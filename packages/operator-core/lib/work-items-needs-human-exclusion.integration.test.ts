/**
 * work-items-needs-human-exclusion.integration.test.ts — post-migration-864
 * compatibility behavior for the historical `payload.needsHuman` key.
 *
 * Migration 864 replaced the ambiguous payload flag with typed owner-action and agent-review
 * destinations. The legacy key remains readable for pre-migration rows, but no lifecycle writer
 * may recreate it. Stored status='needs-human' is reserved for a strict typed owner capability;
 * unstructured requests are refused at the lifecycle seam.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-needs-human-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  afterUpdate: undefined as ((id: string) => Promise<void>) | undefined,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('./agent-tools/coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'condition-tester' }) }));
vi.mock('./work-items', async (orig) => {
  const actual = await orig<typeof import('./work-items')>();
  return {
    ...actual,
    updateWorkItem: async (...args: Parameters<typeof actual.updateWorkItem>) => {
      const result = await actual.updateWorkItem(...args);
      await h.afterUpdate?.(args[0]);
      return result;
    },
  };
});

const wi = await import('./work-items');
const updateTool = (await import('./agent-tools/work_items/update')).default;

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE. */
async function seedIssue(
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; createdTs?: number; payload?: Record<string, unknown> | null } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload as unknown as Parameters<typeof db.sql.json>[0]) : null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-needs-human');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
  // Claims and lifecycle transitions emit awaited-event latches. Keep this fixture's
  // runtime dependency explicit and migration-audited so a missing latch relation does
  // not turn otherwise-correct assertions into vitest-fail-on-console failures.
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'work-items-needs-human-exclusion.integration.test.ts',
  });
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL,
    action text NOT NULL, subject text, details jsonb, workspace_id text NOT NULL
  )`;
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  h.afterUpdate = undefined;
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('work_items:update requires persisted current owner authority (P-003)', () => {
  const ownerCondition = {
    kind: 'human', ref: 'credential:test-service', capability: 'credential', status: 'active',
    summary: 'Provide the service credential.', nextVerb: 'Configure and verify the credential.',
    defaultIfUnanswered: 'Keep the credential-dependent work parked.',
    createdBy: 'requester', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
    legacyEvidence: { generation: 7 },
  };
  const update = async (id: string, extra: Record<string, unknown> = {}) => {
    const result = await updateTool.handler({ id, harness: H, needsHuman: true, ...extra } as never, { workspaceId: WS } as never);
    return (result as { data: { results: Array<{ ok: boolean; error?: string }> } }).data;
  };
  const read = async (id: string) => (await db.sql<{
    title: string; status: string; taken_by: string | null; payload: Record<string, unknown>;
  }[]>`SELECT title, status, taken_by, payload FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}`)[0]!;

  it.each(['bug', 'feature'])('refuses an unsupported %s flag before mixed edits and preserves the peer park', async (kind) => {
    const id = `WI-bare-${kind}`;
    const payload = { sibling: 'keep', needsHuman: true, _park: { ref: 'runtime:independent', owner: 'peer' } };
    await seedIssue(id, { kind, takenBy: 'peer', payload });
    const before = await read(id);

    const result = await update(id, { title: 'must not change', payload: { sibling: 'must not change' } });

    expect(result.results[0]).toMatchObject({ ok: false });
    expect(result.results[0]?.error).toContain('current typed credential');
    expect(await read(id)).toEqual(before);
  });

  it.each(['bug', 'feature'])('accepts a persisted credential for %s and preserves its raw condition and peer claim', async (kind) => {
    const id = `WI-credential-${kind}`;
    const payload = { sibling: 'keep', needsHuman: true, externalBlockers: [ownerCondition], _park: { ref: 'runtime:independent', owner: 'peer' } };
    await seedIssue(id, { kind, takenBy: 'peer', payload });

    expect((await update(id)).results[0]).toMatchObject({ ok: true });
    const row = await read(id);
    expect(row.taken_by).toBe('peer');
    expect(row.status).toBe('open');
    expect(row.payload).toMatchObject({ sibling: 'keep', needsOwnerAction: true });
    expect(row.payload.externalBlockers).toEqual(payload.externalBlockers);
    expect(row.payload._park).toEqual(payload._park);
    expect(Object.hasOwn(row.payload, 'needsHuman')).toBe(false);
  });

  it.each([
    ['bug', 'clear'], ['bug', 'close'], ['feature', 'clear'], ['feature', 'close'],
  ])('fences a concurrent %s %s at the SQL write without restoring the owner flag', async (kind, change) => {
    const id = `WI-race-${kind}-${change}`;
    const payload = { sibling: 'keep', needsHuman: true, externalBlockers: [ownerCondition], _park: { ref: 'runtime:independent', owner: 'peer' } };
    await seedIssue(id, { kind, takenBy: 'peer', payload });
    h.afterUpdate = async (updatedId) => {
      expect(updatedId).toBe(id);
      if (change === 'clear') {
        await db.sql`UPDATE harness_shared.work_items
          SET payload = jsonb_set(payload, '{externalBlockers}', ${db.sql.json([{ ...ownerCondition, status: 'cleared' }])})
          WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}`;
      } else {
        await db.sql`UPDATE harness_shared.work_items SET status = 'done'
          WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}`;
      }
    };

    const result = await update(id);

    expect(result.results[0]).toMatchObject({ ok: false });
    expect(result.results[0]?.error).toContain('owner-condition-changed');
    const row = await read(id);
    expect(row.taken_by).toBe('peer');
    expect(row.payload.needsOwnerAction).toBeUndefined();
    expect(row.payload.needsHuman).toBe(true);
    expect(row.payload.sibling).toBe('keep');
    expect(row.payload._park).toEqual(payload._park);
    expect(row.status).toBe(change === 'close' ? 'done' : 'open');
    expect(row.payload.externalBlockers).toEqual([{ ...ownerCondition, status: change === 'clear' ? 'cleared' : 'active' }]);
  });
});

describe('claimNextWorkItem admits a legacy needsHuman:true OPEN issue after migration 864', () => {
  it('serves the legacy-tagged item normally when it is oldest', async () => {
    await seedIssue('EI-human', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-real', { createdTs: 200 });

    // The legacy payload key is no longer a floor, so ordinary oldest-first ordering applies.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('EI-human');

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toMatchObject({ id: 'WI-real' });
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-human'`;
    expect(rows[0]?.taken_by).toBe('bee-1');
  });

  it('a needsHuman row is also directly claimable by id', async () => {
    await seedIssue('EI-human-direct', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    const claimed = await wi.claimWorkItem('EI-human-direct', 'inspector', { harness: H });
    expect(claimed?.id).toBe('EI-human-direct');
    expect(claimed?.assignee).toBe('inspector');
  });

  it('needsHuman:false is NOT excluded', async () => {
    await seedIssue('WI-not-human', { kind: 'change', createdTs: 100, payload: { needsHuman: false } });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-not-human');
  });

  it('a row with no payload at all is NOT excluded (NULL-safe)', async () => {
    await seedIssue('WI-no-payload', { kind: 'change', createdTs: 100, payload: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-no-payload');
  });
});

describe('diagnoseClaimNextMiss counts a legacy needsHuman OPEN row as ordinary work', () => {
  it('reports the row pending and ready instead of a false drain', async () => {
    await seedIssue('EI-human-diag', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1);
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });

  it('counts both a plain row and a legacy-tagged row', async () => {
    await seedIssue('EI-human-diag-2', { kind: 'change', createdTs: 100, payload: { needsHuman: true } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(2);
    expect(diag.readyUnclaimed).toBe(2);
    expect(diag.drained).toBe(false);
  });
});

describe('setWorkItemStateWithAliasInfo retires legacy needsHuman writes (P-006)', () => {
  it('releases an active claim when an issue enters needs-human so the next pull can proceed', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'credential',
        ref: 'credential:prod-db',
        summary: 'Provide the production DB credential.',
        nextVerb: 'setup:save_key',
        defaultIfUnanswered: 'stay parked until the credential is supplied',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-claimed-human', {
      kind: 'change',
      status: 'open',
      createdTs: 100,
    });
    await seedIssue('WI-next-after-human', { createdTs: 200 });

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toMatchObject({
      id: 'EI-claimed-human',
    });
    await db.sql`
      UPDATE harness_shared.work_items
         SET payload = ${db.sql.json(
           { humanCapability: 'credential', externalBlockers: blockers } as unknown as Parameters<typeof db.sql.json>[0],
         )}
       WHERE workspace_id = ${WS} AND feature_id = 'EI-claimed-human'`;

    const parked = await wi.setWorkItemStateWithAliasInfo('EI-claimed-human', 'needs-human', {
      harness: H,
      by: 'tester',
    });

    expect(parked.appliedState).toBe('needs-human');
    const released = await db.sql<{ status: string; taken_by: string | null; taken_at: string | null; last_progress_at: string | null }[]>`
      SELECT status, taken_by, taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'EI-claimed-human'`;
    expect(released[0]).toMatchObject({
      status: 'needs-human',
      taken_by: null,
      taken_at: null,
      last_progress_at: null,
    });

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' })).toMatchObject({
      id: 'WI-next-after-human',
    });
  });

  it('refuses an unstructured needs-human request instead of creating a write-only park', async () => {
    await seedIssue('EI-echo-1', { kind: 'change', status: 'open', createdTs: 100, payload: {} });

    await expect(
      wi.setWorkItemStateWithAliasInfo('EI-echo-1', 'needs-human', { harness: H, by: 'tester' }),
    ).rejects.toThrow(/no answerable owner ask.*work_items:set_blocker/);
  });

  // D-029: a structured ask with no defaultIfUnanswered cannot be answered (the owner cannot see
  // what happens if they never reply), so the canonical writer refuses it exactly like no ask.
  it('refuses a structured owner ask that carries no defaultIfUnanswered', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'credential',
        ref: 'credential:no-default',
        summary: 'Provide the staging credential.',
        nextVerb: 'setup:save_key',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-no-default', {
      kind: 'change',
      status: 'open',
      createdTs: 100,
      payload: { humanCapability: 'credential', externalBlockers: blockers },
    });

    await expect(
      wi.setWorkItemStateWithAliasInfo('EI-no-default', 'needs-human', { harness: H, by: 'tester' }),
    ).rejects.toThrow(/no answerable owner ask.*defaultIfUnanswered/);
    const rows = await db.sql<{ status: string }[]>`
      SELECT status FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-no-default'`;
    expect(rows[0]?.status).toBe('open');
  });

  it('keeps a strict structured owner ask parked and replaces the legacy key atomically', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'credential',
        ref: 'credential:prod-db',
        summary: 'Provide the production DB credential.',
        nextVerb: 'setup:save_key',
        defaultIfUnanswered: 'stay parked until the credential is supplied',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-echo-2', {
      kind: 'change',
      status: 'open',
      createdTs: 100,
      payload: { humanCapability: 'credential', needsHuman: true, externalBlockers: blockers },
    });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-2', 'needs-human', { harness: H, by: 'tester' });

    const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
      SELECT payload FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-echo-2'`;
    expect(res.appliedState).toBe('needs-human');
    expect(rows[0]?.payload?.needsOwnerAction).toBe(true);
    expect(rows[0]?.payload).not.toHaveProperty('needsHuman');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsOwnerAction).toBe(true);
  });

  it('accepts a product-decision structured owner ask when retrying needs-human parking', async () => {
    const { blockers } = wi.updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'product-decision',
        ref: 'decision:scope',
        summary: 'Choose the supported scope.',
        nextVerb: 'Record the product decision.',
        defaultIfUnanswered: 'keep the current scope',
      },
      'tester',
      '2026-08-23T18:00:00.000Z',
    );
    await seedIssue('EI-product-decision-human', {
      kind: 'change',
      status: 'open',
      payload: { humanCapability: 'product-decision', externalBlockers: blockers },
    });

    const res = await wi.setWorkItemStateWithAliasInfo('EI-product-decision-human', 'needs-human', {
      harness: H,
      by: 'tester',
    });

    expect(res.appliedState).toBe('needs-human');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsOwnerAction).toBe(true);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });

  it('does not disturb an item already pending agent review', async () => {
    const agentReview = { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-ledger', round: 1 };
    await seedIssue('EI-echo-review', { kind: 'change', status: 'open', payload: { agentReview } });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-review', 'needs-human', { harness: H, by: 'tester' });
    expect(res.appliedState).toBe('open');
    expect(res.aliasNote).toMatch(/already in agent review/);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.agentReview).toEqual(agentReview);
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });

  it('a non-issue-family transition (e.g. plain wip) never calls the auto-gate / re-fetch at all', async () => {
    await seedIssue('EI-echo-3', { kind: 'change', status: 'open', createdTs: 100, payload: { marker: 'untouched' } });
    const res = await wi.setWorkItemStateWithAliasInfo('EI-echo-3', 'wip', { harness: H, by: 'tester' });
    expect(res.appliedState).toBe('wip');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.marker).toBe('untouched');
    expect((res.workItem?.payload as Record<string, unknown> | undefined)?.needsHuman).toBeUndefined();
  });
});

