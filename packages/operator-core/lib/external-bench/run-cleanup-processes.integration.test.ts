/**
 * Cancel and restart cleanup against REAL confined generation processes
 * (current-benchmark-modernization-2026-10-09 P-003: BM-P-003-cancel-cleanup,
 * BM-P-003-restart-cleanup).
 *
 * Each run-owned "solver" is a real process subtree started through the same
 * `managedSpawn` + task-ledger label the native benchmark launcher uses
 * (`<currentBenchRunLabel(runId)><attempt>:solver`). Nothing is injected into the
 * cleanup path: `cancelBenchRun` and the boot reaper `reapStaleBenchRuns` both
 * run their production `retireCurrentRun` (task-ledger census + subtree kill).
 * There is no in-memory driver for these runs, which is exactly the condition
 * after a host restart or a cross-host cancel: the durable label is the only
 * link from the run to its processes.
 *
 * The census is taken from the kernel, not the ledger: every pid in each owned
 * cgroup must be gone afterwards, while a peer run in the same benchmark
 * workspace and a foreign workspace carrying the SAME run label keep running.
 * No model, gateway or provider is involved; this proves lifecycle only.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { managedSpawn } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { currentBenchRunLabel } from './current-su';
import { cancelBenchRun, reapStaleBenchRuns, _resetActiveRunsForTests } from './run-launcher';
import { getBenchRunDetail, upsertBenchRun } from './run-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
// The task-ledger store and kill control resolve the org database through this seam.
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }) }));
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const WS = 'bench-cleanup-private';
const FOREIGN_WS = 'bench-cleanup-foreign';
let db: OrgTestDb, cwd: string;
const scope = () => ({ sql: h.sql as never, workspaceId: WS });
const scopes: string[] = [];

beforeAll(async () => {
  db = await createOrgTestDb(); h.sql = db.adminSql;
  cwd = mkdtempSync(join(tmpdir(), 'bench-cleanup-'));
});
afterAll(async () => {
  for (const unit of scopes) await killScopeUnit(unit, { signal: 'SIGKILL' }).catch(() => {});
  await db?.cleanup();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});
beforeEach(() => _resetActiveRunsForTests());

interface Solver { taskId: string; scopeUnit: string; pids: number[]; procs: string; exited: Promise<unknown> }

const alive = (pid: number) => existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'));

/** One real solver subtree: a shell that backgrounds a descendant, then execs into a sleeper. */
async function solver(workspaceId: string, label: string): Promise<Solver> {
  const task = await managedSpawn('/bin/sh', ['-c', 'sleep 600 & exec sleep 600'], {
    class: 'agent-session', title: label, argv: [], cwd, launchedBy: 'test:bench-cleanup',
    detail: { label, executionKind: 'stock-native' },
  }, { workspaceId, requireRegistration: true, spawnOptions: { stdio: 'ignore' } });
  expect(task.confined, 'cleanup census needs a real cgroup scope').toBe(true);
  scopes.push(task.scopeUnit!);
  const exited = new Promise(resolve => task.child.once('exit', resolve));
  // The scope handoff completes after managedSpawn returns; observe the kernel's
  // membership instead of assuming it from the spawn result.
  let cgroup = '';
  await vi.waitFor(() => {
    cgroup = readFileSync(`/proc/${task.child.pid}/cgroup`, 'utf8').trim().split(':').at(-1)!;
    expect(cgroup).toContain(task.scopeUnit!);
  }, { timeout: 10_000, interval: 50 });
  const procs = `/sys/fs/cgroup${cgroup}/cgroup.procs`;
  // Both the exec'd sleeper and its backgrounded descendant must be live members.
  let pids: number[] = [];
  await vi.waitFor(() => {
    pids = readFileSync(procs, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    expect(pids.length).toBeGreaterThanOrEqual(2);
  }, { timeout: 5_000 });
  for (const pid of pids) expect(alive(pid)).toBe(true);
  return { taskId: task.taskId, scopeUnit: task.scopeUnit!, pids, procs, exited };
}

async function hostRun(id: string, protocolTag: string) {
  const protocol = currentProtocolFixture(protocolTag, 8000);
  await upsertBenchRun({ id, arm: 'current', taskSetId: 'frontier-swe-v2', model: 'gpt-6-luna', status: 'running' }, scope());
  await h.sql`UPDATE harness_shared.bench_runs
    SET config = ${h.sql.json({ protocol, current: { protocolRunId: protocol.runId } } as never)}
    WHERE id = ${id} AND workspace_id = ${WS}`;
  return protocol.runId;
}

/** Start owned attempts for `runId`, a peer run in the same workspace, and a foreign workspace with the same label. */
async function fleet(runId: string) {
  const own = currentBenchRunLabel(runId);
  const owned = [await solver(WS, `${own}attempt-a:solver`), await solver(WS, `${own}attempt-b:solver`)];
  const peer = await solver(WS, `${currentBenchRunLabel(`${runId}-peer`)}attempt-a:solver`);
  const foreign = await solver(FOREIGN_WS, `${own}attempt-a:solver`);
  return { owned, survivors: [peer, foreign] };
}

async function expectRetired(owned: Solver[]) {
  for (const s of owned) {
    await vi.waitFor(() => {
      for (const pid of s.pids) expect(alive(pid), `owned pid ${pid} survived cleanup`).toBe(false);
      expect(existsSync(s.procs) ? readFileSync(s.procs, 'utf8').trim() : '').toBe('');
    }, { timeout: 10_000 });
    await s.exited;
    // The ledger must account for the attempt as terminal, not leave it 'running'.
    await vi.waitFor(async () => {
      const [terminal] = await h.sql`SELECT state, ended_at FROM harness_shared.task_ledger WHERE task_id = ${s.taskId}`;
      expect(['killed', 'exited']).toContain(terminal.state);
      expect(terminal.ended_at).toBeInstanceOf(Date);
    }, { timeout: 10_000 });
  }
}

async function expectUntouched(survivors: Solver[]) {
  for (const s of survivors) {
    for (const pid of s.pids) expect(alive(pid), `non-owned pid ${pid} was killed`).toBe(true);
    const [row] = await h.sql`SELECT state, ended_at FROM harness_shared.task_ledger WHERE task_id = ${s.taskId}`;
    expect(row.state).toBe('running');
    expect(row.ended_at).toBeNull();
  }
}

it.runIf(process.platform === 'linux')('cancel stops every run-owned generation process and leaves peer and foreign runs running', async () => {
  const runId = await hostRun('cleanup-cancel-host', 'CLEANUP-CANCEL');
  const { owned, survivors } = await fleet(runId);
  try {
    const dissolve = vi.fn(async () => {});
    await expect(cancelBenchRun('cleanup-cancel-host', { scope: scope(), dissolve })).resolves.toEqual({ cancelled: true });
    await expectRetired(owned);
    await expectUntouched(survivors);
    expect((await getBenchRunDetail('cleanup-cancel-host', scope()))!.status).toBe('cancelled');
  } finally {
    for (const s of [...owned, ...survivors]) await killScopeUnit(s.scopeUnit, { signal: 'SIGKILL' }).catch(() => {});
  }
}, 60_000);

it.runIf(process.platform === 'linux')('restart recovery retires orphaned generation processes of the interrupted run only', async () => {
  const runId = await hostRun('cleanup-restart-host', 'CLEANUP-RESTART');
  const { owned, survivors } = await fleet(runId);
  try {
    // No active-run entry and no injected retire seam: the boot reaper must find
    // the orphans from the persisted protocol binding and durable task labels alone.
    const dissolve = vi.fn(async () => {});
    const { reaped } = await reapStaleBenchRuns({ scope: scope(), staleAfterSec: 0, dissolve });
    expect(reaped).toEqual(['cleanup-restart-host']);
    await expectRetired(owned);
    await expectUntouched(survivors);
    const detail = await getBenchRunDetail('cleanup-restart-host', scope());
    expect(detail!.status).toBe('error');
    expect(detail!.runError).toMatch(/reaped/);
    expect((await reapStaleBenchRuns({ scope: scope(), staleAfterSec: 0, dissolve })).reaped).toEqual([]);
  } finally {
    for (const s of [...owned, ...survivors]) await killScopeUnit(s.scopeUnit, { signal: 'SIGKILL' }).catch(() => {});
  }
}, 60_000);
