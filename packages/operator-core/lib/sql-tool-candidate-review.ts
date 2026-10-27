/** Passive demand enters the existing review queue; never generates or executes tools. */
import { createHash } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { newCollisionResistantIssueTail } from './issues-engineer';
import { captureImprovement, type CaptureImprovementInput } from './harness/improvements/capture-core';
import { enterAgentReview } from './harness/improvements/agent-review';
import { readAgentReviewState } from './harness/improvements/agent-review-policy';
import { getWorkItem, setWorkItemStateWithAliasInfo, type WorkItem } from './work-items';
import type { SqlToolCandidateScore } from './sql-tool-candidate-score';
import type { SqlToolRecommendation } from './bash-substitution/sql-tool-recommendations';
import { activeWorkspaceId } from './workspace-registry';
import { ALL_SUCCESSFUL_STATUSES, ALL_TERMINAL_STATUSES } from './work-item-blocking';
import { readProductionMonitoredCandidate, type MonitoredCandidateReadOptions } from './agent-opportunities/census';
import type { MonitoredFamily } from './agent-opportunities/pipeline';
import { boundedStage, miningFailureReason } from './agent-opportunities/pipeline';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface SqlCandidateReviewInput {
  workspaceId: string;
  harnessSlug: string;
  submittedBy: string;
  candidate: SqlToolCandidateScore;
  /** Versioned contract identity; counts and observation dates are not material editions. */
  contractRef: string;
  /** Pointer to the ACL-checked, expiring aggregate; never copy source SQL into review. */
  sourceRef?: { scopeId: string; ranOn: string };
  recommendation?: SqlToolRecommendation;
}
export function sqlCandidateReviewIdentity(input: SqlCandidateReviewInput) {
  if (!input.workspaceId || !input.harnessSlug || !input.submittedBy || !input.contractRef)
    throw new Error('invalid_sql_candidate_review_identity');
  const lifecycleId = hash([input.workspaceId, input.harnessSlug, input.candidate.id]);
  const r = input.recommendation;
  const editionId = hash([input.contractRef, r?.kind ?? 'review-demand', r?.toolName ?? null,
    [...(r?.missingFeatures ?? [])].sort()]);
  return { lifecycleId, editionId, conditionKey: `sql-candidate:${lifecycleId}:${editionId}` };
}
export interface SqlCandidateReviewDeps {
  client?: ReturnType<typeof getOrgPg>['sql'];
  capture?: (input: CaptureImprovementInput) => Promise<unknown>;
  enroll?: typeof enterAgentReview;
  read?: (id: string, harness: string) => Promise<WorkItem | null>;
  open?: (id: string, harness: string, by: string) => Promise<void>;
}
export interface SqlCandidateReviewResult {
  status: 'ineligible' | 'suppressed' | 'pending' | 'accepted' | 'declined' | 'UNKNOWN';
  lifecycleId: string;
  editionId: string;
  workItemId: string | null;
  /** Authoritative post-review read; the initial capture assignment is never proof. */
  owner: string | null;
  queue: 'agent-review' | 'implementation' | null;
  stage?: 'review'; reason?: string;
}
type ReviewIdentity = ReturnType<typeof sqlCandidateReviewIdentity>;
interface ReviewPacket {
  identity: ReviewIdentity; eligible: boolean; suppressed: boolean;
  title: string; body: string; payloadExtra: CaptureImprovementInput['payloadExtra'];
  /** Re-read current evidence around every asynchronous intake boundary. */
  authorize?: () => Promise<boolean>;
}
export async function submitSqlCandidateReview(
  input: SqlCandidateReviewInput, deps: SqlCandidateReviewDeps = {},
): Promise<SqlCandidateReviewResult> {
  const identity = sqlCandidateReviewIdentity(input);
  return submitCandidateReview(input, {
    identity, eligible: input.candidate.eligible && input.recommendation?.kind !== 'insufficient-evidence',
    suppressed: ['keep-sql', 'route-existing'].includes(input.recommendation?.kind ?? ''),
    title: 'Review recurring SQL intent ' + identity.lifecycleId.slice(0, 12),
    body: 'Passive recurring SQL demand. Review scoped evidence and current contracts before proposing implementation. No tool is generated or executed.\n'
      + JSON.stringify({ lifecycleId: identity.lifecycleId, editionId: identity.editionId,
        contractRef: input.contractRef, policyVersion: input.candidate.policyVersion,
        sourceRef: input.sourceRef ?? null, candidateId: input.candidate.id,
        recommendation: input.recommendation?.kind ?? 'review-demand' }),
    payloadExtra: { sqlCandidateReview: { lifecycleId: identity.lifecycleId, editionId: identity.editionId } },
  }, deps);
}

