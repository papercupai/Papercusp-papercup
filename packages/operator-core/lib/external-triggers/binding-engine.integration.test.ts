import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from '../blueprint/project-to-pg';
import { submitBlueprintOperation } from '../blueprint/operation-service';
import { runBlueprintOperationAction } from '../harness/routines/blueprint-operation-action';
import type { StartGoalByIdResult } from '../goals/start-goal-by-id';
import { upsertDatatype } from '../datatype-registry-store';
import type { CreateWorkItemInput, WorkItem } from '../work-items';
import {
  dispatchPendingTriggerRuns,
  directWorkItemTriggerRef,
  EMAIL_DRAFT_PROPOSAL_HARNESS,
  EMAIL_DRAFT_PROPOSAL_KIND,
  EMAIL_DRAFT_PROPOSAL_SCHEMA_VERSION,
  triggerRunPlanToken,
  type TriggerDispatchDeps,
} from './binding-engine';
import type { ScheduledPlanFireRefusal, ScheduledPlanFireStartedResult } from '../harness/routines/plan-run-action';
import { readTriggerPlanRunPayload } from './plan-run-payload';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual,
    getOrgPg: () => ({ sql: h.sql }) };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PLAN = 'triage-external-event';

const EMAIL_DRAFT_PAYLOAD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messageId', 'threadId', 'from', 'to', 'subject', 'text', 'policy'],
  properties: {
    messageId: { type: 'string', minLength: 1 },
    threadId: { type: 'string', minLength: 1 },
    from: { type: 'string', minLength: 1 },
    to: { type: 'array', items: { type: 'string', minLength: 1 } },
    subject: { type: 'string' },
    text: { type: 'string' },
    policy: {
      type: 'object',
      additionalProperties: false,
      required: ['draftOnly'],
      properties: { draftOnly: { const: true } },
    },
    triggerRef: { type: 'string' },
  },
};

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;
let bindingId: string;
let deliveryId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const migration = readFileSync(
    path.join(REPO, 'libs/papercusp/libs/db/sql/878-external-trigger-dispatch-routine.sql'),
    'utf8',
  );
  await sql.unsafe(migration);
  const operationMigration = path.join(
    REPO,
    'libs/papercusp/libs/db/sql/1228-blueprint-operation-automation-bindings.sql',
  );
  await sql.unsafe(readFileSync(existsSync(operationMigration) ? operationMigration : `${operationMigration}.DRAFT`, 'utf8'));
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, 'Triage event', 'active',
            ${`---\nslug: ${PLAN}\n---\n# Triage event`}, 'trigger-plan-v1',
            ${JSON.stringify([{ id: 'P-001', text: 'Handle trigger payload', status: 'todo' }])}::text::jsonb)`;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'gmail', 'connected') RETURNING id`;
  sourceId = sources[0].id;
  const bindings = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       event_filter, action, armed, storm_policy)
    VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
            '{}'::jsonb, '{"type":"launch-plan"}'::jsonb, TRUE, '{}'::jsonb)
    RETURNING id`;
  bindingId = bindings[0].id;
  const deliveries = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, completed_at)
    VALUES (${WS}, ${sources[0].id}, 'gmail:dispatch-1', 'email-message',
            'ext:gmail:message.received', '{"id":"dispatch-1"}'::jsonb,
            'event-bus', 'workspace', 'delivered', 1, now())
    RETURNING id`;
  deliveryId = deliveries[0].id;
});

