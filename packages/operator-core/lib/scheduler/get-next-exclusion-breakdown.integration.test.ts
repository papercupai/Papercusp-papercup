/**
 * EI-13965 (DB-backed) — `aggregateIssueClaimExclusions`, the scoped-miss AGGREGATE
 * floor-exclusion breakdown for the BROAD-spec case `explainIssueClaimFloors` cannot cover
 * (no named ids to attribute per-row).
 *
 * Live incident (2026-07-17, curation-signals fleet): a member drained its lane and reported
 * "todo items visible in both bound plans but none match the spec" — the leader took ~6
 * queries to discover the pool was NOT empty, just stranded behind three DIFFERENT floors
 * (claim-hold, taken-by-outside-agents, plan-item-lane-guard release). A member with a broad
 * spec (kind/plan-scoped, no `id in [...]`) has no named ids for `explainIssueClaimFloors` to
 * attribute, so it got nothing actionable.
 *
 * The unit/integration siblings for `explainIssueClaimFloors` (get-next-miss-diagnosis.*)
 * pin the NAMED-id case; THIS test owns what only a real database can prove for the
 * BROAD case: that the one aggregate query actually counts each floor bucket correctly
 * against real rows, using the SAME exported exclusion-SQL fragments the claim path ANDs in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { FilterNode } from './claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const {
  aggregateIssueClaimExclusions,
  listIssueClaimableRows,
  readIssueClaimability,
  sampleIssueClaimExclusions,
  readClaimSpecDelta,
  issueClaimCandidateSubquery,
  compileFilter,
  ALL_ISSUE_CLAIM_FLOORS_PASS,
} = await import('./get-next');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** Seed an ISSUE-family row (bug/change/task) with an arbitrary payload + the broader
 *  taken/released stamps `aggregateIssueClaimExclusions` reads (beyond what
 *  get-next-miss-diagnosis.integration.test.ts's narrower seedIssue needs). */
async function seedIssue(
  id: string,
  payload: Record<string, unknown> | null,
  opts: {
    status?: string;
    takenBy?: string;
    lastReleasedBy?: string;
    lastReleasedAgoSec?: number;
    /** WI-5939: how long ago the row was FILED. Default 0 = the epoch, i.e. far outside any
     *  filing-grace window — so every pre-existing case here is untouched by that floor. */
    createdAgoSec?: number;
    origin?: string;
  } = {},
) {
  const status = opts.status ?? 'open';
  const createdTs = opts.createdAgoSec === undefined ? 0 : Date.now() - opts.createdAgoSec * 1000;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id, origin,
       created_ts, updated_ts, title, payload, last_released_by, last_released_at)
    VALUES (${H}, ${id}, 'change', ${status}, ${opts.takenBy ?? null}, ${WS}, ${opts.origin ?? 'local'}, ${createdTs}, 0, ${'t ' + id},
            ${payload ? db.sql.json(payload as postgres.JSONValue) : null}, ${opts.lastReleasedBy ?? null},
            ${
              opts.lastReleasedAgoSec !== undefined
                ? db.sql`now() - make_interval(secs => ${opts.lastReleasedAgoSec})`
                : null
            })`;
}

/** Seed a `blocks` edge: `blockerId` (an OPEN issue) blocks `blockedId`. Matches the bare
 *  `d.blocked_ref = wi.feature_id` / `bi.issue_id = d.blocker_ref` shape
 *  `aggregateIssueClaimExclusions`'s inline blocked-dep subquery reads. */
async function seedBlocks(blockedId: string, blockerId: string) {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, 'issue', ${blockedId}, 'issue', ${blockerId}, 'blocks')`;
}

async function seedPlan(slug: string, status: 'active' | 'paused') {
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status)
    VALUES (${WS}, ${H}, ${slug}, ${status})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('get-next-exclusion-breakdown');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items
         ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup?.();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
});

