/** Real SQLSTATE57014 from a positively identified disposable-cluster HTTP reader. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem } from '../lib/work-items';
import { workItemScope } from '../lib/carry-note';
import { getWorkItemCheckpoint, setWorkItemCheckpointWithPrior } from '../lib/work-item-checkpoint';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; expectedSha: string };

export async function measurePrivateReadPgErrorScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const { sql } = getOrgPg();
  const [cluster] = await sql`SELECT current_setting('data_directory') AS directory,
    inet_server_port() AS port, current_database() AS database`;
  assert.match(basename(String(cluster.directory)), /^papercusp-test-pg-/);
  assert.equal(Number(cluster.port), Number(process.env.PAPERCUSP_PG_PORT));
  assert.notEqual(Number(cluster.port), 5432);
  // Only this throwaway server is changed. Verbose PG logs retain SQLSTATE,
  // even though the public checkpoint contract intentionally exposes unknown.
  await sql`ALTER SYSTEM SET log_error_verbosity = 'verbose'`;
  const [reload] = await sql`SELECT pg_reload_conf() AS reloaded`;
  assert.equal(reload.reloaded, true);
  const diagnostics = `${o.evidenceDir}/read-pg-error-pg.ndjson`;
  await writeFile(diagnostics, '', { flag: 'wx' });
  const snapshot = async (stage: string, detail: Record<string, unknown> = {}) => {
    const activity = await sql`SELECT pid, state, xact_start::text AS "xactStart",
      query_start::text AS "queryStart", wait_event_type AS "waitEventType",
      pg_blocking_pids(pid) AS "blockingPids", left(query, 600) AS query
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
      ORDER BY pid LIMIT 32`;
    const locks = await sql`SELECT pid, mode, granted FROM pg_locks
      WHERE relation = 'harness_shared.carry_notes'::regclass ORDER BY pid, mode LIMIT 64`;
    const row = { stage, observedAtMs: performance.now(), activity, locks, ...detail };
    await appendFile(diagnostics, JSON.stringify(row) + '\n');
    return row;
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
  const item = await createWorkItem({ kind: 'feature', title: `P009 private PG error ${randomUUID()}`,
    summary: 'Disposable selected checkpoint read for real PostgreSQL cancellation evidence.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const checkpoint = `private read PG error ${randomUUID()}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: item.id }, checkpoint);
  let index = 0;
  const read = async () => {
    const requestIndex = index++;
    const startedAtMs = performance.now();
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers,
      signal: AbortSignal.timeout(45_000), body: JSON.stringify({ name: 'work_items:get', harness: o.harness,
        args: { id: item.id, harness: o.harness, checksOnly: true },
        callerSid: 'private-read-pg-error-' + o.workspace, confirmed: true }) });
    const envelope = await response.json() as any;
    const completedAtMs = performance.now();
    await writeFile(`${o.evidenceDir}/read-pg-error-request-${requestIndex}.json`,
      JSON.stringify({ status: response.status, envelope, startedAtMs, completedAtMs }), { flag: 'wx' });
    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true);
    assert.notEqual(envelope.result?.isError, true);
    const json = envelope.result?.content?.filter((part: any) => part.type === 'text'
      && typeof part.text === 'string' && part.text.trim().startsWith('{'));
    if (!envelope.result?.structuredContent) assert.equal(json?.length, 1);
    const result = envelope.result?.structuredContent ?? JSON.parse(json[0].text);
    assert.equal(result.results?.length, 1);
    assert.equal(result.results[0].id, item.id);
    return { status: response.status, result, startedAtMs, completedAtMs };
  };
  const healthy = (result: any) => {
    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, { ok: 1, failed: 0 });
    assert.equal(result.results[0].ok, true);
    assert.notEqual(result.results[0].checkpointReadFailed, true);
    assert.equal(result.results[0].checkpointContentHash,
      createHash('sha256').update(checkpoint).digest('hex').slice(0, 12));
  };
  const lock = await sql.reserve();
  let transactionOpen = false;
  let settled: Promise<unknown> | undefined;
  try {
    healthy((await read()).result);
    await lock`BEGIN`;
    transactionOpen = true;
    await lock`LOCK TABLE harness_shared.carry_notes IN ACCESS EXCLUSIVE MODE`;
    const [holder] = await lock`SELECT pg_backend_pid() AS pid`;
    const observeWait = async () => await sql`SELECT pid, backend_start::text AS "backendStart",
      query_start::text AS "queryStart", state, wait_event_type AS "waitEventType",
      pg_blocking_pids(pid) AS "blockingPids", query
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%harness_shared.carry_notes%'
        AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid)) ORDER BY query_start LIMIT 2`;
    const pending = read();
    settled = pending.then(value => ({ value }), error => ({ error: String(error) }));
    const deadline = performance.now() + 5_000;
    let wait: Awaited<ReturnType<typeof observeWait>>[number] | undefined;
    while (performance.now() < deadline) {
      const rows = await observeWait();
      assert.ok(rows.length <= 1, 'the selected HTTP checkpoint reader must be unambiguous');
      if (rows[0]) { wait = rows[0]; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(wait, 'the exact HTTP checkpoint SELECT must reach the private holder');
    assert.match(wait.query, /^\s*SELECT note, updated_ts,/);
    assert.notEqual(Number(wait.pid), Number(holder.pid));
    await snapshot('selected-http-wait', { holderPid: Number(holder.pid), wait, cluster });
    const cancelledAtMs = performance.now();
    // Revalidate both backend AND query generations at the mutation seat. Never
    // signal a PID copied from a broad/stale activity snapshot or a shared server.
    const cancellation = await sql`SELECT pid, pg_cancel_backend(pid) AS cancelled
      FROM pg_stat_activity WHERE datname = current_database() AND pid = ${Number(wait.pid)}
        AND backend_start::text = ${wait.backendStart} AND query_start::text = ${wait.queryStart}
        AND state = 'active' AND wait_event_type = 'Lock' AND query = ${wait.query}
        AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid))`;
    assert.equal(cancellation.length, 1);
    assert.equal(cancellation[0].cancelled, true);
    await snapshot('selected-pg-cancel-sent', { waitPid: Number(wait.pid), cancellation, cancelledAtMs });
    const failed = await pending;
    const row = failed.result.results[0];
    assert.notEqual(row.availability, 'absent', 'PG cancellation cannot establish item absence');
    const unavailable = row.ok === false && row.availability === 'unavailable'
      && row.pgCode === '57014' && row.retryable === true;
    const checkpointUnknown = row.ok === true && row.checkpointReadFailed === true
      && row.checkpointChecks === null && row.checkpointBody === null && row.checkpointContentHash === null
      && row.checkpointAgeMs === null && row.checkpointUpdatedAtMs === null;
    assert.ok(unavailable || checkpointUnknown, 'actual PG failure must preserve explicit unknown checkpoint state');
    assert.ok(failed.completedAtMs - cancelledAtMs < 5_000, 'PG error must settle before the read deadline');
    const afterError = await snapshot('http-pg-error-returned', { failed });
    assert.ok(afterError.locks.some(row => row.pid === Number(holder.pid)
      && row.granted && row.mode === 'AccessExclusiveLock'), 'error must return while the selected holder still owns its lock');
    await lock`ROLLBACK`;
    transactionOpen = false;
    const afterRollback = await snapshot('post-rollback', { holderPid: Number(holder.pid) });
    assert.equal(afterRollback.activity.find(row => row.pid === Number(holder.pid))?.xactStart, null);
    assert.equal(afterRollback.locks.some(row => row.pid === Number(holder.pid)
      && row.granted && row.mode === 'AccessExclusiveLock'), false);
    const recovered = await read();
    healthy(recovered.result);
    let done = false;
    const readback = getWorkItemCheckpoint({ workspaceId: o.workspace, harness: o.harness, workItemId: item.id })
      .then(value => ({ value }), error => ({ error })).finally(() => { done = true; });
    for (let sample = 0; !done && sample < 24; sample++) {
      await snapshot('direct-readback-pending', { sample });
      if (!done) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const result = await readback;
    await snapshot('direct-readback-settled', 'error' in result
      ? { error: String(result.error), pgCode: result.error?.code } : { exactReadback: result.value === checkpoint });
    if ('error' in result) throw result.error;
    assert.equal(result.value, checkpoint);
    const remainingWaits = await observeWait();
    assert.equal(remainingWaits.length, 0);
    const receipt = { workspace: o.workspace, harness: o.harness, itemId: item.id, expectedSha: o.expectedSha,
      cluster, holderPid: Number(holder.pid), wait, cancelledAtMs, cancellation, failed,
      afterRollback, recovered, exactReadback: true, remainingWaits, healthBefore, healthAfter: await health() };
    await writeFile(`${o.evidenceDir}/read-pg-error-observation.json`, JSON.stringify(receipt), { flag: 'wx' });
    return receipt;
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
