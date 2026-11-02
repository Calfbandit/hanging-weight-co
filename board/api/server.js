#!/usr/bin/env node
// Hanging Weight Co. collector: the website (hangingweightco.com) reports visits, calculator use,
// emails left, $197 bookings and $2,000 interest here; the owner board reads the totals back.
// Runs on 127.0.0.1 behind Caddy. Built-in modules only.
//
//   PUBLIC  POST /api/collect        from the website (CORS: Allen's site origins only), rate-limited
//   PUBLIC  POST /api/stripe         optional Stripe webhook (needs STRIPE_WEBHOOK_SECRET) to confirm payments
//   SIGNED-IN ONLY (Caddy forward_auth, same as the board):
//           GET  /api/summary        numbers + lists for the board
//           POST /api/mark           {id, set:{status|confirmed_time|offered|note}} to save Allen's marks
//           /api/google/*, /api/inbox, /api/thread, /api/reply, /api/calendar/*, /api/agents
//                                    Allen's Gmail + Google Calendar (api/google.js)
//
// Data: $HW_DATA/events.jsonl (default /var/lib/hw-board), one JSON line per event. Nothing secret in code:
// env HW_ORIGINS, NOTIFY_EMAIL, FROM_EMAIL, SENDGRID_API_KEY, STRIPE_WEBHOOK_SECRET,
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, HW_TOKEN_KEY (see api/google.js).
"use strict";
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA = process.env.HW_DATA || "/var/lib/hw-board";
const FILE = path.join(DATA, "events.jsonl");
const PORT = Number(process.env.HW_API_PORT || 8791);
const HOST = process.env.HW_API_HOST || "127.0.0.1";
const ORIGINS = new Set(["https://hangingweightco.com", "https://www.hangingweightco.com", "https://calfbandit.github.io",
  ...String(process.env.HW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)]);
const TYPES = new Set(["visit", "calc_open", "calc_done", "lead", "package_interest", "booking", "booking_paid"]);
const NOTIFY = { lead: "New calculator lead", package_interest: "Package interest", booking: "New booking", booking_paid: "Booking paid" };
const MAX_BODY = 16 * 1024;
const DAY = 86400000;

/* ---------- storage ---------- */
fs.mkdirSync(DATA, { recursive: true });
let cache = null, cacheSize = -1;
function readAll() {
  let size = 0;
  try { size = fs.statSync(FILE).size; } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  if (cache && size === cacheSize) return cache;
  const out = [];
  for (const line of fs.readFileSync(FILE, "utf8").split("\n")) { if (!line) continue; try { out.push(JSON.parse(line)); } catch {} }
  cache = out; cacheSize = size;
  return out;
}
function append(rec) { fs.appendFileSync(FILE, JSON.stringify(rec) + "\n", { mode: 0o600 }); }
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

/* ---------- input hygiene ---------- */
function clean(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 4000);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clean(x, depth + 1));
  if (typeof v === "object") { const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k.slice(0, 40)] = clean(v[k], depth + 1); return o; }
  return null;
}
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 60;
}
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > max) { reject(Object.assign(new Error("too big"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function send(res, status, obj, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(JSON.stringify(obj));
}
function cors(req) {
  const o = req.headers.origin;
  return o && ORIGINS.has(o) ? { "Access-Control-Allow-Origin": o, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } : { "Vary": "Origin" };
}

/* ---------- optional email to Allen (SendGrid) ---------- */
function notify(rec) {
  const key = process.env.SENDGRID_API_KEY, to = process.env.NOTIFY_EMAIL || "theherd@herddirect.net", from = process.env.FROM_EMAIL;
  if (!key || !from || !NOTIFY[rec.type]) return;
  const d = rec.data || {};
  const who = d.name || d.email || (rec.type === "booking_paid" ? (d.booking_id || "") : "someone");
  const lines = Object.entries(d).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  const body = JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, name: "Hanging Weight Co. board" },
    subject: `${NOTIFY[rec.type]} – ${String(who).slice(0, 80)}`,
    content: [{ type: "text/plain", value: `${lines.join("\n")}\n\nSee it on your board: ${process.env.BOARD_URL || "https://board.hangingweightco.com"}/#calls` }] });
  const r = https.request({ hostname: "api.sendgrid.com", path: "/v3/mail/send", method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => res.resume());
  r.on("error", () => {}); r.end(body);
}

/* ---------- Stripe webhook (optional) ---------- */
function stripeOk(raw, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(p => p.split("=")));
  const t = Number(parts.t); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  const sigs = String(header).split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  return sigs.some(s => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}

/* ---------- summary for the board ---------- */
const CENTRAL = "America/Chicago";
function weekStart(ts) { // Monday of that week, Central time, as YYYY-MM-DD
  const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: CENTRAL }));
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function summary() {
  const all = readAll();
  const marks = {};
  for (const e of all) if (e.type === "mark" && e.target) marks[e.target] = { ...(marks[e.target] || {}), ...e.set, at: e.at };
  const ev = all.filter(e => TYPES.has(e.type));
  const nowWeek = weekStart(Date.now());
  const weeks = []; for (let i = 7; i >= 0; i--) weeks.push(weekStart(Date.now() - i * 7 * DAY));
  const blank = () => ({ visits: 0, calc: 0, email: 0, book: 0, paid: 0, pkg: 0 });
  const byWeek = Object.fromEntries(weeks.map(w => [w, { t: blank(), src: {} , vids: new Set() }]));
  const firstSrc = {};
  for (const e of ev) if (e.vid && !firstSrc[e.vid]) firstSrc[e.vid] = e.src || "direct";
  const key = { visit: "visits", calc_open: "calc", lead: "email", booking: "book", booking_paid: "paid", package_interest: "pkg" };
  for (const e of ev) {
    const w = byWeek[weekStart(e.at)]; if (!w || !key[e.type]) continue;
    const src = firstSrc[e.vid] || e.src || "direct";
    w.src[src] = w.src[src] || blank();
    if (e.type === "visit") { const k = `${e.vid}`; if (w.vids.has(k)) continue; w.vids.add(k); }
    if (e.type === "calc_open") { const k = `c:${e.vid}`; if (w.vids.has(k)) continue; w.vids.add(k); }
    w.t[key[e.type]]++; w.src[src][key[e.type]]++;
  }
  const paidIds = new Set(ev.filter(e => e.type === "booking_paid").map(e => e.data && e.data.booking_id));
  const verified = new Set(all.filter(e => e.type === "stripe_paid").map(e => e.booking_id));
  const pick = (type, n = 60) => ev.filter(e => e.type === type).slice(-n).reverse();
  // Marks (Allen's taps + calendar confirm/move/cancel from api/google.js) ride along as `mark`, and the calendar
  // fields are also copied onto the booking itself: status, confirmed_time, event_id, event_start, meet_link.
  const bookings = pick("booking").map(e => { const mk = marks[e.id] || null;
    return { id: e.id, at: e.at, src: firstSrc[e.vid] || e.src, ...e.data,
      paid: verified.has(e.id) ? "verified" : paidIds.has(e.id) ? "reported" : "no", mark: mk,
      status: mk && mk.status || "new", confirmed_time: mk && mk.confirmed_time || null, event_id: mk && mk.event_id || null,
      event_start: mk && mk.event_start || null, meet_link: mk && mk.meet_link || null }; });
  return {
    live: ev.length > 0, total: ev.length, generated: new Date().toISOString(), timezone: CENTRAL,
    weeks: weeks.map(w => ({ week: w, totals: byWeek[w].t, sources: byWeek[w].src })), this_week: nowWeek,
    bookings, leads: pick("lead").map(e => ({ id: e.id, at: e.at, src: firstSrc[e.vid] || e.src, ...e.data, mark: marks[e.id] || null })),
    package_interest: pick("package_interest").map(e => ({ id: e.id, at: e.at, src: firstSrc[e.vid] || e.src, ...e.data, mark: marks[e.id] || null })),
    calculations: pick("calc_done", 30).map(e => ({ at: e.at, ...e.data })),
  };
}

