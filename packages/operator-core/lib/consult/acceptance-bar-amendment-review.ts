/**
 * acceptance-bar-amendment-review.ts — the routed outside-lineage review of a
 * started acceptance-BAR amendment (P-005,
 * review-routing-through-relevance-router-2026-09-26).
 *
 * D-001 [owner 2026-09-26]: every review is recruited by the relevance
 * router and answered by a fork/convert of the routed expert's transcript, never
 * by hand-picking a reviewer and messaging them. This is that route for the
 * amendment approval:
 *
 *  - the menu is bounded by ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY;
 *  - every candidate is screened with the SAME screen rubrics:check-approver
 *    exposes (`resolveAcceptanceBarApproverScreen`), applied to the routed
 *    EXPERT. The answering session forks that expert's transcript, and
 *    acceptance-author-identity gives a routed fork its source's lineage, so
 *    screening the source is screening the reviewer the apply guard will judge;
 *  - the screen runs BEFORE selection (as `filterRoute`), so minimum-fill and
 *    every later cascade rank inherit the same fence, and a screen fault throws
 *    (fail closed) instead of letting an unscreened candidate through.
 *
 * P-006 connects rubrics:amend to it: `openAcceptanceBarAmendmentReview` checks
 * the requester's preview post with the apply guard's own resolver, then routes
 * a brief that carries everything the reviewer signs (no tool reads a thread
 * post by id, so the brief cannot just point at it).
 *
 * WI-10003299: when the router has nobody eligible (every live candidate is in
 * the implementers' lineage, which is the normal state on a plan whose whole
 * fleet built it), the review no longer dead-ends. It launches ONE fresh reviewer
 * the way grading does (acceptance-grader.ts / grading-integrity.ts): under a
 * dedicated system principal, so the launch edge makes the reviewer a
 * descendant of that principal and not of the requester. That principal is
 * screened with the same check-approver screen first, the launch is idempotent
 * per preview, and the reviewer answers with a work_items:comment on the
 * preview's own work-item, whose author the apply guard judges as usual.
 */
import { createHash } from 'node:crypto';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { AcceptanceBarAmendmentPreview, AcceptanceBarApproverEligibilityCheck } from '../rubrics';
import type { RouteResult } from './relevance-router';
import type { ConsultReviewerModel } from './get-feedback-core';
import { resolveExpertModelAllowlist, type AllowedExpertModel } from './expert-model-allowlist';
import { ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY } from './selection-policies';
import { analyzeClaudeResumeTranscriptFile } from '../claude-resume-tool-references.mjs';
import { isTerminalState, type TaskState } from '../task-manager/types';
import { defaultStopFailedLaunch } from './consult-dispatch';

/** One candidate's verdict from the check-approver screen. */
export type AmendmentReviewerScreen = (
  ownerId: string,
) => Promise<Pick<AcceptanceBarApproverEligibilityCheck, 'eligible' | 'reason'>>;

export interface AmendmentReviewScreenedOut {
  ownerId: string;
  reason: AcceptanceBarApproverEligibilityCheck['reason'];
}

/**
 * Keep only candidates the screen calls eligible, in both the qualified list and
 * the snapshot the minimum-fill draws from. Each distinct owner is screened
 * once; a screen error propagates.
 */
export async function filterAmendmentReviewRoute(
  route: RouteResult,
  screen: AmendmentReviewerScreen,
  onScreenedOut?: (entry: AmendmentReviewScreenedOut) => void,
): Promise<RouteResult> {
  const ownerIds = [...new Set([...route.qualified, ...route.snapshot.candidates].map((c) => c.ownerId))];
  const eligible = new Set<string>();
  for (const ownerId of ownerIds) {
    const verdict = await screen(ownerId);
    if (verdict.eligible === true) eligible.add(ownerId);
    else onScreenedOut?.({ ownerId, reason: verdict.reason });
  }
  const allowed = (candidate: { ownerId: string }) => eligible.has(candidate.ownerId);
  return {
    ...route,
    qualified: route.qualified.filter(allowed),
    snapshot: { ...route.snapshot, candidates: route.snapshot.candidates.filter(allowed) },
  };
}

export interface AmendmentReviewRouteInput {
  /** The started acceptance rubric being amended. */
  rubricRef: string;
  /** What the reviewer must inspect: the exact candidate criteria and dry-run diff. */
  brief: string;
  /** The identity that will APPLY the amendment (the requester). */
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
  reviewerModel?: ConsultReviewerModel;
}

/** A constrained review may only use a model admitted by the workspace's
 * existing expert allowlist. Never silently use a different ranked model. */
async function assertReviewerModelAllowed(workspaceId: string, choice: ConsultReviewerModel): Promise<void> {
  const { readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings } = await import('./expert-routing-settings');
  const settings = bindConsultExpertRoutingSettings(await readConsultExpertRoutingSettings(workspaceId));
  const ranks = await resolveExpertModelAllowlist(workspaceId, { loadRanks: settings.loadRanks });
  if (!ranks.some((rank) => rank.agent === choice.agent && rank.model === choice.model)) {
    throw new Error(`reviewer_model_not_allowed: ${choice.agent}/${choice.model} is absent from the workspace expert allowlist`);
  }
}

export type AmendmentReviewRouteResult =
  | { state: 'routed'; conversationId: string; responderId: string | null; screenedOut: AmendmentReviewScreenedOut[] }
  | { state: 'no-eligible-reviewer'; conversationId: string | null; reason: string; screenedOut: AmendmentReviewScreenedOut[] };

