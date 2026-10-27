import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { desktopPortalPlugin } from '../../desktop-portal-plugin';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const hook = (plugin: object, name: string) => (plugin as Record<string, Function>)[name];
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true }); });

function source() {
  const portalRoot = mkdtempSync(resolve(tmpdir(), 'desktop-portal-plugin-'));
  temporary.push(portalRoot);
  const files: Record<string, string> = {
    'packages/ui/package.json': JSON.stringify({ name: '@portal/ui', exports: { '.': './src/index.tsx' } }),
    'packages/ui/src/index.tsx': 'export { PortalEntry } from "./shell";',
    'packages/ui/src/shell.tsx': 'import { invoke } from "@tauri-apps/api/core"; export function PortalEntry() { return invoke; }',
    'packages/contracts/package.json': JSON.stringify({ name: '@portal/contracts', exports: { '.': './src/index.ts' } }),
    'packages/contracts/src/index.ts': 'export const PORTAL_APP_KINDS = [];',
    'app/tokens.css': ':root { --portal-gap: 1rem; }', 'app/globals.css': '.portal { display: grid; }',
    'apps/host/shims/native.ts': 'throw new Error("web-only native shim");',
    'apps/host/src/operator-surface-build.mjs': 'export function operatorSurfaceShims(desktop, portal) { return [{ pattern: /^@tauri-apps\\/api/, replacement: portal + "/apps/host/shims/native.ts" }]; }',
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(portalRoot, path)), { recursive: true });
    writeFileSync(resolve(portalRoot, path), body);
  }
  return portalRoot;
}

async function candidate(out?: string) {
  const output = out ?? resolve(homedir(), '.papercusp/desktop-candidates/plugin-test');
  return desktopPortalPlugin({ papercuspRoot: root, env: {
    PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', PAPERCUSP_DESKTOP_PORTAL_ROOT: source(),
    PAPERCUSP_VITE_OUT_DIR: output,
  } });
}

describe('desktop interface build selection', () => {
  it('keeps ordinary builds legacy without reading or requiring any portal checkout', async () => {
    const plugin = await desktopPortalPlugin({ papercuspRoot: root, env: {} });
    expect(hook(plugin, 'config')().define.__PAPERCUSP_DESKTOP_PORTAL__).toBe('false');
    const id = hook(plugin, 'resolveId')('virtual:desktop-portal-entry');
    expect(hook(plugin, 'load')(id)).not.toContain('@portal/ui');
    expect(hook(plugin, 'resolveId')('@tauri-apps/api/core')).toBeUndefined();
    expect(hook(plugin, 'configResolved')({ root, build: { outDir: 'dist' } })).toBeUndefined();
    expect(hook(plugin, 'transformIndexHtml')('<meta name="papercusp-desktop-interface" content="legacy" />'))
      .toContain('content="legacy"');
  });

  it('refuses unknown selections and an absent explicit source before building', async () => {
    await expect(desktopPortalPlugin({ papercuspRoot: root,
      env: { PAPERCUSP_DESKTOP_INTERFACE: 'unexpected' } })).rejects.toThrow('Unknown desktop interface');
    await expect(desktopPortalPlugin({ papercuspRoot: root,
      env: { PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate' } })).rejects.toThrow('Explicit absolute');
  });

  it('loads the measured local UI and styles with real native bindings and desktop singleton modules', async () => {
    const plugin = await candidate();
    expect(hook(plugin, 'config')().define.__PAPERCUSP_DESKTOP_PORTAL__).toBe('true');
    const entry = hook(plugin, 'load')(hook(plugin, 'resolveId')('virtual:desktop-portal-entry'));
    expect(entry).toContain('app/tokens.css');
    expect(entry).toContain('app/globals.css');
    expect(entry).toContain('export { PortalEntry as default }');
    expect(hook(plugin, 'resolveId')('@portal/ui')).toContain('packages/ui/src/index.tsx');
    expect(hook(plugin, 'resolveId')('@tauri-apps/api/core')).toMatch(/@tauri-apps\/api\/core\.(c?js)$/);
    expect(hook(plugin, 'resolveId')('react')).toContain('/node_modules/react/');
    expect(hook(plugin, 'transformIndexHtml')('<meta name="papercusp-desktop-interface" content="legacy" />'))
      .toContain('content="portal-candidate"');
  });

  it('refuses ordinary or mismatched output paths and allows only the explicitly selected private directory', async () => {
    const plugin = await candidate();
    const configure = (outDir: string) => hook(plugin, 'configResolved')({ root, build: { outDir } });
    expect(() => configure('apps/operator-vite/dist')).toThrow('desktop-candidates');
    expect(() => configure('.papercusp/private-desktop-candidates/plugin-test')).toThrow('desktop-candidates');
    expect(() => configure(resolve(homedir(), '.papercusp/desktop-candidates/other'))).toThrow('desktop-candidates');
    expect(() => configure(resolve(homedir(), '.papercusp/desktop-candidates/plugin-test'))).not.toThrow();
    const ordinary = await candidate(resolve(root, 'apps/operator-vite/dist'));
    expect(() => hook(ordinary, 'configResolved')({ root, build: { outDir: 'apps/operator-vite/dist' } }))
      .toThrow('desktop-candidates');
  });

  it('refuses a symlinked private output rather than writing into its destination', async () => {
    const link = resolve(homedir(), '.papercusp/desktop-candidates/plugin-symlink-test');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(source(), link);
    temporary.push(link);
    const plugin = await candidate(resolve(link, 'out'));
    expect(() => hook(plugin, 'configResolved')({ root, build: { outDir: resolve(link, 'out') } }))
      .toThrow('cannot traverse symlinks');
  });

  it('emits a candidate document with real native code through the actual Vite build pipeline', async () => {
    const portalRoot = source();
    writeFileSync(resolve(portalRoot, 'index.html'), '<meta name="papercusp-desktop-interface" content="legacy" /><script type="module" src="/main.js"></script>');
    writeFileSync(resolve(portalRoot, 'main.js'), 'import Entry from "virtual:desktop-portal-entry"; console.log(Entry);');
    const outDir = resolve(homedir(), '.papercusp/desktop-candidates/plugin-build-test');
    const plugin = await desktopPortalPlugin({ papercuspRoot: root, env: {
      PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate', PAPERCUSP_DESKTOP_PORTAL_ROOT: portalRoot,
      PAPERCUSP_VITE_OUT_DIR: outDir,
    } });
    const result = await build({ root: portalRoot, configFile: false, plugins: [plugin], logLevel: 'silent',
      build: { outDir, write: false, minify: false } });
    const output = (Array.isArray(result) ? result : [result]).flatMap(result => 'output' in result ? result.output : []);
    const html = output.find(item => item.fileName === 'index.html');
    if (!html || html.type !== 'asset') throw new Error('Vite did not emit the candidate document');
    const text = typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);
    expect(text).toContain('content="portal-candidate"');
    const code = output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
    expect(code).toContain('__TAURI_INTERNALS__');
    expect(code).not.toContain('web-only native shim');
    expect(output.some(item => item.fileName.endsWith('.css'))).toBe(true);
  });
});
