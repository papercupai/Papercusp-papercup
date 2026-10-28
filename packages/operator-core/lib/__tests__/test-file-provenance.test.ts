import { describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beginNodeTestLedger } from '../../../../libs/test-config/src/node-test-ledger';
import type { TestRunRow } from '../../../../libs/test-config/src/admin-test-runs-reporter';
import { parseTestRunExecutionDetails } from '../../../../libs/test-config/src/execution-details';
import { verifierSourceFiles } from '../verifier-source';
import {
  CHILD_SOURCE_NOTICE_ENV,
  CHILD_SOURCE_NOTICE_SCHEMA,
  committedBlobProbes,
  diffProvenanceSnapshots,
  fileFingerprint,
  formatChildSourceNotices,
  formatProvenanceBanner,
  formatProvenanceDrift,
  main,
  openChildSourceNoticeSink,
  parseChildSourceNotices,
  provenanceResultFields,
  readChildSourceNotices,
  snapshotProvenance,
  unscopedFocusedRunWarning,
  REPO_ROOT,
  // The .mjs CLI has no declaration file; the diagnostic lands on the `from`
  // line of this multi-line import, so the suppression directive must be the
  // LAST comment line immediately above that line.
  // @ts-expect-error
} from '../../../../scripts/test-files.mjs';

/**
 * EI-18681435059177620 — a test result must name the file state it describes.
 *
 * The suite is written against the PURE decision functions (the half that can be wrong in a costly
 * way) plus one end-to-end assertion through the real `main()`, matching the split the router's
 * sibling suites already use.
 */

const entry = (over: Record<string, unknown> = {}) => ({
  absolute: '/repo/a.test.ts',
  path: 'a.test.ts',
  state: 'clean',
  fingerprint: 'aaaaaaaaaaaa',
  added: null,
  deleted: null,
  ...over,
});

describe('focused router verifier archive provenance', () => {
  it('uses the external receipt at both boundaries and rejects a changed archive under another Git root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'router-archive-'));
    const root = join(parent, 'source');
    mkdirSync(join(parent, '.git'));
    mkdirSync(root);
    const test = join(root, 'journey.test.ts');
    writeFileSync(test, 'export const test = true;\n');
    const files = verifierSourceFiles(root);
    const receipt = { schemaVersion: 'verifier-source-v1', sourceCommit: 'f'.repeat(40),
      testedInputs: files.map(({ path, sha256 }) => ({ path, sha256 })), files };
    const path = join(parent, 'receipt.json');
    writeFileSync(path, JSON.stringify(receipt));
    writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', path);
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', receipt.sourceCommit);
    try {
      const before = snapshotProvenance([test], root);
      expect(before.head).toBe(receipt.sourceCommit);
      expect(before.entries[0]).toMatchObject({ path: 'journey.test.ts', state: 'clean' });
      expect(snapshotProvenance([test], root).head).toBe(receipt.sourceCommit);
      writeFileSync(test, 'export const test = false;\n');
      const after = snapshotProvenance([test], root);
      expect(after.head).toBeNull();
      expect(after.entries[0].state).toBe('unknown');
      expect(after.provenanceError).toContain('changed journey.test.ts');
      const stamp = provenanceResultFields(after, diffProvenanceSnapshots(before, after));
      expect(stamp).toContain('head=unknown');
      expect(stamp).toContain('provenance=drifted');
    } finally { vi.unstubAllEnvs(); rmSync(parent, { recursive: true, force: true }); }
  });
});

describe('provenance banner', () => {
  it('stamps HEAD and reports a clean path as clean', () => {
    const banner = formatProvenanceBanner({ head: 'a452179fbf', entries: [entry()] }, 'pre-run');
    expect(banner).toContain(
      'TEST_FILE_PROVENANCE head=a452179fbf testedPaths=1 uncommitted=0 unknown=0 phase=pre-run',
    );
    expect(banner).toContain('a.test.ts  [clean]');
    // The scope disclaimer is load-bearing: without it the stamp silently implies whole-import-graph
    // coverage, which would be a more confident version of the very overclaim this item is about.
    expect(banner).toContain('NAMED paths above only');
  });

  it('names the uncommitted line counts and warns the result is not reproducible by anyone else', () => {
    const banner = formatProvenanceBanner(
      { head: 'a452179fbf', entries: [entry({ state: 'dirty', added: 30, deleted: 0 })] },
      'pre-run',
    );
    expect(banner).toContain('a.test.ts  [DIRTY +30/-0]');
    expect(banner).toContain('not reproducible by anyone else');
    expect(banner).toContain('uncommitted=1');
  });

  it('marks an untracked path as existing only on this box', () => {
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry({ state: 'untracked' })] }, 'pre-run');
    expect(banner).toContain('[UNTRACKED — exists only on this box]');
    expect(banner).toContain('uncommitted=1');
  });

  /**
   * The failure mode this guards is the whole point: an unmeasurable state reported as `clean` is
   * indistinguishable from a measured clean, and manufactures exactly the false confidence the
   * stamp exists to remove.
   */
  it('reports an unmeasurable path as UNKNOWN and never as clean', () => {
    const banner = formatProvenanceBanner({ head: null, entries: [entry({ state: 'unknown' })] }, 'pre-run');
    expect(banner).toContain('[state UNKNOWN — git could not be read]');
    expect(banner).toContain('treat their state as UNKNOWN, not as clean');
    expect(banner).not.toContain('[clean]');
    expect(banner).toContain('head=unknown');
  });
});

