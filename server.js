const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const BUNDLED_DB_FILE = path.join(__dirname, "data", "db.json");
const DATA_DIR = process.env.OFFKAY_DATA_DIR || (process.env.VERCEL ? path.join(os.tmpdir(), "offkay-data") : path.join(__dirname, "data"));
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const LISTING_TYPES = ["Studio", "Shared", "En-suite", "Self-contained", "Apartment"];
const LISTING_STATUSES = ["active", "hidden"];
const EPOCH = "1970-01-01T00:00:00.000Z";

function loadDotEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch {}
}
loadDotEnvFile(path.join(__dirname, ".env.local"));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_BASE = "https://api.paystack.co";

const universities = [
  "University of Lagos","University of Ibadan","University of Nigeria, Nsukka","Obafemi Awolowo University",
  "Ahmadu Bello University","University of Benin","University of Ilorin","University of Abuja",
  "University of Port Harcourt","Federal University of Technology, Akure","Federal University of Technology, Minna",
  "Federal University of Technology, Owerri","University of Jos","University of Calabar","University of Uyo",
  "Bayero University Kano","Nnamdi Azikiwe University","Usmanu Danfodiyo University","University of Maiduguri",
  "Federal University Oye-Ekiti","Lagos State University","Olabisi Onabanjo University","Ekiti State University",
  "Adekunle Ajasin University","Delta State University","Rivers State University","Ambrose Alli University",
  "Benue State University","Kaduna State University","Kwara State University","Covenant University",
  "Babcock University","Afe Babalola University","Bowen University","Landmark University",
  "American University of Nigeria","Pan-Atlantic University","Redeemer's University","Lead City University",
  "Nile University of Nigeria","University of Medical Sciences, Ondo","Federal University of Agriculture, Abeokuta",
  "Michael Okpara University of Agriculture","Modibbo Adama University","Abubakar Tafawa Balewa University",
  "Federal University Dutse","Federal University Lafia","Federal University Lokoja","Federal University Kashere",
  "Alex Ekwueme Federal University"
];

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function seedDb() {
  const landlordId = "usr_landlord_demo";
  const tenantId = "usr_tenant_demo";
  const zainabId = "usr_zainab_demo";
  const now = new Date().toISOString();
  return {
    users: [
      {
        id: landlordId, name: "David Okonkwo", email: "landlord@demo.test",
        password: hashPassword("demo1234"), role: "landlord", phone: "08030000001",
        university: "University of Lagos", verified: true,
        bio: "Property owner offering verified student accommodation near campus.",
        createdAt: now
      },
      {
        id: tenantId, name: "Amara Obi", email: "tenant@demo.test",
        password: hashPassword("demo1234"), role: "tenant", phone: "08030000002",
        university: "University of Lagos", verified: true,
        bio: "Computer Science student. Quiet, tidy, and usually studying late.",
        budget: 500000, habits: ["Very tidy","Night owl","Quiet home"], createdAt: now
      },
      {
        id: zainabId, name: "Zainab Musa", email: "zainab@demo.test",
        password: hashPassword("demo1234"), role: "tenant", phone: "08030000003",
        university: "University of Lagos", verified: true,
        bio: "Mass Communication student looking to split a two-bedroom apartment around Akoka.",
        budget: 450000, habits: ["Very tidy","Night owl","Quiet home"], createdAt: now
      }
    ],
    sessions: [],
    listings: [
      {
        id:"lst_palm",ownerId:landlordId,title:"Palm Court Studio",university:"University of Lagos",
        area:"Akoka, Lagos",price:450000,type:"Studio",bedrooms:1,bathrooms:1,
        latitude:6.5158,longitude:3.3898,
        description:"Bright self-contained studio with steady water, prepaid electricity, security, and an eight-minute walk to campus.",
        amenities:["Steady water","Security","Prepaid meter","Wardrobe"],verified:true,status:"active",
        accent:"emerald",createdAt:now
      },
      {
        id:"lst_maple",ownerId:landlordId,title:"Maple Student Lodge",university:"University of Ibadan",
        area:"Agbowo, Ibadan",price:380000,type:"Shared",bedrooms:2,bathrooms:2,
        latitude:7.4433,longitude:3.9008,
        description:"A calm two-bedroom apartment designed for two students, close to the main gate and daily transport.",
        amenities:["Furnished","Wi-Fi ready","Fenced compound","Kitchen"],verified:true,status:"active",
        accent:"amber",createdAt:now
      },
      {
        id:"lst_green",ownerId:landlordId,title:"Green Nest En-suite",university:"University of Nigeria, Nsukka",
        area:"Odenigwe, Nsukka",price:520000,type:"En-suite",bedrooms:1,bathrooms:1,
        latitude:6.8683,longitude:7.4064,
        description:"Private en-suite room in a newly renovated student building with generator backup and caretaker support.",
        amenities:["Generator","Caretaker","Private bathroom","Parking"],verified:true,status:"active",
        accent:"blue",createdAt:now
      },
      {
        id:"lst_cedar",ownerId:landlordId,title:"Cedar House",university:"Obafemi Awolowo University",
        area:"Road 7, Ile-Ife",price:410000,type:"Shared",bedrooms:2,bathrooms:1,
        latitude:7.5180,longitude:4.5230,
        description:"Spacious shared apartment on a quiet street with direct transport to campus.",
        amenities:["Balcony","Kitchen","Water tank","Security"],verified:true,status:"active",
        accent:"rose",createdAt:now
      }
    ],
    saved: [{userId:tenantId,listingId:"lst_palm"}],
    conversations: [
      {id:"con_demo",memberIds:[tenantId,landlordId],listingId:"lst_palm",updatedAt:now,reads:{}}
    ],
    messages: [
      {id:"msg_1",conversationId:"con_demo",senderId:landlordId,text:"Hello Amara, the studio is still available. Would you like to schedule a viewing?",createdAt:new Date(Date.now()-3600000).toISOString()},
      {id:"msg_2",conversationId:"con_demo",senderId:tenantId,text:"Yes please. Is Saturday morning okay?",createdAt:new Date(Date.now()-3200000).toISOString()}
    ],
    bookings: [],
    inspections: [],
    reports: [],
    verifications: []
  };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = String(stored || "").split(":");
  if (!salt || !key) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const original = Buffer.from(key, "hex");
  return candidate.length === original.length && crypto.timingSafeEqual(candidate, original);
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const initial = process.env.VERCEL && fs.existsSync(BUNDLED_DB_FILE)
      ? fs.readFileSync(BUNDLED_DB_FILE, "utf8").replace(/^\uFEFF/, "")
      : JSON.stringify(seedDb(), null, 2);
    fs.writeFileSync(DB_FILE, initial);
  }
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, ""));
  db.users ||= [];
  db.sessions ||= [];
  db.listings ||= [];
  db.saved ||= [];
  db.conversations ||= [];
  db.messages ||= [];
  db.bookings ||= [];
  db.inspections ||= [];
  db.reports ||= [];
  db.verifications ||= [];
  db.conversations.forEach(conversation => { conversation.reads ||= {}; });
  const demoCoords = { lst_palm:[6.5158,3.3898], lst_maple:[7.4433,3.9008], lst_green:[6.8683,7.4064], lst_cedar:[7.5180,4.5230] };
  db.listings.forEach(listing => {
    if (demoCoords[listing.id] && !listing.latitude && !listing.longitude) {
      [listing.latitude, listing.longitude] = demoCoords[listing.id];
    }
  });
  db.bookings.forEach(booking => {
    if (!Array.isArray(booking.paymentShares) || booking.paymentShares.length !== booking.splitCount) {
      const base = Math.floor(booking.amount / booking.splitCount);
      booking.paymentShares = Array.from({ length: booking.splitCount }, (unused, index) => index === 0 ? booking.amount - base * (booking.splitCount - 1) : base);
    }
    booking.paidSlots ||= [];
    booking.paymentRefs ||= {};
    booking.shareToken ||= id("shk");
  });
  return db;
}

