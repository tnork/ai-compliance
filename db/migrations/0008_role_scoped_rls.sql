-- AI Compliance — 0008: role-scoped RLS (review findings F3 + F7).
-- Prior state: the four Phase-2 tenant tables and `policy` were tenant-scoped only,
-- so any firm user could delete the firm's tool register / training log (F3), and
-- only a policy's original creator could update it — blocking admin adoption (F7).
-- This migration adds a role helper and tightens/relaxes the affected policies.
-- Apply with: node scripts/migrate.mjs

-- Resolve the caller's role from their app_user row. SECURITY DEFINER so the lookup
-- isn't blocked by app_user's own RLS (mirrors current_firm_id()).
create or replace function current_user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from app_user where id = auth.uid()
$$;

-- ── F3: firm register writes are admin-only ────────────────────────
-- tool_register + training_record: any firm member may still read (select) and add
-- (insert) rows, but UPDATE/DELETE of the firm's register is restricted to admins.
do $$
declare t text;
begin
  foreach t in array array['tool_register','training_record'] loop
    execute format('drop policy if exists %I_upd on %I', t, t);
    execute format('drop policy if exists %I_del on %I', t, t);
    execute format(
      'create policy %I_upd on %I for update using (firm_id = current_firm_id() and current_user_role() = ''admin'') with check (firm_id = current_firm_id())',
      t, t);
    execute format(
      'create policy %I_del on %I for delete using (firm_id = current_firm_id() and current_user_role() = ''admin'')',
      t, t);
  end loop;
end $$;

-- ── F7: firm admins can adopt/edit any of the firm's policies ───────
-- Was: update allowed only when created_by = auth.uid() (creator-only).
-- Now: the creator OR a firm admin may update, still scoped to the firm.
drop policy if exists policy_upd on policy;
create policy policy_upd on policy for update
  using (firm_id = current_firm_id())
  with check (
    firm_id = current_firm_id()
    and (created_by = auth.uid() or current_user_role() = 'admin')
  );
