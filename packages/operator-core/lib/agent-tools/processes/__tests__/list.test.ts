/**
 * processes:list — structured output preserves large inventories for ptool.
 *
 * The text projection is intentionally model-friendly JSON and may pass through
 * the result door. Programmatic callers need the typed object result instead, or
 * a 20-row inventory becomes an unparseable JSON prefix.
 */

import { describe, expect, it, vi } from 'vitest';
import { mockResolvedOnceTyped, mockResolvedTyped } from '../../../testing/typed-mock';
import type { ReconcileTickResult } from '../../../task-manager/reconcile-tick';
import { summarizeReconcile, type ReconcileResult } from '../../../task-manager/reconcile';
import type { TaskRow } from '../../../task-manager/types';

const { LOCAL_SUPERUSER_BEARER, listTasksMock } = vi.hoisted(() => ({
  LOCAL_SUPERUSER_BEARER: '8c91f74d2e6a4bbf90f44a71d142d095',
  listTasksMock: vi.fn(async (_filter?: unknown) => []),
}));

vi.mock('../../../task-manager/enabled', () => ({
  isTaskManagerEnabled: vi.fn(async () => true),
}));

vi.mock('../../../task-manager/store', () => ({
  listTasks: listTasksMock,
  listTasksPage: vi.fn(async (filter: { limit?: number } = {}) => {
    const rows = await listTasksMock(filter);
    return { rows, totalCount: rows.length, limit: filter.limit ?? 200 };
  }),
  residueTaskId: vi.fn((path: string) => `residue:${path}`),
}));

vi.mock('../../../task-manager/reconcile-tick', () => ({
  reconcileTick: vi.fn(),
}));

vi.mock('../../../superuser-token', () => ({
  readSuperuserToken: () => LOCAL_SUPERUSER_BEARER,
}));

await import('../list');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
const projected = lookupByMcpName('processes:list')!;

/**
 * A COMPLETE, typed reconcileTick result for the typed-mock helpers — no `as never`
 * (check-mock-cast-escape). `summary` is computed by the real summarizeReconcile, so
 * it can never disagree with the `result` a fixture supplies.
 */
function tickResult(
  over: {
    result?: Partial<ReconcileResult>;
    scan?: Partial<ReconcileTickResult['scan']>;
  } & Partial<Omit<ReconcileTickResult, 'result' | 'scan' | 'summary'>> = {},
): ReconcileTickResult {
  const { result: resultOver, scan: scanOver, ...rest } = over;
  const result: ReconcileResult = {
    alive: [], stranded: [], unresolved: [], endedUnobserved: [], unaccounted: [], abandonedWindow: [],
    consoleWindow: [], verifierScope: [], foreign: [], overdue: [], tooYoung: [],
    ...resultOver,
  };
  return {
    summary: summarizeReconcile(result),
    result,
    scan: {
      ownedRootExists: true, ownedTruncated: false, foreignTruncated: false, scanTimedOut: false,
      processes: 0, userManagerRoot: null, ...scanOver,
    },
    scannedProcesses: [],
    degraded: false,
    touched: 0,
    strandedCount: 0,
    endedUnobservedCount: 0,
    recoveredFromJobLogCount: 0,
    unaccountedPersisted: 0,
    residueCleared: 0,
    confirmedUnaccounted: [],
    ...rest,
  };
}

function makeTx() {
  return vi.fn(async () => []);
}

function pageTaskRow(taskId: string): TaskRow {
  return {
    taskId,
    workspaceId: 'default',
    rootTaskId: taskId,
    class: 'bash-job',
    title: taskId,
    argv: [],
    launchedBy: 'su-test',
    workItemId: null,
    planSlug: null,
    parentTaskId: null,
    confined: true,
    state: 'running',
    startedAt: '2026-10-31T00:00:00.000Z',
    lastSeenAt: '2026-10-31T00:00:00.000Z',
    lastMemoryBytes: null,
    peakMemoryBytes: null,
    cpuUsec: null,
    pidsCurrent: 1,
    scopeUnit: `${taskId}.scope`,
    memoryMaxBytes: null,
    deadlineAt: null,
    exitCode: null,
    exitReason: null,
    logPath: null,
    detail: {},
  };
}