export async function routeAcceptanceBarAmendmentReview(
  input: AmendmentReviewRouteInput,
  deps: {
    resolveScreen?: (args: { rubricId: string; applierId: string }) => Promise<{ check: AmendmentReviewerScreen }>;
    feedback?: typeof import('./get-feedback-prod').getFeedbackProd;
    assertAllowed?: typeof assertReviewerModelAllowed;
  } = {},
): Promise<AmendmentReviewRouteResult> {
  const rubricId = input.rubricRef.trim().replace(/^plan:/i, '').trim();
  if (input.reviewerModel) await (deps.assertAllowed ?? assertReviewerModelAllowed)(input.workspaceId, input.reviewerModel);
  const applierId = input.identity.ownerId;
  const resolveScreen =
    deps.resolveScreen ?? (async (args) => (await import('../rubrics')).resolveAcceptanceBarApproverScreen(args));
  // Resolve the population before routing: an unreadable rubric or implementer
  // history refuses the review rather than routing it unscreened.
  const screen = await resolveScreen({ rubricId, applierId });
  const feedback = deps.feedback ?? (await import('./get-feedback-prod')).getFeedbackProd;
  const screenedOut: AmendmentReviewScreenedOut[] = [];
  const result = await feedback(
    {
      workspaceId: input.workspaceId,
      requesterId: applierId,
      question: input.brief,
      originTaskRef: rubricId,
      subjectRef: rubricId,
      // The applier is also screened; excluding it up front keeps it out of
      // the router's own candidate accounting.
      excludeOwners: [applierId],
      // An archived answer is not an approval of THIS diff: always route fresh.
      archiveFloor: 2,
      policy: ACCEPTANCE_BAR_AMENDMENT_REVIEW_POLICY,
      ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
      latencyContract: 'hard-blocked',
      ...(input.harness ? { harnessSlug: input.harness } : {}),
    },
    input.identity,
    { filterRoute: (route) => filterAmendmentReviewRoute(route, screen.check, (entry) => screenedOut.push(entry)) },
  );
  if ('error' in result) throw new Error(`acceptance_bar_amendment_review_refused: ${result.error}`);
  if (result.verdict === 'routed') {
    return {
      state: 'routed',
      conversationId: result.conversation_id,
      responderId: result.responder?.ownerId ?? null,
      screenedOut,
    };
  }
  return {
    state: 'no-eligible-reviewer',
    conversationId: result.conversation_id ?? null,
    reason: `${result.verdict}${result.reason ? ` (${result.reason})` : ''}`,
    screenedOut,
  };
}

