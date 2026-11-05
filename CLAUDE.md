# Hanging Weight Co. — rules for Claude when changing this site

This repo is Allen's website for Hanging Weight Co. (hangingweightco.com). Allen is not technical: explain in plain English and tell him exactly what you changed.

- Plain HTML/CSS/JS, no build step, no framework. Served by GitHub Pages at hangingweightco.com (CNAME present).
- Pages: index.html (home), calculator/index.html, book/index.html ($197 booking), book/thanks/index.html. Shared files in assets/.
- Settings at the top of each page (keep them the same in all four): HW_API (Allen's board), SESSION_URL ($197 Stripe link), PACKAGE_URL ($1,000 deposit link; the "Tell Allen you're interested" form was removed on Nov 5, so keep this filled in or the $2,000 buttons do nothing), MIXPANEL_TOKEN, CAPTURE_URL. Never put passwords, API keys or secret tokens in this repo.
- Only Allen decides prices, the Stripe links and the policy text. Change them only when he asks.
- Never add claims about beef (grass-fed, organic, health), made-up reviews, testimonials, stats or stories.
- The owner's board (sign-in, data collector, Gmail/Calendar) lives in board/ and runs on its own server at board.hangingweightco.com; see board/README.md. GitHub Pages skips that folder.
- The agents' instructions live in handover/helpers/. Going-live steps are in docs/GO-LIVE.md.
- After a change: check every <script> block still parses, open the changed pages in a browser at phone width, test the calculator and the booking form once, then commit with a plain-English message.
