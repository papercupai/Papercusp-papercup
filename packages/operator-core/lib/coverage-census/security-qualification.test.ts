import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { canonicalJson } from '@papercusp/hash-chain';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { SECURITY_POPULATIONS, securityTupleId, type SecurityTuple } from './security-manifest';

const h = vi.hoisted(() => ({ artifacts: new Map<string, string>(), claims: new Map<string, string>(),
  related: vi.fn(async (_a: string, _b: string) => false), keyAvailable: true,
  secret: Buffer.alloc(32, 7), now: 1000, captureRuntimeSecurityCensus: vi.fn() }));
vi.mock('../observability/runtime', () => ({ captureRuntimeSecurityCensus: h.captureRuntimeSecurityCensus }));
// Runtime custody must load and work even when source-only scanning cannot load.
// In particular, a relocated host bundle has no sibling source checkout.
vi.mock('./security-source-census', () => { throw Error('runtime-custody-loaded-source-scanner'); });
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: async () =>
  h.keyAvailable ? [{ value_b64: h.secret.toString('base64') }] : [] }) }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-security' }));
vi.mock('../acceptance-author-identity', () => ({ areAcceptanceLineageRelated: h.related }));
vi.mock('../text-artifacts', () => ({
  saveImmutableTextArtifact: async (harness: string, bytes: string) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    h.artifacts.set(`${harness}:${sha256}`, bytes);
    return { sha256 };
  },
  loadImmutableTextArtifact: async (harness: string, ref: string) => h.artifacts.get(`${harness}:${ref}`) ?? null,
  loadImmutableTextArtifactClaim: async (harness: string, slot: string) => h.claims.get(`${harness}:${slot}`) ?? null,
  claimImmutableTextArtifact: async (harness: string, slot: string, bytes: string) => {
    const key = `${harness}:${slot}`;
    if (h.claims.has(key)) {
      if (h.claims.get(key) !== bytes) throw new Error('text_artifact_immutable_claim_conflict');
      return false;
    }
    h.claims.set(key, bytes);
    return true;
  },
}));
const { captureAuthenticatedSecurityManifest, prepareAuthenticatedSecurityLedger,
  commitSecurityApplicability, runSecurityQualification, verifySecurityQualificationResult,
  captureAuthenticatedRuntimeSecurityCensus, verifyAuthenticatedRuntimeSecurityCensus } = await import('./security-qualification');
const ids = { producer: 'su-11111111-1111-4111-8111-111111111111',
  ledger: 'su-22222222-2222-4222-8222-222222222222', reviewer: 'su-33333333-3333-4333-8333-333333333333',
  executor: 'su-44444444-4444-4444-8444-444444444444' };
