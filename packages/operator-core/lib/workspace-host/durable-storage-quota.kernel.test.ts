import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { renderDurableStorageQuotaCore, workspaceHostDurableTenantIdentity } from './aws-host-bootstrap-push-core.mjs';
import { renderDurableFilesystemScript } from './durable-filesystem-script';
import { createInstance, DEFAULT_ZONE, gcloudExec, TEST_PROJECT, teardownRun } from '../../../../scripts/agent-capacity/gcp-rails';

// No PostgreSQL dependency. Explicit privileged acceptance uses an owned sparse image in a private mount
// namespace. Ordinary unit runs never mount disks or require sudo. On this route,
// absent tooling/capabilities FAIL; they cannot turn acceptance into a skip.
it.runIf(process.env.PAPERCUSP_TEST_DURABLE_QUOTA_KERNEL === '1')(
  'enforces independent DB and shared workspace projects across an ext4 remount', () => {
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-kernel-'));
    const quotaBin = process.env.PAPERCUSP_TEST_QUOTA_BIN ?? '/usr/sbin';
    const quota = renderDurableStorageQuotaCore({ dbGiB: 1, workspaceGiB: 1 },
      workspaceHostDurableTenantIdentity('kernel-test', 'customer')).join('\n');
    try {
      const result = spawnSync('sudo', ['-n', 'unshare', '--mount', '--propagation', 'private',
        'bash', '-s', '--', root, quotaBin], {
        encoding: 'utf8', timeout: 60000,
        input: [
          'set -euo pipefail', 'export LC_ALL=C', 'export PATH="$2:/usr/sbin:/usr/bin:/sbin:/bin"',
          'for tool in setquota mkfs.ext4 tune2fs chattr lsattr findmnt fallocate setpriv; do command -v "$tool"; done',
          'data_device="$1/data.ext4"', 'data_mount="$1/mount"', 'data_probe_marker="$1/boot"',
          'mkdir "$data_mount"',
          'trap \'mountpoint -q "$data_mount" && umount "$data_mount" || true\' EXIT',
          'truncate -s 3G "$data_device"',
          'mkfs.ext4 -q -O quota,project -E quotatype=prjquota -I 256 "$data_device"',
          'data_uuid=$(blkid -p -s UUID -o value "$data_device")',
          'mount -o loop,prjquota "$data_device" "$data_mount"',
          'mkdir "$data_mount"/{postgres,repositories,transcripts,workspaces,home}',
          'data_freshly_formatted=1', quota,
          // Configure as root; write as the nonprivileged guest service/agent.
          // CAP_SYS_RESOURCE intentionally exempts a root writer from quotas.
          'chmod 0755 "$1" "$data_mount"',
          'chown 65534:65534 "$data_mount"/{postgres,repositories,transcripts,workspaces,home}',
          'tenant_write() { setpriv --reuid=65534 --regid=65534 --clear-groups fallocate "$@"; }',
          'tenant_write -l 700M "$data_mount/postgres/database"',
          'tenant_write -l 700M "$data_mount/repositories/repository"',
          'expect_edquot() {',
          '  local path="$1" error',
          '  if error=$(tenant_write -l 400M "$path" 2>&1); then echo "quota bypass: $path" >&2; exit 1; fi',
          '  [[ "$error" == *"Disk quota exceeded"* ]] || { echo "$error" >&2; exit 1; }',
          '  rm -f "$path"',
          '}',
          'expect_edquot "$data_mount/postgres/overflow"',
          'for directory in transcripts workspaces home; do expect_edquot "$data_mount/$directory/overflow"; done',
          'printf retained > "$data_mount/home/session"',
          'pin=$(sha256sum "$data_mount/.papercusp-storage-quota" | cut -d " " -f1)',
          'umount "$data_mount"',
          'mount -o loop,prjquota "$data_device" "$data_mount"',
          'data_freshly_formatted=0', quota,
          '[[ "$pin" == "$(sha256sum "$data_mount/.papercusp-storage-quota" | cut -d " " -f1)" ]]',
          '[[ "$(cat "$data_mount/home/session")" == retained ]]',
          'expect_edquot "$data_mount/postgres/overflow"',
          'for directory in transcripts workspaces home; do expect_edquot "$data_mount/$directory/overflow"; done',
          'echo KERNEL_EDQUOT_RETAINED_OK',
        ].join('\n'),
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('KERNEL_EDQUOT_RETAINED_OK');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 65000,
);

// Explicit, billed operational acceptance. The caller must first verify the programme's
// remaining budget. Reuse the maintained create/deadline/census/teardown rails, and run
// the actual full guest renderer, including its fstab, home bind and retained-volume pins.
it.runIf(process.env.PAPERCUSP_TEST_DURABLE_QUOTA_GCP === '1')(
  'retains enforced DB/workspace quotas and customer data across a real GCP reboot', async () => {
    expect(process.env.PAPERCUSP_TEST_CLOUD_BUDGET_VERIFIED, 'verify remaining programme budget before opt-in').toBe('1');
    const root = mkdtempSync(join(tmpdir(), 'durable-quota-gcp-'));
    const runId = `p537-quota-${Date.now()}`;
    const name = `cap-${runId}`;
    const evidencePath = process.env.PAPERCUSP_TEST_DURABLE_QUOTA_EVIDENCE;
    const evidence: Record<string, unknown> = { runId, name, project: TEST_PROJECT, zone: DEFAULT_ZONE };
    const saveEvidence = () => {
      if (evidencePath) writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    };
    const check = String.raw`#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
data=/var/lib/papercusp
phase="$1"
[[ ",$(findmnt -rn -M "$data" -o OPTIONS)," == *,prjquota,* ]]
[[ "$(stat -c %d:%i /home)" == "$(stat -c %d:%i "$data/home")" ]]
[[ "$(stat -c %d:%i /srv/papercusp/workspaces)" == "$(stat -c %d:%i "$data/workspaces")" ]]
if [[ "$phase" == before ]]; then
  setpriv --reuid=65534 --regid=65534 --clear-groups fallocate -l 3G "$data/postgres/database"
  setpriv --reuid=65534 --regid=65534 --clear-groups fallocate -l 3G "$data/repositories/repository"
  printf retained > "$data/home/p537-retained"
else
  [[ "$(cat "$data/home/p537-retained")" == retained ]]
  [[ "$(stat -c %s "$data/postgres/database")" == 3221225472 ]]
  [[ "$(stat -c %s "$data/repositories/repository")" == 3221225472 ]]
fi
for directory in postgres repositories transcripts workspaces home; do
  path="$data/$directory/p537-overflow"
  if [[ "$directory" == home ]]; then path="$data/home/p537-probe/p537-overflow"; fi
  [[ "$(stat -c %u:%g "$(dirname "$path")")" == 65534:65534 ]] || { echo "probe service identity not configured: $directory" >&2; exit 1; }
  if error=$(setpriv --reuid=65534 --regid=65534 --clear-groups fallocate -l 2G "$path" 2>&1); then
    echo "quota bypass: $directory" >&2; exit 1
  fi
  [[ "$error" == *"Disk quota exceeded"* ]] || { echo "$error" >&2; exit 1; }
  rm -f "$path"
done
printf '{"phase":"%s","bootId":"%s","uuid":"%s","pin":"%s","edquotDirectories":5}\n' "$phase" \
  "$(cat /proc/sys/kernel/random/boot_id)" "$(findmnt -rn -M "$data" -o UUID)" \
  "$(sha256sum "$data/.papercusp-storage-quota" | cut -d ' ' -f1)"
`;
    // The normal renderer runs again on boot. Preserve the FIRST receipt, and only
    // mark this boot ready after the actual retained-data initialization completes.
    const bootstrap = [
      "cat > /usr/local/sbin/p537-quota-check <<'P537_CHECK'", check, 'P537_CHECK',
      'chmod 0755 /usr/local/sbin/p537-quota-check',
      'proof=/var/lib/papercusp-host-bootstrap/p537-quota',
      'install -d -m 0755 "$proof"',
      // Like the real runtime bootstrap, configure the service identity on EVERY
      // boot after the renderer prepares root-owned mount directories.
      'chmod 0755 /var/lib/papercusp /var/lib/papercusp/home',
      'chown 65534:65534 /var/lib/papercusp/{postgres,repositories,transcripts,workspaces}',
      'install -d -o 65534 -g 65534 /var/lib/papercusp/home/p537-probe',
      'if [[ ! -e "$proof/before.json" ]]; then /usr/local/sbin/p537-quota-check before > "$proof/before.json"; fi',
      'cat /proc/sys/kernel/random/boot_id > "$proof/ready-boot-id"',
    ].join('\n');
    const startup = join(root, 'startup.sh');
    writeFileSync(startup, renderDurableFilesystemScript({
      allocation: { dbGiB: 4, workspaceGiB: 4 },
      tenantIdentity: workspaceHostDurableTenantIdentity('p537-gcp-proof', runId),
      dataMode: 'fresh', devicePath: '/dev/disk/by-id/google-data', deviceWaitSec: 90,
      hostBootstrapScript: bootstrap,
    }));
    const run = async (args: string[]) => {
      const result = await gcloudExec(args);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    const ssh = (command: string) => gcloudExec([
      'compute', 'ssh', name, `--project=${TEST_PROJECT}`, `--zone=${DEFAULT_ZONE}`,
      '--quiet', '--ssh-flag=-oConnectTimeout=5', '--ssh-flag=-oConnectionAttempts=1', `--command=${command}`,
    ]);
    const ready = async (previousBoot?: string) => {
      const deadline = Date.now() + 12 * 60_000;
      let last = '';
      while (Date.now() < deadline) {
        const command = 'sudo -n bash -c \'proof=/var/lib/papercusp-host-bootstrap/p537-quota; '
          + 'test "$(cat "$proof/ready-boot-id")" = "$(cat /proc/sys/kernel/random/boot_id)" && cat "$proof/before.json" && cat /proc/sys/kernel/random/boot_id\'';
        const result = await ssh(command);
        last = result.stdout + result.stderr;
        if (result.code === 0) {
          const lines = result.stdout.trim().split('\n');
          const before = JSON.parse(lines[0]) as { bootId: string; uuid: string; pin: string };
          const bootId = lines[1];
          if (!previousBoot || bootId !== previousBoot) return { before, bootId };
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      throw new Error(`GCP quota bootstrap did not become ready: ${last}`);
    };
    try {
      console.log('P537_GCP_PHASE create');
      const admitted = await createInstance({
        runId, name, machineType: 'e2-custom-2-4096', maxHours: 1, diskGb: 20,
        extraDisks: [{ type: 'pd-balanced', gb: 12, deviceName: 'data' }],
        metadataFromFile: [`startup-script=${startup}`],
      });
      evidence.admission = admitted;
      saveEvidence();
      expect(admitted.created).toBe(true);
      const first = await ready();
      evidence.before = first;
      saveEvidence();
      console.log('P537_GCP_PHASE before-reboot-quotas-verified');
      // This is a hard provider reset. Commit BOTH the fixture's first-boot witness
      // and the provider guest agent's newly created SSH/sudo files before it. A
      // lost boot-disk witness must never be regenerated and mistaken for retention.
      const flushed = await ssh('sudo -n sync');
      expect(flushed.code, flushed.stdout + flushed.stderr).toBe(0);
      await run(['compute', 'instances', 'reset', name, `--project=${TEST_PROJECT}`, `--zone=${DEFAULT_ZONE}`, '--quiet']);
      const second = await ready(first.bootId);
      evidence.reboot = second;
      saveEvidence();
      expect(second.bootId).not.toBe(first.bootId);
      expect(second.before).toEqual(first.before);
      const after = await ssh('sudo -n /usr/local/sbin/p537-quota-check after');
      expect(after.code, after.stdout + after.stderr).toBe(0);
      evidence.after = JSON.parse(after.stdout.trim());
      saveEvidence();
      expect(evidence.after).toMatchObject({ uuid: first.before.uuid, pin: first.before.pin, edquotDirectories: 5 });
      console.log('P537_GCP_PHASE reboot-and-retained-quotas-verified');
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      saveEvidence();
      throw error;
    } finally {
      evidence.teardown = await teardownRun(runId);
      saveEvidence();
      if (evidencePath) {
        expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toEqual(evidence);
      }
      rmSync(root, { recursive: true, force: true });
      expect(evidence.teardown).toMatchObject({ verified: true, remainingInstances: [], orphanDisks: [] });
      console.log('P537_GCP_PHASE teardown-verified');
    }
  }, 20 * 60_000,
);
