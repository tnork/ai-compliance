import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

// Persist a swallowed/silent server error to error_log so the Developers view
// surfaces it (and it survives across sessions). Best-effort: NEVER throws — a
// logging failure must not break the caller. Uses the passed admin (service-role)
// client, which bypasses RLS. Do NOT put secrets or raw prompt/output in context.
export type ErrorSource = 'connector' | 'ingest' | 'storage' | 'staff' | 'packet' | 'coverage' | 'web'

export async function logError(
  admin: SupabaseClient,
  e: {
    firmId: string
    source: ErrorSource
    message: string
    severity?: 'error' | 'warn'
    context?: Record<string, unknown> | null
    stack?: string | null
  },
): Promise<void> {
  try {
    await admin.from('error_log').insert({
      firm_id: e.firmId,
      source: e.source,
      severity: e.severity ?? 'error',
      message: (e.message || 'unknown error').slice(0, 4000),
      context: e.context ?? null,
      stack: e.stack ? e.stack.slice(0, 8000) : null,
    })
  } catch (err) {
    console.error('[logError] failed to persist error_log row', err)
  }
}
