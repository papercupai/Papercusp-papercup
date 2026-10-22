/**
 * claim-ssot-agreement.integration.test.ts — P-002 (work-item-claimability-clarity-2026-07-20):
 * the ANTI-DRIFT AGREEMENT between the two representations of the issue-family claim floors.
 *
 * P-001 (migration 654) landed a QUERYABLE SQL SSOT for the issue-family claim floors —
 * `harness_shared.work_item_claim_floors(...)` + the `harness_shared.work_items_claimable`
 * view — so a raw `dev:pg_query` / `admissibleOnly` read AGREES with what the scheduler
 * actually serves. But that SQL function is a HAND-TRANSLATION of the inline TS `sql`-tagged
 * floor fragments the real claim path (`claimNextIssueWorkItem`) ANDs into its
 * `UPDATE … WHERE … FOR UPDATE SKIP LOCKED`. Two hand-maintained copies of the same predicate
 * in two different engines (PL/pgSQL vs TS query-builder) are exactly the drift risk P-001
 * exists to kill — edit one floor and forget the other, and `work_items_claimable` silently
 * disagrees with the scheduler, re-opening the 2026-07-12 idle-fleet incident (a leader fed a
 * tranche `admissibleOnly:true` reported claimable that `scheduler:get_next` correctly refused).
 *
 * WHY A BINDING TEST, NOT A PHYSICAL MERGE (the P-002 "call the same predicate" wording).
 * A literal refactor — route `claimNextIssueWorkItem` through the SSOT view / function — is
 * NOT achievable without a federation-recovery REGRESSION, by the SSOT's own owner-ratified
 * design (see migration 654's header):
 *   • the OWN-NODE drift-recovery origin leg (admit a remote row whose author_pubkey is one
 *     THIS workspace also wrote locally — owner 2026-07-20 "these can't be truly remote") is a
 *     correlated self-join over the whole work_items table, so it is INTENTIONALLY not baked
 *     into the bulk view (the view uses the fail-safe origin-only form, which "only ever
 *     UNDER-admits"). The scheduler still applies the own-node leg with its live workspace
 *     context. ANDing the view can never RE-admit a row the view already dropped, so a
 *     "SELECT FROM the view" claim path would permanently strand this box's own federated bugs.
 *   • the PER-CLAIM floors (cross-machine-rig, swarm-affinity, redundancy, release-cooldown) and
 *     the own-LEASE plan-item exemption depend on the CLAIMING caller's capability/spec, not the
 *     row, so a generic "claimable by someone" view CANNOT bake them in.
 * So the two representations must stay PHYSICALLY SEPARATE, and the achievable "never diverge"
 * guarantee is this AGREEMENT TEST: for a seeded DB state, the SSOT view admits EXACTLY the
 * issue-family rows the inline claim path serves — MODULO the three deliberate, documented
 * divergences, each of which is pinned below so a future "alignment" that accidentally erases
 * one (breaking federation recovery or the fail-safe under-admit) reds HERE.
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   1. AGREEMENT — across every UNCONDITIONAL floor (not-open, taken, federated-remote,
 *      claim-hold, observation-lane, owner-action, external-blocker, federation-detector,
 *      loop-noise, already-completed, reserved non-executable plan, other-owner-lease, blocked-dep,
 *      and their satisfied/admit counterparts) the view's membership set === the set the inline
 *      claim path drains, EXACTLY.
 *   2. DIVERGENCE A (per-claim rig floor) — the view admits a rig-gated row (SSOT omits per-claim
 *      floors); a default single-box claim does NOT serve it; a rigAvailable caller DOES.
 *   3. DIVERGENCE B (own-node drift recovery) — the view under-admits a remote own-authored row
 *      (fail-safe); the scheduler recovers it via the own-node origin leg.
 *   4. DIVERGENCE C (own-lease plan-item exemption) — the view excludes a plan-item under any
 *      live lease (caller-independent); the LEASE HOLDER can still claim it.
 *
 * D-007/B2 (fleet-leadership-continuity-and-actuation-2026-08-01) reuses this mould for the
 * second physically-separate claim pair: a linked feature work-item's `taken_by` holder and the
 * live `plan_item_claims.owner`. Ordinary live pairs must agree. The three intentional one-sided
 * states — a lane claimed before promotion, a held work-item whose plan item is terminal, and the
 * same-owner lease exemption that lets the work-item claim converge — are pinned explicitly so
 * they cannot become an excuse for an unlabelled owner mismatch.
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/claim-ssot-agreement.integration.test.ts
 * (or, from the repo root: npm run test:file -- \
 *     packages/operator-core/lib/scheduler/claim-ssot-agreement.integration.test.ts)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { DEFAULT_CLAIM_SPEC } from './claim-spec';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  applyClaimPathReadDeps,
  WATCHDOG_TICKS_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import { WIDE_TRIGGER_DDL } from './dependency-trigger-fixture';
import {
  IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS,
  createImplementationReadiness,
  implementationReadinessAdmitsClaim,
  implementationReadinessNormalExclusionSql,
  sealImplementationAcceptance,
  type ImplementationAcceptanceContract,
} from '../harness/improvements/agent-review-policy';
import type { OrgSql } from '../work-items';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
/** Read a migration file for `sql.unsafe(...).simple()`, dropping psql meta / GRANT /
 *  bare BEGIN|COMMIT lines the simple-protocol bootstrap can't run (mirrors the sibling
 *  claim-issues-claimable.integration.test.ts helper). */
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, currentBuild: 'abcdef1' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
// Every flag resolves to its production default. We drive the ISSUE claim path DIRECTLY
// (claimNextIssueWorkItem), so SCHEDULER_ISSUES_CLAIMABLE (the ladder gate) is irrelevant here;
// resolveIssuesScopeWorkspace('default') returns 'default' on either ISSUES_PER_WORKSPACE branch
// because we pass the workspace explicitly.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async (key: FlagKey) => FLAG_DEFAULTS[key] ?? false };
});
// A schema fixture is not a registered target checkout. Supply that external
// build identity at the composition seam while retaining the real receipt and
// currentness verifier; otherwise the post-cutover bug stops the claim drain
// before the independent change-kind candidate is reached.
vi.mock('../attention/intake-promotion', async (orig) => {
  const actual = await orig<typeof import('../attention/intake-promotion')>();
  return {
    ...actual,
    verifyAcceptedWorkItemBugReproduction: (item: Parameters<typeof actual.verifyAcceptedWorkItemBugReproduction>[0]) =>
      actual.verifyAcceptedWorkItemBugReproduction(item, {
        currentTargetBuild: async () => h.currentBuild,
        ledger: {
          readTestRun: async () => { throw new Error('this fixture uses free-text reproduction refs'); },
          readToolInvocation: async () => { throw new Error('this fixture uses free-text reproduction refs'); },
          now: () => new Date('2026-10-09T12:00:00Z'),
        },
      }),
  };
});

const wi = await import('../work-items');

const H = 'papercup';
const WS = 'default'; // == DEFAULT_COORD_WORKSPACE; work_item_deps + issues live here
const OP = `operator:${WS}`; // operator-scope encoding (migration 382)
let db: FreshPgDb;

/** Seed one issue-family (or, for a blocker, feature-family) row on the work_items base,
 *  exposing every column the SSOT view / inline claim path key on. */
async function seed(
  id: string,
  o: {
    kind?: string;
    status?: string;
    takenBy?: string | null;
    origin?: string;
    authorPubkey?: string | null;
    harnessSlug?: string;
    title?: string;
    payload?: Record<string, unknown> | null;
    terminalOwner?: string | null;
    terminalCompletionRef?: string | null;
    swarmAffinity?: string | null;
    redundancy?: number | null;
    createdTs?: number;
    sourcePlanSlug?: string | null;
    sourcePlanItemIds?: string[] | null;
  } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, payload, origin, author_pubkey, title,
       terminal_owner, terminal_completion_ref, swarm_affinity, redundancy,
       source_plan_slug, source_plan_item_ids)
    VALUES (
      ${o.harnessSlug ?? H}, ${id}, ${o.kind ?? 'bug'}, ${o.status ?? 'open'}, ${o.takenBy ?? null}, ${WS},
      ${o.createdTs ?? 0}, 0,
      ${o.payload ? db.sql.json(o.payload as Parameters<typeof db.sql.json>[0]) : null},
      ${o.origin ?? 'local'}, ${o.authorPubkey ?? null}, ${o.title ?? id},
      ${o.terminalOwner ?? null}, ${o.terminalCompletionRef ?? null}, ${o.swarmAffinity ?? null}, ${o.redundancy ?? null},
      ${o.sourcePlanSlug ?? null}, ${o.sourcePlanItemIds ?? null})`;
}

/** A blocks edge (issue blocked_ref is BARE; feature blocker_ref is harness-qualified). */
async function blockEdge(blockedRef: string, blockerRef: string, blockedKind = 'issue', blockerKind = 'feature') {
  await db.sql`
    INSERT INTO harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
    VALUES (${WS}, ${blockedKind}, ${blockedRef}, ${blockerKind}, ${blockerRef}, 'blocks')`;
}
// `opStatus` is the OPERATIONAL axis (started/paused/done — what plans:start / plans:pause
// write); `status` is the LIFECYCLE one. Floor #11 reads BOTH, and a plan that is genuinely
// RUNNING normally reads status='ready' + op_status='started' (EI-19409397800537963).
const seedPlan = (slug: string, status: string, opStatus: string | null = null) =>
  db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status, op_status)
          VALUES (${slug}, ${status}, ${opStatus})`;
const seedNormalizedPlanItem = (planSlug: string, itemId: string, status: string, harnessSlug = H) =>
  db.sql`INSERT INTO harness_shared.plan_items
            (workspace_id, harness_slug, plan_slug, item_id, seq, status)
          VALUES (${WS}, ${harnessSlug}, ${planSlug}, ${itemId}, 0, ${status})`;
const seedLease = (slug: string, itemId: string, owner: string, expiresMinFromNow: number) =>
  db.sql`INSERT INTO harness_shared.plan_item_claims (plan_slug, item_id, owner, expires_ts)
          VALUES (${slug}, ${itemId}, ${owner}, now() + make_interval(mins => ${expiresMinFromNow}))`;
const seedAssignment = (slug: string, itemId: string, assignee: string) =>
  db.sql`INSERT INTO harness_shared.plan_item_assignments
           (workspace_id, harness_slug, plan_slug, item_id, assignee_name,
            assigned_by_user, assigned_ts)
         VALUES (${WS}, ${H}, ${slug}, ${itemId}, ${assignee}, 'test-leader', now())`;
const seedRouteDecision = (slug: string, itemId: string) =>
  db.sql`INSERT INTO harness_shared.plan_decisions
           (workspace_id, harness_slug, plan_slug, decision_id, seq, title, body, item_refs)
         VALUES (${WS}, ${H}, ${slug}, 'D-001', 1,
                 'Owner-directed AUTO and self-only execution route',
                 'This session implements the plan itself. No fleet or subagent handoff is authorized.',
                 ARRAY[${itemId}]::text[])`;
const seedPlanLinkedIssue = (id: string, planSlug: string, itemId: string) =>
  seed(id, { kind: 'task', payload: { plan_item: { plan_slug: planSlug, item_id: itemId, harness_slug: H } } });

/** A promoted feature-family execution record carries BOTH the payload back-pointer read by the
 * claim floors and the first-class source columns used by the pair-agreement join. */
async function seedPlanLinkedFeature(
  id: string,
  planSlug: string,
  itemId: string,
  o: { status?: string; takenBy?: string | null; createdTs?: number } = {},
) {
  await seed(id, {
    kind: 'feature',
    status: o.status,
    takenBy: o.takenBy,
    createdTs: o.createdTs,
    payload: { plan_item: { plan_slug: planSlug, item_id: itemId, harness_slug: H } },
  });
  await db.sql`
    UPDATE harness_shared.work_items
       SET source_plan_slug = ${planSlug}, source_plan_item_ids = ARRAY[${itemId}]::text[]
     WHERE workspace_id = ${WS} AND harness_slug = ${H} AND feature_id = ${id}`;
}

interface FeatureClaimPairSnapshot {
  plan_slug: string;
  item_id: string;
  work_item_id: string | null;
  work_item_owner: string | null;
  work_item_status: string | null;
  plan_item_owner: string | null;
  plan_item_status: string | null;
}

/** FULL-OUTER snapshot of the two deliberately separate claim stores for one plan. Keeping the
 * one-sided rows is the point: filtering them out would make the three documented divergences
 * invisible and turn an apparent equality into a vacuous one. */
