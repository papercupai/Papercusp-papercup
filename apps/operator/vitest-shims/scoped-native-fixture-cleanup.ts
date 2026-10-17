import type { OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
import { drainDetached } from '@papercusp/operator-core/lib/detached-imports';
import { stopInterestWatchSweeper } from '@papercusp/operator-core/lib/events/await/interest-watch';
import { flushFallbackObservations } from '@papercusp/operator-core/lib/degradation/fallback-observations';

/** Retire fixture-owned writers before closing the SQL handle they retain. */
export async function cleanupScopedNativeFixtureDatabase(db: Pick<OrgTestDb, 'adminSql' | 'cleanup'> | undefined) {
  if (!db) return;
  try {
    await stopInterestWatchSweeper();
    await drainDetached();
    const flushed = await flushFallbackObservations({ sql: db.adminSql });
    if (flushed.failed > 0) throw new Error(`Scoped native fixture lost ${flushed.failed} fallback observation(s) during teardown`);
    return flushed;
  } finally {
    await db.cleanup();
  }
}
