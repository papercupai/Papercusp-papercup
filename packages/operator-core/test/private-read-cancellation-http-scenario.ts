/** Real caller disconnect while a selected private checkpoint read waits in PG. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem } from '../lib/work-items';
import { workItemScope } from '../lib/carry-note';
import { getWorkItemCheckpoint, setWorkItemCheckpointWithPrior } from '../lib/work-item-checkpoint';

type Options = { workspace: string; harness: string; base: string;
  headers: Record<string, string>; evidenceDir: string; expectedSha: string };

export async function measurePrivateReadCancellationScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  const { sql } = getOrgPg();
  const diagnostics = `${o.evidenceDir}/read-cancellation-pg.ndjson`;
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
  const until = async <T>(probe: () => Promise<T | undefined>, message: string) => {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(message);
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
  const item = await createWorkItem({ kind: 'feature', title: `P009 private cancellation ${randomUUID()}`,
    summary: 'Disposable selected read for actual HTTP caller-disconnect evidence.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const checkpoint = `private read cancellation ${randomUUID()}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: item.id }, checkpoint);
  let index = 0;
  const read = async (signal = AbortSignal.timeout(45_000)) => {
    const requestIndex = index++;
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', { method: 'POST', headers: o.headers, signal,
      body: JSON.stringify({ name: 'work_items:get', harness: o.harness,
        args: { id: item.id, harness: o.harness, checksOnly: true },
        callerSid: 'private-read-cancellation-' + o.workspace, confirmed: true }) });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/read-cancellation-request-${requestIndex}.json`,
      JSON.stringify({ status: response.status, envelope }), { flag: 'wx' });
    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true);
    assert.notEqual(envelope.result?.isError, true);
    const json = envelope.result?.content?.filter((part: any) => part.type === 'text'
      && typeof part.text === 'string' && part.text.trim().startsWith('{'));
    const result = envelope.result?.structuredContent ?? (json?.length === 1 ? JSON.parse(json[0].text) : undefined);
    assert.equal(result?.ok, true);
    assert.deepEqual(result.counts, { ok: 1, failed: 0 });
    assert.equal(result.results[0].id, item.id);
    assert.equal(result.results[0].checkpointContentHash,
      createHash('sha256').update(checkpoint).digest('hex').slice(0, 12));
    return { status: response.status, result };
  };
  const invocationRows = async (after: string) => await sql<{ id: string; status: string;
    errorCode: string | null; errorMessage: string | null; durationMs: number;
    metadata: { resultOutcome?: string; softFailureReason?: string } | null }[]>`
    SELECT id::text, status, error_code AS "errorCode", error_message AS "errorMessage",
      duration_ms AS "durationMs", metadata_json AS metadata
    FROM harness_shared.tool_invocations WHERE workspace_id = ${o.workspace}
      AND tool_name = 'work_items:get' AND transport = 'http'
      AND args_json->>'id' = ${item.id} AND id > ${after}::bigint ORDER BY id LIMIT 2`;
  const lock = await sql.reserve();
  let transactionOpen = false;
  let clientSettled: Promise<{ value?: unknown; error?: { name: string; message: string } }> | undefined;
  try {
    await read();
    const baseline = await until(async () => (await invocationRows('0'))[0], 'healthy HTTP invocation must be persisted first');
    await lock`BEGIN`;
    transactionOpen = true;
    await lock`LOCK TABLE harness_shared.carry_notes IN ACCESS EXCLUSIVE MODE`;
    const [holder] = await lock`SELECT pg_backend_pid() AS pid`;
    const controller = new AbortController();
    clientSettled = read(AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]))
      .then(value => ({ value }), error => ({ error: { name: String(error.name), message: String(error.message) } }));
    const wait = await until(async () => {
      const rows = await sql`SELECT pid, backend_start::text AS "backendStart", query_start::text AS "queryStart",
        state, wait_event_type AS "waitEventType", pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%harness_shared.carry_notes%'
          AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid)) ORDER BY query_start LIMIT 2`;
      assert.ok(rows.length <= 1, 'the selected HTTP reader must be unambiguous');
      return rows[0];
    }, 'actual HTTP read must reach the exact held PostgreSQL table before disconnect');
    await snapshot('selected-http-wait', { holderPid: Number(holder.pid), wait });
    const abortedAtMs = performance.now();
    controller.abort(new DOMException('private HTTP caller disconnected', 'AbortError'));
    const clientResult = await clientSettled;
    assert.equal(clientResult.error?.name, 'AbortError', 'a real client abort must reject the HTTP request');
    const ledger = await until(async () => {
      const rows = await invocationRows(baseline.id);
      assert.ok(rows.length <= 1, 'one completed invocation must identify the disconnected request');
      return rows[0];
    }, 'governed cancellation must settle in the invocation ledger before the30s read deadline');
    const serverSettledAtMs = performance.now();
    await snapshot('cancellation-settled', { clientResult, ledger, abortedAtMs, serverSettledAtMs });
    // Writer contract: status is CALL-level. Only explicit cancellation in its
    // error code or effect metadata establishes the server observed disconnect.
    assert.ok(ledger.errorCode === 'aborted' || (ledger.metadata?.resultOutcome === 'soft-failure'
      && ledger.metadata.softFailureReason === 'cancelled'), 'client rejection alone is not server cancellation evidence');
    assert.ok(serverSettledAtMs - abortedAtMs < 5_000);
    // A cancellation disposition can settle while its SQL is still running.
    // Keep the holder locked: rollback would otherwise release the query and
    // let a leaked read masquerade as successful cancellation cleanup.
    const releaseDeadline = performance.now() + 5_000;
    let queryReleasedAtMs: number | undefined;
    while (performance.now() < releaseDeadline) {
      const active = await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${Number(wait.pid)}
        AND backend_start::text = ${wait.backendStart} AND query_start::text = ${wait.queryStart}
        AND state = 'active'`;
      if (active.length === 0) { queryReleasedAtMs = performance.now(); break; }
      await snapshot('pg-query-still-active-before-rollback', { wait });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const beforeRollback = await snapshot('pg-query-release-check', { queryReleasedAtMs, wait });
    assert.ok(beforeRollback.locks.some(row => row.pid === Number(holder.pid)
      && row.granted && row.mode === 'AccessExclusiveLock'), 'query release must be checked while the exact holder is still locked');
    assert.ok(queryReleasedAtMs !== undefined,
      'governed cancellation must stop the exact PostgreSQL query before the fixture rolls back its holder');
    await lock`ROLLBACK`;
    transactionOpen = false;
    const afterRollback = await snapshot('post-rollback', { holderPid: Number(holder.pid) });
    assert.equal(afterRollback.activity.find(row => row.pid === Number(holder.pid))?.xactStart, null);
    assert.equal(afterRollback.locks.some(row => row.pid === Number(holder.pid)
      && row.granted && row.mode === 'AccessExclusiveLock'), false);
    const recovered = await read();
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
    const remainingWaits = await sql`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid))`;
    assert.equal(remainingWaits.length, 0);
    const receipt = { workspace: o.workspace, harness: o.harness, itemId: item.id, expectedSha: o.expectedSha,
      holderPid: Number(holder.pid), wait, abortedAtMs, serverSettledAtMs, clientResult, ledger,
      queryReleasedAtMs, beforeRollback, afterRollback, recovered,
      exactReadback: true, remainingWaits, healthBefore, healthAfter: await health() };
    await writeFile(`${o.evidenceDir}/read-cancellation-observation.json`, JSON.stringify(receipt), { flag: 'wx' });
    return receipt;
  } catch (error) {
    await snapshot('scenario-failed', { error: String(error) });
    throw error;
  } finally {
    try { if (transactionOpen) await lock`ROLLBACK`; } finally { lock.release(); }
    await clientSettled;
    await sql`DELETE FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, item.id)}`;
    await sql`DELETE FROM harness_shared.work_items
      WHERE workspace_id = ${o.workspace} AND harness_slug = ${o.harness} AND feature_id = ${item.id}`;
  }
}
