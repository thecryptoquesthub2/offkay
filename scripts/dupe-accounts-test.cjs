"use strict";
/* Regression probe for the duplicate-accounts bug the user reported:
   "2 new users signed up but their accounts are duplicated — 4 profiles for
   2 persons." Simulates BOTH production paths in Mongo mode (fake driver):

   PART A — healing already-corrupted data: plants the exact broken state
   (two user docs per person, refs pointing at both) in a shared fake Mongo
   store, boots a cold instance, and proves one merged profile per person
   with every reference intact and the duplicate docs deleted in Mongo.

   PART B — preventing new duplicates: two real server instances share the
   store; instance B signs up the same email A just signed up (B's snapshot
   cannot know about A's write). The unique index must reject B with 409 —
   not create a second account. Also: conversation pair race, and signup on
   ONE instance then instant login on the OTHER. */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT_A = 4655, PORT_B = 4656;
const BASE_A = `http://127.0.0.1:${PORT_A}`, BASE_B = `http://127.0.0.1:${PORT_B}`;
const fakeFile = path.join(os.tmpdir(), `dupe-e2e-${Date.now()}.json`);
const dataA = fs.mkdtempSync(path.join(os.tmpdir(), "dupe-a-"));
const dataB = fs.mkdtempSync(path.join(os.tmpdir(), "dupe-b-"));
let passed = 0, failed = 0;
const check = (name, ok, extra = "") => { if (ok) { passed++; console.log("  ok  ", name); } else { failed++; console.log("  FAIL", name, extra); } };
const boot = (port, dataDir) => spawn(process.execPath,
  ["--require", path.join(__dirname, "fake-mongo-preload.cjs"), path.join(__dirname, "..", "server.js")],
  { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OFFKAY_DATA_DIR: dataDir, PAYSTACK_SECRET_KEY: "",
    MONGODB_URI: "mongodb://fake@127.0.0.1:27017/offkay", MONGODB_DB: "offkay", OFFKAY_FAKE_MONGO: "1",
    OFFKAY_FAKE_MONGO_FILE: fakeFile, OFFKAY_FAKE_MONGO_SHARED: "1" }, stdio: ["ignore", "ignore", "inherit"] });
const ready = async base => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch {} await new Promise(r => setTimeout(r, 150)); } return false; };
const readStore = () => JSON.parse(fs.readFileSync(fakeFile, "utf8")).collections;
async function call(base, method, url, body, cookie) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, payload: await res.json().catch(() => ({})), cookie: setCookies[0]?.split(";")[0] || "" };
}

