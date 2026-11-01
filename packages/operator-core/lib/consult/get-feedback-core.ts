/**
 * get-feedback-core.ts — the requester-side consult workflow (plan
 * get-feedback-relevance-consults-2026-08-16, P-003; decisions D-003/D-005/
 * D-007/D-008). Core/binding split mirrors conversations-core.ts: ALL consult
 * logic lives here behind injected deps (sql, router, conversation-opener,
 * reach/wake) so it is integration-tested against a real consult_state table
 * without the prod singletons; the `consult:get_feedback` tool
 * (agent-tools/consult/get-feedback.ts) binds the prod seams.
 *
 * What this module OWNS (and the router deliberately does not):
 *  - SELECTABILITY (D-002): the router annotates sessionState, but selection
 *    does not gate on liveness. Dispatch reads a candidate's tracked transcript
 *    through fork/convert/brief; only an authoritative owner pause excludes a
 *    candidate. Source-specific dispatch failures are recorded and the
 *    dispatcher continues through the cascade; `no_live_responder` is not a
 *    selection verdict. When semantic embeddings are unavailable, the router
 *    may provide explicitly labeled lexical candidates; those are bounded
 *    minimum-fill manual-review picks, never floor-qualified experts.
 *  - SELECTION (consult-min-max-and-rubric-vetting-2026-08-17 D-001/D-005):
 *    min/max responder selection over the router's ranked pool. The per-task
 *    wake budget is REMOVED (D-005: maxResponders is the only per-consult
 *    bound; residual spam guards = per-consult max, the depth cap, and
 *    archive-first dedupe). consult_state.wakes_used keeps being WRITTEN as a
 *    plain stat — it gates nothing.
 *  - PERSISTENCE (D-008 §1): every call — routed or not — opens the
 *    kind='consult' conversation and writes the consult_state row with the
 *    routing snapshot VERBATIM (the D-003 honesty-metric feed needs persisted
 *    no_qualified_responder verdicts too; the PK needs the conversation row).
 *  - the LATENCY CONTRACT (D-005): 'proceed' (default — requester proceeds on
 *    assumption and reconciles) vs 'hard-blocked' (requester parks on the
 *    latched `consult:reply:<conversation_id>` event, emitted by the P-004
 *    reply verbs). expires_at derives from the contract.
 */
import type { Sql } from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { withIterativeScan, type PgHandle } from '@papercusp/search';
import type { RouteResult, RoutingCandidate, SelectionVia } from './relevance-router';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { DEFAULT_SIM_FLOOR, selectResponders, selectionSnapshot } from './relevance-router';
import { advanceCascade, digestFromRow, makeDigestEntry, pendingCascadeDispatch, selectionFromRouting } from './cascade-core';
import { selectConsultEvidenceSource } from './consult-dispatch';
import { consultCurrentReviewContext, consultResponderVerbMenu } from './responder-verb-menu';
import { sourceAuditCascadeMetaFromRouting, sourceAuditWakeCopy, type SourceAuditCascadeMeta } from './grading-cascade';
import { proseProfilePredicateSql } from '../search/prose-vector-dims';

/** P-006 archive-first retrieval floor: a closed_answered consult whose
 * question similarity clears this is served from the archive (create +
 * instant-close, no wake). Deliberately precision-biased — a
 * silently-wrong cached answer is worse than a wake — and never below the
 * router's own similarity sub-floor. */
export const DEFAULT_ARCHIVE_FLOOR = Math.max(DEFAULT_SIM_FLOOR, 0.8);
/** Latency-contract expiry defaults (D-005 'proceed-after-N'; the N is a
 * policy default here, not owner-pinned — P-005 lifecycle owns the expiry
 * sweep and may recalibrate). */
export const PROCEED_EXPIRY_MS = 4 * 3_600_000; // 4h
export const HARD_BLOCKED_EXPIRY_MS = 30 * 60_000; // 30m
/** Definitively dead session states.
 *
 * ⚠ NOT a selection gate any more (D-002): dispatch forks or converts an
 * expert's TRANSCRIPT, so deadness stopped being a reason to pass anyone over
 * (R-2). What still reads this set is retrieval/reporting — the post-routing
 * no-pickup detector, and the "who is still reachable" annotations. */
export const DEAD_RESPONDER_STATES: ReadonlySet<string> = new Set(['ended', 'recorded']);
/** Recursion ceiling (D-007 §7) — mirrors the consult_state.depth CHECK (0–2). */
export const MAX_CONSULT_DEPTH = 2;
/** consult-min-max-and-rubric-vetting-2026-08-17 D-003 [owner]: EVERY consult
 * selects at least the best-available LIVE candidate even below the relevance
 * floor (labeled per D-002). The honest no-route verdict survives only where a
 * minimum is physically unfillable: no live candidate at all, or the embedder
 * is down (no ranking exists to pick "best-available" from — D-003 keeps the
 * cannot-measure degrade honest rather than inventing a recency fallback).
 *
 * Both constants now DERIVE from `selection-policies.ts`, which is the single
 * place bounds are written (unified-responder-selection-critique-and-grading
 * -2026-08-30 D-001). Re-exported here so existing importers are unchanged.
 * Rubric vetting no longer "pins 3 explicitly" — it passes
 * `policy: RUBRIC_VETTING_POLICY` and reads its bound from the registry.
 *
 * Imported AND re-exported: a bare `export … from` would satisfy downstream
 * importers while leaving no local binding for the selection site below. */
import { selectionPolicy } from '@papercusp/ranked-selection';
import {
  BAR_CRITIQUE_POLICY,
  DEFAULT_MIN_RESPONDERS,
  DEFAULT_MAX_RESPONDERS,
  METHOD_REVIEW_POLICY,
  methodReviewTarget,
  RUBRIC_VETTING_POLICY,
} from './selection-policies';
export { DEFAULT_MIN_RESPONDERS, DEFAULT_MAX_RESPONDERS };

/** The latched park/reply key for a consult conversation — the ONE format every
 * emitter (P-004 reply verbs, P-005 expiry sweep) and awaiter shares. */
export function consultParkKey(conversationId: string): string {
  return `consult:reply:${conversationId}`;
}

export type LatencyContract = 'proceed' | 'hard-blocked';

/** A reviewer-specific launch choice, persisted with the consult so every later
 * cascade dispatch uses the same model as the first responder. */