describe('EI-13965 — aggregateIssueClaimExclusions counts each floor bucket for a broad (no-named-ids) spec', () => {
  it('reproduces the incident: a stranded pool broken down by claim-hold, taken, plan-lane, and blocked-dep', async () => {
    await seedPlan('live-plan', 'active');

    // The control: a clean, untaken, unfloored row — must be admissible (matched, excluded
    // under nothing). If this doesn't hold the rest of the assertions measure the wrong thing.
    await seedIssue('WI-9401', null);

    // The three floors from the live incident:
    await seedIssue('WI-9402', { _claimHold: true, held_open_by: 'su-other', held_open_reason: 'blocked' });
    await seedIssue('WI-9403', {}, { takenBy: 'su-outside-agent' });
    await seedIssue('WI-9404', { plan_item: { plan_slug: 'live-plan', item_id: 'P-001' } });

    // Every-day floors the aggregate must also carry correctly. Migration 864
    // retired the ambiguous legacy `needsHuman` floor, so WI-9405 is now an
    // admitted compatibility row rather than an exclusion bucket.
    await seedIssue('WI-9405', { needsHuman: true });
    await seedIssue('WI-9411', { needsOwnerAction: true });
    await seedIssue('WI-9406', { lane: 'observation' });
    await seedIssue('WI-9407', {
      externalBlockers: [{ kind: 'event', ref: 'deploy:green', status: 'active', createdAt: '', updatedAt: '' }],
    });
    // A blocked-dep pair: WI-9409 is blocked by the still-open WI-9408.
    await seedIssue('WI-9408', null);
    await seedIssue('WI-9409', null);
    await seedBlocks('WI-9409', 'WI-9408');

    // Out of scope entirely — a different status must not enter `matched`.
    await seedIssue('WI-9410', null, { status: 'resolved' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });

    // The canonical agent-work predicate scopes the population before claim floors:
    // WI-9406 (observation) and WI-9411 (owner action) are outside it, as is the
    // resolved WI-9410. The other eight rows remain, including the compatibility
    // WI-9405 and the unfloored blocker WI-9408.
    expect(out.matchedByFilter).toBe(8);
    expect(out.claimable).toBe(3); // WI-9401, WI-9405, WI-9408
    expect(out.excluded).toMatchObject({
      taken: 1, // WI-9403
      claimHold: 1, // WI-9402
      needsOwnerAction: 0, // WI-9411 is outside the agent-work population
      observationLane: 0, // WI-9406 is outside the agent-work population
      externalBlocker: 1, // WI-9407
      planLaneReserved: 1, // WI-9404
      blockedDep: 1, // WI-9409 (blocked by open WI-9408)
    });
  });

  it('distinguishes "pool empty" (spec itself matches nothing) from "pool stranded" (floors)', async () => {
    await seedIssue('WI-9501', null);
    await seedIssue('WI-9502', { _claimHold: true });

    // A spec that matches nothing at all — the ACTUAL problem is the filter, not a floor.
    const noMatch = await aggregateIssueClaimExclusions(
      { field: 'title', op: 'glob', value: '*this-matches-nothing-seeded*' },
      { harness: H },
    );
    expect(noMatch.matchedByFilter).toBe(0);
    expect(noMatch.excluded).toMatchObject({ taken: 0, claimHold: 0 });

    // The unrestricted case over the same rows: the pool is NOT empty, one row is floored.
    const broad = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(broad.matchedByFilter).toBe(2);
    expect(broad.excluded.claimHold).toBe(1);
  });

  it('applies the release-cooldown floor only to the assignee that released it, within the window', async () => {
    // Released by a DIFFERENT assignee than the one asking — must NOT count as cooldown for us.
    await seedIssue('WI-9601', {}, { lastReleasedBy: 'su-someone-else', lastReleasedAgoSec: 5 });
    // Released by US, recently — DOES count.
    await seedIssue('WI-9602', {}, { lastReleasedBy: 'su-asking', lastReleasedAgoSec: 5 });
    // Released by US, long enough ago to clear the (default 300s) cooldown window.
    await seedIssue('WI-9603', {}, { lastReleasedBy: 'su-asking', lastReleasedAgoSec: 10_000 });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'su-asking' });
    expect(out.matchedByFilter).toBe(3);
    expect(out.excluded.cooldown).toBe(1);
  });

  // WI-5939 — filing IS publishing. A row filed moments ago is held back from every agent
  // EXCEPT its filer, and (the item's own acceptance) that exclusion reports under the
  // EXISTING `cooldown` bucket rather than a new parallel one. This is the PREVIEW half of
  // the floor; claim-issues-claimable.integration.test.ts pins the real claim door, and the
  // two share one fragment (issueCooldownExclusionSql) precisely so they cannot drift.
  it('applies the filing-grace floor to a PEER but never to the filer, under the cooldown bucket', async () => {
    // Filed seconds ago by someone else — graced FOR US.
    await seedIssue('WI-9611', { _ei: { created_by: 'su-the-filer' } }, { createdAgoSec: 5 });
    // Filed seconds ago by US — the filer claims their own filing instantly.
    await seedIssue('WI-9612', { _ei: { created_by: 'su-asking' } }, { createdAgoSec: 5 });
    // Filed by someone else, but long enough ago that the window has cleared.
    await seedIssue('WI-9613', { _ei: { created_by: 'su-the-filer' } }, { createdAgoSec: 10_000 });
    // Fresh, but NO filer recorded — fail-OPEN: an unknown filer never gates the row.
    await seedIssue('WI-9614', {}, { createdAgoSec: 5 });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'su-asking' });
    expect(out.matchedByFilter).toBe(4);
    expect(out.excluded.cooldown).toBe(1);
    expect(out.claimable).toBe(3);
  });

  it('an item taken by someone else counts ONLY under `taken`, never double-counted under another floor', async () => {
    // Eligible agent work that is taken AND would otherwise be claim-held /
    // externally blocked. Owner-action rows cannot exercise this short-circuit:
    // the canonical work predicate excludes them before any bucket is counted.
    await seedIssue(
      'WI-9701',
      {
        _claimHold: true,
        externalBlockers: [{ kind: 'event', ref: 'deploy:green', status: 'active', createdAt: '', updatedAt: '' }],
      },
      { takenBy: 'su-outside' },
    );

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(out.matchedByFilter).toBe(1);
    expect(out.excluded).toMatchObject({
      taken: 1,
      claimHold: 0,
      needsOwnerAction: 0,
      externalBlocker: 0,
    });
  });
});