/**
 * EI-19385411226259421 — the MIRROR of every containment trap CLAUDE.md documents.
 *
 * The documented ones all run one way: a check wrongly says your change is MISSING from the
 * candidate. This one runs the other way — `test:file` executes the WORKING TREE, so on this shared
 * checkout a peer's uncommitted fix is silently included, the named file passes, and the reader
 * records "the verdict was stale". That is the direction that makes you STOP looking, and it is the
 * direction with no instrument. Measured 2026-08-02: 7 files named by a red verdict, all 7 passed at
 * tip, 6 genuinely stale and the 7th green only on an uncommitted peer fix.
 */
describe('stale-verdict trap', () => {
  it('does NOT warn when every tested path is clean', () => {
    // The negative control. Without it a banner that emitted the warning unconditionally — i.e. one
    // that measured nothing at all — would pass every other assertion in this block.
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry()] }, 'post-run');
    expect(banner).not.toContain('STALE-VERDICT TRAP');
    expect(banner).not.toContain('git show <candidate>:');
  });

  it('warns that a pass on an uncommitted path does not make a gate verdict stale', () => {
    const banner = formatProvenanceBanner(
      { head: 'abc', entries: [entry({ state: 'dirty', added: 12, deleted: 3 })] },
      'post-run',
    );
    expect(banner).toContain('STALE-VERDICT TRAP');
    expect(banner).toContain('COMMITTED blob the gate judged still fails');
    expect(banner).toContain('git show <candidate>:a.test.ts');
  });

  it('warns on an UNTRACKED path too — not only a modified one', () => {
    // Untracked is the strictly worse case (the file is not in git at all), so a warning scoped to
    // `dirty` would exempt exactly the least reproducible state.
    const banner = formatProvenanceBanner({ head: 'abc', entries: [entry({ state: 'untracked' })] }, 'post-run');
    expect(banner).toContain('STALE-VERDICT TRAP');
  });

  it('gives a submodule path the `git -C <sub>` form and names the gitlink blindness', () => {
    const banner = formatProvenanceBanner(
      {
        head: 'abc',
        entries: [
          entry({
            path: 'papercusp-desktop/test/dev-operator-ifneeded-reaper.test.js',
            state: 'dirty',
            repoPath: 'papercusp-desktop',
            repoRelativePath: 'test/dev-operator-ifneeded-reaper.test.js',
          }),
        ],
      },
      'post-run',
    );
    expect(banner).toContain(
      'git -C papercusp-desktop show <candidate-pin-for-papercusp-desktop>:test/dev-operator-ifneeded-reaper.test.js',
    );
    expect(banner).toContain('answer about the gitlink, not this file');
    // The superproject form would answer about the wrong object here, so it must not be offered.
    expect(banner).not.toContain('git show <candidate>:papercusp-desktop/');
  });

  it('emits one probe per REPO, not per path, and covers both shapes in a mixed set', () => {
    const probes = committedBlobProbes([
      entry({ path: 'packages/operator-core/lib/a.test.ts', state: 'dirty' }),
      entry({ path: 'packages/operator-core/lib/b.test.ts', state: 'dirty' }),
      entry({
        path: 'papercusp-desktop/test/c.test.js',
        state: 'dirty',
        repoPath: 'papercusp-desktop',
        repoRelativePath: 'test/c.test.js',
      }),
      entry({
        path: 'papercusp-desktop/test/d.test.js',
        state: 'untracked',
        repoPath: 'papercusp-desktop',
        repoRelativePath: 'test/d.test.js',
      }),
    ]);
    expect(probes).toHaveLength(2);
    expect(probes[0]).toContain('git show <candidate>:packages/operator-core/lib/a.test.ts');
    expect(probes[1]).toContain('git -C papercusp-desktop show');
  });

  it('treats an explicit `.` repoPath as the superproject', () => {
    // `gitRepoDetails` writes `repoPath: '.'` for a superproject path; reading that as a submodule
    // would print a `git -C .` form that is correct-looking and needlessly wrong.
    expect(committedBlobProbes([entry({ state: 'dirty', repoPath: '.' })])).toEqual([
      'git show <candidate>:a.test.ts',
    ]);
  });

  it('never fabricates a candidate sha', () => {
    // This process does not know which sha the gate is judging; a guessed one would re-create,
    // inside the fix, the same confidently-wrong-object error the fix exists to prevent.
    const banner = formatProvenanceBanner(
      { head: 'a452179fbf', entries: [entry({ state: 'dirty' })] },
      'post-run',
    );
    expect(banner).toContain('<candidate>');
    expect(banner).not.toContain('show a452179fbf:');
  });
});

