#!/usr/bin/env node
// AI Compliance — run a .sql file against the configured database (same env as migrate.mjs).
// Used by CI to apply scripts/ci/auth-shim.sql before replaying migrations.
// Usage: node scripts/run-sql.mjs <path-to-sql-file>

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
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/run-sql.mjs <file.sql>'); process.exit(1); }
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
await client.connect();
await client.query(readFileSync(path.resolve(file), 'utf8'));
await client.end();
console.log(`applied ${file}`);
