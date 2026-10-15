/**
 * work-items-observation-lane-exclusion.integration.test.ts — the issue-family
 * `payload.lane:'observation'` self-select exclusion.
 *
 * A `lane:'observation'` row is a turn-end reflection / rubric scorecard filed via
 * `improvements:capture { lane:'observation' }`. By DESIGN (D-005, advertised in the capture
 * tool's own description) it "never enters the work queue/triage/auto-implement — only Scout's
 * corpus-digest + the Observations pane read it". But these rows land in the work_items BASE as
 * issue-family `change`-kind rows, so without an exclusion floor the oldest-first self-select
 * served them like real work: a drain member claimed a scorecard, found nothing to DO (its
 * payload IS the whole deliverable), and released it — pure recycle churn. This was the dominant
 * pool pollutant (922 open observation rows vs 854 real items, 2026-07-05) and the root of the
 * recurring "claim_next keeps surfacing lane:observation scorecards" friction (EI-7503/7587/7741).
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • claimNextWorkItem's issue tier SKIPS an observation-lane row and serves a real one instead
 *     — even when the observation is oldest (would otherwise win the oldest-first steal);
 *   • an observation-lane row is STILL directly claimable BY ID (the floor only gates self-select);
 *   • diagnoseClaimNextMiss reports an observation-ONLY backlog as DRAINED (pendingUnclaimed===0,
 *     drained===true) — the KEY difference from a _claimHold-only backlog (pending-but-not-ready):
 *     an observation is not work-queue material AT ALL, so a drainer facing only scorecards must
 *     be told to idle, never "work exists, don't idle";
 *   • a real ready item alongside an observation one counts fully (the observation neither shadows
 *     siblings nor inflates the pending/ready counts).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-observation-lane-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE. `kind` is exposed so an observation row can be
 *  seeded as a realistic 'change' (the scorecard kind) while a real item stays 'bug'. */
async function seedIssue(
  id: string,
  opts: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    createdTs?: number;
    payload?: postgres.JSONValue | null;
    harness?: string;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.kind ?? 'bug'}, ${`title ${id}`}, ${opts.status ?? 'open'}, ${opts.takenBy ?? null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${opts.payload ? db.sql.json(opts.payload) : null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-observation-lane');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple()); // trust list, deps, adv_sessions, event tables (WI-10005130)
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
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

describe('claimNextWorkItem SKIPS a lane:observation issue (D-005)', () => {
  it('serves the real item, never the observation, even when the observation is oldest', async () => {
    await seedIssue('EI-obs', { kind: 'change', createdTs: 100, payload: { lane: 'observation' } });
    await seedIssue('WI-real', { createdTs: 200 });

    // Oldest-first would normally serve EI-obs (createdTs:100) — the observation floor must skip it.
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real');

    // Only one real candidate existed — it's now claimed, so the pool is genuinely dry.
    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    // The observation was NEVER claimed by the self-select path.
    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'EI-obs'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('an observation row is STILL directly claimable by id (the floor only gates self-select)', async () => {
    await seedIssue('EI-obs-direct', { kind: 'change', createdTs: 100, payload: { lane: 'observation' } });
    const claimed = await wi.claimWorkItem('EI-obs-direct', 'inspector', { harness: H });
    expect(claimed?.id).toBe('EI-obs-direct');
    expect(claimed?.assignee).toBe('inspector');
  });

  it('a non-observation lane (improvement) is NOT excluded', async () => {
    await seedIssue('WI-improvement', { kind: 'change', createdTs: 100, payload: { lane: 'improvement' } });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-improvement');
  });

  it('re-reads the exact claimed operator-scope issue when a stale empty-slug twin exists (EI-7808)', async () => {
    await seedIssue('EI-dup', {
      harness: '',
      status: 'resolved',
      createdTs: 100,
      payload: { _ei: { scope: 'operator', severity: 'minor', source: 'engineer', signal_origin: 'organic' } },
    });
    await seedIssue('EI-dup', {
      harness: `operator:${WS}`,
      status: 'open',
      createdTs: 200,
      payload: { _ei: { scope: 'operator', severity: 'minor', source: 'engineer', signal_origin: 'organic' } },
    });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('EI-dup');
    expect(got?.state).toBe('open');
    expect(got?.assignee).toBe('bee-1');
  });
});

describe('diagnoseClaimNextMiss treats an observation-only backlog as DRAINED (D-005)', () => {
  it('pendingUnclaimed === 0 and drained === true (idle is correct — NOT pending-but-gated)', async () => {
    // The distinguishing case vs _claimHold: an observation is not work-queue material at all,
    // so it must NOT inflate the pool — a scorecard-only queue reads drained, so a drainer idles.
    await seedIssue('EI-obs-diag', { kind: 'change', createdTs: 100, payload: { lane: 'observation' } });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(true);
  });

  it('a real ready item alongside an observation one counts fully (observation neither shadows nor inflates)', async () => {
    await seedIssue('EI-obs-diag-2', { kind: 'change', createdTs: 100, payload: { lane: 'observation' } });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1); // ONLY the real item — the observation is excluded from the pool
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });
});
