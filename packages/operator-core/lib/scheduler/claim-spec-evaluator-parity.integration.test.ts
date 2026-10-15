/**
 * claim-spec-evaluator-parity.integration.test.ts — WI-5995.
 *
 * ONE spec language, TWO evaluators. This is the STANDING parity guard over the pair.
 *
 *   • the SQL compiler — `compileFilter`/`compileLeaf` (get-next.ts), what `scheduler:get_next`,
 *     `work_items:claimable` and the miss-diagnosis breakdown actually execute;
 *   • the JS evaluator — `matchesClaimSpecFilter` (claim-spec-match.ts), what by-id claims,
 *     create+assign, plan-item dispatch and get_next's own post-claim re-check execute.
 *
 * That seam has now diverged FOUR times, each found in production by a starved or mis-served
 * fleet rather than by a test: EI-13306 (scalar `not`/`!=` over a NULL column dropped the
 * backlog — measured 2341 -> 4), EI-18654360178824151 / WI-5781 (plan+tags resolved from
 * different logical sources), WI-5995 itself (this file), and the json-array `!=` null-drop
 * pinned below. Each was fixed with a POINT fix plus a hand-written case list naming the shape
 * that had just burned someone. A hand-written case list cannot fail for a shape nobody has
 * been burned by yet — which is why the fourth divergence was found by a fleet, not by
 * claim-spec-null-semantics.integration.test.ts sitting right next to it.
 *
 * So this file is deliberately NOT another case list. It is a PROPERTY over a cross-product:
 * every (field x op) leaf the spec language admits, each emitted BOTH bare and wrapped in
 * `not:`, evaluated against a corpus of rows covering set / absent / empty / column-only /
 * payload-only for every field. ~N_filters x N_rows verdict pairs; both engines must agree on
 * every one. A new op, a new field, or a new FIELD_MAP entry is covered the day it is added,
 * with no test edit — and every disagreement is collected and reported TOGETHER, so a
 * regression shows its full blast radius instead of one arbitrary first failure.
 *
 * ⚠ THE SUBJECT IS BUILT BY THE REAL MAPPER, NOT HAND-MIRRORED. Every prior parity test in
 * this directory builds its JS-side subject from a hand-written `WorkItem` literal that the
 * test author kept in sync with the seeded row by eye. That cannot see a whole CLASS of
 * divergence — the one where the row projection feeding the JS evaluator never carried the
 * column at all — and it silently passes when the mirror drifts. Here the row is seeded, read
 * BACK through the same `FEATURE_COLS` projection the production read path uses, and mapped by
 * the real `featureRowToWorkItem` -> `claimSpecSubjectFromWorkItem`. The two engines therefore
 * disagree here for exactly the reasons they would disagree in production.
 *
 * Real Postgres (testcontainer; Docker required) ON PURPOSE: the defects in this class are SQL
 * three-valued-logic and collation behaviours. A unit test asserting the emitted SQL string
 * contains "COALESCE" would pin the implementation while proving nothing about the verdict.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-spec-evaluator-parity.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { FilterLeaf, FilterNode } from './claim-spec';
import type { ClaimSpecSubject } from './claim-spec-match';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const { compileFilter } = await import('./get-next');
const { validateClaimSpec } = await import('./claim-spec');
const { matchesClaimSpecFilter, claimSpecSubjectFromWorkItem } = await import('./claim-spec-match');
const { featureRowToWorkItem, FEATURE_COLS, issueToWorkItem } = await import('../work-items');
const { toIssue, ISSUE_COLS } = await import('../issues-engineer');

const H = 'papercup';
const ISSUE_H = 'papercup-issue-parity';
const WS = 'default';
let db: FreshPgDb;

// ────────────────────────────────────────────────────────────────────────────
// The row corpus. Each row isolates one axis of how a field's value can reach
// (or fail to reach) an evaluator.
// ────────────────────────────────────────────────────────────────────────────

interface SeedRow {
  id: string;
  /** Why this row is in the corpus — quoted into the divergence report. */
  why: string;
  title: string;
  /** EI-20240035377782004: defaults to '' (matching every pre-existing row's seeded value). */
  summary?: string;
  createdTs: number;
  featureOrder?: number | null;
  planSlugCol?: string | null;
  planItemIdsCol?: string[] | null;
  tagsCol?: unknown;
  goalId?: string | null;
  takenBy?: string | null;
  redundancy?: number | null;
  expectedCostCents?: number | null;
  payload?: Record<string, unknown> | null;
}

const PLAN = 'plan-alpha';

