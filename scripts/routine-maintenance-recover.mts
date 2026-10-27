/** Standalone recovery/guardian. Run in a separately qualified scope outside
 * bg-host. No HTTP endpoint or automatic database discovery is used.
 * --check-runtime is read-only. --manifest FILE [--watch] seals and restores
 * exactly one operation, immediately or at the manifest's absolute deadline.
 * The publisher must retain the emitted receipt and own any unresolved residue. */
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = [
  'scripts/routine-maintenance-recover.mts',
  'packages/operator-core/lib/agent-tools/routines/maintenance.ts',
  'packages/operator-core/lib/agent-tools/routines/maintenance-pg.ts',
  'packages/operator-core/lib/agent-tools/routines/revert.ts',
  'packages/operator-core/lib/agent-tools/routines/routine-snapshot.ts',
  'packages/operator-core/lib/gateway-control/control-harness.ts',
  'libs/generic/control-mutation/src/index.ts',
];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
const runtime = {
  cgroup, cgroupSha256: digest(cgroup),
  sourceSha256: Object.fromEntries(sourcePaths.map(path => [path, digest(readFileSync(resolve(root, path)))])),
};
if (process.argv.includes('--check-runtime')) {
  process.stdout.write(JSON.stringify({ ...runtime, executionReady: false, note: 'Source census only; qualify scope, runtime import closure and cleanup before execution.' }) + '\n');
} else {
  const manifestPath = process.argv[process.argv.indexOf('--manifest') + 1];
  if (!process.argv.includes('--manifest') || !manifestPath) throw new Error('Requires --manifest FILE or --check-runtime');
  const manifest = JSON.parse(readFileSync(realpathSync(manifestPath), 'utf8'));
  if (manifest.schemaVersion !== 'routine-maintenance-recovery-v1' ||
      !/^[0-9a-f-]{36}$/i.test(manifest.operationId) || !manifest.ownerId || !manifest.workspaceId ||
      !Number.isSafeInteger(manifest.timeoutMs) || manifest.timeoutMs <= 0 || manifest.timeoutMs > 600_000 ||
      !Number.isSafeInteger(manifest.deadlineMs) || manifest.cgroupSha256 !== runtime.cgroupSha256 ||
      /bg-host/i.test(cgroup) || sourcePaths.some(path => manifest.sourceSha256?.[path] !== runtime.sourceSha256[path]))
    throw new Error('Recovery manifest/runtime qualification mismatch');
  const dsn = process.env.PAPERCUSP_MAINTENANCE_DATABASE_URL;
  if (!dsn) throw new Error('Explicit PAPERCUSP_MAINTENANCE_DATABASE_URL is required; no database discovery');
  const { default: postgres } = await import('postgres');
  const { maintenancePgStore } = await import('../packages/operator-core/lib/agent-tools/routines/maintenance-pg.ts');
  const { recoverRoutineMaintenance } = await import('../packages/operator-core/lib/agent-tools/routines/maintenance.ts');
  const sql = postgres(dsn, { max: 2, prepare: false, connect_timeout: 5,
    connection: { statement_timeout: 5_000, application_name: 'routine-maintenance-recovery' } });
  try {
    // Reachability is checked before the guardian announces it is armed.
    await sql`SELECT 1`;
    if (process.argv.includes('--watch') && Date.now() < manifest.deadlineMs) {
      if (manifest.deadlineMs - Date.now() > 3_600_000) throw new Error('Guardian deadline exceeds one hour');
      process.stdout.write(JSON.stringify({ armed: true, operationId: manifest.operationId, deadlineMs: manifest.deadlineMs, cgroupSha256: runtime.cgroupSha256 }) + '\n');
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); process.off('SIGINT', finish); process.off('SIGTERM', finish); done(); };
        const timer = setTimeout(finish, Math.max(1, manifest.deadlineMs - Date.now()));
        process.once('SIGINT', finish); process.once('SIGTERM', finish);
      });
    }
    const result = await recoverRoutineMaintenance(
      maintenancePgStore(sql, manifest.workspaceId, manifest.ownerId), manifest.operationId, manifest.timeoutMs,
    );
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } finally { await sql.end({ timeout: 5 }); }
}