// Persistence layer. On Vercel the filesystem is ephemeral, so when MONGODB_URI
// is set the whole app state lives in one MongoDB document instead of db.json.
const USE_MONGODB = Boolean(process.env.MONGODB_URI);

let mongoDbPromise = null;
function mongoDb() {
  if (!mongoDbPromise) {
    const { MongoClient } = require("mongodb");
    mongoDbPromise = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 }).connect()
      .then(client => client.db(process.env.MONGODB_DB || "offkay"));
  }
  return mongoDbPromise;
}

async function loadDb() {
  if (!USE_MONGODB) return readDb();
  const database = await mongoDb();
  const [meta, users, sessions, listings, saved, conversations, messages, bookings, inspections, reports, verifications] = await Promise.all([
    database.collection("state").findOne({ _id: "counters" }),
    database.collection("users").find({}).toArray(),
    database.collection("sessions").find({}).toArray(),
    database.collection("listings").find({}).toArray(),
    database.collection("saved").find({}).toArray(),
    database.collection("conversations").find({}).toArray(),
    database.collection("messages").find({}).toArray(),
    database.collection("bookings").find({}).toArray(),
    database.collection("inspections").find({}).toArray(),
    database.collection("reports").find({}).toArray(),
    database.collection("verifications").find({}).toArray()
  ]);
  const db = readDbShape({
    users: users.map(({ _id, ...rest }) => rest),
    sessions: sessions.map(({ _id, ...rest }) => rest),
    listings: listings.map(({ _id, ...rest }) => rest),
    saved: saved.map(({ _id, ...rest }) => rest),
    conversations: conversations.map(({ _id, ...rest }) => rest),
    messages: messages.map(({ _id, ...rest }) => rest),
    bookings: bookings.map(({ _id, ...rest }) => rest),
    inspections: inspections.map(({ _id, ...rest }) => rest),
    reports: reports.map(({ _id, ...rest }) => rest),
    verifications: verifications.map(({ _id, ...rest }) => rest)
  });
  return db;
}

async function persistDb(db) {
  if (!USE_MONGODB) {
    await fs.promises.writeFile(DB_FILE, JSON.stringify(db, null, 2));
    return;
  }
  const database = await mongoDb();
  const collections = {
    users: db.users || [],
    sessions: db.sessions || [],
    listings: db.listings || [],
    saved: db.saved || [],
    conversations: db.conversations || [],
    messages: db.messages || [],
    bookings: db.bookings || [],
    inspections: db.inspections || [],
    reports: db.reports || [],
    verifications: db.verifications || []
  };
  const stableId = (name, item) => item.id
    || item.token
    || (name === "saved" && item.userId && item.listingId ? `${item.userId}:${item.listingId}` : null)
    || crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex");
  const writes = Object.entries(collections).map(([name, items]) => {
    if (!items.length) return Promise.resolve();
    const collection = database.collection(name);
    return collection.bulkWrite(items.map(item => ({
      replaceOne: { filter: { _id: stableId(name, item) }, replacement: { ...item, _id: stableId(name, item) }, upsert: true }
    })), { ordered: false });
  });
  await Promise.all(writes);
}

