/**
 * P-010 (verification-system-improvements-2026-10-10) — instrument provenance at bind time.
 *
 * Clauses pinned here (all unit layer):
 *  - AUTO-BAR-R-10-P-010 / SPEC-P-010-INSTRUMENT-DECLARED: operational|manual evidence is refused
 *    unless it cites a committed instrument + committed importing test, or declares none with a reason.
 *  - SPEC-P-010-INSTRUMENT-PROVENANCE: a registered sibling checkout with a commit pin is accepted.
 *  - SPEC-P-010-AS-COMMITTED: a run that executed in an as-committed /tmp clone is accepted — the
 *    recorded run root is never consulted, only the instrument's repo-relative path at the run commit.
 *  - SPEC-P-010-BIND-TIME-ONLY: only the bind handler imports the rule, so a re-measure / scorecard
 *    re-emit path cannot apply it to evidence bound before it landed.
 *
 * The git side is an in-memory fake keyed by (repo, commit, path), so every refusal is exercised
 * against an exact, inspectable tree rather than whatever the shared checkout holds right now.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GitRunner } from './evidence-measurement-pin';
import {
  INSTRUMENT_EVIDENCE_KINDS,
  INSTRUMENT_REFUSAL_CODES,
  instrumentProvenanceRefusal,
  isScriptPathToken,
  testReferencesInstrument,
  type InstrumentProvenanceDeps,
  type InstrumentRefusalCode,
} from './instrument-provenance';

const ROOT = '/repo';
const SUBMODULE = '/repo/libs/papercusp';
const SIBLING = '/work/sibling-harness';

/** repo → commit → repo-relative path → file body. */
type Tree = Record<string, Record<string, Record<string, string>>>;

function fakeGit(tree: Tree): { git: GitRunner; cwds: string[] } {
  const cwds: string[] = [];
  const repos = Object.keys(tree).sort((a, b) => b.length - a.length);
  const blob = (cwd: string, spec: string): string | undefined => {
    const at = spec.indexOf(':');
    return tree[cwd]?.[spec.slice(0, at)]?.[spec.slice(at + 1)];
  };
  const git: GitRunner = async (cwd, args) => {
    cwds.push(cwd);
    const [verb, ...rest] = args;
    if (verb === 'rev-parse' && rest[0] === '--show-toplevel') {
      const top = repos.find((repo) => cwd === repo || cwd.startsWith(`${repo}/`));
      if (!top) throw new Error(`fatal: not a git repository: ${cwd}`);
      return `${top}\n`;
    }
    if (verb === 'cat-file' && rest[0] === '-e') {
      if (blob(cwd, rest[1]!) === undefined) throw new Error(`fatal: path does not exist: ${rest[1]}`);
      return '';
    }
    if (verb === 'show') {
      const body = blob(cwd, rest[0]!);
      if (body === undefined) throw new Error(`fatal: invalid object name ${rest[0]}`);
      return body;
    }
    throw new Error(`fake git: unsupported ${args.join(' ')}`);
  };
  return { git, cwds };
}

function deps(tree: Tree, registered: Record<string, string> = {}): InstrumentProvenanceDeps & { cwds: string[] } {
  const { git, cwds } = fakeGit(tree);
  return {
    git,
    cwds,
    primaryRoot: async () => ROOT,
    checkoutRoot: async (checkout) => registered[checkout] ?? null,
  };
}

const INSTRUMENT = 'packages/bench/lib/recall.ts';
const INSTRUMENT_TEST = 'packages/bench/lib/recall.test.ts';
const IMPORTING_TEST = `import { recallAt1 } from './recall';\nit('counts misses', () => expect(recallAt1([])).toBe(0));\n`;

/** A primary-checkout tree where the instrument and its importing test are committed at HEAD. */
const committedTree = (extra: Record<string, string> = {}): Tree => ({
  [ROOT]: { HEAD: { [INSTRUMENT]: 'export const recallAt1 = () => 0;', [INSTRUMENT_TEST]: IMPORTING_TEST, ...extra } },
});

