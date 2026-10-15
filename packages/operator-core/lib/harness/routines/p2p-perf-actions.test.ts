/**
 * p2p-perf-actions.test.ts — regression guard for EI-5753.
 *
 * THE BUG: when a nightly Tier-1 run produced no summary, runTier auto-filed a
 * `kind:'bug'` improvement for EVERY exit — including a SIGNAL-terminated run
 * (exit 143=SIGTERM / 137=SIGKILL, or a non-null close signal). A signal-kill is
 * an INTERRUPTED run — the run's own 30-min timeout firing, the OOM killer, or a
 * bg-host service restart mid-run — not a runner crash with a real finding. Because
 * `kind:'bug'` is auto-implement-eligible, "the box was restarted" got routed into
 * the auto-fix loop and re-filed nightly (this very EI).
 *
 * classifyNoSummaryRun is the pure policy: only a genuine non-zero crash is a bug;
 * a timeout is a human-reviewed perf signal; an external signal-kill is not a
 * finding at all. This locks that classification so the noise loop can't return.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyNoSummaryRun } from './p2p-perf-actions';
import type { RunSummary } from '../../sync/hyperbee/perf/runner';

const captureImprovementMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../improvements/capture-core', () => ({
  captureImprovement: (...args: unknown[]) => captureImprovementMock(...args),
}));

// EI-7254: the exact-lookup pre-filter — defaults to "nothing already open" so
// the pre-existing watchdogKey-stability tests below are unaffected; individual
// tests override this to simulate an already-open standing issue.
const findIssuesByWatchdogKeysMock = vi.fn().mockResolvedValue([]);
vi.mock('../../issues-engineer', () => ({
  findIssuesByWatchdogKeys: (...args: unknown[]) => findIssuesByWatchdogKeysMock(...args),
}));

describe('classifyNoSummaryRun (EI-5753)', () => {
  it('classifies our own timeout firing as a timeout (human-reviewed perf signal, not a bug)', () => {
    // The killer fired and SIGTERM'd the tree; the tsx wrapper forwarded exit 143.
    expect(classifyNoSummaryRun({ code: 143, signal: null, timedOut: true })).toBe('timeout');
    // …or Node reported the signal directly on the tsx child.
    expect(classifyNoSummaryRun({ code: 1, signal: 'SIGTERM', timedOut: true })).toBe('timeout');
  });

  it('classifies an external SIGTERM (exit 143) with NO timeout as an interrupted signal-kill — not a finding', () => {
    // bg-host service restart / cgroup SIGTERM mid-run: our killer never fired.
    // This was the EI-5753 case mis-filed as kind:'bug'.
    expect(classifyNoSummaryRun({ code: 143, signal: null, timedOut: false })).toBe('signal');
  });

  it('classifies a SIGKILL (exit 137, e.g. OOM) with NO timeout as an interrupted signal-kill', () => {
    expect(classifyNoSummaryRun({ code: 137, signal: null, timedOut: false })).toBe('signal');
  });

  it('classifies ANY forwarded signal-band exit (128+N) with NO timeout as a signal-kill, not a crash bug (EI-5752 class)', () => {
    // The runner only ever exits 0/1, so an exit code in 129..159 is the tsx wrapper
    // forwarding a signal-kill it could not surface as a `close` signal — SIGHUP(129),
    // SIGINT(130), SIGABRT(134), SIGSEGV(139). Each must NOT re-file as an auto-fix bug.
    for (const code of [129, 130, 134, 139, 159]) {
      expect(classifyNoSummaryRun({ code, signal: null, timedOut: false })).toBe('signal');
    }
  });

  it('does NOT treat ordinary error exits (1/2/127/128) as signal-kills — those stay crashes', () => {
    // The boundary: a missing-runner 127 or a generic 1/2 is a genuine defect (bug),
    // and 128 (no signal byte) is below the 128+N band.
    for (const code of [1, 2, 127, 128]) {
      expect(classifyNoSummaryRun({ code, signal: null, timedOut: false })).toBe('crash');
    }
  });

  it('classifies a non-null close signal as a signal-kill regardless of code', () => {
    expect(classifyNoSummaryRun({ code: 1, signal: 'SIGKILL', timedOut: false })).toBe('signal');
    expect(classifyNoSummaryRun({ code: 0, signal: 'SIGTERM', timedOut: false })).toBe('signal');
  });

  it('classifies a genuine non-zero crash (no signal, no timeout) as a real bug', () => {
    // The runner actually threw / exited non-zero — an auto-fixable defect.
    expect(classifyNoSummaryRun({ code: 1, signal: null, timedOut: false })).toBe('crash');
    expect(classifyNoSummaryRun({ code: 2, signal: null, timedOut: false })).toBe('crash');
    expect(classifyNoSummaryRun({ code: 127, signal: null, timedOut: false })).toBe('crash');
  });

  it('treats a timeout as a timeout even though the kill also yields a signal/143 (timeout wins)', () => {
    // Our timeout firing implies we SIGTERM'd the tree, so signal/143 co-occur —
    // the run overran its budget, so it must classify as timeout, not signal.
    expect(classifyNoSummaryRun({ code: 143, signal: 'SIGTERM', timedOut: true })).toBe('timeout');
  });
});

describe('runTier scratch cleanup (EI-24940172185367066)', () => {
  it('removes a partial summary before releasing the tier lock on a handled signal exit', async () => {
    const priorTmpdir = process.env.TMPDIR;
    const isolatedTmpdir = mkdtempSync(path.join(os.tmpdir(), 'p2p-perf-cleanup-test-'));
    process.env.TMPDIR = isolatedTmpdir;

    let summaryPath: string | undefined;
    const events: string[] = [];
    try {
      const { runTier, releasePerfLock } = (await import('./p2p-perf-actions'))._testing;
      await runTier({} as never, '--tier1', 1_000, {
        runRunner: async (_root, args) => {
          const summaryArg = args.indexOf('--summary-json');
          const candidate = args[summaryArg + 1];
          if (!candidate) throw new Error('runner arguments omitted the summary path');
          summaryPath = candidate;
          writeFileSync(summaryPath, '{partial');
          return { code: 137, stdout: '', stderr: 'runner was killed', signal: null, timedOut: false };
        },
        removeSummary: (filePath, options) => {
          events.push('summary');
          rmSync(filePath, options);
        },
        releasePerfLock: (tier) => {
          events.push('lock');
          expect(summaryPath).toBeDefined();
          expect(existsSync(summaryPath!)).toBe(false);
          releasePerfLock(tier);
        },
      });

      expect(events).toEqual(['summary', 'lock']);
      expect(summaryPath).toBeDefined();
      expect(existsSync(summaryPath!)).toBe(false);
      expect(existsSync(path.join(isolatedTmpdir, 'papercusp-p2p-perf--tier1.lock'))).toBe(false);
    } finally {
      if (priorTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = priorTmpdir;
      rmSync(isolatedTmpdir, { recursive: true, force: true });
    }
  });
});

describe('fileFindings watchdogKey stability (EI-3909/EI-5846/EI-5829/EI-6585)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
    findIssuesByWatchdogKeysMock.mockResolvedValue([]);
  });

  function summaryWith(overrides: Partial<RunSummary>): RunSummary {
    return {
      runId: 'r1',
      profile: 'ci',
      outDir: '/tmp/out',
      reportPath: '/tmp/out/report.md',
      scenarioFailures: [],
      sloViolations: [],
      regressions: [],
      artifacts: [],
      baselineCompared: true,
      ...overrides,
    } as RunSummary;
  }

  it('stamps a watchdogKey for a regression that does NOT vary run-to-run even though baseline/current/relChange do', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    // Two "different nights" of the SAME regressed metric — every live number differs,
    // but scenario/paramsKey/metric (what the watchdogKey must key on) stay identical.
    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1068.699, relChange: 6.27 },
        ],
      }),
      'nightly Tier-1',
    );
    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1186.973, relChange: 7.08 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const firstKey = captureImprovementMock.mock.calls[0]![0].watchdogKey;
    const secondKey = captureImprovementMock.mock.calls[1]![0].watchdogKey;
    expect(firstKey).toBe('p2p-perf-regression:merge.delta-tick:historySize=1000,seed=1234:deltaTick1000Ms');
    // THE regression this test guards: same key across runs despite different live numbers.
    expect(firstKey).toBe(secondKey);
    // And the title (which DOES embed the live numbers) legitimately differs —
    // the watchdogKey, not the title, is what must carry cross-run identity.
    expect(captureImprovementMock.mock.calls[0]![0].title).not.toBe(captureImprovementMock.mock.calls[1]![0].title);
  });

  it('stamps a watchdogKey for an SLO violation keyed on scenario+params only (not the live p95Ms)', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].watchdogKey).toBe(
      'p2p-perf-slo:churn.reconnect-storm:historySize=10000,readers=4,seed=1234,winners=3710',
    );
  });

  it('AUTO-FILES a convergence failure — a run where the mesh never caught up must not pass silently (EI-20576392705164447)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    // The 2026-08-16 shape: ZERO SLO violations (loop lag was a healthy 21ms)
    // while most readers never converged. Before this, the nightly filed nothing.
    await fileFindings(
      summaryWith({
        sloViolations: [],
        convergenceViolations: [
          {
            scenario: 'replication.sustained',
            paramsKey: 'count=200,peers=64,rate=10',
            expectedReaders: 63,
            convergedReaders: 58,
            laggingReaders: ['1', '2', '22', '29', '3'],
            observedP95Ms: 601075,
            p95LimitMs: null,
            budgetMs: null,
            slowestConvergedMs: null,
          },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    const filed = captureImprovementMock.mock.calls[0]![0];
    expect(filed.watchdogKey).toBe('p2p-perf-convergence:replication.sustained:count=200,peers=64,rate=10');
    expect(filed.kind).toBe('bug');
    // Numbers stay out of the title so cross-run dedup keeps working.
    expect(filed.title).not.toMatch(/601075|58\/63/);
    expect(filed.body).toContain('58/63');
  });

  it('CONTROL: the same run with the convergence list absent (a pre-fix summary.json) files nothing and does not throw', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    // summary.json is parsed off disk with a cast, so a legacy file genuinely
    // arrives without the field — it must read as "not measured", not crash.
    await fileFindings(summaryWith({ convergenceViolations: undefined as never }), 'nightly Tier-1');
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('gives a DIFFERENT watchdogKey to a different metric on the SAME scenario/params (they must not dedup against each other)', async () => {
    const { fileFindings } = (
      await import('./p2p-perf-actions')
    )._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 74.832, relChange: 4.4 },
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 874.11, relChange: 4.95 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const keys = captureImprovementMock.mock.calls.map((c) => c[0].watchdogKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('stamps a STABLE watchdogKey for a scenario crash — same failure string, two "nights", same key (EI-22042363019140442)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const failure = 'replication.sustained: proc mesh: writer never became ready';

    await fileFindings(summaryWith({ scenarioFailures: [failure] }), 'nightly Tier-1');
    await fileFindings(summaryWith({ scenarioFailures: [failure] }), 'nightly Tier-1');

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const firstKey = captureImprovementMock.mock.calls[0]![0].watchdogKey;
    const secondKey = captureImprovementMock.mock.calls[1]![0].watchdogKey;
    expect(firstKey).toBe(`p2p-perf-crash:${failure}`);
    expect(firstKey).toBe(secondKey);
    expect(captureImprovementMock.mock.calls[0]![0].kind).toBe('bug');
  });

  it('gives a DIFFERENT watchdogKey to two DIFFERENT scenario crashes in the same run', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        scenarioFailures: [
          'replication.sustained: proc mesh: writer never became ready',
          'churn.cold-join: proc mesh: reader 3 never admitted the writer',
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(2);
    const keys = captureImprovementMock.mock.calls.map((c) => c[0].watchdogKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('fileFindings exact watchdogKey pre-filter (EI-7254)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
  });

  function summaryWith(overrides: Partial<RunSummary>): RunSummary {
    return {
      runId: 'r1',
      profile: 'ci',
      outDir: '/tmp/out',
      reportPath: '/tmp/out/report.md',
      scenarioFailures: [],
      sloViolations: [],
      regressions: [],
      artifacts: [],
      baselineCompared: true,
      ...overrides,
    } as RunSummary;
  }

  it('SKIPS capture entirely when an OPEN issue already carries the exact watchdogKey — even though capture-core\'s own fuzzy search-first dedup is mocked away and would have let it through', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const key = 'p2p-perf-regression:merge.delta-tick:historySize=1000,seed=1234:deltaTick100Ms';
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-1', state: 'open', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(findIssuesByWatchdogKeysMock).toHaveBeenCalledWith([key]);
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('does NOT skip when the existing issue with the same key is already RESOLVED (not open)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const key = 'p2p-perf-slo:churn.reconnect-storm:historySize=10000,readers=4,seed=1234,winners=3710';
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-2', state: 'resolved', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('a lookup failure (e.g. no DB) never blocks filing — fails open, same as before the fix', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    findIssuesByWatchdogKeysMock.mockRejectedValue(new Error('no db in this test'));

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('files an advisory regression as kind:"change" (human-reviewed), not kind:"bug" (auto-implement-eligible) — EI-7254', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick100Ms', baseline: 13.857, current: 90.492, relChange: 5.53 },
        ],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].kind).toBe('change');
  });

  it('still files an SLO violation as kind:"bug" (a real regression worth an auto-fix attempt)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].kind).toBe('bug');
  });

  it('SKIPS a scenario crash when an OPEN issue already carries its exact watchdogKey (EI-22042363019140442, EI-7254 pattern)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const failure = 'replication.sustained: proc mesh: writer never became ready';
    const key = `p2p-perf-crash:${failure}`;
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-22042363019140442', state: 'open', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(summaryWith({ scenarioFailures: [failure] }), 'nightly Tier-1');

    expect(findIssuesByWatchdogKeysMock).toHaveBeenCalledWith([key]);
    expect(captureImprovementMock).not.toHaveBeenCalled();
  });

  it('does NOT skip a scenario crash when the existing issue with the same key is already RESOLVED', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;
    const failure = 'churn.cold-join: proc mesh: reader 3 never admitted the writer';
    const key = `p2p-perf-crash:${failure}`;
    findIssuesByWatchdogKeysMock.mockResolvedValue([
      { id: 'EI-1', state: 'resolved', payload: { watchdogKey: key }, updatedAt: new Date().toISOString() },
    ]);

    await fileFindings(summaryWith({ scenarioFailures: [failure] }), 'nightly Tier-1');

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });
});

describe('fileFindings host-contention gate (EI-8843)', () => {
  beforeEach(() => {
    captureImprovementMock.mockClear();
    findIssuesByWatchdogKeysMock.mockClear();
    findIssuesByWatchdogKeysMock.mockResolvedValue([]);
  });

  function summaryWith(overrides: Partial<RunSummary>): RunSummary {
    return {
      runId: 'r1',
      profile: 'ci',
      outDir: '/tmp/out',
      reportPath: '/tmp/out/report.md',
      scenarioFailures: [],
      sloViolations: [],
      regressions: [],
      artifacts: [],
      baselineCompared: true,
      ...overrides,
    } as RunSummary;
  }

  it('skips ALL auto-filing (regressions AND SLO violations) when the run sampled an oversubscribed host', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1068.699, relChange: 6.27 },
        ],
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
        hostLoad: {
          loadavg1m: 150,
          cpus: 128,
          ratio1m: 1.17,
          oversubscribed: true,
          swapPagesDelta: null,
          memoryContended: false,
          memoryContendedReason: null,
          psiMemSome60: null,
          psiCpuSome60: null,
        },
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).not.toHaveBeenCalled();
    expect(findIssuesByWatchdogKeysMock).not.toHaveBeenCalled();
  });

  it('files normally when hostLoad is present but NOT oversubscribed', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        regressions: [
          { scenario: 'merge.delta-tick', paramsKey: 'historySize=1000,seed=1234', metric: 'deltaTick1000Ms', baseline: 146.982, current: 1068.699, relChange: 6.27 },
        ],
        hostLoad: {
          loadavg1m: 20,
          cpus: 128,
          ratio1m: 0.16,
          oversubscribed: false,
          swapPagesDelta: null,
          memoryContended: false,
          memoryContendedReason: null,
          psiMemSome60: null,
          psiCpuSome60: null,
        },
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('files normally when hostLoad is absent (older/mocked summaries — backward compatible)', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        sloViolations: [{ scenario: 'churn.reconnect-storm', paramsKey: 'historySize=10000,readers=4,seed=1234,winners=3710', p95Ms: 812, limitMs: 500 }],
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
  });

  it('EI-22042363019140442: also skips scenario-crash filing when the run sampled an oversubscribed host — this used to be a SEPARATE ungated loop in runTier() that ignored this gate entirely', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        scenarioFailures: ['replication.sustained: proc mesh: writer never became ready'],
        hostLoad: {
          loadavg1m: 150,
          cpus: 128,
          ratio1m: 1.17,
          oversubscribed: true,
          swapPagesDelta: null,
          memoryContended: false,
          memoryContendedReason: null,
          psiMemSome60: null,
          psiCpuSome60: null,
        },
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).not.toHaveBeenCalled();
    expect(findIssuesByWatchdogKeysMock).not.toHaveBeenCalled();
  });

  it('files a scenario crash normally when hostLoad is present but NOT oversubscribed', async () => {
    const { fileFindings } = (await import('./p2p-perf-actions'))._testing;

    await fileFindings(
      summaryWith({
        scenarioFailures: ['replication.sustained: proc mesh: writer never became ready'],
        hostLoad: {
          loadavg1m: 20,
          cpus: 128,
          ratio1m: 0.16,
          oversubscribed: false,
          swapPagesDelta: null,
          memoryContended: false,
          memoryContendedReason: null,
          psiMemSome60: null,
          psiCpuSome60: null,
        },
      }),
      'nightly Tier-1',
    );

    expect(captureImprovementMock).toHaveBeenCalledTimes(1);
    expect(captureImprovementMock.mock.calls[0]![0].watchdogKey).toBe(
      'p2p-perf-crash:replication.sustained: proc mesh: writer never became ready',
    );
  });
});
