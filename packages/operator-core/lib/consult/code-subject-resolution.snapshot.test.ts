import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peekPushSnapshot, type PushSnapshot, type SnapshotSymbol } from '../code-intelligence/push-snapshot';
import { gitGrepSymbolResolver, resolveQuestionCodeSubjects } from './code-subject-resolution';

vi.mock('../code-intelligence/push-snapshot', async importOriginal => ({
  ...await importOriginal<typeof import('../code-intelligence/push-snapshot')>(),
  peekPushSnapshot: vi.fn(),
}));

describe('validated snapshot hints in the consult resolver (D-007)', () => {
  let repo: string;
  let trace: string;
  let snapshot: PushSnapshot;
  const source = 'export function routeThing() { return 1; }\n';
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const hint = (overrides: Partial<SnapshotSymbol> = {}): SnapshotSymbol => ({
    id: 'definition:routeThing', name: 'routeThing', path: 'src/target.ts', line: 1, column: 17,
    sha256: digest(source), signature: 'function routeThing()', aliases: [], callers: [], ...overrides,
  });
  const resolve = (options: { timeoutMs?: number; cwd?: string; maxFilesPerIdentifier?: number } = {}) =>
    gitGrepSymbolResolver({ cwd: repo, snapshotRepo: 'papercusp', ...options });
  const scanned = () => readFileSync(trace, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { event?: string; argv?: string[] })
    .some(row => row.event === 'start' && row.argv?.includes('grep'));

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'consult-index-proof-'));
    trace = join(repo, 'trace.json');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'apps/host'), { recursive: true });
    writeFileSync(join(repo, 'src/target.ts'), source);
    writeFileSync(join(repo, 'src/other.ts'), 'export const otherThing = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', 'src'], { cwd: repo });
    snapshot = { commit: 'a'.repeat(40), generatedAt: new Date().toISOString(), generatedMs: Date.now(),
      importers: new Map(), hashes: new Map(), symbols: new Map([['routeThing', [hint()]]]) };
    vi.mocked(peekPushSnapshot).mockReturnValue(snapshot);
    vi.stubEnv('GIT_TRACE2_EVENT', trace);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(repo, { recursive: true, force: true });
  });

  it('validates a positive hint in a separate checkout from a nested runtime cwd without scanning the corpus', async () => {
    expect(await resolve({ cwd: join(repo, 'apps/host') })(['routeThing']))
      .toEqual(new Map([['routeThing', ['src/target.ts']]]));
    expect(scanned()).toBe(false);
  });

  it('requires explicit opt-in and skips snapshot loading for non-code questions', async () => {
    await gitGrepSymbolResolver({ cwd: repo })(['routeThing']);
    expect(peekPushSnapshot).not.toHaveBeenCalled();
    expect(scanned()).toBe(true);
    const result = await resolveQuestionCodeSubjects('How should we organize the picnic?', { resolveSymbol: resolve() });
    expect(result.resolver).toBe('skipped');
    expect(peekPushSnapshot).not.toHaveBeenCalled();
  });

  it.each(['missing', 'stale', 'future', 'ambiguous', 'hash', 'export', 'alias', 'invalid', 'unnormalized'])(
    'falls back honestly for a %s hint', async kind => {
      if (kind === 'missing') vi.mocked(peekPushSnapshot).mockReturnValue(null);
      if (kind === 'stale') snapshot.generatedMs -= 25 * 60 * 60_000;
      if (kind === 'future') snapshot.generatedMs += 10 * 60_000;
      if (kind === 'ambiguous') snapshot.symbols = new Map([['routeThing', [hint(), hint({ id: 'another' })]]]);
      if (kind === 'hash') snapshot.symbols = new Map([['routeThing', [hint({ sha256: '0'.repeat(64) })]]]);
      if (kind === 'export') snapshot.symbols = new Map([['routeThing', [hint({ path: 'src/other.ts', sha256: digest('export const otherThing = 1;\n') })]]]);
      if (kind === 'alias') snapshot.symbols = new Map([['routeThing', [hint({ name: 'otherThing', aliases: ['routeThing'] })]]]);
      if (kind === 'invalid') snapshot.symbols = new Map([['routeThing', [hint({ path: '../target.ts' })]]]);
      if (kind === 'unnormalized') snapshot.symbols = new Map([['routeThing', [hint({ path: 'src//target.ts' })]]]);
      expect((await resolve()(['routeThing'])).get('routeThing')).toEqual(['src/target.ts']);
      expect(scanned()).toBe(true);
    },
  );

  it('never credits an untracked definition', async () => {
    writeFileSync(join(repo, 'src/untracked.ts'), source);
    snapshot.symbols = new Map([['routeThing', [hint({ path: 'src/untracked.ts' })]]]);
    expect((await resolve()(['routeThing'])).get('routeThing')).toEqual(['src/target.ts']);
    expect(scanned()).toBe(true);
  });

  it('refuses a tracked symlink hint', async () => {
    symlinkSync('target.ts', join(repo, 'src/link.ts'));
    execFileSync('git', ['add', 'src/link.ts'], { cwd: repo });
    snapshot.symbols = new Map([['routeThing', [hint({ path: 'src/link.ts' })]]]);
    expect((await resolve()(['routeThing'])).get('routeThing')).toEqual(['src/target.ts']);
    expect(scanned()).toBe(true);
  });

  it('combines validated definitions with the Git fallback for remaining names', async () => {
    const out = await resolve({ maxFilesPerIdentifier: 1 })(['routeThing', 'otherThing', 'missingThing']);
    expect(out).toEqual(new Map([['routeThing', ['src/target.ts']], ['otherThing', ['src/other.ts']]]));
    expect(scanned()).toBe(true);
  });

  it('charges index metadata and fallback to the same deadline and cancels the active child', async () => {
    const bin = join(repo, 'bin');
    mkdirSync(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    // Deterministic per-call latency: each command fits the budget separately,
    // but root + tracked-file validation + fallback cannot fit it together.
    const wrapper = `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nsetTimeout(()=>{const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);},180);\n`;
    writeFileSync(join(bin, 'git'), wrapper);
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    const subjects = await resolveQuestionCodeSubjects('Why does routeThing call otherThing?', {
      resolveSymbol: resolve({ timeoutMs: 450 }),
    });
    expect(subjects.resolver).toBe('unavailable');
    expect(subjects.files).toEqual([]);
  });
});
