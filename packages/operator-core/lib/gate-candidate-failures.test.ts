/**
 * WI-1702869 — the failing-files-on-the-frozen-candidate instrument.
 *
 * Every case here is a wrong answer this module was filed to stop returning. They are
 * written as the WRONG reading first, so a future change that reintroduces one fails
 * with the misreading named rather than with a bare assertion diff.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessCandidateFailures,
  outstandingLegIds,
  staleUnadmittedRedLegIds,
  parseGitLsTreeObjectIds,
  readGateCandidateFailures,
  submoduleRelativeCandidates,
} from './gate-candidate-failures';
import type { FrozenRepairLegState } from './release/repair-leg-lifecycle';
import type { RepairSignatureEntry } from './release/frozen-candidate-repair-queue';

const CANDIDATE = 'adbf27530285830455f8d8df32a45752cfaff332';
const REPAIR_HEAD = 'e7bffeac00000000000000000000000000000000';

type Row = Record<string, unknown>;

/**
 * A fake `sql` tagged template. The module fires up to three queries: the census (told apart
 * by its aggregate), the gate's own runs AT repairHead (told apart by the `repair_head_runs`
 * CTE, EI-24654779657165409), and the candidate's failing files. Matching on the structural
 * marker means a refactor that drops one breaks this fake loudly instead of silently
 * answering the wrong query. `atRepairHead` defaults to NO rows — "the gate has not run it
 * there" — so every case written before that query existed keeps its blob-only reading.
 */
function fakeSql(opts: { filesJudged: number; failing: Row[]; atRepairHead?: Row[] }) {
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join(' ');
    if (/count\(DISTINCT file_path\)/.test(text)) {
      return Promise.resolve([{ files_judged: opts.filesJudged }]);
    }
    if (/repair_head_runs/.test(text)) return Promise.resolve(opts.atRepairHead ?? []);
    return Promise.resolve(opts.failing);
  }) as never;
  return sql;
}

/** A git stub keyed by the exact argv the module builds. */
function fakeGit(table: Record<string, string | null>) {
  return async (_cwd: string, args: string[]) => {
    const key = args.join(' ');
    if (key in table) return table[key];
    // Keep the existing per-path fixtures useful after production batches those same object-id
    // reads. An explicitly-null fixture is a successfully-read missing path; no fixture at all
    // keeps the whole synthetic batch unreadable so the fail-soft fallback remains exercised.
    if (args[0] === 'ls-tree' && args[1] === '-z') {
      const ref = args[2];
      const paths = args.slice(args.indexOf('--') + 1);
      let matched = false;
      const records: string[] = [];
      for (const path of paths) {
        const legacyKey = revParse(ref, path);
        if (!(legacyKey in table)) continue;
        matched = true;
        const objectId = table[legacyKey];
        if (objectId !== null) records.push(`100644 blob ${objectId}\t${path}\0`);
      }
      if (matched) return records.join('');
    }
    return null;
  };
}

const revParse = (sha: string, p: string) => `rev-parse --verify --quiet ${sha}:${p}`;

describe('parseGitLsTreeObjectIds', () => {
  it('parses NUL-delimited object ids without trimming paths', () => {
    expect(
      parseGitLsTreeObjectIds(
        ['100644 blob aaa111\tplain.test.ts', '100644 blob bbb222\tpath with spaces.test.ts', ''].join('\0'),
      ),
    ).toEqual(
      new Map([
        ['plain.test.ts', 'aaa111'],
        ['path with spaces.test.ts', 'bbb222'],
      ]),
    );
  });
});