function readDbShape(db) {
  db.users ||= [];
  db.sessions ||= [];
  db.listings ||= [];
  db.saved ||= [];
  db.conversations ||= [];
  db.messages ||= [];
  db.bookings ||= [];
  db.inspections ||= [];
  db.reports ||= [];
  db.verifications ||= [];
  db.conversations.forEach(conversation => { conversation.reads ||= {}; });
  const demoCoords = { lst_palm:[6.5158,3.3898], lst_maple:[7.4433,3.9008], lst_green:[6.8683,7.4064], lst_cedar:[7.5180,4.5230] };
  db.listings.forEach(listing => {
    if (demoCoords[listing.id] && !listing.latitude && !listing.longitude) {
      [listing.latitude, listing.longitude] = demoCoords[listing.id];
    }
  });
  db.bookings.forEach(booking => {
    if (!Array.isArray(booking.paymentShares) || booking.paymentShares.length !== booking.splitCount) {
      const base = Math.floor(booking.amount / booking.splitCount);
      booking.paymentShares = Array.from({ length: booking.splitCount }, (unused, index) => index === 0 ? booking.amount - base * (booking.splitCount - 1) : base);
    }
    booking.paidSlots ||= [];
    booking.paymentRefs ||= {};
    booking.shareToken ||= id("shk");
  });
  return db;
}

// All API requests are serialized through one queue so every read-modify-write
// is atomic. This prevents the duplicate-account race on concurrent signups.
let apiChain = Promise.resolve();
function serializeApi(handler) {
  const run = apiChain.then(() => handler());
  apiChain = run.catch(() => {});
  return run;
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

// Privacy-safe profile shown to other users: no email, phone, or internal state.
function profileView(account) {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    university: account.university,
    verified: Boolean(account.verified),
    hosting: account.hosting === true || account.role === "landlord",
    bio: account.bio || "",
    habits: Array.isArray(account.habits) ? account.habits : [],
    budget: Number(account.budget || 0),
    memberSince: account.createdAt || null
  };
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";").filter(Boolean).map(part => {
      const index = part.indexOf("=");
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function currentUser(req, db) {
  const token = parseCookies(req).ch_session;
  if (!token) return null;
  const session = db.sessions.find(item => item.token === token && item.expiresAt > Date.now());
  return session ? db.users.find(user => user.id === session.userId) : null;
}

function canHost(user) {
  return user?.role === "landlord" || user?.hosting === true;
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff",
    "Referrer-Policy":"no-referrer",
    ...headers
  });
  res.end(JSON.stringify(payload));
}

function sessionCookie(req, token, maxAge) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = proto === "https" ? "; Secure" : "";
  return `ch_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function error(res, status, message) {
  return json(res, status, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let overflow = false;
    let drained = 0;
    req.on("data", chunk => {
      if (overflow) {
        drained += chunk.length;
        if (drained > 8_000_000) req.destroy();
        return;
      }
      body += chunk;
      if (body.length > 2_000_000) {
        overflow = true;
        body = "";
        reject(new Error("Request is too large"));
      }
    });
    req.on("end", () => {
      if (overflow) return;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) error(res, 401, "Please sign in to continue");
  return user;
}

function listingPayload(listing, db, user) {
  const owner = db.users.find(item => item.id === listing.ownerId);
  return {
    ...listing,
    owner: owner ? { id:owner.id, name:owner.name, verified:owner.verified } : null,
    saved: Boolean(user && db.saved.some(item => item.userId === user.id && item.listingId === listing.id))
  };
}

function conversationPayload(conversation, db, viewerId) {
  const otherId = conversation.memberIds.find(memberId => memberId !== viewerId);
  const other = db.users.find(item => item.id === otherId);
  const messages = db.messages.filter(message => message.conversationId === conversation.id);
  const last = [...messages].sort((a,b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const listing = conversation.listingId ? db.listings.find(item => item.id === conversation.listingId) : null;
  const readUpTo = conversation.reads?.[viewerId] || EPOCH;
  const unread = messages.filter(message => message.senderId !== viewerId && message.createdAt > readUpTo).length;
  return {
    id: conversation.id,
    listingId: conversation.listingId || null,
    listingTitle: listing ? listing.title : null,
    updatedAt: conversation.updatedAt,
    other: profileView(other),
    lastMessage: last || null,
    unread
  };
}

function removeUserFromDb(db, userId) {
  db.users = db.users.filter(user => user.id !== userId);
  db.sessions = db.sessions.filter(session => session.userId !== userId);
  db.listings = db.listings.filter(listing => listing.ownerId !== userId);
  db.saved = db.saved.filter(item => item.userId !== userId);
  db.bookings = db.bookings.filter(item => item.tenantId !== userId && item.ownerId !== userId);
  db.inspections = db.inspections.filter(item => item.tenantId !== userId && item.ownerId !== userId);
  db.reports = db.reports.filter(item => item.reportedBy !== userId);
  db.verifications = db.verifications.filter(item => item.userId !== userId);
  const removedConversations = new Set(
    db.conversations.filter(conversation => conversation.memberIds.includes(userId)).map(conversation => conversation.id)
  );
  db.conversations = db.conversations.filter(conversation => !conversation.memberIds.includes(userId));
  db.messages = db.messages.filter(message => !removedConversations.has(message.conversationId));
}

function requestUrl(req) {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  if (!host) return null;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const hostText = String(host);
  const local = hostText.startsWith("localhost") || hostText.startsWith("127.0.0.1");
  const proto = forwardedProto || (local ? "http" : "https");
  return `${proto}://${hostText}`;
}

