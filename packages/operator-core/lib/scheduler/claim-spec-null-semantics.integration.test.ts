/**
 * claim-spec-null-semantics.integration.test.ts — EI-13306 recurrence + parity guard.
 *
 * THE BUG THIS PINS. A claim-spec filter that NEGATES a predicate over a NULLABLE field
 * (`not:{plan = X}`, `not:{plan glob X}`, `plan != X`) used to compile to a bare
 * `NOT (source_plan_slug::text = 'X')`. SQL three-valued logic makes that NULL for every row
 * whose plan is NULL, and a WHERE clause drops a NULL row — so the filter silently deleted the
 * entire backlog. It starved a 10-agent drain fleet TWICE in one day; the second time the
 * claimable pool was measured collapsing 2341 -> 4. It fails SILENT: the spec validates
 * (ok:true, errors:[]) and get_next returns an honest-looking "no claimable item in fleet
 * scope", so the spec — the one thing that is fine — gets blamed.
 *
 * These run against REAL Postgres (testcontainer; Docker required) ON PURPOSE. The defect IS
 * SQL null semantics, so a unit test asserting the emitted string contains "COALESCE" would
 * pin the implementation while proving nothing about behavior. The only guard that can fail
 * for the right reason is one that executes the SQL against a real NULL column.
 *
 * PARITY. One spec language has TWO evaluators — this SQL compiler (get-next.ts, what
 * get_next actually runs) and a JS evaluator (claim-spec-match.ts, used by the assignment-
 * admission seams). They disagreed on exactly the shape that starved the fleet: JS's
 * `!matchLeaf(...)` ADMITS a null row while SQL's `NOT (...)` DROPPED it. Every case below
 * asserts BOTH engines agree, so they can never drift apart again unnoticed.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-null-semantics.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyEventSubstrateMigrationsForTest,
  COORD_SUBSCRIPTION_SUBSTRATE,
  createFreshPgDb,
  type FreshPgDb,
} from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { ClaimSpec, FilterNode } from './claim-spec';
import type { ClaimSpecSubject } from './claim-spec-match';
import type { WorkItem } from '../work-items';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// WI-10004742 / EI-24400810686776632: getNextWorkItem reads the operation-worker receipt from
// adv_sessions + session_briefs, which this fixture never builds, so every claim failed closed
// ('operation claim authority unavailable'). The subject is claim-spec NULL semantics, not
// operation claims: stub the read to "no operation worker", as work-items.integration does.
vi.mock('../blueprint/operation-worker-binding', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' }) };
});

const { getNextWorkItem } = await import('./get-next');
const { validateClaimSpec } = await import('./claim-spec');
const { matchesClaimSpecFilter, claimSpecSubjectFromWorkItem } = await import('./claim-spec-match');

const H = 'papercup';
const WS = 'default';
const PEER_PLAN = 'carry-idle-plans-to-completion-2026-07-17';
let db: FreshPgDb;

/** Seed a feature row with an EXPLICIT plan (or NULL — the case the whole file is about). */
async function seedFeature(id: string, opts: { plan?: string | null; createdTs?: number } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, source_plan_slug, title)
    VALUES (${H}, ${id}, 'feature', 'open', ${null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${opts.plan ?? null}, ${id})`;
}

/** Seed a feature row whose plan/tags live ONLY in `payload` — the column stays NULL
 *  (EI-18654360178824151's exact repro shape: WI-5781/WI-5779 had plan linkage written to
 *  `payload.plan_item.plan_slug` / `payload.tags` but the `source_plan_slug`/`tags` columns
 *  were never backfilled). */
async function seedFeatureWithPayloadOnlyPlan(
  id: string,
  opts: { planSlugInPayload?: string; tagsInPayload?: string[]; createdTs?: number } = {},
) {
  const payload = {
    ...(opts.planSlugInPayload ? { plan_item: { plan_slug: opts.planSlugInPayload } } : {}),
    ...(opts.tagsInPayload ? { tags: opts.tagsInPayload } : {}),
  };
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, source_plan_slug, tags, payload, title)
    VALUES (${H}, ${id}, 'feature', 'open', ${null}, ${WS},
       ${opts.createdTs ?? 0}, 0, ${null}, ${null}, ${db.sql.json(payload)}, ${id})`;
}

