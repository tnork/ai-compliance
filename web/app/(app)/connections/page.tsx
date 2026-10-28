import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import SubmitButton from '@/components/SubmitButton'
import DesktopConnectCode from '@/components/DesktopConnectCode'
import { connectProvider, disconnectProvider, syncNow, setContentRetention } from './actions'

const PROVIDERS: { id: string; label: string; scopeHint: string; note: string; comingSoon?: boolean }[] = [
  { id: 'openai', label: 'OpenAI / ChatGPT Enterprise', scopeHint: 'workspace or org id', note: 'Full prompt + output capture (Compliance API).' },
  { id: 'anthropic', label: 'Anthropic / Claude Enterprise', scopeHint: 'organization id', note: 'Chats + files. Claude Cowork is excluded by Anthropic.' },
  { id: 'grok', label: 'xAI / Grok Enterprise', scopeHint: 'team/org id (optional)', note: 'Usage-level only - no prompt/output content.' },
  { id: 'gemini', label: 'Google / Gemini (Workspace)', scopeHint: 'not required', note: 'Workspace audit logs - usage-level (who/when), no prompt/output content. Paste a Workspace admin OAuth token.' },
  { id: 'copilot', label: 'Microsoft / Copilot (M365)', scopeHint: 'not required', note: 'Microsoft Graph enterprise interactions (prompt + response). Paste an Azure AD app token.' },
]

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ e?: string; synced?: string; retention?: string }> }) {
  const me = await requireUser()
  const sp = await searchParams
  const supabase = await createClient()
  const { data: conns } = await supabase
    .from('provider_connection')
    .select('id, provider, status, scope_ref, last_sync_at, last_error')
  const { data: firm } = await supabase.from('firm').select('retain_raw_captures').eq('id', me.firm_id).maybeSingle()
  const retainRaw = !!firm?.retain_raw_captures
  const byProvider = new Map((conns ?? []).map((c) => [c.provider, c]))
  const isAdmin = me.role === 'admin'

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">AUTOMATIC CAPTURE · §10.36</div>
          <h1>Connections</h1>
          <p>Capture AI use automatically instead of logging each record by hand: pair the browser extension and desktop logger below (works on any plan), or connect an enterprise workspace. Captured events arrive marked unreviewed until a person verifies them.</p>
        </div>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}
      {sp.synced && <div className="msg ok" role="status" style={{ maxWidth: 720 }}>Synced - {sp.synced}</div>}
      {sp.retention && <div className="msg ok" role="status" style={{ maxWidth: 720 }}>Content review turned {sp.retention}.</div>}

      {/* Content review (raw-capture retention) — off by default; make it easy + obvious to turn on */}
      <div className="card" style={{ marginBottom: 20, borderColor: retainRaw ? 'var(--green-pale)' : 'var(--green)', background: retainRaw ? '#fff' : 'var(--mint)' }}>
        <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ maxWidth: 640 }}>
            <h2 style={{ marginBottom: 4 }}>Content review {retainRaw ? <span className="badge ok">On</span> : <span className="badge neutral">Off</span>}</h2>
            {retainRaw ? (
              <p className="hint">Captured prompts <span className="amp">&</span> responses are <b>retained and encrypted at rest</b> so your reviewers can read the actual AI work and sign off on it. Records show the full content on their detail page.</p>
            ) : (
              <p className="hint">Right now captured AI use is logged as <b>hashes only</b> - there&rsquo;s nothing for a reviewer to read. <b>Turn on content review</b> to store the actual prompt <span className="amp">&</span> response (AES-256 encrypted at rest, visible only to members who can view logs) so your team can genuinely review and approve AI work. Recommended for real supervision.</p>
            )}
          </div>
          {isAdmin ? (
            <form action={setContentRetention}>
              <input type="hidden" name="on" value={(!retainRaw).toString()} />
              <SubmitButton className={`btn ${retainRaw ? 'btn-ghost' : 'btn-green'}`} pendingLabel="Saving…">
                {retainRaw ? 'Turn off' : 'Turn on content review'}
              </SubmitButton>
            </form>
          ) : (
            <span className="hint" style={{ alignSelf: 'center' }}>Admins control this setting.</span>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginBottom: 4 }}>Connect your capture clients <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 14 }}>(browser extension · desktop logger)</span></h2>
        <p className="hint" style={{ marginBottom: 4 }}>
          <b>Browser extension</b>{' '}- captures ChatGPT, Claude, Grok, Gemini, and Copilot in the browser in real time, on any account tier.
          Works in Chrome, Edge, Brave, other Chromium browsers, and Firefox (grant site access from the extension popup).
        </p>
        <p className="hint" style={{ marginBottom: 12 }}>
          <b>Desktop logger</b>{' '}- captures the local AI agents the browser can&rsquo;t see: Claude Code (CLI/IDE), Codex CLI, and Claude Desktop
          agent sessions, via a small menubar/tray app for macOS and Windows.
        </p>
        <p className="hint" style={{ marginBottom: 12 }}>
          Install a client, then pair it <b>once</b>{' '}with a connect code: paste the code into the extension popup or the logger&rsquo;s Settings.
          The client keeps its own session, refreshes it automatically, and stays connected - captured turns sync about 30 seconds after they happen.
        </p>
        <DesktopConnectCode />
      </div>
      {!isAdmin && <div className="callout">Connecting enterprise workspaces is admin-only - ask your firm admin. The capture clients above work for every member.</div>}

      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Enterprise workspaces</h2>
        <p className="hint" style={{ marginBottom: 16 }}>Provider Compliance/audit APIs (enterprise seats). Keys are encrypted at rest; content is hashed, not stored. Adapters are validated against documented API shapes - confirm capture with a real workspace before relying on it.</p>
        {PROVIDERS.map((p) => {
          const c = byProvider.get(p.id)
          return (
            <div key={p.id} style={{ borderTop: '1px solid var(--line)', padding: '14px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <strong style={{ color: 'var(--navy)' }}>{p.label}</strong>
                  {c ? <span className={`badge ${c.status === 'connected' ? 'ok' : 'warn'}`} style={{ marginLeft: 8 }}>{c.status}</span>
                    : p.comingSoon ? <span className="badge neutral" style={{ marginLeft: 8 }}>coming soon</span>
                    : <span className="badge neutral" style={{ marginLeft: 8 }}>not connected</span>}
                  <div className="hint" style={{ marginTop: 3 }}>{p.note}</div>
                  {c?.last_sync_at && <div className="hint">Last sync {new Date(c.last_sync_at).toLocaleString()}{c.last_error ? ` · ${c.last_error}` : ''}</div>}
                </div>
                {c && isAdmin && (
                  <div className="rowflex">
                    <form action={syncNow}><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn btn-ghost btn-sm" pendingLabel="Syncing…">Sync now</SubmitButton></form>
                    <form action={disconnectProvider}><input type="hidden" name="id" value={c.id} /><SubmitButton className="btn btn-danger btn-sm" pendingLabel="…">Disconnect</SubmitButton></form>
                  </div>
                )}
              </div>
              {!c && isAdmin && !p.comingSoon && (
                <form action={connectProvider} style={{ marginTop: 10 }}>
                  <input type="hidden" name="provider" value={p.id} />
                  <div className="grid grid-2" style={{ maxWidth: 640 }}>
                    <div className="field" style={{ margin: 0 }}><label htmlFor={`s-${p.id}`}>Compliance API key</label><input className="input" id={`s-${p.id}`} name="secret" type="password" placeholder="sk-… / enterprise key" required /></div>
                    <div className="field" style={{ margin: 0 }}><label htmlFor={`r-${p.id}`}>Scope <span className="sub">({p.scopeHint})</span></label><input className="input" id={`r-${p.id}`} name="scope_ref" placeholder="optional" /></div>
                  </div>
                  <SubmitButton className="btn btn-primary btn-sm" pendingLabel="Connecting…" >Connect</SubmitButton>
                </form>
              )}
            </div>
          )
        })}
      </div>

    </>
  )
}
