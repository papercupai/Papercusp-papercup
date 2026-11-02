/**
 * convert.integration.test.ts — the PG read/idempotency helpers behind plan-item→
 * work_item conversion, against a real Postgres. (convertPlanItem itself drives the
 * whole work-items/liveness stack; the focused reads are what need a real DB.)
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - listConvertedPlanItemRefs / findImplementingWorkItem / findCoverageWorkItems:
 *    the implements/relates coord_links plane is split by FAMILY across two
 *    workspaces (EI-19346291419606670) — each must UNION both tenants, not pin
 *    DEFAULT_COORD_WORKSPACE alone. Every "TENANT-COMPLETE" test below writes the
 *    two families to DIFFERENT workspaces, which a fake-sql/single-tenant fixture
 *    cannot do (it would satisfy whichever tenant the reader picked either way).
 *  - findImplementingWorkItem: edge lookup newest-first + the issue vs
 *    `<harness>#<id>` feature-ref src parsing.
 *  - findConvertedWorkItemByStamp: the `payload.plan_item` stamp match against a real
 *    jsonb OBJECT, plus (WI-6993 / EI-19342686955096692) a proof that the historical
 *    postgres-js jsonb STRING SCALAR binding quirk can no longer reach a stored row at
 *    all — migration 725's `work_items_payload_is_object_ck` CHECK constraint rejects
 *    a non-object payload at INSERT time, which is what let the read side drop its
 *    `CASE WHEN jsonb_typeof(payload)='string' …` unwrap (the wrap was defeating the
 *    `work_items_plan_item_stamp_idx` expression index and costing ~7.6h of DB time/day
 *    — see that migration's comment for the measured before/after).
 *
 * getWorkItem (and the convert-only deps) are mocked; the SQL is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyMigrationForTest, applyPlanItemAnchorMigrationsForTest } from '../../test/_pg-helpers';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { PLAN_ITEM_KIND, planItemRef } from '../issue-blocks-merge';
import { checkDraftItemStartGateLive } from '../agent-tools/plans/draft-item-start-gate';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// Partially import work-items so static dependencies added to this runtime graph keep resolving;
// override the conversion reads/writes whose behavior this real-PG fixture controls.
// getWorkItem returns a stub for any id (null for ids starting 'missing').
// ISSUE_FAMILY_KINDS must be the REAL value (not a stub array) — findConvertedWorkItemByStamp
// binds it into a `= ANY(...)` SQL filter against a real Postgres, so a wrong/missing value
// silently changes which rows match rather than throwing.
//
// EI-21213528544407590: the resolvers now PREFER a non-terminal record over a terminal
// one, so the stub's state is load-bearing. `wiState.states` overrides it per id; the
// default stays 'open' so every test written before this distinction existed is unaffected.
const wiState = vi.hoisted(() => ({ states: {} as Record<string, string> }));
vi.mock('../work-items', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../work-items')>();
  return {
    ...actual,
    getWorkItem: (id: string, harness?: string) =>
      id.startsWith('missing') ? null : { id, harness: harness ?? null, state: wiState.states[id] ?? 'open' },
    getWorkItemDetail: vi.fn().mockResolvedValue(null),
    createWorkItem: vi.fn(),
    claimWorkItem: vi.fn(),
    releaseWorkItem: vi.fn(),
    linkWorkItem: vi.fn(),
    updateWorkItem: vi.fn(async (id: string, patch: Record<string, unknown>, _owner?: string, opts?: { harness?: string }) => ({
      ok: true,
      item: { id, harness: opts?.harness ?? null, state: wiState.states[id] ?? 'open', ...patch },
    })),
    isWorkItemKind: () => true,
    isClaimHoldParked: () => false,
  };
});
vi.mock('../agent-tools/plans/source', () => ({ readPlanBySlug: vi.fn() }));
// The dynamic half of the split implements-link plane. Controlled here so the union
// default is deterministic — with a real coordScopeWorkspace() the two scopes can
// collapse to one and the tenant-completeness test below would pass vacuously.
const cs = vi.hoisted(() => ({ scope: 'default' }));
vi.mock('../agent-tools/coordination/log', () => ({ coordScopeWorkspace: () => cs.scope }));
vi.mock('./liveness', () => ({ claimPlanItem: vi.fn() }));
vi.mock('./compile-brief', () => ({ compilePlanItemBrief: vi.fn(), decisionsForItem: vi.fn() }));

const {
  findImplementingWorkItem,
  findCoverageWorkItems,
  findConvertedWorkItemByStamp,
  listConvertedPlanItemRefs,
  listCoveredPlanItemRefs,
  IMPLEMENTS_REL,
  convertPlanItem,
  stampPromotedWorkItemProvenance,
} = await import('./convert');

const WS = DEFAULT_COORD_WORKSPACE;
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `conv_${randomBytes(5).toString('hex')}`;
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
    CREATE TABLE harness_shared.coord_links (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      src_kind text NOT NULL, src_ref text NOT NULL,
      dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text,
      created_at timestamptz DEFAULT now() NOT NULL
    )`);
  // P-010 unification: work_items base + hfc/ei compat views (replaces hand-rolled hfc + ei).
  await rootSql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyPlanItemAnchorMigrationsForTest(rootSql);
  await applyMigrationForTest(rootSql, fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/832-plan-audits.sql', import.meta.url,
  )));
  // The draft item-start gate reads the activation audit payload from plan_audits.
  await applyMigrationForTest(rootSql, fileURLToPath(new URL(
    '../../../../libs/papercusp/libs/db/sql/938-plan-activation-audits.sql', import.meta.url,
  )));
  // WI-6993 / EI-19342686955096692 / migration 725: the shared fixture DDL deliberately
  // omits check constraints (see _work-items-schema.ts's doc comment — "add it in the
  // specific test, not here"). This test's whole point is proving the production
  // `work_items_payload_is_object_ck` guard, so add it here to mirror prod exactly.
  await rootSql.unsafe(`
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_payload_is_object_ck
      CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object')`);
  // P-003 promotion-provenance stamp: resolveGoalContext reads BOTH goal legs —
  // the promoter's own goal-mode row (agent_modes) and the launch-inherited one
  // (session_briefs). Real tables so the stamp's composition with the resolver
  // is proven against actual SQL, not a mock of it (the goal-provenance-stamp
  // integration test exists because the unit-mocked halves had "never been
  // proven to compose" — same lesson here).
  // The provenance resolver reads the canonical election/lease plane. Reuse
  // its actual migrations instead of a pre-election imitation of agent_modes.
  for (const migration of [
    '500-agent-modes.sql',
    '767-agent-modes-subject.sql',
    '1032-agent-mode-goal-holder-election.sql',
  ]) {
    await applyMigrationForTest(rootSql, fileURLToPath(new URL(
      `../../../../libs/papercusp/libs/db/sql/${migration}`, import.meta.url,
    )));
  }
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL, goal_id text,
      first_seen_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_links, harness_shared.work_items,
                harness_shared.agent_modes, harness_shared.session_briefs`;
  cs.scope = 'default'; // collapse the union to WS unless a test widens it
  wiState.states = {}; // every id back to the default 'open'
});

async function edge(o: { plan: string; item: string; srcKind?: string; srcRef: string; rel?: string; dstKind?: string; ws?: string; createdAt?: string }) {
  await rootSql`
    INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel, created_at)
    VALUES (${o.ws ?? WS}, ${o.srcKind ?? 'issue'}, ${o.srcRef}, ${o.dstKind ?? PLAN_ITEM_KIND},
            ${planItemRef(o.plan, o.item)}, ${o.rel ?? IMPLEMENTS_REL}, ${o.createdAt ?? '2026-01-01T00:00:00Z'})`;
}

describe('listConvertedPlanItemRefs (PG)', () => {
  /**
   * THE REGRESSION THIS SUITE PREVIOUSLY COULD NOT SEE. The implements-link plane is split by
   * FAMILY across two workspaces — feature-family under DEFAULT_COORD_WORKSPACE (work-items.ts
   * binds the store to the static literal), issue-family under coordScopeWorkspace() (
   * issues-engineer.ts binds the dynamic resolver). A reader pinned to EITHER single tenant is
   * blind to a whole family, and stays plausible while blind because the half it does see is
   * large: measured 2026-08-02, 1216 feature links under 'default' and 1468 issue links under
   * 'papercusp-workspace'.
   *
   * Every other test in this file writes and reads under ONE workspace (WS), so the fixture
   * value silently satisfies whichever tenant the reader picked — which is exactly why P-009's
   * 26/26 green, mutation-verified suite shipped this bug. The guard has to write the two
   * families to DIFFERENT workspaces or it proves nothing.
   */
  it('is TENANT-COMPLETE: unions both workspaces the plane is split across', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'pf', item: 'I-1', srcKind: 'feature', srcRef: 'web#F-1', ws: DEFAULT_COORD_WORKSPACE });
    await edge({ plan: 'pi', item: 'I-2', srcKind: 'issue', srcRef: 'EI-1', ws: 'papercusp-workspace' });
    // Pinning to either tenant alone returns exactly one of these — the bug.
    const refs = await listConvertedPlanItemRefs();
    expect([...refs].sort()).toEqual([planItemRef('pf', 'I-1'), planItemRef('pi', 'I-2')].sort());
  });

  it('an explicit workspace list still pins the read (the test-only escape hatch)', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'pf', item: 'I-1', srcRef: 'EI-1', ws: DEFAULT_COORD_WORKSPACE });
    await edge({ plan: 'pi', item: 'I-2', srcRef: 'EI-2', ws: 'papercusp-workspace' });
    expect([...(await listConvertedPlanItemRefs([DEFAULT_COORD_WORKSPACE]))]).toEqual([planItemRef('pf', 'I-1')]);
  });

  it('returns the DISTINCT set of implements→plan_item dst_refs, workspace-scoped', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-1' });
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-2' }); // duplicate dst → DISTINCT collapses
    await edge({ plan: 'p2', item: 'I-2', srcRef: 'EI-3' });
    await edge({ plan: 'p3', item: 'I-3', srcRef: 'EI-4', rel: 'blocks' }); // wrong rel — excluded
    await edge({ plan: 'p4', item: 'I-4', srcRef: 'EI-5', dstKind: 'issue' }); // wrong dst_kind — excluded
    await edge({ plan: 'p5', item: 'I-5', srcRef: 'EI-6', ws: 'other-ws' }); // wrong workspace — excluded
    const refs = await listConvertedPlanItemRefs([WS]);
    expect([...refs].sort()).toEqual([planItemRef('p1', 'I-1'), planItemRef('p2', 'I-2')].sort());
  });
});

