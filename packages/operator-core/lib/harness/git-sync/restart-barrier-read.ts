import type { Sql } from 'postgres';
import { acquireWithContentionRetry } from '../../agent-tools/locks/contention-retry';
import { readResourceQueue, type ResourceQueueResult } from '../../agent-tools/locks/su-lock-store';

const RESTART_BARRIER_LOCK_TIMEOUT_MS = 250;
const RESTART_BARRIER_STATEMENT_TIMEOUT_MS = 1_500;
const RESTART_BARRIER_READ_BACKOFFS_MS = [50, 150] as const;

function isPostgresLockTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; pgCode?: unknown };
  return value.code === '55P03' || value.pgCode === '55P03';
}

/**
 * Read the restart barrier in a read-only SU transaction. The pool inherits a
 * role-level 15s lock_timeout; override it for this small probe and retry only
 * 55P03. A 57014 statement timeout or a pool error is not retried, so the
 * caller's existing fail-open commit behavior remains bounded and unchanged.
 */
export async function readGitSyncRestartBarrierQueue(
  sql: Sql,
  params: { coordinationDomain: string; resource: string },
): Promise<ResourceQueueResult> {
  return acquireWithContentionRetry(
    () =>
      sql.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`SELECT set_config('lock_timeout', ${`${RESTART_BARRIER_LOCK_TIMEOUT_MS}ms`}, true)`;
        await tx`SELECT set_config('statement_timeout', ${`${RESTART_BARRIER_STATEMENT_TIMEOUT_MS}ms`}, true)`;
        return readResourceQueue(tx as unknown as Sql, params);
      }),
    {
      backoffsMs: RESTART_BARRIER_READ_BACKOFFS_MS,
      isRetryable: isPostgresLockTimeout,
    },
  );
}
