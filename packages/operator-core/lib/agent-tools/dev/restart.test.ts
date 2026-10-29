/**
 * dev:restart — target dispatch (dev/staging) + the WI-4221 staging
 * debounce/coalescing logic. `guardResource` (the drain+restart primitive)
 * is mocked — it already has its own coverage via
 * locks/__tests__/resource-lock-guard.integration.test.ts; this file's job
 * is the NEW behavior layered on top: target→{unit,resource} dispatch, the
 * cooldown-marker and git-sync-barrier acquire-before-drain short-circuits,
 * and releasing those markers when a real restart attempt aborts after claiming
 * them.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/dev/restart.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BundleStaleness } from '../../bundle-staleness';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const foreignCoordinationDomain = join(tmpdir(), 'papercusp-release');

vi.mock('../locks/identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: 'dom' })),
}));
vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
vi.mock('../locks/in-workspace-txn', () => ({
  inWorkspaceTxn: vi.fn(async (_d: string, _o: string, fn: (tx: unknown) => unknown) => fn({})),
}));
vi.mock('../locks/su-lock-store', () => ({
  tryAcquireResource: vi.fn(),
  tryReleaseResource: vi.fn(async () => ({
    released: 1,
    releasedModes: ['exclusive'],
    exclusiveResources: [],
    waiters: {},
  })),
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource: vi.fn() }));
vi.mock('../../serving-host-identity', () => ({ hostIdentity: vi.fn(() => 'pid-test') }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  return {
    ...actual,
    spawn: vi.fn((...spawnArgs: unknown[]) => {
      const commandArgs = Array.isArray(spawnArgs[1]) ? spawnArgs[1].map(String) : [];
      const acquired = new PassThrough();
      const release = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        unref: vi.fn(),
        kill: vi.fn(),
        pid: undefined,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdio: [null, null, null, acquired, release],
      });
      queueMicrotask(() => {
        acquired.write('papercup-staging-sync-lock-acquired\n');
        if (commandArgs.join(' ').includes('papercusp-bg-host.service')) {
          child.exitCode = 0;
          child.emit('close', 0, null);
        }
      });
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});
// EI-11137: the systemd truth-check that decides genuine-vs-phantom coalesce.
vi.mock('./systemd-service-probe', () => ({
  probeServiceStart: vi.fn(),
  probeSystemdDaemonReloadNeed: vi.fn(),
}));
// EI-21651903020639415: gateway restarts must prove the new PID owns the
// listener before reporting restarted:true. Mock the shared HTTP probe so the
// regression suite stays hermetic and can assert the PID-before-health order.
vi.mock('../../escalating-http-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../escalating-http-probe')>();
  return { ...actual, probeHttpReachable: vi.fn() };
});
// EI-21651903020639415: gateway readiness must prove that the replacement
// MainPID owns the listener before probing /healthz. Keep the listener table
// hermetic here; its own parser/OS integration coverage lives in listening-sockets.
vi.mock('../../listening-sockets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../listening-sockets')>();
  return { ...actual, listListeningSockets: vi.fn() };
});
vi.mock('../../task-manager/cgroup-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../task-manager/cgroup-read')>();
  return { ...actual, readProcessCgroupPath: vi.fn(() => null) };
});
// EI-18661647550414959: the pre-kill "can this tree actually boot?" check. Mocked so
// the suite never shells out to systemctl; its own logic is covered in
// restart-preflight.test.ts. The default (set in beforeEach) is a clean tree.
vi.mock('./restart-preflight', () => ({
  preflightRestartTarget: vi.fn(),
  prepareStagingSchemaForRestart: vi.fn(),
}));
vi.mock('../../harness/routines/restricted-tree-skip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/routines/restricted-tree-skip')>();
  return { ...actual, integrationTreeRoots: vi.fn() };
});
vi.mock('../testing/restricted-hold-fence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../testing/restricted-hold-fence')>();
  return { ...actual, restrictedTreeHoldRefusal: vi.fn() };
});
vi.mock('./desktop-dev-restart', () => ({
  DESKTOP_DEV_RESOURCE: 'desktop-dev-server',
  resolveDesktopDevListener: vi.fn(),
  restartDesktopDev: vi.fn(),
}));
vi.mock('../../release/gate-collision-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../release/gate-collision-guard')>();
  return {
    ...actual,
    checkGateCollision: vi.fn(),
    checkGitSyncCollision: vi.fn(),
    checkStagingSyncCollision: vi.fn(),
    acquireGitSyncRestartBarrier: vi.fn(),
    waitForInFlightLocalSync: vi.fn(),
  };
});
// WI-2140796: the bg-host quiesce preflight. isQuiesceSensitiveTarget stays real
// (spread importOriginal) so the dev/staging/etc. "never even probed" assertions
// below are meaningful; only the probing/judging call is mocked.
vi.mock('./bg-host-quiesce-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bg-host-quiesce-guard')>();
  return { ...actual, checkBgHostQuiesce: vi.fn() };
});
// EI-18198340374286980: the audit_log writer — asserted directly in the new
// authorize-arg tests below, and must never make a real restart fail if it
// throws (fire-and-forget), so every OTHER test gets a working no-op stub.
// Partial mock (importOriginal): @papercusp/agent-mcp's own bootstrap imports
// OTHER exports (e.g. `generated`) from this same package — a full replacement
// breaks that unrelated import chain.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: vi.fn() };
});

import { tryAcquireResource, tryReleaseResource } from '../locks/su-lock-store';
import { inWorkspaceTxn } from '../locks/in-workspace-txn';
import { guardResource, type FenceToken, type GuardOutcome, type GuardSpec } from '../locks/resource-lock-guard';
import { hostIdentity } from '../../serving-host-identity';
import { spawn } from 'node:child_process';
import { probeServiceStart, probeSystemdDaemonReloadNeed } from './systemd-service-probe';
import { probeHttpReachable } from '../../escalating-http-probe';
import { listListeningSockets } from '../../listening-sockets';
import { integrationTreeRoots } from '../../harness/routines/restricted-tree-skip';
import { restrictedTreeHoldRefusal } from '../testing/restricted-hold-fence';
import { readProcessCgroupPath } from '../../task-manager/cgroup-read';
import {
  preflightRestartTarget,
  prepareStagingSchemaForRestart,
  type StagingSchemaPreparationResult,
} from './restart-preflight';
import { resolveDesktopDevListener, restartDesktopDev } from './desktop-dev-restart';
import { getOrgPg } from '@papercusp/db-org';
import { BUDGET, HARD_CAP, promptWeight } from '../tool-guidance-budget';
import {
  acquireGitSyncRestartBarrier,
  waitForInFlightLocalSync,
  checkGateCollision,
  checkGitSyncCollision,
  checkStagingSyncCollision,
} from '../../release/gate-collision-guard';
import { checkBgHostQuiesce } from './bg-host-quiesce-guard';
import { mockImplementationTyped, mockResolvedOnceTyped, mockResolvedTyped } from '../../testing/typed-mock';
import type { BgHostRestartReadiness, StagingRestartReadiness } from './restart';

const acquireM = vi.mocked(tryAcquireResource);
const releaseM = vi.mocked(tryReleaseResource);
const workspaceTxnM = vi.mocked(inWorkspaceTxn);
const guardM = vi.mocked(guardResource);
const spawnM = vi.mocked(spawn);
const probeM = vi.mocked(probeServiceStart);
const daemonReloadNeedM = vi.mocked(probeSystemdDaemonReloadNeed);
const gatewayHealthM = vi.mocked(probeHttpReachable);
const listeningSocketsM = vi.mocked(listListeningSockets);
const integrationTreeRootsM = vi.mocked(integrationTreeRoots);
const restrictedTreeHoldRefusalM = vi.mocked(restrictedTreeHoldRefusal);
const preflightM = vi.mocked(preflightRestartTarget);
const stagingSchemaPreparationM = vi.mocked(prepareStagingSchemaForRestart);
const desktopResolveM = vi.mocked(resolveDesktopDevListener);
const desktopRestartM = vi.mocked(restartDesktopDev);
/** A boot-integrity verdict. Defaults to an inspected, clean tree. */
const bootVerdict = (over: Record<string, unknown> = {}) =>
  ({
    target: 'dev',
    unit: 'papercusp-dev-api.service',
    checked: true,
    ok: true,
    requestedRoot: '/tree/apps/operator',
    lockRoot: '/tree',
    missing: [],
    extraneous: [],
    note: 'clean',
    ...over,
  }) as never;
const preparedStagingSchema = (
  over: Partial<StagingSchemaPreparationResult> = {},
): StagingSchemaPreparationResult => ({
  ok: true,
  integrationRoot: '/staging-tree',
  sqlDir: '/staging-tree/libs/papercusp/libs/db/sql',
  applied: 0,
  failed: [],
  note: 'The staging target schema is prepared while the current API remains serving.',
  ...over,
});
const orgPgM = vi.mocked(getOrgPg);
const auditUnsafeM = vi.fn(async (_query: string, _params: unknown[]) => undefined);
const gateCollisionM = vi.mocked(checkGateCollision);
const gitSyncCollisionM = vi.mocked(checkGitSyncCollision);
const stagingSyncCollisionM = vi.mocked(checkStagingSyncCollision);
const gitSyncBarrierM = vi.mocked(acquireGitSyncRestartBarrier);
const gitSyncBarrierReleaseM = vi.fn(async () => undefined);
const localSyncWaitM = vi.mocked(waitForInFlightLocalSync);
const quiesceM = vi.mocked(checkBgHostQuiesce);
/** A quiesce verdict. Defaults to "not quiesced" (see beforeEach). */
const quiesceVerdict = (over: Record<string, unknown> = {}) =>
  ({
    target: 'bg-host',
    quiesced: false,
    blocked: false,
    overridden: false,
    marker: null,
    probeFailed: false,
    note: 'bg-host is not quiesced.',
    ...over,
  }) as never;

const gatewayListenerResult = (pid: number) =>
  ({
    sockets: [
      {
        port: 8788,
        address: '127.0.0.1',
        family: 'ipv4',
        pid,
        pids: [pid],
        listeners: 1,
        command: 'gateway',
        ownerVisible: true,
        reserved: false,
        acceptQueue: { pending: 0, backlog: 511 },
        app: null,
        appUnknownReason: 'not-attempted',
        localUrl: `http://127.0.0.1:8788`,
      },
    ],
    matched: 1,
    totalListening: 1,
    truncated: false,
    ownerHidden: 0,
  }) satisfies Awaited<ReturnType<typeof listListeningSockets>>;

const clearGateCollision = () => ({
  blocked: false,
  kind: 'clear' as const,
  overridden: false,
  note: 'clear',
  detail: {
    runElapsedSec: null,
    nextFireInSec: null,
    refiringCandidate: null,
    refireAttempt: null,
    runLockPid: null,
    runLockCgroupPath: null,
    targetCgroupPath: null,
    cgroupRelation: 'unknown' as const,
  },
});

const clearGitSyncCollision = () => ({
  blocked: false,
  kind: 'clear' as const,
  overridden: false,
  note: 'clear',
  detail: {
    targetCgroupPath: null,
    collidingResources: [],
    collidingPids: [],
    isolatedResources: [],
    unknownResources: [],
    deadResources: [],
  },
});

const clearStagingSyncCollision = () => ({
  blocked: false,
  kind: 'clear' as const,
  note: 'staging-sync lock is clear',
  detail: { lockPath: '/tmp/papercup-staging-sync.lock', lockHeld: false },
});

const restartModule = await import('./restart');
const tool = restartModule.default;
const { RESTART_TARGETS } = restartModule;
const {
  bgHostIntegrationRootFromUnitProperties,
  configureBgHostEnvironmentDropInFreshnessReaderForTests,
  configureBgHostIntegrationRootResolverForTests,
  configureBgHostRestartReadinessReaderForTests,
  configureBgHostRestartFreshnessReaderForTests,
  configureBgHostBundleStaleReaderForTests,
  configurePeerInFlightEditsReaderForTests,
  configureStagingRestartReadinessReaderForTests,
  configureSystemdDaemonReloaderForTests,
  evaluateBgHostEnvironmentDropInFreshness,
  evaluateBgHostRestartFreshness,
  restartVerificationHint,
  SYSTEMD_DAEMON_RELOAD_TIMEOUT_MS,
  SYSTEMD_USER_DAEMON_RELOAD,
  waitForStagingRestartReadiness,
  gatewayListenerBelongsToService,
} = restartModule;

