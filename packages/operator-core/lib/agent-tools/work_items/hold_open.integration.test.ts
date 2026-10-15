/**
 * Real-store regression for work_items:hold_open { clear, reconcile } — plan
 * bug-queue-legitimacy-and-actionable-validation-2026-10-10 D-009.
 *
 * The unit suite proves the tool's branching with the two database seams mocked. This
 * suite proves the property D-009 exists for, against a migrated Postgres: an agent can
 * settle a peer's DURABLE PARK through the tool door with evidence and a fingerprint
 * compare-and-set, the fingerprint the dry run hands back is the one the reconciler's CAS
 * accepts, a moved park is refused rather than cleared, a retry replays instead of
 * re-applying, and a coexisting held_open lease survives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../../long-lived-admin-pool', () => ({ getLongLivedAdminPool: () => h.sql }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'reconciling-agent', workspaceId: 'default' }),
}));
// Not the subject: the broadcast and the report artifact's disk/PG mirror.
const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
const saveTextArtifact = vi.fn();
vi.mock('../../text-artifacts', async (orig) => ({
  ...(await orig<object>()),
  saveTextArtifact: (...a: unknown[]) => saveTextArtifact(...a),
}));

const holdOpen = (await import('./hold_open')).default;
const { DURABLE_PARK_CLEAR_AUDIT_ACTION } = await import('../../work-items-durable-park-audit');

const HARNESS = 'papercusp';
const EVIDENCE = 'deploy.3070.sha=d740fc3802 contains the fix commit (blob equal at the fixed path)';
const PARK = {
  _claimHold: 'true',
  claim_hold_by: 'departed-parker',
  claim_hold_reason: 'parked until the fix is deployed to :3070',
  claim_hold_at: '2026-10-08T10:00:00.000Z',
};

let db: OrgTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  vi.clearAllMocks();
  sendMessage.mockResolvedValue(undefined);
  saveTextArtifact.mockResolvedValue(undefined);
  await sql`TRUNCATE harness_shared.work_items, harness_shared.audit_log, harness_shared.admission_runs RESTART IDENTITY CASCADE`;
});

async function insertParked(id: string, payload: Record<string, unknown>, takenBy: string | null = null): Promise<void> {
  const now = Date.parse('2026-10-08T10:00:00.000Z');
  await sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, title, summary, status, item_kind, taken_by, workspace_id,
       created_ts, updated_ts, payload)
    VALUES
      (${HARNESS}, ${id}, ${`parked ${id}`}, 'parked', 'blocked', 'bug', ${takenBy}, 'default',
       ${now}, ${now}, ${sql.json(payload as never)})`;
}

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM harness_shared.work_items WHERE feature_id = ${id} AND workspace_id = 'default'`;
  return rows[0]!.payload;
}

async function receipts(id: string) {
  return sql<Array<{ actor: string; details: Record<string, unknown> }>>`
    SELECT actor, details FROM harness_shared.audit_log
     WHERE action = ${DURABLE_PARK_CLEAR_AUDIT_ACTION} AND subject = ${id}`;
}

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = (holdOpen.args as { parse: (x: unknown) => unknown }).parse(args);
  const res = (await holdOpen.handler(parsed as never, { harnessSlug: HARNESS } as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

const reconcile = (extra: Record<string, unknown> = {}) => ({
  id: 'EI-park-1',
  harness: HARNESS,
  clear: true,
  reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, ...extra },
});

describe('work_items:hold_open clear+reconcile against a real store (D-009)', () => {
  it('dry run → apply clears a departed peer\'s park with a receipt, and a retry replays instead of re-applying', async () => {
    await insertParked('EI-park-1', PARK);

    const preview = await call(reconcile());
    expect(preview).toMatchObject({ ok: true, dryRun: true, outcome: 'cleared', wouldClear: true });
    expect(await payloadOf('EI-park-1')).toMatchObject({ _claimHold: 'true', claim_hold_by: 'departed-parker' });
    expect(await receipts('EI-park-1')).toHaveLength(0);

    const fp = preview.observedParkFingerprint as string;
    const applied = await call(reconcile({ expectedParkFingerprint: fp }));
    expect(applied).toMatchObject({ ok: true, outcome: 'cleared', held: false, clearedFrom: 'departed-parker' });
    const after = await payloadOf('EI-park-1');
    for (const key of ['_claimHold', 'claim_hold_by', 'claim_hold_reason', 'claim_hold_at']) expect(after).not.toHaveProperty(key);

    const written = await receipts('EI-park-1');
    expect(written).toHaveLength(1);
    expect(written[0]!.actor).toBe('reconciling-agent');
    expect(written[0]!.details).toMatchObject({
      reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: fp, runId: applied.runId,
    });
    const runs = await sql<Array<{ detail: Record<string, unknown> }>>`
      SELECT detail FROM harness_shared.admission_runs WHERE id = ${applied.runId as string}`;
    expect(runs[0]!.detail).toMatchObject({ status: 'complete', mode: 'durable-park-reconcile' });

    // Identical input → identical runId → the recorded run is replayed: no second receipt.
    const retried = await call(reconcile({ expectedParkFingerprint: fp }));
    expect(retried).toMatchObject({ ok: true, outcome: 'cleared', runId: applied.runId });
    expect(await receipts('EI-park-1')).toHaveLength(1);

    // A fresh attempt (different evidence) against the now-cleared row is evaluated, not refused.
    const fresh = await call({
      ...reconcile(),
      reconcile: { reasonCode: 'condition-satisfied', evidence: `${EVIDENCE} (rechecked)`, expectedParkFingerprint: fp },
    });
    expect(fresh).toMatchObject({ ok: true, outcome: 'already-cleared' });
    expect(await receipts('EI-park-1')).toHaveLength(1);
  });

  it('a park that MOVED after the dry run is refused as stale-fingerprint and stays parked', async () => {
    await insertParked('EI-park-1', PARK);
    const preview = await call(reconcile());
    await sql`
      UPDATE harness_shared.work_items
         SET payload = payload || ${sql.json({ claim_hold_reason: 'parked: now waiting on a DIFFERENT fix' } as never)}
       WHERE feature_id = 'EI-park-1'`;

    const out = await call(reconcile({ expectedParkFingerprint: preview.observedParkFingerprint }));
    expect(out).toMatchObject({ ok: false, outcome: 'stale-fingerprint', error: 'reconcile_stale-fingerprint' });
    expect(out.observedParkFingerprint).not.toBe(preview.observedParkFingerprint);
    expect(await payloadOf('EI-park-1')).toMatchObject({ _claimHold: 'true', claim_hold_by: 'departed-parker' });
    expect(await receipts('EI-park-1')).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('clearing the park preserves a coexisting held_open lease (the item stays held)', async () => {
    await insertParked('EI-park-1', { ...PARK, held_open_by: 'live-gatekeeper', held_open_reason: 'verifying', held_open_at: '2026-10-10T09:00:00.000Z' });
    const preview = await call(reconcile());
    const out = await call(reconcile({ expectedParkFingerprint: preview.observedParkFingerprint }));
    expect(out).toMatchObject({ ok: true, outcome: 'cleared', held: true, preservedLease: true });
    const after = await payloadOf('EI-park-1');
    expect(after).toMatchObject({ _claimHold: 'true', held_open_by: 'live-gatekeeper' });
    expect(after).not.toHaveProperty('claim_hold_by');
  });

  it('a park on a CLAIMED row is reported `assigned` and left untouched', async () => {
    await insertParked('EI-park-1', PARK, 'someone-live');
    const preview = await call(reconcile());
    expect(preview).toMatchObject({ dryRun: true, outcome: 'assigned', wouldClear: false });
    const out = await call(reconcile({ expectedParkFingerprint: preview.observedParkFingerprint }));
    expect(out).toMatchObject({ ok: false, outcome: 'assigned' });
    expect(await payloadOf('EI-park-1')).toMatchObject({ claim_hold_by: 'departed-parker' });
  });
});
