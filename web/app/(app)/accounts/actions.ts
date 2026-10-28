'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

export async function addAccount(formData: FormData) {
  const supabase = await createClient()
  const provider = String(formData.get('provider') || 'other')
  const { error } = await supabase.from('ai_account').insert({
    provider,
    tool: String(formData.get('tool') || '').trim() || null,
    account_type: String(formData.get('account_type') || 'personal'),
    is_local_llm: provider === 'local',
    label: String(formData.get('label') || '').trim() || null,
  })
  if (error) redirect('/accounts?e=' + encodeURIComponent(error.message))
  revalidatePath('/accounts')
}

export async function deleteAccount(formData: FormData) {
  const supabase = await createClient()
  const { error } = await supabase.from('ai_account').delete().eq('id', String(formData.get('id')))
  if (error) redirect('/accounts?e=' + encodeURIComponent(error.message))
  revalidatePath('/accounts')
}
