import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  createExternalTriggerBinding,
  createExternalTriggerSource,
  detachExternalTriggerBinding,
  loadExternalTriggerAdminSnapshot,
  loadExternalTriggerPlanAdminSnapshot,
  migrateExternalTriggerPlanBindingToOperation,
  queueExternalTriggerLastEventTestRun,
  setExternalTriggerBindingArmed,
  updateExternalTriggerBindingStormPolicy,
} from './admin';

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const PLAN = 'trigger-admin-fixture';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;
let bindingId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const operationMigration = path.join(REPO, 'libs/papercusp/libs/db/sql/1228-blueprint-operation-automation-bindings.sql');
  await sql.unsafe(readFileSync(existsSync(operationMigration) ? operationMigration : `${operationMigration}.DRAFT`, 'utf8'));
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.plan_run_turns WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
  await sql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${WS} AND install_slug = ${HARNESS} AND name = ${`plan-schedule-${PLAN}`}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items,
       schedule, schedule_active, tzid, input_schema)
    VALUES (${WS}, ${HARNESS}, ${PLAN}, 'Trigger admin fixture', 'ready',
            ${`---\nslug: ${PLAN}\n---\n# Trigger admin fixture`}, 'trigger-admin-v1', '[]'::jsonb,
            '{"kind":"cron","cron":"0 9 * * 1-5"}'::jsonb, FALSE, 'America/New_York',
            '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}'::jsonb)`;
  await sql`
    INSERT INTO harness_shared.routines
      (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role,
       payload_template, active, last_fired_at, next_fire_at)
    VALUES (${`fixture-${PLAN}`}, ${WS}, ${HARNESS}, ${`plan-schedule-${PLAN}`}, 'cron', '{}'::jsonb,
            'system:plan-run', '{}'::jsonb, FALSE,
            '2026-08-22T12:00:00.000Z'::timestamptz,
            '2026-08-23T13:00:00.000Z'::timestamptz)`;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, status, credential_ref, last_connected_at)
    VALUES (${WS}, 'gmail', 'connected', 'google-oauth:fixture', now())
    RETURNING id`;
  sourceId = sources[0].id;
  const bindings = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
       event_filter, action, armed, storm_policy, created_by)
    VALUES (${WS}, ${sources[0].id}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
            '{"label":"support"}'::jsonb, '{"type":"launch-plan"}'::jsonb,
            TRUE, '{"maxRuns":2,"windowSeconds":60}'::jsonb, 'owner-fixture')
    RETURNING id`;
  bindingId = bindings[0].id;
  await sql`
    INSERT INTO harness_shared.trigger_runs
      (workspace_id, binding_id, dedupe_key, status, args, attempts, completed_at)
    VALUES (${WS}, ${bindingId}, 'gmail:admin-fixture', 'failed', '{}'::jsonb, 2, now())`;
});

async function seedSettledProviderRun(): Promise<{ deliveryId: string; triggerRunId: string }> {
  const deliveries = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, completed_at)
    VALUES (${WS}, ${sourceId}, 'gmail:admin-fixture', 'email-message',
            'ext:gmail:message.received',
            '{"messageId":"m-1","subject":"Support request"}'::jsonb,
            'event-bus', 'workspace', 'delivered', 1, now())
    RETURNING id::text`;
  const args = {
    trigger: {
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId,
      externalId: 'm-1',
      occurredAt: '2026-08-24T12:00:00.000Z',
      datatypeId: 'email-message',
      dedupeKey: 'gmail:admin-fixture',
      payload: { messageId: 'm-1', subject: 'Support request' },
    },
  };
  const runs = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.trigger_runs
       SET delivery_id = ${deliveries[0].id}::uuid,
           status = 'succeeded',
           args = ${JSON.stringify(args)}::text::jsonb,
           outcome = '{}'::jsonb,
           error = NULL,
           completed_at = now(),
           updated_at = now()
     WHERE workspace_id = ${WS} AND binding_id = ${bindingId}
     RETURNING id::text`;
  return { deliveryId: deliveries[0].id, triggerRunId: runs[0].id };
}

describe('external-trigger admin shared seam', () => {
  it('projects source policy and sync diagnostics from canonical rows within the requested workspace', async () => {
    const lastSyncAt = '2026-10-14T12:00:00.000Z';
    const nextAttemptAt = '2026-10-14T12:00:30.000Z';
    await sql`UPDATE harness_shared.data_sources
      SET scope = 'pot', scope_ref = ${HARNESS}, permission_mapping = '{"mode":"source-acl"}'::jsonb,
          backfill_status = 'running', sync_last_success_at = ${lastSyncAt}::timestamptz,
          sync_next_attempt_at = ${nextAttemptAt}::timestamptz, sync_failure_count = 2,
          last_error = 'rate_limited: retry after 30s'
      WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    const [foreign] = await sql<{ id: string }[]>`INSERT INTO harness_shared.data_sources
      (workspace_id, kind, status) VALUES ('admin-diagnostics-other-workspace', 'slack', 'error') RETURNING id::text`;

    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.sources.map((source) => source.id)).toEqual([sourceId]);
    expect(snapshot.sources[0]).toMatchObject({
      scope: 'pot', scopeRef: HARNESS, permissionMode: 'source-acl', backfillStatus: 'running',
      lastSyncAt, nextAttemptAt, failureCount: 2, lastError: 'rate_limited: retry after 30s',
    });
    expect(snapshot.sources[0]).not.toHaveProperty('permissionMapping');
    expect(snapshot.sources[0]).not.toHaveProperty('credentials');
    expect((await loadExternalTriggerAdminSnapshot(sql, 'admin-diagnostics-other-workspace')).sources[0]).toMatchObject({
      id: foreign!.id, scope: 'organization', scopeRef: null, permissionMode: 'owner',
      backfillStatus: 'not-requested', lastSyncAt: null, nextAttemptAt: null, failureCount: 0,
    });
  });

  it('reports source/binding/run truth from the canonical tables', async () => {
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.counts).toEqual({ sources: 1, bindings: 1, armed: 1, recentFailures: 1 });
    expect(snapshot.sources[0]).toMatchObject({
      kind: 'gmail',
      status: 'connected',
      credentialRef: 'google-oauth:fixture',
      bindingCount: 1,
      armedBindingCount: 1,
    });
    expect(snapshot.bindings[0]).toMatchObject({
      id: bindingId,
      eventPattern: 'ext:gmail:message.*',
      planSlug: PLAN,
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      lastRun: { status: 'failed', error: null },
    });
    expect(snapshot.recentRuns[0]).toMatchObject({ bindingId, status: 'failed', attempts: 2 });
  });

  it('loads source aggregates when the source relation is a compatibility view without primary-key metadata', async () => {
    const relations = await sql<Array<{ relkind: string }>>`
      SELECT c.relkind::text AS relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname = 'data_sources'`;
    expect(relations[0]?.relkind).toBe('r');

    const snapshot = await sql.begin(async (tx) => {
      await tx`SAVEPOINT compatibility_view_fixture`;
      await tx`ALTER TABLE harness_shared.data_sources RENAME TO data_sources_view_fixture_base`;
      await tx`CREATE VIEW harness_shared.data_sources AS
        SELECT * FROM harness_shared.data_sources_view_fixture_base`;
      const result = await loadExternalTriggerAdminSnapshot(tx as unknown as Sql, WS);
      // Keep this schema substitution local to the assertion; all existing test
      // cases continue against the migrated base table after the savepoint rolls back.
      await tx`ROLLBACK TO SAVEPOINT compatibility_view_fixture`;
      return result;
    });

    expect(snapshot.sources).toHaveLength(1);
    expect(snapshot.sources[0]).toMatchObject({
      id: sourceId,
      kind: 'gmail',
      bindingCount: 1,
      armedBindingCount: 1,
    });
  });

  it('projects a redacted trigger cause, policy trace, linked plan progress, and outcome links', async () => {
    const planRuns = await sql<Array<{ id: number }>>`
      INSERT INTO harness_shared.plan_runs
        (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, note,
         launched_by, launched_at, status, title, updated_at, run_type, trigger,
         outcome, finished_at, instance_plan_slug)
      VALUES (${WS}, ${HARNESS}, ${PLAN}, 'trigger-admin-v1', 'trigger-visibility-session', NULL,
              'system:plan-run', 1000, 'done', 'Triggered fixture', 5000,
              'scheduled', 'event', 'success', 5000, 'trigger-admin-fixture@run-1')
      RETURNING id`;
    const planRunId = Number(planRuns[0].id);
    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'succeeded',
             args = ${JSON.stringify({
               trigger: {
                 payload: {
                   subject: 'Launch review',
                   from: 'Ada <ada@example.com>',
                   accessToken: 'opaque-secret-token',
                 },
               },
             })}::text::jsonb,
             outcome = ${JSON.stringify({
               gmailDraft: {
                 draftId: 'draft-1',
                 subject: 'Re: Launch review',
               },
             })}::text::jsonb,
             plan_run_ref = ${String(planRunId)},
             attempts = 1,
             error = NULL,
             started_at = '2026-08-22T18:00:00.000Z'::timestamptz,
             completed_at = '2026-08-22T18:00:01.000Z'::timestamptz
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}`;

    const run = (await loadExternalTriggerAdminSnapshot(sql, WS)).recentRuns[0]!;
    expect(run).toMatchObject({
      bindingId,
      sourceKind: 'gmail',
      causeSummary: 'Launch review · Ada <ada@example.com>',
      policyDisposition: 'ran',
      policyDetail: 'ran',
      eventFilter: { label: 'support' },
      stormPolicy: { maxRuns: 2, windowSeconds: 60 },
      redactedPayload: {
        subject: 'Launch review',
        from: 'Ada <ada@example.com>',
        accessToken: '[redacted]',
      },
      planRun: {
        id: planRunId,
        instancePlanSlug: 'trigger-admin-fixture@run-1',
        status: 'done',
        workItems: { total: 0, passed: 0, failed: 0, open: 0 },
        durationMs: 4000,
        costUsd: 0,
      },
    });
    expect(run.timeline?.map((step) => step.stage)).toEqual([
      'received', 'matched', 'policy', 'launched', 'completed',
    ]);
    expect(run.outcomeLinks).toEqual([
      {
        kind: 'gmail-draft',
        label: 'Re: Launch review',
        href: 'https://mail.google.com/mail/u/0/#drafts/draft-1',
      },
    ]);
  });

  it('joins a blueprint-operation run to its actual direct-item or plan target outcome', async () => {
    await sql`
      UPDATE harness_shared.trigger_bindings
         SET plan_harness_slug = NULL,
             plan_slug = NULL,
             action = ${JSON.stringify({
               type: 'blueprint-operation',
               operationHarnessSlug: HARNESS,
               operationId: 'triage-message',
             })}::text::jsonb
       WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    const itemId = 'WI-operation-target-fixture';
    const itemStatus = 'todo';
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status)
      VALUES (${WS}, ${HARNESS}, ${itemId}, 'task', 'Operation target fixture', ${itemStatus})`;
    const baseHandle = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      receiptId: 71,
      operationId: 'triage-message',
      specificationRevision: 'a'.repeat(64),
    };
    await sql`
      UPDATE harness_shared.trigger_runs
         SET status = 'succeeded',
             outcome = ${JSON.stringify({
               blueprintOperation: { ...baseHandle, target: { kind: 'work-item', id: itemId } },
             })}::text::jsonb,
             error = NULL,
             completed_at = now()
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}`;

    const direct = (await loadExternalTriggerAdminSnapshot(sql, WS)).recentRuns[0]!;
    expect(direct.blueprintOperation).toMatchObject({
      operationId: 'triage-message',
      target: { kind: 'work-item', id: itemId, status: itemStatus },
    });
    expect(direct.timeline!.at(-1)).toMatchObject({
      stage: 'completed',
      status: 'active',
      detail: `Work item ${itemId} · ${itemStatus}`,
    });

    const planRuns = await sql<Array<{ id: number }>>`
      INSERT INTO harness_shared.plan_runs
        (workspace_id, harness_slug, plan_slug, plan_content_hash, session_id, note,
         launched_by, launched_at, status, title, updated_at, run_type, trigger,
         outcome, finished_at, instance_plan_slug, outputs)
      VALUES (${WS}, ${HARNESS}, ${PLAN}, 'trigger-admin-v1', 'operation-visibility-session', NULL,
              'system:blueprint-operation', 1000, 'done', 'Operation plan target', 5000,
              'scheduled', 'event', 'success', 5000, 'trigger-admin-fixture@run-71',
              '{"candidate":"accepted"}'::jsonb)
      RETURNING id`;
    const planRunId = Number(planRuns[0]!.id);
    await sql`
      UPDATE harness_shared.trigger_runs
         SET outcome = ${JSON.stringify({
           blueprintOperation: {
             ...baseHandle,
             target: { kind: 'plan', runId: planRunId, instanceSlug: 'trigger-admin-fixture@run-71' },
           },
         })}::text::jsonb
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}`;

    const plan = (await loadExternalTriggerAdminSnapshot(sql, WS)).recentRuns[0]!;
    expect(plan.blueprintOperation).toMatchObject({
      operationId: 'triage-message',
      target: {
        kind: 'plan',
        runId: planRunId,
        instanceSlug: 'trigger-admin-fixture@run-71',
        status: 'done',
        outcome: 'success',
      },
    });
    expect(plan.timeline!.at(-1)).toMatchObject({
      stage: 'completed',
      status: 'done',
      detail: 'Plan trigger-admin-fixture@run-71 · done · success',
    });
  });

  it('changes only the named workspace binding armed state', async () => {
    expect(await setExternalTriggerBindingArmed(sql, WS, bindingId, false)).toMatchObject({
      id: bindingId,
      armed: false,
    });
    const rows = await sql<Array<{ armed: boolean }>>`
      SELECT armed FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS} AND id = ${bindingId}`;
    expect(rows[0].armed).toBe(false);
  });

  it('queues distinct audited tests from the same canonical last event without re-ingesting it', async () => {
    const seeded = await seedSettledProviderRun();
    const first = await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId,
      requestedBy: 'owner:test',
    });
    const second = await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId,
      requestedBy: 'owner:test',
    });
    expect(first).toMatchObject({
      ok: true,
      run: {
        bindingId,
        sourceTriggerRunId: seeded.triggerRunId,
        sourceDeliveryId: seeded.deliveryId,
        providerDedupeKey: 'gmail:admin-fixture',
        status: 'pending',
        requestedBy: 'owner:test',
        providerWritePossible: true,
      },
    });
    expect(second).toMatchObject({ ok: true, run: { sourceTriggerRunId: seeded.triggerRunId } });
    if (!first.ok || !second.ok) throw new Error('expected queued test runs');
    expect(second.run.id).not.toBe(first.run.id);

    const rows = await sql<
      Array<{
        id: string;
        deliveryId: string;
        dedupeKey: string;
        args: { trigger: { dedupeKey: string } };
        outcome: { runWithLastEvent: { sourceTriggerRunId: string; requestedBy: string } };
      }>
    >`
      SELECT id::text,
             delivery_id::text AS "deliveryId",
             dedupe_key AS "dedupeKey",
             args,
             outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS}
         AND id IN (${first.run.id}::uuid, ${second.run.id}::uuid)
       ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(2);
    for (const row of rows) {
      expect(row.deliveryId).toBe(seeded.deliveryId);
      expect(row.dedupeKey).toMatch(/^test:/);
      expect(row.args.trigger.dedupeKey).toBe('gmail:admin-fixture');
      expect(row.outcome.runWithLastEvent).toMatchObject({
        sourceTriggerRunId: seeded.triggerRunId,
        requestedBy: 'owner:test',
      });
    }
    const deliveries = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${sourceId}`;
    expect(deliveries[0].count).toBe(1);
  });

  it('truthfully refuses missing history and cannot cross workspace scope', async () => {
    expect(await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId,
      requestedBy: 'owner:test',
    })).toMatchObject({ ok: false, error: 'no_last_event', bindingId });
    expect(await queueExternalTriggerLastEventTestRun(sql, 'another-workspace', {
      bindingId,
      requestedBy: 'owner:test',
    })).toMatchObject({ ok: false, error: 'binding_not_found', bindingId });
  });

  /**
   * WI-474131. A binding that has never fired owns no trigger_runs, so a
   * binding-scoped lookup could never bootstrap it — which made a freshly
   * installed replacement binding (still disarmed, waiting to be proven before
   * the legacy one is retired) the single binding that could never be tested.
   * These three cases pin the fallback: it engages, it respects the binding's
   * own filter, and it covers the direct work-item dispatch shape too.
   */
  async function seedDeliveryOnly(
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<string> {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
         sink_kind, sink_ref, outcome, attempts, completed_at)
      VALUES (${WS}, ${sourceId}, ${dedupeKey}, 'email-message',
              'ext:gmail:message.received', ${JSON.stringify(payload)}::text::jsonb,
              'event-bus', 'workspace', 'delivered', 1, now())
      RETURNING id::text`;
    return rows[0].id;
  }

  it('bootstraps a never-fired binding from its source last matching delivery', async () => {
    const deliveryId = await seedDeliveryOnly(
      { messageId: 'm-boot', subject: 'Support request', label: 'support', id: 'm-boot', occurredAt: '2026-08-24T12:00:00.000Z' },
      'gmail:bootstrap-1',
    );
    const queued = await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId,
      requestedBy: 'owner:test',
    });
    expect(queued).toMatchObject({
      ok: true,
      run: {
        bindingId,
        sourceTriggerRunId: null,
        sourceDeliveryId: deliveryId,
        providerDedupeKey: 'gmail:bootstrap-1',
        eventSource: 'source-delivery',
        status: 'pending',
      },
    });
    if (!queued.ok) throw new Error('expected a queued bootstrap test run');
    const rows = await sql<
      Array<{
        dedupeKey: string;
        args: { trigger: { key: string; source: string; event: string; dedupeKey: string; externalId: string | null; payload: Record<string, unknown> } };
        outcome: { runWithLastEvent: { eventSource: string; sourceTriggerRunId: string | null } };
      }>
    >`
      SELECT dedupe_key AS "dedupeKey", args, outcome
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${queued.run.id}::uuid`;
    // The rebuilt envelope must be the same canonical shape the live enqueue
    // path writes, or the replay would exercise a different contract.
    expect(rows[0].args.trigger).toMatchObject({
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      dedupeKey: 'gmail:bootstrap-1',
      externalId: 'm-boot',
    });
    expect(rows[0].dedupeKey).toMatch(/^test:delivery:/);
    expect(rows[0].outcome.runWithLastEvent).toMatchObject({
      eventSource: 'source-delivery',
      sourceTriggerRunId: null,
    });
  });

  it('does not bootstrap from a source event the binding filter rejects', async () => {
    // Same source, but no `label:"support"` — the live enqueue path would never
    // have matched this binding, so neither may the replay.
    await seedDeliveryOnly({ messageId: 'm-other', subject: 'Billing', id: 'm-other' }, 'gmail:bootstrap-2');
    expect(await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId,
      requestedBy: 'owner:test',
    })).toMatchObject({ ok: false, error: 'no_last_event', bindingId });
  });

  it('replays a create-work-item binding instead of refusing it as non-plan', async () => {
    const directBindings = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, work_item_harness_slug, work_item_kind, event_pattern,
         event_filter, action, armed, storm_policy, created_by)
      VALUES (${WS}, ${sourceId}, 'email', 'email-draft-proposal', 'ext:gmail:message.*',
              '{"label":"support"}'::jsonb, '{"type":"create-work-item"}'::jsonb,
              FALSE, '{"maxRuns":2,"windowSeconds":60}'::jsonb, 'owner-fixture')
      RETURNING id`;
    const directBindingId = directBindings[0].id;
    await seedDeliveryOnly(
      { messageId: 'm-direct', subject: 'Support request', label: 'support', id: 'm-direct' },
      'gmail:bootstrap-3',
    );
    expect(await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId: directBindingId,
      requestedBy: 'owner:test',
    })).toMatchObject({
      ok: true,
      run: { bindingId: directBindingId, eventSource: 'source-delivery', status: 'pending' },
    });
  });

  it('still refuses a binding whose action is neither dispatch shape', async () => {
    // A target-less binding is unreachable — `trigger_bindings_exactly_one_target`
    // rejects it in the DB — so the reachable failure is a binding that HAS a
    // valid target but declares an action neither dispatcher handles. Replaying
    // it would queue a trigger_run that dispatchPendingTriggerRuns can only fail.
    const brokenBindings = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy, created_by)
      VALUES (${WS}, ${sourceId}, ${HARNESS}, ${PLAN}, 'ext:gmail:message.*',
              '{"label":"support"}'::jsonb, '{"type":"send-webhook"}'::jsonb, FALSE,
              '{"maxRuns":2,"windowSeconds":60}'::jsonb, 'owner-fixture')
      RETURNING id`;
    await seedDeliveryOnly(
      { messageId: 'm-broken', subject: 'Support request', label: 'support', id: 'm-broken' },
      'gmail:bootstrap-4',
    );
    expect(await queueExternalTriggerLastEventTestRun(sql, WS, {
      bindingId: brokenBindings[0].id,
      requestedBy: 'owner:test',
    })).toMatchObject({ ok: false, error: 'unsupported_binding_action' });
  });

  it('reads schedule fire state and the manual source for one plan', async () => {
    expect(await loadExternalTriggerPlanAdminSnapshot(sql, WS, HARNESS, PLAN)).toMatchObject({
      harnessSlug: HARNESS,
      planSlug: PLAN,
      schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
      scheduleActive: false,
      tzid: 'America/New_York',
      lastFire: '2026-08-22T12:00:00.000Z',
      nextFire: '2026-08-23T13:00:00.000Z',
      manualSource: 'input-schema',
    });
  });

  it('soft-detaches while preserving settled history and cancelling queued runs', async () => {
    await sql`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, dedupe_key, status, args)
      VALUES (${WS}, ${bindingId}, 'gmail:queued-before-detach', 'pending', '{}'::jsonb)`;
    expect(await detachExternalTriggerBinding(sql, WS, bindingId)).toMatchObject({ id: bindingId });

    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.bindings).toEqual([]);
    expect(snapshot.counts.bindings).toBe(0);
    const runs = await sql<Array<{ dedupeKey: string; status: string }>>`
      SELECT dedupe_key AS "dedupeKey", status
        FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND binding_id = ${bindingId}
       ORDER BY dedupe_key`;
    expect(runs).toEqual([
      { dedupeKey: 'gmail:admin-fixture', status: 'failed' },
      { dedupeKey: 'gmail:queued-before-detach', status: 'cancelled' },
    ]);
  });

  it('validates and persists the binding-engine storm-policy vocabulary', async () => {
    expect(
      await updateExternalTriggerBindingStormPolicy(sql, WS, bindingId, {
        maxRuns: 5,
        windowSeconds: 300,
      }),
    ).toMatchObject({ stormPolicy: { maxRuns: 5, windowSeconds: 300 } });
    await expect(
      updateExternalTriggerBindingStormPolicy(sql, WS, bindingId, {
        maxRuns: 0,
        windowSeconds: 300,
      }),
    ).rejects.toThrow('external_trigger_invalid_storm_max_runs');
  });

  it('creates a non-secret source and installs its binding disarmed', async () => {
    const source = await createExternalTriggerSource(sql, WS, {
      kind: 'slack',
      config: { teamId: 'T123' },
      credentialRef: 'integration:slack-fixture',
      status: 'ready',
      createdBy: 'agent-fixture',
    });
    expect(source).toMatchObject({ kind: 'slack', status: 'ready', config: { teamId: 'T123' } });

    const binding = await createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      planHarnessSlug: HARNESS,
      planSlug: PLAN,
      eventPattern: 'ext:slack:mention',
      eventFilter: { channelType: 'public_channel' },
      stormPolicy: { maxRuns: 3, windowSeconds: 120 },
      createdBy: 'agent-fixture',
    });
    expect(binding).toMatchObject({
      sourceId: source.id,
      sourceKind: 'slack',
      eventPattern: 'ext:slack:mention',
      armed: false,
      action: { type: 'launch-plan' },
      stormPolicy: { maxRuns: 3, windowSeconds: 120 },
    });
  });

  it('creates an operation-targeted binding and exposes its target in the admin snapshot', async () => {
    const source = await createExternalTriggerSource(sql, WS, { kind: 'slack' });
    const binding = await createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      operationHarnessSlug: HARNESS,
      operationId: 'triage-message',
      operationInput: { priority: 'normal' },
      eventPattern: 'ext:slack:mention',
      createdBy: 'agent-fixture',
    });
    expect(binding).toMatchObject({
      planHarnessSlug: null,
      planSlug: null,
      goalId: null,
      action: {
        type: 'blueprint-operation',
        operationHarnessSlug: HARNESS,
        operationId: 'triage-message',
        input: { priority: 'normal' },
      },
      armed: false,
    });
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    expect(snapshot.bindings.find((row) => row.id === binding.id)).toMatchObject({
      planHarnessSlug: null,
      planSlug: null,
      action: { type: 'blueprint-operation', operationId: 'triage-message' },
    });
    await expect(createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      operationHarnessSlug: HARNESS,
      eventPattern: 'ext:slack:mention',
    })).rejects.toThrow('external_trigger_blueprint_operation_target_incomplete');
  });

  it('migrates one legacy plan binding with exact source/filter/storm parity and replay identity', async () => {
    const first = await migrateExternalTriggerPlanBindingToOperation(sql, WS, {
      bindingId,
      operationHarnessSlug: HARNESS,
      operationId: 'triage-message',
      operationInput: { priority: 'normal' },
      createdBy: 'agent-fixture',
    });
    expect(first).toMatchObject({
      legacyBindingId: bindingId,
      replayed: false,
      replacement: {
        sourceId,
        planHarnessSlug: null,
        planSlug: null,
        eventPattern: 'ext:gmail:message.*',
        eventFilter: { label: 'support' },
        stormPolicy: { maxRuns: 2, windowSeconds: 60 },
        armed: false,
        action: {
          type: 'blueprint-operation',
          operationHarnessSlug: HARNESS,
          operationId: 'triage-message',
          input: { priority: 'normal' },
          migrationFromBindingId: bindingId,
        },
      },
      parity: {
        sourceId,
        eventPattern: 'ext:gmail:message.*',
        eventFilter: { label: 'support' },
        stormPolicy: { maxRuns: 2, windowSeconds: 60 },
        legacyArmed: true,
        replacementArmed: false,
        legacyTarget: { harnessSlug: HARNESS, planSlug: PLAN },
        operationTarget: { harnessSlug: HARNESS, operationId: 'triage-message' },
        legacyExecution: null,
      },
    });
    const replay = await migrateExternalTriggerPlanBindingToOperation(sql, WS, {
      bindingId,
      operationHarnessSlug: HARNESS,
      operationId: 'triage-message',
      operationInput: { priority: 'normal' },
      createdBy: 'agent-fixture',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.replacement.id).toBe(first.replacement.id);

    const rows = await sql<Array<{ id: string; armed: boolean; action: Record<string, unknown> }>>`
      SELECT id::text, armed, action
        FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS}
         AND (id = ${bindingId}::uuid OR action->>'migrationFromBindingId' = ${bindingId})
       ORDER BY id`;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === bindingId)?.armed).toBe(true);
    expect(rows.find((row) => row.id === first.replacement.id)?.armed).toBe(false);
    await expect(
      migrateExternalTriggerPlanBindingToOperation(sql, WS, {
        bindingId,
        operationHarnessSlug: HARNESS,
        operationId: 'different-operation',
      }),
    ).rejects.toThrow('external_trigger_binding_migration_target_conflict');
  });

  it('refuses a binding pattern for a different source kind', async () => {
    const source = await createExternalTriggerSource(sql, WS, { kind: 'slack' });
    await expect(
      createExternalTriggerBinding(sql, WS, {
        sourceId: source.id,
        planHarnessSlug: HARNESS,
        planSlug: PLAN,
        eventPattern: 'ext:gmail:message.received',
      }),
    ).rejects.toThrow('external_trigger_pattern_source_mismatch:ext:slack:');
  });
});

