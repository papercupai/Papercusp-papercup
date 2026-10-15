/**
 * deploy-cli.ts `main()` — the gate's exit-code CHOKEPOINT.
 *
 * The shipped suite covers `gatherPlan` (deploy-gate.test.ts transcribes the
 * refusal predicate inline) but never drove the CLI's OWN exit code. This file
 * does: it injects the gather/deps/execute seams so `main()` runs end-to-end
 * with NO git, drain, restart, or real deploy, and asserts the three branches
 * the chokepoint guarantees:
 *
 *   - a non-green target with no --force → exit 2, and `executeDeploy` is NEVER
 *     called (the refusal happens BEFORE any real-effect dep is touched);
 *   - a green non-noop target → proceeds (executeDeploy runs), exit 0;
 *   - `--deploy-commit <sha>` → forces past the green gate AND emits the loud
 *     un-green audit broadcast before executing.
 */
import { describe, it, expect, vi } from 'vitest';
import { main } from './deploy-cli';
import { releaseConfig, type ReleaseConfig } from './release-config';
import type { DeployDeps, DeployPlan, DeployResult, ExecuteOpts } from './deploy';

const cfg = releaseConfig({ integrationRoot: '/tmp/int', releaseRoot: '/tmp/rel', releaseRef: 'ready' });

// Typed function shapes so the vi.fn mocks expose correctly-typed `.mock.calls`
// tuples (an untyped impl narrows the call-args to `[]`).
type GatherFn = (cfg: ReleaseConfig, opts: { target?: string; force?: boolean }) => Promise<DeployPlan>;
type ExecuteFn = (cfg: ReleaseConfig, plan: DeployPlan, deps: DeployDeps, opts: ExecuteOpts) => Promise<DeployResult>;
type BroadcastFn = (summary: string, body?: string) => Promise<void>;

/** A DeployPlan with the fields `main()` reads, overridable per test. */
function makePlan(over: Partial<DeployPlan> = {}): DeployPlan {
  return {
    target: 'ready',
    targetSha: 'a'.repeat(40),
    currentReleaseSha: 'b'.repeat(40),
    isFastForward: true,
    green: true,
    forced: false,
    commits: ['c1', 'c2'],
    commitShas: ['a'.repeat(40), 'c'.repeat(40)],
    migrations: [],
    warnings: [],
    noop: false,
    servingSha: null,
    servingReachable: false,
    restartOnly: false,
    desktopOnly: false,
    risk: { tier: 'auto', autoDeployable: true, reasons: [], blocked: [] },
    ...over,
  };
}

/** A DeployDeps stub — only `broadcast` is exercised by `main()` directly. */
function makeStubDeps(over: Partial<DeployDeps> = {}): DeployDeps {
  return {
    withDrain: async (fn) => fn(),
    // null is a valid RoutineInfo read ("routine not found") and keeps this stub
    // robust to RoutineInfo widening — main() never reads it (executeDeploy is
    // stubbed), so the value is inert here.
    readReleaseTriggerControl: async () => null,
    readLiveReleaseCertification: async (targetSha) => ({
      status: 'certified', targetSha, certified: true, reason: 'exact source certified',
      bankPath: '/tmp/verdicts.jsonl', evidence: null, invalidLines: 0,
    }),
    snapshot: async () => null,
    runSetup: async () => {},
    bundleHost: async () => {},
    migrate: async () => ({ appliedCount: 0, totalKnown: 0, applied: [], sqlDir: '/tmp' }),
    restart: async () => {},
    health: async () => ({ healthy: true, attempts: 1, elapsedMs: 0 }),
    servingSha: async () => ({ reachable: true, sha: 'abcdef12' }),
    verifyPaths: async () => ({ ok: true, failures: [] }),
    preflight: async () => ({ ok: true }),
    restoreSnapshot: async () => {},
    broadcast: async () => {},
    emitEvent: async () => {}, // WI-2399: injected await-bus emit (main() never reaches it — executeDeploy is stubbed)
    log: () => {},
    ...over,
  };
}

