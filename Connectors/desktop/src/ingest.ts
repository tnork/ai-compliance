import os from 'node:os'
import type { IngestEvent, Turn } from './types'
import type { Store } from './store'
import { sha256, byteLen } from './hash'
import { refreshSession, AuthInvalidError } from './auth'

// capture-surface telemetry (0029): the desktop logger reports surface=desktop
// + the host OS on every event (macos/windows/linux)
const OS = os.platform() === 'darwin' ? 'macos' : os.platform() === 'win32' ? 'windows' : 'linux'

const MAX_FIELD = 100_000 // matches the server clip
const MAX_BODY = 1_800_000 // stay under /api/ingest's 2MB pre-parse limit

export interface Status { pending: number; lastError?: string; lastSyncAt?: string; retainRaw: boolean }

// Turns -> a durable queue -> batched POST /api/ingest (source=desktop_agent).
// Mirrors the browser extension: always send sha256+bytes; include RAW text only
// when the firm has content-retention on (re-checked server-side too). Events
// stay queued until the server acks them, so a crash never loses evidence.
export class Ingest {
  private retainRaw = false
  private lastError?: string
  private lastSyncAt?: string

  constructor(private store: Store, private onStatus: (s: Status) => void) {}

  private origin() { return this.store.config.appOrigin.replace(/\/$/, '') }

  private connected() { return !!this.origin() && (!!this.store.session || !!this.store.config.token) }