describe('blocked auto-gate lease cleanup (EI-20490353465054928)', () => {
  async function payloadOf(id: string) {
    const rows = await db.sql<{ status: string; payload: Record<string, unknown> | null }[]>`
      SELECT status, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    return rows[0];
  }

  it('blocks pickup by lifecycle state without creating a duplicate blocked lease', async () => {
    await seedIssue('EI-live-blocked-no-mirror', { kind: 'change', status: 'open', payload: { marker: 'keep' } });

    const blocked = await wi.setWorkItemStateWithAliasInfo('EI-live-blocked-no-mirror', 'blocked', {
      harness: H, by: 'tester',
    });
    expect(blocked.appliedState).toBe('blocked');
    expect(await payloadOf('EI-live-blocked-no-mirror')).toMatchObject({ status: 'blocked', payload: { marker: 'keep' } });
    expect(blocked.workItem?.payload).not.toHaveProperty('_claimHold');
    expect(blocked.workItem?.payload).not.toHaveProperty('held_open_reason');
    expect((await payloadOf('EI-live-blocked-no-mirror'))?.payload).not.toHaveProperty('_claimHold');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'verifier' })).toBeNull();

    await wi.setWorkItemStateWithAliasInfo('EI-live-blocked-no-mirror', 'open', { harness: H, by: 'tester' });
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'verifier' })).toMatchObject({ id: 'EI-live-blocked-no-mirror' });
  });

  it('records one issue blocked transition without using a lease audit as its history', async () => {
    await seedIssue('EI-blocked-history-no-mirror', { kind: 'change', status: 'open' });
    await wi.setWorkItemStateWithAliasInfo('EI-blocked-history-no-mirror', 'blocked', { harness: H, by: 'tester' });
    await wi.setWorkItemStateWithAliasInfo('EI-blocked-history-no-mirror', 'blocked', { harness: H, by: 'tester' });

    await vi.waitFor(async () => {
      const rows = await db.sql<{ actor: string; action: string; details: Record<string, unknown> }[]>`
        SELECT actor, action, details FROM harness_shared.audit_log
         WHERE workspace_id = ${WS} AND subject = 'EI-blocked-history-no-mirror'`;
      expect(rows).toEqual([{
        actor: 'tester', action: 'work_items:state:blocked',
        details: { to: 'blocked', requested: 'blocked', family: 'issue', by: 'tester' },
      }]);
    });
  });

  it('stores claim-hold audit details as JSON objects for park and lease cleanup writers', async () => {
    await seedIssue('EI-audit-json-park');
    await wi.setWorkItemClaimHold('EI-audit-json-park', true, {
      harness: H, parkedBy: 'park-owner', parkedReason: 'Wait for a decision',
      releaseContract: { condition: 'owner decision arrives', owner: 'park-owner', trigger: 'work-item:unblocked:EI-audit-json-park', reachability: 'blocked', evidence: 'fixture decision pending' },
    });
    await wi.recordBulkHoldClearAudit(db.sql, [{ id: 'EI-audit-json-park', workspaceId: WS, formerHolder: 'park-owner' }], {
      actor: 'reconciler', sweepName: 'test-sweep',
    });
    await vi.waitFor(async () => {
      const rows = await db.sql<{ action: string; shape: string }[]>`
        SELECT action, jsonb_typeof(details) AS shape FROM harness_shared.audit_log
         WHERE workspace_id = ${WS} AND subject = 'EI-audit-json-park' ORDER BY action`;
      expect(rows).toEqual([
        { action: 'work_items:claim_hold:clear', shape: 'object' },
        { action: 'work_items:claim_hold:set', shape: 'object' },
      ]);
    });
  });

  it('clears the temporary blocked hold when no durable park exists', async () => {
    await seedIssue('EI-blocked-lease-no-park', {
      kind: 'change', status: 'blocked',
      payload: { _claimHold: true, held_open_by: 'tester', held_open_reason: 'blocked' },
    });
    expect(await payloadOf('EI-blocked-lease-no-park')).toMatchObject({
      status: 'blocked',
      payload: { _claimHold: true, held_open_by: 'tester', held_open_reason: 'blocked' },
    });

    const reopened = await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-no-park', 'open', {
      harness: H,
      by: 'tester',
    });
    const row = await payloadOf('EI-blocked-lease-no-park');

    expect(reopened.workItem?.state).toBe('open');
    expect(reopened.workItem?.payload).not.toHaveProperty('_claimHold');
    expect(row?.status).toBe('open');
    expect(row?.payload).not.toHaveProperty('_claimHold');
    expect(row?.payload).not.toHaveProperty('held_open_by');
    expect(row?.payload).not.toHaveProperty('held_open_reason');
  });

  it('clears only the temporary lease and preserves a coexisting durable park', async () => {
    await seedIssue('EI-blocked-lease-durable-park', {
      kind: 'change', status: 'blocked',
      payload: { _claimHold: true, held_open_by: 'tester', held_open_reason: 'blocked' },
    });
    await wi.setWorkItemClaimHold('EI-blocked-lease-durable-park', true, {
      harness: H,
      parkedBy: 'park-owner',
      parkedReason: 'deliberate retry hold',
      releaseContract: { condition: 'retry authorized', owner: 'park-owner', trigger: 'work-item:unblocked:EI-blocked-lease-durable-park', reachability: 'blocked', evidence: 'fixture retry not authorized' },
    });

    const reopened = await wi.setWorkItemStateWithAliasInfo('EI-blocked-lease-durable-park', 'open', {
      harness: H,
      by: 'tester',
    });
    const row = await payloadOf('EI-blocked-lease-durable-park');

    expect(reopened.workItem?.state).toBe('open');
    expect(reopened.workItem?.payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'park-owner',
      claim_hold_reason: 'deliberate retry hold',
    });
    expect(reopened.workItem?.payload).not.toHaveProperty('held_open_by');
    expect(reopened.workItem?.payload).not.toHaveProperty('held_open_reason');
    expect(row?.status).toBe('open');
    expect(row?.payload).toMatchObject({
      _claimHold: true,
      claim_hold_by: 'park-owner',
      claim_hold_reason: 'deliberate retry hold',
    });
    expect(row?.payload).not.toHaveProperty('held_open_by');
    expect(row?.payload).not.toHaveProperty('held_open_reason');
  });
});
