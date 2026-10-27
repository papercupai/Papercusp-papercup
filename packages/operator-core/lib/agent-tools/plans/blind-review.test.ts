/**
 * plans:blind-review door (WI-6554700010008492, D-041/D-042): op 'mint' routes to the
 * mint adapter with the door-resolved harness + workspace, and howToRun is refused on
 * every other op. The adapter itself is covered by blind-review-mint-op.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runBlindReviewMintOp = vi.fn();
const resumeBlindGapReviewer = vi.fn();
const loadBlindReviewBrief = vi.fn();
const replaceBlindGapReviewer = vi.fn();
vi.mock('../../blind-review-replacement', () => ({
  replaceBlindGapReviewer: (...args: unknown[]) => replaceBlindGapReviewer(...args),
}));

vi.mock('./blind-review-mint-op', () => ({
  runBlindReviewMintOp: (...a: unknown[]) => runBlindReviewMintOp(...a),
}));
vi.mock('../../blind-reviewer-mint', () => ({
  resumeBlindGapReviewer: (...a: unknown[]) => resumeBlindGapReviewer(...a),
}));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_harness: unknown, ctx: unknown) => ctx,
}));
vi.mock('./_ctx-opts', () => ({ ctxToPlanSourceOpts: async () => ({}) }));
vi.mock('./source', () => ({
  resolvePlanScope: async () => ({ workspaceId: 'ws-resolved', harnessSlug: 'papercusp' }),
}));
const recordBlindReview = vi.fn();
const recordBlindGapDispositions = vi.fn();
const evaluateBlindReviewGate = vi.fn();
const archiveBlindReviewScratchPlans = vi.fn();
const findLatestBlindReviewSessionBindingByReviewer = vi.fn();
const recordBlindReviewSessionPost = vi.fn();
const verifyBlindReviewSessionBinding = vi.fn();
vi.mock('../../blind-review-session-bindings', () => ({
  findLatestBlindReviewSessionBindingByReviewer: (...a: unknown[]) => findLatestBlindReviewSessionBindingByReviewer(...a),
  recordBlindReviewSessionPost: (...a: unknown[]) => recordBlindReviewSessionPost(...a),
  verifyBlindReviewSessionBinding: (...a: unknown[]) => verifyBlindReviewSessionBinding(...a),
}));
vi.mock('../../blind-review-gate', async (importOriginal) => ({
  ...await importOriginal<object>(),
  evaluateBlindReviewGate: (...a: unknown[]) => evaluateBlindReviewGate(...a),
  loadBlindReviewBrief: (...a: unknown[]) => loadBlindReviewBrief(...a),
  recordBlindGapDispositions: (...a: unknown[]) => recordBlindGapDispositions(...a),
  recordBlindReview: (...a: unknown[]) => recordBlindReview(...a),
}));
vi.mock('../../blind-review-scratch-plans', () => ({
  archiveBlindReviewScratchPlans: (...a: unknown[]) => archiveBlindReviewScratchPlans(...a),
}));

import tool from './blind-review';

describe('plans:blind-review typed recruiter replacement', () => {
  const args = { slug: 'replacement-plan', op: 'replace', activationAuditSeq: 5, sourceReviewId: 60,
    requestKey: 'corrected-manifest-v1', productReads: { testFiles: ['product.test.ts'] } };
  it('requires the exact activation, source attempt, immutable request and manifest together', () => {
    expect(tool.args.safeParse(args).success).toBe(true);
    for (const key of ['activationAuditSeq', 'sourceReviewId', 'requestKey', 'productReads']) {
      const missing = { ...args };
      delete missing[key as keyof typeof missing];
      expect(tool.args.safeParse(missing).success).toBe(false);
    }
    expect(tool.args.safeParse({ slug: args.slug, op: 'mint', requestKey: args.requestKey }).success).toBe(false);
  });
  it('forwards only authenticated context and exact request fields to the recovery operation', async () => {
    replaceBlindGapReviewer.mockResolvedValue({ ok: true, attempt: { id: 9, status: 'uncertain' } });
    const ctx = { workspaceId: '*', uiClientId: 'su-author', isSuperuser: true };
    const result = await tool.handler(args as never, ctx as never);
    const { op: _op, ...request } = args;
    expect(replaceBlindGapReviewer).toHaveBeenCalledWith({ ...request, harness: 'papercusp', workspaceId: 'ws-resolved',
      howToRun: undefined, ctx: { ...ctx, workspaceId: 'ws-resolved' } });
    expect('isError' in result ? result.isError : undefined).toBeUndefined();
  });
});

const SLUG = 'demo-plan-2026-10-11';
const CTX = { workspaceId: '*', ownerId: 'su-author' };

// op 'post' and 'dispose' attribute the record to the caller, so they need a resolvable identity.
const REVIEWER_CTX = { workspaceId: '*', uiClientId: 'su-reviewer', isSuperuser: true };

async function call(args: Record<string, unknown>, ctx: Record<string, unknown> = CTX) {
  const parsed = tool.args.safeParse({ ...(args.op === 'post' ? { outcome: 'conclusive' } : {}), ...args });
  if (!parsed.success) throw new Error(parsed.error.message);
  const out = (await tool.handler(parsed.data as never, ctx as never)) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(out.content[0]!.text) as Record<string, unknown>, isError: out.isError === true };
}

beforeEach(() => {
  runBlindReviewMintOp.mockReset();
  resumeBlindGapReviewer.mockReset();
  loadBlindReviewBrief.mockReset();
  recordBlindReview.mockReset();
  recordBlindGapDispositions.mockReset();
  evaluateBlindReviewGate.mockReset();
  archiveBlindReviewScratchPlans.mockReset();
  findLatestBlindReviewSessionBindingByReviewer.mockReset().mockResolvedValue(null);
  recordBlindReviewSessionPost.mockReset().mockResolvedValue(true);
  verifyBlindReviewSessionBinding.mockReset().mockResolvedValue({ ok: true });
});

describe('explicit completion outcome contract', () => {
  it('requires a valid outcome on post and scopes it to post', () => {
    for (const outcome of [undefined, null, 'unknown']) {
      expect(tool.args.safeParse({ slug: SLUG, op: 'post', gaps: [], outcome }).success).toBe(false);
    }
    for (const outcome of ['conclusive', 'inconclusive']) {
      expect(tool.args.safeParse({ slug: SLUG, op: 'post', gaps: [], outcome }).success).toBe(true);
      expect(tool.args.safeParse({ slug: SLUG, op: 'brief', outcome }).success).toBe(false);
    }
  });

  it.each([
    ['conclusive', 'INCONCLUSIVE: blocked'],
    ['inconclusive', 'CONCLUSIVE: completed'],
  ])('refuses contradictory %s outcomes at the tool boundary', (outcome, summary) => {
    expect(tool.args.safeParse({ slug: SLUG, op: 'post', gaps: [], outcome, summary }).success).toBe(false);
  });

  it('forwards an inconclusive outcome unchanged and returns its non-counting receipt', async () => {
    recordBlindReview.mockResolvedValue({ ok: true, id: 10, activationAuditSeq: 3, gapIds: [] });
    evaluateBlindReviewGate.mockResolvedValue({ satisfied: false, acceptedReviewIds: [],
      rejectedReviews: [{ reviewId: 10, reason: 'inconclusive' }] });
    archiveBlindReviewScratchPlans.mockResolvedValue(null);
    const { body } = await call({ slug: SLUG, op: 'post', outcome: 'inconclusive', gaps: [], summary: 'INCONCLUSIVE: product blocked' }, REVIEWER_CTX);
    expect(recordBlindReview).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'inconclusive', gaps: [] }));
    expect(body).toMatchObject({ ok: true, id: 10, counts: false, rejected: { reason: 'inconclusive' } });
  });
});

// verification-system-improvements-2026-10-10#D-050 (5): the reviewer's scratch plans are
// archived once its gaps are recorded, without ever putting the recorded review at risk.
describe('plans:blind-review op post — scratch-plan cleanup', () => {
  const PREFIX = 'blind-review-scratch-abc123def456-';
  beforeEach(() => {
    recordBlindReview.mockResolvedValue({ ok: true, id: 9, activationAuditSeq: 3, gapIds: [] });
    recordBlindGapDispositions.mockResolvedValue({ ok: true, id: 10, activationAuditSeq: 3, gapIds: ['G-1'] });
    evaluateBlindReviewGate.mockResolvedValue({ satisfied: true, acceptedReviewIds: [9], rejectedReviews: [] });
  });

  it('archives the poster\'s own scratch plans after recording the review, and reports the count', async () => {
    archiveBlindReviewScratchPlans.mockResolvedValue({ prefix: PREFIX, archived: 2 });
    const { body, isError } = await call({ slug: SLUG, op: 'post', gaps: [] }, REVIEWER_CTX);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, id: 9, counts: true, scratchPlans: { prefix: PREFIX, archived: 2 } });
    expect(archiveBlindReviewScratchPlans).toHaveBeenCalledTimes(1);
    expect(archiveBlindReviewScratchPlans).toHaveBeenCalledWith({ workspaceId: 'ws-resolved', ownerId: 'su-reviewer' });
    expect(recordBlindReview.mock.invocationCallOrder[0]).toBeLessThan(archiveBlindReviewScratchPlans.mock.invocationCallOrder[0]!);
  });

  it('uses the verified session binding as the post receipt and preserves the exact activation audit', async () => {
    const binding = {
      id: 17, workspaceId: 'ws-resolved', harnessSlug: 'papercusp', planSlug: SLUG, activationAuditSeq: 3,
      reviewerOwnerId: 'su-reviewer', advSessionId: 42, nativeSessionId: 'native-review-1',
      launchParentOwner: 'system:blind-gap-review', accountRoute: 'auto', modelSpec: null,
      confinementSnapshot: {}, status: 'ready', resumeLeaseId: null, resumeLeaseExpiresAt: null, reviewId: null,
    };
    findLatestBlindReviewSessionBindingByReviewer.mockResolvedValue(binding);
    const { body, isError } = await call({ slug: SLUG, op: 'post', gaps: [] }, REVIEWER_CTX);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, id: 9 });
    expect(recordBlindReview).toHaveBeenCalledWith(expect.objectContaining({ activationAuditSeq: 3 }));
    expect(recordBlindReviewSessionPost).toHaveBeenCalledWith({
      workspaceId: 'ws-resolved', planSlug: SLUG, activationAuditSeq: 3, reviewerOwnerId: 'su-reviewer', reviewId: 9,
    });
    expect(recordBlindReviewSessionPost.mock.invocationCallOrder[0]).toBeLessThan(archiveBlindReviewScratchPlans.mock.invocationCallOrder[0]!);
  });

  it('reports a cleanup failure without voiding the recorded review', async () => {
    archiveBlindReviewScratchPlans.mockRejectedValue(new Error('pg down'));
    const { body, isError } = await call({ slug: SLUG, op: 'post', gaps: [] }, REVIEWER_CTX);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, id: 9, scratchPlans: { error: 'scratch_cleanup_failed', message: 'pg down' } });
  });

  it('leaves the response unchanged for a poster with no scratch boundary, and never cleans up on dispose', async () => {
    archiveBlindReviewScratchPlans.mockResolvedValue(null);
    const posted = await call({ slug: SLUG, op: 'post', gaps: [] }, REVIEWER_CTX);
    expect(posted.body).not.toHaveProperty('scratchPlans');
    await call({ slug: SLUG, op: 'dispose', dispositions: [{ reviewId: 9, gapId: 'G-1', itemId: 'P-001' }] }, REVIEWER_CTX);
    expect(archiveBlindReviewScratchPlans).toHaveBeenCalledTimes(1);
  });

  it('refuses a failed record before any cleanup', async () => {
    recordBlindReview.mockResolvedValue({ ok: false, code: 'stale_activation_audit', message: 'stale' });
    const { isError } = await call({ slug: SLUG, op: 'post', gaps: [] }, REVIEWER_CTX);
    expect(isError).toBe(true);
    expect(archiveBlindReviewScratchPlans).not.toHaveBeenCalled();
  });
});

describe('plans:blind-review op mint', () => {
  it('routes resume through the recruiter helper with the resolved workspace and caller identity', async () => {
    resumeBlindGapReviewer.mockResolvedValue({
      ok: true, activationAuditSeq: 3, reviewerOwnerId: 'su-reviewer', leaseReleased: true, launch: { mode: 'resume' },
    });
    const { body, isError } = await call({ slug: SLUG, op: 'resume' }, REVIEWER_CTX);
    expect(isError).toBe(false);
    expect(body).toMatchObject({ ok: true, op: 'resume', activationAuditSeq: 3, reviewerOwnerId: 'su-reviewer' });
    expect(resumeBlindGapReviewer).toHaveBeenCalledWith(expect.objectContaining({
      slug: SLUG, harness: 'papercusp', recruiterOwnerId: 'su-reviewer',
      ctx: expect.objectContaining({ workspaceId: 'ws-resolved' }),
    }));
  });

  it('passes nominated product reads only on the mint operation', async () => {
    runBlindReviewMintOp.mockResolvedValue({ isError: false, payload: { ok: true } });
    const productReads = { docsHarness: 'engineering', docsSlugs: ['agent-insights/product-guide'], testFiles: ['lib/probe.test.ts'] };
    await call({ slug: SLUG, op: 'mint', productReads });
    expect(runBlindReviewMintOp).toHaveBeenCalledWith(expect.objectContaining({ productReads }));
    for (const op of ['brief', 'post', 'dispose', 'resume']) {
      const extra = op === 'post' ? { gaps: [] } : op === 'dispose' ? { dispositions: [{ reviewId: 1, gapId: 'G-1', itemId: 'P-001' }] } : {};
      expect(tool.args.safeParse({ slug: SLUG, op, productReads, ...extra }).success).toBe(false);
    }
  });

  it('routes to runBlindReviewMintOp with the resolved harness and workspace, and returns its payload', async () => {
    runBlindReviewMintOp.mockResolvedValue({ isError: false, payload: { ok: true, reviewerOwnerId: 'su-r1' } });

    const { body, isError } = await call({ slug: SLUG, op: 'mint', howToRun: 'npm run dev' });

    expect(isError).toBe(false);
    expect(body).toEqual({ ok: true, reviewerOwnerId: 'su-r1' });
    expect(runBlindReviewMintOp).toHaveBeenCalledTimes(1);
    expect(runBlindReviewMintOp).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, harness: 'papercusp', workspaceId: 'ws-resolved', howToRun: 'npm run dev', ctx: CTX }),
    );
    expect(loadBlindReviewBrief).not.toHaveBeenCalled();
  });

  it('passes a mint refusal through as an error result', async () => {
    runBlindReviewMintOp.mockResolvedValue({ isError: true, payload: { error: 'no_activation_audit', slug: SLUG } });

    const { body, isError } = await call({ slug: SLUG, op: 'mint' });

    expect(isError).toBe(true);
    expect(body.error).toBe('no_activation_audit');
    expect(runBlindReviewMintOp).toHaveBeenCalledWith(expect.objectContaining({ howToRun: undefined }));
  });

  it("refuses howToRun on every op other than 'mint'", () => {
    for (const op of ['brief', 'post', 'dispose', 'resume'] as const) {
      const extra = op === 'post' ? { gaps: [] } : op === 'dispose' ? { dispositions: [{ reviewId: 1, gapId: 'G-1', itemId: 'P-001' }] } : {};
      const parsed = tool.args.safeParse({ slug: SLUG, op, howToRun: 'npm run dev', ...extra });
      expect(parsed.success, op).toBe(false);
      expect(parsed.error?.issues.map((i) => i.message), op).toContain("howToRun is op 'mint' or 'replace' only");
    }
  });

  it('a brief call never reaches the mint adapter', async () => {
    loadBlindReviewBrief.mockResolvedValue({ activationAuditSeq: 3, ownerTurns: [], unverifiedTurns: [], excludedRefs: [], text: '' });

    const { body } = await call({ slug: SLUG, op: 'brief' });

    expect(body.ok).toBe(true);
    expect(runBlindReviewMintOp).not.toHaveBeenCalled();
  });
});
