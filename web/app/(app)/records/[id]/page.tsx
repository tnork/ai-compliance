import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireViewLogs, canReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { recomputeRecordHashV2, sha256 } from '@/lib/hashchain'
import { openSecret } from '@/lib/connectors/crypto'
import SubmitButton from '@/components/SubmitButton'
import { reviewCaptured } from './actions'

type Art = { id: string; kind: string; sha256: string; content_ciphertext: string | null; content_iv: string | null; content_tag: string | null }
// Firm opted into retention → decrypt the stored text server-side for review.
// Key lives only in env; verify the decrypted text against the record's hash.
function decryptArt(a: Art | undefined) {
  if (!a?.content_ciphertext || !a.content_iv || !a.content_tag) return null
  try {
    const text = openSecret({ ciphertext: a.content_ciphertext, iv: a.content_iv, tag: a.content_tag })
    return { text, verified: sha256(text) === a.sha256 }
  } catch { return null }
}
const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--paper-2)',
  border: '1px solid var(--line)', borderRadius: 9, padding: '12px 14px',
  fontSize: 14, lineHeight: 1.5, maxHeight: 360, overflow: 'auto', margin: '6px 0 0',
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <tr><th scope="row">{label}</th><td>{children}</td></tr>
)

export default async function RecordDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string }> }) {
  const { id } = await params
  const sp = await searchParams
  const me = await requireViewLogs()
  const supabase = await createClient()
  const { data: ev } = await supabase.from('ai_event').select('*').eq('id', id).single()
  if (!ev) notFound()
  const { data: artifacts } = await supabase
    .from('artifact').select('id, kind, sha256, byte_size, storage_uri, content_ciphertext, content_iv, content_tag').eq('ai_event_id', id)
  const shaOf = (ref: string | null) => (artifacts ?? []).find((a) => a.id === ref)?.sha256 ?? null
  const promptContent = decryptArt((artifacts ?? []).find((a) => a.kind === 'prompt') as Art | undefined)
  const outputContent = decryptArt((artifacts ?? []).find((a) => a.kind === 'output') as Art | undefined)
  const hasContent = !!(promptContent || outputContent)
  const { data: people } = await supabase
    .from('app_user').select('id, username').in('id', [ev.user_id, ev.reviewer_id].filter(Boolean))
  const nameOf = (uid: string | null) => (people ?? []).find((p) => p.id === uid)?.username ?? uid ?? '-'

  // captured (auto-logged, unreviewed) events can be resolved by appending a
  // review event; check whether one already references this event.
// human labels for the source_t enum - raw enum values never reach the UI
const SOURCE_LABEL: Record<string, string> = {
  manual: 'Manual entry',
  extension: 'Browser extension',
  desktop_agent: 'Desktop logger',
  in_app: 'In app',
  openai_api: 'OpenAI Compliance API',
  anthropic_api: 'Anthropic Compliance API',
  grok_api: 'xAI Grok API',
  gemini_api: 'Google Workspace audit',
  purview: 'Microsoft Purview',
}

  const isCaptured = ev.source !== 'manual' && !ev.reviewed && !ev.reviews_event_id
  const { data: reviewEv } = isCaptured
    ? await supabase.from('ai_event').select('id, reviewer_id, reviewed_at, verification_notes, verified_accurate').eq('reviews_event_id', id).maybeSingle()
    : { data: null }

  // integrity: recompute this record's hash from what's stored right now
  const recomputed = recomputeRecordHashV2({
    ...ev,
    prompt_sha256: shaOf(ev.prompt_ref),
    output_sha256: shaOf(ev.output_ref),
  }, ev.prev_hash)
  const intact = recomputed === ev.record_hash

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link href="/records" style={{ color: 'var(--muted)' }}>← Review records</Link></div>
          <h1>{ev.tool}{ev.model ? ` · ${ev.model}` : ''}</h1>
          <p>{new Date(ev.occurred_at).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}{ev.client_ref ? ` · ${ev.client_ref}` : ''}</p>
        </div>
        <span className={`badge ${intact ? 'ok' : 'warn'}`}>{intact ? 'Integrity verified' : 'INTEGRITY CHECK FAILED'}</span>
      </div>

      {!intact && (
        <div className="msg err" role="alert" style={{ maxWidth: 720 }}>
          This record&rsquo;s stored contents no longer produce its signed hash - it may have been altered outside the append-only flow. Recomputed <code>{recomputed.slice(0, 16)}…</code> vs stored <code>{ev.record_hash.slice(0, 16)}…</code>
        </div>
      )}

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      {/* auto-captured event awaiting human review - the §10.22 resolution
          (only members with review permission see the form) */}
      {isCaptured && !reviewEv && canReview(me) && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'var(--warn-bd)' }}>
          <h2 style={{ marginBottom: 4 }}>Review this auto-captured use <span className="badge warn">needs review</span></h2>
          <p className="hint" style={{ marginBottom: 14 }}>This AI use was captured automatically and hasn&rsquo;t been reviewed by a person yet - so it counts as an open gap (Circular 230 §10.22). Review it to close the gap; this adds a tamper-evident review record, and the captured record itself stays unchanged.</p>
          <form action={reviewCaptured}>
            <input type="hidden" name="captured_id" value={ev.id} />
            <div className="field">
              <label htmlFor="verification_notes">What did you verify?</label>
              <textarea className="input" id="verification_notes" name="verification_notes" rows={3} required placeholder="Checked the output against source documents; confirmed figures and citations" />
            </div>
            <label className="checkline"><input type="checkbox" name="edited" /> The output was edited before use</label>
            <label className="checkline"><input type="checkbox" name="verified_accurate" defaultChecked /> I verified the output is accurate for this engagement</label>
            <div className="field" style={{ maxWidth: 340, marginTop: 10 }}>
              <label htmlFor="approval_signature">Sign - type your full name</label>
              <input className="input" id="approval_signature" name="approval_signature" defaultValue={me.username ?? ''} autoComplete="name" required />
            </div>
            <SubmitButton className="btn btn-primary" pendingLabel="Recording review…"><span>Sign <span className="amp">&amp;</span> resolve</span></SubmitButton>
          </form>
        </div>
      )}

      {isCaptured && reviewEv && (
        <div className="msg ok" role="status" style={{ maxWidth: 720 }}>
          ✓ Reviewed by {nameOf(reviewEv.reviewer_id)}{reviewEv.reviewed_at ? ` on ${new Date(reviewEv.reviewed_at).toLocaleString()}` : ''}{reviewEv.verified_accurate ? ' - verified accurate' : ''}. {reviewEv.verification_notes}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 10 }}>Supervision record</h2>
        <table className="kv"><tbody>
          <Row label="AI used by">{nameOf(ev.user_id)}</Row>
          <Row label="Source">{SOURCE_LABEL[ev.source] ?? ev.source}</Row>
          <Row label="Work type">{ev.data_kind ? ev.data_kind.replace(/_/g, ' ') : '-'}</Row>
          <Row label="Client / matter">{[ev.client_ref, ev.matter_ref].filter(Boolean).join(' · ') || '-'}</Row>
          <Row label="Data sensitivity">{ev.data_sensitivity}{ev.pii_included ? ' · client PII included' : ''}</Row>
          <Row label="Reviewed by">{nameOf(ev.reviewer_id)}{ev.reviewed_at ? ` on ${new Date(ev.reviewed_at).toLocaleString()}` : ''}</Row>
          <Row label="What was verified">{ev.verification_notes || '-'}</Row>
          <Row label="Output edited before use">{ev.edited === null ? '-' : ev.edited ? 'Yes' : 'No'}</Row>
          <Row label="Verified accurate">{ev.verified_accurate === null ? '-' : ev.verified_accurate ? 'Yes' : 'No'}</Row>
          {ev.assumptions_ref && <Row label="Assumptions (written advice)">{ev.assumptions_ref}{ev.reviewer_confirmed_assumptions ? ' · confirmed by reviewer' : ''}</Row>}
          <Row label="Signed approval">{ev.approval_signature || '-'}</Row>
        </tbody></table>
      </div>

      {hasContent && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginBottom: 4 }}>Captured content <span className="badge ok" style={{ marginLeft: 6 }}>retained · encrypted</span></h2>
          <p className="hint" style={{ marginBottom: 14 }}>Your firm enabled content retention, so the actual prompt and response are stored (AES-256 encrypted at rest) for review. Read them, then verify and sign off below.</p>
          {promptContent && (
            <div style={{ marginBottom: 16 }}>
              <div className="eyebrow" style={{ marginBottom: 0 }}>PROMPT {promptContent.verified ? <span className="badge ok">hash verified</span> : <span className="badge warn">hash mismatch</span>}</div>
              <pre style={preStyle}>{promptContent.text}</pre>
            </div>
          )}
          {outputContent && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 0 }}>AI OUTPUT {outputContent.verified ? <span className="badge ok">hash verified</span> : <span className="badge warn">hash mismatch</span>}</div>
              <pre style={preStyle}>{outputContent.text}</pre>
            </div>
          )}
        </div>
      )}

      {!hasContent && ev.source !== 'manual' && (
        <div className="callout" style={{ marginBottom: 20 }}>
          No prompt or response content was retained for this capture, so there&rsquo;s nothing to read here. {me.role === 'admin'
            ? <>Turn on <Link href="/connections" style={{ fontWeight: 700, color: 'var(--blue-ink)' }}>content review</Link> so future captures store the actual content (encrypted) for inspection.</>
            : 'Ask an admin to enable content review so future captures can be inspected.'}
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 10 }}>Content evidence <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 14 }}>{hasContent ? '(content retained + hashed)' : '(hashes only - text not retained)'}</span></h2>
        {artifacts && artifacts.length > 0 ? (
          <table className="table">
            <thead><tr><th>Kind</th><th>SHA-256</th><th>Size</th><th>Raw retention</th></tr></thead>
            <tbody>{artifacts.map((a) => (
              <tr key={a.id}>
                <td className="t-key">{a.kind}</td>
                <td><code style={{ fontSize: 12 }}>{a.sha256}</code></td>
                <td>{a.byte_size != null ? `${a.byte_size} bytes` : '-'}</td>
                <td><span className={`badge ${a.content_ciphertext ? 'ok' : 'neutral'}`}>{a.content_ciphertext ? 'retained (encrypted)' : 'hash only'}</span></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <div className="empty">No captured content on this record.</div>}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 10 }}>Tamper-evidence</h2>
        <table className="kv"><tbody>
          <Row label="Record hash"><code style={{ fontSize: 12 }}>{ev.record_hash}</code></Row>
          <Row label="Previous record hash">{ev.prev_hash ? <code style={{ fontSize: 12 }}>{ev.prev_hash}</code> : <span className="badge neutral">chain genesis</span>}</Row>
          <Row label="Recorded at">{new Date(ev.created_at).toLocaleString()}</Row>
        </tbody></table>
        <p className="hint" style={{ marginTop: 10 }}>
          Each record&rsquo;s hash covers all fields above plus the previous record&rsquo;s hash, forming your firm&rsquo;s append-only supervision chain. Not legal or tax advice; you remain responsible for compliance.
        </p>
      </div>
    </>
  )
}
