-- AI Compliance — 0005: add first/last name to lead (policy-generator funnel captures name).
-- lead already has anon-INSERT-only RLS (0004): firm_id-exempt public table, no anon SELECT.
-- New columns are nullable so the existing landing-checkout insert path keeps working.

alter table lead add column if not exists first_name text;
alter table lead add column if not exists last_name  text;

-- The anon insert policy (0004: `lead_insert ... with check (true)`) already covers these
-- columns — no policy change needed. Leads are read only via the service role.
comment on table lead is 'Public lead capture (anon INSERT only, no anon SELECT). source tags origin: landing-checkout:<plan>, policy_gen.';
