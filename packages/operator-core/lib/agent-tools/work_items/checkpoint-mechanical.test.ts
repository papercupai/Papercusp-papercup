/**
 * R-8 / P-009 (plan derived-status-not-hand-written-2026-10-12, D-004): the
 * mechanical section of a held work item is derived from the ledgers at READ
 * time, matches them on every read, and is never stored.
 */
import { describe, expect, it } from 'vitest';
import {
  MECHANICS_FILES_CAP,
  deriveWorkItemMechanics,
  latestRunPerFile,
  readWorkItemMechanics,
  relatedTestFiles,
  toRepoRelative,
  type MechanicsLedger,
  type MechanicsTestRunRow,
} from './_mechanics';

const ROOT = '/home/u/ws/papercusp';
const HELD = { id: 'WI-1', harness: 'papercusp', assignee: 'su-aaaa1111', takenAt: '2026-10-12T16:00:00.000Z' };

function run(file: string, status: string, finishedAt: string, extra: Partial<MechanicsTestRunRow> = {}): MechanicsTestRunRow {
  return { file_path: file, status, finished_at: finishedAt, source: 'local', worktree_dirty: true, commit_sha: 'abc1234', passed: status === 'pass' ? 3 : 1, failed: status === 'pass' ? 0 : 2, ...extra };
}

/** A ledger whose rows the test can change between reads, and which counts its calls. */
function fakeLedger(state: { writes: Array<{ file?: string; command?: string }>; runs: MechanicsTestRunRow[]; blockers: unknown[] }) {
  const calls = { testRunFiles: [] as string[][] };
  const ledger: MechanicsLedger = {
    writeRows: async () => state.writes,
    testRuns: async (files) => {
      calls.testRunFiles.push([...files]);
      return state.runs.filter((r) => files.includes(r.file_path));
    },
    blockers: async () => state.blockers as never[],
    repoRoots: async () => [ROOT],
  };
  return { ledger, calls };
}

describe('checkpoint mechanical section — pure derivation', () => {
  it('relativizes paths under the harness root and rejects paths outside it', () => {
    expect(toRepoRelative(`${ROOT}/packages/a/x.ts`, [ROOT])).toBe('packages/a/x.ts');
    expect(toRepoRelative(`${ROOT}/`, [`${ROOT}/`])).toBeNull();
    expect(toRepoRelative('/tmp/scratch.ts', [ROOT])).toBeNull();
    expect(toRepoRelative('./apps/b.ts', [ROOT])).toBe('apps/b.ts');
  });

  it('maps written sources to exact sibling test paths and keeps written test files', () => {
    expect(relatedTestFiles(['lib/a.ts', 'lib/b.test.ts', 'docs/c.md'])).toEqual([
      'lib/a.test.ts', 'lib/a.test.tsx', 'lib/a.integration.test.ts', 'lib/a.spec.ts', 'lib/b.test.ts',
    ]);
  });

  it('keeps only the latest non-probe run per file', () => {
    const latest = latestRunPerFile([
      run('lib/a.test.ts', 'pass', '2026-10-12T16:10:00Z'),
      run('lib/a.test.ts', 'fail', '2026-10-12T16:20:00Z'),
      run('lib/a.test.ts', 'pass', '2026-10-12T16:30:00Z', { source: 'mutation-probe' }),
    ]);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ file: 'lib/a.test.ts', status: 'fail', failed: 2 });
  });

  it('returns null when the item has no live claim window', () => {
    const base = { writeRows: [], repoRoots: [ROOT], testRuns: [], blockers: [] };
    expect(deriveWorkItemMechanics({ ...base, workItem: { id: 'WI-2', assignee: null, takenAt: null } })).toBeNull();
    expect(deriveWorkItemMechanics({ ...base, workItem: { id: 'WI-2', assignee: 'su-x', takenAt: null } })).toBeNull();
  });

  it('derives holder, files, tests and active blockers from the ledger rows', () => {
    const m = deriveWorkItemMechanics({
      workItem: HELD,
      writeRows: [
        { file: `${ROOT}/lib/a.ts` },
        { file: `${ROOT}/lib/a.ts` },
        { file: `${ROOT}/.papercusp/scratch/probe.mts` },
        { file: '/tmp/elsewhere.txt' },
      ],
      repoRoots: [ROOT],
      testRuns: [run('lib/a.test.ts', 'pass', '2026-10-12T16:40:00Z'), run('lib/unrelated.test.ts', 'fail', '2026-10-12T16:41:00Z')],
      blockers: [
        { kind: 'gate', ref: 'gate-x', status: 'active', summary: 'red gate' },
        { kind: 'gate', ref: 'gate-y', status: 'resolved', summary: 'cleared' },
      ],
      now: new Date('2026-10-12T17:00:00Z'),
    });
    expect(m).not.toBeNull();
    expect(m!.derived).toBe('read-time');
    expect(m!.holder).toEqual({ ownerId: 'su-aaaa1111', claimedAt: HELD.takenAt });
    expect(m!.filesWritten).toEqual({ paths: ['lib/a.ts'], total: 1, truncated: false, outsideRepo: 1 });
    expect(m!.tests.attribution).toBe('path-and-claim-window');
    expect(m!.tests.latest.map((t) => t.file)).toEqual(['lib/a.test.ts']);
    expect(m!.tests.verdict).toBe('all-pass');
    expect(m!.openBlockers).toEqual([{ kind: 'gate', ref: 'gate-x', summary: 'red gate' }]);
  });

  it('reports a truncated file list instead of silently cutting it', () => {
    const writeRows = Array.from({ length: MECHANICS_FILES_CAP + 5 }, (_, i) => ({ file: `${ROOT}/lib/f${String(i).padStart(3, '0')}.ts` }));
    const m = deriveWorkItemMechanics({ workItem: HELD, writeRows, repoRoots: [ROOT], testRuns: [], blockers: [] })!;
    expect(m.filesWritten.paths).toHaveLength(MECHANICS_FILES_CAP);
    expect(m.filesWritten).toMatchObject({ total: MECHANICS_FILES_CAP + 5, truncated: true });
    expect(m.tests.verdict).toBe('none');
  });
});