const operational = (instrument: unknown, extraDetails: Record<string, unknown> = {}) => ({
  evidenceKind: 'operational',
  details: instrument === undefined ? { ...extraDetails } : { instrument, ...extraDetails },
});

async function refusalCode(
  binding: { evidenceKind: string; details?: Record<string, unknown> },
  d: InstrumentProvenanceDeps,
  asCommitted?: { commitSha: string; repoPrefix: string | null },
): Promise<InstrumentRefusalCode | null> {
  return (await instrumentProvenanceRefusal(binding, asCommitted, d))?.error ?? null;
}

/** Every code a case below provokes — compared against INSTRUMENT_REFUSAL_CODES at the end. */
const provoked = new Set<InstrumentRefusalCode>();
async function expectRefused(
  code: InstrumentRefusalCode,
  binding: { evidenceKind: string; details?: Record<string, unknown> },
  d: InstrumentProvenanceDeps,
  asCommitted?: { commitSha: string; repoPrefix: string | null },
) {
  const refusal = await instrumentProvenanceRefusal(binding, asCommitted, d);
  expect(refusal?.error).toBe(code);
  expect(refusal?.reason.length).toBeGreaterThan(20);
  provoked.add(code);
  return refusal!;
}

describe('instrument provenance — scope', () => {
  it('applies to exactly the measurement kinds operational and manual', () => {
    expect([...INSTRUMENT_EVIDENCE_KINDS].sort()).toEqual(['manual', 'operational']);
  });

  it('never consults git or the registry for executable-proof kinds', async () => {
    const throwing: InstrumentProvenanceDeps = {
      git: async () => {
        throw new Error('must not run git');
      },
      primaryRoot: async () => {
        throw new Error('must not resolve a root');
      },
      checkoutRoot: async () => {
        throw new Error('must not resolve a checkout');
      },
    };
    for (const evidenceKind of ['test', 'mutation', 'counterexample', 'check', 'tree']) {
      expect(await refusalCode({ evidenceKind, details: {} }, throwing)).toBeNull();
    }
  });
});

