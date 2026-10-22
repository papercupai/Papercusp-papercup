import { describe, expect, it, vi } from 'vitest';
import { captureSidecarContainment, observeSidecarExit, reapDeadSidecar, type LifetimeFs } from './sidecar-exec-lifetime';

const path = '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-abcd1234.scope';
const root = '/sys/fs/cgroup';
const procStat = (ticks = '42', state = 'S') => `123 (sidecar ) name) ${[state, ...Array(18).fill('0'), ticks].join(' ')}`;
function fixture() {
  const files: Record<string, string> = {
    '/proc/sys/kernel/random/boot_id': 'boot-one\n',
    '/proc/123/stat': procStat(),
    '/proc/123/cgroup': `0::${path}\n`,
    [`${root}${path}/cgroup.events`]: 'populated 1\nfrozen 0\n',
  };
  const ids: Record<string, string> = { [root]: '9:1', [`${root}${path}`]: '9:2' };
  const errors = new Map<string, string>();
  const read = (values: Record<string, string>, key: string) => {
    if (errors.has(key) || !(key in values)) throw Object.assign(new Error('read failed'), { code: errors.get(key) ?? 'ENOENT' });
    return values[key]!;
  };
  const fs: LifetimeFs = { read: (key) => read(files, key), identity: (key) => read(ids, key) };
  const snapshot = captureSidecarContainment('pc-abcd1234.scope', 123, fs)!;
  expect(snapshot).not.toBeNull();
  return { files, ids, errors, fs, snapshot };
}

