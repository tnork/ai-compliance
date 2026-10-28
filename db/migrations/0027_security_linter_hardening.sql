-- 0027: Supabase security-linter hardening (all WARN-level advisories).
--
-- (1) function_search_path_mutable — pin search_path on OUR 3 functions that
--     lacked it. The other ~45 flagged functions are citext extension functions
--     (trusted, extension-owned) and stay as-is: citext must remain in `public`
--     because app_user/contact_message `email` columns use the citext TYPE, so
--     moving the extension would break them (that's also why extension_in_public
--     for citext is accepted, not fixed).
--
-- (2) anon_security_definer_function_executable — revoke anon EXECUTE on the
--     RLS-helper SECURITY DEFINER functions. They are used ONLY inside RLS
--     policy expressions (never called as RPCs by the app), and no anon-facing
--     policy references them (the public-capture tables use with check(true)),
--     so anon never needs them. `authenticated` KEEPS execute — RLS policy
--     evaluation invokes these as the querying role, so revoking authenticated
--     would break RLS.
--
-- Accepted-as-intentional (deliberately NOT changed):
--   • rls_policy_always_true on lead / contact_message / policy_gen_snapshot —
--     the sanctioned anon-insert public-capture funnel (INSERT-only, no SELECT,
--     bounded by table CHECK constraints).
--   • authenticated_security_definer on the RPCs (log_ai_event, ingest_*,
--     generate_defense_packet, review_captured_event, save_policy_version,
--     set_retain_raw_captures, admin_set_member) and the RLS helpers — that IS
--     how the app invokes them; each forces attribution via auth.uid() or
--     returns only the caller's own attributes.

-- (1) pin search_path (dynamic so the long arg signatures don't have to be typed)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('ai_event_canonical_v2', 'ai_event_canonical_v3', 'ai_event_immutable')
  loop
    execute format('alter function %s set search_path = public', r.sig);
  end loop;
end $$;

-- (2) restrict the RLS-helper SECURITY DEFINER functions to `authenticated`.
--     Two grant paths must both be removed:
--       (a) Postgres grants EXECUTE to PUBLIC by default; and
--       (b) Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE DIRECTLY to
--           anon/authenticated/service_role on every new function in `public`
--           (visible in proacl as `anon=X/postgres`).
--     So `revoke from public` alone is a NO-OP on Supabase (the direct anon grant
--     survives). Revoke from BOTH `anon, public`, then re-grant `authenticated`
--     (RLS evaluation invokes these as the querying role, so authenticated MUST
--     keep execute). Include current_user_is_developer — on prod its 0026 revoke
--     also missed the direct anon grant.
revoke execute on function current_firm_id() from anon, public;
grant execute on function current_firm_id() to authenticated;
revoke execute on function current_user_role() from anon, public;
grant execute on function current_user_role() to authenticated;
revoke execute on function current_user_can_review() from anon, public;
grant execute on function current_user_can_review() to authenticated;
revoke execute on function current_user_can_view_logs() from anon, public;
grant execute on function current_user_can_view_logs() to authenticated;
revoke execute on function current_user_is_developer() from anon, public;
grant execute on function current_user_is_developer() to authenticated;

-- rls_auto_enable is a Supabase-platform helper (not created by our migrations);
-- remove anon/PUBLIC EXECUTE where present (event-trigger fns don't need API
-- grants; harmless no-op on CI, which lacks it).
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    execute 'revoke execute on function public.rls_auto_enable() from anon, public';
  end if;
end $$;