async function featureClaimPairSnapshots(planSlug: string): Promise<FeatureClaimPairSnapshot[]> {
  return db.sql<FeatureClaimPairSnapshot[]>`
    WITH feature_links AS (
      SELECT wi.workspace_id,
             wi.harness_slug,
             wi.source_plan_slug AS plan_slug,
             linked.item_id,
             wi.feature_id AS work_item_id,
             wi.taken_by AS work_item_owner,
             wi.status AS work_item_status
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL unnest(COALESCE(wi.source_plan_item_ids, ARRAY[]::text[])) AS linked(item_id)
       WHERE wi.workspace_id = ${WS}
         AND wi.harness_slug = ${H}
         AND wi.item_kind = 'feature'
         AND wi.source_plan_slug = ${planSlug}
    ), live_plan_claims AS (
      SELECT workspace_id,
             harness_slug,
             plan_slug,
             item_id,
             owner AS plan_item_owner
        FROM harness_shared.plan_item_claims
       WHERE workspace_id = ${WS}
         AND harness_slug = ${H}
         AND plan_slug = ${planSlug}
         AND expires_ts > clock_timestamp()
    )
    SELECT COALESCE(f.plan_slug, c.plan_slug) AS plan_slug,
           COALESCE(f.item_id, c.item_id) AS item_id,
           f.work_item_id,
           f.work_item_owner,
           f.work_item_status,
           c.plan_item_owner,
           pi.status AS plan_item_status
      FROM feature_links f
      FULL OUTER JOIN live_plan_claims c
        ON c.workspace_id = f.workspace_id
       AND c.harness_slug = f.harness_slug
       AND c.plan_slug = f.plan_slug
       AND c.item_id = f.item_id
      LEFT JOIN harness_shared.plan_items pi
        ON pi.workspace_id = COALESCE(f.workspace_id, c.workspace_id)
       AND pi.harness_slug = COALESCE(f.harness_slug, c.harness_slug)
       AND pi.plan_slug = COALESCE(f.plan_slug, c.plan_slug)
       AND pi.item_id = COALESCE(f.item_id, c.item_id)
     ORDER BY plan_slug, item_id, work_item_id NULLS FIRST`;
}

/**
 * EI-13738: a plan carrying an ITEM GRAPH — `harness_plans.items[]` with `blockedBy[]` edges,
 * the store floor #13 reads. `seedPlan` above leaves `items` NULL (the shape every pre-#13 case
 * needs), so this is the sibling that populates it.
 *
 * The plan is seeded at lifecycle 'ready' with op_status NULL on purpose: that makes floor #11
 * (reserved-plan-lane) SATISFIED, so any exclusion observed in these cases is attributable to
 * floor #13 alone. Without that, a non-executable lifecycle would exclude the row for the OTHER
 * reason and the case would pass while proving nothing about the floor under test.
 */
const seedPlanWithItems = (slug: string, items: { id: string; status?: string; blockedBy?: string[] }[]) =>
  db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status, op_status, items)
          VALUES (${slug}, 'ready', NULL, ${db.sql.json(
            items.map((it) => ({
              id: it.id,
              text: it.id,
              status: it.status ?? 'todo',
              blockedBy: it.blockedBy ?? [],
            })) as unknown as Parameters<typeof db.sql.json>[0],
          )})`;

/** REPRESENTATION 1 — the SSOT: the issue-family rows the queryable view admits, scoped the
 *  SAME way the inline claim path scopes (this issue workspace + harness-or-operator slug). */
async function viewClaimableIds(): Promise<string[]> {
  const rows = await db.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.work_items_claimable
     WHERE workspace_id = ${WS} AND harness_slug IN (${H}, ${OP})
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

/** REPRESENTATION 2 — the AUTHORITY: the rows the REAL inline claim path
 *  (`claimNextIssueWorkItem`) hands out. Drain by claiming with a plain, single-box caller and
 *  LEAVING each row taken (floor 2 excludes it next round), so the admissible set is enumerated
 *  exactly once with no cooldown/own-lease interference. Sorted for set comparison. */
async function drainInlineClaimIds(assignee = 'probe'): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 200; i++) {
    const claimed = (await wi.claimNextIssueWorkItem({ harness: H, assignee }, WS))?.id ?? null;
    if (!claimed) break;
    out.push(claimed);
  }
  return out.sort();
}

beforeAll(async () => {
  db = await createFreshPgDb('claim-ssot-agreement');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL); // base work_items + hfc + engineer_issues + plan tables
  // EI-22040912157347872: the new SSOT/TS floor reads durable assignments and
  // adopted-name bindings. This focused DB did not previously install migration 140.
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  // Every claim door asks readActiveOperationWorkerClaimBinding whether the claimant is a
  // blueprint operation worker; without adv_sessions that read is 'unavailable' and the door
  // fails CLOSED before any floor runs (WI-10003526). Present + empty => 'none', as for any
  // ordinary claimant.
  await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
  await db.sql.unsafe(WATCHDOG_TICKS_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // Claims emit `work-item:claimed:*` through the await-event primitive. The real
  // emitter records every fire in migration 632's unconditional latch; install
  // that runtime dependency here so the canonical race test exercises the same
  // path as production instead of producing a fail-soft missing-table warning.
  // The full audited event substrate (event_awaits + latch + wake deliveries + predicate watches),
  // not just 632: a claim emit also reads event_awaits, and a fixture missing it turns the
  // fail-soft warning into a vitest-fail-on-console red (WI-10004700).
  await applyEventSubstrateMigrationsForTest(db.sql, { label: 'claim-ssot-agreement.integration.test.ts' });
  // The terminal-plan floor reads the real normalized plan-item index (migration 675), not a
  // retyped test-only table. The fixture seeds only the rows needed by the regression below.
  await db.sql.unsafe(readMigration('675-normalize-plan-items-decisions.sql')).simple();
  await db.sql
    .unsafe(
      `ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS signal_origin text NOT NULL DEFAULT 'organic';`,
    )
    .simple();
  await db.sql.unsafe(readMigration('379-maintained-ready-column.sql')).simple();
  await db.sql.unsafe(WIDE_TRIGGER_DDL).simple();
  // P-001 (the thing under test): the SSOT function + view. Applying the REAL migration file (not
  // a re-typed copy) is the point — this test binds the migration's SQL to the TS claim path.
  await db.sql.unsafe(readMigration('654-work-item-claim-floors-ssot.sql')).simple();
  // EI-19409397800537963: re-points floor #11 at the OPERATIONAL plan axis (op_status
  // started/paused, not the lifecycle status alone) and tenant-scopes both plan subqueries.
  // Applied AFTER 654 for the same reason 654 itself is applied here rather than re-typed —
  // the migration chain, in order, is what this test binds the TS claim path to.
  await db.sql.unsafe(readMigration('744-plan-lane-floor-op-status.sql')).simple();
  // EI-13738: adds floor #13 (plan-item-blocked) — the PLAN dependency graph
  // (harness_plans.items[].blockedBy[]), which NOTHING read until now. Same reason as above for
  // applying the real file in chain order: this test is the binding between the migration's SQL
  // and the TS fragment (reservedPlanLaneExclusionSql), and landing only one half is exactly the
  // drift it exists to catch. Omitting this line does not merely skip the new coverage — the TS
  // path would then carry a floor the view does not, and the set-equality assertion below reds.
  await db.sql.unsafe(readMigration('759-plan-blockedby-claim-floor.sql')).simple();
  // EI-20467873456529090: excludes open work-items whose effective normalized plan-item is already
  // terminal, keeping the SSOT view in lockstep with the shared TS claim/diagnostic floor.
  await db.sql.unsafe(readMigration('853-plan-item-terminal-claim-floor.sql')).simple();
  // Migration 864 guards against moving a live claim and enrolls review-routed rows in the
  // existing Scout/Blender ledger. This focused fixture does not run the full historical
  // migration chain, so install both ledgers and the columns 864 writes before applying it.
  await db.sql.unsafe(readMigration('188-work-item-claims.sql')).simple();
  await db.sql.unsafe(readMigration('194-scout-routed-ideas.sql')).simple();
  await db.sql.unsafe(readMigration('333-scout-routed-ideas-source-target-hive.sql')).simple();
  await db.sql.unsafe(readMigration('471-scout-routed-ideas-origin.sql')).simple();
  await db.sql.unsafe(readMigration('558-scout-routed-ideas-created-by.sql')).simple();
  // Migration 864's guard reads the authoritative registry to distinguish the owner install
  // from a remote-hive replica.  This focused fixture does not apply the full baseline, so
  // install the production registry DDL before running that migration; otherwise its empty
  // bootstrap census fails with `relation harness_shared.harness_registry does not exist` and
  // every agreement assertion is skipped before the claim paths are exercised.
  await db.sql.unsafe(readMigration('archive/025-harness-registry-and-feature-notes.sql')).simple();
  // abolish-human-review D-003: floor #15 reserves pending review work to the reviewer lane
  // and revision-requested work to the submitter. Approval re-admits the still-open row.
  // Apply the real migration so the queryable SSOT and the existing TS claim fragment must agree.
  await db.sql.unsafe(readMigration('860-agent-review-claim-floor.sql')).simple();
  // P-005: floor #16 reserves strict credential/device/external-service owner actions.
  await db.sql.unsafe(readMigration('863-owner-action-claim-floor.sql')).simple();
  // P-006/migration 864 retires the ambiguous legacy payload.needsHuman floor while retaining
  // the stable public claim-floor signature through its subtractive v16 wrapper.
  await db.sql.unsafe(readMigration('864-migrate-legacy-human-parks-to-agent-review.sql')).simple();
  // EI-22040898205841125: an already-claimed work-item implementing the same canonical
  // plan-item is a pre-claim exclusion, not an invisible claim/clear miss. Apply the real
  // migration so the queryable SSOT and the TypeScript selector stay bound.
  await db.sql.unsafe(readMigration('1070-plan-item-sibling-claim-floor.sql')).simple();
  // EI-22040912157347872: an active durable plan-item assignment reserves the linked work-item
  // while its owner is between claim leases. Migration 1072 follows 1070 and wraps its v19
  // public floor as v20, so applying the real migration in chain order proves both additions compose.
  await db.sql.unsafe(readMigration('1072-plan-assignment-claim-floor.sql')).simple();
  // WI-41737: a normalized D-NNN self-only/direct route decision reserves the referenced
  // linked item even when no live lease or durable per-item assignment exists.
  await db.sql.unsafe(readMigration('1081-plan-route-decision-claim-floor.sql')).simple();
  // P-007 / WI-10004706: floor #16 (implementation readiness + acceptance contract) joins the
  // view through the 12-argument work_item_claim_floors overload. Seeds default to created_ts 0,
  // i.e. before the enforcement cutover, so every earlier case keeps its legacy admission.
  await db.sql.unsafe(readMigration('1301-acceptance-claim-floor.sql')).simple();
  // P-006 / WI-10006220: the same function re-rendered with the kind-specific verification check.
  await db.sql.unsafe(readMigration('1368-acceptance-claim-floor-kind-verification.sql')).simple();
  // P-007 Phase C / WI-10006221: re-rendered again with the completion-verification policy.
  await db.sql.unsafe(readMigration('1373-completion-verification-claim-floor.sql')).simple();
  await db.sql.unsafe(readMigration('1364-solo-decision-execution-reservation.sql')).simple();
  // WI-6554700010009932: the Route A leg's lowercase token index (prefilter ROUTE_A_DECISION_TOKEN_PREFILTER).
  await db.sql.unsafe(readMigration('1490-plan-decisions-lower-execution-tokens-idx.sql')).simple();
  // WI-10006417: Route A is plan-wide even when an owner answer's itemRefs list
  // only the separate implementation details and omits the linked plan item.
  await db.sql.unsafe(readMigration('1389-plan-wide-route-a-claim-floor.sql')).simple();
  // WI20092: source-only route reservations use the maintained compatible wrapper.
  await db.sql.unsafe(readMigration('1556-source-plan-route-claim-floor.sql')).simple();
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  h.currentBuild = 'abcdef1';
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps, harness_shared.work_item_blocked,
                       harness_shared.plan_items, harness_shared.plan_decisions,
                       harness_shared.harness_plans, harness_shared.plan_item_claims,
                       harness_shared.plan_item_assignments, harness_shared.agent_name_sessions`;
});

