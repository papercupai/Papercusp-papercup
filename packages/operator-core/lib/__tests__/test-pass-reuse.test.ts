import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { classifyLanes, isUnitTestFile } from '@papercusp/test-config/lane-split';

// The subject module is overridable (TEST_PASS_REUSE_SUBJECT = an absolute path to a copy) so
// scripts/mutation-probe.sh can run this suite against a frozen historical or mutated snapshot
// without touching the shared tree (WI-10004712). Unset, it is the real module.
type ReuseSubject = typeof import('../../../../scripts/lib/test-pass-reuse.mjs');
const reuseSubjectOverride = process.env.TEST_PASS_REUSE_SUBJECT;
const reuseSubject: ReuseSubject = reuseSubjectOverride
  ? await import(pathToFileURL(reuseSubjectOverride).href)
  : await import('../../../../scripts/lib/test-pass-reuse.mjs');
const {
  auditDraw,
  estimateReuseSavings,
  EXECUTED_SOURCE_MAP_IMPORT_LIMIT,
  formatReuseAlarmLine,
  formatTestReuseLine,
  formatTestReuseTotalLine,
  gateReuseObservations,
  isGlobalRunnerInput,
  isRunnerAffectingScript,
  judgedTreeProofFormat,
  LEGACY_PROOF_SAFE_DRIFT_RE,
  RECORDER_PROOF_FORMAT_FILE,
  laneOfFromSplit,
  laneOfTaskScript,
  laneScopedCandidates,
  packageLockChangeIsInert,
  packageLockInstallView,
  REUSE_PROOF_FORMAT,
  REUSE_SKIP_LIST_SCHEMA,
  PC_TEST_PARTIAL_SKIP_LIST_ENV,
  reuseCandidates,
  reuseRunnerIdentity,
  reuseSoundnessAlarms,
  rootPackageJsonChangeIsInert,
  scriptInvocationJudge,
  scriptsOnlyChangedNames,
  selectReusablePasses,
  testReuseAuditRate,
  testReuseEnabled,
  TEST_REUSE_AUDIT_RATE_DEFAULT,
  tsconfigUnreadByToolchain,
  workspacePackageJsonChangeIsInert,
  writeReuseSkipList,
} = reuseSubject;
import {
  decideReuseSkip,
  executedSourceRunnerIdentity,
  parseReuseSkipList,
  PC_TEST_PARTIAL_SKIP_LIST_ENV as READER_PARTIAL_SKIP_LIST_ENV,
  REUSE_PROOF_FORMAT as RECORDER_PROOF_FORMAT,
  REUSE_SKIP_LIST_SCHEMA as READER_SCHEMA,
} from '@papercusp/test-config/test-pass-reuse-skip';
import { EXECUTED_SOURCE_MAP_IMPORT_LIMIT as RECORDER_IMPORT_LIMIT } from '@papercusp/test-config/vitest-config';
import { gitInertGlobalChange, treeScriptCommands } from '../../../../scripts/lib/executed-source-map.mjs';
import { LANE_SCRIPTS } from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * gate-file-level-test-reuse-2026-09-27 P-008 / D-004: a selected test file is SKIPPED only
 * when its recorded pass proof is still valid at the judged sha. Every other case must RUN it.
 */

const NOW = Date.parse('2026-09-27T16:00:00Z');
const CTX = 'green-checkpoint';
const RUNNER = 'v25.9.0 linux x64';

type Proof = Parameters<typeof selectReusablePasses>[0]['proofs'] extends Map<string, infer P> ? P : never;

function proof(file: string, over: Partial<Proof> = {}): Proof {
  return {
    recordedSha: 'old',
    recordedAtMs: NOW - 3600_000,
    executedModules: [file, 'pkg/src/a.ts', 'libs/sub/src/b.ts'],
    readPaths: ['pkg/fixtures/data.json', 'sql/'],
    inputsCaptured: true,
    opaqueReasons: [],
    runContext: CTX,
    runnerIdentity: RUNNER,
    ...over,
  };
}

function run(files: string[], proofs: Map<string, Proof>, drift: Set<string> | null) {
  return selectReusablePasses({
    candidates: files,
    proofs,
    judgedSha: 'new',
    changedBetween: () => drift,
    runContext: CTX,
    runnerIdentity: RUNNER,
  });
}

const T = 'pkg/src/a.test.ts';

/**
 * WI-6554700010008589: gate run 762a13a6 judged a frozen repair head whose recorder writes proof-v2
 * while the selector (staging) compared against proof-v3, so all 7,689 candidates were `otherRunner`
 * and nothing was reused. The selector must take the JUDGED tree's format, and treat an older one
 * as legacy: its proofs may omit dynamically loaded modules (EI-25597096188717078), so only drift
 * made entirely of OTHER test files may leave them reusable.
 */
describe('judged-tree proof format (legacy proofs on a frozen lineage)', () => {
  const LEGACY = 'proof-v2';
  const legacyIdentity = `${LEGACY} ${RUNNER}`;
  const legacyRun = (files: string[], proofs: Map<string, Proof>, drift: Set<string> | null, proofFormat?: string) =>
    selectReusablePasses({
      candidates: files,
      proofs,
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: reuseRunnerIdentity(RUNNER, LEGACY) ?? '',
      ...(proofFormat === undefined ? {} : { proofFormat }),
    });
  const legacyProof = (file: string) => proof(file, { runnerIdentity: legacyIdentity });

  it('labels the runner identity with the format it is given', () => {
    expect(reuseRunnerIdentity(RUNNER, LEGACY)).toBe(legacyIdentity);
    expect(reuseRunnerIdentity(RUNNER)).toBe(`${REUSE_PROOF_FORMAT} ${RUNNER}`);
  });

  it('reads the format the judged tree records, and null when it cannot', () => {
    const root = mkdtempSync(join(tmpdir(), 'judged-proof-format-'));
    try {
      expect(judgedTreeProofFormat(root)).toBeNull();
      mkdirSync(join(root, 'libs/test-config/src'), { recursive: true });
      writeFileSync(join(root, RECORDER_PROOF_FORMAT_FILE), "export const REUSE_PROOF_FORMAT = 'proof-v2';\n");
      expect(judgedTreeProofFormat(root)).toBe('proof-v2');
      writeFileSync(join(root, RECORDER_PROOF_FORMAT_FILE), 'export const SOMETHING_ELSE = 1;\n');
      expect(judgedTreeProofFormat(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads THIS tree as the selector format (recorder and selector are pinned equal at one revision)', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    expect(judgedTreeProofFormat(repoRoot)).toBe(REUSE_PROOF_FORMAT);
  });

  it('reuses legacy proofs when every drift path is another test file', () => {
    const other = 'pkg/src/other.test.ts';
    const r = legacyRun([T], new Map([[T, legacyProof(T)]]), new Set([other, 'desktop/test/x.test.js']), LEGACY);
    expect(r.skip).toEqual([T]);
    expect(r.summary.otherRunner).toBe(0);
    expect(r.summary.legacyFormatDrift).toBe(0);
  });

  it('runs a legacy proof whose drift holds ANY non-test file, even one it never recorded executing', () => {
    // 'pkg/src/lazy.ts' is not in the proof's executedModules: under the current format that drift
    // would be harmless, but a legacy proof may have loaded it dynamically without recording it.
    for (const changed of ['pkg/src/lazy.ts', 'pkg/src/helpers.shared.ts', 'scripts/x.mjs', 'pkg/package.json']) {
      const r = legacyRun([T], new Map([[T, legacyProof(T)]]), new Set(['pkg/src/other.test.ts', changed]), LEGACY);
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.legacyFormatDrift, changed).toBe(1);
    }
  });

  it('runs a legacy proof whose own test file drifted', () => {
    const r = legacyRun([T], new Map([[T, legacyProof(T)]]), new Set([T]), LEGACY);
    expect(r.skip).toEqual([]);
    expect(r.summary.legacyFormatDrift).toBe(1);
  });

  it('applies no legacy restriction when the judged tree records the selector format', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set(['pkg/src/lazy.ts']));
    expect(r.skip).toEqual([T]);
    expect(r.summary.legacyFormatDrift).toBe(0);
  });

  it('still refuses a proof from a different format than the judged one (otherRunner)', () => {
    const r = legacyRun([T], new Map([[T, proof(T, { runnerIdentity: `${REUSE_PROOF_FORMAT} ${RUNNER}` })]]), new Set(), LEGACY);
    expect(r.skip).toEqual([]);
    expect(r.summary.otherRunner).toBe(1);
  });

  it('classifies only test files as legacy-safe drift', () => {
    for (const f of ['a.test.ts', 'b/c.spec.tsx', 'd.test.mjs', 'e.test.js']) expect(LEGACY_PROOF_SAFE_DRIFT_RE.test(f), f).toBe(true);
    for (const f of ['a.ts', 'a.shared.ts', 'test/helpers.js', 'a.test.ts.tmp', 'package.json']) expect(LEGACY_PROOF_SAFE_DRIFT_RE.test(f), f).toBe(false);
  });
});

