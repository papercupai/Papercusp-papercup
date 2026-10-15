/**
 * Read-only workspace portfolio audit for nonterminal plans.
 *
 * The audit is deliberately split into three layers:
 *   1. canonical readers (plans, work items, blockers, rubrics, audits, presence),
 *   2. a pure classifier (classifier revision 3), and
 *   3. PG-canonical text-artifact publication.
 *
 * Nothing in this module imports a lifecycle writer. The only writes are the JSON
 * and HTML evidence artifacts under `.papercusp/reports/`, mirrored from the
 * existing harness_text_artifacts store. In particular, the audit never changes a
 * plan status, plan-item status, blocker, claim, assignment, or ownership row.
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveEffectiveStatusForItems, type PlanItem } from '@papercusp/plan-parser';
import { listPlanIndexRowsForWorkspace, type PlanIndexRow } from './agent-tools/plans/source';
import { applyPlanItemBlocks, getAllBlockedPlanItems, planItemRef } from './issue-blocks-merge';
import { evaluatePlanAcceptanceGate } from './plan-acceptance-gate';
import { listRubrics, type Rubric } from './rubrics';
import { saveTextArtifact } from './text-artifacts';
import { renderPlanAuditReport } from './plan-audit-report';
import { SETTLED_WORK_ITEM_STATES } from './work-items';
import { activeWorkspaceId } from './workspace-registry';
import {
  planProvenanceFromBlenderFlag,
  type PlanProvenance,
} from './agent-tools/plans/plan-provenance';

export const UNSHIPPED_PLANS_AUDIT_CLASSIFIER_REVISION = 3;
export const UNSHIPPED_PLANS_AUDIT_JSON_ARTIFACT = 'reports/unshipped-plans-audit/latest.json';
export const UNSHIPPED_PLANS_AUDIT_HTML_ARTIFACT = 'reports/unshipped-plans-audit/latest.html';

export const AUDIT_CATEGORIES = [
  'closeout-evidence-missing',
  'supersede-or-rescope-empty',
  'typed-blocker',
  'unblocked-partial-no-owner',
  'supersede-or-archive-fixture',
  'text-only-human-blocker',
  'typed-human-blocker',
  'catalog-residue',
  'plan-item-reconcile',
  'acceptance-residue',
  'unstarted-no-blocker',
  'closeout-status-residue',
  'ongoing-protected',
  'text-only-external-blocker',
  'supersede-or-review-deferred',
  'typed-blocker-stale-hint',
  'closeout-stale-audit',
  'ledger-contradiction',
  'supersede-documented',
] as const;

export type UnshippedPlanAuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type UnshippedPlanAuditBand =
  | 'protected'
  | 'closeoutOrReconcile'
  | 'supersedeOrRetire'
  | 'blockerClaims'
  | 'unblockedPartial'
  | 'catalogResidue';

const CATEGORY_BAND: Record<UnshippedPlanAuditCategory, UnshippedPlanAuditBand> = {
  'ongoing-protected': 'protected',
  'closeout-evidence-missing': 'closeoutOrReconcile',
  'closeout-stale-audit': 'closeoutOrReconcile',
  'closeout-status-residue': 'closeoutOrReconcile',
  'ledger-contradiction': 'closeoutOrReconcile',
  'plan-item-reconcile': 'closeoutOrReconcile',
  'acceptance-residue': 'closeoutOrReconcile',
  'supersede-documented': 'supersedeOrRetire',
  'supersede-or-archive-fixture': 'supersedeOrRetire',
  'supersede-or-rescope-empty': 'supersedeOrRetire',
  'supersede-or-review-deferred': 'supersedeOrRetire',
  'unstarted-no-blocker': 'supersedeOrRetire',
  'typed-blocker': 'blockerClaims',
  'typed-blocker-stale-hint': 'blockerClaims',
  'typed-human-blocker': 'blockerClaims',
  'text-only-human-blocker': 'blockerClaims',
  'text-only-external-blocker': 'blockerClaims',
  'unblocked-partial-no-owner': 'unblockedPartial',
  'catalog-residue': 'catalogResidue',
};

const CATEGORY_COPY: Record<UnshippedPlanAuditCategory, { reason: string; recommendation: string }> = {
  'closeout-evidence-missing': {
    reason: 'All tracked work is terminal, but current code-truth audit and acceptance evidence are incomplete.',
    recommendation: 'Run code-truth and acceptance closeout; ship only if the current gate passes, otherwise supersede with rationale.',
  },
  'supersede-or-rescope-empty': {
    reason: 'The plan has no executable plan items or linked work.',
    recommendation: 'Supersede unless a current owner writes executable items and explicitly re-approves the scope.',
  },
  'typed-blocker': {
    reason: 'At least one unfinished item has a structured dependency or open issue blocker.',
    recommendation: 'Retain only while the blocker still exists and has a concrete owner, next action, and recheck condition.',
  },
  'unblocked-partial-no-owner': {
    reason: 'Work remains, but no current owner or legitimate blocker is recorded.',
    recommendation: 'Finish the surviving work or supersede the plan; do not leave it indefinitely nonterminal.',
  },
  'supersede-or-archive-fixture': {
    reason: 'The plan is a fixture, smoke, drill, demo, canary, or other retained test artifact.',
    recommendation: 'Terminalize it as superseded/retained-fixture so it no longer reads as product backlog.',
  },
  'text-only-human-blocker': {
    reason: 'Plan prose claims an owner decision/approval/credential blocker, but no structured needs-human state records it.',
    recommendation: 'Revalidate the human action and encode it structurally if real; otherwise finish or supersede.',
  },
  'typed-human-blocker': {
    reason: 'At least one unfinished item is structurally marked needs-human.',
    recommendation: 'Retain only with the exact decision/action, accountable owner, and a recheck condition.',
  },
  'catalog-residue': {
    reason: 'The plan row points at a harness that is not present in the current registry.',
    recommendation: 'Repair or retire the catalog reference; this is metadata debt, not implementation work.',
  },
  'plan-item-reconcile': {
    reason: 'Linked work is terminal while one or more plan-item statuses remain open.',
    recommendation: 'Reconcile the plan-item ledger against the completed work; do not reimplement it.',
  },
  'acceptance-residue': {
    reason: 'Implementation appears substantially complete, but acceptance/closeout work remains.',
    recommendation: 'Finish the current audit/rubric/verdict evidence, then close or supersede.',
  },
  'unstarted-no-blocker': {
    reason: 'No progress and no legitimate blocker are recorded.',
    recommendation: 'Supersede by default unless the work is explicitly re-approved now.',
  },
  'closeout-status-residue': {
    reason: 'The plan says it is complete/shipped while its lifecycle or item ledger remains nonterminal.',
    recommendation: 'Reconcile the residual status labels against current evidence, then close.',
  },
  'ongoing-protected': {
    reason: 'A live agent currently declares, claims, or holds nonterminal work linked to this plan.',
    recommendation: 'No cleanup action: preserve the lane and re-audit after its live owner finishes.',
  },
  'text-only-external-blocker': {
    reason: 'Plan prose claims an external/gate/time/provider blocker, but no structured blocker records it.',
    recommendation: 'Revalidate the external condition and encode it structurally if real; otherwise finish or supersede.',
  },
  'supersede-or-review-deferred': {
    reason: 'The plan describes itself as deferred, paused, awaiting review, or designed but not approved/built.',
    recommendation: 'Supersede unless the proposal is explicitly re-approved and re-owned now.',
  },
  'typed-blocker-stale-hint': {
    reason: 'The resolver reports a sticky blocked status whose declared dependencies have already resolved.',
    recommendation: 'Re-baseline immediately; clear the stale status when no external blocker survives, then finish or supersede.',
  },
  'closeout-stale-audit': {
    reason: 'The plan has audit and acceptance artifacts, but the current ship gate says the evidence is stale.',
    recommendation: 'Re-audit only the stale items/citations, re-grade current acceptance, then ship.',
  },
  'ledger-contradiction': {
    reason: 'Plan items are terminal but linked work remains nonterminal.',
    recommendation: 'Resolve the linked-work contradiction before closing the plan.',
  },
  'supersede-documented': {
    reason: 'The plan-level Now state explicitly says the plan is superseded.',
    recommendation: 'Verify the named replacement/obsolete premise, then set the plan lifecycle to superseded.',
  },
};

export interface AuditOwnerEvidence {
  ownerId: string;
  ownerLabel?: string | null;
  fleet?: string | null;
  intent?: string | null;
  source: 'declared-plan' | 'plan-item-claim' | 'work-item-hold';
}

export interface AuditBlockerEvidence {
  typedBlocked: boolean;
  typedHuman: boolean;
  refs: string[];
  staleHints: string[];
}

export interface AuditSummaryEvidence {
  auditSeq: number;
  createdAt: string;
  auditedSha: string | null;
  auditedItems: number;
}

export interface AcceptanceRubricEvidence {
  rubricId: string;
  status: string;
}

export interface AcceptanceGateEvidence {
  satisfied: boolean;
  code?: string;
  message?: string;
  skipped?: string;
}

export interface AuditWorkItemRow {
  sourcePlanSlug: string;
  status: string;
  holder: string | null;
}

export interface UnshippedPlanAuditRow {
  slug: string;
  title: string | null;
  harness: string;
  status: string;
  archived: boolean;
  template: string | null;
  templateSlug: string | null;
  provenance: PlanProvenance;
  category: UnshippedPlanAuditCategory;
  reason: string;
  recommendation: string;
  created: string | null;
  updated: string | null;
  itemTotal: number;
  terminalPlanItems: number;
  openPlanItems: number;
  workItemTotal: number;
  openWorkItems: number;
  itemCounts: Record<string, number>;
  workItemStates: Record<string, number>;
  audit: AuditSummaryEvidence | null;
  acceptanceRubric: AcceptanceRubricEvidence | null;
  gateVerdict: AcceptanceGateEvidence | null;
  owners: AuditOwnerEvidence[];
  blocker: AuditBlockerEvidence;
  nowState: string;
  nowNext: string;
}

export interface UnshippedPlansAuditManifest {
  schemaVersion: 'unshipped-plans-audit-manifest-v2';
  generatedAt: string;
  workspace: string;
  scope: {
    snapshotStartedAt: string;
    snapshotFinishedAt: string;
    liveOwnershipMeasuredAt: string;
    nonterminalListedAtSnapshot: number;
    listedAtSnapshot: number;
    census: Record<'archived' | 'superseded' | 'rubricTemplate' | 'scheduledInstance', { listed: number; included: number; excluded: number; exclusionReason: string | null }>;
    materialized: number;
    catalogFailures: number;
    classifiedRows: number;
    rule: string;
    classifierRevision: number;
    classifierCorrection: string;
  };
  summaryByCategory: Record<string, { count: number; byStatus: Record<string, number> }>;
  bands: Record<UnshippedPlanAuditBand, number>;
  closeoutEvidence: { staleAuditAndRubric: number; missingAuditOrAcceptance: number };
  blockerEvidence: { typedCurrent: number; typedWithStaleHint: number; textOnly: number };
  currentRegistryAtPublish: Record<string, number> & { total: number };
  provenance: { blender: number; outsideBlender: number };
  rows: UnshippedPlanAuditRow[];
}

export interface ClassifierInput {
  plan: PlanIndexRow;
  registeredHarness: boolean;
  owners: AuditOwnerEvidence[];
  workItems: AuditWorkItemRow[];
  blocker: AuditBlockerEvidence;
  itemCounts: Record<string, number>;
  audit: AuditSummaryEvidence | null;
  acceptanceRubric: AcceptanceRubricEvidence | null;
  gateVerdict: AcceptanceGateEvidence | null;
}

const PLAN_TERMINAL_STATUSES = new Set(['shipped', 'superseded']);
const ITEM_TERMINAL_STATUSES = new Set(['done', 'dropped']);
const WORK_ITEM_TERMINAL_STATUSES = new Set<string>(SETTLED_WORK_ITEM_STATES);

/**
 * Revision 2's load-bearing correction: inspect only the plan-level Now state and
 * require a plan-subject assertion. A sentence such as "D-004 superseded the old
 * approach" or "the superseded decision" must never retire the whole plan.
 */
