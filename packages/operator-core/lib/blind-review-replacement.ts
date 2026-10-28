/** Recruiter-only, append-only replacement on the existing reviewer binding ledger. */
import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from './agent-tools/coordination/identity';
import { loadHarnessRegistry } from './harness-registry';
import { areAcceptanceLineageRelated, isAcceptanceAuthorIdentity, resolvePlanImplementerIdentities } from './acceptance-author-identity';
import { blindReviewCompletion, loadBlindReviewBrief } from './blind-review-gate';
import { briefTurnCount } from './blind-review-brief';
import { validProductReadBoundary, type ProductReadBoundary, type SessionToolConfinement } from './capability-envelope/session-confinement';
import { blindReviewScratchPrefix } from './blind-review-scratch-plans';
import { blindReviewLaunchReceipt, blindReviewerConfinement, buildBlindReviewerKickoff, BLIND_GAP_REVIEW_ACCOUNT, BLIND_REVIEWER_BACKENDS, defaultKnownToolNames, launchProvablyNotStarted,
  howToRunOutsideCeilingMessage, howToRunToolsOutsideCeiling, type BlindReviewerProductReads } from './blind-reviewer-mint';
import { BLIND_GAP_REVIEW_ACTOR, createBlindReviewSessionBinding, recordBlindReviewSessionPost } from './blind-review-session-bindings';
import { TERMINAL_TASK_STATES } from './task-manager/types';

type Sql = ReturnType<typeof getOrgPg>['sql'];
type Attempt = {
  id: number | string; replacement_of: number | string; attempt_seq: number;
  workspace_id: string; harness_slug: string; plan_slug: string; activation_audit_seq: number;
  request_key: string; request_hash: string; requested_by: string; launch_key: string;
  status: string; reviewer_owner_id: string | null; adv_session_id: number | string | null;
  native_session_id: string | null; review_id: number | string | null;
  confinement_snapshot: SessionToolConfinement;
  request_snapshot: { productReads: ProductReadBoundary; howToRun: string; kickoff: string };
  launch_result: unknown;
};
export type BlindReviewReplacementInput = {
  workspaceId: string; harness: string; slug: string; activationAuditSeq: number;
  sourceReviewId: number; requestKey: string; productReads: BlindReviewerProductReads;
  howToRun?: string; ctx: Record<string, unknown>;
};
export type BlindReviewReplacementDeps = {
  sql?: Sql;
  loadBrief?: typeof loadBlindReviewBrief;
  resolveImplementers?: typeof resolvePlanImplementerIdentities;
  authorIdentity?: typeof isAcceptanceAuthorIdentity;
  lineageRelated?: typeof areAcceptanceLineageRelated;
  repoRoot?: (workspaceId: string, harness: string) => Promise<string>;
  launcher?: () => Promise<{ handler: (args: Record<string, unknown>, ctx: never) => Promise<unknown>; confinementKey: symbol }>;
  bind?: typeof createBlindReviewSessionBinding;
  /** Live psu host for an owner, or null. Injected in tests (EI-27120731037609627). */
  liveHost?: (ownerId: string, workspaceId: string) => Promise<unknown>;
  /** Registered tool names for the howToRun ceiling check (EI-27120299877087815). */
  knownTools?: () => Promise<ReadonlySet<string>>;
};

async function defaultLiveHost(ownerId: string, workspaceId: string): Promise<unknown> {
  const { findLiveHostAsync } = await import('./events/await/psu-pty-discovery');
  return findLiveHostAsync(ownerId, undefined, { workspaceId });
}

/**
 * A reviewer that registered and then died while no parent watched its exit (for
 * example across an operator restart) never gets adv_sessions.ended_at: nothing but
 * markAdvSessionEnded writes it, and the dead-launch reconciler only covers sessions
 * that never registered. Without this step its inconclusive review could never be
 * replaced (EI-27120731037609627). Close the row only on positive terminal evidence,
 * under the row lock the caller already holds: every agent-session task for the
 * owner is terminal in the task ledger, one of them is bound to this native session,
 * and no live psu host answers for the owner. Anything less stays protected.
 */
