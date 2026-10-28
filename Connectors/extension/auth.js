// Connect-once auth, shared by background.js (Chrome loads this via
// importScripts inside the service worker; Firefox lists it before
// background.js in the manifest's background.scripts) and by popup.js
// (<script src="auth.js"> before popup.js — the popup needs parseConnectCode
// so it can request the localhost permission from a user gesture BEFORE
// handing the code to the background).
//
// A connect code is minted by the app (Connections page): a one-time Supabase
// magic-link token_hash + the env's public URLs/keys, base64url-encoded. The
// extension redeems it once for its OWN session (separate refresh-token family
// from the browser tab's login — rotation never collides) and self-refreshes
// from then on. Connect once, stays connected. In production there is no
// hourly re-paste; the ~1h access token rotates silently underneath.
//
// NOTE: chrome.storage.local is not OS-keychain encrypted — the stored session
// has the same at-rest posture as the legacy pasted token (documented limit).

const AppAuth = (() => {
  // Hostname of YOUR deployed app. Also add it to manifest.json host_permissions.
  const APP_HOST = 'app.example.com'

  // Only the AI Compliance app origin (or localhost for dev) may receive the bearer
  // token / captured content. A crafted connect code must not be able to point
  // capture at an arbitrary host.
  function isAllowedOrigin(url) {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' && u.hostname === APP_HOST) return true
      if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
      return false
    } catch { return false }
  }

  // Auth traffic only ever goes to a real Supabase project (or a local stack).
  function isAllowedSupabaseUrl(url) {
    try {
      const u = new URL(url)
      if (u.protocol === 'https:' && u.hostname.endsWith('.supabase.co')) return true
      if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
      return false
    } catch { return false }
  }

  function b64urlDecode(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  }

  function parseConnectCode(raw) {
    const code = String(raw ?? '').trim()
    if (!code.startsWith('aic1.')) throw new Error('That does not look like a connect code (expected it to start with "aic1.").')
    let parsed
    try { parsed = JSON.parse(b64urlDecode(code.slice(5))) } catch { throw new Error('Connect code is malformed — copy the whole code and try again.') }
    const { v, appOrigin, supabaseUrl, anonKey, tokenHash } = parsed || {}
    if (Number(v) !== 1 || !appOrigin || !supabaseUrl || !anonKey || !tokenHash) {
      throw new Error('Connect code is incomplete — generate a fresh one in the app.')
    }
    if (!isAllowedOrigin(appOrigin)) throw new Error('Connect code points at an unrecognized app URL — rejected.')
    if (!isAllowedSupabaseUrl(supabaseUrl)) throw new Error('Connect code points at an unrecognized auth server — rejected.')
    return { v: 1, appOrigin: appOrigin.replace(/\/$/, ''), supabaseUrl: supabaseUrl.replace(/\/$/, ''), anonKey, tokenHash }
  }

  // Thrown when the auth server definitively rejects the credential (vs a
  // transient failure): the session is dead, a fresh connect code is needed.
  class AuthInvalidError extends Error {}

  function toCreds(supabaseUrl, anonKey, body) {
    if (!body || !body.access_token || !body.refresh_token) {
      throw new AuthInvalidError((body && (body.error_description || body.msg)) || 'auth server returned no session')
    }
    return {
      supabaseUrl,
      anonKey,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      email: (body.user && body.user.email) || null,
    }
  }

  // One-time: exchange the code's token_hash for this extension's own session.
  async function redeemConnectCode(c) {
    const res = await fetch(`${c.supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: c.anonKey },
      body: JSON.stringify({ type: 'magiclink', token_hash: c.tokenHash }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new AuthInvalidError('Connect code expired or already used — generate a new one in the app (Connections page).')
    return toCreds(c.supabaseUrl, c.anonKey, body)
  }

  // Rotate: refresh tokens are single-use — the caller must persist the
  // returned creds immediately.
  async function refreshSession(s) {
    let res
    try {
      res = await fetch(`${s.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: s.anonKey },
        body: JSON.stringify({ refresh_token: s.refreshToken }),
      })
    } catch (e) {
      throw new Error(`offline? token refresh failed: ${String(e)}`) // network — keep session, retry later
    }
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      // ONLY a definitive rejection (400/401/403) kills the session; 429/5xx
      // are transient — keep the session and retry later.
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new AuthInvalidError('Session was revoked — generate a new connect code in the app.')
      }
      throw new Error(`token refresh failed: server ${res.status}`)
    }
    const creds = toCreds(s.supabaseUrl, s.anonKey, body)
    if (!creds.email) creds.email = s.email
    return creds
  }

  return { APP_HOST, isAllowedOrigin, isAllowedSupabaseUrl, parseConnectCode, redeemConnectCode, refreshSession, AuthInvalidError }
})()
