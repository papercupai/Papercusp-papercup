/**
 * scorecards:emit concurrency regression (EI-22580603850046617).
 *
 * The unit emit suites mock `listScorecards` and `captureImprovement`, so they
 * cannot observe the check-then-create race across real database sessions. This
 * Docker-gated test runs two identical emits concurrently against a migrated
 * throwaway Postgres database and reads the persisted history back out. Exactly
 * one call may create a card; the other must see the first card after waiting on
 * the direct session advisory lock and return unchanged-evidence.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createPhaseTracker } from '@papercusp/tooldef';

const h = vi.hoisted(() => ({ sql: null as unknown }));

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

const { emitScorecard, scorecardEmitMutexKey, _closeScorecardEmitMutexForTests } = await import('./emit');
const {
  GRADING_AUDIT_RESERVATION_TTL_MS,
  GRADING_AUDIT_DISPATCH_ACTOR,
  reservePendingGradingAudit,
} = await import('../../grading-integrity');
const { proposeRubric, getRubric } = await import('../../rubrics');
const {
  acquireGradingAuditSubjectMutex,
  _closeGradingAuditSubjectMutexForTests,
  ScorecardEmitMutexWaitTimeoutError,
  listScorecards,
  isCurrentSourceAuditResponder,
} = await import('../../scorecards');
const { getLongLivedAdminPool } = await import('../../long-lived-admin-pool');
const { createIssue } = await import('../../issues-engineer');
const { closeTask, registerTask } = await import('../../task-manager/store');
const { OBSERVATION_TOPIC } = await import('../../harness/improvements/read-items');
const { flushFallbackObservations } = await import('../../degradation/fallback-observations');
const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { _resetHarnessAdminUrlCacheForTests } = await import('../../embedded-pg-discovery');

const RUBRIC = 'scorecard-emit-concurrency-regression';
const TIMEOUT_RUBRIC = 'scorecard-emit-lock-timeout-regression';
const SOURCE_HIVE = 'papercusp';
const OWNER = 'su-scorecard-concurrency';
const RATINGS = {
  'dedup-safety': {
    rating: 'healthy',
    evidence: 'two concurrent emitters must retain one immutable scorecard',
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
    title: 'Scorecard emit concurrency regression',
    criteria: [
      {
        key: 'dedup-safety',
        title: 'Dedup safety',
        model: 'Concurrent identical emits retain one scorecard.',
        method: 'Run two scorecards:emit calls at once and read the persisted ledger.',
        driftMarkers: 'Two unsuperseded cards with one evidence fingerprint.',
      },
    ],
    status: 'active',
    by: OWNER,
  });
  await proposeRubric({
    rubricId: TIMEOUT_RUBRIC,
    characteristic: 'scorecard-emission',
    title: 'Scorecard emit lock-timeout regression',
    criteria: [
      {
        key: 'dedup-safety',
        title: 'Dedup safety',
        model: 'A valid emit waits for an in-flight emitter beyond the role lock timeout.',
        method: 'Hold the dedup advisory lock, then release it after the inherited timeout expires.',
        driftMarkers: 'A valid emit returns lock_timeout instead of waiting for the lock holder.',
      },
    ],
    status: 'active',
    by: OWNER,
  });
  await proposeRubric({
    rubricId: 'grading-integrity',
    characteristic: 'grading-integrity',
    title: 'Grading-integrity concurrency fixture',
    criteria: [
      {
        key: 'audit-correctness',
        title: 'Audit correctness',
        model: 'One pending subject reservation produces one grading-audit card.',
        method: 'Run two direct-fallback audit emitters against the same reserved subject.',
        driftMarkers: 'Multiple persisted grading-audit cards cite one subject reservation.',
      },
    ],
    ratingScale: ['pass', 'fail', 'unknown'],
    status: 'active',
    by: OWNER,
  });
}, 180_000);

afterAll(async () => {
  await _closeScorecardEmitMutexForTests();
  await _closeGradingAuditSubjectMutexForTests();
  if (db) {
    const fallbackFlush = await flushFallbackObservations({ sql: db.adminSql });
    expect(fallbackFlush.failed, 'fallback observations must flush before their private PG pool closes').toBe(0);
  }
  await db?.cleanup();
  _resetHarnessAdminUrlCacheForTests();
  if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
  if (SAVED_MUTEX_TEST_FLAG === undefined) delete process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;
  else process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = SAVED_MUTEX_TEST_FLAG;
});

async function waitForScorecardMutexWait(applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await db.adminSql`
      SELECT 1
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND application_name = ${applicationName}
         AND wait_event_type = 'Lock'
         AND wait_event = 'advisory'
         AND query LIKE '%pg_advisory_lock%'
       LIMIT 1`;
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`scorecard mutex session ${applicationName} did not reach its advisory-lock wait`);
}

describe('scorecards:emit final dedup read-to-write mutex, real PG', () => {
  it('uses a finite lock timeout above the inherited role timeout while waiting for an in-flight emitter', async () => {
    // Pass finite timeouts only to the dedicated mutex pool's sessions. ALTER
    // DATABASE would also affect any admin-pool connections opened during this
    // test and leave their inherited settings in place after RESET, making the
    // later concurrency cases order-dependent.
    const previousAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    const mutexUrl = new URL(db.adminDsn);
    mutexUrl.searchParams.set('options', '-c lock_timeout=100ms -c statement_timeout=100ms');
    await _closeScorecardEmitMutexForTests();
    process.env.HARNESS_ADMIN_DATABASE_URL = mutexUrl.toString();
    _resetHarnessAdminUrlCacheForTests();
    const holder = (await import('postgres')).default(db.adminDsn, { max: 1, onnotice: () => {} });
    const key = scorecardEmitMutexKey({
      workspaceId: activeWorkspaceId(),
      rubricRef: TIMEOUT_RUBRIC,
      sourceHive: SOURCE_HIVE,
    });
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      const emit = emitScorecard(
        { rubricRef: TIMEOUT_RUBRIC, ratings: RATINGS },
        {
          createdBy: OWNER,
          ctxHarness: SOURCE_HIVE,
          workspaceId: activeWorkspaceId(),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await holder`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
      await expect(emit).resolves.toMatchObject({ ok: true, created: true });
    } finally {
      await holder.end({ timeout: 5 });
      await _closeScorecardEmitMutexForTests();
      if (previousAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
      else process.env.HARNESS_ADMIN_DATABASE_URL = previousAdminUrl;
      _resetHarnessAdminUrlCacheForTests();
    }
  }, 120_000);

  it('returns a retryable no-write result when the dedup mutex exceeds its deadline', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const key = scorecardEmitMutexKey({
      workspaceId: input.workspaceId,
      rubricRef: TIMEOUT_RUBRIC,
      sourceHive: SOURCE_HIVE,
    });
    const holder = (await import('postgres')).default(db.adminDsn, { max: 1, onnotice: () => {} });
    let held = false;
    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
      held = true;
      const before = await listScorecards({ rubricRef: TIMEOUT_RUBRIC, sourceHive: SOURCE_HIVE, limit: 10 });
      const phases = createPhaseTracker();
      const result = await emitScorecard(
        { rubricRef: TIMEOUT_RUBRIC, ratings: RATINGS },
        { ...input, phases },
        { scorecardMutexWaitTimeoutMs: 150 },
      );
      expect(result).toMatchObject({ ok: false, code: 'scorecard_emit_mutex_timeout', retryable: true });
      expect((result as { error?: string }).error).toContain('No scorecard was persisted by this attempt');
      expect(phases.intervals()).toContainEqual(expect.objectContaining({
        phase: 'scorecards:emit:mutex:dedup:advisory-lock',
        durationMs: expect.any(Number),
      }));
      const after = await listScorecards({ rubricRef: TIMEOUT_RUBRIC, sourceHive: SOURCE_HIVE, limit: 10 });
      expect(after).toHaveLength(before.length);
    } finally {
      if (held) await holder`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`.catch(() => {});
      await holder.end({ timeout: 5 });
    }
  }, 120_000);

  it('bounds grading-audit subject mutex waits and releases the timed-out connection', async () => {
    const subject = { workspaceId: activeWorkspaceId(), subjectIssueId: 'EI-MUTEX-TIMEOUT-SUBJECT' };
    const releaseFirst = await acquireGradingAuditSubjectMutex(subject);
    try {
      await expect(acquireGradingAuditSubjectMutex(subject, undefined, 150)).rejects
        .toBeInstanceOf(ScorecardEmitMutexWaitTimeoutError);
    } finally {
      await releaseFirst();
    }
    const retryRelease = await acquireGradingAuditSubjectMutex(subject, undefined, 150);
    await retryRelease();
  }, 120_000);

  it('bounds grading-audit mutex pool acquisition and releases a late reservation', async () => {
    await _closeGradingAuditSubjectMutexForTests();
    const pool = getLongLivedAdminPool('grading-audit-subject', { max: 8 });
    const holders = await Promise.all(Array.from({ length: 8 }, () => pool.reserve()));
    const phases = createPhaseTracker();
    const subject = { workspaceId: activeWorkspaceId(), subjectIssueId: 'EI-MUTEX-POOL-TIMEOUT-SUBJECT' };
    try {
      const startedAt = Date.now();
      await expect(acquireGradingAuditSubjectMutex(subject, phases, 150)).rejects.toMatchObject({
        name: 'ScorecardEmitMutexWaitTimeoutError',
        code: 'scorecard_emit_mutex_timeout',
        phase: 'pool-reservation',
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(phases.intervals()).toContainEqual(expect.objectContaining({
        phase: 'scorecards:emit:mutex:grading-audit-subject:pool-reservation',
        durationMs: expect.any(Number),
      }));
    } finally {
      holders.forEach((holder) => holder.release());
      // The timed-out reserve may resolve after the holders are released. Give
      // its expired() branch time to release the late connection before the
      // pool is closed and re-used by the next case.
      await new Promise((resolve) => setTimeout(resolve, 100));
      await _closeGradingAuditSubjectMutexForTests();
    }
    const retryRelease = await acquireGradingAuditSubjectMutex(subject, undefined, 150);
    await retryRelease();
  }, 120_000);

  it('serializes concurrent identical emits and persists exactly one scorecard', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const args = { rubricRef: RUBRIC, ratings: RATINGS };

    const results = await Promise.all([
      emitScorecard(args, input),
      emitScorecard(args, input),
    ]);

    expect(results.every((result) => result.ok), JSON.stringify(results, null, 2)).toBe(true);
    expect(results.filter((result) => result.ok && result.created)).toHaveLength(1);
    expect(results.filter((result) => result.ok && !result.created)).toHaveLength(1);
    expect(results.find((result) => result.ok && !result.created)).toMatchObject({
      reason: 'unchanged-evidence',
    });

    const persisted = await listScorecards({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      limit: 10,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      evidenceFingerprint: expect.any(String),
    });
  }, 120_000);

  it('does not block a different dedup key behind an emitter waiting on PostgreSQL', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const blockedKey = scorecardEmitMutexKey({
      workspaceId: input.workspaceId,
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
    });
    const applicationName = `pcusp:scorecard-emit-mutex:p${process.pid}`.slice(0, 63);
    const postgresModule = await import('postgres');
    const holder = postgresModule.default(db.adminDsn, { max: 1, onnotice: () => {} });
    const blockedPhases = createPhaseTracker();
    let held = false;
    let blockedOutcome: Promise<
      | { state: 'resolved'; result: Awaited<ReturnType<typeof emitScorecard>> }
      | { state: 'rejected'; error: string }
    > | undefined;
    let unrelatedOutcome: typeof blockedOutcome;
    let unrelatedBeforeRelease: Awaited<NonNullable<typeof unrelatedOutcome>> | { state: 'timeout' } | undefined;

    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${blockedKey}, 0))`;
      held = true;
      blockedOutcome = emitScorecard(
        { rubricRef: RUBRIC, ratings: RATINGS },
        { ...input, phases: blockedPhases },
      ).then(
        (result) => ({ state: 'resolved' as const, result }),
        (error) => ({ state: 'rejected' as const, error: String(error) }),
      );
      await waitForScorecardMutexWait(applicationName);

      unrelatedOutcome = emitScorecard(
        { rubricRef: TIMEOUT_RUBRIC, ratings: RATINGS },
        input,
      ).then(
        (result) => ({ state: 'resolved' as const, result }),
        (error) => ({ state: 'rejected' as const, error: String(error) }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      unrelatedBeforeRelease = await Promise.race([
        unrelatedOutcome,
        new Promise<{ state: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ state: 'timeout' }), 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } finally {
      if (held) {
        await holder`SELECT pg_advisory_unlock(hashtextextended(${blockedKey}, 0))`.catch(() => {});
      }
      await holder.end({ timeout: 5 });
      await Promise.all([blockedOutcome, unrelatedOutcome].filter(Boolean));
    }

    expect(unrelatedBeforeRelease?.state).toBe('resolved');
    const [blocked, unrelated] = await Promise.all([blockedOutcome, unrelatedOutcome]);
    expect(blocked).toMatchObject({ state: 'resolved', result: { ok: true, reason: 'unchanged-evidence' } });
    expect(unrelated).toMatchObject({ state: 'resolved', result: { ok: true, reason: 'unchanged-evidence' } });
    const blockedIntervals = blockedPhases.intervals();
    expect(blockedIntervals.map(({ phase }) => phase)).toContain('scorecards:emit:mutex:dedup:pool-reservation');
    expect(blockedIntervals).toContainEqual(expect.objectContaining({
      phase: 'scorecards:emit:mutex:dedup:advisory-lock',
      durationMs: expect.any(Number),
    }));
    expect(blockedIntervals.find(({ phase }) => phase === 'scorecards:emit:mutex:dedup:advisory-lock')?.durationMs)
      .toBeGreaterThan(0);
  }, 120_000);

  it('does not block a different typed subject behind an emitter waiting on PostgreSQL', async () => {
    const input = {
      createdBy: OWNER,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
    };
    const subjectA = { kind: 'scorecard' as const, ref: 'scorecard-subject-a' };
    const subjectB = { kind: 'scorecard' as const, ref: 'scorecard-subject-b' };
    const blockedKey = scorecardEmitMutexKey({
      workspaceId: input.workspaceId,
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      subjectKind: subjectA.kind,
      subjectRef: subjectA.ref,
    });
    const applicationName = `pcusp:scorecard-emit-mutex:p${process.pid}`.slice(0, 63);
    const postgresModule = await import('postgres');
    const holder = postgresModule.default(db.adminDsn, { max: 1, onnotice: () => {} });
    const blockedPhases = createPhaseTracker();
    let held = false;
    let blockedOutcome: Promise<
      | { state: 'resolved'; result: Awaited<ReturnType<typeof emitScorecard>> }
      | { state: 'rejected'; error: string }
    > | undefined;
    let unrelatedOutcome: typeof blockedOutcome;
    let unrelatedBeforeRelease: Awaited<NonNullable<typeof unrelatedOutcome>> | { state: 'timeout' } | undefined;

    try {
      await holder`SELECT pg_advisory_lock(hashtextextended(${blockedKey}, 0))`;
      held = true;
      blockedOutcome = emitScorecard(
        { rubricRef: RUBRIC, ratings: RATINGS, subject: subjectA },
        { ...input, phases: blockedPhases },
      ).then(
        (result) => ({ state: 'resolved' as const, result }),
        (error) => ({ state: 'rejected' as const, error: String(error) }),
      );
      await waitForScorecardMutexWait(applicationName);

      unrelatedOutcome = emitScorecard(
        { rubricRef: RUBRIC, ratings: RATINGS, subject: subjectB },
        input,
      ).then(
        (result) => ({ state: 'resolved' as const, result }),
        (error) => ({ state: 'rejected' as const, error: String(error) }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      unrelatedBeforeRelease = await Promise.race([
        unrelatedOutcome,
        new Promise<{ state: 'timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ state: 'timeout' }), 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    } finally {
      if (held) {
        await holder`SELECT pg_advisory_unlock(hashtextextended(${blockedKey}, 0))`.catch(() => {});
      }
      await holder.end({ timeout: 5 });
      await Promise.all([blockedOutcome, unrelatedOutcome].filter(Boolean));
    }

    expect(unrelatedBeforeRelease?.state).toBe('resolved');
    const [blocked, unrelated] = await Promise.all([blockedOutcome, unrelatedOutcome]);
    expect(blocked).toMatchObject({ state: 'resolved', result: { ok: true, created: true } });
    expect(unrelated).toMatchObject({ state: 'resolved', result: { ok: true, created: true } });
    const persistedA = await listScorecards({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      subjectRef: subjectA.ref,
      limit: 10,
    });
    const persistedB = await listScorecards({
      rubricRef: RUBRIC,
      sourceHive: SOURCE_HIVE,
      subjectRef: subjectB.ref,
      limit: 10,
    });
    expect(persistedA).toHaveLength(1);
    expect(persistedB).toHaveLength(1);
  }, 120_000);

  it('does not file a second audit when two direct-fallback emitters share one pending lease', async () => {
    console.info('[grading-audit concurrency fixture] starting grading-integrity rubric lookup');
    const auditRubricRead = getRubric('grading-integrity').then(
      (rubric) => ({ status: 'resolved' as const, rubric }),
      (error) => ({ status: 'rejected' as const, error }),
    );
    let rubricReadTimer: ReturnType<typeof setTimeout> | undefined;
    const auditRubricResult = await Promise.race([
      auditRubricRead,
      new Promise<{ status: 'timeout' }>((resolve) => {
        rubricReadTimer = setTimeout(() => resolve({ status: 'timeout' }), 5_000);
      }),
    ]);
    if (rubricReadTimer) clearTimeout(rubricReadTimer);
    console.info(`[grading-audit concurrency fixture] rubric lookup result=${auditRubricResult.status}`);
    if (auditRubricResult.status !== 'resolved') {
      console.info('[grading-audit concurrency fixture] rubric lookup timed out; importing postgres');
      const postgresModule = await import('postgres');
      console.info('[grading-audit concurrency fixture] postgres import resolved');
      const observer = postgresModule.default(db.adminDsn, {
        max: 1,
        connect_timeout: 3,
        onnotice: () => {},
        prepare: false,
        connection: { search_path: 'harness_shared, public' },
      });
      console.info('[grading-audit concurrency fixture] observer client created');
      let activity: readonly unknown[] = [];
      let diagnosticError: string | undefined;
      try {
        activity = await observer`
          SELECT pid, application_name, state, wait_event_type, wait_event,
                 ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)::integer AS query_age_ms,
                 LEFT(query, 180) AS query_prefix, pg_blocking_pids(pid) AS blocking_pids
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
           ORDER BY query_start NULLS LAST
           LIMIT 12
        `;
        console.info(`[grading-audit concurrency fixture] observer query resolved with ${activity.length} rows`);
      } catch (error) {
        diagnosticError = String(error);
        console.info(`[grading-audit concurrency fixture] observer query failed: ${diagnosticError}`);
      } finally {
        console.info('[grading-audit concurrency fixture] closing observer client');
        await observer.end({ timeout: 5 });
        console.info('[grading-audit concurrency fixture] observer client closed');
      }
      const readError = auditRubricResult.status === 'rejected'
        ? `; read error=${String(auditRubricResult.error)}`
        : '';
      throw new Error(`grading-integrity rubric lookup did not resolve in 5s${readError}; pg_stat_activity=${JSON.stringify(activity)}; diagnosticError=${diagnosticError ?? 'none'}`);
    }
    const auditRubric = auditRubricResult.rubric;
    expect(auditRubric?.kind).toBe('standard');
    expect(auditRubric?.criteria.length).toBeGreaterThan(0);
    if (!auditRubric) throw new Error('grading-integrity rubric was not available in the test database');
    expect(auditRubric.ratingScale).toEqual(['pass', 'fail', 'unknown']);

    const reservedAt = new Date().toISOString();
    console.info('[grading-audit concurrency fixture] creating pending source subject');
    const subject = await createIssue({
      title: 'pending grading-audit concurrency subject',
      kind: 'change',
      topics: [OBSERVATION_TOPIC],
      createdBy: 'su-scorecard-concurrency-source',
      payload: {
        observation: {
          rubricRef: RUBRIC,
          rubricRevision: 1,
          criteriaHash: 'source-rubric-hash-v1',
          sourceHive: SOURCE_HIVE,
          ratings: RATINGS,
          gradingAudit: {
            state: 'pending',
            metaRubricRef: 'grading-integrity',
            stampedAt: new Date(Date.now() - 1_000).toISOString(),
            rubricRevision: auditRubric.revision,
            criteriaHash: auditRubric.criteriaHash,
            dispatchReservation: {
              key: 'grading-audit:pending-grading-audit-concurrency-subject',
              reservedAt,
            },
          },
        },
      },
    });
    console.info(`[grading-audit concurrency fixture] source subject created id=${subject.id}`);
    const reservation = {
      key: `grading-audit:${subject.id}`,
      reservedAt,
    };
    console.info('[grading-audit concurrency fixture] persisting dispatch reservation');
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
           payload,
           '{observation,gradingAudit,dispatchReservation}',
           ${db.adminSql.json(reservation as never)}::jsonb,
           true
         )
       WHERE feature_id = ${subject.id}
    `;
    console.info('[grading-audit concurrency fixture] verifying persisted dispatch reservation');
    const persistedReservations = await db.adminSql`
      SELECT payload->'observation'->'gradingAudit'->'dispatchReservation' AS reservation
        FROM harness_shared.work_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND feature_id = ${subject.id}
    `;
    expect(persistedReservations[0]?.reservation).toEqual(reservation);
    console.info('[grading-audit concurrency fixture] dispatch reservation verified');

    const directFallbackTask = await registerTask({
      class: 'agent-session',
      title: 'direct fallback grading auditor',
      argv: [],
      launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
      harnessSlug: SOURCE_HIVE,
      detail: { label: reservation.key, coordOwnerId: 'su-audit-concurrency-a' },
    }, { workspaceId: activeWorkspaceId() }, db.adminSql);

    const passRatings = Object.fromEntries(
      auditRubric.criteria.map((criterion) => [criterion.key, {
        rating: 'pass',
        evidence: 'replayed the same pending subject before the competing emitter settled',
      }]),
    );
    const failRatings = {
      ...passRatings,
      [auditRubric.criteria[0]!.key]: {
        rating: 'fail',
        evidence: 'the competing verdict intentionally disagrees for the race reproduction',
      },
    };
    let releaseFirstPreflight!: () => void;
    const firstPreflightRelease = new Promise<void>((resolve) => {
      releaseFirstPreflight = resolve;
    });
    let signalFirstPreflight!: () => void;
    const firstPreflightReached = new Promise<void>((resolve) => {
      signalFirstPreflight = resolve;
    });
    let signalSecondPreflight!: () => void;
    const secondPreflightReached = new Promise<void>((resolve) => {
      signalSecondPreflight = resolve;
    });
    let responderCalls = 0;
    const responderBarrier: typeof isCurrentSourceAuditResponder = async (...args) => {
      const eligible = await isCurrentSourceAuditResponder(...args);
      if (!eligible) return false;
      responderCalls += 1;
      if (responderCalls === 1) {
        signalFirstPreflight();
        await firstPreflightRelease;
      } else if (responderCalls === 2) {
        signalSecondPreflight();
      }
      return true;
    };
    const inputFor = (createdBy: string, phases?: ReturnType<typeof createPhaseTracker>) => ({
      createdBy,
      ctxHarness: SOURCE_HIVE,
      workspaceId: activeWorkspaceId(),
      ...(phases ? { phases } : {}),
    });
    const argsFor = (ratings: typeof passRatings) => ({
      rubricRef: 'grading-integrity',
      ratings,
      terminal: true,
      subject: { kind: 'scorecard' as const, ref: subject.id },
      gradingAuditReservation: reservation,
    });
    const deps = {
      isCurrentSourceAuditResponder: responderBarrier,
      lineageRelated: async () => false,
    };

    console.info('[grading-audit concurrency fixture] starting first audit emitter');
    const first = emitScorecard(argsFor(passRatings) as never, inputFor('su-audit-concurrency-a'), deps);
    const firstOutcome = first.then(
      (result) => ({ state: 'settled' as const, result }),
      (error) => ({ state: 'rejected' as const, error: String(error) }),
    );
    let firstBarrierTimer: ReturnType<typeof setTimeout> | undefined;
    const firstBarrierState = await Promise.race([
      firstPreflightReached.then(() => ({ state: 'preflight' as const })),
      firstOutcome,
      new Promise<{ state: 'timeout' }>((resolve) => {
        firstBarrierTimer = setTimeout(() => resolve({ state: 'timeout' }), 5_000);
      }),
    ]);
    if (firstBarrierTimer) clearTimeout(firstBarrierTimer);
    console.info(`[grading-audit concurrency fixture] first emitter phase=${firstBarrierState.state}`);
    if (firstBarrierState.state !== 'preflight') {
      releaseFirstPreflight();
      throw new Error(
        `first audit emitter did not reach responder preflight: ${JSON.stringify(firstBarrierState)}`,
      );
    }
    console.info('[grading-audit concurrency fixture] starting second audit emitter');
    const secondPhases = createPhaseTracker();
    const second = emitScorecard(argsFor(failRatings) as never, inputFor('su-audit-concurrency-b', secondPhases), deps);
    const competingReservation = reservePendingGradingAudit(
      subject.id,
      'grading-audit:competing-reclaim',
      {
        workspaceId: activeWorkspaceId(),
        now: new Date(Date.now() + GRADING_AUDIT_RESERVATION_TTL_MS + 1_000),
      },
    );
    let reservationTimer: ReturnType<typeof setTimeout> | undefined;
    const competingReservationCompletedBeforeFirstSettled = await Promise.race([
      competingReservation.then(() => true),
      new Promise<boolean>((resolve) => {
        reservationTimer = setTimeout(() => resolve(false), 250);
      }),
    ]);
    if (reservationTimer) clearTimeout(reservationTimer);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const secondPassedBeforeFirstSettled = await Promise.race([
      secondPreflightReached.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    console.info(
      `[grading-audit concurrency fixture] second preflight before first settled=${secondPassedBeforeFirstSettled}`,
    );
    releaseFirstPreflight();
    const [results, competingReservationResult] = await Promise.all([
      Promise.all([first, second]),
      competingReservation,
    ]);
    const persistedAudits = await listScorecards({
      rubricRef: 'grading-integrity',
      subjectRef: subject.id,
      limit: 10,
    });
    console.info(`[grading-audit concurrency fixture] persisted audit count=${persistedAudits.length}`);
    await closeTask(directFallbackTask.taskId, {
      state: 'killed',
      exitReason: 'concurrency fixture complete',
    }, db.adminSql);
    expect({
      secondPassedBeforeFirstSettled,
      competingReservationCompletedBeforeFirstSettled,
      competingReservationStatus: competingReservationResult.status,
      createdAuditCount: results.filter((result) => result.ok && result.created).length,
      persistedAuditCount: persistedAudits.length,
    }).toEqual({
      secondPassedBeforeFirstSettled: false,
      competingReservationCompletedBeforeFirstSettled: false,
      competingReservationStatus: 'not-pending',
      createdAuditCount: 1,
      persistedAuditCount: 1,
    });
    const secondIntervals = secondPhases.intervals();
    expect(secondIntervals.map(({ phase }) => phase)).toContain('scorecards:emit:mutex:grading-audit-subject:pool-reservation');
    expect(secondIntervals.find(({ phase }) => phase === 'scorecards:emit:mutex:grading-audit-subject:advisory-lock')?.durationMs)
      .toBeGreaterThan(0);
  }, 30_000);
});
