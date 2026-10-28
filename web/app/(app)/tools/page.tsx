import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { addTool, deleteTool } from './actions'
import SubmitButton from '@/components/SubmitButton'

export default async function ToolsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireUser()
  const sp = await searchParams
  const supabase = await createClient()
  const { data: tools } = await supabase
    .from('tool_register')
    .select('id, tool_name, provider, approved_for_pii, status, data_handling_notes')
    .order('created_at', { ascending: false })

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§10.36 · APPROVED-TOOL REGISTER</div>
          <h1>AI tools</h1>
          <p>Which AI tools your firm approves, and for what data. Only approved tools may be used on client work; PII belongs only in tools cleared for it.</p>
        </div>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 14 }}>Add a tool</h2>
        <form action={addTool}>
          <div className="grid grid-3">
            <div className="field"><label htmlFor="tool_name">Tool name</label><input className="input" id="tool_name" name="tool_name" placeholder="ChatGPT" required /></div>
            <div className="field"><label htmlFor="provider">Provider</label><input className="input" id="provider" name="provider" placeholder="OpenAI" /></div>
            <div className="field"><label htmlFor="status">Status</label>
              <select className="select" id="status" name="status" defaultValue="approved">
                <option value="approved">Approved</option>
                <option value="under_review">Under review</option>
                <option value="blocked">Blocked</option>
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="data_handling_notes">Data-handling notes</label><input className="input" id="data_handling_notes" name="data_handling_notes" placeholder="No client PII; enterprise account with no training on data" /></div>
          <label className="checkline" style={{ marginBottom: 16 }}><input type="checkbox" name="approved_for_pii" /> Approved for client PII</label>
          <SubmitButton className="btn btn-primary" pendingLabel="Adding…">Add tool</SubmitButton>
        </form>
      </div>

      <div className="card">
        {tools && tools.length > 0 ? (
          <table className="table">
            <thead><tr><th>Tool</th><th>Provider</th><th>PII</th><th>Status</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.id}>
                  <td className="t-key">{t.tool_name}</td>
                  <td>{t.provider || '-'}</td>
                  <td><span className={`badge ${t.approved_for_pii ? 'ok' : 'neutral'}`}>{t.approved_for_pii ? 'PII OK' : 'No PII'}</span></td>
                  <td><span className={`badge ${t.status === 'approved' ? 'ok' : t.status === 'blocked' ? 'warn' : 'neutral'}`}>{t.status.replace('_', ' ')}</span></td>
                  <td style={{ color: 'var(--muted)', maxWidth: 260 }}>{t.data_handling_notes || '-'}</td>
                  <td>{me.role === 'admin' ? <form action={deleteTool}><input type="hidden" name="id" value={t.id} /><SubmitButton className="btn btn-danger btn-sm" pendingLabel="Removing…">Remove</SubmitButton></form> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No tools yet. Add the AI tools your firm has vetted.</div>
        )}
      </div>
    </>
  )
}
