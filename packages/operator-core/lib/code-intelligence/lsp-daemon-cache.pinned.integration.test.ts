/** P006 native cache path: real pinned server, isolated PG, managed lifecycle. */
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const state = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, enabled: true, tasks: [] as string[] }));
vi.mock('@papercusp/db-org', async original => ({ ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => { if (!state.sql) throw new Error('isolated cache DB missing'); return { sql: state.sql }; } }));
vi.mock('@papercusp/flags/server', async original => ({ ...await original<typeof import('@papercusp/flags/server')>(),
  getFlag: async () => state.enabled }));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    const task = await actual.managedSpawn(args[0], args[1], args[2], { ...args[3], workspaceId });
    state.tasks.push(task.taskId);
    const [row] = await state.sql!`SELECT workspace_id FROM harness_shared.task_ledger WHERE task_id=${task.taskId}`;
    expect(row?.workspace_id).toBe(workspaceId);
    return task;
  } };
});
import { dispatchLspDaemonRequest } from './lsp-daemon-server';
import { lspClientInventory, resolveServerBin, shutdownAllLspClients } from './lsp-adapter';
import { closeTask } from '../task-manager/store';
import { killTask } from '../task-manager/control';
const events = await import('../events/await/engine');
const workspaceId = `test-native-cache-${process.pid}`;
let db: OrgTestDb | undefined;
let root: string;
let previousAutoPump = true;
let requestNumber = 0;
const config = { compilerOptions: { noLib: true, noResolve: true, types: [] }, include: ['*.ts'] };
function project(name: string) {
  const dir = join(root, name); mkdirSync(dir);
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'target.ts'), 'function target() { return 1; }\n');
  writeFileSync(join(dir, 'consumer.ts'), 'function consume() { return target(); }\n');
  return dir;
}
const query = (dir: string, over: { workspaceId?: string; archive?: boolean } = {}) => dispatchLspDaemonRequest({
  workspaceId, op: 'symbol', args: { rootPath: dir, file: join(dir, 'consumer.ts'), line1: 1, character: 29 },
  deadlineAtMs: Date.now() + 90_000, ...over,
}, `cache-test-${++requestNumber}`, new AbortController().signal);

beforeAll(async () => {
  expect(resolveServerBin('typescript'), 'pinned server must exist; acceptance never skips').not.toBeNull();
  root = mkdtempSync(join(tmpdir(), 'native-lsp-cache-'));
  db = await createOrgTestDb(); state.sql = db.adminSql;
  previousAutoPump = events.setAutoPumpEnabledForTests(false);
}, 120_000);
afterEach(async () => { state.enabled = true; await shutdownAllLspClients(); }, 120_000);
afterAll(async () => {
  await shutdownAllLspClients();
  for (const taskId of state.tasks) {
    const result = await killTask(taskId, { includeSubtree: true, escalateAfterMs: 1_000 });
    expect(result.ok || result.error === 'not_live' || result.error === 'task_not_found' || result.error === 'already_gone').toBe(true);
    await closeTask(taskId, { state: 'exited', exitCode: 0, exitReason: 'cache-fixture-shutdown' });
  }
  events.setAutoPumpEnabledForTests(previousAutoPump);
  await db?.cleanup(); if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

it('reuses real producer evidence with uncached parity and a live flag check', async () => {
  const a = project('parity');
  const first = await query(a); expect(first.error).toBeNull();
  expect(first.sites).toEqual([expect.objectContaining({ path: 'target.ts', line1: 1 })]);
  let warm = await query(a);
  for (let attempt = 0; attempt < 3 && warm.daemonCache?.state !== 'hit'; attempt++) warm = await query(a);
  expect(warm.daemonCache?.state).toBe('hit'); expect(warm.sites).toEqual(first.sites);
  expect((await query(a, { workspaceId: `${workspaceId}-other` })).daemonCache?.state).toBe('miss');
  const oracle = await query(a, { archive: true }); expect(oracle.sites).toEqual(warm.sites);
  expect(oracle.daemonCache?.state).toBe('bypass');
  state.enabled = false;
  const disabled = await query(a); expect(disabled.error).toContain('disabled'); expect(disabled.sites).toEqual([]);
}, 90_000);

it('reconciles missed dependency edits and deletes at an unchanged cursor', async () => {
  const a = project('dependencies'); const first = await query(a); expect(first.error).toBeNull();
  expect(first.sites).toEqual([expect.objectContaining({ path: 'target.ts', line1: 1 })]);
  await query(a);
  const target = join(a, 'target.ts'); const stamp = statSync(target);
  // A dependency edit changes the definition line without changing the queried document.
  writeFileSync(target, '\nfunction target() { return 1; }'); utimesSync(target, stamp.atime, stamp.mtime);
  const edited = await query(a); expect(edited.sites).toEqual([expect.objectContaining({ path: 'target.ts', line1: 2 })]);
  expect(edited.daemonCache?.state).not.toBe('hit');
  rmSync(target); const deleted = await query(a); expect(deleted.sites).toEqual([]); expect(deleted.daemonCache?.state).not.toBe('hit');
}, 90_000);

it('isolates physical projects and reconciles service restart and compiler options', async () => {
  const a = project('scope-a'); const b = project('scope-b');
  const first = await query(a); expect(first.error).toBeNull();
  const other = await query(b); expect(other.sites).toEqual(first.sites);
  expect(other.daemonCache?.state).not.toBe('hit');
  expect(other.daemonCache?.inputFingerprint).not.toBe(first.daemonCache?.inputFingerprint);
  let warm = await query(b);
  for (let attempt = 0; attempt < 3 && warm.daemonCache?.state !== 'hit'; attempt++) warm = await query(b);
  expect(warm.daemonCache?.state, JSON.stringify(warm.daemonCache)).toBe('hit');
  await shutdownAllLspClients(); expect(lspClientInventory()).toHaveLength(0);
  const restarted = await query(b); expect(restarted.sites).toEqual(first.sites); expect(restarted.daemonCache?.state).not.toBe('hit');
  writeFileSync(join(b, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['*.ts'] }));
  const unmeasured = await query(b); expect(unmeasured.daemonCache).toMatchObject({ state: 'bypass', reason: 'TypeScript external compiler inputs are unmeasured' });
  expect(state.tasks.length).toBeGreaterThan(2);
}, 90_000);
