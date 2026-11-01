/**
 * fleet/operator-spawn — unit coverage for the operator→agent nursery spawn
 * engine (Brief 4, agent-briefs-2026-06-05): harness/role/cap validation,
 * durable record/finish bookkeeping, the single-harness default, and the
 * failed-attempt rows that replace the old silent-drop dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ownerSteering: { value: null as null | Record<string, unknown> },
  // P-009 (WI-586538): controllable rate-limit config + governor window so
  // spawnConcurrencyCeiling's seed-vs-user branch is directly testable.
  rateLimit: {
    value: { maxSimultaneousAgents: 16, concurrencyFloor: 1 } as Record<string, unknown>,
  },
  governorWindow: { value: null as number | null },
  backgroundWorkers: { enabled: false },
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(), setAdminPoolStatementTimeoutProvider: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  // 'overwatch' included so the B-10 flag-gate (which runs AFTER the known-role
  // check) is reachable in the gate tests below.
  AGENT_ROLES: ['scoper', 'worker', 'validator', 'reviewer', 'operator', 'cup', 'kettle', 'papercup-deep'],
  // Keep transitive agent-tool declarations inert in this focused spawn harness.
  defineTool: (def: unknown) => def,
}));
// @papercusp/flags itself stays REAL (FLAG_DEFAULTS / FLAGS); only the server-side
// getFlag is mocked so the overwatch gate's flag read is controllable. The default
// impl (set in beforeEach) returns each flag's real default, so the other getFlag
// callers in operator-spawn (WEDGE_AUTO_REAP / SPAWN_HANDOFF_HYDRATION) behave exactly
// as they did under the real getFlag's no-PostHog fallback — behavior-preserving.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(), onFlagChange: vi.fn() }));
vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
// WI-1937: operator-spawn.ts imports isEphemeralForeignProject directly, and
// the module graph ALSO reaches harness-registry.ts transitively (via
// inference-gateway/stall-waker-loop → ... → sync/hyperbee/projections/
// p2p-peer-grants.ts → p2p/revocation-reaper.ts, which imports
// deregisterEphemeralForeignHarness at module scope). Every ephemeral-foreign
// export is stubbed inline (matching real semantics for the pure ones) rather
// than via importOriginal, so this mock doesn't pull in the real
// harness-registry.ts's PG-backed module graph into an otherwise fully
// isolated unit test — and so a FUTURE transitive import of any of these
// doesn't silently reintroduce this same "no export defined on the mock" break.
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(),
  isEphemeralForeignProject: (p: { ephemeral_foreign?: boolean }) => p.ephemeral_foreign === true,
  ephemeralForeignHarnessSlug: (offerId: string) => `foreign-${offerId}`,
  registerEphemeralForeignHarness: vi.fn(),
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
  sweepOrphanedEphemeralForeignHarnesses: vi.fn(async () => ({ swept: 0, removed: [] })),
}));
vi.mock('../agent-config', () => ({ readAgentConfig: vi.fn(async () => null) }));
vi.mock('../owner-steering', () => ({
  getOwnerSteering: vi.fn(async () => h.ownerSteering.value ?? {
    directive: null,
    eligiblePlans: [],
    eligibleHives: [],
    pauseNewWork: false,
    pausedUntil: null,
    modelTiers: null,
    tierCeilings: null,
    modelOverrides: null,
  }),
  effectiveMaxBees: vi.fn((_steering: unknown, base: number) => base),
}));
vi.mock('../pot/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));
vi.mock('../dbos/orchestrator-runner', () => ({
  spawnInvokeOnceWithFallback: vi.fn(),
  // EI-361: operator-spawn.ts reads this for the timeout-kill errorMessage fallback
  // when the spawn didn't override timeoutMs — mirror the real default (45min).
  invokeTimeoutMs: vi.fn(() => 2_700_000),
}));
vi.mock('./supervision', () => ({ superviseCrash: vi.fn() }));
vi.mock('./spawn-tree', () => ({
  recordSpawn: vi.fn(),
  finishSpawn: vi.fn(),
  // Keep the mock contract aligned with spawn-tree's account-route exports.
  // Transitive launch paths can load this mock even when these tests exercise
  // only the legacy record/finish calls.
  recordSpawnAccountRoute: vi.fn(async () => {}),
  spawnAccountRouteFromLaunch: vi.fn(() => null),
}));
vi.mock('../inference-gateway/spawn-env', () => ({ resolveSpawnGatewayEnv: vi.fn(async () => ({})) }));
vi.mock('../background-workers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../background-workers')>()),
  backgroundWorkersEnabled: vi.fn(() => h.backgroundWorkers.enabled),
}));
vi.mock('../inference-gateway/stall-waker-loop', () => ({
  ensureStallWakerLoop: vi.fn(),
}));
// Per-hive override resolver (P-012/P-013) is a PG-backed spawn dep like its siblings —
// mock it to a no-op so the unit tests don't touch PG. vi.mock intercepts the dynamic
// import operator-spawn uses, so the BLUEPRINT_LOCAL_ROOT producer is a clean no-op here.
vi.mock('../hive-local-blueprint-resolve', () => ({
  resolveHiveLocalBlueprintRoot: vi.fn(async () => null),
  blueprintLocalRootExtra: (root: string | null) => (root ? `BLUEPRINT_LOCAL_ROOT=${root}` : null),
}));
vi.mock('../rate-limit-config', () => ({
  getCachedRateLimitConfig: () => h.rateLimit.value,
}));
// P-009 (WI-586538): only effectiveConcurrencySnapshot is overridden — the rest of the
// shared agent surface stays REAL, since operator-spawn's import graph reaches it.
vi.mock('@papercusp/papercusp-shared/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/papercusp-shared/agent')>()),
  effectiveConcurrencySnapshot: () => ({
    effective: null,
    floor: 1,
    cleanStreak: 0,
    effectiveAfterExpiry: h.governorWindow.value,
    peak: 0,
    contractedAt: null,
    constraintExpired: false,
  }),
}));
vi.mock('./spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(async () => {}),
  reclaimOrphanedSpawns: vi.fn(async () => ({ reclaimed: 0, spawnIds: [], workspaces: [] })),
  recordSpawnPid: vi.fn(async () => {}),
  spawnResultArtifactPath: (projectDir: string, spawnId: string) =>
    `${projectDir}/.papercusp/spawn-results/${spawnId}.log`,
  removeSpawnResultArtifact: vi.fn(() => {}),
  SPAWN_HEARTBEAT_INTERVAL_MS: 60_000,
  // operator-spawn re-exports this from spawn-reclaim (threshold centralised there);
  // selectWedgeReapCandidates uses it as a default param, so the mock must expose it.
  WEDGE_REAP_SILENT_MS: 30 * 60_000,
}));
// Lazy-imported by the slot-freed announce (D-004) — vi.mock intercepts the
// dynamic import too, so the spy sees every emit.
vi.mock('../events/await/engine', () => ({
  emitAwaitedEvent: vi.fn(async () => ({ ok: true, key: '', woken: 0, notified: [], msgId: null })),
}));
// EI-6476: releaseSpawnWorkItemClaim now delegates to the unified releaseWorkItem
// (correctly dispatches feature vs issue family) instead of hand-rolling a
// features-only UPDATE — mock it here so the timeout/never-started-child test
// below asserts the call directly rather than needing a full work-items.ts
// PG-backed read (getWorkItem) to succeed against this file's minimal sql fake.
vi.mock('../work-items', () => ({ releaseWorkItem: vi.fn(async () => null) }));
// getSpawnHeadroom lazy-imports this for the host-saturation shed (EI-73);
// vi.mock intercepts the dynamic import too (same pattern as
// '../events/await/engine' above). Default: no capture → 'unknown' verdict
// (fail-soft, matches the real no-PostHog/no-capture fallback).
vi.mock('../system-health/perf-budgets', () => ({
  readLatestPerfSignals: vi.fn(async () => null),
  evaluatePerfSignals: vi.fn(() => ({ status: 'unknown', reasons: [] })),
}));

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveProject } from '../harness-core';
import { loadHarnessRegistry } from '../harness-registry';
import { spawnInvokeOnceWithFallback } from '../dbos/orchestrator-runner';
import { resolveSpawnGatewayEnv } from '../inference-gateway/spawn-env';
import { backgroundWorkersEnabled } from '../background-workers';
import { ensureStallWakerLoop } from '../inference-gateway/stall-waker-loop';
import { emitAwaitedEvent } from '../events/await/engine';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { superviseCrash } from './supervision';
import { reclaimOrphanedSpawns, recordSpawnPid, removeSpawnResultArtifact } from './spawn-reclaim';
import { releaseWorkItem } from '../work-items';
import { evaluatePerfSignals } from '../system-health/perf-budgets';
import {
  spawnAgentInHarness,
  abortLocalSpawn,
  spawnConcurrencyCeiling,
  spawnSlotEventKey,
  findBriefPlaceholder,
  selectWedgeReapCandidates,
  WEDGE_REAP_SILENT_MS,
  applyHostSaturationShed,
  getSpawnHeadroom,
} from './operator-spawn';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { mockOrgPgSql } from '../testing/mock-org-pg';

// `/tmp` exists on disk, so the project-dir existence check passes without fixtures.
const PROJECT = { slug: 'demo', path: '/tmp', hasState: true, hasSpec: false };

let runningCount = 0;
let dupRows: Array<{ spawn_id: string }> = [];
let errorSpy: ReturnType<typeof vi.spyOn>;
let savedXbenchDirective: string | undefined;
let savedXbenchDirectiveLegacy: string | undefined;
let savedSpawnReadinessShadow: string | undefined;

beforeEach(() => {
  // Hermeticity (EI-1837): the external-bench launcher exports
  // PAPERCUSP_XBENCH_CUP_DIRECTIVE (dual-accept legacy: PAPERCUSP_XBENCH_BEE_DIRECTIVE) on the
  // shared env both the launcher and the :3170 host read; when present, operator-spawn appends
  // it to a `cup` brief (intentional, bench-scoped). These unit tests assert the PRODUCTION
  // contract (the brief passed through verbatim), so neutralize both var names for the suite
  // and restore them after — otherwise the suite reddens whenever it runs under the bench.
  savedXbenchDirective = process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  savedXbenchDirectiveLegacy = process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  savedSpawnReadinessShadow = process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  delete process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  delete process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  // The readiness probe is intentionally shadow-only in production and emits
  // console.warn when the local gateway has no serviceable account. This suite
  // tests spawn semantics, not that inert telemetry, and vitest fails on any
  // unexpected console output; keep the test hermetic while preserving the
  // production default.
  process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = '0';
  runningCount = 0;
  dupRows = [];
  h.ownerSteering.value = null;
  h.backgroundWorkers.enabled = false;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // One template-tag fn answers every query by shape; `begin` (the atomic
  // admission tx, P-017/P-039) hands the same tag back as the tx.
  const tag = vi.fn(async (strings: TemplateStringsArray | string) => {
    const q = Array.isArray(strings) ? strings.join('') : String(strings);
    if (q.includes('SELECT spawn_id')) return dupRows; // idempotency dedupe probe
    if (q.includes('count(*)')) return [{ n: String(runningCount) }];
    return [];
  });
  const sql = Object.assign(tag, {
    begin: async (cb: (tx: unknown) => Promise<unknown>) => cb(tag),
    // recordDecisionDisposition (now reached on the spawn path) does a
    // `tx.unsafe(INSERT ... RETURNING id, [params])`; without it the catch
    // logged "[decision-ledger] disposition insert failed: tx.unsafe is not a
    // function", which vitest-fail-on-console reddened. Complete the fake sql
    // interface — an empty result is fine (the disposition write is
    // fire-and-forget and the tests don't assert on it).
    unsafe: async (_q: string, _params?: unknown[]) => [] as unknown[],
  });
  mockOrgPgSql(vi.mocked(getOrgPg), sql);
  vi.mocked(resolveProject).mockResolvedValue(PROJECT);
  vi.mocked(loadHarnessRegistry).mockResolvedValue({ projects: [PROJECT] });
  vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: 'done!', exitCode: 0, stderr: '' });
  vi.mocked(resolveSpawnGatewayEnv).mockResolvedValue({});
  vi.mocked(recordSpawn).mockResolvedValue(undefined);
  vi.mocked(finishSpawn).mockResolvedValue(undefined);
  vi.mocked(superviseCrash).mockResolvedValue({
    spawnId: 'test-spawn',
    action: 'noop',
    intensity: null,
    strategy: 'one_for_one',
    toRestart: [],
    reason: 'spawn not found',
    relaunches: [],
  });
  // Default getFlag → each flag's real default (no PostHog), matching the prior
  // real-getFlag fallback. Overwatch defaults OFF, so the gate rejects it unless a
  // test overrides this. Other callers (WEDGE_AUTO_REAP/SPAWN_HANDOFF_HYDRATION) keep
  // their default-true behavior.
  //
  // ⚠ THIS MOCK USED TO FORCE `papercusp-mug-kettle-system` ON so the fixtures below
  // could spawn role="cup"/"kettle" past the retirement gate. P-068 DELETED that flag,
  // so the override became unsatisfiable BY CONSTRUCTION — `mugKettleSystemEnabled()`
  // no longer reads getFlag at all, and no mock can re-open the tier. The fixtures now
  // use FIXTURE_ROLE (below) instead; do not reintroduce a tier role here expecting it
  // to spawn.
  vi.mocked(getFlag).mockImplementation(
    async (key: string) => FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false,
  );
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
  if (savedXbenchDirective === undefined) delete process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE;
  else process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE = savedXbenchDirective;
  if (savedXbenchDirectiveLegacy === undefined) delete process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE;
  else process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE = savedXbenchDirectiveLegacy;
  if (savedSpawnReadinessShadow === undefined) delete process.env.PAPERCUSP_SPAWN_READINESS_SHADOW;
  else process.env.PAPERCUSP_SPAWN_READINESS_SHADOW = savedSpawnReadinessShadow;
});

/** Let the fire-and-forget completion chain settle. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * The default role for fixtures whose SUBJECT IS NOT THE ROLE — supervisor-pid
 * stamping, stderr/marker handling, timeouts, forced session ids, gateway account
 * routing, harness resolution, idempotency, slot-waits. These used to spawn `cup`
 * as a convenience fixture, which made ~50 unrelated cases collateral damage of
 * P-068's retirement gate (a gated value used as a fixture is invisible until the
 * gate closes).
 *
 * WHY `reviewer` specifically — it is the one role in the mocked AGENT_ROLES that
 * clears EVERY admission gate with no extra context: not `worker` (requires a
 * chunkId), not a FACTORY_PIPELINE_ROLE (`scoper`/`validator` require a pushed
 * FEATURE_ID), not a retired tier role (`cup`/`kettle`), and — unlike `cup` — it
 * carries NO role-conditional behaviour downstream (no owner-bee ceiling, no
 * BLUEPRINT_ID default, no bench-directive pin), so it cannot silently change what
 * these tests measure. Tests that genuinely assert TIER behaviour keep their own
 * literal role and assert the permanent refusal instead.
 */
