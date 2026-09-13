#!/usr/bin/env node
/* Offkay profile + messages regression test (two real accounts).
   Boots a disposable server in a temp data dir, then verifies:
   - signup/profile picture upload + persistence
   - public profile exposes only public info (incl. avatarUrl)
   - Message-from-profile: find-or-create + full payload
   - conversations/connections survive logout + re-login (both sides)
   - image/voice attachments accepted and delivered
   - unread counts + read receipts
   Exit code 1 on any failure. Usage: node scripts/profile-messages-test.js */
"use strict";
const { spawn } = require("node:child_process");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4597;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const fails = [];
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; fails.push(name); console.log("  FAIL", name, extra); }
}
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb: res => {
      for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = line.split(";");
        const idx = pair.indexOf("=");
        if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
      }
    }
  };
}
async function call(j, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(j ? { Cookie: j.header() } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (j) j.absorb(res);
  return { status: res.status, payload: await res.json().catch(() => ({})) };
}
const PIXEL_JPEG = "data:image/jpeg;base64," + Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofGh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscFRUiHhWTS0zL21UXFwcOD09Nzc3Pk1XV2dm5/D09/embeddedstub".replace(/-/g, "A"), "base64"
).toString("base64").slice(0, 400);

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-pmtest-"));
  const server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), OFFKAY_DATA_DIR: tmp },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stderr.on("data", () => {});
  const ready = await new Promise(resolve => {
    const t = setInterval(() => {
      fetch(`${BASE}/api/health`).then(r => r.ok && resolve(true)).catch(() => {});
    }, 150);
    setTimeout(() => { clearInterval(t); resolve(false); }, 8000);
  });
  try {
    check("server boots", ready);

    const ada = jar(), bode = jar();

    // ---- signup both accounts ----
    const a1 = await call(ada, "POST", "/api/auth/signup", { name: "Ada Obi", email: "ada@test.local", password: "password123", role: "tenant", university: "University of Lagos" });
    check("ada signs up", a1.status === 200 || a1.status === 201);
    const b1 = await call(bode, "POST", "/api/auth/signup", { name: "Bode Alamin", email: "bode@test.local", password: "password123", role: "tenant", university: "University of Lagos" });
    check("bode signs up", b1.status === 200 || b1.status === 201);

    // ---- avatar upload + privacy ----
    const up = await call(ada, "PATCH", "/api/profile", { avatar: PIXEL_JPEG });
    // The avatar is stored as bytes and served from /api/media/:token; the
    // response carries the URL ref. Same upload must always hash to the same token.
    check("ada uploads a profile picture", up.status === 200 && up.payload.user && up.payload.user.avatarUrl === `/api/media/${require("node:crypto").createHash("sha1").update(PIXEL_JPEG).digest("hex")}`);
    const bad = await call(ada, "PATCH", "/api/profile", { avatar: "https://evil.example/x.png" });
    check("remote avatar URL is rejected", bad.status === 400);
    const prof1 = await call(ada, "PATCH", "/api/profile", { bio: "Quiet night owl", budget: 500000, habits: ["Quiet home"] });
    check("profile fields still patch", prof1.status === 200 && prof1.payload.user.bio === "Quiet night owl");

    // bode looks ada up: public view
    const users = await call(bode, "GET", "/api/users?q=ada");
    const adaView = (users.payload.people || []).find(p => p.name === "Ada Obi");
    check("bode discovers ada with avatar", Boolean(adaView && adaView.avatarUrl));
    check("public view hides ada email", adaView && adaView.email === undefined);

    // ---- message from profile: /api/conversations/start returns payload ----
    const start = await call(bode, "POST", "/api/conversations/start", { userId: adaView.id });
    check("conversations/start finds or creates", start.status === 200 && typeof start.payload.conversationId === "string");
    check("start reply carries conversation payload with avatar", Boolean(start.payload.conversation && start.payload.conversation.other && start.payload.conversation.other.avatarUrl));

    // ---- send image + voice messages ----
    const img = "data:image/jpeg;base64," + Buffer.alloc(900, 7).toString("base64");
    const m1 = await call(bode, "POST", `/api/conversations/${start.payload.conversationId}/messages`, { text: "", attachments: [{ dataUrl: img, name: "photo.jpg" }] });
    check("image message accepted", m1.status === 201);
    const voice = "data:audio/webm;codecs=opus;base64," + Buffer.alloc(400, 3).toString("base64");
    const m2 = await call(ada, "POST", `/api/conversations/${start.payload.conversationId}/messages`, { text: "Got your photo!", attachments: [{ dataUrl: voice, name: "voice-note", meta: "3s" }] });
    check("voice note message accepted", m2.status === 201);

    // ---- unread counts + read receipts ----
    const bodeList0 = await call(bode, "GET", "/api/bootstrap");
    const bodeConv0 = (bodeList0.payload.conversations || []).find(c => c.id === start.payload.conversationId);
    check("bode sees unread=1 after ada's reply", bodeConv0 && bodeConv0.unread === 1);
    const before = await call(ada, "GET", `/api/conversations/${start.payload.conversationId}/messages`);
    check("ada fetches messages (2 media/text)", before.status === 200 && before.payload.messages.length === 2);
    check("ada's fetch marks conversation read", Boolean(before.payload.conversation && typeof before.payload.conversation.otherReadAt === "string"));
    const list2 = await call(ada, "GET", "/api/bootstrap");
    const conv2 = (list2.payload.conversations || []).find(c => c.id === start.payload.conversationId);
    check("unread drops to 0 after opening", conv2 && conv2.unread === 0);

    // ---- persistence: logout + re-login on both sides ----
    await call(ada, "POST", "/api/auth/logout");
    await call(bode, "POST", "/api/auth/logout");
    const a2 = await call(ada, "POST", "/api/auth/login", { email: "ada@test.local", password: "password123" });
    const b2 = await call(bode, "POST", "/api/auth/login", { email: "bode@test.local", password: "password123" });
    check("both accounts re-login", a2.status === 200 && b2.status === 200);

    const list3 = await call(ada, "GET", "/api/bootstrap");
    const persisted = (list3.payload.conversations || []).find(c => c.id === start.payload.conversationId);
    check("conversation survives logout/login (ada)", Boolean(persisted));
    check("messages survive logout/login (ada)", Boolean(persisted && persisted.lastMessage));
    const usersAfter = await call(ada, "GET", "/api/users?q=bode");
    const bodeView = (usersAfter.payload.people || []).find(p => p.name === "Bode Alamin");
    check("connection state intact after re-login", bodeView && bodeView.connection && bodeView.connection.state === "none");
    const list4 = await call(bode, "GET", "/api/bootstrap");
    check("conversation survives logout/login (bode)", (list4.payload.conversations || []).some(c => c.id === start.payload.conversationId));

    // avatar persisted across sessions (seen from bode's fresh session)
    const avatarAfter = await call(bode, "GET", "/api/users?q=ada");
    const adaAfter = (avatarAfter.payload.people || []).find(p => p.name === "Ada Obi");
    check("avatar persists across logout/login", Boolean(adaAfter && adaAfter.avatarUrl === `/api/media/${require("node:crypto").createHash("sha1").update(PIXEL_JPEG).digest("hex")}`));

    // ---- connection lifecycle: request → accept → persists ----
    const connect = await call(bode, "POST", "/api/connections", { userId: adaView.id });
    check("bode sends connection request", connect.status === 200 || connect.status === 201);
    const inbox = await call(ada, "GET", "/api/connections");
    const incoming = (inbox.payload.connections || []).find(l => l.status === "pending" && l.direction === "incoming");
    check("ada sees the incoming request", Boolean(incoming));
    if (incoming) {
      const accept = await call(ada, "POST", `/api/connections/${incoming.id}/accept`);
      check("ada accepts", accept.status === 200);
      const afterA = await call(ada, "GET", "/api/connections");
      const afterB = await call(bode, "GET", "/api/connections");
      check("accepted connection visible to ada", (afterA.payload.connections || []).some(l => l.status === "accepted"));
      check("accepted connection visible to bode", (afterB.payload.connections || []).some(l => l.status === "accepted"));
      await call(ada, "POST", "/api/auth/logout");
      await call(ada, "POST", "/api/auth/login", { email: "ada@test.local", password: "password123" });
      const afterReauth = await call(ada, "GET", "/api/connections");
      check("accepted connection survives re-login", (afterReauth.payload.connections || []).some(l => l.status === "accepted"));
      const bootAfter = await call(ada, "GET", "/api/bootstrap");
      check("conversation present in fresh bootstrap (ada)", (bootAfter.payload.conversations || []).some(c => c.id === start.payload.conversationId));
    }

    // ---- read receipt reflects on the sender side ----
    const m3 = await call(bode, "POST", `/api/conversations/${start.payload.conversationId}/messages`, { text: "Still there?" });
    check("bode sends another message", m3.status === 201);
    const adaFinal = await call(ada, "GET", "/api/bootstrap");
    const adaConvFinal = (adaFinal.payload.conversations || []).find(c => c.id === start.payload.conversationId);
    check("ada sees unread=1 for bode's latest message", adaConvFinal && adaConvFinal.unread === 1);
  } finally {
    server.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(" | ")); process.exit(1); }
}
main().catch(err => { console.error(err); process.exit(1); });
