"use strict";
/* Minimal file-backed fake MongoDB driver for tests. Activated only when
   OFFKAY_FAKE_MONGO=1; the require("mongodb") call then resolves to this
   module. Implements exactly the surface server.js uses: collection.find()
   .toArray(), findOne (with projection), bulkWrite replaceOne-upserts,
   deleteMany({ _id: { $in } }), admin().command({ ping }). Persisted to a
   JSON file so a separate process can assert on the stored documents. */
const fs = require("node:fs");
const path = require("node:path");

const FILE = process.env.OFFKAY_FAKE_MONGO_FILE || path.join(require("node:os").tmpdir(), "offkay-fake-mongo.json");
// Optional per-operation latency to simulate a remote cluster (e.g. Atlas RTT)
// in flow measurements. Applied to cursor materialization and writes.
const OP_DELAY_MS = Number(process.env.OFFKAY_FAKE_MONGO_DELAY_MS || 0);
const delay = () => (OP_DELAY_MS ? new Promise(r => setTimeout(r, OP_DELAY_MS)) : Promise.resolve());
let store = { collections: {} };
// OFFKAY_FAKE_MONGO_SHARED=1: re-read the file before every operation so two
// server processes behave like two deployment instances sharing one cluster.
const SHARED = process.env.OFFKAY_FAKE_MONGO_SHARED === "1";
function reloadIfShared() {
  if (!SHARED) return;
  // Mutate IN PLACE: reassigning the store object would orphan mutations
  // from concurrent in-flight operations sharing the same module instance.
  try { store.collections = JSON.parse(fs.readFileSync(FILE, "utf8")).collections || {}; }
  catch { store.collections = {}; }
}
if (fs.existsSync(FILE)) {
  try { store = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { store = { collections: {} }; }
}
let saveQueued = false;
function save() {
  // Shared mode is used by multi-instance regression tests: a debounced flush
  // can serialize a store state from AFTER a later reload, silently dropping
  // writes. Write synchronously there; every op is reload->mutate->save with
  // no awaits in between, so ops stay atomic.
  if (SHARED) { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch {} return; }
  if (saveQueued) return;
  saveQueued = true;
  process.nextTick(() => {
    saveQueued = false;
    try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch {}
  });
}
function coll(name) {
  if (!store.collections[name]) store.collections[name] = [];
  return store.collections[name];
}
function matches(doc, filter) {
  if (!filter || Object.keys(filter).length === 0) return true;
  return Object.entries(filter).every(([key, cond]) => {
    if (cond && typeof cond === "object" && !Array.isArray(cond) && cond.$in) return cond.$in.includes(doc[key]);
    return doc[key] === cond;
  });
}
function cursor(docs) {
  return { toArray: async () => { await delay(); return docs.map(d => ({ ...d })); }, sort: () => cursor(docs), limit: () => cursor(docs) };
}
function makeCollection(name) {
  return {
    find(filter, options) {
      reloadIfShared();
      let docs = coll(name).filter(d => matches(d, filter));
      const proj = options?.projection || {};
      if (proj.dataUrl === 0) docs = docs.map(d => { const c = { ...d }; delete c.dataUrl; return c; });
      return cursor(docs);
    },
    async findOne(filter, options) {
      await delay();
      reloadIfShared();
      const doc = coll(name).find(d => matches(d, filter));
      if (!doc) return null;
      const copy = { ...doc };
      if (options?.projection?.dataUrl === 0) delete copy.dataUrl;
      return copy;
    },
    async bulkWrite(ops) {
      await delay();
      reloadIfShared();
      for (const op of ops) {
        if (op.replaceOne) {
          const list = coll(name);
          const idx = list.findIndex(d => d._id === op.replaceOne.filter._id);
          if (idx >= 0) list[idx] = { ...op.replaceOne.replacement };
          else list.push({ ...op.replaceOne.replacement });
        }
      }
      save();
      return { upsertedCount: ops.length, modifiedCount: 0 };
    },
    async deleteMany(filter) {
      await delay();
      reloadIfShared();
      const list = coll(name);
      const before = list.length;
      store.collections[name] = list.filter(d => !matches(d, filter));
      save();
      return { deletedCount: before - store.collections[name].length };
    },
    async replaceOne(filter, replacement, options = {}) {
      await delay();
      reloadIfShared();
      const list = coll(name);
      const idx = list.findIndex(d => matches(d, filter));
      let result;
      if (idx >= 0) { list[idx] = { ...replacement }; result = { matchedCount: 1, upsertedId: null }; }
      else if (options.upsert) { list.push({ ...replacement }); result = { matchedCount: 0, upsertedId: replacement._id }; }
      else result = { matchedCount: 0, upsertedId: null };
      save();
      return result;
    },
    async deleteOne(filter) {
      await delay();
      reloadIfShared();
      const list = coll(name);
      const idx = list.findIndex(d => matches(d, filter));
      if (idx >= 0) { list.splice(idx, 1); save(); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
    async countDocuments(filter) { reloadIfShared(); return coll(name).filter(d => matches(d, filter)).length; },
    async insertOne(doc) { reloadIfShared(); coll(name).push({ ...doc }); save(); return {}; }
  };
}
function makeDb() {
  return {
    collection: name => makeCollection(name),
    admin: () => ({ command: async () => ({ ok: 1 }) })
  };
}
class FakeMongoClient {
  constructor() {}
  async connect() { return this; }
  db() { return makeDb(); }
  async close() {}
}
class FakeMongoError extends Error {}

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "mongodb" && process.env.OFFKAY_FAKE_MONGO === "1") {
    return { MongoClient: FakeMongoClient, MongoError: FakeMongoError };
  }
  return originalLoad.apply(this, arguments);
};
