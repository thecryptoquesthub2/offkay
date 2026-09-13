"use strict";
/* One-shot verification of the user's exact reported scenario:
   student messages a host from TWO DIFFERENT properties -> exactly ONE
   conversation must exist, opener sent once, second message lands in the
   same thread. Also covers the Find-People path and legacy-duplicate heal. */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const PORT = 4621;
const BASE = `http://127.0.0.1:${PORT}`;
let cookies = {};
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; console.log("  FAIL", name, extra); }
};
async function call(as, method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookies[as] ? { Cookie: cookies[as] } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) cookies[as] = setCookies[0].split(";")[0];
  return { status: res.status, payload: await res.json().catch(() => ({})) };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-dedupe-verify-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")],
    { env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
  try {
    for (let i = 0; i < 80; i++) { try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    const host = await call("host", "POST", "/api/auth/signup", { name: "Verify Host", email: `vh${Date.now()}@example.com`, password: "verify-pass-1", role: "landlord", university: "University of Lagos" });
    const student = await call("student", "POST", "/api/auth/signup", { name: "onchaindc", email: `vs${Date.now()}@example.com`, password: "verify-pass-1", role: "tenant", university: "University of Lagos" });
    check("both accounts created", host.status === 201 && student.status === 201);

    const l1 = await call("host", "POST", "/api/listings", { title: "PARADISE", area: "Yaba", university: "University of Lagos", price: 800000, type: "Studio", bedrooms: 1, description: "first" });
    const l2 = await call("host", "POST", "/api/listings", { title: "Palm Court Studio", area: "Yaba", university: "University of Lagos", price: 900000, type: "Studio", bedrooms: 1, description: "second" });
    check("two listings created", l1.status === 201 && l2.status === 201, `${l1.status}/${l2.status}`);

    // Student messages from property 1, then property 2 (the exact bug report).
    const c1 = await call("student", "POST", `/api/listings/${l1.payload.listing.id}/contact`, {});
    const c2 = await call("student", "POST", `/api/listings/${l2.payload.listing.id}/contact`, {});
    check("contact from property 1 returns conversation", c1.status === 200 && c1.payload.conversationId);
    check("contact from property 2 returns the SAME conversation", c2.status === 200 && c2.payload.conversationId === c1.payload.conversationId,
      `p1=${c1.payload.conversationId} p2=${c2.payload.conversationId}`);

    // Repeat clicks must not duplicate anything.
    const c3 = await call("student", "POST", `/api/listings/${l1.payload.listing.id}/contact`, {});
    check("repeat click idempotent", c3.status === 200 && c3.payload.conversationId === c1.payload.conversationId);

    const list = await call("student", "GET", "/api/bootstrap");
    check("student sees exactly ONE conversation", list.payload.conversations?.length === 1, `count=${list.payload.conversations?.length}`);
    const msgs = await call("student", "GET", `/api/conversations/${c1.payload.conversationId}/messages`);
    const openers = msgs.payload.messages.filter(m => m.text?.includes("PARADISE")).length;
    const courts = msgs.payload.messages.filter(m => m.text?.includes("Palm Court Studio")).length;
    check("opener sent exactly once for property 1", openers === 1, `openers=${openers}`);
    check("property 2 message landed in the SAME thread", courts === 1, `palmCourt=${courts}`);

    // Host side sees one conversation too.
    const hostList = await call("host", "GET", "/api/bootstrap");
    check("host sees exactly ONE conversation", hostList.payload.conversations?.length === 1, `count=${hostList.payload.conversations?.length}`);

    // Find-People path must reuse the same pair conversation.
    const start = await call("student", "POST", "/api/conversations/start", { userId: host.payload.user.id });
    check("Find-People start reuses the pair conversation", start.status === 200 && start.payload.conversationId === c1.payload.conversationId,
      `start=${start.payload.conversationId}`);
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); process.exit(1); });
