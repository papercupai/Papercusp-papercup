/**
 * check-lint-guard-reachability.test.ts — EI-19452618085391226.
 *
 * This suite is deliberately in TWO halves, because a guard-checker can fail in two
 * unrelated ways and only one of them is catchable with fixtures:
 *
 *   1. PURE LOGIC, with a permanent WRONG-IMPLEMENTATION control. The controls are the
 *      point: a classifier that credits any mention as enforcement is the exact mistake
 *      the first draft of this checker made, so it stays in the file forever as a case
 *      the real implementation must beat. A calibration case pins that the real logic
 *      still passes, so the controls cannot go green by the property itself breaking.
 *
 *   2. A REAL-TREE assertion that EXECUTES the checker over this repository. Without
 *      it, this file would be exactly what it exists to detect — a logic-only test that
 *      makes an unenforced guard look covered — and `check-lint-guard-reachability.mjs`
 *      would correctly flag ITSELF. That self-consistency is intentional.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReachabilityCensus,
  classifyGuard,
  extractTestExecutionEvidence,
  resolveImplementationPaths,
  selectGuardScripts,
  ACKNOWLEDGED_UNREACHABLE,
  ACKNOWLEDGED_UNGATEABLE,
  UNREACHABLE_HIGH_WATERMARK,
  sharedImplementationPaths,
  ENFORCING_TEST_RE,
  stripComments,
  computeCoverage,
  deriveScanScope,
  hasEnumeratingLsFiles,
  scanScopeSources,
  workspaceOfPath,
  parseRepoWideRegistrations,
  parseRepoWideRegistrationPairs,
  findInertRepoWideRegistrations,
  ACKNOWLEDGED_PARTIAL_COVERAGE,
  PARTIAL_COVERAGE_HIGH_WATERMARK,
  // @ts-expect-error — untyped .mjs guard script, imported for its pure helpers.
} from '../../../../scripts/check-lint-guard-reachability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = 'scripts/check-lint-guard-reachability.mjs';
// A wedged checker must fail this test with evidence, not hold the lane until the
// affected-suite watchdog reaps it. The normal run completes in a few seconds; this
// leaves generous headroom for a loaded worker while bounding the failure mode.
const CHECKER_TIMEOUT_MS = 120_000;

/** No corpus mentions anything unless a test says so. */
const corpora = (over: Partial<Record<string, string>> = {}) => ({
  gate: '',
  ci: '',
  test: '',
  hook: '',
  'logic-test': '',
  ...over,
});

/* ── the `test` tier takes EXECUTION evidence, not a mention (WI-39832) ────────
 *
 * The corpus for this tier is 424 *.test.ts files concatenated. Tests are the most
 * prose-dense code in the repo and they name guards for every reason EXCEPT running
 * them — so the substring match that is correct for `gate`/`ci` (config that runs a
 * guard by npm name) manufactures enforcement here.
 *
 * All three fixtures below are transcribed from real credits measured on the live
 * tree; the first is the one worth remembering, because the evidence did not merely
 * fail to prove enforcement — it asserted the OPPOSITE.
 */
