import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDesktopPortalBundle } from '../../desktop-portal-bundle';

const desktopRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'desktop-portal-bundle-'));
  temporary.push(root);
  const files: Record<string, string> = {
    'packages/ui/package.json': JSON.stringify({ name: '@portal/ui', exports: { '.': './src/index.tsx' } }),
    'packages/ui/src/index.tsx': 'export { PortalEntry } from "./shell";',
    'packages/ui/src/shell.tsx': 'import { useState } from "react"; import { invoke } from "@tauri-apps/api/core"; export function PortalEntry() { return useState(invoke)[0]; }',
    'packages/contracts/package.json': JSON.stringify({ name: '@portal/contracts', exports: { '.': './src/index.ts' } }),
    'packages/contracts/src/index.ts': 'export const PORTAL_APP_KINDS = ["home"];',
    'app/tokens.css': ':root { --portal-gap: 1rem; }',
    'app/globals.css': '.portal { display: grid; }',
    'apps/host/shims/tauri-api-browser.ts': 'throw new Error("browser-only native shim must never enter desktop");',
    'apps/host/src/operator-surface-build.mjs': `export function operatorSurfaceAliases() { return {}; }
      export function operatorSurfaceShims(desktop, portal) {
        return [{pattern: /^@tauri-apps\\/api(?:\\/.*)?$/, replacement: portal + '/apps/host/shims/tauri-api-browser.ts'}];
      }`,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), body);
  }
  return root;
}

describe('private desktop portal graph preparation', () => {
  it('compiles local shared source with real native bindings, CSS and desktop React without writing outputs', async () => {
    const portalRoot = fixture();
    const outputDirectory = resolve(portalRoot, 'private-candidate');
    const result = await prepareDesktopPortalBundle({ portalRoot, papercuspRoot: desktopRoot, outputDirectory });
    expect(existsSync(outputDirectory)).toBe(false);
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some(path => path.endsWith('packages/ui/src/shell.tsx'))).toBe(true);
    expect(inputs.some(path => path.endsWith('@tauri-apps/api/core.cjs'))).toBe(true);
    expect(inputs.some(path => path.includes('tauri-api-browser'))).toBe(false);
    expect(inputs.filter(path => path.endsWith('react.production.js'))).toHaveLength(1);
    expect(result.outputFiles.some(file => file.path.endsWith('.css') && file.text.includes('--portal-gap'))).toBe(true);
    expect(result.outputFiles.some(file => file.path.endsWith('.js') && file.text.includes('__TAURI_INTERNALS__'))).toBe(true);
  });

  it('fails a missing local import instead of retaining an unresolved hosted dependency', async () => {
    const portalRoot = fixture();
    writeFileSync(resolve(portalRoot, 'packages/ui/src/shell.tsx'), 'export { PortalEntry } from "./missing-local-shell";');
    const outputDirectory = resolve(portalRoot, 'private-candidate');
    await expect(prepareDesktopPortalBundle({ portalRoot, papercuspRoot: desktopRoot, outputDirectory }))
      .rejects.toThrow('Could not resolve "./missing-local-shell"');
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it('exposes a runnable no-write receipt command from a different working directory', async () => {
    const portalRoot = fixture();
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve(desktopRoot, 'apps/operator-vite/desktop-portal-preflight.ts'), '--portal-root', portalRoot,
    ], { cwd: portalRoot, timeout: 20_000 });
    const receipt = JSON.parse(stdout);
    expect(receipt.ok).toBe(true);
    expect(receipt.outputsWritten).toBe(false);
    expect(receipt.outputSetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.nativeInputs.some((path: string) => path.endsWith('@tauri-apps/api/core.cjs'))).toBe(true);
    expect(receipt.browserNativeShims).toEqual([]);
    expect(receipt.scope).toContain('remain unverified');
    expect(existsSync(resolve(portalRoot, 'private-candidate'))).toBe(false);
  });
});
