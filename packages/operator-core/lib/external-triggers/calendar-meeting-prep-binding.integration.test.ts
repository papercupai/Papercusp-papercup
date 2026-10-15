/**
 * Generic platform coverage for migrating a launch-plan trigger binding onto a
 * blueprint operation, and for run-with-last-event on an operation-targeting
 * binding (kept by app-agent-tasks-durable-execution-2026-10-06 D-011 point 4).
 *
 * The fixture is the HISTORICAL Calendar meeting-prep shape (binding 5bbaba69:
 * ext:gcal:event-upcoming, attendees filter, storm 60/60s, launch-plan
 * calendar/calendar-meeting-prep; operation `meeting-prep-for-trigger`). It is
 * NOT the live design: D-011 retired that binding and removed the operation;
 * the Calendar app now submits `meeting-prep` itself as its own caller (proved
 * in the calendar repo's tests/meeting-prep-operation.test.ts). The input
 * contract below is an inline fixture, independent of the calendar blueprint.
 *
 * The migrated binding is cut over (replacement armed, legacy disarmed), and
 * then driven end to end on PostgreSQL through the REAL binding sink and REAL
 * dispatcher into the REAL `submitBlueprintOperation`:
 *   • two signals for one event revision (same dedupe key) give ONE operation;
 *   • a new revision of the same event (new start, new dedupe key) gives a second;
 *   • an event with no attendees matches nothing (the filter survived migration);
 *   • the event body never rides in operation input (routing envelope only).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { BlueprintSchema, compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { projectBlueprintToPg } from '../blueprint/project-to-pg';
import { upsertDatatype } from '../datatype-registry-store';
import { dispatchPendingTriggerRuns, queueExternalTriggerBindings } from './binding-engine';
import {
  migrateExternalTriggerPlanBindingToOperation,
  queueExternalTriggerLastEventTestRun,
  setExternalTriggerBindingArmed,
} from './admin';
import type { CanonicalExternalEvent } from './ingestion';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const WS = 'ws-calendar-meeting-prep-binding';
const CALENDAR = 'calendar';
const OPERATION = 'meeting-prep-for-trigger';
const EVENT_ID = '1s62d9odtr4m1s3j170pg8c8co';
const PRIVATE_SUMMARY = 'PRIVATE: board prep with Dana';

// The Calendar app's generated meeting-prep-for-trigger input contract (calendar
// .papercusp/blueprint.yaml, pinned to its Zod schema by the app's own
// tests/operation-contract-drift.test.ts): the routing envelope only.
const TRIGGER_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    trigger: {
      type: 'object',
      properties: {
        key: { type: 'string', pattern: '^ext:([a-z0-9][a-z0-9._-]*):event-upcoming$' },
        source: { type: 'string', minLength: 1 },
        event: { type: 'string', minLength: 1 },
        sourceId: { type: 'string', minLength: 1 },
        externalId: { type: 'string', minLength: 1 },
        occurredAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        datatypeId: { type: 'string' },
        dedupeKey: { type: 'string', minLength: 1 },
      },
      required: ['key', 'source', 'event', 'sourceId', 'externalId', 'occurredAt', 'dedupeKey'],
      additionalProperties: false,
    },
  },
  required: ['trigger'],
  additionalProperties: false,
};

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;
let legacyBindingId: string;
let replacementId: string;

const revisionKey = (start: string) => `gcal:${EVENT_ID}:event-upcoming:${start}`;

async function signal(start: string, attendees: Array<{ email: string }>): Promise<{ queued: number; deduped: number; matched: number }> {
  const dedupeKey = revisionKey(start);
  await sql`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, completed_at)
    VALUES (${WS}, ${sourceId}, ${dedupeKey}, 'calendar-event', 'ext:gcal:event-upcoming',
            ${JSON.stringify({ id: EVENT_ID })}::text::jsonb, 'event-bus', 'workspace', 'delivered', 1, now())
    ON CONFLICT DO NOTHING`;
  const event = {
    workspaceId: WS,
    key: 'ext:gcal:event-upcoming',
    source: 'gcal',
    event: 'event-upcoming',
    sourceId,
    externalId: EVENT_ID,
    datatypeId: 'calendar-event',
    dedupeKey,
    occurredAt: start,
    payload: { id: EVENT_ID, summary: PRIVATE_SUMMARY, start, end: start, attendees },
  } as unknown as CanonicalExternalEvent;
  return queueExternalTriggerBindings(sql, event);
}

async function operationItems(): Promise<Array<{ id: string; payload: unknown }>> {
  return sql<Array<{ id: string; payload: unknown }>>`
    SELECT feature_id AS id, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${CALENDAR} ORDER BY created_ts`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  await sql.unsafe(readFileSync(path.join(REPO, 'libs/papercusp/libs/db/sql/878-external-trigger-dispatch-routine.sql'), 'utf8'));
  const operationMigration = path.join(REPO, 'libs/papercusp/libs/db/sql/1228-blueprint-operation-automation-bindings.sql');
  await sql.unsafe(readFileSync(existsSync(operationMigration) ? operationMigration : `${operationMigration}.DRAFT`, 'utf8'));

  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${CALENDAR}, ${Buffer.from([7])}, 'kc-calendar-meeting-prep', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  const source = {
    id: CALENDAR, workItem: { kind: 'feature' },
    roles: [{ id: 'calendar-prep-worker' }], spine: { edges: { DONE: { to: 'done' } } },
    operations: [{
      id: OPERATION, version: '1', target: { kind: 'work-item', itemKind: 'feature' },
      execution: { kind: 'agent', role: 'calendar-prep-worker' },
      inputSchema: TRIGGER_INPUT_SCHEMA,
      acceptance: { resultSchema: { type: 'object', required: ['eventId'], properties: { eventId: { type: 'string' } } } },
    }],
  };
  await projectBlueprintToPg(sql, {
    workspaceId: WS, harnessSlug: CALENDAR,
    blueprint: BlueprintSchema.parse(source), specification: compileAgentSpecification({ source }),
  });

  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${CALENDAR}, 'calendar-meeting-prep', 'Meeting prep', 'active',
            ${'---\nslug: calendar-meeting-prep\n---\n# Meeting prep'}, 'meeting-prep-v1', '[]'::jsonb)`;
  // trigger_deliveries.datatype_id is a FK into this workspace's registry.
  await upsertDatatype(sql, {
    id: 'calendar-event', workspaceId: WS, title: 'Calendar event',
    description: 'A calendar event from a connected calendar.',
    tier: 'generic-kind', nature: 'event', published: false,
    createdBy: 'calendar-meeting-prep-binding.integration.test',
  });
  const [src] = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'gcal', 'connected') RETURNING id`;
  sourceId = src!.id;
  // The live binding's exact shape (5bbaba69).
  const [legacy] = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern, event_filter, action, armed, storm_policy)
    VALUES (${WS}, ${sourceId}, ${CALENDAR}, 'calendar-meeting-prep', 'ext:gcal:event-upcoming',
            '{"attendees.0":{"exists":true}}'::jsonb, '{"type":"launch-plan"}'::jsonb, TRUE,
            '{"maxRuns":60,"windowSeconds":60}'::jsonb)
    RETURNING id`;
  legacyBindingId = legacy!.id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('Calendar meeting prep binding on durable execution (P-006 / R-6)', () => {
  it('migrates the armed legacy binding with source/filter/storm parity, then cuts over', async () => {
    const migrated = await migrateExternalTriggerPlanBindingToOperation(sql, WS, {
      bindingId: legacyBindingId, operationHarnessSlug: CALENDAR, operationId: OPERATION,
    });
    replacementId = migrated.replacement.id;
    expect(migrated.replacement).toMatchObject({
      armed: false, sourceId, eventPattern: 'ext:gcal:event-upcoming',
      eventFilter: { 'attendees.0': { exists: true } },
    });
    // Replay identity: migrating again returns the same replacement, not a second one.
    const again = await migrateExternalTriggerPlanBindingToOperation(sql, WS, {
      bindingId: legacyBindingId, operationHarnessSlug: CALENDAR, operationId: OPERATION,
    });
    expect(again.replacement.id).toBe(replacementId);

    // Preserve the ARMED state across the cutover: exactly one live binding.
    expect(await setExternalTriggerBindingArmed(sql, WS, replacementId, true)).toMatchObject({ armed: true });
    expect(await setExternalTriggerBindingArmed(sql, WS, legacyBindingId, false)).toMatchObject({ armed: false });
    const live = await sql<Array<{ id: string; action: { type: string; operationId?: string } }>>`
      SELECT id::text, action FROM harness_shared.trigger_bindings
       WHERE workspace_id = ${WS} AND armed AND detached_at IS NULL`;
    expect(live).toEqual([{ id: replacementId, action: expect.objectContaining({ type: 'blueprint-operation', operationId: OPERATION }) }]);
  });

  it('two signals for one event revision give ONE operation; a new revision gives a second', async () => {
    const attendees = [{ email: 'dana@example.com' }];
    const first = await signal('2026-10-20T15:00:00.000Z', attendees);
    const repeat = await signal('2026-10-20T15:00:00.000Z', attendees);
    expect(first).toMatchObject({ matched: 1, queued: 1, deduped: 0 });
    expect(repeat).toMatchObject({ matched: 1, queued: 0, deduped: 1 });
    await expect(dispatchPendingTriggerRuns(sql)).resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(await operationItems()).toHaveLength(1);

    // The owner moved the meeting: a new revision of the SAME event is new prep.
    await expect(signal('2026-10-21T15:00:00.000Z', attendees)).resolves.toMatchObject({ queued: 1, deduped: 0 });
    await expect(dispatchPendingTriggerRuns(sql)).resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const items = await operationItems();
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);

    const runs = await sql<Array<{ dedupe_key: string; status: string; outcome: { blueprintOperation?: { operationId: string; harnessSlug: string } } }>>`
      SELECT dedupe_key, status, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND binding_id = ${replacementId}::uuid ORDER BY triggered_at`;
    expect(runs.map((run) => [run.dedupe_key, run.status])).toEqual([
      [revisionKey('2026-10-20T15:00:00.000Z'), 'succeeded'],
      [revisionKey('2026-10-21T15:00:00.000Z'), 'succeeded'],
    ]);
    for (const run of runs) expect(run.outcome.blueprintOperation).toMatchObject({ harnessSlug: CALENDAR, operationId: OPERATION });
    // Only the routing envelope crossed into the operation: never the event body.
    expect(JSON.stringify(items)).not.toContain(PRIVATE_SUMMARY);
    expect(JSON.stringify(items)).toContain(EVENT_ID);
    // The disarmed legacy binding launched nothing.
    const [legacyRuns] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND binding_id = ${legacyBindingId}::uuid`;
    expect(legacyRuns!.n).toBe(0);
  }, 90_000);

  it('an upcoming event with no attendees starts nothing (the migrated filter holds)', async () => {
    const before = (await operationItems()).length;
    await expect(signal('2026-10-22T09:00:00.000Z', [])).resolves.toMatchObject({ matched: 0, queued: 0 });
    await dispatchPendingTriggerRuns(sql);
    expect(await operationItems()).toHaveLength(before);
  });

  it('run-with-last-event proves the migrated operation binding with one audited extra operation', async () => {
    const before = (await operationItems()).length;
    const queued = await queueExternalTriggerLastEventTestRun(sql, WS, { bindingId: replacementId, requestedBy: 'owner:test' });
    expect(queued).toMatchObject({ ok: true, run: { bindingId: replacementId, eventSource: 'binding-run', status: 'pending' } });
    await expect(dispatchPendingTriggerRuns(sql)).resolves.toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    const items = await operationItems();
    expect(items).toHaveLength(before + 1);
    expect(JSON.stringify(items.at(-1))).not.toContain(PRIVATE_SUMMARY);
    const [run] = await sql<Array<{ status: string; outcome: { blueprintOperation?: unknown; runWithLastEvent?: unknown } }>>`
      SELECT status, outcome FROM harness_shared.trigger_runs
       WHERE workspace_id = ${WS} AND id = ${queued.ok ? queued.run.id : ''}::uuid`;
    expect(run).toMatchObject({
      status: 'succeeded',
      outcome: { blueprintOperation: { harnessSlug: CALENDAR, operationId: OPERATION }, runWithLastEvent: { requestedBy: 'owner:test' } },
    });
  }, 60_000);
});
