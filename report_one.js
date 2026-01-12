// report_one.js — Executive Search grade (BOLD) LRID™ report
const PDFDocument = require("pdfkit");

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Map question IDs -> domain
function domainFromQid(qid) {
  const s = String(qid || "").toUpperCase();
  // Accept DI-01 / DI_01 / DI1 formats
  if (s.startsWith("DI")) return "DI";
  if (s.startsWith("RP")) return "RP";
  if (s.startsWith("MA")) return "MA";
  if (s.startsWith("AC")) return "AC";
  if (s.startsWith("PR")) return "PR";
  if (s.startsWith("ED")) return "ED";
  return null;
}

// Extract numeric answer 1–5
function extractLikertValue(a) {
  // supports: {value: 3} OR {response: 3} OR nested variants
  const v =
    a?.value ??
    a?.response ??
    a?.answer ??
    a?.selected ??
    null;

  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // Allow 0–4 or 1–5: normalize
  if (n >= 0 && n <= 4) return n + 1; // if someone used 0..4
  if (n >= 1 && n <= 5) return n;
  return null;
}

function computeDomainScores(answers) {
  const buckets = { DI: [], RP: [], MA: [], AC: [], PR: [], ED: [] };

  for (const a of answers || []) {
    const qid = a.question_id || a.questionId || a.id;
    const d = domainFromQid(qid);
    if (!d) continue;

    const val = extractLikertValue(a);
    if (val === null) continue;

    buckets[d].push(val);
  }

  // score per domain: average(1..5) => 0..100
  const scores = {};
  for (const d of Object.keys(buckets)) {
    const arr = buckets[d];
    const avg = arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0;
    scores[d] = clamp(Math.round((avg - 1) / 4 * 100), 0, 100);
  }

  return scores;
}

function placementVerdict(scores) {
  const avg = (scores.DI + scores.ED + scores.RP + scores.MA + scores.AC + scores.PR) / 6;

  // BOLD, but still defensible thresholds
  if (avg >= 74 && scores.PR >= 62 && scores.ED >= 62) {
    return { label: "Strong Placement Candidate", tone: "strong" };
  }
  if (avg >= 66) {
    return { label: "Context-Sensitive High-Value Candidate", tone: "conditional" };
  }
  if (avg >= 58) {
    return { label: "Conditional Placement Candidate", tone: "risk" };
  }
  return { label: "High-Risk Placement", tone: "high-risk" };
}

function executiveNarrative(verdict) {
  if (verdict.tone === "strong") {
    return {
      sentence:
        "This candidate demonstrates strong decision reliability and adaptive capacity, with no material governance or power-related risk signals detected.",
      risks:
        "Residual risk is limited to extreme ambiguity scenarios with prolonged mandate absence.",
      value:
        "High placement confidence in execution-led roles with clear mandate and measurable accountability."
    };
  }
  if (verdict.tone === "conditional") {
    return {
      sentence:
        "This candidate demonstrates high decision agility and moral self-regulation, but exhibits measurable exposure to power-context volatility — a risk factor at CEO and Board interface levels.",
      risks:
        "Decision reliability may decrease in environments where authority signals are indirect, politically fluid, or informally enforced.",
      value:
        "Exceptional value potential when governance is explicit: mandate clarity unlocks performance ceiling."
    };
  }
  if (verdict.tone === "risk") {
    return {
      sentence:
        "This candidate shows situational leadership strengths but displays instability under ambiguous power conditions.",
      risks:
        "Elevated probability of reactive decision shifts when political context overrides data clarity.",
      value:
        "Consider for bounded mandates; avoid roles requiring symbolic authority across competing power centers."
    };
  }
  return {
    sentence:
      "This candidate presents high placement risk due to inconsistent decision behavior under pressure and unclear authority.",
    risks:
      "Mis-hire probability increases significantly in senior governance or board-facing roles.",
    value:
      "Not recommended for mission-critical roles unless substantial governance controls and oversight are in place."
  };
}

