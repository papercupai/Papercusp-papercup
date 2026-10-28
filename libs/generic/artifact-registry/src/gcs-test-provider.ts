import { expect } from 'vitest';
import { gcsObjectStore } from './gcs-object-store.js';
const enc = new TextEncoder();
export function gcsTestProvider() {
  type Stored = { bytes: Uint8Array; metadata: Record<string, unknown>; generation: string };
  const objects = new Map<string, Stored>();
  const uploads = new Map<string, { key: string; metadata: Record<string, unknown>; condition: string | null }>();
  const requests: { url: URL; method: string; init: RequestInit }[] = [];
  let generation = 100;
  let denied = false;
  let loseResponse = false;
  let vanishBeforeMedia = false;
  let beforeUploadCommit: (() => void) | undefined;
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
  const describeObject = (key: string, o: Stored) => ({ name: key, size: String(o.bytes.length), generation: o.generation, updated: '2026-10-24T00:00:00Z', ...o.metadata });
  function seed(key: string, body: string | Uint8Array, metadata: Record<string, unknown> = {}) {
    const object = { bytes: typeof body === 'string' ? enc.encode(body) : body, metadata, generation: String(++generation) };
    objects.set(key, object); return object;
  }
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    requests.push({ url, method, init });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token');
    if (denied) return json({ error: 'denied' }, 403);
    const id = url.searchParams.get('upload_id');
    if (id && method === 'PUT') {
      const upload = uploads.get(id)!;
      beforeUploadCommit?.(); beforeUploadCommit = undefined;
      const existing = objects.get(upload.key);
      if (upload.condition === '0' ? Boolean(existing) : upload.condition && existing?.generation !== upload.condition) return json({}, 412);
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      const o = seed(upload.key, bytes, upload.metadata);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after provider commit'); }
      return json(describeObject(upload.key, o));
    }
    if (url.searchParams.get('uploadType') === 'resumable') {
      const key = url.searchParams.get('name')!;
      const uploadId = String(uploads.size + 1);
      uploads.set(uploadId, { key, metadata: JSON.parse(String(init.body)), condition: url.searchParams.get('ifGenerationMatch') });
      return new Response(null, { status: 200, headers: { location: `https://storage.googleapis.com/upload/storage/v1/b/test-bucket/o?upload_id=${uploadId}` } });
    }
    const marker = '/storage/v1/b/test-bucket/o';
    const compose = url.pathname.endsWith('/compose');
    const key = decodeURIComponent(url.pathname.slice(marker.length + 1, compose ? -8 : undefined));
    if (compose && method === 'POST') {
      if (objects.has(key) && url.searchParams.get('ifGenerationMatch') === '0') return json({}, 412);
      const b = JSON.parse(String(init.body));
      const sources = b.sourceObjects.map((s: { name: string; generation: string }) => {
        const o = objects.get(s.name); return o?.generation === s.generation ? o : null;
      });
      if (sources.some((x: Stored | null) => !x)) return json({}, 404);
      expect(sources.length).toBeLessThanOrEqual(32);
      const bytes = new Uint8Array(sources.reduce((n: number, x: Stored) => n + x.bytes.length, 0));
      let offset = 0; for (const o of sources as Stored[]) { bytes.set(o.bytes, offset); offset += o.bytes.length; }
      const result = seed(key, bytes, b.destination);
      if (loseResponse) { loseResponse = false; throw new Error('response lost after provider commit'); }
      return json(describeObject(key, result));
    }
    if (url.pathname === marker && method === 'GET') {
      const keys = [...objects.keys()].filter(k => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const limit = Number(url.searchParams.get('maxResults'));
      return json({ items: keys.slice(offset, offset + limit).map(k => describeObject(k, objects.get(k)!)),
        ...(offset + limit < keys.length ? { nextPageToken: String(offset + limit) } : {}) });
    }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    const o = objects.get(key);
    if (!o) return json({}, 404);
    if (url.searchParams.get('alt') === 'media') {
      if (vanishBeforeMedia || url.searchParams.get('generation') !== o.generation) return json({}, 404);
      return new Response(new Uint8Array(o.bytes).buffer);
    }
    return json(describeObject(key, o));
  }) as typeof fetch;
  const store = gcsObjectStore({ bucket: 'test-bucket', accessToken: async () => 'test-token', fetchImpl });
  return { store, fetchImpl, objects, requests, seed, setDenied: () => { denied = true; },
    loseNextCommitResponse: () => { loseResponse = true; }, vanishBeforeMedia: () => { vanishBeforeMedia = true; },
    beforeUploadCommit: (f: () => void) => { beforeUploadCommit = f; } };
}

