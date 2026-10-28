import { requireUser } from '@/lib/auth'
import { createPolicy } from '../actions'
import OtherTools from '@/components/OtherTools'
import WispTip from '@/components/WispTip'
import AupTip from '@/components/AupTip'
import SubmitButton from '@/components/SubmitButton'

// DOM order renders row-major in the 2-col grid: left column ChatGPT/Claude/
// Grok, right column Gemini above Copilot (founder-specified order). "Other or
// Local" entries (incl. local LLMs) are added below via <OtherTools/>.
const TOOLS = ['ChatGPT (OpenAI)', 'Google Gemini', 'Claude (Anthropic)', 'Microsoft Copilot', 'Grok (xAI)']

export default async function NewPolicyPage() {
  const u = await requireUser()
  const today = new Date().toISOString().slice(0, 10)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">GENERATE</div>
          <h1>New AI-use policy</h1>
          <p>A Circular-230-mapped draft for discussion. Not legal advice - review with counsel before adoption.</p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 720 }}>
        <form action={createPolicy}>
          <div className="grid grid-2">
            <div className="field"><label htmlFor="firm">Firm name</label><input className="input" id="firm" name="firm" defaultValue={u.firmName} required /></div>
            <div className="field"><label htmlFor="officer">AI responsible person</label><input className="input" id="officer" name="officer" placeholder="Jane Smith, CPA" /></div>
          </div>
          <div className="field"><label htmlFor="size">Firm size</label>
            <select className="select" id="size" name="size" defaultValue="a small firm (2-10 staff)">
              <option>a solo practitioner</option>
              <option>a small firm (2-10 staff)</option>
              <option>a firm (11-20 staff)</option>
              <option>a multi-office firm (20+ staff)</option>
            </select>
          </div>

          <div className="field">
            <label>AI tools used for firm work</label>
            <div className="grid grid-2" style={{ gap: 8, marginTop: 6 }}>
              {TOOLS.map((t) => (
                <label key={t} className="checkline"><input type="checkbox" name="tools" value={t} defaultChecked={t.startsWith('ChatGPT')} /> {t}</label>
              ))}
            </div>
            <OtherTools />
          </div>

          <div className="field">
            <label htmlFor="personal_ai_stance">Personal-account / personal-device AI use</label>
            <select className="select" id="personal_ai_stance" name="personal_ai_stance" defaultValue="watcher">
              <option value="watcher">Allowed if the monitoring agent is installed</option>
              <option value="prohibited">Prohibited - firm-approved tools only</option>
              <option value="approved">Allowed only if approved &amp; logged</option>
              <option value="ungoverned">Happening informally / not yet governed</option>
            </select>
          </div>

          <div className="grid grid-3">
            <div className="field"><label htmlFor="pii_entered">Client PII in AI tools?</label>
              <select className="select" id="pii_entered" name="pii_entered" defaultValue="no"><option value="no">No / not allowed</option><option value="yes">Yes, approved tools only</option></select>
            </div>
            <div className="field"><label htmlFor="has_wisp">WISP in place?<WispTip /></label>
              <select className="select" id="has_wisp" name="has_wisp" defaultValue="yes"><option value="yes">Yes</option><option value="no">Not yet</option></select>
            </div>
            <div className="field"><label htmlFor="has_aup">Acceptable Use Policy?<AupTip /></label>
              <select className="select" id="has_aup" name="has_aup" defaultValue="no"><option value="yes">Yes</option><option value="no">Not yet</option></select>
            </div>
          </div>
          <div className="field"><label htmlFor="effective_date">Effective date</label><input className="input" id="effective_date" name="effective_date" type="date" defaultValue={today} /></div>

          <SubmitButton className="btn btn-primary" pendingLabel="Generating…"><span>Generate <span className="amp">&amp;</span> save</span></SubmitButton>
        </form>
      </div>
    </>
  )
}
