// Allen's Gmail + Google Calendar for the owner board. Required by api/server.js; built-in modules only (Node 22).
//
// Every route here sits behind Caddy's forward_auth (signed-in owner/admin only), like /api/summary.
//   GET  /api/google/start        302 to Google's consent screen
//   GET  /api/google/callback     Google sends Allen back here; stores the (encrypted) refresh token, 302 to /#inbox?connected
//   GET  /api/google/status       {connected, configured, email, connected_at, error?}
//   POST /api/google/disconnect   revoke at Google (best effort) + delete the stored token
//   GET  /api/inbox               booked ranchers + their recent Gmail threads
//   GET  /api/thread?id=&markread=1   one thread, as plain text
//   POST /api/reply               {to, subject, body, threadId?, inReplyTo?} send from Allen's Gmail (ranchers/leads only)
//   GET  /api/calendar/free?days=7    open 60-minute slots, Mon–Sat 8:00–18:00 Central
//   GET  /api/calendar/calls      upcoming booking calls on Allen's calendar
//   POST /api/calendar/confirm    {booking_id, start} create the call + invite the rancher (Meet link for video)
//   POST /api/calendar/move       {booking_id, event_id, start}
//   POST /api/calendar/cancel     {booking_id, event_id}
//   GET  /api/agents?fresh=1      each helper's latest email in Gmail + drafts waiting in "Ready to send" (cached 5 min)
//
// Response shapes (errors are always {ok:false, error:"plain English"}; 409 adds connected:false when Gmail isn't connected):
//   status     {connected, configured, email, connected_at, error?}
//   inbox      {connected:true, email, ranchers:[{booking_id, name, email, ranch, how:"phone"|"video", booked_at, status, confirmed_time,
//               threads:[{id, subject, snippet, last_at, unread, count}], error?}]}
//   thread     {id, subject, messages:[{id, from, to, at, text, mine, message_id}], reply:{to, subject, threadId, inReplyTo}}
//   reply      {ok, id, threadId}                       (429 after 30 sends in an hour; 403 if `to` isn't a rancher/lead)
//   free       {timezone:"America/Chicago", slots:[{start, end, label:"Mon Nov 2 · 9:00 AM"}]}
//   calls      {calls:[{event_id, booking_id, start, end, label, how, meet_link, attendee_email, attendee_response, status}]}
//   confirm    {ok, event_id, meet_link, label}         (409 if already confirmed: use move)
//   move       {ok, event_id, label}      cancel {ok}
//   agents     {ok, agents:[{id, name, last_at, last_subject, earlier_at (newest email older than 2 weeks, only looked up when last_at is null), last_kind:"email"|"draft"|null, count_14d, drafts:number|null}],
//               drafts_ready, ready_label, checked_at}
//
// Secrets come from the environment only (/etc/hw-board/api.env): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, HW_TOKEN_KEY.
// The refresh token is stored AES-256-GCM encrypted in $HW_DATA/google.json (chmod 600). Tokens never leave this process.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TZ = "America/Chicago";
const HOUR = 3600000, DAY = 86400000;
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events"];
const AAD = Buffer.from("hw-board-google-v1");
const BOOKING_TAG = "Hanging Weight Co. booking:";
const MAX_TEXT = 20000;
const SENDS_PER_HOUR = 30;
const READY_LABEL = "ready to send";

const cfg = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  redirect: process.env.GOOGLE_REDIRECT_URI || "https://board.hangingweightco.com/api/google/callback",
  oauth: (process.env.GOOGLE_OAUTH_BASE || "https://oauth2.googleapis.com").replace(/\/$/, ""),
  authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
  api: (process.env.GOOGLE_API_BASE || "https://www.googleapis.com").replace(/\/$/, ""),
  gmail: (process.env.GMAIL_API_BASE || "https://gmail.googleapis.com").replace(/\/$/, ""),
});

