import { describe, expect, it } from 'vitest';
import { gcsTestProvider } from '../../../libs/generic/artifact-registry/src/gcs-test-provider.ts';
import { verifyPublishArchive } from './verify-archive.ts';

const operationId = 'a020a289-698e-4bd9-9137-aad39dfadca6';
function fixture(fault?: 'corrupt-bytes' | 'public' | 'delete-race' | 'extra-object' | 'occupied' | 'lost-response') {
  const p = gcsTestProvider();
  const prefix = 'publish/verification-' + operationId + '/deployment-' + operationId + '/';
  const journal: unknown[] = [];
  if (fault === 'occupied') p.seed(prefix + 'original', 'retained original');
  if (fault === 'lost-response') p.loseNextCommitResponse();
  const metadata = (key: string, o: NonNullable<ReturnType<typeof p.objects.get>>) => ({
    name: key, generation: o.generation, size: String(o.bytes.length), ...o.metadata,
  });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (!new Headers(init.headers).has('authorization')) return new Response(null, { status: fault === 'public' ? 200 : 403 });
    const key = decodeURIComponent(url.pathname.split('/o/')[1] ?? '');
    if (init.method === 'DELETE') {
      expect(journal).toHaveLength(1);
      expect(url.searchParams.get('ifGenerationMatch')).toBe(p.objects.get(key)?.generation);
      if (fault === 'delete-race') return new Response(null, { status: 412 });
      p.objects.delete(key); return new Response(null, { status: 204 });
    }
    if (fault === 'extra-object' && url.searchParams.has('prefix') && journal.length) p.seed(prefix + 'unexpected', 'retain');
    if (fault === 'corrupt-bytes' && url.searchParams.get('alt') === 'media') return new Response('corrupted');
    if (url.searchParams.has('prefix')) return Response.json({ items: [...p.objects.entries()]
      .filter(([name]) => name.startsWith(url.searchParams.get('prefix')!)).map(([name, o]) => metadata(name, o)) });
    const o = p.objects.get(key);
    if (!o) return new Response(null, { status: 404 });
    if (url.searchParams.get('alt') === 'media') {
      expect(url.searchParams.get('generation')).toBe(o.generation);
      return new Response(new Uint8Array(o.bytes).buffer);
    }
    return Response.json(metadata(key, o));
  };
  // Oracle reads do not reuse the adapter's request/parser implementation.
  return { p, prefix, journal, options: { bucket: 'test-bucket', accessToken: 'test-token',
    operationId, body: 'admitted bytes ' + operationId, store: p.store, fetchImpl,
    recordOperation: async (operation: unknown) => { journal.push(operation); } } };
}

describe('bounded live publish archive verifier', () => {
  it('restores admitted bytes and metadata, denies anonymous access and cleans only exact generations', async () => {
    const f = fixture(); const r = await verifyPublishArchive(f.options);
    expect(r.result).toBe('pass'); expect(r.cleanup.complete).toBe(true);
    expect(r.cleanup.deleted).toHaveLength(2); expect(f.p.objects.size).toBe(0);
    expect(f.journal).toHaveLength(1); expect(r.checks.every(c => c.ok)).toBe(true);
  });
  for (const fault of ['corrupt-bytes', 'public', 'delete-race', 'extra-object'] as const) {
    it('rejects ' + fault + ' without reporting successful acceptance', async () => {
      const f = fixture(fault); const r = await verifyPublishArchive(f.options);
      expect(r.result).toBe('fail');
      if (fault === 'delete-race' || fault === 'extra-object') {
        expect(r.cleanup.complete).toBe(false); expect(f.p.objects.size).toBeGreaterThan(0);
      } else expect(r.cleanup.complete).toBe(true);
    });
  }
  it('preserves an occupied archive without journaling or deleting', async () => {
    const f = fixture('occupied'); const r = await verifyPublishArchive(f.options);
    expect(r.result).toBe('fail'); expect(f.journal).toHaveLength(0);
    expect(f.p.objects.has(f.prefix + 'original')).toBe(true); expect(r.cleanup.deleted).toHaveLength(0);
  });
  it('reconciles a lost write response and removes only its own retained file', async () => {
    const f = fixture('lost-response'); const r = await verifyPublishArchive(f.options);
    expect(r.result).toBe('fail'); expect(r.cleanup.complete).toBe(true);
    expect(r.cleanup.deleted).toHaveLength(1); expect(f.p.objects.size).toBe(0);
  });
});
