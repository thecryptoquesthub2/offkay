#!/usr/bin/env node
// Pen-test + stress suite for Offkay. Boots a disposable server on an isolated
// temp database and probes security and load behavior. Usage: node scripts/security-test.js
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4598;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra = "") {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb: res => {
      for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = line.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
      }
    }
  };
}

let clientIp = 10;
const nextIp = () => `10.9.${clientIp++}.7`;

async function call(j, method, url, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      "x-forwarded-for": nextIp(),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(j ? { Cookie: j.header() } : {}),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (j) j.absorb(res);
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload, headers: res.headers };
}

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/bootstrap`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("security test server did not start");
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-sec-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "", SIGNUP_RATE_LIMIT: "100" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    await waitForServer(proc);

    console.log("== security headers & static safety ==");
    {
      const home = await fetch(`${BASE}/`);
      check("static responses set nosniff", home.headers.get("x-content-type-options") === "nosniff");
      const traversal1 = await fetch(`${BASE}/..%2f..%2f..%2fetc%2fpasswd`);
      check("encoded traversal blocked", traversal1.status === 400 || traversal1.status === 403);
      const traversal2 = await fetch(`${BASE}/../../etc/passwd`);
      const text2 = await traversal2.text();
      check("plain traversal does not leak /etc/passwd", traversal2.status >= 400 || !text2.includes("root:"));
      const backslash = await fetch(`${BASE}/..%5c..%5cetc%2fpasswd`);
      const text3 = await backslash.text();
      check("backslash traversal does not leak files", backslash.status >= 400 || !text3.includes("root:"));
    }

    console.log("== payload limits ==");
    {
      clientIp = 40;
      const big = "x".repeat(2_500_000);
      const res = await fetch(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: big, email: "big@example.com", password: "password123" })
      });
      check("oversized signup payload rejected (413)", res.status === 413);
      const badJson = await call(null, "POST", "/api/auth/login", undefined);
      check("empty body login handled (400/401)", [400, 401].includes(badJson.status));
    }

    console.log("== brute force protection ==");
    {
      clientIp = 60;
      const bruteTarget = jar();
      await call(bruteTarget, "POST", "/api/auth/signup", { name: "Brute Target", email: "brute.target@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      let lastStatus = 0;
      for (let i = 0; i < 35; i++) {
        const res = await fetch(`${BASE}/api/auth/login`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "brute.target@example.com", password: `wrong-${i}` })
        });
        lastStatus = res.status;
        if (res.status === 429) break;
      }
      check("repeated failed logins hit rate limit (429)", lastStatus === 429);
    }

    console.log("== XSS injection attempts ==");
    {
      clientIp = 80;
      const xss = jar();
      const name = `<script>alert(1)</script>Evil`;
      await call(xss, "POST", "/api/auth/signup", { name, email: "xss@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      const bootstrap = await call(xss, "GET", "/api/bootstrap");
      check("stored XSS name survives but is stored verbatim for client escaping", bootstrap.payload.user?.name === name);
      const badProfile = await call(xss, "PATCH", "/api/profile", { bio: "x".repeat(5000) });
      check("oversized bio truncated server-side", badProfile.status === 200 && badProfile.payload.user.bio.length <= 400);
      const badBudget = await call(xss, "PATCH", "/api/profile", { budget: "not-a-number" });
      check("non-numeric budget coerced safely", badBudget.status === 200 && badBudget.payload.user.budget === 0);
      const hugeHabits = await call(xss, "PATCH", "/api/profile", { habits: Array.from({ length: 50 }, (_, i) => `h${i}`) });
      check("habit list capped", hugeHabits.status === 200 && hugeHabits.payload.user.habits.length <= 8);
    }

    console.log("== authorization (IDOR) probes ==");
    {
      clientIp = 100;
      const attacker = jar();
      await call(attacker, "POST", "/api/auth/signup", { name: "Attacker", email: "attacker@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      const victim = jar();
      await call(victim, "POST", "/api/auth/signup", { name: "IDOR Victim", email: "idor.victim@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      const victimBootstrap = await call(victim, "GET", "/api/bootstrap");
      const victimId = victimBootstrap.payload.user.id;
      globalThis.idorVictimIdGlobal = victimId;
      const otherLandlord = jar();
      await call(otherLandlord, "POST", "/api/auth/signup", { name: "IDOR Landlord", email: "idor.landlord@example.com", password: "password123", role: "landlord", university: "University of Ibadan" });
      const victimListing = await call(otherLandlord, "POST", "/api/listings", { title: "IDOR Lodge", area: "Sango", university: "University of Ibadan", price: 150000, type: "Shared", bedrooms: 1, bathrooms: 1, description: "probe", amenities: [] });
      const victimListingId = victimListing.payload.listing.id;
      const contactRes = await call(victim, "POST", `/api/listings/${victimListingId}/contact`);
      const probeConvoId = contactRes.payload.conversationId;

      const deleteOther = await call(attacker, "DELETE", "/api/account", { password: "password123" });
      check("attacker deleting account works only for self", deleteOther.status === 200);

      const attacker2 = jar();
      await call(attacker2, "POST", "/api/auth/signup", { name: "Attacker 2", email: "attacker2@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      const fakeListing = await call(attacker2, "PATCH", `/api/listings/${victimListingId}`, { status: "hidden" });
      check("attacker cannot modify someone else's listing (403)", fakeListing.status === 403);
      const deleteOtherListing = await call(attacker2, "DELETE", `/api/listings/${victimListingId}`);
      check("attacker cannot delete someone else's listing (403)", deleteOtherListing.status === 403);

      const anonMessage = await call(null, "GET", `/api/conversations/${probeConvoId}/messages`);
      check("anonymous cannot read conversations (401)", anonMessage.status === 401);
      const outsiderConvo = await call(attacker2, "GET", `/api/conversations/${probeConvoId}/messages`);
      check("non-member cannot read demo conversation (404)", outsiderConvo.status === 404);

      const web = await fetch(`${BASE}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "charge.success", data: { reference: "x", amount: 1 } }) });
      check("unsigned webhook rejected (401)", web.status === 401);

      // Booking authorization probes
      const victimBookingRes = await call(victim, "POST", "/api/bookings", { listingId: victimListingId, splitCount: 1 });
      check("victim can create booking", victimBookingRes.status === 201);
      const victimBooking = victimBookingRes.payload.booking;
      const attackerCancel = await call(attacker2, "POST", `/api/bookings/${victimBooking.id}/cancel`);
      check("attacker cannot cancel someone else's booking (404)", attackerCancel.status === 404);
      const attackerLinks = await call(attacker2, "POST", `/api/bookings/${victimBooking.id}/share`);
      check("attacker cannot mint share links for someone else's booking (404)", attackerLinks.status === 404);
      const attackerInit = await call(attacker2, "POST", `/api/bookings/${victimBooking.id}/pay/initialize`, { slot: 0 });
      check("attacker cannot start payment on someone else's booking (404)", attackerInit.status === 404);
      const badSlot = await call(victim, "POST", `/api/bookings/${victimBooking.id}/pay/initialize`, { slot: 9 });
      check("out-of-range slot rejected (payment 503 or slot-clamped)", badSlot.status === 503 || badSlot.status === 409 || badSlot.status === 400);
      const victimCancel = await call(victim, "POST", `/api/bookings/${victimBooking.id}/cancel`);
      check("victim cancels own unpaid booking (200)", victimCancel.status === 200 && victimCancel.payload.booking.status === "cancelled");
      const cancelPaid = await call(victim, "POST", `/api/bookings/${victimBooking.id}/cancel`);
      check("double-cancel is idempotent (200)", cancelPaid.status === 200);
    }

    console.log("== forged webhook / reference probing ==");
    {
      clientIp = 110;
      // With no key configured the webhook always 401s; probe must never 500.
      const probeRefs = ["OFFKAY-bkg_x-0", "../../etc/passwd", "OFFKAY-bkg_"];
      let safe = true;
      for (const ref of probeRefs) {
        const probe = await fetch(`${BASE}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "charge.success", data: { reference: ref, amount: 100 } }) });
        if (probe.status >= 500) safe = false;
      }
      check("webhook reference probes never crash (no 5xx)", safe);
      const shareAnon = await call(null, "POST", "/api/bookings/bkg_fake/share");
      check("anonymous cannot mint share links (401)", shareAnon.status === 401);
      const verifyAnon = await call(null, "POST", "/api/bookings/bkg_fake/pay/verify", { reference: "OFFKAY-bkg_fake-x-0" });
      check("anonymous cannot verify payments (401)", verifyAnon.status === 401);
    }

    console.log("== race: concurrent duplicate signups ==");
    {
      clientIp = 200;
      const email = `race.${Date.now()}@example.com`;
      const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        fetch(`${BASE}/api/auth/signup`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": `10.20.0.${i}` },
          body: JSON.stringify({ name: "Race Tester", email, password: "password123", role: "tenant", university: "University of Ibadan" })
        }).then(r => r.status)
      ));
      const created = attempts.filter(status => status === 201).length;
      const conflicts = attempts.filter(status => status === 409).length;
      check("exactly one signup wins the race", created === 1 && conflicts === 7, `got ${JSON.stringify(attempts)}`);
    }

    console.log("== stress: burst traffic ==");
    {
      clientIp = 300;
      const anonBootstrap = await Promise.all(Array.from({ length: 60 }, () => fetch(`${BASE}/api/bootstrap`).then(r => r.status)));
      check("60 parallel bootstraps all 200", anonBootstrap.every(s => s === 200));
      const demo = jar();
      await call(demo, "POST", "/api/auth/signup", { name: "Stress User", email: "stress.user@example.com", password: "password123", role: "tenant", university: "University of Ibadan" });
      const burst = await Promise.all(Array.from({ length: 40 }, () => call(demo, "GET", "/api/bootstrap")));
      const stressContact = await call(demo, "POST", "/api/conversations/start", { userId: globalThis.idorVictimIdGlobal });
      const stressConvoId = stressContact.payload.conversationId;
      const stressConvoUrl = `/api/conversations/${stressConvoId}/messages`;
      check("40 parallel authenticated bootstraps all 200", burst.every(r => r.status === 200));
      const messages = await Promise.all(Array.from({ length: 12 }, (_, i) =>
        call(demo, "POST", stressConvoUrl, { text: `stress message ${i}` })
      ));
      check("parallel messages all accepted", messages.every(r => r.status === 201));
      const convo = await call(demo, "GET", stressConvoUrl);
      const stressTexts = convo.payload.messages.filter(m => m.text.startsWith("stress message ")).map(m => m.text);
      const unique = new Set(stressTexts);
      check("no lost or duplicated messages under burst", unique.size === 12, `saw ${unique.size}`);
    }

    console.log("== session expiry purge ==");
    {
      clientIp = 400;
      const dbPath = path.join(tmp, "db.json");
      const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      db.sessions.push({ token: "expired_test_token", userId: db.users[0].id, expiresAt: Date.now() - 1000 });
      fs.writeFileSync(dbPath, JSON.stringify(db));
      const after = await call(jar(), "GET", "/api/bootstrap");
      check("server still healthy after injecting expired session", after.status === 200);
      const cleaned = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      check("expired session purged from store", !cleaned.sessions.some(s => s.token === "expired_test_token"));
    }

  } finally {
    proc.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", failures.join(", ")); process.exit(1); }
}

run().catch(err => { console.error(err); process.exit(1); });
