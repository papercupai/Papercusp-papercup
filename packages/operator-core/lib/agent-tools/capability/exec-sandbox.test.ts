/**
 * Capability-exec sandbox argv (agent-capability-confinement-2026-06-13 P-022/D-008).
 *
 * The wrap's behavior is pinned at the ARGV level via the injectable `bwrapWorks` /
 * `homeDir` / `bwrapBinary` / `maskExists` seam (so it is host-independent); the REAL
 * bwrap + srt exec paths are validated end-to-end by `exec-sandbox.integration.test.ts`
 * on a bwrap-capable host. These tests pin: fail-open both ways (flag-off,
 * bwrap-unavailable → raw), the containment argv (cwd-writable, credential masking,
 * process-namespace isolation), skipping a nonexistent mask target (else bwrap
 * fail-CLOSES under the ro-root), the deny-all-egress lever, and credential-list
 * parity with the fleet sandbox.
 */
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { FLEET_SANDBOX_DENY_READ } from '@papercusp/orchestrator';
import {
  buildCapabilitySandboxCommand,
  capabilityBuildCacheWritePaths,
  capabilityHeavySchedulerWritePath,
  capabilitySrtSettingsPathForCwd,
  __resetCapabilitySrtSettings,
  CAPABILITY_SANDBOX_MASK_DIRS,
  CAPABILITY_SANDBOX_MASK_ABSOLUTE_FILES,
  assertCapabilitySandboxAvailable,
  CapabilityExecConfinementUnavailableError,
  scrubExecEnv,
  type BuildSandboxOpts,
} from './exec-sandbox';

