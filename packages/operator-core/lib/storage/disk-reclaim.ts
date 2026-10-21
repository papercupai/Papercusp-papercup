/** Scheduled policy retention (disk-headroom P-004, D-002/D-005).
 * Reuses the policy selector, native process-holder scan and filesystem mutex.
 * The caller returns this receipt from a DBOS step: operation_outputs is the
 * existing Postgres receipt ledger. Free space is an alarm threshold, never a
 * reason to retain expired artifacts. Existing class owners remain delegates.
 */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import type { ReclaimPhaseTiming } from '../release-cut-reclaim';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { openWriterPidsMany, type OpenWriterScan } from '../native-bg-task-ledger';
import { readRegistry } from '../workspace-registry';
import { mapWithConcurrency } from '../gym/concurrency';
import { sampleDiskSnapshots, type DiskSnapshot } from './disk-space-alarm';
import { RetentionAllocationCounter, type RetentionHardlink, type RetentionCensusTiming } from './disk-consumer-census';
import {
  retentionPolicyForWorkspaceRoot, compilePolicy, containsClassRoot, deletionClassFor,
  retentionRootSizeCap, buildDirsEligible, isBuildDirName, BUILD_DIR_NAMES, CACHEDIR_TAG_SIGNATURE,
  type CompiledPolicy, type RetentionClass, type RetentionPinProtection,
} from './retention-policy';

export const DISK_RECLAIM_STEP = 'disk-retention-reclaim';
export const DISK_RECLAIM_CRONTAB = '0 12 * * * *';
export const DISK_HEADROOM_BYTES = 100 * 1024 ** 3;
export const DEFAULT_RECLAIM_RUN_BUDGET_MS = 15 * 60_000;
/** Keep later scheduled passes inside the deadline established by the first
 * persisted receipt. The first pass uses the normal run budget. */
export function reclaimRunBudgetForDrain(notAfterMs: number | undefined, nowMs = Date.now()): number | undefined {
  if (notAfterMs === undefined) return undefined;
  return Math.max(1, Math.min(DEFAULT_RECLAIM_RUN_BUDGET_MS, notAfterMs - nowMs));
}
const HOUR = 3_600_000;
const EFFECT_BUDGET_SUFFIX = ': effect budget exhausted; resume with a fresh policy census';
const effectBudgetError = (root: string) => `incomplete retention effects:${root}${EFFECT_BUDGET_SUFFIX}`;
const sizeCapError = (root: string, overByBytes: number) => `size cap remains exceeded:${root}:${overByBytes}`;

export interface RetentionEntry {
  path: string; root: string; classId: string;
  newestWriteMs: number; bytes: number; dev: number; ino: number;
  hardlinks?: RetentionHardlink[];
  /** Ownership is revalidated by the native regular-file lease proof. */
  uid?: number; gid?: number;
  protectedReason?: string;
  buildDirs?: Array<{ path: string; dev: number; ino: number }>;
  /** Reclaim only rebuildable descendants; the source entry stays. */
  buildOnly?: boolean;
}
interface BuildRemovalResult { removed: Array<{ path: string; bytes: number }>; }
export interface RetentionFileLease { release: () => Promise<void>; }
export interface ReclaimDelegate {
  classId: string;
  run: (dryRun: boolean, onPhase?: (event: ReclaimPhaseTiming) => void, notAfterMs?: number) => Promise<{ ok: boolean; detail: unknown }>;
}
export interface RetentionCapReceipt {
  root: string; classId: string; maxBytes: number; beforeBytes: number;
  pinnedBytes: number; pinnedPaths: string[]; afterBytes: number;
  overByBytes: number; pinnedOverageBytes: number;
}
/** Offsets from one enrolled command's start, including terminal persistence.
 * Child exit and launch bookkeeping can finish in either order. */
export interface NativeRetentionTiming {
  taskId: string | null;
  totalMs: number;
  spawnedAfterMs: number | null;
  childClosedAfterMs: number | null;
  launchReturnedAfterMs: number | null;
  completedAfterMs: number | null;
  /** Additive receipt fields: absent on older retained timing records. */
  timeoutMs?: number;
  settledBy?: 'close' | 'timeout' | 'child-error' | 'input-error' | 'launch-error' | null;
  settledAfterMs?: number | null;
  cleanupStartedAfterMs?: number | null;
  cleanupFinishedAfterMs?: number | null;
  cleanupResult?: { ok: boolean; error?: string } | null;
  stages: Array<{ name: string; elapsedMs: number }>;
}
export interface DiskReclaimReceipt {
  schemaVersion: 1; id: string; startedAt: string; finishedAt: string; dryRun: boolean;
  /** Native machine identity; legacy hostless receipts cannot certify a host soak. */
  host?: string;
  complete: boolean;
  /** Unknown for partial runs; a successful run drained every unprotected selected entry. */
  policyExhausted: boolean | null;
  devices: Array<{ path: string; beforeFreeBytes: number | null; afterFreeBytes: number | null; atTarget: boolean | null }>;
  entries: Array<{ path: string; classId: string; status: 'removed' | 'would-remove' | 'protected' | 'changed' | 'failed'; bytes: number; reason?: string; nativeCommand?: NativeRetentionTiming }>;
  delegates: Array<{ classId: string; ok: boolean; detail: unknown; elapsedMs?: number;
    phases?: Array<ReclaimPhaseTiming & { observedAfterMs: number }>; omittedPhases?: number }>;
  errors: string[];
  caps?: RetentionCapReceipt[];
  /** Physical roots actually enforced; aliases share identity, selection and holder evidence. */
  roots?: Array<{ path: string; classId: string; aliases: string[] }>;
  scan?: { inspectedNodes: number; retainedRecentTrees: number; stoppedAtRoot: string | null; incompleteRoots?: string[] };
  /** One scalar observation per initial root census; never persist its inventory. */
  censuses?: Array<{ root: string; classId: string; elapsedMs: number; inspectedNodes: number;
    timing?: RetentionCensusTiming; error?: string }>;
  effects?: Array<{
    root: string; selected: number; processed: number; remaining: number;
    nextPath: string | null; elapsedMs: number; stopped: boolean;
    /** Measured effect phases, including failed/incomplete checks. Initial
     * policy census and delegates are outside these counters. New counters are
     * optional when reading receipts written before their introduction. */
    timings?: { initialHolderScanMs: number; freshHolderScanMs: number; reinspectionMs: number; removalMs: number; removalAuditMs: number;
      progressRecordMs?: number; yieldWaitMs?: number; leaseReleaseMs?: number };
  }>;
}
export interface DiskReclaimOptions {
  dryRun?: boolean; home?: string; policy?: readonly RetentionClass[];
  /** Reuse the last durable local receipt to give roots after a blocked census
   * the first turn next time. Selection and all safety evidence remain fresh. */
  previousReceipt?: DiskReclaimReceipt | null;
  /** Dependency seams also permit an isolated fixture tree; production uses the policy roots. */
  roots?: Array<{ path: string; classId: string }>;
  /** Inspection bounds apply independently to each policy root; an incomplete root cannot starve another. */
  nowMs?: number; maxEntries?: number; budgetMs?: number;
  /** Per-root wall time for holder checks, audit waits and removals. In-flight operations finish safely. */
  effectBudgetMs?: number;
  /** Whole-pass deadline, including all roots and delegates. */
  runBudgetMs?: number;
  /** Scheduled drains checkpoint productive partial roots before inspecting
   * another root. Standalone passes retain their independent-root fairness. */
  yieldAfterProductiveEffects?: boolean;
  sample?: () => Promise<DiskSnapshot[]>;
  scanHolders?: (paths: readonly string[]) => Promise<OpenWriterScan>;
  registeredWorkspaces?: () => string[];
  delegates?: readonly ReclaimDelegate[];
  /** Additional leases are resolved by the runtime before this planner runs. */
  protectedPaths?: readonly string[];
  /** Resolve leases after acquiring the reclaim mutex, shared with pin mutations. */
  readProtection?: () => Promise<{ paths: readonly string[]; pins?: readonly RetentionPinProtection[] }>;
  expectedDevices?: readonly string[];
  /** Production writes to audit_log before an effect and after the completed pass. */
  record?: (phase: string, details: unknown) => Promise<void>;
  /** Production reuses the streaming native census for complete max-age trees. */
  inspectTrees?: typeof import('./disk-consumer-census').inspectRetentionTrees;
  /** Production supplies an enrolled privileged remover. Only policy-selected,
   * remeasured agent children reach it, after fresh host holder evidence. */
  removeEntry?: (entry: RetentionEntry, timeoutMs: number, observeTiming?: (timing: NativeRetentionTiming) => void, dryRun?: boolean) => Promise<void | BuildRemovalResult>;
  /** Explicit native proof for regular-file effects. The returned lease is held
   * across the effect and released in the effect finally block. Directories
   * never use this seam and retain their complete host holder scan. */
  acquireRegularFileLease?: (entry: RetentionEntry, timeoutMs: number) => Promise<RetentionFileLease>;
}

/** The workflow checkpoints each callback separately. Only safe, productive
 * effect-budget stops continue; another pass rebuilds all eligibility evidence.
 * The deadline comes from persisted receipt time, so recovery cannot reset it.
 * A callback must return null before starting a pass whose deadline has elapsed.
 */
export async function drainScheduledDiskReclaim(
  runBatch: (batch: number, notAfterMs: number | undefined) => Promise<DiskReclaimReceipt | null>,
  limits: { maxBatches?: number; maxElapsedMs?: number } = {},
): Promise<{ batches: number; lastReceiptId: string | null; stop: 'complete' | 'dry-run' | 'error' | 'no-progress' | 'batch-limit' | 'time-limit' }> {
  const maxBatches = limits.maxBatches ?? 12;
  const maxElapsedMs = limits.maxElapsedMs ?? 15 * 60_000;
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || !Number.isFinite(maxElapsedMs) || maxElapsedMs <= 0) {
    throw new Error('invalid retention drain bounds');
  }
  let notAfterMs: number | undefined;
  let lastReceiptId: string | null = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    const receipt = await runBatch(batch, notAfterMs);
    const result = { batches: batch + (receipt ? 1 : 0), lastReceiptId: receipt?.id ?? lastReceiptId };
    if (!receipt) return { ...result, stop: 'time-limit' };
    lastReceiptId = receipt.id;
    if (receipt.dryRun) return { ...result, stop: 'dry-run' };
    if (receipt.complete) return { ...result, stop: 'complete' };
    const started = Date.parse(receipt.startedAt), finished = Date.parse(receipt.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) return { ...result, stop: 'error' };
    notAfterMs ??= started + maxElapsedMs;
    const budgetErrors = new Set(receipt.effects?.filter((effect) => effect.stopped && effect.remaining > 0)
      .map((effect) => effectBudgetError(effect.root)));
    // A budget-stopped capped root reports its measured remaining overage too.
    // Resume only that exact companion error; permanent or unrelated cap
    // failures still stop, and the original deadline and safety checks apply.
    for (const cap of receipt.caps ?? []) {
      if (budgetErrors.has(effectBudgetError(cap.root)) && cap.overByBytes > cap.pinnedOverageBytes) {
        budgetErrors.add(sizeCapError(cap.root, cap.overByBytes));
      }
    }
    if (!receipt.errors.length || receipt.errors.some((error) => !budgetErrors.has(error)) ||
        receipt.delegates.some((delegate) => !delegate.ok) || receipt.entries.some((entry) => entry.status === 'failed')) {
      return { ...result, stop: 'error' };
    }
    if (!receipt.entries.some((entry) => entry.status === 'removed')) return { ...result, stop: 'no-progress' };
    if (finished >= notAfterMs) return { ...result, stop: 'time-limit' };
  }
  return { batches: maxBatches, lastReceiptId, stop: 'batch-limit' };
}

