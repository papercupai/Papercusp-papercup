/** P-008: deterministic outcomes on the existing session/epoch ledger.
 * Contradiction wins over use; replaying a tool call does not count twice.
 * Canonical counters survive the ledger's fourteen-day GC. */
import type { SqlTag } from './bump-last-surfaced';
import type { MemoryEntry } from './backend';

export type SurfacedOutcome = 'used' | 'contradicted';
export interface OutcomeCounts { used: number; contradicted: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordSurfacedOutcome(
  sql: SqlTag, sessionId: string, memoryIds: readonly string[], outcome: SurfacedOutcome,
): Promise<void> {
  const ids = [...new Set(memoryIds.filter(id => UUID.test(id)))];
  if (!sessionId || !ids.length) return;
  // Lock before reading the previous outcome. Concurrent fetch/update calls must
  // apply exactly one transition, including used -> contradicted.
  await sql`
    WITH prior AS MATERIALIZED (
      SELECT session_id, epoch, memory_id, outcome AS previous
      FROM harness_shared.memory_session_surfaced
      WHERE session_id = ${sessionId} AND memory_id = ANY(${ids}::uuid[])
        AND outcome <> 'contradicted' AND outcome <> ${outcome}
      ORDER BY memory_id, epoch FOR UPDATE
    ), changed AS (
      UPDATE harness_shared.memory_session_surfaced s
      SET outcome = ${outcome}, outcome_at = now()
      FROM prior p
      WHERE s.session_id = p.session_id AND s.epoch = p.epoch AND s.memory_id = p.memory_id
      RETURNING s.memory_id, p.previous
    ), deltas AS (
      SELECT memory_id,
        sum(CASE WHEN ${outcome} = 'used' THEN 1 WHEN previous = 'used' THEN -1 ELSE 0 END)::int AS used_delta,
        sum(CASE WHEN ${outcome} = 'contradicted' THEN 1 ELSE 0 END)::int AS contradicted_delta
      FROM changed GROUP BY memory_id
    )
    UPDATE harness_shared.memory_canonical m
    SET used_count = m.used_count + d.used_delta,
        contradicted_count = m.contradicted_count + d.contradicted_delta
    FROM deltas d WHERE m.id = d.memory_id
  `;
}

/** Report capture failure separately: never turn a successful privacy mutation
 * into a retry of that mutation because its learning signal failed. */
export async function captureSurfacedOutcome(
  ctx: { uiClientId?: string | null } | undefined, memoryIds: readonly string[], outcome: SurfacedOutcome,
): Promise<{ ok: boolean; reason?: string }> {
  if (!ctx?.uiClientId || !memoryIds.length) return { ok: true };
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { withMemoryToolTimeout } = await import('./op-deadline');
    await withMemoryToolTimeout(recordSurfacedOutcome(getOrgPg().sql, ctx.uiClientId, memoryIds, outcome), 'memory outcome');
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[memory-outcome] capture failed:', reason);
    return { ok: false, reason };
  }
}

export async function loadOutcomeCounts(sql: SqlTag, memoryIds: readonly string[]): Promise<Map<string, OutcomeCounts>> {
  const ids = [...new Set(memoryIds.filter(id => UUID.test(id)))];
  if (!ids.length) return new Map();
  const rows = await sql<Array<{ id: string; used_count: number; contradicted_count: number }>>`
    SELECT id::text, used_count, contradicted_count FROM harness_shared.memory_canonical
    WHERE id = ANY(${ids}::uuid[])
  `;
  return new Map(rows.map(r => [r.id, { used: Number(r.used_count), contradicted: Number(r.contradicted_count) }]));
}

/** Retain the score scale (cosine/RRF) and use a multiplier, never a floor
 * from a different scale. The stable tie-break also covers a zero score. */
export function applyOutcomeRerank<T extends MemoryEntry>(entries: T[], counts: ReadonlyMap<string, OutcomeCounts>): T[] {
  const contradictions = (e: T) => counts.get(e.id)?.contradicted ?? 0;
  const adjusted = entries.map(e => contradictions(e) >= 2 && typeof e.score === 'number'
    ? { ...e, score: e.score / (1 + contradictions(e)) } : e);
  return adjusted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)
    || Number(contradictions(a) >= 2) - Number(contradictions(b) >= 2));
}

/** Explicit memory:<uuid> citations only; arbitrary UUIDs are not citations. */
export function citedMemoryIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\bmemory:([0-9a-f-]{36})\b/gi)]
    .map(m => m[1]!).filter(id => UUID.test(id)))];
}
