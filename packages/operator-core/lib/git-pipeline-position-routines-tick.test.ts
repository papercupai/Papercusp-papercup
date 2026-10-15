import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyRuntimeOwners } from './git-pipeline-position';
import {
  dispatchedSweepSpecifiers,
  dispatchedSweepPaths,
  dispatchedSweepMatcher,
  resetDispatchedSweepCache,
  NOT_BG_HOST_DISPATCHED,
  operatorCoreLibDirFromModuleDir,
} from './routines-dispatch-derivation';

/**
 * WI-6659 — the CLASS guard behind the routinesTick runtime-ownership rules.
 *
 * `routinesTickImpl` dispatches its periodic sweeps by DIRECT `await import(...)`
 * rather than through the `system:<action>` registry, so the registry-shaped rules
 * in RUNTIME_OWNERS never matched them: every such path fell through to
 * DEFAULT_OWNER and `dev:pipeline_position` reported `deployed ✓ (live)` +
 * `nextAction: null` for code the :3070 release operator NEVER executes.
 *
 * That is not a cosmetic mislabel. On WI-6639 it produced a false "the fix is
 * live" conclusion — bg-host had been running 4h45m of PRE-FIX code while the
 * tool reported the change deployed — and only a behavioural measurement caught
 * it. CLAUDE.md tells agents to trust `blockedOn`/`nextAction` over the position
 * ticks, so these are precisely the fields that must not lie.
 *
 * Enumerating the sweeps by hand fixes today's list and rots on the next one, so
 * this test RE-DERIVES the set from the real dispatcher on every run. Adding sweep
 * #25 without a runtime-ownership rule fails HERE — loudly, at the seam — instead
 * of silently mis-routing someone's activation decision hours later.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const WORKFLOW = 'packages/operator-core/lib/dbos/routines-workflow.ts';

/**
 * EI-19369080695408825: the derivation this guard used to keep a PRIVATE copy of now
 * lives in production (`routines-dispatch-derivation.ts`), where RUNTIME_OWNERS consumes
 * it as a last-resort catch-all rule. The test imports that same code rather than
 * re-implementing it — a guard that re-derives the set independently of the thing it is
 * guarding would just be a second hand-maintained copy to drift, which is the bug.
 */

