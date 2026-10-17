/** Bounded organization -> department -> project budget allocations and pilot
 * outcome-cost records (enterprise readiness P-009, WI-10007904).
 *
 * Extends the hosted budget seam (budget-store.ts / migration 1352) instead of
 * adding a second funding ledger. Every writer takes the SAME organization
 * fence as PostgresHostedBudgetStore (lockHostedBudgetOrganization), so these
 * functions compose inside a budget-store transaction and concurrent writers
 * serialize. Money is integer micro-USD.
 *
 * - Trees are per (organization, month, cost class): model, hosting and
 *   subscription costs never share a cap or a total.
 * - Children's caps never sum above their parent's cap; a reservation is
 *   admitted only when it fits every node from its project to the root.
 * - A hold commits its maximum until a provider-final settlement. Money that is
 *   committed but not yet provider-final is "unreconciled" and is bounded per
 *   node by max_unreconciled_micros at admission.
 * - Outcome records carry result cost, review effort and rework as either a
 *   value or an explicit unknown reason, never a silent zero.
 *
 * Figures are engineering inputs on the ASSUMED enterprise profile
 * (docs/evidence/enterprise-assumed-profile-2026-10-13.md), never buyer facts.
 */
import { createHash } from 'node:crypto';
import { withHostedServiceContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { lockHostedBudgetOrganization } from './budget-store';
import { addMicrosDecimals } from '../../../cupboard/money-journal';
import { projectHostedMonthlyCost, type HostedUsageForecast, type HostedUsageSourceCensus } from './usage-statement';

export const HOSTED_COST_CLASSES = ['model', 'hosting', 'subscription'] as const;
export type HostedCostClass = typeof HOSTED_COST_CLASSES[number];
export type HostedAllocationLevel = 'organization' | 'department' | 'project';
export type HostedHoldCostSource = 'unpriced' | 'estimate' | 'provider-reported' | 'provider-billed';
export type HostedOutcomeEvidenceClass = 'internal-simulation' | 'synthetic' | 'customer';
export type HostedOutcomeResultState = 'accepted' | 'rejected' | 'rework-requested' | 'unknown';
/** A measured value, or an explicit statement that it is not known and why. */
export type KnownOrUnknown<T> = { readonly value: T } | { readonly unknownReason: string };

export interface HostedAllocationOrganization {
  readonly controlWorkspaceId: string;
  readonly organizationId: string;
}
export interface HostedAllocationRequest {
  readonly organization: HostedAllocationOrganization;
  readonly allocationId: string;
  readonly parentAllocationId: string | null;
  readonly level: HostedAllocationLevel;
  readonly costClass: HostedCostClass;
  readonly month: string;
  readonly capMicros: number;
  readonly maxUnreconciledMicros: number;
  readonly evidenceRef: string;
  readonly recordedBy: string;
}
export interface HostedAllocation {
  readonly allocationId: string;
  readonly parentAllocationId: string | null;
  readonly level: HostedAllocationLevel;
  readonly costClass: HostedCostClass;
  readonly month: string;
  readonly capMicros: number;
  readonly maxUnreconciledMicros: number;
  readonly revision: number;
}
export type HostedAllocationOutcome =
  | { readonly outcome: 'created' | 'revised' | 'duplicate'; readonly allocation: HostedAllocation }
  | { readonly outcome: 'conflict' | 'refused'; readonly reason: string; readonly allocation: HostedAllocation | null };

export interface HostedAllocationHoldRequest {
  readonly organization: HostedAllocationOrganization;
  /** Same identifier namespace as hosted_budget_receipts.reservation_id. */
  readonly reservationId: string;
  readonly allocationId: string;
  readonly costClass: HostedCostClass;
  readonly month: string;
  /** Server/provider-enforced maximum, never a forecast. */
  readonly maximumCostMicros: number;
  readonly observedAtMs: number;
  readonly evidenceRef: string;
}
export interface HostedAllocationHold {
  readonly reservationId: string;
  readonly allocationId: string;
  readonly costClass: HostedCostClass;
  readonly month: string;
  readonly maximumCostMicros: number;
  readonly requestHash: string;
  readonly revision: number;
  readonly costSource: HostedHoldCostSource;
  readonly costMicros: number | null;
  readonly providerFinal: boolean;
  readonly observedAtMs: number;
}
export type HostedAllocationHoldOutcome =
  | { readonly outcome: 'admitted' | 'duplicate' | 'settled'; readonly hold: HostedAllocationHold }
  | { readonly outcome: 'refused' | 'conflict'; readonly reason: string; readonly allocationId: string | null;
      readonly hold: HostedAllocationHold | null };
export interface HostedAllocationSettlement {
  readonly organization: HostedAllocationOrganization;
  readonly reservationId: string;
  readonly costSource: HostedHoldCostSource;
  readonly costMicros: number | null;
  /** Only a provider-billed final amount releases unreconciled exposure. */
  readonly providerFinal: boolean;
  readonly observedAtMs: number;
  readonly evidenceRef: string;
}

export interface HostedOutcomeRecordRequest {
  readonly organization: HostedAllocationOrganization;
  readonly outcomeId: string;
  readonly allocationId: string;
  readonly workflowRef: string;
  readonly evidenceClass: HostedOutcomeEvidenceClass;
  readonly result: { readonly state: Exclude<HostedOutcomeResultState, 'unknown'> }
    | { readonly state: 'unknown'; readonly unknownReason: string };
  readonly reservationIds: readonly string[];
  /** Omit to derive from the linked holds: any hold not yet provider-final
   * makes the result cost an explicit unknown naming the pending holds. */
  readonly resultCostMicros?: KnownOrUnknown<number>;
  readonly reviewEffortSeconds: KnownOrUnknown<number>;
  readonly reworkCount: KnownOrUnknown<number>;
  readonly observedAtMs: number;
  readonly evidenceRef: string;
  readonly recordedBy: string;
}
export interface HostedOutcomeRecord {
  readonly outcomeId: string;
  readonly revision: number;
  readonly allocationId: string;
  readonly workflowRef: string;
  readonly evidenceClass: HostedOutcomeEvidenceClass;
  readonly resultState: HostedOutcomeResultState;
  readonly resultUnknownReason: string | null;
  readonly reservationIds: readonly string[];
  readonly resultCostMicros: KnownOrUnknown<number>;
  readonly reviewEffortSeconds: KnownOrUnknown<number>;
  readonly reworkCount: KnownOrUnknown<number>;
}
export type HostedOutcomeRecordOutcome =
  | { readonly outcome: 'recorded'; readonly record: HostedOutcomeRecord }
  | { readonly outcome: 'refused'; readonly reason: string; readonly record: null };

export interface HostedAllocationPosition {
  readonly allocationId: string;
  readonly parentAllocationId: string | null;
  readonly level: HostedAllocationLevel;
  readonly capMicros: number;
  readonly maxUnreconciledMicros: number;
  readonly committedMicros: number;
  readonly unreconciledMicros: number;
  readonly providerFinalMicros: number;
  readonly availableMicros: number;
  readonly openHolds: number;
}
export interface HostedOutcomeCostSummary {
  readonly allocationId: string;
  readonly outcomes: number;
  readonly byState: Readonly<Record<HostedOutcomeResultState, number>>;
  readonly evidenceClasses: readonly HostedOutcomeEvidenceClass[];
  readonly acceptedResultCostMicros: number;
  readonly acceptedWithUnknownCost: number;
  /** Null whenever any accepted outcome's cost is unknown (see the reason). */
  readonly costPerAcceptedOutcomeMicros: number | null;
  readonly costPerAcceptedUnknownReason: string | null;
  readonly reviewEffortKnownSeconds: number;
  readonly reviewEffortUnknown: number;
  readonly reworkKnownTotal: number;
  readonly reworkUnknown: number;
}
export interface HostedAllocationReport {
  readonly month: string;
  /** Cost classes are reported separately and never summed together. */
  readonly byCostClass: Readonly<Record<HostedCostClass, {
    readonly allocations: readonly HostedAllocationPosition[];
    readonly committedMicros: number;
    readonly unreconciledMicros: number;
    readonly providerFinalMicros: number;
    /** Extrapolates recorded costs only, not caps/commitments or unrecorded
     * provider usage. Absent until a server-derived census is supplied. */
    readonly forecast?: HostedUsageForecast & {
      readonly scope: 'recorded-allocation-costs';
      readonly evidenceRef: string;
    };
  }>>;
  readonly outcomes: readonly HostedOutcomeCostSummary[];
}

export interface HostedAllocationReportInput {
  readonly organization: HostedAllocationOrganization;
  readonly month: string;
  readonly forecast?: { readonly asOfMs: number; readonly source: HostedUsageSourceCensus };
}

export interface HostedAllocationAccountingRow {
  readonly reservationId: string;
  readonly allocationId: string;
  /** Organization, department and project IDs for filtering; this row's cost is counted once. */
  readonly allocationPath: readonly string[];
  readonly costClass: HostedCostClass;
  readonly revision: number;
  readonly observedAtMs: number;
  readonly costSource: HostedHoldCostSource;
  readonly maximumCostMicros: number;
  readonly observedCostMicros: KnownOrUnknown<number>;
  readonly providerFinalCostMicros: KnownOrUnknown<number>;
  readonly committedMicros: number;
  readonly unreconciledMicros: number;
  readonly outcomeIds: readonly string[];
}
export interface HostedAllocationAccountingExport {
  readonly organization: HostedAllocationOrganization;
  readonly month: string;
  readonly currency: 'USD';
  readonly rows: readonly HostedAllocationAccountingRow[];
  readonly byCostClass: Readonly<Record<HostedCostClass, {
    readonly reservations: number;
    readonly pendingProviderFinal: number;
    readonly committedMicros: number;
    readonly unreconciledMicros: number;
    readonly providerFinalMicros: number;
  }>>;
  /** Latest recorded measurements retain their evidence class and explicit unknown reasons. */
  readonly outcomes: readonly HostedOutcomeRecord[];
  readonly gaps: readonly {
    readonly kind: 'provider-final-pending' | 'unattributed-reservation' | 'shared-outcome-reservation'
      | 'unknown-result' | 'unknown-result-cost' | 'unknown-review-effort' | 'unknown-rework';
    readonly ref: string;
    readonly reason: string;
  }[];
}

type Row = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const LEVEL_RANK: Readonly<Record<HostedAllocationLevel, number>> = { organization: 0, department: 1, project: 2 };
const SOURCES: readonly HostedHoldCostSource[] = ['unpriced', 'estimate', 'provider-reported', 'provider-billed'];
const STATES: readonly HostedOutcomeResultState[] = ['accepted', 'rejected', 'rework-requested', 'unknown'];
const EVIDENCE: readonly HostedOutcomeEvidenceClass[] = ['internal-simulation', 'synthetic', 'customer'];
const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length >= 1 && v.length <= max;
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function counter(v: unknown): number {
  const n = Number(v);
  if (!safe(n)) throw new Error('invalid hosted allocation counter');
  return n;
}
function add(a: number, b: number): number {
  const n = a + b;
  if (!Number.isSafeInteger(n)) throw new Error('hosted allocation total overflow');
  return n;
}
function only(input: object, keys: readonly string[], what: string): void {
  if (!input || typeof input !== 'object' || Object.keys(input).some(k => !keys.includes(k))) throw new Error(`invalid ${what}`);
}
function organization(o: HostedAllocationOrganization): HostedAllocationOrganization {
  only(o, ['controlWorkspaceId', 'organizationId'], 'hosted allocation organization');
  if (!isId(o.controlWorkspaceId) || !isId(o.organizationId)) throw new Error('invalid hosted allocation organization');
  return Object.freeze({ controlWorkspaceId: o.controlWorkspaceId, organizationId: o.organizationId });
}
function knownOrUnknown(v: KnownOrUnknown<number> | undefined, field: string): KnownOrUnknown<number> {
  if (v && 'value' in v && !('unknownReason' in v) && safe(v.value)) return { value: v.value };
  if (v && 'unknownReason' in v && !('value' in v) && text(v.unknownReason, 512)) return { unknownReason: v.unknownReason };
  throw new Error(`invalid hosted outcome ${field}: a value or an explicit unknownReason is required`);
}
const valueOf = (v: KnownOrUnknown<number>) => ('value' in v ? v.value : null);
const reasonOf = (v: KnownOrUnknown<number>) => ('unknownReason' in v ? v.unknownReason : null);
const fromColumns = (value: unknown, reason: unknown): KnownOrUnknown<number> =>
  value === null || value === undefined ? { unknownReason: String(reason) } : { value: counter(value) };

function allocationRow(r: Row): HostedAllocation {
  return Object.freeze({ allocationId: r.allocation_id as string,
    parentAllocationId: (r.parent_allocation_id as string | null) ?? null, level: r.level as HostedAllocationLevel,
    costClass: r.cost_class as HostedCostClass, month: r.month as string, capMicros: counter(r.cap_micros),
    maxUnreconciledMicros: counter(r.max_unreconciled_micros), revision: counter(r.revision) });
}
function holdRow(r: Row): HostedAllocationHold {
  return Object.freeze({ reservationId: r.reservation_id as string, allocationId: r.allocation_id as string,
    costClass: r.cost_class as HostedCostClass, month: r.month as string,
    maximumCostMicros: counter(r.maximum_cost_micros), requestHash: r.request_hash as string,
    revision: counter(r.revision), costSource: r.cost_source as HostedHoldCostSource,
    costMicros: r.cost_micros === null ? null : counter(r.cost_micros), providerFinal: r.provider_final === true,
    observedAtMs: counter(r.observed_at_ms) });
}
function outcomeRow(r: Row): HostedOutcomeRecord {
  return Object.freeze({ outcomeId: r.outcome_id as string, revision: counter(r.revision),
    allocationId: r.allocation_id as string, workflowRef: r.workflow_ref as string,
    evidenceClass: r.evidence_class as HostedOutcomeEvidenceClass, resultState: r.result_state as HostedOutcomeResultState,
    resultUnknownReason: (r.result_unknown_reason as string | null) ?? null,
    reservationIds: Object.freeze([...((r.reservation_ids as string[] | null) ?? [])]),
    resultCostMicros: fromColumns(r.result_cost_micros, r.result_cost_unknown_reason),
    reviewEffortSeconds: fromColumns(r.review_effort_seconds, r.review_effort_unknown_reason),
    reworkCount: fromColumns(r.rework_count, r.rework_unknown_reason) });
}

/** A hold commits its maximum (or a larger observed overrun) until provider-final. */
const committedOf = (h: HostedAllocationHold) => h.providerFinal ? (h.costMicros ?? 0)
  : Math.max(h.maximumCostMicros, h.costMicros ?? 0);
const unreconciledOf = (h: HostedAllocationHold) => (h.providerFinal ? 0 : committedOf(h));

async function latestAllocation(sql: Sql, o: HostedAllocationOrganization, allocationId: string) {
  const [row] = await sql<Row[]>`SELECT * FROM papercusp_auth.hosted_budget_allocations
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND allocation_id = ${allocationId} ORDER BY revision DESC LIMIT 1`;
  return row ? allocationRow(row) : null;
}
async function tree(sql: Sql, o: HostedAllocationOrganization, month: string, costClass?: HostedCostClass) {
  const rows = await sql<Row[]>`SELECT DISTINCT ON (allocation_id) * FROM papercusp_auth.hosted_budget_allocations
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND month = ${month} ${costClass ? sql`AND cost_class = ${costClass}` : sql``}
    ORDER BY allocation_id, revision DESC`;
  return new Map(rows.map(r => [r.allocation_id as string, allocationRow(r)]));
}
async function holds(sql: Sql, o: HostedAllocationOrganization, month: string, costClass?: HostedCostClass) {
  const rows = await sql<Row[]>`SELECT DISTINCT ON (reservation_id) * FROM papercusp_auth.hosted_budget_allocation_holds
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND month = ${month} ${costClass ? sql`AND cost_class = ${costClass}` : sql``}
    ORDER BY reservation_id, revision DESC`;
  return rows.map(holdRow);
}
async function latestHolds(sql: Sql, o: HostedAllocationOrganization, reservationIds: readonly string[]) {
  if (reservationIds.length === 0) return [];
  const rows = await sql<Row[]>`SELECT DISTINCT ON (reservation_id) * FROM papercusp_auth.hosted_budget_allocation_holds
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND reservation_id = ANY(${'{' + reservationIds.join(',') + '}'}::text[])
    ORDER BY reservation_id, revision DESC`;
  return rows.map(holdRow);
}

/** Project -> ... -> organization. Null when the chain is broken or cyclic. */
function chain(nodes: ReadonlyMap<string, HostedAllocation>, allocationId: string): HostedAllocation[] | null {
  const out: HostedAllocation[] = [];
  let current = nodes.get(allocationId);
  while (current) {
    if (out.length > 2 || out.some(n => n.allocationId === current!.allocationId)) return null;
    out.push(current);
    if (current.parentAllocationId === null) return current.level === 'organization' ? out : null;
    const parent = nodes.get(current.parentAllocationId);
    if (!parent || LEVEL_RANK[parent.level] + 1 !== LEVEL_RANK[current.level]) return null;
    current = parent;
  }
  return null;
}
interface Tally { committed: number; unreconciled: number; providerFinal: number; open: number }
function tallies(nodes: ReadonlyMap<string, HostedAllocation>, population: readonly HostedAllocationHold[]) {
  const out = new Map<string, Tally>();
  for (const h of population) {
    for (const n of chain(nodes, h.allocationId) ?? []) {
      const t = out.get(n.allocationId) ?? { committed: 0, unreconciled: 0, providerFinal: 0, open: 0 };
      t.committed = add(t.committed, committedOf(h));
      t.unreconciled = add(t.unreconciled, unreconciledOf(h));
      if (h.providerFinal) t.providerFinal = add(t.providerFinal, h.costMicros ?? 0); else t.open += 1;
      out.set(n.allocationId, t);
    }
  }
  return out;
}
const childCaps = (nodes: ReadonlyMap<string, HostedAllocation>, parentId: string, except?: string) =>
  [...nodes.values()].filter(n => n.parentAllocationId === parentId && n.allocationId !== except)
    .reduce((total, n) => add(total, n.capMicros), 0);

function allocationRequest(r: HostedAllocationRequest): HostedAllocationRequest {
  only(r, ['organization', 'allocationId', 'parentAllocationId', 'level', 'costClass', 'month', 'capMicros',
    'maxUnreconciledMicros', 'evidenceRef', 'recordedBy'], 'hosted allocation request');
  if (!isId(r.allocationId) || !(r.parentAllocationId === null || isId(r.parentAllocationId))
      || !(r.level in LEVEL_RANK) || !HOSTED_COST_CLASSES.includes(r.costClass) || !MONTH.test(r.month)
      || !safe(r.capMicros) || !safe(r.maxUnreconciledMicros) || r.maxUnreconciledMicros > r.capMicros
      || (r.level === 'organization') !== (r.parentAllocationId === null)
      || r.parentAllocationId === r.allocationId || !text(r.evidenceRef, 512) || !text(r.recordedBy, 256)) {
    throw new Error('invalid hosted allocation request');
  }
  return Object.freeze({ ...r, organization: organization(r.organization) });
}

/** Create or revise one allocation under the organization fence. Never moves money. */
export async function defineHostedAllocation(sql: Sql, input: HostedAllocationRequest): Promise<HostedAllocationOutcome> {
  const r = allocationRequest(input);
  const o = r.organization;
  await lockHostedBudgetOrganization(sql, o);
  const prior = await latestAllocation(sql, o, r.allocationId);
  const refused = (reason: string): HostedAllocationOutcome => ({ outcome: 'refused', reason, allocation: prior });
  if (prior) {
    if (prior.parentAllocationId !== r.parentAllocationId || prior.level !== r.level
        || prior.costClass !== r.costClass || prior.month !== r.month) {
      return { outcome: 'conflict', reason: 'immutable-allocation-fields', allocation: prior };
    }
    if (prior.capMicros === r.capMicros && prior.maxUnreconciledMicros === r.maxUnreconciledMicros) {
      return { outcome: 'duplicate', allocation: prior };
    }
  }
  const nodes = await tree(sql, o, r.month, r.costClass);
  if (r.parentAllocationId === null) {
    if ([...nodes.values()].some(n => n.parentAllocationId === null && n.allocationId !== r.allocationId)) {
      return refused('organization-root-exists');
    }
  } else {
    const parent = nodes.get(r.parentAllocationId);
    if (!parent) return refused('parent-missing');
    if (LEVEL_RANK[parent.level] + 1 !== LEVEL_RANK[r.level]) return refused('level-order');
    if (add(childCaps(nodes, parent.allocationId, r.allocationId), r.capMicros) > parent.capMicros) {
      return refused('children-exceed-parent');
    }
  }
  if (prior) {
    if (r.capMicros < childCaps(nodes, r.allocationId)) return refused('cap-below-children');
    const t = tallies(nodes, await holds(sql, o, r.month, r.costClass)).get(r.allocationId);
    if (t && r.capMicros < t.committed) return refused('cap-below-committed');
  }
  const revision = (prior?.revision ?? 0) + 1;
  const requestHash = digest([o.controlWorkspaceId, o.organizationId, r.allocationId, revision, r.parentAllocationId,
    r.level, r.costClass, r.month, r.capMicros, r.maxUnreconciledMicros]);
  const [row] = await sql<Row[]>`INSERT INTO papercusp_auth.hosted_budget_allocations
    (control_workspace_id, organization_id, allocation_id, revision, parent_allocation_id, level, cost_class, month,
     cap_micros, max_unreconciled_micros, request_hash, evidence_ref, recorded_by)
    VALUES (${o.controlWorkspaceId}, ${o.organizationId}, ${r.allocationId}, ${revision}, ${r.parentAllocationId},
      ${r.level}, ${r.costClass}, ${r.month}, ${r.capMicros}, ${r.maxUnreconciledMicros}, ${requestHash},
      ${r.evidenceRef}, ${r.recordedBy}) RETURNING *`;
  return { outcome: prior ? 'revised' : 'created', allocation: allocationRow(row!) };
}

/** Admit one hold against a project allocation, or refuse with no write. */
export async function reserveHostedAllocation(sql: Sql, input: HostedAllocationHoldRequest): Promise<HostedAllocationHoldOutcome> {
  only(input, ['organization', 'reservationId', 'allocationId', 'costClass', 'month', 'maximumCostMicros',
    'observedAtMs', 'evidenceRef'], 'hosted allocation hold');
  const o = organization(input.organization);
  if (!isId(input.reservationId) || !isId(input.allocationId) || !HOSTED_COST_CLASSES.includes(input.costClass)
      || !MONTH.test(input.month) || !safe(input.maximumCostMicros) || !safe(input.observedAtMs)
      || !text(input.evidenceRef, 512)) throw new Error('invalid hosted allocation hold');
  await lockHostedBudgetOrganization(sql, o);
  const requestHash = digest([o.controlWorkspaceId, o.organizationId, input.reservationId, input.allocationId,
    input.costClass, input.month, input.maximumCostMicros]);
  const [prior] = await latestHolds(sql, o, [input.reservationId]);
  if (prior) {
    return prior.requestHash === requestHash ? { outcome: 'duplicate', hold: prior }
      : { outcome: 'conflict', reason: 'reservation-binding-changed', allocationId: prior.allocationId, hold: prior };
  }
  const refused = (reason: string, allocationId: string | null = input.allocationId): HostedAllocationHoldOutcome =>
    ({ outcome: 'refused', reason, allocationId, hold: null });
  const nodes = await tree(sql, o, input.month, input.costClass);
  const node = nodes.get(input.allocationId);
  if (!node) return refused((await latestAllocation(sql, o, input.allocationId)) ? 'cost-class-or-month-mismatch' : 'unknown-allocation');
  if (node.level !== 'project') return refused('not-a-project-allocation');
  const path = chain(nodes, input.allocationId);
  if (!path) return refused('broken-allocation-chain');
  const t = tallies(nodes, await holds(sql, o, input.month, input.costClass));
  for (const n of path) {
    const current = t.get(n.allocationId) ?? { committed: 0, unreconciled: 0, providerFinal: 0, open: 0 };
    if (add(current.committed, input.maximumCostMicros) > n.capMicros) return refused('allocation-exhausted', n.allocationId);
    if (add(current.unreconciled, input.maximumCostMicros) > n.maxUnreconciledMicros) {
      return refused('unreconciled-bound', n.allocationId);
    }
  }
  const [row] = await sql<Row[]>`INSERT INTO papercusp_auth.hosted_budget_allocation_holds
    (control_workspace_id, organization_id, reservation_id, revision, allocation_id, cost_class, month,
     maximum_cost_micros, request_hash, cost_source, cost_micros, provider_final, observed_at_ms, evidence_ref)
    VALUES (${o.controlWorkspaceId}, ${o.organizationId}, ${input.reservationId}, 1, ${input.allocationId},
      ${input.costClass}, ${input.month}, ${input.maximumCostMicros}, ${requestHash}, 'unpriced', NULL, false,
      ${input.observedAtMs}, ${input.evidenceRef}) RETURNING *`;
  return { outcome: 'admitted', hold: holdRow(row!) };
}

/** Append one cost observation. Only provider-billed final amounts reconcile. */
export async function settleHostedAllocation(sql: Sql, input: HostedAllocationSettlement): Promise<HostedAllocationHoldOutcome> {
  only(input, ['organization', 'reservationId', 'costSource', 'costMicros', 'providerFinal', 'observedAtMs',
    'evidenceRef'], 'hosted allocation settlement');
  const o = organization(input.organization);
  if (!isId(input.reservationId) || !SOURCES.includes(input.costSource) || typeof input.providerFinal !== 'boolean'
      || (input.costSource === 'unpriced') !== (input.costMicros === null)
      || (input.costMicros !== null && !safe(input.costMicros))
      || (input.providerFinal && input.costSource !== 'provider-billed')
      || !safe(input.observedAtMs) || !text(input.evidenceRef, 512)) throw new Error('invalid hosted allocation settlement');
  await lockHostedBudgetOrganization(sql, o);
  const [prior] = await latestHolds(sql, o, [input.reservationId]);
  const refused = (reason: string): HostedAllocationHoldOutcome =>
    ({ outcome: 'refused', reason, allocationId: prior?.allocationId ?? null, hold: prior ?? null });
  if (!prior) return refused('unknown-reservation');
  if (prior.providerFinal && !input.providerFinal) return refused('provider-final-is-terminal');
  if (input.observedAtMs < prior.observedAtMs) return refused('stale-observation');
  const [row] = await sql<Row[]>`INSERT INTO papercusp_auth.hosted_budget_allocation_holds
    (control_workspace_id, organization_id, reservation_id, revision, allocation_id, cost_class, month,
     maximum_cost_micros, request_hash, cost_source, cost_micros, provider_final, observed_at_ms, evidence_ref)
    VALUES (${o.controlWorkspaceId}, ${o.organizationId}, ${prior.reservationId}, ${prior.revision + 1},
      ${prior.allocationId}, ${prior.costClass}, ${prior.month}, ${prior.maximumCostMicros}, ${prior.requestHash},
      ${input.costSource}, ${input.costMicros}, ${input.providerFinal}, ${input.observedAtMs}, ${input.evidenceRef})
    RETURNING *`;
  return { outcome: 'settled', hold: holdRow(row!) };
}

/** Append one outcome revision: result, review effort and rework, each known or explicitly unknown. */
export async function recordHostedOutcome(sql: Sql, input: HostedOutcomeRecordRequest): Promise<HostedOutcomeRecordOutcome> {
  only(input, ['organization', 'outcomeId', 'allocationId', 'workflowRef', 'evidenceClass', 'result', 'reservationIds',
    'resultCostMicros', 'reviewEffortSeconds', 'reworkCount', 'observedAtMs', 'evidenceRef', 'recordedBy'], 'hosted outcome record');
  const o = organization(input.organization);
  const result = input.result;
  if (!isId(input.outcomeId) || !isId(input.allocationId) || !text(input.workflowRef, 256)
      || !EVIDENCE.includes(input.evidenceClass) || !result || !STATES.includes(result.state)
      || (result.state === 'unknown') !== ('unknownReason' in result)
      || ('unknownReason' in result && !text(result.unknownReason, 512))
      || !Array.isArray(input.reservationIds) || !input.reservationIds.every(isId)
      || new Set(input.reservationIds).size !== input.reservationIds.length
      || !safe(input.observedAtMs) || !text(input.evidenceRef, 512) || !text(input.recordedBy, 256)) {
    throw new Error('invalid hosted outcome record');
  }
  const review = knownOrUnknown(input.reviewEffortSeconds, 'reviewEffortSeconds');
  const rework = knownOrUnknown(input.reworkCount, 'reworkCount');
  if ('value' in rework && rework.value > 2_147_483_647) throw new Error('invalid hosted outcome reworkCount');
  await lockHostedBudgetOrganization(sql, o);
  const refused = (reason: string): HostedOutcomeRecordOutcome => ({ outcome: 'refused', reason, record: null });
  if (!(await latestAllocation(sql, o, input.allocationId))) return refused('unknown-allocation');
  const ids = [...input.reservationIds].sort();
  const linked = await latestHolds(sql, o, ids);
  if (linked.length !== ids.length) return refused('unknown-reservation');
  if (linked.some(h => h.allocationId !== input.allocationId)) return refused('reservation-allocation-mismatch');
  let cost: KnownOrUnknown<number>;
  if (input.resultCostMicros !== undefined) cost = knownOrUnknown(input.resultCostMicros, 'resultCostMicros');
  else if (linked.length === 0) cost = { unknownReason: 'no-linked-reservations' };
  else {
    const pending = linked.filter(h => !h.providerFinal).map(h => h.reservationId);
    cost = pending.length > 0 ? { unknownReason: `provider-final-pending:${pending.join(',')}` }
      : { value: linked.reduce((total, h) => add(total, h.costMicros ?? 0), 0) };
  }
  const [prior] = await sql<Row[]>`SELECT revision FROM papercusp_auth.hosted_outcome_cost_records
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND outcome_id = ${input.outcomeId} ORDER BY revision DESC LIMIT 1`;
  const revision = prior ? counter(prior.revision) + 1 : 1;
  const [row] = await sql<Row[]>`INSERT INTO papercusp_auth.hosted_outcome_cost_records
    (control_workspace_id, organization_id, outcome_id, revision, allocation_id, workflow_ref, evidence_class,
     result_state, result_unknown_reason, reservation_ids, result_cost_micros, result_cost_unknown_reason,
     review_effort_seconds, review_effort_unknown_reason, rework_count, rework_unknown_reason,
     observed_at_ms, evidence_ref, recorded_by)
    VALUES (${o.controlWorkspaceId}, ${o.organizationId}, ${input.outcomeId}, ${revision}, ${input.allocationId},
      ${input.workflowRef}, ${input.evidenceClass}, ${result.state},
      ${'unknownReason' in result ? result.unknownReason : null}, ${'{' + ids.join(',') + '}'}::text[],
      ${valueOf(cost)}, ${reasonOf(cost)}, ${valueOf(review)}, ${reasonOf(review)}, ${valueOf(rework)},
      ${reasonOf(rework)}, ${input.observedAtMs}, ${input.evidenceRef}, ${input.recordedBy}) RETURNING *`;
  return { outcome: 'recorded', record: outcomeRow(row!) };
}

function summarize(allocationId: string, records: readonly HostedOutcomeRecord[]): HostedOutcomeCostSummary {
  const byState = { accepted: 0, rejected: 0, 'rework-requested': 0, unknown: 0 } as Record<HostedOutcomeResultState, number>;
  for (const r of records) byState[r.resultState] += 1;
  const accepted = records.filter(r => r.resultState === 'accepted');
  const acceptedUnknown = accepted.filter(r => !('value' in r.resultCostMicros)).length;
  const acceptedCost = accepted.reduce((total, r) => add(total, valueOf(r.resultCostMicros) ?? 0), 0);
  const per = accepted.length === 0 ? { v: null, why: 'no-accepted-outcomes' }
    : acceptedUnknown > 0 ? { v: null, why: `${acceptedUnknown} of ${accepted.length} accepted outcome(s) have an unknown result cost` }
    : { v: Math.floor(acceptedCost / accepted.length), why: null };
  return { allocationId, outcomes: records.length, byState,
    evidenceClasses: [...new Set(records.map(r => r.evidenceClass))].sort(),
    acceptedResultCostMicros: acceptedCost, acceptedWithUnknownCost: acceptedUnknown,
    costPerAcceptedOutcomeMicros: per.v, costPerAcceptedUnknownReason: per.why,
    reviewEffortKnownSeconds: records.reduce((t, r) => add(t, valueOf(r.reviewEffortSeconds) ?? 0), 0),
    reviewEffortUnknown: records.filter(r => !('value' in r.reviewEffortSeconds)).length,
    reworkKnownTotal: records.reduce((t, r) => add(t, valueOf(r.reworkCount) ?? 0), 0),
    reworkUnknown: records.filter(r => !('value' in r.reworkCount)).length };
}

async function readOutcomeRecords(sql: Sql, o: HostedAllocationOrganization, ids: readonly string[]): Promise<HostedOutcomeRecord[]> {
  if (ids.length === 0) return [];
  // The database append guard pins allocation_id across outcome revisions.
  const rows = await sql<Row[]>`SELECT DISTINCT ON (outcome_id) *
    FROM papercusp_auth.hosted_outcome_cost_records
    WHERE control_workspace_id = ${o.controlWorkspaceId} AND organization_id = ${o.organizationId}
      AND allocation_id = ANY(${'{' + ids.join(',') + '}'}::text[])
    ORDER BY outcome_id, revision DESC`;
  return rows.map(outcomeRow);
}

/** A consistent per-month position, read under the organization fence. */
export async function readHostedAllocationReport(sql: Sql, input: HostedAllocationReportInput):
    Promise<HostedAllocationReport> {
  const o = organization(input.organization);
  if (!MONTH.test(input.month)) throw new Error('invalid hosted allocation month');
  await lockHostedBudgetOrganization(sql, o);
  const all = await tree(sql, o, input.month);
  const population = await holds(sql, o, input.month);
  const byCostClass = {} as Record<HostedCostClass, HostedAllocationReport['byCostClass'][HostedCostClass]>;
  for (const costClass of HOSTED_COST_CLASSES) {
    const nodes = new Map([...all].filter(([, n]) => n.costClass === costClass));
    const classHolds = population.filter(h => h.costClass === costClass);
    const t = tallies(nodes, classHolds);
    const allocations = [...nodes.values()].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
      || a.allocationId.localeCompare(b.allocationId)).map(n => {
      const v = t.get(n.allocationId) ?? { committed: 0, unreconciled: 0, providerFinal: 0, open: 0 };
      return { allocationId: n.allocationId, parentAllocationId: n.parentAllocationId, level: n.level,
        capMicros: n.capMicros, maxUnreconciledMicros: n.maxUnreconciledMicros, committedMicros: v.committed,
        unreconciledMicros: v.unreconciled, providerFinalMicros: v.providerFinal,
        availableMicros: Math.max(0, n.capMicros - v.committed), openHolds: v.open };
    });
    let forecast: HostedAllocationReport['byCostClass'][HostedCostClass]['forecast'];
    if (input.forecast) {
      const { asOfMs, source } = input.forecast;
      const gaps = new Set<string>();
      for (const h of classHolds) {
        if (h.observedAtMs > source.observedAtMs || h.observedAtMs > asOfMs) gaps.add('receipt-newer-than-census');
        if (h.costMicros === null) gaps.add('unpriced-usage');
        if (!h.providerFinal) gaps.add('unreconciled-provider-cost');
      }
      forecast = { ...projectHostedMonthlyCost({ month: input.month, asOfMs, source, gaps,
        basisMicrosExact: addMicrosDecimals(...classHolds.map(h => String(h.costMicros ?? 0))) }),
        scope: 'recorded-allocation-costs', evidenceRef: source.evidenceRef };
    }
    byCostClass[costClass] = { allocations,
      committedMicros: classHolds.reduce((total, h) => add(total, committedOf(h)), 0),
      unreconciledMicros: classHolds.reduce((total, h) => add(total, unreconciledOf(h)), 0),
      providerFinalMicros: classHolds.reduce((total, h) => add(total, h.providerFinal ? h.costMicros ?? 0 : 0), 0),
      ...(forecast ? { forecast } : {}) };
  }
  const ids = [...all.keys()];
  const records = await readOutcomeRecords(sql, o, ids);
  const outcomes = [...new Set(records.map(r => r.allocationId))].sort()
    .map(id => summarize(id, records.filter(r => r.allocationId === id)));
  return { month: input.month, byCostClass, outcomes };
}

