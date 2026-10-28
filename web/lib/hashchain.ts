import { createHash } from 'node:crypto'

// Tamper-evidence utilities (server-side only).
//
// As of migration 0010, record hashes are computed IN THE DATABASE by
// log_ai_event() → ai_event_canonical_v2(): the client never supplies
// prev_hash/record_hash (Codex P1: forgeable chain). This module is the
// VERIFICATION mirror - recomputeRecordHashV2 must produce byte-identical
// output to the SQL function. The key order and the 3-ms-digit UTC "Z"
// timestamps ARE the format; never reorder or reformat.

export const sha256 = (s: string) =>
  createHash('sha256').update(s, 'utf8').digest('hex')

export type CoreFieldsV2 = {
  firm_id: string
  user_id: string
  tool: string
  model: string | null
  source: string
  occurred_at: string            // ISO-8601 UTC, 3 ms digits (Date.toISOString)
  data_kind: string | null
  data_sensitivity: string
  pii_included: boolean
  client_ref: string | null
  matter_ref: string | null
  prompt_sha256: string | null
  output_sha256: string | null
  reviewed: boolean
  reviewer_id: string | null
  reviewed_at: string | null
  // null on captured (unreviewed) events; non-null on manual - canonical is null-safe either way
  verification_notes: string | null
  edited: boolean | null
  verified_accurate: boolean | null
  assumptions_ref: string | null
  reviewer_confirmed_assumptions: boolean | null
  approval_signature: string | null
  reviews_event_id: string | null   // null for usage events; the captured id on a review event (v3)
}

const isoMs = (ts: string | null) => (ts === null ? null : new Date(ts).toISOString())

// Mirrors ai_event_canonical_v3 (0018: v2 + reviews_event_id bound into the hash).
export function canonicalV2(c: CoreFieldsV2): string {
  return JSON.stringify({
    v: 3,
    firm_id: c.firm_id,
    user_id: c.user_id,
    tool: c.tool,
    model: c.model,
    source: c.source,
    occurred_at: isoMs(c.occurred_at),
    data_kind: c.data_kind,
    data_sensitivity: c.data_sensitivity,
    pii_included: c.pii_included,
    client_ref: c.client_ref,
    matter_ref: c.matter_ref,
    prompt_sha256: c.prompt_sha256,
    output_sha256: c.output_sha256,
    reviewed: c.reviewed,
    reviewer_id: c.reviewer_id,
    reviewed_at: isoMs(c.reviewed_at),
    verification_notes: c.verification_notes,
    edited: c.edited,
    verified_accurate: c.verified_accurate,
    assumptions_ref: c.assumptions_ref,
    reviewer_confirmed_assumptions: c.reviewer_confirmed_assumptions,
    approval_signature: c.approval_signature,
    reviews_event_id: c.reviews_event_id,
  })
}

export const recomputeRecordHashV2 = (c: CoreFieldsV2, prevHash: string | null) =>
  sha256(canonicalV2(c) + (prevHash ?? ''))

// A row as selected from ai_event: all core fields except the artifact hashes,
// which live on the artifact rows and are joined in via prompt_ref/output_ref.
export type ChainEvent = Omit<CoreFieldsV2, 'prompt_sha256' | 'output_sha256'> & {
  id: string
  prompt_ref: string | null
  output_ref: string | null
  prev_hash: string | null
  record_hash: string
}

export type ChainVerdict =
  | { ok: true; count: number; headHash: string | null }
  | { ok: false; count: number; failedAt: string; reason: string }

// Full-chain verification: walk the linked list from genesis (prev_hash null)
// and recompute every hash from the stored fields + artifact hashes. Any
// altered, removed, or reordered record breaks the walk or the recomputation.
export function verifyChain(
  events: ChainEvent[],
  artifactSha: Map<string, string>, // artifact id → sha256
): ChainVerdict {
  if (events.length === 0) return { ok: true, count: 0, headHash: null }
  const byPrev = new Map<string | null, ChainEvent>()
  for (const ev of events) {
    if (byPrev.has(ev.prev_hash)) return { ok: false, count: events.length, failedAt: ev.id, reason: 'forked chain: duplicate prev_hash' }
    byPrev.set(ev.prev_hash, ev)
  }
  let prev: string | null = null
  let seen = 0
  while (seen < events.length) {
    const ev = byPrev.get(prev)
    if (!ev) return { ok: false, count: events.length, failedAt: prev ?? 'genesis', reason: 'broken link: no record continues the chain' }
    const recomputed = recomputeRecordHashV2({
      ...ev,
      prompt_sha256: ev.prompt_ref ? artifactSha.get(ev.prompt_ref) ?? null : null,
      output_sha256: ev.output_ref ? artifactSha.get(ev.output_ref) ?? null : null,
    }, prev)
    if (recomputed !== ev.record_hash) return { ok: false, count: events.length, failedAt: ev.id, reason: 'record hash does not recompute - contents differ from what was signed' }
    prev = ev.record_hash
    seen++
  }
  return { ok: true, count: seen, headHash: prev }
}
