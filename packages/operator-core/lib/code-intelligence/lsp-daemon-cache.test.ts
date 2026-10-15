import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspDaemonAnswerCache, LSP_ANSWER_CACHE_BOUNDS, type LspCacheRevision } from './lsp-daemon-cache';
import { captureLspDaemonInputs } from './lsp-daemon-cost-key';
import type { LspDaemonAnswer, LspDaemonRequest } from './lsp-daemon-protocol';
import { unmeasuredSourceEvidence } from './contracts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lsp-answer-cache-')); roots.push(root);
  const file = join(root, 'source.ts'); writeFileSync(file, 'export const value = 1;');
  let revision: LspCacheRevision = { measured: true, identity: 'service-a' };
  const lifecycle = { prepare: vi.fn(async () => revision), current: () => revision };
  const cache = new LspDaemonAnswerCache(lifecycle);
  const request: LspDaemonRequest = { workspaceId: 'workspace-a', op: 'symbol', args: { file, rootPath: root, line1: 1, character: 13 } };
  const execute = vi.fn(async (): Promise<LspDaemonAnswer> => {
    const answer: LspDaemonAnswer = { backend: 'lsp-adapter', intent: 'definition', query: file,
      sites: [{ path: 'source.ts', line1: 1, kind: 'variable', detail: readFileSync(file, 'utf8') }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, indexedCommit: null, staleVsDisk: null }, latencyMs: 1, error: null };
    const evidence = unmeasuredSourceEvidence(answer, { repositoryId: 'fixture', identityKind: 'registry', paths: ['.'], basis: 'compiler-project' }, []);
    return { ...answer, evidence: { ...evidence, sourceScope: { ...evidence.sourceScope, sourceFingerprint: 'a'.repeat(64) } } };
  });
  const query = (over: Partial<LspDaemonRequest> = {}, run = execute, signal = new AbortController().signal) =>
    cache.query({ ...request, ...over }, 'typescript', root, signal, run);
  return { root, file, cache, request, execute, query, lifecycle, setRevision: (next: LspCacheRevision) => { revision = next; } };
}