async function paystackFetch(pathname, options = {}) {
  const response = await fetch(`${PAYSTACK_BASE}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function paystackWebhookSignatureValid(req, rawBody) {
  const header = String(req.headers["x-paystack-signature"] || "");
  if (!header || !PAYSTACK_SECRET_KEY) return false;
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(rawBody).digest("hex");
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

async function api(req, res, url) {
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";
  if (!rateLimit(`ip:${ip}`, 300, 60_000)) return error(res, 429, "Too many requests. Slow down a moment.");
  const db = await loadDb();
  if (db.sessions.some(session => session.expiresAt <= Date.now())) {
    db.sessions = db.sessions.filter(session => session.expiresAt > Date.now());
    await persistDb(db);
  }
  const user = currentUser(req, db);
  const method = req.method;
  const route = url.pathname;

  if (route === "/api/bootstrap" && method === "GET") {
    const listings = db.listings.filter(item => item.status === "active").map(item => listingPayload(item, db, user));
    const ownListings = user ? db.listings.filter(item => item.ownerId === user.id).map(item => listingPayload(item, db, user)) : [];
    const conversations = user ? db.conversations
      .filter(conversation => conversation.memberIds.includes(user.id))
      .map(conversation => conversationPayload(conversation, db, user.id))
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
    const bookings = user ? db.bookings
      .filter(item => item.tenantId === user.id || item.ownerId === user.id)
      .map(booking => {
        const listing = db.listings.find(item => item.id === booking.listingId);
        const tenant = db.users.find(item => item.id === booking.tenantId);
        return { ...booking, propertyTitle: listing ? listing.title : "Removed property", tenantName: tenant ? tenant.name : "Student" };
      }) : [];
    const inspections = user ? db.inspections.filter(item => item.tenantId === user.id || item.ownerId === user.id) : [];
    const roommateCandidates = user && user.role === "tenant" ? db.users
      .filter(item => item.id !== user.id && (item.role === "tenant" || item.hosting === true))
      .map(candidate => {
        const sameUniversity = candidate.university === user.university;
        const sharedHabits = (candidate.habits || []).filter(habit => (user.habits || []).includes(habit)).length;
        const budgetClose = user.budget && candidate.budget ? Math.abs(user.budget-candidate.budget)<=150000 : false;
        return {...profileView(candidate), score:Math.min(98,62+(sameUniversity?20:0)+(sharedHabits*5)+(budgetClose?6:0))};
      }).sort((a,b)=>b.score-a.score) : [];
    const verification = user ? db.verifications.filter(item => item.userId === user.id).at(-1) || null : null;
    const people = user ? db.users
      .filter(item => item.id !== user.id && (item.role === "tenant" || item.hosting === true))
      .map(item => profileView(item))
      .sort((a,b) => (a.university === user.university ? -1 : 1) - (b.university === user.university ? -1 : 1)) : [];
    return json(res, 200, {
      user: publicUser(user),
      universities: [...new Set(universities)].sort((a,b)=>a.localeCompare(b)),
      listings, ownListings, conversations, bookings, inspections, roommateCandidates, verification, people,
      paymentsEnabled: Boolean(PAYSTACK_SECRET_KEY)
    });
  }

  if (route === "/api/auth/signup" && method === "POST") {
    if (!rateLimit(`ip:${ip}:signup`, 10, 3_600_000)) return error(res, 429, "Too many sign-up attempts from this network. Try again later.");
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = body.role === "landlord" ? "landlord" : "tenant";
    if (name.length < 2 || name.length > 80) return error(res, 400, "Enter your full name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Enter a valid email address");
    if (password.length < 8) return error(res, 400, "Password must be at least 8 characters");
    if (db.users.some(item => item.email === email)) return error(res, 409, "An account with this email already exists. Try signing in instead.");
    const university = universities.includes(body.university) ? body.university : universities[0];
    const newUser = {
      id:id("usr"), name, email, password:hashPassword(password), role,
      phone:String(body.phone || "").replace(/[^\d+]/g,"").slice(0,20),
      university, verified:false, bio:"", budget:0, habits:[], createdAt:new Date().toISOString()
    };
    db.users.push(newUser);
    const token = id("ses");
    db.sessions.push({token,userId:newUser.id,expiresAt:Date.now()+SESSION_TTL});
    await new Promise(resolve => setTimeout(resolve, 0));
    await persistDb(db);
    return json(res, 201, {user:publicUser(newUser)}, {"Set-Cookie":sessionCookie(req, token, 2592000)});
  }

  if (route === "/api/auth/login" && method === "POST") {
    if (!rateLimit(`ip:${ip}:login`, 30, 15 * 60_000)) return error(res, 429, "Too many sign-in attempts. Wait a few minutes.");
    const body = await parseBody(req);
    const account = db.users.find(item => item.email === String(body.email || "").trim().toLowerCase());
    if (!account || !verifyPassword(body.password, account.password)) return error(res, 401, "Email or password is incorrect");
    const token = id("ses");
    db.sessions.push({token,userId:account.id,expiresAt:Date.now()+SESSION_TTL});
    await persistDb(db);
    return json(res, 200, {user:publicUser(account)}, {"Set-Cookie":sessionCookie(req, token, 2592000)});
  }

  if (route === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(req).ch_session;
    db.sessions = db.sessions.filter(item => item.token !== token);
    await persistDb(db);
    return json(res, 200, {ok:true}, {"Set-Cookie":sessionCookie(req, "", 0)});
  }

  if (route === "/api/auth/logout-all" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    db.sessions = db.sessions.filter(item => item.userId !== account.id);
    await persistDb(db);
    return json(res, 200, {ok:true}, {"Set-Cookie":sessionCookie(req, "", 0)});
  }

  if (route === "/api/account" && method === "DELETE") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    if (!verifyPassword(String(body.password || ""), account.password)) {
      return error(res, 403, "Enter your password to confirm account deletion");
    }
    removeUserFromDb(db, account.id);
    await persistDb(db);
    return json(res, 200, {ok:true}, {"Set-Cookie":sessionCookie(req, "", 0)});
  }

  if (route === "/api/profile" && method === "PATCH") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const fieldCaps = { name: 80, phone: 20, bio: 400 };
    ["name","phone","university","bio"].forEach(key => {
      if (body[key] !== undefined) account[key] = String(body[key]).trim().slice(0, fieldCaps[key] || 100);
    });
    if (body.budget !== undefined) account.budget = Math.max(0, Math.min(10_000_000, Number(body.budget) || 0));
    if (Array.isArray(body.habits)) account.habits = body.habits.slice(0,8).map(habit => String(habit).slice(0,40));
    await persistDb(db);
    return json(res, 200, {user:publicUser(account)});
  }

  if (route === "/api/host/activate" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    account.hosting = true;
    account.hostActivatedAt = new Date().toISOString();
    await persistDb(db);
    return json(res, 200, {user:publicUser(account)});
  }

  if (route === "/api/verification" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const nin = String(body.nin || "").replace(/\D/g,"");
    if (nin.length < 8) return error(res,400,"Enter a valid NIN before submitting verification");
    const verification = {
      id:id("ver"),userId:account.id,nin:nin.slice(0,20),idType:String(body.idType || "Student ID").slice(0,60),
      idCardImage:typeof body.idCardImage === "string" && body.idCardImage.startsWith("data:image/") ? body.idCardImage.slice(0,1_200_000) : null,
      supportDocument:typeof body.supportDocument === "string" && body.supportDocument.startsWith("data:image/") ? body.supportDocument.slice(0,1_200_000) : null,
      status:"manual_review",createdAt:new Date().toISOString()
    };
    db.verifications.push(verification);
    account.verificationStatus = "manual_review";
    await persistDb(db);
    return json(res,201,{verification,user:publicUser(account)});
  }

  if (route === "/api/listings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!canHost(account)) return error(res, 403, "Activate hosting before publishing a property");
    const body = await parseBody(req);
    if (!body.title || !body.area || !body.price) return error(res,400,"Title, area, and annual rent are required");
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 10000) return error(res,400,"Enter an annual rent of at least ₦10,000");
    const listing = {
      id:id("lst"),ownerId:account.id,title:String(body.title).trim().slice(0,120),
      university:universities.includes(body.university) ? body.university : account.university,
      area:String(body.area).trim().slice(0,120),
      price,type:LISTING_TYPES.includes(body.type) ? body.type : "Studio",
      bedrooms:Math.min(10,Math.max(1,Number(body.bedrooms) || 1)),
      bathrooms:Math.min(10,Math.max(1,Number(body.bathrooms) || 1)),
      description:String(body.description || "").trim().slice(0,2000),
      amenities:Array.isArray(body.amenities) ? body.amenities.map(String).slice(0,10) : [],
      photos:Array.isArray(body.photos) ? body.photos.filter(photo => typeof photo === "string" && photo.startsWith("data:image/")).slice(0,4) : [],
      latitude:Number(body.latitude || 0),longitude:Number(body.longitude || 0),
      source:"host",verified:false,status:"active",
      accent:["emerald","amber","blue","rose"][db.listings.length%4],
      createdAt:new Date().toISOString()
    };
    db.listings.unshift(listing);
    await persistDb(db);
    return json(res,201,{listing:listingPayload(listing,db,account)});
  }

  const listingMatch = route.match(/^\/api\/listings\/([^/]+)$/);
  if (listingMatch && method === "PATCH") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === listingMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId !== account.id) return error(res,403,"You cannot edit this property");
    const body = await parseBody(req);
    ["title","area","university","type","description"].forEach(key => {
      if (body[key] !== undefined) listing[key] = String(body[key]).trim();
    });
    if (body.status !== undefined) {
      if (!LISTING_STATUSES.includes(body.status)) return error(res,400,"Unknown listing status");
      listing.status = body.status;
    }
    ["price","bedrooms","bathrooms","latitude","longitude"].forEach(key => {
      if (body[key] !== undefined) listing[key] = Number(body[key]);
    });
    await persistDb(db);
    return json(res,200,{listing:listingPayload(listing,db,account)});
  }

  if (listingMatch && method === "DELETE") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === listingMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId !== account.id) return error(res,403,"You cannot delete this property");
    db.listings = db.listings.filter(item => item.id !== listing.id);
    db.saved = db.saved.filter(item => item.listingId !== listing.id);
    await persistDb(db);
    return json(res,200,{ok:true});
  }

  const inspectionMatch = route.match(/^\/api\/listings\/([^/]+)\/inspections$/);
  if (inspectionMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return error(res,403,"Only tenants can request an inspection");
    const listing = db.listings.find(item => item.id === inspectionMatch[1] && item.status === "active");
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId === account.id) return error(res,400,"This is your own property");
    const body = await parseBody(req);
    const inspection = {
      id:id("ins"),listingId:listing.id,tenantId:account.id,ownerId:listing.ownerId,
      preferredDate:String(body.preferredDate || "").slice(0,30),
      timeWindow:String(body.timeWindow || "Morning").slice(0,30),
      note:String(body.note || "").trim().slice(0,600),
      evidenceImage:typeof body.evidenceImage === "string" && body.evidenceImage.startsWith("data:image/") ? body.evidenceImage.slice(0,1_000_000) : null,
      status:"requested",createdAt:new Date().toISOString()
    };
    db.inspections.push(inspection);
    await persistDb(db);
    return json(res,201,{inspection});
  }

  if (route === "/api/reports" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!rateLimit(`user:${account.id}:reports`, 5, 3_600_000)) return error(res, 429, "Too many reports sent. Try again later.");
    const body = await parseBody(req);
    const listing = db.listings.find(item => item.id === body.listingId);
    if (!listing) return error(res,404,"Property not found");
    const category = String(body.category || "").trim();
    const detail = String(body.detail || "").trim();
    if (!category || detail.length < 8) return error(res,400,"Choose a concern and add a short description");
    const report = {
      id:id("rpt"),listingId:listing.id,reportedBy:account.id,category:category.slice(0,80),
      detail:detail.slice(0,1000),evidenceImage:typeof body.evidenceImage === "string" && body.evidenceImage.startsWith("data:image/") ? body.evidenceImage.slice(0,1_000_000) : null,
      status:"received",createdAt:new Date().toISOString()
    };
    db.reports.push(report);
    await persistDb(db);
    return json(res,201,{report});
  }

  const saveMatch = route.match(/^\/api\/listings\/([^/]+)\/save$/);
  if (saveMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === saveMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    const index = db.saved.findIndex(item => item.userId === account.id && item.listingId === saveMatch[1]);
    if (index >= 0) db.saved.splice(index,1); else db.saved.push({userId:account.id,listingId:saveMatch[1]});
    await persistDb(db);
    return json(res,200,{saved:index<0});
  }

  const contactMatch = route.match(/^\/api\/listings\/([^/]+)\/contact$/);
  if (contactMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === contactMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId === account.id) return error(res,400,"This is your own listing");
    let conversation = db.conversations.find(item => item.listingId === listing.id && item.memberIds.includes(account.id) && item.memberIds.includes(listing.ownerId));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,listing.ownerId],listingId:listing.id,updatedAt:new Date().toISOString(),reads:{}};
      db.conversations.push(conversation);
      db.messages.push({id:id("msg"),conversationId:conversation.id,senderId:account.id,text:`Hi, I am interested in ${listing.title}. Is it still available?`,createdAt:new Date().toISOString()});
    }
    await persistDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  const messagesMatch = route.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const conversation = db.conversations.find(item => item.id === messagesMatch[1] && item.memberIds.includes(account.id));
    if (!conversation) return error(res,404,"Conversation not found");
    const messages = db.messages.filter(item => item.conversationId === conversation.id).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    conversation.reads[account.id] = new Date().toISOString();
    await persistDb(db);
    return json(res,200,{conversation:conversationPayload(conversation, db, account.id),messages});
  }
  if (messagesMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const conversation = db.conversations.find(item => item.id === messagesMatch[1] && item.memberIds.includes(account.id));
    if (!conversation) return error(res,404,"Conversation not found");
    const body = await parseBody(req);
    const text = String(body.text || "").trim();
    if (!text) return error(res,400,"Message cannot be empty");
    const message = {id:id("msg"),conversationId:conversation.id,senderId:account.id,text:text.slice(0,2000),createdAt:new Date().toISOString()};
    db.messages.push(message);
    conversation.updatedAt = message.createdAt;
    conversation.reads[account.id] = message.createdAt;
    await persistDb(db);
    return json(res,201,{message});
  }

  if (route === "/api/users" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 80);
    const university = String(url.searchParams.get("university") || "").trim().slice(0, 120);
    const visible = db.users.filter(item => {
      if (item.id === account.id) return false;
      if (!(item.role === "tenant" || item.hosting === true)) return false;
      if (university && item.university !== university) return false;
      if (q) {
        const haystack = `${item.name} ${item.university || ""} ${(item.habits || []).join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    const people = visible.map(item => {
      const sameUniversity = item.university === account.university;
      const sharedHabits = (item.habits || []).filter(habit => (account.habits || []).includes(habit)).length;
      const budgetClose = account.budget && item.budget ? Math.abs(account.budget-item.budget)<=150000 : false;
      return {...profileView(item), score:Math.min(98,62+(sameUniversity?20:0)+(sharedHabits*5)+(budgetClose?6:0))};
    }).sort((a,b)=>b.score-a.score).slice(0, 60);
    return json(res,200,{people});
  }

  if (route === "/api/conversations/start" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const candidate = db.users.find(item => item.id === body.userId && (item.role === "tenant" || item.hosting === true));
    if (!candidate || candidate.id === account.id) return error(res,404,"Student not found");
    let conversation = db.conversations.find(item => !item.listingId && item.memberIds.includes(account.id) && item.memberIds.includes(candidate.id));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,candidate.id],listingId:null,updatedAt:new Date().toISOString(),reads:{}};
      db.conversations.push(conversation);
    }
    await persistDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  if (route === "/api/roommates" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return json(res,200,{matches:[]});
    const matches = db.users.filter(item => item.id !== account.id && (item.role === "tenant" || item.hosting === true)).map(candidate => {
      const sameUniversity = candidate.university === account.university;
      const sharedHabits = (candidate.habits || []).filter(habit => (account.habits || []).includes(habit)).length;
      const budgetClose = account.budget && candidate.budget ? Math.abs(account.budget-candidate.budget)<=150000 : false;
      return {...profileView(candidate),score:Math.min(98,62+(sameUniversity?20:0)+(sharedHabits*5)+(budgetClose?6:0))};
    }).sort((a,b)=>b.score-a.score);
    return json(res,200,{matches});
  }

  if (route === "/api/roommates/connect" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const candidate = db.users.find(item => item.id === body.userId && (item.role === "tenant" || item.hosting === true));
    if (!candidate || candidate.id === account.id) return error(res,404,"Student not found");
    let conversation = db.conversations.find(item => !item.listingId && item.memberIds.includes(account.id) && item.memberIds.includes(candidate.id));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,candidate.id],listingId:null,updatedAt:new Date().toISOString(),reads:{}};
      db.conversations.push(conversation);
      db.messages.push({id:id("msg"),conversationId:conversation.id,senderId:account.id,text:"Hi! Offkay matched us as potential roommates. Would you like to chat?",createdAt:new Date().toISOString()});
    }
    await persistDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  const userMatch = route.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const target = db.users.find(item => item.id === userMatch[1]);
    if (!target) return error(res,404,"User not found");
    return json(res,200,{user:profileView(target)});
  }

  if (route === "/api/bookings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!rateLimit(`user:${account.id}:bookings`, 10, 3_600_000)) return error(res, 429, "Too many booking attempts. Try again later.");
    if (account.role !== "tenant") return error(res,403,"Only tenant accounts can book a property");
    const body = await parseBody(req);
    const listing = db.listings.find(item => item.id === body.listingId && item.status === "active");
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId === account.id) return error(res,400,"You cannot book your own property");
    const existing = db.bookings.find(item => item.listingId === listing.id && item.tenantId === account.id && (item.status === "awaiting_payment" || item.status === "paid"));
    if (existing) return error(res,409,"You already have an active booking for this property. Check it in your profile.");
    const splitCount = Math.min(4, Math.max(1, Math.round(Number(body.splitCount) || 1)));
    const base = Math.floor(listing.price / splitCount);
    const paymentShares = Array.from({ length: splitCount }, (unused, index) => index === 0 ? listing.price - base * (splitCount - 1) : base);
    const booking = {
      id:id("bkg"),listingId:listing.id,tenantId:account.id,ownerId:listing.ownerId,
      amount:listing.price,platformFee:0,splitCount,paymentShares,
      paymentShare:paymentShares[0],paidSlots:[],paymentRefs:{},shareToken:id("shk"),
      status:"awaiting_payment",createdAt:new Date().toISOString()
    };
    db.bookings.push(booking);
    await persistDb(db);
    return json(res,201,{booking});
  }

  const payMatch = route.match(/^\/api\/bookings\/([^/]+)\/confirm-payment$/);
  if (payMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const booking = db.bookings.find(item => item.id === payMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res,404,"Booking not found");
    if (booking.status === "paid") return json(res,200,{booking});
    if (PAYSTACK_SECRET_KEY) return error(res,403,"Real payments are enabled - complete checkout on Paystack instead");
    booking.paidSlots ||= [];
    if (!booking.paidSlots.includes(0)) booking.paidSlots.push(0);
    if (booking.paidSlots.length >= booking.splitCount) {
      booking.status = "paid";
      booking.paidAt = new Date().toISOString();
      booking.reference = `HH-${Date.now()}`;
    }
    await persistDb(db);
    return json(res,200,{booking});
  }

  const shareMatch = route.match(/^\/api\/bookings\/([^/]+)\/share$/);
  if (shareMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const booking = db.bookings.find(item => item.id === shareMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res,404,"Booking not found");
    if (booking.splitCount <= 1) return error(res,400,"This booking is not split - there are no roommate shares to invite");
    if (booking.status === "paid") return error(res,409,"This booking is already fully paid");
    const origin = requestUrl(req);
    const links = Array.from({ length: booking.splitCount }, (unused, index) => ({
      slot: index,
      amount: booking.paymentShares[index],
      url: `${origin}/payment-callback.html?ref=OFFKAY-${booking.id}-${booking.shareToken}&slot=${index}`
    }));
    return json(res,200,{booking,links:links.slice(1)});
  }

  const initMatch = route.match(/^\/api\/bookings\/([^/]+)\/pay\/initialize$/);
  if (initMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!PAYSTACK_SECRET_KEY) return error(res, 503, "Payments are not configured on this server yet");
    const booking = db.bookings.find(item => item.id === initMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res, 404, "Booking not found");
    if (booking.status === "paid") return error(res, 409, "This booking is already paid");
    const body = await parseBody(req);
    const slotRaw = Number(body.slot);
    const slot = Number.isInteger(slotRaw) && slotRaw >= 0 && slotRaw < booking.splitCount ? slotRaw : 0;
    booking.paidSlots ||= [];
    if (booking.paidSlots.includes(slot)) return error(res, 409, "This share has already been paid");
    const shareAmount = booking.paymentShares[slot];
    const origin = requestUrl(req);
    if (!origin) return error(res, 400, "Cannot determine the request origin");
    const reference = `OFFKAY-${booking.id}-${booking.shareToken}-${slot}`;
    const { status, payload } = await paystackFetch("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: account.email,
        amount: shareAmount * 100,
        reference,
        currency: "NGN",
        callback_url: `${origin}/payment-callback.html`,
        metadata: { bookingId: booking.id, userId: account.id, splitCount: booking.splitCount, slot }
      })
    });
    if (!status || !payload?.status || !payload?.data?.authorization_url) {
      console.error("Paystack initialize failed:", payload?.message || payload);
      return error(res, 502, payload?.message || "Paystack rejected the payment request");
    }
    booking.paymentRefs[slot] = reference;
    booking.paymentStatus = "initializing";
    await persistDb(db);
    return json(res, 200, { authorizationUrl: payload.data.authorization_url, reference, slot, amount: shareAmount });
  }

  const verifyMatch = route.match(/^\/api\/bookings\/([^/]+)\/pay\/verify$/);
  if (verifyMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const booking = db.bookings.find(item => item.id === verifyMatch[1]);
    if (!booking) return error(res, 404, "Booking not found");
    const isOwner = booking.tenantId === account.id;
    const body = await parseBody(req);
    const reference = typeof body.reference === "string" ? body.reference.slice(0, 200) : "";
    const slotRaw = Number(body.slot);
    const slot = Number.isInteger(slotRaw) && slotRaw >= 0 && slotRaw < booking.splitCount ? slotRaw : null;
    if (!isOwner && !(reference && booking.shareToken && reference.includes(booking.shareToken))) {
      return error(res, 404, "Booking not found");
    }
    booking.paidSlots ||= [];
    if (booking.status === "paid") return json(res, 200, { booking, alreadyPaid: true });
    const verifySlot = slot !== null && !booking.paidSlots.includes(slot) ? slot
      : booking.splitCount === 1 && !booking.paidSlots.includes(0) ? 0 : null;
    if (verifySlot === null) return json(res, 200, { booking, alreadyPaid: booking.paidSlots.length >= booking.splitCount });
    const expectedRef = booking.paymentRefs?.[verifySlot] || (booking.splitCount === 1 ? booking.paymentReference : null);
    if (!expectedRef) return error(res, 400, "No payment was started for this share");
    const { status, payload } = await paystackFetch(`/transaction/verify/${encodeURIComponent(expectedRef)}`);
    const transaction = payload?.data;
    const paid = Boolean(status && payload?.status && transaction?.status === "success");
    if (paid && transaction.amount !== booking.paymentShares[verifySlot] * 100) {
      console.error("Paystack amount mismatch:", transaction.amount, "expected", booking.paymentShares[verifySlot] * 100);
      return error(res, 400, "Payment amount does not match this booking share");
    }
    if (!paid) {
      booking.paymentStatus = transaction?.status || "pending";
      await persistDb(db);
      return error(res, 402, "Payment is not complete yet. If you just paid, give it a moment and try again.");
    }
    booking.paidSlots.push(verifySlot);
    if (!booking.paymentRefs) booking.paymentRefs = {};
    booking.paymentRefs[verifySlot] = expectedRef;
    booking.paymentStatus = "success";
    if (booking.paidSlots.length >= booking.splitCount) {
      booking.status = "paid";
      booking.paidAt = new Date(transaction.paid_at || Date.now()).toISOString();
      booking.reference = expectedRef;
      booking.paystackTransactionId = transaction.id;
    }
    await persistDb(db);
    return json(res, 200, { booking });
  }

  if (route === "/api/payments/webhook" && method === "POST") {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 500_000) return error(res, 413, "Payload too large");
    }
    const rawBody = Buffer.concat(chunks);
    if (!paystackWebhookSignatureValid(req, rawBody)) return error(res, 401, "Invalid webhook signature");
    let event = null;
    try { event = JSON.parse(rawBody.toString("utf8")); } catch {}
    if (event?.event === "charge.success" && event?.data?.reference) {
      const refText = String(event.data.reference);
      const booking = db.bookings.find(item => refText.startsWith(`OFFKAY-${item.id}-`) || item.paymentReference === refText);
      if (booking) {
        const slotMatch = refText.match(/-(\d+)$/);
        const slot = slotMatch ? Number(slotMatch[1]) : 0;
        const shareAmount = Array.isArray(booking.paymentShares) ? booking.paymentShares[slot] : booking.amount;
        booking.paidSlots ||= [];
        if (booking.status !== "paid" && !booking.paidSlots.includes(slot) && event.data.amount === shareAmount * 100) {
          booking.paidSlots.push(slot);
          if (!booking.paymentRefs) booking.paymentRefs = {};
          booking.paymentRefs[slot] = refText;
          booking.paymentStatus = "success";
          if (booking.paidSlots.length >= booking.splitCount) {
            booking.status = "paid";
            booking.paidAt = new Date(event.data.paid_at || Date.now()).toISOString();
            booking.reference = refText;
            booking.paystackTransactionId = event.data.id;
          }
          await persistDb(db);
        }
      }
    }
    return json(res, 200, { received: true });
  }

  return error(res,404,"API route not found");
}

