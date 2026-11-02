#!/usr/bin/env node
// Sign-in for the Hanging Weight Co. owner's board.
// Runs on 127.0.0.1 behind Caddy. Caddy sends /signin and /auth/* here and asks
// /auth/check (forward_auth) before serving any board file. Built-in modules only.
//
//   node auth/server.js                              start the server
//   node auth/server.js set-password <email> [--must-change] [--role owner|admin] [--generate]
//
// Users live in $HW_DIR/users.json (default /etc/hw-board), hashes only, chmod 600.
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DIR = process.env.HW_DIR || "/etc/hw-board";
const USERS = path.join(DIR, "users.json");
const SECRET = path.join(DIR, "secret");
const PORT = Number(process.env.HW_PORT || 8790);
const HOST = process.env.HW_HOST || "127.0.0.1";
const COOKIE = "hwb_s";
const DAY = 86400000;
const KEEP_MS = 30 * DAY;      // "Keep me signed in on this phone"
const SHORT_MS = 1 * DAY;      // browser-session cookie; server-side cap
const MIN_LEN = 10;
const MAX_TRIES = 5, LOCK_MS = 15 * 60000;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/* ---------- storage ---------- */
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}
function saveUsers(u) {
  const tmp = USERS + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2) + "\n", { mode: 0o600 });
  if (process.getuid && process.getuid() === 0) { const st = fs.statSync(DIR); fs.chownSync(tmp, st.uid, st.gid); }
  fs.renameSync(tmp, USERS);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, key] = String(stored || "").split("$");
  if (alg !== "scrypt") return false;
  const want = Buffer.from(key, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, want);
}
// Spend the same time on unknown emails so they can't be told apart by timing.
const DUMMY = hashPassword(crypto.randomBytes(12).toString("hex"));

/* ---------- sessions: signed cookie {e,g,x,k} ---------- */
let secret = null;
function sign(s) { return crypto.createHmac("sha256", secret).update(s).digest("base64url"); }
function makeCookie(email, user, keep) {
  const body = Buffer.from(JSON.stringify({ e: email, g: user.gen || 0, x: Date.now() + (keep ? KEEP_MS : SHORT_MS), k: keep ? 1 : 0 })).toString("base64url");
  const attrs = ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (keep) attrs.push("Max-Age=" + KEEP_MS / 1000);
  return `${COOKIE}=${body}.${sign(body)}; ${attrs.join("; ")}`;
}
const CLEAR = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
function session(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [body, mac] = m[1].split(".");
  if (!body || !mac) return null;
  const a = Buffer.from(sign(body)), b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let s; try { s = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (!s || s.x < Date.now()) return null;
  const user = loadUsers()[s.e];
  if (!user || (user.gen || 0) !== s.g) return null;  // password changed → old sessions end
  return { email: s.e, user, keep: !!s.k };
}

/* ---------- lockout: 5 wrong tries per account in 15 min ---------- */
const fails = new Map();
function recentFails(email) {
  const now = Date.now(), list = (fails.get(email) || []).filter(t => now - t < LOCK_MS);
  fails.set(email, list); return list;
}

/* ---------- pages ---------- */
const PAGES = {};
function page(name) {
  if (!PAGES[name] || process.env.HW_DEV) PAGES[name] = fs.readFileSync(path.join(__dirname, name), "utf8");
  return PAGES[name];
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function render(name, vals = {}) {
  return page(name)
    .replace("<!--ERROR-->", vals.error ? `<p class="err" role="alert">${esc(vals.error)}</p>` : "")
    .replace("__EMAIL__", esc(vals.email || ""));
}
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin", "X-Content-Type-Options": "nosniff" };
function send(res, code, body, type, extra = {}) {
  res.writeHead(code, { ...BASE_HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}
const html = (res, code, body, extra) => send(res, code, body, "text/html; charset=utf-8", extra);
const go = (res, to, extra = {}) => { res.writeHead(303, { ...BASE_HEADERS, Location: to, ...extra }); res.end(); };

function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 8192) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on("error", reject);
  });
}
// Same-site check for form posts (SameSite=Lax already blocks cross-site cookies on POST).
function sameOrigin(req) {
  const o = req.headers.origin;
  return !o || o === `https://${req.headers.host}`;
}
const safeNext = n => (/^#[a-z]{2,20}$/.test(n || "") ? "/" + n : "/");
const SIGNIN_ERR = "That username or password isn't right.";
const LOCKED = "Too many tries. Wait 15 minutes and try again.";

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/auth/check") {  // Caddy forward_auth
    const s = session(req);
    if (!s) return go(res, "/signin");
    if (s.user.must_change) return go(res, "/auth/new-password");
    res.writeHead(200, { "X-HW-User": s.email }); return res.end();
  }
  if (p === "/auth/signin.css") return send(res, 200, page("signin.css"), "text/css; charset=utf-8", { "Cache-Control": "public, max-age=3600" });

  if (p === "/signin" && req.method === "GET") {
    const s = session(req);
    if (s) return go(res, s.user.must_change ? "/auth/new-password" : "/");
    return html(res, 200, render("signin.html"));
  }
  if (p === "/signin" && req.method === "POST") {
    if (!sameOrigin(req)) return html(res, 403, "Forbidden");
    const f = await readForm(req);
    const email = String(f.email || "").trim().toLowerCase();
    const keep = f.keep === "1";
    if (recentFails(email).length >= MAX_TRIES) return html(res, 429, render("signin.html", { error: LOCKED, email }));
    const user = loadUsers()[email];
    const ok = checkPassword(String(f.password || ""), user ? user.hash : DUMMY) && !!user;
    if (!ok) {
      recentFails(email).push(Date.now());
      return html(res, 401, render("signin.html", { error: SIGNIN_ERR, email }));
    }
    fails.delete(email);
    return go(res, user.must_change ? "/auth/new-password" : safeNext(f.next), { "Set-Cookie": makeCookie(email, user, keep) });
  }

  if (p === "/auth/new-password") {
    const s = session(req);
    if (!s) return go(res, "/signin");
    if (req.method === "GET") return html(res, 200, render("new-password.html", { email: s.email }));
    if (req.method !== "POST" || !sameOrigin(req)) return html(res, 405, "Not allowed");
    const f = await readForm(req);
    const pw = String(f.password || ""), pw2 = String(f.password2 || "");
    let error = "";
    if (pw.length < MIN_LEN) error = `Use at least ${MIN_LEN} characters.`;
    else if (pw !== pw2) error = "The two passwords don't match. Type them again.";
    else if (checkPassword(pw, s.user.hash)) error = "Pick a new one, not the one you were given.";
    if (error) return html(res, 400, render("new-password.html", { error, email: s.email }));
    const users = loadUsers(), u = users[s.email];
    u.hash = hashPassword(pw); u.must_change = false; u.gen = (u.gen || 0) + 1; u.changed = new Date().toISOString();
    saveUsers(users);
    return go(res, "/#funnel", { "Set-Cookie": makeCookie(s.email, u, s.keep) });
  }

  if (p === "/auth/me") {
    const s = session(req);
    if (!s || s.user.must_change) return send(res, 401, '{"error":"signed out"}', "application/json");
    return send(res, 200, JSON.stringify({ email: s.email, role: s.user.role }), "application/json");
  }
  if (p === "/auth/signout") return go(res, "/signin", { "Set-Cookie": CLEAR });

  return html(res, 404, "Not found");
}

