import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { computeConditionStates } from '../agent-tools/coordination/condition-state';

const WS = 'p005-managed-original-process';
const children = new Set<ChildProcess>();
let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); }, 300_000);
afterAll(async () => {
  await Promise.all([...children].map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  }));
  await db?.cleanup();
}, 120_000);

function launch(action: 'raise' | 'reconcile' | 'restart' | 'idle-watch', intervalMs = 60_000, workspace = WS) {
  const env = { ...process.env, HARNESS_DATABASE_URL: db.adminDsn,
    HARNESS_ADMIN_DATABASE_URL: db.adminDsn, PAPERCUSP_PGBOUNCER: '0', PAPERCUSP_WORKSPACE_ID: workspace };
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const child = fork(fileURLToPath(new URL('../../test/managed-tick-alarm-process.fixture.ts', import.meta.url)), [action, String(intervalMs)], {
    execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let diagnostics = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`P005 ${action} child did not settle in 60s`)), 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`P005 ${action} exited ${code}: ${diagnostics}`)); });
    child.once('message', value => { clearTimeout(timer); resolve(value as Record<string, unknown>); });
  });
  return { child, message };
}

async function envelopes(workspace = WS) {
  const rows = await db.adminSql<{ body: Record<string, unknown> }[]>`
    SELECT body FROM harness_shared.coord_event_log WHERE workspace_id = ${workspace}
      AND surface = 'messages' AND body->>'condition_key' LIKE 'alarm:managed-tick:%' ORDER BY id`;
  return rows.map(row => row.body);
}

async function reconcile() {
  const worker = launch('reconcile');
  const result = await worker.message;
  if (worker.child.exitCode === null && worker.child.signalCode === null) await once(worker.child, 'exit');
  expect(result.kind).toBe('reconciled');
  return result.result as { resolved: string[]; intervalMs: number };
}

describe('original managed tick recovery across fresh processes and the real condition store', () => {
  it('discovers a short-cadence external alarm after the surviving watcher has already become idle', async () => {
    const workspace = 'p005-late-external-process';
    const watcher = launch('idle-watch', 60_000, workspace);
    expect((await watcher.message).kind).toBe('started');
    const producer = launch('raise', 5000, workspace);
    const raised = await producer.message;
    expect(raised.kind).toBe('raised');
    const key = (raised.data as Record<string, unknown>).conditionKey as string;
    expect(computeConditionStates(await envelopes(workspace)).find(row => row.condition_key === key)?.open).toBe(true);
    const exited = once(producer.child, 'exit');
    producer.child.kill('SIGKILL');
    await exited;
    const endedAt = Date.now();
    await expect.poll(async () => (await envelopes(workspace)).filter(row => row.resolves_condition === key).length,
      { timeout: 5000, interval: 25 }).toBe(1);
    expect(Date.now() - endedAt).toBeLessThanOrEqual(5000);
    expect(computeConditionStates(await envelopes(workspace)).find(row => row.condition_key === key)?.open).toBe(false);
  }, 300_000);

  it('keeps a live predecessor open, then atomically settles the ended original episode across restart and concurrent recovery', async () => {
    const producer = launch('raise');
    const raised = await producer.message;
    expect(raised.kind).toBe('raised');
    const raisedData = raised.data as Record<string, unknown>;
    const key = raisedData.conditionKey as string;
    const original = (await envelopes()).find(row => row.condition_key === key)!;
    expect(original).toMatchObject({ one_shot: true, data: { timerName: 'fresh-process-held', heldMs: 600_001,
      producerRun: raisedData.producerRun, watcherIntervalMs: 60_000 }, emitter: { pid: producer.child.pid } });
    expect((await reconcile()).resolved).toEqual([]);
    expect(computeConditionStates(await envelopes()).find(row => row.condition_key === key)?.open).toBe(true);

    const exited = once(producer.child, 'exit');
    producer.child.kill('SIGKILL'); await exited;
    const recoveryStartedAt = Date.now();
    const restarts = [launch('restart'), launch('restart')];
    const started = await Promise.all(restarts.map(worker => worker.message));
    expect(started.map(message => message.kind)).toEqual(['started', 'started']);
    // Includes fresh-process boot: the original cadence is the finite deadline.
    expect(Date.now() - recoveryStartedAt).toBeLessThan(60_000);
    await expect.poll(async () => (await envelopes()).filter(row => row.resolves_condition === key).length,
      { timeout: Math.max(1, 60_000 - (Date.now() - recoveryStartedAt)), interval: 50 }).toBe(1);
    expect(Date.now() - recoveryStartedAt).toBeLessThanOrEqual(60_000);
    await Promise.all([reconcile(), reconcile()]);
    await reconcile();
    const rows = await envelopes();
    expect(rows.filter(row => row.resolves_condition === key)).toHaveLength(1);
    expect(rows.find(row => row.msg_id === original.msg_id)).toEqual(original);
    expect(computeConditionStates(rows).find(row => row.condition_key === key)?.open).toBe(false);

    const successor = launch('raise');
    const next = await successor.message;
    const successorKey = (next.data as Record<string, unknown>).conditionKey;
    expect(successorKey).not.toBe(key);
    await reconcile();
    const states = computeConditionStates(await envelopes());
    expect(states.find(row => row.condition_key === key)?.open).toBe(false);
    expect(states.find(row => row.condition_key === successorKey)?.open).toBe(true);
  }, 300_000);
});