export interface MonitoredCandidateReviewInput extends Omit<MonitoredCandidateReadOptions,
  'family' | 'authorizeSource' | 'authorizeCandidate'> {
  family: Exclude<MonitoredFamily, 'sql'>;
  submittedBy: string; contractRef: string;
}
export interface MonitoredCandidateReviewDeps extends SqlCandidateReviewDeps {
  /** Trusted test seam; production always replays canonical sources and current ACLs. */
  evidence?: typeof readProductionMonitoredCandidate;
}
export function monitoredCandidateReviewIdentity(input: MonitoredCandidateReviewInput): ReviewIdentity {
  if (!input.workspaceId || !input.harnessSlug || !input.submittedBy || !input.contractRef
    || !['search-reformulation', 'result-recovery', 'workaround-funnel', 'native-operation'].includes(input.family)
    || !/^[a-f0-9]{64}$/.test(input.candidateId)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.runId))
    throw new Error('invalid_monitored_candidate_review_identity');
  // Runs and changing measurements are evidence editions, never new demand identities.
  const lifecycleId = hash([input.workspaceId, input.harnessSlug, input.family, input.candidateId]);
  const editionId = hash(['monitored-review-demand-v1', input.contractRef]);
  return { lifecycleId, editionId, conditionKey: `monitored-candidate:${lifecycleId}:${editionId}` };
}
export async function submitMonitoredCandidateReview(
  input: MonitoredCandidateReviewInput, deps: MonitoredCandidateReviewDeps = {},
): Promise<SqlCandidateReviewResult> {
  const identity = monitoredCandidateReviewIdentity(input);
  const budget = Math.min(30_000, Math.max(1, input.timeBudgetMs ?? 5000));
  const deadline = Date.now() + budget;
  let cancelled = false;
  const authorize = async () => {
    if (cancelled || Date.now() >= deadline) return false;
    const evidence = await (deps.evidence ?? readProductionMonitoredCandidate)({ ...input,
      timeBudgetMs: Math.max(1, deadline - Date.now()) });
    return !cancelled && Date.now() < deadline && evidence?.id === input.candidateId && evidence.reviewEligible === true;
  };
  const pointer = { family: input.family, runId: input.runId, candidateId: input.candidateId,
    lifecycleId: identity.lifecycleId, editionId: identity.editionId };
  try {
    const result = await boundedStage(() => submitCandidateReview(input, {
    identity, eligible: true, suppressed: false, authorize,
    title: `Review recurring ${input.family} opportunity ${identity.lifecycleId.slice(0, 12)}`,
    // Work-item reads have no source-ACL hook. Retain pointers only, never counts,
    // rankings, memberships, raw requests or copies of derived evidence.
    body: 'Passive opportunity. Read current scoped evidence before reviewing.\n' + JSON.stringify(pointer),
    payloadExtra: { monitoredCandidateReview: pointer },
    }, { ...deps, client: deps.client ?? input.client }), budget);
    return result.status === 'UNKNOWN'
      ? { ...result, stage: 'review', reason: 'monitored_candidate_evidence_or_intake_unavailable' } : result;
  } catch (error) { return { status: 'UNKNOWN', lifecycleId: identity.lifecycleId, editionId: identity.editionId,
    workItemId: null, owner: null, queue: null, stage: 'review', reason: miningFailureReason(error) }; }
  finally { cancelled = true; }
}

/** Opaque work-item pointers never grant access to current review state or evidence. */
export async function readMonitoredCandidateReview(
  input: MonitoredCandidateReviewInput, deps: MonitoredCandidateReviewDeps = {},
): Promise<SqlCandidateReviewResult | null> {
  const identity = monitoredCandidateReviewIdentity(input);
  if (!deps.read && activeWorkspaceId() !== input.workspaceId) return null;
  const budget = Math.min(30_000, Math.max(1, input.timeBudgetMs ?? 5000)), deadline = Date.now() + budget;
  let cancelled = false;
  const allowed = async () => {
    if (cancelled || Date.now() >= deadline) return false;
    const evidence = await (deps.evidence ?? readProductionMonitoredCandidate)({ ...input,
      timeBudgetMs: Math.max(1, deadline - Date.now()) });
    return !cancelled && Date.now() < deadline && evidence?.id === input.candidateId && evidence.reviewEligible === true;
  };
  try { return await boundedStage(async () => {
    if (!await allowed()) return null;
    const sql = deps.client ?? input.client ?? getOrgPg().sql;
    const [row] = await sql<{ artifact_id: string }[]>`SELECT artifact_id FROM harness_shared.sql_candidate_reviews
      WHERE workspace_id=${input.workspaceId} AND harness_slug=${input.harnessSlug}
        AND lifecycle_id=${identity.lifecycleId} AND edition_id=${identity.editionId} AND NOT suppressed`;
    if (!row || !await allowed()) return null;
    const item = await (deps.read ?? getWorkItem)(row.artifact_id, input.harnessSlug);
    if (!item || item.harness !== input.harnessSlug || !await allowed()) return null;
    const review = readAgentReviewState(item.payload);
    const terminal = ALL_TERMINAL_STATUSES.has(item.state);
    const status: SqlCandidateReviewResult['status'] = terminal
      ? ALL_SUCCESSFUL_STATUSES.has(item.state) ? 'accepted' : 'declined'
      : review?.status === 'approved' ? 'accepted' : review && item.state === 'open' ? 'pending' : 'UNKNOWN';
    return { status, lifecycleId: identity.lifecycleId, editionId: identity.editionId,
      workItemId: row.artifact_id, owner: item.assignee,
      queue: !terminal && review?.status === 'approved' ? 'implementation' : status === 'pending' ? 'agent-review' : null };
  }, budget); } catch { return null; } finally { cancelled = true; }
}

