/**
 * gate-throughput-shift-left-2026-10-06 P-001 / P-002 (bars R-1, R-2, R-3).
 *
 * R-1: the per-sync delta check runs under load — the soft load band and a running
 *      green-checkpoint suite shrink its budget instead of skipping it, every heavy
 *      leg runs at low CPU / best-effort I/O priority, and only a hard ceiling still skips.
 * R-2: every tick records whether it judged its window; coverage below the
 *      threshold over the alarm window files ONE condition-keyed alarm, which
 *      clears when coverage recovers.
 * R-3: a red is routed to the agent whose edit introduced it, read from the
 *      per-edit attribution ledger (never git blame), and an assignment refusal
 *      never costs the red itself.
 */
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  sqlRows: [] as Array<Record<string, unknown>>,
  createArgs: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  wakes: [] as Array<{ targets: string[]; options: Record<string, unknown> }>,
  messagePersisted: false,
  notificationFails: false,
  notificationAssignee: 'su-author-1' as string | null,
  wakeQueued: 1,
  operationalRuns: [] as Array<Record<string, unknown>>,
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.sqlCalls.push({ text: strings.join('$?'), values });
      return Promise.resolve(captured.sqlRows);
    },
  }),
}));

vi.mock('../agent-tools/work_items/_create-core', () => ({
  createOneWorkItem: async (args: Record<string, unknown>) => {
    captured.createArgs.push(args);
    return { ok: true, workItem: { id: 'WI-77' } };
  },
}));

vi.mock('../work-items', () => ({
  getWorkItem: async () => ({ assignee: captured.notificationAssignee }),
}));
vi.mock('../agent-tools/coordination/messages', () => ({
  getMessageById: async () => captured.messagePersisted ? { msg_id: 'persisted' } : null,
  sendMessage: async (_identity: unknown, options: Record<string, unknown>) => {
    if (captured.notificationFails) throw new Error('notification store unavailable');
    captured.messages.push(options);
    captured.messagePersisted = true;
    return { msg_id: options.msgId };
  },
}));
vi.mock('../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: async (targets: string[], options: Record<string, unknown>) => {
    captured.wakes.push({ targets, options });
    return { queued: captured.wakeQueued, woken: captured.wakeQueued, staged: 0, timedOutTargets: [] };
  },
}));
vi.mock('../agent-tools/testing/record-run', () => ({
  executeOperationalRun: async (input: { run: () => Promise<unknown> }, scope: unknown) => {
    captured.operationalRuns.push({ input, scope });
    return input.run();
  },
}));

import { buildSyncBatchDeltaDeps, runReservedArgv, type RunResult } from './sync-batch-delta-check-deps';
import { buildSyncLintGuardDeps } from './sync-batch-lint-guards-deps';
import {
  COVERAGE_ALARM_CONDITION_KEY,
  COVERAGE_ALARM_MIN_TICKS,
  COVERAGE_ALARM_THRESHOLD,
  COVERAGE_ALARM_WINDOW_MS,
  COVERAGE_EXPECTED_INTERVAL_MS,
  COVERAGE_JUDGE_DEADLINE_MS,
  SYNC_DELTA_RUN_BUDGET_MS,
  SYNC_DELTA_TIMEOUTS_MS,
  REDUCED_BUDGET,
  SOURCE_CHECK_SLICE,
  buildCoverageAlarm,
  creditLateJudgedSlots,
  evaluateCapacity,
  evaluateCoverage,
  evaluateSyncRedDeliveryWindow,
  executeSyncRedDeliveryWindow,
  fileRoutedRed,
  isScopeLaunchFailure,
  reservedCapacityArgv,
  pickRedAuthor,
  recordCoverageOpportunities,
  recordCoverageTick,
  runSyncBatchDeltaCheck,
  type CoverageTick,
  type EditorHit,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
  type SyncRedDeliveryWindow,
} from './sync-batch-delta-check';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const NOW = 10_000_000;
const FULL = { maxConfirmRuns: 3, maxAttributionProbes: 8 };

