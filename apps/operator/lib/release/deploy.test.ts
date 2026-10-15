/**
 * Deploy orchestration tests — the step order + rollback-on-failure are the
 * load-bearing safety property (a deploy that swaps code but skips snapshot, or
 * fails health without rolling back, would wedge the fleet). Stub deps so we
 * test pure orchestration; real wiring is exercised in the e2e integration test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatherPlan,
  executeDeploy,
  isDesktopOnlyDelta,
  DESKTOP_SUBMODULE_PATH,
  type DeployDeps,
  type DeployPlan,
  type SnapshotInfo,
} from './deploy';
import { git, revParse } from './git-ops';
import { releaseConfig } from './release-config';

// WI-2399: executeDeploy no longer hard-imports the await engine — the emit is an
// INJECTED dep (deps.emitEvent), so there's nothing to vi.mock here. makeDeps'
// stub captures emitted keys into this module-level array; the EI-5993 / P-102
// tests reset + read it. The 20ms delay in the stub is the EI-5993 guard: a
// regression back to a fire-and-forget emit (dropping the await at the call site)
// makes the await-ordering tests fail instead of passing by scheduling luck —
// deploy-cli process.exit()s right after executeDeploy resolves, so an un-awaited
// emit races the exit and (in production) almost never fires.
const emittedKeys: string[] = [];

function makeDeps(over: Partial<DeployDeps> & { fail?: string } = {}): { deps: DeployDeps; calls: string[] } {
  const calls: string[] = [];
  const failAt = over.fail;
  const rec = <T>(name: string, val: T): Promise<T> => {
    calls.push(name);
    if (failAt === name) return Promise.reject(new Error(`stub failure at ${name}`));
    return Promise.resolve(val);
  };
  const deps: DeployDeps = {
    withDrain: async (fn) => {
      calls.push('drain:acquire');
      try {
        return await fn();
      } finally {
        calls.push('drain:release');
      }
    },
    readReleaseTriggerControl: () =>
      rec('releaseTriggerControl', {
        name: 'release-trigger',
        active: true,
        cron: '0 */15 * * * *',
        lastFiredAtMs: null,
        nextFireAtMs: null,
        groupSlug: 'release',
        pause: null,
      }),
    readLiveReleaseCertification: async (targetSha) => ({
      status: 'certified',
      targetSha,
      certified: true,
      reason: 'exact source certified',
      bankPath: '/tmp/verdicts.jsonl',
      evidence: null,
      invalidLines: 0,
    }),
    snapshot: () => rec('snapshot', { snapshotId: 1, kopiaSnapshotId: 'kopia-abc' } as SnapshotInfo),
    runSetup: (sha) => rec(`runSetup:${sha.slice(0, 4)}`, undefined).then(() => undefined),
    bundleHost: () => rec('bundleHost', undefined).then(() => undefined),
    migrate: () => rec('migrate', { appliedCount: 1, totalKnown: 5, applied: ['200-x.sql'], sqlDir: '/x' }),
    restart: () => rec('restart', undefined).then(() => undefined),
    health: () => rec('health', { healthy: true, attempts: 1, elapsedMs: 10 }),
    servingSha: () => rec('servingSha', { reachable: true, sha: 'abcdef12' }),
    verifyPaths: () => rec('verifyPaths', { ok: true, failures: [] }),
    preflight: () => rec('preflight', { ok: true }),
    restoreSnapshot: () => rec('restoreSnapshot', undefined).then(() => undefined),
    broadcast: (s) => {
      calls.push(`broadcast:${s.includes('✅') ? 'ok' : s.includes('❌') ? 'fail' : 'other'}`);
      return Promise.resolve();
    },
    // WI-2399: the injected await-bus emit. The 20ms delay is the EI-5993 guard
    // (see the emittedKeys note above) — it captures the key only AFTER the delay,
    // so an un-awaited call at the site would leave emittedKeys empty when the
    // assertion runs.
    emitEvent: async (opts) => {
      await new Promise((r) => setTimeout(r, 20));
      emittedKeys.push(opts.key);
    },
    // The deploy records its own pipeline event (deployer-dies-with-deployed,
    // 2026-06-06: the routine's host dies at the deploy's restart step, so only
    // the deploy process can report the outcome).
    recordEvent: (ev) => {
      calls.push(`recordEvent:${ev.status}`);
      return Promise.resolve();
    },
    log: () => {},
    ...stripFail(over),
  };
  return { deps, calls };
}

