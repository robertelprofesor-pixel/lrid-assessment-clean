// server.js — LRID™ production server (Intake + PDF + Email + Review-compatible + Thank You)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const { generateExecutiveSearchReport } = require("./report_one");
const { sendReportEmail } = require("./mailer");

const app = express();

// --------------------
// Storage paths
// --------------------
const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data"); // /data/data
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals"); // /data/approvals
const OUT_DIR = process.env.OUT_DIR || path.join(STORAGE_ROOT, "out"); // /data/out

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return p;
  } catch (e) {
    const fallback = path.join("/tmp", path.basename(p) || "data");
    fs.mkdirSync(fallback, { recursive: true });
    console.warn(`⚠️ Cannot create ${p}, using fallback: ${fallback}`);
    return fallback;
  }
}

const EFFECTIVE_DATA_DIR = ensureDir(DATA_DIR);
const EFFECTIVE_APPROVALS_DIR = ensureDir(APPROVALS_DIR);
const EFFECTIVE_OUT_DIR = ensureDir(OUT_DIR);

// --------------------
// Middleware
// --------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use((req, res, next) => {
  if (req.path.includes("/api/")) console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// --------------------
// Static assets
// --------------------
app.use(express.static(__dirname, { extensions: ["html"], fallthrough: true }));
app.use("/config", express.static(__dirname)); // load /config/questions.lrid.v1.json
app.use("/out", express.static(EFFECTIVE_OUT_DIR)); // serve generated PDFs

// --------------------
// Health
// --------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    dataDir: EFFECTIVE_DATA_DIR,
    approvalsDir: EFFECTIVE_APPROVALS_DIR,
    outDir: EFFECTIVE_OUT_DIR,
    time: new Date().toISOString(),
  });
});

// --------------------
// Helpers
// --------------------
function makeId(prefix = "LRID") {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${ts.slice(0, 8)}-${rand}`; // LRID-YYYYMMDD-xxxx
}

function safeJsonParse(x) {
  try {
    if (typeof x === "string") return JSON.parse(x);
    return x;
  } catch {
    return x;
  }
}

function writeJsonFile(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function draftFilenameFromCaseId(caseId) {
  return `draft_${caseId}.json`;
}
function responsesFilenameFromCaseId(caseId) {
  return `responses_${caseId}.json`;
}
function caseIdFromDraftFilename(filename) {
  const m = filename.match(/^draft_(.+)\.json$/i);
  return m ? m[1] : null;
}

function resolveDraftFilename(idOrFile) {
  const s = String(idOrFile || "").trim();
  if (/^draft_.+\.json$/i.test(s)) return s;
  return draftFilenameFromCaseId(s);
}

function readDraftFile(filename) {
  const safeName = String(filename || "").trim();
  const filePath = path.join(EFFECTIVE_DATA_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return { ok: false, status: 404, error: "Draft not found", filename: safeName, filePath };
  }
  return { ok: true, filename: safeName, filePath, content: fs.readFileSync(filePath, "utf8") };
}

function normalizeDraftObject(draftObj, filename) {
  const base = draftObj || {};
  const data = base.data || base.submission || base.payload || {};
  const caseId = base.case_id || data.case_id || caseIdFromDraftFilename(filename) || null;

  return {
    ok: true,
    case_id: caseId,
    status: base.status || "draft",
    created_at: base.created_at || base.createdAt || null,
    source: base.source || "intake",
    data,
    submission: data,
    payload: data,
    respondent: data.respondent || null,
    answers: Array.isArray(data.answers) ? data.answers : (Array.isArray(base.answers) ? base.answers : []),
    meta: { filename },
  };
}

function listFilesSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function buildDraftList() {
  const files = listFilesSafe(EFFECTIVE_DATA_DIR).filter((f) => /^draft_.+\.json$/i.test(f));

  return files
    .map((f) => {
      const caseId = caseIdFromDraftFilename(f) || f.replace(/\.json$/i, "");
      const fullPath = path.join(EFFECTIVE_DATA_DIR, f);
      const st = statSafe(fullPath);

      return {
        case_id: caseId,
        caseId,
        id: caseId,
        draftFile: f,
        filename: f,
        path: fullPath,
        mtime: st ? st.mtimeMs : 0,
        size: st ? st.size : 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// --------------------
// Thank you page
// --------------------
app.get("/thank-you", (req, res) => {
  const emailed = String(req.query.emailed || "").toLowerCase() === "true";
  const to = req.query.to ? escHtml(req.query.to) : null;
  const caseId = req.query.case_id ? escHtml(req.query.case_id) : null;
  const reportUrl = req.query.report_url ? escHtml(req.query.report_url) : null;

  const title = "Thank you — LRID™";
  const msg = emailed
    ? "Thank you. The report was sent to the designated email address."
    : "Thank you. Your submission was received, but email delivery was not confirmed.";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#f6f7fb;color:#111;}
    .wrap{max-width:820px;margin:0 auto;padding:60px 20px;}
    .card{background:#fff;border:1px solid #e6e7ee;border-radius:14px;padding:28px;box-shadow:0 6px 18px rgba(0,0,0,0.06);}
    h1{margin:0 0 10px;font-size:22px;}
    p{margin:8px 0;line-height:1.55;}
    .meta{margin-top:18px;padding-top:14px;border-top:1px solid #eee;color:#333;font-size:14px;}
    a{color:#0b5fff;text-decoration:none;}
    a:hover{text-decoration:underline;}
    .btn{display:inline-block;margin-top:16px;padding:10px 14px;border-radius:10px;border:1px solid #d6d8e5;background:#fff;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>${msg}</h1>
      <p>You may close this page.</p>

      <div class="meta">
        ${caseId ? `<p><strong>Case ID:</strong> ${caseId}</p>` : ``}
        ${to ? `<p><strong>Email:</strong> ${to}</p>` : ``}
        ${reportUrl ? `<p><strong>Report link:</strong> <a href="${reportUrl}">Open report</a></p>` : ``}
      </div>

      <a class="btn" href="/">Back to start</a>
    </div>
  </div>
</body>
</html>`);
});