describe('EI-16028 — aggregateIssueClaimExclusions reports affinity path coverage over claimable survivors', () => {
  it('counts only post-floor claimable rows and warns when fewer than half carry payload.paths', async () => {
    // These five rows survive every claim floor. Only the two non-empty arrays are
    // affinity inputs; an empty array, a scalar, and a null payload must not count.
    await seedIssue('WI-AFF-1', { paths: ['packages/operator-core/lib/scheduler/get-next.ts'] });
    await seedIssue('WI-AFF-2', { paths: [] });
    await seedIssue('WI-AFF-3', { paths: ['packages/operator-core/lib/agent-tools/work_items/claimable.ts'] });
    await seedIssue('WI-AFF-4', { paths: 'not-an-array' });
    await seedIssue('WI-AFF-5', null);
    // A path-bearing row behind a floor must not inflate the coverage numerator.
    await seedIssue('WI-AFF-6', { paths: ['ignored/because-taken.ts'] }, { takenBy: 'su-outside' });

    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });

    expect(out.matchedByFilter).toBe(6);
    expect(out.claimable).toBe(5);
    expect(out.affinityCoverage).toEqual({
      denominator: 5,
      nonEmptyPaths: 2,
      floor: 0.5,
      belowFloor: true,
    });
  });

  it('treats exact 50% coverage as healthy and an empty claimable set as not below floor', async () => {
    await seedIssue('WI-AFF-7', { paths: ['one.ts'] });
    await seedIssue('WI-AFF-8', { paths: ['two.ts'] });
    await seedIssue('WI-AFF-9', { paths: [] });
    await seedIssue('WI-AFF-10', {});

    const exactFloor = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(exactFloor.affinityCoverage).toEqual({
      denominator: 4,
      nonEmptyPaths: 2,
      floor: 0.5,
      belowFloor: false,
    });

    await seedIssue('WI-AFF-11', { paths: ['not-claimable.ts'] }, { takenBy: 'su-outside' });
    const stillExactFloor = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(stillExactFloor.affinityCoverage).toEqual(exactFloor.affinityCoverage);
  });

  it('does not warn for a zero-denominator lane even when excluded rows carry paths', async () => {
    await seedIssue('WI-AFF-12', { paths: ['taken.ts'] }, { takenBy: 'su-outside' });
    const out = await aggregateIssueClaimExclusions(undefined, { harness: H });

    expect(out.claimable).toBe(0);
    expect(out.affinityCoverage).toEqual({
      denominator: 0,
      nonEmptyPaths: 0,
      floor: 0.5,
      belowFloor: false,
    });
  });
});

/**
 * WI-6673 — the claimable ROW projection must read severity from where it actually lives.
 *
 * Severity on `harness_shared.work_items` sits at `payload._ei.severity` (the migration-374
 * fold), NOT top level. The projection used to read the top-level key, which matched 1 of
 * 13,731 open issue-family rows — so every claimable row came back `severity: null`,
 * including genuine criticals, and a fleet leader reading the tool concluded severity was
 * simply not tracked on claimable work.
 *
 * This is the shape a unit test cannot catch and a quiescent read cannot either: the query
 * was VALID, returned the right ROWS in the right ORDER, and reported a well-formed `null`
 * for a field that had a value. Only a DB-backed assertion that a severity-BEARING row
 * projects its severity can fail when this regresses — which is why it lives here and not
 * beside the pure folds in admitted-composition.test.ts.
 */
describe('WI-6673 — listIssueClaimableRows projects severity from payload._ei, not top level', () => {
  it('projects the _ei severity for a row whose severity lives under the migration-374 fold', async () => {
    await seedIssue('WI-SEV-1', { _ei: { severity: 'critical' } });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    // The assertion that matters: NOT null. A regression here reports a well-formed
    // `severity: null` for a genuine critical — success-shaped, and wrong.
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-1', severity: 'critical', origin: 'local' });
  });

  it('still reads a legacy TOP-LEVEL severity for rows that predate the fold', async () => {
    // The COALESCE fallback: pre-fold stragglers must not regress to null while we fix the
    // common case.
    await seedIssue('WI-SEV-2', { severity: 'major' });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-2', severity: 'major' });
  });

  it('prefers the _ei value when BOTH accessors are present (the fold is authoritative)', async () => {
    // A row carrying both must not be decided by accessor order changing underneath us.
    await seedIssue('WI-SEV-3', { severity: 'nit', _ei: { severity: 'critical' } });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-3', severity: 'critical' });
  });

  it('reports null only when the row genuinely carries no severity anywhere', async () => {
    // The honest null — pinned so "everything is null" and "this one has none" stay
    // distinguishable.
    await seedIssue('WI-SEV-4', { someOtherField: true });

    const rows = await listIssueClaimableRows(undefined, { harness: H }, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'WI-SEV-4', severity: null });
  });
});