export function hasExplicitPlanLevelSupersession(nowState: string | null | undefined): boolean {
  const state = (nowState ?? '').trim();
  if (!state) return false;
  return (
    /^(?:this\s+)?plan\s+(?:is\s+|was\s+|has\s+been\s+)?superseded\b/i.test(state) ||
    /^superseded\b(?:\s+in\s+its\b|\s+by\b|\s*[:—-])/i.test(state)
  );
}

function textSignals(input: ClassifierInput) {
  const text = [input.plan.planSlug, input.plan.title, input.plan.nowState, input.plan.nowNext]
    .filter(Boolean)
    .join(' ');
  // Revision 3: blocker classification is about the plan's CURRENT state, not
  // vocabulary anywhere in its identity/history. Scanning slug/title made
  // `abolish-human-review-*` a human blocker; matching bare `credential` made
  // "run credential/provider probes" a human blocker even when the same Next
  // sentence said "now unblocked". Require blocker-shaped syntax in ## Now.
  const nowText = [input.plan.nowState, input.plan.nowNext].filter(Boolean).join(' ');
  // A prose-only blocker is plan-level triage, so an explicitly executable
  // current lane must win over a different deferred/owner-gated sub-item.
  // Typed item evidence still takes priority later in classifyUnshippedPlan.
  const hasAgentExecutableNext =
    /\b(?:now unblocked|fully[- ]agent[- ]executable|agent[- ]executable)\b/i.test(input.plan.nowNext ?? '');
  const human =
    !hasAgentExecutableNext &&
    (/\b(?:owner[- ]gated|owner[- ]run|needs[- ]human|owner (?:action|decision|approval|review|ratification)|human (?:action|decision|approval)|purchase required)\b/i.test(nowText) ||
      /\b(?:blocked|waiting|awaiting|depends)\b.{0,80}\b(?:owner|human|approval|decision|review|ratification|credential|api key)\b/i.test(nowText) ||
      /\b(?:credential|api key)\b.{0,40}\b(?:required|needed|missing|unavailable)\b/i.test(nowText) ||
      /\b(?:provide|supply|needs?|requires?)\b.{0,40}\b(?:credential|api key)\b/i.test(nowText));
  const external =
    !hasAgentExecutableNext &&
    (/\b(?:blocked (?:on|by|until)|waiting (?:on|for)|time[- ]gated|deploy[- ]gated|release[- ]gated|external blocker|provider blocker|remote blocker)\b/i.test(nowText) ||
      /\b(?:release|deploy(?:ment)?) gate\b.{0,40}\b(?:red|blocked|pending|stalled|waiting)\b/i.test(nowText) ||
      /\b(?:quota|capacity)\b.{0,30}\b(?:exhausted|walled|blocked|unavailable)\b/i.test(nowText) ||
      /\b(?:cannot|hold|wait)\b.{0,80}\buntil\b.{0,40}\b(?:lands|ships|completes|recovers)\b/i.test(nowText) ||
      /\b(?:once|when)\b.{0,80}\b(?:reaches|lands|ships|completes|recovers)\b/i.test(nowText));
  return {
    fixture: /(?:^|[-\s])(fixture|smoke|drill|demo|canary|heartbeat|behaviou?r[-\s]grade[-\s]run)(?:[-\s]|$)/i.test(text),
    deferred: /\b(awaiting (?:owner|review|approval)|designed[,;:]? not built|not approved|deferred|paused indefinitely|draft[,;:]? awaiting)\b/i.test(text),
    human,
    external,
    completion: /^(?:plan\s+)?(?:complete|completed|done|shipped)\b|\b(?:plan complete|all (?:items|work).{0,30}(?:done|complete)|shipped and (?:live|deployed))\b/i.test(
      input.plan.nowState ?? '',
    ),
    acceptance: /\b(acceptance|closeout|code-truth audit|independent grad(?:e|ing))\b/i.test(text),
  };
}

