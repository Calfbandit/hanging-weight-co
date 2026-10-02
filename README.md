# Hanging Weight Co.

Website and free Beef Price Calculator for Hanging Weight Co., consulting for cattle ranchers who sell beef direct.

## What's here

| Path | What it is |
|---|---|
| `index.html` | Business website: the $197 Beef Pricing & Direct-Sales Game Plan session, how it works, contact, policies |
| `calculator/index.html` | Free Beef Price Calculator: cost per head → price per lb hanging weight → whole/half/quarter price sheet, plus "Email me this price sheet" |
| `supabase/functions/capture-lead/` | Edge function that stores a calculator lead in the `leads` table and emails the price sheet via SendGrid |
| `supabase/migrations/0001_leads.sql` | The `leads` table |
| `facebook-ad.png` | 1080×1080 Facebook/Instagram ad graphic |
| `CNAME` | Custom domain for GitHub Pages (`hangingweightco.com`) |

Plain HTML, CSS and JavaScript. No build step: open `index.html` in a browser to preview.

## Config (no secrets in this repo)

- `calculator/index.html`: `CAPTURE_URL` = the deployed capture-lead function URL. While it's empty, the form falls back to a pre-filled email to info@hangingweightco.com, so leads still arrive.
- `index.html` and `calculator/index.html`: `MIXPANEL_TOKEN` = the shared South Creek Mixpanel project token. Empty = tracking off.
- Function secrets are set in Supabase, never here: `SENDGRID_API_KEY`, `MAILING_ADDRESS` (plus the Supabase URL and service key the platform provides).
- capture-lead always saves the lead, but only sends the email once `MAILING_ADDRESS` and `SENDGRID_API_KEY` are set, at most 3 per address per day and 50 per hour overall. It builds the price sheet from the calculator numbers itself, and every email carries an unsubscribe link (the same function, `?unsubscribe=<lead id>`).

## Deploy

1. GitHub Pages serves `main` at hangingweightco.com (DNS must point here; see the master plan, lane C).
2. `supabase db push` then `supabase functions deploy capture-lead --no-verify-jwt`, then paste the function URL into `CAPTURE_URL`.

## Links

- Website: https://hangingweightco.com
- Calculator: https://hangingweightco.com/calculator/
- Payment (Stripe): https://buy.stripe.com/8x2fZh3cn7xtf0097L6Zy01
- Contact: info@hangingweightco.com
