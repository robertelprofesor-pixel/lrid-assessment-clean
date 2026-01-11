// server.js — drop-in replacement for Railway public domain
// Serves static HTML/JS assets and provides simple health endpoint.
// Works on Railway because it binds to process.env.PORT.

const path = require("path");
const express = require("express");

const app = express();

// ---- Basic middleware ----
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ---- Static files (IMPORTANT) ----
// Your repo has HTML/JS/JSON/CSV sitting at the repo root.
// This exposes them correctly (index.html, review.html, *.js, *.json, *.csv, etc.)
app.use(express.static(__dirname, {
  extensions: ["html"],
  fallthrough: true,
}));

// ---- Health ----
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ---- Page routes (IMPORTANT) ----
// These ensure "/" and common routes don't 404.
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/review", (req, res) => {
  res.sendFile(path.join(__dirname, "review.html"));
});

app.get("/intake", (req, res) => {
  // If you have a separate intake page, keep this.
  // If you don't have intake.html, replace with index.html.
  res.sendFile(path.join(__dirname, "intake.html"));
});

// Optional convenience routes (only if these files exist)
app.get("/questionnaire", (req, res) => {
  res.sendFile(path.join(__dirname, "questionnaire.html"));
});

// ---- Fallback: return index for unknown paths (optional SPA-like behavior) ----
// If you prefer strict 404 for unknown routes, remove this block.
app.use((req, res) => {
  // Try to serve index as a friendly default instead of Railway "not found"
  res.status(404).sendFile(path.join(__dirname, "index.html"));
});

// ---- Start server on Railway port ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
});
