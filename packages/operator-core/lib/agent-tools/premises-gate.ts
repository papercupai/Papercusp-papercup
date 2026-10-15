import type { Sql } from 'postgres';
import type { DispatchProjectedDeps, UnifiedToolContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { parseFactRef } from './coordination/premise-resolve';

type Resolution = Awaited<ReturnType<NonNullable<DispatchProjectedDeps['resolvePremises']>>>[number];
export interface PremiseFact {
  id: string | number;
  confidence: string | null;
  retracted_at: string | null;
  superseded_at: string | null;
  expired: boolean;
}

/** Current fact semantics, independent of the read/transport used to obtain it. */
export function premiseFactStatus(fact: PremiseFact): Resolution['status'] {
  if (fact.retracted_at) return 'retracted';
  if (fact.superseded_at) return 'superseded';
  if (fact.expired) return 'expired';
  if (fact.confidence === 'provisional' || fact.confidence === 'suspected') return fact.confidence;
  return 'confirmed';
}

/** Reuses the canonical fact-reference grammar and existing agent_facts store. */
export async function resolveDispatchPremises(
  refs: readonly string[], ctx: UnifiedToolContext, inject?: Sql,
): Promise<Resolution[]> {
  const workspaceId = ctx.workspaceId;
  if (!workspaceId) return refs.map(ref => ({ ref, status: 'unknown', reason: 'workspace unavailable' }));
  const sql: Sql = inject ?? getOrgPg().sql;
  return Promise.all(refs.map(async ref => {
    const parsed = ref.startsWith('fact:') ? parseFactRef(ref) : { key: ref };
    if (!parsed || parsed.version !== undefined) return { ref, status: 'unknown' as const,
      reason: 'expected a fact key or unpinned canonical fact reference' };
    const key = parsed.key;
    const scope = parsed.scope ?? null;
    const scopeRef = parsed.scopeRef ?? null;
    const rows = await Promise.resolve(sql<PremiseFact[]>`
      SELECT id, confidence, retracted_at::text, superseded_at::text, expires_at <= now() AS expired
        FROM (
          SELECT DISTINCT ON (scope, coalesce(scope_ref, '')) *
            FROM harness_shared.agent_facts
           WHERE workspace_id = ${workspaceId} AND key = ${key}
             AND source_hive IS NULL
             AND (${scope}::text IS NULL OR (scope = ${scope} AND coalesce(scope_ref, '') = coalesce(${scopeRef}, '')))
           ORDER BY scope, coalesce(scope_ref, ''), id DESC
        ) current_identities LIMIT 2`);
    if (!rows.length) return { ref, status: 'missing' as const };
    if (rows.length > 1) return { ref, status: 'unknown' as const, reason: 'ambiguous key; cite a scoped fact reference' };
    return { ref, status: premiseFactStatus(rows[0]), factId: rows[0].id };
  }));
}