describe('classifyGuard — the `test` tier takes EXECUTION evidence only', () => {
  const cmd = 'node scripts/check-x.mjs';

  it('does NOT credit a guard named only to assert it is NOT run', () => {
    // VERBATIM SHAPE of green-checkpoint.test.ts's `NEVER gates lint:cell-matrix` case.
    // That assertion exists to keep the guard OUT of the gate (it needs live operators);
    // the census read it as proof something runs it, and reported the guard ENFORCED for
    // ~2 weeks. A padlock scored as a running engine.
    const r = classifyGuard({
      name: 'lint:x',
      command: cmd,
      corpora: corpora({ test: 'expect(scripts, "must not gate").not.toContain("lint:x");' }),
    });
    expect(r.tiers).not.toContain('test');
    expect(r.blocking).toBe(false);
  });

  it('does NOT credit a guard named only in a fixture string', () => {
    // Measured: `lint:plane-adoption` was credited off a fixture literal inside THIS
    // checker's own test file. A census that counts its own fixtures is measuring itself.
    const r = classifyGuard({
      name: 'lint:x',
      command: cmd,
      corpora: corpora({ test: `const src = "{ script: 'lint:x', label: 'PROBE' },";` }),
    });
    expect(r.tiers).not.toContain('test');
  });

  it('does NOT credit a fixture mention beside execution of a different guard', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: cmd,
      corpora: corpora({
        test: `const fixture = "npm run lint:x; scripts/check-x.mjs";\nspawnSync('node', ['scripts/check-y.mjs']);`,
      }),
    });
    expect(r.tiers).not.toContain('test');
    expect(r.blocking).toBe(false);
  });

  it('does NOT credit a guard off a SHARED runner path that names no guard in particular', () => {
    // `scripts/test-files.mjs` is the implementation of lint:tool-prompts, lint:plane-guards
    // AND lint:design-primitives, so any test naming that runner credited all three.
    const shared = sharedImplementationPaths({
      'lint:x': 'node scripts/test-files.mjs a.test.ts',
      'lint:y': 'node scripts/test-files.mjs b.test.ts',
    });
    expect(shared).toContain('scripts/test-files.mjs');

    const r = classifyGuard({
      name: 'lint:x',
      command: 'node scripts/test-files.mjs a.test.ts',
      corpora: corpora({ test: "spawnSync('node', ['scripts/test-files.mjs'])" }),
      sharedImpls: shared,
    });
    expect(r.tiers).not.toContain('test');
  });

  it('DOES credit a test that runs the guard by its own implementation path', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: cmd,
      corpora: corpora({ test: "execFileSync('node', ['scripts/check-x.mjs'], { cwd: REPO_ROOT })" }),
    });
    expect(r.tiers).toContain('test');
    expect(r.blocking).toBe(true);
  });

  it('DOES credit a test that runs the guard by npm name, including argv spelling', () => {
    for (const invocation of ["execSync('npm run lint:x')", "spawnSync('npm', ['run', 'lint:x'])"]) {
      const r = classifyGuard({ name: 'lint:x', command: cmd, corpora: corpora({ test: invocation }) });
      expect(r.tiers, invocation).toContain('test');
    }
  });

  it('DOES credit runGuardScript when its executable arguments name this guard', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: cmd,
      corpora: corpora({ test: "runGuardScript('node', ['scripts/check-x.mjs'], { cwd: REPO_ROOT })" }),
    });
    expect(r.tiers).toContain('test');
  });

  it('binds an imported scanTree call to the guard module it actually scans', () => {
    const evidence = extractTestExecutionEvidence(
      `import { scanTree as runScan } from '../../../../scripts/check-x.mjs'; runScan();`,
      'packages/operator-core/lib/__tests__/x.test.ts',
    );
    expect(evidence.implementationPaths).toContain('scripts/check-x.mjs');
  });

  it('resolves a guard path assigned through a nullish fallback before executing it', () => {
    const evidence = extractTestExecutionEvidence(
      `
        import { join } from 'node:path';
        const GUARD_REL = 'scripts/check-x.mjs';
        const GUARD = process.env.GUARD_UNDER_TEST ?? join(ROOT, GUARD_REL);
        execFileSync('node', [GUARD, '--list']);
      `,
      'packages/operator-core/lib/__tests__/x.test.ts',
    );
    expect(evidence.implementationPaths).toContain('scripts/check-x.mjs');
  });

  it('keeps a path composed from the repository root as one executed script argument', () => {
    const evidence = extractTestExecutionEvidence(
      `
        import { join as pathJoin, resolve as pathResolve } from 'node:path';
        const REPO_ROOT = pathResolve(pathJoin(__dirname, '..', '..', '..', '..'));
        const GUARD_REL = 'scripts/check-x.mjs';
        const GUARD = process.env.GUARD_UNDER_TEST ?? pathJoin(REPO_ROOT, GUARD_REL);
        execFileSync('node', [GUARD, '--list']);
      `,
      'apps/operator/scripts/__tests__/x.test.ts',
    );

    expect([...evidence.implementationPaths]).toEqual(['../../../../scripts/check-x.mjs']);
  });

  it('does not let a LONGER guard name credit its own prefix', () => {
    // `lint:no-retired` is a prefix of `lint:no-retired-resurrection` and both are real.
    const r = classifyGuard({
      name: 'lint:x',
      command: 'node scripts/check-x.mjs',
      corpora: corpora({ test: "spawnSync('npm', ['run', 'lint:x-extended'])" }),
    });
    expect(r.tiers).not.toContain('test');
  });

  it('leaves the gate/ci/hook tiers matching by NAME — there a mention IS the evidence', () => {
    // The asymmetry is the whole design: narrowing these too would report every
    // gate-run guard as unenforced, which is the false positive that red-pins a fleet.
    for (const tier of ['gate', 'ci', 'hook'] as const) {
      const r = classifyGuard({ name: 'lint:x', command: cmd, corpora: corpora({ [tier]: "'lint:x'" }) });
      expect(r.tiers, tier).toContain(tier);
    }
  });

  /* ── the MIRROR failure: a structurally-enforced guard scored by mention ──────
   * Three guards are IMPLEMENTED AS *.test.ts files (lint:tool-prompts,
   * lint:plane-guards, lint:design-primitives). vitest runs those by existence, so no
   * one has to mention them — yet `lint:tool-prompts` was credited only because seven
   * unrelated suites happen to name `tools-md-sync.test.ts`. Same root cause, opposite
   * failure direction: delete those incidental mentions and a genuinely-enforced guard
   * reads as "runs on NO blocking path", reddening the gate with a false finding.
   */
  it('credits a guard IMPLEMENTED AS a tracked test file with NO mention anywhere', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: 'node scripts/test-files.mjs packages/operator-core/lib/__tests__/x-sync.test.ts',
      corpora: corpora({}), // every corpus EMPTY — nothing names this guard at all
      trackedTestFiles: new Set(['packages/operator-core/lib/__tests__/x-sync.test.ts']),
    });
    expect(r.tiers).toContain('test');
    expect(r.blocking).toBe(true);
  });

  it('does NOT credit a test-file implementation that is not tracked', () => {
    // An untracked path is invisible to vitest's selection just as it is to the corpus
    // builder, so existence alone is not the claim — TRACKED existence is.
    const r = classifyGuard({
      name: 'lint:x',
      command: 'node scripts/test-files.mjs packages/operator-core/lib/__tests__/x-sync.test.ts',
      corpora: corpora({}),
      trackedTestFiles: new Set(),
    });
    expect(r.tiers).not.toContain('test');
  });

  it('CONTROL: the OLD rule credits every fixture above — that gap is the bug', () => {
    // Kept permanently. Without it the six assertions above would also pass against a
    // classifier that credits NOTHING, and would silently stop testing anything.
    const creditsAnyMention = (text: string, name: string, impls: string[]) =>
      text.includes(name) || impls.some((p) => text.includes(p));

    expect(creditsAnyMention('expect(scripts).not.toContain("lint:x");', 'lint:x', [])).toBe(true);
    expect(creditsAnyMention(`const src = "{ script: 'lint:x' }";`, 'lint:x', [])).toBe(true);
    expect(
      creditsAnyMention("spawnSync('node', ['scripts/test-files.mjs'])", 'lint:x', ['scripts/test-files.mjs']),
    ).toBe(true);
  });

  it('CALIBRATION: per-file attribution alone would NOT have fixed this', () => {
    // The obvious remedy — stop concatenating the corpus, attribute per file — measured
    // ZERO revoked credits on the live tree: the enforcing marker and the mention already
    // co-occur in the same file. Pinned so nobody re-derives the wrong fix. Here the ONE
    // file both matches ENFORCING_TEST_RE and names the guard, and it still must not count.
    const oneFile = 'const r = spawnSync(BIN, [], { cwd: REPO_ROOT });\nexpect(legs).not.toContain("lint:x");';
    expect(ENFORCING_TEST_RE.test(oneFile)).toBe(true);
    expect(oneFile.includes('lint:x')).toBe(true);

    const r = classifyGuard({ name: 'lint:x', command: cmd, corpora: corpora({ test: oneFile }) });
    expect(r.tiers).not.toContain('test');
  });
});

describe('ACKNOWLEDGED_UNGATEABLE — a population the watermark must not ration', () => {
  it('is disjoint from the shrink-only debt set', () => {
    // An entry in both would be counted as debt AND excused as by-design — the shape that
    // lets a permanent exclusion quietly consume a debt slot.
    for (const name of ACKNOWLEDGED_UNGATEABLE.keys()) {
      expect(ACKNOWLEDGED_UNREACHABLE.has(name), name).toBe(false);
    }
  });

  it('does not spend the debt ceiling', () => {
    // The guarantee that matters: adding a by-design exclusion must never make the NEXT
    // real debt entry fail the watermark.
    expect(ACKNOWLEDGED_UNREACHABLE.size).toBeLessThanOrEqual(UNREACHABLE_HIGH_WATERMARK);
    expect(ACKNOWLEDGED_UNREACHABLE.size + ACKNOWLEDGED_UNGATEABLE.size).toBeGreaterThan(
      ACKNOWLEDGED_UNREACHABLE.size,
    );
  });

  it('gives every entry a reason naming why RUNNING it in the gate is unsound', () => {
    // Cost is never a reason to sit here (that is the wire-or-retire probe's job).
    for (const [name, reason] of ACKNOWLEDGED_UNGATEABLE) {
      expect(reason, name).toMatch(/design|live|operator|checkpoint tree/i);
    }
  });
});

describe('selectGuardScripts', () => {
  it('collapses companion invocations onto their base guard', () => {
    // Enforcement is a property of the IMPLEMENTATION, not of how many npm aliases
    // point at it — counting `lint:x` and `lint:x:strict` separately double-counts.
    const picked = selectGuardScripts({
      'lint:x': 'node scripts/x.mjs',
      'lint:x:strict': 'node scripts/x.mjs --strict',
      'lint:x:fix': 'node scripts/x.mjs --fix',
      'lint:x:update': 'node scripts/x.mjs --update',
      'test:affected': 'node scripts/affected.mjs',
    });
    expect(picked).toEqual(['lint:x']);
  });
});

