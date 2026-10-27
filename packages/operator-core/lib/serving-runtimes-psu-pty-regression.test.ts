/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-006 — the regression this plan exists for.
 *
 * 2026-09-23: psu-pty-turn-boundary-generalization's ingest fix had been running in bg-host
 * (canonical tree, restarted 23:58Z) for an hour, while `dev:pipeline_position` on
 * `psu-pty-host-events-ingest.ts` answered `deployed:false, blockedOn:gate` and led its
 * summary with "WAITING AT GATE". The implementer and the independent grader both waited
 * on main for code no deploy would ever carry.
 *
 * This drives the FULL resolver with that exact state: bg-host's build contains the
 * ingest blob, :3070's does not.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyRuntimeOwners,
  gitPipelinePosition,
  type GitRunner,
} from './git-pipeline-position';
import type { DevDeployState } from './dev-deploy-state';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import type { RuntimeVintageRow } from './runtime-vintage';
import { projectCheckpointQualificationState } from './release/checkpoint-qualification-transaction';

vi.mock('./agent-tools/dev/systemd-service-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-tools/dev/systemd-service-probe')>();
  return {
    ...actual,
    probeServiceStart: async () => ({ ok: true, mainPid: 4242, secondsSinceStart: 60, activeState: 'active' }),
  };
});

const INGEST = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';
const PTY_HOST = 'apps/operator/scripts/psu-pty-host.mjs';
const BG_BUILD = '9536482f31'.padEnd(40, '1');
const RELEASE_BUILD = 'be8396c6dd'.padEnd(40, '2');
const FIXED_BLOB = 'f'.repeat(40);
const OLD_BLOB = '0'.repeat(40);

const deploy = (): DevDeployState =>
  ({
    integrationRoot: '/repo',
    deployed: { sha: RELEASE_BUILD } as DevDeployState['deployed'],
    deployedAtMs: Date.now() - 60 * 60_000,
  }) as DevDeployState;

const snap = (): GitPipelineSnapshot =>
  ({
    gate: {
      stalled: false,
      consecutiveReds: 1,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      verdictStale: false,
      verdictObservedAtMs: null,
      verdictStaleReason: null,
      verdictStaleReasonCode: null,
      candidateAgeMs: null,
      commitsBehindTip: null,
      observedCandidate: null,
      inconclusive: null,
      qualification: projectCheckpointQualificationState(null, 0),
    },
    gitSync: { lastStatus: 'synced' },
    deploy: {
      integrationRoot: '/repo',
      greenPin: { sha: RELEASE_BUILD, shortSha: 'be8396c6dd', committedAtMs: 1000, subject: 'green' },
      deployed: { sha: RELEASE_BUILD },
      greenPinAtStagingHead: false,
      deployedBehindGreenPin: 0,
    },
  }) as unknown as GitPipelineSnapshot;

/** HEAD carries the fix; bg-host's boot HEAD carries it; the :3070 release build does not. */
const git =
  (path: string): GitRunner =>
  async (_repo, args) => {
    if (args[0] === 'config') return null;
    if (args[0] === 'status') return '';
    if (args[0] === 'log' && args.includes('--pretty=%H')) return 'c0ffee1234'.padEnd(40, '3');
    if (args[0] === 'log' && args.includes('--pretty=%s')) return 'psu-pty ingest fix';
    if (args[0] === 'rev-list') return '0';
    if (args[0] === 'merge-base') return args[1];
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2]?.endsWith('^{commit}')) {
      return args[2].replace('^{commit}', '').padEnd(40, '0').slice(0, 40);
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === `${BG_BUILD}:${path}`) return FIXED_BLOB;
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === `HEAD:${path}`) return FIXED_BLOB;
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === `${RELEASE_BUILD}:${path}`) return OLD_BLOB;
    if (args[0] === 'hash-object') return FIXED_BLOB;
    return null;
  };

const vintageRows: RuntimeVintageRow[] = [
  {
    workspaceId: 'ws',
    unit: 'hono-host:3271',
    host: 'box',
    treeSha: BG_BUILD,
    buildTime: null,
    bundleVersion: '0.0.0',
    pid: 5151,
    extra: {},
    reportedAt: new Date().toISOString(),
  },
];

describe('psu-pty regression: bg-host runs the fix, :3070 does not ⇒ not blocked on main', () => {
  it('both psu-pty paths classify to runtimes the release pipeline does NOT carry', () => {
    expect(classifyRuntimeOwners(INGEST)?.map((r) => [r.host, r.releasePipelineApplies])).toEqual([['bg-host', false]]);
    expect(classifyRuntimeOwners(PTY_HOST)?.map((r) => [r.host, r.releasePipelineApplies])).toEqual([
      ['psu-pty-host', false],
    ]);
  });

  it('the ingest path leads with LIVE NOW on bg-host, never a gate wait, and :3070 still reads false', async () => {
    const startedAtMs = Date.now() - 30 * 60_000;
    const res = await gitPipelinePosition(
      { path: INGEST },
      {
        git: git(INGEST),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
        // bg-host's MainPID is a wrapper; its reporter is a child in the same cgroup.
        probeUnitStart: async (unit) => ({ pid: unit.includes('bg-host') ? 5000 : 6000, startedAtMs }),
        loadRuntimeVintage: async () => vintageRows,
        localRuntimeHost: 'box',
        readCgroup: async (pid) => (pid === 5151 ? '0::/user.slice/papercusp-bg-host.service' : null),
        // bg-host bundles the canonical tree, so only the sha baked into the bundle it
        // serves on :3271 can prove containment (EI-26048015059197913): a runtime-vintage
        // boot sha describes the tree at boot, not the bytes the loaded bundle carries.
        probeHealthSha: async (port) => (port === 3070 ? RELEASE_BUILD : port === 3271 ? BG_BUILD : null),
        probeHealthBundle: async (port) => (port === 3271 ? { stale: false, servingBuiltAtMs: null } : null),
        fileMtimeMs: async () => startedAtMs - 60_000,
      },
    );
    const bg = res.servingRuntimes.find((r) => r.runtime === 'bg-host');
    expect(bg).toMatchObject({ role: 'owner', buildSha: BG_BUILD, containsChange: true, buildShaSource: 'health' });
    const release = res.servingRuntimes.find((r) => r.runtime === 'release-operator');
    // Measured at :3070's OWN health sha — independent of the git-ancestry `positions.deployed`
    // flag (which this fake git happens to report as reached; the runtime row must not copy it).
    expect(release).toMatchObject({ role: 'shared', containsChange: false, buildShaSource: 'health' });
    expect(res.summary).toMatch(/^LIVE NOW on bg-host build 9536482f31/);
    expect(res.summary).toMatch(/does NOT wait on main/);
    expect(res.summary).not.toMatch(/WAITING AT GATE/);
  });

  it('the pty host path answers per psu session', async () => {
    const res = await gitPipelinePosition(
      { path: PTY_HOST },
      {
        git: git(PTY_HOST),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
        probeUnitStart: async () => ({ pid: 1, startedAtMs: Date.now() - 1_000 }),
        loadRuntimeVintage: async () => [],
        fileMtimeMs: async () => 5_000,
        listPtyHostInstances: async () => [
          { pid: 11, startedAtMs: 4_000 },
          { pid: 12, startedAtMs: 6_000 },
        ],
      },
    );
    expect(res.servingRuntimes).toEqual([
      expect.objectContaining({ runtime: 'psu-pty-host', containsChange: true, instances: { total: 2, current: 1 } }),
    ]);
    expect(res.summary).toMatch(/^LIVE NOW on psu-pty-host 1\/2 sessions/);
  });
});