export interface ConsultReviewerModel {
  agent: 'claude' | 'codex' | 'omp';
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface GetFeedbackRequest {
  /** Reuse on transport retries; a new key explicitly asks for a fresh consult. */
  requestKey?: string;
  workspaceId: string;
  requesterId: string;
  question: string;
  /** The production binding supplies its actual launch permission. */
  allowDispatch?: boolean;
  tried?: string;
  observed?: string;
  decisionAtStake?: string;
  latencyContract?: LatencyContract;
  /** Explicit origin task ref; undefined ⇒ default to the requester's most
   * recently progressed wip work-item (fail-soft: none ⇒ null). */
  originTaskRef?: string | null;
  /** Optional exact durable subject whose transcript mentions must justify routing. */
  subjectRef?: string | null;
  /** Explicit source refs from the caller, retained in the accepted request payload. */
  subjectRefs?: string[];
  /** Public-manual anchors expanded before the request is persisted and dispatched. */
  resolvedSubjectRefs?: string[];
  /** Public manual refs that could not be expanded completely; they block floor qualification. */
  unresolvedSubjectRefs?: string[];
  /** Exclude owners from candidacy — e.g. exhausted-menu decliners on a FRESH
   * re-route (the cascade itself is server-driven now, D-005/P-013: declines
   * and expiries advance the selected menu without a re-call). */
  excludeOwners?: string[];
  /** P-005 recursion lineage: set when this consult is opened from WITHIN a
   * consult turn (the responder consulting onward) — the parent consult's
   * conversation_id. depth = parent.depth+1, refused past MAX_CONSULT_DEPTH;
   * the lineage's participants are folded into the router's excludeOwners so
   * a cycle (A→B→A, D-005) can never form by construction. */
  parentConsultId?: string | null;
  topics?: string[];
  harnessSlug?: string;
  /** P-006 archive floor override (default DEFAULT_ARCHIVE_FLOOR). Raise past
   * 1 (e.g. 2) to force fresh routing when an archived answer did not fit;
   * tests use 0 / unreachable as falsifiability controls. */
  archiveFloor?: number;
  /** D-001 §1 / D-003: select at least this many responders even when the
   * routing floors filter everyone out (best-available fill, labeled
   * via:'minimum'). Default DEFAULT_MIN_RESPONDERS (1). Pass 0 to restore
   * pure-floor selection. */
  minResponders?: number;
  /** D-001 §1: hard cap on the selected cascade menu. Default
   * DEFAULT_MAX_RESPONDERS (3). Delivery remains single-wake cascade. */
  maxResponders?: number;
  /**
   * Named selection policy (see `selection-policies.ts`) — resolves min/max
   * from the shared registry instead of the caller supplying numbers.
   *
   * This is the preferred form for any call site whose bounds are GOVERNED
   * rather than ad-hoc (rubric vetting, acceptance grading): it keeps the
   * number in code that one place owns, instead of in prose telling an agent
   * what to type. Explicit minResponders/maxResponders still override, so an
   * ad-hoc consult can widen or narrow for itself.
   *
   * An unregistered key THROWS rather than falling back to the defaults —
   * quietly selecting under the wrong bounds is the failure this replaces.
   */
  policy?: string;
  /** Canonical independence target for a prospective METHOD assessment. */
  methodReviewRubricRef?: string;
  reviewerModel?: ConsultReviewerModel;
  /** Internal testing:run constraint, included in the saved payload fingerprint. */
  nativeConsult?: import('./native-consult').NativeConsultConstraints;
  /** Internal consumer metadata, persisted before any delivery or revival. */
  cascade?: SourceAuditCascadeMeta | import('./decision-review').DecisionReviewCascadeMeta;
}

/** P-005 creation-side refusals — structural, BEFORE any conversation/row is
 * written (a depth/cycle refusal is a pre-flight arg problem, not a routing
 * verdict, so it does not enter the D-003 honesty feed). */
export type GetFeedbackError =
  | { error: 'parent_consult_not_found'; parent_consult_id: string; hint: string }
  | { error: 'consult_depth_exceeded'; depth: number; max_depth: number; hint: string }
  | { error: 'consult_cycle'; lineage: string[]; hint: string }
  | { error: 'bar_critique_requires_plan'; hint: string };

/** Bar critiques count only when their origin is the exact registered plan
 * key that plans:start will query in this workspace and harness. A non-empty
 * work-item or incident id is still the wrong identity. */
export async function validateBarCritiquePlanOrigin(
  req: GetFeedbackRequest,
  sql: Sql,
): Promise<Extract<GetFeedbackError, { error: 'bar_critique_requires_plan' }> | null> {
  if (req.policy !== BAR_CRITIQUE_POLICY) return null;
  const planSlug = req.originTaskRef;
  const harnessSlug = req.harnessSlug;
  const hint = `policy:'${BAR_CRITIQUE_POLICY}' requires origin_task_ref to be the exact plan_slug of a registered plan in the same workspace and harness. Use plans:list/get to resolve the slug, pass a concrete harness, and retry.`;
  if (typeof planSlug !== 'string' || !planSlug.trim() || planSlug !== planSlug.trim() ||
      typeof harnessSlug !== 'string' || !harnessSlug.trim() || harnessSlug !== harnessSlug.trim()) {
    return { error: 'bar_critique_requires_plan', hint };
  }
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${req.workspaceId}
       AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug}
     LIMIT 1
  `;
  return rows.length ? null : { error: 'bar_critique_requires_plan', hint };
}

export interface GetFeedbackDeps {
  /** Internal recovery context, never an externally supplied conversation id. */
  acceptedRequest?: { conversation_id: string; thread_id: string; leaseToken: string };
  getSql: () => Sql;
  route: (params: {
    workspaceId: string;
    requesterId: string;
    question: string;
    /** Exact durable subject (relevance-router `subjectRef`); forwarded from the request. */
    subjectRef?: string | null;
    /** Full source-ref set, including public-manual `documents:` anchors. */
    subjectRefs?: string[];
    /** Unexpanded public-manual document refs; candidates cannot clear the floor with these present. */
    unresolvedSubjectRefs?: string[];
    excludeOwners?: string[];
  }) => Promise<RouteResult>;
  /** Opens the kind='consult' conversation (bound to openConversation in prod). */
  open: (input: {
    id?: string;
    kind: 'consult';
    title: string;
    body: string;
    topics?: string[];
    harness_slug?: string;
    direct_to: string[];
  }) => Promise<{ conversation_id: string; thread_id: string; delivered: number }>;
  /**
   * DELIVERY — get `responder`'s knowledge ANSWERING, by forking or converting
   * their session (prod binds `makeConsultReachDispatcher`; D-002/D-010).
   *
   * ⚠ This seam used to mean "directed ping + wake" and no longer does. A
   * consult never messages a live agent: `responder` names the expert whose
   * TRANSCRIPT answers, and a non-zero `queued` means an answering session was
   * launched from it. Zero means the whole ranked allowlist was exhausted for
   * that expert, which this core treats as "advance to the next selectee".
   *
   * `answeringOwnerId` is the identity that will actually post. It differs from
   * `responder` on a FORK (psu mints — here, pre-pins — a new coord id so the
   * fork cannot collide with a still-live original) and equals it on a
   * conversion. The core persists it so the answering session's first
   * `consult:reply` has a participant gate to pass.
   */
  reach: (opts: {
    responder: string;
    conversationId: string;
    summary: string;
    body: string;
    /** Exact session-turn evidence selected by the router. */
    evidence?: Array<{ session_id: string; turn_idx: number; ts?: string | null; sim?: number; lexicalRank?: number }>;
    /** Persist the answering identity AS SOON AS that session is running —
     *  before the dispatcher's verification wait, which it can post during. */
    onAnsweringOwner?: (answeringOwnerId: string) => void | Promise<void>;
  }) => Promise<{
    /** Answering sessions launched (0 or 1). Legacy bindings report `woke`. */
    queued?: number;
    /** Execution-confirmed: a launch whose kickoff persisted AND whose host registered. */
    woke?: number;
    pickupConfirmed?: boolean;
    /** Who will post — the fork's new identity, or the source on a conversion. */
    answeringOwnerId?: string | null;
    /** No source candidate can repair this native target's provider capacity. */
    targetCapacityUnavailable?: string;
    /** HOW it was reached, for the requester-facing provenance note. Optional so
     *  a PG-free or legacy binding keeps the plain delivery-count contract. */
    dispatch?: {
      operation: 'fork' | 'convert' | 'brief' | null;
      agent: string | null;
      model: string | null;
      verified: boolean | null;
      detail: string;
    };
  }>;
  /** Start the existing leased delivery continuation after accepted selection
   * commits its launch brief. The sweep recovers if this process stops first. */
  resumeInitialDispatch?: (conversationId: string) => void;
  now?: () => Date;
}

export interface AcceptedFeedbackResult {
  ok: true;
  verdict: 'accepted';
  conversation_id: string;
  thread_id: string;
  request_key: string;
  state: string;
  pending: boolean;
  /** Persisted routing outcome; lifecycle state alone cannot distinguish an
   * unmeasured route, a measured absence, or deliberate retrieval-only. */
  result?: GetFeedbackResult | GetFeedbackError;
  latency_contract: LatencyContract;
  park_key: string | null;
  hint: string;
}

interface AcceptedRequest {
  version: 1;
  key: string;
  fingerprint: string;
  payload: GetFeedbackRequest;
  leaseToken?: string | null;
  leaseUntil?: string | null;
  attempts?: number;
  result?: GetFeedbackResult | GetFeedbackError;
  lastError?: string;
}

function requestFingerprint(req: GetFeedbackRequest): string {
  // Normalize object order and undefined values so a transport retry hashes
  // identically even when its client serializes optional fields differently.
  const canonical = (value: unknown): unknown => Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key, v]) => key !== 'requestKey' && v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]))
      : value;
  return createHash('sha256').update(JSON.stringify(canonical(req))).digest('hex');
}

/** Persist before embeddings or launches. Conversation-store creation and the
 * consult PK both converge on the same requester/workspace/key identity. */
export async function acceptFeedbackRequestCore(
  req: GetFeedbackRequest,
  deps: Pick<GetFeedbackDeps, 'getSql' | 'open'>,
): Promise<AcceptedFeedbackResult | { error: 'request_key_conflict'; conversation_id: string; hint: string }> {
  methodReviewTarget(req);
  const sql = deps.getSql();
  const fingerprint = requestFingerprint(req);
  const key = req.requestKey?.trim() || `auto:${fingerprint}`;
  const id = `conv-request-${createHash('sha256').update(JSON.stringify([req.workspaceId, req.requesterId, key])).digest('hex')}`;
  const opened = await deps.open({ id, kind: 'consult', title: consultTitle(req.question), body: consultBody(req),
    ...(req.topics?.length ? { topics: req.topics } : {}),
    ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}), direct_to: [] });
  const request: AcceptedRequest = { version: 1, key, fingerprint, payload: req, attempts: 0 };
  await sql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, state, question, latency_contract, routing)
    VALUES (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId}, 'routing', ${req.question},
      ${req.latencyContract ?? 'proceed'}, ${sql.json({
        deliveryIntent: req.allowDispatch === false ? 'retrieval-only' : 'dispatch', request,
      } as never)})
    ON CONFLICT (workspace_id, conversation_id) DO NOTHING`;
  const rows = await sql<{ state: string; routing: { request: AcceptedRequest } }[]>`
    SELECT state, routing FROM harness_shared.consult_state
    WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${opened.conversation_id}
      AND requester_id = ${req.requesterId}`;
  const row = rows[0];
  if (!row || row.routing.request?.fingerprint !== fingerprint) return {
    error: 'request_key_conflict', conversation_id: opened.conversation_id,
    hint: 'This request_key already names a different question or options. Reuse its original payload for recovery, or use a new key for a fresh consult.',
  };
  const latency = req.latencyContract ?? 'proceed';
  const result = row.routing.request.result;
  const outcomeHint = result?.hint ?? (row.state === 'routing' ? ''
    : 'No routing result is recorded; lifecycle state is not a measured no-expert verdict.');
  return { ok: true, verdict: 'accepted', conversation_id: opened.conversation_id, thread_id: opened.thread_id,
    request_key: key, state: row.state,
    ...(result ? { result } : {}),
    pending: !row.routing.request.result && ['routing', 'awaiting_responder', 'active'].includes(row.state),
    latency_contract: latency, park_key: latency === 'hard-blocked' ? consultParkKey(opened.conversation_id) : null,
    hint: `Accepted as ${opened.conversation_id}; current state is ${row.state}. ${outcomeHint ? `${outcomeHint} ` : ''}Read conversations:get { id: '${opened.conversation_id}' } for routing and replies. Reuse request_key '${key}' with the same payload after a timeout; use a new key for a fresh consult. Pending means accepted work, not a launched or answered session.` };
}

/** A bounded CAS lease owns preparation. Once the core commits the selected
 * awaiting row, retries leave delivery to its existing stamp/attempt/expiry
 * lifecycle; they never replay the launch because a response was lost. */
export async function continueFeedbackRequestCore(
  workspaceId: string,
  conversationId: string,
  deps: { getSql: () => Sql; now?: () => Date;
    execute: (req: GetFeedbackRequest, accepted: NonNullable<GetFeedbackDeps['acceptedRequest']>) => Promise<GetFeedbackResult | GetFeedbackError> },
): Promise<boolean> {
  const sql = deps.getSql();
  const now = deps.now?.() ?? new Date();
  const token = randomUUID();
  const rows = await sql<{ requester_id: string; routing: { request: AcceptedRequest } }[]>`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(routing, '{request}', (routing->'request') ||
         ${sql.json({ leaseToken: token, leaseUntil: new Date(now.getTime() + 120_000).toISOString() } as never)}),
           updated_at = ${now.toISOString()}::timestamptz
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
       AND state = 'routing' AND closed_at IS NULL AND routing #>> '{request,version}' = '1'
       AND COALESCE((routing #>> '{request,leaseUntil}')::timestamptz, '-infinity'::timestamptz) <= ${now.toISOString()}::timestamptz
     RETURNING requester_id, routing`;
  const row = rows[0];
  if (!row) return false;
  const request = row.routing.request;
  if (request.payload.workspaceId !== workspaceId || request.payload.requesterId !== row.requester_id ||
      request.fingerprint !== requestFingerprint(request.payload)) throw new Error('consult-request-provenance-mismatch');
  try {
    const result = await deps.execute(request.payload, { conversation_id: conversationId, thread_id: `thr-${conversationId}`, leaseToken: token });
    await sql`
      UPDATE harness_shared.consult_state SET routing = jsonb_set(routing, '{request}',
        (routing->'request') || ${sql.json({ result, leaseToken: null, leaseUntil: null } as never)}),
        state = CASE WHEN state = 'routing' THEN 'no_qualified_responder' ELSE state END
      WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
        AND routing #>> '{request,leaseToken}' = ${token}`;
  } catch (error) {
    const attempts = (request.attempts ?? 0) + 1;
    await sql`
      UPDATE harness_shared.consult_state SET routing = jsonb_set(routing, '{request}',
        (routing->'request') || ${sql.json({ attempts, leaseToken: null,
          leaseUntil: new Date(now.getTime() + 30_000).toISOString(),
          lastError: String(error).slice(0, 500) } as never)}),
        state = CASE WHEN state = 'routing' AND ${attempts} >= 3 THEN 'no_qualified_responder' ELSE state END
      WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
        AND routing #>> '{request,leaseToken}' = ${token}`;
    throw error;
  }
  return true;
}

/**
 * Record WHO will actually post, on the selection entry the cascade cursor is
 * pointing at. A FORK answers under a new identity, so without this stamp the
 * answering session's first `consult:reply` is refused `not_a_participant`:
 * `responder_id` names the expert whose KNOWLEDGE was routed, which is the right
 * thing for it to name and is not who holds the keyboard.
 *
 * A jsonb_set on a path that does not exist yet is a no-op, and `selection` is
 * always written before dispatch, so the cursor entry is always there. Written
 * as its own bounded statement rather than folded into a larger UPDATE because
 * the answering session may ALREADY have replied by the time this lands — the
 * guards keep this write additive so it cannot clobber that turn's work.
 */
export async function stampAnsweringOwner(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
  cursor: number,
  answeringOwnerId: string | null,
): Promise<void> {
  if (!answeringOwnerId) return;
  await sql`
    UPDATE harness_shared.consult_state
       SET routing = jsonb_set(
             routing,
             ARRAY['selection', 'selected', ${String(cursor)}, 'answeringOwnerId'],
             -- to_jsonb, NOT a JSON.stringify'd parameter cast ::jsonb — see
             -- cascade-core's stamp: the double-encoded form stores "\"su-x\""
             -- and the answering session is then refused not_a_participant.
             to_jsonb(${answeringOwnerId}::text)
           )
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
       AND routing #>> ARRAY['selection', 'selected', ${String(cursor)}, 'ownerId'] IS NOT NULL
  `;
}