/**
 * EI-18802055183255275 — DB-backed proof that `readIssueClaimability`'s materialize-once
 * temp-table path (introduced to stop redundant serial full scans of the candidate set —
 * see get-next.ts's `candidateFromSource`) returns IDENTICAL results to calling
 * `aggregateIssueClaimExclusions` / `listIssueClaimableRows` directly (the un-materialized,
 * per-caller-recomputed default path every OTHER test in this file already exercises against
 * this same real database). The mocked-pg unit tests in claimability-snapshot.test.ts pin the
 * TRANSACTION SHAPE (query counts) but stub every query to return zero rows, so they cannot
 * catch a real defect in the temp-table's column projection/typing against live Postgres —
 * only a real database can.
 */
describe('EI-18802055183255275 — readIssueClaimability (materialized temp-table path) agrees with the direct (unmaterialized) reads', () => {
  it('cancels a work_items lock wait at its transaction-local statement timeout (EI-266693)', async () => {
    const holder = await db.sql.reserve();
    let releasePromise: Promise<void> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      releasePromise ??= holder`ROLLBACK`.then(() => undefined);
      return releasePromise;
    };

    try {
      await holder`BEGIN`;
      await holder`LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE`;

      const timeoutMs = 300;
      const startedAt = performance.now();
      // Bound the failure case too: if statement_timeout stops applying, releasing the lock
      // lets the query finish and the SQLSTATE assertion fails instead of hanging the suite.
      releaseTimer = setTimeout(() => { void release(); }, 1_600);
      let readError: unknown;
      try {
        await readIssueClaimability(undefined, { harness: H, client: db.sql }, {
          limit: 1,
          breakdownOnly: true,
          statementTimeoutMs: timeoutMs,
        });
      } catch (error) {
        readError = error;
      }
      const elapsedMs = performance.now() - startedAt;

      expect(readError).toMatchObject({ code: '57014' });
      expect(elapsedMs).toBeGreaterThanOrEqual(100);
      expect(elapsedMs).toBeLessThan(1_300);
    } finally {
      if (releaseTimer) clearTimeout(releaseTimer);
      await release();
      holder.release();
    }
  });

  it('breakdown + rows + admitted composition from readIssueClaimability match the standalone calls, for a floor-stranded pool', async () => {
    await seedPlan('rc-plan', 'active');
    await seedIssue('WI-RC-1', null); // clean, claimable
    await seedIssue('WI-RC-2', { _claimHold: true }); // claim-hold floored
    await seedIssue('WI-RC-3', {}, { takenBy: 'su-outside' }); // taken
    await seedIssue('WI-RC-4', { _ei: { severity: 'critical' } }); // claimable, carries severity

    const direct = await aggregateIssueClaimExclusions(undefined, { harness: H });
    const directRows = await listIssueClaimableRows(undefined, { harness: H }, 20);

    const viaSnapshot = await readIssueClaimability(undefined, { harness: H }, { limit: 20 });

    expect(viaSnapshot.breakdown).toEqual(direct);
    // Row order is spec-rank-determined and deterministic for this fixed set — compare
    // directly rather than as a set, so an ordering regression in the materialized path
    // (e.g. a lost ORDER BY) would also be caught.
    expect(viaSnapshot.rows).toEqual(directRows);
    expect(viaSnapshot.rows.find((r) => r.id === 'WI-RC-4')).toMatchObject({ severity: 'critical' });
    expect(viaSnapshot.breakdown.matchedByFilter).toBe(4);
    expect(viaSnapshot.breakdown.claimable).toBe(2); // WI-RC-1, WI-RC-4
  });

  it('breakdownOnly:true still returns the SAME admitted composition as the unconditional full read (WI-6673 x EI-18802055183255275)', async () => {
    await seedIssue('WI-RC-10', { _ei: { severity: 'minor' } });
    await seedIssue('WI-RC-11', { _ei: { severity: 'major' } });

    const full = await readIssueClaimability(undefined, { harness: H }, { limit: 20 });
    const breakdownOnly = await readIssueClaimability(undefined, { harness: H }, { limit: 20, breakdownOnly: true });

    expect(breakdownOnly.rows).toEqual([]);
    expect(breakdownOnly.breakdown).toEqual(full.breakdown);
    expect(breakdownOnly.admitted).toEqual(full.admitted);
    expect(breakdownOnly.admitted.total).toBe(2);
  });

  it('pushes a filter into the materialized candidate population without changing the filtered verdict', async () => {
    await seedIssue('WI-RC-FILTER-IN', { _ei: { severity: 'critical' } });
    await seedIssue('WI-RC-FILTER-OUT', { _ei: { severity: 'minor' } }, { takenBy: 'su-outside' });

    const filter: FilterNode = { field: 'severity', op: '=', value: 'critical' };
    const direct = await aggregateIssueClaimExclusions(filter, { harness: H });
    const directRows = await listIssueClaimableRows(filter, { harness: H }, 20);
    const viaSnapshot = await readIssueClaimability(filter, { harness: H }, { limit: 20 });

    // The filtered-out row is taken on purpose: the optimized snapshot must retain the
    // exact direct count/list semantics for the selected row while excluding it before the
    // floor-decorated candidate set is materialized.
    expect(viaSnapshot.breakdown).toEqual(direct);
    expect(viaSnapshot.rows).toEqual(directRows);
    expect(viaSnapshot.breakdown).toMatchObject({ matchedByFilter: 1, claimable: 1 });
    expect(viaSnapshot.rows).toMatchObject([{ id: 'WI-RC-FILTER-IN', severity: 'critical' }]);
  });

  it('omits the retired legacy-needs-human bucket from the materialized snapshot', async () => {
    await seedIssue('WI-RC-20', { needsHuman: true });
    await seedIssue('WI-RC-21', null);

    const out = await readIssueClaimability(undefined, { harness: H }, { limit: 20, sampleLimit: 5 });
    expect(out.breakdown.excluded).not.toHaveProperty('legacyNeedsHuman');
    expect(out.sample).not.toHaveProperty('legacyNeedsHuman');
  });

  // bug-queue-legitimacy D-007/D-008: queueControl splits revision-requested spec rows into an
  // exact partition, so a census can count "claimable to validate" from revisionKind rather than
  // from status alone (D-007's correction: status alone overstated the validation reach ~11x).
  it('partitions revision-requested rows into reproduction, content and legacy', async () => {
    const review = (submittedBy: string, revisionKind?: string) => ({
      agentReview: {
        status: 'revision-requested',
        submittedBy,
        ledgerIdeaId: `idea-${submittedBy}`,
        round: 1,
        ...(revisionKind ? { revisionKind } : {}),
      },
    });
    await seedIssue('WI-QC-REV-REPRO', review('su-author', 'reproduction'));
    await seedIssue('WI-QC-REV-CONTENT', review('su-author', 'content'));
    // Pre-D-006 revisions carry no revisionKind and are content revisions.
    await seedIssue('WI-QC-REV-PRE-D006', review('su-author'));
    await seedIssue('WI-QC-REV-LEGACY', review('system:legacy-agent-review'));

    const out = await readIssueClaimability(undefined, { harness: H }, {
      limit: 20,
      sampleLimit: 5,
      breakdownOnly: true,
    });

    const qc = out.breakdown.queueControl;
    expect(qc).toMatchObject({
      revisionRequestedAgentReview: 4,
      revisionReproductionValidation: 1,
      revisionContentAdoptionCandidates: 2,
      revisionLegacyException: 1,
    });
    expect(qc.revisionReproductionValidation + qc.revisionContentAdoptionCandidates + qc.revisionLegacyException)
      .toBe(qc.revisionRequestedAgentReview);
  });

  it('routes only pending peer reviews from the queue-control sample (EI-25275046747164289)', async () => {
    await seedIssue('WI-QC-REVIEW-PENDING', {
      agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'idea-pending', round: 1 },
    });
    await seedIssue('WI-QC-REVIEW-REVISION', {
      agentReview: {
        status: 'revision-requested',
        submittedBy: 'su-author',
        ledgerIdeaId: 'idea-revision',
        round: 1,
      },
    });

    const out = await readIssueClaimability(undefined, { harness: H }, {
      limit: 20,
      sampleLimit: 5,
      breakdownOnly: true,
    });

    expect(out.breakdown.queueControl).toMatchObject({
      pendingAgentReview: 1,
      revisionRequestedAgentReview: 1,
    });
    expect(out.sample?.queueControl.agentReview).toEqual([
      {
        id: 'WI-QC-REVIEW-PENDING',
        status: 'pending',
        submittedBy: 'su-author',
        ledgerIdeaId: 'idea-pending',
        round: 1,
      },
    ]);
  });

  it('excludes pending reviews another agent holds from the count and the sample (EI-25949663083795915)', async () => {
    const review = (idea: string) => ({
      agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: idea, round: 1 },
    });
    // improvements:agent-review refuses this one with claim-conflict (holder !== reviewer).
    await seedIssue('WI-QC-REVIEW-HELD-OTHER', review('idea-held-other'), { takenBy: 'su-other' });
    await seedIssue('WI-QC-REVIEW-UNHELD', review('idea-unheld'));
    // The caller's own hold is claimable by the caller, so it still counts.
    await seedIssue('WI-QC-REVIEW-HELD-SELF', review('idea-held-self'), { takenBy: 'su-asking' });

    const out = await readIssueClaimability(undefined, { harness: H, assignee: 'su-asking' }, {
      limit: 20,
      sampleLimit: 5,
      breakdownOnly: true,
    });
    expect(out.breakdown.queueControl.pendingAgentReview).toBe(2);
    expect((out.sample?.queueControl.agentReview ?? []).map((r) => r.id).sort()).toEqual([
      'WI-QC-REVIEW-HELD-SELF',
      'WI-QC-REVIEW-UNHELD',
    ]);

    // The direct (unmaterialized) aggregate applies the same predicate.
    const direct = await aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'su-asking' });
    expect(direct.queueControl.pendingAgentReview).toBe(2);
    // With no caller, every held row is someone else's: only the unheld one is reviewable.
    const anonymous = await aggregateIssueClaimExclusions(undefined, { harness: H });
    expect(anonymous.queueControl.pendingAgentReview).toBe(1);
  });
});

