/** Actual private HTTP/PG deadline observation; no injected tool or storage results. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem } from '../lib/work-items';
import { workItemScope } from '../lib/carry-note';
import { getWorkItemCheckpoint, setWorkItemCheckpointWithPrior } from '../lib/work-item-checkpoint';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; expectedSha: string };

function receiptFromEnvelope(envelope: any) {
  if (envelope.result?.structuredContent) return envelope.result.structuredContent;
  const candidates = envelope.result?.content?.filter((part: any) =>
    part.type === 'text' && typeof part.text === 'string' && part.text.trim().startsWith('{'));
  assert.equal(candidates?.length, 1, 'one authoritative JSON read receipt is required');
  return JSON.parse(candidates[0].text);
}

export async function measurePrivateReadDeadlineScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const { sql } = getOrgPg();
  // Retain each boundary before the next assertion/read can fail. A final-only
  // receipt lost the holder/wait evidence when independent readback timed out.
  const diagnosticsPath = `${o.evidenceDir}/read-deadline-pg.ndjson`;
  await writeFile(diagnosticsPath, '', { flag: 'wx' });
  const snapshot = async (stage: string, detail: Record<string, unknown> = {}) => {
    const activity = await sql<{ pid: number; state: string; xactStart: string | null;
      queryStart: string; waitEventType: string | null; waitEvent: string | null;
      blockingPids: number[]; query: string }[]>`
      SELECT pid, state, xact_start::text AS "xactStart", query_start::text AS "queryStart",
             wait_event_type AS "waitEventType", wait_event AS "waitEvent",
             pg_blocking_pids(pid) AS "blockingPids", left(query, 600) AS query
        FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
       ORDER BY pid LIMIT 32`;
    const locks = await sql<{ pid: number; mode: string; granted: boolean }[]>`
      SELECT pid, mode, granted FROM pg_locks
       WHERE relation = 'harness_shared.carry_notes'::regclass ORDER BY pid, mode LIMIT 64`;
    const observation = { stage, observedAtMs: performance.now(), activity, locks, ...detail };
    await appendFile(diagnosticsPath, JSON.stringify(observation) + '\n');
    return observation;
  };
  const health = async () => {
    const response = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as { service: string; sha: string; bundleStale?: unknown };
    assert.equal(response.status, 200);
    assert.equal(body.service, 'papercusp-operator');
    assert.equal(body.sha, o.expectedSha);
    assert.equal(body.bundleStale, undefined);
    return body;
  };
  const healthBefore = await health();
  const item = await createWorkItem({ kind: 'feature', title: `P009 private read deadline ${randomUUID()}`,
    summary: 'Disposable item for an observed checkpoint-read lock wait.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const checkpoint = `private read deadline ${randomUUID()}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: item.id }, checkpoint);
  let requestIndex = 0;
  const read = async () => {
    const index = requestIndex++;
    const startedAtMs = performance.now();
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ name: 'work_items:get', harness: o.harness,
        args: { id: item.id, harness: o.harness, checksOnly: true },
        callerSid: 'private-read-deadline-' + o.workspace, confirmed: true }),
    });
    const envelope = await response.json() as any;
    const completedAtMs = performance.now();
    const receipt = { index, startedAtMs, completedAtMs, status: response.status, envelope };
    await writeFile(`${o.evidenceDir}/read-deadline-request-${index}.json`, JSON.stringify(receipt), { flag: 'wx' });
    assert.equal(response.status, 200, 'HTTP failure does not prove a keyed unavailable read');
    assert.equal(envelope.ok, true);
    assert.notEqual(envelope.result?.isError, true);
    const result = receiptFromEnvelope(envelope);
    assert.equal(result.results?.length, 1);
    assert.equal(result.results[0].id, item.id);
    return { ...receipt, result };
  };
  const assertHealthy = (result: any) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, { ok: 1, failed: 0 });
    const row = result.results[0];
    assert.equal(row.ok, true);
    assert.notEqual(row.checkpointReadFailed, true);
    assert.equal(row.checkpointContentHash, createHash('sha256').update(checkpoint).digest('hex').slice(0, 12));
  };
  const lock = await sql.reserve();
  let transactionOpen = false;
  let pending: ReturnType<typeof read> | undefined;
  let settled: Promise<unknown> | undefined;
  try {
    assertHealthy((await read()).result);
    await lock`BEGIN`;
    transactionOpen = true;
    // This table belongs to the disposable PG cluster. A row lock cannot stall SELECT.
    await lock`LOCK TABLE harness_shared.carry_notes IN ACCESS EXCLUSIVE MODE`;
    const [holder] = await lock`SELECT pg_backend_pid() AS pid`;
    const observeWait = async () => await sql<{ pid: number; backendStart: string; queryStart: string;
      state: string; waitEventType: string; blockingPids: number[] }[]>`
      SELECT pid, backend_start::text AS "backendStart", query_start::text AS "queryStart",
             state, wait_event_type AS "waitEventType", pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity WHERE datname = current_database()
         AND wait_event_type = 'Lock' AND query LIKE '%harness_shared.carry_notes%'
         AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid)) ORDER BY query_start LIMIT 2`;
    pending = read();
    // Consume a rejection even if correlation fails before awaiting the HTTP result.
    settled = pending.then(value => ({ value }), error => ({ error: String(error) }));
    const observeDeadline = performance.now() + 5_000;
    let wait: Awaited<ReturnType<typeof observeWait>>[number] | undefined;
    while (performance.now() < observeDeadline) {
      const rows = await observeWait();
      assert.ok(rows.length <= 1, 'multiple waits cannot identify the selected HTTP read');
      if (rows[0]) { wait = rows[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(wait, 'the actual HTTP checkpoint read must reach the held PostgreSQL table');
    assert.ok(wait.blockingPids.includes(Number(holder.pid)));
    const observedAtMs = performance.now();
    await snapshot('selected-http-wait', { holderPid: Number(holder.pid), wait, observedAtMs });
    const timed = await pending;
    const row = timed.result.results[0];
    assert.notEqual(row.availability, 'absent', 'a stalled read is not evidence of absence');
    const unavailable = row.ok === false && row.availability === 'unavailable'
      && row.error === 'timeout' && row.retryable === true;
    const disclosedCheckpointFailure = row.ok === true && row.checkpointReadFailed === true
      && row.checkpointChecks === null && row.checkpointBody === null && row.checkpointContentHash === null;
    assert.ok(unavailable || disclosedCheckpointFailure,
      'a read deadline must retain explicit unknown checkpoint state, never healthy or empty measurements');
    assert.ok(timed.completedAtMs >= observedAtMs);
    assert.ok(timed.completedAtMs - timed.startedAtMs <= 40_000,
      'the maintained 30-second read budget must finish before the 45-second transport deadline');
    const stillWaiting = await observeWait();
    await snapshot('http-deadline-returned', { holderPid: Number(holder.pid), stillWaiting });
    await lock`ROLLBACK`;
    transactionOpen = false;
    const afterRollback = await snapshot('post-rollback', { holderPid: Number(holder.pid) });
    const holderAfterRollback = afterRollback.activity.find(row => row.pid === Number(holder.pid));
    assert.ok(holderAfterRollback, 'retain the exact reserved holder after rollback');
    assert.equal(holderAfterRollback.xactStart, null, 'rollback must end the selected holder transaction');
    assert.equal(afterRollback.locks.some(row => row.pid === Number(holder.pid)
      && row.granted && row.mode === 'AccessExclusiveLock'), false,
    'direct readback must not start while the fixture still owns its table lock');
    const recovered = await read();
    assertHealthy(recovered.result);
    await snapshot('http-recovered');
    let readbackDone = false;
    const readback = getWorkItemCheckpoint({ workspaceId: o.workspace, harness: o.harness, workItemId: item.id })
      .then(value => ({ value }), error => ({ error }))
      .finally(() => { readbackDone = true; });
    // Observe the existing bounded reader, without replacing it or widening its
    // deadline. In particular, retain a lock waiter BEFORE PG cancels its query.
    for (let sample = 0; !readbackDone && sample < 24; sample++) {
      await snapshot('direct-readback-pending', { sample });
      if (!readbackDone) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const readbackResult = await readback;
    await snapshot('direct-readback-settled', 'error' in readbackResult
      ? { error: { message: String(readbackResult.error), code: readbackResult.error?.code,
        boundedPgReadTxn: readbackResult.error?.boundedPgReadTxn, stack: readbackResult.error?.stack } }
      : { exactReadback: readbackResult.value === checkpoint });
    if ('error' in readbackResult) throw readbackResult.error;
    assert.equal(readbackResult.value, checkpoint);
    const remainingWaits = await observeWait();
    assert.equal(remainingWaits.length, 0, 'the private read lock must leave no waiting query after rollback');
    const observation = { workspace: o.workspace, harness: o.harness, itemId: item.id,
      checkpoint, expectedSha: o.expectedSha, healthBefore, healthAfter: await health(),
      holderPid: Number(holder.pid), wait: { ...wait, observedAtMs }, timed, stillWaiting,
      afterRollback, recovered, exactReadback: true, remainingWaits };
    await writeFile(`${o.evidenceDir}/read-deadline-observation.json`, JSON.stringify(observation), { flag: 'wx' });
    return observation;
  } catch (error) {
    await snapshot('scenario-failed', { error: String(error) });
    throw error;
  } finally {
    try { if (transactionOpen) await lock`ROLLBACK`; } finally { lock.release(); }
    await settled;
    await sql`DELETE FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, item.id)}`;
    await sql`DELETE FROM harness_shared.work_items
      WHERE workspace_id = ${o.workspace} AND harness_slug = ${o.harness} AND feature_id = ${item.id}`;
  }
}
