import type { ProviderAdapter, FetchWindow, FetchResult, NormalizedEvent } from './types'

// Microsoft 365 Copilot — enterprise interaction history via Microsoft Graph
// (copilot/users/getAllEnterpriseInteractions). Bearer is an Azure AD app token
// with AiEnterpriseInteraction.Read.All. Unlike the Gemini Workspace audit, this
// endpoint returns interaction CONTENT: each record is a userPrompt or aiResponse
// with body.content, paired by sessionId. (Purview / eDiscovery is the alternate
// content path — hence source_t='purview'.) Request shape written to the
// documented Graph behavior; MUST be validated against a live M365 tenant.
export const copilotAdapter: ProviderAdapter = {
  provider: 'copilot',
  label: 'Microsoft / Copilot (M365)',
  async fetchWindow({ secret, cursor, sinceISO, fetchImpl }: FetchWindow): Promise<FetchResult> {
    const f = fetchImpl ?? fetch
    const url = new URL('https://graph.microsoft.com/v1.0/copilot/users/getAllEnterpriseInteractions')
    url.searchParams.set('$filter', `createdDateTime gt ${sinceISO}`)
    if (cursor) url.searchParams.set('$skiptoken', cursor)

    const res = await f(url, { headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' } })
    if (!res.ok) throw new Error(`copilot graph ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { value?: Record<string, unknown>[]; '@odata.nextLink'?: string }

    const events: NormalizedEvent[] = []
    for (const r of body.value ?? []) {
      const from = (r.from ?? {}) as Record<string, unknown>
      const user = (from.user ?? {}) as Record<string, unknown>
      const email = (user.mail ?? user.email ?? user.userPrincipalName ?? '') as string
      if (!email) continue
      const kind = r.interactionType as string // 'userPrompt' | 'aiResponse'
      const bodyObj = (r.body ?? {}) as Record<string, unknown>
      const content = (bodyObj.content ?? '') as string
      events.push({
        externalId: String(r.id ?? `${r.sessionId}:${r.createdDateTime}`),
        userEmail: email,
        occurredAt: new Date((r.createdDateTime as string) ?? sinceISO).toISOString(),
        tool: 'Copilot',
        model: null,
        promptText: kind === 'userPrompt' ? content : null,
        outputText: kind === 'aiResponse' ? content : null,
        clientRef: (r.sessionId as string) ?? null,
      })
    }

    // Graph paginates via @odata.nextLink; persist just its $skiptoken as cursor.
    let nextCursor: string | null = null
    const next = body['@odata.nextLink']
    if (next) { try { nextCursor = new URL(next).searchParams.get('$skiptoken') } catch { nextCursor = null } }
    return { events, nextCursor }
  },
}
