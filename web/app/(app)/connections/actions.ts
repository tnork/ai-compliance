'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole, requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sealSecret } from '@/lib/connectors/crypto'
import { syncConnection } from '@/lib/connectors/sync'
import type { Provider } from '@/lib/connectors/types'

const PROVIDERS: Provider[] = ['openai', 'anthropic', 'grok', 'gemini', 'copilot']
const err = (m: string) => redirect('/connections?e=' + encodeURIComponent(m))

// Connect an enterprise workspace: encrypt the Compliance-API key server-side
// (never stored plaintext), then upsert via the service role. firm_id/connected_by
// are passed explicitly because the service role has no auth.uid() for the
// current_firm_id() default.
export async function connectProvider(formData: FormData) {
  const me = await requireRole('admin')
  const provider = String(formData.get('provider') || '') as Provider
  const secret = String(formData.get('secret') || '').trim()
  const scope_ref = String(formData.get('scope_ref') || '').trim() || null
  if (!PROVIDERS.includes(provider)) err('unknown provider')
  if (!secret) err('an API key is required')

  const sealed = sealSecret(secret)
  const admin = createAdminClient()
  const { error } = await admin.from('provider_connection').upsert({
    firm_id: me.firm_id, provider, scope_ref, status: 'connected',
    secret_ciphertext: sealed.ciphertext, secret_iv: sealed.iv, secret_tag: sealed.tag,
    connected_by: me.id, last_error: null,
  }, { onConflict: 'firm_id,provider' })
  if (error) err(error.message)
  revalidatePath('/connections')
  redirect('/connections')
}

export async function disconnectProvider(formData: FormData) {
  await requireRole('admin') // RLS also enforces admin + firm on the delete
  const supabase = await createClient()
  const { error } = await supabase.from('provider_connection').delete().eq('id', String(formData.get('id')))
  if (error) err(error.message)
  revalidatePath('/connections')
  redirect('/connections')
}

// Admin flips the firm's content-retention switch (via the SECURITY DEFINER RPC,
// which re-checks admin + resolves the firm from auth.uid()).
export async function setContentRetention(formData: FormData) {
  await requireRole('admin')
  const on = String(formData.get('on') || '') === 'true'
  const supabase = await createClient()
  const { error } = await supabase.rpc('set_retain_raw_captures', { p_on: on })
  if (error) err(error.message)
  revalidatePath('/connections')
  redirect('/connections?retention=' + (on ? 'on' : 'off'))
}

// Desktop-logger pairing: mint a one-time connect code for the CALLER's own
// account. It wraps a Supabase magic-link token_hash (admin generateLink — no
// email is sent) plus the env's public URLs/keys; the desktop app redeems it
// once for its own self-refreshing session, so pairing survives past the ~1h
// access-token lifetime that the raw paste-a-token flow suffers from. The code
// is bearer-equivalent until redeemed: shown once, never persisted or logged.
export async function generateDesktopConnectCode(): Promise<{ code?: string; error?: string }> {
  await requireUser() // any firm member may connect their own logger
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return { error: 'Your account has no email address - contact support.' }

  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email })
  const tokenHash = data?.properties?.hashed_token
  if (error || !tokenHash) return { error: error?.message || 'Could not generate a connect code - try again.' }

  const payload = {
    v: 1,
    appOrigin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, // publishable - already in the client bundle
    tokenHash,
  }
  return { code: 'aic1.' + Buffer.from(JSON.stringify(payload)).toString('base64url') }
}

export async function syncNow(formData: FormData) {
  const me = await requireRole('admin')
  const admin = createAdminClient()
  const { data: conn } = await admin.from('provider_connection')
    .select('*').eq('id', String(formData.get('id'))).eq('firm_id', me.firm_id).single()
  if (!conn) err('connection not found')
  const report = await syncConnection(admin, conn, new Date().toISOString())
  revalidatePath('/connections')
  redirect('/connections?synced=' + encodeURIComponent(`${report.inserted} new, ${report.duplicate} already logged${report.error ? ' · ' + report.error : ''}`))
}
