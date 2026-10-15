/** Scheduled policy retention (disk-headroom P-004, D-002/D-005).
 * Reuses the policy selector, native process-holder scan and filesystem mutex.
 * The caller returns this receipt from a DBOS step: operation_outputs is the
 * existing Postgres receipt ledger. Free space is an alarm threshold, never a
 * reason to retain expired artifacts. Existing class owners remain delegates.
 */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { openWriterPidsMany, type OpenWriterScan } from '../native-bg-task-ledger';
import { readRegistry } from '../workspace-registry';
import { mapWithConcurrency } from '../gym/concurrency';
import { sampleDiskSnapshots, type DiskSnapshot } from './disk-space-alarm';
import {
  RETENTION_POLICY, compilePolicy, containsClassRoot, deletionClassFor,
  retentionRootSizeCap,
  type CompiledPolicy, type RetentionClass, type RetentionPinProtection,
} from './retention-policy';

export const DISK_RECLAIM_STEP = 'disk-retention-reclaim';
export const DISK_RECLAIM_CRONTAB = '0 12 * * * *';
export const DISK_HEADROOM_BYTES = 100 * 1024 ** 3;
const HOUR = 3_600_000;
const EFFECT_BUDGET_SUFFIX = ': effect budget exhausted; resume with a fresh policy census';
const effectBudgetError = (root: string) => `incomplete retention effects:${root}${EFFECT_BUDGET_SUFFIX}`;

