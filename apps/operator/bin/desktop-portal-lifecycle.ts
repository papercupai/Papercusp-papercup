import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Http2Bindings, HttpBindings } from '@hono/node-server';
import { createDesktopPortalHost } from './desktop-portal-host';

type Bindings = HttpBindings | Http2Bindings;
type Operator = (request: Request, bindings?: Bindings) => Response | Promise<Response>;
type Application = { fetch: Operator; stop(): Promise<void> };
type Factory = (options: { operator: Operator; createHost: typeof createDesktopPortalHost }) => Promise<Application>;

/** One lazy persistent portal runtime per explicitly selected private host. */
export function createDesktopPortalLifecycle(options: {
  operator: Operator;
  env?: NodeJS.ProcessEnv;
  load?: (file: string) => Promise<{ createDesktopPortalApplication: Factory }>;
}) {
  const env = options.env ?? process.env;
  const choice = env.PAPERCUSP_DESKTOP_INTERFACE ?? 'legacy';
  if (choice !== 'legacy' && choice !== 'portal-candidate') throw new Error('Unknown desktop interface');
  const candidate = choice === 'portal-candidate';
  const file = env.PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE ?? '';
  if (candidate && (!isAbsolute(file) || !file.endsWith('.cjs'))) {
    throw new Error('Portal candidate requires an explicit prepared .cjs host bundle');
  }
  if (candidate && !env.PORTAL_DATABASE_URL?.trim()) {
    throw new Error('Portal candidate requires an explicit persistent PORTAL_DATABASE_URL');
  }
  if (candidate && env.PORTAL_USE_MEMORY_STORE === '1') {
    throw new Error('Portal candidate cannot use an ephemeral memory store');
  }
  const load = options.load ?? (async (path: string) => {
    const module = await import(pathToFileURL(path).href);
    return module.default ?? module;
  });
  let application: Promise<Application> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    fetch(request: Request, bindings?: Bindings): Response | Promise<Response> {
      if (!candidate || new URL(request.url).pathname === '/api/health') return options.operator(request, bindings);
      if (stopping) return Response.json({ ok: false, error: 'desktop_portal_stopping' }, { status: 503 });
      application ??= load(file).then(module => {
        if (typeof module.createDesktopPortalApplication !== 'function') throw new Error('Invalid desktop portal host bundle');
        // The prepared factory's default runtime is persistent. Inject the
        // adapter rather than duplicating the desktop's AsyncLocalStorage guards.
        return module.createDesktopPortalApplication({ operator: options.operator, createHost: createDesktopPortalHost });
      });
      return application.then(app => app.fetch(request, bindings));
    },
    stop(): Promise<void> {
      // Await an in-flight open, close once, and never open a store just to stop.
      return stopping ??= (application?.then(app => app.stop()) ?? Promise.resolve());
    },
  };
}