function spec(filter: FilterNode): ClaimSpec {
  const s: ClaimSpec = {
    specVersion: '1.0',
    specId: 'null-semantics',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
  const v = validateClaimSpec(s);
  // The trap's signature is that the spec VALIDATES and then mis-executes, so assert
  // validity explicitly — a filter rejected here would make the behavior tests vacuous.
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

/** The raw MCP-authored form: validation expands the named macro into the exact
 * filter persisted by scheduler:set_claim_spec and executed by get_next. */
function p2pLaneMacroSpec(): ClaimSpec {
  const v = validateClaimSpec({
    specVersion: '1.0',
    specId: 'p2p-lane-macro-structural-plan',
    revision: 1,
    view: { fence: 'p2p-lane' },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  });
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  if (!v.spec?.view.filter) throw new Error('p2p-lane macro did not expand into a filter');
  return v.spec;
}

/** The JS-evaluator subject for a row with NO plan — the mirror of seedFeature({plan:null}). */
function nullPlanSubject(id: string): ClaimSpecSubject {
  return {
    id,
    title: id,
    summary: null,
    kind: 'feature',
    priority: null,
    tags: [],
    paths: [],
    plan: null,
    planItem: [],
    fleet: null,
    triageGate: null,
    itemClass: 'work',
    age: 0,
    riskTier: null,
    redundancy: null,
    estCost: null,
    assignee: null,
    severity: null,
    goal: null,
  };
}

const BEE = { assignee: 'bee-1' };

beforeAll(async () => {
  db = await createFreshPgDb('sched-null-semantics');
  h.sql = db.sql;
  // Every successful get_next claim emits an awaited-event key through the real
  // runtime path. Its durable fire latch is migration 632; without this table the
  // fail-soft emit logs a warning, and vitest-fail-on-console turns it into a red
  // unrelated to the NULL-semantics assertions.
  // The key-fire latch resolves subscribers from event_awaits (WI-10004234), so the
  // whole shared event substrate is needed, not just event_key_fires (WI-10004700).
  // The latch's subscriber lookup also reads coord_entity_subscriptions (123, last widened
  // by 1257): same coordination extras as get-next and work-items-release-request.
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'scheduler/claim-spec-null-semantics.integration.test.ts',
    ...COORD_SUBSCRIPTION_SUBSTRATE,
  });
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await db.sql
    .unsafe(
      `
    ALTER TABLE harness_shared.work_items
      ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: false });
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps `;
});

// ────────────────────────────────────────────────────────────────────────────
// The regression: a negated predicate over a NULLABLE field must not eat the backlog.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-13306 — a `not`/`!=` fence over a NULLABLE field admits NULL rows', () => {
  it('not:{plan = X} ADMITS a row whose plan is NULL (the exact fence that collapsed 2341 -> 4)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: '=', value: PEER_PLAN } }), BEE, { harness: H });
    // Before the fix this was null: NOT (NULL = 'X') is NULL, so the row was dropped and the
    // fleet starved while the queue was full.
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('not:{plan glob X} ADMITS a row whose plan is NULL (EI-13306 original repro)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: 'glob', value: 'p2p-*' } }), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('plan != X ADMITS a NULL-plan row — consistent with the array branches', async () => {
    // text-array `!=` already compiled to NOT (v = ANY(COALESCE(col, ARRAY[]::text[]))) => true
    // on an absent value. Scalar `<>` was the odd one out, yielding NULL -> dropped.
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ field: 'plan', op: '!=', value: PEER_PLAN }), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-noplan');
  });

  it('the fence still EXCLUDES the plan it names — null-safety did not widen it into a no-op', async () => {
    // The inverse failure: "fix" the NULL drop by making the filter match everything. The
    // fence must still do its job, or the peer-fleet collision it exists to prevent returns.
    await seedFeature('F-peer', { plan: PEER_PLAN });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: '=', value: PEER_PLAN } }), BEE, { harness: H });
    expect(r).toBeNull();
  });

  it('fences OUT the named plan while KEEPING the NULL-plan backlog — the real-world spec', async () => {
    await seedFeature('F-peer', { plan: PEER_PLAN, createdTs: 10 }); // oldest: rank would pick it first
    await seedFeature('F-mine', { plan: null, createdTs: 20 });
    await seedFeature('F-other', { plan: 'some-other-plan', createdTs: 30 });
    const s = spec({
      all: [
        { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'feature'] },
        { not: { field: 'plan', op: '=', value: PEER_PLAN } },
      ],
    });
    const first = await getNextWorkItem(s, BEE, { harness: H });
    expect(first?.workItem.id).toBe('F-mine'); // NOT F-peer, and NOT starved to null
    const second = await getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H });
    expect(second?.workItem.id).toBe('F-other');
    const third = await getNextWorkItem(s, { assignee: 'bee-3' }, { harness: H });
    expect(third).toBeNull(); // only the correctly-fenced peer row remains
  });

  it('a positive plan = X still EXCLUDES a NULL-plan row (null-safety is directional)', async () => {
    await seedFeature('F-noplan', { plan: null });
    const r = await getNextWorkItem(spec({ field: 'plan', op: '=', value: PEER_PLAN }), BEE, { harness: H });
    expect(r).toBeNull();
  });
});

