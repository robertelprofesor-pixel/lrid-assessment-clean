// server.js — PRODUCTION-SAFE version for Railway
// Fixes localhost issues and exposes config JSON correctly

const path = require("path");
const express = require("express");

const app = express();

// --------------------
// Middleware
// --------------------
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// --------------------
// Static assets
// --------------------
// Serve EVERYTHING from repo root (HTML, JS, JSON, CSV)
app.use(express.static(__dirname, {
  extensions: ["html"],
  fallthrough: true,
}));

// Explicitly expose /config (important for LRID questions)
app.use("/config", express.static(path.join(__dirname)));

// --------------------
// Health check
// --------------------
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// --------------------
// Pages
// --------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/intake", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/review", (req, res) => {
  res.sendFile(path.join(__dirname, "review.html"));
});

// --------------------
// Fallback
// --------------------
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "index.html"));
});

// --------------------
// Start server
// --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ LRID™ Server running on port ${PORT}`);
});
