import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runDbosWorkflowGcOnce,
  dbosWorkflowGcEnabled,
  dbosWorkflowGcRetentionDays,
  DBOS_TERMINAL_STATUSES,
  DBOS_WORKFLOW_GC_CRONTAB,
  DBOS_HISTORY_CEILING_CONDITION_KEY,
  dbosWorkflowHistoryCeiling,
  runDbosWorkflowHistoryAlarmOnce,
  type DbosHistoryAlarmDeps,
  type DbosGcDeps,
} from './dbos-workflow-gc';
import { computeNextFireAt } from '../harness/routines/cron';
import { armInProcessPeriodicChecks, buildDefaultChecks, disarmInProcessPeriodicChecks } from './in-process-periodic';

afterEach(() => {
  disarmInProcessPeriodicChecks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function alarmDeps(count: number): DbosHistoryAlarmDeps {
  return { readCount: async () => count, recentlyEscalated: async () => false,
    notify: vi.fn(async () => {}), broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) };
}

describe('DBOS-independent history ceiling', () => {
  it('uses a 300000-row default and reads a valid custom row threshold', () => {
    expect(dbosWorkflowHistoryCeiling()).toBe(300_000);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_HISTORY_CEILING', '1234');
    expect(dbosWorkflowHistoryCeiling()).toBe(1234);
    for (const invalid of ['-1', '0', '3.5', 'bad']) {
      vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_HISTORY_CEILING', invalid);
      expect(dbosWorkflowHistoryCeiling()).toBe(300_000);
    }
  });

  it.each([299_999, 300_000, 300_001])('observes the strict default ceiling boundary at %i rows', async count => {
    const deps = alarmDeps(count);
    const result = await runDbosWorkflowHistoryAlarmOnce({ deps });
    expect(result).toEqual({ count, ceilingRows: 300_000, breached: count > 300_000 });
    if (count > 300_000) {
      expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'intervention', importance: 'urgent', data: {
          rowCount: count, ceilingRows: 300_000, conditionKey: DBOS_HISTORY_CEILING_CONDITION_KEY,
        },
      }));
      expect(deps.broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: DBOS_HISTORY_CEILING_CONDITION_KEY }));
      expect(deps.resolve).not.toHaveBeenCalled();
    } else {
      expect(deps.notify).not.toHaveBeenCalled();
      expect(deps.broadcast).not.toHaveBeenCalled();
      expect(deps.resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: DBOS_HISTORY_CEILING_CONDITION_KEY }));
    }
  });

  it('uses the configured ceiling in the actual detector', async () => {
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_HISTORY_CEILING', '10');
    const deps = alarmDeps(11);
    expect(await runDbosWorkflowHistoryAlarmOnce({ deps })).toEqual({ count: 11, ceilingRows: 10, breached: true });
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ceilingRows: 10 }) }));
  });

  it('does not resolve an alarm after an unreadable or invalid count', async () => {
    const deps = alarmDeps(Number.NaN);
    await expect(runDbosWorkflowHistoryAlarmOnce({ deps })).rejects.toThrow('Invalid DBOS history row count');
    expect(deps.resolve).not.toHaveBeenCalled();
    deps.readCount = async () => { throw new Error('count unavailable'); };
    await expect(runDbosWorkflowHistoryAlarmOnce({ deps })).rejects.toThrow('count unavailable');
    expect(deps.resolve).not.toHaveBeenCalled();
  });

  it('runs the registered non-shed check within 60s across the three count boundaries', async () => {
    vi.useFakeTimers();
    let count = 299_999;
    const deps = alarmDeps(count);
    deps.readCount = async () => count;
    const gc = await import('./dbos-workflow-gc');
    const actual = gc.runDbosWorkflowHistoryAlarmOnce;
    vi.spyOn(gc, 'runDbosWorkflowHistoryAlarmOnce').mockImplementation(() => actual({ deps }));
    const check = buildDefaultChecks().find(c => c.name === 'dbos-history-ceiling')!;
    expect(check).toMatchObject({ intervalMs: 30_000, fireOnArm: true, classification: 'must-sample' });
    const shouldShed = vi.fn(() => true);
    armInProcessPeriodicChecks({ checks: [check], deps: { shouldShed } });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.notify).not.toHaveBeenCalled();
    count = 300_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.notify).not.toHaveBeenCalled();
    count = 300_001;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(shouldShed).not.toHaveBeenCalled();
  });
});

it('schedules a cleanup pass every hour across a full day', () => {
  let previous = new Date('2026-10-22T00:30:00Z');
  for (let i = 0; i < 25; i++) {
    const next = computeNextFireAt(DBOS_WORKFLOW_GC_CRONTAB, previous);
    expect(next).not.toBeNull();
    expect(next!.getTime() - previous.getTime()).toBe(3_600_000);
    previous = next!;
  }
});

describe('terminal-status safety', () => {
  it('only ever targets terminal statuses (never PENDING/ENQUEUED)', () => {
    expect([...DBOS_TERMINAL_STATUSES]).toEqual(['SUCCESS', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'CANCELLED']);
    expect(DBOS_TERMINAL_STATUSES as readonly string[]).not.toContain('PENDING');
    expect(DBOS_TERMINAL_STATUSES as readonly string[]).not.toContain('ENQUEUED');
  });
});

describe('env knobs', () => {
  it('default-ON (recurring backstop); disabled only by PAPERCUSP_DBOS_WORKFLOW_GC=0', () => {
    vi.unstubAllEnvs();
    expect(dbosWorkflowGcEnabled()).toBe(true);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC', '0');
    expect(dbosWorkflowGcEnabled()).toBe(false);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC', '1');
    expect(dbosWorkflowGcEnabled()).toBe(true);
  });
  it('retention defaults 2d, env-tunable', () => {
    vi.unstubAllEnvs();
    expect(dbosWorkflowGcRetentionDays()).toBe(2);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC_DAYS', '30');
    expect(dbosWorkflowGcRetentionDays()).toBe(30);
  });
});

