-- Leads captured on the Hanging Weight Co. calculator (lane C).
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  email text not null,
  ranch text,
  state text,
  source text not null default 'calculator',
  page text,
  inputs jsonb,
  results jsonb,
  sheet_text text,
  unsubscribed_at timestamptz,
  nurture_step int not null default 0
);
create index if not exists leads_email_idx on public.leads (lower(email));
alter table public.leads enable row level security;
-- No public policies: only the service role (used by the capture-lead function and the agents) can read or write.
