// Shared types for the AI Compliance desktop logger.

// A captured supervision unit: one human prompt -> the assistant's text answer.
export interface Turn {
  externalId: string // stable dedup key, e.g. "cc:<uuid>" / "cd:<uuid>"
  tool: string // "Claude Code" | "Claude Desktop"
  model: string | null
  occurredAt: string // ISO 8601
  promptText: string
  outputText: string
}

// The event shape POSTed to /api/ingest (mirrors the browser extension). Raw
// text is included ONLY when the firm has content-retention on; otherwise we
// send hash-only (data-minimization) and the server stores just the hashes.
export interface IngestEvent {
  externalId: string
  occurredAt: string
  tool: string
  model: string | null
  promptText?: string | null
  outputText?: string | null
  promptSha256: string | null
  promptBytes: number | null
  outputSha256: string | null
  outputBytes: number | null
  // capture-surface telemetry (0029): 'desktop' + the host OS
  surface: string
  os: string
}

export interface Config {
  appOrigin: string // e.g. http://localhost:3000 or https://app.example.com
  // LEGACY fallback: a pasted Supabase access token (expires ~hourly). The
  // primary connection is now the connect-code session held on Store.session.
  token: string
  paused: boolean
  launchAtLogin: boolean
  sources: { cli: boolean; desktop: boolean; codex: boolean }
}

export interface PersistedState {
  offsets: Record<string, number> // absolute file path -> bytes already read
  seen: string[] // externalIds already ingested (capped ring buffer)
}