async function reconcileUnobservedReviewerEnd(
  tx: Sql,
  target: { workspaceId: string; advSessionId: string; ownerId: string; sessionId: string | null },
  liveHost: (ownerId: string, workspaceId: string) => Promise<unknown>,
): Promise<boolean> {
  if (!target.sessionId) return false;
  const tasks = await tx<Array<{ state: string; session_id: string | null }>>`
    SELECT state, session_id FROM harness_shared.task_ledger
     WHERE workspace_id = ${target.workspaceId} AND class = 'agent-session'
       AND detail ->> 'coordOwnerId' = ${target.ownerId}`;
  const terminal = new Set<string>(TERMINAL_TASK_STATES);
  if (tasks.length === 0 || !tasks.every(task => terminal.has(task.state))) return false;
  if (!tasks.some(task => task.session_id === target.sessionId)) return false;
  if (await liveHost(target.ownerId, target.workspaceId)) return false;
  const closed = await tx<Array<{ id: unknown }>>`
    UPDATE harness_shared.adv_sessions SET ended_at = now(), ended_by = 'reconciler'
     WHERE workspace_id = ${target.workspaceId} AND id = ${target.advSessionId}
       AND coord_owner_id = ${target.ownerId} AND ended_at IS NULL AND resume_claim_key IS NULL
    RETURNING id`;
  return closed.length === 1;
}

class Refusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function refuse(code: string, message: string): never { throw new Refusal(code, message); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => JSON.stringify(key) + ':' + stable(entry)).join(',') + '}';
  return JSON.stringify(value);
}
function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Exact canonical nominations; lexical checks alone cannot detect symlink escapes. */
export async function validateReplacementProductReads(reads: ProductReadBoundary, root: string): Promise<void> {
  if (!validProductReadBoundary(reads) || new Set(reads.testFiles).size !== reads.testFiles.length ||
      new Set(reads.docsSlugs).size !== reads.docsSlugs.length) {
    refuse('invalid_product_reads', 'Nominations must contain unique exact product paths and documentation slugs.');
  }
  const canonicalRoot = await realpath(root);
  for (const file of reads.testFiles) {
    if (path.posix.normalize(file) !== file || path.isAbsolute(file) || file.includes('\\')) {
      refuse('invalid_product_reads', 'Each nominated test must be a canonical repository-relative path.');
    }
    let target: string;
    try { target = await realpath(path.join(canonicalRoot, file)); }
    catch { refuse('invalid_product_reads', `Nominated test is missing: ${file}`); }
    const relative = path.relative(canonicalRoot, target);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || !(await stat(target)).isFile()) {
      refuse('invalid_product_reads', `Nominated test escapes its repository or is not a file: ${file}`);
    }
  }
}

/** Preserve the replacement API while sharing the original mint's receipt rules. */
export function replacementLaunchReceipt(value: unknown):
  | { kind: 'not-started' }
  | { kind: 'native'; ownerId: string; advSessionId: number; sessionId: string }
  | { kind: 'uncertain' } {
  const receipt = blindReviewLaunchReceipt(value);
  return receipt.kind === 'native' && receipt.sessionId
    ? { kind: 'native', ownerId: receipt.ownerId, advSessionId: receipt.advSessionId, sessionId: receipt.sessionId }
    : receipt.kind === 'not-started' ? receipt : { kind: 'uncertain' };
}

function publicAttempt(row: Attempt) {
  return { id: Number(row.id), sourceBindingId: Number(row.replacement_of), attemptSeq: row.attempt_seq,
    requestKey: row.request_key, requestedBy: row.requested_by, status: row.status,
    activationAuditSeq: row.activation_audit_seq, reviewerOwnerId: row.reviewer_owner_id,
    advSessionId: row.adv_session_id == null ? null : Number(row.adv_session_id),
    nativeSessionId: row.native_session_id, reviewId: row.review_id == null ? null : Number(row.review_id),
    productReads: row.request_snapshot.productReads };
}