describe('listCoveredPlanItemRefs (PG, legacy text coverage)', () => {
  it('reads legacy feature and issue coverage across both workspace partitions', async () => {
    cs.scope = 'papercusp-workspace';
    await rootSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, summary)
      VALUES (${WS}, 'web', 'F-legacy', 'feature', 'Plan: legacy-plan item P-001'),
             ('papercusp-workspace', 'web', 'EI-legacy', 'bug', 'Plan: legacy-plan item P-002')`;

    expect([...(await listCoveredPlanItemRefs('legacy-plan', 'web', ['P-001', 'P-002']))].sort())
      .toEqual([planItemRef('legacy-plan', 'P-001'), planItemRef('legacy-plan', 'P-002')]);
  });

  it('keeps legacy coverage within its tenant, harness and exact plan/item references', async () => {
    await rootSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, summary)
      VALUES (${WS}, 'web', 'EI-positive', 'bug', 'Plan: legacy-plan item P-001'),
             (${WS}, 'other-harness', 'EI-wrong-harness', 'bug', 'Plan: legacy-plan item P-002'),
             ('other-workspace', 'web', 'EI-wrong-tenant', 'bug', 'Plan: legacy-plan item P-003'),
             (${WS}, 'web', 'EI-long-item', 'bug', 'Plan: legacy-plan item P-0040'),
             (${WS}, 'web', 'EI-long-plan', 'bug', 'Plan: legacy-plan-extra item P-005')`;

    expect([...(await listCoveredPlanItemRefs('legacy-plan', 'web',
      ['P-001', 'P-002', 'P-003', 'P-004', 'P-005']))])
      .toEqual([planItemRef('legacy-plan', 'P-001')]);
  });
});

