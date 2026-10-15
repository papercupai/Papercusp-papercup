/**
 * sandbox-builder smoke tests — primarily exercises the env-var escape
 * hatch and the shape of the build result. The actual sandboxer
 * invocation is OS-specific and tested at the runner-integration level.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandbox, prepareSandboxCommand, _resetSmokeCacheForTests } from './sandbox';

const ORIG_PLATFORM = process.platform;

/** Override process.platform to exercise an OS-specific code path; restored in afterEach. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

/** True if `seq` appears as a contiguous run anywhere in argv (flag + operand checks). */
function hasSeq(argv: string[], ...seq: string[]): boolean {
  for (let i = 0; i + seq.length <= argv.length; i++) {
    if (seq.every((s, j) => argv[i + j] === s)) return true;
  }
  return false;
}

beforeEach(() => {
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  _resetSmokeCacheForTests();
});
afterEach(() => {
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  delete process.env.PAPERCUSP_ALLOW_NO_SANDBOX;
  delete process.env.PAPERCUSP_BWRAP;
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
  _resetSmokeCacheForTests();
});

describe('buildSandbox', () => {
  it('returns inactive driver when explicitly disabled', () => {
    const r = buildSandbox({
      pluginDir: '/tmp/p',
      scratchDir: '/tmp/s',
      allowedHosts: [],
      env: { FOO: 'bar' },
    });
    expect(r.active).toBe(false);
    expect(r.driver).toBe('none');
    expect(r.argv).toEqual([]);
    expect(r.env.FOO).toBe('bar');
  });

  it('passes env through unchanged on the inactive path', () => {
    const r = buildSandbox({
      pluginDir: '/p',
      scratchDir: '/s',
      allowedHosts: [],
      env: { A: '1', B: '2' },
    });
    expect(r.env).toEqual({ A: '1', B: '2' });
  });

  it('does not surface smokeBypass when DISABLE_SANDBOX short-circuits', () => {
    // DISABLE takes precedence; we never reach the smoke probe so no bypass marker.
    const r = buildSandbox({
      pluginDir: '/p',
      scratchDir: '/s',
      allowedHosts: [],
      env: {},
    });
    expect(r.smokeBypass).toBeUndefined();
  });
});

