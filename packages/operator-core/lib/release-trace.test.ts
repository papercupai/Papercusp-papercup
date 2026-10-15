import { describe, expect, it } from 'vitest';
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import { buildReleaseTrace, classifyReleaseWake, type ReleaseTraceGate, type ReleaseTraceInput } from './release-trace';
import { projectCheckpointQualificationState } from './release/checkpoint-qualification-transaction';

const sha = 'a'.repeat(40);
const green = sha;
const deployed = sha;
const NO_QUALIFICATION = projectCheckpointQualificationState(null, 0);

function position(over: Partial<PipelinePosition> = {}): PipelinePosition {
  return {
    input: { path: null, sha },
    // WI-9974 made this REQUIRED. `[]` is correct here rather than a silencer:
    // these fixtures describe a sha-only probe, and a sha-only probe identifies
    // no path, so there is no file whose generation any host could be running.
    runtimeGenerations: [],
    // acceptance-runtime-plane P-001 made this REQUIRED; a sha-only probe names no path,
    // so no runtime can be asked whether it executes it.
    servingRuntimes: [],
    repoRoot: '/repo',
    submodule: null,
    // EI-18715870370005934 made this REQUIRED on PipelinePosition. `null` is the
    // semantically correct value here, not just a compiler-silencer: these fixtures
    // describe a superproject path, so no gitlink substitution happened and the sha
    // asked about IS the sha the positions describe.
    submodulePin: null,
    targetSha: sha,
    targetShortSha: sha.slice(0, 9),
    targetSubject: 'test',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    // P-002 made the resolver-owned assessments REQUIRED. This lineage-only fixture
    // does not probe a serving process or gate candidate, so those conclusions stay
    // unavailable; the gate, deployed-sha, and main/staging readings are fully measured.
    assessments: {
      pipelinePosition: null,
      gateVerdict: 'passing-current',
      gateCandidate: null,
      gateOwnership: null,
      deployedSha: 'process-unverified',
      mainBehindStaging: 'caught-up',
    },
    positionsUnknown: [],
    // WI-6646 made these REQUIRED on PipelinePosition. Both values are semantically
    // correct here rather than compiler-silencers: this fixture names no `marker`, so
    // there is no per-leg marker verdict to report, and no leg is a newer-commit artifact.
    positionsMarker: null,
    positionsNewerCommit: [],
    // P-007 made this REQUIRED on PipelinePosition, and empty is the semantically
    // correct value rather than a compiler-silencer: these fixtures describe a fully
    // measured pipeline, so no verdict leg is degraded.
    verdictUnknown: [],
    deployedSha: deployed,
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      // EI-19325520469216548 made these REQUIRED on PipelinePosition['gate']; false/null is
      // the semantically correct default here, not a compiler-silencer — this fixture
      // describes a fully-measured, non-stale verdict.
      verdictStale: false,
      // WI-1752145: the verdict's own vintage. `null` is correct here rather than a
      // timestamp — this fixture asserts nothing about age, and null means UNKNOWN
      // vintage, which is precisely what a fixture that does not model a clock knows.
      verdictObservedAtMs: null,
      verdictStaleReason: null,
      verdictStaleReasonCode: null,
      candidateAgeMs: null,
      commitsBehindTip: null,
      observedCandidate: null,
      // EI-19405864032365760 made this REQUIRED for the same reason: `null` says this gate
      // RENDERED a verdict (no preflight abort recorded), which is what this fixture describes.
      inconclusive: null,
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
    },
    verdictProvenance: {
      lastGreenSha: green,
      lastGreenShortSha: green.slice(0, 9),
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'ok',
    gitSync: {
      status: 'ok',
      lastSyncedAtMs: 1,
      syncAgeMs: 0,
      consecutiveErrorTicks: 0,
      skippedPaths: [],
      pushedRepos: [],
      mergedRepos: [],
      conflicts: [],
      errors: [],
      pushMode: 'push',
    },
    // git-pipeline-agent-state-2026-07-26 P-001 made this REQUIRED. Empty is correct
    // for these fixtures: they assert release-trace's own lineage logic, which reads
    // `positions`/`verdictProvenance` and never the stage table.
    stages: [],
    runtime: null,
    runtimes: null,
    // P-003 (2e1280dcd1) made `serving` REQUIRED on PipelinePosition. All-null is the
    // correct value here for the same reason `runtime`/`runtimes` are null: these
    // fixtures assert release-trace's own LINEAGE logic (`positions` /
    // `verdictProvenance`), and never probe a live process. `unknownReason` states
    // that explicitly rather than leaving a bare null that reads as "probed, found
    // nothing" — the distinction ServingTruth exists to preserve.
    serving: {
      host: null,
      unit: null,
      pid: null,
      startedAtMs: null,
      codeAsOfMs: null,
      codeAsOfSource: null,
      startedSinceCodeChange: null,
      behindMin: null,
      // WI-2141731: nothing was probed, so NEITHER evidence source produced a
      // verdict — same reasoning as `unknownReason` above.
      evidence: null,
      reportedSha: null,
      restartLever: null,
      restartSupersededBy: null,
      unknownReason: { code: 'not-measured', detail: 'fixture: no serving probe (lineage-only test)' },
    },
    // P-004 made `changeInCandidate` REQUIRED. All-null is the correct value here for the
    // same reason `serving` is: these fixtures assert release-trace's own LINEAGE logic and
    // never resolve a gate candidate. Nulls mean "not measured" — the three-valued verdict
    // exists precisely so an unmeasured containment can never be read as a confirmed one.
    changeInCandidate: {
      judgingSha: null,
      judgingContainsPath: null,
      nextCandidateSha: null,
      nextContainsPath: null,
      submodule: null,
      missingReason: null,
      // EI-18797292094433710 added marker containment on the same three-valued
      // principle as the fields above: no marker was supplied by these fixtures,
      // so null is "not measured" rather than a measured absence.
      markerJudging: null,
      markerNext: null,
      detail: null,
    },
    // P-006 made `sweepExposure` REQUIRED. `dirtyUncommitted` is false in this fixture, so
    // "not exposed" is the semantically correct value, not a compiler-silencer: a clean
    // path has nothing for the next git-sync tick to sweep.
    sweepExposure: {
      exposed: false,
      dirtyPathCount: null,
      dirtyPathSample: [],
      nextSweepInMs: null,
      detail: null,
    },
    // P-005 made these REQUIRED. null/null is correct here for the same reason as above:
    // these fixtures carry an empty `stages` table, so there is no pending stage to derive
    // a blocker from — and null/null is the honest reading of that ("nothing pending"),
    // not a placeholder.
    blockedOn: null,
    nextAction: null,
    summary: 'ok',
    notes: [],
    ...over,
  };
}

function deploy(over: Partial<DeployStatus> = {}): DeployStatus {
  return {
    gate: {
      green: true,
      consecutiveReds: 0,
      stalled: false,
      fireStale: false,
      fireStaleReason: null,
      lastGreenAtMs: 1,
      verdictStale: false,
      verdictStaleReason: null,
      lastFixerStatus: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      failingTests: [],
      lastVerdict: null,
    },
    manualRunAuthority: null,
    deploy: {
      deployedSha: deployed,
      stagingHeadSha: sha,
      greenPinSha: green,
      deployedBehindStaging: 0,
      greenPinBehindStaging: 0,
      deployedBehindGreenPin: 0,
      greenPinAtStagingHead: true,
      deployedAtMs: 1,
    },
    deployInFlight: null,
    deployTerminal: null,
    checkpointRunInFlight: null,
    checkpoint: {
      state: 'idle',
      authority: 'live-probe',
      phase: null,
      blocker: null,
      verdictPending: false,
      probe: { status: 'ok', detail: null },
    },
    releaseTrigger: {
      active: true,
      cron: null,
      lastFiredAtMs: null,
      nextFireAtMs: null,
      pause: null,
      blocked: false,
      blockReason: null,
      fireStale: false,
      fireStaleReason: null,
    },
    liveCertification: null,
    canTriggerGreen: false,
    nothingToDeploy: true,
    state: 'up-to-date',
    recommendation: 'done',
    summary: 'done',
    errors: [],
    ...over,
  };
}

function input(over: Partial<ReleaseTraceInput> = {}): ReleaseTraceInput {
  return {
    position: position(),
    deploy: deploy(),
    pipeline: 'papercusp',
    inspectedKeys: [
      `release:deployed:${sha}`,
      'release:deploy-failed',
      'release:green:papercusp',
      'green-checkpoint:red:papercusp',
    ],
    awaits: [],
    wakes: [],
    snapshotGeneration: 10,
    requesterId: 'su-x',
    gate: {
      state: 'up-to-date',
      authoritative: true,
      consecutiveReds: 0,
      failingTests: [],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
    },
    ...over,
  };
}

/**
 * A wall-clock instant for fixtures whose assertion depends on the trace's clock.
 *
 * `input()` defaults `snapshotGeneration` to `10`, which is fine for every assertion that never
 * reads it — but production passes `snapshot.generatedAtMs`, a real epoch-ms value, and P-002's
 * progress certificate measures heartbeat AGE against it. A fixture that leaves the default in
 * place is therefore certifying a heartbeat against the instant `10ms after the epoch`, where
 * every plausible timestamp is far in the future and the verdict is decided by clock skew rather
 * than by the branch under test. Any fixture that sets `progressAtMs` must set this too.
 */
const NOW_MS = 1_700_000_000_000;

