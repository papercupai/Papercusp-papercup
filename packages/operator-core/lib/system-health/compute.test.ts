/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GovernorQueuePopulationObservation } from '../resource-governor/queue';
const {
  backgroundWorkersEnabledMock,
  getFlagMock,
  readSharedSnapshotMock,
  statfsMock,
  homedirMock,
  tmpdirMock,
  sqlMock,
  devDeployStateMock,
  computeNextFireAtMock,
  readGovernorQueuePopulationMock,
  GovernorStateSnapshotWriterMock,
  governorWriterPublishMock,
} = vi.hoisted(() => ({
  backgroundWorkersEnabledMock: vi.fn(() => false),
  getFlagMock: vi.fn(async () => true),
  readSharedSnapshotMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  statfsMock: vi.fn(),
  homedirMock: vi.fn(() => '/home/tester'),
  tmpdirMock: vi.fn(() => '/tmp'),
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  devDeployStateMock: vi.fn(async () => ({
    deployed: { shortSha: 'deployed' },
    deployedBehindStaging: 0,
    greenPinBehindStaging: 0,
    deployedBehindGreenPin: 0,
    greenPinAtStagingHead: true,
    deployedAtMs: 0,
    stagingHead: { committedAtMs: 0 },
    errors: [],
  })),
  computeNextFireAtMock: vi.fn(),
  readGovernorQueuePopulationMock: vi.fn(
    async (..._args: unknown[]): Promise<GovernorQueuePopulationObservation[]> => [],
  ),
  GovernorStateSnapshotWriterMock: vi.fn(function () {
    return { publish: governorWriterPublishMock };
  }),
  governorWriterPublishMock: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: getFlagMock,
}));
vi.mock('../dev-deploy-state', () => ({ devDeployState: devDeployStateMock }));
// WI-10006803: the live git-sync push-backlog probe resolves its repo root through
// operator-notes first, so this is where a test can hang the whole probe.
const { projectDirForSlugMock } = vi.hoisted(() => ({
  projectDirForSlugMock: vi.fn(async (_slug: string): Promise<string | null> => null),
}));
vi.mock('../operator-notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../operator-notes')>()),
  projectDirForSlug: projectDirForSlugMock,
}));
vi.mock('../harness/routines/cron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness/routines/cron')>()),
  computeNextFireAt: computeNextFireAtMock,
}));
vi.mock('../background-workers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../background-workers')>()),
  backgroundWorkersEnabled: backgroundWorkersEnabledMock,
}));
vi.mock('../derived-reads/shared-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../derived-reads/shared-snapshot')>()),
  readSharedSnapshot: readSharedSnapshotMock,
}));
vi.mock('../resource-governor/queue', () => ({
  readGovernorQueuePopulation: readGovernorQueuePopulationMock,
}));
vi.mock('../resource-governor/state-snapshot', () => ({
  GOVERNOR_STATE_MAX_AGE_MS: 120_000,
  GovernorStateSnapshotWriter: GovernorStateSnapshotWriterMock,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  statfs: statfsMock,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: homedirMock,
  tmpdir: tmpdirMock,
}));
import { makeOpenImprovementsReader, panelSafe, computeEscalationsHealth, probeGatewayHealthz, observationRole, overwatchScorecardSkipped, scoutHealthVerdict, suIdeateVerdict, crossesProvenanceDivergenceThreshold, PROVENANCE_DIVERGENCE_WARN_THRESHOLD, splitAutoEligibleStuck, tallyPlans, toolEfficiencyStatus, countStuckFrontier, isLiveRigOnlyFrontierTitle, computeAccountsAvailable, computeProjectionFreshestAgeMs, computeStalePausedRoutines, deadRoutineOverdueMsForCiWindow, summarizeDeadRoutines, FLEET_BLOCKING_ROUTINE_NAMES, mergeHealthPanels, resolveSystemHealth, readSharedSystemHealthSnapshot, selectPreviousHealthSnapshot, deriveSystemHealthGitSyncStatus, readFreshGitSyncMissedIntervalsByInstall, collectDeploy, _resetSystemHealthCache, systemHealthGitSidecarEnabled, hostPressureSampleFromLiveHealth, publishGovernorStateSnapshot, readAcceptanceDrainVisibility, ACCEPTANCE_DRAIN_VISIBILITY_SQL, countInvalidModelFailures, type EscalationAgingInput, type StalePausedRoutineInput } from './compute';
import { readDiskPressure } from './compute';
import { markSpawnOffloadHost, resetSpawnOffloadHostForTest } from '../fleet/git-via-sidecar';
import { PUSH_BACKLOG_DEADLINE_MS } from './push-backlog-reader';
import { PANEL_LABELS, PANEL_ORDER } from './types';
import { GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS } from '../harness/git-sync/missing-checkout';
import type { ClaudeAccount } from '../deployment/account-pool';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import type { DeployHealth, HealthPanel, PanelKey, PanelStatus, SystemHealth, SystemHealthPanels } from './types';

/** A real (minimal) ImprovementCandidate — id/kind/scope/title are the only required
 *  fields, so these tests need no cast and stay honest if the shape changes. */
const candidate = (id: string): ImprovementCandidate =>
  ({ id, kind: 'bug', scope: 'operator', title: `candidate ${id}` });

describe('countInvalidModelFailures', () => {
  it('excludes capacity walls even when another field mentions access', () => {
    expect(countInvalidModelFailures([
      { error_message: 'Selected model is at capacity', output_tail: 'failed to access gateway' },
      { error_message: 'Selected model does not exist', output_tail: null },
    ])).toBe(1);
  });
});

describe('publishGovernorStateSnapshot — queue census bridge (EI-219699)', () => {
  const observedAtMs = 2_000_000;
  const queueByClass = [
    { admissionClass: 'agent', depth: 4, oldestAgeMs: 1_500, arrivals: 6, drained: 2, observedWindowMs: 60_000 },
    { admissionClass: 'build', depth: 1, arrivals: 2, drained: 3, observedWindowMs: 60_000 },
  ];

  beforeEach(() => {
    readGovernorQueuePopulationMock.mockReset().mockResolvedValue(queueByClass);
    governorWriterPublishMock.mockReset().mockResolvedValue(undefined);
    GovernorStateSnapshotWriterMock.mockClear();
  });

  it('publishes the complete queue census while leaving process-local decisions unknown', async () => {
    await expect(publishGovernorStateSnapshot('ws-governor', observedAtMs)).resolves.toBeUndefined();

    expect(readGovernorQueuePopulationMock).toHaveBeenCalledWith(sqlMock, 'ws-governor', observedAtMs);
    expect(GovernorStateSnapshotWriterMock).toHaveBeenCalledWith('ws-governor');
    expect(governorWriterPublishMock).toHaveBeenCalledWith({
      observedAtMs,
      validUntilMs: observedAtMs + 120_000,
      queueByClass,
    });
    expect(governorWriterPublishMock.mock.calls[0]?.[0]).not.toHaveProperty('admission');
    expect(governorWriterPublishMock.mock.calls[0]?.[0]).not.toHaveProperty('recovery');
    expect(governorWriterPublishMock.mock.calls[0]?.[0]).not.toHaveProperty('health');
  });

  it('swallows a census failure without attempting a partial snapshot write', async () => {
    readGovernorQueuePopulationMock.mockRejectedValueOnce(new Error('queue census unavailable'));

    await expect(publishGovernorStateSnapshot('ws-governor', observedAtMs)).resolves.toBeUndefined();

    expect(GovernorStateSnapshotWriterMock).not.toHaveBeenCalled();
    expect(governorWriterPublishMock).not.toHaveBeenCalled();
  });

  it('swallows a snapshot write failure so the health tick can still finish', async () => {
    governorWriterPublishMock.mockRejectedValueOnce(new Error('snapshot store unavailable'));

    await expect(publishGovernorStateSnapshot('ws-governor', observedAtMs)).resolves.toBeUndefined();

    expect(readGovernorQueuePopulationMock).toHaveBeenCalledOnce();
    expect(governorWriterPublishMock).toHaveBeenCalledOnce();
  });
});

describe('hostPressureSampleFromLiveHealth — measured-only projection', () => {
  const reading = (state: 'measured' | 'unknown' | 'stale', value: unknown) => ({ state, value });

  it('projects measured numeric readings and profile normalization into the detector sample', () => {
    const snapshot = {
      sampledAtMs: 10_000,
      profile: { effectiveCores: 4 },
      signals: {
        'cpu.psiSomePct': reading('measured', 12),
        'memory.psiSomePct': reading('measured', 3),
        'memory.psiFullPct': reading('measured', 1),
        'scheduler.runnableCount': reading('measured', 7),
        'scheduler.blockedCount': reading('measured', 1),
      },
    } as unknown as Parameters<typeof hostPressureSampleFromLiveHealth>[0];

    expect(hostPressureSampleFromLiveHealth(snapshot)).toEqual({
      sampledAtMs: 10_000,
      effectiveCores: 4,
      cpuPsiSomePct: 12,
      memoryPsiSomePct: 3,
      memoryPsiFullPct: 1,
      runnableCount: 7,
      blockedCount: 1,
    });
  });

  it('maps unknown/stale/non-numeric readings to null and preserves an absent snapshot', () => {
    const snapshot = {
      sampledAtMs: 10_000,
      profile: { effectiveCores: 4 },
      signals: {
        'cpu.psiSomePct': reading('unknown', null),
        'memory.psiSomePct': reading('stale', null),
        'memory.psiFullPct': reading('measured', true),
        'scheduler.runnableCount': reading('measured', 7),
        'scheduler.blockedCount': reading('unknown', null),
      },
    } as unknown as Parameters<typeof hostPressureSampleFromLiveHealth>[0];

    expect(hostPressureSampleFromLiveHealth(snapshot)).toMatchObject({
      sampledAtMs: 10_000,
      effectiveCores: 4,
      cpuPsiSomePct: null,
      memoryPsiSomePct: null,
      memoryPsiFullPct: null,
      runnableCount: 7,
      blockedCount: null,
    });
    expect(hostPressureSampleFromLiveHealth(null)).toBeNull();
  });
});