const FIXTURE_ROLE = 'reviewer';

describe('spawnAgentInHarness — happy path', () => {
  it('resolves the harness, records the nursery row, launches, and finishes done', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'validator',
      featureId: 'F-1',
      parentSpawnId: 'op-turn-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toMatch(/^s-\d+-/);
    expect(res.harness).toBe('demo');
    expect(res.projectDir).toBe('/tmp');

    // Durable record BEFORE the child launches, with lineage + ownership.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const rec = vi.mocked(recordSpawn).mock.calls[0][1];
    expect(rec).toMatchObject({
      workspaceId: 'ws-1',
      harnessSlug: 'demo',
      childRole: 'validator',
      parentSpawnId: 'op-turn-1',
      parentRole: 'operator',
      featureId: 'F-1',
      status: 'running',
    });
    expect(rec.sessionOwner).toBe(rec.spawnId);

    // The child launches in the harness's REAL project dir with the registry
    // slug pinned in env (schema resolution) + the feature extra.
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalledTimes(1);
    const [dir, role, extras, env, opts] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(role).toBe('validator');
    expect(extras).toContain('FEATURE_ID=F-1');
    expect(env.HARNESS_SLUG).toBe('demo');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('ws-1');
    expect(opts?.resultPath).toBe(`/tmp/.papercusp/spawn-results/${res.spawnId}.log`);

    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      outputTail: 'done!',
    }));
  });

  it('stamps the supervisor pid before launch so boot reconcile can own the admission-to-child window', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);

    expect(recordSpawnPid).toHaveBeenCalledWith(expect.anything(), res.spawnId, process.pid);
    expect(vi.mocked(recordSpawn).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordSpawnPid).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(recordSpawnPid).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(spawnInvokeOnceWithFallback).mock.invocationCallOrder[0],
    );
  });

  it('automatically supervises a durable failure after the child has started', async () => {
    vi.mocked(superviseCrash).mockResolvedValue({
      spawnId: 'crashed-spawn',
      action: 'restart',
      intensity: null,
      strategy: 'one_for_one',
      toRestart: ['crashed-spawn'],
      reason: 'restart (one_for_one)',
      relaunches: [],
    });
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _dir: string,
      _role: string,
      _extras: string[],
      _env: Record<string, string>,
      opts?: { onChildPid?: (pid: number) => void },
    ) => {
      opts?.onChildPid?.(1234);
      return Promise.resolve({ output: '', exitCode: 1, stderr: 'child crashed' });
    }));

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();

    expect(superviseCrash).toHaveBeenCalledTimes(1);
    expect(superviseCrash).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: 'ws-1',
      spawnId: res.spawnId,
      actor: {
        ownerId: 'system:operator-spawn-supervision',
        ownerLabel: 'operator spawn supervision',
        source: 'static-client',
        workspaceId: 'ws-1',
        userId: null,
      },
      reason: 'child crashed',
    }));
    expect(vi.mocked(finishSpawn).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(superviseCrash).mock.invocationCallOrder[0]);
  });

  it('automatically supervises a timed-out child after the child has started', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _dir: string,
      _role: string,
      _extras: string[],
      _env: Record<string, string>,
      opts?: { onChildPid?: (pid: number) => void },
    ) => {
      opts?.onChildPid?.(1234);
      return Promise.resolve({ output: '', exitCode: 143, stderr: '', timedOut: true });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();

    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      errorMessage: expect.stringContaining('invoke timeout'),
    }));
    expect(superviseCrash).toHaveBeenCalledTimes(1);
    expect(superviseCrash).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId: 'ws-1',
      spawnId: res.spawnId,
      reason: expect.stringContaining('invoke timeout'),
    }));
    expect(vi.mocked(finishSpawn).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(superviseCrash).mock.invocationCallOrder[0]);
  });

  it.each([
    { label: 'successful', childStarted: true, cancelled: false, exitCode: 0, expectedStatus: 'done' },
    { label: 'cancelled', childStarted: true, cancelled: true, exitCode: 1, expectedStatus: 'cancelled' },
    { label: 'pre-start', childStarted: false, cancelled: false, exitCode: 1, expectedStatus: 'failed' },
  ])('does not supervise a $label terminal', async ({ childStarted, cancelled, exitCode, expectedStatus }) => {
    let finishChild!: (result: { output: string; exitCode: number; stderr: string }) => void;
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _dir: string,
      _role: string,
      _extras: string[],
      _env: Record<string, string>,
      opts?: { onChildPid?: (pid: number) => void },
    ) => {
      if (childStarted) opts?.onChildPid?.(1234);
      return new Promise((resolve) => { finishChild = resolve; });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    if (cancelled) expect(abortLocalSpawn(res.spawnId!)).toBe(true);
    finishChild({ output: '', exitCode, stderr: 'terminal detail' });
    await flush();

    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: expectedStatus,
    }));
    expect(superviseCrash).not.toHaveBeenCalled();
  });

  it('times out a spawn that never reaches child pid and releases only its reserved work item claim', async () => {
    vi.useFakeTimers();
    vi.stubEnv('PAPERCUSP_SPAWN_CHILD_START_TIMEOUT_MS', '1000');
    vi.mocked(superviseCrash).mockResolvedValue({
      spawnId: 'timed-out-spawn',
      action: 'restart',
      intensity: null,
      strategy: 'one_for_one',
      toRestart: ['timed-out-spawn'],
      reason: 'restart (one_for_one)',
      relaunches: [],
    });
    let captured: AbortSignal | undefined;
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _d: string,
      _r: string,
      _e: string[],
      _env: Record<string, string>,
      opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise(() => {});
    }) as never);
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: FIXTURE_ROLE,
        featureId: 'WI-1',
      });
      expect(res.ok).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(captured?.aborted).toBe(true);
      expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        spawnId: res.spawnId,
        status: 'failed',
        errorMessage: expect.stringContaining('timed out before child process start'),
      }));

      // EI-6476: the release now goes through the unified releaseWorkItem (which
      // correctly dispatches feature vs issue family) instead of a hand-rolled
      // features-only UPDATE — assert the delegated call directly.
      expect(releaseWorkItem).toHaveBeenCalledWith('WI-1', {
        harness: 'demo',
        expectedAssignee: res.spawnId,
      });
      expect(superviseCrash).toHaveBeenCalledTimes(1);
      expect(superviseCrash).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        workspaceId: 'ws-1',
        spawnId: res.spawnId,
        reason: expect.stringContaining('timed out before child process start'),
      }));
      expect(vi.mocked(releaseWorkItem).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(superviseCrash).mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('EI-6476: a launch that throws before the child ever starts releases the claim too (bug/issue-family item id)', async () => {
    // The exact reported symptom: a fresh spawn reserved onto an ISSUE-family work
    // item (EI-/WI- bug, not a feature) whose launch fails before childStarted —
    // the spawn/claim path must not leave the item claimed by a holder that never
    // went live. `featureId` here is an issue id on purpose — releaseWorkItem
    // (unlike the old hand-rolled features-only UPDATE) dispatches correctly by
    // family, so this same call-site now covers both.
    vi.mocked(spawnInvokeOnceWithFallback).mockRejectedValue(new Error('spawn transport exploded'));
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: FIXTURE_ROLE,
      featureId: 'EI-9',
    });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      errorMessage: 'spawn transport exploded',
    }));
    expect(releaseWorkItem).toHaveBeenCalledWith('EI-9', {
      harness: 'demo',
      expectedAssignee: res.spawnId,
    });
  });

  it('a non-zero child exit finishes the row failed with the stderr tail', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: '', exitCode: 1, stderr: 'boom' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      exitCode: 1,
      errorMessage: 'boom',
    }));
  });

  it('EI-361: a timeout-killed child (empty stderr, timedOut:true) records a self-explaining errorMessage instead of null', async () => {
    // Pre-fix: a SIGTERM'd child almost always exits with EMPTY stderr (it never got
    // a chance to write anything), so `(r.stderr||'')||null` recorded exit 143 with
    // error_message NULL — indistinguishable from an unexplained crash without
    // separately noticing the run lasted exactly the timeout budget.
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: '', exitCode: 143, stderr: '', timedOut: true,
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'failed',
      exitCode: 143,
      errorMessage: expect.stringContaining('invoke timeout'),
    }));
    const call = vi.mocked(finishSpawn).mock.calls.find((c) => c[1]?.spawnId === res.spawnId);
    expect(call?.[1]?.errorMessage).toContain('2700000ms');
  });

  it('EI-361: a timeout-killed child honors the per-spawn timeoutMs override in the errorMessage', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: '', exitCode: 143, stderr: '', timedOut: true,
    });
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, timeoutMs: 120_000,
    });
    expect(res.ok).toBe(true);
    await flush();
    const call = vi.mocked(finishSpawn).mock.calls.find((c) => c[1]?.spawnId === res.spawnId);
    expect(call?.[1]?.errorMessage).toContain('120000ms');
  });

  it('preserves first-turn termination detail instead of reducing it to a generic timeout', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: '', exitCode: 143,
      stderr: 'release-fixer first-turn timeout after 180000ms (no agent stream)',
      timedOut: true,
      rawStdoutTail: 'invoke-once: received termination signal — aborting agent',
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    const call = vi.mocked(finishSpawn).mock.calls.find((c) => c[1]?.spawnId === res.spawnId);
    expect(call?.[1]?.errorMessage).toContain('first-turn timeout after 180000ms');
    expect(call?.[1]?.outputTail).toContain('received termination signal');
  });

  it('an exit-0 child with non-empty stderr persists stderr as errorMessage (WI-111 — session-limit diagnostic)', async () => {
    // Root cause of the 3.5-day archaeology: the session-limit message ("You've hit
    // your session limit") reaches the parent as stderr on an exit-0 process. The old
    // path dropped it (`exitCode === 0 ? null`), leaving error_message blank and the
    // cause invisible in fleet:tree / the Brew tab.
    const sessionMsg = "You've hit your session limit · resets 7:30pm (America/New_York)";
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: '', exitCode: 0, stderr: sessionMsg });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId,
      status: 'done',
      exitCode: 0,
      errorMessage: sessionMsg,
    }));
  });

  // ── WI-36237: the two diagnostic paths that were blinding every spawn ──────
  //
  // MEASURED 2026-08-08 on live harness_shared.spawned_agents cup rows: four
  // failed spawns each carried error_message = "[papercusp:activity]\n" exactly,
  // and a SUCCESSFUL 303s run carried fourteen of the same marker line. The
  // marker is the outer-process activity heartbeat (WI-3302) and has no
  // diagnostic content, so every one of those rows LOOKED like it had a cause
  // recorded and had none.

  it('WI-36237: a marker-only stderr persists as NULL, not as the raw activity marker', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: '', exitCode: 1, stderr: '[papercusp:activity]\n[papercusp:activity]\n',
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    // NULL is the honest record for a silent death, and it is what restores the
    // capacity_shed fingerprint's `stderr === ''` signature for anyone reading
    // the row (invoke-outcome.ts:227).
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'failed', exitCode: 1, errorMessage: null,
    }));
  });

  it('WI-36237: a real diagnostic interleaved with activity markers SURVIVES the strip', async () => {
    // CALIBRATION for the case above: the strip must remove only the marker, not
    // flatten every stderr to null. Without this, a strip that nulled everything
    // would pass the previous test while destroying the diagnostics it exists to
    // uncrowd.
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: '',
      exitCode: 1,
      stderr: '[papercusp:activity]\nEACCES: permission denied\n[papercusp:activity]\n',
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();
    const call = vi.mocked(finishSpawn).mock.calls.find((c) => c[1]?.spawnId === res.spawnId);
    expect(call?.[1]?.errorMessage).toContain('EACCES: permission denied');
    expect(call?.[1]?.errorMessage).not.toContain('[papercusp:activity]');
  });

  it('WI-36237: a SUCCESSFUL spawn no longer records activity markers as an error', async () => {
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({
      output: 'did the thing', exitCode: 0, stderr: '[papercusp:activity]\n[papercusp:activity]\n',
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'done', exitCode: 0, errorMessage: null,
    }));
  });

  it('WI-36237: the invoke-once artifact is RETAINED on a FAILED terminal', async () => {
    // The artifact holds the child's full teed stdout+stderr — the only record
    // that is not a 2000-char tail. Deleting it on failure destroyed the sole
    // diagnostic at the exact moment it became the only one, which presents as
    // "the spawn log is never written".
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: '', exitCode: 1, stderr: '' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    expect(removeSpawnResultArtifact).not.toHaveBeenCalled();
  });

  it('WI-36237: …and is still REMOVED on a successful terminal', async () => {
    // CALIBRATION: proves the assertion above turns on the terminal STATUS and
    // not on the unlink having become unreachable altogether — which would leak
    // an artifact per spawn instead of per failed spawn.
    vi.mocked(spawnInvokeOnceWithFallback).mockResolvedValue({ output: 'ok', exitCode: 0, stderr: '' });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();
    expect(removeSpawnResultArtifact).toHaveBeenCalledWith(
      `/tmp/.papercusp/spawn-results/${res.spawnId}.log`,
    );
  });
});