/* ---------- the 20 helpers: what their emails/drafts are called (from handover/helpers/*.md) ---------- */
// email:  subjects of emails the helper sends to Allen (or, for draft writers, drafts Allen has sent)
// drafts: subjects of drafts it leaves in "Ready to send" (null = subjects vary, can't tell whose they are)
// sentOnly: only count mail Allen sent (draft writers; a rancher's "Re:" must not count)
const DASH = "\\s*[–—-]";
const APOS = "['’]";
const re = s => new RegExp(s, "i");
const HELPERS = [
  { id: "finder", name: "Rancher Finder", q: ['"Rancher Finder"'], email: [re(`^Rancher Finder${DASH}`)], drafts: null },
  { id: "outreach", name: "Outreach", q: ['"Outreach" "mailing address"'], email: [re(`^Outreach${DASH}\\s*please add your mailing address`)], drafts: null },
  { id: "articles", name: "Article Writer", q: ['"Article draft"'], email: [re(`^Article draft${DASH}`)], drafts: null },
  { id: "social", name: "Post Writer", q: ['"Post draft"'], email: [re(`^Post draft${DASH}`)], drafts: null },
  { id: "partners", name: "Partner Outreach", q: ['"Partner Outreach"'], email: [re(`^Partner Outreach${DASH}`)], drafts: null },
  { id: "referral", name: "Referral", sentOnly: true, q: ['"Thanks for the call"'], email: [re("^Thanks for the call\\b")], drafts: [re("^Thanks for the call\\b")] },
  { id: "helper", name: "Calculator Questions", sentOnly: true,
    q: ['"My beef price sheet"', '"Your beef price sheet"', '"One pricing tip"', '"Last note from me"', '"New calculator lead"'],
    email: [re("^re:\\s*(My beef price sheet|Your beef price sheet|One pricing tip|Last note from me|New calculator lead)")],
    drafts: [re("^re:\\s*(My beef price sheet|Your beef price sheet|One pricing tip|Last note from me|New calculator lead)")] },
  { id: "followup", name: "Follow-Up", sentOnly: true, q: ['"Your beef price sheet"', '"One pricing tip"', '"Last note from me"'],
    email: [re(`^Your beef price sheet${DASH}\\s*thanks`), re("^One pricing tip,"), re("^Last note from me,")],
    drafts: [re(`^Your beef price sheet${DASH}\\s*thanks`), re("^One pricing tip,"), re("^Last note from me,")] },
  // Follow-Up's "You're booked" draft is the same email Booking writes; it is counted under Booking.
  { id: "booking", name: "Booking", sentOnly: true, q: ['"booked"', '"Picking a time for our call"', '"See you tomorrow"', '"link for our video call today"'],
    email: [re(`^You${APOS}re booked${DASH}`), re("^Picking a time for our call"), re(`^See you tomorrow${DASH}`), re(`^Here${APOS}s the link for our video call today`)],
    drafts: [re(`^You${APOS}re booked${DASH}`), re("^Picking a time for our call"), re(`^See you tomorrow${DASH}`), re(`^Here${APOS}s the link for our video call today`)] },
  { id: "prep", name: "Call Prep", q: ['"Call prep"'], email: [re(`^Call prep${DASH}`)], drafts: null },
  { id: "recap", name: "Call Recap", sentOnly: true, q: ['"Your plan from our call"'], email: [re("^Your plan from our call")], drafts: [re("^Your plan from our call")] },
  { id: "upgrade", name: "Upgrade", sentOnly: true, q: ['"The Ranch Store in a Box"'], email: [re("^The Ranch Store in a Box")], drafts: [re("^The Ranch Store in a Box")] },
  { id: "profile", name: "HerdDirect Profile Builder", q: ['"Storefront draft"'], email: [re(`^Storefront draft${DASH}`)], drafts: null },
  { id: "buyers", name: "Local Buyer Finder", q: ['"Local Buyer Finder"'], email: [re(`^Local Buyer Finder${DASH}`)], drafts: null },
  { id: "posts", name: "Client Post Writer", q: ['"Client posts"'], email: [re(`^Client posts${DASH}`)], drafts: null },
  { id: "orders", name: "Order Reminders", sentOnly: true, q: ['"is reserved"', '"Time to send your cut sheet"', '"Your balance for the"', '"Pickup for your beef"'],
    email: [re("^Your .+ from .+ is reserved"), re("^Time to send your cut sheet"), re("^Your balance for the "), re("^Pickup for your beef")],
    drafts: [re("^Your .+ from .+ is reserved"), re("^Time to send your cut sheet"), re("^Your balance for the "), re("^Pickup for your beef")] },
  { id: "report", name: "Client Report", q: ['"Client report"'], email: [re(`^Client report${DASH}`)], drafts: null },
  { id: "watchdog", name: "Website Watchdog", q: ['"Website alert"'], email: [re("^Website alert")], drafts: null },
  { id: "analyst", name: "Weekly Numbers", q: ['"Weekly numbers"'], email: [re(`^Weekly numbers${DASH}`)], drafts: null },
  { id: "driver", name: "Daily Driver", q: ['"your day at Hanging Weight Co"'], email: [re(`^Good morning${DASH}\\s*your day at Hanging Weight Co\\.`)], drafts: null },
];

/* ---------- Central time (DST-safe, via Intl) ---------- */
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function centralParts(ms) {
  const o = {}; for (const p of partsFmt.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute, s: o.second };
}
function offsetAt(ms) { // Central local minus UTC, in ms (e.g. -5h in summer, -6h in winter)
  const p = centralParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
function centralToUtc(y, m, d, h, mi = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(guess);
  const o2 = offsetAt(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}
const labelFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
function slotLabel(ms) { // "Mon Nov 2 · 9:00 AM"
  const o = {}; for (const p of labelFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return `${o.weekday} ${o.month} ${o.day} · ${o.hour}:${o.minute} ${String(o.dayPeriod || "").toUpperCase()}`;
}
// Open 60-minute slots, Mon–Sat, starting 8:00..17:00 Central, from the next full hour for `days` days.
function freeSlots(now, days, busy, max = 40) {
  const first = Math.ceil(now / HOUR) * HOUR, end = now + days * DAY, p = centralParts(now), out = [];
  for (let i = 0; i <= days + 1 && out.length < max; i++) {
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    if (d.getUTCDay() === 0) continue; // Sunday
    for (let h = 8; h < 18 && out.length < max; h++) {
      const s = centralToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h), e = s + HOUR;
      if (s < first || e > end) continue;
      if (busy.some(([bs, be]) => bs < e && be > s)) continue;
      out.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), label: slotLabel(s) });
    }
  }
  return out;
}

