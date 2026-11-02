/**
 * store.integration.test.ts — task-manager/store.ts against REAL Postgres
 * (task-manager-no-escape-2026-07-27, P-003).
 *
 * EI-18824358724907941: `clearVanishedUnaccounted([])` used to plug a literal NUL
 * byte ('\x00none') into a query parameter as a sentinel to avoid an empty
 * `<> ALL(...)` array — Postgres rejects ANY string containing 0x00 outright
 * ("invalid byte sequence for encoding \"UTF8\": 0x00"), so it failed on EVERY
 * tick with zero currently-unaccounted residue (the common, healthy case), which
 * is what the `task-reconcile` background routine's watchdog failure
 * (EI-18824358724907941) reported. This never showed up in the stubbed unit
 * tests (reconcile-tick.test.ts fakes `clearVanishedUnaccounted` entirely) — it
 * needs a REAL Postgres round-trip to reproduce, hence this integration test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
  createFreshPgDb,
  applyEventSubstrateMigrationsForTest,
  type FreshPgDb,
  COORD_SUBSCRIPTION_SUBSTRATE,
} from '../../test/_pg-helpers';
import type { CloseTaskEffects, TaskReleaseReceiptInput, TaskReleaseReceiptState } from './store';
import type { TaskTerminalProvenance } from './types';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const store = await import('./store');

const WS = 'default';
let db: FreshPgDb;

async function insertUnaccounted(taskId: string, cgroupPath = '/sys/fs/cgroup/foo') {
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv,
      launched_by, cgroup_path, pid, confined, state, detail
    ) VALUES (
      ${taskId}, ${WS}, ${taskId}, 'other', 'sample cmdline',
      '[]'::jsonb, 'unknown', ${cgroupPath}, 1, false, 'unaccounted', '{}'::jsonb
    )
  `;
}

async function insertAgentSessionTask(input: {
  taskId: string;
  coordOwnerId: string;
  state?: 'pending' | 'running' | 'exited';
  taskClass?: string;
  sessionId?: string | null;
}) {
  const state = input.state ?? 'running';
  await db.sql`
    INSERT INTO harness_shared.task_ledger (
      task_id, workspace_id, root_task_id, class, title, argv,
      launched_by, confined, state, session_id, ended_at, detail
    ) VALUES (
      ${input.taskId}, ${WS}, ${input.taskId}, ${input.taskClass ?? 'agent-session'},
      ${input.taskId}, '[]'::jsonb, 'test', true, ${state}, ${input.sessionId ?? null},
      CASE WHEN ${state === 'exited'} THEN now() ELSE NULL END,
      jsonb_build_object('coordOwnerId', ${input.coordOwnerId}::text)
    )
  `;
}

beforeAll(async () => {
  db = await createFreshPgDb('task-ledger-store');
  h.sql = db.sql;
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'task-manager/store.integration.test.ts',
    ...COORD_SUBSCRIPTION_SUBSTRATE,
    extra: [
      ...COORD_SUBSCRIPTION_SUBSTRATE.extra,
      '696-task-ledger.sql',
      '700-task-ledger-bash-job-id-idx.sql',
      '774-task-ledger-ended-unobserved-state.sql',
    ],
  });
  await db.sql`
    CREATE TABLE harness_shared.adv_sessions (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      coord_owner_id text,
      session_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    )
  `;
});

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.task_ledger`;
  await db.sql`DELETE FROM harness_shared.adv_sessions`;
});

describe('host-wide task reconciliation across workspace partitions', () => {
  async function insertTask(taskId: string, workspaceId: string, state: 'running' | 'exited', pendingEvent = false) {
    const endedAt = state === 'running' ? null : new Date();
    const detail = pendingEvent ? { terminalEventPending: true, terminalEventRevision: 1 } : {};
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, ended_at, detail
      ) VALUES (
        ${taskId}, ${workspaceId}, ${taskId}, 'agent-session', ${taskId}, '[]'::jsonb,
        'test', true, ${state}, ${endedAt}, ${JSON.stringify(detail)}::jsonb
      )
    `;
  }

  it('lists all workspace rows only when the explicit null host scope is used', async () => {
    await insertTask('host-recon-default', 'default', 'running');
    await insertTask('host-recon-handler', 'handler-workspace', 'running');

    const hostRows = await store.listReconcileTasks(null);
    const scopedRows = await store.listReconcileTasks('default');

    expect(hostRows.map(({ workspaceId, taskId }) => [workspaceId, taskId]).sort()).toEqual([
      ['default', 'host-recon-default'],
      ['handler-workspace', 'host-recon-handler'],
    ]);
    expect(scopedRows.map(({ taskId }) => taskId)).toEqual(['host-recon-default']);
  });

  it('recovers pending terminal events across workspace partitions in host scope', async () => {
    await insertTask('terminal-recon-default', 'default', 'exited', true);
    await insertTask('terminal-recon-handler', 'handler-workspace', 'exited', true);
    const emittedWorkspaces: string[] = [];

    const delivered = await store.recoverPendingTaskTerminalEvents(null, db.sql, async (event) => {
      emittedWorkspaces.push(event.workspaceId);
      return true;
    });

    expect(delivered).toBe(2);
    expect(emittedWorkspaces.sort()).toEqual(['default', 'handler-workspace']);
  });
});

describe('dispatch correlation real SQL recovery', () => {
  async function insertDispatchTask(taskId: string, workspaceId: string, dispatchCallId: string | null, ageMinutes: number) {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, started_at, ended_at, detail
      ) VALUES (
        ${taskId}, ${workspaceId}, ${taskId}, 'bash-job', 'same shell command',
        '[]'::jsonb, 'test', true, 'exited',
        now() - ${ageMinutes} * interval '1 minute', now(),
        jsonb_build_object('dispatchCallId', ${dispatchCallId}::text)
      )
    `;
  }

  it('dispatch correlation recovers an older exact task before a small LIMIT without another enrollment', async () => {
    const dispatchCallId = "dispatch_%' OR true --";
    await insertDispatchTask('original-dispatch', WS, dispatchCallId, 10);
    await insertDispatchTask('foreign-same-dispatch', 'foreign-workspace', dispatchCallId, 0);
    await insertDispatchTask('same-command-other-dispatch', WS, 'other-dispatch', 1);
    await insertDispatchTask('literal-near-match', WS, "dispatch_X' OR true --", 2);
    await insertDispatchTask('legacy-no-dispatch', WS, null, 3);

    const countBefore = await db.sql`SELECT count(*)::int AS count FROM harness_shared.task_ledger`;
    const filter = { workspaceId: WS, dispatchCallId, includeEnded: true, limit: 1 };
    expect((await store.listTasks(filter)).map((task) => task.taskId)).toEqual(['original-dispatch']);
    expect((await store.listTasks(filter)).map((task) => task.taskId)).toEqual(['original-dispatch']);
    expect(await db.sql`SELECT count(*)::int AS count FROM harness_shared.task_ledger`).toEqual(countBefore);

    // The legacy top row is a decoy: filtering an already-limited result cannot recover the original.
    expect((await store.listTasks({ workspaceId: WS, includeEnded: true, limit: 1 })).map((task) => task.taskId))
      .toEqual(['same-command-other-dispatch']);
  });

  it('dispatch correlation never returns a foreign-workspace match and retains missing-identity rows in legacy reads', async () => {
    await insertDispatchTask('foreign-only-match', 'foreign-workspace', 'foreign-only-dispatch', 0);
    await insertDispatchTask('legacy-own-task', WS, null, 1);

    expect(await store.listTasks({ workspaceId: WS, dispatchCallId: 'foreign-only-dispatch', includeEnded: true, limit: 1 }))
      .toEqual([]);
    expect((await store.listTasks({ workspaceId: 'foreign-workspace', dispatchCallId: 'foreign-only-dispatch', includeEnded: true, limit: 1 }))
      .map((task) => task.taskId)).toEqual(['foreign-only-match']);
    expect((await store.listTasks({ workspaceId: WS, includeEnded: true, limit: 1 })).map((task) => task.taskId))
      .toEqual(['legacy-own-task']);
  });
});

describe('agent-session native-id binding (EI-21268871278252116)', () => {
  it('links the exact initial native session after a real short child has exited (EI-25609725859690051)', async () => {
    const { managedSpawn } = await import('./managed-spawn');
    const spawned = await managedSpawn(process.execPath, ['-e', 'process.exit(0)'], {
      class: 'agent-session', title: 'short stock child', argv: [], launchedBy: 'test',
      detail: { coordOwnerId: 'stock-fast-owner' },
    }, { workspaceId: WS, confine: false, requireRegistration: true });
    if (spawned.child.exitCode === null) await new Promise<void>((resolve, reject) => {
      spawned.child.once('exit', () => resolve()); spawned.child.once('error', reject);
    });
    await expect.poll(async () => (await store.getTask(spawned.taskId))?.state).toBe('exited');
    const binding = { workspaceId: WS, coordOwnerId: 'stock-fast-owner', sessionId: 'native-fast-child',
      initialTaskId: spawned.taskId };

    // The old live-only path cannot account for this already-terminal child.
    expect(await store.bindLiveAgentSessionTasksToNativeSession({ ...binding, initialTaskId: undefined })).toEqual([]);
    await insertAgentSessionTask({ taskId: 'same-owner-sibling', coordOwnerId: 'stock-fast-owner' });
    expect(await store.bindLiveAgentSessionTasksToNativeSession(binding)).toEqual([spawned.taskId]);
    // A retried observation returns the same receipt, without reopening the task.
    expect(await store.bindLiveAgentSessionTasksToNativeSession(binding)).toEqual([spawned.taskId]);
    expect(await store.getTask(spawned.taskId)).toMatchObject({ state: 'exited', sessionId: 'native-fast-child', exitCode: 0 });
    expect((await store.getTask('same-owner-sibling'))?.sessionId).toBeNull();
  });

  it('initial binding never retargets a conflicting session or crosses task, owner, workspace or class', async () => {
    await insertAgentSessionTask({ taskId: 'conflict', coordOwnerId: 'stock-owner', state: 'exited', sessionId: 'other-native' });
    await insertAgentSessionTask({ taskId: 'wrong-owner', coordOwnerId: 'other-owner', state: 'exited' });
    await insertAgentSessionTask({ taskId: 'wrong-class', coordOwnerId: 'stock-owner', taskClass: 'bash-job' });
    await insertAgentSessionTask({ taskId: 'exact', coordOwnerId: 'stock-owner', state: 'exited' });
    await insertAgentSessionTask({ taskId: 'sibling', coordOwnerId: 'stock-owner' });
    const binding = { workspaceId: WS, coordOwnerId: 'stock-owner', sessionId: 'new-native' };
    for (const initialTaskId of ['conflict', 'wrong-owner', 'wrong-class', 'missing']) {
      expect(await store.bindLiveAgentSessionTasksToNativeSession({ ...binding, initialTaskId })).toEqual([]);
    }
    expect(await store.bindLiveAgentSessionTasksToNativeSession({ ...binding, workspaceId: 'other-workspace', initialTaskId: 'exact' })).toEqual([]);
    expect(await store.bindLiveAgentSessionTasksToNativeSession({ ...binding, initialTaskId: '' })).toEqual([]);
    expect(await store.bindLiveAgentSessionTasksToNativeSession({ ...binding, initialTaskId: 'exact' })).toEqual(['exact']);
    expect((await store.getTask('conflict'))?.sessionId).toBe('other-native');
    for (const id of ['wrong-owner', 'wrong-class', 'sibling']) expect((await store.getTask(id))?.sessionId).toBeNull();
  });

  it('binds every matching live task when enrolment lands before bootstrap, without crossing owner/class/state', async () => {
    await insertAgentSessionTask({ taskId: 'match-pending', coordOwnerId: 'su-owner', state: 'pending' });
    await insertAgentSessionTask({ taskId: 'match-running', coordOwnerId: 'su-owner' });
    await insertAgentSessionTask({
      taskId: 'match-rebind',
      coordOwnerId: 'su-owner',
      sessionId: 'native-predecessor',
    });
    await insertAgentSessionTask({ taskId: 'wrong-owner', coordOwnerId: 'su-other' });
    await insertAgentSessionTask({ taskId: 'wrong-class', coordOwnerId: 'su-owner', taskClass: 'bash-job' });
    await insertAgentSessionTask({ taskId: 'ended-owner', coordOwnerId: 'su-owner', state: 'exited' });

    const bound = await store.bindLiveAgentSessionTasksToNativeSession({
      workspaceId: WS,
      coordOwnerId: 'su-owner',
      sessionId: 'native-current',
    });

    expect(bound.sort()).toEqual(['match-pending', 'match-rebind', 'match-running']);
    const rows = await db.sql`
      SELECT task_id, session_id FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row.session_id]))).toEqual({
      'ended-owner': null,
      'match-pending': 'native-current',
      'match-rebind': 'native-current',
      'match-running': 'native-current',
      'wrong-class': null,
      'wrong-owner': null,
    });
  });

  it('binds one newly enrolled task to the newest open owner session when bootstrap lands first', async () => {
    await db.sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, coord_owner_id, session_id, started_at, ended_at)
      VALUES
        (${WS}, 'su-owner', 'native-closed', now() - interval '3 minutes', now()),
        (${WS}, 'su-owner', 'native-older-open', now() - interval '2 minutes', null),
        (${WS}, 'su-owner', 'native-newest-open', now() - interval '1 minute', null),
        (${WS}, 'su-other', 'native-other', now(), null)
    `;
    await insertAgentSessionTask({ taskId: 'late-enrolment', coordOwnerId: 'su-owner' });
    await insertAgentSessionTask({ taskId: 'other-owner-task', coordOwnerId: 'su-other' });
    await insertAgentSessionTask({ taskId: 'ended-late', coordOwnerId: 'su-owner', state: 'exited' });

    await expect(store.bindAgentSessionTaskToLatestNativeSession('late-enrolment')).resolves.toBe('native-newest-open');
    await expect(store.bindAgentSessionTaskToLatestNativeSession('ended-late')).resolves.toBeNull();

    const rows = await db.sql`
      SELECT task_id, session_id FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row.session_id]))).toEqual({
      'ended-late': null,
      'late-enrolment': 'native-newest-open',
      'other-owner-task': null,
    });
  });
});

describe('restart-safe release receipt journal (BYOC P-005)', () => {
  const operationId = 'release-op-20260908';
  const inputHash = 'a'.repeat(64);

  async function releaseTask(taskId = 'releasetask01') {
    return store.registerTask(
      {
        class: 'deploy',
        title: 'workspace-host release',
        argv: ['release'],
        launchedBy: 'test',
        detail: {
          release: {
            schemaVersion: 1,
            operationId,
            source: { sha: 'b'.repeat(40), gitlinks: { desktop: 'c'.repeat(40) } },
            artifactIdentity: { sha256: inputHash },
            credential: { generation: 'generation-7', expiresAt: '2026-09-08T06:00:00.000Z' },
            cursor: 0,
            currentStage: null,
            currentState: null,
            spentOperationIds: [],
            receipts: [],
          },
        },
      },
      { taskId, workspaceId: WS },
    );
  }

  function receipt(
    state: TaskReleaseReceiptState,
    over: Partial<TaskReleaseReceiptInput> = {},
  ): TaskReleaseReceiptInput {
    return {
      operationId,
      requestIdentity: 'multipart-init-01',
      stage: 'publish.multipart.initiate',
      state,
      inputHash,
      evidenceRefs: ['manifest:sha256:' + inputHash],
      credentialGeneration: 'generation-7',
      credentialExpiresAt: '2026-09-08T06:00:00.000Z',
      recordedAt: '2026-09-08T04:00:00.000Z',
      ...over,
    };
  }

  it('persists intent -> unknown -> reconciled commit without losing immutable release identity', async () => {
    await releaseTask();
    await expect(store.appendTaskReleaseReceipt('releasetask01', 0, receipt('intent'))).resolves.toMatchObject({ ok: true });
    await expect(store.appendTaskReleaseReceipt('releasetask01', 1, receipt('unknown'))).resolves.toMatchObject({ ok: true });
    await expect(
      store.appendTaskReleaseReceipt('releasetask01', 2, receipt('committed', {
        evidenceRefs: ['provider-ledger:multipart-init-01'],
      })),
    ).resolves.toMatchObject({ ok: true });

    const task = await store.getTask('releasetask01');
    const journal = store.taskReleaseJournalFromDetail(task?.detail);
    expect(journal).toMatchObject({
      operationId,
      cursor: 3,
      source: { sha: 'b'.repeat(40), gitlinks: { desktop: 'c'.repeat(40) } },
      artifactIdentity: { sha256: inputHash },
      credential: { generation: 'generation-7' },
      currentStage: 'publish.multipart.initiate',
      currentState: 'committed',
      spentOperationIds: ['multipart-init-01'],
    });
    expect(journal?.receipts.map(({ sequence, state }) => ({ sequence, state }))).toEqual([
      { sequence: 0, state: 'intent' },
      { sequence: 1, state: 'unknown' },
      { sequence: 2, state: 'committed' },
    ]);
  });

  it('persists interruption and verified resume receipts across every desktop release phase', async () => {
    const taskId = 'releasetask-phase-boundaries';
    await releaseTask(taskId);
    const phases = [
      'release.build.linux',
      'release.build.windows',
      'release.build.mac',
      'release.manifest',
    ] as const;

    for (const [index, stage] of phases.entries()) {
      const requestIdentity = `phase-request-${index}`;
      const cursor = index * 3;
      await expect(store.appendTaskReleaseReceipt(taskId, cursor, receipt('intent', {
        requestIdentity,
        stage,
        evidenceRefs: [`stage-input:${stage}`],
      }))).resolves.toMatchObject({ ok: true });
      await expect(store.appendTaskReleaseReceipt(taskId, cursor + 1, receipt('unknown', {
        requestIdentity,
        stage,
        evidenceRefs: [`fault:interrupted-after:${stage}`],
      }))).resolves.toMatchObject({ ok: true });
      await expect(store.appendTaskReleaseReceipt(taskId, cursor + 2, receipt('committed', {
        requestIdentity,
        stage,
        evidenceRefs: [`artifact-set:verified:${stage}`],
      }))).resolves.toMatchObject({ ok: true });
    }

    const journal = store.taskReleaseJournalFromDetail((await store.getTask(taskId))?.detail);
    expect(journal).toMatchObject({
      cursor: phases.length * 3,
      currentStage: 'release.manifest',
      currentState: 'committed',
    });
    expect(journal?.receipts.map(({ stage, state }) => ({ stage, state }))).toEqual(
      phases.flatMap((stage) => [
        { stage, state: 'intent' },
        { stage, state: 'unknown' },
        { stage, state: 'committed' },
      ]),
    );
  });

  it('fails closed on cursor races, operation reuse, and advance-without-intent', async () => {
    await releaseTask();
    expect((await store.appendTaskReleaseReceipt('releasetask01', 0, receipt('intent'))).ok).toBe(true);

    await expect(
      store.appendTaskReleaseReceipt('releasetask01', 0, receipt('unknown')),
    ).resolves.toMatchObject({ ok: false, reason: 'cursor_mismatch' });
    await expect(
      store.appendTaskReleaseReceipt('releasetask01', 1, receipt('intent', {
        stage: 'publish.multipart.part.1',
      })),
    ).resolves.toMatchObject({ ok: false, reason: 'request_identity_conflict' });
    await expect(
      store.appendTaskReleaseReceipt('releasetask01', 1, receipt('committed', {
        requestIdentity: 'never-intended',
      })),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_transition' });

    const journal = store.taskReleaseJournalFromDetail((await store.getTask('releasetask01'))?.detail);
    expect(journal?.cursor).toBe(1);
    expect(journal?.receipts).toHaveLength(1);
  });

  it('lets only one concurrent child win the same receipt cursor', async () => {
    await releaseTask();
    const outcomes = await Promise.all([
      store.appendTaskReleaseReceipt('releasetask01', 0, receipt('intent')),
      store.appendTaskReleaseReceipt('releasetask01', 0, receipt('intent', {
        requestIdentity: 'multipart-init-02',
      })),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ reason: 'cursor_mismatch' }),
    ]);
  });

  it('treats a malformed or receipt-count-mismatched chain as unavailable, never empty success', async () => {
    await releaseTask();
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release,cursor}', '1'::jsonb)
       WHERE task_id = 'releasetask01'
    `;
    expect(store.taskReleaseJournalFromDetail((await store.getTask('releasetask01'))?.detail)).toBeNull();
    await expect(
      store.appendTaskReleaseReceipt('releasetask01', 1, receipt('intent')),
    ).resolves.toMatchObject({ ok: false, reason: 'journal_missing' });

    const cyclicIdentity: Record<string, unknown> = {};
    cyclicIdentity.self = cyclicIdentity;
    const cyclicDetail = {
      release: {
        schemaVersion: 1,
        operationId,
        cursor: 1,
        currentStage: 'publish.multipart.initiate',
        currentState: 'intent',
        spentOperationIds: ['multipart-init-01'],
        receipts: [{
          sequence: 0,
          ...receipt('intent'),
          inputIdentity: cyclicIdentity,
        }],
      },
    };
    expect(() => store.taskReleaseJournalFromDetail(cyclicDetail)).not.toThrow();
    expect(store.taskReleaseJournalFromDetail(cyclicDetail)).toBeNull();
  });

  it('finds only a fresh, evidenced, same-workspace terminal receipt and bounds the candidate scan', async () => {
    const priorOperation = 'release-op-prior';
    const currentOperation = 'release-op-current';
    const expiresAt = '2026-09-10T00:00:00.000Z';
    const releaseDetail = (op: string) => ({
      release: {
        schemaVersion: 1,
        operationId: op,
        source: { sha: 'b'.repeat(40), gitlinks: { desktop: 'c'.repeat(40) } },
        artifactIdentity: { kind: 'papercusp-desktop-release', version: '0.0.19', channel: 'nightly' },
        cursor: 0,
        currentStage: null,
        currentState: null,
        spentOperationIds: [],
        receipts: [],
      },
    });
    await store.registerTask(
      { class: 'deploy', title: 'prior release', argv: ['release'], launchedBy: 'test', detail: releaseDetail(priorOperation) },
      { taskId: 'prior-release', workspaceId: WS },
    );
    await store.appendTaskReleaseReceipt('prior-release', 0, receipt('intent', {
      operationId: priorOperation,
      requestIdentity: 'prior-request',
      stage: 'release.build.linux',
      evidenceRefs: ['stage-input:' + inputHash],
    }));
    await store.appendTaskReleaseReceipt('prior-release', 1, receipt('committed', {
      operationId: priorOperation,
      requestIdentity: 'prior-request',
      stage: 'release.build.linux',
      evidenceRefs: ['artifact-set:hash-signature-verified'],
      credentialGeneration: 'generation-7',
      credentialExpiresAt: expiresAt,
      reuseExpiresAt: expiresAt,
      recordedAt: '2026-09-09T10:00:00.000Z',
      preparationElapsedMs: 1_234,
    }));
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET state = 'exited', ended_at = '2026-09-09T10:01:00.000Z', started_at = '2026-09-09T09:00:00.000Z'
       WHERE task_id = 'prior-release'
    `;
    await store.registerTask(
      { class: 'deploy', title: 'current release', argv: ['release'], launchedBy: 'test', detail: releaseDetail(currentOperation) },
      { taskId: 'current-release', workspaceId: WS },
    );
    await db.sql`
      UPDATE harness_shared.task_ledger SET started_at = '2026-09-09T11:00:00.000Z' WHERE task_id = 'current-release'
    `;

    const lookup = {
      currentTaskId: 'current-release',
      currentOperationId: currentOperation,
      stage: 'release.build.linux',
      inputHash,
      credentialGeneration: 'generation-7',
      requiredEvidenceRefs: ['artifact-set:hash-signature-verified'],
      now: new Date('2026-09-09T12:00:00.000Z'),
      maxCandidates: 4,
    } as const;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toMatchObject({
      taskId: 'prior-release',
      operationId: priorOperation,
      receipt: { sequence: 1, preparationElapsedMs: 1_234 },
    });
    await expect(store.findPriorCommittedTaskReleaseReceipt({ ...lookup, credentialGeneration: 'generation-8' })).resolves.toBeNull();
    await expect(store.findPriorCommittedTaskReleaseReceipt({ ...lookup, requiredEvidenceRefs: ['missing-proof'] })).resolves.toBeNull();
    await expect(store.findPriorCommittedTaskReleaseReceipt({ ...lookup, now: new Date(expiresAt) })).resolves.toBeNull();

    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release,artifactIdentity,kind}', '"other-release"'::jsonb)
       WHERE task_id = 'prior-release'
    `;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toBeNull();
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release,artifactIdentity,kind}', '"papercusp-desktop-release"'::jsonb)
       WHERE task_id = 'prior-release'
    `;
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = detail #- '{release,artifactIdentity,kind}'
       WHERE task_id = 'current-release'
    `;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toBeNull();
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release,artifactIdentity,kind}', '"papercusp-desktop-release"'::jsonb)
       WHERE task_id = 'current-release'
    `;
    await db.sql`UPDATE harness_shared.task_ledger SET class = 'other' WHERE task_id = 'current-release'`;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toBeNull();
    await db.sql`UPDATE harness_shared.task_ledger SET class = 'deploy' WHERE task_id = 'current-release'`;

    await db.sql`UPDATE harness_shared.task_ledger SET workspace_id = 'other-workspace' WHERE task_id = 'prior-release'`;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toBeNull();

    // A committed row without the artifact proof required by the manifest consumer
    // is never a publishable cache hit, even when every identity field still matches.
    await db.sql`UPDATE harness_shared.task_ledger SET workspace_id = ${WS} WHERE task_id = 'prior-release'`;
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_set(detail, '{release,receipts,1,evidenceRefs}', '[]'::jsonb)
       WHERE task_id = 'prior-release'
    `;
    await expect(store.findPriorCommittedTaskReleaseReceipt(lookup)).resolves.toBeNull();
  });
});

describe('P-012 terminal provenance writer', () => {
  async function liveTask(
    taskId: string,
    input: { memoryMaxBytes?: number | null; peakMemoryBytes?: number | null } = {},
  ) {
    const row = await store.registerTask(
      {
        class: 'bash-job',
        title: taskId,
        argv: ['/bin/bash'],
        launchedBy: 'test',
        memoryMaxBytes: input.memoryMaxBytes ?? null,
      },
      { taskId, workspaceId: WS, reserveScope: true, unitKind: 'service' },
    );
    await store.markSpawned(taskId, {
      pid: 42,
      processIdentity: 'linux:boot:42',
      scopeUnit: row.scopeUnit,
      cgroupPath: `/user.slice/papercusp.slice/${row.scopeUnit}`,
      confined: true,
    });
    if (input.peakMemoryBytes != null) {
      await store.touchAlive([{ taskId, metrics: { peakMemoryBytes: input.peakMemoryBytes, lastMemoryBytes: 1 } }]);
    }
    return (await store.getTask(taskId))!;
  }

  it('persists pids.events max monotonically while keeping pids.current at its latest sample', async () => {
    await liveTask('pidseventstask');
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET detail = jsonb_build_object('bashJobId', 'job-pids-events', 'keep', true)
       WHERE task_id = 'pidseventstask'
    `;

    await expect(
      store.touchAlive([
        { taskId: 'pidseventstask', metrics: { pidsCurrent: 12, pidsEventsMax: 11 } },
      ]),
    ).resolves.toBe(1);
    let row = (await db.sql`
      SELECT pids_current, detail FROM harness_shared.task_ledger WHERE task_id = 'pidseventstask'
    `)[0]!;
    expect(row).toMatchObject({
      pids_current: 12,
      detail: { bashJobId: 'job-pids-events', keep: true, pidsEventsMax: 11 },
    });
    expect((await store.getTask('pidseventstask'))).toMatchObject({ pidsCurrent: 12, pidsEventsMax: 11 });

    await expect(
      store.touchAlive([
        { taskId: 'pidseventstask', metrics: { pidsCurrent: 3, pidsEventsMax: 4 } },
      ]),
    ).resolves.toBe(1);
    row = (await db.sql`
      SELECT pids_current, detail FROM harness_shared.task_ledger WHERE task_id = 'pidseventstask'
    `)[0]!;
    expect(row).toMatchObject({
      pids_current: 3,
      detail: { bashJobId: 'job-pids-events', keep: true, pidsEventsMax: 11 },
    });

    await expect(
      store.touchAlive([
        { taskId: 'pidseventstask', metrics: { pidsCurrent: 2, pidsEventsMax: 17 } },
      ]),
    ).resolves.toBe(1);
    row = (await db.sql`
      SELECT pids_current, detail FROM harness_shared.task_ledger WHERE task_id = 'pidseventstask'
    `)[0]!;
    expect(row).toMatchObject({
      pids_current: 2,
      detail: { bashJobId: 'job-pids-events', keep: true, pidsEventsMax: 17 },
    });
    expect((await store.getTask('pidseventstask'))).toMatchObject({ pidsCurrent: 2, pidsEventsMax: 17 });
  });

  it('persists independent CPU and RSS sample timestamps only when each sample is present', async () => {
    const taskId = 'metricsampletimes';
    await liveTask(taskId);
    await store.touchAlive([{ taskId, metrics: { cpuUsec: 100, lastMemoryBytes: 2048 } }]);
    const sampled = (await store.getTask(taskId))!;
    expect(sampled.cpuSampledAt).toBeTruthy();
    expect(sampled.rssSampledAt).toBeTruthy();
    expect(Date.parse(sampled.cpuSampledAt!)).toBe(Date.parse(sampled.lastSeenAt));
    expect(Date.parse(sampled.rssSampledAt!)).toBe(Date.parse(sampled.lastSeenAt));

    const staleSampleAt = new Date(0).toISOString();
    await db.sql`
      UPDATE harness_shared.task_ledger
         SET last_seen_at = ${staleSampleAt}::timestamptz,
             detail = jsonb_set(
               jsonb_set(detail, '{cpuSampledAt}', to_jsonb(${staleSampleAt}::timestamptz), true),
               '{rssSampledAt}', to_jsonb(${staleSampleAt}::timestamptz), true
             )
       WHERE task_id = ${taskId}
    `;

    await store.touchAlive([{ taskId, metrics: { lastMemoryBytes: 4096 } }]);
    const rssRefresh = (await store.getTask(taskId))!;
    expect(rssRefresh).toMatchObject({
      cpuUsec: 100,
      lastMemoryBytes: 4096,
      cpuSampledAt: staleSampleAt,
    });
    expect(Date.parse(rssRefresh.lastSeenAt)).toBeGreaterThan(Date.parse(staleSampleAt));
    expect(Date.parse(rssRefresh.rssSampledAt!)).toBe(Date.parse(rssRefresh.lastSeenAt));

    await store.touchAlive([{ taskId, metrics: { cpuUsec: 200 } }]);
    const cpuRefresh = (await store.getTask(taskId))!;
    expect(cpuRefresh).toMatchObject({
      cpuUsec: 200,
      lastMemoryBytes: 4096,
      rssSampledAt: rssRefresh.rssSampledAt,
    });
    expect(Date.parse(cpuRefresh.cpuSampledAt!)).toBe(Date.parse(cpuRefresh.lastSeenAt));
  });

  function terminal(scopeUnit: string, over: Partial<TaskTerminalProvenance> = {}) {
    return {
      capturedAt: '2026-08-24T16:00:00.000Z',
      scopeUnit,
      cgroupPath: null,
      invocationId: 'terminal-invocation',
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'oom-kill',
      execMainCode: 2,
      execMainStatus: 9,
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      peakMemorySource: 'systemd' as const,
      ...over,
    };
  }

  it("records a cgroup-cap OOM as killed/137/exit_reason='oom-kill' with its exact unit identity", async () => {
    const max = 32 * 1024 * 1024;
    const row = await liveTask('oomtask', { memoryMaxBytes: max });
    // Classification and persistence use the awaited effect seam; the real
    // terminal-event bridge is exercised by its own integration suite.
    let emittedAfterClose = false;
    const emitTerminal = vi.fn<NonNullable<CloseTaskEffects['emitTerminal']>>(async (event) => {
      await Promise.resolve();
      const [closed] = await db.sql`
        SELECT state, exit_code, exit_reason, ended_at
          FROM harness_shared.task_ledger WHERE task_id = ${event.taskId}
      `;
      expect(closed).toMatchObject({
        state: 'killed',
        exit_code: 137,
        exit_reason: 'oom-kill',
      });
      expect(closed!.ended_at).not.toBeNull();
      emittedAfterClose = true;
    });
    const effects: CloseTaskEffects = { emitTerminal };

    await expect(
      store.closeTask('oomtask', {
        state: 'exited',
        exitCode: 1,
        terminalProvenance: terminal(row.scopeUnit!),
      }, undefined, effects),
    ).resolves.toBe(true);
    expect(emittedAfterClose).toBe(true);
    expect(emitTerminal).toHaveBeenCalledTimes(1);
    expect(emitTerminal).toHaveBeenCalledWith({
      taskId: 'oomtask',
      workspaceId: WS,
      harnessSlug: null,
      taskClass: 'bash-job',
      launchedBy: 'test',
      state: 'killed',
      exitCode: 137,
      exitReason: 'oom-kill',
      revision: 1,
    });

    const [stored] = await db.sql`
      SELECT state, exit_code, exit_reason, memory_max_bytes::text,
             peak_memory_bytes::text, detail
        FROM harness_shared.task_ledger WHERE task_id = 'oomtask'
    `;
    expect(stored).toMatchObject({
      state: 'killed',
      exit_code: 137,
      exit_reason: 'oom-kill',
      memory_max_bytes: String(max),
      peak_memory_bytes: String(max),
    });
    expect(stored!.detail.terminalProvenance).toMatchObject({
      scopeUnit: row.scopeUnit,
      cgroupPath: `/user.slice/papercusp.slice/${row.scopeUnit}`,
      invocationId: 'terminal-invocation',
      serviceResult: 'oom-kill',
      peakMemorySource: 'systemd',
    });
    expect((await store.getTask('oomtask'))?.terminalProvenance?.serviceResult).toBe('oom-kill');
  });

  it('distinguishes timeout, ordinary exit 1, manual kill, and uncapped host/ancestor OOM', async () => {
    // Classification is the subject here; exercising the asynchronous await-event
    // bridge would import an unrelated module graph after this test has settled.
    // WI-10002569: inject the documented effect seam so late import warnings
    // cannot turn a truthful ledger assertion into a console-warn flake.
    const emittedEvents: string[] = [];
    const emitTerminal = vi.fn(async (event: { taskId: string }) => {
      await Promise.resolve();
      emittedEvents.push(event.taskId);
    });
    const effects = { emitTerminal };
    const timeout = await liveTask('timeouttask', { memoryMaxBytes: 64 * 1024 * 1024 });
    await store.closeTask('timeouttask', {
      state: 'killed',
      exitReason: 'signal SIGTERM',
      terminalProvenance: terminal(timeout.scopeUnit!, {
        serviceResult: 'timeout',
        execMainStatus: 15,
        memoryMaxBytes: 64 * 1024 * 1024,
        peakMemoryBytes: 2 * 1024 * 1024,
      }),
    }, undefined, effects);

    await liveTask('exit1task');
    await store.closeTask('exit1task', { state: 'exited', exitCode: 1 }, undefined, effects);

    await liveTask('manualtask');
    await store.closeTask('manualtask', { state: 'killed', exitReason: 'scope kill SIGTERM' }, undefined, effects);

    const host = await liveTask('hostoomtask');
    await store.closeTask('hostoomtask', {
      state: 'killed',
      terminalProvenance: terminal(host.scopeUnit!, {
        memoryMaxBytes: null,
        peakMemoryBytes: 8 * 1024 * 1024,
      }),
    }, undefined, effects);

    const rows = await db.sql`
      SELECT task_id, state, exit_code, exit_reason
        FROM harness_shared.task_ledger ORDER BY task_id
    `;
    expect(Object.fromEntries(rows.map((row) => [row.task_id, row]))).toMatchObject({
      timeouttask: { state: 'timed_out', exit_code: 143, exit_reason: 'timeout' },
      exit1task: { state: 'exited', exit_code: 1, exit_reason: null },
      manualtask: { state: 'killed', exit_code: null, exit_reason: 'scope kill SIGTERM' },
      hostoomtask: { state: 'killed', exit_code: 137, exit_reason: 'host-oom' },
    });
    expect(emitTerminal).toHaveBeenCalledTimes(4);
    expect(emittedEvents).toEqual(['timeouttask', 'exit1task', 'manualtask', 'hostoomtask']);
  });

  it('refuses to attach terminal evidence from a different scope identity', async () => {
    const row = await liveTask('identitytask', { memoryMaxBytes: 32 * 1024 * 1024 });
    await expect(
      store.closeTask('identitytask', {
        state: 'killed',
        terminalProvenance: terminal('pc-other.service'),
      }),
    ).resolves.toBe(false);
    expect((await store.getTask(row.taskId))?.state).toBe('running');
  });

  it('upgrades an unobserved close from delayed exit evidence without changing ended_at', async () => {
    const row = await liveTask('lateexit');
    const effects = { emitTerminal: vi.fn(async () => {}) };
    await store.closeTask(row.taskId, { state: 'ended_unobserved' }, undefined, effects);
    const endedAt = (await store.getTask(row.taskId))!.endedAt;
    expect((await store.listReconcileTasks(WS)).map((r) => r.taskId)).toContain(row.taskId);
    const emitTerminal = vi.fn(async () => {
      expect(await store.getTask(row.taskId)).toMatchObject({ state: 'exited', exitCode: 0, endedAt });
    });
    const input = { state: 'ended_unobserved' as const, terminalProvenance: terminal(row.scopeUnit!, {
      activeState: 'inactive', serviceResult: 'success', execMainCode: 1, execMainStatus: 0,
    }) };
    expect(await store.closeTask(row.taskId, input, undefined, { emitTerminal })).toBe(true);
    expect(await store.closeTask(row.taskId, input, undefined, { emitTerminal })).toBe(false);
    expect(emitTerminal).toHaveBeenCalledTimes(1);
  });

  it('preserves a known invocation when delayed terminal evidence omits its identity', async () => {
    const row = await liveTask('missinginvocation');
    const effects = { emitTerminal: vi.fn(async () => {}), onTerminalPersisted: vi.fn() };
    await store.closeTask(row.taskId, { state: 'ended_unobserved', terminalProvenance: terminal(row.scopeUnit!, {
      invocationId: 'retained-invocation', activeState: 'inactive', serviceResult: null,
      execMainCode: null, execMainStatus: null,
    }) }, undefined, effects);
    const endedAt = (await store.getTask(row.taskId))!.endedAt;
    expect(await store.closeTask(row.taskId, { state: 'exited', exitCode: 0,
      terminalProvenance: terminal(row.scopeUnit!, { invocationId: null, activeState: 'inactive',
        serviceResult: 'success', execMainCode: 1, execMainStatus: 0 }) }, undefined, effects)).toBe(true);
    expect(await store.getTask(row.taskId)).toMatchObject({ state: 'exited', exitCode: 0, endedAt,
      terminalProvenance: { invocationId: 'retained-invocation' } });
    expect(effects.onTerminalPersisted).toHaveBeenCalledTimes(2);
  });

  it.each(['unobserved', 'runner-log'])('receipts only accepted terminal writes in a mixed %s batch', async (path) => {
    const tasks = await Promise.all(['acceptedreceipt', 'refusedreceipt'].map((id) => liveTask(id)));
    const receipts: string[] = [];
    const effects = (taskId: string) => ({ emitTerminal: vi.fn(async () => {}),
      onTerminalPersisted: () => receipts.push(taskId) });
    const verdicts = tasks.map((row, index) => ({ taskId: row.taskId, state: 'exited' as const,
      exitCode: 2, reason: 'released', terminalProvenance: terminal(index ? 'pc-wrong.service' : row.scopeUnit!) }));
    expect(await (path === 'unobserved'
      ? store.markEndedUnobserved(verdicts, undefined, effects)
      : store.markRecoveredFromJobLog(verdicts, undefined, effects))).toBe(1);
    expect(receipts).toEqual([tasks[0].taskId]);
    expect((await store.getTask(tasks[1].taskId))?.state).toBe('running');
  });

  it('preserves observed exits and rejects active or mismatched recovery evidence', async () => {
    const row = await liveTask('latecontrols');
    const effects = { emitTerminal: vi.fn(async () => {}) };
    await store.closeTask(row.taskId, { state: 'ended_unobserved', terminalProvenance: terminal(row.scopeUnit!, {
      invocationId: 'original', activeState: 'inactive', serviceResult: null, execMainCode: null, execMainStatus: null,
    }) }, undefined, effects);
    for (const change of [{ scopeUnit: 'pc-other.service' }, { invocationId: 'other' },
      ...['active', 'activating', 'reloading', 'deactivating'].map((activeState) => ({ activeState }))]) {
      expect(await store.closeTask(row.taskId, { state: 'exited', exitCode: 0,
        terminalProvenance: terminal(row.scopeUnit!, { invocationId: 'original', serviceResult: 'success',
          execMainCode: 1, execMainStatus: 0, activeState: 'inactive', ...change }) }, undefined, effects)).toBe(false);
    }
    expect(await store.closeTask(row.taskId, { state: 'exited', exitCode: 4 }, undefined, effects)).toBe(true);
    expect(await store.closeTask(row.taskId, { state: 'exited', exitCode: 0 }, undefined, effects)).toBe(false);
    expect(await store.getTask(row.taskId)).toMatchObject({ state: 'exited', exitCode: 4 });
  });

  it('does not receipt or emit a SQL-refused racing close after the recovery read', async () => {
    for (const change of ['observed', 'scope', 'invocation']) {
      const row = await liveTask(`racing${change}`);
      await store.closeTask(row.taskId, { state: 'ended_unobserved' }, undefined, { emitTerminal: async () => {} });
      const [before] = await db.sql`SELECT detail -> 'terminalEventRevision' AS revision,
        detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${row.taskId}`;
      let closeUpdates = 0;
      const effects: CloseTaskEffects = { emitTerminal: vi.fn(async () => {}), onTerminalPersisted: vi.fn(), stage: (stage) => {
        if (stage === 'task-close-update') updates.push(change === 'observed'
          ? db.sql`UPDATE harness_shared.task_ledger SET state = 'exited', exit_code = 9 WHERE task_id = ${row.taskId}`
          : change === 'scope'
            ? db.sql`UPDATE harness_shared.task_ledger SET scope_unit = 'pc-replaced.service' WHERE task_id = ${row.taskId}`
            : db.sql`UPDATE harness_shared.task_ledger SET detail = detail || '{"terminalProvenance":{"invocationId":"new"}}'::jsonb WHERE task_id = ${row.taskId}`);
      } };
      // An injected SQL boundary models another connection winning between read and UPDATE.
      const updates: PromiseLike<unknown>[] = [];
      const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
        const query = parts.join('?');
        if (query.includes('UPDATE harness_shared.task_ledger')) return (async () => {
          closeUpdates++;
          await Promise.all(updates);
          return db.sql(parts, ...values as never[]);
        })();
        return db.sql(parts, ...values as never[]);
      }) as typeof db.sql;
      expect(await store.closeTask(row.taskId, { state: 'exited', exitCode: 0 }, sql, effects)).toBe(false);
      expect(closeUpdates).toBe(1);
      expect(effects.onTerminalPersisted).not.toHaveBeenCalled();
      expect(effects.emitTerminal).not.toHaveBeenCalled();
      expect(await db.sql`SELECT detail -> 'terminalEventRevision' AS revision,
        detail -> 'terminalEventPending' AS pending FROM harness_shared.task_ledger WHERE task_id = ${row.taskId}`)
        .toEqual([before]);
    }
  });
});

describe('persistFailedTaskUnitTerminal fallback collector', () => {
  function failedTerminal(scopeUnit: string): TaskTerminalProvenance {
    return {
      capturedAt: '2026-09-26T20:00:00.000Z',
      scopeUnit,
      cgroupPath: null,
      invocationId: `invocation-${scopeUnit}`,
      loadState: 'loaded',
      activeState: 'failed',
      serviceResult: 'exit-code',
      execMainCode: 1,
      execMainStatus: 3,
      memoryMaxBytes: null,
      peakMemoryBytes: 7_700_480,
      peakMemorySource: 'systemd',
    };
  }

  it('reconstructs a missing ledger row, closes it with terminal evidence, then authorizes reset', async () => {
    const emittedEvents: string[] = [];
    const emitTerminal = vi.fn(async (event: { taskId: string }) => {
      await Promise.resolve();
      emittedEvents.push(event.taskId);
    });
    const result = await store.persistFailedTaskUnitTerminal(
      failedTerminal('pc-recovered1.service'),
      { workspaceId: WS, harnessSlug: 'papercusp' },
      undefined,
      { emitTerminal },
    );

    expect(result).toEqual({ durable: true, outcome: 'created-and-closed', taskId: 'recovered1' });
    const row = await store.getTask('recovered1');
    expect(row).toMatchObject({
      workspaceId: WS,
      harnessSlug: 'papercusp',
      class: 'bash-job',
      launchedBy: 'system:task-reconcile',
      scopeUnit: 'pc-recovered1.service',
      confined: true,
      state: 'exited',
      exitCode: 3,
      exitReason: 'exit-code',
      terminalProvenance: expect.objectContaining({
        scopeUnit: 'pc-recovered1.service',
        invocationId: 'invocation-pc-recovered1.service',
        peakMemoryBytes: 7_700_480,
      }),
    });
    expect(row?.detail.recoveredFailedUnit).toMatchObject({ source: 'task-reconcile-fallback' });
    expect(emitTerminal).toHaveBeenCalledOnce();
    expect(emittedEvents).toEqual(['recovered1']);
  });

  it('augments an already-terminal row without rewriting its observed terminal verdict', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, scope_unit, confined, state, exit_reason, ended_at, detail
      ) VALUES (
        'legacyterm1', ${WS}, 'legacyterm1', 'bash-job', 'legacy close', '[]'::jsonb,
        'su-original', 'pc-legacyterm1.service', true, 'stranded', 'observed owner exit', now(),
        '{"keep":"yes"}'::jsonb
      )
    `;

    const result = await store.persistFailedTaskUnitTerminal(failedTerminal('pc-legacyterm1.service'), {
      workspaceId: 'another-workspace',
      harnessSlug: 'other',
    });

    expect(result).toEqual({ durable: true, outcome: 'augmented-terminal', taskId: 'legacyterm1' });
    const row = await store.getTask('legacyterm1');
    expect(row).toMatchObject({
      workspaceId: WS,
      state: 'stranded',
      exitReason: 'observed owner exit',
      peakMemoryBytes: 7_700_480,
      terminalProvenance: expect.objectContaining({ scopeUnit: 'pc-legacyterm1.service' }),
      detail: expect.objectContaining({ keep: 'yes' }),
    });
  });

  it('refuses a task-id collision whose existing scope identity differs', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, scope_unit, confined, state, detail
      ) VALUES (
        'collision1', ${WS}, 'collision1', 'bash-job', 'different unit', '[]'::jsonb,
        'su-original', 'pc-different1.service', true, 'running', '{}'::jsonb
      )
    `;

    await expect(
      store.persistFailedTaskUnitTerminal(failedTerminal('pc-collision1.service'), { workspaceId: WS }),
    ).resolves.toEqual({ durable: false, outcome: 'refused', taskId: 'collision1' });
    expect((await store.getTask('collision1'))?.state).toBe('running');
  });

  it('is idempotent after terminal evidence is already durable', async () => {
    const terminal = failedTerminal('pc-idempotent1.service');
    const emitTerminal = vi.fn();
    await store.persistFailedTaskUnitTerminal(
      terminal,
      { workspaceId: WS },
      undefined,
      { emitTerminal },
    );
    await expect(
      store.persistFailedTaskUnitTerminal(
        terminal,
        { workspaceId: WS },
        undefined,
        { emitTerminal },
      ),
    ).resolves.toEqual({
      durable: true,
      outcome: 'already-recorded',
      taskId: 'idempotent1',
    });
    expect(emitTerminal).toHaveBeenCalledOnce();
  });

  it('refuses to reset a reused unit name when its invocation differs from durable evidence', async () => {
    const scopeUnit = 'pc-reusedunit1.service';
    const recorded = failedTerminal(scopeUnit);
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, scope_unit, confined, state, exit_reason, ended_at, detail
      ) VALUES (
        'reusedunit1', ${WS}, 'reusedunit1', 'bash-job', 'prior invocation', '[]'::jsonb,
        'su-original', ${scopeUnit}, true, 'stranded', 'prior failure', now(),
        ${JSON.stringify({ terminalProvenance: recorded })}::text::jsonb
      )
    `;
    const current = { ...recorded, invocationId: 'different-invocation' };

    await expect(store.persistFailedTaskUnitTerminal(current, { workspaceId: WS })).resolves.toEqual({
      durable: false,
      outcome: 'refused',
      taskId: 'reusedunit1',
    });
    expect((await store.getTask('reusedunit1'))?.terminalProvenance?.invocationId)
      .toBe(recorded.invocationId);
  });
});

describe('clearVanishedUnaccounted (EI-18824358724907941)', () => {
  it('does NOT throw when stillPresent is empty — the common zero-residue tick', async () => {
    await insertUnaccounted('t-1');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(1);
    const row = (await db.sql`SELECT state, exit_reason FROM harness_shared.task_ledger WHERE task_id = 't-1'`)[0];
    expect(row.state).toBe('stranded');
    expect(row.exit_reason).toBe('unaccounted residue no longer present');
  });

  it('closes ALL currently-unaccounted rows when nothing is still present (vacuous-TRUE semantics, not a no-op)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(2);
  });

  it('keeps a row named in stillPresent, closes the rest (non-empty path unchanged)', async () => {
    await insertUnaccounted('t-1');
    await insertUnaccounted('t-2', '/sys/fs/cgroup/bar');
    const closed = await store.clearVanishedUnaccounted(['t-1'], { workspaceId: WS });
    expect(closed).toBe(1);
    const rows = await db.sql`SELECT task_id, state FROM harness_shared.task_ledger ORDER BY task_id`;
    expect(rows).toEqual([
      { task_id: 't-1', state: 'unaccounted' },
      { task_id: 't-2', state: 'stranded' },
    ]);
  });

  it('is a no-op when there is nothing unaccounted at all (empty table, empty stillPresent)', async () => {
    await expect(store.clearVanishedUnaccounted([], { workspaceId: WS })).resolves.toBe(0);
  });
});

describe('gcTerminalTasks retention', () => {
  async function insertTerminal(
    taskId: string,
    endedHoursAgo: number,
    detail: Record<string, unknown>,
    options: { taskClass?: string; launchedBy?: string; logPath?: string | null; startedHoursAgo?: number } = {},
  ) {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, ended_at, log_path, detail
      ) VALUES (
        ${taskId}, ${WS}, ${taskId}, ${options.taskClass ?? 'deploy'}, ${taskId}, '[]'::jsonb,
        ${options.launchedBy ?? 'test'}, false, 'exited',
        now() - make_interval(hours => ${endedHoursAgo}::int), ${options.logPath ?? null},
        ${db.sql.json(detail as postgres.JSONValue)}
      )
    `;
    if (options.startedHoursAgo !== undefined) {
      await db.sql`
        UPDATE harness_shared.task_ledger
           SET started_at = now() - make_interval(hours => ${options.startedHoursAgo}::int)
         WHERE workspace_id = ${WS} AND task_id = ${taskId}
      `;
    }
  }

  it('never deletes a release journal, however long ago its process exited', async () => {
    // The plain old row is the positive control: without it, a GC that deletes nothing would pass.
    await insertTerminal('old-plain', 200, {});
    await insertTerminal('young-plain', 1, {});
    await insertTerminal('old-release', 200, { release: { operationId: 'op-1', receipts: [] } });

    await expect(store.gcTerminalTasks(168, { workspaceId: WS })).resolves.toBe(1);
    const rows = await db.sql`SELECT task_id FROM harness_shared.task_ledger ORDER BY task_id`;
    expect(rows.map((row) => row.task_id)).toEqual(['old-release', 'young-plain']);
  });

  it('retains the latest operator E2E task rows to match the per-run log window', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'operator-e2e-task-retention-'));
    const oldestLog = join(stateDir, 'operator-e2e-oldest.log');
    const latestLog = join(stateDir, 'operator-e2e-latest.log');
    writeFileSync(oldestLog, 'old E2E output\n', 'utf8');
    writeFileSync(latestLog, 'retained E2E output\n', 'utf8');

    try {
      const runIds = Array.from(
        { length: store.OPERATOR_E2E_TASK_RETENTION_RUNS + 1 },
        (_, index) => `operator-e2e-run-${String(index + 1).padStart(2, '0')}`,
      );
      for (const [index, taskId] of runIds.entries()) {
        const endedHoursAgo = 200 + runIds.length - index - 1;
        await insertTerminal(
          taskId,
          endedHoursAgo,
          { subsystem: store.OPERATOR_E2E_TASK_SUBSYSTEM, runGroup: `operator-e2e-nightly:fire-${index}` },
          {
            taskClass: store.OPERATOR_E2E_TASK_CLASS,
            launchedBy: store.OPERATOR_E2E_TASK_LAUNCHED_BY,
            logPath: index === 0 ? oldestLog : index === runIds.length - 1 ? latestLog : null,
            startedHoursAgo: endedHoursAgo + 1,
          },
        );
      }

      // Similar metadata outside the exact class/launcher/subsystem fence must
      // continue to use the ordinary age policy.
      await insertTerminal('wrong-launcher-e2e', 400, { subsystem: store.OPERATOR_E2E_TASK_SUBSYSTEM }, {
        taskClass: store.OPERATOR_E2E_TASK_CLASS,
      });
      await insertTerminal('wrong-class-e2e', 400, { subsystem: store.OPERATOR_E2E_TASK_SUBSYSTEM }, {
        taskClass: 'other',
        launchedBy: store.OPERATOR_E2E_TASK_LAUNCHED_BY,
      });
      await insertTerminal('wrong-subsystem-e2e', 400, { subsystem: 'other' }, {
        taskClass: store.OPERATOR_E2E_TASK_CLASS,
        launchedBy: store.OPERATOR_E2E_TASK_LAUNCHED_BY,
      });

      await expect(store.gcTerminalTasks(168, { workspaceId: WS })).resolves.toBe(4);

      const retained = await db.sql`
        SELECT task_id
          FROM harness_shared.task_ledger
         WHERE workspace_id = ${WS}
           AND class = ${store.OPERATOR_E2E_TASK_CLASS}
           AND launched_by = ${store.OPERATOR_E2E_TASK_LAUNCHED_BY}
           AND detail->>'subsystem' = ${store.OPERATOR_E2E_TASK_SUBSYSTEM}
         ORDER BY started_at DESC, task_id DESC
      `;
      expect(retained.map((row) => row.task_id)).toEqual(runIds.slice(1).reverse());
      expect(await store.getTask(runIds[0])).toBeNull();
      expect(await store.getTask('wrong-launcher-e2e')).toBeNull();
      expect(await store.getTask('wrong-class-e2e')).toBeNull();
      expect(await store.getTask('wrong-subsystem-e2e')).toBeNull();
      expect(existsSync(oldestLog)).toBe(false);
      expect(await store.getTask(runIds[runIds.length - 1])).toMatchObject({
        logPath: latestLog,
        class: store.OPERATOR_E2E_TASK_CLASS,
      });
      expect(existsSync(latestLog)).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('keeps terminal logs reattachable until expiry, then retires only deleted-row logs', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'task-ledger-retention-'));
    const scratchDir = join(stateDir, 'scratch');
    mkdirSync(scratchDir, { recursive: true });
    const expiredLog = join(scratchDir, 'bash-expired.log');
    const recentLog = join(scratchDir, 'bash-recent.log');
    const releaseLog = join(scratchDir, 'bash-release.log');
    const activeLog = join(scratchDir, 'bash-active.log');
    for (const [path, content] of [
      [expiredLog, 'expired output\n'],
      [recentLog, 'late reattachment output\n'],
      [releaseLog, 'release receipt output\n'],
      [activeLog, 'active output\n'],
    ]) {
      writeFileSync(path, content, 'utf8');
    }

    try {
      await insertTerminal(
        'expired-bash-task',
        200,
        { bashJobId: 'bash-expired' },
        { taskClass: 'bash-job', logPath: expiredLog },
      );
      await insertTerminal(
        'recent-bash-task',
        1,
        { bashJobId: 'bash-recent' },
        { taskClass: 'bash-job', logPath: recentLog },
      );
      await insertTerminal(
        'release-bash-task',
        200,
        { bashJobId: 'bash-release', release: { operationId: 'release-1', receipts: [] } },
        { taskClass: 'bash-job', logPath: releaseLog },
      );
      await db.sql`
        INSERT INTO harness_shared.task_ledger (
          task_id, workspace_id, root_task_id, class, title, argv,
          launched_by, confined, state, log_path, detail
        ) VALUES (
          'active-bash-task', ${WS}, 'active-bash-task', 'bash-job', 'active-bash-task',
          '[]'::jsonb, 'test', false, 'running', ${activeLog},
          ${db.sql.json({ bashJobId: 'bash-active' } as postgres.JSONValue)}
        )
      `;

      // bash_output's worker-loss recovery resolves this durable task identity
      // and reads its ledger-owned path while the row is within retention.
      const attachable = await store.getTaskByBashJobId('bash-recent', { workspaceId: WS });
      expect(attachable).toMatchObject({ taskId: 'recent-bash-task', logPath: recentLog, state: 'exited' });
      expect(readFileSync(attachable!.logPath!, 'utf8')).toBe('late reattachment output\n');

      await expect(store.gcTerminalTasks(168, { workspaceId: WS })).resolves.toBe(1);

      expect(await store.getTask('expired-bash-task')).toBeNull();
      expect(existsSync(expiredLog)).toBe(false);
      expect(await store.getTaskByBashJobId('bash-recent', { workspaceId: WS })).toMatchObject({
        taskId: 'recent-bash-task',
        logPath: recentLog,
      });
      expect(existsSync(recentLog)).toBe(true);
      expect(await store.getTask('release-bash-task')).toMatchObject({ logPath: releaseLog });
      expect(existsSync(releaseLog)).toBe(true);
      expect(await store.getTask('active-bash-task')).toMatchObject({ logPath: activeLog, state: 'running' });
      expect(existsSync(activeLog)).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe('upsertUnaccounted scope identity', () => {
  it('persists managed scope_unit canonically and backfills it on conflict without erasing it', async () => {
    const group = {
      taskId: 'tscopeunit',
      cgroupPath: '/sys/fs/cgroup/papercusp.slice/pc-tscopeunit.scope',
      scopeUnit: null as string | null,
      pids: [11],
      sampleCmdline: 'managed residue',
    };

    await store.upsertUnaccounted([group], { workspaceId: WS });
    let [row] = await db.sql`
      SELECT scope_unit, confined FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBeNull();
    expect(row!.confined).toBe(false);

    await store.upsertUnaccounted([{ ...group, scopeUnit: 'pc-tscopeunit.scope', pids: [12] }], { workspaceId: WS });
    [row] = await db.sql`
      SELECT scope_unit, confined FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBe('pc-tscopeunit.scope');
    expect(row!.confined).toBe(true);

    await store.upsertUnaccounted([{ ...group, pids: [13] }], { workspaceId: WS });
    [row] = await db.sql`
      SELECT scope_unit, confined FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}
    `;
    expect(row!.scope_unit).toBe('pc-tscopeunit.scope');
    expect(row!.confined).toBe(true);
  });

  it('persists unaccounted cgroup metrics and preserves lifecycle probes on refresh', async () => {
    const taskId = 't-unaccounted-metrics';
    const group = {
      taskId,
      cgroupPath: '/sys/fs/cgroup/papercusp.slice/t-unaccounted-metrics.scope',
      scopeUnit: 't-unaccounted-metrics.scope',
      pids: [11],
      sampleCmdline: 'unaccounted worker',
      metrics: {
        lastMemoryBytes: 1024,
        peakMemoryBytes: 2048,
        cpuUsec: 55,
        pidsCurrent: 2,
      },
    };
    const probe = {
      version: 1,
      launcherEndedSinceMs: null,
      logPath: null,
      logMtimeMs: null,
      cpuUsec: 55,
      cpuSampledAtMs: 123,
      lastActivityAtMs: null,
    };

    await store.upsertUnaccounted([group], { workspaceId: WS });
    await store.mergeTaskLifecycleProbes([{ taskId, probe }]);
    await store.upsertUnaccounted(
      [{ ...group, pids: [11, 12], metrics: { ...group.metrics, cpuUsec: 89, pidsCurrent: 4 } }],
      { workspaceId: WS },
    );

    const row = (await store.listLifecycleJudgementTasks({ workspaceId: WS })).find((item) => item.taskId === taskId);
    expect(row).toMatchObject({
      lastMemoryBytes: 1024,
      peakMemoryBytes: 2048,
      cpuUsec: 89,
      pidsCurrent: 4,
      detail: {
        pids: [11, 12],
        scopeUnit: group.scopeUnit,
        processLifecycleProbe: probe,
      },
    });
  });

  it('redacts credential-bearing residue titles before persisting and on conflict refresh', async () => {
    const group = {
      taskId: 't-redaction',
      cgroupPath: '/sys/fs/cgroup/papercusp.slice/pc-t-redaction.scope',
      scopeUnit: 'pc-t-redaction.scope',
      pids: [11],
      sampleCmdline: 'DATABASE_URL=postgresql://user:opaque-password@localhost/app',
    };

    await store.upsertUnaccounted([group], { workspaceId: WS });
    let [row] = await db.sql`SELECT title FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}`;
    expect(row!.title).toBe('DATABASE_URL=[redacted]');

    await store.upsertUnaccounted([{ ...group, sampleCmdline: 'AWS_ACCESS_KEY_ID=opaque-aws-access-key' }], {
      workspaceId: WS,
    });
    [row] = await db.sql`SELECT title FROM harness_shared.task_ledger WHERE task_id = ${group.taskId}`;
    expect(row!.title).toBe('AWS_ACCESS_KEY_ID=[redacted]');
    expect(row!.title).not.toContain('opaque-');
  });
});

describe('registerTask detector-placeholder adoption', () => {
  it('adopts a managed scope placeholder instead of losing its provenance to a duplicate key', async () => {
    const taskId = 'race1234';
    const scopeUnit = `pc-${taskId}.scope`;
    const cgroupPath = `/sys/fs/cgroup/papercusp.slice/${scopeUnit}`;

    await store.upsertUnaccounted(
      [
        {
          taskId,
          cgroupPath,
          scopeUnit,
          pids: [321],
          sampleCmdline: 'node invoke-once.js',
        },
      ],
      { workspaceId: WS },
    );

    const row = await store.registerTask(
      {
        class: 'sidecar',
        title: 'invoke-once',
        argv: ['node', 'invoke-once.js'],
        launchedBy: 'test',
      },
      { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
    );

    expect(row).toMatchObject({
      taskId,
      class: 'sidecar',
      title: 'invoke-once',
      launchedBy: 'test',
      scopeUnit,
      cgroupPath,
      pid: 321,
      state: 'pending',
    });
    expect(row.detail).toMatchObject({ pids: [321], scopeUnit });
  });

  it('rejects a duplicate registered task id instead of overwriting its provenance', async () => {
    const taskId = 'duplicate1234';
    await store.registerTask(
      {
        class: 'sidecar',
        title: 'original',
        argv: ['node', 'original.js'],
        launchedBy: 'original-owner',
      },
      { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
    );

    await expect(
      store.registerTask(
        {
          class: 'agent-session',
          title: 'replacement',
          argv: ['node', 'replacement.js'],
          launchedBy: 'replacement-owner',
        },
        { workspaceId: WS, taskId, reserveScope: true, unitKind: 'scope' },
      ),
    ).rejects.toThrow(/not an adoptable residue/);

    const [row] = await db.sql`
      SELECT class, title, launched_by FROM harness_shared.task_ledger WHERE task_id = ${taskId}
    `;
    expect(row).toEqual({ class: 'sidecar', title: 'original', launched_by: 'original-owner' });
  });
});

describe('registerTask unit identity', () => {
  it('reserves a transient service unit when the caller selects service mode', async () => {
    const row = await store.registerTask(
      {
        class: 'bash-job',
        title: 'service reservation',
        argv: ['echo', 'ok'],
        launchedBy: 'test',
      },
      { workspaceId: WS, taskId: 'abc123', reserveScope: true, unitKind: 'service' },
    );

    expect(row.scopeUnit).toBe('pc-abc123.service');
    const [dbRow] = await db.sql`
      SELECT scope_unit FROM harness_shared.task_ledger WHERE task_id = 'abc123'
    `;
    expect(dbRow!.scope_unit).toBe('pc-abc123.service');
  });
});

describe('updateTaskLimits', () => {
  it('persists every runtime budget field so the processes:list ledger read reflects systemd changes', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, cpu_weight, tasks_max, detail
      ) VALUES (
        't-limits', ${WS}, 't-limits', 'other', 'runtime limits',
        '[]'::jsonb, 'test', true, 'running', 100, 512, '{}'::jsonb
      )
    `;

    await expect(
      store.updateTaskLimits('t-limits', {
        memoryMaxBytes: 6_442_450_944,
        cpuWeight: 20,
        tasksMax: 256,
      }),
    ).resolves.toBe(true);

    const [row] = await db.sql`
      SELECT memory_max_bytes::text, cpu_weight::text, tasks_max::text
        FROM harness_shared.task_ledger
       WHERE task_id = 't-limits'
    `;
    expect(row).toEqual({
      memory_max_bytes: '6442450944',
      cpu_weight: '20',
      tasks_max: '256',
    });
  });

  it('retains omitted budget fields during a partial runtime retune', async () => {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, confined, state, memory_max_bytes, cpu_weight, tasks_max, detail
      ) VALUES (
        't-limits-partial', ${WS}, 't-limits-partial', 'other', 'partial runtime limits',
        '[]'::jsonb, 'test', true, 'running', 1024, 100, 512, '{}'::jsonb
      )
    `;

    await expect(store.updateTaskLimits('t-limits-partial', { cpuWeight: 40 })).resolves.toBe(true);
    const [row] = await db.sql`
      SELECT memory_max_bytes::text, cpu_weight::text, tasks_max::text
        FROM harness_shared.task_ledger
       WHERE task_id = 't-limits-partial'
    `;
    expect(row).toEqual({
      memory_max_bytes: '1024',
      cpu_weight: '40',
      tasks_max: '512',
    });
  });
});

/**
 * D-014 (process-lifecycle-no-orphans-2026-08-02). `markSpawned` stamps the
 * unconfined REASON into `detail`, which is shared jsonb other writers already use —
 * `startBackground` puts `bashJobId` there, and `findByBashJobId` reads it back via
 * `detail ->> 'bashJobId'`.
 *
 * So the merge has to be a merge. A plain `detail = '{...}'::jsonb` assignment would
 * pass every unit test (they mock the sql tag) and silently destroy the bashJobId
 * lookup in production — a background job that becomes unfindable the moment it is
 * marked running. These run against real Postgres precisely because that class of
 * mistake is invisible to a mocked query.
 */
