import type { SupabaseClient } from '@supabase/supabase-js'

// Phase 4 coverage engine - the 6 Circular 230 clause evaluators, HARDCODED
// as plain functions per the build philosophy: no satisfied_by DSL until the
// second content pack (ABA 512) exists and the shared shape is visible.
// evidence_requirement.satisfied_by in the DB is authoring data, not executed.
//
// Findings are TEMPORAL (Codex review #2): each event is judged against the
// evidence that existed AT ev.occurred_at - training completed later never
// retroactively satisfies §10.35; training that expired later doesn't
// retroactively fail it. Known approximations (documented, not hidden):
// policy adoption time and tool approval revocations aren't historized yet;
// WISP uses coalesce(approved_at, created_at) on currently-approved tools.
// §10.36 is VERSION-STRICT (founder decision 2026-07-12, enabled by 0031):
// the AI user must have acknowledged, before the event, a policy version that
// was STILL that policy's current version at event time - if the policy was
// edited after their last acknowledgement, events until they re-acknowledge
// are genuine gaps (matching the dashboard's re-acknowledgement cycle).
// Legacy attestations with no recorded version (pre-0031 rows whose policy has
// no version history) fall back to the timestamp-only check.
//
// All clause language rendered from these results is DRAFT until advisor
// sign-off (hard constraint #2). This module documents supervision evidence;
// it never asserts compliance.

export type ClauseStatus = 'satisfied' | 'gap' | 'na'

export type EventRow = {
  id: string
  user_id: string
  tool: string
  model: string | null
  occurred_at: string
  data_kind: string | null
  pii_included: boolean
  reviewed: boolean
  reviewer_id: string | null
  verification_notes: string | null
  verified_accurate: boolean | null
  assumptions_ref: string | null
  reviewer_confirmed_assumptions: boolean | null
  record_hash: string
  client_ref: string | null
  reviews_event_id: string | null   // set on a review event → the captured event it resolves
}

export type FirmEvidence = {
  hasAdoptedPolicy: boolean
  attestations: { user_id: string; acknowledged_at: string; policy_id: string; policy_version_no: number | null }[]
  trainings: { user_id: string; completed_at: string | null; expires_at: string | null }[]
  // normalized tool name → PII approval (conservative: conflicting duplicate
  // rows resolve to NOT PII-approved) + earliest approval timestamp
  approvedTools: Map<string, { pii: boolean; approvedAt: number }>
  // adopted policy_id → version history [{version, at}] (at = created_at ms),
  // used to resolve "which version was current at event time" for the
  // version-strict §10.36 check.
  versionTimelines: Map<string, { version: number; at: number }[]>
}

export const CLAUSES = [
  { code: '§10.36', title: 'Procedures to ensure compliance', section: 'Firm Procedures', severity: 'required' },
  { code: '§10.22', title: 'Diligence as to accuracy', section: 'Human Review', severity: 'required' },
  { code: '§10.35', title: 'Competence', section: 'Competence', severity: 'required' },
  { code: '§10.37', title: 'Requirements for written advice', section: 'Written Advice', severity: 'required' },
  { code: 'WISP', title: 'Data safeguarding (GLBA / FTC Safeguards)', section: 'Data Handling', severity: 'required' },
  { code: '§10.27', title: 'Fees', section: 'Fees', severity: 'recommended' },
] as const
export type ClauseCode = (typeof CLAUSES)[number]['code']

export type Finding = { status: ClauseStatus; detail: string }

// reviewByCaptured: capturedEventId → the review event that resolved it (a human
// later verified this auto-captured usage). Lets §10.22 count a captured event
// satisfied even though the captured row itself stays reviewed=false (append-only).
export type ReviewInfo = { verified: boolean; notes: string | null; reviewerId: string | null }