describe('instrument provenance — declaration (SPEC-P-010-INSTRUMENT-DECLARED)', () => {
  it('refuses operational and manual evidence that neither cites an instrument nor declares none', async () => {
    const d = deps(committedTree());
    for (const evidenceKind of ['operational', 'manual']) {
      await expectRefused('instrument_undeclared', { evidenceKind, details: {} }, d);
      await expectRefused('instrument_undeclared', { evidenceKind }, d);
    }
    for (const malformed of [null, 'scripts/measure.sh', ['a', 'b'], 42]) {
      await expectRefused('instrument_undeclared', operational(malformed), d);
    }
  });

  it('accepts a no-instrument declaration only with a non-empty reason and no cited path', async () => {
    const d = deps(committedTree());
    expect(await refusalCode(operational({ none: true, reason: 'observed the UI by hand; no program measured it' }), d)).toBeNull();
    expect(
      await refusalCode({ evidenceKind: 'manual', details: { instrument: { none: true, reason: 'read the log line' } } }, d),
    ).toBeNull();
    await expectRefused('instrument_undeclared', operational({ none: true }), d);
    await expectRefused('instrument_undeclared', operational({ none: true, reason: '   ' }), d);
    await expectRefused('instrument_undeclared', operational({ none: true, reason: 'x', path: INSTRUMENT }), d);
  });

  // R-10 drift marker (4): a no-instrument declaration whose evidence record names a script path,
  // a run id or captured output is refused — the record says a program measured it.
  const NONE = { none: true, reason: 'observed it by hand; no program measured it' };
  const noneBinding = (extra: { evidenceRef?: string; testRunId?: number | null; details?: Record<string, unknown> }) => ({
    evidenceKind: 'manual',
    ...extra,
    details: { instrument: NONE, ...(extra.details ?? {}) },
  });

  it('refuses a no-instrument declaration whose evidence record names a script path (R-10 marker 4)', async () => {
    const d = deps(committedTree());
    for (const evidenceRef of [
      'scripts/measure-recall.sh',
      '.papercusp/scratch/verif/probe.mts',
      '/tmp/census.py',
      'ran ~/bin/count.sh by hand',
      'docs/evidence/census.sql',
      'packages/bench/lib/recall.test.ts',
      'tools/measure/report.js',
    ]) {
      const refusal = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef }), d);
      expect(refusal.reason).toContain('script path');
    }
    for (const details of [
      { note: 'numbers from scripts/recall.ts' },
      { probe: { command: 'bash .papercusp/scratch/census.sh' } },
      { steps: ['opened the dashboard', 'ran /tmp/x.mjs'] },
    ]) {
      const refusal = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef: 'docs/evidence/live.json', details }), d);
      expect(refusal.reason).toContain('script path');
    }
  });

  it('refuses a no-instrument declaration whose evidence record names a run id (R-10 marker 4)', async () => {
    const d = deps(committedTree());
    const run = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef: 'docs/evidence/live.json', testRunId: 21057568 }), d);
    expect(run.reason).toContain('testRunId 21057568');
    for (const evidenceRef of ['test-run 21057568', 'testRunId=21057568', 'run id 9001', 'run #12', 'testing:run 21057568']) {
      const refusal = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef }), d);
      expect(refusal.reason).toContain('run id');
    }
    for (const details of [
      { runId: 'rg-2026-10-11' },
      { testRun: { id: 21057568, status: 'pass' } },
      { test_run_id: 21057568 },
      { probe: { runGroupId: 'g-1' } },
      { note: 'bound from test-run 21057568' },
    ]) {
      const refusal = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef: 'docs/evidence/live.json', details }), d);
      expect(refusal.reason).toContain('run id');
    }
  });

  it('refuses a no-instrument declaration whose evidence record carries captured output (R-10 marker 4)', async () => {
    const d = deps(committedTree());
    for (const details of [
      { capturedOutput: 'recall@1 = 0.91' },
      { stdout: 'PASS 12/12' },
      { stderr: ['warn: 3 rows dropped'] },
      { outputTail: 'ok' },
      { observation: { log: 'line 1\nline 2' } },
    ]) {
      const refusal = await expectRefused('instrument_undeclared', noneBinding({ evidenceRef: 'docs/evidence/live.json', details }), d);
      expect(refusal.reason).toContain('captured output');
    }
  });

  it('keeps accepting an honest no-instrument observation: the shapes live bindings use (calibration)', async () => {
    const d = deps(committedTree());
    // Each evidenceRef/details shape below is copied from a live none:true binding (2026-10-11).
    for (const binding of [
      noneBinding({ evidenceRef: 'docs/evidence/scope-unique-identifiers-2026-07-26-live.json', details: { note: 'census of 4 tables', observedVia: 'dev:pg_query' } }),
      noneBinding({ evidenceRef: 'live:hono-host:3170 plans:verification-health @a5827f2d5b 2026-10-11T10:02:23.428Z health.valBlockPlans=0' }),
      noneBinding({ evidenceRef: 'work_items:get:WI-6554700010008355/comment:WI-6554700010008355' }),
      noneBinding({ evidenceRef: 'scorecard:EI-25451551833415468; thread-post:1166188; thread-post:1166250' }),
      noneBinding({
        evidenceRef: 'work-item:WI-10007399; report:rpt_7a95e432-7f4c-4a35-982c-fe4e1ef7e2e1; lifecycle-observation:2026-10-11T04:27Z',
        details: { previousObservationBindingId: 36313, observationRuntime: { build: 'a5827f2d5b' } },
      }),
      noneBinding({ evidenceRef: 'read packages/operator-core/lib/verification-health.ts by hand; Node.js runtime, run 2 of 3' }),
      noneBinding({ testRunId: null, evidenceRef: 'observed the UI by hand' }),
      // Server-stamped measurement keys and adequacy metadata are not part of the observation.
      noneBinding({
        evidenceRef: 'docs/evidence/live.json',
        details: {
          measurementPin: { files: ['scripts/x.sh'] },
          currentMeasurement: { sourcePaths: ['scripts/x.sh'] },
          declaredConfiguration: { testRunId: 1 },
        },
      }),
    ]) {
      expect(await refusalCode(binding, d), JSON.stringify(binding)).toBeNull();
    }
  });

  it('classifies script-path tokens at their documented boundary', () => {
    for (const script of ['scripts/a.ts', 'x/scripts/b', '/tmp/a', '~/a', '.papercusp/scratch/p.ts', 'a.sh', 'a.py', 'a.mjs', 'q.sql', 'a.test.ts', 'b.spec.tsx', 'lib/a.js', 'scripts/a.sh:12', 'a.sh.']) {
      expect(isScriptPathToken(script), script).toBe(true);
    }
    for (const notScript of ['Node.js', 'docs/evidence/x.json', 'lib/foo.ts', 'plans:verification-health', '@a5827f2d5b', 'thread-post:1166188', 'scriptsfoo/a.ts', '']) {
      expect(isScriptPathToken(notScript), notScript).toBe(false);
    }
  });

  it('refuses a citation missing either the instrument path or its test', async () => {
    const d = deps(committedTree());
    await expectRefused('instrument_undeclared', operational({ path: INSTRUMENT }), d);
    await expectRefused('instrument_undeclared', operational({ testPath: INSTRUMENT_TEST }), d);
    await expectRefused('instrument_undeclared', operational({ path: '', testPath: INSTRUMENT_TEST }), d);
  });
});