describe('readDiskPressure — process temp filesystem coverage (EI-21048564873280768)', () => {
  beforeEach(() => {
    statfsMock.mockReset();
    homedirMock.mockReturnValue('/home/tester');
    tmpdirMock.mockReturnValue('/tmp');
  });

  it('probes tmpdir() and retains a separate temp mount after same-device deduplication', async () => {
    const root = { type: 1, blocks: 100, bsize: 1, bavail: 10, bfree: 10 };
    const temp = { type: 2, blocks: 1000, bsize: 1, bavail: 20, bfree: 20 };
    statfsMock.mockImplementation(async (path: string) => {
      if (path === '/home/tester/.papercusp' || path === process.cwd()) return root;
      if (path === '/tmp') return temp;
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(readDiskPressure()).resolves.toEqual([
      { path: '/home/tester/.papercusp', usedPct: 90, freeGb: 0 },
      { path: '/tmp', usedPct: 98, freeGb: 0 },
    ]);
    expect(statfsMock.mock.calls.map(([path]) => path)).toEqual([
      '/home/tester/.papercusp',
      process.cwd(),
      '/tmp',
    ]);
  });
});

describe('resolveSystemHealth — reader cold-cache guard (EI-203357)', () => {
  beforeEach(() => {
    _resetSystemHealthCache();
    // The two assertions below are CALL-COUNT assertions, and nothing in this
    // file or the vitest config clears mocks between tests. Without an explicit
    // clear they count every call since module load — including any made at
    // import time elsewhere in the module graph — so an unrelated new caller
    // turns "the guard consults host role once" into a spurious 2. Clear (not
    // reset: the return values below are the mock's whole behaviour) so the
    // counts measure THIS test only, which is what they were written to assert.
    backgroundWorkersEnabledMock.mockClear();
    readSharedSnapshotMock.mockClear();
    backgroundWorkersEnabledMock.mockReturnValue(false);
    getFlagMock.mockResolvedValue(true);
    readSharedSnapshotMock.mockResolvedValue(null);
  });

  it('returns null on a reader snapshot miss instead of running the full tick', async () => {
    const health = await resolveSystemHealth('ws-reader-cold-cache');

    expect(health).toBeNull();
    expect(backgroundWorkersEnabledMock).toHaveBeenCalledOnce();
    expect(readSharedSnapshotMock).toHaveBeenCalledOnce();
  });

  it('exposes the shared snapshot payload with the caller freshness bound and no aggregation fallback', async () => {
    const shared = {
      workspaceId: 'ws-shared-hit',
      evaluatedAt: 123_456,
      overall: 'ok',
      crossMonitor: { queenAlive: true, overwatchAlive: null },
      panels: {},
    } as unknown as SystemHealth;
    readSharedSnapshotMock.mockResolvedValue({ payload: shared, computedAt: 123_456, ageMs: 10 });

    await expect(readSharedSystemHealthSnapshot('ws-shared-hit', 4_321)).resolves.toBe(shared);
    expect(readSharedSnapshotMock).toHaveBeenCalledWith('system.health', 'ws-shared-hit', 1, 4_321);
  });
});

describe('selectPreviousHealthSnapshot — shared predecessor for cold tick hosts (EI-21401701194386826)', () => {
  it('uses the shared snapshot when the local tick cache is cold, preserving disk band state', () => {
    const shared = {
      workspaceId: 'ws-shared',
      evaluatedAt: 123_456,
      overall: 'crit',
      crossMonitor: { queenAlive: true, overwatchAlive: null },
      panels: {
        infra: {
          key: 'infra',
          label: 'Infra',
          status: 'crit',
          summary: 'DISK 94% used (crit hysteresis held)',
          metrics: [],
          data: { disk: [{ path: '/', usedPct: 94, freeGb: 100, band: 'crit' }] },
        },
      },
    } as unknown as SystemHealth;

    expect(selectPreviousHealthSnapshot(null, shared)).toBe(shared);
    expect(selectPreviousHealthSnapshot(null, shared)?.panels.infra?.data).toMatchObject({
      disk: [{ band: 'crit' }],
    });
  });

  it('keeps the local snapshot authoritative when both predecessors exist', () => {
    const local = { workspaceId: 'ws-local' } as unknown as SystemHealth;
    const shared = { workspaceId: 'ws-shared' } as unknown as SystemHealth;
    expect(selectPreviousHealthSnapshot(local, shared)).toBe(local);
  });

  it('returns a true cold start when neither predecessor is available', () => {
    expect(selectPreviousHealthSnapshot(null, null)).toBeNull();
  });
});

describe('makeOpenImprovementsReader — one open-improvements read per tick (P-008)', () => {
  // Why this is pinned: collectWorkFeed (auto-eligible-stuck) and collectImprovements
  // BOTH need readImprovementItems({state:'open',limit:1000}), and they run concurrently
  // in the tick's Promise.all. Measured 2026-08-01 that read is the tick's most expensive
  // statement (~160ms, ~997 rows), and with ~22 hosts ticking every 30s the duplicate
  // alone cost ~0.12 DB-cores continuously. A future collector calling the reader
  // directly instead of ctx.openImprovements() silently re-opens that — these tests are
  // the tripwire.
  it('issues the underlying read exactly once no matter how many collectors ask', async () => {
    let calls = 0;
    const reader = makeOpenImprovementsReader(async () => { calls += 1; return []; });
    await Promise.all([reader(), reader(), reader()]);
    await reader();
    expect(calls).toBe(1);
  });

  it('memoises the PROMISE, so concurrent callers share one in-flight read', async () => {
    // A value-memo would let both collectors fire before either resolved — the exact
    // duplicate this exists to remove, since they start in the same Promise.all.
    let calls = 0;
    let release!: (v: ImprovementCandidate[]) => void;
    const reader = makeOpenImprovementsReader(() => {
      calls += 1;
      return new Promise<ImprovementCandidate[]>((res) => { release = res; });
    });
    const a = reader();
    const b = reader(); // starts BEFORE the first resolves
    expect(calls).toBe(1);
    release([candidate('EI-1')]);
    expect(await a).toBe(await b); // same array instance — one read, shared rows
  });

  it('gives every caller the same rows (the two panels can never disagree)', async () => {
    const rows = [candidate('EI-1'), candidate('EI-2')];
    const reader = makeOpenImprovementsReader(async () => rows);
    expect(await reader()).toBe(rows);
    expect(await reader()).toBe(rows);
  });

  it('memoises a REJECTION rather than retrying per collector', async () => {
    // Both callers issue the identical query in the same tick, so a failure hits both
    // anyway; retrying would turn one failing tick into two failing queries. Each
    // collector keeps its own fail-soft handling.
    let calls = 0;
    const reader = makeOpenImprovementsReader(async () => { calls += 1; throw new Error('pg down'); });
    await expect(reader()).rejects.toThrow('pg down');
    await expect(reader()).rejects.toThrow('pg down');
    expect(calls).toBe(1);
  });

  it('separate ticks do NOT share a memo (a fresh ctx reads fresh rows)', async () => {
    // refreshHealthPanel builds its own ctx; two refreshes minutes apart must not
    // serve the older one's rows.
    let calls = 0;
    const read = async () => { calls += 1; return []; };
    await makeOpenImprovementsReader(read)();
    await makeOpenImprovementsReader(read)();
    expect(calls).toBe(2);
  });
});

// dedupeInFlight's own suite moved to ../dedupe-in-flight.test.ts when the
// primitive was extracted to its own module (EI-22091013068319789) for reuse
// by sync-resolver/adv-roster-read.ts.

describe('splitAutoEligibleStuck — keyed dispatcher-stuck vs keyless human-review backlog (EI-14223)', () => {
  it('counts only KEYED, attempts:0 items as autoEligibleStuck', () => {
    const r = splitAutoEligibleStuck([
      { attempts: 0, watchdogKey: 'dispatcher-staleness:auto-implement-dispatcher' },
      { attempts: 0, watchdogKey: 'some-watchdog:key' },
      { attempts: 1, watchdogKey: 'in-flight:key' }, // already dispatched — excluded
    ]);
    expect(r.autoEligibleStuck).toBe(2);
    expect(r.keylessHumanReviewBacklog).toBe(0);
  });

  it('counts KEYLESS (no watchdogKey), attempts:0 items as keylessHumanReviewBacklog, never autoEligibleStuck', () => {
    const r = splitAutoEligibleStuck([
      { attempts: 0 }, // manually captured, no watchdogKey
      { attempts: 0, watchdogKey: undefined },
      { attempts: 1 }, // keyless but already attempted — excluded from both
    ]);
    expect(r.autoEligibleStuck).toBe(0);
    expect(r.keylessHumanReviewBacklog).toBe(2);
  });

  it('does not let a large keyless pile inflate autoEligibleStuck (the EI-14223 false-alarm repro)', () => {
    const keyless = Array.from({ length: 200 }, () => ({ attempts: 0 }));
    const keyed = [{ attempts: 0, watchdogKey: 'dispatcher-staleness:auto-implement-dispatcher' }];
    const r = splitAutoEligibleStuck([...keyless, ...keyed]);
    expect(r.autoEligibleStuck).toBe(1);
    expect(r.keylessHumanReviewBacklog).toBe(200);
  });

  it('returns zeros for an empty input', () => {
    expect(splitAutoEligibleStuck([])).toEqual({ autoEligibleStuck: 0, keylessHumanReviewBacklog: 0 });
  });
});

describe('observationRole — per-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('prefers the stamped payload.filedByRole', () => {
    expect(observationRole({ payload: { filedByRole: 'kettle' }, signalOrigin: 'organic' })).toBe('kettle');
  });
  it('falls back to sourceRole, then signalOrigin, then unknown', () => {
    expect(observationRole({ payload: {}, sourceRole: 'Scout' })).toBe('Scout');
    expect(observationRole({ payload: null, signalOrigin: 'organic' })).toBe('organic');
    expect(observationRole({})).toBe('unknown');
  });
  it('reads the REAL row fields, not the prior phantom `it.origin`/top-level `sourceRole`', () => {
    // EngineerIssue carries `payload` + `signalOrigin`, NEVER a top-level `origin`
    // nor (for tool captures) `sourceRole` — the old `it.sourceRole ?? it.origin`
    // read undefined on both → bucketed 100% as 'unknown'.
    expect(observationRole({ payload: { filedByRole: 'cup' } })).toBe('cup');
  });
});