const ROWS: SeedRow[] = [
  {
    id: 'F-agree',
    why: 'CONTROL: every field set, and set IDENTICALLY in its column and its payload leg, so any '
      + 'divergence on this row is an OPERATOR bug, never a source-split one.',
    title: 'p2p data path is ~95% LOSSY, not dead',
    createdTs: 1000,
    featureOrder: 5,
    planSlugCol: PLAN,
    planItemIdsCol: ['P-001'],
    tagsCol: ['p2p-release', 'infra'],
    goalId: 'G-1',
    takenBy: 'agent-1',
    redundancy: 3,
    expectedCostCents: 500,
    payload: {
      tags: ['p2p-release', 'infra'],
      paths: ['libs/generic/a.ts'],
      plan_item: { plan_slug: PLAN, item_id: 'P-001' },
      risk_tier: 'high',
      est_cost: 500,
      redundancy: 3,
      // EI-16052: `triage_gate` is payload-only (`payload.ideaLifecycle.triageDecision`), so
      // it is only covered NON-VACUOUSLY if some row actually carries a decision. Without
      // this stamp both engines resolve null on every row and agree for the trivial reason —
      // a green that proves nothing, which is exactly the failure this corpus exists to
      // catch. With it, F-agree exercises the 'gate' value and F-absent (no payload at all)
      // exercises the null/negation polarity, on both engines, for every op.
      ideaLifecycle: { triageDecision: 'gate' },
      // P-005: `item_class` reads payload.sourceRole — stamp it so F-agree is 'ideation' and
      // F-absent is 'work', exercising both values on both engines (non-vacuous parity).
      sourceRole: 'Scout',
    },
  },
  {
    id: 'F-absent',
    why: 'Every optional field ABSENT — the null-poison probe. A negated predicate must ADMIT this '
      + 'row (a row with no plan is certainly not in plan X); a positive one must refuse it.',
    title: 'plain backlog item',
    createdTs: 2000,
  },
  {
    id: 'F-payload-only',
    why: 'plan/tags/paths live ONLY in payload, columns NULL — the WI-5781 / EI-18654360178824151 '
      + 'shape the SQL FIELD_MAP was COALESCEd to resolve.',
    title: 'payload-only linkage',
    createdTs: 3000,
    payload: {
      tags: ['infra'],
      paths: ['libs/generic/b.ts'],
      plan_item: { plan_slug: PLAN, item_id: 'P-002' },
      risk_tier: 'low',
      est_cost: 250,
      redundancy: 2,
    },
  },
  {
    id: 'F-column-only',
    why: 'The MIRROR of F-payload-only: plan/tags/plan_item/redundancy/est_cost live ONLY in their '
      + 'COLUMNS, payload NULL. This is the DEFAULT shape for anything written through the standard '
      + 'writer (source_plan_slug is the indexed, authoritative leg), so it is not an edge case — it '
      + 'is the common one, and it is the axis a hand-mirrored subject structurally cannot test.',
    title: 'column-only linkage',
    createdTs: 4000,
    planSlugCol: PLAN,
    planItemIdsCol: ['P-003'],
    tagsCol: ['infra'],
    redundancy: 2,
    expectedCostCents: 250,
  },
  {
    id: 'F-empty',
    why: 'EMPTY arrays rather than absent ones — `[]` and NULL are different values in both engines '
      + 'and must still produce the same verdict.',
    title: 'empty collections',
    createdTs: 5000,
    tagsCol: [],
    planItemIdsCol: [],
    payload: { tags: [], paths: [] },
  },
  {
    id: 'F-nonp2p',
    why: 'The `word`-vs-`glob` discriminator (EI-18690730909662985): a `*p2p*` GLOB matches this '
      + 'title, a `p2p` WORD must not. Both engines must draw that boundary in the same place.',
    title: 'nonp2p-bug-drain member cannot claim this',
    createdTs: 6000,
  },
  {
    id: 'F-snake',
    why: 'The snake_case word boundary (WI-5639): Postgres \\m/\\M and JS \\b BOTH count `_` as a '
      + 'word character, which is why both engines use explicit [^A-Za-z0-9] classes instead. This '
      + 'row fails if either drifts back to the built-in anchors.',
    title: 'replication_soak: connected_never_replicated after 13.0s',
    createdTs: 7000,
  },
  {
    id: 'F-case',
    why: 'Case-folding parity: ILIKE / `~*` (Postgres, collation-driven) vs the JS `i` regex flag.',
    title: 'Hyperswarm Sidecar ISOLATION',
    createdTs: 8000,
  },
  {
    id: 'F-summary-only',
    why: 'EI-20240035377782004: the actual live leak shape — a p2p/federation TELL that lives ONLY '
      + 'in the summary/body text, with a completely generic title. A title-only fence field admits '
      + 'this row; both engines must now agree it is excluded once `summary` is filterable.',
    title: 'Follow up on outstanding review feedback',
    summary: 'Team accepted P-205 Mac peer for the next round of federation drills.',
    createdTs: 9000,
  },
  {
    id: 'F-p2p-plan-column',
    why: 'P-207 regression: a neutral issue title and summary still carry structured P2P source_plan_slug.',
    title: 'Neutral plan-scoped bug title',
    summary: 'The generic summary carries no P2P transport terms.',
    createdTs: 10000,
    planSlugCol: 'p2p-public-release-endgame-2026-09-01',
    planItemIdsCol: ['P-401'],
  },
  {
    id: 'F-p2p-plan-payload',
    why: 'P-207 regression: plan scope may be present only in payload.plan_item.plan_slug.',
    title: 'Neutral payload-plan bug title',
    summary: 'The generic summary carries no P2P transport terms.',
    createdTs: 11000,
    payload: { plan_item: { plan_slug: 'p2p-public-release-endgame-2026-09-01', item_id: 'P-401' } },
  },
  {
    id: 'F-nonp2p-plan',
    why: 'P-207 negative control: the whole-word plan fence must preserve nonp2p-* plans.',
    title: 'Neutral non-P2P plan-scoped bug title',
    summary: 'The generic summary carries no P2P transport terms.',
    createdTs: 12000,
    planSlugCol: 'nonp2p-feature-change-drain-2026-09-04-v3',
  },
];

