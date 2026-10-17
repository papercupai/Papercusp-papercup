import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_HOST_DATA_ROOT } from '@papercusp/deployment-driver';
import { workspaceHostDurableTenantIdentity, renderDurableFilesystemScriptCore, renderDurableStorageQuotaCore, renderDurableToolPrerequisiteCore } from './aws-host-bootstrap-push-core.mjs';
import {
  renderDurableFilesystemScript,
  WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT,
} from './durable-filesystem-script';

/**
 * The provider-neutral durable data mount (plan aws-byoc-gcp-parity-2026-10-01 D-013 point 2).
 * GCP's output was compared byte-for-byte against its pre-extraction function when this moved
 * (WI-10005172), and gcp-provider.test.ts keeps pinning GCP's startup-script behaviour; this file
 * pins the parts AWS relies on.
 */

const AWS_DEVICE = '/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0';
const DATA_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const TENANT = workspaceHostDurableTenantIdentity('workspace', 'customer');

function executeTenantGuard(input: { root: string; tenant?: string; formatted?: boolean;
  mountedUuid?: string; uuid?: string; fsroot?: string; owner?: number; newBoot?: boolean }) {
  const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30, tenantIdentity: input.tenant });
  const block = script.slice(script.indexOf('data_mounted_uuid='), script.indexOf('resize2fs'));
  return spawnSync('bash', ['-c', [
    'set -euo pipefail', `data_mount='${input.root}'`,
    `data_probe_marker='${input.root}/${input.newBoot ? 'replacement' : 'original'}-boot'`,
    `data_uuid='${input.uuid ?? DATA_UUID}'`, `data_freshly_formatted=${input.formatted ? 1 : 0}`,
    `findmnt() { if [[ "$*" == *FSROOT* ]]; then printf '%s' '${input.fsroot ?? '/'}'; else printf '%s' '${input.mountedUuid ?? input.uuid ?? DATA_UUID}'; fi; }`,
    // Hosts run this block as root; preserve the real mode while emulating only the uid.
    `stat() { printf '${input.owner ?? 0}:%s' "$(command stat -c %a "\${@: -1}")"; }`,
    block, 'flock -n "${data_probe_marker}.lock" true', 'echo BOOTSTRAP',
  ].join('\n')], { encoding: 'utf8', timeout: 5000 });
}

function executeProbe(input: { dataMode: 'fresh' | 'existing'; probeStatus: number; type: string;
  wipeStatus: number; signatures: string; stateDir: string; uuid?: string }) {
  const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30, dataMode: input.dataMode });
  const probe = script.slice(script.indexOf('data_mode='), script.indexOf('install -d -m 0750 "$data_mount"'))
    .replace('data_probe_state_dir=/var/lib/papercusp-host-bootstrap/data-identity', `data_probe_state_dir='${input.stateDir}'`);
  return spawnSync('bash', ['-c', [
    'set -euo pipefail', 'data_device=/dev/fixture',
    `blkid() { if [[ "$*" == *TYPE* ]]; then printf '%s' '${input.type}'; return ${input.probeStatus}; fi; printf '%s' '${input.uuid ?? '01234567-89ab-cdef-0123-456789abcdef'}'; }`,
    `wipefs() { printf '%s' '${input.signatures}'; return ${input.wipeStatus}; }`,
    'mkfs.ext4() { echo FORMATTED; }', probe,
    // A new bootstrap child must be able to acquire this lock independently.
    'flock -n "${data_probe_marker}.lock" true',
  ].join('\n')], { encoding: 'utf8', timeout: 5000 });
}

