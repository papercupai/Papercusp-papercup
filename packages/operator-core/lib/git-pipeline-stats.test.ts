/**
 * git-pipeline-stats.test.ts — pure unit coverage for the aggregator's helpers
 * (resolver-model resolution + routine-row mapping). The full snapshot read is
 * exercised against real Postgres via the pipeline-events integration test +
 * verified live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const routineSql = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: routineSql }),
}));
import {
  readPipelineRoutineControl,
  readReleaseTriggerControl,
  resolverModel,
  summarizeGateFireHistory,
  toRoutineInfo,
  pinProvenGateCorrection,
  mapActiveRun,
  applyCheckpointProcessAuthority,
  selectActiveCheckpointRoot,
  pickRetriageVerdict,
  projectGreenCheckpointFireFreshness,
  projectGreenCheckpointPause,
  GIT_SYNC_CONFLICT_MAX_AGE_MS,
  isGitSyncConflictCurrent,
  currentGateInconclusive,
  projectFrozenRepairQueueRead,
  projectGateCandidateSnapshot,
  projectGatePromotionIdentity,
  gateFailingTestsMeasurement,
  deriveInRoutineGateStalled,
  combineGateStallSignals,
  skippedPathArr,
  contentErrorArr,
  type RawGateCounters,
} from './git-pipeline-stats';
import { decideStallNotification } from './release/stall-escalation-ladder';
import type { PipelineEventRow } from './harness/git-sync/pipeline-events';
import { buildCandidateSnapshot } from './release/candidate-snapshot';

describe('strict pipeline routine control reads', () => {
  afterEach(() => routineSql.mockReset());

  it('returns absence only after the exact checkpoint configuration query succeeds', async () => {
    routineSql.mockResolvedValue([]);
    expect(await readPipelineRoutineControl('customer', 'green-checkpoint')).toBeNull();
    const [query, slug, name] = routineSql.mock.calls[0]!;
    expect(query.join('?')).toContain('FROM harness_shared.routines');
    expect(query.join('?')).toContain('install_slug = ?');
    expect(query.join('?')).toContain('name = ?');
    expect([slug, name]).toEqual(['customer', 'green-checkpoint']);
  });

  it('does not turn a failed checkpoint configuration read into absence', async () => {
    routineSql.mockRejectedValue(new Error('routine query failed'));
    await expect(readPipelineRoutineControl('customer', 'green-checkpoint')).rejects.toThrow('routine query failed');
  });

  it('retains the release-trigger control reader and inactive routine evidence', async () => {
    routineSql.mockResolvedValue([{ name: 'release-trigger', active: false }]);
    expect(await readReleaseTriggerControl('customer')).toMatchObject({ name: 'release-trigger', active: false });
    expect(routineSql.mock.calls[0]!.slice(1)).toEqual(['customer', 'release-trigger']);
  });
});

describe('gitPipelineSnapshot latency topology', () => {
  it('starts every independent snapshot read before consuming the routines result', () => {
    const source = readFileSync(new URL('./git-pipeline-stats.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export async function gitPipelineSnapshot(');
    const end = source.indexOf('\n/**', start + 1);
    const body = source.slice(start, end < 0 ? undefined : end);
    const firstConsumption = body.indexOf('const routineRows = await routineRowsPromise;');

    expect(firstConsumption).toBeGreaterThan(0);
    for (const declaration of [
      'const routineRowsPromise =',
      'const openConflictRowsPromise =',
      'const dayPromise =',
      'const weekPromise =',
      'const recentPromise =',
      'const deployPromise =',
      'const fireHistoryPromise =',
    ]) {
      expect(body.indexOf(declaration)).toBeGreaterThan(0);
      expect(body.indexOf(declaration)).toBeLessThan(firstConsumption);
    }
  });
});

describe('checkpoint fire history', () => {
  it('keeps fires, verdict records, no-verdict aborts and skipped starts distinct across UTC day boundaries', () => {
    const days = [
      { fires: 30, verdictsGreen: 0, verdictsRed: 0, noVerdicts: 2, skips: 20 },
      { fires: 44, verdictsGreen: 0, verdictsRed: 0, noVerdicts: 5, skips: 26 },
    ] as Parameters<typeof summarizeGateFireHistory>[0];
    expect(summarizeGateFireHistory(days)).toEqual({
      windowHours: 24, fires: 74, verdictRecords: 0, noVerdictAborts: 7, skippedStarts: 46,
    });
    expect(summarizeGateFireHistory([])).toEqual({
      windowHours: 24, fires: 0, verdictRecords: 0, noVerdictAborts: 0, skippedStarts: 0,
    });
  });
});

describe('resolverModel', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads the merge-resolver spec from AGENT_MODELS', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus', 'merge-resolver': 'opus:xhigh' }));
    expect(resolverModel()).toBe('opus:xhigh');
  });

  it('falls back to the committed default when unset or malformed', () => {
    vi.stubEnv('AGENT_MODELS', '');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', '{not json');
    expect(resolverModel()).toBe('opus:xhigh');
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ worker: 'opus' })); // no merge-resolver key
    expect(resolverModel()).toBe('opus:xhigh');
  });
});

describe('D-013/P-011 gate promotion identity', () => {
  it('projects the judged candidate and the main pin written beside that verdict', () => {
    expect(
      projectGatePromotionIdentity({
        observedCandidate: 'candidate-judged',
        lastMainPin: 'main-after-verdict',
      }),
    ).toEqual({
      observedCandidate: 'candidate-judged',
      lastMainPin: 'main-after-verdict',
    });
  });

  it('preserves unknown instead of substituting the staging or green pin', () => {
    expect(projectGatePromotionIdentity({ observedCandidate: '', lastMainPin: 42 })).toEqual({
      observedCandidate: null,
      lastMainPin: null,
    });
    expect(projectGatePromotionIdentity(null)).toEqual({
      observedCandidate: null,
      lastMainPin: null,
    });
  });
});

describe('EI-22344736163383832 canonical candidate snapshot projection', () => {
  const snapshot = buildCandidateSnapshot(
    {
      candidate: 'a'.repeat(40),
      base: 'b'.repeat(40),
      runId: 'run-1',
      source: 'pinned',
      selectedAtMs: 123,
      candidateCommittedAt: '2026-09-04T12:00:00.000Z',
      commitsBehindTip: 2,
      failingTests: ['packages/example.test.ts'],
      failingTestsMeasured: true,
      postSuiteMeasured: true,
      postSuiteLegs: [{ id: 'typecheck', status: 'passed', durationMs: 10 }],
      repairQueue: {
        candidate: 'a'.repeat(40),
        repairHead: 'c'.repeat(40),
        phase: 'awaiting-fixer',
        fixerSpawnId: 'fixer-1',
      },
      retriage: { classification: 'real-red', tip: 'd'.repeat(40) },
    },
    456,
  );

  it('projects only the parsed canonical snapshot from gate_health', () => {
    expect(projectGateCandidateSnapshot({ candidateSnapshot: snapshot })).toEqual(snapshot);
  });

  it('fails closed for absent or malformed snapshot values', () => {
    expect(projectGateCandidateSnapshot({})).toBeNull();
    expect(
      projectGateCandidateSnapshot({
        candidateSnapshot: { ...snapshot, identity: 'torn' },
      }),
    ).toBeNull();
  });
});

describe('currentGateInconclusive', () => {
  const mismatch = {
    status: 'repair-staging-mismatch',
    candidate: 'a'.repeat(40),
    detail: 'repair patch is not on staging',
    observedAtMs: 123,
  };

  it('suppresses a stale repair-owned hold once the authoritative queue is absent', () => {
    expect(currentGateInconclusive(mismatch, null)).toBeNull();
    expect(currentGateInconclusive({ ...mismatch, status: 'repair-in-progress' }, undefined)).toBeNull();
  });

  it('preserves repair holds while any queue payload remains', () => {
    expect(currentGateInconclusive(mismatch, { phase: 'ready-to-verify' })).toMatchObject(mismatch);
  });

  it('P-003 projects frozenCandidate and repairHead separately for a no-suite repair hold', () => {
    const queue = {
      schemaVersion: 3,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      base: 'b'.repeat(40),
      repairHead: 'c'.repeat(40),
      worktreePath: '/tmp/repair',
      attempts: 1,
      openedAtMs: 1,
      updatedAtMs: 2,
      fixerSpawnId: 'fixer-1',
      failingTests: ['lib/broken.test.ts'],
    };
    const result = currentGateInconclusive(
      { status: 'repair-in-progress', candidate: queue.repairHead, detail: 'no suite ran', observedAtMs: 3 },
      queue,
    );
    expect(result).toMatchObject({
      status: 'repair-in-progress',
      candidate: queue.candidate,
      frozenCandidate: queue.candidate,
      repairHead: queue.repairHead,
      phase: queue.phase,
      verdictProvenance: {
        frozenCandidateVerdict: 'full-gate-red',
        repairHeadVerdict: 'not-judged',
      },
    });
  });

  it('preserves non-repair aborts independently of the repair queue', () => {
    expect(currentGateInconclusive({ ...mismatch, status: 'migrations-pending' }, null)).toMatchObject({
      ...mismatch,
      status: 'migrations-pending',
    });
  });
});

describe('projectFrozenRepairQueueRead — P-025', () => {
  it('exposes a current-plus-one queue as unreadable instead of null/none', () => {
    const projected = projectFrozenRepairQueueRead(
      { schemaVersion: 5, candidate: 'a'.repeat(40) },
      {
        freezeAndConverge: {
          enabled: true,
          state: 'none',
          reason: 'no candidate is frozen this tick',
          candidate: null,
          holdUntilMs: null,
          capacityRetryAtMs: null,
          observedAtMs: 1,
        },
      },
      123,
    );
    expect(projected.queue).toBeNull();
    expect(projected.read).toEqual({
      status: 'unreadable',
      reason: 'schema-newer-than-reader',
      schemaVersion: 5,
      candidate: 'a'.repeat(40),
      repairHead: null,
      phase: null,
    });
    expect(projected.freezeAndConverge).toMatchObject({
      state: 'unreadable',
      observedAtMs: 123,
    });
    expect(projected.freezeAndConverge?.reason).toContain('refusing to report');
  });

  it('keeps true absence distinct and normalizes unavailable repair latency to null', () => {
    const stored = {
      freezeAndConverge: {
        enabled: true,
        state: 'none' as const,
        reason: 'nothing frozen',
        candidate: null,
        holdUntilMs: null,
        capacityRetryAtMs: null,
        observedAtMs: 1,
      },
    };
    const projected = projectFrozenRepairQueueRead(null, stored, 123);
    expect(projected.read).toEqual({ status: 'absent' });
    expect(projected.freezeAndConverge).toEqual({
      ...stored.freezeAndConverge,
      queuePhase: null,
      blockedBy: null,
      repairLatency: null,
    });
  });
});

describe('gateFailingTestsMeasurement (EI-21561093776434695)', () => {
  const inconclusive = {
    status: 'migrations-pending',
    candidate: 'deadbeefcafe',
    detail: 'migration preflight aborted before the suite',
    observedAtMs: 123,
  };

  it('marks a pre-suite abort unmeasured and suppresses any inherited failure names', () => {
    expect(
      gateFailingTestsMeasurement({
        failingTests: ['historical-red.test.ts'],
        measured: false,
        inconclusive,
      }),
    ).toEqual({ failingTests: [], measured: false, provenance: 'not-measured' });
  });

  it('keeps a real measured empty verdict distinct from an abort', () => {
    expect(
      gateFailingTestsMeasurement({ failingTests: [], measured: true, inconclusive: null }),
    ).toEqual({ failingTests: [], measured: true, provenance: 'measured' });
  });

  it('derives compatibility-safe states for legacy blobs', () => {
    expect(
      gateFailingTestsMeasurement({ failingTests: [], measured: undefined, inconclusive: null }),
    ).toEqual({ failingTests: [], measured: true, provenance: 'measured' });
    expect(
      gateFailingTestsMeasurement({ failingTests: undefined, measured: undefined, inconclusive: null }),
    ).toEqual({ failingTests: [], measured: null, provenance: 'unknown' });
    expect(
      gateFailingTestsMeasurement({ failingTests: [], measured: undefined, inconclusive }),
    ).toEqual({ failingTests: [], measured: false, provenance: 'not-measured' });
  });

  it('WI-2143266: preserves an explicitly-measured, populated list during an open repair instead of erasing it', () => {
    // Live 2026-09-03 reading: gate_health carried failingTestsMeasured:true with two
    // named legs while inconclusive.status was 'repair-in-progress' (non-null) — the
    // whole duration of a frozen repair. The old code discarded the list here, so the
    // reader-facing owner brief reported "nothing failing" on a gate that was red.
    expect(
      gateFailingTestsMeasurement({
        failingTests: ['lint:design-primitives', 'lint:plane-integrity'],
        measured: true,
        inconclusive: { ...inconclusive, status: 'repair-in-progress' },
      }),
    ).toEqual({
      failingTests: ['lint:design-primitives', 'lint:plane-integrity'],
      measured: true,
      provenance: 'measured',
    });
  });

  it('P-005: preserves an unstamped populated list during an inconclusive hold and labels it carried', () => {
    const input = {
      failingTests: ['lint:design-primitives', 'lint:plane-integrity'],
      measured: undefined,
      inconclusive: { ...inconclusive, status: 'repair-in-progress' },
    };

    expect(gateFailingTestsMeasurement(input)).toEqual({
      failingTests: ['lint:design-primitives', 'lint:plane-integrity'],
      measured: null,
      provenance: 'carried',
    });

    // Permanent deliberately-wrong control: this is the pre-P-005 predicate. It
    // proves the same fixture really would have been erased, rather than merely
    // asserting the new output in isolation.
    const preP005Blanking = input.inconclusive !== null
      ? { failingTests: [] as string[], measured: false }
      : { failingTests: input.failingTests, measured: true };
    expect(preP005Blanking.failingTests).toEqual([]);
    expect(gateFailingTestsMeasurement(input).failingTests).not.toEqual(preP005Blanking.failingTests);
  });
});

describe('isGitSyncConflictCurrent', () => {
  const NOW = 1_800_000_000_000;

  it('keeps a freshly refreshed conflict row open without merge-completion proof', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('suppresses a row when the same sync tick proves its merge stage completed', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: NOW - 1_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('does not let proof from before the escalation retire a newer conflict row', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 1_000,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: NOW - 2_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('does not trust proof newer than the sync timestamp', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - 5_000,
        lastSyncedAtMs: NOW - 2_000,
        lastMergeCompletedAtMs: NOW - 1_000,
        lastMergeCompleted: ['superproject'],
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('fails closed for a stale or malformed escalation timestamp', () => {
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: NOW - GIT_SYNC_CONFLICT_MAX_AGE_MS - 1,
        lastSyncedAtMs: null,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      isGitSyncConflictCurrent({
        escalationMtimeMs: null,
        lastSyncedAtMs: NOW,
        lastMergeCompletedAtMs: null,
        lastMergeCompleted: [],
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe('toRoutineInfo', () => {
  it('returns null for a missing routine', () => {
    expect(toRoutineInfo(undefined)).toBeNull();
  });

  it('maps a routine row into the typed info (cron from trigger_config, dates → ms)', () => {
    const fired = new Date('2026-06-06T11:00:00Z');
    const next = new Date('2026-06-06T11:10:00Z');
    const info = toRoutineInfo({
      name: 'git-sync',
      active: true,
      trigger_config: { cron: '0 */10 * * * *', push: true },
      metadata: {},
      last_fired_at: fired,
      next_fire_at: next,
    });
    expect(info).toEqual({
      name: 'git-sync',
      active: true,
      cron: '0 */10 * * * *',
      lastFiredAtMs: fired.getTime(),
      nextFireAtMs: next.getTime(),
      // P-004: absent group_slug reads as ungrouped, never as the release group —
      // the legacy-pause default TTL must not be applied to a row we cannot place.
      groupSlug: null,
      pause: null,
    });
  });

  it('projects the deliberate pause record carried by routine metadata', () => {
    const info = toRoutineInfo({
      name: 'release-trigger',
      active: false,
      trigger_config: { cron: '0 */15 * * * *' },
      metadata: {
        pause: {
          reason: 'hold until repaired checkout is green',
          pausedBy: 'su-release-owner',
          pausedAtMs: 1_786_780_000_000,
        },
      },
      last_fired_at: null,
      next_fire_at: null,
    });
    expect(info?.pause).toEqual({
      reason: 'hold until repaired checkout is green',
      pausedBy: 'su-release-owner',
      pausedAtMs: 1_786_780_000_000,
      // P-004: a pre-TTL pause record carries no expiry — projected as an explicit
      // null so a reader sees "no auto-resume recorded" rather than a missing field.
      expiresAtMs: null,
    });
  });

  it('P-004: projects the stamped release-group pause expiry', () => {
    const info = toRoutineInfo({
      name: 'green-checkpoint',
      active: false,
      trigger_config: { cron: '0 15 * * * *' },
      metadata: {
        pause: {
          reason: 'deploy-checkout surgery',
          pausedBy: 'su-release-owner',
          pausedAtMs: 1_786_780_000_000,
          expiresAtMs: 1_786_780_000_000 + 4 * 3_600_000,
        },
      },
      last_fired_at: null,
      next_fire_at: null,
      group_slug: 'release',
    });
    expect(info?.groupSlug).toBe('release');
    expect(info?.pause?.expiresAtMs).toBe(1_786_780_000_000 + 4 * 3_600_000);
  });

  it('tolerates a null trigger_config / null schedule timestamps', () => {
    const info = toRoutineInfo({
      name: 'release-trigger',
      active: false,
      trigger_config: null,
      metadata: null,
      last_fired_at: null,
      next_fire_at: null,
    });
    expect(info).toMatchObject({
      name: 'release-trigger',
      active: false,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
    });
  });
});

