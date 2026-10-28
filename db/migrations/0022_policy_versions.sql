-- ── Policy version history + edit tracking ─────────────────────────────────
-- A `policy` row is the logical document (firm-scoped, adopt/draft status, and a
-- `version` head pointer). Each edit/save appends an immutable `policy_version`
-- snapshot: the rendered body_html + who edited it + when + an optional note.
-- Writes go ONLY through save_policy_version() so version numbering is race-free
-- (advisory lock) and attribution cannot be forged (edited_by = auth.uid()).
-- Attestations keep referencing the logical policy_id, so new versions don't
-- orphan them (re-attestation on material change is a future refinement).

create table if not exists policy_version (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id(),
  policy_id uuid not null,
  version int not null,
  title text,
  body_html text not null,               -- sanitized on save (server); safe to render
  inputs jsonb not null default '{}'::jsonb, -- snapshot of the policy's form inputs
  note text,                             -- optional "what changed" summary
  edited_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (policy_id, version),
  constraint policy_version_policy_fk foreign key (policy_id, firm_id)
    references policy(id, firm_id) on delete cascade,
  constraint policy_version_editor_fk foreign key (edited_by, firm_id)
    references app_user(id, firm_id)
);
create index if not exists policy_version_lookup on policy_version(policy_id, version desc);

alter table policy_version enable row level security;
-- Firm members read their firm's versions; writes are RPC-only (no insert/update/
-- delete policy = deny-all, fail closed — same posture as ai_event).
drop policy if exists policy_version_sel on policy_version;
create policy policy_version_sel on policy_version for select
  using (firm_id = current_firm_id());

-- Backfill one v1 per existing policy from its stored rendered HTML (draft_html
-- was produced by the escaped-input renderer, so it's safe). Rows with a null
-- draft_html get an empty body; the app falls back to rendering from inputs when
-- a version body is empty.
insert into policy_version (firm_id, policy_id, version, title, body_html, inputs, note, edited_by, created_at)
select firm_id, id, coalesce(version, 1), title, coalesce(draft_html, ''), inputs, 'Created', created_by, created_at
from policy
where not exists (select 1 from policy_version pv where pv.policy_id = policy.id);

-- ── save_policy_version(): the only write path ─────────────────────────────
-- Appends a new head version. Advisory-locked per policy so concurrent saves
-- get sequential version numbers. Creator-or-admin only (mirrors policy_upd RLS).
create or replace function save_policy_version(
  p_policy_id uuid, p_title text default null, p_body_html text default null, p_note text default null
) returns int
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_role text; v_created_by uuid; v_inputs jsonb; v_cur_title text;
  v_next int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_body_html), '') = '' then raise exception 'policy body is required'; end if;
  select firm_id, role into v_firm, v_role from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;

  select created_by, inputs, title into v_created_by, v_inputs, v_cur_title
    from policy where id = p_policy_id and firm_id = v_firm;
  if not found then raise exception 'policy not found in your firm'; end if;
  if not (v_role = 'admin' or v_created_by = v_uid) then
    raise exception 'you do not have permission to edit this policy';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('policy_version:' || p_policy_id::text, 0));
  select coalesce(max(version), 0) + 1 into v_next from policy_version where policy_id = p_policy_id;

  insert into policy_version (firm_id, policy_id, version, title, body_html, inputs, note, edited_by)
  values (v_firm, p_policy_id, v_next,
    coalesce(nullif(trim(p_title), ''), v_cur_title),
    p_body_html, coalesce(v_inputs, '{}'::jsonb), nullif(trim(p_note), ''), v_uid);

  -- keep the policy row's head pointer + rendered cache in sync
  update policy set version = v_next, draft_html = p_body_html,
    title = coalesce(nullif(trim(p_title), ''), title)
    where id = p_policy_id and firm_id = v_firm;

  return v_next;
end $$;
revoke all on function save_policy_version(uuid, text, text, text) from public, anon;
grant execute on function save_policy_version(uuid, text, text, text) to authenticated;
