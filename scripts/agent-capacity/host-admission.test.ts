import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCapacityStorage, assertHostAdmission, capacityCacheRoot, capacityHost } from './host-admission';

describe('host-admission', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'caphost-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const scriptsIn = (withOperator: boolean) => {
    const dir = path.join(root, 'scripts', 'agent-capacity');
    mkdirSync(dir, { recursive: true });
    if (withOperator) {
      mkdirSync(path.join(root, 'packages', 'operator-core'), { recursive: true });
      writeFileSync(path.join(root, 'packages', 'operator-core', 'package.json'), '{}');
    }
    return dir;
  };

  it('refuses to start sessions inside the Papercusp tree without a pc-heavy slot', () => {
    const dir = scriptsIn(true);
    expect(capacityHost(dir)).toBe('papercusp-tree');
    expect(() => assertHostAdmission(dir, {})).toThrow(/pc-heavy/);
    expect(() => assertHostAdmission(dir, { PC_HEAVY_BYPASS: '0' })).toThrow(/without admission/);
  });

  it('admits a run inside the Papercusp tree that holds a pc-heavy slot', () => {
    expect(assertHostAdmission(scriptsIn(true), { PC_HEAVY_BYPASS: '1' })).toBe('papercusp-tree');
  });

  it('admits a ramp VM, where the scripts were copied without the operator', () => {
    expect(assertHostAdmission(scriptsIn(false), {})).toBe('dedicated');
  });

  it('classifies this checkout as the Papercusp tree', () => {
    expect(capacityHost(__dirname)).toBe('papercusp-tree');
  });

  it('defaults the shared Linux host to data storage while preserving dedicated VM placement', () => {
    expect(capacityCacheRoot(scriptsIn(false))).toBe(path.join(homedir(), '.cache', 'agent-capacity'));
    expect(capacityCacheRoot(scriptsIn(true))).toBe(platform() === 'linux'
      ? '/mnt/data/agent-capacity' : path.join(homedir(), '.cache', 'agent-capacity'));
  });

  it.skipIf(platform() !== 'linux')('refuses a root-backed destination and nonexistent descendants before creation', () => {
    const scripts = scriptsIn(true);
    expect(() => assertCapacityStorage(scripts, '/')).toThrow(/refuse the root filesystem/);
    expect(() => assertCapacityStorage(scripts, '/capacity-uncreated/child')).toThrow(/refuse the root filesystem/);
  });

  it.skipIf(platform() !== 'linux')('checks the device behind a destination symlink', () => {
    const alias = path.join(root, 'root-device');
    symlinkSync('/', alias);
    expect(() => assertCapacityStorage(scriptsIn(true), path.join(alias, 'capacity-uncreated')))
      .toThrow(/refuse the root filesystem/);
  });

  it('keeps the dedicated VM storage contract independent of the shared host root device', () => {
    expect(() => assertCapacityStorage(scriptsIn(false), '/')).not.toThrow();
  });

  it('accepts the separate filesystem used by the existing fixture', () => {
    expect(() => assertCapacityStorage(scriptsIn(true), path.join(root, 'uncreated', 'work'))).not.toThrow();
  });
});
