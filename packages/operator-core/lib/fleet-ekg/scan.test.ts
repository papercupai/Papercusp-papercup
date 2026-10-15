/**
 * scan.test.ts — the EKG tick's orchestration (P-030 / FB-10), with injected
 * FleetEkgTickDeps and zero PG/clock IO. Pins: embed→persist flow with the
 * event floor; cohort floors short-circuiting; persist + alarm semantics
 * (unattributable MAJOR alarms once; attributed/moderate never; dryRun
 * suppresses; alarm failure never breaks the tick); payload tuning.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BehaviorChangeRow } from '../change-ledger/change-ledger';
import type { SessionVector } from './features';
import {
  ekgOptionsFromPayload,
  runFleetEkgTick,
  type FleetEkgTickDeps,
  type PersistedShift,
} from './scan';

const NOW = 1_750_000_000_000;
const HOUR = 3600_000;

function vector(i: number, endedAtMs: number, features: Record<string, number>): SessionVector {
  return {
    ownerId: `su-${i}`,
    sessionId: `sess-${endedAtMs}-${i}`,
    agent: 'claude',
    harnessSlug: null,
    startedAtMs: endedAtMs - HOUR,
    endedAtMs,
    eventCount: 20,
    features,
    toolMix: { read: 5, bash: 5 },
    bigrams: { 'read>bash': 5 },
  };
}

const baseFeatures = (i: number): Record<string, number> => ({ errorRate: 0.05 + (i % 3) * 0.01 });
const shiftedFeatures = (): Record<string, number> => ({ errorRate: 0.6 });

const ledgerRow = (recordedAtMs: number): BehaviorChangeRow => ({
  id: 'chg-1',
  workspaceId: 'ws-1',
  recordedAt: new Date(recordedAtMs).toISOString(),
  source: 'prompts-api',
  mutationClass: 'manual-prompt',
  action: 'set',
  targetKind: 'prompt-override',
  target: 'papercup/worker',
  harnessSlug: null,
  role: null,
  diffRef: null,
  actor: null,
  summary: null,
  payload: null,
});

interface DepsBundle {
  deps: FleetEkgTickDeps;
  alarm: ReturnType<typeof vi.fn>;
  markNotified: ReturnType<typeof vi.fn>;
  persistVectors: ReturnType<typeof vi.fn>;
  persistShifts: ReturnType<typeof vi.fn>;
}

/** Window cohort shifted hard vs a steady baseline, by default. */
function fakeDeps(over: Partial<FleetEkgTickDeps> = {}, persistedOver?: Partial<PersistedShift>): DepsBundle {
  const windowCohort = Array.from({ length: 10 }, (_, i) => vector(i, NOW - 1000 - i, shiftedFeatures()));
  const baselineCohort = Array.from({ length: 40 }, (_, i) => vector(100 + i, NOW - 30 * HOUR - i, baseFeatures(i)));
  const alarm = vi.fn(async () => {});
  const markNotified = vi.fn(async () => {});
  const persistVectors = vi.fn(async () => {});
  const persistShifts = vi.fn(
    async (_ws: string, _from: number, _to: number, _res: unknown, findings: { feature: string; severity: string; attributed: boolean }[]) =>
      findings.map(
        (f, i): PersistedShift => ({
          id: i + 1,
          feature: f.feature,
          severity: f.severity,
          attributed: f.attributed,
          alreadyNotified: false,
          ...persistedOver,
        }),
      ),
  );
  const deps: FleetEkgTickDeps = {
    readSessions: async () => [],
    persistVectors,
    readCohort: async (_ws, fromMs, toMs) =>
      [...windowCohort, ...baselineCohort].filter((v) => v.endedAtMs >= fromMs && v.endedAtMs < toMs),
    readLedger: async () => [],
    persistShifts,
    alarm,
    markNotified,
    nowMs: () => NOW,
    log: () => {},
    ...over,
  };
  return { deps, alarm, markNotified, persistVectors, persistShifts };
}

beforeEach(() => vi.clearAllMocks());

