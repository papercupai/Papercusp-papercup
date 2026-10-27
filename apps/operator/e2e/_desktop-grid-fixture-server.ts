import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Page } from '@playwright/test';

// Shared by desktop-grid.spec.ts (cloud) and desktop-grid-local.spec.ts (this computer):
// one isolated Vite server per spec that serves ONE fixture module with a closed
// dependency set, the same shape desktop-render-matrix.spec.ts uses. The noVNC RFB
// class is replaced by the deterministic framebuffer in __fixtures__/desktop-render-rfb.ts,
// and an optional `aliases` map substitutes further modules (the local spec stubs
// @papercusp/sync, whose real provider needs a live operator SSE stream).
export const root = path.resolve(import.meta.dirname, '../../..');

/** A text matcher requiring every (non-null) part to appear somewhere in the element. */
export function containsAll(...parts: Array<string | null>): RegExp {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(parts.filter((part): part is string => !!part).map((part) => `(?=[\\s\\S]*${escape(part)})`).join(''));
}

/**
 * Decoded pixel width of every grid thumbnail, in tile order. Decodes a fresh Image from
 * each tile's own src, so the answer does not depend on the <img> being scrolled into
 * view (tiles load lazily) or on a layout-stability wait. A src revoked mid-refresh
 * rejects; the caller's expect.poll simply asks again.
 */
export function decodedThumbnailWidths(page: Page): Promise<number[]> {
  return page.getByRole('list', { name: 'Available desktops' }).locator('img').evaluateAll(
    (images: HTMLImageElement[]) => Promise.all(images.map(async (image) => {
      const copy = new Image();
      copy.src = image.src;
      await copy.decode();
      return copy.naturalWidth;
    })).catch(() => [] as number[]),
  );
}

export interface DesktopGridFixtureServer {
  server: ViteDevServer;
  origin: string;
}

export async function startDesktopGridFixtureServer(
  fixture: string,
  aliases: Record<string, string> = {},
  optimizedDependencies: string[] = [],
): Promise<DesktopGridFixtureServer> {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: false, root, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    css: { postcss: { plugins: [] } },
    resolve: { alias: { '@': path.join(root, 'apps/operator') } },
    optimizeDeps: {
      entries: [fixture],
      noDiscovery: true,
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime',
        'lucide-react', '@radix-ui/react-slot', 'nuqs', 'nuqs/adapters/react', ...optimizedDependencies],
    },
    plugins: [{
      name: 'desktop-grid-fixture',
      enforce: 'pre',
      resolveId(id) {
        if (id === '@novnc/novnc') return path.join(root, 'apps/operator/e2e/__fixtures__/desktop-render-rfb.ts');
        const alias = aliases[id];
        if (alias) return path.join(root, alias);
        return undefined;
      },
      configureServer(instance) {
        instance.middlewares.use((req, res, next) => {
          if (new URL(req.url ?? '/', 'http://fixture').pathname !== '/') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
            <style>:root{--fg:#17202c;--fg-dim:#384454;--fg-mute:#5d6878;--border:#d3dbe5;--bg-deeper:#f1f4f8;--good:#167044;background:#fff;color:var(--fg);font:14px system-ui}
            *{box-sizing:border-box}body{margin:0}main{padding:24px;min-width:0}button{font:inherit;color:inherit;cursor:pointer}.pc-btn{padding:6px 10px;border:1px solid var(--border);background:transparent;border-radius:6px}button:disabled{opacity:.45;cursor:default}</style>
            </head><body><div id="root"></div><script type="module" src="/${fixture}"></script></body></html>`);
        });
      },
    }],
    // No HMR and no file watcher. root is the whole shared tree that the fleet edits
    // continuously: a watched change sent a full-reload mid-test (trace 2026-10-06:
    // the page re-navigated to / 20s after load, detaching the tile under a click),
    // and chokidar crawling the monorepo spends this job's CPU on a loaded box.
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
  });
  await server.listen();
  return { server, origin: server.resolvedUrls!.local[0]!.replace(/\/$/, '') };
}
