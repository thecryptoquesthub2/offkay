"use strict";
/* Multi-instance session regression (the "logged out 3 times after sign-in" bug).
   Two server processes share one database (fake Mongo driver, shared file mode)
   exactly like two Vercel lambda instances sharing Atlas:
     1. Instance B boots and caches a snapshot BEFORE any account exists.
     2. Instance A signs the user up + in (session written to the shared DB).
     3. Within B's snapshot TTL (<3s), the SAME valid session cookie hits B.
   OLD behavior: B 401s a perfectly valid session -> client force-logout loop.
   NEW behavior: B's snapshot miss triggers the Mongo revive -> 200, and
   GET /api/session authoritatively confirms the session for the client. */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PORT_A = 4647;
const PORT_B = 4648;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const fakeFile = path.join(os.tmpdir(), `session-two-instance-${Date.now()}.json`);
const dataA = fs.mkdtempSync(path.join(os.tmpdir(), "sess-a-"));
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), "sess-b-"));

const boot = (port, dataDir) => spawn(process.execPath,
  ["--require", path.join(__dirname, "fake-mongo-preload.cjs"), path.join(__dirname, "..", "server.js")],
  { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OFFKAY_DATA_DIR: dataDir, PAYSTACK_SECRET_KEY: "",
    MONGODB_URI: "mongodb://fake@127.0.0.1:27017/offkay", MONGODB_DB: "offkay",
    OFFKAY_FAKE_MONGO: "1", OFFKAY_FAKE_MONGO_FILE: fakeFile, OFFKAY_FAKE_MONGO_SHARED: "1" },
    stdio: ["ignore", "ignore", "inherit"] });

let passed = 0, failed = 0;
const check = (name, ok, extra = "") => { if (ok) { passed++; console.log("  ok  ", name); } else { failed++; console.log("  FAIL", name, extra); } };
const ready = async base => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch {} await new Promise(r => setTimeout(r, 150)); } return false; };

(async () => {
  let procA = null, procB = null;
  try {
    procB = boot(PORT_B, dataB);
    check("instance B booted (no accounts yet)", await ready(BASE_B));
    // Warm B's snapshot with an anonymous bootstrap: its cache now predates the login.
    await fetch(`${BASE_B}/api/bootstrap`);

    procA = boot(PORT_A, dataA);
    check("instance A booted", await ready(BASE_A));
    const email = `sess${Date.now()}@example.com`;
    const su = await fetch(`${BASE_A}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Friend", email, password: "session-pass-1", role: "tenant", university: "University of Lagos" }) });
    const cookie = (su.headers.getSetCookie ? su.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    check("signup + session issued on instance A", su.status === 201 && cookie.includes("ch_session="), `status=${su.status}`);

    // Immediately (< B's 3s snapshot TTL) hit instance B with the valid cookie.
    const onB = await fetch(`${BASE_B}/api/bootstrap`, { headers: { Cookie: cookie } });
    check("valid session NOT 401'd by stale instance B (revived)", onB.status === 200, `status=${onB.status}`);
    const me = await fetch(`${BASE_B}/api/session`, { headers: { Cookie: cookie } });
    const mePayload = await me.json().catch(() => ({}));
    check("/api/session confirms the session on B", me.status === 200 && mePayload.user?.email === email, `status=${me.status} user=${JSON.stringify(mePayload.user)?.slice(0, 60)}`);

    // A bad token must still be rejected (fail closed).
    const bad = await fetch(`${BASE_B}/api/session`, { headers: { Cookie: "ch_session=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } });
    const badPayload = await bad.json().catch(() => ({}));
    check("invalid token still rejected", bad.status === 200 && badPayload.user === null, `status=${bad.status}`);

    // Revocation must converge across instances: B deletes the session in
    // Mongo; A's snapshot (up to DB_CACHE_TTL stale) drops it on the next
    // refresh. The persistedIndex diff makes resurrection impossible - a
    // stale snapshot's write never re-upserts an unchanged document.
    const lo = await fetch(`${BASE_B}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
    check("logout via instance B works", lo.status === 200);
    // A answers from its snapshot and refreshes in the background, so poll
    // until its TTL refresh (3s) has actually converged.
    let revoked = false, lastUser = "unknown";
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      const after = await fetch(`${BASE_A}/api/session`, { headers: { Cookie: cookie } });
      const afterPayload = await after.json().catch(() => ({}));
      lastUser = JSON.stringify(afterPayload.user)?.slice(0, 40) || "null";
      if (afterPayload.user === null) { revoked = true; break; }
    }
    check("session revoked across instances after logout (converged)", revoked, `lastUser=${lastUser}`);
  } catch (e) {
    console.error("PROBE ERROR", e);
    failed++;
  } finally {
    try { procA?.kill("SIGKILL"); } catch {}
    try { procB?.kill("SIGKILL"); } catch {}
    for (const f of [fakeFile]) try { fs.rmSync(f, { force: true }); } catch {}
    for (const d of [dataA, dataB]) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
