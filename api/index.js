const { handler } = require("../server");
const { MongoClient } = require("mongodb");

// ---- Public, secret-free health diagnostic -------------------------------
// GET /api/health pings the database and reports the exact failure code so a
// broken Atlas link can be diagnosed straight from the browser. It never
// returns credentials or the connection string.
const MONGODB_URI = process.env.MONGODB_URI || "";
const USE_MONGODB = Boolean(MONGODB_URI);

let healthClientPromise = null;
function healthConnect() {
  if (!healthClientPromise) {
    healthClientPromise = new MongoClient(MONGODB_URI, {
      maxPoolSize: 2,
      serverSelectionTimeoutMS: 8_000,
      connectTimeoutMS: 8_000,
      socketTimeoutMS: 20_000,
      retryWrites: true
    }).connect()
      .then(client => client.db(process.env.MONGODB_DB || "offkay"))
      .catch(err => { healthClientPromise = null; throw err; });
  }
  return healthClientPromise;
}

function classifyDbError(lastError) {
  const reason = String(lastError?.message || lastError?.code || "").toLowerCase();
  let hint = "In Atlas, open Network Access and allow connections from anywhere (0.0.0.0/0), then refresh.";
  if (/auth|sasl|illegal|username|password/.test(reason)) hint = "The database username or password in MONGODB_URI is wrong - re-copy the connection string from Atlas.";
  else if (/srv|querysrv|enotfound|getaddrinfo|dns/.test(reason)) hint = "The cluster hostname could not be resolved - re-copy the connection string from Atlas.";
  const codeMatch = String([lastError?.code, lastError?.codeName, lastError?.message].filter(Boolean).join(" ")).match(/(querySrv \w+|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ESERVFAIL|authentication failed|bad auth|illegal scheme|invalid scheme|tlsv\d+|SSL[ \w]+|connection closed|timed out)/i);
  const code = String(lastError?.codeName || lastError?.code || (codeMatch && codeMatch[0]) || "unknown").slice(0, 48);
  return { hint, code };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function healthResponse(res) {
  const body = {
    ok: true,
    mode: USE_MONGODB ? "mongodb" : "file",
    paymentsEnabled: Boolean(process.env.PAYSTACK_SECRET_KEY),
    time: new Date().toISOString()
  };
  if (!USE_MONGODB) return sendJson(res, 200, body);
  try {
    const database = await Promise.race([
      healthConnect(),
      new Promise((unused, reject) => setTimeout(() => reject(Object.assign(new Error("connection timed out after 9s"), { code: "ETIMEDOUT" })), 9_000))
    ]);
    await database.admin().command({ ping: 1 });
    return sendJson(res, 200, body);
  } catch (err) {
    console.error("Health check DB failure:", err?.message);
    const { hint, code } = classifyDbError(err);
    return sendJson(res, 503, { ...body, ok: false, code, hint });
  }
}

// ---- Nested API path delegation (unchanged) -------------------------------
module.exports = (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.searchParams.get("path");

  if (path === "health") return healthResponse(res);

  if (path) {
    url.searchParams.delete("path");
    const query = url.searchParams.toString();
    req.url = `/api/${decodeURIComponent(path)}${query ? `?${query}` : ""}`;
  }

  return handler(req, res);
};
