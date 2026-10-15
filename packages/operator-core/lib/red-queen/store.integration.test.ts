/**
 * store.integration.test.ts — red_queen_drills persistence (migration 255),
 * against a real Postgres. Injectable sql.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - insertDrillRow stores artifacts/payload as jsonb OBJECTS (::text::jsonb),
 *    not string scalars, and returns an ISO plantedAt;
 *  - the PARTIAL UNIQUE INDEX enforces one OPEN drill (planted|detected|triaged)
 *    per (workspace, class) — a second plant over an in-flight drill raises 23505,
 *    but once the first leaves the open set (resolved) a new plant succeeds;
 *  - the lifecycle UPDATEs (detected→triaged→resolved) round-trip through
 *    readDrillOutcomes, carrying mttsh segments + leakCheckPassed + issueId;
 *  - expireStaleDrills flips ONLY open drills past the age deadline — a FRESH
 *    open drill and an already-resolved drill are both left alone (TEETHED here:
 *    the `planted_at < now() - make_interval` window);
 *  - readDrillOutcomes is newest-first, workspace- and class-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { insertDrillRow, updateDrillDetected, updateDrillTriaged, updateDrillResolved, markDrillFailed, expireStaleDrills, readDrillOutcomes } =
  await import('./store');

const WS = 'ws-rq';
let rootSql: postgres.Sql;

const plantInput = (over: Record<string, unknown> = {}) =>
  ({
    workspaceId: WS,
    drillClass: 'broken-watchdog',
    collectorFamily: 'watchdog',
    expectedWatchdogKey: 'wd-1',
    expectedKind: 'bug',
    expectedSeverity: 'high',
    expectedDecision: 'file',
    artifacts: { routine: 'r1', planted: true },
    payload: { synthetic: 'x' },
    ...over,
  }) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `rq_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 255 (incl. the partial unique index + status check).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.red_queen_drills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id text NOT NULL, drill_class text NOT NULL, collector_family text NOT NULL,
      status text NOT NULL DEFAULT 'planted',
      planted_at timestamptz NOT NULL DEFAULT now(),
      detected_at timestamptz, triaged_at timestamptz, resolved_at timestamptz,
      expected_watchdog_key text NOT NULL, expected_kind text NOT NULL, expected_severity text NOT NULL, expected_decision text,
      detected_watchdog_key text, detected_kind text, triaged_decision text, triaged_idea_type text,
      resolved_with_evidence boolean NOT NULL DEFAULT false, issue_id text,
      mttsh_detect_ms bigint, mttsh_triage_ms bigint, mttsh_fix_ms bigint, mttsh_total_ms bigint,
      leak_check_passed boolean, leak_check jsonb,
      planted_artifacts jsonb, payload jsonb, error text, learning_lifecycle jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT red_queen_drills_status_check CHECK (status IN ('planted','detected','triaged','resolved','failed','expired')),
      CONSTRAINT red_queen_drills_expected_kind_check CHECK (expected_kind IN ('bug','change'))
    )`);
  await rootSql.unsafe(`
    CREATE UNIQUE INDEX red_queen_drills_open_class_uq
      ON harness_shared.red_queen_drills (workspace_id, drill_class)
      WHERE status IN ('planted','detected','triaged')`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.red_queen_drills`;
});

describe('red-queen drill store (PG)', () => {
  it('insertDrillRow stores artifacts as a jsonb OBJECT (::text::jsonb) and round-trips', async () => {
    const { drillId, plantedAt } = await insertDrillRow(rootSql, plantInput());
    expect(drillId).toMatch(/[0-9a-f-]{36}/); // a real uuid
    expect(plantedAt).toMatch(/^\d{4}-\d\d-\d\dT/); // ISO, not a Date

    const row = (await rootSql<{ at: string; pt: string; pane: string }[]>`
      SELECT jsonb_typeof(planted_artifacts) AS at, jsonb_typeof(payload) AS pt, planted_artifacts->>'routine' AS pane
        FROM harness_shared.red_queen_drills`)[0]!;
    expect(row.at).toBe('object'); // not a string scalar
    expect(row.pt).toBe('object');
    expect(row.pane).toBe('r1');

    const [out] = await readDrillOutcomes(rootSql, { workspaceId: WS });
    expect(out).toMatchObject({ drillId, drillClass: 'broken-watchdog', status: 'planted', expectedWatchdogKey: 'wd-1', origin: 'drill' });
  });

  it('PARTIAL UNIQUE INDEX: one OPEN drill per class — a second plant collides (23505), but resolving frees the slot', async () => {
    await insertDrillRow(rootSql, plantInput());
    // a 2nd plant of the SAME class while the first is still open → unique violation
    await expect(insertDrillRow(rootSql, plantInput())).rejects.toMatchObject({ code: '23505' });
    // a DIFFERENT class is unaffected
    await expect(insertDrillRow(rootSql, plantInput({ drillClass: 'other-class' }))).resolves.toBeTruthy();

    // resolve the first drill → it leaves the open set → the class slot is free again
    const open = (await rootSql<{ id: string }[]>`SELECT id FROM harness_shared.red_queen_drills WHERE drill_class='broken-watchdog'`)[0]!;
    await updateDrillResolved(rootSql, open.id, { resolvedAt: '2026-01-02T00:00:00Z', resolvedWithEvidence: true, mttsh: {}, leakCheck: { passed: true } as never });
    await expect(insertDrillRow(rootSql, plantInput())).resolves.toBeTruthy(); // re-plant now allowed
  });

  it('lifecycle planted→detected→triaged→resolved round-trips mttsh + leakCheckPassed + issueId', async () => {
    const { drillId } = await insertDrillRow(rootSql, plantInput());
    await updateDrillDetected(rootSql, drillId, { detectedAt: '2026-01-01T01:00:00Z', detectedWatchdogKey: 'wd-1', detectedKind: 'bug', issueId: 'EI-7' });
    await updateDrillTriaged(rootSql, drillId, { triagedAt: '2026-01-01T02:00:00Z', triagedDecision: 'file', triagedIdeaType: 'fix' });
    await updateDrillResolved(rootSql, drillId, {
      resolvedAt: '2026-01-01T03:00:00Z',
      resolvedWithEvidence: true,
      mttsh: { detectMs: 100, triageMs: 200, fixMs: 300, totalMs: 600 },
      leakCheck: { passed: true } as never,
    });
    const [out] = await readDrillOutcomes(rootSql, { workspaceId: WS });
    expect(out).toMatchObject({
      status: 'resolved',
      detectedWatchdogKey: 'wd-1',
      triagedDecision: 'file',
      issueId: 'EI-7',
      resolvedWithEvidence: true,
      leakCheckPassed: true,
      mttsh: { detectMs: 100, triageMs: 200, fixMs: 300, totalMs: 600 },
    });
  });

  it('expireStaleDrills flips ONLY aged OPEN drills — a fresh open drill and a resolved one are left alone', async () => {
    // (a) an OLD open drill (backdated past the 24h deadline) → should expire
    const { drillId: oldId } = await insertDrillRow(rootSql, plantInput({ drillClass: 'aged' }));
    await rootSql`UPDATE harness_shared.red_queen_drills SET planted_at = now() - interval '48 hours' WHERE id = ${oldId}`;
    // (b) a FRESH open drill → must NOT expire (the planted_at < deadline window)
    await insertDrillRow(rootSql, plantInput({ drillClass: 'fresh' }));
    // (c) a resolved drill, also backdated → must NOT expire (status guard)
    const { drillId: resId } = await insertDrillRow(rootSql, plantInput({ drillClass: 'done' }));
    await updateDrillResolved(rootSql, resId, { resolvedAt: '2026-01-02T00:00:00Z', resolvedWithEvidence: true, mttsh: {}, leakCheck: { passed: true } as never });
    await rootSql`UPDATE harness_shared.red_queen_drills SET planted_at = now() - interval '48 hours' WHERE id = ${resId}`;

    const n = await expireStaleDrills(rootSql, WS);
    expect(n).toBe(1); // only the aged-open drill

    const rows = await rootSql<{ drill_class: string; status: string }[]>`SELECT drill_class, status FROM harness_shared.red_queen_drills`;
    const byClass = Object.fromEntries(rows.map((r) => [r.drill_class, r.status]));
    expect(byClass.aged).toBe('expired'); // aged + open → expired
    expect(byClass.fresh).toBe('planted'); // fresh open → untouched (the time window)
    expect(byClass.done).toBe('resolved'); // resolved → untouched (the status guard)
  });

  it('expireStaleDrills is workspace-scoped', async () => {
    const { drillId } = await insertDrillRow(rootSql, plantInput({ workspaceId: 'other-ws', drillClass: 'aged' }));
    await rootSql`UPDATE harness_shared.red_queen_drills SET planted_at = now() - interval '48 hours' WHERE id = ${drillId}`;
    expect(await expireStaleDrills(rootSql, WS)).toBe(0); // other-ws's stale drill invisible to WS
    expect((await rootSql`SELECT status FROM harness_shared.red_queen_drills WHERE id=${drillId}`)[0]!.status).toBe('planted');
  });

  it('readDrillOutcomes is newest-first and class-scoped', async () => {
    const a = await insertDrillRow(rootSql, plantInput({ drillClass: 'A' }));
    const b = await insertDrillRow(rootSql, plantInput({ drillClass: 'B' }));
    // backdate A so B is the newest
    await rootSql`UPDATE harness_shared.red_queen_drills SET planted_at = now() - interval '1 hour' WHERE id = ${a.drillId}`;
    expect((await readDrillOutcomes(rootSql, { workspaceId: WS })).map((o) => o.drillClass)).toEqual(['B', 'A']); // planted_at DESC
    expect((await readDrillOutcomes(rootSql, { workspaceId: WS, classId: 'A' })).map((o) => o.drillId)).toEqual([a.drillId]); // class filter
    void b;
  });
});