function rowCounts(input: ClassifierInput) {
  const itemTotal = Object.values(input.itemCounts).reduce((n, value) => n + value, 0);
  const terminalPlanItems = [...ITEM_TERMINAL_STATUSES].reduce((n, status) => n + (input.itemCounts[status] ?? 0), 0);
  const openPlanItems = itemTotal - terminalPlanItems;
  const workItemStates: Record<string, number> = {};
  let openWorkItems = 0;
  for (const workItem of input.workItems) {
    workItemStates[workItem.status] = (workItemStates[workItem.status] ?? 0) + 1;
    if (!WORK_ITEM_TERMINAL_STATUSES.has(workItem.status)) openWorkItems += 1;
  }
  return {
    itemTotal,
    terminalPlanItems,
    openPlanItems,
    workItemTotal: input.workItems.length,
    openWorkItems,
    workItemStates,
  };
}

export function classifyUnshippedPlan(input: ClassifierInput): UnshippedPlanAuditRow {
  const counts = rowCounts(input);
  const signals = textSignals(input);
  const terminalRatio = counts.itemTotal > 0 ? counts.terminalPlanItems / counts.itemTotal : 0;
  let category: UnshippedPlanAuditCategory;

  if (input.owners.length > 0) category = 'ongoing-protected';
  else if (!input.registeredHarness) category = 'catalog-residue';
  else if (hasExplicitPlanLevelSupersession(input.plan.nowState)) category = 'supersede-documented';
  else if (signals.fixture) category = 'supersede-or-archive-fixture';
  else if (counts.itemTotal === 0 && counts.workItemTotal === 0) category = 'supersede-or-rescope-empty';
  else if (signals.deferred) category = 'supersede-or-review-deferred';
  else if (counts.openPlanItems === 0 && counts.openWorkItems > 0) category = 'ledger-contradiction';
  else if (counts.openPlanItems === 0 && counts.openWorkItems === 0) {
    if (!input.audit || !input.acceptanceRubric) category = 'closeout-evidence-missing';
    else if (input.gateVerdict?.code === 'audit_coverage_stale') category = 'closeout-stale-audit';
    else if (input.gateVerdict?.satisfied) category = 'closeout-status-residue';
    else category = 'acceptance-residue';
  } else if (counts.workItemTotal > 0 && counts.openWorkItems === 0) category = 'plan-item-reconcile';
  else if (signals.completion && !signals.human && !signals.external) category = 'closeout-status-residue';
  else if (signals.acceptance && terminalRatio >= 0.6) category = 'acceptance-residue';
  else if (input.blocker.staleHints.length > 0) category = 'typed-blocker-stale-hint';
  else if (input.blocker.typedHuman) category = 'typed-human-blocker';
  else if (input.blocker.typedBlocked) category = 'typed-blocker';
  else if (signals.human) category = 'text-only-human-blocker';
  else if (signals.external) category = 'text-only-external-blocker';
  else if (counts.terminalPlanItems === 0 && counts.workItemTotal === 0) category = 'unstarted-no-blocker';
  else if (terminalRatio >= 0.6 && signals.completion) category = 'acceptance-residue';
  else category = 'unblocked-partial-no-owner';

  const copy = CATEGORY_COPY[category];
  return {
    slug: input.plan.planSlug,
    title: input.plan.title,
    harness: input.plan.harnessSlug,
    status: input.registeredHarness ? (input.plan.status ?? 'draft') : 'unknown',
    archived: input.plan.archived,
    template: input.plan.template ?? null,
    templateSlug: input.plan.templateSlug ?? null,
    provenance: planProvenanceFromBlenderFlag(input.plan.isBlenderOrigin),
    category,
    reason: copy.reason,
    recommendation: copy.recommendation,
    created: input.plan.created,
    updated: input.plan.updatedAt ?? input.plan.updated,
    ...counts,
    itemCounts: input.itemCounts,
    audit: input.audit,
    acceptanceRubric: input.acceptanceRubric,
    gateVerdict: input.gateVerdict,
    owners: input.owners,
    blocker: input.blocker,
    nowState: input.plan.nowState ?? '',
    nowNext: input.plan.nowNext ?? '',
  };
}

