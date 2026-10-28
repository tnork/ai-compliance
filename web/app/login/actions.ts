'use server'

import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { SESSION_ONLY_COOKIE, SESSION_ONLY_COOKIE_OPTIONS } from '@/lib/supabase/cookie-policy'

export type AuthState = { error?: string }

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') || '').trim()
  const password = String(formData.get('password') || '')
  const remember = formData.get('remember') === '1'
  if (!email || !password) return { error: 'Enter your email and password.' }

  // The marker must be in place before signInWithPassword writes the auth cookies -
  // the server client's setAll reads it to decide session-only vs persistent.
  const cookieStore = await cookies()
  if (remember) cookieStore.delete(SESSION_ONLY_COOKIE)
  else cookieStore.set(SESSION_ONLY_COOKIE, '1', SESSION_ONLY_COOKIE_OPTIONS)

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    // revert the speculative marker so a failed attempt doesn't change existing cookie behavior
    cookieStore.delete(SESSION_ONLY_COOKIE)
    return { error: error.message }
  }
  redirect('/dashboard')
}

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_ONLY_COOKIE)
  redirect('/login')
}