/**
 * The heartbeat shape of a HEALTHY in-flight run: advanced strictly past its start, and seen
 * recently against `NOW_MS`.
 *
 * It exists as a named helper because the wrong shape is the easy one to write by hand and does
 * not announce itself — overriding one field in isolation (a "stale" heartbeat left BEFORE the
 * run's start, say) silently selects the clock-skew branch instead of the one you meant to test,
 * and the assertion still reads as if it exercised the intended path.
 */
function advancingHeartbeat(over: { startedAgoMs?: number; lastSeenAgoMs?: number } = {}) {
  const startedAgoMs = over.startedAgoMs ?? 120_000;
  const lastSeenAgoMs = over.lastSeenAgoMs ?? 5_000;
  return { startedAtMs: NOW_MS - startedAgoMs, progressAtMs: NOW_MS - lastSeenAgoMs };
}

describe('release trace wake lineage', () => {
  it('calls an exact deploy-key wake current even without a payload SHA', () => {
    expect(
      classifyReleaseWake(sha, [
        {
          event: `release:deployed:${sha}`,
          deliveryId: 1,
          subscriberId: 'su-x',
          status: 'delivered',
          channel: 'resume',
          createdAt: '2026-01-01T00:00:00Z',
          deliveredAt: null,
          observedSha: null,
        },
      ]).verdict,
    ).toBe('current');
  });
  it('rejects a crossed gate wake for another SHA as stale', () => {
    expect(
      classifyReleaseWake(sha, [
        {
          event: 'release:green:papercusp',
          deliveryId: 1,
          subscriberId: 'su-x',
          status: 'delivered',
          channel: 'resume',
          createdAt: '2026-01-01T00:00:00Z',
          deliveredAt: null,
          observedSha: 'b'.repeat(40),
        },
      ]).verdict,
    ).toBe('stale');
  });
  it('does not manufacture a wake when no delivery exists', () =>
    expect(classifyReleaseWake(sha, []).verdict).toBe('none'));
});