describe('projectGreenCheckpointFireFreshness', () => {
  it('does not project verdict staleness as a non-firing routine', () => {
    expect(
      projectGreenCheckpointFireFreshness({
        fireStale: false,
        reason: 'no GREEN verdict in ~13h',
      }),
    ).toEqual({ fireStale: false, fireStaleReason: null });
  });

  it('keeps the fire-specific reason when the routine itself is stale', () => {
    expect(
      projectGreenCheckpointFireFreshness({
        fireStale: true,
        reason: 'the routine has not FIRED in ~4h',
      }),
    ).toEqual({ fireStale: true, fireStaleReason: 'the routine has not FIRED in ~4h' });
  });
});

describe('projectGreenCheckpointPause', () => {
  const NOW = 1_786_780_600_000;
  const paused = {
    name: 'green-checkpoint',
    active: false,
    cron: '0 0 * * * *',
    lastFiredAtMs: 1_786_779_000_000,
    nextFireAtMs: null,
    groupSlug: 'release',
    pause: {
      reason: 'hold while the repaired staging checkout is verified',
      pausedBy: 'su-release-owner',
      pausedAtMs: 1_786_780_000_000,
      expiresAtMs: 1_786_780_000_000 + 4 * 3_600_000,
    },
  };

  it('projects an inactive routine pause as the standing GATE PAUSED banner (P-004)', () => {
    const projected = projectGreenCheckpointPause(paused, NOW);
    expect(projected.pause).toEqual(paused.pause);
    expect(projected.fireStale).toBe(true);
    // The banner must name WHO holds it, SINCE when, WHY, and WHEN it auto-resumes —
    // the four facts whose absence made a 99h deliberate pause read as a red gate.
    expect(projected.fireStaleReason).toContain('GREEN-CHECKPOINT PAUSED');
    expect(projected.fireStaleReason).toContain('su-release-owner');
    expect(projected.fireStaleReason).toContain('hold while the repaired staging checkout is verified');
    expect(projected.fireStaleReason).toContain(new Date(paused.pause.pausedAtMs).toISOString());
    expect(projected.fireStaleReason).toContain(`auto-resumes ${new Date(paused.pause.expiresAtMs).toISOString()}`);
    expect(projected.fireStaleReason).toContain('A PAUSED gate is not a FAILING gate');
  });

  it('says so LOUDLY when a hold carries no auto-resume at all', () => {
    const untimed = {
      ...paused,
      groupSlug: null,
      pause: { ...paused.pause, expiresAtMs: null },
    };
    const reason = projectGreenCheckpointPause(untimed, NOW).fireStaleReason ?? '';
    expect(reason).toContain('NO auto-resume is scheduled');
    expect(reason).toContain('NOTHING will re-arm it');
  });

  it('does not carry stale pause metadata onto an active routine', () => {
    expect(projectGreenCheckpointPause({ ...paused, active: true })).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
  });

  it('does not invent a pause for a missing or unpaused routine', () => {
    expect(projectGreenCheckpointPause(null)).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
    expect(projectGreenCheckpointPause({ ...paused, pause: null })).toEqual({
      pause: null,
      fireStale: false,
      fireStaleReason: null,
    });
  });
});