export interface GetFeedbackResult {
  ok: true;
  /**
   * `no_qualified_responder` is a measured finding: relevance WAS computed and
   * no peer cleared the floor, so proceeding alone is correct and a retry buys
   * nothing. `relevance_unmeasured` is not a finding at all — the embedder was
   * unavailable, so no similarity was ever computed and this result makes no
   * claim about who knows what; a retry is exactly the right response. They were
   * one value until EI-21485716602970457, which made a cold-start latency breach
   * read as "no one knows more than you do": the same question, re-asked minutes
   * later, routed to a peer at similarity 0.864.
   *
   * Note `verdict` and `state` are deliberately NOT the same field — `routed`
   * already pairs with state `awaiting_responder`. `verdict` reports the routing
   * outcome; `state` reports the conversation's lifecycle, which on this path is
   * still genuinely "no responder attached" and is what the DB CHECK persists.
   */
  /** `no_launchable_responder` (consult-backed-parking P-003, bar R-2): experts
   * WERE selected but no answering session could be launched for any of them.
   * That is a dispatch failure, not the measured absence `no_qualified_responder`
   * reports, so the two never share a verdict or a stored state. */
  verdict: 'routed' | 'no_qualified_responder' | 'no_launchable_responder' | 'served_from_archive' | 'relevance_unmeasured' | 'retrieval_only';
  /** WHY, honestly (D-003: distinct causes must stay distinguishable).
   * `embed_unavailable` / `evidence_unavailable` accompany verdict
   * `relevance_unmeasured`; `below_floor` accompanies `no_qualified_responder`;
   * `no_available_responder` accompanies `no_launchable_responder`. */
  reason?: 'below_floor' | 'no_available_responder' | 'embed_unavailable' | 'evidence_unavailable' | 'retrieval_only';
  conversation_id: string;
  thread_id: string;
  /** 'served_from_archive' is a TS-surface state only — the DB row reuses
   * state='closed_answered' with outcome.source='archive' (P-006; no enum
   * widening in migration 834's CHECK). */
  state: 'awaiting_responder' | 'no_qualified_responder' | 'no_launchable_responder' | 'served_from_archive';
  responder: RoutingCandidate | null;
  /** How the responder entered the selected set (D-002): 'floor' = cleared the
   * routing floors; 'minimum' = best-available fill below them (weigh the
   * reply as a first-principles review). Null when no responder. */
  responder_via: SelectionVia | null;
  /** The rest of the SELECTED cascade menu, best first. The SERVER drains
   * this menu itself (D-005 always-advance: reply/decline/expiry dispatch the
   * next selectee); returned as retrieval refs, not a re-call worklist. On
   * no_available_responder it falls back to the floor-qualified candidates so
   * the retrieval path keeps its refs. */
  remaining_candidates: Array<{
    ownerId: string;
    score: number;
    liveness: string;
    via: SelectionVia;
    fallback?: 'lexical';
  }>;
  origin_task_ref: string | null;
  latency_contract: LatencyContract;
  expires_at: string | null;
  /** D-002: no agent is woken, so these count ANSWERING-SESSION LAUNCHES. The
   *  field keeps its name because every consumer reads it as "did delivery
   *  happen", which is still exactly what it answers. */
  wake: {
    attempted: boolean;
    /** Answering sessions launched for this consult (0 or 1). */
    queued: number;
    /** Launches whose kickoff persisted AND whose host registered — a started turn. */
    woke: number;
    /** Whether that registration was observed within the dispatch wait window. */
    pickupConfirmed: boolean;
  };
  /** Latched park key for a hard-blocked requester (P-004 reply verbs emit). */
  park_key: string | null;
  /** D-002 dispatch provenance: HOW the answer is being produced. The identity
   *  that will post differs from `responder` on a fork — `responder` names whose
   *  KNOWLEDGE was routed, `answering_owner_id` names who reasons over it. */
  dispatch?: {
    sourceOwnerId: string;
    answeringOwnerId: string | null;
    operation: 'fork' | 'convert' | 'brief' | null;
    agent: string | null;
    model: string | null;
    verified: boolean | null;
    detail: string;
  };
  /** P-006 archive-serve provenance — present only on served_from_archive. */
  archive?: {
    source_conversation_id: string;
    responder_id: string | null;
    closed_at: string | null;
    sim: number;
    /** The source consult's structured outcome VERBATIM (D-001 shape:
     * { answer?, confidence?, evidence?, reason? }). */
    answer: unknown;
  };
  degraded?: 'embed-unavailable' | 'evidence-unavailable';
  hint: string;
}

/** One archive-candidate row from the P-006 retrieval lookup. */
interface ConsultArchiveRow {
  conversation_id: string;
  responder_id: string | null;
  outcome: unknown;
  closed_at: string | Date | null;
  question: string;
  sim: number;
}

/**
 * Extract the stable subject identifiers from a consult question. Embedding
 * similarity is deliberately broad; these exact refs are the safety fence for
 * archive reuse when a question names a rubric, plan, or other durable object.
 * A question without named refs remains compatible only with another question
 * without named refs, so a specific archived answer cannot silently answer a
 * generic request (or vice versa).
 * Version-stamped slugs are also refs when callers omit the kind word, as in
 * "vet acceptance-example-2026-08-30". Without this fallback, both that
 * specific request and an unrelated dated rubric can look subjectless here.
 */