describe('buildReleaseTrace', () => {
  it('reports exact tested/deployed parity for a green live SHA', () => {
    const out = buildReleaseTrace(input());
    expect(out.testedDeployedParity).toMatchObject({
      ok: true,
      state: 'matched',
      targetSha: sha,
      testedSha: sha,
      deployedSha: sha,
    });
    expect(out.constraints).toEqual([]);
    expect(out.nextVerb).toBeNull();
  });

  it('awaits the exact frozen repair head before origin/staging publication', () => {
    const repairHead = 'c'.repeat(40);
    const frozenCandidate = 'd'.repeat(40);
    const repairQueue = {
      phase: 'ready-to-verify',
      candidate: frozenCandidate,
      frozenCandidate,
      repairHead,
    } as NonNullable<PipelinePosition['gate']['repairQueue']>;
    const out = buildReleaseTrace(
      input({
        position: position({
          input: { path: null, sha: repairHead },
          targetSha: repairHead,
          targetShortSha: repairHead.slice(0, 9),
          positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, repairQueue },
        }),
      }),
    );

    expect(out.nextVerb).toEqual({
      name: 'checkpoint:await',
      args: { pipeline: 'papercusp', candidateSha: repairHead },
      reason: expect.stringContaining('ready to verify'),
    });
  });

  it('does not use a frozen repair route for an unrelated target', () => {
    const repairQueue = {
      phase: 'ready-to-verify',
      candidate: 'd'.repeat(40),
      repairHead: 'c'.repeat(40),
    } as NonNullable<PipelinePosition['gate']['repairQueue']>;
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, repairQueue },
        }),
      }),
    );

    expect(out.nextVerb).toMatchObject({ name: 'git-sync:await', args: { sha } });
  });

  describe('exact fix-commit containment in the recorded gate candidate', () => {
    const observedCandidate = 'c'.repeat(40);

    it('projects the canonical contained verdict without a lever or gate-health prediction', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            verdictProvenance: {
              ...position().verdictProvenance,
              targetIncludedInObservedCandidate: true,
            },
          }),
          gate: { ...input().gate, observedCandidate },
        }),
      );

      expect(out.gate.fixCommitContainment).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'contained',
        reason: null,
      });
      expect(out.gate.fixCommitContainment).not.toHaveProperty('nextVerb');
      expect(out.gate.fixCommitContainment).not.toHaveProperty('shouldGreen');
      expect(out.gate.fixCommitContainment).not.toHaveProperty('recommendation');
    });

    it('keeps a measured miss distinct from an unreadable ancestry probe', () => {
      const withMeasurement = (targetIncludedInObservedCandidate: boolean | null) =>
        buildReleaseTrace(
          input({
            position: position({
              verdictProvenance: {
                ...position().verdictProvenance,
                targetIncludedInObservedCandidate,
              },
            }),
            gate: { ...input().gate, observedCandidate },
          }),
        ).gate.fixCommitContainment;

      expect(withMeasurement(false)).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'not_contained',
        reason: null,
      });
      expect(withMeasurement(null)).toEqual({
        fixSha: sha,
        observedCandidate,
        verdict: 'unknown',
        reason: 'ancestry-unreadable',
      });
    });
  });
  it('accepts a target contained in a newer matching green/deployed pin', () => {
    const newer = 'c'.repeat(40);
    const out = buildReleaseTrace(
      input({
        position: position({
          deployedSha: newer,
          verdictProvenance: {
            ...position().verdictProvenance,
            lastGreenSha: newer,
            deployOrigin: 'gate-green',
          },
        }),
      }),
    );
    expect(out.testedDeployedParity).toMatchObject({
      ok: true,
      targetSha: sha,
      testedSha: newer,
      deployedSha: newer,
    });
    expect(out.ok).toBe(true);
  });
  it('reports green-pin ancestry separately from target presence on main', () => {
    const newer = 'c'.repeat(40);
    const out = buildReleaseTrace(
      input({
        position: position({
          deployedSha: newer,
          positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
          verdictProvenance: {
            ...position().verdictProvenance,
            lastGreenSha: newer,
            targetIncludedInGreenPin: false,
            deployOrigin: 'ahead-of-gate',
          },
        }),
      }),
    );
    expect(out.target.presence.inMain).toBe(true);
    expect(out.greenPin).toMatchObject({ sha: newer, targetIncluded: false });
    expect(out.testedDeployedParity).toMatchObject({ state: 'target-not-included', ok: false });
    expect(out.constraints.map((constraint) => constraint.code)).toContain('target-not-green-pinned');
  });
  it('does not claim a staging-only target is in origin/main when the green pin excludes it', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          verdictProvenance: {
            ...position().verdictProvenance,
            targetIncludedInGreenPin: false,
            deployOrigin: 'ahead-of-gate',
          },
        }),
      }),
    );

    const constraint = out.constraints.find((entry) => entry.code === 'target-not-green-pinned');
    expect(out.target.presence.inMain).toBe(false);
    expect(constraint?.summary).toBe(
      'The target is not in origin/main and is not contained by the recorded green pin; neither origin/main visibility nor green-pin containment proves gate testing.',
    );
  });
  it('returns one safe green-pin deploy trigger when main is ahead of live', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false } }),
        deploy: deploy({ canTriggerGreen: true, nothingToDeploy: false, state: 'green-deployable' }),
      }),
    );
    expect(out.nextVerb).toMatchObject({ name: 'release:deploy', args: { op: 'trigger', confirm: true } });
  });
  it('names authoritative gate failures and never recommends force', () => {
    const gate = {
      state: 'gate-red' as const,
      authoritative: true,
      consecutiveReds: 2,
      failingTests: ['x.test.ts'],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
    };
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate,
      }),
    );
    expect(out.gate.failingTests).toEqual(['x.test.ts']);
    expect(out.constraints.map((c) => c.code)).toContain('no-force-past-red');
    expect(out.nextVerb?.name).toBe('testing:flakiness');
  });

  it('projects an exact repair-in-progress candidate as inconclusive over an older red gate', () => {
    const repairCandidate = sha.slice(0, 8);
    const inconclusive = {
      status: 'repair-in-progress',
      candidate: repairCandidate,
      detail: 'frozen repair fixer fixer-1 dispatched; no suite run',
      observedAtMs: 123,
    };
    const inherited = ['historical-red.test.ts', 'older-lint.test.ts'];
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: false,
          consecutiveReds: 18,
          failingTests: [],
          observedCandidate: 'older-candidate',
          recordedVerdict: 'not-green',
          inconclusive,
          inheritedRepairQueueFailingTests: inherited,
          inheritedRepairQueueFailingTestsSource: 'prior-gate-verdict',
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'inconclusive',
      status: 'inconclusive',
      green: null,
      candidate: repairCandidate,
      reason: 'repair-in-progress',
      detail: inconclusive.detail,
    });
    expect(out.gate.failingTests).toEqual([]);
    expect(out.gate.inheritedRepairQueueFailingTests).toEqual(inherited);
    expect(out.gate.inheritedRepairQueueFailingTestsSource).toBe('prior-gate-verdict');
    expect(out.constraints.map((c) => c.code)).toContain('gate-inconclusive');
    expect(out.constraints.map((c) => c.code)).not.toContain('gate-red');
    expect(out.constraints.map((c) => c.code)).not.toContain('no-force-past-red');
    // R-1 / EI-23365548566505155: this fixture's own detail says "no suite run",
    // so there is NO in-flight producer to certify and the pre-R-1 bare `checkpoint:await`
    // asserted here was the stranding recommendation itself. The projection assertions above
    // are this test's subject and are unchanged; only the recommendation moves, to the
    // measurement R-1 requires when advancement cannot be established.
    expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    expect(out.nextVerb?.name).toBe('dev:pipeline_position');
    expect(out.nextVerb?.reason).not.toContain('testing:flakiness');
  });

  it('WI-41252 / D-066: an exact dependency-generation abort outranks the historical red fallback', () => {
    const inconclusive = {
      status: 'infra-inconclusive',
      candidate: sha,
      detail:
        'dependency-generation.sh exited 75: live node_modules changed during generation build; refusing a torn snapshot',
      observedAtMs: 456,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 42,
          failingTests: [],
          observedCandidate: sha,
          recordedVerdict: null,
          inconclusive,
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'inconclusive',
      status: 'inconclusive',
      green: null,
      candidate: sha,
      reason: 'infra-inconclusive',
      detail: inconclusive.detail,
    });
    expect(out.constraints.map((c) => c.code)).toContain('gate-inconclusive');
    expect(out.constraints.map((c) => c.code)).not.toContain('gate-red');
    expect(out.constraints.map((c) => c.code)).not.toContain('no-force-past-red');
    // R-1: the abort ended the run (`dependency-generation.sh exited 75`), so no producer is
    // in flight and the verdict being awaited can never arrive. The D-066 subject of this test
    // — the abort outranking the historical red in the PROJECTION — is asserted above and
    // unchanged; the recommendation is now the certified one.
    expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    expect(out.nextVerb?.name).toBe('dev:pipeline_position');
  });

  it('does not project a historical red while the exact candidate is actively being judged', () => {
    const checkpointRun = {
      active: true,
      activeSource: 'run-lock' as const,
      candidate: sha,
      ...advancingHeartbeat(),
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: {
          ...input().gate,
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 4,
          failingTests: ['historical-red.test.ts'],
          observedCandidate: sha,
          recordedVerdict: null,
          checkpointRunInFlight: checkpointRun,
        },
      }),
    );

    expect(out.gate.candidateVerdict).toMatchObject({
      state: 'unknown',
      status: 'unknown',
      green: null,
      candidate: sha,
    });
    expect(out.gate.candidateVerdict.reason).toContain('checkpoint run');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
  });

  describe("an `unknown` verdict names WHOSE verdict it is and hands back that candidate's re-read", () => {
    // The false-blocker class this closes: a PATH trace resolves `targetSha` to that path's
    // own latest commit, so the exact-SHA rail correctly declines to attribute the gate's
    // verdict to it. Three sessions of stable-candidate-related-gate-2026-08-23 read that
    // `unknown` as the gate failing to type its own state, producing two retracted findings
    // and a false ship blocker. `resync.nextVerb` re-reads the SAME target, so it cannot
    // break the loop; only a handle addressed to `observedCandidate` can.
    const otherCandidate = 'f369131625d4252f0c8202e75766b272a4abc3c2';

    it('points the caller at the candidate that owns the verdict instead of just refusing', () => {
      const out = buildReleaseTrace(
        input({
          gate: {
            ...input().gate,
            state: 'gate-red',
            authoritative: true,
            consecutiveReds: 61,
            recordedVerdict: 'not-green',
            observedCandidate: otherCandidate,
          },
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({
        state: 'unknown',
        status: 'unknown',
        green: null,
        candidate: otherCandidate,
      });
      // The handle must address the OTHER candidate, never the traced target — re-reading
      // the target is precisely the move that kept three sessions stuck.
      expect(out.gate.candidateVerdict.rereadForCandidate).toEqual({
        name: 'release:trace',
        args: { sha: otherCandidate },
      });
      expect(out.gate.candidateVerdict.rereadForCandidate?.args.sha).not.toBe(sha);
      // and the reason must say it is the rail working, not a missing verdict
      expect(out.gate.candidateVerdict.reason).toContain(otherCandidate);
      expect(out.gate.candidateVerdict.reason).toContain('NOT an untyped or missing verdict');
    });

    it('offers no handle when the gate has recorded no candidate to compare against', () => {
      // Fail-closed: absent an observedCandidate there is no better subject to point at,
      // so the field must be null rather than a fabricated self-referential re-read.
      const out = buildReleaseTrace(
        input({
          gate: { ...input().gate, state: 'gate-red', authoritative: true, observedCandidate: null },
        }),
      );

      expect(out.gate.candidateVerdict.state).toBe('unknown');
      expect(out.gate.candidateVerdict.rereadForCandidate).toBeNull();
      expect(out.gate.candidateVerdict.reason).toContain('no observed candidate');
    });
  });

  describe('an exact-candidate recorded terminal verdict is immutable history', () => {
    // EI-21432980132792683 / EI-21433072117655298. Candidate 74027d.. was judged authoritative
    // exact RED and ratified terminal by stable-candidate-related-gate-2026-08-23#D-059/#D-060.
    // release:trace then reported it back as inconclusive/repair-in-progress with
    // nextVerb: checkpoint:await -- erasing the ratified fail-closed branch and stranding
    // readers on a verdict that can never arrive, because the candidate is already terminal.
    const terminalGate = (over: Partial<ReleaseTraceGate> = {}): Partial<ReleaseTraceGate> => ({
      ...input().gate,
      state: 'gate-red',
      consecutiveReds: 41,
      failingTests: [],
      observedCandidate: sha,
      recordedVerdict: 'not-green',
      ...over,
    });

    it('survives a later repair reservation naming the same candidate', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            // `inconclusive` is by contract the latest attempt that rendered NO verdict, so it
            // cannot supersede one that did -- least of all for this very SHA.
            inconclusive: {
              status: 'repair-in-progress',
              candidate: sha,
              detail: 'root-fix fixer dispatched; no suite run',
              observedAtMs: 123,
            },
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'red', status: 'red', green: false, candidate: sha });
      expect(out.gate.candidateVerdict.reason).not.toBe('repair-in-progress');
      expect(out.constraints.map((c) => c.code)).not.toContain('gate-inconclusive');
      expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    });

    it('survives the aggregate verdict going stale against newer staging', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            state: 'gate-verdict-stale',
            // `authoritative` goes false precisely BECAUSE the verdict went stale, which is why
            // the fix reads the explicit writer marker instead of the authoritative+reds fallback.
            authoritative: false,
            verdictStale: true,
            verdictStaleReason: 'candidate-fossil; newer staging',
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'red', status: 'red', green: false, candidate: sha });
      // Staleness still governs the CURRENT TIP -- it just may not rewrite this SHA's own verdict.
      expect(out.constraints.map((c) => c.code)).toContain('gate-verdict-stale');
    });

    it('preserves a recorded green the same way, so the rule is about immutability not redness', () => {
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            state: 'gate-verdict-stale',
            authoritative: false,
            consecutiveReds: 0,
            recordedVerdict: 'green',
            verdictStale: true,
            verdictStaleReason: 'superseded pin',
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'green', status: 'green', green: true });
    });

    it('CONTROL: a red recorded against a DIFFERENT candidate still yields to an exact repair reservation', () => {
      // Falsifiability control for the fix above: it must key on an exact-SHA match, never on
      // the mere presence of `recordedVerdict`. Without this, the fix would silently project an
      // unrelated candidate's red onto this one -- the opposite defect, and the behaviour the
      // 'projects an exact repair-in-progress candidate as inconclusive' test exists to protect.
      const out = buildReleaseTrace(
        input({
          gate: terminalGate({
            authoritative: false,
            observedCandidate: 'older-candidate',
            inconclusive: {
              status: 'repair-in-progress',
              candidate: sha,
              detail: 'frozen repair fixer dispatched; no suite run',
              observedAtMs: 123,
            },
          }) as ReleaseTraceGate,
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({ state: 'inconclusive', reason: 'repair-in-progress' });
    });
  });

  it('uses exact local gate provenance before directing recovery to origin/staging', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: sha },
        }),
        gate: {
          state: 'gate-red',
          authoritative: true,
          consecutiveReds: 1,
          failingTests: ['x.test.ts'],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: false,
          verdictStaleReason: null,
          observedCandidate: sha,
        },
      }),
    );

    expect(out.gate.observedCandidate).toBe(sha);
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain(
      'local green-checkpoint already judged',
    );
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).not.toContain('cannot test it');
    expect(out.nextVerb?.name).toBe('testing:flakiness');
  });

  it('keeps stale exact-candidate recovery on the gate path, not the publication wait path', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: sha },
        }),
        gate: {
          state: 'gate-verdict-stale',
          authoritative: false,
          consecutiveReds: 5,
          failingTests: [],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: true,
          verdictStaleReason: 'stale candidate was re-tested at tip',
          observedCandidate: sha,
        },
      }),
    );

    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
    expect(out.nextVerb?.name).not.toBe('git-sync:await');
  });

  it('awaits origin egress when a local commit is not yet on origin/staging', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, observedCandidate: 'b'.repeat(40) },
        }),
      }),
    );

    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain('cannot test it');
    expect(out.nextVerb).toMatchObject({
      name: 'events:await',
      args: { event: `git-sync:egressed:${sha}` },
    });
  });

  it('awaits an exact active detached repair verifier before origin publication', () => {
    const checkpointRun = {
      active: true,
      candidate: sha,
      activeSource: 'run-lock' as const,
      systemd: {
        scope: 'user' as const,
        argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
        loadState: 'loaded',
        known: true,
        invocationId: 'invocation-123',
      },
      ...advancingHeartbeat(),
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        position: position({
          positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).toContain(
      'actively judging this exact detached candidate',
    );
    expect(out.constraints.find((c) => c.code === 'not-on-origin-staging')?.summary).not.toContain('cannot test it');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    expect(out.nextVerb?.reason).toContain(sha);
    expect(out.gate.checkpointRunInFlight?.systemd).toEqual(checkpointRun.systemd);
  });

  it('keeps an unrelated active verifier from masking the exact origin-egress wait', () => {
    const checkpointRun = {
      active: true,
      candidate: 'b'.repeat(40),
      activeSource: 'run-lock' as const,
      startedAtMs: 123,
      elapsedSec: 42,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.nextVerb).toMatchObject({
      name: 'events:await',
      args: { event: `git-sync:egressed:${sha}` },
    });
  });

  // EI-18672078222841101 — the stampede. Three agents read a red here within 15 minutes and
  // each was told to go classify the failures, with nothing saying a fixer already held them.
  describe('a red that someone already owns', () => {
    // These fixtures describe the AUTOMATED-FIXER verdict alone — the input side of the
    // composition, before any repair holder is read in. So the helper lifts a fixer-only
    // shape exactly the way describeGateRedOwnership does (`fixerState: fixer.state`,
    // `repairOwner: null`): a fixture that spelled those out by hand would be asserting a
    // composition it never performed. A test that DOES want a pre-composed value still
    // passes fixerState/repairOwner explicitly and they win.
    type RedOwner = NonNullable<ReleaseTraceGate['redOwner']>;
    type RedOwnerFixture = Omit<RedOwner, 'fixerState' | 'repairOwner'> &
      Partial<Pick<RedOwner, 'fixerState' | 'repairOwner'>>;
    const liftFixerOnly = (redOwner: RedOwnerFixture): RedOwner => ({
      ...redOwner,
      fixerState: redOwner.fixerState ?? redOwner.state,
      repairOwner: redOwner.repairOwner ?? null,
    });
    // `null` is meaningful here and distinct from omission — it is the fixture for a red
    // with the fixer half explicitly absent — so it passes through unlifted.
    const redGate = (redOwner?: RedOwnerFixture | null) => ({
      state: 'gate-red' as const,
      authoritative: true,
      consecutiveReds: 2,
      failingTests: ['x.test.ts'],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictStaleReason: null,
      redOwner: redOwner ? liftFixerOnly(redOwner) : redOwner,
    });
    const onStaging = position({
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
    });

    const liveCanonicalOwner = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-39450',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-gate-owner',
      takenAt: '2026-08-20T10:00:00Z',
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: {},
    } as unknown as NonNullable<PipelinePosition['gate']['ownership']>;

    it('prefers a live canonical gate singleton over an obsolete fixer owner-gone', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: { ...position().gate, ownership: liveCanonicalOwner },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
          }),
        }),
      );

      // P-008: COMPOSED, not substituted. The composite state is its own value so a
      // reader can tell "a human/agent holds the item" from "the automated fixer is on
      // it" — the previous contract asserted 'owned-live' here, which said the second
      // while meaning the first.
      expect(out.gate.redOwner).toMatchObject({
        state: 'owned-by-repair-holder',
        covered: true,
        // The fixer's OWN verdict and lineage survive the composition. The old
        // substitution nulled spawnId/ageMs and overwrote ownerSignature with the event
        // key, which destroyed the actionable half: a dead fixer beside a live holder is
        // a fixer that needs re-dispatching, and nobody could see it.
        fixerState: 'owner-gone',
        spawnId: 'obsolete-fixer',
        ownerSignature: 'x.test.ts',
      });
      expect(out.gate.redOwner?.repairOwner).toMatchObject({
        eventKey: 'gate-red-streak:papercusp',
        workItem: 'WI-39450',
        takenBy: 'su-live-gate-owner',
        live: true,
      });
      expect(out.gate.redOwner?.label).toContain('WI-39450');
      expect(out.gate.redOwner?.label).toMatch(/^OWNED/);
      // The dead fixer is now REPORTED rather than hidden — but explicitly as something
      // that does not make the red unowned.
      expect(out.gate.redOwner?.label).toContain('CONFIRMED GONE');
      expect(out.gate.redOwner?.label).toMatch(/does NOT mean this red is unowned/);
      expect(out.gate.redOwner?.label).not.toMatch(/Claim it before investigating/);
      expect(out.nextVerb?.name).toBe('checkpoint:await');
      // The constraint carries the same composed label, so it names the live holder AND
      // reports the dead fixer. The old assertion here forbade "CONFIRMED GONE" because
      // under substitution its only possible meaning was the stale "so claim this red";
      // composed, it is a second fact beside the owner, and the property that actually
      // matters is that the summary never invites a second claimant.
      const gateRed = () => out.constraints.find((c) => c.code === 'gate-red')?.summary ?? '';
      expect(gateRed()).toContain('WI-39450');
      expect(gateRed()).toContain('su-live-gate-owner');
      expect(gateRed()).not.toMatch(/Claim it before investigating/);
    });

    it('prefers a measured live run-lock executor even when the singleton projection is absent', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              checkpointRunInFlight: {
                active: true,
                activeSource: 'run-lock',
                candidate: 'checkpoint-candidate',
                startedAtMs: 123,
                elapsedSec: 213,
                asOfAgeMs: 0,
              },
            },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
          }),
        }),
      );

      expect(out.gate.redOwner).toMatchObject({ state: 'owned-live', covered: true });
      expect(out.gate.redOwner?.label).toContain('checkpoint-candidate');
      expect(out.gate.redOwner?.label).not.toContain('CONFIRMED GONE');
    });

    it('prefers measured pre-lock process authority before a candidate is published', () => {
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              checkpointRunInFlight: {
                active: true,
                activeSource: 'process-authority',
                processAuthority: {
                  workspace: 'papercusp-workspace',
                  harness: 'papercusp',
                  cgroupPath: '/user.slice/run-u42.scope',
                  pid: 4242,
                },
                candidate: null,
                startedAtMs: 123,
                elapsedSec: 10,
                asOfAgeMs: null,
              },
            },
          }),
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'obsolete-fixer',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'obsolete fixer gone',
          }),
        }),
      );
      expect(out.gate.redOwner).toMatchObject({ state: 'owned-live', covered: true });
      expect(out.gate.redOwner?.label).toMatch(/gate-authorized checkpoint process/i);
    });

    it('keeps the D-016 paused-routine serializer authoritative over historical fixer lineage', () => {
      // Live shape observed on 2026-08-23: D-012/D-013 deliberately pauses the
      // routine while WI-40086's D-016 claim-hold/qualified-tip serializer owns
      // the gate-red-streak sequence. The inactive run-lock is measured idle;
      // it must not erase the separate live singleton ownership cell.
      const pausedRun = {
        active: false,
        activeSource: 'run-lock' as const,
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
        asOfAgeMs: 0,
      };
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: {
              ...position().gate,
              observedCandidate: sha,
              ownership: {
                assessment: 'held-live',
                eventKey: 'gate-red-streak:papercusp',
                workItem: 'WI-40086',
                claimState: 'held',
                unknown: null,
                takenBy: 'su-c58f545d-f8a4-4afe-b755-1bf613bd8083',
                takenAt: '2026-08-23T00:58:23.745Z',
                lastProgressAt: null,
                expiresAt: null,
                holderSessionState: 'live',
                duplicates: [],
                thread: { recent: [], shown: 0, total: 0, topics: [], unknown: null },
              },
              checkpointRunInFlight: pausedRun,
            },
          }),
          gate: {
            ...redGate({
              state: 'owner-gone',
              covered: false,
              spawnId: 'obsolete-fixer',
              ownerSignature: 'RED-35',
              ageMs: 90 * 60_000,
              label: 'UNOWNED — obsolete release-fixer is CONFIRMED GONE.',
            }),
            observedCandidate: sha,
            checkpointRunInFlight: pausedRun,
          },
        }),
      );

      // P-008: same composition contract as above — the live singleton outranks the
      // obsolete fixer, and outranks the paused-run serializer too, because naming the
      // specific owner is more actionable than "a run is up".
      expect(out.gate.redOwner).toMatchObject({
        state: 'owned-by-repair-holder',
        covered: true,
        fixerState: 'owner-gone',
        spawnId: 'obsolete-fixer',
        ownerSignature: 'RED-35',
      });
      expect(out.gate.redOwner?.repairOwner).toMatchObject({ workItem: 'WI-40086', live: true });
      expect(out.gate.redOwner?.label).toContain('WI-40086');
      expect(out.gate.redOwner?.label).toContain('su-c58f545d-f8a4-4afe-b755-1bf613bd8083');
      // lastProgressAt is null here and takenAt is parseable, so the lease anchors on the
      // claim stamp — an OLD claim with no progress must not read as freshly worked.
      expect(out.gate.redOwner?.repairOwner?.lastProgressAt).toBeNull();
      expect(out.gate.redOwner?.label).not.toMatch(/Claim it before investigating/);
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.name).not.toBe('testing:flakiness');
      // Same composed-label contract as the case above.
      const gateRedSummary = () => out.constraints.find((c) => c.code === 'gate-red')?.summary ?? '';
      expect(gateRedSummary()).toContain('WI-40086');
      expect(gateRedSummary()).toContain('su-c58f545d-f8a4-4afe-b755-1bf613bd8083');
      expect(gateRedSummary()).not.toMatch(/Claim it before investigating/);
    });

    it('sends a reader to await the outcome instead of opening a second diagnosis', () => {
      const out = buildReleaseTrace(
        input({
          position: onStaging,
          gate: redGate({
            state: 'owned-live',
            covered: true,
            spawnId: 'spawn-77',
            ownerSignature: 'x.test.ts',
            ageMs: 20 * 60_000,
            label: 'OWNED — release-fixer spawn-77 has been on this exact failure since 20m ago and is alive.',
          }),
        }),
      );
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
      expect(out.nextVerb?.reason).toContain('spawn-77');
      expect(out.nextVerb?.reason).toContain('already latched');
      expect(out.nextVerb?.reason).toContain('paced cadence');
      // The red is still a blocker and force is still refused — this narrows WHO investigates,
      // it does not soften the gate.
      expect(out.constraints.map((c) => c.code)).toContain('gate-red');
      expect(out.constraints.map((c) => c.code)).toContain('no-force-past-red');
      expect(out.constraints.find((c) => c.code === 'gate-red')?.summary).toContain('spawn-77');
    });

    it('does not bind the wait to a terminal red candidate whose producer is already idle', () => {
      const checkpointRun = {
        active: false,
        activeSource: 'run-lock' as const,
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
        asOfAgeMs: 0,
      };
      const out = buildReleaseTrace(
        input({
          position: position({
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
            gate: { ...position().gate, observedCandidate: sha, checkpointRunInFlight: checkpointRun },
          }),
          gate: {
            ...redGate({
              state: 'owned-live',
              covered: true,
              spawnId: 'spawn-77',
              ownerSignature: 'x.test.ts',
              ageMs: 20 * 60_000,
              label: 'OWNED — release-fixer spawn-77 is alive for the terminal red.',
            }),
            observedCandidate: sha,
            checkpointRunInFlight: checkpointRun,
          },
        }),
      );

      expect(out.gate.candidateVerdict).toMatchObject({
        state: 'red',
        status: 'red',
        green: false,
        candidate: sha,
      });
      expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
      expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
      expect(out.nextVerb?.reason).toContain('already latched');
    });

    it('still sends a reader to diagnose when the recorded fixer is CONFIRMED GONE', () => {
      // The property that keeps "a red gate is everyone's problem" intact: an uncovered red
      // must still recruit whoever reads it, or this fix trades a stampede for a stalled gate.
      const out = buildReleaseTrace(
        input({
          position: onStaging,
          gate: redGate({
            state: 'owner-gone',
            covered: false,
            spawnId: 'spawn-77',
            ownerSignature: 'x.test.ts',
            ageMs: 90 * 60_000,
            label: 'UNOWNED — release-fixer spawn-77 was dispatched 2h ago but is CONFIRMED GONE.',
          }),
        }),
      );
      expect(out.nextVerb?.name).toBe('testing:flakiness');
      expect(out.nextVerb?.reason).toContain('CONFIRMED GONE');
    });

    it('renders byte-identically to before when no ownership is supplied', () => {
      const without = buildReleaseTrace(input({ position: onStaging, gate: redGate(undefined) }));
      const nulled = buildReleaseTrace(input({ position: onStaging, gate: redGate(null) }));
      expect(without.nextVerb?.name).toBe('testing:flakiness');
      expect(JSON.stringify(nulled.constraints)).toBe(JSON.stringify(without.constraints));
      expect(without.constraints.find((c) => c.code === 'gate-red')?.summary).not.toMatch(/OWNED|UNOWNED/);
    });
  });
  it('suppresses stale failing-test authority and asks for a fresh checkpoint', () => {
    const gate = {
      state: 'gate-verdict-stale' as const,
      authoritative: false,
      consecutiveReds: 3,
      failingTests: [],
      fireStale: false,
      fireStaleReason: null,
      verdictStale: true,
      verdictStaleReason: 'superseded pin',
    };
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate,
      }),
    );
    expect(out.constraints.map((c) => c.code)).toContain('gate-verdict-stale');
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });
  it('awaits an active checkpoint instead of recommending a duplicate stale-verdict run', () => {
    const candidate = 'b'.repeat(40);
    const out = buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: {
          state: 'gate-verdict-stale',
          authoritative: false,
          consecutiveReds: 3,
          failingTests: [],
          fireStale: false,
          fireStaleReason: null,
          verdictStale: true,
          verdictStaleReason: 'superseded pin',
          checkpointRunInFlight: {
            active: true,
            candidate,
            activeSource: 'run-lock',
            ...advancingHeartbeat(),
            elapsedSec: 42,
            asOfAgeMs: null,
          },
        },
      }),
    );

    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    expect(out.nextVerb?.args).not.toHaveProperty('candidateSha');
    expect(out.nextVerb?.reason).toContain(candidate);
  });
  it('EI-12457: on staging with no red verdict yet, awaits the gate bound to the exact candidate SHA', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
      }),
    );
    // The candidate is still on staging, gate not red/stale — the safe next step is to
    // await the gate, and the await must be bound to THIS exact candidate (candidateSha)
    // so a stale verdict for a different, superseded SHA can never wake the caller.
    expect(out.nextVerb).toMatchObject({
      name: 'checkpoint:await',
      args: { pipeline: 'papercusp', candidateSha: sha },
    });
  });
  it('returns runtime activation instead of deploy advice for staging-tree hosts', () => {
    const out = buildReleaseTrace(
      input({
        position: position({
          runtime: {
            host: 'gateway',
            releasePipelineApplies: false,
            restartTarget: 'gateway',
            activation: 'restart gateway',
          },
        }),
      }),
    );
    expect(out.nextVerb).toMatchObject({ name: 'dev:restart', args: { target: 'gateway', confirm: true } });
    expect(out.constraints.map((c) => c.code)).toContain('runtime-not-release-carried');
  });
  it('carries both exact tested and deployed SHAs into the live-verification write', () => {
    const out = buildReleaseTrace(input({ workItem: 'F-123' }));
    expect(out.nextVerb).toMatchObject({
      name: 'work_items:set_live_verified',
      args: { id: 'F-123', testedSha: sha, deployedSha: sha },
    });
  });
  it('treats dirty path lineage as blocking even when its prior commit deployed', () => {
    const out = buildReleaseTrace(input({ position: position({ dirtyUncommitted: true }) }));
    expect(out.nextVerb?.name).toBe('git-sync:await');
    expect(out.constraints.map((c) => c.code)).toContain('dirty-path');
  });
  it('flags a force-deployed lineage as not tested/deployed parity authority', () => {
    const out = buildReleaseTrace(
      input({
        position: position({ verdictProvenance: { ...position().verdictProvenance, deployOrigin: 'ahead-of-gate' } }),
      }),
    );
    expect(out.constraints.map((c) => c.code)).toContain('deployed-ahead-of-gate');
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });
  it('carries active registered awaits and a full-snapshot generation resync', () => {
    const out = buildReleaseTrace(
      input({
        consumerGeneration: 9,
        awaits: [
          {
            event: `release:deployed:${sha}`,
            awaitId: 7,
            subscriberId: 'su-x',
            state: 'registered',
            registeredAt: '2026-01-01T00:00:00Z',
            firedAt: null,
            firedReason: null,
            observedSha: null,
          },
        ],
      }),
    );
    expect(out.awaits.activeRegistrations).toBe(1);
    expect(out.awaits.inspectedKeys).toContain(`release:deployed:${sha}`);
    expect(out.resync).toMatchObject({ required: true, consumerGeneration: 9, authoritativeGeneration: 10 });
  });
  it('does not classify another subscriber’s crossed wake as this caller’s stale wake', () => {
    const out = buildReleaseTrace(
      input({
        wakes: [
          {
            event: 'release:green:papercusp',
            deliveryId: 9,
            subscriberId: 'su-peer',
            status: 'delivered',
            channel: 'resume',
            createdAt: '2026-01-01T00:00:00Z',
            deliveredAt: null,
            observedSha: 'b'.repeat(40),
          },
        ],
      }),
    );
    expect(out.staleWake.verdict).toBe('none');
  });

  it('EI-210996: classifies candidate-bound abnormal termination without a result marker as inconclusive and consumed', () => {
    const checkpointRun = {
      active: false,
      terminalMarker: false,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha.slice(0, 8),
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'checkpoint-run-inconclusive')?.summary).toMatch(
      /explicitly INCONCLUSIVE, not red or green/,
    );
    expect(out.gate.consumedAuthority).toMatchObject({
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-053',
      candidate: sha.slice(0, 8),
      status: 'consumed',
      retryAllowed: false,
    });
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.nextVerb).toBeNull();
  });

  it('EI-21411776375901170: terminal marker does not restore retry after an exact abnormal D-053 terminal', () => {
    const checkpointRun = {
      active: false,
      terminalMarker: true,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha,
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
      }),
    );

    expect(out.gate.consumedAuthority).toMatchObject({
      governingRef: 'stable-candidate-related-gate-2026-08-23#D-053',
      candidate: sha,
      status: 'consumed',
      retryAllowed: false,
      reason: expect.stringContaining('D-053 consumes its one-shot checkpoint authority'),
    });
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.nextVerb).toBeNull();
  });

  it.each(['verdict', 'inconclusive', 'unknown-vintage'])(
    'does not attribute an old manual 137 to a newer scheduled same-SHA %s', (kind) => {
      const checkpointRun = {
        active: false, terminalMarker: false,
        terminalEvidence: {
          source: 'systemd-exec-stop-post' as const, candidate: sha,
          serviceResult: 'exit-code', exitCode: 'exited', exitStatus: '137', abnormal: true,
          observedAtMs: kind === 'unknown-vintage' ? null : 100,
        },
        candidate: null, startedAtMs: null, elapsedSec: null, asOfAgeMs: 0,
      };
      const newer = kind === 'inconclusive' ? {
        status: 'infra-inconclusive', candidate: sha, detail: 'new scheduled attempt', observedAtMs: 200,
      } : null;
      const out = buildReleaseTrace(input({
        position: position({
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun,
            verdictObservedAtMs: newer ? null : 200, inconclusive: newer },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun, inconclusive: newer },
      }));
      expect(out.gate.consumedAuthority).toBeNull();
      expect(out.constraints.some((c) => c.code === 'checkpoint-run-inconclusive')).toBe(false);
      expect(out.constraints.some((c) => c.code === 'checkpoint-authority-consumed')).toBe(false);
    },
  );

  it('preserves an authentic manual terminal newer than the scheduled verdict', () => {
    const checkpointRun = {
      active: false, terminalMarker: false,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const, candidate: sha,
        serviceResult: 'exit-code', exitCode: 'exited', exitStatus: '137', abnormal: true, observedAtMs: 300,
      },
      candidate: null, startedAtMs: null, elapsedSec: null, asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(input({
      position: position({ gate: { ...position().gate, checkpointRunInFlight: checkpointRun, verdictObservedAtMs: 200 } }),
      gate: { ...input().gate, checkpointRunInFlight: checkpointRun },
    }));
    expect(out.gate.consumedAuthority?.candidate).toBe(sha);
  });

  it('EI-21103060581352507: refuses to await a candidate whose checkpoint was cancelled and has no producer', () => {
    const cancelledRun = {
      active: false,
      activeSource: 'run-lock' as const,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const cancelled = {
      status: 'cancelled',
      candidate: sha.slice(0, 8),
      detail: 'externally SIGTERMed before a result marker was published',
      observedAtMs: 123,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: cancelledRun, inconclusive: cancelled },
        }),
        gate: {
          ...input().gate,
          checkpointRunInFlight: cancelledRun,
          inconclusive: cancelled,
        },
      }),
    );

    expect(out.constraints.find((c) => c.code === 'checkpoint-run-cancelled')?.summary).toMatch(
      /externally cancelled without a verdict/i,
    );
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run', args: {} });
    expect(out.nextVerb?.reason).toMatch(/do not await a candidate-bound result/i);
  });
});

