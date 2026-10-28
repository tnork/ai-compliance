import Link from 'next/link'
import { requireViewLogs, canReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { verifyChain, type ChainEvent } from '@/lib/hashchain'
import { fetchAllRows } from '@/lib/coverage'

const SENS_LABEL: Record<string, string> = { none: 'None', pii: 'PII', phi: 'PHI', privileged: 'Privileged' }

export default async function RecordsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireViewLogs()
  const sp = await searchParams
  const supabase = await createClient()
  // verification must cover EVERY record (a truncated fetch falsely fails past
  // PostgREST's 1000-row cap), so page through all of them; display shows the
  // newest slice.
  const allEvents = await fetchAllRows<ChainEvent & { model: string | null; source: string; data_sensitivity: string; pii_included: boolean; reviewed: boolean; verified_accurate: boolean | null; reviews_event_id: string | null; created_at: string; user_id: string; surface: string | null; os: string | null }>(
    supabase, 'ai_event', '*', [{ column: 'created_at', ascending: false }, { column: 'id', ascending: false }])
  // captured events that a human later reviewed (via a linked review event) show as verified
  const reviewedCaptured = new Set(allEvents.filter((e) => e.reviews_event_id).map((e) => e.reviews_event_id))
  // list hides review events themselves (they annotate the captured event they resolve)
  const interactions = allEvents.filter((e) => !e.reviews_event_id)
  const events = interactions.slice(0, 200)

  // Usage breakdown (0029): every interaction is counted by member, AI system,
  // capture surface, and OS. Surface/os arrive from the capture clients; manual
  // in-app entries show as 'in-app'; pre-0029 captures show as 'unknown'.
  const { data: memberRows } = await supabase.from('app_user').select('id, username, email')
  const memberName = new Map((memberRows ?? []).map((m) => [m.id, m.username || m.email || m.id.slice(0, 8)]))
  const tally = (get: (e: (typeof interactions)[number]) => string) => {
    const m = new Map<string, number>()
    for (const e of interactions) { const k = get(e); m.set(k, (m.get(k) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }
  const usage = interactions.length === 0 ? null : {
    byMember: tally((e) => memberName.get(e.user_id) ?? 'former member'),
    byTool: tally((e) => e.tool || 'Unknown'),
    bySurface: tally((e) => e.surface ?? (e.source === 'manual' || e.source === 'in_app' ? 'in-app' : 'unknown')),
    byOs: tally((e) => e.os ?? '-'),
  }
  const allArtifacts = await fetchAllRows<{ id: string; sha256: string }>(
    supabase, 'artifact', 'id, sha256', [{ column: 'created_at', ascending: true }])
  let verdict = verifyChain(allEvents, new Map(allArtifacts.map((a) => [a.id, a.sha256])))

  // Content review state (firm-level, RLS-scoped to the caller's firm): drives
  // whether the footer promises hash-only data-minimization or retained content.
  // If the lookup FAILS, make NEITHER claim - a false "not stored" line would be a
  // data-handling misstatement (honesty guardrail). retainKnown gates the assertion.
  const { data: firmRow, error: firmErr } = await supabase.from('firm').select('retain_raw_captures').maybeSingle()
  const retainKnown = !firmErr && !!firmRow
  const retainRaw = !!firmRow?.retain_raw_captures

  // tail-deletion anchor (interim until WORM anchoring): the most recent
  // packet's chain_head must still exist in the chain - a deleted tail can't
  // silently pass while any packet remembers a head beyond it.
  if (verdict.ok) {
    const { data: anchor } = await supabase
      .from('defense_packet').select('chain_head, generated_at')
      .order('generated_at', { ascending: false }).limit(1).maybeSingle()
    if (anchor?.chain_head && !allEvents.some((e) => e.record_hash === anchor.chain_head)) {
      verdict = { ok: false, count: allEvents.length, failedAt: anchor.chain_head.slice(0, 12), reason: `the chain no longer contains the head recorded by the packet generated ${new Date(anchor.generated_at).toLocaleString()} - records after that point may have been removed` }
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§10.22 / §10.36 · RECORD OF SUPERVISION</div>
          <h1>Review records</h1>
          <p>Each record is evidence that a person reviewed an AI work product - tamper-evident, add-only, and exportable into your defense packet. Corrections are saved as new records, never edits.</p>
        </div>
        {canReview(me) && <Link href="/records/new" className="btn btn-primary">Log a review</Link>}
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      {events && events.length > 0 && (
        verdict.ok ? (
          <div className="msg ok" role="status" style={{ maxWidth: 720 }}>
            ✓ Chain verified - {verdict.count} record{verdict.count === 1 ? '' : 's'} recomputed end-to-end. Head hash <code style={{ fontSize: 12 }}>{verdict.headHash?.slice(0, 16)}…</code>
          </div>
        ) : (
          <div className="msg err" role="alert" style={{ maxWidth: 720 }}>
            ✗ CHAIN VERIFICATION FAILED at {verdict.failedAt.slice(0, 8)}… - {verdict.reason}. Records may have been altered outside the append-only flow.
          </div>
        )
      )}

      {usage && (
        <div className="card" style={{ marginBottom: 22 }}>
          <h3>Usage</h3>
          <p className="hint" style={{ margin: '4px 0 12px' }}>Every logged interaction, broken down by who used AI, which system, where it ran (browser or desktop), and on what operating system.</p>
          <div className="grid grid-4" style={{ gap: 18 }}>
            {([['By member', usage.byMember], ['By tool', usage.byTool], ['By surface', usage.bySurface], ['By OS', usage.byOs]] as const).map(([label, rows]) => (
              <div key={label}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>{label.toUpperCase()}</div>
                <table className="table" style={{ fontSize: 13.5 }}>
                  <tbody>
                    {rows.slice(0, 8).map(([k, n]) => (
                      <tr key={k}><td>{k}</td><td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>{n}</td></tr>
                    ))}
                    {rows.length > 8 && <tr><td className="hint" colSpan={2}>+ {rows.length - 8} more</td></tr>}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        {events && events.length > 0 ? (
          <table className="table">
            <thead><tr><th>When</th><th>Tool</th><th>Client / matter</th><th>Kind</th><th>Data</th><th>Review</th><th>Record hash</th></tr></thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(ev.occurred_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td style={{ fontWeight: 700 }}><Link href={`/records/${ev.id}`} style={{ color: 'var(--navy)' }}>{ev.tool}</Link>{ev.model ? <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {ev.model}</span> : null}{ev.source !== 'manual' ? <span className="badge neutral" style={{ marginLeft: 8, fontWeight: 600 }}>auto-captured</span> : null}</td>
                  <td>{ev.client_ref || '-'}</td>
                  <td>{ev.data_kind ? ev.data_kind.replace(/_/g, ' ') : '-'}</td>
                  <td>
                    <span className={`badge ${ev.data_sensitivity === 'none' ? 'neutral' : 'warn'}`}>{SENS_LABEL[ev.data_sensitivity] ?? ev.data_sensitivity}</span>
                  </td>
                  <td>
                    {ev.verified_accurate || reviewedCaptured.has(ev.id)
                      ? <span className="badge ok">Verified</span>
                      : ev.reviewed ? <span className="badge neutral">Reviewed</span> : <span className="badge warn">Unreviewed</span>}
                  </td>
                  <td><code style={{ fontSize: 12, color: 'var(--muted)' }}>{ev.record_hash.slice(0, 12)}…</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">
            No review records yet.{canReview(me) ? <> <Link href="/records/new">Log your first review</Link> - it takes under a minute and starts your firm&rsquo;s tamper-evident supervision chain.</> : ' A reviewer will log the first one - it starts your firm’s tamper-evident supervision chain.'}
          </div>
        )}
      </div>

      <p className="hint" style={{ marginTop: 14 }}>
        {!retainKnown
          ? <>Content handling follows this firm&rsquo;s Content review setting (manage it under Connections). Not legal or tax advice; you remain responsible for compliance.</>
          : retainRaw
          ? <>Content review is on: prompt <span className="amp">&amp;</span> output text is retained and encrypted for this firm - open a record to review the captured content. Not legal or tax advice; you remain responsible for compliance.</>
          : <>Prompt <span className="amp">&amp;</span> output text is hashed, not stored (data-minimization default). Not legal or tax advice; you remain responsible for compliance.</>}
      </p>
    </>
  )
}
