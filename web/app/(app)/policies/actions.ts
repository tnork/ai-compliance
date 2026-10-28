'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { renderPolicy, type PolicyInputs } from '@/lib/policy'
import { sanitizePolicyHtml } from '@/lib/policy-html'

export async function createPolicy(formData: FormData) {
  const inputs: PolicyInputs = {
    firm: String(formData.get('firm') || '').trim(),
    officer: String(formData.get('officer') || '').trim(),
    size: String(formData.get('size') || 'a small firm (2-10 staff)'),
    tools: formData.getAll('tools').map(String),
    // runtime-allowlisted, not just cast (Codex P2): a forged value like
    // 'unknown' must never persist - downstream WISP/stance logic branches on
    // exact values and the attest_wisp() RPC allowlists 'yes'.
    personal_ai_stance: ((['watcher', 'prohibited', 'approved', 'ungoverned'] as const).find((v) => v === formData.get('personal_ai_stance')) ?? 'watcher'),
    pii_entered: formData.get('pii_entered') === 'yes' ? 'yes' : 'no',
    has_wisp: formData.get('has_wisp') === 'no' ? 'no' : 'yes',
    // Optional AUP intake (default 'no'): AI Compliance references, never generates, an AUP.
    has_aup: formData.get('has_aup') === 'yes' ? 'yes' : 'no',
    effective_date: String(formData.get('effective_date') || ''),
  }
  const draft_html = renderPolicy(inputs)
  const title = `${inputs.firm || 'Firm'} - AI Use Policy`

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('policy')
    .insert({ title, inputs, draft_html, status: 'draft' })
    .select('id')
    .single()
  if (error || !data) redirect('/policies?e=' + encodeURIComponent('Could not save the policy. Please try again.'))
  // Record the initial version (v1) so history + versioning start from creation.
  // draft_html is rendered from escaped inputs, so it's already safe; sanitize
  // anyway for a single, consistent write path. A v1 failure ROLLS BACK the
  // policy row (Codex P2) - a policy without its immutable initial version
  // would break version history and acknowledgement evidence.
  const { error: verErr } = await supabase.rpc('save_policy_version', {
    p_policy_id: data.id, p_title: title, p_body_html: sanitizePolicyHtml(draft_html), p_note: 'Created',
  })
  if (verErr) {
    await supabase.from('policy').delete().eq('id', data.id)
    redirect('/policies?e=' + encodeURIComponent('Could not save the policy. Please try again.'))
  }
  redirect(`/policies/${data.id}`)
}

// Save an edited policy document as a NEW head version. Called from the client
// with the contenteditable innerHTML, so it takes an object (not FormData). All
// integrity-critical work is in the save_policy_version RPC (0022): version
// numbering under an advisory lock, creator-or-admin gate, edited_by forced to
// the caller. We sanitize the untrusted HTML here before it is stored.
export async function savePolicyVersion(
  args: { policyId: string; title?: string; bodyHtml: string; note?: string }
): Promise<{ version: number } | { error: string }> {
  const clean = sanitizePolicyHtml(args.bodyHtml || '')
  if (!clean) return { error: 'The policy document cannot be empty.' }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('save_policy_version', {
    p_policy_id: args.policyId,
    p_title: args.title?.trim() || null,
    p_body_html: clean,
    p_note: args.note?.trim() || null,
  })
  if (error) return { error: error.message }
  revalidatePath(`/policies/${args.policyId}`)
  revalidatePath('/policies')
  return { version: data as number }
}

export async function adoptPolicy(formData: FormData) {
  const supabase = await createClient()
  const id = String(formData.get('id'))
  const { error } = await supabase.from('policy').update({ status: 'adopted' }).eq('id', id)
  if (error) redirect(`/policies/${id}?e=` + encodeURIComponent('Could not adopt this policy (you may not have permission).'))
  revalidatePath(`/policies/${id}`)
  revalidatePath('/policies')
}

export async function deletePolicy(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.from('policy').delete().eq('id', String(formData.get('id')))
  if (error) redirect('/policies?e=' + encodeURIComponent('Could not delete this policy (you may not have permission).'))
  revalidatePath('/policies')
  redirect('/policies')
}
