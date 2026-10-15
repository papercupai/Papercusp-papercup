import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { documentedSourceChanges, DOC_SOURCE_CHANGE_MAX_BYTES, DOC_SOURCE_CHANGE_MAX_FILES } from './drift';
import type { GitRunner, SubjectRef } from './subject-ref';

const base = '1'.repeat(40), head = '2'.repeat(40);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function snapshots(before: string | null, after: string | null, failRead = false): GitRunner {
  return async args => {
    if (args[0] === 'rev-parse') return { code: 0, stdout: args.at(-1)?.startsWith(base) ? base : head, stderr: '' };
    const body = args[1].startsWith(base) ? before : after;
    if (args[0] === 'ls-tree') return { code: 0, stdout: body === null ? '' : `100644 blob ${'a'.repeat(40)}\t${args.at(-1)}\n`, stderr: '' };
    return { code: failRead ? 1 : 0, stdout: body ?? '', stderr: failRead ? 'read unavailable' : '' };
  };
}
const ref: SubjectRef = { kind: 'symbol', file: 'api.ts', name: 'readApi' };
describe('native P016 source-linked documentation candidates', () => {
  it('measures a documented rename from pinned source text and independent hashes', async () => {
    const before = 'export function readApi() { return "old"; }', after = 'export function readApiV2() { return "new"; }';
    const [candidate] = await documentedSourceChanges([ref], ['api.ts'], base, { repoRoot: '/fixture', runGit: snapshots(before, after) });
    expect(candidate).toMatchObject({ path: 'api.ts', status: 'measured', before: { commit: base, sha256: hash(before) },
      after: { commit: head, sha256: hash(after) }, removedSymbols: ['readApi'], addedSymbols: ['readApiV2'], changedSymbols: [] });
    expect(candidate.reason).toContain('missing or renamed');
  });
  it('detects a changed documented workflow without falsely removing its symbol', async () => {
    const [candidate] = await documentedSourceChanges([ref], ['api.ts'], base, { repoRoot: '/fixture',
      runGit: snapshots('export function readApi() { return "before"; }', 'export function readApi() { return "after"; }') });
    expect(candidate).toMatchObject({ status: 'measured', removedSymbols: [], changedSymbols: ['readApi'] });
  });
  it('distinguishes a measured deletion from an unreadable source blob', async () => {
    const before = 'export function readApi() {}';
    const [deleted] = await documentedSourceChanges([ref], ['api.ts'], base, { repoRoot: '/fixture', runGit: snapshots(before, null) });
    expect(deleted).toMatchObject({ status: 'measured', removedSymbols: ['readApi'], after: { sha256: null } });
    const [unknown] = await documentedSourceChanges([ref], ['api.ts'], base, { repoRoot: '/fixture', runGit: snapshots(before, null, true) });
    expect(unknown).toMatchObject({ status: 'unknown', removedSymbols: [] });
  });
  it('keeps unsupported and malformed source unknown instead of inventing symbol removals', async () => {
    for (const [path, text] of [['api.py', 'def readApi(): pass'], ['api.ts', 'export function readApi( {']]) {
      const [candidate] = await documentedSourceChanges([], [path], base, { repoRoot: '/fixture', runGit: snapshots(text, '') });
      expect(candidate).toMatchObject({ status: 'unknown', removedSymbols: [] });
    }
  });
  it('bounds candidate files and source bytes and refuses traversal paths', async () => {
    const paths = ['../outside.ts', '/absolute.ts', ...Array.from({ length: 12 }, (_, i) => `api${i}.ts`)];
    const candidates = await documentedSourceChanges([], paths, base, { repoRoot: '/fixture',
      runGit: snapshots('x'.repeat(DOC_SOURCE_CHANGE_MAX_BYTES + 1), '') });
    expect(candidates).toHaveLength(DOC_SOURCE_CHANGE_MAX_FILES);
    expect(candidates.every(candidate => candidate.status === 'unknown' && !candidate.path.includes('..'))).toBe(true);
  });
  it('marks omitted symbols rather than presenting a bounded list as complete', async () => {
    const before = Array.from({ length: 30 }, (_, i) => `export function api${i}() {}`).join('\n');
    const [candidate] = await documentedSourceChanges([], ['api.ts'], base, { repoRoot: '/fixture', runGit: snapshots(before, '') });
    expect(candidate).toMatchObject({ status: 'measured', truncated: true });
    expect(candidate.removedSymbols).toHaveLength(20);
  });
});
