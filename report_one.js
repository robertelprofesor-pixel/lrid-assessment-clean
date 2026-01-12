// report_one.js — single report generator (PDFKit) for LRID™

const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { OUT_DIR, ensureDir } = require("./storage");

// Generates one PDF report and returns local path + public url
async function generateSingleReport({ caseId, draftData, outputBaseUrl }) {
  ensureDir(OUT_DIR);

  const caseFolder = path.join(OUT_DIR, `case_${caseId}_${new Date().toISOString().replace(/[:.]/g, "-")}`);
  fs.mkdirSync(caseFolder, { recursive: true });

  const pdfPath = path.join(caseFolder, "LRID_Report.pdf");

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  // Simple clean report (you can expand later)
  doc.fontSize(20).text("LRID™ Leadership Report", { align: "center" });
  doc.moveDown();

  doc.fontSize(12).text(`Case ID: ${caseId}`);
  doc.text(`Generated: ${new Date().toISOString()}`);
  doc.moveDown();

  const respondent = draftData?.respondent || {};
  doc.fontSize(14).text("Respondent", { underline: true });
  doc.fontSize(12).text(`Name: ${respondent.name || "-"}`);
  doc.text(`Email: ${respondent.email || "-"}`);
  doc.text(`Organization: ${respondent.organization || "-"}`);
  doc.moveDown();

  const answers = Array.isArray(draftData?.answers) ? draftData.answers : [];
  doc.fontSize(14).text("Answers (raw)", { underline: true });
  doc.moveDown(0.5);

  if (answers.length === 0) {
    doc.fontSize(12).text("No answers provided.");
  } else {
    answers.slice(0, 200).forEach((a, idx) => {
      doc.fontSize(12).text(`${idx + 1}. ${a.question_id || a.id || "Q"} = ${a.value ?? "-"}`);
    });
    if (answers.length > 200) {
      doc.moveDown().text(`(Showing first 200 of ${answers.length} answers)`);
    }
  }

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  // public url served by app.use("/out", express.static(OUT_DIR))
  // path example: /out/case_xxx/LRID_Report.pdf
  const relative = pdfPath.replace(OUT_DIR, "").split(path.sep).join("/");
  const publicUrl = `${outputBaseUrl}/out${relative}`;

  return { pdfPath, publicUrl };
}

module.exports = { generateSingleReport };
