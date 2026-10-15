import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ZRAM_SWAP_FUNCTION,
  ZRAM_SWAP_UNIT,
  zramGeneratorConfigLines,
  zramSwapShellLines,
  zramSysctlLines,
} from './zram-swap';

const MARKER = '# Managed by a test (WI-6554700010012418).';
const SWAPS_HEADER = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n';

// Runs the RENDERED function in bash (under the bootstrap's own `set -euo pipefail`) against a
// scratch config tree, a scratch /proc/swaps, a fake generator and fake systemctl/sysctl that log
// their argv. The fake `systemctl start dev-zram0.swap` appends a zram line to the scratch
// /proc/swaps, the way the real unit activates the swap. Nothing touches the real host.
function harness(opts: { startActivates?: boolean; packagedConfig?: string } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'zram-swap-'));
  const conf = path.join(tmp, 'etc/systemd/zram-generator.conf');
  const sysctlConf = path.join(tmp, 'etc/sysctl.d/90-papercusp-zram.conf');
  const generator = path.join(tmp, 'zram-generator');
  writeFileSync(generator, '#!/bin/sh\n', { mode: 0o755 });
  const swaps = path.join(tmp, 'swaps');
  writeFileSync(swaps, SWAPS_HEADER);
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  const callLog = path.join(tmp, 'calls.log');
  const activate = opts.startActivates ?? true;
  writeFileSync(
    path.join(bin, 'systemctl'),
    [
      '#!/bin/sh',
      `echo "systemctl $*" >> '${callLog}'`,
      `if [ "$1" = stop ] && [ "$2" = '${ZRAM_SWAP_UNIT}' ]; then sed -i '/^\\/dev\\/zram0 /d' '${swaps}'; fi`,
      activate
        ? `if [ "$1" = start ] && [ "$2" = '${ZRAM_SWAP_UNIT}' ] && ! grep -q '^/dev/zram0 ' '${swaps}'; then printf '/dev/zram0                              partition\\t8189948\\t\\t0\\t\\t100\\n' >> '${swaps}'; fi`
        : `[ "$1" = start ] && exit 1`,
      'exit 0',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(bin, 'sysctl'), `#!/bin/sh\necho "sysctl $*" >> '${callLog}'\n`);
  const packagedChecksum = opts.packagedConfig === undefined ? '' : createHash('md5').update(opts.packagedConfig).digest('hex');
  writeFileSync(path.join(bin, 'dpkg-query'), `#!/bin/sh\nprintf '%s\\n' '${conf} ${packagedChecksum}'\n`, { mode: 0o755 });
  chmodSync(path.join(bin, 'systemctl'), 0o755);
  chmodSync(path.join(bin, 'sysctl'), 0o755);
  const script = path.join(tmp, 'run.sh');
  writeFileSync(
    script,
    ['set -euo pipefail', ...zramSwapShellLines(MARKER), `${ZRAM_SWAP_FUNCTION} "$@"`, 'echo DONE'].join('\n'),
  );
  const run = () =>
    spawnSync('bash', [script, conf, sysctlConf, generator, swaps], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n') : []);
  const statusLines = (stdout: string) => stdout.split('\n').filter((l) => l.startsWith('PAPERCUSP_ZRAM_SWAP '));
  return { tmp, conf, sysctlConf, generator, swaps, run, calls, statusLines };
}

describe('zramSwapShellLines (WI-6554700010012418)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const make = (opts?: { startActivates?: boolean; packagedConfig?: string }) => {
    const h = harness(opts);
    dirs.push(h.tmp);
    return h;
  };

  it('writes the marker-tagged generator config and sysctl, starts the swap unit, and reports it active', () => {
    const h = make();
    const r = h.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DONE');
    expect(readFileSync(h.conf, 'utf8')).toBe([MARKER, ...zramGeneratorConfigLines()].join('\n') + '\n');
    expect(readFileSync(h.sysctlConf, 'utf8')).toBe([MARKER, ...zramSysctlLines()].join('\n') + '\n');
    expect(h.calls()).toEqual([
      `sysctl -q -p ${h.sysctlConf}`,
      'systemctl daemon-reload',
      `systemctl start ${ZRAM_SWAP_UNIT}`,
    ]);
    // /proc/swaps reports KiB; bash integer division truncates 8189948 / 1024 to 7997 MiB.
    expect(h.statusLines(r.stdout)).toEqual(['PAPERCUSP_ZRAM_SWAP status=active device=/dev/zram0 sizeMiB=7997']);
  });

  it('is idempotent across re-runs (every boot re-runs the bootstrap)', () => {
    const h = make();
    expect(h.run().status).toBe(0);
    const second = h.run();
    expect(second.status).toBe(0);
    expect(h.statusLines(second.stdout)).toEqual(['PAPERCUSP_ZRAM_SWAP status=active device=/dev/zram0 sizeMiB=7997']);
    expect(readFileSync(h.conf, 'utf8').startsWith(`${MARKER}\n`)).toBe(true);
    // Our own active zram0 on the second run is not mistaken for a foreign one.
    expect(readFileSync(h.swaps, 'utf8').match(/^\/dev\/zram0 /gm)).toHaveLength(1);
  });

  it("leaves someone else's generator config alone", () => {
    const h = make();
    mkdirSync(path.dirname(h.conf), { recursive: true });
    writeFileSync(h.conf, '[zram0]\nzram-size = 2048\n');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(readFileSync(h.conf, 'utf8')).toBe('[zram0]\nzram-size = 2048\n');
    expect(existsSync(h.sysctlConf)).toBe(false);
    expect(h.calls()).toEqual([]);
    expect(h.statusLines(r.stdout)).toEqual([
      `PAPERCUSP_ZRAM_SWAP status=skipped reason=foreign-generator-config path=${h.conf}`,
    ]);
  });

  it('adopts the unchanged package default and recreates its already active 4 GiB device', () => {
    const packagedConfig = '# Ubuntu packaged default\n[zram0]\n';
    const h = make({ packagedConfig });
    mkdirSync(path.dirname(h.conf), { recursive: true });
    writeFileSync(h.conf, packagedConfig);
    writeFileSync(h.swaps, `${SWAPS_HEADER}/dev/zram0                              partition\t4194300\t\t0\t\t100\n`);
    const r = h.run();
    expect(r.status).toBe(0);
    expect(readFileSync(h.conf, 'utf8')).toBe([MARKER, ...zramGeneratorConfigLines()].join('\n') + '\n');
    expect(h.calls()).toEqual([
      `sysctl -q -p ${h.sysctlConf}`,
      `systemctl stop ${ZRAM_SWAP_UNIT}`,
      'systemctl stop systemd-zram-setup@zram0.service',
      'systemctl daemon-reload',
      `systemctl start ${ZRAM_SWAP_UNIT}`,
    ]);
    expect(h.statusLines(r.stdout)).toEqual(['PAPERCUSP_ZRAM_SWAP status=active device=/dev/zram0 sizeMiB=7997']);
    expect(h.run().status).toBe(0);
    expect(h.calls().filter(call => call.startsWith('systemctl stop'))).toHaveLength(2);
  });

  it('preserves a customer edit to the packaged conffile and its active swap', () => {
    const h = make({ packagedConfig: '# Ubuntu packaged default\n[zram0]\n' });
    mkdirSync(path.dirname(h.conf), { recursive: true });
    const customized = '[zram0]\nzram-size = 2048\n';
    writeFileSync(h.conf, customized);
    const swaps = `${SWAPS_HEADER}/dev/zram0                              partition\t2097148\t\t16\t\t5\n`;
    writeFileSync(h.swaps, swaps);
    const r = h.run();
    expect(r.status).toBe(0);
    expect(readFileSync(h.conf, 'utf8')).toBe(customized);
    expect(readFileSync(h.swaps, 'utf8')).toBe(swaps);
    expect(h.calls()).toEqual([]);
    expect(existsSync(h.sysctlConf)).toBe(false);
  });

  it('leaves a zram swap another tool already activated alone on the first run', () => {
    const h = make();
    writeFileSync(h.swaps, `${SWAPS_HEADER}/dev/zram0                              partition\t4194300\t\t0\t\t5\n`);
    const r = h.run();
    expect(r.status).toBe(0);
    expect(existsSync(h.conf)).toBe(false);
    expect(h.calls()).toEqual([]);
    expect(h.statusLines(r.stdout)).toEqual(['PAPERCUSP_ZRAM_SWAP status=skipped reason=foreign-zram-swap-active']);
  });

  it('changes nothing without the generator binary', () => {
    const h = make();
    rmSync(h.generator);
    const r = h.run();
    expect(r.status).toBe(0);
    expect(existsSync(h.conf)).toBe(false);
    expect(h.calls()).toEqual([]);
    expect(h.statusLines(r.stdout)).toEqual([
      `PAPERCUSP_ZRAM_SWAP status=absent reason=generator-missing path=${h.generator}`,
    ]);
  });

  it('reports a unit that fails to start and still returns 0 under set -e', () => {
    const h = make({ startActivates: false });
    const r = h.run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DONE');
    expect(h.statusLines(r.stdout)).toEqual([
      `PAPERCUSP_ZRAM_SWAP status=absent reason=swap-not-active unit=${ZRAM_SWAP_UNIT}`,
    ]);
  });

  it('refuses a marker that would break the shell literal or the config syntax', () => {
    expect(() => zramSwapShellLines("# it's")).toThrow(/single quote/);
    expect(() => zramSwapShellLines('not a comment')).toThrow(/comment/);
  });
});

describe('zram settings (WI-6554700010012418)', () => {
  // The values the swap-tier measurement (WI-10005475) ran and the WI recorded; a change here is a
  // change to every hosted desktop, so it should be a deliberate edit to this assertion too.
  it('sizes zram at half of RAM with zstd above any disk swap, and disables swap-in readahead', () => {
    expect(zramGeneratorConfigLines()).toEqual([
      '[zram0]',
      'zram-size = ram / 2',
      'compression-algorithm = zstd',
      'swap-priority = 100',
    ]);
    expect(zramSysctlLines()).toEqual(['vm.page-cluster = 0']);
  });
});