describe('sidecar kernel lifetime proof', () => {
  it('retains a dead sidecar lease until its separately scoped forkserver is also verified empty', async () => {
    const f = fixture();
    const otherPath = path.replace('pc-abcd1234.scope', 'pc-fork1234.scope');
    Object.assign(f.files, {
      '/proc/456/stat': procStat('99').replace(/^123 /, '456 '),
      '/proc/456/cgroup': `0::${otherPath}\n`,
      [`${root}${otherPath}/cgroup.events`]: 'populated 1\n',
    });
    f.ids[`${root}${otherPath}`] = '9:3';
    const companion = captureSidecarContainment('pc-fork1234.scope', 456, f.fs)!;
    expect(companion).not.toBeNull();
    const snapshot = { ...f.snapshot, forkserver: companion };
    delete f.files['/proc/123/stat'];
    f.files[`${root}${path}/cgroup.events`] = 'populated 0\n';
    expect(observeSidecarExit(f.snapshot, f.fs)).toBe('exited');
    expect(observeSidecarExit(snapshot, f.fs)).toBe('populated');
    const kill = vi.fn(async (unit: string) => {
      if (unit === companion.scopeUnit) {
        delete f.files['/proc/456/stat'];
        f.files[`${root}${otherPath}/cgroup.events`] = 'populated 0\n';
      }
    });
    expect(await reapDeadSidecar(snapshot, { fs: f.fs, kill })).toBe(true);
    expect(kill).toHaveBeenCalledWith(companion.scopeUnit);
    expect(observeSidecarExit(snapshot, f.fs)).toBe('exited');
    f.errors.set('/proc/456/stat', 'EIO');
    expect(observeSidecarExit(snapshot, f.fs)).toBe('unknown');
  });

  it('refuses unconfined/inherited scope and unreadable preflight', () => {
    const f = fixture();
    expect(captureSidecarContainment(undefined, 123, f.fs)).toBeNull();
    expect(captureSidecarContainment('pc-other.scope', 123, f.fs)).toBeNull();
    f.errors.set('/proc/123/stat', 'EACCES');
    expect(captureSidecarContainment('pc-abcd1234.scope', 123, f.fs)).toBeNull();
  });

  it('never signals a living shared server even when the socket failed', async () => {
    const f = fixture();
    const kill = vi.fn();
    expect(observeSidecarExit(f.snapshot, f.fs)).toBe('alive');
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO', 'EPERM'])('retains the lease on %s instead of interpreting a failed read as death', async (code) => {
    const f = fixture();
    f.errors.set('/proc/123/stat', code);
    const kill = vi.fn();
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['gone', 'recycled', 'zombie'])('requires subtree exit after server is %s; kill accepted is not exit', async (kind) => {
    const f = fixture();
    if (kind === 'gone') delete f.files['/proc/123/stat'];
    else f.files['/proc/123/stat'] = procStat(kind === 'recycled' ? '43' : '42', kind === 'zombie' ? 'Z' : 'S');
    const kill = vi.fn(async () => ({ ok: true, detail: 'termination pending' }));
    // settleMs:0 pins the single-observation contract: no settle window, so a kill that
    // was merely accepted is reported as unverified rather than waited out.
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill, settleMs: 0 })).toBe(false);
    expect(kill).toHaveBeenCalledExactlyOnceWith('pc-abcd1234.scope');
    f.files[`${root}${path}/cgroup.events`] = 'populated 0\nfrozen 0\n';
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill })).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  // WI-10004743: exit lags the signal. Measured live, `killScopeUnit` reported "verified
  // empty" while the immediately following observation still read `populated`; `exited`
  // arrived ~50ms later. A single immediate re-read turned that teardown into "exit
  // unverified" (reapDeadSidecar false -> caller lease retained + console.error).
  describe('settle window after a signal', () => {
    it('waits out a teardown that is still `populated` right after the kill', async () => {
      const f = fixture();
      delete f.files['/proc/123/stat'];
      const kill = vi.fn(async () => ({ ok: true }));
      let sleeps = 0;
      const sleep = vi.fn(async () => {
        // The kernel clears `populated` only after the signalled tasks are reaped.
        if (++sleeps === 3) f.files[`${root}${path}/cgroup.events`] = 'populated 0\nfrozen 0\n';
      });
      expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill, sleep })).toBe(true);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledTimes(3);
    });

    it('is bounded: a scope that never empties is still reported unverified', async () => {
      const f = fixture();
      delete f.files['/proc/123/stat'];
      const kill = vi.fn(async () => ({ ok: true }));
      const sleep = vi.fn(async () => {});
      expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill, sleep, settleMs: 100 })).toBe(false);
      expect(sleep).toHaveBeenCalledTimes(4);
      expect(observeSidecarExit(f.snapshot, f.fs)).toBe('populated');
    });

    it('does not wait out evidence that is unknown rather than populated', async () => {
      const f = fixture();
      delete f.files['/proc/123/stat'];
      // The kill itself damages the evidence: after it the cgroup events are unreadable.
      const kill = vi.fn(async () => { f.errors.set(`${root}${path}/cgroup.events`, 'EIO'); });
      const sleep = vi.fn(async () => {});
      expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill, sleep })).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  it('observes exit after signaling, including a kill failure racing scope removal', async () => {
    const f = fixture();
    delete f.files['/proc/123/stat'];
    const kill = vi.fn(async () => { delete f.ids[`${root}${path}`]; throw new Error('scope already collected'); });
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill })).toBe(true);
  });

  it.each(['read-error', 'missing-events', 'malformed', 'duplicate', 'replaced-scope', 'replaced-mount', 'changed-boot'])('does not signal or claim exit from %s evidence', async (kind) => {
    const f = fixture();
    delete f.files['/proc/123/stat'];
    if (kind === 'read-error') f.errors.set(`${root}${path}`, 'EACCES');
    if (kind === 'missing-events') delete f.files[`${root}${path}/cgroup.events`];
    if (kind === 'malformed') f.files[`${root}${path}/cgroup.events`] = 'populated nope\n';
    if (kind === 'duplicate') f.files[`${root}${path}/cgroup.events`] = 'populated 0\npopulated 1\n';
    if (kind === 'replaced-scope') f.ids[`${root}${path}`] = '9:3';
    if (kind === 'replaced-mount') f.ids[root] = '10:1';
    if (kind === 'changed-boot') f.files['/proc/sys/kernel/random/boot_id'] = 'boot-two';
    const kill = vi.fn();
    expect(observeSidecarExit(f.snapshot, f.fs)).toBe('unknown');
    expect(await reapDeadSidecar(f.snapshot, { fs: f.fs, kill })).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