describe('WI-5280 — raw p2p-lane macro fences source-plan provenance in both evaluators', () => {
  it('excludes a neutral-title p2p-* plan while preserving NULL and nonp2p plan controls', async () => {
    const p2pPlan = 'p2p-public-release-endgame-2026-09-01';
    const nonP2pPlan = 'nonp2p-feature-change-drain-2026-09-04-v3';
    await seedFeature('F-p2p-neutral', { plan: p2pPlan, createdTs: 10 });
    await seedFeature('F-unplanned-control', { plan: null, createdTs: 20 });
    await seedFeature('F-nonp2p-control', { plan: nonP2pPlan, createdTs: 30 });

    const s = p2pLaneMacroSpec();

    // Engine 1: the real SQL compiler. The oldest row is the leaked P2P item,
    // so selecting both controls and then returning null proves it was fenced.
    const first = await getNextWorkItem(s, BEE, { harness: H });
    const second = await getNextWorkItem(s, { assignee: 'bee-2' }, { harness: H });
    const third = await getNextWorkItem(s, { assignee: 'bee-3' }, { harness: H });
    expect([first?.workItem.id, second?.workItem.id]).toEqual(['F-unplanned-control', 'F-nonp2p-control']);
    expect(third).toBeNull();

    // Engine 2: assignment-admission's JS evaluator must make the same three
    // decisions from the expanded raw macro, not merely from a hand-built leaf.
    const filter = s.view.filter!;
    expect(matchesClaimSpecFilter({ ...nullPlanSubject('F-p2p-neutral'), plan: p2pPlan }, filter)).toBe(false);
    expect(matchesClaimSpecFilter(nullPlanSubject('F-unplanned-control'), filter)).toBe(true);
    expect(matchesClaimSpecFilter({ ...nullPlanSubject('F-nonp2p-control'), plan: nonP2pPlan }, filter)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Parity: the SQL compiler and the JS evaluator must agree on a NULL subject.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-13306 — SQL compiler and JS evaluator agree on NULL subjects', () => {
  const cases: Array<{ name: string; filter: FilterNode; admits: boolean }> = [
    { name: 'not:{plan = X}', filter: { not: { field: 'plan', op: '=', value: PEER_PLAN } }, admits: true },
    { name: 'not:{plan glob p2p-*}', filter: { not: { field: 'plan', op: 'glob', value: 'p2p-*' } }, admits: true },
    { name: 'plan != X', filter: { field: 'plan', op: '!=', value: PEER_PLAN }, admits: true },
    { name: 'plan = X', filter: { field: 'plan', op: '=', value: PEER_PLAN }, admits: false },
    { name: 'plan glob p2p-*', filter: { field: 'plan', op: 'glob', value: 'p2p-*' }, admits: false },
    { name: 'plan in [X]', filter: { field: 'plan', op: 'in', value: [PEER_PLAN] }, admits: false },
    // Double negation must round-trip rather than re-poison on the inner NULL.
    { name: 'not:{plan != X}', filter: { not: { field: 'plan', op: '!=', value: PEER_PLAN } }, admits: false },
    // A NULL leaf nested inside a combinator must not poison its healthy siblings.
    {
      name: 'all:[kind in [feature], not:{plan = X}]',
      filter: {
        all: [{ field: 'kind', op: 'in', value: ['feature'] }, { not: { field: 'plan', op: '=', value: PEER_PLAN } }],
      },
      admits: true,
    },
    {
      name: 'any:[plan = X, kind in [feature]]',
      filter: {
        any: [
          { field: 'plan', op: '=', value: PEER_PLAN },
          { field: 'kind', op: 'in', value: ['feature'] },
        ],
      },
      admits: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} on a NULL-plan row: both engines ${c.admits ? 'ADMIT' : 'EXCLUDE'}`, async () => {
      await seedFeature('F-noplan', { plan: null });

      // Engine 1 — the SQL compiler, via a real get_next against real Postgres.
      const sqlAdmits = (await getNextWorkItem(spec(c.filter), BEE, { harness: H }))?.workItem.id === 'F-noplan';
      // Engine 2 — the JS evaluator used by the assignment-admission seams.
      const jsAdmits = matchesClaimSpecFilter(nullPlanSubject('F-noplan'), c.filter);

      expect(sqlAdmits, `SQL compiler disagreed with the expectation for ${c.name}`).toBe(c.admits);
      expect(jsAdmits, `JS evaluator disagreed with the expectation for ${c.name}`).toBe(c.admits);
      // Stated separately: even if BOTH were to drift to the same wrong answer, the cases
      // above fail — but this is the invariant that actually matters, so name it.
      expect(sqlAdmits, `ENGINE DIVERGENCE on ${c.name}: SQL=${sqlAdmits} JS=${jsAdmits}`).toBe(jsAdmits);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// EI-18654360178824151 — FIELD agreement: plan/tags living ONLY in payload (the
// physical column NULL) must be resolved IDENTICALLY by both evaluators.
//
// This is a DIFFERENT axis from the parity suite above (which pins NULL-subject
// *operator* semantics for a genuinely plan-less row). Here the row DOES have a
// plan/tag, but it was only ever written to `payload` (the shape createAdmissionSubject
// / plan-linked work admits on) while the `source_plan_slug`/`tags` COLUMNS the SQL
// compiler's FIELD_MAP read stayed NULL. Before the fix, `featureMatchesRecord`
// (feature-family assignment admission, SQL) and `claimNextIssueWorkItem`/`get_next`'s
// own compileFilter (self-select, also SQL — same FIELD_MAP) disagreed with
// `matchesWorkItemClaimSpec` (assignment admission for anything else, JS — reads
// `payload.plan_item`/`payload.tags` via `planSlugOfWorkItem`/`staticTagsOfWorkItem`):
// the JS side admitted the item, the SQL side refused it (WI-5781/WI-5779). The fix
// COALESCEs the SQL FIELD_MAP column with the exact same payload derivation, so the
// two representations of ONE logical field can no longer disagree.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-18654360178824151 — SQL FIELD_MAP and JS evaluator agree when plan/tags live only in payload', () => {
  /** The JS-evaluator subject for a row whose plan/tags live ONLY in payload — mirrors
   *  {@link seedFeatureWithPayloadOnlyPlan} so both engines see the identical shape. */
  function payloadOnlyPlanItem(id: string, opts: { planSlugInPayload?: string; tagsInPayload?: string[] }): WorkItem {
    return {
      id,
      kind: 'feature' as WorkItem['kind'],
      family: 'feature',
      harness: H,
      title: id,
      summary: '',
      state: 'open',
      assignee: null,
      takenAt: null,
      lastProgressAt: null,
      assignedBy: null,
      severity: null,
      parent: null,
      payload: {
        ...(opts.planSlugInPayload ? { plan_item: { plan_slug: opts.planSlugInPayload } } : {}),
        ...(opts.tagsInPayload ? { tags: opts.tagsInPayload } : {}),
      },
      origin: 'local',
      auditVerdict: null,
      verifiedAuthorGithubUserId: null,
      rank: null,
      rankWriter: null,
      rankUpdatedAt: null,
      priority: null,
      terminalOwner: null,
      terminalCompletionRef: null,
      terminalCompletionEvidence: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as WorkItem;
  }

  it('plan = X ADMITS a row whose plan lives ONLY in payload.plan_item.plan_slug (WI-5781 shape)', async () => {
    await seedFeatureWithPayloadOnlyPlan('F-payload-plan', { planSlugInPayload: PEER_PLAN });

    const sqlAdmits =
      (await getNextWorkItem(spec({ field: 'plan', op: '=', value: PEER_PLAN }), BEE, { harness: H }))?.workItem.id ===
      'F-payload-plan';
    const jsAdmits = matchesClaimSpecFilter(
      claimSpecSubjectFromWorkItem(payloadOnlyPlanItem('F-payload-plan', { planSlugInPayload: PEER_PLAN })),
      { field: 'plan', op: '=', value: PEER_PLAN },
    );

    expect(jsAdmits, 'sanity: the JS evaluator was already admitting this shape pre-fix').toBe(true);
    expect(sqlAdmits, 'SQL FIELD_MAP must COALESCE the payload-derived plan, mirroring planSlugOfWorkItem').toBe(true);
    expect(sqlAdmits, `ENGINE DIVERGENCE: SQL=${sqlAdmits} JS=${jsAdmits}`).toBe(jsAdmits);
  });

  it('tags contains X ADMITS a row whose tag lives ONLY in payload.tags (WI-5779 shape)', async () => {
    await seedFeatureWithPayloadOnlyPlan('F-payload-tag', { tagsInPayload: ['p2p-release'] });

    const sqlAdmits =
      (await getNextWorkItem(spec({ field: 'tags', op: 'contains', value: 'p2p-release' }), BEE, { harness: H }))
        ?.workItem.id === 'F-payload-tag';
    const jsAdmits = matchesClaimSpecFilter(
      claimSpecSubjectFromWorkItem(payloadOnlyPlanItem('F-payload-tag', { tagsInPayload: ['p2p-release'] })),
      { field: 'tags', op: 'contains', value: 'p2p-release' },
    );

    expect(jsAdmits, 'sanity: the JS evaluator was already admitting this shape pre-fix').toBe(true);
    expect(sqlAdmits, 'SQL FIELD_MAP must COALESCE the payload-derived tags, mirroring staticTagsOfWorkItem').toBe(
      true,
    );
    expect(sqlAdmits, `ENGINE DIVERGENCE: SQL=${sqlAdmits} JS=${jsAdmits}`).toBe(jsAdmits);
  });

  it('the column still WINS when both column and payload are set (no regression on the common case)', async () => {
    await seedFeature('F-column-plan', { plan: PEER_PLAN });
    const r = await getNextWorkItem(spec({ field: 'plan', op: '=', value: PEER_PLAN }), BEE, { harness: H });
    expect(r?.workItem.id).toBe('F-column-plan');
  });

  it('a NEGATIVE plan fence still EXCLUDES a payload-only-plan row it names (COALESCE did not defeat the fence)', async () => {
    await seedFeatureWithPayloadOnlyPlan('F-payload-plan-excluded', { planSlugInPayload: PEER_PLAN });
    const r = await getNextWorkItem(spec({ not: { field: 'plan', op: '=', value: PEER_PLAN } }), BEE, { harness: H });
    expect(r).toBeNull();
  });

  // EI-18655872778244196 (measured live 2026-07-25, fleet p2p-release, spec rev7): a
  // positive `tags` filter over ISSUE-family (bug/change/task) rows matched ZERO of
  // 10436 items and starved 11 agents for ~4.5h. `harness_shared.work_items.tags` is
  // universally NULL for issue-kind rows because `work_items:tag` (via
  // mirrorTopicTagToClaimTags / syncTopicTagToClaimTags) writes issue-family tags to
  // `payload.tags`, never the `tags` column — by design, mirroring the JS evaluator's
  // `staticTagsOfWorkItem`. The suite above only ever seeds `item_kind: 'feature'`; this
  // pins the EXACT issue-kind shape the live incident hit, so a future regression in the
  // FIELD_MAP COALESCE (or a kind-specific code path) fails here instead of only
  // resurfacing as a live fleet starvation. (Live-verified separately via
  // `work_items:claimable` post-fix: matchedByFilter 0→13, claimableCount 0→9 on the
  // actual p2p-release-lane spec.)
  async function seedIssueWithPayloadOnlyTags(id: string, tagsInPayload: string[], createdTs = 0) {
    await db.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
         created_ts, updated_ts, source_plan_slug, tags, payload, title)
      VALUES (${H}, ${id}, 'bug', 'open', ${null}, ${WS},
         ${createdTs}, 0, ${null}, ${null}, ${db.sql.json({ tags: tagsInPayload })}, ${id})`;
  }

  it('tags contains X ADMITS an ISSUE-family (bug) row whose tag lives ONLY in payload.tags (EI-18655872778244196 shape)', async () => {
    // Tier 1/2 query `harness_features_consolidated`, which structurally EXCLUDES
    // item_kind bug/change/task (view WHERE item_kind NOT IN (...)) — only tier 3
    // (claimNextIssueWorkItem, gated by SCHEDULER_ISSUES_CLAIMABLE) can ever serve an
    // issue-family row. The file-level beforeEach defaults this flag OFF for the
    // feature-family NULL-semantics suites above; this issue-kind case needs it ON.
    setFlagOverridesForTest({ [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true });
    await seedIssueWithPayloadOnlyTags('EI-payload-tag-bug', ['p2p-release']);

    const sqlAdmits =
      (await getNextWorkItem(spec({ field: 'tags', op: 'contains', value: 'p2p-release' }), BEE, { harness: H }))
        ?.workItem.id === 'EI-payload-tag-bug';
    const jsAdmits = matchesClaimSpecFilter(
      claimSpecSubjectFromWorkItem({
        ...payloadOnlyPlanItem('EI-payload-tag-bug', { tagsInPayload: ['p2p-release'] }),
        kind: 'bug',
        family: 'issue',
      } as WorkItem),
      { field: 'tags', op: 'contains', value: 'p2p-release' },
    );

    expect(jsAdmits, 'sanity: the JS evaluator already admitted this issue-kind shape pre-fix').toBe(true);
    expect(
      sqlAdmits,
      'SQL FIELD_MAP must COALESCE the payload-derived tags for ISSUE-family rows too, not only feature-family',
    ).toBe(true);
    expect(sqlAdmits, `ENGINE DIVERGENCE on issue-kind: SQL=${sqlAdmits} JS=${jsAdmits}`).toBe(jsAdmits);
  });
});
