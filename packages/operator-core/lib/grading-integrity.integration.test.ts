import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';
import type { ScorecardRow, ScorecardGradingAuditCurrentness } from './scorecards';
import type { Rubric } from './rubrics';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, url: '' }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./embedded-pg-discovery', async (original) => ({
  ...(await original<typeof import('./embedded-pg-discovery')>()),
  getHarnessAdminUrl: () => h.url,
}));

import {
  confirmPendingGradingAuditReservation,
  dispatchPendingGradingAudits,
  GRADING_AUDIT_DISPATCH_ACTOR,
  notifyRetainedGradingAuditor,
  promotePendingGradingAuditClaim,
  reconcilePendingGradingAudits,
  releasePendingGradingAudit,
  reservePendingGradingAudit,
  type DispatchPendingGradingAuditsDeps,
  type DispatchPendingGradingAuditsInput,
} from './grading-integrity';
import { _closeGradingAuditSubjectMutexForTests, isCurrentSourceAuditResponder } from './scorecards';
import { closeTask, getTask, listTasks, markSpawned, registerTask } from './task-manager/store';

const workspaceId = 'default';
const taskLedgerMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/696-task-ledger.sql', import.meta.url));
if (!existsSync(taskLedgerMigration)) throw new Error(`grading audit fixture migration missing: ${taskLedgerMigration}`);
const coordinationSubstrateMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/123-coordination-substrate.sql', import.meta.url));
if (!existsSync(coordinationSubstrateMigration)) throw new Error(`coordination substrate fixture migration missing: ${coordinationSubstrateMigration}`);
const coordinationConversationsMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/132-coordination-conversations.sql', import.meta.url));
if (!existsSync(coordinationConversationsMigration)) throw new Error(`coordination conversations fixture migration missing: ${coordinationConversationsMigration}`);
const consultThreadsMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url));
if (!existsSync(consultThreadsMigration)) throw new Error(`consult threads fixture migration missing: ${consultThreadsMigration}`);
const consultCascadeCursorMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url));
if (!existsSync(consultCascadeCursorMigration)) throw new Error(`consult cascade fixture migration missing: ${consultCascadeCursorMigration}`);
const issueId = 'EI-25100000000000005';
const replacementId = 'EI-25100000000000006';
const now = new Date('2026-10-06T08:00:00.000Z');
const reservation = { key: `grading-audit:${issueId}`, reservedAt: now.toISOString() };
const prior = { key: reservation.key, reservedAt: '2026-10-06T07:00:00.000Z' };
type LaunchHandler = NonNullable<DispatchPendingGradingAuditsDeps['launch']>;
type LaunchResult = Awaited<ReturnType<LaunchHandler>>;
function launchResult(data: unknown): LaunchResult {
  return { data } as LaunchResult;
}

function standardRubric(): Rubric {
  return { kind: 'standard' } as Rubric;
}

const backoff = {
  until: '2026-10-06T09:00:00.000Z', source: 'retry-window' as const,
  code: 'launch_failed', recordedAt: now.toISOString(), reason: 'fixture launch failed',
};
let db: FreshPgDb;
let prepared: postgres.Sql;

async function seed(id = issueId, gradingAudit: Record<string, unknown> = { state: 'pending' }) {
  const payload = JSON.stringify({
    _ei: { created_by: 'fixture-evaluator' },
    observation: {
      rubricRef: 'standard-rubric',
      evidenceFingerprint: 'fixture-evidence',
      gradingAudit,
    },
  });
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, item_kind, payload)
    VALUES (${workspaceId}, 'papercusp', ${id}, 'change', ${payload}::text::jsonb)`;
}

async function readAudit(id = issueId): Promise<Record<string, unknown>> {
  const rows = await db.sql`
    SELECT payload->'observation'->'gradingAudit' AS audit
      FROM harness_shared.work_items WHERE workspace_id = ${workspaceId} AND feature_id = ${id}`;
  return rows[0].audit;
}

beforeAll(async () => {
  db = await createFreshPgDb('grading-audit-writes');
  h.sql = db.sql;
  h.url = db.url;
  prepared = postgres(db.url, { max: 2, onnotice: () => {} });
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await applyMigrationForTest(db.sql, taskLedgerMigration);
  // 834 widens the consult kind on coord_conversations, so replay the production
  // substrate/conversation prerequisites before applying it. createFreshPgDb
  // provisions an empty schema and never replays migrations on its own.
  await applyMigrationForTest(db.sql, coordinationSubstrateMigration);
  await applyMigrationForTest(db.sql, coordinationConversationsMigration);
  await applyMigrationForTest(db.sql, consultThreadsMigration);
  await applyMigrationForTest(db.sql, consultCascadeCursorMigration);
});

beforeEach(async () => {
  h.sql = db.sql;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.task_ledger`;
});

