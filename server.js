// server.js — Railway production server (fixes Submit 404 + returns saved path)
// - Serves static files from repo root
// - Exposes /config/*
// - Adds robust submit endpoints
// - Stores submissions as JSON in DATA_DIR (Railway volume if configured)
// - Returns fields expected by frontend: saved, saved_to, file_path, case_id, review_url

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
    // If /data isn't writable (no volume), fallback to /tmp
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

  const filename = `${caseId}.json`;
  const filePath = path.join(EFFECTIVE_DATA_DIR, filename);

  fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
  return { caseId, filename, filePath };
}

function publicBaseUrl(req) {
  // Railway terminates TLS and passes proto/host
  const proto = (req.headers["x-forwarded-proto"] || "https").toString();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return host ? `${proto}://${host}` : "";
}

// --------------------
// Submit handler
// --------------------
async function handleSubmit(req, res) {
  try {
    const envelope = normalizeSubmission(req.body);
    envelope.ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress;
    envelope.userAgent = req.headers["user-agent"];

    const { caseId, filename, filePath } = writeSubmissionFile(envelope);

    const base = publicBaseUrl(req);
    const reviewUrl = base ? `${base}/review` : "/review";
    const caseUrl = base ? `${base}/api/case/${encodeURIComponent(caseId)}` : `/api/case/${encodeURIComponent(caseId)}`;

    // IMPORTANT: return multiple aliases so frontend never shows "Saved: undefined"
    res.json({
      ok: true,

      // common id fields
      case_id: caseId,
      caseId: caseId,
      id: caseId,

      // common "saved" fields
      saved: filePath,
      saved_to: filePath,
      file_path: filePath,
      filePath: filePath,
      filename,

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

// Multiple endpoints to match existing frontend variants
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
// Review helpers
// --------------------
app.get("/api/cases", (req, res) => {
  try {
    const files = fs.readdirSync(EFFECTIVE_DATA_DIR).filter((f) => f.endsWith(".json"));
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

// Debug: log unknown POSTs
app.post("*", (req, res) => {
  console.warn(`⚠️ Unhandled POST ${req.path} — returning 404`);
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
