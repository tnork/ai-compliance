#!/usr/bin/env node
// CI-ONLY behavioral RLS test (Codex P1: static policy-text checks can pass
// non-isolating policies). Creates two tenant fixtures and PROVES isolation by
// running real queries as `authenticated` with each user's JWT sub, via the
// auth-shim's GUC-based auth.uid(). Never run against a real Supabase project.
//
// Asserts: cross-tenant SELECT sees nothing; INSERT into another firm is
// rejected; ai_event direct INSERT is denied (RPC-only); log_ai_event forces
// attribution, chains correctly, and writes artifacts atomically.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function env() {
  const e = {};
  try { for (const l of readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) e[m[1]] = m[2]; } } catch {}
  return { ...e, ...process.env };
}
const E = env();
if (E.SUPABASE_DB_SSL !== 'disable') {
  console.error('refusing to run: this test creates fixtures and must only run on the CI postgres (SUPABASE_DB_SSL=disable)');
  process.exit(1);
}
const client = new pg.Client({
  host: E.SUPABASE_DB_HOST || 'localhost', port: Number(E.SUPABASE_DB_PORT || 5432),
  user: E.SUPABASE_DB_USER || 'postgres', database: 'postgres',
  password: E.SUPABASE_DB_PASSWORD, ssl: false,
});
await client.connect();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗ FAIL'} ${name}${extra ? ' — ' + extra : ''}`) };

// Supabase grants API roles table access by default; the CI shim doesn't.
await client.query(`grant usage on schema public to anon, authenticated;
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;`);

// fixtures (as superuser — bypasses RLS)
const [uA, uB] = ['aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-00000000000b'];
await client.query(`insert into auth.users (id) values ($1), ($2) on conflict do nothing`, [uA, uB]);
const firms = (await client.query(
  `insert into firm (name, profession) values ('Firm A','tax'), ('Firm B','tax') returning id`)).rows;
const [fA, fB] = [firms[0].id, firms[1].id];
await client.query(
  `insert into app_user (id, firm_id, username, email, role) values
   ($1, $3, 'usera', 'a@test', 'admin'), ($2, $4, 'userb', 'b@test', 'admin')`, [uA, uB, fA, fB]);

// run fn as `authenticated` with a given auth.uid(); committed so later
// assertions can see writes, but each block resets role.
async function as(uid, fn) {
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
  await client.query('set local role authenticated');
  try { return await fn(); } finally { await client.query('commit'); }
}
const q = (sql, params) => client.query(sql, params);
// expected-denial probe: savepoint-wrapped so the failed statement doesn't
// abort the enclosing transaction ("current transaction is aborted")
async function denied(sql, params) {
  await client.query('savepoint probe');
  try { await client.query(sql, params); await client.query('release savepoint probe'); return null; }
  catch (e) { await client.query('rollback to savepoint probe'); return e.code; }
}

// 1. cross-tenant SELECT isolation on every firm-scoped surface
await as(uA, async () => {
  const r = await q('select firm_id from app_user');
  ok('A sees only own-firm app_user rows', r.rows.length === 1 && r.rows[0].firm_id === fA);
  const f = await q('select id from firm');
  ok('A sees only own firm', f.rows.length === 1 && f.rows[0].id === fA);
});

// 2. writes cannot target another firm
await as(uA, async () => {
  const code = await denied(`insert into tool_register (firm_id, tool_name) values ($1, 'evil')`, [fB]);
  ok('A cannot insert into firm B (42501)', code === '42501', `code=${code}`);
  await q(`insert into tool_register (tool_name) values ('ChatGPT')`); // own firm, via default
});
await as(uB, async () => {
  const r = await q('select tool_name from tool_register');
  ok("B cannot see A's tool_register rows", r.rows.length === 0);
});

// 3. ai_event: direct insert denied (RPC-only), RPC forces attribution + chains
await as(uA, async () => {
  const code = await denied(`insert into ai_event (user_id, source, tool, occurred_at, record_hash)
             values ($1, 'manual', 'X', now(), 'forged')`, [uA]);
  ok('direct ai_event insert denied (RPC-only)', code === '42501', `code=${code}`);

  const e1 = await q(`select log_ai_event(p_tool => 'ChatGPT', p_verification_notes => 'checked figures',
    p_approval_signature => 'User A', p_prompt_sha256 => repeat('a',64), p_prompt_bytes => 10,
    p_output_sha256 => repeat('b',64), p_output_bytes => 20, p_verified_accurate => true) as id`);
  const e2 = await q(`select log_ai_event(p_tool => 'Claude', p_verification_notes => 'verified citations',
    p_approval_signature => 'User A') as id`);
  // NOTE: both appends share this transaction, so created_at (= now(), pinned
  // at txn start) TIES — assert by the returned ids, never by timestamp order.
  const chain = await q(`select id, user_id, reviewer_id, firm_id, prev_hash, record_hash from ai_event`);
  const r1 = chain.rows.find(r => r.id === e1.rows[0].id);
  const r2 = chain.rows.find(r => r.id === e2.rows[0].id);
  ok('RPC created 2 events', chain.rows.length === 2 && !!r1 && !!r2);
  ok('attribution forced to caller + own firm', chain.rows.every(r => r.user_id === uA && r.reviewer_id === uA && r.firm_id === fA));
  ok('chain links (genesis null → e1 hash)', r1.prev_hash === null && r2.prev_hash === r1.record_hash,
    `e1.prev=${r1?.prev_hash} e2.prev=${r2?.prev_hash?.slice(0, 12)}`);
  const arts = await q(`select kind from artifact where ai_event_id = $1 order by kind`, [r1.id]);
  ok('artifacts written atomically with event', arts.rows.map(r => r.kind).join(',') === 'output,prompt');
});
await as(uB, async () => {
  const r = await q('select id from ai_event');
  ok("B cannot see A's ai_event rows", r.rows.length === 0);
  const a = await q('select id from artifact');
  ok("B cannot see A's artifacts", a.rows.length === 0);
});

// 4. server-side hash is honest: recompute via the canonical fn (as superuser)
const ev = (await client.query(`select * from ai_event where prev_hash is null`)).rows[0];
const arts = (await client.query(`select id, sha256 from artifact where ai_event_id = $1`, [ev.id])).rows;
const shaOf = id => arts.find(a => a.id === id)?.sha256 ?? null;
const recomputed = (await client.query(
  `select encode(digest(ai_event_canonical_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) || '', 'sha256'), 'hex') as h`,
  [ev.firm_id, ev.user_id, ev.tool, ev.model, ev.source, ev.occurred_at, ev.data_kind,
   ev.data_sensitivity, ev.pii_included, ev.client_ref, ev.matter_ref,
   shaOf(ev.prompt_ref), shaOf(ev.output_ref), ev.reviewed, ev.reviewer_id, ev.reviewed_at,
   ev.verification_notes, ev.edited, ev.verified_accurate, ev.assumptions_ref,
   ev.reviewer_confirmed_assumptions, ev.approval_signature, ev.reviews_event_id])).rows[0].h;
ok('stored record_hash matches recomputation', recomputed === ev.record_hash);

await client.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