export type ReclaimSql = Pick<import('postgres').Sql, 'unsafe'>;
/** Read an exact receipt, or the latest real pass, from the existing workspace audit ledger.
 * Expected readbacks compare JSON values: JSONB may reorder object keys, while
 * changed values, missing records and reordered arrays must still fail closed.
 */
export async function readReclaimReceipt(sql: ReclaimSql, workspaceId: string, id?: string, expected?: DiskReclaimReceipt,
  options: { requireScan?: boolean } = {}): Promise<DiskReclaimReceipt | null> {
  const rows = await sql.unsafe(
    `SELECT details FROM harness_shared.audit_log
      WHERE workspace_id = $1 AND action = 'disk-retention:receipt'
        AND jsonb_typeof(details) = 'object' AND details->>'schemaVersion' = '1'
        AND details->>'id' = subject
        ${options.requireScan ? "AND jsonb_typeof(details->'scan') = 'object'" : ''}
        ${id ? 'AND subject = $2' : "AND details->>'dryRun' = 'false'"}
      ORDER BY ts DESC, id DESC LIMIT 1`,
    id ? [workspaceId, id] : [workspaceId],
  ) as Array<{ details: DiskReclaimReceipt }>;
  const receipt = rows[0]?.details ?? null;
  if (expected && !isDeepStrictEqual(receipt, expected)) throw new Error(`exact receipt readback mismatch ${expected.id}`);
  return receipt;
}
export function reclaimReceiptHref(id: string): string {
  return `/settings/storage?reclaim=${encodeURIComponent(id)}`;
}
/** Reuse audit_log; no separate receipt table or retention subsystem. */
export async function writeReclaimAudit(sql: ReclaimSql, workspaceId: string, runId: string, phase: string, details: unknown): Promise<void> {
  await sql.unsafe(
    // Bind serialized JSON as text; a jsonb-typed postgres.js parameter would
    // serialize the string again and store a JSON string instead of an object.
    'INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb,$7)',
    [randomUUID(), Date.now(), 'system:disk-retention', `disk-retention:${phase}`, runId, JSON.stringify(details), workspaceId],
  );
}

const RETENTION_HOLDER_SCAN_MS = 30_000;
const incompleteHolders = (reason: string, diagnostics: OpenWriterScan['diagnostics'] = {}): OpenWriterScan => ({
  complete: false, byPath: new Map(), diagnostics: { ...diagnostics, reason },
});

/** The existing async scanner needs host-wide read access before it can prove absence. */
export async function scanRetentionHolders(paths: readonly string[], deps: {
  readStatus?: () => Promise<string>;
  uid?: () => number;
  scan?: typeof openWriterPidsMany;
  privileged?: (paths: readonly string[], control: string) => Promise<OpenWriterScan>;
  /** Reuse the isolated worker even when the host itself runs as root. */
  isolate?: boolean;
  includeProcessLinks?: boolean;
} = {}): Promise<OpenWriterScan> {
  const status = await (deps.readStatus ?? (() => readFile('/proc/self/status', 'utf8')))().catch(() => '');
  const ids = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  // A nested PID namespace cannot prove a host tree unused.
  if (!ids || ids.length !== 1) return incompleteHolders('host PID namespace control unavailable');
  const control = process.cwd();
  const wanted = [...new Set([...paths, control])];
  const scan = (deps.uid ?? (() => process.getuid?.() ?? -1))() === 0 && !deps.isolate
    ? await (deps.scan ?? openWriterPidsMany)(wanted, {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: RETENTION_HOLDER_SCAN_MS,
      ...(deps.includeProcessLinks ? { includeProcessLinks: true } : {}),
    })
    : await (deps.privileged ?? ((paths, control) => scanPrivilegedRetentionHolders(paths, control, deps.includeProcessLinks)))(wanted, control)
      .catch((err) => incompleteHolders(`privileged holder scan failed: ${message(err)}`));
  if (!scan.byPath.get(control)?.includes(String(process.pid))) {
    scan.complete = false;
    scan.diagnostics = { ...scan.diagnostics, reason: [scan.diagnostics?.reason, 'original caller PID control missing'].filter(Boolean).join('; ') };
  }
  return scan;
}

async function scanPrivilegedRetentionHolders(paths: readonly string[], control: string, includeProcessLinks = false): Promise<OpenWriterScan> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const require = createRequire(join(repoRoot, 'package.json'));
  // Reuse the scanner from canonical source; the elevated child only reads /proc.
  // Both namespaces and the ORIGINAL caller's PID are positive controls.
  const worker = `
    import { readFile } from 'node:fs/promises';
    import { readdirSync, readlinkSync } from 'node:fs';
    const input = [];
    for await (const chunk of process.stdin) input.push(chunk);
    const paths = JSON.parse(Buffer.concat(input).toString('utf8'));
    const status = await readFile('/proc/self/status', 'utf8');
    const ids = /^NSpid:\\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\\s+/);
    if (!ids || ids.length !== 1) process.exit(2);
    const { openWriterPidsMany } = await import(process.argv[1]);
    const result = await openWriterPidsMany(paths, {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: ${RETENTION_HOLDER_SCAN_MS},
      includeProcessLinks: ${includeProcessLinks},
      // This process is an enrolled, isolated worker, never the operator loop.
      procIo: { readdir: (path) => readdirSync(path), readlink: (path) => readlinkSync(path) },
    });
    process.stdout.write(JSON.stringify({ complete: result.complete, byPath: [...result.byPath], diagnostics: result.diagnostics }));
  `;
  const result = await nativeRetentionCommand(repoRoot, '/usr/bin/sudo', [
    '-n', process.execPath, '--import', require.resolve('tsx/esm'), '--input-type=module', '-e', worker,
    '--', join(repoRoot, 'packages/operator-core/lib/native-bg-task-ledger.ts'),
  ], { stdin: JSON.stringify(paths), stdoutOnly: true, outputLimit: 1024 * 1024, timeoutMs: RETENTION_HOLDER_SCAN_MS + 1_000 });
  if (!result.ok || !result.detail || typeof result.detail !== 'object' ||
      !('output' in result.detail) || typeof result.detail.output !== 'string') {
    const detail = result.detail as { error?: string; code?: number | null; signal?: string | null; taskId?: string | null; stderr?: string; outputTruncated?: boolean } | null;
    return incompleteHolders(detail?.error ?? 'privileged holder transport failed', {
      taskId: detail?.taskId, exitCode: detail?.code, signal: detail?.signal,
      stderr: detail?.stderr, outputTruncated: detail?.outputTruncated,
    });
  }
  try {
    const parsed: unknown = JSON.parse(result.detail.output);
    if (!parsed || typeof parsed !== 'object' || !('complete' in parsed) || typeof parsed.complete !== 'boolean' ||
        !('byPath' in parsed) || !Array.isArray(parsed.byPath)) return incompleteHolders('invalid privileged holder result');
    const byPath = new Map<string, string[]>();
    for (const row of parsed.byPath) {
      if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !paths.includes(row[0]) ||
          !Array.isArray(row[1]) || !row[1].every((pid: unknown) => typeof pid === 'string' && /^\d+$/.test(pid))) return incompleteHolders('invalid privileged holder path/PID evidence');
      byPath.set(row[0], row[1]);
    }
    let diagnostics: OpenWriterScan['diagnostics'];
    if ('diagnostics' in parsed && parsed.diagnostics !== undefined) {
      const raw = parsed.diagnostics;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return incompleteHolders('invalid privileged scan diagnostics');
      diagnostics = {};
      for (const key of ['elapsedMs', 'processesTotal', 'processesScanned', 'descriptorsScanned', 'readFailures'] as const) {
        if (key in raw) {
          const value = (raw as Record<string, unknown>)[key];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return incompleteHolders('invalid privileged scan metrics');
          diagnostics[key] = value;
        }
      }
      if ('deadlineExceeded' in raw) {
        if (typeof raw.deadlineExceeded !== 'boolean') return incompleteHolders('invalid privileged deadline evidence');
        diagnostics.deadlineExceeded = raw.deadlineExceeded;
      }
      if ('reason' in raw && typeof raw.reason === 'string') diagnostics.reason = raw.reason.slice(0, 1000);
      if ('failureSamples' in raw) {
        if (!Array.isArray(raw.failureSamples) || raw.failureSamples.length > 8) return incompleteHolders('invalid privileged failure samples');
        diagnostics.failureSamples = [];
        for (const sample of raw.failureSamples) {
          if (!sample || typeof sample !== 'object' || typeof sample.operation !== 'string' ||
              typeof sample.path !== 'string' || typeof sample.code !== 'string') return incompleteHolders('invalid privileged failure sample');
          diagnostics.failureSamples.push({ operation: sample.operation.slice(0, 100), path: sample.path.slice(0, 4096), code: sample.code.slice(0, 100) });
        }
      }
    }
    return { complete: parsed.complete && byPath.get(control)?.includes(String(process.pid)) === true, byPath,
      ...(diagnostics ? { diagnostics } : {}) };
  } catch { return incompleteHolders('privileged holder JSON could not be decoded'); }
}

/** One enrolled, read-only worker per pass. Only its programs are reused:
 * every request creates fresh full FD/cwd iterators. Bulk census and unsupported
 * candidates retain the existing full proc scanner; no absence is cached.
 */
