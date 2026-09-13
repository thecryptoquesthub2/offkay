"use strict";
/* REAL-BROWSER verification (puppeteer) of the Messages requirements:
   1. The page itself does not scroll (window.scrollY stays 0 when the
      message wheel is scrolled).
   2. Scrolling inside #chatMessages moves ONLY that element; header and
      composer stay in the same viewport position.
   3. Composer is visible without page scrolling.
   4. Avatar <img> elements load (naturalWidth > 0) for a user with an
      uploaded avatar, viewed from ANOTHER user's session.
   Runs the real server in file mode with seeded users/listing/conversation. */
const puppeteer = require("puppeteer");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4639;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; console.log("  FAIL", name, extra); }
};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-scroll-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    // Seed: host (with avatar) + listing; student contacts host.
    const signUp = async (email, name, role) => {
      const res = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password: "scroll-pass-1", role, university: "University of Lagos" }) });
      return (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    };
    const hostCookie = await signUp(`sh${Date.now()}@example.com`, "Scroll Host", "landlord");
    await fetch(`${BASE}/api/profile`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: hostCookie }, body: JSON.stringify({ avatar: PNG }) });
    const listingRes = await fetch(`${BASE}/api/listings`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: hostCookie }, body: JSON.stringify({ title: "Scroll Court", area: "Yaba", university: "University of Lagos", price: 700000, type: "Studio", bedrooms: 1, description: "x" }) });
    const listing = (await listingRes.json()).listing;
    const studentCookie = await signUp(`ss${Date.now()}@example.com`, "Scroll Student", "tenant");
    await fetch(`${BASE}/api/listings/${listing.id}/contact`, { method: "POST", headers: { Cookie: studentCookie } });
    // Plenty of messages so the chat really overflows.
    for (let i = 0; i < 30; i++) {
      await fetch(`${BASE}/api/conversations/${(await (await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: studentCookie } })).json()).conversations[0].id}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: studentCookie },
        body: JSON.stringify({ text: `filler message ${i} with some length to wrap the bubble nicely` })
      });
    }

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 800 });
    // Log in with the student session cookie directly in the browser.
    await page.setCookie({ name: "ch_session", value: studentCookie.split("=")[1], url: BASE });

    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => { document.querySelector('[data-tab="messages"]')?.click(); });
    await new Promise(r => setTimeout(r, 700));
    // Open the first conversation.
    await page.evaluate(() => { document.querySelector("[data-action=\"open-conversation\"]")?.click(); });
    await new Promise(r => setTimeout(r, 900));

    const geo1 = await page.evaluate(() => {
      const list = document.querySelector("#chatMessages");
      const head = document.querySelector(".chat-head");
      const composer = document.querySelector(".chat-compose");
      const shell = document.querySelector(".message-shell");
      const rect = el => el ? el.getBoundingClientRect().top : null;
      return {
        pageScrollY: window.scrollY,
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
        hasChat: Boolean(list && head && composer && shell),
        listScrollable: list ? list.scrollHeight > list.clientHeight + 10 : false,
        headTop: rect(head), composerTop: rect(composer), composerBottom: composer ? composer.getBoundingClientRect().bottom : null,
        innerHeight: window.innerHeight,
        composerVisible: composer ? composer.getBoundingClientRect().bottom <= window.innerHeight + 1 && composer.getBoundingClientRect().top >= 0 : false,
        headVisible: head ? head.getBoundingClientRect().top >= 0 && head.getBoundingClientRect().bottom <= window.innerHeight : false
      };
    });
    check("chat rendered with list, header, composer", geo1.hasChat);
    check("page frame is NOT scrollable (contained)", !geo1.pageScrollable, `scrollHeight>innerHeight=${geo1.pageScrollable}`);
    check("message list actually overflows (test data sufficient)", geo1.listScrollable);

    // Scroll inside the message list by 600px.
    await page.evaluate(() => { document.querySelector("#chatMessages").scrollTop += 600; });
    await new Promise(r => setTimeout(r, 250));
    const geo2 = await page.evaluate(() => {
      const list = document.querySelector("#chatMessages");
      const head = document.querySelector(".chat-head");
      const composer = document.querySelector(".chat-compose");
      return {
        windowY: window.scrollY,
        listScrolled: list.scrollTop,
        headTop: head.getBoundingClientRect().top,
        composerBottom: composer.getBoundingClientRect().bottom,
        innerHeight: window.innerHeight
      };
    });
    check("page did NOT scroll when messages scrolled", geo2.windowY === 0, `windowY=${geo2.windowY}`);
    check("message list moved internally", geo2.listScrolled > 500, `scrollTop=${geo2.listScrolled}`);
    check("header stayed pinned (same top)", Math.abs(geo2.headTop - geo1.headTop) < 1, `delta=${Math.abs(geo2.headTop - geo1.headTop)}`);
    check("composer stayed pinned (same bottom)", Math.abs(geo2.composerBottom - geo1.composerBottom) < 1);
    check("composer visible at all times", geo2.composerBottom <= geo2.innerHeight + 1);

    // Avatar renders for the OTHER user (host avatar in the chat header).
    const avatar = await page.evaluate(() => {
      const img = document.querySelector(".chat-head .avatar-img");
      return { present: Boolean(img), src: img?.src || "", loaded: img ? img.complete && img.naturalWidth > 0 : false };
    });
    check("other user's avatar <img> present in chat header", avatar.present);
    check("other user's avatar actually decoded (naturalWidth>0)", avatar.loaded, avatar.src.slice(-30));
    // Conversation list avatars too.
    const listAvatars = await page.evaluate(() => Array.from(document.querySelectorAll(".conversation .avatar-img")).map(img => img.complete && img.naturalWidth > 0));
    check("conversation-list avatars load", listAvatars.length > 0 && listAvatars.every(Boolean), JSON.stringify(listAvatars));

    await page.screenshot({ path: path.join(__dirname, "scroll-verify.png") });
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(__dirname, "scroll-verify.png"), { force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); process.exit(1); });