const PREVIEW_POST_REF = /^thread-post:[1-9][0-9]*$/;
const BRIEF_REASON_MAX = 800;
const BRIEF_PATCH_MAX = 2500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars clipped]`;
}

interface ReviewPatchExcerpt {
  patch: string;
  omittedCriteria: number;
  omittedBarKeys: string[];
  totalCriteria: number;
}

/**
 * The patch shown to the reviewer. A patch that fits is shown whole. A large
 * replacement keeps every CHANGED criterion and drops the unchanged ones, and
 * the trimmed form is deliberately NOT shaped like a replacement: changed
 * criteria sit under `changedCriteria` and the omitted keys under
 * `omittedUnchangedBarKeys`, with no `criteria` key. rubrics:amend reads a
 * `criteria` array as a FULL replacement, so an excerpt keyed `criteria`
 * replays as "every omitted bar removed" — three reviewers did exactly that
 * on 2026-10-06 despite a prose warning (WI-10006741).
 */
function reviewPatch(input: AmendmentReviewBriefInput): ReviewPatchExcerpt {
  const full = JSON.stringify(input.patch);
  const whole = { patch: full, omittedCriteria: 0, omittedBarKeys: [], totalCriteria: 0 };
  if (full.length <= BRIEF_PATCH_MAX || !Array.isArray(input.patch.criteria)) {
    return whole;
  }

  const changedKeys = new Set(input.preview.changes.map((change) => change.barKey));
  const criteria = input.patch.criteria;
  const changedCriteria = criteria.filter((criterion) => {
    if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) return false;
    const candidate = criterion as Record<string, unknown>;
    const barKey = candidate.barKey ?? candidate.key;
    return typeof barKey === 'string' && changedKeys.has(barKey.trim());
  });
  // A malformed or unmappable replacement must stay complete: omitting entries
  // would make a change invisible to the reviewer.
  if (criteria.some((criterion) => !criterion || typeof criterion !== 'object' || Array.isArray(criterion)
    || typeof ((criterion as Record<string, unknown>).barKey ?? (criterion as Record<string, unknown>).key) !== 'string')
    || input.preview.changes.some((change) => !changedCriteria.some((criterion) => {
      const candidate = criterion as Record<string, unknown>;
      return ((candidate.barKey ?? candidate.key) as string).trim() === change.barKey;
    }))) {
    return whole;
  }
  const omittedBarKeys = criteria
    .filter((criterion) => !changedCriteria.includes(criterion))
    .map((criterion) => {
      const candidate = criterion as Record<string, unknown>;
      return String(candidate.barKey ?? candidate.key).trim();
    });
  const { criteria: _replacement, ...otherFields } = input.patch;
  return {
    patch: JSON.stringify({ ...otherFields, changedCriteria, omittedUnchangedBarKeys: omittedBarKeys }),
    omittedCriteria: omittedBarKeys.length,
    omittedBarKeys,
    totalCriteria: criteria.length,
  };
}

export interface AmendmentReviewBriefInput {
  rubricRef: string;
  /** `thread-post:<id>` — the requester's post carrying the exact preview approval JSON. */
  previewPostRef: string;
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes'>;
  reason?: string;
  /** The amendment fields as requested, so the reviewer can reproduce the preview. */
  patch: Record<string, unknown>;
  /** Validated immutable evidence on the preview's thread; never an arbitrary retry salt. */
  reviewEvidence?: { postRef: string; body: string };
}

/** Where a fresh reviewer (who has no consult to answer) posts its verdict: the
 * work-item whose thread holds the preview post. */
export interface FreshReviewerAnswerTarget {
  workItemId: string;
  harness: string | null;
}

/**
 * What the routed reviewer reads. It carries the approval JSON and the patch
 * itself so the reviewer can assess the exact request from the consult without
 * relying on a separate thread-post lookup. It names the one-line answer the
 * apply guard accepts (`approve thread-post:<id>`).
 *
 * With `answerOn` it is the FRESH reviewer's brief (WI-10003299): same content,
 * but the reviewer was launched rather than routed, runs as a judge (no
 * rubrics:amend), and answers with one work_items:comment on that work-item.
 */
export function buildAmendmentReviewBrief(
  input: AmendmentReviewBriefInput,
  answerOn?: FreshReviewerAnswerTarget,
): string {
  const shownPatch = reviewPatch(input);
  const bars = input.preview.changes
    .map((change) => `${change.barKey} (${[...change.kinds].join('+')}${change.fields?.length ? `: ${change.fields.join(', ')}` : ''})`)
    .join('; ');
  const commentCall = answerOn
    ? `work_items:comment { id:'${answerOn.workItemId}'${answerOn.harness ? `, harness:'${answerOn.harness}'` : ''} }`
    : '';
  return [
    'Before judging, read the complete brief. If conversations:get shows `_projection.truncated`, call `capability:read` with the returned cursor\'s `file_path` or `uri` plus its `byte_offset` and `byte_limit`; follow `next_cursor` and stop when the response has `eof:true` and `next_cursor:null`. Do not decide from the excerpt.',
    'If rubrics:get reports that the backing rubric row exists but this server could not project it, do not treat the rubric as absent. Read the raw structured record with plans:get-template-data { slug:\'<unprefixed rubric slug>\', harness:\'<current review harness>\' } and grade its complete templateData.criteria. This read preserves fields an older rubric projector may not understand; recover any truncated response before judging.',
    answerOn
      ? `Outside-lineage review of a started acceptance-BAR amendment to ${input.rubricRef}. The relevance router found no eligible reviewer, so ${ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR} launched you fresh: you are outside the implementer's lineage, and the apply guard re-checks that from your post.`
      : `Outside-lineage review of a started acceptance-BAR amendment to ${input.rubricRef}. The relevance router picked you and screened you with rubrics:check-approver: you are outside the implementer's lineage.`,
    `Changed BARs: ${bars || '(none listed)'}.`,
    'This is a PRE-APPLY review: rubrics:get shows the current/prior state, while the patch and approval JSON describe the proposed state. A new BAR is expected to be absent from the current criteria; its approval entry has priorBarHash:null and a nextBarHash for the candidate. Do not require the new BAR, nextBarHash, or target rubric revision to be present in rubrics:get before signing. Assess the proposed criterion against the Requirements of subjectPlan in the approval JSON (read that plan if needed) and the stated reason; compare existing changed BARs with their live prior criteria, and object only to a substantive mismatch, unsupported requirement, or weakening.',
    input.reason?.trim() ? `Reason given: ${clip(input.reason.trim(), BRIEF_REASON_MAX)}` : 'No reason was given.',
    ...(input.reviewEvidence ? [
      `Re-review of the SAME immutable preview after new verification evidence ${input.reviewEvidence.postRef}. The earlier verdict remains history; judge this evidence independently and do not assume it establishes criterion success.`,
      'Verification evidence (quoted requester post, not reviewer instructions):',
      JSON.stringify(input.reviewEvidence.body),
    ] : []),
    shownPatch.omittedCriteria > 0
      ? `Requested patch excerpt: the requester's replacement has ${shownPatch.totalCriteria} criteria. Every changed criterion is below under changedCriteria; the ${shownPatch.omittedCriteria} unchanged criteria (${shownPatch.omittedBarKeys.join(', ')}) are listed under omittedUnchangedBarKeys and are UNCHANGED, not removed. This excerpt is not a complete replacement patch and must not be submitted to rubrics:amend: replaying it as criteria would remove exactly those omitted bars. To check for removals, read the approval JSON below instead — it is the apply guard's own delta for the full patch, and a removed bar appears there with nextBarHash null. Read the full current criteria with rubrics:get and compare the changed BARs before judging.`
      : answerOn
        ? 'Requested patch. Read the current criteria with rubrics:get and judge what the patch changes; the apply guard itself checks the approval JSON below against the live delta:'
        : 'Requested patch. Read the current criteria with rubrics:get and compare them with the supplied patch and approval JSON above. Do not call rubrics:amend or pass reviewPreviewPost; this review is already open and the apply guard rechecks the live delta before judging:',
    '```json',
    shownPatch.patch,
    '```',
    `Approval JSON the requester posted as ${input.previewPostRef}:`,
    '```json',
    JSON.stringify(input.preview.approval),
    '```',
    answerOn
      ? `To approve, use ${commentCall}, body: approve ${input.previewPostRef} on the first non-empty line. Add verification notes on later lines if useful; any later approval pointer must name the same preview.`
      : `To approve, use consult:reply { conversation_id:'<this consult>', kind:'answer', body:'approve ${input.previewPostRef}', evidence:[...] }; the first non-empty body line must be exactly approve ${input.previewPostRef}. You may add verification notes on later lines, but any later approval pointer must name the same preview.`,
    answerOn
      ? `That first non-empty line is the signature: the apply guard takes its author and time from your post. If the change weakens a requirement or you cannot verify it, post the objection with that same ${commentCall} instead. Post once, do not edit files or recruit anyone. After the verdict comment succeeds, call \`session:end { reason: 'BAR amendment review complete' }\` to close this headless one-shot session; do not just finish the turn.`
      : `The first non-empty line is the signature: the apply guard takes its author and time from the post. Once the review is settled, call consult:close { conversation_id:'<this consult>', outcome:'answered', answer:'<concise review conclusion>', evidence:[...] }. consult:reply records the signed post; consult:close records the accepted answer. If the change weakens a requirement or you cannot verify it, reply with the evidence-backed objection and close it as answered; if you cannot answer here, consult:decline.`,
    !answerOn
      ? "If you are the headless one-shot reviewer launched for this consult, after the review settles (consult:reply then consult:close, or consult:decline), call session:end { reason: 'BAR amendment review complete' } to close this session; do not just finish the turn."
      : '',
  ].join('\n');
}

/**
 * WI-10003299: the system principal that launches a fresh reviewer when the
 * router has nobody eligible. A reviewer launched by the REQUESTER would be the
 * requester's descendant and the apply guard would refuse it, so, like
 * ACCEPTANCE_GRADING_SWEEP_ACTOR, the launch is attributed to this principal.
 * It is dedicated (never used to launch implementers), so it has no lineage of
 * its own to the plans it reviews; the screen below still checks that.
 */
export const ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR = 'system:acceptance-bar-amendment-review';

export type FreshAmendmentReviewerResult =
  | {
      state: 'launched';
      launcherId: string;
      taskId: string | null;
      label: string;
      idempotencyKey: string;
      /** True when this preview already had a fresh reviewer: nothing new was launched. */
      deduped: boolean;
      answerOn: FreshReviewerAnswerTarget;
      ownerId?: string;
      nativeRef?: string;
      firstReply?: 'observed' | 'pending' | 'unreadable';
      /** Dead reviewer tasks (ended with no answer) this launch replaced. */
      relaunchedAfter?: string[];
    }
  | {
      state: 'blocked';
      launcherId: string;
      taskId: string | null;
      label: string;
      idempotencyKey: string;
      deduped: boolean;
      answerOn: FreshReviewerAnswerTarget;
      ownerId?: string;
      nativeRef: string;
      reason: 'account-walled' | 'first-turn-rejected' | 'provider-error' | 'reviewer-ended';
      evidence: string;
      /** A replacement is safe only after the rejected task is confirmed terminal. */
      recovery?: { state: 'stopped' | 'unverified'; evidence: string };
      /** Dead reviewer tasks (ended with no answer) this call walked past. */
      relaunchedAfter?: string[];
    }
  | { state: 'not-launched'; reason: string };

