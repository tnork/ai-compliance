-- CI-ONLY shim: minimal Supabase auth surface on vanilla Postgres so the real
-- migrations replay from scratch in GitHub Actions (no Supabase project, no secrets).
-- NEVER run against a real Supabase project — these objects already exist there.
create schema if not exists auth;

create table if not exists auth.users (id uuid primary key);

-- Supabase resolves auth.uid() from the request JWT; in CI there is no JWT, so
-- mirror the same GUC-based lookup PostgREST uses (returns null when unset).
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
