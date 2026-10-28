import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { renderPolicy, type PolicyInputs } from '@/lib/policy'
import { sanitizePolicyHtml } from '@/lib/policy-html'
import { diffPolicyHtml } from '@/lib/policy-diff'
import { acknowledgePolicy } from '../../staff/actions'
import SubmitButton from '@/components/SubmitButton'
import PolicyDoc, { type VersionEntry } from './PolicyDoc'

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })

export default async function PolicyDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string; e?: string; diff?: string }> }) {
  const { id } = await params
  const sp = await searchParams
  const me = await requireUser()
  const supabase = await createClient()

  const { data: p } = await supabase
    .from('policy').select('id, title, status, inputs, created_by, version').eq('id', id).single()
  if (!p) notFound()
  const canEdit = me.role === 'admin' || p.created_by === me.id

  const [{ data: vrows }, { data: members }, { data: acks }] = await Promise.all([
    supabase.from('policy_version').select('version, note, edited_by, created_at')
      .eq('policy_id', id).order('version', { ascending: false }),
    supabase.from('app_user').select('id, username'),
    // full acknowledgement log for this policy (0031: version-aware, append-only)
    supabase.from('attestation').select('user_id, policy_version_no, acknowledged_at')
      .eq('policy_id', id).order('acknowledged_at', { ascending: true }),
  ])
  const versionsRaw = vrows ?? []
  const headVersion = versionsRaw.length ? versionsRaw[0].version : (p.version ?? 1)
  const reqV = sp.v ? parseInt(sp.v, 10) : headVersion
  const selectedVersion = versionsRaw.some((v) => v.version === reqV) ? reqV : headVersion

  const nameOf = (uid: string | null) => (members ?? []).find((m) => m.id === uid)?.username ?? '-'
  const versions: VersionEntry[] = versionsRaw.map((v) => ({
    version: v.version, note: v.note, editor: nameOf(v.edited_by), createdAt: v.created_at,
  }))

  // selected version body; fall back to rendering from inputs if empty (legacy /
  // null-draft rows). Sanitize on render too (defense-in-depth over stored HTML).
  const bodyOf = async (version: number): Promise<string> => {
    const { data: sv } = await supabase
      .from('policy_version').select('body_html').eq('policy_id', id).eq('version', version).maybeSingle()
    return sv?.body_html ?? ''
  }
  let bodyHtml = versionsRaw.some((v) => v.version === selectedVersion) ? await bodyOf(selectedVersion) : ''
  if (!bodyHtml.trim()) bodyHtml = renderPolicy(p.inputs as PolicyInputs)
  bodyHtml = sanitizePolicyHtml(bodyHtml)

  // "What changed" - the selected version vs the one before it.
  const prevVersion = versionsRaw.map((v) => v.version).filter((v) => v < selectedVersion).sort((a, b) => b - a)[0]
  const showDiff = sp.diff === '1' && !!prevVersion
  let diffHtml: string | null = null
  if (showDiff) diffHtml = diffPolicyHtml(sanitizePolicyHtml(await bodyOf(prevVersion)), bodyHtml)
  const selMeta = versionsRaw.find((v) => v.version === selectedVersion)

  // Acknowledgement log grouped per version: which members attested to each
  // version, and the window that version was current (created → next version).
  const ackRows = acks ?? []
  const iAckedHead = ackRows.some((a) => a.user_id === me.id && a.policy_version_no === headVersion)
  const memberCount = (members ?? []).length
  const ackGroups = versionsRaw.map((v, i) => ({
    version: v.version,
    from: v.created_at,
    to: i > 0 ? versionsRaw[i - 1].created_at : null, // null = still current
    entries: ackRows.filter((a) => a.policy_version_no === v.version),
  }))
  const legacyAcks = ackRows.filter((a) => a.policy_version_no == null)

  return (
    <>
      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 820, marginBottom: 12 }}>{sp.e}</div>}

      {p.status === 'adopted' && selectedVersion === headVersion && !iAckedHead && (
        <div className="callout" style={{ maxWidth: 820 }}>
          <div className="rowflex" style={{ justifyContent: 'space-between' }}>
            <div><b>You&rsquo;re reading the current version (v{headVersion}).</b><div className="hint" style={{ marginTop: 2 }}>Once you&rsquo;ve read it, record your acknowledgement - it&rsquo;s logged against this version.</div></div>
            <form action={acknowledgePolicy}>
              <input type="hidden" name="policy_id" value={p.id} />
              <input type="hidden" name="version" value={headVersion} />
              <SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">I acknowledge</SubmitButton>
            </form>
          </div>
        </div>
      )}

      <PolicyDoc
        policyId={id}
        status={p.status}
        canEdit={canEdit}
        bodyHtml={bodyHtml}
        selectedVersion={selectedVersion}
        headVersion={headVersion}
        versions={versions}
      />

      {prevVersion && (
        <section className="card" style={{ maxWidth: 820, marginTop: 18 }} aria-label="Changes in this version">
          <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Changes in v{selectedVersion} <span className="hint" style={{ fontWeight: 400 }}>vs v{prevVersion}{selMeta ? ` · ${nameOf(selMeta.edited_by)} · ${fmtDate(selMeta.created_at)}` : ''}</span></h3>
            <Link className="btn btn-ghost btn-sm" href={`/policies/${id}?v=${selectedVersion}${showDiff ? '' : '&diff=1'}`}>
              {showDiff ? 'Hide changes' : 'Show changes'}
            </Link>
          </div>
          {showDiff && (
            diffHtml
              ? <div className="policy-diff" style={{ marginTop: 12 }} dangerouslySetInnerHTML={{ __html: diffHtml }} />
              : <p className="hint" style={{ margin: '12px 0 0' }}>No text changes between v{prevVersion} and v{selectedVersion}.</p>
          )}
        </section>
      )}

      <section className="card" style={{ maxWidth: 820, marginTop: 18 }} aria-label="Acknowledgements">
        <h3 style={{ margin: 0 }}>Acknowledgements</h3>
        <p className="hint" style={{ margin: '4px 0 0' }}>
          Every acknowledgement is logged against the version the member read - nothing is overwritten when the policy changes. A saved edit creates a new version and re-opens the cycle.
        </p>
        {ackRows.length === 0 && <p className="hint" style={{ margin: '14px 0 0' }}>No acknowledgements recorded yet{p.status !== 'adopted' ? ' - the policy has to be adopted before members can acknowledge it' : ''}.</p>}
        {ackGroups.filter((g) => g.entries.length > 0 || g.version === headVersion).map((g) => (
          <div key={g.version} style={{ marginTop: 16 }}>
            <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <b>v{g.version}{g.version === headVersion ? ' · current' : ''}</b>
              <span className="hint">
                {g.to ? `current ${fmtDate(g.from)} - ${fmtDate(g.to)}` : `current since ${fmtDate(g.from)}`}
                {' · '}
                {g.version === headVersion
                  ? `${new Set(g.entries.map((e) => e.user_id)).size} of ${memberCount} member${memberCount === 1 ? '' : 's'} acknowledged`
                  : `${new Set(g.entries.map((e) => e.user_id)).size} acknowledged`}
              </span>
            </div>
            {g.entries.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--muted)', fontSize: 14 }}>
                {g.entries.map((e, idx) => (
                  <li key={idx}>{nameOf(e.user_id)} · {fmtDate(e.acknowledged_at)}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {legacyAcks.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <b>Earlier acknowledgements</b> <span className="hint">(recorded before version tracking)</span>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--muted)', fontSize: 14 }}>
              {legacyAcks.map((e, idx) => <li key={idx}>{nameOf(e.user_id)} · {fmtDate(e.acknowledged_at)}</li>)}
            </ul>
          </div>
        )}
      </section>
    </>
  )
}
