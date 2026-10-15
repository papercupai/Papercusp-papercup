/**
 * P-031 (production-readiness-test-coverage) — `routes/harness/spawn.ts`
 * (/launch, /invoke, /resume). Carved out of P-013 because the cluster shells
 * out via `node:child_process.spawn` to the orchestrator — exercising it
 * unmocked risks real spawns. Here `spawn` is replaced with a controllable fake
 * child, and every side-effecting collaborator (launchRun, buildInvokeOnce,
 * org-PG, plugin hooks, fs) is mocked, so the tests assert:
 *   - public reachability + the loopback gate (403 from a non-loopback host),
 *   - payload / param validation (unknown project → 404, bad role → 400),
 *   - that /launch + /resume dispatch `launchRun`, and
 *   - that a valid /invoke dispatches `spawn()` with the exact argv from
 *     buildInvokeOnce — WITHOUT a real child process.
 *
 * Harness mirrors destructive-public-routes.test.ts: registerRoute → throwaway
 * Hono app → app.request(). The loopback guard is left REAL (it's under test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// ── side-effecting collaborators (all mocked) ──
const { mugKettleSystemEnabled } = vi.hoisted(() => ({
  // Production is permanently closed. Tests that need the retired route's
  // lower bookkeeping seam reopen it explicitly in beforeEach below.
  mugKettleSystemEnabled: vi.fn(async () => false),
}));

const launchRun = vi.fn();
vi.mock('../../harness-launch', () => ({
  launchRun: (...a: unknown[]) => (launchRun as (...args: unknown[]) => unknown)(...a),
}));

const resolveProject = vi.fn();
const resolvePhasedProject = vi.fn();
vi.mock('../../harness-core', () => ({
  resolveProject: (...a: unknown[]) => resolveProject(...(a as [])),
  resolvePhasedProject: (...a: unknown[]) => resolvePhasedProject(...(a as [])),
  harnessDir: vi.fn(() => '/proj/.papercusp'),
}));
vi.mock('../../harness-phases', () => ({ phasePhaseLabel: vi.fn((x: unknown) => x) }));
vi.mock('../../harness-paths', () => ({ harnessPackageDir: vi.fn(() => '/harness-pkg') }));

const buildInvokeOnce = vi.fn((..._args: unknown[]) => ({
  command: 'node',
  args: ['invoke-once.js', '--role', 'worker'],
  env: { PAPERCUSP_TEST: '1' },
}));
const resolveSpawnBackendModel = vi.fn((): { backend: string; model: string; effort?: string | null } => ({ backend: 'omp', model: '' }));
vi.mock('../../harness-invoke-once', () => ({
  buildInvokeOnce: (...a: unknown[]) => (buildInvokeOnce as (...args: unknown[]) => unknown)(...a),
  // The invoke route's spawn path (orchestrator-runner) also imports
  // resolveSpawnBackendModel from this module; the mock must mirror the full
  // named-export surface or Vitest 4's evaluator fails the link under
  // full-suite load (the route then 500s). See orchestrator-runner-spawn.test.
  resolveSpawnBackendModel: (...a: unknown[]) =>
    (resolveSpawnBackendModel as (...args: unknown[]) => unknown)(...a),
}));
const recordAdvSession = vi.fn(async (_input: unknown) => 77);
const markAdvSessionEnded = vi.fn(async () => {});
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: (...a: unknown[]) => (recordAdvSession as (...args: unknown[]) => unknown)(...a),
  markAdvSessionEnded: (...a: unknown[]) =>
    (markAdvSessionEnded as (...args: unknown[]) => unknown)(...a),
}));

const { heartbeatSpawns, recordSpawnPid } = vi.hoisted(() => ({
  heartbeatSpawns: vi.fn(async () => {}),
  recordSpawnPid: vi.fn(async () => {}),
}));
const recordSpawnAccountRoute = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('../../fleet/spawn-tree', async (orig) => ({
  ...(await orig<typeof import('../../fleet/spawn-tree')>()),
  recordSpawnAccountRoute,
}));
vi.mock('../../inference-gateway/spawn-env', async (orig) => ({
  ...(await orig<typeof import('../../inference-gateway/spawn-env')>()),
  resolveSpawnGatewayEnv: vi.fn(async (input: { onResolvedAccounts?: (ids: string[]) => void }) => {
    input.onResolvedAccounts?.(['pool-a']);
    return {};
  }),
}));
vi.mock('../../fleet/spawn-reclaim', async (orig) => ({
  ...(await orig<typeof import('../../fleet/spawn-reclaim')>()),
  heartbeatSpawns: (...a: unknown[]) => (heartbeatSpawns as (...args: unknown[]) => unknown)(...a),
  recordSpawnPid: (...a: unknown[]) => (recordSpawnPid as (...args: unknown[]) => unknown)(...a),
}));

const armInboxWake = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({
  awaitId: 1,
  eventKey: 'coord:inbox-wake:test',
  handleNote: 'resumable',
  minSleepSec: 60,
})));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...a: unknown[]) => armInboxWake(...a),
}));

// P-059: the `pot/mug-brief-launch` stub is gone with the module. WI-682 put a
// wake-brief COMPUTE at this route (the one chokepoint every wake path traverses,
// after EI-995's durable seam bypassed the launcher-side compute); the Mug/Kettle
// retirement removed the thing being briefed, so the compute went with it.
//
// The route still THREADS a caller-supplied body.queenBrief → MUG_WAKE_BRIEF, and
// the tests for that survive below. The two tests that drove the compute itself
// are deleted rather than rewritten — with no builder left they could only have
// asserted a mock calling itself.
vi.mock('../../superuser-token', () => ({ SUPERUSER_TOKEN_PATH: '/fake/su-token' }));
vi.mock('../../plugin-host-runtime', () => ({
  firePluginLifecycle: vi.fn(),
}));
vi.mock('../../events/pipeline-events', () => ({
  emitPipelineEvent: vi.fn(),
}));
// P-068/D-098 permanently hard-wired this predicate false after deleting the
// old feature flag. Most cases in this file exercise route behavior BELOW that
// gate (brief/env/session bookkeeping), so bypass the gate explicitly through
// its surviving chokepoint. A dedicated assertion below flips this mock false
// and pins the production 403; the bypass is test scaffolding, not a claim that
// the retired tier remains launchable.
vi.mock('../../pot/started', async (orig) => ({
  ...(await orig<typeof import('../../pot/started')>()),
  mugKettleSystemEnabled: (...a: unknown[]) => mugKettleSystemEnabled(...(a as [])),
}));
vi.mock('@papercusp/flags/server', async (orig) => {
  const actual = await orig<typeof import('@papercusp/flags/server')>();
  // ENDPOINT_AUTH_TIERS gates the loopback guard in route-stack's authStep
  // (`if (await endpointAuthTiersEnabled())`), and the D-009 tests below assert
  // that guard fires (403 from a non-loopback Host). It defaults ON in
  // production (types.ts) and fails CLOSED on error, so it must read ON here —
  // a blanket `() => false` silently disables the guard under test and wedges
  // the green gate. Keep every OTHER flag OFF (the prior default).
  return {
    ...actual,
    // The retired Mug/Kettle flag no longer exists (P-068/D-098). Only the
    // endpoint-auth tier remains a flag concern in this file; the explicit
    // mugKettleSystemEnabled mock above owns the test-only bypass.
    getFlag: vi.fn(
      async (flag: string) =>
        flag === 'papercusp-endpoint-auth-tiers',
    ),
  };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    // `sql` must be CALLABLE: it is used as a tagged template (sql`SELECT …`).
    // This stub was `{}` — an object no tagged-template call can ever satisfy —
    // so every incidental DB read on a fire-and-forget path (the pot-watchdog
    // turn-end arm, which this file does not assert on) threw "sql is not a
    // function" and logged a console.warn. `vitest-fail-on-console` fails a test
    // on that warn, so the file's greenness depended on the rejection landing
    // AFTER the assertions finished — a race, not a pass. P-059 removed one
    // `await import()` from potDemandCheck, the chain settled a tick earlier,
    // and the latent warn moved inside the window. Returning [] makes the stub
    // honest (an empty DB) and removes the race in both directions.
    getOrgPg: vi.fn(() => ({ sql: async () => [] })),
    listUnconsumedEvents: vi.fn(async () => []),
    consumeEvents: vi.fn(async () => {}),
  };
});
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

// Roster/pane-visibility seed (owner-facing zellij dock): a tracked hive/overwatch
// invoke seeds a coord_presence row so the mug/kettle turn appears in the roster and
// gets a pane. Partial-mock so the real module still loads (nothing here calls the
// DB), replacing only writePresence with a spy to assert the seed.
const writePresence = vi.fn(async () => {});
vi.mock('../../agent-tools/coordination/presence', async (orig) => {
  const actual = await orig<typeof import('../../agent-tools/coordination/presence')>();
  return { ...actual, writePresence: (...a: unknown[]) => (writePresence as (...args: unknown[]) => unknown)(...a) };
});

const cleanupMergeResolverAfterFailure = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    parsed: true,
    scopes: [],
    released: true,
  })),
);
vi.mock('../../harness/merge-resolver-cleanup', () => ({
  cleanupMergeResolverAfterFailure: (...a: unknown[]) =>
    cleanupMergeResolverAfterFailure(...a),
}));

// Mock only the fake product paths. Node's lazy CJS/TS imports need real reads,
// stat and realpath together; a blanket mock breaks module loading first.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  const fixturePath = (p: unknown) => /^\/(?:proj|fake)(?:\/|$)/.test(String(p));
  return {
    ...actual,
    // The frozen-repair cwd validator reads a linked worktree's .git pointer.
    // Keep every unrelated path absent so the existing action-log/token branches
    // retain their prior behavior.
    existsSync: vi.fn((p: unknown) => fixturePath(p) ? String(p).endsWith('/.git') : Reflect.apply(actual.existsSync, null, [p])),
    readdirSync: vi.fn((p: unknown, ...args: unknown[]) => fixturePath(p) ? [] : Reflect.apply(actual.readdirSync, null, [p, ...args])),
    readFileSync: vi.fn((p: unknown, ...args: unknown[]) => {
      if (!fixturePath(p)) return Reflect.apply(actual.readFileSync, null, [p, ...args]);
      if (String(p).endsWith('/.git')) {
        return 'gitdir: /proj/.git/worktrees/repair-1\n';
      }
      throw new Error(`no file (mocked): ${String(p)}`);
    }),
    realpathSync: vi.fn((p: unknown, ...args: unknown[]) => fixturePath(p) ? String(p) : Reflect.apply(actual.realpathSync, null, [p, ...args])),
    statSync: vi.fn((p: unknown, ...args: unknown[]) => fixturePath(p) ? ({
      mtimeMs: 0,
      isDirectory: () => !String(p).endsWith('/.git'),
      isFile: () => String(p).endsWith('/.git'),
    }) : Reflect.apply(actual.statSync, null, [p, ...args])),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(async () => {}) };
});

// ── controllable fake child process ──
// The /invoke handler attaches stdout/stderr/close listeners synchronously after
// spawn() returns, then resolves its Promise on 'close'. We emit a line of stdout
// and close(0) on the next microtask — after the listeners are wired.
const spawnMock = vi.fn(() => makeFakeChild(0));
// Spread the REAL module and override ONLY spawn: the invoke runner
// (dbos/orchestrator-runner) also pulls `execFile` (ensureFeatureBranch, ~L1347),
// so a bare `{ spawn }` mock drops it and Vitest 4's evaluator fails the module
// link under load → the route 500s (EI-8598). Mirrors the node:fs / flags / db-org
// partial-mock pattern above; keeps spawn faked so the routing assertions hold.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawn: (...a: unknown[]) => spawnMock(...(a as [])) };
});

function makeFakeChild(exitCode: number, options: { delayMs?: number } = {}) {
  const stdoutCbs: Array<(d: unknown) => void> = [];
  const closeCbs: Array<(code: number) => void> = [];
  const child = {
    pid: 12345,
    stdout: { on: (ev: string, cb: (d: unknown) => void) => ev === 'data' && stdoutCbs.push(cb) },
    stderr: { on: (_ev: string, _cb: unknown) => {} },
    on: (ev: string, cb: (code: number) => void) => {
      if (ev === 'close') closeCbs.push(cb);
    },
    kill: vi.fn(),
  };
  setTimeout(() => {
    stdoutCbs.forEach((cb) => cb(Buffer.from('decision line\n')));
    closeCbs.forEach((cb) => cb(exitCode));
  }, options.delayMs ?? 0);
  return child;
}

import { registerRoute } from '../define-route';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import spawnRoutes, { __test as spawnTest } from '../routes/harness/spawn';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [launch, invoke, resume] = spawnRoutes as unknown as AnyRoute[];

function appWith(def: AnyRoute): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
const post = (b: unknown = {}) => ({
  method: 'POST',
  body: JSON.stringify(b),
  headers: { 'content-type': 'application/json' } as Record<string, string>,
});
const PROJECT = { slug: 'papercup', path: '/proj' };
let previousAllowRemoteAdmin: string | undefined;

beforeEach(() => {
  // WI-1499 pins the spawn chokepoint inside a systemd-run scope by default on
  // linux; these tests assert the ROUTING (route → spawnInvokeOnce → argv), so
  // run the direct spawn — the wrapper has its own coverage in
  // dbos/orchestrator-runner-scope.test.ts.
  // The fleet's agent environment enables the deliberate remote-admin opt-out.
  // Pin it off here so the D-009 non-loopback assertions exercise the declared
  // loopback tier rather than inheriting the caller's process environment.
  previousAllowRemoteAdmin = process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  process.env.PAPERCUSP_AGENT_SPAWN_SCOPE = '0';
  resolveProject.mockResolvedValue(PROJECT);
  resolvePhasedProject.mockResolvedValue(PROJECT);
  launchRun.mockResolvedValue({ ok: true, logPath: '/log/run.out' });
  resolveSpawnBackendModel.mockReturnValue({ backend: 'omp', model: '' });
  mugKettleSystemEnabled.mockResolvedValue(true);
  spawnMock.mockImplementation(() => makeFakeChild(0));
  armInboxWake.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
  if (previousAllowRemoteAdmin === undefined) {
    delete process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN;
  } else {
    process.env.PAPERCUSP_ALLOW_REMOTE_ADMIN = previousAllowRemoteAdmin;
  }
  previousAllowRemoteAdmin = undefined;
});

describe('POST /harness/:slug/launch (P-031)', () => {
  it('is reachable with no auth header + dispatches launchRun on valid input', async () => {
    const res = await appWith(launch).request('/harness/papercup/launch', post({ extra: 'go' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, logPath: '/log/run.out' });
    expect(launchRun).toHaveBeenCalledWith(PROJECT, 'go');
  });

  it('returns 404 for an unknown project (no launchRun)', async () => {
    resolvePhasedProject.mockResolvedValue(null);
    const res = await appWith(launch).request('/harness/nope/launch', post());
    expect(res.status).toBe(404);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('maps a launchRun failure to 500', async () => {
    launchRun.mockResolvedValue({ ok: false, error: 'boom' });
    const res = await appWith(launch).request('/harness/papercup/launch', post());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'boom' });
  });

  it('ignores a non-string extra (defaults to empty)', async () => {
    await appWith(launch).request('/harness/papercup/launch', post({ extra: { not: 'a string' } }));
    expect(launchRun).toHaveBeenCalledWith(PROJECT, '');
  });

  it('rejects a non-loopback host with 403 before any launch (D-009)', async () => {
    const res = await appWith(launch).request('http://192.168.1.50:3070/harness/papercup/launch', post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'loopback_only' });
    expect(launchRun).not.toHaveBeenCalled();
  });
});

describe('POST /harness/:slug/invoke (P-031)', () => {
  it('routes through the spawnInvokeOnce chokepoint → spawn() with buildInvokeOnce argv + returns the captured output', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status, await res.clone().text()).toBe(200);
    const invokeArgs = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(invokeArgs?.extraEnv?.PAPERCUSP_SID).toMatch(/^s-invoke-[0-9a-f-]{36}$/);
    expect(invokeArgs?.extraEnv?.PAPERCUSP_SPAWN_ID).toBe(invokeArgs?.extraEnv?.PAPERCUSP_SID);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // The route now funnels through spawnInvokeOnce → runChild (unify-agent-spawn-chokepoint
    // P-008), which spawns the buildInvokeOnce argv `detached: true` (its own process group,
    // so the timeout/abort can group-kill the whole tree).
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['invoke-once.js', '--role', 'worker'],
      { cwd: '/proj', env: { PAPERCUSP_TEST: '1' }, detached: true },
    );
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: 'papercup',
      role: 'worker',
      decisionLine: 'decision line',
      exitCode: 0,
      timedOut: false,
    });
  }, 30_000);

  it('runs a frozen-candidate release-fixer from its validated linked worktree', async () => {
    const repairWorktree = '/proj/.papercusp/worktrees/repair-1';
    const spawnRecordId = 's-release-fixer-route-1';
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=release-fixer',
      post({ spawnRecordId, releaseFixerContext: { repairWorktree } }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(armInboxWake).toHaveBeenCalledWith({ ownerId: spawnRecordId });
    expect(buildInvokeOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: repairWorktree,
        stateDir: `${repairWorktree}/.papercusp`,
        extraEnv: expect.objectContaining({
          PAPERCUSP_SID: spawnRecordId,
          PAPERCUSP_SPAWN_ID: spawnRecordId,
        }),
      }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['invoke-once.js', '--role', 'worker'],
      { cwd: repairWorktree, env: { PAPERCUSP_TEST: '1' }, detached: true },
    );
    expect(recordSpawnPid).toHaveBeenCalledWith(expect.anything(), spawnRecordId, 12345, {
      handoff: true,
    });
    expect(heartbeatSpawns).toHaveBeenCalledTimes(1);
    const outputWrite = heartbeatSpawns.mock.calls[0] as unknown as [
      unknown,
      string[],
      ReadonlyMap<string, number>,
    ];
    expect(outputWrite[1]).toEqual([spawnRecordId]);
    expect(outputWrite[2]).toBeInstanceOf(Map);
    expect(outputWrite[2].get(spawnRecordId)).toEqual(expect.any(Number));
  }, 30_000);

  it.each([
    ['codex', 'gpt-6.1-sol:high', 'gpt-6.1-sol', 'xhigh', 'high'],
    ['claude-code', 'opus:xhigh', 'opus[1m]', 'max', 'xhigh'],
  ])('persists the actual %s effort separately from the requested effort', async (backend, requested, model, effort, requestedEffort) => {
    resolveSpawnBackendModel.mockReturnValue({ backend, model, effort });
    const spawnRecordId = 's-blueprint-effort-metadata';
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({
      spawnRecordId, spawnModel: requested, spawnBackend: backend, account: 'auto',
    }));

    expect(res.status, await res.clone().text()).toBe(200);
    expect(recordSpawnAccountRoute).toHaveBeenCalledWith(expect.anything(), spawnRecordId, expect.objectContaining({
      ownerId: spawnRecordId, accountRoute: 'auto', requestedEffort,
      launchedBackend: backend, launchedModel: model, launchedEffort: effort,
      resolvedAccountIds: ['pool-a'],
    }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('uses the same validated repair cwd in the tracked session row and child spawn', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'claude-code', model: '' });
    const repairWorktree = '/proj/.papercusp/worktrees/repair-1';
    const spawnRecordId = 's-release-fixer-hive-row';
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=release-fixer&bpkind=hive',
      post({ spawnRecordId, releaseFixerContext: { repairWorktree } }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    // Tracked launches mint a distinct hiveSpawnId for their own session
    // lifecycle; the plain spawned_agents row must not be armed here.
    expect(armInboxWake).not.toHaveBeenCalled();
    expect(recordAdvSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: repairWorktree }),
    );
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv?.PAPERCUSP_SPAWN_ID).toMatch(/^s-\d+-[0-9a-f]+$/);
    expect(arg?.extraEnv?.PAPERCUSP_SID).toBe(arg?.extraEnv?.PAPERCUSP_SPAWN_ID);
    expect(arg?.extraEnv?.PAPERCUSP_SPAWN_ID).not.toBe(spawnRecordId);
    expect(heartbeatSpawns).toHaveBeenCalledWith(expect.anything(), [spawnRecordId], expect.any(Map));
    expect(spawnMock).toHaveBeenCalledWith(
      'node',
      ['invoke-once.js', '--role', 'worker'],
      { cwd: repairWorktree, env: { PAPERCUSP_TEST: '1' }, detached: true },
    );
  }, 30_000);

  it('rejects a repair-worktree override from a non-release-fixer role before spawning', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=worker',
      post({
        releaseFixerContext: {
          repairWorktree: '/proj/.papercusp/worktrees/repair-1',
        },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'invalid_repair_worktree',
      code: 'repair_worktree_role_mismatch',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports ok:false when the child exits non-zero', async () => {
    // The chokepoint emits a one-line diagnostic to stderr on a non-zero exit with empty
    // stderr (orchestrator-runner.ts) — expected, so assert it explicitly rather than let
    // vitest-fail-on-console trip on it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnMock.mockImplementation(() => makeFakeChild(1));
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200); // the route succeeds; the *run* failed
    expect(await res.json()).toMatchObject({ ok: false, exitCode: 1 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[dbos-invoke] role=worker exited 1'));
    expect(cleanupMergeResolverAfterFailure).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('cleans up a failed merge-resolver with the route-owned child identity and exact conflict extra', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const extra = [
      '--git-sync-conflict',
      JSON.stringify({
        scopes: ['superproject', 'libs/papercusp'],
        files: 'superproject: packages/operator-core/lib/a.ts; libs/papercusp: packages/x.ts',
        authorship: [],
      }),
    ];
    spawnMock.mockImplementation(() => makeFakeChild(1));

    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=merge-resolver',
      post({ extra }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, exitCode: 1, timedOut: false });
    expect(cleanupMergeResolverAfterFailure).toHaveBeenCalledTimes(1);
    const cleanupInput = cleanupMergeResolverAfterFailure.mock.calls[0]?.[0] as {
      projectPath: string;
      ownerId: string;
      extra: string[];
    };
    expect(cleanupInput).toEqual({
      projectPath: '/proj',
      ownerId: expect.stringMatching(/^s-invoke-[0-9a-f-]{36}$/),
      extra,
    });
    const invokeInput = buildInvokeOnce.mock.calls[0]?.[0] as {
      extraEnv?: Record<string, string>;
    };
    expect(cleanupInput.ownerId).toBe(invokeInput.extraEnv?.PAPERCUSP_SID);
    errSpy.mockRestore();
  });

  it('cleans up a timed-out merge-resolver even when the child eventually reports exit 0', async () => {
    const extra = [
      '--git-sync-conflict',
      JSON.stringify({
        scopes: ['superproject'],
        files: 'superproject: packages/operator-core/lib/a.ts',
      }),
    ];
    // resolveInvokeTimeoutMs clamps the shortest route timeout to 5s. Let the
    // fake child close just after that timer so the route observes timedOut=true.
    spawnMock.mockImplementation(() => makeFakeChild(0, { delayMs: 5_050 }));

    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=merge-resolver',
      post({ extra, timeoutMs: 5_000 }),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, exitCode: 0, timedOut: true });
    expect(cleanupMergeResolverAfterFailure).toHaveBeenCalledTimes(1);
    expect(cleanupMergeResolverAfterFailure.mock.calls[0]?.[0]).toEqual({
      projectPath: '/proj',
      ownerId: expect.stringMatching(/^s-invoke-[0-9a-f-]{36}$/),
      extra,
    });
  }, 15_000);

  it('does not clean up a successful merge-resolver', async () => {
    const extra = [
      '--git-sync-conflict',
      JSON.stringify({
        scopes: ['superproject'],
        files: 'superproject: packages/operator-core/lib/a.ts',
      }),
    ];

    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=merge-resolver',
      post({ extra }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(cleanupMergeResolverAfterFailure).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown project (no spawn)', async () => {
    resolveProject.mockResolvedValue(null);
    const res = await appWith(invoke).request('/harness/nope/invoke?role=worker', post());
    expect(res.status).toBe(404);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid role name with 400 (no spawn)', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=bad%20role', post());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid role name' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('permanently rejects a retired role when the production Mug/Kettle gate is closed', async () => {
    mugKettleSystemEnabled.mockResolvedValue(false);
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen', post({}));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'mug_kettle_retired',
      retired: 'permanent',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback host with 403 before any spawn (D-009)', async () => {
    const res = await appWith(invoke).request('http://192.168.1.50:3070/harness/papercup/invoke?role=worker', post());
    expect(res.status).toBe(403);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // P-071 smoke regression (local-hive-orchestration, 2026-06-10): the route
  // silently dropped fireLaunchBlueprint's `kickoff`, so the Queen woke with no
  // idea why. It now threads to the child as MUG_BRIEF (the same channel
  // cup:spawn uses for the Queen brief → buildPrompt's situational overlay).
  it('threads body.kickoff to the child as extraEnv.MUG_BRIEF', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=worker',
      post({ kickoff: 'Wake (manual): run the placement smoke.' }),
    );
    expect(res.status).toBe(200);
    expect(buildInvokeOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        extraEnv: expect.objectContaining({ MUG_BRIEF: 'Wake (manual): run the placement smoke.' }),
      }),
    );
  });

  it('omits MUG_BRIEF when no kickoff is sent', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv ?? {}).not.toHaveProperty('MUG_BRIEF');
  });

  // EI-7871 (WI-3082 follow-up): this route is the one chokepoint every
  // launch-blueprint spawn (queen/overwatch/doc-steward/sentinel/scan/deploy/…)
  // traverses, and previously stamped no PAPERCUSP_TURN_TRIGGER at all — every
  // such run's agent_usage_samples.turn_trigger stayed NULL. Every caller of this
  // route fires from a scheduled/system trigger, never a live human, so 'cron' is
  // the correct default.
  it('EI-7871: defaults PAPERCUSP_TURN_TRIGGER to cron when the body carries none', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ PAPERCUSP_TURN_TRIGGER: 'cron' });
  });

  it('EI-7871: a caller-supplied body.turnTrigger overrides the cron default (e.g. a genuine coord-wake fresh-launch)', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=queen',
      post({ turnTrigger: 'coord-wake' }),
    );
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ PAPERCUSP_TURN_TRIGGER: 'coord-wake' });
  });

  // EI-13668: `@role:mug` (and every other role-slot selector) resolved to
  // targets:[]/woken:0 against a truly-live Mug session because the child process
  // never carried a durable PAPERCUSP_AGENT_ROLE — deriveAgentRole (identity.ts)
  // fell back to the generic identity.source→role mapping ('su'/'cup') on every
  // presence write the Mug's OWN session made after its one-shot spawn-time seed.
  // Assert this chokepoint now stamps PAPERCUSP_AGENT_ROLE, CANONICALIZED
  // (queen → mug, the pot-rename mapping), onto the child's extraEnv.
  it('EI-13668: stamps extraEnv.PAPERCUSP_AGENT_ROLE with the CANONICAL role so the child\'s own presence writes report it correctly', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen', post({}));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ PAPERCUSP_AGENT_ROLE: 'mug' });
  });

  it('EI-13668: an already-canonical role is stamped unchanged', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ PAPERCUSP_AGENT_ROLE: 'worker' });
  });

  // EI-506: MUG_BRIEF is the Queen→BEE situational overlay. For the QUEEN's own
  // wake the kickoff is a terse wake-reason that would render as a misleading
  // self-addressed overlay — and her wake reason is already in the wake brief's
  // "Woke by:" line. So when she HAS a wake brief, MUG_BRIEF is suppressed.
  it('EI-506: suppresses MUG_BRIEF for a queen wake that carries a wake brief', async () => {
    const res = await appWith(invoke).request(
      '/harness/papercup/invoke?role=queen',
      post({ kickoff: 'timer', queenBrief: '## Your wake brief\n**Woke by:** timer\n### Frontier — ready' }),
    );
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv ?? {}).not.toHaveProperty('MUG_BRIEF');
    expect(arg?.extraEnv).toMatchObject({ MUG_WAKE_BRIEF: expect.stringContaining('Woke by') });
  });

  // EI-506 fallback: with no brief on the body, the kickoff is still threaded as
  // MUG_BRIEF so the wake isn't left with no idea why it fired (preserves the
  // P-071 "why you woke" signal).
  //
  // P-059 note: this used to arrive here via a route-side compute that degraded to
  // null. The compute is gone, so the branch is now reached directly — an absent
  // body.queenBrief IS the empty case. The OBSERVABLE contract asserted below is
  // byte-identical either way, which is why the test survives the deletion intact.
  it('EI-506: keeps MUG_BRIEF for a queen wake that carries no wake brief', async () => {
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen', post({ kickoff: 'timer' }));
    expect(res.status).toBe(200);
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({ MUG_BRIEF: 'timer' });
    expect(arg?.extraEnv ?? {}).not.toHaveProperty('MUG_WAKE_BRIEF');
  });

  // 2026-07-01 (the gpt-5.4 switch): codex hive launches now ALSO mint a uuid —
  // it is the TRANSCRIPT/ROSTER key (hive-tabs mirror locates the teed
  // codex-transcripts/<uuid>.jsonl by it), NOT a resume handle; resume stays on
  // the durable CODEX_HOME keyed by the adv_sessions row id, so the codex
  // session key must ride alongside the native id, never be displaced by it.
  it('tracks Codex hive launches with a transcript uuid + the durable CODEX_HOME key', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'codex', model: 'gpt-5' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen&bpkind=hive', post({}));
    expect(res.status).toBe(200);
    expect(recordAdvSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex',
      role: 'mug',
      cwd: '/proj',
      label: 'pot · papercup/queen',
      mode: 'console',
      sessionId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      coordOwnerId: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
      // WI-1347: the reconstructed invoke argv rides the row for forensics.
      launchArgv: expect.arrayContaining(['invoke', '--agent=codex', '--role=queen']),
    }));
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({
      PAPERCUSP_CODEX_SESSION_KEY: '77',
      PAPERCUSP_SID: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
      PAPERCUSP_SPAWN_ID: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
      PAPERCUSP_NATIVE_SESSION_ID: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(arg?.extraEnv?.PAPERCUSP_SID).toBe(arg?.extraEnv?.PAPERCUSP_SPAWN_ID);
    // The route records both disposition and the explicit no-signal evidence.
    expect(markAdvSessionEnded).toHaveBeenCalledWith(77, 0, 'self', { signal: null });
  });

  it('tracks hive launches when the resolved backend supports forced native session ids', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'claude-code', model: '' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=queen&bpkind=hive', post({}));
    expect(res.status).toBe(200);
    expect(recordAdvSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude',
      role: 'mug',
      cwd: '/proj',
      label: 'pot · papercup/queen',
      sessionId: expect.stringMatching(/[0-9a-f-]{36}/),
      coordOwnerId: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
    }));
    const arg = buildInvokeOnce.mock.calls[0]?.[0] as { extraEnv?: Record<string, string> } | undefined;
    expect(arg?.extraEnv).toMatchObject({
      PAPERCUSP_SID: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
      PAPERCUSP_NATIVE_SESSION_ID: expect.stringMatching(/[0-9a-f-]{36}/),
      PAPERCUSP_SPAWN_ID: expect.stringMatching(/^s-\d+-[0-9a-f]+$/),
    });
    expect(arg?.extraEnv?.PAPERCUSP_SID).toBe(arg?.extraEnv?.PAPERCUSP_SPAWN_ID);
    // The route records both disposition and the explicit no-signal evidence.
    expect(markAdvSessionEnded).toHaveBeenCalledWith(77, 0, 'self', { signal: null });
  });

  it('seeds a coord_presence row for a tracked launch so the mug/kettle turn is roster-visible (owner pane-visibility)', async () => {
    // The bug this pins: mug/kettle turns ran but the owner saw no zellij pane,
    // because the pui panes from the coord_presence-PRIMARY roster and a tracked
    // hive/overwatch launch mints no presence row of its own (it never calls
    // coord:inbox/orient, the only presence-minting calls). The route now seeds one
    // under the SAME coordOwnerId (= PAPERCUSP_SPAWN_ID) the adv_sessions row uses,
    // so the roster's LEFT-join resolves the resumable session_id for the pane.
    resolveSpawnBackendModel.mockReturnValue({ backend: 'claude-code', model: '' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=overwatch&bpkind=overwatch', post({}));
    expect(res.status).toBe(200);
    expect(writePresence).toHaveBeenCalledTimes(1);
    const [identity, input, harnessSlug] = writePresence.mock.calls[0] as unknown as [
      { ownerId: string; ownerLabel: string; source: string; workspaceId: string | null },
      { agentRole?: string },
      string,
    ];
    // Same coordOwnerId the adv_sessions row + PAPERCUSP_SPAWN_ID carry — the join key.
    const advArg = recordAdvSession.mock.calls[0]?.[0] as { coordOwnerId?: string } | undefined;
    expect(identity.ownerId).toBe(advArg?.coordOwnerId);
    expect(identity.ownerId).toMatch(/^s-\d+-[0-9a-f]+$/);
    // canonicalCoordRole('overwatch') === 'kettle' → the roster classifies the pane.
    expect(identity.ownerLabel).toBe('kettle · papercup');
    expect(identity.source).toBe('fleet-spawn');
    expect(input.agentRole).toBe('kettle');
    expect(harnessSlug).toBe('papercup');
  });

  it('does NOT seed presence for an untracked worker invoke (only tracked hive/overwatch launches are owner-paned)', async () => {
    resolveSpawnBackendModel.mockReturnValue({ backend: 'claude-code', model: '' });
    const res = await appWith(invoke).request('/harness/papercup/invoke?role=worker', post({}));
    expect(res.status).toBe(200);
    expect(writePresence).not.toHaveBeenCalled();
  });
});

// P-071 smoke regression: both hive wakes were SIGTERM'd at ~91s because the
// route's 90s default applied to a full Queen duty cycle. Hive launches now
// default to the route ceiling; explicit timeoutMs still wins for both kinds.
describe('invoke helpers (__test)', () => {
  it('resolveInvokeTimeoutMs: 15min default for plain launches, ceiling default for hive', () => {
    expect(spawnTest.resolveInvokeTimeoutMs(undefined, false)).toBe(900_000);
    expect(spawnTest.resolveInvokeTimeoutMs(undefined, true)).toBe(2_700_000);
  });
  it('resolveInvokeTimeoutMs: explicit timeoutMs wins, clamped to [5s, 2700s]', () => {
    expect(spawnTest.resolveInvokeTimeoutMs(300_000, true)).toBe(300_000);
    expect(spawnTest.resolveInvokeTimeoutMs(1, false)).toBe(5_000);
    expect(spawnTest.resolveInvokeTimeoutMs(99_999_999, false)).toBe(2_700_000);
  });
  it('extractKickoff: trims, caps at 4000 chars, empty for non-strings', () => {
    expect(spawnTest.extractKickoff('  why  ')).toBe('why');
    expect(spawnTest.extractKickoff('x'.repeat(5_000)).length).toBe(4_000);
    expect(spawnTest.extractKickoff(42)).toBe('');
    expect(spawnTest.extractKickoff(undefined)).toBe('');
  });
});

describe('POST /harness/:slug/resume (P-031)', () => {
  it('dispatches launchRun on valid input', async () => {
    const res = await appWith(resume).request('/harness/papercup/resume', post());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, logPath: '/log/run.out' });
    expect(launchRun).toHaveBeenCalledWith(PROJECT);
  });

  it('returns 404 for an unknown project', async () => {
    resolvePhasedProject.mockResolvedValue(null);
    const res = await appWith(resume).request('/harness/nope/resume', post());
    expect(res.status).toBe(404);
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback host with 403 (D-009)', async () => {
    const res = await appWith(resume).request('http://192.168.1.50:3070/harness/papercup/resume', post());
    expect(res.status).toBe(403);
    expect(launchRun).not.toHaveBeenCalled();
  });
});
