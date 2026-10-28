import { requireReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import SubmitButton from '@/components/SubmitButton'
import { logReview } from '../actions'

// The <60s review-entry flow: one screen, sensible defaults, only three
// hard-required fields (tool, what you verified, signature).
export default async function NewRecordPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireReview()
  const sp = await searchParams
  const supabase = await createClient()
  const { data: tools } = await supabase
    .from('tool_register')
    .select('tool_name')
    .eq('status', 'approved')
    .order('tool_name')

  // datetime-local wants "YYYY-MM-DDTHH:MM" in local time
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">§10.22 / §10.36 · LOG A REVIEW</div>
          <h1>Log a supervised AI work product</h1>
          <p>Record what the AI produced and what you, the person, checked. Prompt <span className="amp">&amp;</span> output text is hashed on save - the text itself is not stored.</p>
        </div>
      </div>

      {sp.e && <div className="msg err" role="alert" style={{ maxWidth: 720 }}>{sp.e}</div>}

      <div className="card" style={{ maxWidth: 860 }}>
        <form action={logReview}>
          <div className="grid grid-3">
            <div className="field">
              <label htmlFor="tool">AI tool</label>
              <input className="input" id="tool" name="tool" list="approved-tools" placeholder="ChatGPT" required />
              <datalist id="approved-tools">
                {(tools ?? []).map((t) => <option key={t.tool_name} value={t.tool_name} />)}
              </datalist>
            </div>
            <div className="field"><label htmlFor="model">Model (optional)</label><input className="input" id="model" name="model" placeholder="GPT-5" /></div>
            <div className="field"><label htmlFor="occurred_at">When it was used</label><input className="input" id="occurred_at" name="occurred_at" type="datetime-local" defaultValue={local} /></div>
          </div>

          <div className="grid grid-3">
            <div className="field"><label htmlFor="client_ref">Client (optional)</label><input className="input" id="client_ref" name="client_ref" placeholder="Client or engagement ref" /></div>
            <div className="field"><label htmlFor="matter_ref">Matter (optional)</label><input className="input" id="matter_ref" name="matter_ref" placeholder="Return / matter ref" /></div>
            <div className="field">
              <label htmlFor="data_kind">Work type</label>
              <select className="select" id="data_kind" name="data_kind" defaultValue="research">
                <option value="research">Research</option>
                <option value="return_prep">Return prep</option>
                <option value="written_advice">Written advice (§10.37)</option>
                <option value="client_communication">Client communication</option>
                <option value="bookkeeping">Bookkeeping</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="prompt_text">What was the AI asked? <span className="sub">(hashed, not stored)</span></label>
            <textarea className="input" id="prompt_text" name="prompt_text" rows={3} placeholder="Paste or summarize the prompt" />
          </div>
          <div className="field">
            <label htmlFor="output_text">What did it produce? <span className="sub">(hashed, not stored)</span></label>
            <textarea className="input" id="output_text" name="output_text" rows={3} placeholder="Paste or summarize the output" />
          </div>

          <div className="grid grid-3">
            <div className="field">
              <label htmlFor="data_sensitivity">Data sensitivity</label>
              <select className="select" id="data_sensitivity" name="data_sensitivity" defaultValue="none">
                <option value="none">None</option>
                <option value="pii">PII</option>
                <option value="phi">PHI</option>
                <option value="privileged">Privileged</option>
              </select>
            </div>
            <label className="checkline" style={{ alignSelf: 'end', marginBottom: 16 }}><input type="checkbox" name="pii_included" /> Client PII was included</label>
          </div>

          <div className="field">
            <label htmlFor="verification_notes">What did you verify?</label>
            <textarea className="input" id="verification_notes" name="verification_notes" rows={3} required
              placeholder="Checked figures against the client's source documents; confirmed citations; corrected the §179 limit" />
          </div>

          <label className="checkline"><input type="checkbox" name="edited" /> I edited the AI&rsquo;s output before use</label>
          <label className="checkline"><input type="checkbox" name="verified_accurate" defaultChecked /> I verified the output is accurate for this engagement</label>

          <div className="grid grid-3" style={{ marginTop: 10 }}>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="assumptions_ref">Assumptions relied on <span className="sub">(written advice only)</span></label>
              <input className="input" id="assumptions_ref" name="assumptions_ref" placeholder="Facts / assumptions the advice relies on" />
            </div>
            <label className="checkline" style={{ alignSelf: 'end', marginBottom: 16 }}><input type="checkbox" name="reviewer_confirmed_assumptions" /> I confirmed the assumptions</label>
          </div>

          <div className="field" style={{ maxWidth: 340 }}>
            <label htmlFor="approval_signature">Sign approval - type your full name</label>
            <input className="input" id="approval_signature" name="approval_signature" defaultValue={me.username ?? ''} autoComplete="name" required />
          </div>

          <SubmitButton className="btn btn-primary" pendingLabel="Signing &amp; chaining…"><span>Sign <span className="amp">&amp;</span> record review</span></SubmitButton>
          <p className="hint" style={{ marginTop: 12 }}>
            Saved records are append-only and hash-chained; corrections are logged as new records. Not legal or tax advice.
          </p>
        </form>
      </div>
    </>
  )
}
