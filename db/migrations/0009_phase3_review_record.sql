-- ── Phase 3: the review-record core (AI Compliance.md Appendix B) ─────────────────
-- ai_event = the canonical record that a human supervised an AI work product.
-- artifact = content pointers (hash always; encrypted blob only when the firm
-- opts into raw retention — metadata-only operation must always work).
-- Tamper-evidence: per-firm append-only hash chain (B.3); rows are IMMUTABLE —
-- corrections are new events, never updates.

-- enums per Appendix B (create type has no IF NOT EXISTS)
do $$ begin
  if not exists (select 1 from pg_type where typname = 'source_t') then
    create type source_t as enum ('in_app','extension','desktop_agent','openai_api','purview','manual');
  end if;
  if not exists (select 1 from pg_type where typname = 'sens_t') then
    create type sens_t as enum ('none','pii','phi','privileged');
  end if;
end $$;

-- ***** THE REVIEW-RECORD *****
create table if not exists ai_event (
  id uuid primary key default gen_random_uuid(),
  -- no ON DELETE CASCADE: records carry 7-year retention; deleting a firm's
  -- events is a deliberate retention operation, never a side effect
  firm_id uuid not null default current_firm_id() references firm(id),
  user_id uuid not null references app_user(id),      -- who used the AI
  source source_t not null default 'in_app',
  tool text not null, model text,
  client_ref text, matter_ref text,                   -- engagement / client / matter
  occurred_at timestamptz not null,
  data_kind text,                                     -- 'return_prep','written_advice','research',...
  data_sensitivity sens_t not null default 'none',
  pii_included boolean not null default false,
  -- content pointers (artifact rows; hash retained even when content isn't):
  prompt_ref uuid, output_ref uuid,
  -- supervision / review:
  reviewed boolean not null default false,
  reviewer_id uuid references app_user(id),
  reviewed_at timestamptz,
  verification_notes text,                            -- what the reviewer checked
  edited boolean, verified_accurate boolean,
  assumptions_ref text,                               -- written advice (§10.37)
  reviewer_confirmed_assumptions boolean,
  approval_signature text,
  standard_tags text[] not null default '{}',
  -- tamper-evidence (per-firm append-only chain, B.3):
  prev_hash text, record_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_event_firm_occurred on ai_event(firm_id, occurred_at);
create index if not exists ai_event_firm_client   on ai_event(firm_id, client_ref);
create index if not exists ai_event_firm_reviewed on ai_event(firm_id, reviewed);
-- chain integrity at the DB level: exactly one genesis and no forked links per firm.
-- Concurrent inserts racing for the same prev_hash violate these and must retry.
create unique index if not exists ai_event_chain_genesis on ai_event(firm_id) where prev_hash is null;
create unique index if not exists ai_event_chain_link    on ai_event(firm_id, prev_hash) where prev_hash is not null;

alter table ai_event enable row level security;
drop policy if exists ai_event_sel on ai_event;
drop policy if exists ai_event_ins on ai_event;
create policy ai_event_sel on ai_event for select using (firm_id = current_firm_id());
-- insert: firm-scoped, and both the AI user and reviewer must be members of the firm.
-- NO update/delete policies: append-only for all API roles (fail closed).
create policy ai_event_ins on ai_event for insert with check (
  firm_id = current_firm_id()
  and user_id in (select id from app_user where firm_id = current_firm_id())
  and (reviewer_id is null
       or reviewer_id in (select id from app_user where firm_id = current_firm_id()))
);

-- belt-and-suspenders immutability: blocks UPDATE/DELETE even via service role.
-- (Retention-driven deletion is a deliberate op that drops this trigger first.)
create or replace function ai_event_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'ai_event is append-only — corrections are new events (Appendix B.3)';
end $$;
drop trigger if exists ai_event_no_mutate on ai_event;
create trigger ai_event_no_mutate
  before update or delete on ai_event
  for each row execute function ai_event_immutable();

-- ***** CONTENT POINTERS *****
create table if not exists artifact (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id),
  ai_event_id uuid references ai_event(id),
  kind text not null,                 -- 'prompt' | 'output' | 'attachment'
  storage_uri text,                   -- null = metadata-only (data-minimization default);
                                      -- set only when the firm opts into raw retention (R2, SSE-KMS + WORM)
  sha256 text not null, byte_size bigint,
  retained_until date,
  created_at timestamptz not null default now()
);
create index if not exists artifact_firm_event on artifact(firm_id, ai_event_id);

alter table artifact enable row level security;
drop policy if exists artifact_sel on artifact;
drop policy if exists artifact_ins on artifact;
create policy artifact_sel on artifact for select using (firm_id = current_firm_id());
create policy artifact_ins on artifact for insert with check (firm_id = current_firm_id());
-- no update/delete policies: artifacts are write-once via the API (WORM posture).
