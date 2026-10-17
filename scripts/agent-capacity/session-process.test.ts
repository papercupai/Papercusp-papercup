import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyTree, overlayLayout, parseCgroupStats, prepareWorkdir, removeTree, sessionSpawn, systemdRunArgs, wrapperScript, STATS_MARKER } from './session-process';

describe('cgroup accounting', () => {
  it('parses the last epilogue line and tolerates a missing value', () => {
    expect(parseCgroupStats(`noise\n${STATS_MARKER} peak=1048576 usage_usec=2500000\n`)).toEqual({ memPeakBytes: 1048576, cpuUsec: 2500000 });
    expect(parseCgroupStats(`${STATS_MARKER} peak= usage_usec=7\n`)).toEqual({ memPeakBytes: null, cpuUsec: 7 });
    expect(parseCgroupStats('')).toEqual({ memPeakBytes: null, cpuUsec: null });
  });

  it('the wrapper preserves the CLI exit status and appends one epilogue line', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'capdrv-wrap-'));
    try {
      const stats = path.join(dir, 'stats');
      let status = 0;
      try {
        execFileSync('bash', ['-c', wrapperScript(stats), 'capdrv', 'bash', '-c', 'exit 3'], { stdio: 'ignore' });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      expect(status).toBe(3);
      const text = readFileSync(stats, 'utf8');
      expect(text.trim().split('\n')).toHaveLength(1);
      expect(text.startsWith(`${STATS_MARKER} peak=`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('systemd-run args put the unit in capdrv.slice by default and skip env values setenv cannot carry', () => {
    const args = systemdRunArgs('capdrv-x', '/w', { A: '1', BASH_FUNC_f: '() {\n}', 'bad-key': 'v' }, '/s', ['claude', '-p', 'hi']);
    expect(args).toContain('--slice=capdrv.slice');
    expect(args).toContain('--setenv=A=1');
    expect(args.some((a) => a.startsWith('--setenv=BASH_FUNC') || a.startsWith('--setenv=bad-key'))).toBe(false);
    expect(args.slice(-3)).toEqual(['claude', '-p', 'hi']);
  });
});

describe('sessionSpawn', () => {
  const env = { PATH: '/session/bin', CODEX_HOME: '/h' };
  const caller = { PATH: '/caller/bin', HOME: '/home/u' };

  it('systemd: a transient unit in the requested slice, the session env via --setenv, and a unit kill on timeout', () => {
    const s = sessionSpawn('systemd', 'caprec-codex-t1', '/w', env, '/s/cgroup.stats', ['codex', 'exec', 'hi'], caller, 'caprec.slice');
    expect(s.cmd).toBe('systemd-run');
    expect(s.args).toContain('--unit=caprec-codex-t1');
    expect(s.args).toContain('--slice=caprec.slice');
    expect(s.args).not.toContain('--slice=capdrv.slice');
    // The CLI inside the unit resolves binaries on the SESSION's PATH, not the user manager's:
    // the manager's PATH found an older codex than the corpus was recorded with (2026-09-30).
    expect(s.args).toContain('--setenv=PATH=/session/bin');
    expect(s.env).toBe(caller);
    expect(s.killArgs).toEqual(['--user', 'kill', '--signal=SIGTERM', 'caprec-codex-t1.service']);
    expect(s.args.slice(-3)).toEqual(['codex', 'exec', 'hi']);
  });

  it('none: the CLI itself with the session env and no unit to kill', () => {
    const s = sessionSpawn('none', 'unused', '/w', env, '/s', ['claude', '-p', 'hi'], caller);
    expect(s).toEqual({ cmd: 'claude', args: ['-p', 'hi'], env, killArgs: null });
  });
});

describe('copyTree / removeTree', () => {
  it('refuses a root-side repository copy before replacing or creating its destination', async () => {
    if (process.platform !== 'linux') return;
    await expect(copyTree('/unread-source', '/capacity-uncreated/child')).rejects.toThrow(/refuse the root filesystem/);
    expect(existsSync('/capacity-uncreated')).toBe(false);
  });

  it('copies a tree including a relative symlink, then removes it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'capdrv-copy-'));
    try {
      const src = path.join(root, 'src');
      mkdirSync(path.join(src, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(path.join(src, 'a.txt'), 'hello');
      execFileSync('ln', ['-s', '../../a.txt', path.join(src, 'node_modules', '.bin', 'a')]);
      const dst = path.join(root, 'nested', 'dst');
      await copyTree(src, dst);
      expect(readFileSync(path.join(dst, 'node_modules', '.bin', 'a'), 'utf8')).toBe('hello');
      await removeTree(dst);
      expect(existsSync(dst)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces a leftover partial destination instead of nesting the copy inside it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'capdrv-copy-'));
    try {
      const src = path.join(root, 'excalidraw');
      mkdirSync(path.join(src, 'packages', 'common', 'src'), { recursive: true });
      writeFileSync(path.join(src, 'packages', 'common', 'src', 'colors.ts'), 'export {}');
      // What an aborted run leaves behind: the work dir with part of the tree already removed.
      const dst = path.join(root, 'replay-work', 'run', 's1-i0');
      mkdirSync(path.join(dst, 'stale'), { recursive: true });
      writeFileSync(path.join(dst, 'stale', 'left.txt'), 'x');
      await copyTree(src, dst);
      expect(readFileSync(path.join(dst, 'packages', 'common', 'src', 'colors.ts'), 'utf8')).toBe('export {}');
      expect(existsSync(path.join(dst, 'excalidraw'))).toBe(false);
      expect(existsSync(path.join(dst, 'stale'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects with the command and its stderr when the copy fails', async () => {
    await expect(copyTree('/nonexistent-capdrv-src', path.join(tmpdir(), 'capdrv-never'))).rejects.toThrow(/^cp .* exited 1: /);
  });
});

// WI-10004672: per-session cp + rm of a 69k-file checkout capped P-005 at ~13 sessions in flight.
describe('prepareWorkdir', () => {
  it('refuses root-side overlays before any native cleanup or mount command', async () => {
    if (process.platform !== 'linux') return;
    const calls: string[] = [];
    const run = async (cmd: string) => { calls.push(cmd); };
    await expect(prepareWorkdir('overlay', '/unread-source', '/capacity-uncreated/child', run))
      .rejects.toThrow(/refuse the root filesystem/);
    expect(calls).toEqual([]);
    expect(existsSync('/capacity-uncreated')).toBe(false);
  });

  it('copy: a real private copy, removed on teardown unless kept', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'capdrv-wd-'));
    try {
      const src = path.join(root, 'src');
      mkdirSync(src);
      writeFileSync(path.join(src, 'a.txt'), 'hello');
      const dst = path.join(root, 'work', 's0-i0');
      const wd = await prepareWorkdir('copy', src, dst);
      writeFileSync(path.join(dst, 'a.txt'), 'changed');
      expect(readFileSync(path.join(src, 'a.txt'), 'utf8')).toBe('hello');
      await wd.teardown(false);
      expect(existsSync(dst)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overlay: clears leftovers, mounts the prepared tree read-only under a per-session upper layer, and tears down as root', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'capdrv-wd-'));
    try {
      const calls: string[] = [];
      let leftoverUnmounted = true;
      const run = async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(' '));
        // A leftover from an aborted run that is not mounted: umount fails, which must not stop setup.
        if (args[1] === 'umount' && leftoverUnmounted) {
          leftoverUnmounted = false;
          throw new Error('umount: not mounted');
        }
      };
      const src = path.join(root, 'prepared', 'excalidraw');
      const dst = path.join(root, 'replay-work', 'run', 's3-i1');
      const wd = await prepareWorkdir('overlay', src, dst, run);
      expect(calls).toEqual([
        `sudo -n umount ${dst}`,
        `sudo -n rm -rf -- ${dst} ${dst}.ovl`,
        `sudo -n mount -t overlay overlay -o lowerdir=${src},upperdir=${dst}.ovl/up,workdir=${dst}.ovl/wk ${dst}`,
      ]);
      // The upper and work dirs sit beside the mount point, never inside it.
      expect(existsSync(`${dst}.ovl/up`) && existsSync(`${dst}.ovl/wk`) && existsSync(dst)).toBe(true);
      calls.length = 0;
      await wd.teardown(true);
      expect(calls).toEqual([`sudo -n umount ${dst}`]);
      calls.length = 0;
      await wd.teardown(false);
      expect(calls).toEqual([`sudo -n umount ${dst}`, `sudo -n rm -rf -- ${dst} ${dst}.ovl`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('shared: the session works in the prepared checkout itself; nothing is created, mounted or removed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'capdrv-wd-'));
    try {
      const src = path.join(root, 'prepared', 'papercusp');
      mkdirSync(src, { recursive: true });
      writeFileSync(path.join(src, 'a.txt'), 'hello');
      const calls: string[] = [];
      const run = async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(' '));
        return '';
      };
      const wd = await prepareWorkdir('shared', src, `${src}/`, run as never);
      await wd.teardown(false);
      await wd.teardown(true);
      expect(calls).toEqual([]);
      expect(readFileSync(path.join(src, 'a.txt'), 'utf8')).toBe('hello');
      expect(existsSync(path.join(root, 'replay-work'))).toBe(false);
      // A per-session path would silently give each session its own tree (and its own service).
      await expect(prepareWorkdir('shared', src, path.join(root, 'replay-work', 'run', 's0-i0'), run as never)).rejects.toThrow(/must be the prepared checkout/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overlay refuses paths its mount option string cannot carry', () => {
    expect(() => overlayLayout('/a,b', '/w')).toThrow(/cannot contain/);
    expect(() => overlayLayout('/a', '/w:x')).toThrow(/cannot contain/);
  });
});

describe('event-loop hygiene', () => {
  // Both drivers run an HTTP server (the replay server / the recording proxy) on the same event
  // loop as the sessions it serves. A synchronous 1.2 GB checkout copy starved every running
  // agent's replies in the first real load-driver smoke run; the same class once hung the
  // recording proxy behind spawnSync.
  for (const file of ['load-driver.ts', 'record-session.ts', 'session-process.ts']) {
    it(`${file} never copies, removes, spawns or execs synchronously`, () => {
      const src = readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toMatch(/\b(cpSync|rmSync|spawnSync|execSync)\s*\(/);
      // execFileSync is allowed only in the load driver's one-shot startup version probe,
      // which runs before the replay server starts.
      const execFileSyncCalls = src.match(/\bexecFileSync\s*\(/g)?.length ?? 0;
      expect(execFileSyncCalls).toBe(file === 'load-driver.ts' ? 1 : 0);
    });
  }
});
