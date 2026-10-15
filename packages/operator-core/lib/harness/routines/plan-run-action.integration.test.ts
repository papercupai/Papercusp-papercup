/**
 * system:plan-run — one fire of a scheduled plan, proven end-to-end against a REAL
 * migrated Postgres (testcontainer): a template + its materialized routine → a run
 * (instance plan + plan_runs ledger row + run-scoped frontier work_items), replay-safe,
 * with distinct runs across fires.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/plan-run-action.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7c).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { BlueprintSchema, compileAgentSpecification, pinPackageInput } from '@papercusp/orchestrator/blueprint';
import { projectBlueprintToPg } from '../../blueprint/project-to-pg';
import { acceptBlueprintPlanRun } from '../../blueprint/operation-admission';
import {
  awaitAcceptedCoordProgramChild, loadAcceptedCoordProgramChild, submitAcceptedCoordProgramChild,
} from '../../dbos/coord-program-workflow';
import { blueprintOperationAcceptanceSubjectRef, cancelBlueprintOperation, getBlueprintOperationEvents, getBlueprintOperationResult, getBlueprintOperationStatus, openBlueprintOperationWait, resumeBlueprintOperation, signalBlueprintOperation, submitBlueprintOperation } from '../../blueprint/operation-service';
import { seedContentHash } from '../../cupboard/rubric-store';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { materializePlanSchedule, planScheduleRoutineName } from './materialize-plan-schedule';
import { handlePlanRun, resetManualTokenCounterForTests, runScheduledPlanFire } from './plan-run-action';
import { retireRunInstancePlan } from './retire-run-instance-plan';
import { inboxWakeKey } from '../../agent-tools/coordination/inbox-wake';
import { assignAndWakeActionableWorkItems } from '../../agent-tools/coordination/actionable-work-item-dispatch';
import { getWorkItem, observeWorkItem, readUnresolvedDepBlockers } from '../../work-items';
import { emitUnblockedOnEdgeRemoved } from '../../work-items-events';
import { FEATURE_KIND } from '../../issue-blocks-merge';
import { recordAdvSession } from '../../adv-sessions';
import { adoptAgentName } from '../../plan-items/agent-names';
import { drainDetached } from '../../detached-imports';
import { setAutoPumpEnabledForTests } from '../../events/await/engine';
import { listRecentDeliveries, registerAwait, upsertInboxWakeAwait } from '../../events/await/store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// Canonical promotion deliberately routes through the shared stores rather than
// borrowing runScheduledPlanFire's transaction client. Point every production
// store seam at this file's throwaway DB so the suite exercises the real
// promoter/reader/work-item/DAG path without ever touching the developer DB.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (flag: string) => (flag === 'papercusp-spec-triad-required' ? false : true),
  };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'ws-planrun' };
});
vi.mock('../../agent-tools/plans/plan-spec-quality-gate', () => ({
  evaluatePlanSpecQualityGate: vi.fn(async ({ planSlug }: { planSlug: string }) => ({
    satisfied: true,
    applicable: false,
    mode: 'report-only',
    planSlug,
    specSetHash: null,
    wouldBlock: ['no-first-class-spec-clauses'],
  })),
}));

// work_items:complete reflects a linked plan item and releases its lane through
// the ordinary reaction dispatcher. Load those projected definitions exactly as
// the operator host does so this integration test exercises the real finish saga.
await import('../../agent-tools/plans/set-status');
await import('../../agent-tools/plan-items/release');
const { default: completeWorkItemTool } = await import('../../agent-tools/work_items/complete');

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-planrun';
// WI-7311: 'papercup' is a RETIRED slug — migration 656's `harness_plans_canonicalize_slug`
// trigger unconditionally rewrites `harness_slug='papercup'` to 'papercusp' on INSERT
// (WHEN clause, workspace-independent), while the app-level `routineStorageSlug` read
// path is workspace/pot-scoped and fails open to the RAW slug in this isolated test
// fixture's fake workspace (which has no seeded pots). That mismatch — write-side
// trigger canonicalizes, read-side resolver doesn't — made every test in this file fail
// "template not found" even though the row genuinely exists (just under 'papercusp', not
// the 'papercup' the test asked for and later reads back). Any non-reserved slug avoids
// the trigger's WHEN clause entirely.
const HARNESS = 'plan-run-it-fixture';
const APP_HARNESS = 'email-plan-run-it-fixture';
const TEMPLATE = 'monitor-x';
const TEMPLATE_CONTENT = `# Monitor X

## Now
**State:** recurring.
**Next:** run.

## Phase 1

- **P-001** \`todo\` check campaign stats
- **P-002** \`done\` already handled
- **P-003** \`todo\` post the summary blocked-by: P-001`;

const ITEMS = [
  { id: 'P-001', text: 'check campaign stats', status: 'todo' },
  { id: 'P-002', text: 'already handled', status: 'done' }, // skipped (done)
  { id: 'P-003', text: 'post the summary', status: 'todo', blockedBy: ['P-001'] },
];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([0])}, 'kc-plan-run-it', 0),
           (${WS}, ${APP_HARNESS}, ${Buffer.from([1])}, 'kc-plan-run-app-it', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
  // The real work_items:complete finish saga resolves the plan scope before
  // reflecting the root plan item to done. Register both fixture harnesses as
  // real Hive homes so that lookup is production-faithful rather than mocked.
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (
      ${WS},
      ${JSON.stringify({
        projects: [
          { slug: HARNESS, path: '/tmp/plan-run-it', harness_kind: 'hive' },
          { slug: APP_HARNESS, path: '/tmp/email-plan-run-it', harness_kind: 'hive' },
        ],
      })}::text::jsonb
    )
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload
  `;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  // This database belongs only to this suite. Clear minted dependency edges before
  // their endpoint rows: the production delete guard correctly refuses the reverse
  // order, which would otherwise strand every test after the first successful run.
  await sql`TRUNCATE harness_shared.work_item_deps`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS})`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS}) AND workspace_id = ${WS}`;
  // Instance slugs (`<template>@run-<n>`) repeat across cases, so revisions must be reset
  // with their plans or a case inherits the previous cases' revision rows.
  await sql`DELETE FROM harness_shared.plan_revisions WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS}) AND workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS}) AND workspace_id = ${WS}`;
  // Seed the TEMPLATE plan with a parsed items index.
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${HARNESS}, ${TEMPLATE}, 'Monitor X', 'active',
            ${TEMPLATE_CONTENT}, ${hashPlanContent(TEMPLATE_CONTENT)},
            ${JSON.stringify(ITEMS)}::text::jsonb)
  `;
  // This fixture predates acceptance BAR adoption. Migration 1111 stamps new
  // rows post-epoch on INSERT; preserve the legacy cohort the test models.
  await sql`
    UPDATE harness_shared.harness_plans
       SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}
  `;
  // Materialize its schedule → the plan-schedule routine (7b).
  await materializePlanSchedule({
    workspaceId: WS,
    harnessSlug: HARNESS,
    templateSlug: TEMPLATE,
    schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
    sql,
  });
});

/** Simulate the routinesTick claim stamping last_fired_at (the replay-stable run token). */
async function stampClaim(at: Date): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET last_fired_at = ${at.toISOString()}::timestamptz
     WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(TEMPLATE)}
  `;
}

/** Complete through the real agent-facing saga so plan-item reflection and the
 * settled dependency event are both part of the acceptance boundary. */
async function completeExecutionWorkItem(id: string, actor: string): Promise<Record<string, unknown>> {
  const parsed = (completeWorkItemTool.args as { parse: (value: unknown) => unknown }).parse({
    id,
    state: 'done',
    assumptions: 'none',
    completion: {
      summary: 'Acceptance fixture root completed',
      testsRun: 'plan-run-action.integration.test.ts real shared-seam acceptance',
      testResult: 'root execution completed successfully',
      verifiedHow: 'integration',
    },
  });
  const response = (await completeWorkItemTool.handler(
    parsed as never,
    {
      uiClientId: actor,
      isSuperuser: true,
      workspaceId: WS,
    } as never,
  )) as { data?: { results?: Record<string, unknown>[] } };
  return response.data?.results?.[0] ?? {};
}

/** WI-10004815: a wake-count mismatch must name the writer of every wake. */
function describeDeliveries(rows: Awaited<ReturnType<typeof listRecentDeliveries>>): string {
  return JSON.stringify(
    rows.map((row) => ({
      source: row.source,
      summary: row.summary,
      workItemIds: (row.payload as { workItemIds?: unknown } | null)?.workItemIds,
      createdAt: row.createdAt,
    })),
    null,
    2,
  );
}

describe('runScheduledPlanFire (system:plan-run)', () => {
  it('runs two isolated neutral plan operations with different schemas through the shared admission contract', async () => {
    const secondTemplate = 'score-template';
    const secondContent = '# Score Template\n\n## Now\n**State:** ready.\n**Next:** score.\n\n## Phase 1\n\n- **P-001** `todo` score the batch';
    await materializePlanSchedule({
      workspaceId: WS, harnessSlug: HARNESS, templateSlug: TEMPLATE,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
      concurrency: 'queue', sql,
    });
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
      VALUES (${WS}, ${APP_HARNESS}, ${secondTemplate}, 'Score Template', 'active',
              ${secondContent}, ${hashPlanContent(secondContent)},
              ${JSON.stringify([{ id: 'P-001', text: 'score the batch', status: 'todo' }])}::text::jsonb)`;
    await sql`
      UPDATE harness_shared.harness_plans
         SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
       WHERE workspace_id = ${WS} AND harness_slug = ${APP_HARNESS} AND plan_slug = ${secondTemplate}`;
    await materializePlanSchedule({
      workspaceId: WS, harnessSlug: APP_HARNESS, templateSlug: secondTemplate,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
      concurrency: 'queue', sql,
    });
    const consumers = [
      { harness: HARNESS, template: TEMPLATE, content: TEMPLATE_CONTENT,
        operationId: 'extract-plan', callerId: 'pi:extract-consumer', input: { segment: 'east' },
        expectedPhase: 'waiting',
        outputSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } },
      { harness: APP_HARNESS, template: secondTemplate, content: secondContent,
        operationId: 'score-plan', callerId: 'pi:score-consumer', input: { count: 7 },
        expectedPhase: 'accepted',
        outputSchema: { type: 'object', required: ['score'], properties: { score: { type: 'integer' } } } },
    ] as const;
    const handles = [];
    for (const consumer of consumers) {
      const [key, value] = Object.entries(consumer.input)[0]!;
      const source = {
        id: `neutral-${consumer.operationId}`, workItem: { kind: 'feature' },
        roles: [{ id: 'worker' }],
        spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: consumer.operationId } }] },
        operations: [{
          id: 'root-program', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'program' },
          inputSchema: { type: 'object', required: [key], additionalProperties: false,
            properties: { [key]: { type: typeof value === 'number' ? 'integer' : 'string' } } },
          acceptance: { resultSchema: consumer.outputSchema },
        }, {
          id: consumer.operationId, version: '1',
          target: { kind: 'plan', template: { kind: 'plan-template', ref: consumer.template,
            revision: '0', contentHash: hashPlanContent(consumer.content) } },
          inputSchema: { type: 'object', required: [key], additionalProperties: false,
            properties: { [key]: { type: typeof value === 'number' ? 'integer' : 'string' } } },
          acceptance: { resultSchema: consumer.outputSchema },
        }, {
          id: 'leaf', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
          execution: { kind: 'agent', role: 'worker' },
          // An agent work-item operation must pin the worker identity it will bind
          // (validate.ts operation-unpinned-agent; WI-10008190).
          policy: { identity: { kind: 'identity', ref: 'neutral-leaf-worker', revision: '1.0.0', contentHash: 'b'.repeat(64) } },
          inputSchema: { type: 'object', required: [key], additionalProperties: false,
            properties: { [key]: { type: typeof value === 'number' ? 'integer' : 'string' } } },
          acceptance: { resultSchema: consumer.outputSchema },
        }],
      };
      await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: consumer.harness,
        blueprint: BlueprintSchema.parse(source), specification: compileAgentSpecification({ source }) });
      const request = { workspaceId: WS, harnessSlug: consumer.harness, callerId: consumer.callerId,
        operationId: consumer.operationId, requestKey: 'neutral-plan', input: consumer.input };
      const handle = await submitBlueprintOperation(sql, request);
      expect(handle.target.kind).toBe('plan');
      expect(await submitBlueprintOperation(sql, request)).toEqual(handle);
      await expect(submitBlueprintOperation(sql, { ...request, input: { [key]: typeof value === 'number' ? 8 : 'west' } }))
        .rejects.toThrow('reused with different input');
      expect(await getBlueprintOperationStatus(sql, handle, consumer.callerId))
        .toMatchObject({ phase: consumer.expectedPhase, outcome: null });
      handles.push(handle);
      const root = await submitBlueprintOperation(sql, {
        ...request, operationId: 'root-program', requestKey: 'neutral-program',
      });
      if (root.target.kind !== 'work-item') throw new Error('program root must be a work item');
      const [rootRow] = await sql<Array<{ updated_ts: string | number }>>`
        SELECT updated_ts FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND harness_slug = ${consumer.harness}
           AND feature_id = ${root.target.id}`;
      const parent = { blueprintId: source.id, payload: {}, callerId: consumer.callerId,
        workspaceId: WS, harnessSlug: consumer.harness, workItemId: root.target.id,
        runId: 'neutral-program', acceptedAttemptUpdatedTs: Number(rootRow.updated_ts),
        acceptedOperation: root };
      const planChildRequest = { stepId: 'op-plan', operationId: consumer.operationId,
        input: consumer.input };
      const planChild = await submitAcceptedCoordProgramChild(sql, parent, planChildRequest);
      expect(planChild.target.kind).toBe('plan');
      expect(planChild.specificationRevision).toBe(root.specificationRevision);
      expect(await submitAcceptedCoordProgramChild(sql, parent, planChildRequest)).toEqual(planChild);
      expect(await loadAcceptedCoordProgramChild(sql, parent, 'plan', consumer.operationId))
        .toEqual(planChild);
      const leafChildRequest = { stepId: 'op-leaf', operationId: 'leaf', input: consumer.input };
      const leafChild = await submitAcceptedCoordProgramChild(sql, parent, leafChildRequest);
      expect(leafChild.target.kind).toBe('work-item');
      expect(leafChild.specificationRevision).toBe(root.specificationRevision);
      expect(await loadAcceptedCoordProgramChild(sql, parent, 'leaf', 'leaf')).toEqual(leafChild);
      await expect(getBlueprintOperationStatus(sql, planChild,
        consumers.find((candidate) => candidate.callerId !== consumer.callerId)!.callerId))
        .rejects.toThrow('does not match its durable receipt');
    }
    expect(handles[0]!.target).not.toEqual(handles[1]!.target);
    await expect(getBlueprintOperationStatus(sql, handles[0]!, consumers[1]!.callerId))
      .rejects.toThrow('does not match its durable receipt');
    await expect(cancelBlueprintOperation(sql, handles[1]!, consumers[0]!.callerId,
      { requestKey: 'foreign-cancel', reason: 'foreign' }))
      .rejects.toThrow('does not match its durable receipt');
    const [counts] = await sql<Array<{ runs: number; instances: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.plan_runs
                WHERE workspace_id = ${WS} AND harness_slug IN (${HARNESS}, ${APP_HARNESS})) AS runs,
             (SELECT count(*)::int FROM harness_shared.harness_plans
                WHERE workspace_id = ${WS} AND harness_slug IN (${HARNESS}, ${APP_HARNESS})
                  AND plan_slug LIKE '%@run-%') AS instances`;
    expect(counts).toEqual({ runs: 4, instances: 4 });
  }, 90_000);

  it('lets an accepted program invoke a pinned plan child and wait for the canonical plan outcome', async () => {
    const rubric = { rubricId: 'plan-child-result-quality', characteristic: 'quality',
      description: 'Final plan output quality', methodRef: null,
      ratingScale: ['pass', 'partial', 'fail', 'unknown'],
      criteria: [{ key: 'complete', title: 'Complete', model: 'Plan output is complete',
        method: 'Read the final outputs', driftMarkers: 'Missing count' }] };
    const rubricPin = pinPackageInput({ packageKind: 'rubric', ref: rubric.rubricId,
      revision: '1.0.0', files: [], dependencies: [], value: rubric });
    const source = {
      id: 'program-plan-child', version: '1', workItem: { kind: 'feature' },
      roles: [{ id: 'worker' }],
      spine: { steps: [{ id: 'open', op: 'coord:thread-open', args: { title: 'Plan child' } }] },
      operations: [{
        id: 'root', version: '1', target: { kind: 'work-item', itemKind: 'feature' },
        execution: { kind: 'program' }, inputSchema: { type: 'object' },
        acceptance: { resultSchema: { type: 'object' } },
      }, {
        id: 'run-monitor', version: '1', target: { kind: 'plan', template: {
          kind: 'plan-template', ref: TEMPLATE, revision: '0',
          contentHash: hashPlanContent(TEMPLATE_CONTENT),
        } },
        inputSchema: { type: 'object', required: ['segment'],
          properties: { segment: { type: 'string' } } },
        acceptance: { resultSchema: { type: 'object' }, rubric: {
          kind: 'rubric', ref: rubric.rubricId, revision: rubricPin.revision,
          contentHash: rubricPin.contentHash,
        } },
      }],
    };
    const blueprint = BlueprintSchema.parse(source);
    await projectBlueprintToPg(sql, { workspaceId: WS, harnessSlug: HARNESS, blueprint,
      specification: compileAgentSpecification({ source, inputClosure: [rubricPin] }) });
    const root = await submitBlueprintOperation(sql, {
      workspaceId: WS, harnessSlug: HARNESS, callerId: 'program-plan-caller',
      operationId: 'root', requestKey: 'plan-child-root', input: {}, title: 'Program root',
    });
    if (root.target.kind !== 'work-item') throw new Error('program root must be a work item');
    const [row] = await sql<Array<{ updated_ts: number | string }>>`
      SELECT updated_ts FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${root.target.id}
    `;
    const parent = { blueprintId: blueprint.id, payload: {}, callerId: 'program-plan-caller',
      workspaceId: WS, harnessSlug: HARNESS, workItemId: root.target.id, runId: 'plan-child-root',
      acceptedAttemptUpdatedTs: Number(row.updated_ts), acceptedOperation: root };
    const request = { stepId: 'op-plan', operationId: 'run-monitor', input: { segment: 'east' } };
    const child = await submitAcceptedCoordProgramChild(sql, parent, request);
    expect(child.target.kind).toBe('plan');
    expect(await submitAcceptedCoordProgramChild(sql, parent, request)).toEqual(child);
    expect(await loadAcceptedCoordProgramChild(sql, parent, 'plan', 'run-monitor')).toEqual(child);
    await expect(awaitAcceptedCoordProgramChild(sql, parent, {
      invokeStepId: 'plan', operationId: 'run-monitor', deadlineAt: new Date(0).toISOString(),
    })).rejects.toThrow('did not settle before its deadline');
    if (child.target.kind !== 'plan') throw new Error('plan child handle was lost');
    await sql`
      UPDATE harness_shared.work_items SET status = 'passed', authority = 'committed'
       WHERE workspace_id = ${WS} AND payload->'plan_run'->>'runId' = ${String(child.target.runId)}
         AND payload->'plan_run'->>'instancePlanSlug' = ${child.target.instanceSlug}
    `;
    await sql`
      UPDATE harness_shared.plan_runs
         SET status = 'done', outcome = 'success', outputs = ${JSON.stringify({ count: 2 })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND id = ${child.target.runId}
    `;
    expect(await getBlueprintOperationResult(sql, child, parent.callerId))
      .toMatchObject({ state: 'unavailable', status: { outcome: 'unverified' } });
    await expect(awaitAcceptedCoordProgramChild(sql, parent, {
      invokeStepId: 'plan', operationId: 'run-monitor',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }, async () => { throw new Error('settled child must not sleep'); }))
      .rejects.toThrow('settled without validated success: unavailable');
    const subjectRef = blueprintOperationAcceptanceSubjectRef({
      targetRef: `plan-run:${child.target.runId}`, attemptRef: `plan-run:${child.target.runId}`,
      operationId: child.operationId, specificationRevision: child.specificationRevision,
      output: { count: 2 },
    });
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      VALUES (${WS}, 'EI-plan-child-result-grade', 'change', ${`harness:${HARNESS}`},
        'plan child output grade', '', 'minor', 'test', 'done',
        ${JSON.stringify({ observation: { rubricRef: rubric.rubricId, rubricRevision: 1,
          criteriaHash: seedContentHash(rubric), evidenceFingerprint: 'fixture-plan-child',
          subject: { ref: subjectRef },
          ratings: { complete: { rating: 'pass', evidence: 'Final count is present' } },
        } })}::text::jsonb,
        'su-grader', 'organic', now(), now())
    `;
    expect(await awaitAcceptedCoordProgramChild(sql, parent, {
      invokeStepId: 'plan', operationId: 'run-monitor',
      deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }, async () => { throw new Error('settled child must not sleep'); }))
      .toMatchObject({ state: 'ready', output: { count: 2 }, evidenceRef: `plan-run:${child.target.runId}` });
  }, 90_000);

  it('admits one pinned blueprint plan run under concurrent replay and repairs an interrupted receipt update', async () => {
    const source = {
      id: 'plan-invocation-fixture', workItem: { kind: 'feature' },
      roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
      operations: [{
        id: 'run-monitor', version: '1',
        target: { kind: 'plan', template: {
          kind: 'plan-template', ref: TEMPLATE, revision: '0',
          contentHash: hashPlanContent(TEMPLATE_CONTENT),
        } },
        inputSchema: { type: 'object', required: ['segment'], additionalProperties: false,
          properties: { segment: { type: 'string' } } },
        acceptance: { resultSchema: { type: 'object' } },
        signals: { note: { payloadSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } },
        waits: { approve: { responseSchema: { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } } } },
      }],
    };
    const blueprint = BlueprintSchema.parse(source);
    await projectBlueprintToPg(sql, {
      workspaceId: WS, harnessSlug: HARNESS, blueprint,
      specification: compileAgentSpecification({ source }),
    });
    const request = {
      workspaceId: WS, harnessSlug: HARNESS, callerId: 'test-principal',
      operationId: 'run-monitor', requestKey: 'batch-001', input: { segment: 'east' },
    };
    const [first, second] = await Promise.all([
      acceptBlueprintPlanRun(sql, request), acceptBlueprintPlanRun(sql, request),
    ]);
    expect(second.instanceSlug).toBe(first.instanceSlug);
    expect(second.runId).toBe(first.runId);
    const population = await sql<Array<{ runs: number; instances: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND instance_plan_slug = ${first.instanceSlug}) AS runs,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND plan_slug = ${first.instanceSlug}) AS instances
    `;
    expect(population[0]).toMatchObject({ runs: 1, instances: 1 });
    const instanceCohort = await sql<Array<{ epoch: number | null; cohort: string | null }>>`
      SELECT acceptance_bar_epoch AS epoch, acceptance_bar_cohort AS cohort
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND plan_slug = ${first.instanceSlug}
    `;
    expect(instanceCohort[0]).toMatchObject({ epoch: null, cohort: null });

    // The plan run committed, but the receipt's final target update did not.
    await sql`
      UPDATE harness_shared.blueprint_operation_invocations SET target_ref = NULL
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND caller_id = 'test-principal' AND operation_id = 'run-monitor'
         AND request_key = 'batch-001'
    `;
    // The seed and promotion committed before the receipt target update; then
    // the template changed. Replay must still finish from the original seed.
    await sql`
      UPDATE harness_shared.harness_plans SET version = version + 1
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}
    `;
    const repaired = await acceptBlueprintPlanRun(sql, request);
    expect(repaired).toMatchObject({ instanceSlug: first.instanceSlug, runId: first.runId, replayed: true });
    const handle = await submitBlueprintOperation(sql, request);
    expect(handle.target).toEqual({ kind: 'plan', runId: first.runId, instanceSlug: first.instanceSlug });
    const status = await getBlueprintOperationStatus(sql, handle, request.callerId);
    expect(status).toMatchObject({ phase: 'waiting', outcome: null });
    expect(status.items).toHaveLength(2);
    await expect(getBlueprintOperationStatus(sql, handle, 'other-principal'))
      .rejects.toThrow('does not match its durable receipt');
    const signal = await signalBlueprintOperation(sql, handle, request.callerId, {
      channel: 'note', payload: { text: 'continue' }, requestKey: 'plan-note',
    });
    expect(signal).toMatchObject({ accepted: true, handled: false });
    await openBlueprintOperationWait(sql, handle, request.callerId, { waitName: 'approve', token: 'plan-wait' });
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ wait: { name: 'approve', token: 'plan-wait' } });
    const response = await resumeBlueprintOperation(sql, handle, request.callerId, {
      token: 'plan-wait', response: { approved: true }, requestKey: 'plan-resume',
    });
    expect(response).toMatchObject({ accepted: true, handled: false });
    const cancellation = await cancelBlueprintOperation(sql, handle, request.callerId, {
      requestKey: 'plan-cancel', reason: 'Stop this run',
    });
    expect(cancellation).toMatchObject({ accepted: true, effected: false });
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ cancellationRequested: true, wait: null });
    const cancelledChildren = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND payload->'plan_run'->>'runId' = ${String(first.runId)}
         AND payload ? 'blueprintCancellation'
    `;
    expect(cancelledChildren[0]?.n).toBe(2);
    const eventPage = await getBlueprintOperationEvents(sql, handle, request.callerId, { limit: 1 });
    expect(eventPage.events).toHaveLength(1);
    expect(eventPage.hasMore).toBe(true);
    expect((await getBlueprintOperationEvents(sql, handle, request.callerId, { cursor: eventPage.cursor })).events.length).toBeGreaterThan(0);
    await expect(acceptBlueprintPlanRun(sql, { ...request, input: { segment: 'west' } }))
      .rejects.toThrow('reused with different input');

    await expect(acceptBlueprintPlanRun(sql, { ...request, requestKey: 'batch-002' }))
      .rejects.toThrow('plan_run_template_pin_mismatch');
    expect((await acceptBlueprintPlanRun(sql, request)).runId).toBe(first.runId);
    const beforeOutcome = await getBlueprintOperationEvents(sql, handle, request.callerId);
    await sql`
      UPDATE harness_shared.plan_runs
         SET status = 'done', outcome = 'partial', outputs = ${JSON.stringify({ count: 1 })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND id = ${first.runId}
    `;
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    expect(await getBlueprintOperationResult(sql, handle, request.callerId))
      .toMatchObject({ state: 'failed' });
    expect((await getBlueprintOperationEvents(sql, handle, request.callerId, { cursor: beforeOutcome.cursor })).events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'plan-run', status: 'done', outcome: 'partial', outputStored: true }),
      ]));

    await sql`
      UPDATE harness_shared.work_items SET status = 'passed', authority = 'committed'
       WHERE workspace_id = ${WS} AND payload->'plan_run'->>'runId' = ${String(first.runId)}
         AND payload->'plan_run'->>'instancePlanSlug' = ${first.instanceSlug}
    `;
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ phase: 'terminal', outcome: 'failed' });
    await sql`
      UPDATE harness_shared.plan_runs SET status = 'done', outcome = 'success', outputs = '[]'::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND id = ${first.runId}
    `;
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ phase: 'terminal', outcome: 'unverified' });
    expect(await getBlueprintOperationResult(sql, handle, request.callerId))
      .toMatchObject({ state: 'unavailable', status: { outcome: 'unverified' } });
    await sql`
      UPDATE harness_shared.plan_runs SET outputs = ${JSON.stringify({ count: 2 })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND id = ${first.runId}
    `;
    expect(await getBlueprintOperationStatus(sql, handle, request.callerId))
      .toMatchObject({ phase: 'terminal', outcome: 'succeeded' });
    expect(await getBlueprintOperationResult(sql, handle, request.callerId))
      .toMatchObject({ state: 'ready', output: { count: 2 } });

    const leafOwner = 'leaf-recursion-test';
    const leafRevision = { specificationRevision: 'a'.repeat(64), stateRevision: 'state-leaf' };
    const leafPin = { kind: 'blueprint-operation', harnessSlug: HARNESS,
      operationId: 'leaf-step', specificationRevision: 'c'.repeat(64),
      operationVersion: '1.0.0', input: {} };
    const leafSession = await recordAdvSession({ workspaceId: WS, mode: 'console',
      role: 'worker', coordOwnerId: leafOwner });
    if (!leafSession) throw new Error('worker session fixture was not recorded');
    await sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${sql.json({
      workspaceId: WS, harnessSlug: HARNESS, role: 'worker', ...leafRevision,
      specificationArtifact: { configuration: { grants: {} } },
      acceptedOperation: { kind: 'blueprint-operation-worker', workItemId: 'F-leaf',
        operationId: 'leaf-step', specificationRevision: leafPin.specificationRevision,
        pin: leafPin,
        identity: { ref: 'leaf-worker', revision: '1.0.0', contentHash: 'd'.repeat(64) },
        requiredTools: ['blueprint:submit'] },
    })} WHERE id = ${leafSession}`;
    await sql`INSERT INTO harness_shared.session_briefs (workspace_id, owner_id, control_state)
      VALUES (${WS}, ${leafOwner}, ${sql.json({ activation: {
        schemaVersion: 1,
        attribution: { actorId: leafOwner, principalId: leafOwner, sessionId: leafOwner },
        desired: leafRevision, prepared: null, applied: leafRevision, status: 'applied',
      } })})`;
    await expect(acceptBlueprintPlanRun(sql, { ...request, callerId: leafOwner, requestKey: 'leaf-recursion' }))
      .rejects.toThrow('plan leaf operation cannot recursively relaunch a plan');
    const [leafReceipts] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${WS} AND caller_id = ${leafOwner}`;
    expect(leafReceipts.n).toBe(0);
  });
  it('rejects an invalid executable dependency candidate before the instance and ledger transaction lands', async () => {
    const invalidContent = TEMPLATE_CONTENT.replace('blocked-by: P-001', 'blocked-by: P-404');
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${invalidContent},
             content_hash = ${hashPlanContent(invalidContent)},
             items = ${JSON.stringify([ITEMS[0], ITEMS[1], { ...ITEMS[2], blockedBy: ['P-404'] }])}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}
    `;
    await stampClaim(new Date('2026-06-16T08:30:00.000Z'));

    await expect(
      runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE }),
    ).rejects.toThrow(/invalid_plan_dependencies.*P-003 -> P-404/);

    const [counts] = await sql<Array<{ instances: number; runs: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND template_slug = ${TEMPLATE}) AS instances,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}) AS runs
    `;
    expect(counts).toEqual({ instances: 0, runs: 0 });
  });

  it('mints a run: instance plan + plan_runs row + run-scoped work_items', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();
    expect(res!.replayed).toBe(false);
    expect(res!.runSeq).toBe(0);
    expect(res!.minted).toBe(2); // P-001 + P-003 (P-002 is done → skipped)
    expect(res!.workItemIds).toHaveLength(2);
    expect(res!.actionableWorkItemIds).toHaveLength(1); // P-003 is blocked by P-001
    const unrelatedBlueprintEvents = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.coord_event_log
       WHERE workspace_id = ${WS} AND surface = 'blueprint-operation'
         AND body->>'kind' = 'plan-run' AND body->>'runId' = ${String(res!.runId)}
    `;
    expect(unrelatedBlueprintEvents[0]?.n).toBe(0);

    // Instance plan: a copy pinned to the template, hidden from the main list.
    const inst = await sql<Array<{ template_slug: string; run_seq: number; content: string }>>`
      SELECT template_slug, run_seq, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst[0]).toBeTruthy();
    expect(inst[0].template_slug).toBe(TEMPLATE);
    expect(inst[0].run_seq).toBe(0);
    expect(inst[0].content).toContain('Monitor X');

    // plan_runs ledger row, keyed on the TEMPLATE slug.
    const run = await sql<
      Array<{ run_type: string; trigger: string; instance_plan_slug: string; status: string; workspace_id: string }>
    >`
      SELECT run_type, trigger, instance_plan_slug, status, workspace_id FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(run).toHaveLength(1);
    expect(run[0].run_type).toBe('scheduled');
    expect(run[0].trigger).toBe('scheduled');
    expect(run[0].instance_plan_slug).toBe(res!.instanceSlug);
    expect(run[0].status).toBe('running');
    // EI-1368: the fire MUST stamp workspace_id (was '' before), else the run is invisible to
    // the workspace-scoped listPlanRuns/getPlanRun reads (Runs/Agents tab + plans:runs/run-transcript).
    expect(run[0].workspace_id).toBe(WS);

    // Run-scoped frontier work_items: source_plan_slug = TEMPLATE, payload.plan_run = the run.
    const wis = await sql<
      Array<{ feature_id: string; source_plan_slug: string; status: string; payload: Record<string, unknown> }>
    >`
      SELECT feature_id, source_plan_slug, status, payload FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS} AND source_plan_slug = ${TEMPLATE}`;
    expect(wis).toHaveLength(2);
    expect(wis.map((wi) => wi.status).sort()).toEqual(['blocked', 'open']);
    for (const wi of wis) {
      expect(wi.source_plan_slug).toBe(TEMPLATE);
      expect((wi.payload as any).plan_run.runId).toBe(res!.runId);
      expect((wi.payload as any).plan_run.templateSlug).toBe(TEMPLATE);
      expect((wi.payload as any).plan_item.plan_slug).toBe(res!.instanceSlug);
    }
    const edges = await sql<Array<{ blocked_ref: string; blocker_ref: string }>>`
      SELECT blocked_ref, blocker_ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'`;
    expect(edges).toHaveLength(1);
  });

  it("WI-10003495: the run instance inherits the template's output_schema (plans:publish-outputs needs it)", async () => {
    const outputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    await sql`
      UPDATE harness_shared.harness_plans
         SET output_schema = ${sql.json(outputSchema)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T09:30:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();
    const inst = await sql<Array<{ output_schema: unknown }>>`
      SELECT output_schema FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst).toHaveLength(1);
    expect(inst[0].output_schema).toEqual(outputSchema);
  });

  it('drives template instance → canonical promotion → stable assignment/wake across replay and dependency release', async () => {
    const execution = { appHarnessSlug: APP_HARNESS, agentName: 'email-agent' };
    const wakeOwner = 'su-email-plan-run-it';
    const genericWaiter = 'su-generic-claim-racer';
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = ${JSON.stringify({ kind: 'rrule', rrule: 'FREQ=DAILY', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T10:00:00.000Z'));
    await upsertInboxWakeAwait({
      subscriberId: wakeOwner,
      eventKey: inboxWakeKey(wakeOwner),
      note: 'real plan-run acceptance wake target',
      minSleepSec: 0,
    });
    await recordAdvSession({
      workspaceId: WS,
      mode: 'console',
      agent: 'codex',
      coordOwnerId: wakeOwner,
    });
    await adoptAgentName(WS, wakeOwner, execution.agentName, wakeOwner);
    setAutoPumpEnabledForTests(false);
    try {
      const result = await runScheduledPlanFire(sql, {
        installSlug: HARNESS,
        workspaceId: WS,
        templateSlug: TEMPLATE,
      });

      expect(result.started).toBe(true);
      if (result.started !== true) throw new Error(`expected plan run to start, got ${result.reason}`);
      expect(result).toMatchObject({
        execution,
        replayed: false,
        minted: 2,
        dispatch: {
          ok: true,
          target: { ownerId: wakeOwner },
          assignment: { assigned: result!.actionableWorkItemIds, retained: [] },
          wake: { queued: 1 },
        },
      });
      expect(result!.actionableWorkItemIds).toHaveLength(1);
      expect(result!.workItemIds).toHaveLength(2);

      const appRows = await sql<
        Array<{
          id: string;
          harness: string;
          status: string;
          assignee: string | null;
          plan_item_id: string;
          payload: Record<string, any>;
        }>
      >`
        SELECT feature_id AS id, harness_slug AS harness, status, taken_by AS assignee,
               payload -> 'plan_item' ->> 'item_id' AS plan_item_id, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ${WS}
           AND payload -> 'plan_run' ->> 'runId' = ${String(result!.runId)}
         ORDER BY plan_item_id`;
      expect(appRows).toHaveLength(2);
      expect(appRows.every((row) => row.harness === APP_HARNESS)).toBe(true);
      expect(appRows.every((row) => row.payload.plan_run.execution.agentName === 'email-agent')).toBe(true);
      const root = appRows.find((row) => row.plan_item_id === 'P-001')!;
      const child = appRows.find((row) => row.plan_item_id === 'P-003')!;
      expect(root).toMatchObject({ status: 'open', assignee: 'email-agent' });
      expect(child).toMatchObject({ status: 'blocked', assignee: null });
      expect(await readUnresolvedDepBlockers(child.id, APP_HARNESS)).toEqual([
        expect.objectContaining({ ref: `${APP_HARNESS}#${root.id}` }),
      ]);

      // A deterministic replay reuses the same run and execution records. It
      // may re-wake the retained root to heal a crash, but never duplicates rows.
      const replay = await runScheduledPlanFire(sql, {
        installSlug: HARNESS,
        workspaceId: WS,
        templateSlug: TEMPLATE,
      });
      expect(replay).toMatchObject({
        runId: result!.runId,
        replayed: true,
        minted: 0,
        workItemIds: result!.workItemIds,
        dispatch: { ok: true, assignment: { assigned: [], retained: [root.id] } },
      });
      const count = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM harness_shared.work_items
         WHERE workspace_id = ${WS}
           AND payload -> 'plan_run' ->> 'runId' = ${String(result!.runId)}`;
      expect(count[0].n).toBe(2);

      await registerAwait({
        subscriberId: genericWaiter,
        eventKey: 'work-item:claimable',
        once: false,
        minSleepSec: 0,
      });
      const beforeSuccessorWake = (await listRecentDeliveries(wakeOwner)).length;
      // EI-24164176252375850 tracks the separate timing warning. This test
      // asserts assignment and dependency behavior; fail on any other warning.
      const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
        if (typeof message === 'string' && message.startsWith('[plans:set-status] slow ')) return;
        throw new Error(`unexpected warning during completion: ${String(message)}`);
      });
      let completed: Record<string, unknown>;
      try {
        completed = await completeExecutionWorkItem(root.id, 'email-agent');
        await drainDetached();
      } finally {
        warn.mockRestore();
      }
      expect(completed, JSON.stringify(completed, null, 2)).toMatchObject({
        ok: true,
        finish: { complete: true, planItem: 'done' },
      });

      const rootAfter = await observeWorkItem(root.id, { harness: APP_HARNESS });
      const childAfter = await observeWorkItem(child.id, { harness: APP_HARNESS });
      expect(rootAfter?.item).toMatchObject({ state: 'done', assignee: null });
      expect(await readUnresolvedDepBlockers(child.id, APP_HARNESS)).toEqual([]);
      expect(childAfter?.item).toMatchObject({ state: 'open', assignee: 'email-agent' });

      const successorDeliveries = await listRecentDeliveries(wakeOwner);
      expect(successorDeliveries, describeDeliveries(successorDeliveries)).toHaveLength(beforeSuccessorWake + 1);
      expect(successorDeliveries[0]).toMatchObject({
        eventKey: inboxWakeKey(wakeOwner),
        payload: { kind: 'actionable-work-item-dispatch', workItemIds: [child.id] },
      });
      expect(await listRecentDeliveries(genericWaiter)).toHaveLength(0);

      // WI-10004815: two writers dispatch a released successor — the settle
      // path (work-items-events) and the plan-lane restore. The settle path
      // reads the dependent BEFORE it dispatches, so when the lane path
      // assigns and wakes the stable agent inside that window, the settle path
      // still holds a snapshot with no assignee. Replay exactly that order:
      // the dispatch must find the row already retained and spend no 2nd wake.
      const assignedChild = await getWorkItem(child.id, APP_HARNESS);
      expect(assignedChild?.assignee).toBe('email-agent');
      const staleSnapshot = { ...assignedChild!, assignee: null };
      const staleGetItem = (async (id: string, harness?: string) =>
        id === child.id ? staleSnapshot : getWorkItem(id, harness)) as typeof getWorkItem;
      const childRef = { kind: FEATURE_KIND, ref: `${APP_HARNESS}#${child.id}` };
      await emitUnblockedOnEdgeRemoved(childRef, root.id, { getItem: staleGetItem });
      await drainDetached();
      const afterStaleSettle = await listRecentDeliveries(wakeOwner);
      expect(afterStaleSettle, describeDeliveries(afterStaleSettle)).toHaveLength(successorDeliveries.length);
      expect(await listRecentDeliveries(genericWaiter)).toHaveLength(0);

      // CONTROL: the same replay with the pre-fix dispatch (which also wakes a
      // row the target already retains) must add exactly one wake. Without
      // this, the assertion above would also pass if the stale snapshot never
      // reached the dispatch at all.
      await emitUnblockedOnEdgeRemoved(childRef, root.id, {
        getItem: staleGetItem,
        dispatchActionable: ((args: Parameters<typeof assignAndWakeActionableWorkItems>[0]) =>
          assignAndWakeActionableWorkItems({ ...args, wakeRetained: undefined })) as typeof assignAndWakeActionableWorkItems,
      });
      await drainDetached();
      const afterLegacyControl = await listRecentDeliveries(wakeOwner);
      expect(afterLegacyControl, describeDeliveries(afterLegacyControl)).toHaveLength(successorDeliveries.length + 1);
      expect(afterLegacyControl[0]).toMatchObject({
        source: 'system:plan-run-successor-dispatch',
        payload: { kind: 'actionable-work-item-dispatch', workItemIds: [child.id] },
      });

      const ledger = await sql<Array<{ harness: string }>>`
        SELECT harness_slug AS harness FROM harness_shared.plan_runs
         WHERE workspace_id = ${WS} AND id = ${result!.runId}`;
      expect(ledger[0].harness).toBe(APP_HARNESS);
    } finally {
      try {
        // Let naked fail-soft invalidations from plans:set-status finish while
        // the throwaway DB is still alive, then remove every standing/pending
        // liveness row this acceptance created. Without this cleanup, the
        // once:false generic waiter consumes later tests' ordinary promotion
        // events and fail-on-console attributes the pump narration to them.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const subscribers = [wakeOwner, genericWaiter];
        await sql`DELETE FROM harness_shared.event_wake_deliveries WHERE subscriber_id = ANY(${subscribers})`;
        await sql`DELETE FROM harness_shared.event_awaits WHERE subscriber_id = ANY(${subscribers})`;
        await sql`
          DELETE FROM harness_shared.agent_name_sessions
           WHERE workspace_id = ${WS} AND session_owner_id = ${wakeOwner}`;
        await sql`
          DELETE FROM harness_shared.agent_names
           WHERE workspace_id = ${WS} AND agent_name = ${execution.agentName}`;
        await sql`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id = ${wakeOwner}`;
      } finally {
        setAutoPumpEnabledForTests(true);
      }
    }
  });

  it('fails loudly for an absent stable target while preserving assigned queue state', async () => {
    const execution = { appHarnessSlug: APP_HARNESS, agentName: 'missing-email-agent' };
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = ${JSON.stringify({ kind: 'rrule', rrule: 'FREQ=DAILY', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T10:30:00.000Z'));

    const result = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
    });

    expect(result.started).toBe(true);
    if (result.started !== true) throw new Error(`expected plan run to start, got ${result.reason}`);
    expect(result.dispatch).toMatchObject({
      ok: false,
      failure: {
        code: 'target_absent',
        target: 'missing-email-agent',
        recoverable: true,
        queuePreserved: true,
      },
      assignment: { assigned: result!.actionableWorkItemIds },
      wake: { queued: 0 },
    });
    const assigned = await observeWorkItem(result!.actionableWorkItemIds[0], { harness: APP_HARNESS });
    expect(assigned?.item.assignee).toBe('missing-email-agent');
  });

  it('is replay-safe: re-firing the same claim is a no-op (no duplicate run)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const replay = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.replayed).toBe(false);
    expect(replay!.replayed).toBe(true);
    expect(replay!.runId).toBe(first!.runId);
    expect(replay!.minted).toBe(0);
    expect(replay!.workItemIds).toEqual(first!.workItemIds);
    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(1);
  });

  it('rolls back a partial mint so a durable replay can heal the complete run', async () => {
    const runToken = '1780000000001';
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.fail_plan_run_insert_once()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected plan_runs failure';
      END
      $$;
      CREATE TRIGGER fail_plan_run_insert_once
      BEFORE INSERT ON harness_shared.plan_runs
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_plan_run_insert_once();
    `);
    try {
      await expect(
        runScheduledPlanFire(sql, {
          installSlug: HARNESS,
          workspaceId: WS,
          templateSlug: TEMPLATE,
          trigger: 'event',
          runToken,
        }),
      ).rejects.toThrow(/injected plan_runs failure/);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS fail_plan_run_insert_once ON harness_shared.plan_runs;
        DROP FUNCTION IF EXISTS harness_shared.fail_plan_run_insert_once();
      `);
    }

    const instanceSlug = `${TEMPLATE}@run-${runToken}`;
    const partial = await sql<{ plans: number; runs: number; items: number }[]>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND plan_slug = ${instanceSlug}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND instance_plan_slug = ${instanceSlug}) AS runs,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND payload -> 'plan_run' ->> 'instancePlanSlug' = ${instanceSlug}) AS items`;
    expect(partial[0]).toEqual({ plans: 0, runs: 0, items: 0 });

    const replay = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'event',
      runToken,
    });
    expect(replay).toMatchObject({ instanceSlug, replayed: false, minted: 2 });
  });

  // EI-1386 — the overlap policy (D-014) was authored (set-schedule → routines.concurrency)
  // but nothing at fire time ever read it. beforeEach's default materialize omits
  // `concurrency`, which materializePlanSchedule defaults to 'skip'.
  it("concurrency='skip' (default): a fire is skipped while a prior run of the same template is still 'running' (EI-1386)", async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.replayed).toBe(false);
    expect(first!.minted).toBeGreaterThan(0);

    // Second fire: a DIFFERENT claim token (so it is not just a replay no-op), while the
    // first run's plan_runs row is still 'running'.
    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second.started).toBe(false);
    if (second.started !== false) throw new Error(`expected concurrency refusal, got started=${second.started}`);
    expect(second.skippedForConcurrency).toBe(true);
    expect(second.reason).toBe('concurrency-skip');
    expect(second.retryable).toBe(false);
    expect(second.priorRunId).toBe(first!.runId);
    expect(second.minted).toBe(0);
    expect(second.replayed).toBe(false); // a distinct outcome from replay, not conflated with it

    // Only ONE plan_runs row exists — the skip genuinely prevented a second mint, not just
    // a display-layer suppression.
    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(1);
  });

  it("concurrency='skip': once the prior run settles (status != 'running'), the next fire mints normally", async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${first!.runId}`;

    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second!.skippedForConcurrency).toBeFalsy();
    expect(second!.minted).toBeGreaterThan(0);
    expect(second!.runSeq).toBe(1);
  });

  it("concurrency='queue': mints anyway even while a prior run is still 'running' (unchanged default DB-column behavior)", async () => {
    // Re-materialize this template with an EXPLICIT 'queue' policy (overrides beforeEach's
    // app-layer 'skip' default).
    await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: TEMPLATE,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
      concurrency: 'queue',
      sql,
    });

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.minted).toBeGreaterThan(0);

    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second!.skippedForConcurrency).toBeFalsy();
    expect(second!.minted).toBeGreaterThan(0);
    expect(second!.runSeq).toBe(1);

    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(2);
  });

  it('run-now (manual) mints a fresh run after a scheduled fire — never replay-no-ops (EI-1369)', async () => {
    // A scheduled fire stamps last_fired_at (the replay-stable token for the cadence path).
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const sched = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(sched!.replayed).toBe(false);
    expect(sched!.runSeq).toBe(0);
    // EI-1386: the default concurrency policy is 'skip', which now genuinely skips a fire
    // while a prior run is still 'running' — settle it first, matching what a real manual
    // run-now against a completed cadence fire would see (this test is about run-TOKEN
    // uniqueness, not concurrency policy, which has its own dedicated tests above).
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${sched!.runId}`;

    // A MANUAL run-now must NOT reuse last_fired_at's token (that would recompute sched's slug and
    // replay-no-op). It mints a fresh run instead — even though last_fired_at is still set.
    const m1 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'manual',
    });
    expect(m1!.replayed).toBe(false);
    expect(m1!.instanceSlug).not.toBe(sched!.instanceSlug);
    expect(m1!.runSeq).toBe(1);
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${m1!.runId}`;

    // A SECOND manual run-now (potentially the same millisecond) still mints a distinct run —
    // the module-monotonic manual token guarantees uniqueness.
    const m2 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'manual',
    });
    expect(m2!.replayed).toBe(false);
    expect(m2!.instanceSlug).not.toBe(m1!.instanceSlug);
    expect(m2!.runSeq).toBe(2);

    const runs = await sql<{ trigger: string }[]>`
      SELECT trigger FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE} ORDER BY id`;
    expect(runs.map((r) => r.trigger)).toEqual(['scheduled', 'manual', 'manual']);
  });

  it('WI-10005127: two PROCESSES drawing the same manual millisecond mint two distinct runs, never one replayed run', async () => {
    // The manual token is Date.now() behind a PER-PROCESS monotonic counter. Two processes
    // (cluster workers, separate cold children) can draw the same millisecond. Pin the clock and
    // reset the counter between the fires to stand in for the second process. Before the fix the
    // second fire read the first fire's instance as a "replay", returned the SAME run id (its own
    // run silently lost) and re-entered promotion of that run — concurrently, in P-013 B.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-16T09:00:00.000Z'));
    try {
      resetManualTokenCounterForTests();
      const first = await runScheduledPlanFire(sql, {
        installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE, trigger: 'manual',
      });
      expect(first!.started).toBe(true);
      expect(first!.replayed).toBe(false);
      // Settle it so the default concurrency='skip' policy cannot be what refuses the second fire.
      await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${first!.runId}`;

      resetManualTokenCounterForTests();
      const second = await runScheduledPlanFire(sql, {
        installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE, trigger: 'manual',
      });
      expect(second!.started).toBe(true);
      expect(second!.replayed).toBe(false);
      expect(second!.runId).not.toBe(first!.runId);
      expect(second!.instanceSlug).not.toBe(first!.instanceSlug);

      const runs = await sql<{ trigger: string; instance_plan_slug: string }[]>`
        SELECT trigger, instance_plan_slug FROM harness_shared.plan_runs
         WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE} ORDER BY id`;
      expect(runs).toEqual([
        { trigger: 'manual', instance_plan_slug: first!.instanceSlug },
        { trigger: 'manual', instance_plan_slug: second!.instanceSlug },
      ]);
      // Each run owns its own work-items: one per open plan item, none shared or doubled.
      const perRun = await sql<{ run: string; n: number; items: number }[]>`
        SELECT payload->'plan_run'->>'runId' AS run, count(*)::int AS n,
               count(DISTINCT (source_plan_item_ids)[1])::int AS items
          FROM harness_shared.work_items
         WHERE workspace_id = ${WS}
           AND payload->'plan_run'->>'runId' IN (${String(first!.runId)}, ${String(second!.runId)})
         GROUP BY 1 ORDER BY 1`;
      expect(perRun).toHaveLength(2);
      for (const row of perRun) expect(row.n).toBe(row.items);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('mints DISTINCT runs across fires (run_seq increments, fresh work_items)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const r0 = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    // EI-1386: settle r0 before the next fire — the default 'skip' policy now genuinely
    // skips while a prior run is 'running' (this test is about run-token/run_seq
    // mechanics across SETTLED fires, not concurrency policy, which has its own tests).
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${r0!.runId}`;
    await stampClaim(new Date('2026-06-17T09:00:00.000Z')); // next day's fire
    const r1 = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });

    expect(r0!.runSeq).toBe(0);
    expect(r1!.runSeq).toBe(1);
    expect(r1!.instanceSlug).not.toBe(r0!.instanceSlug);

    const runs = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runs[0].n).toBe(2);
    // Each run's work_items are distinct (PR-<runId>-...), so audit trails never collide.
    const wiCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(wiCount[0].n).toBe(4); // 2 open items × 2 runs
  });

  it('returns null for an unknown template', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: 'does-not-exist',
    });
    expect(res.started).toBe(false);
    if (res.started !== false) throw new Error(`expected template refusal, got started=${res.started}`);
    expect(res).toMatchObject({
      reason: 'template-missing',
      detail: "template 'does-not-exist' not found in plan-run-it-fixture",
      retryable: false,
      instanceSlug: '',
      runId: -1,
      runSeq: -1,
      minted: 0,
      workItemIds: [],
      actionableWorkItemIds: [],
      replayed: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("template 'does-not-exist' not found"));
    warn.mockRestore();
  });

  // WI-10004721: the daily schedule of a SHIPPED plan cloned it 21 times — every run
  // born all-done, zero work-items, settled in seconds like a healthy fire.
  const SHIPPED_CONTENT = `# Monitor X

## Phase 1

- **P-001** \`done\` check campaign stats
- **P-002** \`dropped\` already handled`;
  const SHIPPED_ITEMS = [
    { id: 'P-001', text: 'check campaign stats', status: 'done' },
    { id: 'P-002', text: 'already handled', status: 'dropped' },
  ];
  async function shipTemplate(storedItems: unknown[]): Promise<void> {
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${SHIPPED_CONTENT}, content_hash = ${hashPlanContent(SHIPPED_CONTENT)},
             items = ${JSON.stringify(storedItems)}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
  }
  async function countRunsAndInstances(): Promise<{ runs: number; instances: number; workItems: number }> {
    const [r] = await sql<Array<{ runs: number; instances: number; work_items: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}) AS runs,
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND template_slug = ${TEMPLATE}) AS instances,
        (SELECT count(*)::int FROM harness_shared.harness_features_consolidated
          WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}) AS work_items`;
    return { runs: r!.runs, instances: r!.instances, workItems: r!.work_items };
  }

  it('WI-10004721: refuses a template whose items are ALL done/dropped — no instance, no run, no work-items', async () => {
    await shipTemplate(SHIPPED_ITEMS);
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("template 'monitor-x' has nothing left to run"));
    warn.mockRestore();
    expect(res).toMatchObject({
      started: false,
      reason: 'template-all-terminal',
      detail: "template 'monitor-x' has nothing left to run: all 2 item(s) are done/dropped",
      retryable: false,
      instanceSlug: '',
      runId: -1,
      minted: 0,
    });
    expect(await countRunsAndInstances()).toEqual({ runs: 0, instances: 0, workItems: 0 });
  });

  it('WI-10004721: reads the content-derived index when the stored index is empty (legacy rows)', async () => {
    await shipTemplate([]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    warn.mockRestore();
    expect(res).toMatchObject({ started: false, reason: 'template-all-terminal' });
    expect(await countRunsAndInstances()).toEqual({ runs: 0, instances: 0, workItems: 0 });
  });

  it('WI-10004721: the routine door (handlePlanRun) disarms an exhausted schedule — routine inactive, schedule_active false', async () => {
    await shipTemplate(SHIPPED_ITEMS);
    await sql`
      UPDATE harness_shared.harness_plans SET schedule_active = true
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    const before = await sql<Array<{ active: boolean }>>`
      SELECT active FROM harness_shared.routines
       WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(TEMPLATE)}`;
    expect(before[0]?.active).toBe(true);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handlePlanRun({
      installSlug: HARNESS,
      workspaceId: WS,
      triggerConfig: {},
      payloadTemplate: { templateSlug: TEMPLATE, harnessSlug: HARNESS },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-disarmed schedule 'monitor-x'"));
    warn.mockRestore();

    const after = await sql<Array<{ active: boolean }>>`
      SELECT active FROM harness_shared.routines
       WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(TEMPLATE)}`;
    expect(after[0]?.active).toBe(false);
    const plan = await sql<Array<{ schedule_active: boolean }>>`
      SELECT schedule_active FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(plan[0]?.schedule_active).toBe(false);
    expect(await countRunsAndInstances()).toEqual({ runs: 0, instances: 0, workItems: 0 });
  });

  it('WI-10004721: a template with one open item among terminal ones still mints (guard is all-terminal only)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    // The default fixture is P-001 todo, P-002 done, P-003 todo — mixed.
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res.started).toBe(true);
    const routine = await sql<Array<{ active: boolean }>>`
      SELECT active FROM harness_shared.routines
       WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(TEMPLATE)}`;
    expect(routine[0]?.active).toBe(true);
  });

  it('D-044: refuses a post-epoch template with no acceptance BAR contract with the documented refusal, minting nothing', async () => {
    // A template created through plans:new is stamped post-epoch by migration 1219's
    // trigger; unlike every other fixture here, this one keeps that stamp.
    const slug = 'post-epoch-template-no-bars';
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
      VALUES (${WS}, ${HARNESS}, ${slug}, 'Monitor X (post-epoch)', 'active',
              ${TEMPLATE_CONTENT}, ${hashPlanContent(TEMPLATE_CONTENT)},
              ${JSON.stringify(ITEMS)}::text::jsonb)
    `;
    const stamped = await sql<Array<{ epoch: number | string | null; cohort: string | null }>>`
      SELECT acceptance_bar_epoch AS epoch, acceptance_bar_cohort AS cohort
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;
    expect(stamped[0]).toMatchObject({ cohort: 'post-epoch' });
    expect(Number(stamped[0]!.epoch)).toBe(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: slug });
    warn.mockRestore();
    expect(res).toMatchObject({
      started: false, reason: 'not-startable', retryable: false, instanceSlug: '', runId: -1, minted: 0,
    });
    const refusal = `${(res as { reason?: string }).reason}: ${(res as { detail?: string }).detail ?? ''}`;
    expect(refusal).toContain('not-startable: acceptance BAR contract is not ready for start');

    const runs = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
    `;
    expect(runs[0]!.n).toBe(0);

    // The published page documents this exact refusal for a non-activated template, so
    // the docs and the gate cannot drift apart silently.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
    const page = readFileSync(
      resolve(repoRoot, 'apps/operator-docs/src/content/docs/harness/blueprint-operations.mdx'), 'utf8');
    expect(page).toContain('`not-startable: acceptance BAR contract is not ready for start`');
  });

  it('does not recreate chunks from a stale schedule.executorKind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = ${JSON.stringify({ kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z', executorKind: 'chunk' })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res!.minted).toBe(2);
    const kinds = await sql<{ item_kind: string }[]>`
      SELECT DISTINCT item_kind FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(kinds).toHaveLength(1);
    expect(kinds[0].item_kind).toBe('feature');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("executorKind='chunk' is deprecated"));
    warn.mockRestore();
  });

  it('defaults to feature item_kind when no executorKind is authored', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const kinds = await sql<{ item_kind: string }[]>`
      SELECT DISTINCT item_kind FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(kinds[0].item_kind).toBe('feature');
  });

  it("EI-19389216343173748: the instance's self-declared frontmatter `slug:` is rewritten to the INSTANCE slug, not left as the template's — and content_hash matches what is actually stored", async () => {
    // Re-seed the template with a REAL frontmatter block (the beforeEach fixture has none,
    // so it can't exercise this bug: setFrontmatterScalar is a no-op on frontmatter-less
    // content). This mirrors the shape every real plan actually has.
    const fmContent = `---\nslug: ${TEMPLATE}\nstatus: active\n---\n# Monitor X\n\n## Now\n**State:** recurring.`;
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${fmContent}, content_hash = ${hashPlanContent(fmContent)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();

    const inst = await sql<Array<{ content: string; content_hash: string }>>`
      SELECT content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst[0]).toBeTruthy();
    // The clone's self-declared slug is the INSTANCE's, not the template's — the exact
    // `slug_mismatch` condition plans/lint.ts flags when these disagree.
    expect(inst[0].content).toContain(`slug: ${res!.instanceSlug}`);
    expect(inst[0].content).not.toContain(`slug: ${TEMPLATE}\n`);
    // Every other frontmatter line survives untouched (surgical, not a full rewrite).
    expect(inst[0].content).toContain('status: active');
    expect(inst[0].content).toContain('**State:** recurring.');
    // content_hash reflects what is ACTUALLY stored (the rewritten content), not the
    // template's original hash — a stale hash would fail plans:set-content's
    // compare-and-swap the moment anyone tried to edit the run snapshot.
    expect(inst[0].content_hash).toBe(hashPlanContent(inst[0].content));
    expect(inst[0].content_hash).not.toBe(hashPlanContent(fmContent));
  });

  it("EI-25654921386861878: the instance's frontmatter `status:` agrees with its `status` column, even when the template's frontmatter says `ready`", async () => {
    // The fixture above declares `status: active`, which happens to equal the column the
    // seed writes, so it cannot see this bug. Real templates are `ready`.
    const fmContent = `---\nslug: ${TEMPLATE}\nstatus: ready\nowner: ops@example.com\n---\n# Monitor X\n\n## Now\n**State:** recurring.`;
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${fmContent}, content_hash = ${hashPlanContent(fmContent)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();

    const inst = await sql<Array<{ status: string; content: string; content_hash: string }>>`
      SELECT status, content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst[0]).toBeTruthy();
    const frontmatterStatus = inst[0].content.match(/^status:[ \t]*(\S+)[ \t]*$/m)?.[1];
    expect(inst[0].status).toBe('active');
    expect(frontmatterStatus).toBe(inst[0].status);
    expect(inst[0].content).not.toContain('status: ready');
    // Surgical: the template's other frontmatter lines survive, and the hash covers the
    // stored bytes.
    expect(inst[0].content).toContain('owner: ops@example.com');
    expect(inst[0].content).toContain(`slug: ${res!.instanceSlug}`);
    expect(inst[0].content_hash).toBe(hashPlanContent(inst[0].content));

    // The template itself is untouched: it stays `ready`.
    const tpl = await sql<Array<{ content: string }>>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(tpl[0].content).toContain('status: ready');
  });

  // WI-10006321: both raw instance writers bypass withPlanLock, so each records its own
  // plan_revisions row. Without it, the plan-parts reconcile sweep has no content clock for
  // the instance and falls back to updated_at (108 live instances had no revision at all).
  it('WI-10006321: the clone and its retirement each record a revision of the stored bytes; a replay records none', async () => {
    const revisionsOf = (slug: string) => sql<Array<{
      seq: number; author_kind: string; author_id: string; content_hash: string; content_snapshot: string;
    }>>`
      SELECT seq, author_kind, author_id, content_hash, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
       ORDER BY seq`;
    const live = async (slug: string) => (await sql<Array<{ content: string; content_hash: string }>>`
      SELECT content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`)[0]!;

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const slug = res!.instanceSlug;
    // Promotion writes the instance again through withPlanLock (which records its own
    // revisions), so the clone is the FIRST revision, not the only one.
    let revs = await revisionsOf(slug);
    expect(revs[0]).toMatchObject({ seq: 1, author_kind: 'system', author_id: 'plan-run:instance-clone' });
    expect(revs[0]!.content_hash).toBe(hashPlanContent(revs[0]!.content_snapshot));
    expect(revs.filter((r) => r.author_id === 'plan-run:instance-clone')).toHaveLength(1);
    // The spine is complete at the head: the live body has a byte-equal latest revision,
    // which is exactly what the reconcile sweep's content clock looks up.
    const promoted = await live(slug);
    expect(revs.at(-1)).toMatchObject({ content_hash: promoted.content_hash, content_snapshot: promoted.content });
    const afterFire = revs.length;

    const replay = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(replay!.replayed).toBe(true);
    expect(await revisionsOf(slug)).toHaveLength(afterFire);

    const retired = await retireRunInstancePlan(sql, {
      workspaceId: WS, planStorageSlug: HARNESS, instanceSlug: slug, templateSlug: TEMPLATE, outcome: 'failed',
    });
    expect(retired.retired).toBe(true);
    const after = await live(slug);
    expect(after.content_hash).not.toBe(promoted.content_hash);
    revs = await revisionsOf(slug);
    expect(revs).toHaveLength(afterFire + 1);
    expect(revs.at(-1)).toMatchObject({
      seq: afterFire + 1,
      author_kind: 'system',
      author_id: 'plan-run:instance-retire',
      content_hash: after.content_hash,
      content_snapshot: after.content,
    });

    // A second retire loses the status guard: no write, so no revision.
    await retireRunInstancePlan(sql, {
      workspaceId: WS, planStorageSlug: HARNESS, instanceSlug: slug, templateSlug: TEMPLATE, outcome: 'failed',
    });
    expect(await revisionsOf(slug)).toHaveLength(afterFire + 1);
  });
});