export function createRetentionHolderScanner(deps: {
  fallback?: typeof scanRetentionHolders;
} = {}) {
  let child: ChildProcess | undefined, starting: Promise<ChildProcess> | undefined;
  let ended = false, closed = false, buffer = '', stderr = '';
  let pending: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let activeLeaseToken: string | undefined;
  let serial = Promise.resolve();
  const fail = (reason: string) => {
    ended = true;
    const request = pending; pending = undefined;
    request?.reject(new Error(reason));
    child?.stdin?.end();
  };
  const start = () => starting ??= new Promise<ChildProcess>((resolveChild, rejectChild) => {
    const timer = setTimeout(() => { fail('holder worker startup deadline'); rejectChild(new Error('holder worker startup deadline')); }, RETENTION_HOLDER_SCAN_MS);
    const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const worker = join(repoRoot, 'packages/operator-core/lib/storage/disk-reclaim-holder-worker.py');
    void import('../task-manager/managed-spawn').then(({ managedSpawn }) => managedSpawn('/usr/bin/sudo', ['-n', '/usr/bin/python3', worker], {
      class: 'other', title: 'scheduled disk retention holder scanner',
      argv: ['/usr/bin/sudo', '-n', '/usr/bin/python3', worker], launchedBy: 'system:disk-retention',
      planSlug: 'disk-headroom-standing-reclaim-2026-10-12', runtimeMaxSec: 1800,
      detail: { subsystem: 'storage', operation: 'retention-holder-scan' },
    }, {
      requireRegistration: true,
      spawnOptions: { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] },
      onSpawn: (spawned) => {
        clearTimeout(timer);
        child = spawned;
        spawned.once('error', (error) => fail(message(error)));
        spawned.once('close', () => fail('holder worker closed'));
        spawned.stdin?.on('error', (error) => fail(message(error)));
        spawned.stderr?.setEncoding('utf8');
        spawned.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
        spawned.stdout?.setEncoding('utf8');
        spawned.stdout?.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1024 * 1024) { fail('holder response overflow'); spawned.kill('SIGKILL'); return; }
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const request = pending; pending = undefined;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!request || buffer.length) { request?.reject(new Error('unsolicited holder response')); fail('unsolicited holder response'); return; }
          request.resolve(line);
        });
        if (!spawned.stdin || !spawned.stdout || !spawned.stderr || closed || ended) {
          fail('holder worker pipes unavailable'); spawned.kill('SIGKILL'); rejectChild(new Error('holder worker unavailable')); return;
        }
        resolveChild(spawned);
      },
    })).catch((error) => { clearTimeout(timer); fail(message(error)); rejectChild(error); });
  });
  const kernel = async (paths: readonly string[], control: string): Promise<OpenWriterScan> => {
    if (ended || closed || paths.length === 0 || paths.length > 16) return incompleteHolders('kernel holder route unavailable');
    // Bind aliases may name the same physical candidate. Never run a sequence
    // of kernel scans for a bulk census or treat its earlier scans as fresh.
    const identities = await Promise.all(paths.map((path) => lstat(path)));
    const identity = identities[0]!;
    if (!identities.every((s) => (s.isFile() || s.isDirectory()) && s.dev === identity.dev && s.ino === identity.ino)) {
      return incompleteHolders('bulk holder census requires proc scanner');
    }
    const spawned = await start();
    if (ended || closed) return incompleteHolders('kernel holder worker ended');
    const line = await requestWorker(spawned, { path: paths[0], caller: process.pid, control }, RETENTION_HOLDER_SCAN_MS);
    const result = JSON.parse(line), d = result?.diagnostics;
    if (result?.complete !== true || !d || d.fdEnd !== 1 || d.cwdEnd !== 1 || d.readFailures !== 0 ||
        d.identityStable !== true || ![d.callerSeen, d.descriptorsScanned, d.processesScanned].every((n) => Number.isSafeInteger(n) && n > 0) ||
        !Number.isFinite(d.elapsedMs) || d.elapsedMs < 0 || !Array.isArray(result.byPath)) {
      return incompleteHolders('kernel holder evidence incomplete', { stderr });
    }
    if (result.byPath.length > 1 || result.byPath.some((row: unknown) => !Array.isArray(row) || row.length !== 2 ||
        row[0] !== paths[0] || !Array.isArray(row[1]) || !row[1].every((pid: unknown) => typeof pid === 'string' && /^[1-9]\d*$/.test(pid)))) {
      return incompleteHolders('invalid kernel holder identities');
    }
    const after = await Promise.all(paths.map((path) => lstat(path)));
    if (!after.every((s, i) => s.dev === identities[i]!.dev && s.ino === identities[i]!.ino && s.mode === identities[i]!.mode)) {
      return incompleteHolders('kernel holder alias identity changed');
    }
    const pids: string[] = result.byPath[0]?.[1] ?? [];
    return { complete: true, byPath: new Map([[control, [String(process.pid)]], ...paths.filter(() => pids.length).map((path): [string, string[]] => [path, pids])]),
      diagnostics: { elapsedMs: d.elapsedMs, readFailures: 0, descriptorsScanned: d.descriptorsScanned, processesScanned: d.processesScanned } };
  };
  function requestWorker(spawned: ChildProcess, request: Record<string, unknown>, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolveLine, rejectLine) => {
      const timeout = Math.max(1, Math.min(timeoutMs, RETENTION_HOLDER_SCAN_MS));
      const timer = setTimeout(() => {
        const error = new Error('holder worker request deadline');
        const current = pending;
        pending = undefined;
        current?.reject(error);
        fail(error.message);
        spawned.kill('SIGKILL');
      }, timeout);
      pending = {
        resolve: (value) => { clearTimeout(timer); resolveLine(value); },
        reject: (error) => { clearTimeout(timer); rejectLine(error); },
      };
      try { spawned.stdin!.write(JSON.stringify(request) + '\n'); }
      catch (error) { clearTimeout(timer); pending = undefined; rejectLine(new Error(message(error))); }
    });
  }
  const acquireRegularFileLease = (entry: RetentionEntry, timeoutMs: number): Promise<RetentionFileLease> => {
    const run = serial.then(async () => {
      if (closed || ended) throw new Error('retention holder scanner unavailable');
      if (activeLeaseToken) throw new Error('regular-file lease already held');
      if (!Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino) ||
          !Number.isSafeInteger(entry.uid) || !Number.isSafeInteger(entry.gid) ||
          !Number.isFinite(entry.newestWriteMs)) throw new Error('regular-file lease identity incomplete');
      const spawned = await start();
      const line = await requestWorker(spawned, {
        operation: 'lease-acquire', path: entry.path, caller: process.pid, control: process.cwd(),
        dev: entry.dev, ino: entry.ino, newestWriteMs: entry.newestWriteMs, uid: entry.uid, gid: entry.gid,
      }, timeoutMs);
      let result: any;
      try { result = JSON.parse(line); } catch { throw new Error('regular-file lease response was not JSON'); }
      const token = result?.lease?.token;
      if (result?.complete !== true || result?.lease?.type !== 'write' || typeof token !== 'string' ||
          token.length < 16 || result?.diagnostics?.backend !== 'fcntl-file-lease' ||
          result?.diagnostics?.identityStable !== true) {
        throw new Error(`regular-file lease unavailable: ${result?.diagnostics?.reason ?? 'incomplete evidence'}`);
      }
      activeLeaseToken = token;
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            const releaseLine = await requestWorker(spawned, { operation: 'lease-release', token }, RETENTION_HOLDER_SCAN_MS);
            let releaseResult: any;
            try { releaseResult = JSON.parse(releaseLine); } catch { throw new Error('regular-file lease release response was not JSON'); }
            if (releaseResult?.complete !== true || releaseResult?.released !== true ||
                releaseResult?.diagnostics?.breakRequested === true) {
              throw new Error(`regular-file lease release incomplete: ${releaseResult?.diagnostics?.reason ?? 'lease break requested'}`);
            }
          } finally {
            activeLeaseToken = undefined;
          }
        },
      } satisfies RetentionFileLease;
    });
    serial = run.then(() => {}, () => {});
    return run;
  };
  const scan = (paths: readonly string[]): Promise<OpenWriterScan> => {
    const run = serial.then(async () => {
      if (closed || activeLeaseToken) return incompleteHolders('retention holder scanner unavailable while regular-file lease is held');
      return scanRetentionHolders(paths, { uid: () => 1, privileged: async (wanted, control) => {
        const candidates = wanted.filter((path) => path !== control);
        let result: OpenWriterScan;
        try { result = await kernel(candidates, control); }
        catch (error) { fail(message(error)); result = incompleteHolders(message(error)); }
        if (result.complete) return result;
        const fallback = await (deps.fallback ?? scanRetentionHolders)(paths);
        if (!fallback.complete) fallback.diagnostics = { ...fallback.diagnostics,
          reason: [result.diagnostics?.reason, fallback.diagnostics?.reason].filter(Boolean).join('; ') };
        return fallback;
      } });
    });
    serial = run.then(() => {}, () => {});
    return run;
  };
  const close = async () => {
    closed = true; fail('retention holder scanner closed');
    const spawned = child;
    if (!spawned || spawned.exitCode !== null || spawned.signalCode !== null) return;
    await new Promise<void>((resolveClosed) => {
      const timer = setTimeout(() => { spawned.kill('SIGKILL'); resolveClosed(); }, 1000);
      spawned.once('close', () => { clearTimeout(timer); resolveClosed(); });
    });
  };
  return { scan, acquireRegularFileLease, close };
}

/** Root usage is a union of allocations. Removing a name releases a shared
 * allocation only after its last retained entry leaves the population. */
class RetentionUsage {
  bytes = 0;
  private entries = new Map<string, RetentionEntry>();
  private shared = new Map<string, { bytes: number; refs: number }>();
  constructor(entries: readonly RetentionEntry[]) { for (const entry of entries) this.add(entry); }
  private add(entry: RetentionEntry): void {
    this.entries.set(entry.path, entry);
    this.bytes += entry.bytes;
    for (const link of entry.hardlinks ?? []) {
      const key = `${link.dev}:${link.ino}`, prior = this.shared.get(key);
      if (prior) {
        if (prior.bytes !== link.bytes) throw new Error('inconsistent hardlink allocation census');
        prior.refs++; this.bytes -= link.bytes;
      } else this.shared.set(key, { bytes: link.bytes, refs: 1 });
    }
  }
  remove(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path); this.bytes -= entry.bytes;
    for (const link of entry.hardlinks ?? []) {
      const key = `${link.dev}:${link.ino}`, shared = this.shared.get(key)!;
      if (--shared.refs) this.bytes += link.bytes;
      else this.shared.delete(key);
    }
  }
  removeBuilds(path: string, removed: BuildRemovalResult['removed']): void {
    let entry = this.entries.get(path)!;
    for (const target of removed) {
      const underTarget = (value: string) => value === target.path || value.startsWith(target.path + '/');
      let bytes = entry.bytes - target.bytes;
      const hardlinks: RetentionHardlink[] = [];
      for (const link of entry.hardlinks ?? []) {
        const paths = link.paths.filter(value => !underTarget(value));
        if (paths.length) {
          hardlinks.push({ ...link, paths });
          if (paths.length !== link.paths.length) bytes += link.bytes;
        }
      }
      if (bytes < 0) throw new Error('invalid build allocation receipt');
      entry = { ...entry, bytes, hardlinks };
    }
    this.remove(path); this.add(entry);
  }
}

