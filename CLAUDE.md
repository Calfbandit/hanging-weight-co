# Hanging Weight Co. — repo rules (lane C)

Read ../CLAUDE.md first (the shared South Creek rules). This repo is lane C.

- Plain HTML/CSS/JS, no build step, no framework. Served by GitHub Pages at hangingweightco.com (CNAME present).
- Branch for lane C: lane-c/capture. Status Oct 1: calculator moved to calculator/index.html; email capture form,
  Mixpanel events, supabase/functions/capture-lead and supabase/migrations/0001_leads.sql are committed.
- Config lives in two constants, never secrets: CAPTURE_URL and MIXPANEL_TOKEN (both pages). Empty CAPTURE_URL = mailto fallback.
- Function secrets are set in Supabase: SENDGRID_API_KEY, MAILING_ADDRESS. Never commit them.
- Don't change prices, the Stripe link, or policy text without DJ's OK (Allen owns the offer).
- Any copy change that makes a claim about beef (grass-fed, organic, health) is refused; see the shared rules.
- After a change: syntax-check every <script> block, open both pages in a browser, test the form once, then commit with a plain-English message.
