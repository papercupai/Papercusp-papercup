/**
 * escalation-log-gc.integration.test.ts — gcResolvedEscalationFamilies, the physical
 * retention GC over the coord_event_log `escalations` surface, against a real Postgres.
 *
 * infra-fail-fast C3/P-011. Proves the family-atomic, resolved-only, fully-aged,
 * operator-scope-only DELETE: an OPEN escalation, a RECENTLY-resolved one, and a
 * harness-scoped (federating) one all SURVIVE; only a resolved + fully-aged +
 * operator-scope family is deleted — and the WHOLE family (raise + every resolution
 * sibling) goes, so the read-time open/resolved fold can never resurrect it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcResolvedEscalationFamilies } = await import('./escalation-log-gc');

let rootSql: postgres.Sql;
const remainingIds = async () =>
  (await rootSql<{ msg_id: string }[]>`SELECT msg_id FROM harness_shared.coord_event_log ORDER BY msg_id`).map((r) => r.msg_id);

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `egc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      surface text NOT NULL, writer_key text, msg_id text NOT NULL,
      body jsonb NOT NULL, harness_slug text, ts timestamptz DEFAULT now() NOT NULL
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_event_log RESTART IDENTITY`;
});

/** Insert one escalations event. `relatedTo` set ⇒ it's an escalation_resolved sibling. */
async function ins(opts: {
  msgId: string; ageDays: number; relatedTo?: string; harness?: string | null;
}) {
  const body = opts.relatedTo
    ? { kind: 'escalation_resolved', related_msg_id: opts.relatedTo, summary: 'resolved: x' }
    : { kind: 'escalation', summary: 'an escalation' };
  await rootSql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, harness_slug, ts)
    VALUES ('escalations', ${opts.msgId}, ${rootSql.json(body)}, ${opts.harness ?? null},
            now() - make_interval(days => ${opts.ageDays}))`;
}

describe('gcResolvedEscalationFamilies (PG)', () => {
  it('deletes ONLY resolved + fully-aged + operator-scope families, whole-family-atomic', async () => {
    // (1) OPEN, operator-scope, old raise, never resolved → KEPT (resolved-only guard).
    await ins({ msgId: 'open-old', ageDays: 30 });
    // (2) resolved but the resolution is RECENT → KEPT (fully-aged guard).
    await ins({ msgId: 'res-recent-raise', ageDays: 30 });
    await ins({ msgId: 'res-recent-fix', ageDays: 1, relatedTo: 'res-recent-raise' });
    // (3) resolved + fully-aged, operator-scope → DELETED (raise + sibling = 2 rows).
    await ins({ msgId: 'res-old-raise', ageDays: 20 });
    await ins({ msgId: 'res-old-fix', ageDays: 20, relatedTo: 'res-old-raise' });
    // (4) resolved + fully-aged with MULTIPLE resolution siblings (resolved + archived) → all 3 deleted.
    await ins({ msgId: 'multi-raise', ageDays: 25 });
    await ins({ msgId: 'multi-fix', ageDays: 22, relatedTo: 'multi-raise' });
    await ins({ msgId: 'multi-archive', ageDays: 18, relatedTo: 'multi-raise' });
    // (5) resolved + fully-aged but HARNESS-SCOPED (federates) → KEPT (no federated deletion).
    await ins({ msgId: 'hs-raise', ageDays: 30, harness: 'some-hive' });
    await ins({ msgId: 'hs-fix', ageDays: 30, relatedTo: 'hs-raise', harness: 'some-hive' });

    const n = await gcResolvedEscalationFamilies(14);
    expect(n).toBe(5); // family (3): 2 rows + family (4): 3 rows

    expect(await remainingIds()).toEqual([
      'hs-fix', 'hs-raise', 'open-old', 'res-recent-fix', 'res-recent-raise',
    ]);
  });

  it('retentionDays controls the age cutoff', async () => {
    await ins({ msgId: 'r', ageDays: 10 });
    await ins({ msgId: 'r-fix', ageDays: 10, relatedTo: 'r' });
    expect(await gcResolvedEscalationFamilies(14)).toBe(0); // 10d < 14d → kept
    expect(await gcResolvedEscalationFamilies(7)).toBe(2);  // 10d > 7d → family deleted
  });
});
