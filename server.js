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
loadDotEnvFile(path.join(__dirname, ".env"));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

/* ---- Auth additions ------------------------------------------------------
   Password reset emails are sent through Resend when RESEND_API_KEY is set.
   In dev (no key) reset emails are logged to the server console so the full
   flow is testable without any external account.
   Google OAuth uses the plain OAuth 2.0 code flow against GOOGLE_CLIENT_ID +
   GOOGLE_CLIENT_SECRET (create OAuth credentials at console.cloud.google.com
   with the app origin registered as an Authorized redirect URI). */
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "Offkay <onboarding@resend.dev>";
const RESET_TOKEN_TTL = 1000 * 60 * 30; // 30 minutes
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

async function sendPasswordResetEmail(to, resetUrl) {
  const subject = "Reset your Offkay password";
  const text = `You asked to reset your Offkay password. Open this link within 30 minutes to choose a new one:\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore the email - your password stays unchanged.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#14231d">
    <p style="font-size:15px;line-height:1.6">Hi,</p>
    <p style="font-size:15px;line-height:1.6">You asked to reset your Offkay password. Tap the button below within <b>30 minutes</b> to choose a new one.</p>
    <p style="margin:26px 0"><a href="${resetUrl}" style="background:#0d7a56;color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:12px;font-weight:700;display:inline-block">Choose a new password</a></p>
    <p style="font-size:13px;line-height:1.6;color:#5b6b63">If the button does not work, copy this link into your browser:<br>${resetUrl}</p>
    <p style="font-size:13px;line-height:1.6;color:#5b6b63">If you did not request a reset, ignore this email - your password stays unchanged.</p>
  </div>`;
  if (!RESEND_API_KEY) {
    console.log(`[password-reset] RESEND_API_KEY not set - dev delivery. Reset link for ${to}: ${resetUrl}`);
    return { delivered: false, delivery: "skipped" };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, text, html })
    });
    if (!response.ok) {
      // Logged WITHOUT any credential material: status code + provider message
      // excerpt only. The API key itself never appears in logs.
      console.error("Resend rejected the reset email:", response.status, (await response.text().catch(() => "")).slice(0, 300));
      return { delivered: false, delivery: "failed" };
    }
    const payload = await response.json().catch(() => ({}));
    return { delivered: true, delivery: "sent", id: payload?.id };
  } catch (err) {
    console.error("Resend reset email request failed:", err?.message || err);
    return { delivered: false, delivery: "failed" };
  }
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "offkay-admin-dev";
const NIN_KEY = crypto.createHash("sha256").update(process.env.NIN_ENCRYPTION_KEY || ADMIN_TOKEN).digest();
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

/* ---- Geography ----------------------------------------------------------
   Real coordinates for every supported campus. Distances/ETAs are always
   calculated from these stored coordinates — never hardcoded per property. */
const UNIVERSITY_LOCATIONS = {
  "University of Lagos": { lat: 6.5158, lng: 3.3898 },
  "University of Ibadan": { lat: 7.4433, lng: 3.9008 },
  "University of Nigeria, Nsukka": { lat: 6.8682, lng: 7.4106 },
  "Obafemi Awolowo University": { lat: 7.5181, lng: 4.5237 },
  "Ahmadu Bello University": { lat: 11.1502, lng: 7.6494 },
  "University of Benin": { lat: 6.3986, lng: 5.6247 },
  "University of Ilorin": { lat: 8.4799, lng: 4.5418 },
  "University of Abuja": { lat: 8.9583, lng: 7.2211 },
  "University of Port Harcourt": { lat: 4.9019, lng: 6.9213 },
  "Federal University of Technology, Akure": { lat: 7.2986, lng: 5.1341 },
  "Federal University of Technology, Minna": { lat: 9.5618, lng: 6.5471 },
  "Federal University of Technology, Owerri": { lat: 5.3866, lng: 7.0366 },
  "University of Jos": { lat: 9.2997, lng: 9.8652 },
  "University of Calabar": { lat: 4.9644, lng: 8.3414 },
  "University of Uyo": { lat: 5.0333, lng: 7.9333 },
  "Bayero University Kano": { lat: 11.9776, lng: 8.4764 },
  "Nnamdi Azikiwe University": { lat: 6.2483, lng: 7.1407 },
  "Usmanu Danfodiyo University": { lat: 13.0646, lng: 5.2342 },
  "University of Maiduguri": { lat: 11.8333, lng: 13.1511 },
  "Federal University Oye-Ekiti": { lat: 7.8021, lng: 5.3133 },
  "Lagos State University": { lat: 6.4698, lng: 3.1996 },
  "Olabisi Onabanjo University": { lat: 6.9167, lng: 3.5000 },
  "Ekiti State University": { lat: 7.6494, lng: 5.2214 },
  "Adekunle Ajasin University": { lat: 7.2833, lng: 5.1333 },
  "Delta State University": { lat: 6.6804, lng: 6.2164 },
  "Rivers State University": { lat: 4.8083, lng: 7.0128 },
  "Ambrose Alli University": { lat: 6.7404, lng: 6.1194 },
  "Benue State University": { lat: 7.7333, lng: 8.5167 },
  "Kaduna State University": { lat: 10.5222, lng: 7.4383 },
  "Kwara State University": { lat: 8.3986, lng: 4.5364 },
  "Covenant University": { lat: 6.6718, lng: 3.1583 },
  "Babcock University": { lat: 6.8937, lng: 3.7098 },
  "Afe Babalola University": { lat: 7.5925, lng: 5.2336 },
  "Bowen University": { lat: 7.8463, lng: 4.1861 },
  "Landmark University": { lat: 8.1378, lng: 5.1044 },
  "American University of Nigeria": { lat: 9.2903, lng: 12.4861 },
  "Pan-Atlantic University": { lat: 6.4413, lng: 3.4712 },
  "Redeemer's University": { lat: 6.8158, lng: 3.4750 },
  "Lead City University": { lat: 7.3750, lng: 3.8581 },
  "Nile University of Nigeria": { lat: 9.0714, lng: 7.4114 },
  "University of Medical Sciences, Ondo": { lat: 7.1000, lng: 4.8333 },
  "Federal University of Agriculture, Abeokuta": { lat: 7.1557, lng: 3.3450 },
  "Michael Okpara University of Agriculture": { lat: 5.6197, lng: 7.6119 },
  "Modibbo Adama University": { lat: 10.2844, lng: 11.3633 },
  "Abubakar Tafawa Balewa University": { lat: 10.3158, lng: 9.8411 },
  "Federal University Dutse": { lat: 11.7061, lng: 9.3369 },
  "Federal University Lafia": { lat: 8.5833, lng: 8.5333 },
  "Federal University Lokoja": { lat: 7.8000, lng: 6.7333 },
  "Federal University Kashere": { lat: 9.6333, lng: 11.0500 },
  "Alex Ekwueme Federal University": { lat: 5.8606, lng: 7.9839 }
};

const EARTH_RADIUS_KM = 6371.0088;
const ROUTING_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
const routingCache = new Map();

