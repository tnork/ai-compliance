import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_ONLY_COOKIE, stripPersistence } from '@/lib/supabase/cookie-policy'

// Next 16: "middleware" is now "proxy" (same functionality). Refreshes the Supabase
// auth session cookie on each request so Server Components always see a valid session.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          const sessionOnly = request.cookies.get(SESSION_ONLY_COOKIE)?.value === '1'
          // never strip removal writes (value '' + maxAge 0) or the cookie lingers instead of deleting
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, sessionOnly && value !== '' ? stripPersistence(options) : options)
          )
        },
      },
    }
  )

  await supabase.auth.getUser()
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