(async () => {
  /* ================= PART A — heal the planted duplicates ============== */
  // The exact production corruption: two user docs per person (original +
  // race-twin created later), with data spread across both and references
  // pointing at BOTH ids. Passwords use the server's real scrypt format so
  // merged accounts authenticate exactly like production ones.
  const hashFor = password => { const salt = require("node:crypto").randomBytes(16).toString("hex"); return `${salt}:${require("node:crypto").scryptSync(password, salt, 64).toString("hex")}`; };
  const origTs = "2026-09-01T10:00:00.000Z";
  const dupTs = "2026-09-05T10:00:00.000Z";
  const store = { collections: {
    users: [
      { _id: "usr_orig_a", id: "usr_orig_a", name: "Abdul Bala", email: "abdul@example.com", password: hashFor("abdul-pass-1"), role: "tenant", university: "Abubakar Tafawa Balewa University", verified: true, bio: "original bio", budget: 150000, habits: ["Early bird"], createdAt: origTs },
      { _id: "usr_dup_a", id: "usr_dup_a", name: "Abdul Bala", email: "abdul@example.com", password: hashFor("abdul-twin-9"), role: "tenant", university: "Abubakar Tafawa Balewa University", hosting: true, bio: "", budget: 0, habits: [], createdAt: dupTs },
      { _id: "usr_orig_g", id: "usr_orig_g", name: "Giwa Musa", email: "giwa@example.com", password: hashFor("giwa-pass-1"), role: "tenant", university: "Abubakar Tafawa Balewa University", bio: "", budget: 0, habits: [], createdAt: origTs },
      { _id: "usr_dup_g", id: "usr_dup_g", name: "Giwa Musa", email: "giwa@example.com", password: hashFor("giwa-twin-9"), role: "tenant", university: "Abubakar Tafawa Balewa University", bio: "", budget: 0, habits: [], createdAt: dupTs }
    ],
    sessions: [],
    listings: [{ _id: "lst_1", id: "lst_1", title: "Tafawa Court", ownerId: "usr_dup_a", price: 900000, type: "Studio", status: "active", createdAt: dupTs }],
    saved: [{ _id: "svd_1", id: "svd_1", userId: "usr_orig_g", listingId: "lst_1", createdAt: origTs }],
    conversations: [{ _id: "con_1", id: "con_1", memberIds: ["usr_dup_a", "usr_orig_g"], listingId: null, updatedAt: origTs, reads: {}, createdAt: origTs }],
    messages: [{ _id: "msg_1", id: "msg_1", conversationId: "con_1", senderId: "usr_dup_a", text: "hello", createdAt: origTs }],
    bookings: [{ _id: "bkg_1", id: "bkg_1", listingId: "lst_1", tenantId: "usr_dup_g", ownerId: "usr_orig_a", amount: 900000, splitCount: 1, paymentShares: [900000], paidSlots: [], paymentRefs: {}, shareToken: "shk_1", status: "awaiting_payment", createdAt: origTs }],
    inspections: [{ _id: "ins_1", id: "ins_1", listingId: "lst_1", tenantId: "usr_orig_g", ownerId: "usr_dup_a", preferredDate: "Sat", timeWindow: "Morning", note: "", status: "requested", createdAt: origTs }],
    reports: [], verifications: [{ _id: "ver_1", id: "ver_1", userId: "usr_dup_a", idType: "Student ID", status: "pending", createdAt: dupTs }],
    verification_events: [],
    notifications: [{ _id: "ntf_1", id: "ntf_1", userId: "usr_orig_g", title: "t", body: "b", type: "system", actorId: "usr_dup_a", read: false, createdAt: origTs }],
    connections: [{ _id: "cnx_1", id: "cnx_1", requesterId: "usr_orig_g", recipientId: "usr_dup_a", status: "accepted", createdAt: origTs }],
    passwordResets: [{ _id: "rst_1", id: "rst_1", userId: "usr_dup_g", token: "t1", createdAt: origTs }]
  } };
  fs.writeFileSync(fakeFile, JSON.stringify(store));

  const procA = boot(PORT_A, dataA);
  try {
    check("instance A booted", await ready(BASE_A));
    // Force a load: the heal runs at load time.
    const boot1 = await call(BASE_A, "GET", "/api/bootstrap");
    check("bootstrap 200 over healed data", boot1.status === 200, `status=${boot1.status}`);
    await new Promise(r => setTimeout(r, 500)); // heal persistence settles

    const after = readStore();
    const abduls = after.users.filter(u => u.email === "abdul@example.com");
    const giwas = after.users.filter(u => u.email === "giwa@example.com");
    check("Abdul merged to ONE account in Mongo", abduls.length === 1, `count=${abduls.length}`);
    check("Giwa merged to ONE account in Mongo", giwas.length === 1, `count=${giwas.length}`);
    const abdul = abduls[0], giwa = giwas[0];
    check("oldest account kept for Abdul", abdul.id === "usr_orig_a", abdul.id);
    check("duplicate docs deleted in Mongo", !after.users.some(u => u.id === "usr_dup_a" || u.id === "usr_dup_g"));

    // Fold-in: keep.verified=true (orig) + drop.hosting=true (dup) both survive.
    check("kept account keeps its verified flag", abdul.verified === true);
    check("kept account adopts hosting from duplicate", abdul.hosting === true);
    check("kept account keeps its bio", abdul.bio === "original bio");

    // Every reference now points at kept ids.
    check("listing ownerId remapped", after.listings[0].ownerId === "usr_orig_a");
    check("saved userId remapped", after.saved[0].userId === "usr_orig_g");
    check("conversation members remapped", JSON.stringify([...after.conversations[0].memberIds].sort()) === JSON.stringify(["usr_orig_a", "usr_orig_g"]));
    check("conversation pairKey recomputed", after.conversations[0].pairKey === "usr_orig_a::usr_orig_g", after.conversations[0].pairKey);
    check("message senderId remapped", after.messages[0].senderId === "usr_orig_a");
    check("booking tenant+owner remapped", after.bookings[0].tenantId === "usr_orig_g" && after.bookings[0].ownerId === "usr_orig_a");
    check("inspection tenant+owner remapped", after.inspections[0].tenantId === "usr_orig_g" && after.inspections[0].ownerId === "usr_orig_a");
    check("verification userId remapped", after.verifications[0].userId === "usr_orig_a");
    check("notification actorId remapped", after.notifications[0].actorId === "usr_orig_a");
    check("connection endpoints remapped", after.connections[0].requesterId === "usr_orig_g" && after.connections[0].recipientId === "usr_orig_a");
    check("passwordResets remapped", after.passwordResets[0].userId === "usr_orig_g");

    // Directory view: each person appears exactly once, with real data.
    const login = await call(BASE_A, "POST", "/api/auth/login", { email: "giwa@example.com", password: "giwa-pass-1" });
    check("merged account still authenticates (original password)", login.status === 200, `status=${login.status}`);
    const people = await call(BASE_A, "GET", "/api/users", null, login.cookie);
    check("directory returns rows", Array.isArray(people.payload.people) && people.payload.people.length > 0, `count=${people.payload.people?.length}`);
    const abdulRows = people.payload.people.filter(person => person.name === "Abdul Bala");
    check("directory lists Abdul exactly ONCE", abdulRows.length === 1, `count=${abdulRows.length}`);
    check("directory row shows merged profile data (verified flag folded in)", abdulRows[0]?.verified === true, JSON.stringify(abdulRows[0] || {}).slice(0, 120));
    check("logged-in user (Giwa) correctly excluded from directory", !people.payload.people.some(person => person.id === login.payload.user.id));

    // Second cold instance loads the healed Mongo shape with no re-heal needed.
    const procB = boot(PORT_B, dataB);
    try {
      check("instance B booted", await ready(BASE_B));
      const boot2 = await call(BASE_B, "GET", "/api/bootstrap");
      check("instance B serves healed data", boot2.status === 200);
      const bStore = readStore();
      check("B still sees one account per person", bStore.users.filter(u => u.email.includes("example.com")).length === 2);

      /* ============ PART B — the race that created duplicates ============ */
      const email = `race${Date.now()}@example.com`;
      const suA = await call(BASE_A, "POST", "/api/auth/signup", { name: "Race One", email, password: "race-pass-1", role: "tenant", university: "University of Lagos" });
      check("signup on A succeeds", suA.status === 201, `status=${suA.status}`);
      const suB = await call(BASE_B, "POST", "/api/auth/signup", { name: "Race Two", email, password: "race-pass-1", role: "tenant", university: "University of Lagos" });
      check("same-email signup on B is REJECTED (unique index)", suB.status === 409, `status=${suB.status} body=${JSON.stringify(suB.payload).slice(0, 80)}`);
      const raceStore = readStore();
      check("exactly ONE account exists for the raced email", raceStore.users.filter(u => u.email === email).length === 1);

      // The race loser can sign in like the UI invites it to.
      const li = await call(BASE_B, "POST", "/api/auth/login", { email, password: "race-pass-1" });
      check("race loser can sign in instead", li.status === 200, `status=${li.status}`);

      // Cross-instance session validity (regression guard for the revive fix).
      const ses = await call(BASE_B, "GET", "/api/session", null, li.cookie);
      check("session created on B valid via /api/session", ses.status === 200 && Boolean(ses.payload.user), `status=${ses.status}`);
      const sesA = await call(BASE_A, "GET", "/api/session", null, li.cookie);
      check("same session valid on the OTHER instance", sesA.status === 200 && Boolean(sesA.payload.user), `status=${sesA.status}`);

      // Conversation pair race: two different users start chats with each
      // other from opposite instances at the same time.
      const u1 = `pair1${Date.now()}@example.com`, u2 = `pair2${Date.now()}@example.com`;
      const a1 = await call(BASE_A, "POST", "/api/auth/signup", { name: "Pair One", email: u1, password: "pair-pass-1", role: "tenant", university: "University of Lagos" });
      const a2 = await call(BASE_B, "POST", "/api/auth/signup", { name: "Pair Two", email: u2, password: "pair-pass-1", role: "tenant", university: "University of Lagos" });
      check("pair users created", a1.status === 201 && a2.status === 201);
      const id1 = a1.payload.user.id, id2 = a2.payload.user.id;
      const [p1, p2] = await Promise.all([
        call(BASE_A, "POST", "/api/conversations/start", { userId: id2 }, a1.cookie),
        call(BASE_B, "POST", "/api/conversations/start", { userId: id1 }, a2.cookie)
      ]);
      check("both pair-starts succeed", p1.status === 200 && p2.status === 200, `${p1.status}/${p2.status}`);
      const pairStore = readStore();
      const pairConvs = pairStore.conversations.filter(c => Array.isArray(c.memberIds) && c.memberIds.includes(id1) && c.memberIds.includes(id2));
      check("exactly ONE conversation for the pair across instances", pairConvs.length === 1, `count=${pairConvs.length}`);
    } finally { procB.kill("SIGKILL"); }
  } finally {
    procA.kill("SIGKILL");
    for (const dir of [dataA, dataB]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(fakeFile, { force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error("PROBE ERROR", err); process.exit(1); });
