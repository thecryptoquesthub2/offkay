#!/usr/bin/env node
"use strict";
// Boots the server against the seeded scratch data dir, logs in as the demo
// tenant, saves the real /api/bootstrap payload to /tmp/seeded-bootstrap.json
// so head-render-diag.js can run the client render path against live data.
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PORT = 4679;
const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, OFFKAY_DATA_DIR: "/tmp/seedtest", PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: "ignore"
});

setTimeout(async () => {
  try {
    const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tenant@demo.test", password: "demo1234" })
    });
    const cookie = login.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
    const res = await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`, { headers: { cookie } });
    fs.writeFileSync("/tmp/seeded-bootstrap.json", await res.text());
    console.log("payload captured");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  srv.kill();
}, 1500);