describe('overwatchScorecardSkipped — monitor-the-monitor (hive-loop-supervision 2026-06-21)', () => {
  const base = { alive: true as boolean | null, lastWakeAt: 1_000_000, now: 1_000_000 + 6 * 60_000, freshnessStatus: 'stale' as const };
  it('skipped when alive + settled past grace + not fresh', () => {
    expect(overwatchScorecardSkipped(base)).toBe(true);
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'partial-only' })).toBe(true);
  });
  it('NOT skipped when fresh', () => {
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'fresh' })).toBe(false);
  });
  it('NOT skipped for an unknown rubric reference', () => {
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'unknown-rubric' })).toBe(false);
  });
  it('NOT skipped within the grace (turn may still be in flight — no mid-turn false positive)', () => {
    expect(overwatchScorecardSkipped({ ...base, now: base.lastWakeAt + 60_000 })).toBe(false);
  });
  it('NOT skipped when dark (alive:false) or never woke (lastWakeAt:null)', () => {
    expect(overwatchScorecardSkipped({ ...base, alive: false })).toBe(false);
    expect(overwatchScorecardSkipped({ ...base, lastWakeAt: null })).toBe(false);
  });
});

describe('scoutHealthVerdict — ideation observability (hive-loop-supervision 2026-06-21)', () => {
  const now = 1_000_000_000;
  const t = (agoMs: number, status: string, ideas?: number) => ({ status, ideasGenerated: ideas, tickAt: new Date(now - agoMs).toISOString() });
  it('transport-death: cycles RAN in-window but 0 ideas', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 0), t(120_000, 'ran', 0)], now);
    expect(v.transportDeath).toBe(true);
    expect(v.ranInWindow).toBe(2);
    expect(v.ideasInWindow).toBe(0);
  });
  it('healthy: cycles ran with ideas (newest run + window sum)', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 5), t(120_000, 'ran', 3)], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ideasInWindow).toBe(8);
    expect(v.ideasLastRun).toBe(5);
  });
  it('only gated/idle ticks → NOT transport-death (no full cycle = unknown, not dead)', () => {
    const v = scoutHealthVerdict([t(60_000, 'gated'), t(120_000, 'gated')], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ranInWindow).toBe(0);
    expect(v.lastRanAt).toBeNull();
  });
  it('window-bounds the ran tally but lastTickAt is the newest overall', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const v = scoutHealthVerdict([t(dayMs + 60_000, 'ran', 9)], now); // older than 24h
    expect(v.ranInWindow).toBe(0);
    expect(v.transportDeath).toBe(false);
    expect(v.lastTickAt).not.toBeNull();
  });
});

describe('crossesProvenanceDivergenceThreshold — WI-6338 recurrence guard', () => {
  it('below the default threshold does not cross', () => {
    expect(crossesProvenanceDivergenceThreshold(0)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(PROVENANCE_DIVERGENCE_WARN_THRESHOLD)).toBe(false);
  });
  it('above the default threshold crosses', () => {
    expect(crossesProvenanceDivergenceThreshold(PROVENANCE_DIVERGENCE_WARN_THRESHOLD + 0.01)).toBe(true);
    // The live measurement that motivated WI-6338 (422/825 agreed everywhere).
    expect(crossesProvenanceDivergenceThreshold(1 - 422 / 825)).toBe(true);
  });
  it('a custom threshold overrides the default', () => {
    expect(crossesProvenanceDivergenceThreshold(0.5, 0.6)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(0.5, 0.4)).toBe(true);
  });
  it('non-finite input never crosses (fail closed, never a phantom warn)', () => {
    expect(crossesProvenanceDivergenceThreshold(NaN)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(Infinity)).toBe(false);
  });
});

describe('suIdeateVerdict — the su-ideate partition (WI-4465)', () => {
  const now = 1_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const p = (agoMs: number, filed?: number, status = 'ran') => ({ status, ideasRouted: filed, tickAt: new Date(now - agoMs).toISOString() });
  it('counts in-window passes and sums their filed ideas', () => {
    const v = suIdeateVerdict([p(60_000, 3), p(120_000, 2)], now);
    expect(v.passesInWindow).toBe(2);
    expect(v.ideasFiled).toBe(5);
    expect(v.lastPassAt).toBe(now - 60_000);
  });
  it('window-bounds the tally but lastPassAt is the newest pass overall', () => {
    const v = suIdeateVerdict([p(dayMs + 60_000, 9)], now);
    expect(v.passesInWindow).toBe(0);
    expect(v.ideasFiled).toBe(0);
    expect(v.lastPassAt).toBe(now - (dayMs + 60_000));
  });
  it('empty ledger → zeros with a null lastPassAt', () => {
    const v = suIdeateVerdict([], now);
    expect(v).toEqual({ passesInWindow: 0, ideasFiled: 0, lastPassAt: null });
  });
  it('a non-ran row never inflates the pass count', () => {
    const v = suIdeateVerdict([p(60_000, 4, 'gated'), p(120_000, 1)], now);
    expect(v.passesInWindow).toBe(1);
    expect(v.ideasFiled).toBe(1);
  });
});

describe('isLiveRigOnlyFrontierTitle / countStuckFrontier — live-rig/federation false-escalation guard (EI-15329)', () => {
  it('recognizes the actual live-incident titles as live-rig/federation-only', () => {
    expect(isLiveRigOnlyFrontierTitle('Federation peer loses gh auth across VM restart → stays local-only')).toBe(true);
    expect(isLiveRigOnlyFrontierTitle('Federation: late-admitted owner core stalls — replication/fold catches up only on next append')).toBe(true);
    expect(isLiveRigOnlyFrontierTitle('Epoch-key wraps rejected during identity divergence are permanently stranded — silent REV fed_event outage class')).toBe(true);
  });
  it('does NOT flag an ordinary, non-federation title', () => {
    expect(isLiveRigOnlyFrontierTitle('Fix off-by-one in pagination for the plan-items list')).toBe(false);
    expect(isLiveRigOnlyFrontierTitle(undefined)).toBe(false);
  });
  it('countStuckFrontier counts a FRESH (ageDays=0) live-rig-titled row as stuck', () => {
    expect(countStuckFrontier([{ ageDays: 0, title: 'Federation peer loses gh auth across VM restart' }])).toBe(1);
  });
  it('countStuckFrontier still counts age-based stuck rows with no title (prior behaviour preserved)', () => {
    expect(countStuckFrontier([{ ageDays: 1 }, { ageDays: 0 }])).toBe(1);
  });
  // EI-15329 GUARD: a "fresh" (recently-touched) ready frontier that is ENTIRELY
  // live-rig/federation-owned SU-lane work is counted as stuck, not fresh.
  it('GUARD: an all-live-rig, age-fresh frontier is counted as stuck', () => {
    const frontier = [
      { ageDays: 0, title: 'Federation peer loses gh auth across VM restart → stays local-only' },
      { ageDays: 0.01, title: 'Federation: late-admitted owner core stalls on quiescent hives' },
      { ageDays: 0, title: 'Epoch-key wraps rejected during identity divergence — silent REV fed_event outage' },
    ];
    const frontierStuck = countStuckFrontier(frontier);
    expect(frontierStuck).toBe(frontier.length); // every row excluded — none is genuinely fresh
  });
});