const okResult = (plan: DeployPlan): DeployResult => ({
  ok: true,
  plan,
  steps: [],
  snapshot: null,
  rolledBack: false,
});

// EI-13729: main() now wraps the --execute path in the release-deploy
// single-flight lock. Stub it to "always acquire" so the existing tests keep
// exercising the flow directly, without touching PG/su-lock-store.
const alwaysAcquires = async <T>(fn: () => Promise<T>): Promise<{ acquired: true; result: T }> => ({
  acquired: true,
  result: await fn(),
});

// P-015: recordParity defaults to the REAL fact/coord writer — stubbed here so
// no test ever writes live facts or severe-event broadcasts from a stubbed
// deploy (same rule as recordRefused/recordCoalesced). Tests that assert on it
// override with their own vi.fn.
// EI-20459175302238839: censusStranded defaults to the REAL census, which shells out to
// `git submodule status --recursive` against cfg.integrationRoot. Stubbed to a measured
// all-clear here for the same reason as recordRefused/recordParity — a unit test of the
// exit-code chokepoint must spawn no git and touch no tree. The strand-gate tests below
// override it explicitly; `[]` (measured, clean) is the neutral value, NOT null.
const silent = {
  out: () => {},
  err: () => {},
  runUnderDeployLock: alwaysAcquires,
  recordParity: async () => {},
  censusStranded: async () => [],
  // WI-10005763: the restricted-write fence defaults to the REAL census (PG + git). `null` =
  // nothing held, so every existing test exercises the flow exactly as before.
  restrictedHoldFence: async () => null,
};

