import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { addAccount, deleteAccount } from './actions'
import SubmitButton from '@/components/SubmitButton'

const PROVIDERS = [
  ['openai', 'ChatGPT (OpenAI)'], ['anthropic', 'Claude (Anthropic)'], ['google', 'Gemini (Google)'],
  ['xai', 'Grok (xAI)'], ['microsoft', 'Copilot (Microsoft)'], ['local', 'Local LLM'], ['other', 'Other'],
]

export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  await requireUser()
  const sp = await searchParams
  const supabase = await createClient()
  const { data: rows } = await supabase
    .from('ai_account')
    .select('id, provider, tool, account_type, is_local_llm, label')
    .order('created_at', { ascending: false })
  const label = (p: string) => PROVIDERS.find(([k]) => k === p)?.[1] || p

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">UNTRACKED AI USE</div>
          <h1>AI accounts</h1>
          <p>Confirm the AI accounts your team uses for firm work - firm-provided <em>and</em> personal, including local AI models. This is the list the monitoring-coverage view checks against.</p>
        </div>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 14 }}>Confirm an account</h2>
        <form action={addAccount}>
          <div className="grid grid-3">
            <div className="field"><label htmlFor="provider">Provider</label>
              <select className="select" id="provider" name="provider" defaultValue="openai">
                {PROVIDERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="tool">Tool / model (optional)</label><input className="input" id="tool" name="tool" placeholder="e.g. Ollama · llama3" /></div>
            <div className="field"><label htmlFor="account_type">Account type</label>
              <select className="select" id="account_type" name="account_type" defaultValue="personal">
                <option value="personal">Personal</option>
                <option value="firm">Firm-provided</option>
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="label">Label (optional)</label><input className="input" id="label" name="label" placeholder="Jane's personal ChatGPT Plus" /></div>
          <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Confirm account</SubmitButton>
        </form>
      </div>

      <div className="card">
        {rows && rows.length > 0 ? (
          <table className="table">
            <thead><tr><th>Provider</th><th>Tool</th><th>Type</th><th>Label</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="t-key">{label(r.provider)}</td>
                  <td>{r.tool || '-'}</td>
                  <td><span className={`badge ${r.account_type === 'firm' ? 'ok' : 'warn'}`}>{r.account_type === 'firm' ? 'Firm' : 'Personal'}</span></td>
                  <td style={{ color: 'var(--muted)' }}>{r.label || '-'}</td>
                  <td><form action={deleteAccount}><input type="hidden" name="id" value={r.id} /><SubmitButton className="btn btn-danger btn-sm" pendingLabel="Removing…">Remove</SubmitButton></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No AI accounts confirmed yet.</div>
        )}
      </div>
    </>
  )
}