describe('EI-21456558908416090: withheld manual checkpoint-run authority', () => {
  /** The exact live shape: a stale gate verdict, which recommends release:checkpoint-run. */
  function staleGate(gateOver: Partial<ReleaseTraceGate> = {}) {
    return input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      }),
      gate: {
        ...input().gate,
        verdictStale: true,
        verdictStaleReason: 'no fire in 3h',
        ...gateOver,
      },
    });
  }

  const withheld = {
    withheld: true as const,
    governingRef: 'stable-candidate-related-gate-2026-08-23#D-061',
    source: 'manual-run-hold' as const,
    reason: "D-042's never-launch-a-duplicate survives this decision intact.",
  };

  // ── CONTROLS ───────────────────────────────────────────────────────────────
  // These two are PERMANENT falsifiability controls, not setup. Without them a
  // suppression that fired unconditionally — the easiest way to get this wrong, and one that
  // would silently blind every reader of a healthy pipeline — would pass the whole suite.

  it('CONTROL: with no withheld authority, a stale gate still recommends release:checkpoint-run', () => {
    const out = buildReleaseTrace(staleGate());
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
    expect(out.constraints.map((c) => c.code)).not.toContain('manual-checkpoint-authority-withheld');
  });

  it('CONTROL: withheld:false is authority GRANTED, not withheld', () => {
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: { ...withheld, withheld: false } }));
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
  });

  it('CONTROL: a withheld authority with a blank governingRef does not suppress', () => {
    // An unattributable prohibition is how an unexplained frozen gate happens. It must not be
    // able to silently remove the recommendation with nothing naming who to ask.
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: { ...withheld, governingRef: '   ' } }));
    expect(out.nextVerb).toMatchObject({ name: 'release:checkpoint-run' });
  });

  // ── THE DEFECT ─────────────────────────────────────────────────────────────

  it('suppresses the release:checkpoint-run recommendation and names the governing decision', () => {
    const out = buildReleaseTrace(staleGate({ manualRunAuthority: withheld }));

    expect(out.nextVerb?.name).not.toBe('release:checkpoint-run');
    expect(out.nextVerb).toMatchObject({ name: 'checkpoint:await', args: { pipeline: 'papercusp' } });
    // A bare null would teach the reader nothing and invite them to reach for the forbidden
    // verb from memory; the reply must say which decision withholds it.
    expect(out.nextVerb?.reason).toContain('stable-candidate-related-gate-2026-08-23#D-061');
    expect(out.nextVerb?.reason).toMatch(/MANUAL CHECKPOINT AUTHORITY WITHHELD/);
  });

  it('generalizes: any governing ref suppresses, not just the decision ids seen so far', () => {
    // The regression this whole item exists to prevent. The prior implementation typed
    // governingRef as the D-053 literal, so D-061 fell through. A future D-099 must not.
    const out = buildReleaseTrace(
      staleGate({
        manualRunAuthority: { ...withheld, governingRef: 'some-future-plan-2027-01-01#D-099' },
      }),
    );
    expect(out.nextVerb?.name).toBe('checkpoint:await');
    expect(out.nextVerb?.reason).toContain('some-future-plan-2027-01-01#D-099');
  });

  it('guards a SECOND recommendation site: the ahead-of-gate deployed lineage', () => {
    // Proves the guard sits at the boundary rather than on one branch. Four separate paths
    // can return release:checkpoint-run; a per-branch fix would leave three armed.
    const aheadOfGate = input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
        verdictProvenance: {
          ...position().verdictProvenance,
          deployOrigin: 'ahead-of-gate',
        },
      }),
    });
    expect(buildReleaseTrace(aheadOfGate).nextVerb).toMatchObject({ name: 'release:checkpoint-run' });

    const guarded = buildReleaseTrace({
      ...aheadOfGate,
      gate: { ...aheadOfGate.gate, manualRunAuthority: withheld },
    });
    expect(guarded.nextVerb?.name).toBe('checkpoint:await');
  });

  it('reports the withholding as a NON-blocking constraint, so a green target still reads ok', () => {
    // `ok` means "this exact SHA is release-complete". A governance decision about who may fire
    // the gate by hand says nothing about that, so it must not flip a green, deployed,
    // parity-matched target to ok:false.
    const complete = input({
      position: position({
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      }),
      gate: { ...input().gate, manualRunAuthority: withheld },
    });
    const out = buildReleaseTrace(complete);

    expect(out.ok).toBe(true);
    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'manual-checkpoint-authority-withheld', blocking: false }),
    );
    expect(out.constraints.find((c) => c.code === 'manual-checkpoint-authority-withheld')?.summary).toMatch(
      /Scheduled gate fires are unaffected/,
    );
  });

  it('does not double-report when the in-module D-053 consumed authority already applies', () => {
    // The consumed authority raises its own BLOCKING constraint and suppresses the verb
    // entirely; adding a second, non-blocking constraint for the same fact would make one
    // prohibition read as two.
    const checkpointRun = {
      active: false,
      terminalMarker: true,
      terminalEvidence: {
        source: 'systemd-exec-stop-post' as const,
        candidate: sha,
        serviceResult: 'oom-kill',
        exitCode: 'killed',
        exitStatus: 'KILL',
        abnormal: true,
      },
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          gate: { ...position().gate, checkpointRunInFlight: checkpointRun },
        }),
        gate: { ...input().gate, checkpointRunInFlight: checkpointRun, manualRunAuthority: withheld },
      }),
    );

    expect(out.constraints).toContainEqual(
      expect.objectContaining({ code: 'checkpoint-authority-consumed', blocking: true }),
    );
    expect(out.constraints.map((c) => c.code)).not.toContain('manual-checkpoint-authority-withheld');
    expect(out.nextVerb).toBeNull();
  });
});

