// mailer.js — SMTP mailer with debug logs (Gmail App Password supported)
const nodemailer = require("nodemailer");

function envBool(v, def = false) {
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function envInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function getMailConfig() {
  const SMTP_HOST = process.env.SMTP_HOST || "";
  const SMTP_PORT = envInt(process.env.SMTP_PORT, 587);
  const SMTP_SECURE = envBool(process.env.SMTP_SECURE, SMTP_PORT === 465);
  const SMTP_USER = process.env.SMTP_USER || "";
  const SMTP_PASS = process.env.SMTP_PASS || "";
  const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `LRID Reports <${SMTP_USER}>` : "LRID Reports");

  return { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM };
}

async function sendReportEmail({ to, subject, text, pdfFilename, pdfBuffer }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM } = getMailConfig();

  console.log("[MAIL] ENV CHECK:", {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER: SMTP_USER || "",
    SMTP_PASS: SMTP_PASS ? "SET" : "MISSING",
    MAIL_FROM
  });

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP env missing: set SMTP_HOST, SMTP_USER, SMTP_PASS (and optionally SMTP_PORT/SMTP_SECURE/MAIL_FROM)");
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },

    // IMPORTANT on platforms that sometimes block/slow SMTP:
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,

    logger: true,
    debug: true
  });

  console.log("[MAIL] Sending to:", to);

  const info = await transporter.sendMail({
    from: MAIL_FROM,
    to,
    subject,
    text,
    attachments: [
      {
        filename: pdfFilename || "LRID_Report.pdf",
        content: pdfBuffer,
        contentType: "application/pdf"
      }
    ]
  });

  console.log("[MAIL] Sent OK:", { messageId: info.messageId, response: info.response });
  return info;
}

module.exports = { sendReportEmail, getMailConfig };
