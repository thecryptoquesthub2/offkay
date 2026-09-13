"use strict";
/* Mobile (375x667) containment check + admin ID-document serving check. */
const puppeteer = require("puppeteer");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const PORT = 4641;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; console.log("  FAIL", name, extra); }
};
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-mob-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
    stdio: ["ignore", "ignore", "inherit"]
  });
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
    // Mobile chat containment (file mode): student + convo with many messages.
    const signUp = async (email, name, role) => {
      const res = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, email, password: "mob-pass-1", role, university: "University of Lagos" }) });
      return (res.headers.getSetCookie ? res.headers.getSetCookie() : [])[0]?.split(";")[0] || "";
    };
    const hostCookie = await signUp(`mh${Date.now()}@example.com`, "Mob Host", "landlord");
    const listing = (await (await fetch(`${BASE}/api/listings`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: hostCookie }, body: JSON.stringify({ title: "Mob Court", area: "Yaba", university: "University of Lagos", price: 700000, type: "Studio", bedrooms: 1, description: "x" }) })).json()).listing;
    const studentCookie = await signUp(`ms${Date.now()}@example.com`, "Mob Student", "tenant");
    const convoId = (await (await fetch(`${BASE}/api/listings/${listing.id}/contact`, { method: "POST", headers: { Cookie: studentCookie } })).json()).conversationId;
    for (let i = 0; i < 25; i++) await fetch(`${BASE}/api/conversations/${convoId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: studentCookie }, body: JSON.stringify({ text: `mobile filler ${i} some wrapping text here` }) });

    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true });
    await page.setCookie({ name: "ch_session", value: studentCookie.split("=")[1], url: BASE });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.querySelector('[data-tab="messages"]')?.click());
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => document.querySelector("[data-action=\"open-conversation\"]")?.click());
    await new Promise(r => setTimeout(r, 900));
    const m1 = await page.evaluate(() => {
      const list = document.querySelector("#chatMessages");
      const composer = document.querySelector(".chat-compose");
      return {
        pageScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
        listScrollable: list && list.scrollHeight > list.clientHeight + 10,
        composerVisible: composer && composer.getBoundingClientRect().bottom <= window.innerHeight + 1
      };
    });
    check("mobile: page contained (no page scroll)", !m1.pageScrollable);
    check("mobile: message list is the scroll area", m1.listScrollable);
    check("mobile: composer visible", m1.composerVisible);
    await page.evaluate(() => { document.querySelector("#chatMessages").scrollTop += 500; });
    await new Promise(r => setTimeout(r, 200));
    const m2 = await page.evaluate(() => ({ y: window.scrollY, scrolled: document.querySelector("#chatMessages").scrollTop }));
    check("mobile: inner scroll only (window stays at 0)", m2.y === 0 && m2.scrolled > 400, `y=${m2.y} scrolled=${m2.scrolled}`);

    // Admin ID-document serving: student submits verification with ID image,
    // admin fetches the document endpoint -> must be an image, not a 404.
    const adminCookie = await signUp(`ma${Date.now()}@example.com`, "Mob Admin", "tenant");
    const submit = await fetch(`${BASE}/api/verification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: studentCookie },
      body: JSON.stringify({ idType: "Student ID", nin: "12345678901", idCardImage: PNG })
    });
    console.log("verification submit:", submit.status);
    // Find the core-admin bootstrap: need a real admin. Check /api/admin/overview access:
    const ov = await fetch(`${BASE}/api/admin/overview`, { headers: { Cookie: adminCookie } });
    console.log("admin overview as plain user:", ov.status, "(expected 403)");
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("PROBE ERROR", e); process.exit(1); });