// Great-circle distance between two coordinates in km.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function formatDistance(km) {
  if (!Number.isFinite(km) || km < 0) return null;
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${(Math.round(km * 10) / 10).toFixed(1)} km`;
}

// Estimated travel time from straight-line distance. Only used when no
// routing provider is configured — a real Directions/OSRM response replaces
// this estimate without any property-system changes.
function estimateDriveMinutes(km) {
  if (!Number.isFinite(km)) return null;
  if (km <= 0.8) return Math.max(2, Math.round(km * 14));
  if (km <= 3) return Math.round(4 + km * 4);
  if (km <= 10) return Math.round(8 + km * 3);
  return Math.round(15 + km * 2.2);
}

function formatEta(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return `${Math.max(1, Math.round(minutes))} min`;
}

function listingHasCoords(listing) {
  return Number.isFinite(Number(listing.latitude)) && Number.isFinite(Number(listing.longitude))
    && Number(listing.latitude) !== 0 && Number(listing.longitude) !== 0;
}

function proximityPayload(listing) {
  const uni = UNIVERSITY_LOCATIONS[listing.university];
  if (!uni || !listingHasCoords(listing)) return null;
  const km = haversineKm(Number(listing.latitude), Number(listing.longitude), uni.lat, uni.lng);
  return {
    university: listing.university,
    destination: { lat: uni.lat, lng: uni.lng },
    distanceText: formatDistance(km),
    etaText: formatEta(estimateDriveMinutes(km)),
    distanceKm: Math.round(km * 100) / 100,
    provider: "estimate",
    approximate: true
  };
}

function fetchJson(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Routing request timed out")), timeoutMs);
    fetch(url)
      .then(async response => {
        clearTimeout(timer);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        resolve(await response.json());
      })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

// Real road distance/ETA via a routing provider, with a 30-minute cache.
// Tries Google Directions (GOOGLE_MAPS_API_KEY), then OSRM (OSRM_BASE_URL),
// then returns null so callers fall back to the straight-line estimate.
async function routeEtaKm(origin, destination) {
  const key = `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}|${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
  const cached = routingCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const googleKey = process.env.GOOGLE_MAPS_API_KEY || "";
  if (googleKey) {
    try {
      const raw = await fetchJson(`https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}`
        + `&destination=${destination.lat},${destination.lng}&mode=driving&key=${encodeURIComponent(googleKey)}`);
      const leg = raw?.routes?.[0]?.legs?.[0];
      if (leg) {
        const value = { provider: "google_directions", distanceKm: (leg.distance?.value || 0) / 1000, durationMinutes: (leg.duration?.value || 0) / 60, approximate: false };
        routingCache.set(key, { value, expiresAt: Date.now() + ROUTING_CACHE_TTL });
        return value;
      }
      console.error("Google Directions returned no route:", raw?.status, raw?.error_message || "");
    } catch (err) { console.error("Google Directions request failed:", err.message); }
  }

  const osrmBase = (process.env.OSRM_BASE_URL || "").replace(/\/$/, "");
  if (osrmBase) {
    try {
      const raw = await fetchJson(`${osrmBase}/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=false`);
      const route = raw?.routes?.[0];
      if (raw?.code === "Ok" && route) {
        const value = { provider: "osrm", distanceKm: (route.distance || 0) / 1000, durationMinutes: (route.duration || 0) / 60, approximate: false };
        routingCache.set(key, { value, expiresAt: Date.now() + ROUTING_CACHE_TTL });
        return value;
      }
      console.error("OSRM returned no route:", raw?.code || raw?.message || "");
    } catch (err) { console.error("OSRM request failed:", err.message); }
  }

  return null;
}

async function proximityPayloadAsync(listing) {
  const base = proximityPayload(listing);
  if (!base) return null;
  const uni = UNIVERSITY_LOCATIONS[listing.university];
  const route = await routeEtaKm({ lat: Number(listing.latitude), lng: Number(listing.longitude) }, { lat: uni.lat, lng: uni.lng });
  if (!route) return base;
  return {
    ...base,
    distanceText: formatDistance(route.distanceKm) || base.distanceText,
    etaText: formatEta(route.durationMinutes) || base.etaText,
    distanceKm: Math.round(route.distanceKm * 100) / 100,
    provider: route.provider,
    approximate: route.approximate
  };
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
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
      : JSON.stringify(EMPTY_DB(), null, 2);
    fs.writeFileSync(DB_FILE, initial);
  }
}

// A brand-new file-mode database starts completely empty. Real data only.
// (Test suites provision their own fixtures through the public API.)
function EMPTY_DB() {
  return {
    users: [], sessions: [], listings: [], saved: [], conversations: [],
    messages: [], bookings: [], inspections: [], reports: [],
    verifications: [], notifications: [], connections: []
  };
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
  db.notifications ||= [];
  db.connections ||= [];
  db.passwordResets ||= [];
  db.conversations.forEach(conversation => { conversation.reads ||= {}; });
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
// File mode on a serverless/ephemeral filesystem cannot retain writes between
// requests. Signup must not report success when persistence cannot be trusted.
const EPHEMERAL_FS = !USE_MONGODB && Boolean(process.env.VERCEL);

let mongoDbPromise = null;
function mongoDb() {
  if (!mongoDbPromise) {
    const { MongoClient } = require("mongodb");
    mongoDbPromise = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      socketTimeoutMS: 20_000,
      retryWrites: true
    }).connect()
      .then(client => client.db(process.env.MONGODB_DB || "offkay"))
      .catch(err => { mongoDbPromise = null; throw err; });
  }
  return mongoDbPromise;
}

// Static checks on the connection string that catch common copy-paste
// mistakes instantly, without connecting and without exposing the value.
function lintMongoUri(uri) {
  if (/<(db_)?(password|username)>/i.test(uri)) {
    return { code: "placeholder-credentials", hint: "The connection string still contains <db_password> - replace it with the real database user's password from Atlas > Database Access, keeping everything else exactly as copied (no angle brackets)." };
  }
  if (/^["'`]|["'`]\s*$|^\s+|\s+$/.test(uri)) {
    return { code: "quoting", hint: "MONGODB_URI has stray quotes or spaces around it - in Vercel > Settings > Environment Variables, save the value with nothing before mongodb+srv:// or after the last character." };
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(uri.trim())) {
    return { code: "invalid scheme", hint: "MONGODB_URI must start with mongodb+srv:// - re-copy it from Atlas > Connect > Drivers." };
  }
  if (/[\r\n]|\s{2,}/.test(uri.trim())) {
    return { code: "line-break in uri", hint: "The connection string contains a line break or double space - paste it as one unbroken line." };
  }
  return null;
}

// Maps a Mongo driver failure to { code, hint } — user-facing diagnostics
// without ever leaking credentials or connection-string details.
function classifyDbError(lastError) {
  const reason = String(lastError?.message || lastError?.code || "").toLowerCase();
  let hint = "In Atlas, open Network Access and allow connections from anywhere (0.0.0.0/0), then refresh.";
  if (/must be uri|uri encoded/.test(reason)) hint = "Your database password contains special characters like @ or : - re-copy the connection string from Atlas > Connect > Drivers so it arrives pre-escaped.";
  else if (/parseerror|invalid connection string/.test(reason)) hint = "MONGODB_URI could not be parsed - re-copy it from Atlas > Connect > Drivers on one line, no quotes or spaces around it.";
  else if (/auth|sasl|illegal|username|password/.test(reason)) hint = "The database username or password in MONGODB_URI is wrong - re-copy the connection string from Atlas.";
  else if (/srv|querysrv|enotfound|getaddrinfo|dns/.test(reason)) hint = "The cluster hostname could not be resolved - re-copy the connection string from Atlas.";
  const codeMatch = String([lastError?.code, lastError?.codeName, lastError?.message].filter(Boolean).join(" ")).match(/(querySrv \w+|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ESERVFAIL|authentication failed|bad auth|illegal scheme|invalid scheme|MongoParseError|invalid connection string|must be URI encoded|tlsv\d+|SSL[ \w]+|connection closed|timed out)/i);
  const code = String(lastError?.codeName || lastError?.code || (codeMatch && codeMatch[0]) || "unknown").slice(0, 48);
  return { hint, code };
}

async function loadDb() {
  if (!USE_MONGODB) {
    const db = readDb();
    ensureCoreAdminRoles(db);
    return db;
  }
  const lint = lintMongoUri(process.env.MONGODB_URI);
  if (lint) {
    const boom = new Error(`Database connection failed. ${lint.hint} [code: ${lint.code}]`);
    boom.status = 503;
    throw boom;
  }
  let database = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !database; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 300));
    try {
      database = await Promise.race([
        mongoDb(),
        new Promise((unused, reject) => setTimeout(() => reject(Object.assign(new Error("connection timed out after 6s"), { code: "ETIMEDOUT" })), 6_000))
      ]);
    } catch (err) {
      lastError = err;
    }
  }
  if (!database) {
    const { hint, code } = classifyDbError(lastError);
    console.error("Database unavailable:", lastError?.message);
    const boom = new Error(`Database connection failed. ${hint} [code: ${code}]`);
    boom.status = 503;
    throw boom;
  }
  const [meta, users, sessions, listings, saved, conversations, messages, bookings, inspections, reports, verifications, notifications, connections, passwordResets] = await Promise.all([
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
    database.collection("verifications").find({}).toArray(),
    database.collection("notifications").find({}).toArray(),
    database.collection("connections").find({}).toArray(),
    database.collection("passwordResets").find({}).toArray()
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
    verifications: verifications.map(({ _id, ...rest }) => rest),
    notifications: notifications.map(({ _id, ...rest }) => rest),
    connections: connections.map(({ _id, ...rest }) => rest),
    passwordResets: passwordResets.map(({ _id, ...rest }) => rest)
  });
  ensureCoreAdminRoles(db);
  loadedKeys = snapshotKeys(db);
  return db;
}

