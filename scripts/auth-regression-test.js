#!/usr/bin/env node
/* Auth regression probe: SIGNUP → SIGNOUT → SIGNIN against the real server
   in file mode (no MONGODB_URI). Verifies persistence, hashing, sessions,
   duplicate handling, and email normalization. Exits 1 on any failure. */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-authprobe-"));
const DB_FILE = path.join(TMP, "db.json");
let cookie = "";
let passed = 0, failed = 0;
const fails = [];
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; fails.push(name); console.log("  FAIL", name, extra); }
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies[0].split(";")[0];
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: TMP, PAYSTACK_SECRET_KEY: "", MONGODB_URI: "" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`${BASE}/api/bootstrap`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    console.log("== reproduction: signup → signout → signin ==");
    const email = `authbug${Date.now()}@example.com`;
    const password = "correct-horse-9";

    const su = await call("POST", "/api/auth/signup", { name: "Auth Probe", email, password, role: "tenant", university: "University of Lagos" });
    check("signup succeeds (201)", su.status === 201);
    check("signup response confirms account created", Boolean(su.payload.user?.id));

    const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const stored = db.users.find(u => u.email === email);
    check("user persisted to the same store login reads (db.json users[])", Boolean(stored));
    check("password stored as salt:scrypt hash, not plaintext", Boolean(stored && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored.password)) && stored.password !== password);

    const lo = await call("POST", "/api/auth/logout", {});
    check("sign out succeeds", lo.status === 200);
    const dbAfterLogout = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    check("sign out does NOT delete the user record", dbAfterLogout.users.some(u => u.email === email));
    check("sign out does NOT touch the stored password", dbAfterLogout.users.find(u => u.email === email)?.password === stored.password);

    const li = await call("POST", "/api/auth/login", { email, password });
    check("SIGN IN with the same email+password succeeds", li.status === 200 && Boolean(li.payload.user));
    const bs = await call("GET", "/api/bootstrap");
    check("session valid after login (bootstrap returns user)", bs.payload.user?.email === email);

    cookie = "";
    const bad = await call("POST", "/api/auth/login", { email, password: "definitely-wrong" });
    check("control: wrong password still rejected (401)", bad.status === 401);
    const dup = await call("POST", "/api/auth/signup", { name: "Dup", email, password, role: "tenant", university: "University of Lagos" });
    check("duplicate email rejected (409)", dup.status === 409);

    const cs = await call("POST", "/api/auth/signup", { name: "Case Probe", email: "Case.Probe@Example.COM", password, role: "tenant", university: "University of Lagos" });
    const cli = await call("POST", "/api/auth/login", { email: "  case.probe@example.com  ", password });
    check("email case/whitespace normalized consistently (signup→login)", cs.status === 201 && cli.status === 200);

    // Phase 2: reproduce the ORIGINAL production failure mode — serverless
    // (VERCEL=1) with no MONGODB_URI. Before the fix, signup reported 201 and
    // the account evaporated with the instance → "Email or password is
    // incorrect" on the next sign-in. Now signup must fail honestly.
    console.log("\n== reproduction: serverless without a database (VERCEL=1, no MONGODB_URI) ==");
    proc.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 150));
    const ephemeral = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "offkay-authprobe-eph-")), PAYSTACK_SECRET_KEY: "", MONGODB_URI: "", VERCEL: "1" },
      stdio: ["ignore", "ignore", "ignore"]
    });
    try {
      for (let i = 0; i < 50; i++) {
        try { const r = await fetch(`${BASE}/api/bootstrap`); if (r.ok) break; } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
      const esu = await call("POST", "/api/auth/signup", { name: "Ephemeral Probe", email: `eph${Date.now()}@example.com`, password, role: "tenant", university: "University of Lagos" });
      check("signup is REFUSED, not silently dropped (503)", esu.status === 503);
      check("refusal explains the missing MONGODB_URI (frontend shows it verbatim)", /cannot be saved/i.test(esu.payload.error || "") && /MONGODB_URI/i.test(esu.payload.error || ""));
      const eli = await call("POST", "/api/auth/login", { email: "ephemeral-refused@example.com", password });
      check("login after refused signup stays honest (401, no ghost account)", eli.status === 401);
    } finally {
      ephemeral.kill("SIGKILL");
    }
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(", ")); process.exit(1); }
}

main().catch(err => { console.error("PROBE ERROR", err); process.exit(1); });
