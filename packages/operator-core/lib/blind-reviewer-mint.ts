/**
 * Mint the blind gap reviewer (verification-system-improvements-2026-10-10 D-006 (2),
 * D-041; WI-6554700010008492).
 *
 * The P-006 door (blind-review-gate.ts, plans:blind-review) records a reviewer's gaps and
 * refuses a reviewer in the author's lineage. This module supplies the reviewer itself: a
 * FRESH headless session, launched under a system actor (so the door's lineage check
 * accepts its post), whose MCP tool surface is confined BEFORE its process starts.
 *
 * The confinement is an exact CEILING (denyOutside), not a slug-keyed deny list. Plan text
 * reaches a session through many families besides plans:* — rubrics, scorecards, search,
 * sessions, memory, work items derived from plan items, coord plan events — so a deny list
 * is only as good as its author's memory. A ceiling names what the reviewer needs and
 * refuses everything else, including tools registered after this was written.
 * denyAmbientContext suppresses hook/recall injections, which also carry plan text.
 *
 * Out of scope (D-041 (4)): reads that are not MCP calls (native Read, or capability:bash
 * `cat` of a plan file). The ceiling closes the MCP half only.
 */
import { createHash } from 'node:crypto';
import {
  SCRATCH_PLAN_TOOLS,
  validProductReadBoundary,
  validScratchPlanBoundary,
  type ProductReadBoundary,
  type ScratchPlanBoundary,
  type SessionToolConfinement,
} from './capability-envelope/session-confinement';
import { blindReviewScratchPrefix } from './blind-review-scratch-plans';
import { BLIND_REVIEW_TOOL, loadBlindReviewBrief } from './blind-review-gate';
import { briefTurnCount, type BlindReviewBrief } from './blind-review-brief';
import {
  acquireBlindReviewSessionResume,
  createBlindReviewSessionBinding,
  releaseBlindReviewSessionResume,
  BLIND_GAP_REVIEW_ACTOR,
  INTERNAL_BLIND_REVIEW_RESUME,
  type BlindReviewResumePermit,
  type BlindReviewSessionBinding,
} from './blind-review-session-bindings';

export { BLIND_GAP_REVIEW_ACTOR } from './blind-review-session-bindings';

/**
 * Account the reviewer launches on: the gateway pool, like the acceptance grader and the
 * grading audit (GRADING_AUDIT_ACCOUNT). Omitting it falls back to launch-agent's
 * 'default' — the box's own system login — so one revoked or rate-limited login killed
 * every reviewer on its first turn while gateway launches kept working (WI-6554700010008650).
 */
export const BLIND_GAP_REVIEW_ACCOUNT = 'auto' as const;

// The backend ladder lives in a dependency-free leaf so the session binding and runtime
// custody (which this module's own imports reach) can check membership without a cycle.
import { BLIND_REVIEWER_BACKENDS } from './blind-reviewer-backends';
export { BLIND_REVIEWER_BACKENDS };
export type { BlindReviewerBackend } from './blind-reviewer-backends';

function receiptRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Does a launch-agent receipt PROVE no process started? `isError` alone never does: a
 * launcher can fail after spawning. Only an explicit pre-spawn failure with zero processes
 * (launch-agent's `err()`), or a non-deduped `opened: 0` receipt that is not partial and has
 * no tasks, proves it. The backend ladder falls through only on this proof, so it can never
 * start a second reviewer beside a live first one. A pre-spawn refusal also leaves (or
 * releases) the launch idempotency key, so the next rung may reuse it.
 */
export function launchProvablyNotStarted(value: unknown): boolean {
  const env = receiptRecord(value);
  const data = receiptRecord(env?.data) ?? receiptRecord(env?.structuredContent);
  const failure = receiptRecord(data?.launchFailure);
  if (failure?.stage === 'pre-spawn' && failure.processesOpened === 0) return true;
  const launch = receiptRecord(data?.launch) ?? receiptRecord(env?.launch) ?? env;
  return !!launch && launch.mode !== 'deduped' && launch.opened === 0 && launch.partial === false
    && Array.isArray(launch.tasks) && launch.tasks.length === 0;
}

export type BlindReviewLaunchReceipt =
  | { kind: 'not-started' }
  | { kind: 'native'; ownerId: string; advSessionId: number; sessionId: string | null }
  | { kind: 'uncertain' };

/** Classify the launch from evidence; an MCP isError bit alone says nothing about spawn. */
export function blindReviewLaunchReceipt(value: unknown): BlindReviewLaunchReceipt {
  if (launchProvablyNotStarted(value)) return { kind: 'not-started' };
  const env = receiptRecord(value);
  const data = receiptRecord(env?.data) ?? receiptRecord(env?.structuredContent);
  const launch = receiptRecord(data?.launch) ?? receiptRecord(env?.launch) ?? env;
  if (!launch || launch.mode === 'deduped' || launch.opened !== 1 ||
      !Array.isArray(launch.ownerIds) || launch.ownerIds.length !== 1) return { kind: 'uncertain' };
  const sessions = receiptRecord(launch.freshVerdict)?.sessions;
  if (!Array.isArray(sessions) || sessions.length !== 1) return { kind: 'uncertain' };
  const session = receiptRecord(sessions[0]);
  const ownerId = launch.ownerIds[0];
  const advSessionId = Number(session?.advSessionId);
  if (typeof ownerId !== 'string' || session?.ownerId !== ownerId ||
      !Number.isSafeInteger(advSessionId) || advSessionId <= 0 ||
      session?.sessionId != null && typeof session.sessionId !== 'string') return { kind: 'uncertain' };
  const sessionId = typeof session.sessionId === 'string' && session.sessionId.trim() ? session.sessionId : null;
  return { kind: 'native', ownerId, advSessionId, sessionId };
}

function blindReviewMintIdempotencyKey(input: {
  workspaceId: string; harnessSlug: string; planSlug: string; activationAuditSeq: number;
}): string {
  const scope = JSON.stringify([input.workspaceId, input.harnessSlug, input.planSlug, input.activationAuditSeq]);
  return `blind-review-mint:${createHash('sha256').update(scope).digest('hex')}`;
}

/**
 * Everything a blind reviewer may call. Each entry carries why it is here; nothing in this
 * list returns plan artifacts.
 */
export const BLIND_REVIEWER_TOOL_CEILING: readonly string[] = Object.freeze([
  // Identity: the reviewer can confirm who it is.
  'coord:whoami',
  // Lifecycle: close only this session through the existing host guards. This
  // returns no plan material and cannot select or terminate another reviewer.
  'session:end',
  // Deferred-tool access on a trimmed surface. tools:invoke re-checks the INNER name at
  // the dispatch seat, so it cannot reach a tool outside this ceiling.
  'tools:find',
  'tools:invoke',
  // The door: op 'brief' (owner turns only) and op 'post' (the gaps).
  BLIND_REVIEW_TOOL,
  // Running the product. A psu session's native Bash has no network, so the reviewer
  // drives the running build through these.
  'capability:bash',
  'capability:bash_output',
  'dev:service_health',
]);

export type BlindReviewerProductReads = {
  docsHarness?: string;
  docsSlugs?: string[];
  testFiles?: string[];
};

export function blindReviewerConfinement(slug: string, productReads?: ProductReadBoundary,
  scratchPlans?: ScratchPlanBoundary): SessionToolConfinement {
  return Object.freeze({
    denyTools: Object.freeze([] as string[]),
    denyOutside: productReads || scratchPlans ? Object.freeze([...BLIND_REVIEWER_TOOL_CEILING,
      ...(productReads?.docsSlugs.length ? ['docs:get'] : []),
      ...(productReads?.testFiles.length ? ['testing:runs', 'testing:run', 'testing:run-status'] : []),
      // Admitted only together with denyPlansOutside, which narrows each verb to the
      // reviewer's own scratch slugs (D-050). Without it they stay outside the ceiling.
      ...(scratchPlans ? SCRATCH_PLAN_TOOLS : []),
    ]) : BLIND_REVIEWER_TOOL_CEILING,
    ...(productReads ? { denyProductReadsOutside: Object.freeze({ ...productReads,
      docsSlugs: Object.freeze([...productReads.docsSlugs]), testFiles: Object.freeze([...productReads.testFiles]),
    }) } : {}),
    ...(scratchPlans ? { denyPlansOutside: Object.freeze({ ...scratchPlans }) } : {}),
    denyAmbientContext: true as const,
    imposedBy: BLIND_GAP_REVIEW_ACTOR,
    reason:
      `you are the blind gap reviewer for ${slug}: judge the product against the owner's ` +
      `words only, without reading the plan, its rubric or its evidence (D-006)`,
  });
}

/**
 * Registered tools a howToRun names that the reviewer's ceiling refuses (EI-27120299877087815).
 * A reviewer told to call one spends its review on capability_denied and posts inconclusive
 * (#109; #53 recorded the same setup error). Only names in the live catalog count, so event
 * keys such as work-item:done:<id> pass. Same token grammar as tools:find's exactToolNamesInQuery.
 */
export function howToRunToolsOutsideCeiling(howToRun: string | null | undefined,
  confinement: SessionToolConfinement, knownTools: ReadonlySet<string>): string[] {
  const text = howToRun?.trim();
  if (!text || !confinement.denyOutside) return [];
  const admitted = new Set(confinement.denyOutside);
  const refused = new Set<string>();
  for (const match of text.matchAll(/(?:^|[^a-z0-9_.-])([a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*)(?=$|[^a-z0-9_-])/gi)) {
    const name = match[1].toLowerCase();
    if (knownTools.has(name) && !admitted.has(name)) refused.add(name);
  }
  return [...refused].sort();
}

export function howToRunOutsideCeilingMessage(refused: readonly string[], confinement: SessionToolConfinement): string {
  return `howToRun names ${refused.join(', ')}, which this reviewer's tool ceiling refuses; the reviewer ` +
    'would spend its review on capability_denied. Remove every such name, including from "do not call" ' +
    `clauses, and describe the work in terms of the admitted tools: ${[...(confinement.denyOutside ?? [])].join(', ')}.`;
}

/** The live projected tool catalog, lower-cased. Empty when the catalog is not loaded. */
export async function defaultKnownToolNames(): Promise<ReadonlySet<string>> {
  const { listAllProjectedTools } = await import('@papercusp/agent-mcp');
  const names = new Set<string>();
  for (const tool of listAllProjectedTools()) {
    const name = tool.expose?.mcp?.name;
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

export function buildBlindReviewerKickoff(brief: BlindReviewBrief, howToRun?: string | null, productReads?: ProductReadBoundary,
  scratchPlans?: ScratchPlanBoundary): string {
  const run = howToRun?.trim()
    ? howToRun.trim()
    : 'Find the running build yourself (dev:service_health), then exercise it with capability:bash.';
  return [
    `# Blind gap review: ${brief.planSlug}`,
    '',
    'You review a finished feature WITHOUT seeing its plan. Below are the owner\'s own words.',
    'Run the product, then list every place where what the owner asked for is missing,',
    'wrong, or only partly there. This plan, its rubric and its evidence are refused for this',
    'session on purpose; a refusal is expected, not an obstacle to route around.',
    '',
    '## How to run the product',
    run,
    ...(productReads ? [
      '',
      'Nominated product reads (all other documentation and ledger selectors remain refused):',
      ...productReads.docsSlugs.map(slug => `docs:get { harness: '${productReads.docsHarness}', slugs: ['${slug}'] }`),
      ...productReads.testFiles.map(file => `testing:runs { harness: '${productReads.harness}', filePath: '${file}', source: 'mutation-probe', sinceHours: 24, limit: 20 }`),
      ...productReads.testFiles.map(file => `testing:run { harness: '${productReads.harness}', files: ['${file}'], timeoutMs: 120000, maxFailures: 5 }`),
      'Run nominated tests through testing:run: its server-side source-hold preflight admits the exact files before execution. The offline capability:bash sandbox cannot query that ledger.',
      'testing:run caps its foreground wait below the requested timeoutMs, so a longer run returns a detachedRunId. Poll it with testing:run-status { runId: \'<that id>\' } until it reports pass, fail, cancelled or error; a foreground timeout is not a test result.',
      'These are maintained product docs and raw test-file history, not the plan, its bound proof, or an author-selected proof ID.',
    ] : []),
    ...(scratchPlans ? [
      '',
      '## Your scratch plans',
      `To exercise plan-tool behaviour, create plans of your own. Every slug must start with ${scratchPlans.scratchPrefix}, for example ${scratchPlans.scratchPrefix}probe.`,
      'plans:new, plans:add-item, plans:set-status, plans:audit and plans:get accept those slugs only, and plans:set-plan-status accepts them only with dryRun: true.',
      'Use force: true on plans:new for an independent scratch rehearsal; it is permitted only under your own minted prefix and cannot bypass another plan\'s boundary.',
      `Browse product definitions with plan-types:list or plan-types:get using harness: '${scratchPlans.harness}'. Public Cupboard browsing is limited to cupboard:search { kind: 'pack', q: '<your product search>' }; plan and rubric listings remain refused.`,
      'Never name the reviewed plan in a scratch call. Such a call is refused, and the attempt is recorded as reading the plan, which voids your review.',
      'Your scratch plans are archived when you post your gaps.',
    ] : []),
    '',
    '## The owner\'s words',
    brief.text,
    '',
    '## Report',
    `Call ${BLIND_REVIEW_TOOL} { op: 'post', slug: '${brief.planSlug}', activationAuditSeq: ${brief.activationAuditSeq}, outcome: 'conclusive', gaps: [...] }`,
    'Use conclusive only after completing the product interaction against the owner\'s words; gaps: [] means you found none.',
    'If product access or verification is incomplete, post outcome: \'inconclusive\' with a summary explaining what could not be verified. Empty gaps alone do not complete a review.',
    'After posting your review, call session:end with a short reason to finish your own session. It preserves the posted review and applies the existing agent-launched and human-attended guards.',
  ].join('\n');
}

type LaunchHandler = (args: Record<string, unknown>, ctx: never) => Promise<unknown>;

export interface MintBlindGapReviewerDeps {
  loadBrief?: typeof loadBlindReviewBrief;
  /** The launch-agent handler plus its confinement symbol; injected in tests. */
  launcher?: () => Promise<{ handler: LaunchHandler; confinementKey: symbol }>;
  createSessionBinding?: typeof createBlindReviewSessionBinding;
  acquireSessionResume?: typeof acquireBlindReviewSessionResume;
  releaseSessionResume?: typeof releaseBlindReviewSessionResume;
  /** Registered tool names for the howToRun ceiling check; injected in tests. */
  knownTools?: () => Promise<ReadonlySet<string>>;
}

export type MintBlindGapReviewerResult =
  | { ok: true; launch: unknown; kickoff: string; activationAuditSeq: number; scratchPrefix: string | null;
      binding: BlindReviewSessionBinding | null; launchStatus: 'bound' | 'partial' | 'not-started' | 'uncertain' }
  | { ok: false; code: 'workspace_required' | 'no_activation_audit' | 'no_source_turns' | 'invalid_product_reads'
      | 'how_to_run_outside_ceiling' | 'session_binding_failed'; message: string; refusedTools?: string[] };

async function defaultLauncher(): Promise<{ handler: LaunchHandler; confinementKey: symbol }> {
  const mod = await import('./agent-tools/capability/launch-agent');
  return {
    handler: (args, ctx) => mod.default.handler(args as never, ctx),
    confinementKey: mod.INTERNAL_SCOPED_SESSION_CONFINEMENT,
  };
}

export async function mintBlindGapReviewer(
  input: { slug: string; harness: string; howToRun?: string | null; productReads?: BlindReviewerProductReads; ctx: Record<string, unknown> },
  deps: MintBlindGapReviewerDeps = {},
): Promise<MintBlindGapReviewerResult> {
  const workspaceId = typeof input.ctx.workspaceId === 'string' ? input.ctx.workspaceId.trim() : '';
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, code: 'workspace_required', message: 'A blind reviewer mint needs a concrete workspace.' };
  }
  const brief = await (deps.loadBrief ?? loadBlindReviewBrief)({
    workspaceId, planSlug: input.slug, harnessSlug: input.harness,
  });
  if (!brief) {
    return { ok: false, code: 'no_activation_audit',
      message: `${input.slug} has no activation audit, so there are no owner turns to brief a reviewer with.` };
  }
  // Owner directive #2499: an unverified-origin user turn is briefed (labelled), not refused.
  // Only an audit citing no user turn at all leaves the reviewer nothing to judge against.
  if (briefTurnCount(brief) === 0) {
    return { ok: false, code: 'no_source_turns',
      message: `${input.slug}'s activation audit cites no readable user turns (only assistant or machine-injected turns, or refs that do not resolve). Re-audit its mappings against the owner's own words before minting a blind reviewer.` };
  }
  const productReads = input.productReads ? { harness: input.harness,
    docsHarness: input.productReads.docsHarness ?? input.harness,
    docsSlugs: input.productReads.docsSlugs ?? [], testFiles: input.productReads.testFiles ?? [],
  } : undefined;
  if (productReads && !validProductReadBoundary(productReads)) {
    return { ok: false, code: 'invalid_product_reads', message: 'Product reads require exact documentation slugs, test file paths and concrete harnesses.' };
  }
  // D-050: the reviewer may author and exercise its own scratch plans. A slug or harness
  // the boundary cannot represent leaves the plan verbs refused, as before D-050.
  const scratchCandidate: ScratchPlanBoundary = { scratchPrefix: blindReviewScratchPrefix(),
    reviewedSlug: input.slug, harness: input.harness };
  const scratchPlans = validScratchPlanBoundary(scratchCandidate) ? scratchCandidate : undefined;
  const confinement = blindReviewerConfinement(input.slug, productReads, scratchPlans);
  const refusedTools = howToRunToolsOutsideCeiling(input.howToRun, confinement,
    await (deps.knownTools ?? defaultKnownToolNames)());
  if (refusedTools.length > 0) {
    return { ok: false, code: 'how_to_run_outside_ceiling', refusedTools,
      message: howToRunOutsideCeilingMessage(refusedTools, confinement) };
  }
  const kickoff = buildBlindReviewerKickoff(brief, input.howToRun, productReads, scratchPlans);
  const { handler, confinementKey } = await (deps.launcher ?? defaultLauncher)();
  // A SYSTEM effect, not the caller's personal launch: the reviewer must descend from this
  // actor, or the door's lineage check rejects it as the author's child. Same pattern as
  // launchAcceptanceGraderForGate (agent-tools/plans/set-plan-status.ts).
  const systemCtx = {
    ...input.ctx,
    harnessSlug: input.harness,
    uiClientId: null,
    isSuperuser: false,
    isPowerUser: false,
    principal: { kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId },
    ownerId: BLIND_GAP_REVIEW_ACTOR,
    ownerLabel: 'blind gap review',
    userId: null,
    [confinementKey]: blindReviewerConfinement(input.slug, productReads, scratchPlans),
  };
  // Walk the backend ladder. Only a launch PROVEN not started falls through; anything
  // else (spawned, partial, or an isError that may follow a spawn) stops the walk, so no
  // second reviewer starts.
  let launch: unknown = null;
  const idempotencyKey = blindReviewMintIdempotencyKey({ workspaceId, harnessSlug: input.harness,
    planSlug: input.slug, activationAuditSeq: brief.activationAuditSeq });
  for (const backend of BLIND_REVIEWER_BACKENDS) {
    try {
      launch = await handler(
        {
          brief: kickoff,
          harness: input.harness,
          headless: true,
          agent: backend.agent,
          ...(backend.model ? { model: backend.model } : {}),
          ...(backend.effort ? { effort: backend.effort } : {}),
          account: BLIND_GAP_REVIEW_ACCOUNT,
          // A confined reviewer must reach the door and product on the build that
          // minted it. The stable endpoint may still serve an older tool catalog.
          mcpTarget: 'spawn-host',
          // One reviewer per activation, including lost replies and partial launches.
          idempotencyKey,
        },
        systemCtx as never,
      );
    } catch (error) {
      // A thrown reply may follow spawn. Preserve uncertainty and stop the ladder.
      launch = { uncertain: error instanceof Error ? error.message : String(error) };
      break;
    }
    if (!launchProvablyNotStarted(launch)) break;
  }
  const receipt = blindReviewLaunchReceipt(launch);
  if (receipt.kind === 'not-started' || receipt.kind === 'uncertain') {
    return { ok: true, launch, kickoff, activationAuditSeq: brief.activationAuditSeq,
      scratchPrefix: scratchPlans?.scratchPrefix ?? null, binding: null, launchStatus: receipt.kind };
  }
  const reviewerOwnerId = receipt.ownerId;
  const advSessionId = receipt.advSessionId;
  const nativeSessionId = receipt.sessionId;
  let bindingResult;
  try {
    bindingResult = await (deps.createSessionBinding ?? createBlindReviewSessionBinding)({
      workspaceId, harnessSlug: input.harness, planSlug: input.slug,
      activationAuditSeq: brief.activationAuditSeq, reviewerOwnerId, advSessionId, nativeSessionId,
      launchParentOwner: BLIND_GAP_REVIEW_ACTOR,
      confinement: blindReviewerConfinement(input.slug, productReads, scratchPlans),
    });
  } catch (error) {
    return { ok: false, code: 'session_binding_failed',
      message: 'The reviewer launched, but its exact session binding could not be persisted: ' +
        (error instanceof Error ? error.message : String(error)) + '. Do not mint or repost again until the binding is reconciled.' };
  }
  if (!bindingResult.ok && bindingResult.code === 'native_session_unresolved') {
    return { ok: true, launch, kickoff, activationAuditSeq: brief.activationAuditSeq,
      scratchPrefix: scratchPlans?.scratchPrefix ?? null, binding: null, launchStatus: 'uncertain' };
  }
  if (!bindingResult.ok) {
    return { ok: false, code: 'session_binding_failed',
      message: 'The reviewer launched, but its exact session binding was refused (' + bindingResult.code +
        '): ' + bindingResult.message + '. Do not mint or repost again until the binding is reconciled.' };
  }
  const launchData = receiptRecord(receiptRecord(launch)?.data)?.launch;
  const launchSummary = receiptRecord(launchData) ?? receiptRecord(receiptRecord(launch)?.launch);
  const partial = receiptRecord(launch)?.isError === true || launchSummary?.partial === true || launchSummary?.agentStarted === false;
  return { ok: true, launch, kickoff, activationAuditSeq: brief.activationAuditSeq,
    scratchPrefix: scratchPlans?.scratchPrefix ?? null, binding: bindingResult.binding,
    launchStatus: partial ? 'partial' : 'bound' };
}

export type ResumeBlindGapReviewerResult =
  | { ok: true; launch: unknown; activationAuditSeq: number; reviewerOwnerId: string; leaseReleased: boolean;
      /** The resumed reviewer's session binding row — its post fires blindReviewPostedEventKey(slug, bindingId). */
      bindingId: number }
  | { ok: false; code: string; message: string };

export async function resumeBlindGapReviewer(
  input: { slug: string; harness: string; recruiterOwnerId: string; ctx: Record<string, unknown> },
  deps: MintBlindGapReviewerDeps = {},
): Promise<ResumeBlindGapReviewerResult> {
  const workspaceId = typeof input.ctx.workspaceId === 'string' ? input.ctx.workspaceId.trim() : '';
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, code: 'workspace_required', message: 'A recruiter resume needs a concrete workspace.' };
  }
  const brief = await (deps.loadBrief ?? loadBlindReviewBrief)({
    workspaceId, planSlug: input.slug, harnessSlug: input.harness,
  });
  if (!brief) return { ok: false, code: 'no_activation_audit', message: 'The plan has no current activation audit to resume.' };
  if (briefTurnCount(brief) === 0) {
    return { ok: false, code: 'no_source_turns', message: 'The current activation audit cites no readable user turns.' };
  }
  const acquired = await (deps.acquireSessionResume ?? acquireBlindReviewSessionResume)({
    workspaceId, planSlug: input.slug, activationAuditSeq: brief.activationAuditSeq,
  });
  if (!acquired.ok) return acquired;
  if (!input.recruiterOwnerId || input.recruiterOwnerId === acquired.binding.reviewerOwnerId) {
    await (deps.releaseSessionResume ?? releaseBlindReviewSessionResume)(acquired.binding.id, acquired.leaseId).catch(() => false);
    return { ok: false, code: 'recruiter_only', message: 'The bound reviewer cannot recruit or resume itself.' };
  }

  let result: ResumeBlindGapReviewerResult;
  try {
    const { handler, confinementKey } = await (deps.launcher ?? defaultLauncher)();
    const permit: BlindReviewResumePermit = {
      bindingId: acquired.binding.id, leaseId: acquired.leaseId, workspaceId, planSlug: input.slug,
      activationAuditSeq: brief.activationAuditSeq, reviewerOwnerId: acquired.binding.reviewerOwnerId,
      advSessionId: acquired.binding.advSessionId, nativeSessionId: acquired.binding.nativeSessionId,
    };
    const systemCtx = {
      ...input.ctx, harnessSlug: input.harness, uiClientId: null, isSuperuser: false, isPowerUser: false,
      principal: { kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId },
      ownerId: BLIND_GAP_REVIEW_ACTOR, ownerLabel: 'blind gap review', userId: null,
      [confinementKey]: acquired.binding.confinementSnapshot,
      [INTERNAL_BLIND_REVIEW_RESUME]: permit,
    };
    const launch = await handler({
      resume: { sessionId: acquired.binding.nativeSessionId },
      fork: false, headless: true, harness: input.harness,
      brief: buildBlindReviewerKickoff(brief),
    }, systemCtx as never);
    result = (launch as { isError?: unknown } | null)?.isError === true
      ? { ok: false, code: 'resume_failed', message: 'The exact in-place recruiter resume was refused by capability:launch-agent.' }
      : { ok: true, launch, activationAuditSeq: brief.activationAuditSeq,
          reviewerOwnerId: acquired.binding.reviewerOwnerId, leaseReleased: false, bindingId: acquired.binding.id };
  } catch (error) {
    result = { ok: false, code: 'resume_failed', message: error instanceof Error ? error.message : String(error) };
  }
  let leaseReleased = false;
  try {
    leaseReleased = await (deps.releaseSessionResume ?? releaseBlindReviewSessionResume)(acquired.binding.id, acquired.leaseId);
  } catch {
    leaseReleased = false;
  }
  return result.ok ? { ...result, leaseReleased } : result;
}
