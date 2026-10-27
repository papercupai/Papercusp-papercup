import { describe, expect, it } from 'vitest';
import { GcsStorageError } from './gcs-object-store.js';
import { sha256Hex } from './content-address.js';
import { objectStoreAsBlobStore } from './object-store.js';
import { putContentAddressed } from './blob-store.js';
import { contentAddressing } from './content-address.js';

const enc = new TextEncoder();
import { gcsTestProvider as provider } from './gcs-test-provider.js';
describe('private GCS object storage port', () => {
  it('preserves exact bytes, custom/HTTP metadata and generation-pinned reads', async () => {
    const p = provider();
    const bytes = enc.encode('private creator bytes');
    const object = await p.store.put('tenant/private.bin', bytes, {
      sha256: await sha256Hex(bytes), customMetadata: { visibility: 'private', tenant: 'one' },
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private' },
    });
    const read = await p.store.get('tenant/private.bin');
    expect(new Uint8Array(await read!.arrayBuffer())).toEqual(bytes);
    expect(read!.customMetadata).toEqual({ visibility: 'private', tenant: 'one' });
    const headers = new Headers(); read!.writeHttpMetadata(headers);
    expect(headers.get('cache-control')).toBe('private');
    expect(p.requests.find(x => x.url.searchParams.get('alt') === 'media')!.url.searchParams.get('generation')).toBe(object!.version);
  });

  it('retains the existing hash-verifying BlobStore seam', async () => {
    const p = provider(); const bytes = enc.encode('registry artifact'); const hash = await sha256Hex(bytes);
    const result = await putContentAddressed(objectStoreAsBlobStore(p.store), {
      hash, scheme: contentAddressing({ prefix: 'registry', ext: '.tgz' }), readBody: async () => bytes.buffer, maxBytes: 100,
    });
    expect(result).toMatchObject({ ok: true, deduped: false });
    expect(p.objects.get(`registry/${hash}.tgz`)!.bytes).toEqual(bytes);
  });

  it('refuses a wrong SHA256 before sending bytes to the provider', async () => {
    const p = provider();
    await expect(p.store.put('bad', 'wrong', { sha256: '0'.repeat(64) })).rejects.toThrow('sha_mismatch');
    expect(p.requests).toHaveLength(0);
  });

  it('fences a create-only race at commit and preserves occupied bytes', async () => {
    const p = provider();
    p.beforeUploadCommit(() => { p.seed('occupied', 'first-writer'); });
    expect(await p.store.put('occupied', 'second-writer', { onlyIf: { etagDoesNotMatch: '*' } })).toBeNull();
    expect(await (await p.store.get('occupied'))!.text()).toBe('first-writer');
  });

  it('fences stale conditional updates by generation', async () => {
    const p = provider(); const first = await p.store.put('state', 'one');
    await p.store.put('state', 'two');
    expect(await p.store.put('state', 'stale', { onlyIf: { etagMatches: first!.httpEtag } })).toBeNull();
    expect(await (await p.store.get('state'))!.text()).toBe('two');
  });

  it('does not turn permission or pinned-generation failures into absence', async () => {
    const denied = provider(); denied.setDenied();
    await expect(denied.store.head('private')).rejects.toMatchObject({ code: 403 });
    await expect(denied.store.get('private')).rejects.toBeInstanceOf(GcsStorageError);
    const raced = provider(); raced.seed('private', 'x'); raced.vanishBeforeMedia();
    await expect(raced.store.get('private')).rejects.toMatchObject({ code: 404 });
  });

  it('streams request bytes and paginates a tenant prefix without listing siblings', async () => {
    const p = provider();
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('streamed')); c.close(); } });
    await p.store.put('tenant/a', stream); await p.store.put('tenant/b', 'two'); await p.store.put('other/a', 'hidden');
    expect(p.requests.find(x => x.method === 'PUT')!.init.body).toBe(stream);
    const one = await p.store.list({ prefix: 'tenant/', limit: 1 });
    const two = await p.store.list({ prefix: 'tenant/', limit: 1, cursor: one.cursor });
    expect(one.objects.map(x => x.key)).toEqual(['tenant/a']); expect(one.truncated).toBe(true);
    expect(two.objects.map(x => x.key)).toEqual(['tenant/b']); expect(two.truncated).toBe(false);
  });
});