function ctx(ownerId: string, harnessSlug: string | null = 'test'): UnifiedToolContext {
  return { uiClientId: ownerId, workspaceId: 'ws-security', harnessSlug, isSuperuser: true,
    log: () => {}, signal: new AbortController().signal, progress: async () => {}, emit: async () => {},
    principal: { kind: 'system', slug: 'system:superuser', workspaceId: 'ws-security',
      authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } };
}
const digest = (letter = 'a') => letter.repeat(64);
async function prepare() {
  const source = { revision: 'exact-source', sha256: digest() };
  const produced = await captureAuthenticatedSecurityManifest(ctx(ids.producer), 'test', {
    source, runtime: { revision: 'exact-loaded-build', sha256: digest('b') },
    inputs: SECURITY_POPULATIONS.map(population => ({ id: population, population, source,
      surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })),
  });
  const tuples: SecurityTuple[] = SECURITY_POPULATIONS.map(population => ({ population, kind: population,
    surfaceId: population, distribution: 'installed', platform: 'linux', runtime: 'node', enforcementMode: 'strict',
    effect: 'fs-write', channel: 'mcp' }));
  const planned = await prepareAuthenticatedSecurityLedger(ctx(ids.ledger), 'test', {
    manifestSha256: produced.manifest.sha256, tuples,
    dispositions: tuples.map(tuple => {
      const rowId = securityTupleId(tuple);
      const probe = (id: string) => ({ id: `${rowId}:${id}`, rowId, sourceSha256: digest(),
        testSha256: digest('c'), fixtureSha256: digest('d'), runtimeSha256: digest('b') });
      return { rowId, applicability: 'applicable' as const, owner: ids.executor, reason: 'registered source',
        sourceRefs: ['fixture:canonical-input'], positiveControl: probe('allowed'), negativeCanary: probe('denied') };
    }),
  });
  h.now = 2000;
  return { manifestSha256: produced.manifest.sha256, ledgerSha256: planned.ledger.sha256,
    manifestProducerRef: produced.producerRef, ledgerProducerRef: planned.producerRef,
    executor: ids.executor, reviewRef: 'fixture:independent-review-of-exact-population',
    expectedTuples: structuredClone(planned.ledger.body.rows.map(row => row.tuple)),
    expectedDispositions: structuredClone(planned.ledger.body.rows.map(row => row.disposition)) };
}
async function approved() {
  const request = await prepare();
  const input = await commitSecurityApplicability(ctx(ids.reviewer), 'test', request);
  return { request, input };
}
const load = (ref: string) => JSON.parse(h.artifacts.get(`test:${ref}`)!);
function mutation(ref: string, change: (event: Record<string, unknown>) => void, resign = false) {
  const signed = load(ref);
  change(signed.event);
  if (resign) signed.signature = createHmac('sha256', h.secret)
    .update(canonicalJson(['security-qualification-v1', signed.event])).digest('hex');
  const bytes = canonicalJson(signed), hash = createHash('sha256').update(bytes).digest('hex');
  h.artifacts.set(`test:${hash}`, bytes);
  return hash;
}
beforeEach(() => {
  vi.restoreAllMocks(); h.artifacts.clear(); h.claims.clear();
  h.related.mockReset().mockResolvedValue(false); h.keyAvailable = true; h.now = 1000;
  h.captureRuntimeSecurityCensus.mockReset();
  vi.spyOn(Date, 'now').mockImplementation(() => h.now);
});

describe('authenticated host discovery custody', () => {
  function discovery() {
    const body = { runtimeIdentity: { artifact: { status: 'unknown', reason: 'fixture' } }, hostCaptureSha256: digest('c'),
      rows: Array.from({ length: 503 }, (_, i) => ({ surfaceId: `row-${i}` })),
      unresolved: ['security-population-not-closed:effect'] };
    return { ...body, discoverySha256: createHash('sha256').update(canonicalJson(body)).digest('hex'),
      status: 'captured', total: 503, count: 503, offset: 0, truncatedByLimit: false,
      populationComplete: false, closureAccepted: false, executionAdmitted: false };
  }

  it('persists all host rows and verifies transport-derived producer, scope, digest and explicit gaps', async () => {
    h.captureRuntimeSecurityCensus.mockResolvedValue(discovery());
    const result = await captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer), 'test');
    const verified = await verifyAuthenticatedRuntimeSecurityCensus('test', result);
    expect(verified.receipt).toMatchObject({ actor: ids.producer, at: 1000, workspaceId: 'ws-security',
      snapshotSha256: result.snapshotRef, discoverySha256: result.discoverySha256 });
    expect(verified.snapshot.rows).toHaveLength(503);
    expect(verified.snapshot.unresolved).toEqual(['security-population-not-closed:effect']);
    expect(verified.snapshot.runtimeIdentity.artifact.status).toBe('unknown');
    expect(result).toMatchObject({ populationComplete: false, closureAccepted: false, executionAdmitted: false });
    expect(h.claims.size).toBe(0);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', { approvalRef: result.receiptRef,
      manifestSha256: digest(), ledgerSha256: digest('b') }, vi.fn())).rejects.toThrow();
  });

  it('refuses unauthenticated or cross-harness capture before reading any host state', async () => {
    const unauthenticated = { ...ctx(ids.producer), principal: undefined };
    await expect(captureAuthenticatedRuntimeSecurityCensus(unauthenticated, 'test')).rejects.toThrow('authenticated_actor_required');
    await expect(captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer), 'other')).rejects.toThrow('authenticated_actor_required');
    h.keyAvailable = false;
    await expect(captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer), 'test')).rejects.toThrow('host_key_unavailable');
    expect(h.captureRuntimeSecurityCensus).not.toHaveBeenCalled(); expect(h.artifacts.size).toBe(0);
  });

  it('accepts an explicit concrete harness from operator scope and rejects sentinel targets', async () => {
    h.captureRuntimeSecurityCensus.mockResolvedValue(discovery());
    const result = await captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer, '*'), 'test');
    expect(result).toMatchObject({ producer: ids.producer, readbackVerified: true });
    const verified = await verifyAuthenticatedRuntimeSecurityCensus('test', result);
    expect(verified.receipt).toMatchObject({ harness: 'test', actor: ids.producer });
    await expect(captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer, '*'), 'all'))
      .rejects.toThrow('authenticated_actor_required');
    expect(h.captureRuntimeSecurityCensus).toHaveBeenCalledOnce();
  });

  it('rejects substituted snapshot pins and tampered custody or snapshot bytes', async () => {
    h.captureRuntimeSecurityCensus.mockResolvedValue(discovery());
    const result = await captureAuthenticatedRuntimeSecurityCensus(ctx(ids.producer), 'test');
    await expect(verifyAuthenticatedRuntimeSecurityCensus('test', { ...result, snapshotRef: digest('f') }))
      .rejects.toThrow('discovery_pin_substitution');
    const signed = load(result.receiptRef); signed.receipt.actor = ids.executor;
    const forged = canonicalJson(signed), forgedRef = createHash('sha256').update(forged).digest('hex');
    h.artifacts.set(`test:${forgedRef}`, forged);
    await expect(verifyAuthenticatedRuntimeSecurityCensus('test', { ...result, receiptRef: forgedRef }))
      .rejects.toThrow('host_signature_invalid');
    const snapshot = discovery(); snapshot.rows.pop();
    h.artifacts.set(`test:${result.snapshotRef}`, canonicalJson(snapshot));
    await expect(verifyAuthenticatedRuntimeSecurityCensus('test', result)).rejects.toThrow('discovery_snapshot_mismatch');
  });
});

