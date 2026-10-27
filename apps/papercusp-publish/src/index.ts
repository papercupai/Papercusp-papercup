import { Hono } from 'hono';
import type { Env } from './env.ts';
import { registerRoute } from './routes/register.ts';
import { publishStartRoute } from './routes/publish-start.ts';
import { publishFileRoute } from './routes/publish-file.ts';
import { publishFinalizeRoute } from './routes/publish-finalize.ts';
import { publishStatusRoute } from './routes/publish-status.ts';
import { rotateSecretRoute } from './routes/rotate-secret.ts';
import { adminRoute } from './routes/admin.ts';
import { handleVanity } from './vanity-proxy.ts';
import { configuredGcsObjectStore } from '@papercusp/artifact-registry';

const api = new Hono<{ Bindings: Env }>();

api.get('/', (c) => c.json({ service: 'papercusp-publish', status: 'ok' }));
api.get('/healthz', (c) => c.json({ ok: true }));

api.route('/', registerRoute());
api.route('/', publishStartRoute());
api.route('/', publishFileRoute());
api.route('/', publishFinalizeRoute());
api.route('/', publishStatusRoute());
api.route('/', rotateSecretRoute());
api.route('/', adminRoute());

api.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  return c.json({ error: 'internal', detail: msg }, 500);
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (
      url.hostname === env.VANITY_HOST ||
      url.hostname.endsWith('.' + env.VANITY_HOST)
    ) {
      return handleVanity(req, env);
    }
    return api.fetch(req, { ...env, get ARCHIVE() { return configuredGcsObjectStore(env); } }, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Daily GC. Hits internal admin endpoints.
    const base = `https://${env.PUBLISH_HOST}`;
    ctx.waitUntil(
      Promise.all([
        fetch(`${base}/admin/gc/abandoned-uploads`, { method: 'POST' }),
        fetch(`${base}/admin/gc/expired-archives`, { method: 'POST' }),
        fetch(`${base}/admin/gc/jti`, { method: 'POST' }),
      ]).then(() => undefined),
    );
  },
};