describe('R-8 original author delivery clock', () => {
  function history(delayMs = 900_000): SyncRedDeliveryWindow {
    return { workspaceId: 'ws-1', harnessSlug: 'h', windowStartMs: NOW - 1,
      windowEndMs: NOW + 1, observedAtMs: NOW + 2_000_000, status: 'complete', total: 1,
      rows: [{ workItemId: 'WI-77', batchSha: SHA_A, authorId: 'su-author-1',
        filingRef: 'engineer_issues:WI-77', redFiledAtMs: NOW,
        wakes: [{ ref: 'event_wake_deliveries:42', workItemId: 'WI-77', recipientId: 'su-author-1',
          queuedAtMs: NOW + 100, deliveredAtMs: NOW + 200,
          turnStartedAtMs: NOW + delayMs, turnProof: 'observed' }] }] };
  }
  it('accepts exact 900000ms original pickup and rejects 900001ms (independent fixed boundary)', () => {
    expect(evaluateSyncRedDeliveryWindow(history())).toMatchObject({ verdict: 'healthy',
      rows: [{ elapsedMs: 900_000, verdict: 'healthy' }] });
    expect(evaluateSyncRedDeliveryWindow(history(900_001))).toMatchObject({ verdict: 'broken',
      rows: [{ elapsedMs: 900_001, verdict: 'broken' }] });
  });
  it.each(['queued-only', 'delivered-without-pickup', 'coalesced', 'wrong-author', 'wrong-item',
    'missing-filing-clock', 'missing-queue-clock', 'reversed-clock', 'future-pickup', 'missing-batch'])(
    'never turns %s into delivery proof', defect => {
      const h = history(), r = h.rows[0]!, w = r.wakes[0]!;
      if (defect === 'queued-only') { w.deliveredAtMs = null; w.turnStartedAtMs = null; }
      if (defect === 'delivered-without-pickup') w.turnStartedAtMs = null;
      if (defect === 'coalesced') w.turnProof = 'superseded';
      if (defect === 'wrong-author') w.recipientId = 'su-other';
      if (defect === 'wrong-item') w.workItemId = 'WI-other';
      if (defect === 'missing-filing-clock') r.redFiledAtMs = Number.NaN;
      if (defect === 'missing-queue-clock') w.queuedAtMs = Number.NaN;
      if (defect === 'reversed-clock') w.turnStartedAtMs = w.queuedAtMs - 1;
      if (defect === 'future-pickup') w.turnStartedAtMs = h.observedAtMs + 1;
      if (defect === 'missing-batch') r.batchSha = null;
      expect(evaluateSyncRedDeliveryWindow(h).verdict).toBe('unknown');
    });
  it.each(['capped', 'unavailable', 'wrong-total', 'empty', 'duplicate', 'future-window'])(
    'never passes an incomplete %s population', defect => {
      const h = history();
      if (defect === 'capped' || defect === 'unavailable') h.status = defect;
      if (defect === 'wrong-total') h.total = 2;
      if (defect === 'empty') { h.rows = []; h.total = 0; }
      if (defect === 'duplicate') { h.rows.push(structuredClone(h.rows[0]!)); h.total = 2; }
      if (defect === 'future-window') h.windowEndMs = h.observedAtMs + 1;
      expect(evaluateSyncRedDeliveryWindow(h).verdict).toBe('unknown');
    });
  it('retains missing/manual wakes and measured late pickup across the whole population', () => {
    const h = history();
    h.rows.push({ ...structuredClone(h.rows[0]!), workItemId: 'WI-missing',
      filingRef: 'engineer_issues:WI-missing', wakes: [] });
    h.total = 2;
    expect(evaluateSyncRedDeliveryWindow(h)).toMatchObject({ verdict: 'unknown',
      rows: [{ verdict: 'healthy' }, { workItemId: 'WI-missing', verdict: 'unknown' }] });
    h.rows[0]!.wakes[0]!.turnStartedAtMs = NOW + 900_001;
    expect(evaluateSyncRedDeliveryWindow(h)).toMatchObject({ verdict: 'broken',
      rows: [{ verdict: 'broken' }, { verdict: 'unknown' }] });
  });
  it('uses earliest proven pickup among retries, never the earliest queue or current activity', () => {
    const h = history(900_001), row = h.rows[0]!;
    row.wakes.unshift({ ...row.wakes[0]!, ref: 'event_wake_deliveries:41',
      queuedAtMs: NOW, deliveredAtMs: null, turnStartedAtMs: null, turnProof: 'awaiting' });
    expect(evaluateSyncRedDeliveryWindow(h).verdict).toBe('broken');
    row.wakes.push({ ...row.wakes[1]!, ref: 'event_wake_deliveries:43', turnStartedAtMs: NOW + 899_999 });
    expect(evaluateSyncRedDeliveryWindow(h)).toMatchObject({ verdict: 'healthy', rows: [{ elapsedMs: 899_999 }] });
  });
  it('records the same clocked verdict through the native executor with its input pinned before yielding', async () => {
    const h = history(900_001);
    const run = executeSyncRedDeliveryWindow(h, { projectDir: '/r', runtimeUnits: ['original-reader'] });
    h.rows[0]!.wakes[0]!.turnStartedAtMs = NOW + 1000;
    expect(await run).toMatchObject({ exitCode: 1, assertions: expect.arrayContaining([
      { id: 'author-delivery-at-most-15min', passed: false, evidence: expect.stringContaining('verdict=broken') },
    ]) });
    expect(captured.operationalRuns.at(-1)?.scope).toMatchObject({ workspaceId: 'ws-1', harnessSlug: 'h' });
  });
  it('keeps a recorded not-picked-up outcome broken after 15 minutes', () => {
    const h = history(), w = h.rows[0]!.wakes[0]!;
    w.turnProof = 'not-picked-up'; w.turnStartedAtMs = null;
    expect(evaluateSyncRedDeliveryWindow(h)).toMatchObject({ verdict: 'broken', rows: [{ verdict: 'broken' }] });
  });
});

function batch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return { sha: SHA_C, committedAtMs: NOW - 60_000, agent: 'su-trailer', paths: ['packages/foo/src/a.ts'], ...overrides };
}

function fakeDeps(overrides: Partial<SyncBatchDeltaDeps> = {}, cursor: SyncDeltaCursor | null = null) {
  const state = { cursor, filed: [] as RedFinding[], logs: [] as string[], confirms: 0 };
  const deps: SyncBatchDeltaDeps = {
    readCursor: async () => state.cursor,
    writeCursor: async (n) => {
      state.cursor = n;
    },
    hostLoad: () => ({ load1: 2, cores: 128 }),
    greenCheckpointRunning: async () => false,
    headSha: async () => SHA_B,
    listBatches: async () => [batch()],
    probeRadius: async () => ({
      workspaces: ['foo'],
      guards: [],
      taskCommands: [{ workspace: 'foo', command: 'npm run test' }],
      derivation: null,
    }),
    runAffected: async () => ({ ok: true, failing: [] }),
    runTsc: async () => ({ ok: true, failing: [] }),
    confirmOne: async () => {
      state.confirms += 1;
      return false;
    },
    fileRed: async (f) => {
      state.filed.push(f);
      return { ok: true, id: `WI-${state.filed.length}` };
    },
    now: () => NOW,
    log: (m) => state.logs.push(m),
    ...overrides,
  };
  return { deps, state };
}

function ticks(n: number, evaluated: boolean): CoverageTick[] {
  return Array.from({ length: n }, (_, i) => ({
    atMs: NOW - (i + 1) * 60_000,
    evaluated,
    status: evaluated ? ('green' as const) : ('skipped' as const),
  }));
}