async function seed(r: SeedRow) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, title, summary,
       created_ts, updated_ts, feature_order, source_plan_slug, source_plan_item_ids,
       tags, goal_id, taken_by, redundancy, expected_cost_cents, payload)
    VALUES (${H}, ${r.id}, 'feature', 'open', ${WS}, ${r.title}, ${r.summary ?? ''},
       ${r.createdTs}, 0, ${r.featureOrder ?? null}, ${r.planSlugCol ?? null},
       ${r.planItemIdsCol ?? null}, ${r.tagsCol === undefined ? null : db.sql.json(r.tagsCol as never)},
       ${r.goalId ?? null}, ${r.takenBy ?? null}, ${r.redundancy ?? null},
       ${r.expectedCostCents ?? null},
       ${r.payload === undefined || r.payload === null ? null : db.sql.json(r.payload as never)})`;
}

/** Seed the same corpus through the issue-family relation so the JS side is
 * built from ISSUE_COLS + toIssue + issueToWorkItem, not a hand mirror. */
async function seedIssue(r: SeedRow) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, workspace_id, title, summary,
       created_ts, updated_ts, source_plan_slug, source_plan_item_ids, tags,
       goal_id, taken_by, redundancy, expected_cost_cents, payload)
    VALUES (${ISSUE_H}, ${`I-${r.id}`}, 'bug', 'open', ${WS}, ${r.title}, ${r.summary ?? ''},
       ${r.createdTs}, 0, ${r.planSlugCol ?? null}, ${r.planItemIdsCol ?? null},
       ${r.tagsCol === undefined ? null : db.sql.json(r.tagsCol as never)},
       ${r.goalId ?? null}, ${r.takenBy ?? null}, ${r.redundancy ?? null},
       ${r.expectedCostCents ?? null},
       ${r.payload === undefined || r.payload === null ? null : db.sql.json(r.payload as never)})`;
}

// ────────────────────────────────────────────────────────────────────────────
// The filter corpus: every (field x op) the language admits, bare AND negated.
// ────────────────────────────────────────────────────────────────────────────

/** One probe value per field, chosen so the corpus splits — some rows match, some do not. */
const LEAF_SPECS: Array<{ field: FilterLeaf['field']; ops: FilterLeaf['op'][]; value: unknown; inValue: unknown[] }> = [
  { field: 'id', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'F-agree', inValue: ['F-agree', 'F-absent'] },
  { field: 'title', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'p2p', inValue: ['p2p'] },
  // EI-20240035377782004: same shape as `title` — a real physical column on both families,
  // wired through both engines for the first time by this fix.
  { field: 'summary', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'federation', inValue: ['federation'] },
  { field: 'kind', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'feature', inValue: ['feature', 'bug'] },
  { field: 'plan', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: PLAN, inValue: [PLAN] },
  { field: 'risk_tier', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'high', inValue: ['high', 'low'] },
  { field: 'assignee', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'agent-1', inValue: ['agent-1'] },
  { field: 'goal', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'G-1', inValue: ['G-1'] },
  { field: 'priority', ops: ['=', '!=', 'in', '<', '<=', '>', '>='], value: 5, inValue: [5] },
  { field: 'age', ops: ['=', '!=', 'in', '<', '<=', '>', '>='], value: 4000, inValue: [4000] },
  { field: 'redundancy', ops: ['=', '!=', 'in', '<', '<=', '>', '>='], value: 1, inValue: [1, 2] },
  { field: 'est_cost', ops: ['=', '!=', 'in', '<', '<=', '>', '>='], value: 250, inValue: [250] },
  { field: 'tags', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'infra', inValue: ['infra'] },
  { field: 'paths', ops: ['=', '!=', 'in', 'glob', 'word', 'contains'], value: 'libs/generic/b.ts', inValue: ['libs/generic/b.ts'] },
  { field: 'plan_item', ops: ['=', '!=', 'in', 'contains'], value: 'P-003', inValue: ['P-001', 'P-003'] },
];

