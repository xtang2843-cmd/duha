"use strict";

/**
 * duha — full-stack server
 * Zero runtime dependencies: Node's built-in http, fetch, sqlite and crypto.
 *
 * Endpoints
 *   GET  /api/health
 *   GET  /api/markets           proxied + cached CoinGecko market data
 *   GET  /api/global            proxied + cached global stats
 *   GET  /api/watchlist         anonymous, cookie-scoped watchlist
 *   PUT  /api/watchlist
 *   POST /api/subscribe         newsletter signup (stored in SQLite)
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV || "development";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(DATA_DIR, "duha.db"));
const COINGECKO_BASE = (process.env.COINGECKO_BASE || "https://api.coingecko.com/api/v3").replace(/\/+$/, "");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const COOKIE_SECURE = process.env.COOKIE_SECURE || "auto";
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");

const SESSION_COOKIE = "duha_sid";
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;
const MAX_BODY = 16 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MARKET_TTL = 60 * 1000;
const GLOBAL_TTL = 5 * 60 * 1000;
const GECKO_MARKETS_URL =
  `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc` +
  "&per_page=12&page=1&sparkline=true&price_change_percentage=24h";

/* ---------------- logging ---------------- */

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/* ---------------- database ---------------- */

let db;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS subscribers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'site',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlists (
      session_id TEXT PRIMARY KEY,
      coins TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
} catch (error) {
  console.error(`[duha] cannot open database at ${DB_PATH}: ${error.message}`);
  process.exit(1);
}

const statements = {
  getWatchlist: db.prepare("SELECT coins, updated_at FROM watchlists WHERE session_id = ?"),
  saveWatchlist: db.prepare(`
    INSERT INTO watchlists (session_id, coins, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET coins = excluded.coins, updated_at = excluded.updated_at
  `),
  addSubscriber: db.prepare(`
    INSERT INTO subscribers (email, source, created_at) VALUES (?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `),
};

/* ---------------- upstream cache ---------------- */

const caches = {
  markets: { data: null, at: 0, pending: null },
  global: { data: null, at: 0, pending: null },
};

async function getCached(cache, url, ttl, transform) {
  if (cache.data && Date.now() - cache.at < ttl) {
    return { data: cache.data, at: cache.at, cached: true };
  }

  if (!cache.pending) {
    cache.pending = (async () => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: "application/json", "user-agent": "duha/1.0" },
      });
      if (!response.ok) throw new Error(`CoinGecko returned ${response.status}`);
      const payload = await response.json();
      const data = transform(payload);
      cache.data = data;
      cache.at = Date.now();
      return { data, at: cache.at, cached: false };
    })();
  }

  const pending = cache.pending;
  try {
    return await pending;
  } catch (error) {
    if (cache.data) {
      return { data: cache.data, at: cache.at, cached: true, stale: true };
    }
    throw error;
  } finally {
    if (cache.pending === pending) cache.pending = null;
  }
}

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

function transformMarkets(payload) {
  if (!Array.isArray(payload)) throw new Error("Unexpected markets payload");
  const coins = payload.slice(0, 12).map((coin) => ({
    id: String(coin.id || ""),
    symbol: String(coin.symbol || ""),
    name: String(coin.name || ""),
    image: String(coin.image || ""),
    current_price: number(coin.current_price),
    market_cap: number(coin.market_cap),
    market_cap_rank: number(coin.market_cap_rank),
    total_volume: number(coin.total_volume),
    price_change_percentage_24h: number(coin.price_change_percentage_24h),
    circulating_supply: number(coin.circulating_supply),
    sparkline_in_7d: {
      price: (Array.isArray(coin.sparkline_in_7d?.price) ? coin.sparkline_in_7d.price : [])
        .filter((price) => Number.isFinite(Number(price)))
        .map(Number)
        .slice(-168),
    },
  }));
  if (!coins.length) throw new Error("Empty markets payload");
  return coins;
}

function transformGlobal(payload) {
  const data = payload && payload.data ? payload.data : payload;
  const global = {
    total_market_cap: { usd: number(data?.total_market_cap?.usd) },
    total_volume: { usd: number(data?.total_volume?.usd) },
    market_cap_percentage: { btc: number(data?.market_cap_percentage?.btc) },
    active_cryptocurrencies: number(data?.active_cryptocurrencies),
  };
  if (!global.total_market_cap.usd) throw new Error("Empty global payload");
  return global;
}

/* ---------------- rate limiting ---------------- */

const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.reset) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

