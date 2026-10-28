-- ── 0029: capture-surface telemetry on ai_event (surface + os) ───────────────
-- Every captured LLM interaction now records WHERE it happened, so admins can
-- report usage by member x AI system x surface x OS:
--   surface = the capture surface: browser name for the extension (chrome/edge/
--             brave/opera/vivaldi/firefox/chromium), 'desktop' for the desktop
--             logger, 'connector' for enterprise Compliance-API pulls.
--   os      = operating system when the capture client knows it (macos/windows/
--             linux/chromeos); null for connector pulls (provider-side) and
--             legacy/manual events.
-- Both are SUPPLEMENTARY telemetry, deliberately NOT part of canonical v3 /
-- record_hash: the hash binds the evidentiary supervision fields (who/what/
-- when/content SHAs/review state); adding fields to the canonical would break
-- every existing chain. Nullable, best-effort, clamped server-side.

alter table ai_event
  add column if not exists surface text,
  add column if not exists os text;

comment on column ai_event.surface is
  'Capture surface: browser name (extension), ''desktop'' (desktop logger), ''connector'' (enterprise API). Supplementary telemetry - not bound into record_hash.';
comment on column ai_event.os is
  'Operating system of the capture client (macos/windows/linux/chromeos), when known. Supplementary telemetry - not bound into record_hash.';

-- ── ingest_ai_events_batch: same as 0024 + persist surface/os per event ──────
-- Only NEW behavior: ev->>'surface' / ev->>'os' are trimmed, lowercased,
-- length-capped, and stored. Hashing and everything else is byte-identical to
-- 0024 (chains unaffected).
create or replace function ingest_ai_events_batch(p_firm_id uuid, p_source text, p_events jsonb)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_users uuid[]; v_prev text; v_result jsonb := '[]'::jsonb; v_seen text[] := array[]::text[];
  v_existing text[]; ev jsonb; v_uid uuid; v_ext text; v_tool text; v_hash text; v_event uuid;
  v_occurred timestamptz; v_psha text; v_osha text; v_pref uuid; v_oref uuid;
  v_surface text; v_os text;
begin
  if p_firm_id is null then raise exception 'firm required'; end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events must be a json array'; end if;
  select array_agg(id) into v_users from app_user where firm_id = p_firm_id;
  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));
  select array_agg(external_id) into v_existing from ai_event
   where firm_id = p_firm_id
     and external_id = any (select jsonb_array_elements_text(jsonb_path_query_array(p_events, '$[*].external_id')));
  v_prev := ai_event_chain_head(p_firm_id);

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
    v_surface := nullif(left(lower(trim(ev->>'surface')), 40), '');
    v_os := nullif(left(lower(trim(ev->>'os')), 40), '');
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
      data_kind, data_sensitivity, pii_included, prompt_ref, output_ref, reviewed, prev_hash, record_hash,
      surface, os
    ) values (
      p_firm_id, v_uid, p_source::source_t, v_ext, v_tool, ev->>'model', ev->>'client_ref', v_occurred,
      ev->>'data_kind', coalesce(ev->>'data_sensitivity','none')::sens_t, coalesce((ev->>'pii_included')::boolean,false),
      v_pref, v_oref, false, v_prev, v_hash,
      v_surface, v_os
    ) returning id into v_event;
    if v_pref is not null then
      insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size, content_ciphertext, content_iv, content_tag)
      values (v_pref, p_firm_id, v_event, 'prompt', v_psha, (ev->>'prompt_bytes')::bigint,
              ev->>'prompt_ct', ev->>'prompt_iv', ev->>'prompt_tag');
    end if;
    if v_oref is not null then
      insert into artifact (id, firm_id, ai_event_id, kind, sha256, byte_size, content_ciphertext, content_iv, content_tag)
      values (v_oref, p_firm_id, v_event, 'output', v_osha, (ev->>'output_bytes')::bigint,
              ev->>'output_ct', ev->>'output_iv', ev->>'output_tag');
    end if;
    v_prev := v_hash;
    if v_ext is not null then v_seen := v_seen || v_ext; end if;
    v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'inserted');
  end loop;
  return v_result;
end $$;
revoke all on function ingest_ai_events_batch from anon, public, authenticated;
grant execute on function ingest_ai_events_batch to service_role;
