import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { expandWorkspaces } from '../../../scripts/assert-workspace-links.mjs';

it('npm enrolls primary apps while excluding their duplicate checkpoint checkouts', () => {
  const patterns: string[] = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).workspaces;
  const root = mkdtempSync(join(tmpdir(), 'npm-enrollment-'));
  const writeRoot = (workspaces: string[]) => writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'enrollment-guard', private: true, workspaces,
  }));
  const query = () => spawnSync('npm', ['pkg', 'get', 'name', '--workspaces', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 15_000,
  });
  try {
    for (const [dir, name] of [['primary', '@fixture/primary'], ['primary-checkpoint', '@fixture/primary'],
      ['another-app', '@fixture/another']]) {
      mkdirSync(join(root, 'apps', dir), { recursive: true });
      writeFileSync(join(root, 'apps', dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    }
    writeRoot(patterns);
    const accepted = query();
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ '@fixture/primary': '@fixture/primary', '@fixture/another': '@fixture/another' });
    expect(expandWorkspaces(patterns, root).sort()).toEqual(['apps/another-app', 'apps/primary']);
    // The same physical population must fail when checkpoint enrollment returns.
    writeRoot(['apps/*']);
    const rejected = query();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('must not have multiple workspaces with the same name');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);
