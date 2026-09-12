#!/usr/bin/env node
/* Quick health-shape check: VERCEL=1 without MONGODB_URI should report
   storage:"ephemeral" + warning; plain file mode reports storage:"file". */
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function waitForHealth(base) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) return r.json(); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never became healthy");
}

async function boot(env, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-health-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, ...env, OFFKAY_DATA_DIR: tmp, HOST: "127.0.0.1" },
    stdio: "ignore"
  });
  try {
    const body = await waitForHealth(`http://127.0.0.1:${env.PORT}`);
    console.log(label, JSON.stringify({ mode: body.mode, storage: body.storage, warning: body.warning || null, ok: body.ok }));
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  await boot({ PORT: "4618", MONGODB_URI: "", VERCEL: "1", PAYSTACK_SECRET_KEY: "" }, "[vercel, no db]");
  await boot({ PORT: "4619", MONGODB_URI: "", PAYSTACK_SECRET_KEY: "" }, "[file mode]      ");
})().catch(err => { console.error(err); process.exit(1); });