describe('readGateCandidateFailures', () => {
  it('reports a DIFFERENT blob at repairHead as "already fixed", not as an open failure', async () => {
    // The measured 2026-08-31 case: one failing row on the frozen candidate whose fix
    // had already landed. Reading that row as work is what cost five hours.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 223,
        failing: [{ file_path: 'apps/x/LearningTab.lens-guard.test.tsx', status: 'fail', attempts: 3 }],
      }),
      git: fakeGit({
        [revParse(CANDIDATE, 'apps/x/LearningTab.lens-guard.test.tsx')]: 'ab5e43a6',
        [revParse(REPAIR_HEAD, 'apps/x/LearningTab.lens-guard.test.tsx')]: '36734ba9',
      }),
    });

    expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(true);
    expect(res.alreadyFixedCount).toBe(1);
    expect(res.stillBrokenCount).toBe(0);
    // The headline is the STILL-BROKEN count, so a fixed-but-unverified file does not
    // read as outstanding work.
    expect(res.assessment).toBe('all-fixes-contained');
    expect(res.distinctFailingFiles[0].reading).toMatch(/Do NOT re-fix/i);
  });

  it('reports an IDENTICAL blob at repairHead as still broken — the real repair queue', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
      }),
    });

    expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(false);
    expect(res.stillBrokenCount).toBe(1);
    expect(res.assessment).toBe('repairs-outstanding');
  });

  describe("the gate's own run AT repairHead outranks the blob compare (EI-24654779657165409)", () => {
    // Measured 2026-09-30: 20 files read "still broken" by blob while repairHead's own
    // verification had passed every one of them, and the only red was a lint leg.
    const unchangedBlob = fakeGit({
      [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
      [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
      [`rev-parse ${CANDIDATE}^{tree}`]: 'tree1',
      [`rev-parse ${REPAIR_HEAD}^{tree}`]: 'tree2',
      [`diff --name-only ${CANDIDATE} ${REPAIR_HEAD}`]: 'libs/a/b.test.ts\nscripts/helper.mjs',
    });

    it('a PASS at repairHead is NOT still broken, even with an unchanged test blob', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({
          filesJudged: 12,
          failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }],
          atRepairHead: [{ file_path: 'libs/a/b.test.ts', status: 'pass', id: 20175905 }],
        }),
        git: unchangedBlob,
      });
      const row = res.distinctFailingFiles[0];
      expect(row.fixInRepairHead).toBe(false); // the blob fact is unchanged…
      expect(row.atRepairHead).toEqual({ status: 'pass', runId: 20175905 }); // …but it was measured
      expect(res.stillBrokenCount).toBe(0);
      expect(res.stillBrokenNeedsRunCount).toBe(0);
      expect(res.passedAtRepairHeadCount).toBe(1);
      expect(res.assessment).toBe('all-fixes-contained');
      expect(row.reading).toMatch(/PASSED AT repairHead/);
      expect(row.reading).not.toMatch(/RUN THIS FILE AT repairHead/);
    });

    it('a FAIL at repairHead is still broken, even when the test blob changed', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({
          filesJudged: 12,
          failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }],
          atRepairHead: [{ file_path: 'libs/a/b.test.ts', status: 'fail', id: 7 }],
        }),
        git: fakeGit({
          [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
          [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'c0ffee00',
        }),
      });
      expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(true);
      expect(res.alreadyFixedCount).toBe(0);
      expect(res.stillBrokenCount).toBe(1);
      expect(res.assessment).toBe('repairs-outstanding');
      expect(res.distinctFailingFiles[0].reading).toMatch(/STILL FAILING AT repairHead.*did not fix it/);
    });

    it('an unreadable repairHead read keeps the hedged blob reading, never a verdict', async () => {
      const sql = ((strings: TemplateStringsArray) => {
        const text = strings.join(' ');
        if (/repair_head_runs/.test(text)) return Promise.reject(new Error('connection reset'));
        if (/count\(DISTINCT file_path\)/.test(text)) return Promise.resolve([{ files_judged: 12 }]);
        return Promise.resolve([{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }]);
      }) as never;
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql,
        git: unchangedBlob,
      });
      expect(res.unavailable).toBeNull();
      expect(res.distinctFailingFiles[0].atRepairHead).toBeNull();
      expect(res.stillBrokenCount).toBe(1);
      expect(res.stillBrokenNeedsRunCount).toBe(1);
      expect(res.distinctFailingFiles[0].reading).toMatch(/RUN THIS FILE AT repairHead/);
    });
  });

  it('a single still-broken file OUTRANKS any number of already-fixed siblings', async () => {
    // First-match ordering. Reporting `all-fixes-contained` while real work remains is
    // the reassuring-degradation failure the cell exists to end.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 223,
        failing: [
          { file_path: 'a.test.ts', status: 'fail', attempts: 1 },
          { file_path: 'b.test.ts', status: 'fail', attempts: 1 },
          { file_path: 'c.test.ts', status: 'error', attempts: 1 },
        ],
      }),
      git: fakeGit({
        [revParse(CANDIDATE, 'a.test.ts')]: 'aaa1',
        [revParse(REPAIR_HEAD, 'a.test.ts')]: 'aaa2', // fixed
        [revParse(CANDIDATE, 'b.test.ts')]: 'bbb1',
        [revParse(REPAIR_HEAD, 'b.test.ts')]: 'bbb2', // fixed
        [revParse(CANDIDATE, 'c.test.ts')]: 'ccc1',
        [revParse(REPAIR_HEAD, 'c.test.ts')]: 'ccc1', // STILL BROKEN
      }),
    });

    expect(res.alreadyFixedCount).toBe(2);
    expect(res.stillBrokenCount).toBe(1);
    expect(res.assessment).toBe('repairs-outstanding');
  });

  it('EI-22737582656157929: batches ordinary blob comparisons into one ls-tree call per ref', async () => {
    const failing = Array.from({ length: 40 }, (_, i) => ({
      file_path: `tests/failing-${i}.test.ts`,
      status: 'fail',
      attempts: 1,
    }));
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]): Promise<string | null> => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === CANDIDATE + '^{tree}') return 'tree-a';
      if (args[0] === 'rev-parse' && args[1] === REPAIR_HEAD + '^{tree}') return 'tree-b';
      if (args[0] === 'diff' && args[1] === '--name-only') return 'src/fix-carrier.ts\n';
      if (args[0] === 'ls-tree') {
        const ref = args[2];
        const suffix = ref === CANDIDATE ? 'a' : 'b';
        return args
          .slice(args.indexOf('--') + 1)
          .map((path, i) => `100644 blob object-${i}-${suffix}\t${path}\0`)
          .join('');
      }
      return null;
    };

    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 40, failing }),
      git,
    });

    expect(res.alreadyFixedCount).toBe(40);
    expect(calls.filter((args) => args[0] === 'ls-tree')).toHaveLength(2);
    expect(calls.filter((args) => args[0] === 'rev-parse' && args.includes('--verify'))).toHaveLength(0);
  });

  it('compares a SUBMODULE-backed path by gitlink, never by blob', async () => {
    // ⚠ THE TRAP THIS EXISTS FOR: `git rev-parse <ref>:<path>` inside a submodule
    // compares content that is IDENTICAL in both refs while the gitlink moved
    // underneath. A blob compare would answer "unchanged" — confidently, and wrongly,
    // in the false-negative direction that sends an agent to re-fix a fixed file.
    const blobsAreIdentical = {
      [revParse(CANDIDATE, 'libs/papercusp/x.test.ts')]: 'same',
      [revParse(REPAIR_HEAD, 'libs/papercusp/x.test.ts')]: 'same',
      [`diff --raw ${CANDIDATE} ${REPAIR_HEAD} -- libs/papercusp`]:
        ':160000 160000 1111111 2222222 M\tlibs/papercusp',
    };
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({
        filesJudged: 10,
        failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }],
      }),
      git: fakeGit(blobsAreIdentical),
    });

    const file = res.distinctFailingFiles[0];
    // The blob compare available to it would have said `false`. The gitlink says `true`.
    expect(file.fixInRepairHead).toBe(true);
    expect(file.comparison).toMatch(/gitlink/);
    expect(file.candidateBlob).toBeNull();
  });

  it('an unchanged gitlink is still-broken, and an unreadable one is UNKNOWN', async () => {
    const unchanged = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({ filesJudged: 10, failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }] }),
      // An EMPTY diff means the gitlink did not move — distinct from an unreadable one.
      git: fakeGit({ [`diff --raw ${CANDIDATE} ${REPAIR_HEAD} -- libs/papercusp`]: '' }),
    });
    expect(unchanged.distinctFailingFiles[0].fixInRepairHead).toBe(false);

    const unreadable = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      submodulePaths: ['libs/papercusp'],
      sql: fakeSql({ filesJudged: 10, failing: [{ file_path: 'libs/papercusp/x.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({}), // every call fails ⇒ null
    });
    // UNKNOWN must not collapse into either verdict.
    expect(unreadable.distinctFailingFiles[0].fixInRepairHead).toBeNull();
    expect(unreadable.stillBrokenCount).toBe(0);
    expect(unreadable.alreadyFixedCount).toBe(0);
    expect(unreadable.assessment).toBe('unmeasured');
  });

  it('an unresolvable blob on EITHER side is UNKNOWN, not "fixed"', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 5, failing: [{ file_path: 'gone.test.ts', status: 'fail', attempts: 1 }] }),
      // Only the candidate side resolves. `a !== b` would read `true` ("fixed") if the
      // null were not checked first — the exact false-positive this guards.
      git: fakeGit({ [revParse(CANDIDATE, 'gone.test.ts')]: 'aaa' }),
    });
    expect(res.distinctFailingFiles[0].fixInRepairHead).toBeNull();
  });

  it('NO frozen candidate is a measured ABSENCE, never a count of zero failures', async () => {
    const res = await readGateCandidateFailures({ candidateSha: null, repairHeadSha: null, root: '/repo' });
    expect(res.assessment).toBe('no-frozen-candidate');
    expect(res.unavailable).toMatch(/not "zero failures"/);
    // The zeroes are shape, not evidence — `unavailable` is what says so.
    expect(res.unavailable).not.toBeNull();
  });

  it('P-025: an unreadable persisted queue stays present-but-unmeasured with its raw identity', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: null,
      repairHeadSha: null,
      root: '/repo',
      repairQueueRead: {
        status: 'unreadable',
        reason: 'schema-newer-than-reader',
        schemaVersion: 5,
        candidate: CANDIDATE,
        repairHead: REPAIR_HEAD,
        phase: 'ready-to-verify',
      },
    });
    expect(res).toMatchObject({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      assessment: 'unmeasured',
      unavailable: expect.stringContaining('phase ready-to-verify'),
    });
    expect(res.unavailable).toMatch(new RegExp(`candidate ${CANDIDATE.slice(0, 12)}`));
    expect(res.unavailable).toMatch(new RegExp(`repairHead ${REPAIR_HEAD.slice(0, 12)}`));
  });

  it('an unreachable test_runs is UNMEASURED, and never degrades to a green-looking zero', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: (() => {
        throw new Error('connection refused');
      }) as never,
    });
    expect(res.assessment).toBe('unmeasured');
    expect(res.unavailable).toMatch(/connection refused/);
  });

  it('carries the scope sentence so filesJudged is never quoted as the full suite', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
    });
    expect(res.filesJudged).toBe(223);
    expect(res.assessment).toBe('none-failing');
    // An empty failing list must not be readable as "the gate is green".
    expect(res.scope).toMatch(/AFFECTED RADIUS/);
    expect(res.scope).toMatch(/NOT "repairHead is green"|NOT\s+"repairHead is green"/);
    // P-003: with no leg measurement threaded in, the honest reading is `not-recorded` —
    // never a `null` that a caller can read as "measured, nothing there".
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
  });

  it('scopes the census to ONE population: ci, clean tree, this candidate', async () => {
    // The original defect was aggregating three populations. Assert the predicates are
    // actually in the SQL, so a future edit cannot silently widen it back.
    const seen: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      seen.push(strings.join(' '));
      return Promise.resolve(/count\(DISTINCT file_path\)/.test(strings.join(' ')) ? [{ files_judged: 1 }] : []);
    }) as never;

    await readGateCandidateFailures({ candidateSha: CANDIDATE, repairHeadSha: REPAIR_HEAD, root: '/repo', sql });

    for (const q of seen) {
      expect(q).toMatch(/source\s*=/);
      expect(q).toMatch(/worktree_dirty\s*=\s*false/);
      expect(q).toMatch(/commit_sha\s*=/);
    }
    // The failing-file query must collapse retries to the latest attempt, or a
    // retried-and-passed file reads as red forever.
    expect(seen.some((q) => /DISTINCT ON \(file_path\)/.test(q))).toBe(true);
  });

  /**
   * ── THE NON-TEST-CARRIER TRAP ────────────────────────────────────────────────────
   * Measured 2026-09-02 on candidate 797454468a / repairHead 607bff8f43: the cell called
   * three files "real work" and ALL THREE were already fixed — the repairs had landed in
   * `scripts/check-resource-governor-enforcement.mjs` and `scripts/pc-heavy-jobs.mjs`,
   * which a TEST-blob comparison cannot see. Wrong 3 times out of 3, in the direction
   * that manufactures labour.
   */
  const tree = (sha: string) => `rev-parse ${sha}^{tree}`;
  const nameOnly = `diff --name-only ${CANDIDATE} ${REPAIR_HEAD}`;

  it('does NOT call a file "real work" when the fix could be riding a non-test file', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({
        filesJudged: 6936,
        failing: [{ file_path: 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts', status: 'fail', attempts: 5 }],
      }),
      git: fakeGit({
        // The test file itself never moved — the real 2026-09-02 shape.
        [revParse(CANDIDATE, 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts')]: 'd397c0ce',
        [revParse(REPAIR_HEAD, 'packages/operator-core/lib/undrained-stdout-exit-guard.test.ts')]: 'd397c0ce',
        [tree(CANDIDATE)]: 'tree-aaa',
        [tree(REPAIR_HEAD)]: 'tree-bbb',
        // ...but the script it exercises did.
        [nameOnly]: 'scripts/pc-heavy-jobs.mjs\n',
      }),
    });

    const row = res.distinctFailingFiles[0];
    // The blob fact is unchanged and stays honest.
    expect(row.fixInRepairHead).toBe(false);
    expect(res.stillBrokenCount).toBe(1);
    // But it must NOT be asserted as confirmed work, and must name the decisive next step.
    expect(res.stillBrokenNeedsRunCount).toBe(1);
    expect(row.reading).not.toMatch(/This one is real work/i);
    expect(row.reading).toMatch(/RUN THIS FILE AT repairHead/i);
    expect(res.changedBetweenRefs).toEqual({ count: 1, sample: ['scripts/pc-heavy-jobs.mjs'] });
  });

  it('KEEPS the strong "real work" reading when nothing else moved either', async () => {
    // The hedge must not swallow the instrument: with an identical tree on both sides
    // there is nowhere for a fix to hide, so `false` is decisive and says so.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 2 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        [tree(CANDIDATE)]: 'same-tree',
        [tree(REPAIR_HEAD)]: 'same-tree',
      }),
    });

    expect(res.stillBrokenCount).toBe(1);
    expect(res.stillBrokenNeedsRunCount).toBe(0);
    expect(res.distinctFailingFiles[0].reading).toMatch(/This one is real work/i);
    expect(res.changedBetweenRefs).toEqual({ count: 0, sample: [] });
  });

  it('reads an EMPTY diff as "nothing moved", never as an unreadable command', async () => {
    // `git diff --name-only` prints nothing both when nothing changed and when the call
    // failed, and the shared fail-soft runner collapses empty stdout to null. Deciding
    // between them from that alone would reintroduce the exact confident-wrong reading
    // this module exists to remove, so the tree ids are compared FIRST.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        [tree(CANDIDATE)]: 'same-tree',
        [tree(REPAIR_HEAD)]: 'same-tree',
        [nameOnly]: null, // indistinguishable from a failure at this layer
      }),
    });

    expect(res.changedBetweenRefs).toEqual({ count: 0, sample: [] });
    expect(res.stillBrokenNeedsRunCount).toBe(0);
  });

  it('hedges when it cannot tell whether anything else moved', async () => {
    // Unknown must not degrade to the confident reading. An unreadable comparison is
    // evidence of nothing, and the row has to say so rather than pick a side.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: 'libs/a/b.test.ts', status: 'fail', attempts: 1 }] }),
      git: fakeGit({
        [revParse(CANDIDATE, 'libs/a/b.test.ts')]: 'deadbeef',
        [revParse(REPAIR_HEAD, 'libs/a/b.test.ts')]: 'deadbeef',
        // no tree ids, no diff ⇒ unknown
      }),
    });

    expect(res.distinctFailingFiles[0].reading).not.toMatch(/This one is real work/i);
    expect(res.stillBrokenNeedsRunCount).toBe(1);
    expect(res.changedBetweenRefs).toBeNull();
  });

  describe('when repairHead has not advanced from the candidate (EI-22131981911313887)', () => {
    /**
     * The ordinary state of a freshly-frozen queue: `repairHead` starts equal to `candidate`
     * and stays there until a fixer commits. Measured 2026-09-02, ALL THREE live installs
     * (papercusp / oddsmith / hello-world-3) sat in exactly this state.
     */
    const sameShaResult = () =>
      readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: CANDIDATE,
        root: '/repo',
        sql: fakeSql({
          filesJudged: 5550,
          failing: [{ file_path: 'packages/operator-core/lib/kopia-backup-guard.test.ts', status: 'fail', attempts: 4 }],
        }),
        // Deliberately EMPTY: with one ref there is nothing to compare, so a correct
        // implementation must not need a single blob lookup to answer.
        git: fakeGit({}),
      });

    it('does not render a self-comparison that reads as an implementation bug', async () => {
      // The WRONG reading first: `git rev-parse <sha>:<path> vs <sha>:<path>` names the same
      // sha twice. It was filed as "the cell compares the candidate blob against ITSELF",
      // costing a reporter's investigation and this one — the comparison string is the only
      // thing a reader has, and it described a two-ref measurement that never happened.
      const res = await sameShaResult();
      const { comparison } = res.distinctFailingFiles[0];

      expect(comparison).not.toMatch(
        new RegExp(`${CANDIDATE.slice(0, 12)}:[^\\s]+\\s+vs\\s+${CANDIDATE.slice(0, 12)}:`),
      );
      expect(comparison).toMatch(/not compared/i);
      expect(comparison).toMatch(/repairHead is still the frozen candidate/i);
    });

    it('does not claim "nothing else moved between the two refs" when there is only one ref', async () => {
      // `movesBetween` diffs a ref against itself and honestly returns `none`, which used to
      // feed the STRONGEST hedge-free reading. True by luck, but derived from a vacuous
      // comparison and phrased as though two refs had been examined.
      const res = await sameShaResult();
      const { reading } = res.distinctFailingFiles[0];

      expect(reading).not.toMatch(/nothing else moved between/i);
      expect(reading).toMatch(/repairHead has not advanced/i);
      expect(reading).toMatch(/no fixer has committed/i);
    });

    it('KEEPS the still-broken verdict — the fix must not be an over-correction to null', async () => {
      // Guards the deliberate call made when this was fixed. Nothing can have landed on a head
      // that has not moved, so these files ARE genuinely unrepaired and "go fix them" is right.
      // Downgrading them to `null` would zero `stillBrokenCount` and flip the assessment to
      // `unmeasured` exactly when a fresh queue's advice is most actionable — the
      // reassuring-degradation failure this cell exists to prevent.
      const res = await sameShaResult();

      expect(res.distinctFailingFiles[0].fixInRepairHead).toBe(false);
      expect(res.stillBrokenCount).toBe(1);
      expect(res.alreadyFixedCount).toBe(0);
      expect(res.assessment).toBe('repairs-outstanding');
    });

    it('does not presume a hidden non-test carrier when the refs are identical', async () => {
      // `stillBrokenNeedsRunCount` flags rows whose fix might ride a non-test file that moved.
      // With one ref nothing moved at all, so nothing is merely PRESUMED broken.
      const res = await sameShaResult();

      expect(res.stillBrokenNeedsRunCount).toBe(0);
    });
  });

  describe('nonTestLegs (WI-2143253)', () => {
    it('is an UNMEASURED object — never null — when the caller has no repairTickLegs measurement (C2)', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
      });
      // D-003 §2: code plus null FIELDS, never a bare null subtree. The independent grader
      // (EI-22270968007901491, C2) measured the live cell downgrading to `unavailable`
      // because `nonTestLegs.perLeg` — a declared evidence path — vanished with the null.
      expect(res.nonTestLegs).not.toBeNull();
      expect(res.nonTestLegsMeasured).toBe('not-recorded');
      expect(res.nonTestLegs).toMatchObject({ current: null, head: null, atMs: null, all: [], failing: [], perLeg: [], outstanding: [] });
      expect(res.nonTestLegs.reading).toMatch(/NOT MEASURED/);
      expect(res.nonTestLegs.shrink.measured).toBe(false);
    });

    it('names which non-test legs are failing, not just that something was measured', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:design-primitives', 'lint:plane-integrity'],
          legs: [
            { id: 'lint:design-primitives', status: 'fail', durationMs: 420 },
            { id: 'lint:plane-integrity', status: 'errored', durationMs: 10 },
            { id: 'lint:tsc', status: 'pass', durationMs: 5000 },
          ],
        },
      });
      expect(res.nonTestLegs).not.toBeNull();
      expect(res.nonTestLegs?.current).toBe(true);
      expect(res.nonTestLegs?.all).toHaveLength(3);
      expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:design-primitives', 'lint:plane-integrity']);
      expect(res.nonTestLegs?.reading).toMatch(/lint:design-primitives/);
      expect(res.nonTestLegs?.reading).toMatch(/lint:plane-integrity/);
    });

    it('reports current:false and hedges the reading when the measurement predates repairHead', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        // A measurement taken at an EARLIER repairHead the queue has since moved past —
        // repairHeadSha does not start with this head.
        repairTickLegs: {
          head: 'ffffffffffff',
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:tsc'],
          legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 1 }],
        },
      });
      expect(res.nonTestLegs?.current).toBe(false);
      expect(res.nonTestLegs?.reading).toMatch(/STALE/);
    });

    it('says all legs passed when none are failing, distinct from "nothing was measured"', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: fakeSql({ filesJudged: 1, failing: [] }),
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: true,
          failingSignatures: [],
          legs: [{ id: 'lint:tsc', status: 'pass', durationMs: 1 }],
        },
      });
      expect(res.nonTestLegs?.failing).toEqual([]);
      expect(res.nonTestLegs?.reading).toMatch(/passed/i);
    });

    it('survives on the unavailable path — a test_runs failure must not also lose the leg measurement', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: CANDIDATE,
        repairHeadSha: REPAIR_HEAD,
        root: '/repo',
        sql: (() => {
          throw new Error('connection refused');
        }) as never,
        repairTickLegs: {
          head: REPAIR_HEAD.slice(0, 12),
          atMs: 1_000,
          ok: false,
          failingSignatures: ['lint:tsc'],
          legs: [{ id: 'lint:tsc', status: 'fail', durationMs: 1 }],
        },
      });
      expect(res.assessment).toBe('unmeasured');
      expect(res.nonTestLegs).not.toBeNull();
      expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:tsc']);
    });

    it('survives on the no-frozen-candidate path', async () => {
      const res = await readGateCandidateFailures({
        candidateSha: null,
        repairHeadSha: null,
        root: '/repo',
        repairTickLegs: {
          head: 'abc123def456',
          atMs: 1_000,
          ok: true,
          failingSignatures: [],
          legs: [],
        },
      });
      expect(res.assessment).toBe('no-frozen-candidate');
      // No live repairHead to compare against ⇒ currency is unknown, not false.
      expect(res.nonTestLegs?.current).toBeNull();
    });
  });
});