describe('computeStalePausedRoutines — stale/unexplained routine pause detector (WI-5839 / EI-18654017982759582 items 2+3)', () => {
  const now = 10_000_000;

  it('flags a paused routine with NO recorded reason, regardless of age (unattributed pause is the bug class)', () => {
    const r = computeStalePausedRoutines([{ name: 'git-sync', updatedAtMs: now - 1000 }], now);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'git-sync', reasonMissing: true, critical: false });
  });

  it('does NOT flag a reasoned pause that is still fresh (within the general threshold)', () => {
    const r = computeStalePausedRoutines(
      [{ name: 'git-sync', pausedAtMs: now - 1000, pauseReason: 'manual deploy-checkout surgery' }],
      now,
    );
    expect(r).toEqual([]);
  });

  it('flags a reasoned pause once it crosses the GENERAL threshold', () => {
    const generalMs = 24 * 60 * 60_000;
    const r = computeStalePausedRoutines(
      [{ name: 'scout-cycle', pausedAtMs: now - generalMs - 1, pauseReason: 'pausing scout during an incident' }],
      now,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'scout-cycle', reasonMissing: false, critical: false });
  });

  it('flags an old acceptance-grading pause when its measured queue is non-empty, preserving the backlog depth', () => {
    const tenDaysMs = 10 * 24 * 60 * 60_000;
    const r = computeStalePausedRoutines(
      [{
        name: 'acceptance-grading-sweep',
        pausedAtMs: now - tenDaysMs,
        pauseReason: 'owner paused background LLM spend',
        backlogDepth: 218,
      }],
      now,
    );
    expect(r).toEqual([expect.objectContaining({
      name: 'acceptance-grading-sweep',
      critical: false,
      backlogDepth: 218,
    })]);
  });

  it('flags a reasoned pause on a RELEASE-CRITICAL routine much sooner (the CRITICAL threshold)', () => {
    const criticalMs = 4 * 60 * 60_000;
    const generalMs = 24 * 60 * 60_000;
    const rows = [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident mitigation' }];
    // Past the critical threshold but nowhere near the general one — still flagged, and marked critical.
    expect(criticalMs).toBeLessThan(generalMs);
    const r = computeStalePausedRoutines(rows, now);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'release-trigger', reasonMissing: false, critical: true });
  });

  it('does NOT flag a fresh reasoned pause on a release-critical routine (within its shorter threshold)', () => {
    const r = computeStalePausedRoutines(
      [{ name: 'green-checkpoint', pausedAtMs: now - 1000, pauseReason: 'holding for a manual migration' }],
      now,
    );
    expect(r).toEqual([]);
  });

  it('falls back to updatedAtMs as the age anchor when pausedAtMs is absent (a legacy pre-fix pause)', () => {
    const generalMs = 24 * 60 * 60_000;
    const r = computeStalePausedRoutines([{ name: 'old-routine', updatedAtMs: now - generalMs - 1 }], now);
    expect(r).toHaveLength(1);
    expect(r[0].ageMs).toBeGreaterThanOrEqual(generalMs);
  });

  it('reports Infinity age (still flagged) when neither pausedAtMs nor updatedAtMs is readable', () => {
    const r = computeStalePausedRoutines([{ name: 'mystery-routine' }], now);
    // Deliberately strict (toEqual, not toMatchObject): this is the one assertion that
    // pins the emitted row SHAPE, so an unintended new field fails here on purpose.
    // `alwaysOnUnreaffirmed` is false because a no-anchor row short-circuits BEFORE the
    // decommissioned cutoff — it is flagged by reasonMissing, never rescued by the
    // EI-18137248342636257 always-on exemption, and the flag means precisely "this row
    // survives ONLY because of that exemption".
    expect(r).toEqual([
      { name: 'mystery-routine', ageMs: Infinity, reasonMissing: true, critical: false, alwaysOnUnreaffirmed: false },
    ]);
  });

  it('sorts critical routines first, then oldest-first within each group', () => {
    const r = computeStalePausedRoutines(
      [
        { name: 'scout-cycle', updatedAtMs: now - 5000 },
        { name: 'release-trigger', updatedAtMs: now - 1000 },
        { name: 'git-sync', updatedAtMs: now - 9000 },
      ],
      now,
    );
    expect(r.map((x) => x.name)).toEqual(['release-trigger', 'git-sync', 'scout-cycle']);
  });

  it('a healthy, unpaused fleet (no rows) → empty', () => {
    expect(computeStalePausedRoutines([], now)).toEqual([]);
  });

  describe('EI-18718973731535914 — a routine dead for WEEKS is decommissioned, not "paused"', () => {
    const decommissionedMs = 7 * 24 * 60 * 60_000;

    it('excludes a routine last touched well past the decommissioned cutoff, even with NO recorded reason', () => {
      // Without the fix, `reasonMissing` alone would ALWAYS flag this (per the rule
      // above) — the exact false-alarm repro: a decommissioned routine (e.g. hive-wake)
      // inactive for 15-48 days, reported forever as an "unattributed pause".
      const r = computeStalePausedRoutines([{ name: 'hive-wake', updatedAtMs: now - decommissionedMs - 1 }], now);
      expect(r).toEqual([]);
    });

    it('still flags a reasonMissing pause that is recent (within the decommissioned cutoff)', () => {
      const r = computeStalePausedRoutines([{ name: 'git-sync', updatedAtMs: now - decommissionedMs + 1 }], now);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'git-sync', reasonMissing: true });
    });

    it('a custom decommissionedMs is honored', () => {
      const oneDayMs = 24 * 60 * 60_000;
      const r = computeStalePausedRoutines(
        [{ name: 'old-routine', updatedAtMs: now - oneDayMs - 1 }],
        now,
        { decommissionedMs: oneDayMs },
      );
      expect(r).toEqual([]);
    });

    it('does NOT exempt a CRITICAL, install-matching pause from reporting, however old — the decommissioned cutoff must never weaken the WI-5839 true-positive path (release-trigger silently paused for days)', () => {
      const tenDaysMs = 10 * 24 * 60 * 60_000; // well past the 7d decommissioned cutoff
      const r = computeStalePausedRoutines(
        [{ name: 'release-trigger', updatedAtMs: now - tenDaysMs, installSlug: 'papercusp' }],
        now,
        { currentInstallSlug: 'papercusp' },
      );
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'release-trigger', critical: true });
    });

    it('DOES exclude a same-named critical routine on a DIFFERENT install once past the cutoff — only the CURRENT install critical pause is exempt from decommissioning', () => {
      const tenDaysMs = 10 * 24 * 60 * 60_000;
      const r = computeStalePausedRoutines(
        [{ name: 'release-trigger', updatedAtMs: now - tenDaysMs, installSlug: 'some-other-hive' }],
        now,
        { currentInstallSlug: 'papercusp' },
      );
      expect(r).toEqual([]);
    });
  });

  describe('EI-18694769501553335 — critical severity is scoped to the CURRENT install, not any row sharing the name', () => {
    it('does NOT escalate to critical a same-named release routine paused on a DIFFERENT install (the false-positive repro)', () => {
      const criticalMs = 4 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        {
          name: 'green-checkpoint',
          pausedAtMs: now - criticalMs - 1,
          pauseReason: 'disposable verify harness, paused on purpose',
          installSlug: 'ei665-verify-x1',
        },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      // Still reported (a real, if unimportant, stale pause) but NOT upgraded to critical —
      // it belongs to a different install and cannot block THIS install's deploy pipeline.
      expect(r[0]).toMatchObject({ name: 'green-checkpoint', critical: false });
    });

    it('DOES escalate to critical when the paused release routine belongs to the CURRENT install', () => {
      const criticalMs = 4 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        {
          name: 'green-checkpoint',
          pausedAtMs: now - criticalMs - 1,
          pauseReason: 'incident mitigation',
          installSlug: 'papercusp',
        },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'green-checkpoint', critical: true });
    });

    it('falls back to name-only matching (pre-fix behavior) when installSlug/currentInstallSlug is unknown — no false negative for callers not yet passing it', () => {
      const criticalMs = 4 * 60 * 60_000;
      // No installSlug on the row, no currentInstallSlug in opts.
      const r1 = computeStalePausedRoutines(
        [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident' }],
        now,
      );
      expect(r1[0]).toMatchObject({ critical: true });

      // installSlug known on the row but currentInstallSlug NOT passed by the caller.
      const r2 = computeStalePausedRoutines(
        [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident', installSlug: 'some-hive' }],
        now,
      );
      expect(r2[0]).toMatchObject({ critical: true });
    });

    it('a NON-critical-named routine paused on a different install is unaffected (still just advisory-eligible by name)', () => {
      const generalMs = 24 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        { name: 'scout-cycle', updatedAtMs: now - generalMs - 1, installSlug: 'ei665-verify-x1' },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'scout-cycle', critical: false });
    });
  });
});

