-- ── Codex review of 0016/0017 — chain-head correctness + review binding ─────
-- P1a: the chain-head read `order by created_at desc, id desc limit 1` is WRONG
--   after a batch — batch rows share now() (txn-stable), so id (random uuid)
--   decides the "tail", picking an interior row. The next append then chains off
--   a non-tip and violates the chain-link unique index. FIX: read the true tip =
--   the record whose record_hash no other row references (as generate_defense_packet
--   already does). Under the per-firm lock the chain is linear → exactly one tip.
-- P1b: review_captured_event's already-reviewed check ran BEFORE the lock (TOCTOU
--   double-review). FIX: recheck after the lock + a partial UNIQUE index.
-- P1c: reviews_event_id was inserted but NOT in the record hash, so the
--   evidentiary link wasn't tamper-covered. FIX: canonical v3 binds it (null for
--   non-review events); all writers + the JS mirror move to v3.
-- P2: review_captured_event now whitelists captured sources (rejects manual);
--   composite FK (reviews_event_id, firm_id)→(id, firm_id) enforces tenant match.

-- one review per captured event, race-proof (belt to the post-lock recheck)
create unique index if not exists ai_event_one_review_per_capture
  on ai_event(firm_id, reviews_event_id) where reviews_event_id is not null;

-- tenant-consistent review link (ai_event already has unique (id, firm_id))
alter table ai_event drop constraint if exists ai_event_reviews_event_id_fkey;
alter table ai_event add constraint ai_event_review_same_firm_fkey
  foreign key (reviews_event_id, firm_id) references ai_event (id, firm_id);

-- ── canonical v3: v2 + reviews_event_id (the only added field) ───────────────
-- Byte-identical to JS JSON.stringify with keys in THIS order; reviews_event_id
-- is the last key, null for every non-review event. web/lib/hashchain.ts mirrors.
create or replace function ai_event_canonical_v3(
  p_firm_id uuid, p_user_id uuid, p_tool text, p_model text, p_source text,
  p_occurred_at timestamptz, p_data_kind text, p_data_sensitivity text,
  p_pii_included boolean, p_client_ref text, p_matter_ref text,
  p_prompt_sha256 text, p_output_sha256 text,
  p_reviewed boolean, p_reviewer_id uuid, p_reviewed_at timestamptz,
  p_verification_notes text, p_edited boolean, p_verified_accurate boolean,
  p_assumptions_ref text, p_reviewer_confirmed_assumptions boolean,
  p_approval_signature text, p_reviews_event_id uuid
) returns text
  language sql immutable as $$
  select '{"v":3'
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
    || ',"reviews_event_id":'   || coalesce(to_json(p_reviews_event_id::text)::text, 'null')
    || '}'
$$;

-- helper: the current chain tip for a firm (the unreferenced record_hash)
create or replace function ai_event_chain_head(p_firm_id uuid) returns text
  language sql stable set search_path = public as $$
  select e.record_hash from ai_event e
   where e.firm_id = p_firm_id
     and not exists (select 1 from ai_event x where x.firm_id = p_firm_id and x.prev_hash = e.record_hash)
$$;