/**
 * P-002 — `nextVerb` may recommend awaiting an in-flight run's verdict ONLY when that run is
 * certified as advancing.
 *
 * The pre-P-002 behaviour recommended `checkpoint:await` from `active === true` alone, which says
 * a run EXISTS, not that it is still deciding. These cases pin the routing: what each verdict
 * recommends, that the several `unknown` bases do not collapse into one sentence, and — the
 * expensive one — that no non-advancing route can reach `release:checkpoint-run`.
 */
describe('P-002: progress-certified checkpoint:await', () => {
  const candidate = 'b'.repeat(40);

  const staleVerdictGate = {
    state: 'gate-verdict-stale' as const,
    authoritative: false,
    consecutiveReds: 3,
    failingTests: [] as string[],
    fireStale: false,
    fireStaleReason: null,
    verdictStale: true,
    verdictStaleReason: 'superseded pin',
  };

  /**
   * Site B: target not green-pinned, a run in flight, and a stale verdict UNDER it.
   *
   * The stale verdict is load-bearing, not scenery — without an in-flight run this same fixture
   * recommends `release:checkpoint-run`, which is what makes "did the progress gate fall through
   * to the forbidden verb?" observable at all. The control case below proves it still does.
   */
  const traceWithRun = (run: Record<string, unknown>) =>
    buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: {
          ...staleVerdictGate,
          checkpointRunInFlight: { active: true, candidate, elapsedSec: 42, ...run },
        } as never,
      }),
    );

  it('control: with no run in flight this fixture DOES recommend firing the gate by hand', () => {
    // Calibration. If this stops recommending release:checkpoint-run, every "did NOT recommend
    // release:checkpoint-run" assertion below starts passing for a reason unrelated to P-002.
    const out = buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: staleVerdictGate as never,
      }),
    );
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });

  it('progressing (live heartbeat): awaits, and carries the certificate reason', () => {
    const out = traceWithRun({ activeSource: 'run-lock', ...advancingHeartbeat(), asOfAgeMs: null });
    expect(out.nextVerb?.name).toBe('checkpoint:await');
    expect(out.nextVerb?.reason).toContain("heartbeat advanced past its start");
  });

  it('verdict-published: reads the verdict that already exists rather than awaiting one', () => {
    // `progressing` is a NECESSARY condition for the await, not a sufficient one: this run is
    // healthy, but the thing the await would wait for has already arrived.
    const out = traceWithRun({
      activeSource: 'run-lock',
      ...advancingHeartbeat(),
      verdictWrittenAtMs: NOW_MS - 30_000,
      asOfAgeMs: null,
    });
    expect(out.nextVerb?.name).toBe('state:read');
    expect(out.nextVerb?.args).toMatchObject({ cell: 'gate.greenCheckpoint.verdict' });
    expect(out.nextVerb?.reason).toContain('already exists');
  });

  it('stalled: measures the producer instead of awaiting it', () => {
    const out = traceWithRun({
      activeSource: 'run-lock',
      ...advancingHeartbeat({ startedAgoMs: 3_600_000, lastSeenAgoMs: 1_800_000 }),
      asOfAgeMs: null,
    });
    expect(out.nextVerb?.name).toBe('processes:list');
    expect(out.nextVerb?.reason).toContain('NOT certified as advancing');
  });

  it('D-004: a stalled run inside its re-triage window names the discarded-rescue cost', () => {
    const out = traceWithRun({
      activeSource: 'run-lock',
      inRetriageWindow: true,
      ...advancingHeartbeat({ startedAgoMs: 3_600_000, lastSeenAgoMs: 1_800_000 }),
      asOfAgeMs: null,
    });
    expect(out.nextVerb?.name).toBe('processes:list');
    expect(out.nextVerb?.reason).toContain('re-triage window');
    expect(out.nextVerb?.reason).toContain('discards');
  });

  it('unknown with a LIVE authority: measures the producer, never a re-read it cannot improve', () => {
    // A live authority already produced the best reading this interface can give, so recommending
    // `dev:pipeline_position` would be a loop: a re-read cannot supply a heartbeat never emitted.
    const out = traceWithRun({ activeSource: 'run-lock', startedAtMs: NOW_MS - 120_000, asOfAgeMs: null });
    expect(out.nextVerb?.name).toBe('processes:list');
    expect(out.nextVerb?.reason).toContain('no heartbeat at all');
  });

  it('D-003 ambiguous-fallback: does not read as a stall', () => {
    const started = NOW_MS - 3_600_000;
    const out = traceWithRun({ activeSource: 'run-lock', startedAtMs: started, progressAtMs: started, asOfAgeMs: null });
    expect(out.nextVerb?.name).toBe('processes:list');
    // The fallback collision is an hour old, so a naive age rule would call it a long stall.
    expect(out.nextVerb?.reason).toContain('not evidence of a stall');
    expect(out.nextVerb?.reason).not.toContain('NOT certified as advancing');
  });

  it('unknown with NO live authority: re-reads from a live authority instead', () => {
    const out = traceWithRun({ startedAtMs: NOW_MS - 120_000, progressAtMs: NOW_MS - 5_000, asOfAgeMs: 7_200_000 });
    expect(out.nextVerb?.name).toBe('dev:pipeline_position');
    expect(out.nextVerb?.reason).toContain('No live authority answered');
  });

  it('no non-advancing route awaits the run or fires the gate by hand', () => {
    // The class invariant over every basis reachable from an active run. Each entry also asserts
    // the forbidden verb is NAMED in the reason — a bare redirect teaches the reader nothing and
    // invites them to reach for `release:checkpoint-run` from memory, which is how the
    // discarded-rescue incident actually happened.
    const nonAdvancing = [
      { activeSource: 'run-lock', startedAtMs: NOW_MS - 120_000, asOfAgeMs: null },
      { activeSource: 'run-lock', startedAtMs: NOW_MS - 600_000, progressAtMs: NOW_MS - 600_000, asOfAgeMs: null },
      {
        activeSource: 'run-lock',
        ...advancingHeartbeat({ startedAgoMs: 3_600_000, lastSeenAgoMs: 1_800_000 }),
        asOfAgeMs: null,
      },
      { activeSource: 'run-lock', startedAtMs: NOW_MS - 120_000, progressAtMs: NOW_MS + 600_000, asOfAgeMs: null },
      { startedAtMs: NOW_MS - 120_000, progressAtMs: NOW_MS - 5_000, asOfAgeMs: 7_200_000 },
      { startedAtMs: NOW_MS - 120_000, progressAtMs: NOW_MS - 5_000, asOfAgeMs: null },
    ];
    for (const run of nonAdvancing) {
      const verb = traceWithRun(run).nextVerb;
      expect(verb?.name).not.toBe('release:checkpoint-run');
      expect(verb?.name).not.toBe('checkpoint:await');
      expect(verb?.reason).toContain('release:checkpoint-run');
    }
  });
});

