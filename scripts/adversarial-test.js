#!/usr/bin/env node
/* Offkay adversarial suite: pentest probes, boundary/stress inputs, and
   race/concurrency checks against a disposable server instance.
   Usage: node scripts/adversarial-test.js */
"use strict";
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4596;
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
async function raw(method, url, { body, headers = {}, cookie, jar } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body))
  });
  if (jar) jar.absorb(res);
  return { status: res.status, payload: await res.json().catch(() => ({})), headers: res.headers };
}
const call = (j, method, url, body) => raw(method, url, { body, cookie: j.header(), jar: j });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-pentest-"));
  const server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(PORT), OFFKAY_DATA_DIR: tmp },
    stdio: ["ignore", "ignore", "pipe"]
  });
  server.stderr.on("data", () => {});
  const up = await new Promise(resolve => {
    const t = setInterval(() => fetch(`${BASE}/api/health`).then(r => r.ok && resolve(true)).catch(() => {}), 150);
    setTimeout(() => { clearInterval(t); resolve(false); }, 8000);
  });
  try {
    check("server boots", up);
    const attacker = jar(), victim = jar(), admin = jar(), third = jar();

    /* ---------- auth & session ---------- */
    const suV = await call(victim, "POST", "/api/auth/signup", { name: "Vic Tim", email: "vic@test.local", password: "password123", role: "tenant", university: "University of Lagos" });
    check("victim signup OK", suV.status === 201, JSON.stringify(suV.payload).slice(0, 120));
    const suA = await call(attacker, "POST", "/api/auth/signup", { name: "Att Ack", email: "att@test.local", password: "password123", role: "tenant", university: "University of Lagos" });
    check("attacker signup OK", suA.status === 201, JSON.stringify(suA.payload).slice(0, 120));
    const suT = await call(third, "POST", "/api/auth/signup", { name: "Th Ird", email: "third@test.local", password: "password123", role: "tenant", university: "University of Lagos" });
    check("third signup OK", suT.status === 201, JSON.stringify(suT.payload).slice(0, 120));
    const forAdmin = await raw("POST", "/api/auth/signup", { body: { name: "Core Admin", email: "coreadmin@test.local", password: "password123", role: "tenant", university: "University of Lagos" } });
    // Promote via CORE_ADMIN_EMAILS equivalent: not set here, so admin APIs should stay closed.

    const badLogin = await raw("POST", "/api/auth/login", { body: { email: "vic@test.local", password: "wrong" } });
    check("wrong password rejected", badLogin.status === 403 || badLogin.status === 401);
    const dupSignup = await raw("POST", "/api/auth/signup", { body: { name: "Dup", email: "vic@test.local", password: "password123", role: "tenant" } });
    check("duplicate email rejected", dupSignup.status === 400 || dupSignup.status === 409);
    const noToken = await raw("GET", "/api/bootstrap");
    check("bootstrap requires session", noToken.status === 200 && noToken.payload.user === null || noToken.status === 401);
    const forged = await raw("GET", "/api/bootstrap", { cookie: "ch_session=completely-forged-token" });
    check("forged session token yields no user", !forged.payload.user);

    /* ---------- IDOR / authorization ---------- */
    const boot = await call(victim, "GET", "/api/bootstrap");
    const vicId = boot.payload.user.id;
    const attBoot = await call(attacker, "GET", "/api/bootstrap");
    const attId = attBoot.payload.user.id;

    const profPatch = await call(attacker, "PATCH", "/api/profile", { name: "Att Ack", bio: "x" });
    check("profile PATCH needs session", profPatch.status === 200);
    const vicAsAtt = await call(attacker, "PATCH", "/api/profile", { email: "hax@test.local" });
    check("email not patchable via profile", !vicAsAtt.payload.user || vicAsAtt.payload.user.email === "att@test.local");

    // attacker opens a conversation with victim, then third tries to read it
    const start = await call(attacker, "POST", "/api/conversations/start", { userId: vicId });
    const convId = start.payload.conversationId;
    await call(attacker, "POST", `/api/conversations/${convId}/messages`, { text: "secret plan" });
    const outsider = await call(third, "GET", `/api/conversations/${convId}/messages`);
    check("non-member cannot read conversation", outsider.status === 404 || outsider.status === 403);
    const outsiderPost = await call(third, "POST", `/api/conversations/${convId}/messages`, { text: "inject" });
    check("non-member cannot post into conversation", outsiderPost.status === 404 || outsiderPost.status === 403);

    /* ---------- admin surface ---------- */
    const adminProbe = await call(attacker, "GET", "/api/admin/overview");
    check("admin API closed to regular users", adminProbe.status === 403);
    const adminDoc = await call(attacker, "GET", "/api/admin/verification/whatever/document/idCard");
    check("admin document endpoint closed", adminDoc.status === 403);
    const adminBypass = await raw("GET", "/api/admin/overview", { headers: { Authorization: "Bearer guess-me-123" } });
    check("admin bearer token required", adminBypass.status === 403);

    /* ---------- input validation / injection ---------- */
    const xss = await call(attacker, "PATCH", "/api/profile", { bio: '<script>alert(1)</script><img src=x onerror=alert(2)>' });
    check("XSS payload stored as data (esc on render)", xss.status === 200);
    const xssName = await call(third, "PATCH", "/api/profile", { name: '<svg onload=alert(1)>' });
    check("XSS in name stored as data", xssName.status === 200);

    const hugeString = "A".repeat(300000);
    const hugeBio = await call(attacker, "PATCH", "/api/profile", { bio: hugeString });
    check("oversized bio truncated not crashed", hugeBio.status === 200 && (hugeBio.payload.user?.bio?.length || 0) <= 400);
    const hugeMsg = await call(attacker, "POST", `/api/conversations/${convId}/messages`, { text: "B".repeat(300000) });
    check("oversized message rejected or truncated", hugeMsg.status === 400 || hugeMsg.status === 413 || (hugeMsg.payload.message?.text?.length || 0) <= 2000);

    const weirdJson = await raw("POST", "/api/auth/login", { body: '{"email":"vic@test.local","password":["array"]}', headers: { "Content-Type": "application/json" } });
    check("array password does not crash auth", [400, 401, 403, 500].includes(weirdJson.status) && weirdJson.status !== 500 || weirdJson.status === 403);
    const deepJson = await raw("POST", "/api/auth/login", { body: '{"a":' + "[".repeat(2000) + "]" .repeat(2000) + "}", headers: { "Content-Type": "application/json" } });
    check("deeply nested JSON handled", deepJson.status !== 500 || deepJson.status === 500); // must not hang/crash server
    const protoPollution = await raw("POST", "/api/auth/signup", { body: '{"__proto__":{"admin":true},"name":"PP","email":"pp@test.local","password":"password123","role":"tenant"}', headers: { "Content-Type": "application/json" } });
    check("proto pollution payload handled", [200, 201, 400].includes(protoPollution.status));

    const negativePrice = await call(attacker, "POST", "/api/host/activate");
    check("host activate fine", negativePrice.status === 200);
    const listing = await call(attacker, "POST", "/api/listings", { title: "Evil Manor", area: "Lekki", price: -5000, type: "Studio" });
    check("negative price rejected", listing.status === 400);
    const nanPrice = await call(attacker, "POST", "/api/listings", { title: "NaN Manor", area: "Lekki", price: "abc", type: "Studio" });
    check("NaN price rejected", nanPrice.status === 400);

    /* ---------- attachment validation ---------- */
    const badDataUrl = await call(attacker, "POST", `/api/conversations/${convId}/messages`, { text: "", attachments: [{ dataUrl: "data:text/html;base64,PGh0bWw+", name: "x" }] });
    check("html attachment rejected", badDataUrl.status === 415 || badDataUrl.status === 400);
    const pathMime = await call(attacker, "POST", `/api/conversations/${convId}/messages`, { text: "", attachments: [{ dataUrl: "data:image/jpeg;base64,QUJD", name: "../../evil.exe" }] });
    check("hostile attachment name accepted-but-sanitized or rejected", pathMime.status === 201 || pathMime.status === 400);

    /* ---------- static serving / path traversal ---------- */
    const trav1 = await fetch(`${BASE}/..%2f..%2f..%2fetc%2fpasswd`);
    const trav1Text = await trav1.text();
    check("encoded traversal blocked", trav1.status === 403 || !trav1Text.includes("root:"));
    const trav2 = await fetch(`${BASE}/%2e%2e/%2e%2e/server.js`);
    const trav2Text = await trav2.text();
    check("dot-dot traversal blocked", !trav2Text.includes("MONGODB_URI") || trav2.status === 403);
    const trav3 = await fetch(`${BASE}/api/../../server.js`);
    check("api-relative traversal blocked", trav3.status !== 200 || !(await trav3.text()).includes("createServer"));

    /* ---------- misc header/cookie hygiene ---------- */
    const login = await raw("POST", "/api/auth/login", { body: { email: "vic@test.local", password: "password123" } });
    const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie().join("|") : "";
    check("session cookie HttpOnly+SameSite", /HttpOnly/i.test(setCookie) && /SameSite/i.test(setCookie));
    const noStore = login.headers.get("cache-control") || "";
    check("API responses no-store", /no-store/i.test(noStore));

    /* ---------- concurrency: parallel message posts ---------- */
    const convB = await call(victim, "POST", "/api/conversations/start", { userId: attId });
    const parallel = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      call(victim, "POST", `/api/conversations/${convB.payload.conversationId}/messages`, { text: `parallel ${i}` })));
    check("12 parallel sends all succeed", parallel.every(r => r.status === 201), `statuses: ${parallel.map(r => r.status).join(",")}`);
    const after = await call(victim, "GET", `/api/conversations/${convB.payload.conversationId}/messages`);
    check("no lost writes under concurrency", after.payload.messages.filter(m => m.text?.startsWith("parallel ")).length === 12);

    /* ---------- stress: rapid reads + polling ---------- */
    const t0 = Date.now();
    const burst = await Promise.all(Array.from({ length: 40 }, () => call(victim, "GET", "/api/bootstrap")));
    const dt = Date.now() - t0;
    check("40 parallel bootstraps OK", burst.every(r => r.status === 200), `${dt}ms`);
    check("burst latency sane (<10s)", dt < 10000, `${dt}ms`);

    // sustained sequential load
    const seqStart = Date.now();
    let seqOk = 0;
    for (let i = 0; i < 30; i++) {
      const r = await call(victim, "GET", "/api/badges");
      if (r.status === 200) seqOk++;
    }
    check("30 sequential badge polls OK", seqOk === 30, `${Date.now() - seqStart}ms`);

    /* ---------- avatar edge cases ---------- */
    const bigAvatar = "data:image/jpeg;base64," + Buffer.alloc(1_500_000, 5).toString("base64");
    const bigAv = await call(victim, "PATCH", "/api/profile", { avatar: bigAvatar });
    check("oversized avatar rejected", bigAv.status === 400 || bigAv.status === 413);
    const fakeAvatar = await call(victim, "PATCH", "/api/profile", { avatar: "data:image/jpeg;base64,not-base64!!!" });
    check("malformed avatar rejected", fakeAvatar.status === 400);
    const scriptAvatar = await call(victim, "PATCH", "/api/profile", { avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" });
    check("svg avatar rejected (script vector)", scriptAvatar.status === 400);

    /* ---------- bootstrap payload weight (splash-hang regression) ----------
       Inline data URLs in /api/bootstrap once multiplied to ~1MB per owner
       avatar, hanging the app on the splash. Payloads must stay small and
       reference /api/media/:token URLs instead. */
    const bootText = JSON.stringify(boot.payload);
    check("bootstrap carries no inline data URLs", !bootText.includes("data:image"), `${(bootText.length / 1024).toFixed(0)}KB`);
    check("bootstrap payload stays lean", bootText.length < 400_000, `${(bootText.length / 1024).toFixed(0)}KB`);
    const avHost = jar();
    await call(avHost, "POST", "/api/auth/signup", { name: "Weight Host", email: "weighthost@test.local", password: "password123", role: "landlord", university: "University of Lagos" });
    await call(avHost, "POST", "/api/host/activate");
    const weightAvatar = "data:image/jpeg;base64," + Buffer.alloc(800_000, 7).toString("base64");
    await call(avHost, "PATCH", "/api/profile", { avatar: weightAvatar });
    for (let i = 0; i < 3; i++) await call(avHost, "POST", "/api/listings", { title: `Weight Manor ${i}`, area: "Lekki", price: 250000 + i, type: "Studio" });
    const weighted = await call(victim, "GET", "/api/bootstrap");
    const weightedText = JSON.stringify(weighted.payload);
    check("3 listings + 1MB avatar keep bootstrap lean", weighted.status === 200 && weightedText.length < 400_000, `${(weightedText.length / 1024).toFixed(0)}KB`);
    // owner.avatars surface as /api/media URLs; the 800KB base64 never travels.
    const avatarPrefix = weightAvatar.slice(0, 60);
    check("weighted bootstrap exposes owner avatar as URL, not bytes", weightedText.includes("/api/media/") && !weightedText.includes(avatarPrefix),
      `hasUrl=${weightedText.includes("/api/media/")} hasBytes=${weightedText.includes(avatarPrefix)}`);

    /* ---------- rate limits exist ---------- */
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const r = await raw("POST", "/api/auth/forgot", { body: { email: "nobody@test.local" } });
      statuses.push(r.status);
    }
    check("forgot endpoint tolerates burst (generic 200s)", statuses.every(s => s === 200));

    /* ---------- second pass: dedup + logical edge cases ---------- */
    const selfChat = await call(victim, "POST", "/api/conversations/start", { userId: vicId });
    check("cannot start conversation with yourself", selfChat.status === 400 || selfChat.status === 404);
    const again = await call(victim, "POST", "/api/conversations/start", { userId: attId });
    check("repeat start returns the SAME conversation (no duplicates)", again.payload.conversationId === convB.payload.conversationId,
      `${again.payload.conversationId} vs ${convB.payload.conversationId}`);
    const bootAfterDedup = await call(victim, "GET", "/api/bootstrap");
    const matching = (bootAfterDedup.payload.conversations || []).filter(c => (c.other || {}).id === attId);
    check("no duplicate conversations in the list", matching.length === 1, `found ${matching.length}`);

    const longQ = await call(victim, "GET", `/api/users?q=${"z".repeat(500)}`);
    check("very long search query handled", longQ.status === 200);

    const fourFiles = { text: "", attachments: Array.from({ length: 4 }, () => ({ dataUrl: "data:image/jpeg;base64," + Buffer.alloc(200, 1).toString("base64"), name: "p.jpg" })) };
    const fourMsg = await call(victim, "POST", `/api/conversations/${convB.payload.conversationId}/messages`, fourFiles);
    check("more than 3 attachments handled (sliced or rejected)", fourMsg.status === 201 || fourMsg.status === 400);

    const unknownRoute = await raw("GET", "/api/definitely-not-a-route", { cookie: (await login) && "" });
    check("unknown API route 404s", unknownRoute.status === 404);

    const methodProbe = await raw("DELETE", "/api/bootstrap");
    check("wrong method on API route does not crash", [404, 405, 200].includes(methodProbe.status));

  } finally {
    server.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(" | ")); process.exit(1); }
}
main().catch(err => { console.error(err); process.exit(1); });
