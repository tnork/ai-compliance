-- ── Phase 5 scale: set-based batch ingest (CaptureArchitecture.md §8.5) ─────
-- Many clients sending regular batches shouldn't each pay N round-trips + N
-- advisory-lock acquisitions. ingest_ai_events_batch appends a whole batch under
-- ONE per-firm lock in ONE transaction: read the chain head once, then chain
-- every event off the running prev. Same guarantees as ingest_ai_event
-- (reviewed=false captured, idempotent on (firm_id, external_id), null-safe
-- canonical hash) — just amortized. Returns per-event {external_id, status} so
-- the caller computes accepted/duplicate; a bad row is 'error', never a chain gap.
--
-- p_source applies to the whole batch (one client = one source). Each element of
-- p_events carries its own user_id (resolved by the app layer): the extension
-- passes the authed user for every row; the connector resolves per-email.

create or replace function ingest_ai_events_batch(p_firm_id uuid, p_source text, p_events jsonb)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_users uuid[];
  v_prev text;
  v_result jsonb := '[]'::jsonb;
  v_seen text[] := array[]::text[];       -- external_ids inserted this run (intra-batch dedup)
  v_existing text[];
  ev jsonb;
  v_uid uuid; v_ext text; v_tool text; v_hash text; v_event uuid;
  v_occurred timestamptz; v_psha text; v_osha text; v_pref uuid; v_oref uuid;
begin
  if p_firm_id is null then raise exception 'firm required'; end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events must be a json array'; end if;

  -- firm's users once (membership check without a subquery per row)
  select array_agg(id) into v_users from app_user where firm_id = p_firm_id;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));

  -- external_ids already captured for this firm (idempotency, one query)
  select array_agg(external_id) into v_existing from ai_event
   where firm_id = p_firm_id
     and external_id = any (select jsonb_array_elements_text(jsonb_path_query_array(p_events, '$[*].external_id')));

  select record_hash into v_prev from ai_event where firm_id = p_firm_id order by created_at desc, id desc limit 1;

  for ev in select * from jsonb_array_elements(p_events) loop
    v_ext := ev->>'external_id';
    v_uid := (ev->>'user_id')::uuid;
    v_tool := trim(ev->>'tool');

    if v_ext is not null and (v_ext = any(coalesce(v_existing, '{}')) or v_ext = any(v_seen)) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'duplicate'); continue;
    end if;
    if v_uid is null or not (v_uid = any(coalesce(v_users, '{}'))) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'error', 'reason', 'user not in firm'); continue;
    end if;
    if coalesce(v_tool, '') = '' then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'error', 'reason', 'tool required'); continue;
    end if;

    v_occurred := coalesce((ev->>'occurred_at')::timestamptz, now());
    v_psha := ev->>'prompt_sha256'; v_osha := ev->>'output_sha256';
    v_pref := case when v_psha is not null then gen_random_uuid() end;
    v_oref := case when v_osha is not null then gen_random_uuid() end;

    v_hash := encode(digest(
      ai_event_canonical_v2(
        p_firm_id, v_uid, v_tool, ev->>'model', p_source, v_occurred, ev->>'data_kind',
        coalesce(ev->>'data_sensitivity','none'), coalesce((ev->>'pii_included')::boolean,false),
        ev->>'client_ref', null, v_psha, v_osha, false, null, null,
        null, null, null, null, null, null
      ) || coalesce(v_prev, ''), 'sha256'), 'hex');

    insert into ai_event (
      firm_id, user_id, source, external_id, tool, model, client_ref, occurred_at,
      data_kind, data_sensitivity, pii_included, prompt_ref, output_ref,
      reviewed, prev_hash, record_hash
    ) values (
      p_firm_id, v_uid, p_source::source_t, v_ext, v_tool, ev->>'model', ev->>'client_ref', v_occurred,
      ev->>'data_kind', coalesce(ev->>'data_sensitivity','none')::sens_t, coalesce((ev->>'pii_included')::boolean,false),
      v_pref, v_oref, false, v_prev, v_hash
    ) returning id into v_event;

    if v_pref is not null then
      insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
      values (v_pref, p_firm_id, v_event, 'prompt', v_psha, (ev->>'prompt_bytes')::bigint);
    end if;
    if v_oref is not null then
      insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size)
      values (v_oref, p_firm_id, v_event, 'output', v_osha, (ev->>'output_bytes')::bigint);
    end if;

    v_prev := v_hash;                       -- chain the next event off this one
    if v_ext is not null then v_seen := v_seen || v_ext; end if;
    v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'inserted');
  end loop;

  return v_result;
end $$;

revoke all on function ingest_ai_events_batch from public, anon, authenticated;
grant execute on function ingest_ai_events_batch to service_role;