describe('resolveImplementationPaths', () => {
  it('resolves the implementation file across node/tsx/npx invocation forms', () => {
    expect(resolveImplementationPaths('node scripts/check-a.mjs')).toEqual(['scripts/check-a.mjs']);
    expect(resolveImplementationPaths('tsx scripts/check-b.mjs --strict')).toEqual(['scripts/check-b.mjs']);
    expect(resolveImplementationPaths('node apps/operator/scripts/check-c.mjs')).toEqual([
      'apps/operator/scripts/check-c.mjs',
    ]);
    expect(resolveImplementationPaths('tsx scripts/project-authored-docs.mts --check')).toEqual([
      'scripts/project-authored-docs.mts',
    ]);
  });

  it('returns nothing for a guard with no script file, so it is matched by name alone', () => {
    // `knip --no-config-hints` has no implementation path of ours to search for.
    expect(resolveImplementationPaths('knip --no-config-hints')).toEqual([]);
  });
});

describe('classifyGuard — a mention is not enforcement', () => {
  const scripts = { 'lint:x': 'node scripts/check-x.mjs', 'gen:foo': 'node scripts/gen-foo.mjs' };

  it('credits a guard the release gate runs', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ gate: "'lint:x'" }) });
    expect(r.blocking).toBe(true);
    expect(r.tier).toBe('gate');
  });

  /* ── the REGISTRATION-ONLY tier (WI-37627, the ed2c4f36 gate red) ────────────
   * These pin `repo-wide` at the classifyGuard level ON PURPOSE. The real-tree
   * assertion further down also fails when this tier is broken, but only for as
   * long as some guard is registration-ONLY — and the incident report notes that
   * all 11 registrations pre-dating this tier ALSO carry a corpus mention, so
   * their green was incidental. The moment `lint:no-ungated-mug-kettle` picks up
   * a CI job or a test that names it, the real-tree signal goes quiet and the
   * blind spot re-hides behind the same coincidence that hid it for months.
   * These cases do not depend on the tree's contents at all.
   */
  it('credits a guard whose ONLY wiring is a REPO_WIDE_INVARIANT_GUARDS registration', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({}), // named by NO gate, ci, test, hook or logic-test
      repoWideRegistered: new Set(['lint:x']),
    });
    expect(r.blocking).toBe(true);
    expect(r.tier).toBe('repo-wide');
  });

  // CONTROL for the case above: identical inputs, registration withdrawn. Without
  // this, that test would also pass if `repo-wide` were unconditionally blocking.
  it('CONTROL: the same guard, unregistered, is still reported as run by nothing', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({}),
      repoWideRegistered: new Set(),
    });
    expect(r.blocking).toBe(false);
    expect(r.tier).toBe(null);
  });

  /* Guard names NEST in this repo — `lint:no-retired` is a prefix of
   * `lint:no-retired-resurrection`, and BOTH are registered. The corpora axis
   * matches by substring, so spelling this membership the same way would credit
   * the shorter name off the longer one's registration and manufacture exactly
   * the false green this checker exists to prevent. The implementation uses an
   * exact Set lookup; this pins that choice, which is otherwise invisible.
   */
  it('does NOT credit a guard whose name is merely a PREFIX of a registered one', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({}),
      repoWideRegistered: new Set(['lint:x-strict']),
    });
    expect(r.blocking).toBe(false);
  });

  /* A guard's BLOCKING mode usually lives in a companion alias (`lint:x` reports and
   * exits 0; `lint:x:fail` exits 1), so the correct registration names the `:fail`
   * half — registering the base would buy full coverage of a script that can never
   * red anything. An exact-Set lookup reported that correct registration as absent
   * (measured 2026-08-16 on `lint:di-seam-arity-strands`, which was wired properly and
   * still failed the coverage axis). Enforcement is a property of the IMPLEMENTATION,
   * not of which alias points at it.
   */
  it('CREDITS the base guard when its `:fail` companion alias is what is registered', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({}),
      repoWideRegistered: new Set(['lint:x:fail']),
    });
    expect(r.tiers).toContain('repo-wide');
    expect(r.blocking).toBe(true);
  });

  /* FAIL-CLOSED CONTROL for the alias hop. The `gen:*:check` family is the one place the
   * collapse must NOT happen: `gen:foo` WRITES the artifact and `gen:foo:check` is the only
   * half that asserts drift, so crediting the writer would certify a script whose job is to
   * overwrite the very thing it would have to fail on. If this goes quiet, the alias hop has
   * been widened into the hole GEN_CHECK_RE exists to keep shut.
   */
  it('does NOT credit a `gen:` WRITER off its `:check` guard registration', () => {
    const r = classifyGuard({
      name: 'gen:foo',
      command: scripts['gen:foo'],
      corpora: corpora({}),
      repoWideRegistered: new Set(['gen:foo:check']),
    });
    expect(r.tiers).not.toContain('repo-wide');
    expect(r.blocking).toBe(false);
  });

  // The tier is appended AFTER the corpora so a guard that is both registered and
  // named by a real gate leg keeps reporting the more specific tier — which is why
  // adding this tier did not change how the 11 pre-existing registrations report.
  it('keeps reporting the more specific tier for a guard that is BOTH registered and gate-run', () => {
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ gate: "'lint:x'" }),
      repoWideRegistered: new Set(['lint:x']),
    });
    expect(r.tier).toBe('gate');
    expect(r.tiers).toContain('repo-wide');
  });

  it('finds a guard invoked by direct PATH rather than npm name', () => {
    // The under-claim this checker exists to avoid: several guards run from hooks by
    // script path and never by npm name, so searching for the name alone reports a
    // false UNREACHABLE and sends someone to wire an already-covered guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ hook: 'node scripts/check-x.mjs' }),
    });
    expect(r.tiers).toContain('hook');
  });

  it('does NOT count a logic-only unit test as enforcement (the motivating case)', () => {
    // `lint:mock-cast-escape` had a fully green unit test of its helpers throughout the
    // window its real-tree count drifted +45 past baseline. Green detector, rotting guard.
    const r = classifyGuard({
      name: 'lint:x',
      command: scripts['lint:x'],
      corpora: corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" }),
    });
    expect(r.blocking).toBe(false);
    expect(r.tier).toBe('logic-test');
  });

  it('does NOT count a hook as enforcement — it nudges one agent and blocks nothing', () => {
    const r = classifyGuard({ name: 'lint:x', command: scripts['lint:x'], corpora: corpora({ hook: 'scripts/check-x.mjs' }) });
    expect(r.blocking).toBe(false);
  });
});