describe('selectReusablePasses', () => {
  it('reuses a valid proof when nothing it depends on drifted', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other/unrelated.ts']));
    expect(r.skip).toEqual([T]);
    expect(r.summary.reused).toBe(1);
  });

  it('runs the file when the test file, an executed module or a submodule module changed', () => {
    for (const changed of [T, 'pkg/src/a.ts', 'libs/sub/src/b.ts']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.inputChanged, changed).toBe(1);
    }
  });

  it('runs the file when a runtime-read file or anything under a read directory changed', () => {
    for (const changed of ['pkg/fixtures/data.json', 'sql/1236-new.sql', 'sql']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
  });

  it('runs the file when a package.json or tsconfig above an executed module changed', () => {
    for (const changed of ['pkg/package.json', 'pkg/tsconfig.json', 'libs/sub/package.json', 'libs/tsconfig.base.json']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
    }
    // ...but a sibling package's manifest does not touch this proof.
    const r = run([T], new Map([[T, proof(T)]]), new Set(['other-pkg/package.json']));
    expect(r.skip).toEqual([T]);
  });

  it('invalidates every proof on a global runner input change', () => {
    for (const changed of ['package-lock.json', 'package.json', 'libs/test-config/src/vitest-config.ts', 'patches/x.patch']) {
      const r = run([T], new Map([[T, proof(T)]]), new Set([changed]));
      expect(r.skip, changed).toEqual([]);
      expect(r.summary.globalInput, changed).toBe(1);
    }
  });

  it('runs on unknown drift, missing, foreign, uncaptured or opaque proofs', () => {
    expect(run([T], new Map([[T, proof(T)]]), null).summary.unknownDrift).toBe(1);
    expect(run([T], new Map(), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { executedModules: ['pkg/src/a.ts'] })]]), new Set()).summary.noProof).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runContext: 'clean-local' })]]), new Set()).summary.otherContext).toBe(1);
    expect(run([T], new Map([[T, proof(T, { runnerIdentity: 'v22.0.0 linux x64' })]]), new Set()).summary.otherRunner).toBe(1);
    expect(run([T], new Map([[T, proof(T, { inputsCaptured: false })]]), new Set()).summary.notCaptured).toBe(1);
    expect(run([T], new Map([[T, proof(T, { opaqueReasons: ['child-process'] })]]), new Set()).summary.opaque).toBe(1);
  });

  it('treats a proof recorded at the judged sha as zero drift without calling git', () => {
    let calls = 0;
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T, { recordedSha: 'new' })]]),
      judgedSha: 'new',
      changedBetween: () => {
        calls += 1;
        return null;
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
    });
    expect(r.skip).toEqual([T]);
    expect(calls).toBe(0);
  });

  it('reads a throwing drift seam as unknown (runs the file)', () => {
    const r = selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, proof(T)]]),
      judgedSha: 'new',
      changedBetween: () => {
        throw new Error('boom');
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.unknownDrift).toBe(1);
  });
});

describe('gateReuseObservations', () => {
  it('does not invent an eligible file for an off-path decision with unknown population', () => {
    expect(gateReuseObservations('@ws::test', { offReason: 'dirty-checkout' })).toEqual([
      { eligible: 0, applied: 0, populationKnown: false, reason: 'dirty-checkout', scope: '@ws::test' },
    ]);
  });

  it('keeps a measured off-path population when one is available', () => {
    expect(gateReuseObservations('@ws::test', { offReason: 'dirty-checkout', eligible: 7 })).toEqual([
      { eligible: 7, applied: 0, populationKnown: true, reason: 'dirty-checkout', scope: '@ws::test' },
    ]);
  });

  it('records an empty candidate population as zero units', () => {
    expect(gateReuseObservations('@ws::test', { summary: { candidates: 0, reused: 0 } })).toEqual([
      { eligible: 0, applied: 0, populationKnown: true, reason: 'no-candidates', scope: '@ws::test' },
    ]);
  });

  it('keeps known file units measurable', () => {
    expect(gateReuseObservations('@ws::test', { summary: { candidates: 20, reused: 20 } })).toEqual([
      { eligible: 20, applied: 20, populationKnown: true, reason: 'applied', scope: '@ws::test' },
    ]);
  });

  it('splits a mixed population into its exclusive buckets', () => {
    expect(gateReuseObservations('@ws::test', {
      summary: { candidates: 15, reused: 10, noProof: 5 },
    })).toEqual([
      { eligible: 10, applied: 10, populationKnown: true, reason: 'applied', scope: '@ws::test' },
      { eligible: 5, applied: 0, populationKnown: true, reason: 'noProof', scope: '@ws::test' },
    ]);
  });

  it('does not count opaque proofs or global input drift as missed reuse opportunities', () => {
    const rows = gateReuseObservations('@ws::test', {
      summary: { candidates: 21, reused: 0, opaque: 5, globalInput: 16 },
    });

    expect(rows).toEqual([
      { eligible: 0, applied: 0, populationKnown: true, reason: 'opaque', scope: '@ws::test' },
      { eligible: 0, applied: 0, populationKnown: true, reason: 'globalInput', scope: '@ws::test' },
    ]);
    expect(rows.reduce((total, row) => total + row.eligible, 0)).toBe(0);
  });

  it('distinguishes measured zero off-path files from missing or invalid cardinality', () => {
    expect(gateReuseObservations('@ws::test', { offReason: 'dirty-checkout', eligible: 0 })[0])
      .toMatchObject({ eligible: 0, populationKnown: true });
    for (const eligible of [undefined, -1, NaN, 0.5]) {
      expect(gateReuseObservations('@ws::test', { offReason: 'dirty-checkout', eligible })[0])
        .toMatchObject({ eligible: 0, populationKnown: false });
    }
    expect(gateReuseObservations('@ws::test', {})[0])
      .toMatchObject({ eligible: 0, populationKnown: false });
  });
});

describe('P-001 (gate-test-reuse-yield-2026-10-01): nested vitest configs are per-proof inputs', () => {
  const OC_CFG = 'packages/operator-core/vitest.config.ts';
  const SEARCH_CFG = 'libs/generic/search/vitest.config.ts';
  const REPO = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));

  it('keeps ROOT runner configs global and scopes nested ones', () => {
    expect(isGlobalRunnerInput('vitest.config.ts')).toBe(true);
    expect(isGlobalRunnerInput('vitest.workspace.ts')).toBe(true);
    expect(isGlobalRunnerInput(OC_CFG)).toBe(false);
    expect(isGlobalRunnerInput('packages/operator-core/vitest.integration.config.ts')).toBe(false);
  });

  it('a nested config change voids exactly the proofs that recorded that config as an input', () => {
    const ocTest = 'packages/operator-core/lib/x.test.ts';
    const searchTest = 'libs/generic/search/src/y.test.ts';
    const proofs = new Map([
      [ocTest, proof(ocTest, { readPaths: ['pkg/fixtures/data.json', OC_CFG] })],
      [searchTest, proof(searchTest, { readPaths: [SEARCH_CFG] })],
    ]);
    const r = run([ocTest, searchTest], proofs, new Set([SEARCH_CFG]));
    // Before P-001 the search config was global and BOTH ran; the proof that loaded it must still run.
    expect(r.skip).toEqual([ocTest]);
    expect(r.summary.inputChanged).toBe(1);
    expect(r.summary.globalInput).toBe(0);
  });

  it('the proof format rides in the runner identity, identically on the selector and recorder sides', () => {
    expect(REUSE_PROOF_FORMAT).toBe('proof-v3');
    expect(REUSE_PROOF_FORMAT).toBe(RECORDER_PROOF_FORMAT);
    expect(reuseRunnerIdentity(' v25.9.0 linux x64\n')).toBe(`${REUSE_PROOF_FORMAT} v25.9.0 linux x64`);
    expect(reuseRunnerIdentity('')).toBeNull();
    expect(reuseRunnerIdentity(null)).toBeNull();
    expect(reuseRunnerIdentity(`${process.version} ${process.platform} ${process.arch}`)).toBe(executedSourceRunnerIdentity());
  });

  it('an older-format proof (no config input recorded) is never judged under the narrowed rule', () => {
    const f = 'packages/operator-core/lib/x.test.ts';
    const r = selectReusablePasses({
      candidates: [f],
      proofs: new Map([[f, proof(f, { runnerIdentity: RUNNER })]]),
      judgedSha: 'new',
      changedBetween: () => new Set([OC_CFG]),
      runContext: CTX,
      runnerIdentity: reuseRunnerIdentity(RUNNER) ?? '',
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.otherRunner).toBe(1);
  });

  it('rejects collection-only proof-v2 even when no tracked inputs changed', () => {
    const f = 'packages/operator-core/lib/dynamic-route.test.ts';
    const r = run([f], new Map([[f, proof(f, { runnerIdentity: `proof-v2 ${RUNNER}` })]]), new Set());
    expect(r.skip).toEqual([]);
    expect(r.summary.otherRunner).toBe(1);
  });

  // Vite records a config's RELATIVE imports in configFileDependencies but externalizes BARE ones,
  // so a proof never sees a bare import. That is sound only while every bare import of a nested
  // config resolves into node_modules (package-lock.json is global) or to libs/test-config (global).
  type SpecClass = 'builtin' | 'relative' | 'test-config' | 'npm' | 'workspace' | 'unresolved';
  function classify(spec: string, fromFile: string): SpecClass {
    if (spec.startsWith('node:') || builtinModules.includes(spec)) return 'builtin';
    if (spec.startsWith('.')) return 'relative';
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    for (let dir = dirname(`${REPO}/${fromFile}`); ; dir = dirname(dir)) {
      const candidate = `${dir}/node_modules/${name}`;
      if (existsSync(candidate)) {
        const real = realpathSync(candidate);
        if (real.split(sep).includes('node_modules')) return 'npm';
        return relative(REPO, real) === 'libs/test-config' ? 'test-config' : 'workspace';
      }
      if (dir === REPO || dir === dirname(dir)) return 'unresolved';
    }
  }

  it('every nested vitest config imports only what a proof or a global rule covers', () => {
    const configs = execFileSync('git', ['ls-files', '--recurse-submodules'], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n')
      .filter((f) => existsSync(`${REPO}/${f}`)) // drop index-lagged deletions before the reads below
      .filter((f) => /\/vitest\.[^/]*config[^/]*\.[cm]?[jt]s$/.test(f));
    const counts: Record<SpecClass, number> = { builtin: 0, relative: 0, 'test-config': 0, npm: 0, workspace: 0, unresolved: 0 };
    const violations: string[] = [];
    const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;
    for (const f of configs) {
      const src = readFileSync(`${REPO}/${f}`, 'utf8');
      for (const m of src.matchAll(SPEC_RE)) {
        const c = classify(m[2], f);
        counts[c] += 1;
        if (c === 'workspace' || c === 'unresolved') violations.push(`${f} imports '${m[2]}' (${c})`);
      }
    }
    // Positive controls: the scan saw the real population, so an empty violation list is not vacuous.
    expect(configs.length).toBeGreaterThanOrEqual(40);
    expect(counts['test-config']).toBeGreaterThanOrEqual(40);
    expect(counts.npm).toBeGreaterThan(0);
    // Negative control: the classifier CAN report a workspace import.
    const otherWorkspace = readdirSync(`${REPO}/node_modules/@papercusp`).find(
      (n) => n !== 'test-config' && !realpathSync(`${REPO}/node_modules/@papercusp/${n}`).split(sep).includes('node_modules'),
    );
    expect(otherWorkspace).toBeDefined();
    expect(classify(`@papercusp/${otherWorkspace}`, 'packages/operator-core/vitest.config.ts')).toBe('workspace');
    expect(violations).toEqual([]);
  });
});

