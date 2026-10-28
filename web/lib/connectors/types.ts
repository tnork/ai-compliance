// One normalized shape for a captured AI interaction, whatever the source.
// Both the enterprise connector (this dir) and the browser extension (via
// /api/ingest) produce these; the ingest_ai_event RPC consumes them.
export type NormalizedEvent = {
  externalId: string          // provider's stable id - idempotency key
  userEmail: string           // resolved to app_user by email within the firm
  occurredAt: string          // ISO-8601
  tool: string                // 'ChatGPT' | 'Claude' | 'Grok' | ...
  model?: string | null
  promptText?: string | null  // hashed then discarded (metadata-only default)
  outputText?: string | null
  // pre-hashed variant (the extension hashes on-device so raw text never leaves
  // the browser); when present these win over promptText/outputText.
  promptSha256?: string | null
  promptBytes?: number | null
  outputSha256?: string | null
  outputBytes?: number | null
  dataKind?: string | null
  clientRef?: string | null
  // capture-surface telemetry (0029): browser name for the extension, 'desktop'
  // for the desktop logger, 'connector' for enterprise pulls; os when known.
  // Supplementary - never part of the record hash.
  surface?: string | null
  os?: string | null
}

export type Provider = 'openai' | 'anthropic' | 'grok' | 'gemini' | 'copilot'

export type FetchWindow = {
  secret: string              // decrypted provider credential
  scopeRef?: string | null    // workspace/org id
  cursor?: string | null      // provider pagination cursor (resume point)
  sinceISO: string            // lower time bound for this pull
  // injectable for tests; defaults to global fetch in production
  fetchImpl?: typeof fetch
}

export type FetchResult = {
  events: NormalizedEvent[]
  nextCursor: string | null   // null = caught up
}

export type ProviderAdapter = {
  provider: Provider
  label: string
  // NOTE: the HTTP calls below are written to each provider's DOCUMENTED 2026
  // Compliance/audit API shape but are validated only against synthetic payloads
  // here - live validation needs a real enterprise workspace credential.
  fetchWindow(opts: FetchWindow): Promise<FetchResult>
}