function planItemsForRow(row: PlanIndexRow): PlanItem[] {
  return row.items.map((item) => ({
    id: item.id,
    text: item.text,
    storedStatus: item.status as PlanItem['storedStatus'],
    importance: item.importance as PlanItem['importance'],
    blockedBy: item.blockedBy,
    decisionRefs: item.decisionRefs,
    phase: item.phase,
    lineNumber: 0,
    rawLine: '',
  }));
}

export function blockerEvidenceForPlan(
  row: PlanIndexRow,
  blockedItems: ReadonlyMap<string, string[]>,
): { itemCounts: Record<string, number>; blocker: AuditBlockerEvidence } {
  const resolved = resolveEffectiveStatusForItems(planItemsForRow(row));
  const overlaid = applyPlanItemBlocks(resolved.items, (itemId) => blockedItems.get(planItemRef(row.planSlug, itemId)));
  const itemCounts: Record<string, number> = {};
  const refs = new Set<string>();
  const staleHints = new Set<string>();
  let typedBlocked = false;
  let typedHuman = false;

  for (const item of overlaid.items) {
    itemCounts[item.effectiveStatus] = (itemCounts[item.effectiveStatus] ?? 0) + 1;
    if (item.effectiveStatus === 'blocked') typedBlocked = true;
    if (item.effectiveStatus === 'needs-human' || item.needsHuman) typedHuman = true;
    for (const ref of item.unresolvedBlockers ?? []) refs.add(ref);
    for (const issueId of overlaid.blockingIssues[item.id] ?? []) refs.add(issueId);
    if (item.staleBlockedHint) staleHints.add(item.staleBlockedHint);
  }

  return {
    itemCounts,
    blocker: {
      typedBlocked,
      typedHuman,
      refs: [...refs].sort(),
      staleHints: [...staleHints].sort(),
    },
  };
}