export function evaluateEvent(
  ev: EventRow, firm: FirmEvidence, reviewByCaptured: Map<string, ReviewInfo> = new Map(),
): Record<ClauseCode, Finding> {
  const at = new Date(ev.occurred_at).getTime()
  const review = reviewByCaptured.get(ev.id)
  const humanVerified =
    (ev.reviewed && ev.verified_accurate === true && !!ev.verification_notes?.trim()) ||
    (!!review && review.verified && !!review.notes?.trim())

  const tool = firm.approvedTools.get(ev.tool.trim().toLowerCase())
  const toolApprovedByThen = !!tool && tool.approvedAt <= at
  const wisp: Finding = !toolApprovedByThen
    ? { status: 'gap', detail: tool ? `"${ev.tool}" was not yet approved when the AI was used` : `"${ev.tool}" is not on the approved-tool register` }
    : ev.pii_included && !tool.pii
      ? { status: 'gap', detail: `client PII went into "${ev.tool}", which is not PII-approved` }
      : { status: 'satisfied', detail: 'approved tool; data class respected' }

  // Version-strict: the acknowledgement must predate the event AND still be of
  // the policy's then-current version (an edit after their last acknowledgement
  // re-opens the gap until they re-acknowledge). Legacy rows without a version
  // fall back to timestamp-only.
  const myAcks = firm.attestations.filter(
    (a) => a.user_id === ev.user_id && new Date(a.acknowledged_at).getTime() <= at)
  const attestedByThen = myAcks.some((a) => {
    if (a.policy_version_no == null) return true // pre-versioning legacy row
    const timeline = firm.versionTimelines.get(a.policy_id) ?? []
    const currentThen = timeline.reduce((m, v) => (v.at <= at && v.version > m ? v.version : m), 0)
    // fail CLOSED (Codex P3): if no version of that policy existed yet at event
    // time, the acknowledged version certainly wasn't current then - a
    // backdated event can't borrow a later version's acknowledgement.
    return a.policy_version_no === currentThen
  })
  const ackOutdated = !attestedByThen && myAcks.length > 0
  // §10.35 is about the REVIEWER's competence - for a captured event that's the
  // reviewer on the linked review event, not the (null) captured reviewer_id.
  const effectiveReviewer = review?.reviewerId ?? ev.reviewer_id
  const trainedByThen = !!effectiveReviewer && firm.trainings.some((t) =>
    t.user_id === effectiveReviewer
    && t.completed_at && new Date(t.completed_at).getTime() <= at
    && (!t.expires_at || new Date(t.expires_at).getTime() > at))

  return {
    '§10.36': !firm.hasAdoptedPolicy
      ? { status: 'gap', detail: 'no adopted AI-use policy' }
      : !attestedByThen
        ? { status: 'gap', detail: ackOutdated ? 'the policy changed after the AI user’s last acknowledgement - the current version was not re-acknowledged before this use' : 'the AI user had not acknowledged the policy at time of use' }
        : { status: 'satisfied', detail: 'adopted policy, then-current version acknowledged by the AI user before use' },
    '§10.22': humanVerified
      ? { status: 'satisfied', detail: review ? 'auto-captured, then verified by a human reviewer' : 'human review recorded with verification notes' }
      : { status: 'gap', detail: ev.reviews_event_id ? 'review record' : !ev.reviewed ? (ev.reviewer_id === null && !review ? 'auto-captured, not yet reviewed' : 'not reviewed') : ev.verified_accurate !== true ? 'accuracy not verified' : 'no verification notes' },
    '§10.35': trainedByThen
      ? { status: 'satisfied', detail: 'reviewer held current AI training at time of use' }
      : { status: 'gap', detail: 'reviewer had no current AI-competence training at time of use' },
    '§10.37': ev.data_kind !== 'written_advice'
      ? { status: 'na', detail: 'not written advice' }
      : ev.assumptions_ref?.trim() && ev.reviewer_confirmed_assumptions === true
        ? { status: 'satisfied', detail: 'assumptions documented and confirmed' }
        : { status: 'gap', detail: !ev.assumptions_ref?.trim() ? 'assumptions not documented' : 'assumptions not confirmed by reviewer' },
    WISP: wisp,
    // recommended, trivially satisfiable per the seed rule ("any": [..., true]);
    // no fee_note field exists yet - revisit when engagement data lands
    '§10.27': { status: 'satisfied', detail: 'no fee-practice exception recorded' },
  }
}

export type Coverage = {
  events: (EventRow & { findings: Record<ClauseCode, Finding> })[]
  perClause: { code: ClauseCode; title: string; severity: string; satisfied: number; gap: number; na: number }[]
  coveragePct: number | null   // satisfied/total across REQUIRED findings; null if no events
  firmGaps: string[]           // firm-level issues independent of any single event
}

