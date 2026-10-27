import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from 'vite';
import { desktopPortalSource } from './desktop-portal-source';

const ENTRY = 'virtual:desktop-portal-entry';
const INTERNAL_ENTRY = '\0' + ENTRY;

/** Private candidate selection; ordinary Vite builds keep the legacy graph. */
export async function desktopPortalPlugin(input: {
  papercuspRoot: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Plugin> {
  const env = input.env ?? process.env;
  const choice = env.PAPERCUSP_DESKTOP_INTERFACE ?? 'legacy';
  if (choice !== 'legacy' && choice !== 'portal-candidate') {
    throw new Error('Unknown desktop interface; choose legacy or portal-candidate');
  }
  const candidate = choice === 'portal-candidate';
  const root = realpathSync(input.papercuspRoot);
  const source = candidate ? desktopPortalSource({
    papercuspRoot: root, portalRoot: env.PAPERCUSP_DESKTOP_PORTAL_ROOT ?? '',
  }) : null;
  const load = createRequire(resolve(root, 'package.json'));
  const seam = source ? await import(pathToFileURL(resolve(source.root,
    'apps/host/src/operator-surface-build.mjs')).href) : null;
  const shims: Array<{ pattern: RegExp; replacement: string }> = seam
    ? seam.operatorSurfaceShims(root, source!.root).filter((item: { replacement: string }) => {
      const path = relative(root, realpathSync(item.replacement));
      return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    }) : [];

  return {
    name: 'papercusp-private-desktop-portal',
    enforce: 'pre',
    config() {
      return { define: { __PAPERCUSP_DESKTOP_PORTAL__: JSON.stringify(candidate) } };
    },
    configResolved(config) {
      if (!candidate) return;
      // A private UI may never overwrite the dist consumed by the ordinary
      // desktop/package/public pipeline, including through a symlinked parent.
      const directory = env.PAPERCUSP_VITE_OUT_DIR;
      if (!directory || !isAbsolute(directory)) throw new Error('Portal candidate requires an explicit private output directory');
      const boundary = resolve(homedir(), '.papercusp/desktop-candidates');
      const out = resolve(config.root, config.build.outDir);
      const path = relative(boundary, out);
      if (out !== resolve(directory) || !path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        throw new Error('Portal candidate output must be inside ~/.papercusp/desktop-candidates');
      }
      let parent = out;
      while (resolve(parent, '..') !== parent) {
        try {
          if (realpathSync(parent) !== parent) throw new Error('Portal candidate output cannot traverse symlinks');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        parent = resolve(parent, '..');
      }
    },
    resolveId(id) {
      if (id === ENTRY) return INTERNAL_ENTRY;
      if (!source) return;
      if (id === '@portal/ui') return source.uiEntry;
      if (id === '@portal/contracts') return source.contractsEntry;
      if (id === '@tauri-apps/api' || id.startsWith('@tauri-apps/api/') ||
        Object.keys(source.singletonRoots).some(name => id === name || id.startsWith(`${name}/`))) return load.resolve(id);
      return shims.find(shim => shim.pattern.test(id))?.replacement;
    },
    load(id) {
      if (id !== INTERNAL_ENTRY) return;
      return source
        ? [...source.styles.map(file => `import ${JSON.stringify(file)};`),
          'export { PortalEntry as default } from "@portal/ui";'].join('\n')
        : 'export default function DisabledPortalCandidate() { return null; }';
    },
    transformIndexHtml(html) {
      return html.replace(/(<meta\s+name="papercusp-desktop-interface"\s+content=")[^"]+("\s*\/?>)/,
        `$1${choice}$2`);
    },
  };
}
