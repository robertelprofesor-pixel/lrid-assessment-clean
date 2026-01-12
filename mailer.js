// mailer.js — Resend (HTTP) mailer
const { Resend } = require("resend");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getMailConfig() {
  return {
    RESEND_API_KEY: process.env.RESEND_API_KEY || "",
    MAIL_FROM: process.env.MAIL_FROM || "",
  };
}

/**
 * Send PDF as attachment via Resend
 * NOTE: MAIL_FROM must be a verified sender/domain in Resend.
 */
async function sendReportEmail({ to, subject, text, pdfFilename, pdfBuffer }) {
  const RESEND_API_KEY = required("RESEND_API_KEY");
  const MAIL_FROM = required("MAIL_FROM");

  const resend = new Resend(RESEND_API_KEY);

  const base64 = Buffer.from(pdfBuffer).toString("base64");

  console.log("[MAIL] Using Resend:", {
    to,
    from: MAIL_FROM,
    subject,
    attachment: pdfFilename || "LRID_Report.pdf",
  });

  const { data, error } = await resend.emails.send({
    from: MAIL_FROM,
    to: [to],
    subject,
    text,
    attachments: [
      {
        filename: pdfFilename || "LRID_Report.pdf",
        content: base64,
      },
    ],
  });

  if (error) {
    console.error("[MAIL] Resend error:", error);
    throw new Error(error.message || "Resend failed");
  }

  console.log("[MAIL] Resend sent:", data);
  return data;
}

module.exports = { sendReportEmail, getMailConfig };