type Out = { content: { text: string }[]; isError?: boolean };
type Fence = Pick<FenceToken, 'assertCurrent' | 'seq'>;
type FreshnessSnapshot = {
  bundleMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
  newestSourcePath: string | null;
};
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;
const freshnessM = vi.fn(
  async (_integrationRoot: string): Promise<FreshnessSnapshot> => ({
    bundleMtimeMs: null,
    newestSourceMtimeMs: null,
    newestSourcePath: null,
  }),
);
type EnvironmentDropInFreshness = { checked: boolean; changedPaths: string[] };
const environmentDropInFreshnessM = vi.fn(
  async (_unit: string, _startedAtMs: number): Promise<EnvironmentDropInFreshness> => ({
    checked: true,
    changedPaths: [],
  }),
);
/** WI-10003606: the root bg-host's own unit names — deliberately NOT the serving operator's. */
const BG_HOST_UNIT_ROOT = '/fixture/canonical-tree';
const bgHostRootM = vi.fn(async (): Promise<string | null> => BG_HOST_UNIT_ROOT);
/** EI-25257294558913225: the unit tree's dist-host/.bundle-stale.json. Default absent (fresh build). */
const bgHostBundleStaleM = vi.fn((_root: string): BundleStaleness | null => null);
// EI-24790218658923698: the peer in-flight-edit advisory. Default: checked, nothing held.
const peerEditsM = vi.fn(async (_workingDirectory: string | null, _selfOwner: string | null) => ({
  checked: true,
  tree: BG_HOST_UNIT_ROOT as string | null,
  total: 0,
  files: [] as { path: string; owner: string; intent: string }[],
}));
const systemdDaemonReloadM = vi.fn(async (): Promise<void> => undefined);
const stagingReadinessM = vi.fn(
  async (before: { mainPid?: number }): Promise<StagingRestartReadiness> => ({
    ready: true,
    observed: true,
    outcome: 'ready' as const,
    pidChanged: true,
    observedPid: (before.mainPid ?? 0) + 1,
    activeState: 'active',
    result: 'success',
    listener: {
      port: 3170,
      checked: true,
      ownedByPid: true,
      ownerVisible: true,
      observedPids: [(before.mainPid ?? 0) + 1],
      detail: 'listener belongs to replacement',
    },
    waitedMs: 5,
  }),
);
const bgHostRestartReadinessM = vi.fn(
  async (before: { mainPid?: number }): Promise<BgHostRestartReadiness> => ({
    ready: true,
    observed: true,
    outcome: 'ready',
    pidChanged: true,
    observedPid: (before.mainPid ?? 0) + 1,
    activeState: 'active',
    result: 'success',
    waitedMs: 5,
  }),
);
/** Drive guardResource's mock as `(spec, run) => run(fence)` — a thin,
 *  explicitly-typed stand-in for the real drain+fence primitive (which has
 *  its own coverage elsewhere) so `run` never infers to `never` through the
 *  generic mock. */
const runGuard =
  (fence: Fence) =>
  async <T>(_spec: GuardSpec, run: (f: FenceToken) => Promise<T>): Promise<GuardOutcome<T>> => ({
    acquired: true,
    result: await run({
      resource: 'test-resource',
      coordinationDomain: 'test-domain',
      lockId: 'L-test',
      mode: 'exclusive',
      seq: fence.seq ?? 1,
      assertCurrent: fence.assertCurrent,
    }),
    lock_id: 'L-test',
  });
const fenceOk = (seq = 1): Fence => ({
  assertCurrent: async () => ({ current: true, live_fence_seq: seq }),
  seq,
});
const fenceStale = (seq = 1): Fence => ({
  assertCurrent: async () => ({ current: false, reason: 'superseded', live_fence_seq: 2 }),
  seq,
});

const ORIGINAL_ENV = process.env.PAPERCUSP_ALLOW_DEV_RESTART;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hostIdentity).mockReturnValue('pid-test');
  delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  freshnessM.mockResolvedValue({
    bundleMtimeMs: null,
    newestSourceMtimeMs: null,
    newestSourcePath: null,
  });
  configureBgHostRestartFreshnessReaderForTests(freshnessM);
  environmentDropInFreshnessM.mockResolvedValue({ checked: true, changedPaths: [] });
  configureBgHostEnvironmentDropInFreshnessReaderForTests(environmentDropInFreshnessM);
  bgHostRootM.mockResolvedValue(BG_HOST_UNIT_ROOT);
  configureBgHostIntegrationRootResolverForTests(bgHostRootM);
  peerEditsM.mockResolvedValue({ checked: true, tree: BG_HOST_UNIT_ROOT, total: 0, files: [] });
  configurePeerInFlightEditsReaderForTests(peerEditsM);
  configureStagingRestartReadinessReaderForTests(stagingReadinessM);
  configureBgHostRestartReadinessReaderForTests(bgHostRestartReadinessM);
  bgHostBundleStaleM.mockReturnValue(null);
  configureBgHostBundleStaleReaderForTests(bgHostBundleStaleM);
  configureSystemdDaemonReloaderForTests(systemdDaemonReloadM);
  releaseM.mockResolvedValue({
    released: 1,
    releasedModes: ['exclusive'],
    exclusiveResources: [],
    waiters: {},
  } as never);
  // Benign default: no live main process to report. Individual tests that care
  // about the coalesce-truth check or the restartedFromPid surfacing override it.
  mockResolvedTyped(probeM, { ok: true, mainPid: 0 });
  daemonReloadNeedM.mockResolvedValue('needed');
  daemonReloadNeedM.mockResolvedValue('needed');
  listeningSocketsM.mockResolvedValue({
    sockets: [],
    matched: 0,
    totalListening: 0,
    truncated: false,
    ownerHidden: 0,
  });
  gatewayHealthM.mockResolvedValue({ reachable: true, detail: 'HTTP 200' });
  integrationTreeRootsM.mockReturnValue(['/tree']);
  restrictedTreeHoldRefusalM.mockResolvedValue(null);
  preflightM.mockResolvedValue(bootVerdict());
  stagingSchemaPreparationM.mockResolvedValue(preparedStagingSchema());
  desktopResolveM.mockResolvedValue({ ok: true, pid: 327001, note: 'verified desktop-dev listener' });
  desktopRestartM.mockResolvedValue({ ok: true, pid: 327001, note: 'verified desktop-dev listener' });
  auditUnsafeM.mockClear();
  orgPgM.mockReturnValue({ sql: { unsafe: auditUnsafeM } } as never);
  gateCollisionM.mockResolvedValue(clearGateCollision());
  gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
  stagingSyncCollisionM.mockResolvedValue(clearStagingSyncCollision());
  quiesceM.mockResolvedValue(quiesceVerdict());
  gitSyncBarrierReleaseM.mockClear();
  gitSyncBarrierM.mockResolvedValue({
    acquired: true,
    resource: 'git-sync',
    lockId: 'barrier-1',
    owner: 'system:dev-restart:git-sync-barrier:42:uuid',
    coordinationDomain: 'workspace-domain',
    expiresAt: '2026-08-27T19:00:00.000Z',
    release: gitSyncBarrierReleaseM,
  });
  localSyncWaitM.mockReset();
  localSyncWaitM.mockResolvedValue({ probeFailed: false, targetCgroupPath: null, inFlight: [] });
});

afterAll(() => {
  configureBgHostRestartFreshnessReaderForTests();
  configureBgHostIntegrationRootResolverForTests();
  configurePeerInFlightEditsReaderForTests();
  configureStagingRestartReadinessReaderForTests();
  configureBgHostRestartReadinessReaderForTests();
  configureBgHostBundleStaleReaderForTests();
  configureSystemdDaemonReloaderForTests();
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_ALLOW_DEV_RESTART;
  else process.env.PAPERCUSP_ALLOW_DEV_RESTART = ORIGINAL_ENV;
});

describe('evaluateBgHostEnvironmentDropInFreshness (EI-24391112212280372)', () => {
  it('flags only active Environment= drop-ins newer than the exact MainPID start time', () => {
    expect(
      evaluateBgHostEnvironmentDropInFreshness(
        [
          {
            path: '/fixture/53-workspace-host-identity.conf',
            mtimeMs: 101,
            contents: '[Service]\nEnvironment=PAPERCUSP_WORKSPACE_HOST_RELEASE_MANIFEST=/new/manifest.json\n',
          },
          { path: '/fixture/50-memory.conf', mtimeMs: 102, contents: '[Service]\nMemoryMax=2G\n' },
          { path: '/fixture/40-old-env.conf', mtimeMs: 99, contents: '[Service]\nEnvironment=FOO=old\n' },
          { path: '/fixture/40-comment.conf', mtimeMs: 103, contents: '# Environment=IGNORED=1\n' },
        ],
        100,
      ),
    ).toEqual({ checked: true, changedPaths: ['/fixture/53-workspace-host-identity.conf'] });
  });

  it('reports unknown when the MainPID start time or a drop-in timestamp is not measurable', () => {
    const dropIns = [{ path: '/fixture/env.conf', mtimeMs: 101, contents: 'Environment=FOO=1\n' }];
    expect(evaluateBgHostEnvironmentDropInFreshness(dropIns, Number.NaN)).toEqual({
      checked: false,
      changedPaths: [],
    });
    expect(
      evaluateBgHostEnvironmentDropInFreshness([{ ...dropIns[0]!, mtimeMs: Number.NaN }], 100),
    ).toEqual({ checked: false, changedPaths: [] });
  });
});

describe('evaluateBgHostRestartFreshness (WI-207443)', () => {
  it('reports changed-tree freshness when a runtime source is newer than the produced bundle', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: 10_000,
        newestSourceMtimeMs: 10_001,
        newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      }),
    ).toEqual({
      bundleMtimeMs: 10_000,
      newestSourceMtimeMs: 10_001,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      treeChangedSinceRestart: true,
      checked: true,
    });
  });

  it('reports current-tree freshness when the produced bundle is at least as new as runtime sources', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: 10_001,
        newestSourceMtimeMs: 10_000,
        newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
      }),
    ).toMatchObject({ treeChangedSinceRestart: false, checked: true });
  });

  it('reports UNKNOWN freshness when either side cannot be read', () => {
    expect(
      evaluateBgHostRestartFreshness({
        bundleMtimeMs: null,
        newestSourceMtimeMs: 10_000,
        newestSourcePath: 'x.ts',
      }),
    ).toMatchObject({ treeChangedSinceRestart: null, checked: false });
  });
});

describe('bgHostIntegrationRootFromUnitProperties (WI-10003606)', () => {
  it("prefers the unit's own PAPERCUSP_INTEGRATION_ROOT among other environment entries", () => {
    expect(
      bgHostIntegrationRootFromUnitProperties(
        [
          'Environment=FOO=1 PAPERCUSP_INTEGRATION_ROOT=/home/u/papercusp MALLOC_ARENA_MAX=2',
          'WorkingDirectory=/elsewhere/apps/operator',
        ].join('\n'),
      ),
    ).toBe('/home/u/papercusp');
  });

  it('reads a quoted environment token', () => {
    expect(
      bgHostIntegrationRootFromUnitProperties('Environment="A=b c" "PAPERCUSP_INTEGRATION_ROOT=/srv/tree"\n'),
    ).toBe('/srv/tree');
  });

  it('falls back to the <root>/apps/operator working directory when the unit sets no root', () => {
    expect(
      bgHostIntegrationRootFromUnitProperties('Environment=FOO=1\nWorkingDirectory=/home/u/papercusp/apps/operator/\n'),
    ).toBe('/home/u/papercusp');
  });

  it('returns UNKNOWN for an unrecognised layout instead of guessing', () => {
    expect(bgHostIntegrationRootFromUnitProperties('Environment=\nWorkingDirectory=/opt/bg\n')).toBeNull();
    expect(bgHostIntegrationRootFromUnitProperties('Environment=PAPERCUSP_INTEGRATION_ROOT=relative/root\n')).toBeNull();
    expect(bgHostIntegrationRootFromUnitProperties('')).toBeNull();
  });
});

describe('dev:restart serving API lifetime (WI-6554700010023103)', () => {
  it.each([
    ['port-3170', 'staging-server'],
    ['port-3070', 'dev-server'],
  ])('keeps %s leased while the target barrier waits, then releases on refusal', async (host, resource) => {
    vi.mocked(hostIdentity).mockReturnValue(host);
    mockResolvedTyped(acquireM, {
      ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL-SERVING',
      expires_ts: new Date(), shared_holders: [], fence_seq: 1,
    });
    let held = false;
    let finishBarrier!: () => void;
    const barrierStarted = new Promise<void>((resolve) => {
      gitSyncBarrierM.mockImplementation(async () => {
        expect(held).toBe(true);
        resolve();
        await new Promise<void>((done) => { finishBarrier = done; });
        return { acquired: false, resource: 'git-sync', reason: 'drain_timeout', holders: [] };
      });
    });
    mockImplementationTyped(guardM, async (spec, run) => {
      expect(spec).toMatchObject({ resource, mode: 'shared' });
      held = true;
      try { return await runGuard(fenceOk())(spec, run); }
      finally { held = false; }
    });
    const pending = call({ target: 'bg-host', confirm: true, authorize: true });
    await barrierStarted;
    expect(held).toBe(true);
    expect(spawnM).not.toHaveBeenCalled();
    finishBarrier();
    expect(body(await pending)).toMatchObject({ reason: 'git_sync_barrier_drain_timeout', restarted: false });
    expect(held).toBe(false);
  });

  it('refuses a cross-target restart before preflight when its serving API is already draining', async () => {
    vi.mocked(hostIdentity).mockReturnValue('port-3170');
    mockResolvedTyped(guardM, { acquired: false, reason: 'exclusive_pending', holders: [] });
    expect(body(await call({ target: 'bg-host', confirm: true, authorize: true }))).toMatchObject({
      ok: false, reason: 'request_host_exclusive_pending', resource: 'staging-server', restarted: false,
    });
    expect(preflightM).not.toHaveBeenCalled();
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });

  it('releases its serving API lease when target preflight throws', async () => {
    vi.mocked(hostIdentity).mockReturnValue('port-3170');
    let held = false;
    mockImplementationTyped(guardM, async (spec, run) => {
      held = true;
      try { return await runGuard(fenceOk())(spec, run); }
      finally { held = false; }
    });
    preflightM.mockImplementation(async () => {
      expect(held).toBe(true);
      throw new Error('preflight unavailable');
    });
    await expect(call({ target: 'bg-host', confirm: true, authorize: true })).rejects.toThrow('preflight unavailable');
    expect(held).toBe(false);
  });

  it.each([['port-3170', 'staging'], ['port-3070', 'dev']])(
    'does not take a shared lease that would block its own %s restart', async (host, target) => {
      vi.mocked(hostIdentity).mockReturnValue(host);
      preflightM.mockResolvedValue(bootVerdict({ ok: false, missing: ['hono'] }));
      expect(body(await call({ target, confirm: true, authorize: true }))).toMatchObject({
        reason: 'boot_integrity_inconsistent',
      });
      expect(guardM).not.toHaveBeenCalled();
    },
  );

  it('keeps a cross-target dry run free of serving-host leases', async () => {
    vi.mocked(hostIdentity).mockReturnValue('port-3170');
    expect(body(await call({ target: 'bg-host' }))).toMatchObject({ dry_run: true });
    expect(guardM).not.toHaveBeenCalled();
  });
});