describe('renderDurableFilesystemScript', () => {
  const allocation = { dbGiB: 256, workspaceGiB: 32 };
  function executeStorageQuota(root: string, options: { fresh?: boolean; features?: string;
    mountOptions?: string; quotaFailure?: boolean; inherit?: boolean; share?: typeof allocation } = {}) {
    for (const dir of ['postgres', 'repositories', 'transcripts', 'workspaces']) mkdirSync(join(root, dir), { recursive: true });
    const block = renderDurableStorageQuotaCore(options.share ?? allocation, TENANT).join('\n');
    return spawnSync('bash', ['-c', [
      'set -euo pipefail', `data_mount='${root}'`, 'data_device=/dev/fixture',
      `data_uuid='${DATA_UUID}'`, `data_probe_marker='${root}/boot'`,
      `data_freshly_formatted=${options.fresh ? 1 : 0}`,
      `tune2fs() { printf 'Filesystem features: ${options.features ?? 'has_journal extent quota project'}\n'; }`,
      `findmnt() { printf '${options.mountOptions ?? 'rw,relatime,prjquota'}'; }`,
      // Emulate only root ownership: mode and filesystem device checks remain real.
      'stat() { if [[ "$*" == *%u:%a* ]]; then printf "0:%s" "$(command stat -c %a "${@: -1}")"; else command stat "$@"; fi; }',
      `setquota() { printf 'QUOTA %s\n' "$*"; return ${options.quotaFailure ? 1 : 0}; }`,
      'chattr() { printf "PROJECT %s\\n" "$*"; }',
      // This shell contract test does not mount a filesystem; do not flush the shared test disk.
      'sync() { [[ "$1" == -f && -f "$2" ]]; }',
      `lsattr() { local path="\${@: -1}"; if [[ "$path" == */postgres ]]; then printf '1001 '; else printf '1002 '; fi; printf '%s %s\\n' '${options.inherit === false ? '--------------' : '--------P-----'}' "$path"; }`,
      block, 'echo BOOTSTRAP',
    ].join('\n')], { encoding: 'utf8', timeout: 5000 });
  }

  it('enforces distinct DB and shared workspace hard limits before runtime, and replays unchanged allocation', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-'));
    try {
      const first = executeStorageQuota(root, { fresh: true });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain(`QUOTA -P 1001 0 268435456 0 0 ${root}`);
      expect(first.stdout).toContain(`QUOTA -P 1002 0 33554432 0 0 ${root}`);
      for (const dir of ['repositories', 'transcripts', 'workspaces']) expect(first.stdout).toContain(`PROJECT -p 1002 +P ${root}/${dir}`);
      const marker = readFileSync(join(root, '.papercusp-storage-quota'), 'utf8');
      expect(marker).toBe(`papercusp-storage-quota-v1:${TENANT}:${DATA_UUID}:256:32\n`);
      expect(executeStorageQuota(root).status).toBe(0);
      const changed = executeStorageQuota(root, { share: { dbGiB: 128, workspaceGiB: 160 } });
      expect(changed.status).toBe(1);
      expect(changed.stderr).toContain('allocation identity mismatch');
      expect(changed.stdout).not.toContain('QUOTA');
      expect(readFileSync(join(root, '.papercusp-storage-quota'), 'utf8')).toBe(marker);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['unqualified existing disk', {}, 'migration qualification required'],
    ['missing feature', { fresh: true, features: 'has_journal quota' }, 'feature missing: project'],
    ['unenforced mount', { fresh: true, mountOptions: 'rw,relatime' }, 'enforcement is not mounted'],
    ['kernel quota refusal', { fresh: true, quotaFailure: true }, ''],
    ['missing project inheritance', { fresh: true, inherit: false }, 'inheritance not enforced'],
  ])('refuses %s before runtime', (_name, options, reason) => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-refusal-'));
    try {
      const run = executeStorageQuota(root, options);
      expect(run.status).toBe(1);
      if (reason) expect(run.stderr).toContain(reason);
      expect(run.stdout).not.toContain('BOOTSTRAP');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a symlinked project directory and a writable allocation pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-identity-'));
    try {
      expect(executeStorageQuota(root, { fresh: true }).status).toBe(0);
      rmSync(join(root, 'transcripts'), { recursive: true });
      symlinkSync(join(root, 'repositories'), join(root, 'transcripts'));
      const redirected = executeStorageQuota(root);
      expect(redirected.status).toBe(1);
      expect(redirected.stderr).toContain('directory identity mismatch');
      chmodSync(join(root, '.papercusp-storage-quota'), 0o644);
      expect(executeStorageQuota(root).stderr).toContain('allocation identity mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
    'refuses invalid or unlimited DB share %s', dbGiB => {
      expect(() => renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30,
        tenantIdentity: TENANT, allocation: { ...allocation, dbGiB } })).toThrow(/positive safe integral/);
    });

  it('gives both renderers identical quota enforcement and seeds agent homes inside the shared project', () => {
    const input = { devicePath: AWS_DEVICE, deviceWaitSec: 30, tenantIdentity: TENANT,
      allocation, hostBootstrapScript: 'echo BOOTSTRAP' };
    const rendered = [renderDurableFilesystemScript(input), renderDurableFilesystemScriptCore(input)];
    for (const script of rendered) {
      expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
      expect(script).toContain('mkfs.ext4 -O quota,project -E quotatype=prjquota -I 256');
      expect(script).toContain('defaults,nofail,discard,prjquota');
      expect(script.indexOf('setquota -P')).toBeLessThan(script.indexOf('echo BOOTSTRAP'));
      expect(script.indexOf('durable_storage_project 1002 "$home_seed"')).toBeLessThan(script.indexOf('cp -a "$home_target"'));
      expect(script).not.toContain('tune2fs -O');
    }
    const quota = (script: string) => script.slice(script.indexOf('# Begin admitted'), script.indexOf('# End admitted'));
    expect(quota(rendered[0]!)).toBe(quota(rendered[1]!));
    expect(() => renderDurableFilesystemScript({ ...input, tenantIdentity: undefined })).toThrow(/requires tenant/);
  });

  it('creates the project-quota filesystem features on real blank media without root or a mount', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-ext4-'));
    try {
      const image = join(root, 'data.ext4');
      const created = spawnSync('truncate', ['-s', '32M', image], { encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);
      const formatted = spawnSync('/usr/sbin/mkfs.ext4', ['-q', '-O', 'quota,project', '-E', 'quotatype=prjquota', '-I', '256', image], { encoding: 'utf8', timeout: 10000 });
      expect(formatted.status, formatted.stderr).toBe(0);
      const observed = spawnSync('/usr/sbin/tune2fs', ['-l', image], { encoding: 'utf8' });
      expect(observed.status, observed.stderr).toBe(0);
      const features = observed.stdout.split('\n').find(line => line.startsWith('Filesystem features:'));
      expect(features).toMatch(/\bquota\b/);
      expect(features).toMatch(/\bproject\b/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('binds a newly formatted volume once and preserves its tenant across a replacement boot disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-tenant-'));
    try {
      const first = executeTenantGuard({ root, tenant: TENANT, formatted: true });
      expect(first.status, first.stderr).toBe(0);
      const marker = readFileSync(join(root, '.papercusp-tenant'), 'utf8');
      expect(marker).toBe(`papercusp-tenant-v1:${TENANT}:${DATA_UUID}\n`);
      const resumed = executeTenantGuard({ root, tenant: TENANT, newBoot: true });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('BOOTSTRAP');
      expect(readFileSync(join(root, '.papercusp-tenant'), 'utf8')).toBe(marker);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['foreign tenant', { tenant: 'b'.repeat(64) }, 'tenant identity mismatch'],
    ['missing controller binding', { tenant: undefined }, 'controller tenant identity required'],
    ['changed UUID', { uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, 'tenant identity mismatch'],
    ['wrong mount', { mountedUuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, 'mount identity mismatch'],
    ['subdirectory bind', { fsroot: '/foreign' }, 'mount identity mismatch'],
    ['non-root marker', { owner: 1000 }, 'tenant identity mismatch'],
  ])('refuses %s before starting the runtime', (_name, overrides, error) => {
    const root = mkdtempSync(join(tmpdir(), 'durable-foreign-'));
    try {
      const marker = `papercusp-tenant-v1:${TENANT}:${DATA_UUID}\n`;
      writeFileSync(join(root, '.papercusp-tenant'), marker, { mode: 0o600 });
      const run = executeTenantGuard({ root, tenant: TENANT, ...overrides });
      expect(run.status, run.stderr).toBe(1);
      expect(run.stderr).toContain(error);
      expect(run.stdout).not.toContain('BOOTSTRAP');
      expect(readFileSync(join(root, '.papercusp-tenant'), 'utf8')).toBe(marker);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses unmarked existing data, symlink markers and writable markers without adopting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-unmarked-'));
    const marker = join(root, '.papercusp-tenant');
    try {
      const unmarked = executeTenantGuard({ root, tenant: TENANT });
      expect(unmarked.status).toBe(1);
      expect(unmarked.stderr).toContain('refusing empty initialization');
      expect(existsSync(marker)).toBe(false);
      symlinkSync(join(root, 'missing'), marker);
      expect(executeTenantGuard({ root, tenant: TENANT, formatted: true }).stderr).toContain('marker is a symlink');
      rmSync(marker);
      writeFileSync(marker, `papercusp-tenant-v1:${TENANT}:${DATA_UUID}\n`, { mode: 0o600 });
      chmodSync(marker, 0o644);
      expect(executeTenantGuard({ root, tenant: TENANT }).stderr).toContain('tenant identity mismatch');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('derives distinct tenant identities across control workspaces and rejects shell payloads', () => {
    expect(TENANT).not.toBe(workspaceHostDurableTenantIdentity('other-workspace', 'customer'));
    expect(TENANT).not.toBe(workspaceHostDurableTenantIdentity('workspace', 'other-customer'));
    expect(() => workspaceHostDurableTenantIdentity('', 'customer')).toThrow(/requires/);
    expect(() => renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30,
      tenantIdentity: "'; echo foreign" })).toThrow(/sha256/);
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30,
      tenantIdentity: TENANT, hostBootstrapScript: 'echo BOOTSTRAP' });
    expect(script.indexOf('durable tenant identity mismatch')).toBeLessThan(script.indexOf('resize2fs'));
    expect(script.indexOf('durable tenant identity mismatch')).toBeLessThan(script.indexOf('echo BOOTSTRAP'));
  });

  it('renders valid bash that waits for, formats-if-blank, and mounts the named device', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 180 });
    const syntax = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain(`data_device='${AWS_DEVICE}'`);
    expect(script).toContain(`data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`);
    expect(script).toContain('for attempt in $(seq 1 180); do test -b "$data_device"');
    expect(script).toContain('wipefs --no-act --noheadings --output TYPE "$data_device"');
    expect(script).not.toContain('mkfs.ext4 -F');
    // Survives a reboot without re-running: every mount is in fstab, and the data mount is nofail.
    expect(script).toContain('defaults,nofail,discard');
    expect(script).toContain('none bind 0 0\\n" "$data_mount/home" "$home_target" >> /etc/fstab');
    expect(script).toContain(`${WORKSPACE_HOST_DATA_ROOT} none bind 0 0`);
  });

  it.each([
    ['fresh', 0, 'ext4', 0, '', false, 0],
    ['existing', 0, 'ext4', 0, '', false, 0],
    ['fresh', 2, '', 0, '', true, 0],
    ['existing', 2, '', 0, '', false, 1],
    ['fresh', 8, '', 0, '', false, 1],
    ['existing', 4, '', 0, '', false, 1],
    ['fresh', 2, '', 1, '', false, 1],
    ['fresh', 2, '', 0, 'ext4', false, 1],
    ['fresh', 0, 'xfs', 0, '', false, 1],
    ['existing', 0, 'xfs', 0, '', false, 1],
  ] as const)('executes safe %s probe (blkid=%s,type=%s,wipefs=%s,signatures=%s)',
    (dataMode, probeStatus, type, wipeStatus, signatures, formatted, exitStatus) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'durable-probe-'));
      try {
        const run = executeProbe({ dataMode, probeStatus, type, wipeStatus, signatures, stateDir });
        expect(run.status, run.stderr).toBe(exitStatus);
        expect(run.stdout.includes('FORMATTED')).toBe(formatted);
      } finally { rmSync(stateDir, { recursive: true, force: true }); }
    });

  it('never restores fresh-format permission on reboot and refuses a changed filesystem identity', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'durable-reboot-'));
    const input = { dataMode: 'fresh' as const, probeStatus: 2, type: '', wipeStatus: 0, signatures: '', stateDir };
    try {
      const first = executeProbe(input);
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain('FORMATTED');
      const lostSignature = executeProbe(input);
      expect(lostSignature.status).toBe(1);
      expect(lostSignature.stdout).not.toContain('FORMATTED');
      const foreign = executeProbe({ ...input, probeStatus: 0, type: 'ext4', uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
      expect(foreign.status).toBe(1);
      expect(foreign.stderr).toContain('UUID changed');
      const resumed = executeProbe({ ...input, probeStatus: 0, type: 'ext4' });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).not.toContain('FORMATTED');
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it('binds the canonical home on a bootc image, where /home is a symlink to var/home (WI-10006838)', () => {
    // Measured 2026-10-06 on AMI A-r62b (CentOS Stream 10 bootc): /home -> var/home. The script
    // refused that layout outright, so every bootc host failed bootstrap on AWS and GCP. Run the
    // real rendered home block against a bootc-shaped root and an ordinary one.
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    expect(script).not.toMatch(/-L \/home\b/);
    const start = script.indexOf('home_target="$(readlink -f -- /home)"');
    const end = script.indexOf('install -d -m 0755 "$home_target"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);

    const root = mkdtempSync(join(tmpdir(), 'durable-home-'));
    const run = (homePath: string) =>
      spawnSync(
        'bash',
        ['-c', ['set -euo pipefail', block.replaceAll('-- /home)', `-- ${homePath})`), 'echo "TARGET=$home_target"'].join('\n')],
        { encoding: 'utf8', env: { ...process.env, data_mount: join(root, 'data') }, timeout: 5000 },
      );
    try {
      mkdirSync(join(root, 'data'));
      // bootc: <root>/home -> var/home (relative, exactly as ostree writes it).
      mkdirSync(join(root, 'var', 'home', 'papercusp-workspace'), { recursive: true });
      writeFileSync(join(root, 'var', 'home', 'papercusp-workspace', '.auth-fixture'), 'customer-login');
      symlinkSync('var/home', join(root, 'home'));
      const bootc = run(join(root, 'home'));
      expect(bootc.status, bootc.stderr).toBe(0);
      expect(bootc.stdout).toContain(`TARGET=${realpathSync(join(root, 'var', 'home'))}`);
      expect(readFileSync(join(root, 'data', 'home', 'papercusp-workspace', '.auth-fixture'), 'utf8')).toBe(
        'customer-login',
      );

      // An ordinary image: a real /home resolves to itself.
      mkdirSync(join(root, 'plain-home'));
      const plain = run(join(root, 'plain-home'));
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stdout).toContain(`TARGET=${realpathSync(join(root, 'plain-home'))}`);

      // A /home that resolves to nothing is still refused.
      symlinkSync('missing', join(root, 'dangling-home'));
      const dangling = run(join(root, 'dangling-home'));
      expect(dangling.status).toBe(1);
      expect(dangling.stderr).toContain('workspace home mount target is not a real directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('relabels the fresh mount root on SELinux hosts before creating its children, never recursively (WI-10006903)', () => {
    // A new ext4 has no security.selinux xattrs, so its root reads unlabeled_t and every child
    // inherits it (measured on a P-012 bootc host). The relabel must come after the mount and
    // before the first child directory, and must not recurse: a recursive relabel by the backing
    // path would rewrite the home bind's copied labels to var_lib_t.
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    const lines = script.split('\n');
    const mount = lines.findIndex((l) => l.includes('mount "$data_mount"'));
    const relabel = lines.findIndex((l) => l.includes('restorecon'));
    const firstChild = lines.findIndex((l) => l.startsWith('install -d') && l.includes('"$data_mount"/'));
    expect(mount).toBeGreaterThan(0);
    expect(relabel).toBeGreaterThan(mount);
    expect(firstChild).toBeGreaterThan(relabel);
    expect(lines.filter((l) => l.includes('restorecon'))).toHaveLength(1);
    expect(lines[relabel]).not.toMatch(/restorecon\s+-\w*R/);

    const stubs = mkdtempSync(join(tmpdir(), 'durable-selinux-'));
    const run = (selinux: boolean) => {
      writeFileSync(join(stubs, 'selinuxenabled'), `#!/bin/sh\nexit ${selinux ? 0 : 1}\n`, { mode: 0o755 });
      writeFileSync(join(stubs, 'restorecon'), '#!/bin/sh\necho "restorecon $*"\n', { mode: 0o755 });
      return spawnSync('bash', ['-c', `set -euo pipefail\ndata_mount=/var/lib/papercusp\n${lines[relabel]}`], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
        timeout: 5000,
      });
    };
    try {
      const enforcing = run(true);
      expect(enforcing.status, enforcing.stderr).toBe(0);
      expect(enforcing.stdout.trim()).toBe(`restorecon -F ${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}`);
      const ubuntu = run(false);
      expect(ubuntu.status, ubuntu.stderr).toBe(0);
      expect(ubuntu.stdout).toBe('');
    } finally {
      rmSync(stubs, { recursive: true, force: true });
    }
  });

  it('runs the host bootstrap only after every durable mount, without its shebang', () => {
    const script = renderDurableFilesystemScript({
      devicePath: AWS_DEVICE,
      deviceWaitSec: 30,
      hostBootstrapScript: '#!/usr/bin/env bash\necho papercusp-bootstrap\n',
    });
    const bootstrapAt = script.indexOf('echo papercusp-bootstrap');
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/workspaces"`));
    expect(bootstrapAt).toBeGreaterThan(script.indexOf(`mount --bind "$data_mount/home"`));
    expect(script.match(/^#!/gm)).toHaveLength(1);
  });

  it('prepares quota tooling before probing or touching the durable device, and fails closed on bootc', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30, allocation, tenantIdentity: TENANT });
    const prerequisites = script.indexOf('required_durable_tools=');
    expect(prerequisites).toBeGreaterThan(-1);
    expect(prerequisites).toBeLessThan(script.indexOf('data_device='));
    expect(prerequisites).toBeLessThan(script.indexOf('data_mode='));
    expect(script).toContain('apt-get install --no-install-recommends -y e2fsprogs quota util-linux');
    expect(script).toContain('durable quota prerequisites missing from immutable bootc image');
  });

  describe('durable prerequisite execution', () => {
    function execute(missing: string, outcome: 'installed' | 'incomplete' | 'failed' | 'immutable') {
      const root = mkdtempSync(join(tmpdir(), 'durable-prerequisite-'));
      try {
        if (outcome === 'immutable') writeFileSync(join(root, 'immutable'), '');
        const prerequisites = renderDurableToolPrerequisiteCore().join('\n')
          .replaceAll('/run/ostree-booted', join(root, 'immutable'))
          .replaceAll('/usr/bin/bootc', join(root, 'bootc'));
        return spawnSync('bash', ['-c', [
          'set -euo pipefail',
          // Model command availability without invoking apt, mounting or touching a device.
          'command() { [[ "$1" == -v ]] || { builtin command "$@"; return; }; [[ "$2" != "$MISSING_TOOL" || -e "$FIXTURE/installed" ]]; }',
          'timeout() { printf "TIMEOUT %s\\n" "$*"; shift 3; "$@"; }',
          'apt-get() { printf "APT %s\\n" "$*"; [[ "$OUTCOME" != failed ]] || return 42; if [[ "$1" == install && "$OUTCOME" == installed ]]; then printf ready > "$FIXTURE/installed"; fi; return 0; }',
          prerequisites,
          'printf "DEVICE_TOUCHED\\n"',
        ].join('\n')], { encoding: 'utf8', timeout: 10000,
          env: { ...process.env, FIXTURE: root, MISSING_TOOL: missing, OUTCOME: outcome } });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }

    it.each(['chattr', 'lsattr', 'flock'])('installs missing %s before device access', (tool) => {
      const run = execute(tool, 'installed');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('TIMEOUT -k 30 180 apt-get update');
      expect(run.stdout).toContain('TIMEOUT -k 30 600 apt-get install --no-install-recommends -y e2fsprogs quota util-linux');
      expect(run.stdout.indexOf('APT install')).toBeLessThan(run.stdout.indexOf('DEVICE_TOUCHED'));
    });

    it.each(['chattr', 'lsattr', 'flock'])('refuses immutable images missing %s without package or device mutation', (tool) => {
      const run = execute(tool, 'immutable');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`durable quota prerequisites missing from immutable bootc image: ${tool}`);
      expect(run.stdout).not.toContain('APT');
      expect(run.stdout).not.toContain('DEVICE_TOUCHED');
    });

    it('rechecks tools after install and refuses an incomplete package result', () => {
      const run = execute('chattr', 'incomplete');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('durable quota prerequisite still missing after install: chattr');
      expect(run.stdout).not.toContain('DEVICE_TOUCHED');
    });

    it('propagates package failures before device access', () => {
      const run = execute('flock', 'failed');
      expect(run.status).toBe(42);
      expect(run.stdout).toContain('APT update');
      expect(run.stdout).not.toContain('APT install');
      expect(run.stdout).not.toContain('DEVICE_TOUCHED');
    });

    it('does not install packages when the required tools are already available', () => {
      const run = execute('unused-tool', 'installed');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toBe('DEVICE_TOUCHED\n');
    });
  });

  it('emits the mount alone when there is no bootstrap', () => {
    const script = renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec: 30 });
    expect(script).not.toContain('# User-supplied bootstrap follows the durable mount.');
  });

  it('refuses a device that is not named by a stable /dev/disk/by-id path', () => {
    // The script formats a blank device, so a guessed kernel name could format the wrong disk.
    for (const devicePath of ['/dev/nvme1n1', '/dev/xvdf', '/dev/disk/by-id/', "/dev/disk/by-id/x'; rm -rf /"]) {
      expect(() => renderDurableFilesystemScript({ devicePath, deviceWaitSec: 30 })).toThrow(/by-id/);
    }
  });

  it('refuses a wait that is not a positive whole number of seconds', () => {
    for (const deviceWaitSec of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderDurableFilesystemScript({ devicePath: AWS_DEVICE, deviceWaitSec })).toThrow(/wait/);
    }
  });
});
