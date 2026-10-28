-- ── Raw-capture retention (opt-in per firm, encrypted at rest) ──────────────
-- Data-minimization stays the DEFAULT: captured events store only metadata +
-- content hashes. A firm ADMIN may opt in to retaining the actual prompt/output
-- text so a reviewer can inspect it before signing off. When on, the text is
-- AES-256-GCM encrypted in the app (key in env, never in the DB) and the
-- ciphertext lands on the artifact row; the record_hash still binds the content
-- SHA (not the ciphertext), so tamper-evidence is unchanged and retained content
-- is verifiable against the chain (decrypt -> sha256 -> compare).

-- firm-level switch, default OFF (matches the privacy policy: opt-in per firm)
alter table firm add column if not exists retain_raw_captures boolean not null default false;

-- encrypted content on the artifact (nullable; set only when the firm opted in)
alter table artifact
  add column if not exists content_ciphertext text,
  add column if not exists content_iv text,
  add column if not exists content_tag text;

-- ── ingest_ai_events_batch: same as 0018 + optionally store encrypted content ─
-- Only NEW behavior: if an event carries prompt_ct/iv/tag or output_ct/iv/tag
-- (the app sealed them because the firm opted in), persist them on the artifact.
-- The canonical hash + everything else is byte-identical to 0018.
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
revoke all on function ingest_ai_events_batch from public, anon, authenticated;
grant execute on function ingest_ai_events_batch to service_role;

-- ── admin toggles the firm switch (service-role callers pass firm explicitly) ─
-- Authenticated path: firm resolved from auth.uid(); only admins may flip it.
create or replace function set_retain_raw_captures(p_on boolean) returns void
  language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_firm uuid; v_role text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id, role into v_firm, v_role from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if v_role is distinct from 'admin' then raise exception 'only admins can change content retention'; end if;
  update firm set retain_raw_captures = coalesce(p_on, false) where id = v_firm;
end $$;
revoke all on function set_retain_raw_captures(boolean) from public, anon;
grant execute on function set_retain_raw_captures(boolean) to authenticated;