describe('dev:restart dry run', () => {
  it('registers every target resource and cooldown marker in the locks migration ledger', () => {
    const sqlDir = new URL('../../../../../libs/papercusp/packages/locks/src/sql/', import.meta.url).pathname;
    const migrations = readdirSync(sqlDir)
      .filter((name) => /^\d{3}-.*\.sql$/.test(name))
      .map((name) => readFileSync(join(sqlDir, name), 'utf8'))
      .join('\n');

    for (const { resource, cooldownResource } of Object.values(RESTART_TARGETS)) {
      expect(migrations, `missing agent_resource_registry seed for ${resource}`).toContain(`('${resource}',`);
      if (cooldownResource) {
        expect(migrations, `missing agent_resource_registry seed for ${cooldownResource}`).toContain(
          `('${cooldownResource}',`,
        );
      }
    }
  });

  it('defaults target to dev and reports the dev unit', async () => {
    const result = await call({});
    const b = body(result);
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'dev',
      would_run: 'systemctl --user daemon-reload && systemctl --user restart papercusp-dev-api.service',
    });
    expect(result.isError).toBeUndefined();
    expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('chaining guidance includes both gates for a real restart', () => {
    expect(tool.guidance?.chaining).toMatch(/confirm:true/);
    expect(tool.guidance?.chaining).toMatch(/authorize:true/);
    expect(tool.guidance?.chaining).toMatch(/reason:/);
  });

  it('keeps the registered prompt weight within the budget and hard cap', () => {
    const weight = promptWeight(tool as Parameters<typeof promptWeight>[0]);
    expect(weight).toBeLessThanOrEqual(BUDGET);
    expect(weight).toBeLessThanOrEqual(HARD_CAP);
  });

  it('generated tool catalog preserves the real-restart enablement gates', () => {
    const catalogPath = new URL('../../../../../.papercusp/tool-catalog.json', import.meta.url).pathname;
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
      tools: Array<{ name: string; description?: string; guidance?: { chaining?: string } }>;
    };
    const projected = catalog.tools.find((entry) => entry.name === 'dev:restart');

    expect(projected).toBeDefined();
    expect(projected?.description).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/confirm:true/);
    expect(projected?.guidance?.chaining).toMatch(/authorize:true/);
    expect(projected?.guidance?.chaining).toMatch(/reason:/);
  });

  it('target:staging reports the staging unit + mentions the coalescing window', async () => {
    const b = body(await call({ target: 'staging' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'staging',
      would_run: 'systemctl --user daemon-reload && systemctl --user restart papercusp-staging-api.service',
    });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~2min/);
    expect(stagingSchemaPreparationM).not.toHaveBeenCalled();
  });

  // EI-13307: bg-host's coalesce window is tuned to its REAL cost (the ~13min
  // cross-machine peer-log rejoin freeze, EI-13317) — NOT the generic ~2min
  // window shared by gateway/embed-sidecar. The dry-run note must say so.
  it('target:bg-host advertises its OWN wider ~13min coalescing window (EI-13307), not the generic ~2min one', async () => {
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'bg-host',
      would_run: 'systemctl --user daemon-reload && systemctl --user --no-block restart papercusp-bg-host.service',
    });
    expect(b.note).toMatch(/coalesced/);
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13307/);
    expect(b.note).toMatch(/EI-13317/);
    expect(b.note).not.toMatch(/~2min/);
  });

  it('target:gateway, target:embed-sidecar, and target:mcp-proxy keep the generic ~2min window (unaffected by the bg-host widening)', async () => {
    for (const target of ['gateway', 'embed-sidecar', 'mcp-proxy'] as const) {
      const b = body(await call({ target }));
      expect(b.note).toMatch(/~2min/);
      expect(b.note).not.toMatch(/~13min/);
    }
  });

  it('target:desktop-dev previews the wrapper-owned listener operation with the same identity check as confirmation', async () => {
    const b = body(await call({ target: 'desktop-dev' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'desktop-dev',
      would_run: 'SIGUSR2 recycle verified desktop-dev listener on :3270 (wait for verified wrapper respawn)',
      listener_identity: { checked: true, verified: true, would_block: false, pid: 327001 },
    });
    expect(b.note).toMatch(/exclusive\(desktop-dev-server\)/);
    expect(desktopResolveM).toHaveBeenCalledTimes(1);
    expect(preflightM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('target:desktop-dev dry run surfaces the same identity refusal that confirmation would return', async () => {
    desktopResolveM.mockResolvedValue({
      ok: false,
      pid: 622453,
      reason: 'desktop_dev_identity_mismatch',
      note: 'Listener pid 622453 is not the expected desktop-dev hono-host process; refusing to signal it.',
    });

    const b = body(await call({ target: 'desktop-dev' }));

    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target: 'desktop-dev',
      would_run: null,
      listener_identity: {
        checked: true,
        verified: false,
        would_block: true,
        pid: 622453,
        reason: 'desktop_dev_identity_mismatch',
      },
    });
    expect(b.note).toMatch(/would refuse before draining\/signaling/);
    expect(desktopResolveM).toHaveBeenCalledTimes(1);
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('takes no lock and drains nobody on a dry run', async () => {
    await call({ target: 'staging' });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
  });

  // EI-10896: the gateway/bg-host/embed-sidecar had NO sanctioned restart path —
  // the enum was ['dev','staging'] only, so a gateway fix could ONLY be landed by
  // the raw `systemctl` this tool's own guidance forbids. Guard that every shared
  // unit dispatches to its real systemd unit, and that each cooldown-bearing
  // (shared, coalescing) target advertises the debounce in its dry-run note. If a
  // target is dropped from the enum/TARGETS map, `cfg.unit` throws here.
  it.each([
    ['dev', 'papercusp-dev-api.service', false],
    ['staging', 'papercusp-staging-api.service', true],
    ['gateway', 'papercup-inference-gateway.service', true],
    ['bg-host', 'papercusp-bg-host.service', true],
    ['embed-sidecar', 'papercup-embed-sidecar.service', true],
    ['mcp-proxy', 'papercup-mcp-proxy.service', true],
    ['mcp-proxy-staging', 'papercup-mcp-proxy-staging.service', false],
    ['mcp-proxy-bg-host', 'papercup-mcp-proxy-bg-host.service', false],
    // WI-10001633: app sidecars run tsx from the tree with no restart-on-change —
    // without a sanctioned target the only way to load an edit was raw systemctl.
    ['email-sidecar', 'papercusp-email-sidecar.service', true],
    ['calendar-sidecar', 'papercusp-calendar-sidecar.service', true],
  ] as const)('target:%s dispatches to %s (coalescing note: %s)', async (target, unit, coalesces) => {
    const b = body(await call({ target }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      target,
      would_run:
        target === 'bg-host'
          ? `systemctl --user daemon-reload && systemctl --user --no-block restart ${unit}`
          : `systemctl --user daemon-reload && systemctl --user restart ${unit}`,
    });
    if (coalesces) expect(b.note).toMatch(/coalesced/);
    else expect(b.note).not.toMatch(/coalesced/);
    expect(acquireM).not.toHaveBeenCalled();
  });
});

// EI-18643120769203916: a withheld restart is a REFUSAL, not a partial success.
// The old code ran this check INSIDE guardResource, so an un-enabled call
// drained the target (leaving it quiesced on old code) and returned ok:true —
// which reads as "the restart happened" to any caller that checks `ok`.
describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('target:dev REFUSES with ok:false and does NOT drain — no guard, no lock, no audit — and the note points at authorize:true', async () => {
    guardM.mockImplementation(runGuard(fenceOk()));
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(b.note).toMatch(/authorize:\s*true/);
    // The whole point: the refusal happens BEFORE any side effect.
    expect(guardM).not.toHaveBeenCalled();
    // dev has no cooldownResource — the debounce path must never engage for it.
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('target:staging is refused the same way — no drain, and the cooldown marker is never claimed (nothing real happened to debounce)', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'staging' }));
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'restart_withheld',
      restarted: false,
      drained: false,
    });
    expect(guardM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('the refusal states plainly that nothing was done, so ok:false is not read as "drained but not restarted"', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'bg-host' }));
    expect(b).toMatchObject({ ok: false, drained: false, restarted: false });
    expect(b.note).toMatch(/NOTHING was done/i);
    expect(b.note).toMatch(/papercusp-bg-host\.service/);
  });
});

// EI-18198340374286980: an agent cannot set PAPERCUSP_ALLOW_DEV_RESTART on the
// already-running operator process — authorize:true is the in-band equivalent,
// still gated behind confirm:true (the deliberate-action + drain gate), and
// always audited (unlike the raw-systemctl bypass it exists to replace).
// EI-18661647550414959. Unit-testing the preflight proves nothing about whether
// dev:restart CALLS it — these are the call-site assertions. The failure being
// prevented: a restart that returns {ok:true, restarted:true} and then crash-loops
// the service on `[boot-integrity] FATAL` (exit 78), taking routines/git-sync down
// fleet-wide, which is exactly what happened on 2026-07-25.
describe('dev:restart boot-integrity preflight', () => {
  const inconsistent = bootVerdict({
    ok: false,
    missing: ['hono', 'postgres'],
    note: '[boot-integrity] /tree is INCONSISTENT',
  });

  it('REFUSES an inconsistent tree and does NOT drain, lock, restart or audit', async () => {
    // guardResource is deliberately left UNARMED: if the refusal ever regressed, the
    // handler would call it and fail loudly rather than quietly restarting.
    preflightM.mockResolvedValue(inconsistent);

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'boot_integrity_inconsistent',
      restarted: false,
      drained: false,
      boot_integrity: { checked: true, missing: ['hono', 'postgres'] },
    });
    // The whole point: the host is left UP on working code. Nothing was disturbed.
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('runs the preflight BEFORE the drain, against the requested target', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' });
    expect(preflightM).toHaveBeenCalledWith('bg-host');
  });

  // The mirror of the refusal test above: reaching guardResource IS the proof that the
  // preflight did not block. Asserted that way (rather than by driving a full restart)
  // so this needs no `as never` on the generic guard signature — the lint:mock-cast-escape
  // ratchet is shrink-only, and these tests do not need to climb it.
  it('override_boot_integrity:true proceeds — the restart may itself be the remedy', async () => {
    preflightM.mockResolvedValue(inconsistent);
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x', override_boot_integrity: true }).catch(
      () => undefined,
    );
    expect(guardM).toHaveBeenCalled();
  });

  // Fails OPEN: a guard that cannot run must never be the reason a wedged host stays
  // wedged. `checked:false` is NOT a clean bill, but it is also not a blocker.
  it('proceeds when the tree could not be inspected (checked:false, ok:true)', async () => {
    preflightM.mockResolvedValue(bootVerdict({ checked: false, lockRoot: null, reason: 'no package-lock.json' }));
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' }).catch(() => undefined);
    expect(guardM).toHaveBeenCalled();
  });

  it('previews the verdict in the DRY RUN, where the decision is actually made', async () => {
    preflightM.mockResolvedValue(inconsistent);
    const b = body(await call({ target: 'dev' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      boot_integrity: { checked: true, would_block: true, tree: '/tree', missing: ['hono', 'postgres'] },
    });
  });
});