/**
 * P-023. Every test above supplies an EXPLICIT storm policy, so none of them
 * exercises what a binding gets when the caller supplies none — which is the
 * only path a real social source takes at install time.
 */
describe('P-023 — a social binding defaults to coalesce-with-cap, never to unbounded', () => {
  const bindOn = async (kind: string, stormPolicy?: Record<string, unknown>) => {
    const source = await createExternalTriggerSource(sql, WS, { kind });
    return createExternalTriggerBinding(sql, WS, {
      sourceId: source.id,
      planHarnessSlug: HARNESS,
      planSlug: PLAN,
      eventPattern: `ext:${kind}:mention.created`,
      ...(stormPolicy ? { stormPolicy } : {}),
    });
  };

  it('bluesky states no rate budget, and still gets a bounded cap rather than none', async () => {
    const binding = await bindOn('bluesky');
    expect(binding.stormPolicy).toMatchObject({
      mode: 'coalesce-with-cap',
      maxRuns: 12,
      windowSeconds: 300,
    });
    expect((binding.stormPolicy.basis as { kind: string }).kind).toBe('conservative-default');
  });

  it('reddit derives its cap from the documented 60 requests/minute', async () => {
    const binding = await bindOn('reddit');
    expect(binding.stormPolicy).toMatchObject({ mode: 'coalesce-with-cap', maxRuns: 30 });
    expect(binding.stormPolicy.basis).toMatchObject({ kind: 'rate-budget', requestsPerMinute: 60 });
  });

  it('CONTROL: a non-social source gets the GENERIC bounded default, not the social one', async () => {
    // Still proves the P-023 change is SCOPED — a mail binding gets neither
    // `mode: coalesce-with-cap` nor a platform `basis`, and its numbers are the
    // generic ones, so the social tests above cannot be passing merely because
    // every binding was given the social policy.
    //
    // What this assertion no longer says is "and therefore it is unbounded".
    // It asserted exactly that until 2026-08-26, when a Gmail poller closed a
    // 2h35m resync gap and the uncapped mail binding minted 228 autonomous
    // plan runs in 68s (EI-21500982767775449). "Mail volume is bounded by how
    // fast humans write" was the premise, and a replayed backlog falsifies it:
    // ingestion, not authorship, sets the burst rate.
    const binding = await bindOn('gmail');
    expect(binding.stormPolicy).toMatchObject({ maxRuns: 12, windowSeconds: 60 });
    expect(binding.stormPolicy.mode).toBeUndefined();
    expect(binding.stormPolicy.basis).toBeUndefined();
  });

  it('GUARD: no source kind can produce a binding with a window but no cap', async () => {
    // The incident shape was `{"windowSeconds":60}` — half-specified config,
    // which is more dangerous than absent config because the present field
    // READS as rate limiting in every dump of the row while the absent one is
    // invisible. This asserts the shape is unreachable, not merely unused.
    for (const kind of ['gmail', 'gcal', 'slack', 'bluesky', 'reddit']) {
      const stated = await bindOn(kind, { windowSeconds: 60 });
      expect(
        typeof stated.stormPolicy.maxRuns,
        `${kind} accepted a window with no cap: ${JSON.stringify(stated.stormPolicy)}`,
      ).toBe('number');
      expect(Number(stated.stormPolicy.maxRuns)).toBeGreaterThan(0);

      const silent = await bindOn(kind);
      expect(
        typeof silent.stormPolicy.maxRuns,
        `${kind} defaulted to no cap: ${JSON.stringify(silent.stormPolicy)}`,
      ).toBe('number');
      expect(Number(silent.stormPolicy.maxRuns)).toBeGreaterThan(0);
    }
  });

  it('an explicit caller policy still wins on a social source', async () => {
    const binding = await bindOn('bluesky', { maxRuns: 2, windowSeconds: 60 });
    expect(binding.stormPolicy).toMatchObject({ maxRuns: 2, windowSeconds: 60 });
    expect(binding.stormPolicy.mode).toBeUndefined();
  });

  // WI-10004920: the dispatch validity window says nothing about RATE, so stating
  // only it must not cost a social binding its per-platform rate default — which
  // is what happened while ANY stated policy displaced that default wholesale.
  it('a policy stating only maxAgeSeconds keeps the social rate default and adds the window', async () => {
    const binding = await bindOn('bluesky', { maxAgeSeconds: 3600 });
    expect(binding.stormPolicy).toMatchObject({
      mode: 'coalesce-with-cap',
      maxRuns: 12,
      windowSeconds: 300,
      maxAgeSeconds: 3600,
    });
  });

  it('CONTROL: a non-social source stating only maxAgeSeconds gets the generic rate default', async () => {
    const binding = await bindOn('gmail', { maxAgeSeconds: 3600 });
    expect(binding.stormPolicy).toMatchObject({ maxRuns: 12, windowSeconds: 60, maxAgeSeconds: 3600 });
    expect(binding.stormPolicy.mode).toBeUndefined();
  });

  it('refuses a validity window past the 31-day ceiling on the social overlay path too', async () => {
    await expect(bindOn('bluesky', { maxAgeSeconds: 32 * 24 * 60 * 60 })).rejects.toThrow(
      /external_trigger_invalid_storm_max_age_seconds/,
    );
  });
});

