-- ── Atomic member management (fixes the last-admin race) ────────────────────
-- The staff-page updateMember action counted admins then updated in two steps.
-- Two concurrent demotions could each see ">1 admin" and both proceed, leaving
-- the firm with zero admins. Move the whole thing into one RPC that locks the
-- firm's admin rows (SELECT … FOR UPDATE) before counting — the second demotion
-- then blocks, re-reads, and sees the last admin. Runs SECURITY DEFINER but is
-- scoped to the CALLER's firm via auth.uid(); the caller must be an admin.
-- (app_metadata.role parity still happens in the server action via the admin
--  API — that can't be done in SQL.)

create or replace function admin_set_member(
  p_user_id uuid, p_role text,
  p_can_view_logs boolean default false, p_can_review boolean default false
) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_caller_role text; v_target_role text;
  -- normalize: only 'admin' or 'staff'; admins implicitly have both grants
  v_role   text    := case when p_role = 'admin' then 'admin' else 'staff' end;
  v_view   boolean := case when v_role = 'admin' then false else coalesce(p_can_view_logs, false) end;
  v_review boolean := case when v_role = 'admin' then false else coalesce(p_can_review, false) end;
  v_admin_count int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id, role into v_firm, v_caller_role from app_user where id = v_uid;
  if v_caller_role is distinct from 'admin' then raise exception 'only admins can manage members'; end if;

  -- serialize concurrent demotions within this firm: hold a write lock on every
  -- admin row so a second demotion waits for this txn to commit before counting.
  perform 1 from app_user where firm_id = v_firm and role = 'admin' for update;

  select role into v_target_role from app_user where id = p_user_id and firm_id = v_firm;
  if v_target_role is null then raise exception 'that member is not in your firm'; end if;

  if v_target_role = 'admin' and v_role <> 'admin' then
    select count(*) into v_admin_count from app_user where firm_id = v_firm and role = 'admin';
    if v_admin_count <= 1 then raise exception 'your firm must keep at least one admin'; end if;
  end if;

  update app_user
    set role = v_role, can_view_logs = v_view, can_review = v_review
    where id = p_user_id and firm_id = v_firm;
end $$;

-- callable by signed-in users; the body enforces admin + firm scope. Deny anon.
revoke all on function admin_set_member(uuid, text, boolean, boolean) from public, anon;
grant execute on function admin_set_member(uuid, text, boolean, boolean) to authenticated;