describe('readAcceptanceDrainVisibility — P-027 ledger projection', () => {
  it('keeps awaiting plans visible when no active keyed filing owns them', async () => {
    // WI-10002538: the projection runs the exported, index-pinned SQL text via
    // sql.unsafe (the integration test EXPLAINs that same constant).
    const unsafe = vi.fn(async () => [{
      awaiting: '3',
      with_driver: '1',
      without_driver: '2',
      escalated: '1',
      oldest_plan_updated_at: new Date('2026-09-20T00:00:00.000Z'),
    }]);
    await expect(readAcceptanceDrainVisibility({ unsafe } as never, 'papercusp-workspace')).resolves.toEqual({
      awaiting: 3,
      withDriver: 1,
      withoutDriver: 2,
      escalated: 1,
      oldestPlanUpdatedAt: '2026-09-20T00:00:00.000Z',
    });
    expect(unsafe).toHaveBeenCalledTimes(1);
    expect(unsafe).toHaveBeenCalledWith(ACCEPTANCE_DRAIN_VISIBILITY_SQL, ['papercusp-workspace']);
  });
});

describe('releaseInstallSlug — the health tick asks about the RELEASE install, not the Queen panel pot (EI-20258981691947730)', () => {
  const ENV = 'PAPERCUSP_POT_HOME_SLUG';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  it('resolves the SAME identity the green-checkpoint routine is registered under', async () => {
    const { releaseInstallSlug } = await import('./compute');
    const { operatorHomeHarnessSlug } = await import('../harness/operator-home-harness');
    // release-checkpoint-launch.ts registers the routine row with operatorHomeHarnessSlug().
    // Reading it back under any OTHER identity is the whole defect, so the two must agree.
    process.env[ENV] = 'some-other-home';
    expect(releaseInstallSlug()).toBe(operatorHomeHarnessSlug());
    expect(releaseInstallSlug()).toBe('some-other-home');
  });

  it('never returns null/empty — the pot-registry read could throw, this cannot', async () => {
    const { releaseInstallSlug } = await import('./compute');
    delete process.env[ENV];
    const slug = releaseInstallSlug();
    expect(typeof slug).toBe('string');
    expect(slug.length).toBeGreaterThan(0);
  });

  // WIRING guard. The defect was never in computeStalePausedRoutines (its install-scoping
  // and its deliberate fail-open are both correct and separately tested above) — it was that
  // computeSystemHealth handed it the WRONG VARIABLE: `potSlug`, resolved as "first STARTED
  // pot, else hives[0].slug", which measured 'sb-devboard-hive' on this install. No pure unit
  // test over the detector can catch a caller passing a plausible-but-wrong identity, so the
  // call sites themselves are what gets pinned here.
  it('computeSystemHealth passes releaseInstallSlug() — not potSlug — to BOTH install-scoped readers', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./compute.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/readStalePausedRoutines\(\s*sql,\s*releaseInstallSlug\(\)/);
    expect(src).toMatch(/resolveDeadRoutineOverdueMs\(\s*sql,\s*releaseInstallSlug\(\)/);
    expect(src).not.toMatch(/readStalePausedRoutines\(\s*sql,\s*potSlug/);
    expect(src).not.toMatch(/resolveDeadRoutineOverdueMs\(\s*sql,\s*potSlug/);
  });
});

describe('deadRoutineOverdueMsForCiWindow — dead-routine alarm vs green-checkpoint residual contention (WI-4310)', () => {
  it('widens when a checkpoint run is currently active', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: true, recentCheckpointEventAgeMs: null });
    expect(ms).toBe(20 * 60_000);
  });

  it('widens within the trailing grace after the most recent checkpoint event, even though the run is no longer active', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: 2 * 60_000 });
    expect(ms).toBe(20 * 60_000);
  });

  it('stays at the tight base threshold once the grace window has elapsed', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: 5 * 60_000 + 1 });
    expect(ms).toBe(10 * 60_000);
  });

  it('stays at the tight base threshold with no checkpoint signal at all (the common case)', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: null });
    expect(ms).toBe(10 * 60_000);
  });

  it('respects injected opts over the module defaults', () => {
    const ms = deadRoutineOverdueMsForCiWindow(
      { checkpointActive: true, recentCheckpointEventAgeMs: null },
      { baseMs: 1000, widenedMs: 5000, graceMs: 500 },
    );
    expect(ms).toBe(5000);
  });

  it('the grace boundary is inclusive (age exactly equal to graceMs still widens)', () => {
    const ms = deadRoutineOverdueMsForCiWindow(
      { checkpointActive: false, recentCheckpointEventAgeMs: 500 },
      { graceMs: 500 },
    );
    expect(ms).toBe(20 * 60_000);
  });
});

describe('tallyPlans — queen-plan-selection signal (hive-loop-supervision 2026-06-21)', () => {
  const now = 2_000_000_000;
  it('startedDraft = plans force-started while still draft (the anti-pattern)', () => {
    const v = tallyPlans([
      { status: 'draft', opStatus: 'started' },  // force-started draft — flagged
      { status: 'active', opStatus: 'started' }, // started a ready/active plan — fine
      { status: 'draft', opStatus: null },       // a draft NOT started — fine
    ], now);
    expect(v.startedDraft).toBe(1);
    expect(v.started).toBe(2);
    expect(v.draft).toBe(2);
    expect(v.active).toBe(1);
  });
  it('counts stalled started plans past the aging window', () => {
    const v = tallyPlans([{ status: 'active', opStatus: 'started', opUpdatedAt: new Date(now - 48 * 60 * 60_000).toISOString() }], now);
    expect(v.stalledPlans).toBe(1);
  });
  it('skips archived rows', () => {
    const v = tallyPlans([{ status: 'draft', opStatus: 'started', archived: true }], now);
    expect(v.startedDraft).toBe(0);
    expect(v.started).toBe(0);
  });
  it('tallies item done/total (dropped excluded)', () => {
    const v = tallyPlans([{ status: 'active', items: [{ status: 'done' }, { status: 'todo' }, { status: 'dropped' }] }], now);
    expect(v.itemsDone).toBe(1);
    expect(v.itemsTotal).toBe(2);
  });
});

describe('panelSafe — per-panel fail-soft', () => {
  it('passes a healthy collector through, injecting key + label', async () => {
    const panel = await panelSafe('queen', async () => ({
      status: 'ok' as const,
      summary: 'looping',
      metrics: [{ label: 'last wake', value: '2m ago' }],
      data: { hi: true },
    }));
    // 'queen' stays the stable PanelKey (PANEL_ORDER/UI consumers key on it);
    // the pot-rename shows through the LABEL ('Mug'), not the key.
    expect(panel.key).toBe('queen');
    expect(panel.label).toBe(PANEL_LABELS.queen);
    expect(panel.status).toBe('ok');
    expect(panel.error).toBeUndefined();
    expect(panel.data).toEqual({ hi: true });
  });

  it('greys a throwing collector to unknown + captures the error (never throws)', async () => {
    const panel = await panelSafe('tokens', async () => {
      throw new Error('PG exploded');
    });
    expect(panel.key).toBe('tokens');
    expect(panel.label).toBe(PANEL_LABELS.tokens);
    expect(panel.status).toBe('unknown');
    expect(panel.data).toBeNull();
    expect(panel.error).toContain('PG exploded');
    expect(panel.metrics).toEqual([]);
  });

  it('a non-Error throw still degrades cleanly to unknown', async () => {
    const panel = await panelSafe('deploy', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure';
    });
    expect(panel.status).toBe('unknown');
    expect(panel.error).toBe('string failure');
  });
});

