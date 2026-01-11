// server.js — LRID™ Railway production server (FINAL: Review compatible + /review/api aliases)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const app = express();

// --------------------
// Storage paths
// --------------------
const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data"); // /data/data
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals"); // /data/approvals

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
app.use("/config", express.static(__dirname));

// --------------------
// Health
// --------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    dataDir: EFFECTIVE_DATA_DIR,
    approvalsDir: EFFECTIVE_APPROVALS_DIR,
    time: new Date().toISOString(),
  });
});

// --------------------
// Helpers
// --------------------
function makeId(prefix = "LRID") {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}

function safeJsonParse(x) {
  try {
    if (typeof x === "string") return JSON.parse(x);
    return x;
  } catch {
    return x;
  }
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

function writeJsonFile(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
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
  if (/^draft_.+$/i.test(s) && !s.endsWith(".json")) return `${s}.json`;
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

// Normalize draft shape for any frontend
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

    // original
    data,

    // aliases
    submission: data,
    payload: data,
    response: data,

    tool: data.tool || null,
    version: data.version || null,
    timestamps: data.timestamps || null,
    respondent: data.respondent || null,
    answers: Array.isArray(data.answers) ? data.answers : [],

    links: base.links || null,
    meta: { filename, links: base.links || null },
  };
}

// --------------------
// Draft list builder (include draftFile)
// --------------------
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

        // MUST:
        draftFile: f,

        // aliases:
        draft_file: f,
        draft: f,
        name: f,
        file: f,
        filename: f,
        path: fullPath,
        filePath: fullPath,

        mtime: st ? st.mtimeMs : 0,
        size: st ? st.size : 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// --------------------
// Intake submit
// --------------------
async function handleIntakeSubmit(req, res) {
  try {
    const payload = safeJsonParse(req.body) || {};
    const caseId = payload.case_id ? String(payload.case_id) : makeId("LRID");

    const responsesFilename = responsesFilenameFromCaseId(caseId);
    const draftFilename = draftFilenameFromCaseId(caseId);

    const responsesPath = path.join(EFFECTIVE_DATA_DIR, responsesFilename);
    const draftPath = path.join(EFFECTIVE_DATA_DIR, draftFilename);

    const envelope = {
      receivedAt: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
      submission: payload,
    };

    writeJsonFile(responsesPath, envelope);

    writeJsonFile(draftPath, {
      case_id: caseId,
      status: "draft",
      created_at: new Date().toISOString(),
      source: "intake",
      data: payload,
      links: { responses_file: responsesFilename },
    });

    res.json({
      ok: true,
      case_id: caseId,
      file: responsesPath,
      saved: responsesPath,
      responses_file: responsesPath,
      draft_file: draftPath,
      review_url: `${publicBaseUrl(req)}/review`,
      message: "Submission stored as responses + draft",
    });
  } catch (err) {
    console.error("❌ Intake submit error:", err);
    res.status(500).json({ ok: false, error: "Submit failed (server error)" });
  }
}

[
  "/api/intake/submit",
  "/api/submit",
  "/submit",
  "/intake/submit",
].forEach((p) => app.post(p, handleIntakeSubmit));

// --------------------
// Handlers
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

// --------------------
// API ROUTES (normal)
// --------------------
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

// --------------------
// ✅ CRITICAL FIX: /review/api/... aliases
// (handles fetch("api/drafts") from /review)
// --------------------
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
// Approval save
// --------------------
app.post("/api/approval/save", (req, res) => {
  try {
    const payload = safeJsonParse(req.body) || {};
    const caseId =
      payload.case_id ||
      payload.caseId ||
      payload.case ||
      payload.selected_case ||
      payload.selectedCase ||
      null;

    if (!caseId) return res.status(400).json({ ok: false, error: "Missing case_id" });

    const filename = `approval_${caseId}.json`;
    const filePath = path.join(EFFECTIVE_APPROVALS_DIR, filename);

    writeJsonFile(filePath, {
      savedAt: new Date().toISOString(),
      case_id: caseId,
      approval: payload,
    });

    res.json({ ok: true, case_id: caseId, file: filePath, message: "Approval saved" });
  } catch (err) {
    console.error("❌ approval/save error:", err);
    res.status(500).json({ ok: false, error: "Cannot save approval" });
  }
});

// Finalize placeholder
app.post("/api/finalize", (req, res) => {
  res.json({ ok: true, message: "Finalize ready. PDF generation will be added next." });
});

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// API 404
app.use("/api", (req, res) => {
  console.warn(`❌ API 404: ${req.method} ${req.path}`);
  res.status(404).json({ ok: false, error: "API endpoint not found", method: req.method, path: req.path });
});

// Fallback
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "index.html")));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ APPROVALS_DIR: ${EFFECTIVE_APPROVALS_DIR}`);
});
