-- ── Phase 4 spine: Standard-Mappings content tables + defense packet ────────
-- Appendix B.4: the crosswalk is DATA, not code — a new profession is a
-- content pack, not a rebuild. Evaluation is deliberately NOT a DSL yet:
-- the 6 Circular 230 clause evaluators are plain functions in
-- web/lib/coverage.ts keyed by clause_code (build philosophy: extract a DSL
-- only when the SECOND content pack arrives). satisfied_by jsonb is stored
-- as authoring data / future DSL input, not executed.
--
-- ALL seeded clause text is DRAFT — advisor sign-off gates removing the
-- [DRAFT] marker (hard constraint #2: no unverified regulatory claims).

-- ***** GLOBAL CONTENT (read-only-public; the firm_id exemption trio) *****
-- These are the only tables without firm_id: shared reference content.
-- RLS stays ON with a read-only policy (deny all writes via API roles).
create table if not exists standard (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,            -- 'circular_230', later 'aba_512', ...
  name text not null, profession text not null, jurisdiction text,
  version text, effective_at date,
  created_at timestamptz not null default now()
);
comment on table standard is 'Global content: read-only-public via RLS; no firm_id by design (check-rls EXEMPT global-content)';

create table if not exists standard_clause (
  id uuid primary key default gen_random_uuid(),
  standard_id uuid not null references standard(id),
  clause_code text not null,            -- '§10.36'
  title text not null,
  requirement text,                     -- short summary; DRAFT until advisor sign-off
  sort int not null default 0,
  unique (standard_id, clause_code)
);
comment on table standard_clause is 'Global content: read-only-public via RLS; no firm_id by design';

create table if not exists evidence_requirement (
  id uuid primary key default gen_random_uuid(),
  clause_id uuid not null references standard_clause(id),
  description text not null,
  satisfied_by jsonb,                   -- authoring data; evaluated by code, not a DSL engine
  packet_section text, severity text not null default 'required'  -- 'required' | 'recommended'
);
comment on table evidence_requirement is 'Global content: read-only-public via RLS; no firm_id by design';

alter table standard enable row level security;
alter table standard_clause enable row level security;
alter table evidence_requirement enable row level security;
drop policy if exists standard_sel on standard;
drop policy if exists standard_clause_sel on standard_clause;
drop policy if exists evidence_requirement_sel on evidence_requirement;
create policy standard_sel on standard for select to authenticated using (true);
create policy standard_clause_sel on standard_clause for select to authenticated using (true);
create policy evidence_requirement_sel on evidence_requirement for select to authenticated using (true);
-- no insert/update/delete policies: content ships via migrations only.

-- ***** DEFENSE PACKET (firm-scoped) *****
create table if not exists defense_packet (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id),
  scope text not null default 'firm',   -- 'firm' | 'client' | 'matter' | 'period'
  scope_ref text,
  standard_id uuid references standard(id),
  generated_at timestamptz not null default now(),
  generated_by uuid references app_user(id),
  event_ids uuid[] not null default '{}',
  chain_head text,                      -- chain head hash at generation time
  coverage_summary jsonb,               -- per-clause satisfied/gap rollup
  pdf_uri text,                         -- later: WORM-stored export
  packet_hash text not null
);
create index if not exists defense_packet_firm on defense_packet(firm_id, generated_at);

alter table defense_packet enable row level security;
drop policy if exists defense_packet_sel on defense_packet;
drop policy if exists defense_packet_ins on defense_packet;
create policy defense_packet_sel on defense_packet for select using (firm_id = current_firm_id());
create policy defense_packet_ins on defense_packet for insert with check (
  firm_id = current_firm_id()
  and (generated_by is null or generated_by in (select id from app_user where firm_id = current_firm_id()))
);
-- no update/delete: a generated packet is a point-in-time evidentiary export.

-- ***** SEED: Circular 230 content pack (ALL DRAFT) *****
with s as (
  insert into standard (code, name, profession, jurisdiction, version)
  values ('circular_230', 'Treasury Circular 230 (AI supervision crosswalk)', 'tax', 'US-federal', 'DRAFT-2026-OPR-2026-19')
  on conflict (code) do update set version = excluded.version
  returning id
),
c as (
  insert into standard_clause (standard_id, clause_code, title, requirement, sort)
  select s.id, v.code, v.title, '[DRAFT — pending advisor review] ' || v.req, v.sort
  from s, (values
    ('§10.36', 'Procedures to ensure compliance', 'The firm maintains written procedures governing AI use and staff have acknowledged them.', 1),
    ('§10.22', 'Diligence as to accuracy', 'A practitioner exercised due diligence — a human reviewed and verified AI output before reliance.', 2),
    ('§10.35', 'Competence', 'Personnel using AI are competent to do so, evidenced by completed, current training.', 3),
    ('§10.37', 'Requirements for written advice', 'Written advice rests on reasonable factual and legal assumptions the reviewer confirmed.', 4),
    ('WISP',   'Data safeguarding (GLBA / FTC Safeguards)', 'Client data goes only into vetted tools; PII only into tools approved for it.', 5),
    ('§10.27', 'Fees', 'Where relevant, AI assistance is reflected appropriately in engagement/fee practices.', 6)
  ) as v(code, title, req, sort)
  on conflict (standard_id, clause_code) do nothing
  returning id, clause_code
)
insert into evidence_requirement (clause_id, description, satisfied_by, packet_section, severity)
select c.id, v.descr, v.rule::jsonb, v.section, v.sev
from c join (values
  ('§10.36', 'Firm has an adopted AI-use policy and the AI user acknowledged it',
   '{"all":["firm.policy.adopted","attestation.exists(event.user_id, policy)"]}', 'Firm Procedures', 'required'),
  ('§10.22', 'A human reviewed the AI output, verified accuracy, and recorded what was checked',
   '{"all":["event.reviewed==true","event.verified_accurate==true","event.verification_notes!=''''"]}', 'Human Review', 'required'),
  ('§10.35', 'The reviewer holds completed, unexpired AI-competence training',
   '{"all":["training_record.valid(event.reviewer_id)"]}', 'Competence', 'required'),
  ('§10.37', 'Written advice: assumptions documented and confirmed by the reviewer',
   '{"if":"event.data_kind==''written_advice''","then":{"all":["event.assumptions_ref!=null","event.reviewer_confirmed_assumptions==true"]}}', 'Written Advice', 'required'),
  ('WISP', 'The tool is on the approved register; if PII was included, the tool is PII-approved',
   '{"all":["tool_register.approved(event.tool)",{"if":"event.pii_included==true","then":"tool_register.approved_for_pii(event.tool)"}]}', 'Data Handling', 'required'),
  ('§10.27', 'AI assistance noted in engagement/fee practices where relevant',
   '{"any":["event.fee_note!=null","true"]}', 'Fees', 'recommended')
) as v(code, descr, rule, section, sev) on c.clause_code = v.code
on conflict do nothing;
