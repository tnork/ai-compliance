'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireRole } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/error-log'

export async function inviteStaff(formData: FormData) {
  const me = await requireRole('admin') // only admins invite; firm_id from session, never input
  const email = String(formData.get('email') || '').trim().toLowerCase()
  const username = String(formData.get('username') || '').trim() || email.split('@')[0]
  // Admin picks the role at invite time; anything but 'admin' is a plain user.
  const role = String(formData.get('role') || '') === 'admin' ? 'admin' : 'staff'
  if (!email) redirect('/staff?e=' + encodeURIComponent('Email required'))

  // Supabase emails the invite link (custom SMTP → Resend). The link lands on
  // /auth/confirm (token_hash pattern), which sends them to /welcome to set a password.
  // NEXT_PUBLIC_APP_URL = deployed app origin; unset in dev = localhost.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  const admin = createAdminClient()
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { username },
    redirectTo: `${appUrl}/auth/confirm`,
  })
  if (error || !data.user) redirect('/staff?e=' + encodeURIComponent(error?.message || 'Invite failed'))

  // Role parity with existing users (the authoritative role lives on app_user; this mirrors it).
  await admin.auth.admin.updateUserById(data.user.id, { app_metadata: { role } })

  const { error: ins } = await admin.from('app_user').insert({
    id: data.user!.id,
    firm_id: me.firm_id,
    username,
    email,
    role,
  })
  if (ins) {
    // Roll back the auth user so the invite can be retried cleanly.
    await admin.auth.admin.deleteUser(data.user.id)
    redirect('/staff?e=' + encodeURIComponent(ins.message))
  }

  revalidatePath('/staff')
  redirect('/staff?invited=1')
}

// Admin-only: set a member's role (Admin/User) and the two granular permissions
// (view logs / review & approve). The admin_set_member RPC (0021) does the
// firm-scoping, admin check, and last-admin guard ATOMICALLY under a row lock -
// a concurrent double-demotion can't strand a firm with zero admins. It runs as
// the caller (RLS client → auth.uid()), so no service-role app_user write here.
export async function updateMember(formData: FormData) {
  const me = await requireRole('admin') // defense-in-depth; the RPC re-checks in-DB
  const userId = String(formData.get('user_id') || '')
  const role = String(formData.get('role') || '') === 'admin' ? 'admin' : 'staff'
  // Admins implicitly have both permissions; only staff carry granular grants.
  const can_view_logs = role === 'admin' ? false : formData.get('can_view_logs') === 'on'
  const can_review = role === 'admin' ? false : formData.get('can_review') === 'on'
  if (!userId) redirect('/staff?e=' + encodeURIComponent('Missing user'))

  // Read the CURRENT role before the RPC changes it - only an actual
  // staff -> admin promotion re-opens onboarding below (Codex P2: re-saving an
  // existing admin's permissions must not reset their stamp).
  const supabase = await createClient()
  const { data: prior } = await supabase.from('app_user').select('role').eq('id', userId).maybeSingle()

  const { error } = await supabase.rpc('admin_set_member', {
    p_user_id: userId, p_role: role, p_can_view_logs: can_view_logs, p_can_review: can_review,
  })
  if (error) redirect('/staff?e=' + encodeURIComponent(error.message))

  // Promotion to admin re-opens onboarding: the admin checklist (7 firm steps)
  // supersets the member one (3 personal steps), so a stamp earned as staff no
  // longer covers the role (Codex P2). Pinned to the target row in the caller's
  // firm; idempotent (no-op when already null); the dashboard restamps once the
  // admin steps compute complete. Demotion keeps the stamp (7 supersets 3).
  // A failed clear is surfaced (a promotion keeping the staff stamp would
  // silently skip the admin checklist), not swallowed.
  const admin = createAdminClient()
  if (role === 'admin' && prior?.role === 'staff') {
    const { error: clearErr } = await admin.from('app_user').update({ onboarding_done_at: null })
      .eq('id', userId).eq('firm_id', me.firm_id).not('onboarding_done_at', 'is', null)
    if (clearErr) {
      await logError(admin, {
        firmId: me.firm_id, source: 'staff', severity: 'warn',
        message: 'onboarding stamp clear on promotion failed: ' + clearErr.message,
        context: { userId },
      })
    }
  }

  // Keep app_metadata.role in parity (authoritative role stays on app_user).
  // Requires the admin API, so this one step uses the service role. If it fails,
  // the DB role (authoritative) is already set - surface the drift, don't swallow it.
  const { error: metaErr } = await admin.auth.admin.updateUserById(userId, { app_metadata: { role } })
  if (metaErr) {
    await logError(admin, {
      firmId: me.firm_id, source: 'staff', severity: 'warn',
      message: 'auth app_metadata.role sync failed (DB role is authoritative): ' + metaErr.message,
      context: { userId, role },
    })
  }

  revalidatePath('/staff')
  redirect('/staff?updated=1')
}

export async function acknowledgePolicy(formData: FormData) {
  const supabase = await createClient()
  const policy_id = String(formData.get('policy_id'))
  const version = parseInt(String(formData.get('version') || ''), 10)
  // Acknowledgements are an append-only, VERSION-aware log (migration 0031):
  // the RPC forces attribution to the caller, requires the version they read to
  // still be the head (advisory-locked against concurrent edits), and no-ops on
  // repeats. A saved edit bumps the head, so everyone is prompted again.
  const { error } = await supabase.rpc('acknowledge_policy', {
    p_policy_id: policy_id, p_version: Number.isFinite(version) ? version : -1,
  })
  if (error) {
    const msg = error.message.includes('stale_version')
      ? 'The policy was updated since you loaded this page - please re-read the current version, then acknowledge it.'
      : 'Could not record your acknowledgement. Please try again.'
    redirect('/staff?e=' + encodeURIComponent(msg))
  }
  revalidatePath('/staff')
  revalidatePath('/dashboard') // the acknowledge form also lives in the dashboard Key Actions card
}

// One-click acknowledgement of the firm's WISP (the security plan the AI-use
// policy is an addendum to). The attest_wisp() RPC is the only write path
// (0032, Codex P2): it re-validates IN the DB that the adopted policy declares
// a WISP is in place - a direct PostgREST insert can no longer mint evidence
// the product considers inapplicable. Attribution forced to auth.uid();
// repeats no-op on the unique.
export async function attestWisp() {
  const supabase = await createClient()
  const { error } = await supabase.rpc('attest_wisp')
  if (error) {
    // Through the UI this only happens on a stale page (the policy changed
    // underneath); surface it rather than pretending the click worked.
    redirect('/staff?e=' + encodeURIComponent('Could not record the WISP acknowledgement - the firm’s policy may have changed. Reload and try again.'))
  }
  revalidatePath('/staff')
  revalidatePath('/dashboard')
}
