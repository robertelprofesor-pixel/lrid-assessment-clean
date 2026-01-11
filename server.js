// server.js — LRID™ Railway production server (FINAL for Review Drafts)
// ---------------------------------------------------------------
// ✅ Intake:
//   - GET  /config/questions.lrid.v1.json
//   - POST /api/intake/submit  -> /data/data/responses_<case_id>.json
//                               + /data/data/draft_<case_id>.json (for Review Panel)
// ✅ Review:
//   - GET/POST many aliases -> returns JSON with data.data.drafts
//   - reads: /data/data/draft_*.json
// ✅ Approvals:
//   - POST /api/approval/save -> /data/approvals/approval_<case_id>.json
// ✅ Storage:
//   - Railway Volume: /data
//   - data dir: /data/data
// ---------------------------------------------------------------

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

// Log API calls to Railway logs (helps debugging immediately)
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`[API] ${req.method} ${req.path}`);
  }
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

// draft filename helpers
function draftFilenameFromCaseId(caseId) {
  return `draft_${caseId}.json`;
}
function caseIdFromDraftFilename(filename) {
  const m = filename.match(/^draft_(.+)\.json$/i);
  return m ? m[1] : null;
}

// responses filename helpers
function responsesFilenameFromCaseId(caseId) {
  return `responses_${caseId}.json`;
}
function caseIdFromResponsesFilename(filename) {
  const m = filename.match(/^responses_(.+)\.json$/i);
  return m ? m[1] : null;
}

// Build draft list for Review (reads draft_*.json)
function buildDraftList() {
  const files = listFilesSafe(EFFECTIVE_DATA_DIR).filter((f) => /^draft_.+\.json$/i.test(f));

  const drafts = files
    .map((f) => {
      const caseId = caseIdFromDraftFilename(f) || f.replace(/\.json$/i, "");
      const fullPath = path.join(EFFECTIVE_DATA_DIR, f);
      const st = statSafe(fullPath);
      return {
        case_id: caseId,
        id: caseId,
        caseId: caseId,

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

// Read draft by id (id = caseId OR draft filename)
function readDraftById(idRaw) {
  const id = String(idRaw || "").trim();

  let filename = id;
  if (!filename.endsWith(".json")) {
    if (filename.startsWith("draft_")) filename = `${filename}.json`;
    else filename = draftFilenameFromCaseId(filename);
  }

  const filePath = path.join(EFFECTIVE_DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return { ok: false, status: 404, error: "Not found", filename };

  return { ok: true, filePath, filename, content: fs.readFileSync(filePath, "utf8") };
}

// --------------------
// Intake submit (creates responses_*.json + draft_*.json)
// --------------------
async function handleIntakeSubmit(req, res) {
  try {
    const payload = safeJsonParse(req.body) || {};
    const caseId = payload.case_id ? String(payload.case_id) : makeId("LRID");

    const responsesFilename = responsesFilenameFromCaseId(caseId);
    const draftFilename = draftFilenameFromCaseId(caseId);

    const responsesPath = path.join(EFFECTIVE_DATA_DIR, responsesFilename);
    const draftPath = path.join(EFFECTIVE_DATA_DIR, draftFilename);

    // envelope kept for audit
    const envelope = {
      receivedAt: new Date().toISOString(),
      ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
      userAgent: req.headers["user-agent"],
      submission: payload,
    };

    // 1) Save responses_*.json (raw + audit)
    writeJsonFile(responsesPath, envelope);

    // 2) Save draft_*.json for Review Panel (what review UI expects)
    // The Review panel looks for: data/draft_*.json
    // We'll store the submission as draft.data so the UI can render it.
    writeJsonFile(draftPath, {
      case_id: caseId,
      status: "draft",
      created_at: new Date().toISOString(),
      source: "intake",
      data: payload,
      links: {
        responses_file: responsesFilename,
      },
    });

    // Keep compatibility with your intake.js: it prints out.file
    res.json({
      ok: true,
      case_id: caseId,

      // keep old keys for backwards compatibility:
      filename: responsesFilename,
      file: responsesPath,
      saved: responsesPath,

      // new keys:
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

// Accept multiple submit routes (robust)
[
  "/api/intake/submit",
  "/api/submit",
  "/submit",
  "/intake/submit",
].forEach((p) => app.post(p, handleIntakeSubmit));

// --------------------
// Review — Draft list endpoints (returns data.data.drafts)
// --------------------
function handleDraftList(req, res) {
  try {
    const drafts = buildDraftList();

    // Review expects: data.data.drafts
    const payload = {
      ok: true,

      // common aliases (harmless)
      drafts,
      cases: drafts,
      items: drafts,
      files: drafts,
      count: drafts.length,
      total: drafts.length,

      // nested for review.js
      data: {
        drafts,
        count: drafts.length,
        data: {
          drafts,
          count: drafts.length,
        },
      },
    };

    res.json(payload);
  } catch (err) {
    console.error("❌ Draft list error:", err);
    res.status(500).json({ ok: false, error: "Cannot list drafts" });
  }
}

// Add MANY possible paths that Review might call
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

// Read a single draft (GET)
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
  "/api/load/:id",
];

DRAFT_READ_PATHS.forEach((p) => app.get(p, handleDraftRead));

// Keep /api/case/:id working but read responses_*.json (for your direct tests)
app.get("/api/case/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const filename = id.endsWith(".json") ? id : responsesFilenameFromCaseId(id);
    const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Not found", filename });
    }
    res.type("json").send(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("❌ /api/case/:id error:", err);
    res.status(500).json({ ok: false, error: "Cannot read case" });
  }
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

// --------------------
// Finalize placeholder (PDF pipeline later)
// --------------------
app.post("/api/finalize", (req, res) => {
  res.json({
    ok: true,
    message: "Finalize endpoint is ready. PDF generation will be added next.",
  });
});

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// --------------------
// API 404 with hint
// --------------------
app.use("/api", (req, res) => {
  console.warn(`❌ API 404: ${req.method} ${req.path}`);
  res.status(404).json({
    ok: false,
    error: "API endpoint not found",
    method: req.method,
    path: req.path,
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