describe('isGlobalRunnerInput', () => {
  it('treats libs/test-config TEST files as ordinary tests, not runner inputs', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.test.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/pg-container.ts')).toBe(true);
    expect(isGlobalRunnerInput('packages/operator-core/package.json')).toBe(false);
    // P-001: a nested vitest config is a per-proof input (proof-v2 records it), not global.
    expect(isGlobalRunnerInput('packages/operator-core/vitest.config.ts')).toBe(false);
  });

  // WI-10003752: replayed from real commits (592850d, ff4e267, e1cb05e) — each discarded every
  // pass proof fleet-wide while changing nothing any other workspace's runner reads.
  it('ignores test-config fixtures and swept non-source temps, but not real runner sources', () => {
    expect(isGlobalRunnerInput('libs/test-config/src/__fixtures__/armed-capture/sample.txt')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/__fixtures__/armed-capture/nested/x.ts')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.test.ts.tmp.4121.a1b2c3')).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.ts.tmp')).toBe(false);
    // The calibration half: every real runner source still invalidates (a rule that excluded
    // these would pass the lines above vacuously).
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.ts')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/executed-source-map-reporter.ts')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/setup.mjs')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/src/quarantine.json')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/package.json')).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/tsconfig.json')).toBe(true);
  });
});

/**
 * gate-test-reuse-yield-2026-10-01 P-002: a root package.json change is global only when something
 * a proof cannot see changed. Measured: 12 of 43 global-touching commits in 72h touched it.
 */
describe('P-002: scripts-only root package.json changes are not global', () => {
  const pkg = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      name: 'root',
      private: true,
      workspaces: ['packages/*'],
      devDependencies: { vitest: '4.0.0' },
      scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'node x.mjs', 'gen:y': 'node y.mjs' },
      ...over,
    });

  it('judges only non-runner script edits as inert', () => {
    const base = pkg();
    // Inert: an added, changed or removed non-task script, and pure key reordering.
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'node x2.mjs', 'gen:y': 'node y.mjs', 'lint:new': 'z' } }))).toBe(true);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { test: 'node scripts/affected-tests.mjs' } }))).toBe(true);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(base) as Record<string, unknown>).reverse()));
    expect(reordered).not.toBe(base);
    expect(rootPackageJsonChangeIsInert(base, reordered)).toBe(true);
    // 'prettier' starts with "pre" but is no task's hook.
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: { ...JSON.parse(base).scripts, prettier: 'prettier .' } }))).toBe(true);
    // Global: any field outside scripts.
    expect(rootPackageJsonChangeIsInert(base, pkg({ devDependencies: { vitest: '4.0.1' } }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ workspaces: ['packages/*', 'libs/*'] }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ overrides: { esbuild: '0.25.0' } }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ type: 'module' }))).toBe(false);
  });

  it('keeps task scripts, their pre/post hooks and install lifecycle scripts global', () => {
    const base = pkg();
    const withScript = (name: string, body: string) =>
      pkg({ scripts: { ...JSON.parse(base).scripts, [name]: body } });
    for (const name of [
      'test', 'test:lane-pure', 'test:lane-stateful', 'test:lane-future', 'test:integration', 'test:el-suite',
      'lint:el-tools', 'pretest', 'posttest', 'pretest:lane-pure', 'posttest:integration',
      'postinstall', 'preinstall', 'install', 'prepare', 'dependencies',
    ]) {
      expect(isRunnerAffectingScript(name), name).toBe(true);
      expect(rootPackageJsonChangeIsInert(base, withScript(name, 'changed')), name).toBe(false);
    }
    for (const name of ['lint:x', 'gen:y', 'test:file', 'test:affected', 'prettier', 'postgres:up']) {
      expect(isRunnerAffectingScript(name), name).toBe(false);
    }
  });

  it('fails closed on anything it cannot parse as two JSON objects with object scripts', () => {
    const base = pkg();
    expect(rootPackageJsonChangeIsInert(base, '{ not json')).toBe(false);
    expect(rootPackageJsonChangeIsInert('[]', '[]')).toBe(false);
    expect(rootPackageJsonChangeIsInert('null', 'null')).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: 'node x.mjs' }))).toBe(false);
    expect(rootPackageJsonChangeIsInert(base, pkg({ scripts: ['a'] }))).toBe(false);
  });

  // The lane list is the gate's task vocabulary (targeted-task-reuse.mjs), and affected-tests
  // pushes further task scripts by literal name. Every one must count as runner-affecting, or a
  // root edit to it would be wrongly judged inert.
  it('covers every task script the gate runs (derived from the runners, not hand-listed)', () => {
    for (const name of LANE_SCRIPTS) expect(isRunnerAffectingScript(name), name).toBe(true);
    const repo = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
    const src = readFileSync(join(repo, 'scripts/affected-tests.mjs'), 'utf8');
    const pushed = [...src.matchAll(/tasks\.push\(\{\s*ws,\s*script:\s*"([^"]+)"\s*\}\)/g)].map((m) => m[1]!);
    // Positive control: the scan must find the known literal pushes, or it is checking nothing.
    expect(pushed).toEqual(expect.arrayContaining(['test', 'lint:el-tools', 'test:integration', 'test:el-suite']));
    for (const name of pushed) expect(isRunnerAffectingScript(name), name).toBe(true);
  });

  function runWithSeam(
    drift: Set<string>,
    inertGlobalChange: ((rel: string, from: string, to: string) => boolean) | null,
    p: Proof = proof(T),
  ) {
    return selectReusablePasses({
      candidates: [T],
      proofs: new Map([[T, p]]),
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: RUNNER,
      inertGlobalChange,
    });
  }

  it('reuses a proof across an inert root package.json change and counts it as inertGlobal', () => {
    const asked: string[] = [];
    const r = runWithSeam(new Set(['package.json', 'other/unrelated.ts']), (rel, from, to) => {
      asked.push(`${rel}@${from}..${to}`);
      return true;
    });
    expect(r.skip).toEqual([T]);
    expect(r.summary).toMatchObject({ reused: 1, globalInput: 0, inputChanged: 0, inertGlobal: 1 });
    // Only GLOBAL drift paths are put to the seam, with the proof's recorded sha and the judged sha.
    expect(asked).toEqual(['package.json@old..new']);
  });

  it('still invalidates a proof that read the root package.json itself', () => {
    const p = proof(T, { readPaths: ['package.json'] });
    const r = runWithSeam(new Set(['package.json']), () => true, p);
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ globalInput: 0, inputChanged: 1, inertGlobal: 1 });
  });

  it('keeps the change global when the seam says no, throws, answers non-true, or is absent', () => {
    const seams: Array<((rel: string, from: string, to: string) => boolean) | null> = [
      () => false,
      () => {
        throw new Error('git show failed');
      },
      () => 1 as unknown as boolean,
      () => 'yes' as unknown as boolean,
      null,
    ];
    for (const seam of seams) {
      const r = runWithSeam(new Set(['package.json']), seam);
      expect(r.skip).toEqual([]);
      expect(r.summary).toMatchObject({ globalInput: 1, inertGlobal: 0 });
    }
  });

  it('stays global when any other global path drifted alongside the inert one', () => {
    const r = runWithSeam(new Set(['package.json', 'package-lock.json']), (rel) => rel === 'package.json');
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ globalInput: 1, inertGlobal: 0 });
  });

  it('gitInertGlobalChange reads both shas with git show, judges only the root package.json, and caches', () => {
    const texts: Record<string, string> = {
      'old:package.json': pkg(),
      'new:package.json': pkg({ scripts: { test: 'node scripts/affected-tests.mjs', 'lint:x': 'changed' } }),
      'dep:package.json': pkg({ devDependencies: { vitest: '9.9.9' } }),
    };
    const calls: string[][] = [];
    const exec = (file: string, args: string[]) => {
      calls.push([file, ...args]);
      const t = texts[args[1]!];
      if (t === undefined) throw new Error(`fatal: invalid object name ${args[1]}`);
      return t;
    };
    const seam = gitInertGlobalChange({ repoRoot: '/repo', exec });
    expect(seam('package.json', 'old', 'new')).toBe(true);
    expect(seam('package.json', 'old', 'new')).toBe(true);
    expect(calls).toEqual([
      ['git', 'show', 'old:package.json'],
      ['git', 'show', 'new:package.json'],
    ]);
    expect(seam('package.json', 'old', 'dep')).toBe(false);
    // A sha this clone lacks reads as "cannot tell": global.
    expect(seam('package.json', 'gone', 'new')).toBe(false);
    // Only manifests (root here, workspace ones in the D-009 block below) and the lockfile
    // (P-005, below) can be inert; nothing else is read.
    const before = calls.length;
    expect(seam('libs/test-config/src/vitest-config.ts', 'old', 'new')).toBe(false);
    expect(seam('patches/x.patch', 'old', 'new')).toBe(false);
    expect(seam('packages/operator-core/tsconfig.json', 'old', 'new')).toBe(false);
    expect(calls.length).toBe(before);
    // A workspace manifest is judged over the whole tree (D-009); this fake has no tree, so the
    // read fails and the answer is "cannot tell".
    expect(seam('packages/operator-core/package.json', 'old', 'new')).toBe(false);
  });
});

