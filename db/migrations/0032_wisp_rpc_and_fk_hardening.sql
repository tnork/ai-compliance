-- ── 0032: Codex-review hardening for 0030/0031 ───────────────────────────────
-- Review of the WISP + versioned-attestation work (2026-07-12) found:
--
-- P2: wisp_attestation was direct-INSERTable via PostgREST with only tenant +
--     self checks - a member could mint immutable "I read the WISP" evidence
--     while the adopted policy declares NO WISP exists (or with no adopted
--     policy at all); the state check lived only in the server action. Fix:
--     drop the INSERT policy; attest_wisp() RPC validates the adopted policy's
--     has_wisp inside the DB (same evidence posture as acknowledge_policy).
--
-- P3: attestation's version FK was ON DELETE CASCADE - deleting a single
--     policy_version row (service-role maintenance, future feature) would
--     silently erase the acknowledgements logged against it. Fix: plain
--     NO ACTION. Whole-policy deletes still cascade fine: the policy FK
--     cascade removes attestations AND versions in the same statement, and
--     NO ACTION is checked at end of statement when both sides are gone -
--     but a lone policy_version delete is now blocked while acknowledgement
--     evidence references it.

-- ── P2: WISP acknowledgement becomes RPC-only ────────────────────────────────
drop policy if exists wisp_attestation_ins on wisp_attestation;

create or replace function attest_wisp()
returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_has text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;

  -- The newest adopted policy must declare a WISP is in place (missing key =
  -- 'yes', matching createPolicy's default). Without that declaration there is
  -- nothing to acknowledge - reject rather than record inapplicable evidence.
  select coalesce(inputs->>'has_wisp', 'yes') into v_has
    from policy where firm_id = v_firm and status = 'adopted'
    order by created_at desc limit 1;
  if v_has is null then raise exception 'no adopted policy declares a WISP'; end if;
  if v_has = 'no' then raise exception 'the adopted policy declares no WISP is in place yet'; end if;

  -- one row per member per firm; repeats no-op on the unique
  insert into wisp_attestation (firm_id, user_id) values (v_firm, v_uid)
  on conflict (firm_id, user_id) do nothing;
end $$;
-- 0027 lesson: revoke from anon AND public (Supabase default-privileges grant
-- EXECUTE directly to anon), then grant back what's intended.
revoke all on function attest_wisp() from anon, public;
grant execute on function attest_wisp() to authenticated, service_role;

-- ── P3: acknowledgements must not vanish with a single version row ──────────
alter table attestation drop constraint if exists attestation_version_fk;
alter table attestation add constraint attestation_version_fk
  foreign key (policy_id, policy_version_no)
  references policy_version(policy_id, version);