describe('collectDeploy — EI-218 git-sync freshness wiring', () => {
  const now = Date.parse('2026-08-30T06:20:00.000Z');
  const cron = '0 */3 * * * *';

  const ctx = (at = now): Parameters<typeof collectDeploy>[0] => ({
    ws: 'ws-ei-218',
    now: at,
    potSlug: null,
    started: false,
    openPlacements: null,
    gatewayEnabled: false,
    gatewayReachable: null,
    overwatchAlive: null,
    openImprovements: async () => [],
  });

  const routine = (metadata: Record<string, unknown>) => ({
    install_slug: 'home-harness',
    trigger_config: { cron },
    metadata,
    active: true,
  });

  beforeEach(() => {
    sqlMock.mockReset();
    devDeployStateMock.mockReset().mockResolvedValue({
      deployed: { shortSha: 'deployed' },
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: now - 1_000,
      stagingHead: { committedAtMs: now - 1_000 },
      errors: [],
    });
    computeNextFireAtMock.mockReset().mockImplementation((_expression: unknown, from: Date) =>
      new Date(from.getTime() + 3 * 60_000),
    );
  });

  it('overrides a stale raw synced outcome and selects trigger_config for the cadence', async () => {
    sqlMock.mockResolvedValue([
      routine({ last_status: 'synced', last_synced_at: now - 10 * 60_000 }),
    ]);

    const panel = await collectDeploy(ctx());
    expect(panel.status).toBe('warn');
    expect(panel.data).toMatchObject({
      gitSyncStatus: 'degraded',
      gitSyncLastSyncedAtMs: now - 10 * 60_000,
    });
    expect(panel.metrics.find((metric) => metric.label === 'git-sync')).toMatchObject({
      value: 'degraded',
      tone: 'warn',
    });

    const [template] = sqlMock.mock.calls[0] ?? [];
    expect(String((template as TemplateStringsArray).join(' '))).toContain('trigger_config');
    expect(computeNextFireAtMock.mock.calls.map(([expression]) => expression)).toEqual([cron, cron]);
  });

  it('overrides raw synced when a fire is stuck in-flight despite a recent completed outcome', async () => {
    sqlMock.mockResolvedValue([
      routine({
        last_status: 'synced',
        last_synced_at: now - 60_000,
        git_sync_activity: {
          active: true,
          phase: 'push',
          started_at: now - 10 * 60_000,
        },
      }),
    ]);

    const panel = await collectDeploy(ctx());
    expect(panel.status).toBe('warn');
    expect(panel.data).toMatchObject({
      gitSyncStatus: 'degraded',
      gitSyncLastSyncedAtMs: now - 60_000,
    });
  });

  it('preserves a recent raw status when the completed outcome is fresh', async () => {
    sqlMock.mockResolvedValue([
      routine({ last_status: 'synced', last_synced_at: now - 60_000 }),
    ]);

    const panel = await collectDeploy(ctx());
    expect(panel.status).toBe('ok');
    expect(panel.data).toMatchObject({
      gitSyncStatus: 'synced',
      gitSyncLastSyncedAtMs: now - 60_000,
    });
  });

  it('excludes a progressing in-flight fire from the scheduler-starvation alarm candidates', async () => {
    sqlMock.mockResolvedValue([
      {
        ...routine({
          last_status: 'synced',
          last_synced_at: now - 24 * 60_000,
          git_sync_activity: {
            active: true,
            phase: 'local-sync',
            started_at: now - 8 * 60_000,
            last_progress_at: now - 60_000,
          },
        }),
        install_slug: 'progressing-install',
      },
      {
        ...routine({
          last_status: 'synced',
          last_synced_at: now - 18 * 60_000,
          git_sync_activity: {
            active: true,
            phase: 'local-sync',
            started_at: now - 20 * 60_000,
            last_progress_at: now - 12 * 60_000,
          },
        }),
        install_slug: 'stuck-install',
      },
      {
        ...routine({ last_status: 'skipped', last_skip_reason: 'locked-path', last_synced_at: now - 15 * 60_000 }),
        install_slug: 'starved-install',
      },
    ]);

    const panel = await collectDeploy(ctx());
    const data = panel.data as DeployHealth;
    expect(data.gitSyncMissedIntervalsByInstall?.map((entry) => entry.installSlug)).toEqual([
      'stuck-install',
      'starved-install',
    ]);
    expect(data.gitSyncMissedIntervalsByInstall?.map((entry) => entry.missedIntervals)).toEqual([6, 5]);
    // Keep the raw diagnostic max even when it came from the progressing install.
    expect(data.gitSyncMaxMissedIntervals).toBe(8);
  });

  it('re-reads current starvation candidates with the same exclusions as the deploy snapshot', async () => {
    sqlMock.mockResolvedValue([
      {
        ...routine({
          last_status: 'synced',
          last_synced_at: now - 24 * 60_000,
          git_sync_activity: {
            active: true,
            phase: 'local-sync',
            started_at: now - 8 * 60_000,
            last_progress_at: now - 60_000,
          },
        }),
        install_slug: 'progressing-install',
      },
      {
        ...routine({ last_status: 'skipped', last_skip_reason: 'locked-path', last_synced_at: now - 15 * 60_000 }),
        install_slug: 'starved-install',
      },
      {
        ...routine({ last_status: 'error', last_synced_at: now - 30 * 60_000 }),
        install_slug: 'failing-install',
      },
      {
        ...routine({ last_status: 'skipped', last_skip_reason: 'no_path', last_synced_at: now - 30 * 60_000 }),
        install_slug: 'missing-checkout',
      },
    ]);

    await expect(readFreshGitSyncMissedIntervalsByInstall('ws-ei-218', now)).resolves.toEqual([
      { installSlug: 'starved-install', missedIntervals: 5 },
    ]);
    const [template, workspaceId] = sqlMock.mock.calls[0] ?? [];
    expect(String((template as TemplateStringsArray).join(' '))).toContain("target_role = 'system:git-sync'");
    expect(workspaceId).toBe('ws-ei-218');
  });

  it('reports an unreadable live routine read as unknown instead of an empty candidate set', async () => {
    sqlMock.mockRejectedValue(new Error('routine metadata unavailable'));
    await expect(readFreshGitSyncMissedIntervalsByInstall('ws-ei-218', now)).resolves.toBeNull();
  });

  it('keeps the deploy panel fail-soft when the routine metadata read fails', async () => {
    sqlMock.mockRejectedValue(new Error('routine metadata unavailable'));

    const panel = await collectDeploy(ctx());
    expect(panel.status).toBe('ok');
    expect(panel.data).toMatchObject({
      gitSyncStatus: null,
      gitSyncConsecutiveErrorTicks: 0,
      gitSyncPushBacklog: null,
    });
    expect(panel.error).toBeUndefined();
  });

  it('WI-10006867: a vanished checkout (skipped no_path) is reported as checkout-missing, never as missed intervals', async () => {
    // Both rows went quiet 2h ago on a 3-minute cadence, so each derives ~40 missed
    // intervals. Only the no_path row's silence is explained by a vanished checkout;
    // the locked-path control proves the exclusion keys on the skip REASON, not on
    // last_status alone, and that a real starvation reading still gets through.
    const since = now - 2 * 60 * 60_000;
    sqlMock.mockResolvedValue([
      {
        ...routine({
          last_status: 'skipped',
          last_skip_reason: 'no_path',
          last_synced_at: since,
          missing_checkout: { since, path: '/gone/checkout' },
        }),
        install_slug: 'vanished-install',
      },
      {
        ...routine({ last_status: 'skipped', last_skip_reason: 'locked-path', last_synced_at: since }),
        install_slug: 'starved-install',
      },
    ]);

    const panel = await collectDeploy(ctx());
    const data = panel.data as DeployHealth;
    expect(data.gitSyncCheckoutMissingByInstall).toEqual([
      {
        installSlug: 'vanished-install',
        path: '/gone/checkout',
        sinceMs: since,
        retireAtMs: since + GIT_SYNC_MISSING_CHECKOUT_RETIRE_AFTER_MS,
      },
    ]);
    expect((data.gitSyncMissedIntervalsByInstall ?? []).map((entry) => entry.installSlug)).toEqual(['starved-install']);
    expect(data.gitSyncMissedIntervalsInstallSlug).toBe('starved-install');
    expect(data.gitSyncMaxMissedIntervals).toBe(40);
  });

  it('WI-10006867: a no_path row with no recorded missing_checkout still leaves the starvation measure', async () => {
    // Rows skipped by a host that predates the recorder carry no missing_checkout key.
    // They must still be kept out of missed intervals, reported with unknown since/path.
    sqlMock.mockResolvedValue([
      routine({ last_status: 'skipped', last_skip_reason: 'no_path', last_synced_at: now - 2 * 60 * 60_000 }),
    ]);

    const panel = await collectDeploy(ctx());
    const data = panel.data as DeployHealth;
    expect(data.gitSyncCheckoutMissingByInstall).toEqual([
      { installSlug: 'home-harness', path: null, sinceMs: null, retireAtMs: null },
    ]);
    expect(data.gitSyncMissedIntervalsByInstall).toEqual([]);
    expect(data.gitSyncMaxMissedIntervals).toBeNull();
  });

  it('WI-10006803: a hung push-backlog probe never holds the deploy leg past the reader deadline', async () => {
    // With push errors present (consecutive_error_ticks > 0) collectDeploy consults the
    // live push backlog. The probe behind it is ~117 serial git spawns on a big tree
    // (39-75s per tick measured on bg-host, 2026-10-06). Hang it outright: the panel must
    // settle at the reader's cold-miss deadline with the backlog unknown and the error
    // ticks kept. Awaiting the probe directly (the pre-fix wiring) never settles here.
    // A unique slug keeps the hung single-flight entry out of every other test's key.
    const slug = 'wi-10006803-hung-probe';
    projectDirForSlugMock.mockReset().mockImplementation(() => new Promise<string | null>(() => {}));
    sqlMock.mockResolvedValue([
      {
        ...routine({ last_status: 'error', last_synced_at: now - 60_000, consecutive_error_ticks: 2 }),
        install_slug: slug,
      },
    ]);

    // Real timers: collectDeploy reaches the probe through dynamic imports, which load in
    // real time, so fake time cannot order "probe entered" before "deadline fired".
    // Pre-load both modules so the measured window is the deadline, not module loading.
    await import('../agent-tools/routines/list');
    await import('../operator-notes');
    const startedAt = performance.now();
    const panel = await collectDeploy(ctx());
    const elapsedMs = performance.now() - startedAt;

    // Upper bound only: libuv arms setTimeout from the loop's cached time, so under load
    // the deadline can fire before performance.now() shows the full window. The guard is
    // that the leg settles at all; the pre-fix wiring never does.
    expect(projectDirForSlugMock).toHaveBeenCalledWith(slug);
    expect(elapsedMs).toBeLessThan(PUSH_BACKLOG_DEADLINE_MS + 5_000);
    expect(panel.data).toMatchObject({
      gitSyncPushBacklog: null,
      gitSyncConsecutiveErrorTicks: 2,
    });
  }, 20_000);
});