/** Reservation-level accounting projection of the existing ledger. Ancestor
 * rollups and shared outcome links never multiply money. Non-final bills,
 * unassigned costs and missing human measurements remain explicit gaps. */
export async function readHostedAllocationAccountingExport(sql: Sql, input: {
  organization: HostedAllocationOrganization; month: string;
}): Promise<HostedAllocationAccountingExport> {
  const o = organization(input.organization);
  const report = await readHostedAllocationReport(sql, input);
  // report holds the same transaction-scoped organization fence as every writer.
  const population = await holds(sql, o, input.month);
  const nodes = new Map(HOSTED_COST_CLASSES.flatMap(c => report.byCostClass[c].allocations.map(a => [a.allocationId, a] as const)));
  const outcomes = await readOutcomeRecords(sql, o, [...nodes.keys()]);
  const gaps: HostedAllocationAccountingExport['gaps'][number][] = [];
  const associations = new Map<string, string[]>();
  for (const outcome of outcomes) {
    for (const reservationId of outcome.reservationIds) {
      const ids = associations.get(reservationId) ?? [];
      ids.push(outcome.outcomeId); associations.set(reservationId, ids);
    }
    if (outcome.resultState === 'unknown') gaps.push({ kind: 'unknown-result', ref: outcome.outcomeId,
      reason: outcome.resultUnknownReason ?? 'result-not-measured' });
    for (const [field, kind] of [['resultCostMicros', 'unknown-result-cost'],
      ['reviewEffortSeconds', 'unknown-review-effort'], ['reworkCount', 'unknown-rework']] as const) {
      const measurement = outcome[field];
      if ('unknownReason' in measurement) gaps.push({ kind, ref: outcome.outcomeId, reason: measurement.unknownReason });
    }
  }
  const byCostClass = {} as Record<HostedCostClass, HostedAllocationAccountingExport['byCostClass'][HostedCostClass]>;
  for (const c of HOSTED_COST_CLASSES) {
    const positions = report.byCostClass[c];
    const classHolds = population.filter(h => h.costClass === c);
    byCostClass[c] = { reservations: classHolds.length, pendingProviderFinal: classHolds.filter(h => !h.providerFinal).length,
      committedMicros: positions.committedMicros, unreconciledMicros: positions.unreconciledMicros,
      providerFinalMicros: positions.providerFinalMicros };
  }
  const rows = [...population].sort((a, b) => a.reservationId.localeCompare(b.reservationId)).map(h => {
    const allocationPath: string[] = [];
    let id: string | null = h.allocationId;
    while (id !== null) {
      const node = nodes.get(id);
      if (!node || allocationPath.includes(id)) throw new Error('broken hosted allocation accounting path');
      allocationPath.unshift(id); id = node.parentAllocationId;
    }
    const outcomeIds = [...(associations.get(h.reservationId) ?? [])].sort();
    if (!h.providerFinal) gaps.push({ kind: 'provider-final-pending', ref: h.reservationId,
      reason: 'provider-final-bill-not-recorded' });
    if (outcomeIds.length === 0) gaps.push({ kind: 'unattributed-reservation', ref: h.reservationId,
      reason: 'no-recorded-workflow-outcome' });
    if (outcomeIds.length > 1) gaps.push({ kind: 'shared-outcome-reservation', ref: h.reservationId,
      reason: 'cost-counted-once;per-outcome-allocation-weights-not-recorded' });
    return { reservationId: h.reservationId, allocationId: h.allocationId, allocationPath, costClass: h.costClass,
      revision: h.revision, observedAtMs: h.observedAtMs, costSource: h.costSource,
      maximumCostMicros: h.maximumCostMicros,
      observedCostMicros: h.costMicros === null ? { unknownReason: 'usage-cost-not-recorded' } : { value: h.costMicros },
      providerFinalCostMicros: h.providerFinal ? { value: h.costMicros! } : { unknownReason: 'provider-final-bill-not-recorded' },
      committedMicros: committedOf(h), unreconciledMicros: unreconciledOf(h), outcomeIds };
  });
  return { organization: o, month: report.month, currency: 'USD', rows, byCostClass, outcomes, gaps };
}

/** Standalone transaction wrapper; the functions above also compose inside a
 * PostgresHostedBudgetStore transaction because they share its fence. */
export class PostgresHostedAllocationStore {
  private readonly run: HostedServiceContextRunner;
  constructor(options: { run?: HostedServiceContextRunner } = {}) {
    this.run = options.run ?? withHostedServiceContext;
  }
  define(input: HostedAllocationRequest) { return this.run(sql => defineHostedAllocation(sql, input)); }
  reserve(input: HostedAllocationHoldRequest) { return this.run(sql => reserveHostedAllocation(sql, input)); }
  settle(input: HostedAllocationSettlement) { return this.run(sql => settleHostedAllocation(sql, input)); }
  recordOutcome(input: HostedOutcomeRecordRequest) { return this.run(sql => recordHostedOutcome(sql, input)); }
  report(input: HostedAllocationReportInput) {
    return this.run(sql => readHostedAllocationReport(sql, input));
  }
  accountingExport(input: { organization: HostedAllocationOrganization; month: string }) {
    return this.run(sql => readHostedAllocationAccountingExport(sql, input));
  }
}
