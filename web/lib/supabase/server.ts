import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SESSION_ONLY_COOKIE, stripPersistence } from './cookie-policy'

// Server client - cookie-bound session (publishable key, subject to RLS).
// Next 16: cookies() is async.
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            const sessionOnly = cookieStore.get(SESSION_ONLY_COOKIE)?.value === '1'
            // never strip removal writes (value '' + maxAge 0) or the cookie lingers instead of deleting
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, sessionOnly && value !== '' ? stripPersistence(options) : options)
            )
          } catch {
            // called from a Server Component - safe to ignore; middleware refreshes the session.
          }
        },
      },
    }
  )
}
