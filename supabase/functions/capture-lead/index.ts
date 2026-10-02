// Supabase Edge Function: capture-lead (lane C)
// Stores a calculator lead and emails the rancher their price sheet through SendGrid.
// Secrets (set with `supabase secrets set`): SENDGRID_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// MAILING_ADDRESS (HerdDirect LLC / Hanging Weight Co. postal address for the email footer).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://hangingweightco.com", "https://www.hangingweightco.com"];
const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
});

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405, headers });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers }); }

  const name = String(body.name ?? "").trim().slice(0, 120);
  const email = String(body.email ?? "").trim().toLowerCase().slice(0, 200);
  const ranch = String(body.ranch ?? "").trim().slice(0, 200);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  const sheet = String(body.sheet_text ?? "").slice(0, 4000);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: "Name and a valid email are required" }, { status: 400, headers });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error } = await supabase.from("leads").insert({
    name, email, ranch, state,
    source: String(body.source ?? "calculator").slice(0, 40),
    page: String(body.page ?? "").slice(0, 300),
    inputs: body.inputs ?? null,
    results: body.results ?? null,
    sheet_text: sheet,
  });
  if (error) return Response.json({ error: "Could not save lead" }, { status: 500, headers });

  const address = Deno.env.get("MAILING_ADDRESS") ?? "";
  const text = [
    `Hi ${name.split(" ")[0]},`,
    "",
    "Here's the price sheet you built on the Hanging Weight Co. calculator:",
    "",
    sheet || "(The sheet text didn't come through. Reply to this email and we'll send it by hand.)",
    "",
    "Two things most ranchers miss: price from your real cost per head, and take a deposit when someone reserves a share.",
    "If you'd like a one-hour session to set your price and a plan to sell your next 5 beef, it's $197: https://hangingweightco.com/#session",
    "",
    "Allen",
    "Hanging Weight Co.",
    "",
    `Hanging Weight Co. · ${address}`,
    "You asked for this price sheet on hangingweightco.com. To stop future emails, reply with STOP.",
  ].join("\n");

  const sg = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { "Authorization": `Bearer ${Deno.env.get("SENDGRID_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email, name }] }],
      from: { email: "info@hangingweightco.com", name: "Allen, Hanging Weight Co." },
      reply_to: { email: "info@hangingweightco.com" },
      subject: "Your beef price sheet",
      content: [{ type: "text/plain", value: text }],
    }),
  });
  if (!sg.ok) console.error("SendGrid error", sg.status, await sg.text());

  return Response.json({ ok: true, emailed: sg.ok }, { status: 200, headers });
});
