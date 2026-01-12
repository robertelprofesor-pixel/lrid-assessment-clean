// report_one.js — LRID™ Executive-Grade PDF Report (CONSULTING-GRADE, SAFE)
// Export name matches server.js: generateExecutiveSearchReport

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

// =====================
// Utils
// =====================
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function safeFileName(v) {
  return String(v || "unknown")
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .slice(0, 120);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((x, y) => x + y, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

// =====================
// LRID dimensions
// =====================
const DIMENSIONS = [
  { key: "DI", name: "Decision Integrity", short: "Integrity" },
  { key: "RP", name: "Risk Posture", short: "Risk" },
  { key: "MA", name: "Moral Autonomy", short: "Autonomy" },
  { key: "AC", name: "Adaptive Consistency", short: "Adaptation" },
  { key: "PR", name: "Power Response", short: "Power" },
  { key: "ED", name: "Ethical Discipline", short: "Ethics" },
];

const DIM_ALIASES = {
  INTEGRITY: "DI",
  RISK: "RP",
  AUTONOMY: "MA",
  ADAPT: "AC",
  POWER: "PR",
  ETHIC: "ED",
  ETHICS: "ED",
};

// =====================
// Answer parsing
// =====================
function normalizeAnswers(draft) {
  const a =
    (Array.isArray(draft?.answers) && draft.answers) ||
    (Array.isArray(draft?.data?.answers) && draft.data.answers) ||
    (Array.isArray(draft?.payload?.answers) && draft.payload.answers) ||
    (Array.isArray(draft?.submission?.answers) && draft.submission.answers) ||
    [];

  return a
    .map((x) => {
      const qid = x?.question_id || x?.questionId || x?.id || x?.qid || null;
      const raw =
        x?.value ??
        x?.answer ??
        x?.response ??
        x?.selected ??
        x?.choice ??
        x?.score ??
        x?.result ??
        x?.text ??
        null;
      return { question_id: qid ? String(qid) : null, raw };
    })
    .filter((x) => x.question_id);
}

const LIKERT_TEXT = {
  "strongly disagree": 1,
  "disagree": 2,
  "somewhat disagree": 2,
  "neutral": 3,
  "neither agree nor disagree": 3,
  "somewhat agree": 4,
  "agree": 4,
  "strongly agree": 5,
};

function toScore0to100(raw) {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "boolean") return raw ? 100 : 0;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw >= 1 && raw <= 5) return ((raw - 1) / 4) * 100;
    if (raw >= 0 && raw <= 100) return raw;
    return clamp(raw, 0, 100);
  }

  const s = String(raw).trim();
  if (!s) return null;

  const asNum = Number(s);
  if (Number.isFinite(asNum)) return toScore0to100(asNum);

  const key = s.toLowerCase();
  if (LIKERT_TEXT[key]) return toScore0to100(LIKERT_TEXT[key]);

  if (["yes", "y", "true"].includes(key)) return 100;
  if (["no", "n", "false"].includes(key)) return 0;

  return null;
}

function detectDimension(questionId) {
  const q = String(questionId || "").trim();
  if (!q) return null;

  const m = q.match(/^([A-Za-z]{2,8})/);
  const prefix = m ? m[1].toUpperCase() : "";

  const direct = DIMENSIONS.find((d) => d.key === prefix);
  if (direct) return direct.key;

  if (DIM_ALIASES[prefix]) return DIM_ALIASES[prefix];

  const m2 = q.toUpperCase().match(/(DI|RP|MA|AC|PR|ED)/);
  if (m2) return m2[1];

  return null;
}

// =====================
// Scoring & insights
// =====================
function band(score) {
  if (score === null || score === undefined) return "Insufficient data";
  if (score < 35) return "High Risk / Low Reliability";
  if (score < 55) return "Mixed / Context-Sensitive";
  if (score < 75) return "Generally Reliable";
  return "High Reliability / Strong Signal";
}

function buildResults(draft) {
  const answers = normalizeAnswers(draft);
  const total = answers.length;

  const scored = answers.map((a) => {
    const dim = detectDimension(a.question_id);
    const score = toScore0to100(a.raw);
    return { ...a, dim, score };
  });

  const scoredValid = scored.filter((x) => x.dim && typeof x.score === "number");

  const dimBuckets = {};
  for (const d of DIMENSIONS) dimBuckets[d.key] = [];
  for (const s of scoredValid) dimBuckets[s.dim].push(s);

  const dimResults = DIMENSIONS.map((d) => {
    const items = dimBuckets[d.key] || [];
    const scores = items.map((x) => x.score);
    const avg = mean(scores);
    const sd = stdev(scores);
    return {
      key: d.key,
      name: d.name,
      short: d.short,
      n: items.length,
      avg: avg === null ? null : Math.round(avg),
      sd: sd === null ? null : Math.round(sd),
      items,
    };
  });

  const overallScores = dimResults.filter((d) => typeof d.avg === "number").map((d) => d.avg);
  const overall = mean(overallScores);

  return {
    totalAnswers: total,
    scoredCount: scoredValid.length,
    completenessPct: pct(scoredValid.length, total || 1),
    overall: overall === null ? null : Math.round(overall),
    dimResults,
  };
}