// WI-10006159: exact owner reservations must survive the normal decision writer's
// title and an execution master with no plan_item back-pointer. No hold, lease,
// assignment, active plan or spec exclusion supplies the answer in these cases.
describe('WI-10006159 solo decision reservations', () => {
  it('WI20092 preserves the public nine-argument SQL claim-floor signature', async () => {
    const signature = await db.sql`
      SELECT oidvectortypes(p.proargtypes) AS argument_types,
             p.proargnames AS argument_names,
             pg_get_function_result(p.oid) AS return_type
        FROM pg_proc p
       WHERE p.oid = to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       )`;
    expect(signature).toEqual([{
      argument_types: 'text, text, text, text, text, text, text, jsonb, text',
      argument_names: [
        'p_workspace_id', 'p_status', 'p_taken_by', 'p_origin', 'p_title',
        'p_terminal_owner', 'p_terminal_completion_ref', 'p_payload', 'p_feature_id',
      ],
      return_type: 'text[]',
    }]);
  });

  const decision = async (title: string, body: string, refs: string[] = [], id = 'D-005') => {
    await seedPlan('solo-route-plan', 'ready');
    await db.sql.begin(async (tx) => {
      await writePlanIndexRows(
        tx as unknown as Parameters<typeof writePlanIndexRows>[0],
        { workspaceId: WS, harnessSlug: H, planSlug: 'solo-route-plan' },
        { decisions: [{ id, title, body, date: '2026-10-05', itemRefs: refs }] },
      );
    });
  };
  const floors = async (id: string) => {
    const [row] = await db.sql<{ floors: string[] }[]>`SELECT harness_shared.work_item_claim_floors(
      workspace_id, status, taken_by, origin, title, terminal_owner,
      terminal_completion_ref, payload, feature_id) AS floors
      FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    return row!.floors;
  };

  it.each(['task', 'feature'])('reserves the unmarked single-implementer decision for %s', async (kind) => {
    await decision('Implementation authorized; publication still separate',
      'Avi authorizes the plan. The authoring session ended, so su-a973d2b0 is the single implementer.', ['P-007']);
    await seed('WI-10006071', { kind, payload: { plan_item: {
      plan_slug: 'solo-route-plan', item_id: 'P-007', harness_slug: H,
    } } });
    await seed('WI-10006072', { kind, payload: { plan_item: {
      plan_slug: 'solo-route-plan', item_id: 'P-008', harness_slug: H,
    } } });
    expect(await floors('WI-10006071')).toContain('reserved-plan-lane');
    expect(await floors('WI-10006072')).not.toContain('reserved-plan-lane');
    if (kind === 'task') expect(await viewClaimableIds()).toEqual(['WI-10006072']);
    const claimed = kind === 'task'
      ? await wi.claimNextIssueWorkItem({ harness: H, assignee: 'generic-drainer' }, WS)
      : await wi.claimNextWorkItem({ harness: H, assignee: 'generic-drainer' });
    expect(claimed?.id).toBe('WI-10006072');
    expect((await wi.claimWorkItem('WI-10006071', 'route-owner', { harness: H }))?.id).toBe('WI-10006071');
  });

  it.each(['task', 'feature'])('WI20092 reserves source-only plan-wide direct routes for %s', async (kind) => {
    await decision('Self-only execution route',
      'This session implements the plan directly; generic fleet self-selection must not claim its work.');
    await seed('WI-200092', { kind, sourcePlanSlug: 'solo-route-plan' });
    await seed('WI-200093', { kind });

    expect(await floors('WI-200092')).toContain('reserved-plan-lane');
    expect(await floors('WI-200093')).not.toContain('reserved-plan-lane');
    const ids = ['WI-200092', 'WI-200093'];
    const predicate = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload', {
      decisionCandidates: { workspaceId: WS, ids },
    });
    const admitted = await db.sql<{ feature_id: string }[]>`
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${predicate}
       ORDER BY wi.feature_id`;
    expect(admitted.map(row => row.feature_id)).toEqual(['WI-200093']);
    if (kind === 'task') {
      expect(await viewClaimableIds()).toEqual(['WI-200093']);
      const attribution = await wi.explainIssueClaimFloors(H, ids, {
        assignee: 'generic-drainer', includeAllFloors: true,
      });
      expect(attribution.find(row => row.id === 'WI-200092')?.failedFloors).toContain('plan-lane-reserved');
    } else {
      expect((await wi.listWorkItems({ harness: H, kind: 'feature', admissibleOnly: true }))
        .map(row => row.id)).toEqual(['WI-200093']);
    }
    const claim = () => kind === 'task'
      ? wi.claimNextIssueWorkItem({ harness: H, assignee: 'generic-drainer' }, WS)
      : wi.claimNextWorkItem({ harness: H, assignee: 'generic-drainer' });
    expect((await claim())?.id).toBe('WI-200093');
    expect(await claim()).toBeNull();
    expect((await wi.claimWorkItem('WI-200092', 'route-owner', { harness: H }))?.id).toBe('WI-200092');
  });

  it.each(['task', 'feature'])('WI20092 preserves source item scope and unrelated controls for %s', async (kind) => {
    await decision('Self-only execution route', 'This session implements the plan directly.', ['P-007']);
    await seed('WI-200092', { kind, sourcePlanSlug: 'solo-route-plan', sourcePlanItemIds: ['P-006', 'P-007'] });
    await seed('WI-200093', { kind, sourcePlanSlug: 'solo-route-plan', sourcePlanItemIds: ['P-008'] });
    await seed('WI-200094', { kind, sourcePlanSlug: 'solo-route-plan' });
    await seed('WI-200095', { kind, sourcePlanSlug: 'unreserved-plan' });
    // A pre-existing payload lane retains its authority; a conflicting provenance
    // source does not broaden this source-only repair to legacy lane reassignment.
    await seed('WI-200096', { kind, sourcePlanSlug: 'solo-route-plan', sourcePlanItemIds: ['P-007'],
      payload: { plan_item: { plan_slug: 'unreserved-plan', item_id: 'P-007' } } });
    await seed('WI-200097', { kind, sourcePlanSlug: 'unreserved-plan', sourcePlanItemIds: ['P-008'],
      payload: { plan_item: { plan_slug: 'solo-route-plan', item_id: 'P-007' } } });
    expect(await floors('WI-200092')).toContain('reserved-plan-lane');
    expect(await floors('WI-200097')).toContain('reserved-plan-lane');
    for (const id of ['WI-200093', 'WI-200094', 'WI-200095', 'WI-200096']) {
      expect(await floors(id)).not.toContain('reserved-plan-lane');
    }
    const expected = ['WI-200093', 'WI-200094', 'WI-200095', 'WI-200096'];
    if (kind === 'task') {
      expect(await viewClaimableIds()).toEqual(expected);
      expect(await drainInlineClaimIds()).toEqual(expected);
    } else {
      expect((await wi.listWorkItems({ harness: H, kind: 'feature', admissibleOnly: true }))
        .map(row => row.id).sort()).toEqual(expected);
      expect((await wi.claimNextWorkItem({ harness: H, assignee: 'generic-drainer' }))?.id)
        .not.toBe('WI-200097');
    }
    await db.sql`UPDATE harness_shared.plan_decisions SET workspace_id = 'foreign-tenant'`;
    expect(await floors('WI-200092')).not.toContain('reserved-plan-lane');
    const predicate = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer');
    expect((await db.sql`SELECT wi.feature_id FROM harness_shared.work_items wi
      WHERE wi.feature_id = 'WI-200092' AND ${predicate}`)).toHaveLength(1);
  });

  it.each(['task', 'feature'])('WI20092 reserves source-only Route A despite unrelated item refs for %s', async (kind) => {
    await decision('Owner selected direct implementation',
      'Route A: this session (su-dab96471) implements the plan.', ['P-other']);
    await seed('WI-200092', { kind, sourcePlanSlug: 'solo-route-plan' });
    expect(await floors('WI-200092')).toContain('reserved-plan-lane');
    const predicate = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload', {
      decisionCandidates: { workspaceId: WS, ids: ['WI-200092'] },
    });
    expect(await db.sql`SELECT wi.feature_id FROM harness_shared.work_items wi
      WHERE wi.feature_id = 'WI-200092' AND ${predicate}`).toEqual([]);
  });

  it.each(['task', 'feature'])('reserves an unbound explicit execution master for %s without reserving other mentions', async (kind) => {
    await decision('Owner authorizes direct AUTO execution',
      'Route is this session implementing directly, without a new fleet or client-native subagents. ' +
      'WI-10005829 owns execution and its durable successor state. Preserve independent cloud lane WI-10005826.');
    await seed('WI-10005829', { kind });
    await seed('WI-10005826', { kind });
    expect(await floors('WI-10005829')).toContain('reserved-plan-lane');
    expect(await floors('WI-10005826')).not.toContain('reserved-plan-lane');
    if (kind === 'task') expect(await viewClaimableIds()).toEqual(['WI-10005826']);
    const claimed = kind === 'task'
      ? await wi.claimNextIssueWorkItem({ harness: H, assignee: 'generic-drainer' }, WS)
      : await wi.claimNextWorkItem({ harness: H, assignee: 'generic-drainer' });
    expect(claimed?.id).toBe('WI-10005826');
    // A second pull cannot hand the reserved master back after the unrelated claim.
    expect(kind === 'task'
      ? await wi.claimNextIssueWorkItem({ harness: H, assignee: 'another-drainer' }, WS)
      : await wi.claimNextWorkItem({ harness: H, assignee: 'another-drainer' })).toBeNull();
    expect((await wi.claimWorkItem('WI-10005829', 'route-owner', { harness: H }))?.id).toBe('WI-10005829');
  });

  it.each(['task', 'feature'])('reserves the plan-wide Route A owner for P-002 despite D-006 refs for %s', async (kind) => {
    const planSlug = 'solo-route-plan';
    const id = `WI-10006417-${kind.toUpperCase()}`;
    // The decision names the executor by its short display prefix. The by-id claim API
    // requires a canonical owner id unless the fixture also seeds coord_presence.
    const routeOwnerId = 'su-dab96471-1234-4234-9234-123456789abc';
    await decision(
      'Owner answers: completion goes straight to Done; only delegated/assigned tasks plus added project rules become work; su-dab96471 builds it',
      'Route A: this session (su-dab96471) implements the plan.',
      ['P-003', 'P-006', 'P-010'],
      'D-006',
    );
    await seed(id, {
      kind,
      payload: { plan_item: { plan_slug: planSlug, item_id: 'P-002', harness_slug: H } },
    });

    expect(await floors(id)).toContain('reserved-plan-lane');
    if (kind === 'task') {
      expect(await viewClaimableIds()).not.toContain(id);
      expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'generic-drainer' }, WS)).toBeNull();
    } else {
      const candidates = await wi.listWorkItems({ harness: H, kind: 'feature', admissibleOnly: true });
      expect(candidates.some((row) => row.id === id)).toBe(false);
      expect(await wi.claimNextWorkItem({ harness: H, assignee: 'generic-drainer' })).toBeNull();
    }
    // The route owner can deliberately pick up the reserved item by id.
    expect((await wi.claimWorkItem(id, routeOwnerId, { harness: H }))?.id).toBe(id);
  });

  it('extracts execution masters once for a large candidate census while preserving exact reservations', async () => {
    await decision('Owner authorizes direct AUTO execution',
      'Route is this session implementing directly, without a new fleet. ' +
      'WI-200001 owns execution. WI-200002 owns execution and its successor state. ' +
      'Preserve independent WI-200003; WI-200004 owns execution only if approved.');
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, origin,
         created_ts, updated_ts, payload)
      SELECT ${WS}, ${H}, 'WI-' || (200000 + n), 'task', 'open', 'candidate', 'local',
             0, 0, NULL
        FROM generate_series(1, 2000) n
    `;
    const predicate = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload');
    const admitted = await db.sql<{ feature_id: string }[]>`
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND ${predicate}
       ORDER BY wi.feature_id
    `;
    expect(admitted).toHaveLength(1998);
    expect(admitted.slice(0, 2).map((row) => row.feature_id)).toEqual(['WI-200003', 'WI-200004']);
    expect(await floors('WI-200001')).toContain('reserved-plan-lane');
    expect(await floors('WI-200002')).toContain('reserved-plan-lane');
    expect(await floors('WI-200004')).not.toContain('reserved-plan-lane');

    const plans = await db.sql`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND ${predicate}
    `;
    type PlanNode = { 'Node Type': string; 'Function Name'?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const visit = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(visit); };
    visit(plans[0]['QUERY PLAN'][0].Plan);
    const masterExtractions = nodes.filter((node) => node['Function Name'] === 'regexp_matches');
    expect(masterExtractions.length).toBeGreaterThan(0);
    expect(masterExtractions.every((node) => node['Actual Loops'] === 1)).toBe(true);
    expect(nodes.some((node) => node['Actual Loops'] >= 2000 &&
      node['Node Type'] === 'Bitmap Heap Scan')).toBe(false);
  });

  it('does not infer solo authority from rejected routes, negated implementers or a foreign tenant', async () => {
    await decision('Direct execution route rejected',
      'su-a973d2b0 is not the single implementer. WI-10005829 owns execution only if Avi approves.');
    await seed('WI-10005829', { kind: 'task' });
    expect(await floors('WI-10005829')).not.toContain('reserved-plan-lane');
    await db.sql`UPDATE harness_shared.plan_decisions SET workspace_id = 'foreign-tenant',
      title = 'Self-only execution route', body = 'WI-10005829 owns execution.'`;
    expect(await floors('WI-10005829')).not.toContain('reserved-plan-lane');
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'generic-drainer' }, WS))?.id).toBe('WI-10005829');
  });

  it('keeps fixed-cohort decision reservations identical while excluding unrelated decision tokens', async () => {
    await decision('Owner authorizes direct AUTO execution',
      'Route is this session implementing directly, without a new fleet. WI-300001 owns execution. ' +
      'Preserve WI-300003; WI-300004 owns execution only if approved.');
    await seed('WI-300001', { kind: 'task' });
    await seed('WI-300002', { kind: 'task', payload: { plan_item: {
      plan_slug: 'solo-route-plan', item_id: 'P-002', harness_slug: H,
    } } });
    await seed('WI-300003', { kind: 'task' });
    await seed('WI-300004', { kind: 'task' });
    await db.sql`
      INSERT INTO harness_shared.plan_decisions
        (workspace_id, harness_slug, plan_slug, decision_id, seq, title, body, item_refs)
      SELECT ${WS}, ${H}, 'solo-route-plan', 'D-unrelated-' || n, 100 + n,
             'Self-only execution route', 'WI-' || (400000 + n) || ' owns execution.', ARRAY['P-other']::text[]
        FROM generate_series(1, 20) n
    `;
    const ids = ['WI-300001', 'WI-300002', 'WI-300003', 'WI-300004'];
    const ordinary = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer');
    const scoped = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload', {
      decisionCandidates: { workspaceId: WS, ids },
    });
    const read = (predicate: ReturnType<typeof wi.reservedPlanLaneExclusionSql>) => db.sql<{ feature_id: string }[]>`
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${predicate}
       ORDER BY wi.feature_id
    `;
    expect(await read(scoped)).toEqual(await read(ordinary));
    expect((await read(scoped)).map(row => row.feature_id)).toEqual(['WI-300003', 'WI-300004']);
    const attributed = await wi.explainIssueClaimFloors(H, ids, { assignee: 'generic-drainer', includeAllFloors: true });
    expect(attributed.filter(row => row.failedFloors?.includes('plan-lane-reserved')).map(row => row.id))
      .toEqual(['WI-300001', 'WI-300002']);
    const plans = await db.sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${scoped}`;
    type PlanNode = { 'Function Name'?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const visit = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(visit); };
    visit(plans[0]['QUERY PLAN'][0].Plan);
    const extractions = nodes.filter(node => node['Function Name'] === 'regexp_matches');
    expect(extractions.length).toBeGreaterThan(0);
    // LATERAL runs once per eligible decision, including decisions whose master
    // identity is outside the cohort. Bound the work by decisions, so repeating
    // that extraction for each candidate still fails this regression.
    const [decisionCount] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM harness_shared.plan_decisions
       WHERE workspace_id = ${WS}`;
    const extractionLoops = extractions.reduce((sum, node) => sum + node['Actual Loops'], 0);
    console.log('FIXED_COHORT_EXTRACTION', JSON.stringify({
      decisions: decisionCount.count, candidates: ids.length, extractionLoops, extractions,
    }));
    expect(extractionLoops).toBeLessThanOrEqual(decisionCount.count);
  });

  it('evaluates the Route A decision set once for a large fixed cohort', async () => {
    await seedPlan('route-a-load', 'ready');
    await db.sql`
      INSERT INTO harness_shared.plan_decisions
        (workspace_id, harness_slug, plan_slug, decision_id, seq, title, body, item_refs)
      VALUES (${WS}, ${H}, 'route-a-load', 'D-route-a', 1, 'Route choice',
        'Route A: this session (su-dab96471) implements the plan.', ARRAY['P-other']::text[])
    `;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, origin,
         created_ts, updated_ts, payload)
      SELECT ${WS}, ${H}, 'WI-' || (500000 + n), 'task', 'open', 'route candidate', 'local',
             0, 0, jsonb_build_object('plan_item',
               jsonb_build_object('plan_slug', 'route-a-load', 'item_id', 'P-001'))
        FROM generate_series(1, 2000) n
    `;
    const ids = Array.from({ length: 2000 }, (_, n) => `WI-${500001 + n}`);
    const scoped = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload', {
      decisionCandidates: { workspaceId: WS, ids },
    });
    const rows = await db.sql`SELECT wi.feature_id FROM harness_shared.work_items wi
      WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${scoped}`;
    expect(rows).toEqual([]);
    const plans = await db.sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${scoped}`;
    type PlanNode = { Filter?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const visit = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(visit); };
    visit(plans[0]['QUERY PLAN'][0].Plan);
    const routeScans = nodes.filter(node => node.Filter?.includes('route[[:space:]]+a:'));
    expect(routeScans.length).toBeGreaterThan(0);
    expect(routeScans.every(node => node['Actual Loops'] <= 1)).toBe(true);
  });
});

