I'm Allen. I run Hanging Weight Co. (hangingweightco.com), a free beef price calculator for Texas ranchers, a $197 "Price It Right" call (by phone or video), and a $2,000 "Ranch Store in a Box" package. My business email is theherd@herddirect.net.

I have 20 helper agents written for me. Each one is a scheduled task that runs in my Claude account, reads my Gmail and writes drafts for me. I'm not technical, so please do the setup for me and keep everything in plain English.

The instructions for each agent are public on GitHub, one file per agent:
https://github.com/Calfbandit/hanging-weight-co/tree/main/handover/helpers
The raw text of each file is at:
https://raw.githubusercontent.com/Calfbandit/hanging-weight-co/main/handover/helpers/<file name>
Start by reading README.md there.

Please do this, in order:

1. Check that my Gmail is connected to Claude. If it isn't, stop and tell me exactly where to click to connect it (I'll use the Google account that gets theherd@herddirect.net mail and my Stripe receipts). If I use Google Calendar for calls, help me connect that too.

2. Ask me ONE question before you start: my business mailing address. (Outreach, Follow-Up, Partner Outreach, Upgrade and Local Buyer Finder put it at the bottom of every invitation, as the law requires.) Don't make one up.

3. Create these 6 agents first, as scheduled tasks, one at a time:
   - Rancher Finder (rancher-finder.md)
   - Outreach (outreach.md)
   - Follow-Up (follow-up.md)
   - Call Prep (call-prep.md)
   - Website Watchdog (watchdog.md)
   - Daily Driver (daily-driver.md)
   For each one:
   - Read the file. The task's instructions are EVERYTHING below the line that says "Copy everything below this line into the scheduled task". Use that text word for word. Don't shorten it, rewrite it or "improve" it.
   - Replace [Your mailing address] with the address I gave you, if it's in there.
   - Name the task exactly the agent's name.
   - Use the schedule the file gives under "When it runs" (the schedule code in backticks), in the America/Chicago (Central) time zone.
   - Give it Gmail, plus Web search if the file says it needs it, plus Google Calendar for Booking, Call Prep and Daily Driver if I connected it.
   - If the file has a "Before you save it" part, tell me what it says in one or two plain sentences.

4. When the 6 are done, show me a short table: agent, when it runs, what it does. Then run Daily Driver once right now so I can see the morning email arrive in my inbox.

5. Then ask me if I want the next group. The order is:
   - Turning visitors into calls: Calculator Questions, Booking, Call Recap, Upgrade, Referral
   - Getting the word out: Article Writer, Post Writer, Partner Outreach, Weekly Numbers
   - Only when my first $2,000 client starts: HerdDirect Profile Builder, Local Buyer Finder, Client Post Writer, Order Reminders, Client Report
   Set each group up the same way as step 3.

Rules you must keep, now and later:
- The agents never send anything to a rancher, buyer or business. They only write Gmail drafts (under the label "Ready to send") and send emails to me alone.
- Never make up ranches, people, numbers, reviews, stories, prices or health claims.
- Never use Facebook, Instagram, LinkedIn, TikTok or any social media.
- Don't change prices, my Stripe links or my policies.
- If you can't create scheduled tasks from this chat, tell me plainly and walk me through creating each one by hand: where to click, what to paste, what schedule to pick.
- If something doesn't work, tell me what happened in one sentence and what I should do. Don't guess.
