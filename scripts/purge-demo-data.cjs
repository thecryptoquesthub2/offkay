#!/usr/bin/env node
"use strict";
/* Offkay demo-content purge — scoped to the one-time demo seed only.
 *
 * Deletes exactly: the 3 seeded demo users, their 4 listings, conversations,
 * messages, saved rows, bookings, inspections, reports, verifications,
 * verification events, connections, notifications, sessions, password-reset
 * tokens, and the demoSeed state flag.
 *
 * Deletes nothing else. The script ABORTS without deleting anything if:
 *   - a demo-named listing is owned by a non-demo account (so a real
 *     landlord's "Palm Court Studio" can never be swept away), or
 *   - a demo account shares a conversation with a real user.
 *
 * Run modes:
 *   node scripts/purge-demo-data.cjs           dry-run: prints a full report, deletes nothing
 *   node scripts/purge-demo-data.cjs --apply   interactive: report, then a typed confirmation gate
 *
 * Requires MONGODB_URI in the environment (the same variable the server uses).
 * The connection string is never printed.
 */

const DEMO_EMAILS = new Set(["landlord@demo.test", "tenant@demo.test", "zainab@demo.test"]);
const DEMO_LISTING_TITLES = new Set(["Palm Court Studio", "Maple Student Lodge", "Green Nest En-suite", "Cedar House"]);
const CONFIRM_PHRASE = "PURGE DEMO DATA";

async function main() {
  const apply = process.argv.includes("--apply");
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set in this shell. Nothing was inspected or deleted.");
    console.error("Run this where the server's MongoDB URI is available (it is never printed).");
    process.exit(2);
  }

  let dbName = "offkay";
  try {
    const parsed = new URL(uri);
    const fromPath = decodeURIComponent((parsed.pathname || "").replace(/^\//, ""));
    if (fromPath) dbName = fromPath.split("?")[0];
  } catch { /* keep default name if the URI cannot be parsed here */ }

  const { MongoClient } = require("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000 });
  await client.connect();
  const db = client.db(dbName);

  const users = await db.collection("users").find({}).toArray();
  const demoUsers = users.filter(u => DEMO_EMAILS.has(String(u.email || "").toLowerCase()));
  const demoIds = new Set(demoUsers.map(u => u.id));
  const demoEmailList = demoUsers.map(u => `${u.name} <${u.email}> role=${u.role}${u.verified ? " verified=true" : ""}`);

  console.log(`Database: connected (database name hidden; ${users.length} user rows total)`);
  console.log(`Demo accounts found: ${demoUsers.length}`);
  for (const line of demoEmailList) console.log("  - " + line);
  if (!demoUsers.length) {
    console.log("No demo rows found. Nothing to do.");
    await client.close();
    return;
  }

  // Real accounts that could be caught in the blast radius — hard abort if any exist.
  const listings = await db.collection("listings").find({}).toArray();
  const demoListings = listings.filter(l => demoIds.has(l.ownerId));
  const demoListingIds = new Set(demoListings.map(l => l.id));
  const strangerOwned = listings.filter(l => !demoIds.has(l.ownerId) && DEMO_LISTING_TITLES.has(l.title));
  if (strangerOwned.length) {
    console.error("\nABORT: demo-named listings are owned by non-demo accounts:");
    for (const l of strangerOwned) console.error(`  - "${l.title}" owner=${l.ownerId}`);
    console.error("Nothing was deleted. Resolve these listings manually first.");
    await client.close();
    process.exit(3);
  }

  const conversations = await db.collection("conversations").find({}).toArray();
  const demoConversations = conversations.filter(c => (c.memberIds || []).some(id => demoIds.has(id)));
  const demoConversationIds = new Set(demoConversations.map(c => c.id));
  const mixed = demoConversations.filter(c => (c.memberIds || []).some(id => !demoIds.has(id)));
  if (mixed.length) {
    console.error("\nABORT: demo accounts share conversations with real users:");
    for (const c of mixed) {
      const others = users.filter(u => (c.memberIds || []).includes(u.id) && !demoIds.has(u.id));
      for (const o of others) console.error(`  - conversation ${c.id} includes ${o.name} <${o.email}>`);
    }
    console.error("Nothing was deleted. Remove those conversations manually first.");
    await client.close();
    process.exit(3);
  }

  const countWhere = async (collection, filter) => db.collection(collection).countDocuments(filter);
  const inIds = field => ({ $in: [...demoIds] });
  const plan = [];
  const add = (collection, filter, note) => plan.push({ collection, filter, note });

  add("listings", { ownerId: inIds() }, demoListings.map(l => `"${l.title}"`));
  add("conversations", { _idSafe: true, id: { $in: [...demoConversationIds] } }, [...demoConversationIds].length + " conversation(s)");
  add("messages", { conversationId: { $in: [...demoConversationIds] } });
  add("saved", { userId: inIds() }, "demo users' saved rows");
  add("bookings", { $or: [{ tenantId: inIds() }, { ownerId: inIds() }] });
  add("inspections", { $or: [{ tenantId: inIds() }, { ownerId: inIds() }] });
  add("reports", { reportedBy: inIds() });
  add("verifications", { userId: inIds() });
  add("verification_events", { userId: inIds() });
  add("notifications", { userId: inIds() });
  add("connections", { $or: [{ requesterId: inIds() }, { recipientId: inIds() }] });
  add("passwordResets", { userId: inIds() });
  add("sessions", { userId: inIds() });
  // Saved rows from REAL users pointing at demo listings become meaningless
  // once those listings are gone — count them so the report is honest.
  const strangerSaves = await countWhere("saved", { listingId: { $in: [...demoListingIds] }, userId: { $nin: [...demoIds] } });
  if (strangerSaves) add("saved", { listingId: { $in: [...demoListingIds] } }, `includes ${strangerSaves} row(s) saved by real users on demo listings`);

  console.log("\nDeletion plan:");
  let total = 0;
  const report = [];
  for (const { collection, filter, note } of plan) {
    const safeFilter = filter._idSafe ? { id: filter.id } : filter;
    const n = await countWhere(collection, safeFilter);
    total += n;
    report.push({ collection, safeFilter, n, note });
    console.log(`  ${collection}: ${n}${note ? `  (${note})` : ""}`);
  }
  const seedState = await db.collection("state").findOne({ _id: "demoSeed" });
  if (seedState) { console.log(`  state/demoSeed flag: present, seeded at ${seedState.seededAt || "unknown time"}`); total += 1; }

  console.log(`\nTotal documents to delete: ${total}`);

  if (!apply) {
    console.log("\n[dry-run] Nothing has been deleted. Re-run with --apply to delete.");
    await client.close();
    return;
  }

  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question(`Type "${CONFIRM_PHRASE}" to delete, anything else to cancel: `, resolve));
  rl.close();
  if (answer.trim() !== CONFIRM_PHRASE) {
    console.log("Cancelled. Nothing was deleted.");
    await client.close();
    return;
  }

  let deleted = 0;
  for (const { collection, safeFilter, n } of report) {
    if (!n) continue;
    const result = await db.collection(collection).deleteMany(safeFilter);
    deleted += result.deletedCount;
  }
  if (seedState) { await db.collection("state").deleteOne({ _id: "demoSeed" }); deleted += 1; }
  console.log(`\nDone. Deleted ${deleted} document(s). Demo accounts, listings, and their data are gone.`);
  await client.close();
}

main().catch(err => {
  console.error("Purge failed before deleting anything:", err.codeName || err.name || "", err.message);
  process.exit(1);
});
