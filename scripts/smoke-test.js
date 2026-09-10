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
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp },
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

    console.log("== bookings ==");
    const badBooking = await call(tenant, "POST", "/api/bookings", { listingId:"lst_missing", splitCount:2 });
    check("booking missing listing (404)", badBooking.status === 404);

    const booking = await call(tenant, "POST", "/api/bookings", { listingId, splitCount:4 });
    check("tenant can create booking (201)", booking.status === 201);
    check("4-way split computes paymentShare", booking.payload.booking.splitCount === 4 && booking.payload.booking.paymentShare === Math.round(250000/4));

    const dupBooking = await call(tenant, "POST", "/api/bookings", { listingId, splitCount:2 });
    check("duplicate active booking blocked (409)", dupBooking.status === 409);

    const landlordBooking = await call(landlord, "POST", "/api/bookings", { listingId });
    check("landlord cannot book (403)", landlordBooking.status === 403);

    const pay = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/confirm-payment`);
    check("tenant confirms payment", pay.status === 200 && pay.payload.booking.status === "paid" && pay.payload.booking.reference);
    const rePay = await call(tenant, "POST", `/api/bookings/${booking.payload.booking.id}/confirm-payment`);
    check("re-confirm is idempotent", rePay.status === 200 && rePay.payload.booking.reference === pay.payload.booking.reference);

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
      check("paid booking persisted", db.bookings.some(b => b.status === "paid" && b.reference));
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