describe('spawnAgentInHarness — role="kettle" is retired ABOVE the overwatch gate (P-068)', () => {
  // WHAT THIS BLOCK USED TO BE, and why it could not survive P-068: it held the two
  // halves of the overwatch flag gate (overwatch-role-2026-06-15 B-10 / D-009) —
  // "kettle rejected when papercusp-overwatch is OFF" and "kettle admitted when it is
  // ON". BOTH reached that gate only because the old beforeEach forced
  // MUG_KETTLE_SYSTEM ON; `kettle` is ALSO a retired tier role, and the retirement
  // gate sits ABOVE the overwatch gate in spawnAgentInHarness. With the flag deleted
  // the overwatch gate is UNREACHABLE for the only role it governs, so a test
  // asserting either half would be asserting dead code — the flag-ON half could not
  // pass at all, and the flag-OFF half would have gone green for the WRONG REASON
  // (refused by the retirement gate while claiming to measure the overwatch one),
  // which is precisely the failure its own old comment warned about.
  //
  // What replaces them is the property that actually holds now and is worth pinning
  // at this chokepoint: NO flag state re-opens the tier. That is falsifiable — delete
  // the retirement gate and the papercusp-overwatch:ON case below starts passing
  // admission. (The overwatch gate itself is now dead code downstream of a
  // permanently-closed gate; its removal is tracked as follow-up cleanup, not done
  // here, so P-068 stays a flag deletion.)
  it('refuses role="kettle" for RETIREMENT — not overwatch — even with papercusp-overwatch ON', async () => {
    vi.mocked(getFlag).mockImplementation(async (key: string) =>
      key === FLAGS.OVERWATCH ? true : (FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false),
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'kettle' });
    expect(res.ok).toBe(false);
    // The RETIREMENT refusal, not the overwatch one and not unknown-role: kettle IS
    // a registered role, and the gate above overwatch is the one that fires.
    expect(res.error).toContain('RETIRED');
    expect(res.error).not.toContain('papercusp-overwatch');
    expect(res.error).not.toContain('unknown role');
    // refused BEFORE any child process launches
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  // NO alias case here on purpose: `overwatch`/`bee`/`queen` are not in this file's
  // mocked AGENT_ROLES, so a spawn under an alias is refused by the UNKNOWN-ROLE gate
  // before the retirement gate is ever reached — it would pass for the wrong reason.
  // isRetiredTierRole's canonicalization is covered where it can be exercised
  // honestly: ../pot/retired-tier-roles.test.ts.
});

describe('spawnAgentInHarness — coding-factory role needs a pushed FEATURE_ID (coding-hive-bee-vs-coding-factory-scoper-2026-06-23)', () => {
  it('rejects a coding-FACTORY pipeline role with NO pushed-feature context, pointing at an su fleet', async () => {
    // A scoper spawned with no featureId / FEATURE_ID= extra / chunkId is the
    // observed mistake (testing the coding-hive handoff by spawning a scoper +
    // setting claim-specs on it — inert). The guard refuses + names the bee unit.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('coding-FACTORY');
    // Points at the SURVIVING self-pull mechanism. This used to assert `role="cup"`,
    // which P-068 turned into misdirection: the refusal was steering callers toward a
    // role the retirement gate below refuses unconditionally. A rejection message that
    // names a guaranteed-rejected remedy is a dead end, so the assertion moved with it.
    expect(res.error).toContain('fleet:launch-on-plan');
    expect(res.error).not.toContain('role="cup"');
    expect(res.error).not.toContain('unknown role');
    // refused BEFORE any child process launches
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('allows a coding-FACTORY pipeline role WHEN a FEATURE_ID is pushed (the legit factory path)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'scoper',
      featureId: 'F-123',
    });
    await flush();
    // the guard passed → the spawn proceeds (happy-path mocks launch + finish it)
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });

  it('also accepts a FEATURE_ID= extra as pushed-feature context (the spine pushes it via extras)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'scoper',
      extras: ['FEATURE_ID=F-456'],
    });
    await flush();
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });

  it('a NON-factory role with no feature context is unaffected by the factory guard', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();
    expect(res.ok).toBe(true);
    expect(res.error).toBeFalsy();
    expect(spawnInvokeOnceWithFallback).toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — forced session id for claude bees (P-016 / D-007)', () => {
  const findUpdate = () => {
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    return sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SET session_id ='),
    );
  };

  it('mints + records a session_id and threads forceSessionId for a claude backend', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    try {
      // cup's committed floor is the claude-family `sonnet[1m]:high` (WI-4623 revert);
      // the explicit `modelSpec: 'sonnet'` pins the claude family deterministically so
      // this test exercises the CLAUDE-specific forced-session-id path (P-016/D-007)
      // regardless of the role's default.
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, modelSpec: 'sonnet' });
      expect(res.ok).toBe(true);

      // forceSessionId (a uuid) is threaded to the launcher so buildInvokeOnce bakes --session-id.
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toMatch(/[0-9a-f-]{36}/);

      // ...and recorded on the nursery row via the best-effort UPDATE — same id.
      const updateCall = findUpdate();
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).toBe(opts?.forceSessionId);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('mints NO session id for the omp backend (omp resumes by thread id)', async () => {
    // Force the omp backend explicitly — resolveSpawnBackendModel reads the AMBIENT
    // AGENT_CMD, which on any real agent box is `claude …` (the box runs claude bees),
    // so relying on the unset-env default would mint a uuid and fail in the gate.
    vi.stubEnv('AGENT_CMD', 'omp -p');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
      expect(res.ok).toBe(true);
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toBeUndefined();
      expect(findUpdate()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('mints NO session id for the codex backend (codex resumes by CODEX_HOME rollout)', async () => {
    vi.stubEnv('AGENT_CMD', 'codex exec --model gpt-5.6-sol');
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
      expect(res.ok).toBe(true);
      const opts = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0][4] as { forceSessionId?: string } | undefined;
      expect(opts?.forceSessionId).toBeUndefined();
      expect(findUpdate()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('spawnAgentInHarness — backend-aware gateway account routing', () => {
  it('rejects an unavailable explicit route before durable admission or child launch', async () => {
    vi.mocked(resolveSpawnGatewayEnv).mockRejectedValueOnce(
      new Error("account route 'auto' requires the inference gateway, but it is off; refusing fallback"),
    );
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: FIXTURE_ROLE,
      accountOverride: 'auto',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/spawn rejected.*refusing fallback/i);
    // The rejection is ledgered as an immediately-terminal failed attempt, not
    // admitted as a live/running nursery slot.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }));
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('applies owner steering to an unpinned spawn instead of falling back to the host Claude command', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    h.ownerSteering.value = {
      modelTiers: [
        { name: 'quick', spec: 'chatgpt:5.5', backend: 'codex' },
        { name: 'standard', spec: 'chatgpt:5.5', backend: 'codex' },
      ],
      // Keyed by ROLE — must name the role this case actually spawns, or the ceiling
      // lookup misses and no steering is applied (which is how this read as a pass
      // for `cup` and would silently under-assert for anything else).
      tierCeilings: { [FIXTURE_ROLE]: 'quick' },
      modelOverrides: null,
    };
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: FIXTURE_ROLE,
      });
      expect(res.ok).toBe(true);
      const [, , , env, opts] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_SPAWN_MODEL).toBe('chatgpt:5.5');
      expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
      expect((opts as { forceSessionId?: string } | undefined)?.forceSessionId).toBeUndefined();
      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'codex',
        role: FIXTURE_ROLE,
        ownerId: res.spawnId,
      }));
      expect(recordSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        modelSpec: 'chatgpt:5.5',
        modelTier: 'quick',
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('forces Codex backend for a chatgpt:* per-spawn model even when the host command is Claude', async () => {
    vi.stubEnv('AGENT_CMD', 'claude -p');
    try {
      const res = await spawnAgentInHarness({
        workspaceId: 'ws-1',
        harness: 'demo',
        role: FIXTURE_ROLE,
        modelSpec: 'chatgpt:5.5',
      });
      expect(res.ok).toBe(true);
      const [, , , env, opts] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_SPAWN_MODEL).toBe('chatgpt:5.5');
      expect(env.PAPERCUSP_SPAWN_BACKEND).toBe('codex');
      expect((opts as { forceSessionId?: string } | undefined)?.forceSessionId).toBeUndefined();
      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'codex',
        ownerId: res.spawnId,
      }));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('passes the resolved Codex backend to the shared gateway env helper and carries only the returned Codex account id', async () => {
    vi.stubEnv('AGENT_CMD', 'codex exec --model gpt-5.6-sol');
    vi.mocked(resolveSpawnGatewayEnv).mockResolvedValue({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    try {
      const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
      expect(res.ok).toBe(true);

      expect(resolveSpawnGatewayEnv).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1',
        slug: 'demo',
        ownerId: res.spawnId,
        backend: 'codex',
      }));
      const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
      expect(env.PAPERCUSP_ACCOUNT_ID).toBe('codex-main');
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('spawnAgentInHarness — stall-waker process ownership', () => {
  beforeEach(() => {
    vi.mocked(getFlag).mockImplementation(async (key: string) =>
      key === FLAGS.INFERENCE_GATEWAY
        ? true
        : FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS] ?? false,
    );
  });

  it('does not start the poll loop from a request-only spawn process', async () => {
    h.backgroundWorkers.enabled = false;

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });

    expect(res.ok).toBe(true);
    expect(backgroundWorkersEnabled).toHaveBeenCalledTimes(1);
    expect(ensureStallWakerLoop).not.toHaveBeenCalled();
  });

  it('allows the background-worker spawn fallback to start the poll loop', async () => {
    h.backgroundWorkers.enabled = true;

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });

    expect(res.ok).toBe(true);
    expect(backgroundWorkersEnabled).toHaveBeenCalledTimes(1);
    expect(ensureStallWakerLoop).toHaveBeenCalledTimes(1);
    expect(ensureStallWakerLoop).toHaveBeenCalledWith('ws-1');
  });
});

