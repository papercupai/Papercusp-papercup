/**
 * vboxdrv-rebuild-kernel-hook.test.ts — the RECURRENCE GUARD for the VirtualBox
 * kernel-update residue (reboot-residue-service-repairs-2026-10-03 D-004 / R-004,
 * WI-10005993, WI-10006387).
 *
 * The outage: Oracle's virtualbox-7.2 package ships no kernel-update hook, so a
 * kernel update leaves vboxdrv unbuilt for the new kernel and VirtualBox is down
 * after the next reboot. The guard is apps/operator/scripts/systemd/vboxdrv-rebuild.kernel-hook,
 * installed into /etc/kernel/postinst.d and /etc/kernel/header_postinst.d.
 *
 * These cases EXECUTE the hook against stubs (a fake vboxdrv.sh and a temp modules
 * root), so they go red if the hook stops rebuilding for the kernel it was given,
 * stops deferring cleanly when headers are not yet installed, or ever exits non-zero
 * (a non-zero kernel hook wedges dpkg — WI-38019). The README cases pin the install
 * recipe so the documented install cannot drift away from the two hook directories.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SYSTEMD_DIR = join(__dirname, '..', 'systemd');
// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at a mutated COPY
// outside the tree instead of mutating the shared checkout.
const HOOK = process.env.PROBE_SCRIPT ?? join(SYSTEMD_DIR, 'vboxdrv-rebuild.kernel-hook');
const README = join(SYSTEMD_DIR, 'README.md');
const KVER = '9.9.9-test-generic';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  setup: string;
  modules: string;
  logDir: string;
  calls: string;
  syslog: string;
}

function makeFixture(
  opts: { setupExit?: number; withSetup?: boolean; withHeaders?: boolean; installsModule?: boolean } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'vboxdrv-rebuild-hook-'));
  dirs.push(root);
  const setup = join(root, 'vboxdrv.sh');
  const modules = join(root, 'modules');
  const logDir = join(root, 'log');
  const calls = join(root, 'setup-calls');
  const syslog = join(root, 'syslog');
  mkdirSync(modules);
  mkdirSync(logDir);
  if (opts.withHeaders ?? true) mkdirSync(join(modules, KVER, 'build'), { recursive: true });
  if (opts.withSetup ?? true) {
    writeFileSync(
      setup,
      [
        '#!/bin/sh',
        // Record exactly how the hook invoked the maintained rebuild path.
        `echo "argv=$* KERN_VER=\${KERN_VER:-}" >> "${calls}"`,
        'echo "building modules"',
        // Like Oracle's vboxdrv.sh: a successful build leaves the module under misc/ for $2.
        ...((opts.installsModule ?? true)
          ? [`mkdir -p "${modules}/$2/misc" && : > "${modules}/$2/misc/vboxdrv.ko"`]
          : []),
        `exit ${opts.setupExit ?? 0}`,
        '',
      ].join('\n'),
    );
    chmodSync(setup, 0o755);
  }
  const logger = join(root, 'logger');
  writeFileSync(logger, `#!/bin/sh\necho "$*" >> "${syslog}"\n`);
  chmodSync(logger, 0o755);
  return { root, setup, modules, logDir, calls, syslog };
}

function runHook(f: Fixture, args: string[]) {
  return spawnSync('/bin/sh', [HOOK, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      VBOXDRV_REBUILD_SETUP: f.setup,
      VBOXDRV_REBUILD_MODULES_DIR: f.modules,
      VBOXDRV_REBUILD_LOG_DIR: f.logDir,
      VBOXDRV_REBUILD_LOGGER: join(f.root, 'logger'),
    },
  });
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

describe('vboxdrv-rebuild kernel hook', () => {
  it('rebuilds VirtualBox modules for exactly the kernel it is handed, via vboxdrv.sh setup', () => {
    const f = makeFixture();
    const r = runHook(f, [KVER, '/boot/vmlinuz-' + KVER]);
    expect(r.status).toBe(0);
    expect(read(f.calls).trim()).toBe(`argv=setup ${KVER} KERN_VER=${KVER}`);
    expect(read(join(f.logDir, `vboxdrv-rebuild-${KVER}.log`))).toContain('building modules');
    expect(read(f.syslog)).toContain(`rebuilt VirtualBox modules for ${KVER}`);
  });

  it('a FAILED build is loud (stderr + syslog error) but never exits non-zero, so dpkg is not wedged', () => {
    const f = makeFixture({ setupExit: 3 });
    const r = runHook(f, [KVER]);
    expect(r.status).toBe(0);
    expect(read(f.calls)).toContain(`setup ${KVER}`);
    expect(r.stderr).toContain(`FAILED to build VirtualBox modules for ${KVER}`);
    expect(read(f.syslog)).toContain('-p user.err');
  });

  it('defers without building when the kernel headers are not installed yet', () => {
    const f = makeFixture({ withHeaders: false });
    const r = runHook(f, [KVER]);
    expect(r.status).toBe(0);
    expect(read(f.calls)).toBe('');
    expect(r.stderr).toContain(`no headers for ${KVER} yet`);
  });

  it('is a no-op when VirtualBox is not installed (no vboxdrv.sh)', () => {
    const f = makeFixture({ withSetup: false });
    const r = runHook(f, [KVER]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('is a no-op when run-parts passes no kernel release', () => {
    const f = makeFixture();
    const r = runHook(f, []);
    expect(r.status).toBe(0);
    expect(read(f.calls)).toBe('');
  });
});

describe('vboxdrv-rebuild install recipe (README)', () => {
  const readme = readFileSync(README, 'utf8');

  it('installs the hook root-owned 0755 into BOTH kernel hook directories', () => {
    for (const dir of ['/etc/kernel/postinst.d', '/etc/kernel/header_postinst.d']) {
      expect(readme).toMatch(
        new RegExp(
          `sudo install -o root -g root -m 0755 vboxdrv-rebuild\\.kernel-hook \\\\\\s*\\n\\s*${dir.replace(/\//g, '\\/')}\\/vboxdrv-rebuild`,
        ),
      );
    }
  });

  it('documents a byte-identity check of the installed copies against the repo blob', () => {
    expect(readme).toContain('cmp vboxdrv-rebuild.kernel-hook /etc/kernel/postinst.d/vboxdrv-rebuild');
    expect(readme).toContain('cmp vboxdrv-rebuild.kernel-hook /etc/kernel/header_postinst.d/vboxdrv-rebuild');
  });
});