describe('buildSandbox — active Linux bwrap argv', () => {
  // A non-executable stand-in: existsSync() resolves it so resolveBundledBwrap()
  // picks it, but the smoke spawnSync then fails — which, on the default (no
  // ALLOW_NO_SANDBOX) path, does NOT change the returned argv, so the argv
  // assertions below stay deterministic without ever launching a real sandbox.
  function fakeBwrap(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-bwrap-'));
    const path = join(dir, 'bwrap');
    writeFileSync(path, '');
    return path;
  }

  beforeEach(() => {
    delete process.env.PAPERCUSP_DISABLE_SANDBOX; // exercise the real driver path
    setPlatform('linux');
  });

  it('wraps in the bundled bwrap with namespace isolation + RW scratch + RO plugin', () => {
    const bwrap = fakeBwrap();
    process.env.PAPERCUSP_BWRAP = bwrap;
    const r = buildSandbox({
      pluginDir: '/tmp/plug',
      scratchDir: '/tmp/scratch',
      allowedHosts: [],
      env: { FOO: 'bar' },
    });
    expect(r.driver).toBe('bwrap');
    expect(r.active).toBe(true);
    // Only the substrate-bundled bwrap is ever invoked (never a bare system bwrap).
    expect(r.argv[0]).toBe(bwrap);
    for (const flag of ['--die-with-parent', '--unshare-pid', '--unshare-user', '--share-net', '--clearenv']) {
      expect(r.argv).toContain(flag);
    }
    expect(hasSeq(r.argv, '--ro-bind', '/tmp/plug', '/tmp/plug')).toBe(true);
    expect(hasSeq(r.argv, '--bind', '/tmp/scratch', '/tmp/scratch')).toBe(true);
    expect(hasSeq(r.argv, '--chdir', '/tmp/scratch')).toBe(true);
    expect(r.argv[r.argv.length - 1]).toBe('--');
  });

  it('passes only opts.env through --setenv after --clearenv (drops ambient env)', () => {
    process.env.PAPERCUSP_BWRAP = fakeBwrap();
    const r = buildSandbox({
      pluginDir: '/tmp/plug',
      scratchDir: '/tmp/scratch',
      allowedHosts: [],
      env: { FOO: 'bar' },
    });
    expect(r.argv).toContain('--clearenv');
    expect(hasSeq(r.argv, '--setenv', 'FOO', 'bar')).toBe(true);
    // An ambient var the caller did not pass is never re-injected after --clearenv.
    expect(hasSeq(r.argv, '--setenv', 'PATH')).toBe(false);
  });

  it('binds the project dir RW only when provided and it exists', () => {
    process.env.PAPERCUSP_BWRAP = fakeBwrap();
    const projectDir = mkdtempSync(join(tmpdir(), 'sbx-proj-'));
    const withProj = buildSandbox({
      pluginDir: '/tmp/plug', scratchDir: '/tmp/scratch', projectDir,
      allowedHosts: [], env: {},
    });
    expect(hasSeq(withProj.argv, '--bind', projectDir, projectDir)).toBe(true);

    // No project dir → only the scratch dir is bound RW (exactly one --bind).
    const noProj = buildSandbox({
      pluginDir: '/tmp/plug', scratchDir: '/tmp/scratch',
      allowedHosts: [], env: {},
    });
    expect(noProj.argv.filter((a) => a === '--bind')).toHaveLength(1);

    // Provided but non-existent → not bound (a plugin can't mount a path that isn't there).
    const missingProj = buildSandbox({
      pluginDir: '/tmp/plug', scratchDir: '/tmp/scratch',
      projectDir: '/tmp/sbx-does-not-exist-xyz', allowedHosts: [], env: {},
    });
    expect(hasSeq(missingProj.argv, '--bind', '/tmp/sbx-does-not-exist-xyz', '/tmp/sbx-does-not-exist-xyz')).toBe(false);
  });

  it('mounts extraReadOnlyMounts read-only', () => {
    process.env.PAPERCUSP_BWRAP = fakeBwrap();
    const r = buildSandbox({
      pluginDir: '/tmp/plug', scratchDir: '/tmp/scratch',
      allowedHosts: [], env: {},
      extraReadOnlyMounts: [{ src: '/opt/data', dst: '/data' }],
    });
    expect(hasSeq(r.argv, '--ro-bind', '/opt/data', '/data')).toBe(true);
  });

  it('honors PAPERCUSP_ALLOW_NO_SANDBOX as a loud bypass when the smoke test fails', () => {
    // The fake bwrap is non-executable → smoke fails. With the opt-in env set,
    // buildSandbox returns the bypass marker instead of the bwrap argv.
    process.env.PAPERCUSP_BWRAP = fakeBwrap();
    process.env.PAPERCUSP_ALLOW_NO_SANDBOX = '1';
    const r = buildSandbox({
      pluginDir: '/tmp/plug', scratchDir: '/tmp/scratch',
      allowedHosts: [], env: {},
    });
    expect(r.active).toBe(false);
    expect(r.driver).toBe('none');
    expect(r.argv).toEqual([]);
    expect(r.smokeBypass?.reason).toBeTruthy();
  });
});

