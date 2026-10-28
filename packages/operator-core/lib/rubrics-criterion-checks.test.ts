/**
 * rubrics-criterion-checks.test.ts — the P-011 / owner-ratified D-006 structured
 * criterion checks: schema acceptance, propose-time REFUSING path validation, and
 * grading-time evaluation (live-run semantics via an injectable runner).
 *
 * The path-validation tests run against a REAL scratch tree (mkdtemp) so existsSync
 * semantics are the production ones, never a mocked fs. The grading-time tests inject
 * a runner stub; the contradiction pair (failing run × pass rating REFUSES; failing
 * run × honest rating STAMPS) is its own falsifiability control — the verdict provably
 * depends on the rating–run PAIR, not on either alone.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { declaredCaseTitles, mayMatchUnresolvedCaseTitle } from './testing-declared-case-titles';
import {
  validateCriterionCheckPaths,
  assertCriterionCheckPathsResolve,
  selectCriterionCheckRoot,
  runCriterionCheckFiles,
  runCargoCriterionCheck,
  evaluateCriterionCargoChecks,
  evaluateCriterionTestChecks,
  evaluateCriterionCoverageChecks,
  subjectPlanAllowsPlannedPaths,
  type CriterionCheckRunner,
  type CriterionCaseLoader,
  type CriterionCargoCheckRunner,
  type CoverageMeasurement,
  type CoverageReader,
} from './rubrics-criterion-checks';
import { checkoutRootForPath, selectTestFileRoot } from './agent-tools/testing/run';
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import { rubricCriterionSchema, rubricTemplateDataSchema, rubricCriterionCheckSchema } from './agent-tools/plans/rubric-template';
import { collectPlannedRubricPaths, effectiveCriterionInstrumentKey, planRowToRubric } from './rubrics';
// The ROUTER's own admission predicate, imported so WI-369566's restated pattern is
// pinned to it. A test may import this plain-Node CLI freely; the validator may not
// (the operator host spawns it and must not bundle it).
// eslint-disable-next-line import/no-relative-packages
// @ts-expect-error — plain-Node .mjs router has no declaration file by design.
import { isTestFilePath } from '../../../scripts/test-files.mjs';

// ── scratch tree ──────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'rubric-checks-test-'));
mkdirSync(join(root, 'packages', 'x'), { recursive: true });
writeFileSync(join(root, 'packages', 'x', 'real.test.ts'), 'export {};\n');
mkdirSync(join(root, 'apps', 'tui', 'src'), { recursive: true });
writeFileSync(join(root, 'apps', 'tui', 'Cargo.toml'), '[package]\nname = "pui"\nversion = "0.1.0"\n');
writeFileSync(join(root, 'apps', 'tui', 'src', 'app.rs'), '#[test]\nfn app_test() {}\n');
writeFileSync(join(root, 'apps', 'tui', 'src', 'ui.rs'), '#[test]\nfn ui_test() {}\n');
const outside = mkdtempSync(join(tmpdir(), 'rubric-checks-outside-'));
writeFileSync(join(outside, 'escape.rs'), '#[test]\nfn escape_test() {}\n');
symlinkSync(join(outside, 'escape.rs'), join(root, 'apps', 'tui', 'src', 'escape.rs'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => rmSync(outside, { recursive: true, force: true }));

// Independent sibling checkout fixture.  The production workspace exposes these
// as `portal/tests/foo.test.ts`; the check validator must admit that spelling and
// hand the absolute file to testing:run so it can switch to the sibling's router.
const siblingWorkspace = mkdtempSync(join(tmpdir(), 'rubric-checks-sibling-workspace-'));
const siblingAmbient = join(siblingWorkspace, 'papercusp');
const siblingRepo = join(siblingWorkspace, 'portal');
const siblingRepoLink = join(siblingWorkspace, 'portal-link');
mkdirSync(join(siblingAmbient, '.git'), { recursive: true });
writeFileSync(join(siblingAmbient, 'package.json'), JSON.stringify({ workspaces: [] }));
mkdirSync(join(siblingRepo, '.git'), { recursive: true });
writeFileSync(join(siblingRepo, 'package.json'), JSON.stringify({ workspaces: [] }));
mkdirSync(join(siblingRepo, 'tests'), { recursive: true });
writeFileSync(join(siblingRepo, 'tests', 'sibling.test.ts'), 'export {}\n');
symlinkSync(siblingRepo, siblingRepoLink, 'dir');
afterAll(() => rmSync(siblingWorkspace, { recursive: true, force: true }));

// WI-6554700010018010: a single-package Vitest sibling (the papercusp.com site
// shape — package.json with NO `workspaces` field, its own vitest.config.js) is a
// real sibling too, admitted through a symlink like the production site clone.
// Controls: a sibling with no runnable Vitest, and a pointer-file `.git`
// (worktree/submodule) sibling, stay refused; a Vitest clone NESTED inside the
// strict superproject keeps routing to the superproject.
const vitestWorkspace = mkdtempSync(join(tmpdir(), 'rubric-checks-vitest-sibling-'));
const vitestAmbient = join(vitestWorkspace, 'papercusp');
const vitestSiteClone = mkdtempSync(join(tmpdir(), 'rubric-checks-vitest-site-clone-'));
const singlePackage = (dir: string, opts: { gitFile?: boolean; vitestConfig?: boolean } = {}) => {
  mkdirSync(join(dir, 'tests'), { recursive: true });
  if (opts.gitFile) writeFileSync(join(dir, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
  else mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'single', type: 'module' }));
  if (opts.vitestConfig !== false) writeFileSync(join(dir, 'vitest.config.js'), 'export default {};\n');
  writeFileSync(join(dir, 'tests', 'map.test.js'), 'export {}\n');
};
mkdirSync(join(vitestAmbient, '.git'), { recursive: true });
writeFileSync(join(vitestAmbient, 'package.json'), JSON.stringify({ workspaces: [] }));
singlePackage(vitestSiteClone);
symlinkSync(vitestSiteClone, join(vitestWorkspace, 'site'), 'dir');
singlePackage(join(vitestWorkspace, 'plain'), { vitestConfig: false });
singlePackage(join(vitestWorkspace, 'worktree-site'), { gitFile: true });
singlePackage(join(vitestAmbient, 'apps', 'drill'));
afterAll(() => rmSync(vitestWorkspace, { recursive: true, force: true }));
afterAll(() => rmSync(vitestSiteClone, { recursive: true, force: true }));

const testsCheck = (files: string[]) => ({ kind: 'tests' as const, files });
describe('named test citation preflight (EI-26971745324820138)', () => {
  const file = 'packages/x/named.test.ts';
  const title = 'stable review identity excludes volume R5-CONTRACT';
  writeFileSync(join(root, file), `import { describe, it } from 'vitest';
    describe('review identity', () => { it('${title}', () => {}); });`);

  it('refuses an embedded case tag before proposal while preserving exact titles and hierarchy suffixes', () => {
    const criterion = (testName: string) => [{ key: 'r5', check: { ...testsCheck([file]), testName } }];
    expect(() => assertCriterionCheckPathsResolve(criterion('R5-CONTRACT'), { root })).toThrow(/case.*R5-CONTRACT/i);
    expect(() => assertCriterionCheckPathsResolve(criterion('review identity'), { root })).toThrow(/case/i);
    expect(() => assertCriterionCheckPathsResolve(criterion(title), { root })).not.toThrow();
    expect(() => assertCriterionCheckPathsResolve(criterion(`review identity > ${title}`), { root })).not.toThrow();
  });

  it('checks each cases selector against its own file and preserves whole-file and planned-file checks', () => {
    const other = 'packages/x/other-named.test.ts';
    writeFileSync(join(root, other), "import { it } from 'vitest'; it('different maintained case', () => {});");
    expect(() => assertCriterionCheckPathsResolve([{ key: 'r7', check: {
      ...testsCheck([file, other]), cases: [{ file, testName: title }, { file: other, testName: title }],
    } }], { root })).toThrow(/other-named.*case/i);
    expect(() => assertCriterionCheckPathsResolve([{ key: 'whole', check: testsCheck([file]) }], { root })).not.toThrow();
    expect(() => assertCriterionCheckPathsResolve([{ key: 'future', check: {
      ...testsCheck(['packages/x/future-case.test.ts']), testName: 'future case',
    } }], { root, allowPlannedPaths: true })).not.toThrow();
  });

  it('accepts an explicit planned case in an existing suite only through the pre-start allowance and names it', () => {
    const testName = 'new contract behavior to implement';
    const criteria = [{ key: 'future', check: { ...testsCheck([file]), cases: [
      { file, testName, plannedReason: 'The implementing item adds this behavior to the maintained suite.' },
    ] } }];
    const validation = assertCriterionCheckPathsResolve(criteria, { root, allowPlannedPaths: true });
    expect(validation.planned).toEqual([expect.objectContaining({ criterionKey: 'future', path: file, testName })]);
    expect(collectPlannedRubricPaths({ planned: [] }, validation)).toEqual([
      { criterionKey: 'future', path: file, kind: 'tests-check', literal: testName },
    ]);
    expect(() => assertCriterionCheckPathsResolve(criteria, { root })).toThrow(/matches no maintained case/);
    expect(() => assertCriterionCheckPathsResolve([{ key: 'unmarked', check: {
      ...testsCheck([file]), cases: [{ file, testName }],
    } }], { root, allowPlannedPaths: true })).toThrow(/matches no maintained case/);
  });

  it('a planned case never exempts another selector in the same existing suite', () => {
    const planned = { file, testName: 'first future behavior', plannedReason: 'Implement this case.' };
    const second = { file, testName: 'second future behavior', plannedReason: 'Implement this other case.' };
    const criteria = [{ key: 'future', check: { ...testsCheck([file]), cases: [planned, second] } }];
    const validation = assertCriterionCheckPathsResolve(criteria, { root, allowPlannedPaths: true });
    expect(validation.planned.map(row => row.testName)).toEqual([planned.testName, second.testName]);
    expect(collectPlannedRubricPaths({ planned: [] }, validation)).toHaveLength(2);
    expect(() => assertCriterionCheckPathsResolve([{ key: 'mixed', check: {
      ...testsCheck([file]), cases: [planned, { file, testName: 'R5-CONTRACT' }],
    } }], { root, allowPlannedPaths: true })).toThrow(/case.*R5-CONTRACT/);
    for (const plannedReason of ['', '   ', true]) {
      expect(rubricCriterionCheckSchema.safeParse({ ...testsCheck([file]), cases: [{ ...planned, plannedReason }] }).success).toBe(false);
    }
  });

  it('bounds dynamic uncertainty per declaration instead of exempting a mixed file', () => {
    const file = 'packages/x/dynamic-named.test.ts';
    writeFileSync(join(root, file), "import { describe, it as caseTest } from 'vitest'; describe('suite', () => { caseTest.each([1])('handles %s rows', () => {}); caseTest('fixed R7-CONTRACT', () => {}); });");
    const criterion = (testName: string) => [{ key: 'mixed', check: { ...testsCheck([file]), testName } }];
    expect(() => assertCriterionCheckPathsResolve(criterion('R7-CONTRACT'), { root })).toThrow(/case/);
    expect(() => assertCriterionCheckPathsResolve(criterion('fixed R7-CONTRACT'), { root })).not.toThrow();
    expect(() => assertCriterionCheckPathsResolve(criterion('handles 1 rows'), { root })).not.toThrow();
    expect(() => assertCriterionCheckPathsResolve(criterion('suite'), { root })).toThrow(/case/);
  });

  it('ignores quoted/commented declarations and confines computed suite uncertainty to its leaf titles', () => {
    const discovered = declaredCaseTitles('titles.test.ts', "// it('fake', () => {})\nconst text = \"it('also fake', () => {})\"; describe(`region ${region}`, () => { it('real leaf', () => {}); });");
    expect(discovered.titles).toEqual([]);
    expect(mayMatchUnresolvedCaseTitle('real leaf', discovered.unresolvedTitles)).toBe(true);
    expect(mayMatchUnresolvedCaseTitle('region east > real leaf', discovered.unresolvedTitles)).toBe(true);
    expect(mayMatchUnresolvedCaseTitle('fake', discovered.unresolvedTitles)).toBe(false);
    expect(mayMatchUnresolvedCaseTitle('region east', discovered.unresolvedTitles)).toBe(false);
  });

  it('recognizes namespace imports and named callbacks without executing modules', () => {
    const discovered = declaredCaseTitles('titles.test.ts', "import * as v from 'vitest'; import nodeCase from 'node:test'; v.describe('suite', () => { v.it('literal leaf', callback); }); nodeCase('native leaf', callback); v.describe('computed subtree', registerCases);");
    expect(discovered.titles).toEqual(['suite > literal leaf', 'native leaf']);
    expect(mayMatchUnresolvedCaseTitle('computed subtree > generated leaf', discovered.unresolvedTitles)).toBe(true);
    expect(mayMatchUnresolvedCaseTitle('unrelated tag', discovered.unresolvedTitles)).toBe(true);
  });
});
describe('scorecard integration PG route', () => {
  it.each([
    { integration: true, wrapper: true, privatePg: true },
    { integration: false, wrapper: true, privatePg: false },
    { integration: true, wrapper: false, privatePg: false },
  ])('selects owned PG only for a supported integration batch: %j', async (route) => {
    const checkout = mkdtempSync(join(tmpdir(), 'criterion-private-pg-'));
    try {
      if (route.wrapper) {
        mkdirSync(join(checkout, 'scripts'));
        writeFileSync(join(checkout, 'scripts', 'with-test-pg.mjs'), 'export {};\n');
      }
      const files = [route.integration ? 'mixed.integration.test.ts' : 'unit.test.ts'];
      const runFiles = vi.fn<typeof import('./agent-tools/testing/run').runTestFilesCore>()
        .mockResolvedValue({ ok: false, error: 'no_report', root: checkout, runId: 'owned-pg-route-control' });
      await runCriterionCheckFiles({ root: checkout, files, runId: 'owned-pg-route-control' }, { runFiles });
      expect(runFiles).toHaveBeenCalledOnce();
      const request = runFiles.mock.calls[0]![0];
      expect(request).toMatchObject({ root: checkout, files, runId: 'owned-pg-route-control' });
      expect(request.privatePg === true).toBe(route.privatePg);
      if (route.privatePg) expect(request.allowDetachedRecovery).toBe(false);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
const cargoCheck = (manifestPath: string, sourceFiles: string[], test?: string) => ({
  kind: 'cargo' as const,
  manifestPath,
  sourceFiles,
  ...(test ? { test } : {}),
});

// WI-39848 fixtures: enough distinct resolving files to model a THOROUGH rubric — the
// exact shape that used to be ungradeable, because each criterion cost its own vitest
// cold start against one shared deadline.
const MANY = Array.from({ length: 8 }, (_, i) => `packages/x/many-${i}.test.ts`);
for (const f of MANY) writeFileSync(join(root, f), 'export {};\n');

// ── schema ────────────────────────────────────────────────────────────────────
describe('rubricCriterionCheckSchema (P-011 schema)', () => {
  it('accepts a tests check and an instrument check; refuses unknown fields and unknown kinds', () => {
    expect(rubricCriterionCheckSchema.safeParse(testsCheck(['a.test.ts'])).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'instrument', instrumentKey: 'gate-verdict' }).success).toBe(true);
    expect(
      rubricCriterionCheckSchema.safeParse(
        cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/app.rs'], 'app::tests::renders'),
      ).success,
    ).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: ['a.test.ts'], extra: 1 }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'vibes' }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: [] }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'cargo', manifestPath: 'apps/tui/Cargo.toml', sourceFiles: [] }).success).toBe(false);
  });

  it('rides the criterion schema as an optional field (absent = fuzzy, unchanged)', () => {
    const base = { key: 'k', title: 't', model: 'm', method: 'm', driftMarkers: 'd' };
    expect(rubricCriterionSchema.safeParse(base).success).toBe(true);
    expect(rubricCriterionSchema.safeParse({ ...base, check: testsCheck(['a.test.ts']) }).success).toBe(true);
  });

  it('data-level superRefine refuses a criterion binding two DIFFERENT instruments, tolerates equal', () => {
    const data = (check: unknown, instrumentKey?: string) => ({
      characteristic: 'c',
      criteria: [
        { key: 'k', title: 't', model: 'm', method: 'm', driftMarkers: 'd', ...(instrumentKey ? { instrumentKey } : {}), check },
      ],
      ratingScale: ['healthy', 'broken'],
    });
    const conflicting = rubricTemplateDataSchema.safeParse(data({ kind: 'instrument', instrumentKey: 'a' }, 'b'));
    expect(conflicting.success).toBe(false);
    expect(JSON.stringify(conflicting.success ? '' : conflicting.error.issues)).toContain('two different instruments');
    expect(rubricTemplateDataSchema.safeParse(data({ kind: 'instrument', instrumentKey: 'a' }, 'a')).success).toBe(true);
    // tests-check beside an instrumentKey is two DIFFERENT bindings — legal.
    expect(rubricTemplateDataSchema.safeParse(data(testsCheck(['a.test.ts']), 'a')).success).toBe(true);
  });

  it('round-trips through planRowToRubric (the store read maps check 1:1, absent stays absent)', () => {
    const row = {
      plan_slug: 'r-check',
      workspace_id: 'ws',
      harness_slug: null,
      title: 'R',
      status: 'active',
      created: '2026-08-17',
      updated: '2026-08-17',
      updated_at: '2026-08-17T00:00:00.000Z',
      owner: 'su-1',
      archived: false,
      template_data: {
        characteristic: 'c',
        criteria: [
          { key: 'det', title: 't', model: 'm', method: 'm', driftMarkers: 'd', check: testsCheck(['a.test.ts']) },
          { key: 'fuzzy', title: 't', model: 'm', method: 'm', driftMarkers: 'd' },
        ],
        ratingScale: ['healthy', 'broken'],
      },
    };
    const mapped = planRowToRubric(row as never);
    expect(mapped?.criteria.find((c) => c.key === 'det')?.check).toEqual(testsCheck(['a.test.ts']));
    expect(mapped?.criteria.find((c) => c.key === 'fuzzy')?.check).toBeUndefined();
  });

  it('effectiveCriterionInstrumentKey prefers the structured check over the legacy field and model token', () => {
    expect(
      effectiveCriterionInstrumentKey({
        model: 'prose [instrumentKey: legacy-token]',
        instrumentKey: 'legacy-field',
        check: { kind: 'instrument', instrumentKey: 'structured' },
      }),
    ).toBe('structured');
    expect(effectiveCriterionInstrumentKey({ instrumentKey: 'legacy-field' })).toBe('legacy-field');
    // a tests-check is NOT an instrument binding — falls through to the legacy chain.
    expect(
      effectiveCriterionInstrumentKey({ check: testsCheck(['a.test.ts']), instrumentKey: 'legacy-field' }),
    ).toBe('legacy-field');
  });
});

// ── EI-24372605712471072: PLANNED paths on a subject plan that has not started ──
describe('allowPlannedPaths — a pre-start BAR may name its future test file', () => {
  const future = 'packages/x/written-by-the-plan.test.ts';

  it('subjectPlanAllowsPlannedPaths admits only the un-started statuses', () => {
    expect(subjectPlanAllowsPlannedPaths('draft')).toBe(true);
    expect(subjectPlanAllowsPlannedPaths('ready')).toBe(true);
    for (const started of ['active', 'awaiting-acceptance', 'shipped', 'done', 'superseded', '', null, undefined]) {
      expect(subjectPlanAllowsPlannedPaths(started)).toBe(false);
    }
  });

  it('accepts a missing, relative, test-shaped file as planned and names it', () => {
    const v = validateCriterionCheckPaths([{ key: 'k', check: testsCheck([future]) }], { root, allowPlannedPaths: true });
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
    expect(v.planned).toEqual([expect.objectContaining({ criterionKey: 'k', path: future })]);
    expect(v.normalizedByKey.k).toEqual([future]);
  });

  it('without the allowance (grading, or a started plan) the same file still refuses', () => {
    const strict = validateCriterionCheckPaths([{ key: 'k', check: testsCheck([future]) }], { root });
    expect(strict.ok).toBe(false);
    expect(strict.planned).toEqual([]);
    expect(strict.failures[0]?.reason).toContain('does not resolve');
    expect(() => assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck([future]) }], { root })).toThrowError(
      /invalid_args:.*written-by-the-plan\.test\.ts/s,
    );
    // POSITIVE CONTROL: the assert form returns the planned list with the allowance on.
    expect(
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck([future]) }], { root, allowPlannedPaths: true })
        .planned.map((p) => p.path),
    ).toEqual([future]);
  });

  it('still refuses what can never become valid: absolute, escaping, non-test, and directory paths', () => {
    const v = validateCriterionCheckPaths(
      [
        { key: 'abs', check: testsCheck([join(root, future)]) },
        { key: 'escape', check: testsCheck(['../outside/never.test.ts']) },
        { key: 'shape', check: testsCheck(['packages/x/future-script.sh']) },
        { key: 'dir', check: testsCheck(['packages/x']) },
      ],
      { root, allowPlannedPaths: true },
    );
    expect(v.ok).toBe(false);
    expect(v.planned).toEqual([]);
    expect(v.failures.map((f) => f.criterionKey).sort()).toEqual(['abs', 'dir', 'escape', 'shape']);
    expect(v.failures.find((f) => f.criterionKey === 'shape')?.reason).toContain('not a test file');
  });

  it('refuses a Playwright spec (WI-10004678): its *.spec.ts name passes the shape rule, but Vitest cannot run it', () => {
    // The module name is split so THIS file's own source never contains the import the
    // detector matches: other cases here validate this very file against the real repo.
    const pw = ['@playwright', 'test'].join('/');
    mkdirSync(join(root, 'apps', 'e2e'), { recursive: true });
    writeFileSync(join(root, 'apps', 'e2e', 'billing.spec.ts'), `import { test, expect } from '${pw}';\ntest('x', () => {});\n`);
    writeFileSync(join(root, 'apps', 'e2e', 'cjs.spec.js'), `const { test } = require("${pw}");\n`);
    // Control: a Vitest spec with the same suffix still validates.
    writeFileSync(join(root, 'apps', 'e2e', 'vitest.spec.ts'), "import { it } from 'vitest';\nit('x', () => {});\n");
    const v = validateCriterionCheckPaths(
      [
        { key: 'pw', check: testsCheck(['apps/e2e/billing.spec.ts']) },
        { key: 'pwcjs', check: testsCheck(['apps/e2e/cjs.spec.js']) },
        { key: 'vitest', check: testsCheck(['apps/e2e/vitest.spec.ts']) },
      ],
      { root },
    );
    expect(v.failures.map((f) => f.criterionKey).sort()).toEqual(['pw', 'pwcjs']);
    expect(v.failures.find((f) => f.criterionKey === 'pw')?.reason).toContain('Playwright spec');
  });

  it('a Cargo manifest the plan will create is planned; an existing path is not re-labelled', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'crate', check: { kind: 'cargo', manifestPath: 'apps/new-crate/Cargo.toml', sourceFiles: ['apps/tui/src/app.rs'] } }],
      { root, allowPlannedPaths: true },
    );
    expect(v.ok).toBe(true);
    expect(v.planned.map((p) => [p.path, p.checkKind])).toEqual([['apps/new-crate/Cargo.toml', 'cargo']]);
  });

  it('root selection stays strict: the allowance never chooses a tree where real files look planned', () => {
    // Requested root is a phantom; the canonical root holds the file. The strict
    // selection must still pick the canonical root, so nothing is reported as planned.
    const phantom = join(tmpdir(), 'rubric-checks-phantom-root-does-not-exist');
    const selected = selectCriterionCheckRoot(
      [{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }],
      phantom,
      root,
      { allowPlannedPaths: true },
    );
    expect(selected.source).toBe('canonical-repo');
    expect(selected.validation.ok).toBe(true);
    expect(selected.validation.planned).toEqual([]);
  });
});

// ── propose-time path validation (REFUSING — D-006) ──────────────────────────
describe('validateCriterionCheckPaths / assertCriterionCheckPathsResolve', () => {
  it('passes a resolving repo-root-relative file and returns it normalized', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }],
      { root },
    );
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(1);
    expect(v.normalizedByKey.k).toEqual(['packages/x/real.test.ts']);
  });

  it('fails a file that does not resolve, an absolute path, and reports the criterion key', () => {
    const v = validateCriterionCheckPaths(
      [
        { key: 'missing', check: testsCheck(['packages/x/ghost.test.ts']) },
        { key: 'abs', check: testsCheck([join(root, 'packages/x/real.test.ts')]) },
      ],
      { root },
    );
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.criterionKey).sort()).toEqual(['abs', 'missing']);
    expect(v.failures.find((f) => f.criterionKey === 'missing')?.reason).toContain('does not resolve');
    expect(v.failures.find((f) => f.criterionKey === 'abs')?.reason).toContain('machine-specific');
  });

  it('ignores fuzzy criteria and instrument checks entirely (checked stays 0)', () => {
    const v = validateCriterionCheckPaths(
      [
        { key: 'fuzzy' },
        { key: 'inst', check: { kind: 'instrument', instrumentKey: 'x' } },
      ],
      { root },
    );
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(0);
  });

  it('assert form throws an invalid_args teaching error naming path + criterion', () => {
    expect(() =>
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck(['nope.test.ts']) }], { root }),
    ).toThrowError(/invalid_args:.*'k'.*nope\.test\.ts/s);
    // POSITIVE CONTROL for the guard: the same call with a resolving path returns.
    expect(() =>
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }], { root }),
    ).not.toThrow();
  });

  it('validates Cargo manifest + source files and reports the complete checked count once', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs']) }],
      { root },
    );
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(3);
    expect(v.normalizedCargoByKey.native).toEqual({
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs'],
    });
  });

  it('admits a workspace-relative path in an independent sibling checkout', () => {
    const siblingPath = 'portal/tests/sibling.test.ts';
    const v = validateCriterionCheckPaths([{ key: 'sibling', check: testsCheck([siblingPath]) }], {
      root: siblingAmbient,
    });
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(1);
    expect(v.normalizedByKey.sibling).toEqual([join(siblingRepo, 'tests', 'sibling.test.ts')]);
    expect(checkoutRootForPath(v.normalizedByKey.sibling![0]!)).toBe(siblingRepo);
    expect(() => assertCriterionCheckPathsResolve([{ key: 'sibling', check: testsCheck([siblingPath]) }], { root: siblingAmbient })).not.toThrow();
  });

  it('admits a single-package Vitest sibling with no workspaces field and selects its own root (WI-6554700010018010)', () => {
    const sitePath = 'site/tests/map.test.js';
    const v = validateCriterionCheckPaths([{ key: 'site', check: testsCheck([sitePath]) }], { root: vitestAmbient });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    const absolute = join(realpathSync(vitestSiteClone), 'tests', 'map.test.js');
    expect(v.normalizedByKey.site).toEqual([absolute]);
    expect(checkoutRootForPath(absolute)).toBe(realpathSync(vitestSiteClone));
    // The runner gate accepts it as the execution root, not just the binding.
    expect(selectTestFileRoot([absolute], vitestAmbient, { discoveredRoots: [] })).toEqual({
      root: realpathSync(vitestSiteClone),
      source: 'absolute-file-checkout',
    });
  });

  it.each([
    ['no runnable Vitest', 'plain/tests/map.test.js'],
    ['a pointer-file .git (worktree/submodule)', 'worktree-site/tests/map.test.js'],
  ])('still refuses a single-package sibling with %s', (_label, path) => {
    const v = validateCriterionCheckPaths([{ key: 'refused', check: testsCheck([path]) }], { root: vitestAmbient });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual([
      expect.objectContaining({ criterionKey: 'refused', path, reason: 'does not resolve against the live tree' }),
    ]);
  });

  it('keeps a Vitest clone nested inside a workspaces superproject owned by the superproject', () => {
    expect(checkoutRootForPath(join(vitestAmbient, 'apps', 'drill', 'tests', 'map.test.js'))).toBe(vitestAmbient);
  });

  it('refuses sibling-prefixed paths that traverse outside the admitted checkout', () => {
    const traversal = 'portal/../papercusp/package.json';
    const v = validateCriterionCheckPaths([{ key: 'traversal', check: testsCheck([traversal]) }], {
      root: siblingAmbient,
    });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual([
      expect.objectContaining({ criterionKey: 'traversal', path: traversal }),
    ]);
  });

  it('REFUSES a Cargo source symlink that resolves outside the claimed tree', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/escape.rs']) }],
      { root },
    );
    expect(v.ok).toBe(false);
    expect(v.checked).toBe(2);
    expect(v.failures).toEqual([
      expect.objectContaining({
        criterionKey: 'native',
        path: 'apps/tui/src/escape.rs',
        checkKind: 'cargo',
        reason: 'does not resolve to a regular file in the live tree',
      }),
    ]);
    expect(v.normalizedCargoByKey.native).toBeUndefined();
    expect(() =>
      assertCriterionCheckPathsResolve(
        [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/escape.rs']) }],
        { root },
      ),
    ).toThrow(/structured cargo-check manifest\/source paths.*escape\.rs/s);
  });
});

// ── WI-369566: RESOLVING IS NOT RUNNABLE (the propose-time routability guard) ────
// The measured shape: a criterion bound a file that EXISTS on disk but that the test
// router answers TEST_FILE_UNSUPPORTED_INPUT (⚠ NON_TEST … skipped) for, so
// scorecards:emit reported on nothing and refused the rating — and since emit requires
// EVERY criterion to be rated, no rating value skipped it and the rubric was
// permanently ungradeable. The emit-side refusal is CORRECT and must not be weakened
// (D-006 forbids passing an unjudgeable check); this guard moves the cost to the author.
//
// Every case is PAIRED with a positive control, so a guard that simply refused all
// tests-checks — or one that refused nothing — fails these tests rather than passing them.
writeFileSync(join(root, 'packages', 'x', 'verify-rail.sh'), '#!/usr/bin/env bash\nexit 0\n');

// The PIN corpus: BOTH verdicts, every entry created on disk so path resolution can
// never be mistaken for a runnability verdict.
const ROUTABILITY_CORPUS = [
  'packages/x/real.test.ts',
  'packages/x/widget.test.tsx',
  'packages/x/flow.spec.ts',
  'packages/x/legacy.spec.jsx',
  'packages/x/node.test.mjs',
  'packages/x/node.test.cjs',
  'packages/x/verify-rail.sh',
  'packages/x/source.ts',
  'packages/x/README.md',
  'packages/x/testing.ts',
  'packages/x/test-helpers.ts',
];
for (const f of ROUTABILITY_CORPUS) {
  if (!existsSync(join(root, f))) writeFileSync(join(root, f), 'export {};\n');
}

describe('validateCriterionCheckPaths — routability (WI-369566)', () => {
  // FALSIFIABILITY CONTROL, kept permanently rather than run once as a mutation: the
  // PRE-FIX rule was existence-only, so it is reproducible in one line. Same file,
  // old rule ACCEPTS, new rule REFUSES — which pins the refusal to the new routability
  // leg and not to a fixture that quietly stopped resolving (a missing file would refuse
  // for the wrong reason and this test could not tell the difference).
  const preFixExistenceOnlyRule = (file: string): boolean => existsSync(join(root, file));

  it('REFUSES a resolving non-test path; the same criterion with a real test file passes', () => {
    expect(preFixExistenceOnlyRule('packages/x/verify-rail.sh')).toBe(true);

    const bad = validateCriterionCheckPaths(
      [{ key: 'rail', check: testsCheck(['packages/x/verify-rail.sh']) }],
      { root },
    );
    expect(bad.ok).toBe(false);
    expect(bad.failures.map((f) => f.criterionKey)).toEqual(['rail']);
    expect(bad.failures[0]?.path).toBe('packages/x/verify-rail.sh');
    expect(bad.failures[0]?.reason).toContain('NON_TEST');
    // Not normalized either — an unroutable path must never be persisted as gradeable.
    expect(bad.normalizedByKey.rail).toBeUndefined();

    // POSITIVE CONTROL: the guard is about runnability, not about refusing tests-checks.
    const good = validateCriterionCheckPaths(
      [{ key: 'rail', check: testsCheck(['packages/x/real.test.ts']) }],
      { root },
    );
    expect(good.ok).toBe(true);
    expect(good.normalizedByKey.rail).toEqual(['packages/x/real.test.ts']);
  });

  it('assert form refuses it at PROPOSE time, naming the criterion, the path and the way out', () => {
    expect(() =>
      assertCriterionCheckPathsResolve(
        [{ key: 'rail', check: testsCheck(['packages/x/verify-rail.sh']) }],
        { root },
      ),
    ).toThrowError(/invalid_args:.*'rail'.*verify-rail\.sh.*drop the check/s);
    // POSITIVE CONTROL for this guard: the same call with a runnable path returns.
    expect(() =>
      assertCriterionCheckPathsResolve(
        [{ key: 'rail', check: testsCheck(['packages/x/real.test.ts']) }],
        { root },
      ),
    ).not.toThrow();
  });

  // DERIVED-TRUTH RUNG 2 (PIN). The validator cannot IMPORT the router — that CLI is
  // spawned by the host, never bundled into it — so its admission pattern is restated
  // there and pinned HERE, where importing the .mjs is free. If the router widens or
  // narrows what it will run, this fails and forces the validator to move with it,
  // instead of the two sides silently disagreeing about what "runnable" means.
  it('agrees with the ROUTER about which paths it will run (pins the restated pattern)', () => {
    // Every corpus entry EXISTS on disk (created above), so the only thing that can
    // separate the two verdicts is the runnability rule itself — never path resolution.
    for (const file of ROUTABILITY_CORPUS) {
      const v = validateCriterionCheckPaths([{ key: 'k', check: testsCheck([file]) }], { root });
      expect({ file, accepted: v.ok }).toEqual({ file, accepted: isTestFilePath(file) });
    }
    // CALIBRATION: the corpus must produce BOTH verdicts, or an always-true predicate on
    // either side would satisfy the loop above without proving anything.
    expect(ROUTABILITY_CORPUS.some((f) => isTestFilePath(f))).toBe(true);
    expect(ROUTABILITY_CORPUS.some((f) => !isTestFilePath(f))).toBe(true);

    // DRIFT CONTROL: three plausible ways the restated pattern could drift, each shown
    // to DISAGREE with the router somewhere in this corpus. Without this, the loop above
    // could pass on a corpus too narrow to notice a real drift.
    const drifted = [
      /\.test\.[cm]?[jt]sx?$/i, // forgot `spec`
      /\.(?:test|spec)\.[jt]s$/i, // forgot the jsx/mjs/cjs spellings
      /(?:test|spec)/i, // matches any path merely containing the word
    ];
    for (const pattern of drifted) {
      expect(ROUTABILITY_CORPUS.some((f) => pattern.test(f) !== isTestFilePath(f))).toBe(true);
    }
  });
});

// ── WI-41394: phantom-root fallback (the WI-41365 class, this validator's rung) ──
// A second scratch tree stands in for the canonical repo, so selection semantics are
// tested without depending on the real REPO_ROOT's contents; the phantom root is a
// path mkdtemp never created — the exact shape a stale hive registry entry produces.
const canonical = mkdtempSync(join(tmpdir(), 'rubric-checks-canonical-'));
mkdirSync(join(canonical, 'packages', 'x'), { recursive: true });
writeFileSync(join(canonical, 'packages', 'x', 'real.test.ts'), 'export {};\n');
const phantom = join(tmpdir(), 'rubric-checks-phantom-does-not-exist');
afterAll(() => rmSync(canonical, { recursive: true, force: true }));

describe('selectCriterionCheckRoot (WI-41394 phantom-root fallback)', () => {
  const crit = [{ key: 'k', check: testsCheck(['packages/x/real.test.ts']) }];

  it('falls back to the canonical repo when the requested root cannot resolve the paths and the canonical repo resolves them ALL', () => {
    const s = selectCriterionCheckRoot(crit, phantom, canonical);
    expect(s.source).toBe('canonical-repo');
    expect(s.root).toBe(canonical);
    expect(s.validation.ok).toBe(true);
    expect(s.validation.root).toBe(canonical);
    expect(s.validation.normalizedByKey.k).toEqual(['packages/x/real.test.ts']);
  });

  it('keeps the requested root authoritative when it resolves every path — even though the canonical repo also would', () => {
    const s = selectCriterionCheckRoot(crit, root, canonical);
    expect(s.source).toBe('requested');
    expect(s.root).toBe(root);
    expect(s.validation.ok).toBe(true);
  });

  it('keeps the requested root and ITS failures when neither tree resolves the paths', () => {
    const ghost = [{ key: 'k', check: testsCheck(['packages/x/ghost.test.ts']) }];
    const s = selectCriterionCheckRoot(ghost, phantom, canonical);
    expect(s.source).toBe('requested');
    expect(s.validation.ok).toBe(false);
    expect(s.validation.root).toBe(phantom);
  });

  it('does not fall back for a root-independent fault: an absolute path is refused under BOTH trees', () => {
    const abs = [{ key: 'k', check: testsCheck([join(canonical, 'packages/x/real.test.ts')]) }];
    const s = selectCriterionCheckRoot(abs, phantom, canonical);
    expect(s.source).toBe('requested');
    expect(s.validation.failures[0]?.reason).toContain('machine-specific');
  });

  it('assertCriterionCheckPathsResolve inherits the rung against the real REPO_ROOT: a phantom root no longer refuses a repo-resolving path', () => {
    expect(() =>
      assertCriterionCheckPathsResolve(
        [{ key: 'k', check: testsCheck(['packages/operator-core/lib/rubrics-criterion-checks.test.ts']) }],
        { root: phantom },
      ),
    ).not.toThrow();
    // CONTROL: the same phantom root still refuses a path that resolves nowhere —
    // the rung rescues resolvable checks, never bad ones.
    expect(() =>
      assertCriterionCheckPathsResolve([{ key: 'k', check: testsCheck(['nope-nowhere.test.ts']) }], { root: phantom }),
    ).toThrowError(/invalid_args:/);
  });

  it('grading time inherits the rung: a phantom requested root validates AND RUNS against the canonical repo', async () => {
    const calls: { files: string[]; root: string }[] = [];
    const runner: CriterionCheckRunner = async ({ files, root: r }) => {
      calls.push({ files, root: r });
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck(['packages/operator-core/lib/rubrics-criterion-checks.test.ts']) }],
      ratings: { det: { rating: 'healthy' } },
      root: phantom,
      runner,
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.root).toBe(REPO_ROOT);
  });
});

describe("evaluateCriterionCargoChecks (grading time)", () => {
  const cargoCriteria = [
    {
      key: 'app',
      check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/app.rs'], 'app::tests'),
    },
    {
      key: 'ui',
      check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/ui.rs'], 'app::tests'),
    },
  ];

  it('groups one manifest/filter invocation and preserves each criterion source attribution', async () => {
    const calls: Array<Parameters<CriterionCargoCheckRunner>[0]> = [];
    const runner: CriterionCargoCheckRunner = async (opts) => {
      calls.push(opts);
      return {
        passed: 5,
        failed: 0,
        ignored: 1,
        runId: 'cargo-1',
        durationMs: 125,
      };
    };
    const res = await evaluateCriterionCargoChecks({
      criteria: cargoCriteria,
      ratings: { app: { rating: 'healthy' }, ui: { rating: 'healthy' } },
      root,
      runner,
      nowIso: () => '2026-08-30T07:30:00.000Z',
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs', 'apps/tui/src/ui.rs'],
      test: 'app::tests',
      root,
    });
    if (!res.ok) return;
    expect(res.checkRuns.app).toMatchObject({
      kind: 'cargo',
      manifestPath: 'apps/tui/Cargo.toml',
      sourceFiles: ['apps/tui/src/app.rs'],
      test: 'app::tests',
      verdict: 'pass',
      passed: 5,
      failed: 0,
      ignored: 1,
      runId: 'cargo-1',
    });
    expect(res.checkRuns.ui).toMatchObject({
      kind: 'cargo',
      sourceFiles: ['apps/tui/src/ui.rs'],
    });
  });

  it('REFUSES a stale Cargo path before invoking the native runner', async () => {
    let ran = false;
    const runner: CriterionCargoCheckRunner = async () => {
      ran = true;
      return { passed: 1, failed: 0, ignored: 0, runId: 'cargo-1', durationMs: 1 };
    };
    const res = await evaluateCriterionCargoChecks({
      criteria: [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/deleted.rs']) }],
      ratings: { native: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_path_unresolved');
      expect(res.criterionKey).toBe('native');
      expect(res.detail).toContain('deleted.rs');
    }
    expect(ran).toBe(false);
  });

  it('REFUSES a native run with no non-ignored tests instead of passing vacuously', async () => {
    const runner: CriterionCargoCheckRunner = async () => ({
      passed: 0,
      failed: 0,
      ignored: 3,
      runId: 'cargo-empty',
      durationMs: 4,
    });
    const res = await evaluateCriterionCargoChecks({
      criteria: [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/app.rs']) }],
      ratings: { native: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_run_failed');
      expect(res.detail).toContain('ZERO non-ignored');
    }
  });

  it('REFUSES a pass-claiming rating when Cargo fails, while an honest rating is stamped', async () => {
    const runner: CriterionCargoCheckRunner = async () => ({
      passed: 2,
      failed: 1,
      ignored: 0,
      runId: 'cargo-fail',
      durationMs: 8,
      failures: ['app::tests::renders'],
    });
    const checked = [{ key: 'native', check: cargoCheck('apps/tui/Cargo.toml', ['apps/tui/src/app.rs']) }];
    const contradicted = await evaluateCriterionCargoChecks({
      criteria: checked,
      ratings: { native: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(contradicted.ok).toBe(false);
    if (!contradicted.ok) {
      expect(contradicted.error).toBe('check_contradicted');
      expect(contradicted.detail).toContain('cargo-check');
    }

    const honest = await evaluateCriterionCargoChecks({
      criteria: checked,
      ratings: { native: { rating: 'broken' } },
      root,
      runner,
    });
    expect(honest.ok).toBe(true);
    if (honest.ok) expect(honest.checkRuns.native).toMatchObject({ verdict: 'fail', failed: 1 });
  });
});

function makeFakeCargoChild(opts: {
  output?: string;
  exitCode?: number | null;
  emitCloseOnKill?: boolean;
  synchronousOutput?: boolean;
} = {}): {
  child: import('node:child_process').ChildProcess;
  killSignals: NodeJS.Signals[];
} {
  const child = new EventEmitter() as unknown as import('node:child_process').ChildProcess;
  const killSignals: NodeJS.Signals[] = [];
  const stdout = opts.synchronousOutput
    ? (() => {
        const stream = new EventEmitter();
        const originalOn = stream.on.bind(stream);
        stream.on = ((event: string, listener: (...args: unknown[]) => void) => {
          if (event === 'data' && opts.output) listener(Buffer.from(opts.output));
          return originalOn(event, listener);
        }) as typeof stream.on;
        return stream;
      })()
    : new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout as unknown as PassThrough;
  child.stderr = stderr;
  const mutableChild = child as unknown as {
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  mutableChild.pid = undefined;
  mutableChild.exitCode = opts.exitCode ?? null;
  mutableChild.signalCode = null;
  child.kill = ((signal?: NodeJS.Signals) => {
    if (signal) killSignals.push(signal);
    if (signal && opts.emitCloseOnKill) {
      setImmediate(() => child.emit('close', null, signal));
    }
    return true;
  }) as typeof child.kill;
  return { child, killSignals };
}

function managedCargoResult(child: import('node:child_process').ChildProcess): never {
  return {
    taskId: 'task-cargo-test',
    row: {} as never,
    child,
    scopeUnit: null,
    confined: false,
  } as never;
}

describe('runCargoCriterionCheck (native runner lifecycle)', () => {
  const runnerOpts = {
    root,
    manifestPath: 'apps/tui/Cargo.toml',
    sourceFiles: ['apps/tui/src/app.rs'],
  };

  it('distils Cargo result lines and does not leak the global regex cursor between runs', async () => {
    const makeSpawn = (output: string) => {
      const fake = makeFakeCargoChild({ output, exitCode: 0, synchronousOutput: true });
      const managedSpawnFn = (async () => {
        setImmediate(() => fake.child.emit('close', 0, null));
        return managedCargoResult(fake.child);
      }) as never;
      return { fake, managedSpawnFn };
    };
    const first = makeSpawn('test app::tests::one ... ok\n');
    const firstResult = await runCargoCriterionCheck({ ...runnerOpts, managedSpawnFn: first.managedSpawnFn });
    const second = makeSpawn('test ui::tests::two ... FAILED\n');
    const secondResult = await runCargoCriterionCheck({ ...runnerOpts, managedSpawnFn: second.managedSpawnFn });

    expect(firstResult).toMatchObject({ passed: 1, failed: 0, ignored: 0 });
    expect(firstResult.error).toBeUndefined();
    expect(secondResult).toMatchObject({ passed: 0, failed: 1, ignored: 0 });
    expect(secondResult.error).toBeUndefined();
    expect(secondResult.failures).toEqual(['ui::tests::two']);
  });

  it('uses the child exitCode fallback when close fired before the listener was attached', async () => {
    const fake = makeFakeCargoChild({
      output: 'test app::tests::one ... ok\n',
      exitCode: 0,
      synchronousOutput: true,
    });
    const managedSpawnFn = (async () => managedCargoResult(fake.child)) as never;
    const result = await runCargoCriterionCheck({ ...runnerOpts, managedSpawnFn });
    expect(result).toMatchObject({ passed: 1, failed: 0, ignored: 0 });
    expect(result.error).toBeUndefined();
  });

  it('settles the timeout before a slow spawn handshake and kills a late child when it arrives', async () => {
    const fake = makeFakeCargoChild();
    const managedSpawnFn = (() =>
      new Promise((resolve) => {
        setTimeout(() => resolve(managedCargoResult(fake.child)), 30);
      })) as never;
    const result = await runCargoCriterionCheck({
      ...runnerOpts,
      timeoutMs: 5,
      managedSpawnFn,
    });
    expect(result.error).toBe('timeout after 5ms');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.killSignals).toContain('SIGTERM');
  });

  it('terminates a running child on timeout and returns the typed timeout refusal', async () => {
    const fake = makeFakeCargoChild({ emitCloseOnKill: true });
    const managedSpawnFn = (async () => managedCargoResult(fake.child)) as never;
    const result = await runCargoCriterionCheck({
      ...runnerOpts,
      timeoutMs: 5,
      managedSpawnFn,
    });
    expect(result.error).toBe('timeout after 5ms');
    expect(fake.killSignals).toEqual(['SIGTERM']);
  });

  it('escalates an uncooperative child from SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeCargoChild();
      const managedSpawnFn = (async () => managedCargoResult(fake.child)) as never;
      const promise = runCargoCriterionCheck({
        ...runnerOpts,
        timeoutMs: 5,
        managedSpawnFn,
      });
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(5);
      expect(fake.killSignals).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fake.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
      fake.child.emit('close', null, 'SIGKILL');
      const result = await promise;
      expect(result.error).toBe('timeout after 5ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── grading-time evaluation (live-run semantics, injectable runner) ───────────
// These stubs stand in for the REAL runner, so they carry the same `byFile` per-file
// grain a real report does (WI-39848) — the batched evaluator attributes verdicts from
// it. Totals are DERIVED from byFile rather than hand-written beside it, so a stub can
// never drift into an internally-inconsistent shape the real distiller could not produce.
const totalsOf = (byFile: Record<string, { passed: number; failed: number; skipped: number; collectionFailed: boolean }>) => ({
  passed: Object.values(byFile).reduce((n, b) => n + b.passed, 0),
  failed: Object.values(byFile).reduce((n, b) => n + b.failed, 0),
  skipped: Object.values(byFile).reduce((n, b) => n + b.skipped, 0),
});
const passRun = (files: string[]) => {
  const byFile = Object.fromEntries(
    files.map((f) => [f, { passed: 3, failed: 0, skipped: 0, collectionFailed: false }]),
  );
  return {
    ok: true,
    runId: 'run-1',
    root,
    ...totalsOf(byFile),
    files: files.length,
    failures: [],
    failuresTruncated: false,
    durationMs: 100,
    byFile,
  };
};
const failRun = (files: string[]) => {
  // Only the FIRST file is red — which is also what makes this a meaningful batched
  // fixture: a criterion naming a later file must NOT inherit this failure.
  const byFile = Object.fromEntries(
    files.map((f, i) => [f, { passed: i === 0 ? 2 : 3, failed: i === 0 ? 1 : 0, skipped: 0, collectionFailed: false }]),
  );
  return {
    ...passRun(files),
    ok: false,
    ...totalsOf(byFile),
    failures: [{ file: files[0], test: 'does the thing', message: 'boom' }],
    byFile,
  };
};

const collectionFailRun = (files: string[], message: string) => {
  const byFile = Object.fromEntries(
    files.map((f, i) => [
      f,
      i === 0
        ? { passed: 0, failed: 1, skipped: 0, collectionFailed: true }
        : { passed: 3, failed: 0, skipped: 0, collectionFailed: false },
    ]),
  );
  return {
    ...passRun(files),
    ok: false,
    ...totalsOf(byFile),
    failures: [{ file: files[0], test: '(file failed to collect)', message }],
    byFile,
  };
};

const CRITERIA = [
  { key: 'fuzzy', check: undefined },
  { key: 'det', check: testsCheck(['packages/x/real.test.ts']) },
];

describe('evaluateCriterionTestChecks (grading time)', () => {
  it('passes concrete ledger scope to the runner and preserves its bindable testRunIds', async () => {
    const calls: Array<{ files: string[]; workspaceId?: string; harnessSlug?: string }> = [];
    const runner: CriterionCheckRunner = async ({ files, workspaceId, harnessSlug }) => {
      calls.push({ files, workspaceId, harnessSlug });
      return { ...passRun(files), testRunIds: [901, 902] } as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      workspaceId: 'workspace-test',
      harnessSlug: 'papercusp',
      runner,
    });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { files: ['packages/x/real.test.ts'], workspaceId: 'workspace-test', harnessSlug: 'papercusp' },
    ]);
    if (res.ok) expect(res.checkRuns.det).toMatchObject({ testRunIds: [901, 902] });
  });

  it('runs the check for a rated tests-check criterion and stamps a pass verdict', async () => {
    const calls: string[][] = [];
    const runner: CriterionCheckRunner = async ({ files }) => {
      calls.push(files);
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { fuzzy: { rating: 'healthy' }, det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkRuns.det).toMatchObject({ kind: 'tests', verdict: 'pass', passed: 3, failed: 0, runId: 'run-1' });
      expect(res.checkRuns.fuzzy).toBeUndefined();
    }
    expect(calls).toEqual([['packages/x/real.test.ts']]);
  });

  it('attributes an external-checkout file when Vitest reports the same real file relative to its run root', async () => {
    const siblingPath = 'portal/tests/sibling.test.ts';
    const absoluteSibling = join(siblingRepo, 'tests', 'sibling.test.ts');
    const runner: CriterionCheckRunner = async ({ files }) => {
      expect(files).toEqual([absoluteSibling]);
      const byFile = {
        'tests/sibling.test.ts': { passed: 3, failed: 0, skipped: 0, collectionFailed: false },
      };
      return {
        ok: true,
        runId: 'external-run',
        root: siblingRepo,
        ...totalsOf(byFile),
        files: 1,
        failures: [],
        failuresTruncated: false,
        durationMs: 10,
        byFile,
      } as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'external', check: testsCheck([siblingPath]) }],
      ratings: { external: { rating: 'healthy' } },
      root: siblingAmbient,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkRuns.external).toMatchObject({
        files: [absoluteSibling],
        verdict: 'pass',
        passed: 3,
        failed: 0,
        runId: 'external-run',
      });
    }
  });

  it('attributes the external file when a symlink run root makes Vitest report a ../-escaping key', async () => {
    const siblingPath = 'portal/tests/sibling.test.ts';
    const absoluteSibling = join(siblingRepo, 'tests', 'sibling.test.ts');
    const reportedPath = relative(siblingRepoLink, absoluteSibling).split(sep).join('/');
    expect(reportedPath).toContain('../');
    const runner: CriterionCheckRunner = async () => {
      const byFile = {
        [reportedPath]: { passed: 3, failed: 0, skipped: 0, collectionFailed: false },
      };
      return {
        ok: true,
        runId: 'symlink-root-run',
        root: siblingRepoLink,
        ...totalsOf(byFile),
        files: 1,
        failures: [],
        failuresTruncated: false,
        durationMs: 10,
        byFile,
      } as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'external', check: testsCheck([siblingPath]) }],
      ratings: { external: { rating: 'healthy' } },
      root: siblingAmbient,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkRuns.external).toMatchObject({ verdict: 'pass', passed: 3, failed: 0 });
    }
  });

  it('REFUSES a pass-claiming rating the run contradicts (check_contradicted)', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => failRun(files) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_contradicted');
      expect(res.detail).toContain("'det'");
      expect(res.detail).toContain('FAILED');
    }
  });

  it('preserves a collection-error message in the deterministic refusal', async () => {
    const collectionMessage = "Expected ';' but found 'why' at unanswered-directed.ts:639:58";
    const runner: CriterionCheckRunner = async ({ files }) => collectionFailRun(files, collectionMessage) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_contradicted');
      expect(res.detail).toContain(collectionMessage);
      expect('run' in res).toBe(true);
      if ('run' in res) {
        expect(res.run.kind).toBe('tests');
        if (res.run.kind === 'tests') {
          expect(res.run.failures?.[0]).toContain('(file failed to collect)');
          expect(res.run.failures?.[0]).toContain(collectionMessage);
        }
      }
    }
  });

  it('CONTROL: the SAME failing run with an honest rating is stamped, not refused — the verdict keys on the pair', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => failRun(files) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'broken' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const det = res.checkRuns.det;
      expect(det.verdict).toBe('fail');
      // `failures` rides only the kind:'tests' arm of the ScorecardCheckRun union, so
      // narrow on the discriminant rather than asserting past it.
      if (det.kind !== 'tests') throw new Error(`expected a tests check run, got ${det.kind}`);
      expect(det.failures?.[0]).toContain('does the thing');
    }
  });

  it('REFUSES when the check path no longer resolves at grading time (check_path_unresolved), before any run', async () => {
    let ran = false;
    const runner: CriterionCheckRunner = async ({ files }) => {
      ran = true;
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck(['packages/x/deleted.test.ts']) }],
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('check_path_unresolved');
    expect(ran).toBe(false);
  });

  it('REFUSES when the run itself cannot judge (route_error → check_run_failed)', async () => {
    const runner: CriterionCheckRunner = async () =>
      ({ ok: false, runId: 'route-run-42', root, error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence' }) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'broken' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_run_failed');
      if (res.error !== 'check_run_failed') throw new Error(`unexpected refusal ${res.error}`);
      expect(res.detail).toContain('runId route-run-42');
      expect(res.runner).toEqual({
        runId: 'route-run-42', root, error: 'route_error',
        routerOutput: 'TEST_FILE_ROUTE_ERROR exact router evidence',
      });
    }
  });

  it('preserves no-report diagnostics and full router log paths through a scorecard refusal', async () => {
    const diagnostics = {
      routerExit: 1,
      reportDirEntries: [],
      markerSeen: true,
      summarySeen: 'none' as const,
      routerLogPaths: ['/tmp/scorecard-setup-stdout.log', '/tmp/scorecard-setup-stderr.log'],
    };
    const runner: CriterionCheckRunner = async () => ({
      ok: false, runId: 'setup-refused-42', root, error: 'no_report', diagnostics,
      routerOutput: `${'later router progress\n'.repeat(300)}Error: TEST SUBSTRATE STORAGE LOW`,
    });
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'check_run_failed') throw new Error('expected a failed check run');
    expect(res.runner).toMatchObject({
      runId: 'setup-refused-42', error: 'no_report', diagnostics,
    });
    expect(res.runner?.routerOutput).toHaveLength(2_000);
    expect(res.runner?.routerOutput).toContain('Error: TEST SUBSTRATE STORAGE LOW');
  });

  it('REFUSES an exit-zero file whose entire suite is skipped as unjudged, never passed', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => {
      const byFile = Object.fromEntries(
        files.map((f) => [f, { passed: 0, failed: 0, skipped: 3, collectionFailed: false }]),
      );
      return { ...passRun(files), ...totalsOf(byFile), byFile } as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_run_failed');
      expect(res.criterionKey).toBe('det');
      expect(res.detail).toContain('executed ZERO tests');
      expect(res.detail).toContain('3 skipped');
    }
  });

  it('REFUSES one skip-only file even when a sibling file executed and made the batch green', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => {
      const byFile = Object.fromEntries(
        files.map((f, i) => [
          f,
          i === 0
            ? { passed: 3, failed: 0, skipped: 0, collectionFailed: false }
            : { passed: 0, failed: 0, skipped: 4, collectionFailed: false },
        ]),
      );
      return { ...passRun(files), ...totalsOf(byFile), byFile } as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck([MANY[0], MANY[1]]) }],
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_run_failed');
      expect(res.detail).toContain(MANY[1]);
      expect(res.detail).not.toContain(`${MANY[0]} (`);
    }
  });

  it('skips unrated tests-check criteria (emit completeness governs rating coverage separately)', async () => {
    let ran = false;
    const runner: CriterionCheckRunner = async ({ files }) => {
      ran = true;
      return passRun(files) as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: CRITERIA,
      ratings: { fuzzy: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    expect(ran).toBe(false);
  });

  // ── WI-39848: the starvation guard ──────────────────────────────────────────
  // A rubric with many tests-checks used to be UNGRADEABLE: one vitest process per
  // criterion against a single shared deadline, so each run ate budget the next needed
  // and the last criterion timed out every time — deterministically, on criterion COUNT.
  // That blocked the plan's ship gate outright, and the refusal blamed the starved
  // criterion's file for being "too slow" when the budget had been spent upstream.
  it('WI-39848: batches EVERY criterion into ONE runner call, so budget cannot be starved by criterion count', async () => {
    const calls: string[][] = [];
    const runner: CriterionCheckRunner = async ({ files }) => {
      calls.push(files);
      return passRun(files) as never;
    };
    const criteria = MANY.map((f, i) => ({ key: `c${i}`, check: testsCheck([f]) }));
    const res = await evaluateCriterionTestChecks({
      criteria,
      ratings: Object.fromEntries(criteria.map((c) => [c.key, { rating: 'healthy' }])),
      root,
      runner,
      // The real budget. Under the old per-criterion loop the 8th run got the 1000ms
      // floor and timed out; the point of the fix is that N no longer divides it.
      timeoutMs: 50_000,
    });
    expect(res.ok).toBe(true);
    // THE assertion: one run total, not one per criterion.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(MANY);
    if (res.ok) {
      expect(Object.keys(res.checkRuns).sort()).toEqual(criteria.map((c) => c.key).sort());
      for (const c of criteria) expect(res.checkRuns[c.key]).toMatchObject({ verdict: 'pass' });
    }
  });

  it('WI-39848: attributes per-file — one criterion failing does NOT condemn another sharing the batch', async () => {
    // failRun reds only the FIRST file, which is what makes this meaningful: with a
    // batched run, judging on the aggregate would fail every criterion at once.
    const runner: CriterionCheckRunner = async ({ files }) => failRun(files) as never;
    const criteria = [
      { key: 'red', check: testsCheck([MANY[0]]) },
      { key: 'green', check: testsCheck([MANY[1]]) },
    ];
    const res = await evaluateCriterionTestChecks({
      criteria,
      // Honest ratings, so the contradiction refusal does not fire and we can inspect
      // both verdicts in one pass.
      ratings: { red: { rating: 'broken' }, green: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.checkRuns.red).toMatchObject({ verdict: 'fail', failed: 1, passed: 2 });
      expect(res.checkRuns.green).toMatchObject({ verdict: 'pass', failed: 0, passed: 3 });
    }
  });

  it('WI-39848: a file the batch never reported is REFUSED as unjudged, never counted as a pass', async () => {
    // The silent-pass hazard batching introduces: a green aggregate must not vouch for a
    // file that never ran. Runner reports only the first file.
    const runner: CriterionCheckRunner = async ({ files }) => passRun([files[0]]) as never;
    const res = await evaluateCriterionTestChecks({
      criteria: [
        { key: 'reported', check: testsCheck([MANY[0]]) },
        { key: 'silent', check: testsCheck([MANY[1]]) },
      ],
      ratings: { reported: { rating: 'healthy' }, silent: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('check_run_failed');
      expect(res.criterionKey).toBe('silent');
      expect(res.detail).toContain(MANY[1]);
    }
  });

  it('WI-39848: a runner reporting no per-file grain REFUSES rather than judging on the aggregate', async () => {
    const runner: CriterionCheckRunner = async ({ files }) => {
      const { byFile: _drop, ...noGrain } = passRun(files);
      return noGrain as never;
    };
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck(['packages/x/real.test.ts']) }],
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('check_run_failed');
  });
});

// ── kind:'coverage' (P-006) ───────────────────────────────────────────────────
const coverageCheck = (
  scope: { surfaceKind?: string; sourceFiles?: string[]; planTouched?: true },
  floor: 'l1' | 'l2' | 'l3' | 'l4' = 'l1',
) => ({ kind: 'coverage' as const, scope, floor });

/** A census reading. Defaults describe a healthy, fully-covered, DECLARED population,
 *  so each test perturbs exactly the one field it is about. */
