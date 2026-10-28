#!/usr/bin/env node
// AI Compliance — RLS enforcement check.
// FAILS (exit 1) if any table in schema `public` violates the tenant-isolation rules:
//   • RLS disabled on any table
//   • firm-scoped table missing a NOT NULL firm_id column
//   • firm-scoped table missing a SELECT policy that references firm_id/current_firm_id()
//   • any policy on a firm-scoped table whose qual/with_check does NOT reference the tenant key
//   • exempt tables violating their declared shape (see EXEMPT below)
//
// Runs against any Postgres: CI (vanilla postgres + scripts/ci/auth-shim.sql + migrations)
// or a live Supabase project (same env vars as scripts/migrate.mjs).
//
// Usage: node scripts/check-rls.mjs
// Env:   SUPABASE_URL + SUPABASE_DB_PASSWORD (+ SUPABASE_DB_HOST/_USER/_PORT pooler
//        overrides, SUPABASE_DB_SSL=disable for plain-TCP CI postgres)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function env() {
  const e = {};
  try { for (const l of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } } catch {}
  return { ...e, ...process.env };
}
const E = env();
if (!E.SUPABASE_URL || !E.SUPABASE_DB_PASSWORD) {
  console.error('Missing SUPABASE_URL / SUPABASE_DB_PASSWORD'); process.exit(1);
}
const ref = new URL(E.SUPABASE_URL).hostname.split('.')[0];
const ssl = E.SUPABASE_DB_SSL === 'disable' ? false
  : E.SUPABASE_CA_CERT ? { ca: readFileSync(E.SUPABASE_CA_CERT, 'utf8'), rejectUnauthorized: true }
  : { rejectUnauthorized: false };
const client = new pg.Client({
  host: E.SUPABASE_DB_HOST || `db.${ref}.supabase.co`,
  port: Number(E.SUPABASE_DB_PORT || 5432),
  user: E.SUPABASE_DB_USER || 'postgres',
  database: 'postgres', password: E.SUPABASE_DB_PASSWORD, ssl,
});

// Every table NOT listed here must be firm-scoped: NOT NULL firm_id + tenant policies.
// Adding a table to this list is a security decision — justify it in the same PR.
const EXEMPT = {
  firm:              'tenant-root',     // the tenant itself; policies key on id = current_firm_id()
  schema_migrations: 'tooling',         // migrate.mjs bookkeeping; RLS on, zero policies = deny-all
  lead:              'public-capture',  // landing funnel; anon INSERT-only, no reads via API roles
  contact_message:   'public-capture',  // contact form; anon INSERT-only, no reads via API roles
  policy_gen_snapshot: 'public-capture', // free-generator selections; anon INSERT-only, import is service-side
  standard:          'global-content',  // Phase 4 Standard-Mappings: read-only reference data
  standard_clause:   'global-content',
  evidence_requirement: 'global-content',
};
const TENANT_KEY = /firm_id|current_firm_id/;

await client.connect();
const tables = (await client.query(
  `select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename`)).rows;
const policies = (await client.query(
  `select tablename, policyname, cmd, coalesce(qual,'') as qual, coalesce(with_check,'') as with_check
     from pg_policies where schemaname='public'`)).rows;
const firmIdCols = (await client.query(
  `select table_name, is_nullable from information_schema.columns
    where table_schema='public' and column_name='firm_id'`)).rows;
// views/matviews bypass table RLS when owner-executed (Codex P2): require
// security_invoker on views; matviews have no such option — exempt or fail.
const views = (await client.query(
  `select c.relname, c.relkind, coalesce(c.reloptions, '{}') as opts
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v','m')`)).rows;
await client.end();

const polsFor = t => policies.filter(p => p.tablename === t);
const failures = [];
const fail = (t, msg) => failures.push(`✗ ${t}: ${msg}`);

for (const { tablename: t, rowsecurity } of tables) {
  if (!rowsecurity) { fail(t, 'RLS is DISABLED — every public table must have RLS enabled'); continue; }
  const pols = polsFor(t);
  const kind = EXEMPT[t] ?? 'firm-scoped';

  if (kind === 'tooling') {
    if (pols.length) fail(t, `tooling table must be deny-all (no policies); found ${pols.length}`);
  } else if (kind === 'public-capture') {
    for (const p of pols.filter(p => p.cmd !== 'INSERT'))
      fail(t, `public-capture table must be INSERT-only; found ${p.cmd} policy "${p.policyname}"`);
    if (!pols.some(p => p.cmd === 'INSERT')) fail(t, 'public-capture table has no INSERT policy');
  } else if (kind === 'global-content') {
    for (const p of pols.filter(p => p.cmd !== 'SELECT'))
      fail(t, `global-content table must be read-only (SELECT policies only); found ${p.cmd} "${p.policyname}"`);
    if (!pols.some(p => p.cmd === 'SELECT')) fail(t, 'global-content table has no SELECT policy');
  } else if (kind === 'tenant-root') {
    if (!pols.some(p => p.cmd === 'SELECT' && TENANT_KEY.test(p.qual)))
      fail(t, 'tenant-root table needs a SELECT policy keyed on current_firm_id()');
    for (const p of pols)
      if (!TENANT_KEY.test(p.qual + p.with_check))
        fail(t, `policy "${p.policyname}" (${p.cmd}) does not reference the tenant key`);
  } else { // firm-scoped (the default for anything new)
    const col = firmIdCols.find(c => c.table_name === t);
    if (!col) { fail(t, 'missing firm_id column (or add the table to EXEMPT with a justification)'); continue; }
    if (col.is_nullable === 'YES') fail(t, 'firm_id must be NOT NULL');
    if (!pols.some(p => p.cmd === 'SELECT' && TENANT_KEY.test(p.qual)))
      fail(t, 'no SELECT policy referencing firm_id/current_firm_id()');
    for (const p of pols)
      if (!TENANT_KEY.test(p.qual + p.with_check))
        fail(t, `policy "${p.policyname}" (${p.cmd}) does not reference firm_id — cross-tenant leak risk`);
  }
}

const VIEW_EXEMPT = {}; // name → justification; a view listed here was reviewed for tenant safety
for (const v of views) {
  if (VIEW_EXEMPT[v.relname]) continue;
  if (v.relkind === 'm') fail(v.relname, 'materialized view over public schema — matviews bypass RLS; exempt with justification or move out of API-exposed schema');
  else if (!v.opts.some(o => o.replace(/\s/g, '') === 'security_invoker=true' || o.replace(/\s/g, '') === 'security_invoker=on'))
    fail(v.relname, 'view without security_invoker=true — owner-executed views bypass table RLS');
}

console.log(`checked ${tables.length} public tables, ${policies.length} policies, ${views.length} views`);
if (failures.length) {
  console.error(`\nRLS ENFORCEMENT FAILED (${failures.length}):`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('✓ RLS enforcement passed — all tables isolated per tenant rules.');
