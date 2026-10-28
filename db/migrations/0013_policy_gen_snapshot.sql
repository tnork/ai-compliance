-- ── Free-generator snapshot capture (funnel continuity) ─────────────────────
-- The public policy generator saves the visitor's FORM SELECTIONS (never client
-- data, never the rendered document) keyed to the email captured by the lead
-- modal. When self-serve signup exists, onboarding matches on lower(email) and
-- offers "import the policy you generated as your draft".
--
-- Public-capture pattern (same class as lead/contact_message): anon INSERT-only,
-- NO anon reads, no firm_id by design. Always insert with Prefer: return=minimal.
create table if not exists policy_gen_snapshot (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) <= 320 and position('@' in email) > 1),
  first_name text check (char_length(first_name) <= 100),
  last_name text check (char_length(last_name) <= 100),
  firm_name text check (char_length(firm_name) <= 200),
  inputs jsonb not null check (pg_column_size(inputs) <= 8192),  -- selections only; size-capped junk guard
  source text not null default 'policy_gen',
  imported_policy_id uuid references policy(id),  -- set server-side when a firm imports it
  created_at timestamptz not null default now()
);
comment on table policy_gen_snapshot is 'Public capture: anon INSERT-only, no reads via API roles; no firm_id by design (check-rls EXEMPT public-capture). Import matcher keys on lower(email), newest row wins.';
create index if not exists policy_gen_snapshot_email on policy_gen_snapshot (lower(email), created_at desc);

alter table policy_gen_snapshot enable row level security;
drop policy if exists policy_gen_snapshot_ins on policy_gen_snapshot;
create policy policy_gen_snapshot_ins on policy_gen_snapshot
  for insert to anon, authenticated with check (true);
-- no select/update/delete policies: reads and import-marking are service-role ops.