/**
 * agent-epistemics-2026-08-02 P-005 — DB-backed proof for `readClaimSpecDelta`, the
 * before/after read behind `scheduler:preview_spec_delta`.
 *
 * The mocked-pg unit suite (claim-spec-delta.test.ts) pins the TRANSACTION SHAPE — one
 * REPEATABLE READ txn, one floor materialization, three reads off it — but stubs every query
 * to return zero rows, so it cannot execute a line of the actual SQL. What only a real
 * database can prove is exactly what that shape makes non-obvious: the delta materializes the
 * candidate population decorated with TWO match columns (`spec_match` for the stored spec, a
 * second compiled filter as `proposed_match`) over the UNION of both sides' claimable states,
 * and both compiled filters must evaluate correctly against that derived table's columns.
 *
 * The load-bearing assertion is AGREEMENT: each side of a delta must equal what
 * `readIssueClaimability` reports for that spec ALONE. A delta that quietly disagrees with the
 * single-spec oracle is worse than no delta — it would send a leader to re-steer a lane on
 * numbers the claim door does not honor, which is the exact drift (a second SQL copy of the
 * floors) this design exists to prevent.
 */
describe('P-005 — readClaimSpecDelta: which items a proposed spec revision drops or picks up', () => {
  const sev = (s: string) => ({ _ei: { severity: s } });
  const CRIT_OR_MAJOR: FilterNode = { field: 'severity', op: 'in', value: ['critical', 'major'] };
  const CRIT_ONLY: FilterNode = { field: 'severity', op: '=', value: 'critical' };

  it('names the rows a NARROWING revision would drop, and agrees with the single-spec oracle on both sides', async () => {
    await seedIssue('WI-D-CRIT', sev('critical'));
    await seedIssue('WI-D-MAJ', sev('major'));
    await seedIssue('WI-D-MINOR', sev('minor'));
    await seedIssue('WI-D-TAKEN', sev('major'), { takenBy: 'su-outside' }); // floored on BOTH sides

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR },
      { filter: CRIT_ONLY },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.currentClaimable).toBe(2); // CRIT + MAJ (TAKEN is floored, MINOR is out of filter)
    expect(delta.proposedClaimable).toBe(1); // CRIT
    expect(delta.retained).toBe(1);
    expect(delta.newlyExcludedCount).toBe(1);
    expect(delta.newlyAdmittedCount).toBe(0);
    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-D-MAJ']);
    // Attribution: the filter moved it, not the states — the two have different fixes.
    expect(delta.newlyExcluded[0]).toMatchObject({ cause: 'filter', severity: 'major', status: 'open', origin: 'local' });
    expect(delta.truncated).toEqual({ newlyExcluded: false, newlyAdmitted: false });

    // AGREEMENT with the single-spec oracle, per side. This is the anti-drift assertion.
    const current = await readIssueClaimability(CRIT_OR_MAJOR, { harness: H }, { limit: 20 });
    const proposed = await readIssueClaimability(CRIT_ONLY, { harness: H }, { limit: 20 });
    expect(delta.currentClaimable).toBe(current.breakdown.claimable);
    expect(delta.proposedClaimable).toBe(proposed.breakdown.claimable);
    // A floored row is invisible to the delta entirely — it was in neither lane, so it can be
    // neither a loss nor a gain.
    const moved = [...delta.newlyExcluded, ...delta.newlyAdmitted].map((r) => r.id);
    expect(moved).not.toContain('WI-D-TAKEN');
  });

  it('names the rows a WIDENING revision would pick up', async () => {
    await seedIssue('WI-W-CRIT', sev('critical'));
    await seedIssue('WI-W-MAJ', sev('major'));

    const delta = await readClaimSpecDelta(
      { filter: CRIT_ONLY },
      { filter: CRIT_OR_MAJOR },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.currentClaimable).toBe(1);
    expect(delta.proposedClaimable).toBe(2);
    expect(delta.newlyExcludedCount).toBe(0);
    expect(delta.newlyAdmitted.map((r) => r.id)).toEqual(['WI-W-MAJ']);
    expect(delta.newlyAdmitted[0]!.cause).toBe('filter');
  });

  it('includes proposed-only fixed-cohort rows when widening an existing plan filter', async () => {
    // This is the live EI-20414245235902773 shape: the current plan lane is empty, while the
    // proposal widens it with a fixed ID cohort. The candidate snapshot must be the UNION of
    // both filters; seeding only the proposed IDs makes the old current-filter-only snapshot
    // report a false 0 → 0 / newlyAdmitted=0.
    const currentFilter: FilterNode = {
      field: 'plan',
      op: '=',
      value: 'sidestage-iphone-app-2026-08-13',
    };
    const ids = ['WI-38727', 'WI-38728', 'WI-38729', 'WI-38732', 'WI-38733'];
    for (const id of ids) await seedIssue(id, null);

    const delta = await readClaimSpecDelta(
      { filter: currentFilter },
      {
        filter: {
          any: [currentFilter, { field: 'id', op: 'in', value: ids }],
        },
      },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.currentClaimable).toBe(0);
    expect(delta.proposedClaimable).toBe(ids.length);
    expect(delta.retained).toBe(0);
    expect(delta.newlyExcludedCount).toBe(0);
    expect(delta.newlyAdmittedCount).toBe(ids.length);
    expect(delta.newlyAdmitted.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('treats a states-only revision as a first-class delta and attributes it to `states`', async () => {
    // The starvation shape this fleet has actually hit: an issue-family lane re-steered onto a
    // status token its rows do not carry. The filter is IDENTICAL on both sides, so a
    // filter-only diff would report "no change" for the most common way a lane starves.
    await seedIssue('WI-S-OPEN', null);
    await seedIssue('WI-S-FAILING', null, { status: 'failing' });

    const delta = await readClaimSpecDelta({ states: ['open'] }, { states: ['failing'] }, { harness: H }, {
      limit: 20,
    });

    expect(delta.currentClaimable).toBe(1);
    expect(delta.proposedClaimable).toBe(1);
    expect(delta.retained).toBe(0);
    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-S-OPEN']);
    expect(delta.newlyAdmitted.map((r) => r.id)).toEqual(['WI-S-FAILING']);
    expect(delta.newlyExcluded[0]!.cause).toBe('states');
    expect(delta.newlyAdmitted[0]!.cause).toBe('states');
  });

  it('attributes a row moved by BOTH dimensions to `both`', async () => {
    await seedIssue('WI-B-1', sev('major'), { status: 'failing' });

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR, states: ['failing'] },
      { filter: CRIT_ONLY, states: ['open'] },
      { harness: H },
      { limit: 20 },
    );

    expect(delta.newlyExcluded.map((r) => r.id)).toEqual(['WI-B-1']);
    expect(delta.newlyExcluded[0]!.cause).toBe('both');
  });

  it('reports an identical revision as a zero delta', async () => {
    await seedIssue('WI-N-1', sev('critical'));
    await seedIssue('WI-N-2', sev('major'));

    const delta = await readClaimSpecDelta(
      { filter: CRIT_OR_MAJOR },
      { filter: CRIT_OR_MAJOR },
      { harness: H },
      { limit: 20 },
    );

    expect(delta).toMatchObject({
      currentClaimable: 2,
      proposedClaimable: 2,
      retained: 2,
      newlyExcludedCount: 0,
      newlyAdmittedCount: 0,
      newlyExcluded: [],
      newlyAdmitted: [],
    });
  });

  it('keeps the COUNTS exact when the row lists are capped, and says so', async () => {
    // A capped list that silently under-reports the loss is how a leader green-lights a
    // revision that drops 40 items after seeing 2.
    for (let i = 0; i < 5; i += 1) await seedIssue(`WI-C-${i}`, sev('major'));

    const delta = await readClaimSpecDelta({ filter: CRIT_OR_MAJOR }, { filter: CRIT_ONLY }, { harness: H }, {
      limit: 2,
    });

    expect(delta.newlyExcludedCount).toBe(5);
    expect(delta.newlyExcluded).toHaveLength(2);
    expect(delta.truncated.newlyExcluded).toBe(true);
    expect(delta.truncated.newlyAdmitted).toBe(false);
  });
});