describe('runFleetEkgTick', () => {
  it('embeds sessions over the floor, counts skips, persists vectors', async () => {
    const mk = (n: number, id: string) => ({
      ownerId: 'su-1',
      sessionId: id,
      agent: 'claude',
      harnessSlug: null,
      events: Array.from({ length: n }, (_, i) => ({ toolName: 'Read', status: 'ok', atMs: NOW - HOUR + i * 1000 })),
    });
    const { deps, persistVectors } = fakeDeps({ readSessions: async () => [mk(15, 'big'), mk(3, 'small')] });
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.embedded).toBe(1);
    expect(result.skippedSmall).toBe(1);
    const persisted = persistVectors.mock.calls[0][1] as SessionVector[];
    expect(persisted).toHaveLength(1);
    expect(persisted[0].sessionId).toBe('big');
  });

  it('short-circuits on an insufficient baseline (no persist, no alarm)', async () => {
    const { deps, alarm, persistShifts } = fakeDeps({
      readCohort: async (_ws, fromMs, toMs) =>
        // Only the window cohort exists; the baseline range returns nothing.
        toMs === NOW ? Array.from({ length: 10 }, (_, i) => vector(i, NOW - 1000 - i, baseFeatures(i))) : [],
    });
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.status).toBe('insufficient-baseline');
    expect(result.findings).toBe(0);
    expect(persistShifts).not.toHaveBeenCalled();
    expect(alarm).not.toHaveBeenCalled();
  });

  it('an unattributable MAJOR shift persists, alarms once, and stamps notified', async () => {
    const { deps, alarm, markNotified, persistShifts } = fakeDeps();
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.status).toBe('ok');
    expect(result.findings).toBeGreaterThan(0);
    expect(result.unattributable).toBe(result.findings);
    expect(persistShifts).toHaveBeenCalledTimes(1);
    expect(alarm).toHaveBeenCalledTimes(1);
    expect(alarm.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-1' });
    expect((alarm.mock.calls[0][0] as { body: string }).body).toContain('errorRate');
    expect(markNotified).toHaveBeenCalledWith('ws-1', expect.arrayContaining([1]));
    expect(result.alarmed).toBeGreaterThan(0);
  });

  it('a ledgered mutation in the lookback attributes the shift — no alarm', async () => {
    const { deps, alarm } = fakeDeps({ readLedger: async () => [ledgerRow(NOW - 24 * HOUR)] });
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.attributed).toBe(result.findings);
    expect(result.unattributable).toBe(0);
    expect(alarm).not.toHaveBeenCalled();
  });

  it('an already-notified shift refreshes its condition without another owner page', async () => {
    const { deps, alarm, markNotified } = fakeDeps({}, { alreadyNotified: true });
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.alarmed).toBe(0);
    expect(alarm).toHaveBeenCalledWith(expect.objectContaining({ notifyOwner: false }));
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('dryRun persists but never alarms (backtest mode)', async () => {
    const { deps, alarm, persistShifts } = fakeDeps();
    const result = await runFleetEkgTick('ws-1', deps, { dryRun: true });
    expect(persistShifts).toHaveBeenCalled();
    expect(alarm).not.toHaveBeenCalled();
    expect(result.alarmed).toBe(0);
  });

  it('an alarm failure is swallowed; shift rows persist; nothing marked notified', async () => {
    const { deps, markNotified } = fakeDeps({
      alarm: vi.fn(async () => {
        throw new Error('push down');
      }),
    });
    const result = await runFleetEkgTick('ws-1', deps);
    expect(result.findings).toBeGreaterThan(0);
    expect(result.alarmed).toBe(0);
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('embed window honors embedDays', async () => {
    const readSessions = vi.fn(async () => []);
    const { deps } = fakeDeps({ readSessions });
    await runFleetEkgTick('ws-1', deps, { embedDays: 10 });
    expect(readSessions).toHaveBeenCalledWith('ws-1', NOW - 10 * 24 * HOUR);
  });
});

describe('ekgOptionsFromPayload', () => {
  it('lifts numeric knobs, ignores junk', () => {
    expect(
      ekgOptionsFromPayload({ windowHours: 12, baselineDays: 14, psiMajor: 0.5, minEvents: 'nope', bogus: true }),
    ).toMatchObject({ windowHours: 12, baselineDays: 14, psiMajor: 0.5, minEvents: undefined });
    expect(ekgOptionsFromPayload(null)).toEqual({});
    expect(ekgOptionsFromPayload('x')).toEqual({});
    expect(ekgOptionsFromPayload({ windowHours: -5 })).toMatchObject({ windowHours: undefined });
  });
});
