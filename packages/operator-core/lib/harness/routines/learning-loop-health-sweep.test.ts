import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: vi.fn(() => ({ sql: vi.fn() })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-test') }));
vi.mock('../../pot/watchdog', () => ({
  recentWatchdogFires: vi.fn(),
  claimWatchdogFire: vi.fn(),
}));
vi.mock('../../startup/validate-home-harness', () => ({ isLikelyFreshInstallGap: vi.fn() }));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../blueprint/learning-loop-read', () => ({ readLearningLoopHealth: vi.fn() }));

import {
  selectLearningLoopsNeedingEscalation,
  learningLoopHealthSweep,
  learningLoopHealthSweepWithEvidence,
} from './learning-loop-health-sweep';
import { summarizeLearningLoopHealth, type LearningLoopHealth } from '../../blueprint/learning-loop-health';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { captureImprovement } from '../improvements/capture-core';
import { readLearningLoopHealth } from '../../blueprint/learning-loop-read';
import { isLikelyFreshInstallGap } from '../../startup/validate-home-harness';

function loop(over: Partial<LearningLoopHealth>): LearningLoopHealth {
  return {
    blueprintId: 'scout',
    alwaysOn: true,
    singletonRow: null,
    legacyRow: null,
    collision: false,
    active: false,
    lastFiredAt: null,
    daysSinceFire: null,
    activityLastAt: null,
    daysSinceActivity: null,
    activitySource: null,
    activityDetail: null,
    status: 'firing',
    expectedMaterialized: true,
    pauseAcknowledged: false,
    ...over,
  };
}

describe('selectLearningLoopsNeedingEscalation (EI-19281872822982156)', () => {
  it('the motivating case: an always-on loop paused (should-be-on-but-dark) is selected', () => {
    const rows = [loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['scout']);
  });

  it('a wedged active loop (stale) is selected', () => {
    const rows = [loop({ blueprintId: 'gym-x', status: 'stale', daysSinceFire: 5 })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['gym-x']);
  });

  it('an expected-but-never-materialized loop (absent + expectedMaterialized) is selected', () => {
    const rows = [loop({ blueprintId: 'transfer', status: 'absent', expectedMaterialized: true })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['transfer']);
  });

  it('an absent-but-NOT-expected loop (platform-mode-off gate) is NOT selected', () => {
    const rows = [loop({ blueprintId: 'memory-precision', status: 'absent', expectedMaterialized: false })];
    expect(selectLearningLoopsNeedingEscalation(rows)).toEqual([]);
  });

  // EI-19370236916382521 — the "re-affirm it explicitly rather than letting this alarm
  // re-fire silently" remedy: a should-be-on-but-dark loop whose pause was acknowledged
  // (routines:set { active:false, reviewBy }, still in its window) drops out of selection.
  it('a RE-AFFIRMED should-be-on-but-dark loop (pauseAcknowledged) is NOT selected', () => {
    const rows = [loop({ blueprintId: 'iq-battery', status: 'should-be-on-but-dark', pauseAcknowledged: true })];
    expect(selectLearningLoopsNeedingEscalation(rows)).toEqual([]);
  });

  it('an UNACKNOWLEDGED should-be-on-but-dark loop is still selected even when others nearby are acknowledged', () => {
    const rows = [
      loop({ blueprintId: 'iq-battery', status: 'should-be-on-but-dark', pauseAcknowledged: true }),
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', pauseAcknowledged: false }),
    ];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['scout']);
  });

  it('a collision (both @singleton and legacy rows exist) is selected regardless of status', () => {
    const rows = [loop({ blueprintId: 'red-queen', status: 'firing', collision: true })];
    expect(selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId)).toEqual(['red-queen']);
  });

  it('firing / pending / dark-by-design are NOT selected — healthy or expected states', () => {
    const rows = [
      loop({ blueprintId: 'a', status: 'firing' }),
      loop({ blueprintId: 'b', status: 'pending' }),
      loop({ blueprintId: 'c', status: 'dark-by-design', alwaysOn: false }),
    ];
    expect(selectLearningLoopsNeedingEscalation(rows)).toEqual([]);
  });

  it('never drifts from summarizeLearningLoopHealth\'s own needsAttention predicate', () => {
    const rows = [
      loop({ blueprintId: 'a', status: 'firing' }),
      loop({ blueprintId: 'b', status: 'should-be-on-but-dark' }),
      loop({ blueprintId: 'c', status: 'stale' }),
      loop({ blueprintId: 'd', status: 'dark-by-design', alwaysOn: false }),
      loop({ blueprintId: 'e', status: 'absent', expectedMaterialized: true }),
      loop({ blueprintId: 'f', status: 'absent', expectedMaterialized: false }),
      loop({ blueprintId: 'g', status: 'firing', collision: true }),
    ];
    const selected = selectLearningLoopsNeedingEscalation(rows).map((r) => r.blueprintId).sort();
    const summarized = summarizeLearningLoopHealth(rows).needsAttention.slice().sort();
    expect(selected).toEqual(summarized);
  });
});

