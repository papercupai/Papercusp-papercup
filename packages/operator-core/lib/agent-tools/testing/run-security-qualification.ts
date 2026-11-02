/** Authenticated security custody on the existing testing:run surface.
 * These receipts admit an exact frozen revision; they never certify confinement
 * or replace row-bound controls, canaries and installed-artifact evidence.
 */
import { z } from 'zod';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { SECURITY_POPULATIONS } from '../../coverage-census/security-manifest';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1);
const pin = z.object({ revision: text, sha256: hash }).strict();
const surface = z.object({ kind: text, surfaceId: text, sourceFile: z.string().nullable().optional(),
  schemaRef: z.unknown().optional(), attrs: z.record(z.string(), z.unknown()).optional(),
  fidelity: z.enum(['declared', 'spec', 'convention', 'observed', 'file-only']) }).strict();
const tuple = z.object({ population: z.enum(SECURITY_POPULATIONS), kind: text, surfaceId: text,
  distribution: text, platform: text, runtime: text, enforcementMode: text, effect: text, channel: text }).strict();
const probe = z.object({ id: text, rowId: hash, sourceSha256: hash, testSha256: hash,
  fixtureSha256: hash, runtimeSha256: hash }).strict();
const reason = { rowId: hash, reason: text, sourceRefs: z.array(text).min(1) };
const disposition = z.discriminatedUnion('applicability', [
  z.object({ ...reason, applicability: z.literal('notApplicable') }).strict(),
  z.object({ ...reason, applicability: z.literal('applicable'), owner: text,
    positiveControl: probe, negativeCanary: probe }).strict(),
]);
const pins = { manifestSha256: hash, ledgerSha256: hash };
export const securityQualificationSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('manifest'), manifest: z.object({ source: pin, runtime: pin,
    inputs: z.array(z.object({ id: text, population: z.enum(SECURITY_POPULATIONS), source: pin,
      surfaces: z.array(surface).min(1) }).strict()).min(1) }).strict() }).strict(),
  z.object({ phase: z.literal('ledger'), manifestSha256: hash,
    tuples: z.array(tuple).min(1), dispositions: z.array(disposition).min(1) }).strict(),
  z.object({ phase: z.literal('review'), ...pins, manifestProducerRef: hash,
    ledgerProducerRef: hash, executor: text, reviewRef: text,
    expectedTuples: z.array(tuple).min(1), expectedDispositions: z.array(disposition).min(1) }).strict(),
  z.object({ phase: z.literal('execute'), ...pins, approvalRef: hash }).strict(),
  z.object({ phase: z.literal('verify'), ...pins, resultRef: hash }).strict(),
]);
export type SecurityQualificationRequest = z.infer<typeof securityQualificationSchema>;
export type SecurityQualificationExecution = Extract<SecurityQualificationRequest, { phase: 'execute' }>;

/** Refuse combinations before metadata writes or any test/evidence preparation. */
export function securityQualificationSelectionError(args: Record<string, unknown>): string | null {
  if (args.securityQualification === undefined) return null;
  const request = securityQualificationSchema.parse(args.securityQualification);
  const excluded = ['nativeConsult', 'changedPaths', 'recoverEvidence', 'remeasureEvidence', 'testNamePattern'];
  if (request.phase !== 'execute') excluded.push('files', 'evidence', 'rootHarnessSlug', 'privatePg',
    'timeoutMs', 'taskDeadlineAtMs', 'cleanupReserveMs', 'reporterStageTrace', 'maxFailures', 'recheckReason');
  if (excluded.some(key => args[key] !== undefined)) return 'security_qualification_conflicting_selectors';
  if (request.phase === 'execute' && (!Array.isArray(args.files) || args.files.length === 0)) {
    return 'security_qualification_requires_exact_files';
  }
  return null;
}

export async function securityQualificationMetadata(ctx: UnifiedToolContext, harness: string,
  request: Exclude<SecurityQualificationRequest, SecurityQualificationExecution>) {
  const host = await import('../../coverage-census/security-qualification');
  const evidence = { custodyOnly: true, securityVerdict: 'unmeasured' as const };
  switch (request.phase) {
    case 'manifest': {
      const result = await host.captureAuthenticatedSecurityManifest(ctx, harness, request.manifest);
      return { ...evidence, manifestSha256: result.manifest.sha256, producerRef: result.producerRef };
    }
    case 'ledger': {
      const result = await host.prepareAuthenticatedSecurityLedger(ctx, harness, {
        manifestSha256: request.manifestSha256, tuples: request.tuples, dispositions: request.dispositions,
      });
      return { ...evidence, ledgerSha256: result.ledger.sha256, producerRef: result.producerRef,
        rows: result.ledger.body.rows.length };
    }
    case 'review': {
      const { phase: _phase, ...input } = request;
      return { ...evidence, ...await host.commitSecurityApplicability(ctx, harness, input) };
    }
    case 'verify': {
      const { phase: _phase, ...input } = request;
      const result = await host.verifySecurityQualificationResult(harness, input);
      if (!result.executionEvidenceSha256) throw Error('security_qualification_execution_evidence_missing');
      const measured = z.object({ runId: text, ok: z.literal(true), files: z.number().int().positive(),
        passed: z.number().int().positive(), failed: z.literal(0) }).passthrough().parse(result.executionEvidence);
      return { ...evidence, ...input, approvalRef: result.approvalRef, startRef: result.startRef,
        executionEvidenceSha256: result.executionEvidenceSha256, runId: measured.runId,
        readbackVerified: true, rows: result.ledger.body.rows.length };
    }
  }
}

/** The existing core retains routing, admission, deadlines and test evidence.
 * Its automatic timeout replay is disabled by the caller: one host approval
 * admits one start. Failed/uncertain runs never acquire a passed receipt.
 */
export async function executeSecurityQualification<T extends { ok: boolean; error?: string;
  passed?: number; failed?: number; files?: number }>(ctx: UnifiedToolContext, harness: string,
  request: SecurityQualificationExecution, execute: () => Promise<T>): Promise<T & {
    securityQualification?: Record<string, unknown>;
  }> {
  const { runSecurityQualification } = await import('../../coverage-census/security-qualification');
  const { phase: _phase, ...input } = request;
  let measured: T | undefined;
  const incomplete = new Error('security_qualification_run_not_passed');
  try {
    const result = await runSecurityQualification(ctx, harness, input, async () => {
      measured = await execute();
      if (!measured.ok || measured.error !== undefined || measured.failed !== 0 ||
          !(typeof measured.passed === 'number' && measured.passed > 0) ||
          !(typeof measured.files === 'number' && measured.files > 0)) throw incomplete;
      return measured;
    }, value => value);
    return { ...result.value, securityQualification: { ...input, startRef: result.startRef,
      resultRef: result.resultRef, executionEvidenceSha256: result.executionEvidenceSha256,
      custodyOnly: true, securityVerdict: 'unmeasured' } };
  } catch (error) {
    if (error !== incomplete || !measured) throw error;
    return { ...measured, ok: false, securityQualification: { ...input,
      status: 'failed-or-unmeasured', custodyOnly: true, securityVerdict: 'unmeasured' } };
  }
}