describe('findImplementingWorkItem (PG)', () => {
  it('resolves an issue-family edge to its work item', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcKind: 'issue', srcRef: 'EI-7' });
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'EI-7' });
  });

  it('parses a feature-ref `<harness>#<id>` edge into getWorkItem(id, harness)', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcKind: 'feature', srcRef: 'web#F-1' });
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'F-1', harness: 'web' });
  });

  it('prefers the NEWEST edge (ORDER BY created_at DESC)', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-old', createdAt: '2026-01-01T00:00:00Z' });
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-new', createdAt: '2026-06-01T00:00:00Z' });
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'EI-new' });
  });

  /**
   * EI-21213528544407590 regression: "a newer TERMINAL implements edge masks an older
   * OPEN execution record", measured live on plan P-028 2026-08-23T03:33:59Z.
   *
   * Two implements edges, 6s apart: the older pointed at WI-40489 (open, the record
   * actually doing the work), the newer at WI-40495 (dropped 20min earlier). The
   * resolver returned the newest EXTANT edge with no state filter, so it answered with
   * the dropped record; convertPlanItem's step-2 resume branch only fires for a
   * NON-terminal record, so it fell through and minted a duplicate (WI-40781) for a
   * plan item that already had a live execution record.
   *
   * Recency is now only a TIE-BREAK. The calibration for these two tests is the
   * 'prefers the NEWEST edge' test above: same helper, same stub, both records open —
   * so newest-first is provably still in force, and these pin only what state changes.
   */
  it('EI-21213528544407590: a newer TERMINAL edge does NOT mask an older open record', async () => {
    wiState.states['EI-dropped'] = 'dropped';
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-open', createdAt: '2026-01-01T00:00:00Z' });
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-dropped', createdAt: '2026-06-01T00:00:00Z' });
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'EI-open' });
  });

  it('EI-21213528544407590: falls back to the NEWEST terminal record when every candidate is terminal', async () => {
    wiState.states['EI-done'] = 'done';
    wiState.states['EI-dropped'] = 'dropped';
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-done', createdAt: '2026-01-01T00:00:00Z' });
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-dropped', createdAt: '2026-06-01T00:00:00Z' });
    // NOT the oldest — the live-record preference must not degrade into "prefer oldest".
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'EI-dropped' });
  });

  it('returns null when no edge exists', async () => {
    expect(await findImplementingWorkItem('nope', 'I-9')).toBeNull();
  });

  /**
   * EI-19346291419606670: this reader used to hardcode DEFAULT_COORD_WORKSPACE alone
   * (the same bug listConvertedPlanItemRefs was fixed for above) — a single-tenant
   * read is blind to whichever family lives in the other workspace. Same
   * different-workspaces-per-family fixture as the listConvertedPlanItemRefs
   * TENANT-COMPLETE test above; a fixture on ONE workspace cannot see this class.
   */
  it('is TENANT-COMPLETE: finds a feature-family edge under DEFAULT_COORD_WORKSPACE even when coordScopeWorkspace() differs', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'p1', item: 'I-1', srcKind: 'feature', srcRef: 'web#F-1', ws: DEFAULT_COORD_WORKSPACE });
    expect(await findImplementingWorkItem('p1', 'I-1')).toMatchObject({ id: 'F-1', harness: 'web' });
  });

  it('is TENANT-COMPLETE: finds an issue-family edge under the real per-workspace tenant', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'p2', item: 'I-2', srcKind: 'issue', srcRef: 'EI-8', ws: 'papercusp-workspace' });
    expect(await findImplementingWorkItem('p2', 'I-2')).toMatchObject({ id: 'EI-8' });
  });

  it('an explicit workspace list still pins the read (the test-only escape hatch)', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'p3', item: 'I-3', srcKind: 'issue', srcRef: 'EI-9', ws: 'papercusp-workspace' });
    expect(await findImplementingWorkItem('p3', 'I-3', [DEFAULT_COORD_WORKSPACE])).toBeNull();
  });
});

