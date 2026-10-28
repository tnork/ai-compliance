import { requireUser } from '@/lib/auth'
import { PLANS } from '@/lib/plans'
import { startCheckout } from './actions'
import SubmitButton from '@/components/SubmitButton'

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ stub?: string }> }) {
  await requireUser()
  const sp = await searchParams

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">BILLING</div>
          <h1>Plans</h1>
          <p>Start free with the policy generator. Upgrade for review records, packet exports, staff tracking, and coverage reporting.</p>
        </div>
      </div>

      {sp.stub && (
        <div className="msg ok" role="status" style={{ maxWidth: 720 }}>
          Thanks - <b>{PLANS.find((p) => p.id === sp.stub)?.name}</b> noted. Online checkout isn&rsquo;t live yet; we&rsquo;ll reach out to set up your plan and onboarding. Questions? Email <a href="mailto:hello@example.com">hello@example.com</a>.
        </div>
      )}

      <div className="grid grid-3">
        {PLANS.map((p) => (
          <div key={p.id} className="card" style={p.featured ? { borderColor: 'var(--navy)', boxShadow: 'var(--shadow)' } : undefined}>
            <div className="rowflex" style={{ justifyContent: 'space-between' }}>
              <h3>{p.name}</h3>
              {p.featured && <span className="badge neutral">Most firms</span>}
            </div>
            <p className="hint" style={{ minHeight: 40, marginTop: 6 }}>{p.blurb}</p>
            <div style={{ margin: '14px 0 2px' }}><span style={{ fontSize: 34, fontWeight: 900, letterSpacing: '-.03em', color: 'var(--navy)' }}>${p.price}</span><span className="hint"> /mo · {p.seats}</span></div>
            <div className="hint" style={{ marginBottom: 2 }}>or ${(p.price * 10).toLocaleString()}/year</div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '16px 0 18px', display: 'grid', gap: 8 }}>
              {p.features.map((f) => (
                <li key={f} style={{ fontSize: 14, color: 'var(--ink)', display: 'flex', gap: 8 }}>
                  <span aria-hidden="true" style={{ color: 'var(--green-deep)', fontWeight: 800 }}>✓</span>{f}
                </li>
              ))}
            </ul>
            <form action={startCheckout}>
              <input type="hidden" name="plan" value={p.id} />
              <SubmitButton className={`btn btn-block ${p.featured ? 'btn-green' : 'btn-ghost'}`} pendingLabel="One moment…">Choose {p.name}</SubmitButton>
            </form>
          </div>
        ))}
      </div>
    </>
  )
}
