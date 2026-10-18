import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalEvidenceRootBase, defaultEvidenceRoot, isLegacyEvidenceRoot, legacyEvidenceRoot } from './evidence-root.js';

const base = '/mnt/data/offload/verification-harness';
const legacy = '/fixture-home/.local/state/verification-harness/proof';
const env = { HOME: '/fixture-home' };
const stats = (dev: number, directory = true) => ({ dev, isDirectory: () => directory });
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const createHost = () => ({
  platform: vi.fn(() => 'linux'),
  lstat: vi.fn((_target: string): unknown => { throw missing(); }),
  stat: vi.fn((target: string) => stats(target === '/' ? 1 : 2)),
  access: vi.fn((_target: string, _mode: number) => {}),
});
let host: ReturnType<typeof createHost>;
beforeEach(() => { host = createHost(); });
const root = () => defaultEvidenceRoot('proof', env, host);

describe('verification evidence placement (P-009)', () => {
  it.skipIf(platform() !== 'linux')('checks the resolved shell device for a symlink back to root', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'vh-device-'));
    try {
      const alias = join(fixture, 'root-link');
      symlinkSync('/', alias);
      const vh = fileURLToPath(new URL('../bin/vh.sh', import.meta.url));
      const result = spawnSync('bash', ['-c', 'source "$1"\n_vh_evidence_device "$2"', 'vh-device', vh, alias],
        { encoding: 'utf8', timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(String(statSync('/').dev));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('defaults new evidence to an existing writable separate data volume without creating it', () => {
    expect(root()).toBe(`${base}/proof`);
    expect(host.access).toHaveBeenCalledWith('/mnt/data/offload', 3);
    expect(canonicalEvidenceRootBase(host)).toBe(base);
    expect(legacyEvidenceRoot('proof', env)).toBe(legacy);
    expect(isLegacyEvidenceRoot('proof', legacy, env, host)).toBe(true);
    expect(isLegacyEvidenceRoot('proof', `${base}/proof`, env, host)).toBe(false);
  });

  it('honors the explicit evidence base before every other setting', () => {
    expect(defaultEvidenceRoot('proof', { ...env, VH_EVIDENCE_ROOT_BASE: '/chosen', XDG_STATE_HOME: '/state' }, host)).toBe('/chosen/proof');
    expect(host.stat).not.toHaveBeenCalled();
  });

  it('preserves an explicit XDG state location', () => {
    expect(defaultEvidenceRoot('proof', { ...env, XDG_STATE_HOME: '/state' }, host)).toBe('/state/verification-harness/proof');
    expect(host.stat).not.toHaveBeenCalled();
    expect(isLegacyEvidenceRoot('proof', '/state/verification-harness/proof', { ...env, XDG_STATE_HOME: '/state' }, host)).toBe(false);
  });

  it('does not treat an unmounted data directory as separate storage', () => {
    host.stat.mockReturnValue(stats(1));
    expect(root()).toBe(legacy);
  });

  it.each(['ENOENT', 'EACCES'])('keeps the portable default when data storage is unavailable: %s', code => {
    host.stat.mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(root()).toBe(legacy);
  });

  it('rejects a non-directory or unwritable data parent', () => {
    host.stat.mockReturnValue(stats(2, false));
    expect(root()).toBe(legacy);
    host.stat.mockImplementation(p => stats(p === '/' ? 1 : 2));
    host.access.mockImplementation(() => { throw new Error('not writable'); });
    expect(root()).toBe(legacy);
  });

  it('checks an existing evidence base itself, including a symlink back to root', () => {
    host.lstat.mockReturnValue(stats(2));
    host.stat.mockReturnValue(stats(1));
    expect(root()).toBe(legacy);
    expect(host.stat).toHaveBeenCalledWith(base);
  });

  it('rejects a dangling evidence-base link rather than trusting its parent', () => {
    host.lstat.mockReturnValue(stats(2));
    host.stat.mockImplementation(() => { throw missing(); });
    expect(root()).toBe(legacy);
  });

  it('preserves portable home placement outside Linux', () => {
    host.platform.mockReturnValue('darwin');
    expect(root()).toBe(legacy);
    expect(host.stat).not.toHaveBeenCalled();
  });

  it.each([
    { VH_EVIDENCE_ROOT_BASE: '', XDG_STATE_HOME: '' },
    { VH_EVIDENCE_ROOT_BASE: '/chosen', XDG_STATE_HOME: '/state' },
    { VH_EVIDENCE_ROOT_BASE: '', XDG_STATE_HOME: '/state' },
  ])('keeps the shell and TypeScript resolvers aligned on the actual host: %j', overrides => {
    const shellEnv = { ...process.env, HOME: env.HOME, ...overrides };
    const vh = fileURLToPath(new URL('../bin/vh.sh', import.meta.url));
    const result = spawnSync('bash', ['-c', 'source "$1"\nvh_default_root "$2"', 'vh-root', vh, 'proof'],
      { env: shellEnv, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(defaultEvidenceRoot('proof', shellEnv));
  });
});
