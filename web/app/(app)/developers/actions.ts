'use server'

import { revalidatePath } from 'next/cache'
import { requireDeveloper } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

// Mark an error resolved (or reopen it). RLS restricts error_log writes to the
// developer of the firm, so a non-developer can't call this even if they POST.
export async function setResolved(formData: FormData) {
  const me = await requireDeveloper()
  const id = String(formData.get('id') || '')
  const resolved = String(formData.get('resolved') || '') === 'true'
  if (!id) return
  const supabase = await createClient()
  await supabase.from('error_log').update({
    resolved,
    resolved_at: resolved ? new Date().toISOString() : null,
    resolved_by: resolved ? me.id : null,
  }).eq('id', id)
  revalidatePath('/developers')
}
