import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPortalSource } from '../../desktop-portal-source';

const desktopRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function portal() {
  const root = mkdtempSync(resolve(tmpdir(), 'desktop-portal-source-'));
  temporary.push(root);
  const files: Record<string, string> = {
    'packages/ui/package.json': JSON.stringify({ name: '@portal/ui', exports: { '.': './src/index.tsx' } }),
    'packages/ui/src/index.tsx': 'export { PortalEntry } from "./shell";',
    'packages/ui/src/shell.tsx': 'export function PortalEntry() { return null; }',
    'packages/contracts/package.json': JSON.stringify({ name: '@portal/contracts', exports: { '.': './src/index.ts' } }),
    'packages/contracts/src/index.ts': 'export const PORTAL_APP_KINDS = ["home"];',
    'app/tokens.css': ':root { --portal-gap: 1rem; }',
    'app/globals.css': '.portal { display: grid; }',
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), body);
  }
  return root;
}

describe('desktop portal candidate source preparation', () => {
  it('reuses the exported portal entries and real desktop native/singleton dependencies', () => {
    const root = portal();
    const source = desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot });
    expect(source.uiEntry).toBe(resolve(root, 'packages/ui/src/index.tsx'));
    expect(source.contractsEntry).toBe(resolve(root, 'packages/contracts/src/index.ts'));
    expect(source.styles).toEqual([resolve(root, 'app/tokens.css'), resolve(root, 'app/globals.css')]);
    expect(readFileSync(source.nativeApiEntry, 'utf8')).toContain('window.__TAURI_INTERNALS__.invoke');
    expect(source.nativeApiEntry).not.toContain('tauri-api-browser');
    for (const [name, directory] of Object.entries(source.singletonRoots)) {
      expect(JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).name).toBe(name);
    }
    expect(source.inputs).toHaveLength(7);
    expect(source.inputs.every(file => !file.path.startsWith('/') && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  it('binds shell and stylesheet changes while keeping identical relocated source identities stable', () => {
    const first = portal();
    const second = portal();
    const inspect = (portalRoot: string) => desktopPortalSource({ portalRoot, papercuspRoot: desktopRoot });
    expect(inspect(first).sourceFingerprint).toBe(inspect(second).sourceFingerprint);
    writeFileSync(resolve(second, 'app/globals.css'), '.portal { display: flex; }');
    expect(inspect(first).sourceFingerprint).not.toBe(inspect(second).sourceFingerprint);
    writeFileSync(resolve(first, 'packages/ui/src/shell.tsx'), 'export function PortalEntry() { return "changed"; }');
    expect(inspect(first).inputs.find(file => file.path.endsWith('/shell.tsx'))?.sha256)
      .not.toBe(inspect(second).inputs.find(file => file.path.endsWith('/shell.tsx'))?.sha256);
  });

  it('refuses an unrelated package rather than claiming it is the maintained portal', () => {
    const root = portal();
    writeFileSync(resolve(root, 'packages/ui/package.json'), JSON.stringify({ name: '@unrelated/ui', exports: { '.': './src/index.tsx' } }));
    expect(() => desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot })).toThrow('Expected maintained package @portal/ui');
  });

  it('refuses package exports and symlinks outside the supplied portal source', () => {
    const root = portal();
    const other = portal();
    writeFileSync(resolve(root, 'packages/ui/package.json'), JSON.stringify({ name: '@portal/ui', exports: { '.': resolve(other, 'packages/ui/src/index.tsx') } }));
    expect(() => desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot })).toThrow('explicit source entry');
    writeFileSync(resolve(root, 'packages/ui/package.json'), JSON.stringify({ name: '@portal/ui', exports: { '.': './../contracts/src/index.ts' } }));
    expect(() => desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot })).toThrow('escapes its source root');
    writeFileSync(resolve(root, 'packages/ui/package.json'), JSON.stringify({ name: '@portal/ui', exports: { '.': './src/escape.tsx' } }));
    symlinkSync(resolve(other, 'packages/ui/src/index.tsx'), resolve(root, 'packages/ui/src/escape.tsx'));
    expect(() => desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot })).toThrow('escapes its source root');
  });

  it('requires explicit roots and all local styles rather than falling back to a hosted page', () => {
    expect(() => desktopPortalSource({ portalRoot: 'portal', papercuspRoot: desktopRoot })).toThrow('Explicit absolute');
    const root = portal();
    rmSync(resolve(root, 'app/tokens.css'));
    expect(() => desktopPortalSource({ portalRoot: root, papercuspRoot: desktopRoot })).toThrow();
  });
});