// --------------------
// Intake submit (creates responses + draft + PDF + email)
// --------------------
async function handleIntakeSubmit(req, res) {
  try {
    const payload = safeJsonParse(req.body) || {};
    const caseId = payload.case_id ? String(payload.case_id) : makeId("LRID");

    const responsesFilename = responsesFilenameFromCaseId(caseId);
    const draftFilename = draftFilenameFromCaseId(caseId);

    const responsesPath = path.join(EFFECTIVE_DATA_DIR, responsesFilename);
    const draftPath = path.join(EFFECTIVE_DATA_DIR, draftFilename);

    // Accept both formats:
    // A) payload.respondent + payload.answers
    // B) payload.data.respondent + payload.data.answers
    const respondent = payload.respondent || payload?.data?.respondent || {};
    const answers = payload.answers || payload?.data?.answers || [];

    const envelope = {
      receivedAt: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
      submission: payload,
    };

    writeJsonFile(responsesPath, envelope);

    // draft is a placeholder “analysis envelope”
    writeJsonFile(draftPath, {
      case_id: caseId,
      status: "draft",
      created_at: new Date().toISOString(),
      source: "intake",
      data: payload,
      links: { responses_file: responsesFilename },
    });

    // ---- Generate report (PDF) and WAIT until it exists
    const generatedAtISO = new Date().toISOString();

    const caseFolder = path.join(
      EFFECTIVE_OUT_DIR,
      `case_${caseId}_${generatedAtISO.replace(/[:.]/g, "-")}`
    );
    ensureDir(caseFolder);

    const pdfPath = path.join(caseFolder, "LRID_Report.pdf");

    // CRITICAL: await -> PDF is guaranteed written before we continue
    await generateExecutiveSearchReport(
      {
        case_id: caseId,
        respondent,
        answers,
        generatedAtISO,
        data: payload,
        meta: { source: "intake" },
      },
      pdfPath
    );

    const reportUrl = `${publicBaseUrl(req)}/out/${path.basename(caseFolder)}/LRID_Report.pdf`;

    // ---- Email (best effort)
    let emailed = false;
    let emailError = null;

    const to = respondent?.email || payload?.respondent?.email || null;
    if (to) {
      try {
        const pdfBuffer = fs.readFileSync(pdfPath);

        await sendReportEmail({
          to,
          subject: `LRID™ Executive Search Report — ${caseId}`,
          text:
            `Attached is your LRID™ Executive Search Report.\n\n` +
            `Case ID: ${caseId}\nGenerated: ${generatedAtISO}\n\n` +
            `If you cannot open the attachment, use this link:\n${reportUrl}\n`,
          pdfFilename: "LRID_Report.pdf",
          pdfBuffer,
        });

        emailed = true;
      } catch (e) {
        emailed = false;
        emailError = e?.message || String(e);
        console.error("❌ Email send failed:", emailError);
      }
    }

    const thankYouUrl =
      `${publicBaseUrl(req)}/thank-you` +
      `?case_id=${encodeURIComponent(caseId)}` +
      `&emailed=${encodeURIComponent(String(emailed))}` +
      (to ? `&to=${encodeURIComponent(to)}` : "") +
      `&report_url=${encodeURIComponent(reportUrl)}`;

    return res.json({
      ok: true,
      case_id: caseId,
      responses_file: responsesPath,
      draft_file: draftPath,
      report_path: pdfPath,
      report_url: reportUrl,
      report_generated: true,
      emailed,
      email_error: emailError,
      thank_you_url: thankYouUrl,
      review_url: `${publicBaseUrl(req)}/review`,
      message: "Submission stored as responses + draft",
    });
  } catch (err) {
    console.error("❌ Intake submit error:", err);
    return res.status(500).json({ ok: false, error: err?.message || "Submit failed (server error)" });
  }
}