export function consultSubjectKeys(question: string): string[] {
  const keys = new Set<string>();
  const namedSubject = /\b(rubric|plan|goal|feature|work[\s-]*item)\s*[:#=]?\s*([a-z0-9][a-z0-9._/-]*-[a-z0-9._/-]*)/gi;
  for (const match of question.matchAll(namedSubject)) {
    const kind = match[1].toLowerCase().replace(/[\s-]+/g, '-');
    keys.add(`${kind}:${match[2].toLowerCase()}`);
  }
  const untypedDatedSlug = /\b([a-z0-9][a-z0-9._/]*(?:-[a-z0-9][a-z0-9._/]*){1,}-\d{4}-\d{2}-\d{2})\b/gi;
  for (const match of question.matchAll(untypedDatedSlug)) {
    keys.add(`slug:${match[1].toLowerCase()}`);
  }
  // EI- tails are ~17 digits and slotted WI- ids are 16 (migration 1442), so the
  // digit run must not be capped below that: a capped run plus \b matches nothing.
  const explicitIds = /\b((?:WI|EI|F|D)-\d{1,20})\b/gi;
  for (const match of question.matchAll(explicitIds)) keys.add(`id:${match[1].toUpperCase()}`);
  // A review of the same subject can become stale when its criteria change.
  // Keep explicitly requested revision/digest pins in the archive identity too;
  // an unpinned answer cannot stand in for a pinned construction review.
  const revisionPin = /\b(?:rev(?:ision)?)[\s:#=]*(\d+)\b/gi;
  for (const match of question.matchAll(revisionPin)) keys.add(`revision:${match[1]}`);
  const hashPin = /\b(?:criteria[\s_-]*)?hash[\s:#=]*([a-f0-9]{7,64})\b/gi;
  for (const match of question.matchAll(hashPin)) keys.add(`hash:${match[1].toLowerCase()}`);
  return [...keys].sort();
}

function archiveSubjectsMatch(currentQuestion: string, archivedQuestion: string): boolean {
  const current = consultSubjectKeys(currentQuestion);
  const archived = consultSubjectKeys(archivedQuestion);
  return current.length === archived.length && current.every((key, i) => key === archived[i]);
}

/**
 * A rubric critique is an INDEPENDENCE task, not an expertise task: someone
 * who already emitted a scorecard on the instrument must not be selected to
 * reshape that same instrument. Relevance is actively inverted here — the
 * grader is likely to rank highly precisely because they just graded it.
 *
 * `consult:get_feedback` has no structured subject arg, so derive a bounded
 * candidate set from the question and let the scorecard ledger resolve which
 * tokens are ACTUAL rubric refs. The broad hyphenated-token leg is deliberate:
 * real critique prompts often say only "critique acceptance-foo-2026-08-25"
 * (the EI-21469207548268721 incident), without the word `rubric` adjacent to
 * the ref. Non-rubric tokens are harmless because the SQL exact-match removes
 * them. Explicit `rubricRef: 'simple'` syntax also supports refs without a
 * hyphen. Cap before SQL so an adversarial prose body cannot widen the query.
 */
const RUBRIC_REF_CANDIDATE_CAP = 64;

function rubricRefCandidates(question: string): string[] {
  const refs = new Set<string>();
  const explicit = /\brubric(?:Ref)?\s*[:#=]?\s*['"`]?([a-z0-9][a-z0-9._/-]{0,199})/gi;
  for (const match of question.matchAll(explicit)) {
    refs.add(match[1]);
    if (refs.size >= RUBRIC_REF_CANDIDATE_CAP) return [...refs];
  }
  const durableTokens = /\b([a-z0-9][a-z0-9._/-]{2,199})\b/gi;
  for (const match of question.matchAll(durableTokens)) {
    const token = match[1];
    if (!token.includes('-')) continue;
    refs.add(token);
    if (refs.size >= RUBRIC_REF_CANDIDATE_CAP) break;
  }
  return [...refs];
}

function isRubricCritiqueQuestion(question: string): boolean {
  return /\b(critique|critic|vet|vetting|review|audit)\b/i.test(question);
}

async function rubricGraderExclusions(
  sql: Sql,
  workspaceId: string,
  question: string,
): Promise<string[]> {
  if (!isRubricCritiqueQuestion(question)) return [];
  const refs = rubricRefCandidates(question);
  if (refs.length === 0) return [];

  // Scorecards are issue-family work_items whose canonical discriminator is
  // payload.observation.rubricRef. The emitter is persisted by the issue-view
  // writer at payload._ei.created_by and projected by scorecards:list as
  // ScorecardRow.createdBy. Read those WRITER-backed fields directly so this
  // gate cannot drift from what scorecards:list calls a grader. The rubric plan
  // itself is a second authoring identity source: harness_plans.owner is the
  // original author, while template_data.proposedBy is the latest proposer.
  const [scorecardRows, rubricRows] = await Promise.all([
    sql`
      SELECT DISTINCT payload -> '_ei' ->> 'created_by' AS owner_id
       FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         -- Match migration 1103's expression exactly so the tiny partial
         -- work_items_obs_rubric_ref_v2_idx is usable. The accessor is LOAD-BEARING,
         -- not cosmetic: an expression index is matched structurally, so the
         -- semantically-equal _ei-subtracting traversal silently misses it and this
         -- becomes a full scan of a 173k-row / 4.5GB table. That subtracting form was
         -- correct against migration 842, until 1096 stopped the engineer_issues view
         -- subtracting _ei and thereby orphaned both 842 indexes (WI-2143953).
         -- Keep this accessor identical to 1103's index expression.
         AND payload -> 'observation' ->> 'rubricRef' = ANY(${refs}::text[])
         AND payload -> '_ei' ->> 'created_by' IS NOT NULL
    ORDER BY owner_id
    `,
    sql`
      SELECT owner AS author_id, template_data ->> 'proposedBy' AS proposer_id
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND template = 'rubric'
         AND template_slug IS NULL
         AND plan_slug = ANY(${refs}::text[])
       ORDER BY plan_slug, author_id, proposer_id
    `,
  ]) as unknown as [
    Array<{ owner_id: string }>,
    Array<{ author_id: string | null; proposer_id: string | null }>,
  ];
  return [
    ...scorecardRows.map((row) => row.owner_id),
    ...rubricRows.flatMap((row) => [row.author_id, row.proposer_id].filter((id): id is string => Boolean(id))),
  ];
}

/**
 * EI-22180634511432554: a responder's `closed_cant_help` (D-003/the
 * responder-verb-menu void exit) and a fully-declined, menu-exhausted
 * `declined` terminal are both HONEST, deliberately NON-ADVANCING outcomes —
 * `consultCloseCore` never calls `advanceCascade` for either (by design, see
 * responder-verb-menu.ts's void-exit doc). But nothing else in this module
 * remembered that outcome either: a caller who re-asks the verbatim-identical
 * question — the natural recovery move after a non-advancing close — got no
 * benefit from it. Routing ran from scratch and could re-select the exact
 * responder who had just said, on this exact question, that they could not or
 * would not help — wasting a full consult cycle, re-declining a second time,
 * and silently minting a second, now-stale conversation id while a genuinely
 * untried candidate sat unselected in `remaining_candidates`.
 *
 * Fold every responder who told THIS requester "not this one" on the
 * verbatim-identical question into `excludeOwners` automatically, mirroring
 * the existing `rubricGraderExclusions` seam. EXACT question match only
 * (never embedding similarity, unlike the archive-serve floor above) — this
 * answers "did you ask this exact thing before", never "a related topic", so
 * it can never over-exclude a merely-similar re-ask.
 *
 * `responder_id` alone would miss a `declined` menu-exhaustion row's EARLIER
 * decliners (the column tracks only the cascade's current/last cursor).
 *
 * ⚠ WI-10002406 — `cascade_digest` IS NOT A COMPLETE RECORD, and this comment
 * used to assert that it was ("the append-only record of who declined this
 * consult, in order"). It is append-only with a SLIDING WINDOW: `cascade-core`
 * writes `[...digestFromRow(prev), event].slice(-CASCADE_DIGEST_MAX_ENTRIES)`
 * with a cap of 16, so once a cascade exceeds 16 chain-advancing events
 * (replies + declines + expiries) its OLDEST entries are dropped. A decline
 * that fell out of that window was invisible here, and the agent who made it
 * became eligible to be re-offered the verbatim-identical question. The
 * failure direction is the bad one — an under-report is indistinguishable from
 * "nobody declined", so there is no error and nothing to notice.
 *
 * The COMPLETE decline record is `consult_post_meta`: one immutable row per
 * decline post, neither truncated nor advanced, joined per conversation. Same
 * source, and for the same reason, as `acceptance-grader.ts`'s
 * `resolvePriorGradingDecliners` (WI-10002369).
 *
 * All three sources are UNIONED, never swapped:
 *  - `consult_post_meta` is the complete, authoritative decline set;
 *  - `responder_id` stays load-bearing for `closed_cant_help`, whose terminal
 *    non-advancing close leaves the closer sitting in that column;
 *  - the digest fold is retained as belt-and-braces, so a decline recorded as a
 *    cascade event without a corresponding post row cannot be lost.
 * Union-only means this can never exclude FEWER agents than before — the one
 * direction that would reintroduce the bug.
 */
export async function priorNonHelpfulResponders(
  sql: Sql,
  workspaceId: string,
  requesterId: string,
  question: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT cs.responder_id, cs.cascade_digest, pm.author_id AS decline_author
      FROM harness_shared.consult_state cs
      LEFT JOIN harness_shared.consult_post_meta pm
        ON pm.workspace_id = cs.workspace_id
       AND pm.conversation_id = cs.conversation_id
       AND pm.kind = 'decline'
       AND pm.author_id IS NOT NULL
     WHERE cs.workspace_id = ${workspaceId}
       AND cs.requester_id = ${requesterId}
       AND cs.question = ${question}
       AND cs.state IN ('closed_cant_help', 'declined')
  `) as unknown as Array<{
    responder_id: string | null;
    cascade_digest: unknown;
    decline_author: string | null;
  }>;
  const owners = new Set<string>();
  for (const row of rows) {
    if (row.responder_id) owners.add(row.responder_id);
    if (row.decline_author) owners.add(row.decline_author);
    for (const entry of digestFromRow(row.cascade_digest)) {
      if (entry.kind === 'decline') owners.add(entry.ownerId);
    }
  }
  return [...owners];
}

function consultTitle(question: string): string {
  const q = question.replace(/\s+/g, ' ').trim();
  return `consult: ${q.length > 90 ? `${q.slice(0, 90)}…` : q}`;
}

function consultBody(req: GetFeedbackRequest): string {
  const parts = [req.question.trim()];
  if (req.tried?.trim()) parts.push(`## Tried\n${req.tried.trim()}`);
  if (req.observed?.trim()) parts.push(`## Observed\n${req.observed.trim()}`);
  if (req.decisionAtStake?.trim()) parts.push(`## Decision at stake\n${req.decisionAtStake.trim()}`);
  parts.push(`_latency contract: ${req.latencyContract ?? 'proceed'}_`);
  return parts.join('\n\n');
}

/** Structural minimum the why-you-were-chosen evidence line needs from a
 * candidate. RoutingCandidate satisfies it, and so does a candidate parsed back
 * from the persisted D-008 routing snapshot (score/signals/evidence are stored
 * verbatim). */
export interface BriefCandidate {
  /** Stage-2 comparison score (relevance × freshness). */
  score: number;
  /** Stage-1 qualification score — the number the relevance floor judged, and
   * therefore the one that justifies reviving this responder at all. */
  relevance: number;
  signals: { similarity: number };
  evidence: Array<{ session_id: string; turn_idx: number; sim: number; lexicalRank?: number }>;
}

/**
 * EI-24833606853730057: tell "refused before any model was tried" apart from "every
 * model was walled" using the consult's persisted dispatch walks. A walk that
 * records `dispatched:false` with an EMPTY `attempts` list never reached the rank
 * loop (source ownership, transcript availability, cool-down…), so no account reset
 * will fix it, and the requester's hint must not claim one will.
 */
export function summarizePreLaunchRefusals(walks: unknown): { total: number; refused: number; details: string[] } {
  const list = Array.isArray(walks) ? walks : [];
  let total = 0;
  let refused = 0;
  const details: string[] = [];
  for (const walk of list) {
    if (!walk || typeof walk !== 'object') continue;
    const w = walk as { dispatched?: unknown; attempts?: unknown; detail?: unknown };
    if (w.dispatched !== false) continue;
    total += 1;
    if (!Array.isArray(w.attempts) || w.attempts.length > 0) continue;
    refused += 1;
    const detail = typeof w.detail === 'string' ? w.detail.trim() : '';
    if (detail && !details.includes(detail) && details.length < 3) details.push(detail.slice(0, 240));
  }
  return { total, refused, details };
}

/** Compact why-you-were-chosen evidence for the wake body (D-008 §5) — refs
 * resolvable via sessions:read, so relevance validation is a cheap check. */
function evidenceLine(c: Pick<BriefCandidate, 'evidence'>): string {
  const source = selectConsultEvidenceSource(c.evidence);
  return (source?.evidence ?? [])
    .map((e) =>
      e.lexicalRank !== undefined
        ? `${e.session_id}#${e.turn_idx} (lexical rank ${e.lexicalRank.toFixed(3)})`
        : `${e.session_id}#${e.turn_idx} (sim ${(e.sim ?? 0).toFixed(2)})`,
    )
    .join('; ');
}

/**
 * Did anyone actually CRITIQUE this consult?
 *
 * (consult-min-max-and-rubric-vetting-2026-08-17 P-004; tightened by
 * EI-20821478338037350.) scorecards:emit validates a `vettingConsult` before
 * stamping it, because the acceptance gate trusts the stamp rather than
 * re-querying. The original predicate was a bare `consult_state` EXISTENCE
 * check, which validated LINKAGE ("the consult row is real") and was read
 * downstream as VETTING ("critique happened") — so a consult that was opened
 * and never answered satisfied the ship gate. That is the vacuous-green shape
 * the vetting gate exists to prevent, one level up.
 *
 * A CRITIQUE POST here is one authored by a KNOWN third party — neither the
 * emitter attesting the vetting nor the consult's own requester, whose posts
 * are the ask, not the answer — with a kind other than 'decline'. Two
 * deliberate exclusions:
 *  - 'decline' ("my context does not cover this") is the documented
 *    no-responder path, not critique; counting it would rebuild the same hole
 *    one rung lower.
 *  - a NULL author_id cannot be attributed to a third party, so it cannot
 *    evidence external critique.
 * Every other kind counts: a `clarifying_question` from a live reviewer is
 * genuine engagement with the rubric, and being stricter than that just pushes
 * honest authors onto the waiver path.
 *
 * Deps-injected `sql` like everything else in this module, so callers bind
 * their own seam.
 */
export interface VettingConsultCritique {
  /** false ⇒ no consult_state row: a dangling link, not an unanswered consult. */
  exists: boolean;
  /** The consult's fine-grained lifecycle state, for a refusal that can say WHY. */
  state: string | null;
  /** Third-party posts that constitute critique (see the kind rules above). */
  critiquePosts: number;
  /** Third-party 'decline' posts — reviewers who explicitly could not help. */
  declinePosts: number;
  /** Distinct authors of the critique posts, so the stamp can name the critics. */
  critics: string[];
  /** Present only when the emitter is the persisted rubric-vetting answerer and authored a non-decline critique post. */
  routedVettingCritic?: string;
  /**
   * Present when the caller supplied rubric/plan refs to bind the consult to a
   * specific vetting subject. A match must occur in the durable opening
   * question or an archive-served answer.
   */
  relevance?: {
    matched: boolean;
    matchedRefs: string[];
    via: Array<'question' | 'archive-answer'>;
  };
}

function vettingConsultRelevance(
  refs: readonly string[],
  sources: Array<{ via: 'question' | 'archive-answer'; text: unknown }>,
): NonNullable<VettingConsultCritique['relevance']> | undefined {
  const normalizedRefs = [...new Set(refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0))];
  if (normalizedRefs.length === 0) return undefined;
  const matchedRefs = new Set<string>();
  const via = new Set<'question' | 'archive-answer'>();
  for (const source of sources) {
    if (typeof source.text !== 'string') continue;
    const haystack = source.text.toLocaleLowerCase();
    for (const ref of normalizedRefs) {
      if (!haystack.includes(ref.toLocaleLowerCase())) continue;
      matchedRefs.add(ref);
      via.add(source.via);
    }
  }
  return { matched: matchedRefs.size > 0, matchedRefs: [...matchedRefs], via: [...via] };
}

/** A consult's source responder and the session that actually answered can
 * differ. Only the router's durable rubric-vetting policy + answeringOwnerId
 * stamp can let that answerer count their own critique as evidence for the
 * scorecard they authored. */
function isRoutedRubricVettingAnswerer(routing: unknown, emitterId: string): boolean {
  let snapshot = routing;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot) as unknown;
    } catch {
      return false;
    }
  }
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const root = snapshot as Record<string, unknown>;
  if (root.policy !== RUBRIC_VETTING_POLICY) return false;
  const selection = root.selection;
  if (selection === null || typeof selection !== 'object' || Array.isArray(selection)) return false;
  const selected = (selection as Record<string, unknown>).selected;
  return (
    Array.isArray(selected) &&
    selected.some((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
      return (entry as Record<string, unknown>).answeringOwnerId === emitterId;
    })
  );
}

/**
 * P-006 archive-served consults intentionally have no posts on the wrapper
 * conversation. Their outcome carries the source consult's structured answer
 * and responder provenance instead, so the vetting gate must read that answer
 * as one attributed critique rather than treating the empty wrapper thread as
 * unanswered.
 */
