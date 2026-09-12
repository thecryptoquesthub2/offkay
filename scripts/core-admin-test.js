#!/usr/bin/env node
"use strict";
/* Core Administrator authorization tests — API-level, as required.
   Boots a disposable server with CORE_ADMIN_EMAILS listing exactly two
   accounts (the "two initial admins" scenario), then verifies:
   - role promotion is server-side and extensible (a 3rd email works)
   - only core_admin sessions reach /api/admin/* (normal users get 403)
   - anonymous requests get 401/403
   - signup CANNOT self-assign core_admin or claim a CORE_ADMIN_EMAILS address
   - documents are only served to authorized callers
   - approval/rejection records WHO did it (audit trail distinguishes admins)
   - users cannot modify their own verification status via public endpoints */
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 4607;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "test-core-admin-token";

let passed = 0, failed = 0;
const failures = [];
function check(name, condition, extra = "") {
  if (condition) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    absorb: res => {
      for (const line of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
    }
  };
}

async function call(session, method, route, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Cookie: session.header() } : {}),
      ...extraHeaders
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (session) session.absorb(res);
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offkay-admin-"));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: {
      ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp,
      PAYSTACK_SECRET_KEY: "", ADMIN_TOKEN,
      // The "two initial core administrators" configuration, plus nothing else.
      CORE_ADMIN_EMAILS: "owner@offkay.test, cobuilder@offkay.test"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  proc.stdout.on("data", d => { serverLog += d; });
  proc.stderr.on("data", d => { serverLog += d; });

  try {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    console.log("== admin account provisioning ==");
    // The two admin accounts are ordinary users created through normal signup,
    // then promoted server-side because their emails are in CORE_ADMIN_EMAILS.
    const owner = jar(), coBuilder = jar(), student = jar(), outsider = jar();
    await call(owner, "POST", "/api/auth/signup", { name: "Product Owner", email: "owner@offkay.test", password: "ownerpass123", role: "tenant", university: "University of Lagos" });
    await call(coBuilder, "POST", "/api/auth/signup", { name: "Co Builder", email: "cobuilder@offkay.test", password: "builderpass123", role: "tenant", university: "University of Lagos" });
    await call(student, "POST", "/api/auth/signup", { name: "Regular Student", email: `student${Date.now()}@t.test`, password: "studentpass123", role: "tenant", university: "University of Ibadan" });

    const ownerBoot = await call(owner, "GET", "/api/bootstrap");
    const coBoot = await call(coBuilder, "GET", "/api/bootstrap");
    const studentBoot = await call(student, "GET", "/api/bootstrap");
    check("first admin has core_admin role server-side", ownerBoot.payload.user?.role === "core_admin");
    check("second admin has core_admin role server-side", coBoot.payload.user?.role === "core_admin");
    check("both admins flagged isCoreAdmin for the UI", ownerBoot.payload.user?.isCoreAdmin === true && coBoot.payload.user?.isCoreAdmin === true);
    check("regular user is NOT admin", studentBoot.payload.user?.isCoreAdmin === false && studentBoot.payload.user?.role !== "core_admin");

    console.log("== signup cannot create or claim admin accounts ==");
    const selfAdmin = await call(jar(), "POST", "/api/auth/signup", { name: "Sneaky Admin", email: `sneaky${Date.now()}@t.test`, password: "password123", role: "core_admin", university: "University of Lagos" });
    check("signup with role=core_admin rejected (403)", selfAdmin.status === 403);
    const claimOwner = await call(jar(), "POST", "/api/auth/signup", { name: "Impostor", email: "owner@offkay.test", password: "password123", role: "tenant", university: "University of Lagos" });
    check("signup with a CORE_ADMIN_EMAILS address rejected (409/403)", claimOwner.status === 403 || claimOwner.status === 409);

    console.log("== admin API authorization ==");
    const anonOverview = await call(null, "GET", "/api/admin/overview");
    check("anonymous cannot access admin overview (401/403)", [401, 403].includes(anonOverview.status));
    const studentOverview = await call(student, "GET", "/api/admin/overview");
    check("authenticated non-admin gets 403 on admin overview", studentOverview.status === 403);
    check("403 message names the requirement", /core administrator/i.test(String(studentOverview.payload.error || "")));
    const studentHistory = await call(student, "GET", "/api/admin/verification-history");
    check("non-admin cannot read verification history", studentHistory.status === 403);

    console.log("== verification submission + document security ==");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const submit = await call(student, "POST", "/api/verification", { nin: "12345678901", idType: "Student ID", idCardImage: png });
    check("student submits verification", submit.status === 201);
    const verId = submit.payload.verification?.id;
    check("submission id returned", Boolean(verId));

    const docAnon = await fetch(`${BASE}/api/admin/verification/${verId}/document/idCard`);
    check("anonymous cannot fetch verification document", [401, 403].includes(docAnon.status));
    const docStudent = await fetch(`${BASE}/api/admin/verification/${verId}/document/idCard`, { headers: { Cookie: student.header() } });
    check("owner (non-admin) cannot fetch own document via admin route", docStudent.status === 403);
    const docAdmin = await fetch(`${BASE}/api/admin/verification/${verId}/document/idCard`, { headers: { Cookie: owner.header() } });
    check("core admin session CAN fetch the document", docAdmin.status === 200);
    const docToken = await fetch(`${BASE}/api/admin/verification/${verId}/document/idCard`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    check("operator bearer token still works for ops", docToken.status === 200);

    // Public surfaces must never expose documents or raw NIN
    const ownGet = await call(student, "GET", "/api/verification");
    check("owner sees masked NIN only", ownGet.payload.verification?.ninMasked?.startsWith("*") === true && !String(ownGet.payload.verification?.ninMasked || "").includes("12345678901"));
    const publicProfile = await call(owner, "GET", `/api/users/${studentBoot.payload.user.id}`);
    check("public profile exposes no verification documents", !("idCardImage" in (publicProfile.payload.user || {})) && !("nin" in (publicProfile.payload.user || {})));

    console.log("== self-service status tampering blocked ==");
    const tamper = await call(student, "PATCH", "/api/profile", { verificationStatus: "VERIFIED", verified: true, role: "core_admin" });
    const studentAfter = await call(student, "GET", "/api/bootstrap");
    check("user cannot promote self via profile PATCH", studentAfter.payload.user?.role !== "core_admin" && studentAfter.payload.verificationStatus !== "VERIFIED" && studentAfter.payload.user?.verified !== true);

    console.log("== review + audit trail: admins are distinguishable ==");
    const rejectNoReason = await call(owner, "POST", `/api/admin/verification/${verId}/review`, { decision: "reject", reason: "" });
    check("rejection without reason blocked (400)", rejectNoReason.status === 400);
    const approveByOwner = await call(owner, "POST", `/api/admin/verification/${verId}/review`, { decision: "approve" });
    check("owner approves the submission", approveByOwner.status === 200 && approveByOwner.payload.verification?.status === "verified");
    const double = await call(owner, "POST", `/api/admin/verification/${verId}/review`, { decision: "approve" });
    check("double review blocked (409)", double.status === 409);
    const userVerified = await call(student, "GET", "/api/bootstrap");
    check("student is now verified server-side", userVerified.payload.verificationStatus === "VERIFIED");

    // Second submission, rejected by the OTHER admin — audit must show both.
    // (Fresh IP jar: the test client has already used the signup rate-limit budget.)
    const resubSession = jar();
    const resub = await call(resubSession, "POST", "/api/auth/signup", { name: "Second Student", email: `second${Date.now()}@t.test`, password: "studentpass123", role: "tenant", university: "University of Ibadan" });
    check("second student created", resub.status === 201, `status ${resub.status} ${JSON.stringify(resub.payload)}`);
    const submit2 = await call(resubSession, "POST", "/api/verification", { nin: "10987654321", idType: "NIN slip", supportDocument: png });
    check("second submission created", submit2.status === 201);
    const rejectByCo = await call(coBuilder, "POST", `/api/admin/verification/${submit2.payload.verification.id}/review`, { decision: "reject", reason: "Document is not readable" });
    check("co-builder rejects with reason", rejectByCo.status === 200 && rejectByCo.payload.verification?.status === "rejected");
    const rejectedUser = await call(resubSession, "GET", "/api/verification");
    check("rejected user sees the reason", String(rejectedUser.payload.verification?.rejectionReason || "").includes("not readable"));

    const history = await call(owner, "GET", "/api/admin/verification-history");
    const events = history.payload.events || [];
    check("history records both reviews", events.length >= 2);
    const approveEvent = events.find(e => e.decision === "approved");
    const rejectEvent = events.find(e => e.decision === "rejected");
    check("approval audited with acting admin name", approveEvent?.reviewedByName === "Product Owner" && Boolean(approveEvent?.reviewedBy) && Boolean(approveEvent?.reviewedAt));
    check("rejection audited with the OTHER admin", rejectEvent?.reviewedByName === "Co Builder" && rejectEvent?.reason === "Document is not readable");
    check("history is admin-only", (await call(student, "GET", "/api/admin/verification-history")).status === 403);

    console.log("== future extensibility: a third admin via env ==");
    // Restart with a third email added — the role system must accept it with no code change.
    proc.kill("SIGKILL");
    const proc2 = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: {
        ...process.env, PORT: String(PORT), HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp,
        PAYSTACK_SECRET_KEY: "", ADMIN_TOKEN,
        CORE_ADMIN_EMAILS: "owner@offkay.test, cobuilder@offkay.test, third@offkay.test"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    const third = jar();
    await call(third, "POST", "/api/auth/signup", { name: "Third Admin", email: "third@offkay.test", password: "thirdpass123", role: "tenant", university: "University of Lagos" });
    const thirdBoot = await call(third, "GET", "/api/bootstrap");
    check("third admin promoted without code change", thirdBoot.payload.user?.role === "core_admin");
    const thirdAdmin = await call(third, "GET", "/api/admin/overview");
    check("third admin can access the dashboard", thirdAdmin.status === 200);
    proc2.kill("SIGKILL");

  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    if (failed) console.log(`\nServer log tail:\n${serverLog.slice(-600)}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log("Failures:", failures.join(", ")); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