/**
 * P-003 — the D-004 interlock on the RECOMMENDATION side.
 *
 * P-002 proved that no PROGRESS-GATED route reaches `release:checkpoint-run`. That is a claim
 * about one branch family: the routes taken when a run is in flight and its heartbeat is being
 * certified. D-004 is stronger and total — while a run is inside its auto-refire re-triage
 * window, NO path may recommend firing the gate by hand, because doing so discards the in-flight
 * rescue and spends a ~55min suite.
 *
 * The sites below are deliberately the ones P-002 does NOT cover: they are reached with no run
 * certified in flight, so the progress gate never sees them. Each carries the re-triage flag on
 * the same `checkpointRunInFlight` reading that the certificate reads, which is how the flag is
 * actually delivered in production (git-pipeline-position emits it beside the heartbeat).
 */
describe('P-003: D-004 forbids a manual checkpoint-run inside the re-triage window', () => {
  /** The re-triage reading as production emits it: the voided run is no longer active. */
  const inRetriage = { active: false, inRetriageWindow: true, candidate: null, startedAtMs: null, elapsedSec: null, asOfAgeMs: 0 };

  const staleVerdict = {
    state: 'gate-verdict-stale' as const,
    authoritative: false,
    consecutiveReds: 3,
    failingTests: [] as string[],
    fireStale: false,
    fireStaleReason: null,
    verdictStale: true,
    verdictStaleReason: 'superseded pin',
  };

  /** Site A — a stale gate verdict with nothing in flight. */
  const staleVerdictSite = (run?: Record<string, unknown>) =>
    input({
      position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
      gate: (run ? { ...staleVerdict, checkpointRunInFlight: run } : staleVerdict) as never,
    });

  /** Site B — a force-deployed lineage ahead of the green pin. */
  const aheadOfGateSite = (run?: Record<string, unknown>) =>
    input({
      position: position({ verdictProvenance: { ...position().verdictProvenance, deployOrigin: 'ahead-of-gate' } }),
      gate: (run ? { ...input().gate, checkpointRunInFlight: run } : input().gate) as never,
    });

  const sites: ReadonlyArray<{ name: string; build: (run?: Record<string, unknown>) => ReleaseTraceInput }> = [
    { name: 'stale gate verdict', build: staleVerdictSite },
    { name: 'deployed lineage ahead of the green pin', build: aheadOfGateSite },
  ];

  // ── CONTROLS ───────────────────────────────────────────────────────────────
  // Without these, a suppression that fired unconditionally — or a fixture that stopped
  // reaching the verb for an unrelated reason — would satisfy every assertion below while
  // proving nothing. Each site must genuinely recommend the forbidden verb when the window
  // is absent, or the property under test is untested.

  it('CONTROL: with no re-triage window, every site DOES recommend firing the gate by hand', () => {
    for (const { name, build } of sites) {
      expect({ site: name, verb: buildReleaseTrace(build()).nextVerb?.name }).toEqual({
        site: name,
        verb: 'release:checkpoint-run',
      });
    }
  });

  it('CONTROL: an in-flight reading WITHOUT the flag still recommends it', () => {
    // Proves the suppression keys on the re-triage window itself, not on the mere presence of a
    // `checkpointRunInFlight` reading — which every production trace carries.
    for (const { name, build } of sites) {
      const verb = buildReleaseTrace(build({ ...inRetriage, inRetriageWindow: undefined })).nextVerb?.name;
      expect({ site: name, verb }).toEqual({ site: name, verb: 'release:checkpoint-run' });
    }
  });

  // ── THE INTERLOCK ──────────────────────────────────────────────────────────

  it('suppresses the manual run on every site while the window is open', () => {
    for (const { name, build } of sites) {
      const verb = buildReleaseTrace(build(inRetriage)).nextVerb;
      expect({ site: name, verb: verb?.name }).not.toEqual({ site: name, verb: 'release:checkpoint-run' });
    }
  });

  it('names D-004 and the discarded-rescue cost instead of going silent', () => {
    // A bare null teaches the reader nothing and invites them to reach for the forbidden verb
    // from memory — the same reasoning the withheld-authority guard records above.
    for (const { name, build } of sites) {
      const verb = buildReleaseTrace(build(inRetriage)).nextVerb;
      expect({ site: name, hasVerb: verb !== null && verb !== undefined }).toEqual({ site: name, hasVerb: true });
      expect(verb?.reason).toContain('re-triage window');
      expect(verb?.reason).toContain('discards');
    }
  });
});

