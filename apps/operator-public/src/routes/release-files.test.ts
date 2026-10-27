import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@papercusp/artifact-registry';
import { gcsTestProvider } from '../../../../libs/generic/artifact-registry/src/gcs-test-provider.ts';
import { makeEnv } from '../__tests__/fake-d1.ts';
import { buildApi } from './index.ts';

const api = buildApi();
const prefix = `releases/${'a'.repeat(40)}`;
function setup() {
  const p = gcsTestProvider();
  return { ...p, env: makeEnv({ ARTIFACTS: p.store, RELEASE_PATH_PREFIX: prefix }).env };
}

describe('release delivery through private GCS', () => {
  it.each([
    ['desktop-v1.0.0/Server installer.exe', 'signed installer', 'application/octet-stream'],
    ['desktop-v1.0.0/Server installer.exe.sig', 'detached signature', 'text/plain'],
    ['latest.json', '{"version":"1.0.0"}', 'application/json'],
    ['history.json', '{"releases":[]}', 'application/json'],
    ['instructions.html', '<p>Install the signed release</p>', 'text/html'],
    ['pui/1.0.0/archive.tar.gz', 'accepted PUI archive', 'application/gzip'],
  ])('streams exact %s and its HEAD metadata', async (file, content, type) => {
    const p = setup(); const bytes = new TextEncoder().encode(content); const sha = await sha256Hex(bytes);
    p.seed(`${prefix}/${file}`, content, { metadata: { sha256: sha }, contentType: type });
    const path = `/${prefix}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const response = await api.request(path, {}, p.env);
    expect(response.status).toBe(200); expect(await response.text()).toBe(content);
    expect(response.headers.get('content-type')).toBe(type);
    expect(response.headers.get('x-content-sha256')).toBe(sha);
    const head = await api.request(path, { method: 'HEAD' }, p.env);
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(head.headers.get('etag')).toBe(response.headers.get('etag'));
  });

  it('confines reads to the configured namespace and refuses write/list doors', async () => {
    const p = setup(); const sha = await sha256Hex(new TextEncoder().encode('private'));
    p.seed('artifacts/cupboard/sha256/private', 'private', { metadata: { sha256: sha } });
    p.seed('releases/another-namespace/private', 'private', { metadata: { sha256: sha } });
    for (const path of [`/${prefix}/`, '/releases/another-namespace/private',
      `/${prefix}/%2e%2e%2fartifacts%2fcupboard%2fsha256%2fprivate`, `/${prefix}/bad%00key`, `/${prefix}/%zz`]) {
      expect((await api.request(path, {}, p.env)).status).toBe(404);
    }
    expect(p.requests).toHaveLength(0);
    expect((await api.request(`/${prefix}/file`, { method: 'PUT', body: 'attempt' }, p.env)).status).toBe(405);
    expect(p.requests).toHaveLength(0);
    expect((await api.request(`/${prefix}/file`, {}, { ...p.env, RELEASE_PATH_PREFIX: undefined })).status).toBe(404);
  });

  it('hides objects lacking publisher integrity metadata and responds to conditional reads', async () => {
    const p = setup(); p.seed(`${prefix}/unadmitted`, 'bytes');
    expect((await api.request(`/${prefix}/unadmitted`, {}, p.env)).status).toBe(404);
    const sha = await sha256Hex(new TextEncoder().encode('signed'));
    p.seed(`${prefix}/accepted`, 'signed', { metadata: { sha256: sha } });
    const head = await api.request(`/${prefix}/accepted`, { method: 'HEAD' }, p.env);
    const cached = await api.request(`/${prefix}/accepted`, { headers: { 'if-none-match': head.headers.get('etag')! } }, p.env);
    expect(cached.status).toBe(304); expect(await cached.text()).toBe('');
  });

  it('returns a measurable provider failure without leaking credentials or claiming absence', async () => {
    const p = setup();
    const store = new Proxy(p.store, { get(target, property, receiver) {
      if (property === 'get') return async () => { throw new Error('private account credential'); };
      return Reflect.get(target, property, receiver);
    } });
    const response = await api.request(`/${prefix}/latest.json`, {}, { ...p.env, ARTIFACTS: store });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'release_storage_unavailable' });
  });
});
