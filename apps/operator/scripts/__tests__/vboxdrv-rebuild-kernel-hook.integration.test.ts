/**
 * Integration rung for the VirtualBox kernel-update rebuild hook
 * (reboot-residue-service-repairs-2026-10-03, spec FAIL-P-003-vboxdrv-kernel-build, WI-10006520).
 *
 * Contract: a kernel install must never be REPORTED as having a working VirtualBox build when no
 * vboxdrv module exists for that kernel. The unit rung (vboxdrv-rebuild-kernel-hook.test.ts) pins
 * how the hook calls `vboxdrv.sh setup`. This rung checks the outcome against the filesystem. It
 * runs the real tracked hook under the real /bin/sh against a real modules tree, and it judges
 * success by whether a module file is present, NOT by setup's exit status.
 * The case that motivated it is a setup that exits 0 but builds nothing: before WI-10006520 the
 * hook logged "rebuilt" for it.
 *
 * PROBE_SCRIPT overrides the hook path so scripts/mutation-probe.sh can point this rung at a
 * mutated copy outside the shared tree.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = process.env.PROBE_SCRIPT ?? join(__dirname, '..', 'systemd', 'vboxdrv-rebuild.kernel-hook');
const KVER = '7.0.0-34-generic';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** `installs`: the relative path (under modules/<kver>/) the fake setup writes, or null for none. */
function host(installs: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'vboxdrv-hook-int-'));
  dirs.push(root);
  const modules = join(root, 'modules');
  const logDir = join(root, 'log');
  const syslog = join(root, 'syslog');
  mkdirSync(join(modules, KVER, 'build'), { recursive: true });
  mkdirSync(logDir);
  const setup = join(root, 'vboxdrv.sh');
  const install = installs === null
    ? []
    : [`mkdir -p "$(dirname "${modules}/$2/${installs}")"`, `: > "${modules}/$2/${installs}"`];
  writeFileSync(setup, ['#!/bin/sh', 'echo "vboxdrv.sh: building for $2"', ...install, 'exit 0', ''].join('\n'));
  chmodSync(setup, 0o755);
  const logger = join(root, 'logger');
  writeFileSync(logger, `#!/bin/sh\necho "$*" >> "${syslog}"\n`);
  chmodSync(logger, 0o755);
  const run = () =>
    spawnSync('/bin/sh', [HOOK, KVER, `/boot/vmlinuz-${KVER}`], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        VBOXDRV_REBUILD_SETUP: setup,
        VBOXDRV_REBUILD_MODULES_DIR: modules,
        VBOXDRV_REBUILD_LOG_DIR: logDir,
        VBOXDRV_REBUILD_LOGGER: logger,
      },
    });
  const readSyslog = () => (existsSync(syslog) ? readFileSync(syslog, 'utf8') : '');
  return { run, readSyslog, logPath: join(logDir, `vboxdrv-rebuild-${KVER}.log`) };
}

describe('vboxdrv-rebuild hook — missing module build is detected (FAIL-P-003)', () => {
  it('setup exits 0 but no vboxdrv module exists for the kernel → loud FAILED, never "rebuilt", exit 0', () => {
    const h = host(null);
    const r = h.run();
    expect(r.status).toBe(0); // dpkg must never be wedged by the hook
    expect(readFileSync(h.logPath, 'utf8')).toContain(`building for ${KVER}`); // setup really ran
    expect(r.stderr).toContain(`no vboxdrv module exists under`);
    expect(r.stderr).toContain(KVER);
    const log = h.readSyslog();
    expect(log).toContain('-p user.err');
    expect(log).toContain(`no vboxdrv module for ${KVER}`);
    expect(log).not.toContain('rebuilt VirtualBox modules');
  });

  it("Oracle layout: a module under misc/ is reported rebuilt", () => {
    const h = host('misc/vboxdrv.ko');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(h.readSyslog()).toContain(`rebuilt VirtualBox modules for ${KVER}`);
    expect(h.readSyslog()).not.toContain('user.err');
  });

  it('DKMS layout with a compressed module (updates/dkms/vboxdrv.ko.zst) is reported rebuilt', () => {
    const h = host('updates/dkms/vboxdrv.ko.zst');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(h.readSyslog()).toContain(`rebuilt VirtualBox modules for ${KVER}`);
  });

  it('a module built for a DIFFERENT kernel does not count', () => {
    const h = host(null);
    const otherKernel = join(h.logPath, '..', '..', 'modules', '6.99.0-1-generic', 'misc');
    mkdirSync(otherKernel, { recursive: true });
    writeFileSync(join(otherKernel, 'vboxdrv.ko'), '');
    const r = h.run();
    expect(r.status).toBe(0);
    expect(h.readSyslog()).toContain(`no vboxdrv module for ${KVER}`);
    expect(h.readSyslog()).not.toContain('rebuilt VirtualBox modules');
  });
});