describe('P-003 — the named per-leg surface that replaced postSuiteMeasured', () => {
  const legsSnap = {
    head: REPAIR_HEAD.slice(0, 12),
    atMs: 1_800_000_000_000,
    ok: false,
    failingSignatures: ['lint:design-primitives'],
    legs: [
      { id: 'lint:design-primitives', status: 'fail' as const, durationMs: 120 },
      { id: 'lint:tsc', status: 'pass' as const, durationMs: 90 },
    ],
  };

  /** A cycle that still has `lint:plane-ratchet` failing — which THIS tick did not measure. */
  const queueLegs: FrozenRepairLegState[] = [
    {
      id: 'lint:plane-ratchet',
      state: 'failing' as const,
      admittedRound: 1,
      admittedHead: REPAIR_HEAD.slice(0, 12),
      admittedAtMs: 1_799_999_000_000,
      lastMeasuredHead: REPAIR_HEAD.slice(0, 12),
      lastMeasuredAtMs: 1_799_999_000_000,
      lastMeasuredRound: 1,
      failingRounds: 1,
    },
    {
      id: 'lint:design-primitives',
      state: 'failing' as const,
      admittedRound: 1,
      admittedHead: REPAIR_HEAD.slice(0, 12),
      admittedAtMs: 1_799_999_000_000,
      lastMeasuredHead: REPAIR_HEAD.slice(0, 12),
      lastMeasuredAtMs: 1_800_000_000_000,
      lastMeasuredRound: 1,
      failingRounds: 1,
    },
  ];

  async function read(opts: { queueLegs?: readonly FrozenRepairLegState[] } = {}) {
    return readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
      git: fakeGit({}),
      repairTickLegs: legsSnap,
      ...(opts.queueLegs ? { queueLegs: opts.queueLegs } : {}),
    });
  }

  it('C2 FALSIFIER: with NO tick snapshot, queue-admitted FAILING legs still surface by name and stay outstanding (not measuring is not a pass)', async () => {
    // Before C2 (EI-22270968007901491) `nonTestLegs` was null whenever no repair-tick
    // snapshot existed — so a cycle that had ADMITTED two failing legs rendered nothing, the
    // declared evidence paths vanished, and the verdict read `none-failing`. The lifecycle
    // is real evidence on its own (D-005 §4): list every admitted leg as not-measured, and
    // keep a failing one outstanding until something actually measures it passing.
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
      git: fakeGit({}),
      queueLegs,
      // deliberately NO repairTickLegs
    });
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    expect(res.nonTestLegs.head).toBeNull();
    expect(res.nonTestLegs.all).toEqual([]);
    expect(res.nonTestLegs.perLeg.map((l) => [l.id, l.measuredNow, l.lifecycle])).toEqual([
      ['lint:design-primitives', 'not-measured', 'failing'],
      ['lint:plane-ratchet', 'not-measured', 'failing'],
    ]);
    expect(res.nonTestLegs.outstanding).toEqual(['lint:design-primitives', 'lint:plane-ratchet']);
    expect(res.nonTestLegs.reading).toMatch(/NOT MEASURED/);
    expect(res.nonTestLegs.reading).toMatch(/lint:plane-ratchet/);
    // The shrink reading still comes from the lifecycle, unchanged by the missing snapshot.
    expect(res.nonTestLegs.shrink.failingLegIds).toEqual(['lint:design-primitives', 'lint:plane-ratchet']);
    // …and the VERDICT sees them: zero failing files + an unrepaired admitted leg is not an all-clear.
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('CALIBRATION: a leg measurement makes the answer "measured" and names the failing leg', async () => {
    const res = await read();
    expect(res.nonTestLegsMeasured).toBe('measured');
    expect(res.nonTestLegs?.failing.map((l) => l.id)).toEqual(['lint:design-primitives']);
  });

  it('LOAD-BEARING: no leg measurement reads as NOT-RECORDED, never as "no legs failing"', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: [] }),
      git: fakeGit({}),
    });
    // The old `postSuiteMeasured: null` was indistinguishable from "measured, came back
    // empty" — and it resolved null forever, because no caller ever supplied it.
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    // C2 (EI-22270968007901491): NEVER null — the cell's declared evidence paths
    // (`nonTestLegs.perLeg` / `.outstanding`) must ARRIVE, and the flag beside them is what
    // says they are unmeasured. A null subtree made assessmentFrom downgrade the whole cell.
    expect(res.nonTestLegs.perLeg).toEqual([]);
    expect(res.nonTestLegs.outstanding).toEqual([]);
    expect(res.nonTestLegs.head).toBeNull();
    expect(res.nonTestLegs.current).toBeNull();
    expect(res.nonTestLegs.reading).toMatch(/NOT MEASURED/);
    // ...and the scope sentence must still refuse the green reading.
    expect(res.scope).toMatch(/BY NAME/);
  });

  it('LOAD-BEARING: a leg the tick did NOT measure is still NAMED, not dropped', async () => {
    // The union is the whole point. Intersecting would silently drop lint:plane-ratchet
    // because this tick did not run it — rendering "we did not look" as "not on the list".
    const res = await read({ queueLegs });
    const ids = res.nonTestLegs!.perLeg.map((l) => l.id);
    expect(ids).toContain('lint:plane-ratchet');
    const ratchet = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:plane-ratchet')!;
    expect(ratchet.measuredNow).toBe('not-measured');
    expect(ratchet.lifecycle).toBe('failing');
    expect(ratchet.reading).toMatch(/not a pass/i);

    // The control: an intersection-shaped answer loses it entirely.
    const intersected = legsSnap.legs.filter((l) => queueLegs.some((q) => q.id === l.id)).map((l) => l.id);
    expect(intersected).not.toContain('lint:plane-ratchet');
  });

  it('LOAD-BEARING: "did its fix land" is answered with a HEAD, never a bare boolean', async () => {
    const fixed: FrozenRepairLegState[] = [
      {
        ...queueLegs[0]!,
        id: 'lint:tsc',
        state: 'fixed',
        resolvedHead: REPAIR_HEAD.slice(0, 12),
        resolvedAtMs: 1_800_000_000_000,
      },
    ];
    const res = await read({ queueLegs: fixed });
    const tsc = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:tsc')!;
    expect(tsc.lifecycle).toBe('fixed');
    // A bare `true` invites "the fix is in the CURRENT head". The sha is the claim.
    expect(tsc.fixedAtHead).toBe(REPAIR_HEAD.slice(0, 12));
    expect(tsc.reading).toMatch(/Do NOT go fix it/);
  });

  it('a leg measured but never admitted reads as never-admitted, not as repair work', async () => {
    const res = await read();
    const tsc = res.nonTestLegs!.perLeg.find((l) => l.id === 'lint:tsc')!;
    expect(tsc.lifecycle).toBe('never-admitted');
    expect(tsc.admittedRound).toBeNull();
    expect(tsc.fixedAtHead).toBeNull();
  });

  it('the leg shrink reading carries its own scope, so it is never differenced against file counts', async () => {
    const res = await read({ queueLegs });
    expect(res.nonTestLegs!.shrink.measured).toBe(true);
    expect(res.nonTestLegs!.shrink.failingLegIds).toEqual(['lint:design-primitives', 'lint:plane-ratchet']);
    expect(res.nonTestLegs!.shrink.scope).toMatch(/do not subtract them/i);
    // Unmeasured legs: null shrink, never a reassuring zero.
    const noLifecycle = await read();
    expect(noLifecycle.nonTestLegs!.shrink.measured).toBe(false);
    expect(noLifecycle.nonTestLegs!.shrink.shrinkTotal).toBeNull();
  });
});

