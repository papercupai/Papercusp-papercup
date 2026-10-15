import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicDocsRelativePath, servePublicDocs } from './public-docs';

describe('public manual read boundary', () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'public-docs-test-'));
    root = join(dir, 'public');
    await mkdir(join(root, 'pagefind'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'index.html'), '<h1>Public manual</h1>'),
      writeFile(join(root, 'using-the-app.html'), '<h1>Get started</h1>'),
      writeFile(join(root, '404.html'), '<h1>Not found</h1>'),
      writeFile(join(root, 'pagefind', 'pagefind.js'), 'export const search = true;'),
      writeFile(join(dir, 'private.txt'), 'private-engineering-secret'),
    ]);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const request = (path: string, method = 'GET') => new Request(`https://portal.example${path}`, { method });

  it.each(['/docs', '/docs/', '/docs/index.html'])('serves the anonymous home at %s', async (path) => {
    const response = await servePublicDocs(request(path), root);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Public manual');
    expect(response.headers.get('content-type')).toContain('text/html');
  });
  it('serves extensionless articles and correct search MIME without auth', async () => {
    expect(await (await servePublicDocs(request('/docs/using-the-app/'), root)).text()).toContain('Get started');
    const asset = await servePublicDocs(request('/docs/pagefind/pagefind.js'), root);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('HEAD matches GET status and headers with no body', async () => {
    for (const path of ['/docs', '/docs/using-the-app', '/docs/missing', '/docs/%', '/docs/%00secret']) {
      const get = await servePublicDocs(request(path), root);
      const head = await servePublicDocs(request(path, 'HEAD'), root);
      expect(head.status).toBe(get.status);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(await head.text()).toBe('');
    }
  });
  it('revalidates the same FAQ and Pagefind URLs after their published bytes change', async () => {
    const artifacts = [
      { path: '/docs/faq', file: 'faq.html', before: 'Old FAQ answer', after: 'Reviewed FAQ answer' },
      { path: '/docs/pagefind/index.pf_index', file: 'pagefind/index.pf_index', before: 'old index', after: 'revised index' },
    ];
    for (const artifact of artifacts) {
      await writeFile(join(root, artifact.file), artifact.before);
      const before = await servePublicDocs(request(artifact.path), root);
      expect(before.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(await before.text()).toBe(artifact.before);
      await writeFile(join(root, artifact.file), artifact.after);
      const after = await servePublicDocs(request(artifact.path), root);
      expect(after.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
      expect(await after.text()).toBe(artifact.after);
    }
  });
  it.each(['pf_meta', 'pf_index', 'pf_fragment', 'pagefind'])('serves Pagefind binary %s without HTML fallback', async (extension) => {
    const path = `/docs/pagefind/test.${extension}`;
    await writeFile(join(root, 'pagefind', `test.${extension}`), new Uint8Array([0, 97, 115, 109]));
    const response = await servePublicDocs(request(path), root);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    const head = await servePublicDocs(request(path, 'HEAD'), root);
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
  });
  it('returns genuine missing-page and unavailable-artifact statuses', async () => {
    expect((await servePublicDocs(request('/docs/missing'), root)).status).toBe(404);
    expect((await servePublicDocs(request('/docs'), join(dir, 'absent'))).status).toBe(503);
    const unavailable = await servePublicDocs(request('/docs', 'HEAD'), join(dir, 'absent'));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe('');
  });
  it('never serves files outside the public asset extension allowlist', async () => {
    await writeFile(join(root, 'server.ts'), 'private-engineering-secret');
    await writeFile(join(root, '.env'), 'private-engineering-secret');
    for (const path of ['/docs/server.ts', '/docs/.env']) {
      const response = await servePublicDocs(request(path), root);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('private-engineering-secret');
    }
  });
  it.each(['/docs/%', '/docs/%2e%2e%2fprivate.txt', '/docs/%252e%252e/private.txt',
    '/docs/%5c..%5cprivate.txt', '/docs/%00secret', '/internal/docs/index.html', '/api/config'])(
    'rejects an invalid namespace or path: %s', async (path) => {
      expect(publicDocsRelativePath(path)).toBeNull();
      const response = await servePublicDocs(request(path), root);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('private-engineering-secret');
    });
  it('refuses symlink escape and non-read methods', async () => {
    await symlink(join(dir, 'private.txt'), join(root, 'escape.txt'));
    expect((await servePublicDocs(request('/docs/escape.txt'), root)).status).toBe(404);
    const response = await servePublicDocs(request('/docs', 'POST'), root);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
