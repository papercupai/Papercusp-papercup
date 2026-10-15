import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexSqliteHome } from '../scripts/psu-pty-host.mjs';
import { runWrapper } from '../scripts/psu-launcher.mjs';

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'psu-codex-sqlite-preflight-'));
  home = join(root, 'codex-home');
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const env = () => ({ PAPERCUSP_AGENT: 'codex', CODEX_HOME: home });
const configure = (stateHome: string) => writeFileSync(join(home, 'config.toml'), `sqlite_home = ${JSON.stringify(stateHome)}\n`);

describe('Codex SQLite storage before managed PTY startup', () => {
  it('creates the default state home when the optional config is missing', () => {
    rmSync(home, { recursive: true });
    expect(prepareCodexSqliteHome({ env: env() })).toBe(home);
    expect(readdirSync(home)).toEqual([]);
  });

  it('uses the environment state home when the optional config is missing', () => {
    const state = join(root, 'env-state');
    expect(prepareCodexSqliteHome({ env: { ...env(), CODEX_SQLITE_HOME: state } })).toBe(state);
    expect(readdirSync(state)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  it('uses the native override when the optional config is missing', () => {
    const ignored = join(root, 'env-state');
    expect(prepareCodexSqliteHome({
      env: { ...env(), CODEX_SQLITE_HOME: ignored },
      cwd: root,
      args: ['-c', 'sqlite_home="native state"'],
    })).toBe(join(root, 'native state'));
    expect(existsSync(ignored)).toBe(false);
  });

  it('preserves invalid config and refuses it before creating state', () => {
    const invalid = 'sqlite_home = [unterminated';
    writeFileSync(join(home, 'config.toml'), invalid);
    const state = join(root, 'env-state');
    expect(() => prepareCodexSqliteHome({ env: { ...env(), CODEX_SQLITE_HOME: state } })).toThrow();
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(invalid);
    expect(existsSync(state)).toBe(false);
  });

  it('preserves config read errors other than an absent file', () => {
    mkdirSync(join(home, 'config.toml'));
    const state = join(root, 'env-state');
    expect(() => prepareCodexSqliteHome({ env: { ...env(), CODEX_SQLITE_HOME: state } })).toThrow(/EISDIR/);
    expect(existsSync(state)).toBe(false);
  });

  it('restores a removed temp companion before a fresh launch or carry', () => {
    const state = join(root, 'temp-state', 'session-38931');
    configure(state);
    expect(existsSync(state)).toBe(false);
    expect(prepareCodexSqliteHome({ env: env() })).toBe(state);
    expect(readdirSync(state)).toEqual([]);
    rmSync(state, { recursive: true });
    expect(prepareCodexSqliteHome({ env: env() })).toBe(state);
    expect(readdirSync(state)).toEqual([]);
  });

  it('leaves existing database and WAL bytes intact and removes its own probe', () => {
    const state = join(root, 'existing-state');
    mkdirSync(state);
    configure(state);
    for (const name of ['state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm', 'logs_2.sqlite']) {
      writeFileSync(join(state, name), `retained ${name}`);
    }
    const before = readdirSync(state).map(name => [name, readFileSync(join(state, name))] as const);
    expect(prepareCodexSqliteHome({ env: env() })).toBe(state);
    expect(readdirSync(state).map(name => [name, readFileSync(join(state, name))])).toEqual(before);
  });

  it('reports an inaccessible path with its OS error and preserves the blocker', () => {
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'keep this file');
    configure(join(blocker, 'session'));
    expect(() => prepareCodexSqliteHome({ env: env() })).toThrow(/SQLite storage is unavailable.*ENOTDIR/);
    expect(readFileSync(blocker, 'utf8')).toBe('keep this file');
  });

  it.each(['0', '1'])('refuses failed SQLite storage before either launch route (plain=%s)', noPty => {
    const blocker = join(root, 'launch-blocker');
    writeFileSync(blocker, 'retained');
    configure(join(blocker, 'state'));
    const onSpawn = vi.fn();
    const onSpawnFailure = vi.fn();
    expect(() => runWrapper({
      wrapperBin: process.execPath, cwd: root, preserveCwd: true,
      envelopeEnv: { ...env(), PAPERCUSP_PSU_NO_PTY: noPty },
      onSpawn, onSpawnFailure,
    })).toThrow(/SQLite storage is unavailable.*ENOTDIR/);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(onSpawnFailure).toHaveBeenCalledOnce();
    expect(readFileSync(blocker, 'utf8')).toBe('retained');
  });

  it.skipIf(process.getuid?.() === 0)('refuses storage that the launching user cannot write', () => {
    const state = join(root, 'readonly-state');
    mkdirSync(state);
    configure(state);
    chmodSync(state, 0o500);
    try {
      expect(() => prepareCodexSqliteHome({ env: env() })).toThrow(/SQLite storage is unavailable.*EACCES/);
      expect(readdirSync(state)).toEqual([]);
    } finally { chmodSync(state, 0o700); }
  });

  it('uses the configured path ahead of the environment and handles spaces', () => {
    const state = join(root, 'configured state');
    const ignored = join(root, 'env-state');
    configure(state);
    expect(prepareCodexSqliteHome({ env: { ...env(), CODEX_SQLITE_HOME: ignored } })).toBe(state);
    expect(existsSync(ignored)).toBe(false);
  });

  it.each(['-c', '--config', '--config='])('honors native %s overrides relative to the child working directory', flag => {
    const ignored = join(root, 'config-state');
    configure(ignored);
    const assignment = 'sqlite_home="native state"';
    const args = flag === '--config=' ? [flag + assignment] : [flag, assignment];
    expect(prepareCodexSqliteHome({ env: env(), cwd: root, args })).toBe(join(root, 'native state'));
    expect(existsSync(ignored)).toBe(false);
  });

  it('uses CODEX_SQLITE_HOME, then CODEX_HOME, when sqlite_home is absent', () => {
    writeFileSync(join(home, 'config.toml'), '');
    const state = join(root, 'env-state');
    expect(prepareCodexSqliteHome({ env: { ...env(), CODEX_SQLITE_HOME: state } })).toBe(state);
    expect(prepareCodexSqliteHome({ env: env() })).toBe(home);
    expect(readdirSync(home)).toEqual(['config.toml']);
  });

  it('does not inspect or create state for other backends', () => {
    expect(prepareCodexSqliteHome({ env: { PAPERCUSP_AGENT: 'claude', CODEX_HOME: '/does-not-exist' } })).toBeNull();
    expect(prepareCodexSqliteHome({ env: { PAPERCUSP_AGENT: 'codex' } })).toBeNull();
  });
});
