# Owner's board (Hanging Weight Co.)

Allen's phone-first dashboard: the rancher "alley" (visitors → calculator → email → $197 call → $2,000 package),
traffic, growth, the six helpers, calls & clients, what's waiting, websites and money.

- `index.html` — the page, ready to serve (GitHub Pages or any static host). Open it in a browser; no build step.
- `app.html` — the same page without the outer HTML wrapper (used to publish it as a Claude page).

It runs on **demo data** today (yellow "Demo data" band on every screen). The demo numbers live in one block at the top
of the script, marked `DEMO SEED DATA`. At handover they're replaced by live numbers from:
- Mixpanel project "Herd Direct", events tagged `site = hanging_weight` (calculator_opened, calculator_completed,
  email_captured, session_cta_clicked, stripe_checkout_opened, upgrade_cta_clicked, package_checkout_opened)
- Allen's Stripe ($197 calls, $1,000 package payments)
- The helpers' emails in Allen's Gmail
No passwords or keys belong in this file.

## Sign-in

Who has access: Allen (owner, `theherd@herddirect.net`) and an admin, if you add one. Only the admin sees Handover.

- `auth/server.js` runs on the box as `hw-board-auth.service` on 127.0.0.1:8790. Caddy sends `/signin` and `/auth/*` to it and asks `/auth/check` (forward_auth) before serving the board.
- Users (scrypt hashes only) live in `/etc/hw-board/users.json`; the cookie secret in `/etc/hw-board/secret`. Both chmod 600, never in this repo.
- Add a user or reset a password (asks twice, nothing shows while you type; ends that person's other sign-ins):
  `sudo node /opt/hw-board/auth/server.js set-password <email> [--must-change] [--role owner|admin]`

## Live numbers from the website (api/server.js)

The website (hangingweightco.com) posts each visit, calculator use, email left, $197 booking and $2,000 interest to
`POST /api/collect`. The board reads the totals from `GET /api/summary` and switches its yellow "Demo data" band to a green
"Live" band as soon as the first event arrives. Until then it shows sample numbers. `?demo=1` forces the sample numbers.

- Service: `api/hw-board-api.service` (127.0.0.1:8791), data in `/var/lib/hw-board/events.jsonl` (one line per event).
- Caddy: add `api/Caddyfile.snippet` to the site block. `/api/collect` and `/api/stripe` are public (collect only accepts
  Allen's site origins, 60 requests/min per visitor); every other `/api/*` sits behind the same sign-in as the board.
- Optional in `/etc/hw-board/api.env` (chmod 600, never in git): `SENDGRID_API_KEY`, `FROM_EMAIL`, `NOTIFY_EMAIL` (emails Allen
  "New booking – …", "New calculator lead – …", "Package interest – …"), `BOARD_URL` (your board's address, used in those emails), `STRIPE_WEBHOOK_SECRET` (Stripe webhook to
  `https://<your board address>/api/stripe`, event `checkout.session.completed`, turns "Paid? Check Stripe" into "Paid $197").

## Gmail and Calendar (api/google.js)

The board reads and answers Allen's emails with booked ranchers through **his own Gmail**, puts confirmed calls on **his
Google Calendar** (Google emails the rancher the invite, with a Google Meet link for video calls), and shows each helper's
latest email. Nothing new for Caddy: it all lives under `/api/*`, which already needs the board sign-in.

What it can and can't do:
- It only opens email threads that include a rancher who booked or left an email on hangingweightco.com, and only sends
  to those addresses (at most 30 emails an hour). It can't be used to read Allen's other mail or to email anyone else.
- It only moves or cancels calendar events it created for a booking.
- Allen's Google sign-in is stored encrypted in `/var/lib/hw-board/google.json` (chmod 600). "Disconnect" removes it and tells Google.

**One-time Google setup (about 15 minutes), signed in to Google as Allen:**
1. Go to console.cloud.google.com → project picker (top left) → **New project** → name it `Hanging Weight Board` → **Create**, and select it.
2. **APIs & Services → Library**: search **Gmail API** → **Enable**. Back to Library: **Google Calendar API** → **Enable**.
3. **APIs & Services → OAuth consent screen** (may be called **Google Auth Platform → Branding**): User type **External** →
   app name `Hanging Weight Co. board`, support email and developer email = yours → **Save**.
4. **Data access / Scopes → Add or remove scopes**: tick `openid`, `.../auth/userinfo.email`, `.../auth/gmail.modify` and
   `.../auth/calendar.events` (paste the last two in "Manually add scopes" if you can't find them) → **Update** → **Save**.
5. **Audience** (or the consent screen page): **Publish app → Confirm** so it's "In production". Don't submit for verification;
   unverified is fine for one user. (Left in "Testing", Google signs Allen out every 7 days.)
6. **Credentials → Create credentials → OAuth client ID** → type **Web application** → name `board` → under
   **Authorized redirect URIs** add `https://<your board address>/api/google/callback` (and put the same address in `GOOGLE_REDIRECT_URI` in api.env) → **Create**. Copy the
   Client ID and Client secret.
7. On the box, add to `/etc/hw-board/api.env` (chmod 600, owner root, never in git):
   ```
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   HW_TOKEN_KEY=<run: openssl rand -base64 36>
   ```
   then `sudo systemctl restart hw-board-api`.
8. Allen opens the board → Inbox → **Connect Gmail**, picks his Google account, sees "Google hasn't verified this app" →
   **Advanced → Go to Hanging Weight Co. board (unsafe)** (once; it's our own app), ticks **every** box → **Continue**.
   He lands back on the Inbox. If he unticks Gmail or Calendar, the board says so and he tries again.

Endpoints (all signed-in only; errors are `{ok:false, error:"<plain English>"}`, 409 `{connected:false}` when Gmail isn't connected,
502 when Google fails): `GET /api/google/start`, `GET /api/google/callback`, `GET /api/google/status`, `POST /api/google/disconnect`,
`GET /api/inbox`, `GET /api/thread?id=&markread=1`, `POST /api/reply`, `GET /api/calendar/free?days=7`, `GET /api/calendar/calls`,
`POST /api/calendar/confirm|move|cancel`, `GET /api/agents`. Shapes are listed at the top of `api/google.js`.
Confirm/move/cancel also save the call's status, time and calendar event on the booking, so `/api/summary` shows them.
Test everything against a fake Google with `node api/test-google.js`.

