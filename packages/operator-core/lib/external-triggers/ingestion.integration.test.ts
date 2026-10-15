import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { isCompilableSchema } from '../datatype-payload-validation';
import { ingestExternalTriggerEvent, PENDING_DELIVERY_LEASE_SECONDS } from './ingestion';

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (
      'papercusp-workspace', 'papercusp', 'inbox-triage', 'Inbox triage', 'ready',
      '# Inbox triage', 'inbox-triage-fixture', '[]'::jsonb
    )
    ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
      title = EXCLUDED.title,
      status = EXCLUDED.status,
      content = EXCLUDED.content,
      content_hash = EXCLUDED.content_hash,
      items = EXCLUDED.items`;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES ('papercusp-workspace', 'gmail', 'connected') RETURNING id`;
  sourceId = source.id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('external trigger ingestion core', () => {
  it('seeds the curated external datatypes with compilable schemas', async () => {
    const rows = await sql<{ id: string; payload_schema: Record<string, unknown> }[]>`
      SELECT id, payload_schema FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace'
         AND id IN ('calendar-event', 'chat-message', 'contact', 'email-message', 'social-post', 'webhook-payload')
       ORDER BY id`;
    // 877 seeds the first five; 1269 adds `webhook-payload` to the same platform catalog.
    expect(rows.map((row) => row.id)).toEqual([
      'calendar-event',
      'chat-message',
      'contact',
      'email-message',
      'social-post',
      'webhook-payload',
    ]);
    expect(rows.every((row) => isCompilableSchema(row.payload_schema))).toBe(true);
  });

  it('distinguishes the old nature selector from the curated selector on the same ticket-seeded catalog', async () => {
    // createOrgTestDb applies 1332, which seeds these real registered ticket natures.
    const tickets = await sql<{ id: string; nature: string }[]>`
      SELECT id, nature FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace'
         AND id IN ('ticket', 'ticket-comment', 'ticket-status-change')
       ORDER BY id`;
    expect(tickets).toEqual([
      { id: 'ticket', nature: 'record' },
      { id: 'ticket-comment', nature: 'document' },
      { id: 'ticket-status-change', nature: 'event' },
    ]);

    // The historical selector includes all three tickets, so its old six-ID
    // equality fails. Both controls read this one migrated throwaway database.
    const historicalRows = await sql<{ id: string }[]>`
      SELECT id FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace' AND nature != 'work'
       ORDER BY id`;
    const curatedRows = await sql<{ id: string; payload_schema: Record<string, unknown> }[]>`
      SELECT id, payload_schema FROM harness_shared.datatype_registry
       WHERE workspace_id = 'papercusp-workspace'
         AND id IN ('calendar-event', 'chat-message', 'contact', 'email-message', 'social-post', 'webhook-payload')
       ORDER BY id`;
    const historicalIds = historicalRows.map((row) => row.id);
    const curatedIds = curatedRows.map((row) => row.id);
    expect(curatedIds).toEqual([
      'calendar-event', 'chat-message', 'contact', 'email-message', 'social-post', 'webhook-payload',
    ]);
    expect(historicalIds).toEqual(expect.arrayContaining([
      ...curatedIds, 'ticket', 'ticket-comment', 'ticket-status-change',
    ]));
    expect(historicalIds).not.toEqual(curatedIds);
    expect(curatedRows.every((row) => isCompilableSchema(row.payload_schema))).toBe(true);
  });

  it('normalizes once, emits a derived key, and fans the same event to a second sink', async () => {
    const normalize = vi.fn(() => ({
      id: 'm-1',
      from: 'ada@example.com',
      to: ['owner@example.com'],
      subject: 'Hello',
      text: 'Body',
    }));
    const emit = vi.fn(async () => ({
      ok: true as const,
      key: 'ext:gmail:message.received',
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const vaultDeliver = vi.fn(async () => ({ id: 'doc-1' }));

    const result = await ingestExternalTriggerEvent(
      sql,
      {
        workspaceId: 'papercusp-workspace',
        sourceId,
        source: 'gmail',
        event: 'message.received',
        externalId: 'm-1',
        datatypeId: 'email-message',
        adapterPayload: { raw: true },
        normalize,
        additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
      },
      { emit },
    );

    expect(result.ok).toBe(true);
    expect(result.event.key).toBe('ext:gmail:message.received');
    expect(result.event.workspaceId).toBe('papercusp-workspace');
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ key: 'ext:gmail:message.received' }));
    expect(vaultDeliver).toHaveBeenCalledWith(result.event);
    expect(result.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: false }),
        expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered', deduped: false }),
      ]),
    );

    const rows = await sql<{ sink_kind: string; outcome: string }[]>`
      SELECT sink_kind, outcome FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:email-message:m-1' ORDER BY sink_kind`;
    expect(rows).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered' },
      { sink_kind: 'personal-vault', outcome: 'delivered' },
      { sink_kind: 'trigger-bindings', outcome: 'delivered' },
    ]);
  });

  it('retries only the failed sink while preserving delivered-sink dedupe', async () => {
    const firstEmit = vi.fn(async () => ({
      ok: true as const,
      key: 'ext:gmail:message.received',
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const failingVault = vi.fn(async () => {
      throw new Error('vault unavailable');
    });
    const input = {
      workspaceId: 'papercusp-workspace',
      sourceId,
      source: 'gmail',
      event: 'message.received',
      externalId: 'm-retry',
      datatypeId: 'email-message',
      adapterPayload: {},
      normalize: () => ({ id: 'm-retry', subject: 'Retry me' }),
    };

    const first = await ingestExternalTriggerEvent(
      sql,
      {
        ...input,
        additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: failingVault }],
      },
      { emit: firstEmit },
    );
    expect(first.ok).toBe(false);
    expect(firstEmit).toHaveBeenCalledTimes(1);
    expect(first.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: false }),
        expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'failed', deduped: false }),
      ]),
    );

    const replayEmit = vi.fn(async () => ({
      ok: true as const,
      key: 'ext:gmail:message.received',
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const recoveredVault = vi.fn(async () => ({ id: 'doc-recovered' }));
    const replay = await ingestExternalTriggerEvent(
      sql,
      {
        ...input,
        additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: recoveredVault }],
      },
      { emit: replayEmit },
    );

    expect(replay.ok).toBe(true);
    expect(replayEmit).not.toHaveBeenCalled();
    expect(recoveredVault).toHaveBeenCalledTimes(1);
    expect(replay.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: true }),
        expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered', deduped: false }),
      ]),
    );
    const rows = await sql<{ sink_kind: string; outcome: string; attempts: number }[]>`
      SELECT sink_kind, outcome, attempts FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:email-message:m-retry' ORDER BY sink_kind`;
    expect(rows).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', attempts: 1 },
      { sink_kind: 'personal-vault', outcome: 'delivered', attempts: 2 },
      { sink_kind: 'trigger-bindings', outcome: 'delivered', attempts: 1 },
    ]);
  });

  // WI-10003159: a claimant that died between claimDelivery and finishDelivery
  // left an event-bus row 'pending' forever. It was never reclaimed, the binding
  // sink refused to queue without a delivered event-bus row, and one orphaned
  // row froze a Gmail source's sync for 11 days.
  it('reclaims an orphaned pending claim once its lease expires, but not a live one', async () => {
    const seedPending = async (externalId: string, ageSeconds: number) => {
      await sql`
        INSERT INTO harness_shared.trigger_deliveries
          (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
           sink_kind, sink_ref, outcome, attempts, updated_at)
        VALUES (
          'papercusp-workspace', ${sourceId}, ${`gmail:email-message:${externalId}`}, 'email-message',
          'ext:gmail:message.received', '{}'::jsonb, 'event-bus', 'workspace', 'pending', 1,
          now() - (${ageSeconds} * interval '1 second')
        )`;
    };
    const emitOk = () =>
      vi.fn(async () => ({
        ok: true as const,
        key: 'ext:gmail:message.received',
        woken: 0,
        notified: [],
        msgId: null,
        waiters: 0,
      }));
    const ingest = (externalId: string, emit: ReturnType<typeof emitOk>) =>
      ingestExternalTriggerEvent(
        sql,
        {
          workspaceId: 'papercusp-workspace',
          sourceId,
          source: 'gmail',
          event: 'message.received',
          externalId,
          datatypeId: 'email-message',
          adapterPayload: {},
          normalize: () => ({ id: externalId, subject: 'Orphaned claim' }),
        },
        { emit },
      );

    await seedPending('m-orphaned', PENDING_DELIVERY_LEASE_SECONDS + 60);
    const orphanedEmit = emitOk();
    const recovered = await ingest('m-orphaned', orphanedEmit);
    expect(recovered.ok).toBe(true);
    expect(orphanedEmit).toHaveBeenCalledTimes(1);
    expect(recovered.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: false }),
        expect.objectContaining({ sinkKind: 'trigger-bindings', outcome: 'delivered', deduped: false }),
      ]),
    );
    const orphanedRows = await sql<{ sink_kind: string; outcome: string; attempts: number }[]>`
      SELECT sink_kind, outcome, attempts FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:email-message:m-orphaned' ORDER BY sink_kind`;
    expect(orphanedRows).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', attempts: 2 },
      { sink_kind: 'trigger-bindings', outcome: 'delivered', attempts: 1 },
    ]);

    // A claim inside its lease may still be in flight; replay must not steal it.
    await seedPending('m-in-flight', 60);
    const inFlightEmit = emitOk();
    const deferred = await ingest('m-in-flight', inFlightEmit);
    expect(inFlightEmit).not.toHaveBeenCalled();
    expect(deferred.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'event-bus', outcome: 'pending', deduped: true }),
      ]),
    );
    const [inFlightRow] = await sql<{ outcome: string; attempts: number }[]>`
      SELECT outcome, attempts FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:email-message:m-in-flight' AND sink_kind = 'event-bus'`;
    expect(inFlightRow).toEqual({ outcome: 'pending', attempts: 1 });
  });

  it('dedupes provider replay without re-emitting either sink', async () => {
    const emit = vi.fn(async () => ({
      ok: true as const,
      key: 'ext:gmail:message.received',
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));
    const vaultDeliver = vi.fn(async () => undefined);
    const result = await ingestExternalTriggerEvent(
      sql,
      {
        workspaceId: 'papercusp-workspace',
        sourceId,
        source: 'gmail',
        event: 'message.received',
        externalId: 'm-1',
        datatypeId: 'email-message',
        adapterPayload: {},
        normalize: () => ({ id: 'm-1', subject: 'Hello' }),
        additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
      },
      { emit },
    );
    expect(result.ok).toBe(true);
    expect(result.deliveries.every((delivery) => delivery.deduped)).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(vaultDeliver).not.toHaveBeenCalled();
  });

  it('migrates a matching legacy delivery key without replaying an already delivered event', async () => {
    const externalId = 'm-legacy-key';
    await sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
         sink_kind, sink_ref, outcome, attempts, updated_at)
      VALUES (
        'papercusp-workspace', ${sourceId}, ${`gmail:${externalId}`}, 'email-message',
        'ext:gmail:message.received', '{}'::jsonb, 'event-bus', 'workspace', 'delivered', 1, now()
      )`;
    const emit = vi.fn();
    const result = await ingestExternalTriggerEvent(
      sql,
      {
        workspaceId: 'papercusp-workspace',
        sourceId,
        source: 'gmail',
        event: 'message.received',
        externalId,
        datatypeId: 'email-message',
        adapterPayload: {},
        normalize: () => ({ id: externalId, subject: 'Legacy delivery' }),
      },
      { emit: emit as never },
    );

    expect(result.ok).toBe(true);
    expect(result.event.dedupeKey).toBe(`gmail:email-message:${externalId}`);
    expect(result.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sinkKind: 'event-bus', outcome: 'delivered', deduped: true }),
    ]));
    expect(emit).not.toHaveBeenCalled();
    const rows = await sql<{ dedupe_key: string; outcome: string }[]>`
      SELECT dedupe_key, outcome FROM harness_shared.trigger_deliveries
       WHERE source_id = ${sourceId} AND event_key = 'ext:gmail:message.received'
         AND sink_kind = 'event-bus' AND dedupe_key = ${result.event.dedupeKey}`;
    expect(rows).toEqual([{ dedupe_key: `gmail:email-message:${externalId}`, outcome: 'delivered' }]);
  });

  it('persists canonical validation failures and emits nothing', async () => {
    const emit = vi.fn();
    const vaultDeliver = vi.fn();
    const result = await ingestExternalTriggerEvent(
      sql,
      {
        workspaceId: 'papercusp-workspace',
        sourceId,
        source: 'gmail',
        event: 'message.received',
        externalId: 'm-2',
        datatypeId: 'email-message',
        adapterPayload: {},
        normalize: () => ({ subject: 'missing canonical id' }),
        additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
      },
      { emit: emit as never },
    );
    expect(result.ok).toBe(false);
    expect(result.validationErrors?.join(' ')).toMatch(/id/);
    expect(emit).not.toHaveBeenCalled();
    expect(vaultDeliver).not.toHaveBeenCalled();
    const rows = await sql<{ sink_kind: string; outcome: string; error: string }[]>`
      SELECT sink_kind, outcome, error FROM harness_shared.trigger_deliveries
       WHERE dedupe_key = 'gmail:email-message:m-2' ORDER BY sink_kind`;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.outcome === 'failed' && /invalid_email-message_payload/.test(row.error))).toBe(true);
  });

  it('matches armed bindings, evaluates canonical payload filters, and enforces the storm window', async () => {
    await sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern,
         event_filter, action, armed, storm_policy)
      VALUES ('papercusp-workspace', ${sourceId}, 'papercusp', 'inbox-triage',
              'ext:gmail:message.*', ${JSON.stringify({ subject: 'Launch me' })}::text::jsonb,
              '{"type":"launch-plan"}'::jsonb, TRUE,
              '{"maxRuns":1,"windowSeconds":60}'::jsonb)`;
    const emit = vi.fn(async () => ({
      ok: true as const,
      key: 'ext:gmail:message.received',
      woken: 0,
      notified: [],
      msgId: null,
      waiters: 0,
    }));

    for (const [externalId, subject] of [
      ['m-bind-1', 'Launch me'],
      ['m-bind-no-match', 'Ignore me'],
      ['m-bind-2', 'Launch me'],
    ] as const) {
      const result = await ingestExternalTriggerEvent(
        sql,
        {
          workspaceId: 'papercusp-workspace',
          sourceId,
          source: 'gmail',
          event: 'message.received',
          externalId,
          datatypeId: 'email-message',
          adapterPayload: {},
          normalize: () => ({ id: externalId, subject }),
        },
        { emit },
      );
      expect(result.ok).toBe(true);
    }

    const runs = await sql<
      Array<{ status: string; args: { trigger: { key: string; externalId: string } }; error: string | null }>
    >`
      SELECT status, args, error FROM harness_shared.trigger_runs ORDER BY triggered_at, id`;
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      status: 'pending',
      args: { trigger: { key: 'ext:gmail:message.received', externalId: 'm-bind-1' } },
      error: null,
    });
    expect(runs[1].status).toBe('skipped');
    expect(runs[1].args.trigger.externalId).toBe('m-bind-2');
    expect(runs[1].error).toMatch(/external_trigger_storm_limit/);
  });
});