describe('P-020 — goal-targeted bindings through the create door', () => {
  const GOAL = 'goal-admin-door-1';
  let goalSourceId: string;

  beforeEach(async () => {
    await sql`
      INSERT INTO harness_shared.goals (id, workspace_id, install_slug, title, status)
      VALUES (${GOAL}, ${WS}, ${HARNESS}, 'Admin-door test goal', 'active')`;
    const source = await createExternalTriggerSource(sql, WS, { kind: 'slack' });
    goalSourceId = source.id;
  });

  it('creates a goal-targeted binding: goal_id set, plan cols NULL, action start-goal, disarmed', async () => {
    const binding = await createExternalTriggerBinding(sql, WS, {
      sourceId: goalSourceId,
      goalId: GOAL,
      eventPattern: 'ext:slack:mention',
      createdBy: 'agent-fixture',
    });
    expect(binding).toMatchObject({
      sourceId: goalSourceId,
      sourceKind: 'slack',
      goalId: GOAL,
      planHarnessSlug: null,
      planSlug: null,
      action: { type: 'start-goal' },
      armed: false,
    });
    const rows = await sql<Array<{ goal_id: string | null; plan_slug: string | null }>>`
      SELECT goal_id, plan_slug FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND id = ${binding.id}::uuid`;
    expect(rows[0]).toEqual({ goal_id: GOAL, plan_slug: null });
  });

  it('refuses both targets, no target, and an unknown goal — by name, before the DB constraint', async () => {
    await expect(
      createExternalTriggerBinding(sql, WS, {
        sourceId: goalSourceId,
        goalId: GOAL,
        planHarnessSlug: HARNESS,
        planSlug: PLAN,
        eventPattern: 'ext:slack:mention',
      }),
    ).rejects.toThrow('external_trigger_binding_both_targets');
    await expect(
      createExternalTriggerBinding(sql, WS, {
        sourceId: goalSourceId,
        eventPattern: 'ext:slack:mention',
      }),
    ).rejects.toThrow('external_trigger_binding_no_target');
    await expect(
      createExternalTriggerBinding(sql, WS, {
        sourceId: goalSourceId,
        goalId: 'goal-that-does-not-exist',
        eventPattern: 'ext:slack:mention',
      }),
    ).rejects.toThrow('external_trigger_unknown_goal:goal-that-does-not-exist');
  });
});