function stripFail(o: Partial<DeployDeps> & { fail?: string }): Partial<DeployDeps> {
  const { fail, ...rest } = o;
  void fail;
  return rest;
}

const plan: DeployPlan = {
  target: 'ready',
  targetSha: 'abcdef1234567890',
  currentReleaseSha: '1111111111111111',
  isFastForward: true,
  green: true,
  forced: false,
  commits: ['c1', 'c2'],
  commitShas: ['abcdef1234567890', 'cccccccccccccccc'],
  migrations: ['libs/papercusp/libs/db/sql/200-x.sql'],
  warnings: [],
  noop: false,
  servingSha: null,
  servingReachable: false,
  restartOnly: false,
  desktopOnly: false,
  risk: { tier: 'review', autoDeployable: false, reasons: ['1 staged migration(s)'], blocked: [] },
};
const cfg = releaseConfig();

describe('isDesktopOnlyDelta — D-003 desktop-only deploy skip', () => {
  it('is true when the only changed path is the papercusp-desktop gitlink', () => {
    expect(isDesktopOnlyDelta([DESKTOP_SUBMODULE_PATH])).toBe(true);
  });
  it('is true for paths under the submodule', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop/src-tauri/tauri.conf.json'])).toBe(true);
  });
  it('is false when any non-desktop path also changed', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop', 'apps/operator/lib/x.ts'])).toBe(false);
    expect(isDesktopOnlyDelta(['apps/operator/lib/x.ts'])).toBe(false);
  });
  it('is false for an empty delta (the noop case, gated separately)', () => {
    expect(isDesktopOnlyDelta([])).toBe(false);
  });
  it('does not treat a sibling prefix (papercusp-desktop-extras) as inside the submodule', () => {
    expect(isDesktopOnlyDelta(['papercusp-desktop-extras/x'])).toBe(false);
  });
});

