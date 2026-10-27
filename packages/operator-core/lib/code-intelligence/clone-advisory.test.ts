import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptPreparedCloneFile, cloneAdvisoryLookup, snapshotCloneLeg, type PreparedCloneFile } from './clone-advisory';
import { codeIntelPushText, formatPushFact, type PushCall, type PushFact, type PushInput } from './push-channel';
import { parsePushSnapshot, parsePushSnapshotStream, type PushSnapshot } from './push-snapshot';
import { collectCloneEdits, editedPathsFor, postInjection } from '../../../../apps/operator/scripts/hooks/inject/core.mjs';
import { cloneAdvisoryFixture as fixture } from './__fixtures__/clone-advisory-fixture';

const input = (calls: PushCall[]) => ({ owner: 'clone-agent', workspace: 'test-workspace', calls });

describe('P006 native clone advisory', () => {
  it.each(['Edit', 'Write', 'MultiEdit', 'apply_patch'])('delivers a source-corroborated %s note through the native hook response', async tool => {
    const { snapshot, sources } = fixture();
    const root = await mkdtemp(join(tmpdir(), 'clone-hook-'));
    try {
      await Promise.all(Object.entries(sources).map(([path, text]) => writeFile(join(root, path), text)));
      const toolInput = tool === 'apply_patch' ? '*** Begin Patch\n*** Update File: b.ts\n@@\n*** End Patch' : { file_path: 'b.ts' };
      const call = { tool, toolInput: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput),
        toolResponse: '', editedPaths: editedPathsFor(tool, toolInput) };
      const commit = vi.fn(async (_input: PushInput, snap: PushSnapshot, facts: PushFact[]) => facts.map(fact => formatPushFact(fact, snap)).join('\n'));
      const deliver = () => postInjection('mid-turn', { owner: `pure-clone-${tool}`, cwd: root,
        workspace: 'test-workspace', harness: 'papercusp', client: 'codex', toolCalls: [call] }, {
        env: { PAPERCUSP_MID_TURN_CONTEXT: 'on' },
        fetchImpl: (async (_url: unknown, init: RequestInit) => {
          const request = JSON.parse(init.body as string);
          return { ok: true, json: async () => ({ text: await codeIntelPushText({
            ...input(request.toolCalls), root,
          }, { snapshot: async () => snapshot, enabled: async () => true,
            legs: () => new Map([['clone', snapshotCloneLeg]]), commit }) }) };
        }) as typeof fetch,
      });
      expect((await deliver())?.text).toContain('2 copies; reuse original (a.ts:1)');
      expect(commit).toHaveBeenCalledTimes(1);
      await writeFile(join(root, 'a.ts'), '// changed after preparation');
      expect(await deliver()).toBeNull();
      expect(commit).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['Edit', 'Write', 'MultiEdit', 'apply_patch'])('collects digest-only %s edits and refuses delivery without local proof', async tool => {
    const { files, snapshot } = fixture();
    const body = { cwd: '/repo', toolCalls: [{ tool, editedPaths: ['b.ts', 'b.ts'] }] };
    const digest = vi.fn(async () => files.find(file => file.path === 'b.ts')!.sha256);
    await collectCloneEdits(body, digest);
    expect(digest).toHaveBeenCalledTimes(1);
    const commit = vi.fn(async (_input: PushInput, snap: PushSnapshot, facts: PushFact[]) => facts.map(fact => formatPushFact(fact, snap)).join('\n'));
    const result = await codeIntelPushText(input(body.toolCalls), {
      snapshot: async () => snapshot, enabled: async () => true,
      legs: () => new Map([['clone', snapshotCloneLeg]]), commit,
    });
    // No sourceHashes bypass: delivery corroborates the current local source.
    expect(commit).not.toHaveBeenCalled();
    const lookup = cloneAdvisoryLookup(input(body.toolCalls), snapshot);
    expect(lookup.status).toBe('measured');
    expect(lookup.facts).toHaveLength(1);
    expect(lookup.facts[0]!.text).toContain('2 copies; reuse original (a.ts:1)');
    expect(formatPushFact(lookup.facts[0]!, snapshot).split('\n')).toHaveLength(1);
    expect(result).toBe('');
  });

  it('does not warn for a measured nonmatch and preserves unknown for absent/stale blobs', () => {
    const { files, snapshot } = fixture();
    const call = (path: string, sha256: string) => input([{ tool: 'Edit', cloneEdits: [{ path, sha256 }] }]);
    expect(cloneAdvisoryLookup(call('none.ts', files.find(row => row.path === 'none.ts')!.sha256), snapshot))
      .toEqual({ status: 'measured', facts: [] });
    expect(cloneAdvisoryLookup(call('b.ts', '0'.repeat(64)), snapshot)).toEqual({ status: 'unknown', facts: [] });
    expect(cloneAdvisoryLookup(call('missing.ts', '0'.repeat(64)), snapshot)).toEqual({ status: 'unknown', facts: [] });
  });

  it('loads the same prepared rows through the production streaming reader', async () => {
    const { raw, snapshot } = fixture();
    async function* chunks() { yield JSON.stringify(raw); }
    expect((await parsePushSnapshotStream(chunks()))?.cloneFiles).toEqual(snapshot.cloneFiles);
    const standalone = { ...raw, edges: [] };
    expect(parsePushSnapshot(JSON.stringify(standalone))?.cloneFiles).toEqual(snapshot.cloneFiles);
    async function* standaloneChunks() { yield JSON.stringify(standalone); }
    expect((await parsePushSnapshotStream(standaloneChunks()))?.cloneFiles).toEqual(snapshot.cloneFiles);
    standalone.clones.schema = 'unsupported-clone-schema';
    expect(parsePushSnapshot(JSON.stringify(standalone))).toBeNull();
    expect(await parsePushSnapshotStream(standaloneChunks())).toBeNull();
  });

  it('rejects malformed prepared rows without breaking the maintained snapshot', async () => {
    const { raw, files } = fixture();
    for (const notes of [[null], [{ ...files[0]!.notes[0], sources: [null] }]]) {
      expect(acceptPreparedCloneFile({ ...files[0], notes })).toBeNull();
      const corrupt = { ...raw, clones: { schema: 'clone-advisory-v1', files: [{ ...files[0], notes }] } };
      expect(parsePushSnapshot(JSON.stringify(corrupt))?.cloneFiles?.size).toBe(0);
      async function* chunks() { yield JSON.stringify(corrupt); }
      expect((await parsePushSnapshotStream(chunks()))?.cloneFiles?.size).toBe(0);
    }
  });

  it('uses at most 20 fake-clock lookups in a 100000-function population and caps/deduplicates a batch at three lines', () => {
    const { snapshot } = fixture();
    const row = snapshot.cloneFiles!.get('b.ts')!;
    const population = new Map<string, PreparedCloneFile>();
    for (let i = 0; i < 100000; i++) population.set(`f${i}.ts`, { ...row, path: `f${i}.ts` });
    let clock = 0;
    const get = vi.fn((path: string) => { clock++; return population.get(path); });
    const cloneFiles = { get } as unknown as ReadonlyMap<string, PreparedCloneFile>;
    const calls = Array.from({ length: 20 }, (_, i) => ({ tool: 'Edit', cloneEdits: [{ path: `f${i}.ts`, sha256: row.sha256 }] }));
    const result = cloneAdvisoryLookup(input(calls), { ...snapshot, cloneFiles });
    expect(clock).toBe(20);
    expect(clock).toBeLessThanOrEqual(25);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.text.split('\n')).toHaveLength(1);
    const distinct = new Map(Array.from({ length: 20 }, (_, i) => [`f${i}.ts`, {
      ...row, path: `f${i}.ts`, notes: [{ ...row.notes[0]!, family: i.toString(16).padStart(64, '0'), text: `family ${i}` }],
    }]));
    expect(cloneAdvisoryLookup(input(calls), { ...snapshot, cloneFiles: distinct }).facts[0]!.text.split('\n'))
      .toEqual(['family 0', 'family 1', 'family 2']);
  });
});

