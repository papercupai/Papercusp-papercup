import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { replacementLaunchReceipt, validateReplacementProductReads } from './blind-review-replacement';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('replacement launch custody', () => {
  it('does not release partial errors, thrown/lost replies, empty dedupe replies, or missing native identity', () => {
    for (const reply of [null, { isError: true }, { uncertain: 'transport closed' },
      { data: { launch: { mode: 'deduped', opened: 0, tasks: [], partial: false } } },
      { data: { launch: { opened: 1, ownerIds: ['su-new'], freshVerdict: { sessions: [] } } } }]) {
      expect(replacementLaunchReceipt(reply)).toEqual({ kind: 'uncertain' });
    }
    expect(replacementLaunchReceipt({ isError: true, data: { launch: { opened: 1, ownerIds: ['su-new'],
      freshVerdict: { sessions: [{ ownerId: 'su-new', advSessionId: 7, sessionId: 'native' }] } } } }))
      .toEqual({ kind: 'native', ownerId: 'su-new', advSessionId: 7, sessionId: 'native' });
    expect(replacementLaunchReceipt({ isError: true, data: { launch: { opened: 1, ownerIds: ['su-new'],
      freshVerdict: { sessions: [{ ownerId: 'su-new', advSessionId: 7, sessionId: null }] } } } }))
      .toEqual({ kind: 'uncertain' });
  });

  it('recognizes an explicit pre-spawn refusal and a measured zero-process launch', () => {
    expect(replacementLaunchReceipt({ isError: true, data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } } }))
      .toEqual({ kind: 'not-started' });
    expect(replacementLaunchReceipt({ opened: 0, partial: false, tasks: [] })).toEqual({ kind: 'not-started' });
    expect(replacementLaunchReceipt({ opened: 0, partial: true, tasks: [] })).toEqual({ kind: 'uncertain' });
  });

  it('validates file custody and rejects missing, duplicate, traversing, noncanonical and symlink-escaped nominations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'blind-replacement-'));
    roots.push(root);
    await mkdir(path.join(root, 'product'));
    await writeFile(path.join(root, 'product', 'widget.test.ts'), 'test source');
    const outside = await mkdtemp(path.join(tmpdir(), 'blind-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'escape.test.ts'), 'outside');
    await symlink(path.join(outside, 'escape.test.ts'), path.join(root, 'escape.test.ts'));
    const reads = (files: string[]) => ({ harness: 'papercusp', docsHarness: 'papercusp', docsSlugs: [], testFiles: files });
    await expect(validateReplacementProductReads(reads(['product/widget.test.ts']), root)).resolves.toBeUndefined();
    for (const files of [['missing.test.ts'], ['product/widget.test.ts', 'product/widget.test.ts'],
      ['../escape.test.ts'], ['product/../product/widget.test.ts'], ['escape.test.ts']]) {
      await expect(validateReplacementProductReads(reads(files), root)).rejects.toThrow();
    }
  });
});