describe('learningLoopHealthSweep (EI-19281872822982156, defect 2)', () => {
  const originalDesktopEnv = process.env.PAPERCUSP_DESKTOP;

  beforeEach(() => {
    if (originalDesktopEnv === undefined) delete process.env.PAPERCUSP_DESKTOP;
    else process.env.PAPERCUSP_DESKTOP = originalDesktopEnv;
    vi.mocked(isLikelyFreshInstallGap).mockResolvedValue(false);
    vi.mocked(recentWatchdogFires).mockResolvedValue(0);
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    vi.mocked(captureImprovement).mockResolvedValue({} as never);
  });
  afterEach(() => {
    if (originalDesktopEnv === undefined) delete process.env.PAPERCUSP_DESKTOP;
    else process.env.PAPERCUSP_DESKTOP = originalDesktopEnv;
    vi.clearAllMocks();
  });

  it('retains the resolved workspace and every classifier candidate/outcome in a JSON-safe report', async () => {
    const singletonRow = {
      installSlug: '@singleton',
      name: 'bp-singleton-scout-0',
      active: false,
      lastFiredAt: '2026-10-04T00:00:00.000Z',
      nextFireAt: null,
      pauseReviewBy: null,
    };
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', singletonRow }),
      loop({ blueprintId: 'regret', status: 'firing', active: true }),
    ]);

    const report = await learningLoopHealthSweepWithEvidence();

    expect(report).toMatchObject({
      schemaVersion: 'learning-loop-health-sweep/v1',
      workspaceId: 'ws-test',
      runStatus: 'completed',
      candidateCount: 2,
      candidates: [
        { blueprintId: 'scout', status: 'should-be-on-but-dark', selectedForEscalation: true, singletonRow },
        { blueprintId: 'regret', status: 'firing', selectedForEscalation: false },
      ],
      escalations: [{ blueprintId: 'scout', outcome: 'escalated' }],
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('does not escalate an empty registry during a pristine packaged desktop first boot', async () => {
    process.env.PAPERCUSP_DESKTOP = '1';
    vi.mocked(isLikelyFreshInstallGap).mockResolvedValue(true);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(isLikelyFreshInstallGap).toHaveBeenCalledWith('ws-test');
    expect(readLearningLoopHealth).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('does not apply the fresh-install deferral to a non-desktop operator', async () => {
    vi.mocked(isLikelyFreshInstallGap).mockResolvedValue(true);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', alwaysOn: true }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([
      expect.objectContaining({ blueprintId: 'scout', outcome: 'escalated', status: 'should-be-on-but-dark' }),
    ]);
    expect(readLearningLoopHealth).toHaveBeenCalled();
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('passes the bg-host process start time into the shared classifier read', async () => {
    const nowMs = Date.parse('2026-10-06T04:00:00.000Z');
    const uptimeSeconds = 321;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const uptimeSpy = vi.spyOn(process, 'uptime').mockReturnValue(uptimeSeconds);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([]);

    try {
      await learningLoopHealthSweep();

      expect(readLearningLoopHealth).toHaveBeenCalledTimes(1);
      expect(vi.mocked(readLearningLoopHealth).mock.calls[0]?.[2]).toEqual({
        processStartedAtMs: nowMs - uptimeSeconds * 1_000,
      });
    } finally {
      nowSpy.mockRestore();
      uptimeSpy.mockRestore();
    }
  });

  it('keeps real alarms active on a packaged desktop after a project is provisioned', async () => {
    process.env.PAPERCUSP_DESKTOP = '1';
    vi.mocked(isLikelyFreshInstallGap).mockResolvedValue(false);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', alwaysOn: true }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([
      expect.objectContaining({ blueprintId: 'scout', outcome: 'escalated', status: 'should-be-on-but-dark' }),
    ]);
    expect(readLearningLoopHealth).toHaveBeenCalled();
    expect(captureImprovement).toHaveBeenCalledTimes(1);
  });

  it('the motivating case: scout paused (should-be-on-but-dark) — files ONE major-severity observation', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark', alwaysOn: true, lastFiredAt: '2026-07-27T22:33:06.115Z' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([
      expect.objectContaining({ blueprintId: 'scout', outcome: 'escalated', status: 'should-be-on-but-dark' }),
    ]);
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        severity: 'major',
        title: expect.stringContaining('scout'),
      }),
    );
  });

  it('a non-always-on stale loop escalates at minor severity', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'graduation', status: 'stale', alwaysOn: false, daysSinceFire: 5 }),
    ]);

    await learningLoopHealthSweep();

    expect(captureImprovement).toHaveBeenCalledWith(expect.objectContaining({ severity: 'minor' }));
  });

  it('a collision reports status "collision", not the underlying LearningLoopStatus', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'red-queen', status: 'firing', collision: true }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0]).toMatchObject({ blueprintId: 'red-queen', status: 'collision', outcome: 'escalated' });
  });

  it('a RE-AFFIRMED should-be-on-but-dark loop (pauseAcknowledged) is never captured — no daily re-fire', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'iq-battery', status: 'should-be-on-but-dark', pauseAcknowledged: true }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a healthy loop set escalates nothing', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([loop({ blueprintId: 'scout', status: 'firing' })]);

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('debounced (already fired within 24h): never re-files', async () => {
    vi.mocked(recentWatchdogFires).mockResolvedValue(1);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a raced claim (claimWatchdogFire returns false) reports debounced, never files twice', async () => {
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
    ]);

    const results = await learningLoopHealthSweep();

    expect(results[0].outcome).toBe('debounced');
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('fully fail-soft: a read failure never throws — returns [] and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(readLearningLoopHealth).mockRejectedValue(new Error('pg down'));

    const results = await learningLoopHealthSweep();

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    warn.mockRestore();
  });

  it('one loop erroring during capture never blocks the others', async () => {
    vi.mocked(readLearningLoopHealth).mockResolvedValue([
      loop({ blueprintId: 'scout', status: 'should-be-on-but-dark' }),
      loop({ blueprintId: 'change-ledger', status: 'should-be-on-but-dark' }),
    ]);
    vi.mocked(captureImprovement)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({} as never);

    const results = await learningLoopHealthSweep();

    expect(results.map((r) => r.outcome)).toEqual(['error', 'escalated']);
  });
});