[
  "/api/intake/submit",
  "/api/submit",
  "/submit",
  "/intake/submit",
].forEach((p) => app.post(p, handleIntakeSubmit));

// --------------------
// Draft list / draft read (Review Panel compatible)
// --------------------
function handleDraftList(req, res) {
  try {
    const drafts = buildDraftList();
    res.json({
      ok: true,
      drafts,
      count: drafts.length,
      total: drafts.length,
      data: {
        drafts,
        count: drafts.length,
        data: { drafts, count: drafts.length },
      },
    });
  } catch (err) {
    console.error("❌ Draft list error:", err);
    res.status(500).json({ ok: false, error: "Cannot list drafts" });
  }
}

function sendNormalizedDraft(res, filename) {
  const out = readDraftFile(filename);
  if (!out.ok) return res.status(out.status).json(out);

  let parsed = null;
  try {
    parsed = JSON.parse(out.content);
  } catch {
    return res.status(500).json({ ok: false, error: "Draft JSON parse error", filename });
  }

  return res.json(normalizeDraftObject(parsed, filename));
}

const LIST_PATHS = [
  "/api/drafts",
  "/api/draft",
  "/api/drafts/list",
  "/api/draft/list",
  "/api/review/drafts",
  "/api/review/cases",
  "/api/cases",
  "/api/cases/list",
  "/api/list",
  "/api/files",
  "/api/files/list",
];

LIST_PATHS.forEach((p) => {
  app.get(p, handleDraftList);
  app.post(p, handleDraftList);
});

app.get("/api/drafts/:id", (req, res) => sendNormalizedDraft(res, resolveDraftFilename(req.params.id)));
app.get("/api/draft/:id", (req, res) => sendNormalizedDraft(res, resolveDraftFilename(req.params.id)));
app.get("/data/:filename", (req, res) => {
  const filename = String(req.params.filename || "");
  if (!/^draft_.+\.json$/i.test(filename)) return res.status(400).json({ ok: false, error: "Bad filename" });
  return sendNormalizedDraft(res, filename);
});

// ✅ /review/api aliases (so review.html works)
const REVIEW_LIST_PATHS = LIST_PATHS.map((p) => `/review${p}`);
REVIEW_LIST_PATHS.forEach((p) => {
  app.get(p, handleDraftList);
  app.post(p, handleDraftList);
});

app.get("/review/api/drafts/:id", (req, res) => sendNormalizedDraft(res, resolveDraftFilename(req.params.id)));
app.get("/review/api/draft/:id", (req, res) => sendNormalizedDraft(res, resolveDraftFilename(req.params.id)));
app.get("/review/data/:filename", (req, res) => {
  const filename = String(req.params.filename || "");
  if (!/^draft_.+\.json$/i.test(filename)) return res.status(400).json({ ok: false, error: "Bad filename" });
  return sendNormalizedDraft(res, filename);
});

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// --------------------
// Start
// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ APPROVALS_DIR: ${EFFECTIVE_APPROVALS_DIR}`);
  console.log(`✅ OUT_DIR: ${EFFECTIVE_OUT_DIR}`);
});