/**
 * EI-13714 — the gate reports "STALLED — N consecutive reds" long after it has GREENED, because
 * the raw `gate_health` counters (`consecutiveReds` / `stalled` / `failingTests`) are the cache
 * `verdictStale` already proves superseded, yet every reader (`release:deploy{op:status}`, the
 * `/admin` Git tab, `dev:pipeline_position`) reported them unchanged in the SAME response that
 * carried `verdictStale:true` with a pin-advance reason. `pinProvenGateCorrection` is the single
 * point that resets those counters — pure, so it's covered here without a live Postgres (the full
 * `gitPipelineSnapshot` read that calls it is only exercised via integration test / live).
 */
describe('pinProvenGateCorrection (EI-13714)', () => {
  const RAW: RawGateCounters = {
    consecutiveReds: 11,
    stalled: true,
    failingTests: ['apps/operator/lib/some.test.ts'],
    firstRedAtMs: 1_700_000_000_000,
  };

  it('⭐ resets the streak to 0 when the pin advance PROVES a green happened since', () => {
    const out = pinProvenGateCorrection('pin-advance', RAW);
    expect(out).toEqual({ consecutiveReds: 0, stalled: false, failingTests: [], firstRedAtMs: null });
  });

  it('leaves the raw counters untouched for writer-starved (unverified, not proven green)', () => {
    expect(pinProvenGateCorrection('writer-starved', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched for retriage-proven (proves specific tests, not full-suite green)', () => {
    expect(pinProvenGateCorrection('retriage-proven', RAW)).toEqual(RAW);
  });

  it('leaves the raw counters untouched when the verdict is not stale at all', () => {
    expect(pinProvenGateCorrection(null, RAW)).toEqual(RAW);
  });
});

describe('gate stalled health projection', () => {
  const stallRedsThreshold = 3;
  const stallAgeThresholdMs = 6 * 60 * 60 * 1000;

  it('stays stalled on a repeated tick after the notification rung is deduplicated', () => {
    const firstInput = {
      consecutiveReds: 3,
      stallAgeMs: 1_000,
      stallRedsThreshold,
      stallAgeThresholdMs,
      marks: { stallAlerted: false },
    };
    const first = decideStallNotification(firstInput);
    const second = decideStallNotification({
      ...firstInput,
      marks: { ...first.marks, stallAlerted: true },
    });
    const inRoutineStalled = deriveInRoutineGateStalled(firstInput);

    expect(first.shouldNotify).toBe(true);
    expect(second.shouldNotify).toBe(false);
    expect(combineGateStallSignals(inRoutineStalled, false)).toBe(true);
  });

  it('includes the watchdog verdict when the count and age conditions are clear', () => {
    const inRoutineStalled = deriveInRoutineGateStalled({
      consecutiveReds: 0,
      stallAgeMs: 1_000,
      stallRedsThreshold,
      stallAgeThresholdMs,
    });

    expect(inRoutineStalled).toBe(false);
    expect(combineGateStallSignals(inRoutineStalled, true)).toBe(true);
  });

  it('returns false only when all signal sources are measured clear', () => {
    const inRoutineStalled = deriveInRoutineGateStalled({
      consecutiveReds: 0,
      stallAgeMs: 1_000,
      stallRedsThreshold,
      stallAgeThresholdMs,
    });

    expect(combineGateStallSignals(inRoutineStalled, false)).toBe(false);
  });

  it('returns unknown when required stall inputs or the watchdog verdict are unavailable', () => {
    expect(deriveInRoutineGateStalled({
      consecutiveReds: null,
      stallAgeMs: null,
      stallRedsThreshold,
      stallAgeThresholdMs,
    })).toBeNull();
    expect(combineGateStallSignals(false, null)).toBeNull();
  });

  it('keeps a measured positive stall even when another axis is unknown', () => {
    expect(deriveInRoutineGateStalled({
      consecutiveReds: 3,
      stallAgeMs: null,
      stallRedsThreshold,
      stallAgeThresholdMs,
    })).toBe(true);
  });
});

describe('mapActiveRun (overview-tab-expansion P-001)', () => {
  it('projects user-manager provenance from the checkpoint probe into camelCase snapshot fields', () => {
    expect(
      mapActiveRun({
        active: true,
        systemd: {
          scope: 'user',
          argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
          load_state: 'loaded',
          known: true,
          invocation_id: 'invocation-123',
        },
      }),
    ).toMatchObject({
      systemd: {
        scope: 'user',
        argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
        loadState: 'loaded',
        known: true,
        invocationId: 'invocation-123',
        appliesToActiveRun: true,
      },
    });
  });

  it('does not present the manual systemd probe or start-time fallback as evidence about an externally-held run', () => {
    const m = mapActiveRun({
      active: true,
      held_externally: true,
      started_at: '2026-09-20T00:16:36.087Z',
      elapsed_sec: 1693,
      systemd: {
        scope: 'user',
        argv: ['--user', 'show', 'papercup-green-checkpoint-manual-1fxzuva.service', '--property=LoadState'],
        load_state: 'not-found',
        known: false,
        invocation_id: null,
      },
    });

    expect(m).toMatchObject({
      active: true,
      heldExternally: true,
      progressAtMs: null,
      systemd: { loadState: 'not-found', known: false, appliesToActiveRun: false },
    });
  });

  it('preserves actual phase progress while marking the manual-unit probe inapplicable to an externally-held run', () => {
    const m = mapActiveRun({
      active: true,
      held_externally: true,
      started_at: '2026-09-20T00:16:36.087Z',
      progress_at: '2026-09-20T00:44:49.000Z',
      current_phase: 'affected-sweep',
      elapsed_sec: 1693,
      systemd: {
        scope: 'user',
        argv: ['--user', 'show', 'papercup-green-checkpoint-manual-1fxzuva.service', '--property=LoadState'],
        load_state: 'not-found',
        known: false,
        invocation_id: null,
      },
    });

    expect(m).toMatchObject({
      active: true,
      heldExternally: true,
      currentPhase: 'affected-sweep',
      progressAtMs: Date.parse('2026-09-20T00:44:49.000Z'),
      systemd: { appliesToActiveRun: false },
    });
  });

  it('maps a live judging run: systemd timestamp → epoch ms, candidate + elapsed through', () => {
    const m = mapActiveRun({
      active: true,
      log_path: '/tmp/papercup-green-checkpoint-manual-demo.log',
      candidate: '06a0eb9577deadbeef',
      started_at: '2026-07-20T04:00:00.000Z',
      elapsed_sec: 840,
    });
    expect(m).toEqual({
      active: true,
      logPath: '/tmp/papercup-green-checkpoint-manual-demo.log',
      candidate: '06a0eb9577deadbeef',
      startedAtMs: Date.parse('2026-07-20T04:00:00.000Z'),
      progressAtMs: Date.parse('2026-07-20T04:00:00.000Z'),
      elapsedSec: 840,
    });
  });

  it('maps an idle probe ({active:false}) with nulls — distinct from the not-probed null', () => {
    expect(mapActiveRun({ active: false })).toEqual({
      active: false,
      candidate: null,
      startedAtMs: null,
      progressAtMs: null,
      elapsedSec: null,
    });
  });

  it('EI-210996: carries systemd-owned abnormal terminal evidence through the derived snapshot', () => {
    expect(
      mapActiveRun({
        active: false,
        terminal_marker: false,
        terminal_evidence: {
          source: 'systemd-exec-stop-post',
          observed_at_ms: 12345,
          candidate: '1f64eb2d',
          service_result: 'oom-kill',
          exit_code: 'killed',
          exit_status: 'KILL',
          abnormal: true,
        },
      }),
    ).toMatchObject({
      active: false,
      terminalMarker: false,
      terminalEvidence: {
        candidate: '1f64eb2d',
        observedAtMs: 12345,
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
    });
  });

  it('nulls an unparseable systemd timestamp instead of NaN', () => {
    expect(mapActiveRun({ active: true, started_at: 'not-a-date' }).startedAtMs).toBeNull();
    expect(mapActiveRun({ active: true, started_at: 'not-a-date' }).progressAtMs).toBeNull();
  });

  it('maps an advancing log/phase heartbeat and does not reuse the immutable start time', () => {
    const m = mapActiveRun({
      active: true,
      started_at: '2026-08-20T09:00:00.000Z',
      progress_at: '2026-08-20T09:24:00.000Z',
    });
    expect(m.startedAtMs).toBe(Date.parse('2026-08-20T09:00:00.000Z'));
    expect(m.progressAtMs).toBe(Date.parse('2026-08-20T09:24:00.000Z'));
  });

  it('carries the run phase alongside its advancing heartbeat', () => {
    expect(
      mapActiveRun({
        active: true,
        started_at: '2026-08-20T09:00:00.000Z',
        progress_at: '2026-08-20T09:24:00.000Z',
        current_phase: 'delivering',
      }),
    ).toMatchObject({
      progressAtMs: Date.parse('2026-08-20T09:24:00.000Z'),
      currentPhase: 'delivering',
    });
  });

  it('preserves external run-lock and failed-probe provenance instead of collapsing both into active:true', () => {
    expect(
      mapActiveRun({
        active: true,
        held_externally: true,
        probe_failed: true,
        probe_detail: 'systemctl show failed; independent run lock is held',
        current_phase: 'setup',
      }),
    ).toMatchObject({
      active: true,
      heldExternally: true,
      probeFailed: true,
      probeDetail: 'systemctl show failed; independent run lock is held',
      currentPhase: 'setup',
    });
  });

  /**
   * EI-19327704778173646 / WI-7024. A single green-checkpoint run can re-candidate
   * mid-flight (in-process auto-refire onto tip), so `candidate` can legitimately differ
   * between two reads of the SAME run while pid/started_at never move. Without the
   * provenance below that reads as a corrupt/unstable field — which is exactly how several
   * agents misdiagnosed it on 2026-08-02.
   */
  it('carries refire provenance through when the run re-candidated mid-flight', () => {
    const m = mapActiveRun({
      active: true,
      candidate: '4961cfb8',
      initial_candidate: '14fb28da',
      refire_observed: true,
      started_at: '2026-08-02T08:37:45.565Z',
      elapsed_sec: 3400,
    });
    // The CURRENT candidate, not the abandoned one.
    expect(m.candidate).toBe('4961cfb8');
    expect(m.initialCandidate).toBe('14fb28da');
    expect(m.refireObserved).toBe(true);
    // startedAtMs deliberately stays the OUTER frame's — a candidate newer than it is the
    // healthy refire signature, not evidence the field is bogus.
    expect(m.startedAtMs).toBe(Date.parse('2026-08-02T08:37:45.565Z'));
  });

  it('omits refire provenance entirely when no refire was observed (shape unchanged)', () => {
    const m = mapActiveRun({ active: true, candidate: 'abc12345', elapsed_sec: 10 });
    expect(Object.prototype.hasOwnProperty.call(m, 'refireObserved')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(m, 'initialCandidate')).toBe(false);
  });
});

describe('applyCheckpointProcessAuthority (P-009 pre-lock liveness)', () => {
  const idle = mapActiveRun({ active: false });

  it('overturns idle during gate-authorized materialization and keeps candidate null', () => {
    expect(
      applyCheckpointProcessAuthority(idle, {
        active: true,
        probeFailed: false,
        pid: 4242,
        startedAtMs: 1_000,
        elapsedSec: 30,
        cgroupPath: '/user.slice/run-u42.scope',
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
      }),
    ).toEqual({
      ...idle,
      active: true,
      preLockAuthority: {
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        cgroupPath: '/user.slice/run-u42.scope',
        pid: 4242,
      },
      candidate: null,
      startedAtMs: 1_000,
      progressAtMs: 1_000,
      currentPhase: 'materializing',
      elapsedSec: 30,
    });
  });

  it.each([
    ['inactive', { active: false, probeFailed: false, pid: null, startedAtMs: null, elapsedSec: null, cgroupPath: null, workspace: null, harness: null }],
    ['missing authority', { active: true, probeFailed: false, pid: 42, startedAtMs: null, elapsedSec: null, cgroupPath: '/run.scope', workspace: null, harness: null }],
  ])('leaves the systemd reading unchanged when the process signal is %s', (_label, authority) => {
    expect(applyCheckpointProcessAuthority(idle, authority)).toBe(idle);
  });

  it('EI-22129511435526580: preserves genuine sweep progress instead of resetting it to the pre-lock placeholder', () => {
    // The systemd-tracked probe already found a run deep in the affected-test sweep — this
    // is what `activeRun` looks like once the primary probe (called just before this overlay,
    // against the same resolved root) has real progress_at/current_phase to report.
    const midSweep = mapActiveRun({
      active: true,
      started_at: '2026-09-02T05:23:30.985Z',
      progress_at: '2026-09-02T06:17:26.000Z',
      current_phase: 'affected-sweep',
    });
    // The systemd UNIT lookup has since gone stale (its loadState reads "not-found" for a
    // long-running manual run) and the pre-lock cheap-procfs authority is the only thing
    // that still confirms the process is alive — this must NOT reset the phase/progress
    // `activeRun` already knows back to the "just started" placeholder.
    const result = applyCheckpointProcessAuthority(midSweep, {
      active: true,
      probeFailed: false,
      pid: 3718680,
      startedAtMs: Date.parse('2026-09-02T05:23:30.985Z'),
      elapsedSec: 3210,
      cgroupPath: '/user.slice/run-u42.scope',
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
    });
    expect(result?.currentPhase).toBe('affected-sweep');
    expect(result?.progressAtMs).toBe(Date.parse('2026-09-02T06:17:26.000Z'));
    expect(result?.progressAtMs).not.toBe(result?.startedAtMs);
    // The pre-lock authority fields the overlay exists to add are still applied normally.
    expect(result?.startedAtMs).toBe(Date.parse('2026-09-02T05:23:30.985Z'));
    expect(result?.preLockAuthority).toEqual({
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      cgroupPath: '/user.slice/run-u42.scope',
      pid: 3718680,
    });
  });
});

describe('selectActiveCheckpointRoot', () => {
  it('EI-24349243151786500: probes the canonical gate unit when a staging operator serves a mirror', () => {
    const mirror = '/workspace/papercusp-staging';
    const canonical = '/workspace/papercusp';
    const input = {
      pipeline: 'papercusp',
      projectPaths: [mirror, canonical],
      defaultPipeline: 'papercusp',
      defaultRoot: mirror,
      canonicalRoot: canonical,
    };
    expect(selectActiveCheckpointRoot(input)).toBe(canonical);
    expect(selectActiveCheckpointRoot({ ...input, canonicalRoot: '   ' })).toBe(mirror);
    expect(selectActiveCheckpointRoot({ ...input, pipeline: 'other' })).toBeNull();
  });

  it('selects the requested harness root instead of the operator integration root', () => {
    expect(
      selectActiveCheckpointRoot({
        pipeline: 'sidestage',
        projectPaths: ['/srv/papercusp', '/srv/sidestage'],
        defaultPipeline: 'papercusp',
        defaultRoot: '/srv/papercusp',
      }),
    ).toBe('/srv/sidestage');
  });

  it('uses the explicit deploy root for the default pipeline even when registry paths are ambiguous', () => {
    const base = {
      projectPaths: ['/srv/a/papercusp', '/srv/b/papercusp'],
      defaultPipeline: 'papercusp',
      defaultRoot: '/srv/papercusp',
    };
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'papercusp' })).toBe('/srv/papercusp');
  });

  it('uses the deploy root when the default pipeline is absent and rejects unknown or ambiguous mappings', () => {
    const base = {
      projectPaths: ['/srv/a/sidestage', '/srv/b/sidestage'],
      defaultPipeline: 'papercusp',
      defaultRoot: '/srv/papercusp',
    };
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'papercusp', projectPaths: [] })).toBe('/srv/papercusp');
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'unknown' })).toBeNull();
    expect(selectActiveCheckpointRoot({ ...base, pipeline: 'sidestage' })).toBeNull();
  });
});