describe('processes:list structured output', () => {
  it('dispatch correlation accepts and forwards an exact selector and keeps live recovery compact', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockClear();
    mockResolvedOnceTyped(vi.mocked(reconcileTick), tickResult());
    const dispatchCallId = 'server-dispatch-for-lost-response';
    const dispatched = await dispatchProjectedTool(projected, 'processes:list',
      { dispatchCallId, includeEnded: true, limit: 1, live: true }, {
        log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
        workspaceId: 'default', runId: 'processes-list-dispatch-correlation', role: 'operator',
        gateBypass: { role: true, capability: true, quota: true }, transport: 'mcp',
        requestedFormat: 'json', requestedStructured: true, tx: makeTx(),
      }, {});
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledOnce();
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ dispatchCallId, includeEnded: true, limit: 1 }));
    expect(JSON.stringify(dispatched)).toContain('global process groups omitted because a task selector is active');
  });

  it('allows the prompted mug lifecycle judge to read evidence', () => {
    expect(projected.agentRoles).toContain('mug');
  });

  it('documents PID counts and PID arrays as distinct return fields', () => {
    const returns = projected.guidance?.returns ?? '';
    expect(returns).toContain('pids: number|null (PID count)');
    expect(returns).toContain('livePids: number[]|null (PID array');
    expect(returns).toContain('unaccountedGroups?: Array<{ pids: number[] (PID array) }>');
  });

  it('accepts the singular state filter used by sibling task surfaces', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { state: 'running' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-singular-state-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ states: ['running'] }));
  });

  it('accepts the exact taskId selector used by processes:kill', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { taskId: 'task-to-kill' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-task-id-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-to-kill' }));
  });

  it('accepts an exact scopeUnit selector for a live systemd unit', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();
    const scopeUnit = 'papercup-green-checkpoint-manual-1fxzuva.service';

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { scopeUnit, includeEnded: true, limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-scope-unit-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ scopeUnit, limit: 2000 }));
  });

  it('accepts an exact InvocationID selector for terminal provenance', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();
    const invocationId = '8c91f74d2e6a4bbf90f44a71d142d095';

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { invocationId, includeEnded: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-invocation-id-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ invocationId }));
  });

  it('preserves scan truncation flags while returning only the exact live systemd group', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    const scopeUnit = 'papercup-green-checkpoint-manual-1fxzuva.service';
    vi.mocked(listTasks).mockResolvedValueOnce([]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { alive: 0, stranded: 0, endedUnobserved: 0, unaccounted: 1, foreign: 1, verifierScope: 0 },
      result: {
        alive: [],
        stranded: [],
        endedUnobserved: [],
        unaccounted: [
          { cgroupPath: `/user.slice/${scopeUnit}`, scopeUnit, pids: [101, 102], sampleCmdline: 'checkpoint target' },
        ],
        abandonedWindow: [],
        consoleWindow: [],
        verifierScope: [],
        foreign: [
          { cgroupPath: '/user.slice/other.service', scopeUnit: 'other.service', pids: [201], sampleCmdline: 'other' },
        ],
        overdue: [],
        tooYoung: [],
      },
      scan: { processes: 3, ownedTruncated: false, foreignTruncated: true },
      degraded: false,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 0,
      residueCleared: 0,
    } as never);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { scopeUnit, live: true, includeEnded: true, limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-exact-live-unit-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      live: {
        exactScopeUnitMatches: Array<Record<string, unknown>>;
        ownedTruncated: boolean;
        foreignTruncated: boolean;
      };
    };
    expect(structured.live.ownedTruncated).toBe(false);
    expect(structured.live.foreignTruncated).toBe(true);
    expect(structured.live.exactScopeUnitMatches).toEqual([
      {
        kind: 'unaccounted',
        cgroupPath: `/user.slice/${scopeUnit}`,
        scopeUnit,
        pids: [101, 102],
        sample: 'checkpoint target',
      },
    ]);
  });

  it('reports task-ledger pagination independently of a complete kernel scan', async () => {
    const { listTasksPage } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    const rows = Array.from({ length: 200 }, (_, index) => pageTaskRow(`task-page-${index}`));
    vi.mocked(listTasksPage).mockResolvedValueOnce({ rows, totalCount: 231, limit: 200 });
    mockResolvedOnceTyped(vi.mocked(reconcileTick), tickResult());

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-task-page-truncation-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(dispatched.result?.structuredContent).toMatchObject({
      taskPage: { limit: 200, returned: 200, total: 231, truncated: true },
      live: { ownedTruncated: false, foreignTruncated: false },
    });
  });

  it('overlays dry-run terminal reconciliation verdicts without mutating ledger rows', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    const row = (taskId: string): TaskRow => ({
      taskId,
      workspaceId: 'default',
      rootTaskId: taskId,
      class: 'agent-session',
      title: taskId,
      argv: [],
      launchedBy: 'su-test',
      workItemId: null,
      planSlug: null,
      parentTaskId: null,
      confined: true,
      state: 'running',
      startedAt: '2026-08-25T01:00:00.000Z',
      lastSeenAt: '2026-08-25T01:00:00.000Z',
      lastMemoryBytes: 34 * 1024 * 1024,
      peakMemoryBytes: 34 * 1024 * 1024,
      cpuUsec: 0,
      pidsCurrent: 0,
      scopeUnit: `pc-${taskId}.scope`,
      memoryMaxBytes: null,
      deadlineAt: null,
      exitCode: null,
      exitReason: null,
      logPath: null,
      detail: {},
    });
    const strandedRow = row('bootstrap-corpse');
    const endedRow = row('ended-without-exit');
    vi.mocked(listTasks).mockResolvedValueOnce([strandedRow, endedRow]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { alive: 0, stranded: 1, endedUnobserved: 1 },
      result: {
        alive: [],
        stranded: [{ taskId: strandedRow.taskId, reason: 'scope disappeared from the kernel' }],
        endedUnobserved: [{ taskId: endedRow.taskId, reason: 'systemd confirmed the scope was released' }],
        unaccounted: [],
        abandonedWindow: [],
        consoleWindow: [],
        verifierScope: [],
        foreign: [],
        overdue: [],
        tooYoung: [],
      },
      scan: { processes: 0, foreignTruncated: false },
      degraded: false,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 0,
      residueCleared: 0,
    } as never);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-reconcile-overlay-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      counts: { byState: Record<string, number> };
      tasks: Array<{ taskId: string; state: string; exitReason: string | null }>;
    };
    expect(structured.counts.byState).toMatchObject({ stranded: 1, ended_unobserved: 1 });
    expect(structured.tasks).toEqual([
      expect.objectContaining({
        taskId: strandedRow.taskId,
        state: 'stranded',
        exitReason: 'scope disappeared from the kernel',
      }),
      expect.objectContaining({
        taskId: endedRow.taskId,
        state: 'ended_unobserved',
        exitReason: 'systemd confirmed the scope was released',
      }),
    ]);
    expect(strandedRow.state).toBe('running');
    expect(endedRow.state).toBe('running');
  });

  it('advertises an object result and preserves a large task inventory', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    mockResolvedTyped(
      vi.mocked(listTasks),
      // Annotated `: TaskRow` rather than cast `as never`: the annotation gives each object
      // literal CONTEXTUAL typing (so `class` / `state` narrow to their real unions instead
      // of widening to string) AND makes a new required field on TaskRow a compile error
      // here — which the old cast silently swallowed.
      Array.from(
        { length: 25 },
        (_, i): TaskRow => ({
          taskId: `task-${i}`,
          workspaceId: 'default',
          rootTaskId: `root-${i}`,
          class: 'bash-job',
          title: `task-${i}-${'x'.repeat(220)}`,
          argv: [],
          launchedBy: 'su-test',
          workItemId: null,
          planSlug: null,
          parentTaskId: null,
          confined: true,
          state: 'running' as const,
          startedAt: '2026-08-12T09:00:00.000Z',
          lastSeenAt: '2026-08-12T09:00:00.000Z',
          lastMemoryBytes: 1024,
          peakMemoryBytes: 2048,
          cpuUsec: 3_000_000,
          pidsCurrent: 1,
          scopeUnit: `pc-${i}.scope`,
          memoryMaxBytes: null,
          deadlineAt: null,
          exitCode: null,
          exitReason: null,
          logPath: null,
          detail: {},
        }),
      ),
    );

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({
      ok: true,
      counts: { total: 25 },
    });
    const structured = dispatched.result?.structuredContent as { tasks: unknown[] };
    expect(structured.tasks).toHaveLength(25);
  });

  it('surfaces the durable systemd reason and killed scope identity for a completed task', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const row: TaskRow = {
      taskId: 'oom-task',
      workspaceId: 'default',
      rootTaskId: 'oom-task',
      class: 'bash-job',
      title: 'oom-task',
      argv: [],
      launchedBy: 'su-test',
      confined: true,
      state: 'killed',
      startedAt: '2026-08-24T09:00:00.000Z',
      endedAt: '2026-08-24T09:01:00.000Z',
      lastSeenAt: '2026-08-24T09:01:00.000Z',
      scopeUnit: 'pc-oom-task.service',
      cgroupPath: '/user.slice/papercusp.slice/pc-oom-task.service',
      memoryMaxBytes: 32 * 1024 * 1024,
      peakMemoryBytes: 32 * 1024 * 1024,
      exitCode: 137,
      exitReason: 'oom-kill',
      terminalProvenance: {
        capturedAt: '2026-08-24T09:01:00.000Z',
        scopeUnit: 'pc-oom-task.service',
        cgroupPath: '/user.slice/papercusp.slice/pc-oom-task.service',
        invocationId: 'oom-invocation',
        loadState: 'loaded',
        activeState: 'failed',
        serviceResult: 'oom-kill',
        execMainCode: 2,
        execMainStatus: 9,
        memoryMaxBytes: 32 * 1024 * 1024,
        peakMemoryBytes: 32 * 1024 * 1024,
        peakMemorySource: 'systemd',
      },
      detail: {},
    };
    vi.mocked(listTasks).mockResolvedValueOnce([row]);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { includeEnded: true },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-terminal-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect((dispatched.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
      state: 'killed',
      exitCode: 137,
      exitReason: 'oom-kill',
      termination: {
        reason: 'oom-kill',
        serviceResult: 'oom-kill',
        scopeUnit: 'pc-oom-task.service',
        invocationId: 'oom-invocation',
        memoryMaxMb: 32,
        peakRssMb: 32,
        peakMemorySource: 'systemd',
      },
    });
  });

  it('uses persisted sample timestamps and ignores repeated reads of the same CPU sample', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const row = (
      cpuUsec: number,
      lastSeenAt: string,
      cpuSampledAt = lastSeenAt,
      rssSampledAt = lastSeenAt,
    ): TaskRow => ({
      taskId: 'cpu-rate-task',
      workspaceId: 'default',
      rootTaskId: 'cpu-rate-task',
      class: 'bash-job',
      title: 'cpu-rate-task',
      argv: [],
      launchedBy: 'su-test',
      workItemId: null,
      planSlug: null,
      parentTaskId: null,
      confined: true,
      state: 'running',
      startedAt: '2026-08-24T09:00:00.000Z',
      lastSeenAt,
      cpuSampledAt,
      rssSampledAt,
      lastMemoryBytes: 1024,
      peakMemoryBytes: 2048,
      cpuUsec,
      pidsCurrent: 1,
      scopeUnit: 'pc-cpu-rate-task.scope',
      memoryMaxBytes: null,
      deadlineAt: null,
      exitCode: null,
      exitReason: null,
      logPath: null,
      detail: {},
    });

    vi.useFakeTimers();
    try {
      const sampleTime = new Date('2026-08-24T09:01:00.000Z').getTime();
      const read = (runId: string) => dispatchProjectedTool(
          projected,
          'processes:list',
          {},
          {
            log: vi.fn(),
            signal: new AbortController().signal,
            progress: vi.fn(),
            emit: vi.fn(),
            workspaceId: 'default',
            runId,
            role: 'operator',
            gateBypass: { role: true, capability: true, quota: true },
            transport: 'mcp',
            requestedFormat: 'json',
            requestedStructured: true,
            tx: makeTx(),
          },
          {},
        );

      vi.setSystemTime(sampleTime);
      vi.mocked(listTasks).mockResolvedValueOnce([
        row(0, new Date(sampleTime).toISOString(), new Date(sampleTime).toISOString()),
      ]);
      const first = await read('processes-list-cpu-first');

      // The ledger still has the same metric sample ten seconds later. Request time
      // must not turn that cached counter into an apparently measured zero.
      vi.setSystemTime(sampleTime + 10_000);
      vi.mocked(listTasks).mockResolvedValueOnce([
        row(0, new Date(sampleTime + 10_000).toISOString(), new Date(sampleTime).toISOString()),
      ]);
      const repeated = await read('processes-list-cpu-repeated');

      // A later persisted sample does provide a valid interval. Its sample timestamps,
      // rather than the much later request time, set the rate denominator.
      vi.setSystemTime(sampleTime + 20_000);
      vi.mocked(listTasks).mockResolvedValueOnce([
        row(1_000_000, new Date(sampleTime + 1000).toISOString(), new Date(sampleTime + 1000).toISOString()),
      ]);
      const second = await read('processes-list-cpu-second');

      expect(first.ok, JSON.stringify(first)).toBe(true);
      expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
      expect(second.ok, JSON.stringify(second)).toBe(true);
      expect((first.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
        cpuSec: 0,
        cpuBusyPercent: null,
        cpuSampleAgeSec: 0,
        cpuSampleFreshness: 'current',
      });
      expect((repeated.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
        cpuSec: 0,
        cpuBusyPercent: null,
        cpuSampleAgeSec: 10,
        cpuSampleFreshness: 'stale',
        rssSampleAgeSec: 0,
        rssSampleFreshness: 'current',
      });
      expect((second.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0]).toMatchObject({
        cpuSec: 1,
        cpuBusyPercent: 100,
        cpuSampleAgeSec: 19,
        cpuSampleFreshness: 'current',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the validated scopeUnit for a live unaccounted group', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: {
        alive: 2,
        stranded: 3,
        endedUnobserved: 4,
        unaccounted: 1,
        unaccountedPids: 2,
        abandonedWindow: 5,
        abandonedWindowPids: 6,
        consoleWindow: 7,
        consoleWindowPids: 8,
        verifierScope: 9,
        verifierScopePids: 10,
        foreign: 11,
        overdue: 12,
        tooYoung: 13,
      },
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope',
            scopeUnit: 'pc-orphan123.scope',
            pids: [11, 12],
            sampleCmdline: 'node orphan',
          },
        ],
        verifierScope: [
          {
            cgroupPath:
              '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/' +
              'papercup-tauri-verify-90-3416089-tauri-1.scope',
            scopeUnit: 'papercup-tauri-verify-90-3416089-tauri-1.scope',
            pids: [21, 22],
            sampleCmdline: 'npm run tauri dev',
          },
        ],
        foreign: [],
      },
      scan: { processes: 2, foreignTruncated: false },
      degraded: false,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 1,
      residueCleared: 0,
    } as never);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true, limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-live-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      live: {
        aliveCount: number;
        strandedCount: number;
        endedUnobservedCount: number;
        unaccountedCount: number;
        unaccountedPidCount: number;
        abandonedWindowCount: number;
        abandonedWindowPidCount: number;
        consoleWindowCount: number;
        consoleWindowPidCount: number;
        verifierScopeCount: number;
        verifierScopePidCount: number;
        foreignCount: number;
        overdueCount: number;
        tooYoungCount: number;
        unaccountedGroups: Array<{ scopeUnit: string; cgroupPath: string; pids: number[] }>;
        verifierGroups: Array<{ scopeUnit: string; cgroupPath: string; pids: number[] }>;
      };
    };
    expect(structured.live).toMatchObject({
      aliveCount: 2,
      strandedCount: 3,
      endedUnobservedCount: 4,
      unaccountedCount: 1,
      unaccountedPidCount: 2,
      abandonedWindowCount: 5,
      abandonedWindowPidCount: 6,
      consoleWindowCount: 7,
      consoleWindowPidCount: 8,
      verifierScopeCount: 9,
      verifierScopePidCount: 10,
      foreignCount: 11,
      overdueCount: 12,
      tooYoungCount: 13,
    });
    for (const ambiguousCountKey of [
      'alive', 'stranded', 'endedUnobserved', 'unaccounted', 'unaccountedPids',
      'abandonedWindow', 'abandonedWindowPids', 'consoleWindow', 'consoleWindowPids',
      'verifierScope', 'verifierScopePids', 'foreign', 'overdue', 'tooYoung',
    ]) {
      expect(structured.live).not.toHaveProperty(ambiguousCountKey);
    }
    expect(structured.live.unaccountedGroups[0]).toMatchObject({
      scopeUnit: 'pc-orphan123.scope',
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope',
      pids: [11, 12],
    });
    expect(structured.live.unaccountedGroups).toHaveLength(structured.live.unaccountedCount);
    expect(structured.live.unaccountedPidCount).toBe(
      structured.live.unaccountedGroups.reduce((count, group) => count + group.pids.length, 0),
    );
    expect(structured.live.verifierGroups).toEqual([
      expect.objectContaining({
        scopeUnit: 'papercup-tauri-verify-90-3416089-tauri-1.scope',
        pids: [21, 22],
      }),
    ]);
  });

  it('joins live unaccounted scope PIDs onto its task row without treating an absent scan as zero', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    const orphan: TaskRow = {
      taskId: 'orphan123', workspaceId: 'default', rootTaskId: 'orphan123',
      class: 'other', title: 'orphan', argv: [], launchedBy: 'unknown',
      workItemId: null, planSlug: null, parentTaskId: null, confined: false,
      state: 'unaccounted', startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      lastMemoryBytes: null, peakMemoryBytes: null, cpuUsec: null, pidsCurrent: null,
      scopeUnit: 'pc-orphan123.scope', memoryMaxBytes: null, deadlineAt: null,
      exitCode: null, exitReason: null, logPath: null, detail: {},
    };
    vi.mocked(listTasks).mockResolvedValueOnce([orphan]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { unaccounted: 1, unaccountedPids: 2 },
      result: { unaccounted: [{
        cgroupPath: '/user.slice/papercusp.slice/pc-orphan123.scope',
        scopeUnit: 'pc-orphan123.scope',
        pids: [11, 12], sampleCmdline: 'node orphan',
      }] },
      degraded: false, scan: { processes: 2, foreignTruncated: false },
    } as never);
    const context = {
      log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
      workspaceId: 'default', runId: 'unaccounted-pids-live', role: 'operator',
      gateBypass: { role: true, capability: true, quota: true },
      transport: 'mcp', requestedFormat: 'json', requestedStructured: true, tx: makeTx(),
    } as const;
    const measured = await dispatchProjectedTool(projected, 'processes:list',
      { taskId: 'orphan123', live: true }, context, {});
    expect(measured.ok).toBe(true);
    expect((measured.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0])
      .toMatchObject({ state: 'unaccounted', pids: 2, livePids: [11, 12] });

    vi.mocked(listTasks).mockResolvedValueOnce([orphan]);
    mockResolvedOnceTyped(vi.mocked(reconcileTick), tickResult({
      degraded: true, degradedReason: 'incomplete kernel scan',
      scan: { processes: 0, foreignTruncated: true },
    }));
    const unknown = await dispatchProjectedTool(projected, 'processes:list',
      { taskId: 'orphan123', live: true }, context, {});
    expect(unknown.ok).toBe(true);
    expect((unknown.result?.structuredContent as { tasks: Array<Record<string, unknown>> }).tasks[0])
      .toMatchObject({ pids: null, livePids: null });
  });

  it('redacts credential assignments in live groups and persisted task titles', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([
      {
        taskId: 'task-redaction',
        workspaceId: 'default',
        rootTaskId: 'task-redaction',
        class: 'bash-job',
        title:
          'psql DATABASE_URL=postgresql://user:opaque-password@localhost/app --url postgresql://user:second-secret@db.example/app',
        argv: [],
        launchedBy: 'su-test',
        workItemId: null,
        planSlug: null,
        parentTaskId: null,
        confined: true,
        state: 'running',
        startedAt: '2026-08-23T09:00:00.000Z',
        lastSeenAt: '2026-08-23T09:00:00.000Z',
        lastMemoryBytes: null,
        peakMemoryBytes: null,
        cpuUsec: null,
        pidsCurrent: 1,
        scopeUnit: 'pc-task-redaction.scope',
        memoryMaxBytes: null,
        deadlineAt: null,
        exitCode: null,
        exitReason: null,
        logPath: null,
        detail: {},
      },
    ]);
    mockResolvedOnceTyped(vi.mocked(reconcileTick), tickResult({
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/papercusp.slice/pc-orphan-redaction.scope',
            scopeUnit: 'pc-orphan-redaction.scope',
            pids: [11],
            sampleCmdline:
              `python3 - http://127.0.0.1:9071 ${LOCAL_SUPERUSER_BEARER} ` + 'AWS_ACCESS_KEY_ID=opaque-aws-access-key',
          },
        ],
      },
      scan: { processes: 1, foreignTruncated: false },
      unaccountedPersisted: 1,
    }));

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true, limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-redaction-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const structured = dispatched.result?.structuredContent as {
      live: { unaccountedGroups: Array<{ sample: string }> };
      tasks: Array<{ title: string }>;
    };
    expect(structured.live.unaccountedGroups[0]!.sample).toBe(
      'python3 - http://127.0.0.1:9071 [redacted] AWS_ACCESS_KEY_ID=[redacted]',
    );
    expect(structured.tasks[0]!.title).toBe(
      'psql DATABASE_URL=[redacted] --url postgresql://[redacted]@db.example/app',
    );
    expect(JSON.stringify(structured)).not.toContain('opaque-');
    expect(JSON.stringify(structured)).not.toContain('second-secret');
    expect(JSON.stringify(structured)).not.toContain(LOCAL_SUPERUSER_BEARER);
  });

  it('omits unrelated global groups from a filtered live task read', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    const { reconcileTick } = await import('../../../task-manager/reconcile-tick');
    vi.mocked(listTasks).mockResolvedValueOnce([]);
    vi.mocked(reconcileTick).mockResolvedValueOnce({
      summary: { unaccounted: 38, foreign: 38, verifier: 1 },
      result: {
        unaccounted: [
          {
            cgroupPath: '/user.slice/papercusp.slice/pc-orphan123.scope',
            scopeUnit: 'pc-orphan123.scope',
            pids: [11, 12],
            sampleCmdline: 'node unrelated orphan process',
          },
        ],
        verifierScope: [
          {
            cgroupPath: '/user.slice/papercusp.slice/papercup-tauri-verify.scope',
            scopeUnit: 'papercup-tauri-verify.scope',
            pids: [21],
            sampleCmdline: 'npm run tauri dev',
          },
        ],
        foreign: [
          {
            cgroupPath: '/user.slice/foreign.slice/foreign.scope',
            pids: [31],
            sampleCmdline: 'node unrelated foreign process',
          },
        ],
      },
      scan: { processes: 3, foreignTruncated: false },
      degraded: false,
      touched: 0,
      strandedCount: 0,
      endedUnobservedCount: 0,
      unaccountedPersisted: 1,
      residueCleared: 0,
    } as unknown as ReconcileTickResult);

    const dispatched = await dispatchProjectedTool(
      projected,
      'processes:list',
      { live: true, launchedBy: 'su-self', limit: 2000 },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'processes-list-filtered-live-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: makeTx(),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(expect.objectContaining({ launchedBy: 'su-self' }));
    const structured = dispatched.result?.structuredContent as {
      live: Record<string, unknown>;
    };
    expect(structured.live).toMatchObject({
      unaccountedCount: 38,
      diagnosticsOmitted: 'global process groups omitted because a task selector is active',
    });
    expect(structured.live).not.toHaveProperty('unaccountedGroups');
    expect(structured.live).not.toHaveProperty('foreignGroups');
    expect(structured.live).not.toHaveProperty('verifierGroups');
  });
});

