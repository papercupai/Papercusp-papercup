import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  playwrightOwnedTest,
  selectRelatedTests,
  unitExcludedVitestTest,
} from '../../../../scripts/lib/related-tests.mjs';

/**
 * EI-21440128879545486 — a red gate task with ZERO attributable test files.
 *
 * `scripts/affected-tests.mjs` narrows a workspace's suite to the tests related to a change,
 * but it only narrows VITEST lanes (`narrowable()` = `test` + the lane scripts). The related
 * selector indexes `.test.*` AND `.spec.*`, because both name real tests SOMEWHERE in this
 * repo — so a Playwright spec could enter a vitest lane's positional filter, where it matches
 * nothing. `scripts/test-files.mjs` then refuses the entire partial-match run rather than
 * false-greening it (`TEST_FILE_ROUTE_ERROR requested=342 matched=340`).
 *
 * The resulting failure is the worst shape a gate red can take: exit 1 with no failing test.
 * It writes no `test_runs` fail rows, so ledger triage sees nothing; it names no file, so the
 * gate's isolation re-run has nothing to isolate; and re-running it changes nothing. Two specs
 * (`e2e/design-dashboard-flow.spec.ts`, `e2e/docs-routes.spec.ts`) entering the
 * `@papercusp/web :: test` selection that way red-pinned green-checkpoint and froze `main` for
 * the whole fleet — surviving seven unrelated test fixes, because no test was ever broken.
 *
 * EI-21576035258955946 exposed the same routing failure for the other universally excluded
 * unit-layer paths: `*.integration.test.*` and `*.browser.test.*`. The selector handed an
 * explicit integration test to the unit lane, whose config correctly refused it before any
 * test could run. The rails below cover both predicates and their WIRING: a correct predicate
 * nobody calls restores either bug in full.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
// Overridable so falsifiability can be proven against a COPY outside the tree
// (`scripts/mutation-probe.sh --file scripts/affected-tests.mjs`). Mutating the real file to
// prove the guard bites is unsafe here: git-sync sweeps the whole working tree on a schedule
// and can COMMIT the mutant even when nothing goes wrong and no restore handler fails.
const AFFECTED_TESTS_PATH = resolve(REPO_ROOT, process.env.PROBE_AFFECTED_TESTS ?? 'scripts/affected-tests.mjs');
const AFFECTED_TESTS_SRC = readFileSync(AFFECTED_TESTS_PATH, 'utf8').replaceAll('"', "'");

describe('wiring: affected-tests.mjs drops foreign-runner tests before narrowing a vitest lane', () => {
  it('imports the ownership predicate from the related-tests selector', () => {
    expect(AFFECTED_TESTS_SRC).toMatch(/playwrightOwnedTest/);
    expect(AFFECTED_TESTS_SRC).toMatch(/unitExcludedVitestTest/);
    expect(AFFECTED_TESTS_SRC).toMatch(
      /import\s*\{[^}]*playwrightOwnedTest[^}]*\}\s*from\s*'\.\/lib\/related-tests\.mjs'/s,
    );
    expect(AFFECTED_TESTS_SRC).toMatch(
      /import\s*\{[^}]*unitExcludedVitestTest[^}]*\}\s*from\s*'\.\/lib\/related-tests\.mjs'/s,
    );
  });

  it('filters the related selection through both unit-lane exclusion predicates', () => {
    // The calls must be APPLIED to the selection, not merely imported.
    const selectionAt = AFFECTED_TESTS_SRC.indexOf('result.selected.filter((f) => {');
    const playwrightAt = AFFECTED_TESTS_SRC.indexOf('ownedByPlaywright(f)', selectionAt);
    const layeredAt = AFFECTED_TESTS_SRC.indexOf('unitExcludedVitestTest(f)', selectionAt);

    expect(AFFECTED_TESTS_SRC).toMatch(/const\s+ownedByPlaywright\s*=\s*playwrightOwnedTest\(\s*wsRoot\s*\)/);
    expect(selectionAt).toBeGreaterThan(-1);
    expect(playwrightAt).toBeGreaterThan(selectionAt);
    expect(layeredAt).toBeGreaterThan(selectionAt);
  });

  it('drops them BEFORE the rails that publish and widen the selection', () => {
    // Ordering is load-bearing twice over. Before `byWorkspace.set`, or the run executes the
    // unfiltered set anyway. Before the `< 1` rail, or a selection emptied by filtering is
    // narrowed to nothing and passes vacuously under --passWithNoTests — a false green, the
    // exact outcome the whole selector is written to avoid.
    const playwrightFilterAt = AFFECTED_TESTS_SRC.indexOf('ownedByPlaywright(f)');
    const layeredFilterAt = AFFECTED_TESTS_SRC.indexOf('unitExcludedVitestTest(f)');
    const publishAt = AFFECTED_TESTS_SRC.indexOf('byWorkspace.set(t.ws.name');
    const widenAt = AFFECTED_TESTS_SRC.indexOf('result.selected.length < 1');

    expect(playwrightFilterAt).toBeGreaterThan(-1);
    expect(layeredFilterAt).toBeGreaterThan(-1);
    expect(publishAt).toBeGreaterThan(-1);
    expect(widenAt).toBeGreaterThan(-1);
    expect(playwrightFilterAt).toBeLessThan(publishAt);
    expect(playwrightFilterAt).toBeLessThan(widenAt);
    expect(layeredFilterAt).toBeLessThan(publishAt);
    expect(layeredFilterAt).toBeLessThan(widenAt);
  });

  it('announces the drop instead of shrinking the run silently', () => {
    // A selection that quietly loses files is indistinguishable from one that never had them.
    expect(AFFECTED_TESTS_SRC).toMatch(/RELATED_SELECTION_FOREIGN_RUNNER/);
    expect(AFFECTED_TESTS_SRC).toMatch(/RELATED_SELECTION_UNIT_EXCLUDED/);
  });
});

describe('unitExcludedVitestTest', () => {
  it.each([
    'lib/a.integration.test.ts',
    'lib/a.integration.test.mts',
    'lib/a.browser.test.tsx',
    'C:\\repo\\lib\\a.browser.test.jsx',
  ])('recognizes a layered test excluded by the shared unit config: %s', (file) => {
    expect(unitExcludedVitestTest(file)).toBe(true);
  });

  it.each(['lib/a.test.ts', 'lib/a.integration.spec.ts', 'lib/a.browser-test.ts', 'lib/a.integration.test.ts.snap'])(
    'does not over-classify a unit/custom-config path: %s',
    (file) => {
      expect(unitExcludedVitestTest(file)).toBe(false);
    },
  );

  it('recognizes the exact P-004 integration test that poisoned test:related', () => {
    expect(
      unitExcludedVitestTest(
        join(REPO_ROOT, 'packages/operator-core/lib/resource-governor/live-health-monitor.integration.test.ts'),
      ),
    ).toBe(true);
  });
});

describe('behaviour: the real apps/operator selection carries no Playwright spec', () => {
  const OPERATOR = join(REPO_ROOT, 'apps/operator');

  it('selects the e2e specs by import-graph, then excludes them by runner ownership', () => {
    // A change under app/_components reaches the two specs through the real import graph —
    // this is the actual mechanism that produced the frozen gate, not a synthetic fixture.
    const isOwned = playwrightOwnedTest(OPERATOR);
    const result = selectRelatedTests({
      rootDir: OPERATOR,
      changedPaths: [join(OPERATOR, 'app/_components/ChromeShell.tsx')],
      aliases: [],
    });

    if (result.mode !== 'related') {
      // Nothing to assert about narrowing when the selector widened; the wiring rails above
      // still hold. Skip rather than assert a vacuous pass.
      expect(result.mode).toBe('full');
      return;
    }

    const owned = result.selected.filter((f: string) => isOwned(f));
    const kept = result.selected.filter((f: string) => !isOwned(f));

    // Positive control: the run must still have real work, or "no Playwright specs" is
    // vacuously true and would stay true if the filter ate everything.
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((f: string) => !f.includes(`${join(OPERATOR, 'e2e')}/`))).toBe(true);
    // Every dropped file is Playwright's, and nothing else was touched.
    expect(owned.every((f: string) => f.endsWith('.spec.ts'))).toBe(true);
  });
});
