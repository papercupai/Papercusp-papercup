import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { applyGoalPackageUpdate, planGoalPackageUpdate } from './package-update';
import { resolveLocalGoalPackage } from '../cupboard/goal-package-store';
import type { Sql } from 'postgres';

// Exercise the maintained bundled package, independent of any user-layer
// export on the developer's machine. The SQL reader/validator/writer stay real.
vi.mock('../cupboard/goal-package-store', async (original) => {
  const actual = await original<typeof import('../cupboard/goal-package-store')>();
  const { fileURLToPath } = await import('node:url');
  return { ...actual, resolveLocalGoalPackage: (ref: string) => actual.resolveLocalGoalPackage(ref,
    [{ dir: fileURLToPath(new URL('../../../../goal-packages', import.meta.url)), layer: 'bundled' }]) };
});

let db: OrgTestDb;
const WS = 'package-update-properties';
vi.mock('@papercusp/db-org', async (original) => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: db.adminSql, workspaceId: WS }) };
});
beforeAll(async () => { db = await createOrgTestDb(); }, 300_000);
afterAll(async () => { await db?.cleanup(); }, 120_000);

describe('accepted package declaration update (private Postgres)', () => {
  it.each(['active', 'paused', 'killed'])('preserves lifecycle and stored owner choices on a started package-update attempt (%s)', async (status) => {
    const sql = db.adminSql;
    const goalId = `package-update-${status}`;
    const pkg = resolveLocalGoalPackage('work-on-everything');
    expect(pkg).toBeDefined();
    const properties = {
      worklist: { value: ['plan:papercusp/saved-plan'], version: 7, edited_by: 'agent', edited_at: '2026-10-01T00:00:00Z' },
      worklist_policy: { value: { order: ['plan:papercusp/saved-plan'], excluded: ['plan:papercusp/excluded-plan'] },
        version: 4, edited_by: 'owner', edited_at: '2026-10-02T00:00:00Z' },
    };
    const metadata = { goalPackageRef: 'work-on-everything', packageVersion: '1.1.0',
      agentOwnerId: 'su-package-holder', custom: { keep: true } };
    const instanceOnly = { datatype: 'plan-ref-list', default: [], editable_by: 'owner' };
    await sql`INSERT INTO harness_shared.goals
      (workspace_id, id, install_slug, title, status, standing, property_schema, properties, metadata)
      VALUES (${WS}, ${goalId}, 'papercusp', 'Prior title', ${status}, true,
        ${sql.json({ worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both' }, instance_only: instanceOnly })},
        ${sql.json(properties)}, ${sql.json(metadata)})`;
    const [before] = await sql`SELECT status, metadata, properties, property_schema FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = ${goalId}`;
    await sql.begin(async (tx) => {
      const plan = await planGoalPackageUpdate(tx as unknown as Sql, { workspaceId: WS, goalId });
      if (status === 'killed') expect(plan).toMatchObject({ ok: false, reason: 'terminal-instance' });
      else expect(plan.ok && plan.changes.map((c) => c.field)).toContain('propertySchema');
      const [planned] = await tx`SELECT status, metadata, properties, property_schema FROM harness_shared.goals
        WHERE workspace_id = ${WS} AND id = ${goalId}`;
      expect(planned).toEqual(before);
      const applied = await applyGoalPackageUpdate(tx as unknown as Sql, { workspaceId: WS, goalId });
      expect(applied).toMatchObject(status === 'killed'
        ? { ok: false, reason: 'terminal-instance' } : { ok: true, mode: 'live-contract' });
      const { readGoalRubricStewardship } = await import('../goal-rubric-stewardship');
      const reading = await readGoalRubricStewardship({ workspaceId: WS, goalId }, { sql: tx as unknown as Sql });
      expect(reading.error).toBeNull();
      const [afterRead] = await tx`SELECT status FROM harness_shared.goals
        WHERE workspace_id = ${WS} AND id = ${goalId}`;
      expect(afterRead.status, 'The canonical rubric evidence reader cannot resume or resurrect a goal').toBe(before.status);
    });
    const [after] = await sql`SELECT status, metadata, properties, property_schema FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(after.status).toBe(before.status);
    expect(after.properties).toEqual(properties);
    expect(after.metadata).toEqual(status === 'killed' ? metadata : { ...metadata, packageVersion: pkg?.version });
    expect(after.property_schema).toEqual(status === 'killed'
      ? before.property_schema : { ...pkg?.propertySchema, instance_only: instanceOnly });
    const again = await planGoalPackageUpdate(sql, { workspaceId: WS, goalId });
    expect(again).toMatchObject({ ok: false, reason: status === 'killed' ? 'terminal-instance' : 'up-to-date' });
  }, 60_000);
});
