/**
 * operator-app-root.ts — resolve the `apps/operator` directory from the directory
 * of the module asking, in every layout this code actually runs in.
 *
 * Lifted out of desktop-install/papercusp-files.ts (which re-exports it) so that a
 * module needing a path under `apps/operator` — e.g. `scripts/ptool.mjs` — can
 * resolve it without pulling the desktop-install module graph in, and without the
 * fixed `new URL('../../../../../apps/operator/…', import.meta.url)` hop count that
 * is correct from SOURCE and wrong from every BUNDLE.
 *
 * Measured 2026-10-09 (WI-10007644): the stale-bg-host auto-restart actuator used
 * exactly that fixed-hop form. From its source file it resolved to the repo's
 * `apps/operator/scripts/ptool.mjs`; from the esbuild host bundle bg-host actually
 * runs (`apps/operator/dist-host/hono-host.mjs`) the same five hops resolved to
 * `$HOME/apps/operator/scripts/ptool.mjs`, which does not exist — so the actuator
 * never once reached `dev:restart` (0 of 1,398 restart calls in the ledger).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the operator app root from the directory containing a module.
 *
 * The source module lives below `packages/operator-core`, while an esbuild
 * bundle collapses the module directory to `sidecar/` and the dist-host build
 * puts it below `apps/operator/`. A fixed number of `..` hops therefore cannot
 * describe all three layouts. Walk upward and accept either an existing
 * `<ancestor>/apps/operator` (source/package sidecar) or an ancestor already
 * named `apps/operator` (dist-host/source app). The artifact check makes the
 * source and packaged choices self-validating instead of cwd-dependent.
 */
export function resolveOperatorAppRootFromModuleDir(moduleDir: string): string {
  const originalDir = path.resolve(moduleDir);
  let dir = originalDir;
  while (true) {
    if (path.basename(dir) === 'operator' && path.basename(path.dirname(dir)) === 'apps') {
      return dir;
    }

    const packagedAppRoot = path.join(dir, 'apps', 'operator');
    if (existsSync(packagedAppRoot)) return packagedAppRoot;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Preserve the old best-effort fallback for an incomplete/unpacked runtime;
  // callers that need a specific artifact must still check that it exists.
  return path.resolve(originalDir, '..', '..');
}
