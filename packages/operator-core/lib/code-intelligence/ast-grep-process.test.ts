import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveAstGrepBin } from './ast-grep-process.mjs';

const tempRoots: string[] = [];

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'ast-grep-home-'));
  tempRoots.push(root);
  return { root, hostHome: join(root, 'host'), workspaceHome: join(root, 'workspace', '.papercusp') };
}

function installStub(home: string) {
  const bin = join(home, 'vendor', 'ast-grep', 'node_modules', '.bin', 'ast-grep');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, 'pinned asset fixture');
  return bin;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveAstGrepBin with workspace-scoped homes', () => {
  it('uses the explicit host asset root when the workspace copy is missing', () => {
    const { hostHome, workspaceHome } = makeHome();
    const hostBin = installStub(join(hostHome, '.papercusp'));

    expect(resolveAstGrepBin({
      env: { PAPERCUSP_HOME: workspaceHome },
      fallbackHome: hostHome,
    })).toBe(hostBin);
  });

  it('prefers the workspace copy and returns null when neither pinned root has an asset', () => {
    const { hostHome, workspaceHome } = makeHome();
    const workspaceBin = installStub(workspaceHome);
    const options = { env: { PAPERCUSP_HOME: workspaceHome }, fallbackHome: hostHome };

    expect(resolveAstGrepBin(options)).toBe(workspaceBin);
    rmSync(workspaceBin);
    expect(resolveAstGrepBin(options)).toBeNull();
  });
});
