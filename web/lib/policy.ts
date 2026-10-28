// Circular 230 AI-use policy renderer (condensed TS port of the standalone generator).
// Grounded only in verified facts (OPR Alert 2026-19; Circular 230 §§; WISP/Pub 5708).
// DRAFT - pending attorney review; evidence tooling, not legal advice.

export type PolicyInputs = {
  firm: string
  officer: string
  size: string
  tools: string[]
  personal_ai_stance: 'watcher' | 'prohibited' | 'approved' | 'ungoverned'
  pii_entered: 'yes' | 'no'
  has_wisp: 'yes' | 'no'
  // Optional: whether the firm has a general Acceptable Use Policy. AI Compliance does
  // not generate an AUP; when 'yes' the rendered policy notes it supplements one.
  // Optional in the type so older stored `inputs` (pre-AUP) still render.
  has_aup?: 'yes' | 'no'
  effective_date: string
}

const esc = (s: string) =>
  (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))

function stanceClause(s: PolicyInputs['personal_ai_stance']): string {
  switch (s) {
    case 'watcher':
      return 'Staff may use their own AI accounts and personal-device tools (including local LLMs) for firm work <strong>provided</strong> the firm’s approved AI monitoring agent is installed and active, so every AI-assisted work product is captured into the supervision record. Client PII may be entered only where the tool is approved for that data class (Section 2); monitoring documents supervision but does not by itself make a personal consumer account appropriate for confidential client data.'
    case 'prohibited':
      return 'Staff <strong>must not</strong> use personal AI accounts or personal-device tools (including local LLMs) for any client work. Only firm-approved tools on the register may be used.'
    case 'approved':
      return 'Personal accounts or personal-device tools (including local LLMs) may be used for client work <strong>only</strong> where the specific tool has been vetted and added to the approved-tool register and each use is recorded. The data-handling rules in Section 2 apply in full.'
    default:
      return 'The firm is bringing informal ("shadow") AI use under this policy. Until a tool is vetted and approved, staff must not use personal AI accounts or personal-device tools for client work, and must disclose any AI tool currently used so it can be assessed.'
  }
}

export function renderPolicy(i: PolicyInputs): string {
  const firm = esc(i.firm) || '[Firm Name]'
  const officer = esc(i.officer) || '[Designated AI Responsible Person]'
  const eff = i.effective_date
    ? new Date(i.effective_date + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : '__________'
  const toolList = i.tools.length
    ? '<ul>' + i.tools.map((t) => `<li>${esc(t)}</li>`).join('') + '</ul>'
    : '<p>No AI tools are currently approved. Any tool must be vetted and approved before use in client work.</p>'
  const piiClause =
    i.pii_entered === 'yes'
      ? 'Client PII may be entered <strong>only</strong> into tools on the approved-tool register vetted for that purpose.'
      : 'Client PII <strong>must not</strong> be entered into any general-purpose AI tool.'
  const wispClause =
    i.has_wisp === 'yes'
      ? 'The firm maintains a WISP (FTC Safeguards Rule, IRS Pub 5708); this policy is an addendum to it, and all personnel must read and acknowledge the WISP.'
      : 'The firm is establishing a WISP (FTC Safeguards Rule, IRS Pub 5708); AI tools must be incorporated into it, and all personnel must read and acknowledge it once adopted.'
  // Optional AUP reference (only when the firm attests it has one). AI Compliance does
  // not generate an AUP - this only notes the AI policy supplements an existing one.
  const aupClause =
    i.has_aup === 'yes'
      ? '<p>Where the firm maintains a general Acceptable Use Policy (AUP) governing its technology and systems, this AI-use policy supplements that AUP; both apply to AI tools used in client work.</p>'
      : ''

  return `
<h1>${firm} - Artificial Intelligence Use Policy</h1>
<p class="doc-sub">Circular 230 · Federal Tax Practice · v1.0 (DRAFT) · Effective ${eff} · Responsible person: ${officer}</p>
<div class="doc-draft">DRAFT - pending attorney review. Template only; not legal or tax advice.</div>

<h2>1. Purpose &amp; Scope <span>OPR 2026-19</span></h2>
<p>This policy governs AI use in the federal tax practice of ${firm}, ${esc(i.size)}. It responds to IRS OPR Alert 2026-19, applying Circular 230 to AI, and applies to all staff, whether the tool is firm-provided or a personal account or device.</p>

<h2>2. Approved Tools &amp; Data Handling <span>§10.36 · WISP</span></h2>
${toolList}
<p>${piiClause} ${wispClause} Confidentiality under §10.51 and IRC §§6713/7216 applies to all AI use. No tool may be used in client work until vetted and added to the register by ${officer}.</p>

<h2>3. Personal Accounts, Personal Devices &amp; Shadow AI <span>§10.36 · §10.51</span></h2>
<p>The firm’s §10.36 supervision duty covers <em>all</em> AI used in client work, including personal subscriptions and local LLMs. ${stanceClause(i.personal_ai_stance)}</p>

<h2>4. Human Review &amp; Due Diligence <span>§10.22</span></h2>
<p>A qualified person must verify every AI-assisted work product before reliance - facts, citations, calculations, and fit to the client’s circumstances. Reliance without independent human verification is prohibited.</p>

<h2>5. Competence &amp; Training <span>§10.35</span></h2>
<p>Personnel must understand the tools’ limitations (hallucinations, bias, staleness) and complete AI-use training before using AI on client matters, and periodically after.</p>

<h2>6. Documentation &amp; Recordkeeping <span>§10.36</span></h2>
<p>§10.36 requires the firm to ensure procedures are followed. The firm keeps a record of AI-assisted work - tool, user, reviewer, verification, approval - available to demonstrate supervision.</p>

<h2>7. Roles &amp; Enforcement</h2>
<p>${officer} maintains this policy, the approved-tool register, and the training and review records, and reviews it at least annually and on any material change in IRS guidance. All personnel acknowledge this policy before using AI in client work.</p>
${aupClause}

<p class="doc-foot"><strong>Disclaimer.</strong> Generated by AI Compliance as a template. Not legal or tax advice; does not guarantee compliance. Review with qualified counsel before adoption.</p>`
}
