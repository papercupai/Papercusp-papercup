import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEc2ConsoleBootstrapStatus } from '@papercusp/deployment-driver';
import {
  AWS_DATA_DEVICE_WAIT_SEC,
  AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES,
  AWS_HOST_BOOTSTRAP_STAGING_DIR,
  AWS_HOST_BOOTSTRAP_UNIT,
  awsEbsNvmeDevicePath,
  renderAwsHostBootstrapPush,
} from './aws-host-bootstrap-push';
import { renderDurableFilesystemScript } from './durable-filesystem-script';

/**
 * The SSM-pushed AWS host bootstrap (plan aws-byoc-gcp-parity-2026-10-01 D-013, WI-10005172).
 * The wrapper is executed under `sh` — the shell AWS-RunShellScript uses — with `systemctl` and
 * `systemd-run` stubbed on PATH and the staging directory and console redirected into a temp dir.
 */

const VOLUME_ID = 'vol-0123456789abcdef0';
const BOOTSTRAP = '#!/usr/bin/env bash\nset -euo pipefail\necho papercusp-bootstrap\n';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface WrapperRun {
  status: number | null;
  stderr: string;
  staged: string;
  systemdRunArgs: string | null;
  console: string;
}

function runWrapper(commands: readonly string[], activeState = 'inactive'): WrapperRun {
  const root = mkdtempSync(join(tmpdir(), 'aws-bootstrap-push-'));
  scratch.push(root);
  const bin = join(root, 'bin');
  const staged = join(root, 'staging');
  const consoleFile = join(root, 'console');
  const recorded = join(root, 'systemd-run.args');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho '${activeState}'\n`);
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${recorded}'\n`);
  chmodSync(join(bin, 'systemctl'), 0o755);
  chmodSync(join(bin, 'systemd-run'), 0o755);
  const script = commands
    .map((line) => line.split(AWS_HOST_BOOTSTRAP_STAGING_DIR).join(staged))
    .map((line) => line.replace('> /dev/console', `>> '${consoleFile}'`))
    .join('\n');
  const run = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  return {
    status: run.status,
    stderr: run.stderr,
    staged,
    systemdRunArgs: existsSync(recorded) ? readFileSync(recorded, 'utf8').trim() : null,
    console: existsSync(consoleFile) ? readFileSync(consoleFile, 'utf8') : '',
  };
}

describe('renderAwsHostBootstrapPush', () => {
  it('delivers the tenant guard inside the verified AWS payload', () => {
    const push = renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: BOOTSTRAP,
      tenantIdentity: 'a'.repeat(64), allocation: { dbGiB: 256, workspaceGiB: 32 } });
    const run = runWrapper(push.commands);
    expect(run.status, run.stderr).toBe(0);
    const installed = readFileSync(join(run.staged, 'bootstrap.sh'), 'utf8');
    expect(installed).toContain(`data_expected_tenant='${'a'.repeat(64)}'`);
    expect(installed.indexOf('durable tenant identity mismatch')).toBeLessThan(installed.indexOf('echo papercusp-bootstrap'));
    expect(installed).toContain('setquota -P 1001 0 268435456 0 0 "$data_mount"');
    expect(installed).toContain('setquota -P 1002 0 33554432 0 0 "$data_mount"');
    expect(installed.indexOf('# End admitted durable storage quotas.')).toBeLessThan(installed.indexOf('echo papercusp-bootstrap'));
  });

  it('installs exactly the durable mount + bootstrap for the attached volume and starts it as a unit', () => {
    const push = renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: BOOTSTRAP });
    // The redirections the harness rewrites must be real, or the run proves nothing.
    expect(push.commands.filter((line) => line.includes(AWS_HOST_BOOTSTRAP_STAGING_DIR)).length).toBeGreaterThan(0);
    expect(push.commands.filter((line) => line.includes('> /dev/console'))).toHaveLength(1);

    const run = runWrapper(push.commands);
    expect(run.status, run.stderr).toBe(0);
    const installed = readFileSync(join(run.staged, 'bootstrap.sh'), 'utf8');
    expect(installed).toBe(
      renderDurableFilesystemScript({
        devicePath: awsEbsNvmeDevicePath(VOLUME_ID),
        deviceWaitSec: AWS_DATA_DEVICE_WAIT_SEC,
        hostBootstrapScript: BOOTSTRAP,
      }),
    );
    expect(installed.indexOf('echo papercusp-bootstrap')).toBeGreaterThan(installed.indexOf('mount --bind'));
    expect(run.systemdRunArgs).toBe(
      `--unit=${AWS_HOST_BOOTSTRAP_UNIT} --collect --property=Type=exec /bin/bash ${join(run.staged, 'bootstrap.sh')}`,
    );
    // A previous run's report is superseded before the push returns.
    expect(parseEc2ConsoleBootstrapStatus(run.console)).toEqual({ state: 'running' });
  });

  it('refuses to start a payload whose checksum does not match', () => {
    const push = renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: BOOTSTRAP });
    const tampered = push.commands.map((line) => line.split(push.scriptSha256).join('0'.repeat(64)));
    expect(tampered).not.toEqual(push.commands);
    const run = runWrapper(tampered);
    expect(run.status).not.toBe(0);
    expect(run.systemdRunArgs).toBeNull();
    expect(existsSync(join(run.staged, 'bootstrap.sh'))).toBe(false);
    expect(run.console).toBe('');
  });

  it('leaves a bootstrap that is still running alone', () => {
    const push = renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: BOOTSTRAP });
    for (const state of ['active', 'activating']) {
      const run = runWrapper(push.commands, state);
      expect(run.status, run.stderr).toBe(0);
      expect(run.systemdRunArgs).toBeNull();
    }
  });

  it('names the data volume by its NVMe volume id, never by the attach device name', () => {
    expect(awsEbsNvmeDevicePath(VOLUME_ID)).toBe(
      '/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0',
    );
    for (const bad of ['/dev/sdf', 'vol-XYZ', 'vol-', "vol-0123abcd'; reboot"]) {
      expect(() => awsEbsNvmeDevicePath(bad)).toThrow(/aws_workspace_host_volume_id_invalid/);
    }
  });

  it('refuses a payload over the SSM ceiling with the ceiling named', () => {
    // Incompressible, so gzip cannot rescue it.
    const huge = `#!/usr/bin/env bash\n: '${randomBytes(AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES).toString('base64')}'\n`;
    expect(() => renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: huge })).toThrow(
      new RegExp(`aws_workspace_host_bootstrap_too_large: .*${AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES} bytes`),
    );
  });

  it('refuses an empty bootstrap', () => {
    expect(() => renderAwsHostBootstrapPush({ volumeId: VOLUME_ID, hostBootstrapScript: '  \n' })).toThrow(
      /aws_workspace_host_bootstrap_empty/,
    );
  });
});
