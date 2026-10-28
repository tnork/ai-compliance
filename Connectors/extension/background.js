// Service worker: SINGLE WRITER for the capture buffer, and the syncer that
// drains it to AI Compliance. All buffer mutations (capture appends from any tab, the
// sync ack-filter, retention stripping) run through one serialized queue so a
// sync can never clobber an event a tab just captured (Codex P1 fix — content
// scripts no longer touch storage).
//
// Sync triggers, fastest first: (1) ~30s after a captured turn (one-shot
// debounce alarm re-armed per capture, so a burst of Q&A uploads as one batch),
// (2) on browser startup — flushes anything buffered when the browser was last
// closed, (3) a 7-minute periodic alarm as the retry backstop for failed sends,
// (4) on demand from the popup. Auth is the signed-in user's Supabase access
// token, stored by the popup.
//
// Durability policy: an event is removed ONLY when the server explicitly acks
// its externalId — a 2xx without a valid `accepted` array fails closed and
// keeps everything. Unacked events are NEVER evicted and retained text is never
// silently degraded (the manifest requests unlimitedStorage, so quota pressure
// can't force a choice between old and new evidence). The only text strip is
// the policy-mandated one: the firm turning content retention OFF. The local
// hash chain covers a TEXT-FREE projection of each record, so that strip never
// breaks chain recomputability.
// Shared connect-once auth (AppAuth): Chrome loads it here (classic service
// worker, importScripts is available); Firefox already loaded it via the
// manifest's background.scripts array, where importScripts doesn't exist.
if (typeof importScripts === 'function') importScripts('auth.js')

const KEY = 'aicompliance_buffer'
const CFG = 'aicompliance_config' // { appOrigin, session? (connect-code creds), accessToken? (legacy pasted token) }
const AUTH_ERR = 'aicompliance_auth_error'
const ALARM = 'aicompliance_sync'
const ALARM_SOON = 'aicompliance_sync_soon' // one-shot, armed on each capture
const MAX_FIELD = 100_000  // server clip; applied at APPEND so storage is bounded per event
const BACKLOG_WARN = 5_000 // pending count worth shouting about (dead token for weeks)

// ── single-writer buffer queue ───────────────────────────────────────────────
// Every read-modify-write of KEY goes through here. Within one service-worker
// instance this fully serializes mutations; messages arriving while a previous
// mutation runs simply queue behind it. (A SW restart resets the chain, but
// each mutation re-reads storage, so state is never stale across restarts.)
let mutex = Promise.resolve()
function withBuffer(mutate) {
  const run = mutex.then(async () => {
    const { [KEY]: buf = [] } = await chrome.storage.local.get(KEY)
    const next = await mutate(buf)
    if (next) await chrome.storage.local.set({ [KEY]: next })
    return next || buf
  })
  mutex = run.catch(() => {}) // a failed mutation never wedges the queue
  return run
}