describe('deploy-cli main() — the gate chokepoint', () => {
  it('REFUSES a non-green target without --force → exit 2, executeDeploy NEVER called', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const makeDeps = vi.fn(() => makeStubDeps());
    const recordRefused = vi.fn(async () => {}); // stub: never write live pipeline_events
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: false, forced: false }),
      makeDeps,
      executeDeploy,
      recordRefused,
    });

    expect(code).toBe(2);
    expect(executeDeploy).not.toHaveBeenCalled();
    // The refusal happens before any real-effect dep is built.
    expect(makeDeps).not.toHaveBeenCalled();
    // The 'refused' event is recorded (the fold counts it), via the injected stub.
    expect(recordRefused).toHaveBeenCalledWith(makePlan({ green: false, forced: false }).targetSha);
  });

  it('PLAN ONLY (no --execute) → exit 0, never deploys even when green', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts'], // no --execute
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(code).toBe(0);
    expect(executeDeploy).not.toHaveBeenCalled();
  });

  it('noop (release already at target) → exit 0, never deploys', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(code).toBe(0);
    expect(executeDeploy).not.toHaveBeenCalled();
  });

  it('a green non-noop target PROCEEDS — executeDeploy runs, exit 0, NO forced broadcast', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const plan = makePlan({ green: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });

    expect(executeDeploy).toHaveBeenCalledTimes(1);
    // rollbackOnFailure default true (no --no-rollback flag).
    expect(executeDeploy.mock.calls[0]![3]).toEqual({ rollbackOnFailure: true });
    expect(code).toBe(0);
    // A green deploy does NOT emit the un-green escape-hatch broadcast.
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a failed deploy → exit 1', async () => {
    const plan = makePlan({ green: true, noop: false });
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => ({ ...okResult(plan), ok: false, rolledBack: true, error: 'health failed' }),
    });
    expect(code).toBe(1);
  });

  it('--deploy-commit <sha> FORCES an un-green deploy + emits the loud audit broadcast', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const sha = 'f'.repeat(40);
    // deploy-commit targets a specific (un-green) sha; gatherPlan reflects force.
    const plan = makePlan({ green: false, forced: true, noop: false, targetSha: sha, migrations: ['142-x.sql'] });
    const gatherPlan = vi.fn<GatherFn>(async () => plan);
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));

    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--deploy-commit', sha, '--execute'],
      cfg,
      gatherPlan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });

    // --deploy-commit implies force + sets target to the sha.
    expect(gatherPlan.mock.calls[0]![1]).toEqual({ target: sha, force: true });
    // The loud un-green audit broadcast fires BEFORE the deploy.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [summary, body] = broadcast.mock.calls[0]!;
    expect(summary).toMatch(/FORCED un-green deploy/);
    expect(summary).toContain(sha.slice(0, 8));
    expect(body).toContain('142-x.sql');
    // …and it still proceeds to execute.
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('--force (without --deploy-commit) also proceeds past the green gate', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const plan = makePlan({ green: false, forced: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--force', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
    });
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1); // un-green → loud broadcast
    expect(code).toBe(0);
  });

  it('EI-13729: a COALESCED lock (another deploy in flight) → exit 0, gatherPlan and executeDeploy NEVER called', async () => {
    const gatherPlan = vi.fn<GatherFn>(async () => makePlan({ green: true }));
    const executeDeploy = vi.fn<ExecuteFn>();
    const runUnderDeployLock = vi.fn(async () => ({ acquired: false as const, holder: 'release-deploy:9999:abc' }));
    const code = await main({
      ...silent,
      runUnderDeployLock,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan,
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });

    expect(code).toBe(0);
    // The whole point: a coalesced attempt never even computes a plan against
    // state that may already be stale by the time it would run.
    expect(gatherPlan).not.toHaveBeenCalled();
    expect(executeDeploy).not.toHaveBeenCalled();
    expect(runUnderDeployLock).toHaveBeenCalledTimes(1);
  });

  it('EI-18835078701597295: a COALESCED attempt is RECORDED durably, with the holder and its liveness', async () => {
    // The CLI is one process per attempt, so "how many attempts in a row coalesced" cannot
    // live in memory here. Without this durable row the consecutive-coalesce alarm has
    // nothing to count and a wedged holder halts delivery with nothing paging.
    const recordCoalesced = vi.fn(async () => {});
    const code = await main({
      ...silent,
      runUnderDeployLock: vi.fn(async () => ({
        acquired: false as const,
        holder: 'release-deploy:9999:abc',
        holderAlive: false,
      })),
      recordCoalesced,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: vi.fn<GatherFn>(async () => makePlan({ green: true })),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });

    expect(code).toBe(0);
    // holderAlive must survive verbatim — it is what separates a healthy queue behind a
    // live deploy from a leaked lease the reclaim should already have taken.
    expect(recordCoalesced).toHaveBeenCalledWith({ holder: 'release-deploy:9999:abc', holderAlive: false });
  });

  it('EI-18835078701597295: a telemetry failure on the coalesce path never changes the exit code', async () => {
    // Best-effort by construction: the deploy path must not fail because recording did.
    const recordCoalesced = vi.fn(async () => {
      throw new Error('pipeline_events unreachable');
    });
    const code = await main({
      ...silent,
      runUnderDeployLock: vi.fn(async () => ({ acquired: false as const, holder: 'h', holderAlive: true })),
      recordCoalesced,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: vi.fn<GatherFn>(async () => makePlan({ green: true })),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });

    expect(recordCoalesced).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });

  it('a PLAN-ONLY invocation (no --execute) never consults the deploy lock', async () => {
    const runUnderDeployLock = vi.fn(alwaysAcquires);
    const code = await main({
      ...silent,
      // The Mock<> wrapper narrows the generic return below the field's union
      // type; the underlying function shape is exactly alwaysAcquires.
      runUnderDeployLock: runUnderDeployLock as typeof alwaysAcquires,
      argv: ['node', 'deploy-cli.ts'],
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
    });
    expect(code).toBe(0);
    expect(runUnderDeployLock).not.toHaveBeenCalled();
  });

  it('--no-rollback is threaded into executeDeploy opts', async () => {
    const plan = makePlan({ green: true, noop: false });
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute', '--no-rollback'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy,
    });
    expect(executeDeploy.mock.calls[0]![3]).toEqual({ rollbackOnFailure: false });
  });

  it('P-015: a COMPLETED deploy reports its parity consequence — forced ok → { ok:true, green:false }', async () => {
    const recordParity = vi.fn(async () => {});
    const plan = makePlan({ green: false, forced: true, noop: false });
    const code = await main({
      ...silent,
      recordParity,
      argv: ['node', 'deploy-cli.ts', '--force', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => okResult(plan),
    });
    expect(code).toBe(0);
    expect(recordParity).toHaveBeenCalledTimes(1);
    expect(recordParity).toHaveBeenCalledWith({
      ok: true,
      green: false,
      targetSha: plan.targetSha,
      installSlug: expect.any(String),
      integrationRoot: cfg.integrationRoot,
    });
  });

  it('P-015: a parity-recorder failure never changes the exit code (best-effort by construction)', async () => {
    const recordParity = vi.fn(async () => {
      throw new Error('facts store unreachable');
    });
    const plan = makePlan({ green: true, noop: false });
    const code = await main({
      ...silent,
      recordParity,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => okResult(plan),
    });
    expect(recordParity).toHaveBeenCalledTimes(1);
    expect(code).toBe(0);
  });
});