describe('instrument provenance — committed + tested instrument (AUTO-BAR-R-10-P-010)', () => {
  it('accepts a committed instrument whose committed test imports it', async () => {
    const d = deps(committedTree());
    expect(await refusalCode(operational({ path: INSTRUMENT, testPath: INSTRUMENT_TEST }), d)).toBeNull();
  });

  it('refuses /tmp, home, absolute and ../ instruments as outside the repository', async () => {
    const d = deps(committedTree());
    for (const path of ['/tmp/probe.ts', '~/probe.ts', '/home/me/probe.ts', '../other-repo/probe.ts', 'lib/../../escape.ts', 'C:\\probe.ts']) {
      await expectRefused('instrument_outside_repo', operational({ path, testPath: INSTRUMENT_TEST }), d);
    }
    await expectRefused('instrument_outside_repo', operational({ path: INSTRUMENT, testPath: '/tmp/probe.test.ts' }), d);
  });

  it('refuses a .papercusp/scratch probe as the instrument or as its test', async () => {
    const d = deps(committedTree({ '.papercusp/scratch/probe.mts': 'x', '.papercusp/scratch/probe.test.ts': 'x' }));
    await expectRefused('instrument_scratch_probe', operational({ path: '.papercusp/scratch/probe.mts', testPath: INSTRUMENT_TEST }), d);
    await expectRefused('instrument_scratch_probe', operational({ path: './.papercusp/scratch/probe.mts', testPath: INSTRUMENT_TEST }), d);
    await expectRefused('instrument_scratch_probe', operational({ path: INSTRUMENT, testPath: '.papercusp/scratch/probe.test.ts' }), d);
  });

  it('refuses an untracked instrument or test (no blob at the bound commit)', async () => {
    await expectRefused(
      'instrument_not_committed',
      operational({ path: INSTRUMENT, testPath: INSTRUMENT_TEST }),
      deps({ [ROOT]: { HEAD: { [INSTRUMENT_TEST]: IMPORTING_TEST } } }),
    );
    const refusal = await expectRefused(
      'instrument_not_committed',
      operational({ path: INSTRUMENT, testPath: INSTRUMENT_TEST }),
      deps({ [ROOT]: { HEAD: { [INSTRUMENT]: 'export const recallAt1 = () => 0;' } } }),
    );
    expect(refusal.reason).toContain(INSTRUMENT_TEST);
  });

  it('refuses a committed test that does not import the instrument', async () => {
    const d = deps(committedTree({ 'packages/bench/lib/other.test.ts': "import { x } from './other';\n" }));
    await expectRefused('instrument_test_not_importing', operational({ path: INSTRUMENT, testPath: 'packages/bench/lib/other.test.ts' }), d);
  });

  it('accepts path === testPath only when it is itself a test file', async () => {
    const d = deps(committedTree({ 'scripts/measure.sh': 'echo 1' }));
    expect(await refusalCode(operational({ path: INSTRUMENT_TEST, testPath: INSTRUMENT_TEST }), d)).toBeNull();
    await expectRefused('instrument_test_not_importing', operational({ path: 'scripts/measure.sh', testPath: 'scripts/measure.sh' }), d);
  });

  it('resolves an instrument inside a submodule against the submodule, and refuses a test in another repository', async () => {
    const inSub = 'libs/papercusp/libs/db/measure.ts';
    const subTest = 'libs/papercusp/libs/db/measure.test.ts';
    const tree: Tree = {
      [ROOT]: { HEAD: { [INSTRUMENT_TEST]: IMPORTING_TEST } },
      [SUBMODULE]: { HEAD: { 'libs/db/measure.ts': 'x', 'libs/db/measure.test.ts': "import './measure';\n" } },
    };
    expect(await refusalCode(operational({ path: inSub, testPath: subTest }), deps(tree))).toBeNull();
    await expectRefused('instrument_test_not_importing', operational({ path: inSub, testPath: INSTRUMENT_TEST }), deps(tree));
  });
});

