const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

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
  return `${prefix}_${crypto.randomBytes(7).toString("hex")}`;
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
        university: "University of Lagos", verified: true, createdAt: now
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
        description:"Bright self-contained studio with steady water, prepaid electricity, security, and an eight-minute walk to campus.",
        amenities:["Steady water","Security","Prepaid meter","Wardrobe"],verified:true,status:"active",
        accent:"emerald",createdAt:now
      },
      {
        id:"lst_maple",ownerId:landlordId,title:"Maple Student Lodge",university:"University of Ibadan",
        area:"Agbowo, Ibadan",price:380000,type:"Shared",bedrooms:2,bathrooms:2,
        description:"A calm two-bedroom apartment designed for two students, close to the main gate and daily transport.",
        amenities:["Furnished","Wi-Fi ready","Fenced compound","Kitchen"],verified:true,status:"active",
        accent:"amber",createdAt:now
      },
      {
        id:"lst_green",ownerId:landlordId,title:"Green Nest En-suite",university:"University of Nigeria, Nsukka",
        area:"Odenigwe, Nsukka",price:520000,type:"En-suite",bedrooms:1,bathrooms:1,
        description:"Private en-suite room in a newly renovated student building with generator backup and caretaker support.",
        amenities:["Generator","Caretaker","Private bathroom","Parking"],verified:true,status:"active",
        accent:"blue",createdAt:now
      },
      {
        id:"lst_cedar",ownerId:landlordId,title:"Cedar House",university:"Obafemi Awolowo University",
        area:"Road 7, Ile-Ife",price:410000,type:"Shared",bedrooms:2,bathrooms:1,
        description:"Spacious shared apartment on a quiet street with direct transport to campus.",
        amenities:["Balcony","Kitchen","Water tank","Security"],verified:true,status:"active",
        accent:"rose",createdAt:now
      }
    ],
    saved: [{userId:tenantId,listingId:"lst_palm"}],
    conversations: [
      {id:"con_demo",memberIds:[tenantId,landlordId],listingId:"lst_palm",updatedAt:now}
    ],
    messages: [
      {id:"msg_1",conversationId:"con_demo",senderId:landlordId,text:"Hello Amara, the studio is still available. Would you like to schedule a viewing?",createdAt:new Date(Date.now()-3600000).toISOString()},
      {id:"msg_2",conversationId:"con_demo",senderId:tenantId,text:"Yes please. Is Saturday morning okay?",createdAt:new Date(Date.now()-3200000).toISOString()}
    ],
    bookings: [],
    inspections: [],
    reports: []
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
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(seedDb(), null, 2));
}

function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, ""));
  db.inspections ||= [];
  db.reports ||= [];
  db.verifications ||= [];
  return db;
}

let writeQueue = Promise.resolve();
function writeDb(db) {
  const serialized = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DB_FILE, serialized));
  return writeQueue;
}

function publicUser(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
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
  res.writeHead(status, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...headers });
  res.end(JSON.stringify(payload));
}