describe('canonical plan-item sibling claim guard (EI-21151083448505391)', () => {
  it('skips an actively claimed sibling before UPDATE and serves the next unrelated issue', async () => {
    const payload = { plan_item: { plan_slug: 'claimed-sibling-plan', item_id: 'P-SAME', harness_slug: H } };
    await seedPlan('claimed-sibling-plan', 'ready');
    await seed('WI-SIBLING-HELD', { kind: 'bug', payload, takenBy: 'plan-owner', createdTs: 1 });
    await seed('WI-SIBLING-CANDIDATE', { kind: 'bug', payload, createdTs: 2 });
    await seed('WI-UNRELATED-NEXT', { kind: 'bug', createdTs: 3 });

    // The generic read and the real selector both exclude the duplicate implementation.
    expect(await viewClaimableIds()).toEqual(['WI-UNRELATED-NEXT']);
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'drain-member' }, WS))?.id).toBe(
      'WI-UNRELATED-NEXT',
    );
    const [stillFree] = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'WI-SIBLING-CANDIDATE'`;
    expect(stillFree?.taken_by).toBeNull();

    // Releasing the actual sibling owner returns the duplicate implementation to the pool.
    await db.sql`
      UPDATE harness_shared.work_items
         SET taken_by = NULL, taken_at = NULL
       WHERE workspace_id = ${WS} AND feature_id = 'WI-SIBLING-HELD'`;
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'drain-member' }, WS))?.id).toBe('WI-SIBLING-HELD');
  });

  // WI-6554700010009927 / WI-6554700010009932 (perf audit P-012): "another live taken item holds
  // this candidate's lane" used to be a correlated EXISTS, run once per candidate, that detoasted
  // every taken sibling's payload (37 ms x 179 candidates on the live box). It is now two
  // uncorrelated sets over the held lanes. The admission result must not change, and the holder
  // scans must run once per statement rather than once per candidate.
  it('decides held sibling lanes from statement-level sets, never a per-candidate scan', async () => {
    await seedPlan('held-lane-load', 'ready');
    const lane = (item: string) => db.sql.json({ plan_item: { plan_slug: 'held-lane-load', item_id: item } });
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, origin,
         created_ts, updated_ts, taken_by, payload, source_plan_slug, source_plan_item_ids)
      VALUES
        (${WS}, ${H}, 'WI-HELD-OWNER', 'task', 'open', 'held lane owner', 'local', 0, 0,
         'plan-owner', ${lane('P-HELD')}, NULL, NULL),
        (${WS}, ${H}, 'WI-SOLE-HOLDER', 'task', 'open', 'sole holder of its own lane', 'local', 0, 0,
         'solo-owner', ${lane('P-SOLE')}, NULL, NULL),
        (${WS}, ${H}, 'WI-PAIR-A', 'task', 'open', 'first of two holders of one lane', 'local', 0, 0,
         'pair-owner-a', ${lane('P-PAIR')}, NULL, NULL),
        (${WS}, ${H}, 'WI-PAIR-B', 'task', 'open', 'second of two holders of one lane', 'local', 0, 0,
         'pair-owner-b', ${lane('P-PAIR')}, NULL, NULL),
        (${WS}, ${H}, 'WI-CANON-OWNER', 'task', 'open', 'canonical-column holder', 'local', 0, 0,
         'canon-owner', ${lane('P-DECOY')}, ' held-lane-load ', ARRAY['P-CANON']::text[])
    `;
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, origin,
         created_ts, updated_ts, payload)
      SELECT ${WS}, ${H}, 'WI-' || (700000 + n), 'task', 'open', 'unheld lane candidate', 'local',
             0, 0, jsonb_build_object('plan_item',
               jsonb_build_object('plan_slug', 'held-lane-load', 'item_id', 'P-FREE-' || n))
        FROM generate_series(1, 1500) n
      UNION ALL
      SELECT ${WS}, ${H}, v.id, 'task', 'open', v.title, 'local', 0, 0,
             jsonb_build_object('plan_item', jsonb_build_object('plan_slug', 'held-lane-load', 'item_id', v.item))
        FROM (VALUES ('WI-HELD-DUP', 'duplicate of the held lane', 'P-HELD'),
                     ('WI-CANON-DUP', 'duplicate of a canonical-column lane', 'P-CANON'),
                     ('WI-DECOY-FREE', 'payload lane its canonical holder does not hold', 'P-DECOY'))
             AS v(id, title, item)
    `;
    const free = Array.from({ length: 1500 }, (_, n) => `WI-${700001 + n}`);
    const ids = [...free, 'WI-HELD-DUP', 'WI-CANON-DUP', 'WI-DECOY-FREE', 'WI-SOLE-HOLDER', 'WI-PAIR-A', 'WI-PAIR-B'];
    const floor = wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload');

    const rows = await db.sql<{ feature_id: string }[]>`SELECT wi.feature_id FROM harness_shared.work_items wi
      WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${floor}`;
    const admitted = new Set(rows.map(r => r.feature_id));
    // Someone else holds these lanes: a payload-form holder, a canonical-column holder (slug
    // btrimmed), and each of two items sharing one lane.
    for (const id of ['WI-HELD-DUP', 'WI-CANON-DUP', 'WI-PAIR-A', 'WI-PAIR-B']) expect(admitted.has(id), id).toBe(false);
    // Being the only holder of your own lane is not a collision, and a holder whose canonical
    // columns are set does not also hold its stale payload lane.
    expect(admitted.has('WI-SOLE-HOLDER')).toBe(true);
    expect(admitted.has('WI-DECOY-FREE')).toBe(true);
    expect(admitted.size).toBe(1502);

    const plans = await db.sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT wi.feature_id FROM harness_shared.work_items wi
       WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[]) AND ${floor}`;
    type PlanNode = { Alias?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const visit = (node: PlanNode) => { nodes.push(node); node.Plans?.forEach(visit); };
    visit(plans[0]['QUERY PLAN'][0].Plan);
    const holderScans = nodes.filter(node => node.Alias === 'holder');
    expect(holderScans.length).toBeGreaterThan(0);
    // 1,506 candidates: a per-candidate form scans the holders 1,506 times.
    expect(Math.max(...holderScans.map(node => node['Actual Loops']))).toBeLessThanOrEqual(1);
  });

  // WI-6554700010009932: both execution-route decision legs prefilter on a body-token GIN index
  // (they were 1,034 ms and 516-587 ms sequential scans of 14,805 decisions on the live box).
  // Route A matches LOWER(body), so its prefilter must use the lowercase token index: a
  // mixed-case sentence still reserves its plan.
  it('prefilters both execution-route decision legs on token indexes without changing what they reserve', async () => {
    await seedPlan('route-a-mixed-case', 'ready');
    await seedPlan('master-owned', 'ready');
    await db.sql`
      INSERT INTO harness_shared.plan_decisions
        (workspace_id, harness_slug, plan_slug, decision_id, seq, title, body, item_refs)
      VALUES
        (${WS}, ${H}, 'route-a-mixed-case', 'D-route-a', 1, 'Route choice',
         'ROUTE A: This Session (su-dab96471) Implements The Plan.', ARRAY['P-other']::text[]),
        (${WS}, ${H}, 'master-owned', 'D-master', 1, 'Self-only execution route',
         'WI-910001 owns execution.', ARRAY[]::text[])
    `;
    await seed('WI-910001', { kind: 'task' });
    await seed('WI-910002', { kind: 'task' });
    await seed('WI-910003', { kind: 'task', payload: { plan_item: { plan_slug: 'route-a-mixed-case', item_id: 'P-001' } } });
    await seed('WI-910004', { kind: 'task', payload: { plan_item: { plan_slug: 'route-a-unruled', item_id: 'P-001' } } });
    const ids = ['WI-910001', 'WI-910002', 'WI-910003', 'WI-910004'];

    const rows = await db.sql<{ feature_id: string }[]>`SELECT wi.feature_id FROM harness_shared.work_items wi
      WHERE wi.workspace_id = ${WS} AND wi.feature_id = ANY(${ids}::text[])
        AND ${wi.reservedPlanLaneExclusionSql(db.sql, 'generic-drainer', 'wi.payload')}
      ORDER BY wi.feature_id`;
    expect(rows.map(r => r.feature_id)).toEqual(['WI-910002', 'WI-910004']);

    // Each prefilter must be ABLE to use its token index: an expression that drifts from the
    // index definition silently falls back to regex-scanning every decision body. Probe each
    // exported prefilter alone with sequential scans disabled, so its GIN bitmap scan is the
    // only non-disabled path. (Explaining the whole statement instead asserts a cost choice:
    // on a tiny table the planner may legitimately prefer a parameterized btree path.)
    const indexesUsedBy = (predicate: string) => db.sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      const plans = await tx.unsafe(
        `EXPLAIN (FORMAT JSON) SELECT 1 FROM harness_shared.plan_decisions d WHERE ${predicate}`,
      );
      type PlanNode = { 'Index Name'?: string; Plans?: PlanNode[] };
      const names: string[] = [];
      const visit = (node: PlanNode) => {
        if (node['Index Name']) names.push(node['Index Name']);
        node.Plans?.forEach(visit);
      };
      visit(plans[0]['QUERY PLAN'][0].Plan);
      return names;
    });
    expect(await indexesUsedBy(wi.MASTER_DECISION_TOKEN_PREFILTER))
      .toEqual(['plan_decisions_execution_tokens_idx']);
    expect(await indexesUsedBy(wi.ROUTE_A_DECISION_TOKEN_PREFILTER))
      .toEqual(['plan_decisions_lower_execution_tokens_idx']);
  });

  it('permits exactly one concurrent winner across bounded feature and issue claim transactions', async () => {
    const gn = await import('./get-next');
    const payload = { plan_item: { plan_slug: 'cross-family-race', item_id: 'P-RACE', harness_slug: H } };
    await seed('F-CROSS-FAMILY', { kind: 'feature', payload });
    await seed('EI-CROSS-FAMILY', { kind: 'bug', payload });

    for (let round = 0; round < 20; round += 1) {
      await db.sql`
        UPDATE harness_shared.work_items
           SET taken_by = NULL, taken_at = NULL, last_progress_at = NULL
         WHERE feature_id IN ('F-CROSS-FAMILY', 'EI-CROSS-FAMILY')`;

      const [feature, issue] = await Promise.all([
        gn.getNextWorkItem(
          DEFAULT_CLAIM_SPEC,
          { assignee: `feature-racer-${round}` },
          { harness: H, workspaceId: WS, states: ['open'] },
        ),
        wi.claimNextIssueWorkItem({ harness: H, assignee: `issue-racer-${round}` }, WS),
      ]);

      const claimedIds = [feature?.workItem.id, issue?.id].filter((id): id is string => Boolean(id));
      expect(claimedIds).toHaveLength(1);

      const rows = await db.sql<{ feature_id: string; taken_by: string | null }[]>`
        SELECT feature_id, taken_by
          FROM harness_shared.work_items
         WHERE feature_id IN ('F-CROSS-FAMILY', 'EI-CROSS-FAMILY')
         ORDER BY feature_id`;
      expect(rows.filter((row) => row.taken_by)).toHaveLength(1);
      expect(rows.find((row) => row.taken_by)?.feature_id).toBe(claimedIds[0]);
    }
  }, 120_000);
});