function roleFitMatrix(scores) {
  // simple rule-based (can be upgraded later)
  const pr = scores.PR;
  const ed = scores.ED;
  const avg = (scores.DI + scores.ED + scores.RP + scores.MA + scores.AC + scores.PR) / 6;

  const CEO_board = (pr < 55 || ed < 55) ? "High Risk" : (avg >= 70 ? "Conditional" : "Conditional-High Risk");
  const COO = avg >= 62 ? "Strong" : "Conditional";
  const Transform = (scores.AC >= 60 && scores.DI >= 60) ? "Strong" : "Conditional";
  const CEO_founder = (avg >= 66 && pr >= 55) ? "Conditional" : "Conditional";
  const Board = pr >= 70 ? "Conditional" : "Not Recommended";

  return [
    ["COO / Operations Leader", COO],
    ["Transformation / Change Lead", Transform],
    ["CEO (Founder-led org)", CEO_founder],
    ["CEO (Board-driven governance)", CEO_board],
    ["Board / NED", Board]
  ];
}

function writeSectionTitle(doc, t) {
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).text(t);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(11);
}

function generateExecutiveSearchReport({ caseId, respondent, answers, generatedAtISO }) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks = [];
  doc.on("data", (d) => chunks.push(d));

  const domainScores = computeDomainScores(answers || []);
  const verdict = placementVerdict(domainScores);
  const narrative = executiveNarrative(verdict);
  const matrix = roleFitMatrix(domainScores);

  // --- Header
  doc.font("Helvetica-Bold").fontSize(18).text("LRID™ Executive Search Report", { align: "center" });
  doc.moveDown(0.2);
  doc.font("Helvetica").fontSize(10).text(`Case ID: ${caseId}`, { align: "center" });
  doc.font("Helvetica").fontSize(10).text(`Generated: ${generatedAtISO}`, { align: "center" });
  doc.moveDown(1);

  // --- Executive Search Summary
  writeSectionTitle(doc, "Executive Search Summary");

  doc.font("Helvetica-Bold").text("Placement Verdict");
  doc.font("Helvetica").text(verdict.label);
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").text("One-Sentence Verdict");
  doc.font("Helvetica").text(narrative.sentence);
  doc.moveDown(0.6);

  doc.font("Helvetica-Bold").text("Value Creation Potential");
  doc.font("Helvetica").text(narrative.value);
  doc.moveDown(0.6);

  doc.font("Helvetica-Bold").text("Primary Risk Signal");
  doc.font("Helvetica").text(narrative.risks);

  // --- Respondent
  writeSectionTitle(doc, "Respondent");
  doc.text(`Name: ${respondent?.name || respondent?.subject_name || "-"}`);
  doc.text(`Email: ${respondent?.email || "-"}`);
  doc.text(`Organization: ${respondent?.organization || "-"}`);

  // --- Dashboard
  writeSectionTitle(doc, "Decision Reliability Dashboard (0–100)");
  Object.entries(domainScores).forEach(([k, v]) => {
    doc.text(`${k}: ${v}`);
  });

  // --- Role Fit Matrix
  writeSectionTitle(doc, "Role & Context Fit Matrix");
  matrix.forEach(([role, fit]) => doc.text(`${role}: ${fit}`));

  // --- Interview Guide
  writeSectionTitle(doc, "Interview Deep-Dive Guide (Final Round)");
  doc.text("Validate with concrete examples:");
  doc.text("• Decision reversals driven by power context (not new data).");
  doc.text("• Performance under unclear mandate with high urgency.");
  doc.text("• Handling of informal authority overrides and coalition pressure.");

  // --- Appendix (raw answers)
  writeSectionTitle(doc, "Appendix: Response Snapshot (22 items)");
  (answers || []).forEach((a, idx) => {
    const qid = a.question_id || a.questionId || a.id || `Q${idx + 1}`;
    const val = extractLikertValue(a);
    const shown = val === null ? (a.value ?? a.response ?? a.answer ?? "-") : val;
    doc.text(`${idx + 1}. ${qid} = ${shown}`);
  });

  // --- Disclaimer
  doc.moveDown(1);
  doc.fontSize(9).text(
    "Disclaimer: This report supports executive search decision-making by assessing decision reliability under power, pressure, and ambiguity. It is not a clinical assessment and should be used alongside structured interviews, references, and role-context validation.",
    { align: "left" }
  );

  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      resolve({ pdfBuffer: Buffer.concat(chunks), domainScores, verdict });
    });
  });
}

module.exports = { generateExecutiveSearchReport };
