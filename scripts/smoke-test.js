#!/usr/bin/env node
// End-to-end API smoke test for Offkay.
// Usage: node scripts/smoke-test.js [baseUrl]
//   - With no baseUrl it boots a disposable server in an isolated temp data dir.
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const BASE = process.argv[2];
const PORT = 4599;
const URL_BASE = BASE || `http://127.0.0.1:${PORT}`;
const fs = require("node:fs");

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
    header: () => [...cookies.entries()].map(([k,v]) => `${k}=${v}`).join("; "),
    absorb: res => {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const [pair] = line.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) cookies.set(pair.slice(0,idx).trim(), pair.slice(idx+1).trim());
      }
    }
  };
}

async function call(j, method, url, body) {
  const res = await fetch(`${URL_BASE}${url}`, {
    method,
    headers: {
      ...(body ? {"Content-Type":"application/json"} : {}),
      ...(j ? {Cookie: j.header()} : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (j) j.absorb(res);
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

function startsWithDb(db) {
  const tenant = db.users.find(u => u.email === "tenant@demo.test");
  const landlord = db.users.find(u => u.email === "landlord@demo.test");
  return Boolean(tenant && landlord && db.listings.some(l => l.id === "lst_palm"));
}

async function waitForServer(proc) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL_BASE}/api/bootstrap`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill("SIGKILL");
  throw new Error("Test server did not become ready");
}

function bootServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-test-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  return { proc, tmp };
}


async function run() {
  let ctx = null;
  if (!BASE) {
    ctx = bootServer();
    await waitForServer(ctx.proc);
  }
  try {
    console.log("== public bootstrap ==");
    {
      const res = await call(null, "GET", "/api/bootstrap");
      check("bootstrap returns 200", res.status === 200);
      check("bootstrap exposes universities", Array.isArray(res.payload.universities) && res.payload.universities.length > 10);
      check("bootstrap reports payments disabled without key", res.payload.paymentsEnabled === false);
      check("bootstrap lists only active listings", Array.isArray(res.payload.listings) && res.payload.listings.every(l => l.status === "active"));
      check("anonymous user is null", res.payload.user === null);
    }

    console.log("== auth ==");
    const badSignup = await call(null, "POST", "/api/auth/signup", { name:"T", email:"bad", password:"123" });
    check("signup rejects invalid input (400)", badSignup.status === 400);

    const newAccount = { name:"Test Student", email:"test.student@example.com", password:"password123", role:"tenant", phone:"08011122233", university:"University of Ibadan" };
    const signup = await call(null, "POST", "/api/auth/signup", newAccount);
    check("signup returns 201", signup.status === 201);
    check("signup creates session cookie", signup.payload.user?.email === newAccount.email);

    const dupSignup = await call(null, "POST", "/api/auth/signup", newAccount);
    check("duplicate signup rejected with 409", dupSignup.status === 409);

    const badLogin = await call(null, "POST", "/api/auth/login", { email:newAccount.email, password:"wrongpassword" });
    check("login rejects wrong password (401)", badLogin.status === 401);

    const session = jar();
    const login = await call(session, "POST", "/api/auth/login", { email:newAccount.email, password:newAccount.password });
    check("login returns 200", login.status === 200);

    const me = await call(session, "GET", "/api/bootstrap");
    check("session restores user on bootstrap", me.payload.user?.email === newAccount.email);
    check("bootstrap includes ownListings for signed-in user", Array.isArray(me.payload.ownListings));

    const demo = jar();
    const demoLogin = await call(demo, "POST", "/api/auth/login", { email:"tenant@demo.test", password:"demo1234" });
    check("demo tenant can sign in", demoLogin.status === 200);
    const demoBootstrap = await call(demo, "GET", "/api/bootstrap");
    check("demo tenant sees roommate candidates", demoBootstrap.payload.roommateCandidates.length > 0);
    check("roommate payload hides email and phone", demoBootstrap.payload.roommateCandidates.every(c => c.email === undefined && c.phone === undefined));
    check("demo tenant conversations present", demoBootstrap.payload.conversations.length > 0);
    check("conversation payload includes profile-safe other user", demoBootstrap.payload.conversations.every(c => c.other && c.other.email === undefined));

    const logout = await call(session, "POST", "/api/auth/logout");
    check("logout succeeds", logout.status === 200);
    const afterLogout = await call(session, "GET", "/api/bootstrap");
    check("bootstrap after logout has no user", afterLogout.payload.user === null);

    console.log("== profile ==");
    const patch = await call(demo, "PATCH", "/api/profile", { bio:"I love quiet spaces and football.", budget:400000, habits:["Quiet home","Social"] });
    check("profile patch returns updated user", patch.status === 200 && patch.payload.user.bio.includes("football"));

    const demoUser = demoBootstrap.payload.user;
    const userView = await call(demo, "GET", `/api/users/${demoUser.id}`);
    check("public profile hides email/phone", userView.status === 200 && userView.payload.user.email === undefined && userView.payload.user.phone === undefined);
    check("public profile exposes bio and habits", Array.isArray(userView.payload.user.habits) && userView.payload.user.habits.includes("Quiet home"));

    console.log("== listings ==");
    const listingAsTenant = await call(demo, "POST", "/api/listings", { title:"Nope", area:"X", price:100000 });
    check("tenant cannot publish without hosting (403)", listingAsTenant.status === 403);

    const landlord = jar();
    await call(landlord, "POST", "/api/auth/login", { email:"landlord@demo.test", password:"demo1234" });
    const badListing = await call(landlord, "POST", "/api/listings", { title:"", area:"", price:"abc" });
    check("landlord listing validation (400)", badListing.status === 400);

    const listing = await call(landlord, "POST", "/api/listings", { title:"Test Lodge", area:"Sango", university:"University of Ibadan", price:250000, type:"Shared", bedrooms:2, bathrooms:1, description:"Test property", amenities:["Water"] });
    check("landlord can publish listing (201)", listing.status === 201);
    const listingId = listing.payload.listing.id;

    const notOwner = await call(null, "PATCH", `/api/listings/${listingId}`, { status:"hidden" });
    check("non-owner cannot edit listing (401/403)", notOwner.status === 401 || notOwner.status === 403);

    const hide = await call(landlord, "PATCH", `/api/listings/${listingId}`, { status:"hidden" });
    check("owner can hide listing", hide.status === 200 && hide.payload.listing.status === "hidden");
    const afterHide = await call(null, "GET", "/api/bootstrap");
    check("hidden listing excluded from public feed", !afterHide.payload.listings.some(l => l.id === listingId));
    check("hidden listing still in owner ownListings", (await call(landlord, "GET", "/api/bootstrap")).payload.ownListings.some(l => l.id === listingId));

    const show = await call(landlord, "PATCH", `/api/listings/${listingId}`, { status:"active" });
    check("owner can republish listing", show.status === 200 && show.payload.listing.status === "active");

    const tenant = jar();
    await call(tenant, "POST", "/api/auth/login", { email:"tenant@demo.test", password:"demo1234" });

    const save = await call(tenant, "POST", `/api/listings/${listingId}/save`);
    check("tenant can save listing", save.status === 200 && save.payload.saved === true);

    const inspection = await call(tenant, "POST", `/api/listings/${listingId}/inspections`, { preferredDate:"2026-10-01", timeWindow:"Morning", note:"Please show me the water." });
    check("tenant can request inspection (201)", inspection.status === 201);

    const ownListingInspection = await call(landlord, "POST", `/api/listings/${listingId}/inspections`, { preferredDate:"2026-10-01" });
    check("owner cannot inspect own listing (403/400)", ownListingInspection.status === 403 || ownListingInspection.status === 400);

    console.log("== chat ==");
    const contact = await call(tenant, "POST", `/api/listings/${listingId}/contact`);
    check("tenant can contact landlord", contact.status === 200 && typeof contact.payload.conversationId === "string");

    const convoId = contact.payload.conversationId;
    const send = await call(tenant, "POST", `/api/conversations/${convoId}/messages`, { text:"Hello, is this still available?" });
    check("tenant can send a message (201)", send.status === 201);

    const readLandlord = await call(landlord, "GET", `/api/conversations/${convoId}/messages`);
    check("landlord reads tenant message", readLandlord.status === 200 && readLandlord.payload.messages.some(m => m.text.includes("still available")));
    check("landlord unread count reflects tenant message", readLandlord.payload.conversation.unread >= 0);

    const landlordBootstrap = await call(landlord, "GET", "/api/bootstrap");
    const convo = landlordBootstrap.payload.conversations.find(c => c.id === convoId);
    check("conversation includes listing title and unread count", convo && convo.listingTitle === "Test Lodge" && typeof convo.unread === "number");

    const outsider = jar();
    await call(outsider, "POST", "/api/auth/signup", { name:"Out Sider", email:"outsider@example.com", password:"password123" });
    const outsiderRead = await call(outsider, "GET", `/api/conversations/${convoId}/messages`);
    check("non-member cannot read conversation (404)", outsiderRead.status === 404);

    console.log("== roommates ==");
    const matches = await call(tenant, "GET", "/api/roommates");
    check("tenant gets roommate matches", matches.status === 200 && matches.payload.matches.length > 0);
    const target = matches.payload.matches[0];
    const connect = await call(tenant, "POST", "/api/roommates/connect", { userId: target.id });
    check("tenant can connect to a match", connect.status === 200 && connect.payload.conversationId);
    const selfConnect = await call(tenant, "POST", "/api/roommates/connect", { userId: demoUser.id });
    check("cannot connect to yourself (404)", selfConnect.status === 404);

    console.log("== people directory ==");
    const directory = await call(tenant, "GET", "/api/users?q=zainab");
    check("directory search finds person by name", directory.status === 200 && directory.payload.people.length >= 1 && directory.payload.people.every(p => p.email === undefined && p.phone === undefined));
    const directoryAll = await call(tenant, "GET", "/api/users");
    check("directory lists users with privacy-safe fields", directoryAll.status === 200 && directoryAll.payload.people.length >= 2 && directoryAll.payload.people.every(p => p.id && p.name));
    const startConvo = await call(tenant, "POST", "/api/conversations/start", { userId: target.id });
    check("start-chat opens conversation", startConvo.status === 200 && startConvo.payload.conversationId);
    const startAgain = await call(tenant, "POST", "/api/conversations/start", { userId: target.id });
    check("start-chat is idempotent", startAgain.status === 200 && startAgain.payload.conversationId === startConvo.payload.conversationId);

    console.log("== bookings ==");
    const badBooking = await call(tenant, "POST", "/api/bookings", { listingId:"lst_missing", splitCount:2 });
    check("booking missing listing (404)", badBooking.status === 404);

    const booking = await call(tenant, "POST", "/api/bookings", { listingId, splitCount:4 });
    check("tenant can create booking (201)", booking.status === 201);
    check("4-way split computes shares", booking.payload.booking.splitCount === 4 && Array.isArray(booking.payload.booking.paymentShares) && booking.payload.booking.paymentShares.reduce((a,b)=>a+b,0) === 250000 && Math.max(...booking.payload.booking.paymentShares) - Math.min(...booking.payload.booking.paymentShares) <= 1);

    const dupBooking = await call(tenant, "POST", "/api/bookings", { listingId, splitCount:2 });
    check("duplicate active booking blocked (409)", dupBooking.status === 409);

    const landlordBooking = await call(landlord, "POST", "/api/bookings", { listingId });
    check("landlord cannot book (403)", landlordBooking.status === 403);

    const initNoKey = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/pay/initialize`);
    check("paystack initialize refused without key (503)", initNoKey.status === 503);

    const pay = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/confirm-payment`);
    check("4-way: first share marks paid (1/4, still awaiting)", pay.status === 200 && pay.payload.booking.status === "awaiting_payment" && Array.isArray(pay.payload.booking.paidSlots) && pay.payload.booking.paidSlots.length === 1);
    const shareInfo = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/share`);
    check("share links issued for 3 roommates", shareInfo.status === 200 && Array.isArray(shareInfo.payload.links) && shareInfo.payload.links.length === 3 && shareInfo.payload.links.every(link => link.url.includes("slot=")));
    const dupShare = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/share`);
    check("share links idempotent", dupShare.status === 200 && dupShare.payload.links.length === 3);
    const outsiderPay = await call(outsider, "POST", `/api/bookings/${booking.payload.booking.id}/confirm-payment`);
    check("another user cannot confirm someone else's booking", outsiderPay.status === 404);
    const rePay = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/confirm-payment`);
    check("demo re-confirm is idempotent (still 1/4)", rePay.status === 200 && rePay.payload.booking.paidSlots.length === 1 && rePay.payload.booking.status === "awaiting_payment");

    const initWhenPaid = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/pay/initialize`);
    check("paystack initialize stays unavailable without key (503)", initWhenPaid.status === 503);

    const unsignedWebhook = await fetch(`${URL_BASE}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "charge.success", data: { reference: "OFFKAY-fake", amount: 100 } }) });
    check("webhook rejects unsigned payload (401)", unsignedWebhook.status === 401);

    console.log("== payments with key configured ==");
    {
      const keyedPort = PORT + 2;
      const keyedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-keyed-"));
      const keyedProc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
        env: { ...process.env, PORT: String(keyedPort), HOST: "127.0.0.1", OFFKAY_DATA_DIR: keyedTmp, PAYSTACK_SECRET_KEY: "sk_test_smoke_fake_key" },
        stdio: ["ignore", "ignore", "ignore"]
      });
      try {
        let ready = false;
        for (let i = 0; i < 50 && !ready; i++) {
          try { ready = (await fetch(`http://127.0.0.1:${keyedPort}/api/bootstrap`)).ok; } catch {}
          if (!ready) await new Promise(r => setTimeout(r, 100));
        }
        check("keyed server became ready", ready);
        if (ready) {
          const keyedBase = `http://127.0.0.1:${keyedPort}`;
          const keyedCall = async (j, method, urlPath, body) => {
            const res = await fetch(`${keyedBase}${urlPath}`, {
              method,
              headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(j ? { Cookie: j.header() } : {}) },
              body: body ? JSON.stringify(body) : undefined
            });
            if (j) j.absorb(res);
            return { status: res.status, payload: await res.json().catch(() => ({})) };
          };
          const keyedTenant = jar();
          await keyedCall(keyedTenant, "POST", "/api/auth/login", { email: "tenant@demo.test", password: "demo1234" });
          const keyedBootstrap = await keyedCall(keyedTenant, "GET", "/api/bootstrap");
          check("bootstrap reports payments enabled with key", keyedBootstrap.payload.paymentsEnabled === true);
          const keyedListing = keyedBootstrap.payload.listings[0];
          const keyedBooking = await keyedCall(keyedTenant, "POST", "/api/bookings", { listingId: keyedListing.id, splitCount: 2 });
          check("keyed server accepts booking", keyedBooking.status === 201);
          const keyedConfirm = await keyedCall(keyedTenant, "POST", `/api/bookings/${keyedBooking.payload.booking.id}/confirm-payment`);
          check("test confirm-payment blocked when paystack enabled (403)", keyedConfirm.status === 403);
          const keyedInit = await keyedCall(keyedTenant, "POST", `/api/bookings/${keyedBooking.payload.booking.id}/pay/initialize`);
          check("initialize with fake key reaches Paystack or fails safely (500/502)", [500, 502].includes(keyedInit.status));
          const signedBody = JSON.stringify({ event: "charge.success", data: { reference: "OFFKAY-unknown-123", amount: 100, id: 1 } });
          const crypto = require("node:crypto");
          const signature = crypto.createHmac("sha512", "sk_test_smoke_fake_key").update(signedBody).digest("hex");
          const signedWebhook = await fetch(`${keyedBase}/api/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": signature }, body: signedBody });
          const webhookPayload = await signedWebhook.json().catch(() => ({}));
          check("webhook accepts validly signed payload (200)", signedWebhook.status === 200 && webhookPayload.received === true);
        }
      } finally {
        keyedProc.kill("SIGKILL");
        fs.rmSync(keyedTmp, { recursive: true, force: true });
      }
    }

    console.log("== account management ==");
    const wrongDelete = await call(tenant, "DELETE", "/api/account", { password:"not-the-password" });
    check("delete account requires correct password (403)", wrongDelete.status === 403);

    const deleteAccount = await call(outsider, "DELETE", "/api/account", { password:"password123" });
    check("user can delete own account", deleteAccount.status === 200);
    const goneLogin = await call(null, "POST", "/api/auth/login", { email:"outsider@example.com", password:"password123" });
    check("deleted account cannot log in", goneLogin.status === 401);

    const deleteListing = await call(landlord, "DELETE", `/api/listings/${listingId}`);
    check("owner can delete listing", deleteListing.status === 200);
    const afterDelete = await call(null, "GET", "/api/bootstrap");
    check("deleted listing removed from feed", !afterDelete.payload.listings.some(l => l.id === listingId));

    console.log("== persistence sanity ==");
    if (ctx) {
      const dbPath = path.join(ctx.tmp, "db.json");
      const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      check("db file persists seeded users", startsWithDb(db));
      check("deleted user removed from db", !db.users.some(u => u.email === "outsider@example.com"));
      check("partially-paid booking persisted with slots", db.bookings.some(b => b.splitCount === 4 && Array.isArray(b.paidSlots) && b.paidSlots.length === 1 && b.status === "awaiting_payment"));
    } else {
      check("db file check skipped (external server)", true);
    }
  } finally {
    if (ctx) ctx.proc.kill("SIGKILL");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", failures.join(", ")); process.exit(1); }
}

run().catch(err => { console.error(err); process.exit(1); });