describe('shared heavy scheduler metadata in capability sandboxes', () => {
  it('binds only the real shared metadata directory while retaining root and network containment', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-scheduler-sandbox-')));
    const runtime = join(root, 'runtime');
    const slots = join(runtime, 'pc-heavy-slots');
    mkdirSync(slots, { recursive: true });
    const cwd = join(root, 'work');
    mkdirSync(cwd);
    vi.stubEnv('PC_HEAVY_DIR', undefined);
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    try {
      expect(capabilityHeavySchedulerWritePath()).toBe(slots);
      const d = buildCapabilitySandboxCommand({ cmd: ['bash', '-c', 'true'], cwd }, {
        enabled: true, required: true, bwrapWorks: true, srtBin: null,
        denyAllEgress: true, homeDir: join(root, 'home'), maskExists: () => false,
      });
      const i = d.argv.indexOf(slots);
      expect(d.argv.slice(i - 1, i + 2)).toEqual(['--bind', slots, slots]);
      expect(d.argv.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
      expect(d.argv).toContain('--unshare-net');
      expect(d.argv).not.toContain(runtime);
      const alias = join(root, 'slot-alias');
      symlinkSync(slots, alias);
      expect(capabilityHeavySchedulerWritePath({ PC_HEAVY_DIR: alias })).toBe(slots);
      const freshRuntime = join(root, 'absent');
      expect(capabilityHeavySchedulerWritePath({ XDG_RUNTIME_DIR: freshRuntime })).toBe(join(freshRuntime, 'pc-heavy-slots'));
      const file = join(root, 'not-a-directory');
      writeFileSync(file, 'blocked');
      expect(() => capabilityHeavySchedulerWritePath({ PC_HEAVY_DIR: file }))
        .toThrow(`Shared heavy scheduler metadata is unavailable at ${file}`);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const CMD = ['/usr/bin/bash', '-c', 'echo hi'];
const CWD = '/proj/work';
// srtBin:null pins the BWRAP-fallback path deterministically (the srt-preferred
// path is exercised separately); without it the result would depend on whether
// `srt` happens to be on the test host's PATH.
const base: Omit<BuildSandboxOpts, 'enabled'> = {
  bwrapWorks: true,
  srtBin: null,
  homeDir: '/home/op',
  bwrapBinary: 'bwrap',
  // The fake homeDir's credential paths don't exist on the test host; pin "all
  // present" so the mask-argv assertions below stay deterministic. The skip-missing
  // behavior is covered by its own block.
  maskExists: () => true,
};

describe('capabilityBuildCacheWritePaths (EI-12725 — out-of-tree build caches are writable)', () => {
  // A real temp layout: the repo's cargo target is a SYMLINK out to a "big disk" dir,
  // exactly the shape that made the Tauri AppImage unbuildable in-sandbox.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pc-buildcache-')));
  const cwd = join(root, 'repo');
  const bigDisk = join(root, 'bigdisk', 'cargo-target');
  const home = join(root, 'home');
  const envCache = join(root, 'env-cargo-target');
  const envCacheInsideCwd = join(cwd, 'inner-cargo-target');
  mkdirSync(join(cwd, 'papercusp-desktop', 'src-tauri'), { recursive: true });
  mkdirSync(bigDisk, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(envCache, { recursive: true });
  mkdirSync(envCacheInsideCwd, { recursive: true });
  symlinkSync(bigDisk, join(cwd, 'papercusp-desktop', 'src-tauri', 'target'));

  // WI-37702: `cwd` and `homeDir` are parameters, but the FIRST candidate the
  // function considers is `process.env.CARGO_TARGET_DIR` — ambient, and therefore
  // outside the fixture's control. This dev box sets it (to a symlink that
  // realpath's out to /mnt), which leaked a fourth path into every result and made
  // the two exact-equality assertions below fail for reasons having nothing to do
  // with the code under test — reddening `operator-core :: test` for every agent
  // whose change merely selected this workspace. Unset it so the fixture is
  // authoritative and the file actually holds the host-independence its header
  // claims; the env leg is then covered DELIBERATELY by the two tests at the end
  // of this block rather than by accident on whichever hosts happen to set it.
  beforeEach(() => vi.stubEnv('CARGO_TARGET_DIR', undefined));

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves the SYMLINK to its real target — binding the link node would still write through to a read-only path', () => {
    const paths = capabilityBuildCacheWritePaths(cwd, home);
    expect(paths).toContain(bigDisk);
    expect(paths).not.toContain(join(cwd, 'papercusp-desktop', 'src-tauri', 'target'));
  });

  it('skips a cache that does not exist — binding a missing path is fail-CLOSED under the read-only / bind (WI-608)', () => {
    // `home` here has no .cargo-target; only the symlinked one above resolves.
    expect(capabilityBuildCacheWritePaths(cwd, home)).toEqual([bigDisk]);
    // A cwd with no caches at all yields nothing rather than a bogus bind.
    expect(capabilityBuildCacheWritePaths(join(root, 'empty-repo'), home)).toEqual([]);
  });

  it('skips a cache that resolves INSIDE the cwd — the cwd bind already covers it', () => {
    const stock = join(root, 'stock');
    mkdirSync(join(stock, 'papercusp-desktop', 'src-tauri', 'target'), { recursive: true });
    expect(capabilityBuildCacheWritePaths(stock, home)).toEqual([]);
  });

  // WI-37702: the two below pin the `process.env.CARGO_TARGET_DIR` candidate — the
  // one input with no parameter seam. Before this it was exercised only by accident,
  // on whichever hosts happened to export the variable, and there in the form of a
  // FAILURE; on a host that leaves it unset the leg ran zero times. Both populations
  // got the wrong answer, so neither could have caught a regression here.
  it('honours CARGO_TARGET_DIR, and lists it FIRST — it is the highest-priority candidate', () => {
    vi.stubEnv('CARGO_TARGET_DIR', envCache);
    // The cwd's symlinked target still resolves too, so this also pins the ORDER:
    // env var ahead of the in-repo target, matching the candidate list's intent.
    expect(capabilityBuildCacheWritePaths(cwd, home)).toEqual([envCache, bigDisk]);
  });

  it('applies the cwd-containment skip to CARGO_TARGET_DIR too — an env cache inside the cwd is not double-bound', () => {
    vi.stubEnv('CARGO_TARGET_DIR', envCacheInsideCwd);
    // Resolves under `cwd`, so the cwd bind already covers it: only the out-of-tree
    // symlinked target should survive.
    expect(capabilityBuildCacheWritePaths(cwd, home)).toEqual([bigDisk]);
  });

  it('bwrap argv binds the resolved cache rw, and does NOT weaken the read-only / bind', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd }, { ...base, enabled: true, homeDir: home });
    const i = d.argv.indexOf(bigDisk);
    expect(i).toBeGreaterThan(-1);
    expect(d.argv[i - 1]).toBe('--bind'); // rw, not --ro-bind
    expect(d.argv[i + 1]).toBe(bigDisk); // bound at its real path
    // the host stays read-only apart from the carve-outs
    expect(d.argv.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
  });
});

describe('buildCapabilitySandboxCommand — optional trusted path remains fail-open', () => {
  it('flag OFF → raw command, not sandboxed (reason flag-off, mode raw)', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: false });
    expect(d.sandboxed).toBe(false);
    expect(d.mode).toBe('raw');
    expect(d.reason).toBe('flag-off');
    expect(d.binary).toBe('/usr/bin/bash');
    expect(d.argv).toEqual(['-c', 'echo hi']);
  });

  it('flag ON but bwrap unavailable → raw (srt rests on bwrap too, so neither can sandbox here)', () => {
    // bwrapWorks:false; srt is intentionally present to prove it is NOT used when
    // the underlying bubblewrap can't sandbox (a failing srt would NOT be fail-open).
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, bwrapWorks: false, srtBin: '/usr/bin/srt', srtSettingsPath: '/tmp/s.json' },
    );
    expect(d.sandboxed).toBe(false);
    expect(d.mode).toBe('raw');
    expect(d.reason).toBe('bwrap-unavailable');
    expect(d.binary).toBe('/usr/bin/bash');
  });
});