export interface RetentionEntry {
  path: string; root: string; classId: string;
  newestWriteMs: number; bytes: number; dev: number; ino: number;
  protectedReason?: string;
}
export interface ReclaimDelegate {
  classId: string;
  run: (dryRun: boolean) => Promise<{ ok: boolean; detail: unknown }>;
}
export interface RetentionCapReceipt {
  root: string; classId: string; maxBytes: number; beforeBytes: number;
  pinnedBytes: number; pinnedPaths: string[]; afterBytes: number;
  overByBytes: number; pinnedOverageBytes: number;
}
export interface DiskReclaimReceipt {
  schemaVersion: 1; id: string; startedAt: string; finishedAt: string; dryRun: boolean;
  complete: boolean;
  /** Unknown for partial runs; a successful run drained every unprotected selected entry. */
  policyExhausted: boolean | null;
  devices: Array<{ path: string; beforeFreeBytes: number | null; afterFreeBytes: number | null; atTarget: boolean | null }>;
  entries: Array<{ path: string; classId: string; status: 'removed' | 'would-remove' | 'protected' | 'changed' | 'failed'; bytes: number; reason?: string }>;
  delegates: Array<{ classId: string; ok: boolean; detail: unknown }>;
  errors: string[];
  caps?: RetentionCapReceipt[];
  /** Physical roots actually enforced; aliases share identity, selection and holder evidence. */
  roots?: Array<{ path: string; classId: string; aliases: string[] }>;
  scan?: { inspectedNodes: number; retainedRecentTrees: number; stoppedAtRoot: string | null; incompleteRoots?: string[] };
  effects?: Array<{
    root: string; selected: number; processed: number; remaining: number;
    nextPath: string | null; elapsedMs: number; stopped: boolean;
    /** Measured effect phases, including failed/incomplete checks. Progress
     * writes, initial policy census and delegates are outside these counters. */
    timings?: { initialHolderScanMs: number; freshHolderScanMs: number; reinspectionMs: number; removalMs: number; removalAuditMs: number };
  }>;
}
export interface DiskReclaimOptions {
  dryRun?: boolean; home?: string; policy?: readonly RetentionClass[];
  /** Dependency seams also permit an isolated fixture tree; production uses the policy roots. */
  roots?: Array<{ path: string; classId: string }>;
  /** Inspection bounds apply independently to each policy root; an incomplete root cannot starve another. */
  nowMs?: number; maxEntries?: number; budgetMs?: number;
  /** Per-root wall time for holder checks, audit waits and removals. In-flight operations finish safely. */
  effectBudgetMs?: number;
  /** Whole-pass deadline, including all roots and delegates. */
  runBudgetMs?: number;
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
  removeEntry?: (entry: RetentionEntry, timeoutMs: number) => Promise<void>;
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
export async function readReclaimReceipt(sql: ReclaimSql, workspaceId: string, id?: string, expected?: DiskReclaimReceipt): Promise<DiskReclaimReceipt | null> {
  const rows = await sql.unsafe(
    `SELECT details FROM harness_shared.audit_log
      WHERE workspace_id = $1 AND action = 'disk-retention:receipt'
        AND jsonb_typeof(details) = 'object' AND details->>'schemaVersion' = '1'
        AND details->>'id' = subject
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
} = {}): Promise<OpenWriterScan> {
  const status = await (deps.readStatus ?? (() => readFile('/proc/self/status', 'utf8')))().catch(() => '');
  const ids = /^NSpid:\s*(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/);
  // A nested PID namespace cannot prove a host tree unused.
  if (!ids || ids.length !== 1) return incompleteHolders('host PID namespace control unavailable');
  const control = process.cwd();
  const wanted = [...new Set([...paths, control])];
  const scan = (deps.uid ?? (() => process.getuid?.() ?? -1))() === 0
    ? await (deps.scan ?? openWriterPidsMany)(wanted, {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: RETENTION_HOLDER_SCAN_MS,
    })
    : await (deps.privileged ?? scanPrivilegedRetentionHolders)(wanted, control)
      .catch((err) => incompleteHolders(`privileged holder scan failed: ${message(err)}`));
  if (!scan.byPath.get(control)?.includes(String(process.pid))) {
    scan.complete = false;
    scan.diagnostics = { ...scan.diagnostics, reason: [scan.diagnostics?.reason, 'original caller PID control missing'].filter(Boolean).join('; ') };
  }
  return scan;
}

async function scanPrivilegedRetentionHolders(paths: readonly string[], control: string): Promise<OpenWriterScan> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? process.cwd();
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
        spawned.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
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
    const line = await new Promise<string>((resolveLine, rejectLine) => {
      const timer = setTimeout(() => { fail('kernel holder request deadline'); spawned.kill('SIGKILL'); }, RETENTION_HOLDER_SCAN_MS);
      pending = {
        resolve: (value) => { clearTimeout(timer); resolveLine(value); },
        reject: (error) => { clearTimeout(timer); rejectLine(error); },
      };
      spawned.stdin!.write(JSON.stringify({ path: paths[0], caller: process.pid, control }) + '\n');
    });
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
  const scan = (paths: readonly string[]): Promise<OpenWriterScan> => {
    const run = serial.then(async () => {
      if (closed) return incompleteHolders('retention holder scanner closed');
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
  return { scan, close };
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
      const beforeBytes = group.reduce((sum, entry) => sum + entry.bytes, 0);
      let remaining = beforeBytes;
      // The UNION of age and cap effects is oldest-first. Do not subtract
      // planned age deletions before choosing cap victims: doing so could skip
      // an older entry while evicting a newer age-selected sibling.
      for (const entry of [...group].reverse()) {
        if (remaining <= maxBytes) break;
        if (entry.protectedReason || !deletionClassFor(entry.path, policy, nowMs)) continue;
        selected.add(entry); remaining -= entry.bytes;
      }
      const pinnedBytes = pinned.reduce((sum, entry) => sum + entry.bytes, 0);
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
  retained?: (reason: string) => void): Promise<RetentionEntry | null> {
  const first = await lstat(path);
  let newestWriteMs = 0, bytes = 0;
  const stack = [path];
  while (stack.length) {
    if (Date.now() > budget.deadline) throw new Error('incomplete tree scan');
    const current = stack.pop()!;
    const s = current === path ? first : await lstat(current);
    // A known traversal boundary conclusively protects the whole candidate.
    // Never follow it, and do not confuse that retain verdict with lost evidence.
    if (s.isSymbolicLink() || s.dev !== first.dev) {
      retained?.(s.isSymbolicLink() ? 'symlink boundary' : 'filesystem boundary');
      return null;
    }
    // Unix sockets are represented as socket:[inode] in /proc, so a path-only
    // holder scan cannot prove them unused. Native/system owners retain these.
    if (!s.isFile() && !s.isDirectory()) { retained?.('special filesystem entry'); return null; }
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
    bytes += s.blocks * 512;
    if (s.isDirectory()) stack.push(...(await readdir(current)).map((name) => join(current, name)));
  }
  return { path, root, classId, newestWriteMs, bytes, dev: first.dev, ino: first.ino };
}

export async function runDiskReclaimOnce(options: DiskReclaimOptions = {}): Promise<DiskReclaimReceipt> {
  const started = options.nowMs ?? Date.now();
  const runDeadline = Date.now() + (options.runBudgetMs ?? 15 * 60_000);
  const receipt: DiskReclaimReceipt = {
    schemaVersion: 1, id: randomUUID(), startedAt: new Date(started).toISOString(), finishedAt: '',
    dryRun: options.dryRun ?? false, complete: false, policyExhausted: null, devices: [], entries: [], delegates: [], errors: [],
  };
  const home = options.home ?? homedir();
  const policy = compilePolicy(options.policy ?? RETENTION_POLICY, home);
  const sample = options.sample ?? (() => sampleDiskSnapshots(['/', '/mnt/data']));
  const scan = options.scanHolders ?? scanRetentionHolders;
  const snapshots = async (): Promise<DiskSnapshot[]> => {
    try { return await sample(); } catch (err) { receipt.errors.push(`device sample: ${message(err)}`); return []; }
  };
  const before = await snapshots();
  try {
    await options.record?.('started', receipt);
    await withFsMutex('papercusp-disk-retention', async (mutex) => {
      // Pins and native cleanup share this writer lock. Yield only between
      // operations; an admitted holder check/removal must finish before release.
      const yieldToWaiter = async () => {
        if (!await mutex?.hasWaiters()) return false;
        receipt.errors.push('retention yielded to queued writer');
        return true;
      };
      const protection = await options.readProtection?.();
      policy.pins = protection?.pins ?? [];
      const censusPolicy = { ...policy, pins: [] };
      const roots = await physicalRetentionRoots(options.roots ?? await policyRoots(policy, home, receipt.errors), receipt.errors);
      receipt.roots = roots;
      // A registered workspace's tool run dirs belong exclusively to scratch-gc.
      const workspaceIds = (options.registeredWorkspaces ?? (() => readRegistry().workspaces.map((x) => x.id)))();
      const protectedPaths = [...(options.protectedPaths ?? []), ...(protection?.paths ?? [])].map((path) => resolve(path));
      const progress = receipt.scan = { inspectedNodes: 0, retainedRecentTrees: 0, stoppedAtRoot: null as string | null, incompleteRoots: [] as string[] };
      for (const root of roots) {
        if (Date.now() >= runDeadline) { receipt.errors.push('retention run budget exhausted'); break; }
        if (await yieldToWaiter()) return;
        const rootProtectedPaths = protectedPaths.flatMap((path) => root.aliases.map((alias) =>
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
        const keep = policy.classes.get(root.classId)?.keep;
        const maxBytes = retentionRootSizeCap(policy.classes.get(root.classId)!);
        const capped = maxBytes !== undefined;
        const retainAfterMs = keep?.kind === 'max-age' ? started - keep.maxAgeHours * HOUR : undefined;
        try {
          const names = await readdir(root.path);
          const excluded = names.map((name) => join(root.path, name)).filter((path) =>
            (root.classId === 'papercusp-scratch' && workspaceIds.includes(path.slice(root.path.length + 1))) ||
            (!capped && rootProtectedPaths.some((protectedPath) => overlap(path, protectedPath))) ||
            !deletionClassFor(path, capped ? censusPolicy : policy, started) || containsClassRoot(path, policy));
          if (options.inspectTrees && (retainAfterMs !== undefined || capped)) {
            // Native find bounds the complete walk by elapsed time while streaming
            // metadata. It avoids permanently restarting a large tree at a JS node cap.
            const census = await outsideInspectionBudget(() => options.inspectTrees!(root.path, {
              retainAfterMs: retainAfterMs ?? Number.POSITIVE_INFINITY, includeRecent: capped,
              excludedPaths: excluded, timeoutMs: Math.max(1, budget.deadline - Date.now()),
            }));
            progress.inspectedNodes += census.inspectedNodes;
            progress.retainedRecentTrees += census.retainedRecentTrees;
            receipt.entries.push(...census.retained.map((entry) => ({ ...entry, classId: root.classId, status: 'protected' as const, bytes: 0 })));
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
            if (root.classId === 'papercusp-scratch' && workspaceIds.includes(name)) { retain('registered workspace scratch owner'); return null; }
            if (!capped && rootProtectedPaths.some((protectedPath) => overlap(path, protectedPath))) { retain('live retention lease'); return null; }
            // Refuse nested policy roots before walking (e.g. a scratch PG data dir).
            if (!deletionClassFor(path, capped ? censusPolicy : policy, started) || containsClassRoot(path, policy)) { retain('protected policy root'); return null; }
            try {
              return await inspectEntry(path, root.path, root.classId, budget, capped ? undefined : retainAfterMs, retain);
            }
            catch (err) {
              if (budgetExpired()) { stopAtBudget(root.path); return null; }
              // Concurrent disappearance proves this candidate cannot be removed;
              // permission/IO failures still leave eligibility unknown and fail closed.
              if (absent(err)) { retain('disappeared during inspection', 'changed'); return null; }
              receipt.errors.push(`inspect:${path}: ${message(err)}`);
              return null;
            }
            });
            entries = inspected.filter((entry): entry is RetentionEntry => entry !== null);
          }
        } catch (err) { if (!absent(err)) receipt.errors.push(`list:${root.path}: ${message(err)}`); }
        // An incomplete class census cannot establish oldest-first selection.
        // Leave its entries untouched and retain the independent owner delegates.
        if (budgetStopped) continue;
        for (const entry of entries) {
          if (rootProtectedPaths.some((path) => overlap(entry.path, path))) entry.protectedReason = 'live retention lease';
        }
        const rootCaps: RetentionCapReceipt[] = [];
        const selected = selectRetentionEntries(entries, policy, started, rootCaps);
        (receipt.caps ??= []).push(...rootCaps);
        const cap = rootCaps[0];
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
        if (!selected.length) {
          if (cap && cap.overByBytes > cap.pinnedOverageBytes) receipt.errors.push(`size cap remains exceeded:${root.path}:${cap.overByBytes}`);
          continue;
        }
        const effectStarted = Date.now();
        const effectDeadline = Math.min(runDeadline, effectStarted + (options.effectBudgetMs ?? 60_000));
        const timings = { initialHolderScanMs: 0, freshHolderScanMs: 0, reinspectionMs: 0, removalMs: 0, removalAuditMs: 0 };
        const effect = { root: root.path, selected: selected.length, processed: 0, remaining: selected.length,
          nextPath: selected[0]!.path as string | null, elapsedMs: 0, stopped: false, timings };
        (receipt.effects ??= []).push(effect);
        const measureEffect = async <T>(phase: keyof typeof timings, operation: () => Promise<T>): Promise<T> => {
          const began = Date.now();
          try { return await operation(); }
          finally { timings[phase] += Math.max(0, Date.now() - began); }
        };
        let lastProgressAt = effectStarted;
        const recordProgress = async () => {
          effect.remaining = selected.length - effect.processed;
          effect.nextPath = selected[effect.processed]?.path ?? null;
          effect.elapsedMs = Math.max(0, Date.now() - effectStarted);
          await outsideInspectionBudget(async () => options.record?.('progress', { ...effect }));
          lastProgressAt = Date.now();
        };
        const stopEffects = () => {
          if (Date.now() < effectDeadline) return false;
          effect.stopped = true;
          receipt.errors.push(effectBudgetError(root.path));
          return true;
        };
        await recordProgress();
        if (stopEffects()) { await recordProgress(); continue; }
        if (await yieldToWaiter()) { effect.stopped = true; await recordProgress(); return; }
        const holders = await measureEffect('initialHolderScanMs', () => outsideInspectionBudget(() => scanRoot(selected.map((e) => e.path))));
        if (!holders.complete) {
          receipt.errors.push(`incomplete process-holder scan:${root.path}: ${JSON.stringify(holders.diagnostics ?? {})}`);
          await recordProgress(); continue;
        }
        for (const entry of selected) {
          if (await yieldToWaiter()) { effect.stopped = true; await recordProgress(); return; }
          if (cap && cap.afterBytes <= cap.maxBytes && !agePaths.has(entry.path)) { effect.processed++; continue; }
          if (budgetExpired()) { stopAtBudget(root.path); break; }
          if (stopEffects()) break;
          const outcome: DiskReclaimReceipt['entries'][number] = { path: entry.path, classId: entry.classId, bytes: entry.bytes, status: 'protected' };
          receipt.entries.push(outcome);
          let deferred = false;
          try {
            if (holders.byPath.has(entry.path)) { outcome.reason = 'live process'; continue; }
            // Write the intent before the last identity/holder checks, so a
            // slow database round trip cannot widen the check-to-effect window.
            if (!receipt.dryRun) await measureEffect('removalAuditMs', () => outsideInspectionBudget(async () => options.record?.('remove-intent', entry)));
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            // Rescan write activity + identity and process holders immediately before the effect.
            // A regular file's complete newest-write/identity census is one
            // lstat. Preserve that check without spawning the tree inspector
            // for every file; directories still require its complete walk.
            const fresh = await measureEffect('reinspectionMs', async () => {
              const regularFile = options.inspectTrees && !options.removeEntry && retainAfterMs !== undefined && (await lstat(entry.path)).isFile();
              if (options.inspectTrees && (retainAfterMs !== undefined || capped) && !regularFile) {
                const census = await outsideInspectionBudget(() => options.inspectTrees!(entry.root, {
                  retainAfterMs: retainAfterMs ?? Number.POSITIVE_INFINITY, includeRecent: capped, paths: [entry.path],
                  timeoutMs: Math.max(1, effectDeadline - Date.now()),
                }));
                if (census.error) throw new Error(census.error);
                const current = census.entries.find((candidate) => candidate.path === entry.path);
                if (!current) outcome.reason = census.retained[0]?.reason ?? 'recent write';
                return current ? { ...current, root: entry.root, classId: entry.classId } : null;
              }
              return inspectEntry(entry.path, entry.root, entry.classId, budget, undefined,
                (reason) => { outcome.reason = reason; });
            });
            if (!fresh) continue;
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            const freshHolders = await measureEffect('freshHolderScanMs', () => outsideInspectionBudget(() => scanRoot([entry.path])));
            if (!freshHolders.complete || freshHolders.byPath.has(entry.path)) {
              outcome.reason = 'process evidence unavailable or held';
              if (!freshHolders.complete) receipt.errors.push(`incomplete process-holder scan before removal:${entry.path}: ${JSON.stringify(freshHolders.diagnostics ?? {})}`);
              continue;
            }
            if (stopEffects()) { deferred = true; outcome.reason = 'effect budget exhausted'; break; }
            if (fresh.dev !== entry.dev || fresh.ino !== entry.ino || fresh.newestWriteMs !== entry.newestWriteMs || fresh.bytes !== entry.bytes) { outcome.status = 'changed'; continue; }
            if (receipt.dryRun) { outcome.status = 'would-remove'; if (cap) cap.afterBytes -= entry.bytes; continue; }
            await measureEffect('removalMs', () => outsideInspectionBudget(() => options.removeEntry
              ? options.removeEntry(entry, Math.max(1, effectDeadline - Date.now())) : rm(entry.path, { recursive: true, force: false })));
            outcome.status = 'removed';
            if (cap) cap.afterBytes -= entry.bytes;
            await measureEffect('removalAuditMs', () => outsideInspectionBudget(async () => options.record?.('removed', outcome)));
          } catch (err) {
            if (absent(err)) { outcome.status = 'changed'; outcome.reason = 'disappeared before removal'; continue; }
            outcome.status = 'failed'; outcome.reason = message(err);
            if (budgetExpired()) { stopAtBudget(root.path); break; }
            receipt.errors.push(`remove:${entry.path}: ${message(err)}`);
          } finally {
            if (!deferred) effect.processed++;
            // Do not race or cancel a running safety check or removal. Record
            // progress between effects, after the final holder-to-unlink window.
            if (Date.now() - lastProgressAt >= 10_000) await recordProgress();
          }
        }
        await recordProgress();
        if (cap) {
          cap.overByBytes = Math.max(0, cap.afterBytes - cap.maxBytes);
          if (cap.overByBytes > cap.pinnedOverageBytes) receipt.errors.push(`size cap remains exceeded:${root.path}:${cap.overByBytes}`);
        }
      }
      for (const delegate of options.delegates ?? []) {
        if (Date.now() >= runDeadline) { receipt.errors.push(`retention run budget exhausted before delegate:${delegate.classId}`); break; }
        if (await yieldToWaiter()) return;
        try { receipt.delegates.push({ classId: delegate.classId, ...await delegate.run(receipt.dryRun) }); }
        catch (err) { receipt.delegates.push({ classId: delegate.classId, ok: false, detail: message(err) }); }
      }
      for (const cls of policy.classes.values()) {
        if (cls.enforcers.some((e) => e.kind === 'standing-reclaim' && (e.via || cls.keep.kind === 'lease')) &&
            !receipt.delegates.some((e) => e.classId === cls.id)) receipt.errors.push(`missing delegate:${cls.id}`);
      }
    }, { timeoutMs: 1_000 });
  } catch (err) { receipt.errors.push(message(err)); }
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
  execute: typeof nativeRetentionCommand = nativeRetentionCommand): Promise<void> {
  if (resolve(entry.root) !== entry.root || dirname(entry.path) !== entry.root || entry.path === entry.root ||
      !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) throw new Error('unsafe privileged retention target');
  const root = await lstat(entry.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('unsafe privileged retention root');
  const worker = `
import json, os, shutil, stat, sys
e = json.load(sys.stdin)
fd = os.open(e['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    root = os.fstat(fd)
    if (root.st_dev, root.st_ino) != (e['rootDev'], e['rootIno']):
        raise RuntimeError('retention root identity changed')
    name = os.path.basename(e['path'])
    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if (s.st_dev, s.st_ino) != (e['dev'], e['ino']) or not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
        raise RuntimeError('retention candidate identity changed')
    if stat.S_ISDIR(s.st_mode):
        if not shutil.rmtree.avoids_symlink_attacks:
            raise RuntimeError('fd-safe retention removal unavailable')
        shutil.rmtree(name, dir_fd=fd)
    else:
        os.unlink(name, dir_fd=fd)
finally:
    os.close(fd)
`;
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const result = await execute(repoRoot, '/usr/bin/sudo', ['-n', '/usr/bin/python3', '-c', worker], {
    stdin: JSON.stringify({ ...entry, rootDev: root.dev, rootIno: root.ino }), timeoutMs,
  });
  if (!result.ok) throw new Error(`privileged retention removal failed:${JSON.stringify(result.detail)}`);
}

/** Bounded, enrolled execution of an existing native cleaner. */
export async function nativeRetentionCommand(repoRoot: string, command: string, args: string[], options: {
  /** Candidate lists can exceed the kernel's per-argument limit; keep them off argv. */
  stdin?: string;
  stdoutOnly?: boolean; outputLimit?: number; timeoutMs?: number;
} = {}) {
  const { managedSpawn } = await import('../task-manager/managed-spawn');
  let finish!: (result: { ok: boolean; detail: unknown }) => void;
  const observed = new Promise<{ ok: boolean; detail: unknown }>((resolve) => { finish = resolve; });
  let output = '', stderr = '', taskId: string | null = null, settled = false;
  let outputTruncated = false;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const outputLimit = options.outputLimit ?? 4000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (ok: boolean, detail: unknown) => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    finish({ ok, detail: options.stdoutOnly && detail && typeof detail === 'object'
      ? { ...detail, stderr, outputTruncated } : detail });
  };
  try {
    const spawned = await managedSpawn(command, args, {
      class: 'other', title: 'scheduled disk retention delegate', argv: [command, ...args],
      launchedBy: 'system:disk-retention', planSlug: 'disk-headroom-standing-reclaim-2026-10-12',
      runtimeMaxSec: Math.ceil(timeoutMs / 1000), detail: { subsystem: 'storage', operation: 'retention-delegate' },
    }, {
      spawnOptions: { cwd: repoRoot, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
      onSpawn: (child, id) => {
        taskId = id;
        timer = setTimeout(() => {
          done(false, { error: 'delegate timeout', taskId, output });
          child.kill('SIGKILL');
        }, timeoutMs);
        timer.unref();
        const append = (chunk: Buffer) => {
          const combined = output + chunk.toString();
          outputTruncated ||= combined.length > outputLimit;
          output = combined.slice(-outputLimit);
        };
        child.stdout?.on('data', append);
        if (!options.stdoutOnly) child.stderr?.on('data', append);
        else child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.once('error', (error) => done(false, { error: message(error), taskId, output }));
        child.once('close', (code, signal) => done(code === 0 && !(options.stdoutOnly && outputTruncated), { code, signal, taskId, output }));
        if (options.stdin !== undefined) {
          if (!child.stdin) {
            done(false, { error: 'delegate input pipe unavailable', taskId, output });
            child.kill('SIGKILL');
          } else {
            child.stdin.once('error', (error) => {
              done(false, { error: `delegate input:${message(error)}`, taskId, output });
              child.kill('SIGKILL');
            });
            child.stdin.end(options.stdin);
          }
        }
      },
    });
    const result = await observed;
    await spawned.waitForCompletion();
    return result;
  } catch (error) { done(false, { error: message(error), taskId, output }); }
  return observed;
}

/** Runtime delegates preserve the owning program's leases and its original receipts. */
export async function runScheduledDiskReclaim(options: Pick<DiskReclaimOptions, 'dryRun'> = {}): Promise<DiskReclaimReceipt> {
  const repoRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { activeWorkspaceId } = await import('../workspace-registry');
  const { readRetentionLeases, isLeaseLive, defaultRetentionDir } = await import('../release-cut-reclaim');
  let isPinnedPath: (path: string) => boolean = () => { throw new Error('retention protection has not been read'); };
  const readProtection = async () => {
    const dir = defaultRetentionDir();
    const leaseRead = readRetentionLeases(dir);
    const { readRetentionPins } = await import('./retention-pins');
    const pinRead = readRetentionPins({ dir });
    const errors = [...leaseRead.errors, ...pinRead.errors];
    // Unknown/malformed leases are a hard refusal, rather than disappearing from protection.
    if (errors.length) throw new Error(`retention leases unreadable: ${errors.join('; ')}`);
    const { pinProtection } = await import('../../../../scripts/lib/retention-pins.mjs');
    isPinnedPath = pinProtection(pinRead.pins);
    return { paths: leaseRead.leases.filter((lease) => isLeaseLive(lease, Date.now())).flatMap((lease) => lease.paths), pins: pinRead.pins };
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
    ]) },
    { classId: 'release-cut-worktrees', run: async (dryRun) => {
      const { gatherCutReclaimPlan, executeCutReclaim } = await import('../release-cut-reclaim');
      const { isAutoManagedCutWorktree, RELEASE_RESUME_VERSION_PATHS } = await import('../agent-tools/release/cut');
      const plan = await gatherCutReclaimPlan({
        repoPath: repoRoot, isAutoManaged: isAutoManagedCutWorktree, releaseVersionPaths: RELEASE_RESUME_VERSION_PATHS,
        loadReleases: async () => {
          const { sql } = getOrgPg();
          const rows = await sql<Array<{ version: string; git_sha: string | null; cut_at: Date; published_at: Date | null }>>`
            SELECT version, git_sha, cut_at, published_at FROM harness_shared.releases WHERE workspace_id = ${activeWorkspaceId()}`;
          return rows.map((row) => ({ version: row.version, gitSha: row.git_sha, cutAtMs: new Date(row.cut_at).getTime(), publishedAtMs: row.published_at ? new Date(row.published_at).getTime() : null }));
        },
      });
      const targets = plan.verdicts.filter((v) => v.disposition === 'reclaimable').map((v) => v.path);
      if (dryRun || targets.length === 0) return { ok: plan.failClosed.length === 0, detail: { dryRun, targets, failClosed: plan.failClosed } };
      const detail = await executeCutReclaim(plan, targets);
      return { ok: detail.ok && detail.results.every((r) => r.removed), detail };
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
  const { inspectRetentionTrees, resolveCensusSudo } = await import('./disk-consumer-census');
  // No unprivileged fallback: permission loss must be a visible incomplete
  // receipt, rather than silently retaining every foreign-owned agent tree.
  const sudo = await resolveCensusSudo();
  const inspectTrees: typeof inspectRetentionTrees = (root, options) => {
    if (!sudo && process.getuid?.() !== 0) throw new Error('privileged retention census unavailable');
    return inspectRetentionTrees(root, { ...options, sudo });
  };
  const holders = createRetentionHolderScanner();
  try { return await runDiskReclaimOnce({ ...options, delegates, readProtection, inspectTrees,
    removeEntry: removePrivilegedRetentionEntry, scanHolders: holders.scan, record: async (phase, detail) => {
    if (phase === 'started') runId = (detail as DiskReclaimReceipt).id;
    await writeReclaimAudit(getOrgPg().sql as unknown as ReclaimSql, activeWorkspaceId(), runId, phase, detail);
  } }); } finally { await holders.close(); }
}
