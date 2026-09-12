#!/usr/bin/env node
/* Auth flow test: exercises the REAL endpoints end to end against a
   disposable server in file mode (isolated temp data dir, no MONGODB_URI).
   Covers password confirmation, forgot/reset (dev console delivery),
   Google OAuth guards, session invalidation after reset, and reset.html.
   Exits 1 on any failure. Usage: node scripts/auth-flow-test.js */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = 4615;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-authflow-"));
let cookie = "";
let passed = 0, failed = 0;
const fails = [];
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; fails.push(name); console.log("  FAIL", name, extra); }
}

async function call(method, url, body, opts = {}) {
  const res = await fetch(BASE + url, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie && !opts.noAuth ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (opts.absorbCookies) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of setCookies) {
      if (line.startsWith("ch_session=")) cookie = line.split(";")[0];
    }
  }
  const type = res.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await res.json().catch(() => ({})) : null;
  return { status: res.status, payload, location: res.headers.get("location") || "" };
}

async function main() {
  const serverLog = [];
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: TMP, PAYSTACK_SECRET_KEY: "", MONGODB_URI: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  proc.stdout.on("data", d => serverLog.push(String(d)));
  proc.stderr.on("data", d => serverLog.push(String(d)));

  try {
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      try { const r = await fetch(`${BASE}/api/bootstrap`); if (r.ok) ready = true; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    check("server boots for auth-flow tests", ready);

    const email = `flow${Date.now()}@example.com`;
    const password = "password123";

    /* ---- 1. Sign-up password confirmation -------------------------------- */
    const mismatch = await call("POST", "/api/auth/signup", {
      name: "Flow Tester", email, password, confirmPassword: "different99", role: "tenant", university: "University of Lagos"
    });
    check("signup with wrong confirmation is blocked (400)", mismatch.status === 400);
    check("mismatch error is clear", /do not match/i.test(mismatch.payload.error || ""));

    const okSignup = await call("POST", "/api/auth/signup", {
      name: "Flow Tester", email, password, confirmPassword: password, role: "tenant", university: "University of Lagos"
    }, { absorbCookies: true });
    check("signup with matching confirmation creates the account (201)", okSignup.status === 201);
    check("signup issues a session cookie", okSignup.payload.user?.email === email);

    /* ---- 2. Sessions work ------------------------------------------------- */
    let boot = await call("GET", "/api/bootstrap");
    check("session is valid after signup", boot.payload.user?.email === email);

    /* ---- 3. Forgot password: unknown + known email ------------------------- */
    const unknown = await call("POST", "/api/auth/forgot", { email: `ghost${Date.now()}@example.com` });
    check("unknown email still answers 200 (no account discovery)", unknown.status === 200);
    check("unknown email response is honest but generic", /if an offkay account exists/i.test(unknown.payload.message || ""));

    const invalidEmail = await call("POST", "/api/auth/forgot", { email: "not-an-email" });
    check("invalid email format is rejected (400)", invalidEmail.status === 400);

    const forgot = await call("POST", "/api/auth/forgot", { email });
    check("known email accepts the reset request (200)", forgot.status === 200);
    check("dev delivery is flagged when RESEND_API_KEY is unset", forgot.payload.devMode === true);

    const tokenLine = serverLog.join("").split("\n").find(l => l.includes("/reset.html?token=") && l.includes(email));
    check("reset link was emitted in dev delivery (server console)", Boolean(tokenLine));
    const token = tokenLine ? (tokenLine.match(/token=([a-f0-9]{64})/) || [])[1] : "";

    /* ---- 4. Reset token verification -------------------------------------- */
    const verify = await call("GET", `/api/auth/reset/${token}`);
    check("reset link verifies (GET)", verify.status === 200);
    const badVerify = await call("GET", `/api/auth/reset/${"a".repeat(64)}`);
    check("unknown token fails verification", badVerify.status === 400);
    const malformed = await call("GET", "/api/auth/reset/deadbeef");
    check("malformed token is rejected", malformed.status === 404 || malformed.status === 400);

    /* ---- 5. Reset: validation + completion -------------------------------- */
    const wrongMatch = await call("POST", "/api/auth/reset", { token, password: "newpassword1", confirmPassword: "different99" });
    check("reset with mismatched confirmation is blocked", wrongMatch.status === 400 && /do not match/i.test(wrongMatch.payload.error || ""));
    const tooShort = await call("POST", "/api/auth/reset", { token, password: "short", confirmPassword: "short" });
    check("weak/short password is rejected on reset", tooShort.status === 400);
    const reset = await call("POST", "/api/auth/reset", { token, password: "newpassword1", confirmPassword: "newpassword1" });
    check("reset completes with matching confirmation (200)", reset.status === 200);

    /* ---- 6. Reset consequences: single use, sessions invalidated ---------- */
    const reuse = await call("POST", "/api/auth/reset", { token, password: "another123", confirmPassword: "another123" });
    check("reset token is single-use", reuse.status === 400);
    boot = await call("GET", "/api/bootstrap");
    check("old session is invalidated after reset", boot.payload.user === null);

    const oldLogin = await call("POST", "/api/auth/login", { email, password });
    check("old password no longer works (401)", oldLogin.status === 401);
    const newLogin = await call("POST", "/api/auth/login", { email, password: "newpassword1" }, { absorbCookies: true });
    check("sign-in works with the new password", newLogin.status === 200 && newLogin.payload.user?.email === email);
    boot = await call("GET", "/api/bootstrap");
    check("session valid after re-login", boot.payload.user?.email === email);

    /* ---- 7. Google OAuth guards ------------------------------------------- */
    cookie = "";
    const gStart = await call("GET", "/api/auth/google");
    check("google start with no credentials fails honestly (503)", gStart.status === 503);
    const gStart2 = await call("GET", "/api/auth/google");
    check("google start failure explains missing configuration", /GOOGLE_CLIENT_ID|not configured/i.test(gStart2.payload.error || ""));
    const gCallback = await call("GET", "/api/auth/google/callback?error=access_denied");
    check("google callback redirects on user cancel", gCallback.status === 302 && /index\.html\?authError=/.test(gCallback.location || ""));
    const gCallback2 = await call("GET", "/api/auth/google/callback?code=abc&state=wrong");
    check("google callback rejects a bad state (CSRF guard)", gCallback2.status === 302 && /authError=/.test(gCallback2.location || ""));
    const gCallback3 = await call("GET", "/api/auth/google/callback");
    check("google callback without a code redirects with an error", gCallback3.status === 302 && /authError=/.test(gCallback3.location || ""));

    /* ---- 8. reset.html page ------------------------------------------------ */
    const page = await fetch(`${BASE}/reset.html?token=${"b".repeat(64)}`);
    const html = await page.text();
    check("reset.html is served", page.status === 200 && /Choose a new password/.test(html));
    check("reset.html has password + confirm fields", /name="confirmPassword"/.test(html) && /name="password"/.test(html));
    check("reset.html has eye toggles", /pw-toggle/.test(html));

    /* ---- 9. Sign out ------------------------------------------------------- */
    cookie = "";
    const relogin = await call("POST", "/api/auth/login", { email, password: "newpassword1" }, { absorbCookies: true });
    check("re-login for sign-out test", relogin.status === 200);
    const logout = await call("POST", "/api/auth/logout", {});
    check("sign out succeeds", logout.status === 200);
    cookie = "";
    boot = await call("GET", "/api/bootstrap");
    check("protected data is inaccessible after sign out", boot.payload.user === null);

    /* ---- 10. Login validation guard ---------------------------------------- */
    const badLoginBody = await call("POST", "/api/auth/login", { email });
    check("login without a password is rejected (401)", badLoginBody.status === 401);
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    if (failed) console.log(`\nServer log tail:\n${serverLog.join("").slice(-1200)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(", ")); process.exit(1); }
}

main().catch(err => { console.error("AUTH FLOW TEST ERROR", err); process.exit(1); });