/**
 * P-005 / D-015 — the steering kill-switch (FLAGS.RELEASE_TRACE_PROGRESS_CERTIFICATE).
 *
 * D-015 settled REACHABILITY of the `stalled` branch but explicitly carried one risk forward:
 * DEFAULT_STALL_THRESHOLD_MS = 600_000 is a declared JUDGEMENT, and its falsifier — a healthy run
 * observed with a heartbeat gap wider than 600s — is unrun. A run that legitimately goes quiet
 * inside one long test file would therefore be certified `stalled` and steer every reader off a
 * correct await. The flag is the owner's revert for exactly that case.
 *
 * Two properties are worth a test, and only one of them is obvious:
 *   1. OFF really does restore the pre-certificate verb (not a third, untested behaviour), and
 *   2. OFF does NOT disarm the D-004 re-triage interlock. That interlock reads the certificate
 *      too, so gating "the certificate" wholesale would have quietly re-armed the discarded-rescue
 *      footgun — a steering switch silently becoming a safety switch.
 *
 * Every OFF assertion is paired with an ON control, because a fixture that stopped reaching the
 * gated branch for an unrelated reason satisfies every "did not steer" assertion while proving
 * nothing.
 */
describe('P-005: the progress-certificate steering kill-switch', () => {
  const candidate = 'b'.repeat(40);

  const staleVerdictGate = {
    state: 'gate-verdict-stale' as const,
    authoritative: false,
    consecutiveReds: 3,
    failingTests: [] as string[],
    fireStale: false,
    fireStaleReason: null,
    verdictStale: true,
    verdictStaleReason: 'superseded pin',
  };

  /** A run in flight at the not-green-pinned site, with the switch in a stated position. */
  const traceWithRun = (run: Record<string, unknown>, progressCertificateEnabled?: boolean) =>
    buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        progressCertificateEnabled,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: {
          ...staleVerdictGate,
          checkpointRunInFlight: { active: true, candidate, elapsedSec: 42, ...run },
        } as never,
      }),
    );

  /** The heartbeat shape D-015 proved a producer can emit: aged past the stall threshold. */
  const stalledRun = {
    activeSource: 'run-lock',
    ...advancingHeartbeat({ startedAgoMs: 3_600_000, lastSeenAgoMs: 1_800_000 }),
    asOfAgeMs: null,
  };

  const healthyRun = { activeSource: 'run-lock', ...advancingHeartbeat(), asOfAgeMs: null };

  it('CONTROL: with the switch at its default the stalled fixture DOES steer off the await', () => {
    // Calibration for every OFF assertion below. If this stops reaching `processes:list`, the
    // fixture no longer exercises the gated branch and the OFF tests prove nothing.
    const out = traceWithRun(stalledRun);
    expect(out.nextVerb?.name).toBe('processes:list');
    expect(out.nextVerb?.reason).toContain('NOT certified as advancing');
  });

  it('an omitted switch and an explicit true are the same reading', () => {
    // Undefined means ON on purpose: a caller that has not been taught the flag must keep the
    // shipped behaviour rather than silently losing the certificate.
    expect(traceWithRun(stalledRun, true).nextVerb).toEqual(traceWithRun(stalledRun).nextVerb);
  });

  it('OFF: a certified stall returns the plain await, undecorated', () => {
    const out = traceWithRun(stalledRun, false);
    expect(out.nextVerb?.name).toBe('checkpoint:await');
    expect(out.nextVerb?.reason).toContain('await its terminal verdict');
    // The revert must be total: no certificate wording may survive on the verb.
    expect(out.nextVerb?.reason).not.toContain('NOT certified as advancing');
    expect(out.nextVerb?.reason).not.toContain('Do not fire release:checkpoint-run');
  });

  it('OFF: a HEALTHY run also returns the plain await, so OFF is one behaviour and not two', () => {
    // The switch reverts the whole steering, not just its stalled branch. Gating only `stalled`
    // would leave a third behaviour — decorated awaits with no stall detection — that nothing
    // has ever exercised in production.
    const out = traceWithRun(healthyRun, false);
    expect(out.nextVerb?.name).toBe('checkpoint:await');
    expect(out.nextVerb?.reason).not.toContain('heartbeat advanced past its start');
    expect(out.nextVerb?.reason).toEqual(traceWithRun({ active: true, candidate }, false).nextVerb?.reason);
  });

  it('OFF: the D-004 re-triage interlock STILL withholds manual checkpoint authority', () => {
    // The property that makes this a steering switch rather than a safety switch. `inRetriageWindow`
    // is a window-membership fact that no threshold enters, so the carried threshold risk is not a
    // reason to let a manual run through.
    const inRetriage = {
      active: false,
      inRetriageWindow: true,
      candidate: null,
      startedAtMs: null,
      elapsedSec: null,
      asOfAgeMs: 0,
    };
    const out = buildReleaseTrace(
      input({
        progressCertificateEnabled: false,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: { ...staleVerdictGate, checkpointRunInFlight: inRetriage } as never,
      }),
    );
    expect(out.nextVerb?.name).not.toBe('release:checkpoint-run');
    expect(out.nextVerb?.reason).toContain('re-triage window');
    expect(out.nextVerb?.reason).toContain('discards');
  });

  it('CONTROL: with the switch OFF and no re-triage window, that site DOES recommend the manual run', () => {
    // Without this the assertion above passes for a site that never reaches the forbidden verb at
    // all — the suppression would be untested and read as proven.
    const out = buildReleaseTrace(
      input({
        progressCertificateEnabled: false,
        position: position({ positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false } }),
        gate: staleVerdictGate as never,
      }),
    );
    expect(out.nextVerb?.name).toBe('release:checkpoint-run');
  });
});

