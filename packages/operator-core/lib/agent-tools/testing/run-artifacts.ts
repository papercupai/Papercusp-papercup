/** Retained evidence for the existing testing:run route; this module launches nothing. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { papercuspPath } from '@papercusp/host-platform/home';
import type { OwnedTestDbCleanupResult } from '@papercusp/test-config/pg';

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
}
export class TestRunArtifactPacket {
  readonly paths: TestRunArtifactPaths;
  childState: 'not-started' | 'pending' | 'closed' = 'not-started';
  cleanupResult?: OwnedTestDbCleanupResult;
  readonly groupCleanups: Array<{ directory: string | null; cleanup: unknown }> = [];
  constructor(readonly runId: string, readonly root: string, readonly deadline: TestRunDeadline,
    base = papercuspPath('test-artifacts', 'testing-run')) {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(base, 'run-'));
    this.paths = { directory, manifest: join(directory, 'manifest.json'), phases: join(directory, 'phases.jsonl'),
      reports: join(directory, 'reports'), ownedDatabases: join(directory, 'owned-databases'),
      runtimeInputs: join(directory, 'executed-inputs') };
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
  finish(detail: Record<string, unknown>): void {
    this.stage('retained', { childState: this.childState });
    this.write('manifest.json', { schemaVersion: 1, runId: this.runId, root: this.root,
      deadline: this.deadline, state: 'retained', childState: this.childState, paths: this.paths,
      groupCleanups: this.groupCleanups, ...detail });
  }
}
