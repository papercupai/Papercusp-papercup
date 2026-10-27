import { build } from 'esbuild';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { desktopPortalSource } from './desktop-portal-source.ts';

/** Compile the shared candidate graph in memory, independently of public builds. */
export async function prepareDesktopPortalBundle(input: {
  portalRoot: string;
  papercuspRoot: string;
  outputDirectory: string;
}) {
  const source = desktopPortalSource(input);
  const desktopRoot = realpathSync(input.papercuspRoot);
  const desktopRequire = createRequire(resolve(desktopRoot, 'package.json'));
  // Reuse the portal's existing source/build boundary. Only its desktop-owned
  // server-code shims belong here: browser host/router/native substitutes do not.
  const seam = await import(pathToFileURL(resolve(source.root, 'apps/host/src/operator-surface-build.mjs')).href);
  const shims: Array<{ pattern: RegExp; replacement: string }> = seam.operatorSurfaceShims(desktopRoot, source.root)
    .filter((item: { replacement: string }) => {
      const path = relative(desktopRoot, realpathSync(item.replacement));
      return path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    });
  const aliases = Object.entries(seam.operatorSurfaceAliases(desktopRoot)) as Array<[string, string]>;
  const result = await build({
    absWorkingDir: desktopRoot,
    stdin: {
      contents: [...source.styles.map(file => `import ${JSON.stringify(file)};`),
        'export { PortalEntry } from "@portal/ui";'].join('\n'),
      resolveDir: desktopRoot,
      sourcefile: 'desktop-portal-candidate-entry.tsx',
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    splitting: true,
    outdir: input.outputDirectory,
    logLevel: 'silent',
    jsx: 'automatic',
    target: 'es2022',
    // Match the desktop production build's conditional package exports, plus
    // CSS packages whose stylesheet export explicitly uses the style condition.
    conditions: ['production', 'style'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{"MODE":"production","DEV":false,"PROD":true}',
    },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
    plugins: [{
      name: 'desktop-portal-shared-source',
      setup(api) {
        api.onResolve({ filter: /.*/ }, async args => {
          if (args.pluginData?.resolvedDesktopAlias) return;
          let path: string | undefined;
          if (args.path === '@portal/ui') path = source.uiEntry;
          else if (args.path === '@portal/contracts') path = source.contractsEntry;
          else if (args.path === '@tauri-apps/api' || args.path.startsWith('@tauri-apps/api/') ||
            Object.keys(source.singletonRoots).some(name => args.path === name || args.path.startsWith(`${name}/`))) {
            path = desktopRequire.resolve(args.path);
          } else {
            const shim = shims.find(item => item.pattern.test(args.path));
            if (shim) path = shim.replacement;
            else {
              const alias = aliases.find(([name]) => args.path === name || args.path.startsWith(`${name}/`));
              if (alias) path = alias[1] + args.path.slice(alias[0].length);
            }
          }
          if (!path) return;
          return api.resolve(path, {
            kind: args.kind,
            resolveDir: desktopRoot,
            pluginData: { resolvedDesktopAlias: true },
          });
        });
      },
    }],
  });
  if (desktopPortalSource(input).sourceFingerprint !== source.sourceFingerprint) {
    throw new Error('Portal source inputs changed during candidate preparation; no output was written');
  }
  return { source, ...result };
}