describe('bounded shared daemon answers', () => {
  it('reuses unchanged producer results, preserves sites/evidence and isolates caller mutations', async () => {
    const f = fixture(); const first = await f.query();
    expect(first.daemonCache?.state).toBe('miss');
    (first.sites[0] as { detail: string }).detail = 'caller mutation';
    const second = await f.query();
    expect(second.daemonCache?.state).toBe('hit');
    expect(second.sites[0]?.detail).toBe('export const value = 1;');
    expect(second.evidence).toEqual(first.evidence);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('detects same-size/mtime edits without events and agrees with the uncached producer', async () => {
    const f = fixture(); await f.query(); const stamp = statSync(f.file);
    writeFileSync(f.file, 'export const value = 2;'); utimesSync(f.file, stamp.atime, stamp.mtime);
    const edited = await f.query(); const oracle = await f.execute();
    expect(edited.daemonCache?.state).toBe('miss'); expect(edited.sites).toEqual(oracle.sites);
    expect(edited.sites[0]?.detail).toContain('2');
  });

  it('invalidates aliases, manifests, compiler options, nested repositories and deletes without notifications', async () => {
    const f = fixture(); await f.query(); mkdirSync(join(f.root, 'nested'));
    const changes = [['.aliases', 'x=y'], ['package.json', '{"type":"module"}'],
      ['tsconfig.json', '{"compilerOptions":{"strict":true}}'], ['nested/lib.ts', 'export const nested = 1;'],
      ['nested/.git', 'ref: main']];
    for (const [path, text] of changes) {
      writeFileSync(join(f.root, path!), text!); expect((await f.query()).daemonCache?.state).toBe('miss');
      expect((await f.query()).daemonCache?.state).toBe('hit');
    }
    rmSync(join(f.root, 'nested/lib.ts')); expect((await f.query()).daemonCache?.state).toBe('miss');
    writeFileSync(join(f.root, 'nested/.git'), 'gitdir: ../../outside');
    expect((await f.query()).daemonCache).toMatchObject({ state: 'bypass', reason: expect.stringContaining('external repository') });
  });

  it('removes a relationship supported only by a deleted dependency from the next current answer', async () => {
    const f = fixture(); const dependency = join(f.root, 'dependency.ts');
    writeFileSync(dependency, 'function target() {}');
    // An independent semantic oracle determines the surviving relation from
    // source existence; the cache cannot manufacture its expected site list.
    const producer = vi.fn(async () => ({ ...await f.execute(), sites: existsSync(dependency) ?
      [{ path: 'dependency.ts', line1: 1, kind: 'function' }] : [] }));
    expect((await f.query({}, producer)).sites).toEqual([{ path: 'dependency.ts', line1: 1, kind: 'function' }]);
    expect((await f.query({}, producer)).daemonCache?.state).toBe('hit');
    rmSync(dependency);
    const next = await f.query({}, producer);
    expect(next.sites).toEqual([]); expect(next.daemonCache?.state).toBe('miss');
    expect(next.sites).toEqual((await producer()).sites);
    expect((await f.query({}, producer)).sites).toEqual([]);
  });

  it('isolates workspaces and cursors, invalidates service restarts and cold reconnects', async () => {
    const f = fixture(); await f.query();
    expect((await f.query({ workspaceId: 'workspace-b' })).daemonCache?.state).toBe('miss');
    expect((await f.query({ args: { ...f.request.args, character: 14 } })).daemonCache?.state).toBe('miss');
    f.setRevision({ measured: true, identity: 'restarted-service' });
    expect((await f.query()).daemonCache?.state).toBe('miss');
    expect((await f.query()).daemonCache?.state).toBe('hit'); f.cache.clear();
    expect((await f.query()).daemonCache?.state).toBe('miss');
  });

  it('never reuses unmeasured external inputs, unhealthy replies or archive/plugin evidence', async () => {
    const f = fixture(); await f.query();
    f.setRevision({ measured: false, reason: 'external compiler inputs are unmeasured' });
    expect((await f.query()).daemonCache).toMatchObject({ state: 'bypass', reason: 'external compiler inputs are unmeasured' });
    f.setRevision({ measured: true, identity: 'service-a' });
    expect((await f.query({ archive: true })).daemonCache?.state).toBe('bypass');
    const unhealthy = vi.fn(async () => ({ ...await f.execute(), error: 'server died' }));
    f.cache.clear(); await f.query({}, unhealthy); await f.query({}, unhealthy);
    expect(unhealthy).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply when concurrent edits change its input scope during execution', async () => {
    const f = fixture();
    const editDuringQuery = vi.fn(async () => { const answer = await f.execute(); writeFileSync(f.file, 'changed while querying'); return answer; });
    const result = await f.query({}, editDuringQuery);
    expect(result).toMatchObject({ sites: [], error: expect.stringContaining('changed during'), daemonCache: { state: 'pending' } });
    expect(result.evidence).toBeUndefined();
    expect((await f.query()).daemonCache?.state).toBe('miss');
  });

  it('debounces concurrent project work with an explicit per-file pending warning', async () => {
    const f = fixture(); let release!: () => void; let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const slow = vi.fn(async () => { began(); await new Promise<void>(resolve => { release = resolve; }); return f.execute(); });
    const first = f.query({}, slow); await started;
    const pending = await f.query({ workspaceId: 'workspace-b' });
    expect(pending).toMatchObject({ sites: [], freshness: { health: 'degraded' },
      daemonCache: { state: 'pending', pendingFiles: [f.file] } });
    release(); await first; expect((await f.query()).daemonCache?.state).toBe('hit');
  });

  it('does not retain cancelled queries or oversized answers', async () => {
    const f = fixture(); const controller = new AbortController();
    const cancelled = vi.fn(async () => { const answer = await f.execute(); controller.abort(new Error('cancelled')); return answer; });
    await expect(f.query({}, cancelled, controller.signal)).rejects.toThrow('cancelled');
    expect((await f.query()).daemonCache?.state).toBe('miss'); f.cache.clear();
    const large = vi.fn(async () => ({ ...await f.execute(), sites: [{ path: 'source.ts', line1: 1, kind: null,
      detail: 'x'.repeat(LSP_ANSWER_CACHE_BOUNDS.answerBytes + 1) }] }));
    expect((await f.query({}, large)).daemonCache).toMatchObject({ state: 'bypass', reason: 'answer byte bound exceeded' });
    await f.query({}, large); expect(large).toHaveBeenCalledTimes(2);
  });

  it('evicts old answers at the maintained cache entry bound', async () => {
    const f = fixture();
    for (let character = 0; character <= LSP_ANSWER_CACHE_BOUNDS.entries; character++)
      await f.query({ args: { ...f.request.args, character } });
    expect((await f.query({ args: { ...f.request.args, character: 0 } })).daemonCache?.state).toBe('miss');
  });

  it('bypasses an oversized census rather than certifying a partial input hash', async () => {
    const f = fixture(); const cache = new LspDaemonAnswerCache(f.lifecycle,
      root => captureLspDaemonInputs(root, { maxEntries: 1, maxBytes: 1 }));
    const result = await cache.query(f.request, 'typescript', f.root, new AbortController().signal, f.execute);
    expect(result.daemonCache).toMatchObject({ state: 'bypass', reason: 'project-input byte bound exceeded' });
    expect(f.lifecycle.prepare).not.toHaveBeenCalled();
  });
});