describe('abortLocalSpawn — fleet:cancel actually stops the child (EI-40)', () => {
  it('passes an AbortSignal to spawnInvokeOnceWithFallback and abortLocalSpawn fires it', async () => {
    // Hold the child open so the spawn stays "live" (registered in the abort map)
    // until we abort it. Capture the signal handed to spawnInvokeOnceWithFallback.
    let captured: AbortSignal | undefined;
    let resolveChild: (v: { output: string; exitCode: number; stderr: string }) => void;
    vi.mocked(spawnInvokeOnceWithFallback).mockImplementation(((
      _d: string, _r: string, _e: string[], _env: Record<string, string>, opts?: { signal?: AbortSignal },
    ) => {
      captured = opts?.signal;
      return new Promise((res) => { resolveChild = res; });
    }) as never);

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured!.aborted).toBe(false);

    // The live spawn is locally tracked → abortLocalSpawn finds + signals it.
    expect(abortLocalSpawn(res.spawnId!)).toBe(true);
    expect(captured!.aborted).toBe(true);

    // Let the (now-aborted) child settle so the finally-cleanup runs.
    resolveChild!({ output: '', exitCode: 1, stderr: 'aborted (fleet:cancel)' });
    await flush();

    // The completion records 'cancelled' (abort was the cause), and the handle is
    // removed from the registry → a second abort is a no-op.
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'cancelled',
    }));
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('abortLocalSpawn returns false for an unknown / already-finished spawn', async () => {
    expect(abortLocalSpawn('s-nonexistent')).toBe(false);
    // A spawn that finished normally is de-registered → not abortable.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
  });

  it('de-registers the local spawn handle even when the durable finishSpawn write throws (EI-7235)', async () => {
    // Regression: a rejected finishSpawn (transient DB error) used to leave
    // this spawn's entry in localSpawnAborts/localSpawnOutput forever, because
    // the cleanup ran AFTER the (now-throwing) await and terminalRecorded's
    // early-return guard silently no-oped every later retry. Since the
    // heartbeat loop re-heartbeats every id still in the map with no per-id
    // liveness check, the row's heartbeat_at would stay "falsely fresh"
    // forever — invisible to reclaimOrphanedSpawns's stale-heartbeat query.
    // The fix clears local bookkeeping in a `finally`, independent of whether
    // the durable write succeeded — asserted here via abortLocalSpawn flipping
    // to false (the existing de-registration proxy) despite the rejection.
    vi.mocked(finishSpawn).mockRejectedValueOnce(new Error('ECONNRESET: pg pool exhausted'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    await flush();

    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      spawnId: res.spawnId, status: 'done',
    }));
    // Cleared despite the throw — no lingering entry to keep heartbeating.
    expect(abortLocalSpawn(res.spawnId!)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('completeSpawn durable-write failed'),
      expect.anything(),
    );
  });
});

