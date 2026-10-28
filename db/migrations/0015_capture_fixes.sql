-- ── Capture hardening (Codex review of 0014, 2026-07-08) ────────────────────
-- P1: both log_ai_event and ingest_ai_event hashed p_tool verbatim but stored
-- trim(p_tool) — an untrimmed tool would produce a record_hash that can't
-- recompute from the stored row (chain-verification false failure). Trim ONCE
-- and use the trimmed value for both hash and insert. (No live break today: the
-- manual form pre-trims; this closes the latent path for captured events.)
-- P2: firm members could SELECT the encrypted provider credential columns
-- directly. Even AES-GCM-with-env-key ciphertext shouldn't be exposed — restrict
-- to non-secret columns via column-level grants (RLS row-scoping stays on top).

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
  v_tool text := trim(p_tool);
  v_occurred timestamptz := coalesce(p_occurred_at, now());
  v_reviewed_at timestamptz := now();
  v_prev text; v_hash text; v_event uuid;
  v_prompt_ref uuid; v_output_ref uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if coalesce(v_tool, '') = '' then raise exception 'tool is required'; end if;
  if coalesce(trim(p_verification_notes), '') = '' then raise exception 'verification notes are required'; end if;
  if coalesce(trim(p_approval_signature), '') = '' then raise exception 'approval signature is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || v_firm::text, 0));
  select record_hash into v_prev from ai_event where firm_id = v_firm order by created_at desc, id desc limit 1;
  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;

  v_hash := encode(digest(
    ai_event_canonical_v2(
      v_firm, v_uid, v_tool, p_model, 'manual', v_occurred, p_data_kind,
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
    v_firm, v_uid, 'manual', v_tool, p_model, p_client_ref, p_matter_ref, v_occurred,
    p_data_kind, p_data_sensitivity, p_pii_included, v_prompt_ref, v_output_ref,
    true, v_uid, v_reviewed_at, p_verification_notes, p_edited,
    p_verified_accurate, p_assumptions_ref, p_reviewer_confirmed_assumptions,
    p_approval_signature, v_prev, v_hash
  ) returning id into v_event;

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

create or replace function ingest_ai_event(
  p_firm_id uuid, p_user_id uuid, p_source text, p_external_id text,
  p_tool text, p_model text default null, p_occurred_at timestamptz default null,
  p_client_ref text default null, p_data_kind text default null,
  p_data_sensitivity sens_t default 'none', p_pii_included boolean default false,
  p_prompt_sha256 text default null, p_prompt_bytes bigint default null,
  p_output_sha256 text default null, p_output_bytes bigint default null
) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_tool text := trim(p_tool);
  v_occurred timestamptz := coalesce(p_occurred_at, now());
  v_prev text; v_hash text; v_event uuid; v_existing uuid;
  v_prompt_ref uuid; v_output_ref uuid;
begin
  if p_firm_id is null or p_user_id is null then raise exception 'firm and user required'; end if;
  if coalesce(v_tool, '') = '' then raise exception 'tool is required'; end if;
  if not exists (select 1 from app_user where id = p_user_id and firm_id = p_firm_id) then
    raise exception 'user % is not a member of firm %', p_user_id, p_firm_id;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));
  if p_external_id is not null then
    select id into v_existing from ai_event where firm_id = p_firm_id and external_id = p_external_id;
    if v_existing is not null then return v_existing; end if;
  end if;
  select record_hash into v_prev from ai_event where firm_id = p_firm_id order by created_at desc, id desc limit 1;
  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;

  v_hash := encode(digest(
    ai_event_canonical_v2(
      p_firm_id, p_user_id, v_tool, p_model, p_source, v_occurred, p_data_kind,
      p_data_sensitivity::text, p_pii_included, p_client_ref, null,
      p_prompt_sha256, p_output_sha256, false, null, null,
      null, null, null, null, null, null
    ) || coalesce(v_prev, ''), 'sha256'), 'hex');

  insert into ai_event (
    firm_id, user_id, source, external_id, tool, model, client_ref, occurred_at,
    data_kind, data_sensitivity, pii_included, prompt_ref, output_ref,
    reviewed, prev_hash, record_hash
  ) values (
    p_firm_id, p_user_id, p_source::source_t, p_external_id, v_tool, p_model, p_client_ref, v_occurred,
    p_data_kind, p_data_sensitivity, p_pii_included, v_prompt_ref, v_output_ref,
    false, v_prev, v_hash
  ) returning id into v_event;

  if v_prompt_ref is not null then
    insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
    values (v_prompt_ref, p_firm_id, v_event, 'prompt', p_prompt_sha256, p_prompt_bytes);
  end if;
  if v_output_ref is not null then
    insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
    values (v_output_ref, p_firm_id, v_event, 'output', p_output_sha256, p_output_bytes);
  end if;
  return v_event;
end $$;

-- Column-level lockdown: firm members may read connection STATUS but never the
-- encrypted secret columns (defense-in-depth over the env-key encryption).
revoke select on provider_connection from anon, authenticated;
grant select (id, firm_id, provider, scope_ref, status, last_sync_at, last_error, connected_by, created_at)
  on provider_connection to authenticated;
