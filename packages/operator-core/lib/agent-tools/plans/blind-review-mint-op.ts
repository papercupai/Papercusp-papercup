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
  if (launch.isError) {
    return {
      isError: true,
      payload: {
        error: 'launch_failed',
        slug: input.slug,
        activationAuditSeq: minted.activationAuditSeq,
        launch: launch.body,
        message: 'The reviewer launch was refused, so no reviewer is running. Fix the cause named in launch, then mint again.',
      },
    };
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
      next: "The reviewer posts its gaps with op 'post'. After it posts, map each gap with op 'dispose'.",
    },
  };
}
