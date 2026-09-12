"use strict";
// Diagnostic: runs a given build of public/app.js (default: working tree; pass
// a path to test another build, e.g. the committed HEAD copy) through the full
// signed-in render path with a recording DOM stub, then reports which render
// function crashes and what actually got rendered.
// Usage: node scripts/head-render-diag.js [path/to/app.js]
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appPath = process.argv[2] || path.join(__dirname, "..", "public", "app.js");
const PORT = 4583;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-headdiag-"));
const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" },
  stdio: "ignore"
});

setTimeout(async () => {
  try {
    const login = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tenant@demo.test", password: "demo1234" })
    });
    const cookie = login.headers.get("set-cookie") || "";
    const payload = await (await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
    console.log("bootstrap payload user:", payload.user?.name);

    // Recording DOM: every innerHTML write is logged so we can see what rendered.
    const writes = [];
    const els = new Map();
    function makeEl(sel) {
      return {
        sel, _inner: "", textContent: "", style: {}, dataset: {}, value: "",
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        get innerHTML() { return this._inner; },
        set innerHTML(v) { this._inner = String(v); writes.push([sel, this._inner.length]); },
        addEventListener() {}, removeEventListener() {},
        appendChild() {}, querySelector() { return null; },
        querySelectorAll() { return []; },
        setAttribute() {}, getAttribute() { return null; }, remove() {}, focus() {},
      };
    }
    global.document = {
      body: makeEl("body"),
      querySelector(sel) { if (!els.has(sel)) els.set(sel, makeEl(sel)); return els.get(sel); },
      querySelectorAll() { return []; },
      createElement(t) { return makeEl("<created " + t + ">"); },
      addEventListener() {}, removeEventListener() {},
    };
    global.window = { addEventListener() {}, location: { href: "" }, scrollTo() {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
    global.localStorage = window.localStorage;
    try { global.navigator = { clipboard: {} }; } catch { Object.defineProperty(global, "navigator", { value: { clipboard: {} }, configurable: true }); }
    global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
    global.setInterval = () => 0;
    global.clearInterval = () => {};

    const src = fs.readFileSync(appPath, "utf8");
    const api = new Function(src + "\n;return { state, renderHome, renderExplore, renderMessages, renderProfile, renderAll, enterApp, switchTab, tenantHome, landlordHome, propertyTable, bookingsList, conversationRow, personRow, listingCard, roommateCard };")();

    Object.assign(api.state, payload);
    console.log("--- signed-in as:", api.state.user?.role, "---");

    // Run each render individually to isolate the crashing one.
    const steps = [
      ["renderHome", api.renderHome],
      ["renderExplore", api.renderExplore],
      ["renderMessages", api.renderMessages],
      ["renderProfile", api.renderProfile],
      ["renderAll", api.renderAll],
      ["enterApp", api.enterApp],
    ];
    let failures = 0;
    for (const [name, fn] of steps) {
      writes.length = 0;
      try {
        fn.call(api);
        const bytes = writes.reduce((s, w) => s + w[1], 0);
        console.log(`OK   ${name} (wrote ${bytes} chars across ${writes.length} nodes)`);
      } catch (e) {
        failures++;
        console.log(`CRASH ${name}: ${e.message}`);
        console.log((e.stack || "").split("\n").slice(1, 4).join("\n"));
      }
    }

    // Host-view path too (landlord dashboard is a separate render branch).
    if (api.state.user) {
      api.state.hostView = true;
      try {
        api.renderHome();
        console.log("OK   renderHome in host view");
      } catch (e) {
        failures++;
        console.log(`CRASH renderHome (host view): ${e.message}`);
      }
      api.state.hostView = false;
    }

    console.log(failures ? `RESULT: ${failures} render function(s) crash` : "RESULT: all render functions clean");
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.log("diag error:", e.message);
    process.exitCode = 1;
  } finally {
    proc.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}, 1500);