describe('P-027 — the admin snapshot carries social platform facts per source', () => {
  /**
   * These assert through loadExternalTriggerAdminSnapshot, NOT through
   * socialAdminFacts directly. The pane consumes the SNAPSHOT, so a test of the
   * helper alone would prove the declaration and miss the wiring — the exact
   * gap that let seven trigger packs validate green while every one of them
   * failed at install (D-047).
   */
  const snapshotSource = async (kind: string) => {
    const snapshot = await loadExternalTriggerAdminSnapshot(sql, WS);
    const row = snapshot.sources.find((source) => source.kind === kind);
    if (!row) throw new Error(`no source row for kind ${kind}`);
    return row;
  };

  it('attaches platform facts to a social source', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'reddit' });
    const row = await snapshotSource('reddit');

    expect(row.social).not.toBeNull();
    expect(row.social?.platformId).toBe('reddit');
    expect(row.social?.wave).toBe('A');
    // A cap the budget actually funds — never unbounded.
    expect(row.social?.rateBudget.maxRuns).toBeGreaterThan(0);
    expect(row.social?.rateBudget.windowSeconds).toBeGreaterThan(0);
  });

  it('CONTROL: a non-social source carries social:null and cannot inherit a budget', async () => {
    // Without this control the assertion above passes for a helper that
    // returns facts for EVERY kind, which would give gmail a social rate cap.
    await createExternalTriggerSource(sql, WS, { kind: 'gmail' });
    const row = await snapshotSource('gmail');
    expect(row.social).toBeNull();
  });

  it('reports a fresh source as never-synced, not as a broken cursor', async () => {
    // createExternalTriggerSource persists `{}`; that cold shape must read as
    // never-synced. Reading it as `unrecognized` would alarm on every new source.
    await createExternalTriggerSource(sql, WS, { kind: 'mastodon' });
    const row = await snapshotSource('mastodon');
    expect(row.social?.cursor.state).toBe('never-synced');
  });

  it('reads a persisted watermark cursor as synced, through the real column', async () => {
    const created = await createExternalTriggerSource(sql, WS, { kind: 'threads' });
    const at = new Date(Date.now() - 90_000).toISOString();
    await sql`
      UPDATE harness_shared.data_sources
         SET cursor = ${JSON.stringify({ watermark: at, boundaryIds: ['m1'] })}::jsonb
       WHERE workspace_id = ${WS} AND id = ${created.id}::uuid`;

    const row = await snapshotSource('threads');
    expect(row.social?.cursor.state).toBe('synced');
    expect(row.social?.cursor.at).toBe(at);
    // ~90s, allowing for the round trip.
    expect(row.social?.cursor.ageMs ?? 0).toBeGreaterThanOrEqual(89_000);
    expect(row.social?.cursor.ageMs ?? 0).toBeLessThan(600_000);
  });

  it('reads reddit’s timeless fullname cursor as position-only, not never-synced', async () => {
    // The regression this exists to catch: a pane keyed on `cursor.watermark`
    // reports a perfectly healthy reddit source as never synced, forever.
    const created = await createExternalTriggerSource(sql, WS, { kind: 'reddit' });
    await sql`
      UPDATE harness_shared.data_sources
         SET cursor = ${JSON.stringify({ newestFullname: 't3_abc123' })}::jsonb
       WHERE workspace_id = ${WS} AND id = ${created.id}::uuid`;

    const row = await snapshotSource('reddit');
    expect(row.social?.cursor.state).toBe('position-only');
    expect(row.social?.cursor.position).toBe('newestFullname=t3_abc123');
  });

  it('surfaces the owner-side wall on a review-gated platform', async () => {
    // Wave B is gated on Meta app review; the pane must say so rather than
    // presenting it as merely disconnected.
    await createExternalTriggerSource(sql, WS, { kind: 'instagram' });
    const row = await snapshotSource('instagram');
    expect(row.social?.platformId).toBe('instagram');
    expect(row.social?.wave).toBe('B');
  });
});
