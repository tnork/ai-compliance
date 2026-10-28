import type { ProviderAdapter, FetchWindow, FetchResult, NormalizedEvent } from './types'

// Google Workspace — Gemini usage via the Admin SDK Reports API (audit
// activities for the 'gemini_in_workspace_apps' application). Bearer is an OAuth2
// access token for a Workspace admin with reports.audit.readonly.
//
// IMPORTANT LIMIT (like Grok): the Workspace audit log is USAGE-LEVEL — who/when/
// which surface — prompt/output CONTENT is NOT exposed here (Vault is a separate
// content path). So this documents that Gemini WAS used (a valid §10.22 "AI used,
// needs review" event) without capturing content; the packet must not imply
// content was captured when it wasn't. Request shape written to the documented
// behavior; MUST be validated against a live Workspace before trusting.
export const geminiAdapter: ProviderAdapter = {
  provider: 'gemini',
  label: 'Google / Gemini (Workspace, usage-level)',
  async fetchWindow({ secret, cursor, sinceISO, fetchImpl }: FetchWindow): Promise<FetchResult> {
    const f = fetchImpl ?? fetch
    const url = new URL('https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/gemini_in_workspace_apps')
    url.searchParams.set('startTime', sinceISO)
    if (cursor) url.searchParams.set('pageToken', cursor)

    const res = await f(url, { headers: { Authorization: `Bearer ${secret}` } })
    if (!res.ok) throw new Error(`gemini reports ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as { items?: Record<string, unknown>[]; nextPageToken?: string | null }

    const events: NormalizedEvent[] = []
    for (const it of body.items ?? []) {
      const actor = (it.actor ?? {}) as Record<string, unknown>
      const email = (actor.email ?? '') as string
      if (!email) continue
      const id = (it.id ?? {}) as Record<string, unknown>
      const time = (id.time as string) ?? sinceISO
      const qualifier = String(id.uniqueQualifier ?? time)
      events.push({
        externalId: `gemini:${qualifier}`,
        userEmail: email,
        occurredAt: new Date(time).toISOString(),
        tool: 'Gemini',
        model: null,
        // usage-level: no content in the Workspace audit log
        promptText: null,
        outputText: null,
      })
    }
    return { events, nextCursor: body.nextPageToken ?? null }
  },
}
