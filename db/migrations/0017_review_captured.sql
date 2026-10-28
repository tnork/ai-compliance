-- ── Review a captured event (CaptureArchitecture.md §8.1) ───────────────────
-- Captured events land reviewed=false and the chain is append-only, so a human
-- can't flip reviewed on them. The correct model: REVIEWING a captured event is
-- a NEW fact → append a review event that references the captured one via
-- reviews_event_id. Coverage then treats the captured event as satisfied because
-- a review event points at it (see web/lib/coverage.ts). The review event is a
-- normal hash-chained ai_event (reviewed=true, the reviewer's verification), but
-- it is excluded from the per-event coverage tally (it annotates, not new usage).

alter table ai_event add column if not exists reviews_event_id uuid references ai_event(id);
create index if not exists ai_event_reviews on ai_event(firm_id, reviews_event_id) where reviews_event_id is not null;

-- Append a review event resolving a captured event. auth.uid()-based (the
-- reviewer is the logged-in user). Validates the target is a captured
-- (unreviewed) event in the caller's firm and not already reviewed.
create or replace function review_captured_event(
  p_captured_id uuid, p_verification_notes text, p_verified_accurate boolean,
  p_approval_signature text, p_edited boolean default null
) returns uuid
  language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid;
  v_reviewed_at timestamptz := now();
  v_cap ai_event%rowtype;
  v_prev text; v_hash text; v_event uuid;
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
  if exists (select 1 from ai_event where firm_id = v_firm and reviews_event_id = p_captured_id) then
    raise exception 'this captured event has already been reviewed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ai_event_chain:' || v_firm::text, 0));
  select record_hash into v_prev from ai_event where firm_id = v_firm order by created_at desc, id desc limit 1;

  -- the review event carries the captured event's identifying fields + tool so
  -- the packet reads naturally; reviewed=true with the human's verification.
  v_hash := encode(digest(
    ai_event_canonical_v2(
      v_firm, v_uid, v_cap.tool, v_cap.model, 'manual', v_cap.occurred_at, v_cap.data_kind,
      v_cap.data_sensitivity::text, v_cap.pii_included, v_cap.client_ref, v_cap.matter_ref,
      null, null, true, v_uid, v_reviewed_at,
      p_verification_notes, p_edited, p_verified_accurate, null, null, p_approval_signature
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

revoke all on function review_captured_event from public, anon;
grant execute on function review_captured_event to authenticated;