describe('evaluateCapacity (R-1; green-main-ratchet P-009 R-8)', () => {
  it('runs the full budget below the soft band with no gate running', () => {
    const v = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(v).toEqual({ mode: 'full', budget: FULL });
  });

  it('the soft load band reduces the budget instead of skipping', () => {
    const v = evaluateCapacity({ reading: { load1: 200, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(v.mode).toBe('reduced');
    expect(v.budget).toEqual(REDUCED_BUDGET);
  });

  it('a running gate reduces the budget; an undetectable gate (null) does not', () => {
    const running = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: true, fullBudget: FULL });
    expect(running).toMatchObject({ mode: 'reduced', reason: 'green-checkpoint-running' });
    const unknown = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: null, fullBudget: FULL });
    expect(unknown).toMatchObject({ mode: 'full' });
  });

  // R-8 falsifier (1): no load condition may skip the check. Before P-009 these two
  // cases returned { skip: true }; the measured lint-guard skip was load 384.91 > 384.
  it('never skips: the hard ceiling and an unreadable load only reduce the budget, and say why', () => {
    const hard = evaluateCapacity({ reading: { load1: 384.91, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(hard).not.toHaveProperty('skip');
    expect(hard.mode).toBe('reduced');
    expect(hard.budget).toEqual(REDUCED_BUDGET);
    expect(hard.reason).toMatch(/hard ceiling 384\.00/);
    const blind = evaluateCapacity({ reading: null, gateRunning: true, fullBudget: FULL });
    expect(blind).toEqual({
      mode: 'reduced',
      reason: 'host-load-unreadable; green-checkpoint-running',
      budget: REDUCED_BUDGET,
    });
  });

  it('never raises a caller budget that is already below the reduced one', () => {
    const v = evaluateCapacity({
      reading: { load1: 10, cores: 128 },
      gateRunning: true,
      fullBudget: { maxConfirmRuns: 0, maxAttributionProbes: 1 },
    });
    expect(v).toMatchObject({ budget: { maxConfirmRuns: 0, maxAttributionProbes: 1 } });
  });
});

describe('runSyncBatchDeltaCheck under load (R-1)', () => {
  it('judges the window in the soft band, spending at most the reduced confirm budget', async () => {
    const failing = [
      { workspace: 'foo', file: 'packages/foo/src/a.test.ts' },
      { workspace: 'foo', file: 'packages/foo/src/b.test.ts' },
    ];
    const { deps, state } = fakeDeps(
      {
        hostLoad: () => ({ load1: 200, cores: 128 }),
        listBatches: async () => [batch({ sha: SHA_B })],
        runAffected: async () => ({ ok: false, failing }),
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).not.toBe('skipped');
    expect(state.confirms).toBe(REDUCED_BUDGET.maxConfirmRuns);
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  // R-8 falsifier (1), end to end: above the hard ceiling and with an unreadable load
  // the tick still judges its window and advances the cursor.
  it.each([
    ['above the hard ceiling', () => ({ load1: 10_000, cores: 128 })],
    ['with an unreadable load', () => null],
  ])('judges the window %s instead of skipping', async (_label, hostLoad) => {
    const { deps, state } = fakeDeps({ hostLoad }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.sha).toBe(SHA_C);
    expect(state.cursor?.coverage?.ticks.at(-1)).toMatchObject({ evaluated: true, status: 'green' });
    expect(state.logs.some((m) => /reduced budget/.test(m))).toBe(true);
  });
});

describe('reserved-capacity legs (green-main-ratchet P-009 / D-017)', () => {
  it('reservedCapacityArgv runs the payload in source-checks.slice at the default weights', () => {
    expect(reservedCapacityArgv('node', ['x.mjs', '--a'])).toEqual({
      cmd: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--property=CollectMode=inactive-or-failed',
        `--slice=${SOURCE_CHECK_SLICE}`,
        '--property=CPUWeight=100',
        '--property=IOWeight=100',
        '--',
        'node',
        'x.mjs',
        '--a',
      ],
    });
    // A dash would nest it under papercusp.slice (CPUWeight=25): the slice must be top-level.
    expect(SOURCE_CHECK_SLICE).toBe('source-checks.slice');
  });

  it('every heavy leg spawns in the reserved slice; the millisecond git/proc-guard reads do not', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = async (cmd: string, args: string[]): Promise<RunResult | null> => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '', durationMs: 10 };
    };
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'w', root: '/r', branch: 'staging', exec });
    await deps.probeRadius(['a.ts']);
    await deps.runAffected(['a.ts']);
    await deps.runTsc(['a.ts']);
    await deps.confirmOne('a.test.ts');
    const heavy = calls.splice(0);
    expect(heavy).toHaveLength(4);
    for (const c of heavy) {
      expect(c.cmd).toBe('systemd-run');
      expect(c.args).toContain(`--slice=${SOURCE_CHECK_SLICE}`);
      expect(c.args[c.args.indexOf('--') + 1]).toBe('node');
    }
    const affectedRun = heavy.find(
      (c) => c.args.includes('--changed-paths') && !c.args.includes('--print-affected'),
    );
    expect(affectedRun?.args).toContain('--related');
    // D-030: the probe narrows exactly as the run does, so its AFFECTED_ETA projects the run
    // that would actually execute rather than every selected suite in full.
    const probeRun = heavy.find((c) => c.args.includes('--print-affected'));
    expect(probeRun?.args).toContain('--related');
    await deps.headSha();
    await deps.greenCheckpointRunning();
    expect(calls.map((c) => c.cmd)).toEqual(['git', 'node']);
  });

  it('the lint guards run in the reserved slice too', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = async (cmd: string, args: string[]): Promise<RunResult | null> => {
      calls.push({ cmd, args });
      return { status: 0, stdout: 'clean', stderr: '', durationMs: 10 };
    };
    const deps = buildSyncLintGuardDeps({ installSlug: 'h', workspaceId: 'w', root: '/r', branch: 'staging', exec });
    const run = await deps.runGuard('lint:no-control-bytes');
    expect(run.exitCode).toBe(0);
    expect(calls).toEqual([{ cmd: 'systemd-run', args: reservedCapacityArgv('npm', ['run', '--silent', 'lint:no-control-bytes']).args }]);
  });

  it('falls back to an unwrapped run, with a diagnostic, when the scope cannot start', async () => {
    const calls: string[] = [];
    const exec = async (cmd: string): Promise<RunResult | null> => {
      calls.push(cmd);
      if (cmd === 'systemd-run') {
        return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found\n', durationMs: 40 };
      }
      return { status: 0, stdout: 'ok', stderr: '', durationMs: 900 };
    };
    const r = await runReservedArgv(exec, 'node', ['x.mjs'], { cwd: '/r', timeoutMs: 1000 });
    expect(calls).toEqual(['systemd-run', 'node']);
    expect(r).toMatchObject({ status: 0, stdout: 'ok' });
    expect(r?.stderr).toMatch(/reserved slice unavailable \(exit 1: Failed to connect to bus/);
    // A missing systemd-run binary (unmeasurable spawn) falls back too.
    const missing: string[] = [];
    const r2 = await runReservedArgv(
      async (cmd) => {
        missing.push(cmd);
        return cmd === 'systemd-run' ? null : { status: 0, stdout: '', stderr: '' };
      },
      'node',
      [],
      { cwd: '/r', timeoutMs: 1000 },
    );
    expect(missing).toEqual(['systemd-run', 'node']);
    expect(r2?.stderr).toMatch(/systemd-run could not be spawned/);
  });

  it('never re-runs a payload that failed INSIDE a healthy scope', async () => {
    const calls: string[] = [];
    const exec = async (cmd: string): Promise<RunResult | null> => {
      calls.push(cmd);
      // ENOENT text from the payload, but well past the launch window: a real red.
      return { status: 1, stdout: '', stderr: 'Error: No such file or directory', durationMs: 60_000 };
    };
    const r = await runReservedArgv(exec, 'node', ['x.mjs'], { cwd: '/r', timeoutMs: 120_000 });
    expect(calls).toEqual(['systemd-run']);
    expect(r?.status).toBe(1);
    expect(isScopeLaunchFailure({ status: 1, stderr: 'Failed to start transient scope', durationMs: 50 })).toBe(true);
    expect(isScopeLaunchFailure({ status: 1, stderr: 'Failed to start transient scope', durationMs: 5_000 })).toBe(false);
    expect(isScopeLaunchFailure({ status: 0, stderr: 'Failed to connect to bus' })).toBe(false);
    expect(isScopeLaunchFailure({ status: null, stderr: 'x', failureKind: 'timeout' })).toBe(false);
  });
});

