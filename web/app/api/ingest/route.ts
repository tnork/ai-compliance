import { NextResponse } from 'next/server'
import { createClient as createJsClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { ingestEventsForUser } from '@/lib/connectors/ingest'
import type { NormalizedEvent } from '@/lib/connectors/types'

const MAX_TEXT = 100_000 // cap captured prompt/output before hashing
const safeDate = (v: unknown): string => {
  const t = Date.parse(String(v))
  const now = Date.now()
  // clamp to a sane window: not future-skewed, not older than 45 days
  if (!Number.isFinite(t) || t > now + 864e5 || t < now - 45 * 864e5) return new Date(now).toISOString()
  return new Date(t).toISOString()
}
const clip = (v: unknown, n: number): string | null => {
  if (typeof v !== 'string' || !v) return null
  return v.length > n ? v.slice(0, n) : v
}

export const dynamic = 'force-dynamic'

// The browser extension AND the desktop logger post captured interactions here
// (body.source distinguishes them: 'extension' | 'desktop_agent'). Auth is the
// logged-in user's Supabase access token (Bearer) - every event is attributed to
// THAT user (the client captures for whoever is signed into it), so per-event
// userEmail from the client is ignored and overridden. Events land reviewed=false
// via the same ingest_ai_events_batch RPC the connector uses.
export async function POST(request: Request) {
  const auth = request.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // validate the session token → resolve the user
  const anon = createJsClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  })
  const { data: { user }, error: authErr } = await anon.auth.getUser()
  if (authErr || !user?.email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // reject oversized bodies BEFORE parsing (a 500-event batch of hashes is tiny;
  // anything above ~2MB is abuse). Content-Length is advisory but cheap to check.
  const len = Number(request.headers.get('content-length') || 0)
  if (len > 2_000_000) return NextResponse.json({ error: 'payload too large' }, { status: 413 })

  let body: { events?: unknown; source?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }) }
  // Which capture client is posting. Allowlisted → source_t enum; anything else
  // (or absent) falls back to 'extension'. Never trust an arbitrary client string.
  const source = body.source === 'desktop_agent' ? 'desktop_agent' : 'extension'
  const raw = Array.isArray(body.events) ? body.events : []
  if (raw.length === 0) return NextResponse.json({ inserted: 0, duplicate: 0 })
  if (raw.length > 500) return NextResponse.json({ error: 'batch too large (max 500)' }, { status: 413 })

  const admin = createAdminClient()
  const { data: au } = await admin.from('app_user').select('firm_id').eq('id', user.id).single()
  if (!au) return NextResponse.json({ error: 'no firm' }, { status: 403 })
  // The firm's CURRENT retention setting is authoritative — the extension only
  // sends raw text when it thinks retention is on, but we re-check here so a
  // stale cache or rogue client can never force raw text to be stored/retained.
  const { data: firm } = await admin.from('firm').select('retain_raw_captures').eq('id', au.firm_id).single()
  const retainRaw = !!firm?.retain_raw_captures

  // validate + clamp client input; attribution is forced to the authed user id
  // (in the RPC via ingestEventsForUser), never a client-supplied email. The
  // extension sends PRE-HASHED prompt/output always, plus raw text ONLY when the
  // firm opted into retention; when off, any raw text is ignored (hash-only).
  const sha = (v: unknown) => (typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : null)
  // non-negative integer byte count, else null (reject negatives / NaN / huge)
  const nn = (v: unknown) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null }
  const events: NormalizedEvent[] = raw.slice(0, 500).map((e) => {
    const ev = (e ?? {}) as Record<string, unknown>
    return {
      externalId: String(ev.externalId ?? '').slice(0, 200),
      userEmail: user.email!, // ignored by ingestEventsForUser; kept for the type
      occurredAt: safeDate(ev.occurredAt),
      tool: String(ev.tool ?? 'Unknown').trim().slice(0, 120) || 'Unknown',
      model: clip(ev.model, 120),
      promptText: clip(ev.promptText, MAX_TEXT),
      outputText: clip(ev.outputText, MAX_TEXT),
      promptSha256: sha(ev.promptSha256), promptBytes: nn(ev.promptBytes),
      outputSha256: sha(ev.outputSha256), outputBytes: nn(ev.outputBytes),
      // capture-surface telemetry (0029): clamped here, lowercased in the RPC
      surface: clip(ev.surface, 40),
      os: clip(ev.os, 40),
    }
  }).filter((e) => e.externalId)

  const out = await ingestEventsForUser(admin, au.firm_id, user.id, events, source, retainRaw)
  return NextResponse.json({ inserted: out.inserted, duplicate: out.duplicate, accepted: out.accepted, errors: out.errors })
}