/**
 * EI-20091339613996367 — the claimability BAR applies every floor the candidate subquery computes.
 *
 * WHY THIS EXISTS, stated as the failure it catches rather than the rule it asserts.
 * `ALL_ISSUE_CLAIM_FLOORS_PASS` is a hand-written AND of `ok_*` column names. The floor LOGIC
 * behind each of those columns cannot drift — every one is computed by the same exported helper
 * `claimNextIssueWorkItem` enforces, which is what makes the count and the row list agree. What
 * is NOT protected is the SET: decorate a new floor in `issueClaimCandidateSubquery` and forget
 * to AND it here, and Postgres computes that boolean for every candidate row and then ignores
 * it. `work_items:claimable` and the survivors count silently OVER-ADMIT — the queue advertises
 * work the real claim path refuses, which is the exact user-visible shape of WI-2633 / WI-4405 /
 * WI-37761 / WI-37774, each of which was one floor missing from one representation.
 *
 * Nothing about that failure is loud. There is no SQL error (the column exists, it is merely
 * unreferenced), no type error (the bar is a string), and — the part that matters — the seeded
 * AGREEMENT tests do not catch it either: `claim-ssot-agreement` and
 * `work-items-advertise-claim-floor-parity` compare verdicts on rows their fixtures seed, and a
 * newly-added floor by construction has no fixture yet. That is the same "the audit that proves
 * this is point-in-time and rots the moment someone adds a door" problem
 * `claim-door-census.test.ts` was written for, one level down: this asserts a STRUCTURAL set
 * equality, so it holds for floors nobody has thought of yet.
 *
 * MEASURED WHEN WRITTEN (2026-08-10): 13 decorated, 13 ANDed, exact agreement — i.e. this ships
 * GREEN and is a recurrence guard, not a bug fix. EI-20091339613996367 explicitly left
 * representation (3) unmeasured ("nothing PREVENTS it from drifting, not that it currently has");
 * this closes that question in the safe direction and keeps it closed.
 *
 * WHY RESULT-COLUMN METADATA AND NOT A SOURCE-TEXT SCAN. Grepping `AS ok_*` out of the .ts file
 * would be cheaper and would be WRONG in the one direction that matters: the subquery composes
 * its column list from helper calls at runtime, so a floor introduced by any means other than a
 * literal `AS ok_x` in that file is invisible to a text scan, which then reports a confident
 * "0 missing". A guard that cannot see the drift it exists to catch is worse than no guard,
 * because it is trusted. Asking the server what the query ACTUALLY returns cannot miss that way.
 */