  // ---- auth: connect-code session (self-refreshing) with legacy-token fallback ----
  private refreshing: Promise<boolean> | null = null
  private doRefresh(): Promise<boolean> {
    // serialize concurrent refreshes — refresh tokens are single-use (rotation)
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const s = this.store.session
        if (!s) return false
        try {
          this.store.setSession(await refreshSession(s))
          // Rotation makes the OLD refresh token single-use: if the rotated pair
          // couldn't be persisted, a restart would load the dead old token and
          // the session dies silently. Keep syncing on the in-memory session
          // (evidence still uploads) but surface the persistence failure loudly
          // (Codex P2).
          if (this.store.lastWriteError) {
            this.lastError = `session refreshed but NOT saved to disk (${this.store.lastWriteError}) — a restart will need a new connect code`
          }
          return true
        } catch (e) {
          if (e instanceof AuthInvalidError) { this.store.setSession(null); this.lastError = e.message }
          else this.lastError = String(e instanceof Error ? e.message : e)
          return false
        }
      })().finally(() => { this.refreshing = null })
    }
    return this.refreshing
  }
  private async accessToken(forceRefresh = false): Promise<string | null> {
    const s = this.store.session
    if (s) {
      if (forceRefresh || Date.now() > s.expiresAt - 90_000) {
        if (!(await this.doRefresh())) return null
      }
      return this.store.session?.accessToken ?? null
    }
    return this.store.config.token || null
  }

  private status(): Status {
    return { pending: this.store.queue.length, lastError: this.lastError, lastSyncAt: this.lastSyncAt, retainRaw: this.retainRaw }
  }
  private emitStatus() { this.onStatus(this.status()) }

  enqueue(turn: Turn) {
    if (!this.store.markSeen(turn.externalId)) return // already ingested
    const pText = (turn.promptText || '').slice(0, MAX_FIELD)
    const oText = (turn.outputText || '').slice(0, MAX_FIELD)
    const ev: IngestEvent = {
      externalId: turn.externalId,
      occurredAt: turn.occurredAt,
      tool: turn.tool,
      model: turn.model,
      promptSha256: pText ? sha256(pText) : null,
      promptBytes: pText ? byteLen(pText) : null,
      outputSha256: oText ? sha256(oText) : null,
      outputBytes: oText ? byteLen(oText) : null,
      // raw text only when retention is on; otherwise never persisted locally
      promptText: this.retainRaw ? pText : null,
      outputText: this.retainRaw ? oText : null,
      surface: 'desktop',
      os: OS,
    }
    this.store.queue.push(ev)
    this.store.saveState()
    this.emitStatus()
  }

  // Freshness-bounded (Codex P2): a permanently-failing config refresh must
  // not leave a stale retainRaw=true collecting raw text locally forever -
  // past the TTL with no successful re-check, fail closed to hash-only.
  private retainCheckedAt = 0
  private static RETAIN_TTL_MS = 24 * 60 * 60 * 1000
  private async refreshRetention() {
    if (!this.connected()) return
    try {
      const token = await this.accessToken()
      if (!token) return
      const res = await fetch(this.origin() + '/api/capture-config', { headers: { Authorization: `Bearer ${token}` } })
      if (res.ok) { this.retainRaw = !!(await res.json()).retainRaw; this.retainCheckedAt = Date.now() }
    } catch { /* keep last known; the TTL below ages it out */ }
    if (this.retainRaw && Date.now() - this.retainCheckedAt > Ingest.RETAIN_TTL_MS) this.retainRaw = false
  }

  async sync(): Promise<{ ok: boolean; uploaded?: number; reason?: string }> {
    if (this.store.config.paused) return { ok: false, reason: 'paused' }
    if (!this.connected()) { this.lastError = 'not connected'; this.emitStatus(); return { ok: false, reason: 'not connected' } }
    await this.refreshRetention()
    if (!this.store.queue.length) { this.emitStatus(); return { ok: true, uploaded: 0 } }

    // authoritative: if retention is OFF, never send raw text even if a record was
    // queued with it (admin may have turned it off since capture). Persist the
    // sanitized queue NOW — otherwise raw text lingers in state.json if this sync
    // fails (401/error) or the app quits before a successful upload.
    if (!this.retainRaw && this.store.queue.some((e) => e.promptText !== null || e.outputText !== null)) {
      this.store.queue = this.store.queue.map((e) => ({ ...e, promptText: null, outputText: null }))
      this.store.saveState()
    }

    // byte-bounded prefix (<=500, <=~1.8MB) so a big retained batch can't wedge
    // the queue with a permanent 413.
    const enc = new TextEncoder()
    const batch: IngestEvent[] = []
    let size = 2
    for (const e of this.store.queue) {
      const s = enc.encode(JSON.stringify(e)).length + 1
      if (batch.length && size + s > MAX_BODY) break
      batch.push(e); size += s
      if (batch.length >= 500) break
    }

    try {
      let token = await this.accessToken()
      if (!token) { this.emitStatus(); return { ok: false, reason: this.lastError || 'not connected' } }
      const post = (tk: string) => fetch(this.origin() + '/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}` },
        body: JSON.stringify({ events: batch, source: 'desktop_agent' }),
      })
      let res = await post(token)
      if (res.status === 401 && this.store.session) {
        // access token may have just aged out server-side — refresh once, retry once
        token = await this.accessToken(true)
        if (!token) { this.emitStatus(); return { ok: false, reason: this.lastError || 'session invalid' } }
        res = await post(token)
      }
      if (res.status === 401) {
        this.lastError = this.store.session
          ? 'session invalid — generate a new connect code in the app'
          : 'session expired — paste a fresh token (or use a connect code, which stays connected)'
        this.emitStatus()
        return { ok: false, reason: 'session expired' }
      }
      if (!res.ok) { this.lastError = `server ${res.status}`; this.emitStatus(); return { ok: false, reason: `server ${res.status}` } }
      const body = await res.json().catch(() => null)
      // FAIL CLOSED: only drop events the server explicitly acked - a 2xx with
      // no valid `accepted` array keeps the queue for retry (Codex P2, same fix
      // as the browser extension).
      if (!body || !Array.isArray(body.accepted)) {
        this.lastError = 'malformed server response — kept queue'
        this.emitStatus()
        return { ok: false, reason: 'malformed server response' }
      }
      const acked = new Set<string>(body.accepted)
      this.store.queue = this.store.queue.filter((e) => !acked.has(e.externalId))
      this.store.saveState()
      this.lastError = undefined
      this.lastSyncAt = new Date().toISOString()
      this.emitStatus()
      return { ok: true, uploaded: acked.size }
    } catch (e) {
      this.lastError = String(e)
      this.emitStatus()
      return { ok: false, reason: String(e) }
    }
  }

  getStatus() { return this.status() }
}