describe('runDbosWorkflowGcOnce', () => {
  it('records an observable zero-work pass with elapsed time and budget disposition', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => [],
      deleteOutputs: vi.fn(async () => 0),
      deleteWorkflows: vi.fn(async () => 0),
    };
    let clock = 0;
    const result = await runDbosWorkflowGcOnce({ enabled: true, deps, nowMs: 0, nowClockMs: () => clock++ });
    expect(result).toMatchObject({ deletedWorkflows: 0, deletedOutputs: 0, batches: 0, budgetExhausted: false });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledExactlyOnceWith(`[dbos-workflow-gc] ${JSON.stringify(result)}`);
    expect(deps.deleteOutputs).not.toHaveBeenCalled();
  });

  it('records partial progress and propagates a deletion error for DBOS recovery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('workflow delete failed');
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => ['a'],
      deleteOutputs: async () => 2,
      deleteWorkflows: async () => { throw error; },
    };
    await expect(runDbosWorkflowGcOnce({ enabled: true, deps, nowMs: 0, nowClockMs: () => 7 })).rejects.toBe(error);
    expect(log).toHaveBeenCalledTimes(1);
    const record = JSON.parse(String(log.mock.calls[0]![0]).replace('[dbos-workflow-gc] ', ''));
    expect(record).toMatchObject({ error: error.message, deletedOutputs: 2, deletedWorkflows: 0, durationMs: 0, budgetExhausted: false });
  });

  it('starts no deletion when selection exhausts the time budget', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let clock = 0;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => { clock = 25; return ['a']; },
      deleteOutputs: vi.fn(async () => 1),
      deleteWorkflows: vi.fn(async () => 1),
    };
    const result = await runDbosWorkflowGcOnce({ enabled: true, deps, timeBudgetMs: 25, nowClockMs: () => clock });
    expect(result).toMatchObject({ batches: 0, deletedWorkflows: 0, budgetExhausted: true, durationMs: 25 });
    expect(deps.deleteOutputs).not.toHaveBeenCalled();
    expect(deps.deleteWorkflows).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(`[dbos-workflow-gc] ${JSON.stringify(result)}`);
  });
  it('disabled → skipped, runs NO queries', async () => {
    const deps: DbosGcDeps = {
      selectTerminalVictims: vi.fn(async () => []),
      deleteOutputs: vi.fn(async () => 0),
      deleteWorkflows: vi.fn(async () => 0),
    };
    const r = await runDbosWorkflowGcOnce({ enabled: false, deps });
    expect(r).toMatchObject({ skipped: true, deletedWorkflows: 0, deletedOutputs: 0 });
    expect(deps.selectTerminalVictims).not.toHaveBeenCalled();
  });

  it('enabled: deletes a sub-batch, outputs BEFORE workflows (FK order), computes cutoff', async () => {
    const calls: string[] = [];
    let served = false;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => {
        calls.push('select');
        if (served) return [];
        served = true;
        return ['a', 'b'];
      },
      deleteOutputs: async (ids) => { calls.push(`outputs:${ids.join(',')}`); return ids.length; },
      deleteWorkflows: async (ids) => { calls.push(`workflows:${ids.join(',')}`); return ids.length; },
    };
    const r = await runDbosWorkflowGcOnce({ enabled: true, retentionDays: 14, batchLimit: 5000, nowMs: 1_000_000_000_000, deps });
    expect(r.skipped).toBe(false);
    expect(r.deletedOutputs).toBe(2);
    expect(r.deletedWorkflows).toBe(2);
    expect(r.cutoffMs).toBe(1_000_000_000_000 - 14 * 86_400_000);
    const oi = calls.indexOf('outputs:a,b');
    const wi = calls.indexOf('workflows:a,b');
    expect(oi).toBeGreaterThanOrEqual(0);
    expect(wi).toBeGreaterThan(oi); // operation_outputs deleted before workflow_status
  });

  it('enabled: loops across a FULL batch then stops on a short/empty batch', async () => {
    let call = 0;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => { call++; return call === 1 ? ['a', 'b'] : []; },
      deleteOutputs: async (ids) => ids.length,
      deleteWorkflows: async (ids) => ids.length,
    };
    const r = await runDbosWorkflowGcOnce({ enabled: true, batchLimit: 2, nowMs: 0, deps });
    expect(call).toBe(2); // batch1 (==limit) → continue; batch2 (empty) → break
    expect(r.batches).toBe(1);
    expect(r.deletedWorkflows).toBe(2);
  });

  it('uses a liveness budget instead of a fixed batch ceiling', async () => {
    let call = 0;
    let clock = 0;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => {
        call += 1;
        return ['a'];
      },
      deleteOutputs: async (ids) => ids.length,
      deleteWorkflows: async (ids) => {
        // Model the elapsed time of each committed delete batch. The second
        // batch crosses the 25ms liveness budget, so no third SELECT should
        // be issued.
        clock += 13;
        return ids.length;
      },
    };
    const r = await runDbosWorkflowGcOnce({
      enabled: true,
      batchLimit: 1,
      timeBudgetMs: 25,
      nowMs: 0,
      nowClockMs: () => clock,
      deps,
    });
    // Two committed batches fit in the budget; the next tick resumes the rest.
    expect(r.batches).toBe(2);
    expect(r.deletedWorkflows).toBe(2);
    expect(r.budgetExhausted).toBe(true);
    expect(call).toBe(2);
  });
});