/**
 * main-green-status-visible-2026-09-03 P-007 — THE FALSIFIER THAT MATTERS MOST.
 *
 * Before this block the verdict was `files.length === 0 ? 'none-failing' : …`: it counted
 * TEST FILES only, so a gate wedged on a red lint/perf/desktop/delta leg with zero failing
 * test files read `none-failing` on the one cell whose job is to say what is failing. That
 * is "measured empty renders as nothing failing" (P-012) one leg over. The deliberately
 * wrong control is kept in this file so the property, not just today's code, is what is
 * being tested.
 */
describe('P-007 — a red non-test leg is NEVER none-failing on any reading of this cell', () => {
  const SHORT = REPAIR_HEAD.slice(0, 12);
  const tick = (legs: Array<{ id: string; status: 'pass' | 'fail' | 'errored' }>, head = SHORT) => ({
    head,
    atMs: 1_800_000_000_000,
    ok: legs.every((l) => l.status === 'pass'),
    failingSignatures: legs.filter((l) => l.status !== 'pass').map((l) => l.id),
    legs: legs.map((l) => ({ ...l, durationMs: 10 })),
  });
  const lifecycle = (id: string, state: 'failing' | 'fixed'): FrozenRepairLegState => ({
    id,
    state,
    admittedRound: 1,
    admittedHead: SHORT,
    admittedAtMs: 1_799_999_000_000,
    lastMeasuredHead: SHORT,
    lastMeasuredAtMs: 1_799_999_500_000,
    lastMeasuredRound: 1,
    failingRounds: state === 'failing' ? 1 : 0,
    ...(state === 'fixed' ? { resolvedHead: SHORT, resolvedAtMs: 1_800_000_000_000 } : {}),
  });
  const lintSignature: RepairSignatureEntry = {
    kind: 'lint-leg',
    id: 'lint:tsc',
    recipe: 'npm run lint:tsc',
    admittedRound: 1,
    measuredHead: SHORT,
  };
  const read = (opts: {
    repairTickLegs?: ReturnType<typeof tick>;
    queueLegs?: readonly FrozenRepairLegState[];
    queueSignature?: readonly RepairSignatureEntry[];
    failing?: Row[];
    git?: Record<string, string | null>;
  }) =>
    readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql({ filesJudged: 223, failing: opts.failing ?? [] }),
      git: fakeGit(opts.git ?? {}),
      ...(opts.repairTickLegs ? { repairTickLegs: opts.repairTickLegs } : {}),
      ...(opts.queueLegs ? { queueLegs: opts.queueLegs } : {}),
      ...(opts.queueSignature ? { queueSignature: opts.queueSignature } : {}),
    });

  /** The pre-P-007 rule, verbatim in shape — kept as the control that must NOT be what ships. */
  const preP007Rule = (fileCount: number, stillBroken: number, alreadyFixed: number) =>
    fileCount === 0 ? 'none-failing' : stillBroken > 0 ? 'repairs-outstanding' : alreadyFixed === fileCount ? 'all-fixes-contained' : 'unmeasured';

  it('THE FALSIFIER: zero failing test files + a red lint leg is non-test-leg-failing, and the leg is NAMED', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]) });
    expect(res.stillBrokenCount).toBe(0);
    expect(res.nonTestLegsMeasured).toBe('measured');
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.assessment).toBe('non-test-leg-failing');
    expect(res.assessment).not.toBe('none-failing');
    // The control reproduces the defect on the same inputs — so this test discriminates.
    expect(preP007Rule(0, 0, 0)).toBe('none-failing');
  });

  it('CALIBRATION: every leg passing with zero failing files IS none-failing', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }, { id: 'perf', status: 'pass' }]) });
    expect(res.nonTestLegs!.outstanding).toEqual([]);
    expect(res.assessment).toBe('none-failing');
  });

  it('an errored leg is red, not "not a fail"', async () => {
    const res = await read({ repairTickLegs: tick([{ id: 'desktop', status: 'errored' }]) });
    expect(res.assessment).toBe('non-test-leg-failing');
    expect(res.nonTestLegs!.outstanding).toEqual(['desktop']);
  });

  it('NOT MEASURING a leg the cycle has FAILING is not a pass — it stays outstanding', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }]),
      queueLegs: [lifecycle('lint:plane-ratchet', 'failing')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:plane-ratchet']);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('an unmeasured queue-signature lint leg stays named and outstanding before the first repair tick', async () => {
    const res = await read({ queueSignature: [lintSignature] });

    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    expect(res.nonTestLegs!.perLeg).toMatchObject([
      { id: 'lint:tsc', measuredNow: 'not-measured', lifecycle: 'failing', admittedRound: 1 },
    ]);
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.nonTestLegs!.reading).toMatch(/lint:tsc/);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('a current repair-tick pass resolves a signature-only lint leg before queue lifecycle is persisted', async () => {
    const res = await read({
      queueSignature: [lintSignature],
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }]),
    });

    expect(res.nonTestLegs!.current).toBe(true);
    expect(res.nonTestLegs!.perLeg).toMatchObject([
      { id: 'lint:tsc', measuredNow: 'pass', lifecycle: 'fixed', fixedAtHead: SHORT, admittedRound: 1 },
    ]);
    expect(res.nonTestLegs!.outstanding).toEqual([]);
    expect(res.assessment).toBe('all-fixes-contained');
  });

  it('a stale repair-tick pass does not erase a signature-only lint leg red', async () => {
    const res = await read({
      queueSignature: [lintSignature],
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }], '0123456789ab'),
    });

    expect(res.nonTestLegs!.current).toBe(false);
    expect(res.nonTestLegs!.perLeg).toMatchObject([
      { id: 'lint:tsc', measuredNow: 'pass', lifecycle: 'failing', admittedRound: 1 },
    ]);
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('a leg whose own re-run PASSED reads all-fixes-contained — never none-failing, never outstanding', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }]),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual([]);
    // "Nothing failing" would erase the fact that something WAS red and is awaiting
    // re-verification; the converging code is the honest one.
    expect(res.assessment).toBe('all-fixes-contained');
  });

  it('a fixed leg measured RED again is a regression — outstanding, not "already fixed"', async () => {
    const res = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(res.assessment).toBe('non-test-leg-failing');
  });

  it('a STALE tick (measured at an earlier repairHead) is not evidence either way — only the lifecycle counts', async () => {
    const stalePass = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'pass' }], '0123456789ab'),
      queueLegs: [lifecycle('lint:tsc', 'failing')],
    });
    expect(stalePass.nonTestLegs!.current).toBe(false);
    expect(stalePass.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
    expect(stalePass.assessment).toBe('non-test-leg-failing');

    const staleFail = await read({
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }], '0123456789ab'),
      queueLegs: [lifecycle('lint:tsc', 'fixed')],
    });
    expect(staleFail.nonTestLegs!.outstanding).toEqual([]);
    expect(staleFail.assessment).toBe('all-fixes-contained');
  });

  it('a red leg OUTRANKS "every file already fixed" — all-fixes-contained is reserved for nothing left to do', async () => {
    const p = 'lib/a.test.ts';
    const res = await read({
      failing: [{ file_path: p, status: 'fail', attempts: 1 }],
      git: { [revParse(CANDIDATE, p)]: 'blob-old', [revParse(REPAIR_HEAD, p)]: 'blob-new' },
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
    });
    expect(res.alreadyFixedCount).toBe(1);
    expect(res.stillBrokenCount).toBe(0);
    expect(res.assessment).toBe('non-test-leg-failing');
    // …and the control would have called it converging.
    expect(preP007Rule(1, 0, 1)).toBe('all-fixes-contained');
  });

  it('a still-broken FILE still outranks the leg — but the leg stays named beside it', async () => {
    const p = 'lib/a.test.ts';
    const res = await read({
      failing: [{ file_path: p, status: 'fail', attempts: 1 }],
      git: { [revParse(CANDIDATE, p)]: 'blob-same', [revParse(REPAIR_HEAD, p)]: 'blob-same' },
      repairTickLegs: tick([{ id: 'lint:tsc', status: 'fail' }]),
    });
    expect(res.assessment).toBe('repairs-outstanding');
    expect(res.nonTestLegs!.outstanding).toEqual(['lint:tsc']);
  });

  it('no leg measurement at all leaves the file-only verdict alone (the P-012 flag says the legs were not looked at)', async () => {
    const res = await read({});
    expect(res.nonTestLegsMeasured).toBe('not-recorded');
    // C2 (EI-22270968007901491): NEVER null — the cell's declared evidence paths
    // (`nonTestLegs.perLeg` / `.outstanding`) must ARRIVE, and the flag beside them is what
    // says they are unmeasured. A null subtree made assessmentFrom downgrade the whole cell.
    expect(res.nonTestLegs.perLeg).toEqual([]);
    expect(res.nonTestLegs.outstanding).toEqual([]);
    expect(res.nonTestLegs.head).toBeNull();
    expect(res.nonTestLegs.current).toBeNull();
    expect(res.nonTestLegs.reading).toMatch(/NOT MEASURED/);
    expect(res.assessment).toBe('none-failing');
  });

  describe('the pure rules, so a future reorder of the branches fails HERE with the case named', () => {
    it('assessCandidateFailures — first match, in this order', () => {
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 1, alreadyFixedCount: 1, passedAtRepairHeadCount: 0, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('repairs-outstanding');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('non-test-leg-failing');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 2, passedAtRepairHeadCount: 0, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('non-test-leg-failing');
      // EI-24654779657165409: every file passed at repairHead, one leg still red → the LEG.
      expect(assessCandidateFailures({ fileCount: 20, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 20, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('non-test-leg-failing');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 1, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('unmeasured');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 2, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('all-fixes-contained');
      // A file PASSED at repairHead is resolved, so it never leaves the rest reading unmeasured.
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 1, passedAtRepairHeadCount: 1, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('all-fixes-contained');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 1, staleUnadmittedLegs: 0 })).toBe('all-fixes-contained');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: 0 })).toBe('none-failing');
    });

    it('outstandingLegIds — the one rule the assessment and the readings share', () => {
      const row = (id: string, measuredNow: 'pass' | 'fail' | 'errored' | 'not-measured', lifecycle: 'failing' | 'fixed' | 'never-admitted') => ({ id, measuredNow, lifecycle });
      // current head (true or unknown): this tick's result decides when it exists
      expect(outstandingLegIds([row('a', 'fail', 'never-admitted'), row('b', 'pass', 'failing'), row('c', 'not-measured', 'failing'), row('d', 'not-measured', 'never-admitted'), row('e', 'errored', 'fixed')], true)).toEqual(['a', 'c', 'e']);
      expect(outstandingLegIds([row('a', 'fail', 'never-admitted')], null)).toEqual(['a']);
      // stale head: only the lifecycle
      expect(outstandingLegIds([row('a', 'fail', 'fixed'), row('b', 'pass', 'failing'), row('c', 'fail', 'never-admitted')], false)).toEqual(['b']);
    });

    // WI-10005727 — observed 2026-10-02 on queue 6ca43115: 11 legs measured `fail` at a stale
    // head, all never-admitted, and the cell read `none-failing`. A stale red with no
    // lifecycle is "unknown at repairHead", never an all-clear.
    it('staleUnadmittedRedLegIds — the legs outstandingLegIds refuses must not vanish from the verdict', () => {
      const row = (id: string, measuredNow: 'pass' | 'fail' | 'errored' | 'not-measured', lifecycle: 'failing' | 'fixed' | 'never-admitted') => ({ id, measuredNow, lifecycle });
      const legs = [row('a', 'fail', 'never-admitted'), row('b', 'errored', 'never-admitted'), row('c', 'pass', 'never-admitted'), row('d', 'not-measured', 'never-admitted'), row('e', 'fail', 'fixed'), row('f', 'fail', 'failing')];
      expect(staleUnadmittedRedLegIds(legs, false)).toEqual(['a', 'b']);
      // At the current head (or unknown currency) outstandingLegIds already counts them — no double count.
      expect(staleUnadmittedRedLegIds(legs, true)).toEqual([]);
      expect(staleUnadmittedRedLegIds(legs, null)).toEqual([]);
      // The exact observed shape: every red leg stale + never-admitted → nothing outstanding, so the
      // verdict must come from the stale count, and it must not be either all-clear.
      const observed = [row('lint:tsc', 'fail', 'never-admitted'), row('lint:migrations', 'pass', 'never-admitted')];
      expect(outstandingLegIds(observed, false)).toEqual([]);
      const verdict = assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: staleUnadmittedRedLegIds(observed, false).length });
      expect(verdict).toBe('unmeasured');
      // Rank: real work still outranks it; it outranks both all-clears.
      expect(assessCandidateFailures({ fileCount: 1, stillBrokenCount: 1, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 0, staleUnadmittedLegs: 3 })).toBe('repairs-outstanding');
      expect(assessCandidateFailures({ fileCount: 0, stillBrokenCount: 0, alreadyFixedCount: 0, passedAtRepairHeadCount: 0, outstandingLegs: 1, fixedLegs: 0, staleUnadmittedLegs: 3 })).toBe('non-test-leg-failing');
      expect(assessCandidateFailures({ fileCount: 2, stillBrokenCount: 0, alreadyFixedCount: 2, passedAtRepairHeadCount: 0, outstandingLegs: 0, fixedLegs: 1, staleUnadmittedLegs: 1 })).toBe('unmeasured');
    });
  });
});