async function seedTriggerRun(over: {
  status?: string;
  attempts?: number;
  startedAt?: string;
  args?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  bindingId?: string;
} = {}): Promise<string> {
  const args = over.args ?? {
    trigger: {
      key: 'ext:gmail:message.received', source: 'gmail', event: 'message.received',
      sourceId: 'source-fixture', externalId: 'dispatch-1', occurredAt: null,
      datatypeId: 'email-message', dedupeKey: 'gmail:dispatch-1',
      payload: { id: 'dispatch-1', subject: 'Triage this' },
    },
  };
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, delivery_id, dedupe_key, status, args, outcome, attempts, started_at)
    VALUES (${WS}, ${over.bindingId ?? bindingId}, ${deliveryId}, ${(args.trigger as { dedupeKey?: string })?.dedupeKey ?? 'gmail:dispatch-1'}, ${over.status ?? 'pending'},
            ${JSON.stringify(args)}::text::jsonb, ${JSON.stringify(over.outcome ?? {})}::text::jsonb,
            ${over.attempts ?? 0}, ${over.startedAt ?? null}::timestamptz)
    RETURNING id`;
  return rows[0].id;
}

function planRunRefusal(overrides: Partial<ScheduledPlanFireRefusal> = {}): ScheduledPlanFireRefusal {
  return {
    started: false,
    instanceSlug: '',
    runId: -1,
    runSeq: -1,
    minted: 0,
    workItemIds: [],
    actionableWorkItemIds: [],
    replayed: false,
    reason: 'not-startable',
    detail: 'plan fire refused',
    retryable: false,
    ...overrides,
  };
}

function startedPlanRun(triggerRunId: string, runId: number): ScheduledPlanFireStartedResult {
  return {
    started: true,
    instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
    runId,
    runSeq: 0,
    minted: 1,
    workItemIds: [],
    actionableWorkItemIds: [],
    replayed: false,
  };
}

describe('external trigger durable dispatch', () => {
  it('replays event and routine fires for two typed neutral consumers without plan runs', async () => {
    const consumers = [
      { harness: 'neutral-trigger-text', operationId: 'extract', field: 'value',
        value: 'alpha' as string | number, resultField: 'answer', resultType: 'string' },
      { harness: 'neutral-trigger-count', operationId: 'score', field: 'count',
        value: 7 as string | number, resultField: 'score', resultType: 'integer' },
    ];
    await sql`
      INSERT INTO harness_shared.pots
        (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${WS}, ${consumers[0]!.harness}, ${Buffer.from([1])}, 'kc-neutral-trigger-text', 0),
             (${WS}, ${consumers[1]!.harness}, ${Buffer.from([2])}, 'kc-neutral-trigger-count', 0)
      ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
    const triggerRunIds: string[] = [];
    for (const consumer of consumers) {
      const source = {
        id: consumer.harness, workItem: { kind: 'feature' },
        roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
        operations: [{
          id: consumer.operationId, version: '1', target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'agent', role: 'worker' },
          // An agent work-item operation must pin the worker identity it will bind
          // (validate.ts operation-unpinned-agent; same fixture fix as WI-10008190).
          policy: { identity: { kind: 'identity', ref: `${consumer.harness}-worker`, revision: '1.0.0', contentHash: 'c'.repeat(64) } },
          inputSchema: { type: 'object', required: [consumer.field], additionalProperties: false,
            properties: { [consumer.field]: { type: typeof consumer.value === 'number' ? 'integer' : 'string' },
              trigger: { type: 'object' } } },
          acceptance: { resultSchema: { type: 'object', required: [consumer.resultField],
            properties: { [consumer.resultField]: { type: consumer.resultType } } } },
        }],
      };
      await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: consumer.harness,
        blueprint: BlueprintSchema.parse(source), specification: compileAgentSpecification({ source }) });
      const [binding] = await sql<Array<{ id: string }>>`
        INSERT INTO harness_shared.trigger_bindings
          (workspace_id, source_id, event_pattern, event_filter, action, armed, storm_policy)
        VALUES (${WS}, ${sourceId}, 'ext:gmail:message.*', '{}'::jsonb,
                ${JSON.stringify({ type: 'blueprint-operation', operationHarnessSlug: consumer.harness,
                  operationId: consumer.operationId, input: { [consumer.field]: consumer.value } })}::text::jsonb,
                TRUE, '{}'::jsonb)
        RETURNING id`;
      triggerRunIds.push(await seedTriggerRun({ bindingId: binding.id }));
    }
    const dispatch = await dispatchPendingTriggerRuns(sql);
    const failures = await sql<Array<{ id: string; error: string | null }>>`
      SELECT id, error FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id IN ${sql(triggerRunIds)} AND status = 'failed'`;
    expect({ dispatch, failures }).toMatchObject({
      dispatch: { claimed: 2, succeeded: 2, failed: 0 }, failures: [],
    });
    const triggerRows = await sql<Array<{ id: string; outcome: { blueprintOperation: {
      harnessSlug: string; target: { kind: string; id: string } } } }>>`
      SELECT id, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id IN ${sql(triggerRunIds)}`;
    expect(triggerRows).toHaveLength(2);
    const eventItemIds = triggerRows.map((row) => row.outcome.blueprintOperation.target.id);
    expect(new Set(eventItemIds).size).toBe(2);
    for (const consumer of consumers) {
      // A routine fire is admitted only for an ACTIVE routine row with this id
      // (operation-routine-admission.ts); the fixture predates that check.
      await sql`
        INSERT INTO harness_shared.routines
          (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template, concurrency, active)
        VALUES (${`routine:${consumer.harness}`}, ${WS}, ${consumer.harness}, ${consumer.harness}, 'cron',
                ${JSON.stringify({ costCapCents: 200 })}::text::jsonb, 'system:blueprint-operation',
                ${JSON.stringify({ operationHarnessSlug: consumer.harness, operationId: consumer.operationId })}::text::jsonb,
                'skip', true)
        ON CONFLICT (id) DO NOTHING`;
      const first = await runBlueprintOperationAction({
        workspaceId: WS, installSlug: consumer.harness, routineId: `routine:${consumer.harness}`,
        workflowId: `routine-fire:${consumer.harness}:first`, triggerConfig: {},
        payloadTemplate: { operationHarnessSlug: consumer.harness,
          operationId: consumer.operationId, input: { [consumer.field]: consumer.value } },
      }, { sql });
      const replay = await runBlueprintOperationAction({
        workspaceId: WS, installSlug: consumer.harness, routineId: `routine:${consumer.harness}`,
        workflowId: `routine-fire:${consumer.harness}:first`, triggerConfig: {},
        payloadTemplate: { operationHarnessSlug: consumer.harness,
          operationId: consumer.operationId, input: { [consumer.field]: consumer.value } },
      }, { sql });
      expect(replay).toEqual(first);
      expect(first.diagnostics?.blueprintOperation).toMatchObject({ harnessSlug: consumer.harness,
        operationId: consumer.operationId, target: { kind: 'work-item' } });
    }
    const [counts] = await sql<Array<{ items: number; runs: number; plans: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.work_items
                WHERE workspace_id = ${WS} AND harness_slug IN ('neutral-trigger-text', 'neutral-trigger-count')) AS items,
             (SELECT count(*)::int FROM harness_shared.plan_runs
                WHERE workspace_id = ${WS} AND harness_slug IN ('neutral-trigger-text', 'neutral-trigger-count')) AS runs,
             (SELECT count(*)::int FROM harness_shared.harness_plans
                WHERE workspace_id = ${WS} AND harness_slug IN ('neutral-trigger-text', 'neutral-trigger-count')) AS plans`;
    expect(counts).toEqual({ items: 4, runs: 0, plans: 0 });
  }, 90_000);

  it('replays one blueprint operation from the trigger receipt and never forwards private payload', async () => {
    const operationAction = {
      type: 'blueprint-operation',
      operationHarnessSlug: 'papercusp',
      operationId: 'triage-message',
      input: { priority: 'normal' },
    };
    const bindings = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, event_pattern, event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, 'ext:gmail:message.*', '{}'::jsonb,
              ${JSON.stringify(operationAction)}::text::jsonb, TRUE, '{}'::jsonb)
      RETURNING id`;
    const operationBindingId = bindings[0]!.id;
    const triggerRunId = await seedTriggerRun({ bindingId: operationBindingId });
    const handle = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      receiptId: 41,
      operationId: 'triage-message',
      specificationRevision: 'a'.repeat(64),
      target: { kind: 'work-item' as const, id: 'WI-operation-41' },
    };
    const submitOperation = vi.fn<NonNullable<TriggerDispatchDeps['submitOperation']>>(async () => handle);

    await expect(dispatchPendingTriggerRuns(sql, { submitOperation })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(submitOperation).toHaveBeenCalledWith(sql, {
      workspaceId: WS,
      harnessSlug: HARNESS,
      callerId: `trigger-binding:${operationBindingId}`,
      operationId: 'triage-message',
      requestKey: `trigger-run:${triggerRunId}`,
      input: {
        priority: 'normal',
        trigger: expect.objectContaining({
          key: 'ext:gmail:message.received',
          dedupeKey: 'gmail:dispatch-1',
        }),
      },
    });
    expect(JSON.stringify(submitOperation.mock.calls[0]![1])).not.toContain('Triage this');
    expect(JSON.stringify(submitOperation.mock.calls[0]![1])).not.toContain('"payload"');

    const first = await sql<Array<{ outcome: Record<string, unknown>; plan_run_ref: string | null }>>`
      SELECT outcome, plan_run_ref FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(first[0]).toMatchObject({ outcome: { blueprintOperation: handle }, plan_run_ref: null });

    // Simulate a lost status response after canonical operation admission. The
    // same persisted occurrence must submit the same caller/request pair.
    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'failed', outcome = '{}'::jsonb, error = 'lost response',
             next_attempt_at = now() - interval '1 second', completed_at = now()
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    await expect(dispatchPendingTriggerRuns(sql, { submitOperation })).resolves.toMatchObject({ succeeded: 1 });
    expect(submitOperation).toHaveBeenCalledTimes(2);
    expect(submitOperation.mock.calls[1]![1]).toEqual(submitOperation.mock.calls[0]![1]);
    const replay = await sql<Array<{ outcome: Record<string, unknown>; attempts: number }>>`
      SELECT outcome, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(replay[0]).toMatchObject({ outcome: { blueprintOperation: handle }, attempts: 2 });
  });

  it('launches the canonical plan run with trigger inputs and announces its work', async () => {
    const audit = {
      runWithLastEvent: {
        sourceTriggerRunId: 'source-run-1',
        sourceDeliveryId: deliveryId,
        providerDedupeKey: 'gmail:dispatch-1',
        requestedBy: 'owner:test',
      },
    };
    const triggerRunId = await seedTriggerRun({ outcome: audit });
    const runPlan = vi.fn<NonNullable<TriggerDispatchDeps['runPlan']>>(
      async (): Promise<ScheduledPlanFireStartedResult> => startedPlanRun(triggerRunId, 4241));
    const announceRunWork = vi.fn(async () => undefined);
    const result = await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);
    const triggerRuns = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string;
      outcome: {
        instancePlanSlug: string;
        planRunId: number;
        runWithLastEvent: typeof audit.runWithLastEvent;
      };
    }>>`
      SELECT status, attempts, plan_run_ref, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(triggerRuns[0].status).toBe('succeeded');
    expect(triggerRuns[0].attempts).toBe(1);
    expect(triggerRuns[0].outcome.instancePlanSlug).toBe(`${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`);
    expect(triggerRuns[0].outcome.runWithLastEvent).toEqual(audit.runWithLastEvent);
    expect(triggerRuns[0].plan_run_ref).toBe(String(triggerRuns[0].outcome.planRunId));

    // WI-2143575: plan-run inputs FEDERATE, so they carry the routing envelope
    // only. The private payload stays in trigger_runs.args (owner-local) and the
    // agent pulls it back with `triggers:read-payload` by planRunId.
    expect(runPlan).toHaveBeenCalledWith(sql, expect.objectContaining({
      trigger: 'event',
      inputs: { trigger: expect.objectContaining({ key: 'ext:gmail:message.received' }) },
    }));
    const inputs = runPlan.mock.calls[0]![1].inputs as { trigger: Record<string, unknown> };
    expect(inputs.trigger).not.toHaveProperty('payload');
    expect(announceRunWork).toHaveBeenCalledWith(sql, WS, triggerRuns[0].outcome.planRunId);
  });

  it('retries failed and stale-running rows without minting duplicate trigger attempts', async () => {
    const triggerRunId = await seedTriggerRun();
    const runPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary launch failure'))
      .mockResolvedValueOnce({
        started: true,
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 4242,
        runSeq: 0,
        minted: 1,
        replayed: false,
      });
    const announceRunWork = vi.fn(async () => undefined);

    expect(await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });
    expect(await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const rows = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
    expect(runPlan).toHaveBeenCalledTimes(2);
    expect(announceRunWork).toHaveBeenCalledTimes(1);

    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'running', started_at = now() - interval '5 minutes',
             completed_at = NULL, attempts = 2
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    runPlan.mockResolvedValueOnce({
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 4242,
      runSeq: 0,
      minted: 0,
      replayed: true,
    });
    expect(await dispatchPendingTriggerRuns(sql, {
      runPlan,
      announceRunWork,
      staleAfterSeconds: 60,
    })).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const recovered = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(recovered[0]).toEqual({ status: 'succeeded', attempts: 3 });
  });

  it('forwards agentic execution metadata and retries a failed required wake', async () => {
    const execution = { appHarnessSlug: 'email', agentName: 'email-agent' };
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET action = ${JSON.stringify({ type: 'launch-plan', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    const triggerRunId = await seedTriggerRun();
    const dispatchBase = {
      target: {
        requested: 'email-agent',
        ownerId: 'su-email-live',
        present: true,
        sessionState: 'parked',
        wakeable: true,
      },
      assignment: {
        ok: true,
        targetAgent: 'email-agent',
        requested: ['WI-AGENTIC'],
        actionable: ['WI-AGENTIC'],
        assigned: ['WI-AGENTIC'],
        retained: [],
        skipped: [],
        failed: [],
        executionWorkItemIds: ['WI-AGENTIC'],
      },
      wake: null,
    };
    const runPlan = vi
      .fn()
      .mockResolvedValueOnce({
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 9001,
        runSeq: 0,
        minted: 1,
        workItemIds: ['WI-AGENTIC'],
        actionableWorkItemIds: ['WI-AGENTIC'],
        replayed: false,
        execution,
        dispatch: {
          ...dispatchBase,
          ok: false,
          failure: {
            code: 'target_absent',
            target: 'su-email-live',
            recoverable: true,
            queuePreserved: true,
            message: 'no live adopting session',
          },
        },
      })
      .mockResolvedValueOnce({
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 9001,
        runSeq: 0,
        minted: 0,
        workItemIds: ['WI-AGENTIC'],
        actionableWorkItemIds: ['WI-AGENTIC'],
        replayed: true,
        execution,
        dispatch: { ...dispatchBase, ok: true },
      });
    const announceRunWork = vi.fn(async () => undefined);

    await expect(dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    const failed = await sql<Array<{ status: string; error: string; plan_run_ref: string | null }>>`
      SELECT status, error, plan_run_ref FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    // The run launched before its dispatch failed, so the receipt names it and whoever
    // executes the still-queued work-item can read the payload (WI-6554700010010446).
    expect(failed[0]).toMatchObject({
      status: 'failed',
      error: 'external_trigger_agentic_dispatch_failed:target_absent',
      plan_run_ref: '9001',
    });
    await expect(readTriggerPlanRunPayload(sql, WS, 9001)).resolves.toMatchObject({
      triggerRunId,
      externalId: 'dispatch-1',
    });

    await expect(dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(runPlan).toHaveBeenCalledWith(sql, expect.objectContaining({ execution, trigger: 'event' }));
    expect(announceRunWork).not.toHaveBeenCalled();
    const succeeded = await sql<Array<{ status: string; attempts: number; outcome: Record<string, any> }>>`
      SELECT status, attempts, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(succeeded[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(succeeded[0].outcome.execution).toEqual(execution);
    expect(succeeded[0].outcome.dispatch.ok).toBe(true);
  });

  it('does not report an agentic dispatch with no executable consumer as succeeded', async () => {
    const execution = { appHarnessSlug: 'email', agentName: 'email-agent' };
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET action = ${JSON.stringify({ type: 'launch-plan', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    const triggerRunId = await seedTriggerRun();
    const runPlan = vi.fn<NonNullable<TriggerDispatchDeps['runPlan']>>(async (): Promise<ScheduledPlanFireStartedResult> => ({
      started: true,
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 9004,
      runSeq: 0,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: true,
      execution,
      dispatch: {
        ok: true,
        target: {
          requested: 'email-agent', ownerId: 'su-email-recorded', present: true,
          sessionState: 'recorded', wakeable: false,
        },
        assignment: {
          ok: true, targetAgent: 'email-agent', requested: [], actionable: [],
          assigned: [], retained: [], skipped: [], failed: [], executionWorkItemIds: [],
        },
        wake: null,
        warning: 'no currently actionable work-items; blocked/parked descendants remain unassigned and target was not woken',
      },
    }));

    await expect(dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork: vi.fn() }))
      .resolves.toMatchObject({ claimed: 1, succeeded: 0, skipped: 1, failed: 0 });
    const rows = await sql<Array<{
      status: string;
      error: string;
      outcome: Record<string, any>;
    }>>`
      SELECT status, error, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(rows[0]).toMatchObject({
      status: 'skipped',
      error: 'external_trigger_agentic_dispatch_no_consumer',
      outcome: {
        minted: 0,
        noConsumer: true,
        dispatch: { ok: true, wake: null, target: { wakeable: false } },
      },
    });
  });

  it('terminalizes a non-retryable plan-run invalid_data refusal with typed outcome evidence', async () => {
    const triggerRunId = await seedTriggerRun();
    const refusal = planRunRefusal({
      reason: 'not-startable',
      detail: 'The supplied inputs do not satisfy this plan schema',
      retryable: false,
      readiness: {
        ready: false,
        code: 'invalid_data',
        source: 'input-schema',
        missing: [],
        issues: ['/trigger/payload/end must be object'],
        hint: 'Fix the trigger payload before starting this plan.',
      },
    });
    const runPlan = vi.fn(async () => refusal);

    await expect(dispatchPendingTriggerRuns(sql, { runPlan })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });
    const run = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string | null;
      error: string | null;
      completed_at: Date | null;
      outcome: Record<string, any>;
    }>>`
      SELECT status, attempts, plan_run_ref, error, completed_at, outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(run[0]).toMatchObject({
      status: 'skipped',
      attempts: 1,
      plan_run_ref: null,
      error: 'external_trigger_plan_run_refused:not-startable:invalid_data',
      outcome: {
        planRunRefusal: {
          reason: 'not-startable',
          detail: refusal.detail,
          retryable: false,
          readiness: {
            code: 'invalid_data',
            source: 'input-schema',
            issues: refusal.readiness?.issues,
          },
        },
      },
    });
    expect(run[0].completed_at).toBeTruthy();
    expect(await dispatchPendingTriggerRuns(sql, { runPlan })).toMatchObject({ claimed: 0 });
    expect(runPlan).toHaveBeenCalledTimes(1);
  });

  it('keeps a retryable missing_required plan-run refusal on the failed/retry path', async () => {
    const triggerRunId = await seedTriggerRun();
    const refusal = planRunRefusal({
      reason: 'not-startable',
      detail: 'Required input not supplied: end',
      retryable: true,
      readiness: {
        ready: false,
        code: 'missing_required',
        source: 'input-schema',
        missing: ['end'],
        issues: [],
        hint: 'Supply it via plans:set-template-data or pass it as inputs on this run.',
      },
    });
    const runPlan = vi
      .fn()
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(startedPlanRun(triggerRunId, 4244));

    await expect(dispatchPendingTriggerRuns(sql, { runPlan })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      skipped: 0,
      failed: 1,
    });
    const failed = await sql<Array<{
      status: string;
      attempts: number;
      error: string | null;
      outcome: Record<string, any>;
    }>>`
      SELECT status, attempts, error, outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(failed[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'external_trigger_plan_run_refused:not-startable:missing_required',
      outcome: {
        planRunRefusal: {
          reason: 'not-startable',
          detail: refusal.detail,
          retryable: true,
          readiness: { code: 'missing_required', missing: ['end'] },
        },
      },
    });

    await expect(dispatchPendingTriggerRuns(sql, { runPlan })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    });
    const recovered = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string | null;
      error: string | null;
    }>>`
      SELECT status, attempts, plan_run_ref, error
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(recovered[0]).toEqual({
      status: 'succeeded',
      attempts: 2,
      plan_run_ref: '4244',
      error: null,
    });
    expect(runPlan).toHaveBeenCalledTimes(2);
  });

  it('terminalizes a concurrency-skip plan-run refusal without retrying it', async () => {
    const triggerRunId = await seedTriggerRun();
    const refusal = planRunRefusal({
      skippedForConcurrency: true,
      reason: 'concurrency-skip',
      detail: 'prior plan run 4245 is still running (concurrency=skip)',
      retryable: false,
      priorRunId: 4245,
    });
    const runPlan = vi.fn(async () => refusal);

    await expect(dispatchPendingTriggerRuns(sql, { runPlan })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    });
    const run = await sql<Array<{
      status: string;
      attempts: number;
      error: string | null;
      outcome: Record<string, any>;
    }>>`
      SELECT status, attempts, error, outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(run[0]).toMatchObject({
      status: 'skipped',
      attempts: 1,
      error: 'external_trigger_plan_run_skipped:concurrency-skip',
      outcome: {
        planRunRefusal: {
          reason: 'concurrency-skip',
          detail: refusal.detail,
          retryable: false,
          priorRunId: 4245,
        },
      },
    });
    expect(await dispatchPendingTriggerRuns(sql, { runPlan })).toMatchObject({ claimed: 0 });
    expect(runPlan).toHaveBeenCalledTimes(1);
  });

  it('parks a queue-preserved target_absent run beyond the ordinary cap, alerts once, then resolves on recovery', async () => {
    const execution = { appHarnessSlug: 'email', agentName: 'email-agent' };
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET action = ${JSON.stringify({ type: 'launch-plan', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    const triggerRunId = await seedTriggerRun({ attempts: 4 });
    const failedDispatch = {
      ok: false,
      target: {
        requested: 'email-agent', ownerId: 'email-agent', present: false,
        sessionState: null, wakeable: null,
      },
      assignment: {
        ok: true, targetAgent: 'email-agent', requested: ['WI-EMAIL'], actionable: ['WI-EMAIL'],
        assigned: ['WI-EMAIL'], retained: [], skipped: [], failed: [], executionWorkItemIds: ['WI-EMAIL'],
      },
      wake: { queued: 0, woken: 0, staged: 0, timedOutTargets: [] },
      failure: {
        code: 'target_absent' as const,
        target: 'email-agent', recoverable: true as const, queuePreserved: true,
        message: 'no live adopting session',
      },
    };
    const runPlan = vi
      .fn()
      .mockResolvedValueOnce({
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 9002, runSeq: 0, minted: 1, workItemIds: ['WI-EMAIL'],
        actionableWorkItemIds: ['WI-EMAIL'], replayed: false, execution, dispatch: failedDispatch,
      })
      .mockResolvedValueOnce({
        instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
        runId: 9002, runSeq: 0, minted: 0, workItemIds: ['WI-EMAIL'],
        actionableWorkItemIds: ['WI-EMAIL'], replayed: true, execution,
        dispatch: { ...failedDispatch, ok: true, failure: undefined },
      });
    const openEscalation = vi.fn(async () => ({ msg_id: 'esc-trigger-retry-1' }) as any);
    const resolveEscalation = vi.fn(async () => 'already_resolved' as const);

    expect(await dispatchPendingTriggerRuns(sql, { runPlan, openEscalation, resolveEscalation }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1, deferred: 1 });
    const parked = await sql<Array<{
      status: string; attempts: number; next_attempt_at: Date; outcome: Record<string, any>;
    }>>`
      SELECT status, attempts, next_attempt_at, outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(parked[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(new Date(parked[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(parked[0].outcome).toMatchObject({
      dispatchFailure: { code: 'target_absent', recoverable: true, queuePreserved: true },
      retry: { deferred: true, retryAfterSeconds: 900, attempts: 5 },
      retryEscalationMsgId: 'esc-trigger-retry-1',
    });
    expect(openEscalation).toHaveBeenCalledTimes(1);
    // WI-6554700010010397: the escalation carries the classifier's cause, not only the code.
    expect(openEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: expect.stringContaining('Cause: no live adopting session') }),
    );

    // Parked means paced: an immediate routine tick does not hot-loop or consume
    // the queued successful replay.
    expect(await dispatchPendingTriggerRuns(sql, { runPlan, openEscalation, resolveEscalation }))
      .toMatchObject({ claimed: 0 });
    await sql`
      UPDATE harness_shared.trigger_runs SET next_attempt_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(await dispatchPendingTriggerRuns(sql, { runPlan, openEscalation, resolveEscalation }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0, deferred: 0 });
    const recovered = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(recovered[0]).toEqual({ status: 'succeeded', attempts: 6 });
    expect(resolveEscalation).toHaveBeenCalledWith(expect.objectContaining({
      msg_id: 'esc-trigger-retry-1', choice: 'recovered',
    }));
  });

  it('gives a pre-metadata capped target_absent row one rescue claim', async () => {
    const triggerRunId = await seedTriggerRun({ status: 'failed', attempts: 5 });
    await sql`
      UPDATE harness_shared.trigger_runs
         SET error = 'external_trigger_agentic_dispatch_failed:target_absent',
             outcome = '{}'::jsonb, next_attempt_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    const runPlan = vi.fn<NonNullable<TriggerDispatchDeps['runPlan']>>(async (): Promise<ScheduledPlanFireStartedResult> => ({
      started: true,
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 9003, runSeq: 0, minted: 0, workItemIds: [], actionableWorkItemIds: [], replayed: true,
    }));

    expect(await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork: vi.fn() }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const recovered = await sql<Array<{ status: string; attempts: number }>>`
      SELECT status, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(recovered[0]).toEqual({ status: 'succeeded', attempts: 6 });
  });

  it('terminalizes retry residue after a binding is disarmed and reaps stale running rows', async () => {
    const triggerArgs = (suffix: string) => ({
      trigger: {
        key: 'ext:gmail:message.received', source: 'gmail', event: 'message.received',
        sourceId: 'source-fixture', externalId: `disarmed-${suffix}`, occurredAt: null,
        datatypeId: 'email-message', dedupeKey: `gmail:disarmed-${suffix}`,
        payload: { id: `disarmed-${suffix}`, subject: 'Do not retry this' },
      },
    });
    const failedId = await seedTriggerRun({ status: 'failed', attempts: 23, args: triggerArgs('failed') });
    const runningId = await seedTriggerRun({ status: 'running', attempts: 21, args: triggerArgs('running') });
    await sql`
      UPDATE harness_shared.trigger_runs
         SET error = 'external_trigger_agentic_dispatch_failed:target_unwakeable',
             outcome = ${JSON.stringify({
               dispatchFailure: {
                 code: 'target_unwakeable', target: 'dead-agent', recoverable: true, queuePreserved: true,
               },
             })}::text::jsonb,
             next_attempt_at = now() - interval '1 second',
             started_at = CASE WHEN id = ${runningId} THEN now() - interval '10 minutes' ELSE started_at END
       WHERE workspace_id = ${WS} AND id IN (${failedId}, ${runningId})`;
    await sql`
      UPDATE harness_shared.trigger_bindings SET armed = FALSE
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;

    expect(await dispatchPendingTriggerRuns(sql, { runPlan: vi.fn(), staleAfterSeconds: 60 }))
      .toMatchObject({ claimed: 0, failed: 0 });
    const rows = await sql<Array<{ id: string; status: string; error: string }>>`
      SELECT id::text, status, error
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id IN (${failedId}, ${runningId})
       ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
    expect(rows.map((row) => row.error)).toEqual([
      'external_trigger_agentic_dispatch_failed:target_unwakeable',
      'external_trigger_agentic_dispatch_failed:target_unwakeable',
    ]);
  });

  it('expires a never-attempted run older than maxAgeSeconds instead of dispatching it (WI-10004920)', async () => {
    const triggerArgs = (suffix: string) => ({
      trigger: {
        key: 'ext:gmail:message.received', source: 'gmail', event: 'message.received',
        sourceId: 'source-fixture', externalId: `aged-${suffix}`, occurredAt: null,
        datatypeId: 'email-message', dedupeKey: `gmail:aged-${suffix}`,
        payload: { id: `aged-${suffix}`, subject: 'Queued while the drain was paused' },
      },
    });
    // Backlog that piled up while the dispatcher was off: never attempted, 2 days old.
    const backlogId = await seedTriggerRun({ args: triggerArgs('backlog') });
    // Same age, but dispatch already began — its retry policy, not the age window, governs it.
    const startedId = await seedTriggerRun({ status: 'failed', attempts: 1, args: triggerArgs('started') });
    // A custom, tighter window on the binding: 1h. A 2h-old fresh run is past it.
    const customId = await seedTriggerRun({ args: triggerArgs('custom') });
    await sql`
      UPDATE harness_shared.trigger_runs
         SET triggered_at = CASE WHEN id = ${customId} THEN now() - interval '2 hours'
                                 ELSE now() - interval '2 days' END,
             next_attempt_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND id IN (${backlogId}, ${startedId}, ${customId})`;

    const runPlan = vi.fn().mockRejectedValue(new Error('plan launch unavailable'));
    const first = await dispatchPendingTriggerRuns(sql, { runPlan, staleAfterSeconds: 60 });
    // Default window (24h): the backlog row expires, the already-started row is still claimed,
    // and the 2h-old row is inside the default window so it is claimed too.
    expect(first.triggerRunIds).not.toContain(backlogId);
    expect(first.triggerRunIds).toContain(startedId);
    const backlog = await sql<Array<{ status: string; error: string | null; attempts: number }>>`
      SELECT status, error, attempts FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${backlogId}`;
    expect(backlog[0]).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(backlog[0].error).toMatch(/^external_trigger_stale/);

    // A stored custom window is honoured: reset the 2h-old row to never-attempted and tighten to 1h.
    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = now() - interval '1 second'
       WHERE workspace_id = ${WS} AND id = ${customId}`;
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET storm_policy = COALESCE(storm_policy, '{}'::jsonb) || '{"maxAgeSeconds": 3600}'::jsonb
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    const second = await dispatchPendingTriggerRuns(sql, { runPlan, staleAfterSeconds: 60 });
    expect(second.triggerRunIds).not.toContain(customId);
    const custom = await sql<Array<{ status: string; error: string | null }>>`
      SELECT status, error FROM harness_shared.trigger_runs WHERE workspace_id = ${WS} AND id = ${customId}`;
    expect(custom[0].status).toBe('skipped');
    expect(custom[0].error).toMatch(/^external_trigger_stale/);
  });

  it('passes the complete Calendar-upcoming trigger input into the meeting-prep plan run', async () => {
    const args = {
      trigger: {
        key: 'ext:gcal:event-upcoming',
        source: 'gcal',
        event: 'event-upcoming',
        sourceId: 'calendar-source-1',
        externalId: 'calendar-event-7',
        occurredAt: '2026-08-22T13:45:00.000Z',
        datatypeId: 'calendar-event',
        dedupeKey: 'gcal:calendar-event-7:event-upcoming:2026-08-22T14:00:00.000Z',
        payload: {
          id: 'calendar-event-7',
          summary: 'Roadmap review',
          start: '2026-08-22T14:00:00.000Z',
          end: '2026-08-22T14:30:00.000Z',
          attendees: [
            { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted' },
            { email: 'bob@example.com', displayName: 'Bob', responseStatus: 'tentative' },
          ],
          organizer: { email: 'owner@example.com', self: true },
          htmlLink: 'https://calendar.google.com/event?eid=fixture',
        },
      },
    };
    const triggerRunId = await seedTriggerRun({ args });
    const runPlan = vi.fn<NonNullable<TriggerDispatchDeps['runPlan']>>(async (): Promise<ScheduledPlanFireStartedResult> => ({
      started: true,
      instanceSlug: `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
      runId: 4243,
      runSeq: 0,
      minted: 1,
      workItemIds: ['WI-4243'],
      actionableWorkItemIds: ['WI-4243'],
      replayed: false,
    }));
    const announceRunWork = vi.fn(async () => undefined);

    await expect(dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork }))
      .resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(runPlan).toHaveBeenCalledWith(sql, expect.objectContaining({
      trigger: 'event',
      inputs: {
        trigger: expect.objectContaining({
          key: 'ext:gcal:event-upcoming',
          source: 'gcal',
          externalId: 'calendar-event-7',
        }),
      },
    }));
    const forwarded = runPlan.mock.calls[0]![1].inputs as { trigger: Record<string, unknown> };
    expect(forwarded.trigger).not.toHaveProperty('payload');
  });
});

