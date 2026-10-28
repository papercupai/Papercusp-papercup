/** Retained evidence for the existing testing:run route; this module launches nothing. */
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { papercuspPath } from '@papercusp/host-platform/home';
import type { OwnedTestDbCleanupResult } from '@papercusp/test-config/pg';
import { retainNativeProofPacket, verifyNativeProofPacket,
  type NativeCustodyAuxiliary, type NativeCustodyGroup, type NativeCustodyIdentity,
  type NativeCustodyLocator } from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';

export interface TestRunDeadline {
  startedAtMs: number;
  taskDeadlineAtMs: number;
  childCutoffAtMs: number;
  cleanupReserveMs: number;
}
export function testRunDeadline(timeoutMs: number, options: {
  now?: number; taskDeadlineAtMs?: number; cleanupReserveMs?: number;
} = {}): TestRunDeadline {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('test run budget must be positive');
  const now = options.now ?? Date.now();
  if (options.taskDeadlineAtMs !== undefined && !Number.isFinite(options.taskDeadlineAtMs)) {
    throw new Error('absolute test task deadline must be finite');
  }
  const taskDeadlineAtMs = Math.min(now + timeoutMs, options.taskDeadlineAtMs ?? Infinity);
  const available = Math.max(0, taskDeadlineAtMs - now);
  const requestedReserve = options.cleanupReserveMs ?? Math.min(30_000, Math.floor(timeoutMs / 3));
  if (!Number.isFinite(requestedReserve) || requestedReserve < 0 || requestedReserve >= timeoutMs) {
    throw new Error('test cleanup reserve must be nonnegative and smaller than the task budget');
  }
  // An explicit reserve defines a fixed child cutoff. Shrinking it as preparation
  // elapses would move that cutoff forward and consume the caller's cleanup time.
  const cleanupReserveMs = options.cleanupReserveMs === undefined
    ? Math.min(requestedReserve, available) : requestedReserve;
  return { startedAtMs: now, taskDeadlineAtMs, cleanupReserveMs,
    childCutoffAtMs: taskDeadlineAtMs - cleanupReserveMs };
}

export interface TestRunArtifactPaths {
  directory: string;
  manifest: string;
  phases: string;
  reports: string;
  ownedDatabases: string;
  runtimeInputs: string;
  nativeProof: string;
}

export interface RetainedDetachedVitestReport {
  reportPath: string;
  manifestPath: string;
  sha256: string;
  byteLength: number;
}

async function ensureArtifactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('detached_report_artifact_directory_redirected');
}