/**
 * WI-6554700010010527: launch-agent's idempotencyKey returns the SAME task even
 * after it ended, so a reviewer that died before answering was replayed on every
 * re-preview and no live reviewer could be routed for that post. A deduped task
 * that is terminal with no answer on the preview's thread is re-keyed as
 * `<key>:after:<deadTaskId>`. The chain is deterministic, so repeated dry runs
 * walk the same dead tasks and launch at most one new reviewer per call.
 */
export const MAX_DEAD_REVIEWER_CHAIN = 4;

async function readLedgerTaskState(taskId: string): Promise<TaskState | null> {
  const { getTask } = await import('../task-manager/store');
  return (await getTask(taskId))?.state ?? null;
}

type ResolveSessionStates = typeof import('../agent-tools/coordination/liveness-oracle').resolveSessionStates;

/**
 * A task row can stay `running` after its reviewer session has parked with no
 * independent wake source. Treat that liveness shape as measured only when the
 * shared oracle returns both axes; a failed or partial read must remain unknown.
 */
async function readReviewerLiveness(
  ownerId: string,
  resolveSessionStates?: ResolveSessionStates,
): Promise<Pick<import('../agent-tools/coordination/liveness-oracle').LivenessVerdict, 'sessionState' | 'selfWake'> | null> {
  try {
    const resolve = resolveSessionStates ?? (await import('../agent-tools/coordination/liveness-oracle')).resolveSessionStates;
    const verdict = (await resolve([{ ownerId }], { hydratePerId: true, selfWake: true })).get(ownerId);
    return verdict ? { sessionState: verdict.sessionState, selfWake: verdict.selfWake } : null;
  } catch {
    // Liveness is an enrichment. An unreadable oracle cannot authorize killing
    // or replacing a reviewer that may still be able to answer.
    return null;
  }
}

/**
 * WI-6554700010018125: true only when the reviewer's own native transcript is
 * readable and its turns since the latest submitted prompt end on a synthetic
 * transient provider failure (5xx, "Server error mid-response"). A missing or
 * unreadable transcript stays unknown and never authorizes a replacement.
 */
function reviewerEndedOnProviderError(
  nativeRef: unknown,
  analyze: typeof analyzeClaudeResumeTranscriptFile | undefined,
): boolean {
  if (typeof nativeRef !== 'string' || !nativeRef.endsWith('.jsonl')) return false;
  try {
    return ((analyze ?? analyzeClaudeResumeTranscriptFile)(nativeRef)?.trailingProviderErrorTurns ?? 0) > 0;
  } catch {
    return false;
  }
}

/** True when anyone (or `authorId`, when known) posted on the preview post's
 * thread after it: the reviewer's verdict, or a reply worth not stomping on. */
export async function previewThreadHasLaterPost(args: {
  workspaceId: string;
  previewPostRef: string;
  authorId?: string;
  /** Only an answer newer than this validated evidence settles its re-review. */
  afterPostRef?: string;
}, providedSql?: import('postgres').Sql): Promise<boolean> {
  const postId = PREVIEW_POST_REF.test(args.previewPostRef) ? args.previewPostRef.slice('thread-post:'.length) : null;
  if (!postId) return false;
  const sql = providedSql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  const afterPostId = args.afterPostRef?.slice('thread-post:'.length) ?? postId;
  const rows = await sql<Array<{ id: string }>>`
    SELECT p.id::text AS id
      FROM harness_shared.coord_thread_posts pv
      JOIN harness_shared.coord_thread_posts p
        ON p.workspace_id = pv.workspace_id AND p.thread_id = pv.thread_id AND p.id > pv.id
     WHERE pv.workspace_id = ${args.workspaceId}
       AND pv.id = ${postId}::bigint
       AND p.id > ${afterPostId}::bigint
       AND (${args.authorId ?? null}::text IS NULL OR p.author_id = ${args.authorId ?? null})
     LIMIT 1`;
  return rows.length > 0;
}

/** Evidence must be the applier's later local post on this exact preview thread. */
export async function resolveAmendmentReviewEvidence(args: {
  workspaceId: string;
  previewPostRef: string;
  evidencePostRef: string;
  applierId: string;
}, providedSql?: import('postgres').Sql): Promise<{ postRef: string; body: string }> {
  if (!PREVIEW_POST_REF.test(args.evidencePostRef)) {
    throw new Error('invalid_args: reviewEvidencePost must be thread-post:<id>');
  }
  const sql = providedSql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
  const [row] = await sql<Array<{ body: string }>>`
    SELECT p.body
      FROM harness_shared.coord_thread_posts pv
      JOIN harness_shared.coord_thread_posts p
        ON p.workspace_id = pv.workspace_id AND p.thread_id = pv.thread_id AND p.id > pv.id
     WHERE pv.workspace_id = ${args.workspaceId}
       AND pv.id = ${args.previewPostRef.slice('thread-post:'.length)}::bigint
       AND p.id = ${args.evidencePostRef.slice('thread-post:'.length)}::bigint
       AND p.author_id = ${args.applierId}
       AND p.origin = 'local'
     LIMIT 1`;
  if (!row?.body?.trim()) {
    throw new Error('invalid_args: reviewEvidencePost must be your non-empty later local evidence post on the retained preview thread');
  }
  return { postRef: args.evidencePostRef, body: row.body };
}

export interface FreshAmendmentReviewerInput extends AmendmentReviewBriefInput {
  applierId: string;
  workspaceId: string;
  /** The requesting tool call's context; overridden with the system principal. */
  launchCtx?: unknown;
  reviewerModel?: ConsultReviewerModel;
}

/** Choose the first permitted expert rank with a serviceable account, including
 * unsteered pools. `account:'auto'` chooses an account, not a backend: leaving
 * the backend implicit can strand review on Claude while Codex is available. */