describe('buildCapabilitySandboxCommand — confined callers fail closed', () => {
  it('does not return a raw command when bwrap is unavailable', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, required: true, bwrapWorks: false },
    );
    expect(d).toMatchObject({
      binary: '',
      argv: [],
      sandboxed: false,
      mode: 'unavailable',
      reason: 'bwrap-unavailable',
    });
    expect(() => assertCapabilitySandboxAvailable(d, CWD)).toThrow(
      CapabilityExecConfinementUnavailableError,
    );
    expect(() => assertCapabilitySandboxAvailable(d, CWD)).toThrow(/Raw host execution was not attempted/);
  });

  it('does not let a disabled rollout flag weaken an explicitly required boundary', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: false, required: true },
    );
    expect(d.mode).toBe('unavailable');
    expect(d.reason).toBe('flag-off');
  });

  it('uses the bwrap fallback offline when srt is absent instead of sharing the host network', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, required: true, srtBin: null },
    );
    expect(d.mode).toBe('bwrap');
    expect(d.argv).toContain('--unshare-net');
  });

  it('keeps approved-network behavior through the existing SRT allowlist path', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      {
        ...base,
        enabled: true,
        required: true,
        srtBin: '/opt/srt',
        srtSettingsPath: '/tmp/srt-settings.json',
      },
    );
    expect(d.mode).toBe('srt');
    expect(d.binary).toBe('/opt/srt');
  });
});

describe('buildCapabilitySandboxCommand — srt preferred (P-033 egress allowlist)', () => {
  const d = buildCapabilitySandboxCommand(
    { cmd: CMD, cwd: CWD },
    { ...base, enabled: true, srtBin: '/opt/srt', srtSettingsPath: '/tmp/srt-settings.json' },
  );

  it('when srt is present (and bwrap works), srt wraps the command — mode srt, binary = srt', () => {
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('srt');
    expect(d.reason).toBeNull();
    expect(d.binary).toBe('/opt/srt');
  });

  it('passes the settings file via -s and runs the command via -c (srt egress-allowlist proxy + fs sandbox)', () => {
    expect(d.argv[0]).toBe('-s');
    expect(d.argv[1]).toBe('/tmp/srt-settings.json');
    expect(d.argv[2]).toBe('-c');
    // The inner shell clears no_proxy (so egress routes through srt's proxy) and
    // execs the original command, single-quote escaped (no injection).
    const inner = d.argv[3];
    expect(inner).toContain("exec '/usr/bin/bash' '-c' 'echo hi'");
    expect(inner).toContain('no_proxy');
  });

  it('falls back to bwrap when srt is absent even though bwrap works (mode bwrap)', () => {
    const b = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, srtBin: null });
    expect(b.mode).toBe('bwrap');
    expect(b.binary).toBe('bwrap');
  });
});

