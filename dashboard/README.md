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