function archivedVettingCritic(outcome: unknown): string | null {
  if (outcome == null || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  const archive = outcome as Record<string, unknown>;
  if (archive.source !== 'archive' || typeof archive.source_conversation_id !== 'string') return null;
  if (archive.source_conversation_id.trim() === '') return null;

  const answer = archive.answer;
  if (answer == null || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const answerText = (answer as Record<string, unknown>).answer;
  if (typeof answerText !== 'string' || answerText.trim() === '') return null;

  const responderId =
    typeof archive.source_responder_id === 'string' && archive.source_responder_id.trim() !== ''
      ? archive.source_responder_id
      : null;
  return responderId;
}

export async function readVettingConsultCritique(
  sql: Sql,
  workspaceId: string,
  conversationId: string,
  emitterId: string,
  relevanceRefs: readonly string[] = [],
): Promise<VettingConsultCritique> {
  const stateRows = (await sql`
    SELECT state, requester_id, responder_id, question, outcome, routing
      FROM harness_shared.consult_state
     WHERE workspace_id = ${workspaceId} AND conversation_id = ${conversationId}
     LIMIT 1
  `) as unknown as Array<{
    state: string;
    requester_id: string;
    responder_id: string | null;
    question: string;
    outcome: unknown;
    routing: unknown;
  }>;
  const stateRow = stateRows[0];
  if (!stateRow) {
    return {
      exists: false,
      state: null,
      critiquePosts: 0,
      declinePosts: 0,
      critics: [],
      ...(relevanceRefs.length > 0
        ? { relevance: vettingConsultRelevance(relevanceRefs, [])! }
        : {}),
    };
  }

  // Archive-served wrappers are closed_answered consult_state rows with an
  // empty wrapper thread by design (P-006). Count their copied structured
  // answer once, attributed to the original responder, while preserving the
  // same self/requester exclusions as real posts. A provenance-only or
  // malformed archive payload remains zero critique and keeps the gate honest.
  const archivedCriticFromOutcome = archivedVettingCritic(stateRow.outcome);
  const archivedCritic = stateRow.responder_id ?? archivedCriticFromOutcome;
  const isArchiveAnswer = archivedCriticFromOutcome !== null;
  if (isArchiveAnswer && archivedCritic && archivedCritic !== emitterId && archivedCritic !== stateRow.requester_id) {
    const archiveAnswer = (stateRow.outcome as { answer?: { answer?: unknown } }).answer?.answer;
    return {
      exists: true,
      state: stateRow.state,
      critiquePosts: 1,
      declinePosts: 0,
      critics: [archivedCritic],
      ...(relevanceRefs.length > 0
        ? {
            relevance: vettingConsultRelevance(relevanceRefs, [
              { via: 'question', text: stateRow.question },
              { via: 'archive-answer', text: archiveAnswer },
            ])!,
          }
        : {}),
    };
  }

  const emitterIsRoutedVettingAnswerer =
    emitterId !== stateRow.requester_id && isRoutedRubricVettingAnswerer(stateRow.routing, emitterId);
  const postRows = (await sql`
    SELECT kind, author_id
      FROM harness_shared.consult_post_meta pm
     WHERE pm.workspace_id = ${workspaceId}
       AND pm.conversation_id = ${conversationId}
       AND pm.author_id IS NOT NULL
       AND pm.author_id <> ${stateRow.requester_id}
  `) as unknown as { kind: string; author_id: string }[];

  const critics = new Set<string>();
  let critiquePosts = 0;
  let declinePosts = 0;
  let routedVettingCritic: string | undefined;
  for (const post of postRows) {
    if (post.author_id === emitterId && !emitterIsRoutedVettingAnswerer) continue;
    if (post.kind === 'decline') {
      declinePosts += 1;
      continue;
    }
    critiquePosts += 1;
    critics.add(post.author_id);
    if (post.author_id === emitterId && emitterIsRoutedVettingAnswerer) routedVettingCritic = emitterId;
  }
  return {
    exists: true,
    state: stateRow.state,
    critiquePosts,
    declinePosts,
    critics: [...critics].sort(),
    ...(routedVettingCritic ? { routedVettingCritic } : {}),
    ...(relevanceRefs.length > 0
      ? { relevance: vettingConsultRelevance(relevanceRefs, [{ via: 'question', text: stateRow.question }])! }
      : {}),
  };
}

/** Walk the parent_consult_id chain collecting every lineage participant —
 * bounded: the depth CHECK caps a legal chain at MAX_CONSULT_DEPTH+1 rows.
 * Null ⇒ the named parent does not exist in this workspace. */
async function readConsultLineage(
  sql: Sql,
  workspaceId: string,
  parentConsultId: string,
): Promise<{ parentDepth: number; owners: Set<string> } | null> {
  const owners = new Set<string>();
  let parentDepth: number | null = null;
  let cursor: string | null = parentConsultId;
  for (let hop = 0; cursor && hop <= MAX_CONSULT_DEPTH; hop += 1) {
    const rows = (await sql`
      SELECT requester_id, responder_id, depth, parent_consult_id
        FROM harness_shared.consult_state
       WHERE workspace_id = ${workspaceId} AND conversation_id = ${cursor}
    `) as unknown as Array<{
      requester_id: string;
      responder_id: string | null;
      depth: number;
      parent_consult_id: string | null;
    }>;
    const row = rows[0];
    if (!row) break;
    if (hop === 0) parentDepth = row.depth;
    owners.add(row.requester_id);
    if (row.responder_id) owners.add(row.responder_id);
    cursor = row.parent_consult_id;
  }
  return parentDepth == null ? null : { parentDepth, owners };
}

/**
 * D-002 provenance, stated rather than implied: the requester needs to know
 * that the reply will come from a NEW session, not from the expert — otherwise
 * they will read the answer as that agent's considered position and, worse,
 * expect that agent to remember the exchange.
 *
 * consult-backed-parking-2026-10-12 P-002 / D-008: a `brief` launch is a FRESH
 * session holding only the expert's cited turns — never their session — so it
 * gets its own wording instead of the fork/convert one.
 */
export function renderDispatchProvenanceNote(p: GetFeedbackResult['dispatch'] | null | undefined): string {
  if (!p) return '';
  const target = `${p.agent ?? '?'}/${p.model ?? '?'}`;
  const liveness = p.verified === true ? ' (live)' : ' (booting — the cascade expiry guards the reply)';
  if (p.operation === 'brief') {
    return ` 🧭 No agent was woken: launched a FRESH session on ${target}` +
      `${p.answeringOwnerId ? ` as ${p.answeringOwnerId}` : ''}, briefed with turns cited from ` +
      `${p.sourceOwnerId}'s transcript${liveness}. ` +
      `It holds only those quoted turns, not their session; ${p.sourceOwnerId} was not asked and will not remember it.`;
  }
  return ` 🧭 No agent was woken: ${p.operation === 'convert' ? 'CONVERTED' : 'FORKED'} ` +
    `${p.sourceOwnerId}'s session onto ${target}` +
    `${p.answeringOwnerId && p.answeringOwnerId !== p.sourceOwnerId ? ` as ${p.answeringOwnerId}` : ''}` +
    `${liveness}. ` +
    `The answer reasons over their transcript; they were not asked and will not remember it.`;
}

export async function getFeedbackCore(
  req: GetFeedbackRequest,
  deps: GetFeedbackDeps,
): Promise<GetFeedbackResult | GetFeedbackError> {
  const methodReviewRubricRef = methodReviewTarget(req);
  const sql = deps.getSql();
  const now = deps.now ? deps.now() : new Date();
  const latency: LatencyContract = req.latencyContract ?? 'proceed';

  // P-007 / SPEC-P-007-CRITIQUE-REF: a present string is not enough. Check
  // the exact workspace+harness plan key before routing, opening, or writing;
  // this also rechecks durable requests recovered from before the preflight.
  const planRefusal = await validateBarCritiquePlanOrigin(req, sql);
  if (planRefusal) return planRefusal;

  // 0) Recursion lineage (P-005, D-005 / D-007 §7): a consult opened from
  //    within a consult carries parent depth+1 (structural refusal past the
  //    ceiling — never let the DB CHECK be the error surface), and its
  //    lineage's participants are excluded from routing so a cycle cannot
  //    form by construction.
  let depth = 0;
  let lineageOwners: string[] = [];
  if (req.parentConsultId) {
    const lineage = await readConsultLineage(sql, req.workspaceId, req.parentConsultId);
    if (!lineage) {
      return {
        error: 'parent_consult_not_found',
        parent_consult_id: req.parentConsultId,
        hint: 'parent_consult_id must name an existing consult conversation in this workspace — pass the conversation_id of the consult you are answering.',
      };
    }
    depth = lineage.parentDepth + 1;
    if (depth > MAX_CONSULT_DEPTH) {
      return {
        error: 'consult_depth_exceeded',
        depth,
        max_depth: MAX_CONSULT_DEPTH,
        hint: `Consult recursion is capped at depth ${MAX_CONSULT_DEPTH} (D-007 §7) — answer from your own context, or close/decline and let the requester cascade.`,
      };
    }
    lineageOwners = [...lineage.owners];
  }

  // 1) Origin task ref — explicit wins; undefined defaults to the requester's
  //    most recently progressed wip item (task-attribution stat; the D-005
  //    budget that once aggregated on it is removed).
  let originRef: string | null = req.originTaskRef !== undefined ? req.originTaskRef : null;
  if (req.originTaskRef === undefined) {
    const rows = (await sql`
      SELECT feature_id FROM harness_shared.work_items
       WHERE taken_by = ${req.requesterId} AND status = 'wip'
    ORDER BY COALESCE(last_progress_at, taken_at) DESC NULLS LAST
       LIMIT 1
    `) as unknown as Array<{ feature_id: string }>;
    originRef = rows[0]?.feature_id ?? null;
  }

  // 2) Route (one embedding + bounded SQL; snapshot comes back for persisting).
  //    The caller's explicit exclusions (e.g. a fresh route after an
  //    exhausted cascade), recursion lineage, and rubric grader/critic
  //    independence gate fold into ONE existing excludeOwners seam. The last
  //    leg closes EI-21469207548268721: familiarity is a disqualifier when the
  //    task is to critique an instrument the owner already graded against.
  const [graderExclusions, priorNonHelpful] = await Promise.all([
    rubricGraderExclusions(sql, req.workspaceId, req.question),
    priorNonHelpfulResponders(sql, req.workspaceId, req.requesterId, req.question),
  ]);
  const excludeOwners = [
    ...new Set([...(req.excludeOwners ?? []), ...lineageOwners, ...graderExclusions, ...priorNonHelpful]),
  ];
  // Only NEW exclusions this call contributed (vs. what the caller already
  // named) are worth a note — an explicit req.excludeOwners re-call should
  // not get a redundant "auto-excluded" line for owners it named itself.
  const autoExcludedNote = priorNonHelpful.filter((o) => !(req.excludeOwners ?? []).includes(o));
  const route = await deps.route({
    workspaceId: req.workspaceId,
    requesterId: req.requesterId,
    question: req.question,
    subjectRef: req.subjectRef ?? null,
    ...((req.resolvedSubjectRefs ?? req.subjectRefs) !== undefined
      ? { subjectRefs: req.resolvedSubjectRefs ?? req.subjectRefs }
      : {}),
    ...(req.unresolvedSubjectRefs?.length ? { unresolvedSubjectRefs: req.unresolvedSubjectRefs } : {}),
    ...(excludeOwners.length ? { excludeOwners } : {}),
  });
  // The production router applies these exclusions in SQL, but the core also
  // accepts alternate route implementations (for example a degraded or test
  // seam). Enforce the participant boundary here as well so a stale route
  // cannot select or expose an explicitly excluded owner in any result path.
  const explicitlyExcluded = new Set([...(req.excludeOwners ?? []), req.requesterId]);
  // Keep automatically derived lineage exclusions in the pool until the
  // structural cycle check below. That check is an intentional fail-closed
  // guard for a route implementation that violates the lineage contract;
  // silently filtering the owner first would turn the same violation into a
  // misleading ordinary no-route result.
  const cycleCheckOwners = new Set(lineageOwners.filter((owner) => !explicitlyExcluded.has(owner)));
  const excludedFromCandidacy = new Set(
    [...excludeOwners, req.requesterId].filter((owner) => !cycleCheckOwners.has(owner)),
  );
  route.qualified = route.qualified.filter((candidate) => !excludedFromCandidacy.has(candidate.ownerId));
  route.snapshot.deliveryIntent = req.allowDispatch === false ? 'retrieval-only' : 'dispatch';
  route.snapshot.candidates = route.snapshot.candidates.filter(
    (candidate) => !excludedFromCandidacy.has(candidate.ownerId),
  );
  if (req.cascade) {
    route.snapshot.cascade = req.cascade;
    // Exclude from the ENTIRE persisted pool, including refill/revival inputs.
    // The core-level filter above already enforces this for every route; this
    // branch retains the cascade-specific intent as an explicit invariant.
    route.qualified = route.qualified.filter((c) => !excludedFromCandidacy.has(c.ownerId));
    route.snapshot.candidates = route.snapshot.candidates.filter(
      (c) => !excludedFromCandidacy.has(c.ownerId),
    );
  }

  // The real router labels every lexical fallback candidate. Preserve that
  // contract for injected/test route implementations too: a degraded snapshot
  // must never turn an unlabeled token match into an apparently semantic pick.
  if (route.snapshot.fallback === 'lexical') {
    route.snapshot.candidates = route.snapshot.candidates.map((candidate) =>
      candidate.fallback ? candidate : { ...candidate, fallback: 'lexical' as const },
    );
  }

  // 2b) Archive-first retrieval (P-006, D-005/D-006 "retrieval, not consult"):
  //     BEFORE any wake or insert, check whether a CLOSED consult already
  //     answered a highly similar question. A hit is served as a create +
  //     instant-close: the consult row is written state='closed_answered' with
  //     outcome.source='archive' and the source's outcome verbatim — no wake.
  //     Archive-served rows are excluded from candidacy
  //     (outcome->>'source' predicate) so no copy-of-copy chains can form.
  //     The SELECT doubles as the capability probe: pgvector absent / column
  //     not migrated throws, and the leg degrades to normal routing (the
  //     per-source degrade contract) — the INSERT then also skips the column.
  const archiveFloor = req.nativeConsult || req.policy === METHOD_REVIEW_POLICY
    ? 2 : req.archiveFloor ?? DEFAULT_ARCHIVE_FLOOR;
  const qVecStr = route.queryVec && route.queryVec.length > 0 && route.queryProfile
    ? JSON.stringify(route.queryVec)
    : null;
  let embeddingColumnOk = false;
  let archiveHit: ConsultArchiveRow | null = null;
  if (qVecStr) {
    try {
      // Iterative HNSW scan (WI-10004138), as the peers-know twin of this read
      // runs: closed_answered is ~14% of the table. At today's 2.3k rows the
      // planner does not choose the HNSW index and nothing is lost (measured
      // 2026-09-30); this keeps the read whole once it does.
      const queryProfile = route.queryProfile;
      const rows = (await withIterativeScan(sql as unknown as PgHandle, (handle) => {
        const s = handle as unknown as Sql;
        return s`
      SELECT conversation_id, responder_id, outcome, closed_at, question,
               1 - (query_embedding <=> ${qVecStr}::vector) AS sim
          FROM harness_shared.consult_state
         WHERE workspace_id = ${req.workspaceId}
           AND state = 'closed_answered'
           AND query_embedding IS NOT NULL
           AND ${proseProfilePredicateSql(s, queryProfile, 'query_embedding_profile', 'query_embedding_mode')}
           AND (outcome->>'source' IS DISTINCT FROM 'archive')
           AND (responder_id IS NULL OR responder_id <> ALL(${excludeOwners}::text[]))
      ORDER BY query_embedding <=> ${qVecStr}::vector
         LIMIT 3
      `;
      })) as unknown as ConsultArchiveRow[];
      embeddingColumnOk = true;
      const top = rows.find(
        (candidate) =>
          Number(candidate.sim) >= archiveFloor && archiveSubjectsMatch(req.question, candidate.question),
      );
      // A bar critique must be a fresh reading of THIS plan's current bars; an
      // archived answer to a similar question cannot pin them (P-007).
      if (top && req.policy !== BAR_CRITIQUE_POLICY) archiveHit = { ...top, sim: Number(top.sim) };
    } catch {
      embeddingColumnOk = false;
    }
  }
  // ⚠ jsonb params in this module go through sql.json(), never a hand
  // JSON.stringify + ::jsonb: under prepare:true (postgres-js default; the
  // integration fixture) PG describes $n::jsonb as a jsonb param and the
  // driver's jsonb serializer stringifies AGAIN — the row lands as a jsonb
  // STRING scalar whose ->>'key' is NULL, silently breaking the archive
  // exclusion predicate. Prod (buildClient, prepare:false) sends text and
  // single-encodes either way; sql.json() single-encodes under BOTH modes.
  if (archiveHit) {
    const opened = deps.acceptedRequest ?? await deps.open({
      kind: 'consult',
      title: consultTitle(req.question),
      body: consultBody(req),
      ...(req.topics?.length ? { topics: req.topics } : {}),
      ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}),
      direct_to: [],
    });
    const closedAtIso = archiveHit.closed_at ? new Date(archiveHit.closed_at as string).toISOString() : null;
    const outcome = {
      source: 'archive',
      source_conversation_id: archiveHit.conversation_id,
      source_responder_id: archiveHit.responder_id,
      source_closed_at: closedAtIso,
      sim: archiveHit.sim,
      answer: archiveHit.outcome,
    };
    // WI-1713046 — an archive-served row must not misreport ITSELF. Two columns
    // used to lie about this row, independently of whether the answer served
    // was the right one:
    //
    //   responder_id — used to copy `archiveHit.responder_id`, so the ledger
    //     asserted that agent X answered THIS consult while `wakes_used` was
    //     literally 0: X was never woken and never saw the question. It is
    //     NULL because the row genuinely has no responder — which is already
    //     what this very function returns to the caller (`responder: null`
    //     below); only the column disagreed. The honest provenance lives in
    //     `outcome.source_responder_id` above, which records it correctly as
    //     the SOURCE consult's responder. That distinction — "answered this"
    //     vs "once answered something similar" — is exactly what the
    //     top-level column erased, and the top-level column is the indexed one
    //     (`consult_state_responder_idx`) that queries read.
    //
    //   closed_at — used to bind a JS `now` captured BEFORE the embed + route
    //     + vector-search work (~1.9s earlier), while `created_at` takes the
    //     column default `now()` AT INSERT. Every such row was therefore
    //     stamped closed ~1.9s before it was created (measured: 34/34, e.g.
    //     conv-mth51nyx, lifetime -00:00:01.867), corrupting any duration
    //     analytic and leaving the row un-orderable against its own siblings.
    //     Both timestamps now come from the SAME clock, so the row cannot
    //     close before it opens.
    const persisted = await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, outcome, closed_at, wakes_used,
         depth, parent_consult_id, query_embedding, query_embedding_mode, query_embedding_profile)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         NULL, 'closed_answered', ${req.question}, ${latency},
         ${originRef}, ${sql.json(route.snapshot as never)},
         ${sql.json(outcome as never)}, now(), 0,
         ${depth}, ${req.parentConsultId ?? null}, ${qVecStr}::vector,
         ${route.queryMode}, ${route.queryProfile!.profileId})
      ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET
        state = EXCLUDED.state, responder_id = EXCLUDED.responder_id,
        origin_task_ref = EXCLUDED.origin_task_ref, outcome = EXCLUDED.outcome,
        closed_at = EXCLUDED.closed_at, depth = EXCLUDED.depth, parent_consult_id = EXCLUDED.parent_consult_id,
        routing = EXCLUDED.routing || jsonb_build_object('request', consult_state.routing->'request'),
        query_embedding = EXCLUDED.query_embedding, query_embedding_mode = EXCLUDED.query_embedding_mode,
        query_embedding_profile = EXCLUDED.query_embedding_profile
      WHERE consult_state.state = 'routing' AND consult_state.routing #>> '{request,leaseToken}' = ${deps.acceptedRequest?.leaseToken ?? null}
      RETURNING conversation_id
    `;
    if (persisted.length === 0) throw new Error('consult-request-lease-lost');
    return {
      ok: true,
      verdict: 'served_from_archive',
      conversation_id: opened.conversation_id,
      thread_id: opened.thread_id,
      state: 'served_from_archive',
      responder: null,
      responder_via: null,
      remaining_candidates: route.qualified.map((c) => ({
        ownerId: c.ownerId,
        score: c.score,
        liveness: c.liveness,
        via: 'floor' as SelectionVia,
      })),
      origin_task_ref: originRef,
      latency_contract: latency,
      expires_at: null,
      wake: {
        attempted: false,
        queued: 0,
        woke: 0,
        pickupConfirmed: false,
      },
      park_key: null,
      archive: {
        source_conversation_id: archiveHit.conversation_id,
        responder_id: archiveHit.responder_id,
        closed_at: closedAtIso,
        sim: archiveHit.sim,
        answer: archiveHit.outcome,
      },
      hint:
        `Served from the archive: consult ${archiveHit.conversation_id}` +
        `${archiveHit.responder_id ? ` (answered by ${archiveHit.responder_id}` : ' (closed'}${closedAtIso ? ` ${closedAtIso}` : ''})` +
        ` settled a highly similar question (sim ${archiveHit.sim.toFixed(2)} ≥ floor ${archiveFloor}). ` +
        'The structured answer + provenance are in `archive` — no one was woken. ' +
        'RECONCILE if your context differs: the archived answer predates your current state; ' +
        // The MCP arg is archive_floor (agent-tools/consult/get-feedback.ts); archiveFloor is this core field.
        'if it does not fit, re-call with archive_floor: 2 to force fresh routing.',
    };
  }

  // 3) D-001 §1 selection (min/max; owner-pause selectability per D-002): every
  //    selectable floor-qualified candidate best-first up to max; fewer than
  //    min ⇒ best-available fill from the full ranked pool, labeled
  //    via:'minimum' (D-002 — labeled, never silent). The selected set IS the
  //    cascade menu; delivery stays single-wake. The selection provenance is
  //    stamped into the routing snapshot BEFORE it is persisted, so the D-003
  //    honesty feed can always tell floor-qualified from minimum-fill.
  // Precedence: an explicit caller number wins, then the named policy's bound,
  // then the global default. A governed call site passes only `policy` and so
  // cannot drift from the registered value.
  const policyBounds = req.policy ? selectionPolicy(req.policy) : null;
  const minResponders = Math.max(0, req.minResponders ?? policyBounds?.min ?? DEFAULT_MIN_RESPONDERS);
  const maxResponders = Math.max(1, req.maxResponders ?? policyBounds?.max ?? DEFAULT_MAX_RESPONDERS);
  let selected = selectResponders({
    qualified: route.qualified,
    allCandidates: route.snapshot.candidates,
    min: minResponders,
    max: maxResponders,
    // D-002 REMOVED THE LIVENESS GATE. Delivery no longer needs the expert's
    // session to be reachable — it forks or converts their TRANSCRIPT — so
    // `ended`/`recorded`/`parked`/`warmIdle` stopped being reasons to pass over
    // the best-matched expert. That gate existed only because delivery was a
    // wake, and keeping it would now discard the best expert for a property
    // dispatch does not depend on.
    //
    // An owner PAUSE is different in kind and stays: it is an authoritative
    // "leave this identity alone" that the oracle reports independently of
    // liveness, and a fork still spends that identity's transcript and fleet
    // budget on work its owner has stood down.
    isSelectable: (c) => c.ownerPaused !== true,
  });
  route.snapshot.selection = selectionSnapshot(minResponders, maxResponders, selected);
  // P-014: the policy rides on the persisted snapshot so the expiry sweep can
  // recognize a review consult (rubric-vetting) and convert it to pullable work.
  if (req.policy) route.snapshot.policy = req.policy;
  if (methodReviewRubricRef) route.snapshot.methodReviewRubricRef = methodReviewRubricRef;
  if (req.reviewerModel) route.snapshot.reviewerModel = req.reviewerModel;
  if (req.nativeConsult) route.snapshot.nativeConsult = req.nativeConsult;
  const chosenSel = selected[0] ?? null;
  const chosen = chosenSel?.candidate ?? null;
  const chosenVia: SelectionVia | null = chosenSel?.via ?? null;

  // Belt + braces for the cycle rule (D-005): the excludeOwners fold means the
  // router can never hand back a lineage owner — but a future direct-responder
  // path might. Refuse structurally rather than trusting every route impl.
  if (chosen && lineageOwners.includes(chosen.ownerId)) {
    return {
      error: 'consult_cycle',
      lineage: lineageOwners,
      hint: "The resolved responder is already in this consult's lineage (A→B→A, D-005) — a cycle is refused. Re-call excluding them, or proceed on your own judgment.",
    };
  }
  if (cycleCheckOwners.size > 0) {
    selected = selected.filter(({ candidate }) => !cycleCheckOwners.has(candidate.ownerId));
    route.qualified = route.qualified.filter((candidate) => !cycleCheckOwners.has(candidate.ownerId));
    route.snapshot.candidates = route.snapshot.candidates.filter(
      (candidate) => !cycleCheckOwners.has(candidate.ownerId),
    );
    route.snapshot.selection = selectionSnapshot(minResponders, maxResponders, selected);
  }
  // 3b) D-002 retired the whole revival apparatus that used to live here. A
  //     "dead above-floor expert beats a live below-floor fill" preemption only
  //     made sense while delivery was a WAKE and death meant unreachable; the
  //     dispatcher forks or converts the transcript either way, so the best
  //     expert is simply the best expert and there is no liveness trade to make,
  //     no per-consult revival budget to spend, and no live-collision case.
  const provisionalSelected = selected;

  // 5) Open the conversation — ALWAYS (D-003 honesty feed + the PK row).
  //     ⚠ `direct_to` is EMPTY on purpose: openConversation fans a notification
  //     out to its addressees, so naming the expert here would message a live
  //     agent through the back door the wake seam just stopped using. Nobody
  //     needs the subscription anyway — appendPost auto-joins a contributor, so
  //     the answering session can post without being enrolled first.
  const opened = deps.acceptedRequest ?? await deps.open({
    kind: 'consult',
    title: consultTitle(req.question),
    body: consultBody(req),
    ...(req.topics?.length ? { topics: req.topics } : {}),
    ...(req.harnessSlug ? { harness_slug: req.harnessSlug } : {}),
    direct_to: [],
  });

  // The row is inserted BEFORE dispatch, and that ordering is load-bearing: the
  // launched session receives its brief as its FIRST turn and can issue
  // consult:reply before the dispatcher's host-registration wait even returns.
  // A missing row turns that valid first turn into not_a_consult; a row without
  // the answering identity turns it into not_a_participant. So the row lands
  // first with the routed expert as its responder, and the answering identity is
  // stamped onto the selection the moment dispatch reports it.
  let dispatchProvenance: GetFeedbackResult['dispatch'] | undefined;
  let finalSelected = provisionalSelected;
  // Nullable from here down: the D-002 dispatch walk can end with EVERY
  // selectee's allowlist exhausted, and the honest terminal for that is
  // `no_available_responder` with NO responder named (see 7c). `chosen` itself
  // is non-null on this path, so the widening is the walk's, not the route's.
  const retrievalOnly = req.allowDispatch === false;
  // Retrieval preserves the ranked menu but never attaches an answering
  // identity or enters the dispatch/cascade path. The persisted no-responder
  // state is inert; deliveryIntent distinguishes it from failed dispatch.
  let finalChosen: RoutingCandidate | null = retrievalOnly ? null : chosen;
  let finalChosenVia: SelectionVia | null = retrievalOnly ? null : chosenVia;
  const provisionalState: GetFeedbackResult['state'] = finalChosen
    ? 'awaiting_responder'
    : 'no_qualified_responder';
  const provisionalExpiresAt = finalChosen
    ? new Date(
        now.getTime() + (latency === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS),
      ).toISOString()
    : null;
  const provisionalWillWake = Boolean(finalChosen);
  const briefFor = (candidate: RoutingCandidate, via: SelectionVia | null) => {
    // consult-backed-parking D-013: a decision-review cascade uses the default consult copy.
    const auditCopy = req.cascade?.flavor === 'grading-integrity' ? sourceAuditWakeCopy(req.cascade, opened.conversation_id) : null;
    const reviewCopy = consultCurrentReviewContext(req.policy);
    return {
      summary:
        auditCopy?.summary ??
        `🧭 consult from ${req.requesterId}: ${req.question.replace(/\s+/g, ' ').slice(0, 72)}`,
      // Keep the initial review context intact through process-loss recovery.
      body: auditCopy?.body ?? (
        `QUESTION: ${req.question}\n` +
        (reviewCopy ? `${reviewCopy}\n` : '') +
        (candidate.fallback === 'lexical'
          ? `The semantic embedder is UNAVAILABLE. You are the bounded MANUAL-REVIEW pick from lexical text_tsv evidence (token overlap only; this is NOT a qualified semantic route).\n` +
            `Lexical evidence: ${evidenceLine(candidate)}. Review the question independently, state what you can and cannot ground, and do not present token overlap as expertise.\n`
          : via === 'minimum'
          ? `Selected as BEST-AVAILABLE reviewer (relevance ${candidate.relevance.toFixed(2)}, sim ${candidate.signals.similarity.toFixed(2)} — BELOW the relevance floor; no better-matched peer exists, and this consult carries a minimum of ${minResponders}).\n` +
            `This is a FIRST-PRINCIPLES review request, not a claim the transcript covers it — do NOT decline solely for lack of context. Review the question on its merits and state plainly what you can and cannot ground.\n`
          : `Routed by transcript relevance (relevance ${candidate.relevance.toFixed(2)}, sim ${candidate.signals.similarity.toFixed(2)}).\n` +
            `Why this transcript: ${evidenceLine(candidate)} — sessions:read resolves the refs.\n` +
            (reviewCopy ? '' : `Validate relevance FIRST; decline cheaply if the context doesn't cover it. Answer FROM the transcript, citing evidence.\n`)) +
        consultResponderVerbMenu({
          conversationId: opened.conversation_id,
          ...(reviewCopy || via === 'minimum'
            ? { evidenceNote: 'answer requires evidence — labeled first-principles reasoning is admissible here' }
            : {}),
          ...(candidate.fallback !== 'lexical' && via !== 'minimum'
            ? { declineNote: "if it's not your area" }
            : {}),
        })),
    };
  };
  // Selection and its launch obligation must commit together: request recovery
  // deliberately never re-routes an already-selected row. Reuse the cascade's
  // CAS lease and early answering-owner reservation for delivery recovery.
  const deferredInitialDispatch = Boolean(deps.acceptedRequest && deps.resumeInitialDispatch && finalChosen);
  const initialRouting = deferredInitialDispatch && finalChosen
    ? { ...route.snapshot, cascadeDispatch: pendingCascadeDispatch({
        responder: finalChosen.ownerId, conversationId: opened.conversation_id,
        evidence: finalChosen.evidence, ...briefFor(finalChosen, finalChosenVia),
      }, 0) }
    : route.snapshot;

  // query_embedding is stored whenever the column exists (embeddingColumnOk —
  // proven by the archive probe) and this route produced a vector: every
  // consult forward-fills the P-006 retrieval cache, hit or miss.
  let persisted;
  if (embeddingColumnOk && qVecStr) {
    persisted = await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, expires_at, wakes_used,
         depth, parent_consult_id, query_embedding, query_embedding_mode, query_embedding_profile)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         ${finalChosen?.ownerId ?? null}, ${provisionalState}, ${req.question}, ${latency},
         ${originRef}, ${sql.json(initialRouting as never)}, ${provisionalExpiresAt},
         ${provisionalWillWake ? 1 : 0}, ${depth}, ${req.parentConsultId ?? null}, ${qVecStr}::vector,
         ${route.queryMode}, ${route.queryProfile!.profileId})
      ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET
        responder_id = EXCLUDED.responder_id, state = EXCLUDED.state,
        origin_task_ref = EXCLUDED.origin_task_ref, expires_at = EXCLUDED.expires_at,
        wakes_used = EXCLUDED.wakes_used, depth = EXCLUDED.depth, parent_consult_id = EXCLUDED.parent_consult_id,
        routing = EXCLUDED.routing || jsonb_build_object('request', consult_state.routing->'request'),
        query_embedding = EXCLUDED.query_embedding, query_embedding_mode = EXCLUDED.query_embedding_mode,
        query_embedding_profile = EXCLUDED.query_embedding_profile
      WHERE consult_state.state = 'routing' AND consult_state.routing #>> '{request,leaseToken}' = ${deps.acceptedRequest?.leaseToken ?? null}
      RETURNING conversation_id
    `;
  } else {
    persisted = await sql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, origin_task_ref, routing, expires_at, wakes_used,
         depth, parent_consult_id)
      VALUES
        (${req.workspaceId}, ${opened.conversation_id}, ${req.requesterId},
         ${finalChosen?.ownerId ?? null}, ${provisionalState}, ${req.question}, ${latency},
         ${originRef}, ${sql.json(initialRouting as never)}, ${provisionalExpiresAt},
         ${provisionalWillWake ? 1 : 0}, ${depth}, ${req.parentConsultId ?? null})
      ON CONFLICT (workspace_id, conversation_id) DO UPDATE SET
        responder_id = EXCLUDED.responder_id, state = EXCLUDED.state,
        origin_task_ref = EXCLUDED.origin_task_ref, expires_at = EXCLUDED.expires_at,
        wakes_used = EXCLUDED.wakes_used, depth = EXCLUDED.depth, parent_consult_id = EXCLUDED.parent_consult_id,
        routing = EXCLUDED.routing || jsonb_build_object('request', consult_state.routing->'request')
      WHERE consult_state.state = 'routing' AND consult_state.routing #>> '{request,leaseToken}' = ${deps.acceptedRequest?.leaseToken ?? null}
      RETURNING conversation_id
    `;
  }
  if (persisted.length === 0) throw new Error('consult-request-lease-lost');


  // An empty selection is now a pure ROUTING verdict, and that is the D-002
  // simplification: the distinct causes stay distinguishable (D-003), but
  // `no_live_responder` is GONE from this point in the flow because liveness no
  // longer keeps anyone out of the selection. Instrument down ⇒
  // embed_unavailable; nothing above the floor and no minimum-fill ⇒
  // below_floor. The third case — an expert was selected but no allowed model
  // could be launched from their transcript — is only knowable AFTER the
  // dispatch walk, and is recorded there as `no_available_responder`.
  // Set only on the exhausted-menu terminal (7c); drives the honest hint there.
  let preLaunchRefusals: ReturnType<typeof summarizePreLaunchRefusals> | null = null;
  let reason: GetFeedbackResult['reason'] = retrievalOnly
    ? 'retrieval_only'
    : finalChosen
      ? undefined
      : route.snapshot.degraded === 'embed-unavailable'
        ? 'embed_unavailable'
        : route.snapshot.degraded === 'evidence-unavailable'
          ? 'evidence_unavailable'
        : 'below_floor';

  // 4) Delivery gating is SELECTION only — the per-task wake budget is REMOVED
  //    (D-005: maxResponders is the only per-consult bound; residual spam guards
  //    = per-consult max, the depth cap, archive-first dedupe).
  const willWake = Boolean(finalChosen);

  // 6) The consult_state row was persisted above. Re-read the final route values
  // for the return surface and the dispatch.
  let state: GetFeedbackResult['state'] = finalChosen ? 'awaiting_responder' : 'no_qualified_responder';
  let expiresAt = finalChosen
    ? new Date(now.getTime() + (latency === 'hard-blocked' ? HARD_BLOCKED_EXPIRY_MS : PROCEED_EXPIRY_MS)).toISOString()
    : null;

  // 7) DISPATCH the responder (D-002): fork or convert their session so an
  //    allowed model answers from their transcript. Nobody is woken.
  //
  //    The copy below is unchanged and still earns its branches — it is the
  //    answering session's BRIEF now rather than a wake body, and a brief needs
  //    exactly the same thing a wake body did: why this transcript was chosen,
  //    what standard of answer that implies, and the verb menu that settles the
  //    consult. A floor-qualified pick gets the why-you-were-chosen evidence; a
  //    minimum-fill pick gets the HONEST best-available framing so the reply is
  //    not a designed decline.
  let queued = 0;
  let woke = 0;
  let pickupConfirmed = false;
  if (deferredInitialDispatch) deps.resumeInitialDispatch!(opened.conversation_id);

  if (willWake && finalChosen && !deferredInitialDispatch) {
    const r = await deps.reach({
      responder: finalChosen.ownerId,
      conversationId: opened.conversation_id,
      evidence: finalChosen.evidence,
      // Stamp before a fork is launched: its first turn can reply while
      // spawnHeadless is waiting for the kickoff receipt. Conversions retain
      // their existing identity and stamp before verification; the
      // post-dispatch stamp below remains the backstop.
      onAnsweringOwner: (owner) =>
        stampAnsweringOwner(sql, req.workspaceId, opened.conversation_id, 0, owner),
      ...briefFor(finalChosen, finalChosenVia),
    });
    pickupConfirmed = r.pickupConfirmed ?? false;
    queued = r.queued ?? r.woke ?? 0;
    woke = pickupConfirmed ? queued : 0;
    if (queued > 0) {
      await stampAnsweringOwner(sql, req.workspaceId, opened.conversation_id, 0, r.answeringOwnerId ?? null);
      dispatchProvenance = {
        sourceOwnerId: finalChosen.ownerId,
        answeringOwnerId: r.answeringOwnerId ?? null,
        operation: r.dispatch?.operation ?? null,
        agent: r.dispatch?.agent ?? null,
        model: r.dispatch?.model ?? null,
        verified: r.dispatch?.verified ?? null,
        detail: r.dispatch?.detail ?? '',
      };
    }

    // 7b) An exhausted allowlist is a failed delivery for THIS expert, not a
    //     failed consult. Advance the same CAS-protected cascade reply/decline/
    //     expiry use, recording the exhausted head in the digest, and dispatch
    //     the next selectee. This is R-6 in the general case: a walled backend
    //     costs one expert, never the consult.
    let cascadeContinues = false;
    // WI-6554700010008590: a single-seat menu still has a failover target when the
    // routing pool holds candidates the menu never seated. advanceCascade's
    // min-ANSWERS refill draws from exactly that untried remainder, so gating on
    // `finalSelected.length > 1` alone stranded a bar-critique consult whose only
    // seat was refused pre-launch (transcript not_archived) with seven untried
    // candidates — two of them live — and ended it no_qualified_responder.
    const seatedOwners = new Set(finalSelected.map((s) => s.candidate.ownerId));
    const hasUntriedPool = minResponders > 0 &&
      route.snapshot.candidates.some((c) => !seatedOwners.has(c.ownerId));
    if (queued === 0 && !r.targetCapacityUnavailable && (finalSelected.length > 1 || hasUntriedPool)) {
      const failedOwner = finalSelected[0]!.candidate.ownerId;
      let failoverReach: Awaited<ReturnType<GetFeedbackDeps['reach']>> | undefined;
      const advanced = await advanceCascade(
        {
          workspaceId: req.workspaceId,
          conversationId: opened.conversation_id,
          question: req.question,
          latencyContract: latency,
          requesterId: req.requesterId,
          routing: route.snapshot,
          cascadeCursor: 0,
          digest: [],
          event: makeDigestEntry(
            failedOwner,
            'dispatch_failed',
            now.toISOString(),
            'Every allowed expert model was exhausted for this transcript (walled account, unforkable ' +
              'source, or failed launch); advancing to the next selected expert.',
          ),
          stateOnAdvance: 'awaiting_responder',
          nowIso: now.toISOString(),
        },
        sql,
        async (opts) => {
          // advanceCascade passes its own early-stamp hook; carry it through so
          // the failover leg closes the same first-reply race the creation leg
          // does, and report the identity back for the cascade's own stamp.
          failoverReach = await deps.reach(opts);
          return {
            woke: failoverReach.queued ?? failoverReach.woke ?? 0,
            answeringOwnerId: failoverReach.answeringOwnerId ?? null,
            ...(failoverReach.targetCapacityUnavailable ? { targetCapacityUnavailable: failoverReach.targetCapacityUnavailable } : {}),
          };
        },
      );
      // The cascade owns the complete failed-dispatch walk, including refill
      // and answering-id stamps. Do not count local loop iterations as cursor
      // positions: one advance may now skip several unlaunchable experts.
      cascadeContinues = advanced.advanced || advanced.raced;
      if (advanced.advanced && advanced.next) {
        finalChosen = route.snapshot.candidates.find((c) => c.ownerId === advanced.next!.ownerId) ?? null;
        finalChosenVia = advanced.next.via;
        queued = failoverReach?.queued ?? failoverReach?.woke ?? advanced.woke;
        pickupConfirmed = failoverReach?.pickupConfirmed ?? false;
        woke = pickupConfirmed ? queued : 0;
        if (finalChosen) {
          dispatchProvenance = {
            sourceOwnerId: finalChosen.ownerId,
            answeringOwnerId: failoverReach?.answeringOwnerId ?? null,
            operation: failoverReach?.dispatch?.operation ?? null,
            agent: failoverReach?.dispatch?.agent ?? null,
            model: failoverReach?.dispatch?.model ?? null,
            verified: failoverReach?.dispatch?.verified ?? null,
            detail: failoverReach?.dispatch?.detail ?? '',
          };
        }
      } else if (advanced.raced) {
        // A concurrent writer owns the outcome; preserve its row and report
        // its selected expert rather than the failed head of our stale menu.
        const current = await sql<{ responder_id: string | null; routing: unknown }[]>`
          SELECT responder_id, routing FROM harness_shared.consult_state
          WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${opened.conversation_id}`;
        finalChosen = route.snapshot.candidates.find((c) => c.ownerId === current[0]?.responder_id) ?? null;
        finalChosenVia = selectionFromRouting(current[0]?.routing)
          .find((entry) => entry.ownerId === finalChosen?.ownerId)?.via ?? null;
      }
    }

    // 7c) The whole menu was exhausted. Say so NOW rather than leaving an
    //     awaiting_responder row for the expiry sweep to settle hours later: no
    //     session was launched, so nothing is coming, and the requester's only
    //     useful next move is the retrieval fallback. This is the one honest
    //     terminal the old code could not express — it had a revival to try.
    if (queued === 0 && !cascadeContinues) {
      reason = 'no_available_responder';
      // P-003 / R-2: experts were selected and every one was attempted, so this
      // is NOT the measured absence no_qualified_responder reports.
      state = 'no_launchable_responder';
      expiresAt = null;
      // …and DROP the responder. Nothing was launched, so naming one would
      // promise an answer that is not coming — the park key, the verdict and
      // the hint all derive from this, and each is only honest once it is null.
      finalChosen = null;
      finalChosenVia = null;
      try {
        const walkRows = await sql<{ walks: unknown }[]>`
          SELECT dispatch_attempts AS walks FROM harness_shared.consult_state
           WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${opened.conversation_id}`;
        preLaunchRefusals = summarizePreLaunchRefusals(walkRows[0]?.walks);
      } catch {
        /* the hint falls back to the generic wording; the verdict is unaffected */
      }
      await sql`
        UPDATE harness_shared.consult_state
           SET state = 'no_launchable_responder',
               responder_id = NULL,
               expires_at = NULL,
               updated_at = ${now.toISOString()}::timestamptz
         WHERE workspace_id = ${req.workspaceId} AND conversation_id = ${opened.conversation_id}
           AND state = 'awaiting_responder'
           AND closed_at IS NULL
      `;
    }
  }

  const parkKey = finalChosen && latency === 'hard-blocked' ? consultParkKey(opened.conversation_id) : null;
  const viaNote =
    finalChosenVia === 'minimum'
      ? ' ⚠ Best-available pick BELOW the relevance floor (minimum-fill, D-001) — weigh the reply as a first-principles review, not grounded expertise.'
      : '';
  const fallbackNote =
    finalChosen?.fallback === 'lexical'
      ? ' ⚠ Semantic embedding was unavailable: this is a BOUNDED MANUAL-REVIEW pick from lexical text_tsv token matches, not a qualified semantic responder. Validate independently.'
      : '';
  const dispatchNote = renderDispatchProvenanceNote(dispatchProvenance);
  const wakeNote = deferredInitialDispatch
    ? `delivery queued durably for ${finalChosen?.ownerId}'s transcript; no answering session is confirmed yet`
    : pickupConfirmed
    ? `answering session live for ${finalChosen?.ownerId}'s transcript`
    : `answering session launched for ${finalChosen?.ownerId}'s transcript; it is still booting — the cascade expiry guards the reply`;
  // EI-22180634511432554: closed_cant_help / a fully-declined menu are
  // terminal-and-non-advancing BY DESIGN (see priorNonHelpfulResponders) — say
  // so on the re-route that benefited from it, so a caller who re-asked the
  // identical question learns their prior conversation id is stale (a
  // different responder is now this consult) instead of discovering it only
  // by comparing ids by hand.
  const autoExcludedNoteText = autoExcludedNote.length
    ? ` ⚠ ${autoExcludedNote.join(', ')} already told you "not this one" on this EXACT question (closed_cant_help / declined) and ${autoExcludedNote.length === 1 ? 'was' : 'were'} excluded from this re-route — any conversation id you previously published for ${autoExcludedNote.length === 1 ? 'that consult' : 'those consults'} is now stale.`
    : '';
  const hint = finalChosen
    ? latency === 'hard-blocked'
      ? `Routed + ${wakeNote}. Park on events:await { event: '${parkKey}' } and end your turn — a subsequent reply wakes you. This is a recurring event, so a reply that arrives before registration is an earlier edge; read the conversation before deciding whether to wait for another reply. Expires ${expiresAt}.${viaNote}${fallbackNote}${dispatchNote}${autoExcludedNoteText}`
      : `Routed + ${wakeNote}; the reply lands in conversation ${opened.conversation_id}. PROCEED on your own judgment meanwhile and apply relevant advice to your project when it arrives. Declines/expiries advance the cascade SERVER-side (the next expert is dispatched with the feedback so far, D-005) — no re-call needed unless the whole menu exhausts.${viaNote}${fallbackNote}${dispatchNote}${autoExcludedNoteText}`
    : retrievalOnly
      ? 'Retrieval-only: dispatch was disabled. No answering session was requested; do not park. Read remaining_candidates with sessions:read / sessions:search and decide from their transcript evidence.'
    : reason === 'embed_unavailable'
      ? `The embedder is unavailable on this host — similarity could NOT be measured, so there is no ranking to fill a minimum from (cannot-measure ≠ measured-nothing). Proceed on your own judgment; retry later if the answer matters.`
      : reason === 'evidence_unavailable'
        ? 'Problem-specific expertise could not be fully measured within the bounded evidence check. This does not prove no expert exists. Read the candidate transcript references and retry if the answer matters.'
      : reason === 'no_available_responder' && preLaunchRefusals && preLaunchRefusals.total > 0 &&
          preLaunchRefusals.refused === preLaunchRefusals.total
        ? `Matching experts were selected, but every dispatch walk (${preLaunchRefusals.total}) was refused BEFORE any model was tried, so no account wall is involved and retrying after a reset will not help: ${preLaunchRefusals.details.join(' | ')}. Nothing is coming, so do not park: remaining_candidates lists the experts; read their transcripts via sessions:read / sessions:search (retrieval fallback) and proceed.`
      : reason === 'no_available_responder'
        ? `Matching experts were selected, but NO allowed model could be launched from any of their transcripts — every ranked model was walled, unreachable for that backend, or failed to launch. Nothing is coming, so do not park: remaining_candidates lists the experts; read their transcripts via sessions:read / sessions:search (retrieval fallback) and proceed. Retrying once a walled account resets is reasonable.`
        : `No transcript cleared this question's relevance floor (and no minimum-fill applied — either min 0 was requested or nothing matched at all): there is no best-available reviewer to route to. Proceed on your own judgment (first-class honest verdict, not an error).`;

  return {
    ok: true,
    // Derived from `reason` rather than re-testing `snapshot.degraded`, so the
    // verdict and the reason can never drift into disagreeing about the same
    // route (EI-21485716602970457).
    verdict: retrievalOnly
      ? 'retrieval_only'
      : finalChosen
        ? 'routed'
        : reason === 'embed_unavailable' || reason === 'evidence_unavailable'
          ? 'relevance_unmeasured'
          : reason === 'no_available_responder'
            ? 'no_launchable_responder'
            : 'no_qualified_responder',
    ...(reason ? { reason } : {}),
    conversation_id: opened.conversation_id,
    thread_id: opened.thread_id,
    state,
    responder: finalChosen,
    responder_via: finalChosenVia,
    remaining_candidates: (finalSelected.length > 0
      ? retrievalOnly ? finalSelected : finalSelected.slice(1)
      : route.qualified.map((c) => ({ candidate: c, via: 'floor' as SelectionVia }))
    ).map((s) => ({
      ownerId: s.candidate.ownerId,
      score: s.candidate.score,
      // Reported beside `score` because `via` is derived from THIS number, not
      // from the comparison score: a caller weighing the remaining menu cannot
      // otherwise tell a floor-qualified peer from a best-available fill.
      relevance: s.candidate.relevance,
      liveness: s.candidate.liveness,
      via: s.via,
      ...(s.candidate.fallback ? { fallback: s.candidate.fallback } : {}),
    })),
    origin_task_ref: originRef,
    latency_contract: latency,
    expires_at: expiresAt,
    wake: {
      attempted: willWake,
      queued,
      woke,
      pickupConfirmed,
    },
    park_key: parkKey,
    ...(dispatchProvenance ? { dispatch: dispatchProvenance } : {}),
    ...(route.snapshot.degraded ? { degraded: route.snapshot.degraded } : {}),
    hint,
  };
}
