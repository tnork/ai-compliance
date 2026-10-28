#!/usr/bin/env node
// AI Compliance — save a generated policy to Supabase (server-side; uses the SECRET key).
// The secret key BYPASSES RLS and must never reach the browser — this runs on your machine only.
//
// Usage:
//   node scripts/save-policy.mjs <policy.json>     # save a policy exported from the generator
//   node scripts/save-policy.mjs --list            # list saved policies
//
// The generator's "Save policy" button downloads the <policy.json> this ingests.

import { readFileSync } from 'node:fs';

// --- tiny .env reader (no deps) ---
function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* .env optional if vars already in process.env */ }
  return { ...env, ...process.env };
}
const E = loadEnv();
const URL_BASE = E.SUPABASE_URL, SECRET = E.SUPABASE_SECRET_KEY;
if (!URL_BASE || !SECRET) { console.error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY in .env'); process.exit(1); }

const H = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' };

async function rest(path, init = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const body = await r.text();
  if (!r.ok) throw new Error(`REST ${r.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function adminUser() {
  const username = E.ADMIN_USERNAME || 'admin';
  const rows = await rest(`app_user?username=eq.${encodeURIComponent(username)}&select=id,firm_id&limit=1`);
  if (!rows?.length) throw new Error(`admin app_user (username=${username}) not found — see README "Bootstrap the first admin"`);
  return rows[0];
}

const arg = process.argv[2];

if (arg === '--list') {
  const rows = await rest('policy?select=id,title,status,created_at&order=created_at.desc');
  if (!rows.length) { console.log('No policies saved yet.'); process.exit(0); }
  for (const p of rows) console.log(`${p.created_at}  ${p.status.padEnd(8)}  ${p.id}  ${p.title || ''}`);
  process.exit(0);
}

if (!arg) { console.error('Usage: node scripts/save-policy.mjs <policy.json> | --list'); process.exit(1); }

const doc = JSON.parse(readFileSync(arg, 'utf8'));
const me = await adminUser();
const [saved] = await rest('policy', {
  method: 'POST',
  headers: { Prefer: 'return=representation' },
  body: JSON.stringify({
    firm_id: me.firm_id,
    created_by: me.id,
    title: doc.title || null,
    inputs: doc.inputs || {},
    draft_html: doc.draft_html || null,
    status: 'draft'
  })
});
console.log('Saved policy:', saved.id);
console.log('  title:', saved.title);
console.log('  personal-AI stance:', (saved.inputs || {}).personal_ai_stance);