describe('findCoverageWorkItems (PG)', () => {
  it('resolves `relates` edges to their work items, newest-first', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-1', rel: 'relates', createdAt: '2026-01-01T00:00:00Z' });
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-2', rel: 'relates', createdAt: '2026-06-01T00:00:00Z' });
    expect((await findCoverageWorkItems('p1', 'I-1')).map((wi) => wi.id)).toEqual(['EI-2', 'EI-1']);
  });

  it('excludes `implements` edges — only `relates` counts as coverage', async () => {
    await edge({ plan: 'p1', item: 'I-1', srcRef: 'EI-1', rel: IMPLEMENTS_REL });
    expect(await findCoverageWorkItems('p1', 'I-1')).toEqual([]);
  });

  it('returns [] when no coverage edge exists', async () => {
    expect(await findCoverageWorkItems('nope', 'I-9')).toEqual([]);
  });

  /**
   * EI-19346291419606670 — THE bug this work-item exists for: findCoverageWorkItems backs
   * the residual-coverage guard (a plan item must not close as `done` while a linked
   * coverage work-item is still open). Hardcoding DEFAULT_COORD_WORKSPACE alone made the
   * guard see only the 'default'-tenant slice of `relates` edges (measured 2026-08-02: 64
   * of 357, ~18%) — a coverage work-item living in the real per-workspace tenant was
   * invisible, so the guard FAILED OPEN and the plan item could close while real tracked
   * work remained open. This fixture pins the two families to DIFFERENT workspaces, which
   * a single-tenant fixture (every other pre-existing test in this describe) cannot do.
   */
  it('is TENANT-COMPLETE: unions both workspaces the relates-coverage plane is split across', async () => {
    cs.scope = 'papercusp-workspace';
    await edge({ plan: 'pf', item: 'I-1', srcKind: 'feature', srcRef: 'web#F-1', rel: 'relates', ws: DEFAULT_COORD_WORKSPACE });
    await edge({ plan: 'pf', item: 'I-1', srcKind: 'issue', srcRef: 'EI-1', rel: 'relates', ws: 'papercusp-workspace' });
    // Pinning to either tenant alone returns exactly one of these — the bug.
    const items = await findCoverageWorkItems('pf', 'I-1');
    expect(items.map((wi) => wi.id).sort()).toEqual(['EI-1', 'F-1'].sort());
  });
});

describe('draft item-start gate recognizes stamped execution coverage (PG)', () => {
  it('lets an implements-only stamped work-item continue through an unaudited draft plan', async () => {
    const id = 'EI-draft-gate-stamped';
    const slug = 'p-draft-gate-stamped';
    const itemId = 'P-008';
    const content =
      '---\ntitle: T\nstatus: draft\n---\n\n## Phase 1 — Work\n\n- **P-008** `todo` implementation\n';
    await rootSql`INSERT INTO harness_shared.work_items (harness_slug, feature_id, item_kind, workspace_id, payload)
                  VALUES ('web', ${id}, 'bug', ${WS},
                          ${rootSql.json({ plan_item: { plan_slug: slug, item_id: itemId, harness_slug: 'web' } })})`;
    await edge({ plan: slug, item: itemId, srcKind: 'issue', srcRef: id, rel: IMPLEMENTS_REL });

    // The residual-coverage helper intentionally remains relates-only. The start
    // gate also consults the durable conversion stamp for existing execution work.
    expect(await findCoverageWorkItems(slug, itemId, [WS])).toEqual([]);
    const input = {
      workspaceId: WS,
      harnessSlug: 'web',
      slug,
      itemId,
      toStatus: 'done',
      planContent: content,
    };
    expect(await checkDraftItemStartGateLive(input)).toBeNull();

    wiState.states[id] = 'done';
    expect(await checkDraftItemStartGateLive(input)).toBeNull();
  });
});