-- ── redefine all three writers: v3 canonical + correct tail read ────────────
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
  v_uid uuid := auth.uid(); v_firm uuid; v_tool text := trim(p_tool);
  v_occurred timestamptz := coalesce(p_occurred_at, now()); v_reviewed_at timestamptz := now();
  v_prev text; v_hash text; v_event uuid; v_prompt_ref uuid; v_output_ref uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if coalesce(v_tool, '') = '' then raise exception 'tool is required'; end if;
  if coalesce(trim(p_verification_notes), '') = '' then raise exception 'verification notes are required'; end if;
  if coalesce(trim(p_approval_signature), '') = '' then raise exception 'approval signature is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || v_firm::text, 0));
  v_prev := ai_event_chain_head(v_firm);
  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;

  v_hash := encode(digest(
    ai_event_canonical_v3(
      v_firm, v_uid, v_tool, p_model, 'manual', v_occurred, p_data_kind,
      p_data_sensitivity::text, p_pii_included, p_client_ref, p_matter_ref,
      p_prompt_sha256, p_output_sha256, true, v_uid, v_reviewed_at,
      p_verification_notes, p_edited, p_verified_accurate, p_assumptions_ref,
      p_reviewer_confirmed_assumptions, p_approval_signature, null
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
  if v_prompt_ref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_prompt_ref, v_firm, v_event, 'prompt', p_prompt_sha256, p_prompt_bytes); end if;
  if v_output_ref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_output_ref, v_firm, v_event, 'output', p_output_sha256, p_output_bytes); end if;
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
  v_tool text := trim(p_tool); v_occurred timestamptz := coalesce(p_occurred_at, now());
  v_prev text; v_hash text; v_event uuid; v_existing uuid; v_prompt_ref uuid; v_output_ref uuid;
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
  v_prev := ai_event_chain_head(p_firm_id);
  if p_prompt_sha256 is not null then v_prompt_ref := gen_random_uuid(); end if;
  if p_output_sha256 is not null then v_output_ref := gen_random_uuid(); end if;
  v_hash := encode(digest(
    ai_event_canonical_v3(
      p_firm_id, p_user_id, v_tool, p_model, p_source, v_occurred, p_data_kind,
      p_data_sensitivity::text, p_pii_included, p_client_ref, null,
      p_prompt_sha256, p_output_sha256, false, null, null,
      null, null, null, null, null, null, null
    ) || coalesce(v_prev, ''), 'sha256'), 'hex');
  insert into ai_event (
    firm_id, user_id, source, external_id, tool, model, client_ref, occurred_at,
    data_kind, data_sensitivity, pii_included, prompt_ref, output_ref, reviewed, prev_hash, record_hash
  ) values (
    p_firm_id, p_user_id, p_source::source_t, p_external_id, v_tool, p_model, p_client_ref, v_occurred,
    p_data_kind, p_data_sensitivity, p_pii_included, v_prompt_ref, v_output_ref, false, v_prev, v_hash
  ) returning id into v_event;
  if v_prompt_ref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_prompt_ref, p_firm_id, v_event, 'prompt', p_prompt_sha256, p_prompt_bytes); end if;
  if v_output_ref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_output_ref, p_firm_id, v_event, 'output', p_output_sha256, p_output_bytes); end if;
  return v_event;
end $$;

create or replace function ingest_ai_events_batch(p_firm_id uuid, p_source text, p_events jsonb)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_users uuid[]; v_prev text; v_result jsonb := '[]'::jsonb; v_seen text[] := array[]::text[];
  v_existing text[]; ev jsonb; v_uid uuid; v_ext text; v_tool text; v_hash text; v_event uuid;
  v_occurred timestamptz; v_psha text; v_osha text; v_pref uuid; v_oref uuid;
begin
  if p_firm_id is null then raise exception 'firm required'; end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events must be a json array'; end if;
  select array_agg(id) into v_users from app_user where firm_id = p_firm_id;
  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));
  select array_agg(external_id) into v_existing from ai_event
   where firm_id = p_firm_id
     and external_id = any (select jsonb_array_elements_text(jsonb_path_query_array(p_events, '$[*].external_id')));
  v_prev := ai_event_chain_head(p_firm_id);   -- correct tip, not created_at order

  for ev in select * from jsonb_array_elements(p_events) loop
    v_ext := ev->>'external_id'; v_uid := (ev->>'user_id')::uuid; v_tool := trim(ev->>'tool');
    if v_ext is not null and (v_ext = any(coalesce(v_existing,'{}')) or v_ext = any(v_seen)) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'duplicate'); continue; end if;
    if v_uid is null or not (v_uid = any(coalesce(v_users,'{}'))) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'error', 'reason', 'user not in firm'); continue; end if;
    if coalesce(v_tool,'') = '' then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'error', 'reason', 'tool required'); continue; end if;
    v_occurred := coalesce((ev->>'occurred_at')::timestamptz, now());
    v_psha := ev->>'prompt_sha256'; v_osha := ev->>'output_sha256';
    v_pref := case when v_psha is not null then gen_random_uuid() end;
    v_oref := case when v_osha is not null then gen_random_uuid() end;
    v_hash := encode(digest(
      ai_event_canonical_v3(
        p_firm_id, v_uid, v_tool, ev->>'model', p_source, v_occurred, ev->>'data_kind',
        coalesce(ev->>'data_sensitivity','none'), coalesce((ev->>'pii_included')::boolean,false),
        ev->>'client_ref', null, v_psha, v_osha, false, null, null,
        null, null, null, null, null, null, null
      ) || coalesce(v_prev, ''), 'sha256'), 'hex');
    insert into ai_event (
      firm_id, user_id, source, external_id, tool, model, client_ref, occurred_at,
      data_kind, data_sensitivity, pii_included, prompt_ref, output_ref, reviewed, prev_hash, record_hash
    ) values (
      p_firm_id, v_uid, p_source::source_t, v_ext, v_tool, ev->>'model', ev->>'client_ref', v_occurred,
      ev->>'data_kind', coalesce(ev->>'data_sensitivity','none')::sens_t, coalesce((ev->>'pii_included')::boolean,false),
      v_pref, v_oref, false, v_prev, v_hash
    ) returning id into v_event;
    if v_pref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_pref, p_firm_id, v_event, 'prompt', v_psha, (ev->>'prompt_bytes')::bigint); end if;
    if v_oref is not null then insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size) values (v_oref, p_firm_id, v_event, 'output', v_osha, (ev->>'output_bytes')::bigint); end if;
    v_prev := v_hash;
    if v_ext is not null then v_seen := v_seen || v_ext; end if;
    v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'inserted');
  end loop;
  return v_result;