describe('WI-6659: routinesTick-dispatched modules are classified bg-host', () => {
  const source = readFileSync(resolve(REPO_ROOT, WORKFLOW), 'utf8');

  it('finds the dispatcher and a plausible number of dispatched modules', () => {
    // Guards the guard: if the dispatch idiom is refactored away, the matcher would
    // silently find nothing and every assertion below would vacuously pass.
    const specs = dispatchedSweepSpecifiers(source);
    expect(specs.length).toBeGreaterThan(15);
  });

  it('classifies every dispatched module as bg-host (or explicitly allowlists it)', () => {
    const resolved = dispatchedSweepPaths();
    expect(resolved.length).toBeGreaterThan(15);

    const misrouted: string[] = [];
    for (const path of resolved) {
      if (NOT_BG_HOST_DISPATCHED.has(path)) continue;
      const owners = classifyRuntimeOwners(path) ?? [];
      if (!owners.some((o) => o.host === 'bg-host')) misrouted.push(path);
    }

    expect(
      misrouted,
      `These modules are dispatched by routinesTickImpl (bg-host only) but classifyRuntimeOwners does ` +
        `not report a bg-host runtime for them, so dev:pipeline_position will tell an agent the ` +
        `deploy made their edit live when it cannot.\n\n` +
        `Since EI-19369080695408825 a new sweep should be classified AUTOMATICALLY by the derived ` +
        `catch-all rule (routines-dispatch-derivation.ts), so reaching this failure means the ` +
        `derivation itself is broken — check whether the dispatch idiom changed, rather than ` +
        `hand-adding a RUNTIME_OWNERS rule. If the module genuinely should NOT be bg-host, add it ` +
        `to NOT_BG_HOST_DISPATCHED with a stated reason; if it has BOTH a sweep and an ` +
        `operator-served consumer, add an explicit WI-5440 plural rule ABOVE the catch-all.\n  ${misrouted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('reports a bg-host activation lever, not a deploy, for a bg-host-only sweep', () => {
    // The regression that started WI-6659, pinned end-to-end.
    const owners = classifyRuntimeOwners(
      'packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts',
    );
    expect(owners).not.toBeNull();
    expect(owners).toHaveLength(1);
    expect(owners![0].host).toBe('bg-host');
    expect(owners![0].releasePipelineApplies).toBe(false);
    expect(owners![0].restartTarget).toBe('bg-host');
  });

  it('classifies the fleet-control reconcile helper by its bg-host caller', () => {
    // EI-22090053297465523: this helper is dynamically imported by the registered
    // fleet-transition-sweep action, so it runs in bg-host even though its filename
    // does not match the routine action/sweep naming conventions.
    const owners = classifyRuntimeOwners(
      'packages/operator-core/lib/harness/routines/fleet-control-reconcile.ts',
    );
    expect(owners).toHaveLength(1);
    expect(owners![0]).toMatchObject({
      host: 'bg-host',
      releasePipelineApplies: false,
      restartTarget: 'bg-host',
    });
    expect(owners![0].activation).toMatch(/dev:restart.*bg-host/s);
  });

  it.each([
    'packages/operator-core/lib/harness/routines/loop-unreachable-guard.ts',
    'packages/operator-core/lib/harness/routines/pty-host-wedge-guard.ts',
    'packages/operator-core/lib/harness/routines/stalled-loops-guard.ts',
  ])('WI-39787: %s is the implementation behind a bg-host routine action, not a deploy-carried path', (path) => {
    const owners = classifyRuntimeOwners(path) ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0].host).toBe('bg-host');
    expect(owners[0].releasePipelineApplies).toBe(false);
    expect(owners[0].restartTarget).toBe('bg-host');
    expect(owners[0].activation).toMatch(/dev:restart.*bg-host/s);
  });

  it('keeps BOTH routes for a dual-consumer sweep', () => {
    // pot/watchdog is swept by routinesTick AND read by operator-served surfaces.
    // Collapsing it either way sends half the callers to the wrong lever (WI-5440).
    const owners = classifyRuntimeOwners('packages/operator-core/lib/pot/watchdog.ts') ?? [];
    expect(owners.map((o) => o.host)).toEqual(['bg-host', 'operator-release']);
    expect(owners.find((o) => o.host === 'bg-host')!.restartTarget).toBe('bg-host');
    expect(owners.find((o) => o.host === 'operator-release')!.releasePipelineApplies).toBe(true);
  });

  it('leaves an ordinary operator-served path on the release pipeline', () => {
    // The new rules must not over-reach into unrelated operator-core code.
    const owners = classifyRuntimeOwners('packages/operator-core/lib/git-pipeline-position.ts') ?? [];
    expect(owners).toHaveLength(1);
    expect(owners[0].host).toBe('operator-release');
    expect(owners[0].releasePipelineApplies).toBe(true);
  });
});

/**
 * EI-19369080695408825 — the derived catch-all.
 *
 * The suite above asserts the set is CLASSIFIED. These assert it is classified without a
 * hand-edit, which is the actual fix: RUNTIME_OWNERS' hand-written alternation diverged
 * from the dispatcher twice in one day, and each divergence red-pinned the shared gate.
 */
describe('EI-19369080695408825: a new sweep is classified with no hand-edit', () => {
  /** A dispatcher that has just grown sweep #27, with the file "present" on disk. */
  const SYNTHETIC = `
    import { somethingUnrelated } from '../workspace-registry';
    export async function routinesTickImpl() {
      const { brandNewSweep } = await import('../harness/routines/brand-new-sweep');
      await brandNewSweep();
    }
  `;
  const NEW_SWEEP = 'packages/operator-core/lib/harness/routines/brand-new-sweep.ts';
  const existsAsNewSweep = (abs: string) => abs.endsWith('/harness/routines/brand-new-sweep.ts');

  it('picks up a sweep that exists in NO hand-written list', () => {
    const paths = dispatchedSweepPaths(SYNTHETIC, existsAsNewSweep);
    expect(paths).toContain(NEW_SWEEP);
  });

  it('is what saves that sweep — no hand-written rule covers it today', () => {
    // Pins the premise. If some rule ever DOES match this path, the test above stops
    // proving anything and this failure says so instead of passing vacuously.
    const owners = classifyRuntimeOwners(NEW_SWEEP) ?? [];
    expect(
      owners.map((o) => o.host),
      'a hand-written RUNTIME_OWNERS rule now matches the synthetic sweep path, so the ' +
        'catch-all is no longer the thing being tested — pick a different synthetic path',
    ).toEqual(['operator-release']);
  });

  it('spans the whole REAL dispatched set, so the net has no holes', () => {
    const matcher = dispatchedSweepMatcher();
    const uncovered = dispatchedSweepPaths().filter((p) => !matcher.test(p));
    expect(uncovered, `derived paths the catch-all regex fails to match:\n  ${uncovered.join('\n  ')}`).toEqual([]);
  });

  it('derives the set when the runtime module lives in the bundled host directory', () => {
    // In the host bundle import.meta.url points at apps/operator/dist-host, while
    // the source-only dispatcher stays under packages/operator-core/lib.
    const bundleModuleDir = resolve(REPO_ROOT, 'apps/operator/dist-host');
    const sourceLibDir = operatorCoreLibDirFromModuleDir(bundleModuleDir);

    expect(sourceLibDir).toBe(resolve(REPO_ROOT, 'packages/operator-core/lib'));
    const paths = dispatchedSweepPaths(undefined, undefined, sourceLibDir);
    expect(paths.length).toBeGreaterThan(15);
    expect(paths).toContain('packages/operator-core/lib/harness/routines/reconcile-loop-routines.ts');
  });

  it('degrades to matching NOTHING, never to matching everything', () => {
    // The failure direction matters more than the failure. A matcher that swallowed
    // unrelated paths would tell an agent editing a shared operator file that a deploy
    // cannot activate their change — the opposite lie to the one WI-6659 fixed.
    expect(dispatchedSweepPaths('', () => true)).toEqual([]);
    expect(dispatchedSweepPaths('const x = 1;', () => true)).toEqual([]);
  });

  it('is actually WIRED — classifyRuntimeOwners consults the derived matcher', () => {
    // The no-op check. Everything above tests the derivation in isolation; this proves
    // RUNTIME_OWNERS really reaches it, which nothing in the live set can exercise
    // (every dispatched module today matches an earlier hand-written rule).
    const synthetic = 'packages/operator-core/lib/harness/routines/wired-probe-sweep.ts';
    expect(classifyRuntimeOwners(synthetic)?.map((o) => o.host)).toEqual(['operator-release']);

    resetDispatchedSweepCache(new RegExp(`^${synthetic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    try {
      const owners = classifyRuntimeOwners(synthetic) ?? [];
      expect(owners).toHaveLength(1);
      expect(owners[0].host).toBe('bg-host');
      expect(owners[0].releasePipelineApplies).toBe(false);
      expect(owners[0].restartTarget).toBe('bg-host');
    } finally {
      resetDispatchedSweepCache();
    }

    // ...and the rule is LAST, so seeding it cannot steal a path an earlier rule owns.
    resetDispatchedSweepCache(/^packages\/operator-core\/lib\/pot\/watchdog\.ts$/);
    try {
      expect(classifyRuntimeOwners('packages/operator-core/lib/pot/watchdog.ts')?.map((o) => o.host)).toEqual([
        'bg-host',
        'operator-release',
      ]);
    } finally {
      resetDispatchedSweepCache();
    }
  });

  it('keeps the allowlist out of the derived set', () => {
    // agent-facts/store.ts is dispatched, but ~460 operator-served importers dominate it.
    const withFacts = `const { sweepExpiredFacts } = await import('../agent-facts/store');`;
    expect(dispatchedSweepPaths(withFacts, () => true)).toEqual([]);
  });
});
