import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import type { Config, IngestEvent } from './types'
import type { SessionCreds } from './auth'

// Durable local store: user settings (config.json) + runtime state (state.json:
// per-file read offsets, the not-yet-acked ingest queue, and a capped ring of
// already-ingested externalIds for dedup). Everything lives under Electron's
// per-app userData dir. Raw prompt/output text is only ever written into the
// queue when the firm has content-retention on (see Ingest) — data-minimization
// holds on disk too.
const DEFAULT_CONFIG: Config = { appOrigin: '', token: '', paused: false, launchAtLogin: true, sources: { cli: true, desktop: true, codex: true } }
const SEEN_CAP = 20_000

export class Store {
  config: Config = { ...DEFAULT_CONFIG }
  // The connect-code session (access + refresh token). Held OUTSIDE config so it
  // never rides the IPC state payload into the renderer; persisted encrypted at
  // rest via Electron safeStorage (Keychain / DPAPI) when available.
  session: SessionCreds | null = null
  offsets: Record<string, number> = {}
  queue: IngestEvent[] = []
  private seen = new Set<string>()
  private seenOrder: string[] = []

  private cfgPath() { return join(app.getPath('userData'), 'config.json') }
  private statePath() { return join(app.getPath('userData'), 'state.json') }

  load() {
    try {
      if (existsSync(this.cfgPath())) {
        const c = JSON.parse(readFileSync(this.cfgPath(), 'utf8'))
        this.session = this.readSession(c)
        delete c.encSession; delete c.session
        this.config = { ...DEFAULT_CONFIG, ...c, sources: { ...DEFAULT_CONFIG.sources, ...(c.sources || {}) } }
      }
    } catch { /* keep defaults */ }
    try {
      if (existsSync(this.statePath())) {
        const s = JSON.parse(readFileSync(this.statePath(), 'utf8'))
        this.offsets = s.offsets && typeof s.offsets === 'object' ? s.offsets : {}
        this.queue = Array.isArray(s.queue) ? s.queue : []
        this.seenOrder = Array.isArray(s.seen) ? s.seen.slice(-SEEN_CAP) : []
        this.seen = new Set(this.seenOrder)
      }
    } catch { /* keep empty */ }
  }

  saveConfig() { this.write(this.cfgPath(), { ...this.config, ...this.sessionForDisk() }) }

  setSession(s: SessionCreds | null) { this.session = s; this.saveConfig() }

  // Session at rest: encrypted via safeStorage (macOS Keychain / Windows DPAPI /
  // Linux keyring) when the OS provides it; plaintext-in-0600-file fallback
  // otherwise (same posture as the legacy pasted token).
  private sessionForDisk(): { encSession?: string; session?: SessionCreds } {
    if (!this.session) return {}
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return { encSession: safeStorage.encryptString(JSON.stringify(this.session)).toString('base64') }
      }
    } catch { /* fall through to plaintext */ }
    return { session: this.session }
  }

  private readSession(c: Record<string, unknown>): SessionCreds | null {
    try {
      if (typeof c.encSession === 'string' && c.encSession) {
        return JSON.parse(safeStorage.decryptString(Buffer.from(c.encSession, 'base64')))
      }
      if (c.session && typeof c.session === 'object') return c.session as SessionCreds
    } catch (e) { console.error('[store] could not read stored session (reconnect needed)', e) }
    return null
  }
  saveState() { this.write(this.statePath(), { offsets: this.offsets, queue: this.queue, seen: this.seenOrder }) }

  // Atomic write: temp file (0600 - the config holds the bearer token and the
  // state may hold retained raw text) then rename over the target, so a crash or
  // full disk can't truncate the file and lose offsets/queue. Surfaces failures
  // to the console (a status surface is a follow-up).
  lastWriteError: string | null = null
  private write(path: string, data: unknown) {
    const tmp = path + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, path)
      this.lastWriteError = null
    } catch (e) {
      this.lastWriteError = String(e)
      console.error('[store] persist failed for', path, e)
    }
  }

  getOffset(path: string): number | undefined { return this.offsets[path] }
  setOffset(path: string, n: number) { this.offsets[path] = n; this.saveState() }

  // true if newly seen (enqueue it); false if already ingested (skip).
  markSeen(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id); this.seenOrder.push(id)
    if (this.seenOrder.length > SEEN_CAP) { const drop = this.seenOrder.splice(0, this.seenOrder.length - SEEN_CAP); for (const d of drop) this.seen.delete(d) }
    return true
  }
}