describe('ENFORCING_TEST_RE — the discriminator', () => {
  it('separates a real-tree execution from a fixture-driven unit test', () => {
    expect(ENFORCING_TEST_RE.test("execFileSync('node', [SCRIPT])")).toBe(true);
    expect(ENFORCING_TEST_RE.test('listTrackedFiles(REPO_ROOT)')).toBe(true);
    // A pure-helper test: imports the detector, feeds it a string, asserts. Enforces nothing.
    expect(ENFORCING_TEST_RE.test("expect(findEscapes('x as never')).toHaveLength(1)")).toBe(false);
  });

  it('credits runGuardScript — the helper that spawns a guard on a test’s behalf', () => {
    // EI-20692923474318761: runGuardScript wraps spawnSync so a red carries the guard's own report.
    // The marker therefore moves OUT of the test and into the helper, and a test that
    // adopts it while letting the helper own the cwd would carry none of the other
    // markers — enforcing the guard for real, classified as advisory.
    expect(ENFORCING_TEST_RE.test("const g = runGuardScript('node', ['scripts/check-x.mjs'], opts);")).toBe(true);

    // Calibration: the promotion above must not have blunted the discriminator. A
    // fixture-driven test still enforces nothing, however the guard is spawned elsewhere.
    expect(ENFORCING_TEST_RE.test("expect(findOffendersInSource('f.mjs', src)).toHaveLength(1)")).toBe(false);
  });
});

describe('stripComments — prose about a guard is not a runner of it', () => {
  it('drops a comment block that merely NAMES a guard', () => {
    // This fired for real: the green-checkpoint leg added for this very check carries a
    // comment naming `lint:mock-cast-escape` as its motivating example, and that one
    // sentence reclassified the rotting guard from `logic-test` to `gate` — the checker
    // declaring its own motivating case enforced.
    const src = ['// EI-123: lint:mock-cast-escape drifted +45 past baseline.', "const x = 1;"].join('\n');
    expect(stripComments(src)).not.toContain('lint:mock-cast-escape');
    expect(stripComments(src)).toContain('const x = 1;');
  });

  it('drops JSDoc continuation lines, not just `//`', () => {
    const src = ['/**', ' * lint:some-guard is the example here.', ' */', "run('lint:real-guard');"].join('\n');
    expect(stripComments(src)).not.toContain('lint:some-guard');
    expect(stripComments(src)).toContain('lint:real-guard');
  });

  it('PRESERVES a real invocation on a code line (the regression that ate a wired guard)', () => {
    // `lint:plane-adoption` is wired at green-checkpoint.ts:5094 as a plain array entry.
    // A block-comment regex (`/\*[\s\S]*?\*\//`) removed that line outright, reporting a
    // properly-gated guard as unenforced — an unbalanced `/*` inside any string or regex
    // earlier in a 5000-line file lets the match run for thousands of lines.
    const src = "      { script: 'lint:plane-adoption', label: 'ADOPTION PROBE' },";
    expect(stripComments(src)).toContain('lint:plane-adoption');
  });

  it('keeps string literals, since a real invocation lives inside one', () => {
    expect(stripComments("exec('npm', ['run', 'lint:x'])")).toContain('lint:x');
  });

  it('strips YAML comments without touching a workflow run: line', () => {
    const src = ['# lint:documented-only is discussed here', '  - run: npm run lint:actually-run'].join('\n');
    const out = stripComments(src, { yaml: true });
    expect(out).not.toContain('lint:documented-only');
    expect(out).toContain('lint:actually-run');
  });
});

describe('buildReachabilityCensus', () => {
  it('reports a guard that nothing runs at all', () => {
    const c = buildReachabilityCensus({ scripts: { 'lint:orphan': 'node scripts/check-orphan.mjs' }, corpora: corpora() });
    expect(c.unreachable.map((r: { name: string }) => r.name)).toEqual(['lint:orphan']);
    expect(c.notEnforced).toHaveLength(1);
  });

  it('surfaces a NEW guard as debt without anyone listing it', () => {
    // The anti-drift property: the population comes from the scan, so a guard added
    // today cannot avoid the census by not being mentioned here.
    const c = buildReachabilityCensus({
      scripts: { 'lint:brand-new': 'node scripts/check-brand-new.mjs' },
      corpora: corpora(),
      acknowledged: new Map(),
    });
    expect(c.unacknowledged.map((r: { name: string }) => r.name)).toEqual(['lint:brand-new']);
  });

  it('does not fail a guard whose unenforcement is acknowledged', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:known': 'node scripts/check-known.mjs' },
      corpora: corpora(),
      acknowledged: new Map([['lint:known', 'pending decision']]),
    });
    expect(c.unacknowledged).toHaveLength(0);
    expect(c.notEnforced).toHaveLength(1); // acknowledged is not enforced
  });

  it('catches an allowlist entry for a guard that no longer exists', () => {
    // A stale entry keeps asserting a pending decision about nothing — and silently
    // consumes watermark budget that a real guard would otherwise have to justify.
    const c = buildReachabilityCensus({
      scripts: { 'lint:live': 'node scripts/check-live.mjs' },
      corpora: corpora({ gate: "'lint:live'" }),
      acknowledged: new Map([['lint:deleted-last-month', 'pending decision']]),
    });
    expect(c.staleAcknowledgements).toEqual(['lint:deleted-last-month']);
  });

  it('propagates reachability through an npm-run chain', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:agg': 'npm run lint:leaf', 'lint:leaf': 'node scripts/check-leaf.mjs' },
      corpora: corpora({ gate: "'lint:agg'" }),
    });
    expect(c.notEnforced).toHaveLength(0);
  });

  /* ── permanent WRONG-IMPLEMENTATION controls ───────────────────────────────
   * These stay in the file forever. Each encodes a classifier that looks right and
   * is wrong in a way that already happened; the assertions state what that mistake
   * costs. Without them, every test above also passes on a checker that credits any
   * mention at all as enforcement. */

  it('CONTROL: a classifier that credits ANY mention misses the rotting guard', () => {
    const creditsAnyMention = (corp: Record<string, string>, impl: string) =>
      Object.values(corp).some((t) => t.includes(impl));

    const logicOnly = corpora({ 'logic-test': "import { decide } from 'scripts/check-x.mjs'" });

    // The wrong implementation calls this guard covered …
    expect(creditsAnyMention(logicOnly, 'scripts/check-x.mjs')).toBe(true);
    // … while the real one correctly reports it as not enforced. That gap is the bug.
    const real = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: logicOnly });
    expect(real.blocking).toBe(false);
  });

  it('CALIBRATION: the real classifier still credits genuine enforcement', () => {
    // Guards the controls above: if the real implementation ever stopped crediting
    // ANYTHING, every control would pass for the wrong reason.
    const gated = classifyGuard({ name: 'lint:x', command: 'node scripts/check-x.mjs', corpora: corpora({ gate: "'lint:x'" }) });
    expect(gated.blocking).toBe(true);
  });
});

/* ── COVERAGE: enforced ≠ enforced EVERYWHERE (EI-19461064447747454) ──────────── */

