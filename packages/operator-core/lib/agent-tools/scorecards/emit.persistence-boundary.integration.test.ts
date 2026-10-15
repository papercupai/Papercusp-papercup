/** scorecards:emit releases its per-key mutex at the durable persistence boundary. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({
  sql: null as unknown,
  postPersistenceGate: null as null | { reached: () => void; wait: Promise<void> },
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(workspaceId: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      (h.sql as postgres.Sql).begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

vi.mock('../../harness/improvements/capture-core', async (orig) => {
  const actual = await orig<typeof import('../../harness/improvements/capture-core')>();
  return {
    ...actual,
    captureImprovement: (
      input: Parameters<typeof actual.captureImprovement>[0],
      deps?: Parameters<typeof actual.captureImprovement>[1],
    ) => {
      const gate = h.postPersistenceGate;
      if (!gate) return actual.captureImprovement(input, deps);
      h.postPersistenceGate = null;
      return actual.captureImprovement(
        {
          ...input,
          onIssuePersisted: async (issue) => {
            await input.onIssuePersisted?.(issue);
            gate.reached();
            await gate.wait;
          },
        },
        deps,
      );
    },
  };
});

const { emitScorecard, _closeScorecardEmitMutexForTests } = await import('./emit');
const { proposeRubric } = await import('../../rubrics');
const { listScorecards } = await import('../../scorecards');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { _resetHarnessAdminUrlCacheForTests } = await import('../../embedded-pg-discovery');

const RUBRIC = 'scorecard-emit-post-persist-release-regression';
const SOURCE_HIVE = 'papercusp';
const OWNER = 'su-scorecard-persistence-boundary';
const RATINGS = {
  'dedup-safety': {
    rating: 'healthy',
    evidence: 'same-key emits can observe the first card once its issue row is durable',
  },
};

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;
const SAVED_MUTEX_TEST_FLAG = process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 8 });
  h.sql = db.adminSql;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = '1';
  _resetHarnessAdminUrlCacheForTests();

  await proposeRubric({
    rubricId: RUBRIC,
    characteristic: 'scorecard-emission',
    title: 'Scorecard emit persistence-boundary release regression',
    criteria: [
      {
        key: 'dedup-safety',
        title: 'Dedup safety',
        model: 'A persisted scorecard releases its mutex before post-create work settles.',
        method: 'Pause post-create occurrence recording after persistence and start a same-key emit.',
        driftMarkers: 'The second emit waits for post-create work after the row is durable.',
      },
    ],
    status: 'active',
    by: OWNER,
  });
}, 180_000);

afterAll(async () => {
  await _closeScorecardEmitMutexForTests();
  await db?.cleanup();
  _resetHarnessAdminUrlCacheForTests();
  if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
  if (SAVED_MUTEX_TEST_FLAG === undefined) delete process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;
  else process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = SAVED_MUTEX_TEST_FLAG;
});

describe('scorecards:emit persistence-boundary release, real PG', () => {
  it('releases the same-key mutex after persistence while post-create work is pending', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const args = { rubricRef: RUBRIC, ratings: RATINGS };
    let releasePostCreate!: () => void;
    let markPersisted!: () => void;
    const postCreateGate = new Promise<void>((resolve) => {
      releasePostCreate = resolve;
    });
    const persisted = new Promise<void>((resolve) => {
      markPersisted = resolve;
    });
    h.postPersistenceGate = { reached: markPersisted, wait: postCreateGate };

    type Outcome =
      | { state: 'resolved'; result: Awaited<ReturnType<typeof emitScorecard>> }
      | { state: 'rejected'; error: string };
    const asOutcome = (promise: ReturnType<typeof emitScorecard>): Promise<Outcome> =>
      promise.then(
        (result) => ({ state: 'resolved' as const, result }),
        (error) => ({ state: 'rejected' as const, error: String(error) }),
      );
    const first = asOutcome(emitScorecard(args, input));
    let second: Promise<Outcome> | undefined;
    let persistedBeforeTimeout = false;
    let secondBeforeRelease: Outcome | { state: 'timeout' } = { state: 'timeout' };

    try {
      let persistedTimer: ReturnType<typeof setTimeout> | undefined;
      persistedBeforeTimeout = await Promise.race([
        persisted.then(() => true),
        new Promise<boolean>((resolve) => {
          persistedTimer = setTimeout(() => resolve(false), 20_000);
        }),
      ]);
      if (persistedTimer) clearTimeout(persistedTimer);

      if (persistedBeforeTimeout) {
        second = asOutcome(emitScorecard(args, input));
        let secondTimer: ReturnType<typeof setTimeout> | undefined;
        secondBeforeRelease = await Promise.race([
          second,
          new Promise<{ state: 'timeout' }>((resolve) => {
            secondTimer = setTimeout(() => resolve({ state: 'timeout' }), 10_000);
          }),
        ]);
        if (secondTimer) clearTimeout(secondTimer);
      }
    } finally {
      h.postPersistenceGate = null;
      releasePostCreate();
      await Promise.all([first, second].filter((outcome): outcome is Promise<Outcome> => Boolean(outcome)));
    }

    expect(persistedBeforeTimeout).toBe(true);
    expect(secondBeforeRelease.state).toBe('resolved');
    const [firstResult, secondResult] = await Promise.all([first, second!]);
    expect(firstResult).toMatchObject({ state: 'resolved', result: { ok: true, created: true } });
    expect(secondResult).toMatchObject({
      state: 'resolved',
      result: { ok: true, created: false, reason: 'unchanged-evidence' },
    });
    const persistedCards = await listScorecards({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      limit: 10,
    });
    expect(persistedCards).toHaveLength(1);
  }, 120_000);
});