/* ---------------- helpers ---------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers["content-type"] || "");
    if (!type.toLowerCase().includes("application/json")) {
      reject(new HttpError(415, "Expected application/json"));
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, "Request body is too large"));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function cookieMap(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    try {
      out[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      out[key] = part.slice(index + 1).trim();
    }
  }
  return out;
}

function secureCookies(req) {
  if (COOKIE_SECURE === "always") return true;
  if (COOKIE_SECURE === "never") return false;
  return req.headers["x-forwarded-proto"] === "https" || Boolean(req.socket.encrypted);
}

function sessionId(req, res) {
  const existing = cookieMap(req)[SESSION_COOKIE];
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;

  const sid = crypto.randomBytes(16).toString("hex");
  const attrs = [
    `${SESSION_COOKIE}=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (secureCookies(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
  return sid;
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
    if (req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]);
  }
  return req.socket.remoteAddress || "unknown";
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function parseWatchlist(raw) {
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map(String))].filter((id) => ID_RE.test(id)).slice(0, 50);
  } catch {
    return [];
  }
}

/* ---------------- api ---------------- */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === "/api/health") {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    let database = "ok";
    try {
      db.prepare("SELECT 1 AS ok").get();
    } catch {
      database = "error";
    }
    sendJson(res, database === "ok" ? 200 : 503, {
      ok: database === "ok",
      service: "duha",
      database,
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
    return;
  }

  if (route === "/api/markets") {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    try {
      const result = await getCached(caches.markets, GECKO_MARKETS_URL, MARKET_TTL, transformMarkets);
      sendJson(res, 200, {
        ok: true,
        source: "coingecko",
        cached: Boolean(result.cached),
        stale: Boolean(result.stale),
        updatedAt: new Date(result.at).toISOString(),
        data: result.data,
      });
    } catch (error) {
      log("markets upstream failed:", error.message);
      sendJson(res, 503, {
        ok: false,
        demo: true,
        error: "Market data is temporarily unavailable.",
      }, { "Retry-After": "30" });
    }
    return;
  }

  if (route === "/api/global") {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
    try {
      const result = await getCached(caches.global, `${COINGECKO_BASE}/global`, GLOBAL_TTL, transformGlobal);
      sendJson(res, 200, {
        ok: true,
        source: "coingecko",
        cached: Boolean(result.cached),
        stale: Boolean(result.stale),
        updatedAt: new Date(result.at).toISOString(),
        data: result.data,
      });
    } catch (error) {
      log("global upstream failed:", error.message);
      sendJson(res, 503, { ok: false, demo: true, error: "Global stats are temporarily unavailable." });
    }
    return;
  }

  if (route === "/api/watchlist") {
    const sid = sessionId(req, res);

    if (req.method === "GET") {
      const row = statements.getWatchlist.get(sid);
      sendJson(res, 200, {
        ok: true,
        coins: row ? parseWatchlist(row.coins) : [],
        updatedAt: row ? row.updated_at : null,
      });
      return;
    }

    if (req.method === "PUT") {
      if (!isSameOrigin(req)) throw new HttpError(403, "Cross-origin request refused");
      if (!rateLimit(`${clientIp(req)}:watchlist`, 120, 60 * 1000)) {
        throw new HttpError(429, "Too many updates, slow down");
      }
      const body = await readJson(req);
      if (!Array.isArray(body.coins)) throw new HttpError(400, "coins must be an array");
      const coins = [...new Set(body.coins.map(String))]
        .filter((id) => ID_RE.test(id))
        .slice(0, 50);
      const updatedAt = new Date().toISOString();
      statements.saveWatchlist.run(sid, JSON.stringify(coins), updatedAt);
      sendJson(res, 200, { ok: true, coins, updatedAt });
      return;
    }

    throw new HttpError(405, "Method not allowed");
  }

  if (route === "/api/subscribe") {
    if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
    if (!isSameOrigin(req)) throw new HttpError(403, "Cross-origin request refused");
    if (!rateLimit(`${clientIp(req)}:subscribe`, 8, 60 * 60 * 1000)) {
      throw new HttpError(429, "Too many signups from this address");
    }
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      throw new HttpError(400, "Please enter a valid email address");
    }
    const source = String(body.source || "site").slice(0, 40);
    statements.addSubscriber.run(email, source, new Date().toISOString());
    sendJson(res, 200, { ok: true });
    return;
  }

  throw new HttpError(404, "Unknown API route");
}

/* ---------------- static files ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const gzipCache = new Map();

function notFound(res) {
  sendText(res, 404, "Not found");
}

async function serveStatic(req, res, pathname) {
  let filePath = null;

  if (pathname === "/" || pathname === "/index.html") {
    filePath = path.join(ROOT, "index.html");
  } else if (pathname === "/legal" || pathname === "/legal.html") {
    filePath = path.join(ROOT, "legal.html");
  } else if (pathname.startsWith("/assets/")) {
    const name = pathname.slice("/assets/".length);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      notFound(res);
      return;
    }
    filePath = path.join(ROOT, "assets", name);
  } else if (pathname === "/robots.txt") {
    filePath = path.join(ROOT, "robots.txt");
  }

  if (!filePath) {
    notFound(res);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    notFound(res);
    return;
  }
  if (!stat.isFile()) {
    notFound(res);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const isHtml = ext === ".html";
  const cacheControl = isHtml ? "no-cache" : "public, max-age=300";

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": cacheControl });
    res.end();
    return;
  }

  let body = await fsp.readFile(filePath);

  if (type.startsWith("text/") && /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""))) {
    const key = `${filePath}:${stat.mtimeMs}`;
    let compressed = gzipCache.get(key);
    if (!compressed) {
      compressed = zlib.gzipSync(body);
      gzipCache.set(key, compressed);
      if (gzipCache.size > 50) {
        const oldest = gzipCache.keys().next().value;
        gzipCache.delete(oldest);
      }
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": compressed.length,
      "Content-Encoding": "gzip",
      Vary: "Accept-Encoding",
      ETag: etag,
      "Cache-Control": cacheControl,
    });
    res.end(req.method === "HEAD" ? undefined : compressed);
    return;
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    ETag: etag,
    "Cache-Control": cacheControl,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/* ---------------- server ---------------- */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://api.coingecko.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

function securityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", CSP);
  if (req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) log("api error:", error.message);
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          error: status >= 500 ? "Something went wrong. Please try again." : error.message,
        }, status === 429 ? { "Retry-After": "300" } : {});
      }
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendText(res, 405, "Method not allowed");
    return;
  }

  try {
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    log("static error:", error.message);
    if (!res.headersSent) sendText(res, 500, "Server error");
  }
});

server.listen(PORT, HOST, () => {
  log(`duha listening on http://${HOST}:${PORT}`);
  log(`database: ${DB_PATH}`);
  log(`environment: ${NODE_ENV}${SITE_URL ? ` · ${SITE_URL}` : ""}`);
});

function shutdown(signal) {
  log(`${signal} received, closing`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