describe('computeEscalationsHealth — operational flood excluded (EI-1490)', () => {
  const NOW = Date.parse('2026-06-18T12:00:00Z');
  const OLD = '2026-06-15T00:00:00Z'; // ~3.5d old → past the 6h aging threshold
  const FRESH = '2026-06-18T11:30:00Z'; // 30m old → under the threshold

  // The live bug: ~13k system:hive-placement-watchdog escalations (system sender,
  // no options) inflate `aging` to an impossible "13,246 aging past threshold".
  function flood(n: number): EscalationAgingInput[] {
    return Array.from({ length: n }, () => ({
      from: 'system:hive-placement-watchdog',
      severity: 'advisory',
      ts: OLD,
    }));
  }

  it('excludes operational escalations from open/aging/bySeverity', () => {
    const h = computeEscalationsHealth(flood(13_246), NOW);
    expect(h.open).toBe(0);
    expect(h.aging).toBe(0);
    expect(h.oldestAgeMs).toBeNull();
    expect(h.bySeverity).toEqual({});
  });

  it('counts only genuine human-decision escalations (agent sender / options)', () => {
    const open: EscalationAgingInput[] = [
      ...flood(500),
      { from: 's-agent-1', severity: 'blocker', ts: OLD }, // aged human decision
      { from: 's-agent-2', severity: 'question', ts: FRESH }, // fresh human decision
      // a system sender WITH options is a real choice → human-attention
      { from: 'system:queen', options: [{ id: 'a', label: 'A' }], severity: 'advisory', ts: OLD },
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.open).toBe(3);
    expect(h.aging).toBe(2); // the two OLD ones; the FRESH one is under threshold
    expect(h.agingNew).toBe(0); // both crossed the threshold DAYS ago — standing, not new
    expect(h.bySeverity).toEqual({ blocker: 1, question: 1, advisory: 1 });
  });

  it('agingNew counts only escalations that crossed the threshold in the last 24h (health-tab-v2 P-003)', () => {
    const open: EscalationAgingInput[] = [
      // aged 7h → crossed the 6h threshold ~1h ago → NEW aging
      { from: 's-agent-1', severity: 'question', ts: new Date(NOW - 7 * 60 * 60_000).toISOString() },
      // aged ~3.5d → crossed days ago → standing aging only
      { from: 's-agent-2', severity: 'warning', ts: OLD },
      { from: 's-agent-3', severity: 'info', ts: FRESH }, // not aged at all
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.aging).toBe(2);
    expect(h.agingNew).toBe(1);
  });

  it('no escalations → clean zeroed panel', () => {
    const h = computeEscalationsHealth([], NOW);
    expect(h).toEqual({ open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, agingNew: 0 });
  });
});

describe('probeGatewayHealthz retry (EI-1693 sibling — one transient timeout is not "down")', () => {
  const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

  it('a transient timeout THEN a success → reachable (true)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (n++ === 0) throw timeoutErr();
        return { status: 200 } as Response;
      }));
      const p = probeGatewayHealthz([5, 50]);
      await vi.runAllTimersAsync(); // advance the inter-attempt backoff
      expect(await p).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('all escalating attempts fail → unreachable (false)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => { throw timeoutErr(); }));
      const p = probeGatewayHealthz([5, 5]);
      await vi.runAllTimersAsync();
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('toolEfficiencyStatus — WI-839 tool-efficiency panel status fold', () => {
  it('any leg broken → crit, regardless of the others', () => {
    expect(toolEfficiencyStatus(['broken', 'healthy', 'unknown'])).toBe('crit');
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'broken'])).toBe('crit');
  });
  it('no broken but any degraded → warn', () => {
    expect(toolEfficiencyStatus(['degraded', 'healthy', 'unknown'])).toBe('warn');
  });
  it('every leg unknown (all windows too small to grade) → unknown, not ok', () => {
    expect(toolEfficiencyStatus(['unknown', 'unknown', 'unknown'])).toBe('unknown');
  });
  it('all healthy (some possibly unknown) → ok', () => {
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'healthy'])).toBe('ok');
    expect(toolEfficiencyStatus(['healthy', 'unknown', 'healthy'])).toBe('ok');
  });
  it('broken beats degraded beats unknown-only (precedence order)', () => {
    expect(toolEfficiencyStatus(['broken', 'degraded'])).toBe('crit');
    expect(toolEfficiencyStatus(['degraded', 'unknown'])).toBe('warn');
  });
});

describe('computeAccountsAvailable — starvation-watchdog false-positive fix (EI-15875)', () => {
  const NOW = 1_784_000_000_000;

  function account(id: string, overrides: Partial<ClaudeAccount['rate']> = {}): ClaudeAccount {
    return {
      id,
      credentialRef: `token:${id}`,
      addedAt: NOW - 1000,
      boundTo: [],
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, ...overrides },
    };
  }

  it('a plain healthy account (no pause, no usage-wall, no edge-throttle) is available', () => {
    const r = computeAccountsAvailable([account('a1')], null, NOW);
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 1, accountsPaused: 0 });
  });

  it('a rate-paused account is excluded (unchanged pre-existing behavior)', () => {
    const r = computeAccountsAvailable(
      [account('a1', { pausedUntil: NOW + 60_000 })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('EI-15875 core bug: a weekly-usage-walled account with NO active pause is excluded, not counted as idle-healthy', () => {
    // pausedUntil: 0 (never set / already lapsed), but util7d is at cap and the window has not
    // reset yet — exactly the 2026-07-18 false-positive shape (5 accounts read this way as spare
    // capacity by the OLD pause-only check).
    const r = computeAccountsAvailable(
      [account('a1', {
        pausedUntil: 0,
        utilization7d: 0.98,
        utilizationAt: NOW - 1000,
        windowResetAt7d: NOW + 3 * 24 * 60 * 60_000,
      })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('a usage-walled account becomes available again once its window has reset', () => {
    const r = computeAccountsAvailable(
      [account('a1', {
        pausedUntil: 0,
        utilization7d: 0.98,
        utilizationAt: NOW - 1000,
        windowResetAt7d: NOW - 1000, // already past — window reset
      })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 1, accountsPaused: 0 });
  });

  it('a live edge-throttled account (no pause, no usage-wall) is excluded too', () => {
    const r = computeAccountsAvailable(
      [account('a1')],
      { edgeThrottleByAccount: { a1: { edgeThrottled: true } } },
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('mixed pool: only the genuinely-servable accounts count as available (mirrors the 2026-07-18 incident: 2/8 usable)', () => {
    const accounts = [
      account('usable-1'),
      account('usable-2'),
      account('paused', { pausedUntil: NOW + 60_000 }),
      account('walled-1', { utilization7d: 0.97, utilizationAt: NOW - 1000, windowResetAt7d: NOW + 100_000 }),
      account('walled-2', { utilization7d: 0.99, utilizationAt: NOW - 1000, windowResetAt7d: NOW + 100_000 }),
      account('edge-throttled'),
    ];
    const r = computeAccountsAvailable(
      accounts,
      { edgeThrottleByAccount: { 'edge-throttled': { edgeThrottled: true } } },
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 6, accountsAvailable: 2, accountsPaused: 4 });
  });

  it('a null gateway snapshot (gateway unreachable) never throws — edge-throttle just reads as unknown/false', () => {
    expect(() => computeAccountsAvailable([account('a1')], null, NOW)).not.toThrow();
  });
});

describe('computeProjectionFreshestAgeMs — the independent gateway-DB-loss leg (EI-19303809952284205)', () => {
  const NOW = 1_784_000_000_000;

  function account(id: string, overrides: Partial<ClaudeAccount['rate']> = {}): ClaudeAccount {
    return {
      id,
      credentialRef: `token:${id}`,
      addedAt: NOW - 1000,
      boundTo: [],
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, ...overrides },
    };
  }

  it('null when no account has ever been observed — a fresh pool is not a fault', () => {
    expect(computeProjectionFreshestAgeMs([account('a1'), account('a2')], NOW)).toBeNull();
  });

  it('null on an empty pool', () => {
    expect(computeProjectionFreshestAgeMs([], NOW)).toBeNull();
  });

  it('measures the age of the single observed reading', () => {
    expect(computeProjectionFreshestAgeMs([account('a1', { utilizationAt: NOW - 90_000 })], NOW)).toBe(90_000);
  });

  it('takes the FRESHEST reading, not the oldest — a starved account must not fabricate an alarm', () => {
    // The live 2026-08-01 case: aviynw10's egress proxy was transport-failing, so NO traffic reached
    // it and its reading sat hours old while the write path was perfectly healthy (the owner flagged
    // this as unrelated pre-existing noise). Taking the max here would alarm on it every single tick.
    const age = computeProjectionFreshestAgeMs(
      [
        account('aviynw10', { utilizationAt: NOW - 8 * 60 * 60_000 }), // starved: no traffic reaching it
        account('aviynw3', { utilizationAt: NOW - 45_000 }), // busy: written 45s ago
      ],
      NOW,
    );
    expect(age).toBe(45_000);
  });

  it('reports a large age only when NOTHING anywhere has moved — the real write-path-dead condition', () => {
    const age = computeProjectionFreshestAgeMs(
      [
        account('a1', { utilizationAt: NOW - 5 * 60 * 60_000 }),
        account('a2', { utilizationAt: NOW - 6 * 60 * 60_000 }),
      ],
      NOW,
    );
    expect(age).toBe(5 * 60 * 60_000);
  });

  it('ignores accounts with no reading when others have one', () => {
    expect(
      computeProjectionFreshestAgeMs([account('a1'), account('a2', { utilizationAt: NOW - 1000 })], NOW),
    ).toBe(1000);
  });

  it('clamps a future-dated reading to 0 rather than reporting a negative age', () => {
    expect(computeProjectionFreshestAgeMs([account('a1', { utilizationAt: NOW + 5_000 })], NOW)).toBe(0);
  });
});

describe('mergeHealthPanels — push-on-write merge for the health-tab cache (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013)', () => {
  function fixturePanel(key: PanelKey, status: PanelStatus): HealthPanel<unknown> {
    return { key, label: PANEL_LABELS[key], status, summary: `${key}:${status}`, metrics: [], data: null };
  }

  /** A full 20-panel snapshot, every panel 'ok' unless overridden. */
  function fixtureSnapshot(overrides: Partial<Record<PanelKey, PanelStatus>> = {}): SystemHealth {
    const panels = {} as SystemHealthPanels;
    for (const key of PANEL_ORDER) {
      (panels as Record<PanelKey, HealthPanel<unknown>>)[key] = fixturePanel(key, overrides[key] ?? 'ok');
    }
    return {
      workspaceId: 'ws-test',
      evaluatedAt: 0,
      overall: 'ok',
      crossMonitor: { queenAlive: false, overwatchAlive: null },
      panels,
    };
  }

  it('replaces only the named panel(s), leaving every other panel byte-identical', () => {
    const snap = fixtureSnapshot();
    const freshObservations = fixturePanel('observations', 'warn');
    mergeHealthPanels(snap, { observations: freshObservations }, 123);
    expect(snap.panels.observations).toBe(freshObservations);
    expect(snap.panels.autonomy.status).toBe('ok');
    expect(snap.panels.improvements.status).toBe('ok');
  });

  it('re-derives `overall` as the worst status across ALL panels, not just the merged one', () => {
    // infra is pre-existing crit; merging a mere 'warn' into observations must
    // not downgrade overall away from that crit (the P-013 bug this guards:
    // partial-panel merges must never blind the aggregator to an untouched
    // panel's worse status).
    const snap = fixtureSnapshot({ infra: 'crit' });
    mergeHealthPanels(snap, { observations: fixturePanel('observations', 'warn') }, 999);
    expect(snap.overall).toBe('crit');
  });

  it('a merged panel recovering to ok brings `overall` back down when nothing else is worse', () => {
    const snap = fixtureSnapshot({ improvements: 'crit' });
    mergeHealthPanels(snap, { improvements: fixturePanel('improvements', 'ok') }, 111);
    expect(snap.overall).toBe('ok');
  });

  it('a merged panel escalating to crit raises `overall` even though it started ok', () => {
    const snap = fixtureSnapshot();
    mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'crit') }, 222);
    expect(snap.overall).toBe('crit');
  });

  it('stamps `evaluatedAt` to the merge time so the tab treats the snapshot as fresh', () => {
    const snap = fixtureSnapshot();
    mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'ok') }, 42424);
    expect(snap.evaluatedAt).toBe(42424);
  });

  it('mutates the snapshot in place AND returns it (same reference)', () => {
    const snap = fixtureSnapshot();
    const returned = mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'warn') }, 1);
    expect(returned).toBe(snap);
  });
});

