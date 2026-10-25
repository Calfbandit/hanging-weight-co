# Going live: hangingweightco.com

Plain-English steps. You don't need to write any code. Where a step says "paste", you're pasting one line of text into a box on a website.

---

## 1. Where things stand today

- **hangingweightco.com does not show this repo yet.** Right now the domain *forwards* (redirects) visitors to a page that was published from Claude on Allen's account. That page is the old version.
- **This repo** (github.com/Calfbandit/hanging-weight-co) holds the new home page and the new Beef Price Calculator (version 2). It already has a file called `CNAME` that says `hangingweightco.com`, so GitHub knows which domain it belongs to.
- Going live means two things: turn on GitHub Pages for this repo, then point the domain at GitHub instead of at the Claude page.

**Who does this:** DJ or Allen only. Changing where the domain points affects the live site.

**Before you start:** the new pages are already on the `main` branch (done Oct 24, 2026).

---

## 2. Turn on GitHub Pages (about 2 minutes)

1. Go to **github.com** and sign in with the account that owns the Calfbandit repos.
2. Open **github.com/Calfbandit/hanging-weight-co**.
3. Click **Settings** (the gear tab along the top of the repo, on the right).
4. In the left-hand menu, click **Pages**.
5. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
6. Under **Branch**, pick **main** in the first box and **/ (root)** in the second box. Click **Save**.
7. Wait 1–2 minutes and refresh the page. At the top you'll see "Your site is live at …". Click that link and check that you see the new home page with the orange "Price my beef — free" button.
8. Further down on the same Pages screen, under **Custom domain**, it should already say `hangingweightco.com` (from the CNAME file). If the box is empty, type `hangingweightco.com` and click **Save**.
9. Leave this tab open. You'll come back to tick **Enforce HTTPS** at the end.

---

## 3. Point the domain at GitHub (about 10 minutes, then a wait)

You do this where the domain was bought (the "registrar", for example GoDaddy, Namecheap, Squarespace Domains or Cloudflare). Sign in there and find **hangingweightco.com**.

### 3a. Turn off the forward to the Claude page

1. Open the domain's settings and look for **Forwarding**, **Redirect** or **URL forwarding**.
2. You'll see a forward pointing to the Claude page. **Delete** (or turn off) that forward and save.

### 3b. Add the GitHub addresses