describe('buildCapabilitySandboxCommand — wrapped argv (flag ON + bwrap works)', () => {
  const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true });

  it('spawns bwrap, sandboxed, no reason (mode bwrap — srt absent)', () => {
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('bwrap');
    expect(d.reason).toBeNull();
    expect(d.binary).toBe('bwrap');
  });

  it('mounts a read-only root, a writable cwd at its real path, and chdirs there', () => {
    const a = d.argv;
    expect(seq(a, ['--ro-bind', '/', '/'])).toBe(true);
    expect(seq(a, ['--bind', CWD, CWD])).toBe(true);
    expect(seq(a, ['--chdir', CWD])).toBe(true);
    expect(seq(a, ['--tmpfs', '/tmp'])).toBe(true);
  });

  it('orders `--tmpfs /tmp` BEFORE the cwd bind (else a cwd under /tmp is shadowed → bwrap --chdir fails)', () => {
    // Regression guard: a `--tmpfs /tmp` applied AFTER `--bind cwd cwd` mounts an
    // empty tmpfs OVER a cwd that lives under /tmp (e.g. TMPDIR=/tmp/pcv → a mkdtemp
    // working dir), so bwrap aborts with `Can't chdir … No such file or directory`.
    // The tmpfs must come first so the cwd bind lands on top of it and survives.
    // (Presence alone is not enough — the earlier assertions don't pin order.)
    const tmpfsIdx = seqIndex(d.argv, ['--tmpfs', '/tmp']);
    const bindIdx = seqIndex(d.argv, ['--bind', CWD, CWD]);
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(tmpfsIdx).toBeLessThan(bindIdx);
  });

  it('orders `--proc` and `--dev` BEFORE the cwd bind (else a cwd under /dev/shm is shadowed, WI-10006742)', () => {
    const shmCwd = '/dev/shm/pcv/work';
    const shm = buildCapabilitySandboxCommand({ cmd: CMD, cwd: shmCwd }, { ...base, enabled: true });
    const bindIdx = seqIndex(shm.argv, ['--bind', shmCwd, shmCwd]);
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    for (const mount of [['--proc', '/proc'], ['--dev', '/dev'], ['--tmpfs', '/tmp']]) {
      const i = seqIndex(shm.argv, mount);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(bindIdx);
    }
  });

  it('isolates process namespaces + dies with the parent (foreground: background unset)', () => {
    for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--die-with-parent']) {
      expect(d.argv).toContain(f);
    }
  });

  it('EI-16635: a BACKGROUND spawn omits --die-with-parent — it is incompatible with run_in_background outliving this call', () => {
    const bg = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, background: true });
    expect(bg.mode).toBe('bwrap');
    expect(bg.argv).not.toContain('--die-with-parent');
    // everything else about the containment is unchanged for a background spawn.
    for (const f of ['--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try']) {
      expect(bg.argv).toContain(f);
    }
    expect(seq(bg.argv, ['--ro-bind', '/', '/'])).toBe(true);
    expect(seq(bg.argv, ['--bind', CWD, CWD])).toBe(true);
  });

  it('a FOREGROUND spawn (background:false explicit) still dies with the parent', () => {
    const fg = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, background: false });
    expect(fg.argv).toContain('--die-with-parent');
  });

  it('masks credential DIRS with a tmpfs at the resolved home path', () => {
    for (const dir of ['.ssh', '.aws', '.gnupg', '.config/gcloud', '.papercusp']) {
      expect(CAPABILITY_SANDBOX_MASK_DIRS).toContain(dir);
      expect(seq(d.argv, ['--tmpfs', `/home/op/${dir}`])).toBe(true);
    }
  });

  it('masks the credential FILE ~/.npmrc with --ro-bind /dev/null (a tmpfs over a file no-ops → would leak the token)', () => {
    expect(CAPABILITY_SANDBOX_MASK_DIRS).toContain('.npmrc');
    expect(seq(d.argv, ['--ro-bind', '/dev/null', '/home/op/.npmrc'])).toBe(true);
    // …and NOT a tmpfs (the bug this guards against).
    expect(seq(d.argv, ['--tmpfs', '/home/op/.npmrc'])).toBe(false);
  });

  it('masks the absolute systemd-run binary with --ro-bind /dev/null', () => {
    const target = '/usr/bin/systemd-run';
    expect(CAPABILITY_SANDBOX_MASK_ABSOLUTE_FILES).toContain(target);
    expect(seq(d.argv, ['--ro-bind', '/dev/null', target])).toBe(true);
  });

  it('ends with `-- <cmd>` so the wrapped command runs last', () => {
    const dashIdx = d.argv.lastIndexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    expect(d.argv.slice(dashIdx + 1)).toEqual(CMD);
  });

  it('does NOT unshare the network by default (fs/credential containment, egress shared — domain-allowlist is the follow-up)', () => {
    expect(d.argv).not.toContain('--unshare-net');
  });
});

