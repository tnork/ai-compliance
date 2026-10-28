-- ── 0034: Firm documents (bring-your-own policy docs: AUP, WISP, other) ──────
-- Firms upload their OWN policy documents (Acceptable Use Policy, WISP, or any
-- other governance doc), version them over time, and optionally have staff
-- acknowledge them. AI Compliance does NOT generate these documents or judge their
-- legal adequacy - it only stores, versions, and tracks acknowledgement of the
-- firm's own files. Every document is firm-isolated by RLS (firm_id); the files
-- live in the private `firm-documents` storage bucket (created out-of-band, like
-- `course-materials`) and this schema holds only metadata + the storage path.
--
-- Model mirrors policy/policy_version: `firm_document` is the logical document
-- (head `version` pointer); each uploaded file is an immutable
-- `firm_document_version` snapshot. Writes to versions + attestations go ONLY
-- through SECURITY DEFINER RPCs (race-free numbering, forced attribution, and a
-- storage-path prefix guard), same posture as save_policy_version /
-- acknowledge_policy.

-- ── logical document ────────────────────────────────────────────────────────
create table if not exists firm_document (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  doc_type text not null check (doc_type in ('aup','wisp','other')),
  title text not null,
  description text,
  version int not null default 0,        -- head pointer; 1 after the first upload
  created_by uuid not null default auth.uid() references app_user(id),
  created_at timestamptz not null default now(),
  unique (id, firm_id)                   -- referenced by composite FKs (tenant-consistent)
);
create index if not exists firm_document_firm_idx on firm_document(firm_id, created_at desc);
alter table firm_document enable row level security;

drop policy if exists firm_document_sel on firm_document;
drop policy if exists firm_document_ins on firm_document;
drop policy if exists firm_document_upd on firm_document;
drop policy if exists firm_document_del on firm_document;
create policy firm_document_sel on firm_document for select using (firm_id = current_firm_id());
-- any firm member may add a document; created_by is forced to the caller
create policy firm_document_ins on firm_document for insert
  with check (firm_id = current_firm_id() and created_by = auth.uid());
