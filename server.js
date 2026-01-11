// server.js — Railway production server (fixes Submit 404)
// - Serves static files (HTML/JS/JSON/CSV) from repo root
// - Exposes /config/*
// - Adds robust intake submit endpoints (multiple paths) to avoid 404
// - Stores submissions as JSON in DATA_DIR (Railway volume if configured)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const app = express();

// --------------------
// Config / storage paths
// --------------------
const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");

// Ensure DATA_DIR exists (works locally and on Railway volume)
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    // If /data isn't writable (no volume), fallback to /tmp
    if (p === DATA_DIR) {
      const fallback = path.join("/tmp", "data");
      try {
        fs.mkdirSync(fallback, { recursive: true });
        console.warn(`⚠️ DATA_DIR not writable, using fallback: ${fallback}`);
        return fallback;
      } catch (err) {
        console.error("❌ Cannot create fallback data dir:", err);
      }
    }
  }
  return p;
}

let EFFECTIVE_DATA_DIR = ensureDir(DATA_DIR);

// --------------------
// Middleware
// --------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// --------------------
// Static assets
// --------------------
// Serve everything from repo root (index.html, review.html, *.js, *.json, *.csv, etc.)
app.use(express.static(__dirname, { extensions: ["html"], fallthrough: true }));

// Explicitly expose /config/* (frontend loads questions from here)
app.use("/config", express.static(__dirname));

// --------------------
// Health
// --------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    storageRoot: STORAGE_ROOT,
    dataDir: EFFECTIVE_DATA_DIR,
    time: new Date().toISOString(),
  });
});

// --------------------
// Helpers
// --------------------
function makeId(prefix = "case") {
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
  // Accept many shapes. Keep original body but create consistent envelope.
  const payload = safeJsonParse(body) || {};
  const candidate =
    payload.submission ||
    payload.response ||
    payload.responses ||
    payload.data ||
    payload.payload ||
    payload;

  return {
    receivedAt: new Date().toISOString(),
    ua: body && body.__ua ? body.__ua : undefined,
    ip: undefined, // filled later
    submission: candidate,
    raw: payload,
  };
}

function writeSubmissionFile(envelope) {
  const caseId =
    envelope?.submission?.case_id ||
    envelope?.submission?.caseId ||
    envelope?.raw?.case_id ||
    envelope?.raw?.caseId ||
    makeId("case");

  const filePath = path.join(EFFECTIVE_DATA_DIR, `${caseId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
  return { caseId, filePath };
}

// --------------------
// Submit handler (fixes HTTP 404)
// --------------------
async function handleSubmit(req, res) {
  try {
    const envelope = normalizeSubmission(req.body);
    envelope.ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;

    const { caseId } = writeSubmissionFile(envelope);

    // Return something useful to frontend
    res.json({
      ok: true,
      case_id: caseId,
      message: "Submission stored",
    });
  } catch (err) {
    console.error("❌ Submit error:", err);
    res.status(500).json({ ok: false, error: "Submit failed (server error)" });
  }
}

// Register multiple common endpoints to match your existing frontend code.
// (Any one of these matching will stop the 404.)
const SUBMIT_PATHS = [
  "/submit",
  "/api/submit",
  "/api/intake",
  "/api/intake/submit",
  "/api/responses",
  "/intake/submit",
];

SUBMIT_PATHS.forEach((p) => app.post(p, handleSubmit));

// --------------------
// Review helpers (optional but useful)
// --------------------
app.get("/api/cases", (req, res) => {
  try {
    const files = fs.readdirSync(EFFECTIVE_DATA_DIR).filter((f) => f.endsWith(".json"));
    // newest first
    files.sort((a, b) => (a < b ? 1 : -1));
    const cases = files.slice(0, 200).map((f) => ({
      case_id: f.replace(/\.json$/i, ""),
      filename: f,
    }));
    res.json({ ok: true, cases });
  } catch (err) {
    console.error("❌ /api/cases error:", err);
    res.status(500).json({ ok: false, error: "Cannot list cases" });
  }
});

app.get("/api/case/:id", (req, res) => {
  try {
    const id = req.params.id;
    const filePath = path.join(EFFECTIVE_DATA_DIR, `${id}.json`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: "Not found" });
    const content = fs.readFileSync(filePath, "utf8");
    res.type("json").send(content);
  } catch (err) {
    console.error("❌ /api/case/:id error:", err);
    res.status(500).json({ ok: false, error: "Cannot read case" });
  }
});

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// --------------------
// Debug: log unknown POSTs (helps if frontend uses a different endpoint)
// --------------------
app.post("*", (req, res) => {
  console.warn(`⚠️ Unhandled POST ${req.path} — returning 404`);
  res.status(404).json({ ok: false, error: `Not found: POST ${req.path}` });
});

// --------------------
// Fallback (avoid Railway "Not Found" page)
// --------------------
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "index.html"));
});

// --------------------
// Start
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
  console.log(`✅ DATA_DIR: ${EFFECTIVE_DATA_DIR}`);
  console.log(`✅ Submit endpoints: ${SUBMIT_PATHS.join(", ")}`);
});
