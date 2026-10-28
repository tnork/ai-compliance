-- ── 0030: WISP acknowledgement (per-member attestation) ──────────────────────
-- The AI-use policy is an ADDENDUM to the firm's Written Information Security
-- Plan (FTC Safeguards Rule / IRS Pub 5708). AI Compliance never generates or stores
-- the WISP itself - the firm gets one from Pub 5708, their attorney, or their
-- IT provider. This table records each member's acknowledgement that the WISP
-- exists and they have read it (Pub 5708's own employee-acknowledgment
-- practice), surfaced as an onboarding step + Key Action when the adopted
-- policy declares a WISP is in place (inputs->>'has_wisp' <> 'no'). When the
-- policy says the firm has no WISP yet, admins get an encouragement to put one
-- in place instead of an attest prompt.
--
-- One row per member per firm. Acknowledgements are immutable: no update or
-- delete policies (API roles fail closed), same posture as attestation.

create table if not exists wisp_attestation (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null default current_firm_id() references firm(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  attested_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (firm_id, user_id),
  -- tenant-consistent member ref (0019 pattern): the user must be in this firm
  foreign key (user_id, firm_id) references app_user(id, firm_id) on delete cascade
);
alter table wisp_attestation enable row level security;
create index if not exists wisp_attestation_firm_idx on wisp_attestation(firm_id);

-- Firm-scoped read (admins see who has acknowledged); self-only insert - a
-- member can only attest for themselves, never for a colleague.
create policy wisp_attestation_sel on wisp_attestation
  for select using (firm_id = current_firm_id());
create policy wisp_attestation_ins on wisp_attestation
  for insert with check (firm_id = current_firm_id() and user_id = auth.uid());

comment on table wisp_attestation is
  'Per-member acknowledgement that the firm''s WISP (FTC Safeguards Rule / Pub 5708) exists and they have read it. The AI-use policy is an addendum to the WISP; AI Compliance does not store the WISP document itself. Immutable - no update/delete policies.';