export function computeCoverage(events: EventRow[], firm: FirmEvidence): Coverage {
  // Review events (reviews_event_id set) annotate a captured event - they are
  // not distinct AI usage, so they're excluded from the tally and instead credit
  // the captured event they resolve.
  const reviewByCaptured = new Map<string, ReviewInfo>()
  for (const r of events) {
    if (r.reviews_event_id) reviewByCaptured.set(r.reviews_event_id, {
      verified: r.verified_accurate === true, notes: r.verification_notes, reviewerId: r.reviewer_id,
    })
  }
  const usage = events.filter((e) => !e.reviews_event_id)
  const evaluated = usage.map((ev) => ({ ...ev, findings: evaluateEvent(ev, firm, reviewByCaptured) }))
  const perClause = CLAUSES.map((c) => {
    let satisfied = 0, gap = 0, na = 0
    for (const ev of evaluated) {
      const s = ev.findings[c.code].status
      if (s === 'satisfied') satisfied++
      else if (s === 'gap') gap++
      else na++
    }
    return { code: c.code, title: c.title, severity: c.severity, satisfied, gap, na }
  })
  const req = perClause.filter((c) => c.severity === 'required')
  const denom = req.reduce((n, c) => n + c.satisfied + c.gap, 0)
  const num = req.reduce((n, c) => n + c.satisfied, 0)

  const firmGaps: string[] = []
  if (!firm.hasAdoptedPolicy) firmGaps.push('No adopted AI-use policy - adopt one under Policies.')
  if (firm.approvedTools.size === 0) firmGaps.push('The approved-tool register is empty - vet the tools your firm uses.')

  return { events: evaluated, perClause, coveragePct: denom ? Math.round((num / denom) * 100) : null, firmGaps }
}

// PostgREST caps responses at 1000 rows - page until a short page so "all"
// really means all (a truncated fetch would silently distort findings and
// falsely fail chain verification past the cap).
export async function fetchAllRows<T>(
  supabase: SupabaseClient, table: string, select: string,
  order: { column: string; ascending: boolean }[],
): Promise<T[]> {
  const PAGE = 1000
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1)
    for (const o of order) q = q.order(o.column, { ascending: o.ascending })
    const { data, error } = await q
    if (error) throw new Error(`${table} query failed: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) return rows
  }
}

// Evidence queries FAIL LOUDLY (Codex P2): a swallowed error here would freeze
// false gaps into a permanent packet. Callers catch and surface.
export async function loadFirmEvidence(supabase: SupabaseClient): Promise<FirmEvidence> {
  const [adoptedR, toolsR, trainingR] = await Promise.all([
    supabase.from('policy').select('id, created_at').eq('status', 'adopted').order('created_at', { ascending: false }),
    supabase.from('tool_register').select('tool_name, approved_for_pii, approved_at, created_at').eq('status', 'approved'),
    supabase.from('training_record').select('user_id, completed_at, expires_at'),
  ])
  for (const [name, r] of [['policy', adoptedR], ['tool_register', toolsR], ['training_record', trainingR]] as const) {
    if (r.error) throw new Error(`${name} query failed: ${r.error.message}`)
  }
  // ONLY the newest adopted policy counts (Codex P1): the UI, WISP gating, and
  // acknowledgement prompts all key off the newest adopted row, so §10.36
  // evidence must too - otherwise an acknowledgement of an OLD adopted policy
  // could satisfy the packet while the app says the member is pending. Same
  // documented approximation as before (adoption isn't historized), one rule
  // everywhere now.
  const adoptedIds = (adoptedR.data ?? []).slice(0, 1).map((p) => p.id)
  let attestations: FirmEvidence['attestations'] = []
  const versionTimelines: FirmEvidence['versionTimelines'] = new Map()
  if (adoptedIds.length) {
    const [ackR, verR] = await Promise.all([
      supabase.from('attestation').select('user_id, acknowledged_at, policy_id, policy_version_no').in('policy_id', adoptedIds),
      supabase.from('policy_version').select('policy_id, version, created_at').in('policy_id', adoptedIds),
    ])
    if (ackR.error) throw new Error(`attestation query failed: ${ackR.error.message}`)
    if (verR.error) throw new Error(`policy_version query failed: ${verR.error.message}`)
    attestations = ackR.data ?? []
    for (const v of verR.data ?? []) {
      const list = versionTimelines.get(v.policy_id) ?? []
      list.push({ version: v.version, at: new Date(v.created_at).getTime() })
      versionTimelines.set(v.policy_id, list)
    }
  }
  const approvedTools = new Map<string, { pii: boolean; approvedAt: number }>()
  for (const t of toolsR.data ?? []) {
    const key = t.tool_name.trim().toLowerCase()
    const approvedAt = new Date(t.approved_at ?? t.created_at).getTime()
    const prior = approvedTools.get(key)
    approvedTools.set(key, prior
      ? { pii: prior.pii && !!t.approved_for_pii, approvedAt: Math.min(prior.approvedAt, approvedAt) } // conservative on conflicts
      : { pii: !!t.approved_for_pii, approvedAt })
  }
  return {
    hasAdoptedPolicy: adoptedIds.length > 0,
    attestations,
    trainings: (trainingR.data ?? []),
    approvedTools,
    versionTimelines,
  }
}
