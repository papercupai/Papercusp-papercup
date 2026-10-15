import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT = '/var/lib/papercusp';
export const WORKSPACE_HOST_DURABLE_WORKSPACE_ROOT = '/srv/papercusp/workspaces';
export const AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES = 48 * 1024;
export const AWS_HOST_BOOTSTRAP_UNIT = 'papercusp-workspace-host-bootstrap';
export const AWS_HOST_BOOTSTRAP_STAGING_DIR = '/var/lib/papercusp-host-bootstrap';
export const AWS_DATA_DEVICE_WAIT_SEC = 300;
export const AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC = 120;

const VOLUME_ID = /^vol-[0-9a-f]{8,17}$/;

export function awsEbsNvmeDevicePathCore(volumeId) {
  if (!VOLUME_ID.test(volumeId)) throw new Error(`aws_workspace_host_volume_id_invalid: ${JSON.stringify(volumeId)}`);
  return `/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeId.replace('-', '')}`;
}

export function renderDurableFilesystemScriptCore(input) {
  if (!/^\/dev\/disk\/by-id\/[A-Za-z0-9._:-]+$/.test(input.devicePath)) {
    throw new Error(`durable data device must be a /dev/disk/by-id path, got ${JSON.stringify(input.devicePath)}`);
  }
  if (!Number.isInteger(input.deviceWaitSec) || input.deviceWaitSec < 1) {
    throw new Error(`durable data device wait must be a positive whole number of seconds, got ${input.deviceWaitSec}`);
  }
  const workspaceDataRoot = input.workspaceDataRoot ?? WORKSPACE_HOST_DURABLE_WORKSPACE_ROOT;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(workspaceDataRoot)) {
    throw new Error(`durable workspace root must be a plain absolute path, got ${JSON.stringify(workspaceDataRoot)}`);
  }
  const userScript = input.hostBootstrapScript?.trim().replace(/^#![^\n]*(?:\n|$)/, '');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `data_device='${input.devicePath}'`,
    `data_mount='${WORKSPACE_HOST_DURABLE_DATA_MOUNT_POINT}'`,
    `for attempt in $(seq 1 ${input.deviceWaitSec}); do test -b "$data_device" && break; sleep 1; done`,
    'test -b "$data_device"',
    'if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi',
    'data_uuid=$(blkid -s UUID -o value "$data_device")',
    'install -d -m 0750 "$data_mount"',
    'grep -q "^UUID=${data_uuid} " /etc/fstab || printf "UUID=%s %s ext4 defaults,nofail,discard 0 2\\n" "$data_uuid" "$data_mount" >> /etc/fstab',
    'mountpoint -q "$data_mount" || mount "$data_mount"',
    'resize2fs "$data_device"',
    'if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon -F "$data_mount"; fi',
    'install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}',
    'home_target="$(readlink -f -- /home)"',
    '[[ -n "$home_target" && -d "$home_target" && ! -L "$home_target" ]] || { echo "workspace home mount target is not a real directory: /home -> ${home_target:-unresolved}" >&2; exit 1; }',
    'if [[ ! -e "$data_mount/home" && ! -L "$data_mount/home" ]]; then',
    '  home_seed="$(mktemp -d "$data_mount/.home-seed.XXXXXX")"',
    '  cp -a "$home_target"/. "$home_seed"/',
    '  mv -T -- "$home_seed" "$data_mount/home"',
    'fi',
    '[[ -d "$data_mount/home" && ! -L "$data_mount/home" ]] || { echo "durable home is not a real directory" >&2; exit 1; }',
    'install -d -m 0755 "$home_target"',
    'grep -q " ${home_target} none bind" /etc/fstab || printf "%s %s none bind 0 0\\n" "$data_mount/home" "$home_target" >> /etc/fstab',
    'mountpoint -q "$home_target" || mount --bind "$data_mount/home" "$home_target"',
    '[[ "$(stat -c %d:%i "$home_target")" == "$(stat -c %d:%i "$data_mount/home")" ]] || { echo "workspace home is not backed by the durable directory" >&2; exit 1; }',
    `install -d -m 0711 '${workspaceDataRoot.replace(/\/[^/]+$/, '')}'`,
    `install -d '${workspaceDataRoot}'`,
    `grep -q " ${workspaceDataRoot} none bind" /etc/fstab || printf "%s ${workspaceDataRoot} none bind 0 0\\n" "$data_mount/workspaces" >> /etc/fstab`,
    `mountpoint -q '${workspaceDataRoot}' || mount --bind "$data_mount/workspaces" '${workspaceDataRoot}'`,
    ...(userScript ? ['', '# User-supplied bootstrap follows the durable mount.', userScript] : []),
    '',
  ].join('\n');
}

export function renderAwsHostBootstrapPushCore(input) {
  if (!input.hostBootstrapScript?.trim()) throw new Error('aws_workspace_host_bootstrap_empty');
  if (!/^[A-Z0-9_]+$/.test(input.statusMarker)) throw new Error('aws_workspace_host_bootstrap_status_marker_invalid');
  const unitName = input.unit ?? AWS_HOST_BOOTSTRAP_UNIT;
  const script = renderDurableFilesystemScriptCore({
    devicePath: awsEbsNvmeDevicePathCore(input.volumeId),
    deviceWaitSec: input.deviceWaitSec ?? AWS_DATA_DEVICE_WAIT_SEC,
    hostBootstrapScript: input.hostBootstrapScript,
    ...(input.workspaceDataRoot ? { workspaceDataRoot: input.workspaceDataRoot } : {}),
  });
  const scriptSha256 = createHash('sha256').update(script, 'utf8').digest('hex');
  const payload = gzipSync(Buffer.from(script, 'utf8'), { level: 9 }).toString('base64');
  if (payload.length > AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `aws_workspace_host_bootstrap_too_large: encoded payload is ${payload.length} bytes; ` +
        `the SSM push ceiling is ${AWS_HOST_BOOTSTRAP_ENCODED_PAYLOAD_MAX_BYTES} bytes`,
    );
  }
  const dir = input.stagingDir ?? AWS_HOST_BOOTSTRAP_STAGING_DIR;
  const unit = `${unitName}.service`;
  const commands = [
    'set -eu',
    'umask 077',
    `install -d -m 0700 '${dir}'`,
    `printf '%s' '${payload}' | base64 -d | gunzip > '${dir}/bootstrap.sh.partial'`,
    `printf '%s  %s\\n' '${scriptSha256}' '${dir}/bootstrap.sh.partial' | sha256sum --check --strict --quiet`,
    `mv -f '${dir}/bootstrap.sh.partial' '${dir}/bootstrap.sh'`,
    `state="$(systemctl show -p ActiveState --value '${unit}' 2>/dev/null || true)"`,
    `case "$state" in active|activating|reloading) echo "${unitName} is already $state"; exit 0;; esac`,
    `printf '%s %s\\n' '${input.statusMarker}' running > /dev/console 2>/dev/null || true`,
    `systemd-run --unit='${unitName}' --collect --property=Type=exec /bin/bash '${dir}/bootstrap.sh'`,
    `echo "started ${unitName} sha256=${scriptSha256}"`,
  ];
  return { commands, scriptSha256, encodedPayloadBytes: payload.length };
}
