// report_one.js — LRID™ Executive-Grade PDF Report (FINAL)

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

/**
 * Generate LRID™ Executive Report
 * @param {Object} draft - normalized draft object
 * @param {String} outputPath - full path to output PDF
 */
function generateReport(draft, outputPath) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  doc.pipe(fs.createWriteStream(outputPath));

  // ===============================
  // Helpers
  // ===============================
  const H1 = (t) => {
    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(18).text(t);
    doc.moveDown(0.6);
  };

  const H2 = (t) => {
    doc.moveDown(1.0);
    doc.font("Helvetica-Bold").fontSize(13).text(t);
    doc.moveDown(0.4);
  };

  const P = (t) => {
    doc.font("Helvetica").fontSize(10.5).text(t, {
      align: "justify",
      lineGap: 3,
    });
  };

  const Small = (t) => {
    doc.font("Helvetica").fontSize(9).text(t, {
      align: "justify",
      lineGap: 2,
    });
  };

  // ===============================
  // COVER
  // ===============================
  doc.font("Helvetica-Bold").fontSize(22).text("LRID™ Leadership Report");
  doc.moveDown(0.5);
  doc.fontSize(11).font("Helvetica").text("Executive Decision Integrity Assessment");

  doc.moveDown(2);

  const respondent = draft.respondent || {};
  doc.fontSize(11).text(`Case ID: ${draft.case_id || "-"}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.moveDown(1);
  doc.text(`Respondent: ${respondent.name || "—"}`);
  doc.text(`Organization: ${respondent.organization || "—"}`);
  doc.text(`Email: ${respondent.email || "—"}`);

  doc.addPage();

  // ===============================
  // EXECUTIVE SUMMARY
  // ===============================
  H1("Executive Summary");

  P(
    "This report provides an executive-level interpretation of leadership decision patterns under conditions of ambiguity, " +
      "power asymmetry, and contextual pressure. The analysis focuses on how the respondent is likely to reason, adapt, " +
      "and maintain decision coherence when confronted with changing incentives, incomplete data, and organizational constraints."
  );

  P(
    "The findings are designed to support board-level discussion, executive search evaluation, and leadership development " +
      "conversations. They are not intended as a diagnostic instrument, but as a structured signal to guide deeper inquiry."
  );

  // ===============================
  // DIMENSION SNAPSHOT (PLACEHOLDER – expandable later)
  // ===============================
  H2("Leadership Risk & Reliability Snapshot");

  P(
    "Across the assessed dimensions (Decision Integrity, Risk Posture, Moral Autonomy, Adaptive Consistency, " +
      "Power Response, and Ethical Discipline), the respondent demonstrates a mixed and context-sensitive profile. " +
      "This suggests an ability to adjust behavior to situational demands, accompanied by identifiable exposure to " +
      "context-driven trade-offs under pressure."
  );

  // ===============================
  // PAGE: ABOUT & DISCLAIMER
  // ===============================
  doc.addPage();

  H1("About This Report");

  P(
    "This document is an Executive Search–oriented interpretive report generated from self-reported questionnaire inputs. " +
      "It is designed to support senior decision-makers, boards, and investors in structured conversations about leadership reliability, " +
      "judgment under pressure, and decision integrity within complex organizational environments."
  );

  P(
    "The report does not attempt to label, diagnose, or predict behavior in absolute terms. Instead, it highlights " +
      "patterns, tendencies, and potential risk exposures that may become relevant depending on role mandate, governance design, " +
      "and incentive structures."
  );

  H2("How to Use the Results");

  P(
    "The findings should be used as one input within a broader due diligence or development process. " +
      "For high-stakes decisions, it is strongly recommended to triangulate this report with structured executive interviews, " +
      "work-sample evidence (e.g., crisis scenarios or strategic memoranda), independent references, and role-specific success criteria."
  );

  H2("Indicative Nature of Results");

  P(
    "Results reflect an interpretation of responses captured at a single point in time. Leadership effectiveness is inherently " +
      "context-dependent and may vary significantly across organizational cultures, power architectures, and decision environments. " +
      "Accordingly, this report should not be treated as definitive proof of competence, integrity, or role suitability."
  );

  H2("Data Integrity & Reliability");

  P(
    "The assessment relies on respondent-provided inputs. Reliability may be affected by incomplete answers, inconsistent responding, " +
      "time pressure, or strategic impression management. Where material decisions are contemplated, repeating the assessment under " +
      "controlled conditions and conducting an independent executive interview is advised."
  );

  H2("Legal Disclaimer");

  Small(
    "This report is provided for informational and developmental purposes only and does not constitute legal advice, " +
      "medical advice, psychological diagnosis, or professional services of any kind. LRID™ is not a clinical instrument " +
      "and does not assess mental health conditions."
  );

  Small(
    "To the maximum extent permitted by applicable law, the author(s), operator(s), and affiliated parties disclaim any liability " +
      "arising from reliance on this report, including direct or indirect losses, business interruption, reputational impact, " +
      "or consequential damages."
  );

  Small(
    "Confidentiality notice: This report is intended solely for the recipient and explicitly authorized stakeholders. " +
      "Redistribution should be limited and controlled in accordance with applicable privacy and data protection regulations. " +
      "By using this report, the recipient acknowledges the advisory nature of the content and assumes full responsibility " +
      "for decisions made on its basis."
  );

  // ===============================
  // FOOTER
  // ===============================
  doc.end();
}

module.exports = { generateReport };
