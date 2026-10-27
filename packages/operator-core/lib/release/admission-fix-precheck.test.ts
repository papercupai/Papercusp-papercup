import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_PRECHECK_FILE_CONCURRENCY,
  ADMISSION_PRECHECK_FILE_CONCURRENCY_MAX,
  ADMISSION_PRECHECK_SETUP_BUDGET_MS,
  ADMISSION_PRECHECK_SETUP_IDLE_MS,
  ADMISSION_PRECHECK_HEARTBEAT_INTERVAL_MS,
  admissionPrecheckFileConcurrency,
  admissionPrecheckSetupEnv,
  classifyTestFileRun,
  confirmationRerunFiles,
  createCheckpointTreeFixPrecheckRunner,
  defaultExec,
  dependencyGenerationInfraCode,
  deriveAdmissionPrecheckRoot,
  evaluateFixPrecheck,
  isTestFilePath,
  precheckPopulation,
  previousHeadBaselineFiles,
  REPORT_ONLY_DEFERRED_SAMPLE_CAP,
  defaultGitCommonDir,
  resolveCanonicalIntegrationRoot,
  ROUTER_EXIT_NOT_MEASURED,
  ROUTER_EXIT_TEMPFAIL,
  type AdmissionRadius,
  type ExecOptions,
  type AdmissionPrecheckRootProbe,
  type ExecResult,
  type FixPrecheckRunResult,
  type FixPrecheckProgress,
} from './admission-fix-precheck';
import {
  TEST_FILE_EXIT_FAILED,
  TEST_FILE_EXIT_NOT_MEASURED,
  TEST_FILE_EXIT_PASSED,
  TEST_FILE_EXIT_TEMPFAIL,
  testFileRunWasMeasured,
  // The .mjs contract module has no declaration file; the diagnostic lands on
  // the `from` line, so the suppression must be the LAST comment line directly
  // above it.
  // @ts-expect-error
} from '../../../../scripts/lib/test-file-exit-codes.mjs';

const C = 'e'.repeat(40);
const sig = (id: string, kind: 'test-file' | 'lint-leg' | 'workspace-task' | 'post-suite-leg' | 'seed' = 'test-file') => ({ kind, id });
const ran = (results: Array<[string, 'pass' | 'fail' | 'unmeasured']>): FixPrecheckRunResult => ({
  ran: true,
  commit: C,
  results: results.map(([path, status]) => ({ path, status })),
});

describe('precheckPopulation (P-006 / R6)', () => {
  it('WI-8351 treats immutable dependency-selected node tests as imported-red candidates without altering signature proofs', () => {
    const pop = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: ['component'],
      affectedTestFiles: ['lib/red.test.ts', 'component/test/pair.node-test.ts', 'parent.test.mjs'] });
    expect(pop.signatureTestFiles).toEqual(['lib/red.test.ts']);
    expect(pop.admittedTestFiles).toEqual(['component/test/pair.node-test.ts', 'parent.test.mjs']);
    expect(pop.canProveDoesNotFix).toBe(true);
    expect(evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['component/test/pair.node-test.ts', 'fail'],
      ['parent.test.mjs', 'pass']]))).toMatchObject({ ok: false, code: 'admission-imports-red' });
  });
  it('splits signature test files from admitted-outside-signature test files and ignores non-test paths', () => {
    const pop = precheckPopulation({
      signature: [sig('lib/red.test.ts'), sig('lib/red.test.ts'), sig('lib/other.test.ts')],
      admittedPaths: ['lib/red.test.ts', './lib/fix.ts', 'lib/new.test.ts', 'lib/new.test.ts', 'lib/x.integration.test.ts'],
    });
    expect(pop.signatureTestFiles).toEqual(['lib/red.test.ts', 'lib/other.test.ts']);
    expect(pop.admittedTestFiles).toEqual(['lib/new.test.ts', 'lib/x.integration.test.ts']);
    expect(pop.nonTestKinds).toEqual([]);
    expect(pop.canProveDoesNotFix).toBe(true);
    expect(pop.files).toEqual(['lib/red.test.ts', 'lib/other.test.ts', 'lib/new.test.ts', 'lib/x.integration.test.ts']);
  });

  it('cannot prove does-not-fix when the signature carries a non-test kind, or is empty', () => {
    const mixed = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lint:tsc', 'lint-leg')], admittedPaths: [] });
    expect(mixed.canProveDoesNotFix).toBe(false);
    expect(mixed.nonTestKinds).toEqual(['lint-leg']);
    expect(mixed.signatureTestFiles).toEqual(['lib/red.test.ts']);
    const empty = precheckPopulation({ signature: [], admittedPaths: ['lib/fix.ts'] });
    expect(empty.canProveDoesNotFix).toBe(false);
    expect(empty.files).toEqual([]);
  });

  it('recognises the test-file spellings the router runs', () => {
    for (const p of ['a.test.ts', 'a.spec.tsx', 'a.integration.test.ts', 'a.test.mjs', 'a.spec.cjs', 'a.test.js']) {
      expect(isTestFilePath(p), p).toBe(true);
    }
    for (const p of ['a.ts', 'test.ts', 'a.tests.ts', 'a.test.ts.snap', 'a.test.md']) {
      expect(isTestFilePath(p), p).toBe(false);
    }
  });
});

describe('evaluateFixPrecheck (P-006 / R6)', () => {
  const pop = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lib/red2.test.ts')], admittedPaths: ['lib/new.test.ts', 'lib/fix.ts'] });

  it('nothing-to-run when the population is empty (never invokes the runner)', () => {
    const empty = precheckPopulation({ signature: [sig('lint:tsc', 'lint-leg')], admittedPaths: ['lib/fix.ts'] });
    const v = evaluateFixPrecheck(empty, ran([]));
    expect(v).toMatchObject({ ok: true, ran: false, reason: 'nothing-to-run' });
  });

  it('refuses unavailable measurement without inventing failed assertions or imported reds', () => {
    const v = evaluateFixPrecheck(pop, ran([
      ['lib/red.test.ts', 'unmeasured'], ['lib/red2.test.ts', 'unmeasured'], ['lib/new.test.ts', 'unmeasured'],
    ]));
    expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', failing: [], importedRed: [], alsoImportsRed: false });
  });

  it('passes when at least one signature test file passes and nothing admitted is red', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['lib/red2.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(v.ok).toBe(true);
    if (!v.ok || !v.ran) throw new Error('expected a ran verdict');
    expect(v.fixes).toEqual(['lib/red.test.ts']);
    expect(v.failing).toEqual(['lib/red2.test.ts']);
    expect(v.commit).toBe(C);
  });

  it('refuses unavailable when a signature file is unmeasured rather than claiming none can pass', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', alsoImportsRed: false, importedRed: [] });
    if (v.ok || !v.ran) throw new Error('expected a measured refusal');
    expect(v.unmeasured).toEqual(['lib/red2.test.ts']);
    expect(v.detail).toContain('not measured');
  });

  it('refuses admission-imports-red when an admitted test file outside the signature fails', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['lib/red2.test.ts', 'pass'], ['lib/new.test.ts', 'fail']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['lib/new.test.ts'], alsoImportsRed: false });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('lib/new.test.ts');
  });

  it('names does-not-fix as primary and flags alsoImportsRed when both hold', () => {
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'fail'], ['lib/red2.test.ts', 'fail'], ['lib/new.test.ts', 'fail']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-does-not-fix', alsoImportsRed: true, importedRed: ['lib/new.test.ts'] });
  });

  it('a signature with non-test kinds can only be refused for imports-red, never does-not-fix', () => {
    const mixed = precheckPopulation({ signature: [sig('lib/red.test.ts'), sig('lint:tsc', 'lint-leg')], admittedPaths: ['lib/new.test.ts'] });
    const allRedButNoImport = evaluateFixPrecheck(mixed, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'pass']]));
    expect(allRedButNoImport.ok).toBe(true);
    const imports = evaluateFixPrecheck(mixed, ran([['lib/red.test.ts', 'fail'], ['lib/new.test.ts', 'fail']]));
    expect(imports).toMatchObject({ ok: false, code: 'admission-imports-red' });
  });

  it('a signature red admitted as a path is still a signature file, not an import', () => {
    const p = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: ['lib/red.test.ts'] });
    expect(p.admittedTestFiles).toEqual([]);
    expect(evaluateFixPrecheck(p, ran([['lib/red.test.ts', 'fail']]))).toMatchObject({ ok: false, code: 'admission-does-not-fix' });
  });

  it('accepts only the busy-tree exception; a runner failure refuses as unmeasured', () => {
    const busy: FixPrecheckRunResult = { ran: false, reason: 'checkpoint-tree-busy', detail: 'gate run holds it', holder: { pid: 7, elapsedSec: 30 } };
    expect(evaluateFixPrecheck(pop, busy)).toMatchObject({ ok: true, ran: false, reason: 'checkpoint-tree-busy', holder: { pid: 7 } });
    const failed: FixPrecheckRunResult = { ran: false, reason: 'runner-failed', detail: 'setup exited 1' };
    expect(evaluateFixPrecheck(pop, failed)).toMatchObject({
      ok: false,
      ran: false,
      code: 'admission-precheck-unavailable',
      reason: 'runner-failed',
      detail: expect.stringContaining('setup exited 1'),
    });
  });
});

