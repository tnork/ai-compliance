import Link from 'next/link'
import { requireViewLogs } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { computeCoverage, fetchAllRows, loadFirmEvidence, type EventRow } from '@/lib/coverage'
import { generatePacket } from './actions'
import SubmitButton from '@/components/SubmitButton'
import WispTip from '@/components/WispTip'

export default async function CoveragePage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireViewLogs()
  const sp = await searchParams
  const supabase = await createClient()
  const [events, firm, { data: packets }] = await Promise.all([
    fetchAllRows<EventRow>(supabase, 'ai_event', '*', [{ column: 'occurred_at', ascending: true }, { column: 'id', ascending: true }]),
    loadFirmEvidence(supabase),
    supabase.from('defense_packet').select('id, generated_at, packet_hash, coverage_summary').order('generated_at', { ascending: false }).limit(5),
  ])
  const cov = computeCoverage(events, firm)
  const totalGaps = cov.perClause.filter((c) => c.severity === 'required').reduce((n, c) => n + c.gap, 0)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">CIRCULAR 230 MAPPING · DRAFT</div>
          <h1>Coverage</h1>
          <p>How your review records line up with each Circular 230 duty. These clause mappings are a DRAFT pending advisor review - this shows your supervision evidence; it is not a claim that your firm is compliant.</p>
        </div>
        <form action={generatePacket}><SubmitButton className="btn btn-primary" pendingLabel="Generating…">Generate defense packet</SubmitButton></form>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="n" style={cov.coveragePct !== null && cov.coveragePct >= 80 ? { color: 'var(--green-deep)' } : undefined}>
            {cov.coveragePct === null ? '-' : `${cov.coveragePct}%`}
          </div>
          <div className="l">Required-evidence coverage</div>
        </div>
        <div className="stat">
          <div className="n">{events.length}</div>
          <div className="l">Review records evaluated</div>
        </div>
        <div className="stat">
          <div className="n" style={totalGaps > 0 ? { color: 'var(--warn-ink)' } : undefined}>{totalGaps}</div>
          <div className="l">Open gaps (required)</div>
        </div>
      </div>

      {cov.firmGaps.length > 0 && (
        <div className="callout">
          <b>Firm-level gaps:</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20 }}>
            {cov.firmGaps.map((g) => <li key={g} style={{ marginBottom: 3 }}>{g}</li>)}
          </ul>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <table className="table">
          <thead><tr><th>Clause</th><th>Duty</th><th>Severity</th><th>Satisfied</th><th>Gaps</th><th>N/A</th></tr></thead>
          <tbody>
            {cov.perClause.map((c) => (
              <tr key={c.code}>
                <td className="t-key" style={{ whiteSpace: 'nowrap' }}>{c.code}</td>
                <td>{c.title}</td>
                <td><span className={`badge ${c.severity === 'required' ? 'neutral' : 'ok'}`}>{c.severity}</span></td>
                <td>{c.satisfied}</td>
                <td>{c.gap > 0 ? <span className="badge warn">{c.gap}</span> : 0}</td>
                <td style={{ color: 'var(--muted)' }}>{c.na}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 10 }}>Gaps are actionable: adopt/acknowledge the policy (§10.36), log verification notes (§10.22), record training (§10.35), document assumptions on written advice (§10.37), and keep tools/PII on the approved register (WISP<WispTip />).</p>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 10 }}>Generated packets</h2>
        {packets && packets.length > 0 ? (
          <table className="table">
            <thead><tr><th>Generated</th><th>Coverage</th><th>Packet hash</th><th></th></tr></thead>
            <tbody>{packets.map((p) => (
              <tr key={p.id}>
                <td>{new Date(p.generated_at).toLocaleString()}</td>
                <td>{(p.coverage_summary as { coveragePct?: number | null })?.coveragePct ?? '-'}%</td>
                <td><code style={{ fontSize: 12 }}>{p.packet_hash.slice(0, 16)}…</code></td>
                <td><Link href={`/packet/${p.id}`}>Open</Link></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="empty">No packets yet. Generate one to get a dated, tamper-evident export of your supervision evidence.</div>}
      </div>
    </>
  )
}