describe('instrument provenance — registered sibling checkout (SPEC-P-010-INSTRUMENT-PROVENANCE)', () => {
  const pin = 'a1b2c3d4e5f6';
  const siblingTree: Tree = {
    [ROOT]: { HEAD: {} },
    // The blobs exist ONLY at the pin: a sibling HEAD lookup would refuse, so acceptance proves the pin was used.
    [SIBLING]: { [pin]: { 'lib/score.ts': 'export const score = 1;', 'lib/score.test.ts': "import { score } from './score';\n" } },
  };
  const cite = (extra: Record<string, unknown>) => operational({ path: 'lib/score.ts', testPath: 'lib/score.test.ts', ...extra });

  it('accepts a committed, tested instrument in a registered sibling checkout carrying a commit pin', async () => {
    const d = deps(siblingTree, { sibling: SIBLING });
    expect(await refusalCode(cite({ checkout: 'sibling', commitPin: pin }), d)).toBeNull();
    expect(d.cwds.every((cwd) => cwd === SIBLING)).toBe(true);
  });

  it('refuses a sibling citation without a hex commit pin', async () => {
    const d = deps(siblingTree, { sibling: SIBLING });
    await expectRefused('instrument_sibling_unpinned', cite({ checkout: 'sibling' }), d);
    await expectRefused('instrument_sibling_unpinned', cite({ checkout: 'sibling', commitPin: 'HEAD' }), d);
    await expectRefused('instrument_sibling_unpinned', cite({ checkout: 'sibling', commitPin: 'abc' }), d);
  });

  it('refuses an unregistered checkout, and a pin at which the instrument does not exist', async () => {
    await expectRefused('instrument_outside_repo', cite({ checkout: 'not-registered', commitPin: pin }), deps(siblingTree, { sibling: SIBLING }));
    await expectRefused(
      'instrument_not_committed',
      cite({ checkout: 'sibling', commitPin: 'ffffffffffff' }),
      deps(siblingTree, { sibling: SIBLING }),
    );
  });
});