describe('markSpawned detail merge (D-014)', () => {
  /** Note the `::jsonb` on a bound literal rather than `${JSON.stringify(...)}::jsonb`:
   *  under this harness's client the latter binds as a jsonb STRING, not an object,
   *  which is exactly the ambiguity `markSpawned` now refuses to depend on. */
  async function insertPending(taskId: string, detailJson: string) {
    await db.sql`
      INSERT INTO harness_shared.task_ledger (
        task_id, workspace_id, root_task_id, class, title, argv,
        launched_by, pid, confined, state, detail
      ) VALUES (
        ${taskId}, ${WS}, ${taskId}, 'other', 'sample', '[]'::jsonb,
        'unknown', null, false, 'pending', ${db.sql.unsafe(`'${detailJson}'::jsonb`)}
      )
    `;
  }

  it('stamps unconfinedReason WITHOUT clobbering an existing bashJobId', async () => {
    await insertPending('t-merge', '{"bashJobId":"bash-42"}');

    await store.markSpawned('t-merge', { pid: 123, confined: false, unconfinedReason: 'probe-pending' });

    const [row] =
      await db.sql`SELECT detail, confined, state FROM harness_shared.task_ledger WHERE task_id = 't-merge'`;
    expect(row!.detail).toEqual({ bashJobId: 'bash-42', unconfinedReason: 'probe-pending' });
    expect(row!.confined).toBe(false);
    expect(row!.state).toBe('running');
  });

  it('keeps the bashJobId lookup working after the stamp — the thing a clobber would break', async () => {
    await insertPending('t-lookup', '{"bashJobId":"bash-99"}');

    await store.markSpawned('t-lookup', { pid: 126, confined: false, unconfinedReason: 'probe-pending' });

    // `detail ->> 'bashJobId'` is how findByBashJobId resolves a background job. A
    // replace-instead-of-merge, or a merge that produced an array, returns nothing here.
    //
    // WI-8806: the `detail ? 'bashJobId'` clause mirrors the production query exactly --
    // it is what lets the planner use the PARTIAL task_ledger_bash_job_id_idx. Kept here
    // so this test exercises the same predicate set production does; without it the test
    // would still pass while silently diverging from the shape it claims to pin.
    const [row] = await db.sql`
      SELECT task_id FROM harness_shared.task_ledger
       WHERE detail ? 'bashJobId' AND detail ->> 'bashJobId' = 'bash-99'
    `;
    expect(row?.task_id).toBe('t-lookup');
  });

  it('leaves detail untouched when the task is confined (no reason to record)', async () => {
    await insertPending('t-confined', '{"bashJobId":"bash-7"}');

    await store.markSpawned('t-confined', { pid: 124, confined: true, unconfinedReason: null });

    const [row] = await db.sql`SELECT detail, confined FROM harness_shared.task_ledger WHERE task_id = 't-confined'`;
    expect(row!.detail).toEqual({ bashJobId: 'bash-7' });
    expect(row!.confined).toBe(true);
  });

  it('always merges into an OBJECT, never an array (the `||` string footgun)', async () => {
    await insertPending('t-shape', '{}');

    await store.markSpawned('t-shape', { pid: 125, confined: false, unconfinedReason: 'no-scope-support' });

    const [row] = await db.sql`
      SELECT jsonb_typeof(detail) AS t, detail FROM harness_shared.task_ledger WHERE task_id = 't-shape'
    `;
    expect(row!.t).toBe('object');
    expect(row!.detail).toEqual({ unconfinedReason: 'no-scope-support' });
  });
});