describe('spawnAgentInHarness — harness resolution', () => {
  it('defaults to the single registered harness when none is named', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe('demo');
  });

  it('rejects when no harness is named and several are registered', async () => {
    vi.mocked(loadHarnessRegistry).mockResolvedValue({
      projects: [PROJECT, { ...PROJECT, slug: 'other' }],
    } as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2 are registered');
    expect(res.error).toContain('demo');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('rejects an unregistered harness, naming the registered ones, and records the failed attempt', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'nope', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"nope" is not a registered project');
    expect(res.error).toContain('demo');
    // The rejection is DURABLE — a failed nursery row, not a dropped warn.
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('nope'),
    }));
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — SU MCP slug remap (EI-429)', () => {
  // The Queen sometimes passes its SU MCP server slug ("<project>-su", or the
  // legacy "papercusp-su") as a spawn target instead of the registered project,
  // so every such spawn was rejected — burning Queen turns (a whole turn fired 5
  // bad-slug spawns). The central chokepoint deterministically remaps a KNOWN -su
  // MCP slug to its project (strip the "-su" suffix; alias the legacy
  // "papercusp-su" → the dogfood project "papercup") — never a silent normalize of
  // an arbitrary wrong slug — so the spawn proceeds against the real project.
  const PAPERCUP = { slug: 'papercup', path: '/tmp', hasState: true, hasSpec: false };
  // null for the -su MCP slug, the real project for the stripped base.
  const onlyResolves = (base: string) =>
    vi.mocked(resolveProject).mockImplementation(
      (async (s: string) => (s === base ? PAPERCUP : null)) as never,
    );

  it('remaps the "<project>-su" MCP slug to its project and spawns against it', async () => {
    onlyResolves('papercup');
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercup-su', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    // the nursery row + child env carry the REMAPPED project slug, not the -su MCP slug
    expect(res.harness).toBe('papercup');
    expect(vi.mocked(recordSpawn).mock.calls[0][1]).toMatchObject({ harnessSlug: 'papercup' });
    const [dir, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(dir).toBe('/tmp');
    expect(env.HARNESS_SLUG).toBe('papercup');
  });

  it('aliases the legacy "papercusp-su" slug to the operator-home project', async () => {
    // The legacy "papercusp-su" MCP slug remaps to the operator-home project —
    // operatorHomeHarnessSlug() (PAPERCUSP_POT_HOME_SLUG, else the migrated
    // legacy default, post papercup→papercusp migration). Derive `home` from the
    // SAME source of truth the production remap uses, so this stays hermetic under
    // the gate's PAPERCUSP_*-stripped env (and under any host-configured pointer).
    const home = operatorHomeHarnessSlug();
    const HOME_PROJECT = { slug: home, path: '/tmp', hasState: true, hasSpec: false };
    vi.mocked(resolveProject).mockImplementation(
      (async (s: string) => (s === home ? HOME_PROJECT : null)) as never,
    );
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'papercusp-su', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    expect(res.harness).toBe(home);
  });

  it('does NOT silently normalize an arbitrary wrong slug — a non -su typo still rejects', async () => {
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'paprcup', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"paprcup" is not a registered project');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('rejects a "<base>-su" slug whose stripped base is also unregistered (remap only when the project exists)', async () => {
    // foo-su strips to foo, which is not a project → no remap, normal rejection.
    vi.mocked(resolveProject).mockResolvedValue(null as never);
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'foo-su', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('"foo-su" is not a registered project');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

describe('spawnAgentInHarness — role + cap validation', () => {
  it('rejects an unknown role before touching the registry', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'wizard' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown role "wizard"');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('accepts a plugin-namespaced role (contains a colon)', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'myplugin:gardener' });
    expect(res.ok).toBe(true);
  });

  it('rejects worker without a chunk', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'worker' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('requires a chunk');
  });

  it('accepts worker with a chunk and passes CHUNK_ID through', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: 'worker', chunkId: 'F-1.c2',
    });
    expect(res.ok).toBe(true);
    const [, , extras] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(extras).toContain('CHUNK_ID=F-1.c2');
  });

  it('REFUSES the retired `cup` role permanently — no chunk, no flag, no way back in', async () => {
    // INVERTED BY P-068. This case used to be "accepts the generic `cup` role WITHOUT
    // a chunk (no pipeline guard — local-hive P-011)": the flip-to-real-path criterion
    // for cup:spawn. The tier is now retired and the escape-hatch flag is deleted, so
    // the SAME call must be refused — and refused for the retirement, not for a
    // missing chunk (which is `worker`'s guard and would be a different bug).
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('RETIRED');
    expect(res.error).not.toContain('requires a chunk');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('accepts a non-pipeline role WITHOUT a chunk (the guard is `worker`-scoped, not universal)', async () => {
    // The surviving half of the case above: chunk-coupling is specific to `worker`,
    // so a role outside the factory pipeline still passes admission with no chunkId.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    const [, role] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(role).toBe(FIXTURE_ROLE);
  });

  it('admits papercup-deep through the real role and retirement gates at the deep tier', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1',
      harness: 'demo',
      role: 'papercup-deep',
      tier: 'deep',
      featureId: 'WI-301',
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    const [, role] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(role).toBe('papercup-deep');
  });

  it('threads the Queen brief into the child env as MUG_BRIEF (P-060 — the real delivery channel, not `extras`)', async () => {
    // P-060: the brief reaches the bee via extraEnv.MUG_BRIEF (which buildInvokeOnce
    // sets on the child env, and invoke-once's buildPrompt renders as `## Queen brief`),
    // NOT as a generic `extras` positional. Assert the real channel.
    const brief = 'watch for the migration race; this connects to bee-2; priority: unblock CI';
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, brief,
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.MUG_BRIEF).toBe(brief);
  });

  it('threads the operator `s-…` spawnId into the child env as PAPERCUSP_SPAWN_ID (THE UMBILICAL — bee coord identity)', async () => {
    // The voice-gap fix: the durable s-… spawnId is the child's stable coord owner.
    // It rides extraEnv.PAPERCUSP_SPAWN_ID so invoke()/spawn-mcp bakes it as the signed
    // MCP URL's client= param → resolveAgentIdentity attributes the bee's coord writes
    // to it instead of throwing "no attributable identity".
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_ID).toBe(res.spawnId);
    expect(env.PAPERCUSP_SPAWN_ID).toMatch(/^s-\d+-/);
  });

  it('EI-13668: stamps extraEnv.PAPERCUSP_AGENT_ROLE with the role so the child\'s own presence writes report it correctly', async () => {
    // Mirrors the harness-spawn-routes.integration.test.ts assertion for the OTHER
    // spawn chokepoint. Without this env stamp, deriveAgentRole (identity.ts) falls
    // back to the generic identity.source→role mapping ('cup') on every presence
    // write the child's OWN session makes after its one-shot spawn-time seed, so
    // `@role:<x>` addressing (role-slot-live-resolve.ts) never finds a truly-live
    // holder for any role spawned through this chokepoint. `role` reaching this
    // chokepoint is already canonical post pot-rename (the `knownRole` admission
    // gate above only accepts AGENT_ROLES entries, which are canonical ids — the
    // legacy `queen` alias is resolved to `mug` upstream, at the /invoke HTTP
    // route in harness/spawn.ts), so `canonicalCoordRole` here is effectively an
    // identity no-op for every role this test can legally pass — asserted anyway
    // so a future re-introduction of a non-canonical role id at this chokepoint
    // is still caught. (role: 'operator' — this case used to spawn 'kettle' as its
    // fixture, which P-068's retirement gate now refuses; 'operator' is the same class
    // of workspace-singleton, non-pipeline role and exercises the identical code path.)
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'operator' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_AGENT_ROLE).toBe('operator');
  });

  it('EI-13668: a different role is stamped as itself, not a stale/hardcoded value', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_AGENT_ROLE).toBe(FIXTURE_ROLE);
  });

  it('rejects when the workspace is at the running-spawn ceiling', async () => {
    const ceiling = spawnConcurrencyCeiling();
    runningCount = ceiling;
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    expect(res.error).toContain(`ceiling ${ceiling}`);
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });
});