/**
 * gate-test-reuse-yield-2026-10-01 D-009 (WI-10004940): a scripts-only edit to a WORKSPACE
 * package.json voided every proof beneath that directory through the ancestor-config rule.
 * Measured: 2,847 of 3,757 proofs at 87d557e7 for one operator-core script edit, ~1.5 such edits
 * a day. It is inert only when no changed name is runner-affecting and no script anywhere in the
 * tree can invoke one.
 */
describe('D-009: scripts-only workspace package.json changes reach only proofs that read them', () => {
  const ws = (scripts: Record<string, string>, over: Record<string, unknown> = {}) =>
    JSON.stringify({ name: '@x/pkg', type: 'module', dependencies: { zod: '3.0.0' }, scripts, ...over });
  const base = { test: 'vitest run', 'gen:docs': 'node gen.mjs', prebuild: 'node pre.mjs' };
  const never = () => false;

  it('scriptsOnlyChangedNames lists added, removed and changed names, and null for anything else', () => {
    expect(scriptsOnlyChangedNames(ws(base), ws({ ...base, 'gen:docs': 'node gen2.mjs', 'lint:new': 'x' }))).toEqual(['gen:docs', 'lint:new']);
    expect(scriptsOnlyChangedNames(ws(base), ws({ test: 'vitest run', prebuild: 'node pre.mjs' }))).toEqual(['gen:docs']);
    expect(scriptsOnlyChangedNames(ws(base), ws(base))).toEqual([]);
    expect(scriptsOnlyChangedNames(ws(base), ws(base, { dependencies: { zod: '3.0.1' } }))).toBeNull();
    expect(scriptsOnlyChangedNames(ws(base), '{ nope')).toBeNull();
    expect(scriptsOnlyChangedNames(ws(base), ws(base, { scripts: ['a'] }))).toBeNull();
  });

  it('is inert only for a non-runner, non-invokable scripts-only change', () => {
    expect(workspacePackageJsonChangeIsInert(ws(base), ws({ ...base, 'gen:docs': 'node gen2.mjs' }), never)).toBe(true);
    // A non-script field, a runner-affecting script, a parse failure: never inert.
    expect(workspacePackageJsonChangeIsInert(ws(base), ws(base, { type: 'commonjs' }), never)).toBe(false);
    expect(workspacePackageJsonChangeIsInert(ws(base), ws({ ...base, test: 'vitest run --bail' }), never)).toBe(false);
    expect(workspacePackageJsonChangeIsInert(ws(base), ws({ ...base, 'pretest:lane-pure': 'x' }), never)).toBe(false);
    expect(workspacePackageJsonChangeIsInert(ws(base), '{ nope', never)).toBe(false);
    // Invokable: the judge must answer exactly false; true, a non-boolean or a throw keep it a config change.
    const changed = ws({ ...base, 'gen:docs': 'node gen2.mjs' });
    expect(workspacePackageJsonChangeIsInert(ws(base), changed, (n) => n === 'gen:docs')).toBe(false);
    expect(workspacePackageJsonChangeIsInert(ws(base), changed, () => undefined as unknown as boolean)).toBe(false);
    expect(
      workspacePackageJsonChangeIsInert(ws(base), changed, () => {
        throw new Error('tree unreadable');
      }),
    ).toBe(false);
  });

  it('treats a pre/post hook as invoked whenever the script it wraps is', () => {
    // npm runs `prebuild` around every `npm run build`.
    const edited = ws({ ...base, prebuild: 'node pre2.mjs' });
    expect(workspacePackageJsonChangeIsInert(ws(base), edited, (n) => n === 'build')).toBe(false);
    expect(workspacePackageJsonChangeIsInert(ws(base), edited, never)).toBe(true);
    const post = ws({ ...base, 'postgen:docs': 'node after.mjs' });
    expect(workspacePackageJsonChangeIsInert(ws(base), post, (n) => n === 'gen:docs')).toBe(false);
  });

  it('scriptInvocationJudge finds sibling, cross-package and pattern invocations', () => {
    const judge = scriptInvocationJudge([
      // papercusp-desktop's shape: a task script that runs its siblings.
      { rel: 'desk/package.json', name: 'test', command: 'npm run test:config && npm run test:shell' },
      { rel: 'desk/package.json', name: 'test:config', command: 'node --test config.test.js' },
      // A root script reaching into a workspace.
      { rel: 'package.json', name: 'docs', command: 'npm run build:docs --workspace apps/docs' },
      // A script whose own command mentions its own name is not an invocation of itself.
      { rel: 'pkg/package.json', name: 'gen:x', command: 'node gen-x.mjs gen:x' },
    ]);
    expect(judge('test:config', 'desk/package.json')).toBe(true);
    expect(judge('build:docs', 'apps/docs/package.json')).toBe(true);
    expect(judge('gen:x', 'pkg/package.json')).toBe(false);
    // ...but the same name spelled in ANOTHER package's command is (substring, over-approximate).
    expect(judge('gen:x', 'other/package.json')).toBe(true);
    expect(judge('test:con', 'x/package.json')).toBe(true);
    expect(judge('lint:never-mentioned', 'pkg/package.json')).toBe(false);
    for (const command of ["run-s 'lint:*'", 'npm-run-all --parallel gen:*', 'concurrently "npm:watch-*"']) {
      const patterned = scriptInvocationJudge([{ rel: 'package.json', name: 'all', command }]);
      expect(patterned('lint:never-mentioned', 'pkg/package.json'), command).toBe(true);
    }
    // A plain glob in a non-runner command is not a pattern run.
    expect(scriptInvocationJudge([{ rel: 'p/package.json', name: 'fmt', command: 'prettier "src/**/*.ts"' }])('gen:y', 'q/package.json')).toBe(false);
  });

  function runWith(
    drift: Set<string>,
    inertGlobalChange: ((rel: string, from: string, to: string) => boolean) | null,
    p: Proof = proof(T),
    file = T,
  ) {
    return selectReusablePasses({
      candidates: [file],
      proofs: new Map([[file, p]]),
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: RUNNER,
      inertGlobalChange,
    });
  }

  it('reuses a proof beneath an inert workspace manifest and counts it as inertWorkspaceConfig', () => {
    const asked: string[] = [];
    const seam = (rel: string, from: string, to: string) => {
      asked.push(`${rel}@${from}..${to}`);
      return true;
    };
    const r = runWith(new Set(['pkg/package.json', 'pkg/src/unrelated.ts', 'docs/readme.md']), seam);
    expect(r.skip).toEqual([T]);
    expect(r.summary).toMatchObject({ reused: 1, inputChanged: 0, globalInput: 0, inertWorkspaceConfig: 1, inertGlobal: 0 });
    // Only manifests are put to the seam; other non-global paths never are.
    expect(asked).toEqual(['pkg/package.json@old..new']);
  });

  it('still invalidates through the ancestor rule when the seam says no, and a proof that read the manifest', () => {
    for (const seam of [() => false, null, () => { throw new Error('x'); }]) {
      const r = runWith(new Set(['pkg/package.json']), seam);
      expect(r.skip).toEqual([]);
      expect(r.summary).toMatchObject({ inputChanged: 1, inertWorkspaceConfig: 0 });
    }
    const reader = proof(T, { readPaths: ['pkg/package.json'] });
    const r = runWith(new Set(['pkg/package.json']), () => true, reader);
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ inputChanged: 1, inertWorkspaceConfig: 0 });
  });

  it('counts only proofs the manifest would have reached, and keeps the root counter separate', () => {
    const elsewhere = 'other/x.test.ts';
    const r = runWith(new Set(['pkg/package.json']), () => true, proof(elsewhere, { executedModules: [elsewhere], readPaths: [] }), elsewhere);
    expect(r.skip).toEqual([elsewhere]);
    expect(r.summary).toMatchObject({ reused: 1, inertWorkspaceConfig: 0, inertGlobal: 0 });
    const both = runWith(new Set(['package.json', 'pkg/package.json']), () => true);
    expect(both.summary).toMatchObject({ reused: 1, inertGlobal: 1, inertWorkspaceConfig: 1 });
  });

  // A fake git over named trees: `${repoDir}@${sha}` -> path -> manifest text or a gitlink.
  type TreeSpec = Record<string, string | { gitlink: string }>;
  function fakeGit(repos: Record<string, TreeSpec>) {
    const blobs = new Map<string, string>();
    const calls: string[] = [];
    const oidOf = (text: string) => {
      const oid = createHash('sha1').update(text).digest('hex');
      blobs.set(oid, text);
      return oid;
    };
    const exec = (_file: string, args: string[], opts: object) => {
      const { cwd, input } = opts as { cwd: string; input?: Buffer };
      calls.push(`${cwd} ${args[0]}`);
      if (args[0] === 'ls-tree') {
        const spec = repos[`${cwd}@${args.at(-1)}`];
        if (!spec) throw new Error(`fatal: not a tree object: ${args.at(-1)}`);
        return (
          Object.entries(spec)
            .map(([p, v]) => (typeof v === 'string' ? `100644 blob ${oidOf(v)}\t${p}` : `160000 commit ${v.gitlink}\t${p}`))
            .join('\0') + '\0'
        );
      }
      if (args[0] === 'cat-file') {
        const parts = String(input).trim().split('\n').map((oid) => {
          const text = Buffer.from(blobs.get(oid) ?? '');
          return Buffer.concat([Buffer.from(`${oid} blob ${text.length}\n`), text, Buffer.from('\n')]);
        });
        return Buffer.concat(parts) as unknown as string;
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { exec, calls };
  }

  const SUB_OLD = 'a1'.repeat(20);
  const SUB_NEW = 'b2'.repeat(20);
  // Multibyte text checks that cat-file's byte sizes are honoured.
  const root = (scripts: Record<string, string> = {}) => JSON.stringify({ name: 'root', description: 'naïve — ✓', scripts });
  const repos: Record<string, TreeSpec> = {
    '/repo@old': { 'package.json': root(), 'pkg/package.json': ws(base), 'pkg/src/a.ts': 'x', 'libs/sub': { gitlink: SUB_OLD } },
    '/repo@new': {
      'package.json': root(),
      'pkg/package.json': ws({ ...base, 'gen:docs': 'node gen2.mjs' }),
      'libs/sub': { gitlink: SUB_NEW },
    },
    // At new2 the root starts invoking the changed script.
    '/repo@new2': {
      'package.json': root({ docs: 'npm run gen:docs --workspace pkg' }),
      'pkg/package.json': ws({ ...base, 'gen:docs': 'node gen2.mjs' }),
      'libs/sub': { gitlink: SUB_NEW },
    },
    '/repo@broken': { 'package.json': root(), 'pkg/package.json': ws(base), 'fixtures/package.json': '{ nope' },
    '/repo@lostsub': { 'package.json': root(), 'pkg/package.json': ws(base), 'libs/sub': { gitlink: 'c3'.repeat(20) } },
    [`/repo/libs/sub@${SUB_OLD}`]: { 'package.json': root(), 'x/package.json': ws({ 'lint:y': 'eslint .' }) },
    [`/repo/libs/sub@${SUB_NEW}`]: { 'package.json': root(), 'x/package.json': ws({ 'lint:y': 'eslint src' }) },
  };

  it('treeScriptCommands reads every manifest, submodules at their pinned commit, and fails closed', () => {
    const { exec } = fakeGit(repos);
    const tree = treeScriptCommands({ exec, repoRoot: '/repo', sha: 'old' });
    expect([...tree.texts.keys()].sort()).toEqual(['libs/sub/package.json', 'libs/sub/x/package.json', 'package.json', 'pkg/package.json']);
    expect(tree.texts.get('package.json')).toBe(root());
    expect(tree.commands).toContainEqual({ rel: 'libs/sub/x/package.json', name: 'lint:y', command: 'eslint .' });
    expect(() => treeScriptCommands({ exec, repoRoot: '/repo', sha: 'broken' })).toThrow();
    expect(() => treeScriptCommands({ exec, repoRoot: '/repo', sha: 'lostsub' })).toThrow();
  });

  it('gitInertGlobalChange judges workspace manifests against the tree at both shas, once per sha', () => {
    const { exec, calls } = fakeGit(repos);
    const seam = gitInertGlobalChange({ repoRoot: '/repo', exec });
    expect(seam('pkg/package.json', 'old', 'new')).toBe(true);
    // A manifest inside a submodule is read at the commit each side pins.
    expect(seam('libs/sub/x/package.json', 'old', 'new')).toBe(true);
    // Each tree is listed once per repository, however many paths are judged.
    expect(calls.filter((c) => c.endsWith('ls-tree')).sort()).toEqual(['/repo ls-tree', '/repo ls-tree', '/repo/libs/sub ls-tree', '/repo/libs/sub ls-tree']);
    // Invoked by a script at EITHER side: not inert.
    expect(seam('pkg/package.json', 'old', 'new2')).toBe(false);
    expect(seam('pkg/package.json', 'new2', 'old')).toBe(false);
    // The manifest is identical at new2 and new: nothing changed, so nothing to reach.
    expect(seam('pkg/package.json', 'new2', 'new')).toBe(true);
    // Any unreadable side fails closed.
    expect(seam('pkg/package.json', 'broken', 'new')).toBe(false);
    expect(seam('pkg/package.json', 'lostsub', 'new')).toBe(false);
    expect(seam('pkg/package.json', 'gone', 'new')).toBe(false);
    expect(seam('missing/package.json', 'old', 'new')).toBe(false);
  });

  // D-009 rule 3 reads package.json COMMANDS only. That is sound only while no task script (the
  // only scripts whose tests are reused) runs a FILE that itself runs npm scripts: such a file
  // could reach a changed name the commands never spell. Measured 2026-10-01: 27 files referenced
  // by 135 runner-affecting scripts; the ones mentioning an npm-script run are listed here, each
  // with why it is not an invocation the rule misses. A new one must be taught to
  // scriptInvocationJudge (or shown harmless here), not silently added.
  it('no task script reaches npm scripts through a file it runs, beyond the known ones', () => {
    const KNOWN: Record<string, string> = {
      'scripts/affected-tests.mjs':
        'the gate runner: runs task scripts by literal name (pinned runner-affecting above) and repo-wide guards, which are never reused (unitTasks = test + lane scripts)',
      'scripts/pc-heavy.sh': 'mentions npm run only in help text it echoes',
      'scripts/guard-shared-tree-install.mjs': 'mentions npm run only in its refusal message',
      'scripts/npm-install-safe.mjs': 'the scan matches only the exported USAGE help string; --exec-under-lock forwards the explicit command argv already present in the task script',
      'scripts/install-onnxruntime-node.mjs': 'mentions npm run only in an error message',
    };
    const repo = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
    const manifests = execFileSync('git', ['ls-files', '--recurse-submodules', '-z'], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter((f) => f.endsWith('package.json') && /(?:^|\/)package\.json$/.test(f) && !f.includes('node_modules/'));
    const INVOKE_RE = /\bnpm\s+(?:run|run-script|test|t|start|restart|stop)\b|\bnpm-run-all2?\b|\brun-[sp]\b|\bconcurrently\b|\bnpm:|\bpnpm\b|\byarn\b|\blerna\s+run\b|\bturbo\s+run\b/;
    const reaching = new Set<string>();
    let filesChecked = 0;
    for (const m of manifests) {
      const abs = join(repo, m);
      if (!existsSync(abs)) continue;
      let scripts: Record<string, unknown> = {};
      try {
        scripts = (JSON.parse(readFileSync(abs, 'utf8')) as { scripts?: Record<string, unknown> }).scripts ?? {};
      } catch {
        continue; // a fixture; treeScriptCommands fails closed on it in the gate
      }
      for (const [name, command] of Object.entries(scripts)) {
        if (!isRunnerAffectingScript(name)) continue;
        for (const token of String(command).split(/[\s;&|()'"=]+/)) {
          if (!/\.(?:sh|bash|mjs|cjs|js|ts|mts|cts|py)$/.test(token)) continue;
          const file = join(dirname(abs), token);
          if (!existsSync(file) || !statSync(file).isFile()) continue;
          filesChecked += 1;
          const live = readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(?:\/\/|#|\*)/.test(l));
          if (live.some((l) => INVOKE_RE.test(l))) reaching.add(relative(repo, file).split(sep).join('/'));
        }
      }
    }
    // Positive control: the scan must see the runner itself, or it is checking nothing.
    expect(filesChecked).toBeGreaterThan(5);
    expect(reaching).toContain('scripts/affected-tests.mjs');
    const unknown = [...reaching].filter((f) => !(f in KNOWN));
    expect(unknown, `teach scriptInvocationJudge about these files: ${unknown.join(', ')}`).toEqual([]);
  });
});

/**
 * gate-test-reuse-yield-2026-10-01 P-005: package-lock.json is global unless the installed tree is
 * identical at both shas. Proofs record no node_modules path (the reporter drops external modules),
 * so any installed-entry change stays global. Measured: 5 of 17 lockfile commits in the 7 days to
 * 2026-10-01 changed only workspace entries, and each one discarded every proof.
 */
describe('P-003: a test-config file outside the main-process closure is a per-proof input', () => {
  const MAIN = new Set(['libs/test-config/src/vitest-config.ts', 'libs/test-config/src/executed-source-map-reporter.ts']);
  const SETUP = 'libs/test-config/src/setup-hermetic-env.ts';
  const runWith = (proofs: Map<string, Proof>, drift: Set<string>, main: ReadonlySet<string> | null = MAIN) =>
    selectReusablePasses({
      candidates: [...proofs.keys()],
      proofs,
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: RUNNER,
      testConfigMainProcess: main,
    });

  it('keeps every test-config source file global without a closure, and main-process ones global with it', () => {
    expect(isGlobalRunnerInput(SETUP)).toBe(true);
    expect(isGlobalRunnerInput(SETUP, MAIN)).toBe(false);
    expect(isGlobalRunnerInput('libs/test-config/src/vitest-config.ts', MAIN)).toBe(true);
    // The manifest and tsconfig are never narrowed.
    expect(isGlobalRunnerInput('libs/test-config/package.json', MAIN)).toBe(true);
    expect(isGlobalRunnerInput('libs/test-config/tsconfig.json', MAIN)).toBe(true);
  });

  it('matches a worker-side change per proof: a proof that ran it reruns, one that did not is reused', () => {
    const ran = 'pkg/src/ran.test.ts';
    const didNot = 'pkg/src/did-not.test.ts';
    const proofs = new Map([
      [ran, proof(ran, { executedModules: [ran, SETUP] })],
      [didNot, proof(didNot)],
    ]);
    const r = runWith(proofs, new Set([SETUP]));
    expect(r.skip).toEqual([didNot]);
    expect(r.summary).toMatchObject({ reused: 1, inputChanged: 1, globalInput: 0, testConfigNarrowed: 2 });
    // Without the closure, the same drift discards both.
    expect(runWith(proofs, new Set([SETUP]), null).summary).toMatchObject({ reused: 0, globalInput: 2 });
  });

  it('still discards every proof for a main-process change', () => {
    const r = runWith(new Map([[T, proof(T)]]), new Set(['libs/test-config/src/executed-source-map-reporter.ts']));
    expect(r.summary).toMatchObject({ reused: 0, globalInput: 1, testConfigNarrowed: 0 });
  });

  it('treats a proof whose module record hit the import cap as opaque under a narrowed drift (D-004)', () => {
    const capped = Array.from({ length: EXECUTED_SOURCE_MAP_IMPORT_LIMIT }, (_, i) => `pkg/src/m${i}.ts`);
    const proofs = new Map([[T, proof(T, { executedModules: [T, ...capped] })]]);
    expect(runWith(proofs, new Set([SETUP])).summary).toMatchObject({ reused: 0, opaque: 1 });
    // The cap only matters when a narrowed path is in the drift.
    expect(runWith(proofs, new Set(['pkg/unrelated.md'])).summary).toMatchObject({ reused: 1, opaque: 0 });
  });

  it('pins the import-cap mirror to the recorder', () => {
    expect(EXECUTED_SOURCE_MAP_IMPORT_LIMIT).toBe(RECORDER_IMPORT_LIMIT);
  });
});

describe('P-004: a tsconfig the vitest toolchain never reads is not a runner input (D-007)', () => {
  // The derived set (libs/test-config/src/toolchain-tsconfigs.ts): what vite + vite-tsconfig-paths read.
  const READ = new Set(['tsconfig.base.json', 'pkg/tsconfig.json', 'pkg/tsconfig.lib.json']);
  const UNREAD_ROOT = 'tsconfig.declarations.json';
  const UNREAD_NESTED = 'pkg/tsconfig.build.json';
  const runWith = (proofs: Map<string, Proof>, drift: Set<string>, read: ReadonlySet<string> | null = READ) =>
    selectReusablePasses({
      candidates: [...proofs.keys()],
      proofs,
      judgedSha: 'new',
      changedBetween: () => drift,
      runContext: CTX,
      runnerIdentity: RUNNER,
      toolchainTsconfigs: read,
    });

  it('narrows only tsconfig/jsconfig files outside the set, never an entry name, and nothing without a set', () => {
    expect(tsconfigUnreadByToolchain(UNREAD_ROOT, READ)).toBe(true);
    expect(tsconfigUnreadByToolchain(UNREAD_NESTED, READ)).toBe(true);
    expect(tsconfigUnreadByToolchain('pkg/jsconfig.app.json', READ)).toBe(true);
    expect(tsconfigUnreadByToolchain('tsconfig.base.json', READ)).toBe(false);
    // tsconfig.json / jsconfig.json are entry points by name: a deleted one is absent from the
    // judged-tree set yet changed what the toolchain read, so it is never narrowed.
    expect(tsconfigUnreadByToolchain('pkg/gone/tsconfig.json', READ)).toBe(false);
    expect(tsconfigUnreadByToolchain('pkg/gone/jsconfig.json', READ)).toBe(false);
    expect(tsconfigUnreadByToolchain('pkg/src/a.ts', READ)).toBe(false);
    expect(tsconfigUnreadByToolchain(UNREAD_ROOT, null)).toBe(false);
  });

  it('keeps a read root tsconfig global and an unread one not, and every root tsconfig global without a set', () => {
    expect(isGlobalRunnerInput(UNREAD_ROOT, null, READ)).toBe(false);
    expect(isGlobalRunnerInput('tsconfig.base.json', null, READ)).toBe(true);
    expect(isGlobalRunnerInput('tsconfig.json', null, READ)).toBe(true);
    expect(isGlobalRunnerInput(UNREAD_ROOT)).toBe(true);
    expect(isGlobalRunnerInput(UNREAD_ROOT, null, null)).toBe(true);
  });

  it('reuses every proof across an unread root tsconfig change, unless the proof read the file itself', () => {
    const plain = 'pkg/src/plain.test.ts';
    const reader = 'pkg/src/reader.test.ts';
    const proofs = new Map([
      [plain, proof(plain)],
      [reader, proof(reader, { readPaths: [UNREAD_ROOT] })],
    ]);
    const r = runWith(proofs, new Set([UNREAD_ROOT]));
    expect(r.skip).toEqual([plain]);
    expect(r.summary).toMatchObject({ reused: 1, inputChanged: 1, globalInput: 0, tsconfigNarrowed: 1 });
    // Without the set the same drift discards both (the pre-P-004 rule).
    expect(runWith(proofs, new Set([UNREAD_ROOT]), null).summary).toMatchObject({ reused: 0, globalInput: 2 });
  });

  it('still discards every proof for a read root tsconfig change', () => {
    const r = runWith(new Map([[T, proof(T)]]), new Set(['tsconfig.base.json']));
    expect(r.summary).toMatchObject({ reused: 0, globalInput: 1, tsconfigNarrowed: 0 });
  });

  it('exempts an unread nested tsconfig from the ancestor-directory rule, but not a read one', () => {
    const under = 'pkg/src/under.test.ts';
    const proofs = new Map([[under, proof(under, { executedModules: [under, 'pkg/src/a.ts'] })]]);
    const unread = runWith(proofs, new Set([UNREAD_NESTED]));
    expect(unread.summary).toMatchObject({ reused: 1, inputChanged: 0, tsconfigNarrowed: 1 });
    expect(runWith(proofs, new Set(['pkg/tsconfig.lib.json'])).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    // A deleted (or any) tsconfig.json beneath which the proof ran always invalidates it.
    expect(runWith(proofs, new Set(['pkg/tsconfig.json'])).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    // Without the set the unread config is an ancestor config like any other.
    expect(runWith(proofs, new Set([UNREAD_NESTED]), null).summary).toMatchObject({ reused: 0, inputChanged: 1 });
  });

  it('counts a proof as narrowed only when the narrowed path is what it survived', () => {
    const r = runWith(new Map([[T, proof(T)]]), new Set([UNREAD_ROOT, 'pkg/src/a.ts']));
    expect(r.summary).toMatchObject({ reused: 0, inputChanged: 1, tsconfigNarrowed: 0 });
  });

  it('does not apply the capped-record guard to a tsconfig narrowing (it is matched against readPaths, not modules)', () => {
    const capped = Array.from({ length: EXECUTED_SOURCE_MAP_IMPORT_LIMIT }, (_, i) => `pkg/src/m${i}.ts`);
    const proofs = new Map([[T, proof(T, { executedModules: [T, ...capped] })]]);
    expect(runWith(proofs, new Set([UNREAD_ROOT])).summary).toMatchObject({ reused: 1, opaque: 0 });
  });
});

describe('P-005: a lockfile edit that installs nothing different is not global', () => {
  const lock = (over: { packages?: Record<string, unknown>; top?: Record<string, unknown> } = {}) =>
    JSON.stringify({
      name: 'root',
      version: '0.0.1',
      lockfileVersion: 3,
      requires: true,
      ...over.top,
      packages: over.packages ?? {
        '': { name: 'root', workspaces: ['packages/*'], devDependencies: { vitest: '4.0.0' } },
        'packages/a': { name: '@x/a', version: '1.0.0', dependencies: { zod: '^3.0.0' } },
        'node_modules/@x/a': { resolved: 'packages/a', link: true },
        'node_modules/zod': { version: '3.1.0', resolved: 'https://r/zod-3.1.0.tgz', integrity: 'sha512-z' },
        'packages/a/node_modules/kleur': { version: '4.0.0', integrity: 'sha512-k' },
      },
    });
  const base = JSON.parse(lock()) as { packages: Record<string, Record<string, unknown>> };
  const withPackages = (edit: (p: Record<string, Record<string, unknown>>) => void) => {
    const p = structuredClone(base.packages);
    edit(p);
    return lock({ packages: p });
  };

  it('treats workspace-entry-only edits and key reordering as inert', () => {
    // A workspace declares a dependency that is already installed, and bumps its own version.
    const declared = withPackages((p) => {
      p['packages/a'] = { ...p['packages/a'], version: '1.1.0', dependencies: { zod: '^3.0.0', kleur: '^4.0.0' } };
    });
    expect(packageLockChangeIsInert(lock(), declared)).toBe(true);
    // The root entry's declarations mirror the root package.json (judged on its own, P-002).
    const rootDeclared = withPackages((p) => {
      p[''] = { ...p[''], devDependencies: { vitest: '4.0.0', zod: '^3.0.0' } };
    });
    expect(packageLockChangeIsInert(lock(), rootDeclared)).toBe(true);
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(lock()) as Record<string, unknown>).reverse()));
    expect(reordered).not.toBe(lock());
    expect(packageLockChangeIsInert(lock(), reordered)).toBe(true);
  });

  it('keeps every installed-tree change global, at any depth', () => {
    const changes: Array<[string, string]> = [
      ['version bump', withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], version: '3.2.0' }))],
      ['integrity only', withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], integrity: 'sha512-y' }))],
      ['nested copy', withPackages((p) => void (p['packages/a/node_modules/kleur'] = { version: '4.1.0' }))],
      // A brand-new package can still change behaviour through an optional require probe.
      ['new package', withPackages((p) => void (p['node_modules/bufferutil'] = { version: '4.0.8' }))],
      ['removed package', withPackages((p) => void delete p['packages/a/node_modules/kleur'])],
      ['hoisting move', withPackages((p) => {
        p['node_modules/kleur'] = p['packages/a/node_modules/kleur']!;
        delete p['packages/a/node_modules/kleur'];
      })],
      ['workspace link retarget', withPackages((p) => void (p['node_modules/@x/a'] = { resolved: 'packages/b', link: true }))],
      // The two workspace-entry fields that act at install time.
      ['workspace install script', withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], hasInstallScript: true }))],
      ['workspace bin', withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], bin: { a: 'cli.js' } }))],
      ['lockfile version', lock({ top: { lockfileVersion: 2 } })],
    ];
    for (const [label, after] of changes) {
      expect(after, label).not.toBe(lock());
      expect(packageLockChangeIsInert(lock(), after), label).toBe(false);
    }
  });

  it('fails closed on anything it cannot judge', () => {
    expect(packageLockChangeIsInert(lock(), '{ not json')).toBe(false);
    expect(packageLockChangeIsInert('[]', '[]')).toBe(false);
    expect(packageLockChangeIsInert('null', 'null')).toBe(false);
    expect(packageLockChangeIsInert('{}', '{}')).toBe(false);
    expect(packageLockInstallView(JSON.stringify({ packages: { 'packages/a': 'x' } }))).toBeNull();
    // Calibration: the same text judges inert, so the lines above are not vacuous.
    expect(packageLockChangeIsInert(lock(), lock())).toBe(true);
  });

  it('gitInertGlobalChange judges the lockfile by install view, reading each sha once', () => {
    const texts: Record<string, string> = {
      'old:package-lock.json': lock(),
      'ws:package-lock.json': withPackages((p) => void (p['packages/a'] = { ...p['packages/a'], version: '2.0.0' })),
      'bump:package-lock.json': withPackages((p) => void (p['node_modules/zod'] = { ...p['node_modules/zod'], version: '3.9.0' })),
    };
    const calls: string[] = [];
    const exec = (_file: string, args: string[]) => {
      calls.push(args[1]!);
      const t = texts[args[1]!];
      if (t === undefined) throw new Error(`fatal: invalid object name ${args[1]}`);
      return t;
    };
    const seam = gitInertGlobalChange({ repoRoot: '/repo', exec });
    expect(seam('package-lock.json', 'old', 'ws')).toBe(true);
    expect(seam('package-lock.json', 'bump', 'ws')).toBe(false);
    expect(seam('package-lock.json', 'gone', 'ws')).toBe(false);
    // The judged sha ('ws') is shared by every proof; its 1 MB lockfile is read once.
    expect(calls.filter((c) => c === 'ws:package-lock.json')).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('reuses a proof across an inert lockfile change, unless the proof read the lockfile', () => {
    const T = 'packages/a/src/x.test.ts';
    const prf = (readPaths: string[] = []) => ({
      recordedSha: 'old',
      recordedAtMs: 1_000,
      executedModules: [T, 'packages/a/src/x.ts'],
      readPaths,
      inputsCaptured: true,
      opaqueReasons: [],
      runContext: 'green-checkpoint',
      runnerIdentity: 'id',
    });
    const run = (p: ReturnType<typeof prf>, inert: boolean) =>
      selectReusablePasses({
        candidates: [T],
        proofs: new Map([[T, p]]),
        judgedSha: 'new',
        changedBetween: () => new Set(['package-lock.json']),
        runContext: 'green-checkpoint',
        runnerIdentity: 'id',
        inertGlobalChange: (rel: string) => inert && rel === 'package-lock.json',
      });
    expect(run(prf(), true).skip).toEqual([T]);
    expect(run(prf(), true).summary).toMatchObject({ reused: 1, globalInput: 0, inertGlobal: 1 });
    expect(run(prf(['package-lock.json']), true).summary).toMatchObject({ reused: 0, inputChanged: 1 });
    // Calibration: the same drift without the inert verdict is a global discard.
    expect(run(prf(), false).summary).toMatchObject({ reused: 0, globalInput: 1 });
  });
});

