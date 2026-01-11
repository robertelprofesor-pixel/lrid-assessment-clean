// server.js — LRID™ Railway production server (Option A: Review reads responses_*.json)
// ✅ Intake:
//   - GET  /config/questions.lrid.v1.json
//   - POST /api/intake/submit  -> /data/data/responses_<case_id>.json
// ✅ Review (Option A):
//   - GET  /api/drafts         -> lists responses_*.json as "draft cases"
//   - GET  /api/draft/:id      -> returns saved response file for selected case
//   - POST /api/approval/save  -> saves approval JSON (approvals/approval_<case_id>.json)
//   - POST /api/finalize       -> placeholder (ready for PDF pipeline later)
// ✅ Storage: Railway Volume mounted at /data (data dir: /data/data)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const app = express();

// --------------------
// Storage paths
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

function normalizeSubmission(body) {
  const payload = safeJsonParse(body) || {};
  // Intake sends the full payload directly
  return {
    receivedAt: new Date().toISOString(),
    submission: payload,
  };
}

function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
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

// Extract case id from filename: responses_LRID-YYYYMMDD-XXXX.json
function caseIdFromResponsesFilename(filename) {
  const m = filename.match(/^responses_(.+)\.json$/i);
  return m ? m[1] : null;
}

function responsesFilenameFromCaseId(caseId) {
  return `responses_${caseId}.json`;
}

function writeJsonFile(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

// --------------------
// Intake submit (works with your intake.js expecting out.file)
// --------------------
async function handleIntakeSubmit(req, res) {
  try {
    const envelope = normalizeSubmission(req.body);
    envelope.ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;
    envelope.userAgent = req.headers["user-agent"];

    const caseId = (req.body && req.body.case_id) ? String(req.body.case_id) : makeId("LRID");
    const filename = responsesFilenameFromCaseId(caseId);
    const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

    writeJsonFile(filePath, envelope);

    res.json({
      ok: true,
      case_id: caseId,
      filename,
      file: filePath, // ✅ intake.js prints out.file
      saved: filePath,
      message: "Submission stored",
      review_url: `${publicBaseUrl(req)}/review`,
    });
  } catch (err) {
    console.error("❌ Intake submit error:", err);
    res.status(500).json({ ok: false, error: "Submit failed (server error)" });
  }
}

const SUBMIT_PATHS = [
  "/api/intake/submit", // your intake.js
  "/api/submit",
  "/submit",
  "/intake/submit",
];

SUBMIT_PATHS.forEach((p) => app.post(p, handleIntakeSubmit));

// --------------------
// Review — Option A: draft list == responses_*.json
// --------------------

// ✅ Review refresh should call this (we make it exist)
app.get("/api/drafts", (req, res) => {
  try {
    const files = listFilesSafe(EFFECTIVE_DATA_DIR).filter((f) => /^responses_.+\.json$/i.test(f));

    const drafts = files
      .map((f) => {
        const caseId = caseIdFromResponsesFilename(f) || f.replace(/\.json$/i, "");
        const fullPath = path.join(EFFECTIVE_DATA_DIR, f);
        const st = statSafe(fullPath);
        return {
          case_id: caseId,
          file: f,
          path: fullPath,
          mtime: st ? st.mtimeMs : 0,
          size: st ? st.size : 0,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    res.json({
      ok: true,
      drafts,
      count: drafts.length,
      note: "Option A: drafts are responses_*.json files",
    });
  } catch (err) {
    console.error("❌ /api/drafts error:", err);
    res.status(500).json({ ok: false, error: "Cannot list drafts" });
  }
});

// Read selected case (accepts caseId or filename)
app.get("/api/draft/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    let filename = id;
    if (!filename.endsWith(".json")) {
      // If it's a case id, map to responses_<id>.json
      filename = responsesFilenameFromCaseId(id);
    }

    // If user passed "responses_*.json" without .json, handle
    if (!filename.endsWith(".json") && filename.startsWith("responses_")) filename += ".json";

    const filePath = path.join(EFFECTIVE_DATA_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Not found", filename });
    }

    res.type("json").send(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("❌ /api/draft/:id error:", err);
    res.status(500).json({ ok: false, error: "Cannot read draft" });
  }
});

// Convenience: keep your /api/case working
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
// Approval save (for your Review Panel buttons)
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

    if (!caseId) {
      return res.status(400).json({ ok: false, error: "Missing case_id in approval payload" });
    }

    const filename = `approval_${caseId}.json`;
    const filePath = path.join(EFFECTIVE_APPROVALS_DIR, filename);

    const envelope = {
      savedAt: new Date().toISOString(),
      case_id: caseId,
      approval: payload,
    };

    writeJsonFile(filePath, envelope);

    res.json({
      ok: true,
      case_id: caseId,
      file: filePath,
      message: "Approval saved",
    });
  } catch (err) {
    console.error("❌ /api/approval/save error:", err);
    res.status(500).json({ ok: false, error: "Cannot save approval" });
  }
});

// --------------------
// Finalize placeholder (PDF pipeline later)
// --------------------
app.post("/api/finalize", (req, res) => {
  // We'll wire PDFs here in the next step once review flow works.
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

// Debug unknown POST
app.post("*", (req, res) => {
  console.warn(`⚠️ Unhandled POST ${req.path}`);
  res.status(404).json({ ok: false, error: `Not found: POST ${req.path}` });
});

// Fallback
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "index.html"));
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ APPROVALS_DIR: ${EFFECTIVE_APPROVALS_DIR}`);
  console.log(`✅ Submit endpoints: ${SUBMIT_PATHS.join(", ")}`);
  console.log(`✅ Review endpoint: GET /api/drafts, GET /api/draft/:id`);
});