function topBottomItems(items, n = 3) {
  const valid = items.filter((x) => typeof x.score === "number");
  const sorted = [...valid].sort((a, b) => a.score - b.score);
  return {
    low: sorted.slice(0, n),
    high: sorted.slice(-n).reverse(),
  };
}

function implicationByBand(dimKey, score) {
  const b = band(score);

  // Consulting-grade: (1) what it means, (2) how it fails, (3) governance mitigations
  const map = {
    DI: {
      meaning:
        "Measures reliability of judgment under pressure: consistency, evidence discipline, accountability, and resistance to rationalization.",
      fail:
        "Failure mode typically shows up as shifting standards, post-hoc justification, or selective evidence use when incentives change.",
      gov:
        "Mitigate via clear decision rights, pre-commit criteria (what evidence qualifies), audit trails, and explicit escalation rules."
    },
    RP: {
      meaning:
        "Measures risk calibration: balancing speed, uncertainty tolerance, downside protection, and escalation discipline.",
      fail:
        "Failure mode appears as over-acceleration without downside controls or paralysis/avoidance when ambiguity rises.",
      gov:
        "Mitigate via risk thresholds, stage-gates, red-team reviews, and pre-defined stop-loss indicators."
    },
    MA: {
      meaning:
        "Measures independence from group pressure and willingness to defend principled choices under political/social cost.",
      fail:
        "Failure mode appears as conformity to authority, moral outsourcing, or inconsistent standards across stakeholders.",
      gov:
        "Mitigate via explicit ethical standards, protected dissent channels, and governance that rewards principled escalation."
    },
    AC: {
      meaning:
        "Measures ability to adapt while preserving core logic (agility without opportunistic switching).",
      fail:
        "Failure mode appears as reactive pivoting that breaks coherence, trust, and strategic continuity.",
      gov:
        "Mitigate via decision principles, guardrails, and defining what is 'non-negotiable' vs. adaptable."
    },
    PR: {
      meaning:
        "Measures behavior under hierarchy and asymmetry: composure, boundary discipline, and distortion under authority.",
      fail:
        "Failure mode appears as volatility under dominance, coercive compliance, or power games that distort decisions.",
      gov:
        "Mitigate via balanced power architecture, clear accountability, and structured conflict resolution mechanisms."
    },
    ED: {
      meaning:
        "Measures ethical execution under pressure (not intention): tolerance for boundary erosion in grey zones.",
      fail:
        "Failure mode appears as gradual ethical drift under incentives/time pressure, normalization of deviations.",
      gov:
        "Mitigate via compliance controls, incentive alignment, and explicit consequences for boundary violations."
    }
  };

  const base = map[dimKey] || { meaning: "", fail: "", gov: "" };

  const posture =
    b === "High Risk / Low Reliability"
      ? "Risk exposure is elevated and should be treated as a governance priority."
      : b === "Mixed / Context-Sensitive"
      ? "Signal is situational; governance design materially affects outcomes."
      : b === "Generally Reliable"
      ? "Signal is workable; focus on stress-testing and targeted guardrails."
      : "Signal is strong; focus on role fit and leverage as a strength.";

  return { ...base, posture, band: b };
}

// =====================
// PDF drawing helpers
// =====================
function drawBar(doc, x, y, w, h, value0to100) {
  doc.rect(x, y, w, h).stroke();
  const fillW = (clamp(value0to100, 0, 100) / 100) * w;
  doc.rect(x, y, fillW, h).fillOpacity(0.15).fill("black").fillOpacity(1);
}

function h1(doc, t) {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(18).fillColor("black").text(t);
  doc.moveDown(0.4);
}

function h2(doc, t) {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("black").text(t);
  doc.moveDown(0.25);
}

function p(doc, t) {
  doc.font("Helvetica").fontSize(10.5).fillColor("black").text(t, { align: "justify", lineGap: 3 });
}

