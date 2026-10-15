/**
 * work-item-blocker-reaper.integration.test.ts — the REAL-PG half of WI-10005010's
 * blocker-default reaper (WI-10005093).
 *
 * The unit file (work-item-blocker-reaper.test.ts) drives `sweepWorkItemBlockerDefaults`
 * against fakes, so `defaultBlockerReapDeps.restoreLifecycle` — which hand-mirrors
 * `work_items:set_blocker`'s lifecycle-restore branches — was never exercised against the
 * real work-items store. This file does: it seeds an issue-family item the way
 * `set_blocker` leaves it (typed human blocker in `payload.externalBlockers`, status
 * `needs-human`), runs the production sweep with its DEFAULT deps, and asserts the
 * lifecycle that ends up in Postgres — and that the apply is exactly-once.
 *
 * Run:
 *   npm run test:file -- packages/operator-core/lib/attention/work-item-blocker-reaper.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import type { ExternalBlockerRecord } from '../external-blockers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('../work-items');
const { sweepWorkItemBlockerDefaults, BLOCKER_DEFAULT_REAPER_ACTOR, defaultBlockerReapDeps } = await import('./work-item-blocker-reaper');

const H = 'papercup';
const WS = 'default';
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
let db: FreshPgDb;

function ask(over: Partial<ExternalBlockerRecord> = {}): ExternalBlockerRecord {
  return {
    kind: 'human',
    capability: 'product-decision',
    capabilitySource: 'explicit',
    ref: 'ask-1',
    summary: 'owner decision needed',
    // readStructuredOwnerAsk (the needs-human lifecycle gate) requires a non-empty nextVerb.
    nextVerb: 'work_items:set_blocker { op: "clear" }',
    status: 'active',
    createdAt: '2019-12-31T00:00:00.000Z',
    createdBy: 'su-test',
    updatedAt: '2019-12-31T00:00:00.000Z',
    defaultIfUnanswered: 'proceed with option A',
    decideBy: PAST,
    defaultAction: 'release_to_agents',
    ...over,
  };
}

/**
 * Seed an issue-family item the way `work_items:set_blocker` leaves one parked on a strict
 * human ask: the typed blocker lands in the payload FIRST (the lifecycle seam refuses a
 * `needs-human` transition without one), then the item moves to `needs-human`.
 */
