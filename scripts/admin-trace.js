#!/usr/bin/env node
"use strict";
// Trace why CORE_ADMIN_EMAILS promotion is not reflected in bootstrap responses.
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admintrace-"));
const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: {
    ...process.env, PORT: "4608", HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp,
    ADMIN_TOKEN: "tok", CORE_ADMIN_EMAILS: "owner@offkay.test", PAYSTACK_SECRET_KEY: ""
  },
  stdio: "ignore"
});

(async () => {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch("http://127.0.0.1:4608/api/health")).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const su = await fetch("http://127.0.0.1:4608/api/auth/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Owner", email: "owner@offkay.test", password: "ownerpass123", role: "tenant", university: "University of Lagos" })
  });
  const cookies = su.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  console.log("signup status:", su.status);
  const boot = await fetch("http://127.0.0.1:4608/api/bootstrap", { headers: { Cookie: cookies } });
  const data = await boot.json();
  console.log("bootstrap role:", data.user.role, "| isCoreAdmin:", data.user.isCoreAdmin);
  const db = JSON.parse(fs.readFileSync(path.join(tmp, "db.json"), "utf8"));
  const u = db.users.find(x => x.email === "owner@offkay.test");
  console.log("db.json role:", u.role);
  proc.kill();
})();
