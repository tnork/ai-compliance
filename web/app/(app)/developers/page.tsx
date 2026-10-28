import { requireDeveloper } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import SubmitButton from '@/components/SubmitButton'
import { setResolved } from './actions'

type Row = {
  id: string
  source: string
  severity: string
  message: string
  context: unknown
  stack: string | null
  resolved: boolean
  resolved_at: string | null
  created_at: string
}

export default async function DevelopersPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  await requireDeveloper()
  const sp = await searchParams
  const showAll = sp.show === 'all'
  const supabase = await createClient()

  let q = supabase
    .from('error_log')
    .select('id, source, severity, message, context, stack, resolved, resolved_at, created_at')
    .order('created_at', { ascending: false })
    .limit(500)
  if (!showAll) q = q.eq('resolved', false)
  const { data } = await q
  const rows = (data ?? []) as Row[]

  const { count: openCount } = await supabase
    .from('error_log').select('id', { count: 'exact', head: true }).eq('resolved', false)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">DEVELOPER · error log</div>
          <h1>Developers</h1>
          <p>Server-side errors that would otherwise fail silently are captured here so they survive across sessions. Visible only to the developer account. Mark each resolved once the underlying issue is fixed.</p>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="n">{openCount ?? 0}</div><div className="l">Unresolved errors</div></div>
      </div>

      <div className="rowflex" style={{ gap: 8, marginBottom: 14 }}>
        <a className={`btn btn-sm ${showAll ? 'btn-ghost' : 'btn-primary'}`} href="/developers">Unresolved</a>
        <a className={`btn btn-sm ${showAll ? 'btn-primary' : 'btn-ghost'}`} href="/developers?show=all">All</a>
      </div>

      {rows.length === 0 ? (
        <div className="card"><p className="hint" style={{ margin: 0 }}>No {showAll ? '' : 'unresolved '}errors. {showAll ? '' : 'Nothing needs attention right now.'}</p></div>
      ) : (
        rows.map((r) => (
          <div key={r.id} className="card" style={{ marginBottom: 12, opacity: r.resolved ? 0.62 : 1 }}>
            <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: '1 1 420px' }}>
                <div className="rowflex" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span className={`badge ${r.severity === 'warn' ? 'warn' : 'err'}`}>{r.severity}</span>
                  <span className="badge neutral">{r.source}</span>
                  {r.resolved && <span className="badge ok">resolved</span>}
                  <span className="hint">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div style={{ fontWeight: 600, color: 'var(--navy)', wordBreak: 'break-word' }}>{r.message}</div>
                {r.context != null && (
                  <pre style={{ marginTop: 8, background: 'var(--paper-2)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', fontSize: 12, overflowX: 'auto', maxHeight: 220 }}>
                    <code>{JSON.stringify(r.context, null, 2)}</code>
                  </pre>
                )}
                {r.stack && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>stack</summary>
                    <pre style={{ marginTop: 6, fontSize: 11, overflowX: 'auto', maxHeight: 220 }}><code>{r.stack}</code></pre>
                  </details>
                )}
              </div>
              <form action={setResolved}>
                <input type="hidden" name="id" value={r.id} />
                <input type="hidden" name="resolved" value={(!r.resolved).toString()} />
                <SubmitButton className={`btn btn-sm ${r.resolved ? 'btn-ghost' : 'btn-green'}`} pendingLabel="…">
                  {r.resolved ? 'Reopen' : 'Mark resolved'}
                </SubmitButton>
              </form>
            </div>
          </div>
        ))
      )}
    </>
  )
}
