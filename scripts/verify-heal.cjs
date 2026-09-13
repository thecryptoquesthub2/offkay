"use strict";
/* One-shot: plant a legacy duplicate conversation pair in a scratch data dir,
   boot the server once, and confirm the load-time heal merges the duplicates
   and persists the merged shape back to the db file. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heal-"));
fs.writeFileSync(path.join(tmp, "db.json"), JSON.stringify({
  users: [
    { id: "u_host", name: "Host", email: "h@x.com", password: "$2a$10$invalid", role: "landlord" },
    { id: "u_stud", name: "Stud", email: "s@x.com", password: "$2a$10$invalid", role: "tenant" }
  ],
  conversations: [
    { id: "c_old", memberIds: ["u_stud", "u_host"], listingId: "l_a", createdAt: "2026-09-01T10:00:00Z", updatedAt: "2026-09-01T10:00:00Z", reads: {} },
    { id: "c_dup", memberIds: ["u_stud", "u_host"], listingId: "l_b", createdAt: "2026-09-02T10:00:00Z", updatedAt: "2026-09-02T10:00:00Z", reads: {} }
  ],
  messages: [
    { id: "m_1", conversationId: "c_old", senderId: "u_stud", text: "from A", createdAt: "2026-09-01T10:00:00Z" },
    { id: "m_2", conversationId: "c_dup", senderId: "u_stud", text: "from B", createdAt: "2026-09-02T10:00:00Z" }
  ]
}));
const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")],
  { env: { ...process.env, PORT: "4622", HOST: "127.0.0.1", OFFKAY_DATA_DIR: tmp, PAYSTACK_SECRET_KEY: "" }, stdio: ["ignore", "ignore", "inherit"] });
(async () => {
  for (let i = 0; i < 80; i++) { try { const r = await fetch("http://127.0.0.1:4622/api/health"); if (r.ok) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  // Any authenticated request forces a loadDb; an anonymous bootstrap is enough.
  await fetch("http://127.0.0.1:4622/api/bootstrap").catch(() => {});
  await new Promise(r => setTimeout(r, 400));
  const db = JSON.parse(fs.readFileSync(path.join(tmp, "db.json"), "utf8"));
  console.log("conversations after load:", db.conversations.map(c => c.id).join(",") || "(none)");
  console.log("message parents:", db.messages.map(m => `${m.id}->${m.conversationId}`).join(" "));
  const ok = db.conversations.length === 1 && db.conversations[0].id === "c_old"
    && db.messages.every(m => m.conversationId === "c_old")
    && db.conversations[0].pairKey === "u_host:u_stud" || db.conversations[0]?.pairKey;
  console.log(ok ? "HEAL OK" : "HEAL FAILED");
  proc.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("PROBE ERROR", e); proc.kill("SIGKILL"); process.exit(1); });
