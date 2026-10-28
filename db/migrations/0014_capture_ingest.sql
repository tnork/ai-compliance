-- ── Phase 5 capture: shared ingest foundation (extension + enterprise connector) ──
-- Both capture mechanisms funnel through ingest_ai_event(): a service-role RPC
-- that attributes an event to the RESOLVED AI user (not the caller), lands it
-- reviewed=false (captured usage is NOT yet human-supervised — it surfaces as a
-- §10.22 gap until reviewed), and hash-chains it into the firm chain exactly
-- like manual events. Idempotent on (firm_id, external_id) so repeated pulls /
-- retried syncs never double-insert.

-- new event sources for the two additional providers (source_t already had openai_api)
alter type source_t add value if not exists 'anthropic_api';
alter type source_t add value if not exists 'grok_api';

-- idempotency key: the provider/extension's stable id for the interaction
alter table ai_event add column if not exists external_id text;
create unique index if not exists ai_event_firm_external
  on ai_event(firm_id, external_id) where external_id is not null;

-- ── canonical v2, made fully null-safe (Codex-format contract, matches JS) ───
-- FIX: verification_notes + approval_signature are now coalesce('null')'d like
-- every other nullable field. Manual events always set them non-null so their
-- hashes are UNCHANGED; captured events leave them null and now hash
-- deterministically, matching web/lib/hashchain.ts JSON.stringify (which already
-- renders null as null). Key order and 3-ms UTC timestamps remain the contract.
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
    || ',"verification_notes":' || coalesce(to_json(p_verification_notes)::text, 'null')
    || ',"edited":'             || coalesce(to_json(p_edited)::text, 'null')
    || ',"verified_accurate":'  || coalesce(to_json(p_verified_accurate)::text, 'null')
    || ',"assumptions_ref":'    || coalesce(to_json(p_assumptions_ref)::text, 'null')
    || ',"reviewer_confirmed_assumptions":' || coalesce(to_json(p_reviewer_confirmed_assumptions)::text, 'null')
    || ',"approval_signature":' || coalesce(to_json(p_approval_signature)::text, 'null')
    || '}'
$$;

-- ── ingest_ai_event: the capture write path (service-role only) ──────────────
-- Attribution is the resolved AI user (p_user_id) after the caller validates it
-- belongs to p_firm_id — the service layer, not the DB session, is trusted here
-- (there is no auth.uid() in a background connector or a batch post). The firm
-- chain lock + server-side hash are identical to log_ai_event().
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
  v_occurred timestamptz := coalesce(p_occurred_at, now());
  v_prev text; v_hash text; v_event uuid; v_existing uuid;
  v_prompt_ref uuid; v_output_ref uuid;
begin
  if p_firm_id is null or p_user_id is null then raise exception 'firm and user required'; end if;
  if coalesce(trim(p_tool), '') = '' then raise exception 'tool is required'; end if;
  -- attribution guard: the AI user must belong to the target firm
  if not exists (select 1 from app_user where id = p_user_id and firm_id = p_firm_id) then
    raise exception 'user % is not a member of firm %', p_user_id, p_firm_id;
  end if;

  -- serialize per-firm appends (shared with log_ai_event) — no chain races
  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));

  -- idempotent: a repeated pull / retried sync of the same interaction is a no-op
  if p_external_id is not null then
    select id into v_existing from ai_event where firm_id = p_firm_id and external_id = p_external_id;
    if v_existing is not null then return v_existing; end if;
  end if;

  select record_hash into v_prev from ai_event
    where firm_id = p_firm_id order by created_at desc, id desc limit 1;

  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;

  -- captured = unreviewed: reviewer/verify/signature all null (surfaces as a gap)
  v_hash := encode(digest(
    ai_event_canonical_v2(
      p_firm_id, p_user_id, p_tool, p_model, p_source, v_occurred, p_data_kind,
      p_data_sensitivity::text, p_pii_included, p_client_ref, null,
      p_prompt_sha256, p_output_sha256, false, null, null,
      null, null, null, null, null, null
    ) || coalesce(v_prev, ''), 'sha256'), 'hex');

  insert into ai_event (
    firm_id, user_id, source, external_id, tool, model, client_ref, occurred_at,
    data_kind, data_sensitivity, pii_included, prompt_ref, output_ref,
    reviewed, prev_hash, record_hash
  ) values (
    p_firm_id, p_user_id, p_source::source_t, p_external_id, trim(p_tool), p_model, p_client_ref, v_occurred,
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

revoke all on function ingest_ai_event from public, anon, authenticated;
grant execute on function ingest_ai_event to service_role;

-- ── provider_connection: enterprise Compliance-API credentials (encrypted) ───
-- Secret is AES-256-GCM encrypted in the app (key in CONNECTOR_ENC_KEY env, never
-- in the DB) BEFORE insert; RLS firm-scoping is the tenant boundary on top. The
-- browser extension does NOT use this table (it auths as the logged-in user).
create table if not exists provider_connection (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id),
  provider text not null check (provider in ('openai','anthropic','grok')),
  scope_ref text,                       -- workspace/org id at the provider
  status text not null default 'connected',   -- connected | error | disabled
  secret_ciphertext text, secret_iv text, secret_tag text,  -- AES-256-GCM parts
  sync_cursor text,                     -- provider pagination cursor
  last_sync_at timestamptz, last_error text,
  connected_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  unique (firm_id, provider)
);
create index if not exists provider_connection_firm on provider_connection(firm_id);

alter table provider_connection enable row level security;
drop policy if exists provider_connection_sel on provider_connection;
drop policy if exists provider_connection_del on provider_connection;
-- firms see their own connection status; connecting/syncing is a service-role
-- server action (secret must be encrypted server-side first) so there is NO
-- client insert/update policy. Admins may disconnect.
create policy provider_connection_sel on provider_connection
  for select using (firm_id = current_firm_id());
create policy provider_connection_del on provider_connection
  for delete using (firm_id = current_firm_id() and current_user_role() = 'admin');
