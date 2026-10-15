import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  externalHomePathToLockKey,
  externalPathToLockKey,
  EXTERNAL_RUNTIME_LOCK_PREFIX,
  resolveExternalPathLockIdentity,
} from './external-path';

describe('externalHomePathToLockKey', () => {
  it('maps a home config file to the hook-compatible reserved key', () => {
    expect(externalHomePathToLockKey('/home/jdoe/.config/mimeapps.list', '/home/jdoe')).toBe(
      '@external/home/.config/mimeapps.list',
    );
  });

  it('rejects relative, outside-home, and home-root paths', () => {
    expect(() => externalHomePathToLockKey('.config/x', '/home/jdoe')).toThrow(/absolute/);
    expect(() => externalHomePathToLockKey('/etc/hosts', '/home/jdoe')).toThrow(/below/);
    expect(() => externalHomePathToLockKey('/home/jdoe', '/home/jdoe')).toThrow(/below/);
  });

  it('maps current-user XDG runtime credential files to a distinct reserved key', () => {
    expect(
      externalPathToLockKey(
        '/run/user/1000/papercusp-p029-acceptance.9aTT9e/storage-state.json',
        { home: '/home/jdoe', runtimeDir: '/run/user/1000' },
      ),
    ).toBe(`${EXTERNAL_RUNTIME_LOCK_PREFIX}/papercusp-p029-acceptance.9aTT9e/storage-state.json`);
  });

  it('rejects the runtime root itself and paths under another runtime root', () => {
    const roots = { home: '/home/jdoe', runtimeDir: '/run/user/1000' };
    expect(() => externalPathToLockKey('/run/user/1000', roots)).toThrow(/below/);
    expect(() => externalPathToLockKey('/run/user/1001/state.json', roots)).toThrow(/below/);
  });
});

describe('resolveExternalPathLockIdentity', () => {
  const previousWorkspacesRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  const previousCanonicalTree = process.env.PAPERCUSP_CANONICAL_TREE;
  const cleanup: string[] = [];

  afterEach(() => {
    if (previousWorkspacesRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = previousWorkspacesRoot;
    if (previousCanonicalTree === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = previousCanonicalTree;
    while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
  });

  it('maps a managed suite-app absolute path to the hook-compatible repository identity', () => {
    const workspaces = mkdtempSync(join(tmpdir(), 'lock-external-workspaces-'));
    cleanup.push(workspaces);
    process.env.PAPERCUSP_WORKSPACES_ROOT = workspaces;
    // Keep the canonical-tree candidate hermetic so this fixture is classified
    // solely by the managed suite-app shape.
    process.env.PAPERCUSP_CANONICAL_TREE = join(workspaces, 'missing-canonical-tree');

    const portal = join(workspaces, 'papercusp-workspace', '.papercusp', 'apps', 'portal');
    const target = join(portal, 'packages', 'contracts', 'src', 'index.ts');
    mkdirSync(join(portal, '.git'), { recursive: true });
    writeFileSync(join(portal, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export {};\n');

    expect(resolveExternalPathLockIdentity(target)).toEqual({
      coordinationDomain: realpathSync(portal),
      path: 'packages/contracts/src/index.ts',
    });
  });

  it('keeps an ordinary home configuration file in the reserved external namespace', () => {
    expect(resolveExternalPathLockIdentity('/home/jdoe/.config/mimeapps.list', {
      home: '/home/jdoe',
      runtimeDir: null,
    })).toEqual({ path: '@external/home/.config/mimeapps.list' });
  });

  it('coordinates a physical offloaded file with its proven HOME alias, including a new lock-file leaf', () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'lock-offloaded-home-')));
    cleanup.push(fixture);
    const home = join(fixture, 'home', 'person');
    const physicalHome = join(fixture, 'offload', home.slice(1));
    const physicalBank = join(physicalHome, '.papercusp', 'bank');
    mkdirSync(physicalBank, { recursive: true });
    mkdirSync(join(home, '.papercusp'), { recursive: true });
    symlinkSync(physicalBank, join(home, '.papercusp', 'bank'));
    writeFileSync(join(physicalBank, 'cache.txt'), 'controlled cache');
    for (const leaf of ['cache.txt', 'sidecar.build.lock']) {
      const physical = join(physicalBank, leaf);
      const alias = join(home, '.papercusp', 'bank', leaf);
      const expected = { path: `@external/home/.papercusp/bank/${leaf}` };
      expect(resolveExternalPathLockIdentity(physical, { home, runtimeDir: null })).toEqual(expected);
      expect(resolveExternalPathLockIdentity(alias, { home, runtimeDir: null })).toEqual(expected);
    }
  });

  it('refuses a mirrored layout when the HOME alias is missing or resolves to different bytes', () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'lock-offload-refusal-')));
    cleanup.push(fixture);
    const home = join(fixture, 'home', 'person');
    const physical = join(fixture, 'offload', home.slice(1), '.cache', 'bank', 'cache.txt');
    mkdirSync(dirname(physical), { recursive: true });
    writeFileSync(physical, 'physical data');
    expect(() => resolveExternalPathLockIdentity(physical, { home, runtimeDir: null })).toThrow(/below/);
    const other = join(fixture, 'other-bank');
    mkdirSync(other);
    writeFileSync(join(other, 'cache.txt'), 'different data');
    mkdirSync(join(home, '.cache'), { recursive: true });
    symlinkSync(other, join(home, '.cache', 'bank'));
    expect(() => resolveExternalPathLockIdentity(physical, { home, runtimeDir: null })).toThrow(/below/);
  });

  it('does not accept another user’s mirrored HOME tree or an unrelated external directory', () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'lock-offload-other-home-')));
    cleanup.push(fixture);
    const home = join(fixture, 'home', 'person');
    const other = join(fixture, 'offload', fixture.slice(1), 'home', 'peer', 'cache.txt');
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, 'peer data');
    expect(() => resolveExternalPathLockIdentity(other, { home, runtimeDir: null })).toThrow(/below/);
    expect(() => resolveExternalPathLockIdentity(join(fixture, 'unrelated', 'cache.txt'), { home, runtimeDir: null })).toThrow(/below/);
  });
});