async function submitCandidateReview(
  input: Pick<SqlCandidateReviewInput, 'workspaceId' | 'harnessSlug' | 'submittedBy'>,
  packet: ReviewPacket, deps: SqlCandidateReviewDeps,
): Promise<SqlCandidateReviewResult> {
  const identity = packet.identity;
  const answer = (status: SqlCandidateReviewResult['status'], workItemId: string | null = null,
    owner: string | null = null, queue: SqlCandidateReviewResult['queue'] = null): SqlCandidateReviewResult =>
    ({ status, lifecycleId: identity.lifecycleId, editionId: identity.editionId, workItemId, owner, queue });
  if (!packet.eligible) return answer('ineligible');
  const allowed = async () => {
    try { return packet.authorize ? await packet.authorize() : true; } catch { return false; }
  };
  if (!await allowed()) return answer('UNKNOWN');
  // Production capture writes through the existing workspace context. Fail closed
  // before reserving or filing if that context differs from the candidate's scope.
  if (!deps.capture && activeWorkspaceId() !== input.workspaceId) return answer('UNKNOWN');
  const sql = deps.client ?? getOrgPg().sql;
  const suppress = packet.suppressed;
  const rows = await sql<{ artifact_id: string; suppressed: boolean }[]>`
    INSERT INTO harness_shared.sql_candidate_reviews
      (workspace_id,harness_slug,lifecycle_id,edition_id,artifact_id,suppressed)
    VALUES (${input.workspaceId},${input.harnessSlug},${identity.lifecycleId},${identity.editionId},
      ${'EI-' + newCollisionResistantIssueTail()},${suppress})
    ON CONFLICT (workspace_id,harness_slug,lifecycle_id,edition_id) DO UPDATE
      SET lifecycle_id=EXCLUDED.lifecycle_id
    RETURNING artifact_id,suppressed`;
  const reservation = rows[0];
  if (!reservation) return answer('UNKNOWN');
  if (!await allowed()) return answer('UNKNOWN');
  if (reservation.suppressed) return answer('suppressed');
  const id = reservation.artifact_id;
  const read = deps.read ?? getWorkItem;
  let item = await read(id, input.harnessSlug);
  if (!await allowed()) return answer('UNKNOWN');
  if (!item) {
    await (deps.capture ?? captureImprovement)({
      artifactId: id, watchdogKey: identity.conditionKey, kind: 'feature',
      scope: `harness:${input.harnessSlug}`, workspaceId: input.workspaceId,
      createdBy: input.submittedBy, assignee: input.submittedBy,
      reviewRequired: true, reviewHarness: input.harnessSlug,
      title: packet.title, body: packet.body, payloadExtra: packet.payloadExtra,
    });
    if (!await allowed()) return answer('UNKNOWN');
    item = await read(id, input.harnessSlug);
  }
  if (!await allowed()) return answer('UNKNOWN');
  if (!item || item.harness !== input.harnessSlug) return answer('UNKNOWN', id);
  const review = readAgentReviewState(item.payload);
  if (ALL_TERMINAL_STATUSES.has(item.state))
    return answer(ALL_SUCCESSFUL_STATUSES.has(item.state) ? 'accepted' : 'declined', id, item.assignee);
  if (review?.status === 'approved') return answer('accepted', id, item.assignee, 'implementation');
  // Enrollment persists review state before releasing the filer's claim. A crash
  // between those writes must retry enrollment, without releasing a reviewer's hold.
  if (!review || (review.status === 'pending' && item.assignee === input.submittedBy)) {
    if (!await allowed()) return answer('UNKNOWN');
    const enrolled = await (deps.enroll ?? enterAgentReview)({ id, submittedBy: input.submittedBy,
      harnessSlug: input.harnessSlug, workspaceId: input.workspaceId });
    if (!enrolled.entered && enrolled.state?.status !== 'pending') return answer('UNKNOWN', id);
  }
  // Recovery after enrollment committed but the subsequent reopen was interrupted.
  if (!review || (review.status === 'pending' && item.state === 'blocked')) {
    if (!await allowed()) return answer('UNKNOWN');
    await (deps.open ?? (async (workId, harness, by) => {
      const result = await setWorkItemStateWithAliasInfo(workId, 'open', { harness, by });
      if ((result.appliedState ?? result.workItem?.state) !== 'open') throw new Error('sql_candidate_review_reopen_failed');
    }))(id, input.harnessSlug, input.submittedBy);
  }
  item = await read(id, input.harnessSlug);
  if (!item || !await allowed()) return answer('UNKNOWN');
  const post = readAgentReviewState(item.payload);
  if (post?.status === 'approved') return answer('accepted', id, item.assignee, 'implementation');
  return post && item.state === 'open'
    ? answer('pending', id, item.assignee, 'agent-review') : answer('UNKNOWN', id);
}
