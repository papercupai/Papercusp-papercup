/**
 * readTriggerOperationPayload against real Postgres
 * (app-agent-tasks-durable-execution-2026-10-06 D-006).
 *
 * A trigger-fired blueprint operation has no plan run, so its worker reads the
 * private ingest by the work item the operation created. The join is the trust
 * boundary, so it is exercised against the real schema rather than a stub:
 * only an invocation the binding engine minted for THAT trigger run
 * (caller trigger-binding:<bindingId>, request key trigger-run:<runId>) resolves,
 * and only inside the caller's workspace.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readTriggerOperationPayload } from './plan-run-payload';

const WS = 'ws-trigger-operation-payload';
const OTHER_WS = 'ws-trigger-operation-payload-other';
// request_fingerprint and specification_revision are CHECKed as 64-char lowercase hex.
const HEX64 = 'a'.repeat(64);

let org: OrgTestDb;
let sql: Sql;
let bindingId: string;
let otherBindingId: string;
let runId: string;
let otherRunId: string;

async function binding(sourceId: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings (workspace_id, source_id, event_pattern, action)
    VALUES (${WS}, ${sourceId}::uuid, 'ext:gmail:message.received',
            ${JSON.stringify({
              type: 'blueprint-operation',
              operationHarnessSlug: 'email',
              operationId: 'draft-reply-for-trigger',
            })}::text::jsonb)
    RETURNING id::text`;
  return rows[0]!.id;
}

async function triggerRun(forBinding: string, dedupeKey: string, status: string): Promise<string> {
  const args = {
    trigger: {
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId: '00000000-0000-4000-8000-000000000001',
      externalId: `msg-${dedupeKey}`,
      occurredAt: '2026-10-06T09:00:00.000Z',
      dedupeKey,
      payload: { text: `PRIVATE BODY ${dedupeKey}`, from: 'alice@example.com' },
    },
  };
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_runs (workspace_id, binding_id, dedupe_key, status, args)
    VALUES (${WS}, ${forBinding}::uuid, ${dedupeKey}, ${status}, ${JSON.stringify(args)}::text::jsonb)
    RETURNING id::text`;
  return rows[0]!.id;
}

async function invocation(opts: {
  workspaceId?: string;
  callerId: string;
  requestKey: string;
  workItemId: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.blueprint_operation_invocations
      (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
       specification_revision, target_kind, target_ref)
    VALUES (${opts.workspaceId ?? WS}, 'email', ${opts.callerId}, 'draft-reply-for-trigger',
            ${opts.requestKey}, ${HEX64}, ${HEX64}, 'work-item', ${opts.workItemId})`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'gmail', 'connected') RETURNING id::text`;
  bindingId = await binding(sources[0]!.id);
  otherBindingId = await binding(sources[0]!.id);
  // 'running': the invocation row is written in the submit transaction, before
  // the engine marks the trigger run succeeded — a prompt worker must resolve it.
  runId = await triggerRun(bindingId, 'gmail:op-1', 'running');
  otherRunId = await triggerRun(otherBindingId, 'gmail:op-2', 'succeeded');

  // The genuine engine-minted invocation.
  await invocation({ callerId: `trigger-binding:${bindingId}`, requestKey: `trigger-run:${runId}`, workItemId: 'WI-900001' });
  // A non-binding caller reusing a trigger-run request key must not resolve.
  await invocation({ callerId: 'su-forger', requestKey: `trigger-run:${otherRunId}`, workItemId: 'WI-900002' });
  // A binding naming ANOTHER binding's trigger run must not resolve.
  await invocation({ callerId: `trigger-binding:${bindingId}`, requestKey: `trigger-run:${otherRunId}`, workItemId: 'WI-900003' });
  // The same genuine pair recorded under a different workspace must not resolve.
  await invocation({
    workspaceId: OTHER_WS,
    callerId: `trigger-binding:${bindingId}`,
    requestKey: `trigger-run:${runId}`,
    workItemId: 'WI-900004',
  });
});

afterAll(async () => {
  await org?.cleanup();
});

describe('readTriggerOperationPayload (real schema)', () => {
  it('resolves the private payload for the engine-minted invocation, even before the run is marked succeeded', async () => {
    const result = await readTriggerOperationPayload(sql, WS, 'WI-900001');
    expect(result.triggerRunId).toBe(runId);
    expect(result.externalId).toBe('msg-gmail:op-1');
    expect(result.payload.text).toBe('PRIVATE BODY gmail:op-1');
  });

  it('refuses an invocation whose caller is not the trigger binding', async () => {
    await expect(readTriggerOperationPayload(sql, WS, 'WI-900002')).rejects.toThrow(
      'trigger_payload_operation_not_found:WI-900002',
    );
  });

  it("refuses a binding's invocation that names another binding's trigger run", async () => {
    await expect(readTriggerOperationPayload(sql, WS, 'WI-900003')).rejects.toThrow(
      'trigger_payload_operation_not_found:WI-900003',
    );
  });

  it('never resolves across workspaces', async () => {
    await expect(readTriggerOperationPayload(sql, OTHER_WS, 'WI-900004')).rejects.toThrow(
      'trigger_payload_operation_not_found:WI-900004',
    );
    await expect(readTriggerOperationPayload(sql, OTHER_WS, 'WI-900001')).rejects.toThrow(
      'trigger_payload_operation_not_found:WI-900001',
    );
  });
});