afterAll(async () => {
  await _closeGradingAuditSubjectMutexForTests();
  await prepared?.end({ timeout: 5 });
  await db?.cleanup();
});

describe.each([false, true])('grading audit JSON writes with prepare=%s', (prepare) => {
  beforeEach(() => { h.sql = prepare ? prepared : db.sql; });

  it('retires only a quota backoff after route recovery without bypassing a live lease', async () => {
    const quota = { ...backoff, code: 'model_quota_exhausted' };
    await seed(issueId, { state: 'pending', dispatchBackoff: quota });
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now }))
      .toMatchObject({ status: 'quota-backoff' });
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'claimed' });
    expect(await readAudit()).not.toHaveProperty('dispatchBackoff');
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'already-reserved' });
  });

  it('keeps non-quota backoffs even when the requested route can serve', async () => {
    await seed(issueId, { state: 'pending', dispatchBackoff: backoff });
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now, allowRecoveredQuotaBackoff: true,
    })).toMatchObject({ status: 'dispatch-backoff' });
    expect(await readAudit()).toHaveProperty('dispatchBackoff', backoff);
  });

  it('stores both reservation fields as objects and confirms the exact lease', async () => {
    await seed();
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now }))
      .toEqual({ status: 'claimed', reservation });
    expect(await readAudit()).toMatchObject({ dispatchReservation: reservation, lastDispatchReservation: reservation });
    expect(await confirmPendingGradingAuditReservation(issueId, reservation.key, {
      workspaceId, reservedAt: reservation.reservedAt,
    })).toBe(true);
    expect(await confirmPendingGradingAuditReservation(issueId, reservation.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(false);
  });

  it('keeps the auditor lease visible while one dispatcher checks a retained task', async () => {
    await seed(issueId, { state: 'pending', dispatchReservation: prior, lastDispatchReservation: prior });
    const claim = await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    expect(claim).toMatchObject({ status: 'claimed', reservation: prior, dispatchClaim: reservation });
    // A separate read during slow task/native checks must still authorize the
    // original auditor, before any replacement notice could have been saved.
    expect(await readAudit()).toMatchObject({ dispatchReservation: prior, lastDispatchReservation: prior });
    expect(await confirmPendingGradingAuditReservation(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(true);
    expect(await reservePendingGradingAudit(issueId, reservation.key, {
      workspaceId, now: new Date(now.getTime() + 1_000), preserveAuditorLease: true,
    })).toMatchObject({ status: 'already-reserved' });
    // An unclaimed cleanup path cannot erase this dispatcher's election.
    expect(await releasePendingGradingAudit(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt,
    })).toBe(false);
    expect(await promotePendingGradingAuditClaim(issueId, prior, {
      ...reservation, reservedAt: new Date(now.getTime() + 1_000).toISOString(),
    }, workspaceId)).toBe(false);
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(true);
    expect(await readAudit()).toMatchObject({ dispatchReservation: reservation, lastDispatchReservation: reservation });
    expect((await readAudit()).dispatchClaim).toBeUndefined();
  });

  it('retains the auditor epoch on release and cannot promote after settlement or a competing claim', async () => {
    await seed(issueId, { state: 'pending', dispatchReservation: prior, lastDispatchReservation: prior });
    await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    expect(await releasePendingGradingAudit(issueId, prior.key, {
      workspaceId, reservedAt: prior.reservedAt, dispatchClaimReservedAt: reservation.reservedAt, restore: prior,
    })).toBe(true);
    expect(await readAudit()).toMatchObject({ dispatchReservation: prior, lastDispatchReservation: prior });
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(false);
    await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, preserveAuditorLease: true });
    await db.sql`UPDATE harness_shared.work_items SET payload = jsonb_set(payload, '{observation,gradingAudit,state}', '"passed"'::jsonb)
      WHERE workspace_id = ${workspaceId} AND feature_id = ${issueId}`;
    expect(await promotePendingGradingAuditClaim(issueId, prior, reservation, workspaceId)).toBe(false);
  });

  it.each(['restore-and-backoff', 'restore', 'backoff'] as const)('round-trips the %s release branch', async (branch) => {
    await seed(issueId, { state: 'pending', dispatchReservation: reservation });
    const restore = branch !== 'backoff' ? prior : undefined;
    const suppression = branch !== 'restore' ? backoff : undefined;
    expect(await releasePendingGradingAudit(issueId, reservation.key, {
      workspaceId, reservedAt: reservation.reservedAt, restore, backoff: suppression,
    })).toBe(true);
    const audit = await readAudit();
    expect(audit.dispatchReservation).toEqual(restore);
    expect(audit.lastDispatchReservation).toEqual(restore ?? reservation);
    expect(audit.dispatchBackoff).toEqual(suppression);
  });

  it('reopens an obsolete settled rubric as an object with the new exact identity', async () => {
    await seed(issueId, { state: 'passed', rubricRevision: 5, criteriaHash: 'old-hash' });
    const currentness: ScorecardGradingAuditCurrentness = {
      state: 'stale', reason: 'revision-mismatch', recordedRevision: 5, currentRevision: 6,
      recordedCriteriaHash: 'old-hash', currentCriteriaHash: 'new-hash',
    };
    expect(await reservePendingGradingAudit(issueId, reservation.key, { workspaceId, now, currentness }))
      .toEqual({ status: 'claimed', reservation });
    expect(await readAudit()).toEqual({
      state: 'pending', metaRubricRef: 'grading-integrity', rubricRevision: 6, criteriaHash: 'new-hash',
      stampedAt: now.toISOString(), dispatchReservation: reservation, lastDispatchReservation: reservation,
    });
  });
});

