-- AI Compliance — 0007: add work phone to lead (policy-generator funnel now captures phone).
-- lead already has anon-INSERT-only RLS (0004): firm_id-exempt public table, no anon SELECT.
-- Nullable so the existing landing-checkout insert path (email/firm only) keeps working.

alter table lead add column if not exists phone text;

-- The anon insert policy (0004: `lead_insert ... with check (true)`) already covers this
-- column — no policy change needed. Leads are read only via the service role.
