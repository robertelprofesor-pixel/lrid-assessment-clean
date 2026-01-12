// server.js — LRID™ FINAL (Resend-based, SMTP-free)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const { sendReportEmail } = require("./mailer");

const app = express();

/* =========================
   STORAGE
========================= */

const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";
const DATA_DIR = path.join(STORAGE_ROOT, "data");
const OUT_DIR = path.join(STORAGE_ROOT, "out");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = path.join("/tmp", path.basename(dir));
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const EFFECTIVE_DATA_DIR = ensureDir(DATA_DIR);
const EFFECTIVE_OUT_DIR = ensureDir(OUT_DIR);

/* =========================
   MIDDLEWARE
========================= */

app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  if (req.path.includes("/api")) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

/* =========================
   HEALTH
========================= */

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    dataDir: EFFECTIVE_DATA_DIR,
    outDir: EFFECTIVE_OUT_DIR,
    time: new Date().toISOString()
  });
});

/* =========================
   HELPERS
========================= */

function makeCaseId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rnd = crypto.randomBytes(4).toString("hex");
  return `LRID_${ts}_${rnd}`;
}

function publicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

/* =========================
   PDF (PLACEHOLDER)
========================= */

function generatePdf(caseId) {
  const caseDir = path.join(EFFECTIVE_OUT_DIR, caseId);
  fs.mkdirSync(caseDir, { recursive: true });

  const pdfPath = path.join(caseDir, "LRID_Report.pdf");
  fs.writeFileSync(
    pdfPath,
    `LRID REPORT\n\nCase: ${caseId}\nGenerated: ${new Date().toISOString()}`
  );

  return pdfPath;
}

/* =========================
   INTAKE
========================= */

app.post("/api/intake/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const caseId = makeCaseId();

    const responsesFile = path.join(
      EFFECTIVE_DATA_DIR,
      `responses_${caseId}.json`
    );

    fs.writeFileSync(
      responsesFile,
      JSON.stringify(payload, null, 2),
      "utf8"
    );

    const pdfPath = generatePdf(caseId);
    const reportUrl = `${publicBaseUrl(req)}/out/${caseId}/LRID_Report.pdf`;

    let emailed = false;

    try {
      await sendReportEmail({
        to: payload?.respondent?.email,
        caseId,
        pdfPath,
        publicReportUrl: reportUrl
      });
      emailed = true;
    } catch (mailErr) {
      console.error("❌ Email failed:", mailErr.message);
    }

    res.json({
      ok: true,
      case_id: caseId,
      pdf: reportUrl,
      emailed
    });
  } catch (err) {
    console.error("❌ Intake error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

/* =========================
   STATIC
========================= */

app.use("/out", express.static(EFFECTIVE_OUT_DIR));
app.use(express.static(__dirname));

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ OUT_DIR: ${EFFECTIVE_OUT_DIR}`);
});