/** Select by each root's keep rule. Oldest first; do not depend on available bytes (D-005). */
export function selectRetentionEntries(entries: readonly RetentionEntry[], policy: CompiledPolicy, nowMs: number,
  caps?: RetentionCapReceipt[]): RetentionEntry[] {
  const groups = new Map<string, RetentionEntry[]>();
  const unpinnedPolicy = { ...policy, pins: [] };
  for (const entry of entries) {
    const cls = deletionClassFor(entry.path, unpinnedPolicy, nowMs);
    if (!cls || cls.id !== entry.classId || containsClassRoot(entry.path, policy)) continue;
    const key = `${entry.classId}\0${entry.root}`;
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const selected = new Set<RetentionEntry>();
  for (const group of groups.values()) {
    group.sort((a, b) => b.newestWriteMs - a.newestWriteMs || a.path.localeCompare(b.path));
    const cls = policy.classes.get(group[0]!.classId)!;
    const rule = cls.keep;
    for (let index = 0; index < group.length; index++) {
      const entry = group[index]!;
      if (entry.protectedReason || !deletionClassFor(entry.path, policy, nowMs)) continue;
      const age = nowMs - entry.newestWriteMs;
      if (rule.kind === 'max-age' && age > rule.maxAgeHours * HOUR) selected.add(entry);
      if (rule.kind === 'newest' && (index >= rule.keep || (rule.maxAgeHours !== undefined && age > rule.maxAgeHours * HOUR))) selected.add(entry);
      // Lease classes run through their owning program, never through a generic age delete.
    }
    const maxBytes = retentionRootSizeCap(cls);
    if (maxBytes !== undefined) {
      const pinned = group.filter((entry) => !deletionClassFor(entry.path, policy, nowMs));
      const usage = new RetentionUsage(group);
      const beforeBytes = usage.bytes;
      // The UNION of age and cap effects is oldest-first. Do not subtract
      // planned age deletions before choosing cap victims: doing so could skip
      // an older entry while evicting a newer age-selected sibling.
      for (const entry of [...group].reverse()) {
        if (usage.bytes <= maxBytes) break;
        if (entry.protectedReason || !deletionClassFor(entry.path, policy, nowMs)) continue;
        selected.add(entry); usage.remove(entry.path);
      }
      const pinnedBytes = new RetentionUsage(pinned).bytes;
      caps?.push({ root: group[0]!.root, classId: cls.id, maxBytes, beforeBytes, pinnedBytes,
        pinnedPaths: pinned.map((entry) => entry.path), afterBytes: beforeBytes,
        overByBytes: Math.max(0, beforeBytes - maxBytes), pinnedOverageBytes: Math.max(0, pinnedBytes - maxBytes) });
    }
  }
  return [...selected].sort((a, b) => a.newestWriteMs - b.newestWriteMs || a.path.localeCompare(b.path));
}

function overlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function message(err: unknown): string { return err instanceof Error ? err.message : String(err); }
function absent(err: unknown): boolean { return (err as NodeJS.ErrnoException)?.code === 'ENOENT'; }

/** Bind mounts have different paths but the same device/inode. Never run two policies on those bytes. */
export async function physicalRetentionRoots(roots: Array<{ path: string; classId: string }>, errors: string[],
  inspect: (path: string) => Promise<{ dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean }> = lstat,
): Promise<Array<{ path: string; classId: string; aliases: string[] }>> {
  const groups = new Map<string, { path: string; classId: string; aliases: string[]; conflict: boolean }>();
  for (const root of roots) {
    try {
      const stat = await inspect(root.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { errors.push(`unsafe retention root:${root.path}`); continue; }
      const key = `${stat.dev}:${stat.ino}`;
      const prior = groups.get(key);
      if (!prior) groups.set(key, { ...root, aliases: [root.path], conflict: false });
      else if (prior.classId !== root.classId) {
        prior.conflict = true;
        errors.push(`conflicting physical retention classes:${prior.classId}/${root.classId}:${root.path}`);
      } else if (!prior.aliases.includes(root.path)) prior.aliases.push(root.path);
    } catch (error) { if (!absent(error)) errors.push(`root:${root.path}: ${message(error)}`); }
  }
  return [...groups.values()].filter((root) => !root.conflict).map(({ conflict: _conflict, ...root }) => root);
}

/** A descriptor opened through either bind alias protects the selected physical tree. */
export async function scanRetentionRootHolders(root: { path: string; aliases: string[] }, paths: readonly string[],
  scan: (paths: readonly string[]) => Promise<OpenWriterScan>,
): Promise<OpenWriterScan> {
  const aliases = (path: string) => root.aliases.map((alias) => alias + path.slice(root.path.length));
  const result = await scan([...new Set(paths.flatMap(aliases))]);
  const byPath = new Map<string, string[]>();
  for (const path of paths) {
    const pids = [...new Set(aliases(path).flatMap((alias) => result.byPath.get(alias) ?? []))];
    if (pids.length) byPath.set(path, pids);
  }
  return { ...result, byPath };
}

/** Expand policy patterns using the policy's own compiled segment matchers. No symlink traversal. */
async function policyRoots(policy: CompiledPolicy, home: string, errors: string[]): Promise<Array<{ path: string; classId: string }>> {
  const roots: Array<{ path: string; classId: string }> = [];
  for (const cls of policy.classes.values()) {
    if (!cls.enforcers.some((e) => e.kind === 'standing-reclaim' && !e.via)) continue;
    if (cls.keep.kind !== 'max-age' && cls.keep.kind !== 'newest') continue;
    for (const root of policy.roots.filter((r) => r.classId === cls.id)) {
      const literal = root.pattern.replace(/^~(?=\/)/, home).split('/').filter(Boolean);
      let parents = ['/'];
      for (let i = 0; i < literal.length; i++) {
        const next: string[] = [];
        for (const parent of parents) {
          try {
            const names = literal[i]!.includes('*') || literal[i]!.startsWith('re:') ? await readdir(parent) : [literal[i]!];
            for (const name of names) {
              if (!root.segments[i]!.test(name)) continue;
              const path = join(parent, name);
              const s = await lstat(path);
              if (s.isDirectory() && !s.isSymbolicLink()) next.push(path);
            }
          } catch (err) { if (!absent(err)) errors.push(`root:${parent}: ${message(err)}`); }
        }
        parents = next;
      }
      roots.push(...parents.map((path) => ({ path, classId: cls.id })));
    }
  }
  return roots;
}

/** A tree is stale only if EVERY descendant is stale. Capped or unreadable scans refuse deletion. */
interface RetentionScanBudget {
  left: number; deadline: number;
  progress: NonNullable<DiskReclaimReceipt['scan']>;
}
async function inspectEntry(path: string, root: string, classId: string, budget: RetentionScanBudget, retainAfterMs?: number,
  retained?: (reason: string) => void, collectBuildDirs = false, includeProtected = false): Promise<RetentionEntry | null> {
  const first = await lstat(path);
  let newestWriteMs = 0;
  const allocation = new RetentionAllocationCounter();
  const stack = [path];
  const directories = new Map<string, { path: string; dev: number; ino: number }>();
  const buildDirs: NonNullable<RetentionEntry['buildDirs']> = [];
  let protectedReason: string | undefined;
  while (stack.length) {
    if (Date.now() > budget.deadline) throw new Error('incomplete tree scan');
    const current = stack.pop()!;
    const s = current === path ? first : await lstat(current);
    // A known traversal boundary conclusively protects the whole candidate.
    // Never follow it, and do not confuse that retain verdict with lost evidence.
    const boundary = s.isSymbolicLink() ? 'symlink boundary' : s.dev !== first.dev ? 'filesystem boundary'
      : !s.isFile() && !s.isDirectory() ? 'special filesystem entry' : undefined;
    if (boundary) {
      if (!protectedReason) retained?.(boundary);
      if (!includeProtected) return null;
      protectedReason ??= boundary;
    }
    // Unix sockets are represented as socket:[inode] in /proc, so a path-only
    // holder scan cannot prove them unused. Native/system owners retain these.
    newestWriteMs = Math.max(newestWriteMs, s.mtimeMs, s.ctimeMs);
    // A single recent write proves a max-age tree ineligible. Its remaining
    // descendants cannot change that verdict, so leave them unwalked. Count
    // policies still need the exact newest write across the whole tree.
    if (retainAfterMs !== undefined && newestWriteMs >= retainAfterMs) {
      budget.progress.retainedRecentTrees++;
      return null;
    }
    // Only unresolved stale-tree nodes consume the deep-inspection count.
    // Cheap, conclusive retain checks remain bounded by the shared deadline.
    if (--budget.left < 0) throw new Error('incomplete tree scan');
    budget.progress.inspectedNodes++;
    allocation.add(current, s, s.isFile());
    if (!boundary && s.isDirectory()) {
      if (collectBuildDirs) {
        const identity = { path: current, dev: s.dev, ino: s.ino };
        directories.set(current, identity);
        if (current !== path && isBuildDirName(current.slice(current.lastIndexOf('/') + 1))) buildDirs.push(identity);
      }
      stack.push(...(await readdir(current)).map((name) => join(current, name)));
    } else if (collectBuildDirs && current.endsWith('/CACHEDIR.TAG')) {
      const parent = directories.get(dirname(current));
      if (parent && parent.path !== path && !buildDirs.some(value => value.path === parent.path)) buildDirs.push(parent);
    }
  }
  return { path, root, classId, newestWriteMs, bytes: allocation.bytes, ...allocation.metadata(), dev: first.dev, ino: first.ino,
    uid: first.uid, gid: first.gid,
    ...(protectedReason ? { protectedReason } : {}),
    ...(collectBuildDirs ? { buildDirs } : {}) };
}

export async function runDiskReclaimOnce(options: DiskReclaimOptions = {}): Promise<DiskReclaimReceipt> {
  const started = options.nowMs ?? Date.now();
  const runDeadline = Date.now() + (options.runBudgetMs ?? DEFAULT_RECLAIM_RUN_BUDGET_MS);
  const receipt: DiskReclaimReceipt = {
    schemaVersion: 1, id: randomUUID(), host: hostname(), startedAt: new Date(started).toISOString(), finishedAt: '',
    dryRun: options.dryRun ?? false, complete: false, policyExhausted: null, devices: [], entries: [], delegates: [], errors: [],
  };
  const home = options.home ?? homedir();
  const policy = compilePolicy(options.policy ?? retentionPolicyForWorkspaceRoot(), home);
  const sample = options.sample ?? (() => sampleDiskSnapshots(['/', '/mnt/data']));
  const scan = options.scanHolders ?? scanRetentionHolders;
  const snapshots = async (): Promise<DiskSnapshot[]> => {
    try { return await sample(); } catch (err) { receipt.errors.push(`device sample: ${message(err)}`); return []; }
  };
  const before = await snapshots();
  try {
    await options.record?.('started', receipt);
    let mutex: { hasWaiters: () => Promise<boolean> } | undefined;
    let protectedPaths: string[] = [];
    const refreshProtection = async () => {
      const protection = await options.readProtection?.();
      policy.pins = protection?.pins ?? [];
      protectedPaths = [...(options.protectedPaths ?? []), ...(protection?.paths ?? [])].map((path) => resolve(path));
    };
    // Keep the census/effect cursor across FIFO handoffs. Ending the whole pass
    // here made a queued writer discard minutes of inspection on every tick.
    const yieldToWaiter = async function* (onPaused?: (elapsedMs: number) => void): AsyncGenerator<void, number, void> {
      if (!await mutex?.hasWaiters()) return 0;
      const pausedAt = Date.now();
      try {
        await options.record?.('progress', { phase: 'yield-to-queued-writer' });
        yield;
        // A pin or lease writer may have changed eligibility while we released
        // the mutex. Never reuse that protection snapshot after reacquisition.
        await refreshProtection();
        return Math.max(0, Date.now() - pausedAt);
      } finally {
        // If the owning mutex times out while this generator is suspended, its
        // `return()` runs this finally without returning a value to yieldEffects.
        // Attribute that terminal wait immediately instead of dropping it.
        onPaused?.(Math.max(0, Date.now() - pausedAt));
      }
    };
    const reclaim = async function* (): AsyncGenerator<void, void, void> {
      // Pins and native cleanup share this writer lock. Yield only between
      // operations; an admitted holder check/removal must finish before release.
      await refreshProtection();
      // Independent owners must not wait behind a whole-root census: a large
      // root can spend the entire pass deadline before reaching this lane.
      // Keep their existing protection, mutex and deadline contracts intact.
      const delegates = options.delegates ?? [];
      for (const [index, delegate] of delegates.entries()) {
        if (Date.now() >= runDeadline) { receipt.errors.push(`retention run budget exhausted before delegate:${delegate.classId}`); break; }
        yield* yieldToWaiter();
        // One productive owner must not spend the entire pass before the
        // remaining owners or policy census get a turn. Reuse its existing
        // deadline seam, reserving one equal share for each remaining lane.
        // An incomplete measurement still refuses effects and stays incomplete.
        const remainingMs = runDeadline - Date.now();
        if (remainingMs <= 0) { receipt.errors.push(`retention run budget exhausted before delegate:${delegate.classId}`); break; }
        const delegateDeadline = Date.now() + Math.floor(remainingMs / (delegates.length - index + 1));
        const delegateStarted = performance.now();
        const phases: NonNullable<DiskReclaimReceipt['delegates'][number]['phases']> = [];
        let omittedPhases = 0, acceptingPhases = true;
        let phaseWrites = Promise.resolve();
        const onPhase = (event: ReclaimPhaseTiming) => {
          if (!acceptingPhases) return;
          if (phases.length >= 32) { omittedPhases++; return; }
          const measured = { ...event, observedAfterMs: performance.now() - delegateStarted };
          phases.push(measured);
          // The existing release-cut observer is synchronous. Serialize its
          // bounded audit writes without delaying or cancelling safety work.
          phaseWrites = phaseWrites.then(async () => {
            await options.record?.('progress', { ...measured, phase: 'delegate-phase', classId: delegate.classId, delegatePhase: measured.phase });
          }).catch(err => { receipt.errors.push(`delegate phase audit:${delegate.classId}: ${message(err)}`); });
        };
        await options.record?.('progress', { phase: 'delegate-start', classId: delegate.classId });
        let result: { ok: boolean; detail: unknown };
        try { result = await delegate.run(receipt.dryRun, onPhase, delegateDeadline); }
        catch (err) { result = { ok: false, detail: message(err) }; }
        finally { acceptingPhases = false; await phaseWrites; }
        const measured = { classId: delegate.classId, ...result, elapsedMs: performance.now() - delegateStarted,
          ...(phases.length ? { phases } : {}), ...(omittedPhases ? { omittedPhases } : {}) };
        receipt.delegates.push(measured);
        await options.record?.('progress', { phase: 'delegate-finish', classId: delegate.classId,
          ok: result.ok, elapsedMs: measured.elapsedMs });
      }
      const censusPolicy = { ...policy, pins: [] };
      const roots = await physicalRetentionRoots(options.roots ?? await policyRoots(policy, home, receipt.errors), receipt.errors);
      const previous = options.previousReceipt;
      if (previous && !previous.complete && !previous.dryRun && previous.host === receipt.host) {
        const blocked = previous.scan?.stoppedAtRoot;
        const index = roots.findIndex(root => blocked !== null && blocked !== undefined && root.aliases.includes(blocked));
        // Rotate the existing physical order rather than dropping the slow root.
        // A large first root must not spend every run before its peers start.
        if (index >= 0) roots.push(...roots.splice(0, index + 1));
      }
      receipt.roots = roots;
      // A registered workspace's tool run dirs belong exclusively to scratch-gc.
      const workspaceIds = (options.registeredWorkspaces ?? (() => readRegistry().workspaces.map((x) => x.id)))();
      const progress = receipt.scan = { inspectedNodes: 0, retainedRecentTrees: 0, stoppedAtRoot: null as string | null, incompleteRoots: [] as string[] };
      for (const root of roots) {
        if (Date.now() >= runDeadline) { receipt.errors.push('retention run budget exhausted'); break; }
        yield* yieldToWaiter();
        const rootProtectedPaths = () => protectedPaths.flatMap((path) => root.aliases.map((alias) =>
          path === alias || path.startsWith(alias + '/') ? root.path + path.slice(alias.length) : path));
        const scanRoot = (paths: readonly string[]) => scanRetentionRootHolders(root, paths, scan);
        const budget = { left: options.maxEntries ?? 100_000, deadline: Math.min(runDeadline, Date.now() + (options.budgetMs ?? 60_000)), progress };
        const budgetExpired = () => budget.left <= 0 || Date.now() >= Math.min(budget.deadline, runDeadline);
        // Each root gets the same inspection allowance. Holder scans retain
        // their own native deadline; effect waits do not spend that allowance.
        const outsideInspectionBudget = async <T>(operation: () => Promise<T>): Promise<T> => {
          const pausedAt = Date.now();
          try { return await operation(); }
          finally { budget.deadline += Math.max(0, Date.now() - pausedAt); }
        };
        let budgetStopped = false;
        const stopAtBudget = (root: string) => {
          if (!progress.incompleteRoots.length) receipt.errors.push('incomplete tree scan: retention scan budget exhausted');
          progress.stoppedAtRoot ??= root;
          if (!progress.incompleteRoots.includes(root)) progress.incompleteRoots.push(root);
          budgetStopped = true;
        };
        if (budgetExpired()) { stopAtBudget(root.path); continue; }
        let entries: RetentionEntry[] = [];
        let inspectionFailed = false;
        const keep = policy.classes.get(root.classId)?.keep;
        const maxBytes = retentionRootSizeCap(policy.classes.get(root.classId)!);
        const capped = maxBytes !== undefined;
        const collectBuildDirs = keep?.kind === 'max-age' && keep.buildDirMaxAgeHours !== undefined;
        const retainAfterMs = keep?.kind === 'max-age'
          ? started - Math.min(keep.maxAgeHours, keep.buildDirMaxAgeHours ?? keep.maxAgeHours) * HOUR : undefined;
        try {
          const names = await readdir(root.path);
          const excluded = names.map((name) => join(root.path, name)).filter((path) =>
            (!capped && root.classId === 'papercusp-scratch' && workspaceIds.includes(path.slice(root.path.length + 1))) ||
            (!capped && rootProtectedPaths().some((protectedPath) => overlap(path, protectedPath))) ||
            !deletionClassFor(path, capped ? censusPolicy : policy, started) || containsClassRoot(path, policy));
          if (options.inspectTrees && (retainAfterMs !== undefined || capped)) {
            // An advancing whole-root census must not restart at the ordinary
            // per-root inspection allowance on every scheduled pass. Bound stalls
            // by metadata progress and the complete walk by the remaining run.
            // Cap accounting still requires a successful complete-root census.
            await options.record?.('progress', { phase: 'census-start', root: root.path, classId: root.classId });
            const censusStarted = performance.now();
            let census: Awaited<ReturnType<NonNullable<DiskReclaimOptions['inspectTrees']>>> | undefined;
            let censusError: string | undefined;
            try {
              census = await outsideInspectionBudget(() => options.inspectTrees!(root.path, {
                retainAfterMs: retainAfterMs ?? Number.POSITIVE_INFINITY, includeRecent: capped, collectBuildDirs,
                excludedPaths: excluded, timeoutMs: Math.max(1, runDeadline - Date.now()),
                progressTimeoutMs: options.budgetMs ?? 60_000,
              }));
            } catch (error) { censusError = message(error); throw error; }
            finally {
              const measured = { root: root.path, classId: root.classId, elapsedMs: performance.now() - censusStarted,
                inspectedNodes: census?.inspectedNodes ?? 0, ...(census?.timing ? { timing: census.timing } : {}),
                ...(census?.error || censusError ? { error: census?.error ?? censusError } : {}) };
              (receipt.censuses ??= []).push(measured);
              await options.record?.('progress', { phase: 'census-finish', ...measured });
            }
            progress.inspectedNodes += census.inspectedNodes;
            progress.retainedRecentTrees += census.retainedRecentTrees;
            // Allocation graphs belong to selection below. Persist only the
            // public outcome: spreading retained.entry duplicated potentially
            // huge hardlink/build inventories into the terminal receipt.
            receipt.entries.push(...census.retained.map(({ path, reason }) => ({ path, reason, classId: root.classId, status: 'protected' as const, bytes: 0 })));
            if (census.error) {
              receipt.errors.push(`inspect:${root.path}: ${census.error}`);
              progress.stoppedAtRoot ??= root.path; progress.incompleteRoots.push(root.path);
              continue;
            }
            entries = census.entries.map((entry) => ({ ...entry, root: root.path, classId: root.classId }));
            if (capped) entries.push(...census.retained.filter((entry) => entry.entry && !excluded.includes(entry.path))
              .map((entry) => ({ ...entry.entry!, root: root.path, classId: root.classId, protectedReason: entry.reason })));
          } else {
            const inspected = await mapWithConcurrency(names, 16, async (name) => {
            if (budgetStopped) return null;
            if (budgetExpired()) { stopAtBudget(root.path); return null; }
            const path = join(root.path, name);
            const retain = (reason: string, status: 'protected' | 'changed' = 'protected') => {
              receipt.entries.push({ path, classId: root.classId, status, bytes: 0, reason });
            };
            if (!capped && root.classId === 'papercusp-scratch' && workspaceIds.includes(name)) { retain('registered workspace scratch owner'); return null; }
            if (!capped && rootProtectedPaths().some((protectedPath) => overlap(path, protectedPath))) { retain('live retention lease'); return null; }
            // Refuse nested policy roots before walking (e.g. a scratch PG data dir).
            if (!deletionClassFor(path, capped ? censusPolicy : policy, started) || containsClassRoot(path, policy)) { retain('protected policy root'); return null; }
            try {
              return await inspectEntry(path, root.path, root.classId, budget, capped ? undefined : retainAfterMs, retain, collectBuildDirs, capped);
            }
            catch (err) {
              if (budgetExpired()) { stopAtBudget(root.path); return null; }
              // Concurrent disappearance proves this candidate cannot be removed;
              // permission/IO failures still leave eligibility unknown and fail closed.
              if (absent(err)) { retain('disappeared during inspection', 'changed'); return null; }
              receipt.errors.push(`inspect:${path}: ${message(err)}`);
              inspectionFailed = true;
              return null;
            }
            });
            entries = inspected.filter((entry): entry is RetentionEntry => entry !== null);
          }
        } catch (err) {
          if (!absent(err)) { receipt.errors.push(`list:${root.path}: ${message(err)}`); inspectionFailed = true; }
        }
        // An incomplete class census cannot establish oldest-first selection.
        // Leave its entries untouched and retain the independent owner delegates.
        if (inspectionFailed) {
          progress.stoppedAtRoot ??= root.path;
          if (!progress.incompleteRoots.includes(root.path)) progress.incompleteRoots.push(root.path);
        }
        if (budgetStopped || inspectionFailed) continue;
        for (const entry of entries) {
          // The workspace owner controls deletion, but its retained usage still
          // belongs in this root's cap census on both inspection routes.
          if (root.classId === 'papercusp-scratch' && workspaceIds.includes(entry.path.slice(root.path.length + 1))) {
            entry.protectedReason = 'registered workspace scratch owner';
            receipt.entries.push({ path: entry.path, classId: entry.classId, status: 'protected', bytes: entry.bytes, reason: entry.protectedReason });
          }
          if (rootProtectedPaths().some((path) => overlap(entry.path, path))) entry.protectedReason = 'live retention lease';
        }
        const rootCaps: RetentionCapReceipt[] = [];
        const selected = selectRetentionEntries(entries, policy, started, rootCaps);
        (receipt.caps ??= []).push(...rootCaps);
        const cap = rootCaps[0];
        const remainingUsage = cap ? new RetentionUsage(entries) : undefined;
        const ageOnlyPolicy = { ...policy, classes: new Map([...policy.classes].map(([id, cls]) => [id, { ...cls, maxBytes: undefined }])) };
        const agePaths = new Set(selectRetentionEntries(entries, ageOnlyPolicy, started).map((entry) => entry.path));
        if (cap && cap.beforeBytes > cap.maxBytes) {
          // A holder/change may prevent an earlier planned eviction. Continue
          // oldest-first through the remaining eligible entries until the
          // measured retained usage, rather than a planned total, meets the cap.
          const picked = new Set(selected.map((entry) => entry.path));
          selected.push(...entries.filter((entry) => !picked.has(entry.path) && !entry.protectedReason && deletionClassFor(entry.path, policy, started)));
          selected.sort((a, b) => a.newestWriteMs - b.newestWriteMs || a.path.localeCompare(b.path));
        }
        for (const entry of entries) {
          if (entry.protectedReason || !entry.buildDirs?.length || !keep || !buildDirsEligible(keep, entry.newestWriteMs, started) ||
              !deletionClassFor(entry.path, policy, started) || selected.some(value => value.path === entry.path)) continue;
          selected.push({ ...entry, buildOnly: true });
          agePaths.add(entry.path);
        }
        selected.sort((a, b) => a.newestWriteMs - b.newestWriteMs || a.path.localeCompare(b.path));
        if (!selected.length) {
          if (cap && cap.overByBytes > cap.pinnedOverageBytes) receipt.errors.push(sizeCapError(root.path, cap.overByBytes));
          continue;
        }
        const effectStarted = Date.now();
        let effectDeadline = Math.min(runDeadline, effectStarted + (options.effectBudgetMs ?? 60_000));
        const timings = { initialHolderScanMs: 0, freshHolderScanMs: 0, reinspectionMs: 0, removalMs: 0, removalAuditMs: 0,
          progressRecordMs: 0, yieldWaitMs: 0, leaseReleaseMs: 0 };
        const yieldEffects = async function* () {
          try {
            const pausedMs = yield* yieldToWaiter(ms => { timings.yieldWaitMs += ms; });
            budget.deadline += pausedMs;
            effectDeadline = Math.min(runDeadline, effectDeadline + pausedMs);
          } finally {
            // A failed reacquisition closes the cursor before its normal root
            // epilogue. Keep the terminal receipt's continuation and time current.
            updateEffectProgress();
          }
        };
        const effect = { root: root.path, selected: selected.length, processed: 0, remaining: selected.length,
          nextPath: selected[0]!.path as string | null, elapsedMs: 0, stopped: false, timings };
        (receipt.effects ??= []).push(effect);
        const measureEffect = async <T>(phase: keyof typeof timings, operation: () => Promise<T>): Promise<T> => {
          const began = Date.now();
          try { return await operation(); }
          finally { timings[phase] += Math.max(0, Date.now() - began); }
        };
        let lastProgressAt = effectStarted;
        const updateEffectProgress = () => {
          effect.remaining = selected.length - effect.processed;
          effect.nextPath = selected[effect.processed]?.path ?? null;
          effect.elapsedMs = Math.max(0, Date.now() - effectStarted);
        };
        const recordProgress = async () => {
          updateEffectProgress();
          await measureEffect('progressRecordMs', () => outsideInspectionBudget(async () => options.record?.('progress', { ...effect })));
          lastProgressAt = Date.now();
          effect.elapsedMs = Math.max(0, lastProgressAt - effectStarted);
        };
        const stopEffects = () => {
          if (Date.now() < effectDeadline) return false;
          effect.stopped = true;
          receipt.errors.push(effectBudgetError(root.path));
          return true;
        };
        await recordProgress();
        if (stopEffects()) { await recordProgress(); continue; }
        yield* yieldEffects();
        // This is only an early skip for the first candidate. Every candidate
        // still receives a fresh holder check immediately before its effect.
        // A bulk proc scan of hundreds of thousands of paths forced the slow
        // fallback and could consume this root's entire effect allowance.
        const holders = await measureEffect('initialHolderScanMs', () => outsideInspectionBudget(() => scanRoot([selected[0]!.path])));
        if (!holders.complete) {
          receipt.errors.push(`incomplete process-holder scan:${root.path}: ${JSON.stringify(holders.diagnostics ?? {})}`);
          await recordProgress(); continue;
        }
        for (let entry of selected) {
          yield* yieldEffects();
          if (cap && cap.afterBytes <= cap.maxBytes && !agePaths.has(entry.path)) {
            if (keep && entry.buildDirs?.length && buildDirsEligible(keep, entry.newestWriteMs, started)) entry = { ...entry, buildOnly: true };
            else { effect.processed++; continue; }
          }
          if (budgetExpired()) { stopAtBudget(root.path); break; }
          if (stopEffects()) break;
          const outcome: DiskReclaimReceipt['entries'][number] = { path: entry.path, classId: entry.classId, bytes: entry.bytes, status: 'protected' };
          receipt.entries.push(outcome);
          let deferred = false;
          let regularLease: RetentionFileLease | undefined;
          try {
            if (!deletionClassFor(entry.path, policy, started) || rootProtectedPaths().some((path) => overlap(entry.path, path))) {
              outcome.reason = 'live retention lease or pin'; continue;
            }
            if (holders.byPath.has(entry.path)) { outcome.reason = 'live process'; continue; }
            // Write the intent before the last identity/holder checks, so a
            // slow database round trip cannot widen the check-to-effect window.
            if (!receipt.dryRun) await measureEffect('removalAuditMs', () => outsideInspectionBudget(async () => options.record?.('remove-intent', entry)));
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            // Rescan write activity + identity and process holders immediately before the effect.
            // A regular file's complete newest-write/identity census is one
            // lstat, including when production supplies an enrolled remover.
            // Preserve that check without spawning the tree inspector for every
            // file; directories still require its complete walk.
            let regularFile = false;
            const fresh = await measureEffect('reinspectionMs', async () => {
              const candidateStat = await lstat(entry.path);
              regularFile = candidateStat.isFile();
              if (options.inspectTrees && (retainAfterMs !== undefined || capped) && !regularFile) {
                const census = await outsideInspectionBudget(() => options.inspectTrees!(entry.root, {
                  retainAfterMs: retainAfterMs ?? Number.POSITIVE_INFINITY, includeRecent: capped, paths: [entry.path], collectBuildDirs,
                  timeoutMs: Math.max(1, effectDeadline - Date.now()),
                }));
                if (census.error) throw new Error(census.error);
                const current = census.entries.find((candidate) => candidate.path === entry.path);
                if (!current) outcome.reason = census.retained[0]?.reason ?? 'recent write';
                return current ? { ...current, root: entry.root, classId: entry.classId, uid: candidateStat.uid, gid: candidateStat.gid } : null;
              }
              return inspectEntry(entry.path, entry.root, entry.classId, budget, undefined,
                (reason) => { outcome.reason = reason; }, collectBuildDirs);
            });
            if (!fresh) continue;
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            // A regular file can use one enrolled worker FD as the proof held
            // across the effect. Directories retain the complete host holder
            // census because a lease on the directory would not prove all
            // descendants are unused. Unsupported/incomplete lease evidence
            // falls back to the existing fresh host scan.
            if (regularFile && !receipt.dryRun && options.acquireRegularFileLease) {
              try {
                regularLease = await measureEffect('freshHolderScanMs', () => outsideInspectionBudget(() =>
                  options.acquireRegularFileLease!(fresh, Math.max(1, effectDeadline - Date.now()))));
              } catch {
                regularLease = undefined;
              }
            }
            if (!regularLease) {
              const freshHolders = await measureEffect('freshHolderScanMs', () => outsideInspectionBudget(() => scanRoot([entry.path])));
              if (!freshHolders.complete || freshHolders.byPath.has(entry.path)) {
                outcome.reason = 'process evidence unavailable or held';
                if (!freshHolders.complete) receipt.errors.push(`incomplete process-holder scan before removal:${entry.path}: ${JSON.stringify(freshHolders.diagnostics ?? {})}`);
                continue;
              }
            }
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            if (fresh.dev !== entry.dev || fresh.ino !== entry.ino || fresh.newestWriteMs !== entry.newestWriteMs || fresh.bytes !== entry.bytes ||
                !isDeepStrictEqual(fresh.hardlinks, entry.hardlinks)) { outcome.status = 'changed'; continue; }
            if (entry.buildOnly) {
              if (!isDeepStrictEqual(fresh.buildDirs, entry.buildDirs)) { outcome.status = 'changed'; continue; }
              const result = await measureEffect('removalMs', () => outsideInspectionBudget(() => (options.removeEntry ??
                ((value, ms, observe, dryRun) => removePrivilegedRetentionEntry(value, ms, nativeRetentionCommand, observe, dryRun)))
                (entry, Math.max(1, effectDeadline - Date.now()), (timing) => { outcome.nativeCommand = timing; }, receipt.dryRun)));
              if (!result) throw new Error('build removal receipt unavailable');
              outcome.bytes = 0; outcome.reason = 'source entry retained after build inspection';
              for (const removed of result.removed) {
                const childOutcome = { path: removed.path, classId: entry.classId, bytes: removed.bytes,
                  status: receipt.dryRun ? 'would-remove' as const : 'removed' as const };
                receipt.entries.push(childOutcome);
                if (!receipt.dryRun) await measureEffect('removalAuditMs', () => outsideInspectionBudget(async () => options.record?.('removed', childOutcome)));
              }
              if (cap && remainingUsage) { remainingUsage.removeBuilds(entry.path, result.removed); cap.afterBytes = remainingUsage.bytes; }
              continue;
            }
            if (receipt.dryRun) {
              outcome.status = 'would-remove';
              if (cap && remainingUsage) { remainingUsage.remove(entry.path); cap.afterBytes = remainingUsage.bytes; }
              continue;
            }
            await measureEffect('removalMs', () => outsideInspectionBudget(() => options.removeEntry
              ? options.removeEntry(entry, Math.max(1, effectDeadline - Date.now()), (timing) => { outcome.nativeCommand = timing; })
              : rm(entry.path, { recursive: true, force: false })));
            outcome.status = 'removed';
            if (cap && remainingUsage) { remainingUsage.remove(entry.path); cap.afterBytes = remainingUsage.bytes; }
            await measureEffect('removalAuditMs', () => outsideInspectionBudget(async () => options.record?.('removed', outcome)));
          } catch (err) {
            if (absent(err)) { outcome.status = 'changed'; outcome.reason = 'disappeared before removal'; continue; }
            outcome.status = 'failed'; outcome.reason = message(err);
            if (budgetExpired()) { stopAtBudget(root.path); break; }
            receipt.errors.push(`remove:${entry.path}: ${message(err)}`);
          } finally {
            if (regularLease) {
              const lease = regularLease;
              try { await measureEffect('leaseReleaseMs', () => lease.release()); }
              catch (err) {
                outcome.status = 'failed'; outcome.reason = `regular-file lease release: ${message(err)}`;
                receipt.errors.push(`lease-release:${entry.path}: ${message(err)}`);
              }
              regularLease = undefined;
            }
            if (!deferred) effect.processed++;
            // Do not race or cancel a running safety check or removal. Record
            // progress between effects, after the final holder-to-unlink window.
            if (Date.now() - lastProgressAt >= 10_000) await recordProgress();
          }
        }
        await recordProgress();
        if (cap) {
          cap.pinnedPaths = entries.filter((entry) => !deletionClassFor(entry.path, policy, started)).map((entry) => entry.path);
          cap.pinnedBytes = new RetentionUsage(entries.filter((entry) => cap.pinnedPaths.includes(entry.path))).bytes;
          cap.pinnedOverageBytes = Math.max(0, cap.pinnedBytes - cap.maxBytes);
          cap.overByBytes = Math.max(0, cap.afterBytes - cap.maxBytes);
          if (cap.overByBytes > cap.pinnedOverageBytes) receipt.errors.push(sizeCapError(root.path, cap.overByBytes));
        }
        // A productive partial root is a durable continuation point. Do not
        // spend the remainder of this pass starting an unrelated large root:
        // the next scheduled batch rotates from stoppedAtRoot and rebuilds all
        // safety evidence. This specifically prevents the first batch from
        // consuming its full drain window before any later root can run.
        const productiveStop = options.yieldAfterProductiveEffects === true &&
          receipt.effects?.at(-1)?.stopped === true && selected.some(entry =>
            receipt.entries.some(outcome => outcome.path === entry.path && outcome.status === 'removed'));
        if (productiveStop) {
          progress.stoppedAtRoot = root.path;
          for (const remaining of roots.slice(roots.indexOf(root) + 1)) {
            if (!progress.incompleteRoots.includes(remaining.path)) progress.incompleteRoots.push(remaining.path);
          }
          break;
        }
      }
      for (const cls of policy.classes.values()) {
        if (cls.enforcers.some((e) => e.kind === 'standing-reclaim' && (e.via || cls.keep.kind === 'lease')) &&
            !receipt.delegates.some((e) => e.classId === cls.id)) receipt.errors.push(`missing delegate:${cls.id}`);
      }
    };
    const cursor = reclaim();
    try {
      while (true) {
        const remainingMs = runDeadline - Date.now();
        if (remainingMs <= 0) throw new Error('retention run budget exhausted');
        let done = false;
        await withFsMutex('papercusp-disk-retention', async (held) => {
          mutex = held;
          done = (await cursor.next()).done === true;
        }, { timeoutMs: Math.max(1, remainingMs) });
        if (done) break;
      }
    } finally { await cursor.return(); }
  } catch (err) { receipt.errors.push(message(err)); }
  // A queued writer can end the callback between effects, before the root's
  // normal epilogue. Report retained usage after successful effects on every
  // exit path, including a cooperative yield or a later inspection failure.
  for (const cap of receipt.caps ?? []) cap.overByBytes = Math.max(0, cap.afterBytes - cap.maxBytes);
  const after = await snapshots();
  const paths = new Set(options.expectedDevices ?? ['/', '/mnt/data']);
  receipt.devices = [...paths].map((path) => {
    const matches = (s: DiskSnapshot) => s.path === path || s.aliases?.includes(path);
    const b = before.find(matches), a = after.find(matches);
    if (!b || !a) receipt.errors.push(`device sample missing:${path}`);
    return { path, beforeFreeBytes: b?.freeBytes ?? null, afterFreeBytes: a?.freeBytes ?? null, atTarget: a ? a.freeBytes >= DISK_HEADROOM_BYTES : null };
  });
  receipt.complete = receipt.errors.length === 0 && receipt.delegates.every((d) => d.ok);
  receipt.policyExhausted = receipt.complete && !receipt.dryRun ? true : null;
  receipt.finishedAt = new Date().toISOString();
  try { await options.record?.('receipt', receipt); }
  catch (err) { receipt.complete = false; receipt.policyExhausted = null; receipt.errors.push(`receipt write:${message(err)}`); }
  return receipt;
}

/** Elevated deletion stays within a held directory descriptor and refuses an
 * identity change. Python's fd-based rmtree never follows swapped symlinks.
 * Reuse the existing enrolled/timeout-bounded subprocess route. */
export async function removePrivilegedRetentionEntry(entry: RetentionEntry, timeoutMs: number,
  execute: typeof nativeRetentionCommand = nativeRetentionCommand,
  observeTiming?: (timing: NativeRetentionTiming) => void, dryRun = false): Promise<void | BuildRemovalResult> {
  if (resolve(entry.root) !== entry.root || dirname(entry.path) !== entry.root || entry.path === entry.root ||
      !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) throw new Error('unsafe privileged retention target');
  const root = await lstat(entry.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe privileged retention root');
  const worker = `
import json, os, shutil, stat, sys, time
started = time.monotonic()
def progress(phase, **detail):
    # stderr remains separate from the build-removal JSON receipt. Bound scan
    # samples below so a stalled worker cannot flood its enrolled task log.
    print('RETENTION_WORKER ' + json.dumps(dict(phase=phase,
          elapsedMs=round((time.monotonic() - started) * 1000), **detail)), file=sys.stderr, flush=True)
progress('started')
e = json.load(sys.stdin)
progress('input-read')
fd = os.open(e['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    root = os.fstat(fd)
    if (root.st_dev, root.st_ino) != (e['rootDev'], e['rootIno']):
        raise RuntimeError('retention root identity changed')
    progress('root-verified')
    name = os.path.basename(e['path'])
    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if (s.st_dev, s.st_ino) != (e['dev'], e['ino']) or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
        raise RuntimeError('retention candidate identity changed')
    progress('candidate-verified')
    if e.get('buildOnly'):
        parent = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            if (os.fstat(parent).st_dev, os.fstat(parent).st_ino) != (e['dev'], e['ino']):
                raise RuntimeError('retention source identity changed')
            def open_parent(path):
                parts = path.split('/')
                if not parts or any(p in ('', '.', '..') for p in parts):
                    raise RuntimeError('unsafe build path')
                current = os.dup(parent)
                try:
                    for part in parts[:-1]:
                        nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                        os.close(current)
                        current = nxt
                        if os.fstat(current).st_dev != e['dev']:
                            raise RuntimeError('build filesystem boundary')
                    return current, parts[-1]
                except:
                    os.close(current)
                    raise
            selected = []
            for target in sorted(e.get('buildDirs', []), key=lambda t: (len(t['path']), t['path'])):
                prefix = e['path'] + '/'
                if not target['path'].startswith(prefix):
                    raise RuntimeError('build target outside source')
                if any(target['path'].startswith(t['path'] + '/') for t in selected):
                    continue
                pfd, leaf = open_parent(target['path'][len(prefix):])
                try:
                    bfd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=pfd)
                    try:
                        bs = os.fstat(bfd)
                        if (bs.st_dev, bs.st_ino) != (target['dev'], target['ino']) or bs.st_dev != e['dev']:
                            raise RuntimeError('build target identity changed')
                        valid = leaf in e['buildNames']
                        if not valid:
                            try:
                                tag = os.open('CACHEDIR.TAG', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=bfd)
                                try:
                                    ts = os.fstat(tag)
                                    valid = stat.S_ISREG(ts.st_mode) and ts.st_dev == e['dev'] and os.read(tag, 128).startswith(e['tagSignature'].encode())
                                finally:
                                    os.close(tag)
                            except FileNotFoundError:
                                pass
                        if not valid:
                            continue
                        selected.append(dict(target, bytes=0))
                    finally:
                        os.close(bfd)
                finally:
                    os.close(pfd)
            # Recheck the source after tag reads and inside the native effect.
            # This single walk also accounts only selected build bytes, so
            # nested targets never double-subtract from the source/root cap.
            progress('source-scan-started', targets=len(selected))
            newest, total, nodes, scan_samples = 0, 0, 0, 0
            seen = set()
            target_seen = {t['path']: set() for t in selected}
            next_sample = time.monotonic() + 1
            def account(path, s):
                global newest, total, nodes, scan_samples, next_sample
                if s.st_dev != e['dev'] or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
                    raise RuntimeError('unsafe source descendant')
                newest = max(newest, s.st_mtime_ns / 1000000, s.st_ctime_ns / 1000000)
                size = s.st_blocks * 512
                shared = stat.S_ISREG(s.st_mode) and s.st_nlink > 1
                key = (s.st_dev, s.st_ino)
                if not shared or key not in seen:
                    total += size
                    if shared:
                        seen.add(key)
                nodes += 1
                if nodes % 1024 == 0 and scan_samples < 16 and time.monotonic() >= next_sample:
                    progress('source-scan', nodes=nodes)
                    scan_samples += 1
                    next_sample = time.monotonic() + 1
                for target in selected:
                    if path == target['path'] or path.startswith(target['path'] + '/'):
                        if not shared or key not in target_seen[target['path']]:
                            target['bytes'] += size
                            if shared:
                                target_seen[target['path']].add(key)
            for directory, dirs, files, dfd in os.fwalk('.', dir_fd=parent, follow_symlinks=False):
                account(os.path.normpath(os.path.join(e['path'], directory)), os.fstat(dfd))
                for child in dirs + files:
                    cs = os.stat(child, dir_fd=dfd, follow_symlinks=False)
                    if cs.st_dev != e['dev'] or not (stat.S_ISDIR(cs.st_mode) or stat.S_ISREG(cs.st_mode)):
                        raise RuntimeError('unsafe source descendant')
                    if child in files:
                        account(os.path.normpath(os.path.join(e['path'], directory, child)), cs)
            # Allow only floating-point rounding of the same nanosecond value
            # between Python and JS (less than 0.001 ms at current epochs).
            if abs(newest - e['newestWriteMs']) > 0.001 or total != e['bytes']:
                raise RuntimeError('retention source changed before build removal')
            current = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (e['dev'], e['ino']):
                raise RuntimeError('retention source identity changed')
            progress('source-scan-verified', nodes=nodes)
            # Validate the whole batch before the first effect. Reopen each
            # parent from the original source descriptor immediately at unlink.
            if not shutil.rmtree.avoids_symlink_attacks:
                raise RuntimeError('fd-safe retention removal unavailable')
            progress('effect-started', targets=len(selected), dryRun=e['dryRun'])
            for target in selected:
                pfd, leaf = open_parent(target['path'][len(e['path']) + 1:])
                try:
                    bs = os.stat(leaf, dir_fd=pfd, follow_symlinks=False)
                    if (bs.st_dev, bs.st_ino) != (target['dev'], target['ino']) or not stat.S_ISDIR(bs.st_mode):
                        raise RuntimeError('build target identity changed')
                    if not e['dryRun']:
                        shutil.rmtree(leaf, dir_fd=pfd)
                finally:
                    os.close(pfd)
            progress('effect-completed', targets=len(selected), dryRun=e['dryRun'])
            print(json.dumps({'removed': [{'path': t['path'], 'bytes': t['bytes']} for t in selected]}))
        finally:
            os.close(parent)
    elif stat.S_ISDIR(s.st_mode):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError('fd-safe retention removal unavailable')
        progress('effect-started')
        shutil.rmtree(name, dir_fd=fd)
        progress('effect-completed')
    else:
        progress('effect-started')
        os.unlink(name, dir_fd=fd)
        progress('effect-completed')
finally:
    os.close(fd)
`;
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const result = await execute(repoRoot, '/usr/bin/sudo', ['-n', '/usr/bin/python3', '-c', worker], {
    stdin: JSON.stringify({ ...entry, rootDev: root.dev, rootIno: root.ino, dryRun,
      buildNames: BUILD_DIR_NAMES, tagSignature: CACHEDIR_TAG_SIGNATURE }), timeoutMs, observeTiming,
    stdoutOnly: entry.buildOnly, outputLimit: entry.buildOnly ? Math.max(4000, JSON.stringify(entry.buildDirs).length * 2) : undefined,
  });
  if (!result.ok) throw new Error(`privileged retention removal failed:${JSON.stringify(result.detail)}`);
  if (entry.buildOnly) {
    const value = JSON.parse((result.detail as { output: string }).output) as BuildRemovalResult;
    if (!Array.isArray(value.removed) || value.removed.some(target => !entry.buildDirs?.some(candidate => candidate.path === target.path) ||
        !Number.isSafeInteger(target.bytes) || target.bytes < 0)) throw new Error('invalid build removal receipt');
    return value;
  }
}

/** Bounded, enrolled execution of an existing native cleaner. */
export async function nativeRetentionCommand(repoRoot: string, command: string, args: string[], options: {
  /** Candidate lists can exceed the kernel's per-argument limit; keep them off argv. */
  stdin?: string;
  /** Per-invocation context for a native owner, without mutating process.env. */
  env?: NodeJS.ProcessEnv;
  stdoutOnly?: boolean; outputLimit?: number; timeoutMs?: number;
  /** Receipts reuse managedSpawn's existing tracer; no extra subprocess or audit write. */
  observeTiming?: (timing: NativeRetentionTiming) => void;
} = {}) {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  const { killTask } = await import('../task-manager/control');
  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const timing: NativeRetentionTiming = { taskId: null, totalMs: 0, spawnedAfterMs: null,
    childClosedAfterMs: null, launchReturnedAfterMs: null, completedAfterMs: null,
    timeoutMs, settledBy: null, settledAfterMs: null,
    cleanupStartedAfterMs: null, cleanupFinishedAfterMs: null, cleanupResult: null, stages: [] };
  let finish!: (result: { ok: boolean; detail: unknown }) => void;
  const observed = new Promise<{ ok: boolean; detail: unknown }>((resolve) => { finish = resolve; });
  let output = '', stderr = '', taskId: string | null = null, settled = false;
  let outputTruncated = false, needsTermination = false;
  const outputLimit = options.outputLimit ?? 4000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (ok: boolean, detail: unknown, settledBy: NonNullable<NativeRetentionTiming['settledBy']>) => {
    if (settled) return;
    timing.settledBy = settledBy; timing.settledAfterMs = elapsed();
    settled = true; clearTimeout(timer);
    finish({ ok, detail: options.stdoutOnly && detail && typeof detail === 'object'
      ? { ...detail, stderr, outputTruncated } : detail });
  };
  const abort = (error: string, settledBy: 'timeout' | 'input-error') => {
    if (settled) return;
    needsTermination = true;
    done(false, { error, taskId, output }, settledBy);
  };
  try {
    const spawned = await managedSpawn(command, args, {
      class: 'other', title: 'scheduled disk retention delegate', argv: [command, ...args],
      launchedBy: 'system:disk-retention', planSlug: 'disk-headroom-standing-reclaim-2026-10-12',
      runtimeMaxSec: Math.ceil(timeoutMs / 1000), detail: { subsystem: 'storage', operation: 'retention-delegate' },
    }, {
      spawnOptions: { cwd: repoRoot, env: options.env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
      ...(options.observeTiming ? { stage: (name: string) => {
        if (timing.stages.length < 32) timing.stages.push({ name, elapsedMs: elapsed() });
      } } : {}),
      onSpawn: (child, id) => {
        taskId = id;
        timing.taskId = id; timing.spawnedAfterMs = elapsed();
        timer = setTimeout(() => abort('delegate timeout', 'timeout'), timeoutMs);
        timer.unref();
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        const append = (chunk: string) => {
          const combined = output + chunk;
          outputTruncated ||= combined.length > outputLimit;
          output = combined.slice(-outputLimit);
        };
        child.stdout?.on('data', append);
        if (!options.stdoutOnly) child.stderr?.on('data', append);
        else child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
        child.once('error', (error) => done(false, { error: message(error), taskId, output }, 'child-error'));
        child.once('close', (code, signal) => {
          timing.childClosedAfterMs = elapsed();
          done(code === 0 && !(options.stdoutOnly && outputTruncated), { code, signal, taskId, output }, 'close');
        });
        if (options.stdin !== undefined) {
          if (!child.stdin) {
            abort('delegate input pipe unavailable', 'input-error');
          } else {
            child.stdin.once('error', (error) => {
              abort(`delegate input:${message(error)}`, 'input-error');
            });
            child.stdin.end(options.stdin);
          }
        }
      },
    });
    timing.launchReturnedAfterMs = elapsed();
    const result = await observed;
    if (needsTermination) {
      // The handle belongs to systemd-run, whose death can leave its payload
      // live. Wait for enrollment above, then reap and verify the owned task
      // through its existing scope/identity control before returning a receipt.
      timing.cleanupStartedAfterMs = elapsed();
      const cleanup = await killTask(spawned.taskId, { signal: 'SIGKILL', reapTerminalResidue: true })
        .catch((error: unknown) => ({ ok: false as const, error: message(error) }));
      timing.cleanupFinishedAfterMs = elapsed();
      timing.cleanupResult = { ok: cleanup.ok, ...(!cleanup.ok ? { error: cleanup.error } : {}) };
      if (!cleanup.ok && cleanup.error !== 'already_gone') {
        return { ok: false, detail: { ...result.detail as Record<string, unknown>, cleanup } };
      }
    }
    await spawned.waitForCompletion();
    timing.completedAfterMs = elapsed();
    return result;
  } catch (error) { done(false, { error: message(error), taskId, output }, 'launch-error'); }
  finally {
    timing.totalMs = elapsed();
    options.observeTiming?.(timing);
  }
  return observed;
}

/** Runtime delegates preserve the owning program's leases and its original receipts. */
export async function runScheduledDiskReclaim(options: Pick<DiskReclaimOptions, 'dryRun' | 'runBudgetMs'> = {}): Promise<DiskReclaimReceipt> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('../workspace-registry');
  const { readRetentionLeases, isLeaseLive, defaultRetentionDir } = await import('../release-cut-reclaim');
  // Admission failures contain no cursor. They still remain the latest visible
  // outcome, but must not erase an earlier interrupted census's continuation.
  const previousReceipt = await readReclaimReceipt(getOrgPg().sql as unknown as ReclaimSql, activeWorkspaceId(),
    undefined, undefined, { requireScan: true });
  let isPinnedPath: (path: string) => boolean = () => { throw new Error('retention protection has not been read'); };
  const readProtection = async () => {
    const dir = defaultRetentionDir();
    const { readOpenWorkItemEvidenceReferences, renewWorkItemEvidencePins } = await import('./retention-pins');
    const references = await readOpenWorkItemEvidenceReferences(getOrgPg().sql, activeWorkspaceId());
    let renewedPins: RetentionPinProtection[] = [];
    if (references.length) {
      const { loadHarnessRegistry, resolveHarnessContentPath } = await import('../harness-registry');
      const registry = await loadHarnessRegistry(activeWorkspaceId(), { fresh: true });
      const repositories = new Map<string, string>();
      for (const ref of references) {
        const root = resolveHarnessContentPath(registry, ref.harness_slug);
        if (root) repositories.set(ref.harness_slug, root);
      }
      const renewal = await renewWorkItemEvidencePins(references, { repositories, dir, dryRun: options.dryRun });
      renewedPins = renewal.pins;
      // Missing evidence is distinct from a historical test failure. Preserve
      // the exact custody gap on the standing cleaner's existing audit surface.
      if (renewal.missing.length) await writeReclaimAudit(getOrgPg().sql, activeWorkspaceId(), 'disk-retention', 'progress', {
        phase: 'missing-open-work-item-evidence', missing: renewal.missing,
      });
    }
    const leaseRead = readRetentionLeases(dir);
    const { readRetentionPins } = await import('./retention-pins');
    const pinRead = readRetentionPins({ dir });
    const pins = [...pinRead.pins, ...renewedPins];
    const errors = [...leaseRead.errors, ...pinRead.errors];
    // Unknown/malformed leases are a hard refusal, rather than disappearing from protection.
    if (errors.length) throw new Error(`retention leases unreadable: ${errors.join('; ')}`);
    const { pinProtection } = await import('../../../../scripts/lib/retention-pins.mjs');
    isPinnedPath = pinProtection(pins);
    return { paths: leaseRead.leases.filter((lease) => isLeaseLive(lease, Date.now())).flatMap((lease) => lease.paths), pins };
  };
  const require = createRequire(import.meta.url);
  const delegates: ReclaimDelegate[] = [
    { classId: 'sidecar-failed-stages', run: async (dryRun) => {
      const owner = require(join(repoRoot, 'papercusp-desktop/bin/lib/sidecar-stage-state.js')) as {
        pruneFailedStagesWithProtection: (options: { all: boolean; dryRun: boolean }, env: NodeJS.ProcessEnv,
          isPinned: (path: string) => boolean) => { errors: unknown[] };
      };
      const detail = owner.pruneFailedStagesWithProtection({ all: true, dryRun }, process.env, isPinnedPath);
      return { ok: detail.errors.length === 0, detail };
    } },
    { classId: 'cargo-target-slots', run: (dryRun) => nativeRetentionCommand(repoRoot, '/bin/bash', [
      join(repoRoot, 'papercusp-desktop/bin/reap-private-target-slots.sh'), ...(dryRun ? ['--dry-run'] : []),
    ], {
      // runDiskReclaimOnce invokes delegates while holding the pin mutex. The
      // shell's public entrypoints otherwise acquire it themselves. Keep this
      // internal reuse context scoped to this one enrolled child.
      env: { ...process.env, PAPERCUSP_DISK_RETENTION_MUTEX_HELD: '1' },
    }) },
    { classId: 'release-cut-worktrees', run: async (dryRun, onPhase, notAfterMs) => {
      const { gatherCutReclaimPlan, reclaimCutWorktrees } = await import('../release-cut-reclaim');
      const { isAutoManagedCutWorktree, RELEASE_RESUME_VERSION_PATHS } = await import('../agent-tools/release/cut');
      const gather = () => gatherCutReclaimPlan({
        repoPath: repoRoot, isAutoManaged: isAutoManagedCutWorktree, releaseVersionPaths: RELEASE_RESUME_VERSION_PATHS,
        onPhase,
        loadReleases: async () => {
          const { sql } = getOrgPg();
          const rows = await sql<Array<{ version: string; git_sha: string | null; cut_at: Date; published_at: Date | null }>>`
            SELECT version, git_sha, cut_at, published_at FROM harness_shared.releases WHERE workspace_id = ${activeWorkspaceId()}`;
          return rows.map((row) => ({ version: row.version, gitSha: row.git_sha, cutAtMs: new Date(row.cut_at).getTime(), publishedAtMs: row.published_at ? new Date(row.published_at).getTime() : null }));
        },
      });
      const { createHash } = await import('node:crypto');
      const plan = await gather();
      const detail = await reclaimCutWorktrees(plan, { dryRun, notAfterMs }, {
        retentionMutexHeld: true, refreshPlan: gather,
        // This is persistent retention-owner state, not a per-run census. Its
        // lifecycle is consumption/terminal retirement, never generic census GC.
        usageWalk: { dir: join(defaultRetentionDir(), 'reclaim-usage', createHash('sha256').update(plan.canonicalRoot ?? repoRoot).digest('hex')) },
      });
      return { ok: detail.ok, detail };
    } },
    { classId: 'unregistered-workspaces', run: async () => {
      // Whole-workspace deletion cannot be inferred from absence in the registry:
      // the more-specific policy still protects databases and product stores.
      // The registered workspace collector retains those roots and delegates their
      // explicit disposable children above, rather than deleting protected data.
      const { workspacesRoot } = await import('../workspace-registry');
      const registered = new Set(readRegistry().workspaces.map((w) => w.id));
      const unregistered: string[] = [];
      for (const name of await readdir(workspacesRoot())) {
        if (name.startsWith('.') || registered.has(name)) continue;
        const path = join(workspacesRoot(), name);
        if ((await lstat(path)).isDirectory()) unregistered.push(path);
      }
      return { ok: true, detail: { retainedProtectedRoots: unregistered, reason: 'Workspace database/product descendants remain protected by the written policy; only separately classified disposable children are collected.' } };
    } },
  ];
  let runId = '';
  const { inspectRetentionTrees } = await import('./disk-consumer-census');
  // No unprivileged fallback: permission loss must be a visible incomplete
  // receipt from the actual bounded operation, not a cached preflight result.
  const inspectTrees: typeof inspectRetentionTrees = (root, options) =>
    inspectRetentionTrees(root, { ...options, requirePrivilege: true });
  const holders = createRetentionHolderScanner();
  try { return await runDiskReclaimOnce({ ...options, yieldAfterProductiveEffects: true, previousReceipt, delegates, readProtection, inspectTrees,
    removeEntry: (entry, timeoutMs, observeTiming) => removePrivilegedRetentionEntry(entry, timeoutMs, nativeRetentionCommand, observeTiming),
    scanHolders: holders.scan, acquireRegularFileLease: holders.acquireRegularFileLease,
    record: async (phase, detail) => {
    if (phase === 'started') runId = (detail as DiskReclaimReceipt).id;
    await writeReclaimAudit(getOrgPg().sql as unknown as ReclaimSql, activeWorkspaceId(), runId, phase, detail);
  } }); } finally { await holders.close(); }
}
