'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function addTool(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.from('tool_register').insert({
    tool_name: String(formData.get('tool_name') || '').trim(),
    provider: String(formData.get('provider') || '').trim() || null,
    approved_for_pii: formData.get('approved_for_pii') === 'on',
    data_handling_notes: String(formData.get('data_handling_notes') || '').trim() || null,
    status: String(formData.get('status') || 'approved'),
    approved_at: new Date().toISOString(),
  })
  if (error) redirect('/tools?e=' + encodeURIComponent(error.message))
  revalidatePath('/tools')
}

export async function deleteTool(formData: FormData) {
  await requireRole('admin') // the firm tool register is admin-managed; staff can't delete
  const supabase = await createClient()
  const { error } = await supabase.from('tool_register').delete().eq('id', String(formData.get('id')))
  if (error) redirect('/tools?e=' + encodeURIComponent(error.message))
  revalidatePath('/tools')
}
