/**
 * Decision provenance against the real migrated schema (migration 1603,
 * one-work-graph-structured-holds-2026-10-26#P-018, D-012).
 *
 * The unit tests mock the database. These run the record module against a disposable
 * database cloned from the fully-migrated org template, so the table, its key, its shape
 * checks and the read join are exercised as they ship.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const {
  upsertDecisionProvenance,
  recordDecisionProvenance,
  loadDecisionProvenance,
  resolveDecisionProvenance,
  withDecisionProvenance,
} = await import('./decision-provenance-record');
type ProvenanceArg = Parameters<typeof resolveDecisionProvenance>[0];

const WS = 'ws-1603-a';
const WS2 = 'ws-1603-b';
const SCOPE = { workspaceId: WS, harnessSlug: 'papercusp', planSlug: 'plan-1603' };
const OWNER_TURN = 'session_turn:claude:00000000-0000-0000-0000-000000001603:7';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
});

afterAll(async () => {
  await db?.cleanup();
});

describe('plan_decision_provenance (migration 1603)', () => {
  it('stores an owner row and an agent row and reads them back with their fields', async () => {
    await upsertDecisionProvenance({ ...SCOPE, decisionId: 'D-001' }, {
      kind: 'owner',
      agentId: 'su-author',
      ownerTurnRef: OWNER_TURN,
      ownerTurnVerdict: 'owner-typed',
    });
    await upsertDecisionProvenance({ ...SCOPE, decisionId: 'D-002' }, { kind: 'agent', agentId: 'su-author' });

    const byId = await loadDecisionProvenance(SCOPE, ['D-001', 'D-002', 'D-003']);
    expect(byId.get('D-001')).toMatchObject({
      kind: 'owner',
      agentId: 'su-author',
      ownerTurnRef: OWNER_TURN,
      ownerTurnVerdict: 'owner-typed',
      source: 'write',
    });
    expect(byId.get('D-002')).toMatchObject({ kind: 'agent', agentId: 'su-author', source: 'write' });
    expect(byId.get('D-003')).toEqual({ kind: 'unrecorded' });
  });

  it('replaces the row on a second write instead of adding one, and clears the owner fields', async () => {
    const key = { ...SCOPE, decisionId: 'D-010' };
    await upsertDecisionProvenance(key, {
      kind: 'owner',
      agentId: 'su-first',
      ownerTurnRef: OWNER_TURN,
      ownerTurnVerdict: 'owner-dialog',
    });
    await upsertDecisionProvenance(key, { kind: 'agent', agentId: 'su-second' });

    const rows = await db.adminSql<Array<{ kind: string; agent_id: string; owner_turn_ref: string | null }>>`
      SELECT kind, agent_id, owner_turn_ref FROM harness_shared.plan_decision_provenance
       WHERE workspace_id = ${WS} AND plan_slug = ${SCOPE.planSlug} AND decision_id = 'D-010'`;
    expect(rows).toEqual([{ kind: 'agent', agent_id: 'su-second', owner_turn_ref: null }]);
  });

  it('refuses an owner row without a turn ref, a malformed decision id and a blank agent', async () => {
    await expect(db.adminSql`
      INSERT INTO harness_shared.plan_decision_provenance
        (workspace_id, harness_slug, plan_slug, decision_id, kind, agent_id, source)
      VALUES (${WS}, 'papercusp', 'plan-1603', 'D-020', 'owner', 'su-x', 'write')`).rejects.toThrow(
      /plan_decision_provenance_kind_shape/,
    );
    await expect(db.adminSql`
      INSERT INTO harness_shared.plan_decision_provenance
        (workspace_id, harness_slug, plan_slug, decision_id, kind, agent_id, source)
      VALUES (${WS}, 'papercusp', 'plan-1603', 'D-1', 'agent', 'su-x', 'write')`).rejects.toThrow(/check constraint/i);
    await expect(db.adminSql`
      INSERT INTO harness_shared.plan_decision_provenance
        (workspace_id, harness_slug, plan_slug, decision_id, kind, agent_id, source)
      VALUES (${WS}, 'papercusp', 'plan-1603', 'D-021', 'agent', '  ', 'write')`).rejects.toThrow(/check constraint/i);
  });

  it('keys rows by workspace, harness and plan: another scope reads unrecorded', async () => {
    await upsertDecisionProvenance({ ...SCOPE, decisionId: 'D-030' }, { kind: 'agent', agentId: 'su-a' });

    const otherWorkspace = await loadDecisionProvenance({ ...SCOPE, workspaceId: WS2 }, ['D-030']);
    const otherPlan = await loadDecisionProvenance({ ...SCOPE, planSlug: 'plan-1603-other' }, ['D-030']);
    const otherHarness = await loadDecisionProvenance({ ...SCOPE, harnessSlug: 'portal' }, ['D-030']);
    expect(otherWorkspace.get('D-030')).toEqual({ kind: 'unrecorded' });
    expect(otherPlan.get('D-030')).toEqual({ kind: 'unrecorded' });
    expect(otherHarness.get('D-030')).toEqual({ kind: 'unrecorded' });
  });

  it('recordDecisionProvenance reports the row it wrote, and the read join attaches it', async () => {
    const recorded = await recordDecisionProvenance({ ...SCOPE, decisionId: 'D-040' }, {
      kind: 'owner',
      agentId: 'su-author',
      ownerTurnRef: OWNER_TURN,
      ownerTurnVerdict: 'owner-turn',
    });
    expect(recorded).toMatchObject({ kind: 'owner', ownerTurnRef: OWNER_TURN, source: 'write' });

    const joined = await withDecisionProvenance(SCOPE, [
      { id: 'D-040', title: 'owner-ruled' },
      { id: 'D-041', title: 'never recorded' },
    ]);
    expect(joined.map((d) => [d.id, d.provenance.kind])).toEqual([
      ['D-040', 'owner'],
      ['D-041', 'unrecorded'],
    ]);
    expect(joined[0]).toMatchObject({ title: 'owner-ruled', provenance: { ownerTurnVerdict: 'owner-turn' } });
  });

  // The write path as plans:add-decision composes it: resolve with the REAL identity resolver
  // and turn verifier, record only on ok. A refusal must leave no row behind.
  async function writeDecision(decisionId: string, arg: ProvenanceArg, ctx: Record<string, unknown>) {
    const resolution = await resolveDecisionProvenance(arg, 'A ruling.', ctx);
    if (resolution.ok) await recordDecisionProvenance({ ...SCOPE, decisionId }, resolution.provenance);
    const rows = await db.adminSql<Array<{ kind: string; agent_id: string }>>`
      SELECT kind, agent_id FROM harness_shared.plan_decision_provenance
       WHERE workspace_id = ${WS} AND plan_slug = ${SCOPE.planSlug} AND decision_id = ${decisionId}`;
    return { resolution, rows };
  }
  const ATTRIBUTED = { workspaceId: WS, isSuperuser: true, uiClientId: 'su-int-recorder' };

  it('SPEC-P-018: a decision with provenance lands its row; one with no resolvable provenance is refused with no row', async () => {
    const withProvenance = await writeDecision('D-050', undefined, ATTRIBUTED);
    expect(withProvenance.resolution).toEqual({ ok: true, provenance: { kind: 'agent', agentId: 'su-int-recorder' } });
    expect(withProvenance.rows).toEqual([{ kind: 'agent', agent_id: 'su-int-recorder' }]);

    for (const [id, arg] of [['D-051', undefined], ['D-052', { kind: 'agent' }]] as const) {
      const without = await writeDecision(id, arg, { workspaceId: WS });
      expect(without.resolution).toMatchObject({ ok: false, error: 'provenance_unattributable', field: 'provenance' });
      expect(without.rows).toEqual([]);
    }
  });

  it('AUTO-BAR-R-9: an owner turn ref that does not resolve is refused with no row', async () => {
    const unresolved = await writeDecision(
      'D-060',
      { kind: 'owner', turnRef: '[turn:deadbeef@2026-10-28T11:00:00.000Z]' },
      ATTRIBUTED,
    );
    expect(unresolved.resolution).toMatchObject({ ok: false, error: 'provenance_owner_turn_unverified', field: 'ownerTurnRef' });
    expect(unresolved.rows).toEqual([]);
  });

  it('a failed read marks every decision unavailable, never unrecorded', async () => {
    const joined = await withDecisionProvenance(SCOPE, [{ id: 'D-001' }, { id: 'D-099' }], async () => {
      throw new Error('connection reset');
    });
    expect(joined.map((d) => d.provenance.kind)).toEqual(['unavailable', 'unavailable']);
    expect(joined[0]?.provenance).toMatchObject({ reason: expect.stringContaining('connection reset') });
  });
});
