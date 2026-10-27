import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@papercusp/artifact-registry';
import { buildArtifactPackage } from '@papercusp/operator-core/lib/p2p/artifact-package.ts';
import { cupboardArtifactKey } from '@papercusp/operator-core/lib/cupboard/artifact-store.ts';
import { gcsTestProvider } from '../../../../libs/generic/artifact-registry/src/gcs-test-provider.ts';
import { makeEnv, stubGithub } from '../__tests__/fake-d1.ts';
import { buildApi } from './index.ts';

const api = buildApi();
const enc = new TextEncoder();
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function setup() {
  stubGithub({ user: { id: 7, login: 'operator' } });
  const provider = gcsTestProvider();
  const { env, store } = makeEnv({ ARTIFACTS: provider.store, CUPBOARD_OPERATOR_GITHUB_IDS: '7' });
  return { ...provider, env, db: store };
}
function manifest(contentHash: string, size: number) {
  return { listing_kind: 'plugin', listing_ref: 'gcs-private', github_repository_id: 7,
    github_owner: 'operator', github_name: 'gcs-private', github_url: 'https://github.com/operator/gcs-private',
    title: 'Private GCS artifact', description: 'private creator object',
    artifact: { content_hash: contentHash, size_bytes: size, content_type: 'application/octet-stream' } };
}

describe('Cupboard HTTP routes through the private GCS protocol adapter', () => {
  it('admits exact public package bytes and returns them without granting direct bucket access', async () => {
    const p = setup(); const bytes = enc.encode(JSON.stringify({ files: [{ path: 'recipe.json', body: 'google' }] }));
    const root = buildArtifactPackage(Buffer.from(bytes)).rootHash;
    const url = `/artifacts/sha256/${root.slice(7)}`;
    const upload = await api.request(url, { method: 'PUT', headers: { authorization: 'Bearer operator' }, body: bytes }, p.env);
    expect(upload.status).toBe(201);
    const response = await api.request(url, {}, p.env);
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect((await api.request(url, { method: 'PUT', headers: { authorization: 'Bearer operator' }, body: bytes }, p.env)).status).toBe(200);
    expect(p.requests.filter(x => x.method === 'PUT')).toHaveLength(1);
  });

  it('preserves an occupied private key when it wins the public-upload race', async () => {
    const p = setup(); const bytes = enc.encode(JSON.stringify({ files: [{ path: 'recipe.json', body: 'race' }] }));
    const root = buildArtifactPackage(Buffer.from(bytes)).rootHash; const key = cupboardArtifactKey(root);
    p.beforeUploadCommit(() => { p.seed(key, 'private retained bytes', { metadata: { draftId: 'private-owner' } }); });
    const response = await api.request(`/artifacts/sha256/${root.slice(7)}`, {
      method: 'PUT', headers: { authorization: 'Bearer operator' }, body: bytes,
    }, p.env);
    expect(response.status).toBe(409);
    expect(await (await p.store.get(key))!.text()).toBe('private retained bytes');
    expect((await api.request(`/artifacts/sha256/${root.slice(7)}`, {}, p.env)).status).toBe(404);
  });

  it('keeps a creator artifact private and rejects a collision at commit', async () => {
    const p = setup(); const bytes = enc.encode('private creator content'); const hash = `sha256:${await sha256Hex(bytes)}`;
    const create = await api.request('/creator-drafts', { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(hash, bytes.length) }) }, p.env);
    expect(create.status).toBe(201); const draft = await create.json() as { upload_url: string };
    const upload = await api.request(draft.upload_url, { method: 'PUT', body: bytes }, p.env);
    expect(upload.status).toBe(200);
    expect((await api.request(`/artifacts/sha256/${hash.slice(7)}`, {}, p.env)).status).toBe(404);
    const other = setup();
    const another = await api.request('/creator-drafts', { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: manifest(hash, bytes.length) }) }, other.env);
    const raced = await another.json() as { upload_url: string };
    other.beforeUploadCommit(() => { other.seed(cupboardArtifactKey(hash), 'first writer'); });
    expect((await api.request(raced.upload_url, { method: 'PUT', body: bytes }, other.env)).status).toBe(409);
    expect(await (await other.store.get(cupboardArtifactKey(hash)))!.text()).toBe('first writer');
  });

  it('resumes the original multipart HTTP operation and hides unfinalized bytes', async () => {
    const p = setup(); const bytes = enc.encode('same admitted multipart bundle'); const hash = await sha256Hex(bytes);
    const operation = crypto.randomUUID();
    const base = `/admin/artifacts/workspace-host/sha256/${hash}/server.tgz/multipart`;
    const headers = { authorization: 'Bearer operator', 'content-type': 'application/json', 'x-artifact-sha256': hash,
      'x-artifact-size': String(bytes.length), 'x-operation-id': operation };
    const start = () => api.request(base, { method: 'POST', headers,
      body: JSON.stringify({ parts: [{ partNumber: 1, sha256: hash, sizeBytes: bytes.length }] }) }, p.env);
    expect((await start()).status).toBe(201);
    const resumed = await start(); expect(resumed.status).toBe(200); expect(await resumed.json()).toMatchObject({ resumed: true, uploadId: operation });
    const before = await api.request(`/artifacts/workspace-host/sha256/${hash}/server.tgz`, {}, p.env);
    expect(before.status).toBe(404);
    const part = await api.request(`${base}/parts/1?uploadId=${operation}`, { method: 'PUT', body: bytes,
      headers: { authorization: 'Bearer operator', 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'x-part-sha256': hash, 'x-part-size': String(bytes.length) } }, p.env);
    expect(part.status).toBe(200); const receipt = await part.json() as { etag: string };
    const complete = () => api.request(`${base}/complete?uploadId=${operation}`, { method: 'POST', headers: { authorization: 'Bearer operator', 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: receipt.etag }] }) }, p.env);
    expect((await complete()).status).toBe(201); expect((await complete()).status).toBe(200);
    expect(new Uint8Array(await (await p.store.get(`artifacts/workspace-host/sha256/${hash}/server.tgz`))!.arrayBuffer())).toEqual(bytes);
    expect((await api.request(`/artifacts/workspace-host/sha256/${hash}/server.tgz`, {}, p.env)).status).toBe(404);
    expect([...p.objects.keys()].filter(x => x.endsWith('/session'))).toHaveLength(1);
  });

  it('denies anonymous workspace writes before any Google request', async () => {
    const p = setup(); const hash = await sha256Hex(enc.encode('unsigned'));
    const response = await api.request(`/admin/artifacts/workspace-host/sha256/${hash}/server.tgz`, { method: 'PUT', body: 'unsigned' }, p.env);
    expect(response.status).toBe(401); expect(p.requests).toHaveLength(0);
  });
});
