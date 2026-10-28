-- AI Compliance — 0003: harden policy attribution (codex review, High).
-- Before: insert RLS only checked firm_id, and created_by was nullable — a client
-- could insert with created_by = null or another user's UUID within the firm.
-- After: created_by is required and RLS forces it to equal the caller (auth.uid()).
-- (Server-side secret-key jobs bypass RLS and still set created_by explicitly.)

alter table policy alter column created_by set not null;

drop policy if exists policy_ins on policy;
create policy policy_ins on policy for insert
  with check (firm_id = current_firm_id() and created_by = auth.uid());

drop policy if exists policy_upd on policy;
create policy policy_upd on policy for update
  using (firm_id = current_firm_id())
  with check (firm_id = current_firm_id() and created_by = auth.uid());