-- NO direct UPDATE policy (deny-all, fail closed): the `version` head pointer is
-- integrity-managed and must only move through add_firm_document_version(). A
-- direct client update could otherwise set version to a nonexistent value,
-- breaking the acknowledgement FK + the UI's "current version" (Codex P1). The
-- SECURITY DEFINER RPCs run as table owner and bypass RLS, so they still update
-- version. (Add an update_firm_document() RPC later if metadata editing is needed.)
-- delete: creator or admin (mirrors policy/course ownership)
create policy firm_document_del on firm_document for delete
  using (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'));

comment on table firm_document is
  'A firm''s own uploaded policy document (AUP, WISP, or other). AI Compliance stores/versions it but never generates it or judges legal adequacy. firm-isolated by RLS; files live in the private firm-documents bucket.';

-- ── immutable file versions (metadata; files in the private bucket) ─────────
create table if not exists firm_document_version (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id(),
  document_id uuid not null,
  version int not null,
  file_name text not null,
  storage_path text not null unique,     -- '<firm_id>/<document_id>/<uuid>__<name>'
  mime_type text,
  byte_size bigint,
  note text,                             -- optional "what changed"
  uploaded_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (document_id, version),
  constraint firm_document_version_doc_fk foreign key (document_id, firm_id)
    references firm_document(id, firm_id) on delete cascade,
  constraint firm_document_version_uploader_fk foreign key (uploaded_by, firm_id)
    references app_user(id, firm_id)
);
create index if not exists firm_document_version_lookup on firm_document_version(document_id, version desc);
alter table firm_document_version enable row level security;
-- firm members read; writes are RPC-only (no insert/update/delete policy =
-- deny-all, fail closed - same posture as policy_version).
drop policy if exists firm_document_version_sel on firm_document_version;
create policy firm_document_version_sel on firm_document_version for select
  using (firm_id = current_firm_id());

-- ── optional per-member acknowledgement (append-only log) ───────────────────
create table if not exists firm_document_attestation (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id(),
  document_id uuid not null,
  document_version int not null,
  user_id uuid not null default auth.uid(),
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (document_id, user_id, document_version),   -- one ack per member per version
  constraint firm_document_attestation_doc_fk foreign key (document_id, firm_id)
    references firm_document(id, firm_id) on delete cascade,
  constraint firm_document_attestation_member_fk foreign key (user_id, firm_id)
    references app_user(id, firm_id) on delete cascade,
  constraint firm_document_attestation_version_fk foreign key (document_id, document_version)
    references firm_document_version(document_id, version) on delete cascade
);
create index if not exists firm_document_attestation_doc_idx on firm_document_attestation(document_id, document_version);
alter table firm_document_attestation enable row level security;
-- firm-scoped read (admins see who acknowledged); writes RPC-only (immutable log)
drop policy if exists firm_document_attestation_sel on firm_document_attestation;
create policy firm_document_attestation_sel on firm_document_attestation for select
  using (firm_id = current_firm_id());

comment on table firm_document_attestation is
  'Optional per-member acknowledgement of a firm_document version (append-only, one row per member per version). RPC-only writes; a new uploaded version re-opens the acknowledgement.';

-- ── create_firm_document(): logical doc + its v1, atomically ────────────────
-- The action generates the doc id (so the storage path can be built before the
-- row exists), uploads the file, then calls this. firm_id + created_by are
-- forced to the caller; the storage path must sit inside the caller's own firm
-- prefix (defense-in-depth against a cross-tenant path).
create or replace function create_firm_document(
  p_id uuid, p_doc_type text, p_title text, p_description text,
  p_file_name text, p_storage_path text, p_mime text, p_size bigint
) returns uuid
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_doc_type not in ('aup','wisp','other') then raise exception 'invalid document type'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title is required'; end if;
  if coalesce(trim(p_file_name), '') = '' or coalesce(trim(p_storage_path), '') = '' then
    raise exception 'a file is required'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if position(v_firm::text || '/' in p_storage_path) <> 1 then raise exception 'invalid storage path'; end if;

  insert into firm_document (id, firm_id, doc_type, title, description, version, created_by)
  values (p_id, v_firm, p_doc_type, trim(p_title), nullif(trim(p_description), ''), 1, v_uid);

  insert into firm_document_version (firm_id, document_id, version, file_name, storage_path, mime_type, byte_size, note, uploaded_by)
  values (v_firm, p_id, 1, p_file_name, p_storage_path, nullif(p_mime, ''), p_size, 'Initial upload', v_uid);

  return p_id;
end $$;
revoke all on function create_firm_document(uuid, text, text, text, text, text, text, bigint) from anon, public;
grant execute on function create_firm_document(uuid, text, text, text, text, text, text, bigint) to authenticated;

-- ── add_firm_document_version(): append a new head version ──────────────────
-- Advisory-locked per document so concurrent uploads get sequential numbers.
-- Creator-or-admin only (mirrors firm_document_upd). Storage-path prefix guard.
create or replace function add_firm_document_version(
  p_document_id uuid, p_file_name text, p_storage_path text, p_mime text, p_size bigint, p_note text
) returns int
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_role text; v_created_by uuid; v_next int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_file_name), '') = '' or coalesce(trim(p_storage_path), '') = '' then
    raise exception 'a file is required'; end if;
  select firm_id, role into v_firm, v_role from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;
  if position(v_firm::text || '/' in p_storage_path) <> 1 then raise exception 'invalid storage path'; end if;

  select created_by into v_created_by from firm_document where id = p_document_id and firm_id = v_firm;
  if not found then raise exception 'document not found in your firm'; end if;
  if not (v_role = 'admin' or v_created_by = v_uid) then
    raise exception 'you do not have permission to edit this document';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('firm_document:' || p_document_id::text, 0));
  select coalesce(max(version), 0) + 1 into v_next from firm_document_version where document_id = p_document_id;

  insert into firm_document_version (firm_id, document_id, version, file_name, storage_path, mime_type, byte_size, note, uploaded_by)
  values (v_firm, p_document_id, v_next, p_file_name, p_storage_path, nullif(p_mime, ''), p_size, nullif(trim(p_note), ''), v_uid);

  update firm_document set version = v_next where id = p_document_id and firm_id = v_firm;
  return v_next;
end $$;
revoke all on function add_firm_document_version(uuid, text, text, text, bigint, text) from anon, public;
grant execute on function add_firm_document_version(uuid, text, text, text, bigint, text) to authenticated;

-- ── attest_firm_document(): acknowledge the current head version ────────────
-- Optional. Attribution forced to auth.uid(); always attests the true head
-- version (never a client-supplied one); repeat of the same version no-ops; a
-- new uploaded version re-opens the acknowledgement (append-only log).
create or replace function attest_firm_document(p_document_id uuid) returns int
  language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_firm uuid; v_head int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select firm_id into v_firm from app_user where id = v_uid;
  if v_firm is null then raise exception 'no firm membership'; end if;

  perform pg_advisory_xact_lock(hashtextextended('firm_document:' || p_document_id::text, 0));
  select version into v_head from firm_document where id = p_document_id and firm_id = v_firm;
  if not found then raise exception 'document not found in your firm'; end if;
  if coalesce(v_head, 0) < 1 then raise exception 'document has no uploaded version'; end if;

  if exists (select 1 from firm_document_attestation
             where document_id = p_document_id and user_id = v_uid and document_version = v_head) then
    return v_head;
  end if;
  insert into firm_document_attestation (firm_id, document_id, document_version, user_id)
  values (v_firm, p_document_id, v_head, v_uid);
  return v_head;
end $$;
revoke all on function attest_firm_document(uuid) from anon, public;
grant execute on function attest_firm_document(uuid) to authenticated, service_role;