describe('srt settings — absolute executable masks (WI-39391)', () => {
  it('adds the canonical systemd-run path to filesystem.denyRead', () => {
    const root = mkdtempSync(join(tmpdir(), 'pc-exec-srt-mask-'));
    try {
      __resetCapabilitySrtSettings();
      const settingsPath = capabilitySrtSettingsPathForCwd(root);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        filesystem: { denyRead: string[] };
      };
      expect(settings.filesystem.denyRead).toContain('/usr/bin/systemd-run');
    } finally {
      __resetCapabilitySrtSettings();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildCapabilitySandboxCommand — skip a nonexistent mask target (fail-OPEN, not fail-closed)', () => {
  // bwrap can't create a mount point under the ro-root (`Can't mkdir …: Read-only
  // file system`), so binding a credential path that doesn't exist would abort the
  // whole command. A missing path has no secret to mask, so it must be skipped.
  it('omits --tmpfs / --ro-bind for mask paths that do not exist on the host', () => {
    // Only ~/.ssh + ~/.npmrc exist; the rest are missing and must be skipped.
    const present = new Set(['/home/op/.ssh', '/home/op/.npmrc']);
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, maskExists: (abs) => present.has(abs) },
    );
    expect(d.mode).toBe('bwrap');
    // present → masked
    expect(seq(d.argv, ['--tmpfs', '/home/op/.ssh'])).toBe(true);
    expect(seq(d.argv, ['--ro-bind', '/dev/null', '/home/op/.npmrc'])).toBe(true);
    // missing → NOT bound (no --tmpfs / --ro-bind referencing them at all)
    for (const missing of ['/home/op/.aws', '/home/op/.gnupg', '/home/op/.config/gcloud', '/home/op/.papercusp']) {
      expect(d.argv).not.toContain(missing);
    }
  });

  it('skips ALL mask targets when none exist (still a valid sandbox, just no credential overlays)', () => {
    const d = buildCapabilitySandboxCommand(
      { cmd: CMD, cwd: CWD },
      { ...base, enabled: true, maskExists: () => false },
    );
    expect(d.sandboxed).toBe(true);
    expect(d.mode).toBe('bwrap');
    for (const dir of CAPABILITY_SANDBOX_MASK_DIRS) {
      expect(d.argv).not.toContain(`/home/op/${dir}`);
    }
    // The core containment (ro-root, writable cwd, ns isolation) is unaffected.
    expect(seq(d.argv, ['--ro-bind', '/', '/'])).toBe(true);
    expect(seq(d.argv, ['--bind', CWD, CWD])).toBe(true);
  });
});

describe('buildCapabilitySandboxCommand — deny-all-egress lever', () => {
  it('denyAllEgress:true adds --unshare-net', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, denyAllEgress: true });
    expect(d.argv).toContain('--unshare-net');
  });
  it('denyAllEgress:false omits --unshare-net', () => {
    const d = buildCapabilitySandboxCommand({ cmd: CMD, cwd: CWD }, { ...base, enabled: true, denyAllEgress: false });
    expect(d.argv).not.toContain('--unshare-net');
  });
});

