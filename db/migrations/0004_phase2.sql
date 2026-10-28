-- AI Compliance — 0004: Phase 2 tables (attestation, tool_register, training_record, ai_account, lead).
-- MANDATORY: RLS on every table + firm-scoped policy. firm_id/user_id default from the caller's
-- session so a logged-in client can insert without knowing its own ids. Service key bypasses RLS.

-- ── ATTESTATION (staff acknowledged a policy version) ──────────────
create table if not exists attestation (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  user_id uuid not null default auth.uid() references app_user(id) on delete cascade,
  policy_id uuid not null references policy(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  ip inet, signature text,
  created_at timestamptz not null default now()
);
alter table attestation enable row level security;
create index if not exists attestation_firm_idx on attestation(firm_id, policy_id);

-- ── TOOL_REGISTER (approved AI tools + data handling) ──────────────
create table if not exists tool_register (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  tool_name text not null,
  provider text,
  approved_for_pii boolean not null default false,
  data_handling_notes text,
  status text not null default 'approved',        -- 'approved' | 'blocked' | 'under_review'
  approved_by uuid references app_user(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table tool_register enable row level security;
create index if not exists tool_register_firm_idx on tool_register(firm_id);

-- ── TRAINING_RECORD (competence evidence, §10.35) ──────────────────
create table if not exists training_record (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  user_id uuid not null references app_user(id) on delete cascade,
  course_name text not null,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table training_record enable row level security;
create index if not exists training_firm_idx on training_record(firm_id, user_id);

-- ── AI_ACCOUNT (attested AI accounts per user → watcher coverage) ──
create table if not exists ai_account (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  user_id uuid not null default auth.uid() references app_user(id) on delete cascade,
  provider text not null,                          -- 'openai'|'anthropic'|'google'|'xai'|'microsoft'|'local'|'other'
  tool text,                                       -- display label, e.g. 'ChatGPT','Ollama'
  account_type text not null default 'personal',   -- 'firm' | 'personal'
  is_local_llm boolean not null default false,
  label text,
  created_at timestamptz not null default now()
);
alter table ai_account enable row level security;
create index if not exists ai_account_firm_idx on ai_account(firm_id, user_id);

-- Firm-scoped policies for the four tenant tables
do $$
declare t text;
begin
  foreach t in array array['attestation','tool_register','training_record','ai_account'] loop
    execute format('drop policy if exists %I_sel on %I', t, t);
    execute format('drop policy if exists %I_ins on %I', t, t);
    execute format('drop policy if exists %I_upd on %I', t, t);
    execute format('drop policy if exists %I_del on %I', t, t);
    execute format('create policy %I_sel on %I for select using (firm_id = current_firm_id())', t, t);
    execute format('create policy %I_ins on %I for insert with check (firm_id = current_firm_id())', t, t);
    execute format('create policy %I_upd on %I for update using (firm_id = current_firm_id()) with check (firm_id = current_firm_id())', t, t);
    execute format('create policy %I_del on %I for delete using (firm_id = current_firm_id())', t, t);
  end loop;
end $$;

-- ── LEAD (marketing email capture; PRE-TENANT, no firm_id) ─────────
-- Exception to the firm_id rule: leads arrive from the public site before any tenant exists.
-- RLS on; anon may INSERT only (public form); no anon SELECT. Admin/service reads via secret key.
create table if not exists lead (
  id uuid primary key default gen_random_uuid(),
  email citext not null,
  firm_name text,
  source text,
  created_at timestamptz not null default now()
);
alter table lead enable row level security;
drop policy if exists lead_insert on lead;
create policy lead_insert on lead for insert to anon, authenticated with check (true);
-- (no select/update/delete policy → only the service role can read leads)
