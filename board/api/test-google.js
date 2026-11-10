#!/usr/bin/env node
// End-to-end test for api/google.js: a fake Google on localhost, the real api/server.js in a child process.
//   node api/test-google.js
// Prints PASS/FAIL per check and exits 1 on any failure. Built-in modules only.
"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const G = require("./google");

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`); }
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const b64u = s => Buffer.from(s, "utf8").toString("base64url");
const HOUR = 3600000, DAY = 86400000;
const central = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" });
const cParts = ms => Object.fromEntries(central.formatToParts(new Date(ms)).map(p => [p.type, p.value]));

/* ======================= unit checks (pure functions, fixed clocks) ======================= */
function unit() {
  // Fall back: Sun Nov 1 2026, 2:00 CDT -> 1:00 CST.
  const now = Date.parse("2026-10-30T13:30:00Z"); // Fri Oct 30, 8:30 AM CDT
  const busy = [[Date.parse("2026-10-30T15:00:00Z"), Date.parse("2026-10-30T17:00:00Z")], // Fri 10:00–12:00 CDT
    [Date.parse("2026-10-30T19:30:00Z"), Date.parse("2026-10-30T19:45:00Z")]];            // Fri 2:30–2:45 PM CDT (partial)
  const s = G.freeSlots(now, 7, busy, 200);
  const starts = s.map(x => x.start);
  check("unit: first slot is next full hour (Fri 9:00 AM CDT = 14:00Z)", s[0].start === "2026-10-30T14:00:00.000Z" && s[0].label === "Fri Oct 30 · 9:00 AM", s[0]);
  check("unit: busy 10–12 skipped, 12:00 kept", !starts.includes("2026-10-30T15:00:00.000Z") && !starts.includes("2026-10-30T16:00:00.000Z") && starts.includes("2026-10-30T17:00:00.000Z"));
  check("unit: partial busy 2:30–2:45 knocks out the 2:00 slot only", !starts.includes("2026-10-30T19:00:00.000Z") && starts.includes("2026-10-30T20:00:00.000Z"));
  check("unit: Saturday 8:00 AM CDT = 13:00Z", starts.includes("2026-10-31T13:00:00.000Z"));
  check("unit: no Sunday slots", !s.some(x => x.label.startsWith("Sun")));
  check("unit: after DST ends, Mon 8:00 AM CST = 14:00Z", starts.includes("2026-11-02T14:00:00.000Z") && !starts.includes("2026-11-02T13:00:00.000Z"));
  const mon = s.find(x => x.start === "2026-11-02T14:00:00.000Z");
  check("unit: label after DST", mon && mon.label === "Mon Nov 2 · 8:00 AM", mon);
  check("unit: last slot of a day starts 5:00 PM, ends 6:00 PM Central", s.some(x => x.label === "Fri Oct 30 · 5:00 PM") && !s.some(x => /6:00 PM/.test(x.label)));
  check("unit: every slot is 60 min, Mon–Sat 8–17 Central", s.every(x => { const p = cParts(Date.parse(x.start)); return Date.parse(x.end) - Date.parse(x.start) === HOUR && p.weekday !== "Sun" && +p.hour >= 8 && +p.hour <= 17 && p.minute === "00"; }));
  check("unit: max 40", G.freeSlots(now, 21, []).length === 40);
  // Spring forward: Sun Mar 14 2027.
  const s2 = G.freeSlots(Date.parse("2027-03-12T20:00:00Z"), 4, [], 200).map(x => x.start);
  check("unit: spring DST (Sat Mar 13 8:00 CST = 14:00Z, Mon Mar 15 8:00 CDT = 13:00Z)", s2.includes("2027-03-13T14:00:00.000Z") && s2.includes("2027-03-15T13:00:00.000Z"));
  check("unit: centralToUtc", G.centralToUtc(2026, 7, 4, 12) === Date.parse("2026-07-04T17:00:00Z") && G.centralToUtc(2026, 12, 25, 12) === Date.parse("2026-12-25T18:00:00Z"));
  const long = "Précio del café – ¿cuánto cobro por media res? ✓ ".repeat(3).trim();
  const enc = G.encodeHeader(long);
  const dec = enc.split("\r\n ").map(w => Buffer.from(w.match(/^=\?UTF-8\?B\?(.*)\?=$/)[1], "base64").toString("utf8")).join("");
  check("unit: RFC 2047 subject round-trips, words ≤ 75 chars", dec === long && enc.split("\r\n ").every(w => w.length <= 75), enc);
  check("unit: ASCII subject left alone", G.encodeHeader("Re: Monday") === "Re: Monday");
  check("unit: html fallback strips tags and decodes entities", G.htmlToText("<div>Hi&nbsp;Allen,<br>Price is &lt;$5&gt; &amp; up</div><style>x{}</style>") === "Hi Allen,\nPrice is <$5> & up");
  check("unit: 20 helper ids", G.HELPERS.map(h => h.id).join() === "finder,outreach,articles,social,partners,referral,helper,followup,booking,prep,recap,upgrade,profile,buyers,posts,orders,report,watchdog,analyst,driver");
}

/* ======================= fake Google ======================= */
const ALLEN = "allen@example.com", CODY = "cody@ranch.test", DANA = "dana@ranch.test", LEE = "lee@lead.test", STRANGER = "stranger@else.test";
const RT = "rt-SECRET-refresh-123";
const now = Date.now();
function msg(id, threadId, { from, to, subject, labels = [], at, snippet = "", payload, msgid }) {
  return { id, threadId, labelIds: labels, internalDate: String(at), snippet,
    payload: { ...payload, headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }, { name: "Message-ID", value: msgid || `<${id}@mail.test>` }, ...((payload && payload.headers) || [])] } };
}
const plain = (text, cs = "utf-8") => ({ mimeType: "text/plain", body: { data: Buffer.from(text, cs === "utf-8" ? "utf8" : "latin1").toString("base64url") }, headers: [{ name: "Content-Type", value: `text/plain; charset=${cs}` }] });
const htmlOnly = html => ({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64u(html) }, headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }] }] });
const fake = {
  valid: new Set(), n: 0, refreshes: 0, invalidGrant: false, revoked: [], sent: [], inserts: [], patches: [], deletes: [], modifies: [], busy: [], freebusyReqs: [], authFails: 0,
  threads: {
    t1aaaaaa: [msg("m1", "t1aaaaaa", { from: `Cody Bell <${CODY}>`, to: ALLEN, subject: "Monday call", labels: ["INBOX", "UNREAD"], at: now - 2 * DAY, snippet: "Can we talk Monday? It&#39;s about the café", payload: plain("Hi Allen,\r\nCan we talk Monday? It's about the café price.\r\nCody") }),
      msg("m2", "t1aaaaaa", { from: `Allen <${ALLEN}>`, to: CODY, subject: "Re: Monday call", labels: ["SENT"], at: now - DAY, snippet: "See you Monday", payload: htmlOnly("<div>See you <b>Monday</b>&nbsp;at 9.</div><div>Allen</div>"), msgid: "<allen-m2@mail.test>" })],
    t2bbbbbb: [msg("m3", "t2bbbbbb", { from: DANA, to: ALLEN, subject: "Video call?", labels: ["INBOX"], at: now - 3 * DAY, snippet: "Video works", payload: plain("Olá, video works for me.", "iso-8859-1") })],
    t9zzzzzz: [msg("m9", "t9zzzzzz", { from: STRANGER, to: ALLEN, subject: "Private", labels: ["INBOX"], at: now - DAY, snippet: "private", payload: plain("not for the board") })],
  },
  mailbox: [ // helper emails (id, subject, at, labels)
    ["h1", "Rancher Finder – 17 new ranches – Oct 29, 2026", now - DAY, ["INBOX", "SENT"]],
    ["h2", "Rancher Finder – 15 new ranches – Oct 28, 2026", now - 2 * DAY, ["INBOX", "SENT"]],
    ["h3", "Rancher Finder – 12 new ranches – Oct 1, 2026", now - 20 * DAY, ["INBOX"]],
    ["h4", "Re: Rancher Finder – 17 new ranches – Oct 29, 2026", now - HOUR, ["INBOX"]],
    ["h5", "Good morning – your day at Hanging Weight Co. – Oct 30, 2026", now - 3 * HOUR, ["INBOX", "SENT"]],
    ["h6", "Website alert – calculator page is down", now - 5 * DAY, ["INBOX", "SENT"]],
    ["h7", "Thanks for the call, Dana", now - 2 * DAY, ["SENT"]],
    ["h8", "Partner Outreach – please add your mailing address", now - DAY, ["INBOX", "SENT"]],
    ["h9", "Re: Your beef price sheet – thanks, Cody", now - DAY, ["INBOX"]], // the rancher's reply: not a helper
    ["h10", "Weekly numbers – Oct 5, 2026", now - 30 * DAY, ["INBOX", "SENT"]], // old email only: Weekly Numbers went quiet
  ],
  drafts: [ // draft message id, subject, at, labels
    ["d1", "You’re booked – a few numbers before our call", now - 2 * HOUR, ["DRAFT", "Label_7"]],
    ["d2", "Thanks for the call, Cody", now - HOUR, ["DRAFT", "Label_7"]],
    ["d3", "Pricing your beef – a free tool from a fellow rancher", now - 4 * HOUR, ["DRAFT", "Label_7"]],
    ["d4", "Your plan from our call – Bell Ranch", now - 5 * HOUR, ["DRAFT"]],
  ],
  events: {},
};
const metaOf = (id, subject, at, labels) => ({ id, threadId: id, labelIds: labels, internalDate: String(at), payload: { headers: [{ name: "Subject", value: subject }] } });
function threadPeople(t) { return t.flatMap(m => m.payload.headers.filter(h => /^(from|to|cc)$/i.test(h.name)).map(h => h.value.toLowerCase())).join(" "); }

function fakeGoogle(req, res, body) {
  const url = new URL(req.url, "http://x"), p = url.pathname, q = url.searchParams;
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
  if (p === "/token") {
    const f = new URLSearchParams(body);
    if (f.get("client_id") !== "cid-test" || f.get("client_secret") !== "csecret-test") return json(401, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      if (f.get("code") !== "code-ok" || f.get("redirect_uri") !== "https://board.test/api/google/callback") return json(400, { error: "invalid_grant" });
      const at = `at-${++fake.n}-access`; fake.valid.add(at);
      const idt = [b64u('{"alg":"none"}'), b64u(JSON.stringify({ email: ALLEN, email_verified: true })), "sig"].join(".");
      return json(200, { access_token: at, expires_in: 3599, refresh_token: RT, id_token: idt, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events" });
    }
    if (f.get("grant_type") === "refresh_token") {
      fake.refreshes++;
      if (fake.invalidGrant || f.get("refresh_token") !== RT) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const at = `at-${++fake.n}-access`; fake.valid.add(at);
      return json(200, { access_token: at, expires_in: 3599, token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  }
  if (p === "/revoke") { fake.revoked.push(new URLSearchParams(body).get("token")); return json(200, {}); }
  const auth = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (!fake.valid.has(auth)) { fake.authFails++; return json(401, { error: { code: 401, message: "Invalid Credentials" } }); }
  const B = body ? JSON.parse(body) : null;
  let m;
  /* Gmail */
  if (p === "/gmail/v1/users/me/threads" && req.method === "GET") {
    const em = ((q.get("q") || "").match(/from:([^\s}]+)/) || [])[1];
    const ids = Object.keys(fake.threads).filter(id => em && threadPeople(fake.threads[id]).includes(em));
    return json(200, { threads: ids.map(id => ({ id })), resultSizeEstimate: ids.length });
  }
  if ((m = p.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/)) && req.method === "GET") {
    const t = fake.threads[m[1]]; if (!t) return json(404, { error: { code: 404, message: "Not Found" } });
    const full = q.get("format") === "full";
    return json(200, { id: m[1], messages: t.map(x => full ? x : { ...x, payload: { headers: x.payload.headers } }) });
  }
  if ((m = p.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)\/modify$/)) && req.method === "POST") {
    fake.modifies.push({ id: m[1], body: B });
    for (const x of fake.threads[m[1]] || []) x.labelIds = x.labelIds.filter(l => !(B.removeLabelIds || []).includes(l));
    return json(200, { id: m[1] });
  }
  if (p === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
    fake.sent.push(B); return json(200, { id: `sent${fake.sent.length}`, threadId: B.threadId || `tnew${fake.sent.length}`, labelIds: ["SENT"] });
  }
  if (p === "/gmail/v1/users/me/labels") return json(200, { labels: [{ id: "INBOX", name: "INBOX" }, { id: "Label_7", name: "Ready to send" }] });
  if (p === "/gmail/v1/users/me/drafts") return json(200, { drafts: fake.drafts.map(([id]) => ({ id: `r-${id}`, message: { id, threadId: id } })) });
  if (p === "/gmail/v1/users/me/messages" && req.method === "GET") {
    const qs = q.get("q") || "", phrases = [...qs.matchAll(/subject:"([^"]+)"/g)].map(x => x[1].toLowerCase()), sentOnly = /\bin:sent\b/.test(qs);
    const hits = fake.mailbox.filter(([, s, , l]) => phrases.some(ph => s.toLowerCase().includes(ph)) && (!sentOnly || l.includes("SENT")));
    return json(200, { messages: hits.map(([id]) => ({ id, threadId: id })), resultSizeEstimate: hits.length });
  }
  if ((m = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/)) && req.method === "GET") {
    const x = fake.mailbox.find(r => r[0] === m[1]) || fake.drafts.find(r => r[0] === m[1]);
    return x ? json(200, metaOf(...x)) : json(404, { error: { code: 404, message: "Not Found" } });
  }
  /* Calendar */
  if (p === "/calendar/v3/freeBusy" && req.method === "POST") { fake.freebusyReqs.push(B); return json(200, { calendars: { primary: { busy: fake.busy } } }); }
  if (p === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
    const id = `ev${Object.keys(fake.events).length + 1}x`;
    const ev = { ...B, id, status: "confirmed", organizer: { email: ALLEN, self: true }, attendees: (B.attendees || []).map(a => ({ ...a, responseStatus: "needsAction" })) };
    if (B.conferenceData && q.get("conferenceDataVersion") === "1") { ev.hangoutLink = "https://meet.google.com/abc-defg-hij"; ev.conferenceData = { entryPoints: [{ entryPointType: "video", uri: ev.hangoutLink }] }; }
    fake.events[id] = ev; fake.inserts.push({ query: Object.fromEntries(q), body: B });
    return json(200, ev);
  }
  if (p === "/calendar/v3/calendars/primary/events" && req.method === "GET") {
    return json(200, { items: [...Object.values(fake.events).filter(e => e.status !== "cancelled"),
      { id: "dentist1", summary: "Dentist", description: "cleaning", start: { dateTime: new Date(now + DAY).toISOString() }, end: { dateTime: new Date(now + DAY + HOUR).toISOString() }, status: "confirmed" }] });
  }
  if ((m = p.match(/^\/calendar\/v3\/calendars\/primary\/events\/([^/]+)$/))) {
    const ev = fake.events[m[1]];
    if (!ev) return json(404, { error: { code: 404, message: "Not Found" } });
    if (req.method === "GET") return json(200, ev);
    if (req.method === "PATCH") { Object.assign(ev, B); fake.patches.push({ id: m[1], query: Object.fromEntries(q), body: B }); return json(200, ev); }
    if (req.method === "DELETE") { if (ev.status === "cancelled") return json(410, { error: { code: 410, message: "Resource has been deleted" } }); ev.status = "cancelled"; fake.deletes.push({ id: m[1], query: Object.fromEntries(q) }); res.writeHead(204); return res.end(); }
  }
  json(404, { error: { code: 404, message: `fake: no route ${req.method} ${p}` } });
}

/* ======================= run ======================= */
async function main() {
  unit();
  const gport = await freePort(), aport = await freePort();
  const gsrv = http.createServer((req, res) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => fakeGoogle(req, res, Buffer.concat(c).toString("utf8"))); });
  await new Promise(r => gsrv.listen(gport, "127.0.0.1", r));
  const GB = `http://127.0.0.1:${gport}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "hwb-google-"));
  const ev = (type, d, at) => ({ id: `${type.slice(0, 2)}${Math.random().toString(36).slice(2, 10)}`, at: new Date(at).toISOString(), type, vid: "v1", src: "direct", page: "/book/", data: d, ip: "x" });
  const codyOld = ev("booking", { name: "Cody Bell", email: "CODY@ranch.test", phone: "(512) 555-0100", ranch: "Bell Ranch", heads: 40, sells: ["halves"], how: "phone", times: ["Mon Nov 2 · Morning"], notes: "old booking", calc: {} }, now - 5 * DAY);
  const cody = ev("booking", { name: "Cody Bell", email: CODY, phone: "(512) 555-0100", ranch: "Bell Ranch", heads: 40, sells: ["halves"], how: "phone", times: ["Mon Nov 2 · Morning"], notes: "Wants to talk deposits", calc: { break_even: 4.1 } }, now - 3 * DAY);
  const dana = ev("booking", { name: "Dana Ruiz", email: DANA, phone: "830-555-0199", ranch: "Ruiz Cattle", heads: 12, sells: ["quarters"], how: "video", times: ["Tue Nov 3 · Afternoon"], notes: "", calc: {} }, now - 2 * DAY);
  const lead = ev("lead", { name: "Lee", email: LEE }, now - DAY);
  fs.writeFileSync(path.join(data, "events.jsonl"), [codyOld, cody, dana, lead].map(x => JSON.stringify(x)).join("\n") + "\n");

  const env = { ...process.env, HW_DATA: data, HW_API_PORT: String(aport), HW_API_HOST: "127.0.0.1",
    GOOGLE_CLIENT_ID: "cid-test", GOOGLE_CLIENT_SECRET: "csecret-test", GOOGLE_REDIRECT_URI: "https://board.test/api/google/callback",
    HW_TOKEN_KEY: "test-token-key-0123456789-abcdefghijklmnop", GOOGLE_OAUTH_BASE: GB, GOOGLE_AUTH_URL: `${GB}/o/oauth2/v2/auth`, GOOGLE_API_BASE: GB, GMAIL_API_BASE: GB,
    SENDGRID_API_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
  const child = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", d => logs += d); child.stderr.on("data", d => logs += d);
  const A = `http://127.0.0.1:${aport}`;
  for (let i = 0; i < 50; i++) { try { await fetch(`${A}/api/google/status`); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

  const leaks = [];
  async function call(method, p, body, headers = {}) {
    const r = await fetch(A + p, { method, redirect: "manual", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (text.includes(RT) || /at-\d+-access/.test(text) || text.includes("csecret-test") || String(r.headers.get("location") || "").includes("csecret")) leaks.push(`${method} ${p}`);
    let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text, loc: r.headers.get("location") };
  }

  try {
    /* --- not connected yet --- */
    let r = await call("GET", "/api/google/status");
    check("status before connect: not connected, configured", r.status === 200 && r.j.connected === false && r.j.configured === true, r.j);
    r = await call("GET", "/api/inbox");
    check("inbox before connect → 409 {connected:false}", r.status === 409 && r.j.connected === false, r);

    /* --- OAuth --- */
    r = await call("GET", "/api/google/start");
    const auth = r.loc ? new URL(r.loc) : null, sp = auth ? auth.searchParams : new URLSearchParams();
    check("start → 302 to Google consent", r.status === 302 && auth && auth.origin + auth.pathname === `${GB}/o/oauth2/v2/auth`, r);
    check("start has scopes, offline, consent, include_granted_scopes, redirect, client id",
      sp.get("scope") === "openid email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events" && sp.get("access_type") === "offline" && sp.get("prompt") === "consent" &&
      sp.get("include_granted_scopes") === "true" && sp.get("redirect_uri") === "https://board.test/api/google/callback" && sp.get("client_id") === "cid-test" && sp.get("response_type") === "code" && (sp.get("state") || "").length >= 20, Object.fromEntries(sp));
    const state = sp.get("state");
    r = await call("GET", `/api/google/callback?code=code-ok&state=wrong-state`);
    check("callback with a wrong state is refused", r.status === 302 && /google_error=/.test(r.loc) && !fs.existsSync(path.join(data, "google.json")), r.loc);
    r = await call("GET", `/api/google/callback?code=code-ok&state=${encodeURIComponent(state)}`);
    check("callback → 302 /#inbox?connected", r.status === 302 && r.loc === "/#inbox?connected", r);
    r = await call("GET", `/api/google/callback?code=code-ok&state=${encodeURIComponent(state)}`);
    check("same state can't be used twice", r.status === 302 && /google_error=expired/.test(r.loc), r.loc);
    const tokFile = path.join(data, "google.json"), tokRaw = fs.readFileSync(tokFile, "utf8");
    check("google.json is chmod 600", (fs.statSync(tokFile).mode & 0o777) === 0o600, (fs.statSync(tokFile).mode & 0o777).toString(8));
    check("refresh token is encrypted at rest", !tokRaw.includes(RT) && /"ct":/.test(tokRaw) && /"tag":/.test(tokRaw));
    r = await call("GET", "/api/google/status");
    check("status connected with Allen's email", r.j.connected === true && r.j.email === ALLEN && !!r.j.connected_at, r.j);

    /* --- inbox --- */
    r = await call("GET", "/api/inbox");
    const ranchers = r.j && r.j.ranchers || [];
    check("inbox: 2 booked ranchers, unique by email, newest first", r.status === 200 && ranchers.length === 2 && ranchers[0].email === DANA && ranchers[1].email === CODY, ranchers.map(x => x.email));
    check("inbox: rancher fields", ranchers[1] && ranchers[1].booking_id === cody.id && ranchers[1].how === "phone" && ranchers[0].how === "video" && ranchers[1].name === "Cody Bell", ranchers[1]);
    const t1 = ranchers[1] && ranchers[1].threads[0];
    check("inbox: thread summary {id, subject, snippet, last_at, unread, count}", t1 && t1.id === "t1aaaaaa" && t1.subject === "Monday call" && t1.unread === true && t1.count === 2 && t1.snippet === "See you Monday" && t1.last_at === new Date(now - DAY).toISOString(), t1);
    check("inbox: stranger thread not listed", !ranchers.some(x => x.threads.some(t => t.id === "t9zzzzzz")));

    /* --- thread --- */
    r = await call("GET", "/api/thread?id=t1aaaaaa&markread=1");
    const msgs = r.j && r.j.messages || [];
    check("thread: 2 messages, text/plain decoded", r.status === 200 && msgs.length === 2 && msgs[0].text === "Hi Allen,\nCan we talk Monday? It's about the café price.\nCody" && msgs[0].mine === false, msgs[0]);
    check("thread: html-only message stripped to text, mine=true", msgs[1] && msgs[1].text === "See you Monday at 9.\nAllen" && msgs[1].mine === true, msgs[1]);
    check("thread: reply helper filled in", r.j && r.j.reply && r.j.reply.to === CODY && r.j.reply.subject === "Re: Monday call" && r.j.reply.inReplyTo === "<allen-m2@mail.test>", r.j && r.j.reply);
    check("thread: markread=1 removes UNREAD", fake.modifies.length === 1 && fake.modifies[0].body.removeLabelIds[0] === "UNREAD" && !fake.threads.t1aaaaaa[0].labelIds.includes("UNREAD"));
    r = await call("GET", "/api/thread?id=t2bbbbbb");
    check("thread: latin-1 charset decoded, no markread without flag", r.status === 200 && r.j.messages[0].text === "Olá, video works for me." && fake.modifies.length === 1, r.j);
    r = await call("GET", "/api/thread?id=t9zzzzzz");
    check("thread with a non-rancher is refused (403)", r.status === 403 && r.j.ok === false, r);
    r = await call("GET", "/api/thread?id=../../x");
    check("thread: bad id → 400", r.status === 400, r);

    /* --- reply --- */
    const subj = "Re: Monday call ✓ — café";
    r = await call("POST", "/api/reply", { to: CODY, subject: subj, body: "Hi Cody,\nMonday at 9 works. Ñ ✓\nAllen", threadId: "t1aaaaaa" });
    check("reply → {ok, id, threadId}", r.status === 200 && r.j.ok && r.j.id === "sent1" && r.j.threadId === "t1aaaaaa", r);
    const sent = fake.sent[0] || {}, raw = Buffer.from(sent.raw || "", "base64url").toString("utf8");
    const [head, bodyB64] = raw.split("\r\n\r\n");
    const H = Object.fromEntries(head.replace(/\r\n /g, " ").split("\r\n").map(l => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 2)]));
    const decSubj = H.subject.split(" ").map(w => Buffer.from(w.match(/^=\?UTF-8\?B\?(.*)\?=$/)[1], "base64").toString("utf8")).join("");
    check("reply MIME: threadId passed to Gmail", sent.threadId === "t1aaaaaa");
    check("reply MIME: From/To/MIME headers", H.from === ALLEN && H.to === CODY && H["mime-version"] === "1.0" && H["content-type"] === "text/plain; charset=UTF-8" && H["content-transfer-encoding"] === "base64", H);
    check("reply MIME: RFC 2047 subject decodes", /^=\?UTF-8\?B\?/.test(H.subject) && decSubj === subj, decSubj);
    check("reply MIME: In-Reply-To/References = last message", H["in-reply-to"] === "<allen-m2@mail.test>" && H.references === "<allen-m2@mail.test>", H);
    check("reply MIME: body is UTF-8 with CRLF", Buffer.from(bodyB64.replace(/\r\n/g, ""), "base64").toString("utf8") === "Hi Cody,\r\nMonday at 9 works. Ñ ✓\r\nAllen", bodyB64);
    check("reply MIME: base64 lines ≤ 76", bodyB64.split("\r\n").every(l => l.length <= 76));
    r = await call("POST", "/api/reply", { to: LEE, subject: "Your price sheet", body: "Hi Lee" });
    check("reply to a calculator lead (new thread) works", r.status === 200 && r.j.ok && !fake.sent[1].threadId, r);
    const before = fake.sent.length;
    r = await call("POST", "/api/reply", { to: STRANGER, subject: "hi", body: "hi" });
    check("reply to a non-rancher address is refused (403)", r.status === 403 && fake.sent.length === before, r);
    r = await call("POST", "/api/reply", { to: `${CODY}, ${STRANGER}`, subject: "hi", body: "hi" });
    check("reply with two addresses is refused", r.status === 400 && fake.sent.length === before, r);
    r = await call("POST", "/api/reply", { to: CODY, subject: "hi", body: "hi", threadId: "t9zzzzzz" });
    check("reply into someone else's thread is refused", r.status === 403 && fake.sent.length === before, r);
    r = await call("POST", "/api/reply", { to: CODY, subject: "x", body: "a".repeat(20001) });
    check("reply body over 20k → 400", r.status === 400 && fake.sent.length === before, r);
    r = await call("POST", "/api/reply", { to: CODY, subject: "Hi\r\nBcc: evil@x.test", body: "hi" });
    const raw2 = Buffer.from(fake.sent[fake.sent.length - 1].raw, "base64url").toString("utf8");
    check("subject header injection is flattened", r.status === 200 && !/^Bcc:/mi.test(raw2.split("\r\n\r\n")[0]), raw2.split("\r\n\r\n")[0]);
    r = await call("POST", "/api/reply", { to: CODY, subject: "hi", body: "hi" }, { Origin: "https://evil.test" });
    check("cross-site POST refused", r.status === 403, r);
    let ok = fake.sent.length, limited = null;
    for (let i = 0; i < 35 && !limited; i++) { const x = await call("POST", "/api/reply", { to: LEE, subject: `n${i}`, body: "x" }); if (x.status === 429) limited = x; }
    check("rate limit: 30 sends per hour, then 429", limited && fake.sent.length === 30 && /30 emails/.test(limited.j.error), { sent: fake.sent.length, ok });

    /* --- 401 → refresh → retry --- */
    fake.valid.clear(); const ref0 = fake.refreshes, fails0 = fake.authFails;
    /* --- free slots --- */
    const pre = G.freeSlots(Date.now(), 7, []);
    fake.busy = [{ start: pre[0].start, end: pre[1].end }, { start: new Date(Date.parse(pre[4].start) + 15 * 60000).toISOString(), end: new Date(Date.parse(pre[4].start) + 30 * 60000).toISOString() }];
    r = await call("GET", "/api/calendar/free?days=7");
    check("Google 401 → refresh once → retry succeeds", r.status === 200 && fake.refreshes === ref0 + 1 && fake.authFails === fails0 + 1, { st: r.status, refreshes: fake.refreshes - ref0, fails: fake.authFails - fails0 });
    const slots = r.j && r.j.slots || [];
    const fb = fake.freebusyReqs[fake.freebusyReqs.length - 1] || {};
    check("freeBusy asked for primary, Central, from the next full hour", fb.items && fb.items[0].id === "primary" && fb.timeZone === "America/Chicago" && Date.parse(fb.timeMin) % HOUR === 0, fb);
    check("free: 1..40 slots, sorted, in the future", slots.length > 0 && slots.length <= 40 && slots.every((x, i) => i === 0 || x.start > slots[i - 1].start) && Date.parse(slots[0].start) >= Date.now() - HOUR, slots.length);
    check("free: every slot Mon–Sat, 8:00–17:00 start Central, 60 min",
      slots.every(x => { const p = cParts(Date.parse(x.start)); return p.weekday !== "Sun" && +p.hour >= 8 && +p.hour <= 17 && p.minute === "00" && Date.parse(x.end) - Date.parse(x.start) === HOUR; }), slots.slice(0, 3));
    const busyMs = fake.busy.map(b => [Date.parse(b.start), Date.parse(b.end)]);
    check("free: busy blocks skipped (incl. a 15-min block)", !slots.some(x => busyMs.some(([a, b]) => a < Date.parse(x.end) && b > Date.parse(x.start))) && !slots.some(x => x.start === pre[0].start || x.start === pre[1].start || x.start === pre[4].start) && slots[0].start === pre[2].start, { first: slots[0], pre: pre.slice(0, 5).map(x => x.start) });
    check("free: label format \"Mon Nov 2 · 9:00 AM\"", slots.every(x => /^(Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2} · \d{1,2}:00 (AM|PM)$/.test(x.label)), slots[0]);
    const crossesDst = slots.some(x => cParts(Date.parse(x.start)).weekday && Date.parse(x.start) >= Date.parse("2026-11-01T07:00:00Z")) && slots.some(x => Date.parse(x.start) < Date.parse("2026-11-01T07:00:00Z"));
    if (crossesDst) check("free (live clock) spans the Nov 1 DST change and stays on 8–17 Central both sides", true);

    /* --- confirm --- */
    const slotA = slots[0], slotB = slots[1], slotC = slots[2];
    r = await call("POST", "/api/calendar/confirm", { booking_id: cody.id, start: slotA.start });
    const insA = fake.inserts[0] || {};
    check("confirm (phone) → {ok, event_id, meet_link:null, label}", r.status === 200 && r.j.ok && r.j.event_id === "ev1x" && r.j.meet_link === null && r.j.label === slotA.label, r);
    check("confirm (phone): sendUpdates=all, attendee = rancher, no Meet", insA.query && insA.query.sendUpdates === "all" && !insA.body.conferenceData && !insA.query.conferenceDataVersion &&
      insA.body.attendees.length === 1 && insA.body.attendees[0].email === CODY, insA);
    check("confirm (phone): title, 60 min, description, location", insA.body && insA.body.summary === "Price It Right call – Cody Bell" &&
      Date.parse(insA.body.end.dateTime) - Date.parse(insA.body.start.dateTime) === HOUR && insA.body.start.dateTime === slotA.start &&
      insA.body.description === `Hanging Weight Co. booking: ${cody.id}\nPhone: (512) 555-0100\nWants to talk deposits` && insA.body.location === "Phone call – Allen calls (512) 555-0100", insA.body);
    r = await call("POST", "/api/calendar/confirm", { booking_id: cody.id, start: slotB.start });
    check("confirm twice → 409 (use Move)", r.status === 409 && fake.inserts.length === 1, r);
    r = await call("POST", "/api/calendar/confirm", { booking_id: dana.id, start: slotB.start });
    const insB = fake.inserts[1] || {};
    check("confirm (video): Meet createRequest + conferenceDataVersion=1", r.status === 200 && insB.query.conferenceDataVersion === "1" && insB.query.sendUpdates === "all" &&
      insB.body.conferenceData.createRequest.conferenceSolutionKey.type === "hangoutsMeet" && !!insB.body.conferenceData.createRequest.requestId && !insB.body.location && insB.body.attendees[0].email === DANA, insB);
    check("confirm (video) returns the Meet link", r.j && r.j.meet_link === "https://meet.google.com/abc-defg-hij" && r.j.event_id === "ev2x", r.j);
    r = await call("POST", "/api/calendar/confirm", { booking_id: "nope", start: slotC.start });
    check("confirm unknown booking → 404", r.status === 404, r);
    r = await call("POST", "/api/calendar/confirm", { booking_id: dana.id, start: new Date(Date.now() - DAY).toISOString() });
    check("confirm a past time → 400", r.status === 400, r);
    r = await call("GET", "/api/summary");
    let bc = r.j.bookings.find(b => b.id === cody.id), bd = r.j.bookings.find(b => b.id === dana.id);
    check("mark appended: summary shows confirmed + time + event id", bc && bc.mark.status === "confirmed" && bc.mark.confirmed_time === slotA.label && bc.mark.event_id === "ev1x" && bc.status === "confirmed" && bc.confirmed_time === slotA.label && bc.event_id === "ev1x", bc);
    check("summary: video booking carries meet_link", bd && bd.meet_link === "https://meet.google.com/abc-defg-hij" && bd.mark.meet_link === bd.meet_link, bd);

    /* --- calls --- */
    r = await call("GET", "/api/calendar/calls");
    const cl = r.j && r.j.calls || [];
    check("calls: only booking events, with booking ids", r.status === 200 && cl.length === 2 && cl.every(c => [cody.id, dana.id].includes(c.booking_id)) && !cl.some(c => c.event_id === "dentist1"), cl);
    const cd = cl.find(c => c.booking_id === dana.id), cc = cl.find(c => c.booking_id === cody.id);
    check("calls: fields {event_id, booking_id, start, end, how, meet_link, attendee_email, status}", cd && cd.how === "video" && cd.meet_link && cd.attendee_email === DANA && cd.status === "confirmed" && cc.how === "phone" && cc.meet_link === null && cc.start === slotA.start && cc.end, cl);

    /* --- move --- */
    r = await call("POST", "/api/calendar/move", { booking_id: cody.id, event_id: "ev1x", start: slotC.start });
    const pa = fake.patches[0] || {};
    check("move → {ok, label}; patch with sendUpdates=all", r.status === 200 && r.j.ok && r.j.label === slotC.label && pa.query && pa.query.sendUpdates === "all" && pa.body.start.dateTime === slotC.start && Date.parse(pa.body.end.dateTime) - Date.parse(pa.body.start.dateTime) === HOUR, { r: r.j, pa });
    r = await call("POST", "/api/calendar/move", { booking_id: cody.id, event_id: "ev2x", start: slotC.start });
    check("move someone else's event → 403", r.status === 403 && fake.patches.length === 1, r);
    r = await call("GET", "/api/summary"); bc = r.j.bookings.find(b => b.id === cody.id);
    check("move: summary shows the new time", bc.confirmed_time === slotC.label && bc.mark.confirmed_time === slotC.label && bc.event_id === "ev1x", bc.mark);

    /* --- cancel --- */
    r = await call("POST", "/api/calendar/cancel", { booking_id: dana.id, event_id: "ev2x" });
    const de = fake.deletes[0] || {};
    check("cancel → delete with sendUpdates=all", r.status === 200 && r.j.ok && de.id === "ev2x" && de.query.sendUpdates === "all", { r: r.j, de });
    r = await call("GET", "/api/summary"); bd = r.j.bookings.find(b => b.id === dana.id);
    check("cancel: summary shows cancelled, event cleared", bd.status === "cancelled" && bd.mark.status === "cancelled" && bd.event_id === null && bd.confirmed_time === null, bd.mark);
    r = await call("POST", "/api/calendar/confirm", { booking_id: dana.id, start: slotB.start });
    check("after cancel the booking can be confirmed again", r.status === 200 && r.j.ok, r);

    /* --- agents --- */
    r = await call("GET", "/api/agents");
    const A2 = Object.fromEntries((r.j && r.j.agents || []).map(a => [a.id, a]));
    check("agents: 20 helpers in order", r.status === 200 && r.j.agents.map(a => a.id).join() === G.HELPERS.map(h => h.id).join(), r.j);
    check("agents: drafts_ready counts the \"Ready to send\" label", r.j.drafts_ready === 3, r.j.drafts_ready);
    check("agents: Rancher Finder = 2 in 14 days (old + Re: ignored), newest subject", A2.finder.count_14d === 2 && A2.finder.last_subject === "Rancher Finder – 17 new ranches – Oct 29, 2026" && A2.finder.last_at === new Date(now - DAY).toISOString() && A2.finder.drafts === null, A2.finder);
    check("agents: Daily Driver and Watchdog found", A2.driver.count_14d === 1 && A2.watchdog.count_14d === 1 && /^Website alert/.test(A2.watchdog.last_subject), [A2.driver, A2.watchdog]);
    check("agents: \"Partner Outreach –\" counts for partners, not outreach", A2.partners.count_14d === 1 && A2.outreach.count_14d === 0 && A2.outreach.last_at === null, [A2.partners, A2.outreach]);
    check("agents: Referral = 1 sent + 1 draft, newest is the draft", A2.referral.count_14d === 1 && A2.referral.drafts === 1 && A2.referral.last_kind === "draft" && A2.referral.last_subject === "Thanks for the call, Cody", A2.referral);
    check("agents: Booking draft (curly apostrophe), Recap draft without label", A2.booking.drafts === 1 && A2.recap.drafts === 1 && A2.followup.drafts === 0, [A2.booking, A2.recap, A2.followup]);
    check("agents: rancher's own \"Re:\" doesn't count for Follow-Up / Calculator Questions", A2.followup.count_14d === 0 && A2.helper.count_14d === 0, [A2.followup, A2.helper]);
    check("agents: only an old email → no recent, but earlier_at is set (went quiet)", A2.analyst.last_at === null && A2.analyst.count_14d === 0 && A2.analyst.earlier_at === new Date(now - 30 * DAY).toISOString(), A2.analyst);
    check("agents: never emailed → earlier_at null; recent email → earlier_at null", A2.prep.earlier_at === null && A2.finder.earlier_at === null, [A2.prep, A2.finder]);
    check("agents: nothing found → nulls and 0", A2.prep.last_at === null && A2.prep.count_14d === 0 && A2.prep.drafts === null && A2.outreach.drafts === null, A2.prep);

    /* --- disconnect --- */
    r = await call("POST", "/api/google/disconnect");
    check("disconnect → revoke sent + token file deleted", r.status === 200 && r.j.ok && fake.revoked.includes(RT) && !fs.existsSync(tokFile), { r: r.j, revoked: fake.revoked.length });
    r = await call("GET", "/api/google/status");
    check("status after disconnect: not connected", r.j.connected === false && !r.j.email, r.j);
    r = await call("GET", "/api/calendar/free");
    check("calendar after disconnect → 409", r.status === 409 && r.j.connected === false, r);

    /* --- invalid_grant marks disconnected --- */
    r = await call("GET", "/api/google/start"); const st2 = new URL(r.loc).searchParams.get("state");
    await call("GET", `/api/google/callback?code=code-ok&state=${st2}`);
    fake.valid.clear(); fake.invalidGrant = true;
    r = await call("GET", "/api/inbox");
    check("refresh invalid_grant → 409 connected:false", r.status === 409 && r.j.connected === false, r);
    r = await call("GET", "/api/google/status");
    check("status shows disconnected with a plain-English error", r.j.connected === false && r.j.email === ALLEN && /Connect Gmail again/.test(r.j.error || ""), r.j);
    check("token file no longer holds a refresh token", !/"refresh"/.test(fs.readFileSync(tokFile, "utf8")));

    /* --- other routes still fine --- */
    r = await call("GET", "/api/google/nope");
    check("unknown /api/google/* → 404", r.status === 404, r);
    r = await call("POST", "/api/collect", { type: "visit", vid: "v9", src: "google.com" }, { Origin: "https://hangingweightco.com" });
    const corsR = await fetch(`${A}/api/collect`, { method: "OPTIONS", headers: { Origin: "https://hangingweightco.com" } });
    check("sanity: /api/collect still works (200 + CORS preflight)", r.status === 200 && r.j.ok && corsR.status === 204 && corsR.headers.get("access-control-allow-origin") === "https://hangingweightco.com", r);
    r = await call("POST", "/api/collect", { type: "visit" }, { Origin: "https://evil.test" });
    check("sanity: /api/collect still refuses other origins", r.status === 403, r);
    r = await call("POST", "/api/stripe", { type: "x" });
    check("sanity: /api/stripe still needs a signature", r.status === 400, r);
    r = await call("GET", "/api/summary");
    check("sanity: /api/summary still works (live, bookings, leads)", r.status === 200 && r.j.live === true && r.j.bookings.length === 3 && r.j.leads.length === 1 && r.j.weeks.length === 8, r.j && r.j.total);
    r = await call("POST", "/api/mark", { id: cody.id, set: { status: "done" } });
    const r2 = await call("GET", "/api/summary");
    check("sanity: /api/mark still merges (done keeps event_id)", r.status === 200 && r2.j.bookings.find(b => b.id === cody.id).mark.status === "done" && r2.j.bookings.find(b => b.id === cody.id).event_id === "ev1x");

    check("no token or client secret ever appeared in a response", leaks.length === 0, leaks);
    check("server logs hold no tokens", !logs.includes(RT) && !/at-\d+-access/.test(logs) && !logs.includes("csecret-test"), logs.slice(0, 500));
  } catch (e) {
    check("test run finished without crashing", false, e.stack);
  } finally {
    child.kill(); gsrv.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
  if (failed.length) { console.log("Server log:\n" + logs.slice(-2000)); process.exit(1); }
}
main();
