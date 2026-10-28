import InfoTip from './InfoTip'

// The one canonical WISP explainer (founder-approved copy, confirmed figures
// only). Reuse this anywhere the app says
// "WISP" so the explanation never drifts between surfaces.
export default function WispTip() {
  return (
    <InfoTip label="What is a WISP?">
      <span style={{ display: 'block', marginBottom: 8 }}><strong>WISP stands for Written Information Security Plan.</strong></span>
      <span style={{ display: 'block', marginBottom: 8 }}>It&rsquo;s a written document that federal law requires every professional tax preparer to have. The FTC Safeguards Rule (under the Gramm-Leach-Bliley Act) treats tax preparers as &ldquo;financial institutions,&rdquo; so anyone with a PTIN must maintain a WISP describing how they protect client data - access controls, encryption, incident response, employee training, and so on. The IRS confirms this on the annual PTIN renewal.</span>
      <span style={{ display: 'block', marginBottom: 8 }}>Failure to comply with the Safeguards Rule can carry FTC penalties of roughly $53,088 per violation.</span>
      <span style={{ display: 'block', marginBottom: 8 }}>A firm&rsquo;s WISP has to account for where client data flows. AI tools are a new data flow, so supervised, documented AI use (approved tools, PII rules, personal-account boundaries) is what keeps the WISP honest - which is why this policy&rsquo;s PII-handling and shadow-AI sections map to it.</span>
      <span style={{ display: 'block' }}>WISP obligations are about data security (§7216/§6713 disclosure penalties, FTC enforcement), a separate legal track from Circular 230&rsquo;s supervision duties (§§10.22/10.36) - AI Compliance&rsquo;s record covers evidence for both.</span>
    </InfoTip>
  )
}