describe('env toggles and the report line', () => {
  it('is ON by default and OFF for the documented values', () => {
    expect(testReuseEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) expect(testReuseEnabled({ AFFECTED_TEST_REUSE: v })).toBe(false);
  });

  it('prints every counter on one greppable line', () => {
    const r = run([T], new Map([[T, proof(T)]]), new Set());
    const line = formatTestReuseLine('@papercusp/x', r.summary);
    expect(line).toMatch(/^TEST_PASS_REUSE ws=@papercusp\/x candidates=1 reused=1 /);
    expect(line).toMatch(
      / audited=0 inertGlobal=0 testConfigNarrowed=0 tsconfigNarrowed=0 inertWorkspaceConfig=0 schemaNarrowed=0$/,
    );
    // D-009: the workspace-manifest narrowing is visible in the gate log, not only in the summary object.
    expect(formatTestReuseLine('@papercusp/x', { ...r.summary, inertWorkspaceConfig: 3 })).toMatch(/ inertWorkspaceConfig=3 /);
  });

  it('reads the P-012 audit rate: 5% by default, clamped to [0,1], garbage falls back', () => {
    expect(TEST_REUSE_AUDIT_RATE_DEFAULT).toBe(0.05);
    expect(testReuseAuditRate({})).toBe(0.05);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: ' ' })).toBe(0.05);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '0' })).toBe(0);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '0.2' })).toBe(0.2);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '7' })).toBe(1);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: '-1' })).toBe(0);
    expect(testReuseAuditRate({ AFFECTED_TEST_REUSE_AUDIT_RATE: 'lots' })).toBe(0.05);
  });
});

