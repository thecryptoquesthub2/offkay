#!/usr/bin/env node
// Integration check for the /api/health diagnostic route. Boots disposable
// servers on isolated temp storage: one healthy file-mode server, then one
// configured with a placeholder MONGODB_URI to prove the URI lint reports
// the exact copy-paste mistake. Usage: node scripts/health-test.js
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4599;
const LINT_PORT = 4598;
const BASE = `http://127.0.0.1:${PORT}`;
const LINT_BASE = `http://127.0.0.1:${LINT_PORT}`;

function bootServer(port, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-health-"));
  return spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "", ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"]
  });
}

async function waitReady(base, proc, label) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/health`); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
    if (i === 49) { proc.kill("SIGKILL"); throw new Error(`${label} did not start`); }
  }
}

async function run() {
  // Phase 1: healthy file-mode server.
  const proc = bootServer(PORT);
  const bail = (message) => { proc.kill("SIGKILL"); console.error(`  FAIL ${message}`); process.exit(1); };
  try {
    await waitReady(BASE, proc, "file-mode server");

    const health = await fetch(`${BASE}/api/health`);
    const body = await health.json();
    console.log(`  health: ${health.status} ${JSON.stringify(body)}`);
    if (health.status !== 200 || body.ok !== true || body.mode !== "file" || !body.time) bail("health payload wrong");

    const missing = await fetch(`${BASE}/api/definitely-not-real`);
    console.log(`  unknown route: ${missing.status}`);
    if (missing.status !== 404) bail("unknown route should 404");

    const signup = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Health User", email: "health.user@example.com", password: "password123", role: "tenant", university: "University of Lagos" })
    });
    console.log(`  signup: ${signup.status}`);
    if (!signup.ok) bail("signup broken");
    console.log("  FILE-MODE PASSED");
  } finally {
    proc.kill("SIGKILL");
  }

  // Phase 2: placeholder-credential URI must produce the exact lint code.
  const lintProc = bootServer(LINT_PORT, { MONGODB_URI: "mongodb+srv://offkay_user:<password>@cluster0.abcd.mongodb.net/?retryWrites=true&w=majority" });
  try {
    await waitReady(LINT_BASE, lintProc, "lint server");
    const res = await fetch(`${LINT_BASE}/api/health`);
    const body = await res.json();
    console.log(`  lint health: ${res.status} code=${body.code}`);
    if (res.status !== 503 || body.ok !== false || body.code !== "placeholder-credentials") throw new Error("placeholder URI not detected");
    console.log("  URI-LINT PASSED");
  } finally {
    lintProc.kill("SIGKILL");
  }

  console.log("HEALTH TEST PASSED");
}

run().catch(error => { console.error("  FAIL", error.message); process.exit(1); });