describe('R-1: an inconclusive candidate may not hand back an uncertified checkpoint:await', () => {
  // EI-23365548566505155. The `inconclusive` branch sits AHEAD of both active-run branches in
  // unguardedNextVerb, so it answers first — and it used to return a BARE `checkpoint:await`,
  // bypassing the progress certificate entirely. That is the EI-21432980132792683 /
  // EI-21433072117655298 stranding shape: `inconclusive` means the latest attempt rendered NO
  // verdict, so for an already-terminal candidate no producer remains and the reader waits on
  // "a verdict that can never arrive". R-1 makes `progressing` NECESSARY for the await.
  const inconclusiveGate = () =>
    ({
      ...input().gate,
      state: 'gate-red',
      authoritative: false,
      consecutiveReds: 3,
      failingTests: [],
      observedCandidate: 'older-candidate',
      recordedVerdict: 'not-green',
      inconclusive: {
        status: 'repair-in-progress',
        candidate: sha,
        detail: 'frozen repair fixer dispatched; no suite run',
        observedAtMs: 123,
      },
    }) as never;

  const traceInconclusive = (
    run: Record<string, unknown> | null,
    progressCertificateEnabled?: boolean,
  ) =>
    buildReleaseTrace(
      input({
        snapshotGeneration: NOW_MS,
        progressCertificateEnabled,
        position: position({
          positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        }),
        gate: { ...(inconclusiveGate() as object), checkpointRunInFlight: run } as never,
      }),
    );

  it('control: the fixture DOES reach the inconclusive branch and awaits a certified advancing run', () => {
    // Calibration. Without this, the "does not await" assertion below would also pass if the
    // fixture stopped reaching this branch at all — an untested guard reading as a proven one.
    const out = traceInconclusive({
      active: true,
      candidate: sha,
      elapsedSec: 42,
      activeSource: 'run-lock',
      asOfAgeMs: null,
      ...advancingHeartbeat(),
    });
    expect(out.gate.candidateVerdict.state).toBe('inconclusive');
    expect(out.nextVerb).toMatchObject({
      name: 'checkpoint:await',
      args: { candidateSha: sha },
    });
  });

  it('does NOT recommend the await when no in-flight producer can be certified', () => {
    const out = traceInconclusive(null);
    expect(out.gate.candidateVerdict.state).toBe('inconclusive');
    // The load-bearing assertion: R-1 forbids the passive wait here, because nothing
    // establishes that a producer is still advancing toward the verdict being awaited.
    expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    expect(out.nextVerb?.name).toBe('dev:pipeline_position');
  });

  it('does NOT recommend the await for a stalled producer, and never says fire the gate by hand', () => {
    const out = traceInconclusive({
      active: true,
      candidate: sha,
      elapsedSec: 4242,
      activeSource: 'run-lock',
      asOfAgeMs: null,
      startedAtMs: NOW_MS - 3_600_000,
      progressAtMs: NOW_MS - 1_800_000,
    });
    expect(out.nextVerb?.name).not.toBe('checkpoint:await');
    expect(out.nextVerb?.name).not.toBe('release:checkpoint-run');
    expect(out.nextVerb?.name).toBe('processes:list');
  });

  it('kill-switch OFF restores the plain await — a clean revert, not a third behaviour', () => {
    // P-005 / D-015: RELEASE_TRACE_PROGRESS_CERTIFICATE gates STEERING only. With it off the
    // reader gets exactly the pre-certificate recommendation, uncertified, by design.
    const out = traceInconclusive(null, false);
    expect(out.nextVerb).toMatchObject({
      name: 'checkpoint:await',
      args: { candidateSha: sha },
    });
  });
});
