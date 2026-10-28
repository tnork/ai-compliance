-- ── Packet integrity hardening (Codex review #2, 2026-07-08) ────────────────
-- Same root cause as 0010: the CLIENT supplied integrity data. defense_packet
-- inserts now go ONLY through generate_defense_packet(): attribution forced to
-- the caller, the event set + chain head derived from the firm's actual chain,
-- generated_at pinned, and packet_hash computed in-DB over all of it. The
-- caller supplies only coverage_summary (its findings are re-derivable from
-- the immutable records; the hash binds the summary so it can't change later).

drop policy if exists defense_packet_ins on defense_packet;

create or replace function generate_defense_packet(p_summary jsonb, p_standard_code text default 'circular_230')
returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid;
  v_std uuid;
  v_now timestamptz := now();
  v_ids uuid[]; v_hashes jsonb; v_head text; v_hash text; v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if p_summary is null then raise exception 'coverage summary is required'; end if;
  select id into v_std from standard where code = p_standard_code;

  -- the packet's event set is the firm's chain as it exists NOW, never caller-chosen
  select array_agg(id order by created_at, id),
         coalesce(jsonb_agg(record_hash order by created_at, id), '[]'::jsonb)
    into v_ids, v_hashes
    from ai_event where firm_id = v_firm;
  if v_ids is null then raise exception 'no review records to export'; end if;

  -- true chain head: the record no other record links back to
  select e.record_hash into v_head
    from ai_event e
   where e.firm_id = v_firm
     and not exists (select 1 from ai_event x where x.firm_id = v_firm and x.prev_hash = e.record_hash);

  -- hash binds firm, moment, chain head, every record hash, and the frozen summary.
  -- jsonb::text is deterministic (jsonb normalizes key order), so this is
  -- re-verifiable in-DB from the stored row.
  v_hash := encode(digest(
    '{"v":2'
    || ',"firm_id":'       || to_json(v_firm::text)::text
    || ',"generated_at":'  || to_json(to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"chain_head":'    || coalesce(to_json(v_head)::text, 'null')
    || ',"record_hashes":' || v_hashes::text
    || ',"summary":'       || p_summary::text
    || '}', 'sha256'), 'hex');

  insert into defense_packet (
    firm_id, scope, standard_id, generated_at, generated_by,
    event_ids, chain_head, coverage_summary, packet_hash
  ) values (
    v_firm, 'firm', v_std, v_now, v_uid,
    v_ids, v_head, p_summary, v_hash
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function generate_defense_packet from public, anon;
grant execute on function generate_defense_packet to authenticated;

-- re-verification: recompute a stored packet's hash entirely in-DB
create or replace function verify_defense_packet(p_id uuid) returns boolean
  language sql stable security invoker set search_path = public, extensions as $$
  select dp.packet_hash = encode(digest(
    '{"v":2'
    || ',"firm_id":'       || to_json(dp.firm_id::text)::text
    || ',"generated_at":'  || to_json(to_char(dp.generated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"chain_head":'    || coalesce(to_json(dp.chain_head)::text, 'null')
    || ',"record_hashes":' || coalesce((
         select jsonb_agg(e.record_hash order by e.created_at, e.id)
           from ai_event e where e.id = any(dp.event_ids)), '[]'::jsonb)::text
    || ',"summary":'       || dp.coverage_summary::text
    || '}', 'sha256'), 'hex')
  from defense_packet dp where dp.id = p_id
$$;
grant execute on function verify_defense_packet to authenticated;
