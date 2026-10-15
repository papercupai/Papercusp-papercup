import { describe, it, expect, vi } from 'vitest';
import {
  computePipelineHealth,
  computeWhyChain,
  recentFailingFiles,
  splitFailingSignature,
  verifyGateFailingFiles,
  reconcileFailingFiles,
  ledgerFilesForCandidate,
  verifyGateVerdict,
  type AdmissionSnapshotLite,
  type WhyChainDeps,
} from './why-chain';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import * as gitPipelineStats from './git-pipeline-stats';
import type { DevDeployState } from './dev-deploy-state';
import type { AccountStatusRow } from './deployment/account-pool-store';

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    releaseRoot: '/release',
    releaseRef: 'ready',
    integrationBranch: 'main',
    stagingHead: null,
    ready: null,
    originHead: null,
    stagingAheadOfOrigin: null,
    deployed: null,
    deployedAtMs: null,
    deployedBehindStaging: 0,
    greenPinBehindStaging: 0,
    deployedBehindGreenPin: 0,
    greenPinAtStagingHead: true,
    errors: [],
    ...over,
  }) as DevDeployState;

const snap = (over: {
  gate?: Partial<GitPipelineSnapshot['gate']>;
  deploy?: Partial<DevDeployState>;
  gitSync?: Partial<GitPipelineSnapshot['gitSync']>;
  openConflict?: GitPipelineSnapshot['openConflict'];
} = {}): GitPipelineSnapshot =>
  ({
    gate: {
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      firstRedAtMs: null,
      stalled: false,
      lastFiredAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      inconclusive: null,
      lastFixerStatus: null,
      lastFixerAtMs: null,
      lastFixerCandidate: null,
      flakyWorkspaces: [],
      ...over.gate,
    },
    gitSync: {
      lastStatus: 'synced',
      lastSyncedAtMs: 1,
      consecutiveErrorTicks: 0,
      headSha: null,
      lastPushed: [],
      lastMerged: [],
      lastConflicts: [],
      lastErrors: [],
      pushMode: 'push',
      ownHeadPublish: null,
      ...over.gitSync,
    },
    deploy: deploy(over.deploy),
    openConflict: over.openConflict ?? null,
  }) as GitPipelineSnapshot;

const accounts = (rows: Partial<AccountStatusRow>[] = []): AccountStatusRow[] =>
  rows.map((r, i) => ({
    id: `acct-${i}`,
    provider: 'claude',
    credentialRef: 'ref',
    boundTo: [],
    available: true,
    usageWalled: false,
    sustainedlyLimited: false,
    rate: {} as AccountStatusRow['rate'],
    liveBuckets: [],
    ...r,
  })) as AccountStatusRow[];

/** A HEALTHY gateway admission snapshot (EI-10880) — the default so existing cases stay focused. */
const admission = (over: Partial<AdmissionSnapshotLite> = {}): AdmissionSnapshotLite => ({
  running: 2,
  queued: 0,
  maxConcurrent: 24,
  tier1Reserve: 4,
  byTier: [],
  aimdEffective: 24,
  aimdCap: 24,
  ...over,
});

function deps(over: Partial<WhyChainDeps> & { snap?: GitPipelineSnapshot; accounts?: AccountStatusRow[] } = {}): WhyChainDeps {
  return {
    loadSnapshot: async () => over.snap ?? snap(),
    loadAccounts: async () => over.accounts ?? accounts([{}, {}]),
    loadAdmission: over.loadAdmission ?? (async () => admission()),
    sql: over.sql ?? (async () => [] as unknown[]) as WhyChainDeps['sql'],
    ...over,
  };
}

