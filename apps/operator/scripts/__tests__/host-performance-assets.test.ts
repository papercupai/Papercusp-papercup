import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/systemd/papercusp-host-performance.sh');
const UNIT = join(ROOT, 'scripts/systemd/papercusp-host-performance.service');

function createFakeRootDisk(root: string, scheduler = 'none mq-deadline') {
  const commandDir = join(root, 'fake-bin');
  const blockSysfsRoot = join(root, 'sys-block');
  const schedulerPath = join(blockSysfsRoot, 'nvme1n1', 'queue', 'scheduler');
  mkdirSync(commandDir, { recursive: true });
  mkdirSync(join(blockSysfsRoot, 'nvme1n1', 'queue'), { recursive: true });
  writeFileSync(schedulerPath, scheduler + '\n');

  const findmnt = join(commandDir, 'findmnt');
  const lsblk = join(commandDir, 'lsblk');
  writeFileSync(findmnt, '#!/usr/bin/env bash\nprintf "%s\\n" /dev/nvme1n1p2\n');
  writeFileSync(lsblk, '#!/usr/bin/env bash\nprintf "%s\\n" "nvme1n1p2 part" "nvme1n1 disk"\n');
  chmodSync(findmnt, 0o755);
  chmodSync(lsblk, 0o755);

  return { commandDir, blockSysfsRoot, schedulerPath };
}

describe('WI-37533 host performance assets', () => {
  it('has a root-owned oneshot unit with an explicit boot target and no user-writable ExecStart', () => {
    const unit = readFileSync(UNIT, 'utf8');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('ExecStart=/etc/systemd/system/papercusp-host-performance.sh');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('Before=postgresql@18-main.service');
    expect(unit).toContain('RequiredBy=postgresql@18-main.service');
    expect(unit).toContain('ProtectKernelTunables=no');
  });

  it('cannot be manually stopped or restarted, because that would bounce the Postgres that Requires it (WI-10004865)', () => {
    const unit = readFileSync(UNIT, 'utf8');
    const directives = unit.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    // RequiredBy= makes postgresql@18-main Requires= this unit: stop/restart propagates.
    expect(directives).toContain('RequiredBy=postgresql@18-main.service');
    expect(directives).toContain('RefuseManualStop=yes');
    // Re-application goes through reload, which Requires= does not propagate.
    expect(directives).toContain('ExecReload=/etc/systemd/system/papercusp-host-performance.sh');
    // No stronger coupling that would also propagate a stop/restart to Postgres.
    for (const coupling of ['BindsTo=', 'PartOf=', 'PropagatesStopTo=', 'PropagatesReloadTo=']) {
      expect(directives.some((line) => line.startsWith(coupling))).toBe(false);
    }
  });

  it('sets and verifies the root disk scheduler, governor, EPP and 18,000-page default in fake sysfs', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-cpufreq-'));
    const fakeRootDisk = createFakeRootDisk(root);
    const nrHugepages = join(root, 'nr_hugepages');
    try {
      writeFileSync(nrHugepages, '0\n');
      for (const name of ['policy0', 'policy7']) {
        const policy = join(root, name);
        mkdirSync(policy);
        writeFileSync(join(policy, 'scaling_governor'), 'powersave\n');
        writeFileSync(join(policy, 'energy_performance_preference'), 'balance_performance\n');
      }
      const output = execFileSync('bash', [SCRIPT], {
        env: {
          ...process.env,
          PAPERCUSP_CPU_SYSFS_ROOT: root,
          PAPERCUSP_BLOCK_SYSFS_ROOT: fakeRootDisk.blockSysfsRoot,
          PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: nrHugepages,
          PATH: [fakeRootDisk.commandDir, process.env.PATH ?? ''].join(':'),
        },
        encoding: 'utf8',
      });
      expect(output).toContain('verified on 2 CPU policies');
      expect(output).toContain('root I/O scheduler verified: nvme1n1 via /dev/nvme1n1p2 => mq-deadline');
      expect(output).toContain('huge-page reservation verified: reserved=18000 required=18000');
      expect(readFileSync(nrHugepages, 'utf8').trim()).toBe('18000');
      expect(readFileSync(fakeRootDisk.schedulerPath, 'utf8').trim()).toBe('mq-deadline');
      for (const name of ['policy0', 'policy7']) {
        expect(readFileSync(join(root, name, 'scaling_governor'), 'utf8').trim()).toBe('performance');
        expect(readFileSync(join(root, name, 'energy_performance_preference'), 'utf8').trim()).toBe('performance');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when no CPU policy exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-cpufreq-empty-'));
    const fakeRootDisk = createFakeRootDisk(root);
    try {
      expect(() =>
        execFileSync('bash', [SCRIPT], {
          env: {
            ...process.env,
            PAPERCUSP_CPU_SYSFS_ROOT: root,
            PAPERCUSP_BLOCK_SYSFS_ROOT: fakeRootDisk.blockSysfsRoot,
            PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: join(root, 'nr_hugepages'),
            PATH: [fakeRootDisk.commandDir, process.env.PATH ?? ''].join(':'),
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loud when Linux accepts the request but reserves fewer huge pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-hugepages-short-'));
    const fakeRootDisk = createFakeRootDisk(root);
    try {
      const policy = join(root, 'policy0');
      const requested = join(root, 'nr_hugepages.request');
      const observed = join(root, 'nr_hugepages.status');
      mkdirSync(policy);
      writeFileSync(join(policy, 'scaling_governor'), 'powersave\n');
      writeFileSync(join(policy, 'energy_performance_preference'), 'balance_performance\n');
      writeFileSync(requested, '0\n');
      writeFileSync(observed, '618\n');

      expect(() =>
        execFileSync('bash', [SCRIPT], {
          env: {
            ...process.env,
            PAPERCUSP_CPU_SYSFS_ROOT: root,
            PAPERCUSP_BLOCK_SYSFS_ROOT: fakeRootDisk.blockSysfsRoot,
            PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: requested,
            PAPERCUSP_NR_HUGEPAGES_STATUS_PATH: observed,
            PAPERCUSP_NR_HUGEPAGES_TARGET: '18000',
            PATH: [fakeRootDisk.commandDir, process.env.PATH ?? ''].join(':'),
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(readFileSync(requested, 'utf8').trim()).toBe('18000');
      expect(readFileSync(observed, 'utf8').trim()).toBe('618');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails before huge-page writes when mq-deadline is not offered for the root disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-scheduler-unavailable-'));
    const fakeRootDisk = createFakeRootDisk(root, '[none] kyber');
    const policy = join(root, 'policy0');
    const nrHugepages = join(root, 'nr_hugepages');
    try {
      mkdirSync(policy);
      writeFileSync(join(policy, 'scaling_governor'), 'powersave\n');
      writeFileSync(join(policy, 'energy_performance_preference'), 'balance_performance\n');
      writeFileSync(nrHugepages, '0\n');

      expect(() =>
        execFileSync('bash', [SCRIPT], {
          env: {
            ...process.env,
            PAPERCUSP_CPU_SYSFS_ROOT: root,
            PAPERCUSP_BLOCK_SYSFS_ROOT: fakeRootDisk.blockSysfsRoot,
            PAPERCUSP_NR_HUGEPAGES_REQUEST_PATH: nrHugepages,
            PATH: [fakeRootDisk.commandDir, process.env.PATH ?? ''].join(':'),
          },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow();
      expect(readFileSync(nrHugepages, 'utf8').trim()).toBe('0');
      expect(readFileSync(fakeRootDisk.schedulerPath, 'utf8').trim()).toBe('[none] kyber');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
