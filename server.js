// server.js — Railway production server (works with intake.js expecting out.file)
// - Serves static files from repo root
// - Exposes /config/*
// - Handles POST /api/intake/submit (and other common submit paths)
// - Stores submissions as JSON in DATA_DIR
// - Returns: { ok:true, file: "...", case_id: "...", ... } so UI shows Saved correctly

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

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return p;
  } catch (e) {
    const fallback = path.join("/tmp", "data");
    fs.mkdirSync(fallback, { recursive: true });
    console.warn(`⚠️ DATA_DIR not writable, using fallback: ${fallback}`);
    return fallback;
  }
}

const EFFECTIVE_DATA_DIR = ensureDir(DATA_DIR);

// --------------------
// Middleware
// --------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

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
  const candidate =
    payload.submission ||
    payload.response ||
    payload.responses ||
    payload.data ||
    payload.payload ||
    payload;

  return {
    receivedAt: new Date().toISOString(),
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
    makeId("LRID");

  const filename = `responses_${caseId}.json`; // match intake.js comment
  const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
  return { caseId, filename, filePath };
}

function publicBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
}

// --------------------
// Submit handler (THIS is what your intake.js uses)
// --------------------
async function handleSubmit(req, res) {
  try {
    const envelope = normalizeSubmission(req.body);
    envelope.ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;
    envelope.userAgent = req.headers["user-agent"];

    const { caseId, filename, filePath } = writeSubmissionFile(envelope);

    const base = publicBaseUrl(req);
    const reviewUrl = base ? `${base}/review` : "/review";
    const caseUrl = base ? `${base}/api/case/${encodeURIComponent(filename)}` : `/api/case/${encodeURIComponent(filename)}`;

    // ⭐ KEY: intake.js expects out.file
    res.json({
      ok: true,

      // intake.js uses its own caseId variable, but we still return it for consistency
      case_id: caseId,
      filename,
      file: filePath,                // ✅ this fixes "Saved: undefined"
      file_path: filePath,
      saved: filePath,
      savedPath: filePath,

      // helpful links
      review_url: reviewUrl,
      case_url: caseUrl,

      message: "Submission stored",
    });
  } catch (err) {
    console.error("❌ Submit error:", err);
    res.status(500).json({ ok: false, error: "Submit failed (server error)" });
  }
}

// Register common paths
const SUBMIT_PATHS = [
  "/api/intake/submit", // your intake.js
  "/submit",
  "/api/submit",
  "/api/intake",
  "/api/responses",
  "/intake/submit",
];

SUBMIT_PATHS.forEach((p) => app.post(p, handleSubmit));

// --------------------
// Minimal “case reading” for debugging
// Here id is filename (responses_CASE.json) or caseId without prefix handling.
// --------------------
app.get("/api/case/:name", (req, res) => {
  try {
    const name = req.params.name;

    // Allow passing full filename or just caseId
    const filename = name.endsWith(".json") ? name : `responses_${name}.json`;
    const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "Not found", filename });
    }

    res.type("json").send(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("❌ /api/case error:", err);
    res.status(500).json({ ok: false, error: "Cannot read case" });
  }
});

// Pages
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/intake", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(__dirname, "review.html")));

// Unknown POST debug
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
  console.log(`✅ Submit endpoints: ${SUBMIT_PATHS.join(", ")}`);
});