function small(doc, t) {
  doc.font("Helvetica").fontSize(9).fillColor("black").text(t, { align: "justify", lineGap: 2 });
}

function tocLine(doc, left, right) {
  const y = doc.y;
  doc.font("Helvetica").fontSize(10).text(left, 60, y, { continued: true });
  doc.text(right, 480, y, { align: "right" });
}

// =====================
// Output path resolver (safe)
// =====================
function resolveOutputPathSafe(draft, outputPath) {
  if (isNonEmptyString(outputPath)) return outputPath;

  const storageRoot = process.env.STORAGE_ROOT || "/data";
  if (!isNonEmptyString(storageRoot)) throw new TypeError("STORAGE_ROOT must be a non-empty string.");

  const caseId =
    draft?.case_id || draft?.caseId || draft?.meta?.case_id || draft?.data?.case_id || null;

  return path.join(storageRoot, "reports", safeFileName(caseId), "LRID_Report.pdf");
}

// =====================
// Main export (ASYNC; does NOT break system)
// =====================
async function generateExecutiveSearchReport(draft, outputPath) {
  const finalOutputPath = resolveOutputPathSafe(draft, outputPath);
  fs.mkdirSync(path.dirname(finalOutputPath), { recursive: true });

  const results = buildResults(draft);

  const respondent = draft?.respondent || draft?.data?.respondent || {};
  const caseId =
    draft?.case_id || draft?.caseId || draft?.meta?.case_id || draft?.data?.case_id || "-";
  const generatedAt = draft?.generatedAtISO || new Date().toISOString();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: { Title: "LRID™ Leadership Report", Author: "LRID™" },
  });

  const stream = fs.createWriteStream(finalOutputPath);
  doc.pipe(stream);

  // =====================
  // COVER
  // =====================
  doc.font("Helvetica-Bold").fontSize(22).text("LRID™ Leadership Report");
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(11).text("Executive Decision Integrity Assessment");
  doc.moveDown(1.5);

  doc.font("Helvetica").fontSize(11);
  doc.text(`Case ID: ${caseId}`);
  doc.text(`Generated: ${generatedAt}`);
  doc.moveDown(0.8);
  doc.text(`Respondent: ${respondent.name || respondent.subject_name || "—"}`);
  doc.text(`Organization: ${respondent.organization || "—"}`);
  doc.text(`Email: ${respondent.email || "—"}`);

  doc.moveDown(1.0);
  doc.font("Helvetica-Bold").fontSize(12).text("Confidentiality");
  doc.font("Helvetica").fontSize(10.5);
  doc.text(
    "This report is confidential and intended solely for authorized stakeholders. Redistribution must be controlled."
  );

  doc.addPage();

  // =====================
  // EXECUTIVE ONE-PAGER (consulting style)
  // =====================
  h1(doc, "Executive One-Pager (Decision-Maker View)");

  const overallTxt = results.overall === null ? "—" : `${results.overall}/100`;
  const overallBand = results.overall === null ? "Insufficient data" : band(results.overall);

  doc.font("Helvetica-Bold").fontSize(12).text("Overall Signal");
  doc.font("Helvetica").fontSize(10.5);
  doc.text(`Overall Reliability Signal: ${overallTxt}`);
  doc.text(`Interpretation: ${overallBand}`);
  doc.text(`Scorable completeness: ${results.completenessPct}% (${results.scoredCount}/${results.totalAnswers})`);

  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(12).text("Dimension Dashboard (0–100)");
  doc.moveDown(0.2);

  results.dimResults.forEach((d) => {
    const y = doc.y;
    doc.font("Helvetica").fontSize(10.5).text(`${d.key} — ${d.name}`, 60, y, { width: 210 });
    const s = d.avg === null ? 0 : d.avg;
    doc.font("Helvetica-Bold").fontSize(10.5).text(d.avg === null ? "—" : `${d.avg}`, 275, y);
    drawBar(doc, 310, y + 3, 210, 10, s);
    doc.moveDown(0.65);
  });

  // Strengths & exposures (z itemów)
  const allItems = results.dimResults.flatMap((d) => d.items.map((x) => ({ ...x, dim: d.key })));
  const validItems = allItems.filter((x) => typeof x.score === "number").sort((a, b) => a.score - b.score);

  const exposures = validItems.slice(0, 3);
  const strengths = validItems.slice(-3).reverse();

  doc.moveDown(0.4);
  h2(doc, "Key Signals (Evidence-Anchored)");

  doc.font("Helvetica-Bold").fontSize(10.5).text("Top strength signals");
  doc.font("Helvetica").fontSize(10);
  if (!strengths.length) doc.text("— Insufficient scorable data to extract item-level signals.");
  strengths.forEach((it) => doc.text(`• ${it.dim} / ${it.question_id}: ${Math.round(it.score)}/100 (raw: ${String(it.raw)})`));

  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(10.5).text("Top exposure signals (watch-outs)");
  doc.font("Helvetica").fontSize(10);
  if (!exposures.length) doc.text("— Insufficient scorable data to extract item-level exposures.");
  exposures.forEach((it) => doc.text(`• ${it.dim} / ${it.question_id}: ${Math.round(it.score)}/100 (raw: ${String(it.raw)})`));

  doc.addPage();

  // =====================
  // RESULTS & METHODOLOGY SNAPSHOT
  // =====================
  h1(doc, "Results Dashboard & Method Snapshot");

  p(
    doc,
    "Scores represent a normalized signal (0–100) derived from scorable responses. This is an internal interpretive scale, not a clinical diagnosis and not a population-norm benchmark unless norms are explicitly defined."
  );

  h2(doc, "Dimension Table (Score, Dispersion, N)");
  doc.font("Helvetica-Bold").fontSize(10);
  doc.text("Dimension", 60, doc.y, { continued: true });
  doc.text("Score", 260, doc.y, { continued: true });
  doc.text("Dispersion", 330, doc.y, { continued: true });
  doc.text("N", 450, doc.y);
  doc.moveDown(0.4);

  doc.font("Helvetica").fontSize(10);

  results.dimResults.forEach((d) => {
    const y = doc.y;
    doc.text(`${d.key} — ${d.name}`, 60, y, { width: 190 });
    doc.text(d.avg === null ? "—" : String(d.avg), 260, y);
    doc.text(d.sd === null ? "—" : String(d.sd), 330, y);
    doc.text(String(d.n), 450, y);
    drawBar(doc, 260, y + 13, 240, 8, d.avg === null ? 0 : d.avg);
    doc.moveDown(1.0);
  });

  h2(doc, "Data Quality Readout");
  p(
    doc,
    `Scorable completeness is ${results.completenessPct}%. Low completeness reduces interpretability. If completeness is below ~70%, treat conclusions as directional and prioritize structured interview validation.`
  );

  doc.addPage();

  // =====================
  // DETAILED ANALYSIS + INTERVIEW GUIDE (Big4/McK style)
  // =====================
  h1(doc, "Dimension Deep-Dive (Implications + Risk Controls + Interview Probes)");

  results.dimResults.forEach((d, idx) => {
    h2(doc, `${d.key} — ${d.name}`);

    const imp = implicationByBand(d.key, d.avg);

    doc.font("Helvetica").fontSize(10.5);
    doc.text(`Score: ${d.avg === null ? "—" : `${d.avg}/100`}    Band: ${imp.band}    N: ${d.n}    Dispersion: ${d.sd === null ? "—" : d.sd}`);
    doc.moveDown(0.35);

    doc.font("Helvetica-Bold").fontSize(10.5).text("What this measures");
    doc.font("Helvetica").fontSize(10.5).text(imp.meaning, { align: "justify", lineGap: 3 });

    doc.moveDown(0.25);
    doc.font("Helvetica-Bold").fontSize(10.5).text("Executive interpretation");
    doc.font("Helvetica").fontSize(10.5).text(imp.posture, { align: "justify", lineGap: 3 });

    doc.moveDown(0.25);
    doc.font("Helvetica-Bold").fontSize(10.5).text("Typical failure mode under pressure");
    doc.font("Helvetica").fontSize(10.5).text(imp.fail, { align: "justify", lineGap: 3 });

    doc.moveDown(0.25);
    doc.font("Helvetica-Bold").fontSize(10.5).text("Governance / controls to reduce risk");
    doc.font("Helvetica").fontSize(10.5).text(imp.gov, { align: "justify", lineGap: 3 });

    const tb = topBottomItems(d.items, 3);

    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(10.5).text("Evidence anchors (lowest / highest items)");
    doc.font("Helvetica").fontSize(10);

    if (!tb.low.length && !tb.high.length) {
      doc.text("— No scorable items detected for this dimension.");
    } else {
      if (tb.low.length) {
        doc.text("Lowest-scoring items (watch-outs):");
        tb.low.forEach((it) => doc.text(`• ${it.question_id}: ${Math.round(it.score)}/100 (raw: ${String(it.raw)})`));
      } else {
        doc.text("Lowest-scoring items: —");
      }

      doc.moveDown(0.2);

      if (tb.high.length) {
        doc.text("Highest-scoring items (strengths):");
        tb.high.forEach((it) => doc.text(`• ${it.question_id}: ${Math.round(it.score)}/100 (raw: ${String(it.raw)})`));
      } else {
        doc.text("Highest-scoring items: —");
      }
    }

    doc.moveDown(0.35);
    doc.font("Helvetica-Bold").fontSize(10.5).text("Interview probes (practical)");
    doc.font("Helvetica").fontSize(10);
    doc.text(
      "• Ask for a real decision under pressure: What data was available? What was ignored? What was the pre-commit rule? What changed the mind?\n" +
      "• Ask for a conflict with authority: What was escalated? What was tolerated? What would they do differently?\n" +
      "• Ask for a trade-off case: speed vs. quality, ethics vs. performance, loyalty vs. governance. What principle won and why?",
      { lineGap: 2 }
    );

    if (idx < results.dimResults.length - 1) doc.addPage();
  });

  // =====================
  // ROLE FIT + NEXT STEPS (McK style)
  // =====================
  doc.addPage();
  h1(doc, "Role Fit & Next-Step Recommendations");

  const overall = results.overall;
  const overallBand2 = overall === null ? "Insufficient data" : band(overall);

  p(
    doc,
    "This section translates signals into actionable next steps. It is designed for Executive Search, board evaluation, or leadership development planning."
  );

  h2(doc, "Role Fit View (Directional)");
  doc.font("Helvetica").fontSize(10.5).text(`Overall band: ${overallBand2}`);

  p(
    doc,
    "Directional guidance:\n" +
      "• High Reliability signals support high-autonomy roles with broad decision rights.\n" +
      "• Mixed/Context-Sensitive signals fit best where governance is clear and stakeholder pressure is high (strong operating system).\n" +
      "• High Risk/Low Reliability signals require tight controls, staged authority, and structured decision gates until validated."
  );

  h2(doc, "30-60-90 Development Plan (Evidence-Anchored)");
  doc.font("Helvetica").fontSize(10.5);

  const lowDims = [...results.dimResults]
    .filter((d) => typeof d.avg === "number")
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 2);

  doc.text("30 days — Stabilize decision operating system");
  doc.text("• Define decision criteria, escalation thresholds, and documentation rules for high-stakes calls.");
  doc.text("• Run one red-team review on a live decision; capture what changed and why.");

  doc.moveDown(0.3);
  doc.text("60 days — Stress-test weakest dimensions");
  if (lowDims.length) {
    doc.text(
      "• Focus dimensions: " +
        lowDims.map((d) => `${d.key} (${d.name})`).join(", ") +
        ". Create role-specific guardrails and rehearsals (case simulations)."
    );
  } else {
    doc.text("• If data is insufficient, re-run the assessment with enforced scale responses and compare deltas.");
  }

  doc.moveDown(0.3);
  doc.text("90 days — Institutionalize reliability");
  doc.text("• Embed a repeatable cadence: decision reviews, ethics checkpoints, and post-mortem learning loops.");
  doc.text("• Reassess after 90 days to confirm improvement and stability.");

  // =====================
  // Methodology & Disclaimer
  // =====================
  doc.addPage();
  h1(doc, "Methodology & Limitations");

  p(
    doc,
    "Scoring logic: each scorable response is normalized to a 0–100 scale. Items are grouped into dimensions using the question_id prefix (e.g., DI, RP, MA, AC, PR, ED). Dimension scores are averaged across scorable items. Overall score is the mean of available dimension averages."
  );

  p(
    doc,
    "Limitations: results are directional and context-dependent. Low scorable completeness and high dispersion reduce reliability. For high-stakes decisions, triangulate with structured executive interviews, work-sample simulations, and independent references."
  );

  h2(doc, "Legal Disclaimer");
  small(
    doc,
    "This report is provided for informational and developmental purposes only and does not constitute legal advice, medical advice, psychological diagnosis, or professional services of any kind. LRID™ is not a clinical instrument and does not assess mental health conditions."
  );
  small(
    doc,
    "To the maximum extent permitted by applicable law, the author(s), operator(s), and affiliated parties disclaim any liability arising from reliance on this report, including direct or indirect losses, business interruption, reputational impact, or consequential damages."
  );
  small(
    doc,
    "Confidentiality notice: This report is intended solely for the recipient and explicitly authorized stakeholders. Redistribution should be limited and controlled in accordance with applicable privacy and data protection regulations."
  );

  doc.end();

  // HARD GUARANTEE: wait until the file is fully written
  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });

  return { outputPath: finalOutputPath };
}

module.exports = { generateExecutiveSearchReport };
