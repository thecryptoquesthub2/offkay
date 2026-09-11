#!/usr/bin/env node
// Integration check for the /api/health diagnostic route. Boots a disposable
// server on an isolated temp database and probes health, unknown routes, and
// the demo login path. Usage: node scripts/health-test.js
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-health-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  const bail = (message) => {
    proc.kill("SIGKILL");
    console.error(`  FAIL ${message}`);
    process.exit(1);
  };
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${BASE}/api/bootstrap`)).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
      if (i === 49) bail("server did not start");
    }

    const health = await fetch(`${BASE}/api/health`);
    const body = await health.json();
    console.log(`  health: ${health.status} ${JSON.stringify(body)}`);
    if (health.status !== 200 || body.ok !== true || body.mode !== "file" || !body.time) bail("health payload wrong");

    const missing = await fetch(`${BASE}/api/definitely-not-real`);
    console.log(`  unknown route: ${missing.status}`);
    if (missing.status !== 404) bail("unknown route should 404");

    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tenant@demo.test", password: "demo1234" })
    });
    console.log(`  demo login: ${login.status}`);
    if (!login.ok) bail("demo login broken");

    console.log("HEALTH TEST PASSED");
  } finally {
    proc.kill("SIGKILL");
  }
}

run().catch(error => { console.error("  FAIL", error.message); process.exit(1); });
