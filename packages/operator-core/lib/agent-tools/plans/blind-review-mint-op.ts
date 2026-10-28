/**
 * plans:blind-review op 'mint' (verification-system-improvements-2026-10-10 D-006 (2),
 * D-041, D-042; WI-6554700010008492).
 *
 * Kept out of blind-review.ts so the door file stays small and lane 3's P-006 evidence
 * bindings on it do not move. The door resolves the plan scope and calls
 * runBlindReviewMintOp; this maps mintBlindGapReviewer's result onto the door's JSON
 * payload.
 *
 * The payload never carries plan text. It carries the launch outcome and the kickoff SIZE,
 * not the kickoff itself: the caller is the plan author, and the reviewer reads its own
 * kickoff.
 */
import {
  BLIND_GAP_REVIEW_ACTOR,
  mintBlindGapReviewer,
  type MintBlindGapReviewerDeps,
  type BlindReviewerProductReads,
} from '../../blind-reviewer-mint';
import { blindReviewPostedEventKey } from '../../blind-review-post-event';

/** Longest raw (non-JSON) launch text echoed back to the caller. */
const RAW_LAUNCH_TEXT_CAP = 2000;

/**
 * Read an MCP tool-result envelope `{ content: [{ type:'text', text }], isError? }`.
 * A JSON text body is parsed; any other text is returned capped. A launch handler that
 * returns a bare object (as test doubles do) is passed through as the body.
 */
export function readLaunchEnvelope(launch: unknown): { isError: boolean; body: unknown } {
  if (!launch || typeof launch !== 'object') return { isError: false, body: launch ?? null };
  const env = launch as { content?: unknown; isError?: unknown };
  const isError = env.isError === true;
  if (!Array.isArray(env.content)) return { isError, body: launch };
  const first = env.content.find(
    (c): c is { type: 'text'; text: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
      && typeof (c as { text?: unknown }).text === 'string',
  );
  if (!first) return { isError, body: null };
  try {
    return { isError, body: JSON.parse(first.text) as unknown };
  } catch {
    return { isError, body: first.text.slice(0, RAW_LAUNCH_TEXT_CAP) };
  }
}

export interface BlindReviewMintOpInput {
  slug: string;
  harness: string;
  /** The concrete workspace the door resolved; overrides an unscoped ctx.workspaceId. */
  workspaceId: string;
  howToRun?: string | null;
  productReads?: BlindReviewerProductReads;
  ctx: Record<string, unknown>;
}

export async function runBlindReviewMintOp(
  input: BlindReviewMintOpInput,
  deps: MintBlindGapReviewerDeps = {},
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const minted = await mintBlindGapReviewer(
    {
      slug: input.slug,
      harness: input.harness,
      howToRun: input.howToRun ?? null,
      productReads: input.productReads,
      ctx: { ...input.ctx, workspaceId: input.workspaceId },
    },
    deps,
  );
  if (!minted.ok) {
    return { isError: true, payload: { error: minted.code, slug: input.slug, message: minted.message } };
  }
  const launch = readLaunchEnvelope(minted.launch);
  if (minted.launchStatus === 'not-started') {
    return {
      isError: true,
      payload: {
        error: 'launch_failed',
        slug: input.slug,
        activationAuditSeq: minted.activationAuditSeq,
        launch: launch.body,
        message: 'No reviewer process opened for this activation. Fix the cause named in launch, then retry; the zero-process receipt makes this activation key reusable.',
      },
    };
  }
  if (minted.launchStatus === 'uncertain') {
    return { isError: true, payload: {
      error: 'launch_uncertain', slug: input.slug, activationAuditSeq: minted.activationAuditSeq,
      launch: launch.body,
      message: 'The launch may have opened a reviewer, but its exact native identity is not available yet. Do not start a second reviewer or use a fresh key; retrying this same activation reuses its idempotency key and can reconcile the original launch.',
    } };
  }
  if (minted.launchStatus === 'partial') {
    return { isError: true, payload: {
      error: 'launch_partial', slug: input.slug, activationAuditSeq: minted.activationAuditSeq,
      launch: launch.body,
      binding: minted.binding ? { reviewerOwnerId: minted.binding.reviewerOwnerId,
        advSessionId: minted.binding.advSessionId, nativeSessionId: minted.binding.nativeSessionId } : null,
      ...(minted.binding ? { bindingId: minted.binding.id, awaitKey: blindReviewPostedEventKey(input.slug, minted.binding.id) } : {}),
      message: 'A reviewer process opened and its exact native session is bound, but startup verification failed. Do not mint again; inspect or resume this bound reviewer.',
    } };
  }
  // A 'bound' mint always carries its binding; without one there is no post key to hand out.
  if (!minted.binding) {
    return { isError: true, payload: {
      error: 'session_binding_failed', slug: input.slug, activationAuditSeq: minted.activationAuditSeq,
      launch: launch.body,
      message: 'The reviewer launched without a session binding, so its post cannot be awaited. Do not mint again until the binding is reconciled.',
    } };
  }
  return {
    isError: false,
    payload: {
      ok: true,
      slug: input.slug,
      op: 'mint',
      actor: BLIND_GAP_REVIEW_ACTOR,
      activationAuditSeq: minted.activationAuditSeq,
      kickoffChars: minted.kickoff.length,
      launch: launch.body,
      // awaitable-review-post-events-2026-10-27 R-2: the exact key this reviewer's post fires.
      bindingId: minted.binding.id,
      awaitKey: blindReviewPostedEventKey(input.slug, minted.binding.id),
      next: "The reviewer posts its gaps with op 'post'. Await awaitKey (events:await { event: awaitKey }) instead of polling; after it fires, map each gap with op 'dispose'.",
    },
  };
}
