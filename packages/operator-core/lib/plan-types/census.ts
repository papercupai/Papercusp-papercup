/**
 * The registry census (plan-item-types-registry-cupboard-2026-10-20 P-001, requirement R-3):
 * the evidence that the registry and its first-party seed change no existing verdict.
 *
 * For every plan it captures three verdicts, each from the REAL gate, under one resolver:
 * - SHIP: `evaluatePlanAcceptanceGate` with `SHIP_VERDICT_CENSUS_GATE_OPTS` (re-evaluate a
 *   shipped plan in full, collect every blocker): the predecessor's ship census, reused.
 * - START: `readAndEvaluateAcceptanceBarLifecycle(slug, 'pre-start', { requireComplete... })`,
 *   the resolver-dependent leg of `checkPlanStartable` (plans:start). The start door's other
 *   legs (input readiness, governance admission) never consult the resolver, and its pin
 *   reconcile is a WRITE, so the census leaves them out.
 * - COMPLETION: the resolver-dependent checks `work_items:complete` applies to each plan
 *   item: the R-13 tests-run exemption (`linkedDeliverablesAreNonCode`), the spec-test
 *   adequacy floor (`readClauseCodeDeliverables`), and the R-15 contradiction between a
 *   non-code deliverable and code evidence on its closed work items
 *   (`readNonCodeDeliverableShipEvidence`). plans:audit's own resolver use is the same
 *   predicate as the ship gate's code-citation leg, which the SHIP verdict re-evaluates.
 *
 * `runPlanVerdictCensus` runs under whichever resolver is passed (legacy or registry) through
 * `withVerificationResolver`, so before and after differ in exactly one variable.
 * `diffPlanVerdictCensus` reports every changed verdict, any error row, and whether the
 * census compared the whole population.
 */
import type postgres from 'postgres';
import {
  resolveVerificationLegacy,
  withVerificationResolver,
  DELIVERABLE_KINDS,
  DOMAIN_MODULES,
  VERIFICATION_PROFILES,
  type VerificationItemInput,
  type VerificationPlanInput,
  type VerificationResolver,
} from '../plan-verification-profile';
import {
  SHIP_VERDICT_CENSUS_GATE_OPTS,
  diffShipVerdicts,
  shipVerdictSnapshot,
  type ShipVerdictSnapshot,
} from '../agent-tools/plans/verification-profile-backfill';