// Stable document id per collection, shared by persist and the deletion diff.
function stableIdOf(name, item) {
  return item.id
    || item.token
    || (name === "saved" && item.userId && item.listingId ? `${item.userId}:${item.listingId}` : null)
    || crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex");
}

const PERSIST_COLLECTIONS = ["users","sessions","listings","saved","conversations","messages","bookings","inspections","reports","verifications","notifications","connections","passwordResets","verification_events"];

// Keys present in the database at load time. persistDb diffs against this so
// records REMOVED server-side (sign-out, expired-session pruning, account or
// listing deletion) are actually deleted in Mongo instead of resurrecting on
// the next load. API requests are serialized, so load→mutate→persist cycles
// never interleave.
let loadedKeys = null;
function snapshotKeys(db) {
  const snap = {};
  for (const name of PERSIST_COLLECTIONS) {
    snap[name] = new Set((db[name] || []).map(item => stableIdOf(name, item)));
  }
  return snap;
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
    verifications: db.verifications || [],
    verification_events: db.verification_events || [],
    notifications: db.notifications || [],
    connections: db.connections || [],
    passwordResets: db.passwordResets || []
  };
  const writes = Object.entries(collections).map(([name, items]) => {
    if (!items.length) return Promise.resolve();
    const collection = database.collection(name);
    return collection.bulkWrite(items.map(item => ({
      replaceOne: { filter: { _id: stableIdOf(name, item) }, replacement: { ...item, _id: stableIdOf(name, item) }, upsert: true }
    })), { ordered: false });
  });
  // Diff deletions: everything loaded but no longer present is removed.
  // Without this, sign-out / session-pruning / account deletion never reach
  // Mongo and the records resurrect on the next load.
  const currentKeys = snapshotKeys(db);
  if (loadedKeys) {
    for (const name of PERSIST_COLLECTIONS) {
      const gone = [...loadedKeys[name]].filter(key => !currentKeys[name].has(key));
      if (gone.length) {
        writes.push(database.collection(name).deleteMany({ _id: { $in: gone } }));
      }
    }
  }
  await Promise.all(writes);
  loadedKeys = currentKeys;
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
  db.notifications ||= [];
  db.connections ||= [];
  db.passwordResets ||= [];
  db.conversations.forEach(conversation => { conversation.reads ||= {}; });
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
  safe.avatarUrl = user.avatar || user.googlePicture || null;
  // Authorization data the client may know: whether THIS session is an admin
  // (used only to show the Admin entry point). Every admin action is still
  // verified server-side — this flag gates UI, never authorization.
  safe.isCoreAdmin = isCoreAdmin(user);
  return safe;
}

/* Canonical verification states exposed to the UI. The legacy
   "manual_review" storage value maps onto PENDING for display purposes. */
const VERIFICATION_STATUS = {
  NOT_VERIFIED: "NOT_VERIFIED",
  PENDING: "PENDING",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED"
};

function verificationStatusFromUser(user, verification) {
  if (user?.verified) return VERIFICATION_STATUS.VERIFIED;
  const status = verification?.status || user?.verificationStatus;
  if (status === "manual_review" || status === "PENDING" || status === "pending") return VERIFICATION_STATUS.PENDING;
  if (status === "verified" || status === "VERIFIED") return VERIFICATION_STATUS.VERIFIED;
  if (status === "rejected" || status === "REJECTED") return VERIFICATION_STATUS.REJECTED;
  return VERIFICATION_STATUS.NOT_VERIFIED;
}

/* Own-submission view for the signed-in user: existence flags, a masked NIN,
   and review metadata only — never document bytes or the full NIN. */
function verificationForOwner(verification, user) {
  if (!verification) return null;
  return {
    id: verification.id, userId: verification.userId, idType: verification.idType,
    ninMasked: maskNin(verification.nin), status: verification.status,
    hasIdCard: Boolean(verification.idCardImage), hasSupportDocument: Boolean(verification.supportDocument),
    rejectionReason: verification.rejectionReason || null,
    reviewedAt: verification.reviewedAt || null, createdAt: verification.createdAt,
    statusLabel: verificationStatusFromUser(user, verification)
  };
}

