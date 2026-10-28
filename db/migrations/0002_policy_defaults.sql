-- AI Compliance — 0002: let a logged-in browser client insert a policy under RLS without
-- knowing its own firm_id. Defaults resolve from the caller's auth session, and the
-- RLS with-check (firm_id = current_firm_id()) still holds.
-- (Server-side jobs using the secret key pass firm_id explicitly; defaults are null
--  there because auth.uid() is null, so those inserts are unaffected.)

alter table policy alter column firm_id set default current_firm_id();
alter table policy alter column created_by set default auth.uid();