/**
 * P-012 soundness backstop. A proof never expires (owner #2143); instead a deterministic sample of
 * reusable files runs anyway, and a failure among the files reuse WOULD have skipped is an alarm.
 */
describe('P-012 audit sample (no proof age limit)', () => {
  const runWith = (
    files: string[],
    proofs: Map<string, Proof>,
    drift: Set<string> | null,
    over: { auditRate?: number; changedBetween?: () => Set<string> | null } = {},
  ) =>
    selectReusablePasses({
      candidates: files,
      proofs,
      judgedSha: 'new',
      changedBetween: over.changedBetween ?? (() => drift),
      runContext: CTX,
      runnerIdentity: RUNNER,
      auditRate: over.auditRate,
    });

  it('auditDraw is deterministic per (file, sha), in [0,1), and rotates with the sha', () => {
    expect(auditDraw(T, 'sha1')).toBe(auditDraw(T, 'sha1'));
    const draws = Array.from({ length: 50 }, (_, i) => auditDraw(T, `sha${i}`));
    for (const d of draws) expect(d >= 0 && d < 1).toBe(true);
    expect(new Set(draws).size).toBe(50);
  });

  it('samples roughly auditRate of the reusable files', () => {
    const files = Array.from({ length: 2000 }, (_, i) => `pkg/src/f${i}.test.ts`);
    const proofs = new Map(files.map((f) => [f, proof(f)]));
    const r = runWith(files, proofs, new Set(), { auditRate: 0.05 });
    expect(r.summary.audited + r.summary.reused).toBe(2000);
    expect(r.summary.audited).toBeGreaterThan(60);
    expect(r.summary.audited).toBeLessThan(140);
    expect(r.watch.size).toBe(r.summary.audited);
    for (const [f, why] of r.watch) {
      expect(why).toBe('audit');
      expect(r.skip).not.toContain(f);
    }
  });

  it('an audited file RUNS (not skipped) and is watched', () => {
    const r = runWith([T], new Map([[T, proof(T)]]), new Set(), { auditRate: 1 });
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ reused: 0, audited: 1 });
    expect([...r.watch]).toEqual([[T, 'audit']]);
  });

  it('auditRate 0 (the pure-rule default) audits nothing', () => {
    const r = runWith([T], new Map([[T, proof(T)]]), new Set());
    expect(r.skip).toEqual([T]);
    expect(r.watch.size).toBe(0);
  });

  it('owner #2143: a clean proof is reused however old it is, and its sha is still diffed', () => {
    for (const ageMs of [25 * 3600_000, 49 * 3600_000, 400 * 24 * 3600_000]) {
      let diffs = 0;
      const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - ageMs })]]), null, {
        changedBetween: () => {
          diffs += 1;
          return new Set();
        },
      });
      expect(diffs).toBe(1);
      expect(r.skip).toEqual([T]);
      expect(r.summary).toMatchObject({ reused: 1, audited: 0 });
      expect(r.summary).not.toHaveProperty('expired');
      expect(r.summary).not.toHaveProperty('expiredClean');
    }
  });

  it('an old proof whose inputs drifted still runs (drift, not age, invalidates)', () => {
    const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: NOW - 49 * 3600_000 })]]), new Set(['pkg/src/a.ts']));
    expect(r.skip).toEqual([]);
    expect(r.summary).toMatchObject({ reused: 0, inputChanged: 1 });
    expect(r.watch.size).toBe(0);
  });

  it('an unreadable recorded_at does not block reuse: the rule never reads proof age', () => {
    const r = runWith([T], new Map([[T, proof(T, { recordedAtMs: Number.NaN })]]), new Set());
    expect(r.skip).toEqual([T]);
  });
});