describe('findConvertedWorkItemByStamp (PG, jsonb object-only payload)', () => {
  const stamp = (plan: string, item: string) => ({ plan_item: { plan_slug: plan, item_id: item, harness_slug: 'web' } });

  it('matches a feature row whose payload is a real jsonb OBJECT', async () => {
    await rootSql`INSERT INTO harness_shared.harness_features_consolidated (harness_slug, feature_id, workspace_id, payload, updated_ts)
                  VALUES ('web', 'F-9', ${WS}, ${rootSql.json(stamp('p1', 'I-1'))}, 100)`;
    expect(await findConvertedWorkItemByStamp('p1', 'I-1', 'web')).toMatchObject({ id: 'F-9', harness: 'web' });
  });

  // WI-6993 / EI-19342686955096692 / migration 725: this used to be "matches a feature
  // row whose payload is a jsonb STRING SCALAR (postgres-js binding quirk → must
  // unwrap)" — findConvertedWorkItemByStamp's read-side CASE-unwrap was deleted because
  // the write path (restoreRawJsonbSerializer + migration 641's trigger-level normalize)
  // no longer produces a string-scalar payload, and this CHECK constraint now makes one
  // UNSTORABLE at the source regardless of how a caller binds it. The positive test of
  // that invariant is that the write itself is rejected, not that a since-removed reader
  // can still cope with a row that can no longer exist.
  it('REJECTS a feature row whose payload is a jsonb STRING SCALAR (postgres-js binding quirk) at INSERT time', async () => {
    const jsonText = JSON.stringify(stamp('p2', 'I-2'));
    await expect(
      rootSql`INSERT INTO harness_shared.harness_features_consolidated (harness_slug, feature_id, workspace_id, payload, updated_ts)
              VALUES ('web', 'F-10', ${WS}, to_jsonb(${jsonText}::text), 100)`,
    ).rejects.toThrow(/work_items_payload_is_object_ck/);
    expect(await findConvertedWorkItemByStamp('p2', 'I-2', 'web')).toBeNull();
  });

  it('falls back to engineer_issues when no feature row matches', async () => {
    await rootSql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, payload)
                  VALUES (${WS}, 'EI-9', ${rootSql.json(stamp('p3', 'I-3'))})`;
    expect(await findConvertedWorkItemByStamp('p3', 'I-3', 'web')).toMatchObject({ id: 'EI-9' });
  });

  it('scopes stamped issue matches to the requested workspace and harness', async () => {
    const plan = 'p-stamp-scope';
    const item = 'P-002';
    await rootSql`INSERT INTO harness_shared.work_items (harness_slug, feature_id, item_kind, workspace_id, payload)
                  VALUES ('web', 'EI-stamp-foreign', 'bug', 'other-workspace', ${rootSql.json(stamp(plan, item))})`;
    await rootSql`INSERT INTO harness_shared.work_items (harness_slug, feature_id, item_kind, workspace_id, payload)
                  VALUES ('web', 'EI-stamp-wrong-harness', 'bug', ${WS},
                          ${rootSql.json({ plan_item: { plan_slug: plan, item_id: item, harness_slug: 'other' } })})`;

    expect(await findConvertedWorkItemByStamp(plan, item, 'web', WS)).toBeNull();
    expect(await findConvertedWorkItemByStamp(plan, item, 'web', 'other-workspace'))
      .toMatchObject({ id: 'EI-stamp-foreign' });
  });

  it('returns null when no stamp matches', async () => {
    expect(await findConvertedWorkItemByStamp('ghost', 'I-0', 'web')).toBeNull();
  });

  /**
   * EI-19443762267304247 regression: "plans:set-status{wip} auto-claim creates a
   * SECOND work-item for a plan item that already has one".
   *
   * Repro sequence (measured 2026-08-03): (1) `work_items:create { plan_item:
   * {slug,item} }` mints a work-item and writes a `relates` coverage edge — NOT an
   * `implements` edge (that rel is reserved for convert-at-pickup). (2) A later
   * `plans:set-status { item, status:'wip' }` auto-claims the plan item and (when
   * PLAN_ITEM_CLAIM_AUTO_CONVERT is on, the default) calls convertPlanItem, whose
   * idempotency check at the time was `findImplementingWorkItem` alone — which
   * only matches `implements`, so the `relates`-linked item from step 1 was
   * invisible and a duplicate work-item got minted.
   *
   * EI-19390496242545842 closed the gap from the OTHER end: work_items:create's
   * `plan_item` arg now ALSO stamps `payload.plan_item` (previously it wrote only
   * the `relates` edge) — the same stamp convert-at-pickup itself writes. That
   * means convertPlanItem's step-2 STAMP FALLBACK (findConvertedWorkItemByStamp,
   * used precisely when the `implements` edge is absent — see convert.ts's
   * "resume an existing non-terminal execution record" comment) now finds the
   * step-1 item and RESUMES it instead of minting a sibling.
   *
   * This pins that the two fixes actually compose: a work-item carrying ONLY the
   * `relates` edge (no `implements`) plus the stamp is found by the fallback that
   * convertPlanItem falls through to when the primary edge lookup misses.
   */
  it('EI-19443762267304247: a work_items:create{plan_item} item (relates edge + stamp, NO implements edge) is found by the stamp fallback', async () => {
    await edge({ plan: 'p6', item: 'I-6', srcKind: 'issue', srcRef: 'EI-relates-only', rel: 'relates' });
    await rootSql`INSERT INTO harness_shared.work_items (harness_slug, feature_id, item_kind, workspace_id, payload)
                  VALUES ('web', 'EI-relates-only', 'bug', ${WS}, ${rootSql.json(stamp('p6', 'I-6'))})`;

    // The PRIMARY lookup (implements edge) must miss — only `relates` was written.
    expect(await findImplementingWorkItem('p6', 'I-6')).toBeNull();
    // The FALLBACK (stamp match) must find the same item convertPlanItem would then resume.
    expect(await findConvertedWorkItemByStamp('p6', 'I-6', 'web')).toMatchObject({ id: 'EI-relates-only' });
  });
});

/**
 * EI-21213528544407590, END TO END: the resolver tests above pin which record is
 * RESOLVED; these pin what convertPlanItem then DOES with it, which is where the
 * duplicate actually got minted. Both halves are needed — a resolver that answers
 * correctly still mints a duplicate if step 2 stops consulting it, and step 2's
 * resume branch is guarded on the resolved record's terminal state.
 *
 * The pair is deliberately two-sided: preferring a live record must NOT become
 * "never mint again" — a plan item whose every execution record is genuinely
 * finished still has to convert.
 */
describe('convertPlanItem step 2: terminal records must not mask a live one (EI-21213528544407590)', () => {
  const HARNESS = 'web';
  let readPlanM: ReturnType<typeof vi.fn>;
  let claimPlanItemM: ReturnType<typeof vi.fn>;
  let createWorkItemM: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    readPlanM = (await import('../agent-tools/plans/source')).readPlanBySlug as unknown as ReturnType<typeof vi.fn>;
    claimPlanItemM = (await import('./liveness')).claimPlanItem as unknown as ReturnType<typeof vi.fn>;
    createWorkItemM = (await import('../work-items')).createWorkItem as unknown as ReturnType<typeof vi.fn>;
  });

  // These mocks are module-level and shared with the other describes, so reset
  // rather than inherit whatever a previous test left configured.
  beforeEach(() => {
    readPlanM.mockReset();
    claimPlanItemM.mockReset();
    createWorkItemM.mockReset();
    claimPlanItemM.mockResolvedValue({
      status: 'claimed',
      claim: { claimId: 'c-028' },
      mode: 'solo',
      viaAssignment: false,
    });
  });

  const givenPlanItem = (itemId: string) =>
    readPlanM.mockResolvedValue({
      row: { items: [{ id: itemId, status: 'todo', text: 'Provision the thing' }] },
      parsed: { items: [], frontmatter: {}, now: null },
    });

  const convert = (itemId: string) =>
    convertPlanItem({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'pz',
      itemId,
      owner: 'member-28',
      ownerUser: 'member-28',
    });

  it('RESUMES the older open record instead of minting a duplicate (the live P-028 shape)', async () => {
    wiState.states['WI-dropped'] = 'dropped';
    givenPlanItem('P-028');
    await edge({ plan: 'pz', item: 'P-028', srcKind: 'feature', srcRef: `${HARNESS}#WI-live`, createdAt: '2026-01-01T00:00:00Z' });
    await edge({ plan: 'pz', item: 'P-028', srcKind: 'feature', srcRef: `${HARNESS}#WI-dropped`, createdAt: '2026-06-01T00:00:00Z' });

    expect(await convert('P-028')).toMatchObject({ status: 'resumed', workItem: { id: 'WI-live' } });
    expect(createWorkItemM).not.toHaveBeenCalled();
  });

  it('a still-open STAMPED record whose edge was pruned is resumed too, not masked by a terminal edge', async () => {
    // The edge plane knows only the dropped record; the live one survives via the
    // durable payload.plan_item stamp. Before the fix step 2 consulted the stamp
    // ONLY when the edge lookup returned nothing at all, so a terminal edge
    // suppressed the fallback entirely and the live stamped record was invisible.
    wiState.states['WI-dropped'] = 'dropped';
    givenPlanItem('P-030');
    await edge({ plan: 'pz', item: 'P-030', srcKind: 'feature', srcRef: `${HARNESS}#WI-dropped` });
    await rootSql`INSERT INTO harness_shared.work_items (harness_slug, feature_id, item_kind, workspace_id, payload)
                  VALUES (${HARNESS}, 'WI-stamped-live', 'task', ${WS},
                          ${rootSql.json({ plan_item: { plan_slug: 'pz', item_id: 'P-030', harness_slug: HARNESS } })})`;

    expect(await convert('P-030')).toMatchObject({ status: 'resumed', workItem: { id: 'WI-stamped-live' } });
    expect(createWorkItemM).not.toHaveBeenCalled();
  });

  it('resumes the canonical line node without stamps instead of its legacy child', async () => {
    givenPlanItem('P-031');
    await rootSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, plan_slug, plan_line_id)
      VALUES (${WS}, ${HARNESS}, 'WI-node', 'feature', 'pz', 'P-031')`;
    await edge({ plan: 'pz', item: 'P-031', srcKind: 'issue', srcRef: 'WI-child' });
    expect(await convert('P-031')).toMatchObject({ status: 'resumed', workItem: { id: 'WI-node' } });
    expect(createWorkItemM).not.toHaveBeenCalled();
  });

  it('does not adopt a line node from another workspace', async () => {
    givenPlanItem('P-032');
    await rootSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, plan_slug, plan_line_id)
      VALUES ('other-workspace', ${HARNESS}, 'WI-foreign-node', 'feature', 'pz', 'P-032')`;
    createWorkItemM.mockResolvedValue({ id: 'WI-local', harness: HARNESS, state: 'open' });
    expect(await convert('P-032')).toMatchObject({ status: 'converted', workItem: { id: 'WI-local' } });
  });

  it('still MINTS when every implementing record is genuinely terminal', async () => {
    wiState.states['WI-done'] = 'done';
    givenPlanItem('P-029');
    await edge({ plan: 'pz', item: 'P-029', srcKind: 'feature', srcRef: `${HARNESS}#WI-done` });
    createWorkItemM.mockResolvedValue({ id: 'WI-fresh', harness: HARNESS, state: 'open', title: 'Provision the thing' });

    expect(await convert('P-029')).toMatchObject({ status: 'converted', workItem: { id: 'WI-fresh' } });
    expect(createWorkItemM).toHaveBeenCalled();
  });
});