describe('dev:restart D-012 restricted-hold preflight', () => {
  const held = {
    error: 'restricted_write_held',
    hint: '1 held restricted write in /tree (packages/operator-core/lib/agent-tools/dev/restart.ts).',
  } as const;

  it('refuses a held staging tree before schema preparation, lock, drain, audit, or restart', async () => {
    integrationTreeRootsM.mockReturnValue(['/tree']);
    restrictedTreeHoldRefusalM.mockResolvedValue(held);

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'staging',
        reason: 'x',
        // D-012 is unconditional; a boot-integrity override cannot bypass it.
        override_boot_integrity: true,
      }),
    );

    expect(integrationTreeRootsM).toHaveBeenCalledWith({}, '/tree/apps/operator');
    expect(restrictedTreeHoldRefusalM).toHaveBeenCalledWith(['/tree']);
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'restricted_write_held',
      restarted: false,
      drained: false,
      restricted_hold: { checked: true, roots: ['/tree'], ...held },
    });
    expect(stagingSchemaPreparationM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it.each(['staging', 'gateway', 'bg-host', 'embed-sidecar', 'mcp-proxy', 'mcp-proxy-staging'] as const)(
    'checks the WorkingDirectory-derived tree for %s',
    async (target) => {
      const workingDirectory = target === 'gateway' ? '/tree' : '/tree/apps/operator';
      preflightM.mockResolvedValue(bootVerdict({ target, requestedRoot: workingDirectory, lockRoot: '/tree' }));
      integrationTreeRootsM.mockReturnValue(['/tree']);
      restrictedTreeHoldRefusalM.mockResolvedValue(held);

      const b = body(await call({ confirm: true, authorize: true, target, reason: 'x' }));

      expect(b.reason).toBe('restricted_write_held');
      expect(integrationTreeRootsM).toHaveBeenCalledWith({}, '/tree/apps/operator');
      expect(restrictedTreeHoldRefusalM).toHaveBeenCalledWith(['/tree']);
      expect(guardM).not.toHaveBeenCalled();
      expect(spawnM).not.toHaveBeenCalled();
    },
  );

  it('fails closed when a networked target has no measurable WorkingDirectory', async () => {
    preflightM.mockResolvedValue(
      bootVerdict({ checked: false, requestedRoot: '', lockRoot: null, reason: 'WorkingDirectory unavailable' }),
    );

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'gateway',
        reason: 'x',
        override_boot_integrity: true,
      }),
    );

    expect(b).toMatchObject({
      ok: false,
      reason: 'restricted_hold_state_unknown',
      restarted: false,
      drained: false,
      restricted_hold: { checked: false, roots: [] },
    });
    expect(integrationTreeRootsM).not.toHaveBeenCalled();
    expect(restrictedTreeHoldRefusalM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
  });

  it('shows a held integration tree in the dry-run preview', async () => {
    integrationTreeRootsM.mockReturnValue(['/tree']);
    restrictedTreeHoldRefusalM.mockResolvedValue(held);

    const b = body(await call({ target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      restricted_hold: { checked: true, roots: ['/tree'], would_block: true, ...held },
    });
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it.each(['dev', 'email-sidecar', 'calendar-sidecar'] as const)(
    'does not apply the Papercusp integration-tree fence to %s',
    async (target) => {
      await call({ confirm: true, authorize: true, target, reason: 'x' }).catch(() => undefined);
      expect(integrationTreeRootsM).not.toHaveBeenCalled();
      expect(restrictedTreeHoldRefusalM).not.toHaveBeenCalled();
    },
  );

  it('keeps the wrapper-owned desktop development runtime outside the tree fence', async () => {
    await call({ target: 'desktop-dev' });
    expect(integrationTreeRootsM).not.toHaveBeenCalled();
    expect(restrictedTreeHoldRefusalM).not.toHaveBeenCalled();
  });
});

// WI-2140796: a P-101 seed cut (cut-seed-quiesced.sh) `systemctl --user mask
// --runtime`s bg-host and publishes a marker for its duration. dev:restart's own
// restart command runs detached with stdio ignored (see the `spawn` call below in
// this file), so — before this guard — a masked-unit failure was invisible: the
// tool still reported `ok:true, restarted:true` a moment before systemd silently
// no-op'd against the mask. These assert the refusal fires BEFORE any lock/drain.
describe('dev:restart bg-host quiesce preflight (WI-2140796)', () => {
  const quiesced = (over: Record<string, unknown> = {}) =>
    quiesceVerdict({
      quiesced: true,
      blocked: true,
      marker: {
        pid: 4242,
        unit: 'papercusp-bg-host.service',
        reason: 'release seed cut',
        since: '2026-09-01T20:00:00Z',
        log: '/tmp/p101-seed-cut.log',
      },
      note: "bg-host's unit is masked (pid 4242, since 2026-09-01T20:00:00Z: release seed cut) — a P-101 seed cut (or similar) has it deliberately quiesced.",
      ...over,
    });

  it('REFUSES a quiesced bg-host and does NOT drain, lock, restart or audit', async () => {
    quiesceM.mockResolvedValue(quiesced());
    // guardResource is deliberately left UNARMED, same idiom as the boot-integrity
    // refusal test above: a regression here would call it and fail loudly.
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'bg-host',
      reason: 'bg_host_quiesced',
      restarted: false,
      drained: false,
      quiesce: { quiesced: true, marker: { pid: 4242 } },
    });
    expect(b.note).toMatch(/NOTHING was done/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('checks the target actually requested, after the enablement gate but before the drain', async () => {
    quiesceM.mockResolvedValue(quiesced());
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' });
    expect(quiesceM).toHaveBeenCalledWith('bg-host', false);
  });

  it('never probes quiesce state for a target the guard does not cover (dev)', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk() as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await call({ confirm: true, authorize: true, target: 'dev', reason: 'x' });
    expect(quiesceM).not.toHaveBeenCalled();
  });

  it('override_quiesce:true proceeds — reaching guardResource is the proof the refusal did not fire', async () => {
    quiesceM.mockResolvedValue(quiesced({ blocked: false, overridden: true }));
    // WI-2140796: bg-host carries a cooldownResource, so a call this far down the
    // pipeline reaches the WI-4221 cooldown claim before guardResource — give it a
    // successful claim, same shape as the other bg-host restart tests below.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-OVERRIDE',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    await call({
      confirm: true,
      authorize: true,
      target: 'bg-host',
      reason: 'confirmed safe with the cut holder',
      override_quiesce: true,
    }).catch(() => undefined);
    expect(quiesceM).toHaveBeenCalledWith('bg-host', true);
    expect(guardM).toHaveBeenCalled();
  });

  it('a genuine override is recorded on the result AND the durable audit row', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(7) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    quiesceM.mockResolvedValue(
      quiesced({
        blocked: false,
        overridden: true,
        marker: {
          pid: 4242,
          unit: 'papercusp-bg-host.service',
          reason: 'release seed cut',
          since: '2026-09-01T20:00:00Z',
          log: '/tmp/p101-seed-cut.log',
        },
      }),
    );
    // WI-2140796: same cooldown-claim reasoning as the test above.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-AUDIT',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'bg-host',
        reason: 'confirmed safe with the cut holder',
        override_quiesce: true,
      }),
    );
    expect(b).toMatchObject({ ok: true, restarted: true, quiesceOverridden: { marker: { pid: 4242 } } });
    expect(auditUnsafeM).toHaveBeenCalledTimes(2);
    const request = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    const outcome = JSON.parse(auditUnsafeM.mock.calls[1]![1][5] as string);
    expect(request.quiesceOverridden).toMatchObject({ marker: { pid: 4242 } });
    expect(outcome).toMatchObject({
      requestId: request.requestId,
      phase: 'outcome',
      restarted: true,
      quiesceOverridden: { marker: { pid: 4242 } },
    });
  });

  it('previews the quiesce block in the DRY RUN, where the decision is actually made', async () => {
    quiesceM.mockResolvedValue(quiesced());
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      quiesce: { checked: true, would_block: true, quiesced: true, marker: { pid: 4242 } },
    });
    expect(b.note).toMatch(/quiesced/i);
  });

  it('fails OPEN when the probe itself could not verify state (checked:false, not blocked)', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk() as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    quiesceM.mockResolvedValue(quiesceVerdict({ probeFailed: true }));
    // WI-2140796: same cooldown-claim reasoning as the two tests above — probeFailed
    // fails OPEN (blocked:false), so this call also reaches the bg-host cooldown claim.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-QUIESCE-PROBE-FAILED',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'x' }).catch(() => undefined);
    expect(guardM).toHaveBeenCalled();
  });
});