describe('reuseSoundnessAlarms', () => {
  const watch = new Map<string, 'audit'>([
    ['packages/x/lib/a.test.ts', 'audit'],
    ['packages/x/lib/b.test.ts', 'audit'],
  ]);

  it('maps runner-printed (workspace-relative) failures onto the watched repo-relative files', () => {
    expect(
      reuseSoundnessAlarms({
        failedFiles: ['lib/b.test.ts', './lib/a.test.ts', 'lib/c.test.ts', 'lib/a.test.ts'],
        watch,
        prefix: 'packages/x/',
      }),
    ).toEqual([
      { file: 'packages/x/lib/a.test.ts', reason: 'audit' },
      { file: 'packages/x/lib/b.test.ts', reason: 'audit' },
    ]);
  });

  it('accepts a failure already printed repo-relative', () => {
    expect(reuseSoundnessAlarms({ failedFiles: ['packages/x/lib/a.test.ts'], watch, prefix: 'packages/x/' })).toEqual([
      { file: 'packages/x/lib/a.test.ts', reason: 'audit' },
    ]);
  });

  it('is empty when nothing watched failed, or there is nothing to watch', () => {
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/c.test.ts'], watch, prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/a.test.ts'], watch: new Map(), prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: ['lib/a.test.ts'], watch: undefined, prefix: 'packages/x/' })).toEqual([]);
    expect(reuseSoundnessAlarms({ failedFiles: null, watch, prefix: 'packages/x/' })).toEqual([]);
  });

  it('estimates the saved test time as a lower bound over measured files (P-013)', () => {
    const durations = new Map([
      ['a', 1000],
      ['b', 250.4],
    ]);
    expect(estimateReuseSavings(['a', 'b', 'c'], durations)).toEqual({ savedMs: 1250, measured: 2, unmeasured: 1 });
    expect(estimateReuseSavings([], durations)).toEqual({ savedMs: 0, measured: 0, unmeasured: 0 });
  });

  it('rolls every armed task into one TOTAL line, and says "unknown" when a duration read failed', () => {
    const s1 = run([T], new Map([[T, proof(T)]]), new Set()).summary;
    const s2 = { ...s1, candidates: 3, reused: 1, audited: 2 };
    expect(formatTestReuseTotalLine({ tasks: 2, summaries: [s1, s2], savedMs: 4200, unmeasured: 1 })).toBe(
      'TEST_PASS_REUSE_TOTAL tasks=2 candidates=4 reused=2 audited=2 minSavedTestMs=4200 unmeasured=1',
    );
    expect(formatTestReuseTotalLine({ tasks: 1, summaries: [s1], savedMs: null, unmeasured: 0 })).toMatch(
      / minSavedTestMs=unknown /,
    );
  });

  it('formats one greppable alarm line per file', () => {
    expect(formatReuseAlarmLine('@papercusp/x::test', { file: 'packages/x/lib/a.test.ts', reason: 'audit' })).toMatch(
      /^TEST_PASS_REUSE_ALARM ws=@papercusp\/x::test file=packages\/x\/lib\/a\.test\.ts proof=audit — /,
    );
  });
});