const measurement = (over: {
  surfaces?: number;
  meets?: number;
  belowUnwaived?: number;
  verdict?: 'measured' | 'not-measured';
  censusUnknown?: string[] | null;
  rows?: string[];
  weakest?: string | null;
} = {}): CoverageMeasurement => {
  const surfaces = over.surfaces ?? 10;
  const meets = over.meets ?? 10;
  return {
    verdict: over.verdict ?? (surfaces > 0 ? 'measured' : 'not-measured'),
    censusUnknown: over.censusUnknown ?? null,
    coverage: {
      surfaces,
      meets,
      belowUnwaived: over.belowUnwaived ?? surfaces - meets,
      pct: surfaces > 0 ? Math.round((meets / surfaces) * 1000) / 10 : null,
      fidelity: { weakest: over.weakest ?? 'declared', declaredPct: surfaces > 0 ? 100 : null },
    },
    rows: (over.rows ?? []).map((surfaceId) => ({ surfaceId, kind: 'mcp-tool', sourceFile: null })),
  };
};

const reader = (m: CoverageMeasurement, spy?: (a: Parameters<CoverageReader>[0]) => void): CoverageReader =>
  async (a) => {
    spy?.(a);
    return m;
  };

describe('rubricCriterionCheckSchema — the coverage arm (P-006)', () => {
  it('accepts a coverage check; refuses unknown fields, a bad floor, and an empty file list', () => {
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ surfaceKind: 'mcp-tool' })).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ planTouched: true }, 'l3')).success).toBe(true);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({})).success).toBe(true);
    expect(
      rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: {}, floor: 'l1', extra: 1 }).success,
    ).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: {}, floor: 'l9' }).success).toBe(false);
    expect(rubricCriterionCheckSchema.safeParse(coverageCheck({ sourceFiles: [] })).success).toBe(false);
    // scope is strict too — a typo'd key must not silently widen the scope to everything
    expect(
      rubricCriterionCheckSchema.safeParse({ kind: 'coverage', scope: { surfaceKinds: 'mcp-tool' }, floor: 'l1' })
        .success,
    ).toBe(false);
  });
});