describe('executeDeploy — happy path', () => {
  it('retains the complete shipped artifact SHA in the successful native receipt', async () => {
    const events: Array<{ status: string; detail: Record<string, unknown> }> = [];
    const targetSha = 'abcdef1234567890abcdef1234567890abcdef1234';
    const { deps } = makeDeps({ recordEvent: async (event) => { events.push(event); } });
    expect((await executeDeploy(cfg, { ...plan, targetSha }, deps)).ok).toBe(true);
    expect(events).toEqual([{ status: 'ok', detail: {
      targetSha: targetSha.slice(0, 12), fullTargetSha: targetSha, commits: 2, migrations: 1,
    } }]);
  });

  it('runs steps in order inside the drain, broadcasts success', async () => {
    const { deps, calls } = makeDeps();
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(res.rolledBack).toBe(false);
    // drain wraps everything; snapshot precedes swap precedes migrate precedes restart
    expect(calls[0]).toBe('drain:acquire');
    expect(calls.indexOf('releaseTriggerControl')).toBeLessThan(calls.indexOf('snapshot'));
    expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('runSetup:abcd'));
    // WI-41242: the untracked host bundle is rebuilt after swap and before the
    // preflight/migration/live cutover.
    expect(calls.indexOf('runSetup:abcd')).toBeLessThan(calls.indexOf('bundleHost'));
    expect(calls.indexOf('bundleHost')).toBeLessThan(calls.indexOf('preflight'));
    expect(calls.indexOf('preflight')).toBeLessThan(calls.indexOf('migrate'));
    expect(calls.indexOf('migrate')).toBeLessThan(calls.indexOf('restart'));
    expect(calls.indexOf('restart')).toBeLessThan(calls.indexOf('health'));
    expect(calls.indexOf('health')).toBeLessThan(calls.indexOf('servingSha'));
    expect(calls).toContain('broadcast:ok');
    expect(calls).toContain('recordEvent:ok'); // the deploy reports its own outcome
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('passes the pre-swap release SHA to the migration guard instead of target checkout HEAD', async () => {
    let deployedSha: string | null | undefined;
    const { deps } = makeDeps({
      migrate: async (sha) => {
        deployedSha = sha;
        return { appliedCount: 0, totalKnown: 0, applied: [], sqlDir: '/x' };
      },
    });

    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(deployedSha).toBe(plan.currentReleaseSha);
    expect(deployedSha).not.toBe(plan.targetSha);
  });

  it('WI-41242: a host-bundle build failure aborts before migration or restart and rebuilds the rollback bundle', async () => {
    let bundleCalls = 0;
    const { deps, calls } = makeDeps({
      bundleHost: () => {
        bundleCalls++;
        calls.push('bundleHost');
        return bundleCalls === 1 ? Promise.reject(new Error('stale bundle fallback')) : Promise.resolve();
      },
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res).toMatchObject({ ok: false, rolledBack: true });
    expect(res.error).toMatch(/stale bundle fallback/);
    expect(calls).not.toContain('migrate');
    expect(calls).not.toContain('restart');
    expect(calls).toContain('runSetup:1111');
    expect(bundleCalls).toBe(2); // failed target build + successful previous-sha rebuild
    expect(res.steps.some((s) => s.name === 'rollback-bundle-host')).toBe(true);
  });

  it('WI-41242: a healthy process reporting the wrong SHA fails the deploy loudly', async () => {
    const { deps } = makeDeps({
      servingSha: () => Promise.resolve({ reachable: true, sha: 'deadbeef' }),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/serving process sha mismatch/);
    expect(res.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'serving-sha', ok: true })]));
  });

  it('re-reads a post-launch pause inside the drain and refuses before every mutation without rollback', async () => {
    const { deps, calls } = makeDeps({
      readReleaseTriggerControl: async () => ({
        name: 'release-trigger',
        active: false,
        cron: '0 */15 * * * *',
        lastFiredAtMs: null,
        nextFireAtMs: null,
        groupSlug: 'release',
        pause: {
          reason: 'hold until repaired checkout is green',
          pausedBy: 'su-release-owner',
          pausedAtMs: Date.parse('2026-08-15T09:07:00Z'),
          expiresAtMs: null,
        },
      }),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res).toMatchObject({ ok: false, rolledBack: false });
    expect(res.error).toMatch(/ordinary deploy refused before mutation.*repaired checkout/);
    expect(res.steps).toEqual([
      expect.objectContaining({ name: 'release-trigger-control', ok: false }),
    ]);
    expect(calls).toEqual(['drain:acquire', 'drain:release']);
    expect(calls.some((c) => c.startsWith('runSetup:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('broadcast:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('recordEvent:'))).toBe(false);
  });

  it('fails closed before mutation when the execution-time control read is unavailable', async () => {
    const { deps, calls } = makeDeps({
      readReleaseTriggerControl: async () => null,
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res).toMatchObject({ ok: false, rolledBack: false });
    expect(res.error).toMatch(/release-trigger control is unavailable/);
    expect(calls).toEqual(['drain:acquire', 'drain:release']);
  });

  it('P-010: re-reads exact-SHA live certification inside the drain and refuses before mutation', async () => {
    const { deps, calls } = makeDeps({
      readLiveReleaseCertification: async (targetSha) => ({
        status: 'missing',
        targetSha,
        certified: false,
        reason: 'no exact-source live verdict',
        bankPath: '/tmp/verdicts.jsonl',
        evidence: null,
        invalidLines: 0,
      }),
    });
    const res = await executeDeploy(cfg, plan, deps);

    expect(res).toMatchObject({ ok: false, rolledBack: false });
    expect(res.error).toMatch(/ordinary deploy refused before mutation.*exact-SHA live certification missing/i);
    expect(res.steps).toEqual([
      expect.objectContaining({ name: 'release-trigger-control', ok: true }),
      expect.objectContaining({ name: 'live-certification', ok: false }),
    ]);
    expect(calls).toEqual(['drain:acquire', 'releaseTriggerControl', 'drain:release']);
  });

  it('lets the explicit forced plan bypass the live release-trigger guard', async () => {
    let readAttempted = false;
    let certificationReadAttempted = false;
    const { deps, calls } = makeDeps({
      readReleaseTriggerControl: async () => {
        readAttempted = true;
        throw new Error('force must not consult the ordinary-deploy guard');
      },
      readLiveReleaseCertification: async () => {
        certificationReadAttempted = true;
        throw new Error('force must not consult the ordinary-certification guard');
      },
    });
    const res = await executeDeploy(cfg, { ...plan, forced: true, green: false }, deps);
    expect(res.ok).toBe(true);
    expect(readAttempted).toBe(false);
    expect(certificationReadAttempted).toBe(false);
    expect(calls).toContain('snapshot');
  });

  it('EI-5993: awaits emitAwaitedEvent(release:deployed) before resolving', async () => {
    emittedKeys.length = 0;
    const { deps } = makeDeps();
    await executeDeploy(cfg, plan, deps);
    expect(emittedKeys).toContain('release:deployed');
  });

  it('P-102: also fires the per-sha key release:deployed:<sha> alongside the global', async () => {
    emittedKeys.length = 0;
    const { deps } = makeDeps();
    await executeDeploy(cfg, plan, deps);
    // Both keys fire — the global (wake on ANY deploy) and the precise per-sha
    // (wake only on MY target) — so a caller can await either without payload-filtering.
    expect(emittedKeys).toContain('release:deployed');
    expect(emittedKeys).toContain(`release:deployed:${plan.targetSha}`);
  });

  it("EI-14601: also fires release:deployed:<sha> for EVERY other commit in the batch, not just the tip", async () => {
    emittedKeys.length = 0;
    const { deps } = makeDeps();
    await executeDeploy(cfg, plan, deps);
    // plan.commitShas carries the tip (plan.targetSha) plus an earlier commit in the
    // same fast-forward batch — an agent that awaited THAT earlier commit's exact sha
    // (deploy:await{sha}, or a raw events:await keyed on it) must still wake, because
    // its fix DID ship as part of this deploy even though it isn't the tip.
    const earlierSha = plan.commitShas.find((sha) => sha !== plan.targetSha);
    expect(earlierSha).toBeTruthy();
    expect(emittedKeys).toContain(`release:deployed:${earlierSha}`);
    // The tip's own key still fires exactly once (not double-emitted by the batch loop).
    expect(emittedKeys.filter((k) => k === `release:deployed:${plan.targetSha}`)).toHaveLength(1);
  });

  it('EI-18798501894652068: the release:deployed summary\'s migration count matches payload.migrations.length, even when migrate() itself newly-applied 0 (already applied by a prior attempt)', async () => {
    emittedKeys.length = 0;
    const captured: Array<{ key: string; summary?: string; payload?: unknown }> = [];
    // plan.migrations has 1 staged file (see the module-level `plan` fixture), but this
    // migrate() run applied 0 NEW rows — e.g. a prior deploy attempt already recorded
    // them. Before the fix, the summary read appliedCount (0) while the payload still
    // listed plan.migrations (1 file) — a reader trusting the terse summary concluded
    // "no schema change" despite the payload (and reality) saying otherwise.
    const { deps } = makeDeps({
      migrate: () => Promise.resolve({ appliedCount: 0, totalKnown: 5, applied: [], sqlDir: '/x' }),
      emitEvent: async (opts) => {
        captured.push({ key: opts.key, summary: opts.summary, payload: opts.payload });
      },
    });
    await executeDeploy(cfg, plan, deps);
    const deployed = captured.find((c) => c.key === 'release:deployed');
    expect(deployed).toBeTruthy();
    expect(deployed!.summary).toBeTruthy();
    const payloadMigrations = (deployed!.payload as { migrations: string[] }).migrations;
    expect(payloadMigrations).toHaveLength(plan.migrations.length);
    const summaryCount = Number(deployed!.summary!.match(/(\d+) migration/)?.[1]);
    expect(summaryCount).toBe(payloadMigrations.length);
    expect(summaryCount).toBe(plan.migrations.length); // 1, not migrate()'s appliedCount of 0
  });
});

// WI-5864: a `restartOnly` plan means the checkout is ALREADY at target (a
// prior deploy attempt swapped it and then crashed before restarting) —
// executeDeploy must skip the (redundant, and misleadingly-labeled) swap step
// and go straight to preflight → migrate → restart → health → verify-paths.
describe('executeDeploy — restartOnly (WI-5864)', () => {
  const restartOnlyPlan: DeployPlan = {
    ...plan,
    currentReleaseSha: plan.targetSha, // checkout already at target
    servingSha: '1111111', // the live process is still the OLD build
    servingReachable: true,
    restartOnly: true,
    noop: false,
  };

  it('skips runSetup (swap), but still rebuilds the host bundle before preflight/cutover', async () => {
    let deployedSha: string | null | undefined;
    const { deps, calls } = makeDeps();
    deps.migrate = async (sha) => {
      calls.push('migrate');
      deployedSha = sha;
      return { appliedCount: 0, totalKnown: 0, applied: [], sqlDir: '/x' };
    };
    const res = await executeDeploy(cfg, restartOnlyPlan, deps);
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('runSetup:'))).toBe(false);
    expect(calls).toContain('snapshot');
    expect(calls).toContain('bundleHost');
    expect(calls).toContain('preflight');
    expect(calls).toContain('migrate');
    expect(calls).toContain('restart');
    expect(calls).toContain('health');
    expect(calls).toContain('verifyPaths');
    // order still holds for the steps that DO run
    expect(calls.indexOf('preflight')).toBeLessThan(calls.indexOf('migrate'));
    expect(calls.indexOf('migrate')).toBeLessThan(calls.indexOf('restart'));
    expect(deployedSha).toBe(restartOnlyPlan.servingSha);
  });

  it('a NON-restartOnly plan still runs runSetup (swap) as before — no regression to the normal path', async () => {
    const { deps, calls } = makeDeps();
    await executeDeploy(cfg, plan, deps); // plan.restartOnly is false
    expect(calls.some((c) => c.startsWith('runSetup:'))).toBe(true);
  });
});