describe('reuseCandidates', () => {
  it('uses a narrowed selection, re-anchored repo-relative', () => {
    expect(
      reuseCandidates({ wsRel: 'packages/x', relatedFiles: ['lib/a.test.ts', './lib/b.test.ts'], proofFiles: [] }),
    ).toEqual(['packages/x/lib/a.test.ts', 'packages/x/lib/b.test.ts']);
  });

  it('falls back to every proof under the workspace for an un-narrowed task', () => {
    const proofFiles = ['packages/x/lib/a.test.ts', 'packages/xy/lib/c.test.ts', 'packages/y/lib/b.test.ts'];
    expect(reuseCandidates({ wsRel: 'packages/x', relatedFiles: undefined, proofFiles })).toEqual([
      'packages/x/lib/a.test.ts',
    ]);
    expect(reuseCandidates({ wsRel: 'packages/x', relatedFiles: [], proofFiles })).toEqual([
      'packages/x/lib/a.test.ts',
    ]);
    // The repo-root workspace owns every path.
    expect(reuseCandidates({ wsRel: '', relatedFiles: null, proofFiles })).toEqual(proofFiles);
  });
});

// WI-10004617: both lane tasks receive the same lane-agnostic selection, so the other lane's
// files were counted as candidates. Pure-lane files never record a proof (isolate:false), which
// made ~1.9k of them read as lane-stateful `noProof` on the 599dbeeb gate run.
describe('lane-scoped reuse candidates (WI-10004617)', () => {
  it('maps only the two lane scripts to a lane', () => {
    expect(laneOfTaskScript('test:lane-pure')).toBe('pure');
    expect(laneOfTaskScript('test:lane-stateful')).toBe('stateful');
    expect(laneOfTaskScript('test')).toBeNull();
    expect(laneOfTaskScript('test:lane-stateful-extra')).toBeNull();
    expect(laneOfTaskScript('test:integration')).toBeNull();
  });

  it("keeps only the task's own lane and counts the rest", () => {
    const lanes: Record<string, 'pure' | 'stateful' | null> = {
      'lib/a.test.ts': 'stateful',
      'lib/b.test.ts': 'pure',
      'lib/c.test.ts': 'pure',
      'lib/d.integration.test.ts': null,
    };
    const candidates = Object.keys(lanes).map((f) => `packages/x/${f}`);
    const laneOf = (rel: string) => lanes[rel] ?? null;
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: 'stateful', laneOf })).toEqual({
      candidates: ['packages/x/lib/a.test.ts'],
      otherLane: 3,
    });
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: 'pure', laneOf })).toEqual({
      candidates: ['packages/x/lib/b.test.ts', 'packages/x/lib/c.test.ts'],
      otherLane: 2,
    });
  });

  it('leaves an un-split task and out-of-workspace paths untouched', () => {
    const never = () => {
      throw new Error('an un-split task must not classify anything');
    };
    const candidates = ['packages/x/lib/a.test.ts'];
    expect(laneScopedCandidates({ candidates, wsRel: 'packages/x', lane: null, laneOf: never })).toEqual({
      candidates,
      otherLane: 0,
    });
    expect(
      laneScopedCandidates({ candidates: ['packages/y/lib/z.test.ts'], wsRel: 'packages/x', lane: 'stateful', laneOf: () => 'pure' }),
    ).toEqual({ candidates: ['packages/y/lib/z.test.ts'], otherLane: 0 });
  });

  it('classifies with the real lane-split rule the lane configs use', () => {
    const ws = mkdtempSync(join(tmpdir(), 'lane-scoped-reuse-'));
    try {
      mkdirSync(join(ws, 'lib'), { recursive: true });
      // Built by concatenation so THIS file's own lane classification is unchanged.
      const statefulMarker = 'vi.' + 'mock("./dep");';
      writeFileSync(join(ws, 'lib/mocked.test.ts'), `${statefulMarker}\nit("x", () => {});\n`);
      writeFileSync(join(ws, 'lib/plain.test.ts'), 'it("y", () => {});\n');
      writeFileSync(join(ws, 'lib/db.integration.test.ts'), 'it("z", () => {});\n');
      const rels = ['lib/mocked.test.ts', 'lib/plain.test.ts', 'lib/db.integration.test.ts', 'lib/gone.test.ts'];
      const laneOf = laneOfFromSplit({ classifyLanes, isUnitTestFile }, ws, rels);
      expect(laneOf('lib/mocked.test.ts')).toBe('stateful');
      expect(laneOf('lib/plain.test.ts')).toBe('pure');
      // Not a unit test file: no lane task runs it.
      expect(laneOf('lib/db.integration.test.ts')).toBeNull();
      // Unreadable is stateful in lane-split (the safe direction); mirror it.
      expect(laneOf('lib/gone.test.ts')).toBe('stateful');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// P-011: within one gate run, the selective phase (narrowed to the repair radius) and the full
// phase judge the SAME sha. A pass the selective phase recorded is therefore a zero-drift proof
// for the un-narrowed full task, so the full phase skips it instead of re-running it. This pins
// the composition: un-narrowed candidates come from the recorded proofs, and a same-sha proof is
// reused without diffing.
describe('P-011: the full phase reuses passes the selective phase recorded at the same sha', () => {
  it('skips a file the narrowed selective run passed, when the un-narrowed full task judges that sha', () => {
    const passed = 'packages/x/lib/a.test.ts';
    const proofs = new Map([[passed, proof(passed, { recordedSha: 'repair-head' })]]);
    const candidates = reuseCandidates({ wsRel: 'packages/x', relatedFiles: undefined, proofFiles: [...proofs.keys()] });
    const r = selectReusablePasses({
      candidates,
      proofs,
      judgedSha: 'repair-head',
      changedBetween: () => {
        throw new Error('a same-sha proof must not be diffed');
      },
      runContext: CTX,
      runnerIdentity: RUNNER,
    });
    expect(r.skip).toEqual([passed]);
    expect(r.summary.reused).toBe(1);
  });

  it('still runs a file whose selective-phase pass was recorded in a different run context', () => {
    const passed = 'packages/x/lib/a.test.ts';
    const proofs = new Map([[passed, proof(passed, { recordedSha: 'repair-head', runContext: 'clean-local' })]]);
    const r = selectReusablePasses({
      candidates: [passed],
      proofs,
      judgedSha: 'repair-head',
      changedBetween: () => null,
      runContext: CTX,
      runnerIdentity: RUNNER,
    });
    expect(r.skip).toEqual([]);
    expect(r.summary.otherContext).toBe(1);
  });
});

describe('skip-list channel: affected-tests writer -> vitest-config reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'reuse-skip-'));
    dirs.push(d);
    return d;
  };
  const META = { runContext: CTX, runnerIdentity: RUNNER, judgedSha: 'abc123' };

  it('writes a sorted, de-duplicated, content-addressed list the reader accepts', () => {
    const dir = tmp();
    const a = writeReuseSkipList(dir, { files: ['lib/b.test.ts', 'lib/a.test.ts', 'lib/b.test.ts'], ...META });
    const again = writeReuseSkipList(dir, { files: ['lib/a.test.ts', 'lib/b.test.ts'], ...META });
    const other = writeReuseSkipList(dir, { files: ['lib/a.test.ts'], ...META });
    expect(a.count).toBe(2);
    expect(again.path).toBe(a.path); // same content => same file (EEXIST tolerated)
    expect(other.digest).not.toBe(a.digest);
    const parsed = parseReuseSkipList(readFileSync(a.path, 'utf8'));
    expect(parsed.files).toEqual(['lib/a.test.ts', 'lib/b.test.ts']);
    expect(parsed).toMatchObject(META);
    expect(REUSE_SKIP_LIST_SCHEMA).toBe(READER_SCHEMA);
    expect(PC_TEST_PARTIAL_SKIP_LIST_ENV).toBe(READER_PARTIAL_SKIP_LIST_ENV);
  });

  it('applies only in the same run context and runner identity', () => {
    const list = parseReuseSkipList(
      readFileSync(writeReuseSkipList(tmp(), { files: ['lib/a.test.ts'], ...META }).path, 'utf8'),
    );
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER })).toEqual({
      applied: true,
      exclude: ['lib/a.test.ts'],
      skipped: 1,
    });
    expect(decideReuseSkip(list, { runContext: 'clean-local', runnerIdentity: RUNNER }).applied).toBe(false);
    expect(decideReuseSkip(list, { runContext: CTX, runnerIdentity: 'v24.0.0 linux x64' }).applied).toBe(false);
  });

  it('escapes glob metacharacters so a route-group or dynamic-segment path excludes only itself', () => {
    // Measured against tinyglobby (vitest's matcher): an UNESCAPED `app/(grp)/[id]/page.test.ts`
    // in `ignore` does not match its own file, so reuse would silently run it; escaped, it
    // excludes exactly that file and not its sibling.
    const list = parseReuseSkipList(
      readFileSync(writeReuseSkipList(tmp(), { files: ['app/(grp)/[id]/page.test.ts'], ...META }).path, 'utf8'),
    );
    const d = decideReuseSkip(list, { runContext: CTX, runnerIdentity: RUNNER });
    expect(d.applied && d.exclude).toEqual(['app/\\(grp\\)/\\[id\\]/page.test.ts']);
  });

  it('refuses a malformed or foreign-schema list (the caller then runs every file)', () => {
    expect(() => parseReuseSkipList('["lib/a.test.ts"]')).toThrow();
    expect(() => parseReuseSkipList(JSON.stringify({ schema: 2, files: [], ...META }))).toThrow();
    expect(() => parseReuseSkipList(JSON.stringify({ schema: 1, files: [''], ...META }))).toThrow();
  });
});