/**
 * EI-19399662484764592 (read side of WI-7290). `gate_health` records the re-triage only when it
 * classified `stale-candidate`, so the `real-red`-at-tip finding — the gate's strongest statement
 * that a red is genuinely current — was readable nowhere. These assert the append-only event's
 * verdict reaches readers, and that it is never mis-attributed to the wrong candidate.
 */
describe('pickRetriageVerdict (EI-19399662484764592, pure)', () => {
  const ev = (over: Partial<PipelineEventRow> & { detail?: unknown }): PipelineEventRow =>
    ({
      id: '1',
      kind: 'green_checkpoint',
      status: 'not-green',
      detail: {},
      createdAtMs: 1,
      ...over,
    }) as PipelineEventRow;

  it('⭐ surfaces a real-red-at-tip verdict — the classification gate_health deliberately drops', () => {
    const got = pickRetriageVerdict(
      [
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: {
              classification: 'real-red',
              tip: 'def456789012',
              tipObservedAtMs: 1_775_000_000_000,
              detail: 'reproduce at tip',
            },
          },
        }),
      ],
      'abc123456789',
    );
    expect(got).toEqual({
      classification: 'real-red',
      tip: 'def456789012',
      tipObservedAtMs: 1_775_000_000_000,
      detail: 'reproduce at tip',
      candidate: 'abc123456789',
    });
  });

  it('surfaces an `unknown` verdict with its skip reason intact', () => {
    const got = pickRetriageVerdict(
      [
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'unknown', tip: null, detail: 'tip re-run SKIPPED: no failing entry resolved' },
          },
        }),
      ],
      'abc123456789',
    );
    expect(got?.classification).toBe('unknown');
    expect(got?.detail).toContain('SKIPPED');
    expect(got?.tip).toBeNull();
    expect(got?.tipObservedAtMs).toBeNull();
  });

  it("⭐ REFUSES to attribute a DIFFERENT candidate's re-triage to this verdict — a plausible wrong answer is worse than none", () => {
    const got = pickRetriageVerdict(
      [
        ev({
          detail: {
            candidate: 'ffffffffffff',
            retriage: { classification: 'stale-candidate', tip: 'aaa', detail: 'passes at tip' },
          },
        }),
      ],
      'abc123456789',
    );
    expect(got).toBeNull();
  });

  it('matches across sha LENGTHS in both directions, so a full-length sha cannot silently downgrade a real verdict to unavailable', () => {
    const full = 'abc123456789def456789012345678901234abcd';
    expect(
      pickRetriageVerdict(
        [ev({ detail: { candidate: full, retriage: { classification: 'real-red', tip: null, detail: 'x' } } })],
        'abc123456789',
      ),
    ).not.toBeNull();
    expect(
      pickRetriageVerdict(
        [
          ev({
            detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } },
          }),
        ],
        full,
      ),
    ).not.toBeNull();
  });

  it('takes the NEWEST matching green_checkpoint event and ignores other pipeline kinds', () => {
    const got = pickRetriageVerdict(
      [
        ev({
          kind: 'deploy',
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'stale-candidate', tip: 'zzz', detail: 'wrong kind' },
          },
        }),
        ev({
          detail: {
            candidate: 'abc123456789',
            retriage: { classification: 'real-red', tip: 'newest', detail: 'newest' },
          },
        }),
        ev({
          detail: { candidate: 'abc123456789', retriage: { classification: 'unknown', tip: 'older', detail: 'older' } },
        }),
      ],
      'abc123456789',
    );
    expect(got?.tip).toBe('newest');
  });

  it('returns null — meaning NOT AVAILABLE, never "no re-triage happened" — for a pre-WI-7290 event, a malformed blob, or no candidate', () => {
    // A verdict recorded before WI-7290 simply has no `retriage` key.
    expect(pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789' } })], 'abc123456789')).toBeNull();
    expect(
      pickRetriageVerdict([ev({ detail: { candidate: 'abc123456789', retriage: 'nope' } })], 'abc123456789'),
    ).toBeNull();
    // An unrecognised classification is dropped rather than passed through as a string.
    expect(
      pickRetriageVerdict(
        [ev({ detail: { candidate: 'abc123456789', retriage: { classification: 'bogus' } } })],
        'abc123456789',
      ),
    ).toBeNull();
    expect(pickRetriageVerdict([], 'abc123456789')).toBeNull();
    // No candidate under report ⇒ nothing could be matched against it.
    expect(
      pickRetriageVerdict(
        [
          ev({
            detail: { candidate: 'abc123456789', retriage: { classification: 'real-red', tip: null, detail: 'x' } },
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});

// WI-10006493: git-sync persists every deferral variant in `last_skipped_paths`. This parser used
// to keep only the lock-holder shape, so fence and reservation deferrals never reached
// dev:pipeline_position, which then advertised a git-sync:run that could not help.
describe('skippedPathArr: every persisted git-sync deferral variant survives the read', () => {
  const lock = { scope: 'superproject', path: 'a.ts', owner: 'su-a', intent: 'edit a' };
  const reservation = {
    scope: 'libs/papercusp',
    path: 'libs/db/sql/1234-x.sql',
    reason: 'migration-reservation',
    detail: 'no reservation row for 1234',
  };
  const fence = {
    scope: 'superproject',
    path: 'b.ts',
    reason: 'migration-dependency-fence',
    detail: 'deferred because ...',
    blockingMigrations: ['libs/papercusp/libs/db/sql/1234-x.sql'],
    blockingAgents: ['su-author'],
    blockingWorkItems: ['WI-777'],
  };

  it('keeps lock, reservation and fence entries with their provenance', () => {
    expect(skippedPathArr([lock, reservation, fence])).toEqual([lock, reservation, fence]);
  });

  it('accepts a fence entry written before the provenance fields existed', () => {
    const legacy = { scope: 'superproject', path: 'c.ts', reason: 'migration-dependency-fence', detail: 'd' };
    expect(skippedPathArr([legacy])).toEqual([legacy]);
  });

  it('drops malformed entries and unknown reasons instead of passing them through', () => {
    expect(
      skippedPathArr([
        null,
        'a.ts',
        { scope: 'superproject', path: 'x.ts' },
        { scope: 'superproject', path: 'y.ts', reason: 'something-new', detail: 'd' },
        { scope: 'superproject', path: 'z.ts', reason: 'migration-reservation' },
        { ...fence, blockingAgents: ['su-author', 7] },
      ]),
    ).toEqual([{ ...fence, blockingAgents: ['su-author'] }]);
    expect(skippedPathArr(undefined)).toEqual([]);
  });
});

describe('contentErrorArr: content-quarantine metadata maps to exact pipeline paths', () => {
  it('normalizes root scopes and keeps only the detector key', () => {
    expect(
      contentErrorArr([
        'superproject/docs/evidence/reboot-residue-live-probes-2026-10-06/r001-live-probe-rubric-rev15.txt [identity-leak]',
        'root/docs/other.txt [mdx]',
        'libs/papercusp/libs/db/sql/1234-x.sql [sql-comment-backtick]',
        'superproject/apps/operator/x.ts [quarantined-importer of superproject/private/root.txt (identity-leak)]',
      ]),
    ).toEqual([
      { path: 'docs/evidence/reboot-residue-live-probes-2026-10-06/r001-live-probe-rubric-rev15.txt', detector: 'identity-leak' },
      { path: 'docs/other.txt', detector: 'mdx' },
      { path: 'libs/papercusp/libs/db/sql/1234-x.sql', detector: 'sql-comment-backtick' },
      { path: 'apps/operator/x.ts', detector: 'quarantined-importer' },
    ]);
  });

  it('drops malformed rows and unknown detector keys', () => {
    expect(contentErrorArr([null, 4, 'missing-detector', 'superproject/no-bracket', ' [identity-leak]'])).toEqual([]);
    expect(contentErrorArr(undefined)).toEqual([]);
  });
});