function error(res, status, message) {
  return json(res, status, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 4_000_000) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
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

async function api(req, res, url) {
  const db = readDb();
  const user = currentUser(req, db);
  const method = req.method;
  const route = url.pathname;

  if (route === "/api/bootstrap" && method === "GET") {
    const listings = db.listings.filter(item => item.status === "active").map(item => listingPayload(item, db, user));
    const conversations = user ? db.conversations
      .filter(conversation => conversation.memberIds.includes(user.id))
      .map(conversation => {
        const otherId = conversation.memberIds.find(memberId => memberId !== user.id);
        const other = db.users.find(item => item.id === otherId);
        const messages = db.messages.filter(message => message.conversationId === conversation.id);
        const last = messages.sort((a,b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
        return {...conversation, other:publicUser(other), lastMessage:last || null};
      }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
    const bookings = user ? db.bookings.filter(item => item.tenantId === user.id || item.ownerId === user.id) : [];
    const inspections = user ? db.inspections.filter(item => item.tenantId === user.id || item.ownerId === user.id) : [];
    const roommateCandidates = user && user.role === "tenant" ? db.users.filter(item => item.role === "tenant" && item.id !== user.id).map(candidate => {
      const sameUniversity = candidate.university === user.university;
      const sharedHabits = (candidate.habits || []).filter(habit => (user.habits || []).includes(habit)).length;
      const budgetClose = user.budget && candidate.budget ? Math.abs(user.budget-candidate.budget)<=150000 : false;
      return {...publicUser(candidate),score:Math.min(98,62+(sameUniversity?20:0)+(sharedHabits*5)+(budgetClose?6:0))};
    }).sort((a,b)=>b.score-a.score) : [];
    const verification = user ? db.verifications.filter(item => item.userId === user.id).at(-1) || null : null;
    return json(res, 200, { user:publicUser(user), universities:[...universities].sort((a,b)=>a.localeCompare(b)), listings, conversations, bookings, inspections, roommateCandidates, verification });
  }

  if (route === "/api/auth/signup" && method === "POST") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const role = body.role === "landlord" ? "landlord" : "tenant";
    if (name.length < 2 || !email.includes("@") || String(body.password || "").length < 8) {
      return error(res, 400, "Enter a valid name, email, and password of at least 8 characters");
    }
    if (db.users.some(item => item.email === email)) return error(res, 409, "An account with this email already exists");
    const newUser = {
      id:id("usr"), name, email, password:hashPassword(body.password), role,
      phone:String(body.phone || "").trim(), university:String(body.university || universities[0]),
      verified:false, bio:"", budget:0, habits:[], createdAt:new Date().toISOString()
    };
    db.users.push(newUser);
    const token = id("ses");
    db.sessions.push({token,userId:newUser.id,expiresAt:Date.now()+SESSION_TTL});
    await writeDb(db);
    return json(res, 201, {user:publicUser(newUser)}, {"Set-Cookie":`ch_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`});
  }

  if (route === "/api/auth/login" && method === "POST") {
    const body = await parseBody(req);
    const account = db.users.find(item => item.email === String(body.email || "").trim().toLowerCase());
    if (!account || !verifyPassword(body.password, account.password)) return error(res, 401, "Email or password is incorrect");
    const token = id("ses");
    db.sessions.push({token,userId:account.id,expiresAt:Date.now()+SESSION_TTL});
    await writeDb(db);
    return json(res, 200, {user:publicUser(account)}, {"Set-Cookie":`ch_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`});
  }

  if (route === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(req).ch_session;
    db.sessions = db.sessions.filter(item => item.token !== token);
    await writeDb(db);
    return json(res, 200, {ok:true}, {"Set-Cookie":"ch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"});
  }

  if (route === "/api/profile" && method === "PATCH") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    ["name","phone","university","bio"].forEach(key => {
      if (body[key] !== undefined) account[key] = String(body[key]).trim();
    });
    if (body.budget !== undefined) account.budget = Number(body.budget) || 0;
    if (Array.isArray(body.habits)) account.habits = body.habits.slice(0,8).map(String);
    await writeDb(db);
    return json(res, 200, {user:publicUser(account)});
  }

  if (route === "/api/host/activate" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    account.hosting = true;
    account.hostActivatedAt = new Date().toISOString();
    await writeDb(db);
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
    await writeDb(db);
    return json(res,201,{verification,user:publicUser(account)});
  }

  if (route === "/api/listings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (!canHost(account)) return error(res, 403, "Activate hosting before publishing a property");
    const body = await parseBody(req);
    if (!body.title || !body.area || !body.price) return error(res,400,"Title, area, and annual rent are required");
    const listing = {
      id:id("lst"),ownerId:account.id,title:String(body.title).trim(),
      university:String(body.university || account.university),area:String(body.area).trim(),
      price:Number(body.price),type:String(body.type || "Studio"),
      bedrooms:Number(body.bedrooms || 1),bathrooms:Number(body.bathrooms || 1),
      description:String(body.description || "").trim(),
      amenities:Array.isArray(body.amenities) ? body.amenities.map(String).slice(0,10) : [],
      photos:Array.isArray(body.photos) ? body.photos.filter(photo => typeof photo === "string" && photo.startsWith("data:image/")).slice(0,4) : [],
      latitude:Number(body.latitude || 0),longitude:Number(body.longitude || 0),
      source:canHost(account) ? "host" : "tenant-share",
      verified:false,status:"active",accent:["emerald","amber","blue","rose"][db.listings.length%4],
      createdAt:new Date().toISOString()
    };
    db.listings.unshift(listing);
    await writeDb(db);
    return json(res,201,{listing:listingPayload(listing,db,account)});
  }

  const listingMatch = route.match(/^\/api\/listings\/([^/]+)$/);
  if (listingMatch && method === "PATCH") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === listingMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    if (listing.ownerId !== account.id) return error(res,403,"You cannot edit this property");
    const body = await parseBody(req);
    ["title","area","university","type","description","status"].forEach(key => {
      if (body[key] !== undefined) listing[key] = String(body[key]).trim();
    });
    ["price","bedrooms","bathrooms","latitude","longitude"].forEach(key => {
      if (body[key] !== undefined) listing[key] = Number(body[key]);
    });
    await writeDb(db);
    return json(res,200,{listing:listingPayload(listing,db,account)});
  }

  const inspectionMatch = route.match(/^\/api\/listings\/([^/]+)\/inspections$/);
  if (inspectionMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return error(res,403,"Only tenants can request an inspection");
    const listing = db.listings.find(item => item.id === inspectionMatch[1] && item.status === "active");
    if (!listing) return error(res,404,"Property not found");
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
    await writeDb(db);
    return json(res,201,{inspection});
  }

  if (route === "/api/reports" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
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
    await writeDb(db);
    return json(res,201,{report});
  }

  const saveMatch = route.match(/^\/api\/listings\/([^/]+)\/save$/);
  if (saveMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const index = db.saved.findIndex(item => item.userId === account.id && item.listingId === saveMatch[1]);
    if (index >= 0) db.saved.splice(index,1); else db.saved.push({userId:account.id,listingId:saveMatch[1]});
    await writeDb(db);
    return json(res,200,{saved:index<0});
  }

  const contactMatch = route.match(/^\/api\/listings\/([^/]+)\/contact$/);
  if (contactMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const listing = db.listings.find(item => item.id === contactMatch[1]);
    if (!listing) return error(res,404,"Property not found");
    let conversation = db.conversations.find(item => item.listingId === listing.id && item.memberIds.includes(account.id) && item.memberIds.includes(listing.ownerId));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,listing.ownerId],listingId:listing.id,updatedAt:new Date().toISOString()};
      db.conversations.push(conversation);
      db.messages.push({id:id("msg"),conversationId:conversation.id,senderId:account.id,text:`Hi, I am interested in ${listing.title}. Is it still available?`,createdAt:new Date().toISOString()});
    }
    await writeDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  const messagesMatch = route.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    const conversation = db.conversations.find(item => item.id === messagesMatch[1] && item.memberIds.includes(account.id));
    if (!conversation) return error(res,404,"Conversation not found");
    const messages = db.messages.filter(item => item.conversationId === conversation.id).sort((a,b) => a.createdAt.localeCompare(b.createdAt));
    return json(res,200,{messages});
  }
  if (messagesMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const conversation = db.conversations.find(item => item.id === messagesMatch[1] && item.memberIds.includes(account.id));
    if (!conversation) return error(res,404,"Conversation not found");
    const body = await parseBody(req);
    const text = String(body.text || "").trim();
    if (!text) return error(res,400,"Message cannot be empty");
    const message = {id:id("msg"),conversationId:conversation.id,senderId:account.id,text:text.slice(0,2000),createdAt:new Date().toISOString()};
    db.messages.push(message); conversation.updatedAt=message.createdAt;
    await writeDb(db);
    return json(res,201,{message});
  }

  if (route === "/api/roommates" && method === "GET") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return json(res,200,{matches:[]});
    const matches = db.users.filter(item => item.role === "tenant" && item.id !== account.id).map(candidate => {
      const sameUniversity = candidate.university === account.university;
      const sharedHabits = (candidate.habits || []).filter(habit => (account.habits || []).includes(habit)).length;
      const budgetClose = account.budget && candidate.budget ? Math.abs(account.budget-candidate.budget)<=150000 : false;
      return {...publicUser(candidate),score:Math.min(98,62+(sameUniversity?20:0)+(sharedHabits*5)+(budgetClose?6:0))};
    }).sort((a,b)=>b.score-a.score);
    return json(res,200,{matches});
  }

  if (route === "/api/roommates/connect" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const body = await parseBody(req);
    const candidate = db.users.find(item => item.id === body.userId && item.role === "tenant");
    if (!candidate) return error(res,404,"Student not found");
    let conversation = db.conversations.find(item => !item.listingId && item.memberIds.includes(account.id) && item.memberIds.includes(candidate.id));
    if (!conversation) {
      conversation = {id:id("con"),memberIds:[account.id,candidate.id],listingId:null,updatedAt:new Date().toISOString()};
      db.conversations.push(conversation);
      db.messages.push({id:id("msg"),conversationId:conversation.id,senderId:account.id,text:"Hi! Offkay matched us as potential roommates. Would you like to chat?",createdAt:new Date().toISOString()});
    }
    await writeDb(db);
    return json(res,200,{conversationId:conversation.id});
  }

  if (route === "/api/bookings" && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    if (account.role !== "tenant") return error(res,403,"Only tenants can book a property");
    const body = await parseBody(req);
    const listing = db.listings.find(item => item.id === body.listingId && item.status === "active");
    if (!listing) return error(res,404,"Property not found");
    const booking = {
      id:id("bkg"),listingId:listing.id,tenantId:account.id,ownerId:listing.ownerId,
      amount:listing.price,platformFee:0,
      splitCount:Math.min(4,Math.max(1,Number(body.splitCount || 1))),
      status:"awaiting_payment",createdAt:new Date().toISOString()
    };
    db.bookings.push(booking);
    await writeDb(db);
    return json(res,201,{booking});
  }

  const payMatch = route.match(/^\/api\/bookings\/([^/]+)\/confirm-payment$/);
  if (payMatch && method === "POST") {
    const account = requireUser(req,res,db); if (!account) return;
    const booking = db.bookings.find(item => item.id === payMatch[1] && item.tenantId === account.id);
    if (!booking) return error(res,404,"Booking not found");
    booking.status="paid"; booking.paidAt=new Date().toISOString(); booking.reference=`HH-${Date.now()}`;
    await writeDb(db);
    return json(res,200,{booking});
  }

  return error(res,404,"API route not found");
}

const mime = {
  ".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"
};

function serveStatic(req,res,url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const requested = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!requested.startsWith(PUBLIC_DIR)) return error(res,403,"Forbidden");
  fs.stat(requested,(err,stats)=>{
    if (err || !stats.isFile()) {
      const index = path.join(PUBLIC_DIR,"index.html");
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      return fs.createReadStream(index).pipe(res);
    }
    res.writeHead(200,{"Content-Type":mime[path.extname(requested)] || "application/octet-stream","Cache-Control":"no-cache"});
    fs.createReadStream(requested).pipe(res);
  });
}

ensureDb();
async function handler(req,res) {
  const url = new URL(req.url,`http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req,res,url);
    return serveStatic(req,res,url);
  } catch (err) {
    console.error(err);
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
