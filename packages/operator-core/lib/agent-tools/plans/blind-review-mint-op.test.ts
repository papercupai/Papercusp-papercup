/**
 * plans:blind-review op 'mint' adapter (WI-6554700010008492). The mint itself is covered by
 * lib/blind-reviewer-mint.test.ts; this file covers how its result reaches the caller:
 * the workspace override, the launch envelope parse, the refusal paths, and that the
 * kickoff text (the owner's turns) is never echoed back to the plan author.
 */
import { describe, expect, it, vi } from 'vitest';

import type { BlindReviewBrief } from '../../blind-review-brief';
import type { createBlindReviewSessionBinding } from '../../blind-review-session-bindings';
import { BLIND_GAP_REVIEW_ACTOR } from '../../blind-reviewer-mint';
import { readLaunchEnvelope, runBlindReviewMintOp } from './blind-review-mint-op';

const SLUG = 'demo-plan-2026-10-11';
const KEY = Symbol('test-confinement-key');
const SECRET_TURN = 'Make the export button produce a CSV.';

const BRIEF: BlindReviewBrief = {
  planSlug: SLUG,
  activationAuditSeq: 7,
  ownerTurns: [{ ref: 'claude:s1:3', text: SECRET_TURN }],
  unverifiedTurns: [],
  excludedRefs: [],
  text: `Owner turn claude:s1:3:\n${SECRET_TURN}`,
};

const envelope = (body: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof body === 'string' ? body : JSON.stringify(body) }],
  ...(isError ? { isError: true as const } : {}),
});

// A successful launch carries the exact native-session receipt the mint binds the
// reviewer to; a launch without it is refused as session_binding_failed.
const RECEIPT = { launch: {
  ownerIds: ['su-reviewer-1'],
  freshVerdict: { sessions: [{ ownerId: 'su-reviewer-1', advSessionId: 42, sessionId: 'native-review-1' }] },
} };
const launched = (body: unknown) => ({ ...envelope(body), data: RECEIPT });

function deps(launchResult: unknown, brief: BlindReviewBrief | null = BRIEF) {
  const handler = vi.fn(async () => launchResult);
  const loadBrief = vi.fn(async () => brief);
  const createSessionBinding = vi.fn(async (input: Parameters<typeof createBlindReviewSessionBinding>[0]) => ({
    ok: true as const, created: true,
    binding: {
      id: 7, workspaceId: 'ws-1', harnessSlug: 'papercusp', planSlug: SLUG, activationAuditSeq: 7,
      reviewerOwnerId: input.reviewerOwnerId, advSessionId: input.advSessionId, nativeSessionId: input.nativeSessionId,
      launchParentOwner: BLIND_GAP_REVIEW_ACTOR, accountRoute: 'auto', modelSpec: null,
      confinementSnapshot: input.confinement, status: 'ready' as const, resumeLeaseId: null,
      resumeLeaseExpiresAt: null, reviewId: null,
    },
  }));
  return {
    handler, loadBrief, createSessionBinding,
    deps: { loadBrief, launcher: async () => ({ handler, confinementKey: KEY }), createSessionBinding },
  };
}

const INPUT = { slug: SLUG, harness: 'papercusp', workspaceId: 'ws-1', ctx: { workspaceId: '*', ownerId: 'su-author' } };

describe('readLaunchEnvelope', () => {
  it('parses a JSON text body and reads isError', () => {
    expect(readLaunchEnvelope(envelope({ ok: true, ownerId: 'su-r1' }))).toEqual({ isError: false, body: { ok: true, ownerId: 'su-r1' } });
    expect(readLaunchEnvelope(envelope({ error: 'x' }, true))).toEqual({ isError: true, body: { error: 'x' } });
  });

  it('caps a non-JSON text body instead of failing', () => {
    const out = readLaunchEnvelope(envelope('x'.repeat(5000), true));
    expect(out.isError).toBe(true);
    expect(typeof out.body).toBe('string');
    expect((out.body as string).length).toBe(2000);
  });

  it('passes a bare object through and treats a missing text part as no body', () => {
    expect(readLaunchEnvelope({ ok: true })).toEqual({ isError: false, body: { ok: true } });
    expect(readLaunchEnvelope({ content: [{ type: 'image' }] })).toEqual({ isError: false, body: null });
    expect(readLaunchEnvelope(undefined)).toEqual({ isError: false, body: null });
  });
});

