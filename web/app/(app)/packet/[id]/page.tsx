import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireViewLogs } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { CLAUSES, type ClauseCode, type Finding } from '@/lib/coverage'
import PrintButton from '@/components/PrintButton'

type Summary = {
  firmName?: string
  coveragePct: number | null
  perClause: { code: ClauseCode; title: string; severity: string; satisfied: number; gap: number; na: number }[]
  firmGaps: string[]
  clauses?: { code: string; title: string; requirement: string }[]  // frozen at generation (summary v2)
  events: { id: string; findings: Record<ClauseCode, Finding> }[]
}

// The exportable "Circular 230 AI Supervision Packet" - a point-in-time render
// of coverage_summary as FROZEN at generation: clause text, findings, and firm
// name all come from the summary, never from live tables, so an old packet's
// printed contents can never drift under its integrity stamp (Codex P1).
// Event rows themselves are append-only, so reading their metadata is safe.
// Print → PDF via the browser.
export default async function PacketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await requireViewLogs()
  const supabase = await createClient()
  const { data: packet } = await supabase.from('defense_packet').select('*').eq('id', id).single()
  if (!packet) notFound()
  const summary = packet.coverage_summary as Summary
  const { data: events } = await supabase
    .from('ai_event')
    .select('id, occurred_at, tool, model, client_ref, matter_ref, data_kind, record_hash, approval_signature')
    .in('id', packet.event_ids)
    .order('occurred_at')
  // in-DB recomputation of the packet hash over the stored row (0012)
  const { data: hashOk } = await supabase.rpc('verify_defense_packet', { p_id: id })
  const reqOf = (code: string) => summary.clauses?.find((c) => c.code === code)?.requirement ?? ''
  const findingsOf = (evId: string) => summary.events.find((e) => e.id === evId)?.findings

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow no-print"><Link href="/coverage" style={{ color: 'var(--muted)' }}>← Coverage</Link></div>
          <h1>Circular 230 AI Supervision Packet <span className="badge warn" style={{ verticalAlign: 'middle' }}>DRAFT MAPPINGS</span></h1>
          <p>{summary.firmName ?? me.firmName} · generated {new Date(packet.generated_at).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })} · scope: {packet.scope}</p>
        </div>
        <PrintButton>Print / Save as PDF</PrintButton>
      </div>

      {hashOk === false && (
        <div className="msg err" role="alert" style={{ maxWidth: 720 }}>
          ✗ PACKET INTEGRITY CHECK FAILED - the stored packet no longer reproduces its hash. Its contents may have been altered.
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 10 }}>Integrity stamp {hashOk === true && <span className="badge ok">recomputed ✓</span>}</h2>
        <table className="kv"><tbody>
          <tr><th scope="row">Packet hash</th><td><code style={{ fontSize: 12 }}>{packet.packet_hash}</code></td></tr>
          <tr><th scope="row">Chain head at generation</th><td><code style={{ fontSize: 12 }}>{packet.chain_head ?? '-'}</code></td></tr>
        </tbody></table>
        <p style={{ margin: '10px 0 0', color: 'var(--muted)' }}>{packet.event_ids.length} hash-chained review record{packet.event_ids.length === 1 ? '' : 's'} · required-evidence coverage at generation: <strong>{summary.coveragePct ?? '-'}%</strong></p>
      </div>

      {CLAUSES.map((clause) => {
        const roll = summary.perClause.find((c) => c.code === clause.code)
        const rows = (events ?? []).filter((ev) => findingsOf(ev.id)?.[clause.code]?.status !== 'na')
        return (
          <div className="card" style={{ marginBottom: 20, breakInside: 'avoid' }} key={clause.code}>
            <h2 style={{ marginBottom: 4 }}>{clause.code} - {clause.title} <span className={`badge ${clause.severity === 'required' ? 'neutral' : 'ok'}`}>{clause.severity}</span></h2>
            <p style={{ color: 'var(--muted)', marginBottom: 12 }}>{reqOf(clause.code)}</p>
            <p style={{ marginBottom: 10 }}>
              <span className="badge ok">{roll?.satisfied ?? 0} satisfied</span>{' '}
              {roll && roll.gap > 0 ? <span className="badge warn">{roll.gap} gap{roll.gap === 1 ? '' : 's'}</span> : null}{' '}
              {roll && roll.na > 0 ? <span className="badge neutral">{roll.na} n/a</span> : null}
            </p>
            {rows.length > 0 ? (
              <table className="table">
                <thead><tr><th>When</th><th>Tool</th><th>Client</th><th>Status</th><th>Basis</th><th>Record hash</th></tr></thead>
                <tbody>{rows.map((ev) => {
                  const f = findingsOf(ev.id)?.[clause.code]
                  return (
                    <tr key={ev.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(ev.occurred_at).toLocaleDateString()}</td>
                      <td>{ev.tool}</td>
                      <td>{ev.client_ref || '-'}</td>
                      <td>{f
                        ? <span className={`badge ${f.status === 'satisfied' ? 'ok' : 'warn'}`}>{f.status}</span>
                        : <span className="badge neutral">not evaluated</span>}</td>
                      <td style={{ color: 'var(--muted)' }}>{f?.detail ?? 'record was not part of this packet’s evaluation'}</td>
                      <td><code style={{ fontSize: 11 }}>{ev.record_hash.slice(0, 12)}…</code></td>
                    </tr>
                  )
                })}</tbody>
              </table>
            ) : <div className="empty">No records in scope for this clause.</div>}
          </div>
        )
      })}

      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          This packet documents that a human supervised the listed AI work products; it records evidence, it does not assert or guarantee compliance. Clause mappings are DRAFT pending review by retained counsel. Verify integrity by recomputing each record hash and the packet hash from the underlying records. Not legal or tax advice; you remain responsible for compliance.
        </p>
      </div>
    </>
  )
}
