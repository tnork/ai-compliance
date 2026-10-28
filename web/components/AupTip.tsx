import InfoTip from './InfoTip'

// Canonical Acceptable Use Policy explainer - keep in sync with the public
// generator's #aupTip (policy-generator/index.html). Honesty guardrail: AI Compliance
// stores/versions the firm's own documents (0034 firm_document) but never
// generates one or judges its legal adequacy.
export default function AupTip() {
  return (
    <InfoTip label="What is an Acceptable Use Policy?">
      <span style={{ display: 'block', marginBottom: 8 }}><strong>AUP stands for Acceptable Use Policy.</strong></span>
      <span style={{ display: 'block', marginBottom: 8 }}>It&rsquo;s a written document that sets the rules for how your staff may use the firm&rsquo;s technology - computers, email, networks, the internet, and increasingly AI tools. It usually spells out what&rsquo;s allowed, what&rsquo;s prohibited, and each person&rsquo;s responsibility for protecting firm and client information.</span>
      <span style={{ display: 'block', marginBottom: 8 }}>It&rsquo;s different from a WISP: a WISP is a data-security plan federal law requires every tax preparer to have, while an Acceptable Use Policy is a broader governance document many firms choose to keep. An AI-use policy often works alongside both.</span>
      <span style={{ display: 'block', marginBottom: 8 }}>In AI Compliance you can upload your Acceptable Use Policy (and other firm documents) under Policies, keep a version history, and have staff acknowledge each version. It&rsquo;s optional - not required to use AI Compliance.</span>
      <span style={{ display: 'block' }}>AI Compliance doesn&rsquo;t write your AUP for you or judge whether a given policy is adequate. Your policies and their legal sufficiency remain your firm&rsquo;s and your counsel&rsquo;s responsibility.</span>
    </InfoTip>
  )
}
