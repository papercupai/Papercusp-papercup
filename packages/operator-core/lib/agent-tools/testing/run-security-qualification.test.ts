import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/tooldef';
const h = vi.hoisted(() => ({ manifest: vi.fn(), ledger: vi.fn(), review: vi.fn(), verify: vi.fn(), run: vi.fn() }));
vi.mock('../../coverage-census/security-qualification', () => ({
  captureAuthenticatedSecurityManifest: h.manifest, prepareAuthenticatedSecurityLedger: h.ledger,
  commitSecurityApplicability: h.review, verifySecurityQualificationResult: h.verify, runSecurityQualification: h.run,
}));
import { executeSecurityQualification, securityQualificationMetadata, securityQualificationSchema,
  securityQualificationSelectionError } from './run-security-qualification';
import runTool from './run';
const ctx = { workspaceId: 'test-workspace' } as UnifiedToolContext;
const digest = (c: string) => c.repeat(64);
const pins = { manifestSha256: digest('a'), ledgerSha256: digest('b') };
const execute = { phase: 'execute' as const, ...pins, approvalRef: digest('c') };
const review = { phase: 'review' as const, ...pins, manifestProducerRef: digest('d'),
  ledgerProducerRef: digest('e'), executor: 'authenticated-executor', reviewRef: 'thread-post:review' };
beforeEach(() => vi.resetAllMocks());

describe('testing:run security custody adapter', () => {
  it('refuses conflicts and absent scope at the actual tool handler before host writes', async () => {
    expect(await runTool.handler({ securityQualification: review, files: ['never.test.ts'] }, ctx))
      .toMatchObject({ data: { ok: false, error: 'security_qualification_conflicting_selectors' } });
    expect(await runTool.handler({ securityQualification: review }, {} as UnifiedToolContext))
      .toMatchObject({ data: { ok: false, error: 'security_qualification_requires_concrete_scope' } });
    expect(h.review).not.toHaveBeenCalled();
  });
  it('routes independent review through the actual tool with its transport identity', async () => {
    h.review.mockResolvedValue({ approvalRef: digest('f'), ...pins });
    expect(await runTool.handler({ harness: 'test', securityQualification: review }, ctx))
      .toMatchObject({ data: { approvalRef: digest('f'), custodyOnly: true, securityVerdict: 'unmeasured' } });
    expect(h.review.mock.calls[0][0]).toBe(ctx);
  });
  it('keeps caller identity, ordering, keys and authority out of the public schema', () => {
    for (const field of ['actor', 'ctx', 'signature', 'key', 'at', 'ordinal', 'reviewer']) {
      expect(securityQualificationSchema.safeParse({ ...review, [field]: 'forged' }).success).toBe(false);
    }
    expect(securityQualificationSchema.safeParse({ ...execute, approvalRef: 'missing' }).success).toBe(false);
  });
  it('rejects file execution or recovery mixed into a metadata commitment', () => {
    for (const field of ['files', 'changedPaths', 'recoverEvidence', 'remeasureEvidence', 'nativeConsult',
      'evidence', 'timeoutMs', 'privatePg']) {
      expect(securityQualificationSelectionError({ securityQualification: review, [field]: [] }))
        .toBe('security_qualification_conflicting_selectors');
    }
    expect(h.review).not.toHaveBeenCalled();
  });
  it('requires explicit complete-file selection and refuses filtered or replaying qualification selectors', () => {
    expect(securityQualificationSelectionError({ securityQualification: execute }))
      .toBe('security_qualification_requires_exact_files');
    for (const field of ['testNamePattern', 'changedPaths', 'recoverEvidence', 'remeasureEvidence', 'nativeConsult']) {
      expect(securityQualificationSelectionError({ securityQualification: execute, files: ['check.test.ts'], [field]: [] }))
        .toBe('security_qualification_conflicting_selectors');
    }
    expect(securityQualificationSelectionError({ securityQualification: execute, files: ['check.test.ts'] })).toBeNull();
    expect(securityQualificationSelectionError({ files: ['ordinary.test.ts'] })).toBeNull();
  });
  it('sends the actual transport context to independent host review and propagates its rejection', async () => {
    h.review.mockRejectedValue(Error('security_qualification_reviewer_not_independent'));
    await expect(securityQualificationMetadata(ctx, 'test', review)).rejects.toThrow('reviewer_not_independent');
    const { phase: _phase, ...input } = review;
    expect(h.review).toHaveBeenCalledWith(ctx, 'test', input);
  });
  it('never starts the core runner if the authenticated host refuses approval', async () => {
    h.run.mockRejectedValue(Error('security_qualification_approval_mismatch'));
    const core = vi.fn();
    await expect(executeSecurityQualification(ctx, 'test', execute, core)).rejects.toThrow('approval_mismatch');
    expect(core).not.toHaveBeenCalled();
  });
  it('keeps exact host pins and the core result without claiming security acceptance', async () => {
    h.run.mockImplementation(async (_ctx, _h, input, callback, captureResult) => {
      const value = await callback();
      expect(captureResult(value)).toEqual(value);
      return { ...input, value, startRef: digest('d'), resultRef: digest('e'), executionEvidenceSha256: digest('f') };
    });
    const result = await executeSecurityQualification(ctx, 'test', execute,
      async () => ({ ok: true, files: 2, passed: 4, failed: 0, runId: 'existing-router-group' }));
    expect(result).toMatchObject({ ok: true, runId: 'existing-router-group', securityQualification: {
      ...pins, approvalRef: digest('c'), startRef: digest('d'), resultRef: digest('e'),
      executionEvidenceSha256: digest('f'), custodyOnly: true, securityVerdict: 'unmeasured',
    } });
    expect(h.run.mock.calls[0][0]).toBe(ctx);
  });
  it.each([
    { ok: false, files: 1, passed: 0, failed: 1 },
    { ok: true, files: 1, passed: 0, failed: 0 },
    { ok: true, files: 0, passed: 1, failed: 0 },
    { ok: true, files: 1, passed: 1, failed: 0, error: 'timeout' },
    { ok: false, error: 'timeout', detachedRunId: 'unexpected-replay' },
  ])('never produces a passed receipt for failed, empty or uncertain core results %#', async measured => {
    let signedPassed = false;
    h.run.mockImplementation(async (_ctx, _h, _input, callback) => {
      const value = await callback(); signedPassed = true; return { value };
    });
    expect(await executeSecurityQualification(ctx, 'test', execute, async () => measured))
      .toMatchObject({ ok: false, securityQualification: { status: 'failed-or-unmeasured' } });
    expect(signedPassed).toBe(false);
  });
});