interface LatestAuditDbRow {
  plan_slug: string;
  audit_seq: number | string;
  created_at: string | Date;
  audited_sha: string | null;
  items: unknown;
}

async function readLatestAudits(workspaceId: string): Promise<Map<string, AuditSummaryEvidence>> {
  const { sql } = getOrgPg();
  const rows = await sql<LatestAuditDbRow[]>`
    SELECT DISTINCT ON (plan_slug)
           plan_slug, audit_seq, created_at, audited_sha, items
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${workspaceId}
     ORDER BY plan_slug, audit_seq DESC`;
  return new Map(
    rows.map((row) => [
      row.plan_slug,
      {
        auditSeq: Number(row.audit_seq),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        auditedSha: row.audited_sha,
        auditedItems: Array.isArray(row.items) ? row.items.length : 0,
      },
    ]),
  );
}

interface WorkItemDbRow {
  source_plan_slug: string | null;
  status: string | null;
  taken_by: string | null;
}

async function readPlanWorkItems(workspaceId: string): Promise<Map<string, AuditWorkItemRow[]>> {
  const { sql } = getOrgPg();
  const rows = await sql<WorkItemDbRow[]>`
    SELECT source_plan_slug, status, taken_by
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND source_plan_slug IS NOT NULL`;
  const out = new Map<string, AuditWorkItemRow[]>();
  for (const row of rows) {
    if (!row.source_plan_slug) continue;
    const item: AuditWorkItemRow = {
      sourcePlanSlug: row.source_plan_slug,
      status: row.status ?? 'unknown',
      holder: row.taken_by,
    };
    const list = out.get(row.source_plan_slug);
    if (list) list.push(item);
    else out.set(row.source_plan_slug, [item]);
  }
  return out;
}

async function readRegisteredHarnesses(): Promise<Set<string>> {
  const { loadHarnessRegistry } = await import('./harness-registry');
  const registry = await loadHarnessRegistry();
  const slugs = new Set(registry.projects.map((project) => project.slug));
  if (slugs.size === 0) throw new Error('unshipped plans audit refused: harness registry is empty');
  return slugs;
}

interface StablePresenceRow {
  ownerId?: unknown;
  ownerLabel?: unknown;
  fleetSlug?: unknown;
  intent?: unknown;
  currentPlanSlug?: unknown;
  claimedPlanItemRefs?: unknown;
}

function ownerEvidence(row: StablePresenceRow, source: AuditOwnerEvidence['source']): AuditOwnerEvidence | null {
  if (typeof row.ownerId !== 'string' || !row.ownerId) return null;
  return {
    ownerId: row.ownerId,
    ownerLabel: typeof row.ownerLabel === 'string' ? row.ownerLabel : null,
    fleet: typeof row.fleetSlug === 'string' ? row.fleetSlug : null,
    intent: typeof row.intent === 'string' ? row.intent : null,
    source,
  };
}

/**
 * Call-time import is load-bearing: register-system-actions imports this module.
 * Top-level-importing presence assembly from a registry-loaded module recreates the
 * registry → coord → agent-tools → registry cycle documented by the coordination
 * runbook. The live-owner read must also fail closed: an unavailable roster aborts
 * the audit instead of silently classifying active work as unattended.
 */
