-- ── 0031: version-aware policy attestations (append-only log) ────────────────
-- Founder requirement (2026-07-12): attestations are a LOG, never overwritten.
-- Each acknowledgement records WHICH policy version the member read, so the
-- report can show "all staff attested to v1 (current from date X to date Y),
-- then v2, ..." - multiple cycles per year. Saving an edit to the adopted
-- policy bumps the head version (0022), which now automatically re-opens the
-- attestation cycle: the app keys "acknowledged" to the HEAD version, so every
-- member (admins included) is prompted again after any saved change. Who
-- changed what & when is already captured per version by policy_version
-- (edited_by / created_at / full body snapshot).
--
-- Three changes:
--   1. attestation.policy_version_no + FK to policy_version, backfilled for
--      existing rows to the version that was current at acknowledged_at.
--   2. acknowledge_policy() RPC becomes the ONLY write path (attribution forced
--      to auth.uid(); head-version check under the same advisory lock as
--      save_policy_version so the head can't move mid-acknowledge; repeats of
--      the same version no-op). Direct INSERT policy dropped.
--   3. attestation UPDATE/DELETE policies dropped (0004's generic loop had
--      granted them firm-wide - any member could rewrite acknowledgement
--      evidence; an attestation log must be immutable, same posture as
--      ai_event / policy_version / wisp_attestation).

alter table attestation add column if not exists policy_version_no int;

comment on column attestation.policy_version_no is
  'The policy_version the member acknowledged. New acknowledgements always target the head version (enforced by acknowledge_policy()); a saved edit bumps the head and re-opens the cycle. Null only possible on legacy rows whose policy has no version history.';

-- version must exist for that policy (policy_id is already composite-FK'd to
-- policy(id, firm_id), so tenant consistency is covered). Cascade: versions
-- only disappear when the whole policy cascades, taking attestations with it.
alter table attestation drop constraint if exists attestation_version_fk;
alter table attestation add constraint attestation_version_fk
  foreign key (policy_id, policy_version_no)
  references policy_version(policy_id, version) on delete cascade;

-- Backfill: attribute each existing acknowledgement to the version that was
-- current when it was made (max version created at-or-before acknowledged_at;
-- 0022 backfilled v1 with the policy's created_at, so this resolves for any
-- attestation made after policy creation). Older-than-v1 edge → earliest version.
update attestation a
   set policy_version_no = (
     select max(pv.version) from policy_version pv
      where pv.policy_id = a.policy_id and pv.created_at <= a.acknowledged_at)
 where a.policy_version_no is null
   and exists (select 1 from policy_version pv
                where pv.policy_id = a.policy_id and pv.created_at <= a.acknowledged_at);
update attestation a
   set policy_version_no = (select min(pv.version) from policy_version pv where pv.policy_id = a.policy_id)
 where a.policy_version_no is null
   and exists (select 1 from policy_version pv where pv.policy_id = a.policy_id);

create index if not exists attestation_version_idx on attestation(policy_id, policy_version_no);

-- ── immutability: acknowledgements append via the RPC only ───────────────────
drop policy if exists attestation_ins on attestation;
drop policy if exists attestation_upd on attestation;
drop policy if exists attestation_del on attestation;

create or replace function acknowledge_policy(p_policy_id uuid, p_version int)
returns int
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_status text; v_head int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;

  -- same lock key as save_policy_version: the head cannot bump between the
  -- version check and the insert, so an acknowledgement can never silently
  -- attach to a version the member did not read.
  perform pg_advisory_xact_lock(hashtextextended('policy_version:' || p_policy_id::text, 0));

  select status, version into v_status, v_head
    from policy where id = p_policy_id and firm_id = v_firm;
  if not found then raise exception 'policy not found in your firm'; end if;
  if v_status <> 'adopted' then raise exception 'only an adopted policy can be acknowledged'; end if;
  if p_version is distinct from v_head then raise exception 'stale_version'; end if;

  -- append-only log: acknowledging the same version twice is a no-op, and a
  -- new version is a NEW row - prior acknowledgements are never touched.
  if exists (select 1 from attestation
              where policy_id = p_policy_id and user_id = v_uid and policy_version_no = v_head) then
    return v_head;
  end if;

  insert into attestation (firm_id, user_id, policy_id, policy_version_no)
  values (v_firm, v_uid, p_policy_id, v_head);
  return v_head;
end $$;
-- 0027 lesson: Supabase default-privileges grant EXECUTE directly to anon -
-- always revoke from anon AND public, then grant back what's intended.
revoke all on function acknowledge_policy(uuid, int) from anon, public;
grant execute on function acknowledge_policy(uuid, int) to authenticated, service_role;