describe('admission radius (green-main-cycle-time-2026-10-08 P-007, #D-036)', () => {
  const radius = (over: Partial<AdmissionRadius> = {}): AdmissionRadius => ({
    status: 'measured',
    reason: 'ok',
    guarded: ['ws-a/lib/near.test.ts'],
    reportOnly: ['ws-b/lib/known-red-leg.test.ts'],
    legs: { 'ws-a/lib/near.test.ts': '@t/a', 'ws-b/lib/known-red-leg.test.ts': '@t/b', 'lib/new.test.ts': '@t/root' },
    ...over,
  });
  const withRadius = (r: AdmissionRadius = radius()) =>
    precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: ['lib/fix.ts', 'lib/new.test.ts'], radius: r });

  it('runs guarded radius files after the admitted ones, never counts them as admitted, and never runs report-only ones', () => {
    const pop = withRadius();
    expect(pop.admittedTestFiles).toEqual(['lib/new.test.ts']);
    expect(pop.radius).toMatchObject({ guarded: ['ws-a/lib/near.test.ts'], reportOnly: ['ws-b/lib/known-red-leg.test.ts'] });
    expect(pop.files).toEqual(['lib/red.test.ts', 'lib/new.test.ts', 'ws-a/lib/near.test.ts']);
  });

  it('WI-6554700010029981: a whole red-leg workspace of report-only files stays out of the executed set', () => {
    // Measured 2026-10-27: guarded=111, reportOnly=6602 made a pre-check of 6,758 serial files (days).
    const reportOnly = Array.from({ length: 6602 }, (_, i) => `ws-b/lib/r${i}.test.ts`);
    const pop = withRadius(radius({ reportOnly }));
    expect(pop.files).toEqual(['lib/red.test.ts', 'lib/new.test.ts', 'ws-a/lib/near.test.ts']);
    expect(pop.radius?.reportOnly).toHaveLength(6602);
    const v = evaluateFixPrecheck(pop, ran([['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass'], ['ws-a/lib/near.test.ts', 'pass']]));
    expect(v).toMatchObject({ ok: true, ran: true, fixes: ['lib/red.test.ts'], unmeasured: [] });
    if (!v.ok || !v.ran) throw new Error('expected a measured pass');
    expect(v.reportOnlyDeferred).toEqual({ count: 6602, reason: 'deferred-to-verify-run', sample: reportOnly.slice(0, REPORT_ONLY_DEFERRED_SAMPLE_CAP) });
  });

  it('the managed worker rebuilds the same population from the persisted files plus the partition', () => {
    const first = withRadius();
    // The worker only has `operation.files` + `operation.radius`: radius files must not turn into admitted ones.
    const rebuilt = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: first.files, radius: first.radius });
    expect(rebuilt.admittedTestFiles).toEqual(['lib/new.test.ts']);
    expect(rebuilt.files).toEqual(first.files);
    expect(rebuilt.radius).toEqual(first.radius);
  });

  it('a radius file never shadows a signature or explicitly admitted test file', () => {
    const pop = withRadius(radius({ guarded: ['lib/red.test.ts', 'ws-a/lib/near.test.ts'], reportOnly: ['ws-a/lib/near.test.ts'] }));
    expect(pop.signatureTestFiles).toEqual(['lib/red.test.ts']);
    expect(pop.radius?.guarded).toEqual(['ws-a/lib/near.test.ts']);
    expect(pop.radius?.reportOnly).toEqual([]);
  });

  const nearRed = (): FixPrecheckRunResult => ran([
    ['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass'], ['ws-a/lib/near.test.ts', 'fail'], ['ws-b/lib/known-red-leg.test.ts', 'pass'],
  ]);
  const baseline = (status: 'pass' | 'fail' | 'unmeasured', detail?: string) =>
    ({ commit: 'b'.repeat(40), results: [{ path: 'ws-a/lib/near.test.ts', status }], ...(detail ? { detail } : {}) });

  it('a GUARDED radius file green at the MEASURED previous head and red now refuses admission-imports-red and names its leg', () => {
    const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('pass') });
    expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['ws-a/lib/near.test.ts'], newlyRedLegs: ['@t/a'], reportOnlyRed: [] });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('ws-a/lib/near.test.ts (leg @t/a)');
    expect(v.detail).toContain('previously green leg(s) turned red: @t/a');
  });

  describe('measured-wide-repair-admission-2026-10-24#D-004 ruling 1: the evaluator never implies green', () => {
    it('a guarded red with NO paired baseline is neither blamed nor published', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed());
      expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', importedRed: [], alsoImportsRed: false,
        baselineMissing: ['ws-a/lib/near.test.ts'], newlyRedLegs: [] });
      if (v.ok) throw new Error('expected refusal');
      expect(v).not.toHaveProperty('ratchet');
      expect(v.detail).toContain('no measured previous-head verdict (no paired baseline was run)');
      expect(v.detail).toContain('ws-a/lib/near.test.ts (leg @t/a)');
    });

    it('a guarded red that was ALSO red at the measured previous head is carried and publishes', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('fail') });
      expect(v).toMatchObject({ ok: true, ran: true, fixes: ['lib/red.test.ts'], carriedRed: ['ws-a/lib/near.test.ts'],
        previousHead: baseline('fail') });
    });

    it('a baseline collection failure (matched=0 / route error) maps to unmeasured, never fail or pass', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('unmeasured') });
      expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', importedRed: [], baselineMissing: ['ws-a/lib/near.test.ts'] });
    });

    it('a baseline that could not run names its reason on the refusal', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(),
        { previousHead: { commit: 'b'.repeat(40), results: [], detail: 'the paired baseline did not run (runner-failed): setup exited 1' } });
      expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', baselineMissing: ['ws-a/lib/near.test.ts'] });
      if (v.ok) throw new Error('expected refusal');
      expect(v.detail).toContain('paired baseline at bbbbbbbbbbbb: the paired baseline did not run (runner-failed): setup exited 1');
    });

    it('a proven new failure still rejects when another guarded red is unpaired (reject wins)', () => {
      const v = evaluateFixPrecheck(withRadius(), ran([
        ['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'fail'], ['ws-a/lib/near.test.ts', 'fail'], ['ws-b/lib/known-red-leg.test.ts', 'pass'],
      ]));
      expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['lib/new.test.ts'], baselineMissing: ['ws-a/lib/near.test.ts'] });
    });

    it('previousHeadBaselineFiles selects exactly the guarded files red at the built commit', () => {
      const pop = withRadius(radius({ guarded: ['ws-a/lib/near.test.ts', 'ws-a/lib/far.test.ts'] }));
      expect(previousHeadBaselineFiles(pop, [
        { path: 'lib/red.test.ts', status: 'fail' }, { path: 'lib/new.test.ts', status: 'fail' },
        { path: './ws-a/lib/near.test.ts', status: 'fail' }, { path: 'ws-a/lib/far.test.ts', status: 'unmeasured' },
        { path: 'ws-b/lib/known-red-leg.test.ts', status: 'fail' },
      ])).toEqual(['ws-a/lib/near.test.ts']);
      expect(previousHeadBaselineFiles(precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: [] }),
        [{ path: 'lib/red.test.ts', status: 'fail' }])).toEqual([]);
    });
  });

  describe('EI-27083585698781986: a one-shot flake is confirmed by a re-run before it is attributed', () => {
    const rerun = (status: 'pass' | 'fail' | 'unmeasured', commit = C) =>
      ({ commit, results: [{ path: 'ws-a/lib/near.test.ts', status }] });

    it('a guarded red that passed at the previous head and PASSES its re-run at the built commit is an advisory flake, and publishes', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('pass'), confirmation: rerun('pass') });
      expect(v).toMatchObject({ ok: true, ran: true, fixes: ['lib/red.test.ts'], flakyAtBuiltCommit: ['ws-a/lib/near.test.ts'],
        confirmation: rerun('pass'), previousHead: baseline('pass') });
      // The first failing reading is retained as raw evidence; it is just not attributed.
      expect(v.ok && v.ran && v.failing).toEqual(['ws-a/lib/near.test.ts']);
      expect(v).not.toHaveProperty('carriedRed');
    });

    it('a re-run that FAILS again keeps the attribution (admission-imports-red)', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('pass'), confirmation: rerun('fail') });
      expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['ws-a/lib/near.test.ts'], confirmation: rerun('fail') });
      expect(v).not.toHaveProperty('flakyAtBuiltCommit');
    });

    it('an UNMEASURED re-run never overturns a measured red', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('pass'), confirmation: rerun('unmeasured') });
      expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['ws-a/lib/near.test.ts'] });
    });

    it('a re-run of a DIFFERENT commit is ignored', () => {
      const v = evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('pass'), confirmation: rerun('pass', 'f'.repeat(40)) });
      expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['ws-a/lib/near.test.ts'] });
      expect(v).not.toHaveProperty('flakyAtBuiltCommit');
    });

    it('a passing re-run never rescues a red with no previous-head pass (carried or unpaired stay as they were)', () => {
      expect(evaluateFixPrecheck(withRadius(), nearRed(), { previousHead: baseline('fail'), confirmation: rerun('pass') }))
        .toMatchObject({ ok: true, carriedRed: ['ws-a/lib/near.test.ts'] });
      expect(evaluateFixPrecheck(withRadius(), nearRed(), { confirmation: rerun('pass') }))
        .toMatchObject({ ok: false, code: 'admission-precheck-unavailable', baselineMissing: ['ws-a/lib/near.test.ts'] });
    });

    it('a new ADMITTED test file failing is never confirmed away: the admission authored it', () => {
      const v = evaluateFixPrecheck(withRadius(), ran([
        ['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'fail'], ['ws-a/lib/near.test.ts', 'pass'], ['ws-b/lib/known-red-leg.test.ts', 'pass'],
      ]), { previousHead: baseline('pass'), confirmation: { commit: C, results: [{ path: 'lib/new.test.ts', status: 'pass' }] } });
      expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', importedRed: ['lib/new.test.ts'] });
    });

    it('confirmationRerunFiles selects only guarded reds MEASURED green at the previous head, never signature files', () => {
      const pop = withRadius(radius({ guarded: ['ws-a/lib/near.test.ts', 'ws-a/lib/far.test.ts', 'ws-a/lib/odd.test.ts'] }));
      const results = [
        { path: 'lib/red.test.ts', status: 'fail' as const }, { path: 'lib/new.test.ts', status: 'fail' as const },
        { path: 'ws-a/lib/near.test.ts', status: 'fail' as const }, { path: 'ws-a/lib/far.test.ts', status: 'fail' as const },
        { path: 'ws-a/lib/odd.test.ts', status: 'fail' as const },
      ];
      const previous = { commit: 'b'.repeat(40), results: [
        { path: 'ws-a/lib/near.test.ts', status: 'pass' as const }, { path: 'ws-a/lib/far.test.ts', status: 'fail' as const },
        { path: 'ws-a/lib/odd.test.ts', status: 'unmeasured' as const }, { path: 'lib/red.test.ts', status: 'pass' as const },
      ] };
      expect(confirmationRerunFiles(pop, results, previous)).toEqual(['ws-a/lib/near.test.ts']);
      expect(confirmationRerunFiles(pop, results, undefined)).toEqual([]);
    });
  });

  it('a failing REPORT-ONLY radius file is reported but cannot refuse: its leg was already red', () => {
    const v = evaluateFixPrecheck(withRadius(), ran([
      ['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass'], ['ws-a/lib/near.test.ts', 'pass'], ['ws-b/lib/known-red-leg.test.ts', 'fail'],
    ]));
    expect(v).toMatchObject({ ok: true, ran: true, fixes: ['lib/red.test.ts'], reportOnlyRed: ['ws-b/lib/known-red-leg.test.ts'] });
  });

  it('an admitted test file failing names its leg too', () => {
    const v = evaluateFixPrecheck(withRadius(), ran([
      ['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'fail'], ['ws-a/lib/near.test.ts', 'pass'], ['ws-b/lib/known-red-leg.test.ts', 'pass'],
    ]));
    expect(v).toMatchObject({ ok: false, code: 'admission-imports-red', newlyRedLegs: ['@t/root'] });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('lib/new.test.ts (leg @t/root)');
  });

  it('an unmeasured GUARDED radius file refuses unavailable: it could have imported a red', () => {
    const v = evaluateFixPrecheck(withRadius(), ran([['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass'], ['ws-b/lib/known-red-leg.test.ts', 'pass']]));
    expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', unmeasured: ['ws-a/lib/near.test.ts'] });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('ws-a/lib/near.test.ts');
  });

  it('a REPORT-ONLY radius file is deferred to the verify run, never unmeasured and never a refusal (D-036 point 3)', () => {
    const v = evaluateFixPrecheck(withRadius(), ran([['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass'], ['ws-a/lib/near.test.ts', 'pass']]));
    expect(v).toMatchObject({
      ok: true,
      ran: true,
      fixes: ['lib/red.test.ts'],
      unmeasured: [],
      reportOnlyDeferred: { count: 1, reason: 'deferred-to-verify-run', sample: ['ws-b/lib/known-red-leg.test.ts'] },
    });
  });

  it('a deferred report-only file never hides a blocking unmeasured guarded file', () => {
    const v = evaluateFixPrecheck(withRadius(), ran([['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'pass']]));
    expect(v).toMatchObject({
      ok: false,
      code: 'admission-precheck-unavailable',
      reportOnlyDeferred: { count: 1, reason: 'deferred-to-verify-run', sample: ['ws-b/lib/known-red-leg.test.ts'] },
    });
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('1 admission pre-check file(s) were not measured: ws-a/lib/near.test.ts;');
  });

  it('a skipped radius runs nothing extra but stays on the population as a loud marker', () => {
    const pop = withRadius(radius({ status: 'skipped', reason: 'over-cap(55/40)', guarded: [], reportOnly: [] }));
    expect(pop.files).toEqual(['lib/red.test.ts', 'lib/new.test.ts']);
    expect(pop.radius).toMatchObject({ status: 'skipped', reason: 'over-cap(55/40)' });
  });

  it('without a radius the verdict keeps its pre-P-007 shape and wording', () => {
    const legacy = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: ['lib/new.test.ts'] });
    const v = evaluateFixPrecheck(legacy, ran([['lib/red.test.ts', 'pass'], ['lib/new.test.ts', 'fail']]));
    expect(v).not.toHaveProperty('reportOnlyRed');
    expect(v).not.toHaveProperty('newlyRedLegs');
    if (v.ok) throw new Error('expected refusal');
    expect(v.detail).toContain('1 admitted test file(s) outside the frozen signature fail');
    expect(v.detail).not.toContain('(leg ');
  });
});

describe('classifyTestFileRun', () => {
  const r = (over: Partial<ExecResult>): ExecResult => ({ exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1, ...over });
  it('requires measured failure evidence; route errors, matched=0, timeouts and signals are unmeasured', () => {
    expect(classifyTestFileRun(r({})).status).toBe('pass');
    expect(classifyTestFileRun(r({ exitCode: 1, output: 'Tests 1 failed (1)' })).status).toBe('fail');
    expect(classifyTestFileRun(r({ exitCode: 1, output: 'native copy EACCES' })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: 0, output: 'TEST_FILE_ROUTE_ERROR path=x' })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: 0, output: 'router matched=0 files' })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: 1, timedOut: true })).status).toBe('unmeasured');
    expect(classifyTestFileRun(r({ exitCode: null, signal: 'SIGKILL' })).status).toBe('unmeasured');
  });

  it('pins the local not-measured literals to the router exit-code contract', () => {
    expect(ROUTER_EXIT_NOT_MEASURED).toBe(TEST_FILE_EXIT_NOT_MEASURED);
    expect(ROUTER_EXIT_TEMPFAIL).toBe(TEST_FILE_EXIT_TEMPFAIL);
  });

  it('classifies every contract exit code by whether the router MEASURED it (WI-10003617)', () => {
    // Only a measured run may be pass or fail; everything else is unmeasured — never a red.
    for (const code of [TEST_FILE_EXIT_PASSED, TEST_FILE_EXIT_FAILED, TEST_FILE_EXIT_NOT_MEASURED, TEST_FILE_EXIT_TEMPFAIL] as number[]) {
      const status = classifyTestFileRun(r({ exitCode: code, output: 'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed' })).status;
      if (testFileRunWasMeasured(code)) expect(status, `exit ${code}`).not.toBe('unmeasured');
      else expect(status, `exit ${code}`).toBe('unmeasured');
    }
  });

  it('an all-skipped file (router exit 2) is unmeasured, so it cannot refuse an admission as imports-red', () => {
    const allSkipped = r({
      exitCode: TEST_FILE_EXIT_NOT_MEASURED,
      output:
        'TEST_FILE_ALL_SKIPPED requested=1 executed=1 matched=1 testsExecuted=0 status=not-measured reason=every-collected-test-was-skipped',
    });
    const c = classifyTestFileRun(allSkipped);
    expect(c.status).toBe('unmeasured');
    expect(c.detail).toContain('reason=every-collected-test-was-skipped');

    const pop = precheckPopulation({ signature: [sig('lint', 'lint-leg')], admittedPaths: ['pkg/skipped.test.ts'] });
    const v = evaluateFixPrecheck(pop, ran([['pkg/skipped.test.ts', c.status]]));
    expect(v).toMatchObject({ ok: false, code: 'admission-precheck-unavailable', importedRed: [] });
    expect(v.ran && v.unmeasured).toEqual(['pkg/skipped.test.ts']);
  });
});

