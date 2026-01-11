// server.js — LRID™ Railway production server (Option A + Anti-404 for Review)
// ✅ Intake: POST /api/intake/submit -> /data/data/responses_<case_id>.json, returns out.file
// ✅ Review: supports MANY possible refresh/load endpoints to avoid 404
// ✅ Storage: uses Railway Volume at /data (fallback /tmp)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const app = express();

// --------------------
// Storage
// --------------------
const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");

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

// Simple request logger for API calls (helps immediately in Railway logs)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
  next();
});

// --------------------
// Static
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

function responsesFilenameFromCaseId(caseId) {
  return `responses_${caseId}.json`;
}

function caseIdFromResponsesFilename(filename) {
  const m = filename.match(/^responses_(.+)\.json$/i);
  return m ? m[1] : null;
}

function writeJsonFile(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
}

function buildDraftList() {
  // Option A: drafts == responses_*.json
  const files = listFilesSafe(EFFECTIVE_DATA_DIR).filter((f) => /^responses_.+\.json$/i.test(f));

  const drafts = files
    .map((f) => {
      const caseId = caseIdFromResponsesFilename(f) || f.replace(/\.json$/i, "");
      const fullPath = path.join(EFFECTIVE_DATA_DIR, f);
      const st = statSafe(fullPath);
      return {
        case_id: caseId,
        id: caseId,
        caseId: caseId,

        // file fields (different UIs expect different keys)
        file: f,
        filename: f,
        path: fullPath,
        filePath: fullPath,

        mtime: st ? st.mtimeMs : 0,
        size: st ? st.size : 0,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return drafts;
}

function readDraftById(idRaw) {
  const id = String(idRaw || "").trim();

  // Accept:
  // - LRID-2026...
  // - responses_LRID-2026....json
  // - responses_LRID-2026....
  // - direct filename
  let filename = id;

  if (!filename.endsWith(".json")) {
    if (filename.startsWith("responses_")) filename = `${filename}.json`;
    else filename = responsesFilenameFromCaseId(filename);
  }

  const filePath = path.join(EFFECTIVE_DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: "Not found", filename };

  return { ok: true, filePath, filename, content: fs.readFileSync(filePath, "utf8") };
}

// --------------------
// Intake submit (works with your intake.js expecting out.file)
// --------------------
async function handleIntakeSubmit(req, res) {
  try {
    const payload = safeJsonParse(req.body) || {};
    const caseId = payload.case_id ? String(payload.case_id) : makeId("LRID");
    const filename = responsesFilenameFromCaseId(caseId);
    const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

    const envelope = {
      receivedAt: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
      submission: payload,
    };

    writeJsonFile(filePath, envelope);

    res.json({
      ok: true,
      case_id: caseId,
      filename,
      file: filePath, // ✅ intake.js prints out.file
      saved: filePath,
      review_url: `${publicBaseUrl(req)}/review`,
      message: "Submission stored",
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
// REVIEW — Anti-404 endpoints
// --------------------

// This handler returns the same payload for many possible "refresh" routes
function handleDraftList(req, res) {
  try {
    const drafts = buildDraftList();

    // Return MANY aliases - different frontends expect different keys
    res.json({
      ok: true,
      drafts,
      cases: drafts,
      items: drafts,
      files: drafts,

      count: drafts.length,
      total: drafts.length,

      note: "Option A: draft list is responses_*.json",
    });
  } catch (err) {
    console.error("❌ Draft list error:", err);
    res.status(500).json({ ok: false, error: "Cannot list drafts" });
  }
}

// Add MANY common endpoints (GET + POST) used by “review panels”
const DRAFT_LIST_PATHS = [
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

DRAFT_LIST_PATHS.forEach((p) => {
  app.get(p, handleDraftList);
  app.post(p, handleDraftList);
});

// Load one draft/case (GET) — add aliases too
function handleDraftRead(req, res) {
  const id = req.params.id;
  const out = readDraftById(id);

  if (!out.ok) {
    return res.status(out.status || 404).json({ ok: false, error: out.error, filename: out.filename });
  }

  res.type("json").send(out.content);
}

const DRAFT_READ_PATHS = [
  "/api/draft/:id",
  "/api/drafts/:id",
  "/api/review/draft/:id",
  "/api/review/case/:id",
  "/api/case/:id",
  "/api/load/:id",
];

DRAFT_READ_PATHS.forEach((p) => app.get(p, handleDraftRead));

// Approval save (optional, for your buttons)
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

// Finalize placeholder (PDF next)
app.post("/api/finalize", (req, res) => {
  res.json({ ok: true, message: "Finalize ready. PDF generation will be added next." });
});

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// --------------------
// API 404 with hint (VERY IMPORTANT)
// --------------------
app.use("/api", (req, res) => {
  // If we still missed the endpoint, we want the exact path in logs.
  console.warn(`❌ API 404: ${req.method} ${req.path}`);
  res.status(404).json({
    ok: false,
    error: "API endpoint not found",
    method: req.method,
    path: req.path,
    hint: "Open Railway logs to see which endpoint Review is calling.",
  });
});

// Fallback
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "index.html")));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ APPROVALS_DIR: ${EFFECTIVE_APPROVALS_DIR}`);
  console.log(`✅ Draft list aliases: ${DRAFT_LIST_PATHS.join(", ")}`);
  console.log(`✅ Draft read aliases: ${DRAFT_READ_PATHS.join(", ")}`);
});