1. Find **DNS**, **DNS records** or **Manage DNS** for hangingweightco.com.
2. Delete any existing records of type **A** or **AAAA** whose name is `@` (they're left over from the forward). Don't touch **MX** or **TXT** records; those are for email.
3. Add these four **A** records. For each one, click **Add record**, choose type **A**, name `@`, and paste one address:
   - `185.199.108.153`
   - `185.199.109.153`
   - `185.199.110.153`
   - `185.199.111.153`
4. Add one **CNAME** record: name `www`, value `calfbandit.github.io` (if a `www` record already exists, edit it to this value instead).
5. Click **Save**.

### 3c. Wait, then check

1. It can take anywhere from 10 minutes to a few hours for the change to spread.
2. Go back to the GitHub **Settings → Pages** tab. When the domain check turns green, tick **Enforce HTTPS**.
3. Open **hangingweightco.com** on your phone (use mobile data, not Wi-Fi, so you're not seeing an old saved copy). You should see the new home page. Tap **Price my beef — free** and run the calculator once.

**If something looks wrong:** put the forward back (step 3a in reverse) and the old Claude page returns. Nothing is lost.

---

## 4. Turn on the $2,000 "Do it all for me" checkout (when you're ready)

Right now the $2,000 button doesn't take payment. It opens a short "Tell Allen you're interested" form (name, phone, email, head count), and that comes to Allen by email. That's on purpose: we don't show a checkout until a real one exists.

When Allen is ready to take the $1,000 deposit online:

### 4a. Make the payment link in Stripe

1. Sign in at **dashboard.stripe.com** with Allen's Stripe account.
2. **First do it in Test mode:** flip the **Test mode** switch (top right) on. Test it with card number `4242 4242 4242 4242`, any future date, any 3 digits. Then repeat these steps with Test mode off for the real link.
3. In the left menu click **Payment Links** (you may need to click **More** first).
4. Click **+ New** (or **Create payment link**).
5. Click **+ Add a new product**. Name: `Ranch Store in a Box – deposit`. Price: `1000`, **One time**, currency **USD**. Click **Add product**.
6. Leave quantity fixed at 1. Click **Create link** (top right).
7. Click **Copy** next to the link. It starts with `https://buy.stripe.com/…`.

### 4b. Paste the link into the site

The link goes into **two** files, on the line that says `const PACKAGE_URL = "";`:

- `calculator/index.html`
- `index.html`

Paste it between the two quote marks, like this:

```
const PACKAGE_URL = "https://buy.stripe.com/your-link-here";
```

To do it on the GitHub website (no software needed):

1. Go to github.com/Calfbandit/hanging-weight-co and sign in.
2. Click `index.html`, then the **pencil icon** (top right of the file) to edit it.
3. Press Ctrl+F (Cmd+F on a Mac), type `PACKAGE_URL`, and paste the link between the two quote marks on that line.
4. Click the green **Commit changes…** button, then **Commit changes** again.
5. Do the same for `calculator/index.html` (click the `calculator` folder first).

Within a couple of minutes the $2,000 button opens the Stripe checkout instead of the interest form. If you'd rather not edit the files, send the link to DJ and we'll do it.

The $197 button already uses Allen's existing Stripe link (`SESSION_URL` in both files). Don't change it unless the price changes.

---

## 5. Lead emails to Allen (when the email system is switched on)

Until the form's server is connected, both forms (the free "Email me my plan" form and the $2,000 interest form) open the visitor's own email app with a message to **theherd@herddirect.net** already filled in. The visitor taps Send.

Once DJ connects the server (the `CAPTURE_URL` setting), every calculator lead and every $2,000 interest form is saved and Allen gets an email automatically. These settings live in Supabase (**Project → Edge Functions → Secrets**), never in the website files. Names only:

| Setting name | What it is |
|---|---|
| `SENDGRID_API_KEY` | Lets the server send email (already planned) |
| `MAILING_ADDRESS` | Postal address printed at the bottom of emails to ranchers (already planned) |
| `NOTIFY_EMAIL` | **New.** Where Allen's "New calculator lead" and "Package interest" emails go. If left empty, they go to `theherd@herddirect.net`. |

Lead notification subjects look like:
- `New calculator lead – Jane Smith`
- `Package interest – Jane Smith`

Each one lists what the person entered: name, email, phone, head count, how they sell (whole/half/quarter), ZIP and their estimated break-even.

---

## 6. After going live: quick checklist

- [ ] hangingweightco.com shows the new home page on a phone.
- [ ] The calculator opens at hangingweightco.com/calculator/ and "See my prices" shows a price sheet.
- [ ] **Print price sheet** gives one clean black-and-white page.
- [ ] The $197 button opens Stripe checkout for $197 (you can close it without paying), and the checkout page does **not** say "Test mode" at the top. If it does, the link is a test link: make a live one in Stripe and paste it into `SESSION_URL` the same way as step 4b.
- [ ] The $2,000 button opens the interest form (or the $1,000 Stripe checkout, if you've done step 4).
- [ ] Policies and contact email are still on the home page.
- [ ] In Mixpanel, events like `calculator_opened` show up within a few minutes.

---

## 7. Your owner's board is private

Your owner's board (the phone screen with your ranchers, helpers and money) is **not** part of the public website. DJ shares it with you as a private link; open that link and add it to your phone's home screen. The website settings in this repo keep the `dashboard`, `handover`, `docs` and `supabase` folders off hangingweightco.com.
