#!/usr/bin/env node
/* Mongo-mode auth probe: runs the SIGNUP → SIGNOUT → SIGNIN chain against a
   real MongoDB (in-memory server) using the exact production code path.
   Reproduces persistDb deletion-propagation bugs. Requires the optional
   dev-only mongodb-memory-server package; exits 0 with a notice if absent. */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

let MongoMemoryServer = null;
let useFake = false;
try { ({ MongoMemoryServer } = require("mongodb-memory-server")); }
catch {
  if (process.env.OFFKAY_FAKE_MONGO !== "1") {
    console.log("mongodb-memory-server not installed - rerun with OFFKAY_FAKE_MONGO=1 to use the file-backed fake driver");
    process.exit(0);
  }
  useFake = true;
  console.log("(no mongodb-memory-server - using file-backed fake driver: same driver API, single-process)");
}
const fakeFile = path.join(os.tmpdir(), `offkay-fakemongo-${Date.now()}.json`);

const PORT = 4613;
const BASE = `http://127.0.0.1:${PORT}`;
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
  const mongod = useFake ? null : await MongoMemoryServer.create();
  const uri = useFake ? "mongodb://fake:fake@127.0.0.1:27017/offkay" : mongod.getUri("offkay");
  if (useFake) process.env.OFFKAY_FAKE_MONGO_FILE = fakeFile;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-mongoprobe-"));
  const serverArgs = useFake
    ? ["--require", path.join(__dirname, "fake-mongo-preload.cjs"), path.join(__dirname, "..", "server.js")]
    : [path.join(__dirname, "..", "server.js")];
  const proc = spawn(process.execPath, serverArgs, {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "", MONGODB_URI: uri, MONGODB_DB: "offkay", ...(useFake ? { OFFKAY_FAKE_MONGO: "1", OFFKAY_FAKE_MONGO_FILE: fakeFile } : {}) },
    stdio: ["ignore", "ignore", "inherit"]
  });
  try {
    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    const health = await (await fetch(`${BASE}/api/health`)).json();
    check("server running in mongodb mode", health.mode === "mongodb" && health.ok === true, JSON.stringify(health).slice(0, 140));

    console.log("== reproduction: signup → signout → signin (Mongo mode) ==");
    const email = `authbug${Date.now()}@example.com`;
    const password = "correct-horse-9";

    const su = await call("POST", "/api/auth/signup", { name: "Auth Probe", email, password, role: "tenant", university: "University of Lagos" });
    check("signup succeeds (201)", su.status === 201);

    // Sign out (this mutates db.sessions -> triggers persistDb)
    const lo = await call("POST", "/api/auth/logout", {});
    check("sign out succeeds", lo.status === 200);

    const li = await call("POST", "/api/auth/login", { email, password });
    check("SIGN IN with the same email+password succeeds after signout", li.status === 200, li.status === 401 ? "-> 'Invalid credentials' REPRODUCED" : "");
    if (li.status !== 200) {
      const retry = await call("POST", "/api/auth/login", { email, password });
      check("login retry also fails (bug persists)", retry.status !== 200, "second attempt status " + retry.status);
    } else {
      const bs = await call("GET", "/api/bootstrap");
      check("session valid after login (bootstrap returns user)", bs.payload.user?.email === email);
    }

    // Session cleanup path (expired sessions pruned -> persistDb) must not eat users
    const li2 = await call("POST", "/api/auth/login", { email, password });
    check("repeated login remains stable", li2.status === 200);

    // Deletion propagation: the logout from earlier must have actually removed
    // the first session document from Mongo (not just from the request copy).
    if (useFake) {
      // The fake driver persists to a JSON file; inspect that directly instead
      // of opening a real driver connection.
      await new Promise(r => setTimeout(r, 300));
      const snap = JSON.parse(fs.readFileSync(fakeFile, "utf8")).collections;
      const sessionTokens = snap.sessions || [];
      check("exactly the live sessions exist in Mongo (signed-out one deleted, none resurrected)", sessionTokens.length === 2, `sessions in DB: ${sessionTokens.length}`);
      const userCount = (snap.users || []).filter(u => u.email === email).length;
      check("user document still present after logout", userCount === 1);
      const del = await call("DELETE", "/api/account", { password });
      check("account deletion succeeds", del.status === 200);
      await new Promise(r => setTimeout(r, 300));
      const snap2 = JSON.parse(fs.readFileSync(fakeFile, "utf8")).collections;
      const userAfterDelete = (snap2.users || []).filter(u => u.email === email).length;
      check("deleted account is gone from Mongo", userAfterDelete === 0, `users matching: ${userAfterDelete}`);
      const goneLogin = await call("POST", "/api/auth/login", { email, password });
      check("deleted account cannot log in", goneLogin.status === 401);
      const sessionsAfterDelete = (snap2.sessions || []).length;
      check("deleted account's sessions also removed from Mongo", sessionsAfterDelete === 0, `sessions left: ${sessionsAfterDelete}`);
    } else {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(uri);
    await client.connect();
    const mongoDb = client.db("offkay");
    // Two live logins have happened since logout, so exactly those two
    // session documents should exist — the signed-out one must be gone.
    const sessionTokens = await mongoDb.collection("sessions").find({}, { projection: { token: 1 } }).toArray();
    check("exactly the live sessions exist in Mongo (signed-out one deleted, none resurrected)", sessionTokens.length === 2, `sessions in DB: ${sessionTokens.length}`);
    const userCount = await mongoDb.collection("users").countDocuments({ email });
    check("user document still present after logout", userCount === 1);

    // Account deletion must propagate to Mongo.
    const del = await call("DELETE", "/api/account", { password });
    check("account deletion succeeds", del.status === 200);
    const userAfterDelete = await mongoDb.collection("users").countDocuments({ email });
    check("deleted account is gone from Mongo", userAfterDelete === 0, `users matching: ${userAfterDelete}`);
    const goneLogin = await call("POST", "/api/auth/login", { email, password });
    check("deleted account cannot log in", goneLogin.status === 401);
    const sessionsAfterDelete = await mongoDb.collection("sessions").countDocuments({});
    check("deleted account's sessions also removed from Mongo", sessionsAfterDelete === 0, `sessions left: ${sessionsAfterDelete}`);
    await client.close();
    }
  } finally {
    proc.kill("SIGKILL");
    try { if (mongod) await mongod.stop(); } catch {}
    try { fs.rmSync(fakeFile, { force: true }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(", ")); process.exit(1); }
}

main().catch(err => { console.error("PROBE ERROR", err.message); process.exit(1); });
