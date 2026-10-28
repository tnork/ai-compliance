#!/usr/bin/env node
// AI Compliance — migration runner. Connects to Supabase Postgres directly (IPv6) using
// SUPABASE_DB_PASSWORD from .env; applies db/migrations/*.sql in order, tracking
// applied ones in schema_migrations. Never hardcodes secrets.
//
// Usage:
//   node scripts/migrate.mjs               # apply all pending migrations
//   node scripts/migrate.mjs --status      # list applied vs pending
//   node scripts/migrate.mjs --mark 0001   # record a migration as applied WITHOUT running it (baseline)

import { readFileSync, readdirSync } from 'node:fs';
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
  console.error('Missing SUPABASE_URL / SUPABASE_DB_PASSWORD in .env'); process.exit(1);
}
const ref = new URL(E.SUPABASE_URL).hostname.split('.')[0];   // YOUR-PROJECT
// TLS: Supabase's direct connection uses a self-signed CA. Verify it when SUPABASE_CA_CERT
// points at a downloaded Supabase CA cert; otherwise connect encrypted-but-unverified (dev
// tooling only) with a clear warning. App runtime should always verify.
let ssl;
if (E.SUPABASE_DB_SSL === 'disable') ssl = false;   // CI-only: plain-TCP local postgres service
else if (E.SUPABASE_CA_CERT) ssl = { ca: readFileSync(E.SUPABASE_CA_CERT, 'utf8'), rejectUnauthorized: true };
else { console.warn('⚠  TLS cert not verified (dev). Set SUPABASE_CA_CERT to a Supabase CA cert to enable verification.'); ssl = { rejectUnauthorized: false }; }
// Default: direct connection (IPv6). On IPv4-only networks where `db.<ref>.supabase.co`
// won't resolve, use the pooler by setting these in .env (Supabase → Project → Database → Connection pooling):
//   SUPABASE_DB_HOST=aws-0-<region>.pooler.supabase.com
//   SUPABASE_DB_USER=postgres.<ref>
//   SUPABASE_DB_PORT=5432        # session mode (supports DDL/transactions)
const client = new pg.Client({
  host: E.SUPABASE_DB_HOST || `db.${ref}.supabase.co`,
  port: Number(E.SUPABASE_DB_PORT || 5432),
  user: E.SUPABASE_DB_USER || 'postgres',
  database: 'postgres', password: E.SUPABASE_DB_PASSWORD, ssl
});

const migDir = path.join(ROOT, 'db', 'migrations');
const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
const name = f => f.replace(/\.sql$/, '');

await client.connect();
await client.query('create table if not exists schema_migrations (id text primary key, applied_at timestamptz default now())');
// Tooling table, not firm data: enable RLS (deny-all to API roles; the owner/postgres role
// used here bypasses RLS) and revoke API-role grants so it isn't exposed via PostgREST.
await client.query('alter table schema_migrations enable row level security');
await client.query('revoke all on schema_migrations from anon, authenticated');
const applied = new Set((await client.query('select id from schema_migrations')).rows.map(r => r.id));

const arg = process.argv[2], val = process.argv[3];

if (arg === '--status') {
  for (const f of files) console.log(`${applied.has(name(f)) ? '[applied]' : '[pending]'}  ${name(f)}`);
  await client.end(); process.exit(0);
}
if (arg === '--mark') {
  const id = files.map(name).find(n => n.startsWith(val));
  if (!id) { console.error(`no migration matching ${val}`); await client.end(); process.exit(1); }
  await client.query('insert into schema_migrations(id) values($1) on conflict do nothing', [id]);
  console.log(`marked applied (not executed): ${id}`);
  await client.end(); process.exit(0);
}

let ran = 0;
for (const f of files) {
  const id = name(f);
  if (applied.has(id)) continue;
  const sql = readFileSync(path.join(migDir, f), 'utf8');
  process.stdout.write(`applying ${id} ... `);
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('insert into schema_migrations(id) values($1)', [id]);
    await client.query('commit');
    console.log('ok'); ran++;
  } catch (e) { await client.query('rollback'); console.log('FAILED'); console.error(e.message); await client.end(); process.exit(1); }
}
console.log(ran ? `\napplied ${ran} migration(s).` : 'nothing to apply — up to date.');
await client.end();