// @covers INV-06
// Cited by dependency-subsystem-thorough-testing-2026-08-02 P-009 after READING the case
// below, not from this file's header. INV-06 is "every claim entry point applies the SAME
// blocking verdict", and the `blocked-dep` floor is exercised here in BOTH directions on one
// seed — WI-DEP-OK (terminal blocker) must appear in both sets, WI-DEP-BLOCKED (non-terminal
// blocker) in neither — with the PREVIEW door (the work_items_claimable SSOT view) and the
// real claim door (claimNextIssueWorkItem) asserted equal. That pair is exactly where D-007's
// drift was measured: the preview reported 0 blocked against the claim path's 5, so agents
// were handed items the door then refused. The proof was here all along and simply carried no
// citation — the same unattributed-coverage gap P-005 found across the whole corpus.
describe('work_items_claimable (SSOT view) admits EXACTLY the rows claimNextIssueWorkItem serves (P-002)', () => {
  it('agrees across every unconditional floor — the view membership set === the inline claim drain set', async () => {
    // ── ADMIT: rows that pass every unconditional floor (must be in BOTH sets) ────────────────
    await seed('WI-PLAIN'); // plain open/untaken/local bug
    await seed('WI-CHANGE', { kind: 'change' });
    await seed('WI-TASK', { kind: 'task' });
    await seed('WI-LEGACY-HUMAN', { payload: { needsHuman: true } });
    await seed('WI-REVIEW-APPROVED', {
      kind: 'change',
      payload: {
        agentReview: { status: 'approved', submittedBy: 'su-filer', ledgerIdeaId: 'WI-REVIEW-APPROVED', round: 1 },
      },
    });
    await seed('WI-OP', { harnessSlug: OP }); // operator-scope encoding, still self-pickable
    // reserved-plan-lane floor SATISFIED: a ready plan with no operation or live lease ⇒ free backlog.
    await seedPlan('ready-free', 'ready');
    await seedPlanLinkedIssue('WI-READY-FREE', 'ready-free', 'P-01');
    // blocked-dep floor SATISFIED: blocker is TERMINAL (passed feature) ⇒ not blocking.
    await seed('F-DONE', { kind: 'feature', status: 'passed' });
    await seed('WI-DEP-OK');
    await blockEdge('WI-DEP-OK', `${H}#F-DONE`, 'issue', 'feature');

    // ── EXCLUDE: one row per unconditional floor VIOLATED (must be in NEITHER set) ────────────
    await seed('WI-RESOLVED', { status: 'resolved' }); // 1. not-open
    await seed('WI-TAKEN', { takenBy: 'someone-else' }); // 2. taken
    await seed('WI-REMOTE', { origin: 'remote', authorPubkey: 'foreign-peer-key' }); // 3. federated-remote (true peer)
    await seed('WI-HOLD', { payload: { _claimHold: true } }); // 4. claim-hold
    await seed('WI-OBS', { kind: 'change', payload: { lane: 'observation' } }); // 5. observation-lane
    await seed('WI-OWNER-ACTION', { payload: { needsOwnerAction: true } }); // 16. strict owner action
    await seed('WI-EXTBLOCK', { payload: { externalBlockers: [{ status: 'active' }] } }); // 7. external-blocker
    await seed('WI-FEDDET', { payload: { _ei: { created_by: 'system:replication-liveness' } } }); // 8. federation-detector
    await seed('WI-LOOPNOISE', { title: 'Loop wake #3: continue backlog drain' }); // 9. loop-iteration-noise
    await seed('WI-COMPLETED', { terminalOwner: 'su-peer', terminalCompletionRef: 'commit:abc123' }); // 10. already-completed
    await seed('WI-REVIEW-PENDING', {
      kind: 'change',
      payload: {
        agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-REVIEW-PENDING', round: 1 },
      },
    }); // 15a. agent-review pending
    await seed('WI-REVIEW-REVISION', {
      kind: 'change',
      payload: {
        agentReview: {
          status: 'revision-requested',
          submittedBy: 'su-filer',
          ledgerIdeaId: 'WI-REVIEW-REVISION',
          round: 2,
        },
      },
    }); // 15b. agent-review revision work
    await seedPlan('active-plan', 'active'); // 11a. reserved to an ACTIVE plan lane
    await seedPlanLinkedIssue('WI-ACTIVE-PLAN', 'active-plan', 'P-02');
    await seedPlan('other-lease-plan', 'ready'); // 11b. reserved by ANOTHER owner's live lease
    await seedPlanLinkedIssue('WI-OTHER-LEASE', 'other-lease-plan', 'P-03');
    await seedLease('other-lease-plan', 'P-03', 'su-other-owner', 20);
    // 11c. an active durable assignment reserves the lane while its owner is between
    // claim leases. This is the exact WI-1801547 claim→release→re-serve recurrence.
    await seedPlan('assigned-plan', 'ready');
    await seedPlanLinkedIssue('WI-ASSIGNED-PLAN', 'assigned-plan', 'P-ASSIGNED');
    await seedAssignment('assigned-plan', 'P-ASSIGNED', 'su-route-owner');
    // 11d. A ready plan with no lease/assignment is normally free, but a recorded
    // self-only route decision is durable ownership and reserves the referenced item.
    await seedPlan('decision-reserved-plan', 'ready');
    await seedPlanLinkedIssue('WI-DECISION-RESERVED', 'decision-reserved-plan', 'P-DIRECT');
    await seedRouteDecision('decision-reserved-plan', 'P-DIRECT');
    // Ordinary draft is the shipped FREE control: without a live lease/assignment it has no
    // occupant and must not starve generic backlog (migration 920 remained a draft experiment).
    await seedPlan('draft-plan', 'draft');
    await seedPlanLinkedIssue('WI-DRAFT-PLAN', 'draft-plan', 'P-DRAFT');
    await seedPlan('paused-lifecycle-plan', 'paused'); // 11d. reserved to an ordinary paused plan
    await seedPlanLinkedIssue('WI-PAUSED-LIFECYCLE', 'paused-lifecycle-plan', 'P-PAUSED');
    // 11e. reserved to a STARTED plan whose LIFECYCLE status is still 'ready' — the shape a
    // real running plan actually has, since plans:start writes op_status and never touches
    // status. Both representations read the lifecycle column ALONE until
    // EI-19409397800537963, so this row was served by both doors; on live papercusp that was
    // 31 items across 12 running plans. 11f is the same for an owner-PAUSED plan, whose
    // plans:pause contract is "no new features are picked until plans:start".
    await seedPlan('started-plan', 'ready', 'started');
    await seedPlanLinkedIssue('WI-STARTED-PLAN', 'started-plan', 'P-04');
    await seedPlan('paused-plan', 'ready', 'paused'); // 11d. owner-paused
    await seedPlanLinkedIssue('WI-PAUSED-PLAN', 'paused-plan', 'P-05');
    // …and the anti-over-exclusion control: a plan whose op run FINISHED reserves nothing, so
    // its leftover items drain normally rather than starving behind a done plan.
    await seedPlan('done-plan', 'ready', 'done');
    await seedPlanLinkedIssue('WI-DONE-PLAN-FREE', 'done-plan', 'P-06');
    await seed('F-OPEN', { kind: 'feature', status: 'open' }); // 12. blocked-dep (non-terminal blocker)
    await seed('WI-DEP-BLOCKED');
    await blockEdge('WI-DEP-BLOCKED', `${H}#F-OPEN`, 'issue', 'feature');
    // 13. plan-item-blocked (EI-13738) — the PLAN dependency graph. Every plan below is 'ready'
    // with op_status NULL, so floor #11 is SATISFIED and floor #13 is the ONLY thing that can
    // move these rows; that is what makes each verdict attributable.
    await seedPlanWithItems('blocked-graph', [{ id: 'P-09' }, { id: 'P-10', blockedBy: ['P-09'] }]);
    await seedPlanLinkedIssue('WI-PLAN-BLOCKED', 'blocked-graph', 'P-10'); // blocker is 'todo' ⇒ EXCLUDED

    const expected = [
      'WI-CHANGE',
      'WI-DEP-OK',
      'WI-DONE-PLAN-FREE',
      'WI-DRAFT-PLAN',
      'WI-READY-FREE',
      'WI-LEGACY-HUMAN',
      'WI-OP',
      'WI-PLAIN',
      'WI-REVIEW-APPROVED',
      'WI-TASK',
    ].sort();
    const viewSet = await viewClaimableIds();
    const drainSet = await drainInlineClaimIds();

    // The core anti-drift assertion: the two hand-maintained representations agree EXACTLY.
    expect(drainSet).toEqual(viewSet);
    // …and both equal the hand-computed admit set (guards a mutual-but-wrong drift where a floor
    // was dropped from BOTH copies at once — a set-equality-only check would miss that).
    expect(viewSet).toEqual(expected);
  });
});

describe('the three DELIBERATE, documented divergences are pinned (a future "alignment" that erases one reds here)', () => {
  it('DIVERGENCE A — per-claim rig floor: the view admits a rig-gated row (SSOT omits per-claim floors); a single-box claim does not, a rigAvailable caller does', async () => {
    await seed('WI-RIG', { payload: { needs_2_machine_rig: true } });

    expect(await viewClaimableIds()).toContain('WI-RIG'); // SSOT deliberately omits the per-claim rig floor
    expect(await drainInlineClaimIds()).not.toContain('WI-RIG'); // default single-box caller excludes it

    // proves ONLY the per-claim rig floor gated it: a rig-capable caller is served the same row.
    const claimed =
      (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'rig-fleet', rigAvailable: true }, WS))?.id ?? null;
    expect(claimed).toBe('WI-RIG');
  });

  it('DIVERGENCE B — own-node drift recovery: the view UNDER-admits a remote own-authored row (fail-safe); the scheduler recovers it via the own-node origin leg', async () => {
    // A local row enrolls 'key-own' as one of THIS workspace's own substrate-log author keys…
    await seed('WI-LOCAL-OWN', { origin: 'local', authorPubkey: 'key-own' });
    // …so a remote row carrying the SAME author key is our OWN work that round-tripped federation.
    await seed('WI-REMOTE-OWN', { origin: 'remote', authorPubkey: 'key-own' });

    const view = await viewClaimableIds();
    expect(view).toContain('WI-LOCAL-OWN');
    expect(view).not.toContain('WI-REMOTE-OWN'); // the bulk view uses the fail-safe origin-only form ⇒ under-admits

    const drained = await drainInlineClaimIds();
    expect(drained).toContain('WI-REMOTE-OWN'); // the scheduler's own-node leg re-admits it (federation-recovery)
  });

  it('DIVERGENCE C — own-lease plan-item exemption: the view excludes a plan-item under any live lease (caller-independent); the LEASE HOLDER can still claim it', async () => {
    await seedPlan('own-lease-plan', 'ready');
    await seedPlanLinkedIssue('WI-OWN-LEASE', 'own-lease-plan', 'P-001');
    await seedLease('own-lease-plan', 'P-001', 'probe', 20); // the lease is held by the CLAIMING assignee

    expect(await viewClaimableIds()).not.toContain('WI-OWN-LEASE'); // SSOT is caller-independent ⇒ any live lease excludes

    const claimed = (await wi.claimNextIssueWorkItem({ harness: H, assignee: 'probe' }, WS))?.id ?? null;
    expect(claimed).toBe('WI-OWN-LEASE'); // the holder's own-lease exemption admits it
  });
});

