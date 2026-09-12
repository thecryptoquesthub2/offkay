#!/usr/bin/env node
"use strict";
// Boots a scratch server, creates a throwaway account with a listing, peer,
// conversation, and booking through the public API, then saves the real
// /api/bootstrap payload to /tmp/seeded-bootstrap.json so head-render-diag.js
// can run the client render path against live data.
const { spawn } = require("node:child_process");
const fs = require("node:fs");

const PORT = 4679;
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync("/tmp/seedtest2", { recursive: true, force: true });
const srv = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, OFFKAY_DATA_DIR: "/tmp/seedtest2", PORT: String(PORT), HOST: "127.0.0.1", SIGNUP_RATE_LIMIT: "100" },
  stdio: "ignore"
});

const jar = () => ({ c: "", header() { return this.c; } });
async function call(j, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(j.c ? { Cookie: j.c } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const line of (res.headers.getSetCookie?.() || [])) j.c = line.split(";")[0];
  return { status: res.status, payload: await res.json().catch(() => ({})) };
}

setTimeout(async () => {
  try {
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(`${BASE}/api/bootstrap`); if (r.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const tenant = jar();
    const step1 = await call(tenant, "POST", "/api/auth/signup", { name: "Render Tenant", email: `render.tenant-${Date.now()}@example.com`, password: "password123", role: "tenant", phone: "08000000001", university: "University of Lagos", bio: "Render fixture tenant.", budget: 400000, habits: ["Quiet home"] });
    if (step1.status !== 201) throw new Error("fixture signup failed: " + JSON.stringify(step1.payload));
    await call(tenant, "PATCH", "/api/profile", { bio: "Render fixture tenant.", budget: 400000, habits: ["Very tidy", "Quiet home"] });
    const landlord = jar();
    await call(landlord, "POST", "/api/auth/signup", { name: "Render Landlord", email: `render.landlord-${Date.now()}@example.com`, password: "password123", role: "landlord", university: "University of Lagos" });
    const listing = await call(landlord, "POST", "/api/listings", { title: "Render Court", area: "Akoka", university: "University of Lagos", price: 300000, type: "Studio", bedrooms: 1, bathrooms: 1, description: "Render fixture listing.", amenities: ["Water"], latitude: 6.5158, longitude: 3.3898 });
    if (listing.status !== 201) throw new Error("fixture listing failed: " + JSON.stringify(listing.payload));
    await call(tenant, "POST", `/api/listings/${listing.payload.listing.id}/save`);
    await call(tenant, "POST", `/api/listings/${listing.payload.listing.id}/contact`);
    const peer = jar();
    const peerSignup = await call(peer, "POST", "/api/auth/signup", { name: "Render Peer", email: `render.peer-${Date.now()}@example.com`, password: "password123", role: "tenant", university: "University of Lagos" });
    if (peerSignup.status !== 201) throw new Error("peer signup failed: " + JSON.stringify(peerSignup.payload));
    await call(tenant, "POST", "/api/conversations/start", { userId: peerSignup.payload.user.id });
    const res = await fetch(`${BASE}/api/bootstrap`, { headers: { cookie: tenant.c } });
    fs.writeFileSync("/tmp/seeded-bootstrap.json", await res.text());
    console.log("payload captured");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  srv.kill();
}, 600);