/**
 * EI-20459175302238839 — the STRANDED-SUBMODULE gate.
 *
 * A submodule that is POPULATED but absent from `.git/config` is invisible to git-sync:
 * it holds uncommitted TRACKED work no sweep can ever carry, so the change exists on
 * exactly one box and in no history, while the artifact being shipped is built from
 * committed state WITHOUT it. git-sync already MEASURES this every tick and merely logs
 * it; this gate is what makes the existing signal refuse instead of scroll past. It
 * shipped twice in one week before the gate existed: WI-38933 (a token-kit patch in no
 * history — only that box could `npm ci`) and WI-38945 (libs/sse export conditions
 * missing from the built image → a production crash-loop).
 *
 * The load-bearing distinction under test is `null` (NOT MEASURED) vs `[]` (measured,
 * clean). Collapsing those two is the exact silence the census exists to break, so it is
 * asserted in both directions rather than left to the implementation's discretion.
 */
describe('deploy-cli main() — the stranded-submodule gate (EI-20459175302238839)', () => {
  const strand = [{ path: 'libs/token-kit', trackedFiles: 2, files: ['package.json', 'src/index.ts'] }];
  const censusOf = (v: typeof strand | null) => vi.fn(async (_integrationRoot: string) => v);

  it('REFUSES stranded work → exit 2, executeDeploy NEVER called, refusal recorded', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const makeDeps = vi.fn(() => makeStubDeps());
    const recordRefused = vi.fn(async () => {});
    const plan = makePlan({ green: true, noop: false }); // green: ONLY the strand gate can refuse
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps,
      executeDeploy,
      recordRefused,
      censusStranded: censusOf(strand),
    });

    expect(code).toBe(2);
    expect(executeDeploy).not.toHaveBeenCalled();
    // Refusal lands BEFORE any real-effect dep is constructed.
    expect(makeDeps).not.toHaveBeenCalled();
    expect(recordRefused).toHaveBeenCalledWith(plan.targetSha);
  });

  it('names the offending submodule and its rescue in the refusal text', async () => {
    const lines: string[] = [];
    await main({
      ...silent,
      err: (m: string) => void lines.push(m),
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: false }),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
      recordRefused: async () => {},
      censusStranded: censusOf(strand),
    });

    const text = lines.join('\n');
    // The operator must learn WHICH submodule, WHAT is at risk, and HOW to rescue it —
    // a bare "refused" would send them to the source to find out.
    expect(text).toMatch(/REFUSING/);
    expect(text).toContain('libs/token-kit');
    expect(text).toContain('package.json');
    expect(text).toMatch(/git submodule init/);
    expect(text).toMatch(/--allow-stranded-submodules/);
  });

  it('--force does NOT bypass the strand gate — the two gates guard different things', async () => {
    // --force is about shipping an UN-GREEN commit; this gate is about shipping code that
    // is MISSING. Letting --force imply both would silently re-open the WI-38945 hole for
    // every forced deploy, which is exactly when an operator is least likely to notice.
    const executeDeploy = vi.fn<ExecuteFn>();
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--force', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: false, forced: true, noop: false }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      recordRefused: async () => {},
      censusStranded: censusOf(strand),
    });

    expect(code).toBe(2);
    expect(executeDeploy).not.toHaveBeenCalled();
  });

  it('--allow-stranded-submodules PROCEEDS and emits the loud audit broadcast', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const plan = makePlan({ green: true, noop: false }); // green → the ONLY broadcast is the strand one
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute', '--allow-stranded-submodules'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy,
      censusStranded: censusOf(strand),
    });

    expect(code).toBe(0);
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    // Knowingly shipping an artifact that omits work only one box holds is at least as
    // consequential as knowingly shipping an un-green commit, so it is audited the same way.
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [summary, body] = broadcast.mock.calls[0]!;
    expect(summary).toMatch(/STRANDED/);
    expect(body).toContain('libs/token-kit');
    expect(body).toMatch(/git submodule init/);
  });

  it('NOT MEASURED (null) warns loudly but does NOT refuse — a wedge is worse than the risk', async () => {
    // `git submodule status --recursive` exits non-zero on ONE stray gitlink anywhere in
    // the tree (a recurring condition here), so failing closed would trade a strand RISK
    // for a pipeline-wedge CERTAINTY. It must still be audibly distinct from an all-clear.
    const lines: string[] = [];
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(makePlan({ green: true, noop: false })));
    const code = await main({
      ...silent,
      err: (m: string) => void lines.push(m),
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: false }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      censusStranded: censusOf(null),
    });

    expect(code).toBe(0);
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    const text = lines.join('\n');
    expect(text).toMatch(/DID NOT RUN|NOT MEASURED/);
    // The whole point: an unmeasured pass must never read as clean.
    expect(text).toMatch(/NOT an all-clear/i);
  });

  it('a THROWING census folds into NOT MEASURED — it can never crash the deploy CLI', async () => {
    const lines: string[] = [];
    const executeDeploy = vi.fn<ExecuteFn>(async () => okResult(makePlan({ green: true, noop: false })));
    const code = await main({
      ...silent,
      err: (m: string) => void lines.push(m),
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: false }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      censusStranded: async () => {
        throw new Error('git exploded');
      },
    });

    expect(code).toBe(0);
    expect(executeDeploy).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/DID NOT RUN|NOT MEASURED/);
  });

  it('a measured-clean census ([]) proceeds silently — no strand broadcast, no warning', async () => {
    const broadcast = vi.fn<BroadcastFn>(async () => {});
    const lines: string[] = [];
    const plan = makePlan({ green: true, noop: false });
    const code = await main({
      ...silent,
      err: (m: string) => void lines.push(m),
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps({ broadcast }),
      executeDeploy: async () => okResult(plan),
      censusStranded: censusOf([]),
    });

    expect(code).toBe(0);
    // `[]` is a real all-clear; it must NOT produce the NOT-MEASURED warning.
    expect(lines.join('\n')).not.toMatch(/DID NOT RUN|NOT MEASURED/);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('censuses the INTEGRATION tree (where work strands), not the release checkout', async () => {
    // The release checkout is rebuilt from committed state every deploy, so it cannot hold
    // stranded work by construction. Measuring it would make the gate permanently vacuous.
    const censusStranded = censusOf([]);
    const plan = makePlan({ green: true, noop: false });
    await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => plan,
      makeDeps: () => makeStubDeps(),
      executeDeploy: async () => okResult(plan),
      censusStranded,
    });

    expect(censusStranded).toHaveBeenCalledWith(cfg.integrationRoot);
    expect(cfg.integrationRoot).not.toBe(cfg.releaseRoot);
  });

  it('PLAN ONLY (no --execute) never censuses — review mode stays side-effect free', async () => {
    const censusStranded = censusOf(strand);
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts'], // no --execute
      cfg,
      gatherPlan: async () => makePlan({ green: true, noop: false }),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
      censusStranded,
    });

    expect(code).toBe(0);
    expect(censusStranded).not.toHaveBeenCalled();
  });
});