const mime = {
  ".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"
};

function serveStatic(req,res,url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return error(res,400,"Bad request"); }
  if (pathname === "/") pathname = "/index.html";
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) return error(res,403,"Forbidden");
  fs.stat(requested,(err,stats)=>{
    if (err || !stats.isFile()) {
      const index = path.join(PUBLIC_DIR,"index.html");
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","X-Content-Type-Options":"nosniff"});
      return fs.createReadStream(index).pipe(res);
    }
    res.writeHead(200,{"Content-Type":mime[path.extname(requested)] || "application/octet-stream","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});
    fs.createReadStream(requested).pipe(res);
  });
}

ensureDb();
async function handler(req,res) {
  const url = new URL(req.url,`http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await serializeApi(() => api(req,res,url));
    return serveStatic(req,res,url);
  } catch (err) {
    console.error(err);
    if (err.message === "Request is too large") return error(res, 413, "Request is too large");
    return error(res,500,err.message === "Invalid JSON" ? err.message : "Something went wrong");
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT,HOST,()=>{
    console.log(`Offkay is running at http://${HOST}:${PORT}`);
    console.log("Tenant demo: tenant@demo.test / demo1234");
    console.log("Landlord demo: landlord@demo.test / demo1234");
  });
}

module.exports = server;
module.exports.handler = handler;
