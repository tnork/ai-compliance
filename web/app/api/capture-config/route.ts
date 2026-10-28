import { NextResponse } from 'next/server'
import { createClient as createJsClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

// The browser extension polls this (Bearer session token) to learn whether its
// firm has opted into raw-capture retention. When true it includes the raw
// prompt/output text with each synced event; when false it sends hashes only
// (raw text never leaves the browser). The server re-checks this on ingest too,
// so this is a hint for the client, not the security boundary.
export async function GET(request: Request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const anon = createJsClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  })
  const { data: { user }, error } = await anon.auth.getUser()
  if (error || !user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data: au } = await admin.from('app_user').select('firm_id').eq('id', user.id).single()
  if (!au) return NextResponse.json({ error: 'no firm' }, { status: 403 })
  const { data: firm } = await admin.from('firm').select('retain_raw_captures').eq('id', au.firm_id).single()

  return NextResponse.json({ retainRaw: !!firm?.retain_raw_captures })
}