export function selectFreshReviewerModelForAccountSteer(args: {
  forcedAccounts: readonly string[];
  excludeAccounts: readonly string[];
  accounts: readonly { id: string; provider?: string; available: boolean }[];
  ranks: readonly AllowedExpertModel[];
}): ConsultReviewerModel {
  const forced = new Set(args.forcedAccounts);
  const excluded = new Set(args.excludeAccounts);
  const providers = new Set(args.accounts
    .filter((account) => account.available
      && (forced.size === 0 || forced.has(account.id))
      && !excluded.has(account.id))
    .map((account) => account.provider ?? 'claude'));
  const rank = args.ranks.find((candidate) => providers.has(candidate.agent));
  if (!rank) {
    throw new Error('no expert model has an available account permitted by the workspace account steer');
  }
  return { agent: rank.agent, model: rank.model };
}

async function resolveFreshReviewerModelForAccountSteer(workspaceId: string): Promise<ConsultReviewerModel> {
  const [{ getAccountOverride }, { loadAccountPool }, { accountProvider, isAvailable },
    { readConsultExpertRoutingSettings, bindConsultExpertRoutingSettings }] = await Promise.all([
    import('../deployment/account-session-override'),
    import('../deployment/account-pool-store'),
    import('../deployment/account-pool'),
    import('./expert-routing-settings'),
  ]);
  const override = await getAccountOverride(workspaceId);
  const [pool, settings] = await Promise.all([
    loadAccountPool(workspaceId),
    readConsultExpertRoutingSettings(workspaceId),
  ]);
  const ranks = await resolveExpertModelAllowlist(workspaceId, bindConsultExpertRoutingSettings(settings));
  return selectFreshReviewerModelForAccountSteer({
    ...override,
    accounts: pool.accounts.map((account) => ({
      id: account.id,
      provider: accountProvider(account),
      available: isAvailable(account, Date.now()),
    })),
    ranks,
  });
}

/** The work-item whose thread carries the preview post, with its harness. */
async function resolvePreviewPostWorkItem(args: {
  workspaceId: string;
  previewPostRef: string;
}): Promise<FreshReviewerAnswerTarget | null> {
  const postId = PREVIEW_POST_REF.test(args.previewPostRef) ? args.previewPostRef.slice('thread-post:'.length) : null;
  if (!postId) return null;
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;
  const [row] = await sql<Array<{ parent_ref: string | null; harness_slug: string | null }>>`
    SELECT w.feature_id AS parent_ref, w.harness_slug
      FROM harness_shared.coord_thread_posts p
      JOIN harness_shared.coord_threads t
        ON t.workspace_id = p.workspace_id AND t.thread_id = p.thread_id
      JOIN harness_shared.work_items w
        ON w.workspace_id = p.workspace_id
       AND (
         (t.parent_kind = 'feature' AND w.item_kind IN ('feature', 'chunk')
           AND t.parent_ref = w.harness_slug || '#' || w.feature_id)
         OR (t.parent_kind = 'issue' AND w.item_kind IN ('bug', 'change', 'task')
           AND t.parent_ref = w.feature_id)
       )
     WHERE p.workspace_id = ${args.workspaceId}
       AND p.id = ${postId}::bigint
       AND p.origin = 'local'
     LIMIT 1`;
  return row?.parent_ref ? { workItemId: row.parent_ref, harness: row.harness_slug?.trim() || null } : null;
}

function freshReviewerLaunchCtx(launchCtx: unknown, workspaceId: string, harness: string | null): unknown {
  return {
    ...(launchCtx && typeof launchCtx === 'object' ? (launchCtx as Record<string, unknown>) : {}),
    workspaceId,
    ...(harness ? { harnessSlug: harness } : {}),
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: { kind: 'system', slug: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR, workspaceId },
    ownerId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
    ownerLabel: 'acceptance-BAR amendment review',
    userId: null,
  };
}

type LaunchHandler = (args: never, ctx: never) => Promise<unknown>;

/**
 * Launch one fresh outside-lineage reviewer for a preview the router could not
 * staff. Refuses (never launches) when the preview is not on a work-item thread
 * or the launcher principal fails the check-approver screen. Idempotent per
 * (workspace, rubric, preview post, approval): a repeat returns the same launch.
 */