/* ---------- small helpers ---------- */
class GErr extends Error { constructor(status, msg, extra = {}) { super(msg); this.status = status; this.extra = extra; } }
const NOT_CONNECTED = "Gmail isn't connected yet. Tap Connect Gmail.";
const notConnected = (msg = NOT_CONNECTED) => Object.assign(new GErr(409, msg, { connected: false }), { fatal: true });
function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return s.length <= 254 && /^[^\s@<>()",;:{}\[\]\\]+@[^\s@<>()",;:{}\[\]\\]+\.[a-z0-9-]{2,}$/.test(s) ? s : null;
}
const addrsIn = s => (String(s || "").toLowerCase().match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) || []).map(normEmail).filter(Boolean);
const oneLine = (s, n) => String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
function u(base, params = {}) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v == null) continue; if (Array.isArray(v)) v.forEach(x => s.append(k, String(x))); else s.append(k, String(v)); }
  const q = s.toString(); return q ? `${base}?${q}` : base;
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
function hdr(msg, name) {
  const n = name.toLowerCase();
  for (const h of (msg && msg.payload && msg.payload.headers) || []) if (String(h.name).toLowerCase() === n) return String(h.value);
  return "";
}
const isoAt = m => new Date(Number(m.internalDate) || 0).toISOString();
function decodeEntities(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(nbsp|lt|gt|quot|apos|#39);/g, (_, e) => ({ nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }[e]))
    .replace(/&amp;/g, "&");
}
function htmlToText(h) {
  return decodeEntities(String(h)
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function findPart(p, type) {
  if (!p) return null;
  const disp = (p.headers || []).find(h => /^content-disposition$/i.test(h.name));
  if (String(p.mimeType || "").toLowerCase() === type && p.body && p.body.data && !p.filename && !(disp && /attachment/i.test(disp.value))) return p;
  for (const c of p.parts || []) { const f = findPart(c, type); if (f) return f; }
  return null;
}
function partText(p) {
  const buf = Buffer.from(p.body.data, "base64url");
  const ct = ((p.headers || []).find(h => /^content-type$/i.test(h.name)) || {}).value || "";
  const cs = (ct.match(/charset="?([^";\s]+)/i) || [])[1] || "utf-8";
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString("utf8"); }
}
function bodyText(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return partText(plain).replace(/\r\n/g, "\n").trim();
  const html = findPart(payload, "text/html");
  return html ? htmlToText(partText(html)) : "";
}

/* ---------- RFC 2822 message ---------- */
function encodeHeader(s) { // RFC 2047 encoded-words for non-ASCII, each word ≤ 75 chars
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = []; let cur = "";
  for (const ch of s) { if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ""; } cur += ch; }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}
