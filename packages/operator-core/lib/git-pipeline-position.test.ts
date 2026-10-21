import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { frozenRepairLatency } from './release/frozen-candidate-repair-queue';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GATE_ABORT_DETAIL_LIVENESS_MARKER } from './release/gate-abort-status';

/**
 * P-003: `gitPipelinePosition`'s serving probe really shells out to
 * systemctl+ps by default (D-001 — a null-by-default dep would be shipping the
 * feature dark). That makes every call site in this file machine-dependent:
 * un-mocked, these unit tests read THIS box's live papercup-dev-api uptime and
 * would answer differently on CI, or on a host where the unit does not exist.
 * Pin it to a deterministic process: started 60s ago, which every fixture below
 * treats as "after the code landed" unless it deliberately says otherwise.
 */
vi.mock('./agent-tools/dev/systemd-service-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-tools/dev/systemd-service-probe')>();
  return {
    ...actual,
    probeServiceStart: vi.fn(async () => ({ ok: true, mainPid: 4242, secondsSinceStart: 60, activeState: 'active' })),
  };
});
import { probeServiceStart } from './agent-tools/dev/systemd-service-probe';
import {
  gitPipelinePosition,
  withGitReadBudget,
  assessPipelinePosition,
  assessGateVerdict,
  assessGateCandidate,
  assessDeployedSha,
  assessMainBehindStaging,
  summarizePosition,
  classifyRuntimeOwner,
  classifyRuntimeOwners,
  computeStages,
  evaluateServing,
  evaluateRuntimeGenerations,
  attachRuntimeLoadedIdentities,
  runtimeGenerationDivergenceNote,
  evaluateChangeInCandidate,
  evaluateReleaseContentDrift,
  evaluateAcceptedSourceContainment,
  evaluateSweepExposure,
  gitSyncDeferralFor,
  turnHoldFor,
  parsePorcelainPaths,
  deriveBlocker,
  staleVerdictSafeLever,
  frozenRepairQueueSafeLever,
  safeGateLever,
  mainBufferIsStale,
  mainBufferStallReason,
  mapCheckpointRunInFlight,
  markerNetChange,
  reconcileGateCandidates,
  frozenQueueCandidate,
  isAuthoritativeJudgingShaSource,
  AUTHORITATIVE_JUDGING_SHA_SOURCES,
  gateCandidateProgress,
  resolveEditTreeRoot,
  MAIN_BUFFER_STALL_MS,
  type GateProgressReading,
  type GitRunner,
  type PipelinePosition,
  type RuntimeGeneration,
  type ChangeInCandidate,
  type ServingTruth,
  type StageName,
  type StageState,
  type SweepExposure,
} from './git-pipeline-position';
import type { GateCandidateFailures, GateCandidateFailingFile } from './gate-candidate-failures';
import { unmeasuredNonTestLegs } from './gate-candidate-failures';
import type { MarkerContainment } from './candidate-contains';
import type { DevDeployState } from './dev-deploy-state';
import type { DeployInFlight } from './release-deploy-launch';
import type { GitPipelineSnapshot } from './git-pipeline-stats';
import type { RuntimeVintageRow } from './runtime-vintage';
import { projectCheckpointQualificationState } from './release/checkpoint-qualification-transaction';
import { unownedCell } from './coord/gate-ownership';
import { certifyCheckpointProgress, DEFAULT_STALL_THRESHOLD_MS } from './release-trace-progress';
import { createFrozenCandidateRepairQueue, diagnoseFrozenCandidateRepairQueue, type RepairSignatureEntry } from './release/frozen-candidate-repair-queue';

/** A git-sync leg-state with nothing wrong with it — the baseline for fixtures. */
const HEALTHY_GIT_SYNC = {
  status: 'synced',
  lastSyncedAtMs: Date.now(),
  syncAgeMs: 0,
  consecutiveErrorTicks: 0,
  skippedPaths: [],
  pushedRepos: ['papercusp'],
  mergedRepos: [],
  conflicts: [],
  errors: [],
  // EI-18812945811758018: the baseline is a member that DOES push, so the existing
  // push-leg assertions keep their original meaning.
  pushMode: 'push',
};

/** P-003: a serving process that started AFTER the code it runs — i.e. actually live. */
const HEALTHY_SERVING: ServingTruth = {
  host: 'operator-release',
  unit: 'papercup-dev-api.service',
  pid: 4242,
  startedAtMs: 2_000,
  codeAsOfMs: 1_000,
  codeAsOfSource: 'deploy',
  startedSinceCodeChange: true,
  behindMin: null,
  // This fixture's verdict comes from its two timestamps above, so `start-time`
  // is what actually produced it (WI-2141731).
  evidence: 'start-time',
  reportedSha: null,
  restartLever: 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute',
  restartSupersededBy: null,
  unknownReason: null,
};

/**
 * P-004: the "nothing to report" containment verdict. Every fixture below defaults to
 * it so no existing case accidentally depends on gate-candidate containment — a case
 * that means to exercise it says so explicitly.
 */
const NO_CANDIDATE: ChangeInCandidate = {
  judgingSha: null,
  judgingContainsPath: null,
  nextCandidateSha: null,
  nextContainsPath: null,
  submodule: null,
  missingReason: null,
  // EI-18797292094433710: no caller-supplied marker, so there is nothing to be
  // contained — null is "not measured", distinct from a measured absence.
  markerJudging: null,
  markerNext: null,
  detail: null,
};

/** P-006: a clean tree — nothing for the next git-sync tick to sweep. */
const NO_SWEEP: SweepExposure = {
  exposed: false,
  dirtyPathCount: null,
  dirtyPathSample: [],
  nextSweepInMs: null,
  detail: null,
};

/** No logical qualification attempt exists in these otherwise fully measured fixtures. */
const NO_QUALIFICATION = projectCheckpointQualificationState(null, 0);

// EI-24049239243821100: the resolver's default edit-tree resolution reads
// PAPERCUSP_CANONICAL_TREE. Every fixture here models ONE repo at `/repo`, so a shell
// that exports that variable must not silently redirect them to a real checkout.
beforeEach(() => {
  vi.stubEnv('PAPERCUSP_CANONICAL_TREE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A `merge-base` answer that is no fixture's target sha — "not contained". */
const NOT_AN_ANCESTOR = '0'.repeat(40);

/** A fake `git` runner keyed by arg shape + a per-ref containment map. */
function fakeGit(opts: {
  submodules?: string[];
  dirty?: boolean;
  /** P-006: raw porcelain for the TREE-WIDE status (the sweep's blast radius). */
  dirtyTree?: string;
  /** Constrain dirty status to one repo for nested-submodule regressions. */
  dirtyRepo?: string;
  pathCommit?: string | null;
  subject?: string;
  /** ref → set of shas that ref's history contains (ancestor-or-equal). */
  contains?: Record<string, string[]>;
  /** EI-18694888339365359 / WI-38372: the AUTHORITATIVE remote tips returned by
   *  `git ls-remote`, deliberately independent of `contains` so tests can model
   *  stale local origin/* refs disagreeing with the true remote history. */
  remoteStagingTip?: string;
  remoteMainTip?: string;
  /**
   * D-038 axis 2: refs whose `rev-list --count` FAILS (GitRunner yields null).
   * Deliberately distinct from `contains` merely omitting the ref — that is an
   * honest "not contained", this is "could not measure". Conflating the two is
   * exactly the defect `positionsUnknown` exists to surface.
   */
  failRefs?: string[];
  /**
   * EI-18715870370005934: models the SUBMODULE BOUNDARY faithfully — the
   * superproject stores a gitlink (mode 160000), never submodule file content.
   * So inside the submodule repo a superproject sha does NOT resolve (rev-parse
   * fails) and `git show <superSha>:<submodulePath>` yields nothing, while
   * `git ls-tree <superSha> <submodulePath>` in the ROOT reports the pin.
   */
  submodulePin?: { superSha: string; pinnedSha: string; path: string };
  /** The nested commit pinned by the superproject's origin/staging candidate. */
  submoduleStagingPin?: { pinnedSha: string; path: string };
  /** Make the origin/staging gitlink read fail, rather than measure an absent one. */
  failSubmoduleStagingPin?: boolean;
  /**
   * WI-6646: ref → the newest commit touching the path that REF ALREADY CONTAINS,
   * which is a different question from `pathCommit` (the newest touching it ANYWHERE).
   * `''` models the measured absence (the ref has no commit for this path at all);
   * omitting the ref entirely models a FAILED read, which must never read as absence.
   */
  newestInRef?: Record<string, string>;
  /**
   * WI-6646: ref → that ref's version of the file, which is what a `marker` is counted
   * in. Supplying a ref here also makes it resolvable (`rev-parse`) and listable
   * (`ls-tree`), i.e. it models a ref whose blob can genuinely be read.
   */
  blobAtRef?: Record<string, string>;
  /**
   * EI-21285379200225840: refs whose trees resolve but do not contain the path.
   * This is distinct from an omitted ref, which models a failed `ls-tree` read.
   */
  absentRefs?: string[];
  /**
   * EI-19325915429897280: `pathCommit`'s PARENT (`${pathCommit}~1`) — the file's
   * content immediately BEFORE the change under discussion, which is the marker
   * baseline `markerBaseline`/`markerBaselineCount` are computed from. Supplying
   * it makes `${pathCommit}~1` resolve (`rev-parse`), list (`ls-tree`), and read
   * (`show`) — modeling a baseline that CAN be measured. Omitting it (the
   * default) models a baseline commit that does not resolve: `rev-parse` on
   * `${pathCommit}~1` fails `SHA_RE` (the literal string contains `~`), exactly
   * like a genuinely-unresolvable parent, so `markerBaselineCount` stays null.
   */
  parentBlobAtTarget?: string;
  /** Marker-baseline blobs keyed by an arbitrary commit-parent ref (for example
   * `${newestInRef['origin/main']}~1`). This models the candidate's own parent
   * when a later same-path commit has moved `pathCommit` forward. */
  parentBlobs?: Record<string, string>;
}): GitRunner {
  const root = '/repo';
  // EI-19325915429897280: the literal revision string `markerAtCommit` is called
  // with for the marker baseline — real git accepts `<sha>~1` directly, so the
  // fake never needs a separate resolved identity; it only needs the THREE
  // commands markerAtCommit issues to agree on this one string.
  const targetParent = opts.pathCommit ? `${opts.pathCommit}~1` : null;
  return async (_repo, args) => {
    if (args[0] === 'config' && args.includes('.gitmodules')) {
      const subs = opts.submodules ?? [];
      return subs.length ? subs.map((p, i) => `submodule.s${i}.path ${p}`).join('\n') : null;
    }
    // P-006: the path-filtered status (`status --porcelain -- <path>`) and the
    // TREE-WIDE one are different questions — the second is the sweep's blast radius.
    // A fixture that answers both with the same string cannot exercise the multi-file
    // case at all, which is the only case P-006 exists for.
    if (args[0] === 'status') {
      if (!opts.dirty) return '';
      if (opts.dirtyRepo && _repo !== opts.dirtyRepo) return '';
      return args.includes('--') ? 'M somefile' : (opts.dirtyTree ?? 'M somefile');
    }
    // The gitlink read that IS the ground truth across the boundary.
    if (args[0] === 'ls-tree') {
      const pin = opts.submodulePin;
      if (pin && _repo === root && args[1] === pin.superSha && args[2] === pin.path) {
        return `160000 commit ${pin.pinnedSha}\t${pin.path}`;
      }
      const stagingPin = opts.submoduleStagingPin;
      if (args[1] === 'origin/staging' && stagingPin && _repo === root && args[2] === stagingPin.path) {
        return `160000 commit ${stagingPin.pinnedSha}\t${stagingPin.path}`;
      }
      if (args[1] === 'origin/staging' && opts.failSubmoduleStagingPin) return null;
      if (args[1] === 'origin/staging' && _repo === root) return '';
      if (opts.absentRefs?.includes(args[1])) return '';
      // WI-6646: a ref with a known blob genuinely HAS the path.
      if (opts.blobAtRef && args[1] in opts.blobAtRef) return `100644 blob deadbeef\t${args[3]}`;
      // EI-19325915429897280: the marker-baseline commit HAS the path too, when
      // the fixture supplies its content.
      if (opts.parentBlobAtTarget !== undefined && targetParent && args[1] === targetParent) {
        return `100644 blob deadbeef\t${args[3]}`;
      }
      if (opts.parentBlobs && args[1] in opts.parentBlobs) return `100644 blob deadbeef\t${args[3]}`;
      return null;
    }
    // The naive cross-boundary content probe: empty, because the superproject
    // commit holds a gitlink, not the file. `realGit` turns git's non-zero exit
    // into null, so null is the faithful stand-in for "grep -c => 0".
    if (args[0] === 'show') {
      // WI-6646: `show <ref>:<path>` for a ref whose blob the fixture defines.
      const ref = args[1]?.split(':')[0];
      if (opts.blobAtRef && ref !== undefined && ref in opts.blobAtRef) return opts.blobAtRef[ref];
      // EI-19325915429897280: `show <pathCommit>~1:<path>` for the marker baseline.
      if (opts.parentBlobAtTarget !== undefined && ref === targetParent) return opts.parentBlobAtTarget;
      if (opts.parentBlobs && ref !== undefined && ref in opts.parentBlobs) return opts.parentBlobs[ref];
      return null;
    }
    if (args[0] === 'rev-parse') {
      const want = args[args.length - 1].replace('^{commit}', '');
      // A SUPERPROJECT sha does not exist in the submodule's object store.
      if (opts.submodulePin && _repo !== root && want === opts.submodulePin.superSha) return null;
      // WI-6646: a symbolic ref must resolve to something SHA-SHAPED or markerAtCommit
      // correctly refuses it as unresolvable — the fixture would otherwise test the
      // resolver-failed path while claiming to test marker containment.
      if (opts.blobAtRef && want in opts.blobAtRef) return 'a'.repeat(40);
      if (opts.absentRefs?.includes(want)) return 'b'.repeat(40);
      // EI-19325915429897280: the marker-baseline commit (`${pathCommit}~1`) resolves
      // to something sha-shaped ONLY when the fixture supplies its content — an
      // omitted `parentBlobAtTarget` falls through to `return want`, and `want` here
      // contains a literal `~`, which SHA_RE rejects, faithfully modeling a baseline
      // that could not be measured.
      if (opts.parentBlobAtTarget !== undefined && targetParent && want === targetParent) return 'c'.repeat(40);
      if (opts.parentBlobs && want in opts.parentBlobs) return 'd'.repeat(40);
      return want;
    }
    // WI-6646: the REF-SCOPED variant (`log -1 --pretty=%H <ref> -- <path>`) asks a
    // different question from the bare one below and must not share its answer —
    // conflating them is what made the newer-commit case untestable.
    if (args[0] === 'log' && args.includes('--pretty=%H') && args[3] !== '--') {
      const ref = args[3];
      if (!opts.newestInRef || !(ref in opts.newestInRef)) return null; // read FAILED
      return opts.newestInRef[ref];
    }
    if (args[0] === 'log' && args.includes('--pretty=%H')) return opts.pathCommit ?? null;
    if (args[0] === 'log' && args.includes('--pretty=%s')) return opts.subject ?? 'subj';
    // Containment is `merge-base <sha> <ref>` (git-ref-contains.ts): it prints `sha`
    // itself exactly when `ref` contains it.
    if (args[0] === 'merge-base' && args.length === 3) {
      const [, sha, ref] = args;
      if (opts.failRefs?.includes(ref)) return null; // the READ failed — not "not contained"
      if (ref === sha) return sha;
      const set = new Set(opts.contains?.[ref] ?? []);
      return set.has(sha) ? sha : NOT_AN_ANCESTOR;
    }
    if (args[0] === 'rev-list' && args[1] === '--count') {
      const [ref, sha] = args[2].split('..');
      if (opts.failRefs?.includes(ref)) return null; // the READ failed — not "not contained"
      if (ref === sha) return '0';
      const set = new Set(opts.contains?.[ref] ?? []);
      return set.has(sha) ? '0' : '3';
    }
    if (args[0] === 'ls-remote' && args[1] === 'origin') {
      const tip =
        args[2] === 'refs/heads/staging'
          ? opts.remoteStagingTip
          : args[2] === 'refs/heads/main'
            ? opts.remoteMainTip
            : undefined;
      return tip ? `${tip}\t${args[2]}` : null;
    }
    return null;
  };
}

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    deployed: { sha: 'deployedsha0' } as DevDeployState['deployed'],
    // P-003: the deploy landed an hour ago, while the mocked serving process
    // started 60s ago — so the default fixture is a process that HAS loaded the
    // deployed code. A case that wants the stale reading overrides this.
    deployedAtMs: Date.now() - 60 * 60_000,
    ...over,
  }) as DevDeployState;

/** Default snapshot-level deploy state (distinct from the `deploy()` fixture above,
 *  which is the `loadDeploy` dep — this is `GitPipelineSnapshot.deploy`, the source
 *  for verdictProvenance's ready/greenPinAtStagingHead/deployedBehindGreenPin). */
const snapDeploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    greenPin: {
      sha: 'readysha0',
      shortSha: 'readysha',
      committedAtMs: 1000,
      subject: 'ready',
    } as DevDeployState['greenPin'],
    deployed: { sha: 'deployedsha0' } as DevDeployState['deployed'],
    greenPinAtStagingHead: true,
    deployedBehindGreenPin: 0,
    ...over,
  }) as DevDeployState;

const snap = (
  gate: Partial<GitPipelineSnapshot['gate']> = {},
  lastStatus = 'synced',
  deployOver: Partial<DevDeployState> = {},
): GitPipelineSnapshot =>
  ({
    gate: {
      stalled: false,
      consecutiveReds: 0,
      lastGreenAtMs: 1,
      fireStale: false,
      fireStaleReason: null,
      // EI-19325520469216548: defaults for the fields git-pipeline-stats projects from
      // evaluateGateVerdictFreshness — a healthy/unmeasured-by-default fixture so existing
      // cases that don't care about staleness don't have to spell these out.
      verdictStale: false,
      verdictObservedAtMs: null,
      verdictStaleReason: null,
      verdictStaleReasonCode: null,
      candidateAgeMs: null,
      commitsBehindTip: null,
      observedCandidate: null,
      // EI-19405864032365760 made this REQUIRED on PipelinePosition.gate. `null` is the
      // semantically correct default rather than a compiler-silencer: these fixtures describe a
      // gate that RENDERED a verdict, which is exactly the case where no abort is recorded.
      inconclusive: null,
      qualification: NO_QUALIFICATION,
      ...gate,
    },
    gitSync: { lastStatus },
    deploy: snapDeploy(deployOver),
  }) as GitPipelineSnapshot;

/**
 * Supply the evidence that makes a candidate authoritative at the full pipeline entry point.
 * `resolveGateCandidates` alone is only the checkout probe; reconciliation trusts the run's
 * published marker only when the separately mapped checkpoint snapshot says a run is active.
 */
const activeCandidateDeps = (candidate: string) => {
  const observedAtMs = Date.now();
  return {
    loadSnapshot: async () =>
      snap({
        inFlightCandidate: {
          candidate,
          candidateSource: 'pinned',
          base: null,
          selectedAtMs: observedAtMs,
          quietCutApplied: false,
          tipAtSelection: candidate,
          refireDepth: 0,
          pid: 4242,
          observedAtMs,
          verdictWrittenAtMs: null,
        },
      }),
    readCheckpointRunSnapshot: async () => ({
      activeRun: { active: true, candidate, startedAtMs: observedAtMs - 5_000, elapsedSec: 5 },
      computedAtMs: observedAtMs,
    }),
    readCheckpointRunLock: async () => null,
  };
};

describe('accepted-source pipeline containment (WI-10007982)', () => {
  const acceptedBytes = Buffer.from('accepted recovery source\n');
  const expectedSourceSha256 = createHash('sha256').update(acceptedBytes).digest('hex');
  const acceptedBlob = createHash('sha1').update(`blob ${acceptedBytes.length}\0`).update(acceptedBytes).digest('hex');
  const target = 'a'.repeat(40);
  const laterArtifact = 'b'.repeat(40);
  const otherRuntimeBuild = 'c'.repeat(40);
  const sourcePath = 'packages/operator-core/lib/harness/routines/loop-execution-recovery.ts';

  async function readAccepted(options: {
    bytes?: Buffer | null;
    artifactBlob?: string | null;
    runtimeBlob?: string | null;
    moveSource?: boolean;
    moveMtime?: boolean;
    unknownFormat?: boolean;
    startedAtMs?: number;
    path?: string;
  } = {}) {
    const fallback = fakeGit({ pathCommit: target, dirty: true, contains: {
      HEAD: [target], 'origin/staging': [target], 'origin/main': [target], [laterArtifact]: [target],
    } });
    let runtimeProbed = false;
    const git: GitRunner = async (repo, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--show-object-format') return options.unknownFormat ? null : 'sha1';
      if (args[0] === 'rev-parse' && args.at(-1)?.includes(':')) {
        const ref = args.at(-1)!.split(':')[0];
        return ref === laterArtifact
          ? (options.artifactBlob === undefined ? acceptedBlob : options.artifactBlob)
          : (options.runtimeBlob === undefined ? acceptedBlob : options.runtimeBlob);
      }
      // Deliberately different: accepted containment must use the frozen source,
      // never the mutable hash-object answer from a later tree observation.
      if (args[0] === 'hash-object') return 'd'.repeat(40);
      return fallback(repo, args);
    };
    return gitPipelinePosition({ path: options.path ?? sourcePath, expectedSourceSha256 }, {
      git,
      loadDeploy: async () => deploy({ deployed: { sha: laterArtifact } as DevDeployState['deployed'] }),
      loadSnapshot: async () => snap(),
      readGateOwnership: async () => unownedCell('test'),
      readCheckpointRunSnapshot: async () => null,
      readCheckpointRunLock: async () => null,
      resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: target }),
      probeUnitStart: async () => ({ pid: 42, startedAtMs: options.startedAtMs ?? 500 }),
      probeServingHealthSha: async () => laterArtifact,
      probeHealthSha: async (port) => {
        runtimeProbed = true;
        return port === 3070 ? laterArtifact : otherRuntimeBuild;
      },
      probeHealthBundle: async () => null,
      loadRuntimeVintage: async () => [],
      readCgroup: async () => null,
      fileMtimeMs: async () => options.moveMtime && runtimeProbed ? 3000 : 1000,
      listPtyHostInstances: async () => [
        { pid: 101, startedAtMs: 500 },
        { pid: 102, startedAtMs: 900 },
        { pid: 103, startedAtMs: 2000 },
      ],
      readFileBytes: async () => options.moveSource && runtimeProbed
        ? Buffer.from('later unaccepted edit\n')
        : options.bytes === undefined ? acceptedBytes : options.bytes,
    });
  }

  it('binds accepted bytes to a later deployed artifact and differently pinned named runtimes', async () => {
    const result = await readAccepted();
    expect(result.dirtyUncommitted).toBe(true);
    expect(result.targetSha).toBe(target);
    expect(result.deployedSha).toBe(laterArtifact);
    expect(result.acceptedSource).toMatchObject({ expectedSha256: expectedSourceSha256,
      observedSha256: expectedSourceSha256, matches: true, deployedContains: true });
    expect(result.acceptedSource?.runtimeContainment['release-operator']).toBe(true);
    expect(result.acceptedSource?.runtimeContainment['bg-host']).toBe(true);
  });

  it('rejects old deployed bytes even when latest-path ancestry reports deployed=true', async () => {
    const result = await readAccepted({ artifactBlob: 'e'.repeat(40) });
    expect(result.positions.deployed).toBe(true);
    expect(result.acceptedSource?.matches).toBe(true);
    expect(result.acceptedSource?.deployedContains).toBe(false);
    expect(result.acceptedSource?.runtimeContainment['release-operator']).toBe(false);
  });

  it('rejects a changed accepted source even with positive deployed ancestry and runtime probes', async () => {
    const result = await readAccepted({ bytes: Buffer.from('unaccepted replacement\n') });
    expect(result.positions.deployed).toBe(true);
    expect(result.acceptedSource?.matches).toBe(false);
    expect(result.acceptedSource?.deployedContains).toBe(false);
    expect(result.acceptedSource?.runtimeContainment['bg-host']).toBe(false);
  });

  it('retains unreadable source and failed artifact reads as unknown', async () => {
    const missingSource = await readAccepted({ bytes: null });
    expect(missingSource.acceptedSource).toMatchObject({ observedSha256: null, matches: null, deployedContains: null });
    const missingArtifact = await readAccepted({ artifactBlob: null });
    expect(missingArtifact.acceptedSource).toMatchObject({ matches: true, deployedContains: null });
  });

  it('uses an exact bundle-SHA mismatch instead of deployed containment and keeps unreadable identity unknown', async () => {
    const mismatchedBundle = await readAccepted({ runtimeBlob: 'e'.repeat(40) });
    expect(mismatchedBundle.acceptedSource?.deployedContains).toBe(true);
    expect(mismatchedBundle.acceptedSource?.runtimeContainment['bg-host']).toBe(false);
    const unknown = await readAccepted({ runtimeBlob: null });
    expect(unknown.acceptedSource?.runtimeContainment['bg-host']).toBeNull();
    expect(unknown.acceptedSource?.runtimeContainment['staging-operator']).toBeNull();
  });

  it('refuses a source change during the runtime observation', async () => {
    const result = await readAccepted({ moveSource: true });
    expect(result.acceptedSource).toMatchObject({ matches: false, deployedContains: false });
    expect(result.acceptedSource?.runtimeContainment['bg-host']).toBe(false);
  });

  it('does not invent blob containment when the repository object format cannot be read', async () => {
    const result = await readAccepted({ unknownFormat: true });
    expect(result.acceptedSource).toMatchObject({ matches: true, deployedContains: null });
    expect(result.acceptedSource?.runtimeContainment['release-operator']).toBeNull();
  });

  it('invalidates time-based load evidence when source mtime changes during the read', async () => {
    const result = await readAccepted({ moveMtime: true, runtimeBlob: 'e'.repeat(40), startedAtMs: 2000 });
    expect(result.acceptedSource?.matches).toBe(true);
    expect(result.acceptedSource?.deployedContains).toBe(true);
    // The health-reported bundle SHA is independent of path mtime and still
    // proves that this exact accepted source is absent from the loaded build.
    expect(result.servingRuntimes.find((runtime) => runtime.runtime === 'bg-host'))
      .toMatchObject({ containsChange: false, method: 'blob' });
    expect(result.acceptedSource?.runtimeContainment['bg-host']).toBe(false);
    expect(result.servingRuntimes.find((runtime) => runtime.runtime === 'gateway')?.method).toBe('start-after-mtime');
    expect(result.acceptedSource?.runtimeContainment.gateway).toBeNull();
  });

  it('binds actual PTY instance observations without demanding that every old session restart', async () => {
    const result = await readAccepted({ path: 'apps/operator/scripts/psu-pty-host.mjs' });
    expect(result.servingRuntimes.find((runtime) => runtime.runtime === 'psu-pty-host')?.instances)
      .toMatchObject({ total: 3, current: 1 });
    expect(result.acceptedSource?.runtimeContainment['psu-pty-host']).toBe(true);
  });

  it('preserves PTY at-least-one-instance semantics and explicit unknown runtime values', () => {
    const runtimes = [
      { runtime: 'psu-pty-host', containsChange: true, instances: { total: 3, current: 1, stale: 2 } },
      { runtime: 'bg-host', containsChange: null },
    ] as unknown as import('./serving-runtimes').ServingRuntimeEntry[];
    expect(evaluateAcceptedSourceContainment(expectedSourceSha256, acceptedBytes, true, runtimes).runtimeContainment)
      .toEqual({ 'psu-pty-host': true, 'bg-host': null });
  });
});

describe('gitPipelinePosition diagnostic defaults (EI-21306970701615848)', () => {
  it('uses the loaded deployment configuration for release containment refs', async () => {
    const argsSeen: string[][] = [];
    const base = fakeGit({
      pathCommit: 'candidate-sha',
      contains: {
        'HEAD': ['candidate-sha'],
        'origin/workstream': ['candidate-sha'],
        'origin/release-candidate': ['candidate-sha'],
      },
    });
    const git: GitRunner = async (repo, args) => {
      argsSeen.push(args);
      return base(repo, args);
    };

    await gitPipelinePosition(
      { path: 'src/file.ts' },
      {
        git,
        loadDeploy: async () => deploy({ releaseRef: 'release-candidate', integrationBranch: 'workstream' }),
        loadSnapshot: async () => snap(),
      },
    );

    expect(argsSeen).toContainEqual(['merge-base', 'candidate-sha', 'origin/workstream']);
    expect(argsSeen).toContainEqual(['merge-base', 'candidate-sha', 'origin/release-candidate']);
  });

  it('EI-24356772206513832: the default unit probes supply a local exec path', async () => {
    const probe = vi.mocked(probeServiceStart);
    probe.mockClear();
    await gitPipelinePosition(
      { path: 'packages/operator-core/lib/cell-registrations.ts' },
      { git: fakeGit({}), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(probe).toHaveBeenCalled();
    expect(probe.mock.calls.every(([, exec]) => typeof exec === 'function')).toBe(true);
  });

  it('routes only the bounded dev-deploy reader through the sidecar and keeps the pipeline snapshot local', () => {
    const source = readFileSync(new URL('./git-pipeline-position.ts', import.meta.url), 'utf8');

    expect(source).toContain(
      'const loadDeploy = deps.loadDeploy ?? (() => devDeployState({ useSpawnerSidecar: true }));',
    );
    expect(source).toContain(
      'deps.loadSnapshot ?? (() => gitPipelineSnapshot(undefined, { useSpawnerSidecar: false }));',
    );
  });

  it('runs independent hot-path readers concurrently (EI-21544761852770720)', async () => {
    let resolveDeploy!: (value: DevDeployState) => void;
    let resolveSnapshot!: (value: GitPipelineSnapshot) => void;
    let resolveCheckpoint!: (value: null) => void;
    let resolveLock!: (value: null) => void;
    let resolveOwnership!: (value: never) => void;
    const deployPending = new Promise<DevDeployState>((resolve) => (resolveDeploy = resolve));
    const snapshotPending = new Promise<GitPipelineSnapshot>((resolve) => (resolveSnapshot = resolve));
    const checkpointPending = new Promise<null>((resolve) => (resolveCheckpoint = resolve));
    const lockPending = new Promise<null>((resolve) => (resolveLock = resolve));
    const ownershipPending = new Promise<never>((resolve) => (resolveOwnership = resolve));
    const started: string[] = [];

    const pending = gitPipelinePosition(
      {},
      {
        git: fakeGit({}),
        loadDeploy: () => {
          started.push('deploy');
          return deployPending;
        },
        loadSnapshot: () => {
          started.push('snapshot');
          return snapshotPending;
        },
        readCheckpointRunSnapshot: () => {
          started.push('checkpoint');
          return checkpointPending;
        },
        readCheckpointRunLock: () => {
          started.push('lock');
          return lockPending;
        },
        readGateOwnership: () => {
          started.push('ownership');
          return ownershipPending;
        },
      },
    );

    await Promise.resolve();
    expect(started).toEqual(['deploy', 'snapshot']);
    resolveDeploy(deploy());
    resolveSnapshot(snap());
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['deploy', 'snapshot', 'checkpoint', 'lock', 'ownership']);

    resolveCheckpoint(null);
    resolveLock(null);
    resolveOwnership(null as never);
    await expect(pending).resolves.toMatchObject({ repoRoot: '/repo' });
  });

  it('starts candidate, lock, ownership, and all local containment reads before consuming containment', async () => {
    const started: string[] = [];
    const containmentResolvers: Array<(value: string | null) => void> = [];
    let signalContainmentStarted!: () => void;
    const containmentStarted = new Promise<void>((resolve) => {
      signalContainmentStarted = resolve;
    });
    let resolveCandidates!: (value: { judgingSha: null; nextCandidateSha: null }) => void;
    const candidatesPending = new Promise<{ judgingSha: null; nextCandidateSha: null }>((resolve) => {
      resolveCandidates = resolve;
    });
    const inner = fakeGit({ pathCommit: 'abc1234567', subject: 'ordered fan-out' });
    const git: GitRunner = async (repo, args) => {
      if (args[0] === 'merge-base' && containmentResolvers.length < 4) {
        started.push(`contain:${args[2]}..${args[1]}`);
        return new Promise<string | null>((resolve) => {
          containmentResolvers.push(resolve);
          if (containmentResolvers.length === 4) signalContainmentStarted();
        });
      }
      return inner(repo, args);
    };

    const pending = gitPipelinePosition(
      { path: 'packages/operator-core/lib/example.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => {
          started.push('checkpoint');
          return null;
        },
        readCheckpointRunLock: async () => {
          started.push('lock');
          return null;
        },
        readGateOwnership: async () => {
          started.push('ownership');
          return unownedCell('gate.greenCheckpoint.ownership');
        },
        resolveGateCandidates: () => {
          started.push('candidates');
          return candidatesPending;
        },
      },
    );

    await containmentStarted;
    expect(started.slice(0, 4)).toEqual(['checkpoint', 'lock', 'ownership', 'candidates']);
    expect(containmentResolvers).toHaveLength(4);

    for (const resolve of containmentResolvers) resolve('abc1234567');
    resolveCandidates({ judgingSha: null, nextCandidateSha: null });
    await expect(pending).resolves.toMatchObject({ repoRoot: '/repo' });
  });
});

describe('gitPipelinePosition git read budget + dedupe (EI-24040329952723202)', () => {
  // Measured on a real call: 39 git reads, only 26 distinct — `log -1 HEAD -- <path>` ran 5x
  // concurrently at ~3.3s each under contention, and nothing bounded the TOTAL (p95 17.8s, one 67.5s
  // outlier against the 60s MCP abort). These pin both halves of the fix.
  it('shares ONE subprocess across identical concurrent reads; a different argv or repo stays separate', async () => {
    const base = vi.fn(async (_repo: string, args: string[]) => `out:${args.join(' ')}`);
    const { git, stats } = withGitReadBudget(base);
    const same = await Promise.all(Array.from({ length: 5 }, () => git('/r', ['log', '-1', '--', 'p'])));
    expect(same).toEqual(Array(5).fill('out:log -1 -- p'));
    expect(base).toHaveBeenCalledTimes(1);
    await git('/r', ['log', '-1', '--', 'q']); // control: different argv is NOT collapsed
    await git('/other', ['log', '-1', '--', 'p']); // control: different repo is NOT collapsed
    expect(base).toHaveBeenCalledTimes(3);
    expect(stats).toEqual({ requested: 7, spawned: 3, deduped: 4, refused: 0 });
  });

  it('stops spawning once the total budget is spent: later reads resolve null, onExhausted fires once', async () => {
    let t = 1_000;
    const onExhausted = vi.fn();
    const base = vi.fn(async () => 'ok');
    const { git, stats } = withGitReadBudget(base, { budgetMs: 500, now: () => t, onExhausted });
    await expect(git('/r', ['a'])).resolves.toBe('ok');
    t += 499; // control: still inside the budget, so it must still spawn
    await expect(git('/r', ['b'])).resolves.toBe('ok');
    t += 1; // exactly spent
    await expect(git('/r', ['c'])).resolves.toBeNull();
    await expect(git('/r', ['d'])).resolves.toBeNull();
    await expect(git('/r', ['a'])).resolves.toBe('ok'); // an already-settled read costs no subprocess, so it is still served
    expect(base).toHaveBeenCalledTimes(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(stats.refused).toBe(2);
  });

  it('end to end: a spent budget keeps gitPipelinePosition from spawning ANY git read and says so in notes', async () => {
    const base = vi.fn(fakeGit({}));
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git: base, gitReadBudget: { budgetMs: 0 }, loadDeploy: async () => deploy(), loadSnapshot: async () => snap({}) },
    );
    expect(base).not.toHaveBeenCalled();
    expect(res.notes.join('\n')).toContain('Git read budget');
  });

  it('control: the default budget still runs git and raises no budget note', async () => {
    const base = vi.fn(fakeGit({}));
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git: base, loadDeploy: async () => deploy(), loadSnapshot: async () => snap({}) },
    );
    expect(base).toHaveBeenCalled();
    expect(res.notes.join('\n')).not.toContain('Git read budget');
  });
});

describe('gitPipelinePosition (P-002)', () => {
  it('EI-23739745256751648: stamps the state-cell abort detail and disclaims current-run liveness', async () => {
    const observedAtMs = Date.now() - 27 * 60_000;
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git: fakeGit({}),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap({
            inconclusive: {
              status: 'repair-in-progress',
              candidate: '6234b578884e',
              detail: 'candidate remains serialized and no suite was run',
              observedAtMs,
            },
          }),
      },
    );

    expect(res.gate.inconclusive?.detail).toContain('no suite was run');
    expect(res.gate.inconclusive?.detail).toContain('Abort observed 27m ago');
    expect(res.gate.inconclusive?.detail).toContain(GATE_ABORT_DETAIL_LIVENESS_MARKER);
  });

  it('WI-2146319: always emits a stable candidateFailures object when no queue is present', async () => {
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git: fakeGit({}), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.gate.candidateFailures).toMatchObject({
      candidateSha: null,
      repairHeadSha: null,
      assessment: 'no-frozen-candidate',
    });
    expect(res.gate.candidateFailures?.unavailable).toMatch(/not "zero failures"/);
    expect(res.gate.candidateFailures?.nonTestLegs).toBeDefined();
  });

  it('WI-6554700010009052: passes the persisted queue signature into candidateFailures', async () => {
    const signature: RepairSignatureEntry[] = [{
      kind: 'lint-leg',
      id: 'lint:tsc:workspaces',
      recipe: 'npm run lint:tsc:workspaces',
      admittedRound: 1,
      measuredHead: 'c'.repeat(40),
    }];
    const repairQueue = diagnoseFrozenCandidateRepairQueue({
      ...createFrozenCandidateRepairQueue({ candidate: 'c'.repeat(40), base: null, nowMs: 0, signature }),
      repairHead: 'd'.repeat(40),
      fixerSpawnId: 'fixer',
    }, { nowMs: 1, fixerAlive: true });
    if (!repairQueue) throw new Error('The frozen queue diagnostic must exist');
    const readCandidateFailures = vi.fn(async () => null as unknown as GateCandidateFailures);

    await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git: fakeGit({}),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({ repairQueue }),
        readCheckpointRunSnapshot: async () => null,
        readCheckpointRunLock: async () => null,
        readGateOwnership: async () => unownedCell('test'),
        loadRuntimeVintage: async () => [],
        readGateCandidateFailures: readCandidateFailures,
      },
    );

    expect(readCandidateFailures).toHaveBeenCalledOnce();
    expect(readCandidateFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateSha: repairQueue.candidate,
        repairHeadSha: repairQueue.repairHead,
        queueSignature: signature,
      }),
    );
  });

  it('WI-2146319: preserves an unreadable queue identity and marks candidate failures unmeasured', async () => {
    const queueRead = {
      status: 'unreadable' as const,
      reason: 'schema-newer-than-reader' as const,
      schemaVersion: 5,
      candidate: 'c'.repeat(40),
      repairHead: 'd'.repeat(40),
      phase: 'ready-to-verify',
    };
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git: fakeGit({}),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({ repairQueueRead: queueRead }),
      },
    );

    expect(res.gate.repairQueueRead).toEqual(queueRead);
    expect(res.gate.candidateFailures).toMatchObject({
      candidateSha: queueRead.candidate,
      repairHeadSha: queueRead.repairHead,
      assessment: 'unmeasured',
      unavailable: expect.stringContaining('phase ready-to-verify'),
    });
    expect(res.gate.candidateFailures?.unavailable).toMatch(/candidate cccccccccccc/);
  });

  it('a fully-promoted+deployed superproject path reads committed→staging→main→deployed (live)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      subject: 'my fix',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions).toEqual({ committedLocal: true, onStaging: true, inMain: true, deployed: true });
    expect(res.submodule).toBeNull();
    // P-003 changed this deliberately: the summary no longer prints a bare
    // "(live)" off `positions.deployed`, because that git fact cannot establish
    // that the serving PROCESS has loaded the code. It may claim live only with
    // the process evidence attached — which this fixture supplies (deploy 1h ago,
    // serving process started 60s ago).
    expect(res.summary).toContain('live — the serving process started after this code landed');
    expect(res.serving.startedSinceCodeChange).toBe(true);
  });

  it('measures target-to-green-pin ancestry instead of reversing the relationship', async () => {
    const target = 'targetsha0';
    const greenPin = 'readysha0';
    const git = fakeGit({
      pathCommit: target,
      subject: 'target',
      contains: {
        HEAD: [target],
        'origin/staging': [target],
        'origin/main': [target],
        deployedsha0: [target],
        // The target is newer than the green pin: the green pin is an ancestor of
        // target, but target is not in the green pin's history.
        [greenPin]: [],
        [target]: [greenPin],
      },
    });

    const res = await gitPipelinePosition(
      { sha: target },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.positions.inMain).toBe(true);
    expect(res.verdictProvenance.targetIncludedInGreenPin).toBe(false);
  });

  it('measures exact fix-commit containment against gate_health.observedCandidate', async () => {
    const target = 'targetsha0';
    const observedCandidate = 'observedsha0';
    const snapshot = snap({ observedCandidate });
    const git = fakeGit({
      pathCommit: target,
      subject: 'target',
      contains: {
        HEAD: [target],
        'origin/staging': [target],
        'origin/main': [target],
        deployedsha0: [target],
        readysha0: [target],
        [observedCandidate]: [target],
      },
    });

    const res = await gitPipelinePosition(
      { sha: target },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snapshot },
    );

    expect(res.gate.observedCandidate).toBe(observedCandidate);
    expect(res.verdictProvenance.targetIncludedInObservedCandidate).toBe(true);
  });

  it('distinguishes an honest observed-candidate miss from an unreadable ancestry probe', async () => {
    const target = 'targetsha0';
    const observedCandidate = 'observedsha0';
    const snapshot = snap({ observedCandidate });
    const base = {
      pathCommit: target,
      subject: 'target',
      contains: {
        HEAD: [target],
        'origin/staging': [target],
        'origin/main': [target],
        deployedsha0: [target],
        readysha0: [target],
        [observedCandidate]: [],
      },
    };

    const missing = await gitPipelinePosition(
      { sha: target },
      { git: fakeGit(base), loadDeploy: async () => deploy(), loadSnapshot: async () => snapshot },
    );
    expect(missing.verdictProvenance.targetIncludedInObservedCandidate).toBe(false);

    const unreadable = await gitPipelinePosition(
      { sha: target },
      {
        git: fakeGit({ ...base, failRefs: [observedCandidate] }),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snapshot,
      },
    );
    expect(unreadable.verdictProvenance.targetIncludedInObservedCandidate).toBeNull();
  });

  it('projects structured git-sync skipped-path provenance into the pipeline position', async () => {
    const skippedPaths = [
      {
        scope: 'superproject',
        path: 'packages/operator-core/lib/example.ts',
        owner: 'su-test',
        intent: 'editing the source file',
      },
    ];
    const snapshot = snap();
    snapshot.gitSync = {
      ...snapshot.gitSync,
      lastStatus: 'skipped-locked',
      skippedPaths,
    };
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/example.ts' },
      {
        git: fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } }),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snapshot,
      },
    );
    expect(res.gitSync).toMatchObject({ status: 'skipped-locked', skippedPaths });
  });

  /**
   * D-038 axis 2 + D-039's hoist — and the defect P-006 found in THIS cell while
   * trying to register it as the contract's exemplar.
   *
   * `refContains` returned `contained === '0'` over a GitRunner that yields `null`
   * on any failure, so `null === '0'` made a FAILED read indistinguishable from an
   * honest "this ref does not contain the commit". An agent reads `inMain: false`
   * and waits for a stage it may already have passed — a verdict manufactured from
   * an absence, in the pipeline's headline leg.
   */
  it('a FAILED ref read is hoisted as unknown, never reported as a confident "not reached"', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], deployedsha0: [] },
      failRefs: ['origin/main'], // could not measure — NOT "honestly not contained"
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    // The boolean still degrades to false, so every existing consumer is unchanged…
    expect(res.positions.inMain).toBe(false);
    // …but it is now SAYABLE that this particular false was not a measurement.
    expect(res.positionsUnknown).toContain('inMain');
    // And a leg that genuinely read "not contained" must NOT be swept in with it.
    // A hoist that cries wolf is one agents learn to ignore, which would leave us
    // worse off than the bare boolean it replaced.
    expect(res.positionsUnknown).not.toContain('deployed');
    expect(res.positions.deployed).toBe(false);
    expect(res.positions.onStaging).toBe(true);
  });

  /**
   * WI-6646 — the NEWER-COMMIT trap in `positions.inMain` / `positions.deployed`.
   *
   * With a `path`, `targetSha` is "the newest commit TOUCHING that path", so both legs
   * answer about that commit — which on a shared file is routinely a PEER'S, committed
   * after yours by the whole-tree git-sync sweep. `inMain: false` then means "the newest
   * commit touching this file has not reached main", NOT "your change has not reached
   * main", and those demand opposite advice. Measured on the live repo 2026-07-28: 43 of
   * the 54 paths then diverging between main and staging reported `inMain: false` while a
   * real change to that same file WAS already in main.
   *
   * This is the identical trap `changeInCandidate.judgingContainsPath` carries, but these
   * legs shipped without either of its mitigations — and they are what `summary`,
   * `stages[]`, `blockedOn` and `nextAction` are all derived from.
   */
  describe('WI-6646: the newer-commit artifact in the inMain/deployed legs', () => {
    const P = 'apps/operator/app/x.ts';
    /** A peer's commit, newer than the caller's, is what `targetSha` resolves to. */
    const PEER = 'bbbb222222';
    /** The caller's own commit — already in main, and invisible to the bare legs. */
    const MINE = 'aaaa111111';
    /** A later peer commit touching the same path after the caller's change. */
    const LATER = 'cccc333333';

    it('EXPLAINS a false inMain when the ref already holds an earlier commit to the same path', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        // main does not have the peer's commit, but it DOES have the caller's earlier one.
        newestInRef: { 'origin/main': MINE, deployedsha0: MINE },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // The boolean is unchanged — every existing consumer still sees the same value…
      expect(res.positions.inMain).toBe(false);
      // …but it is now SAYABLE that this false is about a newer commit, not the caller.
      expect(res.positionsNewerCommit).toContain('inMain');
      // The cell still needs a decision-ready ladder code. The qualifier above is
      // structured ambiguity evidence; it must not turn the value-bearing assessment
      // into UNINTERPRETED (the live probe compares this code across sibling paths).
      expect(res.assessments.pipelinePosition).toBe('awaiting-gate');
      expect(res.notes.join('\n')).toMatch(/FALSE ABOUT A NEWER COMMIT/);
      // And it must name the lever, or the caller is left with a warning and no move.
      expect(res.notes.join('\n')).toMatch(/`marker`/);
    });

    it('applies the SAME treatment to the deployed leg, not just inMain', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE, deployedsha0: MINE },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // Both legs share the one `targetSha`, so a fix that only covered inMain would
      // leave the identical false in the leg agents actually act on ("is it LIVE?").
      expect(res.positionsNewerCommit).toEqual(expect.arrayContaining(['inMain', 'deployed']));
    });

    it('covers onStaging too, and never committedLocal (which cannot be a newer-commit artifact)', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        // Local HEAD is ahead of every remote — the shape an unpushed peer commit creates.
        contains: { HEAD: [PEER], 'origin/staging': [], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/staging': MINE, 'origin/main': MINE, deployedsha0: MINE },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // All three REF-relative legs share the one `targetSha`, so leaving any of them out
      // would be a half-fix that leaves the trap armed on that leg.
      expect(res.positionsNewerCommit.sort()).toEqual(['deployed', 'inMain', 'onStaging']);
      // committedLocal is structurally immune: `targetSha` is resolved by `git log`
      // against HEAD, so it is an ancestor of HEAD by construction. Flagging it would be
      // crying wolf on a leg that cannot exhibit the defect.
      expect(res.positionsNewerCommit).not.toContain('committedLocal');
      expect(res.positions.committedLocal).toBe(true);
    });

    it('reads eligible marker refs concurrently while preserving each correction', async () => {
      const refs = ['origin/main', 'deployedsha0'] as const;
      const base = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE, deployedsha0: MINE },
        blobAtRef: Object.fromEntries(refs.map((ref) => [ref, 'function exactlyOnceHere() {}\n'])),
        parentBlobAtTarget: 'empty baseline\n',
        parentBlobs: { [`${MINE}~1`]: 'empty baseline\n' },
      });
      let activeMarkerRefReads = 0;
      let maxConcurrentMarkerRefReads = 0;
      const git: GitRunner = async (repo, args) => {
        const markerRef = args[0] === 'rev-parse' ? args[2]?.replace(/\^\{commit\}$/, '') : undefined;
        if (markerRef && refs.includes(markerRef as (typeof refs)[number])) {
          activeMarkerRefReads += 1;
          maxConcurrentMarkerRefReads = Math.max(maxConcurrentMarkerRefReads, activeMarkerRefReads);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeMarkerRefReads -= 1;
        }
        return base(repo, args);
      };

      const res = await gitPipelinePosition(
        { path: P, marker: 'exactlyOnceHere' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      expect(maxConcurrentMarkerRefReads).toBe(2);
      expect(res.positions).toMatchObject({ onStaging: true, inMain: true, deployed: true });
      expect(res.positionsMarker).toMatchObject({
        inMain: { present: true, count: 1 },
        deployed: { present: true, count: 1 },
      });
    });

    it('a MARKER present in the ref CORRECTS the leg to true, in the result and the summary', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        // main's version of the file DOES carry the caller's change.
        blobAtRef: { 'origin/main': 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n' },
        // EI-19325915429897280: the marker occurred ZERO times before the change,
        // so its 2 occurrences in `origin/main` are a strict net-new count — this
        // is the baseline the "CORRECTED to true" verdict below now REQUIRES.
        parentBlobAtTarget: 'nothing relevant here\n',
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(true);
      expect(res.positionsMarker?.inMain?.present).toBe(true);
      expect(res.positionsMarker?.inMain?.count).toBe(2);
      // A corrected leg must NOT also be reported as a newer-commit artifact — the
      // marker SETTLED it, and emitting both would re-introduce the ambiguity.
      expect(res.positionsNewerCommit).not.toContain('inMain');
      expect(res.notes.join('\n')).toMatch(/CORRECTED to true by the marker/);
      // The correction has to reach the rendered verdict, not just a side field — the
      // summary tick is what an agent actually reads.
      expect(res.summary).toMatch(/main ✓/);
    });

    it('a later same-path commit carrying the marker does not erase the correction', async () => {
      const git = fakeGit({
        pathCommit: LATER,
        contains: { HEAD: [LATER], 'origin/staging': [LATER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        // main's version still carries the caller's marker twice. The later target
        // commit's parent already carries those occurrences, so the old target-parent
        // baseline would incorrectly decline the correction.
        blobAtRef: { 'origin/main': 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n' },
        parentBlobAtTarget: 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n',
        // The candidate commit is the caller's change: its own parent has no marker.
        parentBlobs: { [`${MINE}~1`]: 'nothing relevant here\n' },
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(true);
      expect(res.positionsMarker?.inMain?.count).toBe(2);
      expect(res.positionsNewerCommit).not.toContain('inMain');
      expect(res.notes.join('\n')).toMatch(/CORRECTED to true by the marker/);
      expect(res.summary).toMatch(/main ✓/);
    });

    /**
     * EI-21443291930356119. A marker-DELETING change is still correctable — but only
     * on REF-INTERNAL evidence: the ref's own newest commit to this path (MINE) has
     * to show the drop against ITS parent. That measures a change inside the ref's
     * history, which is the one reading a lagging ref cannot counterfeit.
     */
    it("a MARKER removed by the caller CORRECTS the leg when the REF'S OWN history shows the drop", async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        // main's version no longer carries the marker…
        blobAtRef: { 'origin/main': 'function remains() {}\n' },
        parentBlobAtTarget: 'function looksDeadOrStuck() {}\n',
        // …and main's OWN newest commit to this path is what removed it: its parent
        // still had the occurrence. That is the caller's deletion, inside main.
        parentBlobs: { [`${MINE}~1`]: 'function looksDeadOrStuck() {}\n' },
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(true);
      expect(res.positionsMarker?.inMain?.present).toBe(false);
      expect(res.positionsMarker?.inMain?.count).toBe(0);
      expect(res.positionsNewerCommit).not.toContain('inMain');
      expect(res.notes.join('\n')).toMatch(/CORRECTED to true by the marker/);
      expect(res.notes.join('\n')).toMatch(/strict net-decrease/);
      expect(res.summary).toMatch(/main ✓/);
    });

    /**
     * EI-21443291930356119 — the production false-positive this branch used to emit,
     * reproduced from the live shape that found it.
     *
     * A marker introduced by an EARLIER commit than the path's tip makes the
     * target-parent baseline (`targetSha~1`) already carry it. A ref that simply
     * PREDATES the marker then reads as a "strict net-decrease" against that
     * baseline — count 0 where the baseline has 2 — and the leg was corrected to
     * TRUE on it. Live consequence: `packages/…/session/request-compaction.ts`
     * reported `inMain ✓ / deployed ✓ / live` while `git show origin/main:<path>`
     * and the deployed sha both contained the marker ZERO times and the change sat
     * behind a 42-red gate. `positions.deployed` is the leg agents act on, so this
     * is the most expensive direction the tool can be wrong in.
     *
     * A decrease measured against the HEAD side is NOT evidence of containment.
     * Deleting the `refInternalChange` gating and this test goes red.
     */
    it('EI-21443291930356119: a ref that merely PREDATES the marker is never corrected by "net-decrease"', async () => {
      const git = fakeGit({
        pathCommit: LATER,
        contains: { HEAD: [LATER], 'origin/staging': [LATER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE, deployedsha0: MINE },
        // main's version is simply OLD: it predates the marker entirely (count 0).
        blobAtRef: { 'origin/main': 'nothing relevant here\n', deployedsha0: 'nothing relevant here\n' },
        // The marker landed BEFORE the path's newest commit, so the target-parent
        // baseline already carries it twice — the shape that produced the false.
        parentBlobAtTarget: 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n',
        // main's own newest commit to this path did not touch the marker either way,
        // so there is no ref-internal drop to rest a deletion verdict on.
        parentBlobs: { [`${MINE}~1`]: 'nothing relevant here\n' },
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      expect(res.positions.inMain).toBe(false);
      expect(res.positions.deployed).toBe(false);
      expect(res.notes.join('\n')).not.toMatch(/CORRECTED to true by the marker/);
      expect(res.notes.join('\n')).not.toMatch(/strict net-decrease/);
      // The decline has to SAY why, or the caller re-reads it as the newer-commit
      // false the marker was supposed to settle and passes the same marker again.
      expect(res.notes.join('\n')).toMatch(/FEWER, not more/);
      expect(res.notes.join('\n')).toMatch(/inMain: confirmed NOT present/);
      // And the headline verdict must not render as shipped.
      expect(res.summary).not.toMatch(/deployed ✓/);
    });

    it('EI-21285379200225840: a marker present only in staging never corrects path-absent main/deployed legs', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        // The file has never landed in either target tree, so both ref-scoped
        // newest-path reads are measured absences rather than failed reads.
        newestInRef: { 'origin/main': '', deployedsha0: '' },
        absentRefs: ['origin/main', 'deployedsha0'],
        // The caller's marker is genuinely new in the target commit, but no target
        // tree contains that path at all. This is the production false-positive shape.
        parentBlobAtTarget: 'nothing relevant here\n',
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      expect(res.positions.inMain).toBe(false);
      expect(res.positions.deployed).toBe(false);
      expect(res.positionsMarker?.inMain).toMatchObject({ present: false, count: 0, pathPresent: false });
      expect(res.positionsMarker?.deployed).toMatchObject({ present: false, count: 0, pathPresent: false });
      expect(res.positionsNewerCommit).not.toEqual(expect.arrayContaining(['inMain', 'deployed']));
      expect(res.notes.join('\n')).toMatch(/inMain: confirmed NOT present/);
      expect(res.notes.join('\n')).toMatch(/deployed: confirmed NOT present/);
      expect(res.notes.join('\n')).not.toMatch(/CORRECTED to true by the marker/);
    });

    /**
     * WI-41208, unit half. `markerNetChange` is the boolean that decides whether a FALSE
     * position leg is CORRECTED to true, so it is the one guard here that must be
     * provably falsifiable. The prescribed tier for a module under test is a
     * deliberately-wrong implementation kept permanently beside it as a control, plus a
     * calibration the real subject must pass — mutating the shared tree to prove this is
     * both unnecessary and unsafe here.
     *
     * WRONG_markerNetChange is the pre-fix logic verbatim: a strict count comparison with
     * no `pathPresent` gate. Every case below is asserted against BOTH, so the two must
     * disagree exactly where the bug lived and agree everywhere else. If the real
     * implementation ever regresses to the wrong one, the `not.toBe` rows fail; if the
     * control is silently "fixed" to match, the calibration rows keep it honest.
     */
    const marker = (over: Partial<MarkerContainment> = {}): MarkerContainment => ({
      marker: 'looksDeadOrStuck',
      sha: 'ref0000000',
      present: true,
      count: 1,
      pathPresent: true,
      unknownReason: null,
      ...over,
    });
    const WRONG_markerNetChange = (
      atRef: MarkerContainment | null | undefined,
      baseline: MarkerContainment | null | undefined,
    ): 'added' | 'removed' | null => {
      if (!atRef || !baseline) return null;
      if (typeof atRef.count !== 'number' || typeof baseline.count !== 'number') return null;
      if (atRef.count > baseline.count) return 'added';
      if (atRef.count < baseline.count) return 'removed';
      return null;
    };

    it('WI-41208 unit: markerNetChange refuses a PATH-ABSENT ref where the pre-fix logic said "removed"', () => {
      // THE PRODUCTION SHAPE: the ref has no such path (a definitive count of 0), while
      // the baseline — the file immediately before the change — carried the marker.
      const pathAbsentAtRef = marker({ present: false, count: 0, pathPresent: false });
      const baselineWithMarker = marker({ count: 1 });

      expect(markerNetChange(pathAbsentAtRef, baselineWithMarker)).toBe(null);
      // The control convicts: without the pathPresent gate this reads as a net-decrease,
      // which is what corrected onStaging/inMain/deployed to true for an unpushed file.
      expect(WRONG_markerNetChange(pathAbsentAtRef, baselineWithMarker)).toBe('removed');
      expect(markerNetChange(pathAbsentAtRef, baselineWithMarker)).not.toBe(
        WRONG_markerNetChange(pathAbsentAtRef, baselineWithMarker),
      );

      // The mirror case: a baseline whose own tree lacks the path cannot anchor anything.
      const baselineAbsent = marker({ present: false, count: 0, pathPresent: false });
      expect(markerNetChange(marker({ count: 2 }), baselineAbsent)).toBe(null);
      expect(WRONG_markerNetChange(marker({ count: 2 }), baselineAbsent)).toBe('added');
    });

    it('WI-41208 unit: CALIBRATION — the real net-change verdicts still fire when both trees have the file', () => {
      // Without these rows the test above would pass on a subject that always returns
      // null, i.e. a guard that had silently disabled every marker correction.
      const added = markerNetChange(marker({ count: 2 }), marker({ count: 0, present: false }));
      const removed = markerNetChange(marker({ count: 0, present: false }), marker({ count: 1 }));
      expect(added).toBe('added');
      expect(removed).toBe('removed');
      // Where the file is present on both sides, right and wrong must AGREE — that is
      // what makes the disagreement above attributable to `pathPresent` alone.
      expect(added).toBe(WRONG_markerNetChange(marker({ count: 2 }), marker({ count: 0, present: false })));
      expect(removed).toBe(WRONG_markerNetChange(marker({ count: 0, present: false }), marker({ count: 1 })));

      // Unmeasured counts and an equal count are never a verdict, in either direction.
      expect(markerNetChange(marker({ count: 1 }), marker({ count: 1 }))).toBe(null);
      expect(markerNetChange(marker({ count: null, present: null }), marker({ count: 1 }))).toBe(null);
      expect(markerNetChange(null, marker())).toBe(null);
      expect(markerNetChange(marker(), undefined)).toBe(null);
    });

    /**
     * WI-41208. The EI-21285379200225840 fixture directly above sets a marker-FREE
     * baseline (`parentBlobAtTarget: 'nothing relevant here'`), so `0 < 0` is false and
     * `strictlyRemoved` never fires — which is why that test passed while production
     * still flipped every leg to true. The production shape differs by one word: the
     * newest commit touching the path is an EDIT to a file that ALREADY carried the
     * marker, so the baseline count is NON-ZERO. Each path-absent ref then measures 0,
     * and `0 < baseline` read as a strict net-DECREASE.
     *
     * This test is one half of a two-sided control. Its sibling above — 'a MARKER
     * removed by the target change CORRECTS an absent ref marker by strict count
     * decrease' — is the calibration: it keeps `blobAtRef` set, so the ref genuinely
     * HAS the file and the net-decrease correction must still fire. Delete the
     * `refHasPath`/`baselineHasPath` guard and this test fails; delete `strictlyRemoved`
     * altogether and that one does. Neither passes vacuously.
     */
    it('WI-41208: a NON-ZERO marker baseline never corrects a PATH-ABSENT ref by "strict net-decrease"', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [], 'origin/main': [], deployedsha0: [] },
        // The file is NEW and unpushed: no target tree has ever carried this path.
        // '' is the MEASURED absence, distinct from omitting the ref (a failed read).
        newestInRef: { 'origin/staging': '', 'origin/main': '', deployedsha0: '' },
        absentRefs: ['origin/staging', 'origin/main', 'deployedsha0'],
        // The one difference from the fixture above — a baseline that carries the marker.
        parentBlobAtTarget: 'function looksDeadOrStuck() {}\n',
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      expect(res.positions.onStaging).toBe(false);
      expect(res.positions.inMain).toBe(false);
      expect(res.positions.deployed).toBe(false);
      for (const leg of ['onStaging', 'inMain', 'deployed'] as const) {
        expect(res.positionsMarker?.[leg]).toMatchObject({ present: false, count: 0, pathPresent: false });
      }
      expect(res.notes.join('\n')).not.toMatch(/CORRECTED to true by the marker/);
      expect(res.notes.join('\n')).not.toMatch(/strict net-decrease/);
      // The rendered verdict is what an agent acts on — it must not read as shipped.
      expect(res.summary).not.toMatch(/main ✓/);
    });

    it('a MARKER absent from the ref confirms a GENUINE miss and does not cry newer-commit', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        blobAtRef: { 'origin/main': 'nothing of yours here\n' },
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(false);
      expect(res.positionsMarker?.inMain?.present).toBe(false);
      // The marker answered definitively, so the "may not be about your change" hedge
      // would be actively misleading here.
      expect(res.positionsNewerCommit).not.toContain('inMain');
      expect(res.notes.join('\n')).toMatch(/confirmed NOT present/);
    });

    /**
     * EI-19325915429897280 — the bug this whole baseline mechanism exists to fix.
     * A marker that already occurred in the file BEFORE the change (same count at
     * the baseline as at the ref) proves nothing: presence alone used to
     * unconditionally exonerate the leg, which is exactly how a non-unique marker
     * (a pre-existing identifier, a common symbol) made `dev:pipeline_position`
     * report an undeployed change as live.
     */
    it('EI-19325915429897280: a marker NOT unique to the change (same count as the baseline) does not correct the leg, and still falls through to the newer-commit explanation', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        // The marker occurs in main's version — but it ALREADY occurred the SAME
        // number of times before the change, so its presence in `origin/main`
        // proves nothing about whether the change itself reached main.
        blobAtRef: { 'origin/main': 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n' },
        parentBlobAtTarget: 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n',
        // Keep the candidate-specific fallback honest too: this marker was already
        // present before the candidate commit, so it must not correct the leg.
        parentBlobs: { [`${MINE}~1`]: 'function looksDeadOrStuck() {}\n// looksDeadOrStuck again\n' },
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // NOT corrected — a non-discriminating marker must never upgrade the leg.
      expect(res.positions.inMain).toBe(false);
      expect(res.positionsMarker?.inMain?.present).toBe(true);
      expect(res.positionsMarker?.inMain?.count).toBe(2);
      expect(res.notes.join('\n')).toMatch(/NOT unique to your change/);
      // Unsettled by the marker → still falls through to the newer-commit
      // explanation, same as if no marker had been supplied at all.
      expect(res.positionsNewerCommit).toContain('inMain');
    });

    /**
     * EI-19325915429897280, the second failure mode the fix guards: the baseline
     * commit itself is unresolvable (e.g. a shallow clone, or a `~1` that predates
     * history the checkout has). Presence in the ref is then genuinely
     * uninformative — it must be reported as UNMEASURED, never silently treated
     * as either a correction or a confirmed miss.
     */
    it('EI-19325915429897280: a marker present but an UNRESOLVABLE baseline is reported as unmeasured, never as a correction', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        newestInRef: { 'origin/main': MINE },
        blobAtRef: { 'origin/main': 'function looksDeadOrStuck() {}\n' },
        // No `parentBlobAtTarget` — the baseline commit does not resolve.
      });
      const res = await gitPipelinePosition(
        { path: P, marker: 'looksDeadOrStuck' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(false);
      expect(res.positionsMarker?.inMain?.present).toBe(true);
      expect(res.notes.join('\n')).toMatch(/baseline .* could not be measured/);
      expect(res.positionsNewerCommit).toContain('inMain');
    });

    it('does NOT cry newer-commit when the file has genuinely never landed in the ref', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        // '' = measured absence: main has NO commit touching this path. "Not yet, wait"
        // is the correct advice, and a hoist that cries wolf here is one agents learn
        // to ignore — leaving us worse off than the bare boolean.
        newestInRef: { 'origin/main': '', deployedsha0: '' },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(false);
      expect(res.positionsNewerCommit).toEqual([]);
    });

    it('never relabels a DEGRADED leg as a newer-commit artifact', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], deployedsha0: [] },
        failRefs: ['origin/main'], // could not measure
        newestInRef: { 'origin/main': MINE, deployedsha0: MINE },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // An unreadable leg is UNKNOWN. Replacing that honest unknown with a confident
      // story about WHY it is false is strictly worse than the bare false it replaced.
      expect(res.positionsUnknown).toContain('inMain');
      expect(res.positionsNewerCommit).not.toContain('inMain');
    });

    it('stays silent when the newer-commit probe itself fails to read', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [], deployedsha0: [] },
        // no `newestInRef` at all => the probe returns null (a FAILED read). D-038 axis 2:
        // never derive a verdict — in either direction — from an absence.
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positions.inMain).toBe(false);
      expect(res.positionsNewerCommit).toEqual([]);
    });

    it('reports no positionsMarker at all when the caller named no marker', async () => {
      const git = fakeGit({
        pathCommit: PEER,
        contains: { HEAD: [PEER], 'origin/staging': [PEER], 'origin/main': [PEER], deployedsha0: [PEER] },
      });
      const res = await gitPipelinePosition(
        { path: P },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.positionsMarker).toBeNull();
    });
  });

  /**
   * P-007. The four verdict cells declare `unknownHoist: 'verdictUnknown'`, and that
   * declaration is only honest if the resolver actually populates it. These are the
   * tests that keep the registration from becoming a claim about code that changed.
   *
   * Each leg below degrades into a value that reads as GOOD NEWS, which is why a
   * comment would not have been enough.
   */
  describe('P-007: verdictUnknown hoists the three verdict legs', () => {
    const measuring = () =>
      fakeGit({
        pathCommit: 'abc1234567',
        contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': ['abc1234567'] },
      });

    it('carries NEITHER gate.consecutiveReds NOR verdictProvenance.mainFastForwarded when both are genuinely measured', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        { git: measuring(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // A hoist that cries wolf is one agents learn to ignore — the healthy case must
      // stay silent for THESE two legs, or the whole mechanism is worse than the bare
      // value it qualifies. WI-6485: this fixture never mocks `resolveGateCandidates`,
      // so it falls through to the REAL resolver, which fails safely to
      // judgingSha:null in this sandboxed test environment (no real checkout at
      // `root`) — i.e. this fixture's `changeInCandidate.judgingSha` genuinely IS the
      // "no checkpoint run is in flight" case, correctly hoisted as not-applicable by
      // WI-6485's fix below. Assert on the TWO legs this test actually exists to cover
      // rather than the whole array, so that correct, unrelated hoist does not read as
      // a false alarm here.
      expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('gate.consecutiveReds');
      expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('verdictProvenance.mainFastForwarded');
    });

    /**
     * THE ONE THIS ITEM NEARLY GOT WRONG. `gate.consecutiveReds` is typed `number`, so
     * a reader would conclude it cannot be unknown — but `git-pipeline-stats` applies
     * `?? 0` to an absent counter, so the 0 that arrives here may be a DEFAULT reading
     * as a passing gate. `verdictStale` cannot catch it: its evaluator short-circuits
     * on `consecutiveReds <= 0` because "a stale green is inert", which is true of a
     * stale green and false of an unmeasured one.
     */
    it('names a DEFAULTED reds counter, whose 0 otherwise reads as a passing gate', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        {
          git: measuring(),
          loadDeploy: async () => deploy(),
          loadSnapshot: async () =>
            snap({
              consecutiveReds: 0,
              countersUnknown: { code: 'resolver-failed', detail: 'no readable red-streak counter' },
            }),
        },
      );
      // The number still arrives as a number, so no consumer changes…
      expect(res.gate.consecutiveReds).toBe(0);
      // …but it is now sayable that this particular 0 was not a measurement.
      const leg = res.verdictUnknown.find((v) => v.leg === 'gate.consecutiveReds');
      expect(leg?.unknown.code).toBe('resolver-failed');
      // And the prose surface must carry it too — an agent reading `notes` and not the
      // hoist is the hurried consumer the hoist exists for.
      expect(res.notes.join(' ')).toMatch(/gate\.consecutiveReds/);
    });

    it('threads the failing-test measurement state beside the list', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        {
          git: measuring(),
          loadDeploy: async () => deploy(),
          loadSnapshot: async () =>
            snap({
              failingTests: [],
              failingTestsMeasured: false,
              inconclusive: {
                status: 'migrations-pending',
                candidate: 'deadbeefcafe',
                detail: 'suite never ran',
                observedAtMs: 123,
              },
            }),
        },
      );
      expect(res.gate.failingTests).toEqual([]);
      expect(res.gate.failingTestsMeasured).toBe(false);
    });

    /**
     * A null `deployedSha` was documented in this file as "there is simply nothing
     * deployed". It is not: `devDeployState` pushes 'could not resolve HEAD of release
     * checkout …' onto `errors[]` whenever that read fails, so a null is a FAILED read
     * — and the confident `positions.deployed: false` derived from it was the same
     * axis-2 defect, thirty lines below the hoist built to prevent it.
     */
    it('names an unreadable deployed sha AND stops deriving a confident position from it', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        {
          git: measuring(),
          loadDeploy: async () =>
            deploy({
              deployed: null,
              releaseRoot: '/release',
              errors: ['could not resolve HEAD of release checkout /release'],
            }),
          loadSnapshot: async () => snap(),
        },
      );
      const leg = res.verdictUnknown.find((v) => v.leg === 'deployedSha');
      expect(leg?.unknown.code).toBe('resolver-failed');
      // The REASON existed all along in deploy.errors and was being discarded.
      expect(leg?.unknown.detail).toContain('could not resolve HEAD of release checkout /release');
      // The corrected derivation: `deployed: false` is no longer asserted as measured.
      expect(res.positions.deployed).toBe(false);
      expect(res.positionsUnknown).toContain('deployed');
    });

    /** Which OPERAND was missing is asked directly, rather than sniffed out of the
     *  error strings — a substring match on prose is the thing cell-contract exists to
     *  replace, so it must not reappear in the code that reports the unknown. */
    it('names WHICH operand of the main-vs-staging comparison was unreadable', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        {
          git: measuring(),
          loadDeploy: async () => deploy(),
          loadSnapshot: async () =>
            snap({}, 'synced', { greenPinAtStagingHead: null, stagingHead: null, integrationBranch: 'staging' }),
        },
      );
      const leg = res.verdictUnknown.find((v) => v.leg === 'verdictProvenance.mainFastForwarded');
      expect(leg?.unknown.code).toBe('resolver-failed');
      expect(leg?.unknown.detail).toContain('staging head');
    });

    /**
     * `not-applicable` vs `resolver-failed` is the distinction the enum exists for —
     * one is final, the other is retry-or-escalate. A sha-only probe has no path to
     * compare, so "no candidate is judging it" is not an answer about the pipeline.
     */
    /**
     * THE READABILITY REGRESSION. The three GLOBAL cells (gate verdict / deployed sha /
     * main-vs-staging) are dispatched by `readCell` with NO ARGS, because
     * `argsForRelativity` passes `{}` for a global cell. So a no-arg read must return
     * the path-independent legs — if it does not, those three cells register and then
     * resolve to nothing, which is worse than not registering them.
     */
    it('a NO-ARG read still answers the global legs, and does not fake the per-path ones', async () => {
      const res = await gitPipelinePosition(
        {},
        { git: measuring(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap({ consecutiveReds: 4 }) },
      );
      // The three global cells' headlines are all present and real.
      expect(res.gate.consecutiveReds).toBe(4);
      expect(res.deployedSha).toBe('deployedsha0');
      expect(res.verdictProvenance.mainFastForwarded).toBe(true);
      // …and none of them is degraded, so the verdict hoist stays quiet.
      expect(res.verdictUnknown.map((v) => v.leg)).toEqual(['changeInCandidate.judgingSha']);
      // But there is NO SUBJECT, so every position leg is unmeasured rather than false.
      // Before P-007 this returned four confident `false`s with an empty hoist — the
      // same defect as a failed ref read, reachable by omitting an argument.
      expect(res.positions).toEqual({
        committedLocal: false,
        onStaging: false,
        inMain: false,
        deployed: false,
      });
      expect(res.positionsUnknown.sort()).toEqual(['committedLocal', 'deployed', 'inMain', 'onStaging']);
    });

    /**
     * The one no-target case that must STAY a confident false: a path whose file has no
     * commit yet. The `git log` read SUCCEEDED and found nothing, so "not committed, not
     * on staging" is a measurement. Hoisting it would make the hoist meaningless for the
     * newly-created-file case, which is one of the commonest reads there is.
     */
    it('does NOT hoist a path that simply has no commit yet — that false is measured', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/brand-new.ts' },
        {
          git: fakeGit({ dirty: true }), // no pathCommit ⇒ `log` returns null: nothing has touched it
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
        },
      );
      expect(res.targetSha).toBeNull();
      expect(res.positions.committedLocal).toBe(false);
      expect(res.positionsUnknown).toEqual([]);
    });

    /**
     * WI-6484 — the opposite no-target case from the one just above, and the one the
     * WI actually reported: a path that has NEVER been touched by any commit AND is
     * not even dirty in the working tree (`git status` found nothing either). Unlike
     * a brand-new uncommitted file, there is nothing here to distinguish "not yet
     * created" from "typo'd/renamed/wrong-submodule path" — the overwhelmingly likely
     * real-world cause. This IS nothing-to-measure, and must be hoisted so a caller
     * reading just the headline (notably the `git.pipelinePosition` cell's
     * `positionsUnknown` hoist) does not read "deployed: false" as "wait for it" when
     * waiting is in fact infinite.
     */
    it('DOES hoist all four positions for a path that has NEVER been touched and is not dirty either (WI-6484)', async () => {
      const res = await gitPipelinePosition(
        { path: 'does/not/exist.ts' },
        {
          git: fakeGit({}), // no pathCommit, no dirty ⇒ the path plausibly does not exist at all
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
        },
      );
      expect(res.targetSha).toBeNull();
      expect(res.positions).toEqual({ committedLocal: false, onStaging: false, inMain: false, deployed: false });
      expect(res.positionsUnknown.sort()).toEqual(['committedLocal', 'deployed', 'inMain', 'onStaging']);
    });

    /**
     * WI-6525 — the same never-touched-and-not-dirty path as the WI-6484 test above,
     * but with a RED gate behind it. Before this fix, `notInCandidate` stayed `false`
     * for a path this unresolved (its `changeInCandidate` containment fields are
     * `null`, not `false`, so the strict `=== false` compare never fired), and
     * `deriveBlocker` fell straight through the `committed` stage's null lever to the
     * `gate` stage's "fix the reds" lever — sending the caller to green a gate that
     * has nothing to do with their (nonexistent) file. The fix: the `committed` stage
     * now reports the true blocker itself, so it is the first (and only) lever
     * `deriveBlocker` finds.
     */
    it('does NOT emit "fix the reds" for a path that never existed — even with a red gate behind it (WI-6525)', async () => {
      const res = await gitPipelinePosition(
        { path: 'does/not/exist.ts' },
        {
          git: fakeGit({}), // no pathCommit, no dirty ⇒ the path plausibly does not exist at all
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap({ consecutiveReds: 4 }),
        },
      );
      expect(res.targetSha).toBeNull();
      expect(res.gate.consecutiveReds).toBe(4); // the red is real and measured …
      expect(res.blockedOn).toBe('committed'); // … but it is NOT where this path is blocked.
      expect(res.nextAction).not.toBeNull();
      expect(res.nextAction).not.toMatch(/fix the reds/);
      expect(res.nextAction).not.toMatch(/release:checkpoint-run/);
      expect(res.nextAction).toMatch(/verify the path\/sha/);
      expect(res.summary).toContain('no commit found'); // the honest headline is unchanged
    });

    it('reports a sha-only probe as not-applicable, never as "no run in flight"', async () => {
      const res = await gitPipelinePosition(
        { sha: 'abc1234567' },
        { git: measuring(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      const leg = res.verdictUnknown.find((v) => v.leg === 'changeInCandidate.judgingSha');
      expect(leg?.unknown.code).toBe('not-applicable');
      expect(res.changeInCandidate.judgingSha).toBeNull();
    });

    /**
     * WI-6485 — the asymmetry the WI reported: the sha-only-probe leg above and the
     * submodule leg both already hoist `changeInCandidate.judgingSha` as
     * `not-applicable` when it's null for an explainable reason. The ORDINARY path
     * branch (a real path, no submodule) did not, even though a MEASURED
     * "no checkpoint run is in flight right now" is the exact same kind of
     * explainable, enumerable null —
     * so `state:read { cell:'gate.greenCheckpoint.candidate' }` read it as a
     * measured, confident `value:null` via the CellHoist contract. A REAL path with
     * no candidate is in flight. The liveness inputs are explicit because the
     * production defaults read the real checkpoint cache + live run lock; leaving
     * them unmocked made this test inherit whichever gate run happened to be active.
     */
    it('assesses an ORDINARY path with no run in flight as no-active-run, without manufacturing an unknown (D-009 supersedes WI-6485)', async () => {
      const res = await gitPipelinePosition(
        { path: 'apps/operator/app/x.ts' },
        {
          git: measuring(),
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
          readCheckpointRunSnapshot: async () => ({
            activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
            computedAtMs: Date.now(),
          }),
          readCheckpointRunLock: async () => ({ held: false, elapsedSec: null }),
        },
      );
      const leg = res.verdictUnknown.find((v) => v.leg === 'changeInCandidate.judgingSha');
      expect(leg).toBeUndefined();
      expect(res.changeInCandidate.judgingSha).toBeNull();
      expect(res.assessments.gateCandidate).toBe('no-active-run');
    });
  });

  // EI-18694888339365359: the local origin/staging remote-tracking ref lagged
  // one commit behind (git-sync had not yet fetched this push) — refContains
  // against it said "not present", which would otherwise emit a false BLOCKING
  // "not-on-origin-staging" release:trace constraint and park an agent on
  // git-sync:await for a push event that already fired.
  it('EI-18694888339365359: a STALE local origin/staging ref is corrected via ls-remote when the target IS the exact remote tip', async () => {
    const git = fakeGit({
      pathCommit: 'newtip1234',
      contains: {
        HEAD: ['newtip1234'],
        'origin/staging': [], // stale local ref: does NOT (yet) contain the target
        'origin/main': [],
        deployedsha0: [],
      },
      remoteStagingTip: 'newtip1234', // but the true remote tip IS the target
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/w.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.notes.some((n) => n.includes('ls-remote'))).toBe(true);
  });

  it('EI-18694888339365359: a GENUINELY unpushed commit still reads onStaging false (ls-remote tip does not match, no false positive)', async () => {
    const git = fakeGit({
      pathCommit: 'notpushed12',
      contains: {
        HEAD: ['notpushed12'],
        'origin/staging': [],
        'origin/main': [],
        deployedsha0: [],
      },
      remoteStagingTip: 'someothersha', // remote is at a different commit entirely
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/v.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(false);
  });

  it('WI-38372: corrects a stale origin/staging ref when the target is behind the current remote tip', async () => {
    const target = 'behindstage';
    const remoteTip = 'stage-tip';
    const git = fakeGit({
      pathCommit: target,
      contains: {
        HEAD: [target],
        'origin/staging': [], // stale local ref: does NOT contain the target
        'origin/main': [],
        deployedsha0: [],
        [remoteTip]: [target], // target is an older commit in the advertised tip's history
      },
      remoteStagingTip: remoteTip,
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/behind-stage.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.notes.join('\n')).toMatch(/ls-remote.*contained in the current remote tip/);
  });

  it('WI-38372: applies the same stale-ref containment rescue to origin/main', async () => {
    const target = 'behindmain';
    const remoteTip = 'main-tip';
    const git = fakeGit({
      pathCommit: target,
      contains: {
        HEAD: [target],
        'origin/staging': [target],
        'origin/main': [], // stale local ref: does NOT contain the target
        deployedsha0: [],
        [remoteTip]: [target],
      },
      remoteMainTip: remoteTip,
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/behind-main.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.positions.inMain).toBe(true);
    expect(res.notes.join('\n')).toMatch(/origin\/main.*ls-remote.*contained in the current remote tip/);
  });

  it('WI-38372: does not claim containment when the advertised remote tip is not a local object', async () => {
    const target = 'not-local-tip-target';
    const remoteTip = 'remote-tip-not-fetched';
    const git = fakeGit({
      pathCommit: target,
      contains: {
        HEAD: [target],
        'origin/staging': [],
        'origin/main': [],
        deployedsha0: [],
      },
      remoteStagingTip: remoteTip,
      failRefs: [remoteTip],
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/unavailable-tip.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(false);
    expect(res.notes.some((n) => n.includes('corrected to true'))).toBe(false);
  });

  it('a change stuck at staging behind a STALLED gate reads main ✗ + surfaces the stall', async () => {
    const git = fakeGit({
      pathCommit: 'def7654321',
      contains: {
        HEAD: ['def7654321'],
        'origin/staging': ['def7654321'],
        'origin/main': [], // not promoted
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/y.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap({ stalled: true, consecutiveReds: 3 }) },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.positions.inMain).toBe(false);
    expect(res.positions.deployed).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('STALLED');
  });

  it('WI-282: a change stuck behind a WEDGED (non-firing, 0-red) gate surfaces the wedge, not a false all-clear', async () => {
    const git = fakeGit({
      pathCommit: 'fed7654321',
      contains: {
        HEAD: ['fed7654321'],
        'origin/staging': ['fed7654321'],
        'origin/main': [], // not promoted — main is frozen
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/z.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        // The failure mode: the checkpoint never RAN, so 0 reds + stalled:false — yet
        // it is wedged. fireStale must surface it even though the reds-based signal is clear.
        loadSnapshot: async () =>
          snap({
            stalled: false,
            consecutiveReds: 0,
            fireStale: true,
            fireStaleReason: 'the routine has not FIRED in ~3h (active, cron hourly)',
            verdictStale: false,
            verdictObservedAtMs: null,
            verdictStaleReason: null,
            verdictStaleReasonCode: null,
            candidateAgeMs: null,
            commitsBehindTip: null,
            observedCandidate: null,
            inconclusive: null,
            qualification: NO_QUALIFICATION,
          }),
      },
    );
    expect(res.positions.inMain).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('WEDGED');
    // The reds-based STALLED label must NOT be what shows (it would mislead — 0 reds).
    expect(res.summary).not.toContain('STALLED');
  });

  it('WI-10002316: an unknown stalled condition is not rendered as healthy', async () => {
    const git = fakeGit({
      pathCommit: 'unknown123456',
      contains: {
        HEAD: ['unknown123456'],
        'origin/staging': ['unknown123456'],
        'origin/main': [],
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/unknown-stall.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap({
            stalled: null,
            consecutiveReds: 0,
            fireStale: false,
            verdictStale: false,
            qualification: NO_QUALIFICATION,
          }),
      },
    );

    expect(res.gate.stalled).toBeNull();
    expect(res.verdictUnknown.map((entry) => entry.leg)).toContain('gate.stalled');
    expect(res.summary).toContain('STALL STATUS UNKNOWN');
  });

  it('EI-18719549079738452: 0 reds + not-fast-forwarded reads as a held gate, not a silent all-clear', async () => {
    // The torn-candidate incident this guards: green-checkpoint's retriage recognizes
    // a stale red and works to auto-refire, but while that plays out the LAST
    // *recorded* verdict can show 0 consecutive reds / stalled:false / fireStale:false
    // — every existing branch above falls through to '' — while `main` genuinely sits
    // behind the latest green pin (mainFastForwarded:false). The summary must say so
    // instead of reading as fully healthy.
    const git = fakeGit({
      pathCommit: 'torn1234567',
      contains: {
        HEAD: ['torn1234567'],
        'origin/staging': ['torn1234567'],
        'origin/main': [], // not promoted — main hasn't fast-forwarded
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/w.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap(
            {
              stalled: false,
              consecutiveReds: 0,
              fireStale: false,
              fireStaleReason: null,
              verdictStale: false,
              verdictStaleReason: null,
              verdictStaleReasonCode: null,
              candidateAgeMs: null,
              commitsBehindTip: null,
              observedCandidate: null,
              inconclusive: null,
              qualification: NO_QUALIFICATION,
            },
            'synced',
            {
              greenPinAtStagingHead: false,
            },
          ),
      },
    );
    expect(res.positions.inMain).toBe(false);
    expect(res.verdictProvenance.mainFastForwarded).toBe(false);
    expect(res.gate.consecutiveReds).toBe(0);
    expect(res.gate.stalled).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('0 reds');
    expect(res.summary).toContain('NOT fast-forwarded');
    // Must not be confused with the reds-based / wedge-based labels (this is neither).
    expect(res.summary).not.toContain('STALLED');
    expect(res.summary).not.toContain('WEDGED');
  });

  it('WI-6357 / EI-18790908999972569: the SAME buffer, freshly green, does NOT cry wolf — this is the reported symptom', async () => {
    // Ground truth from the live symptom: main == the green pin, gate reports 0 reds,
    // and a staging buffer exists (the NORMAL steady state — staging outruns the
    // ~hourly checkpoint). The old un-aged check fired on this near-universal
    // combination; it must now stay silent because the last green verdict is recent.
    const git = fakeGit({
      pathCommit: 'fresh1234567',
      contains: {
        HEAD: ['fresh1234567'],
        'origin/staging': ['fresh1234567'],
        'origin/main': [], // not promoted — un-checkpointed buffer, but a NORMAL one
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/w2.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap(
            {
              stalled: false,
              consecutiveReds: 0,
              fireStale: false,
              fireStaleReason: null,
              verdictStale: false,
              verdictStaleReason: null,
              verdictStaleReasonCode: null,
              candidateAgeMs: null,
              commitsBehindTip: null,
              observedCandidate: null,
              inconclusive: null,
              qualification: NO_QUALIFICATION,
              lastGreenAtMs: Date.now() - 5 * 60_000,
            },
            'synced',
            { greenPinAtStagingHead: false },
          ),
      },
    );
    expect(res.verdictProvenance.mainFastForwarded).toBe(false);
    expect(res.gate.consecutiveReds).toBe(0);
    // The false alarm must be GONE — this is exactly what taught readers to scroll
    // past the wording, per the bug's own report.
    expect(res.summary).not.toContain('NOT fast-forwarded');
    expect(res.summary).not.toContain('STALLED');
    expect(res.summary).not.toContain('WEDGED');
  });

  it('D-013: exact judged-SHA promotion stays green while staging is ahead after absorption', async () => {
    const judged = '1'.repeat(40);
    const mainPin = '2'.repeat(40);
    const stagingHead = '3'.repeat(40);
    const pathCommit = '4'.repeat(40);
    const git = fakeGit({
      pathCommit,
      contains: {
        HEAD: [pathCommit],
        'origin/staging': [pathCommit],
        'origin/main': [pathCommit],
        deployedsha0: [pathCommit],
        [mainPin]: [judged],
        [stagingHead]: [mainPin, judged],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/promoted.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap(
            {
              consecutiveReds: 0,
              observedCandidate: judged,
              lastMainPin: mainPin,
              verdictObservedAtMs: Date.now() - 1_000,
            },
            'synced',
            {
              stagingHead: { sha: stagingHead } as DevDeployState['stagingHead'],
              greenPinAtStagingHead: false,
            },
          ),
      },
    );

    expect(res.verdictProvenance.mainBehindStaging).toBe(true);
    expect(res.gate.ownerBrief?.answer).toBe('green');
    expect(res.gate.ownerBrief?.promotion).toMatchObject({
      judgedSha: judged,
      mainPin,
      mainContainsJudgedSha: true,
      staging: {
        headSha: stagingHead,
        bufferPresent: true,
        relation: 'ahead-after-absorption',
      },
    });
  });

  it('D-013: green-not-promoted follows exact ancestry even when no staging buffer exists', async () => {
    const judged = '5'.repeat(40);
    const mainPin = '6'.repeat(40);
    const pathCommit = '7'.repeat(40);
    const git = fakeGit({
      pathCommit,
      contains: {
        HEAD: [pathCommit],
        'origin/staging': [pathCommit],
        'origin/main': [pathCommit],
        deployedsha0: [pathCommit],
        [mainPin]: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/unpromoted.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap(
            {
              consecutiveReds: 0,
              observedCandidate: judged,
              lastMainPin: mainPin,
              verdictObservedAtMs: Date.now() - 1_000,
            },
            'synced',
            {
              greenPin: { sha: mainPin } as DevDeployState['greenPin'],
              stagingHead: { sha: mainPin } as DevDeployState['stagingHead'],
              greenPinAtStagingHead: true,
            },
          ),
      },
    );

    expect(res.verdictProvenance.mainBehindStaging).toBe(false);
    expect(res.gate.ownerBrief?.answer).toBe('green-not-promoted');
    expect(res.gate.ownerBrief?.promotion.mainContainsJudgedSha).toBe(false);
    expect(res.gate.ownerBrief?.promotion.staging.relation).toBe('equal');
  });

  it('a submodule path is detected, annotated, and resolved against the nested repo while staging uses the superproject gitlink', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'a1234567890',
      submoduleStagingPin: { pinnedSha: 'a1234567890', path: 'libs/papercusp' },
      contains: { HEAD: ['a1234567890'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/packages/harness/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.submodule).toBe('libs/papercusp');
    expect(res.positions.committedLocal).toBe(true);
    expect(res.positions.onStaging).toBe(true); // superproject origin/staging gitlink
    expect(res.positions.inMain).toBe(false); // not tracked for submodule paths
    expect(res.summary).toContain('submodule libs/papercusp');
    expect(res.notes.join(' ')).toMatch(/submodule/i);
  });

  it('reads dirty file status from the nested submodule repo', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'a1234567890',
      submoduleStagingPin: { pinnedSha: 'a1234567890', path: 'libs/papercusp' },
      dirty: true,
      dirtyRepo: '/repo/libs/papercusp',
      dirtyTree: ' M libs/db/src/raw-serializers.ts',
      contains: { HEAD: ['a1234567890'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/libs/db/src/raw-serializers.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.submodule).toBe('libs/papercusp');
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.sweepExposure.dirtyPathCount).toBe(1);
  });

  it('does not treat nested origin/HEAD as staging evidence when the superproject gitlink is behind', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'a1234567890',
      submoduleStagingPin: { pinnedSha: 'b1234567890', path: 'libs/papercusp' },
      contains: { HEAD: ['a1234567890'], 'origin/HEAD': ['a1234567890'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/packages/harness/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.positions.onStaging).toBe(false);
    expect(res.positionsUnknown).not.toContain('onStaging');
    expect(res.positions.inMain).toBe(false); // non-release leg: not measured for submodules
    expect(res.positions.deployed).toBe(false); // non-release leg: not measured for submodules
    expect(res.notes.join(' ')).toMatch(/gitlink/);
  });

  it('keeps a failed superproject gitlink read unknown instead of reporting a staging miss', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'a1234567890',
      failSubmoduleStagingPin: true,
      contains: { HEAD: ['a1234567890'], 'origin/HEAD': ['a1234567890'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/packages/harness/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.positions.onStaging).toBe(false);
    expect(res.positionsUnknown).toContain('onStaging');
    expect(res.notes.join(' ')).toMatch(/unknown/);
  });

  /**
   * EI-18715870370005934 — the SUBMODULE-BOUNDARY false negative.
   *
   * The bug is not that a check is hard; it is that the wrong check returns a
   * confident, safe-sounding EMPTY. `git show <superSha>:<submodulePath>` and
   * `git status --porcelain <submodulePath>` both yield nothing across the
   * boundary, which reads as "my change is absent" / "the tree is clean" instead
   * of "you asked the superproject about content it does not store". A near-miss
   * on that reading nearly aborted a good ~30min decisive gate run.
   *
   * The whole point of the guard is that the naive form and the resolver must
   * DISAGREE — so these assert the disagreement directly.
   */
  describe('superproject sha + submodule path (EI-18715870370005934)', () => {
    const SUPER = 'super8b339f8780aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const PINNED = '151cfdb3357a4ae03d34e8a32b89b8355656c356';
    const pinGit = () =>
      fakeGit({
        submodules: ['papercusp-desktop'],
        submodulePin: { superSha: SUPER, pinnedSha: PINNED, path: 'papercusp-desktop' },
        submoduleStagingPin: { pinnedSha: PINNED, path: 'papercusp-desktop' },
        contains: { HEAD: [PINNED] },
      });

    it('resolves the gitlink instead of reporting the sha as absent', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/lib/scenarios/b3-revocation.sh', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      // THE REGRESSION: before the fix this was null + "did not resolve" — a bare
      // absence, from the tool agents are pointed at for "is my edit live".
      expect(res.targetSha).toBe(PINNED);
      expect(res.submodulePin).toEqual({ superprojectSha: SUPER, submoduleSha: PINNED });
      expect(res.notes.join(' ')).not.toMatch(/did not resolve/);
      expect(res.positions.committedLocal).toBe(true);
    });

    it('never substitutes one sha for another silently — the summary names both', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.summary).toContain(SUPER.slice(0, 9));
      expect(res.summary).toContain(PINNED.slice(0, 9));
      expect(res.summary).toMatch(/PINS/);
      // The note must redirect the reader off the hand-rolled form.
      expect(res.notes.join(' ')).toMatch(/git -C papercusp-desktop show/);
    });

    it('the naive cross-boundary probe DISAGREES with the resolver (the whole point)', async () => {
      const git = pinGit();
      // Naive: what an agent hand-composes. Empty — indistinguishable from absent.
      const naiveShow = await git('/repo', ['show', `${SUPER}:papercusp-desktop/bin/vm-federation.sh`]);
      const naiveStatus = await git('/repo', ['ls-tree', SUPER, 'papercusp-desktop/bin/vm-federation.sh']);
      expect(naiveShow).toBeNull();
      expect(naiveStatus).toBeNull(); // a FILE path, not the submodule root — no gitlink

      // The PRE-FIX code path, asserted explicitly so this stays a real guard: the
      // only thing the old implementation did was rev-parse the sha INSIDE the
      // submodule, and that returns null for a superproject sha. So without the
      // gitlink resolution `targetSha` is necessarily null — i.e. reverting the fix
      // makes the expectations below fail, rather than passing for another reason.
      expect(await git('/repo/papercusp-desktop', ['rev-parse', '--verify', `${SUPER}^{commit}`])).toBeNull();

      // Resolver: the same question, asked correctly.
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: SUPER },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.targetSha).toBe(PINNED);
      expect(res.targetSha).not.toBe(naiveShow);
    });

    it('a sha that genuinely does not resolve still reports absent (no false pin)', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // rev-parse succeeds for any non-superproject sha in the fake, so the guard
      // that matters here is that NO pin was fabricated for an unrelated sha.
      expect(res.submodulePin).toBeNull();
    });

    it('a superproject sha with a NON-submodule path is untouched by the resolver', async () => {
      const res = await gitPipelinePosition(
        { path: 'packages/operator-core/lib/x.ts', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.submodule).toBeNull();
      expect(res.submodulePin).toBeNull();
      expect(res.targetSha).toBe(SUPER);
    });
  });

  it('a newly-created uncommitted file reports no commit + the dirty flag', async () => {
    const git = fakeGit({ pathCommit: null, dirty: true });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/new.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.targetSha).toBeNull();
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.summary).toContain('no commit found');
  });

  // EI-24049239243821100: dev:pipeline_position told an author their uncommitted fix
  // was live. The call ran on :3170, whose integration root is the clean
  // papercusp-staging mirror, and two further defects let a dirty path read live on
  // every port. Each case below fails on the pre-fix resolver.
  describe('EI-24049239243821100: a dirty path is never reported live', () => {
    const PATH = 'packages/operator-core/lib/agent-tools/work_items/untouched-paths.ts';
    const OLDER = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';
    // The path's PREVIOUS commit has gone all the way out: committed, pushed, promoted,
    // deployed. Only the edit on disk is new.
    const shippedOlderCommit = {
      pathCommit: OLDER,
      contains: {
        HEAD: [OLDER],
        'origin/staging': [OLDER],
        'origin/main': [OLDER],
        deployedsha0: [OLDER],
      },
      remoteStagingTip: OLDER,
      remoteMainTip: OLDER,
    };
    const loaders = { loadDeploy: async () => deploy(), loadSnapshot: async () => snap() };

    it('an edited file whose previous commit is deployed assesses uncommitted, not live', async () => {
      const res = await gitPipelinePosition(
        { path: PATH },
        { git: fakeGit({ ...shippedOlderCommit, dirty: true }), ...loaders },
      );
      expect(res.dirtyUncommitted).toBe(true);
      expect(res.positions).toEqual({ committedLocal: true, onStaging: true, inMain: true, deployed: true });
      expect(res.assessments.pipelinePosition).toBe('uncommitted');
      expect(res.stages.find((s) => s.name === 'committed')?.position).toBe('pending');
    });

    it('a FAILED git status is unknown, never clean', async () => {
      const base = fakeGit(shippedOlderCommit);
      const git: GitRunner = async (repo, args) => (args[0] === 'status' ? null : base(repo, args));
      const res = await gitPipelinePosition({ path: PATH }, { git, ...loaders });
      expect(res.positionsUnknown).toContain('workingTree');
      expect(res.assessments.pipelinePosition).toBeNull();
      const committed = res.stages.find((s) => s.name === 'committed');
      expect(committed?.position).toBe('pending');
      expect(committed?.health).toBe('unknown');
      expect(res.notes.some((n) => /working-tree status .* UNKNOWN/.test(n))).toBe(true);
    });

    it('reads the working tree from the EDIT tree, not the serving mirror', async () => {
      const base = fakeGit(shippedOlderCommit);
      const statusRepos: string[] = [];
      // The mirror is clean; the edit tree carries the uncommitted change — exactly the
      // two checkouts :3170 sees.
      const git: GitRunner = async (repo, args) => {
        if (args[0] === 'status') {
          statusRepos.push(repo);
          return repo === '/edit-tree' ? ` M ${PATH}` : '';
        }
        return base(repo, args);
      };
      const res = await gitPipelinePosition(
        { path: PATH },
        {
          git,
          loadDeploy: async () => deploy({ integrationRoot: '/serving-mirror' }),
          loadSnapshot: async () => snap(),
          resolveEditTreeRoot: () => '/edit-tree',
        },
      );
      expect(statusRepos.length).toBeGreaterThan(0);
      expect(new Set(statusRepos)).toEqual(new Set(['/edit-tree']));
      expect(res.repoRoot).toBe('/edit-tree');
      expect(res.dirtyUncommitted).toBe(true);
      expect(res.assessments.pipelinePosition).toBe('uncommitted');
    });

    it('the default edit-tree resolution honors PAPERCUSP_CANONICAL_TREE from the process env', async () => {
      vi.stubEnv('PAPERCUSP_CANONICAL_TREE', '/edit-tree');
      try {
        const statusRepos: string[] = [];
        const base = fakeGit(shippedOlderCommit);
        const git: GitRunner = async (repo, args) => {
          if (args[0] === 'status') statusRepos.push(repo);
          return base(repo, args);
        };
        const res = await gitPipelinePosition(
          { path: PATH },
          { git, loadDeploy: async () => deploy({ integrationRoot: '/serving-mirror' }), loadSnapshot: async () => snap() },
        );
        expect(new Set(statusRepos)).toEqual(new Set(['/edit-tree']));
        expect(res.notes.some((n) => n.includes('canonical edit tree /edit-tree'))).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('resolveEditTreeRoot: a declared edit tree wins; unset or blank keeps the integration root', () => {
      expect(resolveEditTreeRoot('/serving-mirror', { PAPERCUSP_CANONICAL_TREE: '/edit-tree' })).toBe('/edit-tree');
      expect(resolveEditTreeRoot('/serving-mirror', {})).toBe('/serving-mirror');
      expect(resolveEditTreeRoot('/serving-mirror', { PAPERCUSP_CANONICAL_TREE: '   ' })).toBe('/serving-mirror');
    });
  });

  // EI-7846: verdict-provenance — the last green sha/age, main-FF status, and
  // whether the live deploy actually came from the gate-green pin.
  it('EI-7846: deployedSha === ready.sha reports deployOrigin gate-green (the normal auto-deploy path)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': ['abc1234567'] },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy({ deployed: { sha: 'readysha0' } as DevDeployState['deployed'] }),
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: true, deployedBehindGreenPin: 0 }),
      },
    );
    expect(res.verdictProvenance.lastGreenSha).toBe('readysha0');
    expect(res.verdictProvenance.lastGreenShortSha).toBe('readysha');
    expect(res.verdictProvenance.lastGreenAgeMs).toBeGreaterThanOrEqual(0);
    expect(res.verdictProvenance.mainFastForwarded).toBe(true);
    expect(res.verdictProvenance.deployedBehindGreenPin).toBe(0);
    expect(res.verdictProvenance.deployOrigin).toBe('gate-green');
  });

  it('EI-7846: a deployed sha that IS an ancestor of ready reports stale-behind-gate (safe lag)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        readysha0: ['deployedsha0'], // ready's history contains the deployed sha
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(), // deployed.sha = 'deployedsha0' (fixture default)
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: true, deployedBehindGreenPin: 2 }),
      },
    );
    expect(res.verdictProvenance.deployOrigin).toBe('stale-behind-gate');
    expect(res.verdictProvenance.deployedBehindGreenPin).toBe(2);
  });

  it('EI-7846: a deployed sha NOT reachable from ready reports ahead-of-gate (force-deployed past the gate)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        // readysha0's history does NOT contain deployedsha0 — force-deployed ahead.
        readysha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: false }),
      },
    );
    expect(res.verdictProvenance.deployOrigin).toBe('ahead-of-gate');
    expect(res.verdictProvenance.mainFastForwarded).toBe(false);
  });

  it('EI-7846: no ready pin (fresh workspace, never green yet) reports unknown provenance, not a throw', async () => {
    const git = fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({}, 'synced', { greenPin: null }),
      },
    );
    expect(res.verdictProvenance.lastGreenSha).toBeNull();
    expect(res.verdictProvenance.lastGreenAgeMs).toBeNull();
    expect(res.verdictProvenance.deployOrigin).toBe('unknown');
  });

  it('summarizePosition is pure over the resolved facts', () => {
    const base: Omit<PipelinePosition, 'summary'> = {
      input: { path: 'a.ts', sha: null },
      // WI-9974 made this REQUIRED. `[]` is the semantically correct value for a
      // summarizePosition fixture, not a compiler-silencer: these describe the
      // pure formatter over already-resolved facts and probe no hosts at all.
      runtimeGenerations: [],
      servingRuntimes: [],
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      assessments: {
        pipelinePosition: 'awaiting-deploy',
        gateVerdict: 'passing-current',
        gateCandidate: 'no-active-run',
        gateOwnership: null,
        deployedSha: 'executing',
        mainBehindStaging: 'caught-up',
      },
      positionsUnknown: [],
      // WI-6646 made these REQUIRED on PipelinePosition. Both values are semantically
      // correct here rather than compiler-silencers: this fixture names no `marker`, so
      // there is no per-leg marker verdict to report, and no leg is a newer-commit artifact.
      positionsMarker: null,
      positionsNewerCommit: [],
      verdictUnknown: [],
      deployedSha: 'deployedsha0',
      gate: {
        stalled: false,
        consecutiveReds: 0,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'stale-behind-gate',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving: HEALTHY_SERVING,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
    };
    expect(summarizePosition(base)).toContain('deployed ✗');
    expect(summarizePosition(base)).not.toContain('(live)');
  });
});

/* ------------------------------------------------------------------------- *
 * EI-10895 — the RUNTIME-OWNER map.
 *
 * The bug being fixed: this tool reported `deployed ✗` + "sleep on the deploy:
 * deploy:await" for code that the release pipeline DOES NOT CARRY. The gateway,
 * bg-host and embed-sidecar all run staging-tree code with no deploy hop (the
 * gateway via tsx; the other two via a bundle their unit rebuilds at every start),
 * so a deploy is a no-op for them and a RESTART is the only activation. An agent that
 * follows the old advice waits forever for an event that lands and changes
 * nothing (this cost an hour on WI-4541, a gateway admission fix).
 * ------------------------------------------------------------------------- */
describe('runtime-owner map (EI-10895)', () => {
  const gatewayPath = 'packages/operator-core/lib/inference-gateway/gateway-priority-tiers.ts';

  it.each([
    [gatewayPath, 'gateway', 'gateway'],
    ['apps/operator/bin/embed-sidecar.ts', 'embed-sidecar', 'embed-sidecar'],
    ['packages/operator-core/lib/dbos/routines-tick.ts', 'bg-host', 'bg-host'],
  ])('%s → runs in %s, and a DEPLOY is not its activation path', (p, host, restartTarget) => {
    const own = classifyRuntimeOwner(p)!;
    expect(own.host).toBe(host);
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBe(restartTarget);
    expect(own.activation).toMatch(/dev:restart/);
    expect(own.activation).toMatch(/authorize: true/);
    expect(own.activation).toMatch(/reason: "<why>"/);
  });

  /* ---------------------------------------------------------------------- *
   * EI-11120: `system:<action>` routine handlers (git-sync, scout-cycle,
   * blueprint-run, ...) and the routinesTick dispatch machinery itself only
   * execute when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host) — :3070/:3170 boot
   * request-only and never run this code. Before this fix these paths fell
   * through to the generic `packages/operator-core/lib` shared-caveat case,
   * which only ever HINTED "restart one of those hosts" instead of naming the
   * one true host — a landed+gated+deployed routine fix could look live and
   * silently not be (WI-4475's scout timeout-hierarchy fix).
   * ---------------------------------------------------------------------- */
  it.each([
    'packages/operator-core/lib/harness/routines/register-system-actions.ts',
    'packages/operator-core/lib/harness/routines/system-actions.ts',
    'packages/operator-core/lib/harness/routines/routine-host.ts',
    'packages/operator-core/lib/harness/routines/improvement-actions.ts',
    'packages/operator-core/lib/blueprint/blueprint-run-action.ts',
    'packages/operator-core/lib/scout/scout-cycle-action.ts',
    'packages/operator-core/lib/scout/cycle.ts',
    'packages/operator-core/lib/harness/git-sync/git-sync-action.ts',
    'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
    'packages/operator-core/lib/harness/git-sync/git-sync-eligibility.ts',
  ])('EI-11120: %s → runs in bg-host only (routinesTick, BACKGROUND_WORKERS=1) — a deploy never carries it', (p) => {
    const own = classifyRuntimeOwner(p)!;
    expect(own.host).toBe('bg-host');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBe('bg-host');
    expect(own.activation).toMatch(/dev:restart.*bg-host/s);
  });

  it('EI-22090053297465523: fleet-control-reconcile.ts is a bg-host dependency of the fleet transition system action', () => {
    const own = classifyRuntimeOwner(
      'packages/operator-core/lib/harness/routines/fleet-control-reconcile.ts',
    )!;
    expect(own.host).toBe('bg-host');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBe('bg-host');
    expect(own.activation).toMatch(/dev:restart.*bg-host/s);
  });

  it('EI-11120: a *-action.ts TEST file under harness/routines/ is NOT misclassified (only the handler itself is bg-host-exclusive)', () => {
    // improvement-actions.test.ts ends in `.test.ts`, not `-action.ts` — must not match.
    const own = classifyRuntimeOwner('packages/operator-core/lib/harness/routines/improvement-actions.test.ts')!;
    expect(own.host).toBe('operator-release');
    expect(own.releasePipelineApplies).toBe(true);
  });

  it('EI-11120: other lib/blueprint/ files (used interactively by the operator API — catalog/authoring) stay release-pipeline-carried', () => {
    const own = classifyRuntimeOwner('packages/operator-core/lib/blueprint/installed-blueprints.ts')!;
    expect(own.host).toBe('operator-release');
    expect(own.releasePipelineApplies).toBe(true);
  });

  it.each([
    ['packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts'],
    ['packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts'],
    ['packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts'],
  ])(
    'WI-4996: %s is the BG-HOST supervisor that spawns its sidecar — NOT the sidecar itself, despite living under a sidecar-named directory',
    (p) => {
      const own = classifyRuntimeOwner(p)!;
      expect(own.host).toBe('bg-host');
      expect(own.releasePipelineApplies).toBe(false);
      expect(own.restartTarget).toBe('bg-host');
      // The activation text must not steer an agent toward restarting the
      // (wrong, more disruptive) sidecar it supervises.
      expect(own.activation).toMatch(/dev:restart.*bg-host/s);
      expect(own.activation).not.toMatch(/target: "gateway"/);
    },
  );

  it('WI-4996: a non-spawn file under inference-gateway/ still classifies as the gateway host (no over-correction)', () => {
    const own = classifyRuntimeOwner(gatewayPath)!;
    expect(own.host).toBe('gateway');
    expect(own.restartTarget).toBe('gateway');
  });

  it('the Tauri shell is carried by NEITHER a deploy nor a dev:restart — it is compiled', () => {
    const own = classifyRuntimeOwner('papercusp-desktop/src-tauri/src/main.rs')!;
    expect(own.host).toBe('tauri-desktop');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBeNull();
  });

  /* ---------------------------------------------------------------------- *
   * EI-19323821719374642 / EI-21175951870654462: green-checkpoint.ts has zero non-test
   * importers and is always fresh-launched from the STAGING integration tree: scheduled runs
   * are child processes from release-actions.ts, while manual runs use a detached systemd unit.
   * Absent a dedicated entry this fell through to DEFAULT_OWNER
   * (operator-release, releasePipelineApplies:true) — telling an agent to wait on a :3070
   * deploy for code a deploy can never carry, and it produced a false "gate deadlock" during a
   * live incident.
   * ---------------------------------------------------------------------- */
  it('EI-21175951870654462: green-checkpoint.ts is a fresh staging-tree CLI with no restart lever', () => {
    const own = classifyRuntimeOwner('apps/operator/lib/release/green-checkpoint.ts')!;
    expect(own.host).toBe('bg-host');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBeNull();
    expect(own.activation).toMatch(/fresh CLI process/i);
    expect(own.activation).toMatch(/staging/i);
    expect(own.activation).not.toMatch(/dev:restart/);
    // Must name BOTH triggers — the cron routine AND the manual tool — since either can fire it
    // and both land on the same staging-tree spawn.
    expect(own.activation).toMatch(/system:green-checkpoint/);
    expect(own.activation).toMatch(/release:checkpoint-run/);
  });

  it('EI-21175951870654462: the full pipeline read does not prescribe a bg-host restart', async () => {
    const path = 'apps/operator/lib/release/green-checkpoint.ts';
    const git = fakeGit({
      pathCommit: 'fresh12345',
      contains: { HEAD: ['fresh12345'], 'origin/staging': ['fresh12345'] },
    });
    const res = await gitPipelinePosition(
      { path },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
      },
    );

    expect(res.runtime?.restartTarget).toBeNull();
    expect(res.serving).toMatchObject({ unit: null, startedSinceCodeChange: true, restartLever: null });
    expect(res.blockedOn).toBeNull();
    expect(res.nextAction).toBeNull();
    expect(res.summary).toMatch(/fresh-invocation route/i);
    expect(res.summary).not.toMatch(/dev:restart/);
  });

  it('ordinary operator code still reads as release-pipeline-carried (no false positives)', () => {
    for (const p of ['apps/operator/app/page.tsx', 'packages/operator-core/lib/agent-tools/dev/why.ts']) {
      const own = classifyRuntimeOwner(p)!;
      expect(own.host).toBe('operator-release');
      expect(own.releasePipelineApplies).toBe(true);
    }
  });

  it('a sha-only probe cannot be classified (returns null, keeping the default reading)', () => {
    expect(classifyRuntimeOwner(null)).toBeNull();
    expect(classifyRuntimeOwner(undefined)).toBeNull();
  });

  it('WI-4541 repro — a gateway path summary leads with the RESTART, never "deployed ✗"', async () => {
    const git = fakeGit({
      pathCommit: 'gate123456',
      subject: 'work-conserving tier admission',
      // Fully committed + on staging, but NOT in main and NOT deployed — the exact
      // state that made the old tool say "not live yet, sleep on the deploy".
      contains: { HEAD: ['gate123456'], 'origin/staging': ['gate123456'] },
    });
    const res = await gitPipelinePosition(
      { path: gatewayPath },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.positions.deployed).toBe(false); // the raw fact is unchanged…
    expect(res.runtime?.host).toBe('gateway'); // …but it is no longer the HEADLINE.
    expect(res.runtime?.releasePipelineApplies).toBe(false);

    // FALSIFICATION: on the old code this summary was
    //   "… committed ✓ · staging ✓ · main ✗ · deployed ✗."
    // and the tool attached { awaitable: deploy:await }. Both were wrong.
    expect(res.summary).toContain('dev:restart');
    expect(res.summary).toContain('gateway');
    expect(res.summary).not.toContain('deployed ✗');
    expect(res.summary).not.toContain('main ✗');
  });

  it('an uncommitted gateway edit is ALREADY what the host will load — the summary says so', async () => {
    const git = fakeGit({ dirty: true, pathCommit: 'gate123456', contains: { HEAD: ['gate123456'] } });
    const res = await gitPipelinePosition(
      { path: gatewayPath },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.summary).toMatch(/uncommitted edit is what it loads on restart/i);
  });

  it('shared operator-core/libs code carries the staging-host caveat (a deploy may not be your lever)', async () => {
    const git = fakeGit({ pathCommit: 'aaa1111111', contains: { HEAD: ['aaa1111111'] } });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp-shared/src/resilience/priority-admission.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    // Still release-carried (the operator loads it too) — so we do NOT reclassify…
    expect(res.runtime?.releasePipelineApplies).toBe(true);
    // …but the agent is told the gateway/bg-host also run it from THIS tree.
    expect(res.notes.some((n) => /gateway|bg-host/.test(n) && /dev:restart/.test(n))).toBe(true);
  });

  it('an app path gets NO staging-host caveat (it is operator-only — keep the note honest)', async () => {
    const git = fakeGit({ pathCommit: 'bbb2222222', contains: { HEAD: ['bbb2222222'] } });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.tsx' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.notes.some((n) => /dev:restart/.test(n))).toBe(false);
  });

  /* ------------------------------------------------------------------------- *
   * WI-5440 — a path with TWO real consumers on DIFFERENT activation routes.
   * `success-metrics.ts` is read by both the scout ideation cycle (bg-host,
   * routinesTick) AND buildProgramSuccessReport (the `blender:success-metrics`
   * MCP tool, served by the release-checkout operator). Collapsing to one
   * routed a live activation decision the wrong way during the 0.0.11-alpha
   * release watch — this must never again answer with a single owner.
   * ------------------------------------------------------------------------- */
  describe('multi-consumer paths (WI-5440)', () => {
    const successMetricsPath = 'packages/operator-core/lib/scout/success-metrics.ts';

    it('classifyRuntimeOwners returns BOTH consumers, in order', () => {
      const owners = classifyRuntimeOwners(successMetricsPath)!;
      expect(owners).toHaveLength(2);
      expect(owners[0].host).toBe('bg-host');
      expect(owners[0].releasePipelineApplies).toBe(false);
      expect(owners[1].host).toBe('operator-release');
      expect(owners[1].releasePipelineApplies).toBe(true);
    });

    it('the legacy singular classifyRuntimeOwner still returns ONE answer (back-compat), never throws', () => {
      const own = classifyRuntimeOwner(successMetricsPath)!;
      expect(own.host).toBe('bg-host');
    });

    it('a sibling scout/ file with only one real consumer still classifies single-owner (no over-correction)', () => {
      const owners = classifyRuntimeOwners('packages/operator-core/lib/scout/cycle.ts')!;
      expect(owners).toHaveLength(1);
      expect(owners[0].host).toBe('bg-host');
    });

    it('EI-21863351526928940: packages/backup/** classifies as dual-consumer (bg-host DBOS scheduled workflows AND operator-release MCP tools/HTTP routes), never bg-host-only', () => {
      const backupHookPath = 'packages/backup/src/hook.ts';
      const owners = classifyRuntimeOwners(backupHookPath)!;
      expect(owners).toHaveLength(2);
      expect(owners[0].host).toBe('bg-host');
      expect(owners[0].releasePipelineApplies).toBe(false);
      expect(owners[0].restartTarget).toBe('bg-host');
      expect(owners[1].host).toBe('operator-release');
      expect(owners[1].releasePipelineApplies).toBe(true);
      expect(owners[1].restartTarget).toBe('staging');
      // Legacy singular still returns bg-host first (back-compat), never throws.
      expect(classifyRuntimeOwner(backupHookPath)!.host).toBe('bg-host');
    });

    it('EI-21863351526928940: gitPipelinePosition no longer reports blockedOn:"gate" / releasePipelineApplies:true-only for a packages/backup path — surfaces BOTH consumers', async () => {
      const git = fakeGit({ pathCommit: 'bk0000001', contains: { HEAD: ['bk0000001'] } });
      const res = await gitPipelinePosition(
        { path: 'packages/backup/src/hook.ts' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.runtimes).toHaveLength(2);
      expect(res.runtimes?.map((r) => r.host)).toEqual(['bg-host', 'operator-release']);
      expect(res.runtime?.host).toBe('bg-host');
      expect(res.summary).toContain('MULTIPLE CONSUMERS');
      expect(res.summary).toContain('bg-host');
      expect(res.summary).toContain('operator-release');
    });

    it('gitPipelinePosition surfaces `runtimes` (plural) and flags the split in notes + summary', async () => {
      const git = fakeGit({ pathCommit: 'sm0000001', contains: { HEAD: ['sm0000001'] } });
      const res = await gitPipelinePosition(
        { path: successMetricsPath },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.runtimes).toHaveLength(2);
      expect(res.runtimes?.map((r) => r.host)).toEqual(['bg-host', 'operator-release']);
      // back-compat single `runtime` is still the first owner, never dropped
      expect(res.runtime?.host).toBe('bg-host');
      expect(res.notes.some((n) => /distinct consumers/.test(n))).toBe(true);
      expect(res.summary).toContain('MULTIPLE CONSUMERS');
      expect(res.summary).toContain('bg-host');
      expect(res.summary).toContain('operator-release');
    });
  });
});

/**
 * git-pipeline-agent-state-2026-07-26 P-001 — the stage table.
 *
 * These assert the BEHAVIOURS that caused real filed incidents, not the shape of
 * the object. Each case names the incident it encodes so a future edit that
 * flattens health back into a boolean fails with the reason attached.
 */
describe('computeStages: position x health', () => {
  type StageInput = Parameters<typeof computeStages>[0];

  const input = (over: Partial<StageInput> = {}): StageInput => ({
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    gate: {
      stalled: false,
      consecutiveReds: 0,
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
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
    },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    serving: HEALTHY_SERVING,
    changeInCandidate: NO_CANDIDATE,
    sweepExposure: NO_SWEEP,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    ...over,
  });

  const stage = (stages: StageState[], name: StageName): StageState => {
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s;
  };

  it('EI-18752644493166307: an UNCOMMITTED edit is not "committed" even when the path is committed', () => {
    // The exact misread that fired the gate twice against candidates lacking the fix:
    // positions.committedLocal means "this PATH exists at a commit", which reads as
    // "my change is committed". The stage table must answer about the CHANGE.
    const s = computeStages(input({ dirtyUncommitted: true }));
    expect(stage(s, 'committed').position).toBe('pending');
    expect(stage(s, 'committed').health).toBe('stalled');
    // and it must say WHY, naming the gate's committed-candidate semantics
    expect(stage(s, 'committed').detail).toMatch(/COMMITTED candidate/);
    expect(stage(s, 'committed').detail).toMatch(/git-sync:run/);
  });

  it('a clean committed path reads past/advancing with no noise', () => {
    const s = computeStages(input());
    expect(stage(s, 'committed')).toMatchObject({ position: 'past', health: 'advancing', detail: null });
  });

  // WI-10006493 (residue of EI-25203408414398603): while git-sync's migration dependency fence
  // deferred unrelated dirty paths, this surface said "BLOCKED AT COMMITTED -> git-sync:run".
  // A forced sync defers the same path again, so the lever sent agents round a loop. When the
  // last pass recorded the queried path as deferred, the stage must name the blocker and owner.
  describe('WI-10006493: a path the last git-sync pass deferred is not unblocked by git-sync:run', () => {
    const fenced = {
      scope: 'superproject',
      path: 'packages/operator-core/lib/schema-consumer.ts',
      reason: 'migration-dependency-fence' as const,
      detail:
        'deferred because this path shares work-item attribution with a reservation-blocked migration at ' +
        'libs/papercusp/libs/db/sql/1234-unreserved.sql',
      blockingMigrations: ['libs/papercusp/libs/db/sql/1234-unreserved.sql'],
      blockingAgents: ['su-migration-author'],
      blockingWorkItems: ['WI-777'],
    };
    const deferred = (skippedPaths: StageInput['gitSync']['skippedPaths'], path: string) =>
      input({
        dirtyUncommitted: true,
        input: { path },
        gitSync: { ...HEALTHY_GIT_SYNC, syncAgeMs: 120_000, skippedPaths },
      });

    it('names the fence, the blocking migration, its author and work-item, and never advertises git-sync:run', () => {
      const s = computeStages(deferred([fenced], fenced.path));
      const committed = stage(s, 'committed');
      expect(committed).toMatchObject({ position: 'pending', health: 'stalled' });
      expect(committed.detail).toMatch(/migration dependency fence/);
      expect(committed.detail).toContain('libs/papercusp/libs/db/sql/1234-unreserved.sql');
      expect(committed.detail).toContain('su-migration-author');
      expect(committed.detail).toContain('WI-777');
      expect(committed.lever).toContain('libs/papercusp/libs/db/sql/1234-unreserved.sql');
      expect(committed.lever).not.toMatch(/git-sync:run/);

      const { blockedOn, nextAction } = deriveBlocker(s);
      expect(blockedOn).toBe('committed');
      expect(nextAction).not.toMatch(/git-sync:run/);
      expect(nextAction).toContain('su-migration-author');
    });

    it('matches a submodule-scoped reservation deferral against the superproject-relative path', () => {
      const reservation = {
        scope: 'libs/papercusp',
        path: 'libs/db/sql/1234-unreserved.sql',
        reason: 'migration-reservation' as const,
        detail: 'no reservation row for 1234',
      };
      const s = computeStages(deferred([reservation], 'libs/papercusp/libs/db/sql/1234-unreserved.sql'));
      const committed = stage(s, 'committed');
      expect(committed.detail).toContain('no reservation row for 1234');
      expect(committed.lever).toMatch(/next-migration\.mjs/);
      expect(committed.lever).not.toMatch(/git-sync:run/);
    });

    it('names the lock holder when a live edit lock deferred the path', () => {
      const lock = { scope: 'superproject', path: 'apps/operator/lib/x.ts', owner: 'su-holder', intent: 'refactor x' };
      const s = computeStages(deferred([lock], 'apps/operator/lib/x.ts'));
      const committed = stage(s, 'committed');
      expect(committed.detail).toContain('su-holder');
      expect(committed.detail).toContain('refactor x');
      expect(committed.lever).not.toMatch(/git-sync:run/);
    });

    it('keeps git-sync:run as the lever when the deferral is for a DIFFERENT path', () => {
      // Control: the match is per path. A fence elsewhere in the tree must not hide the real lever.
      const s = computeStages(deferred([fenced], 'packages/operator-core/lib/unrelated.ts'));
      expect(stage(s, 'committed').lever).toMatch(/^git-sync:run/);
      expect(deriveBlocker(s).nextAction).toMatch(/^git-sync:run/);
    });

    it('ignores a recorded deferral once the path is no longer dirty', () => {
      const s = computeStages(input({ input: { path: fenced.path }, gitSync: { ...HEALTHY_GIT_SYNC, skippedPaths: [fenced] } }));
      expect(stage(s, 'committed')).toMatchObject({ position: 'past', detail: null, lever: null });
    });
  });

  describe('EI-25225672179870571: a content-quarantined path needs its finding fixed', () => {
    const path = 'docs/evidence/reboot-residue-live-probes-2026-10-06/r001-live-probe-rubric-rev15.txt';
    const contentError = { path, detector: 'identity-leak' };

    it('names the content finding and never recommends repeating git-sync while it remains', () => {
      const s = computeStages(
        input({
          dirtyUncommitted: true,
          input: { path },
          gitSync: { ...HEALTHY_GIT_SYNC, contentErrors: [contentError] },
        }),
      );
      const committed = stage(s, 'committed');
      expect(committed).toMatchObject({ position: 'pending', health: 'stalled' });
      expect(committed.detail).toMatch(/identity-leak/);
      expect(committed.detail).not.toMatch(/git-sync:run/);
      expect(committed.lever).toMatch(/identity-leak/);
      expect(committed.lever).not.toMatch(/git-sync:run/);

      const { blockedOn, nextAction } = deriveBlocker(s);
      expect(blockedOn).toBe('committed');
      expect(nextAction).toMatch(/identity-leak/);
      expect(nextAction).not.toMatch(/git-sync:run/);
    });

    it('keeps the normal sync lever for a different path and ignores a clean quarantined path', () => {
      const unrelated = computeStages(
        input({
          dirtyUncommitted: true,
          input: { path: 'docs/other.txt' },
          gitSync: { ...HEALTHY_GIT_SYNC, contentErrors: [contentError] },
        }),
      );
      expect(stage(unrelated, 'committed').lever).toMatch(/^git-sync:run/);

      const clean = computeStages(input({ input: { path }, gitSync: { ...HEALTHY_GIT_SYNC, contentErrors: [contentError] } }));
      expect(stage(clean, 'committed')).toMatchObject({ position: 'past', detail: null, lever: null });
    });
  });

  it('EI-21175951870654462: a fresh-invocation route is past serving with no restart blocker', () => {
    const runtime = classifyRuntimeOwner('apps/operator/lib/release/green-checkpoint.ts')!;
    const serving = evaluateServing({
      runtime,
      process: { pid: 99, startedAtMs: 1 },
      codeAsOfMs: 2,
      codeAsOfSource: 'file-mtime',
    });
    const stages = computeStages(input({ runtime, serving }));
    expect(stage(stages, 'serving')).toMatchObject({ position: 'past', health: 'advancing', lever: null });
    expect(stage(stages, 'serving').detail).toMatch(/fresh-invocation CLI/i);
    expect(deriveBlocker(stages)).toMatchObject({ blockedOn: null, nextAction: null });
  });

  describe('EI-21302702663327936 / EI-21271731610759140: emitted restart guidance carries the enablement gate', () => {
    // The miss: `naDetail` recommended the literal call `dev:restart { target: "…",
    // confirm: true }` — a shape the live gate REFUSES (restart_withheld: a real
    // restart also needs authorize:true + a reason). Agents copied it verbatim and
    // the repeated-tool-error watchdog fired (structural:call-with-target-…-and-confirm,
    // two independent filings in one day). The `activation` (owners map) and
    // `activationLever` legs were already normalized through withRestartAuthorization
    // (2026-08-12); the na-stage detail was the third, missed emission path.
    it('never emits the bare { confirm: true } shape the gate refuses', () => {
      const runtime = classifyRuntimeOwner('packages/operator-core/lib/dbos/routines-workflow.ts')!;
      const s = computeStages(input({ runtime }));
      const texts = s.map((x) => `${x.detail ?? ''} ${x.lever ?? ''}`);
      const recommending = texts.filter((t) => t.includes('dev:restart {'));
      // The na stages for a bg-host path must exist and carry the recommendation —
      // an empty set here means the fixture stopped exercising the emission path,
      // which would make this guard vacuous.
      expect(recommending.length).toBeGreaterThan(0);
      for (const t of recommending) {
        expect(t).not.toMatch(/dev:restart \{[^}]*confirm: true \}/);
        expect(t).toMatch(/authorize: true/);
      }
    });
  });

  const unpushed = { committedLocal: true, onStaging: false, inMain: false, deployed: false };

  it('EI-18753105351266788: "synced" with NOTHING pushed says so explicitly', () => {
    // The trap: status 'synced' is reachable with pushedRepos empty, and the old
    // surface forwarded only that word. The caller must be told the tick pushed
    // nothing rather than left to infer "reached origin" from "synced".
    const s = computeStages(input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, pushedRepos: [] } }));
    expect(stage(s, 'pushed').position).toBe('pending');
    expect(stage(s, 'pushed').detail).toMatch(/does NOT mean pushed/);
    expect(stage(s, 'pushed').detail).toMatch(/pushed NOTHING/);
  });

  describe('EI-18812945811758018: a COMMIT-ONLY member never pushes, by design', () => {
    // The miss this guards: on a bridged hive git-sync is commit-only (the GitHub bridge
    // is the sole origin pusher), so `pushedRepos: []` is CORRECT. The surface reported
    // it as `advancing` and prescribed `git-sync:run` — a lever that cannot move origin
    // here. An agent followed it, the forced run pushed nothing (as designed), and that
    // was read as confirmation of a push bug and filed CRITICAL. The premise was wrong.
    const commitOnly = { ...HEALTHY_GIT_SYNC, pushedRepos: [], pushMode: 'commit-only:bridged' };

    it('reads `disabled`, NOT `advancing` — this leg is never going to move here', () => {
      const s = computeStages(input({ positions: unpushed, gitSync: commitOnly }));
      expect(stage(s, 'pushed').health).toBe('disabled');
    });

    it('NEVER prescribes git-sync:run as the push lever (the whole bug)', () => {
      const s = computeStages(input({ positions: unpushed, gitSync: commitOnly }));
      expect(stage(s, 'pushed').lever).toBeNull();
    });

    it('names the design AND the real (p2p publish) lever instead of "pushed NOTHING"', () => {
      const s = computeStages(input({ positions: unpushed, gitSync: commitOnly }));
      const detail = stage(s, 'pushed').detail ?? '';
      expect(detail).toMatch(/COMMIT-ONLY/);
      expect(detail).toMatch(/bridged/);
      expect(detail).toMatch(/p2p publish/);
      // Must NOT reuse the push-fault wording that caused the misdiagnosis.
      expect(detail).not.toMatch(/does NOT mean pushed/);
    });

    describe('EI-19341723994516667: "greening the gate" was DISPROVED as the blanket lever', () => {
      // WI-6996 measured staging 29 commits AHEAD of the green pin while origin sat
      // frozen for ~6h — publish admission (publish-guard.ts) is a CONTENT check
      // (oversized blobs / secrets), never a release-gate check, so a message that
      // defaults to "green the gate" sends the reader to a lever that cannot move
      // this leg. The default (no own_head_publish signal) message must not claim
      // greening the gate is THE lever, and a real publish-leg fault must be named
      // instead of buried behind it.

      it('with no own_head_publish signal, never claims greening the gate is the lever', () => {
        const s = computeStages(input({ positions: unpushed, gitSync: commitOnly }));
        const detail = stage(s, 'pushed').detail ?? '';
        expect(detail).not.toMatch(/GREENING THE GATE/);
        expect(detail).toMatch(/NOT gated by the release\/green-checkpoint gate/);
        expect(stage(s, 'pushed').lever).toBeNull();
      });

      it('a REFUSED p2p publish leg is `broken`, names the refusal, and points at own_head_publish — not the gate', () => {
        const refused = {
          ...commitOnly,
          ownHeadPublish: { refused: 'secrets', backlogRemains: null, publishedSha: null, sha: null },
        };
        const s = computeStages(input({ positions: unpushed, gitSync: refused }));
        expect(stage(s, 'pushed').health).toBe('broken');
        const detail = stage(s, 'pushed').detail ?? '';
        expect(detail).toMatch(/REFUSING to publish \(secrets\)/);
        expect(detail).toMatch(/NOT the green gate/);
        expect(detail).not.toMatch(/GREENING THE GATE/);
        expect(stage(s, 'pushed').lever).toMatch(/own_head_publish/);
        expect(stage(s, 'pushed').lever).toMatch(/NOT the green gate/);
      });

      it('an admitted-but-UNDRAINED backlog is `stalled`, names the backlog, and points at own_head_publish — not the gate', () => {
        const backlogged = {
          ...commitOnly,
          ownHeadPublish: {
            refused: null,
            backlogRemains: true,
            publishedSha: 'abcdef1234567890',
            sha: 'fedcba0987654321',
          },
        };
        const s = computeStages(input({ positions: unpushed, gitSync: backlogged }));
        expect(stage(s, 'pushed').health).toBe('stalled');
        const detail = stage(s, 'pushed').detail ?? '';
        expect(detail).toMatch(/UNDRAINED BACKLOG/);
        expect(detail).toMatch(/abcdef12/);
        expect(detail).toMatch(/fedcba09/);
        expect(detail).not.toMatch(/GREENING THE GATE/);
        expect(stage(s, 'pushed').lever).toMatch(/own_head_publish/);
        expect(stage(s, 'pushed').lever).toMatch(/NOT the green gate/);
      });

      it('a fully-drained publish leg (backlogRemains: false) stays `disabled` with no fault framing', () => {
        const drained = {
          ...commitOnly,
          ownHeadPublish: { refused: null, backlogRemains: false, publishedSha: 'a', sha: 'a' },
        };
        const s = computeStages(input({ positions: unpushed, gitSync: drained }));
        expect(stage(s, 'pushed').health).toBe('disabled');
        expect(stage(s, 'pushed').lever).toBeNull();
      });
    });

    it('a REAL fault still outranks commit-only — conflicts/errors stay loud', () => {
      // Teeth: commit-only must not become a blanket excuse that swallows genuine
      // faults on the commit/fetch/merge half, which a commit-only member still has.
      const conflicted = computeStages(
        input({ positions: unpushed, gitSync: { ...commitOnly, conflicts: ['libs/papercusp'] } }),
      );
      expect(stage(conflicted, 'pushed').health).toBe('broken');
      const erroring = computeStages(
        input({ positions: unpushed, gitSync: { ...commitOnly, consecutiveErrorTicks: 3 } }),
      );
      expect(stage(erroring, 'pushed').health).toBe('broken');
    });

    it('an UNKNOWN pushMode (older routine rows) is NOT treated as commit-only', () => {
      // Absent evidence must not silently suppress a real push fault — a pre-record row
      // has to keep the original "synced but pushed NOTHING" warning.
      const s = computeStages(
        input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, pushedRepos: [], pushMode: null } }),
      );
      expect(stage(s, 'pushed').health).not.toBe('disabled');
      expect(stage(s, 'pushed').detail).toMatch(/does NOT mean pushed/);
    });
  });

  it('EI-18750935999066024: a FAULTING push leg is `broken`, not "not yet"', () => {
    // The 2h52m / 19-stranded-commit freeze. Commits kept landing locally, so every
    // position boolean looked plausible; only the leg's own health distinguishes
    // "waiting will fix this" from "waiting is futile".
    const s = computeStages(
      input({
        positions: unpushed,
        gitSync: { ...HEALTHY_GIT_SYNC, consecutiveErrorTicks: 4, errors: ['push failed: permission denied'] },
      }),
    );
    expect(stage(s, 'pushed').health).toBe('broken');
    expect(stage(s, 'pushed').detail).toMatch(/FAULTING/);
    expect(stage(s, 'pushed').detail).toMatch(/waiting will not clear this/i);
  });

  it('a git-sync tick far past its interval is `stalled`, with the age named', () => {
    const s = computeStages(input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, syncAgeMs: 172 * 60_000 } }));
    expect(stage(s, 'pushed').health).toBe('stalled');
    expect(stage(s, 'pushed').detail).toMatch(/172 min ago/);
    expect(stage(s, 'pushed').detail).toMatch(/not simply "not yet"/);
  });

  it('merge conflicts block origin and name the resolver, not a retry', () => {
    const s = computeStages(
      input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, conflicts: ['apps/operator/x.tsx'] } }),
    );
    expect(stage(s, 'pushed').health).toBe('broken');
    expect(stage(s, 'pushed').detail).toMatch(/merge-resolver/);
  });

  it('a healthy pushed change is past/advancing with no noise', () => {
    const s = computeStages(input());
    expect(stage(s, 'pushed')).toMatchObject({ position: 'past', health: 'advancing', detail: null });
  });

  it('EI-11120: stages off the release route are `na`, never "pending" — waiting would never end', () => {
    // A bg-host path is not carried by staging->main->:3070 at all. Reporting those
    // stages as pending told an agent to wait for something that could not happen.
    const bg = classifyRuntimeOwner('packages/operator-core/lib/harness/git-sync/git-sync-action.ts');
    expect(bg?.releasePipelineApplies).toBe(false);
    const s = computeStages(input({ runtime: bg }));
    for (const name of ['gate', 'main', 'deployed'] as StageName[]) {
      expect(stage(s, name).position).toBe('na');
      expect(stage(s, name).health).toBe('disabled');
      expect(stage(s, name).detail).toMatch(/dev:restart/);
    }
  });

  it('WI-282: a non-firing gate is `broken` and says waiting will not help', () => {
    const s = computeStages(
      input({
        gate: {
          stalled: false,
          consecutiveReds: 0,
          lastGreenAtMs: 1,
          fireStale: true,
          fireStaleReason: 'paused',
          verdictStale: false,
          verdictObservedAtMs: null,
          verdictStaleReason: null,
          verdictStaleReasonCode: null,
          candidateAgeMs: null,
          commitsBehindTip: null,
          observedCandidate: null,
          inconclusive: null,
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
      }),
    );
    expect(stage(s, 'gate').health).toBe('broken');
    expect(stage(s, 'gate').detail).toMatch(/Waiting will not help/i);
    expect(stage(s, 'gate').detail).toMatch(/paused/);
  });

  it('EI-21271222700908558: a deliberate pause outranks a stale repair-staging-mismatch abort', () => {
    const s = computeStages(
      input({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        gate: {
          ...input().gate,
          fireStale: true,
          fireStaleReason: 'green-checkpoint is deliberately PAUSED (active:false)',
          pause: {
            reason: 'hold while the repaired staging checkout is verified',
            pausedBy: 'su-release-owner',
            pausedAtMs: 1_786_780_000_000,
            // P-004: null = no auto-resume scheduled (this fixture's pause predates TTL stamping).
            expiresAtMs: null,
          },
          inconclusive: {
            status: 'repair-staging-mismatch',
            candidate: 'repair-candidate-sha',
            detail: 'repair patch is not on staging',
            observedAtMs: 1_786_780_000_000,
          },
        },
      }),
    );
    const gate = stage(s, 'gate');
    expect(gate).toMatchObject({ position: 'pending', health: 'broken', lever: null });
    expect(gate.detail).toMatch(/DELIBERATELY PAUSED/);
    expect(gate.detail).toMatch(/repaired staging checkout is verified/);
    expect(gate.detail).not.toMatch(/repair-staging-mismatch/);
    expect(gate.detail).not.toMatch(/clear the gate abort condition/);
    expect(deriveBlocker(s)).toMatchObject({ blockedOn: 'gate', nextAction: null, actionOwner: null });
  });

  it('keeps a firing-but-verdict-stale gate separate from a non-firing gate', () => {
    const s = computeStages(
      input({
        gate: {
          stalled: false,
          consecutiveReds: 0,
          lastGreenAtMs: 1,
          fireStale: false,
          fireStaleReason: null,
          verdictStale: true,
          verdictObservedAtMs: null,
          verdictStaleReason: 'no GREEN verdict in ~13h',
          verdictStaleReasonCode: null,
          candidateAgeMs: null,
          commitsBehindTip: null,
          observedCandidate: null,
          inconclusive: null,
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
      }),
    );
    expect(stage(s, 'gate')).toMatchObject({ health: 'advancing', detail: null });
  });

  it('a red gate is `stalled` and framed as yours to fix, not a queue to wait in', () => {
    const s = computeStages(
      input({
        gate: {
          stalled: true,
          consecutiveReds: 3,
          failingTests: ['lib/current-red.test.ts'],
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
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
      }),
    );
    expect(stage(s, 'gate').health).toBe('stalled');
    expect(stage(s, 'gate').detail).toMatch(/RED \(3 consecutive\)/);
  });

  describe('EI-19326284032085138: gate health carries a PROGRESS term', () => {
    const failingFile = (path: string, fixInRepairHead: boolean | null): GateCandidateFailingFile => ({
      path,
      attempts: 1,
      status: 'fail',
      fixInRepairHead,
      comparison: `git rev-parse <candidate>:${path} vs <repairHead>:${path}`,
      candidateBlob: 'a'.repeat(40),
      repairHeadBlob: fixInRepairHead === null ? null : fixInRepairHead ? 'b'.repeat(40) : 'a'.repeat(40),
      atRepairHead: null,
      reading: 'fixture row',
    });

    const failures = (over: Partial<GateCandidateFailures> = {}): GateCandidateFailures => ({
      candidateSha: 'c'.repeat(40),
      repairHeadSha: 'd'.repeat(40),
      filesJudged: 12,
      distinctFailingFiles: [],
      failingFileCount: 0,
      alreadyFixedCount: 0,
      passedAtRepairHeadCount: 0,
      stillBrokenCount: 0,
      stillBrokenNeedsRunCount: 0,
      changedBetweenRefs: null,
      // P-003 replaced the `postSuiteMeasured` tri-state with a two-value reading derived
      // from whether a leg measurement exists at all. `not-recorded` is the fixture value
      // that matches the UNMEASURED `nonTestLegs` below — and the pair is the point: no
      // measurement recorded is NOT "no legs failing".
      nonTestLegsMeasured: 'not-recorded',
      // WI-2143253 added `nonTestLegs` as a REQUIRED field; C2 of EI-22270968007901491 made
      // it NEVER null (a null subtree dropped the cell's declared evidence paths and the
      // assessment downgraded to `unavailable`). `unmeasuredNonTestLegs()` IS the production
      // default: no per-leg measurement exists yet for this repair queue, which is exactly
      // the state these progress-term fixtures model. The three helpers below (converging /
      // outstanding / outstandingUnconfirmed) all delegate here, so this one site is the
      // whole fix.
      nonTestLegs: unmeasuredNonTestLegs(),
      scope: 'fixture scope sentence',
      unavailable: null,
      truncated: false,
      assessment: 'none-failing',
      ...over,
    });

    /** Every failing file's fix already landed in repairHead — the tree IS converging. */
    const converging = (over: Partial<GateCandidateFailures> = {}): GateCandidateFailures =>
      failures({
        distinctFailingFiles: [failingFile('lib/a.test.ts', true), failingFile('lib/b.test.ts', true)],
        failingFileCount: 2,
        alreadyFixedCount: 2,
        stillBrokenCount: 0,
        assessment: 'all-fixes-contained',
        ...over,
      });

    /**
     * One file still broken at repairHead — real repair work remains, CONFIRMED:
     * `stillBrokenNeedsRunCount: 0` means nothing else moved between the two refs, so
     * there is nowhere a fix could be hiding and the strong wording is earned.
     */
    const outstanding = (): GateCandidateFailures =>
      failures({
        distinctFailingFiles: [failingFile('lib/a.test.ts', true), failingFile('lib/b.test.ts', false)],
        failingFileCount: 2,
        alreadyFixedCount: 1,
        stillBrokenCount: 1,
        stillBrokenNeedsRunCount: 0,
        changedBetweenRefs: { count: 0, sample: [] },
        assessment: 'repairs-outstanding',
      });

    /**
     * The same counts, but the still-broken row is only PRESUMED so: other files moved
     * between the refs, so the fix may ride a non-test carrier the test exercises. The
     * brief must not tell an agent to go fix this one without running it first — that
     * misreading cost three re-fixes of already-repaired files on 2026-09-02.
     */
    const outstandingUnconfirmed = (): GateCandidateFailures =>
      failures({
        distinctFailingFiles: [failingFile('lib/a.test.ts', true), failingFile('lib/b.test.ts', false)],
        failingFileCount: 2,
        alreadyFixedCount: 1,
        stillBrokenCount: 1,
        stillBrokenNeedsRunCount: 1,
        changedBetweenRefs: { count: 1, sample: ['scripts/pc-heavy-jobs.mjs'] },
        assessment: 'repairs-outstanding',
      });

    const redGate = (candidateFailures: GateCandidateFailures | null): StageInput =>
      input({
        gate: {
          stalled: true,
          consecutiveReds: 7,
          failingTests: ['lib/a.test.ts', 'lib/b.test.ts'],
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
          candidateFailures,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
      });

    // ── The discriminator, BOTH directions. Either half alone is satisfiable by a
    //    constant function, which is exactly the weak guard this item warned about.
    it('SHRINKING: a red streak whose failing set is fully repaired reads advancing, not stalled', () => {
      const gate = stage(computeStages(redGate(converging())), 'gate');
      expect(gate.health).toBe('advancing');
      expect(gate.detail).toMatch(/CONVERGING, not wedged/);
      expect(gate.detail).toMatch(/awaiting re-verification/);
      // The claim NAMES ITS OWN SUBJECT — a peer measured the sibling `inconclusive` block
      // serving a verdict about a state that had already changed, precisely because the
      // load-bearing field did not say what it was about.
      expect(gate.detail).toMatch(/Measured live against candidate cccccccccccc → repairHead dddddddddddd/);
      // An advancing gate must not also hand out a "go fix it" lever.
      expect(gate.lever).toBeNull();
    });

    it('NOT SHRINKING: a red streak with repairs still outstanding STAYS stalled', () => {
      const gate = stage(computeStages(redGate(outstanding())), 'gate');
      expect(gate.health).toBe('stalled');
      expect(gate.detail).toMatch(/RED \(7 consecutive\)/);
      expect(gate.detail).toMatch(/1 of 2 failing file\(s\) have an UNCHANGED blob at repairHead/);
      expect(gate.detail).not.toMatch(/CONVERGING/);
      // Nothing else moved, so this really is confirmed work — no hedge should appear.
      expect(gate.detail).not.toMatch(/UNCONFIRMED/);
    });

    it('UNCONFIRMED: a still-broken row whose fix may ride a non-test file demands a run, not a re-fix', () => {
      // The 2026-09-02 failure, at the surface that actually reaches agents. An unchanged
      // TEST blob is not proof the file is unfixed — the repair commonly lands in the code
      // UNDER test (a script it invokes, a helper, a whole-repo scanner), which this
      // comparison cannot see. Asserting "still broken" there manufactures labour: all
      // three files the cell named that day were already fixed and passed at repairHead.
      const gate = stage(computeStages(redGate(outstandingUnconfirmed())), 'gate');
      expect(gate.health).toBe('stalled');
      expect(gate.detail).toMatch(/1 of those are UNCONFIRMED/);
      expect(gate.detail).toMatch(/Run that ONE file at repairHead before treating it as work/);
      // It must still not read as converging — hedging is not good news.
      expect(gate.detail).not.toMatch(/CONVERGING/);
    });

    it('CALIBRATION: candidateFailures:null reproduces the pre-change verdict exactly', () => {
      const gate = stage(computeStages(redGate(null)), 'gate');
      expect(gate.health).toBe('stalled');
      expect(gate.detail).toMatch(/RED \(7 consecutive\)/);
      expect(gate.detail).not.toMatch(/CONVERGING/);
    });

    // ── Absence must never be able to produce the good news.
    it.each([
      ['unavailable — the other fields are explicitly not evidence', converging({ unavailable: 'no frozen candidate' })],
      ['truncated — "all fixed" only covers the capped sample', converging({ truncated: true })],
      ['none-failing — the red is in a leg this cell cannot see', failures()],
      ['unmeasured — rows exist but nothing could be compared', converging({ assessment: 'unmeasured' })],
    ])('degrades to today\'s stalled verdict when the progress data is %s', (_why, cf) => {
      expect(stage(computeStages(redGate(cf)), 'gate').health).toBe('stalled');
    });

    it('P-007: a red NON-TEST leg is OUTSTANDING work, and the stalled detail names the LEG rather than "0 of 0 files"', () => {
      const cf = failures({
        assessment: 'non-test-leg-failing',
        nonTestLegsMeasured: 'measured',
        nonTestLegs: { outstanding: ['lint:tsc'] } as unknown as GateCandidateFailures['nonTestLegs'],
      });
      expect(gateCandidateProgress(cf)).toBe('outstanding');
      const gate = stage(computeStages(redGate(cf)), 'gate');
      expect(gate.health).toBe('stalled');
      expect(gate.detail).toMatch(/non-test leg\(s\) lint:tsc are RED/);
      expect(gate.detail).not.toMatch(/0 of 0 failing file/);
      expect(gate.detail).not.toMatch(/CONVERGING/);
    });

    it('pause and fireStale still OUTRANK a converging candidate', () => {
      const paused = redGate(converging());
      expect(
        stage(computeStages({ ...paused, gate: { ...paused.gate, fireStale: true, fireStaleReason: 'unit not firing' } }), 'gate')
          .health,
      ).toBe('broken');
    });

    describe('gateCandidateProgress — pure classifier', () => {
      it('classifies each reading', () => {
        expect(gateCandidateProgress(converging())).toBe('converging');
        expect(gateCandidateProgress(outstanding())).toBe('outstanding');
        expect(gateCandidateProgress(null)).toBe('unknown');
        expect(gateCandidateProgress(converging({ truncated: true }))).toBe('unknown');
        expect(gateCandidateProgress(converging({ unavailable: 'read failed' }))).toBe('unknown');
        expect(gateCandidateProgress(failures())).toBe('unknown');
      });

      // PERMANENT wrong-implementation controls (never mutate the shared tree to prove a
      // guard can fail — repo rule "Proving a guard is falsifiable"). Each is a plausible
      // way to write this classifier; the assertions below show the real one is not either.
      const naive = (cf: GateCandidateFailures | null): GateProgressReading =>
        cf && cf.alreadyFixedCount > 0 ? 'converging' : 'unknown';
      const neverConverges = (_cf: GateCandidateFailures | null): GateProgressReading => 'unknown';

      it('CONTROL: a classifier keying on alreadyFixedCount alone misreads the wedged + truncated cases', () => {
        // The naive one calls real repair work "converging" — the false all-clear.
        expect(naive(outstanding())).toBe('converging');
        expect(gateCandidateProgress(outstanding())).toBe('outstanding');
        // ...and trusts a bounded sample as a total.
        expect(naive(converging({ truncated: true }))).toBe('converging');
        expect(gateCandidateProgress(converging({ truncated: true }))).toBe('unknown');
      });

      it('CONTROL: a classifier that never converges passes every safety case but fails the calibration', () => {
        // It satisfies every degradation case above — which is why those alone are not a guard.
        expect(neverConverges(converging({ truncated: true }))).toBe('unknown');
        // The calibration case is what separates it from the real subject.
        expect(neverConverges(converging())).toBe('unknown');
        expect(gateCandidateProgress(converging())).toBe('converging');
      });
    });
  });

  it('EI-21337656680788367: a red counter with zero failing tests routes to materialisation, not test triage', () => {
    const s = computeStages(
      input({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        gate: {
          ...input().gate,
          stalled: true,
          consecutiveReds: 39,
          failingTests: [],
        },
      }),
    );
    const gate = stage(s, 'gate');
    expect(gate.health).toBe('stalled');
    expect(gate.detail).toMatch(/zero failing tests/i);
    expect(gate.detail).toMatch(/materialisation blocker/i);
    expect(gate.lever).toMatch(/materialisation blocker/i);
    expect(gate.lever).not.toMatch(/fix the reds/i);
    expect(deriveBlocker(s)).toMatchObject({
      blockedOn: 'gate',
      nextAction: expect.stringMatching(/materialisation blocker/i),
      actionOwner: 'gate',
    });
  });

  /**
   * EI-19405864032365760 — the READ side. This is the surface that actually misled the fleet:
   * a preflight abort is not counted as a red (correctly), so the counters stay frozen on the
   * PREVIOUS verdict and this stage kept rendering it as the current blocker. Measured
   * 2026-08-03: ~2.5h of agents being told "the reds are yours to fix" and chasing test files
   * that had nothing to do with a pending migration.
   */
  const abortedGate = (consecutiveReds: number) => ({
    stalled: consecutiveReds > 0,
    consecutiveReds,
    lastGreenAtMs: 1,
    fireStale: false,
    fireStaleReason: null,
    verdictStale: false,
    verdictObservedAtMs: null,
    verdictStaleReason: null,
    verdictStaleReasonCode: null,
    candidateAgeMs: null,
    commitsBehindTip: null,
    observedCandidate: 'oldcandidat',
    inconclusive: {
      status: 'migrations-pending',
      candidate: 'deadbeefcafe',
      detail:
        'migration preflight ABORTED this run — 1 migration(s) are pending. Pending: 727-widen-vectors.sql: null value',
      observedAtMs: 1,
    },
    candidateFailures: null,
    ownerBrief: null, qualification: NO_QUALIFICATION,
  });

  it('⭐ EI-19405864032365760: an ABORTED gate reports the abort, not the stale red streak', () => {
    const s = computeStages(input({ gate: abortedGate(3) }));
    const detail = stage(s, 'gate').detail ?? '';
    // Leads with the truth: no verdict was rendered, and re-firing aborts identically.
    expect(detail).toMatch(/ABORTED before judging/i);
    expect(detail).toMatch(/migrations-pending/);
    // Names the blocking migration — the ONLY path from "main is stuck" to a fixable cause.
    expect(detail).toMatch(/727-widen-vectors\.sql/);
    // Explicitly disowns the frozen counters instead of presenting them as current.
    expect(detail).toMatch(/PREVIOUS verdict, not this one/i);
    expect(detail).not.toMatch(/The reds are yours to fix/i);
  });

  it('⭐ EI-19405864032365760: the lever routes to the migration, never to another checkpoint run', () => {
    // `inMain: false` is load-bearing: the gate only offers a lever while it is still HOLDING
    // your change back. Once it is in main the stage is 'past' and a null lever is correct.
    const lever =
      stage(
        computeStages(
          input({
            gate: abortedGate(3),
            positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
          }),
        ),
        'gate',
      ).lever ?? '';
    expect(lever).toMatch(/db:migrate/);
    // The pre-fix levers are both actively wrong here: a re-fire aborts at the same preflight,
    // and the named failing tests are not what is holding the pipeline.
    expect(lever).not.toMatch(/release:checkpoint-run/);
    expect(lever).not.toMatch(/fix the reds/i);
  });

  it('⭐ EI-19405864032365760: an abort with no prior red streak omits the counter caveat', () => {
    // Nothing stale to disown — the caveat must not appear and invent a red that never existed.
    const detail = stage(computeStages(input({ gate: abortedGate(0) })), 'gate').detail ?? '';
    expect(detail).toMatch(/ABORTED before judging/i);
    expect(detail).not.toMatch(/PREVIOUS verdict/i);
  });

  /**
   * ⭐ WI-1752145 — the abort's OWN vintage reaches the SUMMARY sentence, not just a sub-object.
   *
   * The defect: `gate_health.inconclusive` is LATCHED. release-actions.ts writes it through a
   * scoped `jsonb_set` on the `{gate_health,inconclusive}` path, which deliberately does NOT
   * advance the top-level `observedAt` — so every other age on the payload (including
   * `readAttestation.snapshotAgeMs`) describes the VERDICT, and the abort silently ages beside
   * it. Measured on live rows 2026-08-31: +4s skew on one install, +5.7 DAYS on two others.
   *
   * The incident: an abort observed 11:23:52Z naming `migrations-pending` on migration 1044 was
   * still served ~1h after 1044 APPLIED (11:27:20Z), and was repeated downstream as fact. The
   * vintage was in the payload the whole time — nothing rendered it where the claim was read.
   *
   * Both directions are asserted here. Without the fresh case this guard passes vacuously: a
   * projection that warns on EVERY read would satisfy the stale assertion alone.
   */
  const abortObservedAt = (observedAtMs: number) => ({
    ...abortedGate(0),
    inconclusive: { ...abortedGate(0).inconclusive, observedAtMs },
  });

  it('⭐ WI-1752145: a STALE abort surfaces its age and a latched-record warning on the gate detail', () => {
    const now = Date.parse('2026-08-31T15:00:00.000Z');
    const detail =
      stage(
        computeStages(input({ gate: abortObservedAt(now - 3 * 60 * 60_000) }), null, now),
        'gate',
      ).detail ?? '';
    expect(detail).toMatch(/ABORTED before judging/i);
    // The vintage itself, on the sentence a reader acts on.
    expect(detail).toContain('observed 3h ago');
    // And the escalation that says the claim may no longer describe now.
    expect(detail).toContain('LATCHED');
  });

  it('⭐ WI-1752145: a FRESH abort states its age but is NOT decorated with a staleness marker', () => {
    const now = Date.parse('2026-08-31T15:00:00.000Z');
    const detail =
      stage(computeStages(input({ gate: abortObservedAt(now - 4_000) }), null, now), 'gate').detail ?? '';
    expect(detail).toMatch(/ABORTED before judging/i);
    expect(detail).toContain('Abort observed 4s ago');
    // The control. A caveat printed on every read is one a reader stops seeing, so the
    // marker must stay silent here — otherwise the assertion above proves nothing.
    expect(detail).not.toContain('LATCHED');
  });

  it('⭐ WI-1752145: an UNSTAMPED abort is disclosed as unknown vintage, never as fresh', () => {
    const now = Date.parse('2026-08-31T15:00:00.000Z');
    const gate = abortedGate(0);
    const unstamped = {
      ...gate,
      inconclusive: { ...gate.inconclusive, observedAtMs: null as number | null },
    };
    const detail = stage(computeStages(input({ gate: unstamped }), null, now), 'gate').detail ?? '';
    expect(detail).toMatch(/ABORTED before judging/i);
    // A blob predating the stamp must not read as current — silence here is the failure.
    expect(detail).toContain('NO observation timestamp');
    expect(detail).not.toMatch(/abort observed/);
  });

  it('EI-214333: a safely retireable queue owns the gate detail and exact next action', () => {
    const nextAction =
      "release:repair-queue { op: 'retire', expectedCandidate: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }";
    const s = computeStages(
      input({
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        gate: {
          ...abortedGate(3),
          inconclusive: {
            status: 'repair-in-progress',
            candidate: 'a'.repeat(40),
            detail: 'historical repair hold',
            observedAtMs: 1,
          },
          repairQueue: {
            phase: 'awaiting-fixer',
            candidate: 'a'.repeat(40),
            repairHead: 'b'.repeat(40),
            attempts: 1,
            openedAtMs: 1,
            updatedAtMs: 2,
            ageMs: 60_000,
            ageEscalationRung: 0,
            repairLatency: frozenRepairLatency({ openedAtMs: 1, phase: 'awaiting-fixer' }, 60_001),
            ageEscalationIntervalMs: 8 * 60 * 60_000,
            zeroAttemptStalled: false,
            zeroAttemptStallMs: 15 * 60_000,
            fixerSpawnId: 'dead-fixer',
            fixerAlive: false,
            legs: [],
            signature: [],
            admissions: [],
            blockedReason: null,
            dispatchReservation: null,
            // This fixture supplies no shared-tree edit set, so the collision probe is
            // explicitly UNMEASURED rather than a false all-clear (measured:false ≠ zero paths).
            manifest: null,
            manifestSummary: null,
            sharedTreeCollision: {
              measured: false,
              repairInFlight: false,
              collidingPaths: [],
              collisionCount: 0,
              truncated: false,
              detail: null,
            },
            decision: 'recover-dead-fixer',
            retireAllowed: true,
            retireRefusal: null,
            nextAction,
          },
        },
      }),
    );
    expect(stage(s, 'gate').detail).toMatch(/Frozen repair queue|not live|recover-dead-fixer/);
    expect(stage(s, 'gate').lever).toBe(nextAction);
  });

  it('EI-7846: a force-deployed sha is `broken` — "deployed" must not imply "tested"', () => {
    const s = computeStages(
      input({
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: true,
          deployedBehindGreenPin: 0,
          deployOrigin: 'ahead-of-gate',
        },
      }),
    );
    expect(stage(s, 'deployed').health).toBe('broken');
    expect(stage(s, 'deployed').detail).toMatch(/does not mean "tested"/);
  });

  it('the 4x-filed class: `serving` is NEVER advancing from git state alone', () => {
    // EI-18740960754854672 + 3 duplicates: `deployed ✓` was read as "live" while the
    // process served older code. Git state can never justify claiming a process is
    // serving something. P-003 supplies that truth from a process probe — and this
    // asserts the OTHER half of the same rule: when the probe cannot answer, the
    // stage degrades to `unknown`, never back to `advancing`. Every stage around it
    // is fully green here, so only a git-derived inference could turn this green.
    const noProcessEvidence = evaluateServing({
      runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
      process: null,
      codeAsOfMs: Date.now(),
      codeAsOfSource: 'deploy',
    });
    const s = computeStages(input({ serving: noProcessEvidence }));
    expect(stage(s, 'deployed').position).toBe('past');
    expect(stage(s, 'serving').health).toBe('unknown');
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').detail).toMatch(/not the same as "live"/);
  });

  it('is pure: no git calls, and stages are ordered source->live', () => {
    const names = computeStages(input()).map((s) => s.name);
    expect(names).toEqual(['committed', 'pushed', 'gate', 'main', 'deployed', 'serving']);
  });

  /**
   * WI-6357 / EI-18790908999972569 — `mainFastForwarded === false` (a nonzero
   * staging→main buffer) is the fleet's NORMAL steady state, not a stall. The old
   * `'main'` stage read `stalled` on its mere existence, crying wolf on virtually
   * every healthy call (EI-11012 reincarnated under a new field name) and burying
   * the ONE real signal — the gate's own health, or a buffer whose age has
   * genuinely outlived the pipeline's cadence.
   */
  describe('WI-6357: the `main` stage no longer conflates a NORMAL buffer with a stall', () => {
    it('a nonzero buffer with a RECENT green verdict reads advancing, not stalled — the reported symptom', () => {
      const s = computeStages(
        input({
          gate: {
            stalled: false,
            consecutiveReds: 0,
            lastGreenAtMs: Date.now() - 5 * 60_000,
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
            candidateFailures: null,
            ownerBrief: null, qualification: NO_QUALIFICATION,
          },
          verdictProvenance: {
            lastGreenSha: 'g',
            lastGreenShortSha: 'g',
            lastGreenAgeMs: 1,
            mainFastForwarded: false,
            deployedBehindGreenPin: 0,
            deployOrigin: 'gate-green',
          },
        }),
      );
      expect(stage(s, 'main').health).toBe('advancing');
      expect(stage(s, 'main').detail).toMatch(/normal, not a stall/);
    });

    it('a buffer whose last green verdict is OLDER than MAIN_BUFFER_STALL_MS reads stalled', () => {
      const s = computeStages(
        input({
          gate: {
            stalled: false,
            consecutiveReds: 0,
            lastGreenAtMs: Date.now() - (MAIN_BUFFER_STALL_MS + 60_000),
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
            candidateFailures: null,
            ownerBrief: null, qualification: NO_QUALIFICATION,
          },
          verdictProvenance: {
            lastGreenSha: 'g',
            lastGreenShortSha: 'g',
            lastGreenAgeMs: 1,
            mainFastForwarded: false,
            deployedBehindGreenPin: 0,
            deployOrigin: 'gate-green',
          },
        }),
      );
      expect(stage(s, 'main').health).toBe('stalled');
      expect(stage(s, 'main').detail).toMatch(/EI-18719549079738452/);
    });

    it('a RED or WEDGED gate still marks `main` stalled regardless of buffer age — the gate is what actually blocks it', () => {
      const redGate = computeStages(
        input({
          gate: {
            stalled: true,
            consecutiveReds: 3,
            lastGreenAtMs: Date.now(),
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
            candidateFailures: null,
            ownerBrief: null, qualification: NO_QUALIFICATION,
          },
          verdictProvenance: {
            lastGreenSha: 'g',
            lastGreenShortSha: 'g',
            lastGreenAgeMs: 1,
            mainFastForwarded: false,
            deployedBehindGreenPin: 0,
            deployOrigin: 'gate-green',
          },
        }),
      );
      expect(stage(redGate, 'main').health).toBe('stalled');
      expect(stage(redGate, 'main').detail).toMatch(/see the gate stage above/);
    });

    it('WI-38367: a recent green that did NOT consume the backlog reads stalled — and says so in the gate-is-running language, not the wedged-gate one', () => {
      const s = computeStages(
        input({
          gate: {
            stalled: false,
            consecutiveReds: 0,
            lastGreenAtMs: Date.now() - 60_000, // greened one minute ago
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
            candidateFailures: null,
            ownerBrief: null, qualification: NO_QUALIFICATION,
          },
          verdictProvenance: {
            lastGreenSha: 'g',
            lastGreenShortSha: 'g',
            lastGreenAgeMs: 1,
            mainFastForwarded: false,
            // ...while the oldest un-promoted commit is 9h old: the advance moved the
            // tip end of the buffer, not this backlog.
            stagingBufferAgeMs: 9 * 60 * 60 * 1000,
            deployedBehindGreenPin: 0,
            deployOrigin: 'gate-green',
          },
        }),
      );
      expect(stage(s, 'main').health).toBe('stalled');
      expect(stage(s, 'main').detail).toMatch(/9\.0h old/);
      expect(stage(s, 'main').detail).toMatch(/Do NOT read this as a wedged gate/);
      // It must NOT reach for the no-green sentence — that one sends the reader to go
      // un-wedge a gate that is running fine.
      expect(stage(s, 'main').detail).not.toMatch(/no NEW green verdict/);
      expect(stage(s, 'main').detail).not.toMatch(/normal, not a stall/);
    });

    it('no buffer at all (mainFastForwarded: true) is unconditionally advancing with no detail, however old lastGreenAtMs is', () => {
      const s = computeStages(
        input({
          gate: {
            stalled: false,
            consecutiveReds: 0,
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
            candidateFailures: null,
            ownerBrief: null, qualification: NO_QUALIFICATION,
          },
          verdictProvenance: {
            lastGreenSha: 'g',
            lastGreenShortSha: 'g',
            lastGreenAgeMs: 1,
            mainFastForwarded: true,
            deployedBehindGreenPin: 0,
            deployOrigin: 'gate-green',
          },
        }),
      );
      expect(stage(s, 'main')).toMatchObject({ health: 'advancing', detail: null });
    });
  });
});

describe('mainBufferIsStale — pure helper (WI-6357 / EI-18790908999972569)', () => {
  it('is false whenever there is no buffer (mainFastForwarded true or null), regardless of age', () => {
    expect(mainBufferIsStale({ gate: { lastGreenAtMs: 1 }, mainFastForwarded: true })).toBe(false);
    expect(mainBufferIsStale({ gate: { lastGreenAtMs: 1 }, mainFastForwarded: null })).toBe(false);
  });

  it('is false when the last green verdict has never been measured (axis 2: no confident negative from missing data)', () => {
    expect(mainBufferIsStale({ gate: { lastGreenAtMs: null }, mainFastForwarded: false })).toBe(false);
  });

  it('is false for a buffer younger than the threshold — the normal, expected lag', () => {
    const now = 10_000_000;
    expect(
      mainBufferIsStale({ gate: { lastGreenAtMs: now - (MAIN_BUFFER_STALL_MS - 1) }, mainFastForwarded: false }, now),
    ).toBe(false);
  });

  it('is true once the last green verdict is older than the threshold', () => {
    const now = 10_000_000;
    expect(
      mainBufferIsStale({ gate: { lastGreenAtMs: now - (MAIN_BUFFER_STALL_MS + 1) }, mainFastForwarded: false }, now),
    ).toBe(true);
  });
});

/**
 * WI-38367 (the audit WI-38340's D-005 asks for) — the partial-green-salvage hole in
 * THIS surface's copy of the "an advance means main is catching up" premise.
 *
 * WI-38218 promotes the longest green PREFIX, so the gate can reset `lastGreenAt` on
 * every pass while the OLD end of the staging buffer never moves. Judged on green
 * recency alone, `stages[main]` then reads `advancing` / "normal, not a stall" about a
 * main that is hundreds of commits behind — the same false all-clear WI-38340 fixed in
 * `evaluateMainBehindStaging`. These pin the fix to the MEASUREMENT (the buffer's own
 * age), not to the `advanced-prefix` status string.
 */
describe('mainBufferStallReason — an advance only suppresses when it CONSUMED the backlog (WI-38367)', () => {
  const now = 100 * 60 * 60 * 1000;
  const green = (agoMs: number) => ({ lastGreenAtMs: now - agoMs });

  it('names WHICH trigger fired — a dead gate and an unproductive one need opposite responses', () => {
    expect(
      mainBufferStallReason(
        { gate: green(MAIN_BUFFER_STALL_MS + 1), mainFastForwarded: false, stagingBufferAgeMs: 60_000 },
        now,
      ),
    ).toBe('no-green');
    expect(
      mainBufferStallReason(
        { gate: green(60_000), mainFastForwarded: false, stagingBufferAgeMs: 9 * 60 * 60 * 1000 },
        now,
      ),
    ).toBe('unproductive-advance');
  });

  it('THE BUG: a fresh green against a hours-old backlog is no longer read as healthy', () => {
    // The WI-38340 shape, one surface over: a 1-minute-old prefix advance while the
    // oldest un-promoted commit is 9h old. Green recency ALONE says "not stale".
    const input = { gate: green(60_000), mainFastForwarded: false as const, stagingBufferAgeMs: 9 * 60 * 60 * 1000 };
    expect(mainBufferIsStale(input, now)).toBe(true);
    // ...and the control that proves the assertion above is not just "any recent green
    // alarms": the SAME green, against a backlog the advance could have produced.
    expect(mainBufferIsStale({ ...input, stagingBufferAgeMs: 60_000 }, now)).toBe(false);
  });

  it('does NOT alarm on the quiet-fleet shape that makes the pin age a bad proxy', () => {
    // main sits at a 5h-old commit (nothing was committed for hours) and ONE new commit
    // landed a minute ago. The buffer is a minute old; the pin's age says 5h. Anything
    // keying on pin age instead of buffer age cries wolf here.
    expect(
      mainBufferStallReason({ gate: green(20 * 60_000), mainFastForwarded: false, stagingBufferAgeMs: 60_000 }, now),
    ).toBeNull();
  });

  it('an unmeasured buffer age leaves the pre-existing suppression untouched — never a manufactured verdict', () => {
    expect(
      mainBufferStallReason({ gate: green(60_000), mainFastForwarded: false, stagingBufferAgeMs: null }, now),
    ).toBeNull();
    expect(mainBufferStallReason({ gate: green(60_000), mainFastForwarded: false }, now)).toBeNull();
    // ...but an unmeasured buffer must NOT rescue a gate that has stopped greening.
    expect(mainBufferStallReason({ gate: green(MAIN_BUFFER_STALL_MS + 1), mainFastForwarded: false }, now)).toBe(
      'no-green',
    );
  });

  it('tolerates one suite cut: a backlog older than the advance by less than the horizon is still progress', () => {
    const advanceAgo = 30 * 60_000;
    expect(
      mainBufferStallReason(
        {
          gate: green(advanceAgo),
          mainFastForwarded: false,
          stagingBufferAgeMs: advanceAgo + MAIN_BUFFER_STALL_MS - 1,
        },
        now,
      ),
    ).toBeNull();
    expect(
      mainBufferStallReason(
        {
          gate: green(advanceAgo),
          mainFastForwarded: false,
          stagingBufferAgeMs: advanceAgo + MAIN_BUFFER_STALL_MS + 1,
        },
        now,
      ),
    ).toBe('unproductive-advance');
  });
});

/**
 * git-pipeline-agent-state-2026-07-26 P-003 — serving-process truth.
 *
 * The class these encode was filed FOUR times independently
 * (EI-18740960754854672, EI-18741985436324043, EI-18741004371760803,
 * EI-18746827803289687): `deployed` is a git fact, and reading it as "live" is
 * wrong whenever the serving process booted before the code landed. Four
 * rediscoveries of one fact is a missing state surface, so these assert the
 * SURFACE never claims liveness without process evidence.
 */
describe('evaluateServing: process truth, never a git inference', () => {
  const releaseRuntime = classifyRuntimeOwner('packages/operator-core/lib/x.ts')!;
  const bgHostRuntime = classifyRuntimeOwner('packages/operator-core/lib/scout/cycle.ts')!;

  it('EI-21175951870654462: a fresh-invocation CLI is ready without probing or restarting a daemon', () => {
    const runtime = classifyRuntimeOwner('apps/operator/lib/release/green-checkpoint.ts')!;
    const sv = evaluateServing({
      runtime,
      // Even a deliberately old process must be ignored: it is the trigger owner, not the
      // process that executes this file.
      process: { pid: 99, startedAtMs: 1 },
      codeAsOfMs: 2,
      codeAsOfSource: 'file-mtime',
    });
    expect(sv).toMatchObject({
      unit: null,
      pid: null,
      startedSinceCodeChange: true,
      restartLever: null,
      unknownReason: null,
    });
  });

  it('a process that started BEFORE the deploy is NOT serving the deployed code', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 99, startedAtMs: 1_000_000 },
      codeAsOfMs: 1_000_000 + 45 * 60_000, // deploy landed 45m AFTER boot
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBe(false);
    expect(sv.behindMin).toBe(45);
    // and it must name the lever, not merely report the gap
    expect(sv.restartLever).toContain('deploy-cli.ts --execute');
    // no deploy was probed, so nothing is known to supersede the lever
    expect(sv.restartSupersededBy).toBeNull();
  });

  /**
   * EI-19447523039740352. The stale-serving verdict above is the NORMAL mid-deploy
   * state — a deploy lands files first and restarts the process late — so the window
   * where these tests' `startedSinceCodeChange:false` holds is exactly the window a
   * deploy is usually already fixing. Offering the restart lever there tells the
   * caller to fire a SECOND deploy against the shared release checkout, which
   * `release:deploy` refuses by design.
   */
  describe('restartSupersededBy: a running deploy withholds the restart lever', () => {
    const STALE = { pid: 99, startedAtMs: 1_000_000 };
    const CODE_AT = 1_000_000 + 45 * 60_000;
    const activeDeploy = {
      active: true,
      unit: 'papercup-auto-deploy',
      activeState: 'active',
      startedAtMs: 1_700_000,
      source: 'systemd' as const,
    };

    it('marks the lever superseded when a deploy is genuinely in flight', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'deploy',
        deployInFlight: activeDeploy,
      });
      // the staleness verdict itself is unchanged — this is about the ADVICE
      expect(sv.startedSinceCodeChange).toBe(false);
      expect(sv.restartSupersededBy).toEqual({
        kind: 'deploy-in-flight',
        unit: 'papercup-auto-deploy',
        startedAtMs: 1_700_000,
        activeState: 'active',
      });
      // restartLever stays FACTUAL (it is still the lever); suppression happens at the
      // stage's `lever`, so callers reading either one get a consistent story.
      expect(sv.restartLever).toContain('deploy-cli.ts --execute');
    });

    it('counts a DEACTIVATING deploy as still in flight — the :3070 restart happens late', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'deploy',
        deployInFlight: { ...activeDeploy, activeState: 'deactivating' },
      });
      expect(sv.restartSupersededBy?.activeState).toBe('deactivating');
    });

    /**
     * The MIRROR-IMAGE bug, and the reason this is scoped by host rather than applied
     * globally: a deploy restarts the release operator, and nothing else. A stale
     * bg-host is fixed by `dev:restart`, which no deploy performs — so suppressing its
     * lever would tell the caller to wait for something that is never coming.
     */
    it('does NOT suppress a non-release host, whose lever no deploy performs', () => {
      const sv = evaluateServing({
        runtime: bgHostRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'file-mtime',
        deployInFlight: activeDeploy,
      });
      expect(sv.startedSinceCodeChange).toBe(false);
      expect(sv.restartSupersededBy).toBeNull();
      expect(sv.restartLever).toContain('bg-host');
    });

    /**
     * `active:false` from an unreadable systemd means UNKNOWN, not idle
     * (readDeployInFlight's own contract). Only an AFFIRMATIVE reading may withhold a
     * lever: guessing "a deploy must be running" would strand a caller whose process
     * really is stale with nothing coming to fix it.
     */
    it('treats an unreadable systemd as UNKNOWN and keeps the lever', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'deploy',
        deployInFlight: { ...activeDeploy, active: false, source: 'systemd-unavailable' },
      });
      expect(sv.restartSupersededBy).toBeNull();
    });

    it('is null when no deploy is running, and when the probe was never run', () => {
      const idle = evaluateServing({
        runtime: releaseRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'deploy',
        deployInFlight: { ...activeDeploy, active: false, activeState: 'inactive' },
      });
      expect(idle.restartSupersededBy).toBeNull();

      // omitted entirely — every pre-existing caller keeps today's behaviour
      const unprobed = evaluateServing({
        runtime: releaseRuntime,
        process: STALE,
        codeAsOfMs: CODE_AT,
        codeAsOfSource: 'deploy',
      });
      expect(unprobed.restartSupersededBy).toBeNull();
    });
  });

  it('a process that started AFTER the deploy has genuinely loaded it', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 99, startedAtMs: 2_000_000 },
      codeAsOfMs: 1_000_000,
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBe(true);
    expect(sv.behindMin).toBeNull();
  });

  it('probes the SERVING unit, not the restart target (an operator-release path is served by :3070, not :3170)', () => {
    // restartTarget for a release path is `staging` — the host you bounce to
    // EXERCISE an edit. Probing that process would answer about the wrong one.
    expect(releaseRuntime.restartTarget).toBe('staging');
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 1, startedAtMs: 2 },
      codeAsOfMs: 1,
      codeAsOfSource: 'deploy',
    });
    expect(sv.unit).toBe('papercusp-dev-api.service');
  });

  it('serving restart advice includes the audited enablement gate', () => {
    const sv = evaluateServing({
      runtime: {
        host: 'bg-host',
        releasePipelineApplies: false,
        restartTarget: 'bg-host',
        activation: 'bg-host activation',
      },
      process: { pid: 1, startedAtMs: 2 },
      codeAsOfMs: 1,
      codeAsOfSource: 'file-mtime',
    });
    expect(sv.restartLever).toBe('dev:restart { target: "bg-host", confirm: true, authorize: true, reason: "<why>" }');
  });

  it('an UNREADABLE process start is UNKNOWN, never "live" (fail-soft in the honest direction)', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: null,
      codeAsOfMs: 1_000,
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBeNull();
    // The probe RAN and came back empty — retry-or-escalate, NOT a final answer.
    expect(sv.unknownReason?.code).toBe('resolver-failed');
    expect(sv.unknownReason?.detail).toMatch(/UNKNOWN, which is not the same as "live"/);
  });

  it('a sha-only probe (no path) cannot identify a serving process and says so', () => {
    const sv = evaluateServing({ runtime: null, process: null, codeAsOfMs: null, codeAsOfSource: null });
    expect(sv.startedSinceCodeChange).toBeNull();
    expect(sv.host).toBeNull();
    // Nothing failed here — there is no serving question to ask, so this is
    // FINAL. A caller that retries a `not-applicable` is burning calls forever.
    expect(sv.unknownReason?.code).toBe('not-applicable');
    expect(sv.unknownReason?.detail).toMatch(/sha-only probe/);
  });

  /**
   * WI-2141731 — the serving process's OWN sha, when it reports one, outranks the
   * start-time inference. These pin the property that matters: the direct
   * evidence is used when present, and its ABSENCE changes nothing at all.
   */
  describe('WI-2141731: the health sha is direct evidence, the inference is the fallback', () => {
    const DEPLOYED = '6e898b6cf88316fcf1574f049554a6caf16318f0';

    it('a matching health sha proves the process is executing the deployed code', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        // Timestamps that would infer STALE on their own — the direct evidence must win.
        process: { pid: 7, startedAtMs: 1_000 },
        codeAsOfMs: 9_000,
        codeAsOfSource: 'deploy',
        servingHealthSha: '6e898b6cf8',
        deployedSha: DEPLOYED,
      });
      expect(sv.startedSinceCodeChange).toBe(true);
      expect(sv.evidence).toBe('health-sha');
      expect(sv.reportedSha).toBe('6e898b6cf8');
      // A duration is NOT derivable from two shas; claiming one would be invented.
      expect(sv.behindMin).toBeNull();
    });

    it('a SHORT health sha still matches the full deployed sha (prefix, not equality)', () => {
      // The regression this pins: `===` reports a MISMATCH for every healthy
      // deploy, because /api/health reports `rev-parse --short` and the deployed
      // sha is the full 40 — a confident false "restart required".
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: { pid: 7, startedAtMs: 9_000 },
        codeAsOfMs: 1_000,
        codeAsOfSource: 'deploy',
        servingHealthSha: '6E898B6', // 7 chars + upper case: both must normalize
        deployedSha: DEPLOYED,
      });
      expect(sv.startedSinceCodeChange).toBe(true);
      expect(sv.evidence).toBe('health-sha');
    });

    it('a DIFFERING health sha reports stale and keeps the restart lever', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        // Timestamps that would infer LIVE on their own. This is the case the
        // inference structurally cannot catch: the process did restart after the
        // code changed, but it loaded DIFFERENT code than expected.
        process: { pid: 7, startedAtMs: 9_000 },
        codeAsOfMs: 1_000,
        codeAsOfSource: 'deploy',
        servingHealthSha: 'deadbeef12',
        deployedSha: DEPLOYED,
      });
      expect(sv.startedSinceCodeChange).toBe(false);
      expect(sv.evidence).toBe('health-sha');
      expect(sv.restartLever).toBeTruthy();
    });

    it('a sha-only probe becomes ANSWERABLE once the process reports its sha', () => {
      // Before this, a sha-only read was structurally not-applicable: the
      // inference needs a path to find a host. The health sha needs neither.
      const sv = evaluateServing({
        runtime: null,
        process: null,
        codeAsOfMs: null,
        codeAsOfSource: null,
        servingHealthSha: '6e898b6cf8',
        deployedSha: DEPLOYED,
      });
      expect(sv.startedSinceCodeChange).toBe(true);
      expect(sv.evidence).toBe('health-sha');
      expect(sv.unknownReason).toBeNull();
    });

    it('NO health answer falls through to the start-time inference, unchanged', () => {
      const args = {
        runtime: releaseRuntime,
        process: { pid: 7, startedAtMs: 9_000 },
        codeAsOfMs: 1_000,
        codeAsOfSource: 'deploy' as const,
      };
      const withoutProbe = evaluateServing(args);
      const probeTimedOut = evaluateServing({ ...args, servingHealthSha: null, deployedSha: DEPLOYED });
      // Byte-identical: a wedged :3070 must cost the caller nothing but latency.
      expect(probeTimedOut).toEqual(withoutProbe);
      expect(probeTimedOut.evidence).toBe('start-time');
      expect(probeTimedOut.startedSinceCodeChange).toBe(true);
    });

    it('refuses to conclude from a sha prefix too short to be unique', () => {
      // A 4-char prefix collides with unrelated commits, and the failure
      // direction is the bad one (a false "it's live"). Fall back instead.
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: { pid: 7, startedAtMs: 1_000 },
        codeAsOfMs: 9_000,
        codeAsOfSource: 'deploy',
        servingHealthSha: '6e89',
        deployedSha: DEPLOYED,
      });
      expect(sv.evidence).toBe('start-time');
      expect(sv.startedSinceCodeChange).toBe(false);
    });

    it('a non-hex health body is ignored rather than compared', () => {
      const sv = evaluateServing({
        runtime: releaseRuntime,
        process: { pid: 7, startedAtMs: 9_000 },
        codeAsOfMs: 1_000,
        codeAsOfSource: 'deploy',
        servingHealthSha: 'not-a-sha',
        deployedSha: DEPLOYED,
      });
      expect(sv.evidence).toBe('start-time');
      expect(sv.reportedSha).toBeNull();
    });

    it('tauri-desktop stays structurally not-applicable (WI-2141716 not regressed)', () => {
      const desktop = classifyRuntimeOwner('papercusp-desktop/src-tauri/src/main.rs');
      if (!desktop || desktop.host !== 'tauri-desktop') return;
      const sv = evaluateServing({
        runtime: desktop,
        process: null,
        codeAsOfMs: 1_000,
        codeAsOfSource: 'file-mtime',
        servingHealthSha: null,
        deployedSha: DEPLOYED,
      });
      expect(sv.unknownReason?.code).toBe('not-applicable');
      expect(sv.evidence).toBeNull();
    });
  });

  /**
   * WI-2141716 — the recurrence guard, and it deliberately spans BOTH functions.
   * The test above proved `evaluateServing` records `not-applicable`; the unit cases
   * for `assessDeployedSha` prove it honours that code. Neither one alone catches the
   * regression that actually shipped: the two agreed in isolation while the WIRING
   * between them dropped the code on the floor, so `state:read { cell:'deploy.3070.sha' }`
   * told every caller to "re-probe the serving runtime" for a question no probe can
   * answer. One ended session (su-bf563dcb, 2026-09-01) rode that loop for a day.
   */
  it('a sha-only probe never yields a retry-shaped deployed-sha verdict (WI-2141716)', () => {
    const sv = evaluateServing({ runtime: null, process: null, codeAsOfMs: null, codeAsOfSource: null });
    const assessment = assessDeployedSha({
      deployedSha: 'abc1234567',
      servingStartedSinceCodeChange: sv.startedSinceCodeChange,
      servingUnknownCode: sv.unknownReason?.code ?? null,
      verdictUnknownLegs: [],
    });
    expect(assessment).toBe('serving-not-probeable');
    expect(assessment).not.toBe('process-unverified');
  });

  /**
   * The case that earns the enum its keep (D-038 axis 2 corollary). All three
   * unknowns above render as prose a human reads the same way — "we don't know"
   * — but they demand THREE different responses, and only the code says which:
   *   - sha-only probe        → not-applicable   → stop asking; there is no lever
   *   - unreadable start time → resolver-failed  → retry, or escalate the probe
   *   - start time but no code-as-of → insufficient-data → supply the missing
   *     operand; retrying the identical call cannot help, because the half that
   *     failed is not the half being retried.
   * Before this change all three were `string | null` and a caller could only
   * have told them apart by matching on prose, which nobody does.
   */
  it('a HALF-read comparison is insufficient-data, not resolver-failed — the probe succeeded', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 4242, startedAtMs: 5_000 },
      codeAsOfMs: null,
      codeAsOfSource: null,
    });
    expect(sv.startedSinceCodeChange).toBeNull();
    expect(sv.unknownReason?.code).toBe('insufficient-data');
    expect(sv.unknownReason?.code).not.toBe('resolver-failed');
    expect(sv.unknownReason?.detail).toMatch(/cannot be compared/);
  });

  it('a working-tree host compares against FILE MTIME, because it imports the tree — not the deploy', () => {
    // bg-host tsx-loads the working tree, so an uncommitted edit IS its code; the
    // deploy is irrelevant to it (EI-11120). Same comparison service-health's
    // evaluateBgHostCodeDrift makes, generalised from hot-paths to one file.
    const sv = evaluateServing({
      runtime: bgHostRuntime,
      process: { pid: 7, startedAtMs: 1_000_000 },
      codeAsOfMs: 1_000_000 + 10 * 60_000,
      codeAsOfSource: 'file-mtime',
    });
    expect(sv.unit).toBe('papercusp-bg-host.service');
    expect(sv.startedSinceCodeChange).toBe(false);
    expect(sv.restartLever).toContain('bg-host');
  });
});

/**
 * EI-19327418148563597: `evaluateReleaseContentDrift` is the pure comparison behind
 * the "LIVE CODE DIFFERS FROM SOURCE" note — while the gate is red, `:3070`'s release
 * checkout can lag the staging tree by hours, so profiling the live box for a hot path
 * can measure code that is not what the working tree holds. Pure byte identity, and
 * fail-soft toward UNKNOWN (never a false "match") when either read failed.
 */
describe('evaluateReleaseContentDrift (EI-19327418148563597)', () => {
  it('reports differs:true when the release checkout has a DIFFERENT copy of the file', () => {
    const res = evaluateReleaseContentDrift({
      workingBytes: Buffer.from('const fixed = true;'),
      releaseBytes: Buffer.from('const fixed = false;'),
    });
    expect(res.differs).toBe(true);
  });

  it('reports differs:false when the release checkout is byte-identical', () => {
    const res = evaluateReleaseContentDrift({
      workingBytes: Buffer.from('same bytes'),
      releaseBytes: Buffer.from('same bytes'),
    });
    expect(res.differs).toBe(false);
  });

  it('reports differs:null (never a false match) when the WORKING read failed', () => {
    const res = evaluateReleaseContentDrift({ workingBytes: null, releaseBytes: Buffer.from('x') });
    expect(res.differs).toBeNull();
  });

  it('reports differs:null (never a false match) when the RELEASE read failed', () => {
    const res = evaluateReleaseContentDrift({ workingBytes: Buffer.from('x'), releaseBytes: null });
    expect(res.differs).toBeNull();
  });

  it('reports differs:null when BOTH reads failed', () => {
    const res = evaluateReleaseContentDrift({ workingBytes: null, releaseBytes: null });
    expect(res.differs).toBeNull();
  });
});

describe('the serving STAGE and summary never claim "live" off a git fact', () => {
  type StageInput = Parameters<typeof computeStages>[0];
  const stage = (stages: StageState[], name: StageName): StageState => {
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s;
  };
  const base = (serving: ServingTruth, over: Partial<StageInput> = {}): StageInput => ({
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    gate: {
      stalled: false,
      consecutiveReds: 0,
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
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
    },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    changeInCandidate: NO_CANDIDATE,
    sweepExposure: NO_SWEEP,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    ...over,
    serving,
  });

  const STALE: ServingTruth = {
    ...HEALTHY_SERVING,
    startedAtMs: 1_000,
    codeAsOfMs: 100_000,
    startedSinceCodeChange: false,
    behindMin: 30,
  };

  it('THE 4x-FILED BUG: deployed ✓ + a process older than the deploy is NOT past the serving stage', () => {
    const s = computeStages(base(STALE));
    // deployed is genuinely past — the git fact is true...
    expect(stage(s, 'deployed').position).toBe('past');
    // ...and that is exactly why serving must be the one to say "no".
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').health).toBe('stalled');
    expect(stage(s, 'serving').detail).toMatch(/does NOT mean "running"/);
    // waiting is futile here; the detail must name the restart, not suggest patience
    expect(stage(s, 'serving').detail).toMatch(/Waiting cannot fix this/);
  });

  it('deployed ✓ + a process younger than the deploy IS past the serving stage', () => {
    const s = computeStages(base(HEALTHY_SERVING));
    expect(stage(s, 'serving').position).toBe('past');
    expect(stage(s, 'serving').health).toBe('advancing');
  });

  it('not deployed yet ⇒ serving is pending even when the process is current (the deploy stage owns that wait)', () => {
    const s = computeStages(
      base(HEALTHY_SERVING, { positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false } }),
    );
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').health).toBe('advancing');
    expect(stage(s, 'serving').detail).toBeNull();
  });

  it('an UNKNOWN serving verdict is health=unknown with its reason — not silently "advancing"', () => {
    const unknown: ServingTruth = {
      ...HEALTHY_SERVING,
      startedAtMs: null,
      pid: null,
      startedSinceCodeChange: null,
      // Nothing was concluded, so no evidence produced it.
      evidence: null,
      unknownReason: { code: 'resolver-failed', detail: 'could not read the unit' },
    };
    const s = computeStages(base(unknown));
    expect(stage(s, 'serving').health).toBe('unknown');
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').detail).toBe('could not read the unit');
  });

  it('summarizePosition drops the bare "(live)" and qualifies it with process evidence', () => {
    const mk = (serving: ServingTruth): Omit<PipelinePosition, 'summary'> => ({
      input: { path: 'a.ts', sha: null },
      runtimeGenerations: [],
      servingRuntimes: [],
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      assessments: {
        pipelinePosition:
          serving.startedSinceCodeChange === true
            ? 'live'
            : serving.startedSinceCodeChange === false
              ? 'restart-required'
              : null,
        gateVerdict: 'passing-current',
        gateCandidate: 'no-active-run',
        gateOwnership: null,
        deployedSha:
          serving.startedSinceCodeChange === true
            ? 'executing'
            : serving.startedSinceCodeChange === false
              ? 'restart-required'
              : 'process-unverified',
        mainBehindStaging: 'caught-up',
      },
      positionsUnknown: [],
      // WI-6646 made these REQUIRED on PipelinePosition. Both values are semantically
      // correct here rather than compiler-silencers: this fixture names no `marker`, so
      // there is no per-leg marker verdict to report, and no leg is a newer-commit artifact.
      positionsMarker: null,
      positionsNewerCommit: [],
      verdictUnknown: [],
      deployedSha: 'deployedsha0',
      gate: {
        stalled: false,
        consecutiveReds: 0,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
    });

    // stale process: the summary must actively CONTRADICT the deployed tick
    const stale = summarizePosition(mk(STALE));
    expect(stale).toMatch(/NOT LIVE/);
    expect(stale).not.toMatch(/\(live\)/);

    // confirmed: "live" is allowed, but only with the reason attached
    const live = summarizePosition(mk(HEALTHY_SERVING));
    expect(live).toContain('live — the serving process started after this code landed');

    // unknown: neither "live" nor a false alarm
    const unknown = summarizePosition(mk({ ...HEALTHY_SERVING, startedSinceCodeChange: null }));
    expect(unknown).toMatch(/UNKNOWN — not confirmed live/);
    expect(unknown).not.toMatch(/NOT LIVE/);
  });
});

/* ------------------------------------------------------------------------- *
 * P-004 — "is the commit the gate is judging even MY code?"
 *
 * EI-18752644493166307: two gate runs judged candidates that did not contain the
 * caller's fix. The wasted runs were the cheap part. The expensive part is that a
 * candidate WITHOUT your fix reds on the PRE-FIX failure with the PRE-FIX count,
 * which reads as "your fix did not work" instead of "your fix was not present" —
 * and sends you off to re-debug code that was already correct.
 *
 * So these cases assert the READING, not the field: every path that can produce that
 * misread must be closed by text that names it.
 * ------------------------------------------------------------------------- */
describe('changeInCandidate (P-004)', () => {
  const contained = (over: Partial<ChangeInCandidate> = {}): ChangeInCandidate => ({
    ...NO_CANDIDATE,
    ...over,
  });

  describe('evaluateChangeInCandidate', () => {
    it('a sha-only probe reports nothing rather than inventing a verdict', () => {
      const r = evaluateChangeInCandidate({
        relPath: null,
        candidates: { judgingSha: 'aaa', nextCandidateSha: 'bbb' },
        judging: null,
        next: null,
      });
      expect(r).toEqual(NO_CANDIDATE);
    });

    it('THE misread: an in-flight run without your file says a RED is not your fix failing', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'cand1234567890', nextCandidateSha: 'cand1234567890' },
        judging: { path: 'a.ts', inCandidate: false, reason: 'uncommitted', unknownReason: null },
        next: null,
      });
      expect(r.judgingContainsPath).toBe(false);
      expect(r.missingReason).toBe('uncommitted');
      // The whole point: pre-empt "my fix didn't work".
      expect(r.detail).toMatch(/NOT evidence your change failed/);
      // …and name the lever that actually applies to THIS reason.
      expect(r.detail).toMatch(/git-sync:run/);
    });

    it('a quiet-cut miss routes to the quiet-window lever, NOT to "commit it"', () => {
      // Naming this 'uncommitted' would send the caller to git-sync:run — which cannot
      // help, because the change is already committed. Wrong lever = another wasted run.
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: null, nextCandidateSha: 'cand1234567890' },
        judging: null,
        next: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
      });
      expect(r.nextContainsPath).toBe(false);
      expect(r.detail).toMatch(/quiet-cut/);
      expect(r.detail).not.toMatch(/git-sync:run/);
    });

    it('the JUDGED candidate outranks the hypothetical next one — its verdict is the one that exists', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: 'nextcand123456' },
        judging: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
        next: { path: 'a.ts', inCandidate: true, reason: null, unknownReason: null },
      });
      expect(r.detail).toMatch(/judged candidate/);
      expect(r.detail).toMatch(/inflight1234/);
      // EI-19311755730915969: `judgingSha` says WHICH commit was judged, never that a run
      // is alive. Phrasing it as liveness is what let a completed run read as "a verdict
      // is coming, so wait" — so no verdict string derived from it may claim in-flight-ness.
      expect(r.detail).not.toMatch(/IN FLIGHT/i);
    });

    it('EI-18797292094433710: a newer-commit miss states the AMBIGUITY and the marker lever — it never exonerates the red', () => {
      // `inCandidate` compares the path's CURRENT content, so a peer's later commit to
      // the same file is indistinguishable from your own change having missed the cut.
      // Claiming "a RED from that run is NOT evidence your change failed" there is a
      // false exoneration — it invites waving a genuine regression through as a stale
      // candidate, and (with the old lever) re-firing for a verdict already in flight.
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: null },
        judging: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
        next: null,
      });
      expect(r.judgingContainsPath).toBe(false);
      expect(r.detail).toMatch(/UNRESOLVED/);
      // The lever this points at is now the `marker` argument rather than a shelled-out
      // `git merge-base --is-ancestor`: both resolve the same ambiguity, but the marker
      // settles it inside the SAME call that raised it, so there is no second step to
      // skip. What this assertion protects is that SOME definitive lever is named — an
      // "UNRESOLVED" verdict with no way to resolve it is what invites the guess.
      expect(r.detail).toMatch(/SETTLE IT IN ONE CALL/);
      expect(r.detail).toMatch(/re-call with `marker`/);
      expect(r.detail).toMatch(/do not re-fire/i);
      // the false exoneration must be gone
      expect(r.detail).not.toMatch(/NOT evidence your change failed/);
      // and it must not prescribe the re-fire that cost the outage two suite cycles.
      // vacuous-negative-ok: EI-18797292094433710 removed this exact phrasing on purpose
      // (the current `newer-commit` lever text is the wholly-different "SETTLE IT IN ONE
      // CALL..." wording asserted above) — the only other occurrence anywhere in the tree
      // is a code COMMENT quoting the old wording for context (git-pipeline-position.ts,
      // same EI), which can never be emitted at runtime. This assertion is a deliberate,
      // stable ratchet against ever reintroducing that specific old bad advice.
      expect(r.detail).not.toMatch(/Re-fire once the commit ages/);
    });

    it('an UNCOMMITTED miss keeps the exoneration — there the candidate provably cannot see the work', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: null },
        judging: { path: 'a.ts', inCandidate: false, reason: 'uncommitted', unknownReason: null },
        next: null,
      });
      expect(r.detail).toMatch(/NOT evidence your change failed/);
      expect(r.detail).toMatch(/git-sync:run/);
    });

    it('a confirmed-contained candidate says the verdict IS about your change TO THAT PATH', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: {
          judgingSha: 'inflight123456',
          judgingShaSource: 'in-flight-candidate',
          nextCandidateSha: null,
        },
        judging: { path: 'a.ts', inCandidate: true, reason: null, unknownReason: null },
        next: null,
      });
      expect(r.judgingContainsPath).toBe(true);
      // The signal itself is preserved: for a path the caller DID edit, blob identity with
      // the working tree does mean the change is in. EI-20429780229915918 scoped the claim,
      // it did not downgrade it.
      expect(r.detail).toMatch(/real verdict on your change to it/);
      expect(r.detail).toMatch(/DOES carry the current content of a\.ts/);
    });

    /**
     * EI-20429780229915918 — the `true` is the direction that fails SILENTLY, because a
     * `true` about the wrong subject is indistinguishable from a `true` about the right
     * one. The detail used to end "so its verdict is a real verdict on your change" with
     * no mention of WHICH path it compared, so an agent polling a fixed probe path across
     * wakes read it as "my fix is in the candidate" — a near-miss that would have claimed
     * an incident two other agents were working and retracted a correct workspace fact.
     *
     * Guard the two properties that stop the misread: the subject is NAMED, and the
     * caller is routed to the instrument that actually answers "is MY change in".
     */
    it('names the compared path and routes to `marker`, so a probe-path true cannot read as "my fix is in"', () => {
      const probePath = 'packages/operator-core/lib/system-health/types.ts';
      const r = evaluateChangeInCandidate({
        relPath: probePath,
        candidates: {
          judgingSha: '75c1ee3ea189',
          judgingShaSource: 'in-flight-candidate',
          nextCandidateSha: null,
        },
        judging: { path: probePath, inCandidate: true, reason: null, unknownReason: null },
        next: null,
      });
      expect(r.judgingContainsPath).toBe(true);
      // The subject is named, so a path unrelated to the fix is visible AS the subject.
      expect(r.detail).toContain(probePath);
      // The unqualified claim that produced the misread is gone.
      expect(r.detail).not.toMatch(/so its verdict is a real verdict on your change\./);
      // The probe-path case is called out, and the real instrument is named.
      expect(r.detail).toMatch(/probe path/i);
      expect(r.detail).toMatch(/says NOTHING about whether your fix is in the candidate/);
      expect(r.detail).toMatch(/`marker`/);
    });

    it('refuses inferred judged containment and preserves the next-candidate fields', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: {
          judgingSha: 'inferred123456',
          judgingShaSource: 'run-probe',
          nextCandidateSha: 'next123456',
        },
        judging: { path: 'a.ts', inCandidate: true, reason: null, unknownReason: null },
        next: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
        markerJudging: {
          marker: 'MY_FIX',
          sha: 'inferred123456',
          present: true,
          count: 1,
          pathPresent: true,
          unknownReason: null,
        },
      });
      expect(r).not.toHaveProperty('judgingContainsPath');
      expect(r.judgingSha).toBe('inferred123456');
      expect(r.judgingShaSource).toBe('run-probe');
      expect(r.nextCandidateSha).toBe('next123456');
      expect(r.nextContainsPath).toBe(false);
      expect(r.detail).toMatch(/^REFUSED/);
      expect(r.detail).toMatch(/Read instead:/);
    });

    it('an UNKNOWN containment claims nothing in either direction', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: null },
        judging: {
          path: 'a.ts',
          inCandidate: null,
          reason: null,
          unknownReason: { code: 'resolver-failed', detail: 'unreadable' },
        },
        next: null,
      });
      expect(r.judgingContainsPath).toBeNull();
      expect(r.detail).toBeNull();
    });
  });

  describe('the gate stage leads with containment', () => {
    type StageInput = Parameters<typeof computeStages>[0];
    const gateStage = (over: Partial<StageInput>) => {
      const stages = computeStages({
        dirtyUncommitted: false,
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        gate: {
          stalled: false,
          consecutiveReds: 0,
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
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: true,
          deployedBehindGreenPin: 0,
          deployOrigin: 'gate-green',
        },
        gitSyncLastStatus: 'synced',
        gitSync: HEALTHY_GIT_SYNC,
        serving: HEALTHY_SERVING,
        changeInCandidate: NO_CANDIDATE,
        sweepExposure: NO_SWEEP,
        runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
        ...over,
      });
      const s = stages.find((x) => x.name === 'gate');
      if (!s) throw new Error('no gate stage');
      return s;
    };

    it('a RED gate + a candidate lacking your file must not read as one signal', () => {
      // These are the two readings the incident conflated. A bare "gate is RED (3
      // consecutive)" next to a candidate that cannot contain the fix is exactly what
      // sends someone back to re-debug correct code — so containment leads, and the red
      // is explicitly demoted to "not about you yet".
      const s = gateStage({
        gate: {
          stalled: true,
          consecutiveReds: 3,
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
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
        changeInCandidate: contained({
          judgingSha: 'cand1234567890',
          judgingContainsPath: false,
          missingReason: 'uncommitted',
          detail: 'candidate does not contain it',
        }),
      });
      expect(s.health).toBe('stalled');
      expect(s.detail).toMatch(/candidate does not contain it/);
      expect(s.detail).toMatch(/do NOT read that red as your change failing/);
    });

    it('leaves the normal red-gate message alone when containment is not in question', () => {
      const s = gateStage({
        gate: {
          stalled: true,
          consecutiveReds: 3,
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
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
      });
      expect(s.detail).toMatch(/Gate is RED \(3 consecutive\)/);
    });

    it('containment also outranks a WEDGED gate — a verdict that cannot mention you is worse news', () => {
      const s = gateStage({
        gate: {
          stalled: false,
          consecutiveReds: 0,
          lastGreenAtMs: 1,
          fireStale: true,
          fireStaleReason: 'no tick',
          verdictStale: false,
          verdictObservedAtMs: null,
          verdictStaleReason: null,
          verdictStaleReasonCode: null,
          candidateAgeMs: null,
          commitsBehindTip: null,
          observedCandidate: null,
          inconclusive: null,
          candidateFailures: null,
          ownerBrief: null, qualification: NO_QUALIFICATION,
        },
        changeInCandidate: contained({
          nextCandidateSha: 'cand1234567890',
          nextContainsPath: false,
          submodule: null,
          missingReason: 'newer-commit',
          detail: 'a fire now would judge older code',
        }),
      });
      expect(s.detail).toMatch(/a fire now would judge older code/);
    });
  });

  describe('summarizePosition', () => {
    const base = (over: Partial<Omit<PipelinePosition, 'summary'>> = {}): Omit<PipelinePosition, 'summary'> => ({
      input: { path: 'a.ts', sha: null },
      runtimeGenerations: [],
      servingRuntimes: [],
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      assessments: {
        pipelinePosition: 'awaiting-gate',
        gateVerdict: 'passing-current',
        gateCandidate: 'no-active-run',
        gateOwnership: null,
        deployedSha: 'executing',
        mainBehindStaging: 'caught-up',
      },
      positionsUnknown: [],
      // WI-6646 made these REQUIRED on PipelinePosition. Both values are semantically
      // correct here rather than compiler-silencers: this fixture names no `marker`, so
      // there is no per-leg marker verdict to report, and no leg is a newer-commit artifact.
      positionsMarker: null,
      positionsNewerCommit: [],
      verdictUnknown: [],
      deployedSha: 'deployedsha0',
      gate: {
        stalled: false,
        consecutiveReds: 0,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving: HEALTHY_SERVING,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
      ...over,
    });

    it('appends the containment warning LAST — where a reader stops', () => {
      const s = summarizePosition(
        base({
          changeInCandidate: contained({
            judgingSha: 'cand1234567890',
            judgingContainsPath: false,
            detail: 'the judged candidate lacks this file',
          }),
        }),
      );
      expect(s).toMatch(/the judged candidate lacks this file$/);
    });

    it('stays silent when containment is unknown — no verdict is better than a wrong one', () => {
      expect(summarizePosition(base())).not.toMatch(/⚠ The gate run/);
    });

    it('EI-21271222700908558: the summary names a deliberate pause instead of a stale repair abort', () => {
      const summary = summarizePosition(
        base({
          blockedOn: 'gate',
          nextAction: null,
          gate: {
            ...base().gate,
            fireStale: true,
            fireStaleReason: 'green-checkpoint is deliberately PAUSED (active:false)',
            pause: {
              reason: 'hold while the repaired staging checkout is verified',
              pausedBy: 'su-release-owner',
              pausedAtMs: 1_786_780_000_000,
              // P-004: null = no auto-resume scheduled (this fixture's pause predates TTL stamping).
              expiresAtMs: null,
            },
            inconclusive: {
              status: 'repair-staging-mismatch',
              candidate: 'repair-candidate-sha',
              detail: 'repair patch is not on staging',
              observedAtMs: 1_786_780_000_000,
            },
          },
        }),
      );
      expect(summary).toMatch(/BLOCKED AT GATE.*DELIBERATELY PAUSED/);
      expect(summary).toMatch(/repaired staging checkout is verified/);
      expect(summary).not.toMatch(/repair-staging-mismatch/);
      expect(summary).not.toMatch(/clear the gate abort condition/);
    });

    it('EI-22162745262638300: a gate wait keeps staging/current-build work actionable', () => {
      const summary = summarizePosition(
        base({
          blockedOn: 'gate',
          nextAction: null,
          gate: {
            ...base().gate,
            stalled: true,
            checkpointRunInFlight: {
              active: true,
              candidate: 'candidate-sha',
              startedAtMs: 1,
              elapsedSec: 600,
              asOfAgeMs: 5_000,
            },
          },
        }),
      );
      expect(summary).toMatch(/WAITING AT GATE/);
      expect(summary).toMatch(/staging\/current-build/);
      expect(summary).toMatch(/final shipment|deployed-only/);
      expect(summary).not.toMatch(/nothing to do/);
    });

    /**
     * The EI names this line specifically. For a working-tree tsx host the reassurance
     * "even an uncommitted edit is what it loads on restart" is TRUE — of the RESTART
     * consumer. The green-checkpoint is a second consumer of the same file and judges a
     * COMMITTED candidate, for which the same edit is invisible. The filer read the true
     * half as blanket permission and fired the gate dirty.
     */
    it('qualifies the working-tree reassurance for the GATE consumer when the path is dirty', () => {
      const bgPath = 'packages/operator-core/lib/inference-gateway/admission.ts';
      const rt = classifyRuntimeOwner(bgPath);
      expect(rt?.releasePipelineApplies).toBe(false);

      const dirty = summarizePosition(
        base({
          input: { path: bgPath, sha: null },
          dirtyUncommitted: true,
          runtime: rt,
          runtimes: classifyRuntimeOwners(bgPath),
        }),
      );
      expect(dirty).toMatch(/even an uncommitted edit is what it loads on restart/);
      expect(dirty).toMatch(/GREEN GATE is a different consumer/);
      expect(dirty).toMatch(/INVISIBLE to it/);

      // …and it must NOT fire when there is nothing uncommitted to be blind to.
      const clean = summarizePosition(
        base({ input: { path: bgPath, sha: null }, runtime: rt, runtimes: classifyRuntimeOwners(bgPath) }),
      );
      expect(clean).not.toMatch(/GREEN GATE is a different consumer/);
    });
  });

  describe('gitPipelinePosition wiring', () => {
    it('reports containment against BOTH candidates and notes the miss', async () => {
      const git: GitRunner = async (_repo, args) => {
        if (args[0] === 'config') return null;
        if (args[0] === 'status') return 'M a.ts';
        // EI-19326775809436764's refineUnattributedUncommitted probes with a
        // REF-SCOPED `log -1 --pretty=%H <ref> -- <path>` (args[3] is the ref,
        // not '--') — a different shape from the bare candidate-resolution form
        // below (args[3] IS '--'). This fixture predates that refinement; without
        // this branch the blanket handler below satisfies its precondition by
        // accident and silently downgrades this test's genuine 'uncommitted' case
        // to 'insufficient-data' (EI-19381... discovered while working
        // EI-19325915429897280 in this same file).
        if (args[0] === 'log' && args.includes('--pretty=%H') && args[3] !== '--') return null;
        if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
        if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
        if (args[0] === 'rev-list') return '0';
        if (args[0] === 'merge-base') return args[1];
        // The candidate COMMIT must resolve before any path verdict is computed — an
        // unresolvable sha is UNKNOWN, not a blanket "absent".
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith('^{commit}')) return 'c'.repeat(40);
        // The candidate carries an OLD blob; the working tree has a new one. (Both must be
        // real hex — the reader rejects non-sha output rather than trusting it.)
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'judging1:a.ts') return '0'.repeat(40);
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD:a.ts') return '0'.repeat(40);
        if (args[0] === 'hash-object') return 'f'.repeat(40);
        return null;
      };
      const res = await gitPipelinePosition(
        { path: 'a.ts' },
        {
          git,
          loadDeploy: async () => deploy(),
          ...activeCandidateDeps('judging1'),
          resolveGateCandidates: async () => ({
            judgingSha: 'judging1',
            judgingShaSource: 'in-flight-candidate',
            nextCandidateSha: 'judging1',
          }),
        },
      );
      expect(res.changeInCandidate.judgingSha).toBe('judging1');
      expect(res.changeInCandidate.judgingContainsPath).toBe(false);
      expect(res.changeInCandidate.missingReason).toBe('uncommitted');
      expect(res.notes.join(' ')).toMatch(/CANDIDATE DOES NOT CONTAIN THIS FILE/);
    });

    it('hoists inferred judged containment as resolver-failed and shows the refusal in the summary', async () => {
      const git: GitRunner = async (_repo, args) => {
        if (args[0] === 'config') return null;
        if (args[0] === 'status') return '';
        if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
        if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
        if (args[0] === 'rev-list') return '0';
        if (args[0] === 'merge-base') return args[1];
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith('^{commit}')) return 'c'.repeat(40);
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith(':a.ts')) return '0'.repeat(40);
        if (args[0] === 'hash-object') return '0'.repeat(40);
        return null;
      };
      const res = await gitPipelinePosition(
        { path: 'a.ts' },
        {
          git,
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
          resolveGateCandidates: async () => ({
            judgingSha: 'judging1',
            judgingShaSource: 'run-probe',
            nextCandidateSha: 'judging1',
          }),
        },
      );
      expect(res.changeInCandidate).not.toHaveProperty('judgingContainsPath');
      expect(res.verdictUnknown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            leg: 'changeInCandidate.judgingContainsPath',
            unknown: expect.objectContaining({ code: 'resolver-failed' }),
          }),
        ]),
      );
      expect(res.summary).toMatch(/REFUSED/);
      expect(res.notes.join(' ')).toMatch(/changeInCandidate\.judgingContainsPath/);
    });

    /**
     * EI-18797292094433710 — the caller's real question is "is MY change in the judged
     * commit", and blob identity stops answering it the moment a peer commits to the same
     * file. These drive the FULL entry point (not `evaluateChangeInCandidate` alone),
     * because the defect they guard lives in the argument handling.
     */
    describe('marker containment — the peer-edited-my-file case', () => {
      /** A candidate whose blob DIFFERS from the tree (a peer moved the file) but which
       *  still carries the caller's change. Blob identity says "missing"; the marker does not. */
      const peerEditedGit =
        (fileAtCandidate: string): GitRunner =>
        async (_repo, args) => {
          if (args[0] === 'status') return 'M a.ts';
          if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
          if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
          if (args[0] === 'rev-list') return '0';
          if (args[0] === 'merge-base') return args[1];
        if (args[0] === 'merge-base') return args[1];
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith('^{commit}')) return 'c'.repeat(40);
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'judging1:a.ts') return '0'.repeat(40);
          // HEAD matches the tree ⇒ committed-but-newer, i.e. reason 'newer-commit'.
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD:a.ts') return 'f'.repeat(40);
          if (args[0] === 'hash-object') return 'f'.repeat(40);
          if (args[0] === 'ls-tree') return `100644 blob ${'e'.repeat(40)}\ta.ts`;
          if (args[0] === 'show') return fileAtCandidate;
          return null;
        };

      const run = (marker: string | undefined, contents: string) =>
        gitPipelinePosition(
          { path: 'a.ts', marker },
          {
            git: peerEditedGit(contents),
            loadDeploy: async () => deploy(),
            ...activeCandidateDeps('judging1'),
            resolveGateCandidates: async () => ({
              judgingSha: 'judging1',
              judgingShaSource: 'in-flight-candidate',
              nextCandidateSha: 'judging1',
            }),
          },
        );

      it('a confirmed marker suppresses the false "does not contain" alarm', async () => {
        const res = await run('MY_FIX_MARKER', 'before MY_FIX_MARKER after');
        // The file is still NOT byte-identical — that stays honestly reported…
        expect(res.changeInCandidate.judgingContainsPath).toBe(false);
        // …but the question the caller asked is now answered, with evidence.
        expect(res.changeInCandidate.markerJudging?.present).toBe(true);
        expect(res.changeInCandidate.markerJudging?.count).toBe(1);
        // The alarm and the re-fire advice are what cost the outage; both must be gone.
        expect(res.notes.join(' ')).not.toMatch(/CANDIDATE DOES NOT CONTAIN THIS FILE/);
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change/);
        expect(res.changeInCandidate.detail).toMatch(/Do NOT re-fire/);
      });

      /**
       * EI-19321297903353500: the "Do NOT re-fire" imperative answers for ONE path, but
       * was phrased as a conclusion about the RUN — a session with several changes in
       * flight across different paths (landing in different commits) would read "do NOT
       * re-fire" for a path that IS covered while another path it also changed is NOT,
       * and let a doomed run hold the gate singleton. The advice must name the path it
       * covers and explicitly say other changed paths need their own check.
       */
      it('EI-19321297903353500: the re-fire verdict is scoped to THIS path, not the whole change-set', async () => {
        const res = await run('MY_FIX_MARKER', 'before MY_FIX_MARKER after');
        // Must name the exact path this verdict is about…
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change TO a\.ts/);
        expect(res.changeInCandidate.detail).toMatch(/Do NOT re-fire FOR a\.ts/);
        // …and must not let the reader generalise it to every file they touched.
        expect(res.changeInCandidate.detail).toMatch(/PER-PATH, not per-run/);
        expect(res.changeInCandidate.detail).toMatch(/re-check each other changed path separately/i);
      });

      it('an absent marker still warns — the exoneration is not blanket', async () => {
        const res = await run('MY_FIX_MARKER', 'this commit predates the fix');
        expect(res.changeInCandidate.markerJudging?.present).toBe(false);
        expect(res.changeInCandidate.detail).toMatch(/does NOT carry your change/);
      });

      /**
       * REGRESSION GUARD for a defect found while fixing the above: a `const marker =
       * inp.marker` added inside the consuming block SHADOWED the validated binding, and
       * nothing caught it — tsc is happy, and no test covered an invalid marker. With the
       * guard bypassed, a whitespace marker substring-matches indentation: measured at 542
       * hits against the real repo, i.e. a CONFIDENT WRONG "the candidate carries your
       * change" for a caller who supplied nothing. That is the precise failure this
       * module's contract forbids, so it is asserted rather than left to review.
       */
      it('a whitespace-only marker is NOT measured, however many times it would match', async () => {
        const res = await run('   ', 'a\n   indented\n   lines\n   everywhere');
        expect(res.changeInCandidate.markerJudging).toBeNull();
        expect(res.changeInCandidate.detail).not.toMatch(/DOES carry your change/);
      });

      it('no marker ⇒ not measured, and the honest ambiguity is preserved', async () => {
        const res = await run(undefined, 'irrelevant');
        expect(res.changeInCandidate.markerJudging).toBeNull();
        expect(res.changeInCandidate.missingReason).toBe('newer-commit');
        expect(res.changeInCandidate.detail).toMatch(/UNRESOLVED/);
      });
    });

    /**
     * EI-19325709344484737 — `present` is a SUBSTRING test, so it proves the marker
     * string is there, never that the CHANGE is. For a marker that is not unique to the
     * edit (a common identifier already in the file) a candidate cut BEFORE the fix reads
     * as carrying it, and the surface then emits a confident exoneration plus "Do NOT
     * re-fire".
     *
     * Reproduced from the real 2026-08-02 incident: marker 'backingTables' occurred 14×
     * in judged candidate 1ee32228 and 16× at tip; the candidate did NOT carry the fix
     * (`git show <candidate>:<path> | grep harness_shared.operator_turns` → 0 hits) yet
     * the tool said it did. Believing it would have left main pinned behind a run that
     * provably could not green.
     */
    describe('marker containment — a NON-UNIQUE marker must not exonerate (EI-19325709344484737)', () => {
      /** judged carries the marker FEWER times than tip ⇒ it lacks part of the change. */
      const splitGit =
        (atJudging: string, atNext: string): GitRunner =>
        async (_repo, args) => {
          if (args[0] === 'status') return 'M a.ts';
          if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
          if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
          if (args[0] === 'rev-list') return '0';
          if (args[0] === 'merge-base') return args[1];
        if (args[0] === 'merge-base') return args[1];
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith('^{commit}')) return 'c'.repeat(40);
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'judging1:a.ts') return '0'.repeat(40);
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'next1:a.ts') return '1'.repeat(40);
          if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD:a.ts') return 'f'.repeat(40);
          if (args[0] === 'hash-object') return 'f'.repeat(40);
          if (args[0] === 'ls-tree') return `100644 blob ${'e'.repeat(40)}\ta.ts`;
          if (args[0] === 'show') return args.some((a) => String(a).startsWith('next1:')) ? atNext : atJudging;
          return null;
        };

      const runSplit = (marker: string, atJudging: string, atNext: string) =>
        gitPipelinePosition(
          { path: 'a.ts', marker },
          {
            git: splitGit(atJudging, atNext),
            loadDeploy: async () => deploy(),
            ...activeCandidateDeps('judging1'),
            resolveGateCandidates: async () => ({
              judgingSha: 'judging1',
              judgingShaSource: 'in-flight-candidate',
              nextCandidateSha: 'next1',
            }),
          },
        );

      it('does NOT exonerate a candidate carrying FEWER occurrences than tip', async () => {
        // 2 occurrences judged, 3 at tip — the shape of 14-vs-16.
        const res = await runSplit(
          'backingTables',
          'backingTables x backingTables',
          'backingTables x backingTables y backingTables',
        );
        expect(res.changeInCandidate.markerJudging?.count).toBe(2);
        expect(res.changeInCandidate.markerNext?.count).toBe(3);
        // The exoneration and its imperative are the two things that cost the outage.
        expect(res.changeInCandidate.detail).not.toMatch(/DOES carry your change/);
        expect(res.changeInCandidate.detail).not.toMatch(/Do NOT re-fire/);
        // It must say what is actually true, and point at the check that IS definitive.
        expect(res.changeInCandidate.detail).toMatch(/PART of the change/);
        /**
         * ANCESTRY is the definitive check — NOT release:checkpoint-run's
         * callerEditsInCandidate, which this assertion originally demanded.
         *
         * That field carries the SAME false-miss defect (EI-19326775809436764, measured
         * 2026-08-02 08:00Z): it compares the path's CURRENT content, so on a file the
         * fleet edits, any peer commit landing after yours reports your change missing
         * from a candidate that provably contains it — and then prescribes a ~55min
         * re-fire. Sending the reader there would have relocated this bug, not fixed it.
         *
         * So the detail must name the canonical ancestry reader AND explicitly warn the
         * reader off the containment field. `callerEditsInCandidate` still appears in the string —
         * as the thing NOT to use — which is why this pins the warning phrasing rather
         * than merely asserting the substring is absent.
         */
        expect(res.changeInCandidate.detail).toMatch(/release:trace[\s\S]*gate\.fixCommitContainment\.verdict/);
        expect(res.changeInCandidate.detail).not.toMatch(/git merge-base --is-ancestor/);
        expect(res.changeInCandidate.detail).toMatch(/Do NOT hand-run merge-base/);
        expect(res.changeInCandidate.detail).toMatch(/settle it with[\s\S]*callerEditsInCandidate/);
        // …and the marker note itself must carry the WARNING glyph, never the reassuring
        // ✓ (the position ticks legitimately use ✓, so this pins the note's own prefix).
        expect(res.summary).toMatch(/⚠ The gate's judged candidate/);
        expect(res.summary).not.toMatch(/✓ The gate's judged candidate/);
      });

      it('an EQUAL count still confirms — this must not fire on the honest case', async () => {
        const res = await runSplit('MY_FIX_MARKER', 'x MY_FIX_MARKER y', 'x MY_FIX_MARKER y');
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change/);
        expect(res.changeInCandidate.detail).not.toMatch(/PART of the change/);
      });

      it('a UNIQUE marker present once on both sides confirms with no caveat', async () => {
        const res = await runSplit('UNIQ_MARK', 'a UNIQ_MARK b', 'a UNIQ_MARK b');
        expect(res.changeInCandidate.markerJudging?.count).toBe(1);
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change/);
        expect(res.changeInCandidate.detail).not.toMatch(/not unique to your change/);
      });

      it('a non-unique marker that IS fully present still warns that it cannot discriminate', async () => {
        const res = await runSplit('common', 'common common', 'common common');
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change/);
        // Equal counts cannot prove absence, but a repeated marker cannot prove presence
        // of the CHANGE either — say so rather than implying certainty.
        expect(res.changeInCandidate.detail).toMatch(/not unique to your change/);
      });
    });

    /**
     * P-011 (main-green-status-visible-2026-09-03, audit entry 5): a path inside a
     * SUBMODULE is measured THROUGH THE GITLINK, not skipped.
     *
     * Before this item the block above was guarded `!submodule` and a submodule path
     * came back `not-applicable` with a prose pointer at the five-command hand recipe in
     * CLAUDE.md (~37 submodules here; every DB migration lives in one). The superproject
     * stores only a gitlink, so `rev-parse <cand>:<sub>/<rel>` is ABSENT there — which is
     * exactly why the old `false` would have been a lie and the old `null` was the honest
     * fallback. The classifier now resolves the pin the candidate carries and compares
     * INSIDE the submodule, so the cell answers the question the recipe answered by hand.
     */
    describe('a path inside a SUBMODULE is measured through the gitlink (P-011)', () => {
      const SUB = 'libs/papercusp';
      const REL = 'libs/db/sql/727-thing.sql';
      const FILE = `${SUB}/${REL}`;
      const FIXED = 'f'.repeat(40);
      const OLD = '0'.repeat(40);

      /**
       * Superproject + nested store, modelled the way real git behaves at the boundary:
       * a `<cand>:<sub>/<rel>` read FAILS from the root (the root holds a gitlink), while
       * `hash-object` on the same path succeeds from the root (bytes on disk hash fine —
       * the trap). Reads routed with an accumulated `-C <sub>` — or issued with the
       * submodule's own gitDir — land in the nested store.
       */
      function submoduleGit(o: {
        /** the gitlink each candidate carries; null = absent (the candidate predates the sub); 'unreadable' = the read fails */
        pin: string | null | 'unreadable';
        pinBlob?: string;
        headBlob?: string;
        treeBlob?: string;
        /** the pinned commit's CONTENT for the file — what a marker is counted in */
        pinContent?: string;
      }): GitRunner {
        const nested = async (args: string[]): Promise<string | null> => {
          if (args[0] === 'rev-parse' && args[1] === '--verify') {
            if (args[2].endsWith('^{commit}')) return 'c'.repeat(40);
            if (o.pin && o.pin !== 'unreadable' && args[2] === `${o.pin}:${REL}`) return o.pinBlob ?? null;
            if (args[2] === `HEAD:${REL}`) return o.headBlob ?? null;
            return null;
          }
          if (args[0] === 'hash-object') return o.treeBlob ?? null;
          if (args[0] === 'ls-tree') return o.pinBlob ? `100644 blob deadbeef\t${REL}` : '';
          if (args[0] === 'show') return o.pinContent ?? null;
          if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
          if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
          if (args[0] === 'rev-list') return '0';
          if (args[0] === 'merge-base') return args[1];
        if (args[0] === 'merge-base') return args[1];
          if (args[0] === 'status') return '';
          return null;
        };
        return async (repo, args) => {
          if (args[0] === '-C') return nested(args.slice(2)); // gitReadInSubdir
          if (repo !== '/repo') return nested(args); // gitDir = <root>/<sub>
          if (args[0] === 'config') return `submodule.x.path ${SUB}`;
          if (args[0] === 'status') return '';
          if (args[0] === 'ls-tree') {
            if (o.pin === 'unreadable') return null;
            return o.pin ? `160000 commit ${o.pin}\t${SUB}` : '';
          }
          if (args[0] === 'rev-parse' && args[1] === '--verify') {
            if (args[2].endsWith('^{commit}')) return 'c'.repeat(40);
            return null; // `<cand>:<sub>/<rel>` — the root holds a gitlink, never the blob
          }
          if (args[0] === 'hash-object') return FIXED; // succeeds on disk from the root: the trap
          if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
          if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
          if (args[0] === 'rev-list') return '0';
          if (args[0] === 'merge-base') return args[1];
        if (args[0] === 'merge-base') return args[1];
          return null;
        };
      }

      const run = (o: Parameters<typeof submoduleGit>[0], marker?: string) =>
        gitPipelinePosition(
          { path: FILE, ...(marker ? { marker } : {}) },
          {
            git: submoduleGit(o),
            loadDeploy: async () => deploy(),
            ...activeCandidateDeps('cand1'),
            resolveGateCandidates: async () => ({
              judgingSha: 'cand1',
              judgingShaSource: 'in-flight-candidate',
              nextCandidateSha: 'cand1',
            }),
          },
        );

      it('CONTAINED when the superproject blob is ABSENT but the pinned submodule commit carries the fix', async () => {
        const res = await run({ pin: 'e0ebb3c6e0ebb3c6', pinBlob: FIXED, headBlob: FIXED, treeBlob: FIXED });
        expect(res.submodule).toBe(SUB);
        expect(res.changeInCandidate.judgingSha).toBe('cand1');
        // The regression guard proper: the old code said null here and pointed at the recipe.
        expect(res.changeInCandidate.judgingContainsPath).toBe(true);
        expect(res.changeInCandidate.nextContainsPath).toBe(true);
        expect(res.changeInCandidate.missingReason).toBeNull();
        // The PIN the hand recipe made agents compute is surfaced, per candidate.
        expect(res.changeInCandidate.submodule).toEqual({
          path: SUB,
          relPath: REL,
          judgingPin: 'e0ebb3c6e0ebb3c6',
          nextPin: 'e0ebb3c6e0ebb3c6',
        });
        expect(res.changeInCandidate.detail).toMatch(/DOES carry the current content of/);
        expect(res.changeInCandidate.detail).toMatch(/resolved through submodule 'libs\/papercusp'/);
        expect(res.assessments.gateCandidate).toBe('judging-current-path');
        // Neither the old blanket not-applicable hoist nor a containment hoist fires.
        expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('changeInCandidate.judgingSha');
        expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('changeInCandidate.judgingContainsPath');
      });

      it('NOT contained when the gitlink was not bumped: the pin predates the fix, and the lever names the superproject bump', async () => {
        // A gitlink is a sha: the pin must be hex or the 160000 regex (correctly) rejects it.
        const res = await run({ pin: '0ddb1c000ddb1c00', pinBlob: OLD, headBlob: FIXED, treeBlob: FIXED });
        expect(res.changeInCandidate.judgingContainsPath).toBe(false);
        // Committed inside the submodule, so the lever is NOT git-sync:run on the file.
        expect(res.changeInCandidate.missingReason).toBe('newer-commit');
        expect(res.changeInCandidate.submodule?.judgingPin).toBe('0ddb1c000ddb1c00');
        expect(res.changeInCandidate.detail).toMatch(/SUPERPROJECT gitlink bump/);
        expect(res.changeInCandidate.detail).toMatch(/no hand-run/);
        expect(res.assessments.gateCandidate).toBe('judging-without-current-path');
        expect(res.notes.join(' ')).toMatch(/CANDIDATE DOES NOT CONTAIN THIS FILE/);
      });

      it('a candidate that PREDATES the submodule (no gitlink) is a definitive miss with a null pin', async () => {
        const res = await run({ pin: null, headBlob: FIXED, treeBlob: FIXED });
        expect(res.changeInCandidate.judgingContainsPath).toBe(false);
        expect(res.changeInCandidate.submodule?.judgingPin).toBeNull();
        expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('changeInCandidate.judgingContainsPath');
      });

      it('an UNREADABLE gitlink is hoisted as resolver-failed on the containment leg — never not-applicable, never a verdict', async () => {
        const res = await run({ pin: 'unreadable', headBlob: FIXED, treeBlob: FIXED });
        expect(res.changeInCandidate.judgingContainsPath).toBeNull();
        expect(res.changeInCandidate.nextContainsPath).toBeNull();
        expect(res.changeInCandidate.submodule).toEqual({ path: SUB, relPath: REL, judgingPin: null, nextPin: null });
        const leg = res.verdictUnknown.find((v) => v.leg === 'changeInCandidate.judgingContainsPath');
        expect(leg?.unknown.code).toBe('resolver-failed');
        expect(leg?.unknown.detail).toMatch(/gitlink/);
        // The old blanket hoist is gone: this is a measurement that FAILED, not a question
        // that does not apply — `assessGateCandidate` must not read it as an answer.
        expect(res.verdictUnknown.map((v) => v.leg)).not.toContain('changeInCandidate.judgingSha');
        expect(res.assessments.gateCandidate).toBeNull();
      });

      it('a MARKER is counted inside the pinned submodule commit, not against the superproject gitlink', async () => {
        // Blob identity says "newer-commit" (peer edits after the pin), but the marker
        // settles it: the pinned commit's content DOES carry the change.
        const res = await run(
          { pin: 'e0ebb3c6e0ebb3c6', pinBlob: OLD, headBlob: FIXED, treeBlob: FIXED, pinContent: 'x MY_SUB_MARK y' },
          'MY_SUB_MARK',
        );
        expect(res.changeInCandidate.markerJudging?.sha).toBe('cand1');
        expect(res.changeInCandidate.markerJudging?.present).toBe(true);
        expect(res.changeInCandidate.markerJudging?.count).toBe(1);
        expect(res.changeInCandidate.detail).toMatch(/DOES carry your change/);
        expect(res.notes.join(' ')).not.toMatch(/CANDIDATE DOES NOT CONTAIN THIS FILE/);
      });

      it('a marker ABSENT from the pinned commit is a definitive miss, with pathPresent from the nested store', async () => {
        const res = await run(
          { pin: 'e0ebb3c6e0ebb3c6', pinBlob: OLD, headBlob: FIXED, treeBlob: FIXED, pinContent: 'nothing here' },
          'MY_SUB_MARK',
        );
        expect(res.changeInCandidate.markerJudging?.present).toBe(false);
        expect(res.changeInCandidate.markerJudging?.pathPresent).toBe(true);
        expect(res.changeInCandidate.detail).toMatch(/does NOT carry your change/);
      });
    });

    it('a failing candidate resolver degrades to UNKNOWN, never to a false all-clear', async () => {
      const git = fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } });
      const res = await gitPipelinePosition(
        { path: 'a.ts' },
        {
          git,
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
          resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
        },
      );
      expect(res.changeInCandidate.judgingContainsPath).toBeNull();
      expect(res.changeInCandidate.nextContainsPath).toBeNull();
      expect(res.summary).not.toMatch(/⚠ The gate run/);
    });
  });
});

/**
 * EI-19327418148563597 — full-entry-point wiring for the "LIVE CODE DIFFERS FROM
 * SOURCE" note: while the gate is red, `:3070`'s release checkout can lag the staging
 * tree by hours (not the usual ~15 minutes), long enough that profiling the live box
 * measures pre-fix code while the fix already sits, verified, in the tree open in
 * front of the caller. The check only applies to a RELEASE-PIPELINE path (the release
 * checkout is irrelevant to a working-tree tsx host like bg-host/gateway/embed-sidecar,
 * which never reads it), and only when a release root is actually known.
 */
describe('gitPipelinePosition: release-content-drift note (EI-19327418148563597)', () => {
  // Same fixture evaluateServing's tests use — a path classified as a RELEASE-PIPELINE
  // consumer (served by :3070 off the release checkout), as opposed to bgHostRuntime.
  const releasePath = 'packages/operator-core/lib/x.ts';

  const minimalGit: GitRunner = async (_repo, args) => {
    if (args[0] === 'status') return '';
    if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
    if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
    if (args[0] === 'rev-list') return '0';
    if (args[0] === 'merge-base') return args[1];
    return null;
  };

  it('warns when the release checkout serves DIFFERENT bytes than the working tree', async () => {
    const res = await gitPipelinePosition(
      { path: releasePath },
      {
        git: minimalGit,
        loadDeploy: async () => deploy({ releaseRoot: '/release' }),
        loadSnapshot: async () => snap(),
        readFileBytes: async (absPath: string) =>
          absPath.startsWith('/release') ? Buffer.from('old, pre-fix code') : Buffer.from('new, fixed code'),
      },
    );
    expect(res.notes.join(' ')).toMatch(/LIVE CODE DIFFERS FROM SOURCE/);
    expect(res.notes.join(' ')).toContain(releasePath);
    expect(res.notes.join(' ')).toContain('/release');
  });

  it('stays silent when the release checkout is byte-identical to the working tree', async () => {
    const res = await gitPipelinePosition(
      { path: releasePath },
      {
        git: minimalGit,
        loadDeploy: async () => deploy({ releaseRoot: '/release' }),
        loadSnapshot: async () => snap(),
        readFileBytes: async () => Buffer.from('same code everywhere'),
      },
    );
    expect(res.notes.join(' ')).not.toMatch(/LIVE CODE DIFFERS FROM SOURCE/);
  });

  it('stays silent (never a false alarm) when either read failed', async () => {
    const res = await gitPipelinePosition(
      { path: releasePath },
      {
        git: minimalGit,
        loadDeploy: async () => deploy({ releaseRoot: '/release' }),
        loadSnapshot: async () => snap(),
        readFileBytes: async () => null,
      },
    );
    expect(res.notes.join(' ')).not.toMatch(/LIVE CODE DIFFERS FROM SOURCE/);
  });

  it('does NOT run the check for a working-tree host — the release checkout is irrelevant to it', async () => {
    // bg-host tsx-loads the working tree directly; it never reads `papercup-release`,
    // so a byte mismatch there says nothing about what bg-host is running.
    const bgPath = 'packages/operator-core/lib/inference-gateway/admission.ts';
    expect(classifyRuntimeOwner(bgPath)?.releasePipelineApplies).toBe(false);
    const readFileBytes = vi.fn(async (absPath: string) =>
      absPath.startsWith('/release') ? Buffer.from('a') : Buffer.from('b'),
    );
    const res = await gitPipelinePosition(
      { path: bgPath },
      {
        git: minimalGit,
        loadDeploy: async () => deploy({ releaseRoot: '/release' }),
        loadSnapshot: async () => snap(),
        readFileBytes,
      },
    );
    expect(res.notes.join(' ')).not.toMatch(/LIVE CODE DIFFERS FROM SOURCE/);
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it('does NOT run the check when no release root is known (default deploy() fixture)', async () => {
    const readFileBytes = vi.fn(async () => Buffer.from('irrelevant'));
    const res = await gitPipelinePosition(
      { path: releasePath },
      { git: minimalGit, loadDeploy: async () => deploy(), loadSnapshot: async () => snap(), readFileBytes },
    );
    expect(res.notes.join(' ')).not.toMatch(/LIVE CODE DIFFERS FROM SOURCE/);
    expect(readFileBytes).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------- *
 * P-005 — blockedOn + nextAction.
 *
 * `stages[]` gives six position×health readings. This answers the question the caller
 * actually arrived with: "is my change live, and if not what is the ONE thing blocking
 * it" — the task that cost 11 tool calls and 4 hand-diffs on 2026-07-26 and STILL went
 * wrong twice, because deciding which of six stages owned the next move was left to the
 * reader.
 *
 * The invariant these protect: THREE distinct states. Collapsing "waiting is correct"
 * into "here is a lever" manufactures busywork (and, on the push/deploy legs, an
 * unnecessary forced run); collapsing it into "nothing is pending" claims the change is
 * live when it is not.
 * ------------------------------------------------------------------------- */
describe('deriveBlocker (P-005)', () => {
  const st = (name: StageName, position: 'past' | 'pending' | 'na', lever: string | null = null): StageState => ({
    name,
    plane: name === 'pushed' ? 'publish' : 'delivery',
    position,
    health: 'advancing',
    detail: null,
    lever,
  });

  it('nothing pending ⇒ null/null — the change is live', () => {
    expect(deriveBlocker([st('committed', 'past'), st('serving', 'past')])).toEqual({
      blockedOn: null,
      nextAction: null,
      actionOwner: null,
    });
  });

  /**
   * Caught by a LIVE run, not a fixture. A healthy publish side leg with the gate RED
   * behind it must not mask the delivery blocker or become one itself.
   */
  it('a self-advancing early stage must NOT mask an actionable stage behind it', () => {
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'pending', null), // publish/durability side leg, not a delivery prerequisite
      st('gate', 'pending', 'fix the reds, then release:checkpoint-run'),
    ]);
    expect(r.blockedOn).toBe('gate');
    expect(r.nextAction).toMatch(/fix the reds/);
    expect(r.actionOwner).toBe('gate');
  });

  it('an EARLIER stage with a lever still wins — you cannot green a gate for uncommitted work', () => {
    const r = deriveBlocker([st('committed', 'pending', 'git-sync:run'), st('gate', 'pending', 'fix the reds')]);
    expect(r.blockedOn).toBe('committed');
    expect(r.nextAction).toBe('git-sync:run');
    expect(r.actionOwner).toBe('committed');
  });

  it('picks the first pending DELIVERY stage and ignores a publish-side remedy', () => {
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'pending', 'git-sync:run'),
      st('gate', 'pending', 'release:checkpoint-run'),
    ]);
    expect(r.blockedOn).toBe('gate');
    expect(r.nextAction).toBe('release:checkpoint-run');
  });

  it('a frozen publish side leg cannot turn an otherwise-live delivery into a block', () => {
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'pending', 'repair the p2p publish bridge'),
      st('gate', 'past'),
      st('main', 'past'),
      st('deployed', 'past'),
      st('serving', 'past'),
    ]);
    expect(r).toEqual({ blockedOn: null, nextAction: null, actionOwner: null });
  });

  it("SKIPS `na` stages — they are not on this change's route, so they cannot block it", () => {
    // The bg-host/gateway case: gate/main/deployed are `na`, and reporting one of them as
    // the blocker would send the caller to wait for a deploy that can never carry the code.
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'past'),
      st('gate', 'na'),
      st('main', 'na'),
      st('deployed', 'na'),
      st('serving', 'pending', 'dev:restart { target: "bg-host" }'),
    ]);
    expect(r.blockedOn).toBe('serving');
    expect(r.nextAction).toBe('dev:restart { target: "bg-host" }');
  });

  it('a pending stage with NO lever anywhere reports the block with a null action — waiting IS the answer', () => {
    const r = deriveBlocker([st('committed', 'past'), st('pushed', 'pending', null), st('gate', 'pending', null)]);
    expect(r.blockedOn).toBe('gate');
    // Distinct from "nothing is pending" (blockedOn null) and from "do this" (action set).
    expect(r.nextAction).toBeNull();
    expect(r.actionOwner).toBeNull();
  });
});

describe('stage levers (P-005)', () => {
  type StageInput = Parameters<typeof computeStages>[0];
  const BASELINE: StageInput = {
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    gate: {
      stalled: false,
      consecutiveReds: 0,
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
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
    },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    serving: HEALTHY_SERVING,
    changeInCandidate: NO_CANDIDATE,
    sweepExposure: NO_SWEEP,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
  };
  const stagesFor = (over: Partial<StageInput>): StageState[] => computeStages({ ...BASELINE, ...over });
  const lever = (name: StageName, over: Partial<StageInput>): string | null => {
    const s = stagesFor(over).find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s.lever;
  };

  /* EI-19311755730915969 fixtures — the gate state where "nothing to do" is a LIE, and
   * the three possible readings of "is a run in flight". `judgingSha` is deliberately
   * NOT one of them: it names which commit was judged, not whether anything is running. */
  const RED_GATE: StageInput['gate'] = {
    stalled: true,
    consecutiveReds: 5,
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
    candidateFailures: null,
    ownerBrief: null, qualification: NO_QUALIFICATION,
  };
  /** A suite really is running — the EI-18797292094433710 state, where waiting IS the lever. */
  const IN_FLIGHT = {
    active: true,
    candidate: 'inflight123456',
    startedAtMs: 1,
    elapsedSec: 600,
    asOfAgeMs: 5_000,
  };
  /** MEASURED idle: the last run COMPLETED. Nothing is coming on its own. */
  const IDLE = { active: false, candidate: null, startedAtMs: null, elapsedSec: null, asOfAgeMs: 5_000 };
  const NOT_IN_MAIN = { committedLocal: true, onStaging: true, inMain: false, deployed: false };
  /** A candidate that demonstrably carries the change — the arm that reported "nothing to do". */
  const COVERED = { ...NO_CANDIDATE, judgingSha: 'lastjudged12', judgingContainsPath: true };

  it('uncommitted work routes to git-sync:run', () => {
    expect(lever('committed', { dirtyUncommitted: true })).toMatch(/git-sync:run/);
  });

  /**
   * The push leg between ticks is the case a lever would actively HARM: git-sync pushes
   * within ~10 min on its own, so offering a forced run invites needless work. A FAULTED
   * leg never self-clears, so it must not read the same way.
   */
  it('a healthy push leg between ticks offers NO lever; a faulted one does', () => {
    const healthy = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
    });
    expect(healthy).toBeNull();

    const faulted = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
      gitSync: { ...HEALTHY_GIT_SYNC, consecutiveErrorTicks: 3, errors: ['boom'] },
    });
    expect(faulted).toMatch(/git-sync:run/);

    const conflicted = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
      gitSync: { ...HEALTHY_GIT_SYNC, conflicts: ['libs/x'] },
    });
    expect(conflicted).toMatch(/merge-resolver/);
  });

  it('containment OUTRANKS a red gate — judging a candidate without your change buys nothing', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: {
        stalled: true,
        consecutiveReds: 3,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      changeInCandidate: { ...NO_CANDIDATE, judgingContainsPath: false, missingReason: 'uncommitted' },
    });
    expect(l).toMatch(/git-sync:run/);
    expect(l).not.toMatch(/fix the reds/);
  });

  it('a red gate with the change present routes to fixing the reds, not waiting', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: {
        stalled: true,
        consecutiveReds: 3,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
    });
    expect(l).toMatch(/fix the reds/);
  });

  it.each([
    'pin-advance',
    'pin-advance-unordered',
    'writer-starved',
    'run-in-flight',
    'retriage-proven',
    'refire-in-flight',
    'candidate-fossil',
  ] as const)('EI-21347137633438058: stale reason %s never dispatches stale-red repair advice', (reasonCode) => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: { ...RED_GATE, verdictStale: true, verdictStaleReasonCode: reasonCode },
      changeInCandidate: COVERED,
    });

    expect(l).toMatch(/Verify the CURRENT candidate before fixing anything/);
    expect(l).not.toMatch(/fix the reds|release:checkpoint-run/i);
  });

  it('EI-21347137633438058: leaves null and unrelated levers untouched', () => {
    expect(staleVerdictSafeLever('candidate-fossil', null)).toBeNull();
    expect(staleVerdictSafeLever('candidate-fossil', 'db:migrate')).toBe('db:migrate');
    expect(staleVerdictSafeLever(null, 'fix the reds')).toBe('fix the reds');
  });

  /**
   * EI-22173032622074833 — the frozen-repair-queue veto.
   *
   * `release:checkpoint-run` always cuts a FRESH candidate at tip, so recommending it while a
   * repair queue is frozen discards that queue and restarts the treadmill freeze-and-converge
   * exists to prevent. The lever ternary already had a `repairQueue.nextAction` arm, but only
   * in the branch reached when the judged candidate ALREADY CONTAINS the change — and a frozen
   * candidate necessarily ages behind the tree, so `notInCandidate` is the STEADY STATE of a
   * live queue. These pin the arm that was actually reachable.
   */
  const FROZEN_QUEUE: NonNullable<PipelinePosition['gate']['repairQueue']> = {
    phase: 'awaiting-fixer',
    candidate: 'a'.repeat(40),
    repairHead: 'b'.repeat(40),
    attempts: 1,
    openedAtMs: 1,
    updatedAtMs: 2,
    ageMs: 60_000,
    ageEscalationRung: 0,
    repairLatency: frozenRepairLatency({ openedAtMs: 1, phase: 'awaiting-fixer' }, 60_001),
    ageEscalationIntervalMs: 8 * 60 * 60_000,
    zeroAttemptStalled: false,
    zeroAttemptStallMs: 15 * 60_000,
    fixerSpawnId: 'dead-fixer',
    fixerAlive: false,
    legs: [],
    signature: [],
    admissions: [],
    blockedReason: null,
    dispatchReservation: null,
    manifest: null,
    manifestSummary: null,
    sharedTreeCollision: {
      measured: false,
      repairInFlight: false,
      collidingPaths: [],
      collisionCount: 0,
      truncated: false,
      detail: null,
    },
    decision: 'recover-dead-fixer',
    retireAllowed: true,
    retireRefusal: null,
    nextAction:
      "decision 'recover-dead-fixer': this queue is still recoverable — do NOT retire it. Land your fix on the judged lineage with release:repair-queue { op: 'converge', paths: ['<your changed path>'] }.",
  };

  /** The judged candidate predates the commit — the exact arm that routed to
   *  "wait out the quiet-cut window, then release:checkpoint-run". */
  const PREDATES_COMMIT = {
    ...NO_CANDIDATE,
    judgingSha: 'lastjudged12',
    judgingContainsPath: false,
    missingReason: 'newer-commit' as const,
  };

  it('EI-22173032622074833: a live frozen repair queue vetoes the quiet-cut re-cut lever', () => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: { ...RED_GATE, checkpointRunInFlight: IDLE, repairQueue: FROZEN_QUEUE },
      changeInCandidate: PREDATES_COMMIT,
    });
    expect(l).not.toMatch(/release:checkpoint-run/i);
    expect(l).toBe(FROZEN_QUEUE.nextAction);
  });

  /**
   * CALIBRATION for the assertion above. Without it, a guard that suppressed the re-cut lever
   * UNCONDITIONALLY would pass that test while destroying a legitimate re-fire — the failure
   * mode is a veto that looks like safety and is really a wedge.
   */
  it('EI-22173032622074833: CONTROL — with NO queue the same state still routes to the quiet-cut lever', () => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: { ...RED_GATE, checkpointRunInFlight: IDLE },
      changeInCandidate: PREDATES_COMMIT,
    });
    expect(l).toMatch(/quiet-cut/);
    expect(l).toMatch(/release:checkpoint-run/);
  });

  it('EI-22173032622074833: a queue held by a LIVE fixer has no nextAction — the veto still names why', () => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: {
        ...RED_GATE,
        checkpointRunInFlight: IDLE,
        repairQueue: {
          ...FROZEN_QUEUE,
          fixerAlive: true,
          decision: 'wait-for-fixer',
          retireAllowed: false,
          retireRefusal: 'live-fixer',
          nextAction: null,
        },
      },
      changeInCandidate: PREDATES_COMMIT,
    });
    expect(l).toMatch(/Do NOT cut a fresh candidate/);
    expect(l).toMatch(/a live fixer holds it/);
    expect(l).toMatch(/op: 'converge'/);
  });

  /**
   * The two vetoes COMPOSE, and the order is load-bearing. Run the other way round, the stale
   * guard rewrites a `release:checkpoint-run` lever into its own caution, which no longer
   * matches the re-cut pattern — so the queue's concrete converge instruction would be
   * swallowed exactly when both conditions hold. This also pins the wording constraint: the
   * veto sentence must avoid the tokens `staleVerdictSafeLever` matches, or it rewrites itself.
   */
  it('EI-22173032622074833: a stale verdict does NOT swallow the repair-queue instruction', () => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: {
        ...RED_GATE,
        verdictStale: true,
        verdictStaleReasonCode: 'candidate-fossil',
        checkpointRunInFlight: IDLE,
        repairQueue: FROZEN_QUEUE,
      },
      changeInCandidate: PREDATES_COMMIT,
    });
    expect(l).toBe(FROZEN_QUEUE.nextAction);
    expect(l).not.toMatch(/Verify the CURRENT candidate before fixing anything/);

    // …and the same must hold for the no-nextAction veto, whose text is the one at risk.
    const held = safeGateLever(
      {
        ...RED_GATE,
        verdictStaleReasonCode: 'candidate-fossil',
        repairQueue: { ...FROZEN_QUEUE, retireAllowed: false, retireRefusal: 'live-fixer', nextAction: null },
      } as PipelinePosition['gate'],
      'wait out the quiet-cut window (~4 min), then release:checkpoint-run — the judged candidate predates your commit',
    );
    expect(held).toMatch(/Do NOT cut a fresh candidate/);
    expect(held).toMatch(/op: 'converge'/);
  });

  it('EI-22173032622074833: leaves null, unrelated and queue-less levers untouched', () => {
    expect(frozenRepairQueueSafeLever(FROZEN_QUEUE, null)).toBeNull();
    expect(frozenRepairQueueSafeLever(FROZEN_QUEUE, 'git-sync:run')).toBe('git-sync:run');
    expect(frozenRepairQueueSafeLever(FROZEN_QUEUE, 'db:migrate')).toBe('db:migrate');
    // No queue at all: every lever, including a re-cut, passes through unchanged.
    expect(frozenRepairQueueSafeLever(null, 'release:checkpoint-run')).toBe('release:checkpoint-run');
    expect(frozenRepairQueueSafeLever(undefined, 'release:checkpoint-run')).toBe('release:checkpoint-run');

    // DELIBERATELY-WRONG CONTROL, kept permanently: the PRE-FIX composition was the stale
    // guard alone, and it leaves the unsafe re-cut lever standing for a live queue (its
    // trigger is `verdictStaleReasonCode`, which a frozen queue does not set). If this ever
    // starts suppressing on its own, the assertions above stop measuring the new guard and
    // would keep passing while it was deleted.
    const QUIET_CUT =
      'wait out the quiet-cut window (~4 min), then release:checkpoint-run — the judged candidate predates your commit';
    expect(staleVerdictSafeLever(null, QUIET_CUT)).toBe(QUIET_CUT);
    expect(frozenRepairQueueSafeLever(FROZEN_QUEUE, QUIET_CUT)).toBe(FROZEN_QUEUE.nextAction);
  });

  /**
   * A terminal decision is the one state where retiring/re-cutting is legitimately on the
   * table, and the queue says so itself: `retirementIsTheDecision` renders the retire recipe
   * as its `nextAction`. Deferring to it is still the right move — the veto must hand over the
   * mechanism's own instruction rather than inventing a competing one.
   */
  it.each(['hold-dispatch-infeasible', 'hold-exhausted'] as const)(
    'EI-22173032622074833: a TERMINAL decision (%s) defers to the queue-authored retire recipe',
    (decision) => {
      const retire =
        "release:repair-queue { op: 'retire', expectedCandidate: 'aaaa', expectedRepairHead: 'bbbb', expectedUpdatedAtMs: 2, reason: '<why>', confirm: true }";
      const l = lever('gate', {
        positions: NOT_IN_MAIN,
        gate: {
          ...RED_GATE,
          checkpointRunInFlight: IDLE,
          repairQueue: { ...FROZEN_QUEUE, decision, nextAction: retire },
        },
        changeInCandidate: PREDATES_COMMIT,
      });
      expect(l).toBe(retire);
      expect(l).not.toMatch(/release:checkpoint-run/i);
    },
  );

  /**
   * Found by DOGFOODING this surface on a live stale red: the gate read 5 consecutive
   * reds, but a run was already in flight judging a candidate that carried the fix, so
   * a verdict clearing it was on its way.
   *
   * Telling the caller to fire release:checkpoint-run there is actively wrong: the gate
   * is a singleton, so a second fire is REFUSED — and the natural escalation from a
   * refusal is `replaceStale`, which is precisely the EI-11667 replace-storm that killed
   * every verdict for 2h on 2026-07-13. When a verdict covering your change is already
   * coming, waiting IS the lever.
   */
  it('an IN-FLIGHT run that carries the change ⇒ no lever, even with the gate red', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      // EI-19311755730915969: the in-flight-ness now comes from the field that MEASURES
      // it. This fixture used to carry only `judgingSha` and pass, which is precisely the
      // conflation that made "a verdict is coming" unfalsifiable.
      gate: { ...RED_GATE, checkpointRunInFlight: IN_FLIGHT },
      changeInCandidate: { ...NO_CANDIDATE, judgingSha: 'inflight123456', judgingContainsPath: true },
    });
    expect(l).toBeNull();
  });

  it('P-009: an ACTIVE run with no published candidate is WAIT-only and never offers a re-fire lever', () => {
    const stages = stagesFor({
      positions: NOT_IN_MAIN,
      gate: { ...RED_GATE, checkpointRunInFlight: IN_FLIGHT },
      changeInCandidate: NO_CANDIDATE,
    });
    const gate = stages.find((s) => s.name === 'gate');
    expect(gate?.health).toBe('stalled');
    expect(gate?.lever).toBeNull();
    expect(gate?.detail).toMatch(/A gate run IS in flight/);
    expect(gate?.detail).toMatch(/do NOT fire a second one/);
    expect(deriveBlocker(stages).nextAction).toBeNull();
    expect(JSON.stringify(stages)).not.toMatch(/release:checkpoint-run/i);
  });

  it('EI-18797292094433710: an in-flight run whose candidate merely PREDATES the newest edit offers NO lever — never a re-fire', () => {
    // The old behaviour routed this to "wait out the quiet-cut window, then
    // release:checkpoint-run". That is the single most expensive wrong lever this
    // surface can emit: `newer-commit` only means the file was committed again since
    // the cut, which a PEER's edit to the same file causes just as readily as your
    // own — so the in-flight candidate may already carry your change, and re-firing
    // discards a verdict minutes from landing to start a fresh ~55min clock. It did
    // exactly that twice during a 3h+ fleet-wide outage whose fix was in every
    // candidate the whole time. A run is in flight ⇒ a verdict is coming ⇒ wait.
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      // EI-19311755730915969: keyed to the MEASURED in-flight field — see the sibling test.
      gate: { ...RED_GATE, checkpointRunInFlight: IN_FLIGHT },
      changeInCandidate: {
        ...NO_CANDIDATE,
        judgingSha: 'inflight123456',
        judgingContainsPath: false,
        missingReason: 'newer-commit',
      },
    });
    expect(l).toBeNull();
  });

  /* -------------------------------------------------------------------------
   * EI-19311755730915969 / P-002 — the false all-clear.
   *
   * The two tests above are the state where a null lever is CORRECT: a suite is
   * measurably running, so a verdict really is coming. Everything below is the state
   * where the same null is a LIE — and until this fix both were reachable from the
   * identical fixture, because "in flight" was inferred from `judgingSha` (which commit
   * was judged) rather than from `checkpointRunInFlight.active` (whether anything is
   * running). On 2026-08-02 that reported `nextAction: null` — rendered "nothing to do —
   * this leg is advancing on its own" — on a gate that had been red ~6.7h with nothing
   * running and the reds already fixed in the tree, holding main for the whole fleet.
   * ------------------------------------------------------------------------- */
  it('EI-19311755730915969: a red gate whose run has COMPLETED offers the real lever, not "nothing to do"', () => {
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      // Same fixture as the in-flight test above in every respect EXCEPT the one field
      // that actually measures liveness. That is the whole bug in one diff.
      gate: { ...RED_GATE, checkpointRunInFlight: IDLE },
      changeInCandidate: COVERED,
    });
    expect(l).toMatch(/fix the reds/);
  });

  it('EI-19311755730915969: a CACHE-COLD in-flight reading is UNKNOWN — never silently "in flight"', () => {
    // `checkpointRunInFlight` was ABSENT from the very payload that misled the filer
    // (it is cache-backed; a cold DB / first routine tick / failed read all produce
    // this), and appeared as `{ active: false }` 14 min later. Defaulting an absence to
    // the reassuring answer is exactly how this fails silently, so UNKNOWN must route to
    // the lever — the caller is told the reading was unavailable via `detail`.
    const l = lever('gate', { positions: NOT_IN_MAIN, gate: RED_GATE, changeInCandidate: COVERED });
    expect(l).toMatch(/fix the reds/);
  });

  it('EI-19311755730915969: the newer-commit arm re-fires once the run it was waiting on has COMPLETED', () => {
    // The EI-18797292094433710 suppression is about not discarding a verdict that is
    // genuinely minutes from landing. Once that run has finished, there is no verdict to
    // discard and suppressing the lever just strands the caller.
    const l = lever('gate', {
      positions: NOT_IN_MAIN,
      gate: { ...RED_GATE, checkpointRunInFlight: IDLE },
      changeInCandidate: {
        ...NO_CANDIDATE,
        judgingSha: 'lastjudged12',
        judgingContainsPath: false,
        missingReason: 'newer-commit',
      },
    });
    expect(l).toMatch(/quiet-cut/);
  });

  /**
   * Assert the SHAPE that IS the bug, not one lever string: a `stalled` gate carrying
   * `lever: null` is what `deriveBlocker` turns into `nextAction: null` and the renderer
   * turns into "nothing to do". That sentence is only ever true when a verdict is really
   * coming, so it must be reachable ONLY from a MEASURED in-flight run — from no other
   * reading, and through none of the containment arms.
   */
  it('P-002: a STALLED gate goes lever-null ONLY for a measured in-flight run — nextAction stays real otherwise', () => {
    const readings: [string, StageInput['gate']['checkpointRunInFlight']][] = [
      ['measured idle (run completed)', IDLE],
      ['cache-cold — UNKNOWN', undefined],
      ['explicit null — UNKNOWN', null],
    ];
    const candidates: [string, StageInput['changeInCandidate']][] = [
      ['judged candidate carries the change', COVERED],
      [
        'judged candidate merely predates it',
        { ...NO_CANDIDATE, judgingSha: 'lastjudged12', judgingContainsPath: false, missingReason: 'newer-commit' },
      ],
      ['containment not measured at all', NO_CANDIDATE],
    ];
    for (const [reading, checkpointRunInFlight] of readings) {
      for (const [shape, changeInCandidate] of candidates) {
        const where = `${reading} / ${shape}`;
        const stages = stagesFor({
          positions: NOT_IN_MAIN,
          gate: { ...RED_GATE, checkpointRunInFlight },
          changeInCandidate,
        });
        const gate = stages.find((s) => s.name === 'gate');
        expect(gate?.health, where).toBe('stalled');
        expect(gate?.lever, where).not.toBeNull();
        // …and end-to-end: the caller must not be told the pipeline has this covered.
        expect(deriveBlocker(stages).nextAction, where).not.toBeNull();
      }
    }
  });

  it('P-002: a blocked gate SAYS which liveness reading it got — and never calls a cached one "measured"', () => {
    const detailFor = (checkpointRunInFlight: StageInput['gate']['checkpointRunInFlight']) =>
      stagesFor({
        positions: NOT_IN_MAIN,
        gate: { ...RED_GATE, checkpointRunInFlight },
        changeInCandidate: COVERED,
      }).find((s) => s.name === 'gate')?.detail;

    // The wait is justified with live evidence rather than left to be inferred from a
    // missing lever — "nothing to do" was read as "someone else has this".
    expect(detailFor(IN_FLIGHT)).toMatch(/A gate run IS in flight \(running ~10m\)/);
    expect(detailFor(IN_FLIGHT)).toMatch(/do NOT fire a second one/);
    /**
     * EI-19395922387569240: "measured" is now earned, not assumed. `IDLE` carries no
     * `activeSource`, i.e. it came from the cache — so the sentence must name the cache and
     * its age, and must NOT use the word "measured". Claiming measurement for a cache of
     * unbounded age (7h, live) is what routed this very lever to "fire release:checkpoint-run"
     * while a run was in flight.
     */
    expect(detailFor(IDLE)).toMatch(/NO gate run is in flight according to the run-liveness CACHE/);
    expect(detailFor(IDLE)).toMatch(/computed 5s ago/);
    expect(detailFor(IDLE)).not.toMatch(/measured/);
    // The same idle verdict, but read LIVE from the run lock, does earn it.
    const lockIdle = { ...IDLE, activeSource: 'run-lock' as const };
    expect(detailFor(lockIdle)).toMatch(/NO gate run is in flight \(measured live via the run lock\)/);
    // The unknown must read as unknown — and must not be mistakable for the idle answer.
    expect(detailFor(undefined)).toMatch(/UNKNOWN on this call/);
    expect(detailFor(undefined)).toMatch(/NOT evidence none is running/);
    expect(detailFor(undefined)).not.toMatch(/NO gate run is in flight/);
  });

  it('…but with NO run in flight, a next-candidate that predates the commit still routes to the quiet-cut lever', () => {
    // Nothing is coming on its own here, so firing IS the move — the guard above is
    // specifically about not throwing away an in-flight verdict.
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: {
        stalled: true,
        consecutiveReds: 5,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      changeInCandidate: {
        ...NO_CANDIDATE,
        judgingSha: null,
        nextCandidateSha: 'nextcand123456',
        nextContainsPath: false,
        submodule: null,
        missingReason: 'newer-commit',
      },
    });
    expect(l).toMatch(/quiet-cut/);
  });

  it('EI-18797292094433710: an UNCOMMITTED/ABSENT miss still routes to git-sync:run even with a run in flight', () => {
    // The narrowing above must not weaken the genuine misses: when the candidate
    // provably cannot see the work, waiting for the in-flight verdict is useless.
    const l = lever('gate', {
      positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
      gate: {
        stalled: true,
        consecutiveReds: 5,
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
        candidateFailures: null,
        ownerBrief: null, qualification: NO_QUALIFICATION,
      },
      changeInCandidate: {
        ...NO_CANDIDATE,
        judgingSha: 'inflight123456',
        judgingContainsPath: false,
        missingReason: 'uncommitted',
      },
    });
    expect(l).toMatch(/git-sync:run/);
  });

  it('`main` never offers a lever — it advances only as a consequence of the gate', () => {
    expect(
      lever('main', {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: false,
          deployedBehindGreenPin: 0,
          deployOrigin: 'gate-green',
        },
      }),
    ).toBeNull();
  });

  it('the force-deploy lever appears ONLY once the change is in main', () => {
    // Offering it earlier would ship a sha that does not carry the change — which looks
    // like progress and is not.
    const notInMain = lever('deployed', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
    });
    expect(notInMain).toBeNull();

    const inMain = lever('deployed', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
    });
    expect(inMain).toMatch(/deploy-cli\.ts --execute/);
  });

  /**
   * EI-11120's shape: restarting a host whose source has NOT yet received the code
   * restarts it onto the SAME old bytes, which reads as "I did the thing and nothing
   * changed".
   */
  it('the restart lever appears ONLY once the code reached the host', () => {
    const STALE = { ...HEALTHY_SERVING, startedSinceCodeChange: false, behindMin: 30, restartLever: 'RESTART_ME' };
    const notDeployed = lever('serving', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      serving: STALE,
    });
    expect(notDeployed).toBeNull();

    const deployed = lever('serving', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      serving: STALE,
    });
    expect(deployed).toBe('RESTART_ME');
  });

  /**
   * EI-19447523039740352 — the regression guard for the reported footgun: while a
   * deploy is mid-flight the serving lever must be WITHHELD, because firing it is a
   * second concurrent deploy against the shared release checkout. A null lever is
   * already rendered as "WAITING AT SERVING (nothing to do — this leg is advancing on
   * its own)", which is the literally correct advice: the running deploy does the
   * restart. Reported live, one call short of firing it.
   */
  it('withholds the serving lever while a deploy is ALREADY in flight', () => {
    const STALE = { ...HEALTHY_SERVING, startedSinceCodeChange: false, behindMin: 30, restartLever: 'RESTART_ME' };
    const superseded = lever('serving', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      serving: {
        ...STALE,
        restartSupersededBy: {
          kind: 'deploy-in-flight' as const,
          unit: 'papercup-auto-deploy',
          startedAtMs: 1_700_000,
          activeState: 'active',
        },
      },
    });
    expect(superseded).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * EI-19447523039740352 — the RESOLVER WIRING, end to end.
 *
 * The two ends of this fix are already covered above: `evaluateServing` computes
 * `restartSupersededBy` from a DeployInFlight (the `restartSupersededBy` describe),
 * and `computeStages` withholds the serving lever when it is set (the lever case
 * directly above). Neither exercises the three lines that JOIN them inside
 * `gitPipelinePosition` — probe `readDeployInFlight` for `operator-release` only,
 * pass it into `evaluateServing`, and let the null lever fall through `deriveBlocker`
 * to `nextAction`.
 *
 * Those three lines ARE the bug. It was reported against the tool's OUTPUT — an agent
 * one call short of firing a second concurrent deploy because `nextAction` told it to —
 * so a green suite that never asserts on that output would not have caught the report.
 * ------------------------------------------------------------------------- */
describe('EI-19447523039740352: a running deploy reaches nextAction through the full resolver', () => {
  const RELEASE_PATH = 'apps/operator/app/x.ts'; // DEFAULT_OWNER ⇒ operator-release
  const RESTART_LEVER = /deploy-cli\.ts --execute/;

  const deployUnitState = (over: Partial<DeployInFlight> = {}): DeployInFlight => ({
    active: false,
    unit: 'papercup-auto-deploy',
    activeState: 'inactive',
    subState: 'dead',
    startedAtMs: null,
    logPath: '/tmp/auto-deploy.log',
    logMtimeMs: null,
    source: 'systemd',
    ...over,
  });

  /** MEASURED idle: systemd answered, and nothing is running. */
  const IDLE = deployUnitState();
  /** The reported state: the deploy is mid-flight and restarts :3070 itself. */
  const RUNNING = deployUnitState({
    active: true,
    activeState: 'activating',
    subState: 'running',
    startedAtMs: 1_700_000,
  });

  /**
   * A fully-deployed path whose SERVING process is stale — the window the report was
   * filed from. It is not an edge case: files land early in a deploy and the restart
   * happens late, so `startedAtMs < codeAsOfMs` holds for the whole duration of a
   * perfectly normal deploy. Everything here is fixed EXCEPT the deploy-unit state,
   * which is the single input the two arms below differ on.
   */
  const stalelyServing = (readDeployInFlight: () => Promise<DeployInFlight>) =>
    gitPipelinePosition(
      { path: RELEASE_PATH },
      {
        git: fakeGit({
          pathCommit: 'abc1234567',
          contains: {
            HEAD: ['abc1234567'],
            'origin/staging': ['abc1234567'],
            'origin/main': ['abc1234567'],
            deployedsha0: ['abc1234567'],
          },
        }),
        loadDeploy: async () => deploy({ deployedAtMs: Date.now() - 60_000 }),
        loadSnapshot: async () => snap(),
        // Started three hours BEFORE the code it serves — i.e. it has not loaded it.
        probeUnitStart: async () => ({ pid: 4242, startedAtMs: Date.now() - 3 * 60 * 60_000 }),
        readDeployInFlight,
      },
    );

  it('withholds the lever end-to-end while a deploy runs — and offers it when one is NOT running', async () => {
    const idle = await stalelyServing(async () => IDLE);
    const running = await stalelyServing(async () => RUNNING);

    /**
     * THE NON-VACUITY GUARD, asserted rather than assumed. If the fixture stopped
     * producing a stale serving process (a fixture drifting, a default changing), BOTH
     * arms would report `nextAction: null` and the differential below would pass with
     * the wiring deleted — the exact "green for the wrong reason" this file's P-009
     * note warns about. This arm fails loudly instead.
     */
    expect(idle.serving.startedSinceCodeChange, 'fixture no longer produces a STALE serving process').toBe(false);
    expect(idle.blockedOn).toBe('serving');
    expect(idle.nextAction, 'with no deploy running the restart lever IS the correct advice').toMatch(RESTART_LEVER);

    // The reported bug, at the output the reporter actually read: same stale process,
    // same git state, only a deploy now in flight ⇒ no lever, and "waiting" is correct.
    expect(running.blockedOn, 'where the change SITS is unchanged — only the advice moves').toBe('serving');
    expect(running.nextAction).toBeNull();
    expect(running.serving.restartSupersededBy).toEqual({
      kind: 'deploy-in-flight',
      unit: 'papercup-auto-deploy',
      startedAtMs: 1_700_000,
      activeState: 'activating',
    });
    // …and the caller is TOLD why there is nothing to do, rather than left to infer it
    // from a bare null — which would read like "your change is live".
    expect(running.notes.join('\n')).toMatch(/DEPLOY IS ALREADY RUNNING/);
  });

  /**
   * The other half of the wiring: the probe is gated on `operator-release` because only
   * that host's lever IS a deploy. Un-gated, every bg-host/gateway/desktop caller would
   * pay a systemctl round-trip for an answer that cannot change its verdict.
   */
  it('does NOT probe the deploy unit for a host whose lever is not a deploy', async () => {
    const BG_PATH = 'packages/operator-core/lib/harness/git-sync/tick.ts';
    // Asserted, not assumed — if this path is ever reclassified, the case below stops
    // testing the gate and this line says so instead of silently passing.
    expect(classifyRuntimeOwners(BG_PATH)?.[0].host).toBe('bg-host');

    const probe = vi.fn(async () => IDLE);
    await gitPipelinePosition(
      { path: BG_PATH },
      {
        git: fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } }),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        probeUnitStart: async () => ({ pid: 99, startedAtMs: Date.now() - 3 * 60 * 60_000 }),
        fileMtimeMs: async () => Date.now() - 60_000,
        probeHealthSha: async () => null,
        probeHealthBundle: async () => null,
        readDeployInFlight: probe,
      },
    );
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('P-005 ACCEPTANCE TEST — one call answers "is it live, and if not what is blocking it"', () => {
  const run = (over: {
    dirty?: boolean;
    contains?: Record<string, string[]>;
    servingStale?: boolean;
    deployedAtMs?: number;
    pushMode?: string | null;
  }) =>
    gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git: fakeGit({ pathCommit: 'abc1234567', subject: 'my fix', dirty: over.dirty, contains: over.contains ?? {} }),
        loadDeploy: async () => deploy(over.deployedAtMs ? { deployedAtMs: over.deployedAtMs } : {}),
        loadSnapshot: async () => {
          const snapshot = snap();
          snapshot.gitSync.pushMode = over.pushMode ?? null;
          return snapshot;
        },
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
        /**
         * EI-20134961617539316. WITHOUT this stub these cases are NOT hermetic:
         * `gitPipelinePosition` falls back to `realReadDeployInFlight()` (deps.readDeployInFlight
         * ?? realReadDeployInFlight), which probes REAL systemd. A deploy that happens to be in
         * flight on the host then sets `restartSupersededBy`, which withholds the SERVING lever
         * BY DESIGN (EI-19447523039740352) — so `nextAction` becomes null and the SERVING case
         * below fails.
         *
         * The reported symptom named the wrong culprit and cost that investigation its lead:
         * ".toMatch() expects to receive a string, but got object" is emitted by @vitest/expect
         * as `typeof actual`, and `typeof null === 'object'` — so it says "object" for a plain
         * NULL. There is no non-string `restartLever` to find; every branch of
         * `servingRestartLever` returns a string.
         *
         * It is self-inflicted and recurs: the gate promotes `main`, release-trigger deploys it,
         * and the NEXT gate run reddens here. Measured 2026-08-14 — papercup-auto-deploy started
         * 12:52:16Z, this case failed at 12:56:22Z, having passed every earlier CI run that day.
         * The `EI-19447523039740352` describe below already asserts the other arm
         * (`expect(running.nextAction).toBeNull()`), so leaving this unstubbed made the two
         * blocks contradict each other exactly when a deploy happened to be running.
         *
         * MEASURED-IDLE, not "unknown": `active:false` with `source:'systemd'` is an affirmative
         * reading, which keeps the lever. `source:'systemd-unavailable'` would mean UNKNOWN and
         * is deliberately not what these cases assert against.
         */
        readDeployInFlight: async (): Promise<DeployInFlight> => ({
          active: false,
          unit: 'papercup-auto-deploy',
          activeState: 'inactive',
          subState: 'dead',
          startedAtMs: null,
          logPath: '/tmp/auto-deploy.log',
          logMtimeMs: null,
          source: 'systemd',
        }),
      },
    );

  it('uncommitted ⇒ blocked at COMMITTED, and the summary LEADS with the lever', async () => {
    const res = await run({ dirty: true, contains: { HEAD: ['abc1234567'] } });
    expect(res.blockedOn).toBe('committed');
    expect(res.nextAction).toMatch(/git-sync:run/);
    // Leading, not buried: this is the whole deliverable — the answer is the first thing read.
    expect(res.summary).toMatch(/^BLOCKED AT COMMITTED → /);
  });

  it('committed but not origin-published ⇒ delivery proceeds to GATE and the summary labels publication as a side leg', async () => {
    const res = await run({ contains: { HEAD: ['abc1234567'] }, pushMode: 'commit-only:bridged' });
    expect(res.blockedOn).toBe('gate');
    expect(res.stages.find((stage) => stage.name === 'pushed')).toMatchObject({
      plane: 'publish',
      position: 'pending',
    });
    expect(res.summary).toMatch(/origin-publish ✗/);
    expect(res.summary).toMatch(/PUBLISH\/DURABILITY side leg/);
    expect(res.summary).toMatch(/local staging→main→:3070 delivery is unaffected/);
    expect(res.summary).not.toMatch(/(?:BLOCKED|WAITING) AT PUSHED/);
  });

  it('a normal pushing member keeps origin/staging on its delivery route', async () => {
    const res = await run({ contains: { HEAD: ['abc1234567'] }, pushMode: 'push' });
    expect(res.blockedOn).toBe('pushed');
    expect(res.stages.find((stage) => stage.name === 'pushed')).toMatchObject({
      plane: 'delivery',
      position: 'pending',
    });
    expect(res.summary).toMatch(/^WAITING AT PUSHED/);
    expect(res.summary).toMatch(/· staging ✗/);
    expect(res.summary).not.toMatch(/delivery is unaffected/);
  });

  it('clean detached candidate ⇒ waits for HEAD containment without calling it committed', async () => {
    const res = await run({ contains: {} });
    expect(res.positions.committedLocal).toBe(false);
    expect(res.dirtyUncommitted).toBe(false);
    expect(res.blockedOn).toBe('committed');
    expect(res.nextAction).toBeNull();
    expect(res.summary).toMatch(/^WAITING FOR HEAD CONTAINMENT \(target commit is not reachable from HEAD/);
    expect(res.summary).not.toMatch(/^.*(?:AT|BLOCKED AT) COMMITTED/);
  });

  it('pushed but not in main ⇒ blocked at GATE', async () => {
    const res = await run({ contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'] } });
    expect(res.blockedOn).toBe('gate');
  });

  it('in main but not deployed ⇒ blocked at DEPLOYED, with the force-deploy lever', async () => {
    const res = await run({
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': ['abc1234567'] },
    });
    expect(res.blockedOn).toBe('deployed');
    expect(res.nextAction).toMatch(/deploy-cli\.ts --execute/);
  });

  it('deployed but the process predates the code ⇒ blocked at SERVING, with the restart lever', async () => {
    // The 4x-filed class: every git tick is ✓ and the change is still NOT running.
    const res = await run({
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
      deployedAtMs: Date.now(), // deploy NOW; the mocked process started 60s ago ⇒ stale
    });
    expect(res.blockedOn).toBe('serving');
    expect(res.nextAction).toMatch(/deploy-cli\.ts --execute/);
    expect(res.summary).toMatch(/^BLOCKED AT SERVING → /);
  });

  it('fully live ⇒ null/null, and the summary carries no blocked/waiting lead at all', async () => {
    const res = await run({
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
    });
    expect(res.blockedOn).toBeNull();
    expect(res.nextAction).toBeNull();
    expect(res.summary).not.toMatch(/BLOCKED AT|WAITING AT/);
  });
});

/* ------------------------------------------------------------------------- *
 * P-006 — SWEEP EXPOSURE.
 *
 * The defect (EI-18735166063643844): an agent cannot commit atomically here, so a
 * multi-file change is GUARANTEED to expose a partial intermediate as a commit, and
 * the green-checkpoint can cut its candidate inside that window. Measured cost: 29
 * failures against a 14:09 candidate for work whose dependent fix landed at 14:36 —
 * all green at tip, and a peer spent a wake triaging them.
 *
 * What is pinned here is a DISTINCTION, not a warning: one dirty file cannot be cut
 * into a partial set, so warning there would be a false alarm that trains readers to
 * skim past the real one.
 * ------------------------------------------------------------------------- */
describe('sweep exposure (P-006)', () => {
  const NOW = 1_000_000_000_000;

  const stageInput = (sweep: SweepExposure): Parameters<typeof computeStages>[0] => ({
    dirtyUncommitted: true,
    positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
    gate: {
      stalled: false,
      consecutiveReds: 0,
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
      candidateFailures: null,
      ownerBrief: null, qualification: NO_QUALIFICATION,
    },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    serving: HEALTHY_SERVING,
    changeInCandidate: NO_CANDIDATE,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    sweepExposure: sweep,
  });

  // git-sync-turn-scoped-commit-hold-2026-10-11 P-003: a path the last sweep turn-held is
  // reported as held (holder + age), never as "the next tick will commit it mid-edit".
  describe('turn-scoped hold (P-003)', () => {
    const TURN_INTENT = 'turn-scoped hold (git-sync-turn-scoped-commit-hold P-002): held';
    const skipped = [
      { scope: 'superproject', path: 'packages/a.ts', owner: 'su-a', intent: TURN_INTENT, heldSince: new Date(NOW - 10 * 60_000).toISOString() },
      { scope: 'libs/papercusp', path: 'libs/x.ts', owner: 'su-b', intent: TURN_INTENT },
      { scope: 'superproject', path: 'packages/locked.ts', owner: 'su-c', intent: 'editing locked.ts' },
    ];

    it('turnHoldFor matches only turn-hold entries, joining the submodule scope', () => {
      expect(turnHoldFor('packages/a.ts', skipped)).toEqual({ holder: 'su-a', heldSince: skipped[0].heldSince });
      expect(turnHoldFor('./libs/papercusp/libs/x.ts', skipped)).toEqual({ holder: 'su-b', heldSince: null });
      expect(turnHoldFor('packages/locked.ts', skipped)).toBeNull();
      expect(turnHoldFor(null, skipped)).toBeNull();
    });

    it('a turn-held dirty path is NOT exposed and names its holder and age', () => {
      const s = evaluateSweepExposure({
        dirtyUncommitted: true,
        dirtyPaths: ['packages/a.ts', 'packages/b.ts'],
        nextSweepAtMs: NOW + 60_000,
        nowMs: NOW,
        turnHold: turnHoldFor('packages/a.ts', skipped),
      });
      expect(s.exposed).toBe(false);
      expect(s.turnHeld).toEqual({ holder: 'su-a', heldSince: skipped[0].heldSince });
      expect(s.detail).toContain('TURN-HELD');
      expect(s.detail).toContain('su-a');
      expect(s.detail).toContain('~10 min');
      expect(s.detail).not.toContain('SWEEP-EXPOSED');
    });

    it('an ordinary dirty path carries no turnHeld field', () => {
      const s = evaluateSweepExposure({
        dirtyUncommitted: true,
        dirtyPaths: ['packages/b.ts'],
        nextSweepAtMs: NOW + 60_000,
        nowMs: NOW,
        turnHold: turnHoldFor('packages/b.ts', skipped),
      });
      expect(s.exposed).toBe(true);
      expect(s).not.toHaveProperty('turnHeld');
    });

    it('the deferral for a turn-held path never tells the caller to release a lock', () => {
      const d = gitSyncDeferralFor('packages/a.ts', { skippedPaths: skipped, syncAgeMs: 60_000 });
      expect(d?.reason).toBe('turn-hold');
      expect(d?.lever).toContain('locks:release does not lift it');
      expect(gitSyncDeferralFor('packages/locked.ts', { skippedPaths: skipped, syncAgeMs: 60_000 })?.reason).toBe('edit-lock');
    });
  });

  it('a clean path is not exposed at all — and says nothing', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: false,
      dirtyPaths: null,
      nextSweepAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(false);
    expect(s.detail).toBeNull();
    expect(s.dirtyPathCount).toBeNull();
  });

  it('ONE dirty path: exposed, but explicitly NOT a partial-set risk', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['packages/operator-core/lib/x.ts'],
      nextSweepAtMs: NOW + 5 * 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(true);
    expect(s.dirtyPathCount).toBe(1);
    expect(s.detail).toMatch(/cannot cut a partial set/);
    // The multi-file alarm must NOT fire here.
    expect(s.detail).not.toMatch(/SWEEP-EXPOSED/);
    expect(s.detail).toMatch(/~5 min/);
  });

  it('SEVERAL dirty paths: names the blast radius, the window, and that you cannot make it atomic', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts', 'c.ts'],
      nextSweepAtMs: NOW + 3 * 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(true);
    expect(s.dirtyPathCount).toBe(3);
    expect(s.detail).toMatch(/SWEEP-EXPOSED/);
    expect(s.detail).toMatch(/all 3 dirty path/);
    expect(s.detail).toMatch(/a\.ts, b\.ts, c\.ts/);
    expect(s.detail).toMatch(/~3 min/);
    // The honest half: there is no lever that makes it atomic.
    expect(s.detail).toMatch(/cannot make this atomic/);
    // ...and the reason it matters: the gate can judge the intermediate.
    expect(s.detail).toMatch(/judge the intermediate/);
  });

  it('a large dirty set is sampled, not dumped — and the remainder is counted', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const s = evaluateSweepExposure({ dirtyUncommitted: true, dirtyPaths: paths, nextSweepAtMs: null, nowMs: NOW });
    expect(s.dirtyPathCount).toBe(20);
    expect(s.dirtyPathSample).toHaveLength(6);
    expect(s.detail).toMatch(/\+14 more/);
  });

  it('an OVERDUE tick clamps to zero — never a negative or a past-tense window', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts'],
      nextSweepAtMs: NOW - 10 * 60_000, // the scheduler is late
      nowMs: NOW,
    });
    expect(s.nextSweepInMs).toBe(0);
    expect(s.detail).toMatch(/within the next MINUTE/);
    // No negative window can render ("in ~-10 min"). Scoped to the rendered duration —
    // the detail legitimately carries a hyphenated issue id.
    expect(s.detail).not.toMatch(/~-\d+ min/);
  });

  it('carry note (2): an UNDEFINED next-fire renders as unknown, never "NaN min"', () => {
    // `nextFireAtMs` is parsed out of free-form routine state, so `undefined` reaches
    // here as easily as `null` — and `=== null` lets it straight through into the
    // arithmetic. This is the trap P-003 hit; pin it rather than re-learn it.
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts'],
      nextSweepAtMs: undefined as unknown as number | null,
      nowMs: NOW,
    });
    expect(s.nextSweepInMs).toBeNull();
    expect(s.detail).not.toMatch(/NaN/);
    expect(s.detail).toMatch(/at its next tick/);
  });

  it('parsePorcelainPaths takes the NEW path of a rename, and unquotes', () => {
    const out = [
      ' M packages/operator-core/lib/x.ts',
      '?? new-file.ts',
      'R  old/name.ts -> new/name.ts',
      ' M "path with space.ts"',
      'MM staged-and-modified.ts',
    ].join('\n');
    expect(parsePorcelainPaths(out)).toEqual([
      'packages/operator-core/lib/x.ts',
      'new-file.ts',
      'new/name.ts',
      'path with space.ts',
      'staged-and-modified.ts',
    ]);
  });

  it('REGRESSION (live probe): realGit TRIMS, so the first record loses its leading space', () => {
    // Found by dogfooding on the real repo, not by any fixture — fixtures never go
    // through realGit, which returns `stdout.trim()`. Every ` M path` record keeps its
    // leading space except the FIRST, whose space the trim ate. A column-slicing parser
    // therefore returned `ackages/operator-core/...` — a plausible path that is not the
    // file, corrupting the sample silently rather than failing.
    const trimmedFirstLine = [
      'M packages/operator-core/lib/a.ts',
      ' M packages/operator-core/lib/b.ts',
      ' M papercusp-desktop',
    ].join('\n');
    expect(parsePorcelainPaths(trimmedFirstLine)).toEqual([
      'packages/operator-core/lib/a.ts',
      'packages/operator-core/lib/b.ts',
      'papercusp-desktop',
    ]);
  });

  it('a path whose first character is itself a status letter still parses', () => {
    // The backtracking case that makes the status-field match safe: `M Makefile` could
    // read as status "M " + path "akefile" if {1,2} were greedy without a fallback.
    expect(parsePorcelainPaths('M Makefile\n?? Dockerfile')).toEqual(['Makefile', 'Dockerfile']);
  });

  it('the committed-stage LEVER carries the blast radius when the sweep takes more than your file', () => {
    // `git-sync:run` told to an agent mid-refactor is an instruction to commit the
    // broken intermediate on purpose. The lever stays — it is right once the set is
    // done — but it must not read as "commits your file".
    const stages = computeStages(
      stageInput(
        evaluateSweepExposure({
          dirtyUncommitted: true,
          dirtyPaths: ['a.ts', 'b.ts', 'c.ts'],
          nextSweepAtMs: NOW + 60_000,
          nowMs: NOW,
        }),
      ),
    );
    const committed = stages.find((s) => s.name === 'committed')!;
    expect(committed.lever).toMatch(/git-sync:run/);
    expect(committed.lever).toMatch(/sweeps ALL 3 dirty paths/);
    expect(committed.lever).toMatch(/only fire it once the set is complete/);
    expect(committed.detail).toMatch(/SWEEP-EXPOSED/);
  });

  it('a SINGLE dirty path leaves the committed lever exactly as it was', () => {
    const stages = computeStages(
      stageInput(
        evaluateSweepExposure({
          dirtyUncommitted: true,
          dirtyPaths: ['x.ts'],
          nextSweepAtMs: NOW + 60_000,
          nowMs: NOW,
        }),
      ),
    );
    const committed = stages.find((s) => s.name === 'committed')!;
    expect(committed.lever).toBe('git-sync:run (commit the working tree — the gate cannot see it)');
  });

  it('end-to-end: a dirty path in a multi-file tree surfaces it in sweepExposure, notes AND the summary', async () => {
    const git = fakeGit({
      dirty: true,
      dirtyTree: [' M packages/operator-core/lib/a.ts', ' M packages/operator-core/lib/b.ts', '?? c.ts'].join('\n'),
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': [], deployedsha0: [] },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/a.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          ({
            ...snap(),
            routines: {
              gitSync: {
                name: 'git-sync',
                active: true,
                cron: null,
                lastFiredAtMs: null,
                nextFireAtMs: Date.now() + 4 * 60_000,
              },
            },
          }) as GitPipelineSnapshot,
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
      },
    );
    expect(res.sweepExposure.exposed).toBe(true);
    expect(res.sweepExposure.dirtyPathCount).toBe(3);
    expect(res.sweepExposure.nextSweepInMs).toBeGreaterThan(0);
    expect(res.notes.join(' ')).toMatch(/SWEEP-EXPOSED/);
    expect(res.summary).toMatch(/SWEEP-EXPOSED: the next git-sync tick \(~4 min\) commits all 3 dirty paths/);
  });

  it('end-to-end: a dirty path ALONE in the tree gets no sweep clause in the summary', async () => {
    const git = fakeGit({
      dirty: true,
      dirtyTree: ' M packages/operator-core/lib/a.ts',
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': [], deployedsha0: [] },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/a.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
      },
    );
    expect(res.sweepExposure.dirtyPathCount).toBe(1);
    expect(res.summary).toContain('⚠ +uncommitted edits');
    expect(res.summary).not.toMatch(/SWEEP-EXPOSED/);
  });

  it('a sha-only probe measures no exposure and pays for no status read at all', async () => {
    const seen: string[][] = [];
    const inner = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const git: GitRunner = async (repo, args) => {
      seen.push(args);
      return inner(repo, args);
    };
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.sweepExposure.exposed).toBe(false);
    expect(seen.some((a) => a[0] === 'status')).toBe(false);
  });
});

describe('mapCheckpointRunInFlight — pure mapper (EI-18793581783459047)', () => {
  const NOW = 1_800_000_000_000;

  it('null cache (no derived-read snapshot yet) maps to null — UNKNOWN, not "idle"', () => {
    expect(mapCheckpointRunInFlight(null, NOW)).toBeNull();
  });

  it('a cached snapshot with no activeRun (registry row present, gate never probed) maps to null', () => {
    expect(mapCheckpointRunInFlight({ activeRun: null, computedAtMs: NOW - 1000 }, NOW)).toBeNull();
  });

  it('carries the live run heartbeat and phase through the position projection', () => {
    const out = mapCheckpointRunInFlight(
      {
        activeRun: {
          active: true,
          candidate: 'abcdef1234567890',
          startedAtMs: NOW - 5 * 60_000,
          progressAtMs: NOW - 15_000,
          currentPhase: 'delivering',
          elapsedSec: 300,
        },
        computedAtMs: NOW - 4_000,
      },
      NOW,
    );
    expect(out).toMatchObject({
      progressAtMs: NOW - 15_000,
      currentPhase: 'delivering',
    });
  });

  it('an active run maps every field through, plus a computed asOfAgeMs', () => {
    const out = mapCheckpointRunInFlight(
      {
        activeRun: { active: true, candidate: 'abcdef1234567890', startedAtMs: NOW - 5 * 60_000, elapsedSec: 300 },
        computedAtMs: NOW - 4_000,
      },
      NOW,
    );
    expect(out).toEqual({
      active: true,
      candidate: 'abcdef1234567890',
      // WI-7035: no marker supplied, so the candidate came from probing the run — which on a
      // cron-fired run is the checkpoint checkout's live HEAD, an inference rather than an
      // observation. Labelled so a reader can weigh it.
      candidateSource: 'run-probe',
      startedAtMs: NOW - 5 * 60_000,
      elapsedSec: 300,
      asOfAgeMs: 4_000,
    });
  });

  /**
   * EI-19327704778173646 / WI-7024. This mapper destructures an EXACT field set, so a new
   * leg is silently DROPPED unless threaded explicitly — which is why refire state never
   * reached dev:pipeline_position, the very tool CLAUDE.md points agents at for "is my
   * change live". A caller that cannot see the run re-candidated reads the moving
   * `candidate` as a corrupt field.
   */
  it('carries refire provenance through to the tool-facing shape', () => {
    const out = mapCheckpointRunInFlight(
      {
        activeRun: {
          active: true,
          candidate: '4961cfb8',
          initialCandidate: '14fb28da',
          refireObserved: true,
          startedAtMs: NOW - 45 * 60_000,
          elapsedSec: 2700,
        },
        computedAtMs: NOW - 1_000,
      },
      NOW,
    );
    expect(out).toEqual({
      active: true,
      candidate: '4961cfb8',
      candidateSource: 'run-probe',
      initialCandidate: '14fb28da',
      refireObserved: true,
      startedAtMs: NOW - 45 * 60_000,
      elapsedSec: 2700,
      asOfAgeMs: 1_000,
    });
  });

  it('carries typed user-manager provenance through to the tool-facing shape', () => {
    const systemd = {
      scope: 'user' as const,
      argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
      loadState: 'loaded',
      known: true,
      invocationId: 'invocation-123',
    };
    const out = mapCheckpointRunInFlight(
      {
        activeRun: {
          active: true,
          candidate: '4961cfb8',
          startedAtMs: NOW - 45 * 60_000,
          elapsedSec: 2700,
          systemd,
        },
        computedAtMs: NOW - 1_000,
      },
      NOW,
    );
    expect(out?.systemd).toEqual(systemd);
  });

  /**
   * WI-7035 — THE RECURRENCE GUARD. The log-derived provenance above only exists for a
   * MANUALLY-fired run: `checkActiveCheckpointRun` parses `/tmp/<unit>.log`, and a CRON-fired
   * run never writes one. It takes the `held_externally` branch, returns before the log parse,
   * and reports the checkpoint checkout's live HEAD as `candidate`. So on the ordinary hourly
   * gate the fields above are structurally unreachable, and CLAUDE.md's 🚨 "never fire a manual
   * run inside the re-triage window" rule was unenforceable from the tool agents are pointed at.
   *
   * Measured live 2026-08-02 11:43Z: the marker held refireAttempt 1/2 with
   * fromCandidate 6f4181447486 → refiringCandidate 16dbb52a7849, and this leg emitted NEITHER.
   *
   * The marker is what the running process published about ITSELF, so it outranks anything
   * inferred about it from outside.
   */
  describe('WI-7035: the inFlightRetriage marker is authoritative over the probed candidate', () => {
    const MARKER = {
      fromCandidate: '6f4181447486a33e4b471b82dee3ed0893c3efa6',
      refiringCandidate: '16dbb52a7849320e27832500bf2157f00b1db1c3',
      refireAttempt: 1,
      maxRefires: 2,
    };
    // The cron shape: active, a candidate that came from the checkout HEAD, and NO log-derived
    // refire provenance — exactly what the live tool returned before this fix.
    const cronRun = {
      activeRun: { active: true, candidate: 'stale-worktree-head', startedAtMs: NOW - 30 * 60_000, elapsedSec: 1800 },
      computedAtMs: NOW,
    };

    it('reports the MARKER candidate, not the probed one, when the two disagree', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, MARKER);
      expect(out?.candidate).toBe(MARKER.refiringCandidate);
      expect(out?.candidateSource).toBe('retriage-marker');
      // The discarded candidate is preserved: a red still being diagnosed may belong to it.
      expect(out?.fromCandidate).toBe(MARKER.fromCandidate);
    });

    it('makes the re-triage window readable on a run with NO log-derived provenance (the cron path)', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, MARKER);
      expect(out?.inRetriageWindow).toBe(true);
      expect(out?.refireAttempt).toBe(1);
      expect(out?.maxRefires).toBe(2);
      // A refire IS a re-candidation — this must hold even though the /tmp log said nothing.
      expect(out?.refireObserved).toBe(true);
    });

    it('does NOT attach a marker to an IDLE probe — that would assert a refire for a finished run', () => {
      const idle = {
        activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
        computedAtMs: NOW,
      };
      const out = mapCheckpointRunInFlight(idle, NOW, MARKER);
      expect(out?.inRetriageWindow).toBeUndefined();
      expect(out?.candidate).toBeNull();
    });

    it('absent marker means NO refire in flight, and leaves the pre-existing shape untouched', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, null);
      expect(out?.inRetriageWindow).toBeUndefined();
      expect(out?.candidate).toBe('stale-worktree-head');
      expect(out?.candidateSource).toBe('run-probe');
    });

    /**
     * EI-19343516395023183. `refireAttempt` is the CHARGED counter — it advances only on a FAILED
     * rescue — so the pair above cannot express "5 of 6 refires performed, next red sticks". Both
     * fields were already in Postgres and dropped by `parseInFlightRetriage`; this leg's
     * exact-field destructure would have dropped them a second time.
     */
    it('⭐ carries the ABSOLUTE-CEILING counters through, so a caller can see the bound refireAttempt cannot express', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, {
        ...MARKER,
        refireAttempt: 0,
        totalRefires: 5,
        absoluteCeiling: 6,
      });
      expect(out?.totalRefires).toBe(5);
      expect(out?.absoluteCeiling).toBe(6);
    });

    it('omits them for a pre-EI-19343532231631821 marker rather than reporting an invented 0', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, MARKER);
      expect(out).not.toHaveProperty('totalRefires');
      expect(out).not.toHaveProperty('absoluteCeiling');
    });
  });

  /**
   * EI-19931692050586322 — THE RECURRENCE GUARD for the SIBLING marker.
   *
   * WI-7035 (above) made the refire marker authoritative. But `inFlightRetriage` only exists
   * once a run has REFIRED, which is the uncommon case — so the ORDINARY hourly cron run, on
   * its first candidate, still fell through to `'run-probe'`: a value this very module
   * documents as an INFERENCE that "can change between two reads". Meanwhile
   * `in-flight-candidate.ts` was already publishing the authoritative answer on every
   * invocation, and no reader consulted it. Producer wired, reader missing.
   *
   * Measured live 2026-08-09T00:05Z on the real stalled gate: `dev:pipeline_position` reported
   * `candidateSource: 'run-probe'` while `gate_health.inFlightCandidate` in the SAME routines
   * row (already loaded by git-pipeline-stats) held
   * `{candidate: 2b8dddcb18f4…, refireDepth: 0, pid: 2353910}`.
   *
   * The fix must not overreach in the other direction: BOTH markers are best-effort writes that
   * swallow their own errors, so `'run-probe'` has to stay reachable and honestly labelled —
   * measured the same night, the 00:13Z run published no marker at all while genuinely active.
   */
  describe('EI-19931692050586322: the inFlightCandidate marker is authoritative for a NON-refiring run', () => {
    const CAND = {
      candidate: '2b8dddcb18f4bb034ca691d05f7bf6503dab9ad5',
      refireDepth: 0,
      quietCutApplied: false,
      pid: 2353910,
    };
    // A refire marker naming a DIFFERENT sha, so the precedence case below can only pass by
    // actually choosing between them — two markers agreeing would prove nothing.
    const MARKER_FOR_PRECEDENCE = {
      fromCandidate: '2b8dddcb18f4bb034ca691d05f7bf6503dab9ad5',
      refiringCandidate: 'eb9de957d45d0c1a2f3b4c5d6e7f8091a2b3c4d5',
      refireAttempt: 1,
      maxRefires: 2,
    };
    const cronRun = {
      activeRun: { active: true, candidate: 'stale-worktree-head', startedAtMs: NOW - 30 * 60_000, elapsedSec: 1800 },
      computedAtMs: NOW,
    };

    it('⭐ a refireDepth:0 run WITH a published marker resolves to the AUTHORITATIVE source, not run-probe', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, null, null, CAND);
      expect(out?.candidate).toBe(CAND.candidate);
      expect(out?.candidateSource).toBe('in-flight-candidate');
    });

    it('the REFIRE marker still wins when both are present — a refire supersedes the starting candidate', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, MARKER_FOR_PRECEDENCE, null, CAND);
      expect(out?.candidate).toBe(MARKER_FOR_PRECEDENCE.refiringCandidate);
      expect(out?.candidateSource).toBe('retriage-marker');
    });

    /**
     * The fallback is NOT dead code — it is the honest answer when a live run published
     * nothing. Deleting this case would let a future "simplification" assume a marker always
     * exists and start reporting an inference as an observation.
     */
    it('keeps run-probe REACHABLE and labelled when the run published no marker (best-effort write)', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, null, null, null);
      expect(out?.candidate).toBe('stale-worktree-head');
      expect(out?.candidateSource).toBe('run-probe');
    });

    it('does NOT attach the marker to an IDLE run — a finished run is judging nothing', () => {
      const idle = {
        activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
        computedAtMs: NOW,
      };
      const out = mapCheckpointRunInFlight(idle, NOW, null, null, CAND);
      expect(out?.candidate).toBeNull();
      expect(out?.candidateSource).toBeUndefined();
    });

    /**
     * On the cron path the log-derived `refireObserved` can never fire (only MANUAL runs write
     * the /tmp log), so before this an in-process rescue was invisible whenever the refire
     * marker happened to be absent. `refireDepth` is the run's own report of the same fact.
     */
    it('reports refireObserved from refireDepth — the cron path has no log to derive it from', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, null, null, { ...CAND, refireDepth: 2 });
      expect(out?.refireObserved).toBe(true);
    });

    it('a refireDepth:0 marker does NOT claim a refire happened', () => {
      const out = mapCheckpointRunInFlight(cronRun, NOW, null, null, CAND);
      expect(out?.refireObserved).toBeUndefined();
    });

    it('reconcileGateCandidates treats it as authoritative, so judgingSha stops being an inference', () => {
      const out = reconcileGateCandidates({ judgingSha: 'stale-worktree-head' } as never, {
        candidate: CAND.candidate,
        candidateSource: 'in-flight-candidate',
      });
      expect(out.judgingSha).toBe(CAND.candidate);
      expect(out.judgingShaSource).toBe('in-flight-candidate');
    });
  });

  it('an idle probe result ({ active: false }) is NOT collapsed to null — it is the genuine "gate is idle" reading', () => {
    const out = mapCheckpointRunInFlight(
      { activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null }, computedAtMs: NOW },
      NOW,
    );
    expect(out).toEqual({ active: false, candidate: null, startedAtMs: null, elapsedSec: null, asOfAgeMs: 0 });
  });

  it('a cache with no computedAt (should not happen once populated) reports asOfAgeMs null rather than a fabricated age', () => {
    const out = mapCheckpointRunInFlight(
      { activeRun: { active: true, candidate: 'sha1', startedAtMs: NOW - 1000, elapsedSec: 1 }, computedAtMs: null },
      NOW,
    );
    expect(out?.asOfAgeMs).toBeNull();
  });

  it('asOfAgeMs never goes negative when the cache read races past `now` (clock skew)', () => {
    const out = mapCheckpointRunInFlight(
      { activeRun: { active: true, candidate: 'sha1', startedAtMs: NOW, elapsedSec: 0 }, computedAtMs: NOW + 500 },
      NOW,
    );
    expect(out?.asOfAgeMs).toBe(0);
  });

  /**
   * EI-19395922387569240 — THE RECURRENCE GUARD. This leg was cache-ONLY, and `{ active:
   * false }` was documented (and consumed at the gate lever) as "MEASURED idle". It was not
   * measured: it was a snapshot of unbounded age. Both directions were already wrong in the
   * live DB when this was filed, measured 2026-08-03:
   *
   *   papercusp-workspace  age 90.9s (its own ttl is 90s)  activeRun { active: false }
   *   default              age 7.03 HOURS                  activeRun { active: true,
   *                                                          candidate f990615f, elapsedSec 314 }
   *
   * The stale `false` is the expensive one — it routes the gate lever to "wait out the
   * quiet-cut window, then release:checkpoint-run", i.e. it recommends firing a manual run
   * into a live one, the exact 🚨 action CLAUDE.md forbids because it discards an in-flight
   * rescue and costs a full ~55min suite.
   *
   * The fix is reuse, not new machinery: `isCheckpointRunLockHeldCheap` already answered this
   * for BOTH origins (every run holds that lock for its whole duration) and was simply never
   * wired to the read agents actually call.
   */
  describe('EI-19395922387569240: the LIVE run lock outranks the cached reading for liveness', () => {
    const MARKER_FIXTURE = {
      fromCandidate: '6f4181447486a33e4b471b82dee3ed0893c3efa6',
      refiringCandidate: '16dbb52a7849320e27832500bf2157f00b1db1c3',
      refireAttempt: 1,
      maxRefires: 2,
    };
    const STALE = 25_299_000; // the 7.03h `default` row, to the millisecond
    const staleActive = {
      activeRun: { active: true, candidate: 'f990615f', startedAtMs: NOW - STALE - 314_000, elapsedSec: 314 },
      computedAtMs: NOW - STALE,
    };
    const staleIdle = {
      activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
      computedAtMs: NOW - 600_000,
    };

    it('⭐ a HELD lock overturns a stale cached "idle" — the false all-clear that sent callers to fire into a live run', () => {
      const out = mapCheckpointRunInFlight(staleIdle, NOW, null, { held: true, elapsedSec: 720 });
      expect(out?.active).toBe(true);
      expect(out?.activeSource).toBe('run-lock');
      // The lock knows how long, so the caller can see it is a long run rather than a new one.
      expect(out?.elapsedSec).toBe(720);
      expect(out?.startedAtMs).toBe(NOW - 720_000);
    });

    it('P-009: pre-lock process authority overturns idle without inventing a candidate', () => {
      const processAuthority = {
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        cgroupPath: '/user.slice/run-u42.scope',
        pid: 4242,
      };
      const out = mapCheckpointRunInFlight(staleIdle, NOW, null, {
        held: true,
        elapsedSec: 45,
        startedAtMs: NOW - 45_000,
        source: 'process-authority',
        processAuthority,
      });
      expect(out).toMatchObject({
        active: true,
        activeSource: 'process-authority',
        candidate: null,
        elapsedSec: 45,
        startedAtMs: NOW - 45_000,
        processAuthority,
      });
    });

    it('⭐ a NOT-HELD lock overturns a stale cached "active" — a run that ended hours ago must not read as in flight', () => {
      const out = mapCheckpointRunInFlight(staleActive, NOW, null, { held: false, elapsedSec: null });
      expect(out?.active).toBe(false);
      expect(out?.activeSource).toBe('run-lock');
      // And the finished run's DETAIL must not be re-presented as current: reporting
      // `candidate f990615f` here is precisely "what the gate is judging right now" being
      // answered with a 7h-old fact.
      expect(out?.candidate).toBeNull();
      expect(out?.startedAtMs).toBeNull();
      expect(out?.elapsedSec).toBeNull();
      // The cache's age is still reported — that is what the field means.
      expect(out?.asOfAgeMs).toBe(STALE);
    });

    /**
     * The one case the lock cannot see, straight from its own doc: it "misses a manual-unit
     * run that hasn't (yet) raced for the shared run-lock". During that startup sliver the
     * systemd probe is right and the lock is not, so a FRESH cached active must survive.
     * Without this the fix would trade a stale false negative for a fresh one.
     */
    it('does NOT let a not-held lock overturn a FRESH cached active (the manual-run startup sliver)', () => {
      const freshActive = {
        activeRun: { active: true, candidate: 'abc123', startedAtMs: NOW - 5_000, elapsedSec: 5 },
        computedAtMs: NOW - 1_000,
      };
      const out = mapCheckpointRunInFlight(freshActive, NOW, null, { held: false, elapsedSec: null });
      expect(out?.active).toBe(true);
      // Cache-backed, so it must NOT claim to be a live measurement.
      expect(out).not.toHaveProperty('activeSource');
      expect(out?.candidate).toBe('abc123');
    });

    it('EI-20444707119723892: a not-held lock overturns a FRESH cache of an OLD run that just finished', () => {
      const justFinished = {
        activeRun: {
          active: true,
          candidate: 'old-run',
          startedAtMs: NOW - 120 * 60_000,
          elapsedSec: 120 * 60 - 1,
        },
        // The cache was computed one second ago, immediately before the watchdog released
        // the lock. Cache freshness cannot turn a two-hour-old run back into a startup race.
        computedAtMs: NOW - 1_000,
      };
      const out = mapCheckpointRunInFlight(justFinished, NOW, null, { held: false, elapsedSec: null });
      expect(out).toMatchObject({ active: false, activeSource: 'run-lock' });
      expect(out?.candidate).toBeNull();
      expect(out?.startedAtMs).toBeNull();
      expect(out?.elapsedSec).toBeNull();
    });

    it('EI-21356516911755816: preserves finished-unit cancellation evidence across a live-lock release', () => {
      const terminalEvidence = {
        source: 'systemd-exec-stop-post' as const,
        candidate: 'cancelled-candidate',
        serviceResult: 'success',
        exitCode: 'killed',
        exitStatus: 'TERM',
        abnormal: true,
      };
      const cacheStillLabelsUnitActive = {
        activeRun: {
          active: true,
          candidate: 'cancelled-candidate',
          startedAtMs: NOW - 120 * 60_000,
          elapsedSec: 120 * 60,
          terminalMarker: false,
          terminalEvidence,
        },
        computedAtMs: NOW - 1_000,
      };

      const out = mapCheckpointRunInFlight(cacheStillLabelsUnitActive, NOW, null, {
        held: false,
        elapsedSec: null,
      });

      expect(out).toMatchObject({
        active: false,
        activeSource: 'run-lock',
        candidate: null,
        startedAtMs: null,
        elapsedSec: null,
        terminalMarker: false,
        terminalEvidence,
      });
    });

    it('answers liveness with NO cache at all — previously UNKNOWN, though the lock could answer for free', () => {
      expect(mapCheckpointRunInFlight(null, NOW, null, { held: true, elapsedSec: 60 })).toMatchObject({
        active: true,
        activeSource: 'run-lock',
        elapsedSec: 60,
      });
      expect(mapCheckpointRunInFlight(null, NOW, null, { held: false, elapsedSec: null })).toMatchObject({
        active: false,
        activeSource: 'run-lock',
      });
      // No cache behind it, so there is no cache-age to report.
      expect(mapCheckpointRunInFlight(null, NOW, null, { held: false, elapsedSec: null })?.asOfAgeMs).toBeNull();
    });

    it('still reports UNKNOWN (null) when BOTH the cache and the lock fail to answer', () => {
      expect(mapCheckpointRunInFlight(null, NOW, null, null)).toBeNull();
      expect(mapCheckpointRunInFlight(null, NOW)).toBeNull();
    });

    it("prefers the lock elapsed over the cache's frozen one, which understates a live run by exactly asOfAgeMs", () => {
      const cachedMidRun = {
        activeRun: { active: true, candidate: 'abc123', startedAtMs: NOW - 720_000, elapsedSec: 300 },
        computedAtMs: NOW - 420_000,
      };
      // Cache says 5m (frozen 7m ago); the run is really 12m in.
      const out = mapCheckpointRunInFlight(cachedMidRun, NOW, null, { held: true, elapsedSec: 720 });
      expect(out?.elapsedSec).toBe(720);
    });

    it('does not mix cached run A detail with the live lock identity for back-to-back run B', () => {
      const out = mapCheckpointRunInFlight(
        {
          activeRun: {
            active: true,
            candidate: 'run-a-candidate',
            startedAtMs: NOW - 20 * 60_000,
            elapsedSec: 20 * 60,
          },
          computedAtMs: NOW - 1_000,
        },
        NOW,
        null,
        {
          held: true,
          startedAtMs: NOW - 4_000,
          elapsedSec: 4,
          pid: 4242,
        },
      );

      expect(out).toMatchObject({
        active: true,
        activeSource: 'run-lock',
        startedAtMs: NOW - 4_000,
        elapsedSec: 4,
      });
      expect(out?.candidate).toBeNull();
    });

    it('attaches the retriage marker on a lock-driven upgrade, so the cron re-triage window stays readable', () => {
      const out = mapCheckpointRunInFlight(staleIdle, NOW, MARKER_FIXTURE, { held: true, elapsedSec: 900 });
      expect(out?.active).toBe(true);
      expect(out?.inRetriageWindow).toBe(true);
      expect(out?.candidate).toBe(MARKER_FIXTURE.refiringCandidate);
      expect(out?.candidateSource).toBe('retriage-marker');
    });

    it('an omitted lock leaves the reply shape byte-identical to the cache-only behaviour', () => {
      const cache = {
        activeRun: { active: true, candidate: 'abc123', startedAtMs: NOW - 60_000, elapsedSec: 60 },
        computedAtMs: NOW - 1_000,
      };
      expect(mapCheckpointRunInFlight(cache, NOW, null, null)).toEqual(mapCheckpointRunInFlight(cache, NOW));
      expect(mapCheckpointRunInFlight(cache, NOW, null, null)).not.toHaveProperty('activeSource');
    });
  });
});

describe('gitPipelinePosition wires checkpointRunInFlight into gate + notes (EI-18793581783459047)', () => {
  it('an active gate run surfaces on gate.checkpointRunInFlight AND as a contention-warning note', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => ({
          activeRun: {
            active: true,
            candidate: 'deadbeef1234',
            startedAtMs: Date.now() - 3 * 60_000,
            elapsedSec: 180,
            systemd: {
              scope: 'user',
              argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
              loadState: 'loaded',
              known: true,
              invocationId: 'invocation-123',
            },
          },
          computedAtMs: Date.now(),
        }),
        readCheckpointRunLock: async () => ({ held: true, elapsedSec: 180 }),
      },
    );
    expect(res.gate.checkpointRunInFlight?.active).toBe(true);
    expect(res.gate.checkpointRunInFlight?.candidate).toBe('deadbeef1234');
    expect(res.gate.checkpointRunInFlight?.systemd).toEqual({
      scope: 'user',
      argv: ['--user', 'show', 'unit.service', '--property=LoadState'],
      loadState: 'loaded',
      known: true,
      invocationId: 'invocation-123',
    });
    expect(res.notes.join(' ')).toMatch(/GATE RUN IN FLIGHT/);
    expect(res.notes.join(' ')).toMatch(/EI-18793581783459047/);
  });

  it('an idle gate (active:false) reaches gate.checkpointRunInFlight but adds no contention note', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => ({
          activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
          computedAtMs: Date.now(),
        }),
      },
    );
    expect(res.gate.checkpointRunInFlight?.active).toBe(false);
    expect(res.notes.join(' ')).not.toMatch(/GATE RUN IN FLIGHT/);
  });

  it('BOTH reads failing (cache null + lock null) leaves gate.checkpointRunInFlight null and adds no note', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => null,
        // EI-19395922387569240: the lock must be nulled EXPLICITLY now. A missing cache alone
        // is no longer UNKNOWN — the lock can answer liveness on its own, which is the point.
        readCheckpointRunLock: async () => null,
      },
    );
    expect(res.gate.checkpointRunInFlight).toBeNull();
    expect(res.notes.join(' ')).not.toMatch(/GATE RUN IN FLIGHT/);
  });

  /**
   * EI-19395922387569240 — the WIRING guard. The mapper unit-tests above prove the precedence
   * logic; this proves the dep is actually reachable from `gitPipelinePosition`, which is the
   * half that was missing: `isCheckpointRunLockHeldCheap` already existed and was correct, it
   * was simply never wired to the read agents call (its only caller was system-health).
   */
  it('⭐ a HELD live lock reports an in-flight run even with NO cache — and raises the contention note', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => null,
        readCheckpointRunLock: async () => ({ held: true, elapsedSec: 600 }),
      },
    );
    expect(res.gate.checkpointRunInFlight?.active).toBe(true);
    expect(res.gate.checkpointRunInFlight?.activeSource).toBe('run-lock');
    expect(res.notes.join(' ')).toMatch(/GATE RUN IN FLIGHT/);
  });

  it('P-009: pre-lock process authority reaches the candidate assessment as WAIT, never no-active-run', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({ consecutiveReds: 5, stalled: true }),
        readCheckpointRunSnapshot: async () => null,
        readCheckpointRunLock: async () => ({
          held: true,
          elapsedSec: 45,
          startedAtMs: Date.now() - 45_000,
          source: 'process-authority',
          processAuthority: {
            workspace: 'papercusp-workspace',
            harness: 'papercusp',
            cgroupPath: '/user.slice/run-u42.scope',
            pid: 4242,
          },
        }),
      },
    );
    expect(res.gate.checkpointRunInFlight).toMatchObject({
      active: true,
      activeSource: 'process-authority',
      candidate: null,
    });
    expect(res.assessments.gateCandidate).toBe('candidate-not-yet-published');
    expect(res.nextAction ?? '').not.toMatch(/release:checkpoint-run/i);
  });

  it('⭐ a HELD live lock overturns a STALE cached idle — the reading that used to send callers to fire into a live run', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        readCheckpointRunSnapshot: async () => ({
          activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
          computedAtMs: Date.now() - 7 * 60 * 60_000, // the 7h row measured live 2026-08-03
        }),
        readCheckpointRunLock: async () => ({ held: true, elapsedSec: 900 }),
      },
    );
    expect(res.gate.checkpointRunInFlight?.active).toBe(true);
    expect(res.gate.checkpointRunInFlight?.activeSource).toBe('run-lock');
    expect(res.notes.join(' ')).toMatch(/GATE RUN IN FLIGHT/);
  });

  it('does not claim a cache-backed idle was "measured", but does for a lock-backed one', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const run = (lock: { held: boolean; elapsedSec: number | null } | null) =>
      gitPipelinePosition(
        { sha: 'abc1234567' },
        {
          git,
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap({ consecutiveReds: 5, stalled: true }),
          readCheckpointRunSnapshot: async () => ({
            activeRun: { active: false, candidate: null, startedAtMs: null, elapsedSec: null },
            computedAtMs: Date.now() - 600_000,
          }),
          readCheckpointRunLock: async () => lock,
        },
      );
    const gateDetail = (r: Awaited<ReturnType<typeof run>>) => r.stages.find((s) => s.name === 'gate')?.detail ?? '';
    expect(gateDetail(await run({ held: false, elapsedSec: null }))).toMatch(/measured live via the run lock/);
    // Cache-only: the same idle reading must NOT be dressed up as a measurement.
    const cacheOnly = gateDetail(await run(null));
    expect(cacheOnly).toMatch(/according to the run-liveness CACHE/);
    expect(cacheOnly).not.toMatch(/measured/);
  });

  it('⭐ composes a live run-lock into the stale-verdict reason (EI-21345219754813525)', async () => {
    const git = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap({
            consecutiveReds: 5,
            stalled: true,
            verdictStale: true,
            verdictStaleReason: 'the gate writer has not produced a verdict since the last fire',
            verdictStaleReasonCode: 'writer-starved',
          }),
        readCheckpointRunSnapshot: async () => null,
        readCheckpointRunLock: async () => ({ held: true, elapsedSec: 600 }),
      },
    );

    expect(res.gate.checkpointRunInFlight?.active).toBe(true);
    expect(res.gate.checkpointRunInFlight?.activeSource).toBe('run-lock');
    expect(res.gate.verdictStale).toBe(true);
    expect(res.gate.verdictStaleReasonCode).toBe('run-in-flight');
    expect(res.gate.verdictStaleReason).toMatch(/measured live via the run lock/);
    expect(res.gate.verdictStaleReason).toMatch(/do NOT fire release:checkpoint-run/);
  });
});

/**
 * WI-9974 — the runtime-generation leg.
 *
 * Why this exists at all: the same root cause ("deployed" is not "loaded by the
 * process that runs it") has been independently rediscovered and written down at
 * least EIGHT times on this fleet, and EI-18642482762875484 concluded that
 * documentation is SATURATED — only a detector can close the loop. These tests
 * pin BOTH directions, because only one of them was ever documented and the
 * undocumented one (a fix already live on a staging-tree host while :3070 lags)
 * is what cost WI-9137 several wakes of waiting on a deploy it did not need.
 */
describe('runtime generations (WI-9974) — every host, both directions', () => {
  type Probe = Parameters<typeof evaluateRuntimeGenerations>[0][number];
  const host = (over: Partial<Probe> = {}): Probe => ({
    unit: 'papercup-bg-host.service',
    label: 'bg-host',
    releasePipelineApplies: false,
    activationLever: 'dev:restart { target: "bg-host" }',
    process: { pid: 1, startedAtMs: 2_000 },
    codeAsOfMs: 1_000,
    ...over,
  });

  it('reports a host that started AFTER the code changed as running it', () => {
    const [g] = evaluateRuntimeGenerations([host({ process: { pid: 7, startedAtMs: 5_000 }, codeAsOfMs: 1_000 })]);
    expect(g.runningYourCode).toBe(true);
    expect(g.behindMin).toBeNull();
  });

  it('reports a host that started BEFORE the code changed as behind, with the lag', () => {
    const [g] = evaluateRuntimeGenerations([host({ process: { pid: 7, startedAtMs: 0 }, codeAsOfMs: 600_000 })]);
    expect(g.runningYourCode).toBe(false);
    expect(g.behindMin).toBe(10);
  });

  // The contract evaluateServing already states: never fabricate a boolean.
  it('yields NULL with a reason when the process start is unreadable — not false', () => {
    const [g] = evaluateRuntimeGenerations([host({ process: null })]);
    expect(g.runningYourCode).toBeNull();
    expect(g.unknownReason?.code).toBe('insufficient-data');
  });

  it('yields NULL with a reason when the code time is unreadable — not true', () => {
    const [g] = evaluateRuntimeGenerations([host({ codeAsOfMs: null })]);
    expect(g.runningYourCode).toBeNull();
    expect(g.unknownReason?.code).toBe('insufficient-data');
  });

  /**
   * Caught by LIVE EXERCISE, not by the unit tests above — which is the point.
   * The first implementation compared start-time to deploy-time for the release
   * host and reported `runningYourCode: true` for :3070 on the very path that
   * motivated this leg, while that checkout provably lacked the change. Start vs
   * deploy answers "did it restart since SOME deploy", never "which content did
   * that deploy carry". These pin the corrected semantics.
   */
  describe('release host: content identity is load-bearing, not just restart recency', () => {
    const releaseHost = (over: Partial<Probe> = {}) =>
      host({
        unit: 'papercup-dev-api.service',
        label: ':3070 release operator',
        releasePipelineApplies: true,
        // Restarted LONG after the deploy — the old implementation called this `true`.
        process: { pid: 1, startedAtMs: 900_000 },
        codeAsOfMs: 1_000,
        ...over,
      });

    it('is FALSE when the deployed copy differs from the working tree, however recent the restart', () => {
      const [g] = evaluateRuntimeGenerations([releaseHost({ contentDiffers: true })]);
      expect(g.runningYourCode).toBe(false);
    });

    it('is TRUE only when the content matches AND the process started since the deploy', () => {
      const [g] = evaluateRuntimeGenerations([releaseHost({ contentDiffers: false })]);
      expect(g.runningYourCode).toBe(true);
    });

    it('is NULL — never true — when the content comparison could not be made', () => {
      const [g] = evaluateRuntimeGenerations([releaseHost({ contentDiffers: null })]);
      expect(g.runningYourCode).toBeNull();
      expect(g.unknownReason?.code).toBe('insufficient-data');
    });

    it('ignores contentDiffers for a staging-tree host, which imports the tree file directly', () => {
      const [g] = evaluateRuntimeGenerations([
        host({
          releasePipelineApplies: false,
          contentDiffers: true,
          process: { pid: 1, startedAtMs: 9_000 },
          codeAsOfMs: 1_000,
        }),
      ]);
      expect(g.runningYourCode).toBe(true);
    });

    // The end-to-end shape of the WI-9137 miss: :3070 behind, bg-host already live.
    it('produces the divergence note for the real WI-9137 shape', () => {
      const gens = evaluateRuntimeGenerations([
        releaseHost({ contentDiffers: true }),
        host({ unit: 'papercup-bg-host.service', process: { pid: 2, startedAtMs: 900_000 }, codeAsOfMs: 1_000 }),
      ]);
      const note = runtimeGenerationDivergenceNote(gens, 'packages/operator-core/lib/memory/knowledge-read.ts');
      expect(note).toContain('papercup-bg-host.service');
      expect(note).toMatch(/NOT blocked on a deploy/i);
      // A content-differs host is out of date by CONTENT, not by minutes — the
      // first live run rendered this as the literal "~nullm behind".
      expect(note).toContain('serving DIFFERENT content');
      expect(note).not.toContain('null');
    });
  });

  it('labels the clock per host: deploy for the release checkout, file-mtime for a staging-tree host', () => {
    const [release, staging] = evaluateRuntimeGenerations([
      host({ unit: 'papercup-dev-api.service', releasePipelineApplies: true }),
      host({ unit: 'papercup-staging-api.service', releasePipelineApplies: false }),
    ]);
    expect(release.codeAsOfSource).toBe('deploy');
    expect(staging.codeAsOfSource).toBe('file-mtime');
  });

  describe('the divergence note — the sentence this leg exists to emit', () => {
    const diverging = () =>
      evaluateRuntimeGenerations([
        host({
          unit: 'papercup-dev-api.service',
          label: ':3070 release operator',
          releasePipelineApplies: true,
          process: { pid: 1, startedAtMs: 0 },
          codeAsOfMs: 600_000,
          // A release row is only DECIDABLE once content identity is known.
          contentDiffers: true,
        }),
        host({ unit: 'papercup-bg-host.service', process: { pid: 2, startedAtMs: 900_000 }, codeAsOfMs: 600_000 }),
      ]);

    it('fires when some hosts run the code and others do not, naming both sides', () => {
      const note = runtimeGenerationDivergenceNote(diverging(), 'packages/operator-core/lib/memory/knowledge-read.ts');
      expect(note).toContain('RUNTIME GENERATIONS DIVERGE');
      expect(note).toContain('papercup-bg-host.service');
      expect(note).toContain('papercup-dev-api.service');
      // The load-bearing correction: not blocked on a deploy merely to OBSERVE it.
      expect(note).toContain('ALREADY LIVE');
      expect(note).toMatch(/NOT blocked on a deploy/i);
    });

    // Falsifiability controls. A note that fires on everything says nothing, so
    // pin the cases where it must STAY SILENT.
    it('stays silent when every host agrees it is current', () => {
      const gens = evaluateRuntimeGenerations([
        host({ unit: 'a.service', process: { pid: 1, startedAtMs: 9_000 }, codeAsOfMs: 1_000 }),
        host({ unit: 'b.service', process: { pid: 2, startedAtMs: 9_000 }, codeAsOfMs: 1_000 }),
      ]);
      expect(runtimeGenerationDivergenceNote(gens, 'x.ts')).toBeNull();
    });

    it('stays silent when every host agrees it is behind (a real all-stale case)', () => {
      const gens = evaluateRuntimeGenerations([
        host({ unit: 'a.service', process: { pid: 1, startedAtMs: 0 }, codeAsOfMs: 600_000 }),
        host({ unit: 'b.service', process: { pid: 2, startedAtMs: 0 }, codeAsOfMs: 600_000 }),
      ]);
      expect(runtimeGenerationDivergenceNote(gens, 'x.ts')).toBeNull();
    });

    it('stays silent rather than inferring divergence from a single decidable host', () => {
      const gens = evaluateRuntimeGenerations([
        host({ unit: 'a.service', process: { pid: 1, startedAtMs: 9_000 }, codeAsOfMs: 1_000 }),
        host({ unit: 'b.service', process: null }),
      ]);
      expect(runtimeGenerationDivergenceNote(gens, 'x.ts')).toBeNull();
    });
  });
});

describe('WI-38455: runtime generations expose the exact process loaded identity', () => {
  const generation = (over: Partial<RuntimeGeneration> = {}): RuntimeGeneration => ({
    unit: 'papercup-bg-host.service',
    label: 'bg-host',
    pid: 42,
    startedAtMs: Date.parse('2026-08-13T10:00:00.000Z'),
    codeAsOfMs: 1,
    codeAsOfSource: 'file-mtime',
    runningYourCode: true,
    behindMin: null,
    loadedIdentity: null,
    loadedIdentityUnknown: null,
    activationLever: 'restart',
    unknownReason: null,
    ...over,
  });
  const vintage = (over: Partial<RuntimeVintageRow> = {}): RuntimeVintageRow => ({
    workspaceId: 'ws',
    unit: 'bg-host',
    host: 'tower',
    treeSha: 'abc123',
    buildTime: '2026-08-13T09:59:00.000Z',
    bundleVersion: '0.0.15-alpha',
    pid: 42,
    extra: {},
    reportedAt: '2026-08-13T10:00:01.000Z',
    ...over,
  });

  it('joins a boot-reported identity by local host + current pid + report-after-start', () => {
    const [result] = attachRuntimeLoadedIdentities([generation()], [vintage()], 'tower');
    expect(result.loadedIdentity).toMatchObject({
      source: 'runtime-vintage',
      unit: 'bg-host',
      host: 'tower',
      treeSha: 'abc123',
      bundleVersion: '0.0.15-alpha',
    });
    expect(result.loadedIdentityUnknown).toBeNull();
  });

  it.each([
    ['a row from another host', vintage({ host: 'desktop' })],
    ['a row for another pid', vintage({ pid: 41 })],
    ['a stale row from an earlier process that reused the pid', vintage({ reportedAt: '2026-08-13T09:59:59.000Z' })],
  ])('does not misattribute %s', (_label, row) => {
    const [result] = attachRuntimeLoadedIdentities([generation()], [row], 'tower');
    expect(result.loadedIdentity).toBeNull();
    expect(result.loadedIdentityUnknown?.code).toBe('insufficient-data');
  });

  it('does not call a metadata-free vintage row a concrete identity', () => {
    const [result] = attachRuntimeLoadedIdentities(
      [generation()],
      [vintage({ treeSha: null, bundleVersion: null })],
      'tower',
    );
    expect(result.loadedIdentity).toBeNull();
    expect(result.loadedIdentityUnknown?.detail).toMatch(/neither treeSha nor bundleVersion/);
  });
});

describe('P-002 / D-009 pipeline assessment truth tables', () => {
  type PipelineInput = Parameters<typeof assessPipelinePosition>[0];
  type PipelineExpected = ReturnType<typeof assessPipelinePosition>;
  const pipelineBase: PipelineInput = {
    targetSha: 'abc1234567',
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    positionsUnknown: [],
    positionsNewerCommit: [],
    servingStartedSinceCodeChange: true,
  };
  const pipelineCases: Array<{ name: string; input: PipelineInput; expected: PipelineExpected }> = [
    {
      name: 'uncommitted',
      input: {
        ...pipelineBase,
        dirtyUncommitted: true,
        positions: { committedLocal: false, onStaging: false, inMain: false, deployed: false },
      },
      expected: 'uncommitted',
    },
    {
      // EI-24049239243821100: the positions describe the path's PREVIOUS commit, which
      // shipped; the edit on disk did not. This row used to return 'live'.
      name: 'dirty edit on top of a deployed older commit',
      input: { ...pipelineBase, dirtyUncommitted: true },
      expected: 'uncommitted',
    },
    {
      name: 'awaiting-push',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
      },
      expected: 'awaiting-push',
    },
    {
      name: 'awaiting-gate',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      },
      expected: 'awaiting-gate',
    },
    {
      name: 'awaiting-deploy',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      },
      expected: 'awaiting-deploy',
    },
    { name: 'live', input: pipelineBase, expected: 'live' },
    {
      name: 'restart-required',
      input: { ...pipelineBase, servingStartedSinceCodeChange: false },
      expected: 'restart-required',
    },
    {
      name: 'unresolved subject',
      input: { ...pipelineBase, targetSha: null, dirtyUncommitted: false },
      expected: null,
    },
    {
      name: 'unknown stage',
      input: { ...pipelineBase, positionsUnknown: ['inMain'] },
      expected: null,
    },
    {
      name: 'newer-commit qualifier preserves the measured ladder code',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        positionsNewerCommit: ['inMain'],
      },
      expected: 'awaiting-gate',
    },
    {
      name: 'dirty edit outranks a newer-commit qualifier',
      input: { ...pipelineBase, dirtyUncommitted: true, positionsNewerCommit: ['inMain'] },
      expected: 'uncommitted',
    },
    {
      name: 'onStaging cannot excuse committedLocal=false',
      input: {
        ...pipelineBase,
        positions: { committedLocal: false, onStaging: true, inMain: true, deployed: true },
      },
      expected: null,
    },
    {
      name: 'inMain cannot excuse onStaging=false',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: false, inMain: true, deployed: true },
      },
      expected: null,
    },
    {
      name: 'deployed cannot excuse inMain=false',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: true },
      },
      expected: null,
    },
    {
      name: 'serving=true cannot turn deployed=false into live',
      input: {
        ...pipelineBase,
        positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      },
      expected: 'awaiting-deploy',
    },
    {
      name: 'deployed with an unreadable process',
      input: { ...pipelineBase, servingStartedSinceCodeChange: null },
      expected: null,
    },
  ];

  it.each(pipelineCases)('git.pipelinePosition: $name → $expected', ({ input, expected }) => {
    expect(assessPipelinePosition(input)).toBe(expected);
  });

  type VerdictInput = Parameters<typeof assessGateVerdict>[0];
  type VerdictExpected = ReturnType<typeof assessGateVerdict>;
  const verdictBase: VerdictInput = {
    inconclusive: null,
    consecutiveReds: 0,
    verdictStale: false,
    fireStale: false,
    mainBehindStaging: false,
    verdictUnknownLegs: [],
  };
  const verdictCases: Array<{ name: string; input: VerdictInput; expected: VerdictExpected }> = [
    {
      name: 'inconclusive outranks frozen counters',
      input: { ...verdictBase, inconclusive: { status: 'run-active' }, consecutiveReds: 4 },
      expected: 'inconclusive',
    },
    // WI-10004092: the measured incident. A crash latched `repair-in-progress` while the head was
    // unjudged, then a verify measured it red and latched the SAME status; the code must change.
    {
      name: 'repair hold, repair head not yet judged — no verdict on this head',
      input: {
        ...verdictBase,
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        repairHeadVerdict: 'not-judged',
      },
      expected: 'inconclusive',
    },
    {
      name: 'repair hold, repair head measured red — a code verdict, not an abort',
      input: {
        ...verdictBase,
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        repairHeadVerdict: 'full-gate-red',
      },
      expected: 'repair-head-red',
    },
    {
      name: 'repair hold with no fix admitted yet — the frozen red is the head\'s red',
      input: {
        ...verdictBase,
        inconclusive: { status: 'repair-in-progress' },
        consecutiveReds: 1,
        repairHeadVerdict: 'same-as-frozen-full-gate-red',
      },
      expected: 'repair-head-red',
    },
    {
      name: 'repair-staging-mismatch hold with a red head is also repair-head-red',
      input: {
        ...verdictBase,
        inconclusive: { status: 'repair-staging-mismatch' },
        repairHeadVerdict: 'full-gate-red',
      },
      expected: 'repair-head-red',
    },
    {
      name: 'a non-repair abort stays inconclusive even beside a red repair head',
      input: { ...verdictBase, inconclusive: { status: 'cancelled' }, repairHeadVerdict: 'full-gate-red' },
      expected: 'inconclusive',
    },
    {
      name: 'repair hold with an unread queue (null verdict) stays inconclusive',
      input: { ...verdictBase, inconclusive: { status: 'repair-in-progress' }, repairHeadVerdict: null },
      expected: 'inconclusive',
    },
    {
      name: 'repair hold whose head is isolated-green is not a red',
      input: {
        ...verdictBase,
        inconclusive: { status: 'repair-in-progress' },
        repairHeadVerdict: 'isolated-repair-green',
      },
      expected: 'inconclusive',
    },
    {
      name: 'red-stale',
      input: { ...verdictBase, consecutiveReds: 2, verdictStale: true },
      expected: 'red-stale',
    },
    {
      name: 'red-current',
      input: { ...verdictBase, consecutiveReds: 2 },
      expected: 'red-current',
    },
    {
      name: 'not-firing',
      input: { ...verdictBase, fireStale: true },
      expected: 'not-firing',
    },
    {
      name: 'unknown stall condition is not a passing verdict',
      input: { ...verdictBase, verdictUnknownLegs: ['gate.stalled'] },
      expected: null,
    },
    {
      name: 'passing-buffered',
      input: { ...verdictBase, mainBehindStaging: true },
      expected: 'passing-buffered',
    },
    { name: 'passing-current', input: verdictBase, expected: 'passing-current' },
    {
      name: 'unknown red counter',
      input: { ...verdictBase, verdictUnknownLegs: ['gate.consecutiveReds'] },
      expected: null,
    },
    {
      name: 'unresolved main/staging subject',
      input: { ...verdictBase, mainBehindStaging: null },
      expected: null,
    },
    {
      name: 'unknown main/staging leg',
      input: { ...verdictBase, verdictUnknownLegs: ['verdictProvenance.mainFastForwarded'] },
      expected: null,
    },
    {
      name: 'zero reds never outranks fireStale',
      input: { ...verdictBase, consecutiveReds: 0, fireStale: true, mainBehindStaging: false },
      expected: 'not-firing',
    },
  ];

  it.each(verdictCases)('gate.greenCheckpoint.verdict: $name → $expected', ({ input, expected }) => {
    expect(assessGateVerdict(input)).toBe(expected);
  });

  type CandidateInput = Parameters<typeof assessGateCandidate>[0];
  type CandidateExpected = ReturnType<typeof assessGateCandidate>;
  const candidateCases: Array<{ name: string; input: CandidateInput; expected: CandidateExpected }> = [
    {
      // EI-21862849770458561: `checkpointRunInFlight` must be EXPLICITLY `{ active: false }`
      // for this to be a genuinely-measured absence — an omitted/null field is the SEPARATE
      // "unmeasured" case below, which used to fall through to this same code by mistake.
      name: 'measured no-active-run',
      input: { judgingSha: null, verdictUnknownLegs: [], checkpointRunInFlight: { active: false } },
      expected: 'no-active-run',
    },
    {
      // EI-21862849770458561: `checkpointRunInFlight == null` means the mapper could not
      // measure liveness at all (neither cache nor live-lock read answered) — genuinely
      // UNKNOWN, not a measured "nothing running". Before the fix this fell through to
      // 'no-active-run', contradicting the cell's own "measured absence, not a failed read"
      // meaning text and steering a reader into firing release:checkpoint-run on an unknown.
      name: 'unmeasured checkpointRunInFlight is unknown, not no-active-run',
      input: { judgingSha: null, verdictUnknownLegs: [], checkpointRunInFlight: null },
      expected: null,
    },
    {
      name: 'active run whose candidate is not yet published',
      input: {
        judgingSha: null,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: true },
      },
      expected: 'candidate-not-yet-published',
    },
    {
      name: 'judging-current-path',
      input: {
        judgingSha: 'abc1234567',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
      },
      expected: 'judging-current-path',
    },
    {
      name: 'judging-without-current-path',
      input: {
        judgingSha: 'abc1234567',
        judgingShaSource: 'in-flight-candidate',
        judgingContainsPath: false,
        verdictUnknownLegs: [],
      },
      expected: 'judging-without-current-path',
    },
    {
      name: 'inferred-candidate',
      input: {
        judgingSha: 'abc1234567',
        judgingShaSource: 'run-probe',
        judgingContainsPath: null,
        verdictUnknownLegs: ['changeInCandidate.judgingContainsPath'],
      },
      expected: 'inferred-candidate',
    },
    {
      name: 'sha-only and submodule unknowns are unavailable, not no-active-run',
      input: { judgingSha: null, verdictUnknownLegs: ['changeInCandidate.judgingSha'] },
      expected: null,
    },
    {
      name: 'authoritative sha without containment',
      input: {
        judgingSha: 'abc1234567',
        judgingShaSource: 'retriage-marker',
        judgingContainsPath: null,
        verdictUnknownLegs: [],
      },
      expected: null,
    },
    {
      name: 'sha presence alone never proves path containment',
      input: {
        judgingSha: 'abc1234567',
        judgingShaSource: 'in-flight-candidate',
        verdictUnknownLegs: [],
      },
      expected: null,
    },
    // main-green-status-visible-2026-09-03 P-011 follow-up (grader card EI-22277841040474660
    // C5 leg 3): a frozen repair queue is an AUTHORITATIVE judged sha. Between runs it gets
    // its own codes; while a run is active it resumed that candidate, so the in-flight codes
    // apply. Before this, the same reading was 'inferred-candidate' / 'no-active-run'.
    {
      name: 'frozen queue between runs, candidate contains the path',
      input: {
        judgingSha: 'frozen0000',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      },
      expected: 'frozen-candidate-contains-path',
    },
    {
      name: 'frozen queue between runs, candidate lacks the path',
      input: {
        judgingSha: 'frozen0000',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: false,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      },
      expected: 'frozen-candidate-without-path',
    },
    {
      name: 'frozen queue with liveness UNKNOWN still reads as the frozen candidate, not a live run',
      input: {
        judgingSha: 'frozen0000',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
        checkpointRunInFlight: null,
      },
      expected: 'frozen-candidate-contains-path',
    },
    {
      name: 'frozen queue while a run is ACTIVE: the run resumed it, so the in-flight code applies',
      input: {
        judgingSha: 'frozen0000',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: true,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: true },
      },
      expected: 'judging-current-path',
    },
    {
      name: 'frozen queue sha without a containment verdict is unavailable, never inferred-candidate',
      input: {
        judgingSha: 'frozen0000',
        judgingShaSource: 'repair-queue',
        judgingContainsPath: null,
        verdictUnknownLegs: [],
        checkpointRunInFlight: { active: false },
      },
      expected: null,
    },
  ];

  it.each(candidateCases)('gate.greenCheckpoint.candidate: $name → $expected', ({ input, expected }) => {
    expect(assessGateCandidate(input)).toBe(expected);
  });

  type DeployedInput = Parameters<typeof assessDeployedSha>[0];
  type DeployedExpected = ReturnType<typeof assessDeployedSha>;
  const deployedCases: Array<{ name: string; input: DeployedInput; expected: DeployedExpected }> = [
    {
      name: 'executing',
      input: { deployedSha: 'abc1234567', servingStartedSinceCodeChange: true, verdictUnknownLegs: [] },
      expected: 'executing',
    },
    {
      name: 'restart-required',
      input: { deployedSha: 'abc1234567', servingStartedSinceCodeChange: false, verdictUnknownLegs: [] },
      expected: 'restart-required',
    },
    {
      name: 'process-unverified',
      input: { deployedSha: 'abc1234567', servingStartedSinceCodeChange: null, verdictUnknownLegs: [] },
      expected: 'process-unverified',
    },
    // WI-2141716. A null `servingStartedSinceCodeChange` is two conditions with OPPOSITE
    // levers; these four pin the split. The two retry-shaped codes must keep saying
    // "re-probe" (that action can still succeed), and the structural one must NOT
    // (re-probing it can never change the answer — the retry-forever loop this fixed).
    {
      name: 'probe RAN and failed → stays retry-shaped',
      input: {
        deployedSha: 'abc1234567',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: 'resolver-failed',
        verdictUnknownLegs: [],
      },
      expected: 'process-unverified',
    },
    {
      name: 'probe ran, one operand missing → stays retry-shaped',
      input: {
        deployedSha: 'abc1234567',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: 'insufficient-data',
        verdictUnknownLegs: [],
      },
      expected: 'process-unverified',
    },
    {
      name: 'no probe was attempted and none can be → serving-not-probeable',
      input: {
        deployedSha: 'abc1234567',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: 'not-applicable',
        verdictUnknownLegs: [],
      },
      expected: 'serving-not-probeable',
    },
    {
      name: 'unknown reason unavailable → keeps the weaker retry verdict, never the stronger claim',
      input: {
        deployedSha: 'abc1234567',
        servingStartedSinceCodeChange: null,
        servingUnknownCode: null,
        verdictUnknownLegs: [],
      },
      expected: 'process-unverified',
    },
    {
      name: 'missing deployed sha',
      input: { deployedSha: null, servingStartedSinceCodeChange: true, verdictUnknownLegs: [] },
      expected: null,
    },
    {
      name: 'failed deployed sha read',
      input: {
        deployedSha: 'abc1234567',
        servingStartedSinceCodeChange: true,
        verdictUnknownLegs: ['deployedSha'],
      },
      expected: null,
    },
  ];

  it.each(deployedCases)('deploy.3070.sha: $name → $expected', ({ input, expected }) => {
    expect(assessDeployedSha(input)).toBe(expected);
  });

  type MainBehindInput = Parameters<typeof assessMainBehindStaging>[0];
  type MainBehindExpected = ReturnType<typeof assessMainBehindStaging>;
  const mainBehindCases: Array<{
    name: string;
    input: MainBehindInput;
    expected: MainBehindExpected;
  }> = [
    {
      name: 'caught-up',
      input: { mainBehindStaging: false, fireStale: false, verdictUnknownLegs: [] },
      expected: 'caught-up',
    },
    {
      name: 'normal-buffer',
      input: { mainBehindStaging: true, fireStale: false, verdictUnknownLegs: [] },
      expected: 'normal-buffer',
    },
    {
      name: 'gate-stalled',
      input: { mainBehindStaging: true, fireStale: true, verdictUnknownLegs: [] },
      expected: 'gate-stalled',
    },
    {
      name: 'unresolved main/staging subject',
      input: { mainBehindStaging: null, fireStale: false, verdictUnknownLegs: [] },
      expected: null,
    },
    {
      name: 'failed main/staging read',
      input: {
        mainBehindStaging: false,
        fireStale: false,
        verdictUnknownLegs: ['verdictProvenance.mainFastForwarded'],
      },
      expected: null,
    },
    {
      name: 'caught-up cannot be concealed by a stale fire',
      input: { mainBehindStaging: false, fireStale: true, verdictUnknownLegs: [] },
      expected: 'caught-up',
    },
  ];

  it.each(mainBehindCases)('git.mainBehindStaging: $name → $expected', ({ input, expected }) => {
    expect(assessMainBehindStaging(input)).toBe(expected);
  });
});

/**
 * WI-36259 — THE GUARD THAT WAS MISSING, which is why this survived WI-7035.
 *
 * WI-7035 taught `checkpointRunInFlight.candidate` to prefer the run's own re-triage
 * marker over the probe. It never touched `changeInCandidate.judgingSha` — the headline of
 * the `gate.greenCheckpoint.candidate` cell and the value CLAUDE.md points triagers at — so
 * one resolver named two different shas for the same subject during a re-triage window, and
 * the cell served the ABANDONED one.
 *
 * Nothing caught it because every existing test injects `deps.resolveGateCandidates`
 * wholesale, which BYPASSES the reconciliation entirely: the fixture supplies the final
 * answer, so no test ever observed the probe and the marker disagreeing. These tests pin
 * the precedence at the pure seam instead, where a fixture cannot paper over it.
 */
/**
 * main-green-status-visible-2026-09-03 P-011 follow-up — grader card EI-22277841040474660.
 * The repair queue is authoritative while liveness is measured idle: the next run resumes
 * its current repairHead. It is not evidence of an active run's sha, because admission can
 * move repairHead mid-run while that run continues on its prior head. During an active
 * markerless run, retain the checkout probe as run-probe (non-authoritative); a run-published
 * marker remains authoritative. Unknown liveness never promotes the queue.
 */
describe('P-011 follow-up: a repair queue is authoritative only while the runner is measured idle', () => {
  const probeNull = { judgingSha: null, nextCandidateSha: 'tip00000' };
  const probeHead = { judgingSha: 'checkouthead', nextCandidateSha: 'tip00000' };
  const queue = { candidate: 'frozen0000', phase: 'awaiting-fixer' };

  it('LOAD-BEARING: between runs (probe null, no marker) the queue candidate is the judged sha', () => {
    // THE REGRESSION: before the fix this stayed { judgingSha: null } → 'no-active-run',
    // whose safe action named a re-cut at tip while a candidate was frozen.
    const out = reconcileGateCandidates(
      probeNull,
      { active: false, candidate: null, candidateSource: 'run-probe' },
      queue,
    );
    expect(out.judgingSha).toBe('frozen0000');
    expect(out.judgingShaSource).toBe('repair-queue');
    expect(out.nextCandidateSha).toBe('tip00000');
    expect(isAuthoritativeJudgingShaSource(out.judgingShaSource)).toBe(true);
  });

  it('does not let a repairHead admitted mid-run replace the active run probe', () => {
    const movedQueue = {
      ...queue,
      phase: 'ready-to-verify',
      frozenCandidate: 'run-started-head',
      repairHead: 'repair-head-after-admission',
    };
    expect(frozenQueueCandidate(movedQueue)).toBe('repair-head-after-admission');
    const out = reconcileGateCandidates(
      { judgingSha: 'run-started-head', nextCandidateSha: 'tip00000' },
      { active: true, candidate: 'run-started-head', candidateSource: 'run-probe' },
      movedQueue,
    );
    expect(out.judgingSha).toBe('run-started-head');
    expect(out.judgingShaSource).toBe('run-probe');
    expect(isAuthoritativeJudgingShaSource(out.judgingShaSource)).toBe(false);
  });

  it('does not promote the repair queue when run liveness is unknown', () => {
    const movedQueue = {
      ...queue,
      phase: 'ready-to-verify',
      frozenCandidate: 'frozen0000',
      repairHead: 'repair-head-after-admission',
    };
    const out = reconcileGateCandidates(probeHead, null, movedQueue);
    expect(out.judgingSha).toBe('checkouthead');
    expect(out.judgingShaSource).toBe('run-probe');
    expect(isAuthoritativeJudgingShaSource(out.judgingShaSource)).toBe(false);
  });

  it("never outranks the run's own published marker", () => {
    const out = reconcileGateCandidates(
      probeHead,
      { active: true, candidate: 'refiring9', candidateSource: 'retriage-marker' },
      queue,
    );
    expect(out.judgingSha).toBe('refiring9');
    expect(out.judgingShaSource).toBe('retriage-marker');
    const inFlight = reconcileGateCandidates(
      probeHead,
      { active: true, candidate: 'started11', candidateSource: 'in-flight-candidate' },
      queue,
    );
    expect(inFlight.judgingSha).toBe('started11');
    expect(inFlight.judgingShaSource).toBe('in-flight-candidate');
  });

  it('prefers the immutable frozenCandidate pin over the compatibility candidate field', () => {
    const out = reconcileGateCandidates(
      probeNull,
      { active: false, candidate: null, candidateSource: 'run-probe' },
      { ...queue, frozenCandidate: 'pinned0000' },
    );
    expect(out.judgingSha).toBe('pinned0000');
  });

  it('CONTROL: a blocked queue is not the next run\'s subject, so the pre-fix behaviour stands', () => {
    // attempts / wall-clock exhausted → the queue awaits retire or escape; asserting "the
    // next run resumes this" would be exactly the confident-wrong reading P-004 forbids.
    expect(frozenQueueCandidate({ ...queue, phase: 'blocked' })).toBeNull();
    const out = reconcileGateCandidates(
      probeHead,
      { active: true, candidate: 'checkouthead', candidateSource: 'run-probe' },
      {
        ...queue,
        phase: 'blocked',
      },
    );
    expect(out.judgingSha).toBe('checkouthead');
    expect(out.judgingShaSource).toBe('run-probe');
    expect(reconcileGateCandidates(probeNull, null, { ...queue, phase: 'blocked' }).judgingSha).toBeNull();
  });

  it('CONTROL: no queue (null / undefined / empty sha) leaves the WI-36259 behaviour untouched', () => {
    expect(reconcileGateCandidates(probeNull, null, null).judgingSha).toBeNull();
    expect(reconcileGateCandidates(probeNull, null, undefined).judgingShaSource).toBeUndefined();
    expect(reconcileGateCandidates(probeHead, null, { candidate: '', phase: 'awaiting-fixer' }).judgingShaSource).toBe(
      'run-probe',
    );
    expect(frozenQueueCandidate(null)).toBeNull();
    expect(frozenQueueCandidate({ candidate: null, frozenCandidate: null, phase: 'awaiting-fixer' })).toBeNull();
  });

  it('a repair-queue sha is NOT refused containment the way a run-probe sha is', () => {
    // The refusal exists because a checkout-head inference cannot support a verdict. The
    // frozen candidate is a persisted, published sha — the verdict-shaped boolean must arrive.
    const reconciled = reconcileGateCandidates(
      probeNull,
      { active: false, candidate: null, candidateSource: 'run-probe' },
      queue,
    );
    const cic = evaluateChangeInCandidate({
      relPath: 'libs/papercusp/libs/db/sql/999-x.sql',
      candidates: reconciled,
      judging: { inCandidate: false, reason: 'newer-commit' } as never,
      next: { inCandidate: true, reason: null } as never,
      submodule: { path: 'libs/papercusp', relPath: 'libs/db/sql/999-x.sql', judgingPin: 'pinA', nextPin: 'pinB' },
    });
    expect(cic.judgingSha).toBe('frozen0000');
    expect(cic.judgingShaSource).toBe('repair-queue');
    expect(cic.judgingContainsPath).toBe(false);
    expect(cic.submodule?.judgingPin).toBe('pinA');
    expect(cic.detail === null || !/run-probe/.test(cic.detail)).toBe(true);
    // CONTROL: the same shape from a run-probe source still withholds the boolean.
    const probed = evaluateChangeInCandidate({
      relPath: 'libs/papercusp/libs/db/sql/999-x.sql',
      candidates: reconcileGateCandidates(
        probeHead,
        { active: true, candidate: 'checkouthead', candidateSource: 'run-probe' },
        null,
      ),
      judging: { inCandidate: false, reason: 'newer-commit' } as never,
      next: null,
    });
    expect(probed.judgingShaSource).toBe('run-probe');
    expect('judgingContainsPath' in probed).toBe(false);
  });

  it('the authoritative list is ONE list: the registration cannot drift from the resolver', () => {
    expect([...AUTHORITATIVE_JUDGING_SHA_SOURCES]).toEqual(['retriage-marker', 'in-flight-candidate', 'repair-queue']);
    expect(isAuthoritativeJudgingShaSource('run-probe')).toBe(false);
    expect(isAuthoritativeJudgingShaSource(undefined)).toBe(false);
    expect(isAuthoritativeJudgingShaSource(null)).toBe(false);
  });
});

describe('WI-36259: judgingSha prefers the re-triage marker over the probe', () => {
  const probe = { judgingSha: 'abandoned0', nextCandidateSha: 'next111' };

  it('takes the marker sha and labels it authoritative when a refire is in flight', () => {
    const out = reconcileGateCandidates(probe, {
      candidate: 'refiring9',
      candidateSource: 'retriage-marker',
    });
    // THE REGRESSION: before the fix this was 'abandoned0' — the candidate the gate had
    // already stopped judging — while checkpointRunInFlight.candidate said 'refiring9'.
    expect(out.judgingSha).toBe('refiring9');
    expect(out.judgingShaSource).toBe('retriage-marker');
    // The other candidate answers a different question and must be left alone.
    expect(out.nextCandidateSha).toBe('next111');
  });

  it('keeps the probe sha, labelled run-probe, when no marker is in flight', () => {
    const out = reconcileGateCandidates(probe, { candidate: 'abandoned0', candidateSource: 'run-probe' });
    expect(out.judgingSha).toBe('abandoned0');
    expect(out.judgingShaSource).toBe('run-probe');
  });

  it('labels the probe run-probe even when the in-flight leg is absent entirely', () => {
    // The cache-only / unreadable-lock shape. Provenance must still be stated: silence here
    // would be indistinguishable from an authoritative reading to a caller that only checks
    // for the field's presence.
    expect(reconcileGateCandidates(probe, null).judgingShaSource).toBe('run-probe');
    expect(reconcileGateCandidates(probe, undefined).judgingShaSource).toBe('run-probe');
  });

  it('attributes NOTHING when there is no judged sha to attribute', () => {
    // A source label on a null headline would assert provenance for a value that does not
    // exist, and a consumer branching on "is this attributed" would read it as a real,
    // merely-untrusted candidate.
    const out = reconcileGateCandidates({ judgingSha: null, nextCandidateSha: 'next111' }, null);
    expect(out.judgingSha).toBeNull();
    expect(out.judgingShaSource).toBeUndefined();
  });

  it('does NOT promote a marker-shaped source whose candidate is null', () => {
    // Fails safe: an attributed-but-empty marker must not blank out a real probe answer.
    const out = reconcileGateCandidates(probe, { candidate: null, candidateSource: 'retriage-marker' });
    expect(out.judgingSha).toBe('abandoned0');
    expect(out.judgingShaSource).toBe('run-probe');
  });

  it('surfaces the marker sha through evaluateChangeInCandidate to the cell headline', () => {
    // The end-to-end shape the cell reads: reconcile -> evaluate -> changeInCandidate.
    const reconciled = reconcileGateCandidates(probe, {
      candidate: 'refiring9',
      candidateSource: 'retriage-marker',
    });
    const cic = evaluateChangeInCandidate({
      relPath: 'lib/x.ts',
      candidates: reconciled,
      judging: null,
      next: null,
    });
    expect(cic.judgingSha).toBe('refiring9');
    expect(cic.judgingShaSource).toBe('retriage-marker');
  });

  /**
   * THE WIRING GUARD — and for this bug it is the ONLY test that would have caught it.
   *
   * The pure units above can all pass while the resolver never CALLS them, which is
   * precisely the state the code was in: `mapCheckpointRunInFlight` correctly preferred the
   * marker and `evaluateChangeInCandidate` correctly copied `candidates.judgingSha`, both
   * fully tested, both green — and the seam between them handed the second one a
   * marker-blind probe. The defect lived entirely in the wiring, so it was invisible to
   * every unit test of the things being wired.
   *
   * Driven through `gitPipelinePosition` with a CRON-shaped run (active, a probe candidate
   * from the checkout HEAD, no log-derived provenance) plus a marker naming a different sha
   * — the exact live shape WI-7035 documented and this cell got wrong.
   */
  it('gitPipelinePosition itself hands the cell the MARKER sha, not the probe (the seam)', async () => {
    const MARKER = {
      fromCandidate: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      refiringCandidate: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      refireAttempt: 1,
      maxRefires: 2,
      // The STORED shape (`StoredInFlightRetriage`) is wider than the inline one
      // `mapCheckpointRunInFlight` accepts — `snap()` carries the persisted record, so the
      // freshness stamp and the rescued set are required here.
      observedAtMs: Date.now(),
      failingFiles: [],
    };
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/cell-registrations.ts' },
      {
        git: fakeGit({ contains: { HEAD: ['abc1234567'] } }),
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({ inFlightRetriage: MARKER }),
        readCheckpointRunSnapshot: async () => ({
          activeRun: {
            active: true,
            candidate: 'stale-worktree-head',
            startedAtMs: Date.now() - 30 * 60_000,
            elapsedSec: 1800,
          },
          computedAtMs: Date.now(),
        }),
        readCheckpointRunLock: async () => ({ held: true, elapsedSec: 1800 }),
        // The probe leg the OLD code trusted unconditionally. It deliberately disagrees with
        // the marker: before the fix this sha reached the cell verbatim.
        resolveGateCandidates: async () => ({ judgingSha: 'stale-worktree-head', nextCandidateSha: 'next999' }),
      },
    );

    expect(res.gate.checkpointRunInFlight?.candidate).toBe(MARKER.refiringCandidate);
    // THE REGRESSION: these two describe the SAME subject and used to disagree.
    expect(res.changeInCandidate.judgingSha).toBe(MARKER.refiringCandidate);
    expect(res.changeInCandidate.judgingShaSource).toBe('retriage-marker');
    expect(res.changeInCandidate.judgingSha).toBe(res.gate.checkpointRunInFlight?.candidate);
  });
});

/**
 * D-014 (plan `progress-certified-release-trace-2026-09-05`). P-004 sampled the live gate for
 * 83 minutes and the certifier's `stalled` branch NEVER EXECUTED: on every active sample the
 * cache did not describe the live run, so `progressAtMs` arrived null and the reading landed on
 * `progress-unmeasured`. Its `falseStalls=0` is therefore a statement about REACHABILITY, not
 * about correctness, and D-014 forbids reading it as a clean bill.
 *
 * Why the existing coverage did not already close this. `release-trace-progress.test.ts` tests
 * the verdict thoroughly — `stalled` included — but it constructs `ProgressCertificateInput` BY
 * HAND, which that module's own doc-comment names as the point of keeping the verdict pure. A
 * hand-built input proves the branch is CORRECT; it cannot prove the producer can ever emit one.
 * The gate that decides that lives here, in `mapCheckpointRunInFlight`, not in the certifier —
 * so no amount of testing on either side of the seam covers the seam itself.
 *
 * This is the experiment D-014 names as the only thing that would exercise the branch — "a
 * deliberate test that ages the cache against a synthetic live lock" — run deterministically
 * instead of waiting for a gate run that outlives the snapshot cache (papercusp runs currently
 * finish in ~17s, so the sampled route cannot get there; D-013 separately closed the backfill).
 */
describe('D-014: the producer reaches the certifier stall branch, and the identity gate suppresses it', () => {
  const NOW = 1_800_000_000_000;
  const STARTED = NOW - 90 * 60_000;

  /** A run-lock reading that positively answers "a run is live NOW", as the real probe does. */
  const heldLock = (startedAtMs: number, elapsedSec: number) => ({
    held: true,
    elapsedSec,
    source: 'run-lock' as const,
    startedAtMs,
  });

  it('REACHABILITY: a cache that describes the live run carries an ageable heartbeat through to `stalled`', () => {
    const reading = mapCheckpointRunInFlight(
      {
        activeRun: {
          active: true,
          candidate: 'abcdef1234567890',
          startedAtMs: STARTED,
          // 15 minutes since the last advancing heartbeat — past the 10-minute default.
          progressAtMs: NOW - 15 * 60_000,
          currentPhase: 'suite',
          elapsedSec: 5400,
        },
        computedAtMs: NOW - 4_000,
      },
      NOW,
      null,
      heldLock(STARTED, 5400),
    );

    // The producer-side preconditions, asserted explicitly: without BOTH of these the certifier
    // cannot reach the branch however the verdict itself is written. This is the half P-004
    // could not observe, and the half that makes the assertion below mean anything.
    expect(reading?.progressAtMs).toBe(NOW - 15 * 60_000);
    expect(reading?.activeSource).toBe('run-lock');
    expect(NOW - reading!.progressAtMs!).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_MS);

    const cert = certifyCheckpointProgress(reading, NOW);
    expect(cert.verdict).toBe('stalled');
    expect(cert.basis).toBe('heartbeat-stale');
    expect(cert.liveAuthority).toBe(true);
  });

  /**
   * The same aged heartbeat, withheld. This is the shape P-004 actually measured on all 164
   * samples, and it is the reason the branch was unreachable there — so it belongs beside the
   * reachability case rather than in a separate suite: together they show the identity gate is
   * load-bearing, not incidental. Raw, the cache here would produce a stall; joined, it cannot.
   */
  it('SUPPRESSION: an aged heartbeat belonging to a DIFFERENT run is withheld, never certified `stalled`', () => {
    const liveStarted = NOW - 17_000;
    const reading = mapCheckpointRunInFlight(
      {
        // The previous hour-long run, still in the snapshot, carrying a 30-minute-old heartbeat.
        activeRun: {
          active: true,
          candidate: 'stale00000000000',
          startedAtMs: NOW - 60 * 60_000,
          progressAtMs: NOW - 30 * 60_000,
          currentPhase: 'suite',
          elapsedSec: 3600,
        },
        computedAtMs: NOW - 4_000,
      },
      NOW,
      null,
      // ...while the lock says the live run started 17s ago. Unjoinable, so the detail is dropped.
      heldLock(liveStarted, 17),
    );

    expect(reading?.active).toBe(true);
    expect(reading?.progressAtMs).toBeUndefined();
    expect(reading?.currentPhase).toBeUndefined();
    expect(reading?.candidate ?? null).toBeNull();
    // Liveness and elapsed still come from the lock — exactly the P-004 sample shape.
    expect(reading?.elapsedSec).toBe(17);

    const cert = certifyCheckpointProgress(reading, NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('progress-unmeasured');
  });

  it('SUPPRESSION: a lock-only reading with no snapshot at all is unknown, however long the run has been up', () => {
    const reading = mapCheckpointRunInFlight(null, NOW, null, heldLock(STARTED, 5400));

    expect(reading?.active).toBe(true);
    expect(reading?.progressAtMs).toBeUndefined();

    const cert = certifyCheckpointProgress(reading, NOW);
    expect(cert.verdict).toBe('unknown');
    expect(cert.basis).toBe('progress-unmeasured');
  });
});