describe('coverage record + alarm (R-2)', () => {
  it('recordCoverageTick appends and drops ticks older than the retention window', () => {
    const old = { atMs: NOW - 25 * 60 * 60_000, evaluated: true, status: 'green' as const };
    const next = recordCoverageTick({ ticks: [old] }, { atMs: NOW, evaluated: false, status: 'skipped' });
    expect(next.ticks).toEqual([{ atMs: NOW, evaluated: false, status: 'skipped' }]);
  });

  it('too few samples is NOT an alarm (ratio null), never a false low', () => {
    const v = evaluateCoverage({ ticks: ticks(COVERAGE_ALARM_MIN_TICKS - 1, false) }, NOW);
    expect(v).toMatchObject({ ratio: null, low: false });
  });

  it('counts missed five-minute opportunities around a long action and raises the coverage alarm', async () => {
    const startedAt = NOW;
    const completedAt = NOW + 30 * 60_000;
    // 133 judged slots of history ending 30 min before this run: with the 11 slots
    // below that is exactly COVERAGE_ALARM_MIN_TICKS (144), 133/144 = 92% < 95%.
    const history: CoverageTick[] = Array.from({ length: 133 }, (_, i) => ({
      atMs: NOW - 30 * 60_000 - (132 - i) * 5 * 60_000,
      evaluated: true,
      status: 'green' as const,
    }));
    const { deps, state } = fakeDeps(
      {
        headSha: async () => null, // git unreadable: a skipped, unevaluated run
        now: (() => {
          const times = [startedAt, completedAt, completedAt];
          let index = 0;
          return () => times[Math.min(index++, times.length - 1)]!;
        })(),
      },
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: history } },
    );

    await runSyncBatchDeltaCheck(deps);

    const coverage = state.cursor?.coverage;
    expect(coverage?.ticks.filter((tick) => tick.status === 'missed-opportunity')).toHaveLength(10);
    expect(coverage?.ticks.filter((tick) => tick.evaluated)).toHaveLength(133);
    expect(evaluateCoverage(coverage, completedAt)).toMatchObject({ low: true, evaluated: 133, total: 144 });
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]?.conditionKey).toBe(COVERAGE_ALARM_CONDITION_KEY);
    expect(state.filed[0]?.title).toMatch(/over 24h$/);
  });

  it('files ONE condition-keyed alarm when coverage drops, dedups the next tick, clears on recovery', async () => {
    const { deps, state } = fakeDeps(
      { headSha: async () => null }, // every tick skips (git unreadable) → unevaluated
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: ticks(COVERAGE_ALARM_MIN_TICKS, false) } },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]?.conditionKey).toBe(COVERAGE_ALARM_CONDITION_KEY);
    expect(state.cursor?.coverage?.alarmOpenSinceMs).toBe(NOW);

    await runSyncBatchDeltaCheck(deps); // still low — must not re-file
    expect(state.filed).toHaveLength(1);

    // Recovery: a window of judged five-minute slots and a judged run clear the alarm state.
    const judged: CoverageTick[] = Array.from({ length: COVERAGE_ALARM_MIN_TICKS + 1 }, (_, i) => ({
      atMs: NOW - (COVERAGE_ALARM_MIN_TICKS + 1 - i) * 5 * 60_000,
      evaluated: true,
      status: 'green' as const,
    }));
    state.cursor = {
      sha: SHA_A,
      updatedAtMs: 1,
      coverage: { alarmOpenSinceMs: NOW - 1, ticks: judged },
    };
    deps.headSha = async () => SHA_B;
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.coverage?.alarmOpenSinceMs).toBeUndefined();
    expect(state.cursor?.coverage?.ticks.at(-1)).toMatchObject({ atMs: NOW, evaluated: true });
  });
});

