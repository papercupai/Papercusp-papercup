/**
 * Dev-server-only flag seed for the Vite dev server (:3055).
 *
 * Seeds `window.__PAPERCUSP_FLAGS__` into the served index.html so the SPA
 * paints with real flag state on first load instead of FLAG_DEFAULTS — the same
 * flash the built desktop avoids by injecting the seed in the Hono SPA host
 * (apps/operator/bin/host-spa.ts). In dev the Vite server is a SEPARATE process
 * from the Hono host (:3070) that owns the flag backend, so calling
 * getAllFlags() here would see an uninitialized backend and always return
 * defaults. Instead we fetch the exact payload the client would
 * (/api/flags/bootstrap on :3070, the endpoint the proxy forwards to) and
 * inline it. Best-effort: if the host isn't up yet, inject nothing and let the
 * client bootstrap flags asynchronously.
 *
 * WI-10004079 — this MUST be `apply: 'serve'`. Without it, Vite also runs
 * transformIndexHtml during `vite build` (and `vite build --watch`). Every
 * built index.html, including the one shipped in the desktop sidecar, then
 * baked the BUILD HOST's live :3070 flag snapshot. At runtime host-spa.ts
 * injects the installed app's OWN flags right after <head>, and the baked
 * script, which also sits right after <head>, ran second and overwrote them. So
 * the installed client's first paint used the build machine's flag overrides.
 * The baked `evaluatedAt` also made index.html non-reproducible between two
 * builds of the same commit. Built output must carry no seed; the host is the
 * one place that injects one.
 */
import type { Plugin } from 'vite';

export const FLAGS_BOOTSTRAP_URL = 'http://127.0.0.1:3070/api/flags/bootstrap';

type FetchLike = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Insert the seed script so it runs before the deferred module bundle. */
export function injectFlagsSeed(html: string, payload: unknown): string {
  const seed = `<script>window.__PAPERCUSP_FLAGS__=${JSON.stringify(payload)};</script>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${seed}`) : seed + html;
}

/** The transform, with the fetch injectable so it is testable without a host. */
export async function seedIndexHtmlWithFlags(html: string, fetchImpl: FetchLike = fetch): Promise<string> {
  try {
    const res = await fetchImpl(FLAGS_BOOTSTRAP_URL);
    if (!res.ok) return html;
    return injectFlagsSeed(html, await res.json());
  } catch {
    return html;
  }
}

/** Match host-spa's pre-hydration workspace identity on the separate dev server. */
export async function seedIndexHtmlWithWorkspace(
  html: string,
  requestUrl: string | undefined,
  apiTarget: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let workspace = new URL(requestUrl ?? '/', 'http://localhost').searchParams.get('ws')?.trim();
  if (!workspace) {
    try {
      const response = await fetchImpl(new URL('/api/workspaces', apiTarget).href);
      if (response.ok) {
        const registry = await response.json() as { current?: unknown };
        if (typeof registry.current === 'string') workspace = registry.current.trim();
      }
    } catch {
      // A disconnected host leaves identity to the existing browser fallback.
    }
  }
  if (!workspace) return html;
  const json = JSON.stringify(workspace).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const seed = `<script>window.__PAPERCUSP_WS__=${json};</script>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>${seed}`) : seed + html;
}

export const flagsBootstrapPlugin: Plugin = {
  name: 'papercusp-flags-bootstrap',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler: async (html, context) => seedIndexHtmlWithWorkspace(
      await seedIndexHtmlWithFlags(html),
      context.originalUrl,
      process.env.PAPERCUSP_API_TARGET ?? 'http://127.0.0.1:3070',
    ),
  },
};