it('atomically rebinds a recovered evaluator and rolls it back when auditor independence changes', async () => {
  await seed(issueId, { state: 'pending', dispatchReservation: reservation });
  const task = await registerTask({
    class: 'agent-session', title: 'retained evaluator renewal', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp', workItemId: issueId,
    detail: { label: reservation.key, coordOwnerId: 'su-retained-auditor', keep: 'unrelated',
      gradingAuditRuntimeBinding: { baseUrl: 'http://127.0.0.1:42457' } },
  }, { workspaceId }, db.sql);
  const target = { issueId, createdBy: 'fixture-evaluator', rubricRef: 'standard-rubric',
    evidenceFingerprint: 'fixture-evidence' } as ScorecardRow;
  const runtime = { taskId: 'runtime-recovered', baseUrl: 'http://127.0.0.1:33015',
    evaluatorBuild: { sha: 'exact-evaluator', version: '1.2.3' }, bundleSha256: 'b'.repeat(64),
    expiresAtSec: Math.floor(Date.now() / 1000) + 3600 };
  type RenewalDeps = NonNullable<Parameters<typeof notifyRetainedGradingAuditor>[1]>;
  const { PgCoordLog, ensureCoordEventLogTable } = await import('@papercusp/coordination/event-log');
  await ensureCoordEventLogTable(h.sql);
  const log = new PgCoordLog({ getSql: () => h.sql, workspaceId, ensureSchema: async () => {} });
  const resolveParties = vi.fn<NonNullable<RenewalDeps['resolveParties']>>(async ids =>
    new Map(ids.filter((id): id is string => typeof id === 'string').map(id => [id, id])));
  const send = vi.fn<NonNullable<RenewalDeps['send']>>(async (identity, options) =>
    options.persistEnvelope!({ msg_id: options.msgId!, from: identity.ownerId, to: options.to,
      kind: 'message', ts: now.toISOString(), summary: options.summary, body: options.body }));
  const wake = vi.fn<NonNullable<RenewalDeps['wake']>>().mockResolvedValue({ targets: ['su-retained-auditor'],
    keys: [], woken: 1, queued: 1, pickupConfirmed: false } as unknown as Awaited<ReturnType<NonNullable<RenewalDeps['wake']>>>);
  const deps = { append: log.appendLineIfAbsent.bind(log), resolveParties, send, wake };
  const input = { card: target, task, reservation, workspaceId, runtime };
  const delivered = await notifyRetainedGradingAuditor(input, deps);
  expect(delivered.reason).toBeUndefined();
  expect(delivered).toMatchObject({ state: 'delivered' });
  expect((await getTask(task.taskId, db.sql))?.detail).toMatchObject({
    keep: 'unrelated', gradingAuditRuntimeBinding: runtime,
    gradingAudit: { issueId, evidenceFingerprint: 'fixture-evidence', reservation },
  });
  expect(send.mock.calls[0]![1].body).toContain(runtime.baseUrl);

  // This fence runs AFTER the task UPDATE; the real replay transaction must
  // roll that update back together with the rejected notification append.
  resolveParties.mockResolvedValue(new Map([
    ['fixture-evaluator', 'same-party'], ['su-retained-auditor', 'same-party'],
  ]));
  const replacement = { ...runtime, taskId: 'runtime-uncommitted', baseUrl: 'http://127.0.0.1:33016' };
  expect(await notifyRetainedGradingAuditor({ ...input, runtime: replacement }, deps))
    .toMatchObject({ state: 'failed', reason: 'retained auditor independence is not proven' });
  expect((await getTask(task.taskId, db.sql))?.detail.gradingAuditRuntimeBinding).toEqual(runtime);
  expect(wake).toHaveBeenCalledTimes(1);
});