describe('create-work-item direct Email dispatch (P-018)', () => {
  let directFixtureSeq = 0;

  async function installEmailDraftDatatype(): Promise<void> {
    await upsertDatatype(sql, {
      id: EMAIL_DRAFT_PROPOSAL_KIND,
      workspaceId: WS,
      title: 'Email draft proposal',
      description: 'A draft-only reply proposal from Gmail.',
      tier: 'generic-kind',
      nature: 'work',
      audience: 'human', // D-007: a person decides whether a draft is sent
      workItemKind: EMAIL_DRAFT_PROPOSAL_KIND,
      payloadSchema: EMAIL_DRAFT_PAYLOAD_SCHEMA,
      authoritativeWriter: 'papercusp',
      published: false,
      createdBy: 'binding-engine.integration.test',
    });
  }

  async function seedDirectBinding(): Promise<string> {
    const rows = await sql.unsafe<Array<{ id: string }>>(
      `INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id,
         work_item_harness_slug, work_item_kind, event_pattern, event_filter,
         action, armed, storm_policy)
      VALUES ($1, $2, NULL, NULL, NULL, $3, $4, $5, '{}'::jsonb,
              '{"type":"create-work-item"}'::jsonb, TRUE,
              '{"maxRuns":12,"windowSeconds":60}'::jsonb)
      RETURNING id`,
      [WS, sourceId, EMAIL_DRAFT_PROPOSAL_HARNESS, EMAIL_DRAFT_PROPOSAL_KIND, 'ext:gmail:message.received'],
    );
    return rows[0].id;
  }

  async function seedDirectRun(
    directBindingId: string,
    overrides: Record<string, unknown> = {},
    suffix?: string,
  ): Promise<{
    triggerRunId: string;
    eventPayload: Record<string, unknown>;
    dedupeKey: string;
    externalId: string;
  }> {
    const token = suffix ?? ('direct-' + (++directFixtureSeq));
    const externalId = 'message-' + token;
    const dedupeKey = 'gmail:' + token;
    const eventPayload: Record<string, unknown> = {
      messageId: externalId,
      threadId: 'thread-' + token,
      from: 'sender@example.com',
      to: ['owner@example.com'],
      subject: 'Please review the launch',
      text: 'Could you draft a response?',
      ...overrides,
    };
    const triggerRunId = await seedTriggerRun({
      bindingId: directBindingId,
      args: {
        trigger: {
          key: 'ext:gmail:message.received',
          source: 'gmail',
          event: 'message.received',
          sourceId,
          externalId,
          occurredAt: '2026-08-28T14:00:00.000Z',
          datatypeId: 'email-message',
          dedupeKey,
          payload: eventPayload,
        },
      },
    });
    return { triggerRunId, eventPayload, dedupeKey, externalId };
  }

  function returnedWorkItem(input: CreateWorkItemInput, id: string): WorkItem {
    return {
      id,
      kind: input.kind,
      family: 'feature',
      harness: input.harness ?? null,
      title: input.title,
      summary: input.summary ?? '',
      state: 'open',
      payload: input.payload ?? null,
    } as unknown as WorkItem;
  }

  it('creates a canonical draft-only Email item and records immutable trigger provenance', async () => {
    await installEmailDraftDatatype();
    const directBindingId = await seedDirectBinding();
    const fixture = await seedDirectRun(directBindingId, {}, 'direct-canonical');
    const createWorkItem = vi.fn(async (input: CreateWorkItemInput) =>
      returnedWorkItem(input, 'WI-direct-email-1'),
    );

    await expect(dispatchPendingTriggerRuns(sql, { createWorkItem })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(createWorkItem).toHaveBeenCalledTimes(1);

    const input = createWorkItem.mock.calls[0]![0]!;
    const triggerRef = directWorkItemTriggerRef(fixture.triggerRunId, directBindingId);
    expect(input).toMatchObject({
      kind: EMAIL_DRAFT_PROPOSAL_KIND,
      title: 'Draft reply: Please review the launch',
      summary:
        'Prepare a draft-only reply for Gmail message message-direct-canonical in thread thread-direct-canonical.',
      harness: EMAIL_DRAFT_PROPOSAL_HARNESS,
      workspaceId: WS,
      createdBy: 'system:external-trigger-dispatch',
      payload: {
        messageId: 'message-direct-canonical',
        threadId: 'thread-direct-canonical',
        from: 'sender@example.com',
        to: ['owner@example.com'],
        subject: 'Please review the launch',
        text: 'Could you draft a response?',
        policy: { draftOnly: true },
        triggerRef,
      },
    });
    expect(input.payload).not.toHaveProperty('eventKey');
    expect(input.payload).not.toHaveProperty('dedupeKey');

    const runs = await sql.unsafe<Array<{
      status: string;
      plan_run_ref: string | null;
      outcome: Record<string, unknown>;
    }>>(
      'SELECT status, plan_run_ref, outcome FROM harness_shared.trigger_runs WHERE workspace_id = $1 AND id = $2',
      [WS, fixture.triggerRunId],
    );
    expect(runs[0]).toMatchObject({ status: 'succeeded', plan_run_ref: null });
    expect(runs[0].outcome).toMatchObject({
      directWorkItemId: 'WI-direct-email-1',
      directWorkItem: {
        schemaVersion: EMAIL_DRAFT_PROPOSAL_SCHEMA_VERSION,
        eventKey: 'ext:gmail:message.received',
        triggerRef,
        dedupeKey: fixture.dedupeKey,
        sourceId,
        externalId: fixture.externalId,
        triggerRunId: fixture.triggerRunId,
        workItemId: 'WI-direct-email-1',
        harnessSlug: EMAIL_DRAFT_PROPOSAL_HARNESS,
        kind: EMAIL_DRAFT_PROPOSAL_KIND,
      },
    });
  });

  it('adopts the existing triggerRef on retry without minting a duplicate item', async () => {
    await installEmailDraftDatatype();
    const directBindingId = await seedDirectBinding();
    const fixture = await seedDirectRun(directBindingId, {}, 'direct-retry');
    const createdId = 'WI-direct-email-retry';
    const createWorkItem = vi.fn(async (input: CreateWorkItemInput) =>
      returnedWorkItem(input, createdId),
    );

    await expect(dispatchPendingTriggerRuns(sql, { createWorkItem })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
    });
    expect(createWorkItem).toHaveBeenCalledTimes(1);
    const firstInput = createWorkItem.mock.calls[0]![0]!;
    const now = Date.now();
    // Model the canonical writer having committed before a transient status
    // update failure. The next dispatch must discover this payload by triggerRef.
    await sql.unsafe(
      `INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, title, summary, status, item_kind, payload,
         workspace_id, ts, created_ts, updated_ts, origin)
      VALUES ($1, $2, $3, $4, 'open', $5, $6::text::jsonb, $7, $8, $8, $8, 'local')`,
      [
        EMAIL_DRAFT_PROPOSAL_HARNESS,
        createdId,
        firstInput.title,
        firstInput.summary ?? '',
        EMAIL_DRAFT_PROPOSAL_KIND,
        JSON.stringify(firstInput.payload),
        WS,
        now,
      ],
    );
    await sql.unsafe(
      `UPDATE harness_shared.trigger_runs
         SET status = 'failed',
             error = 'simulated_trigger_status_update_failure',
             outcome = '{}'::jsonb,
             next_attempt_at = now() - interval '1 second',
             completed_at = now(),
             updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [WS, fixture.triggerRunId],
    );

    await expect(dispatchPendingTriggerRuns(sql, { createWorkItem })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(createWorkItem).toHaveBeenCalledTimes(1);

    const runs = await sql.unsafe<Array<{
      status: string;
      attempts: number;
      outcome: Record<string, unknown>;
    }>>(
      'SELECT status, attempts, outcome FROM harness_shared.trigger_runs WHERE workspace_id = $1 AND id = $2',
      [WS, fixture.triggerRunId],
    );
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      attempts: 2,
      outcome: {
        directWorkItemId: createdId,
        directWorkItem: { triggerRef: directWorkItemTriggerRef(fixture.triggerRunId, directBindingId) },
      },
    });
    const items = await sql.unsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = $1
         AND harness_slug = $2
         AND item_kind = $3
         AND payload ->> 'triggerRef' = $4`,
      [
        WS,
        EMAIL_DRAFT_PROPOSAL_HARNESS,
        EMAIL_DRAFT_PROPOSAL_KIND,
        directWorkItemTriggerRef(fixture.triggerRunId, directBindingId),
      ],
    );
    expect(items[0].count).toBe(1);
  });

  it('rejects a malformed Email payload before calling the canonical writer', async () => {
    await installEmailDraftDatatype();
    const directBindingId = await seedDirectBinding();
    const fixture = await seedDirectRun(directBindingId, { text: undefined }, 'direct-malformed');
    const createWorkItem = vi.fn();

    await expect(dispatchPendingTriggerRuns(sql, { createWorkItem })).resolves.toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      skipped: 0,
    });
    expect(createWorkItem).not.toHaveBeenCalled();
    const runs = await sql.unsafe<Array<{ status: string; error: string }>>(
      'SELECT status, error FROM harness_shared.trigger_runs WHERE workspace_id = $1 AND id = $2',
      [WS, fixture.triggerRunId],
    );
    expect(runs[0]).toEqual({
      status: 'failed',
      error: 'external_trigger_email_draft_text_required',
    });
  });
});