// green-main-ratchet-convergence-2026-10-17 P-009, R-8 falsifier (2): coverage is computed
// per schedule slot over 24h at a 95% target, crediting a slot whose commits a later run
// judged within the derived deadline (D-031: 2 x one run's leg budget + the slot interval),
// and never crediting slots whose commits nobody judged.
describe('slot coverage with late-judgment crediting (P-009 / D-017 / D-031)', () => {
  const MIN = 60_000;
  const D = COVERAGE_JUDGE_DEADLINE_MS;
  const slot = (atMs: number, status: CoverageTick['status'], evaluated = false): CoverageTick => ({ atMs, evaluated, status });

  it('pins the target: 24h window, 95%, 144-slot minimum', () => {
    expect(COVERAGE_ALARM_WINDOW_MS).toBe(24 * 60 * MIN);
    expect(COVERAGE_ALARM_THRESHOLD).toBe(0.95);
    expect(COVERAGE_ALARM_MIN_TICKS).toBe(144);
  });

  it('derives the judge deadline from the run legs: 2 x (probe + tsc + affected) + interval (D-031)', () => {
    const { probe, tsc, affected } = SYNC_DELTA_TIMEOUTS_MS;
    expect(SYNC_DELTA_RUN_BUDGET_MS).toBe(probe + tsc + affected);
    expect(COVERAGE_JUDGE_DEADLINE_MS).toBe(2 * (probe + tsc + affected) + COVERAGE_EXPECTED_INTERVAL_MS);
    // Today's budgets: 10 + 10 + 25 min per run, so 95 min. A fixed number here would let the
    // leg budgets move without the deadline (the D-030 #3 defect), so the literal is a tripwire.
    expect(COVERAGE_JUDGE_DEADLINE_MS).toBe(95 * MIN);
    // The property that matters: a slot arriving just after a run starts is judged by the NEXT
    // in-budget run, which ends within one run + one interval + one run.
    expect(SYNC_DELTA_RUN_BUDGET_MS + COVERAGE_EXPECTED_INTERVAL_MS + SYNC_DELTA_RUN_BUDGET_MS).toBeLessThanOrEqual(D);
  });

  it('credits only skipped/missed slots at or before the judged point and within the deadline', () => {
    const judgedAtMs = NOW;
    const coverage = {
      ticks: [
        slot(NOW - D - 10 * MIN, 'missed-opportunity'), // judged 10 min past the deadline: too late
        slot(NOW - D, 'skipped'), // exactly the deadline: credited
        slot(NOW - 25 * MIN, 'leg-timeout'), // cursor advanced past it unjudged: never
        slot(NOW - 20 * MIN, 'radius-too-wide'), // likewise never
        slot(NOW - 15 * MIN, 'missed-opportunity'), // credited
        slot(NOW - 10 * MIN, 'green', true), // already its own judgment: untouched
        slot(NOW - 5 * MIN, 'missed-opportunity'), // after the judged point: not credited
      ],
    };
    const out = creditLateJudgedSlots(coverage, { throughMs: NOW - 8 * MIN, judgedAtMs });
    expect(out.ticks.map((t) => [t.status, t.evaluated, t.judgedAtMs ?? null])).toEqual([
      ['missed-opportunity', false, null],
      ['skipped', true, NOW],
      ['leg-timeout', false, null],
      ['radius-too-wide', false, null],
      ['missed-opportunity', true, NOW],
      ['green', true, null],
      ['missed-opportunity', false, null],
    ]);
    // Pure: the input is not mutated, and nothing to credit returns the same object.
    expect(coverage.ticks[1]!.evaluated).toBe(false);
    const none = { ticks: [slot(NOW - D - MIN, 'skipped')] };
    expect(creditLateJudgedSlots(none, { throughMs: NOW, judgedAtMs: NOW })).toBe(none);
  });

  it('evaluateCoverage judges 95% over the trailing 24h and reports late credits', () => {
    const day = (evaluatedCount: number): CoverageTick[] =>
      Array.from({ length: 288 }, (_, i) => ({
        atMs: NOW - i * 5 * MIN,
        evaluated: i < evaluatedCount,
        status: i < evaluatedCount ? ('green' as const) : ('missed-opportunity' as const),
        ...(i < 10 ? { judgedAtMs: NOW } : {}),
      }));
    expect(evaluateCoverage({ ticks: day(274) }, NOW)).toMatchObject({ total: 288, evaluated: 274, low: false });
    expect(evaluateCoverage({ ticks: day(273) }, NOW)).toMatchObject({ total: 288, evaluated: 273, low: true });
    expect(evaluateCoverage({ ticks: day(274) }, NOW).lateCredited).toBe(10);
    // Slots older than 24h fall out of the window.
    const old = { ticks: [...day(288), slot(NOW - 25 * 60 * MIN, 'missed-opportunity')] };
    expect(evaluateCoverage(old, NOW)).toMatchObject({ total: 288, ratio: 1 });
  });

  /** A tick whose deps.now() returns `startedAt` first and `completedAt` afterwards. */
  function clock(startedAt: number, completedAt: number): () => number {
    let first = true;
    return () => {
      if (first) {
        first = false;
        return startedAt;
      }
      return completedAt;
    };
  }

  // The slots a long previous run left as missed-opportunity during its own execution.
  const leftBehind = (): CoverageTick[] => [
    slot(NOW - 20 * MIN, 'green', true),
    slot(NOW - 15 * MIN, 'missed-opportunity'),
    slot(NOW - 10 * MIN, 'missed-opportunity'),
    slot(NOW - 5 * MIN, 'missed-opportunity'),
  ];

  it('a later run that judged the whole backlog credits the slots it reached within the deadline', async () => {
    // Finishes D - 5 min after start, so the NOW-5 slot is judged exactly D after it arrived.
    const end = NOW + COVERAGE_JUDGE_DEADLINE_MS - 5 * MIN;
    const { deps, state } = fakeDeps(
      { now: clock(NOW, end) },
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: leftBehind() } },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res).toMatchObject({ status: 'green', judgedThrough: 'start' });
    const t = state.cursor?.coverage?.ticks ?? [];
    const at = (ms: number) => t.find((x) => x.atMs === ms);
    expect(at(NOW - 5 * MIN)).toMatchObject({ status: 'missed-opportunity', evaluated: true, judgedAtMs: end });
    expect(at(NOW - 10 * MIN)).toMatchObject({ evaluated: false });
    expect(at(NOW - 15 * MIN)).toMatchObject({ evaluated: false });
    // Slots that passed DURING this run were not judged by it.
    expect(t.filter((x) => x.atMs > NOW && x.status === 'missed-opportunity').every((x) => !x.evaluated)).toBe(true);
    expect(evaluateCoverage(state.cursor?.coverage, end).lateCredited).toBe(1);
  });

  it('a normal in-budget run credits the slots it left behind (the old fixed 30 min did not, D-031)', async () => {
    // A 22-minute run (probe ~4 min + affected ~18 min, inside the leg budgets) that judged a
    // backlog the previous ~20-minute run left behind: NOW-15 is judged 37 min after it arrived.
    const { deps, state } = fakeDeps(
      { now: clock(NOW, NOW + 22 * MIN) },
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: leftBehind() } },
    );
    await runSyncBatchDeltaCheck(deps);
    const credited = (state.cursor?.coverage?.ticks ?? []).filter((x) => x.judgedAtMs !== undefined);
    expect(credited.map((x) => x.atMs)).toEqual([NOW - 15 * MIN, NOW - 10 * MIN, NOW - 5 * MIN]);
  });

  it('a quick later run credits every left-behind slot', async () => {
    const { deps, state } = fakeDeps(
      { now: clock(NOW, NOW + 4 * MIN) },
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: leftBehind() } },
    );
    await runSyncBatchDeltaCheck(deps);
    const credited = (state.cursor?.coverage?.ticks ?? []).filter((x) => x.judgedAtMs !== undefined);
    expect(credited.map((x) => x.atMs)).toEqual([NOW - 15 * MIN, NOW - 10 * MIN, NOW - 5 * MIN]);
  });

  it('a run that left backlog behind credits only slots up to its newest judged commit', async () => {
    const { deps, state } = fakeDeps(
      {
        now: clock(NOW, NOW + 4 * MIN),
        // Newest first: the window cap of 1 judges only the older commit (committed NOW-12m).
        listBatches: async () => [
          batch({ sha: SHA_B, committedAtMs: NOW - 1 * MIN }),
          batch({ sha: SHA_C, committedAtMs: NOW - 12 * MIN }),
        ],
      },
      { sha: SHA_A, updatedAtMs: 1, windowCommitCap: 1, coverage: { ticks: leftBehind() } },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res).toMatchObject({ status: 'green', judgedThrough: NOW - 12 * MIN });
    expect(state.cursor?.sha).toBe(SHA_C);
    const credited = (state.cursor?.coverage?.ticks ?? []).filter((x) => x.judgedAtMs !== undefined);
    expect(credited.map((x) => x.atMs)).toEqual([NOW - 15 * MIN]);
  });

  it('an unevaluated run credits nothing', async () => {
    const { deps, state } = fakeDeps(
      { now: clock(NOW, NOW + 4 * MIN), headSha: async () => null },
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: leftBehind() } },
    );
    await runSyncBatchDeltaCheck(deps);
    expect((state.cursor?.coverage?.ticks ?? []).some((x) => x.judgedAtMs !== undefined)).toBe(false);
  });

  it('the alarm reports the 24h window, the 95% target and the late-credit count', () => {
    const coverage = { ticks: Array.from({ length: 150 }, (_, i) => slot(NOW - i * 5 * MIN, 'missed-opportunity')) };
    const verdict = evaluateCoverage(coverage, NOW);
    const alarm = buildCoverageAlarm(verdict, coverage);
    expect(alarm.conditionKey).toBe(COVERAGE_ALARM_CONDITION_KEY);
    expect(alarm.title).toBe('sync-batch delta check coverage low: 0% of schedule slots judged over 24h');
    expect(alarm.body).toMatch(/below the 95% target/);
    // The alarm states the subject's own deadline: 95 min for the delta check (D-031).
    expect(alarm.body).toMatch(/within 95m \(0 of the judged slots/);
  });
});