/** A glob/word probe per text field, so the wildcard paths get their own coverage. */
const GLOB_PROBES: Array<{ field: FilterLeaf['field']; value: string }> = [
  { field: 'title', value: '*p2p*' },
  { field: 'title', value: '*LOSSY*' },
  { field: 'title', value: '*replication*' },
  { field: 'summary', value: '*federation*' },
  { field: 'summary', value: '*P-205*' },
  { field: 'plan', value: 'plan-*' },
  { field: 'tags', value: '*infra*' },
  { field: 'paths', value: 'libs/generic/*' },
];

interface Probe {
  name: string;
  filter: FilterNode;
}

function buildProbes(): Probe[] {
  const out: Probe[] = [];
  const push = (name: string, leaf: FilterNode) => {
    out.push({ name, filter: leaf });
    out.push({ name: `not:{${name}}`, filter: { not: leaf } });
  };

  for (const spec of LEAF_SPECS) {
    for (const op of spec.ops) {
      const value = op === 'in' ? spec.inValue : spec.value;
      push(`${spec.field} ${op} ${JSON.stringify(value)}`, { field: spec.field, op, value } as FilterLeaf);
    }
  }
  for (const g of GLOB_PROBES) {
    push(`${g.field} glob ${g.value}`, { field: g.field, op: 'glob', value: g.value } as FilterLeaf);
    // `word` takes a literal, not a pattern — strip the wildcards for its probe.
    const literal = g.value.replace(/\*/g, '');
    push(`${g.field} word ${literal}`, { field: g.field, op: 'word', value: literal } as FilterLeaf);
  }

  // Same-field word alternatives share a compiled regex. Exercise its literal
  // escaping, overlapping alternatives, case, empty words and NULLs against
  // the independent evaluator and actual mapped rows, both bare and negated.
  for (const field of ['title', 'summary', 'plan'] as const) {
    for (const values of [
      ['p2p', 'data path', 'LOSSY', 'federation', PLAN],
      ['p2', 'p2p', 'p2p-release', 'infra', 'infra'],
      ['x.y', '(infra)', 'a|b', '[p2p]', '95%', 'not dead'],
      ['', 'replication', 'replication_soak', 'plan-alpha'],
    ]) {
      const any = values.map((value): FilterLeaf => ({ field, op: 'word', value }));
      push(`${field} grouped literal words ${JSON.stringify(values)}`, { any });
    }
    push(`${field} grouped words with a nested alternative`, { any: [
      { field, op: 'word', value: 'p2p' },
      { not: { field: 'goal', op: '=', value: 'G-1' } },
      { field, op: 'word', value: PLAN },
      { field: 'tags', op: 'word', value: 'infra' },
    ] });
  }

  // Combinators over a NULL-valued leaf: a poisoned leaf must not contaminate its siblings.
  out.push({
    name: 'all:[kind = feature, not:{plan = PLAN}]',
    filter: { all: [{ field: 'kind', op: '=', value: 'feature' }, { not: { field: 'plan', op: '=', value: PLAN } }] },
  });
  out.push({
    name: 'any:[plan = PLAN, kind = feature]',
    filter: { any: [{ field: 'plan', op: '=', value: PLAN }, { field: 'kind', op: '=', value: 'feature' }] },
  });
  out.push({
    name: 'not:{not:{plan = PLAN}} (double negation round-trips)',
    filter: { not: { not: { field: 'plan', op: '=', value: PLAN } } },
  });
  out.push({
    name: 'the live p2p fence: all:[kind = feature, not:{title word p2p}, not:{tags contains p2p-release}]',
    filter: {
      all: [
        { field: 'kind', op: '=', value: 'feature' },
        { not: { field: 'title', op: 'word', value: 'p2p' } },
        { not: { field: 'tags', op: 'contains', value: 'p2p-release' } },
      ],
    },
  });
  return out;
}

const PROBES = buildProbes();

// ────────────────────────────────────────────────────────────────────────────
// The known-divergence allowlist — SHRINK-ONLY, and it PROVES it is shrink-only.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fields whose two evaluators are KNOWN to resolve from different logical sources, filed as
 * WI-38326 with the mechanism, the per-field counts and the live census. They are excluded from
 * the agreement property below ONLY so this guard can land GREEN and start protecting every
 * OTHER field today, instead of sitting red (and therefore ignored, or deleted) until a change
 * to `WorkItem` + `FEATURE_COLS` + both row mappers is safe to make.
 *
 * ⚠ THIS IS NOT A PARKING LOT, AND THE MECHANISM THAT KEEPS IT HONEST IS THE TEST DIRECTLY
 * BELOW IT: every field listed here MUST STILL DIVERGE. Fix one and that test goes red, naming
 * the field and telling you to delete its entry. So an entry cannot outlive the defect it
 * describes — the usual failure mode of a baseline list, where a fixed exclusion lingers and
 * silently re-permits the very regression it was added for. The list can only shrink to empty.
 *
 * Adding a field here is therefore never the way to make a NEW divergence go away: a new one is a
 * regression in a seam that has already burned four fleets, and it must be FIXED.
 */