/**
 * BENCH-SCOPED, FAIL-CLOSED OPUS PIN (P-033 Fix 2). Only a bench bee (the bench flag
 * PAPERCUSP_XBENCH_CUP_DIRECTIVE set) gets pinned to opus PER-SPAWN via
 * extraEnv.PAPERCUSP_SPAWN_MODEL — so the opus requirement is bench-scoped (a normal
 * hive bee keeps its committed haiku floor; no GLOBAL AGENT_MODELS opus needed). The
 * pin is the highest-precedence model channel buildInvokeOnce reads, so a paused opus
 * bucket WAITS (fail-closed) and the floor-clamp never downgrades below it.
 */
describe('spawnAgentInHarness — bench-scoped opus pin (P-033 Fix 2)', () => {
  const KEY = 'PAPERCUSP_XBENCH_CUP_DIRECTIVE';
  const MODEL = 'PAPERCUSP_XBENCH_MODEL';
  let savedKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    savedKey = process.env[KEY];
    savedModel = process.env[MODEL];
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedModel === undefined) delete process.env[MODEL]; else process.env[MODEL] = savedModel;
  });

  // ⚠ THE PIN ITSELF IS NOW UNREACHABLE. `benchBeeDirective` in operator-spawn.ts is
  // computed as `role === 'cup' ? … : ''`, and P-068 made every `cup` spawn refuse at
  // the retirement gate — which sits ABOVE the pin. So the three cases that used to
  // live here ("pins a BENCH bee to opus:xhigh", "honors PAPERCUSP_XBENCH_MODEL",
  // "does NOT pin when the bench flag is unset") could only be made green again by
  // asserting the refusal three times over, which measures the gate, not the pin.
  // They are replaced by the one property worth pinning at this chokepoint: the bench
  // env is NOT a back door into the retired tier. Removing the dead pin from
  // operator-spawn.ts is tracked as follow-up cleanup — P-068 stays a flag deletion.
  it('the bench directive env does NOT re-open the retired tier — a bench `cup` is still refused', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'cup' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('RETIRED');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('does NOT pin a non-bee role even under the bench flag (only bench bees are pinned)', async () => {
    process.env[KEY] = 'claim + implement your lone bench feature';
    // A genuine non-bee role (scoper) — carries a featureId so it clears the
    // coding-factory pushed-feature guard while staying a factory pipeline role.
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: 'scoper', featureId: 'F-1' });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.PAPERCUSP_SPAWN_MODEL).toBeUndefined();
  });
});

