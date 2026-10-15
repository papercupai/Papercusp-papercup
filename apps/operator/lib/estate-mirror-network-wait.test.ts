/**
 * WI-10006303 — pc-estate-mirror must not raise the fleet-wide "OFF-GCP ESTATE MIRROR
 * FAILING" alarm when the box simply has no uplink yet.
 *
 * Measured 2026-10-05: the Persistent=true timer fired the missed run at login
 * (14:38:21Z); the 3x40s bucket probe FATALed "(gcloud auth?)" at 14:39:47Z; Wi-Fi
 * reached CONNECTED_GLOBAL at 14:53:35Z. The unit's After=network-online.target is a
 * no-op in the user manager (LoadState=not-found), so the script has to wait itself.
 *
 * Hermetic: every case runs the REAL script in `mirror` mode under a tmp
 * PC_ESTATE_MIRROR_ROOT with PATH shims for ip / getent / gcloud / systemctl that
 * record their calls. Waits are zeroed via the PC_ESTATE_MIRROR_*_SEC knobs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../../../infra/estate-backup/pc-estate-mirror.sh');

type Net = 'online' | 'offline';
type Gcloud = 'ok' | 'reauth-fail';

function shim(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(p, 0o755);
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function runMirror(opts: { net: Net; gcloud: Gcloud; deferCount?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'estate-mirror-net-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls.log');
  const record = `echo "$0 $*" | sed "s#^${bin}/##" >>'${calls}'`;
  shim(bin, 'ip', opts.net === 'online' ? 'echo "default via 192.0.2.1 dev shim0"' : 'exit 0');
  shim(bin, 'getent', opts.net === 'online' ? 'exit 0' : 'exit 2');
  shim(bin, 'systemctl', `${record}; exit 0`);
  shim(
    bin,
    'gcloud',
    opts.gcloud === 'ok'
      ? `${record}; exit 0`
      : `${record}; echo 'ERROR: (gcloud.storage.ls) Reauthentication failed. cannot prompt during non-interactive execution.' >&2; exit 1`,
  );
  shim(bin, 'chattr', 'exit 1');
  shim(bin, 'sudo', 'exit 1');
  if (opts.deferCount !== undefined) writeFileSync(join(root, '.net-defer-count'), String(opts.deferCount));
  const run = spawnSync('bash', [SCRIPT, 'mirror'], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      PC_ESTATE_MIRROR_ROOT: root,
      PC_ESTATE_MIRROR_ALERT: '/bin/true',
      PC_ESTATE_MIRROR_NET_WAIT_SEC: '0',
      PC_ESTATE_MIRROR_PROBE_RETRY_SEC: '0',
      PC_ESTATE_MIRROR_NET_DEFER_MAX: '3',
      PC_ESTATE_MIRROR_SEAL: '0',
    },
  });
  const logPath = join(root, 'mirror.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const recorded = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
  const deferPath = join(root, '.net-defer-count');
  const defer = existsSync(deferPath) ? readFileSync(deferPath, 'utf8').trim() : null;
  return {
    status: run.status,
    log,
    recorded,
    defer,
    stateWritten: existsSync(join(root, 'MIRROR-STATE.json')),
    stderr: run.stderr,
  };
}

describe('WI-10006303 — pc-estate-mirror waits for an uplink instead of alarming "gcloud auth?"', () => {
  it('is the right script (guards a vacuous suite)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('wait_for_network');
    expect(src).toContain('defer_for_network');
    expect(src).not.toContain('(gcloud auth?)');
  });

  it('no uplink: DEFERs with EX_TEMPFAIL(75), never touches gcloud, arms the retry timer', () => {
    const r = runMirror({ net: 'offline', gcloud: 'ok' });
    expect(r.status, r.stderr).toBe(75);
    expect(r.log).toMatch(/DEFER 1\/3: no network/);
    expect(r.log).not.toContain('FATAL');
    expect(r.recorded.some((l) => l.startsWith('gcloud'))).toBe(false);
    expect(r.recorded).toContain('systemctl --user start pc-estate-mirror-retry.timer');
    expect(r.defer).toBe('1');
    expect(r.stateWritten).toBe(false);
  });

  it('no uplink for NET_DEFER_MAX consecutive runs becomes a REAL fatal and resets the counter', () => {
    const r = runMirror({ net: 'offline', gcloud: 'ok', deferCount: 3 });
    expect(r.status, r.stderr).toBe(1);
    expect(r.log).toMatch(/FATAL: no network for 3 consecutive runs/);
    expect(r.recorded.some((l) => l.includes('pc-estate-mirror-retry.timer'))).toBe(false);
    expect(r.defer).toBeNull();
  });

  it("uplink up but the bucket probe fails: the FATAL names gcloud's real error, after 3 attempts", () => {
    const r = runMirror({ net: 'online', gcloud: 'reauth-fail' });
    expect(r.status, r.stderr).toBe(1);
    expect(r.recorded.filter((l) => l.startsWith('gcloud storage ls')).length).toBe(3);
    expect(r.log).toMatch(/FATAL: cannot read gs:\/\/.*: ERROR: \(gcloud\.storage\.ls\) Reauthentication failed/);
    expect(r.log).not.toContain('auth?');
    expect(r.recorded.some((l) => l.includes('retry.timer'))).toBe(false);
  });

  it('uplink up and the bucket readable: the probe passes and a stale defer counter is cleared', () => {
    const r = runMirror({ net: 'online', gcloud: 'ok', deferCount: 2 });
    expect(r.log).not.toContain('bucket probe failed');
    expect(r.log).not.toContain('DEFER');
    expect(r.defer).toBeNull();
    // The gcloud shim lists nothing, so the run ends at the enumeration guard — a
    // DIFFERENT fatal, which is what proves control passed the probe.
    expect(r.log).toMatch(/FATAL: no snapshots found/);
  });
});
