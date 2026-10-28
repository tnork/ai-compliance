// Connect-once auth. The web app's Connections page mints a one-time "connect
// code" (a Supabase magic-link token_hash + the env's URLs/keys, base64url).
// Pasting it here redeems it for the logger's OWN Supabase session — separate
// from the browser session, so refresh-token rotation never collides — and the
// logger self-refreshes from then on. Connect once, stays connected.

export interface SessionCreds {
  supabaseUrl: string
  anonKey: string // publishable key (already public in the web client bundle)
  accessToken: string
  refreshToken: string
  expiresAt: number // epoch ms when accessToken expires
  email: string | null // for display only
}

export interface ConnectCode {
  v: number
  appOrigin: string
  supabaseUrl: string
  anonKey: string
  tokenHash: string
}

// Only the AI Compliance app origin (or localhost for dev) may receive the bearer
// token / captured content. A connect code pointing anywhere else is rejected —
// a crafted code must not be able to exfiltrate transcripts to an arbitrary host.
// Hostname of YOUR deployed app.
export const APP_HOST = 'app.example.com'

export function isAllowedOrigin(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && u.hostname === APP_HOST) return true
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
    return false
  } catch { return false }
}

// Auth traffic only ever goes to a real Supabase project (or local dev stack).
export function isAllowedSupabaseUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && u.hostname.endsWith('.supabase.co')) return true
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
    return false
  } catch { return false }
}

export function parseConnectCode(raw: string): ConnectCode {
  const code = raw.trim()
  if (!code.startsWith('aic1.')) throw new Error('That does not look like a connect code (expected it to start with "aic1.").')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(Buffer.from(code.slice(5), 'base64url').toString('utf8'))
  } catch { throw new Error('Connect code is malformed — copy the whole code and try again.') }
  const { v, appOrigin, supabaseUrl, anonKey, tokenHash } = parsed as Record<string, string>
  if (Number(v) !== 1 || !appOrigin || !supabaseUrl || !anonKey || !tokenHash) {
    throw new Error('Connect code is incomplete — generate a fresh one in the app.')
  }
  if (!isAllowedOrigin(appOrigin)) throw new Error('Connect code points at an unrecognized app URL — rejected.')
  if (!isAllowedSupabaseUrl(supabaseUrl)) throw new Error('Connect code points at an unrecognized auth server — rejected.')
  return { v: 1, appOrigin, supabaseUrl: supabaseUrl.replace(/\/$/, ''), anonKey, tokenHash }
}

// Thrown when the server explicitly rejects the credential (vs a network blip):
// the session is dead and the user needs a fresh connect code.
export class AuthInvalidError extends Error {}

type GotrueSession = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  user?: { email?: string }
  error?: string
  error_description?: string
  msg?: string
}

function toCreds(supabaseUrl: string, anonKey: string, body: GotrueSession): SessionCreds {
  if (!body.access_token || !body.refresh_token) throw new AuthInvalidError(body.error_description || body.msg || 'auth server returned no session')
  return {
    supabaseUrl,
    anonKey,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    email: body.user?.email ?? null,
  }
}

// One-time: exchange the code's token_hash for this device's own session.
export async function redeemConnectCode(c: ConnectCode): Promise<SessionCreds> {
  const res = await fetch(`${c.supabaseUrl}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: c.anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: c.tokenHash }),
  })
  const body = (await res.json().catch(() => ({}))) as GotrueSession
  if (!res.ok) {
    throw new AuthInvalidError('Connect code expired or already used — generate a new one in the app (Connections page).')
  }
  return toCreds(c.supabaseUrl, c.anonKey, body)
}

// Rotate: Supabase refresh tokens are single-use; every refresh persists the
// NEW refresh token (the caller must save the returned creds immediately).
export async function refreshSession(s: SessionCreds): Promise<SessionCreds> {
  let res: Response
  try {
    res = await fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: s.anonKey },
      body: JSON.stringify({ refresh_token: s.refreshToken }),
    })
  } catch (e) {
    throw new Error(`offline? token refresh failed: ${String(e)}`) // network — keep session, retry later
  }
  const body = (await res.json().catch(() => ({}))) as GotrueSession
  if (!res.ok) {
    // ONLY a definitive rejection of the refresh token (400/401/403) kills the
    // session. Everything else — 429 rate limits, 5xx, odd statuses — is
    // transient: keep the session and retry later (Codex P1: a rate limit must
    // never force the user to re-pair).
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AuthInvalidError('Session was revoked — generate a new connect code in the app.')
    }
    throw new Error(`token refresh failed: server ${res.status}`)
  }
  const creds = toCreds(s.supabaseUrl, s.anonKey, body)
  if (!creds.email) creds.email = s.email
  return creds
}