describe('runBlindReviewMintOp', () => {
  it('threads exact nominated product reads through the adapter into the launch confinement', async () => {
    const d = deps(launched({ ok: true, ownerId: 'su-reviewer-1' }));
    const productReads = { docsHarness: 'engineering', docsSlugs: ['agent-insights/product-guide'], testFiles: ['lib/probe.test.ts'] };
    await runBlindReviewMintOp({ ...INPUT, productReads }, d.deps);
    const ctx = (d.handler.mock.calls[0] as unknown as [unknown, Record<PropertyKey, unknown>])[1];
    expect(ctx[KEY]).toMatchObject({ denyProductReadsOutside: { ...productReads, harness: 'papercusp' } });
  });

  it('mints under the resolved workspace, not the unscoped ctx value', async () => {
    const d = deps(launched({ ok: true, ownerId: 'su-reviewer-1' }));
    const out = await runBlindReviewMintOp(INPUT, d.deps);
    expect(out.isError).toBe(false);
    expect(d.loadBrief).toHaveBeenCalledWith({ workspaceId: 'ws-1', planSlug: SLUG, harnessSlug: 'papercusp' });
    expect(d.createSessionBinding).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', planSlug: SLUG, activationAuditSeq: 7,
      reviewerOwnerId: 'su-reviewer-1', advSessionId: 42, nativeSessionId: 'native-review-1',
    }));
    const ctx = (d.handler.mock.calls[0] as unknown as [unknown, Record<string | symbol, unknown>])[1];
    expect(ctx.workspaceId).toBe('ws-1');
    expect(ctx.ownerId).toBe(BLIND_GAP_REVIEW_ACTOR);
    expect(ctx[KEY]).toBeDefined();
  });

  it('reports the launch outcome and the kickoff size, never the kickoff text', async () => {
    const d = deps(launched({ ok: true, ownerId: 'su-reviewer-1' }));
    const out = await runBlindReviewMintOp({ ...INPUT, howToRun: 'npm run dev' }, d.deps);
    expect(out.payload).toMatchObject({
      ok: true,
      op: 'mint',
      slug: SLUG,
      actor: BLIND_GAP_REVIEW_ACTOR,
      activationAuditSeq: 7,
      launch: { ok: true, ownerId: 'su-reviewer-1' },
    });
    const kickoff = (d.handler.mock.calls[0] as unknown as [{ brief: string }])[0].brief;
    expect(kickoff).toContain(SECRET_TURN);
    expect(kickoff).toContain('npm run dev');
    expect(out.payload.kickoffChars).toBe(kickoff.length);
    expect(JSON.stringify(out.payload)).not.toContain(SECRET_TURN);
  });

  it('returns launch_failed with the launcher reason when the launch is refused', async () => {
    const d = deps(envelope({ error: 'account_unavailable', message: 'no route' }, true));
    const out = await runBlindReviewMintOp(INPUT, d.deps);
    expect(out.isError).toBe(true);
    expect(out.payload).toMatchObject({ error: 'launch_failed', slug: SLUG, activationAuditSeq: 7, launch: { error: 'account_unavailable' } });
    expect(out.payload.ok).toBeUndefined();
  });

  it('passes the mint refusals through without launching', async () => {
    const noAudit = deps(envelope({ ok: true }), null);
    const out = await runBlindReviewMintOp(INPUT, noAudit.deps);
    expect(out).toMatchObject({ isError: true, payload: { error: 'no_activation_audit', slug: SLUG } });
    expect(noAudit.handler).not.toHaveBeenCalled();

    const unscoped = deps(envelope({ ok: true }));
    const out2 = await runBlindReviewMintOp({ ...INPUT, workspaceId: '*' }, unscoped.deps);
    expect(out2).toMatchObject({ isError: true, payload: { error: 'workspace_required' } });
    expect(unscoped.loadBrief).not.toHaveBeenCalled();
    expect(unscoped.handler).not.toHaveBeenCalled();

    // A launch that returns no native-session receipt cannot be bound, so the adapter
    // reports the mint's refusal instead of a running reviewer.
    const unbound = deps(envelope({ ok: true, ownerId: 'su-reviewer-1' }));
    const out3 = await runBlindReviewMintOp(INPUT, unbound.deps);
    expect(out3).toMatchObject({ isError: true, payload: { error: 'session_binding_failed', slug: SLUG } });
    expect(unbound.createSessionBinding).not.toHaveBeenCalled();
  });
});