function maskNin(storedNin) {
  const nin = decrypt(storedNin);
  if (!nin) return "**********";
  return `${"*".repeat(Math.max(0, nin.length - 4))}${nin.slice(-4)}`;
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", NIN_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `enc1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload) {
  if (!payload) return null;
  if (!String(payload).startsWith("enc1:")) return payload;
  try {
    const [, iv, tag, data] = String(payload).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", NIN_KEY, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

function adminTokenOk(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
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
    memberSince: account.createdAt || null,
    // Public-safe avatar: the user's uploaded photo or their Google profile
    // picture. Never an arbitrary user-supplied URL.
    avatarUrl: account.avatar || account.googlePicture || null
  };
}

// Real connection state between two accounts, derived from the connections collection.
function connectionStateFor(db, viewerId, otherId) {
  const link = db.connections.find(item =>
    (item.requesterId === viewerId && item.recipientId === otherId) ||
    (item.requesterId === otherId && item.recipientId === viewerId));
  if (!link) return { state: "none", connectionId: null };
  if (link.status === "accepted") return { state: "connected", connectionId: link.id };
  return link.requesterId === viewerId
    ? { state: "outgoing", connectionId: link.id }
    : { state: "incoming", connectionId: link.id };
}

// Central notification writer. Every real user-facing event funnels through here.
function notify(db, userId, notification) {
  if (!userId || !db.users.some(user => user.id === userId)) return;
  db.notifications.unshift({
    id: id("ntf"), read: false, createdAt: new Date().toISOString(),
    ...notification, userId
  });
  const mine = db.notifications.filter(item => item.userId === userId);
  if (mine.length > 60) {
    const drop = new Set(mine.slice(60).map(item => item.id));
    db.notifications = db.notifications.filter(item => !drop.has(item.id));
  }
}

function unreadMessageTotal(db, userId) {
  return db.conversations.reduce((sum, conversation) => {
    if (!conversation.memberIds.includes(userId)) return sum;
    const readUpTo = conversation.reads?.[userId] || EPOCH;
    return sum + db.messages.filter(message => message.conversationId === conversation.id && message.senderId !== userId && message.createdAt > readUpTo).length;
  }, 0);
}

function notificationPayload(item, db) {
  const actor = db.users.find(user => user.id === item.actorId);
  return { ...item, actor: actor ? { id: actor.id, name: actor.name } : null };
}

// Single source of truth for people ranking: university + habits + budget overlap.
function matchScoreFor(db, account, candidate) {
  const sameUniversity = candidate.university === account.university;
  const sharedHabits = (candidate.habits || []).filter(habit => (account.habits || []).includes(habit)).length;
  const budgetClose = account.budget && candidate.budget ? Math.abs(account.budget - candidate.budget) <= 150000 : false;
  return Math.min(98, 62 + (sameUniversity ? 20 : 0) + sharedHabits * 5 + (budgetClose ? 6 : 0));
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

/* Core Administrator authorization — SERVER-SIDE ONLY. The role lives on the
   account row ("core_admin"); eligibility is granted by the CORE_ADMIN_EMAILS
   environment variable (comma-separated). Promotion happens lazily at request
   time, so adding an email to the env var promotes that account on its next
   authenticated request without any code change, and the role system is open
   ended: any number of core admins is supported, two is just the start. The
   frontend never decides admin access — it only learns `isCoreAdmin` from the
   server, and every admin API call re-verifies the role independently. */
const CORE_ADMIN_EMAILS = new Set(
  String(process.env.CORE_ADMIN_EMAILS || "")
    .split(",")
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
);
function isCoreAdmin(user) {
  return Boolean(user) && user.role === "core_admin";
}
function ensureCoreAdminRoles(db) {
  if (!CORE_ADMIN_EMAILS.size) return;
  for (const user of db.users) {
    if (CORE_ADMIN_EMAILS.has(String(user.email || "").toLowerCase()) && user.role !== "core_admin") {
      user.role = "core_admin";
    }
  }
}
function requireCoreAdmin(req, res, db) {
  const account = requireUser(req, res, db);
  if (!account) return null;
  if (!isCoreAdmin(account)) {
    error(res, 403, "Core administrator access required");
    return null;
  }
  return account;
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

// Secure attribute only (no name/value) for the auxiliary auth cookies.
function sessionSecureSuffix(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return proto === "https" ? "; Secure" : "";
}

function redirect(res, status, location, headers = {}) {
  res.writeHead(status, { "Location": location, "Cache-Control": "no-store", ...headers });
  return res.end();
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

function listingOccupancy(listing, db) {
  const paidCount = db.bookings.filter(item => item.listingId === listing.id && item.status === "paid").length;
  const capacity = Math.max(1, Math.min(10, Number(listing.bedrooms) || 1));
  return { occupied: paidCount, capacity, full: paidCount >= capacity };
}

// Deterministic ~200m jitter derived from the listing id: the map pin lands
// in the same neighborhood on every load but never reveals the exact home.
function approximateCoords(listing) {
  const lat = Number(listing.latitude), lng = Number(listing.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (!lat && !lng)) return null;
  let hash = 0;
  for (const char of String(listing.id || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const jitterLat = ((hash % 1000) / 1000 - 0.5) * 0.0036;
  const jitterLng = (((hash >>> 10) % 1000) / 1000 - 0.5) * 0.0044;
  return { approxLatitude: +(lat + jitterLat).toFixed(6), approxLongitude: +(lng + jitterLng).toFixed(6) };
}

function listingPayload(listing, db, user) {
  const owner = db.users.find(item => item.id === listing.ownerId);
  // Exact property coordinates stay server-side (they reveal the home).
  // Clients get neighborhood-accurate approximate coordinates for maps;
  // the owner additionally receives exact coordinates for editing.
  const { latitude, longitude, ...publicListing } = listing;
  const isOwnerView = Boolean(user && user.id === listing.ownerId);
  return {
    ...publicListing,
    ...(isOwnerView ? { latitude, longitude } : {}),
    ...approximateCoords(listing),
    owner: owner ? { id:owner.id, name:owner.name, verified:owner.verified } : null,
    hostView: Boolean(owner && (owner.verified === true || owner.role === "landlord")),
    saved: Boolean(user && db.saved.some(item => item.userId === user.id && item.listingId === listing.id)),
    proximity: proximityPayload(listing),
    ...listingOccupancy(listing, db)
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
    otherReadAt: conversation.reads?.[otherId] || null,
    listingId: conversation.listingId || null,
    listingTitle: listing ? listing.title : null,
    updatedAt: conversation.updatedAt,
    other: profileView(other),
    lastMessage: last ? { ...last, text: last.text || (last.attachments?.length ? (last.attachments[0].mime.startsWith("video/") ? "Video" : last.attachments[0].mime.startsWith("image/") ? "Photo" : "Voice note") : "") } : null,
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
  db.notifications = db.notifications.filter(item => item.userId !== userId);
  db.connections = db.connections.filter(item => item.requesterId !== userId && item.recipientId !== userId);
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

// Public, secret-free health probe. Answers without touching loadDb() or the
// rate limiter, so it stays reachable even while the database is unreachable.
// Reports the driver error code so an Atlas outage can be diagnosed from the
// browser without exposing any credentials or connection strings.
async function healthResponse(req, res) {
  const body = {
    ok: true,
    mode: USE_MONGODB ? "mongodb" : "file",
    // "ephemeral" = writes will be lost on the next request (serverless without
    // MONGODB_URI). Detectable misconfiguration for operators/monitors.
    storage: USE_MONGODB ? "mongodb" : EPHEMERAL_FS ? "ephemeral" : "file",
    ...(EPHEMERAL_FS ? { warning: "Serverless without MONGODB_URI: new sign-ups are refused because data cannot persist." } : {}),
    paymentsEnabled: Boolean(PAYSTACK_SECRET_KEY),
    time: new Date().toISOString()
  };
  if (!USE_MONGODB) return json(res, 200, body);
  const lint = lintMongoUri(process.env.MONGODB_URI);
  if (lint) return json(res, 503, { ...body, ok: false, code: lint.code, hint: lint.hint });
  try {
    const database = await mongoDb();
    await database.admin().command({ ping: 1 });
    return json(res, 200, body);
  } catch (err) {
    console.error("Health check DB failure:", err?.message);
    const { hint, code } = classifyDbError(err);
    return json(res, 503, { ...body, ok: false, code, hint });
  }
}

async function api(req, res, url) {
  if (url.pathname === "/api/health") return healthResponse(req, res);
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
      .map(candidate => ({ ...profileView(candidate), score: matchScoreFor(db, user, candidate), connection: connectionStateFor(db, user.id, candidate.id) }))
      .sort((a,b)=>b.score-a.score) : [];
    const verification = user ? db.verifications.filter(item => item.userId === user.id).sort((a,b) => String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0] || null : null;
    const people = user ? db.users
      .filter(item => item.id !== user.id && (item.role === "tenant" || item.hosting === true))
      .map(item => ({ ...profileView(item), score: matchScoreFor(db, user, item), connection: connectionStateFor(db, user.id, item.id) }))
      .sort((a,b) => b.score - a.score) : [];
    const myNotifications = user ? db.notifications.filter(item => item.userId === user.id) : [];
    return json(res, 200, {
      user: publicUser(user),
      universities: [...new Set(universities)].sort((a,b)=>a.localeCompare(b)),
      listings, ownListings, conversations, bookings, inspections, roommateCandidates,
      verification: verificationForOwner(verification, user),
      verificationStatus: verificationStatusFromUser(user, verification),
      people,
      notifications: myNotifications.slice(0, 30).map(item => notificationPayload(item, db)),
      notificationsUnread: myNotifications.filter(item => !item.read).length,
      unreadMessages: user ? unreadMessageTotal(db, user.id) : 0,
      paymentsEnabled: Boolean(PAYSTACK_SECRET_KEY)
    });
  }

  if (route === "/api/auth/signup" && method === "POST") {
    if (!rateLimit(`ip:${ip}:signup`, Number(process.env.SIGNUP_RATE_LIMIT || 10), 3_600_000)) return error(res, 429, "Too many sign-up attempts from this network. Try again later.");
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = body.role === "landlord" ? "landlord" : "tenant";
    if (name.length < 2 || name.length > 80) return error(res, 400, "Enter your full name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Enter a valid email address");
    if (password.length < 8) return error(res, 400, "Password must be at least 8 characters");
    if (password.length > 200) return error(res, 400, "Password must be 200 characters or fewer");
    if (body.confirmPassword !== undefined && String(body.confirmPassword) !== password) {
      return error(res, 400, "Passwords do not match");
    }
    if (db.users.some(item => item.email === email)) return error(res, 409, "An account with this email already exists. Try signing in instead.");
    // A signup can never SELF-ASSIGN the admin role: "core_admin" is only ever
    // granted server-side to accounts whose email is listed in
    // CORE_ADMIN_EMAILS (promotion happens in loadDb). Registering with
    // role=core_admin is refused outright. An operator-listed email may sign
    // up normally — that IS the provisioning path — and is promoted on the
    // next load; nobody can grab the role by email alone.
    if (body.role === "core_admin") return error(res, 403, "Administrator accounts are provisioned by the operator. The core_admin role cannot be requested at signup.");
    if (EPHEMERAL_FS) {
      // Never report a successful account creation when the write cannot
      // survive this request — that is what produces "invalid credentials"
      // on the next sign-in.
      return error(res, 503, "Offkay is not connected to a database, so new accounts cannot be saved. The operator needs to set MONGODB_URI (see README > Database). ");
    }
    const university = universities.includes(body.university) ? body.university : universities[0];
    const newUser = {
      id:id("usr"), name, email, password:hashPassword(password), role,
      phone:String(body.phone || "").replace(/[^\d+]/g,"").slice(0,20),
      university, verified:false, bio:"", budget:0, habits:[], createdAt:new Date().toISOString()
    };
    db.users.push(newUser);
    const token = id("ses");
    db.sessions.push({token,userId:newUser.id,expiresAt:Date.now()+SESSION_TTL});
    notify(db, newUser.id, { type:"system", title:"Welcome to Offkay", body:"Add your university, budget, and lifestyle so roommates can find you.", actorId:null, meta:{} });
    await new Promise(resolve => setTimeout(resolve, 0));
    await persistDb(db);
    return json(res, 201, {user:publicUser(newUser)}, {"Set-Cookie":sessionCookie(req, token, 2592000)});
  }

  if (route === "/api/auth/login" && method === "POST") {
    if (!rateLimit(`ip:${ip}:login`, 30, 15 * 60_000)) return error(res, 429, "Too many sign-in attempts. Wait a few minutes.");
    const body = await parseBody(req);
    const account = db.users.find(item => item.email === String(body.email || "").trim().toLowerCase());
    if (!account || !verifyPassword(String(body.password || ""), account.password)) return error(res, 401, "Email or password is incorrect");
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

  if (route === "/api/account/password" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    if (!verifyPassword(String(body.currentPassword || ""), account.password)) return error(res, 403, "Your current password is incorrect");
    const next = String(body.newPassword || "");
    if (next.length < 8) return error(res, 400, "New password must be at least 8 characters");
    account.password = hashPassword(next);
    await persistDb(db);
    return json(res, 200, {ok:true});
  }

  /* ---- Google OAuth 2.0 (authorization-code flow) -----------------------
     GET  /api/auth/google → 302 to Google's consent screen (state cookie).
     GET  /api/auth/google/callback → exchanges the code, finds-or-links the
     Offkay account by verified Google email (never creating a duplicate for
     an existing address), issues the normal session cookie, then redirects
     into the app. */
  if (route === "/api/auth/google" && method === "GET") {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return error(res, 503, "Google sign-in is not configured on this server yet. The operator needs to set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see README > Google sign-in).");
    }
    if (!rateLimit(`ip:${ip}:google`, 30, 60 * 60_000)) return error(res, 429, "Too many sign-in attempts. Wait a few minutes.");
    const origin = requestUrl(req);
    if (!origin) return error(res, 400, "Cannot determine the request origin");
    const state = crypto.randomBytes(16).toString("hex");
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account"
    });
    return redirect(res, 302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`, {
      "Set-Cookie": `g_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${sessionSecureSuffix(req)}`
    });
  }

  if (route === "/api/auth/google/callback" && method === "GET") {
    const fail = reason => redirect(res, 302, `/index.html?authError=${encodeURIComponent(reason)}`);
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return fail("Google sign-in is not configured on this server yet.");
    const params = url.searchParams;
    if (params.get("error")) return fail(params.get("error") === "access_denied" ? "Google sign-in was cancelled. Try again any time." : "Google sign-in failed. Please try again.");
    const code = params.get("code") || "";
    const state = params.get("state") || "";
    const cookieState = parseCookies(req).g_state || "";
    if (!code) return fail("Google did not return an authorization code. Please try again.");
    if (!state || !cookieState || state !== cookieState) return fail("Your sign-in session expired. Please try again.");
    let idInfo = null;
    try {
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${requestUrl(req)}/api/auth/google/callback`,
          grant_type: "authorization_code"
        })
      });
      const tokens = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokens.id_token) {
        console.error("Google token exchange failed:", tokenResponse.status, JSON.stringify(tokens).slice(0, 300));
        return fail("Google sign-in failed during account verification. Please try again.");
      }
      const [headerPart, payloadPart] = String(tokens.id_token).split(".");
      idInfo = JSON.parse(Buffer.from(payloadPart, "base64").toString("utf8"));
    } catch (err) {
      console.error("Google OAuth request failed:", err?.message || err);
      return fail("Google sign-in failed. Please try again in a moment.");
    }
    const googleSub = String(idInfo.sub || "");
    const googleEmail = String(idInfo.email || "").trim().toLowerCase();
    const emailVerified = idInfo.email_verified !== false;
    const displayName = String(idInfo.name || googleEmail.split("@")[0] || "Offkay member").slice(0, 80);
    if (!googleSub || !googleEmail || !emailVerified) return fail("Your Google account does not share a verified email, so Offkay cannot use it to sign in.");
    // Prefer the linked OAuth identity; otherwise claim the matching existing
    // account by email so Google users never spawn duplicate accounts.
    let account = db.users.find(item => item.oauthProvider === "google" && item.oauthId === googleSub)
      || db.users.find(item => item.email === googleEmail);
    if (EPHEMERAL_FS && !account) {
      return fail("Offkay is not connected to a database, so new accounts cannot be saved. Existing members can still use email sign-in.");
    }
    if (!account) {
      account = {
        id: id("usr"), name: displayName, email: googleEmail, password: "",
        role: "tenant", phone: "", university: universities[0], verified: false,
        bio: "", budget: 0, habits: [], createdAt: new Date().toISOString(),
        oauthProvider: "google", oauthId: googleSub,
        googlePicture: /^https:\/\//.test(String(idInfo.picture || "")) ? String(idInfo.picture).slice(0, 500) : null
      };
      db.users.push(account);
      notify(db, account.id, { type: "system", title: "Welcome to Offkay", body: "Add your university, budget, and lifestyle so roommates can find you.", actorId: null, meta: {} });
    } else if (!account.oauthProvider) {
      // First Google sign-in on an email-password account: link the identity.
      // The password stays intact, so email sign-in keeps working.
      account.oauthProvider = "google";
      account.oauthId = googleSub;
    }
    if (!account.googlePicture && /^https:\/\//.test(String(idInfo.picture || ""))) {
      account.googlePicture = String(idInfo.picture).slice(0, 500);
    }
    const token = id("ses");
    db.sessions.push({ token, userId: account.id, expiresAt: Date.now() + SESSION_TTL });
    await persistDb(db);
    return redirect(res, 302, "/index.html?authSuccess=google", {
      "Set-Cookie": [
        sessionCookie(req, token, 2592000),
        `g_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${sessionSecureSuffix(req)}`
      ]
    });
  }

  /* ---- Password reset ---------------------------------------------------
     POST /api/auth/forgot { email } — issues a single-use token (hashed at
     rest), emails the reset link, always answers 200 so the endpoint cannot
     be used to discover which addresses have accounts.
     GET  /api/auth/reset/:token — validates a token for the reset screen.
     POST /api/auth/reset { token, password, confirmPassword } — completes it. */
  if (route === "/api/auth/forgot" && method === "POST") {
    if (!rateLimit(`ip:${ip}:forgot`, 10, 60 * 60_000)) return error(res, 429, "Too many reset requests. Try again in a little while.");
    const body = await parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, "Enter a valid email address");
    const account = db.users.find(item => item.email === email);
    const generic = { ok: true, message: "If an Offkay account exists for that email, a reset link is on its way. It expires in 30 minutes." };
    if (!account) return json(res, 200, generic);
    // A fresh request retires any outstanding token so only the newest email works.
    db.passwordResets = (db.passwordResets || []).filter(item => item.userId !== account.id);
    const token = crypto.randomBytes(32).toString("hex");
    db.passwordResets.push({
      userId: account.id,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + RESET_TOKEN_TTL
    });
    await persistDb(db);
    const origin = requestUrl(req);
    if (!origin) return error(res, 400, "Cannot determine the request origin");
    const resetUrl = `${origin}/reset.html?token=${token}`;
    const delivery = await sendPasswordResetEmail(account.email, resetUrl);
    // `delivery` tells the client exactly what happened ("sent" | "failed" |
    // "skipped") so the UI can report a provider failure honestly instead of
    // claiming an email is on its way. `delivered`/`devMode` stay for
    // backward compatibility with existing tests.
    return json(res, 200, { ...generic, devMode: !RESEND_API_KEY, delivered: delivery.delivered, delivery: delivery.delivery });
  }

  const resetVerifyMatch = route.match(/^\/api\/auth\/reset\/([a-f0-9]{64})$/);
  if (resetVerifyMatch && method === "GET") {
    const tokenHash = crypto.createHash("sha256").update(resetVerifyMatch[1]).digest("hex");
    const record = (db.passwordResets || []).find(item => item.tokenHash === tokenHash && item.expiresAt > Date.now());
    if (!record) return error(res, 400, "This reset link is invalid or has expired. Request a new one from the sign-in screen.");
    return json(res, 200, { ok: true });
  }

  if (route === "/api/auth/reset" && method === "POST") {
    if (!rateLimit(`ip:${ip}:reset`, 20, 60 * 60_000)) return error(res, 429, "Too many attempts. Try again in a little while.");
    const body = await parseBody(req);
    const token = String(body.token || "").trim();
    const password = String(body.password || "");
    if (!/^[a-f0-9]{64}$/.test(token)) return error(res, 400, "This reset link is invalid. Request a new one from the sign-in screen.");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const record = (db.passwordResets || []).find(item => item.tokenHash === tokenHash && item.expiresAt > Date.now());
    if (!record) return error(res, 400, "This reset link is invalid or has expired. Request a new one from the sign-in screen.");
    if (password.length < 8) return error(res, 400, "Password must be at least 8 characters");
    if (password.length > 200) return error(res, 400, "Password must be 200 characters or fewer");
    if (body.confirmPassword !== undefined && String(body.confirmPassword) !== password) {
      return error(res, 400, "Passwords do not match");
    }
    const account = db.users.find(item => item.id === record.userId);
    if (!account) {
      db.passwordResets = (db.passwordResets || []).filter(item => item !== record);
      await persistDb(db);
      return error(res, 400, "This reset link is invalid. Request a new one from the sign-in screen.");
    }
    account.password = hashPassword(password);
    // Single-use: retire every reset token and end all sessions, forcing a
    // fresh sign-in with the new password on every device.
    db.passwordResets = (db.passwordResets || []).filter(item => item.userId !== account.id);
    db.sessions = db.sessions.filter(item => item.userId !== account.id);
    await persistDb(db);
    return json(res, 200, { ok: true, message: "Password updated. Sign in with your new password." });
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
    if (body.notifyMessages !== undefined) account.notifyMessages = body.notifyMessages === true;
    // Profile picture: only inline JPEG/PNG/WEBP data URLs the client has
    // already downscaled (<= ~900 KB). null clears the custom photo (the
    // Google picture, if any, shows again). Never a remote URL.
    if (body.avatar !== undefined) {
      if (body.avatar === null) {
        account.avatar = null;
      } else if (typeof body.avatar === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(body.avatar.slice(0, 120)) && body.avatar.length <= 1_200_000) {
        account.avatar = body.avatar;
      } else {
        return error(res, 400, "Profile photo must be a small JPEG, PNG, or WebP image");
      }
    }
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

  if (route === "/api/verification" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const verification = db.verifications.filter(item => item.userId === account.id).sort((a,b) => String(b.createdAt||"").localeCompare(String(a.createdAt||"")))[0] || null;
    return json(res,200,{verification:verificationForOwner(verification,account),statusLabel:verificationStatusFromUser(account,verification)});
  }

  if (route === "/api/verification" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    // Backend enforcement: an approved user can never submit another
    // verification, regardless of what the frontend shows.
    if (account.verified) return error(res,409,"Your account is already verified. Verification is complete and no further submission is needed.");
    const body = await parseBody(req);
    const nin = String(body.nin || "").replace(/\D/g,"");
    if (nin.length < 8) return error(res,400,"Enter a valid NIN before submitting verification");
    const verification = {
      id:id("ver"),userId:account.id,nin:encrypt(nin.slice(0,20)),idType:String(body.idType || "Student ID").slice(0,60),
      idCardImage:typeof body.idCardImage === "string" && body.idCardImage.startsWith("data:image/") ? body.idCardImage.slice(0,1_200_000) : null,
      supportDocument:typeof body.supportDocument === "string" && body.supportDocument.startsWith("data:image/") ? body.supportDocument.slice(0,1_200_000) : null,
      status:"manual_review",createdAt:new Date().toISOString()
    };
    db.verifications.push(verification);
    account.verificationStatus = "manual_review";
    await persistDb(db);
    return json(res,201,{verification:verificationForOwner(verification,account),user:publicUser(account)});
  }

  if (route === "/api/listings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!canHost(account)) return error(res, 403, "Activate hosting before publishing a property");
    const body = await parseBody(req);
    if (!body.title || !body.area || !body.price) return error(res,400,"Title, area, and annual rent are required");
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 10000) return error(res,400,"Enter an annual rent of at least \u20A610,000");
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
    notify(db, listing.ownerId, { type:"inspection", title:"New inspection request", body:`${account.name} requested to inspect ${listing.title}.`, actorId:account.id, meta:{ inspectionId:inspection.id, listingId:listing.id } });
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
      notify(db, listing.ownerId, { type:"message", title:`New message from ${account.name}`, body:`Hi, I am interested in ${listing.title}. Is it still available?`, actorId:account.id, meta:{ conversationId:conversation.id } });
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
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (!text && !attachments.length) return error(res,400,"Message cannot be empty");
    /* Attachments (images, short videos, voice notes) are stored as data URLs
       inside the existing messages collection - the same approach listing
       photos already use. Validation: type allowlist, per-file and total
       size caps that fit the 2 MB JSON body limit; video duration is capped
       client-side before upload. No second media system - this IS the
       messages storage. */
    const MAX_SINGLE = 900000, MAX_TOTAL = 1500000, MAX_FILES = 3;
    const ALLOWED = {
      "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
      "video/mp4": ".mp4", "video/webm": ".webm",
      "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/wav": ".wav"
    };
    const cleaned = [];
    let totalBytes = 0;
    for (const a of attachments.slice(0, MAX_FILES)) {
      const dataUrl = String(a?.dataUrl || "");
      const meta = String(a?.meta || "audio");
      const match = dataUrl.match(/^data:([\w./+-]+)(?:;[\w.=-]+)*;base64,([A-Za-z0-9+\/=]+)$/);
      if (!match) return error(res,400,"Attachment must be a base64 data URL");
      const mime = match[1].toLowerCase();
      if (!ALLOWED[mime]) return error(res,415,"Unsupported attachment type. Use images, short videos, or voice notes.");
      const bytes = Math.floor(match[2].length * 0.75);
      if (bytes > MAX_SINGLE) return error(res,413,"Attachment too large. Keep files under about 650 KB.");
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL) return error(res,413,"Attachments too large for one message.");
      cleaned.push({ mime, name: String(a?.name || "attachment" + ALLOWED[mime]).slice(0,60), bytes, meta: meta.slice(0,120), dataUrl });
    }
    const message = {id:id("msg"),conversationId:conversation.id,senderId:account.id,text:text.slice(0,2000),createdAt:new Date().toISOString()};
    if (cleaned.length) message.attachments = cleaned.map(({mime,name,bytes,meta,dataUrl}) => ({mime,name,bytes,meta,dataUrl}));
    db.messages.push(message);
    conversation.updatedAt = message.createdAt;
    conversation.reads[account.id] = message.createdAt;
    const previewBits = cleaned[0]
      ? (cleaned[0].mime.startsWith("video/") ? "Video" : cleaned[0].mime.startsWith("image/") ? "Photo" : "Voice note")
      : null;
    const previewText = text || (previewBits ? (cleaned.length > 1 ? previewBits + " (" + cleaned.length + ")" : previewBits) : "");
    const recipient = db.users.find(item => conversation.memberIds.includes(item.id) && item.id !== account.id);
    if (recipient && recipient.notifyMessages !== false) {
      notify(db, recipient.id, { type:"message", title:`New message from ${account.name}`, body:previewText.slice(0,120), actorId:account.id, meta:{ conversationId:conversation.id } });
    }
    await persistDb(db);
    return json(res,201,{message});
  }

  if (route === "/api/users" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 80);
    const university = String(url.searchParams.get("university") || "").trim().slice(0, 120);
    const visible = db.users.filter(item => {
      if (item.id === account.id) return false;
      if (item.role !== "tenant" && item.role !== "landlord" && item.hosting !== true) return false;
      if (university && item.university !== university) return false;
      if (q) {
        const haystack = `${item.name} ${item.university || ""} ${(item.habits || []).join(" ")}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    const people = visible.map(item => ({
      ...profileView(item),
      score: matchScoreFor(db, account, item),
      connection: connectionStateFor(db, account.id, item.id)
    })).sort((a,b)=>b.score-a.score).slice(0, 60);
    return json(res,200,{people});
  }

  if (route === "/api/conversations/start" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const candidate = db.users.find(item => item.id === body.userId);
    if (!candidate || candidate.id === account.id) return error(res,404,"User not found");
    let conversation = db.conversations.find(item => !item.listingId && item.memberIds.includes(account.id) && item.memberIds.includes(candidate.id));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,candidate.id],listingId:null,updatedAt:new Date().toISOString(),reads:{}};
      db.conversations.push(conversation);
    }
    await persistDb(db);
    return json(res,200,{conversationId:conversation.id,conversation:conversationPayload(conversation, db, account.id)});
  }

  if (route === "/api/roommates" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return json(res,200,{matches:[]});
    const matches = db.users.filter(item => item.id !== account.id && (item.role === "tenant" || item.hosting === true)).map(candidate => ({
      ...profileView(candidate),
      score: matchScoreFor(db, account, candidate),
      connection: connectionStateFor(db, account.id, candidate.id)
    })).sort((a,b)=>b.score-a.score);
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
      if (candidate.notifyMessages !== false) {
        notify(db, candidate.id, { type:"message", title:`New message from ${account.name}`, body:"Hi! Offkay matched us as potential roommates. Would you like to chat?", actorId:account.id, meta:{ conversationId:conversation.id } });
      }
    }
    await persistDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  const userMatch = route.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const target = db.users.find(item => item.id === userMatch[1]);
    if (!target) return error(res,404,"User not found");
    return json(res,200,{ user: { ...profileView(target), score: matchScoreFor(db, account, target), connection: connectionStateFor(db, account.id, target.id) } });
  }

  // ---- Connections: real pending/accepted links between accounts ----
  if (route === "/api/connections" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const links = db.connections.filter(item => item.requesterId === account.id || item.recipientId === account.id);
    const withPeople = links.map(link => {
      const otherId = link.requesterId === account.id ? link.recipientId : link.requesterId;
      const other = db.users.find(item => item.id === otherId);
      return { ...link, direction: link.requesterId === account.id ? "outgoing" : "incoming", person: profileView(other) };
    }).filter(link => link.person);
    return json(res,200,{ connections: withPeople });
  }

  if (route === "/api/connections" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!rateLimit(`user:${account.id}:connect`, 40, 3_600_000)) return error(res, 429, "Too many connection attempts. Try again later.");
    const body = await parseBody(req);
    const target = db.users.find(item => item.id === body.userId);
    if (!target) return error(res,404,"User not found");
    if (target.id === account.id) return error(res,400,"You cannot connect with yourself");
    const existing = db.connections.find(item =>
      (item.requesterId === account.id && item.recipientId === target.id) ||
      (item.requesterId === target.id && item.recipientId === account.id));
    if (existing && existing.status === "accepted") return json(res,200,{ connection: existing, state: "connected" });
    if (existing && existing.requesterId === account.id) return json(res,200,{ connection: existing, state: "outgoing" });
    if (existing && existing.recipientId === account.id) {
      existing.status = "accepted";
      existing.acceptedAt = new Date().toISOString();
      notify(db, existing.requesterId, { type:"connection_accepted", title:"Connection accepted", body:`${account.name} accepted your connection request.`, actorId:account.id, meta:{ connectionId:existing.id } });
      await persistDb(db);
      return json(res,200,{ connection: existing, state: "connected" });
    }
    const link = { id:id("cnx"), requesterId:account.id, recipientId:target.id, status:"pending", createdAt:new Date().toISOString() };
    db.connections.push(link);
    notify(db, target.id, { type:"connection", title:"New connection request", body:`${account.name} wants to connect with you.`, actorId:account.id, meta:{ connectionId:link.id } });
    await persistDb(db);
    return json(res,201,{ connection: link, state: "outgoing" });
  }

  const connectionAction = route.match(/^\/api\/connections\/([^/]+)\/(accept|decline)$/);
  if (connectionAction && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const link = db.connections.find(item => item.id === connectionAction[1]);
    if (!link || (link.requesterId !== account.id && link.recipientId !== account.id)) return error(res,404,"Connection not found");
    if (connectionAction[2] === "accept") {
      if (link.recipientId !== account.id) return error(res,403,"Only the recipient can accept this request");
      if (link.status !== "accepted") {
        link.status = "accepted";
        link.acceptedAt = new Date().toISOString();
        notify(db, link.requesterId, { type:"connection_accepted", title:"Connection accepted", body:`${account.name} accepted your connection request.`, actorId:account.id, meta:{ connectionId:link.id } });
        await persistDb(db);
      }
      return json(res,200,{ connection: link, state: "connected" });
    }
    // decline: recipient declines, or requester cancels their own pending request
    db.connections = db.connections.filter(item => item.id !== link.id);
    await persistDb(db);
    return json(res,200,{ ok:true, state:"none" });
  }

  // ---- Notifications: real per-user feed with read state ----
  if (route === "/api/notifications" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const mine = db.notifications.filter(item => item.userId === account.id);
    return json(res,200,{
      notifications: mine.slice(0, 50).map(item => notificationPayload(item, db)),
      unread: mine.filter(item => !item.read).length
    });
  }

  if (route === "/api/notifications/read" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 100) : null;
    let changed = 0;
    db.notifications.forEach(item => {
      if (item.userId !== account.id || item.read) return;
      if (ids && !ids.includes(item.id)) return;
      item.read = true;
      changed++;
    });
    if (changed) await persistDb(db);
    const mine = db.notifications.filter(item => item.userId === account.id);
    return json(res,200,{ ok:true, marked: changed, unread: mine.filter(item => !item.read).length });
  }

  // ---- Lightweight badge poll: real unread counts, no render data ----
  if (route === "/api/badges" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const payload = {
      messages: unreadMessageTotal(db, account.id),
      notifications: db.notifications.filter(item => item.userId === account.id && !item.read).length
    };
    // Core admins also get the pending-verification count for the Admin badge.
    if (isCoreAdmin(account)) {
      payload.adminPending = db.verifications.filter(item => item.status === "manual_review" || item.status === "PENDING" || item.status === "pending").length;
    }
    return json(res,200,payload);
  }

  if (route === "/api/bookings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!rateLimit(`user:${account.id}:bookings`, 10, 3_600_000)) return error(res, 429, "Too many booking attempts. Try again later.");
    if (account.role !== "tenant") return error(res,403,"Only tenant accounts can book a property");
    const body = await parseBody(req);
    const listing = db.listings.find(item => item.id === body.listingId && item.status === "active");
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId === account.id) return error(res,400,"You cannot book your own property");
    const occupancy = listingOccupancy(listing, db);
    if (occupancy.full) return error(res,409,"This property is fully booked. Every room already has a confirmed group.");
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
    notify(db, listing.ownerId, { type:"booking", title:"New booking request", body:`${account.name} started a booking for ${listing.title}.`, actorId:account.id, meta:{ bookingId:booking.id, listingId:listing.id } });
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
      notify(db, booking.ownerId, { type:"payment", title:"Booking fully paid", body:`${account.name} completed payment for a booking.`, actorId:account.id, meta:{ bookingId:booking.id } });
    }
    await persistDb(db);
    return json(res,200,{booking});
  }

  const cancelMatch = route.match(/^\/api\/bookings\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const booking = db.bookings.find(item => item.id === cancelMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res,404,"Booking not found");
    if (booking.status === "paid") return error(res,409,"Paid bookings cannot be cancelled here - contact support with your payment reference");
    if (booking.status === "cancelled") return json(res,200,{booking});
    const paidSlots = Array.isArray(booking.paidSlots) ? booking.paidSlots.length : 0;
    if (paidSlots > 0) return error(res,409,"A share has already been paid - this booking can no longer be cancelled");
    booking.status = "cancelled";
    booking.cancelledAt = new Date().toISOString();
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
    const booking = db.bookings.find(item => item.id === initMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res, 404, "Booking not found");
    if (!PAYSTACK_SECRET_KEY) return error(res, 503, "Payments are not configured on this server yet");
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
      notify(db, booking.ownerId, { type:"payment", title:"Booking fully paid", body:`${account.name} completed payment for a booking.`, actorId:account.id, meta:{ bookingId:booking.id } });
    }
    await persistDb(db);
    return json(res, 200, { booking });
  }

  // Distance + ETA from a property to its university, computed server-side
  // from stored coordinates. Uses Google Directions when GOOGLE_MAPS_API_KEY
  // is set, OSRM when OSRM_BASE_URL is set, otherwise a straight-line
  // estimate. Property coordinates are never returned to the client.
  const distanceMatch = route.match(/^\/api\/distance\/university$/);
  if (distanceMatch && method === "GET") {
    const listingId = url.searchParams.get("listingId");
    const university = url.searchParams.get("university") || "";
    const listing = listingId ? db.listings.find(item => item.id === listingId) : null;
    if (!listing && !university) return error(res,400,"Provide listingId or university");
    const uniName = listing ? listing.university : university;
    if (!UNIVERSITY_LOCATIONS[uniName]) return json(res,200,{available:false,reason:"unknown_university"});
    if (!listing || !listingHasCoords(listing)) return json(res,200,{available:false,reason:"missing_coordinates",university:uniName});
    const proximity = await proximityPayloadAsync(listing);
    return json(res,200,{available:true,university:uniName,proximity});
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
            notify(db, booking.ownerId, { type:"payment", title:"Booking fully paid", body:"All shares are confirmed for a booking on your property.", actorId:booking.tenantId, meta:{ bookingId:booking.id } });
          }
          await persistDb(db);
        }
      }
    }
    return json(res, 200, { received: true });
  }

  if (route.startsWith("/api/admin/")) {
    // Core Administrator authorization, enforced HERE on every admin route:
    // the request must be an authenticated session whose account has
    // role === "core_admin", OR carry the operator bearer ADMIN_TOKEN (CLI /
    // ops use). Hiding buttons client-side is never the security boundary.
    // Submitted verification documents are ONLY reachable inside this block —
    // never through any public or user-scoped route.
    const sessionAdmin = isCoreAdmin(currentUser(req, db));
    if (!sessionAdmin && !adminTokenOk(req)) return error(res,403,"Core administrator access required");
    // The acting identity for the audit trail: the signed-in core admin when
    // session-authenticated, else the operator token.
    const actingAdmin = sessionAdmin ? currentUser(req, db) : { id:"op_admin_token", name:"Operator (admin token)" };
    const recordReviewEvent = (verification, decision, reason) => {
      db.verification_events ||= [];
      db.verification_events.push({
        id:id("evt"), verificationId:verification.id, userId:verification.userId,
        decision, reason: reason || null,
        reviewedBy:actingAdmin.id, reviewedByName:actingAdmin.name,
        reviewedAt:new Date().toISOString()
      });
    };
    if (route === "/api/admin/overview" && method === "GET") {
      return json(res,200,{
        stats: {
          users: db.users.length, tenants: db.users.filter(u=>u.role==="tenant").length,
          landlords: db.users.filter(u=>u.role==="landlord").length,
          listings: db.listings.length, pendingVerifications: db.verifications.filter(v=>v.status==="manual_review" || v.status==="PENDING" || v.status==="pending").length,
          pendingListings: db.listings.filter(l=>!l.verified).length,
          openReports: (db.reports || []).filter(r=>r.status==="received" || !r.status).length
        },
        // Admin review list: PENDING submissions with the applicant identity
        // data needed for review. Raw documents are NOT embedded here — bytes
        // are only served on demand via the admin-token-guarded document endpoint.
        verifications: db.verifications
          .filter(v => v.status === "manual_review" || v.status === "PENDING" || v.status === "pending")
          .sort((a,b) => String(b.createdAt||"").localeCompare(String(a.createdAt||"")))
          .map(v => {
            const applicant = db.users.find(u => u.id === v.userId);
            return {...verificationForOwner(v, applicant), statusLabel: VERIFICATION_STATUS.PENDING, applicantName: applicant?.name || "Unknown", applicantEmail: applicant?.email || "", applicantRole: applicant?.role || "tenant", applicantUniversity: applicant?.university || ""};
          }),
        reports: (db.reports || []).map(r => ({...r, reporterName: db.users.find(u=>u.id===r.reportedBy)?.name || "Unknown"})),
        listings: db.listings.filter(l => !l.verified).map(l => ({...listingPayload(l, db, null), ownerName: db.users.find(u=>u.id===l.ownerId)?.name || "Unknown"})),
        users: db.users.map(u => ({ id:u.id, name:u.name, email:u.email, role:u.role, university:u.university, verified:Boolean(u.verified), verificationStatus:verificationStatusFromUser(u, db.verifications.filter(v=>v.userId===u.id).at(-1)), createdAt:u.createdAt }))
      });
    }
    const reviewMatch = route.match(/^\/api\/admin\/verification\/([^/]+)\/review$/);
    if (reviewMatch && method === "POST") {
      const body = await parseBody(req);
      const verification = db.verifications.find(v => v.id === reviewMatch[1]);
      if (!verification) return error(res,404,"Verification not found");
      if (verification.status !== "manual_review" && verification.status !== "PENDING" && verification.status !== "pending") return error(res,409,"This request was already reviewed");
      const approve = body.decision === "approve";
      const reason = String(body.reason || "").trim().slice(0,300);
      if (!approve && !reason) return error(res,400,"Give a short rejection reason");
      verification.status = approve ? "verified" : "rejected";
      verification.reviewedAt = new Date().toISOString();
      verification.reviewedBy = actingAdmin.id;
      verification.reviewedByName = actingAdmin.name;
      verification.rejectionReason = approve ? null : reason;
      const applicant = db.users.find(u => u.id === verification.userId);
      if (applicant) {
        applicant.verified = approve;
        applicant.verificationStatus = verification.status;
      }
      recordReviewEvent(verification, approve ? "approved" : "rejected", reason);
      notify(db, verification.userId, approve
        ? { type:"verification", title:"You are verified", body:`Your Offkay verification was approved by ${actingAdmin.name}.`, actorId:actingAdmin.id }
        : { type:"verification", title:"Verification update", body:`Your verification was not approved. ${reason}`, actorId:actingAdmin.id });
      await persistDb(db);
      return json(res,200,{verification:verificationForOwner(verification,applicant)});
    }
    // Immutable review history (audit trail): who approved/rejected what, when.
    if (route === "/api/admin/verification-history" && method === "GET") {
      const events = (db.verification_events || [])
        .slice()
        .sort((a,b) => String(b.reviewedAt||"").localeCompare(String(a.reviewedAt||"")))
        .slice(0, 200)
        .map(event => {
          const subject = db.users.find(u => u.id === event.userId);
          return { id:event.id, userId:event.userId, userName:subject?.name || "Unknown", userEmail:subject?.email || "",
            decision:event.decision, reason:event.reason, reviewedBy:event.reviewedBy, reviewedByName:event.reviewedByName,
            reviewedAt:event.reviewedAt };
        });
      return json(res,200,{ events });
    }
    const documentMatch = route.match(/^\/api\/admin\/verification\/([^/]+)\/document\/(idCard|support)$/);
    // SECURITY: document bytes are only served inside this /api/admin/* block,
    // which returns 401 unless the request carries a valid ADMIN_TOKEN. No
    // public or user-scoped route returns document data.
    if (documentMatch && method === "GET") {
      const verification = db.verifications.find(v => v.id === documentMatch[1]);
      if (!verification) return error(res,404,"Verification not found");
      const dataUri = documentMatch[2] === "idCard" ? verification.idCardImage : verification.supportDocument;
      if (!dataUri) return error(res,404,"No document uploaded");
      const [meta, base64] = dataUri.split(",");
      const mimeMatch = meta.match(/data:([^;]+)/);
      res.writeHead(200,{"Content-Type":mimeMatch?.[1] || "application/octet-stream","Cache-Control":"no-store"});
      return res.end(Buffer.from(base64 || "", "base64"));
    }
    const listingVerifyMatch = route.match(/^\/api\/admin\/listing\/([^/]+)\/verify$/);
    if (listingVerifyMatch && method === "POST") {
      const body = await parseBody(req);
      const listing = db.listings.find(l => l.id === listingVerifyMatch[1]);
      if (!listing) return error(res,404,"Listing not found");
      listing.verified = body.decision !== "reject";
      if (body.decision === "reject") listing.status = "hidden";
      await persistDb(db);
      return json(res,200,{listing:listingPayload(listing, db, null)});
    }
    return error(res,404,"Admin route not found");
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
    if (err.status) return error(res, err.status, err.message || "Service temporarily unavailable");
    return error(res,500,err.message === "Invalid JSON" ? err.message : "Something went wrong");
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT,HOST,()=>{
    console.log(`Offkay is running at http://${HOST}:${PORT}`);
  });
}

module.exports = server;
module.exports.handler = handler;
