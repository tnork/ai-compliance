import type { ProviderAdapter, FetchWindow, FetchResult, NormalizedEvent } from './types'

// Anthropic Compliance API (since 2025-08). Bearer, programmatic access to
// claude.ai org chats/files/users; 180-day retention. KNOWN GAP: Claude Cowork
// activity is explicitly excluded from Anthropic's audit logs + Compliance API,
// so Cowork usage will not appear here - surface that as an uncovered account,
// not a false "all clear". Request shape written to documented behavior; needs
// live enterprise validation.
export const anthropicAdapter: ProviderAdapter = {
  provider: 'anthropic',
  label: 'Anthropic / Claude Enterprise',
  async fetchWindow({ secret, scopeRef, cursor, sinceISO, fetchImpl }: FetchWindow): Promise<FetchResult> {
    const f = fetchImpl ?? fetch
    const url = new URL('https://api.anthropic.com/v1/organizations/compliance/conversations')
    url.searchParams.set('since', sinceISO)
    if (scopeRef) url.searchParams.set('organization_id', scopeRef)
    if (cursor) url.searchParams.set('after_id', cursor)

    const res = await f(url, { headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } })
    if (!res.ok) throw new Error(`anthropic compliance ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { data?: Record<string, unknown>[]; has_more?: boolean; last_id?: string | null }

    const events: NormalizedEvent[] = []
    for (const r of body.data ?? []) {
      const email = (r.actor_email ?? r.user_email ?? (r as Record<string, Record<string, unknown>>).actor?.email ?? '') as string
      if (!email) continue
      events.push({
        externalId: String(r.id ?? r.uuid),
        userEmail: email,
        occurredAt: new Date((r.created_at as string) ?? sinceISO).toISOString(),
        tool: 'Claude',
        model: (r.model as string) ?? null,
        promptText: (r.input ?? r.prompt ?? null) as string | null,
        outputText: (r.output ?? r.completion ?? null) as string | null,
      })
    }
    return { events, nextCursor: body.has_more ? (body.last_id ?? null) : null }
  },
}
