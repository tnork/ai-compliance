-- ── Chain integrity hardening (Codex review 2026-07-08, 4×P1 + 2×P2) ────────
-- Root cause of the P1s: the CLIENT computed prev_hash/record_hash and attribution.
-- Fix: appends go ONLY through log_ai_event() — a SECURITY DEFINER function that
-- forces user_id/reviewer_id = auth.uid(), locks the firm's chain, computes the
-- canonical v2 hash server-side, and writes event + artifacts atomically.
-- Direct INSERT policies on ai_event/artifact are dropped (fail closed).

create extension if not exists pgcrypto;

-- P2: composite FK so an artifact can never reference another firm's event
alter table ai_event  add constraint ai_event_id_firm_uniq unique (id, firm_id);
alter table artifact  drop constraint if exists artifact_ai_event_id_fkey;
alter table artifact  add constraint artifact_event_same_firm_fkey
  foreign key (ai_event_id, firm_id) references ai_event (id, firm_id);

-- P1: no more direct API inserts — the RPC is the only write path
drop policy if exists ai_event_ins on ai_event;
drop policy if exists artifact_ins on artifact;

-- Canonical JSON v2 (hash covers ALL evidentiary fields — Codex P1: notes,
-- client/matter refs, sensitivity, PII, edited, assumptions, source, review
-- state; supersedes Appendix B.3's narrower list).
-- FORMAT CONTRACT: byte-for-byte identical to JS JSON.stringify of the same
-- object with these keys in this order; timestamps are UTC ISO-8601 with
-- exactly 3 ms digits ("Z" suffix), matching Date.prototype.toISOString().
-- web/lib/hashchain.ts mirrors this for verification. NEVER reorder keys.
create or replace function ai_event_canonical_v2(
  p_firm_id uuid, p_user_id uuid, p_tool text, p_model text, p_source text,
  p_occurred_at timestamptz, p_data_kind text, p_data_sensitivity text,
  p_pii_included boolean, p_client_ref text, p_matter_ref text,
  p_prompt_sha256 text, p_output_sha256 text,
  p_reviewed boolean, p_reviewer_id uuid, p_reviewed_at timestamptz,
  p_verification_notes text, p_edited boolean, p_verified_accurate boolean,
  p_assumptions_ref text, p_reviewer_confirmed_assumptions boolean,
  p_approval_signature text
) returns text
  language sql immutable as $$
  select '{"v":2'
    || ',"firm_id":'  || to_json(p_firm_id::text)::text
    || ',"user_id":'  || to_json(p_user_id::text)::text
    || ',"tool":'     || to_json(p_tool)::text
    || ',"model":'    || coalesce(to_json(p_model)::text, 'null')
    || ',"source":'   || to_json(p_source)::text
    || ',"occurred_at":' || to_json(to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"data_kind":'        || coalesce(to_json(p_data_kind)::text, 'null')
    || ',"data_sensitivity":' || to_json(p_data_sensitivity)::text
    || ',"pii_included":'     || to_json(p_pii_included)::text
    || ',"client_ref":'       || coalesce(to_json(p_client_ref)::text, 'null')
    || ',"matter_ref":'       || coalesce(to_json(p_matter_ref)::text, 'null')
    || ',"prompt_sha256":'    || coalesce(to_json(p_prompt_sha256)::text, 'null')
    || ',"output_sha256":'    || coalesce(to_json(p_output_sha256)::text, 'null')
    || ',"reviewed":'         || to_json(p_reviewed)::text
    || ',"reviewer_id":'      || coalesce(to_json(p_reviewer_id::text)::text, 'null')
    || ',"reviewed_at":'      || coalesce(to_json(to_char(p_reviewed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text, 'null')
    || ',"verification_notes":' || to_json(p_verification_notes)::text
    || ',"edited":'             || coalesce(to_json(p_edited)::text, 'null')
    || ',"verified_accurate":'  || coalesce(to_json(p_verified_accurate)::text, 'null')
    || ',"assumptions_ref":'    || coalesce(to_json(p_assumptions_ref)::text, 'null')
    || ',"reviewer_confirmed_assumptions":' || coalesce(to_json(p_reviewer_confirmed_assumptions)::text, 'null')
    || ',"approval_signature":' || to_json(p_approval_signature)::text
    || '}'
$$;

-- The ONLY append path. SECURITY DEFINER (owner bypasses RLS internally) with
-- its own auth: caller must be an app_user; attribution is FORCED to the
-- caller — user_id, reviewer_id, and firm all derive from auth.uid(), so a
-- record can never impersonate a colleague or another firm.
create or replace function log_ai_event(
  p_tool text, p_model text default null,
  p_client_ref text default null, p_matter_ref text default null,
  p_occurred_at timestamptz default null, p_data_kind text default null,
  p_data_sensitivity sens_t default 'none', p_pii_included boolean default false,
  p_prompt_sha256 text default null, p_prompt_bytes bigint default null,
  p_output_sha256 text default null, p_output_bytes bigint default null,
  p_verification_notes text default null, p_edited boolean default null,
  p_verified_accurate boolean default null, p_assumptions_ref text default null,
  p_reviewer_confirmed_assumptions boolean default null,
  p_approval_signature text default null
) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid;
  v_occurred timestamptz := coalesce(p_occurred_at, now());
  v_reviewed_at timestamptz := now();
  v_prev text; v_hash text; v_event uuid;
  v_prompt_ref uuid; v_output_ref uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if coalesce(trim(p_tool), '') = '' then raise exception 'tool is required'; end if;
  if coalesce(trim(p_verification_notes), '') = '' then raise exception 'verification notes are required'; end if;
  if coalesce(trim(p_approval_signature), '') = '' then raise exception 'approval signature is required'; end if;

  -- serialize appends per firm: no chain races, no forks (belt: unique indexes)
  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || v_firm::text, 0));

  select record_hash into v_prev from ai_event
    where firm_id = v_firm order by created_at desc, id desc limit 1;

  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;

  v_hash := encode(digest(
    ai_event_canonical_v2(
      v_firm, v_uid, p_tool, p_model, 'manual', v_occurred, p_data_kind,
      p_data_sensitivity::text, p_pii_included, p_client_ref, p_matter_ref,
      p_prompt_sha256, p_output_sha256, true, v_uid, v_reviewed_at,
      p_verification_notes, p_edited, p_verified_accurate, p_assumptions_ref,
      p_reviewer_confirmed_assumptions, p_approval_signature
    ) || coalesce(v_prev, ''), 'sha256'), 'hex');

  insert into ai_event (
    firm_id, user_id, source, tool, model, client_ref, matter_ref, occurred_at,
    data_kind, data_sensitivity, pii_included, prompt_ref, output_ref,
    reviewed, reviewer_id, reviewed_at, verification_notes, edited,
    verified_accurate, assumptions_ref, reviewer_confirmed_assumptions,
    approval_signature, prev_hash, record_hash
  ) values (
    v_firm, v_uid, 'manual', trim(p_tool), p_model, p_client_ref, p_matter_ref, v_occurred,
    p_data_kind, p_data_sensitivity, p_pii_included, v_prompt_ref, v_output_ref,
    true, v_uid, v_reviewed_at, p_verification_notes, p_edited,
    p_verified_accurate, p_assumptions_ref, p_reviewer_confirmed_assumptions,
    p_approval_signature, v_prev, v_hash
  ) returning id into v_event;

  -- artifacts land in the SAME transaction: no orphaned evidence (Codex P1)
  if v_prompt_ref is not null then
    insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
    values (v_prompt_ref, v_firm, v_event, 'prompt', p_prompt_sha256, p_prompt_bytes);
  end if;
  if v_output_ref is not null then
    insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
    values (v_output_ref, v_firm, v_event, 'output', p_output_sha256, p_output_bytes);
  end if;

  return v_event;
end $$;

revoke all on function log_ai_event from public, anon;
grant execute on function log_ai_event to authenticated;
revoke all on function ai_event_canonical_v2 from public, anon;
grant execute on function ai_event_canonical_v2 to authenticated;  -- verifiers may recompute
