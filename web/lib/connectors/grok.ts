import type { ProviderAdapter, FetchWindow, FetchResult, NormalizedEvent } from './types'

// xAI / Grok. IMPORTANT LIMIT: xAI's enterprise offering exposes a Console
// AUDIT LOG of API-server interactions (searchable by event id / user), NOT a
// full conversation-content JSONL export like OpenAI/Anthropic. So Grok capture
// is USAGE-LEVEL (who/when/model) - prompt/output CONTENT is generally absent.
// That still produces a valid supervision record (a §10.22 "AI was used, needs
// review" event) but the packet should not imply content was captured when it
// wasn't. Shape written to the documented audit-log behavior; needs live
// validation against a Grok Enterprise console credential.
export const grokAdapter: ProviderAdapter = {
  provider: 'grok',
  label: 'xAI / Grok Enterprise (usage-level)',
  async fetchWindow({ secret, cursor, sinceISO, fetchImpl }: FetchWindow): Promise<FetchResult> {
    const f = fetchImpl ?? fetch
    const url = new URL('https://api.x.ai/v1/audit-log')
    url.searchParams.set('since', sinceISO)
    if (cursor) url.searchParams.set('cursor', cursor)

    const res = await f(url, { headers: { Authorization: `Bearer ${secret}` } })
    if (!res.ok) throw new Error(`grok audit-log ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { events?: Record<string, unknown>[]; next_cursor?: string | null }

    const events: NormalizedEvent[] = []
    for (const r of body.events ?? []) {
      const email = (r.user_email ?? r.user ?? '') as string
      if (!email) continue
      events.push({
        externalId: String(r.event_id ?? r.id),
        userEmail: email,
        occurredAt: new Date((r.timestamp as string) ?? (r.created_at as string) ?? sinceISO).toISOString(),
        tool: 'Grok',
        model: (r.model as string) ?? null,
        // usage-level: no content - record documents that AI was used, pending review
        promptText: null,
        outputText: null,
      })
    }
    return { events, nextCursor: body.next_cursor ?? null }
  },
}