describe('host-authenticated pre-execution applicability commitment', () => {
  it('pins the independently authenticated reviewer comparison in immutable approval evidence', async () => {
    const { input, request } = await approved();
    const approval = load(input.approvalRef).event;
    const evidence = load(approval.applicabilityEvidenceSha256);
    expect(evidence.producer).toBe(ids.reviewer);
    expect(evidence.manifestSha256).toBe(request.manifestSha256);
    expect(evidence.rows.map((row: { rowId: string }) => row.rowId)).toEqual(request.expectedTuples.map(securityTupleId));
    expect(approval).not.toHaveProperty('expectedTuples');
  });

  it.each(['missing-platform', 'equal-count-substitution', 'changed-na', 'changed-probe'])(
    'refuses independently discovered %s before claiming or writing approval', async fault => {
      const request = await prepare(), before = h.artifacts.size;
      const original = request.expectedTuples[0];
      const extra = { ...original, platform: 'darwin-arm64' };
      const disposition = { rowId: securityTupleId(extra), applicability: 'notApplicable' as const,
        reason: 'independent distribution source', sourceRefs: ['source:distribution'] };
      if (fault === 'missing-platform') {
        request.expectedTuples.push(extra); request.expectedDispositions.push(disposition);
      } else if (fault === 'equal-count-substitution') {
        request.expectedTuples[0] = extra; request.expectedDispositions[0] = disposition;
      } else if (fault === 'changed-na') {
        request.expectedDispositions[0] = { ...disposition, rowId: securityTupleId(original) };
      } else {
        const row = request.expectedDispositions[0];
        if (row.applicability !== 'applicable') throw Error('fixture');
        row.negativeCanary.fixtureSha256 = digest('e');
      }
      await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', request))
        .rejects.toThrow('applicability_reconciliation_mismatch');
      expect(h.artifacts.size).toBe(before);
      expect(h.claims.size).toBe(0);
    });

  it.each(['missing', 'producer-substitution', 'missing-pin'])('rejects %s reconciliation evidence before effects', async fault => {
    const { input, request } = await approved(), execute = vi.fn();
    let approvalRef = input.approvalRef;
    if (fault === 'missing') h.artifacts.delete(`test:${load(approvalRef).event.applicabilityEvidenceSha256}`);
    else approvalRef = mutation(approvalRef, event => {
      if (fault === 'missing-pin') delete event.applicabilityEvidenceSha256;
      else event.applicabilityEvidenceSha256 = request.ledgerSha256;
    }, true);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', { ...input, approvalRef }, execute))
      .rejects.toThrow('applicability_reconciliation');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks the same comparison evidence during final result verification', async () => {
    const { input } = await approved();
    const result = await runSecurityQualification(ctx(ids.executor), 'test', input, async () => 'fixture');
    const ref = load(input.approvalRef).event.applicabilityEvidenceSha256;
    h.artifacts.delete(`test:${ref}`);
    await expect(verifySecurityQualificationResult('test', result)).rejects.toThrow('applicability_reconciliation_mismatch');
  });

  it('signs the exact immutable runner result and rejects corrupted result evidence', async () => {
    const { input } = await approved(); h.now = 3000;
    const measured = { runId: 'actual-router-group', ok: true, files: 1, passed: 2, failed: 0 };
    const result = await runSecurityQualification(ctx(ids.executor), 'test', input, async () => measured, value => value);
    expect(load(result.resultRef).event.executionEvidenceSha256).toBe(result.executionEvidenceSha256);
    const verified = await verifySecurityQualificationResult('test', result);
    expect(verified.executionEvidence).toEqual(measured);
    expect(verified.executionEvidenceSha256).toBe(createHash('sha256').update(canonicalJson(measured)).digest('hex'));
    h.artifacts.set(`test:${result.executionEvidenceSha256}`, canonicalJson({ ...measured, runId: 'substituted' }));
    await expect(verifySecurityQualificationResult('test', result)).rejects.toThrow('execution_evidence_mismatch');
  });
  it('persists independent approval and consumes start before any outcome is observed', async () => {
    const { input, request } = await approved(); h.now = 3000;
    const result = await runSecurityQualification(ctx(ids.executor), 'test', input, async pins => {
      const approval = load(input.approvalRef).event, start = load(pins.startRef).event;
      expect([approval.phase, approval.ordinal, approval.actor, approval.at]).toEqual(['approval', 1, ids.reviewer, 2000]);
      expect([start.parent, start.ordinal, start.actor, start.at]).toEqual([input.approvalRef, 2, ids.executor, 3000]);
      expect(approval.manifestProducerRef).toBe(request.manifestProducerRef);
      expect(approval.ledgerProducerRef).toBe(request.ledgerProducerRef);
      expect(h.claims.size).toBe(2); expect(Object.isFrozen(pins)).toBe(true);
      expect([...h.artifacts.values()].map(v => JSON.parse(v)).filter(v => v.event?.phase === 'result')).toHaveLength(0);
      return 'observed';
    });
    expect(result.value).toBe('observed');
    expect(load(result.resultRef).event).toMatchObject({ parent: result.startRef, ordinal: 3, result: 'passed' });
    const verified = await verifySecurityQualificationResult('test', result);
    expect(verified.ledger.sha256).toBe(input.ledgerSha256);
    await expect(verifySecurityQualificationResult('test', { ...result, ledgerSha256: digest('e') }))
      .rejects.toThrow('result_pin_substitution');
    for (const other of [ids.producer, ids.ledger, ids.executor]) {
      expect(h.related).toHaveBeenCalledWith(ids.reviewer, other, { workspaceId: 'ws-security' });
    }
  });
  it.each(['producer', 'ledger', 'executor'] as const)('refuses %s self-review and aliases/descendants', async role => {
    const request = await prepare();
    await expect(commitSecurityApplicability(ctx(ids[role]), 'test', request)).rejects.toThrow('reviewer_not_independent');
    h.related.mockImplementation(async (_reviewer, other) => other === ids[role]);
    await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', request)).rejects.toThrow('reviewer_not_independent');
    expect(h.claims.size).toBe(0);
  });
  it('propagates unavailable eligibility instead of interpreting it as unrelated', async () => {
    const request = await prepare(); h.related.mockRejectedValue(new Error('lineage-unavailable'));
    await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', request)).rejects.toThrow('lineage-unavailable');
  });
  it('refuses missing approval before executing or observing a result', async () => {
    const request = await prepare(), execute = vi.fn();
    const input = { approvalRef: digest('f'), manifestSha256: request.manifestSha256, ledgerSha256: request.ledgerSha256 };
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('commitment_missing');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['actor', 'at', 'ordinal', 'manifestSha256', 'ledgerSha256'])('rejects forged approval %s', async field => {
    const { input } = await approved(), execute = vi.fn();
    const approvalRef = mutation(input.approvalRef, e => { e[field] = field === 'at' || field === 'ordinal' ? 0 : digest('f'); });
    await expect(runSecurityQualification(ctx(ids.executor), 'test', { ...input, approvalRef }, execute))
      .rejects.toThrow('host_signature_invalid');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['backdated', 'wrong-ordinal', 'future', 'wrong-workspace'])('rejects a signed but %s receipt', async fault => {
    const { input } = await approved(), execute = vi.fn();
    const approvalRef = mutation(input.approvalRef, e => {
      if (fault === 'backdated') e.at = 0;
      if (fault === 'future') e.at = 9000;
      if (fault === 'wrong-ordinal') e.ordinal = 3;
      if (fault === 'wrong-workspace') e.workspaceId = 'foreign';
    }, true);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', { ...input, approvalRef }, execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses timestamp, reviewer and event overrides in the review request', async () => {
    const request = await prepare();
    for (const extra of [{ at: 0 }, { actor: ids.producer }, { phase: 'result' }, { ordinal: 3 }]) {
      await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', { ...request, ...extra })).rejects.toThrow();
    }
  });
  it('requires verified transport identity, ignoring caller attribution alone', async () => {
    const request = await prepare(), context = ctx(ids.reviewer); context.principal = null;
    await expect(commitSecurityApplicability(context, 'test', request)).rejects.toThrow('authenticated_actor_required');
    const unverified = ctx(ids.reviewer); unverified.principal!.trust = 'unverified-loopback';
    await expect(commitSecurityApplicability(unverified, 'test', request)).rejects.toThrow('authenticated_actor_required');
  });
  it('refuses producer substitution, ledger/manifest drift and executor substitution', async () => {
    const { input, request } = await approved(), execute = vi.fn();
    await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', {
      ...request, manifestProducerRef: request.ledgerProducerRef })).rejects.toThrow('producer_receipt_mismatch');
    await expect(runSecurityQualification(ctx(ids.producer), 'test', input, execute)).rejects.toThrow('approval_mismatch');
    for (const field of ['manifestSha256', 'ledgerSha256'] as const) {
      await expect(runSecurityQualification(ctx(ids.executor), 'test', { ...input, [field]: digest('e') }, execute))
        .rejects.toThrow('approval_mismatch');
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('runs once under racing starts and refuses replay after result observation', async () => {
    const { input } = await approved(), execute = vi.fn(async () => 'effect');
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
      runSecurityQualification(ctx(ids.executor), 'test', input, execute)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1); expect(execute).toHaveBeenCalledTimes(1);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('already_consumed');
  });
  it('persists failure and leaves a failed execution consumed', async () => {
    const { input } = await approved(), execute = vi.fn(async () => { throw new Error('forbidden-effect-observed'); });
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('forbidden-effect-observed');
    expect([...h.artifacts.values()].map(v => JSON.parse(v)).filter(v => v.event?.result === 'failed')).toHaveLength(1);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('already_consumed');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rechecks lineage and the host signing key before execution', async () => {
    const { input } = await approved(), execute = vi.fn(); h.related.mockResolvedValue(true);
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('reviewer_not_independent');
    h.keyAvailable = false;
    await expect(runSecurityQualification(ctx(ids.executor), 'test', input, execute)).rejects.toThrow('host_key_unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['late-first-na', 'p020-reopening'])('refuses %s on the frozen population after an outcome', async _fault => {
    const { input, request } = await approved();
    const result = await runSecurityQualification(ctx(ids.executor), 'test', input, async () => 'observed');
    const { ledger } = await import('./security-manifest-store').then(async store => ({
      ledger: (await store.loadSecurityTupleLedger('test', input.ledgerSha256))!,
    }));
    const modified = await prepareAuthenticatedSecurityLedger(ctx(ids.ledger), 'test', {
      manifestSha256: input.manifestSha256, tuples: ledger.body.rows.map(r => r.tuple),
      dispositions: ledger.body.rows.map((r, i) => i ? r.disposition : ({ rowId: r.rowId,
        applicability: 'notApplicable' as const, reason: 'reclassify after observation', sourceRefs: ['fixture:changed'] })),
    });
    await expect(commitSecurityApplicability(ctx(ids.reviewer), 'test', { ...request,
      ledgerSha256: modified.ledger.sha256, ledgerProducerRef: modified.producerRef,
      expectedTuples: modified.ledger.body.rows.map(row => row.tuple),
      expectedDispositions: modified.ledger.body.rows.map(row => row.disposition) })).rejects.toThrow('claim_conflict');
    await expect(verifySecurityQualificationResult('test', { ...result, ledgerSha256: modified.ledger.sha256 }))
      .rejects.toThrow('result_pin_substitution');
  });
});