async function readLiveProtection(
  workspaceId: string,
): Promise<{ measuredAt: string; ownersByPlan: Map<string, AuditOwnerEvidence[]> }> {
  const { resolvePresenceScope, assemblePresenceSnapshot } = await import(
    './agent-tools/coordination/presence-snapshot'
  );
  const resolved = await resolvePresenceScope({ workspaceId, harnessSlug: null }, { scope: 'workspace', workspace: workspaceId });
  const snapshot = await assemblePresenceSnapshot(resolved);
  const rows = snapshot.active as StablePresenceRow[];
  const ownerRows = new Map<string, StablePresenceRow>();
  for (const row of rows) {
    if (typeof row.ownerId === 'string') ownerRows.set(row.ownerId, row);
  }
  const ownerIds = [...ownerRows.keys()];
  const ownersByPlan = new Map<string, AuditOwnerEvidence[]>();
  const add = (planSlug: string, evidence: AuditOwnerEvidence | null) => {
    if (!planSlug || !evidence) return;
    const current = ownersByPlan.get(planSlug) ?? [];
    if (!current.some((row) => row.ownerId === evidence.ownerId && row.source === evidence.source)) current.push(evidence);
    ownersByPlan.set(planSlug, current);
  };

  for (const row of rows) {
    if (typeof row.currentPlanSlug === 'string') add(row.currentPlanSlug, ownerEvidence(row, 'declared-plan'));
    if (Array.isArray(row.claimedPlanItemRefs)) {
      for (const ref of row.claimedPlanItemRefs) {
        if (typeof ref !== 'string') continue;
        const hash = ref.lastIndexOf('#');
        if (hash > 0) add(ref.slice(0, hash), ownerEvidence(row, 'work-item-hold'));
      }
    }
  }

  if (ownerIds.length > 0) {
    const { sql } = getOrgPg();
    const [planClaims, workHolds] = await Promise.all([
      sql<{ owner: string; plan_slug: string }[]>`
        SELECT owner, plan_slug
          FROM harness_shared.plan_item_claims
         WHERE workspace_id = ${workspaceId}
           AND owner = ANY(${ownerIds}::text[])
           AND expires_ts > now()`,
      sql<{ taken_by: string; plan_slug: string | null; status: string | null }[]>`
        SELECT taken_by,
               COALESCE(source_plan_slug, payload->'plan_item'->>'plan_slug') AS plan_slug,
               status
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND taken_by = ANY(${ownerIds}::text[])`,
    ]);
    for (const claim of planClaims) add(claim.plan_slug, ownerEvidence(ownerRows.get(claim.owner) ?? {}, 'plan-item-claim'));
    for (const hold of workHolds) {
      if (!hold.plan_slug || WORK_ITEM_TERMINAL_STATUSES.has(hold.status ?? '')) continue;
      add(hold.plan_slug, ownerEvidence(ownerRows.get(hold.taken_by) ?? {}, 'work-item-hold'));
    }
  }

  for (const list of ownersByPlan.values()) list.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  return { measuredAt: snapshot.as_of, ownersByPlan };
}

function acceptanceRubricsByPlan(rubrics: readonly Rubric[]): Map<string, AcceptanceRubricEvidence> {
  const out = new Map<string, AcceptanceRubricEvidence>();
  for (const rubric of rubrics) {
    if (rubric.kind !== 'acceptance' || !rubric.subjectPlan || out.has(rubric.subjectPlan)) continue;
    out.set(rubric.subjectPlan, { rubricId: rubric.rubricId, status: rubric.status });
  }
  return out;
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        out[index] = await fn(values[index]);
      }
    }),
  );
  return out;
}

async function readGateVerdicts(
  plans: readonly PlanIndexRow[],
  audits: ReadonlyMap<string, AuditSummaryEvidence>,
  rubrics: ReadonlyMap<string, AcceptanceRubricEvidence>,
): Promise<Map<string, AcceptanceGateEvidence>> {
  const candidates = plans.filter((plan) => {
    if (!audits.has(plan.planSlug) || !rubrics.has(plan.planSlug)) return false;
    const items = plan.items;
    return items.length > 0 && items.every((item) => ITEM_TERMINAL_STATUSES.has(item.status));
  });
  const rows = await mapConcurrent(candidates, 6, async (plan) => {
    const verdict = await evaluatePlanAcceptanceGate(plan.planSlug);
    return [
      plan.planSlug,
      {
        satisfied: verdict.satisfied,
        ...('code' in verdict && verdict.code ? { code: verdict.code } : {}),
        ...('message' in verdict && verdict.message ? { message: verdict.message } : {}),
        ...('skipped' in verdict && verdict.skipped ? { skipped: verdict.skipped } : {}),
      } satisfies AcceptanceGateEvidence,
    ] as const;
  });
  return new Map(rows);
}