async function sha256Hex(s) {
  if (!s) return null
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ── surface + OS telemetry ───────────────────────────────────────────────────
// Each event records WHERE it was captured: surface = the browser (chrome/edge/
// brave/opera/firefox/...) and os = the operating system. Best-effort detection;
// unknown maps to null rather than a guess. (Arc has no distinct UA brand and
// reports as chrome — a documented limit, not a bug.)
function detectSurface() {
  try {
    const brands = navigator.userAgentData?.brands?.map((b) => b.brand.toLowerCase()) || []
    for (const [needle, name] of [['edge', 'edge'], ['brave', 'brave'], ['opera', 'opera'], ['vivaldi', 'vivaldi'], ['chrome', 'chrome'], ['chromium', 'chromium']]) {
      if (brands.some((b) => b.includes(needle))) return name
    }
    const ua = navigator.userAgent || ''
    if (/firefox\//i.test(ua)) return 'firefox'
    if (/edg\//i.test(ua)) return 'edge'
    if (/chrome\//i.test(ua)) return 'chrome'
  } catch {}
  return null
}
function detectOs() {
  try {
    const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase()
    if (p.includes('mac')) return 'macos'
    if (p.includes('win')) return 'windows'
    if (p.includes('linux') || p.includes('x11')) return 'linux'
    if (p.includes('cros')) return 'chromeos'
  } catch {}
  return null
}
const SURFACE = detectSurface()
const OS = detectOs()

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create(ALARM, { periodInMinutes: 7 }))
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(ALARM, { periodInMinutes: 7 }); sync() })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM || a.name === ALARM_SOON) sync() })
chrome.runtime.onMessage.addListener((m, _s, respond) => {
  if (m?.type === 'capture') { append(m.rec).then(respond); return true }
  if (m?.type === 'sync-now') { sync().then(respond); return true }
  if (m?.type === 'status') { status().then(respond); return true }
  if (m?.type === 'connect') { connect(m.code).then(respond); return true }
  if (m?.type === 'disconnect') { disconnect().then(respond); return true }
  if (m?.type === 'refresh-config') {
    (async () => {
      const cfg = await getCfg()
      const token = cfg?.appOrigin ? await accessToken() : null
      if (token) { await refreshConfig(cfg.appOrigin, token); respond({ ok: true }) } else respond({ ok: false })
    })()
    return true
  }
})