describe('validateCriterionCheckPaths — coverage scopes', () => {
  it('REFUSES a scope naming both planTouched and an explicit sourceFiles list', () => {
    const v = validateCriterionCheckPaths(
      [{ key: 'cov', check: coverageCheck({ planTouched: true, sourceFiles: ['a.ts'] }) }],
      { root },
    );
    expect(v.ok).toBe(false);
    expect(v.scopeFailures[0]?.criterionKey).toBe('cov');
    expect(() => assertCriterionCheckPathsResolve([{ key: 'cov', check: coverageCheck({ planTouched: true, sourceFiles: ['a.ts'] }) }], { root })).toThrow(/invalid_args/);
  });

  it('CONTROL: either one alone is accepted, and a coverage check never counts as a tests path', () => {
    for (const scope of [{ planTouched: true as const }, { sourceFiles: ['a.ts'] }, {}]) {
      const v = validateCriterionCheckPaths([{ key: 'cov', check: coverageCheck(scope) }], { root });
      expect(v.ok).toBe(true);
      expect(v.checked).toBe(0);
    }
  });
});

describe('evaluateCriterionCoverageChecks (grading time)', () => {
  const rated = (rating: string) => ({ cov: { rating } });

  it('stamps a pass verdict when nothing in scope is below the floor, and re-reads the census at the asked rung', async () => {
    let seen: Parameters<CoverageReader>[0] | undefined;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ surfaceKind: 'mcp-tool' }, 'l3') }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 10 }), (a) => (seen = a)),
      nowIso: () => '2026-01-01T00:00:00.000Z',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkRuns.cov).toMatchObject({
      kind: 'coverage',
      verdict: 'pass',
      floor: 'l3',
      surfaces: 10,
      belowUnwaived: 0,
    });
    // measured NOW, at the criterion's own floor, over the gap list
    expect(seen).toMatchObject({ kind: 'mcp-tool', rung: 'l3', gapsOnly: true });
  });

  // ── FAILURE MODE 1: the vacuous pass ────────────────────────────────────────
  it('REFUSES a scope matching ZERO surfaces rather than passing it (coverage_scope_empty)', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ surfaceKind: 'nonesuch' }) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 0, meets: 0, censusUnknown: ['census-has-not-run: …'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
    expect(res.detail).toContain('ZERO censused surfaces');
    expect(res.detail).toContain('census-has-not-run');
  });

  it('REFUSES an empty scope even when the rating is HONEST — 0-of-0 is not measurable, whatever the grader says', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('broken'),
      readCoverage: reader(measurement({ surfaces: 0, meets: 0 })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
  });

  it('CONTROL: the SAME shape with a real denominator passes — the refusal keys on the empty population, not the scope shape', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 1, meets: 1 })),
    });
    expect(res.ok).toBe(true);
  });

  it("REFUSES a not-measured verdict even if a count sneaked through — the words and the number are both honoured", async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 5, meets: 5, verdict: 'not-measured' })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_scope_empty');
  });

  // ── the contradiction pair ──────────────────────────────────────────────────
  it('REFUSES a pass-claiming rating the census contradicts, NAMING the failing surfaces', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}, 'l2') }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 7, rows: ['tool:a', 'tool:b', 'tool:c'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('coverage_contradicted');
    expect(res.detail).toContain('3 of 10');
    expect(res.detail).toContain('tool:a');
    // `run` rides only the coverage_contradicted arm of CriterionCoverageRefusal; narrow
    // on the discriminant so the assertion below is typed rather than asserted past.
    if (res.error !== 'coverage_contradicted') {
      throw new Error(`expected coverage_contradicted, got ${res.error}`);
    }
    expect(res.run).toMatchObject({ verdict: 'fail', belowUnwaived: 3 });
  });

  it('CONTROL: the SAME failing measurement with an honest rating is STAMPED, not refused — the verdict keys on the pair', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}, 'l2') }],
      ratings: rated('degraded'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 7, rows: ['tool:a'] })),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkRuns.cov).toMatchObject({ verdict: 'fail', belowUnwaived: 3 });
  });

  // ── FAILURE MODE 2: a bounded sample must not read as the whole ─────────────
  it('says the named surfaces stand for a LARGER population when the gap list is bounded', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 100, meets: 60, rows: ['a', 'b'] })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain('+38 more');
  });

  it('carries the fidelity ceiling into the refusal — a partial census flatters, and the message must say so', async () => {
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({}) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 10, meets: 4, rows: ['a'], weakest: 'file-only' })),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.detail).toContain('file-only');
    expect(res.detail).toContain('flatters');
  });

  // ── plan-touched: the reverse map ───────────────────────────────────────────
  it('resolves planTouched to the plan\'s changed files and measures over THEM', async () => {
    let seen: Parameters<CoverageReader>[0] | undefined;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [{ key: 'cov', check: coverageCheck({ planTouched: true }) }],
      ratings: rated('healthy'),
      readCoverage: reader(measurement({ surfaces: 3, meets: 3 }), (a) => (seen = a)),
      resolvePlanTouchedFiles: async () => ['packages/x/a.ts', 'packages/x/b.ts'],
    });
    expect(res.ok).toBe(true);
    expect(seen?.sourceFiles).toEqual(['packages/x/a.ts', 'packages/x/b.ts']);
    if (!res.ok) return;
    // the record stores what was MEASURED, not merely the intent to measure
    expect(res.checkRuns.cov).toMatchObject({
      scope: { planTouched: true, sourceFiles: ['packages/x/a.ts', 'packages/x/b.ts'] },
    });
  });

  it('REFUSES planTouched that resolves to NOTHING instead of silently widening to the whole census', async () => {
    for (const resolver of [async () => null, async () => [] as string[]]) {
      let called = false;
      const res = await evaluateCriterionCoverageChecks({
        criteria: [{ key: 'cov', check: coverageCheck({ planTouched: true }) }],
        ratings: rated('healthy'),
        readCoverage: reader(measurement({ surfaces: 999, meets: 999 }), () => (called = true)),
        resolvePlanTouchedFiles: resolver,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('coverage_scope_empty');
      // and it never got as far as measuring the unscoped census
      expect(called).toBe(false);
    }
  });

  it('skips unrated and non-coverage criteria without reading the census at all', async () => {
    let called = false;
    const res = await evaluateCriterionCoverageChecks({
      criteria: [
        { key: 'cov', check: coverageCheck({}) },
        { key: 'fuzzy' },
        { key: 'det', check: testsCheck(['packages/x/real.test.ts']) },
      ],
      ratings: { det: { rating: 'healthy' } },
      readCoverage: reader(measurement(), () => (called = true)),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Object.keys(res.checkRuns)).toEqual([]);
    expect(called).toBe(false);
  });
});

// ── test-case filter on a tests check (test-rubric-unification P-002 / R-2) ──────────
describe('tests check with a testName filter', () => {
  const FILE = 'packages/x/real.test.ts';
  const named = (testName: string) => [{ key: 'det', check: { ...testsCheck([FILE]), testName } }];
  // The file's whole-file counts are GREEN while one unrelated case is red, so a verdict
  // that ignored the filter would be distinguishable from one that honours it.
  const CASES = [
    { caseKey: 'probe sql > refuses a write', occurrence: 1, status: 'pass' as const, durationMs: 4 },
    { caseKey: 'probe sql > reads a row', occurrence: 1, status: 'fail' as const, durationMs: 5 },
    { caseKey: 'probe sql > skips on no db', occurrence: 1, status: 'skip' as const, durationMs: null },
  ];
  const runner: CriterionCheckRunner = async ({ files }) => ({ ...passRun(files), testRunIds: [77] }) as never;
  const loaderOf = (cases: typeof CASES | null, seen?: Array<{ testRunIds: readonly number[]; file: string }>): CriterionCaseLoader =>
    async (args) => {
      seen?.push(args);
      return cases;
    };

  it('schema: accepts testName with exactly one file and refuses it with two', () => {
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: ['a.test.ts'], testName: 'x > y' }).success).toBe(true);
    const two = rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: ['a.test.ts', 'b.test.ts'], testName: 'x' });
    expect(two.success).toBe(false);
    expect(JSON.stringify(two.success ? '' : two.error.issues)).toContain('exactly one file');
    expect(rubricCriterionCheckSchema.safeParse({ kind: 'tests', files: ['a.test.ts'], testName: '   ' }).success).toBe(false);
  });

  const INTEGRATION = 'packages/x/named.integration.test.ts';
  writeFileSync(join(root, INTEGRATION), 'export {};\n');
  const selected = () => ({ kind: 'tests' as const, files: [FILE, INTEGRATION], cases: [
    { file: FILE, testName: 'refuses a write' },
    { file: INTEGRATION, testName: 'integrated > serves an authorized call' },
  ] });
  const integratedCases = [{ caseKey: 'integrated > serves an authorized call', occurrence: 1, status: 'pass' as const, durationMs: 8 }];

  it('requires named selectors for every file and refuses unknown files, duplicates and mixed shorthand', () => {
    expect(rubricCriterionCheckSchema.safeParse(selected()).success).toBe(true);
    for (const bad of [
      { ...selected(), cases: selected().cases.slice(0, 1) },
      { ...selected(), cases: [...selected().cases, { file: 'other.test.ts', testName: 'case' }] },
      { ...selected(), cases: [...selected().cases, selected().cases[0]] },
      { ...selected(), testName: 'refuses a write' },
      { ...selected(), cases: [] },
    ]) expect(rubricCriterionCheckSchema.safeParse(bad).success).toBe(false);
  });

  it('judges required unit and integration cases in one batch and ignores unrelated failures', async () => {
    const seen: string[] = [];
    const batch = vi.fn<CriterionCheckRunner>(runner);
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: selected() }], ratings: { det: { rating: 'healthy' } }, root, runner: batch,
      caseLoader: async ({ file }) => { seen.push(file); return file === FILE ? CASES : integratedCases; },
    });
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]![0].files).toEqual([FILE, INTEGRATION]);
    expect(seen).toEqual([FILE, INTEGRATION]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkRuns.det).toMatchObject({ verdict: 'pass', passed: 2, failed: 0, matchedCases: 2, cases: selected().cases });
  });

  it.each(['missing', 'skipped', 'unrecorded', 'unreadable', 'failed'])('refuses an unproved required integration case: %s', async (mode) => {
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: selected() }], ratings: { det: { rating: 'healthy' } }, root, runner,
      caseLoader: async ({ file }) => {
        if (file === FILE) return CASES;
        if (mode === 'unreadable') throw new Error('ledger read failed');
        if (mode === 'unrecorded') return null;
        if (mode === 'missing') return [{ ...integratedCases[0]!, caseKey: 'renamed case' }];
        return [{ ...integratedCases[0]!, status: mode === 'failed' ? 'fail' : 'skip' }];
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(mode === 'failed' ? 'check_contradicted' : mode === 'unreadable' ? 'check_run_failed' : 'check_test_case_unresolved');
  });

  it('loads a file once and counts overlapping case selectors once', async () => {
    const loader = vi.fn<CriterionCaseLoader>(loaderOf(CASES));
    const check = { ...testsCheck([FILE]), cases: [
      { file: FILE, testName: 'refuses a write' },
      { file: FILE, testName: 'probe sql > refuses a write' },
    ] };
    const res = await evaluateCriterionTestChecks({ criteria: [{ key: 'det', check }], ratings: { det: { rating: 'healthy' } }, root, runner, caseLoader: loader });
    expect(loader).toHaveBeenCalledOnce();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkRuns.det).toMatchObject({ passed: 1, failed: 0, matchedCases: 1 });
  });

  it('refuses a filter that matches zero recorded cases instead of counting it as a pass', async () => {
    const res = await evaluateCriterionTestChecks({
      criteria: named('probe sql > renamed away'),
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: loaderOf(CASES),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res).toMatchObject({
      error: 'check_test_case_unresolved',
      criterionKey: 'det',
      code: 'test_case_filter_zero_match',
      testName: 'probe sql > renamed away',
    });
    if (res.error === 'check_test_case_unresolved') expect(res.recordedSample).toContain('probe sql > refuses a write');
  });

  it.each(['missing', 'skipped', 'failed', 'passed'] as const)('a planned case still requires exact passing execution at grading: %s', async mode => {
    const testName = 'new behavior in the existing suite';
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: { ...testsCheck([FILE]), cases: [
        { file: FILE, testName, plannedReason: 'The plan will implement this case.' },
      ] } }],
      ratings: { det: { rating: 'healthy' } }, root, runner,
      caseLoader: async () => mode === 'missing' ? CASES : [{ caseKey: testName, occurrence: 1,
        status: mode === 'passed' ? 'pass' : mode === 'failed' ? 'fail' : 'skip', durationMs: 4 }],
    });
    expect(res.ok).toBe(mode === 'passed');
    if (!res.ok) expect(res.error).toBe(mode === 'failed' ? 'check_contradicted' : 'check_test_case_unresolved');
    else expect(res.checkRuns.det).toMatchObject({ verdict: 'pass', matchedCases: 1, passed: 1 });
  });

  it('judges only the matched cases: a passing case passes even when a sibling case in the file failed', async () => {
    const seen: Array<{ testRunIds: readonly number[]; file: string }> = [];
    const res = await evaluateCriterionTestChecks({
      criteria: named('refuses a write'),
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: loaderOf(CASES, seen),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checkRuns.det).toMatchObject({
      kind: 'tests',
      verdict: 'pass',
      passed: 1,
      failed: 0,
      testName: 'refuses a write',
      matchedCases: 1,
    });
    // The loader is asked for exactly this run's ledger rows and the cited file.
    expect(seen).toEqual([{ testRunIds: [77], file: FILE }]);
  });

  it('a matched failing case contradicts a pass rating', async () => {
    const res = await evaluateCriterionTestChecks({
      criteria: named('reads a row'),
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: loaderOf(CASES),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('check_contradicted');
    if (res.error === 'check_contradicted') {
      expect(res.run).toMatchObject({ verdict: 'fail', passed: 0, failed: 1, testName: 'reads a row' });
      expect(JSON.stringify(res.run)).toContain('probe sql > reads a row');
    }
  });

  it('refuses when the run recorded no cases for the file (unknown is not a pass)', async () => {
    const res = await evaluateCriterionTestChecks({
      criteria: named('refuses a write'),
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: loaderOf(null),
    });
    expect(res).toMatchObject({ ok: false, error: 'check_test_case_unresolved', code: 'test_case_filter_no_cases_recorded' });
  });

  it('refuses a filter whose only matches were skipped', async () => {
    const res = await evaluateCriterionTestChecks({
      criteria: named('skips on no db'),
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: loaderOf(CASES),
    });
    expect(res).toMatchObject({ ok: false, error: 'check_test_case_unresolved', code: 'test_case_filter_unexecuted' });
  });

  it('leaves a check without testName on whole-file counts and never reads cases', async () => {
    let read = false;
    const res = await evaluateCriterionTestChecks({
      criteria: [{ key: 'det', check: testsCheck([FILE]) }],
      ratings: { det: { rating: 'healthy' } },
      root,
      runner,
      caseLoader: async () => {
        read = true;
        return CASES;
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.checkRuns.det).toMatchObject({ verdict: 'pass', passed: 3, failed: 0 });
    if (res.ok) expect(res.checkRuns.det).not.toHaveProperty('testName');
    expect(read).toBe(false);
  });
});