/**
 * P-003 / D-005 obligation 3 (goal-mode-design-intent-hardening-2026-08-16):
 * promotion must land FIRST-CLASS source_plan_slug / source_plan_item_ids /
 * goal_id — measured live on WI-39506, promotion wrote only payload.plan_item
 * and all three columns stayed NULL, leaving promoted items invisible to a
 * goal-scoped drain lane (the `goal` claim-spec field matches POSITIVELY per
 * WI-37711: a NULL row is excluded, never wildcarded).
 *
 * Real SQL on purpose: the UPDATE's COALESCE/array semantics and its
 * composition with resolveGoalContext (both goal legs are real tables here)
 * are exactly what a fake-sql mock would assert into existence.
 */
describe('stampPromotedWorkItemProvenance + promotion wiring (P-003 / D-005 obligation 3)', () => {
  const HARNESS = 'web';
  // The mocked collaborators, programmable per-test. Handle-casts (not argument
  // casts): the vi.mock factories made these plain vi.fn()s, so the cast only
  // recovers the mock surface the factory installed.
  let readPlanM: ReturnType<typeof vi.fn>;
  let claimPlanItemM: ReturnType<typeof vi.fn>;
  let createWorkItemM: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    readPlanM = (await import('../agent-tools/plans/source')).readPlanBySlug as unknown as ReturnType<typeof vi.fn>;
    claimPlanItemM = (await import('./liveness')).claimPlanItem as unknown as ReturnType<typeof vi.fn>;
    createWorkItemM = (await import('../work-items')).createWorkItem as unknown as ReturnType<typeof vi.fn>;
  });

  // Same shape as the stamp() helper above (scoped to its own describe) — the
  // durable payload.plan_item back-pointer promotion writes.
  const promoStamp = (plan: string, item: string) => ({
    plan_item: { plan_slug: plan, item_id: item, harness_slug: HARNESS },
  });

  async function insertItem(
    id: string,
    over: {
      goal?: string | null;
      slug?: string | null;
      ids?: string[] | null;
      payload?: ReturnType<typeof promoStamp> | null;
    } = {},
  ) {
    await rootSql`INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, workspace_id, goal_id, source_plan_slug, source_plan_item_ids, payload)
      VALUES (${HARNESS}, ${id}, 'task', ${WS}, ${over.goal ?? null}, ${over.slug ?? null},
              ${over.ids ?? null}, ${over.payload ? rootSql.json(over.payload) : null})`;
  }
  async function readItem(id: string): Promise<{ goal_id: string | null; source_plan_slug: string | null; source_plan_item_ids: string[] | null }> {
    const rows = await rootSql<
      { goal_id: string | null; source_plan_slug: string | null; source_plan_item_ids: string[] | null }[]
    >`SELECT goal_id, source_plan_slug, source_plan_item_ids
        FROM harness_shared.work_items WHERE feature_id = ${id}`;
    return rows[0]!;
  }
  /** The promoter RUNS this goal — agent_modes leg of resolveGoalContext. */
  async function givenRunsGoal(ownerId: string, goalId: string) {
    await rootSql`INSERT INTO harness_shared.agent_modes (workspace_id, owner_id, axis_key, mode, subject, set_by)
                  VALUES (${WS}, ${ownerId}, 'overlay:goal', 'goal', ${goalId}, ${ownerId})`;
  }
  /** The promoter INHERITED this goal at launch — session_briefs leg. */
  async function givenInheritedGoal(ownerId: string, goalId: string) {
    await rootSql`INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, goal_id)
                  VALUES (${ownerId}, ${WS}, ${goalId})`;
  }
  const args = (
    id: string,
    over: Partial<Parameters<typeof stampPromotedWorkItemProvenance>[0]> = {},
  ) => ({
    workItemId: id,
    harnessSlug: HARNESS,
    workspaceId: WS,
    planSlug: 'the-plan',
    itemId: 'P-007',
    ownerId: 'promoter-1',
    ...over,
  });

  it('stamps goal + both first-class plan columns for a promoter RUNNING a goal', async () => {
    await givenRunsGoal('promoter-1', 'goal-42');
    await insertItem('WI-9001');
    expect(await stampPromotedWorkItemProvenance(args('WI-9001'))).toBe('goal-42');
    expect(await readItem('WI-9001')).toEqual({
      goal_id: 'goal-42',
      source_plan_slug: 'the-plan',
      source_plan_item_ids: ['P-007'],
    });
  });

  it('a goal-less promoter still lands the plan columns — goal_id stays NULL', async () => {
    await insertItem('WI-9002');
    expect(await stampPromotedWorkItemProvenance(args('WI-9002'))).toBeNull();
    expect(await readItem('WI-9002')).toEqual({
      goal_id: null,
      source_plan_slug: 'the-plan',
      source_plan_item_ids: ['P-007'],
    });
  });

  it('a superseded GOAL holder cannot stamp goal or plan provenance', async () => {
    await givenRunsGoal('promoter-1', 'goal-elected');
    await givenRunsGoal('successor', 'goal-elected');
    await rootSql`UPDATE harness_shared.agent_modes
                    SET goal_lease_epoch = CASE WHEN owner_id = 'successor' THEN 2 ELSE 1 END`;
    await insertItem('WI-superseded');
    expect(await stampPromotedWorkItemProvenance(args('WI-superseded'))).toBeNull();
    expect(await readItem('WI-superseded')).toEqual({
      goal_id: null, source_plan_slug: null, source_plan_item_ids: null,
    });
  });

  it('an unreadable holder schema leaves provenance unchanged rather than assuming authority', async () => {
    await givenRunsGoal('promoter-1', 'goal-unreadable');
    await insertItem('WI-unreadable');
    await rootSql`ALTER TABLE harness_shared.agent_modes RENAME COLUMN goal_lease_epoch TO hidden_epoch`;
    try {
      expect(await stampPromotedWorkItemProvenance(args('WI-unreadable'))).toBeNull();
      expect(await readItem('WI-unreadable')).toEqual({
        goal_id: null, source_plan_slug: null, source_plan_item_ids: null,
      });
    } finally {
      await rootSql`ALTER TABLE harness_shared.agent_modes RENAME COLUMN hidden_epoch TO goal_lease_epoch`;
    }
  });

  it('first attribution wins; item ids accumulate without duplicates', async () => {
    await givenRunsGoal('promoter-1', 'goal-B');
    await insertItem('WI-9003', { goal: 'goal-A', slug: 'plan-x', ids: ['P-001'] });
    await stampPromotedWorkItemProvenance(args('WI-9003', { itemId: 'P-002' }));
    expect(await readItem('WI-9003')).toEqual({
      goal_id: 'goal-A', // NOT goal-B — an attributed item is never re-parented
      source_plan_slug: 'plan-x', // NOT the-plan
      source_plan_item_ids: ['P-001', 'P-002'],
    });
    // Idempotent on repeat — the array gains nothing it already carries.
    await stampPromotedWorkItemProvenance(args('WI-9003', { itemId: 'P-002' }));
    expect((await readItem('WI-9003')).source_plan_item_ids).toEqual(['P-001', 'P-002']);
  });

  it('fail-soft: resolves null instead of throwing when the DB is unreachable', async () => {
    const boom = (() => Promise.reject(new Error('pg down'))) as unknown as postgres.Sql;
    await expect(stampPromotedWorkItemProvenance(args('WI-9004', { sql: boom }))).resolves.toBeNull();
  });

  it("convertPlanItem's MINT leaves the promoted row goal-stamped and plan-addressed", async () => {
    await givenInheritedGoal('member-9', 'goal-77');
    readPlanM.mockResolvedValue({
      row: { items: [{ id: 'P-007', status: 'todo', text: 'Do the thing' }] },
      parsed: { items: [], frontmatter: {}, now: null },
    });
    claimPlanItemM.mockResolvedValue({ status: 'claimed', claim: { claimId: 'c1' }, mode: 'solo', viaAssignment: false });
    createWorkItemM.mockImplementation(async (input: { title: string }) => {
      await insertItem('WI-9005', { payload: promoStamp('pp', 'P-007') });
      return { id: 'WI-9005', harness: HARNESS, state: 'open', title: input.title };
    });

    const res = await convertPlanItem({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'pp',
      itemId: 'P-007',
      owner: 'member-9',
      ownerUser: 'member-9',
    });
    expect(res.status).toBe('converted');
    expect(await readItem('WI-9005')).toEqual({
      goal_id: 'goal-77',
      source_plan_slug: 'pp',
      source_plan_item_ids: ['P-007'],
    });
  });

  it("convertPlanItem's RESUME heals a row promoted before the stamp existed", async () => {
    // The measured live state: stamp only in payload.plan_item, columns NULL.
    await insertItem('WI-9006', { payload: promoStamp('pq', 'P-003') });
    await givenRunsGoal('healer-1', 'goal-88');
    readPlanM.mockResolvedValue({
      row: { items: [{ id: 'P-003', status: 'wip', text: 'Old promoted work' }] },
      parsed: { items: [], frontmatter: {}, now: null },
    });
    claimPlanItemM.mockResolvedValue({ status: 'claimed', claim: { claimId: 'c2' }, mode: 'solo', viaAssignment: false });

    const res = await convertPlanItem({
      workspaceId: WS,
      harnessSlug: HARNESS,
      planSlug: 'pq',
      itemId: 'P-003',
      owner: 'healer-1',
      ownerUser: 'healer-1',
    });
    expect(res.status).toBe('resumed');
    expect(await readItem('WI-9006')).toEqual({
      goal_id: 'goal-88',
      source_plan_slug: 'pq',
      source_plan_item_ids: ['P-003'],
    });
  });
});