end $$;

-- ── review_captured_event: post-lock recheck, source whitelist, v3, correct tip ─
create or replace function review_captured_event(
  p_captured_id uuid, p_verification_notes text, p_verified_accurate boolean,
  p_approval_signature text, p_edited boolean default null
) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid(); v_firm uuid; v_reviewed_at timestamptz := now();
  v_cap ai_event%rowtype; v_prev text; v_hash text; v_event uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if coalesce(trim(p_verification_notes), '') = '' then raise exception 'verification notes are required'; end if;
  if coalesce(trim(p_approval_signature), '') = '' then raise exception 'approval signature is required'; end if;

  select * into v_cap from ai_event where id = p_captured_id and firm_id = v_firm;
  if not found then raise exception 'captured event not found in your firm'; end if;
  if v_cap.reviewed then raise exception 'that event is already a reviewed record'; end if;
  if v_cap.reviews_event_id is not null then raise exception 'that is a review record, not a captured event'; end if;
  if v_cap.source = 'manual' then raise exception 'only auto-captured events are reviewed this way'; end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || v_firm::text, 0));
  -- recheck AFTER the lock (TOCTOU): the unique index is the backstop
  if exists (select 1 from ai_event where firm_id = v_firm and reviews_event_id = p_captured_id) then
    raise exception 'this captured event has already been reviewed';
  end if;
  v_prev := ai_event_chain_head(v_firm);

  v_hash := encode(digest(
    ai_event_canonical_v3(
      v_firm, v_uid, v_cap.tool, v_cap.model, 'manual', v_cap.occurred_at, v_cap.data_kind,
      v_cap.data_sensitivity::text, v_cap.pii_included, v_cap.client_ref, v_cap.matter_ref,
      null, null, true, v_uid, v_reviewed_at,
      p_verification_notes, p_edited, p_verified_accurate, null, null, p_approval_signature, p_captured_id
    ) || coalesce(v_prev, ''), 'sha256'), 'hex');

  insert into ai_event (
    firm_id, user_id, source, tool, model, client_ref, matter_ref, occurred_at,
    data_kind, data_sensitivity, pii_included, reviewed, reviewer_id, reviewed_at,
    verification_notes, edited, verified_accurate, approval_signature,
    reviews_event_id, prev_hash, record_hash
  ) values (
    v_firm, v_uid, 'manual', v_cap.tool, v_cap.model, v_cap.client_ref, v_cap.matter_ref, v_cap.occurred_at,
    v_cap.data_kind, v_cap.data_sensitivity, v_cap.pii_included, true, v_uid, v_reviewed_at,
    p_verification_notes, p_edited, p_verified_accurate, p_approval_signature,
    p_captured_id, v_prev, v_hash
  ) returning id into v_event;
  return v_event;
end $$;

revoke all on function ingest_ai_events_batch from public, anon, authenticated;
grant execute on function ingest_ai_events_batch to service_role;
revoke all on function ingest_ai_event from public, anon, authenticated;
grant execute on function ingest_ai_event to service_role;
revoke all on function review_captured_event from public, anon;
grant execute on function review_captured_event to authenticated;
