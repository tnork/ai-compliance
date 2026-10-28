import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256 } from '@/lib/hashchain'
import { sealSecret } from './crypto'
import type { NormalizedEvent } from './types'

export type IngestOutcome = { inserted: number; duplicate: number; unmatched: string[]; errors: string[]; accepted: string[] }

const sealText = (text?: string | null) => {
  if (!text) return { ct: null as string | null, iv: null as string | null, tag: null as string | null }
  const s = sealSecret(text)
  return { ct: s.ciphertext, iv: s.iv, tag: s.tag }
}

// Build the batch payload row for one event. Metadata + content hashes always;
// the RAW prompt/output text is only sealed (AES-256-GCM) + carried when the firm
// opted into retention (retainRaw) - otherwise it's dropped here and only the
// hash is stored (data-minimization default). When text IS present its own hash
// is authoritative so retained content verifies against the chain (decrypt ->
// sha256 -> compare); else the client's pre-hash is used.
function row(userId: string, ev: NormalizedEvent, retainRaw: boolean) {
  const pText = ev.promptText, oText = ev.outputText
  const p = retainRaw ? sealText(pText) : { ct: null, iv: null, tag: null }
  const o = retainRaw ? sealText(oText) : { ct: null, iv: null, tag: null }
  return {
    user_id: userId,
    external_id: ev.externalId,
    tool: ev.tool,
    model: ev.model ?? null,
    occurred_at: ev.occurredAt,
    client_ref: ev.clientRef ?? null,
    data_kind: ev.dataKind ?? null,
    prompt_sha256: pText ? sha256(pText) : (ev.promptSha256 ?? null),
    prompt_bytes: pText ? Buffer.byteLength(pText, 'utf8') : (ev.promptBytes ?? null),
    output_sha256: oText ? sha256(oText) : (ev.outputSha256 ?? null),
    output_bytes: oText ? Buffer.byteLength(oText, 'utf8') : (ev.outputBytes ?? null),
    prompt_ct: p.ct, prompt_iv: p.iv, prompt_tag: p.tag,
    output_ct: o.ct, output_iv: o.iv, output_tag: o.tag,
    surface: ev.surface ?? null,
    os: ev.os ?? null,
  }
}

// One batch RPC call → append the whole batch under a single per-firm lock in
// one transaction (CaptureArchitecture §8.5). Maps the per-event statuses back
// to the outcome shape; only inserted|duplicate are 'accepted' (safe for the
// client to drop), errors stay buffered for retry.
async function runBatch(admin: SupabaseClient, firmId: string, source: string, rows: ReturnType<typeof row>[]): Promise<IngestOutcome> {
  const out: IngestOutcome = { inserted: 0, duplicate: 0, unmatched: [], errors: [], accepted: [] }
  if (rows.length === 0) return out
  const { data, error } = await admin.rpc('ingest_ai_events_batch', { p_firm_id: firmId, p_source: source, p_events: rows })
  if (error) { out.errors.push('batch: ' + error.message); return out }
  for (const r of (data ?? []) as { external_id: string; status: string; reason?: string }[]) {
    if (r.status === 'inserted') { out.inserted++; out.accepted.push(r.external_id) }
    else if (r.status === 'duplicate') { out.duplicate++; out.accepted.push(r.external_id) }
    else out.errors.push(`${r.external_id}: ${r.reason ?? r.status}`)
  }
  return out
}

// Extension path: attribution is the ALREADY-AUTHENTICATED user id (resolved by
// the route from the session), never remapped through the non-unique email.
// retainRaw is the firm's CURRENT setting (re-checked server-side by the route).
// A usable dedup key: non-empty, not a stringified-undefined collapse
// ("undefined" / "undefined:undefined" from `String(r.id ?? r.uuid)`), bounded.
const validExternalId = (e: NormalizedEvent) =>
  !!e.externalId && e.externalId.length <= 200 && !e.externalId.toLowerCase().includes('undefined')

export async function ingestEventsForUser(
  admin: SupabaseClient, firmId: string, userId: string, events: NormalizedEvent[], source: string, retainRaw = false,
): Promise<IngestOutcome> {
  return runBatch(admin, firmId, source, events.filter(validExternalId).map((e) => row(userId, e, retainRaw)))
}

// Connector path: resolve each event's userEmail → app_user within the firm
// (case-insensitive), skip unknown users (reported, not attributed), then batch.
export async function ingestEvents(
  admin: SupabaseClient, firmId: string, events: NormalizedEvent[], source: string, retainRaw = false,
): Promise<IngestOutcome> {
  const empty: IngestOutcome = { inserted: 0, duplicate: 0, unmatched: [], errors: [], accepted: [] }
  if (events.length === 0) return empty
  const { data: users, error } = await admin.from('app_user').select('id, email').eq('firm_id', firmId)
  if (error) { empty.errors.push('user lookup: ' + error.message); return empty }
  const byEmail = new Map((users ?? []).map((u) => [(u.email ?? '').toLowerCase(), u.id]))

  const unmatched: string[] = []
  const rows: ReturnType<typeof row>[] = []
  for (const ev of events) {
    if (!validExternalId(ev)) continue // no stable id -> would collapse under one dedup key; drop
    const uid = byEmail.get(ev.userEmail.toLowerCase())
    if (!uid) { if (!unmatched.includes(ev.userEmail)) unmatched.push(ev.userEmail); continue }
    rows.push(row(uid, ev, retainRaw))
  }
  const out = await runBatch(admin, firmId, source, rows)
  out.unmatched = unmatched
  return out
}