describe('mid-run drift', () => {
  const before = { head: 'aaa', entries: [entry({ fingerprint: 'v1' })] };

  it('detects a content change while the run was executing', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: 'v2' })] });
    expect(diff.drifted).toBe(true);
    expect(diff.changed).toEqual([{ path: 'a.test.ts' }]);
    const marker = formatProvenanceDrift(diff);
    expect(marker).toContain('TEST_FILE_PROVENANCE_DRIFT changed=1');
    expect(marker).toContain('describes NEITHER the state it started on nor the state on disk now');
    expect(marker).toContain('a.test.ts — content changed mid-run');
  });

  /**
   * THE CALIBRATION CASE — this is the measurement the incident actually got wrong, and the reason
   * the snapshot carries a content fingerprint rather than a clean/dirty bit.
   *
   * In the reported run the file was DIRTY BEFORE and DIRTY AFTER; what changed was its content
   * (`runGatedDelivery` was written 4 minutes after the run that "tested" it). The `statusOnlyDrift`
   * control below is the naive implementation that compares only the git state — it is kept here
   * permanently so the test cannot pass for the wrong reason: it MISSES this case, and the real
   * subject must catch it. Without this pair, a status-only rewrite would satisfy every other
   * assertion in this file.
   */
  it('catches a dirty→dirty content change that a status-only comparison provably misses', () => {
    const dirtyBefore = { head: 'aaa', entries: [entry({ state: 'dirty', fingerprint: 'v1' })] };
    const dirtyAfter = { head: 'aaa', entries: [entry({ state: 'dirty', fingerprint: 'v2' })] };

    const statusOnlyDrift = (a: typeof dirtyBefore, b: typeof dirtyAfter) =>
      a.entries.some((prior, i) => prior.state !== b.entries[i]!.state);

    expect(statusOnlyDrift(dirtyBefore, dirtyAfter)).toBe(false); // the control is blind here
    expect(diffProvenanceSnapshots(dirtyBefore, dirtyAfter).drifted).toBe(true); // the real subject is not
  });

  it('does not invent drift when nothing moved', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: 'v1' })] });
    expect(diff.drifted).toBe(false);
    expect(formatProvenanceDrift(diff)).toBeNull();
  });

  it('treats an unreadable fingerprint as UNKNOWN drift, never as unchanged', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'aaa', entries: [entry({ fingerprint: null })] });
    expect(diff.changed).toEqual([]);
    expect(diff.uncomparable).toEqual([{ path: 'a.test.ts', reason: 'unreadable after the run' }]);
    expect(formatProvenanceDrift(diff)).toContain('drift UNKNOWN');
  });

  /**
   * EI-21378916947744802: the named test path is not the whole measurement radius. In the reported
   * run git-sync committed an imported production module while the named test file stayed byte-for-
   * byte identical. A moved HEAD therefore must not bless the result merely because this deliberately
   * shallow snapshot cannot see what changed.
   */
  it('reports a moved HEAD as unknown when only the named test paths were measured', () => {
    const diff = diffProvenanceSnapshots(before, { head: 'bbb', entries: [entry({ fingerprint: 'v1' })] });
    expect(diff.drifted).toBe(false);
    expect(diff.headMoved).toEqual({ from: 'aaa', to: 'bbb' });
    const marker = formatProvenanceDrift(diff);
    expect(marker).toContain('TEST_FILE_PROVENANCE_HEAD_MOVED from=aaa to=bbb');
    expect(marker).toContain('imported source/change radius was not measured');
    expect(marker).toContain('provenance is UNKNOWN');
    expect(marker).toContain('Inspect existing PC_EXECUTED_SOURCE_MAP_OUT evidence');
    expect(marker).toContain('arm original-source capture before the next run by setting PC_EXECUTED_SOURCE_MAP_WORKSPACE=<workspace-name>');
    expect(marker).toContain('PC_EXECUTED_SOURCE_MAP_OUT=<absolute-path> (OUT alone does not arm the reporter)');
    expect(marker).toContain('does not stamp a commit');
    expect(marker).not.toContain('re-run at settled HEAD');
    expect(marker).not.toContain('still describes the files it measured');
    expect(marker).not.toContain('TEST_FILE_PROVENANCE_DRIFT');
    expect(provenanceResultFields(before, diff)).toContain('provenance=unknown');
  });
});

