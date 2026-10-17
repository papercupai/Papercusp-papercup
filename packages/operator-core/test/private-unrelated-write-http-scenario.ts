/** Real private HTTP control for the P-009 unrelated-write responsiveness bar. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { createWorkItem } from '../lib/work-items';
import { workItemScope } from '../lib/carry-note';
import { getWorkItemCheckpoint, setWorkItemCheckpointWithPrior } from '../lib/work-item-checkpoint';
import { assertPrivateUnrelatedCheckpointObservation, type PrivateUnrelatedCheckpointObservation } from './private-http-workspace-preflight';

type Options = {
  workspace: string;
  harness: string;
  base: string;
  headers: Record<string, string>;
  evidenceDir: string;
  expectedSha: string;
};

type Activity = PrivateUnrelatedCheckpointObservation['stallBefore'];
type ActivityRow = {
  pid: number;
  backendStart: string;
  queryStart: string;
  state: string;
  waitEventType: string;
  query: string;
  blockingPids: number[];
};

function receiptFromEnvelope(envelope: any) {
  const structured = envelope.result?.structuredContent;
  if (structured) return structured;
  const json = envelope.result?.content?.filter((part: any) =>
    part.type === 'text' && typeof part.text === 'string' && part.text.trim().startsWith('{'));
  if (!json || json.length !== 1) return undefined;
  try { return JSON.parse(json[0].text); } catch { return undefined; }
}

export async function measurePrivateUnrelatedCheckpointScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  assert.ok(o.expectedSha, 'the scenario must be pinned to the initial health build');
  const { sql } = getOrgPg();
  const requests: Array<Record<string, unknown>> = [];
  let requestIndex = 0;
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const index = requestIndex++;
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name, args, harness: o.harness,
        callerSid: 'private-unrelated-write-' + o.workspace, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/unrelated-request-${index}.json`,
      JSON.stringify({ name, args, status: response.status, envelope }), { flag: 'wx' });
    const result = receiptFromEnvelope(envelope);
    requests.push({ name, status: response.status, result, isError: envelope.result?.isError === true });
    return { response, envelope, result };
  };

  const healthBeforeResponse = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
  const healthBefore = await healthBeforeResponse.json() as { service: string; sha: string; bundleStale?: unknown };
  assert.equal(healthBeforeResponse.status, 200, JSON.stringify(healthBefore));
  assert.equal(healthBefore.sha, o.expectedSha);

  const suffix = randomUUID();
  const stalled = await createWorkItem({ kind: 'feature', title: `P009 private stalled item ${suffix}`,
    summary: 'Disposable row used only to demonstrate an observed continuing lock wait.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const unrelated = await createWorkItem({ kind: 'feature', title: `P009 private unrelated item ${suffix}`,
    summary: 'Disposable row receiving the unrelated checkpoint write.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const decoy = await createWorkItem({ kind: 'feature', title: `P009 private decoy item ${suffix}`,
    summary: 'An older competing wait must not qualify as the selected stalled item.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const stalledCheckpoint = `private stalled checkpoint ${suffix}`;
  const targetCheckpoint = `private unrelated checkpoint ${suffix}`;
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: stalled.id }, stalledCheckpoint);
  await setWorkItemCheckpointWithPrior({ workspaceId: o.workspace, harness: o.harness, workItemId: decoy.id }, 'decoy');

  const lock = await sql.reserve();
  const decoyLock = await sql.reserve();
  const decoyWaiter = await sql.reserve();
  let blocker: Promise<{ value?: unknown; error?: unknown }> | undefined;
  let decoyPending: Promise<unknown> | undefined;
  try {
    await lock`BEGIN`;
    const lockedRows = await lock`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, stalled.id)} FOR UPDATE`;
    assert.equal(lockedRows.length, 1, 'the selected private carry row must actually be locked');
    assert.equal(lockedRows[0].scope, workItemScope(o.harness, stalled.id));
    const [holder] = await lock`SELECT pg_backend_pid() AS pid`;
    const [decoyBackend] = await decoyWaiter`SELECT pg_backend_pid() AS pid`;
    await decoyLock`BEGIN`;
    const decoyRows = await decoyLock`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, decoy.id)} FOR UPDATE`;
    assert.equal(decoyRows.length, 1);
    decoyPending = decoyWaiter`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, decoy.id)} FOR UPDATE`
      .then(value => ({ value }), error => ({ error }));
    const waitUntil = async <T>(read: () => Promise<T | undefined>, label: string) => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        const found = await read();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(label);
    };
    const decoyWait = await waitUntil(async () => {
      const rows = await sql<{ pid: number; queryStart: string }[]>`SELECT pid, query_start::text AS "queryStart"
        FROM pg_stat_activity WHERE pid = ${decoyBackend.pid} AND state = 'active' AND wait_event_type = 'Lock'`;
      return rows[0];
    }, 'older competing wait must be observed before dispatching the selected blocked request');
    blocker = invoke('work_items:checkpoint', { id: stalled.id, harness: o.harness, checkpoint: `blocked ${suffix}` })
      .then(value => ({ value }), error => ({ error }));

    const activity = async (): Promise<Activity | undefined> => {
      const rows = await sql<ActivityRow[]>`SELECT pid,
          backend_start::text AS "backendStart", query_start::text AS "queryStart",
          state, wait_event_type AS "waitEventType", query, pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock' AND query LIKE '%harness_shared.carry_notes%'
         AND ${Number(holder.pid)} = ANY(pg_blocking_pids(pid))
       ORDER BY query_start ASC LIMIT 2`;
      assert.ok(rows.length <= 1, 'multiple queries blocked by the selected holder are ambiguous');
      const row = rows[0];
      if (!row) return undefined;
      assert.ok(row.blockingPids.includes(Number(holder.pid)),
        'observed query must be blocked by the exact selected row-lock holder, not the older decoy');
      return { observedAtMs: performance.now(), itemId: stalled.id, pid: Number(row.pid),
        backendStart: row.backendStart, queryStart: row.queryStart, state: row.state,
        waitEventType: row.waitEventType };
    };
    const stallBefore = await waitUntil(activity, 'selected lock wait must be observed');
    assert.ok(stallBefore, 'blocked unrelated control must expose a real PostgreSQL lock wait');
    assert.notEqual(stallBefore.pid, Number(decoyWait.pid));

    const startedAtMs = performance.now();
    const unrelatedResult = await invoke('work_items:checkpoint', {
      id: unrelated.id, harness: o.harness, checkpoint: targetCheckpoint,
    });
    const completedAtMs = performance.now();
    const stallAfter = await activity();
    assert.ok(stallAfter, 'the original blocked query must still be waiting after unrelated completion');
    const readbackCheckpoint = await getWorkItemCheckpoint({ workspaceId: o.workspace, harness: o.harness, workItemId: unrelated.id });
    const healthAfterResponse = await fetch(o.base + '/api/health', { headers: o.headers, signal: AbortSignal.timeout(2_000) });
    const healthAfter = await healthAfterResponse.json() as { service: string; sha: string; bundleStale?: unknown };
    const observation: PrivateUnrelatedCheckpointObservation = {
      workspace: o.workspace, base: o.base, expectedBuildSha: o.expectedSha,
      healthBefore, healthAfter, itemId: unrelated.id, harness: o.harness,
      checkpoint: targetCheckpoint, startedAtMs, completedAtMs,
      stallBefore, stallAfter, response: { status: unrelatedResult.response.status, envelope: unrelatedResult.envelope },
      readback: { observedAtMs: performance.now(), workspace: o.workspace, harness: o.harness,
        itemId: unrelated.id, checkpoint: readbackCheckpoint ?? '' },
    };
    assertPrivateUnrelatedCheckpointObservation(observation);
    await writeFile(`${o.evidenceDir}/unrelated-observation.json`, JSON.stringify(observation), { flag: 'wx' });
    return { workspace: o.workspace, stalledItemId: stalled.id, unrelatedItemId: unrelated.id,
      correlation: { holderPid: Number(holder.pid), lockedScope: lockedRows[0].scope,
        decoyPid: Number(decoyWait.pid), decoyQueryStart: decoyWait.queryStart,
        selectedPid: stallBefore.pid, selectedQueryStart: stallBefore.queryStart },
      requests, observation, hostStopped: false };
  } finally {
    try {
      try { await lock`ROLLBACK`; } finally { lock.release(); }
    } finally {
      try { await decoyLock`ROLLBACK`; } finally { decoyLock.release(); }
      try { await decoyPending; } finally { decoyWaiter.release(); }
      if (blocker) await blocker;
      await sql`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${o.workspace}
        AND scope IN (${workItemScope(o.harness, stalled.id)}, ${workItemScope(o.harness, unrelated.id)}, ${workItemScope(o.harness, decoy.id)})`;
      await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${o.workspace}
        AND harness_slug = ${o.harness} AND feature_id IN (${stalled.id}, ${unrelated.id}, ${decoy.id})`;
    }
  }
}

/** Both HTTP appends must merge against the row read inside their locked transaction. */
export async function measurePrivateSameItemCheckpointScenario(o: Options) {
  assert.match(o.workspace, /^test-runtime-/);
  assert.ok(o.expectedSha);
  const { sql } = getOrgPg();
  const nonce = randomUUID();
  const item = await createWorkItem({ kind: 'feature', title: `P009 private same-item ${nonce}`,
    summary: 'Disposable row for two concurrent HTTP checkpoint appends.',
    harness: o.harness, workspaceId: o.workspace, createdBy: 'private-http-fixture' });
  const ref = { workspaceId: o.workspace, harness: o.harness, workItemId: item.id };
  const baseline = `private same-item baseline ${nonce}`;
  const additions = [`private first append ${nonce}`, `private second append ${nonce}`];
  await setWorkItemCheckpointWithPrior(ref, baseline);
  const holder = await sql.reserve();
  const requests: Array<Promise<{ status: number; envelope: any; result: any }>> = [];
  let released = false;
  const health = async () => {
    const response = await fetch(o.base + '/api/health', { headers: o.headers,
      signal: AbortSignal.timeout(2_000) });
    const body = await response.json() as { sha: string };
    assert.equal(response.status, 200);
    assert.equal(body.sha, o.expectedSha);
    return body;
  };
  const invoke = async (index: number) => {
    const response = await fetch(o.base + '/api/agent-mcp/run-tool', {
      method: 'POST', headers: o.headers,
      body: JSON.stringify({ name: 'work_items:checkpoint',
        args: { id: item.id, harness: o.harness, checkpoint: additions[index], append: true },
        harness: o.harness, callerSid: `private-same-item-${o.workspace}-${index}`, confirmed: true }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = await response.json() as any;
    await writeFile(`${o.evidenceDir}/same-item-request-${index}.json`,
      JSON.stringify({ index, status: response.status, envelope }), { flag: 'wx' });
    return { status: response.status, envelope, result: receiptFromEnvelope(envelope) };
  };
  try {
    const healthBefore = await health();
    await holder`BEGIN`;
    const rows = await holder`SELECT scope FROM harness_shared.carry_notes
      WHERE workspace_id = ${o.workspace} AND scope = ${workItemScope(o.harness, item.id)} FOR UPDATE`;
    assert.equal(rows.length, 1);
    const [backend] = await holder`SELECT pg_backend_pid() AS pid`;
    const holderPid = Number(backend.pid);
    const waitFor = async (blockers: number[], exclude: number[] = []) => {
      const deadline = performance.now() + 2_000;
      while (performance.now() < deadline) {
        const waits = await sql<ActivityRow[]>`SELECT pid,
          backend_start::text AS "backendStart", query_start::text AS "queryStart",
          state, wait_event_type AS "waitEventType", query, pg_blocking_pids(pid) AS "blockingPids"
          FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'
            AND wait_event_type = 'Lock' AND query LIKE '%harness_shared.carry_notes%'
            AND pid <> pg_backend_pid()`;
        const selected = waits.filter(row => !exclude.includes(Number(row.pid)) &&
          row.blockingPids.some(pid => blockers.includes(Number(pid))));
        assert.ok(selected.length <= 1, 'same-item waiter correlation must be unambiguous');
        if (selected[0]) return selected[0];
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('both HTTP appends must reach the exact held carry-row lock before release');
    };
    requests.push(invoke(0));
    const firstWait = await waitFor([holderPid]);
    requests.push(invoke(1));
    const secondWait = await waitFor([holderPid, Number(firstWait.pid)], [Number(firstWait.pid)]);
    assert.notEqual(firstWait.pid, secondWait.pid);
    const releasedAtMs = performance.now();
    await holder`ROLLBACK`;
    released = true;
    const responses = await Promise.all(requests);
    const completedAtMs = performance.now();
    const readback = await getWorkItemCheckpoint(ref);
    const expected = [baseline, ...additions].join('\n\n---\n');
    assert.equal(readback, expected, 'the second queued append must retain the first committed append exactly once');
    const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
    const expectedHashes = [hash([baseline, additions[0]].join('\n\n---\n')), hash(expected)];
    const receipts = responses.map((response, index) => {
      assert.equal(response.status, 200);
      const result = response.result?.results?.find((row: any) => row.id === item.id);
      assert.ok(result, 'each HTTP response must identify the same private work item');
      if (result.ok === true) {
        assert.equal(result.verified, true);
        assert.equal(result.contentHash, expectedHashes[index]);
      } else {
        // A later committed append can outrun the first read-after-write verifier.
        // That is an explicit committed conflict, never permission to replay a write.
        assert.equal(index, 0);
        assert.equal(result.errorCode, 'checkpoint_verify_failed');
        assert.equal(result.writeCommitted, true);
        assert.equal(result.retryable, false);
        assert.equal(result.storedContentHash, expectedHashes[0]);
        assert.equal(result.readBackContentHash, expectedHashes[1]);
        assert.equal(result.recovery?.verify?.tool, 'work_items:get');
      }
      return result;
    });
    const healthAfter = await health();
    const observation = { workspace: o.workspace, harness: o.harness, itemId: item.id,
      expectedSha: o.expectedSha, healthBefore, healthAfter, holderPid, firstWait, secondWait,
      releasedAtMs, completedAtMs, receipts, baseline, additions, readback,
      readbackContentHash: hash(readback), hostStopped: false };
    await writeFile(`${o.evidenceDir}/same-item-observation.json`, JSON.stringify(observation), { flag: 'wx' });
    return observation;
  } finally {
    try { if (!released) await holder`ROLLBACK`; } finally { holder.release(); }
    await Promise.allSettled(requests);
    await sql`DELETE FROM harness_shared.carry_notes WHERE workspace_id = ${o.workspace}
      AND scope = ${workItemScope(o.harness, item.id)}`;
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${o.workspace}
      AND harness_slug = ${o.harness} AND feature_id = ${item.id}`;
  }
}
