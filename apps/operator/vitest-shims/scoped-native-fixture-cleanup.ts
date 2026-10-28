import type { OrgTestDb } from '../../../packages/operator-core/test/_org-test-db';
// `/index` is explicit on purpose: `detached-imports` is a DIRECTORY module, and the operator-core
// exports map (`./lib/*` -> `./lib/*.ts`) cannot resolve a bare directory specifier. The operator-core
// typecheck reaches this shim via loop-turn-start-reconcile.integration.test.ts, where that resolution
// fails with TS2307 (frozen candidate 63442ecf); apps/operator's `paths` resolve either spelling.
import { drainDetached } from '@papercusp/operator-core/lib/detached-imports/index';
import { stopInterestWatchSweeper } from '@papercusp/operator-core/lib/events/await/interest-watch';
import { flushFallbackObservations } from '@papercusp/operator-core/lib/degradation/fallback-observations';
import { stopInvalidationListener } from '@papercusp/operator-core/lib/sync-sse';

/** Retire fixture-owned writers before closing the SQL handle they retain. */
export async function cleanupScopedNativeFixtureDatabase(db: Pick<OrgTestDb, 'adminSql' | 'cleanup'> | undefined) {
  if (!db) return;
  try {
    await stopInterestWatchSweeper();
    await drainDetached();
    const flushed = await flushFallbackObservations({ sql: db.adminSql });
    if (flushed.failed > 0) throw new Error(`Scoped native fixture lost ${flushed.failed} fallback observation(s) during teardown`);
    // Coalesced notifications own timers outside drainDetached(). Flush their
    // trailing edge while the fixture's SQL routing is still installed.
    await stopInvalidationListener();
    return flushed;
  } finally {
    await db.cleanup();
  }
}
