import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareDesktopPortalHostBundle } from './desktop-portal-host-bundle';
import { createDesktopPortalHost } from './desktop-portal-host';
import { runAsExternalIngress } from '@papercusp/operator-core/lib/auth/forwarded-request-trust';

const desktopRoot = fileURLToPath(new URL('../../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'desktop-portal-host-'));
  temporary.push(root);
  const files: Record<string, string> = {
    'packages/ui/package.json': JSON.stringify({ name: '@portal/ui', exports: { '.': './src/index.tsx' } }),
    'packages/ui/src/index.tsx': 'export { PortalEntry } from "./shell";',
    'packages/ui/src/shell.tsx': 'export function PortalEntry() { return null; }',
    'packages/contracts/package.json': JSON.stringify({ name: '@portal/contracts', exports: { '.': './src/index.ts' } }),
    'packages/contracts/src/index.ts': 'export const PORTAL_APP_KINDS = ["home"];',
    'app/tokens.css': ':root { --portal-gap: 1rem; }',
    'app/globals.css': '.portal { display: grid; }',
    'apps/host/src/auth.ts': 'export const createLocalPortalAuthenticator = ownerId => async () => ({ ownerId, profile: "local" });',
    'apps/host/src/runtime.ts': 'export const createPortalRuntime = async () => ({ stop() {} });',
    'apps/host/src/operator-relay.ts': `import { AsyncLocalStorage } from 'node:async_hooks';
      const scope = new AsyncLocalStorage();
      export const withOperatorTransport = (transport, run) => scope.run(transport, run);
      export const currentOperatorTransport = () => scope.getStore();`,
    'apps/host/src/api.ts': `import { currentOperatorTransport } from './operator-relay';
      export const createPortalApi = (runtime, auth) => ({ async fetch(request) {
        const identity = await auth(request);
        if (new URL(request.url).pathname === '/api/apps') return Response.json({ profile: identity.profile, ownerId: identity.ownerId });
        return currentOperatorTransport()('/api/native', { method: 'GET', headers: {} });
      } });`,
    'apps/host/src/web-runtime.ts': 'export const composePortalRequestHandler = portal => portal;',
    'scripts/source-integrity.mjs': `export const serverRuntimeSpecs = root => [{
      packageName: '@portal/web-runtime', entry: root + '/apps/host/src/web-runtime.ts', extraArgs: [] }];`,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), body);
  }
  return root;
}

describe('private desktop portal host bundle', () => {
  it('compiles an explicit local composition without writing or starting a host', async () => {
    const portalRoot = fixture();
    const outputFile = resolve(portalRoot, 'candidate/portal-host.cjs');
    const result = await prepareDesktopPortalHostBundle({ portalRoot, papercuspRoot: desktopRoot, outputFile });
    expect(existsSync(outputFile)).toBe(false);
    expect(result.outputFiles).toHaveLength(1);
    expect(result.inputs).toHaveLength(6);
    expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.desktopAdapterInput.path).toBe('apps/operator/bin/desktop-portal-host.ts');
    expect(result.desktopAdapterInput.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Materialization is a test-only consumer of the prepared bytes.
    mkdirSync(dirname(outputFile));
    writeFileSync(outputFile, result.outputFiles[0].contents);
    const { createDesktopPortalApplication } = createRequire(import.meta.url)(outputFile);
    let stops = 0;
    await expect(createDesktopPortalApplication({ operator: () => Response.json({}) }))
      .rejects.toThrow('desktop_portal_host_adapter_required');
    const host = await createDesktopPortalApplication({ ownerId: 'desktop-owner', createHost: createDesktopPortalHost,
      runtime: { stop() { stops += 1; } },
      operator: async (request: Request) => Response.json({ native: new URL(request.url).pathname }),
    });
    expect(await (await host.fetch(new Request('http://localhost/api/apps'))).json())
      .toEqual({ profile: 'local', ownerId: 'desktop-owner' });
    expect(await (await host.fetch(new Request('http://localhost/api/settings'))).json())
      .toEqual({ native: '/api/native' });
    const denied = await runAsExternalIngress('test', () => host.fetch(new Request('http://localhost/api/apps')));
    expect(denied.status).toBe(403);
    await Promise.all([host.stop(), host.stop()]);
    expect(stops).toBe(1);
  });

  it('fails closed when a maintained host input is missing', async () => {
    const portalRoot = fixture();
    rmSync(resolve(portalRoot, 'apps/host/src/auth.ts'));
    const outputFile = resolve(portalRoot, 'candidate/portal-host.cjs');
    await expect(prepareDesktopPortalHostBundle({ portalRoot, papercuspRoot: desktopRoot, outputFile }))
      .rejects.toThrow();
    expect(existsSync(outputFile)).toBe(false);
  });

  it('runs the no-write command with the desktop TypeScript loader from another working directory', async () => {
    const portalRoot = fixture();
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      resolve(desktopRoot, 'apps/operator/bin/desktop-portal-host-preflight.ts'),
      '--portal-root', portalRoot, '--compile-only',
    ], { cwd: portalRoot, timeout: 20_000 });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, outputsWritten: false, listenerStarted: false,
      persistentStoreOpened: false, desktopAdapterInput: { path: 'apps/operator/bin/desktop-portal-host.ts' },
    });
    expect(existsSync(resolve(portalRoot, 'desktop-portal-memory-only.cjs'))).toBe(false);
  });
});