describe('provenance fields on the terminal marker line', () => {
  it('is three-state: stamped, drifted, unknown', () => {
    const clean = { head: 'aaa', entries: [entry()] };
    expect(provenanceResultFields(clean, { drifted: false, uncomparable: [] })).toBe(
      'head=aaa uncommittedPaths=0/1 provenance=stamped',
    );
    expect(provenanceResultFields(clean, { drifted: true, uncomparable: [] })).toContain('provenance=drifted');
    expect(
      provenanceResultFields(clean, {
        drifted: false,
        uncomparable: [],
        headMoved: { from: 'aaa', to: 'bbb' },
      }),
    ).toContain('provenance=unknown');
    expect(provenanceResultFields({ head: null, entries: [entry({ state: 'unknown' })] }, null)).toContain(
      'provenance=unknown',
    );
  });

  it('counts uncommitted paths so a pasted verdict carries its own reproducibility caveat', () => {
    const fields = provenanceResultFields(
      { head: 'aaa', entries: [entry({ state: 'dirty' }), entry({ path: 'b.test.ts', absolute: '/repo/b.test.ts' })] },
      null,
    );
    expect(fields).toContain('uncommittedPaths=1/2');
  });

  it('an unreadable git state degrades to unknown rather than a clean bill', () => {
    expect(provenanceResultFields({ head: null, entries: [] }, null)).toContain('provenance=unknown');
  });
});

/**
 * WI-6554700010009516 — a test that spawns `node <repo script>` hands the committed-source loader to
 * that child through NODE_OPTIONS, and the child executes the HEAD blob of every dirty file it
 * imports. The loader appends one JSONL notice per substituted/refused module to the file named by
 * CHILD_SOURCE_NOTICE_ENV; the router exports a per-run file and reports what landed.
 */