describe('workspaceOfPath', () => {
  const dirs = ['apps/operator', 'packages/operator-core', 'libs/papercusp/packages/harness'];

  it('attributes a file to its workspace', () => {
    expect(workspaceOfPath('packages/operator-core/lib/x.ts', dirs)).toBe('packages/operator-core');
  });

  it('prefers the LONGEST matching prefix, so a nested workspace wins over its parent', () => {
    // `libs/papercusp` is not itself a workspace here; the nested one must win rather
    // than the first entry that happens to match.
    expect(workspaceOfPath('libs/papercusp/packages/harness/src/a.ts', [...dirs, 'libs'])).toBe(
      'libs/papercusp/packages/harness',
    );
  });

  it('returns null for a path in no workspace, rather than guessing one', () => {
    expect(workspaceOfPath('scripts/check-x.mjs', dirs)).toBeNull();
  });

  it('does not treat a name-prefix collision as containment', () => {
    // `apps/operator-vite/...` must NOT be attributed to `apps/operator`.
    expect(workspaceOfPath('apps/operator-vite/src/a.ts', dirs)).toBeNull();
  });
});

describe('deriveScanScope', () => {
  it('reads a declared bounded root array', () => {
    const s = deriveScanScope("const SOURCE_ROOTS = ['apps/operator/lib', 'packages/agent-mcp/src'];");
    expect(s.kind).toBe('bounded');
    expect(s.roots).toEqual(['apps/operator/lib', 'packages/agent-mcp/src']);
  });

  it('detects a repo-wide enumeration via listTrackedFiles', () => {
    expect(deriveScanScope('const { files } = listTrackedFiles(ROOT);').kind).toBe('repo-wide');
  });

  it("detects the git ARGV form, where the literal is 'ls-files' and never 'git ls-files'", () => {
    // The regression this pins: matching the prose form `git ls-files` reported two
    // genuinely repo-wide guards as having no detectable scan at all.
    expect(deriveScanScope("execFileSync('git', ['ls-files', '*.test.ts'])").kind).toBe('repo-wide');
  });

  it('prefers bounded roots over a repo-wide call, because the roots FILTER it', () => {
    const s = deriveScanScope(
      "const SCAN_ROOTS = ['apps/operator/lib'];\nconst all = listTrackedFiles(ROOT);",
    );
    expect(s.kind).toBe('bounded');
  });

  it('classifies a diff-driven guard, which has no directory scope at all', () => {
    expect(deriveScanScope("const filesArg = argv.find((a) => a.startsWith('--files='));").kind).toBe('diff-driven');
  });

  it('says undetermined rather than inventing a scope', () => {
    expect(deriveScanScope('const port = 3170;').kind).toBe('undetermined');
  });
});

/**
 * Measured 2026-10-12 (WI-6554700010009165). scripts/lint-as-committed.mjs gained a
 * single-path `git ls-files -- <one file>` membership probe on 2026-10-08. The bare
 * `'ls-files'` match scored the runner `repo-wide` → `partial`, and the SHRINK-ONLY
 * partial set red-pinned `lint:guard-reachability`, though nothing enumerated the tree.
 */
describe('hasEnumeratingLsFiles — a single-path membership probe enumerates nothing', () => {
  /** The exact probe scripts/lint-as-committed.mjs carries. */
  const AS_COMMITTED_PROBE =
    "const tracked = spawnSync('git', ['-C', dirname(priorTarget), 'ls-files', '--', basename(priorTarget)],\n" +
    "  { encoding: 'utf8', timeout: 15000 });";

  it('does not read the as-committed probe as a whole-tree scan', () => {
    expect(hasEnumeratingLsFiles(AS_COMMITTED_PROBE)).toBe(false);
    expect(deriveScanScope(AS_COMMITTED_PROBE).kind).toBe('undetermined');
  });

  it('accepts flags before `--` and a bare runtime identifier as the one pathspec', () => {
    expect(hasEnumeratingLsFiles('git(["ls-files", "--error-unmatch", "--", repoPath])')).toBe(false);
    expect(hasEnumeratingLsFiles("run('git', ['ls-files', '--stage', '--', parentRelativePath,])")).toBe(false);
  });

  it('CONTROL: the probe beside a real enumeration is still repo-wide', () => {
    expect(deriveScanScope(`${AS_COMMITTED_PROBE}\nconst all = git(['ls-files', '-z']);`).kind).toBe('repo-wide');
  });

  it.each([
    ["git(['ls-files', '--', '*.ts', '*.tsx'])", 'string-literal globs'],
    ["execFileSync('git', ['ls-files', '*.test.ts'])", 'a glob with no `--`'],
    ["run('git', ['ls-files', '-z', '--', ...absolutePaths], { cwd: root })", 'a spread pathspec'],
    ["git(['ls-files', '--', first, second])", 'two pathspecs'],
    ["git(['ls-files', '--', cfg.root])", 'a member expression'],
    ["git('ls-files')", 'no pathspec at all'],
    ["git(['ls-files', '-z', '--recurse-submodules'])", 'flags only'],
    ["const DOCS_PREFIX = 'apps/docs/';\ngit(['ls-files', '-z', '--', DOCS_PREFIX])", 'a directory-prefix constant'],
    ["const pathspec = `${dir}/*.sql`;\ngit(['ls-files', '--others', '--', pathspec])", 'a glob-bound identifier'],
  ])('still reads %s as an enumeration (%s)', (src) => {
    expect(hasEnumeratingLsFiles(src)).toBe(true);
    expect(deriveScanScope(src).kind).toBe('repo-wide');
  });

  it('the as-committed row is no longer scored `partial` (CONTROL: a real enumeration still is)', () => {
    const row = { name: 'lint:as-committed', tier: 'test', blocking: true, impls: ['scripts/lint-as-committed.mjs'] };
    const args = {
      row,
      enforcingTestPaths: ['packages/operator-core/lib/__tests__/lint-as-committed.test.ts'],
      workspaceDirs: ['apps/operator', 'packages/operator-core'],
    };
    // Positive control: this exact row DOES score `partial` once its source really enumerates,
    // so the `undetermined` below is the probe rule speaking, not an artifact of the row setup.
    const enumerating = `${AS_COMMITTED_PROBE}\nconst all = git(['ls-files', '-z']);`;
    expect(computeCoverage({ ...args, implSource: enumerating }).verdict).toBe('partial');
    // The probe alone is no scan-shape claim, so coverage is honestly unmeasured.
    expect(computeCoverage({ ...args, implSource: AS_COMMITTED_PROBE }).verdict).toBe('undetermined');
  });
});

