-- ── Training courses (reusable course catalog + attachments) ────────────────
-- Firms build a catalog of training courses (name, provider, website, summary,
-- attached materials) once, then pick a course when logging a completion — richer
-- than the old free-text course_name, and available for future packet inclusion
-- as §10.35 competence evidence. Attachments (docs / course materials) live in a
-- private Supabase Storage bucket (`course-materials`, created out-of-band); this
-- table holds only the metadata + storage path.

create table if not exists course (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  created_by uuid not null default auth.uid() references app_user(id),
  name text not null,
  provider text,
  website text,
  summary text,                       -- notes / content summary
  created_at timestamptz not null default now(),
  unique (id, firm_id)                -- referenced by composite FKs (tenant-consistent)
);
create index if not exists course_firm_idx on course(firm_id, created_at desc);
alter table course enable row level security;

drop policy if exists course_sel on course;
drop policy if exists course_ins on course;
drop policy if exists course_upd on course;
drop policy if exists course_del on course;
create policy course_sel on course for select using (firm_id = current_firm_id());
-- any firm member may add to the catalog; created_by is forced to the caller
create policy course_ins on course for insert
  with check (firm_id = current_firm_id() and created_by = auth.uid());
-- edit / delete: creator or admin (mirrors policy/tool ownership posture)
create policy course_upd on course for update
  using (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'))
  with check (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'));
create policy course_del on course for delete
  using (firm_id = current_firm_id() and (created_by = auth.uid() or current_user_role() = 'admin'));

-- ── attachments (metadata for files in the private storage bucket) ──────────
create table if not exists course_attachment (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  course_id uuid not null,
  uploaded_by uuid not null default auth.uid() references app_user(id),
  file_name text not null,
  storage_path text not null unique,  -- '<firm_id>/<course_id>/<uuid>__<name>'
  mime_type text,
  byte_size bigint,
  created_at timestamptz not null default now(),
  constraint course_attachment_course_fk foreign key (course_id, firm_id)
    references course(id, firm_id) on delete cascade
);
create index if not exists course_attachment_course_idx on course_attachment(course_id);
alter table course_attachment enable row level security;

drop policy if exists course_attachment_sel on course_attachment;
drop policy if exists course_attachment_ins on course_attachment;
drop policy if exists course_attachment_del on course_attachment;
create policy course_attachment_sel on course_attachment for select
  using (firm_id = current_firm_id());
create policy course_attachment_ins on course_attachment for insert
  with check (firm_id = current_firm_id() and uploaded_by = auth.uid());
create policy course_attachment_del on course_attachment for delete
  using (firm_id = current_firm_id() and (uploaded_by = auth.uid() or current_user_role() = 'admin'));

-- ── link a logged completion to a catalog course (optional) ─────────────────
-- Nullable so the old free-text course_name path still works; on delete set null
-- so removing a course doesn't erase the completion history (course_name remains).
alter table training_record
  add column if not exists course_id uuid;
-- composite FK for tenant-consistency; SET NULL scoped to course_id only (PG15+)
-- so deleting a course keeps the completion row (firm_id stays NOT NULL).
do $$ begin
  alter table training_record add constraint training_record_course_fk
    foreign key (course_id, firm_id) references course(id, firm_id) on delete set null (course_id);
exception when duplicate_object then null; end $$;