describe('GCS multipart generation and retry integrity', () => {
  it('reconciles a committed session when its creation response is lost', async () => {
    const p = provider(); p.loseNextCommitResponse();
    const upload = await p.store.createMultipartUpload('bundle', { customMetadata: { visibility: 'private' } });
    const part = await upload.uploadPart(1, 'same operation'); await upload.complete([part]);
    expect([...p.objects.keys()].filter(x => x.endsWith('/session'))).toHaveLength(1);
    expect((await p.store.head('bundle'))!.customMetadata.gcsUploadId).toBe(upload.uploadId);
  });

  it('resumes the same upload and preserves exact ordered bytes and metadata', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle', { customMetadata: { sha256: 'admitted', visibility: 'private' } });
    const first = await upload.uploadPart(1, 'abc');
    const resumed = p.store.resumeMultipartUpload('bundle', upload.uploadId);
    const second = await resumed.uploadPart(2, 'def');
    await resumed.complete([first, second]);
    expect(await (await p.store.get('bundle'))!.text()).toBe('abcdef');
    expect((await p.store.head('bundle'))!.customMetadata.visibility).toBe('private');
    expect((await p.store.head('bundle'))!.customMetadata.gcsUploadId).toBe(upload.uploadId);
  });

  it('reconciles a lost completion response without composing or replacing again', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const part = await upload.uploadPart(1, 'signed bytes');
    p.loseNextCommitResponse(); await expect(upload.complete([part])).rejects.toThrow('response lost');
    const generation = p.objects.get('bundle')!.generation;
    expect((await p.store.resumeMultipartUpload('bundle', upload.uploadId).complete([part])).version).toBe(generation);
    expect(p.requests.filter(x => x.url.pathname.endsWith('/compose'))).toHaveLength(1);
  });

  it('refuses replacement of an occupied destination and mismatched tenant sessions', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('tenant/bundle'); const part = await upload.uploadPart(1, 'new');
    p.seed('tenant/bundle', 'retained');
    await expect(upload.complete([part])).rejects.toMatchObject({ code: 412 });
    expect(await (await p.store.get('tenant/bundle'))!.text()).toBe('retained');
    await expect(p.store.resumeMultipartUpload('other/bundle', upload.uploadId).uploadPart(2, 'x')).rejects.toThrow('does not match');
  });

  it('rejects stale part generations and reordered/duplicate receipts', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const first = await upload.uploadPart(1, 'old');
    await upload.uploadPart(1, 'different');
    await expect(upload.complete([first])).rejects.toMatchObject({ code: 404 });
    await expect(upload.complete([first, first])).rejects.toThrow('invalid multipart receipts');
    expect(await p.store.head('bundle')).toBeNull();
  });

  it('composes more than 32 parts in bounded generation-pinned stages', async () => {
    const p = provider(); const upload = await p.store.createMultipartUpload('bundle'); const parts = [];
    for (let n = 1; n <= 65; n++) parts.push(await upload.uploadPart(n, String(n) + ','));
    await upload.complete(parts);
    expect(await (await p.store.get('bundle'))!.text()).toBe(Array.from({ length: 65 }, (_, i) => `${i + 1},`).join(''));
    expect(p.requests.filter(x => x.url.pathname.endsWith('/compose'))).toHaveLength(4);
  });

  it('aborts only that session, preserving published and unrelated tenant objects', async () => {
    const p = provider(); p.seed('other/object', 'private'); const upload = await p.store.createMultipartUpload('bundle');
    const part = await upload.uploadPart(1, 'published'); await upload.complete([part]); await upload.abort();
    expect([...p.objects.keys()].sort()).toEqual(['bundle', 'other/object']);
    await expect(upload.uploadPart(2, 'late')).rejects.toThrow('session missing');
  });
});