describe('parseRepoWideRegistrations', () => {
  const src = [
    'const REPO_WIDE_INVARIANT_GUARDS = [',
    "  { workspace: '@papercusp/operator-core', script: 'lint:chunk-safe' },",
    "  { workspace: '@papercusp/operator-core', script: 'lint:partial-index-alignment' },",
    '];',
    "const other = { script: 'lint:not-registered' };",
  ].join('\n');

  it('parses the registered guards', () => {
    expect([...parseRepoWideRegistrations(src)]).toEqual(['lint:chunk-safe', 'lint:partial-index-alignment']);
  });

  it('stops at the array literal, so an unrelated `script:` is not over-credited', () => {
    // Over-crediting here would silently mark a partially-covered guard as full — the
    // same false-green this whole axis exists to remove.
    expect(parseRepoWideRegistrations(src).has('lint:not-registered')).toBe(false);
  });

  it('resolves a static constant used by a live repo-wide registration', () => {
    const constantBacked = [
      "const AUTHORED_DOC_GUARD_SCRIPT = 'gen:authored-docs:check';",
      'const REPO_WIDE_INVARIANT_GUARDS = [',
      "  { workspace: '@papercusp/operator-core', script: AUTHORED_DOC_GUARD_SCRIPT },",
      '];',
      "const unrelated = { script: 'lint:not-registered' };",
    ].join('\n');

    expect([...parseRepoWideRegistrations(constantBacked)]).toEqual(['gen:authored-docs:check']);
    expect(parseRepoWideRegistrationPairs(constantBacked)).toEqual([
      { workspace: '@papercusp/operator-core', script: 'gen:authored-docs:check' },
    ]);
  });

  it('returns an empty set when the block is absent, never a crash', () => {
    expect(parseRepoWideRegistrations('const x = 1;').size).toBe(0);
  });
});

describe('INERT registrations — registering a guard is a CLAIM, declaring the script is the fact (WI-37454)', () => {
  // MEASURED: `lint:drop-database-force` was registered in REPO_WIDE_INVARIANT_GUARDS but
  // never declared by @papercusp/operator-core, so affected-tests.mjs:815 skipped it
  // silently — it ran on NO path — while coverageOf credited it `full` for being present in
  // the registry. The reporting surface hid the absence it existed to report.
  const src = [
    'const REPO_WIDE_INVARIANT_GUARDS = [',
    '  {',
    '    // a prose mention of script: lint:commented-out must not be parsed',
    "    workspace: '@papercusp/operator-core',",
    "    script: 'lint:declared-one',",
    '    appliesTo: () => true,',
    '  },',
    '  {',
    "    workspace: '@papercusp/operator-core',",
    "    script: 'lint:undeclared-one',",
    '  },',
    '];',
  ].join('\n');

  it('keeps the workspace of each registration, not just the script name', () => {
    expect(parseRepoWideRegistrationPairs(src)).toEqual([
      { workspace: '@papercusp/operator-core', script: 'lint:declared-one' },
      { workspace: '@papercusp/operator-core', script: 'lint:undeclared-one' },
    ]);
  });

  it('does not parse a script named only inside a comment', () => {
    // Annotated because the SUT is an untyped .mjs import, so its return is `any` and an
    // unannotated callback parameter trips noImplicitAny (TS7006) in this workspace.
    const pairs = parseRepoWideRegistrationPairs(src) as { workspace: string; script: string }[];
    expect(pairs.some((p) => p.script === 'lint:commented-out')).toBe(false);
  });

  const scriptsByWorkspaceName = new Map([['@papercusp/operator-core', new Set(['lint:declared-one'])]]);

  it('flags ONLY the registration whose workspace does not declare the script', () => {
    const inert = findInertRepoWideRegistrations({
      pairs: parseRepoWideRegistrationPairs(src),
      scriptsByWorkspaceName,
    });
    expect(inert).toEqual([{ workspace: '@papercusp/operator-core', script: 'lint:undeclared-one' }]);
  });

  it('CONTROL — an implementation that credits mere registration reports nothing, and is wrong', () => {
    // The permanent wrong-implementation control this file's header prescribes: this is
    // exactly what the checker did before WI-37454, and it must stay red-able forever.
    const creditAnyRegistration = () => [];
    expect(creditAnyRegistration()).toHaveLength(0);
    expect(
      findInertRepoWideRegistrations({ pairs: parseRepoWideRegistrationPairs(src), scriptsByWorkspaceName }),
    ).not.toHaveLength(0);
  });

  it('FAILS OPEN for a workspace absent from the map, rather than inventing a violation', () => {
    // An unreadable/unparseable package.json must not red-pin the fleet gate on a file the
    // checker could not read — the same stance as the unreadable-registration-source branch.
    expect(
      findInertRepoWideRegistrations({
        pairs: parseRepoWideRegistrationPairs(src),
        scriptsByWorkspaceName: new Map(),
      }),
    ).toEqual([]);
  });

  it('REAL TREE — every registration in the live registry is actually declared', () => {
    // The enforcing half: a logic-only version of this axis would itself be the false green
    // this file exists to detect. Executes the checker over THIS repository.
    const out = spawnSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: CHECKER_TIMEOUT_MS,
    });
    expect(`${out.stdout ?? ''}${out.stderr ?? ''}`).not.toMatch(/registration\(s\) are INERT/);
  });
});

describe('computeCoverage', () => {
  const dirs = ['apps/operator', 'packages/operator-core'];
  const testRow = { name: 'lint:x', tier: 'test', blocking: true, impls: ['scripts/check-x.mjs'] };

  it('credits a gate leg with full coverage — it runs unconditionally', () => {
    const c = computeCoverage({ row: { ...testRow, tier: 'gate' }, workspaceDirs: dirs });
    expect(c.verdict).toBe('full');
  });

  it('reports a repo-wide guard enforced from ONE workspace as partial (the WI-9434 shape)', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'listTrackedFiles(ROOT)',
    });
    expect(c.verdict).toBe('partial');
    expect(c.reason).toMatch(/packages\/operator-core/);
  });

  it('counts covered vs scanned roots for a bounded guard', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: "const SOURCE_ROOTS = ['packages/operator-core/lib', 'apps/operator/lib'];",
    });
    expect(c.verdict).toBe('partial');
    expect(c.coveredRoots).toEqual(['packages/operator-core/lib']);
    expect(c.roots).toHaveLength(2);
  });

  it('does NOT flag a guard whose every scanned root lies inside its enforcing workspace', () => {
    // The false-positive direction. Flagging this would send someone to "fix" a guard
    // that is already fully covered.
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: "const SOURCE_ROOTS = ['packages/operator-core/lib'];",
    });
    expect(c.verdict).toBe('full');
  });

  it('treats a REPO_WIDE_INVARIANT_GUARDS registration as full coverage', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'listTrackedFiles(ROOT)',
      repoWideRegistered: new Set(['lint:x']),
    });
    expect(c.verdict).toBe('full');
  });

  it('reports undetermined — never full — when the scan shape is not comparable', () => {
    const c = computeCoverage({
      row: testRow,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: dirs,
      implSource: 'const port = 3170;',
    });
    expect(c.verdict).toBe('undetermined');
  });

  it('does not assume a chained guard is covered by its unmeasured runner', () => {
    expect(computeCoverage({ row: { ...testRow, tier: 'chained' }, workspaceDirs: dirs }).verdict).toBe(
      'undetermined',
    );
  });

  it('says not-enforced for a guard nothing runs, rather than partial', () => {
    expect(computeCoverage({ row: { ...testRow, blocking: false }, workspaceDirs: dirs }).verdict).toBe(
      'not-enforced',
    );
  });
});

