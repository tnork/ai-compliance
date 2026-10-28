import type { ProviderAdapter, FetchWindow, FetchResult, NormalizedEvent } from './types'

// OpenAI Compliance Platform (rebuilt 2026-03). Base api.chatgpt.com/v1/compliance,
// Bearer Enterprise Compliance API key, immutable time-windowed JSONL with
// cursor pagination, scope workspaces/{id} or organizations/{id}. Returns every
// user input + model output. Docs require an enterprise login to view the exact
// path, so the request shape below is written to the documented behavior and
// MUST be validated against a live workspace before trusting in production.
export const openaiAdapter: ProviderAdapter = {
  provider: 'openai',
  label: 'OpenAI / ChatGPT Enterprise',
  async fetchWindow({ secret, scopeRef, cursor, sinceISO, fetchImpl }: FetchWindow): Promise<FetchResult> {
    const f = fetchImpl ?? fetch
    const scope = scopeRef ? (scopeRef.startsWith('org') ? `organizations/${scopeRef}` : `workspaces/${scopeRef}`) : 'workspaces/default'
    const url = new URL(`https://api.chatgpt.com/v1/compliance/${scope}/conversations`)
    url.searchParams.set('since', sinceISO)
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await f(url, { headers: { Authorization: `Bearer ${secret}`, Accept: 'application/x-ndjson' } })
    if (!res.ok) throw new Error(`openai compliance ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const nextCursor = res.headers.get('x-next-cursor') || null

    const events: NormalizedEvent[] = []
    // JSONL: one conversation-message record per line
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue
      let r: Record<string, unknown>
      try { r = JSON.parse(line) } catch { continue }
      const role = r.role ?? (r as Record<string, Record<string, unknown>>).message?.role
      // capture the paired user prompt + assistant output; skip system/tool lines
      const msg = (r.content ?? (r as Record<string, Record<string, unknown>>).message?.content ?? '') as string
      const email = (r.user_email ?? r.user ?? (r as Record<string, Record<string, unknown>>).author?.email ?? '') as string
      if (!email) continue
      events.push({
        externalId: String(r.id ?? r.message_id ?? `${r.conversation_id}:${r.created_at}`),
        userEmail: email,
        occurredAt: new Date((r.created_at as string) ?? sinceISO).toISOString(),
        tool: 'ChatGPT',
        model: (r.model as string) ?? null,
        promptText: role === 'user' ? msg : null,
        outputText: role === 'assistant' ? msg : null,
      })
    }
    return { events, nextCursor }
  },
}