describe('checkpoint mechanical section — read-time, never stored', () => {
  it('re-derives on every read, so a newer ledger row changes the next answer', async () => {
    const state = { writes: [{ file: `${ROOT}/lib/a.ts` }], runs: [run('lib/a.test.ts', 'pass', '2026-10-12T16:10:00Z')], blockers: [] as unknown[] };
    const { ledger } = fakeLedger(state);
    const first = await readWorkItemMechanics(HELD, ledger, new Date('2026-10-12T17:00:00Z'));
    expect(first!.tests.verdict).toBe('all-pass');

    state.runs.push(run('lib/a.test.ts', 'fail', '2026-10-12T16:50:00Z'));
    state.blockers.push({ kind: 'live-dependency', ref: 'WI-9', status: 'active', summary: 'waits on WI-9' });
    const second = await readWorkItemMechanics(HELD, ledger, new Date('2026-10-12T17:05:00Z'));
    expect(second!.tests.verdict).toBe('failing');
    expect(second!.tests.latest[0]).toMatchObject({ status: 'fail', at: '2026-10-12T16:50:00Z' });
    expect(second!.openBlockers).toEqual([{ kind: 'live-dependency', ref: 'WI-9', summary: 'waits on WI-9' }]);
  });

  it('queries test runs only for exact related paths, scoped to the claim window', async () => {
    const { ledger, calls } = fakeLedger({ writes: [{ file: `${ROOT}/lib/a.test.ts` }, { file: `${ROOT}/docs/x.md` }], runs: [], blockers: [] });
    const m = await readWorkItemMechanics(HELD, ledger);
    expect(calls.testRunFiles).toEqual([['lib/a.test.ts']]);
    expect(m!.tests.verdict).toBe('none');
  });

  it('exposes only read methods: the section has no write path to a checkpoint', () => {
    const { ledger } = fakeLedger({ writes: [], runs: [], blockers: [] });
    expect(Object.keys(ledger).sort()).toEqual(['blockers', 'repoRoots', 'testRuns', 'writeRows']);
  });

  it('returns null without touching the ledger when the item is unclaimed', async () => {
    let touched = 0;
    const ledger: MechanicsLedger = {
      writeRows: async () => { touched++; return []; },
      testRuns: async () => { touched++; return []; },
      blockers: async () => { touched++; return []; },
      repoRoots: async () => { touched++; return []; },
    };
    expect(await readWorkItemMechanics({ id: 'WI-3', assignee: null, takenAt: null }, ledger)).toBeNull();
    expect(touched).toBe(0);
  });
});