function buildRaw({ from, to, subject, body, inReplyTo, references }) {
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  if (inReplyTo) { lines.push(`In-Reply-To: ${inReplyTo}`); lines.push(`References: ${references || inReplyTo}`); }
  const b64 = Buffer.from(String(body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  const raw = `${lines.join("\r\n")}\r\n\r\n${(b64.match(/.{1,76}/g) || []).join("\r\n")}\r\n`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

/* ---------- the routes, bound to server.js's storage ---------- */
function createGoogle({ readAll, append, newId, readBody, send, DATA }) {
  const TOKEN_FILE = path.join(DATA, "google.json");
  const states = new Map();        // OAuth state -> expiry
  let access = null;               // {token, exp}
  let refreshing = null;
  let agentsCache = null;          // {at, body}
  let sends = [];                  // reply timestamps, last hour
  const busyBookings = new Set();  // confirm in progress

  /* token storage */
  function tokenKey() {
    const k = process.env.HW_TOKEN_KEY || "";
    return k.length >= 32 ? crypto.createHash("sha256").update(k).digest() : null;
  }
  function seal(plain) {
    const key = tokenKey(); if (!key) throw new GErr(503, "The server's token key (HW_TOKEN_KEY) isn't set. Ask whoever runs the board's server.");
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); c.setAAD(AAD);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
  }
  function unseal(box) {
    const key = tokenKey(); if (!key) throw new GErr(503, "The server's token key (HW_TOKEN_KEY) isn't set. Ask whoever runs the board's server.");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64")); d.setAAD(AAD); d.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString("utf8");
  }
  function loadStore() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  function saveStore(obj) {
    const tmp = `${TOKEN_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, TOKEN_FILE);
  }
  function dropStore() { try { fs.unlinkSync(TOKEN_FILE); } catch (e) { if (e.code !== "ENOENT") throw e; } access = null; agentsCache = null; }
  const configured = () => { const c = cfg(); return !!(c.clientId && c.clientSecret && tokenKey()); };

  /* talking to Google */
  async function postForm(url, form) {
    let r; try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20000) }); }
    catch { throw new GErr(502, "Couldn't reach Google. Try again in a minute."); }
    let j = {}; try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, j };
  }
  async function doRefresh() {
    const st = loadStore(); if (!st || !st.refresh) throw notConnected(st && st.error || NOT_CONNECTED);
    let rt; try { rt = unseal(st.refresh); } catch (e) { if (e instanceof GErr) throw e; throw notConnected("The saved Google sign-in can't be read (the server key changed). Tap Connect Gmail again."); }
    const c = cfg();
    const r = await postForm(`${c.oauth}/token`, { client_id: c.clientId, client_secret: c.clientSecret, refresh_token: rt, grant_type: "refresh_token" });
    if (!r.ok) {
      if (r.j && r.j.error === "invalid_grant") {
        const msg = "Google access was removed or ran out. Tap Connect Gmail again.";
        saveStore({ v: 1, email: st.email, connected_at: st.connected_at, error: msg, disconnected_at: new Date().toISOString() });
        access = null; agentsCache = null;
        throw notConnected(msg);
      }
      console.error("google refresh failed", r.status, r.j && r.j.error);
      throw new GErr(502, "Couldn't refresh Google access. Try again in a minute.");
    }
    access = { token: r.j.access_token, exp: Date.now() + (Number(r.j.expires_in) || 3600) * 1000 };
    return access.token;
  }
  function accessToken(force) {
    if (!force && access && access.exp - 60000 > Date.now()) return Promise.resolve(access.token);
    if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }
  function upstream(status, j) {
    const err = j && j.error || {}, reason = ((err.errors || [])[0] || {}).reason || err.status || "";
    console.error("google api", status, reason, String(err.message || "").slice(0, 200));
    if (status === 404 || status === 410) return new GErr(status === 410 ? 410 : 404, "Google couldn't find that. It may have been deleted.");
    if (status === 429 || /rate|quota/i.test(reason)) return new GErr(502, "Google is busy. Try again in a minute.");
    if (status === 403 && /insufficient|PERMISSION/i.test(reason + err.message)) return new GErr(502, "Google didn't give the board permission for that. Tap Connect Gmail again and tick every box.");
    if (status === 400) return new GErr(502, "Google turned that request down.");
    return new GErr(502, "Google had a problem. Try again in a minute.");
  }
  async function gapi(method, url, json, retried = false) {
    const token = await accessToken(retried);
    let r;
    try {
      r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) },
        body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(20000) });
    } catch { throw new GErr(502, "Couldn't reach Google. Try again in a minute."); }
    if (r.status === 401) {
      access = null;
      if (!retried) return gapi(method, url, json, true);
      throw Object.assign(new GErr(502, "Google turned down the board's sign-in. Tap Connect Gmail again."), { fatal: true });
    }
    const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok) throw upstream(r.status, j);
    return j || {};
  }
  const GM = () => `${cfg().gmail}/gmail/v1/users/me`;
  const CAL = () => `${cfg().api}/calendar/v3`;
  function connected() { const st = loadStore(); if (!st || !st.refresh) throw notConnected(st && st.error || NOT_CONNECTED); return st; }

  /* board data from events.jsonl */
  function people() {
    const all = readAll(), marks = {}, bookings = [], known = new Set();
    for (const e of all) {
      if (e.type === "mark" && e.target) marks[e.target] = { ...(marks[e.target] || {}), ...e.set };
      if (e.type === "booking" || e.type === "lead" || e.type === "package_interest") { const em = normEmail(e.data && e.data.email); if (em) known.add(em); }
      if (e.type === "booking") bookings.push(e);
    }
    return { marks, bookings, known };
  }
  function findBooking(id) {
    const { marks, bookings } = people();
    const b = typeof id === "string" && bookings.find(e => e.id === id);
    if (!b) throw new GErr(404, "That booking wasn't found.");
    return { b, d: b.data || {}, mark: marks[b.id] || {} };
  }
  function mark(target, set) { append({ id: newId(), at: new Date().toISOString(), type: "mark", target, set }); }
  async function readJson(req, max) {
    let raw; try { raw = await readBody(req, max); } catch (e) { throw new GErr(e.status || 400, "That's too big to send."); }
    try { const j = JSON.parse(raw.toString("utf8") || "{}"); if (j && typeof j === "object") return j; } catch {}
    throw new GErr(400, "The board sent something the server couldn't read.");
  }
  function startTime(v) {
    const t = Date.parse(String(v || ""));
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(String(v || "")) || !Number.isFinite(t)) throw new GErr(400, "Pick a time for the call.");
    if (t < Date.now() - 5 * 60000) throw new GErr(400, "That time has already passed. Pick one that's still ahead.");
    if (t > Date.now() + 366 * DAY) throw new GErr(400, "That time is more than a year away.");
    return t;
  }
  const validEventId = v => typeof v === "string" && /^[a-zA-Z0-9_-]{4,1024}$/.test(v);
  async function ownedEvent(bookingId, eventId) { // refuse to touch calendar events that aren't this booking's call
    if (!validEventId(eventId)) throw new GErr(400, "That calendar event id doesn't look right.");
    const ev = await gapi("GET", `${CAL()}/calendars/primary/events/${encodeURIComponent(eventId)}`);
    if (!String(ev.description || "").includes(`${BOOKING_TAG} ${bookingId}`)) throw new GErr(403, "That calendar event isn't the call for this booking.");
    return ev;
  }
  const meetOf = ev => ev.hangoutLink || ((ev.conferenceData && ev.conferenceData.entryPoints || []).find(p => p.entryPointType === "video") || {}).uri || null;

  /* ----- OAuth ----- */
  function redirect(res, to) { res.writeHead(302, { Location: to, "Cache-Control": "no-store" }); res.end(); }
  async function start(req, res) {
    const c = cfg();
    if (!configured()) throw new GErr(503, "Google isn't set up on the server yet (client id, secret or token key missing). Ask whoever runs the board's server.");
    const now = Date.now();
    for (const [k, exp] of states) if (exp < now) states.delete(k);
    if (states.size > 100) states.clear();
    const state = crypto.randomBytes(24).toString("base64url");
    states.set(state, now + 10 * 60000);
    redirect(res, u(c.authUrl, { client_id: c.clientId, redirect_uri: c.redirect, response_type: "code", scope: SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state }));
  }
  async function callback(req, res, url) {
    const c = cfg(), q = url.searchParams, state = q.get("state") || "", exp = states.get(state);
    if (state) states.delete(state);
    if (q.get("error")) return redirect(res, "/#inbox?google_error=denied");
    if (!exp || exp < Date.now()) return redirect(res, "/#inbox?google_error=expired");
    const code = q.get("code"); if (!code) return redirect(res, "/#inbox?google_error=nocode");
    const r = await postForm(`${c.oauth}/token`, { code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirect, grant_type: "authorization_code" });
    if (!r.ok || !r.j.access_token) { console.error("google code exchange failed", r.status, r.j && r.j.error); return redirect(res, "/#inbox?google_error=exchange"); }
    const granted = String(r.j.scope || "").split(/\s+/);
    if (!SCOPES.slice(2).every(s => granted.includes(s))) {
      postForm(`${c.oauth}/revoke`, { token: r.j.refresh_token || r.j.access_token }).catch(() => {});
      return redirect(res, "/#inbox?google_error=scopes");
    }
    if (!r.j.refresh_token) return redirect(res, "/#inbox?google_error=norefresh");
    let email = null;
    try { email = normEmail(JSON.parse(Buffer.from(String(r.j.id_token || "").split(".")[1] || "", "base64url").toString()).email); } catch {}
    if (!email) {
      try { const ui = await fetch(`${c.api}/oauth2/v3/userinfo`, { headers: { Authorization: `Bearer ${r.j.access_token}` }, signal: AbortSignal.timeout(15000) }); email = normEmail((await ui.json()).email); } catch {}
    }
    if (!email) return redirect(res, "/#inbox?google_error=email");
    saveStore({ v: 1, email, connected_at: new Date().toISOString(), refresh: seal(r.j.refresh_token) });
    access = { token: r.j.access_token, exp: Date.now() + (Number(r.j.expires_in) || 3600) * 1000 };
    agentsCache = null;
    redirect(res, "/#inbox?connected");
  }
  async function status(req, res) {
    const st = loadStore();
    const out = { connected: !!(st && st.refresh), configured: configured(), email: st && st.email || null, connected_at: st && st.connected_at || null };
    if (st && st.error && !st.refresh) out.error = st.error;
    send(res, 200, out);
  }
  async function disconnect(req, res) {
    const st = loadStore();
    if (st && st.refresh) {
      try { await postForm(`${cfg().oauth}/revoke`, { token: unseal(st.refresh) }); } catch {}
    }
    dropStore();
    send(res, 200, { ok: true, connected: false });
  }

  /* ----- Gmail ----- */
  function threadSummary(t) {
    const msgs = t.messages || [], first = msgs[0] || {}, last = msgs[msgs.length - 1] || {};
    return { id: t.id, subject: hdr(first, "Subject") || "(no subject)", snippet: decodeEntities(last.snippet || ""),
      last_at: isoAt(last), unread: msgs.some(m => (m.labelIds || []).includes("UNREAD")), count: msgs.length };
  }
  async function inbox(req, res) {
    const st = connected();
    const { bookings, marks } = people(), byEmail = new Map();
    for (let i = bookings.length - 1; i >= 0; i--) { const em = normEmail(bookings[i].data && bookings[i].data.email); if (em && !byEmail.has(em)) byEmail.set(em, bookings[i]); }
    const list = [...byEmail.entries()].slice(0, 40);
    const ranchers = await pool(list, 4, async ([em, b]) => {
      const d = b.data || {}, mk = marks[b.id] || {};
      const out = { booking_id: b.id, name: d.name || em, email: em, ranch: d.ranch || "", how: d.how === "video" ? "video" : "phone", booked_at: b.at,
        status: mk.status || "new", confirmed_time: mk.confirmed_time || null, threads: [] };
      try {
        const tl = await gapi("GET", u(`${GM()}/threads`, { q: `{from:${em} to:${em}} newer_than:180d`, maxResults: 5 }));
        const ts = await pool(tl.threads || [], 5, t => gapi("GET", u(`${GM()}/threads/${encodeURIComponent(t.id)}`, { format: "metadata", metadataHeaders: ["Subject", "From", "To", "Date"] })));
        out.threads = ts.map(threadSummary).sort((a, b) => b.last_at.localeCompare(a.last_at));
      } catch (e) { if (e.fatal) throw e; out.error = e.message; }
      return out;
    });
    send(res, 200, { connected: true, email: st.email, ranchers });
  }
  const validThreadId = v => typeof v === "string" && /^[a-zA-Z0-9]{6,64}$/.test(v);
  async function thread(req, res, url) {
    const st = connected(), id = url.searchParams.get("id");
    if (!validThreadId(id)) throw new GErr(400, "That email thread id doesn't look right.");
    const t = await gapi("GET", u(`${GM()}/threads/${id}`, { format: "full" }));
    const msgs = t.messages || [], { known } = people();
    const involved = new Set(msgs.flatMap(m => ["From", "To", "Cc", "Reply-To"].flatMap(h => addrsIn(hdr(m, h)))));
    if (![...involved].some(a => known.has(a))) throw new GErr(403, "That email isn't with one of the ranchers from your website, so the board won't open it.");
    const me = st.email;
    const messages = msgs.map(m => {
      const from = hdr(m, "From"), text = bodyText(m.payload);
      return { id: m.id, from, to: hdr(m, "To"), at: isoAt(m), text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n[…cut short]" : text,
        mine: (m.labelIds || []).includes("SENT") || addrsIn(from)[0] === me, message_id: hdr(m, "Message-ID") || null };
    });
    const subject = hdr(msgs[0], "Subject") || "(no subject)";
    if (url.searchParams.get("markread") === "1" && msgs.some(m => (m.labelIds || []).includes("UNREAD"))) {
      try { await gapi("POST", `${GM()}/threads/${id}/modify`, { removeLabelIds: ["UNREAD"] }); } catch (e) { if (e.fatal) throw e; }
    }
    const lastTheirs = [...messages].reverse().find(m => !m.mine), lastMsg = messages[messages.length - 1];
    const replyTo = (lastTheirs && addrsIn(lastTheirs.from).find(a => known.has(a))) || [...involved].find(a => known.has(a));
    send(res, 200, { id: t.id, subject, messages,
      reply: { to: replyTo, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, threadId: t.id, inReplyTo: lastMsg && lastMsg.message_id || null } });
  }
  async function reply(req, res) {
    const st = connected(), b = await readJson(req, 96 * 1024);
    const to = normEmail(b.to);
    if (!to) throw new GErr(400, "That email address doesn't look right.");
    if (!people().known.has(to)) throw new GErr(403, "The board only sends to ranchers who booked a call or left their email on your website.");
    const body = typeof b.body === "string" ? b.body : "";
    if (!body.trim()) throw new GErr(400, "Write a message first.");
    if (body.length > MAX_TEXT) throw new GErr(400, "That message is too long (20,000 characters at most).");
    let subject = oneLine(b.subject, 300);
    let threadId = null, inReplyTo = null, references = null;
    if (b.inReplyTo != null && b.inReplyTo !== "") {
      inReplyTo = String(b.inReplyTo).trim();
      if (!/^<[^<>\s]{1,500}>$/.test(inReplyTo)) throw new GErr(400, "The email being replied to has an odd id.");
    }
    if (b.threadId != null && b.threadId !== "") {
      if (!validThreadId(b.threadId)) throw new GErr(400, "That email thread id doesn't look right.");
      threadId = b.threadId;
      const t = await gapi("GET", u(`${GM()}/threads/${threadId}`, { format: "metadata", metadataHeaders: ["Subject", "From", "To", "Cc", "Message-ID", "References"] }));
      const msgs = t.messages || [];
      if (!msgs.some(m => ["From", "To", "Cc"].some(h => addrsIn(hdr(m, h)).includes(to)))) throw new GErr(403, "That email thread isn't with this rancher.");
      const last = msgs[msgs.length - 1];
      if (!inReplyTo && last) inReplyTo = hdr(last, "Message-ID") || null;
      if (inReplyTo) references = oneLine(`${last ? hdr(last, "References") : ""} ${inReplyTo}`, 4000).split(/\s+/).filter((x, i, a) => x && a.indexOf(x) === i).slice(-20).join(" ");
      if (!subject) { const s = hdr(msgs[0], "Subject"); subject = /^re:/i.test(s) ? s : `Re: ${s}`; }
    }
    if (!subject) throw new GErr(400, "Add a subject.");
    const now = Date.now(); sends = sends.filter(t => now - t < HOUR);
    if (sends.length >= SENDS_PER_HOUR) throw new GErr(429, "That's 30 emails from the board in the last hour. Wait a bit, or send from Gmail.");
    sends.push(now);
    const r = await gapi("POST", `${GM()}/messages/send`, { raw: buildRaw({ from: st.email, to, subject, body, inReplyTo, references }), ...(threadId ? { threadId } : {}) });
    append({ id: newId(), at: new Date().toISOString(), type: "gmail_sent", to, thread_id: r.threadId || null, message_id: r.id || null });
    send(res, 200, { ok: true, id: r.id, threadId: r.threadId });
  }

  /* ----- Calendar ----- */
  async function free(req, res, url) {
    connected();
    const days = Math.min(21, Math.max(1, parseInt(url.searchParams.get("days"), 10) || 7));
    const now = Date.now(), first = Math.ceil(now / HOUR) * HOUR;
    const fb = await gapi("POST", `${CAL()}/freeBusy`, { timeMin: new Date(first).toISOString(), timeMax: new Date(now + days * DAY).toISOString(), timeZone: TZ, items: [{ id: "primary" }] });
    const cal = fb.calendars && fb.calendars.primary || {};
    if (cal.errors && cal.errors.length) throw new GErr(502, "Google couldn't read your calendar right now. Try again in a minute.");
    const busy = (cal.busy || []).map(x => [Date.parse(x.start), Date.parse(x.end)]).filter(([a, b]) => a < b);
    send(res, 200, { timezone: TZ, slots: freeSlots(now, days, busy) });
  }
  async function calls(req, res) {
    connected();
    const now = Date.now(), out = [];
    let pageToken = null, pages = 0;
    do {
      const r = await gapi("GET", u(`${CAL()}/calendars/primary/events`, { timeMin: new Date(now - HOUR).toISOString(), timeMax: new Date(now + 60 * DAY).toISOString(),
        singleEvents: "true", orderBy: "startTime", maxResults: 250, pageToken }));
      for (const ev of r.items || []) {
        const m = String(ev.description || "").match(/Hanging Weight Co\. booking:\s*([A-Za-z0-9_-]+)/);
        if (!m) continue;
        const att = (ev.attendees || []).find(a => !a.self && !a.organizer) || {};
        const start = ev.start && (ev.start.dateTime || ev.start.date), meet = meetOf(ev);
        out.push({ event_id: ev.id, booking_id: m[1], start, end: ev.end && (ev.end.dateTime || ev.end.date), label: start ? slotLabel(Date.parse(start)) : "",
          how: meet ? "video" : "phone", meet_link: meet, attendee_email: att.email || null, attendee_response: att.responseStatus || null, status: ev.status || "confirmed" });
      }
      pageToken = r.nextPageToken || null;
    } while (pageToken && ++pages < 4);
    send(res, 200, { calls: out });
  }
  async function confirm(req, res) {
    connected();
    const b = await readJson(req);
    const { b: booking, d, mark: mk } = findBooking(b.booking_id);
    const em = normEmail(d.email); if (!em) throw new GErr(400, "This booking has no email address, so Google can't send the rancher an invite.");
    const t = startTime(b.start);
    if (mk.status === "confirmed" && mk.event_id) throw new GErr(409, "This call is already on your calendar. Use Move to change the time.", { event_id: mk.event_id });
    if (busyBookings.has(booking.id)) throw new GErr(409, "Already putting this call on your calendar. Give it a moment.");
    busyBookings.add(booking.id);
    try {
      const video = d.how === "video", name = oneLine(d.name, 120) || em, phone = oneLine(d.phone, 40);
      const ev = { summary: `Price It Right call – ${name}`,
        description: `${BOOKING_TAG} ${booking.id}\nPhone: ${phone || "not given"}\n${String(d.notes || "").slice(0, 3000)}`.trim(),
        start: { dateTime: new Date(t).toISOString(), timeZone: TZ }, end: { dateTime: new Date(t + HOUR).toISOString(), timeZone: TZ },
        attendees: [{ email: em, displayName: name }] };
      if (video) ev.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
      else ev.location = `Phone call – Allen calls ${phone || "the number they gave"}`;
      const made = await gapi("POST", u(`${CAL()}/calendars/primary/events`, { sendUpdates: "all", conferenceDataVersion: video ? 1 : null }), ev);
      const label = slotLabel(t), meet = meetOf(made);
      mark(booking.id, { status: "confirmed", confirmed_time: label, event_id: made.id, event_start: new Date(t).toISOString(), meet_link: meet });
      send(res, 200, { ok: true, event_id: made.id, meet_link: meet, label });
    } finally { busyBookings.delete(booking.id); }
  }
  async function move(req, res) {
    connected();
    const b = await readJson(req);
    const { b: booking } = findBooking(b.booking_id);
    const t = startTime(b.start);
    const ev = await ownedEvent(booking.id, b.event_id);
    if (ev.status === "cancelled") throw new GErr(409, "That call was cancelled. Confirm a new time instead.");
    await gapi("PATCH", u(`${CAL()}/calendars/primary/events/${encodeURIComponent(ev.id)}`, { sendUpdates: "all" }),
      { start: { dateTime: new Date(t).toISOString(), timeZone: TZ }, end: { dateTime: new Date(t + HOUR).toISOString(), timeZone: TZ } });
    const label = slotLabel(t);
    mark(booking.id, { status: "confirmed", confirmed_time: label, event_id: ev.id, event_start: new Date(t).toISOString() });
    send(res, 200, { ok: true, event_id: ev.id, label });
  }
  async function cancel(req, res) {
    connected();
    const b = await readJson(req);
    const { b: booking } = findBooking(b.booking_id);
    let gone = false;
    try { await ownedEvent(booking.id, b.event_id); } catch (e) { if (e.status === 404 || e.status === 410) gone = true; else throw e; }
    if (!gone) {
      try { await gapi("DELETE", u(`${CAL()}/calendars/primary/events/${encodeURIComponent(b.event_id)}`, { sendUpdates: "all" })); }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    mark(booking.id, { status: "cancelled", confirmed_time: null, event_id: null, event_start: null, meet_link: null });
    send(res, 200, { ok: true });
  }

  /* ----- helpers' activity ----- */
  async function agents(req, res, url) {
    connected();
    if (agentsCache && Date.now() - agentsCache.at < 5 * 60000 && url.searchParams.get("fresh") !== "1") return send(res, 200, agentsCache.body);
    const since = Date.now() - 14 * DAY, meta = new Map();
    const getMeta = id => {
      if (!meta.has(id)) meta.set(id, gapi("GET", u(`${GM()}/messages/${encodeURIComponent(id)}`, { format: "metadata", metadataHeaders: ["Subject"] }))
        .then(m => ({ id: m.id, subject: hdr(m, "Subject"), at: Number(m.internalDate) || 0, labels: m.labelIds || [] })));
      return meta.get(id);
    };
    // drafts (newest 300) + which of them carry the "Ready to send" label
    const labels = await gapi("GET", `${GM()}/labels`);
    const ready = ((labels.labels || []).find(l => String(l.name).trim().toLowerCase() === READY_LABEL) || {}).id || null;
    const draftIds = []; let pageToken = null, pages = 0;
    do {
      const r = await gapi("GET", u(`${GM()}/drafts`, { maxResults: 100, pageToken }));
      for (const d of r.drafts || []) if (d.message && d.message.id) draftIds.push(d.message.id);
      pageToken = r.nextPageToken || null;
    } while (pageToken && ++pages < 3);
    const drafts = await pool(draftIds, 8, getMeta);
    const draftsReady = ready ? drafts.filter(d => d.labels.includes(ready)).length : 0;
    const list = await pool(HELPERS, 4, async h => {
      const q = `${h.q.length > 1 ? `{${h.q.map(s => `subject:${s}`).join(" ")}}` : `subject:${h.q[0]}`} newer_than:14d -in:drafts${h.sentOnly ? " in:sent" : ""}`;
      const r = await gapi("GET", u(`${GM()}/messages`, { q, maxResults: 50 }));
      const msgs = (await pool(r.messages || [], 8, m => getMeta(m.id))).filter(m => m.at >= since && !m.labels.includes("DRAFT") && h.email.some(x => x.test(m.subject)));
      const mine = h.drafts ? drafts.filter(d => d.at >= since && h.drafts.some(x => x.test(d.subject))) : [];
      const newest = [...msgs, ...mine].sort((a, b) => b.at - a.at)[0];
      // Quiet for 2 weeks? Look for an older email, so the board can tell "went quiet" from "never reported yet".
      let earlier = null;
      if (!newest) {
        const oq = `${h.q.length > 1 ? `{${h.q.map(s => `subject:${s}`).join(" ")}}` : `subject:${h.q[0]}`} older_than:14d -in:drafts${h.sentOnly ? " in:sent" : ""}`;
        const orr = await gapi("GET", u(`${GM()}/messages`, { q: oq, maxResults: 10 }));
        const olds = (await pool(orr.messages || [], 8, m => getMeta(m.id))).filter(m => m.at && m.at < since && !m.labels.includes("DRAFT") && h.email.some(x => x.test(m.subject)));
        earlier = olds.sort((a, b) => b.at - a.at)[0] || null;
      }
      return { id: h.id, name: h.name, last_at: newest ? new Date(newest.at).toISOString() : null, last_subject: newest ? newest.subject : null,
        earlier_at: earlier ? new Date(earlier.at).toISOString() : null,
        last_kind: newest ? (mine.includes(newest) ? "draft" : "email") : null, count_14d: msgs.length,
        drafts: h.drafts ? drafts.filter(d => h.drafts.some(x => x.test(d.subject))).length : null };
    });
    const body = { ok: true, agents: list, drafts_ready: draftsReady, ready_label: !!ready, checked_at: new Date().toISOString() };
    agentsCache = { at: Date.now(), body };
    send(res, 200, body);
  }

  const ROUTES = {
    "GET /api/google/start": start, "GET /api/google/callback": callback, "GET /api/google/status": status, "POST /api/google/disconnect": disconnect,
    "GET /api/inbox": inbox, "GET /api/thread": thread, "POST /api/reply": reply,
    "GET /api/calendar/free": free, "GET /api/calendar/calls": calls, "POST /api/calendar/confirm": confirm,
    "POST /api/calendar/move": move, "POST /api/calendar/cancel": cancel, "GET /api/agents": agents,
  };
  const OURS = /^\/api\/(google\/|calendar\/|inbox$|thread$|reply$|agents$)/;
  function sameOrigin(req) {
    const o = req.headers.origin; if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }
  // Returns true when the request was one of ours (and has been answered).
  async function handle(req, res, url) {
    const p = url.pathname, fn = ROUTES[`${req.method} ${p}`];
    if (!fn) { if (!OURS.test(p)) return false; send(res, 404, { ok: false, error: "Not found" }); return true; }
    if (req.method === "POST" && !sameOrigin(req)) { send(res, 403, { ok: false, error: "Not allowed from another site." }); return true; }
    try { await fn(req, res, url); }
    catch (e) {
      if (res.headersSent) return true;
      if (e instanceof GErr) send(res, e.status, { ok: false, error: e.message, ...e.extra });
      else { console.error("google route", p, e && e.message); send(res, 500, { ok: false, error: "Something went wrong on the board's server. Try again in a minute." }); }
    }
    return true;
  }
  return { handle };
}

module.exports = createGoogle;
Object.assign(module.exports, { freeSlots, centralToUtc, slotLabel, buildRaw, encodeHeader, bodyText, htmlToText, HELPERS, SCOPES });