export interface BuildManifestInput {
  includeHistorical?: boolean;
  workspaceId: string;
  snapshotStartedAt: string;
  snapshotFinishedAt: string;
  liveOwnershipMeasuredAt: string;
  allPlans: PlanIndexRow[];
  registeredHarnesses: ReadonlySet<string>;
  ownersByPlan: ReadonlyMap<string, AuditOwnerEvidence[]>;
  workItemsByPlan: ReadonlyMap<string, AuditWorkItemRow[]>;
  blockedItems: ReadonlyMap<string, string[]>;
  auditsByPlan: ReadonlyMap<string, AuditSummaryEvidence>;
  rubricsByPlan: ReadonlyMap<string, AcceptanceRubricEvidence>;
  gateVerdictsByPlan: ReadonlyMap<string, AcceptanceGateEvidence>;
}

export function buildUnshippedPlansAuditManifest(input: BuildManifestInput): UnshippedPlansAuditManifest {
  const nonterminal = input.allPlans.filter(
    (plan) => input.includeHistorical || (!plan.archived && !plan.templateSlug && !PLAN_TERMINAL_STATUSES.has(plan.status ?? 'draft')),
  );
  const rows = nonterminal.map((plan) => {
    const evidence = blockerEvidenceForPlan(plan, input.blockedItems);
    return classifyUnshippedPlan({
      plan,
      registeredHarness: input.registeredHarnesses.has(plan.harnessSlug),
      owners: [...(input.ownersByPlan.get(plan.planSlug) ?? [])],
      workItems: [...(input.workItemsByPlan.get(plan.planSlug) ?? [])],
      blocker: evidence.blocker,
      itemCounts: evidence.itemCounts,
      audit: input.auditsByPlan.get(plan.planSlug) ?? null,
      acceptanceRubric: input.rubricsByPlan.get(plan.planSlug) ?? null,
      gateVerdict: input.gateVerdictsByPlan.get(plan.planSlug) ?? null,
    });
  });
  rows.sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

  const summaryByCategory: UnshippedPlansAuditManifest['summaryByCategory'] = {};
  const bands: Record<UnshippedPlanAuditBand, number> = {
    protected: 0,
    closeoutOrReconcile: 0,
    supersedeOrRetire: 0,
    blockerClaims: 0,
    unblockedPartial: 0,
    catalogResidue: 0,
  };
  for (const row of rows) {
    const summary = summaryByCategory[row.category] ?? { count: 0, byStatus: {} };
    summary.count += 1;
    summary.byStatus[row.status] = (summary.byStatus[row.status] ?? 0) + 1;
    summaryByCategory[row.category] = summary;
    bands[CATEGORY_BAND[row.category]] += 1;
  }

  const currentRegistryAtPublish: Record<string, number> & { total: number } = { total: input.allPlans.length };
  for (const plan of input.allPlans) {
    const status = plan.status ?? 'draft';
    currentRegistryAtPublish[status] = (currentRegistryAtPublish[status] ?? 0) + 1;
  }
  const blender = rows.filter((row) => row.provenance === 'blender').length;
  // Classes can overlap. Each count compares the input census with the exact
  // selected population; a legacy nonterminal report discloses its exclusions.
  const predicates = {
    archived: (plan: PlanIndexRow) => plan.archived,
    superseded: (plan: PlanIndexRow) => plan.status === 'superseded',
    rubricTemplate: (plan: PlanIndexRow) => plan.template === 'rubric',
    scheduledInstance: (plan: PlanIndexRow) => Boolean(plan.templateSlug),
  };
  const census = Object.fromEntries(Object.entries(predicates).map(([key, predicate]) => {
    const listed = input.allPlans.filter(predicate).length;
    const included = nonterminal.filter(predicate).length;
    const excluded = listed - included;
    return [key, { listed, included, excluded, exclusionReason: excluded ? 'Legacy nonterminal scope excludes archived, terminal and scheduled-instance plans.' : null }];
  })) as UnshippedPlansAuditManifest['scope']['census'];

  return {
    schemaVersion: 'unshipped-plans-audit-manifest-v2',
    generatedAt: input.snapshotFinishedAt,
    workspace: input.workspaceId,
    scope: {
      snapshotStartedAt: input.snapshotStartedAt,
      snapshotFinishedAt: input.snapshotFinishedAt,
      liveOwnershipMeasuredAt: input.liveOwnershipMeasuredAt,
      nonterminalListedAtSnapshot: nonterminal.filter(plan => !plan.archived && !plan.templateSlug && !PLAN_TERMINAL_STATUSES.has(plan.status ?? 'draft')).length,
      listedAtSnapshot: input.allPlans.length,
      census,
      materialized: rows.filter((row) => row.category !== 'catalog-residue').length,
      catalogFailures: rows.filter((row) => row.category === 'catalog-residue').length,
      classifiedRows: rows.length,
      rule: 'Point-in-time, read-only audit. Ongoing plans are protected; no lifecycle, item, blocker, claim, assignment, or ownership state is changed.',
      classifierRevision: UNSHIPPED_PLANS_AUDIT_CLASSIFIER_REVISION,
      classifierCorrection:
        'Plan-level supersession requires an explicit plan-subject assertion in the Now state; prose-only blockers require blocker-shaped Now syntax, so incidental slug/title/history vocabulary is never lifecycle authority.',
    },
    summaryByCategory,
    bands,
    closeoutEvidence: {
      staleAuditAndRubric: summaryByCategory['closeout-stale-audit']?.count ?? 0,
      missingAuditOrAcceptance: summaryByCategory['closeout-evidence-missing']?.count ?? 0,
    },
    blockerEvidence: {
      typedCurrent:
        (summaryByCategory['typed-blocker']?.count ?? 0) + (summaryByCategory['typed-human-blocker']?.count ?? 0),
      typedWithStaleHint: summaryByCategory['typed-blocker-stale-hint']?.count ?? 0,
      textOnly:
        (summaryByCategory['text-only-human-blocker']?.count ?? 0) +
        (summaryByCategory['text-only-external-blocker']?.count ?? 0),
    },
    currentRegistryAtPublish,
    provenance: { blender, outsideBlender: rows.length - blender },
    rows,
  };
}