export interface CensusPlanRef {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export interface StartVerdictSnapshot extends CensusPlanRef {
  satisfied: boolean | null;
  codes: string[];
  error?: string;
}

export interface CompletionVerdictSnapshot extends CensusPlanRef {
  /** Per plan item, sorted: `<itemId>:close=<code|non-code>:floor=<code|non-code|absent>`. */
  items: string[];
  /** R-15 contradictions, sorted: `<itemId>/<workItemId>:<signal>+<signal>`. */
  closeEvidence: string[];
  error?: string;
}

export interface PlanVerdictCensusRow {
  plan: CensusPlanRef;
  ship: ShipVerdictSnapshot;
  start: StartVerdictSnapshot;
  completion: CompletionVerdictSnapshot;
}

export type CensusVerdictKind = 'ship' | 'start' | 'completion';

export interface PlanVerdictCensusDiff {
  /** Plans in the before census: the population both sides are measured against. */
  population: number;
  compared: number;
  unchanged: number;
  changed: Array<{ key: string; kinds: CensusVerdictKind[]; before: PlanVerdictCensusRow; after: PlanVerdictCensusRow }>;
  onlyBefore: string[];
  onlyAfter: string[];
  /** `<side>:<kind>:<key>: <error>` for every verdict that threw, on either side. */
  errorRows: string[];
  /** True when every plan was compared, nothing changed and nothing threw. */
  zeroChange: boolean;
}

export function censusKey(plan: CensusPlanRef): string {
  return `${plan.workspaceId}/${plan.harnessSlug}/${plan.planSlug}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every plan row in the scope: the population a live census must cover. */
export async function listCensusPopulation(
  sql: postgres.Sql,
  scope: { workspaceId: string; harnessSlug?: string },
): Promise<CensusPlanRef[]> {
  const harnessFilter = scope.harnessSlug ? sql`AND harness_slug = ${scope.harnessSlug}` : sql``;
  const rows = await sql<Array<{ workspace_id: string; harness_slug: string; plan_slug: string }>>`
    SELECT workspace_id, harness_slug, plan_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       ${harnessFilter}
     ORDER BY harness_slug, plan_slug`;
  return rows.map((row) => ({ workspaceId: row.workspace_id, harnessSlug: row.harness_slug, planSlug: row.plan_slug }));
}

async function shipVerdict(plan: CensusPlanRef): Promise<ShipVerdictSnapshot> {
  try {
    const { evaluatePlanAcceptanceGate } = await import('../plan-acceptance-gate');
    const gate = await evaluatePlanAcceptanceGate(plan.planSlug, {
      harnessSlug: plan.harnessSlug,
      ...SHIP_VERDICT_CENSUS_GATE_OPTS,
    });
    return shipVerdictSnapshot(plan, gate);
  } catch (error) {
    return { ...plan, satisfied: null, code: null, blockers: [], skipped: null, error: errorText(error) };
  }
}

async function startVerdict(plan: CensusPlanRef): Promise<StartVerdictSnapshot> {
  try {
    const { readAndEvaluateAcceptanceBarLifecycle } = await import('../acceptance-bar-lifecycle-evaluator');
    const verdict = await readAndEvaluateAcceptanceBarLifecycle(plan.planSlug, 'pre-start', {
      harnessSlug: plan.harnessSlug,
      requireCompleteContractBeforeProof: true,
    });
    return { ...plan, satisfied: verdict.satisfied, codes: [...new Set(verdict.codes)].sort() };
  } catch (error) {
    return { ...plan, satisfied: null, codes: [], error: errorText(error) };
  }
}

async function completionVerdict(sql: postgres.Sql, plan: CensusPlanRef): Promise<CompletionVerdictSnapshot> {
  try {
    const escape = await import('../plan-verification-escape');
    const rows = await sql<Array<{ item_id: string; deliverable: string | null; verification_profile: string | null }>>`
      SELECT i.item_id, i.deliverable, p.verification_profile
        FROM harness_shared.plan_items i
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = i.workspace_id AND p.harness_slug = i.harness_slug AND p.plan_slug = i.plan_slug
       WHERE i.workspace_id = ${plan.workspaceId}
         AND i.harness_slug = ${plan.harnessSlug}
         AND i.plan_slug = ${plan.planSlug}
       ORDER BY i.item_id`;
    const floors = await escape.readClauseCodeDeliverables({
      harnessSlug: plan.harnessSlug,
      workspaceId: plan.workspaceId,
      clauses: rows.map((row) => ({ planSlug: plan.planSlug, planItemId: row.item_id })),
    });
    const items = rows.map((row) => {
      const close = escape.linkedDeliverablesAreNonCode([row]) ? 'non-code' : 'code';
      const floor = floors.get(escape.clauseDeliverableKey(plan.planSlug, row.item_id));
      return `${row.item_id}:close=${close}:floor=${floor === undefined ? 'absent' : floor ? 'code' : 'non-code'}`;
    });
    const hits = await escape.readNonCodeDeliverableShipEvidence(plan);
    const closeEvidence = hits
      .map((hit) => `${hit.itemId}/${hit.workItemId}:${[...hit.evidence.signals].sort().join('+')}`)
      .sort();
    return { ...plan, items: items.sort(), closeEvidence };
  } catch (error) {
    return { ...plan, items: [], closeEvidence: [], error: errorText(error) };
  }
}

/**
 * Capture every plan's three verdicts under `resolver`. Plans run one at a time, inside the
 * plan's workspace, so a census never competes with itself for the pool.
 */
export async function runPlanVerdictCensus(input: {
  sql: postgres.Sql;
  plans: readonly CensusPlanRef[];
  resolver: VerificationResolver;
  onProgress?: (done: number, total: number) => void;
}): Promise<PlanVerdictCensusRow[]> {
  const { runWithWorkspace } = await import('../workspace-als');
  const out: PlanVerdictCensusRow[] = [];
  for (const plan of input.plans) {
    const row = await runWithWorkspace(plan.workspaceId, () =>
      withVerificationResolver(input.resolver, async () => ({
        plan,
        ship: await shipVerdict(plan),
        start: await startVerdict(plan),
        completion: await completionVerdict(input.sql, plan),
      })),
    );
    out.push(row);
    input.onProgress?.(out.length, input.plans.length);
  }
  return out;
}

/** The legacy resolver, named for the census's "before" side. */
export const LEGACY_VERIFICATION_RESOLVER: VerificationResolver = resolveVerificationLegacy;

function sameStart(a: StartVerdictSnapshot, b: StartVerdictSnapshot): boolean {
  return a.satisfied === b.satisfied && a.codes.join(',') === b.codes.join(',') && Boolean(a.error) === Boolean(b.error);
}

function sameCompletion(a: CompletionVerdictSnapshot, b: CompletionVerdictSnapshot): boolean {
  return a.items.join('|') === b.items.join('|')
    && a.closeEvidence.join('|') === b.closeEvidence.join('|')
    && Boolean(a.error) === Boolean(b.error);
}

export function diffPlanVerdictCensus(
  before: readonly PlanVerdictCensusRow[],
  after: readonly PlanVerdictCensusRow[],
): PlanVerdictCensusDiff {
  const afterByKey = new Map(after.map((row) => [censusKey(row.plan), row]));
  const beforeKeys = new Set<string>();
  const changed: PlanVerdictCensusDiff['changed'] = [];
  let unchanged = 0;
  for (const b of before) {
    const key = censusKey(b.plan);
    beforeKeys.add(key);
    const a = afterByKey.get(key);
    if (!a) continue;
    const kinds: CensusVerdictKind[] = [];
    if (diffShipVerdicts([b.ship], [a.ship]).changed.length > 0) kinds.push('ship');
    if (!sameStart(b.start, a.start)) kinds.push('start');
    if (!sameCompletion(b.completion, a.completion)) kinds.push('completion');
    if (kinds.length === 0) unchanged += 1;
    else changed.push({ key, kinds, before: b, after: a });
  }
  const errorRows: string[] = [];
  for (const [side, rows] of [['before', before], ['after', after]] as const) {
    for (const row of rows) {
      const key = censusKey(row.plan);
      if (row.ship.error) errorRows.push(`${side}:ship:${key}: ${row.ship.error}`);
      if (row.start.error) errorRows.push(`${side}:start:${key}: ${row.start.error}`);
      if (row.completion.error) errorRows.push(`${side}:completion:${key}: ${row.completion.error}`);
    }
  }
  const onlyBefore = [...beforeKeys].filter((key) => !afterByKey.has(key));
  const onlyAfter = [...afterByKey.keys()].filter((key) => !beforeKeys.has(key));
  const compared = unchanged + changed.length;
  return {
    population: before.length,
    compared,
    unchanged,
    changed,
    onlyBefore,
    onlyAfter,
    errorRows,
    zeroChange: compared === before.length && changed.length === 0 && errorRows.length === 0
      && onlyBefore.length === 0 && onlyAfter.length === 0,
  };
}

/**
 * Every input the built-in vocabulary can produce: each profile (and none), each kind (and
 * none, and an unparseable string), each non-code signal, and each domain-module subset. A
 * resolver that equals the legacy one on all of these equals it everywhere the gates reach.
 *
 * A namespaced type slug is deliberately NOT here: the legacy resolver ignores it, while the
 * registry resolver holds an unregistered one to the strictest module set (R-6). That is an
 * intended divergence, so it is enumerated separately by `enumerateUnregisteredTypeInputs`.
 */
export function enumerateResolverInputs(): Array<{ plan: VerificationPlanInput; item: VerificationItemInput }> {
  return enumerateInputsOver([...DELIVERABLE_KINDS, null, 'Not A Kind!']);
}

/**
 * The same input grid with every item declaring `deliverable` (default: an unregistered
 * namespaced item type). The registry resolver must hold each to the strictest module set.
 */
export function enumerateUnregisteredTypeInputs(
  deliverable = 'acme/legal-review',
): Array<{ plan: VerificationPlanInput; item: VerificationItemInput }> {
  return enumerateInputsOver([deliverable]);
}

function enumerateInputsOver(
  deliverables: Array<string | null>,
): Array<{ plan: VerificationPlanInput; item: VerificationItemInput }> {
  const profiles: Array<string | null> = [...VERIFICATION_PROFILES, null, 'not-a-profile'];
  const auditVerdicts: Array<string | null> = [null, 'not-code', 'implemented', 'dropped'];
  const workItemKinds: Array<string | null> = [null, 'task', 'feature', 'bug'];
  const domainSets = [[], ...DOMAIN_MODULES.map((m) => [m]), [...DOMAIN_MODULES]];
  const out: Array<{ plan: VerificationPlanInput; item: VerificationItemInput }> = [];
  for (const verificationProfile of profiles) {
    for (const deliverable of deliverables) {
      for (const auditVerdict of auditVerdicts) {
        for (const workItemKind of workItemKinds) {
          for (const domainModules of domainSets) {
            out.push({ plan: { verificationProfile }, item: { deliverable, auditVerdict, workItemKind, domainModules } });
          }
        }
      }
    }
  }
  return out;
}
