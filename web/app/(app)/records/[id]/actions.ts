'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireReview } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

// Resolve an auto-captured event's §10.22 gap: append a review event (via the
// review_captured_event RPC) that records a human verified it. The captured row
// stays append-only reviewed=false; the review event references it.
export async function reviewCaptured(formData: FormData) {
  await requireReview()
  const id = String(formData.get('captured_id') || '')
  const notes = String(formData.get('verification_notes') || '').trim()
  const signature = String(formData.get('approval_signature') || '').trim()
  if (!notes || !signature) redirect(`/records/${id}?e=` + encodeURIComponent('Verification notes and signature are required.'))

  const supabase = await createClient()
  const { error } = await supabase.rpc('review_captured_event', {
    p_captured_id: id,
    p_verification_notes: notes,
    p_verified_accurate: formData.get('verified_accurate') === 'on',
    p_approval_signature: signature,
    p_edited: formData.get('edited') === 'on',
  })
  if (error) redirect(`/records/${id}?e=` + encodeURIComponent(error.message))
  revalidatePath(`/records/${id}`)
  revalidatePath('/records')
  redirect(`/records/${id}`)
}
