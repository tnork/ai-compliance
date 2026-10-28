import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import SubmitButton from '@/components/SubmitButton'
import AdoptButton from './AdoptButton'
import { createFirmDocument } from './documents/actions'

const DOC_TYPE_LABEL: Record<string, string> = { aup: 'Acceptable Use Policy', wisp: 'WISP', other: 'Other' }

export default async function PoliciesPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireUser()
  const sp = await searchParams
  const supabase = await createClient()
  const [{ data: policies }, { data: documents }] = await Promise.all([
    supabase.from('policy').select('id, title, status, version, created_at, created_by').order('created_at', { ascending: false }),
    supabase.from('firm_document').select('id, doc_type, title, version, created_at').order('created_at', { ascending: false }),
  ])
  // adopting mutates the policy (creator-or-admin per RLS) - only show the button
  // to users who can actually do it, so it never fails on click.
  const canAdopt = (p: { created_by: string }) => me.role === 'admin' || p.created_by === me.id

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§10.36 · WRITTEN PROCEDURES</div>
          <h1>Policies</h1>
          <p>Your firm&rsquo;s Circular 230 AI-use policies. Generate one, review it, then adopt the active version.</p>
        </div>
        <Link className="btn btn-green" href="/policies/new">Generate a policy</Link>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="card">
        {policies && policies.length > 0 ? (
          <table className="table">
            <thead><tr><th>Policy</th><th>Version</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id}>
                  <td className="t-key">{p.title}</td>
                  <td className="mono">v{p.version}</td>
                  <td><span className={`badge ${p.status === 'adopted' ? 'ok' : 'neutral'}`}>{p.status}</span></td>
                  <td>{new Date(p.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td>
                    <div className="rowflex" style={{ justifyContent: 'flex-end', gap: 8 }}>
                      {p.status !== 'adopted' && canAdopt(p) && <AdoptButton policyId={p.id} />}
                      <Link className="btn btn-ghost btn-sm" href={`/policies/${p.id}`}>Open</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No policies yet. <Link href="/policies/new" style={{ color: 'var(--blue-ink)', fontWeight: 600 }}>Generate your first one.</Link></div>
        )}
      </div>

      {/* Bring-your-own firm documents: upload/version/acknowledge your own AUP,
          WISP, or other policies. AI Compliance stores and versions them - it does not
          generate them or judge their legal adequacy. Firm-isolated by RLS. */}
      <div className="page-head" style={{ marginTop: 40 }}>
        <div>
          <div className="eyebrow">YOUR OWN DOCUMENTS</div>
          <h1 style={{ fontSize: 24 }}>Firm documents</h1>
          <p>Upload and version your firm&rsquo;s own policies - an Acceptable Use Policy, your WISP, or any other document. Staff can acknowledge them. AI Compliance stores and versions your files; it doesn&rsquo;t write them or judge their legal adequacy.</p>
        </div>
      </div>

      <div className="card">
        {documents && documents.length > 0 ? (
          <table className="table">
            <thead><tr><th>Document</th><th>Type</th><th>Version</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="t-key">{doc.title}</td>
                  <td>{DOC_TYPE_LABEL[doc.doc_type] || 'Document'}</td>
                  <td className="mono">v{doc.version}</td>
                  <td>{new Date(doc.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</td>
                  <td>
                    <div className="rowflex" style={{ justifyContent: 'flex-end' }}>
                      <Link className="btn btn-ghost btn-sm" href={`/policies/documents/${doc.id}`}>Open</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No documents uploaded yet. Add your Acceptable Use Policy or WISP below.</div>
        )}
      </div>

      <div className="card" style={{ maxWidth: 720 }}>
        <h3 style={{ marginTop: 0 }}>Upload a document</h3>
        <form action={createFirmDocument} className="grid" style={{ gap: 12 }}>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="doc_title">Title</label>
              <input className="input" id="doc_title" name="title" placeholder="e.g. Firm Acceptable Use Policy" required /></div>
            <div className="field"><label htmlFor="doc_type">Type</label>
              <select className="select" id="doc_type" name="doc_type" defaultValue="aup">
                <option value="aup">Acceptable Use Policy</option>
                <option value="wisp">WISP</option>
                <option value="other">Other</option>
              </select></div>
          </div>
          <div className="field"><label htmlFor="doc_desc">Description <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span></label>
            <input className="input" id="doc_desc" name="description" placeholder="A short note about this document" /></div>
          <div className="field"><label htmlFor="doc_file">File <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(PDF, Word, or text - max 15 MB)</span></label>
            <input className="input" id="doc_file" type="file" name="file" required style={{ padding: '7px 10px' }} /></div>
          <SubmitButton className="btn btn-green" pendingLabel="Uploading…">Upload document</SubmitButton>
        </form>
      </div>
    </>
  )
}