export function renderUnshippedPlansAuditHtml(manifest: UnshippedPlansAuditManifest): string {
  return renderPlanAuditReport({ ...manifest, rows: manifest.rows.map((row) => ({ ...row })) });
}

export interface RunUnshippedPlansAuditOptions {
  workspaceId?: string;
  artifactHarness?: string;
  /** Explicit click-time population; absent means the current nonterminal portfolio. */
  planSlugs?: string[];
  includeHistorical?: boolean;
  /** Unique run namespace. A scoped run never overwrites the system latest report. */
  artifactPrefix?: string;
}

export function selectAuditPlans(plans: PlanIndexRow[], requested?: string[]): PlanIndexRow[] {
  if (requested === undefined) return plans;
  if (requested.length === 0 || requested.length > 10000 || requested.some((slug) => typeof slug !== 'string' || !slug.trim())) {
    throw new Error('Audit selection requires 1–10000 nonempty plan slugs');
  }
  const wanted = new Set(requested.map((slug) => slug.trim()));
  const selected = plans.filter((plan) => wanted.has(plan.planSlug));
  const missing = [...wanted].filter((slug) => !selected.some((plan) => plan.planSlug === slug));
  if (missing.length) throw new Error('Audit selection contains unavailable plans: ' + missing.join(', '));
  return selected;
}

export interface RunUnshippedPlansAuditResult {
  manifest: UnshippedPlansAuditManifest;
  artifacts: { json: string; html: string; harness: string };
}

export async function runUnshippedPlansAudit(
  opts: RunUnshippedPlansAuditOptions = {},
): Promise<RunUnshippedPlansAuditResult> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const artifactHarness = opts.artifactHarness ?? 'papercusp';
  const snapshotStartedAt = new Date().toISOString();

  const [listedPlans, registeredHarnesses, liveProtection, workItemsByPlan, blockedItems, auditsByPlan, rubrics] =
    await Promise.all([
      listPlanIndexRowsForWorkspace({
        workspaceId,
        includeArchived: opts.includeHistorical ?? opts.planSlugs !== undefined,
        includeInstances: opts.includeHistorical ?? opts.planSlugs !== undefined,
        includeItems: true,
        heavyFields: true,
        order: 'slug',
      }),
      readRegisteredHarnesses(),
      readLiveProtection(workspaceId),
      readPlanWorkItems(workspaceId),
      getAllBlockedPlanItems(),
      readLatestAudits(workspaceId),
      listRubrics({ kind: 'acceptance', limit: 500 }),
    ]);
  const allPlans = selectAuditPlans(listedPlans, opts.planSlugs);
  if (allPlans.length === 0) throw new Error(`unshipped plans audit refused: workspace '${workspaceId}' returned zero plans`);

  const rubricsByPlan = acceptanceRubricsByPlan(rubrics);
  const gateVerdictsByPlan = await readGateVerdicts(allPlans, auditsByPlan, rubricsByPlan);
  const snapshotFinishedAt = new Date().toISOString();
  const manifest = buildUnshippedPlansAuditManifest({
    workspaceId,
    includeHistorical: opts.includeHistorical ?? opts.planSlugs !== undefined,
    snapshotStartedAt,
    snapshotFinishedAt,
    liveOwnershipMeasuredAt: liveProtection.measuredAt,
    allPlans,
    registeredHarnesses,
    ownersByPlan: liveProtection.ownersByPlan,
    workItemsByPlan,
    blockedItems,
    auditsByPlan,
    rubricsByPlan,
    gateVerdictsByPlan,
  });

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const html = renderUnshippedPlansAuditHtml(manifest);
  const prefix = opts.artifactPrefix ?? (opts.planSlugs ? 'reports/plan-audits/scoped-' + crypto.randomUUID() : null);
  if (prefix && !/^reports\/plan-audits\/[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('Invalid audit artifact namespace');
  const jsonPath = prefix ? prefix + '/audit.json' : UNSHIPPED_PLANS_AUDIT_JSON_ARTIFACT;
  const htmlPath = prefix ? prefix + '/report.html' : UNSHIPPED_PLANS_AUDIT_HTML_ARTIFACT;
  await saveTextArtifact(artifactHarness, jsonPath, json);
  await saveTextArtifact(artifactHarness, htmlPath, html);

  return {
    manifest,
    artifacts: {
      json: jsonPath,
      html: htmlPath,
      harness: artifactHarness,
    },
  };
}
