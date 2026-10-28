-- AI Compliance — 0001_init: foundation schema (firm, app_user, policy)
-- MANDATORY: every public table has RLS enabled + a firm-scoped tenant policy.
-- Tenant isolation resolves the caller's firm via their auth.uid() (standard Supabase pattern).
-- The service (secret) key bypasses RLS for server-side jobs; the anon/publishable key + a
-- logged-in user are subject to these policies.

create extension if not exists citext;

-- ── FIRM (tenant root) ─────────────────────────────────────────────
create table if not exists firm (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  profession text not null default 'tax',
  created_at timestamptz not null default now()
);
alter table firm enable row level security;

-- ── APP_USER (application user; 1:1 with auth.users) ───────────────
create table if not exists app_user (
  id uuid primary key references auth.users(id) on delete cascade,
  firm_id uuid not null references firm(id) on delete cascade,
  username text unique,
  email citext,
  role text not null default 'reviewer',   -- 'admin' | 'reviewer' | 'staff'
  created_at timestamptz not null default now()
);
alter table app_user enable row level security;
create index if not exists app_user_firm_idx on app_user(firm_id);

-- Resolve the caller's firm from their auth uid. SECURITY DEFINER so the lookup
-- itself isn't blocked by app_user's RLS (avoids recursion).
create or replace function current_firm_id() returns uuid
  language sql stable security definer set search_path = public as $$
  select firm_id from app_user where id = auth.uid()
$$;

-- ── POLICY (generated AI-use policy: input selections + draft) ─────
create table if not exists policy (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firm(id) on delete cascade,
  created_by uuid references app_user(id),
  title text,
  inputs jsonb not null default '{}'::jsonb,  -- form selections: firm, size, tools, byo stance, pii, wisp, effective date
  draft_html text,                            -- the generated policy draft
  version int not null default 1,
  status text not null default 'draft',       -- 'draft' | 'adopted' | 'in_review'
  created_at timestamptz not null default now()
);
alter table policy enable row level security;
create index if not exists policy_firm_idx on policy(firm_id, created_at desc);

-- ── RLS policies (firm-scoped tenant isolation) ────────────────────
drop policy if exists firm_self on firm;
create policy firm_self on firm for select using (id = current_firm_id());

drop policy if exists app_user_tenant on app_user;
create policy app_user_tenant on app_user for select using (firm_id = current_firm_id());

drop policy if exists policy_sel on policy;
drop policy if exists policy_ins on policy;
drop policy if exists policy_upd on policy;
drop policy if exists policy_del on policy;
create policy policy_sel on policy for select using (firm_id = current_firm_id());
create policy policy_ins on policy for insert with check (firm_id = current_firm_id());
create policy policy_upd on policy for update using (firm_id = current_firm_id()) with check (firm_id = current_firm_id());
create policy policy_del on policy for delete using (firm_id = current_firm_id());

-- ── Seed: the first firm. Link your first admin to it after creating the auth user
-- (see README "Bootstrap the first admin"). There is no public sign-up; admins invite staff.
insert into firm (name, profession)
select 'Admin firm', 'tax'
where not exists (select 1 from firm where name = 'Admin firm');