export async function replaceBlindGapReviewer(input: BlindReviewReplacementInput, deps: BlindReviewReplacementDeps = {}):
  Promise<Record<string, unknown>> {
  const sql = deps.sql ?? getOrgPg().sql;
  try {
    const identity = resolveAgentIdentity(input.ctx as Parameters<typeof resolveAgentIdentity>[0]);
    if (identity.workspaceId !== input.workspaceId || input.workspaceId === '*' || !input.workspaceId) {
      refuse('recruiter_only', 'Replacement requires an authenticated recruiter in this workspace.');
    }
    const caller = identity.ownerId;
    const brief = await (deps.loadBrief ?? loadBlindReviewBrief)({ workspaceId: input.workspaceId,
      harnessSlug: input.harness, planSlug: input.slug });
    if (!brief || brief.activationAuditSeq !== input.activationAuditSeq || briefTurnCount(brief) === 0) {
      refuse('activation_audit_mismatch', 'Use the exact current activation, citing at least one readable user turn.');
    }
    const reads = { harness: input.harness, docsHarness: input.productReads.docsHarness ?? input.harness,
      docsSlugs: [...(input.productReads.docsSlugs ?? [])], testFiles: [...(input.productReads.testFiles ?? [])] };
    const root = await (deps.repoRoot ?? (async (ws, harness) => {
      const entry = (await loadHarnessRegistry(ws, { fresh: true })).projects.find(p => p.slug === harness);
      if (!entry?.path) refuse('repository_unavailable', 'The nominated repository is not registered.');
      return entry.path;
    }))(input.workspaceId, input.harness);
    await validateReplacementProductReads(reads, root);
    reads.docsSlugs.sort(); reads.testFiles.sort();
    const howToRun = input.howToRun?.trim() ?? '';
    const requestHash = createHash('sha256').update(stable({ workspaceId: input.workspaceId, harness: input.harness,
      slug: input.slug, activation: input.activationAuditSeq, sourceReviewId: input.sourceReviewId, reads, howToRun })).digest('hex');
    const scratch = { scratchPrefix: blindReviewScratchPrefix(), reviewedSlug: input.slug, harness: input.harness };
    const confinement = blindReviewerConfinement(input.slug, reads, scratch);
    const refusedTools = howToRunToolsOutsideCeiling(howToRun, confinement, await (deps.knownTools ?? defaultKnownToolNames)());
    if (refusedTools.length > 0) refuse('how_to_run_outside_ceiling', howToRunOutsideCeilingMessage(refusedTools, confinement));
    const kickoff = buildBlindReviewerKickoff(brief, howToRun, reads, scratch);

    // The plan, source binding, material and native writer are locked before eligibility
    // is decided. Every contender serializes on the same source; there is no check→claim gap.
    const selected = await sql.begin(async txValue => {
      const tx = txValue as unknown as Sql;
      const [plan] = await tx<Array<{ owner: string | null }>>`
        SELECT owner FROM harness_shared.harness_plans
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness} AND plan_slug = ${input.slug}
         FOR UPDATE`;
      if (!plan) refuse('plan_not_found', 'The exact plan scope was not found.');
      const implementers = await (deps.resolveImplementers ?? resolvePlanImplementerIdentities)(input.slug, { workspaceId: input.workspaceId, sql: tx });
      const authorized = implementers.includes(caller) || await (deps.authorIdentity ?? isAcceptanceAuthorIdentity)(plan.owner, caller, { workspaceId: input.workspaceId, sql: tx });
      if (!authorized) refuse('recruiter_only', 'Only the recorded plan author or implementer may recruit a replacement.');
      const [activation] = await tx<Array<{ audit_seq: number }>>`
        SELECT audit_seq FROM harness_shared.plan_audits WHERE workspace_id = ${input.workspaceId}
          AND harness_slug = ${input.harness} AND plan_slug = ${input.slug} AND audit_kind = 'activation'
         ORDER BY audit_seq DESC LIMIT 1`;
      if (activation?.audit_seq !== input.activationAuditSeq) refuse('activation_audit_mismatch', 'The current activation changed before reservation.');
      const [source] = await tx<Array<{ id: string; reviewer_owner_id: string; adv_session_id: string; status: string; review_id: string }>>`
        SELECT id, reviewer_owner_id, adv_session_id, status, review_id FROM harness_shared.plan_blind_review_sessions
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness} AND plan_slug = ${input.slug}
           AND activation_audit_seq = ${input.activationAuditSeq} AND review_id = ${input.sourceReviewId}
           AND launch_parent_owner = ${BLIND_GAP_REVIEW_ACTOR} FOR UPDATE`;
      if (!source || caller === source.reviewer_owner_id) refuse('source_review_mismatch', 'The request must name a bound review belonging to a different reviewer.');
      const [material] = await tx<Array<Parameters<typeof blindReviewCompletion>[0]>>`
        SELECT * FROM harness_shared.plan_blind_reviews WHERE id = ${input.sourceReviewId}
          AND workspace_id = ${input.workspaceId} AND harness_slug = ${input.harness} AND plan_slug = ${input.slug}
          AND activation_audit_seq = ${input.activationAuditSeq} AND created_by = ${source.reviewer_owner_id} FOR UPDATE`;
      if (source.status !== 'posted' || !material || blindReviewCompletion(material) !== 'inconclusive') {
        refuse('review_protected', 'Only a posted, explicitly incomplete review can be replaced.');
      }
      const [native] = await tx<Array<{ ended_at: unknown; resume_claim_key: string | null; session_id?: string | null }>>`
        SELECT ended_at, resume_claim_key, session_id FROM harness_shared.adv_sessions
         WHERE workspace_id = ${input.workspaceId} AND id = ${source.adv_session_id}
           AND coord_owner_id = ${source.reviewer_owner_id} FOR UPDATE`;
      const protectedMessage = 'The source reviewer is live, reserved for resume, or its end is unverified.';
      if (!native || native.resume_claim_key) refuse('review_protected', protectedMessage);
      if (!native.ended_at && !await reconcileUnobservedReviewerEnd(tx, {
        workspaceId: input.workspaceId, advSessionId: source.adv_session_id,
        ownerId: source.reviewer_owner_id, sessionId: native.session_id ?? null,
      }, deps.liveHost ?? defaultLiveHost)) refuse('review_protected', protectedMessage);
      const history = await tx<Attempt[]>`
        SELECT * FROM harness_shared.plan_blind_review_sessions WHERE replacement_of = ${source.id} ORDER BY attempt_seq FOR UPDATE`;
      const same = history.find(row => row.request_key === input.requestKey);
      if (same && (same.request_hash !== requestHash || same.requested_by !== caller)) refuse('request_conflict', 'This request key already names a different authenticated immutable request.');
      const active = history.find(row => row.status !== 'failed');
      if (same || active) {
        const attempt = same ?? active!;
        if (attempt.request_hash !== requestHash) refuse('replacement_active', 'A replacement with a different manifest or run instruction is already reserved.');
        return { attempt, launch: false, excluded: [...new Set([plan.owner, caller, source.reviewer_owner_id, ...implementers].filter((v): v is string => !!v))] };
      }
      const seq = (history.at(-1)?.attempt_seq ?? 0) + 1;
      const launchKey = `blind-review-replacement:${randomUUID()}`;
      const [attempt] = await tx<Attempt[]>`
        INSERT INTO harness_shared.plan_blind_review_sessions
          (workspace_id, harness_slug, plan_slug, activation_audit_seq, launch_parent_owner,
           confinement_snapshot, status, replacement_of, attempt_seq, request_key, request_hash,
           requested_by, request_snapshot, launch_key)
        VALUES (${input.workspaceId}, ${input.harness}, ${input.slug}, ${input.activationAuditSeq}, ${BLIND_GAP_REVIEW_ACTOR},
          ${tx.json(confinement as never)}, 'launching', ${source.id}, ${seq}, ${input.requestKey}, ${requestHash},
          ${caller}, ${tx.json({ productReads: reads, howToRun, kickoff } as never)}, ${launchKey}) RETURNING *`;
      if (!attempt) refuse('reservation_failed', 'The replacement reservation was not persisted.');
      return { attempt, launch: true, excluded: [...new Set([plan.owner, caller, source.reviewer_owner_id, ...implementers].filter((v): v is string => !!v))] };
    });
    let attempt = selected.attempt;
    // The replacement reservation is now committed and already cuts off old
    // dispatch authority. Retire its original runtime before launching further.
    try {
      const { retireRuntimeNamespacesForBinding } = await import('./blind-review-runtime-recovery');
      await retireRuntimeNamespacesForBinding({ workspaceId: input.workspaceId,
        bindingId: Number(attempt.replacement_of), reason: 'review-replaced' }, { sql });
    } catch {
      console.warn('[blind-review-runtime] replacement cleanup pending; periodic recovery will retry');
    }
    let outcome: unknown = attempt.launch_result;
    if (selected.launch) {
      let invoked = false;
      try {
        // Revalidate filesystem custody against the persisted request immediately before launch.
        await validateReplacementProductReads(attempt.request_snapshot.productReads, root);
        const launcher = await (deps.launcher ?? (async () => {
          const mod = await import('./agent-tools/capability/launch-agent');
          return { handler: (args: Record<string, unknown>, ctx: never) => mod.default.handler(args as never, ctx),
            confinementKey: mod.INTERNAL_SCOPED_SESSION_CONFINEMENT };
        }))();
        invoked = true;
        // Walk the same backend ladder as the mint (EI-27127088253419654). Every rung reuses
        // the reservation's launch_key: a proven-not-started launch left or released that
        // key, so the ledger lookup below still finds whichever rung actually claimed it.
        for (const backend of BLIND_REVIEWER_BACKENDS) {
          outcome = await launcher.handler({ harness: input.harness, brief: attempt.request_snapshot.kickoff,
            headless: true, agent: backend.agent,
            ...(backend.model ? { model: backend.model } : {}),
            ...(backend.effort ? { effort: backend.effort } : {}),
            account: BLIND_GAP_REVIEW_ACCOUNT, independent: true,
            mcpTarget: 'spawn-host', idempotencyKey: attempt.launch_key }, {
            ...input.ctx, workspaceId: input.workspaceId, harnessSlug: input.harness, uiClientId: null,
            isSuperuser: false, isPowerUser: false, userId: null, ownerId: BLIND_GAP_REVIEW_ACTOR,
            principal: { kind: 'system', slug: BLIND_GAP_REVIEW_ACTOR, workspaceId: input.workspaceId },
            [launcher.confinementKey]: attempt.confinement_snapshot,
          } as never);
          if (!launchProvablyNotStarted(outcome)) break;
        }
      } catch (error) {
        // A thrown transport/launcher exception may follow spawn. Never release on it.
        const message = error instanceof Error ? error.message : String(error);
        outcome = invoked ? { uncertain: message }
          : { data: { launchFailure: { stage: 'pre-spawn', processesOpened: 0 } }, message };
      }
      await sql`UPDATE harness_shared.plan_blind_review_sessions SET launch_result = ${sql.json((outcome ?? null) as never)},
        status = 'uncertain', updated_at = now() WHERE id = ${attempt.id} AND status = 'launching'`;
    } else if (attempt.status === 'uncertain' || attempt.status === 'launching') {
      const [ledger] = await sql<Array<{ summary: unknown }>>`
        SELECT summary FROM harness_shared.agent_launch_idempotency
         WHERE workspace_id = ${input.workspaceId} AND idempotency_key = ${attempt.launch_key}
           AND launched_by = ${BLIND_GAP_REVIEW_ACTOR}`;
      if (obj(ledger?.summary) && Object.keys(obj(ledger?.summary)!).length) outcome = ledger!.summary;
    }
    if (attempt.status === 'launching' || attempt.status === 'uncertain') {
      let receipt = replacementLaunchReceipt(outcome);
      const detailedReceipt = blindReviewLaunchReceipt(outcome);
      if (receipt.kind === 'uncertain' && detailedReceipt.kind === 'native' && !detailedReceipt.sessionId) {
        // The launcher can return before Codex records its native id. Its
        // immutable summary then stays incomplete even after ADV is ready.
        // Recover only the exact opened identity; bind below still validates
        // its recruiter profile, confinement and independent lineage.
        const opened = detailedReceipt;
        if (opened) {
          const [native] = await sql<Array<{ session_id: string | null }>>`
            SELECT session_id FROM harness_shared.adv_sessions
             WHERE workspace_id = ${input.workspaceId} AND id = ${opened.advSessionId}
               AND coord_owner_id = ${opened.ownerId}`;
          if (typeof native?.session_id === 'string' && native.session_id.length > 0) {
            receipt = { kind: 'native', ownerId: opened.ownerId,
              advSessionId: opened.advSessionId, sessionId: native.session_id };
          }
        }
      }
      if (receipt.kind === 'not-started') {
        await sql`UPDATE harness_shared.plan_blind_review_sessions SET status = 'failed',
          launch_result = ${sql.json(outcome as never)}, updated_at = now()
          WHERE id = ${attempt.id} AND status IN ('launching', 'uncertain')`;
      } else if (receipt.kind === 'native') {
        for (const excluded of selected.excluded) {
          if (excluded === receipt.ownerId || await (deps.lineageRelated ?? areAcceptanceLineageRelated)(excluded, receipt.ownerId,
            { workspaceId: input.workspaceId, sql })) refuse('reviewer_not_independent', 'The native receipt belongs to the author or an implementation lineage; the reservation remains protected.');
        }
        const bound = await (deps.bind ?? createBlindReviewSessionBinding)({ workspaceId: input.workspaceId,
          harnessSlug: input.harness, planSlug: input.slug, activationAuditSeq: input.activationAuditSeq,
          reviewerOwnerId: receipt.ownerId, advSessionId: receipt.advSessionId, nativeSessionId: receipt.sessionId,
          launchParentOwner: BLIND_GAP_REVIEW_ACTOR, confinement: attempt.confinement_snapshot,
          replacementAttemptId: Number(attempt.id) }, { sql });
        if (!bound.ok && bound.code !== 'binding_conflict') refuse(bound.code, bound.message);
        // A very fast reviewer can post before the native launch reply reaches us.
        // Reconcile that immutable post instead of leaving its binding 'ready'.
        if (bound.ok) {
          const [post] = await sql<Array<{ id: number }>>`
            SELECT id FROM harness_shared.plan_blind_reviews WHERE workspace_id = ${input.workspaceId}
              AND harness_slug = ${input.harness} AND plan_slug = ${input.slug}
              AND activation_audit_seq = ${input.activationAuditSeq} AND record_kind = 'review'
              AND created_by = ${receipt.ownerId} ORDER BY id LIMIT 1`;
          if (post) await recordBlindReviewSessionPost({ workspaceId: input.workspaceId,
            planSlug: input.slug, activationAuditSeq: input.activationAuditSeq,
            reviewerOwnerId: receipt.ownerId, reviewId: Number(post.id) }, { sql });
        }
      }
    }
    const envelope = obj(outcome);
    const launchSummary = obj(obj(envelope?.data)?.launch) ?? obj(envelope?.launch) ?? envelope;
    if (launchSummary?.agentStarted === false) {
      // A measured failed start can open a process. Retain its native identity,
      // and release exclusion only when that same native writer is ended, has
      // no resume reservation, and has not posted. A false/unknown startup bit
      // alone cannot authorize a second process.
      await sql`UPDATE harness_shared.plan_blind_review_sessions AS attempt
         SET status = 'failed', updated_at = now()
       WHERE attempt.id = ${attempt.id} AND attempt.status = 'ready' AND attempt.review_id IS NULL
         AND EXISTS (SELECT 1 FROM harness_shared.adv_sessions AS native
           WHERE native.workspace_id = attempt.workspace_id AND native.id = attempt.adv_session_id
             AND native.coord_owner_id = attempt.reviewer_owner_id
             AND native.session_id = attempt.native_session_id
             AND native.ended_at IS NOT NULL AND native.resume_claim_key IS NULL)
         AND NOT EXISTS (SELECT 1 FROM harness_shared.plan_blind_reviews AS review
           WHERE review.workspace_id = attempt.workspace_id AND review.harness_slug = attempt.harness_slug
             AND review.plan_slug = attempt.plan_slug AND review.activation_audit_seq = attempt.activation_audit_seq
             AND review.record_kind = 'review' AND review.created_by = attempt.reviewer_owner_id)`;
    }
    const history = await sql<Attempt[]>`
      SELECT * FROM harness_shared.plan_blind_review_sessions WHERE replacement_of = ${attempt.replacement_of} ORDER BY attempt_seq`;
    attempt = history.find(row => Number(row.id) === Number(attempt.id)) ?? attempt;
    return { ok: true, op: 'replace', slug: input.slug, deduped: !selected.launch,
      attempt: publicAttempt(attempt), attempts: history.map(publicAttempt),
      next: attempt.status === 'failed' ? 'The previous launch is confirmed inactive. Correct the launch cause and use a new requestKey for a new ordered attempt.'
        : attempt.status === 'launching' || attempt.status === 'uncertain'
          ? 'Launch outcome is unresolved. Retry this exact request to reconcile its ledger; no second reviewer will be started.'
          : 'The confined replacement posts its own typed product-review outcome. The original receipt remains unchanged.' };
  } catch (error) {
    return { ok: false, error: error instanceof Refusal ? error.code : 'replacement_unavailable',
      message: error instanceof Error ? error.message : String(error) };
  }
}