describe('linked feature work-item / plan-item claim-pair AGREEMENT (D-007/B2)', () => {
  it('AGREEMENT + DIVERGENCE C — only the lane owner gets the own-lease exemption, and the resulting live pair has one owner', async () => {
    const gn = await import('./get-next');
    await seedPlan('claim-pair', 'ready');
    await seedNormalizedPlanItem('claim-pair', 'P-001', 'todo');
    await seedPlanLinkedFeature('F-CLAIM-PAIR', 'claim-pair', 'P-001');
    await seedLease('claim-pair', 'P-001', 'pair-owner', 20);

    // A foreign claimant cannot take a work-item out from under the lane owner.
    expect(
      await gn.getNextWorkItem(
        DEFAULT_CLAIM_SPEC,
        { assignee: 'foreign-owner' },
        { harness: H, workspaceId: WS, states: ['open'] },
      ),
    ).toBeNull();

    // The SAME owner is deliberately exempt: this is how the two stores converge after the
    // lane-first claim/promotion sequence rather than deadlocking each other forever.
    const claimed = await gn.getNextWorkItem(
      DEFAULT_CLAIM_SPEC,
      { assignee: 'pair-owner' },
      { harness: H, workspaceId: WS, states: ['open'] },
    );
    expect(claimed?.workItem.id).toBe('F-CLAIM-PAIR');

    const [pair] = await featureClaimPairSnapshots('claim-pair');
    expect(pair).toMatchObject({
      work_item_id: 'F-CLAIM-PAIR',
      work_item_owner: 'pair-owner',
      plan_item_owner: 'pair-owner',
      plan_item_status: 'todo',
    });
    expect(pair?.work_item_owner).toBe(pair?.plan_item_owner);
  });

  it('DIVERGENCE A — a live plan-item claim may exist before promotion creates any work-item', async () => {
    await seedPlan('pre-promotion', 'ready');
    await seedNormalizedPlanItem('pre-promotion', 'P-001', 'todo');
    await seedLease('pre-promotion', 'P-001', 'plan-first-owner', 20);

    expect(await featureClaimPairSnapshots('pre-promotion')).toEqual([
      {
        plan_slug: 'pre-promotion',
        item_id: 'P-001',
        work_item_id: null,
        work_item_owner: null,
        work_item_status: null,
        plan_item_owner: 'plan-first-owner',
        plan_item_status: 'todo',
      },
    ]);
  });

  it('DIVERGENCE B — a terminal plan item may retain an in-flight work-item holder without a live lane claim', async () => {
    await seedPlan('terminal-in-flight', 'ready');
    await seedNormalizedPlanItem('terminal-in-flight', 'P-001', 'done');
    await seedPlanLinkedFeature('F-TERMINAL-IN-FLIGHT', 'terminal-in-flight', 'P-001', {
      takenBy: 'finishing-owner',
    });

    // The terminal reconciler intentionally skips a currently-held work-item rather than
    // clobber work still in flight. That recoverable, work-side-only state is not owner drift.
    expect(await featureClaimPairSnapshots('terminal-in-flight')).toEqual([
      {
        plan_slug: 'terminal-in-flight',
        item_id: 'P-001',
        work_item_id: 'F-TERMINAL-IN-FLIGHT',
        work_item_owner: 'finishing-owner',
        work_item_status: 'open',
        plan_item_owner: null,
        plan_item_status: 'done',
      },
    ]);
  });
});

/**
 * EI-13738 — floor #13 (`plan-item-blocked`): the PLAN dependency graph gates the claim.
 *
 * ⚠ WHY THIS IS A SYNTHETIC FIXTURE AND NOT A BEFORE/AFTER COUNT. Measured on live papercusp
 * 2026-08-04, in BOTH families, this floor would newly exclude ZERO rows today (issue family via
 * `payload.plan_item`: 41 plan-bound open+unassigned rows, 0 excluded; feature family via
 * `source_plan_slug`: 1,253 plan-bound rows, 8 todo+unclaimed, 0 excluded). The defect is REAL but
 * LATENT — floor #11 currently masks it, because it reserves any item whose plan is under
 * execution, and the exposed population is items on plans that were never started. So a
 * production "0 before, 0 after" run would prove exactly nothing, and these seeds are the ONLY
 * way to observe the floor at all.
 *
 * Every plan here is 'ready' with op_status NULL, which SATISFIES floor #11 — so each verdict
 * below is attributable to floor #13 alone rather than to the pre-existing lane reservation.
 * Both representations are asserted on every case: the SSOT view (migration 759) and the real
 * inline claim path (the TS fragment). They are hand-maintained copies, and a case that checked
 * only one would let the pair drift in exactly the direction this file exists to prevent.
 */
describe('floor #13 plan-item-blocked — the PLAN blockedBy graph gates the claim (EI-13738)', () => {
  let probeSeq = 0;
  /**
   * Both doors' verdicts for the named ids: `[view admits?, inline claim serves?]` per id,
   * asserted as a pair so a divergence between the SQL SSOT and the TS fragment reds instead
   * of hiding.
   *
   * ⚠ The probe is deliberately made NON-DESTRUCTIVE, and that is load-bearing.
   * `drainInlineClaimIds` CLAIMS every admissible row and LEAVES it taken — that is how it
   * enumerates the admissible set exactly once. So a naive per-id probe poisons itself: the
   * first call takes every row it admits, and a second call then reports those rows excluded by
   * floor #2 (`taken`) for a reason that has nothing to do with the floor under test. That is
   * not hypothetical — it is precisely how the first draft of the transitivity and malformed-row
   * cases below failed, with the floor itself behaving correctly the whole time. Both doors are
   * therefore read ONCE per call, and the drain is undone before returning; each call also uses
   * a FRESH assignee so no per-claim cooldown can leak between probes.
   */
  async function doorVerdicts(...ids: string[]): Promise<Record<string, [boolean, boolean]>> {
    const view = await viewClaimableIds();
    const drain = await drainInlineClaimIds(`probe-${++probeSeq}`);
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE workspace_id = ${WS}`;
    return Object.fromEntries(ids.map((id) => [id, [view.includes(id), drain.includes(id)] as [boolean, boolean]]));
  }
  /** Single-id shorthand over {@link doorVerdicts} — same non-destructive guarantee. */
  const bothDoors = async (id: string): Promise<[boolean, boolean]> => (await doorVerdicts(id))[id];

  it('EXCLUDES an item whose plan-item is blockedBy an UNFINISHED sibling — and ADMITS it the moment the blocker is done', async () => {
    await seedPlanWithItems('toggle-plan', [
      { id: 'P-01', status: 'todo' },
      { id: 'P-02', blockedBy: ['P-01'] },
    ]);
    await seedPlanLinkedIssue('WI-TOGGLE', 'toggle-plan', 'P-02');

    // BEFORE: the blocker is 'todo' ⇒ neither door offers it. This is the bug the floor fixes —
    // before floor #13 both doors served this row, because NOTHING read the plan graph.
    expect(await bothDoors('WI-TOGGLE')).toEqual([false, false]);

    // Flip the blocker to done — the ONLY thing that changes — and the item becomes claimable.
    // The pair proves the floor GATES rather than merely suppresses: a floor that excluded
    // unconditionally would pass the assertion above and fail this one.
    await db.sql`UPDATE harness_shared.harness_plans
                    SET items = jsonb_set(items, '{0,status}', '"done"')
                  WHERE plan_slug = 'toggle-plan'`;
    expect(await bothDoors('WI-TOGGLE')).toEqual([true, true]);
  });

  it("treats 'dropped' as SATISFIED, not as a blocker — a `<> 'done'` spelling would permanently starve 209 live lanes", async () => {
    // The obvious spelling of this floor is `status <> 'done'`. It is WRONG: measured 2026-08-04
    // there are 209 plan-items sitting at status='dropped', and every item behind one of them
    // would have become permanently unclaimable with no diagnosis path. The canonical TS
    // predicate (plan-parser effective-status.ts L178) counts BOTH terminal tokens as satisfied,
    // and floor #12's own terminal sets already include 'dropped'. This case pins that.
    await seedPlanWithItems('dropped-blocker', [
      { id: 'P-01', status: 'dropped' },
      { id: 'P-02', blockedBy: ['P-01'] },
    ]);
    await seedPlanLinkedIssue('WI-DROPPED-OK', 'dropped-blocker', 'P-02');

    expect(await bothDoors('WI-DROPPED-OK')).toEqual([true, true]);
  });

  it("keeps blocking on 'blocked' and 'needs-human' blockers — only the two TERMINAL tokens satisfy", async () => {
    // The control for the case above: widening "satisfied" past done|dropped would silently
    // un-gate real work, so the non-terminal end of the live status vocabulary is pinned too.
    await seedPlanWithItems('nonterminal-blockers', [
      { id: 'P-01', status: 'blocked' },
      { id: 'P-02', status: 'needs-human' },
      { id: 'P-03', blockedBy: ['P-01'] },
      { id: 'P-04', blockedBy: ['P-02'] },
    ]);
    await seedPlanLinkedIssue('WI-BLOCKED-BLOCKER', 'nonterminal-blockers', 'P-03');
    await seedPlanLinkedIssue('WI-NEEDSHUMAN-BLOCKER', 'nonterminal-blockers', 'P-04');

    const v = await doorVerdicts('WI-BLOCKED-BLOCKER', 'WI-NEEDSHUMAN-BLOCKER');
    expect(v['WI-BLOCKED-BLOCKER']).toEqual([false, false]);
    expect(v['WI-NEEDSHUMAN-BLOCKER']).toEqual([false, false]);
  });

  it('is TRANSITIVE without a recursive CTE — a blocker that is itself blocked is, by definition, not done', async () => {
    // P-03 blockedBy P-02 blockedBy P-01. The floor only ever looks ONE level, deliberately: the
    // work-item bound to P-03 is excluded because P-02 is not done, and P-02 cannot BE done while
    // it is itself blocked. A recursive CTE would buy nothing here and would put cycle risk on
    // the fleet-wide claim path. The P-01 row is the control — the head of the chain is free.
    await seedPlanWithItems('chain-plan', [
      { id: 'P-01', status: 'todo' },
      { id: 'P-02', blockedBy: ['P-01'] },
      { id: 'P-03', blockedBy: ['P-02'] },
    ]);
    await seedPlanLinkedIssue('WI-CHAIN-HEAD', 'chain-plan', 'P-01');
    await seedPlanLinkedIssue('WI-CHAIN-TAIL', 'chain-plan', 'P-03');

    const v = await doorVerdicts('WI-CHAIN-TAIL', 'WI-CHAIN-HEAD');
    expect(v['WI-CHAIN-TAIL']).toEqual([false, false]);
    expect(v['WI-CHAIN-HEAD']).toEqual([true, true]); // control: the head of the chain is free
  });

  it('a TERMINAL self-item is never blocked — the graph gates work that has not happened, it must not re-open work that has', async () => {
    // EI-19412899868617052: a stored terminal token wins over the blocked-by graph. Without the
    // self-status leg, an item whose own plan-item is already done, but whose blocker is still
    // running, would be excluded from its own claim.
    await seedPlanWithItems('self-terminal', [
      { id: 'P-01', status: 'todo' },
      { id: 'P-02', status: 'done', blockedBy: ['P-01'] },
    ]);
    await seedPlanLinkedIssue('WI-SELF-DONE', 'self-terminal', 'P-02');

    expect(await bothDoors('WI-SELF-DONE')).toEqual([true, true]);
  });

  it('a DANGLING blockedBy ref fails OPEN — no undiagnosable deadlock (a deliberate divergence from plan-parser)', async () => {
    // plan-parser pushes an unmatched ref into `unresolvedBlockers` ⇒ effectiveStatus 'blocked'.
    // This floor does NOT: the sibling join simply finds nothing. That matches the established
    // claim-floor convention ("an ABSENT / dangling blocker ref does NOT block (no deadlock)" —
    // claim-respects-blocking.integration.test.ts case 4), because the alternative failure mode
    // is an item nobody can claim and nobody can explain. Measured: exactly 1 dangling ref exists
    // across all live plans, so the fail-open surface is negligible.
    await seedPlanWithItems('dangling-plan', [{ id: 'P-01', blockedBy: ['P-NOPE'] }]);
    await seedPlanLinkedIssue('WI-DANGLING', 'dangling-plan', 'P-01');

    expect(await bothDoors('WI-DANGLING')).toEqual([true, true]);
  });

  it('a MALFORMED plan row cannot take down claiming for the whole fleet', async () => {
    // jsonb_array_elements RAISES on a non-array input, and this predicate runs on EVERY claim
    // for every agent — so one malformed plan row would break claiming entirely, not just its own
    // lane. Both element scans are jsonb_typeof-guarded. The unrelated control row proves the
    // claim path still SERVES work rather than merely not throwing.
    await db.sql`INSERT INTO harness_shared.harness_plans (plan_slug, status, op_status, items)
                  VALUES ('malformed-plan', 'ready', NULL, '{"not":"an array"}'::jsonb)`;
    await seedPlanLinkedIssue('WI-MALFORMED', 'malformed-plan', 'P-01');
    await seed('WI-UNRELATED');

    const v = await doorVerdicts('WI-UNRELATED', 'WI-MALFORMED');
    expect(v['WI-UNRELATED']).toEqual([true, true]);
    // the malformed row itself: no plan-item graph is readable, so it is not excluded by #13.
    expect(v['WI-MALFORMED']).toEqual([true, true]);
  });

  it('is TENANT-SCOPED on workspace_id — a same-slug plan in another workspace never blocks this one', async () => {
    // Floor #11 scopes the same way and for the same measured reason (7 plan slugs each exist in
    // 3 workspaces; (workspace_id, plan_slug) is unique). harness_slug is deliberately NOT part
    // of the key — the plan_item back-pointer's own copy drifted from the plan row's in migration
    // 656, so keying on it would silently un-block real lanes.
    await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id, plan_slug, status, op_status, items)
                  VALUES ('other-workspace', 'cross-tenant', 'draft', NULL,
                          '[{"id":"P-01","status":"todo"},{"id":"P-02","blockedBy":["P-01"]}]'::jsonb)`;
    await seedPlanLinkedIssue('WI-CROSS-TENANT', 'cross-tenant', 'P-02');

    // The blocking graph lives in a DIFFERENT workspace ⇒ it must not reach this row.
    expect(await bothDoors('WI-CROSS-TENANT')).toEqual([true, true]);
  });
});

