/**
 * WI-6554700010030353: the cochange reuse section can measure a window larger than the in-process
 * commit cap. The fixture is a repository whose 90-day first-parent window holds 1,205 commits, so
 * the capped in-process read (IN_PROCESS_HISTORY_BOUNDS, 1000 commits) is incomplete by design and
 * only the resident index can answer `measured`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundChangeHistoryProviders, readCoChange, readWarmCoChange, type CoChangeReport } from './change-history';
import type { ReuseProviderContext } from './reuse-brief-providers';
import { configureWarmCoChange, stopWarmCoChange, warmCoChangeStatus } from './warm-cochange-index';

const COMMITS = 1_205;
const git = (dir: string, args: string[], input?: string) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 }).trim();
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** `count` commits on main, one minute apart and ending `endAgoMs` ago: a.ts and b.ts change in
 * every commit, c.ts in every fifth. */
function fastImport(dir: string, count: number, startSeq: number, endAgoMs: number): void {
  const chunks: string[] = [];
  const blob = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  const last = Math.floor((Date.now() - endAgoMs) / 1000);
  // A new fast-import process does not know the branch tip, so continue it explicitly.
  const parent = startSeq > 0 ? git(dir, ['rev-parse', 'refs/heads/main']) : null;
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    const at = last - (count - 1 - i) * 60;
    chunks.push('commit refs/heads/main\n', `committer Fixture <fixture@example.invalid> ${at} +0000\n`, blob(`c${seq}`),
      ...(i === 0 && parent ? [`from ${parent}\n`] : []),
      `M 100644 inline a.ts\n${blob(`export const a = ${seq};`)}`, `M 100644 inline b.ts\n${blob(`export const b = ${seq};`)}`,
      ...(seq % 5 === 0 ? [`M 100644 inline c.ts\n${blob(`export const c = ${seq};`)}`] : []), '\n');
  }
  git(dir, ['fast-import', '--quiet'], chunks.join(''));
}

async function until(read: () => Promise<CoChangeReport>, done: (report: CoChangeReport) => boolean, ms = 90_000): Promise<CoChangeReport> {
  const stop = Date.now() + ms;
  for (;;) {
    const report = await read();
    if (done(report) || Date.now() > stop) return report;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('resident co-change index (WI-6554700010030353)', () => {
  let dir = '';
  let snapshots = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'warm-cochange-'));
    snapshots = mkdtempSync(join(tmpdir(), 'warm-cochange-snap-'));
    git(dir, ['init', '-q', '-b', 'main']);
    fastImport(dir, COMMITS, 0, 60 * 60_000);
    git(dir, ['reset', '-q', '--hard']);
    configureWarmCoChange({ snapshotDir: snapshots });
  });
  afterAll(() => {
    stopWarmCoChange();
    configureWarmCoChange({});
    rmSync(dir, { recursive: true, force: true });
    rmSync(snapshots, { recursive: true, force: true });
  });

  it('control: the capped in-process read cannot measure this window', async () => {
    const cold = await readCoChange(dir, ['a.ts']);
    expect(cold.complete).toBe(false);
    expect(cold.status).toBe('unknown');
  });

  it('answers not-ready with a reason before the first build, then measures the full window at HEAD', async () => {
    const first = await readWarmCoChange(dir, ['a.ts']);
    expect(first.status).toBe('unknown');
    expect(first.commit).toBeNull();
    // Before the first build: an explicit not-ready, or (worker still starting) the deadline — never pairs.
    expect(first.error).toMatch(/not ready|did not answer before the deadline/);
    expect(first.pairs).toEqual([]);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const warm = await until(() => readWarmCoChange(dir, ['a.ts']), (report) => report.status === 'measured');
    expect(warm).toMatchObject({ status: 'measured', complete: true, commit: head, error: null });
    expect(warm.eligibleCommits).toBe(COMMITS);
    expect(warm.pairs.map((pair) => pair.partner)).toEqual(expect.arrayContaining(['b.ts', 'c.ts']));
    expect((await warmCoChangeStatus(dir))?.source).toBe('full');
  }, 120_000);

  it('never answers for another commit, and follows HEAD after a new commit', async () => {
    fastImport(dir, 1, COMMITS, 0);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const next = await until(() => readWarmCoChange(dir, ['a.ts']), (report) => report.commit === head);
    expect(next).toMatchObject({ status: 'measured', complete: true, commit: head });
    expect(next.eligibleCommits).toBe(COMMITS + 1);
    expect((await warmCoChangeStatus(dir))?.source).toBe('refresh');
  }, 120_000);

  it('rewarms a restarted host from its snapshot plus the delta, without a full read', async () => {
    // The snapshot is written just after the index is installed; give the write a moment to land.
    const stop = Date.now() + 15_000;
    let snapshot = readdirJson(snapshots);
    while (snapshot === null && Date.now() < stop) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      snapshot = readdirJson(snapshots);
    }
    expect(snapshot).not.toBeNull();
    stopWarmCoChange();
    fastImport(dir, 2, COMMITS + 1, 0);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const warm = await until(() => readWarmCoChange(dir, ['a.ts']), (report) => report.commit === head);
    expect(warm).toMatchObject({ status: 'measured', complete: true, commit: head });
    expect(warm.eligibleCommits).toBe(COMMITS + 3);
    expect((await warmCoChangeStatus(dir))?.source).toBe('snapshot+delta');
  }, 120_000);

  it('the claim-time cochange provider reports measured lines through the resident index', async () => {
    git(dir, ['reset', '-q', '--hard']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const sourceVersion = sha256(JSON.stringify([['a.ts', sha256(readFileSync(join(dir, 'a.ts'), 'utf8'))]]));
    const ctx: ReuseProviderContext = { surface: 'claim', workspaceId: 'fixture', owner: 'fixture', invocation: 'fixture',
      paths: ['a.ts'], sourceVersion, commit: head };
    const provider = boundChangeHistoryProviders({ root: async () => dir, harness: 'fixture' }).find((p) => p.id === 'cochange')!;
    const stop = Date.now() + 90_000;
    let result = await provider.read(ctx, AbortSignal.timeout(5_000));
    while (result.status !== 'measured' && Date.now() < stop) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await provider.read(ctx, AbortSignal.timeout(5_000));
    }
    expect(result.status).toBe('measured');
    expect(result.lines.join('\n')).toMatch(/Unanchored b\.ts/);
  }, 120_000);
});

function readdirJson(dir: string): unknown {
  const files = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
  return files.length ? JSON.parse(readFileSync(join(dir, files[0]!), 'utf8')) : null;
}
