import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { desktopPortalSource } from '../../operator-vite/desktop-portal-source.ts';

/** Prepare the maintained local portal API alongside the desktop's host seam. */
export async function prepareDesktopPortalHostBundle(input: {
  portalRoot: string;
  papercuspRoot: string;
  outputFile: string;
}) {
  const source = desktopPortalSource(input);
  const desktopRoot = realpathSync(input.papercuspRoot);
  const desktopAdapter = 'apps/operator/bin/desktop-portal-host.ts';
  const measureAdapter = () => ({ path: desktopAdapter,
    sha256: createHash('sha256').update(readFileSync(resolve(desktopRoot, desktopAdapter))).digest('hex'),
  });
  const desktopAdapterInput = measureAdapter();
  const files = [
    'apps/host/src/api.ts', 'apps/host/src/auth.ts', 'apps/host/src/runtime.ts',
    'apps/host/src/operator-relay.ts', 'apps/host/src/web-runtime.ts',
    'scripts/source-integrity.mjs',
  ].map(path => {
    const file = realpathSync(resolve(source.root, path));
    const rel = relative(source.root, file);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error(`Portal host input escapes its source root: ${path}`);
    }
    return { path, file };
  });
  const measure = () => files.map(({ path, file }) => ({ path,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }));
  const inputs = measure();
  const file = (path: string) => files.find(entry => entry.path === path)!.file;
  const policy = await import(pathToFileURL(file('scripts/source-integrity.mjs')).href);
  const spec = policy.serverRuntimeSpecs(source.root).find((entry: { packageName: string }) => entry.packageName === '@portal/web-runtime');
  if (!spec || realpathSync(spec.entry) !== file('apps/host/src/web-runtime.ts')) {
    throw new Error('Maintained portal web-runtime build policy is required');
  }
  const alias: Record<string, string> = {};
  const external: string[] = [];
  for (const arg of spec.extraArgs ?? []) {
    if (arg.startsWith('--external:')) external.push(arg.slice('--external:'.length));
    else if (arg.startsWith('--alias:')) {
      const value = arg.slice('--alias:'.length);
      const separator = value.indexOf('=');
      if (separator < 1) throw new Error(`Unsupported portal host build option: ${arg}`);
      alias[value.slice(0, separator)] = value.slice(separator + 1);
    } else throw new Error(`Unsupported portal host build option: ${arg}`);
  }
  const result = await build({
    absWorkingDir: source.root,
    stdin: {
      contents: [
        `import { createPortalApi } from ${JSON.stringify(file('apps/host/src/api.ts'))};`,
        `import { createLocalPortalAuthenticator } from ${JSON.stringify(file('apps/host/src/auth.ts'))};`,
        `import { createPortalRuntime } from ${JSON.stringify(file('apps/host/src/runtime.ts'))};`,
        `import { withOperatorTransport } from ${JSON.stringify(file('apps/host/src/operator-relay.ts'))};`,
        `import { composePortalRequestHandler } from ${JSON.stringify(file('apps/host/src/web-runtime.ts'))};`,
        'export { createPortalRuntime };',
        // Keep the desktop's ingress/peer AsyncLocalStorage in its original
        // module instance. A second bundled guard would lose that context.
        'export async function createDesktopPortalApplication({ operator, createHost, ownerId = "local", runtime: suppliedRuntime }) {',
        '  if (typeof createHost !== "function") throw new Error("desktop_portal_host_adapter_required");',
        '  const runtime = suppliedRuntime ?? await createPortalRuntime();',
        '  const portal = composePortalRequestHandler(createPortalApi(runtime, createLocalPortalAuthenticator(ownerId)), null);',
        '  const host = createHost({ portal, withOperatorTransport, operator });',
        '  let stopping;',
        '  return { ...host, stop: () => stopping ??= Promise.resolve().then(() => runtime.stop()) };',
        '}',
      ].join('\n'),
      resolveDir: source.root, sourcefile: 'desktop-portal-host-entry.ts', loader: 'ts',
    },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    minify: true, define: { 'import.meta.url': '__filename' },
    legalComments: 'none', logLevel: 'silent', alias, external,
    write: false, metafile: true, outfile: input.outputFile,
  });
  if (JSON.stringify(inputs) !== JSON.stringify(measure())
    || desktopAdapterInput.sha256 !== measureAdapter().sha256) {
    throw new Error('Portal host entry inputs changed during preparation; no output was written');
  }
  return { ...result, source, inputs, desktopAdapterInput,
    sourceFingerprint: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    scope: 'Local API composition and direct entry inputs; full source, packaged runtime and public acceptance remain separate.',
  };
}