function serve() {
  secret = fs.readFileSync(SECRET);
  if (secret.length < 32) throw new Error(`${SECRET} is too short`);
  http.createServer((req, res) => handle(req, res).catch(e => {
    console.error(e);
    if (!res.headersSent) html(res, 500, "Something went wrong. Try again in a minute.");
  })).listen(PORT, HOST, () => console.log(`hw-board auth on ${HOST}:${PORT}`));
}

/* ---------- set-password command ---------- */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("run this in a terminal"));
    process.stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let pw = "";
    const onData = ch => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); return resolve(pw); }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") pw = pw.slice(0, -1); else pw += c;
      }
    };
    stdin.on("data", onData);
  });
}
async function setPassword(args) {
  const email = String(args.find(a => !a.startsWith("--")) || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error("usage: node auth/server.js set-password <email> [--must-change] [--role owner|admin] [--generate]"); process.exit(2); }
  const roleArg = args.find(a => a.startsWith("--role="))?.split("=")[1] || (args.includes("--role") ? args[args.indexOf("--role") + 1] : null);
  if (roleArg && !["owner", "admin"].includes(roleArg)) { console.error("role must be owner or admin"); process.exit(2); }
  const users = loadUsers();
  const prev = users[email];
  let pw;
  if (args.includes("--generate")) {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    pw = Array.from(crypto.randomBytes(18), b => abc[b % abc.length]).join("").replace(/(.{6})(?=.)/g, "$1-");
  } else {
    pw = await askHidden(`New password for ${email} (nothing shows while you type): `);
    const again = await askHidden("Type it again: ");
    if (pw !== again) { console.error("The two didn't match. Nothing changed."); process.exit(1); }
    if (!pw) { console.error("Empty password. Nothing changed."); process.exit(1); }
    if (pw.length < MIN_LEN) console.log(`Note: shorter than ${MIN_LEN} characters.`);
  }
  users[email] = {
    role: roleArg || prev?.role || "owner",
    hash: hashPassword(pw),
    must_change: args.includes("--must-change"),
    gen: (prev?.gen || 0) + 1,   // ends this person's existing sessions
    changed: new Date().toISOString(),
  };
  saveUsers(users);
  if (args.includes("--generate")) console.log(`Password for ${email} (shown once, not stored): ${pw}`);
  console.log(`Saved ${email} as ${users[email].role}${users[email].must_change ? ", must pick a new password at first sign-in" : ""}. Existing sign-ins for this account have ended.`);
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "set-password") setPassword(rest).catch(e => { console.error(e.message); process.exit(1); });
  else if (!cmd) serve();
  else { console.error(`unknown command: ${cmd}`); process.exit(2); }
}
module.exports = { handle, hashPassword, checkPassword };
