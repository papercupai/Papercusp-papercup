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

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  // The system-clear follow-up's transport ends (event-wait-settlement-2026-10-20 P-003).
  sendMessage: vi.fn(async () => ({})),
  wakeRecipients: vi.fn(async () => ({})),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/messages')>()),
  sendMessage: h.sendMessage,
}));
vi.mock('../agent-tools/coordination/inbox-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-tools/coordination/inbox-wake')>()),
  wakeRecipients: h.wakeRecipients,
}));

// IMPORT ORDER IS LOAD-BEARING (WI-6554700010019178). The system-clear follow-up module
// reaches `messages` / `inbox-wake` through a LAZY `await import()`. If anything loads
// `messages` before that module, the mock factory's importOriginal() evaluates it for the
// first time through the static cycle messages -> … -> inbox-wake -> … -> auto-clear, and
// Vitest 4 then resolves its lazy imports to the REAL modules (a mocked id already on the
// module's callstack falls through to the original). The holder message is then refused by
// the real disclosure seal and h.sendMessage is never called. `../work-items` reaches
// `messages` first since it imported agent-tools/search/knowledge-sources, so the follow-up
// module is loaded BEFORE it. The guard test below fails loudly if the binding regresses.
const autoClear = await import('../work-item-ref-blocker-auto-clear');
const wi = await import('../work-items');
const {
  sweepWorkItemBlockerDefaults, BLOCKER_DEFAULT_REAPER_ACTOR, defaultBlockerReapDeps,
  MISSED_FIRE_RECOVERY_ACTOR, STRANDED_BLOCKED_REPAIR_ACTOR,
} = await import('./work-item-blocker-reaper');
const { recordKeyFire } = await import('../events/await/store');
const { buildDurableParkReleaseContract } = await import('../durable-park-release-contract');

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
  it('import-order guard: the system-clear follow-up sends and wakes through the MOCKED coordination modules', async () => {
    h.sendMessage.mockClear();
    h.wakeRecipients.mockClear();
    const deps = autoClear.productionBlockerAutoClearFollowUpDeps();
    await deps.send({ workspaceId: WS, to: 'su-import-order-guard', summary: 'guard', body: 'guard', harnessSlug: H });
    await deps.wake({ workspaceId: WS, to: 'su-import-order-guard', summary: 'guard' });
    expect(h.sendMessage, 'the follow-up bound the REAL messages module: see the import-order note at the top').toHaveBeenCalledTimes(1);
    expect(h.wakeRecipients, 'the follow-up bound the REAL inbox-wake module: see the import-order note at the top').toHaveBeenCalledTimes(1);
  });

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

  it('AUTO-BAR-R-4-P-003 + AUTO-BAR-R-5-P-003: a re-check that clears a held feature\'s last blocker returns it to open and wakes its holder', async () => {
    h.sendMessage.mockClear();
    h.wakeRecipients.mockClear();
    const event = ask({ kind: 'event', capability: 'live-dependency', ref: 'work-item:done:WI-p003-recheck',
      decideBy: undefined, defaultAction: undefined, recheckAt: PAST });
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, 'WI-p003-recheck-feature', 'feature', 'held feature', 'blocked', 'su-p003-recheck-holder', ${WS}, 100, 0,
        ${JSON.stringify({ externalBlockers: [event] })}::text::jsonb)`;

    const result = await sweepWorkItemBlockerDefaults({ deps: { ...defaultBlockerReapDeps,
      resolveCondition: async () => ({ verdict: 'reachable', basis: 'fired', authoritative: true,
        evidence: 'current event generation fired', checkedAt: new Date().toISOString() }) } });

    expect(result.rechecked.cleared).toBe(1);
    expect((await rowOf('WI-p003-recheck-feature')).status).toBe('open');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = h.sendMessage.mock.calls[0] as unknown as [
      { ownerId: string; workspaceId: string },
      { to: string[]; summary: string; body: string },
    ];
    expect(identity).toMatchObject({ ownerId: 'system:blocker-auto-clear', workspaceId: WS });
    expect(opts.to).toEqual(['su-p003-recheck-holder']);
    expect(opts.summary).toContain('work-item:done:WI-p003-recheck');
    expect(opts.body).toContain(`clearedBy ${BLOCKER_DEFAULT_REAPER_ACTOR}`);
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p003-recheck-holder'],
      expect.objectContaining({ summary: opts.summary, workspaceId: WS }));
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

/**
 * event-wait-settlement-2026-10-20 P-005 (Design 5) — the re-check sweep's recovery pass
 * (R-9) and stranded-blocked repair (R-10), against the real work-items store, the real
 * fire latch (recordKeyFire) and the real settlement (settleProvingFire).
 */
describe('the re-check sweep repairs missed settlements and stranded items (P-005)', () => {
  beforeAll(async () => {
    // reconcileClearedDependencyBlockedState records its restore here; this suite hand-rolls
    // its schema, so the columns that write names are created to match.
    await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
      id text PRIMARY KEY, ts bigint, actor text, action text, subject text, details jsonb, workspace_id text)`;
  });

  const eventWait = (ref: string, createdAt: string): ExternalBlockerRecord =>
    ask({ kind: 'event', capability: 'live-dependency', ref, decideBy: undefined, defaultAction: undefined,
      defaultIfUnanswered: undefined, createdAt, updatedAt: createdAt });

  async function seedBlockedFeature(id: string, blockers: ExternalBlockerRecord[], over: {
    holder?: string | null; stateChangedAt?: string; payload?: Record<string, unknown>;
  } = {}): Promise<void> {
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts,
       state_changed_at, payload)
      VALUES (${H}, ${id}, 'feature', ${`title ${id}`}, 'blocked', ${over.holder ?? null}, ${WS}, 100, 0,
        ${over.stateChangedAt ?? '2019-12-31T00:00:00.000Z'}::timestamptz,
        ${JSON.stringify({ externalBlockers: blockers, ...over.payload })}::text::jsonb)`;
  }

  it('AUTO-BAR-R-9-P-005: a wait whose proving key fired before settlement ran is settled by the next sweep tick', async () => {
    h.sendMessage.mockClear();
    h.wakeRecipients.mockClear();
    const key = 'release:deployed:p005missed';
    await seedBlockedFeature('WI-p005-missed', [eventWait(key, '2019-12-31T00:00:00.000Z')], { holder: 'su-p005-holder' });
    // The crash: the latch is recorded but the emit never reached settleProvingFire.
    await recordKeyFire({ eventKey: key, firedBy: 'deployer' });
    expect((await rowOf('WI-p005-missed')).blockers[0]).toMatchObject({ status: 'active' });

    const result = await sweepWorkItemBlockerDefaults();

    expect(result.recovered).toEqual({ keys: 1, settled: 1, failed: 0, truncatedByLimit: false });
    const after = await rowOf('WI-p005-missed');
    expect(after.blockers[0]).toMatchObject({ status: 'cleared', clearedBy: MISSED_FIRE_RECOVERY_ACTOR });
    expect(after.status).toBe('open');
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect((h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[] }])[1].to).toEqual(['su-p005-holder']);
    // Settled once: the next tick finds nothing to recover.
    expect((await sweepWorkItemBlockerDefaults()).recovered.keys).toBe(0);
  });

  it('AUTO-BAR-R-9-P-005: a durable park whose proving trigger fired before settlement ran is released by the next sweep tick', async () => {
    const key = 'release:deployed:p005park';
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, 'EI-p005-park', 'change', 'parked', 'open', NULL, ${WS}, 100, 0, NULL)`;
    const releaseContract = await buildDurableParkReleaseContract({ condition: 'the deploy landed', trigger: key }, 'park-owner');
    await wi.setWorkItemClaimHold('EI-p005-park', true, { harness: H, parkedBy: 'park-owner', releaseContract });
    await recordKeyFire({ eventKey: key, firedBy: 'deployer' });
    expect((await rowOf('EI-p005-park')).payload._claimHold).toBe(true);

    const result = await sweepWorkItemBlockerDefaults();

    expect(result.recovered.keys).toBe(1);
    expect(result.recovered.settled).toBe(1);
    const after = await rowOf('EI-p005-park');
    expect(after.payload._claimHold).toBeUndefined();
    expect(after.payload.claim_hold_release).toBeUndefined();
  });

  it('settles nothing when the wait was created after the fire, or when the key proves nothing', async () => {
    const late = 'release:deployed:p005late';
    await recordKeyFire({ eventKey: late, firedBy: 'deployer' });
    await seedBlockedFeature('WI-p005-late', [eventWait(late, FUTURE)]);
    await seedBlockedFeature('WI-p005-broad', [eventWait('git-sync:committed', '2019-12-31T00:00:00.000Z')]);
    await recordKeyFire({ eventKey: 'git-sync:committed', firedBy: 'git-sync' });

    const result = await sweepWorkItemBlockerDefaults();

    expect(result.recovered.keys).toBe(0);
    expect((await rowOf('WI-p005-late')).blockers[0]).toMatchObject({ status: 'active' });
    expect((await rowOf('WI-p005-broad')).blockers[0]).toMatchObject({ status: 'active' });
  });

  it('AUTO-BAR-R-10-P-005: an item left blocked with every blocker cleared returns to open on the next sweep tick', async () => {
    h.sendMessage.mockClear();
    const clearedWait = { ...eventWait('event:done', '2019-12-30T00:00:00.000Z'), status: 'cleared' as const,
      clearedAt: '2020-01-01T00:00:00.000Z', clearedBy: 'su-someone' };
    await seedBlockedFeature('WI-p005-stranded', [clearedWait], { holder: 'su-p005-stranded-holder' });

    const result = await sweepWorkItemBlockerDefaults();

    expect(result.repaired).toEqual({ examined: 1, reopened: 1, skipped: {}, truncatedByLimit: false });
    expect((await rowOf('WI-p005-stranded')).status).toBe('open');
    const audit = await db.sql<Array<{ actor: string }>>`
      SELECT actor FROM harness_shared.audit_log WHERE subject = 'WI-p005-stranded' AND action = 'work_items:state:unblocked'`;
    expect(audit.map((a) => a.actor)).toEqual([STRANDED_BLOCKED_REPAIR_ACTOR]);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const opts = (h.sendMessage.mock.calls[0] as unknown as [unknown, { to: string[]; summary: string }])[1];
    expect(opts.to).toEqual(['su-p005-stranded-holder']);
    expect(opts.summary).toContain('Returned to open: WI-p005-stranded');
    expect((await sweepWorkItemBlockerDefaults()).repaired.examined).toBe(0);
  });

  it('leaves blocked an item re-blocked after its last clear, one with a live dependency, and one durably parked', async () => {
    const clearedWait = { ...eventWait('event:done', '2019-12-30T00:00:00.000Z'), status: 'cleared' as const,
      clearedAt: '2020-01-01T00:00:00.000Z', clearedBy: 'su-someone' };
    await seedBlockedFeature('WI-p005-reblocked', [clearedWait], { stateChangedAt: '2020-02-01T00:00:00.000Z' });
    await seedBlockedFeature('WI-p005-dependent', [clearedWait]);
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, 'WI-p005-prereq', 'feature', 'prerequisite', 'open', ${WS}, 100, 0, NULL)`;
    await db.sql`INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
      VALUES (${WS}, 'feature', ${`${H}#WI-p005-dependent`}, 'feature', ${`${H}#WI-p005-prereq`}, 'blocks', 'tester')`;
    await seedBlockedFeature('WI-p005-parked', [clearedWait],
      { payload: { _claimHold: true, claim_hold_by: 'park-owner', claim_hold_reason: 'waiting on review' } });

    const result = await sweepWorkItemBlockerDefaults();

    expect(result.repaired.reopened).toBe(0);
    expect(result.repaired.skipped).toEqual({ 'reblocked-after-clear': 1, 'live-dependency': 1, reserved: 1 });
    for (const id of ['WI-p005-reblocked', 'WI-p005-dependent', 'WI-p005-parked']) {
      expect((await rowOf(id)).status).toBe('blocked');
    }
  });
});

describe('durable parks on unprovable triggers get a re-check against the real store (WI-6554700010030346)', () => {
  // Blind review #110 G-5: a park keeps its wait in claim_hold_release.trigger, which the
  // unprovable-wait backfill above never reads. This runs the production listing, ledger
  // classification and compare-and-set write (only the escalation transport is spied).
  const legacy = (trigger: string) => ({
    condition: `resume once ${trigger} says so`, owner: 'park-owner', trigger,
    reachability: 'blocked' as const, evidence: 'no producer registration or catalogued resolver was found',
  });
  async function seedPark(id: string, releaseContract: {
    condition: string; owner: string; trigger: string;
    reachability: 'reachable' | 'blocked' | 'unreachable' | 'satisfied'; evidence: string;
  }, status = 'open'): Promise<void> {
    await db.sql`INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${id}, 'change', ${`title ${id}`}, ${status}, NULL, ${WS}, 100, 0, NULL)`;
    await wi.setWorkItemClaimHold(id, true, { harness: H, parkedBy: 'park-owner', parkedReason: 'waiting', releaseContract });
  }

  it('stamps only live unprovable parks, escalates them when due, re-arms a day out, and a re-park drops the date', async () => {
    const { backfillUnprovableParkRecheckDates, sweepDueParkRechecks, defaultDurableParkRecheckDeps, UNPROVABLE_PARK_RECHECK_ACTOR } =
      await import('./durable-park-recheck');
    const { assertHoldRegistered } = await import('../hold-registry');
    await seedPark('EI-park-broad', legacy('coord:inbox-wake:su-park-test'));
    await seedPark('EI-park-freetext', legacy('A new trace is attached to this item.'));
    await seedPark('EI-park-provable',
      await buildDurableParkReleaseContract({ condition: 'the deploy landed', trigger: 'release:deployed:parkrecheck' }, 'park-owner'));
    await seedPark('EI-park-done', legacy('coord:inbox-wake:su-park-test'), 'done');
    await seedPark('EI-park-cleared', legacy('coord:inbox-wake:su-park-test'));
    await wi.setWorkItemClaimHold('EI-park-cleared', false, { harness: H });
    const escalate = vi.fn(async (_park: { id: string }) => undefined);
    const deps = { ...defaultDurableParkRecheckDeps, escalate };
    const now = new Date();

    const stamped = await backfillUnprovableParkRecheckDates({ now, deps });

    expect(stamped).toMatchObject({ parks: 3, unprovable: 2, stamped: 2, provable: 1, skipped: {}, truncatedByLimit: false });
    expect(stamped.byReason).toEqual({ broad: 1, uncatalogued: 1 });
    const broad = await rowOf('EI-park-broad');
    expect(broad.payload).toMatchObject({ _claimHold: true, claim_hold_by: 'park-owner', claim_hold_reason: 'waiting' });
    expect(broad.payload.claim_hold_release).toMatchObject({
      ...legacy('coord:inbox-wake:su-park-test'),
      recheckAt: now.toISOString(), recheckSource: UNPROVABLE_PARK_RECHECK_ACTOR, recheckReason: 'broad',
    });
    expect((await rowOf('EI-park-provable')).payload.claim_hold_release).not.toHaveProperty('recheckAt');
    expect((await rowOf('EI-park-done')).payload.claim_hold_release).not.toHaveProperty('recheckAt');
    // Idempotent: nothing left to stamp.
    expect((await backfillUnprovableParkRecheckDates({ now, deps })).stamped).toBe(0);

    const swept = await sweepDueParkRechecks({ now, deps });

    expect(swept).toEqual({ examined: 2, escalated: 2, provable: 0, skipped: {}, truncatedByLimit: false });
    expect(escalate.mock.calls.map(([park]) => park.id).sort()).toEqual(['EI-park-broad', 'EI-park-freetext']);
    const rearmed = new Date(now.getTime() + assertHoldRegistered('park', 'park').recheckSec * 1000).toISOString();
    expect((await rowOf('EI-park-broad')).payload.claim_hold_release).toMatchObject({
      recheckAt: rearmed, recheckDisposition: 'escalated', recheckedAt: now.toISOString(), reachability: 'blocked',
    });
    expect((await sweepDueParkRechecks({ now, deps })).examined).toBe(0);

    // The compare-and-set refuses a contract that moved underneath it.
    expect(await deps.writeRelease('EI-park-broad', H, { stale: true }, legacy('coord:inbox-wake:su-park-test'))).toBe(false);
    // A re-park replaces the contract, so the re-check date goes with the old one.
    await wi.setWorkItemClaimHold('EI-park-broad', true, { harness: H, parkedBy: 'park-owner',
      releaseContract: await buildDurableParkReleaseContract({ condition: 'the deploy landed', trigger: 'release:deployed:parkrecheck' }, 'park-owner') });
    expect((await rowOf('EI-park-broad')).payload.claim_hold_release).not.toHaveProperty('recheckAt');
  });
});
