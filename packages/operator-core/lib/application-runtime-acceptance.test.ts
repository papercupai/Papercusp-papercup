import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptanceBarContractSnapshot } from './acceptance-bar-contract-snapshot';
import type { ApplicationRuntimeCandidate } from './bundled-node';
const h = vi.hoisted(() => ({ snapshot: vi.fn(), artifacts: vi.fn() }));
vi.mock('./acceptance-bar-contract-snapshot', () => ({ readAcceptanceBarContractSnapshot: h.snapshot }));
vi.mock('./agent-tools/plans/spec-evidence-store', () => ({ readCurrentOperationalArtifacts: h.artifacts }));
import { BUN_MIGRATION_PLAN, readApplicationRuntimeAcceptance } from './application-runtime-acceptance';

const sha = (n: number) => String(n).repeat(64);
const reference = 'docs/evidence/bun-candidate.json';
function fixture() {
  const candidate: ApplicationRuntimeCandidate = {
    candidateSha256: sha(1), sourceSha: 'a'.repeat(40), roles: ['host'],
    entrypoint: '/package/serve.mjs', entrypointSha256: sha(2),
    node: { name: 'node', executable: '/package/node', binarySha256: sha(3), version: '24.18.1', platform: 'linux', arch: 'x64' },
    bun: { name: 'bun', executable: '/package/bun', binarySha256: sha(4), version: '1.4.4', platform: 'linux', arch: 'x64' },
  };
  const row = { id: 1, evidenceRef: reference, evidenceKind: 'operational', matchesCurrentSpec: true,
    activeAttempt: true, createdAt: '2026-10-30T00:00:00Z', currentness: { overall: 'current' } };
  const snapshot = {
    contentHash: sha(9), applicable: true, planSlug: BUN_MIGRATION_PLAN,
    plan: { workspaceId: 'workspace-test', harnessSlug: 'papercusp', rubricSlug: 'bun-acceptance', rubricRevision: 3, barSetHash: sha(5) },
    rubric: { rubricId: 'bun-acceptance', revision: 3, criteriaHash: sha(6), barSetHash: sha(5) },
    completeness: { complete: true, truncated: false }, lineage: { complete: true }, bounded: { evidence: { truncated: false } },
    grading: { authoritativeScorecardId: 'SC-independent', gradedBy: 'independent', selectedVia: 'ranked',
      rubricRevision: 3, criteriaHash: sha(6), vetting: { state: 'current' },
      authorVerdict: { state: 'accepted-pending-delivery', scorecardId: 'SC-author', supersedes: 'SC-independent',
        rubricRevision: 3, criteriaHash: sha(6) } },
    bars: Array.from({ length: 8 }, (_, index) => ({
      barKey: `R-${index + 1}`, mandatory: true, passRatings: ['healthy'],
      requiredScope: ['gui:linux-x86_64', 'server:linux-x86_64'],
      readiness: { state: index === 7 ? 'blocked' : 'ready' },
      proof: { state: 'current', uncertainEvidence: 0, history: [structuredClone(row)] },
      grading: { state: 'pass', scorecardId: 'SC-independent', rubricRevision: 3, criteriaHash: sha(6), rating: 'healthy',
        history: [{ scorecardId: 'SC-independent', role: 'independent', authoritative: true, currentRevision: true,
          complete: true, retracted: false, createdAt: '2026-10-31T00:00:00Z' }] },
    })),
  } as unknown as AcceptanceBarContractSnapshot;
  const artifact = { artifact: { schemaVersion: 'application-runtime-candidate/v1', planSlug: BUN_MIGRATION_PLAN,
    candidateSha256: sha(1), sourceSha: candidate.sourceSha, role: 'host', binarySha256: sha(4),
    nodeBinarySha256: sha(3), entrypointSha256: sha(2), validUntil: Date.now() + 60_000 },
    sha256: sha(7), measuredAtCommit: 'b'.repeat(40) };
  const signedArtifacts = ['gui:linux-x86_64', 'server:linux-x86_64'].map(scope => ({
    scope, sha256: sha(8), candidateSha256: sha(1), signatureVerificationRef: 'docs/evidence/signature-verification.json',
  }));
  const finalArtifact = { ...artifact, artifact: { ...artifact.artifact, signedArtifacts } };
  h.snapshot.mockResolvedValue(snapshot);
  h.artifacts.mockResolvedValue(new Map([[1, finalArtifact]]));
  return { snapshot, artifact: finalArtifact, request: { harnessSlug: 'papercusp', evidenceRef: reference, candidate, role: 'host' } };
}