describe('buildSandbox — active macOS sandbox-exec profile', () => {
  beforeEach(() => {
    delete process.env.PAPERCUSP_DISABLE_SANDBOX;
    setPlatform('darwin');
  });

  it('builds a deny-default profile with scratch writable + network policy', () => {
    const r = buildSandbox({
      pluginDir: '/p', scratchDir: '/scratch',
      allowedHosts: [], env: {},
    });
    expect(r.driver).toBe('sandbox-exec');
    expect(r.active).toBe(true);
    expect(r.argv[0]).toBe('sandbox-exec');
    expect(r.argv[1]).toBe('-p');
    const profile = r.argv[2];
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-write* (subpath "/scratch"))');
    expect(profile).toContain('(allow network-outbound');
    // No project dir provided → no project write rule.
    expect(profile).not.toContain('(subpath "/p")');
  });

  it('adds a project-dir write rule only when projectDir is provided', () => {
    const r = buildSandbox({
      pluginDir: '/p', scratchDir: '/scratch', projectDir: '/proj',
      allowedHosts: [], env: {},
    });
    expect(r.argv[2]).toContain('(allow file-write* (subpath "/proj"))');
  });
});

describe('buildSandbox — unsupported platform', () => {
  it('returns an inactive none driver (no sandboxer) on win32, env passed through', () => {
    delete process.env.PAPERCUSP_DISABLE_SANDBOX;
    setPlatform('win32');
    const r = buildSandbox({
      pluginDir: '/p', scratchDir: '/s', allowedHosts: [], env: { X: '1' },
    });
    expect(r.active).toBe(false);
    expect(r.driver).toBe('none');
    expect(r.argv).toEqual([]);
    expect(r.env).toEqual({ X: '1' });
    expect(() => prepareSandboxCommand(r, ['/bin/true'], '/srt')).toThrow(/unsupported/);
  });
});

describe('final provision command composition', () => {
  function active(allowedHosts = ['vendor.example']) {
    return { active: true, driver: 'bwrap' as const,
      argv: ['/bwrap', '--share-net', '--clearenv', '--'], env: { PATH: '/usr/bin' },
      policy: { pluginDir: '/plugin', scratchDir: '/scratch', projectDir: '/project', allowedHosts } };
  }

  it('uses assigned hosts and ports and protects per-run settings', () => {
    const sandbox = active(['vendor.example', '127.0.0.1:32001', '**.multi.example']);
    const prepared = prepareSandboxCommand(sandbox, ['/bin/bash', '/plugin/a b.sh'], '/srt');
    try {
      expect(prepared.argv.slice(0, 3)).toEqual(['/srt', '-s', prepared.settingsPath]);
      expect(prepared.argv[4]).toContain("exec '/bwrap'");
      expect(prepared.argv[4]).not.toContain('--clearenv');
      expect(prepared.argv[4]).toContain("'/plugin/a b.sh'");
      const settings = JSON.parse(readFileSync(prepared.settingsPath!, 'utf8'));
      expect(settings.network).toEqual({ allowedDomains: ['vendor.example:80', 'vendor.example:443',
        '127.0.0.1:32001', '*.multi.example:80', '*.multi.example:443'], deniedDomains: [], strictAllowlist: true });
      expect(settings.filesystem.allowWrite).toEqual(['/scratch', '/project']);
      expect(settings.filesystem.denyWrite).toHaveLength(1);
      expect(prepared.settingsPath!.startsWith(settings.filesystem.denyWrite[0] + '/')).toBe(true);
    } finally { prepared.cleanup(); }
    expect(existsSync(prepared.settingsPath!)).toBe(false);
  });

  it('refuses missing SRT and unrepresentable single-label wildcards before spawn', () => {
    expect(() => prepareSandboxCommand(active(), ['/bin/true'], null)).toThrow(/unavailable/);
    expect(() => prepareSandboxCommand(active(['*.vendor.example']), ['/bin/true'], '/srt'))
      .toThrow(/cannot enforce single-label wildcard/);
  });

  it('retains deny-all when no hosts were assigned', () => {
    const prepared = prepareSandboxCommand(active([]), ['/bin/true'], '/srt');
    try {
      expect(JSON.parse(readFileSync(prepared.settingsPath!, 'utf8')).network.allowedDomains).toEqual([]);
    } finally { prepared.cleanup(); }
  });
});