describe('credential-mask parity with the fleet sandbox', () => {
  it('CAPABILITY_SANDBOX_MASK_DIRS mirrors FLEET_SANDBOX_DENY_READ (home-relative)', () => {
    // The fleet list is `~/`-prefixed; strip it and compare the home-relative set.
    const fleetRel = FLEET_SANDBOX_DENY_READ.map((p) => p.replace(/^~\//, '')).sort();
    expect([...CAPABILITY_SANDBOX_MASK_DIRS].sort()).toEqual(fleetRel);
  });
});

describe('scrubExecEnv (EI-1617 — allowlist, not a passthrough-minus-denylist)', () => {
  it('drops an arbitrary operator secret that is not on the allowlist', () => {
    const out = scrubExecEnv({
      PATH: '/usr/bin',
      DATABASE_URL: 'postgres://user:pw@host/db',
      DEFGUARD_API_TOKEN: 'secret-token',
      ELEVENLABS_WEBHOOK_SECRET: 'wh-secret',
      MOBILE_JWT_SECRET: 'jwt-secret',
      NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN: 'chatwoot-token',
      STARSHIP_SESSION_KEY: 'session-key',
      STOREWOLFPASSWORD: 'wolf-pw',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out).not.toHaveProperty('DATABASE_URL');
    expect(out).not.toHaveProperty('DEFGUARD_API_TOKEN');
    expect(out).not.toHaveProperty('ELEVENLABS_WEBHOOK_SECRET');
    expect(out).not.toHaveProperty('MOBILE_JWT_SECRET');
    expect(out).not.toHaveProperty('NEXT_PUBLIC_CHATWOOT_WEBSITE_TOKEN');
    expect(out).not.toHaveProperty('STARSHIP_SESSION_KEY');
    expect(out).not.toHaveProperty('STOREWOLFPASSWORD');
  });

  it('keeps common shell/toolchain vars', () => {
    const out = scrubExecEnv({
      PATH: '/usr/bin', HOME: '/home/op', LANG: 'en_US.UTF-8', TERM: 'xterm',
      TMPDIR: '/tmp', NODE_ENV: 'test', CARGO_HOME: '/home/op/.cargo',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', GOPATH: '/home/op/go',
    });
    expect(out).toEqual({
      PATH: '/usr/bin', HOME: '/home/op', LANG: 'en_US.UTF-8', TERM: 'xterm',
      TMPDIR: '/tmp', NODE_ENV: 'test', CARGO_HOME: '/home/op/.cargo',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', GOPATH: '/home/op/go',
    });
  });

  it('drops host-X vars (DISPLAY/XAUTHORITY/WAYLAND_DISPLAY are not allowlisted)', () => {
    const out = scrubExecEnv({ PATH: '/usr/bin', DISPLAY: ':0', XAUTHORITY: '/run/gdm/xauth', WAYLAND_DISPLAY: 'wayland-0' });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps the Papercusp exec-path plumbing vars the spawn path itself depends on', () => {
    const out = scrubExecEnv({
      PATH: '/usr/bin',
      PAPERCUSP_OPERATOR_URL: 'http://localhost:3070/api/mcp',
      PAPERCUSP_WORKSPACE_ROOT: '/home/op/workspace',
    });
    expect(out.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3070/api/mcp');
    expect(out.PAPERCUSP_WORKSPACE_ROOT).toBe('/home/op/workspace');
  });

  it('keeps tracked session/workspace identity for provenance-aware helper scripts', () => {
    const out = scrubExecEnv({
      PATH: '/usr/bin',
      PAPERCUSP_SID: 'su-session-123',
      PAPERCUSP_WORKSPACE: 'papercusp-workspace',
      PAPERCUSP_DB_PASSWORD: 'must-not-leak',
    });
    expect(out.PAPERCUSP_SID).toBe('su-session-123');
    expect(out.PAPERCUSP_WORKSPACE).toBe('papercusp-workspace');
    expect(out).not.toHaveProperty('PAPERCUSP_DB_PASSWORD');
  });

  it('drops undefined-valued entries (a bare NodeJS.ProcessEnv can carry them)', () => {
    const out = scrubExecEnv({ PATH: '/usr/bin', HOME: undefined });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });

  it('extraAllow widens the set for one call site without changing the default', () => {
    const withExtra = scrubExecEnv({ PATH: '/usr/bin', MY_SCOPED_TOKEN: 'x' }, ['MY_SCOPED_TOKEN']);
    expect(withExtra.MY_SCOPED_TOKEN).toBe('x');
    const withoutExtra = scrubExecEnv({ PATH: '/usr/bin', MY_SCOPED_TOKEN: 'x' });
    expect(withoutExtra).not.toHaveProperty('MY_SCOPED_TOKEN');
  });
});

/** True if `needle` appears as a contiguous subsequence of `hay`. */
function seq(hay: string[], needle: string[]): boolean {
  return seqIndex(hay, needle) >= 0;
}

/** Start index of `needle` as a contiguous subsequence of `hay`, or -1 if absent. */
function seqIndex(hay: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((n, j) => hay[i + j] === n)) return i;
  }
  return -1;
}