/* ---------- Allen's Gmail + Google Calendar (signed-in only) ---------- */
const google = require("./google")({ readAll, append, newId, readBody, send, DATA });

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (p === "/api/collect") {
    const h = cors(req);
    if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
    if (req.method !== "POST") return send(res, 405, { ok: false }, h);
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) return send(res, 403, { ok: false }, h);
    if (limited(ip)) return send(res, 429, { ok: false, error: "slow down" }, h);
    let body; try { body = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch { return send(res, 400, { ok: false }, h); }
    if (!TYPES.has(body.type)) return send(res, 400, { ok: false, error: "type" }, h);
    const rec = { id: newId(), at: new Date().toISOString(), type: body.type, vid: String(body.vid || "").slice(0, 64), src: String(body.src || "direct").slice(0, 80),
      page: String(body.page || "").slice(0, 200), data: clean(body.data || {}), ip: crypto.createHash("sha256").update(ip + "hwc").digest("hex").slice(0, 16) };
    append(rec); notify(rec);
    return send(res, 200, { ok: true, id: rec.id }, h);
  }
  if (p === "/api/stripe" && req.method === "POST") {
    const raw = (await readBody(req)).toString("utf8");
    if (!stripeOk(raw, req.headers["stripe-signature"])) return send(res, 400, { ok: false });
    let evt; try { evt = JSON.parse(raw); } catch { return send(res, 400, { ok: false }); }
    if (evt.type === "checkout.session.completed") {
      const s = evt.data && evt.data.object || {};
      append({ id: newId(), at: new Date().toISOString(), type: "stripe_paid", booking_id: s.client_reference_id || null, amount: (s.amount_total || 0) / 100, email: s.customer_details && s.customer_details.email || null });
    }
    return send(res, 200, { ok: true });
  }
  // Everything below is behind Caddy's forward_auth (signed-in owner/admin only).
  if (p === "/api/summary" && req.method === "GET") return send(res, 200, summary());
  if (p === "/api/mark" && req.method === "POST") {
    let b; try { b = JSON.parse((await readBody(req)).toString("utf8")); } catch { return send(res, 400, { ok: false }); }
    if (!b || typeof b.id !== "string") return send(res, 400, { ok: false });
    const allowed = ["status", "confirmed_time", "offered", "note"], set = {};
    for (const k of allowed) if (b.set && k in b.set) set[k] = clean(b.set[k]);
    append({ id: newId(), at: new Date().toISOString(), type: "mark", target: b.id.slice(0, 64), set });
    return send(res, 200, { ok: true });
  }
  if (await google.handle(req, res, url)) return;
  return send(res, 404, { ok: false });
}

if (require.main === module) {
  http.createServer((req, res) => handle(req, res).catch(e => send(res, e.status || 500, { ok: false })))
    .listen(PORT, HOST, () => console.log(`hw-board api on ${HOST}:${PORT}, data in ${FILE}`));
}
module.exports = { summary, handle };
