import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openSecret } from './crypto'
import { ingestEvents } from './ingest'
import { logError } from '../error-log'
import { openaiAdapter } from './openai'
import { anthropicAdapter } from './anthropic'
import { grokAdapter } from './grok'
import { geminiAdapter } from './gemini'
import { copilotAdapter } from './copilot'
import type { ProviderAdapter, Provider } from './types'

const ADAPTERS: Record<Provider, ProviderAdapter> = {
  openai: openaiAdapter, anthropic: anthropicAdapter, grok: grokAdapter,
  gemini: geminiAdapter, copilot: copilotAdapter,
}
const SOURCE_BY_PROVIDER: Record<Provider, string> = {
  openai: 'openai_api', anthropic: 'anthropic_api', grok: 'grok_api',
  gemini: 'gemini_api', copilot: 'purview', // Copilot content path is Purview
}
const MAX_PAGES = 50 // safety bound per run; cursor persists so the next run resumes

type ConnectionRow = {
  id: string; firm_id: string; provider: Provider; scope_ref: string | null
  secret_ciphertext: string | null; secret_iv: string | null; secret_tag: string | null
  sync_cursor: string | null; last_sync_at: string | null
}

export type SyncReport = { provider: Provider; inserted: number; duplicate: number; unmatched: string[]; error?: string }

// Pull one connection's window → normalize → ingest → advance cursor + heartbeat.
// `nowISO` is injected (scripts/routes stamp it) so this stays pure-ish and the
// Date.now ban in workflow contexts never bites. fetchImpl is injectable for tests.
export async function syncConnection(
  admin: SupabaseClient, conn: ConnectionRow, nowISO: string, fetchImpl?: typeof fetch,
): Promise<SyncReport> {
  const adapter = ADAPTERS[conn.provider]
  const report: SyncReport = { provider: conn.provider, inserted: 0, duplicate: 0, unmatched: [] }
  try {
    if (!conn.secret_ciphertext || !conn.secret_iv || !conn.secret_tag) throw new Error('no stored credential')
    const secret = openSecret({ ciphertext: conn.secret_ciphertext, iv: conn.secret_iv, tag: conn.secret_tag })
    // honor the firm's content-retention setting for connector captures too
    const { data: firm } = await admin.from('firm').select('retain_raw_captures').eq('id', conn.firm_id).single()
    const retainRaw = !!firm?.retain_raw_captures
    // resume from cursor; else pull from last sync (or 30 days back on first run)
    const sinceISO = conn.last_sync_at ?? new Date(Date.parse(nowISO) - 30 * 864e5).toISOString()
    let cursor = conn.sync_cursor

    for (let page = 0; page < MAX_PAGES; page++) {
      const { events, nextCursor } = await adapter.fetchWindow({
        secret, scopeRef: conn.scope_ref, cursor, sinceISO, fetchImpl,
      })
      // surface telemetry (0029): enterprise pulls are provider-side captures -
      // no browser/OS to report, the surface is the connector itself
      const r = await ingestEvents(admin, conn.firm_id, events.map((e) => ({ ...e, surface: e.surface ?? 'connector' })), SOURCE_BY_PROVIDER[conn.provider], retainRaw)
      report.inserted += r.inserted; report.duplicate += r.duplicate
      for (const u of r.unmatched) if (!report.unmatched.includes(u)) report.unmatched.push(u)
      // HARD ingest error (transient DB/RPC) → do NOT advance the cursor past
      // un-written events; stop and retry from the last good cursor next run
      // (idempotency makes re-ingesting the succeeded ones safe). Unmatched
      // users are NOT hard errors - they can't be attributed until added to the
      // firm, so we don't let one stranger's event wedge the sync forever.
      if (r.errors.length) throw new Error(`ingest failed on ${r.errors.length} event(s): ${r.errors[0]}`)
      cursor = nextCursor
      // a failed cursor persist means the next run would re-fetch (safe:
      // idempotent) but must not be silently ignored - surface it as an error
      const { error: curErr } = await admin.from('provider_connection').update({ sync_cursor: cursor }).eq('id', conn.id)
      if (curErr) throw new Error('cursor persist failed: ' + curErr.message)
      if (!nextCursor) break
    }
    const { error: okErr } = await admin.from('provider_connection').update({
      status: 'connected', last_sync_at: nowISO, last_error: report.unmatched.length
        ? `${report.unmatched.length} unmatched user(s) skipped: ${report.unmatched.slice(0, 5).join(', ')}` : null,
    }).eq('id', conn.id)
    if (okErr) await logError(admin, { firmId: conn.firm_id, source: 'connector', message: 'connector status write failed: ' + okErr.message, context: { connectionId: conn.id, provider: conn.provider } })
    if (report.unmatched.length) await logError(admin, { firmId: conn.firm_id, source: 'connector', severity: 'warn', message: `${report.unmatched.length} unmatched user(s) skipped on ${conn.provider} sync`, context: { connectionId: conn.id, provider: conn.provider, unmatched: report.unmatched.slice(0, 20) } })
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e)
    // The sync itself failed - persist it so the Developers view shows it even if
    // nobody is watching the /connections page.
    await logError(admin, { firmId: conn.firm_id, source: 'connector', message: `connector sync failed (${conn.provider}): ${report.error}`, context: { connectionId: conn.id, provider: conn.provider } })
    const { error: errWr } = await admin.from('provider_connection').update({ status: 'error', last_error: report.error }).eq('id', conn.id)
    if (errWr) await logError(admin, { firmId: conn.firm_id, source: 'connector', message: 'connector error-status write failed: ' + errWr.message, context: { connectionId: conn.id } })
  }
  return report
}

// Sync every connection due for a refresh (cron path). Due = never synced or
// last_sync_at older than `staleMs`.
export async function syncDueConnections(admin: SupabaseClient, nowISO: string, staleMs = 5 * 60_000): Promise<SyncReport[]> {
  const cutoff = new Date(Date.parse(nowISO) - staleMs).toISOString()
  const { data, error } = await admin.from('provider_connection')
    .select('*').neq('status', 'disabled').or(`last_sync_at.is.null,last_sync_at.lt.${cutoff}`)
  // a failed lookup must NOT read as a successful zero-work run
  if (error) throw new Error('due-connection query failed: ' + error.message)
  const reports: SyncReport[] = []
  for (const conn of (data ?? []) as ConnectionRow[]) reports.push(await syncConnection(admin, conn, nowISO))
  return reports
}