it('binds a no-consult direct fallback lease to the live grading task owner', async () => {
  await seed(issueId, { state: 'pending', dispatchReservation: reservation });
  const task = await registerTask({
    class: 'agent-session', title: 'direct fallback grading auditor', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp',
    detail: { label: reservation.key, coordOwnerId: 'su-dispatched-auditor' },
  }, { workspaceId }, db.sql);

  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-dispatched-auditor'))
    .toBe(true);
  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-unrelated-session'))
    .toBe(false);

  await closeTask(task.taskId, { state: 'killed', exitReason: 'fixture complete' }, db.sql, {
    emitTerminal: async () => {},
  });
  expect(await isCurrentSourceAuditResponder(issueId, reservation, 'su-dispatched-auditor'))
    .toBe(false);
});

it('retires cancelled missions from real private ledgers and preserves a pending replacement', async () => {
  await seed(issueId, { state: 'cancelled', stampedAt: prior.reservedAt });
  await seed(replacementId, { state: 'pending', stampedAt: prior.reservedAt });
  const tasks = await Promise.all([issueId, issueId, replacementId].map((target) => registerTask({
    class: 'agent-session', title: 'private cancelled-audit fixture', argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR, harnessSlug: 'papercusp',
    detail: { label: `grading-audit:${target}` },
  }, { workspaceId }, db.sql)));
  // The changed reconciler selects the missions. The unchanged OS termination
  // seam closes disposable task rows; this fixture launches no provider/session.
  const killTask = vi.fn(async (taskId: string) => {
    await closeTask(taskId, { state: 'killed', exitReason: 'cancelled fixture audit' }, db.sql, {
      emitTerminal: async () => {},
    });
    return { ok: true as const, taskId, action: 'kill' as const };
  });
  const launch = vi.fn(async () => { throw new Error('cancelled audit must never launch'); });
  await reconcilePendingGradingAudits({ ctx: { workspaceId } as never, harness: 'papercusp', targetIds: [issueId] }, {
    listTasks: (filter) => listTasks(filter, db.sql),
    listScorecards: async (filter) => {
      const rows = await db.sql`
        SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${filter?.issueIds ?? []}::text[])`;
      return rows.map((row) => ({ issueId: row.feature_id, rubricRef: 'spec-test-adequacy',
        gradingAudit: row.audit })) as ScorecardRow[];
    },
    listWorkspaceWideLoopStanddownOwners: async () => new Set(),
    killTask, launch, now: () => now.getTime(),
  });
  expect(killTask.mock.calls.map(([id]) => id).sort()).toEqual(tasks.slice(0, 2).map((t) => t.taskId).sort());
  expect((await getTask(tasks[0].taskId, db.sql))?.state).toBe('killed');
  expect((await getTask(tasks[1].taskId, db.sql))?.state).toBe('killed');
  expect((await getTask(tasks[2].taskId, db.sql))?.state).toBe('pending');
  expect(launch).not.toHaveBeenCalled();
});

