import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runOrchestrationScript } from '../../../../../libs/generic/tooldef/src/code-orchestration/run-script';

// Keep this fixture byte-for-byte aligned with the script persisted by recipes:revise.
const script = readFileSync(
  new URL('./fixtures/distill-active-git-sync-liveness-and-error-signals.recipe.txt', import.meta.url),
  'utf8',
);

function execute(
  ownerPid: number,
  workflowId: string,
  logsResult: Record<string, unknown> = {
    backend: 'systemd',
    matched: 1,
    collapsed: 0,
    truncated: false,
    entries: [{
      ts: '2026-11-02T00:00:00.000Z',
      unit: 'papercusp-bg-host.service',
      level: 'info',
      message: 'git-sync recipe test',
      repeat: 1,
    }],
  },
  processResult: Record<string, unknown> = {
    taskPage: { limit: 200, returned: 2, total: 2, truncated: false },
    live: { degraded: false, ownedTruncated: false, foreignTruncated: false },
    tasks: [
      { taskId: 'count-only', rootTaskId: 'count-only-root', class: 'runner', state: 'running', livePids: [], pids: ownerPid },
      { taskId: workflowId, rootTaskId: 'root-' + ownerPid, class: 'git-sync', state: 'running', livePids: [ownerPid], pids: 1 },
    ],
  },
) {
  const routinesList = vi.fn(async (_args: Record<string, unknown>) => ({
    count: 1,
    routines: [{
      installSlug: 'papercusp',
      name: 'git-sync',
      active: true,
      health: {
        git_sync_activity: {
          active: true,
          phase: 'local-sync',
          owner_pid: ownerPid,
          workflow_id: workflowId,
        },
      },
    }],
  }));
  const logsRead = vi.fn(async (_args: Record<string, unknown>) => logsResult);
  const processesList = vi.fn(async (_args: Record<string, unknown>) => processResult);
  const facade = {
    routines: { list: routinesList },
    logs: { read: logsRead },
    processes: { list: processesList },
  } as unknown as Parameters<typeof runOrchestrationScript>[1];
  const result = runOrchestrationScript(script, facade, { inputs: {} });
  return { result, routinesList, logsRead, processesList };
}

describe('saved git-sync liveness recipe', () => {
  it.each([
    { ownerPid: 31001, workflowId: 'workflow-run-a' },
    { ownerPid: 42002, workflowId: 'workflow-run-b' },
  ])('derives a different routine owner on each run: $workflowId', async ({ ownerPid, workflowId }) => {
    expect(script).not.toMatch(/\b\d{6,}\b/);

    const run = execute(ownerPid, workflowId);
    const result = await run.result;
    expect(result.ok).toBe(true);
    expect(result.fieldMisses ?? []).toEqual([]);

    const summary = result.result as {
      pidDriftGuard: { passed: boolean };
      routine: { owner_pid: number | null; workflow_id: string | null; activity_active: boolean; phase: string | null };
      processInventory: {
        matchCoverage: { status: string; complete: boolean; unknownReasons: string[] };
        matches: Array<{ taskId: string; livePids: number[] | null; pidsCount: number | null }>;
      };
    };
    expect(summary.pidDriftGuard.passed).toBe(true);
    expect(summary.routine).toMatchObject({
      owner_pid: ownerPid,
      workflow_id: workflowId,
      activity_active: true,
      phase: 'local-sync',
    });
    expect(summary.processInventory.matches).toEqual([
      expect.objectContaining({ taskId: workflowId, livePids: [ownerPid], pidsCount: 1 }),
    ]);
    expect(summary.processInventory.matchCoverage).toMatchObject({
      status: 'match-found',
      complete: true,
      unknownReasons: [],
    });
    expect(run.routinesList).toHaveBeenCalledWith({
      installSlug: 'papercusp',
      name: 'git-sync',
      limit: 1,
      payloadTier: 'full',
    });
    expect(run.logsRead.mock.calls[0]?.[0].grep).toContain(String(ownerPid));
    expect(run.processesList).toHaveBeenCalledWith({
      states: ['running', 'stranded', 'unaccounted'],
      live: true,
      limit: 200,
    });
  });

  it('handles missing optional logs output without a field miss', async () => {
    const run = execute(31001, 'workflow-run-optional-logs', {});
    const result = await run.result;
    expect(result.ok).toBe(true);
    expect(result.fieldMisses ?? []).toEqual([]);
    expect(result.result.logWindow).toMatchObject({
      backend: null,
      matched: null,
      collapsed: null,
      truncated: null,
      signalRows: [],
    });
  });

  it.each([
    {
      name: 'task page is truncated',
      expectedReason: 'task-page-truncated',
      processResult: {
        taskPage: { limit: 1, returned: 1, total: 2, truncated: true },
        live: { degraded: false, ownedTruncated: false, foreignTruncated: false },
        tasks: [],
      },
    },
    {
      name: 'live scan is degraded',
      expectedReason: 'live-scan-degraded',
      processResult: {
        taskPage: { limit: 200, returned: 0, total: 0, truncated: false },
        live: { degraded: true, ownedTruncated: false, foreignTruncated: false },
        tasks: [],
      },
    },
    {
      name: 'owned process scan is truncated',
      expectedReason: 'owned-scan-truncated',
      processResult: {
        taskPage: { limit: 200, returned: 0, total: 0, truncated: false },
        live: { degraded: false, ownedTruncated: true, foreignTruncated: false },
        tasks: [],
      },
    },
    {
      name: 'foreign process scan is truncated',
      expectedReason: 'foreign-scan-truncated',
      processResult: {
        taskPage: { limit: 200, returned: 0, total: 0, truncated: false },
        live: { degraded: false, ownedTruncated: false, foreignTruncated: true },
        tasks: [],
      },
    },
  ])('reports no-match as unknown when the $name', async ({ expectedReason, processResult }) => {
    const run = execute(31001, 'workflow-run-incomplete-coverage', undefined, processResult);
    const result = await run.result;
    expect(result.ok).toBe(true);
    const summary = result.result as {
      processInventory: { matchCoverage: { status: string; complete: boolean; unknownReasons: string[] } };
    };
    expect(summary.processInventory.matchCoverage.status).toBe('unknown');
    expect(summary.processInventory.matchCoverage.complete).toBe(false);
    expect(summary.processInventory.matchCoverage.unknownReasons).toContain(expectedReason);
  });

  it('reports complete no-match only when the task page and process scan are complete', async () => {
    const run = execute(31001, 'workflow-run-complete-no-match', undefined, {
      taskPage: { limit: 200, returned: 0, total: 0, truncated: false },
      live: { degraded: false, ownedTruncated: false, foreignTruncated: false },
      tasks: [],
    });
    const result = await run.result;
    expect(result.ok).toBe(true);
    const summary = result.result as {
      processInventory: { matchCoverage: { status: string; complete: boolean; unknownReasons: string[] } };
    };
    expect(summary.processInventory.matchCoverage).toEqual({
      status: 'complete-no-match',
      complete: true,
      unknownReasons: [],
      taskPageTruncated: false,
      liveScan: { degraded: false, ownedTruncated: false, foreignTruncated: false },
    });
  });
});