describe('instrument provenance — as-committed /tmp run (SPEC-P-010-AS-COMMITTED)', () => {
  const runCommit = '0123456789abcdef0123456789abcdef01234567';
  // The run executed in a disposable /tmp clone; its recorded root is evidence of WHERE it ran, not
  // of what the instrument is. The instrument exists at the run commit, not at the live HEAD.
  const asCommittedDetails = {
    testRun: { root: '/tmp/papercusp-as-committed-9f2c', commitSha: runCommit, worktreeDirty: false, asCommitted: { commitSha: runCommit, repoPrefix: null } },
  };
  const tree: Tree = {
    [ROOT]: { HEAD: {}, [runCommit]: { [INSTRUMENT]: 'export const recallAt1 = () => 0;', [INSTRUMENT_TEST]: IMPORTING_TEST } },
    [SUBMODULE]: { [runCommit]: { 'libs/db/measure.ts': 'x', 'libs/db/measure.test.ts': "import { m } from './measure';\n" } },
  };

  it('accepts the binding at the run commit and never touches the recorded /tmp root', async () => {
    const d = deps(tree);
    const binding = operational({ path: INSTRUMENT, testPath: INSTRUMENT_TEST }, asCommittedDetails);
    expect(await refusalCode(binding, d, { commitSha: runCommit, repoPrefix: null })).toBeNull();
    expect(d.cwds.length).toBeGreaterThan(0);
    expect(d.cwds.some((cwd) => cwd.startsWith('/tmp'))).toBe(false);
  });

  it('strips a submodule repo prefix and resolves the blobs inside that submodule at the run commit', async () => {
    const d = deps(tree);
    const binding = operational({ path: 'libs/papercusp/libs/db/measure.ts', testPath: 'libs/papercusp/libs/db/measure.test.ts' }, asCommittedDetails);
    expect(await refusalCode(binding, d, { commitSha: runCommit, repoPrefix: 'libs/papercusp' })).toBeNull();
    expect(new Set(d.cwds)).toEqual(new Set([SUBMODULE]));
  });

  it('still refuses an instrument absent from the run commit', async () => {
    const d = deps({ [ROOT]: { HEAD: committedTree()[ROOT]!.HEAD!, [runCommit]: {} } });
    await expectRefused('instrument_not_committed', operational({ path: INSTRUMENT, testPath: INSTRUMENT_TEST }), d, {
      commitSha: runCommit,
      repoPrefix: null,
    });
  });

  it('does not judge a derived executable-proof binding whose run root is under /tmp', async () => {
    const d = deps({});
    expect(await refusalCode({ evidenceKind: 'test', details: asCommittedDetails }, d, { commitSha: runCommit, repoPrefix: null })).toBeNull();
    expect(d.cwds).toEqual([]);
  });
});

describe('testReferencesInstrument', () => {
  const test = 'packages/bench/lib/recall.test.ts';
  it.each([
    ["import { recallAt1 } from './recall';", 'packages/bench/lib/recall.ts'],
    ["import { recallAt1 } from './recall.js';", 'packages/bench/lib/recall.ts'],
    ["const m = await import('./recall');", 'packages/bench/lib/recall.ts'],
    ["const m = require('../src/recall');", 'packages/bench/src/recall.ts'],
    ["import { x } from '../shared';", 'packages/bench/shared/index.ts'],
    ["import { recallAt1 } from '@/lib/search/bench/recall';", 'apps/operator/lib/search/bench/recall.ts'],
    ["execFileSync('bash', ['scripts/measure-recall.sh']);", 'scripts/measure-recall.sh'],
  ])('recognises %s as referencing %s', (body, instrument) => {
    expect(testReferencesInstrument(body, test, instrument)).toBe(true);
  });

  it.each([
    ["import { recallAt1 } from './recall-v2';", 'packages/bench/lib/recall.ts'],
    ["import { recallAt1 } from './old/recall';", 'packages/bench/lib/recall.ts'],
    ["import { recallAt1 } from 'other/recall';", 'packages/bench/lib/recall.ts'],
    ["import { describe } from 'vitest';", 'packages/bench/lib/recall.ts'],
    ['// mentions recall.ts in prose only', 'packages/bench/lib/recall.ts'],
  ])('does not treat %s as referencing %s', (body, instrument) => {
    expect(testReferencesInstrument(body, test, instrument)).toBe(false);
  });
});

