import { Hono } from 'hono';
import type { Env } from '../env.ts';

/** Public release delivery over the existing private object port. The secret
 * path selects only the release namespace, never Cupboard or creator objects.
 * Publishers retain their signature checks and advertise feeds after payloads.
 */
export function releaseFilesRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.all('/releases/*', async c => {
    const prefix = c.env.RELEASE_PATH_PREFIX;
    if (!prefix || !/^releases\/[A-Za-z0-9_-]{32,}$/.test(prefix)) return c.notFound();
    let key: string;
    try { key = decodeURIComponent(new URL(c.req.url).pathname.slice(1)); }
    catch { return c.notFound(); }
    if (!key.startsWith(`${prefix}/`) || key === `${prefix}/` ||
      key.includes('\\') || key.includes('\0') || key.split('/').some(p => !p || p === '.' || p === '..')) return c.notFound();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    try {
      const download = c.req.method === 'HEAD' ? null : await c.env.ARTIFACTS.get(key);
      const object = c.req.method === 'HEAD' ? await c.env.ARTIFACTS.head(key) : download;
      const body = download?.body ?? null;
      // Only authenticated publisher objects with admitted digest metadata are
      // deliverable. A private bucket is never made anonymously readable.
      if (!object) return c.notFound();
      if (!/^[a-f0-9]{64}$/.test(object.customMetadata.sha256 ?? '')) {
        await body?.cancel();
        return c.notFound();
      }
      const headers = new Headers({ 'x-content-type-options': 'nosniff' });
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('content-length', String(object.size));
      headers.set('x-content-sha256', object.customMetadata.sha256!);
      if (!headers.has('cache-control')) headers.set('cache-control', 'no-cache, max-age=0');
      if (c.req.header('if-none-match')?.split(',').some(tag => tag.trim() === object.httpEtag || tag.trim() === '*')) {
        await body?.cancel();
        headers.delete('content-length');
        return new Response(null, { status: 304, headers });
      }
      return new Response(body, { headers });
    } catch {
      // Provider failure is not absence or an "up to date" result. Do not expose
      // provider diagnostics, which may contain account or private object paths.
      return c.json({ error: 'release_storage_unavailable' }, 503);
    }
  });
  return app;
}
