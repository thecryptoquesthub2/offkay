"use strict";
/* Production-equivalent flow timings against a simulated remote cluster
   (fake Mongo driver + per-op latency). Measures the exact flows the
   performance report requires: BOOTSTRAP, MESSAGE PROPERTY, OPEN CHAT,
   SEND MESSAGE, SAVE PROPERTY, plus a mixed concurrency check.
   Usage: OFFKAY_FAKE_MONGO_DELAY_MS=40 node scripts/flow-timings.cjs
   Reports queueWait (Server-Timing) + total per request. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4635;
const BASE = `http://127.0.0.1:${PORT}`;
const DELAY = Number(process.env.OFFKAY_FAKE_MONGO_DELAY_MS || 40);
const cookies = { anon: "", host: "", student: "" };
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
};
async function call(as, method, url, body) {
  const t0 = Date.now();
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookies[as] ? { Cookie: cookies[as] } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookies[as] = sc[0].split(";")[0];
  const payload = await res.json().catch(() => ({}));
  return {
    status: res.status, payload,
    total: Date.now() - t0,
    timing: res.headers.get("server-timing") || ""
  };
}
const fmt = r => `total=${r.total}ms [${r.timing}]`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-flow-"));
  const proc = spawn(process.execPath, [
    "--require", path.join(__dirname, "fake-mongo-preload.cjs"),
    path.join(__dirname, "..", "server.js")
  ], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "", MONGODB_URI: "mongodb://fake@127.0.0.1:27017/offkay", MONGODB_DB: "offkay", OFFKAY_FAKE_MONGO: "1", OFFKAY_FAKE_MONGO_DELAY_MS: String(DELAY), OFFKAY_FAKE_MONGO_FILE: path.join(tmp, "fake.json") },
    stdio: ["ignore", "ignore", "inherit"]
  });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }

    console.log(`== simulated cluster latency: ${DELAY}ms per mongo op ==`);
    await call("host", "POST", "/api/auth/signup", { name: "Flow Host", email: `fh${Date.now()}@example.com`, password: "flow-pass-1", role: "landlord", university: "University of Lagos" });
    await call("student", "POST", "/api/auth/signup", { name: "onchaindc", email: `fs${Date.now()}@example.com`, password: "flow-pass-1", role: "tenant", university: "University of Lagos" });

    const cold = await call("anon", "GET", "/api/bootstrap");
    console.log("BOOTSTRAP (snapshot present, anonymous):", fmt(cold), `status=${cold.status}`);
    const warm = await call("student", "GET", "/api/bootstrap");
    console.log("BOOTSTRAP (warm snapshot, signed in):", fmt(warm), `status=${warm.status}`);
    check("warm bootstrap is fast (<600ms at 40ms/op)", warm.total < 600, fmt(warm));

    const listing = await call("host", "POST", "/api/listings", { title: "PARADISE", area: "Yaba", university: "University of Lagos", price: 800000, type: "Studio", bedrooms: 1, description: "flow" });
    check("host published listing", listing.status === 201, `status=${listing.status} ${JSON.stringify(listing.payload).slice(0, 120)}`);

    // MESSAGE PROPERTY flow (student side).
    const contact = await call("student", "POST", `/api/listings/${listing.payload.listing.id}/contact`, {});
    console.log("MESSAGE PROPERTY (find/create convo + opener + persist):", fmt(contact));
    check("contact returns conversation", contact.status === 200 && contact.payload.conversationId, fmt(contact));
    check("message-property completes < 2.5s at 40ms/op", contact.total < 2500, fmt(contact));

    // OPEN CHAT + SEND MESSAGE.
    const convoId = contact.payload.conversationId;
    const open = await call("student", "GET", `/api/conversations/${convoId}/messages`);
    console.log("OPEN CHAT (messages + read receipt):", fmt(open));
    check("open chat fast (<600ms)", open.total < 600, fmt(open));
    const send = await call("student", "POST", `/api/conversations/${convoId}/messages`, { text: "Is it still available?" });
    console.log("SEND MESSAGE (write + persist):", fmt(send));
    check("send message written", [200, 201].includes(send.status), `status=${send.status}`);
    check("send message completes < 2.5s", send.total < 2500, fmt(send));

    // SAVE PROPERTY (toggle endpoint).
    const save = await call("student", "POST", `/api/listings/${listing.payload.listing.id}/save`);
    console.log("SAVE PROPERTY:", fmt(save), `status=${save.status}`);
    check("save property completes < 2.5s", save.total < 2500, fmt(save));

    // Mixed concurrency: 6 reads in flight must NOT serialize behind each other.
    const reads = await Promise.all(Array.from({ length: 6 }, () => call("student", "GET", "/api/bootstrap")));
    const slowest = Math.max(...reads.map(r => r.total));
    const sum = reads.reduce((n, r) => n + r.total, 0);
    console.log(`CONCURRENT READS x6: slowest=${slowest}ms sum=${sum}ms (if serialized, slowest ~ sum)`);
    check("reads run concurrently (slowest << sum)", slowest < sum * 0.6, `slowest=${slowest} sum=${sum}`);
    check("all concurrent reads succeeded", reads.every(r => r.status === 200));

    // Deep health: observability payloads.
    const deep = await call("anon", "GET", "/api/health?deep=1");
    console.log("HEALTH deep:", JSON.stringify(deep.payload.queue || {}), JSON.stringify(deep.payload.db || {}));
    check("deep health exposes queue + db stats", Boolean(deep.payload.queue && deep.payload.db));
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); process.exit(1); });
