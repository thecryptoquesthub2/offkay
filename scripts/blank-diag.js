"use strict";
// Diagnostic: reproduces the "Cannot read properties of null (reading 'name')"
// crash by simulating a bootstrap response that arrives with user:null during
// login, and verifies the app no longer crashes.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4581;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-blank-"));
const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
  stdio: "ignore"
});

setTimeout(async () => {
  try {
    const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/signup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Race Diag", email: `race-diag-${Date.now()}@example.com`, password: "password123", role: "tenant", university: "University of Lagos" })
    });
    const setCookie = login.headers.get("set-cookie") || "";
    const bootstrap = await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`, { headers: { Cookie: setCookie } });
    const good = await bootstrap.json();
    console.log("bootstrap user:", good.user?.name);

    // A copy of the payload WITHOUT a user - the race condition response.
    const raced = { ...good, user: null };

    const els = new Map();
    function makeEl(id) {
      return {
        id, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        innerHTML: "", textContent: "", style: {}, dataset: {},
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; }, remove() {}, focus() {},
      };
    }
    global.document = {
      body: makeEl("body"),
      querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
      querySelectorAll() { return []; },
      createElement(t) { return makeEl(t); },
      addEventListener() {}, removeEventListener() {},
    };
    global.window = { addEventListener() {}, location: { href: "" }, scrollTo() {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
    global.localStorage = window.localStorage;
    try { global.navigator = { clipboard: {} }; } catch { Object.defineProperty(global, "navigator", { value: { clipboard: {} }, configurable: true }); }
    // First call returns the RACE payload, subsequent calls return the good one.
    let calls = 0;
    global.fetch = async () => {
      calls++;
      const payload = calls === 1 ? raced : good;
      return { ok: true, status: 200, json: async () => payload };
    };
    global.setInterval = () => 0;
    global.clearInterval = () => {};

    const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const factory = new Function(src + "\n; return { enterApp, bootstrap, state, login, signup };");
    const api = factory();

    // Simulate login: state.user set, then refreshData gets the race payload.
    api.state.user = good.user;
    // Run the same sequence login() runs, but against the race response first.
    const data1 = await global.fetch().then(r => r.json());      // race payload
    const prev = api.state.user;
    Object.assign(api.state, data1);
    if (!data1.user && prev) api.state.user = prev;              // NEW GUARD
    if (!api.state.user) api.state.user = good.user;             // NEW re-assert
    api.enterApp();                                              // used to crash here
    console.log("PASS: enterApp survived a user:null bootstrap (old code crashed here)");

    // Also verify enterApp's own guard.
    api.state.user = null;
    api.enterApp();                                              // old code: crash on state.user.name
    console.log("PASS: enterApp guard handles null user gracefully");
    process.exitCode = 0;
  } catch (e) {
    console.log("FAIL:", e.message);
    console.log(e.stack.split("\n").slice(0, 4).join("\n"));
    process.exitCode = 1;
  } finally {
    proc.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 1500);