/* ── A SHARED TEST RUNNER IS NOT THE GUARD'S IMPLEMENTATION (WI-38290) ──────────
 *
 * Measured 2026-08-12. A peer added a `git ls-files` call to `scripts/test-files.mjs`
 * for unrelated provenance reporting. Three guards merely INVOKE that runner
 * (`lint:tool-prompts`, `lint:plane-guards`, `lint:design-primitives`); the coverage
 * axis concatenated every resolved impl's source, so all three inherited scan scope
 * `repo-wide` from the runner. `lint:tool-prompts` scored `partial` off it, and because
 * the partial set is SHRINK-ONLY that red-pinned the green-checkpoint gate — over a
 * guard whose own source had not changed at all.
 *
 * The cases below are permanent. The CONTROL encodes the old, wrong rule so this file
 * would fail if anyone reinstated it; the CALIBRATION makes sure the narrowing did not
 * simply blind the axis, which would make every other case here pass vacuously. */

describe('scanScopeSources — the runner is not what the guard scans (WI-38290)', () => {
  const RUNNER = 'scripts/test-files.mjs';
  const SUBJECT = 'packages/operator-core/lib/__tests__/tools-md-sync.test.ts';
  /** The exact literal the peer's change added to the shared runner. */
  const RUNNER_SRC = "run('git', ['ls-files', '-z', '--', ...absolutePaths], { cwd: root })";
  /** tools-md-sync.test.ts: readdirs a fixed prompts dir; enumerates nothing repo-wide. */
  const SUBJECT_SRC = "const PROMPTS_DIR = join(REPO, 'apps/operator/prompts'); readdirSync(PROMPTS_DIR);";

  it('keeps only the test subjects when a command names both a runner and its subjects', () => {
    expect(scanScopeSources([RUNNER, SUBJECT])).toEqual([SUBJECT]);
  });

  it('returns the impl list unchanged when the guard has its own scanner', () => {
    // `node scripts/check-x.mjs` — nothing to narrow, and narrowing to nothing would
    // silently downgrade every self-implemented guard to `undetermined`.
    expect(scanScopeSources(['scripts/check-x.mjs'])).toEqual(['scripts/check-x.mjs']);
    expect(scanScopeSources([])).toEqual([]);
  });

  it('recognises every test-file shape this repo uses', () => {
    const subjects = [
      'packages/operator-core/lib/a.test.ts',
      'apps/operator/app/_lints/b.test.tsx',
      'packages/operator-core/lib/c.integration.test.ts',
    ];
    expect(scanScopeSources([RUNNER, ...subjects])).toEqual(subjects);
  });

  it('CONTROL: the old rule — read EVERY impl — reproduces the gate red', () => {
    // Concatenating the runner in is what made the guard look repo-wide …
    expect(deriveScanScope([RUNNER_SRC, SUBJECT_SRC].join('\n')).kind).toBe('repo-wide');
    // … and `partial`, which the SHRINK-ONLY set turns into a build failure.
    const naive = computeCoverage({
      row: { name: 'lint:tool-prompts', tier: 'test', blocking: true, impls: [RUNNER, SUBJECT] },
      enforcingTestPaths: [SUBJECT],
      workspaceDirs: ['apps/operator', 'packages/operator-core'],
      implSource: [RUNNER_SRC, SUBJECT_SRC].join('\n'),
    });
    expect(naive.verdict).toBe('partial');
  });

  it('the subject alone is NOT repo-wide, so the guard stops being scored partial', () => {
    expect(deriveScanScope(SUBJECT_SRC).kind).not.toBe('repo-wide');
    const fixed = computeCoverage({
      row: { name: 'lint:tool-prompts', tier: 'test', blocking: true, impls: [RUNNER, SUBJECT] },
      enforcingTestPaths: [SUBJECT],
      workspaceDirs: ['apps/operator', 'packages/operator-core'],
      implSource: scanScopeSources([RUNNER, SUBJECT])
        .map((p: string) => (p === RUNNER ? RUNNER_SRC : SUBJECT_SRC))
        .join('\n'),
    });
    expect(fixed.verdict).not.toBe('partial');
  });

  it('CALIBRATION: a test SUBJECT that really does enumerate the tree is still partial', () => {
    // Without this, the narrowing could be hiding real partial coverage rather than
    // fixing a false positive, and every case above would pass for the wrong reason.
    const scanningSubject = 'packages/operator-core/lib/scans-everything.test.ts';
    const c = computeCoverage({
      row: { name: 'lint:scans', tier: 'test', blocking: true, impls: [RUNNER, scanningSubject] },
      enforcingTestPaths: [scanningSubject],
      workspaceDirs: ['apps/operator', 'packages/operator-core'],
      implSource: scanScopeSources([RUNNER, scanningSubject])
        .map(() => 'const { files } = listTrackedFiles(ROOT);')
        .join('\n'),
    });
    expect(c.verdict).toBe('partial');
  });

  it('end-to-end: the census scores the WI-38290 shape without a partial entry', () => {
    const census = buildReachabilityCensus({
      scripts: { 'lint:tool-prompts': `bash scripts/pc-heavy.sh node ${RUNNER} ${SUBJECT}` },
      corpora: corpora({ gate: "'lint:tool-prompts'" }),
      coverage: {
        enforcingTests: [{ path: SUBJECT, text: `runs ${SUBJECT}` }],
        workspaceDirs: ['apps/operator', 'packages/operator-core'],
        implSources: new Map([
          [RUNNER, RUNNER_SRC],
          [SUBJECT, SUBJECT_SRC],
        ]),
        repoWideRegistered: new Set<string>(),
      },
    });
    expect(census.partiallyCovered).toHaveLength(0);
  });
});