describe('EI-20091339613996367 — the claimability bar applies EVERY floor the candidate subquery computes', () => {
  /** The `ok_*` columns the REAL subquery returns, read from live result-column metadata.
   *  `WHERE false` still forces Postgres to parse and plan the whole query (so a malformed
   *  floor fails loudly here) while returning no rows; postgres.js populates `.columns` on an
   *  empty result, which was verified against this database before the test was written. */
  async function decoratedOkColumns(): Promise<string[]> {
    const sql = db.sql as unknown as Parameters<typeof compileFilter>[0];
    const sub = issueClaimCandidateSubquery(sql, {
      compiled: compileFilter(sql, undefined), // the broad, no-named-ids spec: the real hot path
      assignee: 'su-probe',
      cooldown: 0,
      harness: H,
      states: ['open'],
      issueWs: WS,
      operatorScopeSlug: H,
      rigAvailable: true,
    });
    const rows = await db.sql`SELECT * FROM (${sub}) probe WHERE false`;
    const cols = (rows.columns ?? []) as unknown as ReadonlyArray<{ name: string }>;
    return cols
      .map((c) => c.name)
      .filter((n) => n.startsWith('ok_'))
      .sort();
  }

  /** The floors the bar actually references, de-duplicated. */
  function barFloors(): string[] {
    return [...new Set(ALL_ISSUE_CLAIM_FLOORS_PASS.match(/ok_[a-z_]+/g) ?? [])].sort();
  }

  it('ANDs every ok_* column the subquery decorates — one computed but not ANDed is silently ignored', async () => {
    const decorated = await decoratedOkColumns();
    const anded = barFloors();

    // Guard the guard: if the probe ever stops seeing columns, the comparison below would pass
    // vacuously in one direction. An empty decorated set means the probe broke, not that the
    // invariant holds.
    expect(decorated.length, 'probe returned no ok_* columns — the probe is broken, not the bar').toBeGreaterThan(0);

    const computedButIgnored = decorated.filter((c) => !anded.includes(c));
    expect(
      computedButIgnored,
      `issueClaimCandidateSubquery computes ${JSON.stringify(computedButIgnored)} but ` +
        `ALL_ISSUE_CLAIM_FLOORS_PASS never ANDs it, so that floor is evaluated per row and then ` +
        `DISCARDED: work_items:claimable and the survivors count will advertise rows the real ` +
        `claim path refuses. Add it to the bar in get-next.ts.`,
    ).toEqual([]);

    const andedButAbsent = anded.filter((c) => !decorated.includes(c));
    expect(
      andedButAbsent,
      `ALL_ISSUE_CLAIM_FLOORS_PASS references ${JSON.stringify(andedButAbsent)}, which the ` +
        `candidate subquery does not decorate — the floor was removed or renamed on one side only.`,
    ).toEqual([]);
  });

  it('the bar is a pure conjunction of column identifiers — no literal that could pin it open', () => {
    // `sql.unsafe` interpolates this string verbatim at 5+ call sites, so its safety rests on it
    // containing ONLY identifiers and AND. A stray `OR`/`TRUE` would not just be unsafe, it would
    // quietly widen the queue — the same over-admit symptom as a missing floor, from the other end.
    const skeleton = ALL_ISSUE_CLAIM_FLOORS_PASS.replace(/ok_[a-z_]+/g, 'X').replace(/\s+/g, ' ').trim();
    const expected = Array(barFloors().length).fill('X').join(' AND ');
    expect(skeleton, `the bar must be "X AND X AND ..."; got ${JSON.stringify(skeleton)}`).toBe(expected);
  });
});
