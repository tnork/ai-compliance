import type { CookieOptions } from '@supabase/ssr'

// "Keep this device signed in" (login checkbox). Checked (default) = @supabase/ssr's
// persistent auth cookies (400-day maxAge). Unchecked = this marker cookie is set and
// every auth-cookie write strips maxAge/expires, so the session normally ends when the
// browser closes. Best-effort, not a security boundary: browsers with session restore
// ("continue where you left off") can resurrect session cookies. The marker is itself
// a session cookie - it dies with the auth cookies.
export const SESSION_ONLY_COOKIE = 'aic_session_only'

export const SESSION_ONLY_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
} as const

export function stripPersistence(options: CookieOptions): CookieOptions {
  const { maxAge, expires, ...rest } = options
  return rest
}
