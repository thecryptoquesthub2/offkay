"use strict";
/* REAL-BROWSER verification of the reported mobile overlap:
   1. Messages list state (no chat open): ONLY the conversation sidebar is
      visible - no chat panel, no empty-state panel, no overlap.
   2. Chat-open state: ONLY the chat is visible; the conversation list and
      people directory are hidden, and NOTHING overlaps the chat header.
   3. Avatars (other users' pfps) load as real images in both states. */
const puppeteer = require("puppeteer");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4645;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; console.log("  FAIL", name, extra); }
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-overlap-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    // Seed: host with avatar + listing; student contacts host; messages fill thread.
    const signUp = async (email, name, role) => {
      const res = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password: "overlap-pass-1", role, university: "University of Lagos" }) });
      return (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    };
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const hostCookie = await signUp(`oh${Date.now()}@example.com`, "Amara Obi", "landlord");
    await fetch(`${BASE}/api/profile`, { method: "PATCH", headers: { "Content-Type": "application/json", Cookie: hostCookie }, body: JSON.stringify({ avatar: PNG }) });
    const listing = (await (await fetch(`${BASE}/api/listings`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: hostCookie }, body: JSON.stringify({ title: "Overlap Court", area: "Yaba", university: "University of Lagos", price: 700000, type: "Studio", bedrooms: 1, description: "x" }) })).json()).listing;
    const studentCookie = await signUp(`os${Date.now()}@example.com`, "Overlap Student", "tenant");
    await fetch(`${BASE}/api/listings/${listing.id}/contact`, { method: "POST", headers: { Cookie: studentCookie } });
    for (let i = 0; i < 12; i++) {
      const boot = await (await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: studentCookie } })).json();
      await fetch(`${BASE}/api/conversations/${boot.conversations[0].id}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: studentCookie }, body: JSON.stringify({ text: `hello ${i} with wrapping text` }) });
    }

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true });
    await page.setCookie({ name: "ch_session", value: studentCookie.split("=")[1], url: BASE });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.querySelector('[data-tab="messages"]')?.click());
    await new Promise(r => setTimeout(r, 600));

    const overlapProbe = () => page.evaluate(() => {
      const q = s => document.querySelector(s);
      const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0; };
      const list = q(".conversation-list");
      const chat = q(".chat");
      const noChat = q(".message-shell .no-chat");
      const shell = q(".message-shell");
      const head = q(".chat-head");
      const rows = q("#conversationRows");
      // Rect-overlap between visible panels (allow 2px rounding).
      const rectsOverlap = (a, b) => { if (!a || !b) return false; const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left); const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top); return x > 2 && y > 2; };
      return {
        shellRect: shell ? { w: shell.getBoundingClientRect().width, h: shell.getBoundingClientRect().height } : null,
        listVisible: visible(list),
        chatVisible: visible(chat),
        noChatVisible: visible(noChat),
        headVisible: visible(head),
        rowsVisible: visible(rows),
        listChatOverlap: rectsOverlap(list, chat),
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
        listAvatars: Array.from(document.querySelectorAll(".conversation-list .avatar-img")).map(img => img.complete && img.naturalWidth > 0),
        chatAvatar: (() => { const img = q(".chat-head .avatar-img"); return img ? img.complete && img.naturalWidth > 0 : null; })()
      };
    });

    // STATE 1: list only (no conversation open).
    const s1 = await overlapProbe();
    check("list state: sidebar visible", s1.listVisible);
    check("list state: chat panel hidden", !s1.chatVisible);
    check("list state: desktop empty-state hidden on mobile", !s1.noChatVisible);
    check("list state: no page scroll (contained)", !s1.pageScrollable);

    // STATE 2: open the conversation.
    await page.evaluate(() => document.querySelector('[data-action="open-conversation"]')?.click());
    await new Promise(r => setTimeout(r, 900));
    const s2 = await overlapProbe();
    check("chat state: chat visible", s2.chatVisible);
    check("chat state: conversation list hidden", !s2.listVisible);
    check("chat state: header present", s2.headVisible);
    check("chat state: no list/chat overlap", !s2.listChatOverlap);
    check("chat state: page still contained", !s2.pageScrollable);
    check("chat state: other user's avatar decodes", s2.chatAvatar === true, String(s2.chatAvatar));
    check("list state: other user's avatar decoded", s1.listAvatars.length > 0 && s1.listAvatars.every(Boolean), JSON.stringify(s1.listAvatars));

    // STATE 3: back to list.
    await page.evaluate(() => document.querySelector('[data-action="back-to-conversations"]')?.click());
    await new Promise(r => setTimeout(r, 500));
    const s3 = await overlapProbe();
    check("back state: list restored", s3.listVisible && !s3.chatVisible);

    // Desktop sanity: both panels side by side, no overlap. NOTE: dropping
    // isMobile in setViewport reloads the page (SPA state resets), so re-enter
    // the Messages tab first - exactly what a user does after any reload.
    await page.setViewport({ width: 1366, height: 800 });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.querySelector('[data-tab="messages"]')?.click());
    await new Promise(r => setTimeout(r, 600));
    const d = await overlapProbe();
    check("desktop: list visible", d.listVisible);
    check("desktop: no list/chat rect overlap", !d.listChatOverlap);
    check("desktop: page contained", !d.pageScrollable);
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); process.exit(1); });
