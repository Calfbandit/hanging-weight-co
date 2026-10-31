GO-LIVE PROMPT 1 of 3 — Put the website live on hangingweightco.com
(Use Claude with Claude in Chrome turned on, on your computer, so it can click through GitHub, your domain company and Stripe while you're signed in.)

I'm Allen. I own hangingweightco.com, the GitHub account Calfbandit, and my Stripe account. My new website is finished and sits in github.com/Calfbandit/hanging-weight-co. Please put it live on my domain. Follow docs/GO-LIVE.md in that repo exactly (read it first at https://raw.githubusercontent.com/Calfbandit/hanging-weight-co/main/docs/GO-LIVE.md).

Do it in this order, and tell me in plain English what you're doing at each step:
1. GitHub: in the hanging-weight-co repo, turn on GitHub Pages (Settings → Pages → Deploy from a branch → main, root). Make sure the custom domain says hangingweightco.com.
2. My domain company: find out where hangingweightco.com is registered (ask me if you can't tell). Turn off the forward that sends it to my old Claude page. Delete old A/AAAA records for @ (never touch MX or TXT records, those are my email). Add four A records for @: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153. Add a CNAME for www pointing to calfbandit.github.io.
3. Wait until GitHub's domain check turns green, then tick Enforce HTTPS.
4. Stripe: on my $197 Payment Link (the one ending in 7L6Zy01), set After payment → redirect to https://hangingweightco.com/book/thanks/
5. Check: open hangingweightco.com and hangingweightco.com/calculator and tell me what you see.

Rules: I sign in myself whenever a site asks for a password. Ask me before you save each change. Never touch my email records, my bank details or anything not listed here. If something goes wrong, turning the old forward back on brings the old page back.


GO-LIVE PROMPT 2 of 3 — Put my owner's board live
(Use Claude Code in the Claude desktop app on your computer, so it can set up a small server for you.)

I'm Allen. My owner's board for Hanging Weight Co. is in the GitHub repo hanging-weight-board (in my Calfbandit GitHub). It needs a small always-on Linux server. Read the repo's README.md first, then set it up for me step by step:
1. Help me rent the smallest Linux server from a well-known provider (for example DigitalOcean or Hetzner, about $5–6 a month). I'll create the account and pay myself; tell me exactly what to click.
2. Give the board the address board.hangingweightco.com: add an A record for "board" at my domain company pointing to the server.
3. On the server, install Node and Caddy and set up the board exactly as the README says: the sign-in service, the data collector, the Caddy settings and HTTPS. Set BOARD_URL to https://board.hangingweightco.com.
4. Create my sign-in: owner, my email theherd@herddirect.net. Let me type the password myself; never show it or save it anywhere else.
5. Point my website at the board: in the hanging-weight-co repo, change HW_API to "https://board.hangingweightco.com/api" in all four pages (index.html, calculator/index.html, book/index.html, book/thanks/index.html) and save it to GitHub.
6. Gmail and Calendar inside the board: walk me through the one-time Google setup in the README (I'll sign in to Google myself), then I'll click Inbox → Connect Gmail on the board.
7. Check: open the calculator on my phone, run it once, and show me it appearing on the board.

Rules: passwords and keys only ever go in the server's private settings file (/etc/hw-board), never in GitHub, never in chat. Ask me before anything that costs money.


GO-LIVE PROMPT 3 of 3 — Take the $2,000 package online (only when you're ready)
(Use Claude with Claude in Chrome, then Claude Code.)

I'm Allen. In my Stripe account, make a Payment Link called "Ranch Store in a Box – deposit" for $1,000, one time, USD. Make it in Test mode first and check it with card 4242 4242 4242 4242, then make the real one with Test mode off. Then, in my GitHub repo Calfbandit/hanging-weight-co, put the real link in PACKAGE_URL in all four pages (index.html, calculator/index.html, book/index.html, book/thanks/index.html), save it to GitHub, and check the $2,000 button on hangingweightco.com opens the Stripe checkout. Ask me before saving anything in Stripe.