/**
 * EI-20467873456529090 — terminal plan-item residue must be excluded before claim. The old
 * post-claim `planItemLaneBlockReason` guard was correct but too late: `work_items_claimable`,
 * scheduler aggregates, and fleet:bench all counted the open work-item first and could refuse to
 * bench a lane that had no actionable work. These seeds use the normalized plan-item index, which
 * is the status writer/read surface used by production plan-content derivation.
 */
describe('floor #14 terminal normalized plan-item — completed plan residue is not claimable (EI-20467873456529090)', () => {
  let probeSeq = 0;
  async function bothDoors(id: string): Promise<[boolean, boolean]> {
    const view = await viewClaimableIds();
    const drain = await drainInlineClaimIds(`terminal-plan-probe-${++probeSeq}`);
    await db.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE workspace_id = ${WS}`;
    return [view.includes(id), drain.includes(id)];
  }

  it.each(['done', 'dropped'])('excludes an open issue linked to a %s normalized plan-item', async (status) => {
    const planSlug = `terminal-${status}`;
    const itemId = `P-${status.toUpperCase()}`;
    await seedPlan(planSlug, 'ready');
    await seedNormalizedPlanItem(planSlug, itemId, status);
    await seedPlanLinkedIssue(`WI-TERMINAL-${status.toUpperCase()}`, planSlug, itemId);

    expect(await bothDoors(`WI-TERMINAL-${status.toUpperCase()}`)).toEqual([false, false]);
  });

  it('keeps a linked non-terminal plan-item claimable as the control', async () => {
    await seedPlan('live-control', 'ready');
    await seedNormalizedPlanItem('live-control', 'P-LIVE', 'todo');
    await seedPlanLinkedIssue('WI-LIVE-PLAN-CONTROL', 'live-control', 'P-LIVE');

    expect(await bothDoors('WI-LIVE-PLAN-CONTROL')).toEqual([true, true]);
  });
});

/**
 * P-001 (claimable-read-tool-and-sql-encapsulation-audit-2026-07-21): the read tool's two
 * primitives — `aggregateIssueClaimExclusions().claimable` (the survivors COUNT) and
 * `listIssueClaimableRows()` (the survivors ROW LIST) — are built on ONE shared inner
 * subquery + ONE shared all-floors-pass predicate, so the count and the list can never
 * disagree, and both apply the SAME per-row floors the scheduler does. These bind that.
 */
describe('work_items:claimable primitives — the survivors COUNT === the row LIST === the inline claim drain (P-001)', () => {
  it('count, list, and inline-drain all agree for a divergence-free seed; floors actually remove rows', async () => {
    const gn = await import('./get-next');
    // 3 plainly-claimable rows + one row per representative UNCONDITIONAL floor.
    await seed('WI-A'); // bug, claimable
    await seed('WI-B', { kind: 'change' }); // change, claimable
    await seed('WI-C', { kind: 'task' }); // task, claimable
    await seed('WI-TAKEN2', { takenBy: 'peer' }); // taken
    await seed('WI-HOLD2', { payload: { _claimHold: true } }); // claim-hold
    await seed('WI-NH2', {
      payload: {
        agentReview: { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-NH2', round: 1 },
      },
    }); // pending-review fixture uses the post-864 shape
    await seed('WI-OBS2', { kind: 'change', payload: { lane: 'observation' } }); // observation-lane
    await seed('WI-DONE2', { terminalOwner: 'su-x', terminalCompletionRef: 'commit:z' }); // already-completed
    await seedPlan('active2', 'active');
    await seedPlanLinkedIssue('WI-ACTIVE2', 'active2', 'P-9'); // reserved ACTIVE plan lane

    const breakdown = await gn.aggregateIssueClaimExclusions(undefined, { harness: H, assignee: 'probe' });
    const rows = await gn.listIssueClaimableRows(undefined, { harness: H, assignee: 'probe' }, 50);
    const expected = ['WI-A', 'WI-B', 'WI-C'];

    // 1. the row list is EXACTLY the claimable set (ordered ids).
    expect(rows.map((r) => r.id).sort()).toEqual(expected);
    // 2. the survivors COUNT equals the row-list length — the drift-proof SSOT guarantee.
    expect(breakdown.claimable).toBe(rows.length);
    expect(breakdown.claimable).toBe(expected.length);
    // 3. both equal what the REAL inline claim path drains (no rig/own-node/lease divergence here).
    expect(await drainInlineClaimIds()).toEqual(expected);
    // the floors genuinely removed rows (matched pre-floor strictly exceeds the survivors)…
    // 8, not 9: WI-OBS2 (lane=observation) is no longer a FLOORED row. Since P-009
    // (enterprise-data-sources-2026-10-01 D-022) the work predicate removes it in baseWhere,
    // BEFORE the pre-floor census; the absence loop below still proves it never survives.
    expect(breakdown.matchedByFilter).toBe(8);
    expect(breakdown.matchedByFilter).toBeGreaterThan(breakdown.claimable);
    // …and every floored row is absent from the survivors list.
    for (const floored of ['WI-TAKEN2', 'WI-HOLD2', 'WI-NH2', 'WI-OBS2', 'WI-DONE2', 'WI-ACTIVE2']) {
      expect(rows.map((r) => r.id)).not.toContain(floored);
    }
    // the projected row carries the self-selection fields.
    const a = rows.find((r) => r.id === 'WI-A')!;
    expect(a.kind).toBe('bug');
    expect(a.status).toBe('open');
  });

  it('a kind filter narrows both the count and the list; LIMIT caps the list only', async () => {
    const gn = await import('./get-next');
    await seed('WI-BUG1');
    await seed('WI-BUG2');
    await seed('WI-CHG1', { kind: 'change' });

    const bugOnly: import('./claim-spec').FilterNode = { field: 'kind', op: '=', value: 'bug' };
    const b = await gn.aggregateIssueClaimExclusions(bugOnly, { harness: H, assignee: 'probe' });
    expect(b.matchedByFilter).toBe(2); // the change row is filtered OUT before floors
    expect(b.claimable).toBe(2);

    const capped = await gn.listIssueClaimableRows(bugOnly, { harness: H, assignee: 'probe' }, 1);
    expect(capped).toHaveLength(1); // LIMIT honored (the count still reports the true 2)
    expect(capped[0]!.kind).toBe('bug');
  });
});

/**
 * REGRESSION GUARD — the CLAIM path must honor EVERY spec leg, not just kind/id.
 *
 * Why this block exists: the agreement tests above compared the read path and the claim
 * path only under NO filter and under a `kind` filter — the one filter shape the claim SQL
 * could already narrow by. Coverage therefore coincided exactly with the working case, and
 * the following live failure slipped through five successive patches to this area (WI-1407,
 * EI-10062, WI-4309, WI-5258, WI-5275), every one of which tuned id/kind extraction without
 * ever comparing the two paths on a leg the claim SQL could not express.
 *
 * The failure: `claimNextIssueWorkItem` saw only kind/id, so `paths`/`plan`/`title`/`tags`
 * legs were enforced only AFTER the atomic claim, by claim-spec-store.ts's post-claim
 * `matchesWorkItemClaimSpec` release-and-retry — which shares MAX_PLAN_LANE_ATTEMPTS (5), a
 * budget sized for consecutive plan-lane-BLOCKED candidates. Measured live on fleet
 * p2p-release (spec p2p-release-lane@9): 26 spec-matching rows out of 1073 lane-wide
 * claimable (2.4%), so P(>=1 match in 5 draws) ~= 11.6% — scheduler:get_next returned a
 * FALSE "no claimable work" on ~88% of pulls, indistinguishable from a drained lane, while
 * work_items:claimable correctly reported 26. Three fleet members independently misread that
 * as "floor-gated" when zero floors were firing.
 *
 * The shape matters: a TOP-LEVEL `any` is what makes this bite. positiveIdCohortIds
 * correctly refuses to extract a closed-world id set from an OR, so tier 3 runs unrestricted
 * and leans entirely on the post-claim bounce. Keep the `any` here.
 */
describe('the CLAIM path honors every spec leg, not just kind/id (false-drain regression)', () => {
  it('serves a narrow paths+id OR-shaped lane instead of falsely reporting it drained', async () => {
    const gn = await import('./get-next');

    // A lane where the spec's matches are a small MINORITY, and the non-matching rows rank
    // FIRST (older createdTs) — so a claim path blind to `paths` draws violators every time.
    for (let i = 0; i < 20; i++) await seed(`WI-OUT${i}`, { kind: 'change', createdTs: i });
    await seed('WI-INPATH1', {
      kind: 'change',
      createdTs: 900,
      payload: { paths: ['packages/operator-core/lib/p2p/boot.ts'] },
    });
    await seed('WI-INPATH2', {
      kind: 'change',
      createdTs: 901,
      payload: { paths: ['packages/operator-core/lib/p2p/wire.ts'] },
    });
    await seed('WI-INPIN', { kind: 'change', createdTs: 902 });

    const lane: import('./claim-spec').FilterNode = {
      any: [
        { field: 'id', op: 'in', value: ['WI-INPIN'] },
        { field: 'paths', op: 'glob', value: 'packages/operator-core/lib/p2p/*' },
      ],
    };
    const inLane = ['WI-INPATH1', 'WI-INPATH2', 'WI-INPIN'];

    // The READ path was always correct — pin it as the oracle.
    const rows = await gn.listIssueClaimableRows(lane, { harness: H, assignee: 'probe' }, 50);
    expect(rows.map((r) => r.id).sort()).toEqual(inLane);

    // The CLAIM path must now agree. Pre-fix this drained WI-OUT* rows (spec violations the
    // caller then had to bounce) or, under the real bounded retry, returned nothing at all.
    const compiled = gn.compileFilter(db.sql as never, lane);
    const claimed: string[] = [];
    for (let i = 0; i < 50; i++) {
      const got = await wi.claimNextIssueWorkItem({ harness: H, assignee: 'probe' }, WS, { specFilterSql: compiled });
      if (!got) break;
      claimed.push(got.id);
    }

    // 1. The lane is SERVED, not falsely drained — this is the actual regression.
    expect(claimed.length).toBeGreaterThan(0);
    // 2. It serves EXACTLY the spec-matching rows: no violator ever reaches the member, so
    //    the post-claim quarantine release (and its spurious-wake fanout) never has to run.
    expect(claimed.sort()).toEqual(inLane);
    // 3. Claim and read agree — the SSOT guarantee, now extended to the claim path.
    expect(claimed.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('an undefined spec filter still drains the whole lane (the narrowing is opt-in)', async () => {
    await seed('WI-FREE1', { kind: 'change', createdTs: 1 });
    await seed('WI-FREE2', { kind: 'bug', createdTs: 2 });
    expect(await drainInlineClaimIds()).toEqual(['WI-FREE1', 'WI-FREE2']);
  });
});

describe('floor #16 implementation-readiness: view, 12-arg floor labels and the TS claim path agree (P-007, migration 1301)', () => {
  const PRE = 1;
  const POST = IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS + 60_000;
  const TITLE = 'Bounded parser drops the trailing token';
  const SUMMARY = 'The bounded parser drops the last token of every line.';
  const UPDATED_AT = '2026-10-01T00:00:00.000Z';
  const PROPOSAL = {
    problem: 'The bounded parser drops the trailing token of a line.',
    evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
    outcome: 'Every token of a line survives parsing.',
    scope: 'Fix the bounded parser defect only.',
    completionCheck: 'The trailing-token regression fixture passes.',
  };
  const sealedFor = (title: string): ImplementationAcceptanceContract => {
    const sealed = sealImplementationAcceptance({
      proposal: PROPOSAL,
      authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1 },
      reason: 'agent-review-approved (grade 5/5)',
      source: { kind: 'bug', title, summary: SUMMARY },
      acceptedAt: UPDATED_AT,
      // P-006: a bug's acceptance carries its reproduction receipt.
      reproduction: { kind: 'failing-test', ref: 'fixture.test.ts', buildSha: 'abcdef1' },
    });
    if (!sealed.ok) throw new Error('fixture contract must seal');
    return sealed.contract;
  };
  const readiness = (status: 'ready' | 'unknown' | 'not-ready', source: 'agent-review' | 'creation-enrollment', acceptance?: object) => ({
    implementationReadiness: createImplementationReadiness({
      status,
      source,
      // A non-ready verdict is a hold, so it carries the registered reason its real writer
      // uses (hold-registry.ts, D-026); createImplementationReadiness refuses any other.
      reason:
        status === 'ready'
          ? source === 'creation-enrollment' ? 'created' : 'agent-review-approved'
          : source === 'creation-enrollment' ? 'no-acceptance-evidence-at-creation' : 'awaiting-agent-review',
      updatedAt: UPDATED_AT,
      ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
    }),
  });
  const qualifying = () => readiness('ready', 'agent-review', sealedFor(TITLE));
  // Sealed against a DIFFERENT title, so the row's current source revision no longer matches.
  const stale = () => readiness('ready', 'agent-review', sealedFor('An earlier title of the same defect'));
  // A self-review: reviewer === submittedBy is not an independent acceptance authority.
  const selfReviewed = () =>
    readiness('ready', 'agent-review', {
      ...sealedFor(TITLE),
      authority: { kind: 'agent-review', reviewer: 'su-author', submittedBy: 'su-author', round: 1 },
    });

  const cases: Array<{ id: string; createdTs: number; payload: Record<string, unknown> | null; admit: boolean }> = [
    { id: 'WI-F16-PRE-ABSENT', createdTs: PRE, payload: null, admit: true },
    { id: 'WI-F16-POST-ABSENT', createdTs: POST, payload: null, admit: false },
    { id: 'WI-F16-PRE-ENROLLED', createdTs: PRE, payload: readiness('unknown', 'creation-enrollment'), admit: true },
    { id: 'WI-F16-POST-ENROLLED', createdTs: POST, payload: readiness('unknown', 'creation-enrollment'), admit: false },
    { id: 'WI-F16-PRE-NOT-READY', createdTs: PRE, payload: readiness('not-ready', 'agent-review'), admit: false },
    { id: 'WI-F16-PRE-READY-BARE', createdTs: PRE, payload: readiness('ready', 'agent-review'), admit: true },
    { id: 'WI-F16-POST-READY-BARE', createdTs: POST, payload: readiness('ready', 'agent-review'), admit: false },
    { id: 'WI-F16-POST-QUALIFYING', createdTs: POST, payload: qualifying(), admit: true },
    { id: 'WI-F16-PRE-STALE', createdTs: PRE, payload: stale(), admit: false },
    { id: 'WI-F16-POST-STALE', createdTs: POST, payload: stale(), admit: false },
    { id: 'WI-F16-PRE-SELF-REVIEW', createdTs: PRE, payload: selfReviewed(), admit: false },
  ];

  it('the SQL helper body IS the TypeScript floor, re-rendered (a TS edit without a migration fails here)', async () => {
    let captured: { query: string; params: unknown[] } | null = null;
    const probe = postgres(db.url, {
      max: 1,
      debug: (_connection, query, params) => {
        captured = { query, params: params as unknown[] };
      },
    });
    try {
      await probe`
        SELECT ${implementationReadinessNormalExclusionSql(probe as unknown as OrgSql, 'payload', 'work_items')} AS admits
          FROM (SELECT NULL::jsonb AS payload, 'bug'::text AS item_kind, ''::text AS title,
                       ''::text AS summary, 0::bigint AS created_ts) AS row_columns`;
    } finally {
      await probe.end();
    }
    if (!captured) throw new Error('the probe query was never captured');
    const { query, params } = captured as { query: string; params: unknown[] };
    const literal = (v: unknown): string =>
      v === null || v === undefined
        ? 'NULL'
        : typeof v === 'number' || typeof v === 'bigint'
          ? String(v)
          : `'${String(v).replace(/'/g, "''")}'`;
    const inlined = query.replace(/\$(\d+)/g, (_m, n: string) => literal(params[Number(n) - 1]));
    const rendered = inlined.slice(inlined.indexOf('SELECT') + 'SELECT'.length, inlined.lastIndexOf(' AS admits'));
    const [{ prosrc }] = await db.sql<{ prosrc: string }[]>`
      SELECT prosrc FROM pg_proc
       WHERE oid = 'harness_shared.work_item_implementation_readiness_admits(jsonb,text,text,text,bigint)'::regprocedure`;
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    // Calibration: the rendered fragment is the real floor, not an empty or truncated slice.
    expect(normalize(rendered)).toContain("'implementation-readiness-v1'");
    expect(normalize(rendered)).toContain(String(IMPLEMENTATION_ACCEPTANCE_ENFORCEMENT_CUTOVER_MS));
    expect(normalize(prosrc)).toContain(normalize(rendered));
  });

  it('keeps static acceptance distinct from a current-build reproduction refusal and rolls back the claim', async () => {
    await seed('WI-F16-CURRENT-REPRO', { createdTs: POST, payload: qualifying(), title: TITLE });
    await db.sql`UPDATE harness_shared.work_items SET summary = ${SUMMARY}
      WHERE workspace_id = ${WS} AND feature_id = 'WI-F16-CURRENT-REPRO'`;
    expect(await viewClaimableIds()).toEqual(['WI-F16-CURRENT-REPRO']);
    h.currentBuild = 'abcdef2';
    expect(await wi.claimNextIssueWorkItem({ harness: H, assignee: 'probe' }, WS)).toBeNull();
    const [row] = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = 'WI-F16-CURRENT-REPRO'
    `;
    expect(row.taken_by).toBeNull();
    h.currentBuild = 'abcdef1';
    expect((await wi.claimNextIssueWorkItem({ harness: H, assignee: 'probe' }, WS))?.id)
      .toBe('WI-F16-CURRENT-REPRO');
  });

  it('view membership === TS twin === TS claim drain over a pre/post-cutover matrix; refused rows carry the label', async () => {
    for (const c of cases) await seed(c.id, { createdTs: c.createdTs, payload: c.payload, title: TITLE });
    await db.sql`UPDATE harness_shared.work_items SET summary = ${SUMMARY} WHERE feature_id LIKE 'WI-F16-%'`;
    const expected = cases.filter((c) => c.admit).map((c) => c.id).sort();

    // The TypeScript twin the by-id / assignment claim paths use agrees with every declared row.
    for (const c of cases) {
      const admits = implementationReadinessAdmitsClaim({
        payload: c.payload ?? {},
        kind: 'bug',
        title: TITLE,
        summary: SUMMARY,
        createdAtMs: c.createdTs,
      });
      expect([c.id, admits]).toEqual([c.id, c.admit]);
    }

    const viewIds = (
      await db.sql<{ feature_id: string }[]>`
        SELECT feature_id FROM harness_shared.work_items_claimable WHERE feature_id LIKE 'WI-F16-%'`
    )
      .map((r) => r.feature_id)
      .sort();
    expect(viewIds).toEqual(expected);

    const labels = await db.sql<{ feature_id: string; floors: string[] }[]>`
      SELECT feature_id,
             harness_shared.work_item_claim_floors(
               workspace_id, status, taken_by, origin, title, terminal_owner, terminal_completion_ref,
               payload, feature_id, item_kind, summary, created_ts
             ) AS floors
        FROM harness_shared.work_items
       WHERE feature_id LIKE 'WI-F16-%'
       ORDER BY feature_id`;
    expect(labels).toHaveLength(cases.length);
    for (const r of labels) {
      const refused = !expected.includes(r.feature_id);
      expect([r.feature_id, r.floors.includes('implementation-readiness')]).toEqual([r.feature_id, refused]);
      // Floor #16 is the ONLY reason any of these rows is refused.
      expect([r.feature_id, r.floors.filter((f) => f !== 'implementation-readiness')]).toEqual([r.feature_id, []]);
    }

    expect(await drainInlineClaimIds()).toEqual(expected);
  });

  it('P-006 / D-019: the verification check is chosen by kind — after the cutover the view, the TS twin and the drain refuse a bug with no reproduction receipt and a change with no proposal review', async () => {
    const CHANGE_TITLE = 'Collapse the duplicate intake gates into one stage';
    const sealedChange = (): ImplementationAcceptanceContract => {
      const sealed = sealImplementationAcceptance({
        proposal: PROPOSAL,
        authority: { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1 },
        reason: 'agent-review-approved (grade 5/5)',
        source: { kind: 'change', title: CHANGE_TITLE, summary: SUMMARY },
        acceptedAt: UPDATED_AT,
      });
      if (!sealed.ok) throw new Error('fixture change contract must seal');
      return sealed.contract;
    };
    // A bug contract with its receipt removed: the shape of an acceptance written before P-006.
    const bugWithoutReceipt: Record<string, unknown> = { ...sealedFor(TITLE) };
    delete bugWithoutReceipt.verification;
    expect(bugWithoutReceipt).not.toHaveProperty('verification');
    // A bug that carries the change-kind check instead of a reproduction receipt.
    const bugWrongCheck = { ...sealedFor(TITLE), verification: { check: 'proposal-review' } };
    // A change accepted by a policy authority: no proposal review took place.
    const changeByPolicy = {
      ...sealedChange(),
      authority: { kind: 'policy', policy: 'trusted-tool-failure-promotion', actor: 'capture' },
    };
    const kindCases: Array<{ id: string; kind: string; title: string; createdTs: number; acceptance: object; admit: boolean }> = [
      { id: 'WI-K16-POST-BUG-RECEIPT', kind: 'bug', title: TITLE, createdTs: POST, acceptance: sealedFor(TITLE), admit: true },
      { id: 'WI-K16-POST-BUG-NO-RECEIPT', kind: 'bug', title: TITLE, createdTs: POST, acceptance: bugWithoutReceipt, admit: false },
      { id: 'WI-K16-POST-BUG-WRONG-CHECK', kind: 'bug', title: TITLE, createdTs: POST, acceptance: bugWrongCheck, admit: false },
      { id: 'WI-K16-POST-CHANGE-REVIEWED', kind: 'change', title: CHANGE_TITLE, createdTs: POST, acceptance: sealedChange(), admit: true },
      { id: 'WI-K16-POST-CHANGE-POLICY', kind: 'change', title: CHANGE_TITLE, createdTs: POST, acceptance: changeByPolicy, admit: false },
      // Before the WI-10005016 cutover the legacy branch still admits an incomplete contract (D-019).
      { id: 'WI-K16-PRE-BUG-NO-RECEIPT', kind: 'bug', title: TITLE, createdTs: PRE, acceptance: bugWithoutReceipt, admit: true },
      { id: 'WI-K16-PRE-CHANGE-POLICY', kind: 'change', title: CHANGE_TITLE, createdTs: PRE, acceptance: changeByPolicy, admit: true },
    ];
    for (const c of kindCases) {
      await seed(c.id, {
        kind: c.kind,
        createdTs: c.createdTs,
        payload: readiness('ready', 'agent-review', c.acceptance),
        title: c.title,
      });
    }
    await db.sql`UPDATE harness_shared.work_items SET summary = ${SUMMARY} WHERE feature_id LIKE 'WI-K16-%'`;
    const expected = kindCases.filter((c) => c.admit).map((c) => c.id).sort();

    for (const c of kindCases) {
      const admits = implementationReadinessAdmitsClaim({
        payload: readiness('ready', 'agent-review', c.acceptance),
        kind: c.kind,
        title: c.title,
        summary: SUMMARY,
        createdAtMs: c.createdTs,
      });
      expect([c.id, admits]).toEqual([c.id, c.admit]);
    }

    const viewIds = (
      await db.sql<{ feature_id: string }[]>`
        SELECT feature_id FROM harness_shared.work_items_claimable WHERE feature_id LIKE 'WI-K16-%'`
    )
      .map((r) => r.feature_id)
      .sort();
    expect(viewIds).toEqual(expected);

    const labels = await db.sql<{ feature_id: string; floors: string[] }[]>`
      SELECT feature_id,
             harness_shared.work_item_claim_floors(
               workspace_id, status, taken_by, origin, title, terminal_owner, terminal_completion_ref,
               payload, feature_id, item_kind, summary, created_ts
             ) AS floors
        FROM harness_shared.work_items
       WHERE feature_id LIKE 'WI-K16-%'
       ORDER BY feature_id`;
    expect(labels).toHaveLength(kindCases.length);
    for (const r of labels) {
      const refused = !expected.includes(r.feature_id);
      expect([r.feature_id, r.floors.includes('implementation-readiness')]).toEqual([r.feature_id, refused]);
      expect([r.feature_id, r.floors.filter((f) => f !== 'implementation-readiness')]).toEqual([r.feature_id, []]);
    }

    expect(await drainInlineClaimIds()).toEqual(expected);
  });
});
