"use strict";
/* ID-document end-to-end in Mongo mode (fake driver):
   student submits verification with an ID image -> instance RESTARTS ->
   admin (core admin via env seed) fetches /api/admin/verification/:id/
   document/idCard -> must return image bytes, proving the token-keyed media
   path survives cold instances. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PORT = 4642;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fakeFile = path.join(os.tmpdir(), `doc-e2e-${Date.now()}.json`);
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "doc-e2e-data-"));
const boot = () => spawn(process.execPath, ["--require", path.join(__dirname, "fake-mongo-preload.cjs"), path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmpData, PAYSTACK_SECRET_KEY: "", MONGODB_URI: "mongodb://fake@127.0.0.1:27017/offkay", MONGODB_DB: "offkay", OFFKAY_FAKE_MONGO: "1", OFFKAY_FAKE_MONGO_FILE: fakeFile, OFFKAY_CORE_ADMINS: "da@example.com" },
  stdio: ["ignore", "ignore", "inherit"]
});
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => { if (ok) { passed++; console.log("  ok  ", name); } else { failed++; console.log("  FAIL", name, extra); } };

(async () => {
  let proc = boot();
  const ready = async () => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {} await new Promise(r => setTimeout(r, 150)); } return false; };
  try {
    check("server booted", await ready());
    const su = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Doc Student", email: "da@example.com", password: "doc-pass-1", role: "tenant", university: "University of Lagos" }) });
    const cookie = (su.headers.getSetCookie ? su.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    check("student (seeded core admin) signed up", su.status === 201);
    const submit = await fetch(`${BASE}/api/verification`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ idType: "Student ID", nin: "12345678901", idCardImage: PNG }) });
    check("verification with ID image submitted", submit.status === 201, `status=${submit.status}`);
    const own = await (await fetch(`${BASE}/api/verification`, { headers: { Cookie: cookie } })).json();
    const verificationId = own.verification?.id;
    check("verification id retrievable", Boolean(verificationId));

    // Cold restart: fresh MEDIA_TOKENS, fake Mongo persists.
    proc.kill("SIGKILL");
    await new Promise(r => setTimeout(r, 300));
    proc = boot();
    check("server rebooted", await ready());
    const li = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "da@example.com", password: "doc-pass-1" }) });
    const adminCookie = (li.headers.getSetCookie ? li.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    const doc = await fetch(`${BASE}/api/admin/verification/${verificationId}/document/idCard`, { headers: { "Authorization": "Bearer offkay-admin-dev" } });
    const buf = Buffer.from(await doc.arrayBuffer());
    check("admin document endpoint returns image after restart", doc.status === 200 && doc.headers.get("content-type").startsWith("image/"), `status=${doc.status} type=${doc.headers.get("content-type")}`);
    check("document bytes non-empty", buf.length > 50, `bytes=${buf.length}`);
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(fakeFile, { force: true }); } catch {}
    try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); proc.kill("SIGKILL"); process.exit(1); });