/**
 * WI-10005763 (D-012): a direct `npx tsx deploy-cli.ts --execute` executes live-tree code with
 * network, outside the fenced launcher. The fence refuses at entry — before the lock, the plan, or
 * any effect — and neither --force nor --deploy-commit bypasses it.
 */
describe('deploy-cli main() — restricted-write fence (WI-10005763)', () => {
  type FenceFn = (roots: readonly string[]) => Promise<{ error: 'restricted_write_held' | 'restricted_hold_state_unknown'; hint: string } | null>;
  const held = { error: 'restricted_write_held' as const, hint: '1 held restricted write(s) in /tmp/int (a.ts)' };

  it('refuses an --execute run while a write is held: exit 2, no lock, no plan, no deploy', async () => {
    const restrictedHoldFence = vi.fn<FenceFn>(async () => held);
    const runUnderDeployLock = vi.fn(alwaysAcquires);
    const gatherPlan = vi.fn<GatherFn>(async () => makePlan({ green: true }));
    const executeDeploy = vi.fn<ExecuteFn>();
    const out = vi.fn<(s: string) => void>();
    const code = await main({
      ...silent,
      out,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan,
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      runUnderDeployLock: runUnderDeployLock as typeof alwaysAcquires,
      restrictedHoldFence,
    });

    expect(code).toBe(2);
    expect(restrictedHoldFence).toHaveBeenCalledWith(expect.arrayContaining([cfg.integrationRoot]));
    expect(runUnderDeployLock).not.toHaveBeenCalled();
    expect(gatherPlan).not.toHaveBeenCalled();
    expect(executeDeploy).not.toHaveBeenCalled();
    const marker = out.mock.calls.map(([s]) => s).find((s) => s.startsWith('__DEPLOY_PLAN__ '));
    expect(JSON.parse(marker!.slice('__DEPLOY_PLAN__ '.length))).toMatchObject({ mode: 'execute', refused: 'restricted_write_held', restrictedHold: held });
  });

  it('--force and --deploy-commit do not bypass the fence', async () => {
    for (const flags of [['--force'], ['--deploy-commit', 'd'.repeat(40)]]) {
      const executeDeploy = vi.fn<ExecuteFn>();
      const code = await main({
        ...silent,
        argv: ['node', 'deploy-cli.ts', ...flags, '--execute'],
        cfg,
        gatherPlan: async () => makePlan({ green: false, forced: true }),
        makeDeps: () => makeStubDeps(),
        executeDeploy,
        restrictedHoldFence: async () => held,
      });
      expect(code).toBe(2);
      expect(executeDeploy).not.toHaveBeenCalled();
    }
  });

  it('a fence that throws refuses (fail-closed) instead of deploying', async () => {
    const executeDeploy = vi.fn<ExecuteFn>();
    const errLines: string[] = [];
    const code = await main({
      ...silent,
      err: (s) => errLines.push(s),
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      restrictedHoldFence: async () => {
        throw new Error('census down');
      },
    });
    expect(code).toBe(2);
    expect(executeDeploy).not.toHaveBeenCalled();
    expect(errLines.join('\n')).toMatch(/restricted_hold_state_unknown.*census down/);
  });

  it('nothing held → the deploy proceeds (control)', async () => {
    const executeDeploy = vi.fn<ExecuteFn>(async (_c, plan) => okResult(plan));
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts', '--execute'],
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy,
      restrictedHoldFence: async () => null,
    });
    expect(code).toBe(0);
    expect(executeDeploy).toHaveBeenCalledTimes(1);
  });

  it('PLAN ONLY never consults the fence', async () => {
    const restrictedHoldFence = vi.fn<FenceFn>(async () => held);
    const code = await main({
      ...silent,
      argv: ['node', 'deploy-cli.ts'],
      cfg,
      gatherPlan: async () => makePlan({ green: true }),
      makeDeps: () => makeStubDeps(),
      executeDeploy: vi.fn<ExecuteFn>(),
      restrictedHoldFence,
    });
    expect(code).toBe(0);
    expect(restrictedHoldFence).not.toHaveBeenCalled();
  });
});
