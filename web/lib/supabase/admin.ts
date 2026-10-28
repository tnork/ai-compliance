import { createClient } from '@supabase/supabase-js'
import 'server-only'

// Service-role client - BYPASSES RLS. Server-only (never import into a Client Component).
// Use narrowly for privileged operations: staff invites, reading leads, admin tasks.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