describe('dev:restart confirm:true + authorize:true, PAPERCUSP_ALLOW_DEV_RESTART unset', () => {
  it('reloads changed user-unit bytes before draining callers or scheduling a restart', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    systemdDaemonReloadM.mockImplementationOnce(async () => {
      expect(guardM).not.toHaveBeenCalled();
      expect(spawnM).not.toHaveBeenCalled();
    });

    const b = body(await call({ confirm: true, authorize: true, reason: 'load changed drop-in', target: 'dev' }));

    expect(SYSTEMD_USER_DAEMON_RELOAD).toEqual({ command: 'systemctl', args: ['--user', 'daemon-reload'] });
    expect(SYSTEMD_DAEMON_RELOAD_TIMEOUT_MS).toBe(20_000);
    expect(daemonReloadNeedM).toHaveBeenCalledWith('papercusp-dev-api.service');
    expect(systemdDaemonReloadM).toHaveBeenCalledTimes(1);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(systemdDaemonReloadM.mock.invocationCallOrder[0]).toBeLessThan(guardM.mock.invocationCallOrder[0]!);
    expect(spawnM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, restarted: true, systemdDaemonReloaded: true });
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.systemdDaemonReloaded).toBe(true);
  });

  it('does not run a global manager reload when this unit has no pending definition change', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    daemonReloadNeedM.mockResolvedValueOnce('not-needed');

    const b = body(await call({ confirm: true, authorize: true, reason: 'load code change', target: 'dev' }));

    expect(systemdDaemonReloadM).not.toHaveBeenCalled();
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, restarted: true, systemdDaemonReloaded: false });
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.systemdDaemonReloaded).toBe(false);
  });

  it('reports a non-timeout reload failure before draining callers', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    daemonReloadNeedM.mockResolvedValueOnce('unknown');
    systemdDaemonReloadM.mockRejectedValueOnce(new Error('unit parse failed'));

    const b = body(await call({ confirm: true, authorize: true, reason: 'load changed drop-in', target: 'dev' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      drained: false,
      restarted: false,
      reason: 'systemd_daemon_reload_failed',
    });
    expect(b.note).toMatch(/unit parse failed/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
  });

  it('labels an exec timeout accurately and returns before draining callers', async () => {
    guardM.mockImplementation(runGuard(fenceOk(4)) as never);
    systemdDaemonReloadM.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: systemctl --user daemon-reload'), { code: 'ETIMEDOUT' }),
    );

    const b = body(await call({ confirm: true, authorize: true, reason: 'load changed drop-in', target: 'dev' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      drained: false,
      restarted: false,
      systemdDaemonReloaded: false,
      reason: 'systemd_daemon_reload_timed_out',
    });
    expect(b.note).toMatch(/exceeded the 20000ms timeout/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
  });

  it('fires a real restart on authorize:true alone (no env var needed) and writes an audit_log row tagged viaAuthorizeArg', async () => {
    guardM.mockImplementation(runGuard(fenceOk(5)) as never);

    const b = body(
      await call({ confirm: true, authorize: true, reason: 'landing WI-5471 fix on bg-host', target: 'dev' }),
    );

    expect(b).toMatchObject({
      ok: true,
      target: 'dev',
      restarted: true,
      drained: true,
      enabledVia: 'authorize_arg',
      audited: true,
    });
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-dev-api.service')],
      expect.anything(),
    );
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const [, params] = auditUnsafeM.mock.calls[0]!;
    expect(params[3]).toBe('dev:restart'); // action
    expect(params[4]).toBe('dev'); // subject = target
    const details = JSON.parse(params[5] as string);
    expect(details).toMatchObject({
      target: 'dev',
      viaEnv: false,
      viaAuthorizeArg: true,
      reason: 'landing WI-5471 fix on bg-host',
    });
  });

  it('confirm:true alone (authorize omitted, no env) still withholds — authorize does not implicitly follow from confirm', async () => {
    guardM.mockImplementation(runGuard(fenceOk()) as never);
    const b = body(await call({ confirm: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: false, target: 'dev', reason: 'restart_withheld', restarted: false });
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('authorize:true WITHOUT confirm:true stays a dry run — authorize never bypasses the drain gate', async () => {
    const b = body(await call({ authorize: true, target: 'dev' }));
    expect(b).toMatchObject({ ok: true, dry_run: true, target: 'dev' });
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });
});

describe('dev:restart git-sync operation collision guard (WI-222053)', () => {
  const blocked = () => ({
    ...clearGitSyncCollision(),
    blocked: true,
    kind: 'operation-in-flight' as const,
    note: 'Restart REFUSED — git-sync:papercusp is in flight; override_git_sync_collision:true only when wedged.',
    detail: {
      ...clearGitSyncCollision().detail,
      targetCgroupPath: '/user.slice/app.slice/papercusp-bg-host.service',
      collidingResources: ['git-sync:papercusp'],
      collidingPids: [4242],
    },
  });

  it('previews the collision before a caller chooses to confirm', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host' }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      git_sync_collision: {
        kind: 'operation-in-flight',
        would_block: true,
        collidingResources: ['git-sync:papercusp'],
        collidingPids: [4242],
      },
    });
    expect(b.note).toContain('git-sync:papercusp');
    expect(gitSyncCollisionM).toHaveBeenCalledWith('bg-host', false);
  });

  it('previews the DRAIN-BUDGETED call honestly — advisory, not would_block (EI-21930094737784126)', async () => {
    // The preview is where an agent decides whether to fire at all. Reporting
    // would_block:true for a call the confirmed path would NOT refuse deters the
    // correct action — the mirror of EI-21365722353248238, where the preview instead
    // promised a restart the confirmed call refused. Both are the same defect.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host', git_sync_drain_sec: 45 }));
    expect(b).toMatchObject({
      ok: true,
      dry_run: true,
      git_sync_collision: {
        kind: 'operation-in-flight',
        would_block: false,
        preflight_advisory: true,
        drain_sec: 45,
        collidingResources: ['git-sync:papercusp'],
      },
    });
    expect(b.note).toContain('git_sync_drain_sec:45');
    expect(b.note).toContain('ADVISORY');
  });

  it('the preview and the confirmed path never disagree about whether the preflight blocks', async () => {
    // The anti-drift guard for the shared predicate. Two hand-maintained copies of
    // `blocked && drain === 0` would diverge silently, and the preview diverging is
    // the expensive direction (an agent stands down on a lever that would have fired).
    for (const drain of [0, 45]) {
      gitSyncCollisionM.mockResolvedValue(blocked());
      const preview = body(await call({ target: 'bg-host', ...(drain ? { git_sync_drain_sec: drain } : {}) }));

      gitSyncCollisionM.mockResolvedValue(blocked());
      // Let the confirmed path reach its own preflight decision and stop just after
      // it: the cooldown claim succeeds, then the barrier refuses. Anything the call
      // does past the preflight is not what this test compares.
      mockResolvedTyped(acquireM, {
        ok: true,
        mode: 'exclusive',
        status: 'held',
        lock_id: 'COOL-PARITY',
        expires_ts: new Date(),
        shared_holders: [],
        fence_seq: 1,
      });
      gitSyncBarrierM.mockResolvedValue({
        acquired: false,
        resource: 'git-sync',
        reason: 'drain_timeout',
        holders: [],
      });
      const confirmed = body(
        await call({
          confirm: true,
          authorize: true,
          target: 'bg-host',
          reason: 'preflight parity probe',
          ...(drain ? { git_sync_drain_sec: drain } : {}),
        }),
      );
      const confirmedRefusedOnPreflight = confirmed.reason === 'git_sync_collision_operation_in_flight';
      expect(preview.git_sync_collision.would_block).toBe(confirmedRefusedOnPreflight);
    }
  });

  it('a preview WITHOUT a budget names git_sync_drain_sec as the way through, not the override', async () => {
    // #do-not-override-gitsync: the refusal used to point only at
    // override_git_sync_collision, which SIGKILLs a commit mid-flight. The lever a
    // refused caller reads about must be the safe one.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ target: 'bg-host' }));
    expect(b.git_sync_collision.would_block).toBe(true);
    expect(b.note).toContain('git_sync_drain_sec');
    expect(b.note).toContain('WEDGED');
  });

  it('refuses before cooldown, drain, signal, or audit when the target cgroup owns the live operation', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code' }));
    expect(b).toMatchObject({
      ok: false,
      reason: 'git_sync_collision_operation_in_flight',
      restarted: false,
      drained: false,
      git_sync_collision: { collidingPids: [4242] },
    });
    expect(gateCollisionM).not.toHaveBeenCalled();
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('with a drain budget, the cgroup preflight is ADVISORY and the barrier arbitrates instead', async () => {
    // EI-21930094737784126. The preflight asks "is a git-sync PROCESS inside this
    // cgroup?" — on bg-host the worker IS the host process, so it is ~always true and
    // hard-refused 20/20 real attempts, making the stale-executor page's own named
    // remediation unfireable. The authoritative signal is the barrier LOCK, measured
    // FREE in 20 of 40 sampled seconds. A caller willing to wait must reach it.
    gitSyncCollisionM.mockResolvedValue(blocked());
    // Let the cooldown claim succeed so the call actually reaches the barrier; the
    // barrier then refuses, which is what proves the preflight is no longer the gate.
    // mockResolvedTyped, not `as never`: the cast would defeat the one check vi.mocked
    // gives us, and lint:mock-cast-escape is shrink-only.
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-DRAIN',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    gitSyncBarrierM.mockResolvedValue({ acquired: false, resource: 'git-sync', reason: 'drain_timeout', holders: [] });

    const b = body(
      await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code', git_sync_drain_sec: 45 }),
    );

    // It got PAST the preflight — the refusal now comes from the barrier, not the proxy.
    expect(b.reason).not.toBe('git_sync_collision_operation_in_flight');
    expect(b).toMatchObject({ ok: false, restarted: false, drained: false });
    expect(b.note).toContain('git-sync barrier did not clear within the requested 45s wait');
    expect(b.note).not.toContain('saturated');
    expect(gitSyncBarrierM).toHaveBeenCalled();
    expect(gitSyncBarrierM).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ maxDrainSec: 45 }),
    );
    expect(workspaceTxnM).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.any(Function), {
      minLockTimeoutMs: 45_000,
      minStatementTimeoutMs: 45_000,
    });
  });

  it('with NO drain budget the preflight still hard-refuses — the default path is unchanged', async () => {
    // The other half of the guard above: demoting the preflight unconditionally would
    // remove a real protection for every caller who did not opt in.
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code' }));
    expect(b.reason).toBe('git_sync_collision_operation_in_flight');
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });

  it('covers the :3070 dev target, not only scheduled bg-host fires', async () => {
    gitSyncCollisionM.mockResolvedValue(blocked());
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));
    expect(b.reason).toBe('git_sync_collision_operation_in_flight');
    expect(gitSyncCollisionM).toHaveBeenCalledWith('dev', false);
  });

  it('passes a deliberate override, surfaces it, and records operation identity in the restart audit', async () => {
    gitSyncCollisionM.mockResolvedValue({ ...blocked(), blocked: false, overridden: true });
    guardM.mockImplementation(runGuard(fenceOk(17)) as never);

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'dev',
        reason: 'git-sync worker itself is wedged',
        override_git_sync_collision: true,
      }),
    );

    expect(b).toMatchObject({
      ok: true,
      restarted: true,
      gitSyncCollisionOverridden: {
        kind: 'operation-in-flight',
        collidingResources: ['git-sync:papercusp'],
        collidingPids: [4242],
      },
    });
    expect(gitSyncCollisionM).toHaveBeenCalledWith('dev', true);
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.gitSyncCollision).toEqual({
      kind: 'operation-in-flight',
      overridden: true,
      resources: ['git-sync:papercusp'],
      pids: [4242],
    });
  });

  it('closes the post-check race: a held barrier refuses before the target drains', async () => {
    gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
    gitSyncBarrierM.mockResolvedValue({
      acquired: false,
      resource: 'git-sync',
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'system:git-sync:99:late',
          owner_label: 'git-sync:papercusp',
          mode: 'exclusive',
          status: 'held',
        },
      ],
    });
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({
      ok: false,
      reason: 'git_sync_barrier_held_exclusive',
      restarted: false,
      drained: false,
      resource: 'git-sync',
      holders: [{ owner: 'system:git-sync:99:late' }],
    });
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
    expect(b.note).toMatch(/before draining/i);
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(localSyncWaitM).not.toHaveBeenCalled();
  });

  // WI-6554700010010484 (P-031): a local-sync pass whose leases lapsed reads clear to
  // the cgroup preflight AND lets the barrier acquire; only its activity marker shows it.
  it('refuses under a HELD barrier while a lapsed-lease local-sync pass is still committing', async () => {
    gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
    localSyncWaitM.mockResolvedValue({
      probeFailed: false,
      targetCgroupPath: '/user.slice/papercusp-dev-api.service',
      inFlight: [
        {
          installSlug: 'papercusp',
          owner: 'system:git-sync:4242:fire',
          ownerPid: 4242,
          startedAtMs: Date.parse('2026-10-14T08:00:00.000Z'),
          updatedAtMs: Date.parse('2026-10-14T08:01:00.000Z'),
          cgroupRelation: 'same',
        },
      ],
    });
    const b = body(
      await call({ confirm: true, authorize: true, target: 'bg-host', reason: 'reload code', git_sync_drain_sec: 120 }),
    );

    expect(b).toMatchObject({
      ok: false,
      reason: 'git_sync_local_sync_in_flight',
      restarted: false,
      drained: false,
      waited_sec: 30,
      in_flight: [{ install_slug: 'papercusp', owner_pid: 4242, updated_at: '2026-10-14T08:01:00.000Z' }],
    });
    expect(localSyncWaitM).toHaveBeenCalledWith('bg-host', { waitSec: 30 });
    expect(gitSyncBarrierM).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.objectContaining({ maxDrainSec: 120, holdExtraSec: 30 }),
    );
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('refuses fail-closed when the activity markers cannot be read', async () => {
    gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
    localSyncWaitM.mockResolvedValue({ probeFailed: true, targetCgroupPath: null, inFlight: [] });
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({ ok: false, reason: 'git_sync_local_sync_probe_failed', drained: false });
    expect(localSyncWaitM).toHaveBeenCalledWith('dev', { waitSec: 10 });
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
  });

  it('does not consult local-sync markers under the wedged-host override (no barrier is taken)', async () => {
    gitSyncCollisionM.mockResolvedValue(clearGitSyncCollision());
    await call({
      confirm: true,
      authorize: true,
      target: 'dev',
      reason: 'wedged host',
      override_git_sync_collision: true,
    });
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
    expect(localSyncWaitM).not.toHaveBeenCalled();
  });

  it('retries transient workspace contention while acquiring the barrier', async () => {
    guardM.mockImplementation(runGuard(fenceOk(18)) as never);
    const contention = Object.assign(new Error('workspace lock timed out'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    gitSyncBarrierM.mockRejectedValueOnce(contention).mockResolvedValueOnce({
      acquired: true,
      resource: 'git-sync',
      lockId: 'barrier-retry',
      owner: 'system:dev-restart:git-sync-barrier:42:retry',
      coordinationDomain: 'workspace-domain',
      expiresAt: '2026-08-27T19:00:00.000Z',
      release: gitSyncBarrierReleaseM,
    });

    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));

    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true, drained: true });
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(2);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalledTimes(1);
  });

  it('releases an acquired barrier when the target drain never grants', async () => {
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);
    const contention = Object.assign(new Error('workspace lock timed out'), {
      name: 'WorkspaceContendedError',
      pgCode: '57014',
    });
    gitSyncBarrierReleaseM.mockRejectedValueOnce(contention);

    const result = await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' });
    const b = body(result);

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'resource_drain_timeout',
    });
    expect(result.isError).toBe(true);
    expect(gitSyncBarrierM).toHaveBeenCalledTimes(1);
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(2);
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('keeps the successful barrier lease through the delayed systemctl handoff', async () => {
    guardM.mockImplementation(runGuard(fenceOk(19)) as never);
    const b = body(await call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' }));
    expect(b.gitSyncRestartBarrier).toEqual({
      resource: 'git-sync',
      expiresAt: '2026-08-27T19:00:00.000Z',
      release: 'lease-expiry-after-systemctl-handoff',
    });
    expect(spawnM).toHaveBeenCalledTimes(1);
    expect(gitSyncBarrierReleaseM).not.toHaveBeenCalled();
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details.gitSyncBarrier).toEqual({ resource: 'git-sync', expiresAt: '2026-08-27T19:00:00.000Z' });
  });

  it('releases the barrier immediately when scheduling the restart throws', async () => {
    guardM.mockImplementation(runGuard(fenceOk(20)) as never);
    spawnM.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(call({ confirm: true, authorize: true, target: 'dev', reason: 'reload operator' })).rejects.toThrow(
      'spawn failed',
    );
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
  });
});

