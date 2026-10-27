#!/usr/bin/env tsx
/** One-shot R-11 evidence capture. Example: npx tsx scripts/r11-window-snapshot.mts T0 /absolute/output.json */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getOrgPg } from '@papercusp/db-org';
import { resolveBackfillEmbedder } from '../packages/operator-core/lib/search/embed-backfill.ts';
import { buildR11TimerSpecs, captureR11JournalBoundary, captureR11Snapshot, captureR11SystemJournalSuppression, evaluateR11Snapshots, publishR11SnapshotBytes, readR11SnapshotBytes, r11DiskAllocations, r11JournalDirectory, r11PreservationRoots, scheduleR11Timers, type R11PreparedJournals, type R11Snapshot, type R11Stage } from '../packages/operator-core/lib/search/r11-window-snapshot.ts';
import { assessAllocationDiskAdmission } from './lib/disk-reservations.mjs';
import { runGovernedTestProcess } from './lib/governed-test-process.mjs';

const [stage, path, arg3, arg4, arg5, arg6] = process.argv.slice(2);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
let recoveryRoot: string;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const load = (file: string): R11Snapshot => {
  const bytes = readR11SnapshotBytes(file, recoveryRoot);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) as R11Snapshot;
};
let exitCode = 0;
try {
  if (!path?.startsWith('/')) throw new Error('An absolute primary output path is required');
  const preservation = r11PreservationRoots(repoRoot, dirname(path));
  recoveryRoot = preservation.recoveryRoot;
  if (stage === 'reserve') {
    if ((arg3 && arg3 !== '--dry-run') || arg4 || arg5) {
      throw new Error('Usage: reserve <absolute-primary-output.json.gz> [--dry-run]');
    }
    const admission = assessAllocationDiskAdmission(r11DiskAllocations(dirname(path), preservation),
      { protectedBytes: 36 * 1024 ** 3 });
    process.stdout.write(`${JSON.stringify({ preservation, admission, lifetimeSec: 26 * 3600 })}\n`);
    if (!admission.admitted) throw new Error('R11 destinations lack aggregate disk headroom');
    if (arg3 !== '--dry-run') {
      // This shell owns every receipt for the whole window. Never reserve inside
      // command substitution: that would bind the ledger to an already-dead PID.
      const result = await runGovernedTestProcess({ namespace: 'r11-reservation-owner',
        owner: `r11-reservation-${process.pid}`, timeoutMs: 26 * 3600_000, demand: { cpuWeight: 1 } },
      // `settle`, not `resolve`: that name would shadow node:path's resolve, which the
      // spawn argv below needs to locate disk-preflight.sh.
      (_context: unknown, childEnv: NodeJS.ProcessEnv) => new Promise<{ status: number | null; signal: string | null }>((settle, reject) => {
      const child = spawn('bash', ['-c', [
        'set -eu',
        'source "$1"; shift',
        'receipts=()',
        'cleanup() { for receipt in "${receipts[@]}"; do rm -f -- "$receipt"; done; }',
        'trap cleanup EXIT; trap "exit 143" TERM; trap "exit 130" INT',
        'export PAPERCUSP_DISK_RESERVATION_TTL_SEC=93600',
        'while [ "$#" -gt 0 ]; do',
        'papercusp_require_disk_reservation "$1" "$2" "R11 frozen evidence window"',
        'receipts+=("$PAPERCUSP_DISK_RESERVATION_FILE")',
        'printf "R11_RESERVATION_RECEIPT=%s\\n" "$PAPERCUSP_DISK_RESERVATION_FILE"',
        'cat -- "$PAPERCUSP_DISK_RESERVATION_FILE"',
        'shift 2; done',
        'sleep 93600 & wait $!',
      ].join('\n'), 'r11-reserve', resolve(repoRoot, 'papercusp-desktop/bin/lib/disk-preflight.sh'),
      ...admission.devices.flatMap((device) => [device.paths[0], String(Math.ceil(device.requiredBytes / 1024 ** 3))])],
      { stdio: 'inherit', env: childEnv });
      child.once('error', reject);
      child.once('close', (status, signal) => settle({ status, signal }));
      }));
      if (result.status !== 0) throw new Error(`R11 reservation owner exited ${result.status ?? result.signal}`);
    }
  } else if (stage === 'prepare-journals') {
    if (arg3 || existsSync(path)) throw new Error('Usage: prepare-journals <absolute-new-receipt.json>');
    const sinceMs = Date.now();
    // Two hours for setup, then the complete 24-hour window. Actual T1 is
    // frozen later from the database T0, without replacing these producers.
    const specs = buildR11TimerSpecs({ stage: 'T0', capturedAt: new Date(sinceMs + 2 * 3600_000).toISOString() } as R11Snapshot);
    const journalDirectory = r11JournalDirectory(dirname(path), preservation.journalRoot);
    mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const timers = await scheduleR11Timers(specs, { t0: path, cut: path, t1: path },
      { repoRoot, tsx: resolve(repoRoot, 'node_modules/.bin/tsx'), script: fileURLToPath(import.meta.url),
        journalDirectory, ...preservation, journalPreparation: true, journalSinceMs: sinceMs });
    const receipt: R11PreparedJournals = { specs, sinceMs, captures: timers.filter(({ kind }) => kind === 'journal')
      .map(({ unit, path, show }) => ({ unit, path: path!, show: show! })) };
    const bytes = Buffer.from(JSON.stringify(receipt));
    const recoveryPath = publishR11SnapshotBytes(path, bytes, recoveryRoot);
    process.stdout.write(`${JSON.stringify({ path, recoveryPath, sha256: sha256(bytes), receipt, timers })}\n`);
  } else if (stage === 'schedule') {
    if (!path || !arg3 || !arg4 || ![path, arg3, arg4].every((file) => file.startsWith('/')) ||
        !arg3.endsWith('.json.gz') || !arg4.endsWith('.json.gz') ||
        new Set([path, arg3, arg4]).size !== 3 || !arg5?.startsWith('/') || (arg6 && arg6 !== '--dry-run')) {
      throw new Error('Usage: schedule <absolute-T0.json.gz> <absolute-Tcut.json.gz> <absolute-T1.json.gz> <prepared-journals.json> [--dry-run]');
    }
    const t0 = load(path);
    const specs = buildR11TimerSpecs(t0);
    if (Date.parse(t0.capturedAt) > Date.now() + 60_000 ||
        Date.parse(t0.capturedAt) + (24 * 60 - 10) * 60_000 <= Date.now() + 60_000) {
      throw new Error('T0 is in the future or the Tcut deadline is too close to arm safely');
    }
    if (!existsSync(resolve(repoRoot, 'apps/operator/.env.local')) ||
        !existsSync(resolve(repoRoot, 'node_modules/.bin/tsx')) ||
        existsSync(arg3) || existsSync(arg4)) {
      throw new Error('Capture runtime is missing or a frozen output path already exists');
    }
    const script = fileURLToPath(import.meta.url);
    const tsx = resolve(repoRoot, 'node_modules/.bin/tsx');
    const journalDirectory = r11JournalDirectory(dirname(path), preservation.journalRoot);
    const preparedJournals = JSON.parse(readR11SnapshotBytes(arg5, recoveryRoot).toString('utf8')) as R11PreparedJournals;
    if (arg6 !== '--dry-run') mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
    const timers = await scheduleR11Timers(specs, { t0: path, cut: arg3, t1: arg4 },
      { repoRoot, tsx, script, journalDirectory, ...preservation, preparedJournals, t0At: t0.capturedAt, preparedJournalsPath: arg5 }, arg6 === '--dry-run');
    const t0Bytes = readR11SnapshotBytes(path, recoveryRoot);
    process.stdout.write(`${JSON.stringify({ t0: { path, capturedAt: t0.capturedAt,
      bytes: t0Bytes.length, sha256: sha256(t0Bytes) }, timers, dryRun: arg6 === '--dry-run' })}\n`);
  } else if (stage === 'evaluate') {
    if (!path || !arg3 || !arg4) throw new Error('Usage: evaluate <T0.json.gz> <Tcut.json.gz> <T1.json.gz>');
    const t0 = load(path);
    const cut = load(arg3);
    const t1 = load(arg4);
    process.stdout.write(`${JSON.stringify(evaluateR11Snapshots(t0, cut, t1))}\n`);
  } else {
    if (!['preflight', 'T0', 'Tcut', 'T1'].includes(stage ?? '') || !path?.startsWith('/')) {
      throw new Error('Usage: <preflight|T0|Tcut|T1> <absolute-output.json>');
    }
    if (stage === 'T1') {
      if (!arg3 || !arg4 || !arg5) throw new Error('T1 requires T0, Tcut and prepared journal receipt');
      const t0 = load(arg3);
      const prepared = JSON.parse(readR11SnapshotBytes(arg5, recoveryRoot).toString('utf8')) as R11PreparedJournals;
      const proof = await captureR11JournalBoundary(prepared, t0.capturedAt,
        buildR11TimerSpecs(t0)[1].at);
      publishR11SnapshotBytes(`${path}.journal-boundary.json`, Buffer.from(JSON.stringify(proof)), recoveryRoot);
    }
    const resolved = await resolveBackfillEmbedder();
    if (!('profile' in resolved)) throw new Error(`Cannot capture R-11 with embedder ${resolved.mode}`);
    if (stage === 'Tcut' && !arg3) throw new Error('Tcut requires <T0.json.gz>');
    if (stage === 'T1' && (!arg3 || !arg4)) throw new Error('T1 requires <T0.json.gz> <Tcut.json.gz>');
    const prior = stage === 'Tcut' ? { t0: load(arg3!) } : stage === 'T1'
      ? { t0: load(arg3!), cut: load(arg4!) } : {};
    const snapshot = await captureR11Snapshot(getOrgPg().sql, stage as R11Stage, resolved, prior);
    if (stage === 'T1') {
      const t0 = load(arg3!);
      snapshot.systemJournalSuppression = await captureR11SystemJournalSuppression(t0.capturedAt, snapshot.capturedAt);
    }
    const data = JSON.stringify(snapshot);
    const bytes = path.endsWith('.gz') ? gzipSync(data) : Buffer.from(data);
    const recoveryPath = publishR11SnapshotBytes(path, bytes, recoveryRoot);
    process.stdout.write(`${JSON.stringify({ stage, path, capturedAt: snapshot.capturedAt,
      recoveryPath, targetCount: snapshot.targets.length, bytes: bytes.length, uncompressedBytes: Buffer.byteLength(data), sha256: sha256(bytes),
      systemJournalSuppression: snapshot.systemJournalSuppression && {
        status: snapshot.systemJournalSuppression.status,
        noticeCount: snapshot.systemJournalSuppression.notices.length,
        error: snapshot.systemJournalSuppression.error,
      },
      staleByTarget: snapshot.targets.map((target) => ({ table: target.table,
        stale: target.rows.filter((row) => row.stale).length })) })}\n`);
  }
} catch (err) {
  process.stderr.write(`r11-window-snapshot: ${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 2;
} finally {
  if (['preflight', 'T0', 'Tcut', 'T1'].includes(stage ?? '')) {
    await getOrgPg().sql.end({ timeout: 5 }).catch(() => {});
  }
}
process.exitCode = exitCode;
