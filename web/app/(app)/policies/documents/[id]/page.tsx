import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import SubmitButton from '@/components/SubmitButton'
import DeleteDocumentButton from '../DeleteDocumentButton'
import { addDocumentVersion, attestFirmDocument } from '../actions'

const TYPE_LABEL: Record<string, string> = { aup: 'Acceptable Use Policy', wisp: 'WISP', other: 'Other document' }
const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
const fmtSize = (b: number | null) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`)

export default async function DocumentDetailPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ e?: string }> }) {
  const me = await requireUser()
  const { id } = await params
  const sp = await searchParams
  const supabase = await createClient()

  const { data: doc } = await supabase
    .from('firm_document').select('id, doc_type, title, description, version, created_by, created_at').eq('id', id).maybeSingle()
  if (!doc) redirect('/policies?e=' + encodeURIComponent('Document not found.'))
  const d = doc!

  const [{ data: versions }, { data: acks }, { data: members }] = await Promise.all([
    supabase.from('firm_document_version').select('id, version, file_name, byte_size, note, uploaded_by, created_at').eq('document_id', id).order('version', { ascending: false }),
    supabase.from('firm_document_attestation').select('user_id, document_version, attested_at').eq('document_id', id),
    supabase.from('app_user').select('id, username'),
  ])
  const nameOf = (uid: string) => members?.find((m) => m.id === uid)?.username || 'A member'
  const canEdit = me.role === 'admin' || d.created_by === me.id
  const head = d.version || 0
  const headAcks = (acks || []).filter((a) => a.document_version === head)
  const iAckedHead = headAcks.some((a) => a.user_id === me.id)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">FIRM DOCUMENT</div>
          <h1>{d.title}</h1>
          <p>
            <span className="badge neutral">{TYPE_LABEL[d.doc_type] || 'Document'}</span>{' '}
            {head >= 1 ? <>Current version <span className="mono">v{head}</span></> : 'No file uploaded yet'}
            {d.description ? ` · ${d.description}` : ''}
          </p>
        </div>
        <Link className="btn btn-ghost btn-sm" href="/policies">Back to Policies</Link>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      {/* Acknowledge the current version (optional, any member) */}
      {head >= 1 && (
        <div className="card" style={{ maxWidth: 720 }}>
          <h3 style={{ marginTop: 0 }}>Acknowledgement</h3>
          {iAckedHead ? (
            <p className="msg ok" role="status">You acknowledged the current version (v{head}).</p>
          ) : (
            <form action={attestFirmDocument} className="rowflex" style={{ gap: 12, alignItems: 'center' }}>
              <input type="hidden" name="document_id" value={d.id} />
              <p style={{ margin: 0, color: 'var(--lead)' }}>Confirm you have read the current version of this document.</p>
              <SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">Acknowledge v{head}</SubmitButton>
            </form>
          )}
          {headAcks.length > 0 && (
            <p style={{ marginTop: 10, fontSize: 13, color: 'var(--muted)' }}>
              {headAcks.length} {headAcks.length === 1 ? 'person has' : 'people have'} acknowledged v{head}: {headAcks.map((a) => nameOf(a.user_id)).join(', ')}.
            </p>
          )}
        </div>
      )}

      {/* Version history */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Version history</h3>
        {versions && versions.length > 0 ? (
          <table className="table">
            <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Uploaded by</th><th>Date</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="mono">v{v.version}{v.version === head && <span className="badge ok" style={{ marginLeft: 8 }}>current</span>}</td>
                  <td className="t-key">{v.file_name}</td>
                  <td className="mono">{fmtSize(v.byte_size)}</td>
                  <td>{nameOf(v.uploaded_by)}</td>
                  <td>{fmtDate(v.created_at)}</td>
                  <td style={{ color: 'var(--muted)' }}>{v.note || ''}</td>
                  <td><a className="btn btn-ghost btn-sm" href={`/api/firm-document/${v.id}`}>Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No versions yet.</div>
        )}
      </div>

      {/* Upload a new version (creator or admin) */}
      {canEdit && (
        <div className="card" style={{ maxWidth: 720 }}>
          <h3 style={{ marginTop: 0 }}>Upload a new version</h3>
          <p style={{ marginTop: 0, color: 'var(--muted)', fontSize: 14 }}>Replacing the file adds a new version and re-opens acknowledgement for everyone. Max 15 MB.</p>
          <form action={addDocumentVersion} className="grid" style={{ gap: 12 }}>
            <input type="hidden" name="document_id" value={d.id} />
            <div className="field"><label htmlFor="file">File</label>
              <input className="input" id="file" type="file" name="file" required style={{ padding: '7px 10px' }} /></div>
            <div className="field"><label htmlFor="note">What changed <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span></label>
              <input className="input" id="note" name="note" placeholder="e.g. Updated data-retention section" /></div>
            <SubmitButton className="btn btn-primary" pendingLabel="Uploading…">Upload new version</SubmitButton>
          </form>
        </div>
      )}

      {canEdit && (
        <div className="card" style={{ maxWidth: 720 }}>
          <h3 style={{ marginTop: 0 }}>Danger zone</h3>
          <DeleteDocumentButton documentId={d.id} />
        </div>
      )}
    </>
  )
}
