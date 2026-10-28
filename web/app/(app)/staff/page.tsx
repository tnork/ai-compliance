import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { inviteStaff, acknowledgePolicy, attestWisp } from './actions'
import MemberControls from './MemberControls'
import SubmitButton from '@/components/SubmitButton'
import WispTip from '@/components/WispTip'

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ invited?: string; updated?: string; e?: string }> }) {
  const me = await requireUser()
  const isAdmin = me.role === 'admin'
  const sp = await searchParams
  const supabase = await createClient()

  const [{ data: staff }, { data: activePolicy }, { data: attestations }, { data: wispAcks }] = await Promise.all([
    supabase.from('app_user').select('id, username, email, role, can_view_logs, can_review').order('created_at'),
    // The ACTIVE policy is the adopted one - acknowledgements of a draft are not §10.36 evidence.
    supabase.from('policy').select('id, title, status, inputs, version').eq('status', 'adopted').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('attestation').select('user_id, policy_id, policy_version_no'),
    supabase.from('wisp_attestation').select('user_id'),
  ])

  // "Acknowledged" means the CURRENT version (0031: attestations are a
  // version-aware append-only log; a saved edit bumps the head and everyone
  // re-acknowledges - older acknowledgements stay on record on the policy page).
  const activeHead = activePolicy?.version ?? 1
  const attestedUsers = new Set((attestations || [])
    .filter((a) => a.policy_id === activePolicy?.id && a.policy_version_no === activeHead)
    .map((a) => a.user_id))
  const iAttested = attestedUsers.has(me.id)

  // WISP posture from the adopted policy's "WISP in place?" answer (missing =
  // 'yes', matching createPolicy's default). Members attest they have read the
  // firm's WISP - the plan the AI-use policy is an addendum to.
  const wispDeclared = !!activePolicy && ((activePolicy.inputs as { has_wisp?: string } | null)?.has_wisp ?? 'yes') !== 'no'
  const wispAckedUsers = new Set((wispAcks || []).map((w) => w.user_id))
  const iWispAcked = wispAckedUsers.has(me.id)

  // Active Monitor per member: has this person synced ANY web-extension or
  // desktop-logger capture? ai_event SELECT is view-logs-gated, so this uses
  // the same sanctioned narrow service-role read as the dashboard: count-only
  // per member, pinned to the caller's own firm - it reveals nothing beyond
  // connected yes/no, the firm's watcher-coverage signal (§10.36).
  const admin = createAdminClient()
  const monitorChecks = await Promise.all((staff || []).map(async (s) => {
    const { count } = await admin
      .from('ai_event').select('*', { count: 'exact', head: true })
      .eq('firm_id', me.firm_id).eq('user_id', s.id).in('source', ['extension', 'desktop_agent'])
    return [s.id, (count ?? 0) > 0] as const
  }))
  const monitorConnected = new Map(monitorChecks)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">STAFF &amp; SIGN-OFFS</div>
          <h1>Staff</h1>
          <p>Invite your team and collect their acknowledgment of the active AI-use policy - the §10.36 evidence that procedures are actually followed.</p>
        </div>
      </div>

      {sp.invited && (
        <div className="msg ok" role="status" style={{ maxWidth: 720 }}>
          Invite sent. They&rsquo;ll get an email with a link to set their password and join the firm.
        </div>
      )}
      {sp.updated && <div className="msg ok" role="status" style={{ maxWidth: 720 }}>Member permissions updated.</div>}
      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      {activePolicy && !iAttested && (
        <div className="callout">
          <div className="rowflex" style={{ justifyContent: 'space-between' }}>
            <div><b>Acknowledge the active policy:</b> {activePolicy.title} <span className="hint">(v{activeHead})</span></div>
            <form action={acknowledgePolicy}><input type="hidden" name="policy_id" value={activePolicy.id} /><input type="hidden" name="version" value={activeHead} /><SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">I acknowledge</SubmitButton></form>
          </div>
        </div>
      )}

      {wispDeclared && !iWispAcked && (
        <div className="callout">
          <div className="rowflex" style={{ justifyContent: 'space-between' }}>
            <div>
              <b>Acknowledge the firm&rsquo;s WISP</b><WispTip />
              <div className="hint" style={{ marginTop: 2 }}>Confirm you have read the firm&rsquo;s Written Information Security Plan (WISP) - the security plan the AI-use policy adds to.</div>
            </div>
            <form action={attestWisp}><SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">I acknowledge</SubmitButton></form>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card" style={{ marginBottom: 20 }}>
          <h2 style={{ marginBottom: 14 }}>Invite a staff member</h2>
          <form action={inviteStaff}>
            <div className="grid grid-3" style={{ marginBottom: 14 }}>
              <div className="field" style={{ marginBottom: 0 }}><label htmlFor="email">Work email</label><input className="input" id="email" name="email" type="email" placeholder="associate@firm.com" required /></div>
              <div className="field" style={{ marginBottom: 0 }}><label htmlFor="username">Name / username</label><input className="input" id="username" name="username" placeholder="Optional" /></div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="role">Role</label>
                <select className="select" id="role" name="role" defaultValue="staff">
                  <option value="staff">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>
            <p className="hint" style={{ margin: '0 0 14px' }}>Admins can invite <span className="amp">&amp;</span> manage members and have full access. Users start with none of the log permissions - grant View logs / Review below after they join.</p>
            <SubmitButton className="btn btn-primary" pendingLabel="Inviting…">Invite</SubmitButton>
          </form>
        </div>
      )}

      <div className="card">
        {isAdmin && (
          <p className="hint" style={{ margin: '0 0 14px' }}>
            Everyone can view the active policy and record their own sign-off. <b>View logs</b> lets a member see the supervision records and coverage; <b>Review <span className="amp">&amp;</span> approve</b> lets them log and sign off on AI work. Admins have both. You decide who gets each.
          </p>
        )}
        <table className="table">
          <thead><tr><th>Member</th><th>Email</th>{isAdmin ? <th style={{ minWidth: 380 }}>Role <span className="amp">&amp;</span> permissions</th> : <th>Role</th>}<th>Active policy{activePolicy ? ` (v${activeHead})` : ''}</th><th>WISP</th><th>Active monitor</th></tr></thead>
          <tbody>
            {(staff || []).map((s) => (
              <tr key={s.id}>
                <td className="t-key">{s.username || '-'}{s.id === me.id ? <span className="hint" style={{ fontWeight: 400 }}> · you</span> : null}</td>
                <td>{s.email}</td>
                {isAdmin
                  ? <td><MemberControls userId={s.id} role={s.role} canViewLogs={!!s.can_view_logs} canReview={!!s.can_review} isSelf={s.id === me.id} /></td>
                  : <td><span className="badge neutral">{s.role === 'admin' ? 'Admin' : 'User'}</span></td>}
                <td>{activePolicy ? <span className={`badge ${attestedUsers.has(s.id) ? 'ok' : 'warn'}`}>{attestedUsers.has(s.id) ? 'Acknowledged' : 'Pending'}</span> : <span className="hint">no policy yet</span>}</td>
                <td>{wispDeclared ? <span className={`badge ${wispAckedUsers.has(s.id) ? 'ok' : 'warn'}`}>{wispAckedUsers.has(s.id) ? 'Acknowledged' : 'Pending'}</span> : <span className="hint">{activePolicy ? 'not in place' : 'no policy yet'}</span>}</td>
                <td><span className={`badge ${monitorConnected.get(s.id) ? 'ok' : 'warn'}`}>{monitorConnected.get(s.id) ? 'Yes' : 'Not yet'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
