/**
 * Real-Postgres coverage for durable per-request gateway outcomes. The unit suite
 * checks the in-memory contract; this proves actual INSERT/query/retention behavior
 * after the writer instance is discarded, beyond the gateway stall-store's 4h TTL.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationsForTest } from '../../test/_pg-helpers';
import { createOrgTestDb } from '../../test/_org-test-db';
import type { Sql } from 'postgres';
import {
  GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
  createPostgresGatewayRequestOutcomeStore,
  type GatewayRequestOutcomeRecord,
} from './gateway-request-outcome-store';
import type { GatewayRequestTimeline } from './request-stage-telemetry';
import { activeWorkspaceId } from '../workspace-registry';

const BASE = Date.parse('2026-10-13T09:00:00.000Z');
const workspaceId = activeWorkspaceId();
const PROCESS_BEFORE_RESTART = '00000000-0000-4000-8000-000000000001';
const PROCESS_OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const PROCESS_EXPIRED = '00000000-0000-4000-8000-000000000003';
const PROCESS_RECENT = '00000000-0000-4000-8000-000000000004';
let db: { sql: Sql; cleanup: () => Promise<void> };

beforeAll(async () => {
  const org = await createOrgTestDb();
  db = { sql: org.adminSql, cleanup: () => org.cleanup() };
  await applyMigrationsForTest(db.sql, [
    '1510-gateway-request-outcomes.sql',
    '1533-gateway-response-usage-attribution.sql',
    '1554-gateway-request-outcome-attempt-account-ids.sql',
  ], {
    label: 'gateway request outcome store integration test',
    runtimeTables: ['harness_shared.gateway_request_outcomes'],
  });
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.gateway_request_outcomes`;
});

function outcomeRecord(input: {
  processId: string;
  ordinal: number;
  ownerId: string;
  startedAt: number;
  outcomeClass: GatewayRequestTimeline['outcome'];
}): GatewayRequestOutcomeRecord {
  const finalizedAtMs = input.startedAt + 250;
  const finalStatus = input.outcomeClass === 'ok' ? 200
    : input.outcomeClass === 'client-error' ? 400
      : input.outcomeClass === 'upstream-429' || input.outcomeClass === 'shed' ? 429 : 502;
  return {
    requestId: `${input.processId}:${input.ordinal}`,
    gatewayProcessInstanceId: input.processId,
    requestOrdinal: input.ordinal,
    workspaceId,
    ownerId: input.ownerId,
    provider: 'claude',
    protocol: 'anthropic-messages',
    transport: 'oauth-http',
    model: 'claude-sonnet-4',
    selectedAccountId: 'account-a',
    attemptAccountIds: ['account-a'],
    outcomeClass: input.outcomeClass,
    finalStatus,
    requestTimestampMs: input.startedAt,
    finalizedAtMs,
    attempts: input.outcomeClass === 'shed' ? 0 : 1,
    failovers: 0,
    nativeSessionId: null,
    nativeThreadId: null,
    nativeTurnId: null,
    nativeWindowId: null,
    recordedAtMs: finalizedAtMs,
    retentionExpiresAtMs: finalizedAtMs + GATEWAY_REQUEST_OUTCOME_RETENTION_MS,
  };
}

describe('Postgres gateway request outcome store', () => {
  it('persists provider identity and ordered attempt accounts across a writer restart', async () => {
    const record = outcomeRecord({ processId: PROCESS_BEFORE_RESTART, ordinal: 1, ownerId: 'owner-a',
      startedAt: BASE, outcomeClass: 'ok' });
    record.providerResponseId = 'resp-durable';
    record.selectedAccountId = 'account-b';
    record.attemptAccountIds = ['account-a', 'account-b'];
    await createPostgresGatewayRequestOutcomeStore(db.sql).record(record);
    const report = await createPostgresGatewayRequestOutcomeStore(db.sql).report({ ownerId: 'owner-a', nowMs: BASE + 1000 });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      providerResponseId: 'resp-durable',
      selectedAccountId: 'account-b',
      attemptAccountIds: ['account-a', 'account-b'],
    });
  });

  it('joins mixed owner outcomes after a writer restart and beyond the 4h stall-event TTL', async () => {
    const writer = createPostgresGatewayRequestOutcomeStore(db.sql);
    const outcomes: GatewayRequestTimeline['outcome'][] = [
      ...Array<GatewayRequestTimeline['outcome']>(13).fill('upstream-429'),
      'shed', 'shed', 'client-error', 'upstream-error',
    ];
    for (let index = 0; index < outcomes.length; index++) {
      await writer.record(outcomeRecord({
        processId: PROCESS_BEFORE_RESTART,
        ordinal: index + 1,
        ownerId: 'owner-a',
        startedAt: BASE + index * 10 * 60_000,
        outcomeClass: outcomes[index]!,
      }));
    }
    await writer.record(outcomeRecord({
      processId: PROCESS_OTHER_OWNER, ordinal: 1, ownerId: 'owner-b',
      startedAt: BASE + 90 * 60_000, outcomeClass: 'ok',
    }));

    // A new adapter instance models a gateway process restarted against the same durable table.
    const restartedReader = createPostgresGatewayRequestOutcomeStore(db.sql);
    const report = await restartedReader.report({
      ownerId: 'owner-a',
      fromMs: BASE,
      toMs: BASE + 3 * 60 * 60_000,
      nowMs: BASE + 5 * 60 * 60_000,
      limit: 50,
    });

    expect(report.total).toBe(17);
    expect(report.rows).toHaveLength(17);
    expect(report.byOutcome).toMatchObject({ 'upstream-429': 13, shed: 2, 'client-error': 1, 'upstream-error': 1 });
    expect(report.rows[0]).toMatchObject({
      gatewayProcessInstanceId: PROCESS_BEFORE_RESTART,
      requestOrdinal: 1,
      selectedAccountId: 'account-a',
    });
    expect(report.rows.every(row => row.ownerId === 'owner-a')).toBe(true);
    expect(report.rows.some(row => row.gatewayProcessInstanceId === PROCESS_OTHER_OWNER)).toBe(false);
  });

  it('physically prunes expired rows on a later write while keeping rows within retention', async () => {
    const store = createPostgresGatewayRequestOutcomeStore(db.sql);
    const expired = outcomeRecord({
      processId: PROCESS_EXPIRED, ordinal: 1, ownerId: 'owner-a',
      startedAt: BASE, outcomeClass: 'upstream-error',
    });
    await store.record(expired);
    const recent = outcomeRecord({
      processId: PROCESS_RECENT, ordinal: 1, ownerId: 'owner-a',
      startedAt: BASE + GATEWAY_REQUEST_OUTCOME_RETENTION_MS + 5 * 60 * 60_000,
      outcomeClass: 'ok',
    });
    await store.record(recent);

    const oldRows = await db.sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
        FROM harness_shared.gateway_request_outcomes
       WHERE gateway_process_instance_id = ${PROCESS_EXPIRED}
    `;
    const report = await store.report({ ownerId: 'owner-a', nowMs: recent.recordedAtMs + 5 * 60 * 60_000 });

    expect(Number(oldRows[0]?.count ?? 0)).toBe(0);
    expect(report.rows.map(row => row.gatewayProcessInstanceId)).toEqual([PROCESS_RECENT]);
  });
});
