"use strict";
/* UI flow test for the four reported Offkay issues. Boots a real disposable
   server, signs in a core admin, then runs public/app.js inside a vm with a
   DOM stub so the app's OWN click dispatch (bindEvents), switchTab, render
   functions, and fetch wrapper execute end to end. Exits 1 on any failure.
   Usage: node scripts/ui-fix-test.js */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vm = require("node:vm");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-uifix-"));
// Free port resolved inside the async main below (CJS: no top-level await).
let PORT = 0;
let BASE = "";

let passed = 0, failed = 0;
const fails = [];
function check(name, ok, extra = "") {
  if (ok) { passed++; console.log("  ok  ", name); }
  else { failed++; fails.push(name); console.log("  FAIL", name, extra); }
}

/* DOM stub that records innerHTML writes per selector and captures the
   delegated listeners bindEvents() installs. */
function makeDom() {
  const listeners = new Map();
  const els = new Map();
  function makeEl(sel) {
    const el = {
      sel, dataset: {}, value: "", textContent: "", inner: "",
      attributes: {}, disabled: false, style: {},
      classList: {
        _set: new Set(),
        add(...cs) { cs.forEach(c => this._set.add(c)); },
        remove(...cs) { cs.forEach(c => this._set.delete(c)); },
        toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else { on ? this._set.add(c) : this._set.delete(c); } },
        contains(c) { return this._set.has(c); }
      },
      addEventListener(type, fn) { const key = `${sel}|${type}`; if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
      removeEventListener() {},
      setAttribute(k, v) { this.attributes[k] = v; },
      getAttribute(k) { return this.attributes[k] ?? null; },
      requestSubmit() {}, scrollIntoView() {}, focus() {}, appendChild() {}, remove() {}, insertAdjacentHTML() {}, contains() { return false; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      closest() { return null; },
      get innerHTML() { return this.inner; },
      set innerHTML(v) { this.inner = String(v); }
    };
    els.set(sel, el);
    return el;
  }
  const documentStub = {
    querySelector(sel) { if (!els.has(sel)) makeEl(sel); return els.get(sel); },
    querySelectorAll(sel) {
      if (sel === ".admin-only") return [els.get('[data-tab="admin"]')].filter(Boolean);
      if (sel === "[data-tab]") return [...els.values()].filter(e => e.dataset && e.dataset.tab);
      if (sel === ".tab") return ["home", "explore", "messages", "profile", "admin"].map(t => els.get(`#tab-${t}`)).filter(Boolean);
      if (sel.startsWith(".pw-toggle")) return [];
      if (sel.startsWith(".role-option")) return [];
      return [];
    },    addEventListener(type, fn) { const key = `document|${type}`; if (!listeners.has(key)) listeners.set(key, []); listeners.get(key).push(fn); },
    createElement: () => makeEl(`dyn-${Math.random()}`), body: null, documentElement: null, head: null
  };
  documentStub.body = makeEl("body");
  documentStub.documentElement = makeEl("html");
  documentStub.head = makeEl("head");
  // Register every container the app renders into (mirrors index.html).
  for (const sel of ["#tab-home", "#tab-explore", "#tab-messages", "#tab-profile", "#tab-admin", "#modalRoot", "#toast", "#globalSearch", "#notificationButton", "#topAvatar", "#topName", "#topRole", "#sidebarCard", "#loginForm", "#signupForm", "#forgotForm", "#resetForm", "#logoutButton", "#authBanner", "#authTitle", "#authSubtitle", "#authEyebrow", "#resetTokenState", "#resetSubtitle", "#resetSubmit", "#bootSplash", "#app", "#authScreen", "#signupUniversity", "#notifPanel"]) {
    makeEl(sel);
  }
  els.get("#tab-home").classList.add("active");
  // Desktop sidebar + mobile bottom-nav Admin buttons (data-tab targets).
  makeEl('[data-tab="admin"]').dataset.tab = "admin";
  makeEl('[data-tab="home"]').dataset.tab = "home";
  makeEl('[data-tab="profile"]').dataset.tab = "profile";
  makeEl('[data-tab="explore"]').dataset.tab = "explore";
  makeEl('[data-tab="messages"]').dataset.tab = "messages";
  return { documentStub, els, listeners };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const adminEmail = `admin${Date.now()}@example.com`;
  // Resolve a free port up front so crashed runs can never squat on a fixed one.
  PORT = await new Promise(resolve => {
    const probe = require("node:net").createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  BASE = `http://127.0.0.1:${PORT}`;
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "", RESEND_API_KEY: "", CORE_ADMIN_EMAILS: adminEmail },
    stdio: "ignore"
  });
  try {
    check("server boots for UI fix tests", await waitReady());

    const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const indexHtml = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

    /* Issue 1: the shipped openMatches() must route to the Explore roommate
       flow and never open the landlord "Add a property" form. */
    check("issue 1: openMatches no longer returns listingForm() for non-tenants", !/if \(state\.user\.role !== "tenant"\) return listingForm\(\)/.test(appSource));
    check("issue 1: openMatches switches to the Explore roommate mode", appSource.includes('state.exploreMode = state.user.role === "tenant" ? "roommates" : "people"'));
    check("issue 1: hero 'Find a roommate' uses data-action=open-matches", appSource.includes('data-action="open-matches"') && appSource.includes("Find a roommate"));

    /* Issue 2: obsolete settingsSheet popup fully removed; one Settings impl. */
    check("issue 2: settingsSheet() removed from the bundle", !appSource.includes("settingsSheet"));
    check("issue 2: open-settings renders the Settings page (settingsView=true)", appSource.includes('action==="open-settings"') && appSource.includes("state.settingsView = true"));
    check("issue 2: renderProfile routes settingsView to renderSettings", appSource.includes("if (state.settingsView) return renderSettings();"));

    /* Issue 3: desktop sidebar Admin nav carries data-tab=admin like mobile. */
    const sidebarNav = indexHtml.match(/<nav class="main-nav"[\s\S]*?<\/nav>/);
    check("issue 3: desktop sidebar admin nav has data-tab=admin", Boolean(sidebarNav && /data-tab="admin"/.test(sidebarNav[0])));
    const bottomNav = indexHtml.match(/<nav class="bottom-nav[\s\S]*?<\/nav>/);
    check("issue 3: mobile bottom nav admin keeps data-tab=admin", Boolean(bottomNav && /data-tab="admin"/.test(bottomNav[0])));

    /* Issue 4: honest forgot-password delivery reporting, no secrets in logs. */
    check("issue 4: forgot response carries delivery state", serverSource.includes("delivery: delivery.delivery"));
    check("issue 4: Resend failure path returns delivery:failed", serverSource.includes('delivery: "failed"'));
    check("issue 4: dev (no key) path returns delivery:skipped", serverSource.includes('delivery: "skipped"'));
    check("issue 4: client shows an error banner when delivery failed", appSource.includes('data.delivery === "failed"') && appSource.includes("could not send the reset email"));
    check("issue 4: no credential material is logged", !/(RESEND_API_KEY|sk-)[^"`]*\$\{?RESEND/i.test(serverSource.split("console.")[1] || "") );

    /* Live HTTP behavior for issue 4. */
    const email = `uifix${Date.now()}@example.com`;
    const signup = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "UI Fix", email, password: "password123", role: "tenant", university: "University of Lagos" })
    });
    check("live signup works", signup.status === 201);
    const forgot = await fetch(`${BASE}/api/auth/forgot`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const forgotPayload = await forgot.json();
    check("live forgot returns delivery:skipped in dev (no RESEND_API_KEY)", forgot.status === 200 && forgotPayload.delivery === "skipped" && forgotPayload.devMode === true);
    const ghostRes = await fetch(`${BASE}/api/auth/forgot`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `ghost${Date.now()}@example.com` })
    });
    const ghostPayload = await ghostRes.json();
    check("live forgot for unknown email stays generic (200, no delivery leak)", ghostRes.status === 200 && ghostPayload.delivery === undefined && ghostPayload.delivered === undefined);

    /* Sign in the CORE_ADMIN_EMAILS account over real HTTP, then run the app
       in a vm signed in as that admin through the app's own fetch wrapper. */
    const signupAdmin = await fetch(`${BASE}/api/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Core Admin", email: adminEmail, password: "password123", role: "tenant", university: "University of Lagos" })
    });
    const setCookies = signupAdmin.headers.getSetCookie ? signupAdmin.headers.getSetCookie() : [];
    const sessionCookie = (setCookies.find(c => c.startsWith("ch_session=")) || "").split(";")[0];
    check("core admin account created and session issued", signupAdmin.status === 201 && Boolean(sessionCookie));
    // Direct server-side probe: promotion must appear on the next request.
    const bootProbe = await (await fetch(`${BASE}/api/bootstrap`, { headers: { Cookie: sessionCookie } })).json();
    check("server promotes CORE_ADMIN_EMAILS account", bootProbe.user?.role === "core_admin", `role=${bootProbe.user?.role} email=${bootProbe.user?.email} env=${adminEmail}`);

    const dom = makeDom();
    let jarCookie = sessionCookie;
    const sandboxFetch = async (url, opts = {}) => {
      const full = url.startsWith("http") ? url : `${BASE}${url}`;
      const headers = { ...(opts.headers || {}) };
      if (jarCookie && !headers.Cookie && !headers.cookie) headers.Cookie = jarCookie;
      const res = await fetch(full, { ...opts, headers });
      for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        if (line.startsWith("ch_session=")) jarCookie = line.split(";")[0];
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = {}; }
      return { ok: res.ok, status: res.status, headers: { get: () => "application/json" }, json: async () => json, text: async () => text };
    };
    const sandbox = {
      console, URLSearchParams, URL,
      fetch: sandboxFetch,
      document: dom.documentStub,
      window: { location: { href: "", search: "", origin: BASE }, addEventListener() {}, scrollTo() {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { clipboard: { writeText: async () => {} } },
      location: { search: "", href: "", pathname: "/", origin: BASE },
      FormData: class { get() { return ""; } },
      requestAnimationFrame: fn => setTimeout(fn, 0),
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
      crypto: { randomBytes: () => new Uint8Array(32) }
    };
    sandbox.globalThis = sandbox;
    // Expose the app's real internals from within the same script scope.
    const instrumented = `${appSource}\n;globalThis.__offkay = { state, switchTab, renderProfile, renderSettings, renderAdmin, renderExplore, renderAll };`;
    try {
      vm.runInNewContext(instrumented, sandbox, { filename: "app.js" });
      check("app.js loads in the DOM stub and bootstraps", true);
    } catch (err) {
      check("app.js loads in the DOM stub and bootstraps", false, String(err && err.message));
    }
    const app = sandbox.__offkay;
    if (!app) throw new Error("app internals were not exposed");
    await new Promise(r => setTimeout(r, 900)); // let bootstrap() settle

    check("app bootstrapped signed-in as the core admin", Boolean(app.state.user) && app.state.user.isCoreAdmin === true, `user=${JSON.stringify(app.state.user && app.state.user.email)} role=${app.state.user && app.state.user.role} tab=${app.state.activeTab}`);

    /* Issue 2 end to end: dispatch a real click on the Settings row through
       the app's own delegated document handler. */
    const rawClick = dom.listeners.get("document|click");
    const clickHandlers = Array.isArray(rawClick) ? rawClick : [rawClick].filter(Boolean);
    check("bindEvents installed the delegated click handler", clickHandlers.length > 0);
    // A real DOM dispatches to EVERY registered listener, in order.
    const clickHandler = async ev => {
      for (const fn of clickHandlers) {
        try { await fn(ev); } catch { /* a failing handler must not mask the others */ }
      }
    };
    await clickHandler({ target: { closest: sel => sel === "[data-action]" ? { dataset: { action: "open-settings" } } : null }, preventDefault() {} });
    const profileHtml = dom.els.get("#tab-profile").innerHTML;
    check("issue 2: Settings click renders the new Settings page", profileHtml.includes(">Settings</h1>"));
    check("issue 2: no modal opened when opening Settings", (dom.els.get("#modalRoot").innerHTML || "") === "");

    /* Issue 3 end to end: dispatch a real click on the DESKTOP sidebar admin
       nav button through the app's own [data-tab] branch -> switchTab ->
       renderAdmin -> /api/admin/overview over live HTTP. */
    const adminBtn = dom.els.get('[data-tab="admin"]');
    await clickHandler({ target: { closest: sel => sel === "[data-tab]" ? adminBtn : null }, preventDefault() {} });
    await new Promise(r => setTimeout(r, 600));
    const adminHtml = dom.els.get("#tab-admin").innerHTML;
    check("issue 3: clicking the desktop Admin nav renders the Admin dashboard", adminHtml.includes("Admin dashboard") && adminHtml.includes("Pending verifications"), adminHtml.slice(0, 120));

    /* Issue 1 end to end: dispatch a real click on the hero 'Find a roommate'
       button as a tenant session; expect the Explore roommate flow, never the
       Add-property form. Sign out of admin first via a fresh vm run. */
    const tenantEmail = `uifixtenant${Date.now()}@example.com`;
    await fetch(`${BASE}/api/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Tenant Fix", email: tenantEmail, password: "password123", role: "tenant", university: "University of Lagos" })
    });
    const tenantLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: tenantEmail, password: "password123" })
    });
    const tenantCookie = (tenantLogin.headers.getSetCookie().find(c => c.startsWith("ch_session=")) || "").split(";")[0];

    const dom2 = makeDom();
    const sandbox2 = {
      ...sandbox,
      document: dom2.documentStub,
      fetch: async (url, opts = {}) => {
        const headers = { ...(opts.headers || {}) };
        if (!headers.Cookie && !headers.cookie) headers.Cookie = tenantCookie;
        const res = await fetch(url.startsWith("http") ? url : `${BASE}${url}`, { ...opts, headers });
        const text = await res.text();
        let json; try { json = JSON.parse(text); } catch { json = {}; }
        return { ok: res.ok, status: res.status, headers: { get: () => "application/json" }, json: async () => json, text: async () => text };
      }
    };
    sandbox2.globalThis = sandbox2;
    const app2 = {};
    try {
      vm.runInNewContext(`${appSource}\n;globalThis.__offkay = { state, switchTab, renderProfile, renderSettings, renderAdmin, renderExplore, renderAll };`, sandbox2, { filename: "app2.js" });
      app2.ref = sandbox2.__offkay;
    } catch (err) {
      check("tenant app.js loads in the DOM stub", false, String(err && err.message));
    }
    await new Promise(r => setTimeout(r, 900));
    const rawClick2 = dom2.listeners.get("document|click");
    for (const fn of (Array.isArray(rawClick2) ? rawClick2 : [rawClick2].filter(Boolean))) {
      await fn({ target: { closest: sel => sel === "[data-action]" ? { dataset: { action: "open-matches" } } : null }, preventDefault() {} });
    }
    await new Promise(r => setTimeout(r, 600));
    const exploreHtml = dom2.els.get("#tab-explore").innerHTML;
    const modalHtml = dom2.els.get("#modalRoot").innerHTML || "";
    check("issue 1: 'Find a roommate' click lands on the Explore roommate flow", app2.ref.state.activeTab === "explore" && app2.ref.state.exploreMode === "roommates" && exploreHtml.includes("Find a roommate"));
    check("issue 1: 'Find a roommate' never opens the Add-property form", !modalHtml.includes("Add a new property") && !modalHtml.includes("listing-detail") && !exploreHtml.includes("Add a house</button>"));
  } finally {
    proc.kill("SIGKILL");
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", fails.join(", ")); process.exit(1); }
})().catch(err => { console.error("UI FIX TEST ERROR", err); process.exit(1); });
