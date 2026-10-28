'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { sha256 } from '@/lib/hashchain'

const str = (fd: FormData, k: string) => String(fd.get(k) || '').trim()

// Log a supervised AI work product. Everything integrity-critical happens in
// the database RPC (migration 0010): attribution is forced to the caller, the
// firm's chain is locked, the canonical-v2 hash is computed server-side, and
// event + artifacts commit atomically. This action only hashes the prompt/
// output text (data-minimization: the text itself is discarded, never stored)
// and forwards fields - one round trip, no retry loop.
export async function logReview(formData: FormData) {
  await requireReview()
  const supabase = await createClient()

  const tool = str(formData, 'tool')
  const verification_notes = str(formData, 'verification_notes')
  const approval_signature = str(formData, 'approval_signature')
  if (!tool || !verification_notes || !approval_signature) {
    redirect('/records/new?e=' + encodeURIComponent('Tool, verification notes, and signature are required.'))
  }

  const promptText = String(formData.get('prompt_text') || '')
  const outputText = String(formData.get('output_text') || '')
  const occurredRaw = str(formData, 'occurred_at')

  const { error } = await supabase.rpc('log_ai_event', {
    p_tool: tool,
    p_model: str(formData, 'model') || null,
    p_client_ref: str(formData, 'client_ref') || null,
    p_matter_ref: str(formData, 'matter_ref') || null,
    p_occurred_at: occurredRaw ? new Date(occurredRaw).toISOString() : null,
    p_data_kind: str(formData, 'data_kind') || null,
    p_data_sensitivity: str(formData, 'data_sensitivity') || 'none',
    p_pii_included: formData.get('pii_included') === 'on',
    p_prompt_sha256: promptText ? sha256(promptText) : null,
    p_prompt_bytes: promptText ? Buffer.byteLength(promptText, 'utf8') : null,
    p_output_sha256: outputText ? sha256(outputText) : null,
    p_output_bytes: outputText ? Buffer.byteLength(outputText, 'utf8') : null,
    p_verification_notes: verification_notes,
    p_edited: formData.get('edited') === 'on',
    p_verified_accurate: formData.get('verified_accurate') === 'on',
    p_assumptions_ref: str(formData, 'assumptions_ref') || null,
    p_reviewer_confirmed_assumptions: formData.get('reviewer_confirmed_assumptions') === 'on',
    p_approval_signature: approval_signature,
  })
  if (error) redirect('/records/new?e=' + encodeURIComponent(error.message))

  revalidatePath('/records')
  redirect('/records')
}