describe('start-goal trigger dispatch (P-020)', () => {
  const GOAL = 'goal-woe-dispatch-1';
  let goalBindingId: string;

  async function seedGoalBinding(goalId: string | null): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, NULL, NULL, ${goalId}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)
      RETURNING id`;
    return rows[0].id;
  }

  beforeEach(async () => {
    await sql`
      INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, status)
      VALUES (${GOAL}, ${WS}, ${HARNESS}, 'Standing dispatch-test goal', 'active')`;
    goalBindingId = await seedGoalBinding(GOAL);
  });

  async function readRun(triggerRunId: string): Promise<{
    status: string;
    attempts: number;
    plan_run_ref: string | null;
    outcome: Record<string, unknown> | null;
    error: string | null;
  }> {
    const rows = await sql<Array<{
      status: string;
      attempts: number;
      plan_run_ref: string | null;
      outcome: Record<string, unknown> | null;
      error: string | null;
    }>>`
      SELECT status, attempts, plan_run_ref, outcome, error
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    return rows[0];
  }

  it('activates the goal through the injected primitive and closes the run with a goal outcome', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const activation: StartGoalByIdResult = {
      ok: true,
      goalId: GOAL,
      ownerId: 'su-goal-holder-1',
      warnings: ['budget_policy_read_failed'],
      startBlockedOverride: null,
    };
    const startGoal = vi.fn(async () => activation);

    const result = await dispatchPendingTriggerRuns(sql, { startGoal });
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);
    expect(startGoal).toHaveBeenCalledWith(sql, {
      workspaceId: WS,
      goalId: GOAL,
      launcherOwnerId: `trigger-binding:${goalBindingId}`,
    });

    const run = await readRun(triggerRunId);
    expect(run.status).toBe('succeeded');
    // A goal run's handle is the outcome, never a plan-run ref.
    expect(run.plan_run_ref).toBeNull();
    expect(run.error).toBeNull();
    expect(run.outcome).toEqual({
      goalId: GOAL,
      agentOwnerId: 'su-goal-holder-1',
      warnings: ['budget_policy_read_failed'],
    });
  });

  it('retries a heal-able refusal (not-ready) as failed, then succeeds — outcome omits empty warnings', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const refused: StartGoalByIdResult = { ok: false, reason: 'not-ready', detail: 'blockers pending: 2' };
    const activated: StartGoalByIdResult = {
      ok: true, goalId: GOAL, ownerId: 'su-goal-holder-2', warnings: [], startBlockedOverride: null,
    };
    const startGoal = vi.fn()
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(activated);

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    const failed = await readRun(triggerRunId);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('external_trigger_goal_start_refused:not-ready');

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    const done = await readRun(triggerRunId);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
    // warnings: [] is elided from the persisted outcome entirely.
    expect(done.outcome).toEqual({ goalId: GOAL, agentOwnerId: 'su-goal-holder-2' });
  });

  it('closes a terminal refusal (already-held) as skipped and never re-claims it', async () => {
    const triggerRunId = await seedTriggerRun({ bindingId: goalBindingId });
    const refused: StartGoalByIdResult = {
      ok: false, reason: 'already-held', detail: 'goal has a live holder su-elsewhere',
    };
    const startGoal = vi.fn(async () => refused);

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });
    const run = await readRun(triggerRunId);
    expect(run.status).toBe('skipped');
    expect(run.outcome).toEqual({ goalId: GOAL, refusal: 'already-held' });
    expect(run.error).toBe('goal has a live holder su-elsewhere');

    // Terminal: the claim query only takes pending/failed/stale-running rows.
    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 0 });
    expect(startGoal).toHaveBeenCalledTimes(1);
  });

  it('fails a start-goal action whose binding carries no goal target, without invoking the primitive', async () => {
    // The exactly-one-target CHECK allows a plan-targeted row whose action jsonb
    // says start-goal (action is independent of the target columns) — the engine
    // guard is what catches the mismatch.
    const mismatched = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)
      RETURNING id`;
    const triggerRunId = await seedTriggerRun({ bindingId: mismatched[0].id });
    const startGoal = vi.fn();

    expect(await dispatchPendingTriggerRuns(sql, { startGoal }))
      .toMatchObject({ claimed: 1, succeeded: 0, failed: 1, skipped: 0 });
    const run = await readRun(triggerRunId);
    expect(run.status).toBe('failed');
    expect(run.error).toBe('external_trigger_missing_goal_target');
    expect(startGoal).not.toHaveBeenCalled();
  });

  it('migration 921 canary: the DB refuses a binding with both targets or neither', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, goal_id, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sourceId}, ${HARNESS}, ${PLAN}, ${GOAL}, 'ext:gmail:message.*',
              '{}'::jsonb, '{"type":"start-goal"}'::jsonb, TRUE, '{}'::jsonb)`,
    ).rejects.toThrow(/trigger_bindings_exactly_one_target/);
    await expect(seedGoalBinding(null)).rejects.toThrow(/trigger_bindings_exactly_one_target/);
  });
});

