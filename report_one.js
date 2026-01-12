// report_one.js — LRID™ single report generator (PDFKit) — Report v1 (scored domains + narrative)

const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { OUT_DIR, ensureDir } = require("./storage");

// --------------------
// Config (tune later)
// --------------------
const DOMAIN_LABELS = {
  DI: "Decision Intelligence",
  RP: "Resilience & Pressure",
  MA: "Moral Authority",
  AC: "Adaptive Capacity",
  PR: "People & Relationships",
  ED: "Execution Discipline",
};

// If your scale is 0–4 (as in your answers), max per question = 4
const MAX_PER_ITEM = 4;

// Interpretation thresholds (percent)
function levelFromPct(pct) {
  if (pct >= 75) return { level: "High", note: "strong and consistent capability" };
  if (pct >= 50) return { level: "Moderate", note: "generally effective but inconsistent under pressure" };
  return { level: "Developing", note: "clear growth opportunity; focus and practice required" };
}

function safeText(x) {
  return (x === null || x === undefined) ? "-" : String(x);
}

function groupAnswers(answers = []) {
  const groups = {};
  for (const a of answers) {
    const id = (a.question_id || a.id || "").toString().trim();
    const m = id.match(/^([A-Z]{2})/); // DI, RP, MA...
    const dom = m ? m[1] : "OT";
    if (!groups[dom]) groups[dom] = [];
    const v = Number(a.value);
    groups[dom].push({
      id,
      value: Number.isFinite(v) ? v : null,
    });
  }
  return groups;
}

function computeDomainStats(groups) {
  const rows = [];

  for (const dom of Object.keys(DOMAIN_LABELS)) {
    const items = groups[dom] || [];
    const n = items.length;

    const sum = items.reduce((acc, it) => acc + (Number.isFinite(it.value) ? it.value : 0), 0);
    const max = n * MAX_PER_ITEM;
    const pct = max > 0 ? Math.round((sum / max) * 100) : 0;

    const lvl = levelFromPct(pct);

    rows.push({
      code: dom,
      name: DOMAIN_LABELS[dom],
      n,
      sum,
      max,
      pct,
      level: lvl.level,
      note: lvl.note,
    });
  }

  // Overall across known domains only
  const totalSum = rows.reduce((a, r) => a + r.sum, 0);
  const totalMax = rows.reduce((a, r) => a + r.max, 0);
  const overallPct = totalMax > 0 ? Math.round((totalSum / totalMax) * 100) : 0;
  const overallLevel = levelFromPct(overallPct);

  return { rows, totalSum, totalMax, overallPct, overallLevel };
}

function topAndBottom(rows) {
  const sorted = [...rows].sort((a, b) => b.pct - a.pct);
  const top = sorted.slice(0, 2);
  const bottom = sorted.slice(-2).reverse();
  return { top, bottom };
}

// --------------------
// PDF helpers
// --------------------
function h1(doc, text) {
  doc.fontSize(20).text(text, { align: "center" });
  doc.moveDown(0.6);
}

function h2(doc, text) {
  doc.fontSize(14).text(text, { underline: true });
  doc.moveDown(0.3);
}

function p(doc, text) {
  doc.fontSize(11).text(text, { lineGap: 3 });
  doc.moveDown(0.5);
}

function keyValue(doc, k, v) {
  doc.fontSize(11).text(`${k}: ${safeText(v)}`);
}

function tableHeader(doc, cols) {
  doc.fontSize(10);
  doc.text(cols.join("  |  "));
  doc.moveDown(0.2);
  doc.text("-".repeat(95));
  doc.moveDown(0.3);
}

function tableRow(doc, cols) {
  doc.fontSize(10);
  doc.text(cols.join("  |  "));
}