describe('instrument provenance — bind time only (SPEC-P-010-BIND-TIME-ONLY)', () => {
  // The rule must be reachable from the bind handler and from nowhere else. A scorecard re-emit, a
  // freshness recompute and the store itself re-measure already-bound rows; if any of them imported
  // the rule, evidence bound before it landed would be refused or rated failing retroactively.
  const LIB = resolve(__dirname, '../..');
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.[cm]?tsx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?tsx?$/.test(entry.name) ? [full] : [];
    });

  // Matches a module SPECIFIER only (static import/export-from, dynamic import(), require()). A data
  // string that merely names the file — e.g. the doc-claims verification-system map listing
  // 'agent-tools/plans/instrument-provenance.ts' as a refusal-type source — is not an import and
  // cannot make the rule reachable, so it must not count.
  const IMPORTS_RULE =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)['"][^'"]*\/instrument-provenance(?:\.[cm]?[jt]s)?['"]/m;

  it('import detector counts specifiers and ignores data strings that name the file', () => {
    for (const real of [
      "import { instrumentProvenanceRefusal } from './instrument-provenance';",
      "export { x } from '../plans/instrument-provenance.js';",
      "const m = await import('./instrument-provenance');",
      "const m = require('./instrument-provenance');",
      "import './instrument-provenance';",
    ]) expect(IMPORTS_RULE.test(real), real).toBe(true);
    for (const notImport of [
      "{ door: 'plans:bind-spec-evidence', module: 'agent-tools/plans/instrument-provenance.ts' },",
      "const doc = 'see agent-tools/plans/instrument-provenance.ts';",
    ]) expect(IMPORTS_RULE.test(notImport), notImport).toBe(false);
  });

  it('is imported by plans:bind-spec-evidence and by no other production module', () => {
    const importers = sourceFiles(LIB)
      .filter((file) => !file.endsWith('instrument-provenance.ts'))
      .filter((file) => IMPORTS_RULE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(LIB, file));
    expect(importers).toEqual(['agent-tools/plans/bind-spec-evidence.ts']);
  });

  it('calls the rule only on the bind handler path, after targeting and before measurement and storage', () => {
    const handler = readFileSync(resolve(__dirname, 'bind-spec-evidence.ts'), 'utf8');
    const calls = [...handler.matchAll(/instrumentProvenanceRefusal\(/g)];
    expect(calls).toHaveLength(1);
    const at = calls[0]!.index!;
    expect(handler.lastIndexOf("timing.phase('mutationTargeting'", at)).toBeGreaterThan(-1);
    expect(handler.indexOf("timing.phase('measureAndPin'", at)).toBeGreaterThan(at);
    expect(handler.indexOf("timing.phase('storeBinding'", at)).toBeGreaterThan(at);
  });
});

describe('instrument provenance — refusal code coverage', () => {
  it('provokes every declared refusal code in the cases above', () => {
    expect([...provoked].sort()).toEqual([...INSTRUMENT_REFUSAL_CODES].sort());
  });

  // A code enters `provoked` only after expectRefused's toBe(code) passed, so each line
  // below asserts that a case really produced that refusal. The literals are spelled out
  // (not iterated) so the verification-system map's assertion scan can see each one, and
  // so dropping a code from the source union fails here as well as above.
  it('asserts each refusal code by name', () => {
    expect(provoked.has('instrument_undeclared')).toBe(true);
    expect(provoked.has('instrument_scratch_probe')).toBe(true);
    expect(provoked.has('instrument_outside_repo')).toBe(true);
    expect(provoked.has('instrument_not_committed')).toBe(true);
    expect(provoked.has('instrument_test_not_importing')).toBe(true);
    expect(provoked.has('instrument_sibling_unpinned')).toBe(true);
    expect(INSTRUMENT_REFUSAL_CODES).toHaveLength(6);
  });
});
