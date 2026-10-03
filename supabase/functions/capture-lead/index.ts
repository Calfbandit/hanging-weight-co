// Supabase Edge Function: capture-lead (lane C)
// POST (JSON): stores a calculator lead and emails the rancher their price sheet through SendGrid.
// GET or POST with ?unsubscribe=<lead id>: marks that email address unsubscribed (link + one-click header in every email).
// Secrets (set with `supabase secrets set`): SENDGRID_API_KEY, MAILING_ADDRESS (postal address for the email footer).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by the platform.
//
// Anti-abuse: the email body is built here from the calculator numbers, never from text the browser sends,
// so this can't be used to mail arbitrary content. Leads are always saved; the email is skipped when the
// per-address or hourly cap is hit, when the honeypot field is filled, or when MAILING_ADDRESS is unset.
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://hangingweightco.com", "https://www.hangingweightco.com"];
const MAX_EMAILS_PER_ADDRESS_PER_DAY = 3;
const MAX_EMAILS_PER_HOUR = 50;
const INPUT_KEYS = ["live", "dress", "yield", "calf", "feed", "pasture", "vet", "haul", "mkt", "kill", "cut", "profit", "grocery"];

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});
const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const usd = (v: number, d = 0) =>
  (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const lb = (v: number) => Math.round(v).toLocaleString("en-US") + " lb";
const round2 = (v: number) => Math.round(v * 100) / 100;

// Same math and wording as calc() in calculator/index.html. Change both together.
function priceSheet(n: Record<string, number>, custPays: boolean) {
  const hanging = n.live * n.dress / 100;
  const take = hanging * n.yield / 100;
  if (hanging <= 0) return null;
  const costs = n.calf + n.feed + n.pasture + n.vet + n.haul + n.mkt;
  const proc = n.kill + n.cut * hanging;
  const base = custPays ? costs : costs + proc;
  const exact = (base + n.profit) / hanging;
  const price = Math.ceil(exact * 20 - 1e-9) / 20;
  const rancherTotal = price * hanging;

  const lines = [
    "BEEF PRICE SHEET",
    usd(price, 2) + "/lb hanging weight" + (custPays ? " + processing paid to the processor" : ", processing included"),
    "",
  ];
  for (const [name, f] of [["Whole", 1], ["Half", .5], ["Quarter", .25]] as const) {
    const h = hanging * f, yours = rancherTotal * f, p = custPays ? proc * f : 0;
    const total = yours + p;
    const deposit = Math.round(yours * 0.25 / 25) * 25;
    lines.push(`${name}: about ${lb(h)} hanging, ${lb(take * f)} take-home. About ${usd(total)} total${custPays ? ` (${usd(yours)} to us + about ${usd(p)} processing)` : ""}. ${usd(deposit)} deposit reserves your spot.`);
  }
  return {
    sheet: lines.join("\n"),
    results: {
      price_per_lb_hanging: price, hanging_lb: round2(hanging), take_home_lb: round2(take),
      cost_per_head: round2(costs), processing_per_head: round2(proc), profit_per_head: round2(rancherTotal - base),
    },
  };
}

Deno.serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const unsubscribeId = new URL(req.url).searchParams.get("unsubscribe");
  if (unsubscribeId !== null && (req.method === "GET" || req.method === "POST")) {
    const notFound = "That unsubscribe link didn't work. Email info@hangingweightco.com and we'll take you off the list.";
    if (!/^[0-9a-f-]{36}$/i.test(unsubscribeId)) return text(notFound, 404);
    const { data: lead } = await supabase.from("leads").select("email").eq("id", unsubscribeId).maybeSingle();
    if (!lead) return text(notFound, 404);
    const { error } = await supabase.from("leads").update({ unsubscribed_at: new Date().toISOString() })
      .eq("email", lead.email).is("unsubscribed_at", null);
    if (error) return text(notFound, 500);
    return text("You're unsubscribed. Hanging Weight Co. won't email you again.");
  }

  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  // Honeypot: the form's hidden "website" field is only ever filled by bots. Pretend it worked.
  if (String(body.website ?? "").trim()) return Response.json({ ok: true, emailed: true }, { status: 200, headers });

  const name = String(body.name ?? "").trim().slice(0, 80);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  const ranch = String(body.ranch ?? "").trim().slice(0, 200);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "Add your name and a real email address." }, { status: 400, headers });
  }
  // The name is the only free text that reaches the email, so keep links out of it.
  if (/https?:|www\.|[<>@/\\]|[a-z]\.[a-z]{2,}\b/i.test(name)) {
    return Response.json({ error: "Enter just your name, without links." }, { status: 400, headers });
  }

  const raw = (body.inputs ?? {}) as Record<string, unknown>;
  const inputs: Record<string, number> = {};
  for (const k of INPUT_KEYS) {
    const v = Number(raw[k] ?? 0);
    if (!Number.isFinite(v) || Math.abs(v) > 1e7) {
      return Response.json({ error: "Check the calculator numbers and try again." }, { status: 400, headers });
    }
    inputs[k] = v;
  }
  const custPays = raw.who !== "me";
  const built = priceSheet(inputs, custPays);
  if (!built) return Response.json({ error: "Check the calculator numbers and try again." }, { status: 400, headers });

  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const [{ count: sameAddress }, { count: lastHour }] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("email", email).gte("created_at", dayAgo),
    supabase.from("leads").select("id", { count: "exact", head: true }).gte("created_at", hourAgo),
  ]);

  const { data: lead, error } = await supabase.from("leads").insert({
    name, email, ranch, state,
    source: String(body.source ?? "calculator").slice(0, 40),
    page: String(body.page ?? "").slice(0, 300),
    inputs: { ...inputs, who: custPays ? "customer" : "me" },
    results: built.results,
    sheet_text: built.sheet,
  }).select("id").single();
  if (error || !lead) return Response.json({ error: "Could not save lead" }, { status: 500, headers });

  const address = (Deno.env.get("MAILING_ADDRESS") ?? "").trim();
  const sendgridKey = Deno.env.get("SENDGRID_API_KEY") ?? "";
  let skip = "";
  if (!address) skip = "MAILING_ADDRESS not set";
  else if (!sendgridKey) skip = "SENDGRID_API_KEY not set";
  else if ((sameAddress ?? 0) >= MAX_EMAILS_PER_ADDRESS_PER_DAY) skip = "per-address daily cap";
  else if ((lastHour ?? 0) >= MAX_EMAILS_PER_HOUR) skip = "hourly cap";
  if (skip) {
    console.error("Lead saved, email skipped:", skip, lead.id);
    return Response.json({ ok: true, emailed: false }, { status: 200, headers });
  }

  const unsubscribeUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/capture-lead?unsubscribe=${lead.id}`;
  const message = [
    `Hi ${name.split(" ")[0]},`,
    "",
    "Here's the price sheet you built on the Hanging Weight Co. calculator:",
    "",
    built.sheet,
    "",
    "Two things most ranchers miss: price from your real cost per head, and take a deposit when someone reserves a share.",
    "If you'd like a one-hour session to set your price and a plan to sell your next 5 beef, it's $197: https://hangingweightco.com/#session",
    "",
    "Allen",
    "Hanging Weight Co.",
    "",
    `Hanging Weight Co. · ${address}`,
    "You asked for this price sheet on hangingweightco.com.",
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  const sg = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${sendgridKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email, name }] }],
      from: { email: "info@hangingweightco.com", name: "Allen, Hanging Weight Co." },
      reply_to: { email: "info@hangingweightco.com" },
      subject: "Your beef price sheet",
      content: [{ type: "text/plain", value: message }],
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  if (!sg.ok) console.error("SendGrid error", sg.status, await sg.text());

  return Response.json({ ok: true, emailed: sg.ok }, { status: 200, headers });
});