// ── connect-once session (AppAuth) ──────────────────────────────────────────
// The session lives in cfg.session and self-refreshes; the legacy pasted
// accessToken remains as a dev fallback. Refreshes are serialized (rotation
// makes refresh tokens single-use) and the rotated pair is persisted before
// anything else uses it. Definitive auth rejections clear the session and
// leave a visible error for the popup; transient failures (429/5xx/offline)
// keep the session and retry on the next sync.
async function getCfg() { const { [CFG]: cfg } = await chrome.storage.local.get(CFG); return cfg || null }
let refreshing = null
function doRefresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const cfg = await getCfg()
      if (!cfg?.session) return false
      try {
        const next = await AppAuth.refreshSession(cfg.session)
        await chrome.storage.local.set({ [CFG]: { ...cfg, session: next }, [AUTH_ERR]: null })
        return true
      } catch (e) {
        if (e instanceof AppAuth.AuthInvalidError) {
          await chrome.storage.local.set({ [CFG]: { appOrigin: cfg.appOrigin }, [AUTH_ERR]: e.message })
        } else {
          await chrome.storage.local.set({ [AUTH_ERR]: String((e && e.message) || e) })
        }
        return false
      }
    })().finally(() => { refreshing = null })
  }
  return refreshing
}
async function accessToken(force = false) {
  const cfg = await getCfg()
  if (cfg?.session) {
    if (force || Date.now() > cfg.session.expiresAt - 90_000) {
      if (!(await doRefresh())) return null
      const fresh = await getCfg()
      return fresh?.session?.accessToken ?? null
    }
    return cfg.session.accessToken
  }
  return cfg?.accessToken || null
}
// Pair with a connect code (one-time). The popup validated the code and
// handled the localhost permission gesture; we re-validate here anyway.
async function connect(code) {
  try {
    const parsed = AppAuth.parseConnectCode(code)
    const creds = await AppAuth.redeemConnectCode(parsed)
    await chrome.storage.local.set({ [CFG]: { appOrigin: parsed.appOrigin, session: creds }, [AUTH_ERR]: null })
    await refreshConfig(parsed.appOrigin, creds.accessToken)
    sync()
    return { ok: true, email: creds.email }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
async function disconnect() {
  const cfg = await getCfg()
  await chrome.storage.local.set({ [CFG]: { appOrigin: cfg?.appOrigin || '' }, [AUTH_ERR]: null })
  return { ok: true }
}

// The local tamper-evidence chain hashes a TEXT-FREE projection of the record:
// hashes + metadata only, never promptText/outputText. Retained raw text can
// then be stripped (retention turned off) without breaking recomputability,
// and the chain still binds the content via the sha256 fields.
const chainProjection = (rec) => JSON.stringify([
  rec.externalId, rec.tool, rec.occurredAt,
  rec.promptSha256, rec.promptBytes, rec.outputSha256, rec.outputBytes,
  rec.surface ?? null, rec.os ?? null,
])

// Append a captured event (from any tab's content script): local-hash-chain it
// against the current buffer tail, persist, then arm the ~30s debounce sync.
// 30s is the MV3 alarm minimum (Chrome 120+); re-creating the same-name alarm
// resets it, batching rapid-fire turns; the periodic ALARM still fires every
// 7 min, so a long conversation can't defer the upload forever.
async function append(rec) {
  if (!rec || !rec.externalId || (!rec.promptSha256 && !rec.outputSha256)) return { ok: false, reason: 'empty' }
  try {
    await withBuffer(async (buf) => {
      // authoritative local retention check — a stale content script can't
      // persist raw text after the firm turned retention off (TTL-bounded)
      if (!(await retentionOn())) { delete rec.promptText; delete rec.outputText }
      // bound per-event storage to what the server would keep anyway
      if (rec.promptText && rec.promptText.length > MAX_FIELD) rec.promptText = rec.promptText.slice(0, MAX_FIELD)
      if (rec.outputText && rec.outputText.length > MAX_FIELD) rec.outputText = rec.outputText.slice(0, MAX_FIELD)
      rec.surface = SURFACE
      rec.os = OS
      const prev = buf.length ? buf[buf.length - 1].localHash : ''
      rec.prevHash = prev || null
      rec.localHash = await sha256Hex(chainProjection(rec) + prev)
      if (buf.length + 1 >= BACKLOG_WARN) console.warn(`[AI Compliance] ${buf.length + 1} events pending upload — check the connection/token in the popup`)
      return buf.concat(rec)
    })
  } catch (e) {
    // storage failure — surface it; the turn is lost only if the page also
    // can't retry, so make the failure visible rather than silent
    console.error('[AI Compliance] buffer append failed', e)
    return { ok: false, reason: String(e) }
  }
  chrome.alarms.create(ALARM_SOON, { delayInMinutes: 0.5 })
  return { ok: true }
}

async function status() {
  const { [KEY]: buf = [] } = await chrome.storage.local.get(KEY)
  const cfg = await getCfg()
  const { [AUTH_ERR]: authError } = await chrome.storage.local.get(AUTH_ERR)
  const mode = cfg?.session ? 'code' : cfg?.accessToken ? 'legacy' : 'none'
  return {
    pending: buf.length,
    connected: mode !== 'none',
    mode,
    email: cfg?.session?.email || null,
    appOrigin: cfg?.appOrigin || '',
    authError: authError || null,
  }
}

// Refresh the firm's content-retention setting so capture knows whether to
// keep raw text, and so we strip it on send if it was turned off.
async function refreshConfig(appOrigin, token) {
  try {
    const res = await fetch(appOrigin.replace(/\/$/, '') + '/api/capture-config', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) { const b = await res.json(); await chrome.storage.local.set({ aicompliance_retain: !!b.retainRaw, aicompliance_retain_at: Date.now() }) }
  } catch { /* keep the last known value; retentionOn() ages it out */ }
}

// Effective retention = the cached flag, but ONLY while fresh (Codex P2: an
// admin turning retention OFF must not be defeated by a permanently-failing
// config refresh - after the TTL with no successful re-check, fail closed to
// hash-only). The server independently re-checks on ingest either way; this
// bounds how long raw text can accumulate LOCALLY against a stale 'true'.
const RETAIN_TTL_MS = 24 * 60 * 60 * 1000
async function retentionOn() {
  const { aicompliance_retain: retain, aicompliance_retain_at: at } = await chrome.storage.local.get(['aicompliance_retain', 'aicompliance_retain_at'])
  return !!retain && typeof at === 'number' && Date.now() - at < RETAIN_TTL_MS
}

async function sync() {
  const cfg = await getCfg()
  if (!cfg?.appOrigin || (!cfg.session && !cfg.accessToken)) return { ok: false, reason: 'not connected' }
  let token = await accessToken()
  if (!token) {
    const { [AUTH_ERR]: err } = await chrome.storage.local.get(AUTH_ERR)
    return { ok: false, reason: err || 'not connected' }
  }
  await refreshConfig(cfg.appOrigin, token)

  // Authoritative gate: if retention is currently OFF - or the cached 'on' has
  // gone STALE past the TTL (fail closed, Codex P2) - never send raw text even
  // if a record was buffered with it. Strip raw text from the PERSISTED buffer
  // (serialized — can't clobber an append) so raw content never lingers in
  // chrome.storage while the firm is off.
  const retain = await retentionOn()
  const buf = await withBuffer(async (b) => {
    if (!retain && b.some((e) => e.promptText != null || e.outputText != null)) {
      return b.map((e) => { const { promptText, outputText, ...rest } = e; return rest })
    }
    return null // no write needed
  })
  if (!buf.length) return { ok: true, uploaded: 0 }

  const MAX_BODY = 1_800_000 // stay under /api/ingest's 2MB pre-parse limit
  const MAX_FIELD = 100_000  // matches the server clip; bounds any single event
  const prep = (e) => {
    // never send the local chain fields; strip text when retention is off
    const { prevHash, localHash, ...ev } = e
    if (!retain) { const { promptText, outputText, ...rest } = ev; return rest }
    if ((ev.promptText && ev.promptText.length > MAX_FIELD) || (ev.outputText && ev.outputText.length > MAX_FIELD)) {
      return { ...ev, promptText: ev.promptText ? ev.promptText.slice(0, MAX_FIELD) : ev.promptText, outputText: ev.outputText ? ev.outputText.slice(0, MAX_FIELD) : ev.outputText }
    }
    return ev
  }
  // Byte-aware batching: accumulate a PREFIX of the buffer whose UTF-8 body fits
  // the limit (with raw text this can exceed 2MB) so a big retained batch never
  // wedges the queue with a permanent 413. Always include >=1 event to progress.
  // Measure real UTF-8 bytes (JSON.stringify().length undercounts multibyte text).
  const enc = new TextEncoder()
  const batch = []
  let size = 2 // "[]"
  for (const e of buf) {
    const item = prep(e)
    const s = enc.encode(JSON.stringify(item)).length + 1
    if (batch.length && size + s > MAX_BODY) break
    batch.push(item); size += s
    if (batch.length >= 500) break
  }
  try {
    const post = (tk) => fetch(cfg.appOrigin.replace(/\/$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
      body: JSON.stringify({ events: batch }),
    })
    let res = await post(token)
    if (res.status === 401 && cfg.session) {
      // access token may have just aged out server-side — refresh once, retry once
      token = await accessToken(true)
      if (!token) {
        const { [AUTH_ERR]: err } = await chrome.storage.local.get(AUTH_ERR)
        return { ok: false, reason: err || 'session invalid' }
      }
      res = await post(token)
    }
    if (res.status === 401) {
      return { ok: false, reason: cfg.session ? 'session invalid — connect again with a new code' : 'session expired — reconnect in the popup' }
    }
    if (!res.ok) return { ok: false, reason: `server ${res.status}` }
    const body = await res.json().catch(() => null)
    // FAIL CLOSED: remove ONLY events the server explicitly acknowledged. A 2xx
    // without a valid `accepted` array (API mismatch, malformed response) keeps
    // the whole batch buffered for retry — never assume-ack (Codex P2).
    if (!body || !Array.isArray(body.accepted)) return { ok: false, reason: 'malformed server response — kept buffer' }
    const acked = new Set(body.accepted)
    await withBuffer(async (b) => b.filter((e) => !acked.has(e.externalId)))
    return { ok: true, uploaded: acked.size, ...body }
  } catch (e) {
    return { ok: false, reason: String(e) }
  }
}