/**
 * EI-23433375151859491 — a failing path recorded SUBMODULE-relative read as UNMEASURABLE.
 *
 * `test_runs.file_path` stores the path exactly as the runner recorded it, and a suite that ran
 * INSIDE a submodule records `src/dispatch-projected.test.ts`, never
 * `libs/generic/tooldef/src/dispatch-projected.test.ts`. That matches no superproject prefix, so
 * both blobs came back null and the row degraded to UNMEASURABLE — which is indistinguishable
 * from an unfixed file and therefore UNDER-reports how converged a frozen queue is. The two
 * worst responses to a red gate follow from it: re-fixing a file whose fix already landed, or
 * retiring a queue that was about to go green.
 *
 * Nomination is a real filesystem test (`existsSync`), so these cases need real files on disk —
 * a stubbed fs would assert the SHAPE of the fix rather than the fix. Hence mkdtemp.
 */
describe('EI-23433375151859491 — a failing path recorded submodule-relative', () => {
  const SUB = 'libs/generic/tooldef';
  const OTHER = 'libs/generic/search';
  const SUBS = [SUB, OTHER];
  const ONLY_IN_SUB = 'src/dispatch-projected.test.ts';
  const IN_BOTH = 'src/index.test.ts';
  // The measured 2026-09-16 case named in the module's own comment: the row read "says nothing
  // either way" when the true answer was FIXED.
  const CAND_PIN = '152598ba45158ae1c5349aadecae8285b5f04136';
  const HEAD_PIN = 'c1c1807bc78d0000000000000000000000000000';

  let root: string;

  beforeAll(() => {
    // Two submodules that BOTH carry a `src/`, as 35 of this repo's 38 do — that overlap is
    // what makes a bare `src/...` path genuinely ambiguous rather than merely unresolved.
    root = mkdtempSync(join(tmpdir(), 'gate-candidate-failures-'));
    mkdirSync(join(root, SUB, 'src'), { recursive: true });
    mkdirSync(join(root, OTHER, 'src'), { recursive: true });
    writeFileSync(join(root, SUB, ONLY_IN_SUB), '');
    writeFileSync(join(root, SUB, IN_BOTH), '');
    writeFileSync(join(root, OTHER, IN_BOTH), '');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  describe('submoduleRelativeCandidates — nomination only, never the verdict', () => {
    it('nominates the ONE submodule holding the file, where the superproject prefix match cannot', () => {
      // The wrong answer first: `submoduleFor` matches a SUPERPROJECT-relative prefix, and this
      // path has none — which is exactly how it fell through to a batch that can never resolve it.
      expect(SUBS.find((s) => ONLY_IN_SUB === s || ONLY_IN_SUB.startsWith(s + '/'))).toBeUndefined();
      expect(submoduleRelativeCandidates(root, ONLY_IN_SUB, SUBS)).toEqual([SUB]);
    });

    it('returns EVERY match for a shared path, so a caller cannot quietly take the first', () => {
      expect(submoduleRelativeCandidates(root, IN_BOTH, SUBS)).toEqual([SUB, OTHER]);
    });

    it('nominates nothing for a path no submodule has, leaving the superproject answer untouched', () => {
      expect(submoduleRelativeCandidates(root, 'src/not-here.test.ts', SUBS)).toEqual([]);
    });

    it('refuses an absolute path, a climb out of the tree, and an empty one', () => {
      expect(submoduleRelativeCandidates(root, '/etc/passwd', SUBS)).toEqual([]);
      expect(submoduleRelativeCandidates(root, `../${SUB}/${ONLY_IN_SUB}`, SUBS)).toEqual([]);
      expect(submoduleRelativeCandidates(root, '', SUBS)).toEqual([]);
    });
  });

  it('reads the FIXED blob inside the submodule for a path the superproject cannot resolve', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root,
      // REQUIRED: `subs` comes from opts.submodulePaths. Without it there is nothing to nominate
      // against and the row degrades exactly as it did before this fix.
      submodulePaths: SUBS,
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: ONLY_IN_SUB, status: 'fail', attempts: 2 }] }),
      git: fakeGit({
        // Deliberately NO superproject fixture for ONLY_IN_SUB — that miss is the whole trigger.
        [revParse(CANDIDATE, SUB)]: CAND_PIN,
        [revParse(REPAIR_HEAD, SUB)]: HEAD_PIN,
        [revParse(CAND_PIN, ONLY_IN_SUB)]: '8a1dd5928fe6',
        [revParse(HEAD_PIN, ONLY_IN_SUB)]: '7bbb58297abf',
      }),
    });

    const row = res.distinctFailingFiles[0];
    expect(row.fixInRepairHead).toBe(true);
    // Two blob ids as evidence, where the bug returned a pair of nulls.
    expect(row.candidateBlob).toBe('8a1dd5928fe6');
    expect(row.repairHeadBlob).toBe('7bbb58297abf');
    expect(row.comparison).toMatch(/recorded submodule-relative/);
    expect(row.reading).toMatch(/Do NOT re-fix/i);
    // The wrong reading this case exists to stop returning.
    expect(row.reading).not.toMatch(/UNMEASURABLE/);
    expect(res.stillBrokenCount).toBe(0);
  });

  it('reports an ambiguous path as UNMEASURABLE rather than guessing the first submodule', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root,
      submodulePaths: SUBS,
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: IN_BOTH, status: 'fail', attempts: 1 }] }),
      git: fakeGit({}),
    });

    const row = res.distinctFailingFiles[0];
    expect(row.fixInRepairHead).toBeNull();
    expect(row.comparison).toMatch(/ambiguous submodule-relative path/);
    expect(row.reading).toMatch(/genuinely undetermined/);
    // A confident wrong answer where an honest unknown belongs is the failure being avoided,
    // so the unknown must not read as "nothing landed".
    expect(row.reading).toMatch(/NOT a claim that nothing landed/);
  });

  it('keeps an unreadable pin UNKNOWN instead of collapsing it to "unchanged"', async () => {
    const res = await readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root,
      submodulePaths: SUBS,
      sql: fakeSql({ filesJudged: 12, failing: [{ file_path: ONLY_IN_SUB, status: 'fail', attempts: 1 }] }),
      // The candidate pins the submodule; the repairHead pin does not read.
      git: fakeGit({
        [revParse(CANDIDATE, SUB)]: CAND_PIN,
        [revParse(CAND_PIN, ONLY_IN_SUB)]: '8a1dd5928fe6',
      }),
    });

    const row = res.distinctFailingFiles[0];
    // `false` here would be the reassuring degradation: it reads as "no fix has landed".
    expect(row.fixInRepairHead).toBeNull();
    expect(row.reading).toMatch(/says nothing either way/);
  });
});