beforeEach(() => vi.resetAllMocks());
describe('Bun pre-cutover canonical acceptance', () => {
  it('accepts the exact independently graded candidate while only final shipment is pending', async () => {
    const { request } = fixture();
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toMatchObject({
      verdict: 'accepted', evidenceRef: reference, candidateSha256: sha(1), binarySha256: sha(4), nodeBinarySha256: sha(3),
    });
    expect(h.snapshot).toHaveBeenCalledWith(BUN_MIGRATION_PLAN, {}, { harnessSlug: 'papercusp' });
    expect(h.artifacts).toHaveBeenCalledWith('workspace-test', 'papercusp', [expect.objectContaining({ id: 1 })]);
  });

  it.each([
    ['inapplicable contract', (s: AcceptanceBarContractSnapshot) => { s.applicable = false; }],
    ['incomplete read', s => { s.completeness.complete = false; }],
    ['truncated read', s => { s.bounded.evidence.truncated = true; }],
    ['incomplete lineage', s => { s.lineage.complete = false; }],
    ['wrong harness', s => { s.plan!.harnessSlug = 'other'; }],
    ['stale BAR set', s => { s.plan!.barSetHash = sha(8); }],
    ['stale rubric pin', s => { s.plan!.rubricRevision = 2; }],
    ['unvetted rubric', s => { s.grading.vetting.state = 'stale'; }],
    ['absent grader selection', s => { s.grading.selectedVia = null; }],
    ['missing independent grade', s => { s.grading.authoritativeScorecardId = null; }],
    ['stale grading', s => { s.grading.criteriaHash = sha(8); }],
    ['missing author verdict', s => { s.grading.authorVerdict.state = 'missing'; }],
    ['rejected author verdict', s => { s.grading.authorVerdict.state = 'rejected'; }],
    ['unrelated author verdict', s => { s.grading.authorVerdict.supersedes = 'SC-other'; }],
    ['unrecognized BAR population', s => { s.bars.push(structuredClone(s.bars[0]!)); }],
    ['missing eligibility BAR', s => { s.bars[0]!.barKey = 'R-9'; }],
    ['blocked eligibility', s => { s.bars[0]!.readiness.state = 'blocked'; }],
    ['stale proof', s => { s.bars[0]!.proof.state = 'stale'; }],
    ['uncertain proof', s => { s.bars[0]!.proof.uncertainEvidence = 1; }],
    ['failing grade', s => { s.bars[0]!.grading.state = 'not-pass'; }],
    ['implementer grade', s => { s.bars[0]!.grading.history![0]!.role = 'implementer'; }],
    ['retracted grade', s => { s.bars[0]!.grading.history![0]!.retracted = true; }],
    ['candidate absent from one BAR', s => { s.bars[0]!.proof.history = []; }],
    ['candidate bound after grading', s => { s.bars[0]!.proof.history![0]!.createdAt = '2026-11-01T00:00:00Z'; }],
    ['superseded candidate binding', s => { s.bars[0]!.proof.history![0]!.activeAttempt = false; }],
    ['wrong clause revision', s => { s.bars[0]!.proof.history![0]!.matchesCurrentSpec = false; }],
  ] satisfies Array<[string, (snapshot: AcceptanceBarContractSnapshot) => void]>)('refuses %s', async (_name, mutate) => {
    const { request, snapshot } = fixture(); mutate(snapshot);
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    expect(h.artifacts).not.toHaveBeenCalled();
  });

  it.each(['candidateSha256', 'sourceSha', 'role', 'binarySha256', 'nodeBinarySha256', 'entrypointSha256'] as const)(
    'refuses wrong candidate tuple field %s', async field => {
      const { request, artifact } = fixture(); artifact.artifact[field] = field === 'role' ? 'background' : sha(8);
      await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    });
  it('refuses expired, uncommitted, unmeasured and unreadable artifacts', async () => {
    const { request, artifact } = fixture(); artifact.artifact.validUntil = Date.now() - 1;
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    artifact.artifact.validUntil = Date.now() + 60_000;
    h.artifacts.mockResolvedValue(new Map([[1, { ...artifact, measuredAtCommit: null }]]));
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    h.artifacts.mockResolvedValue(new Map());
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    h.artifacts.mockResolvedValue(new Map([[1, { error: 'digest mismatch' }]]));
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
  });
  it('refuses revoked authority during the artifact read', async () => {
    const { request, snapshot } = fixture();
    h.snapshot.mockResolvedValueOnce(snapshot).mockResolvedValueOnce({ ...snapshot, contentHash: sha(8) });
    await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
  });
  it.each(['missing', 'duplicate', 'substituted', 'wrong-candidate', 'unsigned'])(
    'refuses %s final signed artifact coverage before cutover', async condition => {
      const { request, artifact } = fixture();
      if (condition === 'missing') artifact.artifact.signedArtifacts.pop();
      if (condition === 'duplicate') artifact.artifact.signedArtifacts[1] = artifact.artifact.signedArtifacts[0]!;
      if (condition === 'substituted') artifact.artifact.signedArtifacts[1]!.scope = 'server:linux-arm64';
      if (condition === 'wrong-candidate') artifact.artifact.signedArtifacts.forEach(row => { row.candidateSha256 = sha(8); });
      if (condition === 'unsigned') artifact.artifact.signedArtifacts[0]!.signatureVerificationRef = '';
      await expect(readApplicationRuntimeAcceptance(request)).resolves.toBeNull();
    });
});