function recommendationForDomain(code, level) {
  const base = {
    DI: {
      Developing: "Build a repeatable decision cadence (framing → options → risk check → commit). Use pre-mortems and decision logs for 30 days.",
      Moderate: "Increase decision speed without losing quality: set decision timeboxes and define ‘reversible vs irreversible’ decisions explicitly.",
      High: "Institutionalize your method: teach your decision cycle to the team and create a lightweight playbook for recurring decisions.",
    },
    RP: {
      Developing: "Create a resilience routine (sleep, recovery, boundaries). Practice ‘pressure reps’: simulate deadlines and debrief emotional triggers.",
      Moderate: "Strengthen stress discipline: identify top 3 pressure patterns and build counter-actions (pause, reframe, micro-plans).",
      High: "Use your resilience as leverage: become the stabilizer in crisis and coach others on pressure management.",
    },
    MA: {
      Developing: "Clarify non-negotiables. Build ethical reflexes: if-then rules for grey-zone situations and a ‘values checkpoint’ in key decisions.",
      Moderate: "Increase consistency: align incentives and consequences; address small integrity breaches early.",
      High: "Lead by moral example: create psychological safety and set standards that protect trust during conflict and change.",
    },
    AC: {
      Developing: "Train adaptability: weekly learning sprints, faster feedback loops, and deliberate ‘unlearning’ of one outdated habit per month.",
      Moderate: "Improve agility: shorten planning cycles and test assumptions early through small pilots.",
      High: "Scale adaptability: build an adaptive culture with experimentation norms and clear learning accountability.",
    },
    PR: {
      Developing: "Invest in trust: 1:1 cadence, active listening, and explicit expectations. Practice difficult conversations with structure.",
      Moderate: "Increase influence: map stakeholders, tailor messages, and close loops (who decides, who executes, by when).",
      High: "Use relationships strategically: create alignment across units and mentor high-potential talent systematically.",
    },
    ED: {
      Developing: "Improve execution hygiene: weekly priorities, daily top-3 tasks, and strict definition of done. Remove one major bottleneck this week.",
      Moderate: "Raise reliability: track commitments, reduce context switching, and implement a simple operating rhythm.",
      High: "Build an execution system: dashboards, leading indicators, and delegation standards with clear accountability.",
    },
  };

  const key = level === "High" ? "High" : level === "Moderate" ? "Moderate" : "Developing";
  return base[code]?.[key] || "Focus on deliberate practice and consistent routines in this capability area.";
}

async function generateSingleReport({ caseId, draftData, outputBaseUrl }) {
  ensureDir(OUT_DIR);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const caseFolderName = `case_${caseId}_${ts}`;
  const caseFolder = path.join(OUT_DIR, caseFolderName);
  fs.mkdirSync(caseFolder, { recursive: true });

  const pdfPath = path.join(caseFolder, "LRID_Report.pdf");

  const respondent = draftData?.respondent || {};
  const answers = Array.isArray(draftData?.answers) ? draftData.answers : [];

  const groups = groupAnswers(answers);
  const stats = computeDomainStats(groups);
  const { top, bottom } = topAndBottom(stats.rows);

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  // --- Cover / header
  h1(doc, "LRID™ Leadership Competency Report");
  doc.fontSize(12).text("Confidential — for personal development and professional coaching use.", { align: "center" });
  doc.moveDown(1);

  keyValue(doc, "Case ID", caseId);
  keyValue(doc, "Generated", new Date().toISOString());
  doc.moveDown(0.6);

  h2(doc, "Respondent");
  keyValue(doc, "Name", respondent.name);
  keyValue(doc, "Email", respondent.email);
  keyValue(doc, "Organization", respondent.organization);
  doc.moveDown(0.8);

  // --- Executive summary
  h2(doc, "Executive Summary");
  const overallLine = `Overall leadership capability score: ${stats.overallPct}% (${stats.overallLevel.level}) — ${stats.overallLevel.note}.`;
  p(doc, overallLine);

  const topText = top.map(t => `${t.name} (${t.pct}%)`).join(", ");
  const bottomText = bottom.map(b => `${b.name} (${b.pct}%)`).join(", ");

  p(doc, `Top strengths: ${topText || "-"}.`);
  p(doc, `Priority development areas: ${bottomText || "-"}.`);

  // --- Score table
  h2(doc, "Scores by Competency Domain");
  tableHeader(doc, ["Domain", "Items", "Score", "Max", "%", "Level"]);
  for (const r of stats.rows) {
    tableRow(doc, [
      `${r.code} — ${r.name}`,
      String(r.n),
      String(r.sum),
      String(r.max),
      `${r.pct}%`,
      r.level,
    ]);
    doc.moveDown(0.2);
  }
  doc.moveDown(0.6);

  // --- Interpretation and recommendations
  h2(doc, "Interpretation & Recommendations");
  for (const r of stats.rows) {
    doc.fontSize(12).text(`${r.code} — ${r.name}: ${r.pct}% (${r.level})`, { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(11).text(`Interpretation: ${r.note}.`, { lineGap: 2 });
    doc.moveDown(0.2);
    doc.fontSize(11).text(`Recommendation: ${recommendationForDomain(r.code, r.level)}`, { lineGap: 2 });
    doc.moveDown(0.6);
  }

  // --- Appendix (optional raw answers for auditability)
  h2(doc, "Appendix: Item Responses (for transparency)");
  const flat = [];
  Object.keys(groups).forEach(k => groups[k].forEach(it => flat.push(it)));
  flat.sort((a, b) => a.id.localeCompare(b.id));

  flat.forEach((it, idx) => {
    doc.fontSize(10).text(`${idx + 1}. ${it.id} = ${safeText(it.value)}`);
    if ((idx + 1) % 45 === 0) doc.addPage();
  });

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  // URL served by: app.use("/out", express.static(OUT_DIR))
  const publicUrl = `${outputBaseUrl}/out/${caseFolderName}/LRID_Report.pdf`;

  return { pdfPath, publicUrl };
}

module.exports = { generateSingleReport };