async function seedParkedIssue(id: string, blockers: ExternalBlockerRecord[]): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, 'change', ${`title ${id}`}, 'open', NULL, ${WS}, 100, 0, NULL)`;
  await wi.mergeWorkItemPayload(id, { externalBlockers: blockers }, { harness: H });
  await wi.setWorkItemStateWithAliasInfo(id, 'needs-human', { harness: H, by: 'su-test' });
}

async function rowOf(id: string) {
  const rows = await db.sql<{ status: string; payload: Record<string, unknown> | null }[]>`
    SELECT status, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  const row = rows[0];
  const blockers = (row?.payload?.externalBlockers ?? []) as ExternalBlockerRecord[];
  return { status: row?.status, payload: row?.payload ?? {}, blockers };
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-blocker-reaper');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  await ensureCoordCapabilityTables(db.sql);
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'work-item-blocker-reaper.integration.test.ts',
  });
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('sweepWorkItemBlockerDefaults against the real work-items store', () => {
  it('atomically refuses stale blocker history without losing unrelated payload fields', async () => {
    const original = ask({ defaultAction: undefined, decideBy: undefined, recheckAt: PAST });
    await seedParkedIssue('EI-recheck-cas', [original]);
    await wi.mergeWorkItemPayload('EI-recheck-cas', { sibling: 'retained' }, { harness: H });
    const first = await rowOf('EI-recheck-cas');
    const added = ask({ ref: 'ask-2', defaultAction: undefined, decideBy: undefined });
    await wi.mergeWorkItemPayload('EI-recheck-cas', { externalBlockers: [original, added] }, { harness: H });
    expect(await defaultBlockerReapDeps.writeBlockers('EI-recheck-cas', H, [], first.blockers)).toBe(false);
    const fresh = await rowOf('EI-recheck-cas');
    expect(fresh.blockers).toHaveLength(2);
    expect(await defaultBlockerReapDeps.writeBlockers('EI-recheck-cas', H, fresh.blockers, fresh.blockers)).toBe(true);
    expect((await rowOf('EI-recheck-cas')).payload.sibling).toBe('retained');
  });

  it('finds a due external event and restores its issue only after fired-condition proof', async () => {
    const event = ask({ kind: 'event', capability: 'live-dependency', ref: 'event:ready',
      decideBy: undefined, defaultAction: undefined, recheckAt: PAST });
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, 'EI-recheck-event', 'bug', 'event wait', 'blocked', ${WS}, 100, 0,
        ${JSON.stringify({ externalBlockers: [event], sibling: 'retained' })}::text::jsonb)`;
    expect((await defaultBlockerReapDeps.listCandidates(20)).map((r) => r.id)).toContain('EI-recheck-event');
    const result = await sweepWorkItemBlockerDefaults({ deps: { ...defaultBlockerReapDeps,
      resolveCondition: async () => ({ verdict: 'reachable', basis: 'fired', authoritative: true,
        evidence: 'current event generation fired', checkedAt: new Date().toISOString() }) } });
    expect(result.rechecked.cleared).toBe(1);
    const after = await rowOf('EI-recheck-event');
    expect(after.status).toBe('open');
    expect(after.payload.sibling).toBe('retained');
    expect(after.blockers[0]).toMatchObject({ status: 'cleared', recheckDisposition: 'cleared' });
    expect((await sweepWorkItemBlockerDefaults()).rechecked.cleared).toBe(0);
  });

  it('does not select settled legacy features even when they retain a due owner blocker', async () => {
    // ExternalBlockerRecord is an interface (no index signature), so it is not structurally a
    // postgres JSONValue; the cast mirrors the repo-wide sql.json idiom for typed records.
    const payload = db.sql.json({ externalBlockers: [ask()] } as unknown as postgres.JSONValue);
    for (const status of ['open', 'passed', 'deprecated']) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts, payload)
        VALUES (${H}, ${`F-${status}`}, 'feature', ${status}, ${status}, ${WS}, 100, 0, ${payload}::jsonb)`;
    }
    expect((await rowOf('F-open')).blockers).toMatchObject([{ status: 'active', decideBy: PAST }]);
    const candidates = await defaultBlockerReapDeps.listCandidates(20);
    expect(candidates.map(candidate => candidate.id)).toEqual(['F-open']);
    expect((await rowOf('F-passed')).blockers[0]?.defaultAppliedAt).toBeUndefined();
    expect((await rowOf('F-deprecated')).blockers[0]?.defaultAppliedAt).toBeUndefined();
  });

  it('release_to_agents: a past-decideBy needs-human issue is reopened, claimable, and fenced exactly once', async () => {
    await seedParkedIssue('EI-reap-release', [ask()]);
    // Precondition: the fixture really parks it out of the claimable pool.
    expect((await rowOf('EI-reap-release')).status).toBe('needs-human');
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-pre' })).toBeNull();

    const first = await sweepWorkItemBlockerDefaults();
    expect(first.applied).toEqual({ stay_parked: 0, release_to_agents: 1 });
    expect(first.skipped).toEqual({});

    const after = await rowOf('EI-reap-release');
    expect(after.status).toBe('open');
    expect(after.payload).not.toHaveProperty('_claimHold');
    expect(after.blockers.filter((b) => b.status === 'active')).toHaveLength(0);
    expect(after.blockers).toHaveLength(1);
    expect(after.blockers[0]).toMatchObject({
      ref: 'ask-1',
      status: 'cleared',
      clearedBy: BLOCKER_DEFAULT_REAPER_ACTOR,
      defaultAppliedAction: 'release_to_agents',
    });
    expect(after.blockers[0]?.defaultAppliedAt).toBeTruthy();

    // Exactly once: the applied blocker is no longer a candidate, so a second sweep is a no-op
    // and does not touch the (now claimable) item.
    const second = await sweepWorkItemBlockerDefaults();
    expect(second.examined).toBe(0);
    expect(second.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });
    expect((await rowOf('EI-reap-release')).blockers).toEqual(after.blockers);

    // And it is genuinely back in the pool.
    // Back in the pool: claimable by id. (Opportunistic self-select deliberately skips an
    // issue-family item inside its own release cooldown — EI-19306610776344030 — so a
    // just-released item is NOT expected from claimNextWorkItem; by-id claim is the
    // unparked-ness oracle that has no cooldown.)
    expect(await wi.claimWorkItem('EI-reap-release', 'bee-post', { harness: H })).toMatchObject({
      id: 'EI-reap-release',
      assignee: 'bee-post',
    });
  });

  it('release_to_agents keeps the item parked when another strict human ask is still active', async () => {
    await seedParkedIssue('EI-reap-remaining', [
      ask({ ref: 'ask-due' }),
      ask({ ref: 'ask-open', decideBy: FUTURE, defaultAction: 'release_to_agents' }),
    ]);

    const result = await sweepWorkItemBlockerDefaults();
    expect(result.applied.release_to_agents).toBe(1);

    const after = await rowOf('EI-reap-remaining');
    expect(after.status).toBe('needs-human');
    const byRef = Object.fromEntries(after.blockers.map((b) => [b.ref, b]));
    expect(byRef['ask-due']).toMatchObject({ status: 'cleared', defaultAppliedAction: 'release_to_agents' });
    expect(byRef['ask-open']).toMatchObject({ status: 'active' });
    expect(byRef['ask-open']?.defaultAppliedAt).toBeUndefined();
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee' })).toBeNull();
  });

  it('stay_parked: records the application once, leaves the ask active and the item parked', async () => {
    await seedParkedIssue('EI-reap-stay', [ask({ defaultAction: 'stay_parked' })]);

    const first = await sweepWorkItemBlockerDefaults();
    expect(first.applied).toEqual({ stay_parked: 1, release_to_agents: 0 });

    const after = await rowOf('EI-reap-stay');
    expect(after.status).toBe('needs-human');
    expect(after.blockers[0]).toMatchObject({ status: 'active', defaultAppliedAction: 'stay_parked' });
    expect(after.blockers[0]?.defaultAppliedAt).toBeTruthy();
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee' })).toBeNull();

    const second = await sweepWorkItemBlockerDefaults();
    expect(second.examined).toBe(0);
    expect(second.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });
    expect((await rowOf('EI-reap-stay')).blockers).toEqual(after.blockers);
  });

  it('does nothing before decideBy', async () => {
    await seedParkedIssue('EI-reap-early', [ask({ decideBy: FUTURE })]);

    const result = await sweepWorkItemBlockerDefaults();
    expect(result.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });

    const after = await rowOf('EI-reap-early');
    expect(after.status).toBe('needs-human');
    expect(after.blockers[0]).toMatchObject({ status: 'active' });
    expect(after.blockers[0]?.defaultAppliedAt).toBeUndefined();
  });

  it('rollout is inert: a past-decideBy ask with no TYPED defaultAction is never a candidate', async () => {
    await seedParkedIssue('EI-reap-untyped', [ask({ defaultAction: undefined })]);

    const result = await sweepWorkItemBlockerDefaults();
    expect(result.examined).toBe(0);
    expect(result.applied).toEqual({ stay_parked: 0, release_to_agents: 0 });

    const after = await rowOf('EI-reap-untyped');
    expect(after.status).toBe('needs-human');
    expect(after.blockers[0]).toMatchObject({ status: 'active' });
    expect(after.blockers[0]?.defaultAppliedAt).toBeUndefined();
  });
});
