/**
 * test-timing-budget-guard.test.ts — the wall-clock timing-budget guard's detection
 * predicate (EI-20290625014691548).
 *
 * The guard (`scripts/check-test-timing-budgets.mjs`) runs green on the clean tree: its
 * BASELINE grandfathers the 8 files measured as carrying a sub-floor budget. What that
 * green run CANNOT tell anyone is whether the predicate discriminates at all — a guard
 * that flagged nothing would look identical. These cases lock the direction the item
 * actually asks for, from both sides:
 *
 *   FLAGS      a tight numeric literal bound on elapsed wall-clock (the gate-red class)
 *   DOES NOT   a budget at or above the floor, a NAMED-constant budget (the sanctioned
 *              remediation), or a numeric bound on something that is not elapsed time.
 *
 * That last one is not padding. Reaching for this class with a naive grep over
 * `toBeLessThan(<small number>)` drowns in `expect(rows.length).toBeLessThan(9)` and
 * `expect(compareClaims(a, b)).toBeLessThan(0)` — measured while filing this, the first
 * pass was mostly `.length` assertions. A guard that inherited that over-match would
 * cry wolf on every array-size assertion in the tree and be baselined into silence
 * within a week, which is a worse outcome than the gap it was built to close.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only. Kept on ONE line: tsc reports TS7016 at the module-SPECIFIER line, so on a multi-line import the @ts-ignore lands on `import {` and suppresses nothing.
import { findNestedChildBudgetInversions, findWallClockBudgets, hasTightLiteralBudget, TIGHT_BUDGET_FLOOR_MS, BASELINE, SPAWN_SYNC_EXPLICIT_BASELINE, findChildIdleWindowBudgets, IDLE_WINDOW_FLOOR_MS, IDLE_WINDOW_KEY_RE, SPAWNS_CHILD_RE, IDLE_WINDOW_BASELINE } from '../../../scripts/check-test-timing-budgets.mjs';
// @ts-ignore — same untyped module as above; one line for the same TS7016 reason.
import { classifyFileDuration, durationSubjects, FILE_DURATION_BUDGET_MS, FILE_GROWTH_RATIO, FILE_GROWTH_FLOOR_MS, FILE_DURATION_BASELINE } from '../../../scripts/check-test-timing-budgets.mjs';

describe('wall-clock timing-budget guard predicate (EI-20290625014691548)', () => {
  it('FLAGS a tight literal budget on a direct elapsed assertion', () => {
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(80);')).toBe(true);
  });

  it('FLAGS the two-step form (elapsed hoisted into a local first)', () => {
    const src = ['const elapsed = Date.now() - startedAt;', 'expect(elapsed).toBeLessThan(120);'].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(true);
  });

  it('FLAGS performance.now() the same as Date.now()', () => {
    expect(hasTightLiteralBudget('expect(performance.now() - t0).toBeLessThanOrEqual(50);')).toBe(true);
  });

  it('does NOT flag a budget at or above the floor', () => {
    // 500 is the floor itself — deliberately NOT tight, which is why the two measured
    // 500ms sites are absent from BASELINE rather than grandfathered into it.
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(500);')).toBe(false);
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(15_000);')).toBe(false);
  });

  it('does NOT flag a NAMED-constant budget — the sanctioned remediation', () => {
    // The WI-38338 fix pattern: hoist the budget into named constants and assert their
    // ordering, so a too-tight budget fails deterministically on the author's machine
    // instead of silently under load. Naming it is a way OUT of this guard by design.
    const src = [
      'const IDLE_DEADLINE_MS = 1_500;',
      'const HARD_CEILING_MS = 15_000;',
      'expect(IDLE_DEADLINE_MS).toBeLessThan(HARD_CEILING_MS);',
      'expect(Date.now() - started).toBeLessThan(IDLE_DEADLINE_MS);',
    ].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(false);
  });

  it('does NOT flag a small numeric bound on something that is not elapsed time', () => {
    // The over-match control — see the file header.
    expect(hasTightLiteralBudget('expect(rows.length).toBeLessThan(9);')).toBe(false);
    expect(hasTightLiteralBudget('expect(compareClaims(early, late)).toBeLessThan(0);')).toBe(false);
    expect(hasTightLiteralBudget('expect(res.latencyMs).toBeLessThan(400);')).toBe(false);
  });

  it('does NOT treat an unrelated local as elapsed just because the file has a delta somewhere', () => {
    const src = [
      'const elapsed = Date.now() - startedAt;',
      'expect(elapsed).toBeLessThan(15_000);',
      'expect(pageCount).toBeLessThan(3);',
    ].join('\n');
    expect(hasTightLiteralBudget(src)).toBe(false);
  });

  it('does NOT flag an assertion QUOTED inside a string literal (this very file)', () => {
    // Found by running the guard against this test: the fixtures above ARE tight budgets,
    // written as strings, and a textual scanner cannot tell a fixture from live code. The
    // guard would have flagged its own test file — and the tempting fix, a BASELINE entry,
    // would have exempted this file permanently and hidden every real budget later added
    // to it. Skipping quoted matches is the honest fix; this pins it.
    const src = "const fixture = 'expect(Date.now() - started).toBeLessThan(80);';";
    expect(hasTightLiteralBudget(src)).toBe(false);
    // …while the same assertion UNQUOTED on a line is still caught.
    expect(hasTightLiteralBudget('expect(Date.now() - started).toBeLessThan(80);')).toBe(true);
  });

  it('reports the parsed budget and distinguishes literal from named', () => {
    const found = findWallClockBudgets(
      ['expect(Date.now() - a).toBeLessThan(80);', 'expect(Date.now() - b).toBeLessThan(DEADLINE_MS);'].join('\n'),
    ) as Array<{ budgetMs: number | null; named: boolean }>;
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ budgetMs: 80, named: false });
    expect(found[1]).toMatchObject({ budgetMs: null, named: true });
  });

  it('keeps the floor and a seeded, non-empty shrink-only baseline', () => {
    expect(TIGHT_BUDGET_FLOOR_MS).toBe(500);
    // Non-empty because the tree genuinely carried pre-existing sub-floor budgets when
    // this landed; it is SHRINK-ONLY, so this number going DOWN is the intended
    // direction and a rise means someone grandfathered instead of fixing.
    expect((BASELINE as Set<string>).size).toBe(8);
    expect((BASELINE as Set<string>).has('packages/operator-core/lib/release-checkpoint-launch.test.ts')).toBe(true);
    expect((SPAWN_SYNC_EXPLICIT_BASELINE as Set<string>).size).toBe(10);
  });

  it('FLAGS a child-process timeout that outlives the implicit Vitest parent', () => {
    const src = `
      it('scans the tree', () => {
        const guard = runGuardScript('node', ['scripts/check-tree.mjs'], {
          cwd: REPO_ROOT,
          timeoutMs: 180_000,
        });
        expect(guard.status).toBe(0);
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({ childTimeoutMs: 180_000, parentTimeoutMs: 60_000, parentSource: 'implicit-default' }),
    ]);
  });

  it('does NOT flag a child-process budget with an explicit larger Vitest parent', () => {
    const src = `
      test('scans the tree', () => {
        runGuardScript('node', ['scripts/check-tree.mjs'], {
          cwd: REPO_ROOT,
          timeoutMs: 180_000,
        });
      }, 240_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('FLAGS equal child and parent budgets because the parent has no completion headroom', () => {
    const src = `
      it.only('scans the tree', () => {
        runGuardScript('node', [], { cwd: REPO_ROOT, timeoutMs: 120_000 });
      }, 120_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({ childTimeoutMs: 120_000, parentTimeoutMs: 120_000, parentSource: 'explicit' }),
    ]);
  });

  it('does NOT infer a helper-routed or symbolic budget beyond the detector boundary', () => {
    const src = `
      const run = () => runGuardScript('node', [], { cwd: REPO_ROOT, timeoutMs: CHILD_TIMEOUT_MS });
      it('uses a helper', () => run());
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('does NOT crash or invent a budget when runGuardScript uses its default timeout', () => {
    const src = `
      it('uses the helper default', () => {
        runGuardScript('node', [], { cwd: REPO_ROOT });
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('FLAGS a direct spawnSync timeout that outlives its explicit Vitest parent', () => {
    const src = `
      it('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      }, 30_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([
      expect.objectContaining({
        childCall: 'spawnSync',
        childTimeoutMs: 120_000,
        parentTimeoutMs: 30_000,
        parentSource: 'explicit',
      }),
    ]);
  });

  it('does NOT flag spawnSync when its Vitest parent has completion headroom', () => {
    const src = `
      test('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      }, 150_000);
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });

  it('documents the legacy bound: implicit-parent spawnSync sites are not inferred', () => {
    const src = `
      it('runs the real CLI', () => {
        spawnSync('node', ['scripts/validate.mjs'], { timeout: 120_000 });
      });
    `;
    expect(findNestedChildBudgetInversions(src)).toEqual([]);
  });
});

describe('child idle-window guard (WI-10004030 — the WI-10004029 gate-red class)', () => {
  // The exact pre-fix shape of git-stdin-sidecar-handoff.test.ts: a 300ms idle window armed
  // at spawn, so a loaded `node` boot is charged to it and a correct test is idle-killed.
  const PRE_FIX = `
    const result = await execProcess({
      command: process.execPath,
      args: ['-e', script],
      idleTimeoutMs: 300,
      timeoutMs: 3000,
    }, deps);
  `;

  it('FLAGS the pre-fix literal shape', () => {
    expect(SPAWNS_CHILD_RE.test(PRE_FIX)).toBe(true);
    expect(findChildIdleWindowBudgets(PRE_FIX)).toEqual([
      expect.objectContaining({ key: 'idleTimeoutMs', budgetMs: 300, via: 'literal', exempt: false }),
    ]);
  });

  it('ignores report cadence data in a spawning file while retaining the actual child option', () => {
    const src = [
      'const report = { workload: { idleMs: 200 } };',
      'execProcess({ command: process.execPath, idleTimeoutMs: 300 });',
    ].join('\n');
    expect(findChildIdleWindowBudgets(src)).toEqual([
      expect.objectContaining({ key: 'idleTimeoutMs', budgetMs: 300, via: 'literal', exempt: false }),
    ]);
  });

  it('RESOLVES a same-file const, so hoisting the literal into a name does not evade the floor', () => {
    const src = `const IDLE_MS = 300;\nexecProcess({ command: process.execPath, idleTimeoutMs: IDLE_MS });`;
    expect(findChildIdleWindowBudgets(src)).toEqual([
      expect.objectContaining({ budgetMs: 300, via: 'const IDLE_MS' }),
    ]);
    const shorthand = `const idleTimeoutMs = 250;\nspawn('node', [], { idleTimeoutMs });`;
    expect(findChildIdleWindowBudgets(shorthand)).toEqual([expect.objectContaining({ budgetMs: 250 })]);
  });

  it('does NOT flag the post-fix window at or above the floor', () => {
    const src = `const IDLE_MS = 1_500;\nexecProcess({ command: process.execPath, idleTimeoutMs: IDLE_MS });`;
    const [window] = findChildIdleWindowBudgets(src);
    expect(window.budgetMs).toBe(1500);
    expect(window.budgetMs).toBeGreaterThanOrEqual(IDLE_WINDOW_FLOOR_MS);
  });

  it('honours an on-site, reason-carrying exemption on the same or the preceding line only', () => {
    const preceding = `execProcess({\n  // idle-window-ok: asserts the idle kill\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(preceding)).toEqual([expect.objectContaining({ exempt: true })]);
    const sameLine = `execProcess({ idleTimeoutMs: 120 }); // idle-window-ok: asserts the idle kill`;
    expect(findChildIdleWindowBudgets(sameLine)).toEqual([expect.objectContaining({ exempt: true })]);
    const reasonless = `execProcess({\n  // idle-window-ok:\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(reasonless)).toEqual([expect.objectContaining({ exempt: false })]);
    const tooFar = `// idle-window-ok: asserts the idle kill\n\nexecProcess({\n  idleTimeoutMs: 120,\n});`;
    expect(findChildIdleWindowBudgets(tooFar)).toEqual([expect.objectContaining({ exempt: false })]);
  });

  it('does NOT flag a non-idle key, a progress INTERVAL, or a non-positive invalid-policy fixture', () => {
    expect(findChildIdleWindowBudgets('execProcess({ command: process.execPath, timeoutMs: 300 });')).toEqual([]);
    expect(findChildIdleWindowBudgets('execProcess({ progressIntervalMs: 300 });')).toEqual([]);
    expect(findChildIdleWindowBudgets('check({ stallWindowMs: 0 }); check({ stallWindowMs: -1 });')).toEqual([]);
    expect(IDLE_WINDOW_KEY_RE.test('progressIntervalMs')).toBe(false);
    expect(IDLE_WINDOW_KEY_RE.test('noOutputTimeoutMs')).toBe(true);
  });

  it('does NOT resolve an ambiguous or non-const binding (a documented bound, not a guess)', () => {
    const shadowed = `const IDLE_MS = 300;\nfunction f() { const IDLE_MS = 5000; }\nexecProcess({ idleTimeoutMs: IDLE_MS });`;
    expect(findChildIdleWindowBudgets(shadowed)).toEqual([]);
    expect(findChildIdleWindowBudgets(`let IDLE_MS = 300;\nexecProcess({ idleTimeoutMs: IDLE_MS });`)).toEqual([]);
  });

  it('scopes eligibility to files that spawn a child', () => {
    expect(SPAWNS_CHILD_RE.test('const pool = createPool({ idleTimeoutMs: 300 });')).toBe(false);
    expect(SPAWNS_CHILD_RE.test("spawnSync('git', ['status']);")).toBe(true);
  });

  it('keeps the floor and an EMPTY shrink-only baseline — every measured site was fixed or exempted', () => {
    expect(IDLE_WINDOW_FLOOR_MS).toBe(1000);
    expect(IDLE_WINDOW_BASELINE as Set<string>).toBeInstanceOf(Set);
    expect((IDLE_WINDOW_BASELINE as Set<string>).size).toBe(0);
  });
});

// green-main-cycle-time-2026-10-08 P-004 — the FILE-DURATION class. The verdict is a pure
// function of a file's CI samples, so every branch is pinned here without a database.
describe('file-duration long-pole class (P-004)', () => {
  const DAY = 86_400_000;
  const T0 = Date.parse('2026-10-08T12:00:00Z');
  /** Newest-first samples: `recent` are the newest runs, `prior` the ones before them (1h apart). */
  function samples(recent: number[], prior: number[], priorAgeDays = 1) {
    const out: { durationMs: number; finishedAt: string }[] = [];
    recent.forEach((ms, i) => out.push({ durationMs: ms, finishedAt: new Date(T0 - i * 3_600_000).toISOString() }));
    prior.forEach((ms, i) => out.push({ durationMs: ms, finishedAt: new Date(T0 - priorAgeDays * DAY - i * 3_600_000).toISOString() }));
    return out;
  }
  type Verdict = { recentMs: number | null; priorMs: number | null; overBudget: boolean; grew: boolean; growthJudged: boolean };
  const classify = (s: ReturnType<typeof samples>, o?: object) => classifyFileDuration(s, o) as Verdict;

  it('keeps the measured constants the class was calibrated with', () => {
    expect(FILE_DURATION_BUDGET_MS).toBe(300_000);
    expect(FILE_GROWTH_RATIO).toBe(1.5);
    expect(FILE_GROWTH_FLOOR_MS).toBe(60_000);
    expect(FILE_GROWTH_FLOOR_MS).toBeLessThan(FILE_DURATION_BUDGET_MS);
  });

  it('FLAGS the measured long pole: recent median over budget AND grown', () => {
    const v = classify(samples([2_744_000, 2_464_000, 2_800_000], [1_094_000, 1_000_000, 1_200_000, 1_094_000]));
    expect(v.recentMs).toBe(2_744_000);
    expect(v.overBudget).toBe(true);
    expect(v.grew).toBe(true);
  });

  it('uses the MEDIAN of the newest 3, so one load-inflated run is not a finding', () => {
    const v = classify(samples([900_000, 100_000, 110_000], [100_000, 105_000, 95_000]));
    expect(v.recentMs).toBe(110_000);
    expect(v.overBudget).toBe(false);
    expect(v.grew).toBe(false);
  });

  it('FLAGS growth past the ratio for a file above the noise floor', () => {
    const v = classify(samples([222_000, 220_000, 225_000], [142_000, 140_000, 145_000]));
    expect(v.overBudget).toBe(false);
    expect(v.growthJudged).toBe(true);
    expect(v.grew).toBe(true);
  });

  it('does NOT flag a file that is stable just under budget', () => {
    const v = classify(samples([280_000, 279_000, 281_000], [275_000, 276_000, 274_000]));
    expect(v.overBudget).toBe(false);
    expect(v.grew).toBe(false);
  });

  it('does NOT judge growth below the noise floor (2s -> 6s is not a gate problem)', () => {
    const v = classify(samples([6_000, 6_000, 6_000], [2_000, 2_000, 2_000]));
    expect(v.growthJudged).toBe(false);
    expect(v.grew).toBe(false);
  });

  it('does NOT judge growth on too little prior history, nor on runs older than the window', () => {
    expect(classify(samples([200_000, 200_000, 200_000], [100_000, 100_000])).growthJudged).toBe(false);
    expect(classify(samples([200_000, 200_000, 200_000], [100_000, 100_000, 100_000], 9)).growthJudged).toBe(false);
  });

  it('reports no verdict for a file with no CI history (a new or just-split file)', () => {
    const v = classify([]);
    expect(v.recentMs).toBeNull();
    expect(v.overBudget).toBe(false);
    expect(v.grew).toBe(false);
  });

  it('judges only test files among the forwarded changed paths', () => {
    expect(durationSubjects(['scripts/check-test-timing-budgets.mjs', 'apps/x/a.test.ts', 'apps/x/a.test.ts', 'libs/y/b.spec.tsx', 'node_modules/z/c.test.ts'])).toEqual(['apps/x/a.test.ts', 'libs/y/b.spec.tsx']);
  });

  it('keeps a reason on every shrink-only baseline entry', () => {
    const baseline = FILE_DURATION_BASELINE as Map<string, string>;
    expect(baseline.size).toBeLessThanOrEqual(3);
    for (const [path, reason] of baseline) {
      expect(path).toMatch(/\.test\.ts$/);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
