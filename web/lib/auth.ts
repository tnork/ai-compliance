import { redirect } from 'next/navigation'
import { createClient } from './supabase/server'

export type AppUser = {
  id: string
  username: string | null
  email: string | null
  role: string
  firm_id: string
  firmName: string
  can_view_logs: boolean
  can_review: boolean
  is_developer: boolean
  onboarding_done_at: string | null
}

// Derived permissions - admins implicitly have both; review implies view.
export const canReview = (u: AppUser) => u.role === 'admin' || u.can_review
export const canViewLogs = (u: AppUser) => u.role === 'admin' || u.can_view_logs || u.can_review
// Developer console (error_log) — a per-account grant, NOT tied to admin role.
export const isDeveloper = (u: AppUser) => u.is_developer === true

// Server-side: require an authenticated user with an app_user row; return the user + firm.
export async function requireUser(): Promise<AppUser> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: au } = await supabase
    .from('app_user')
    .select('id, username, email, role, firm_id, can_view_logs, can_review, is_developer, onboarding_done_at')
    .eq('id', user.id)
    .single()

  if (!au) redirect('/login?e=no-firm')

  const { data: firm } = await supabase
    .from('firm')
    .select('name')
    .eq('id', au.firm_id)
    .single()

  return { ...au, firmName: firm?.name ?? 'Your firm' }
}

// Require one of the given roles; redirect if not permitted.
export async function requireRole(...roles: string[]): Promise<AppUser> {
  const u = await requireUser()
  if (!roles.includes(u.role)) redirect('/dashboard?e=forbidden')
  return u
}

// Require log-viewing permission (records / coverage / packets). RLS also
// enforces this at the DB - these guards just redirect cleanly instead of
// showing an empty page.
export async function requireViewLogs(): Promise<AppUser> {
  const u = await requireUser()
  if (!canViewLogs(u)) redirect('/dashboard?e=forbidden')
  return u
}

// Require review-and-approve permission (log a review / resolve a captured event).
export async function requireReview(): Promise<AppUser> {
  const u = await requireUser()
  if (!canReview(u)) redirect('/dashboard?e=forbidden')
  return u
}

// Developer-only (error_log console). Distinct from admin — only dev@example.com
// is granted. RLS also enforces this at the DB; this guard redirects cleanly.
export async function requireDeveloper(): Promise<AppUser> {
  const u = await requireUser()
  if (!isDeveloper(u)) redirect('/dashboard?e=forbidden')
  return u
}