/**
 * listTasks({ coordOwnerId }) — the "which row is ME" filter (P-023/WI-2141828).
 *
 * `launched_by` is whoever SPAWNED the task, which for a fleet member is its launcher,
 * so it cannot answer that question. The fallback agents actually used was
 * `pgrep -f <ownerId>`, which self-matches the caller's own command line.
 *
 * The failure this guards is the silent-wrong-answer kind, and it has TWO directions
 * that a single happy-path assertion cannot separate:
 *
 *  - too WIDE — the predicate is dropped (a misplaced conditional, a `sql``` branch) and
 *    the read returns the whole ledger. Every row it returns is real, so the result looks
 *    entirely plausible; the caller concludes another owner's task is its own and kills it.
 *  - too NARROW — the predicate never matches and the read returns []. `coordOwnerId` is
 *    recorded only when the spawn supplied it, so an empty result is ALREADY a legitimate
 *    outcome the tool documents. A filter broken this way is therefore indistinguishable
 *    from the documented absence.
 *
 * So each test below carries both a positive control (a row that MUST come back) and a
 * negative one (a row that must NOT), and the widening test asserts on the exact id set
 * rather than a count — a count is satisfied by returning the wrong row.
 */
describe('listTasks coordOwnerId filter (P-023)', () => {
  it('returns this owner’s rows and NO other owner’s — including rows carrying no owner id at all', async () => {
    await insertAgentSessionTask({ taskId: 'mine-running', coordOwnerId: 'su-mine' });
    await insertAgentSessionTask({ taskId: 'mine-pending', coordOwnerId: 'su-mine', state: 'pending' });
    await insertAgentSessionTask({ taskId: 'theirs', coordOwnerId: 'su-theirs' });
    // A row whose detail has no coordOwnerId key: `detail ->> 'coordOwnerId'` is NULL, and
    // `NULL = 'su-mine'` is NULL, so SQL three-valued logic excludes it. Asserted because a
    // hand-rolled rewrite to COALESCE(...,'') or an IS NOT DISTINCT FROM would include it.
    await insertUnaccounted('no-owner-key');

    const ids = (await store.listTasks({ coordOwnerId: 'su-mine' })).map((r) => r.taskId).sort();

    expect(ids).toEqual(['mine-pending', 'mine-running']);
  });

  // FALSIFIABILITY CONTROL — permanent, per CLAUDE.md § "Proving a guard is falsifiable"
  // (the tier for a module the test imports; a copy-out mutation cannot reach `./store`,
  // and an in-tree mutation would dirty a tree git-sync sweeps).
  //
  // The risk this retires is fixtures that would pass whether or not the predicate exists.
  // `listTasks({})` IS the predicate-dropped behaviour, run through the real function: if
  // this returns the same set as the filtered read above, then that read proves nothing.
  it('control: the unfiltered read over the SAME fixtures returns the other owner’s row too', async () => {
    await insertAgentSessionTask({ taskId: 'mine-running', coordOwnerId: 'su-mine' });
    await insertAgentSessionTask({ taskId: 'theirs', coordOwnerId: 'su-theirs' });

    const unfiltered = (await store.listTasks({})).map((r) => r.taskId).sort();
    const filtered = (await store.listTasks({ coordOwnerId: 'su-mine' })).map((r) => r.taskId).sort();

    expect(unfiltered).toEqual(['mine-running', 'theirs']);
    expect(filtered).not.toEqual(unfiltered);
  });

  it('an owner with no rows returns [] while the ledger is demonstrably non-empty', async () => {
    // Calibration: without this control, a filter that matched nothing at all would pass
    // the assertion below for the wrong reason.
    await insertAgentSessionTask({ taskId: 'someone-else', coordOwnerId: 'su-theirs' });
    expect(await store.listTasks({})).toHaveLength(1);

    expect(await store.listTasks({ coordOwnerId: 'su-nobody' })).toEqual([]);
  });

  it('narrows rather than widens when combined with another filter', async () => {
    await insertAgentSessionTask({ taskId: 'mine-agent', coordOwnerId: 'su-mine' });
    await insertAgentSessionTask({ taskId: 'mine-bash', coordOwnerId: 'su-mine', taskClass: 'bash-job' });
    await insertAgentSessionTask({ taskId: 'theirs-agent', coordOwnerId: 'su-theirs' });

    const ids = (await store.listTasks({ coordOwnerId: 'su-mine', classes: ['agent-session'] })).map((r) => r.taskId);

    expect(ids).toEqual(['mine-agent']);
  });

  it('still honours the default live-only window, so an ended row of mine is opt-in', async () => {
    await insertAgentSessionTask({ taskId: 'mine-live', coordOwnerId: 'su-mine' });
    await insertAgentSessionTask({ taskId: 'mine-ended', coordOwnerId: 'su-mine', state: 'exited' });

    expect((await store.listTasks({ coordOwnerId: 'su-mine' })).map((r) => r.taskId)).toEqual(['mine-live']);
    expect((await store.listTasks({ coordOwnerId: 'su-mine', includeEnded: true })).map((r) => r.taskId).sort()).toEqual(
      ['mine-ended', 'mine-live'],
    );
  });
});

