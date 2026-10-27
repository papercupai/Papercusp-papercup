/** Shared read rail. Hydrate examples on each read; never copy them into history/results/cache packets. */
import { createHmac } from 'node:crypto';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import type { SqlDemandObservation } from '../bash-substitution/sql-intent-corpus';
export const EXAMPLE_LIFETIME_MS = 30 * 86400_000;
export const EXAMPLE_PURGE_GRACE_MS = 86400_000;
export const AGGREGATE_LIFETIME_DAYS = 120;

export function miningScopeId(scope: SqlIntentScope, harnessSlug: string): string {
  if (!scope.workspaceId || !scope.sourceBoundary || !scope.epoch || !harnessSlug || scope.key.byteLength < 32)
    throw new Error('invalid_sql_mining_scope');
  return createHmac('sha256', scope.key).update(JSON.stringify([
    'sql-mining-scope-v1', scope.workspaceId, harnessSlug, scope.sourceBoundary, scope.epoch,
  ])).digest('hex');
}

/** Allow-list fields: a new adapter field cannot silently become 120-day private storage. */
export function minimizeSqlObservation(row: SqlDemandObservation): SqlDemandObservation {
  const tokens = [row.workspaceToken, row.harnessToken, row.boundaryToken, row.sourceToken,
    row.operationToken, row.actorToken, row.intent.status === 'supported' ? row.intent.fingerprint : null];
  if (tokens.some(t => t !== null && !/^[a-f0-9]{64}$/.test(t))) throw new Error('invalid_sql_mining_token');
  return {
    workspaceToken: row.workspaceToken, harnessToken: row.harnessToken, boundaryToken: row.boundaryToken,
    sourceToken: row.sourceToken, operationToken: row.operationToken, actorToken: row.actorToken,
    provider: row.provider, day: row.day, origin: row.origin, status: row.status, durationMs: row.durationMs,
    intent: row.intent.status === 'supported' ? {
      status: 'supported', version: row.intent.version, fingerprint: row.intent.fingerprint,
      suggestedFamily: '', canonical: '', secretValuesDropped: row.intent.secretValuesDropped,
      features: { relations: [], projectedFields: [], predicateOperators: [], jsonPaths: [],
        joins: [], grouping: false, ordering: false, limits: [], inputs: [] },
    } : { status: 'unknown', version: row.intent.version, reason: row.intent.reason },
  };
}
export function exampleReadable(expiresAt: string | Date, now: number): boolean {
  return Number.isFinite(now) && new Date(expiresAt).getTime() > now;
}
/** Counts and membership fail closed too, including on lookup error or source deletion. */
export async function sourcesCurrentlyReadable(ids: readonly string[], authorize: (id: string) => Promise<boolean>): Promise<boolean> {
  if (!ids.length) return false;
  for (const id of ids) {
    try { if (!await authorize(id)) return false; } catch { return false; }
  }
  return true;
}
