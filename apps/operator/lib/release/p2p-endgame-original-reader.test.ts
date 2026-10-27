/** Local acquisition regressions, separate from the independent frozen outcome oracle. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { candidateArtifactDigest } from './p2p-candidate-manifest';
import type { DerivedCandidateProvenance } from './p2p-candidate-evidence';
import { readCanonicalEndgameComponents } from './p2p-endgame-original-reader';
import { hashPlanContent } from '../../../../packages/operator-core/lib/agent-tools/plans/content-hash';
import type { EndgameOutcomeRequest } from './p2p-endgame-outcomes';

const io = vi.hoisted(() => ({
  plan: vi.fn(), revision: vi.fn(), audit: vi.fn(), activation: vi.fn(),
  bindings: vi.fn(), evidence: vi.fn(), provenance: vi.fn(), rubric: vi.fn(), cards: vi.fn(),
  archiveRoot: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock('../../../../packages/operator-core/lib/workspace-registry', () => ({ activeWorkspaceId: io.workspace }));
vi.mock('@papercusp/verification-harness', () => ({ defaultEvidenceRoot: io.archiveRoot }));
vi.mock('../../../../packages/operator-core/lib/agent-tools/plans/source', () => ({ getPlanRow: io.plan }));
vi.mock('../../../../packages/operator-core/lib/agent-tools/plans/revisions', () => ({ getPlanRevisionSnapshot: io.revision }));
vi.mock('../../../../packages/operator-core/lib/plan-audits', () => ({ getLatestPlanAudit: io.audit, getLatestActivationAudit: io.activation }));
vi.mock('../../../../packages/operator-core/lib/agent-tools/plans/spec-evidence-store', () => ({ listSpecEvidence: io.bindings }));
vi.mock('../../../../packages/operator-core/lib/testing-run-store', () => ({ readHarnessTestRunEvidence: io.evidence,
  readTrustedHarnessTestRunProvenance: io.provenance }));
vi.mock('../../../../packages/operator-core/lib/rubrics', () => ({ getRubricWithoutSeeding: io.rubric }));
vi.mock('../../../../packages/operator-core/lib/scorecards', () => ({ listScorecards: io.cards }));

const sourceSha = 'a'.repeat(40);
const artifacts = [{ name: 'server.zip', sha256: 'b'.repeat(64) }];
const digest = candidateArtifactDigest(artifacts);
const build = { tool: 'release:cut', invocationId: 'cut-1', args: {
  op: 'run', confirm: true, version: '1.0.0', channel: 'alpha', sourceSha,
} };
const candidate: DerivedCandidateProvenance = {
  version: '1.0.0', channel: 'alpha', sourceSha, artifacts,
  provenance: { schemaVersion: 1, version: '1.0.0', channel: 'alpha', sourceSha,
    desktopSha: null, buildSha: null, candidateDigest: digest,
    artifacts: artifacts.map(a => ({ ...a, bytes: null, sources: ['ledger'], sig: null })),
    legs: [], ledger: null, buildCommand: build, checks: [], ok: true },
};
const request: EndgameOutcomeRequest = { workspaceId: 'workspace-a', harnessSlug: 'papercusp',
  planSlug: 'p2p-public-release-endgame-2026-09-01', outcome: 'P-521', sourceSha, artifactDigest: digest };
function readers() {
  return { workspaceId: request.workspaceId,
    sql: vi.fn().mockResolvedValue([]),
    readLedger: vi.fn().mockResolvedValue({ version: '1.0.0', channel: 'alpha', gitSha: sourceSha, artifacts }),
    readBuildCommand: vi.fn().mockResolvedValue(build) };
}
const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function retainedNative() {
  const root = mkdtempSync(join(tmpdir(), 'endgame-canonical-originals-'));
  temporaryRoots.push(root);
  const runId = '20261023T000000Z-123';
  const archive = join(root, 'retained', runId);
  const artifacts = ['result.json', 'phases/prepare/source.json', 'phases/execute/lifecycle.json'];
  const hashes = artifacts.map((file, i) => {
    const bytes = JSON.stringify({ original: i });
    const path = join(archive, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
    return createHash('sha256').update(bytes).digest('hex');
  });
  io.archiveRoot.mockReturnValue(root);
  const execution = { schemaVersion: 1, root: '/native/root', filePath: 'qualification.test.ts', runGroupId: 'native-group',
    workspaceId: request.workspaceId, harnessSlug: request.harnessSlug, testNamePattern: null,
    passed: 1, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null, commitSha: sourceSha, worktreeDirty: false,
    isolatedRuntimeReceipts: [{ runId, resultSha256: hashes[0], sourceSha256: hashes[1], lifecycleSha256: hashes[2] }] };
  io.bindings.mockResolvedValue([{ id: 10, testRunId: 123, currentness: { overall: 'current' },
    testRunProvenance: { commitSha: sourceSha, worktreeDirty: false } }]);
  io.evidence.mockResolvedValue([{ id: 123, execution_details: execution }]);
  io.provenance.mockResolvedValue({ commitSha: sourceSha });
  const r = readers();
  r.sql.mockResolvedValue([{ id: 123, run_group_id: 'native-group', execution_details: execution }]);
  return { r, archive, runId };
}
beforeEach(() => {
  vi.resetAllMocks();
  io.workspace.mockReturnValue(request.workspaceId);
  io.plan.mockResolvedValue(null);
  io.revision.mockResolvedValue(null);
  io.audit.mockResolvedValue(null);
  io.activation.mockResolvedValue(null);
  io.bindings.mockResolvedValue([]);
});

describe('canonical outcome component acquisition', () => {
  it('retains the exact available release/build pins while missing custody prevents an outcome', async () => {
    const r = readers();
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(acquired.originals).toBeNull();
    expect(acquired.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'release-ledger', ref: 'release:workspace-a:alpha:1.0.0', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ name: 'build-invocation', ref: 'tool-invocation:workspace-a:cut-1' }),
    ]));
    expect(acquired.missing).toContain('candidate-linked-host-custody');
    expect(acquired.missing).toContain('seed-original-inventory');
    expect(io.plan).toHaveBeenCalledWith(request.planSlug, expect.objectContaining({ workspaceId: 'workspace-a', harnessSlug: 'papercusp' }));
    expect(r.sql).not.toHaveBeenCalled();
  });

  it('rejects foreign scope before reading shared records', async () => {
    const r = readers();
    const acquired = await readCanonicalEndgameComponents({ ...request, workspaceId: 'foreign' }, candidate, r);
    expect(acquired.components).toEqual([]);
    expect(acquired.missing).toEqual(['candidate-scope']);
    expect(r.readLedger).not.toHaveBeenCalled();
    expect(io.plan).not.toHaveBeenCalled();
  });

  it('does not vouch for another artifact set from the same source commit', async () => {
    const r = readers();
    r.readLedger.mockResolvedValue({ version: '1.0.0', channel: 'alpha', gitSha: sourceSha,
      artifacts: [{ ...artifacts[0], sha256: 'c'.repeat(64) }] });
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(acquired.missing).toContain('release-ledger');
    expect(acquired.missing).toContain('build-invocation');
    expect(acquired.components.some(c => c.name === 'release-ledger')).toBe(false);
  });

  it('preserves independently available components when a plan reader fails', async () => {
    io.plan.mockRejectedValue(new Error('private database acquisition detail'));
    const acquired = await readCanonicalEndgameComponents(request, candidate, readers());
    expect(acquired.components.map(c => c.name)).toEqual(['release-ledger', 'build-invocation', 'spec-evidence']);
    expect(acquired.missing).toContain(`plan:${request.planSlug}`);
    expect(JSON.stringify(acquired)).not.toContain('private database acquisition detail');
  });

  it('does not use a dirty bound run or an unbound nearby run as native evidence', async () => {
    io.bindings.mockResolvedValue([{ id: 10, testRunId: 123, currentness: { overall: 'current' },
      testRunProvenance: { commitSha: sourceSha, worktreeDirty: true } }]);
    const r = readers();
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(r.sql).not.toHaveBeenCalled();
    expect(io.evidence).not.toHaveBeenCalled();
    expect(acquired.missing).toContain('native-original-bytes');
    expect(acquired.originals).toBeNull();
  });

  it('retains the missing diagnostic when exact native ledger lookup returns a malformed result', async () => {
    io.bindings.mockResolvedValue([{ id: 10, testRunId: 123, currentness: { overall: 'current' },
      testRunProvenance: { commitSha: sourceSha, worktreeDirty: false } }]);
    const r = readers();
    r.sql.mockResolvedValue({ rows: [] });
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(r.sql).toHaveBeenCalledOnce();
    expect(acquired.missing).toContain('native:123');
    expect(io.provenance).not.toHaveBeenCalled();
    expect(acquired.originals).toBeNull();
  });

  it('rehashes real retained native bytes without treating their capture as physical custody', async () => {
    const { r, runId } = retainedNative();
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(io.archiveRoot).toHaveBeenCalledWith('isolated-integration');
    expect(io.provenance).toHaveBeenCalledWith(expect.objectContaining({ testRunIds: [123],
      workspaceId: request.workspaceId, harnessSlug: request.harnessSlug, runGroupId: 'native-group' }));
    expect(acquired.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `native-original:123:${runId}` }),
    ]));
    expect(acquired.missing).not.toContain('native-original-bytes');
    expect(acquired.missing).toContain('physical-receipt-custody');
    expect(acquired.originals).toBeNull();
  });

  it('refuses retained bytes changed after the native reporter recorded their hashes', async () => {
    const { r, archive, runId } = retainedNative();
    writeFileSync(join(archive, 'phases/execute/lifecycle.json'), '{"tampered":true}');
    const acquired = await readCanonicalEndgameComponents(request, candidate, r);
    expect(acquired.missing).toContain(`native-original:123:${runId}`);
    expect(acquired.missing).toContain('native-original-bytes');
    expect(acquired.components.some(c => c.name.startsWith('native-original:'))).toBe(false);
    expect(acquired.originals).toBeNull();
  });

  it('keeps scoped plan originals but refuses rubric/card reads from another active workspace', async () => {
    const content = '# Canonical scoped plan\n';
    const contentHash = hashPlanContent(content);
    io.plan.mockImplementation(async (slug: string) => slug === request.planSlug
      ? { workspaceId: request.workspaceId, harnessSlug: request.harnessSlug, planSlug: slug,
        version: 1, content, contentHash, forcedPast: null, activeAcceptanceRubricRef: 'acceptance-scoped' } : null);
    io.revision.mockResolvedValue({ id: 7, planSlug: request.planSlug, seq: 1, contentHash,
      contentSnapshot: content, contentSnapshotHash: createHash('sha256').update(content).digest('hex') });
    io.workspace.mockReturnValue('another-workspace');
    const acquired = await readCanonicalEndgameComponents(request, candidate, readers());
    expect(acquired.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: `plan:${request.planSlug}` }),
      expect.objectContaining({ name: `revision:${request.planSlug}` }),
    ]));
    expect(acquired.missing).toContain(`rubric:${request.planSlug}:workspace-context`);
    expect(io.rubric).not.toHaveBeenCalled();
    expect(io.cards).not.toHaveBeenCalled();
    expect(acquired.originals).toBeNull();
  });
});