describe('un-substituted brief placeholder guard (EI-249 — dispatch-pack stampede)', () => {
  describe('findBriefPlaceholder (pure)', () => {
    it('flags the repo `{item}` template token and the historical `brief-NN` placeholder', () => {
      expect(findBriefPlaceholder('Universal schema {item}: single handler')).toBe('{item}');
      expect(findBriefPlaceholder('You are brief-NN — read brief-NN-*.md and execute it')).toBe('brief-NN');
      expect(findBriefPlaceholder('You are Brief-NN')).toBe('Brief-NN'); // case-insensitive
    });

    it('passes a fully-substituted brief, an empty/absent brief, and incidental text', () => {
      expect(findBriefPlaceholder('Universal schema reviews: single handler')).toBeNull();
      expect(findBriefPlaceholder('watch for the migration race; priority: unblock CI')).toBeNull();
      expect(findBriefPlaceholder('')).toBeNull();
      expect(findBriefPlaceholder(null)).toBeNull();
      expect(findBriefPlaceholder(undefined)).toBeNull();
      // tight by design — no false positive on words merely containing the marker letters
      expect(findBriefPlaceholder('debrief the inn-keeper about ANN')).toBeNull();
    });
  });

  it('REFUSES to spawn when the brief still holds a placeholder — durable, no child launched', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE,
      brief: 'You are brief-NN — read brief-NN-*.md and execute it',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "brief-NN"');
    expect(res.error).toContain('EI-249');
    // refused BEFORE any child process launches — no claim-race stampede
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
    // the rejection is DURABLE (a failed nursery row), not a silent drop
    expect(finishSpawn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: 'failed',
      errorMessage: expect.stringContaining('un-substituted placeholder'),
    }));
  });

  it('also refuses the `{item}` template token (a caller that bypassed buildWaveFeatures)', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, brief: 'Implement the {item} handler',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('un-substituted placeholder "{item}"');
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('a fully-substituted brief spawns normally — the guard never false-positives', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, brief: 'Implement the reviews handler',
    });
    expect(res.ok).toBe(true);
    const [, , , env] = vi.mocked(spawnInvokeOnceWithFallback).mock.calls[0];
    expect(env.MUG_BRIEF).toBe('Implement the reviews handler');
  });
});

describe('spawnAgentInHarness — idempotency dedupe (P-017 / EI-73)', () => {
  it('a retry with a matched idempotencyKey returns the ORIGINAL spawn, launching nothing', async () => {
    dupRows = [{ spawn_id: 's-original-123' }];
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, idempotencyKey: 'retry-key-1',
    });
    expect(res.ok).toBe(true);
    expect(res.spawnId).toBe('s-original-123');
    expect(res.deduped).toBe(true);
    expect(recordSpawn).not.toHaveBeenCalled();
    expect(spawnInvokeOnceWithFallback).not.toHaveBeenCalled();
  });

  it('an unmatched idempotencyKey spawns normally and stamps the key on the row', async () => {
    const res = await spawnAgentInHarness({
      workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE, idempotencyKey: 'fresh-key',
    });
    expect(res.ok).toBe(true);
    expect(res.deduped).toBeUndefined();
    expect(recordSpawn).toHaveBeenCalledTimes(1);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const stamp = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SET idempotency_key'),
    );
    expect(stamp).toBeDefined();
    expect(stamp![1]).toBe('fresh-key');
  });

  it('a spawn without a key never touches the dedupe probe', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    const sqlMock = vi.mocked(getOrgPg)().sql as unknown as ReturnType<typeof vi.fn>;
    const probe = sqlMock.mock.calls.find(
      (c) => Array.isArray(c[0]) && (c[0] as string[]).join('').includes('SELECT spawn_id'),
    );
    expect(probe).toBeUndefined();
  });
});

describe('over-ceiling slot-wait — queue + await, never a silent drop (D-004)', () => {
  it('an over-ceiling rejection carries the wake key + the events:await instruction', async () => {
    runningCount = spawnConcurrencyCeiling();
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(false);
    // The caller sleeps on this exact key and retries on wake — no drop, no busy-wait.
    expect(res.awaitEvent).toBe(spawnSlotEventKey('ws-1'));
    expect(res.error).toContain(`events:await { event: "${spawnSlotEventKey('ws-1')}" }`);
  });

  it('a finished spawn announces the freed slot on the workspace slot key', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    await flush(); // the announce is a void-chained promise off the finally
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      key: spawnSlotEventKey('ws-1'),
      workspaceId: 'ws-1',
    }));
  });

  it('a reclaim that freed slots announces per freed workspace before the cap check', async () => {
    vi.mocked(reclaimOrphanedSpawns).mockResolvedValue({
      reclaimed: 2, spawnIds: ['s-a', 's-b'], workspaces: ['ws-1', 'ws-2'],
    });
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    await flush();
    const keys = vi.mocked(emitAwaitedEvent).mock.calls.map((c) => c[0].key);
    expect(keys).toContain(spawnSlotEventKey('ws-1'));
    expect(keys).toContain(spawnSlotEventKey('ws-2'));
  });

  it('a successful under-ceiling spawn result carries NO awaitEvent', async () => {
    const res = await spawnAgentInHarness({ workspaceId: 'ws-1', harness: 'demo', role: FIXTURE_ROLE });
    expect(res.ok).toBe(true);
    expect(res.awaitEvent ?? null).toBeNull();
  });
});

/**
 * Gap 13 — selectWedgeReapCandidates (operator-spawn.ts:190-202): the PURE candidate
 * filter for the wedge reaper. A local spawn is a candidate iff it is TRACKED (this
 * host holds its abort handle), NOT already mid-reap (inFlight), has OBSERVED output
 * (at > 0 — absence of signal is never a wedge), and has been stream-silent past the
 * threshold (now - at > silentMs). The four exclusion arms each get a row.
 */