describe('dev:restart staging-sync collision guard', () => {
  const blocked = () => ({
    ...clearStagingSyncCollision(),
    blocked: true,
    kind: 'staging-sync-in-flight' as const,
    note: 'Restart REFUSED — papercup-staging-sync holds its exclusive checkout lock.',
    detail: { lockPath: '/tmp/papercup-staging-sync.lock', lockHeld: true },
  });

  it('refuses an active sync before cooldown, drain, audit, or spawn', async () => {
    stagingSyncCollisionM.mockResolvedValue(blocked());
    const b = body(
      await call({ confirm: true, authorize: true, target: 'staging', reason: 'reload staging' }),
    );
    expect(b).toMatchObject({
      ok: false,
      reason: 'staging_sync_collision_staging_sync_in_flight',
      restarted: false,
      drained: false,
      staging_sync_collision: { lockHeld: true },
    });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('prepares the target schema before cooldown or drain and refuses a failed preparation', async () => {
    stagingSchemaPreparationM.mockResolvedValue(
      preparedStagingSchema({
        ok: false,
        reason: 'staging_migration_failed',
        applied: 1,
        failed: [{ file: '299-test.sql', error: 'constraint violation' }],
        note: 'The target schema has a failed migration; the service was left running.',
      }),
    );

    const b = body(await call({ confirm: true, authorize: true, target: 'staging', reason: 'reload staging' }));

    expect(stagingSchemaPreparationM).toHaveBeenCalledWith('/tmp/papercup-staging-sync.lock');
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'staging_migration_failed',
      restarted: false,
      drained: false,
      staging_schema_preparation: {
        ok: false,
        applied: 1,
        failed: [{ file: '299-test.sql', error: 'constraint violation' }],
      },
    });
    expect(acquireM).not.toHaveBeenCalled();
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
  });

  it('rechecks after the drain and refuses a late collision before audit or spawn', async () => {
    stagingSyncCollisionM.mockResolvedValueOnce(clearStagingSyncCollision()).mockResolvedValueOnce(blocked());
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-LATE-STAGING-SYNC',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 23,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(23)));

    const b = body(
      await call({ confirm: true, authorize: true, target: 'staging', reason: 'reload staging' }),
    );

    expect(stagingSyncCollisionM).toHaveBeenCalledTimes(2);
    expect(b).toMatchObject({
      ok: false,
      reason: 'staging_sync_collision_staging_sync_in_flight',
      restarted: false,
      drained: true,
      staging_sync_collision: { lockHeld: true },
    });
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(releaseM).toHaveBeenCalledTimes(1);
  });

  it('refuses when staging-sync takes exclusive after the final probe but before the flock handoff', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-HANDOFF-RACE',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 24,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(24)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });
    const lockBusyChild = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
      stdio: [null, null, null, new PassThrough(), new PassThrough()],
    });
    spawnM.mockImplementationOnce(() => {
      queueMicrotask(() => lockBusyChild.emit('close', 75, null));
      return lockBusyChild as never;
    });

    const b = body(await call({ confirm: true, authorize: true, target: 'staging', reason: 'reload staging' }));

    expect(stagingSyncCollisionM).toHaveBeenCalledTimes(2);
    expect(spawnM).toHaveBeenCalledWith(
      '/usr/bin/flock',
      [
        '--shared',
        '--nonblock',
        '--conflict-exit-code',
        '75',
        '/tmp/papercup-staging-sync.lock',
        'sh',
        '-c',
        expect.stringContaining('papercup-staging-sync-lock-acquired'),
      ],
      expect.objectContaining({ detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }),
    );
    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'staging_sync_collision_staging_sync_in_flight',
      restarted: false,
      drained: true,
      staging_sync_collision: {
        kind: 'staging-sync-in-flight',
        lockPath: '/tmp/papercup-staging-sync.lock',
        lockHeld: true,
        exitCode: 75,
      },
    });
    expect(releaseM).toHaveBeenCalledTimes(1);
    expect(auditUnsafeM).not.toHaveBeenCalled();
    expect(stagingReadinessM).not.toHaveBeenCalled();
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:staging', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('releases the exclusive lease before a self-restart can kill its handler', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-SELF-RESTART',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });
    let leaseHeld = false;
    mockImplementationTyped(guardM, async (_spec, run) => {
      leaseHeld = true;
      const result = await run(fenceOk() as FenceToken);
      leaseHeld = false; // guardResource's finally has released staging-server
      return { acquired: true, result, lock_id: 'L-self-restart' };
    });
    spawnM.mockImplementationOnce(() => {
      expect(leaseHeld).toBe(false);
      const acquired = new PassThrough();
      const release = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        unref: vi.fn(),
        kill: vi.fn(),
        pid: undefined,
        stdio: [null, null, null, acquired, release],
      });
      queueMicrotask(() => acquired.write('papercup-staging-sync-lock-acquired\n'));
      return child as never;
    });
    stagingReadinessM.mockImplementationOnce(async () => {
      expect(leaseHeld).toBe(false);
      throw new Error('transport closed when staging killed its own handler');
    });

    const b = body(await call({ confirm: true, target: 'staging' }));
    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      drained: true,
      restarted: false,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(leaseHeld).toBe(false);
    expect(spawnM).toHaveBeenCalledTimes(1);
    expect(stagingReadinessM).not.toHaveBeenCalled();
  });

  it('claims the cooldown marker, drains+restarts, and does NOT release the cooldown on success', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL1',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(9)) as never);
    // EI-11137: the pre-restart MainPID is captured so the caller can verify a real cycle.
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'staging-server-cooldown', mode: 'exclusive', ttlSec: 120 }),
    );
    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      drained: true,
      restartedFromPid: 4242,
      enabledVia: 'env',
      audited: true,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(b.verifyWith).toMatch(/dev:listening_ports \{ port: 3170 \}/);
    expect(b.verifyWith).toMatch(/ownerVisible:true/);
    expect(b.verifyWith).toMatch(/MainPID=0.*ActiveState=activating|ActiveState=activating.*MainPID=0/);
    expect(b).not.toHaveProperty('phantomCoalesceBroken');
    expect(spawnM).toHaveBeenCalledWith(
      '/usr/bin/flock',
      [
        '--shared',
        '--nonblock',
        '--conflict-exit-code',
        '75',
        '/tmp/papercup-staging-sync.lock',
        'sh',
        '-c',
        expect.stringContaining('systemctl --user restart papercusp-staging-api.service'),
      ],
      expect.objectContaining({ detached: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }),
    );
    expect(spawnM.mock.calls[0]?.[1]?.[7] as string).not.toContain('reset-failed');
    // Left to expire, not released — the debounce depends on this.
    expect(releaseM).not.toHaveBeenCalled();
    // EI-18198340374286980: a real restart is ALWAYS audited, even via the env route.
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details).toMatchObject({
      target: 'staging',
      requestId: b.restartRequestId,
      phase: 'request',
      beforeMainPid: 4242,
      restartCommand: 'systemctl --user restart papercusp-staging-api.service',
      viaEnv: true,
      viaAuthorizeArg: false,
      reason: null,
      stagingSyncHandoff: {
        lockPath: '/tmp/papercup-staging-sync.lock',
        mode: 'shared',
        heldThrough: 'systemctl-restart',
      },
    });
  });

  it('retries transient workspace contention while acquiring the staging cooldown marker', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-RETRY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 22,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(22)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });
    workspaceTxnM.mockRejectedValueOnce(
      Object.assign(new Error('workspace lock timed out'), {
        name: 'WorkspaceContendedError',
        pgCode: '57014',
      }),
    );

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      drained: true,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(workspaceTxnM).toHaveBeenCalledTimes(2);
    expect(acquireM).toHaveBeenCalledTimes(1);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalledTimes(1);
  });

  it('staging restart bypasses the git-sync probe and workspace barrier', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-STAGING-NO-GITSYNC',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 21,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(21)) as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      drained: true,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(gitSyncCollisionM).not.toHaveBeenCalled();
    expect(gitSyncBarrierM).not.toHaveBeenCalled();
  });

  it('clears a latched start-limit before scheduling the restart and reports the recovery', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-LATCH',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceOk(10)) as never);
    probeM.mockResolvedValue({ ok: true, mainPid: 0, result: 'start-limit-hit' } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
      resetFailedBeforeRestart: true,
    });
    const shell = spawnM.mock.calls[0]?.[1]?.[7] as string;
    const reset = `systemctl --user reset-failed papercusp-staging-api.service`;
    const restart = `systemctl --user restart papercusp-staging-api.service`;
    expect(shell).toContain(`${reset} && ${restart}`);
    expect(shell.indexOf(reset)).toBeLessThan(shell.indexOf(restart));
    expect(b.note).toMatch(/scheduled|reconcile/i);
  });

  it('also clears a failed MainPID=0 unit when systemd retains Result=exit-code', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-EXIT-CODE-LATCH',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(10)));
    mockResolvedTyped(probeM, {
      ok: true,
      mainPid: 0,
      activeState: 'failed',
      result: 'exit-code',
    });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
      resetFailedBeforeRestart: true,
    });
    expect(spawnM.mock.calls[0]?.[1]?.[7] as string).toContain(
      'systemctl --user reset-failed papercusp-staging-api.service && systemctl --user restart papercusp-staging-api.service',
    );
  });

  it('returns a pending receipt without claiming the detached staging outcome', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-NOT-OBSERVED',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(10)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 0, activeState: 'failed', result: 'exit-code' });
    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      restartScheduled: true,
      restartObserved: false,
      requestAuditPersisted: true,
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(b.note).toMatch(/reconcile the request|scheduled/i);
    expect(stagingReadinessM).not.toHaveBeenCalled();
  });

  it('observes the real staging transition through new-PID listener ownership', async () => {
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, activeState: 'active', result: 'success' });
    mockResolvedTyped(listeningSocketsM, {
      ...gatewayListenerResult(5252),
      sockets: gatewayListenerResult(5252).sockets.map((socket) => ({ ...socket, port: 3170 })),
    });

    const readiness = await waitForStagingRestartReadiness({
      ok: true,
      mainPid: 0,
      activeState: 'failed',
      result: 'exit-code',
    });

    expect(readiness).toMatchObject({
      ready: true,
      observed: true,
      outcome: 'ready',
      pidChanged: true,
      observedPid: 5252,
      listener: { port: 3170, ownedByPid: true },
    });
  });

  it('coalesces when the marker is held AND systemd confirms a genuine recent restart — no drain, no restart, no spawn', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-1',
          owner_label: 'peer-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    // EI-11137: the service really did restart 12s ago (< 120s window) — genuine coalesce.
    mockResolvedTyped(probeM, { ok: true, mainPid: 555, secondsSinceStart: 12 });

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'staging',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 12,
      mainPid: 555,
    });
    expect(b.note).toMatch(/peer-one/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('coalesces a recent bg-host restart without inferring requested-edit absence from an unrelated newer source', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'bg-host-cooldown',
          lock_id: 'lock-peer-bg-6060',
          owner: 'peer-bg',
          owner_label: 'peer-bg-host',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 1,
        },
      ],
    });
    probeM.mockResolvedValue({ ok: true, mainPid: 6060, secondsSinceStart: 600 });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_000,
      newestSourceMtimeMs: 10_001,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 600,
      mainPid: 6060,
      treeChangedSinceRestart: true,
      freshnessVerified: true,
      bundleMtime: new Date(10_000).toISOString(),
      newestSourceMtime: new Date(10_001).toISOString(),
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });
    expect(b.note).toMatch(/runtime tree is newer than the bundle/i);
    expect(b.note).toContain('packages/operator-core/lib/learning/model-policy.ts');
    expect(b.note).toMatch(/requested edit.*unverified/i);
    expect(b.note).not.toMatch(/requested edit is NOT loaded/i);
    expect(b.note).toMatch(/temporal throttle is preserved/i);
    expect(freshnessM).toHaveBeenCalledTimes(1);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('coalesces a recent bg-host restart and reports current tree/bundle freshness', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'bg-host-cooldown',
          lock_id: 'lock-peer-bg-6061',
          owner: 'peer-bg',
          owner_label: 'peer-bg-host',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 1,
        },
      ],
    });
    probeM.mockResolvedValue({ ok: true, mainPid: 6061, secondsSinceStart: 12 });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_001,
      newestSourceMtimeMs: 10_000,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      coalesced: true,
      treeChangedSinceRestart: false,
      freshnessVerified: true,
    });
    expect(b.note).toMatch(/freshness checked/i);
    expect(b.note).not.toMatch(/NOT loaded/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('restarts under the exclusive guard when an Environment= drop-in is newer than the MainPID', async () => {
    const changedDropIn = '/fixture/53-workspace-host-identity.conf';
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-bg', owner_label: 'peer-bg-host', mode: 'exclusive', status: 'held' }],
    } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 6064, secondsSinceStart: 12, startedAtMs: 10_000 });
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 6064, secondsSinceStart: 12, startedAtMs: 10_000 });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_001,
      newestSourceMtimeMs: 10_000,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });
    let underGuard = false;
    let environmentReads = 0;
    environmentDropInFreshnessM.mockImplementation(async (_unit, startedAtMs) => {
      environmentReads++;
      expect(startedAtMs).toBe(10_000);
      if (environmentReads === 2) expect(underGuard).toBe(true);
      return { checked: true, changedPaths: [changedDropIn] };
    });
    const guardBehavior = runGuard(fenceOk(14));
    guardM.mockImplementation((async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      underGuard = true;
      try {
        return await guardBehavior(spec, run);
      } finally {
        underGuard = false;
      }
    }) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: true,
      unitEnvFreshnessVerified: true,
      unitEnvChangedSinceRestart: true,
      unitEnvChangedDropIns: [changedDropIn],
    });
    expect(b.coalesced).toBeUndefined();
    expect(b.note).toMatch(/restarted to load the newer Environment= drop-in/i);
    expect(environmentReads).toBe(2);
    expect(guardM).toHaveBeenCalledTimes(1);
    expect(spawnM).toHaveBeenCalled();
  });

  it('skips the bypass restart when a peer loads the drop-in before the exclusive recheck', async () => {
    const changedDropIn = '/fixture/53-workspace-host-identity.conf';
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-bg', owner_label: 'peer-bg-host', mode: 'exclusive', status: 'held' }],
    } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 6065, secondsSinceStart: 12, startedAtMs: 10_000 });
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 6066, secondsSinceStart: 2, startedAtMs: 11_000 });
    environmentDropInFreshnessM.mockResolvedValueOnce({ checked: true, changedPaths: [changedDropIn] });
    environmentDropInFreshnessM.mockResolvedValueOnce({ checked: true, changedPaths: [] });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_001,
      newestSourceMtimeMs: 10_000,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });
    guardM.mockImplementation(runGuard(fenceOk(15)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: false,
      coalesced: true,
      unitEnvFreshnessVerified: true,
      unitEnvChangedSinceRestart: false,
      treeChangedSinceRestart: false,
    });
    expect(b.note).toMatch(/rechecked under the exclusive/i);
    expect(environmentDropInFreshnessM).toHaveBeenCalledTimes(2);
    expect(freshnessM).toHaveBeenCalledTimes(2);
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('keeps unit environment freshness explicitly unknown when the drop-in probe fails', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [{ owner: 'peer-bg', owner_label: 'peer-bg-host', mode: 'exclusive', status: 'held' }],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 6067, secondsSinceStart: 12, startedAtMs: 10_000 });
    environmentDropInFreshnessM.mockResolvedValue({ checked: false, changedPaths: [] });
    freshnessM.mockResolvedValue({
      bundleMtimeMs: 10_001,
      newestSourceMtimeMs: 10_000,
      newestSourcePath: 'packages/operator-core/lib/learning/model-policy.ts',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      coalesced: true,
      unitEnvFreshnessVerified: false,
      unitEnvChangedSinceRestart: null,
    });
    expect(b.note).toMatch(/Environment= drop-in freshness could NOT be verified/i);
    expect(b.note).not.toMatch(/no active Environment= drop-in is newer/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it("WI-10003606: scans bg-host's own tree, never the serving operator's PAPERCUSP_INTEGRATION_ROOT", async () => {
    const originalRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = '/fixture/serving-staging-checkout';
    try {
      acquireM.mockResolvedValue({
        ok: false,
        reason: 'held_exclusive',
        holders: [
          {
            resource: 'bg-host-cooldown',
            lock_id: 'lock-peer-bg-6062',
            owner: 'peer-bg',
            owner_label: 'peer-bg-host',
            mode: 'exclusive',
            status: 'held',
            reason: '',
            acquired_ts: new Date(),
            expires_ts: new Date(),
            fence_seq: 1,
          },
        ],
      });
      probeM.mockResolvedValue({ ok: true, mainPid: 6062, secondsSinceStart: 30 });
      freshnessM.mockImplementation(async (root: string) =>
        root === BG_HOST_UNIT_ROOT
          ? { bundleMtimeMs: 10_000, newestSourceMtimeMs: 10_001, newestSourcePath: 'packages/operator-core/lib/x.ts' }
          : { bundleMtimeMs: 10_001, newestSourceMtimeMs: 10_000, newestSourcePath: 'packages/operator-core/lib/x.ts' },
      );

      const b = body(await call({ confirm: true, target: 'bg-host' }));

      expect(freshnessM).toHaveBeenCalledTimes(1);
      expect(freshnessM).toHaveBeenCalledWith(BG_HOST_UNIT_ROOT);
      expect(b).toMatchObject({ coalesced: true, treeChangedSinceRestart: true, freshnessVerified: true });
      expect(b.note).toMatch(/requested edit.*unverified/i);
      expect(b.note).not.toMatch(/requested edit is NOT loaded/i);
    } finally {
      if (originalRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = originalRoot;
    }
  });

  it('WI-10003606: an unresolvable bg-host root reports UNKNOWN freshness instead of a clean verdict', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'bg-host-cooldown',
          lock_id: 'lock-peer-bg-6063',
          owner: 'peer-bg',
          owner_label: 'peer-bg-host',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 1,
        },
      ],
    });
    probeM.mockResolvedValue({ ok: true, mainPid: 6063, secondsSinceStart: 30 });
    bgHostRootM.mockResolvedValue(null);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(freshnessM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ coalesced: true, treeChangedSinceRestart: null, freshnessVerified: false });
    expect(b.note).toMatch(/could NOT be verified/i);
  });

  it('EI-11137: PHANTOM coalesce — marker held but systemd shows NO recent restart ⇒ refuses to coalesce and fires a real restart', async () => {
    // The reported wedge: a bg-host marker is held, but the service last started
    // long ago (older than the cooldown). Must NOT coalesce — must restart.
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'stale-peer',
          owner_label: 'stale-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 909, secondsSinceStart: 6 * 3600 }); // 6h ago
    guardM.mockImplementation(runGuard(fenceOk(7)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 909 });
    expect(b.coalesced).toBeUndefined();
    // EI-13307: bg-host's cooldown is now the widened ~13min (780s) window, not the generic 120s one.
    expect(b.phantomCoalesceBroken).toMatchObject({
      staleMarkerHolder: 'stale-one',
      serviceSecondsSinceStart: 6 * 3600,
      cooldownSec: 13 * 60,
    });
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-bg-host.service')],
      expect.anything(),
    );
  });

  it('EI-11137: down service (MainPID 0) is NOT a recent restart ⇒ marker treated as phantom, restart fires', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'stale-peer',
          owner_label: 'stale-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 0 }); // no live main process
    guardM.mockImplementation(runGuard(fenceOk(1)) as never);

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true });
    expect(b.phantomCoalesceBroken).toMatchObject({ serviceSecondsSinceStart: null });
    expect(spawnM).toHaveBeenCalled();
  });

  it('EI-11137: unverifiable (probe failed) falls back to trusting the marker, flagged verified:false', async () => {
    acquireM.mockResolvedValue({
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-1',
          owner_label: 'peer-one',
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    } as never);
    mockResolvedTyped(probeM, { ok: false }); // no systemd / probe error

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: true, target: 'staging', restarted: false, coalesced: true, verified: false });
    expect(b.note).toMatch(/could NOT be verified/i);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('releases the cooldown marker if the drain/restart step aborts after claiming it (stale fence)', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL2',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockImplementation(runGuard(fenceStale()) as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({ ok: false, target: 'staging', reason: 'stale_fence_superseded' });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL2' }));
  });

  it('releases the cooldown marker if the drain-gate itself never grants (e.g. drain_timeout)', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL3',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    guardM.mockResolvedValue({ acquired: false, reason: 'drain_timeout', holders: [] } as never);

    const b = body(await call({ confirm: true, target: 'staging' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'staging',
      reason: 'resource_drain_timeout',
      resource: 'staging-server',
    });
    expect(releaseM).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lockId: 'COOL3' }));
  });
});

