/**
 * WI-10004921 guard: trigger_deliveries stores each event payload ONCE (on the event-bus
 * row) and the retention sweep strips payloads — never rows — past the replay horizon.
 * The rows must survive because they are each sink's dedupe identity.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { ingestExternalTriggerEvent } from './ingestion';
import { pruneTriggerDeliveryPayloads } from './delivery-retention';

const WS = 'papercusp-workspace';
let org: OrgTestDb;
let sql: Sql;
let sourceId: string;

const emitOk = () =>
  vi.fn(async () => ({
    ok: true as const,
    key: 'ext:gmail:message.received',
    woken: 0,
    notified: [],
    msgId: null,
    waiters: 0,
  }));

const ingest = (externalId: string, emit = emitOk(), vaultDeliver = vi.fn(async () => ({ id: 'doc' }))) =>
  ingestExternalTriggerEvent(
    sql,
    {
      workspaceId: WS,
      sourceId,
      source: 'gmail',
      event: 'message.received',
      externalId,
      datatypeId: 'email-message',
      adapterPayload: { raw: true },
      normalize: () => ({
        id: externalId,
        from: 'ada@example.com',
        to: ['owner@example.com'],
        subject: `Hello ${externalId}`,
        text: 'Body',
      }),
      additionalSinks: [{ kind: 'personal-vault', ref: 'owner', deliver: vaultDeliver }],
    },
    { emit },
  );

async function rowsFor(externalId: string) {
  return sql<{ sink_kind: string; outcome: string; has_payload: boolean; pruned: boolean }[]>`
    SELECT sink_kind, outcome, payload IS NOT NULL AS has_payload, payload_pruned_at IS NOT NULL AS pruned
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId} AND dedupe_key = ${`gmail:${externalId}`}
     ORDER BY sink_kind`;
}

/** A legacy-shaped row: every sink carried the payload before migration 1306. */
async function seedLegacy(externalId: string, sinkKind: string, outcome: string, ageDays: number) {
  await sql`
    INSERT INTO harness_shared.trigger_deliveries
      (workspace_id, source_id, dedupe_key, datatype_id, event_key, payload,
       sink_kind, sink_ref, outcome, attempts, received_at, completed_at, updated_at)
    VALUES (
      ${WS}, ${sourceId}, ${`gmail:${externalId}`}, 'email-message', 'ext:gmail:message.received',
      '{"subject":"legacy"}'::jsonb, ${sinkKind}, 'workspace', ${outcome}, 1,
      now() - (${ageDays} * interval '1 day'),
      ${outcome === 'pending' ? null : sql`now() - (${ageDays} * interval '1 day')`},
      now() - (${ageDays} * interval '1 day')
    )`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'gmail', 'connected') RETURNING id`;
  sourceId = source.id;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
});

describe('trigger_deliveries payload retention (WI-10004921)', () => {
  it('stores the payload only on the event-bus row; the other sinks still record outcome + dedupe', async () => {
    const result = await ingest('once-1');
    expect(result.ok).toBe(true);
    expect(await rowsFor('once-1')).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', has_payload: true, pruned: false },
      { sink_kind: 'personal-vault', outcome: 'delivered', has_payload: false, pruned: false },
      { sink_kind: 'trigger-bindings', outcome: 'delivered', has_payload: false, pruned: false },
    ]);
  });

  it('strips legacy copies and expired payloads, keeps every row, and never touches a pending claim', async () => {
    await seedLegacy('legacy-fresh', 'event-bus', 'delivered', 1);
    await seedLegacy('legacy-fresh', 'personal-vault', 'delivered', 1);
    await seedLegacy('legacy-old', 'event-bus', 'delivered', 45);
    await seedLegacy('legacy-failed-old', 'trigger-bindings', 'failed', 45);
    await seedLegacy('legacy-pending', 'personal-vault', 'pending', 45);

    const first = await pruneTriggerDeliveryPayloads({ sql, retentionDays: 30 });
    expect(first.stripped).toBe(3);

    // Fresh event-bus payload survives (display/diagnosis window); its sibling copy goes.
    expect(await rowsFor('legacy-fresh')).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', has_payload: true, pruned: false },
      { sink_kind: 'personal-vault', outcome: 'delivered', has_payload: false, pruned: true },
    ]);
    // Past the horizon: stripped, but the row (dedupe identity) remains.
    expect(await rowsFor('legacy-old')).toEqual([
      { sink_kind: 'event-bus', outcome: 'delivered', has_payload: false, pruned: true },
    ]);
    expect(await rowsFor('legacy-failed-old')).toEqual([
      { sink_kind: 'trigger-bindings', outcome: 'failed', has_payload: false, pruned: true },
    ]);
    // An in-flight claim is never touched, however old.
    expect(await rowsFor('legacy-pending')).toEqual([
      { sink_kind: 'personal-vault', outcome: 'pending', has_payload: true, pruned: false },
    ]);

    // Idempotent: a second sweep finds nothing left.
    expect((await pruneTriggerDeliveryPayloads({ sql, retentionDays: 30 })).stripped).toBe(0);
  });

  it('drains a backlog in bounded batches', async () => {
    for (let i = 0; i < 5; i += 1) await seedLegacy(`batch-${i}`, 'app-delivery', 'delivered', 2);
    const a = await pruneTriggerDeliveryPayloads({ sql, retentionDays: 30, batchLimit: 3 });
    expect(a).toEqual({ stripped: 3, batchFull: true });
    const b = await pruneTriggerDeliveryPayloads({ sql, retentionDays: 30, batchLimit: 3 });
    expect(b).toEqual({ stripped: 2, batchFull: false });
  });

  it('keeps dedupe after a payload is stripped: a provider replay re-delivers to no sink', async () => {
    await ingest('replay-1');
    await sql`
      UPDATE harness_shared.trigger_deliveries
         SET completed_at = now() - interval '60 days'
       WHERE workspace_id = ${WS} AND dedupe_key = 'gmail:replay-1'`;
    await pruneTriggerDeliveryPayloads({ sql, retentionDays: 30 });
    expect((await rowsFor('replay-1')).every((row) => !row.has_payload)).toBe(true);

    const emit = emitOk();
    const vaultDeliver = vi.fn(async () => ({ id: 'doc' }));
    const replay = await ingest('replay-1', emit, vaultDeliver);
    expect(replay.ok).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(vaultDeliver).not.toHaveBeenCalled();
    expect(replay.deliveries.every((delivery) => delivery.deduped)).toBe(true);
  });

  it('rejects a non-positive horizon or batch rather than stripping everything', async () => {
    await expect(pruneTriggerDeliveryPayloads({ sql, retentionDays: 0 })).rejects.toThrow(/retentionDays/);
    await expect(pruneTriggerDeliveryPayloads({ sql, batchLimit: 0 })).rejects.toThrow(/batchLimit/);
  });
});