async function writeArtifactAtomically(path: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new Error('detached_report_artifact_conflict');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Keep a private, content-addressed copy of a detached Vitest report before
 * the run store removes its temporary ingestion sink. The snapshot receives
 * both paths and the digest, so the bytes remain discoverable after restart.
 */
export async function retainDetachedVitestReport(input: {
  runId: string;
  root: string;
  sourcePath: string;
  reportText: string;
  scope?: { harnessSlug: string; workspaceId: string };
  sanitization?: string;
}): Promise<RetainedDetachedVitestReport> {
  if (!input.runId || !isAbsolute(input.root) || !isAbsolute(input.sourcePath)) {
    throw new Error('detached_report_artifact_identity_invalid');
  }
  const sourceName = basename(input.sourcePath).replace(/[^A-Za-z0-9._-]/g, '_').slice(-96) || 'report.json';
  const reportName = sourceName.endsWith('.json') ? sourceName : 'report.json';
  const bytes = Buffer.from(input.reportText, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const identity = JSON.stringify({ runId: input.runId, root: input.root, reportName, sha256, scope: input.scope ?? null });
  const runKey = createHash('sha256').update(input.runId).digest('hex').slice(0, 24);
  const artifactKey = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const base = papercuspPath('test-artifacts', 'testing-run', 'detached-recovery');
  const runDirectory = join(base, `run-${runKey}`);
  const packetDirectory = join(runDirectory, `report-${artifactKey}`);
  const reportsDirectory = join(packetDirectory, 'reports');
  for (const directory of [base, runDirectory, packetDirectory, reportsDirectory]) {
    await ensureArtifactDirectory(directory);
  }

  const reportPath = join(reportsDirectory, reportName);
  const manifestPath = join(packetDirectory, 'manifest.json');
  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'detached-vitest-report',
    runId: input.runId,
    root: input.root,
    scope: input.scope ?? null,
    ...(input.sanitization ? { sanitization: input.sanitization } : {}),
    report: { path: reportPath, sha256, byteLength: bytes.byteLength },
  }, null, 2)}\n`);
  await writeArtifactAtomically(reportPath, bytes);
  await writeArtifactAtomically(manifestPath, manifest);
  return { reportPath, manifestPath, sha256, byteLength: bytes.byteLength };
}

export class TestRunArtifactPacket {
  readonly paths: TestRunArtifactPaths;
  childState: 'not-started' | 'pending' | 'closed' = 'not-started';
  cleanupResult?: OwnedTestDbCleanupResult;
  readonly groupCleanups: Array<{ directory: string | null; cleanup: unknown }> = [];
  private selectedFiles: string[] = [];
  private outputLogs: string[] = [];
  private custodyIdentity?: NativeCustodyIdentity;
  private nativeLocator?: NativeCustodyLocator;
  constructor(readonly runId: string, readonly root: string, readonly deadline: TestRunDeadline,
    base = papercuspPath('test-artifacts', 'testing-run')) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(base, 'run-'));
    this.paths = { directory, manifest: join(directory, 'manifest.json'), phases: join(directory, 'phases.jsonl'),
      reports: join(directory, 'reports'), ownedDatabases: join(directory, 'owned-databases'),
      runtimeInputs: join(directory, 'executed-inputs'), nativeProof: join(directory, 'native-proof') };
    for (const dir of [this.paths.reports, this.paths.ownedDatabases, this.paths.runtimeInputs]) {
      mkdirSync(dir, { mode: 0o700 });
    }
    this.write('manifest.json', { schemaVersion: 1, runId, root, deadline, state: 'running', paths: this.paths });
    this.stage('start');
  }
  stage(stage: string, detail: Record<string, unknown> = {}): void {
    appendFileSync(this.paths.phases, JSON.stringify({ kind: 'testing-run-phase', runId: this.runId, stage,
      atMs: Date.now(), ...detail }) + '\n', { mode: 0o600 });
  }
  write(name: string, value: unknown): void {
    writeFileSync(join(this.paths.directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
  /** Selected bytes and dependency lock are pins, not a claim of a loaded import closure.
   * The maintained reporter owns loaded-source evidence; preserve its runtime inputs too. */
  captureSelectedSources(files: string[], worktree: unknown, root = this.root): void {
    this.selectedFiles = files.map(file => resolve(root, file));
    const inputs = [...new Set([...files, 'package.json', 'package-lock.json', 'scripts/test-files.mjs'])].map(file => {
      const path = resolve(root, file);
      const local = relative(root, path);
      if (local === '..' || local.startsWith('../') || isAbsolute(local)) return { path: file, status: 'outside-root' };
      try { return { path: local, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }; }
      catch { return { path: local, status: 'unavailable' }; }
    });
    this.write('source.json', { root, worktree, inputs,
      coverage: 'selected files and dependency lock; loaded import closure is reporter-owned',
      runtimeInputs: this.paths.runtimeInputs });
  }
  bindNativeIdentity(workspace: string | undefined, harness: string | undefined): void {
    this.custodyIdentity = { workspace: workspace || 'unscoped', harness: harness || 'unscoped', runId: this.runId };
  }
  captureOutputLogs(paths: string[]): void { this.outputLogs = [...paths]; }
  /** Seal after cleanup has its own outcome. No retention failure may prevent
   * confirmed-close cleanup, and a pending edition cannot be rewritten by a late close. */
  private retainNative(detail: Record<string, unknown>): unknown {
    const identity = this.custodyIdentity ?? { workspace: 'unscoped', harness: 'unscoped', runId: this.runId };
    const auxiliary: NativeCustodyAuxiliary[] = [];
    const required = ['source.json', 'configuration.json', 'router.json', 'ledger.json', 'phases.jsonl'];
    for (const name of required) auxiliary.push({ role: name, state: 'produced', path: join(this.paths.directory, name) });
    const inventory = (directory: string, role: string, depth = 0): void => {
      if (depth > 8 || auxiliary.length > 4096) throw new Error('packet auxiliary inventory limit');
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error('packet auxiliary redirected');
        if (stat.isDirectory()) inventory(path, `${role}/${name}`, depth + 1);
        else auxiliary.push({ role: `${role}/${name}`, state: 'produced', path });
      }
    };
    for (const [role, path] of [['reports', this.paths.reports], ['owned-databases', this.paths.ownedDatabases],
      ['executed-inputs', this.paths.runtimeInputs]] as const) inventory(path, role);
    this.outputLogs.forEach((path, index) => auxiliary.push({ role: `router-output/${index}`, state: 'produced', path }));
    const routers = readdirSync(this.paths.directory).filter(name => name.startsWith('native-router-')).sort();
    const routerGroups: NativeCustodyGroup[] = [];
    const routerVerdicts = [];
    for (const name of routers) {
      const directory = join(this.paths.directory, name);
      const declaration = JSON.parse(readFileSync(join(directory, 'expected.json'), 'utf8'));
      const locator = JSON.parse(readFileSync(join(directory, 'locator.json'), 'utf8'));
      const verified = verifyNativeProofPacket(directory, locator, { identity, expected: declaration.expected });
      routerGroups.push(...declaration.expected);
      routerVerdicts.push(verified.status);
      inventory(directory, name);
    }
    if (routers.length) {
      const actual = routerGroups.filter(group => group.attempt === 'primary').flatMap(group => group.selected).sort();
      if (JSON.stringify(actual) !== JSON.stringify([...this.selectedFiles].sort()))
        throw new Error('packet selected/router population mismatch');
    }
    const pending = this.childState === 'pending';
    const group: NativeCustodyGroup = { id: 'packet', attempt: 'primary', selected: this.selectedFiles.length
      ? this.selectedFiles : [this.root], runner: 'unsupported', armed: false, out: null, auxiliary };
    const saved = retainNativeProofPacket(this.paths.nativeProof, { identity, expected: [group],
      observations: [{ id: group.id, out: null }], execution: { childState: this.childState, result: detail.result ?? null },
      cleanup: detail.cleanup ?? null, ...(this.nativeLocator ? { predecessor: this.nativeLocator } : {}) });
    this.nativeLocator = saved.locator;
    return { directory: saved.directory, locator: saved.locator, byteCustody: saved.status,
      writerState: pending ? 'pending' : 'settled', routerCustody: routerVerdicts,
      nativeProof: 'unqualified', acceptance: 'unmeasured', producerRetirement: 'not-performed' };
  }
  finish(detail: Record<string, unknown>): void {
    this.stage('retained', { childState: this.childState });
    let nativeCustody: unknown;
    try { nativeCustody = this.retainNative(detail); }
    catch (error) { nativeCustody = { byteCustody: 'unavailable', error: String(error),
      nativeProof: 'unqualified', acceptance: 'unmeasured', producerRetirement: 'retained' }; }
    this.write('manifest.json', { schemaVersion: 1, runId: this.runId, root: this.root,
      deadline: this.deadline, state: 'retained', childState: this.childState, paths: this.paths,
      groupCleanups: this.groupCleanups, ...detail, nativeCustody });
  }
}