describe('dev:restart gateway readiness (EI-21651903020639415)', () => {
  it('accepts a listener in the new MainPID service cgroup and rejects an unrelated listener', () => {
    const cgroups = new Map([
      [5252, '/user.slice/gateway.service'],
      [5353, '/user.slice/gateway.service'],
      [5454, '/user.slice/gateway.service/worker.scope'],
      [5555, '/user.slice/other.service'],
    ]);
    const read = (pid: number) => cgroups.get(pid) ?? null;
    expect(gatewayListenerBelongsToService(5252, 5353, read)).toBe(true);
    expect(gatewayListenerBelongsToService(5252, 5454, read)).toBe(true);
    expect(gatewayListenerBelongsToService(5252, 5555, read)).toBe(false);
    expect(gatewayListenerBelongsToService(5252, 5656, read)).toBe(false);
    expect(gatewayListenerBelongsToService(5252, 5353, () => '/')).toBe(false);
  });

  it('reports the gateway ready when a child in the new service cgroup owns the listener', async () => {
    mockResolvedTyped(acquireM, {
      ok: true, mode: 'exclusive', status: 'held', lock_id: 'COOL-GATEWAY-CHILD',
      expires_ts: new Date(), shared_holders: [], fence_seq: 33,
    } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, secondsSinceStart: 1 } as never);
    listeningSocketsM.mockResolvedValue(gatewayListenerResult(5353));
    vi.mocked(readProcessCgroupPath).mockImplementation((pid) =>
      pid === 5252 || pid === 5353 ? '/user.slice/gateway.service' : null,
    );
    mockResolvedTyped(gatewayHealthM, { reachable: true, detail: 'HTTP 200' });
    guardM.mockImplementation(runGuard(fenceOk(33)) as never);

    const b = body(await call({ confirm: true, authorize: true, target: 'gateway', reason: 'verify child listener readiness' }));

    expect(b).toMatchObject({ ok: true, restarted: true, gatewayReadiness: { ready: true, observedPid: 5252 } });
    expect(gatewayHealthM).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('waits for a new MainPID before probing /healthz and only then reports restarted:true', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-GATEWAY-READY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 31,
    } as never);
    // The first probe is the pre-restart baseline; the next two model systemd
    // still exposing the old process before the detached restart lands, then a
    // new process. Health must not be probed against either old-PID observation.
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9998 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, secondsSinceStart: 1 } as never);
    listeningSocketsM.mockResolvedValue(gatewayListenerResult(5252));
    mockResolvedTyped(gatewayHealthM, { reachable: true, detail: 'HTTP 200' });
    mockImplementationTyped(guardM, runGuard(fenceOk(31)));

    const b = body(
      await call({
        confirm: true,
        authorize: true,
        target: 'gateway',
        reason: 'verify the gateway restart readiness contract',
      }),
    );

    expect(b).toMatchObject({
      ok: true,
      target: 'gateway',
      drained: true,
      restarted: true,
      restartedFromPid: 4242,
      gatewayReadiness: {
        ready: true,
        pidChanged: true,
        observedPid: 5252,
        health: { reachable: true, detail: 'HTTP 200' },
      },
    });
    expect(gatewayHealthM).toHaveBeenCalledTimes(1);
    expect(gatewayHealthM.mock.calls[0]?.[0]).toMatch(/127\.0\.0\.1:\d+\/healthz$/);
    expect(probeM.mock.invocationCallOrder.at(-1)).toBeLessThan(gatewayHealthM.mock.invocationCallOrder[0]!);
    expect(b.verifyWith).toMatch(/healthz/);
    expect(b.note).toMatch(/MainPID changed to 5252/);
  });

  it('returns a distinct scheduled/not-ready result when the new PID never answers /healthz', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-GATEWAY-NOT-READY',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 32,
    } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 } as never);
    mockResolvedOnceTyped(probeM, { ok: true, mainPid: 5252, secondsSinceStart: 1 } as never);
    listeningSocketsM.mockResolvedValue(gatewayListenerResult(5252));
    mockResolvedTyped(gatewayHealthM, { reachable: false, detail: 'ConnectionRefused' });
    mockImplementationTyped(guardM, runGuard(fenceOk(32)));

    // WI-10005747: `ready:false` now means the whole 20s readiness budget was SPENT polling the
    // listener + /healthz (it used to mean "the first single-shot look missed"), so drive the
    // budget with fake timers instead of waiting it out in real time.
    vi.useFakeTimers();
    let b: ReturnType<typeof body>;
    try {
      const pending = call({
        confirm: true,
        authorize: true,
        target: 'gateway',
        reason: 'exercise the not-ready response',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      b = body(await pending);
    } finally {
      vi.useRealTimers();
    }
    expect(gatewayHealthM.mock.calls.length).toBeGreaterThan(1);

    expect(b).toMatchObject({
      ok: false,
      target: 'gateway',
      drained: true,
      restarted: false,
      restartScheduled: true,
      gatewayReadiness: {
        ready: false,
        pidChanged: true,
        observedPid: 5252,
        health: { reachable: false, detail: 'ConnectionRefused' },
      },
    });
    expect(b.verifyWith).toMatch(/healthz/);
    expect(b.note).toMatch(/readiness was NOT confirmed|Do not send requests yet/i);
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:bg-host (EI-13307 widened cooldown)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('correlates the request and outcome audit rows and reports restarted only after the active PID changes', async () => {
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(21)));

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restartScheduled: true,
      systemdJobAccepted: true,
      restartObserved: true,
      restarted: true,
      restartedFromPid: 4321,
      restartReadiness: { ready: true, observedPid: 4322, activeState: 'active' },
    });
    expect(typeof b.restartRequestId).toBe('string');
    expect(auditUnsafeM).toHaveBeenCalledTimes(2);
    const request = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    const outcome = JSON.parse(auditUnsafeM.mock.calls[1]![1][5] as string);
    expect(request).toMatchObject({
      requestId: b.restartRequestId,
      phase: 'request',
      beforeMainPid: 4321,
      restartCommand: 'systemctl --user --no-block restart papercusp-bg-host.service',
    });
    expect(outcome).toMatchObject({
      requestId: request.requestId,
      phase: 'outcome',
      restartCommandExitCode: 0,
      systemdJobAccepted: true,
      restartObserved: true,
      restarted: true,
      observedMainPid: 4322,
      observedActiveState: 'active',
    });
  });

  it('refuses to schedule a bg-host restart when the request audit cannot be persisted', async () => {
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(25)));
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG-AUDIT-FAILURE',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    auditUnsafeM.mockRejectedValueOnce(new Error('audit database unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    let b: ReturnType<typeof body>;
    try {
      b = body(await call({ confirm: true, target: 'bg-host' }));
      expect(warn).toHaveBeenCalledWith('[dev:restart] audit write failed:', 'audit database unavailable');
    } finally {
      warn.mockRestore();
    }

    expect(b).toMatchObject({
      ok: false,
      target: 'bg-host',
      drained: true,
      restarted: false,
      restartScheduled: false,
      audited: false,
      requestAuditPersisted: false,
      reason: 'bg_host_restart_request_audit_failed',
    });
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('reports loadedNewCode:true when the restart built a fresh bundle (no stale marker in the unit tree)', async () => {
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(23)));

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, restarted: true, loadedNewCode: true });
    expect(b.bundleStale).toBeUndefined();
    expect(bgHostBundleStaleM).toHaveBeenCalledWith(BG_HOST_UNIT_ROOT);
  });

  it('EI-25257294558913225: a restart whose rebuild was refused is restarted but NOT ok — it loaded no new code', async () => {
    acquireM.mockResolvedValue({
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG-STALE-BUNDLE',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    } as never);
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(24)));
    bgHostBundleStaleM.mockReturnValueOnce({
      schema: 'bundle-stale-v1',
      failedAt: '2026-10-06T19:02:19.596Z',
      entry: 'bin/hono-host.ts',
      outfile: 'dist-host/hono-host.mjs',
      servingBundleMtime: '2026-10-06T18:47:10.795Z',
      servingBundleAgeSecAtFailure: 909,
      failingFiles: [],
      error: '🚨 free reference `structuredRootShape` at libs/generic/tooldef/src/serialize-result.ts:364:18',
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: false,
      restarted: true,
      loadedNewCode: false,
      reason: 'bg_host_restarted_on_stale_bundle',
      bundleStale: { servingBundleMtime: '2026-10-06T18:47:10.795Z' },
    });
    expect(String(b.bundleStale.error)).toMatch(/structuredRootShape/);
    expect(b.note).toMatch(/STALE bundle built 2026-10-06T18:47:10\.795Z/);
  });

  it('releases the git-sync barrier after an accepted restart job returns active without a PID transition', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG-NO-PID',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 22,
    });
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(22)));
    bgHostRestartReadinessM.mockResolvedValueOnce({
      ready: false,
      observed: false,
      outcome: 'not-observed',
      pidChanged: false,
      observedPid: null,
      activeState: 'active',
      result: 'success',
      waitedMs: 30_000,
    });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'bg-host',
      restartScheduled: true,
      systemdJobAccepted: true,
      restartObserved: false,
      restarted: false,
      reason: 'bg_host_restart_not_observed',
    });
    expect(gitSyncBarrierReleaseM).toHaveBeenCalledTimes(1);
    const request = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    const outcome = JSON.parse(auditUnsafeM.mock.calls[1]![1][5] as string);
    expect(outcome).toMatchObject({
      requestId: request.requestId,
      phase: 'outcome',
      restartObserved: false,
      restarted: false,
      observedMainPid: null,
      systemdJobAccepted: true,
    });
  });

  it('uses bounded startup polling for the portless bg-host and labels MainPID=0/activating as transient', () => {
    const hint = restartVerificationHint('bg-host', 'papercusp-bg-host.service', 7777);
    expect(hint).toContain('Bounded poll (up to ~30s)');
    expect(hint).toMatch(/MainPID.*nonzero/);
    expect(hint).toMatch(/ActiveState/);
    expect(hint).toContain('MainPID=0 with ActiveState=activating means still starting, NOT failed');
    expect(hint).toContain('differs from 7777');
    expect(hint).not.toContain('dev:listening_ports');
  });

  it('verifies the BG-host MCP proxy through its listener on port 9271', () => {
    const hint = restartVerificationHint('mcp-proxy-bg-host', 'papercup-mcp-proxy-bg-host.service', 8908);
    expect(hint).toContain('dev:listening_ports { port: 9271 }');
    expect(hint).toContain('different from 8908');
  });

  // EI-24790218658923698: a crash at module import yields a fresh nonzero MainPID that dies
  // seconds later, so "MainPID nonzero and different" alone passes on a crash-loop.
  it('tells the caller to confirm bg-host STAYS up, naming the pre-restart NRestarts', () => {
    const hint = restartVerificationHint('bg-host', 'papercusp-bg-host.service', 7777, 4);
    expect(hint).toContain('STAYS up');
    expect(hint).toContain('NRestarts still 4');
    expect(hint).toContain("logs:read { unit: 'papercusp-bg-host.service'");
    expect(restartVerificationHint('bg-host', 'papercusp-bg-host.service', 7777)).toContain(
      'NRestarts still at its pre-restart value',
    );
  });

  it("names peers' in-flight edits in the tree it boots, so a host that does not stay up has its suspects", async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(11)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 7777, secondsSinceStart: 99999, nRestarts: 2 });
    preflightM.mockResolvedValue(bootVerdict({ target: 'bg-host', requestedRoot: `${BG_HOST_UNIT_ROOT}/apps/operator` }));
    const edit = {
      path: 'packages/operator-core/lib/agent-tools/plans/rubric-template.ts',
      owner: 'su-peer',
      intent: 'rubric evidence runtime id',
    };
    peerEditsM.mockResolvedValue({ checked: true, tree: BG_HOST_UNIT_ROOT, total: 1, files: [edit] });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(peerEditsM).toHaveBeenCalledWith(`${BG_HOST_UNIT_ROOT}/apps/operator`, 'me');
    expect(b).toMatchObject({ ok: true, restarted: true, peerInFlightEdits: { checked: true, total: 1, files: [edit] } });
    expect(b.note).toContain('rubric-template.ts (su-peer)');
    expect(b.note).toContain('mid-edit by other agents');
    expect(b.verifyWith).toContain('NRestarts still 2');
  });

  it('omits the advisory when no peer holds a source file in the booted tree', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(11)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 7777, secondsSinceStart: 99999 });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, restarted: true });
    expect(b).not.toHaveProperty('peerInFlightEdits');
    expect(b.note).not.toContain('mid-edit by other agents');
  });

  it('claims the bg-host cooldown marker with the WIDENED ~13min TTL (780s), not the generic 120s one', async () => {
    mockResolvedTyped(acquireM, {
      ok: true,
      mode: 'exclusive',
      status: 'held',
      lock_id: 'COOL-BG',
      expires_ts: new Date(),
      shared_holders: [],
      fence_seq: 1,
    });
    mockImplementationTyped(guardM, runGuard(fenceOk(11)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 7777, secondsSinceStart: 99999 });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(acquireM).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: 'bg-host-cooldown', mode: 'exclusive', ttlSec: 13 * 60 }),
    );
    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, drained: true, restartedFromPid: 7777 });
    // (b): the result states the rail-freeze cost explicitly, referencing EI-13317.
    expect(b.note).toMatch(/~13min/);
    expect(b.note).toMatch(/EI-13317/);
  });

  it("a restart request ~10min (600s) after a peer's real bg-host restart COALESCES under the widened window — the exact storm from EI-13307 (old 120s window would have fired a fresh restart here)", async () => {
    mockResolvedTyped(acquireM, {
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          owner: 'peer-2',
          owner_label: 'peer-two',
          resource: 'bg-host-cooldown',
          lock_id: 'COOL-PEER',
          acquired_ts: new Date(),
          fence_seq: 1,
          mode: 'exclusive',
          status: 'held',
          reason: '',
          expires_ts: new Date(),
        },
      ],
    });
    // 600s ago: outside the OLD 120s window (would have been a phantom / real
    // restart under the pre-fix code) but well inside the NEW 780s window.
    mockResolvedTyped(probeM, { ok: true, mainPid: 8888, secondsSinceStart: 600 });

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({
      ok: true,
      target: 'bg-host',
      restarted: false,
      coalesced: true,
      verified: true,
      restartedSecondsAgo: 600,
      mainPid: 8888,
    });
    expect(b.note).toMatch(/peer-two/);
    expect(guardM).not.toHaveBeenCalled();
    expect(spawnM).not.toHaveBeenCalled();
  });

  it("a restart request >13min (900s) after a peer's real bg-host restart is OUTSIDE even the widened window — fires a genuine restart", async () => {
    mockResolvedTyped(acquireM, {
      ok: false,
      reason: 'held_exclusive',
      holders: [
        {
          resource: 'restart:bg-host',
          owner: 'peer-3',
          owner_label: 'peer-three',
          mode: 'exclusive',
          status: 'held',
          lock_id: 'lock-peer-3',
          reason: '',
          acquired_ts: new Date(),
          expires_ts: new Date(),
          fence_seq: 3,
        },
      ],
    });
    mockResolvedTyped(probeM, { ok: true, mainPid: 4321, secondsSinceStart: 900 });
    mockImplementationTyped(guardM, runGuard(fenceOk(12)));

    const b = body(await call({ confirm: true, target: 'bg-host' }));

    expect(b).toMatchObject({ ok: true, target: 'bg-host', restarted: true, restartedFromPid: 4321 });
    expect(b.coalesced).toBeUndefined();
    expect(b.phantomCoalesceBroken).toMatchObject({
      staleMarkerHolder: 'peer-three',
      serviceSecondsSinceStart: 900,
      cooldownSec: 13 * 60,
    });
  });
});

