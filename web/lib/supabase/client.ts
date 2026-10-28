import { createBrowserClient } from '@supabase/ssr'

// Browser client - uses the publishable (anon) key; all access is subject to RLS.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