/**
 * P-028 simulated acceptance for the SOCIAL platforms.
 *
 * Every other case in this file drives gmail/calendar. Before this block, no
 * test anywhere asserted a social `ext:<platform>:` pattern reaching a plan run
 * — the adapters, the registry and the admin surfaces were all covered, but the
 * span between an inbound social event and the delivery ledger was not. That is
 * the half of P-028's acceptance chain a fixture CAN prove; the live half ("the
 * reply lands on the platform") is owner-walled at every wave (D-052), so this
 * deliberately stops at the ledger.
 *
 * It is a distinct block rather than another gmail case because the thing under
 * test is that the dispatch path is platform-AGNOSTIC: nothing between the
 * binding and the plan run may special-case a source kind.
 */
describe('social platform dispatch (P-028 simulated acceptance)', () => {
  const SOCIAL_DEDUPE = 'bluesky:reply-9001';

  async function seedSocialChain(): Promise<{ triggerRunId: string; bindingId: string }> {
    const sources = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.data_sources (workspace_id, kind, status, cursor)
      VALUES (${WS}, 'bluesky', 'connected', ${JSON.stringify({ seq: 4821 })}::text::jsonb)
      RETURNING id`;
    const bindings = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:bluesky:reply.*',
              '{}'::jsonb, '{"type":"launch-plan"}'::jsonb, TRUE,
              ${JSON.stringify({ maxRuns: 12, windowSeconds: 300 })}::text::jsonb)
      RETURNING id`;
    const deliveries = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
         sink_kind, sink_ref, outcome, attempts, completed_at)
      VALUES (${WS}, ${sources[0].id}, ${SOCIAL_DEDUPE}, 'social-post',
              'ext:bluesky:reply.created',
              ${JSON.stringify({
                uri: 'at://did:plc:p028/app.bsky.feed.post/9001',
                text: 'anyone else seeing this?',
                author: 'did:plc:p028',
              })}::text::jsonb,
              'event-bus', 'workspace', 'delivered', 1, now())
      RETURNING id`;
    const args = {
      trigger: {
        key: 'ext:bluesky:reply.created',
        source: 'bluesky',
        event: 'reply.created',
        sourceId: sources[0].id,
        externalId: 'at://did:plc:p028/app.bsky.feed.post/9001',
        occurredAt: null,
        datatypeId: 'social-post',
        dedupeKey: SOCIAL_DEDUPE,
        payload: {
          uri: 'at://did:plc:p028/app.bsky.feed.post/9001',
          text: 'anyone else seeing this?',
          author: 'did:plc:p028',
        },
      },
    };
    const runs = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args, attempts)
      VALUES (${WS}, ${bindings[0].id}, ${deliveries[0].id}, ${SOCIAL_DEDUPE}, 'pending',
              ${JSON.stringify(args)}::text::jsonb, 0)
      RETURNING id`;
    return { triggerRunId: runs[0].id, bindingId: bindings[0].id };
  }

  it('carries a social inbound event through binding -> plan run -> delivery ledger', async () => {
    const { triggerRunId } = await seedSocialChain();
    const runPlan = vi.fn<NonNullable<TriggerDispatchDeps['runPlan']>>(
      async (): Promise<ScheduledPlanFireStartedResult> => startedPlanRun(triggerRunId, 5252));
    const announceRunWork = vi.fn(async () => undefined);

    const result = await dispatchPendingTriggerRuns(sql, { runPlan, announceRunWork });

    // The gmail fixture from beforeEach has no pending run, so exactly the
    // social one is claimed — if dispatch ever special-cased a source kind,
    // this is where it would show up as claimed:0.
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(result.triggerRunIds).toEqual([triggerRunId]);

    const triggerRuns = await sql<Array<{
      status: string;
      outcome: { instancePlanSlug: string; planRunId: number };
    }>>`
      SELECT status, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${triggerRunId}`;
    expect(triggerRuns[0].status).toBe('succeeded');
    expect(triggerRuns[0].outcome.instancePlanSlug).toBe(
      `${PLAN}@run-${triggerRunPlanToken(triggerRunId)}`,
    );

    // The plan run carries the ROUTING ENVELOPE only. It used to carry the
    // social payload verbatim, but plan-run inputs land in a federated
    // work-item payload, so WI-2143575 moved the content from push to pull:
    // the agent drafting a reply resolves it server-side from the owner-local
    // trigger run via `triggers:read-payload`. A lossy hand-off now surfaces as
    // a missing routing field here, and as a not-found from that reader.
    expect(runPlan).toHaveBeenCalledWith(sql, expect.objectContaining({
      trigger: 'event',
      inputs: {
        trigger: expect.objectContaining({
          key: 'ext:bluesky:reply.created',
          source: 'bluesky',
        }),
      },
    }));
    const inputs = runPlan.mock.calls[0]![1].inputs as { trigger: Record<string, unknown> };
    expect(inputs.trigger).not.toHaveProperty('payload');
    expect(JSON.stringify(inputs)).not.toContain('anyone else seeing this?');
    expect(announceRunWork).toHaveBeenCalledWith(sql, WS, triggerRuns[0].outcome.planRunId);

    // The ledger end of the trace: the delivery that caused this run is still
    // joinable to it, which is what the "delivery ledger shows the full trace"
    // half of P-028 actually means.
    const trace = await sql<Array<{ event_key: string; outcome: string; run_status: string }>>`
      SELECT d.event_key, d.outcome, r.status AS run_status
        FROM harness_shared.trigger_runs r
        JOIN harness_shared.trigger_deliveries d ON d.id = r.delivery_id
       WHERE r.workspace_id = ${WS} AND r.id = ${triggerRunId}`;
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      event_key: 'ext:bluesky:reply.created',
      outcome: 'delivered',
      run_status: 'succeeded',
    });
  });

  it('honours the per-platform storm policy stored on a social binding', async () => {
    const { bindingId: socialBindingId } = await seedSocialChain();
    const stored = await sql<Array<{ storm_policy: { maxRuns: number; windowSeconds: number } }>>`
      SELECT storm_policy FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND id = ${socialBindingId}`;
    // Bluesky's conservative-default budget (12 runs / 300s) is what the plan
    // Triggers composer prefills (D-051). A binding that persisted an unbounded
    // policy instead would spend a metered platform's quota early, which is the
    // defect that prefill exists to prevent.
    expect(stored[0].storm_policy).toMatchObject({ maxRuns: 12, windowSeconds: 300 });
  });
});