describe('executeDeploy — rollback on failure', () => {
  it('rolls back code + db + restart when health fails (migrations staged)', async () => {
    // Deploy health fails on the 1st probe; the post-rollback probe succeeds.
    let healthCalls = 0;
    const { deps, calls } = makeDeps({
      health: () => {
        healthCalls++;
        return Promise.resolve(
          healthCalls === 1
            ? { healthy: false, attempts: 3, elapsedMs: 90, error: 'never came up' }
            : { healthy: true, attempts: 1, elapsedMs: 10 },
        );
      },
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    // rolled the release ref back to the prior sha + restored DB (migrations staged) + restarted
    expect(calls).toContain('runSetup:1111');
    expect(calls).toContain('restoreSnapshot');
    expect(calls).toContain('broadcast:fail');
    expect(calls).toContain('recordEvent:rolled-back');
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('EI-5993: awaits emitAwaitedEvent(release:deploy-failed) before resolving', async () => {
    emittedKeys.length = 0;
    let healthCalls = 0;
    const { deps } = makeDeps({
      health: () => {
        healthCalls++;
        return Promise.resolve(
          healthCalls === 1
            ? { healthy: false, attempts: 3, elapsedMs: 90, error: 'never came up' }
            : { healthy: true, attempts: 1, elapsedMs: 10 },
        );
      },
    });
    await executeDeploy(cfg, plan, deps);
    expect(emittedKeys).toContain('release:deploy-failed');
  });

  it('skips DB restore on code-only failures (no migrations)', async () => {
    const noMig = { ...plan, migrations: [] };
    const { deps, calls } = makeDeps({ fail: 'restart' });
    const res = await executeDeploy(cfg, noMig, deps);
    expect(res.ok).toBe(false);
    expect(calls).not.toContain('restoreSnapshot'); // code-only → no destructive DB restore
    expect(calls).toContain('runSetup:1111'); // code reverted
  });

  it('reports rollback failure loudly (operator may need manual recovery)', async () => {
    const { deps, calls } = makeDeps({
      health: () => Promise.resolve({ healthy: false, attempts: 1, elapsedMs: 5, error: 'down' }),
      runSetup: (sha) => (sha.startsWith('1111') ? Promise.reject(new Error('rollback git failed')) : Promise.resolve()),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(false);
    expect(calls).toContain('broadcast:fail');
  });
});

describe('executeDeploy — pre-cutover preflight (P-001, the MODULE_NOT_FOUND crash-loop guard)', () => {
  it('a FAILING preflight aborts before cutover: no migrate, NO live restart, tree reverted, zero downtime', async () => {
    // preflight() answers "would the checkout AS IT IS RIGHT NOW boot", and it is asked
    // twice about two DIFFERENT trees: first the swapped TARGET (fails here — that is
    // what aborts the cutover), then, after rollback-code, the reverted PREV (passes —
    // prev is the sha that was serving a moment ago). A stub returning one verdict for
    // both conflates them, which is why this models them separately (WI-6648).
    let preflights = 0;
    const { deps, calls } = makeDeps({
      preflight: () => {
        preflights++;
        return Promise.resolve(
          preflights === 1
            ? { ok: false, error: "Cannot find module '@papercusp/x' (MODULE_NOT_FOUND)" }
            : { ok: true },
        );
      },
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(preflights).toBe(2); // target check aborted the cutover; reverted-tree check cleared it
    expect(res.ok).toBe(false);
    // Pre-cutover failure ⇒ the live process never changed ⇒ counts as rolled back (to
    // prev) — but ONLY because the reverted tree was VERIFIED to boot. `rolledBack` is a
    // claim about the checkout, and zero downtime is not evidence for it (WI-6648).
    expect(res.rolledBack).toBe(true);
    expect(res.steps.some((s) => s.name === 'rollback-preflight')).toBe(true);
    expect(calls).toContain('runSetup:abcd'); // the swap happened
    expect(calls).not.toContain('migrate'); // aborted BEFORE migrate (no schema change)
    expect(calls).not.toContain('restart'); // :3070 was NEVER cut over (no crash-loop, no downtime)
    expect(calls).not.toContain('restoreSnapshot'); // no migration applied → no destructive DB restore
    expect(calls).toContain('runSetup:1111'); // tree reverted to the prior consistent sha
    expect(calls).toContain('broadcast:fail');
    expect(calls[calls.length - 1]).toBe('drain:release');
  });

  it('a PASSING preflight proceeds to the normal cutover', async () => {
    const { deps, calls } = makeDeps(); // default preflight ok:true
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(true);
    expect(calls).toContain('preflight');
    expect(calls.indexOf('preflight')).toBeLessThan(calls.indexOf('restart'));
  });

  it('rollback-side preflight failure (prev also won\'t boot) → no second restart, manual recovery (P-002)', async () => {
    let pfCalls = 0;
    const { deps, calls } = makeDeps({
      // pass the pre-cutover check (so we DO cut over), then FAIL the rollback-side check
      preflight: () => {
        pfCalls++;
        return Promise.resolve(pfCalls === 1 ? { ok: true } : { ok: false, error: 'prev node_modules incomplete' });
      },
      // health fails after the live restart → forces a rollback
      health: () => Promise.resolve({ healthy: false, attempts: 1, elapsedMs: 5, error: 'down' }),
    });
    const res = await executeDeploy(cfg, plan, deps);
    expect(res.ok).toBe(false);
    expect(pfCalls).toBe(2); // pre-cutover + rollback-side preflight both ran
    expect(res.rolledBack).toBe(false); // prev won't boot → rollback could not safely complete
    expect(calls).toContain('runSetup:1111'); // tree reverted to prev (code)
    expect(calls.filter((c) => c === 'restart').length).toBe(1); // deploy restart only — rollback-restart SKIPPED (no 2nd crash-loop)
    expect(calls).toContain('broadcast:fail');
  });
});

describe('gatherPlan', () => {
  let repo: string;
  let release: string;
  async function commit(file: string, content: string, msg: string): Promise<string> {
    const full = join(repo, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
    return revParse(repo, 'HEAD');
  }
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'reldep-int-'));
    release = mkdtempSync(join(tmpdir(), 'reldep-rel-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 't@e.com']);
    await git(repo, ['config', 'user.name', 'T']);
    await git(repo, ['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(release, { recursive: true, force: true });
  });

  it('plans a green FF deploy with staged migrations', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    // release checkout at c1
    await git(repo, ['worktree', 'add', '--detach', release, c1]);
    // advance main + ready with a migration
    await commit('libs/papercusp/libs/db/sql/300-z.sql', 'SELECT 1;', 'mig');
    const c3 = await commit('apps/operator/lib/x.ts', 'x', 'code');
    await git(repo, ['branch', '-f', 'ready', c3]);

    const p = await gatherPlan(releaseConfig({ integrationRoot: repo, releaseRoot: release, releaseRef: 'ready' }));
    expect(p.targetSha).toBe(c3);
    expect(p.currentReleaseSha).toBe(c1);
    expect(p.green).toBe(true);
    expect(p.isFastForward).toBe(true);
    expect(p.migrations).toEqual(['libs/papercusp/libs/db/sql/300-z.sql']);
    expect(p.commits.length).toBe(2);
    expect(p.noop).toBe(false);
    await git(repo, ['worktree', 'remove', '--force', release]).catch(() => {});
  });

  it('warns when target is not green and not forced', async () => {
    const c1 = await commit('a.txt', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a.txt', '2', 'c2'); // main ahead of ready
    const p = await gatherPlan(releaseConfig({ integrationRoot: repo, releaseRoot: repo, releaseRef: 'ready' }), {
      target: c2,
    });
    expect(p.green).toBe(false);
    expect(p.warnings.some((w) => w.includes('NOT the green'))).toBe(true);
  });
});
