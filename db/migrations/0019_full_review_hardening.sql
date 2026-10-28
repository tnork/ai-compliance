-- ── Full-codebase Codex review hardening (2026-07-08) ───────────────────────
-- P1: generate_defense_packet accepted an arbitrary client coverage summary and
--   was authenticated-executable → a user could bypass the app and mint a packet
--   claiming 100% coverage with invented findings that still "verifies". FIX:
--   make it service-role-only (params firm_id + generated_by); the ONLY caller is
--   the server action, which derives coverage server-side from the real records.
-- P1: several tenant tables allowed cross-firm foreign references (insert policy
--   checked only the new row's firm_id, not that user_id/policy_id/approved_by
--   belong to that firm). FIX: composite (id, firm_id) FKs.
-- P2: policy update/delete let any firm member act on any policy. FIX: creator-
--   or-admin on both USING clauses.
-- P2: lead/contact_message had no column-size limits. FIX: length CHECKs.

-- ── composite-FK targets: (id, firm_id) must be unique to be referenced ──────
alter table app_user add constraint app_user_id_firm_uniq unique (id, firm_id);
alter table policy   add constraint policy_id_firm_uniq   unique (id, firm_id);

-- ── tenant-consistent foreign references (drop single-col FK → add composite) ─
alter table attestation drop constraint if exists attestation_user_id_fkey;
alter table attestation drop constraint if exists attestation_policy_id_fkey;
alter table attestation add constraint attestation_user_same_firm_fk
  foreign key (user_id, firm_id) references app_user(id, firm_id) on delete cascade;
alter table attestation add constraint attestation_policy_same_firm_fk
  foreign key (policy_id, firm_id) references policy(id, firm_id) on delete cascade;

alter table training_record drop constraint if exists training_record_user_id_fkey;
alter table training_record add constraint training_user_same_firm_fk
  foreign key (user_id, firm_id) references app_user(id, firm_id) on delete cascade;

alter table ai_account drop constraint if exists ai_account_user_id_fkey;
alter table ai_account add constraint ai_account_user_same_firm_fk
  foreign key (user_id, firm_id) references app_user(id, firm_id) on delete cascade;

-- approved_by is nullable → MATCH SIMPLE (default): only enforced when non-null
alter table tool_register drop constraint if exists tool_register_approved_by_fkey;
alter table tool_register add constraint tool_register_approver_same_firm_fk
  foreign key (approved_by, firm_id) references app_user(id, firm_id);

-- ── policy ownership: creator-or-admin on update AND delete ─────────────────
drop policy if exists policy_upd on policy;
drop policy if exists policy_del on policy;
create policy policy_upd on policy for update
  using (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'))
  with check (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'));
create policy policy_del on policy for delete
  using (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'));

-- ── public-capture size caps (cheap abuse mitigation; edge rate-limit still TODO) ─
alter table lead add constraint lead_len_ck check (
  char_length(coalesce(email,'')) <= 320 and char_length(coalesce(firm_name,'')) <= 200
  and char_length(coalesce(source,'')) <= 120 and char_length(coalesce(first_name,'')) <= 100
  and char_length(coalesce(last_name,'')) <= 100 and char_length(coalesce(phone,'')) <= 40);
alter table contact_message add constraint contact_len_ck check (
  char_length(coalesce(email::text,'')) <= 320 and char_length(coalesce(firm_name,'')) <= 200
  and char_length(coalesce(first_name,'')) <= 100 and char_length(coalesce(last_name,'')) <= 100
  and char_length(coalesce(phone,'')) <= 40
  and char_length(coalesce(message,'')) <= 5000 and char_length(coalesce(source,'')) <= 120);

-- ── generate_defense_packet → service-role only, explicit firm/generated_by ──
drop function if exists generate_defense_packet(jsonb, text);
create or replace function generate_defense_packet(
  p_firm_id uuid, p_generated_by uuid, p_summary jsonb, p_standard_code text default 'circular_230'
) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_std uuid; v_now timestamptz := now();
  v_ids uuid[]; v_hashes jsonb; v_head text; v_hash text; v_id uuid;
begin
  if p_firm_id is null then raise exception 'firm required'; end if;
  if p_summary is null then raise exception 'coverage summary is required'; end if;
  if p_generated_by is not null and not exists (select 1 from app_user where id = p_generated_by and firm_id = p_firm_id) then
    raise exception 'generated_by is not a member of the firm';
  end if;
  select id into v_std from standard where code = p_standard_code;

  select array_agg(id order by created_at, id),
         coalesce(jsonb_agg(record_hash order by created_at, id), '[]'::jsonb)
    into v_ids, v_hashes from ai_event where firm_id = p_firm_id;
  if v_ids is null then raise exception 'no review records to export'; end if;
  v_head := ai_event_chain_head(p_firm_id);

  v_hash := encode(digest(
    '{"v":2'
    || ',"firm_id":'       || to_json(p_firm_id::text)::text
    || ',"generated_at":'  || to_json(to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"chain_head":'    || coalesce(to_json(v_head)::text, 'null')
    || ',"record_hashes":' || v_hashes::text
    || ',"summary":'       || p_summary::text
    || '}', 'sha256'), 'hex');

  insert into defense_packet (firm_id, scope, standard_id, generated_at, generated_by,
    event_ids, chain_head, coverage_summary, packet_hash)
  values (p_firm_id, 'firm', v_std, v_now, p_generated_by, v_ids, v_head, p_summary, v_hash)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function generate_defense_packet(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function generate_defense_packet(uuid, uuid, jsonb, text) to service_role;