// WI-38326 fixed the original source-split entries (tags, plan, redundancy, est_cost), and
// EI-20288961198837165 healed the final one (`plan_item`). The SQL FIELD_MAP and the real JS
// WorkItem projection now both resolve physical column provenance first, then the payload
// plan-item object, then the legacy payload array. Keep this list empty: the property below
// must exercise every field, including both payload-only and column-only plan-item rows.
const KNOWN_FIELD_SOURCE_DIVERGENCES: Array<{ field: FilterLeaf['field']; workItem: string; why: string }> = [];

const EXCLUDED_FIELDS = new Set(KNOWN_FIELD_SOURCE_DIVERGENCES.map((d) => d.field));

/** True when a probe touches an allowlisted field ANYWHERE in its tree. */
function touchesExcludedField(node: FilterNode): boolean {
  if ('field' in node) return EXCLUDED_FIELDS.has(node.field);
  if ('all' in node) return node.all.some(touchesExcludedField);
  if ('any' in node) return node.any.some(touchesExcludedField);
  return touchesExcludedField(node.not);
}

beforeAll(async () => {
  db = await createFreshPgDb('sched-evaluator-parity');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  for (const r of ROWS) await seed(r);
  for (const r of ROWS) await seedIssue(r);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

/**
 * Build each row's JS-side subject the way PRODUCTION does — read the row back through the
 * same `FEATURE_COLS` projection the read path uses, then the real mapper. Deliberately NOT a
 * hand-written literal: see the file header.
 */
async function subjects(): Promise<Map<string, ClaimSpecSubject>> {
  const rows = await db.sql.unsafe(
    `SELECT ${FEATURE_COLS} FROM harness_shared.work_items WHERE harness_slug = '${H}' ORDER BY feature_id`,
  );
  const out = new Map<string, ClaimSpecSubject>();
  for (const r of rows) {
    const item = featureRowToWorkItem(r as never);
    out.set(item.id, claimSpecSubjectFromWorkItem(item));
  }
  return out;
}

async function issueItems() {
  const rows = await db.sql.unsafe(
    `SELECT ${ISSUE_COLS} FROM harness_shared.engineer_issues WHERE scope = 'harness:${ISSUE_H}' ORDER BY issue_id`,
  );
  const out = new Map<string, ReturnType<typeof issueToWorkItem>>();
  for (const r of rows) out.set(issueToWorkItem(toIssue(r as never)).id, issueToWorkItem(toIssue(r as never)));
  return out;
}

async function issueSubjects(): Promise<Map<string, ClaimSpecSubject>> {
  const out = new Map<string, ClaimSpecSubject>();
  for (const [id, item] of await issueItems()) out.set(id, claimSpecSubjectFromWorkItem(item));
  return out;
}

/** The ids the SQL compiler's fragment admits, for one filter. */
async function sqlAdmits(filter: FilterNode): Promise<Set<string>> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE harness_slug = ${H}
       AND ${compileFilter(db.sql as never, filter)}`;
  return new Set(rows.map((r) => r.feature_id));
}

async function issueSqlAdmits(filter: FilterNode): Promise<Set<string>> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items
     WHERE harness_slug = ${ISSUE_H}
       AND item_kind IN ('bug', 'change', 'task')
       AND ${compileFilter(db.sql as never, filter)}`;
  return new Set(rows.map((r) => r.feature_id));
}

describe('WI-5995 — the SQL compiler and the JS evaluator agree on every (field x op x row)', () => {
  it('every probe in the corpus is a VALID spec (a rejected filter would make the property vacuous)', () => {
    for (const p of PROBES) {
      const v = validateClaimSpec({
        specVersion: '1.0',
        specId: 'parity',
        revision: 1,
        view: { filter: p.filter },
        rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      });
      expect(v.ok, `probe "${p.name}" is not a valid spec: ${v.errors.join('; ')}`).toBe(true);
    }
  });

  it('the corpus is non-trivial — probes actually split the row set (a filter that admits all or none proves nothing)', async () => {
    let splitting = 0;
    for (const p of PROBES) {
      const admitted = await sqlAdmits(p.filter);
      if (admitted.size > 0 && admitted.size < ROWS.length) splitting += 1;
    }
    // Calibration, not a threshold to tune: if a refactor made every probe degenerate, the
    // agreement assertion below would pass vacuously and this is the only thing that notices.
    expect(splitting, 'no probe splits the corpus — the parity assertion would be vacuous').toBeGreaterThan(
      PROBES.length / 4,
    );
  });

  it('every allowlisted field STILL diverges — a fixed one must be deleted from the list, not left to rot', async () => {
    const subj = await subjects();
    const stillDiverges = new Set<FilterLeaf['field']>();
    // Attribute ONLY from single-field probes (a bare leaf, or a `not:`-wrapped leaf). A
    // combinator probe mixes fields and cannot say which one dissented; the leaf probes cover
    // every allowlisted field on their own, so nothing is lost by skipping them here.
    const soleField = (f: FilterNode): FilterLeaf['field'] | null =>
      'field' in f ? f.field : 'not' in f && 'field' in f.not ? f.not.field : null;

    for (const p of PROBES) {
      const field = soleField(p.filter);
      if (field === null || !EXCLUDED_FIELDS.has(field)) continue;
      const admitted = await sqlAdmits(p.filter);
      for (const row of ROWS) {
        if (admitted.has(row.id) !== matchesClaimSpecFilter(subj.get(row.id)!, p.filter)) {
          stillDiverges.add(field);
        }
      }
    }
    const healed = KNOWN_FIELD_SOURCE_DIVERGENCES.filter((d) => !stillDiverges.has(d.field));
    expect(
      healed.map((d) => `${d.field} (${d.workItem})`),
      'These fields are on the KNOWN_FIELD_SOURCE_DIVERGENCES allowlist but NO LONGER DIVERGE — '
        + 'someone fixed them. DELETE their entries so the agreement property starts protecting them '
        + 'again. Leaving a healed entry in place is exactly how a baseline list decays into a hole.',
    ).toEqual([]);
  }, 120_000);

  it('NO probe x row pair disagrees between the two engines', async () => {
    const subj = await subjects();
    expect(subj.size, 'every seeded row must map through the real projection').toBe(ROWS.length);

    const disagreements: string[] = [];
    for (const p of PROBES) {
      if (touchesExcludedField(p.filter)) continue; // see KNOWN_FIELD_SOURCE_DIVERGENCES
      const admitted = await sqlAdmits(p.filter);
      for (const row of ROWS) {
        const sqlVerdict = admitted.has(row.id);
        const jsVerdict = matchesClaimSpecFilter(subj.get(row.id)!, p.filter);
        if (sqlVerdict !== jsVerdict) {
          disagreements.push(
            `  ${p.name}\n    on ${row.id}: SQL=${sqlVerdict ? 'ADMIT' : 'refuse'} JS=${jsVerdict ? 'ADMIT' : 'refuse'}\n    (${row.why})`,
          );
        }
      }
    }

    expect(
      disagreements,
      `${disagreements.length} of ${PROBES.length * ROWS.length} verdict pairs DIVERGED between the SQL `
        + `compiler (get-next.ts) and the JS evaluator (claim-spec-match.ts).\n`
        + `One spec language must not mean two things. Each line below is a spec that admits an item on `
        + `one claim path and refuses it on the other:\n\n${disagreements.join('\n')}\n`,
    ).toEqual([]);
  }, 120_000);

  it('EI-20288961198837165 resolves both payload-only and column-only plan-item provenance', async () => {
    const filter: FilterLeaf = { field: 'plan_item', op: 'in', value: ['P-002', 'P-003'] };
    const admitted = await sqlAdmits(filter);
    const subj = await subjects();

    expect([...admitted].sort()).toEqual(['F-column-only', 'F-payload-only']);
    expect(matchesClaimSpecFilter(subj.get('F-column-only')!, filter)).toBe(true);
    expect(matchesClaimSpecFilter(subj.get('F-payload-only')!, filter)).toBe(true);
    expect(matchesClaimSpecFilter(subj.get('F-agree')!, filter)).toBe(false);
    expect(matchesClaimSpecFilter(subj.get('F-absent')!, filter)).toBe(false);
  });
});

describe('EI-20288042426947475 — issue-family projection parity', () => {
  it('carries all five FIELD_MAP columns through the real issue projection', async () => {
    const item = (await issueItems()).get('I-F-column-only');
    expect(item).toMatchObject({
      tags: ['infra'],
      sourcePlanSlug: PLAN,
      sourcePlanItemIds: ['P-003'],
      redundancy: 2,
      expectedCostCents: 250,
    });
  });

  it('keeps issue-family SQL and JS verdicts equal for every non-allowlisted probe', async () => {
    const subj = await issueSubjects();
    expect(subj.size, 'every issue row must map through ISSUE_COLS and the real mapper').toBe(ROWS.length);
    const disagreements: string[] = [];
    for (const p of PROBES) {
      if (touchesExcludedField(p.filter)) continue;
      const admitted = await issueSqlAdmits(p.filter);
      for (const row of ROWS) {
        const id = `I-${row.id}`;
        const sqlVerdict = admitted.has(id);
        const jsVerdict = matchesClaimSpecFilter(subj.get(id)!, p.filter);
        if (sqlVerdict !== jsVerdict) {
          disagreements.push(
            `  ${p.name}\n    on ${id}: SQL=${sqlVerdict ? 'ADMIT' : 'refuse'} JS=${jsVerdict ? 'ADMIT' : 'refuse'}\n    (${row.why})`,
          );
        }
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
  }, 120_000);
});

describe('EI-24072346395029750 — plan-only P2P fence for non-P2P drains', () => {
  it('excludes structured column/payload P2P plans in both evaluators without over-fencing summary-only text', async () => {
    const validated = validateClaimSpec({
      specVersion: '1.0',
      specId: 'p2p-plan-lane-regression',
      revision: 1,
      view: { fence: 'p2p-plan-lane' },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    });
    expect(validated.ok, `plan-only fence rejected: ${validated.errors.join('; ')}`).toBe(true);
    const filter = validated.spec?.view.filter;
    if (!filter) throw new Error('plan-only fence did not expand into a filter');

    const featureAdmitted = await sqlAdmits(filter);
    const issueAdmitted = await issueSqlAdmits(filter);
    const featureSubjects = await subjects();
    const issueSubjectsById = await issueSubjects();

    for (const id of ['F-p2p-plan-column', 'F-p2p-plan-payload']) {
      expect(featureAdmitted.has(id), `${id} must be excluded by SQL plan scope`).toBe(false);
      expect(matchesClaimSpecFilter(featureSubjects.get(id)!, filter), `${id} must be excluded by the JS evaluator`).toBe(false);
      const issueId = `I-${id}`;
      expect(issueAdmitted.has(issueId), `${issueId} must be excluded by SQL plan scope`).toBe(false);
      expect(matchesClaimSpecFilter(issueSubjectsById.get(issueId)!, filter), `${issueId} must be excluded by the JS evaluator`).toBe(false);
    }

    for (const id of ['F-summary-only', 'F-nonp2p-plan']) {
      expect(featureAdmitted.has(id), `${id} must remain admitted without structured P2P plan scope`).toBe(true);
      expect(matchesClaimSpecFilter(featureSubjects.get(id)!, filter), `${id} must remain admitted in the JS evaluator`).toBe(true);
      const issueId = `I-${id}`;
      expect(issueAdmitted.has(issueId), `${issueId} must remain admitted without structured P2P plan scope`).toBe(true);
      expect(matchesClaimSpecFilter(issueSubjectsById.get(issueId)!, filter), `${issueId} must remain admitted in the JS evaluator`).toBe(true);
    }
  }, 120_000);
});

// ────────────────────────────────────────────────────────────────────────────
// Regression pin for the divergence this file was written to find.
// ────────────────────────────────────────────────────────────────────────────
describe('WI-5995 — a json-array `!=` must not silently eat the backlog', () => {
  it('tags != X ADMITS a row with NO tags (the 778x pool collapse)', async () => {
    // Pre-fix this compiled to `NOT (col ? 'x')`: on an absent array that is `NOT NULL` = NULL,
    // which a WHERE clause drops. Measured on the live backlog at the time of the fix: 33 of
    // 25,691 genuinely-admissible open rows survived a single `tags != 'p2p-release'` leaf.
    const admitted = await sqlAdmits({ field: 'tags', op: '!=', value: 'p2p-release' });
    expect(admitted.has('F-absent'), 'a row with no tags is certainly not tagged p2p-release').toBe(true);
    expect(admitted.has('F-agree'), 'the fence must still EXCLUDE the tag it names').toBe(false);
  });

  it('paths != X ADMITS a row with NO paths', async () => {
    const admitted = await sqlAdmits({ field: 'paths', op: '!=', value: 'libs/generic/b.ts' });
    expect(admitted.has('F-absent')).toBe(true);
    expect(admitted.has('F-payload-only'), 'the fence must still EXCLUDE the path it names').toBe(false);
  });

  it('null-safety did not widen `!=` into a no-op on either engine', async () => {
    // The inverse failure mode: "fix" the NULL drop by making the predicate match everything.
    const admitted = await sqlAdmits({ field: 'tags', op: '!=', value: 'infra' });
    expect(admitted.has('F-agree')).toBe(false);
    expect(admitted.has('F-column-only')).toBe(false);
  });
});

describe('EI-25503081061868211 — plan fallback preserves scope without rereading absent keys', () => {
  it('retains every payload fallback, column precedence, empty strings and absent-plan negation', async () => {
    const harness = 'plan-key-parity';
    const fixtures: Array<{ id: string; column?: string; payload: unknown; plan: string | null }> = [
      { id: 'column', column: 'column-plan', payload: { plan_item: { plan_slug: 'p2p' } }, plan: 'column-plan' },
      { id: 'empty-column', column: '', payload: { source_plan_slug: 'p2p' }, plan: '' },
      { id: 'snake-plan', payload: { plan_item: { plan_slug: 'p2p', slug: 'later' } }, plan: 'p2p' },
      { id: 'snake-slug', payload: { plan_item: { slug: 'snake-plan' } }, plan: 'snake-plan' },
      { id: 'camel-plan', payload: { planItem: { plan_slug: 'camel-plan' } }, plan: 'camel-plan' },
      { id: 'camel-slug', payload: { planItem: { slug: 'p2p' } }, plan: 'p2p' },
      { id: 'top-level', payload: { source_plan_slug: 'top-plan' }, plan: 'top-plan' },
      { id: 'mixed-fallbacks', payload: { plan_item: {}, planItem: { slug: 'p2p' }, source_plan_slug: 'later' }, plan: 'p2p' },
      { id: 'malformed-parent', payload: { plan_item: 'p2p', planItem: [], source_plan_slug: 'top-plan' }, plan: 'top-plan' },
      { id: 'empty-payload-plan', payload: { plan_item: { plan_slug: '', slug: 'p2p' } }, plan: '' },
      { id: 'unrelated-key', payload: { body: 'plan_item planItem source_plan_slug p2p' }, plan: null },
      { id: 'null-payload', payload: null, plan: null },
      { id: 'array-payload', payload: ['plan_item', 'p2p'], plan: null },
      { id: 'scalar-payload', payload: 'source_plan_slug', plan: null },
    ];
    for (const f of fixtures) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts,
           source_plan_slug, payload, title)
        VALUES (${harness}, ${f.id}, 'feature', 'open', ${WS}, 0, 0,
          ${f.column ?? null}, ${db.sql.json(f.payload as never)}, ${f.id})`;
    }
    const admitted = async (filter: FilterNode) => (await db.sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.work_items
      WHERE harness_slug = ${harness} AND ${compileFilter(db.sql as never, filter)}
      ORDER BY feature_id`).map(r => r.feature_id);
    for (const value of new Set(fixtures.map(f => f.plan).filter((p): p is string => p !== null))) {
      expect(await admitted({ field: 'plan', op: '=', value }), value)
        .toEqual(fixtures.filter(f => f.plan === value).map(f => f.id).sort());
    }
    expect(await admitted({ field: 'plan', op: 'word', value: 'p2p' }))
      .toEqual(fixtures.filter(f => f.plan === 'p2p').map(f => f.id).sort());
    expect(await admitted({ not: { field: 'plan', op: 'word', value: 'p2p' } }))
      .toEqual(fixtures.filter(f => f.plan !== 'p2p').map(f => f.id).sort());
  });

  it('avoids repeated TOAST reads for a complete large-payload cohort without plan keys', async () => {
    const harness = 'plan-key-toast-cost';
    // Distinct hashes resist compression; the body stays present and exceeds the
    // TOAST threshold. The guard compares buffer work, not machine-dependent time.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, status, workspace_id, created_ts, updated_ts, payload, title)
      SELECT ${harness}, 'toast-' || n, 'feature', 'open', ${WS}, 0, 0,
        jsonb_build_object('body', (SELECT string_agg(md5(n::text || ':' || b::text), '')
          FROM generate_series(1, 2048) b)), 'body retained'
      FROM generate_series(1, 64) n`;
    const optimized = db.sql`
      SELECT count(*)::int n FROM harness_shared.work_items WHERE harness_slug = ${harness}
      AND ${compileFilter(db.sql as never, { not: { field: 'plan', op: 'word', value: 'p2p' } })}`;
    // Independent, unguarded reference retains the original full fallback meaning.
    const reference = db.sql`
      SELECT count(*)::int n FROM harness_shared.work_items WHERE harness_slug = ${harness}
      AND NOT COALESCE((COALESCE(source_plan_slug,
        payload->'plan_item'->>'plan_slug', payload->'plan_item'->>'slug',
        payload->'planItem'->>'plan_slug', payload->'planItem'->>'slug',
        payload->>'source_plan_slug') ~* '(^|[^A-Za-z0-9])p2p([^A-Za-z0-9]|$)'), false)`;
    expect((await optimized)[0]?.n).toBe(64);
    expect((await reference)[0]?.n).toBe(64);
    const bufferReads = async (query: typeof optimized) => {
      const rows = await db.sql`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ${query}`;
      const plan = rows[0]!['QUERY PLAN'][0].Plan;
      return Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0);
    };
    const referenceReads = await bufferReads(reference);
    const optimizedReads = await bufferReads(optimized);
    expect(referenceReads, 'the corpus must exercise out-of-line payload reads').toBeGreaterThan(128);
    expect(optimizedReads, `optimized=${optimizedReads}, reference=${referenceReads}`)
      .toBeLessThan(referenceReads / 2);
  });
});