describe('buildReachabilityCensus — the coverage axis is additive', () => {
  it('computes NO coverage when the caller supplies none, rather than defaulting to full', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:x': 'node scripts/check-x.mjs' },
      corpora: corpora({ gate: "'lint:x'" }),
    });
    expect(c.rows[0].coverage).toBeUndefined();
    expect(c.partiallyCovered).toEqual([]);
  });

  it('surfaces a partially-covered guard once coverage inputs are supplied', () => {
    const c = buildReachabilityCensus({
      scripts: { 'lint:x': 'node scripts/check-x.mjs' },
      corpora: corpora({ test: "execFileSync('node', ['scripts/check-x.mjs'])" }),
      coverage: {
        enforcingTests: [
          { path: 'packages/operator-core/lib/x.test.ts', text: "execFileSync('node', ['scripts/check-x.mjs'])" },
        ],
        workspaceDirs: ['packages/operator-core', 'apps/operator'],
        implSources: new Map([['scripts/check-x.mjs', 'listTrackedFiles(ROOT)']]),
        repoWideRegistered: new Set(),
      },
    });
    expect(c.partiallyCovered.map((r: { name: string }) => r.name)).toEqual(['lint:x']);
  });

  /* ── permanent WRONG-IMPLEMENTATION control ────────────────────────────────
   * The bug this axis fixes was not a crash — it was a TRUE statement read as a
   * stronger one. Without this control, every assertion above also passes on the
   * old per-guard boolean, which called the WI-9434 guard "enforced" while three of
   * its four scanned roots had no enforcement at all. */

  it('CONTROL: the per-GUARD boolean calls a partially-covered guard fully enforced', () => {
    const row = { name: 'lint:x', tier: 'test', blocking: true, impls: ['scripts/check-x.mjs'] };
    const perGuardBoolean = (r: { blocking: boolean }) => r.blocking;

    // The old model says this guard is enforced, full stop …
    expect(perGuardBoolean(row)).toBe(true);
    // … while the coverage axis names what that hides.
    const c = computeCoverage({
      row,
      enforcingTestPaths: ['packages/operator-core/lib/x.test.ts'],
      workspaceDirs: ['packages/operator-core', 'apps/operator'],
      implSource: 'listTrackedFiles(ROOT)',
    });
    expect(c.verdict).toBe('partial');
  });

  it('CALIBRATION: the coverage axis still returns full for genuinely full coverage', () => {
    // Without this, the control above would also pass on an implementation that
    // reported EVERY guard as partial.
    expect(computeCoverage({ row: { name: 'lint:x', tier: 'gate', blocking: true, impls: [] } }).verdict).toBe('full');
  });
});

describe('the repository itself (real-tree assertion)', () => {
  // This block is what makes THIS guard enforced rather than merely logic-tested —
  // see the file header. It executes the real checker over the real tree.
  it('has no unenforced lint guard beyond the acknowledged, shrink-only set', () => {
    const run = () => {
      try {
        return {
          code: 0,
          out: execFileSync('node', [SCRIPT], {
            cwd: REPO_ROOT,
            encoding: 'utf-8',
            timeout: CHECKER_TIMEOUT_MS,
          }),
        };
      } catch (e) {
        const err = e as { message?: string; signal?: string; status?: number; stdout?: string; stderr?: string };
        const detail = err.message ?? (err.signal ? `child terminated by ${err.signal}` : 'child failed');
        return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}\n${detail}` };
      }
    };
    const { code, out } = run();
    expect(out).not.toMatch(/STALE allowlist/);
    expect(code, `check-lint-guard-reachability failed:\n${out}`).toBe(0);
  });

  it('keeps the --json report complete and parseable through a downstream pipe', () => {
    // A large stdout payload followed by process.exit() is truncated at the pipe's
    // first flush (8,192 bytes here), so this exercises the actual consumer shape
    // rather than only checking a TTY or file redirect (EI-19455452259628697).
    const probe = spawnSync(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        `node ${SCRIPT} --json | node -e 'let input=""; process.stdin.on("data", chunk => (input += chunk)); process.stdin.on("end", () => { try { const report = JSON.parse(input); console.log(JSON.stringify({ bytes: input.length, rows: report.rows.length })); } catch (error) { console.error(error.message); process.exitCode = 1; } });'`,
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
    expect(probe.status, output).toBe(0);

    const result = JSON.parse(probe.stdout as string) as { bytes: number; rows: number };
    expect(result.bytes).toBeGreaterThan(8192);
    expect(result.rows).toBeGreaterThan(0);
  });

  it('keeps the acknowledged set at or under its watermark', () => {
    // Shrink-only. Growing this set is how the rot would quietly return, so the
    // ceiling is asserted here as well as inside the script.
    expect(ACKNOWLEDGED_UNREACHABLE.size).toBeLessThanOrEqual(UNREACHABLE_HIGH_WATERMARK);
  });

  it('gives every acknowledged guard a non-empty reason', () => {
    for (const [name, reason] of ACKNOWLEDGED_UNREACHABLE) {
      expect(String(reason).length, `${name} needs a stated reason`).toBeGreaterThan(10);
    }
  });

  it('keeps the partial-coverage set at or under its watermark', () => {
    // Shrink-only, like its sibling. Paying one down means REGISTERING the guard in
    // REPO_WIDE_INVARIANT_GUARDS, never appending here.
    expect(ACKNOWLEDGED_PARTIAL_COVERAGE.size).toBeLessThanOrEqual(PARTIAL_COVERAGE_HIGH_WATERMARK);
  });

  it('gives every acknowledged partial-coverage guard a stated reason', () => {
    for (const [name, reason] of ACKNOWLEDGED_PARTIAL_COVERAGE) {
      expect(String(reason).length, `${name} needs a stated reason`).toBeGreaterThan(10);
    }
  });

  it('FAILS OPEN when the registration source is unreadable, instead of red-pinning the gate', () => {
    // This runs as a BLOCKING green-checkpoint leg. Coverage credits a guard as fully
    // covered when it is registered in REPO_WIDE_INVARIANT_GUARDS, so an unreadable
    // registration source would reclassify every registered guard as `partial` and fail
    // the gate for the whole fleet — on a missing file, not on a real defect.
    //
    // The subject is pointed at a COPY outside the tree: proving this by deleting the
    // real file from a shared checkout would let git-sync commit the deletion.
    const stub = path.join(os.tmpdir(), 'guard-reachability-no-registrations.mjs');
    // ⚠ The stub must not NAME the sentinel it is meant to lack. The first version of
    // this fixture was the comment "deliberately contains no REPO_WIDE_INVARIANT_GUARDS
    // block" — which CONTAINS that string, so the detector read the disclaimer as the
    // thing itself and the fail-open branch never ran. Prose about a token is
    // indistinguishable from the token to anything that greps (EI-19459777127106385).
    fs.writeFileSync(stub, '// a registration source with no guard registrations in it\n');
    // spawnSync, not execFileSync: the skip notice is a WARNING and goes to stderr, which
    // execFileSync discards on a successful run. Asserting against stdout alone would have
    // passed for the wrong reason the moment the notice moved streams.
    const r = spawnSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: CHECKER_TIMEOUT_MS,
      env: { ...process.env, LINT_GUARD_REACHABILITY_AFFECTED_TESTS: stub },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(r.status, `expected a fail-OPEN exit 0, got ${r.status}:\n${out}`).toBe(0);
    expect(out).toMatch(/coverage axis SKIPPED/);
    // …and specifically NOT a stale/partial failure, which is the fail-closed trap.
    expect(out).not.toMatch(/STALE partial-coverage/);
    expect(out).not.toMatch(/enforced over only PART/);
  });

  it('states the coverage caveat in the ordinary PASS output, not only on failure', () => {
    // The whole defect was a number quoted without its qualifier: "68/82 enforced" read
    // as "the tree is protected". The caveat has to reach the reader of the NUMBER.
    const out = execFileSync('node', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: CHECKER_TIMEOUT_MS,
    });
    expect(out).toMatch(/enforced over only PART of what they scan/);
    expect(out).toMatch(/per-GUARD boolean, never a per-SCOPE one/);
  });
});
