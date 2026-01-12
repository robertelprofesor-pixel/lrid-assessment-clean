// mailer.js — FINAL, SMTP-free, Railway-proof

const fs = require("fs");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendReportEmail({
  to,
  subject = "Your LRID™ Leadership Report",
  text = "Your LRID™ report is attached as a PDF.",
  pdfPath,
  caseId,
  publicReportUrl,
}) {
  if (!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY missing");
  if (!process.env.MAIL_FROM) throw new Error("MAIL_FROM missing");
  if (!to) throw new Error("Recipient email missing");
  if (!fs.existsSync(pdfPath)) throw new Error("PDF not found");

  console.log("[MAIL] Sending via Resend to:", to);

  const pdfBase64 = fs.readFileSync(pdfPath).toString("base64");

  const response = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: [to],
    subject,
    text: publicReportUrl
      ? `${text}\n\nBackup link: ${publicReportUrl}`
      : text,
    attachments: [
      {
        filename: caseId
          ? `LRID_Report_${caseId}.pdf`
          : "LRID_Report.pdf",
        content: pdfBase64,
      },
    ],
  });

  if (response.error) {
    console.error("❌ Resend error:", response.error);
    throw new Error(response.error.message);
  }

  console.log("✅ Email sent via Resend:", response.data.id);
  return response.data;
}

module.exports = { sendReportEmail };
