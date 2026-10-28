-- ── Member permissions: role (Admin/User) + granular view-logs / review ────
-- Two dimensions per member, admin-managed, persisted here:
--   • role: 'admin' | 'staff'  (staff = "User" in the UI). Admins invite + manage.
--   • can_view_logs / can_review: booleans an admin toggles per user. Admins
--     implicitly have both. Review implies view (you can't review what you can't
--     see) — so the view-logs helper also returns true for reviewers.
-- Everyone keeps: dashboard, view policy, do their own attestation.

alter table app_user
  add column if not exists can_view_logs boolean not null default false,
  add column if not exists can_review    boolean not null default false;

-- Backfill: the role_t enum has a legacy 'reviewer' value the UI never sets
-- (it only offers Admin/User=staff). Any existing reviewer must NOT silently
-- lose access under the new model — normalize them to staff + can_review
-- (review implies view), so their capability is preserved. No-op where none exist.
update app_user set role = 'staff', can_review = true where role = 'reviewer';

-- helpers (SECURITY DEFINER so they read app_user regardless of that table's RLS)
create or replace function current_user_can_view_logs() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_user
    where id = auth.uid()
      and (role = 'admin' or can_view_logs or can_review)  -- review implies view
  )
$$;
create or replace function current_user_can_review() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_user where id = auth.uid() and (role = 'admin' or can_review)
  )
$$;

-- ── RLS: gate the LOGS on view-logs (DB is the real boundary) ────────────────
-- ai_event / artifact / defense_packet are the "logs" — a member without
-- view-logs literally cannot read them, even via direct PostgREST.
drop policy if exists ai_event_sel on ai_event;
create policy ai_event_sel on ai_event for select
  using (firm_id = current_firm_id() and current_user_can_view_logs());
drop policy if exists artifact_sel on artifact;
create policy artifact_sel on artifact for select
  using (firm_id = current_firm_id() and current_user_can_view_logs());
drop policy if exists defense_packet_sel on defense_packet;
create policy defense_packet_sel on defense_packet for select
  using (firm_id = current_firm_id() and current_user_can_view_logs());

-- ── write RPCs: require review permission (append a guard at the top) ────────
-- log_ai_event (manual review entry) and review_captured_event are "review and
-- approve" — gate on can_review. ingest_* stay service-role (system capture).
-- Only the guard line is added; the rest of each body is unchanged from 0018.
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
  if not current_user_can_review() then raise exception 'you do not have review permission'; end if;
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
  if not current_user_can_review() then raise exception 'you do not have review permission'; end if;
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