describe('selectWedgeReapCandidates — pure wedge-reaper filter (Gap 13 / P-010)', () => {
  const NOW = 10_000_000_000; // fixed clock
  const silentMs = 30 * 60_000; // 30 min
  const tracked = (...ids: string[]) => new Set(ids);

  it('returns ONLY the silent-old tracked spawn, excluding in-flight / never-output / recent', () => {
    const output = new Map<string, { at: number }>([
      ['silent-old', { at: NOW - silentMs - 1 }],   // tracked, silent past threshold → REAPED
      ['silent-in-flight', { at: NOW - silentMs - 1 }], // silent-old BUT already mid-reap → excluded
      ['never-output', { at: 0 }],                   // at:0 (no observed output) → excluded
      ['recent', { at: NOW - 60_000 }],              // moved 1 min ago, not silent → excluded
    ]);
    const out = selectWedgeReapCandidates(
      output,
      tracked('silent-old', 'silent-in-flight', 'never-output', 'recent'),
      new Set(['silent-in-flight']), // inFlight
      NOW,
      silentMs,
    );
    expect(out).toEqual(['silent-old']);
  });

  it('excludes a spawn this host does NOT track even when its stream is silent-old', () => {
    const output = new Map<string, { at: number }>([['foreign', { at: NOW - silentMs - 1 }]]);
    // tracked set is empty → the host holds no abort handle → not its verdict to make.
    expect(selectWedgeReapCandidates(output, new Set(), new Set(), NOW, silentMs)).toEqual([]);
  });

  it('boundary: exactly-at-threshold is NOT silent enough (strict >), one ms past IS', () => {
    const atThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs }]]);
    expect(selectWedgeReapCandidates(atThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual([]);
    const pastThreshold = new Map<string, { at: number }>([['x', { at: NOW - silentMs - 1 }]]);
    expect(selectWedgeReapCandidates(pastThreshold, tracked('x'), new Set(), NOW, silentMs)).toEqual(['x']);
  });

  it('defaults silentMs to WEDGE_REAP_SILENT_MS when omitted', () => {
    const output = new Map<string, { at: number }>([
      ['old', { at: NOW - WEDGE_REAP_SILENT_MS - 1 }],
      ['fresh', { at: NOW - WEDGE_REAP_SILENT_MS + 60_000 }],
    ]);
    expect(selectWedgeReapCandidates(output, tracked('old', 'fresh'), new Set(), NOW)).toEqual(['old']);
  });
});

/**
 * EI-73 Fix #1 — applyHostSaturationShed (operator-spawn.ts): the PURE host-load
 * shed rule folded into getSpawnHeadroom. Only a definitive `crit` per-thread
 * wedge verdict (PSI/event-loop-lag/reachability — never raw loadavg, which the
 * 128-core-box D-002 reframe already established lies here) sheds headroom to
 * zero; every other verdict tier is a no-op so a missing/stale/unreadable perf
 * capture leaves admission exactly as it was before this fix (fail-soft).
 */
describe('applyHostSaturationShed — pure host-saturation headroom shed (EI-73 Fix #1)', () => {
  it('sheds headroom to zero on a crit verdict (host actively wedged)', () => {
    const out = applyHostSaturationShed(10, { status: 'crit', reasons: ['event-loop lag p95 1500ms ≥ 1000ms'] });
    expect(out).toEqual({ headroom: 0, shed: true, reason: 'host saturation crit — event-loop lag p95 1500ms ≥ 1000ms' });
  });

  it('falls back to a generic reason when crit carries no reasons', () => {
    const out = applyHostSaturationShed(4, { status: 'crit', reasons: [] });
    expect(out.shed).toBe(true);
    expect(out.headroom).toBe(0);
    expect(out.reason).toContain('per-thread wedge signal');
  });

  it('leaves headroom untouched on warn (noisy, non-definitive) — never shed on warn alone', () => {
    expect(applyHostSaturationShed(7, { status: 'warn', reasons: ['worker cpu 220% ≥ 200%'] })).toEqual({
      headroom: 7,
      shed: false,
      reason: null,
    });
  });

  it('leaves headroom untouched on ok', () => {
    expect(applyHostSaturationShed(5, { status: 'ok', reasons: [] })).toEqual({ headroom: 5, shed: false, reason: null });
  });

  it('leaves headroom untouched on unknown (no/stale capture) — fail-soft, count-based only', () => {
    expect(applyHostSaturationShed(3, { status: 'unknown', reasons: [] })).toEqual({ headroom: 3, shed: false, reason: null });
  });

  it('shedding to zero holds even when raw count-based headroom was already zero', () => {
    expect(applyHostSaturationShed(0, { status: 'crit', reasons: ['operator :3070 unreachable'] })).toEqual({
      headroom: 0,
      shed: true,
      reason: 'host saturation crit — operator :3070 unreachable',
    });
  });
});

/**
 * EI-5678: getSpawnHeadroom({ skipHostSaturationShed }) — the interactive
 * safety floor's own doc comment states human-initiated launches WAIVE brain
 * admission and pass only "the absolute concurrency ceiling"; host-saturation
 * shedding (EI-73) is a brain-admission-style throttle that was silently
 * riding along for every caller, including interactive ones. This threading
 * is what lets `interactive-safety-floor.ts` opt out so a refusal there can
 * never be self-contradicting (e.g. "0 agent(s) running ≥ ceiling 8" caused
 * by a host-saturation shed the message never mentioned).
 */
describe('getSpawnHeadroom({ skipHostSaturationShed }) — EI-5678', () => {
  beforeEach(() => {
    runningCount = 0;
    vi.mocked(evaluatePerfSignals).mockReturnValue({ status: 'crit', reasons: ['event-loop lag p95 1500ms ≥ 1000ms'] } as never);
  });

  it('default (opts omitted): a crit host-saturation verdict sheds headroom to zero', async () => {
    const out = await getSpawnHeadroom('ws-test');
    expect(out.headroom).toBe(0);
    expect(out.hostSaturated).toBe(true);
    expect(out.hostSaturationReason).toContain('event-loop lag');
  });

  it('skipHostSaturationShed:true: the same crit verdict is IGNORED — headroom is count-based only', async () => {
    const out = await getSpawnHeadroom('ws-test', { skipHostSaturationShed: true });
    expect(out.hostSaturated).toBeUndefined();
    expect(out.hostSaturationReason).toBeUndefined();
    // no running agents (runningCount=0) against the default ceiling → full headroom, not shed
    expect(out.headroom).toBeGreaterThan(0);
  });

  it('skipHostSaturationShed:true never even reads the perf-signals capture', async () => {
    vi.mocked(evaluatePerfSignals).mockClear();
    await getSpawnHeadroom('ws-test', { skipHostSaturationShed: true });
    expect(evaluatePerfSignals).not.toHaveBeenCalled();
  });
});

/**
 * P-009 / WI-586538 — spawnConcurrencyCeiling honours `maxSimultaneousAgentsSource`.
 *
 * Found by INDEPENDENT ACCEPTANCE GRADING of capless-adaptive-resource-governor-2026-08-26
 * (criterion `no-artificial-ceiling`). `applyCached` already honoured the seed/user split at
 * the governor's GLOBAL gate, but this — the second, independent count ceiling that
 * getSpawnHeadroom/effectiveSpawnCeiling enforce — read the raw number unconditionally, so a
 * seed-sourced host-profile guess silently became a spawn MAXIMUM.
 *
 * FALSIFIABILITY: the middle test is the load-bearing one. Against the pre-fix implementation
 * (`return getCachedRateLimitConfig().maxSimultaneousAgents`) it returns the frozen seed 16
 * instead of the governor's live 40 and FAILS. The other two pin the behaviour that must NOT
 * regress while fixing it: a real user throttle still caps hard, and the pre-init fallback is
 * never unbounded.
 */
describe('spawnConcurrencyCeiling — P-009 seed-vs-user (WI-586538)', () => {
  const DEFAULT_CFG = { maxSimultaneousAgents: 16, concurrencyFloor: 1 };
  afterEach(() => {
    h.rateLimit.value = { ...DEFAULT_CFG };
    h.governorWindow.value = null;
  });

  it("source 'user': an explicit throttle STILL installs a hard cap, ignoring the governor window", () => {
    h.rateLimit.value = { maxSimultaneousAgents: 25, concurrencyFloor: 1, maxSimultaneousAgentsSource: 'user' };
    h.governorWindow.value = 40;
    // D-002 forbids *Papercusp* configuring a maximum; the owner setting one is real intent.
    expect(spawnConcurrencyCeiling()).toBe(25);
  });

  it("source 'seed': tracks the governor's LIVE window, so capacity grows PAST the host guess", () => {
    h.rateLimit.value = { maxSimultaneousAgents: 16, concurrencyFloor: 1, maxSimultaneousAgentsSource: 'seed' };
    h.governorWindow.value = 40;
    expect(spawnConcurrencyCeiling()).toBe(40);
  });

  it('absent source is read as seed, and with NO finite window falls back to the seed — never unbounded', () => {
    h.rateLimit.value = { ...DEFAULT_CFG }; // no source field at all (pre-init default shape)
    h.governorWindow.value = null;
    const ceiling = spawnConcurrencyCeiling();
    expect(ceiling).toBe(16);
    expect(Number.isFinite(ceiling)).toBe(true);
  });
});
