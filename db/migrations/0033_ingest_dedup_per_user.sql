-- ── 0033: Codex full-codebase review hardening (2026-07-12) ──────────────────
-- P1: capture dedup was firm-wide - `ingest_ai_events_batch` deduped on
--     (firm_id, external_id) BEFORE validating the event's user, and returned
--     'duplicate' (= acked). A member who pre-registered another member's
--     predictable external id could make the victim's client delete its genuine
--     buffered event (evidence loss/misattribution); accidental collisions did
--     the same silently. Fix: dedup is scoped per (firm, USER, external_id),
--     user validity is checked BEFORE the duplicate check (a collision under a
--     different user now inserts normally instead of falsely acking), and the
--     unique index matches the new key.
--
-- P2: attest_wisp() rejected only the exact value 'no' - a forged
--     inputs->>'has_wisp' like 'unknown' rendered as "still establishing a
--     WISP" yet still permitted immutable acknowledgement evidence. Now only
--     missing (= createPolicy default 'yes') or 'yes' allows attesting.

-- unique key matches the new dedup scope
drop index if exists ai_event_firm_external;
create unique index if not exists ai_event_firm_user_external
  on ai_event(firm_id, user_id, external_id) where external_id is not null;

-- same body as 0029 except: user check precedes dup check; dup scoped by user.
-- Hashing and inserts are byte-identical to 0029 (chains unaffected).
create or replace function ingest_ai_events_batch(p_firm_id uuid, p_source text, p_events jsonb)
returns jsonb
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_users uuid[]; v_prev text; v_result jsonb := '[]'::jsonb; v_seen text[] := array[]::text[];
  ev jsonb; v_uid uuid; v_ext text; v_tool text; v_hash text; v_event uuid;
  v_occurred timestamptz; v_psha text; v_osha text; v_pref uuid; v_oref uuid;
  v_surface text; v_os text; v_key text;
begin
  if p_firm_id is null then raise exception 'firm required'; end if;
  if jsonb_typeof(p_events) <> 'array' then raise exception 'events must be a json array'; end if;
  select array_agg(id) into v_users from app_user where firm_id = p_firm_id;
  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || p_firm_id::text, 0));
  v_prev := ai_event_chain_head(p_firm_id);

  for ev in select * from jsonb_array_elements(p_events) loop
    v_ext := ev->>'external_id'; v_uid := (ev->>'user_id')::uuid; v_tool := trim(ev->>'tool');
    -- user validity FIRST: a collision under a different/invalid user must
    -- never be acknowledged as a duplicate (Codex P1)
    if v_uid is null or not (v_uid = any(coalesce(v_users,'{}'))) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'error', 'reason', 'user not in firm'); continue; end if;
    v_key := v_uid::text || ':' || coalesce(v_ext, '');
    if v_ext is not null and (
      v_key = any(v_seen)
      or exists (select 1 from ai_event a where a.firm_id = p_firm_id and a.user_id = v_uid and a.external_id = v_ext)
    ) then
      v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'duplicate'); continue; end if;
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
    if v_ext is not null then v_seen := v_seen || v_key; end if;
    v_result := v_result || jsonb_build_object('external_id', v_ext, 'status', 'inserted');
  end loop;
  return v_result;
end $$;
revoke all on function ingest_ai_events_batch from anon, public, authenticated;
grant execute on function ingest_ai_events_batch to service_role;

-- ── attest_wisp: allowlist, not blocklist ────────────────────────────────────
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

  -- The newest adopted policy must declare a WISP is in place. Missing key =
  -- 'yes' (createPolicy's default); anything OTHER than 'yes' rejects - a
  -- forged value like 'unknown' must not mint acknowledgement evidence.
  select coalesce(inputs->>'has_wisp', 'yes') into v_has
    from policy where firm_id = v_firm and status = 'adopted'
    order by created_at desc limit 1;
  if v_has is null then raise exception 'no adopted policy declares a WISP'; end if;
  if v_has <> 'yes' then raise exception 'the adopted policy does not declare a WISP in place'; end if;

  insert into wisp_attestation (firm_id, user_id) values (v_firm, v_uid)
  on conflict (firm_id, user_id) do nothing;
end $$;
revoke all on function attest_wisp() from anon, public;
grant execute on function attest_wisp() to authenticated, service_role;