/**
 * P-023/D-111 — the tool must DERIVE confinement, never surface the stored column.
 *
 * `confinement.test.ts` proves the resolver. Nothing proved the TOOL calls it, and that
 * is the regression with teeth: replacing `resolveTaskConfinement(r)` with the obvious
 * `cgroupPath: r.cgroupPath` leaves every other assertion in this file passing, ships a
 * field that LOOKS authoritative, and answers the one question it exists for —
 * "would restarting the operator kill this?" — with the pre-EI-9748 YES.
 *
 * So the fixture below stores exactly that wrong value. Asserting on the stored path
 * (rather than only on the derived one) is what makes this test fail on the regression:
 * a test that merely checked `cgroupPath` was a non-empty string would pass either way.
 */
describe('processes:list confinement (P-023/D-111)', () => {
  const ctx = (runId: string) => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    runId,
    role: 'operator' as const,
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp' as const,
    requestedFormat: 'json' as const,
    requestedStructured: true,
    tx: makeTx(),
  });

  // The operator's OWN cgroup — what completeSyncEnrolment wrote for ~1300 agent-session
  // rows by reading /proc/<spawner-pid>/cgroup after `systemd-run --scope` forked away.
  const STORED_SPAWNER_CGROUP = '/user.slice/user-1000.slice/user@1000.service/papercup-dev-api.service';

  const confinedRow = (over: Partial<TaskRow> = {}): TaskRow =>
    ({
      taskId: 'agent-row',
      workspaceId: 'default',
      rootTaskId: 'agent-row',
      class: 'agent-session',
      title: 'agent-row',
      argv: [],
      launchedBy: 'su-launcher',
      workItemId: null,
      planSlug: null,
      parentTaskId: null,
      confined: true,
      state: 'running',
      startedAt: '2026-09-02T01:00:00.000Z',
      lastSeenAt: '2026-09-02T01:00:00.000Z',
      lastMemoryBytes: null,
      peakMemoryBytes: null,
      cpuUsec: 0,
      pidsCurrent: 1,
      scopeUnit: 'pc-agent-row.scope',
      cgroupPath: STORED_SPAWNER_CGROUP,
      memoryMaxBytes: null,
      deadlineAt: null,
      exitCode: null,
      exitReason: null,
      logPath: null,
      detail: {},
      ...over,
    }) as TaskRow;

  async function tasksFor(row: TaskRow, args: Record<string, unknown> = {}) {
    const { listTasks } = await import('../../../task-manager/store');
    vi.mocked(listTasks).mockClear();
    vi.mocked(listTasks).mockResolvedValueOnce([row]);

    const dispatched = await dispatchProjectedTool(projected, 'processes:list', args, ctx('confinement-test'), {});
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    return (
      dispatched.result?.structuredContent as {
        tasks: Array<{
          taskId: string;
          confined: boolean;
          scopeUnit: string | null;
          confinement: {
            confined: boolean;
            cgroupPath: string | null;
            scopeUnit: string | null;
            source: string;
            insideOperatorCgroup?: boolean;
            reason?: string;
          };
        }>;
      }
    ).tasks;
  }

  it('derives the path from scope_unit and does NOT echo the stored spawner cgroup', async () => {
    const [task] = await tasksFor(confinedRow());

    expect(task!.confinement.source).toBe('derived-from-scope-unit');
    expect(task!.confinement.scopeUnit).toBe('pc-agent-row.scope');
    // The derived root depends on the host's own cgroup, so assert the PROPERTY that
    // distinguishes derivation from a column read rather than a literal path.
    expect(task!.confinement.cgroupPath).toContain('pc-agent-row.scope');
    expect(task!.confinement.cgroupPath).not.toBe(STORED_SPAWNER_CGROUP);
    expect(task!.confinement.cgroupPath).not.toContain('papercup-dev-api.service');
  });

  it('reports an unaccounted exact task scope from its observed cgroup path', async () => {
    const taskId = 'abc123';
    const scopeUnit = 'pc-abc123.scope';
    const observedPath =
      `/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/${scopeUnit}`;
    const [task] = await tasksFor(
      confinedRow({
        taskId,
        rootTaskId: taskId,
        class: 'other',
        state: 'unaccounted',
        confined: false,
        scopeUnit,
        cgroupPath: observedPath,
      }),
    );

    expect(task).toMatchObject({
      taskId,
      confined: true,
      scopeUnit,
      confinement: {
        confined: true,
        cgroupPath: observedPath,
        scopeUnit,
        source: 'observed-at-reconcile',
      },
    });
  });

  it('reports a confined row with no scope unit as UNKNOWN, not as unconfined', async () => {
    const [task] = await tasksFor(confinedRow({ scopeUnit: null }));

    expect(task!.confinement.confined).toBe(true);
    expect(task!.confinement.source).toBe('not-derivable');
    expect(task!.confinement.cgroupPath).toBeNull();
    // The stored column is present and wrong; "no scope unit" must not fall back to it.
    expect(task!.confinement.cgroupPath).not.toBe(STORED_SPAWNER_CGROUP);
    // Absent, never false — a `false` here reads as "safe from an operator restart".
    expect(task!.confinement).not.toHaveProperty('insideOperatorCgroup');
  });

  it('passes coordOwnerId through to the ledger read as its own filter', async () => {
    const { listTasks } = await import('../../../task-manager/store');
    await tasksFor(confinedRow(), { coordOwnerId: 'su-mine' });

    // Distinct from launchedBy on purpose: for a fleet member they differ, which is why
    // launchedBy cannot answer "which row is me".
    expect(vi.mocked(listTasks)).toHaveBeenCalledWith(
      expect.objectContaining({ coordOwnerId: 'su-mine', launchedBy: undefined }),
    );
  });
});