describe('createCheckpointTreeFixPrecheckRunner', () => {
  // WI-6554700010018823: a runner built without `logDir` defaults to
  // papercuspPath('checkpoint-logs'), i.e. the REAL gate log directory. Without
  // this pin every run of this file dropped admission-precheck-eeeeeeeeeeee-*.log
  // fixtures beside the gate's own run logs (84 found there on 2026-10-21).
  // Pinning PAPERCUSP_HOME per test covers every runner in this block,
  // including ones added later without a logDir.
  let fixtureHome = '';
  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), 'precheck-papercusp-home-'));
    vi.stubEnv('PAPERCUSP_HOME', fixtureHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  it('advances the heartbeat on setup output before setup finishes or any file is measured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'precheck-setup-progress-'));
    const releaseFile = join(dir, 'release');
    const snapshots: FixPrecheckProgress[] = [];
    let setupFinished = false;
    let setupOutput = '';
    let filesMeasured = 0;
    let sawOutput!: () => void;
    const firstOutput = new Promise<void>((resolve) => { sawOutput = resolve; });
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      if (!argv.includes('--exec-under-lock')) {
        filesMeasured += 1;
        return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
      }
      const result = await defaultExec([
        process.execPath, '-e',
        "const fs = require('node:fs'); console.log('materializing dependencies'); " +
          "console.error('setup stderr progress'); " +
          "const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); } }, 10);",
        releaseFile,
      ], { ...opts, cwd: process.cwd(), timeoutMs: 5_000, onOutput: () => {
        opts.onOutput?.();
        sawOutput();
      } });
      setupFinished = true;
      setupOutput = result.output;
      return result;
    };
    const runner = createCheckpointTreeFixPrecheckRunner({
      integrationRoot: process.cwd(), checkpointRoot: join(dir, 'checkpoint'),
      exec, logDir: dir, runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const startedAt = Date.now();
    const pending = runner({ commit: C, files: ['lib/red.test.ts'], onProgress: (p) => { snapshots.push(p); } });
    try {
      // Observe the real child output before asserting its heartbeat. Its existing
      // process deadline bounds startup; a separate 2s startup race proved nothing
      // about whether output was forwarded while setup remained running.
      await Promise.race([firstOutput, pending.then(() => {
        throw new Error(`setup ended before producing output: ${setupOutput}`);
      })]);
      await vi.waitFor(() => {
        expect(snapshots.some((p) => p.heartbeatAtMs > startedAt)).toBe(true);
      }, { timeout: 2_000 });
      expect(setupFinished).toBe(false);
      expect(filesMeasured).toBe(0);
      expect(snapshots.at(-1)).toMatchObject({ currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 1 });
    } finally {
      writeFileSync(releaseFile, 'release setup');
      const result = await pending;
      rmSync(dir, { recursive: true, force: true });
      expect(result).toMatchObject({ ran: true, results: [{ status: 'pass' }] });
      expect(setupOutput).toContain('materializing dependencies');
      expect(setupOutput).toContain('setup stderr progress');
    }
  });

  it('bounds output heartbeats, coalesces slow writes and drains setup progress before file progress', async () => {
    let now = 100_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const snapshots: FixPrecheckProgress[] = [];
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let setupOutputFinished!: () => void;
    const outputFinished = new Promise<void>((resolve) => { setupOutputFinished = resolve; });
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      if (argv.includes('--exec-under-lock')) {
        opts.onOutput?.();
        for (let i = 0; i < 100; i += 1) {
          now += 1;
          opts.onOutput?.();
        }
        now += ADMISSION_PRECHECK_HEARTBEAT_INTERVAL_MS;
        opts.onOutput?.();
        now += ADMISSION_PRECHECK_HEARTBEAT_INTERVAL_MS;
        opts.onOutput?.();
        setupOutputFinished();
      } else {
        // The latest setup snapshot must already be persisted before this phase starts.
        expect(snapshots.map((p) => p.heartbeatAtMs)).toEqual([100_000, now, now]);
        now += 1;
        opts.onOutput?.();
      }
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
    };
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const pending = runner({ commit: C, files: ['lib/red.test.ts'], onProgress: async (p) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      snapshots.push(p);
      if (snapshots.length === 1) await writeBlocked;
      activeWrites -= 1;
    } });
    try {
      await outputFinished;
      expect(snapshots).toHaveLength(1);
    } finally {
      releaseWrite();
      try {
        expect(await pending).toMatchObject({ ran: true, results: [{ status: 'pass' }] });
        expect(snapshots).toHaveLength(4);
        expect(maxActiveWrites).toBe(1);
        expect(snapshots.every((p) => p.completedCount === 0 && p.totalCount === 1)).toBe(true);
      } finally {
        clock.mockRestore();
      }
    }
  });

  it('keeps the measured verdict when setup output progress cannot be persisted', async () => {
    const logs: string[] = [];
    const exec = async (_argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      opts.onOutput?.();
      return { exitCode: 0, signal: null, timedOut: false, output: 'progress', durationMs: 1 };
    };
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, log: (line) => logs.push(line), runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const result = await runner({ commit: C, files: ['lib/red.test.ts'], onProgress: async () => { throw new Error('queue unavailable'); } });
    expect(result).toMatchObject({ ran: true, results: [{ status: 'pass' }] });
    expect(logs.filter((line) => line.includes('queue unavailable'))).toHaveLength(3);
  });

  // resolveGenerationRoot: () => null pins the default-path tests to the
  // beside-checkpoint placement whatever PAPERCUSP_DEPENDENCY_GENERATION_ROOT says.
  const base = { integrationRoot: '/repo', checkpointRoot: '/ckpt', resolveGenerationRoot: () => null };

  it('WI-6554700010018823: without logDir the precheck log lands under PAPERCUSP_HOME, not a fixed operator home', async () => {
    const exec = vi.fn(async (_argv: readonly string[], _opts: ExecOptions) => ({ exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult));
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/a.test.ts'] });
    const logFiles = exec.mock.calls.map(([, opts]) => opts.logFile);
    expect(logFiles.length).toBeGreaterThan(0);
    for (const logFile of logFiles) {
      expect(logFile?.startsWith(`${join(fixtureHome, 'checkpoint-logs')}/admission-precheck-${C.slice(0, 12)}-`)).toBe(true);
    }
  });

  it('a registered npm pretest failure remains unavailable and never becomes an assertion red', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-pretest-error-'));
    const checkpointRoot = join(root, 'checkpoint');
    const precheckRoot = `${checkpointRoot}-admission-precheck`;
    const fixturePackage = {
      name: 'pretest-error-fixture', version: '1.0.0', private: true,
      scripts: {
        pretest: 'node -e "throw new Error(\'native copy EACCES\')"',
        test: 'node -e "console.log(\'ASSERTIONS_STARTED\')"',
      },
    };
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      if (argv.includes('/operator/apps/operator/bin/release/setup-release-checkout.sh')) {
        mkdirSync(precheckRoot);
        writeFileSync(join(precheckRoot, 'package.json'), JSON.stringify(fixturePackage));
        return { exitCode: 0, signal: null, timedOut: false, output: 'fixture prepared', durationMs: 1 };
      }
      const result = await defaultExec(argv, opts);
      expect(result.output).toContain('native copy EACCES');
      expect(result.output).not.toContain('ASSERTIONS_STARTED');
      return result;
    };
    try {
      const runner = createCheckpointTreeFixPrecheckRunner({
        ...base, integrationRoot: '/app', toolingRoot: '/operator', checkpointRoot,
        testCommand: ['npm', 'test'], exec, runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      const result = await runner({ commit: C, files: ['lib/red.test.ts'] });
      expect(result).toMatchObject({ ran: true, results: [{ status: 'unmeasured', exitCode: 1 }] });
      const population = precheckPopulation({ signature: [sig('lib/red.test.ts')], admittedPaths: [] });
      expect(evaluateFixPrecheck(population, result)).toMatchObject({
        ok: false, code: 'admission-precheck-unavailable', failing: [], importedRed: [],
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runs a frozen exact-file script in test mode without changing its production caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-affected-file-'));
    const checkpointRoot = join(root, 'checkpoint');
    const precheckRoot = `${checkpointRoot}-admission-precheck`;
    const commands: string[][] = [];
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prepareTestEnvironment = vi.fn(async () => ({ PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private@localhost:12345/postgres' }));
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      commands.push([...argv]);
      if (argv.includes('/operator/apps/operator/bin/release/setup-release-checkout.sh')) {
        mkdirSync(precheckRoot);
        writeFileSync(join(precheckRoot, 'package.json'), JSON.stringify({
          private: true,
          scripts: {
            'test:affected': 'node -e "throw new Error(\'unexpected positional filename\')"',
            'test:file': 'node -e "const a=require(\'node:assert/strict\'); a.deepEqual(process.argv.slice(1), [\'tests/host.test.ts\']); a.equal(process.env.NODE_ENV, \'test\'); console.log(\'Tests 1 passed (1)\')"',
          },
        }));
        return { exitCode: 0, signal: null, timedOut: false, output: 'fixture prepared', durationMs: 1 };
      }
      expect(opts.env?.PAPERCUSP_TEST_PG_ADMIN_URL).toBe('postgres://private@localhost:12345/postgres');
      expect(opts.env?.NODE_ENV).toBe('test');
      return defaultExec(argv, opts);
    };
    try {
      const runner = createCheckpointTreeFixPrecheckRunner({
        ...base, integrationRoot: '/app', toolingRoot: '/operator', checkpointRoot,
        testCommand: ['npm', 'run', 'test:affected'], exec,
        prepareTestEnvironment,
        runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      expect(await runner({ commit: C, files: ['tests/host.test.ts'] })).toMatchObject({
        ran: true, results: [{ path: 'tests/host.test.ts', status: 'pass' }],
      });
      expect(commands.at(-1)).toEqual(['npm', 'run', 'test:file', '--', 'tests/host.test.ts']);
      expect(prepareTestEnvironment).toHaveBeenCalledWith(precheckRoot, expect.any(Function));
      expect(process.env.NODE_ENV).toBe('production');
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses an affected suite with no registered exact-file script', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-missing-file-script-'));
    const checkpointRoot = join(root, 'checkpoint');
    const precheckRoot = `${checkpointRoot}-admission-precheck`;
    const exec = vi.fn(async (): Promise<ExecResult> => {
      mkdirSync(precheckRoot);
      writeFileSync(join(precheckRoot, 'package.json'), JSON.stringify({
        scripts: { 'test:affected': 'node affected-tests.mjs' },
      }));
      return { exitCode: 0, signal: null, timedOut: false, output: 'fixture prepared', durationMs: 1 };
    });
    try {
      const runner = createCheckpointTreeFixPrecheckRunner({
        ...base, integrationRoot: '/app', toolingRoot: '/operator', checkpointRoot,
        testCommand: ['npm', 'run', 'test:affected'], exec,
        runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      expect(await runner({ commit: C, files: ['tests/host.test.ts'] })).toMatchObject({
        ran: false, reason: 'runner-failed', detail: expect.stringContaining('no registered test:file command'),
      });
      expect(exec).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('materializes a foreign app with operator tooling and runs its registered suite in the pinned app checkout', async () => {
    const exec = vi.fn(async (_argv: readonly string[], _opts: ExecOptions) => ({ exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult));
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, integrationRoot: '/app', toolingRoot: '/operator',
      testCommand: ['npm', 'test'], clearEnv: ['DATABASE_URL'], exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['tests/host.test.ts'] });
    expect(out).toMatchObject({ ran: true, commit: C, results: [{ path: 'tests/host.test.ts', status: 'pass' }] });
    expect(exec.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      '/operator/scripts/npm-install-safe.mjs', '--repo-root', '/app',
      '/operator/apps/operator/bin/release/setup-release-checkout.sh', '--integration', '/app', '--ref', C,
    ]));
    expect(exec.mock.calls[1]).toEqual([['npm', 'test', '--', 'tests/host.test.ts'], expect.objectContaining({ cwd: '/ckpt-admission-precheck' })]);
    for (const [, options] of exec.mock.calls) {
      expect(options.env).toHaveProperty('DATABASE_URL', undefined);
    }
  });

  it('uses the native file router when distinct tooling and integration paths share a real Git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admission-same-repo-'));
    const toolingRoot = join(root, 'served-build');
    mkdirSync(toolingRoot);
    execFileSync('git', ['init', '--quiet', root]);
    const exec = vi.fn(async (_argv: readonly string[], _opts: ExecOptions) => ({ exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult));
    try {
      expect(await resolveCanonicalIntegrationRoot(toolingRoot)).toBe(root);
      const runner = createCheckpointTreeFixPrecheckRunner({
        ...base, integrationRoot: root, toolingRoot, exec,
        runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      expect(await runner({ commit: C, files: ['lib/red.test.ts'] })).toMatchObject({
        ran: true, results: [{ path: 'lib/red.test.ts', status: 'pass' }],
      });
      expect(exec.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
        join(toolingRoot, 'apps/operator/bin/release/setup-release-checkout.sh'),
        '--integration', root,
      ]));
      expect(exec.mock.calls[1]?.[0]).toEqual(['node', 'scripts/test-files.mjs', 'lib/red.test.ts']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a foreign app without a real registered test command before materialization', async () => {
    const exec = vi.fn();
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, integrationRoot: '/app', toolingRoot: '/operator', exec });
    expect(await runner({ commit: C, files: ['tests/host.test.ts'] })).toMatchObject({ ran: false, reason: 'runner-failed' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports checkpoint-tree-busy without touching the tree when a gate run holds the run-lock', async () => {
    const exec = vi.fn();
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: true, pid: 42, elapsedSec: 120 }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(out).toMatchObject({ ran: false, reason: 'checkpoint-tree-busy', holder: { pid: 42, elapsedSec: 120 } });
    expect(exec).not.toHaveBeenCalled();
  });

  it('holds the source install reader during snapshot setup, then runs tests outside that lease in the dedicated checkout', async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const events: string[] = [];
    const progress: Array<{
      currentFile: string;
      completedCount: number;
      totalCount: number;
      heartbeatAtMs: number;
    }> = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string }) => {
      calls.push({ argv, cwd: opts.cwd });
      if (argv[1] === '/repo/scripts/npm-install-safe.mjs') {
        events.push('setup');
        return { exitCode: 0, signal: null, timedOut: false, output: 'ok', durationMs: 5 } as ExecResult;
      }
      const file = argv[2];
      events.push(`test:${file}`);
      return { exitCode: file === 'lib/red.test.ts' ? 0 : 1, signal: null, timedOut: false, output: 'Tests 1 failed (1)', durationMs: 3 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({
      commit: C,
      files: ['lib/red.test.ts', 'lib/new.test.ts'],
      onProgress: (snapshot) => {
        progress.push(snapshot);
        events.push(`progress:${snapshot.currentFile}`);
      },
    });
    expect(out).toMatchObject({ ran: true, commit: C, results: [{ path: 'lib/red.test.ts', status: 'pass' }, { path: 'lib/new.test.ts', status: 'fail' }] });
    expect(progress).toEqual([
      { currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 2, heartbeatAtMs: expect.any(Number) },
      { currentFile: 'lib/new.test.ts', completedCount: 1, totalCount: 2, heartbeatAtMs: expect.any(Number) },
    ]);
    expect(events).toEqual([
      'setup',
      'progress:lib/red.test.ts',
      'test:lib/red.test.ts',
      'progress:lib/new.test.ts',
      'test:lib/new.test.ts',
    ]);
    expect(calls[0].argv.slice(0, 8)).toEqual([
      process.execPath, '/repo/scripts/npm-install-safe.mjs', '--repo-root', '/repo',
      '--exec-under-lock', '--', 'bash', '/repo/apps/operator/bin/release/setup-release-checkout.sh',
    ]);
    expect(calls[0].argv).toEqual(expect.arrayContaining(['--ref', C, '--integration', '/repo', '--release', '/ckpt-admission-precheck']));
    expect(calls[0].cwd).toBe('/repo');
    expect(calls[1]).toEqual({ argv: ['node', 'scripts/test-files.mjs', 'lib/red.test.ts'], cwd: '/ckpt-admission-precheck' });
    expect(calls[2].argv[2]).toBe('lib/new.test.ts');
  });

  it('materializes the pre-check tree object-sourced, never splicing the live working tree (WI-6554700010030437)', async () => {
    // Measured 2026-10-27 (pre-check ee001775): without this flag an unreadable pinned
    // submodule commit was rsync'd from the integration tree's working directory, so the
    // pre-check judged a tree that matched no commit and reported 42 files `unmeasured`.
    const setupArgvs: Array<readonly string[]> = [];
    const exec = vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === '/repo/scripts/npm-install-safe.mjs') setupArgvs.push(argv);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(setupArgvs).toHaveLength(1);
    const argv = setupArgvs[0];
    const at = argv.indexOf('--source-integrity');
    expect(at).toBeGreaterThan(argv.indexOf('/repo/apps/operator/bin/release/setup-release-checkout.sh'));
    expect(argv[at + 1]).toBe('object-sourced');
  });

  it('materializes the pre-check node_modules by hardlink from the immutable generation (WI-10004928)', async () => {
    const setupEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const testEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      (argv[1] === '/repo/scripts/npm-install-safe.mjs' ? setupEnvs : testEnvs).push(opts.env);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(admissionPrecheckSetupEnv()).toEqual({ DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' });
    expect(setupEnvs).toEqual([{ DEPENDENCY_GENERATION_ALLOW_HARDLINK: '1' }]);
    // The opt-in is for materialization only. The test processes never see it.
    expect(testEnvs[0]?.DEPENDENCY_GENERATION_ALLOW_HARDLINK).toBeUndefined();
  });

  it('attributes a real test child to its explicit harness rather than an inherited harness', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'admission-harness-'));
    const inherited = process.env.PAPERCUSP_TEST_RUN_HARNESS;
    process.env.PAPERCUSP_TEST_RUN_HARNESS = 'foreign-harness';
    let childOutput = '';
    const exec = async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      if (argv.includes('--exec-under-lock')) {
        return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
      }
      const result = await defaultExec([
        process.execPath, '-e',
        'console.log(JSON.stringify({harness:process.env.PAPERCUSP_TEST_RUN_HARNESS,group:process.env.PAPERCUSP_TEST_RUN_GROUP}))',
      ], { ...opts, cwd: process.cwd(), timeoutMs: 5_000 });
      childOutput = result.output;
      return result;
    };
    try {
      const runner = createCheckpointTreeFixPrecheckRunner({
        ...base, exec, logDir, testRunHarness: 'oddsmith',
        runLockHeld: () => ({ held: false, elapsedSec: null }),
      });
      expect(await runner({ commit: C, files: ['lib/red.test.ts'] })).toMatchObject({
        ran: true, results: [{ status: 'pass' }],
      });
      expect(JSON.parse(childOutput.trim())).toEqual({
        harness: 'oddsmith', group: `admission-precheck:${C.slice(0, 12)}`,
      });
    } finally {
      if (inherited === undefined) delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
      else process.env.PAPERCUSP_TEST_RUN_HARNESS = inherited;
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  it('cannot measure a gate-repinned checkout as an admission failure', async () => {
    let gateCheckoutHead = 'old-gate-head';
    const measuredRoots: string[] = [];
    const exec = vi.fn(async (argv: readonly string[], opts: { cwd: string }) => {
      if (argv[1] === '/repo/scripts/npm-install-safe.mjs') {
        expect(argv).toEqual(expect.arrayContaining(['--release', '/ckpt-admission-precheck']));
      } else {
        const racedOntoOldGateTree = gateCheckoutHead === 'new-gate-head' && opts.cwd === base.checkpointRoot;
        measuredRoots.push(opts.cwd);
        if (measuredRoots.length === 1) gateCheckoutHead = 'new-gate-head';
        return {
          exitCode: racedOntoOldGateTree ? 1 : 0,
          signal: null,
          timedOut: false,
          output: racedOntoOldGateTree ? 'No getDatatype export is defined on the old mock' : '',
          durationMs: 5,
        } as ExecResult;
      }
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 5 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/first.test.ts', 'lib/second.test.ts'] });
    expect(gateCheckoutHead).toBe('new-gate-head');
    expect(measuredRoots).toEqual(['/ckpt-admission-precheck', '/ckpt-admission-precheck']);
    expect(out).toMatchObject({ ran: true, results: [{ status: 'pass' }, { status: 'pass' }] });
  });

  it('refuses to reset an existing directory that is not its own admission worktree', async () => {
    const checkpointRoot = mkdtempSync(join(tmpdir(), 'admission-checkout-'));
    const unrelated = `${checkpointRoot}-admission-precheck`;
    mkdirSync(unrelated);
    try {
      const exec = vi.fn();
      const runner = createCheckpointTreeFixPrecheckRunner({
        integrationRoot: '/repo', checkpointRoot, exec,
        runLockHeld: () => ({ held: false, elapsedSec: null }),
        resolveGenerationRoot: () => null,
      });
      const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
      expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
      rmSync(checkpointRoot, { recursive: true, force: true });
    }
  });

  it('materializes into an explicit precheckRoot and names the placement in its log (WI-10006789)', async () => {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const logs: string[] = [];
    const exec = vi.fn(async (argv: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
      calls.push({ argv, cwd: opts.cwd });
      const setup = argv[1] === '/repo/scripts/npm-install-safe.mjs';
      return { exitCode: setup ? 0 : 1, signal: null, output: setup ? 'ok' : ' FAIL  lib/red.test.ts > x\nTests 1 failed (1)', timedOut: false, durationMs: 1 };
    });
    const runner = createCheckpointTreeFixPrecheckRunner({
      ...base, exec, precheckRoot: '/fast/papercusp-precheck', log: (line) => logs.push(line),
      runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(calls[0].argv).toEqual(expect.arrayContaining(['--release', '/fast/papercusp-precheck']));
    expect(calls[1].cwd).toBe('/fast/papercusp-precheck');
    expect(logs).toContain('[admission-precheck] tree /fast/papercusp-precheck (explicit: caller-provided pre-check root)');
  });

  it('isolates progress persistence failures from the measured file verdict', async () => {
    const logs: string[] = [];
    const exec = vi.fn(async (argv: readonly string[]) =>
      ({ exitCode: 0, signal: null, timedOut: false, output: argv[1] === '/repo/scripts/npm-install-safe.mjs' ? 'ok' : '', durationMs: 5 }) as ExecResult,
    );
    const runner = createCheckpointTreeFixPrecheckRunner({
      ...base,
      exec,
      log: (line) => logs.push(line),
      runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const out = await runner({
      commit: C,
      files: ['lib/red.test.ts'],
      onProgress: () => {
        throw new Error('queue unavailable');
      },
    });
    expect(out).toMatchObject({ ran: true, results: [{ path: 'lib/red.test.ts', status: 'pass' }] });
    expect(logs).toContain('[admission-precheck] progress callback failed for lib/red.test.ts: queue unavailable');
  });

  it('a failed setup is runner-failed (never a verdict on the files)', async () => {
    const exec = vi.fn(async () => ({ exitCode: 1, signal: null, timedOut: false, output: 'boom', durationMs: 5 }) as ExecResult);
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // WI-10006014: the setup died on a 20-min WALL-CLOCK budget while still progressing, and the
  // failure left nothing on disk to attribute it with.
  it('gives setup an idle watchdog + the shared ceiling, logs durably, and names a stall and the log in the detail', async () => {
    const seen: ExecOptions[] = [];
    const exec = vi.fn(async (_argv: readonly string[], opts: ExecOptions) => {
      seen.push(opts);
      return { exitCode: null, signal: 'SIGTERM', timedOut: true, idleTimedOut: true, output: 'last-setup-line', durationMs: 5 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({
      ...base,
      exec,
      logDir: '/var/log/precheck',
      runLockHeld: () => ({ held: false, elapsedSec: null }),
    });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect(seen[0]).toMatchObject({
      timeoutMs: ADMISSION_PRECHECK_SETUP_BUDGET_MS,
      idleTimeoutMs: ADMISSION_PRECHECK_SETUP_IDLE_MS,
    });
    expect(seen[0].logFile).toMatch(new RegExp(`^/var/log/precheck/admission-precheck-${C.slice(0, 12)}-.*\\.log$`));
    expect(ADMISSION_PRECHECK_SETUP_IDLE_MS).toBeLessThan(ADMISSION_PRECHECK_SETUP_BUDGET_MS);
    expect(out).toMatchObject({ ran: false, reason: 'runner-failed' });
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain('(stalled: no output for 15 min)');
    expect(detail).toContain(`log=${seen[0].logFile}`);
    expect(detail).toContain('last-setup-line');
  });

  it('a wall-clock ceiling hit is reported as such, distinct from a stall', async () => {
    const exec = vi.fn(async () => ({ exitCode: null, signal: 'SIGTERM', timedOut: true, output: 'x', durationMs: 2_400_000 }) as ExecResult);
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, logDir: '/tmp/l', runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, files: ['lib/red.test.ts'] });
    expect((out as { detail: string }).detail).toMatch(/\(timed out at the 40-min ceiling after 2400s\)/);
  });

  it('every per-file run appends to the same durable log as setup', async () => {
    const logFiles: Array<string | undefined> = [];
    const exec = vi.fn(async (_argv: readonly string[], opts: ExecOptions) => {
      logFiles.push(opts.logFile);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 } as ExecResult;
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, logDir: '/tmp/l', runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await runner({ commit: C, files: ['lib/a.test.ts', 'lib/b.test.ts'] });
    expect(logFiles).toHaveLength(3);
    expect(new Set(logFiles).size).toBe(1);
    expect(logFiles[0]).toMatch(/^\/tmp\/l\/admission-precheck-/);
  });

  it('persists each native file result before starting the next file and preserves its failure', async () => {
    const events: string[] = [];
    const tree = 'd'.repeat(40);
    const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
      if (argv[0] === 'git') return { exitCode: 0, signal: null, timedOut: false, output: tree, durationMs: 1 };
      if (argv[1] === 'scripts/test-files.mjs') {
        events.push(`run:${argv[2]}`);
        return { exitCode: 1, signal: null, timedOut: false, output: 'Tests 1 failed (1)', durationMs: 3 };
      }
      return { exitCode: 0, signal: null, timedOut: false, output: 'setup ok', durationMs: 1 };
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, logDir: '/tmp/l', runLockHeld: () => ({ held: false, elapsedSec: null }) });
    const out = await runner({ commit: C, expectedTree: tree, files: ['lib/a.test.ts', 'lib/b.test.ts'],
      onFileResult: async result => {
        expect(result.status).toBe('fail');
        expect(result.exitCode).toBe(1);
        await Promise.resolve();
        events.push(`persist:${result.path}`);
      } });
    expect(events).toEqual(['run:lib/a.test.ts', 'persist:lib/a.test.ts', 'run:lib/b.test.ts', 'persist:lib/b.test.ts']);
    expect(out).toMatchObject({ ran: true, results: [{ path: 'lib/a.test.ts', status: 'fail' }, { path: 'lib/b.test.ts', status: 'fail' }] });
  });

  it('a fixture lost during execution cannot persist a passing result or start the next file', async () => {
    const files: string[] = [];
    const recorded = vi.fn();
    let healthy = true;
    const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
      if (argv[1] === 'scripts/test-files.mjs') {
        files.push(argv[2]!);
        healthy = false;
      }
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec,
      assertTestEnvironment: () => { if (!healthy) throw new Error('private fixture lost'); },
      runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await expect(runner({ commit: C, files: ['lib/a.test.ts', 'lib/b.test.ts'], onFileResult: recorded }))
      .rejects.toThrow('private fixture lost');
    expect(files).toEqual(['lib/a.test.ts']);
    expect(recorded).not.toHaveBeenCalled();
  });

  it('a durable file-result write failure stops execution before the next file', async () => {
    const files: string[] = [];
    const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
      if (argv[1] === 'scripts/test-files.mjs') files.push(argv[2]!);
      return { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
    });
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    await expect(runner({ commit: C, files: ['lib/a.test.ts', 'lib/b.test.ts'], onFileResult: () => { throw new Error('durable write failed'); } }))
      .rejects.toThrow('durable write failed');
    expect(files).toEqual(['lib/a.test.ts']);
  });

  it('refuses a materialized tree mismatch before executing any test file', async () => {
    const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => ({ exitCode: 0, signal: null, timedOut: false,
      output: argv[0] === 'git' ? 'e'.repeat(40) : 'setup ok', durationMs: 1 }));
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: () => ({ held: false, elapsedSec: null }) });
    expect(await runner({ commit: C, expectedTree: 'd'.repeat(40), files: ['lib/a.test.ts'] }))
      .toMatchObject({ ran: false, reason: 'runner-failed', detail: expect.stringContaining('materialized tree differs') });
    expect(exec.mock.calls.some(([argv]) => argv[1] === 'scripts/test-files.mjs')).toBe(false);
  });

  it('refuses an execution group above the unchanged 200-file cap before setup', async () => {
    const exec = vi.fn();
    const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec });
    expect(await runner({ commit: C, files: Array.from({ length: 201 }, (_, i) => `lib/${i}.test.ts`) }))
      .toMatchObject({ ran: false, reason: 'runner-failed', detail: expect.stringContaining('200-file bound') });
    expect(exec).not.toHaveBeenCalled();
  });

  describe('WI-6554700010030140: bounded file concurrency', () => {
    const ok: ExecResult = { exitCode: 0, signal: null, timedOut: false, output: '', durationMs: 1 };
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      return { opened, open };
    };
    const idle = () => ({ held: false, elapsedSec: null });

    it('runs at most fileConcurrency files at once, serializes every queue write and returns results in input order', async () => {
      const files = Array.from({ length: 7 }, (_, i) => `lib/f${i}.test.ts`);
      const gates = new Map(files.map((f) => [f, gate()]));
      const started: string[] = [];
      let active = 0;
      let maxActive = 0;
      const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
        if (argv[1] !== 'scripts/test-files.mjs') return ok;
        const file = argv[2]!;
        started.push(file);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gates.get(file)!.opened;
        active -= 1;
        return file === 'lib/f3.test.ts' ? { ...ok, exitCode: 1, output: 'Tests 1 failed (1)' } : ok;
      });
      let activeWrites = 0;
      let maxActiveWrites = 0;
      const write = async () => {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Promise.resolve();
        await Promise.resolve();
        activeWrites -= 1;
      };
      const recorded: string[] = [];
      const snapshots: FixPrecheckProgress[] = [];
      const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, fileConcurrency: 3, runLockHeld: idle });
      const pending = runner({
        commit: C, files,
        onFileResult: async (r) => { await write(); recorded.push(r.path); },
        onProgress: async (p) => { await write(); snapshots.push(p); },
      });
      await vi.waitFor(() => expect(started).toEqual(files.slice(0, 3)));
      // Finish the THIRD file first: its slot is refilled before the first two complete.
      gates.get('lib/f2.test.ts')!.open();
      await vi.waitFor(() => expect(started).toHaveLength(4));
      for (const f of [...files].reverse()) gates.get(f)!.open();
      const out = await pending;

      expect(maxActive).toBe(3);
      expect(maxActiveWrites).toBe(1);
      expect(recorded[0]).toBe('lib/f2.test.ts');
      expect([...recorded].sort()).toEqual([...files].sort());
      expect(out.ran && out.results.map((r) => r.path)).toEqual(files);
      expect(out.ran && out.results.find((r) => r.path === 'lib/f3.test.ts')?.status).toBe('fail');
      // A snapshot is built when written: completedCount never goes backwards and never
      // claims a file whose result was not yet durably recorded.
      const counts = snapshots.map((s) => s.completedCount);
      expect(counts).toEqual([...counts].sort((a, b) => a - b));
      expect(Math.max(...counts)).toBeLessThan(files.length);
    });

    it('after a failure no new file starts, and the error surfaces only after running siblings finish', async () => {
      const files = ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts', 'lib/d.test.ts'];
      const gates = new Map(files.map((f) => [f, gate()]));
      const started: string[] = [];
      let healthy = true;
      const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
        if (argv[1] !== 'scripts/test-files.mjs') return ok;
        const file = argv[2]!;
        started.push(file);
        await gates.get(file)!.opened;
        if (file === 'lib/a.test.ts') healthy = false;
        return ok;
      });
      const recorded = vi.fn();
      const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, fileConcurrency: 2, runLockHeld: idle,
        assertTestEnvironment: () => { if (!healthy) throw new Error('private fixture lost'); } });
      let settled = false;
      const pending = runner({ commit: C, files, onFileResult: recorded });
      void pending.then(() => { settled = true; }, () => { settled = true; });
      await vi.waitFor(() => expect(started).toEqual(['lib/a.test.ts', 'lib/b.test.ts']));
      gates.get('lib/a.test.ts')!.open();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(started).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
      gates.get('lib/b.test.ts')!.open();
      await expect(pending).rejects.toThrow('private fixture lost');
      expect(started).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
      expect(recorded).not.toHaveBeenCalled();
    });

    it('defaults to strictly serial when fileConcurrency is unset', async () => {
      let active = 0;
      let maxActive = 0;
      const exec = vi.fn(async (argv: readonly string[]): Promise<ExecResult> => {
        if (argv[1] !== 'scripts/test-files.mjs') return ok;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return ok;
      });
      const runner = createCheckpointTreeFixPrecheckRunner({ ...base, exec, runLockHeld: idle });
      expect(await runner({ commit: C, files: ['lib/a.test.ts', 'lib/b.test.ts', 'lib/c.test.ts'] })).toMatchObject({ ran: true });
      expect(maxActive).toBe(1);
    });

    it('reads the operator override within bounds and rejects anything else', () => {
      expect(ADMISSION_PRECHECK_FILE_CONCURRENCY).toBeGreaterThan(1);
      expect(admissionPrecheckFileConcurrency({})).toBe(ADMISSION_PRECHECK_FILE_CONCURRENCY);
      expect(admissionPrecheckFileConcurrency({ PAPERCUSP_ADMISSION_PRECHECK_FILE_CONCURRENCY: '1' })).toBe(1);
      expect(admissionPrecheckFileConcurrency({ PAPERCUSP_ADMISSION_PRECHECK_FILE_CONCURRENCY: ' 6 ' })).toBe(6);
      expect(admissionPrecheckFileConcurrency({ PAPERCUSP_ADMISSION_PRECHECK_FILE_CONCURRENCY: '999' }))
        .toBe(ADMISSION_PRECHECK_FILE_CONCURRENCY_MAX);
      for (const bad of ['0', '-2', '2.5', 'many', ''])
        expect(admissionPrecheckFileConcurrency({ PAPERCUSP_ADMISSION_PRECHECK_FILE_CONCURRENCY: bad })).toBe(ADMISSION_PRECHECK_FILE_CONCURRENCY);
    });
  });
});

