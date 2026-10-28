import Link from 'next/link'
import { requireUser, canViewLogs, canReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/coverage'
import { logError } from '@/lib/error-log'
import { acknowledgePolicy, attestWisp } from '../staff/actions'
import SubmitButton from '@/components/SubmitButton'

// A Key Action renders ONLY while it is unresolved for the signed-in user -
// once done (policy acknowledged, events reviewed, capture connected) it
// disappears. The card itself hides when there is nothing pending.
type KeyAction = {
  key: string
  title: string
  desc: string
  href?: string
  linkLabel?: string
  ackPolicyId?: string // renders the inline one-click acknowledge form instead of a link
  wispAck?: boolean // renders the inline one-click WISP acknowledge form instead of a link
}

export default async function Dashboard() {
  const u = await requireUser()
  const showLogs = canViewLogs(u)
  const reviewer = canReview(u)
  const isAdmin = u.role === 'admin'
  const supabase = await createClient()

  const [
    { count: policies }, { count: staff }, { count: tools }, { count: accounts }, { count: attestations }, { count: records },
    { data: adoptedPolicy },
    { count: myAccounts },
    { data: firmRow },
    { count: myWispAcks },
  ] = await Promise.all([
    supabase.from('policy').select('*', { count: 'exact', head: true }),
    supabase.from('app_user').select('*', { count: 'exact', head: true }),
    supabase.from('tool_register').select('*', { count: 'exact', head: true }),
    supabase.from('ai_account').select('*', { count: 'exact', head: true }),
    supabase.from('attestation').select('*', { count: 'exact', head: true }),
    showLogs ? supabase.from('ai_event').select('*', { count: 'exact', head: true }) : Promise.resolve({ count: 0 }),
    supabase.from('policy').select('id, title, inputs, version').eq('status', 'adopted').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ai_account').select('*', { count: 'exact', head: true }).eq('user_id', u.id),
    isAdmin ? supabase.from('firm').select('retain_raw_captures').eq('id', u.firm_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from('wisp_attestation').select('*', { count: 'exact', head: true }).eq('user_id', u.id),
  ])

  // Captured events awaiting review: captured (non-manual) events land reviewed=false and are
  // append-only, so "resolved" means a review event REFERENCES them (reviews_event_id). Count by
  // reference (set difference over ids), not by subtracting two aggregate counts - independent
  // aggregates can drift apart and silently hide this required action (Codex P1). fetchAllRows
  // pages past the 1000-row cap, same pattern the records/coverage pages use.
  let pendingReviews = 0
  let reviewCheckFailed = false
  if (reviewer) {
    try {
      type EvRow = { id: string; reviewed: boolean; source: string; reviews_event_id: string | null }
      const evRows = await fetchAllRows<EvRow>(supabase, 'ai_event', 'id, reviewed, source, reviews_event_id', [{ column: 'created_at', ascending: true }])
      const reviewedIds = new Set(evRows.map((r) => r.reviews_event_id).filter(Boolean))
      pendingReviews = evRows.filter((r) => !r.reviewed && r.source !== 'manual' && !reviewedIds.has(r.id)).length
    } catch (e) {
      // Fail loudly to the developer console, and show an uncounted prompt rather
      // than silently hiding a required action behind a transient query failure.
      reviewCheckFailed = true
      await logError(createAdminClient(), { firmId: u.firm_id, source: 'web', message: 'dashboard pending-review check failed', context: { error: String(e) } })
    }
  }

  // Acknowledgements of the ADOPTED policy's CURRENT version (attestations are
  // a version-aware append-only log since 0031): mine, and how many distinct
  // members have acked the head. Older-version acknowledgements stay on record
  // but don't count as current - a saved edit bumps the head and re-opens the
  // cycle for everyone.
  const adoptedHead = adoptedPolicy?.version ?? 1
  let iAcked = true
  let adoptedAcks = 0
  if (adoptedPolicy) {
    const { data: ackRows } = await supabase.from('attestation')
      .select('user_id').eq('policy_id', adoptedPolicy.id).eq('policy_version_no', adoptedHead)
    const ackedUsers = new Set((ackRows ?? []).map((r) => r.user_id))
    iAcked = ackedUsers.has(u.id)
    adoptedAcks = ackedUsers.size
  }

  // WISP posture comes from the ADOPTED policy's generator answer ("WISP in
  // place?") - the policy document is the firm's declaration, so there is no
  // separate firm flag to drift from it. Policies created before the field
  // existed default to 'yes' (createPolicy's default). AI Compliance never stores the
  // WISP itself; members attest they have read it (Pub 5708's own
  // employee-acknowledgment practice), and a firm that answered "not yet" gets
  // an admin encouragement to put one in place instead of an attest prompt.
  const hasWispAnswer = (adoptedPolicy?.inputs as { has_wisp?: string } | null | undefined)?.has_wisp ?? 'yes'
  const wispDeclared = !!adoptedPolicy && hasWispAnswer !== 'no'
  const wispMissing = !!adoptedPolicy && hasWispAnswer === 'no'
  const iWispAcked = (myWispAcks ?? 0) > 0

  // Has any of MY AI use been captured yet (extension or desktop logger)?
  // ai_event SELECT is RLS-gated on log-view permission, which plain members
  // don't have - so this one self-scoped count goes through the service-role
  // client, pinned to the caller's own user_id + firm_id (never cross-tenant,
  // never another member's rows). Sanctioned narrow read: without it this Key
  // Action could never auto-resolve for non-reviewer members.
  const { count: myCaptured } = await createAdminClient()
    .from('ai_event').select('*', { count: 'exact', head: true })
    .eq('firm_id', u.firm_id).eq('user_id', u.id).in('source', ['extension', 'desktop_agent'])

  // Onboarding Setup (formerly Next Steps): a role-shaped checklist, completed
  // steps struck through. Admins get the 7 firm-setup steps; regular users get
  // their 3 personal duties (acknowledge / attest accounts / connect monitor).
  // Once ALL of the viewer's steps are complete, onboarding_done_at is stamped
  // and the card never renders for this user again - even if a condition later
  // regresses, Key Actions keeps surfacing anything required.
  type OnboardingStep = { key: string; done: boolean; href: string; link: string; rest: string }
  let onboardingSteps: OnboardingStep[] | null = null
  if (!u.onboarding_done_at) {
    let steps: OnboardingStep[]
    if (isAdmin) {
      // "Monitor connected" (admin view) = the FIRM has synced at least one
      // captured event. ai_event SELECT is view-logs-gated; admins have it, but
      // keep the same narrow service-role read pattern as myCaptured above:
      // count-only, pinned to the caller's own firm.
      const { count: firmCaptured } = await createAdminClient()
        .from('ai_event').select('*', { count: 'exact', head: true })
        .eq('firm_id', u.firm_id).not('source', 'in', '(manual,in_app)')

      steps = [
        { key: 'generate', done: (policies ?? 0) > 0, href: '/policies/new', link: 'Generate your Circular 230 AI-use policy', rest: '.' },
        { key: 'adopt', done: !!adoptedPolicy, href: '/policies', link: 'Adopt the policy', rest: ' as your firm’s active policy.' },
        // "Collected" means every CURRENT member has acknowledged the adopted
        // policy (distinct ackers >= member count) - solo firms complete via
        // their own acknowledgement. Members hired after the stamp are nagged
        // by their own onboarding + the staff page, not this card (sticky).
        // FAIL CLOSED on a null member count (query error) - an unknown count
        // must never let the permanent stamp land early (Codex P2).
        { key: 'staff', done: !!adoptedPolicy && staff != null && adoptedAcks >= staff, href: '/staff', link: 'Invite staff', rest: ' and collect their sign-offs.' },
        { key: 'tools', done: (tools ?? 0) > 0, href: '/tools', link: 'Vet the AI tools', rest: ' your firm approves, and for what data.' },
        { key: 'accounts', done: (accounts ?? 0) > 0, href: '/accounts', link: 'Confirm the AI accounts', rest: ' your team uses - including personal ones.' },
        // Per-user: EVERY member acknowledges the adopted policy - including the
        // admin who set it up (adopting is not acknowledging). §10.36 evidence.
        { key: 'ack', done: !!adoptedPolicy && iAcked, href: '/staff', link: 'Acknowledge the AI-use policy', rest: ' - every member confirms they have read it, including admins.' },
        // Only when the adopted policy declares a WISP is in place - a firm
        // that answered "not yet" is nagged via Key Actions (get one from your
        // attorney / Pub 5708), not blocked here on an external document.
        ...(wispDeclared ? [{ key: 'wisp', done: iWispAcked, href: '/staff', link: 'Acknowledge the firm’s WISP', rest: ' - the written security plan your AI-use policy adds to.' }] : []),
        { key: 'monitor', done: (firmCaptured ?? 0) > 0, href: '/connections', link: 'Connect the monitor to your AI tools', rest: ' - this clears once the first captured event syncs.' },
      ]
    } else {
      // Non-admin members: personal duties only (firm setup is the admin's).
      // Monitor completion is per-USER here (myCaptured) - each member connects
      // their own capture; the staff page shows who has and hasn't.
      steps = [
        { key: 'ack', done: !!adoptedPolicy && iAcked, href: '/staff', link: 'Acknowledge the AI-use policy', rest: ' - your confirmation that you have read the firm’s policy.' },
        ...(wispDeclared ? [{ key: 'wisp', done: iWispAcked, href: '/staff', link: 'Acknowledge the firm’s WISP', rest: ' - the written security plan the AI-use policy adds to.' }] : []),
        { key: 'accounts', done: (myAccounts ?? 0) > 0, href: '/accounts', link: 'Confirm the AI accounts', rest: ' you use for work - including personal ones.' },
        { key: 'monitor', done: (myCaptured ?? 0) > 0, href: '/connections', link: 'Connect the monitor to your AI tools', rest: ' - this clears once your first captured event syncs.' },
      ]
    }

    if (steps.every((s) => s.done)) {
      // Stamp completion (server-derived, pinned to the caller's own row).
      // Best-effort: a failed write just re-runs on the next dashboard load.
      await createAdminClient().from('app_user')
        .update({ onboarding_done_at: new Date().toISOString() })
        .eq('id', u.id).eq('firm_id', u.firm_id).is('onboarding_done_at', null)
    } else {
      onboardingSteps = steps
    }
  }

  const keyActions: KeyAction[] = [
    ...(isAdmin && !adoptedPolicy ? [{
      key: 'adopt', title: 'Adopt an AI-use policy',
      desc: 'Your firm has no active policy yet - staff can’t acknowledge until one is adopted.',
      href: policies ? '/policies' : '/policies/new', linkLabel: policies ? 'Choose a policy' : 'Generate one',
    }] : []),
    ...(adoptedPolicy && !iAcked ? [{
      key: 'ack', title: `Acknowledge the active policy: ${adoptedPolicy.title} (v${adoptedHead})`,
      desc: adoptedHead > 1
        ? 'The policy has been updated - please re-read the current version. Your §10.36 evidence that procedures are actually followed.'
        : 'Your §10.36 evidence that procedures are actually followed.',
      ackPolicyId: adoptedPolicy.id,
    }] : []),
    ...(wispDeclared && !iWispAcked ? [{
      key: 'wisp-ack', title: 'Acknowledge the firm’s WISP',
      desc: 'Confirm you have read the firm’s Written Information Security Plan (WISP) - the FTC Safeguards Rule plan your AI-use policy adds to.',
      wispAck: true,
    }] : []),
    ...(isAdmin && wispMissing ? [{
      key: 'wisp-missing', title: 'Put a WISP in place',
      desc: 'Your adopted policy says the firm is still establishing its Written Information Security Plan. The FTC Safeguards Rule requires one - ask your attorney to prepare it, or start from the IRS Pub 5708 template. Then generate and adopt an updated policy with “WISP in place: Yes”.',
      href: '/policies/new', linkLabel: 'Update the policy',
    }] : []),
    ...(isAdmin && firmRow && !firmRow.retain_raw_captures ? [{
      key: 'retain', title: 'Turn on content review (prompt logging)',
      desc: 'Captured events are hash-only until you enable it - reviewers can’t read what was asked or answered.',
      href: '/connections', linkLabel: 'Open Connections',
    }] : []),
    ...(reviewer && (pendingReviews > 0 || reviewCheckFailed) ? [{
      key: 'review',
      title: reviewCheckFailed ? 'Check captured AI events' : `Review ${pendingReviews} captured AI event${pendingReviews === 1 ? '' : 's'}`,
      desc: reviewCheckFailed
        ? 'The pending-review count could not be verified just now - open Review records to check directly.'
        : 'Auto-captured AI use is an open §10.22 gap until a human verifies and signs off.',
      href: '/records', linkLabel: 'Review records',
    }] : []),
    ...((myAccounts ?? 0) === 0 ? [{
      key: 'accounts', title: 'Confirm your AI accounts',
      desc: 'List the AI accounts you use for work - including personal ones.',
      href: '/accounts', linkLabel: 'Add accounts',
    }] : []),
    // Resolution rule (deliberate, evidence-first): this clears when the user's FIRST captured
    // event arrives - a capture is the only proof supervision is actually connected. An installed
    // but never-capturing extension is exactly the gap this surfaces. The install/heartbeat signal
    // (agent_enrollment, watcher coverage) is the planned upgrade for install-time resolution.
    ...((myCaptured ?? 0) === 0 ? [{
      key: 'connect', title: 'Connect supervision to your AI accounts',
      desc: `Install the browser extension${isAdmin ? ', desktop logger, or an enterprise connector' : ' or desktop logger'} so your AI use is captured automatically. This clears once your first captured event arrives.`,
      href: '/connections', linkLabel: 'Set up capture',
    }] : []),
  ]

  const stats = [
    // review records are only visible to members with log-view permission
    ...(showLogs ? [{ n: records ?? 0, l: 'Review records', href: '/records' }] : []),
    { n: policies ?? 0, l: 'Policies', href: '/policies' },
    { n: attestations ?? 0, l: 'Sign-offs', href: '/staff' },
    { n: staff ?? 0, l: 'Staff members', href: '/staff' },
    { n: tools ?? 0, l: 'Approved tools', href: '/tools' },
    { n: accounts ?? 0, l: 'AI accounts', href: '/accounts' },
  ]

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">SUPERVISION OVERVIEW</div>
          <h1>{u.firmName}</h1>
          <p>Your firm&rsquo;s AI-supervision record: policies, staff sign-offs, approved tools, and the accounts your team uses.</p>
        </div>
        <Link className="btn btn-green" href="/policies/new">Generate a policy</Link>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 22 }}>
        {stats.map((s) => (
          <Link key={s.l} href={s.href} className="stat" style={{ display: 'block' }}>
            <div className="n">{s.n}</div>
            <div className="l">{s.l}</div>
          </Link>
        ))}
      </div>

      {onboardingSteps && (
        <div className="card" style={{ marginBottom: 22 }}>
          <h3>Onboarding Setup</h3>
          <p className="hint" style={{ margin: '4px 0 0' }}>{isAdmin ? 'Set up your firm’s supervision record.' : 'Your part of the firm’s supervision record.'} Completed steps are crossed off - this card disappears once every step is done.</p>
          <ol style={{ margin: '12px 0 0', paddingLeft: 20, color: 'var(--muted)', lineHeight: 1.9, fontSize: 14.5 }}>
            {onboardingSteps.map((s) => (
              <li key={s.key} style={s.done ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}>
                <Link href={s.href} style={{ color: 'var(--blue-ink)', fontWeight: 600 }}>{s.link}</Link>{s.rest}
                {s.done && <span className="sr-only"> (done)</span>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {keyActions.length > 0 && (
        <div className="card" style={{ marginBottom: 22 }}>
          <h3>Key Actions</h3>
          <p className="hint" style={{ margin: '4px 0 12px' }}>Required items waiting on you - each disappears once it&rsquo;s resolved.</p>
          <div style={{ display: 'grid', gap: 10 }}>
            {keyActions.map((a) => (
              <div key={a.key} className="callout" style={{ margin: 0 }}>
                <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 260, flex: 1 }}>
                    <b>{a.title}</b>
                    <div className="hint" style={{ marginTop: 2 }}>{a.desc}</div>
                  </div>
                  {a.ackPolicyId ? (
                    <form action={acknowledgePolicy}>
                      <input type="hidden" name="policy_id" value={a.ackPolicyId} />
                      <input type="hidden" name="version" value={adoptedHead} />
                      <SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">I acknowledge</SubmitButton>
                    </form>
                  ) : a.wispAck ? (
                    <form action={attestWisp}>
                      <SubmitButton className="btn btn-green btn-sm" pendingLabel="Saving…">I acknowledge</SubmitButton>
                    </form>
                  ) : (
                    <Link className="btn btn-sm" href={a.href!}>{a.linkLabel}</Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </>
  )
}
