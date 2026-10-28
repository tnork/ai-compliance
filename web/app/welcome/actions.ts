'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type WelcomeState = { error?: string }

export async function setPassword(_prev: WelcomeState, formData: FormData): Promise<WelcomeState> {
  const password = String(formData.get('password') || '')
  const confirm = String(formData.get('confirm') || '')
  if (password.length < 8) return { error: 'Password must be at least 8 characters.' }
  if (password !== confirm) return { error: 'Passwords don’t match.' }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login?e=invite-link')

  const { error } = await supabase.auth.updateUser({ password })
  if (error) return { error: error.message }
  redirect('/dashboard')
}