describe('resolveCanonicalIntegrationRoot (P-006 / R6)', () => {
  it('reads the common Git directory asynchronously and returns null when Git cannot classify a root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admission-common-dir-'));
    try {
      execFileSync('git', ['init', '--quiet', root]);
      await expect(defaultGitCommonDir(root)).resolves.toBe(join(root, '.git'));
      await expect(defaultGitCommonDir(join(root, 'missing'))).resolves.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a main worktree (its common dir is its own .git) resolves to itself', async () => {
    expect(await resolveCanonicalIntegrationRoot('/w/papercusp', () => '/w/papercusp/.git')).toBe('/w/papercusp');
  });

  it('a LINKED worktree (papercusp-staging on :3170) resolves to the main worktree that owns the object store', async () => {
    // Measured 2026-09-11: the door handed the runner the linked worktree, setup-release-checkout
    // refused it (`-d .git` is false for a gitdir FILE), and the admission published unmeasured.
    expect(await resolveCanonicalIntegrationRoot('/w/papercusp-staging', () => '/w/papercusp/.git')).toBe('/w/papercusp');
  });

  it('a relative common dir is resolved against the root', async () => {
    expect(await resolveCanonicalIntegrationRoot('/w/papercusp', () => '.git')).toBe('/w/papercusp');
  });

  it('a root git cannot classify is returned unchanged — the runner then fails loudly instead of guessing', async () => {
    expect(await resolveCanonicalIntegrationRoot('/not-a-repo', () => null)).toBe('/not-a-repo');
    expect(await resolveCanonicalIntegrationRoot('/bare.git', () => '/bare.git')).toBe('/bare.git');
  });
});