describe('process-lifecycle judgement ledger seam (P-009)', () => {
  it('reads every live/residue row plus only the terminal ids positively named by reconcile', async () => {
    await insertAgentSessionTask({ taskId: 'live-row', coordOwnerId: 'su-live' });
    await insertUnaccounted('unaccounted-row');
    await insertAgentSessionTask({ taskId: 'terminal-residue', coordOwnerId: 'su-ended', state: 'exited' });
    await insertAgentSessionTask({ taskId: 'terminal-history', coordOwnerId: 'su-history', state: 'exited' });

    const rows = await store.listLifecycleJudgementTasks({
      workspaceId: WS,
      residueTaskIds: ['terminal-residue'],
    });

    expect(rows.map((task) => task.taskId).sort()).toEqual(['live-row', 'terminal-residue', 'unaccounted-row']);
  });

  it('persists probes for live rows and explicitly confirmed terminal residue only', async () => {
    await insertAgentSessionTask({ taskId: 'live-probe', coordOwnerId: 'su-live' });
    await insertAgentSessionTask({ taskId: 'ended-probe', coordOwnerId: 'su-ended', state: 'exited' });
    await insertAgentSessionTask({ taskId: 'ended-residue-probe', coordOwnerId: 'su-ended-residue', state: 'exited' });
    const probe = {
      version: 1,
      launcherEndedSinceMs: 123,
      logPath: null,
      logMtimeMs: null,
      cpuUsec: 55,
      lastActivityAtMs: 456,
    };

    await expect(
      store.mergeTaskLifecycleProbes([
        { taskId: 'live-probe', probe },
        { taskId: 'ended-probe', probe },
        { taskId: 'ended-residue-probe', probe, terminalResidue: true },
      ]),
    ).resolves.toBe(2);

    const rows = await db.sql`
      SELECT task_id, detail FROM harness_shared.task_ledger
       WHERE task_id IN ('live-probe', 'ended-probe', 'ended-residue-probe') ORDER BY task_id
    `;
    expect(rows[0]).toEqual({
      task_id: 'ended-probe',
      detail: { coordOwnerId: 'su-ended' },
    });
    expect(rows[1]).toEqual({
      task_id: 'ended-residue-probe',
      detail: { coordOwnerId: 'su-ended-residue', processLifecycleProbe: probe },
    });
    expect(rows[2]).toEqual({
      task_id: 'live-probe',
      detail: { coordOwnerId: 'su-live', processLifecycleProbe: probe },
    });
  });
});
