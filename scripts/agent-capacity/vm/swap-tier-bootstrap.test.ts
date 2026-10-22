import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'swap-tier-bootstrap.sh');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(opts: { failZram?: boolean; activeAgents?: boolean; packaged?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'swap-tier-boot-'));
  dirs.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const conf = join(root, 'etc/systemd/zram-generator.conf');
  const sysctl = join(root, 'etc/sysctl.d/zram.conf');
  const fstab = join(root, 'fstab'); writeFileSync(fstab, '# retained volumes\n');
  const overflow = join(root, 'overflow.swap'); writeFileSync(overflow, Buffer.alloc(8192));
  const calls = join(root, 'calls');
  const command = (name: string, body: string) => writeFileSync(join(bin, name), [
    '#!/bin/bash', `echo '${name}' "$@" >> "$CALLS"`, body, '',
  ].join('\n'), { mode: 0o755 });
  command('systemctl', [
    'if [[ "$1" == is-active ]]; then exit ' + (opts.activeAgents ? '0' : '3') + '; fi',
    'if [[ "$1" == cat ]]; then exit 0; fi',
    ...(opts.failZram ? ['if [[ "$1" == start && "$2" == dev-zram0.swap ]]; then exit 1; fi'] : []),
    'exit 0',
  ].join('\n'));
  command('apt-get', 'exit 0');
  command('sysctl', 'exit 0');
  command('systemd-escape', 'echo retained-overflow.swap');
  const md5 = opts.packaged ? createHash('md5').update(opts.packaged).digest('hex') : '';
  command('dpkg-query', `printf '%s %s\\n' "$CONF" '${md5}'`);
  if (opts.packaged) { mkdirSync(dirname(conf), { recursive: true }); writeFileSync(conf, opts.packaged); }
  const run = (size = '4096', algorithm = 'lz4', bytes = '8192') => spawnSync('bash', [
    '-c', 'set -euo pipefail; source "$1"; shift; install_boot_swap "$@"', 'test', BOOTSTRAP,
    size, algorithm, overflow, bytes, conf, sysctl, fstab,
  ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, CONF: conf } });
  return { conf, fstab, overflow, run, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

describe('retained qualification boot swap', () => {
  it.each(['4096', '8192'])('persists explicit %s MiB policy using generated units and an independent overflow unit', size => {
    const h = harness(); const r = h.run(size);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(h.conf, 'utf8')).toContain(`zram-size = ${size}\ncompression-algorithm = lz4`);
    expect(readFileSync(h.fstab, 'utf8')).toContain(`${h.overflow} none swap defaults,pri=10 0 0`);
    const calls = h.calls();
    expect(calls.indexOf('systemctl daemon-reload')).toBeLessThan(calls.indexOf('systemctl stop dev-zram0.swap'));
    expect(calls.indexOf('systemctl start retained-overflow.swap')).toBeLessThan(calls.indexOf('systemctl start dev-zram0.swap'));
    expect(calls).toContain('systemctl disable --now p544-swap.service');
    expect(calls.join('\n')).not.toContain('zramctl');
  });

  it('preserves the independent overflow start when compressed swap cannot start', () => {
    const h = harness({ failZram: true }); const r = h.run();
    expect(r.status).not.toBe(0);
    expect(h.calls()).toContain('systemctl start retained-overflow.swap');
    expect(r.stdout).not.toContain('BOOTSTRAP_BOOT_SWAP configured');
    expect(readFileSync(h.fstab, 'utf8')).toContain('swap defaults,pri=10');
  });

  it('keeps identical policy idempotent without resetting active compressed pages', () => {
    const h = harness(); expect(h.run().status).toBe(0);
    const first = h.calls().length; const fstab = readFileSync(h.fstab, 'utf8');
    expect(h.run().status).toBe(0);
    expect(h.calls().slice(first).filter(call => call.startsWith('systemctl stop'))).toEqual([]);
    expect(readFileSync(h.fstab, 'utf8')).toBe(fstab);
  });

  it('adopts only an unchanged package config and refuses foreign edits before modifying it', () => {
    const h = harness({ packaged: '# packaged default\n[zram0]\n' });
    expect(h.run().status).toBe(0);
    writeFileSync(h.conf, '# customer policy\n[zram0]\n');
    const before = h.calls().length; const r = h.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('foreign zram');
    expect(readFileSync(h.conf, 'utf8')).toContain('customer policy');
    expect(h.calls().slice(before).some(call => call.startsWith('apt-get'))).toBe(false);
  });

  it('refuses conflicting retained overflow policy before installing or stopping anything', () => {
    const h = harness(); writeFileSync(h.fstab, `${h.overflow} none swap defaults,pri=20 0 0\n`);
    expect(h.run().status).not.toBe(0);
    expect(h.calls()).toEqual(['systemctl is-active --quiet swaptier.slice']);
    expect(existsSync(h.conf)).toBe(false);
  });

  it('refuses an active measured cohort', () => {
    const h = harness({ activeAgents: true }); expect(h.run().status).not.toBe(0);
    expect(existsSync(h.conf)).toBe(false);
    expect(h.calls()).toEqual(['systemctl is-active --quiet swaptier.slice']);
  });

  it.each([['0', 'lz4', '8192'], ['4096', 'bad', '8192'], ['4096', 'lz4', '16384']])(
    'refuses invalid policy or an unadmitted file size (%s/%s/%s)', (size, algorithm, bytes) => {
      const h = harness(); expect(h.run(size, algorithm, bytes).status).not.toBe(0);
      expect(h.calls()).toEqual([]); expect(existsSync(h.conf)).toBe(false);
    },
  );
});
