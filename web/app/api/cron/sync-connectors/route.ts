import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncDueConnections } from '@/lib/connectors/sync'

export const dynamic = 'force-dynamic'

// Cron entrypoint (DO scheduled job / external cron hits this every 5-10 min).
// Guarded by a shared secret header - NOT a user session. Syncs every enterprise
// connection due for a refresh. The extension does NOT use this path.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const nowISO = new Date().toISOString()
  const reports = await syncDueConnections(createAdminClient(), nowISO)
  const totals = reports.reduce((a, r) => ({ inserted: a.inserted + r.inserted, duplicate: a.duplicate + r.duplicate }), { inserted: 0, duplicate: 0 })
  return NextResponse.json({ ranAt: nowISO, connections: reports.length, ...totals, reports })
}