describe('test-spawned child committed-source substitutions', () => {
  it('main records actual substituted cases and isolates the next node group from earlier notices', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'router-node-source-')));
    // PAPERCUSP_TEST_RUN_HARNESS is cleared so every runner sees the gate's environment:
    // testing:run sets it, the green-checkpoint does not, and main() warns when it is unset.
    const keys = [CHILD_SOURCE_NOTICE_ENV, 'NODE_OPTIONS', 'PC_HEAVY_PREEMPT_READY_FILE',
      'PC_HEAVY_PSI_FINALIZATION_FILE', 'VERIFY_TAURI_SOURCE_RECEIPT', 'VERIFY_TAURI_SOURCE_REF',
      'PAPERCUSP_TEST_RUN_HARNESS'];
    const saved = keys.map(key => process.env[key]);
    for (const key of keys) delete process.env[key];
    const rows: TestRunRow[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'papercusp-desktop', 'test'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(join(root, 'papercusp-desktop', 'package.json'), '{"type":"module"}');
      const first = join(root, 'scripts', 'fixture.test.mjs');
      const committed = "import { test } from 'node:test'; test('HEAD case', () => {});\n";
      writeFileSync(first, committed);
      writeFileSync(join(root, 'papercusp-desktop', 'test', 'fixture.test.js'),
        "import { test } from 'node:test'; test('later clean case', () => {});\n");
      const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      git(['init', '-q']); git(['add', '.']);
      git(['-c', 'user.name=Router fixture', '-c', 'user.email=router@example.test', 'commit', '-qm', 'fixture']);
      const commit = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(first, "import { test } from 'node:test'; test('WORKTREE first', () => { throw Error('wrong source'); }); test('WORKTREE second', () => {});\n");
      process.env.NODE_OPTIONS = `--import=${resolve(REPO_ROOT, 'scripts/lib/committed-source-loader.mjs')}`;
      const code = await main(['scripts/fixture.test.mjs', 'papercusp-desktop/test/fixture.test.js'], {
        repoRoot: root,
        restrictedHoldPreflightImpl: () => ({ verdict: 'skip' }),
        beginNodeTestLedgerImpl: (options: Parameters<typeof beginNodeTestLedger>[0]) =>
          beginNodeTestLedger({ ...options, writeRows: async batch => { rows.push(...batch); } }),
        runGovernedTestProcessImpl: async (_options: unknown, runChild: Function) => {
          const result = await runChild({}, process.env);
          // Restore disk before record(): child notices must remain the execution authority.
          writeFileSync(first, committed);
          return result;
        },
      });
      expect(code).toBe(0);
      // The only console.warn is the unscoped-ledger notice; any other warning still fails.
      expect(warnSpy.mock.calls.map(call => String(call[0]))).toEqual([unscopedFocusedRunWarning({})]);
      expect(rows).toHaveLength(2);
      const substituted = rows.find(row => row.filePath === 'scripts/fixture.test.mjs')!;
      expect(substituted).toMatchObject({ status: 'pass', commitSha: null, worktreeDirty: true });
      expect(parseTestRunExecutionDetails(substituted.executionDetails)).toMatchObject({
        passed: 1, failed: 0, skipped: 0, passedCaseTitles: ['HEAD case'],
        worktreeDirtyReason: expect.stringContaining('substituted esm scripts/fixture.test.mjs'),
      });
      const clean = rows.find(row => row.filePath === 'papercusp-desktop/test/fixture.test.js')!;
      expect(clean).toMatchObject({ status: 'pass', commitSha: commit, worktreeDirty: false });
      expect(parseTestRunExecutionDetails(clean.executionDetails)?.passedCaseTitles).toEqual(['later clean case']);
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
      logSpy.mockRestore(); errSpy.mockRestore(); warnSpy.mockRestore(); stdoutSpy.mockRestore(); stderrSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const notice = (top: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: CHILD_SOURCE_NOTICE_SCHEMA,
      kind: 'substituted',
      via: 'esm',
      rel: 'scripts/lib/a.mjs',
      top,
      pid: 4242,
      entry: '/checkout/scripts/child.mjs',
      ...over,
    });
  const withRoot = (fn: (root: string, scratch: string) => void) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'child-notices-')));
    const root = join(scratch, 'checkout');
    mkdirSync(join(root, 'libs', 'sub'), { recursive: true });
    try {
      fn(root, scratch);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  it('pins the duplicated env name and schema to the loader that writes them', () => {
    const loader = readFileSync(join(REPO_ROOT, 'scripts/lib/committed-source-loader.mjs'), 'utf8');
    expect(loader).toContain(`export const COMMITTED_SOURCE_NOTICE_ENV = '${CHILD_SOURCE_NOTICE_ENV}';`);
    expect(loader).toContain(`export const COMMITTED_SOURCE_NOTICE_SCHEMA = '${CHILD_SOURCE_NOTICE_SCHEMA}';`);
  });

  it('keeps this checkout and its submodules, drops fixtures and prefix siblings, counts malformed lines', () => {
    withRoot((root, scratch) => {
      const text = [
        notice(root, { rel: 'scripts/a.mjs' }),
        notice(join(root, 'libs', 'sub'), { rel: 'b.ts', via: 'cjs' }),
        notice(join(scratch, 'fixture'), { rel: 'fixture.mjs' }),
        notice(`${root}-sibling`, { rel: 'sibling.mjs' }),
        '{not json',
        notice(root, { schemaVersion: 'committed-source-notice-v0' }),
        JSON.stringify({ schemaVersion: CHILD_SOURCE_NOTICE_SCHEMA, kind: 'refused', top: root }),
        '',
      ].join('\n');
      const parsed = parseChildSourceNotices(text, root);
      expect(parsed.records.map((r: { rel: string }) => r.rel)).toEqual(['scripts/a.mjs', 'b.ts']);
      expect(parsed.malformed).toBe(3);
    });
  });

  it('matches a symlinked root against the real path the loader records', () => {
    withRoot((root, scratch) => {
      const link = join(scratch, 'link');
      symlinkSync(root, link);
      expect(parseChildSourceNotices(notice(root), link).records).toHaveLength(1);
    });
  });

  it('prints nothing when no child substituted anything, and count=unknown when the channel was unreadable', () => {
    expect(formatChildSourceNotices({ records: [], malformed: 0, unreadable: false })).toEqual([]);
    for (const notices of [{ records: [], malformed: 0, unreadable: true }, undefined]) {
      const lines = formatChildSourceNotices(notices);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^TEST_FILE_CHILD_SUBSTITUTED count=unknown /);
    }
    expect(formatChildSourceNotices({ records: [], malformed: 2, unreadable: false })).toEqual([
      'TEST_FILE_CHILD_SUBSTITUTED count=0 malformed=2',
    ]);
  });

  it('names each substituted or refused module with its process and entry script, then warns', () => {
    const records = [
      JSON.parse(notice('/checkout')),
      JSON.parse(notice('/checkout', { kind: 'refused', via: 'cjs', rel: 'scripts/b.cjs', pid: 7, reason: 'uncommitted' })),
    ];
    expect(formatChildSourceNotices({ records, malformed: 0, unreadable: false })).toEqual([
      'TEST_FILE_CHILD_SUBSTITUTED count=2',
      '  substituted esm scripts/lib/a.mjs  pid=4242 entry=/checkout/scripts/child.mjs',
      '  refused cjs scripts/b.cjs  pid=7 entry=/checkout/scripts/child.mjs reason=uncommitted',
      expect.stringMatching(/ran the COMMITTED blob .* measured HEAD, not your working tree/),
    ]);
  });

  it('appends childSubstituted LAST on the terminal fields, only when main() passes the notices', () => {
    const snapshot = { head: 'aaa', entries: [entry()], startedAt: '2026-10-13T00:00:00.000Z' };
    const diff = { drifted: false, uncomparable: [] };
    const base = 'head=aaa uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-13T00:00:00.000Z';
    expect(provenanceResultFields(snapshot, diff)).toBe(base);
    expect(provenanceResultFields(snapshot, diff, { records: [{}, {}], malformed: 0, unreadable: false })).toBe(
      `${base} childSubstituted=2`,
    );
    expect(provenanceResultFields(snapshot, diff, { records: [], malformed: 1, unreadable: false })).toBe(
      `${base} childSubstituted=0`,
    );
    for (const unreadable of [{ records: [], malformed: 0, unreadable: true }, null]) {
      expect(provenanceResultFields(snapshot, diff, unreadable)).toBe(`${base} childSubstituted=unknown`);
    }
  });

  it('owns a per-run file: exports it for children, reads it back, then removes it and the variable', () => {
    withRoot((root, scratch) => {
      const env: Record<string, string | undefined> = {};
      const sink = openChildSourceNoticeSink(env, { tmpRoot: scratch });
      expect(sink.owned).toBe(true);
      expect(env[CHILD_SOURCE_NOTICE_ENV]).toBe(sink.path);
      // No child wrote anything: a missing file is a measured zero, not an unreadable channel.
      expect(readChildSourceNotices(sink, root)).toEqual({ records: [], malformed: 0, unreadable: false });
      appendFileSync(sink.path, `${notice(root)}\n`);
      expect(readChildSourceNotices(sink, root).records).toHaveLength(1);
      sink.close();
      expect(CHILD_SOURCE_NOTICE_ENV in env).toBe(false);
      expect(existsSync(dirname(sink.path))).toBe(false);
    });
  });

  it('shares an inherited channel without owning it and reads only what this run appended', () => {
    withRoot((root, scratch) => {
      const path = join(scratch, 'parent-notices.jsonl');
      writeFileSync(path, `${notice(root, { rel: 'before.mjs' })}\n`);
      const env: Record<string, string | undefined> = { [CHILD_SOURCE_NOTICE_ENV]: path };
      const sink = openChildSourceNoticeSink(env, { tmpRoot: scratch });
      expect(sink).toMatchObject({ path, owned: false });
      appendFileSync(path, `${notice(root, { rel: 'during.mjs' })}\n`);
      expect(readChildSourceNotices(sink, root).records.map((r: { rel: string }) => r.rel)).toEqual(['during.mjs']);
      sink.close();
      expect(env[CHILD_SOURCE_NOTICE_ENV]).toBe(path);
      expect(existsSync(path)).toBe(true);
    });
  });

  it('reports a channel it could not open or read as unreadable, never as zero', () => {
    withRoot((root, scratch) => {
      const env: Record<string, string | undefined> = {};
      const unopened = openChildSourceNoticeSink(env, { tmpRoot: join(scratch, 'missing') });
      expect(unopened.path).toBeNull();
      expect(CHILD_SOURCE_NOTICE_ENV in env).toBe(false);
      expect(readChildSourceNotices(unopened, root).unreadable).toBe(true);
      // A path that exists but is not a readable file (EISDIR) is unreadable too.
      expect(readChildSourceNotices({ path: scratch, offset: 0 }, root).unreadable).toBe(true);
    });
  });

  // The fake child writes to the channel named in the env main() HANDS it — what a real child
  // inherits — never to this process's env. WI-6554700010018066: a receipt-bearing run cloned
  // its child env before the channel was exported, so the child got no channel while
  // process.env had one; reading process.env here hid that.
  async function runMainWithFakeChild(receiptFile?: string) {
    // PAPERCUSP_TEST_RUN_HARNESS is cleared so every runner sees the gate's environment
    // (testing:run sets it; the green-checkpoint does not; main() warns when it is unset).
    const keys: string[] = [
      CHILD_SOURCE_NOTICE_ENV, 'PC_HEAVY_PREEMPT_READY_FILE', 'PC_HEAVY_PSI_FINALIZATION_FILE',
      'PAPERCUSP_TEST_RUN_RECEIPT_FILE', 'PAPERCUSP_TEST_RUN_HARNESS',
    ];
    const saved = keys.map((key) => process.env[key]);
    // Under `npm run test:file` this worker inherits the PARENT router's channel; the fake child
    // record below must land in a channel this main() owns, not in the parent's report.
    for (const key of keys) delete process.env[key];
    if (receiptFile) process.env.PAPERCUSP_TEST_RUN_RECEIPT_FILE = receiptFile;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let censusSaw: string | undefined = 'census not called';
    let channel: string | undefined;
    let childChannel: string | undefined;
    let afterMain: string | undefined;
    let code: number;
    let output: string;
    try {
      code = await main(['packages/operator-core/lib/__tests__/test-file-provenance.test.ts'], {
        restrictedHoldPreflightImpl: () => {
          censusSaw = process.env[CHILD_SOURCE_NOTICE_ENV];
          return { verdict: 'skip' };
        },
        runCapturedTestProcessImpl: async (_command: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
          channel = process.env[CHILD_SOURCE_NOTICE_ENV];
          childChannel = opts?.env?.[CHILD_SOURCE_NOTICE_ENV];
          if (childChannel) appendFileSync(childChannel, `${notice(realpathSync(REPO_ROOT), { pid: 999001 })}\n`);
          return {
            status: 0,
            signal: null,
            stdout: 'Test Files 1 passed (1)\nTests 1 passed (1)\n',
            stderr: '',
            error: null,
            timedOut: false,
          };
        },
      });
      afterMain = process.env[CHILD_SOURCE_NOTICE_ENV];
      output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
      // The only console.warn is the unscoped-ledger notice; any other warning still fails.
      expect(warnSpy.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([unscopedFocusedRunWarning({})]);
    } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
      logSpy.mockRestore();
      errSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
    return { code, output, censusSaw, channel, childChannel, afterMain };
  }

  it('main() opens the channel after the restricted-hold census and reports what a run child appended', async () => {
    const { code, output, censusSaw, channel, childChannel, afterMain } = await runMainWithFakeChild();
    expect(code).toBe(0);
    // The census is a deliberate committed-source walk: its substitutions are not the tests'.
    expect(censusSaw).toBeUndefined();
    expect(channel).toBeTruthy();
    expect(childChannel).toBe(channel);
    expect(output).toContain('  substituted esm scripts/lib/a.mjs  pid=999001 entry=/checkout/scripts/child.mjs');
    // The real `vitest list` child shares the channel, so count by agreement, not by a literal 1.
    const count = Number(/TEST_FILE_CHILD_SUBSTITUTED count=(\d+)/.exec(output)?.[1]);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(output).toMatch(new RegExp(`TEST_FILE_RESULT .* childSubstituted=${count} `));
    expect(afterMain).toBeUndefined();
    expect(existsSync(dirname(channel!))).toBe(false);
  });

  it('a receipt-bearing run (every mutation-probe leg) hands its run child the notice channel too', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'test-file-provenance-receipt-'));
    try {
      const { output, censusSaw, channel, childChannel } = await runMainWithFakeChild(join(scratch, 'receipts.jsonl'));
      expect(censusSaw).toBeUndefined();
      expect(channel).toBeTruthy();
      // Before the WI-6554700010018066 fix this was undefined: the receipt env was cloned early.
      expect(childChannel).toBe(channel);
      expect(output).toContain('  substituted esm scripts/lib/a.mjs  pid=999001 entry=/checkout/scripts/child.mjs');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('fingerprint + snapshot against the real filesystem', () => {
  it('changes when the bytes change and is null for a file that does not exist', () => {
    // Mutating a COPY outside the tree — never the shared checkout (CLAUDE.md § proving a guard is
    // falsifiable: an in-tree mutation can be committed by a git-sync sweep even when nothing fails).
    const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
    try {
      const file = join(dir, 'subject.txt');
      writeFileSync(file, 'before');
      const first = fileFingerprint(file);
      writeFileSync(file, 'after');
      expect(fileFingerprint(file)).not.toBe(first);
      expect(fileFingerprint(join(dir, 'missing.txt'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a real HEAD and a real per-path state from the repo', () => {
    const snapshot = snapshotProvenance([resolve(REPO_ROOT, 'package.json')]);
    expect(snapshot.head).toMatch(/^[0-9a-f]{7,40}$/);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].path).toBe('package.json');
    expect(['clean', 'dirty', 'untracked', 'unknown']).toContain(snapshot.entries[0].state);
    expect(snapshot.entries[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  /**
   * REGRESSION: the superproject stores `libs/test-config` as a gitlink, so its own `git ls-files`
   * cannot answer for a file inside that submodule. The provenance reader must use the nested repo
   * and carry both its HEAD and the superproject pin into the human-readable stamp.
   */
  it('resolves a tracked file inside a submodule and reports its commit/pointer state', () => {
    const snapshot = snapshotProvenance([resolve(REPO_ROOT, 'libs/test-config/src/lane-split.test.ts')]);
    const file = snapshot.entries[0];
    expect(file.state).not.toBe('untracked');
    expect(file.repoPath).toBe('libs/test-config');
    expect(file.repoHead).toMatch(/^[0-9a-f]{7,40}$/);
    expect(file.superprojectPin).toMatch(/^[0-9a-f]{40}$/);
    expect(['matched', 'mismatch']).toContain(file.pointerState);

    const banner = formatProvenanceBanner(snapshot, 'pre-run');
    expect(banner).toContain('libs/test-config/src/lane-split.test.ts');
    expect(banner).toContain('repo=libs/test-config');
    expect(banner).toContain(`repoHead=${file.repoHead}`);
    expect(banner).toContain(`superprojectPin=${file.superprojectPin}`);
    expect(banner).toContain(`pointer=${file.pointerState}`);
  });

  it('dedupes a path named twice so the before/after snapshots stay comparable entry-for-entry', () => {
    const p = resolve(REPO_ROOT, 'package.json');
    expect(snapshotProvenance([p, p]).entries).toHaveLength(1);
  });

  /**
   * REGRESSION: a GITIGNORED file must never read as `clean`.
   *
   * `git status` collapses an ignored file to its ignored DIRECTORY (`!! .papercusp/scratch/`) even
   * under `--ignored=matching -uall`, so no exact-path record ever matches it. The first version of
   * this snapshot inferred `clean` from "git named nothing for this path" and therefore reported a
   * file that is not in git AT ALL as reproducible by anyone — which is why tracked-ness is now
   * decided by `ls-files` instead. Verified live before the fix (reported `clean`) and after
   * (reports `untracked`).
   *
   * `.papercusp/scratch/` is gitignored, so writing here cannot be picked up by a git-sync sweep —
   * the in-tree mutation hazard CLAUDE.md warns about does not apply to an ignored path.
   */
  it('never reports a gitignored file as clean', () => {
    const ignored = resolve(REPO_ROOT, '.papercusp/scratch/provenance-ignored-fixture.test.ts');
    try {
      // A FRESH checkout (the green-checkpoint tree) has no .papercusp/scratch/ yet, so the
      // write ENOENT'd there while passing in every long-lived working tree — a red that
      // looked like a provenance regression but was only an unprovisioned fixture dir.
      // The pattern `**/.papercusp/scratch/` ignores this path by name, so creating it here
      // keeps the ignored-ness the assertion depends on (WI-39362).
      mkdirSync(dirname(ignored), { recursive: true });
      writeFileSync(ignored, 'export const fixture = true;\n');
      expect(snapshotProvenance([ignored]).entries[0].state).toBe('untracked');
    } finally {
      rmSync(ignored, { force: true });
    }
    // Calibration: the same probe must still say `clean` for a genuinely tracked, unmodified file,
    // or the assertion above would pass for a snapshot that simply calls everything untracked.
    expect(['clean', 'dirty']).toContain(snapshotProvenance([resolve(REPO_ROOT, 'package.json')]).entries[0].state);
  });
});

describe('end-to-end through the real router', () => {
  it('prints the banner and stamps the terminal marker line', async () => {
    const lines: string[] = [];
    let sawListProgress = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args.join(' ').startsWith('TEST_FILE_LIST_PROGRESS ')) sawListProgress = true;
    });
    const spy = (...args: unknown[]) => void lines.push(args.join(' '));
    const realLog = console.log;
    console.log = spy as typeof console.log;
    let code: number;
    try {
      code = await main(['--dry', 'packages/operator-core/lib/__tests__/test-file-provenance.test.ts']);
    } finally {
      console.log = realLog;
      errorSpy.mockRestore();
    }

    expect(code).toBe(0);
    expect(sawListProgress).toBe(true);
    const banner = lines.find((l) => l.startsWith('TEST_FILE_PROVENANCE '));
    expect(banner).toBeDefined();
    expect(banner).toContain('phase=pre-run');

    const terminal = lines.find((l) => l.startsWith('TEST_FILE_DRYRUN'));
    expect(terminal).toBeDefined();
    // The stamp rides on the line a `| tail -N` actually reads, which is the placement that makes
    // it impossible to paste the verdict without its scope.
    expect(terminal).toMatch(/head=[0-9a-f]{7,40}/);
    expect(terminal).toMatch(/provenance=(stamped|drifted|unknown)/);
  });

  /**
   * REGRESSION GUARD for the compatibility promise this change rests on: the new fields are
   * APPENDED, so `TEST_FILE_RESULT`'s first field stays `requested=` (pinned by the doc-claims
   * anchor registry in machine-line-grep-anchors.ts) and every existing consumer keeps tokenising
   * `status=` unchanged.
   */
  it('keeps the existing marker-line contract intact', async () => {
    const lines: string[] = [];
    let sawListProgress = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args.join(' ').startsWith('TEST_FILE_LIST_PROGRESS ')) sawListProgress = true;
    });
    const realLog = console.log;
    console.log = ((...args: unknown[]) => void lines.push(args.join(' '))) as typeof console.log;
    try {
      await main(['--dry', 'packages/operator-core/lib/__tests__/test-file-provenance.test.ts']);
    } finally {
      console.log = realLog;
      errorSpy.mockRestore();
    }
    expect(sawListProgress).toBe(true);
    const terminal = lines.find((l) => l.startsWith('TEST_FILE_DRYRUN'))!;
    expect(terminal).toMatch(/^TEST_FILE_DRYRUN requested=\d+ /);
    expect(/\bstatus=([a-z-]+)/.exec(terminal)?.[1]).toBe('dry-run');
  });
});