describe('dev:restart confirm with PAPERCUSP_ALLOW_DEV_RESTART=1, target:dev (unaffected by the debounce)', () => {
  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('uses the :3070 listener as the restart readiness contract instead of a one-shot MainPID read', async () => {
    mockImplementationTyped(guardM, runGuard(fenceOk(3)));
    mockResolvedTyped(probeM, { ok: true, mainPid: 4242, secondsSinceStart: 9999 });

    const b = body(await call({ confirm: true }));

    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true, restartedFromPid: 4242 });
    expect(b.verifyWith).toMatch(/dev:listening_ports \{ port: 3070 \}/);
    expect(b.verifyWith).toMatch(/ownerVisible:true/);
    expect(b.verifyWith).toMatch(/different from 4242/);
    expect(b.verifyWith).not.toMatch(/systemctl --user show/);
  });

  it('returns a host-global cross-domain lease as a structured refusal with the holder domain', async () => {
    guardM.mockResolvedValue({
      acquired: false,
      reason: 'held_in_other_domain',
      holders: [
        {
          owner: 'legacy-holder',
          owner_label: null,
          mode: 'exclusive',
          status: 'held',
          coordination_domain: foreignCoordinationDomain,
        },
      ],
    } as never);

    const b = body(await call({ target: 'dev', confirm: true, authorize: true, reason: 'reload operator' }));

    expect(b).toMatchObject({
      ok: false,
      target: 'dev',
      reason: 'resource_held_in_other_domain',
      resource: 'dev-server',
      holders: [
        {
          owner: 'legacy-holder',
          mode: 'exclusive',
          status: 'held',
          coordination_domain: foreignCoordinationDomain,
        },
      ],
    });
    expect(spawnM).not.toHaveBeenCalled();
  });

  it('never touches the cooldown machinery for dev', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(3) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const b = body(await call({ confirm: true }));
    expect(b).toMatchObject({ ok: true, target: 'dev', restarted: true });
    expect(acquireM).not.toHaveBeenCalled();
    expect(releaseM).not.toHaveBeenCalled();
    expect(spawnM).toHaveBeenCalledWith(
      'sh',
      ['-c', expect.stringContaining('papercusp-dev-api.service')],
      expect.anything(),
    );
  });

  it('target:desktop-dev drains the named resource and signals only the verified listener child', async () => {
    mockImplementationTyped(guardM, async (_spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      return { acquired: true, result: await run(fenceOk(7) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const b = body(
      await call({ target: 'desktop-dev', confirm: true, authorize: true, reason: 'reload desktop operator edit' }),
    );
    expect(b).toMatchObject({
      ok: true,
      target: 'desktop-dev',
      drained: true,
      restarted: true,
      listenerPid: 327001,
      enabledVia: 'env',
      audited: true,
    });
    expect(desktopRestartM).toHaveBeenCalledTimes(1);
    expect(guardM).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'desktop-dev-server', mode: 'exclusive' }),
      expect.any(Function),
    );
    expect(spawnM).not.toHaveBeenCalled();
    expect(auditUnsafeM).toHaveBeenCalledTimes(1);
    const details = JSON.parse(auditUnsafeM.mock.calls[0]![1][5] as string);
    expect(details).toMatchObject({ target: 'desktop-dev', unit: 'desktop-dev-wrapper' });
  });
});

// EI-22040822883429888: guardResource's exclusive drain wait fires spec.onTick every
// ~5s while draining (resource-acquire-wait.ts), and db:migrate already forwards that
// into ctx.progress (EI-18769559897594065) so a long-draining MCP call doesn't look
// indistinguishable from a wedge to the client's idle-timeout watchdog. dev:restart's
// guardResource call omitted onTick entirely — this locks in the same wiring here.
describe('dev:restart drain progress -> ctx.progress heartbeat (EI-22040822883429888)', () => {
  const progressCtx = () => {
    const progress = vi.fn();
    return { ctx: { role: 'operator', progress } as never, progress };
  };

  beforeEach(() => {
    process.env.PAPERCUSP_ALLOW_DEV_RESTART = '1';
  });

  it('wires a spec.onTick callback into guardResource that forwards to ctx.progress as a draining-phase tick', async () => {
    const { ctx, progress } = progressCtx();
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({
        waited_sec: 12,
        holders: [{ owner: 'su-peer', owner_label: 'peer', mode: 'shared', status: 'draining' } as never],
      });
      return { acquired: true, result: await run(fenceOk(30) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await tool.handler({ confirm: true, max_drain_sec: 45 } as never, ctx);
    expect(progress).toHaveBeenCalled();
    const draining = progress.mock.calls.map((c) => JSON.parse(c[1] as string)).find((p) => p.phase === 'draining');
    expect(draining).toMatchObject({ phase: 'draining', elapsed_sec: 12, max_drain_sec: 45, remaining_sec: 33 });
    expect(draining.holders[0]).toMatchObject({ owner: 'su-peer', mode: 'shared' });
  });

  it('falls back to the tool default max_drain_sec when the caller does not override it', async () => {
    const { ctx, progress } = progressCtx();
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({ waited_sec: 10, holders: [] });
      return { acquired: true, result: await run(fenceOk(32) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    await tool.handler({ confirm: true } as never, ctx);
    const draining = progress.mock.calls.map((c) => JSON.parse(c[1] as string)).find((p) => p.phase === 'draining');
    // 120 mirrors restart.ts's own module-local DEFAULT_DRAIN_SEC (not exported, so
    // pinned literally here — a change to that constant should fail this assertion).
    expect(draining).toMatchObject({ phase: 'draining', elapsed_sec: 10, max_drain_sec: 120 });
  });

  it('does not throw when ctx has no progress function (older transport shape)', async () => {
    mockImplementationTyped(guardM, async (spec: GuardSpec, run: (fence: FenceToken) => Promise<unknown>) => {
      spec.onTick?.({ waited_sec: 5, holders: [] });
      return { acquired: true, result: await run(fenceOk(31) as never), lock_id: 'L-test' } as GuardOutcome<unknown>;
    });
    const out = body(await call({ confirm: true }));
    expect(out.ok).toBe(true);
  });
});
