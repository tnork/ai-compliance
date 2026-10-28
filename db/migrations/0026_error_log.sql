-- 0026: error_log — durable capture of swallowed/silent errors for the in-app
-- Developers view. Server-side catches that would otherwise fail quietly
-- (connector status writes, storage deletion, role-metadata sync, etc.) record
-- here so a compliance logger fails VISIBLY and errors survive across sessions.
-- Intended to become a production-wide error sink.
--
-- ACCESS: developer-only (NOT all admins) — gated on app_user.is_developer, which
-- is seeded true ONLY for dev@example.com. Firm-scoped for RLS (server errors carry
-- firm context); inserts are service-role only (the logError() helper uses the
-- admin client) so a client can neither forge errors nor read another firm's.

-- developer flag (default false); a per-account grant, not a role.
alter table app_user add column if not exists is_developer boolean not null default false;

-- SECURITY DEFINER helper: is the calling user a developer? (mirrors current_user_role)
create or replace function current_user_is_developer() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_developer from app_user where id = auth.uid()), false)
$$;
revoke all on function current_user_is_developer() from public;
grant execute on function current_user_is_developer() to authenticated;

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references firm(id),
  source text not null,                    -- 'connector' | 'ingest' | 'storage' | 'staff' | 'web' | ...
  severity text not null default 'error',  -- 'error' | 'warn'
  message text not null,
  context jsonb,                           -- structured details (ids, provider…) — never secrets/raw content
  stack text,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  constraint error_log_severity_chk check (severity in ('error', 'warn')),
  constraint error_log_message_len check (char_length(message) <= 4000)
);
create index if not exists error_log_firm_unresolved on error_log(firm_id, resolved, created_at desc);

alter table error_log enable row level security;

-- ONLY the developer (dev@example.com) reads + resolves errors. No API-role INSERT
-- policy => only the service role writes (fail closed, like ai_event).
create policy error_log_sel on error_log for select
  using (firm_id = current_firm_id() and current_user_is_developer());
create policy error_log_upd on error_log for update
  using (firm_id = current_firm_id() and current_user_is_developer())
  with check (firm_id = current_firm_id() and current_user_is_developer());

-- Seed the developer grant. Replace dev@example.com with your developer login, or grant it later
-- with: update app_user set is_developer = true where email = '<you>'; (no-op where absent).
update app_user set is_developer = true
  where id in (select id from auth.users where email = 'dev@example.com');