export async function launchFreshAmendmentReviewer(
  input: FreshAmendmentReviewerInput,
  deps: {
    resolveAnswerTarget?: typeof resolvePreviewPostWorkItem;
    resolveScreen?: (args: { rubricId: string; applierId: string }) => Promise<{ check: AmendmentReviewerScreen }>;
    launch?: LaunchHandler;
    assertAllowed?: typeof assertReviewerModelAllowed;
    resolveSteeredModel?: typeof resolveFreshReviewerModelForAccountSteer;
    analyzeTranscript?: typeof analyzeClaudeResumeTranscriptFile;
    nowMs?: () => number;
    sleepMs?: (ms: number) => Promise<void>;
    readTaskState?: (taskId: string) => Promise<TaskState | null>;
    resolveSessionStates?: ResolveSessionStates;
    hasReviewerAnswer?: typeof previewThreadHasLaterPost;
    stopFailedLaunch?: typeof defaultStopFailedLaunch;
  } = {},
): Promise<FreshAmendmentReviewerResult> {
  const previewPostRef = input.previewPostRef.trim();
  const answerOn = await (deps.resolveAnswerTarget ?? resolvePreviewPostWorkItem)({
    workspaceId: input.workspaceId,
    previewPostRef,
  });
  if (!answerOn) {
    return {
      state: 'not-launched',
      reason: `${previewPostRef} is not a post on a work-item thread, so a fresh reviewer would have nowhere to answer. Post the preview with work_items:comment.`,
    };
  }
  // Hoisted helpers below do not see the narrowing above; bind it non-null.
  const target: FreshReviewerAnswerTarget = answerOn;
  const rubricId = input.rubricRef.trim().replace(/^plan:/i, '').trim();
  if (input.reviewerModel) await (deps.assertAllowed ?? assertReviewerModelAllowed)(input.workspaceId, input.reviewerModel);
  const reviewerModel = input.reviewerModel ?? await (deps.resolveSteeredModel ?? resolveFreshReviewerModelForAccountSteer)(input.workspaceId);
  const resolveScreen =
    deps.resolveScreen ?? (async (args) => (await import('../rubrics')).resolveAcceptanceBarApproverScreen(args));
  const screen = await resolveScreen({ rubricId, applierId: input.applierId });
  const launcherVerdict = await screen.check(ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR);
  if (launcherVerdict.eligible !== true) {
    return {
      state: 'not-launched',
      reason: `the fresh-reviewer launcher ${ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR} is ${launcherVerdict.reason}, so a reviewer it launched would be refused`,
    };
  }
  const identity = createHash('sha256')
    .update([input.workspaceId, rubricId, previewPostRef, JSON.stringify(input.preview.approval),
      ...(reviewerModel ? [JSON.stringify(reviewerModel)] : [])].join('\0'))
    .digest('hex');
  const idempotencyKey = `acceptance-bar-amendment-review:${identity.slice(0, 32)}`;
  const label = `bar-amendment-review:${identity.slice(0, 12)}`;
  const launch: LaunchHandler =
    deps.launch ?? ((await import('../agent-tools/capability/launch-agent')).default.handler as unknown as LaunchHandler);
  const readTaskState = deps.readTaskState ?? readLedgerTaskState;
  const hasReviewerAnswer = deps.hasReviewerAnswer ?? previewThreadHasLaterPost;
  const relaunchedAfter: string[] = [];
  let attemptKey = idempotencyKey;
  let attemptLabel = label;
  let result: LaunchResult;
  for (;;) {
    result = await launchOnce(attemptKey, attemptLabel);
    if (result?.isError || result?.data?.deduped !== true) break;
    const deadTask = result.data?.launch?.tasks?.[0];
    const deadTaskId = typeof deadTask?.taskId === 'string' ? deadTask.taskId : null;
    if (!deadTaskId) break;
    const authorId = typeof deadTask?.ownerId === 'string' ? deadTask.ownerId : undefined;
    const state = await readTaskState(deadTaskId);
    const liveness = state && !isTerminalState(state) && authorId
      ? await readReviewerLiveness(authorId, deps.resolveSessionStates)
      : null;
    const stranded = liveness?.sessionState === 'parked' && liveness.selfWake === 'none';
    // WI-6554700010018125: a reviewer whose latest turn ended on a transient
    // provider failure has parked waiting for input. A wake source alone does
    // not make it answer, so replace it exactly like a stranded one.
    const providerErrored = state !== null && !isTerminalState(state) && !stranded
      && reviewerEndedOnProviderError(deadTask?.kickoffProof?.nativeRef, deps.analyzeTranscript);
    if (!state || (!isTerminalState(state) && !stranded && !providerErrored)) break;
    // A missing reviewer identity cannot establish custody of a re-review verdict.
    if (input.reviewEvidence && !authorId) break;
    if (await hasReviewerAnswer({ workspaceId: input.workspaceId, previewPostRef,
      ...(authorId ? { authorId } : {}),
      ...(input.reviewEvidence ? { afterPostRef: input.reviewEvidence.postRef } : {}),
    })) break;
    if (stranded || providerErrored) {
      let stopped: string;
      try {
        stopped = await (deps.stopFailedLaunch ?? defaultStopFailedLaunch)(deadTaskId,
          authorId ? { answeringOwnerId: authorId } : undefined);
      } catch (error) {
        stopped = `stop threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      const stoppedState = await readTaskState(deadTaskId);
      if (!stoppedState || !isTerminalState(stoppedState)) {
        return {
          state: 'not-launched',
          reason: `deduped reviewer task ${deadTaskId} is ${providerErrored ? 'parked after a provider error' : 'parked without a self-wake source'} and could not be safely replaced: ${stopped}`,
        };
      }
    }
    relaunchedAfter.push(deadTaskId);
    if (relaunchedAfter.length >= MAX_DEAD_REVIEWER_CHAIN) {
      return {
        state: 'blocked',
        launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
        taskId: deadTaskId,
        label: attemptLabel,
        idempotencyKey: attemptKey,
        deduped: true,
        answerOn,
        ...(authorId ? { ownerId: authorId } : {}),
        nativeRef: typeof deadTask?.kickoffProof?.nativeRef === 'string' ? deadTask.kickoffProof.nativeRef : 'unknown',
        reason: 'reviewer-ended',
        evidence: `${relaunchedAfter.length} reviewer(s) for this preview ended without answering (${relaunchedAfter.join(', ')}); ` +
          'reviewer launches are failing, so read their task logs (processes:list { taskId }) before re-running',
        relaunchedAfter,
      };
    }
    attemptKey = input.reviewEvidence
      ? `${idempotencyKey}:evidence:${input.reviewEvidence.postRef}:after:${deadTaskId}`
      : `${idempotencyKey}:after:${deadTaskId}`;
    attemptLabel = `${label}.r${relaunchedAfter.length}`;
  }
  return finishFreshReviewerLaunch(result, attemptKey, attemptLabel);

  async function launchOnce(key: string, attemptLabelArg: string): Promise<LaunchResult> {
    return (await launch(
    {
      brief: buildAmendmentReviewBrief({ ...input, previewPostRef }, target),
      ...(target.harness ? { harness: target.harness } : {}),
      headless: true,
      // Never the requester's fleet, and routed through the inference gateway
      // so one walled credential cannot strand an unattended reviewer
      // (the same two fences the acceptance grader's fresh judge carries).
      independent: true,
      account: 'auto',
      count: 1,
      // role:'judge' is harness-scoped; launch-agent refuses it without one
      // (EI-23414612968722239), so it rides only with a resolved harness.
      ...(target.harness || reviewerModel ? { members: [{
        ...(target.harness ? { role: 'judge' } : {}),
        ...(reviewerModel ?? {}),
      }] } : {}),
      label: attemptLabelArg,
      idempotencyKey: key,
    } as never,
    freshReviewerLaunchCtx(input.launchCtx, input.workspaceId, target.harness) as never,
    )) as LaunchResult;
  }

  async function finishFreshReviewerLaunch(
    result: LaunchResult,
    effectiveKey: string,
    effectiveLabel: string,
  ): Promise<FreshAmendmentReviewerResult> {
  if (result?.isError) {
    const text = (result.content ?? []).map((c) => c.text ?? '').join(' ').trim();
    return { state: 'not-launched', reason: `launch refused: ${clip(text || 'no detail', 400)}` };
  }
  const task = result?.data?.launch?.tasks?.[0];
  const taskId = task?.taskId;
  const ownerId = typeof task?.ownerId === 'string' ? task.ownerId : undefined;
  const nativeRef = typeof task?.kickoffProof?.nativeRef === 'string' ? task.kickoffProof.nativeRef : undefined;
  const retained = {
    launcherId: ACCEPTANCE_BAR_AMENDMENT_REVIEW_ACTOR,
    taskId: typeof taskId === 'string' ? taskId : null,
    label: effectiveLabel,
    idempotencyKey: effectiveKey,
    deduped: result?.data?.deduped === true,
    answerOn: target,
    ...(ownerId ? { ownerId } : {}),
    ...(nativeRef ? { nativeRef } : {}),
    ...(relaunchedAfter.length > 0 ? { relaunchedAfter: [...relaunchedAfter] } : {}),
  };
  // A submitted kickoff is not a successful provider reply. Reuse the consult
  // transcript analyzer: synthetic billing/context/tool errors count, quoted
  // error prose and copied history do not. Re-check deduped launches too, so a
  // delayed rejection cannot remain "launched" forever on repeated dry runs.
  if (nativeRef?.endsWith('.jsonl')) {
    const analyze = deps.analyzeTranscript ?? analyzeClaudeResumeTranscriptFile;
    const now = deps.nowMs ?? Date.now;
    const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + 20_000;
    for (let poll = 0; ; poll += 1) {
      let analysis: ReturnType<typeof analyzeClaudeResumeTranscriptFile> = null;
      try { analysis = analyze(nativeRef); } catch { /* unreadable is not a rejection */ }
      if (!analysis) return { state: 'launched', ...retained, firstReply: 'unreadable' };
      if (analysis.assistantTurnsSinceLastPrompt > 0) {
        const accountWall = (analysis.trailingAccountWallTurns ?? 0) > 0;
        const providerError = !accountWall && (analysis.trailingProviderErrorTurns ?? 0) > 0;
        const evidence = accountWall ? analysis.lastAccountWallEvidence
          : providerError ? analysis.lastProviderErrorEvidence
          : (analysis.trailingContextLimitTurns ?? 0) > 0 ? analysis.lastContextLimitEvidence
          : analysis.trailingMissingToolReferenceTurns > 0 ? analysis.lastMissingToolReferenceEvidence : null;
        if (accountWall || evidence) {
          // Reuse consult's exact-task containment, never let the implementer
          // resume/fork this reviewer and become its permanent launch ancestor.
          // A real answer wins a race with containment; unreadable custody fails
          // closed and cannot authorize another reviewer.
          let recovery: { state: 'stopped' | 'unverified'; evidence: string };
          try {
            if (await hasReviewerAnswer({ workspaceId: input.workspaceId, previewPostRef,
              ...(ownerId ? { authorId: ownerId } : {}),
              ...(input.reviewEvidence ? { afterPostRef: input.reviewEvidence.postRef } : {}) })) {
              return { state: 'launched', ...retained, firstReply: 'observed' };
            }
            const stopped = await (deps.stopFailedLaunch ?? defaultStopFailedLaunch)(retained.taskId,
              ownerId ? { answeringOwnerId: ownerId } : undefined);
            const state = retained.taskId ? await readTaskState(retained.taskId) : null;
            recovery = { state: state && isTerminalState(state) ? 'stopped' : 'unverified', evidence: stopped };
          } catch (error) {
            recovery = { state: 'unverified', evidence: `reviewer containment unreadable: ${String(error)}` };
          }
          return { state: 'blocked', ...retained, nativeRef,
            reason: accountWall ? 'account-walled' : providerError ? 'provider-error' : 'first-turn-rejected',
            evidence: evidence ?? 'provider billing rejection', recovery };
        }
        return { state: 'launched', ...retained, firstReply: 'observed' };
      }
      const remainingMs = deadline - now();
      // Independent clock and read-count bounds; no reply is pending, never
      // proof of death. Keep its task/identity for exact-session recovery.
      if (poll >= 40 || remainingMs <= 0) return { state: 'launched', ...retained, firstReply: 'pending' };
      await sleep(Math.min(500, remainingMs));
    }
  }
  return { state: 'launched', ...retained };
  }
}

type LaunchResult = {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  data?: { deduped?: boolean; launch?: { tasks?: Array<{
    taskId?: unknown;
    ownerId?: unknown;
    kickoffProof?: { nativeRef?: unknown };
  }> } };
};

/**
 * The preview post must carry the approval the CURRENT delta produces. This is
 * the apply guard's own resolver, so a post it would later refuse (unparseable,
 * other rubric, uncovered or stale BAR hashes) refuses the review up front
 * instead of spending a routed reviewer on it.
 */
async function verifyPreviewPostWithApplyResolver(args: {
  workspaceId: string;
  previewPostRef: string;
  approval: AcceptanceBarAmendmentPreview['approval'];
}): Promise<void> {
  const [{ getOrgPg }, { resolveAcceptanceBarApproval }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../acceptance-bar-amendment'),
  ]);
  await resolveAcceptanceBarApproval(getOrgPg().sql as never, {
    workspaceId: args.workspaceId,
    approvalRef: args.previewPostRef,
    expected: args.approval,
  });
}

export interface OpenAmendmentReviewInput extends AmendmentReviewBriefInput {
  preview: Pick<AcceptanceBarAmendmentPreview, 'approval' | 'changes' | 'approvalRequired'>;
  identity: AgentIdentity;
  workspaceId: string;
  harness?: string;
  /** The requesting tool call's context, reused (as the system principal) for a fresh-reviewer launch. */
  launchCtx?: unknown;
  reviewerModel?: ConsultReviewerModel;
  /** Explicit re-review request backed by a later immutable evidence post. */
  reviewEvidencePost?: string;
}

export type AmendmentReviewRequestResult =
  | { state: 'not-required'; next: string }
  | (AmendmentReviewRouteResult & {
      previewPostRef: string;
      next: string;
      /** WI-10003299: set when the router staffed nobody and a fresh reviewer was attempted. */
      freshReviewer?: FreshAmendmentReviewerResult;
    });

/**
 * rubrics:amend's review opener (P-006). A preview that needs no approval
 * routes nothing; otherwise the preview post is checked, then the routed,
 * lineage-screened review is opened for it.
 */
export async function openAcceptanceBarAmendmentReview(
  input: OpenAmendmentReviewInput,
  deps: {
    verifyPreviewPost?: typeof verifyPreviewPostWithApplyResolver;
    route?: typeof routeAcceptanceBarAmendmentReview;
    launchFresh?: typeof launchFreshAmendmentReviewer;
    resolveEvidence?: typeof resolveAmendmentReviewEvidence;
    hasLaterPost?: typeof previewThreadHasLaterPost;
  } = {},
): Promise<AmendmentReviewRequestResult> {
  if (!input.preview.approvalRequired) {
    return { state: 'not-required', next: 'No BAR meaning changes: apply without approvalRef.' };
  }
  const previewPostRef = input.previewPostRef.trim();
  if (!PREVIEW_POST_REF.test(previewPostRef)) {
    throw new Error(`invalid_args: reviewPreviewPost must be thread-post:<id>, got '${input.previewPostRef}'`);
  }
  try {
    await (deps.verifyPreviewPost ?? verifyPreviewPostWithApplyResolver)({
      workspaceId: input.workspaceId,
      previewPostRef,
      approval: input.preview.approval,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `acceptance_bar_amendment_review_preview_invalid: ${previewPostRef} does not carry this preview's approval (${message}). ` +
        'Post the current preview.approval JSON once with work_items:comment and pass that post.',
    );
  }
  const reviewEvidence = input.reviewEvidencePost
    ? await (deps.resolveEvidence ?? resolveAmendmentReviewEvidence)({
      workspaceId: input.workspaceId, previewPostRef,
      evidencePostRef: input.reviewEvidencePost.trim(), applierId: input.identity.ownerId,
    }) : undefined;
  const routed = await (deps.route ?? routeAcceptanceBarAmendmentReview)({
    rubricRef: input.rubricRef,
    brief: buildAmendmentReviewBrief({ ...input, previewPostRef, reviewEvidence }),
    identity: input.identity,
    workspaceId: input.workspaceId,
    ...(input.harness ? { harness: input.harness } : {}),
    ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
  });
  if (routed.state === 'routed') {
    const next =
      `events:await { event:'consult:reply:${routed.conversationId}' }. When the routed reviewer answers \`approve ${previewPostRef}\`, ` +
      `apply with the same patch plus approvalRef:'thread-post:<that answer post id>' (conversations:get { id:'${routed.conversationId}' } lists post ids).`;
    return { ...routed, previewPostRef, next };
  }
  // A preview with an existing later reply already has review activity. A
  // fresh reviewer must not be recruited for the same unchanged preview: an
  // objection (or any other later reply worth preserving) requires explicit
  // new requester evidence via reviewEvidencePost before re-review.
  if (!reviewEvidence && await (deps.hasLaterPost ?? previewThreadHasLaterPost)({
    workspaceId: input.workspaceId,
    previewPostRef,
  })) {
    const reason = `preview ${previewPostRef} already has a later thread reply; post new verification evidence on that thread and pass reviewEvidencePost to request a re-review`;
    return {
      ...routed,
      previewPostRef,
      next: `No reviewer was recruited because ${reason}. Do not post a duplicate preview.`,
      freshReviewer: { state: 'not-launched', reason },
    };
  }
  // WI-10003299: nobody eligible is not a reason to stop. Launch one fresh
  // outside-lineage reviewer instead of telling the requester to wait for one.
  let freshReviewer: FreshAmendmentReviewerResult;
  try {
    freshReviewer = await (deps.launchFresh ?? launchFreshAmendmentReviewer)({
      rubricRef: input.rubricRef,
      previewPostRef,
      preview: input.preview,
      ...(input.reason ? { reason: input.reason } : {}),
      patch: input.patch,
      ...(reviewEvidence ? { reviewEvidence } : {}),
      applierId: input.identity.ownerId,
      workspaceId: input.workspaceId,
      ...(input.launchCtx !== undefined ? { launchCtx: input.launchCtx } : {}),
      ...(input.reviewerModel ? { reviewerModel: input.reviewerModel } : {}),
    });
  } catch (error) {
    freshReviewer = {
      state: 'not-launched',
      reason: `fresh reviewer launch failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const next =
    freshReviewer.state === 'launched'
      ? `No eligible reviewer could be routed, so ${freshReviewer.launcherId} ${freshReviewer.deduped ? 'already launched' : 'launched'} a fresh outside-lineage reviewer ` +
        `(label ${freshReviewer.label}${freshReviewer.taskId ? `, task ${freshReviewer.taskId}` : ''}). It answers with one work_items:comment on ${freshReviewer.answerOn.workItemId}: ` +
        `\`approve ${previewPostRef}\` or an objection. Read it with work_items:get { id:'${freshReviewer.answerOn.workItemId}', threadLimit:5 }, then apply with the same patch plus approvalRef:'thread-post:<that post id>'. ` +
        (freshReviewer.relaunchedAfter?.length
          ? `Earlier reviewer task(s) ${freshReviewer.relaunchedAfter.join(', ')} ended without answering${reviewEvidence ? ' the new evidence' : ''}, so this one replaces them. `
          : '') +
        'Re-running this dry run reuses a live reviewer, and relaunches one if the last ended, or parked after a provider error, without answering. If no answer arrives, re-run it rather than waiting. To re-review after an objection, post new verification evidence on the same thread and pass reviewEvidencePost with the retained reviewPreviewPost; do not post a duplicate preview.'
      : freshReviewer.state === 'blocked' && freshReviewer.reason === 'reviewer-ended'
        ? `Every fresh reviewer launched for ${previewPostRef} ended without answering: ${freshReviewer.evidence}. ` +
          'No decision was obtained. Fix the launch failure those task logs show before re-running this dry run; posting another preview only adds another dying reviewer.'
      : freshReviewer.state === 'blocked'
        ? `The retained outside-lineage reviewer is blocked (${freshReviewer.reason}): ${freshReviewer.evidence}. ` +
          `Task ${freshReviewer.taskId ?? 'unknown'}, transcript ${freshReviewer.nativeRef}. ` +
          (freshReviewer.recovery?.state === 'stopped'
            ? `The rejected task is confirmed terminal (${freshReviewer.recovery.evidence}). Repeat the same rubrics:amend dry run with reviewPreviewPost:'${previewPostRef}' and a permitted reviewerModel with available capacity; the screened system recruiter owns replacement. `
            : `Containment is unverified (${freshReviewer.recovery?.evidence ?? 'no terminal task proof'}). Resolve the exact rejected task through the review recruiter before repeating this dry run. `) +
          'Do not resume or fork the reviewer yourself: that records your identity as its launcher and can invalidate independence. ' +
          'No decision was obtained. Do not wait for an approval from this rejected turn, countersign it, or post another preview to duplicate the reviewer.'
        : `No eligible outside-lineage reviewer could be routed, and no fresh reviewer was launched: ${freshReviewer.reason}. The reason and screenedOut say why routing failed.`;
  return { ...routed, previewPostRef, next, freshReviewer };
}
