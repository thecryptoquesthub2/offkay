#!/usr/bin/env node
// Integration tests for Offkay's social layer (notifications, connections, badges).
// Boots a disposable server in an isolated temp data dir, runs real HTTP flows.
"use strict";

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4601;
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
    header: () => [...cookies.entries()].map(([k,v]) => `${k}=${v}`).join("; "),
    absorb: res => {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
    }
  };
}

async function call(session, method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { cookie: session.header() } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (session) session.absorb(res);
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-social-"));
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  child.stdout.on("data", d => { serverLog += d; });
  child.stderr.on("data", d => { serverLog += d; });

  try {
    check("server boots for social tests", await waitReady());

    // Three real accounts with different overlap profiles
    const a = jar(), b = jar(), c = jar();
    const suffix = Date.now();
    const signupA = await call(a, "POST", "/api/auth/signup", { name: "Ada Test", email: `ada${suffix}@t.test`, password: "password123", role: "tenant", university: "University of Lagos" });
    const signupB = await call(b, "POST", "/api/auth/signup", { name: "Bode Test", email: `bode${suffix}@t.test`, password: "password123", role: "tenant", university: "University of Lagos" });
    const signupC = await call(c, "POST", " /api/auth/signup".trim(), { name: "Cee Test", email: `cee${suffix}@t.test`, password: "password123", role: "tenant", university: "University of Ibadan" });
    check("three accounts created", signupA.status === 201 && signupB.status === 201 && signupC.status === 201);
    await call(a, "PATCH", "/api/profile", { bio: "Testing bio", budget: 400000, habits: ["Very tidy", "Night owl"] });
    await call(b, "PATCH", "/api/profile", { bio: "Bode bio", budget: 420000, habits: ["Very tidy", "Night owl"] });

    const idA = signupA.payload.user.id;
    const idB = signupB.payload.user.id;

    // --- Discover: real directory with prioritization ---
    const dirB = await call(b, "GET", "/api/users");
    check("directory excludes self and includes real users", dirB.payload.people.length >= 2 && dirB.payload.people.every(p => p.id !== idB));
    const adaInDir = dirB.payload.people.find(p => p.id === idA);
    const ceeInDir = dirB.payload.people.find(p => p.id === signupC.payload.user.id);
    check("same-university user outranks other-university user (prioritization)", adaInDir && ceeInDir && adaInDir.score > ceeInDir.score, `ada=${adaInDir?.score} cee=${ceeInDir?.score}`);
    check("directory exposes connection state", adaInDir && adaInDir.connection?.state === "none");

    // --- Connection lifecycle: none -> outgoing -> notification -> incoming -> accepted ---
    const send = await call(a, "POST", "/api/connections", { userId: idB });
    check("connection request created", send.status === 201 && send.payload.state === "outgoing");

    const dup = await call(a, "POST", "/api/connections", { userId: idB });
    check("duplicate request is idempotent (no second row)", dup.status === 200 && dup.payload.state === "outgoing");

    const bBootstrap = await call(b, "GET", "/api/bootstrap");
    check("B got a real notification for the request", bBootstrap.payload.notifications.some(n => n.type === "connection" && n.actor?.id === idA));
    check("B notification unread count > 0", bBootstrap.payload.notificationsUnread > 0);
    const bBadges1 = await call(b, "GET", "/api/badges");
    check("badge endpoint counts the unread notification", bBadges1.payload.notifications >= 1);

    const incomingForB = await call(b, "GET", "/api/users");
    const adaForB = incomingForB.payload.people.find(p => p.id === idA);
    check("B sees incoming state on A's card", adaForB?.connection?.state === "incoming");

    const accept = await call(b, "POST", `/api/connections/${send.payload.connection.id}/accept`, {});
    check("accept succeeds", accept.status === 200 && accept.payload.state === "connected");

    const aNotifs = await call(a, "GET", "/api/notifications");
    check("A notified that B accepted", aNotifs.payload.notifications.some(n => n.type === "connection_accepted" && n.actor?.id === idB));

    const aBootstrap = await call(a, "GET", "/api/bootstrap");
    const bodeForA = aBootstrap.payload.people.find(p => p.id === idB);
    check("A now sees Connected state", bodeForA?.connection?.state === "connected");

    // --- Message notification + unread badge + read-state ---
    const start = await call(a, "POST", "/api/conversations/start", { userId: idB });
    check("conversation started", start.status === 200);
    const sent = await call(a, "POST", `/api/conversations/${start.payload.conversationId}/messages`, { text: "Hi Bode, saw your profile!" });
    check("message delivered", sent.status === 201);

    const badges = await call(b, "GET", "/api/badges");
    check("B's unread message badge is exactly 1", badges.payload.messages === 1, `got ${badges.payload.messages}`);

    await call(b, "GET", `/api/conversations/${start.payload.conversationId}/messages`);
    const badgesAfterRead = await call(b, "GET", "/api/badges");
    check("opening the thread clears the unread badge", badgesAfterRead.payload.messages === 0);

    const bNotifs = await call(b, "GET", "/api/notifications");
    const msgNotif = bNotifs.payload.notifications.find(n => n.type === "message");
    check("B has a real message notification", Boolean(msgNotif));

    // --- Notification read state ---
    const read = await call(b, "POST", "/api/notifications/read", { ids: bNotifs.payload.notifications.filter(n => !n.read).map(n => n.id) });
    check("mark-read works", read.status === 200 && read.payload.unread === 0);
    const badgesAfterNotifRead = await call(b, "GET", "/api/badges");
    check("badge drops after notifications are read", badgesAfterNotifRead.payload.notifications === 0);

    // --- Opt-out of message notifications ---
    await call(b, "PATCH", "/api/profile", { notifyMessages: false });
    await call(a, "POST", `/api/conversations/${start.payload.conversationId}/messages`, { text: "Another one" });
    const bNotifsAfterOptOut = await call(b, "GET", "/api/notifications");
    const newest = bNotifsAfterOptOut.payload.notifications[0];
    check("opted-out user gets no new message notification", newest?.type !== "message" || newest.body !== "Another one");

    // --- Privacy: public profile leaks nothing sensitive ---
    const publicB = await call(a, "GET", `/api/users/${idB}`);
    check("public profile hides email/phone/password", publicB.payload.user && publicB.payload.user.email === undefined && publicB.payload.user.phone === undefined && publicB.payload.user.password === undefined);

    // --- Password change ---
    const badChange = await call(b, "POST", "/api/account/password", { currentPassword: "wrong", newPassword: "newpassword1" });
    check("password change rejects wrong current password", badChange.status === 403);
    const goodChange = await call(b, "POST", "/api/account/password", { currentPassword: "password123", newPassword: "newpassword1" });
    check("password change succeeds", goodChange.status === 200);
    const relogin = await call(jar(), "POST", "/api/auth/login", { email: `bode${suffix}@t.test`, password: "newpassword1" });
    check("login works with the new password", relogin.status === 200);

    // --- Decline/cancel ---
    const send2 = await call(c, "POST", "/api/connections", { userId: idA });
    check("third user can request connection", send2.status === 201);
    const decline = await call(a, "POST", `/api/connections/${send2.payload.connection.id}/decline`, {});
    check("decline removes the link", decline.status === 200);
    const afterDecline = await call(a, "GET", "/api/users");
    check("state returns to none after decline", afterDecline.payload.people.find(p => p.id === signupC.payload.user.id)?.connection?.state === "none");

    // --- Self-connection guard ---
    const self = await call(a, "POST", "/api/connections", { userId: idA });
    check("cannot connect to yourself", self.status === 400);

  } finally {
    child.kill("SIGKILL");
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    if (failed) console.log(`\nServer log tail:\n${serverLog.slice(-800)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
