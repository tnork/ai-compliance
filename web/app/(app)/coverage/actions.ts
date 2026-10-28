'use server'

import { redirect } from 'next/navigation'
import { requireViewLogs } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyChain, type ChainEvent } from '@/lib/hashchain'
import { computeCoverage, fetchAllRows, loadFirmEvidence, type EventRow } from '@/lib/coverage'

// Generate a point-in-time defense packet. Everything integrity-critical
// happens in the generate_defense_packet() RPC (migration 0012): attribution,
// the event set, chain head, generated_at, and packet_hash are all derived
// in-DB - the client supplies ONLY the coverage summary, which the hash then
// binds. The summary FREEZES all rendered content (findings, clause text,
// firm name) so the packet displays what was true at generation forever.
export async function generatePacket() {
  const me = await requireViewLogs()
  const supabase = await createClient()

  let summary: unknown
  try {
    const events = await fetchAllRows<EventRow & ChainEvent>(supabase, 'ai_event', '*',
      [{ column: 'created_at', ascending: true }, { column: 'id', ascending: true }])
    if (events.length === 0) {
      redirect('/coverage?e=' + encodeURIComponent('No review records yet - log at least one before generating a packet.'))
    }
    const arts = await fetchAllRows<{ id: string; sha256: string }>(supabase, 'artifact', 'id, sha256',
      [{ column: 'created_at', ascending: true }])
    const verdict = verifyChain(events, new Map(arts.map((a) => [a.id, a.sha256])))
    if (!verdict.ok) {
      redirect('/coverage?e=' + encodeURIComponent('Chain verification failed - resolve record integrity before exporting a packet.'))
    }

    const firm = await loadFirmEvidence(supabase)
    const cov = computeCoverage(events, firm)
    const { data: clauses, error: clErr } = await supabase
      .from('standard_clause').select('clause_code, title, requirement, sort').order('sort')
    if (clErr) throw new Error('standard_clause query failed: ' + clErr.message)

    summary = {
      v: 2,
      firmName: me.firmName,
      scope: 'firm',
      coveragePct: cov.coveragePct,
      perClause: cov.perClause,
      firmGaps: cov.firmGaps,
      clauses: (clauses ?? []).map((c) => ({ code: c.clause_code, title: c.title, requirement: c.requirement })),
      events: cov.events.map((ev) => ({ id: ev.id, findings: ev.findings })),
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'digest' in e) throw e // Next redirect()
    redirect('/coverage?e=' + encodeURIComponent(e instanceof Error ? e.message : 'evidence queries failed'))
  }

  // packet generation is service-role only (0019): the coverage summary is
  // derived HERE from the firm's real, RLS-scoped records - a client can no
  // longer call the RPC directly with a fabricated summary. firm_id/generated_by
  // are passed explicitly (service role has no auth.uid()).
  const { data: packetId, error } = await createAdminClient().rpc('generate_defense_packet', {
    p_firm_id: me.firm_id, p_generated_by: me.id, p_summary: summary,
  })
  if (error || !packetId) redirect('/coverage?e=' + encodeURIComponent(error?.message ?? 'packet generation failed'))

  redirect(`/packet/${packetId}`)
}