describe('dependencyGenerationInfraCode (WI-10004849)', () => {
  it('maps the typed copy refusals by exit code', () => {
    expect(dependencyGenerationInfraCode(76, '')).toBe('DEPENDENCY_GENERATION_LOCK_TIMEOUT');
    expect(dependencyGenerationInfraCode(77, '')).toBe('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  });

  it('recognizes the logged marker when a wrapper re-mapped the exit', () => {
    expect(
      dependencyGenerationInfraCode(
        1,
        '[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=0 avail=1',
      ),
    ).toBe('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT');
  });

  it('is null for an ordinary setup failure', () => {
    expect(dependencyGenerationInfraCode(1, 'npm ERR! missing script')).toBeNull();
    expect(dependencyGenerationInfraCode(null, '')).toBeNull();
  });
});

describe('deriveAdmissionPrecheckRoot (WI-10006789)', () => {
  // The measured host: checkout on / (ext4, dev 1), generation store on /mnt/data (xfs, dev 2).
  const devices: Record<string, number> = {
    '/': 1,
    '/home/u/ws': 1,
    '/mnt/data': 2,
    '/mnt/data/papercusp-dependency-generations': 2,
  };
  const probe = (writable: string[] = []): AdmissionPrecheckRootProbe => ({
    deviceOf: (p) => devices[p] ?? null,
    writableDir: (dir) => writable.includes(dir),
  });
  const checkpointRoot = '/home/u/ws/papercusp-checkpoint';
  const store = '/mnt/data/papercusp-dependency-generations';

  it('moves the tree into a reserved directory inside the store when the store is on another filesystem and its parent is not writable', () => {
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: store, probe: probe() })).toEqual({
      root: '/mnt/data/papercusp-dependency-generations/.worktrees/papercusp-checkpoint-admission-precheck',
      placement: 'inside-generation-store',
      reason: expect.stringContaining('could not be hardlinked'),
      displaced: '/home/u/ws/papercusp-checkpoint-admission-precheck',
    });
  });

  it('places the tree beside the store when the store parent is writable on the same filesystem', () => {
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: store, probe: probe(['/mnt/data']) })).toMatchObject({
      root: '/mnt/data/papercusp-checkpoint-admission-precheck',
      placement: 'beside-generation-store',
      displaced: '/home/u/ws/papercusp-checkpoint-admission-precheck',
    });
  });

  it('keeps the default location when the store shares its filesystem', () => {
    const local = '/home/u/ws/papercusp/.papercusp/dependency-generations';
    const sameDevice: AdmissionPrecheckRootProbe = { deviceOf: (p) => (p === local ? 1 : devices[p] ?? null), writableDir: () => true };
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: local, probe: sameDevice })).toEqual({
      root: '/home/u/ws/papercusp-checkpoint-admission-precheck',
      placement: 'beside-checkpoint',
      reason: expect.stringContaining('same filesystem'),
    });
  });

  it('keeps the default location when the store is unresolved or does not exist yet', () => {
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: null, probe: probe() }).placement).toBe('beside-checkpoint');
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: '/mnt/data/not-created-yet', probe: probe() })).toMatchObject({
      root: '/home/u/ws/papercusp-checkpoint-admission-precheck',
      placement: 'beside-checkpoint',
      reason: expect.stringContaining('does not exist'),
    });
  });

  it('compares the store against the nearest existing ancestor when the checkout parent does not exist yet', () => {
    const fresh = '/home/u/ws/not-yet/papercusp-checkpoint';
    expect(deriveAdmissionPrecheckRoot({ checkpointRoot: fresh, generationRoot: store, probe: probe() })).toMatchObject({
      placement: 'inside-generation-store',
      root: '/mnt/data/papercusp-dependency-generations/.worktrees/papercusp-checkpoint-admission-precheck',
    });
  });

  it('never names a path a generation glob (`v1-*`) or the default copy would collide with', () => {
    const { root } = deriveAdmissionPrecheckRoot({ checkpointRoot, generationRoot: store, probe: probe() });
    const entry = root.slice(store.length + 1).split('/')[0];
    expect(entry.startsWith('.')).toBe(true);
    expect(entry.startsWith('v1-')).toBe(false);
  });

  it('uses the real filesystem by default: a store in the same tmp tree keeps the default placement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'admission-root-'));
    try {
      const realStore = join(dir, 'generations');
      mkdirSync(realStore);
      expect(deriveAdmissionPrecheckRoot({ checkpointRoot: join(dir, 'checkpoint'), generationRoot: realStore })).toMatchObject({
        root: `${join(dir, 'checkpoint')}-admission-precheck`,
        placement: 'beside-checkpoint',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