it('persists retained grading-auditor work-item custody and suppresses a duplicate launch', async () => {
  const ownerId = 'su-retained-auditor';
  await seed(issueId, { state: 'pending', stampedAt: prior.reservedAt });
  const liveTask = await registerTask({
    class: 'agent-session',
    title: 'live independent grading auditor',
    argv: [],
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
    harnessSlug: 'papercusp',
    workItemId: issueId,
    detail: { label: reservation.key, coordOwnerId: ownerId },
  }, { workspaceId }, db.sql);
  await markSpawned(liveTask.taskId, {}, db.sql);

  const exactTasks = await listTasks({
    workspaceId,
    workItemId: issueId,
    states: ['pending', 'running'],
    classes: ['agent-session'],
    limit: 10,
  }, db.sql);
  expect(exactTasks.map((task) => task.taskId)).toEqual([liveTask.taskId]);

  const launch: LaunchHandler = vi.fn(async () => { throw new Error('duplicate grading auditor launch'); });
  const result = await dispatchPendingGradingAudits(
    {
      targetIds: [issueId],
      ctx: { workspaceId, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'],
      harness: 'papercusp',
    },
    {
      listScorecards: async (filter) => {
        const rows = await db.sql`
          SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ANY(${filter?.issueIds ?? [issueId]}::text[])`;
        return rows.map((row): ScorecardRow => ({
          issueId: row.feature_id,
          createdAt: now.toISOString(),
          createdBy: 'fixture-evaluator',
          rubricRef: 'standard-rubric',
          ratings: {},
          nKeys: 0,
          missingKeys: [],
          extraKeys: [],
          rubricResolved: true,
          synthesized: false,
          score10: null,
          linkedItems: [],
          evidenceFingerprint: 'fixture-evidence',
          gradingAudit: row.audit,
        }));
      },
      getRubric: async () => standardRubric(),
      listTasks: (filter) => listTasks(filter, db.sql),
      readRetainedTaskKernelVerdicts: async () => new Map(),
      isCurrentSourceAuditResponder: async () => true,
      listWorkspaceWideLoopStanddownOwners: async () => new Set(),
      launch,
    },
  );

  expect(result.receipts[0]).toMatchObject({
    issueId,
    state: 'deduped',
    launch: {
      deduped: true,
      mode: 'live-task-guard',
      tasks: [{ taskId: liveTask.taskId }],
    },
  });
  expect(launch).not.toHaveBeenCalled();
});

it('rebinds a live null-session auditor to its paced 429 transcript before launching an independent replacement', async () => {
  const ownerId = 'su-retained-auditor';
  const sessionId = 'native-retained-session';
  const taskLogPath = '/tmp/grading-retained-native.log';
  const nativeTranscriptPath = '/tmp/grading-retained-native.jsonl';
  const nativeTranscript = JSON.stringify({
    type: 'assistant',
    sessionId,
    isSidechain: false,
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API error' }] },
  });
  const pacedLog =
    "API Error: Request rejected (429) · inference-gateway: account 'aviynw4' paced/paused; retry after 60s";

  await seed(issueId, { state: 'pending', stampedAt: prior.reservedAt });
  const liveTask = await registerTask({
    class: 'agent-session',
    title: 'live independent grading auditor',
    argv: [],
    logPath: taskLogPath,
    launchedBy: GRADING_AUDIT_DISPATCH_ACTOR,
    harnessSlug: 'papercusp',
    detail: { label: reservation.key, coordOwnerId: ownerId },
  }, { workspaceId }, db.sql);
  await markSpawned(liveTask.taskId, {}, db.sql);
  expect((await getTask(liveTask.taskId, db.sql))?.sessionId).toBeNull();

  const bindTaskNativeSession = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['bindTaskNativeSession']>>()
    .mockResolvedValue(sessionId);
  const listNativeSessions = vi.fn<
    NonNullable<DispatchPendingGradingAuditsDeps['listNativeSessionsByTranscriptHandles']>
  >().mockResolvedValue([{ sessionId, coordOwnerId: ownerId, agent: 'claude' }]);
  const resolveTranscript = vi.fn<NonNullable<DispatchPendingGradingAuditsDeps['findSessionTranscript']>>()
    .mockResolvedValue(nativeTranscriptPath);
  const killTask = vi.fn(async (taskId: string) => {
    await closeTask(taskId, { state: 'killed', exitReason: 'paced gateway 429 fixture' }, db.sql, {
      emitTerminal: async () => {},
    });
    return { ok: true as const, taskId, action: 'kill' as const };
  });
  const launchCalls: Array<Parameters<LaunchHandler>> = [];
  const launch: LaunchHandler = async (...args) => {
    launchCalls.push(args);
    return launchResult({
      deduped: false,
      launch: { opened: 1, tasks: [{ taskId: 'task-retained-fallback', logPath: '/tmp/grading-retained-fallback.log' }] },
      agentStarted: true,
    });
  };

  const result = await dispatchPendingGradingAudits(
    {
      targetIds: [issueId],
      ctx: { workspaceId, harnessSlug: 'papercusp' } as DispatchPendingGradingAuditsInput['ctx'],
      harness: 'papercusp',
    },
    {
      listScorecards: async (filter) => {
        const rows = await db.sql`
          SELECT feature_id, payload->'observation'->'gradingAudit' AS audit
            FROM harness_shared.work_items
           WHERE workspace_id = ${workspaceId}
             AND feature_id = ANY(${filter?.issueIds ?? [issueId]}::text[])`;
        return rows.map((row): ScorecardRow => ({
          issueId: row.feature_id,
          createdAt: now.toISOString(),
          createdBy: 'fixture-evaluator',
          rubricRef: 'standard-rubric',
          ratings: {},
          nKeys: 0,
          missingKeys: [],
          extraKeys: [],
          rubricResolved: true,
          synthesized: false,
          score10: null,
          linkedItems: [],
          evidenceFingerprint: 'fixture-evidence',
          gradingAudit: row.audit,
        }));
      },
      getRubric: async () => standardRubric(),
      route: async () => ({ state: 'fallback', reason: 'fixture preserves the independent launch path' }),
      listTasks: (filter) => listTasks(filter, db.sql),
      bindTaskNativeSession,
      listNativeSessionsByTranscriptHandles: listNativeSessions,
      findSessionTranscript: resolveTranscript,
      killTask,
      launch,
      isCurrentSourceAuditResponder: async () => true,
      providerCanServe: async () => true,
      listWorkspaceWideLoopStanddownOwners: async () => new Set(),
      readLogTail: (path) => path === nativeTranscriptPath
        ? nativeTranscript
        : path === taskLogPath ? pacedLog : 'healthy fallback boot',
      readLogMtimeMs: () => Date.now(),
      terminalLogRecheckDelayMs: 0,
      terminalLogMaxRechecks: 0,
      now: () => Date.now(),
    },
  );

  expect(bindTaskNativeSession).toHaveBeenCalledExactlyOnceWith(liveTask.taskId);
  expect(listNativeSessions).toHaveBeenCalledExactlyOnceWith([sessionId]);
  expect(resolveTranscript).toHaveBeenCalledExactlyOnceWith(sessionId, { owner: ownerId });
  expect(killTask).toHaveBeenCalledExactlyOnceWith(liveTask.taskId, {
    includeSubtree: true,
    escalateAfterMs: 5_000,
  });
  expect((await getTask(liveTask.taskId, db.sql))?.state).toBe('killed');
  expect(result.receipts[0]).toMatchObject({
    issueId,
    state: 'launched',
    terminalRecovery: {
      retiredTaskIds: [liveTask.taskId],
      codes: ['inference_gateway_error'],
    },
  });
  expect(launchCalls).toHaveLength(1);
  expect(launchCalls[0]?.[1]).toMatchObject({
    ownerId: GRADING_AUDIT_DISPATCH_ACTOR,
    principal: { kind: 'system', slug: GRADING_AUDIT_DISPATCH_ACTOR, workspaceId },
  });
  expect(await readAudit()).toMatchObject({
    state: 'pending',
    dispatchReservation: { key: reservation.key },
  });
});