describe('author routing (R-3)', () => {
  const hit = (file: string, agent: string, tsMs: number): EditorHit => ({ file, agent, tsMs });

  it('prefers the newest editor of the failing file, then of the batch, then the trailer', () => {
    const b = batch({ paths: ['packages/foo/src/a.ts', 'packages/foo/src/b.ts'] });
    expect(
      pickRedAuthor({
        failingFile: 'packages/foo/src/a.ts',
        batch: b,
        editors: [hit('packages/foo/src/a.ts', 'su-old', 1), hit('packages/foo/src/a.ts', 'su-new', 2), hit('packages/foo/src/b.ts', 'su-b', 3)],
      }),
    ).toEqual({ agent: 'su-new', source: 'edit-ledger:failing-file' });
    expect(
      pickRedAuthor({ failingFile: 'packages/foo/src/a.test.ts', batch: b, editors: [hit('packages/foo/src/b.ts', 'su-b', 3)] }),
    ).toEqual({ agent: 'su-b', source: 'edit-ledger:batch' });
    expect(pickRedAuthor({ failingFile: 'x.ts', batch: b, editors: null })).toEqual({ agent: 'su-trailer', source: 'trailer' });
  });

  it('never routes to a system identity, and says so when nobody is attributable', () => {
    const b = batch({ agent: 'system:git-sync' });
    expect(
      pickRedAuthor({ failingFile: 'packages/foo/src/a.ts', batch: b, editors: [hit('packages/foo/src/a.ts', 'system:hook', 9)] }),
    ).toEqual({ agent: null, source: 'none' });
  });

  it('end to end: a seeded type error in a sync batch files a fix-it assigned to the editing agent', async () => {
    const lookups: Array<{ files: readonly string[]; sinceMs: number }> = [];
    const { deps, state } = fakeDeps(
      {
        runTsc: async () => ({ ok: false, failing: ['packages/foo/src/a.ts'] }),
        lookupEditors: async (files, sinceMs) => {
          lookups.push({ files, sinceMs });
          return [hit('packages/foo/src/a.ts', 'su-author-1', NOW - 90_000)];
        },
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    const finding = state.filed.find((f) => f.conditionKey !== COVERAGE_ALARM_CONDITION_KEY);
    expect(finding?.assignee).toBe('su-author-1');
    expect(finding?.authorSource).toBe('edit-ledger:failing-file');
    expect(finding?.body).toContain('su-author-1');
    expect(lookups[0]?.files).toContain('packages/foo/src/a.ts');
    expect(lookups[0]!.sinceMs).toBeLessThan(NOW - 60_000); // window opens before the batch commit
  });

  it('a refused assignment re-files the red unassigned instead of losing it', async () => {
    const seen: RedFinding[] = [];
    const logs: string[] = [];
    const res = await fileRoutedRed(
      {
        fileRed: async (f) => {
          seen.push(f);
          return f.assignee ? { ok: false, error: 'assignee_unresolvable' } : { ok: true, id: 'WI-9' };
        },
        log: (m) => logs.push(m),
      },
      { title: 't', body: 'b', conditionKey: 'k', paths: [], assignee: 'su-gone', authorSource: 'trailer' } as unknown as RedFinding,
    );
    expect(res).toEqual({ ok: true, id: 'WI-9' });
    expect(seen.map((f) => f.assignee)).toEqual(['su-gone', null]);
    expect(logs.join('\n')).toMatch(/refused/);
  });

  it('the IO binding reads the attribution ledger scoped to the workspace, and files with assign_to', async () => {
    captured.sqlCalls.length = 0;
    captured.createArgs.length = 0;
    captured.sqlRows = [{ file: 'packages/foo/src/a.ts', agent_id: 'su-author-1', ts: new Date(NOW).toISOString() }];
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    const hits = await deps.lookupEditors!(['packages/foo/src/a.ts'], NOW - 1000);
    expect(hits).toEqual([{ file: 'packages/foo/src/a.ts', agent: 'su-author-1', tsMs: NOW }]);
    const q = captured.sqlCalls[0]!;
    expect(q.text).toContain('harness_shared.edit_attribution_ledger');
    expect(q.text).not.toMatch(/git blame/);
    expect(q.values).toContain('ws-1');

    await deps.fileRed({
      title: 't',
      body: 'b',
      conditionKey: 'k',
      paths: ['packages/foo/src/a.ts'],
      assignee: 'su-author-1',
      authorSource: 'edit-ledger:failing-file',
    } as unknown as RedFinding);
    await deps.fileRed({ title: 't', body: 'b', conditionKey: 'k2', paths: [], assignee: null, authorSource: 'none' } as unknown as RedFinding);
    expect(captured.createArgs[0]?.assign_to).toBe('su-author-1');
    expect('assign_to' in (captured.createArgs[1] ?? {})).toBe(false);
  });

  it.each([
    ['typecheck delta', buildSyncBatchDeltaDeps],
    ['lint guard', buildSyncLintGuardDeps],
  ] as const)('%s notifies the actual filed owner and queues the existing required-wake path (P037)', async (_leg, buildDeps) => {
    captured.messages.length = captured.wakes.length = 0;
    captured.messagePersisted = captured.notificationFails = false;
    captured.notificationAssignee = 'su-current-holder';
    captured.wakeQueued = 1;
    const deps = buildDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    const finding: RedFinding = { title: 'guard red', body: 'fix the measured red', conditionKey: 'guard:k',
      paths: ['src/timer.ts'], assignee: 'su-author-1', authorSource: 'edit-ledger:failing-file' };
    expect(await deps.fileRed(finding)).toMatchObject({ ok: true, id: 'WI-77', assignee: 'su-current-holder' });
    expect(captured.messages[0]).toMatchObject({ to: ['su-current-holder'], files: ['src/timer.ts'] });
    expect(captured.messages[0]?.msgId).toBe(
      `${_leg === 'lint guard' ? 'sync-lint-red' : 'sync-delta-red'}:ws-1:WI-77`,
    );
    expect(captured.wakes[0]).toMatchObject({ targets: ['su-current-holder'],
      options: { requiredWake: true, workspaceId: 'ws-1', payload: { workItemId: 'WI-77' } } });
    captured.wakeQueued = 0;
    expect(await deps.fileRed(finding)).toMatchObject({ ok: true, id: 'WI-77',
      assignee: 'su-current-holder', notificationError: expect.any(String) });
    captured.wakeQueued = 1;
    captured.notificationAssignee = 'su-author-1';
  });

  it.each([
    ['typecheck delta', buildSyncBatchDeltaDeps, 'notification-store'],
    ['typecheck delta', buildSyncBatchDeltaDeps, 'wake-miss'],
    ['lint guard', buildSyncLintGuardDeps, 'notification-store'],
    ['lint guard', buildSyncLintGuardDeps, 'wake-miss'],
  ] as const)('preserves the attributed red across each owner-notification retry', async (_leg, buildDeps, failure) => {
    captured.messages.length = captured.wakes.length = 0;
    captured.messagePersisted = false;
    captured.notificationFails = failure === 'notification-store';
    captured.notificationAssignee = 'su-author-1';
    captured.wakeQueued = failure === 'wake-miss' ? 0 : 1;
    const deps = buildDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    const finding: RedFinding = { title: 'guard red', body: 'measured red', conditionKey: 'guard:k',
      paths: ['src/timer.ts'], assignee: 'su-author-1', authorSource: 'edit-ledger:failing-file' };
    const result = await deps.fileRed(finding);
    expect(result).toMatchObject({ ok: true, id: 'WI-77', notificationError: expect.any(String) });
    captured.notificationFails = false;
    captured.wakeQueued = 1;
    expect(await deps.fileRed(finding)).not.toHaveProperty('notificationError');
    expect(captured.messages).toHaveLength(1);
    expect(captured.wakes.at(-1)?.targets).toEqual(['su-author-1']);
  });

  it('notifies an adopted incumbent holder even when the new finding is unattributed', async () => {
    captured.messages.length = captured.wakes.length = 0;
    captured.messagePersisted = captured.notificationFails = false;
    captured.notificationAssignee = 'su-current-holder';
    captured.wakeQueued = 1;
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    const result = await deps.fileRed({ title: 'unattributed red', body: 'measured red', conditionKey: 'guard:k',
      paths: ['src/timer.ts'], assignee: null, authorSource: 'none' });
    expect(result).toMatchObject({ ok: true, id: 'WI-77', assignee: 'su-current-holder' });
    expect(captured.messages).toHaveLength(1);
    expect(captured.messages[0]).toMatchObject({ to: ['su-current-holder'] });
    expect(captured.wakes).toHaveLength(1);
  });

  it('production deps persist the discovered typecheck leg/owner and retry it at the same HEAD', async () => {
    const file = 'packages/foo/src/type-error.ts';
    const state = { cursor: { sha: SHA_A, updatedAtMs: 1 } as SyncDeltaCursor | null };
    const tscCalls: string[][] = [];
    captured.messages.length = captured.wakes.length = captured.createArgs.length = 0;
    captured.messagePersisted = captured.notificationFails = false;
    captured.notificationAssignee = 'su-current-holder';
    captured.wakeQueued = 0; // first tick misses the required wake

    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging',
      exec: async () => ({ status: 0, stdout: '', stderr: '' }) });
    deps.hostLoad = () => ({ load1: 2, cores: 128 });
    deps.greenCheckpointRunning = async () => false;
    // The fixture's commits are dated relative to NOW; on the wall clock they would be a
    // decades-old backlog, which the stale-backlog rule skips (WI-6554700010018028).
    deps.now = () => NOW;
    deps.headSha = async () => SHA_B;
    deps.readCursor = async () => JSON.parse(JSON.stringify(state.cursor)) as SyncDeltaCursor | null;
    deps.writeCursor = async next => { state.cursor = JSON.parse(JSON.stringify(next)) as SyncDeltaCursor; };
    deps.listBatches = async () => [batch({ sha: SHA_B, paths: [file] })];
    deps.probeRadius = async () => ({
      workspaces: ['foo'],
      guards: [],
      taskCommands: [{ workspace: 'foo', command: 'npm run test' }],
      derivation: null,
    });
    deps.runTsc = async files => {
      tscCalls.push([...files]);
      return { ok: false, failing: [file], diagnostic: { outcome: 'nonzero-exit' as const, durationMs: 1, exitCode: 2 } };
    };
    deps.runAffected = async () => ({
      ok: true,
      failing: [],
      diagnostic: { outcome: 'completed' as const, durationMs: 1, exitCode: 0 },
    });
    deps.lookupEditors = async () => [{ file, agent: 'su-author-1', tsMs: NOW }];
    deps.confirmOne = async () => { throw new Error('typecheck-held retry must not use confirmOne'); };

    const first = await runSyncBatchDeltaCheck(deps);
    expect(first.status).toBe('red');
    expect(first.filed).toMatchObject([{ id: 'WI-77', notificationError: expect.any(String) }]);
    expect(state.cursor?.openReds).toMatchObject([{
      path: file,
      leg: 'lint-tsc',
      assignee: 'su-current-holder',
      authorSource: 'edit-ledger:failing-file',
    }]);
    const persisted = JSON.stringify(state.cursor);

    captured.wakeQueued = 1;
    state.cursor = JSON.parse(persisted) as SyncDeltaCursor;
    const second = await runSyncBatchDeltaCheck(deps);
    expect(second.status).toBe('up-to-date');
    expect(second.filed).toMatchObject([{ id: 'WI-77' }]);
    expect(second.filed[0]).not.toHaveProperty('notificationError');
    expect(tscCalls).toEqual([[file], [file]]);
    expect(captured.messages).toHaveLength(1);
    expect(captured.messages[0]?.msgId).toBe('sync-delta-red:ws-1:WI-77');
    expect(captured.wakes).toHaveLength(2);
    expect(captured.wakes[1]?.targets).toEqual(['su-current-holder']);
    expect(captured.createArgs).toHaveLength(2);
    expect(captured.createArgs[0]?.conditionKey).toBe(`sync-delta-red:${file}`);
    expect(captured.createArgs[1]?.conditionKey).toBe(captured.createArgs[0]?.conditionKey);
    expect(captured.createArgs[1]?.assign_to).toBe('su-current-holder');
    expect(state.cursor?.openReds?.[0]).toMatchObject({ leg: 'lint-tsc', assignee: 'su-current-holder' });
  });

  it('leaves an unattributed red in the queue without waking a guessed agent', async () => {
    captured.messages.length = captured.wakes.length = 0;
    captured.notificationAssignee = null;
    const deps = buildSyncLintGuardDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    await deps.fileRed({ title: 'red', body: 'measured red', conditionKey: 'guard:k',
      paths: [], assignee: null, authorSource: 'none' });
    expect(captured.messages).toHaveLength(0);
    expect(captured.wakes).toHaveLength(0);
    captured.notificationAssignee = 'su-author-1';
  });
});