describe('systemHealthGitSidecarEnabled — WI-7160 (git-spawn stalls the main thread)', () => {
  // This collector's `runGit` fans out to several `git` execs per tick (fetch +
  // 2x rev-parse/rev-list per repo/submodule via gitAheadCount) — a live profile
  // attributed 20.8% of a stalled main thread's spawn time to it, the same
  // fork()-cost-scales-with-parent-RSS mechanism EI-18808838427010743 documents.
  // These pin the enable-decision wiring (mirrors git-via-sidecar.test.ts's
  // coverage of the shared primitive) so a future edit can't silently detach
  // this call site from its own opt-in var.
  it('is OFF when nothing is set (the sidecar is opt-in, same default as every other caller)', () => {
    expect(systemHealthGitSidecarEnabled({})).toBe(false);
  });

  it('ignores an inherited shared enable var unless this process is marked as the host', () => {
    try {
      expect(systemHealthGitSidecarEnabled({ PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(false);
      markSpawnOffloadHost();
      expect(systemHealthGitSidecarEnabled({ PAPERCUSP_SPAWNER_SIDECAR: '1' })).toBe(true);
    } finally {
      resetSpawnOffloadHostForTest();
    }
  });

  it("this caller's own explicit var can force it ON while the shared var is unset", () => {
    expect(systemHealthGitSidecarEnabled({ PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '1' })).toBe(true);
  });

  it("this caller's own explicit var can force it OFF while the shared var is ON (per-subsystem bisect)", () => {
    expect(
      systemHealthGitSidecarEnabled({
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR: '0',
      }),
    ).toBe(false);
  });

  it('is OFF inside the sidecar process itself (recursion guard), even with the enable var set', () => {
    expect(
      systemHealthGitSidecarEnabled({
        PAPERCUSP_SPAWNER_SIDECAR: '1',
        PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
      }),
    ).toBe(false);
  });
});

describe('summarizeDeadRoutines — census vs. exemplar list (EI-20045691451471399)', () => {
  const many = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("carries the caller's TRUE count through, never names.length", () => {
    // The exact wild misreport: 101 genuinely overdue, a far shorter exemplar list.
    const c = summarizeDeadRoutines(many(101), { count: 101, totalInScope: 151 });
    expect(c.count).toBe(101);
    expect(c.totalInScope).toBe(151);
    expect(c.names.length).toBeLessThan(101);
    expect(c.namesTruncated).toBe(true);
  });

  it('hoists fleet-blocking routines ahead of merely-more-overdue bystanders', () => {
    // Input order IS most-overdue-first, so git-sync/green-checkpoint arrive LAST here — the
    // shape that buried git-sync behind pr-poll in the filed incident.
    const overdue = [...many(8, 'bystander'), 'green-checkpoint', 'git-sync'];
    const c = summarizeDeadRoutines(overdue, { count: 10, totalInScope: 12 });
    expect(c.names.slice(0, 2)).toEqual(['green-checkpoint', 'git-sync']);
    // Reported in FULL even though the exemplar list is capped: a cap must never be able to
    // hide the member that explains the blast radius.
    expect(c.criticalNames).toEqual(['green-checkpoint', 'git-sync']);
  });

  it('marks the list truncated when the population exceeds what is named, even under a truncated census', () => {
    // Census hit its own fetch cap: 3 names came back, but the count says 500 are overdue.
    const c = summarizeDeadRoutines(many(3), { count: 500, totalInScope: 600, censusTruncated: true });
    expect(c.count).toBe(500);
    // The 3 fetched names fit the cap, so the distinct-vs-named comparison alone says
    // "complete" — but a truncated census proves more names exist that were never fetched.
    expect(c.namesTruncated).toBe(true);
    expect(c.censusTruncated).toBe(true);
  });

  it('reports an untruncated list when every overdue routine is named', () => {
    const c = summarizeDeadRoutines(['pr-poll'], { count: 1, totalInScope: 151 });
    expect(c.names).toEqual(['pr-poll']);
    expect(c.namesTruncated).toBe(false);
    expect(c.criticalNames).toEqual([]);
  });

  it('DEDUPES names — one row per install must not fill the exemplar list with one routine', () => {
    // Live shape, 2026-08-10: git-sync 59 rows, cross-hive-outbox-drain 24, green-checkpoint 13.
    // Undeduped, the whole exemplar list reads "git-sync, git-sync, git-sync, …" and every other
    // routine disappears — strictly worse than the arbitrary ordering this replaced.
    const rows = [
      ...Array(59).fill('git-sync'),
      ...Array(24).fill('cross-hive-outbox-drain'),
      ...Array(13).fill('green-checkpoint'),
      'pr-poll',
    ];
    const c = summarizeDeadRoutines(rows, { count: rows.length, totalInScope: 144 });
    expect(c.names).toEqual(['git-sync', 'green-checkpoint', 'cross-hive-outbox-drain', 'pr-poll']);
    expect(c.criticalNames).toEqual(['git-sync', 'green-checkpoint']);
    // count stays in ROWS (the true magnitude); distinctCount is the unit `names` is measured in.
    expect(c.count).toBe(97);
    expect(c.distinctCount).toBe(4);
    expect(c.namesTruncated).toBe(false); // all 4 distinct names fit — despite 97 overdue rows
  });

  it('keeps the fleet-blocking set as the release-critical set plus git-sync', () => {
    // Pinned because the consequence-ordering fix is worthless if git-sync silently drops out
    // of this set in a later refactor — the failure would be invisible until the next freeze.
    expect([...FLEET_BLOCKING_ROUTINE_NAMES].sort()).toEqual(['git-sync', 'green-checkpoint', 'release-trigger']);
  });

  it('carries per-name overdue/active coverage separately from row and exemplar counts', () => {
    const c = summarizeDeadRoutines(
      ['git-sync', 'git-sync', 'pr-poll'],
      { count: 3, totalInScope: 74 },
      { routineCoverage: { 'git-sync': { overdue: 2, active: 70 }, 'pr-poll': { overdue: 1, active: 1 } } },
    );
    expect(c.routineCoverage).toEqual({
      'git-sync': { overdue: 2, active: 70 },
      'pr-poll': { overdue: 1, active: 1 },
    });
  });
});