describe('computeWhyChain (EI-7349)', () => {
  it('loads and computes with injected readers while unrelated runtime imports are unavailable', async () => {
    vi.resetModules();
    vi.doMock('./git-pipeline-position', () => { throw new Error('pipeline position resolver must stay unloaded'); });
    vi.doMock('./deployment/account-pool-store', () => { throw new Error('account runtime must stay unloaded'); });
    try {
      const isolated = await import('./why-chain');
      const result = await isolated.computeWhyChain(deps());
      expect(result.stages.map(stage => stage.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      expect(result.rootCause).toBeNull();
    } finally {
      vi.doUnmock('./git-pipeline-position');
      vi.doUnmock('./deployment/account-pool-store');
      vi.resetModules();
    }
  });

  it('all-green: every stage ok, no root cause', async () => {
    const res = await computeWhyChain(deps());
    expect(res.stages.map((s) => s.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(res.rootCause).toBeNull();
    expect(res.summary).toContain('nominal');
    expect(res.configured.stageOrder).toEqual(['gate', 'deploy', 'admission', 'pool']);
    expect(res.effective).toEqual({ status: 'ok', blockingStage: null });
    expect(res.evidence.stages).toBe(res.stages);
    expect(res.nextVerb).toBeNull();
  });

  it('discloses when the diagnostic process is older than staging', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({
          deploy: {
            stagingHead: { sha: 'aaaaaaaa1111111', shortSha: 'aaaaaaaa1111', committedAtMs: 1, subject: 'tip' },
            greenPin: { sha: 'bbbbbbbb2222222', shortSha: 'bbbbbbbb2222', committedAtMs: 1, subject: 'green' },
          },
        }),
        loadProcessSha: () => 'cccccccc3333333',
      }),
    );
    expect(res.diagnosticVintage.status).toBe('stale');
    expect(res.diagnosticVintage.processMatchesStaging).toBe(false);
    expect(res.diagnosticVintage.warning).toContain('may predate current fixes');
    expect(res.diagnosticVintage.warning).toContain('Verify any nextVerb');
  });

  it('defaults the live snapshot read to local git instead of lazily booting the spawner sidecar', async () => {
    const snapshotSpy = vi.spyOn(gitPipelineStats, 'gitPipelineSnapshot').mockResolvedValue(snap());
    const input = deps();
    delete input.loadSnapshot;
    try {
      await computeWhyChain(input);
      expect(snapshotSpy).toHaveBeenCalledWith(undefined, { useSpawnerSidecar: false });
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  it('scopes the live snapshot read to the requested harness', async () => {
    const snapshotSpy = vi.spyOn(gitPipelineStats, 'gitPipelineSnapshot').mockImplementation(async (slug) =>
      snap({
        gate: { consecutiveReds: slug === 'scout-runtime' ? 2 : 0 },
      }),
    );
    const input = deps({ harnessSlug: 'scout-runtime' });
    delete input.loadSnapshot;
    try {
      const res = await computeWhyChain(input);
      expect(snapshotSpy).toHaveBeenCalledWith('scout-runtime', { useSpawnerSidecar: false });
      expect(res.configured.harnessSlug).toBe('scout-runtime');
      expect(res.rootCause?.stage).toBe('gate');
      expect(res.summary).toContain('2 consecutive');
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  it('gate red but not stalled: degraded, cites recent failing files', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ gate: { consecutiveReds: 3 } }),
        sql: (async () => [
          { file_path: 'apps/x/y.test.ts', finished_at: new Date().toISOString() },
        ]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.stages[0].status).toBe('degraded');
    expect(res.stages[0].reason).toContain('3 consecutive');
    expect(res.stages[0].reason).toContain('apps/x/y.test.ts');
    expect(res.rootCause?.stage).toBe('gate');
    expect(res.effective).toEqual({ status: 'degraded', blockingStage: 'gate' });
    expect(res.nextVerb).toBe('testing:flakiness');
  });

  it('gate stalled: blocked root cause', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ gate: { consecutiveReds: 20, stalled: true } }) }));
    expect(res.rootCause?.stage).toBe('gate');
    expect(res.rootCause?.status).toBe('blocked');
    expect(res.summary).toContain('ROOT CAUSE: gate');
  });

  it('gate wedged (fireStale) takes priority over a plain red streak', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ gate: { fireStale: true, fireStaleReason: 'no fire in 90m' } }) }),
    );
    expect(res.stages[0].reason).toContain('WEDGED');
    expect(res.stages[0].reason).toContain('no fire in 90m');
    expect(res.nextVerb).toBe('release:checkpoint-run');
  });

  it('open merge conflict blocks the gate stage regardless of red streak', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ openConflict: { scopes: ['libs/foo'], conflicts: [], emittedAtMs: Date.now() } }),
      }),
    );
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('merge conflict');
    expect(res.stages[0].reason).toContain('libs/foo');
  });

  it('a migration-preflight ABORT is inconclusive, suppresses historical reds, and names the clear lever', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({
          gate: {
            consecutiveReds: 4,
            observedCandidate: 'oldred123456',
            failingTests: ['lib/historical-red.test.ts'],
            fireStale: true,
            fireStaleReason: 'stale counter beside an aborted tick',
            inconclusive: {
              status: 'migrations-pending',
              candidate: 'newcandidate12',
              detail: 'migration 1044 could not apply: snapshot precondition failed',
              observedAtMs: Date.now(),
            },
          } as Partial<GitPipelineSnapshot['gate']>,
        }),
        sql: (async () => [{ file_path: 'lib/proxy-historical.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('INCONCLUSIVE');
    expect(res.stages[0].reason).toContain('migrations-pending');
    expect(res.stages[0].reason).toContain('migration 1044');
    expect(res.stages[0].reason).toContain('historical red(s)');
    expect(res.stages[0].reason).not.toContain('historical-red.test.ts');
    expect(res.nextVerb).toContain("clear the gate's abort condition");
    expect(res.nextVerb).toContain('migrations-pending');
    expect(res.recentFailingFiles).toEqual([]);
  });

  it('a transient ABORT is inconclusive and explicitly permits a re-fire without triaging old files', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({
          gate: {
            consecutiveReds: 2,
            failingTests: ['lib/old-red.test.ts'],
            inconclusive: {
              status: 'cancelled',
              candidate: 'candidate123456',
              detail: 'checkpoint received an external termination signal',
              observedAtMs: Date.now(),
            },
          } as Partial<GitPipelineSnapshot['gate']>,
        }),
      }),
    );
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('cancelled');
    expect(res.stages[0].reason).toContain('nothing about it blocks a re-fire');
    expect(res.stages[0].reason).not.toContain('old-red.test.ts');
    expect(res.nextVerb).toContain('nothing is blocking a re-fire');
    expect(res.recentFailingFiles).toEqual([]);
  });

  it('an OPEN conflict still outranks an inconclusive checkpoint abort', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({
          openConflict: { scopes: ['packages/operator-core'], conflicts: [], emittedAtMs: Date.now() },
          gate: {
            inconclusive: {
              status: 'migrations-pending',
              candidate: 'candidate123456',
              detail: 'migration preflight stopped',
              observedAtMs: Date.now(),
            },
          } as Partial<GitPipelineSnapshot['gate']>,
        }),
      }),
    );
    expect(res.stages[0].reason).toContain('OPEN merge conflict');
    expect(res.stages[0].reason).not.toContain('INCONCLUSIVE');
    expect(res.nextVerb).toBeNull();
  });

  // ── EI-11012: the staging buffer is NOT a deploy fault ────────────────────
  // These three pin the fix. The deploy stage MUST stay ok while staging runs ahead of the
  // green pin (the normal steady state: git-sync commits staging continuously; the gate FFs
  // main only hourly + only when green). The old behaviour degraded on it, which made the
  // deploy stage permanently degraded — and since rootCause is the FIRST non-ok stage, that
  // shadowed every real downstream cause.
  it('staging ahead of the green pin (the staging buffer) does NOT degrade the deploy stage', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }) }),
    );
    expect(res.stages[1].status).toBe('ok');
    expect(res.rootCause).toBeNull();
  });

  it('a staging buffer is REPORTED (as normal) in the ok reason, not hidden', async () => {
    const res = await computeWhyChain(
      deps({ snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }) }),
    );
    expect(res.stages[1].reason).toContain('10 commit');
    expect(res.stages[1].reason).toContain('normal');
  });

  it('a staging buffer never shadows a real downstream cause (rootCause reaches the pool)', async () => {
    const res = await computeWhyChain(
      deps({
        snap: snap({ deploy: { greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }),
        accounts: accounts([{ available: false }, { available: false }]),
      }),
    );
    expect(res.stages[1].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('green pin ahead of what is live on :3070: deploy stage degraded (the REAL deploy gap)', async () => {
    const res = await computeWhyChain(deps({ snap: snap({ deploy: { deployedBehindGreenPin: 2 } }) }));
    expect(res.stages[1].status).toBe('degraded');
    expect(res.stages[1].reason).toContain('2 commit');
    expect(res.stages[1].reason).toContain('not yet deployed');
    expect(res.rootCause?.stage).toBe('deploy');
  });

  // ── EI-19341938682536275: local-unpushed-to-origin is NEVER "normal", unlike the staging
  // buffer above. dev:why used to report "DEPLOY: ok … 99 commits … normal" through a 6h origin
  // freeze because it never looked past LOCAL HEAD at all. These pin the fix.
  describe('EI-19341938682536275 — unpushed-to-origin is the safety-critical leg, never glossed as normal', () => {
    it('commits unpushed to origin degrade the deploy stage, even with an otherwise-healthy pipeline', async () => {
      const res = await computeWhyChain(
        deps({ snap: snap({ deploy: { stagingAheadOfOrigin: 99, greenPinBehindStaging: 99, deployedBehindGreenPin: 0 } }) }),
      );
      expect(res.stages[1].status).toBe('degraded');
      expect(res.stages[1].reason).toContain('99 commit');
      expect(res.stages[1].reason).toContain('origin');
      // The message itself may legitimately SAY "never normal" — assert against the
      // specific staging-buffer gloss it must not carry, not the bare substring.
      expect(res.stages[1].reason).not.toContain('await the next gate run — normal');
      expect(res.rootCause?.stage).toBe('deploy');
    });

    it('a SMALL unpushed count is degraded too — it is never "normal", however small', async () => {
      const res = await computeWhyChain(deps({ snap: snap({ deploy: { stagingAheadOfOrigin: 1 } }) }));
      expect(res.stages[1].status).toBe('degraded');
      expect(res.stages[1].reason).toContain('1 commit');
      // The message itself may legitimately SAY "never normal" — assert against the
      // specific staging-buffer gloss it must not carry, not the bare substring.
      expect(res.stages[1].reason).not.toContain('await the next gate run — normal');
    });

    it('unpushed-to-origin outranks the ordinary staging buffer AND the real deploy gap (checked first)', async () => {
      const res = await computeWhyChain(
        deps({
          snap: snap({ deploy: { stagingAheadOfOrigin: 5, deployedBehindGreenPin: 2, greenPinBehindStaging: 5 } }),
        }),
      );
      expect(res.stages[1].reason).toContain('origin');
      expect(res.stages[1].reason).not.toContain('not yet deployed');
    });

    it('stagingAheadOfOrigin: 0 (fully caught up) does NOT degrade the deploy stage', async () => {
      const res = await computeWhyChain(
        deps({ snap: snap({ deploy: { stagingAheadOfOrigin: 0, greenPinBehindStaging: 10 } }) }),
      );
      expect(res.stages[1].status).toBe('ok');
      expect(res.rootCause).toBeNull();
    });

    it('stagingAheadOfOrigin: null (unmeasured — e.g. no origin remote) preserves prior behaviour', async () => {
      const res = await computeWhyChain(
        deps({ snap: snap({ deploy: { stagingAheadOfOrigin: null, greenPinBehindStaging: 10, deployedBehindGreenPin: 0 } }) }),
      );
      expect(res.stages[1].status).toBe('ok');
      expect(res.stages[1].reason).toContain('normal');
    });

    it('WI-37998: a caught-up bridged member does not reinterpret designed origin divergence as a stuck push', async () => {
      const res = await computeWhyChain(
        deps({
          snap: snap({
            deploy: { stagingAheadOfOrigin: 132, greenPinBehindStaging: 0, deployedBehindGreenPin: 0 },
            gitSync: {
              pushMode: 'commit-only:bridged',
              ownHeadPublish: {
                refused: null,
                backlogRemains: false,
                publishedSha: 'abcdef123456',
                sha: 'abcdef123456',
              },
            },
          }),
        }),
      );

      expect(res.stages[1].status).toBe('ok');
      expect(res.stages[1].reason).not.toContain('NOT backed up');
      expect(res.stages[1].reason).not.toContain('stuck push');
    });

    it('WI-37998: a bridged publish refusal stays actionable without prescribing git-sync as the pusher', async () => {
      const res = await computeWhyChain(
        deps({
          snap: snap({
            deploy: { stagingAheadOfOrigin: 132 },
            gitSync: {
              pushMode: 'commit-only:bridged',
              ownHeadPublish: {
                refused: 'secrets',
                backlogRemains: null,
                publishedSha: null,
                sha: 'abcdef123456',
              },
            },
          }),
        }),
      );

      expect(res.stages[1]).toMatchObject({ status: 'degraded', nextVerb: 'dev:pipeline_position' });
      expect(res.stages[1].reason).toContain('REFUSING');
      expect(res.stages[1].reason).toContain('git-sync:run cannot fix');
      expect(res.stages[1].reason).not.toContain('stuck push');
    });

    it('WI-37998: an undrained bridged publish backlog is degraded on its real leg', async () => {
      const res = await computeWhyChain(
        deps({
          snap: snap({
            deploy: { stagingAheadOfOrigin: 132 },
            gitSync: {
              pushMode: 'commit-only:bridged',
              ownHeadPublish: {
                refused: null,
                backlogRemains: true,
                publishedSha: '11111111aaaa',
                sha: '22222222bbbb',
              },
            },
          }),
        }),
      );

      expect(res.stages[1]).toMatchObject({ status: 'degraded', nextVerb: 'dev:pipeline_position' });
      expect(res.stages[1].reason).toContain('undrained backlog');
      expect(res.stages[1].reason).toContain('11111111 trails 22222222');
      expect(res.stages[1].reason).toContain('git-sync:run cannot drain');
    });
  });

  it('all accounts unavailable: pool stage blocked', async () => {
    const res = await computeWhyChain(deps({ accounts: accounts([{ available: false }, { available: false }]) }));
    expect(res.stages[3].status).toBe('blocked');
    expect(res.stages[3].reason).toContain('unavailable');
    expect(res.rootCause?.stage).toBe('pool');
    expect(res.nextVerb).toBe('accounts:status');
  });

  it('some accounts sustained-limited but others available: pool stage degraded, not blocked', async () => {
    const res = await computeWhyChain(
      deps({ accounts: accounts([{ sustainedlyLimited: true }, { available: true }]) }),
    );
    expect(res.stages[3].status).toBe('degraded');
    expect(res.stages[3].reason).toContain('1/2');
  });

  it('multiple non-ok stages: rootCause is the upstream-most (gate before deploy before pool)', async () => {
    const res = await computeWhyChain(
      deps({
        // deployedBehindGreenPin (NOT the staging buffer) is what makes the deploy stage
        // non-ok since EI-11012 — using greenPinBehindStaging here would leave deploy ok and
        // silently stop exercising the gate-before-deploy ordering this test exists to pin.
        snap: snap({ gate: { consecutiveReds: 2 }, deploy: { deployedBehindGreenPin: 1 } }),
        accounts: accounts([{ available: false }]),
      }),
    );
    expect(res.rootCause?.stage).toBe('gate');
  });

  it('accounts load failure degrades to empty pool (never throws)', async () => {
    const res = await computeWhyChain({
      loadSnapshot: async () => snap(),
      loadAccounts: async () => {
        throw new Error('boom');
      },
      // MUST inject: without it the default loader would fetch the REAL gateway on :8788 from a unit test.
      loadAdmission: async () => admission(),
      sql: (async () => []) as unknown as WhyChainDeps['sql'],
    });
    expect(res.stages[3].reason).toContain('no accounts registered');
  });

  // ── ADMISSION stage (EI-10880) — the WI-4541 class ──────────────────────────────────────────
  // The whole point: gate/deploy/pool can ALL be green while the fleet is crawling, because the
  // bottleneck is the queue itself. These pin the stage that makes that visible.

  it('WI-4541 repro: QUEUED while slots sit IDLE ⇒ admission BLOCKED and named ROOT CAUSE, even with a healthy pool', async () => {
    // The exact live shape: 12 slots, reserve 2, 1 running, 3 queued — 9 shared slots idle while
    // work waits, because the bottom tier's cap was shed to 1. Gate/deploy/pool are all fine.
    const res = await computeWhyChain(
      deps({
        loadAdmission: async () =>
          admission({
            running: 1,
            queued: 3,
            maxConcurrent: 12,
            tier1Reserve: 2,
            byTier: [
              { tier: 1, minShare: 24, inFlight: 0, queued: 0 },
              { tier: 5, minShare: 1, inFlight: 1, queued: 3 },
            ],
            aimdEffective: 12,
            aimdCap: 24,
          }),
      }),
    );
    const adm = res.stages[2];
    expect(adm.stage).toBe('admission');
    expect(adm.status).toBe('blocked');
    expect(adm.reason).toContain('QUEUED');
    expect(adm.reason).toContain('IDLE');
    expect(adm.reason).toContain('ADMISSION-PATH DEFECT');
    expect(adm.reason).toContain('tier 5');
    // The whole failure this stage exists to prevent: the pool is HEALTHY, so a gate/deploy/pool
    // chain would have reported "all nominal" and named no root cause at all.
    expect(res.stages[3].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('admission');
    expect(res.summary).toContain('ROOT CAUSE: admission');
  });

  it('admission does NOT false-alarm when the idle slots are only the reserved tier-1 floor', async () => {
    // running 10, max 12, reserve 2 ⇒ freeShared = 0. Two slots ARE idle, but they are HELD for the
    // interactive lane on purpose. Queued work here is correct behavior, not a defect.
    const res = await computeWhyChain(
      deps({ loadAdmission: async () => admission({ running: 10, queued: 5, maxConcurrent: 12, tier1Reserve: 2 }) }),
    );
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('genuinely FULL');
    expect(res.stages[2].reason).not.toContain('DEFECT');
  });

  it('a deep AIMD shrink is flagged degraded (the WI-4541 precondition) even with nothing queued', async () => {
    const res = await computeWhyChain(
      deps({ loadAdmission: async () => admission({ running: 1, queued: 0, aimdEffective: 6, aimdCap: 24 }) }),
    );
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('6/24');
  });

  it('gateway unreachable ⇒ admission degraded, chain still returns (never throws)', async () => {
    const res = await computeWhyChain(deps({ loadAdmission: async () => null }));
    expect(res.stages[2].status).toBe('degraded');
    expect(res.stages[2].reason).toContain('unreachable');
  });

  it('a BLOCKED pool still wins root cause when admission is healthy (no over-claiming)', async () => {
    const res = await computeWhyChain(deps({ accounts: accounts([{ available: false }]) }));
    expect(res.stages[2].status).toBe('ok');
    expect(res.rootCause?.stage).toBe('pool');
  });

  it('recentFailingFiles degrades to [] on a query error instead of throwing', async () => {
    const files = await recentFailingFiles({
      sql: (async () => {
        throw new Error('no such table');
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(files).toEqual([]);
  });
});

/**
 * WI-4533 — the gate's COLOUR, and the two things it must refuse to say.
 *
 * The chain is what an agent reads to decide what to go fix, so a wrong colour here does not just
 * misinform: it DISPATCHES someone. Both silences below are load-bearing.
 */
const withRoutines = (s: GitPipelineSnapshot, hasGate = true): GitPipelineSnapshot =>
  ({
    ...s,
    routines: {
      gitSync: null,
      greenCheckpoint: hasGate ? ({ name: 'green-checkpoint', active: true } as unknown) : null,
      releaseTrigger: null,
    },
  }) as GitPipelineSnapshot;

/** A gate whose recorded RED is stale (WI-4489): the streak is real, the verdict is superseded. */
const staleRed = (reds = 4) =>
  withRoutines(
    snap({
      gate: {
        consecutiveReds: reds,
        verdictStale: true,
        verdictStaleReason: 'the release pin advanced past the pin this red was recorded against',
      } as Partial<GitPipelineSnapshot['gate']>,
    }),
  );

describe('WI-4533 — gateLabel + the stale-verdict rule', () => {
  it('a STALE red is NOT reported as red — it is an UNKNOWN colour', async () => {
    const res = await computeWhyChain(deps({ snap: staleRed() }));
    const gate = res.stages[0];
    expect(gate.status).toBe('degraded'); // not 'blocked' — we do NOT know it is broken
    expect(gate.reason).toContain('STALE');
    expect(gate.reason).toContain('UNKNOWN');
    // The precise regression WI-4489 was filed for: a starved gate_health blob reported 4 reds
    // while every real run was green, and the chain's confident RED dispatched the release-fixer.
    expect(gate.reason).not.toMatch(/gate red \(/);
  });

  it('a stale verdict names NO failing tests — naming them is what re-arms the phantom dispatch', async () => {
    const res = await computeWhyChain(
      deps({
        snap: staleRed(),
        sql: (async () => [{ file_path: 'lib/innocent.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    // The file is in recentFailingFiles (it really did fail in the window) — but the STALE gate
    // stage must not hand it to anyone as "the thing to go fix".
    expect(res.recentFailingFiles).toContain('lib/innocent.test.ts');
    expect(res.stages[0].reason).not.toContain('innocent.test.ts');
  });

  it('a FRESH red still reports red, with its failing files (the stale rule must not muzzle a real red)', async () => {
    const res = await computeWhyChain(
      deps({
        snap: withRoutines(snap({ gate: { consecutiveReds: 2 } })),
        sql: (async () => [{ file_path: 'lib/broken.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.stages[0].status).toBe('degraded');
    expect(res.stages[0].reason).toContain('gate red (2 consecutive');
    expect(res.stages[0].reason).toContain('lib/broken.test.ts');
  });

  it('a WEDGED (non-firing) gate outranks a stale verdict — the routine not running is the bigger fact', async () => {
    const s = withRoutines(
      snap({ gate: { consecutiveReds: 3, verdictStale: true, fireStale: true, fireStaleReason: 'no fire in 6h' } as Partial<GitPipelineSnapshot['gate']> }),
    );
    const res = await computeWhyChain(deps({ snap: s }));
    expect(res.stages[0].status).toBe('blocked');
    expect(res.stages[0].reason).toContain('WEDGED');
  });
});

describe('WI-4533 — computePipelineHealth (the coord:orient fold)', () => {
  it('reports known:false for a harness with NO green-checkpoint routine (never a false green)', async () => {
    const res = await computePipelineHealth(deps({ snap: withRoutines(snap(), false) }));
    // A harness that runs no checkpoint has a zero-red gate_health by default — which would render
    // as a confident "green" to a waking agent. A detector with no data must say UNKNOWN.
    expect(res.known).toBe(false);
    expect(res.rootCause).toBeNull();
  });

  it('a GREEN gate pays for NO failing-files query (the hot-path cost discipline)', async () => {
    let queried = 0;
    const res = await computePipelineHealth(
      deps({
        snap: withRoutines(snap()),
        sql: (async () => {
          queried++;
          return [];
        }) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateLabel).toBe('green');
    expect(res.known).toBe(true);
    expect(queried).toBe(0); // no red ⇒ no query. This leg rides orient; it must be ~free when healthy.
  });

  it('a RED gate fetches its failing files and names the gate as root cause', async () => {
    const res = await computePipelineHealth(
      deps({
        snap: withRoutines(snap({ gate: { consecutiveReds: 1 } })),
        sql: (async () => [{ file_path: 'lib/red.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateLabel).toBe('red');
    expect(res.recentFailingFiles).toEqual(['lib/red.test.ts']);
    expect(res.rootCause?.stage).toBe('gate');
  });

  it('carries the DEPLOY position — a green gate whose GREEN code is not live is still not-shipped', async () => {
    // EI-11012: "not live" is deployedBehindGreenPin (green pin ahead of :3070) — NOT
    // greenPinBehindStaging, which is merely the staging buffer. This test used to express
    // "not live" as the buffer, which is why the bug survived: the fixture agreed with the bug.
    const res = await computePipelineHealth(
      deps({ snap: withRoutines(snap({ deploy: { deployedBehindGreenPin: 2 } })) }),
    );
    expect(res.gateLabel).toBe('green');
    expect(res.rootCause?.stage).toBe('deploy'); // the gate is fine; the SHIP is not
  });

  it('carries the staging buffer in the payload WITHOUT making it the root cause', async () => {
    const res = await computePipelineHealth(
      deps({ snap: withRoutines(snap({ deploy: { greenPinBehindStaging: 49, deployedBehindGreenPin: 0 } })) }),
    );
    expect(res.gateLabel).toBe('green');
    expect(res.greenPinBehindStaging).toBe(49); // still reported (useful: is the gate keeping up?)
    expect(res.rootCause).toBeNull(); // ...but 49 commits of un-gated staging is NOT a deploy fault
  });

  it('labels a stale verdict distinctly, so the orient fold can refuse to name its tests', async () => {
    const res = await computePipelineHealth(deps({ snap: staleRed(2) }));
    expect(res.gateLabel).toBe('stale-verdict');
    expect(res.verdictStale).toBe(true);
  });

  it('propagates a structured migration ABORT and suppresses historical failing files in PipelineHealth', async () => {
    const inconclusive = {
      status: 'migrations-pending',
      candidate: 'candidate123456',
      detail: 'migration 1044 is pending',
      observedAtMs: Date.now(),
    };
    const res = await computePipelineHealth(
      deps({
        snap: withRoutines(
          snap({
            gate: {
              consecutiveReds: 3,
              failingTests: ['lib/historical.test.ts'],
              inconclusive,
            } as Partial<GitPipelineSnapshot['gate']>,
          }),
        ),
        sql: (async () => [{ file_path: 'lib/proxy.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateLabel).toBe('inconclusive');
    expect(res.inconclusive).toEqual(inconclusive);
    expect(res.recentFailingFiles).toEqual([]);
    expect(res.gate.reason).toContain('migration 1044');
    expect(res.gate.reason).not.toContain('historical.test.ts');
    expect(res.rootCause?.nextVerb).toContain("clear the gate's abort condition");
  });
});

/**
 * WI-4533 — WHAT is red. The gate records the tests that redded it (`gate_health.failingTests`);
 * nothing surfaced them, so every consumer fell back to a 2h `test_runs` scan that answers a
 * DIFFERENT question. Live on a red gate the scan returned nothing while the gate's own record held
 * all four culprits: the chain said "gate red" and named no one.
 */
describe('WI-4533 — namedFailures: the gate\'s own verdict beats the time-window proxy', () => {
  const redNaming = (tests: string[]) =>
    withRoutines(snap({ gate: { consecutiveReds: 1, failingTests: tests } as Partial<GitPipelineSnapshot['gate']> }));

  it('names the tests the GATE named, and does not even run the proxy scan', async () => {
    let scanned = 0;
    const res = await computePipelineHealth(
      deps({
        snap: redNaming(['lib/a.test.ts', 'lib/b.test.ts']),
        sql: (async () => {
          scanned++;
          return [];
        }) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.recentFailingFiles).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(res.gate.reason).toContain('lib/a.test.ts');
    expect(scanned).toBe(0); // first-hand evidence in hand ⇒ no proxy query at all
  });

  it('falls back to the proxy scan for an OLD blob that never recorded failingTests', async () => {
    // `undefined`, not `[]` — the pre-WI-4533 shape. This is the case a `?.length === 0` guard
    // would have silently skipped, leaving exactly the oldest gates with no names at all.
    const old = withRoutines(snap({ gate: { consecutiveReds: 1 } }));
    delete (old.gate as { failingTests?: unknown }).failingTests;
    const res = await computePipelineHealth(
      deps({
        snap: old,
        sql: (async () => [{ file_path: 'lib/proxy.test.ts', finished_at: new Date().toISOString() }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.recentFailingFiles).toEqual(['lib/proxy.test.ts']);
  });

  it('a STALE verdict still names NOBODY, even though it has failingTests recorded', async () => {
    // The strongest case for the stale rule: the blob is FULL of names, and they are exactly the
    // names a phantom dispatch would chase (WI-4489). The gate's colour is unknown ⇒ say nothing.
    const s = withRoutines(
      snap({
        gate: {
          consecutiveReds: 4,
          verdictStale: true,
          verdictStaleReason: 'the release pin advanced past this red',
          failingTests: ['lib/innocent.test.ts', 'lib/also-innocent.test.ts'],
        } as Partial<GitPipelineSnapshot['gate']>,
      }),
    );
    const res = await computeWhyChain(deps({ snap: s }));
    expect(res.stages[0].reason).toContain('STALE');
    expect(res.stages[0].reason).not.toContain('innocent');
  });
});

/**
 * EI-17603 — the checkpoint's OWN `failingTests` can be disjoint from the ledger for the exact
 * commit it was recorded against: named files that all pass, while the ledger's real reds for
 * that same commit go unnamed. Observed live 2026-07-25 (see EI-18654828745839756).
 */
describe('EI-17603 — splitFailingSignature: a package/step name never masquerades as a file', () => {
  it('separates package-scoped workspace names and lint: step sentinels from real file paths', () => {
    const { failingFiles, failingSteps } = splitFailingSignature([
      '@papercusp/operator-core',
      '@papercusp/operator-vite',
      'lib/harness/improvements/watchdog.test.ts',
      'src/__tests__/typecheck-ratchet.test.ts',
      'lint:tsc',
      'lint:migrations',
    ]);
    expect(failingSteps.sort()).toEqual(['@papercusp/operator-core', '@papercusp/operator-vite', 'lint:migrations', 'lint:tsc'].sort());
    expect(failingFiles.sort()).toEqual(['lib/harness/improvements/watchdog.test.ts', 'src/__tests__/typecheck-ratchet.test.ts'].sort());
  });

  it('an empty signature splits into two empty arrays', () => {
    expect(splitFailingSignature([])).toEqual({ failingFiles: [], failingSteps: [] });
  });
});

describe('EI-17603 — verifyGateFailingFiles: pure ledger cross-check verdict', () => {
  it('confirmed: at least one named file has a matching ledger row', () => {
    expect(verifyGateFailingFiles(['lib/a.test.ts', 'lib/b.test.ts'], ['lib/b.test.ts', 'lib/c.test.ts'])).toBe('confirmed');
  });

  it('disjoint: ledger has evidence for this commit, none of it matches the named files', () => {
    expect(verifyGateFailingFiles(['lib/a.test.ts'], ['lib/totally-different.test.ts'])).toBe('disjoint');
  });

  it('unverifiable: no ledger rows at all for this commit — absence is not evidence of wrongness', () => {
    expect(verifyGateFailingFiles(['lib/a.test.ts'], [])).toBe('unverifiable');
  });

  it('confirmed (trivially): nothing named means nothing to contradict', () => {
    expect(verifyGateFailingFiles([], [])).toBe('confirmed');
    expect(verifyGateFailingFiles([], ['lib/whatever.test.ts'])).toBe('confirmed');
  });
});

describe('EI-17603 — ledgerFilesForCandidate: the commit-scoped ledger read', () => {
  it('never queries for a null or too-short candidate sha', async () => {
    let queried = 0;
    const bump = (async () => {
      queried++;
      return [];
    }) as unknown as WhyChainDeps['sql'];
    expect(await ledgerFilesForCandidate(null, { sql: bump })).toEqual([]);
    expect(await ledgerFilesForCandidate('abc123', { sql: bump })).toEqual([]); // < 7 chars
    expect(queried).toBe(0);
  });

  it('queries commit_sha LIKE for a real candidate and returns distinct file paths', async () => {
    const res = await ledgerFilesForCandidate('deadbee1234', {
      sql: (async () => [{ file_path: 'lib/real.test.ts' }, { file_path: 'lib/real2.test.ts' }]) as unknown as WhyChainDeps['sql'],
    });
    expect(res.sort()).toEqual(['lib/real.test.ts', 'lib/real2.test.ts']);
  });

  it('degrades to [] on a query error instead of throwing', async () => {
    const res = await ledgerFilesForCandidate('deadbee1234', {
      sql: (async () => {
        throw new Error('boom');
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(res).toEqual([]);
  });

  it('EI-18795303393201472: excludes worktree_dirty rows — the query filters worktree_dirty = false', async () => {
    // A torn-read row from a run against the shared, concurrently-edited tree can be
    // stamped with a commit sha it never actually ran at. This is first-hand evidence
    // for an EXACT candidate (verifyGateVerdict below can clear the gate's own named
    // failures when it disagrees), so a dirty row must never be trusted here — assert
    // the generated SQL actually carries the filter, not just that the mock's canned
    // rows come back (a content-blind mock can't catch a dropped WHERE clause).
    let capturedSql = '';
    await ledgerFilesForCandidate('deadbee1234', {
      sql: (async (strings: TemplateStringsArray) => {
        capturedSql = strings.join('');
        return [];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(capturedSql).toContain('worktree_dirty = false');
  });

  it("WI-6825: requires source = 'ci' — a local dev run is NOT gate evidence", async () => {
    // The load-bearing filter. `test_runs` is dominated by source='local' rows (every
    // agent's own dev runs), and they are stamped with whatever sha the SHARED TREE sat
    // at — so a peer testing while the gate judges commit X writes local rows stamped X
    // that were never the gate's evidence. Without this predicate the "ledger" for a
    // candidate is mostly peers' local runs, and verifyGateVerdict's DISJOINT branch then
    // clears the gate's REAL failing list in favour of them, sending the agent to fix
    // files the gate never named. Measured 2026-08-02 on candidate c3966f7316f9: 3,578 ci
    // rows and 3,938 local rows for the SAME sha — so this is the majority case, not an
    // edge case. Assert the generated SQL carries it; a canned-row mock cannot catch a
    // dropped WHERE clause.
    let capturedSql = '';
    await ledgerFilesForCandidate('deadbee1234', {
      sql: (async (strings: TemplateStringsArray) => {
        capturedSql = strings.join('');
        return [];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(capturedSql).toContain("source = 'ci'");
  });
});

describe('EI-17603 — verifyGateVerdict: distrust the gate\'s own record when the ledger contradicts it', () => {
  const redWithFiles = (tests: string[], observedCandidate: string | null = 'deadbee1234') =>
    snap({ gate: { consecutiveReds: 1, failingTests: tests, observedCandidate } as Partial<GitPipelineSnapshot['gate']> });

  it('no observedCandidate ⇒ no query, no-op (cannot attribute the verdict to a commit)', async () => {
    let queried = 0;
    const res = await verifyGateVerdict(redWithFiles(['lib/a.test.ts'], null), {
      sql: (async () => {
        queried++;
        return [];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(queried).toBe(0);
    expect(res.snap.gate.failingTests).toEqual(['lib/a.test.ts']);
  });

  it('nothing file-shaped named (only package/step sentinels) ⇒ no query, no-op', async () => {
    let queried = 0;
    const res = await verifyGateVerdict(redWithFiles(['@papercusp/operator-vite']), {
      sql: (async () => {
        queried++;
        return [];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(queried).toBe(0);
  });

  it('a STALE verdict is out of scope — skipped even with an observedCandidate present', async () => {
    let queried = 0;
    const s = redWithFiles(['lib/a.test.ts']);
    s.gate.verdictStale = true;
    const res = await verifyGateVerdict(s, {
      sql: (async () => {
        queried++;
        return [];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(queried).toBe(0);
  });

  it('an INCONCLUSIVE abort is out of scope — historical failingTests never trigger ledger reconciliation', async () => {
    let queried = 0;
    const s = redWithFiles(['lib/old-red.test.ts']);
    s.gate.inconclusive = {
      status: 'infra-inconclusive',
      candidate: 'candidate123456',
      detail: 'the runner cache disappeared during the suite',
      observedAtMs: Date.now(),
    };
    const res = await verifyGateVerdict(s, {
      sql: (async () => {
        queried++;
        return [{ file_path: 'lib/actually-red.test.ts' }];
      }) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(res.ledgerFiles).toEqual([]);
    expect(queried).toBe(0);
    expect(res.snap).toBe(s);
  });

  it('unverifiable (no ledger rows for this commit) ⇒ leaves the gate\'s record untouched', async () => {
    const res = await verifyGateVerdict(redWithFiles(['lib/a.test.ts']), {
      sql: (async () => []) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(res.snap.gate.failingTests).toEqual(['lib/a.test.ts']);
  });

  it('fully confirmed (every named file is in the ledger, nothing missing) ⇒ leaves the gate\'s record untouched', async () => {
    const res = await verifyGateVerdict(redWithFiles(['lib/a.test.ts', 'lib/b.test.ts']), {
      sql: (async () => [{ file_path: 'lib/a.test.ts' }, { file_path: 'lib/b.test.ts' }]) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(false);
    expect(res.snap.gate.failingTests).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
  });

  it('WI-6529 — PARTIAL overlap (a real bug, live 2026-07-27): drops the unconfirmed (false-positive) file, keeps the confirmed one', async () => {
    // The exact shape any-overlap-confirms-all used to miss: 'lib/a.test.ts' has since gone
    // green (not in the ledger for this commit) but rode along because 'lib/b.test.ts' — a
    // genuine red — made the OLD coarse check call the whole list "confirmed".
    const res = await verifyGateVerdict(redWithFiles(['lib/a.test.ts', 'lib/b.test.ts']), {
      sql: (async () => [{ file_path: 'lib/b.test.ts' }]) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(true);
    expect(res.snap.gate.failingTests).toEqual(['lib/b.test.ts']);
    expect(res.snap.gate.failingTests).not.toContain('lib/a.test.ts');
  });

  it('WI-6529 — an entirely missing failing workspace (a real bug, live 2026-07-27): adds the ledger file the checkpoint never named', async () => {
    // The checkpoint named only its (real) operator-core failure; the ledger shows a SECOND,
    // genuinely-red file in a different workspace that the checkpoint's own record omitted.
    const res = await verifyGateVerdict(redWithFiles(['lib/dbos/orchestrator-runner-scope.test.ts']), {
      sql: (async () => [
        { file_path: 'lib/dbos/orchestrator-runner-scope.test.ts' },
        { file_path: 'app/_lints/css-tokens.test.ts' },
      ]) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(true);
    expect(res.snap.gate.failingTests).toEqual(
      ['app/_lints/css-tokens.test.ts', 'lib/dbos/orchestrator-runner-scope.test.ts'].sort(),
    );
  });

  it('DISJOINT (the live-observed bug): reconciles failingTests to the ledger\'s real files (keeping step sentinels), WITHOUT mutating the input snapshot', async () => {
    const input = redWithFiles(['@papercusp/operator-vite', 'lib/a.test.ts', 'lib/b.test.ts']);
    const res = await verifyGateVerdict(input, {
      sql: (async () => [{ file_path: 'lib/totally-different.test.ts' }]) as unknown as WhyChainDeps['sql'],
    });
    expect(res.disjoint).toBe(true);
    expect(res.ledgerFiles).toEqual(['lib/totally-different.test.ts']);
    // The (never ledger-checked) step sentinel rides back through untouched; the two wrong file
    // names are replaced by the ledger's real one.
    expect(res.snap.gate.failingTests).toEqual(['@papercusp/operator-vite', 'lib/totally-different.test.ts']);
    // The input object itself must be untouched (pure function — no shared-reference surprises).
    expect(input.gate.failingTests).toEqual(['@papercusp/operator-vite', 'lib/a.test.ts', 'lib/b.test.ts']);
  });
});

describe('WI-6529 — reconcileFailingFiles: per-file reconciliation (not any-overlap)', () => {
  it('empty ledger ⇒ unverifiable, returns the input unchanged', () => {
    expect(reconcileFailingFiles(['lib/a.test.ts'], [])).toEqual({ files: ['lib/a.test.ts'], corrected: false });
  });

  it('every named file confirmed, nothing missing ⇒ unchanged', () => {
    expect(reconcileFailingFiles(['lib/a.test.ts'], ['lib/a.test.ts'])).toEqual({
      files: ['lib/a.test.ts'],
      corrected: false,
    });
  });

  it('drops a named file the ledger does not confirm (false positive)', () => {
    expect(reconcileFailingFiles(['lib/a.test.ts', 'lib/b.test.ts'], ['lib/b.test.ts'])).toEqual({
      files: ['lib/b.test.ts'],
      corrected: true,
    });
  });

  it('adds a ledger file the checkpoint never named (false negative)', () => {
    expect(reconcileFailingFiles(['lib/a.test.ts'], ['lib/a.test.ts', 'lib/c.test.ts'])).toEqual({
      files: ['lib/a.test.ts', 'lib/c.test.ts'],
      corrected: true,
    });
  });

  it('corrects BOTH directions at once — the exact WI-6529 shape', () => {
    // named: one false positive (a.test.ts) + one real confirmed (b.test.ts).
    // ledger: the confirmed one + one the checkpoint never named at all (c.test.ts).
    expect(reconcileFailingFiles(['lib/a.test.ts', 'lib/b.test.ts'], ['lib/b.test.ts', 'lib/c.test.ts'])).toEqual({
      files: ['lib/b.test.ts', 'lib/c.test.ts'],
      corrected: true,
    });
  });

  it('fully disjoint ⇒ replaced entirely by the ledger files', () => {
    expect(reconcileFailingFiles(['lib/a.test.ts'], ['lib/totally-different.test.ts'])).toEqual({
      files: ['lib/totally-different.test.ts'],
      corrected: true,
    });
  });
});

describe('EI-17603 — computePipelineHealth end-to-end: the gate\'s own list gets overridden when the ledger disagrees', () => {
  it('replaces the checkpoint\'s wrong failingTests with the ledger\'s real ones for that commit, and flags the disjoint verdict', async () => {
    const s = withRoutines(
      snap({
        gate: {
          consecutiveReds: 1,
          failingTests: ['@papercusp/operator-core', '@papercusp/operator-vite', 'lib/passes-standalone.test.ts'],
          observedCandidate: 'deadbee1234',
        } as Partial<GitPipelineSnapshot['gate']>,
      }),
    );
    const res = await computePipelineHealth(
      deps({
        snap: s,
        sql: (async () => [{ file_path: 'lib/actually-broken.test.ts' }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateVerdictDisjointFromLedger).toBe(true);
    expect(res.recentFailingFiles).toEqual(['lib/actually-broken.test.ts']);
    expect(res.recentFailingFiles).not.toContain('lib/passes-standalone.test.ts');
    expect(res.gate.reason).toContain('lib/actually-broken.test.ts');
    expect(res.gate.reason).toContain('CONTRADICTED');
  });

  it('a CONFIRMED red still names the checkpoint\'s own files and never flags disjoint (no regression)', async () => {
    const s = withRoutines(
      snap({
        gate: {
          consecutiveReds: 1,
          failingTests: ['lib/really-broken.test.ts'],
          observedCandidate: 'deadbee1234',
        } as Partial<GitPipelineSnapshot['gate']>,
      }),
    );
    let queried = 0;
    const res = await computePipelineHealth(
      deps({
        snap: s,
        sql: (async () => {
          queried++;
          return [{ file_path: 'lib/really-broken.test.ts' }];
        }) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateVerdictDisjointFromLedger).toBeUndefined();
    expect(res.recentFailingFiles).toEqual(['lib/really-broken.test.ts']);
    expect(queried).toBe(1); // the one candidate-scoped verification query — no second (broad) scan
    expect(res.gate.reason).not.toContain('CONTRADICTED');
  });
});

describe('EI-17603 — computeWhyChain end-to-end: same correction reaches dev:why', () => {
  it('uses the ledger-derived files (not the checkpoint\'s disjoint list) in both the stage reason and recentFailingFiles', async () => {
    const s = snap({
      gate: {
        consecutiveReds: 1,
        failingTests: ['@papercusp/operator-vite', 'lib/passes-standalone.test.ts'],
        observedCandidate: 'deadbee1234',
      } as Partial<GitPipelineSnapshot['gate']>,
    });
    const res = await computeWhyChain(
      deps({
        snap: s,
        sql: (async () => [{ file_path: 'lib/actually-broken.test.ts' }]) as unknown as WhyChainDeps['sql'],
      }),
    );
    expect(res.gateVerdictDisjointFromLedger).toBe(true);
    expect(res.recentFailingFiles).toEqual(['lib/actually-broken.test.ts']);
    expect(res.stages[0].reason).toContain('lib/actually-broken.test.ts');
    expect(res.stages[0].reason).not.toContain('passes-standalone');
  });
});
