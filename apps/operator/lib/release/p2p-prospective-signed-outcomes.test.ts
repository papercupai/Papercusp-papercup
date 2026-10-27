/** D294-D296 independent signed outcome originals, WI-6554700010020476.
 * Generated private keys and witness files are unit controls, never rig evidence.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson, signAuthorityRpc, verifyAuthorityRpc,
} from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { signWithPrivateKeyDer } from '../../../../packages/operator-core/lib/identity/ed25519';
import {
  citationBlobShaAt, planItemTextHash, repoCitationDeps,
} from '../../../../packages/operator-core/lib/plan-audits';
import { hashPlanContent } from '../../../../packages/operator-core/lib/agent-tools/plans/content-hash';
import {
  resolveAcceptanceGraderEligibility,
} from '../../../../packages/operator-core/lib/agent-tools/scorecards/grader-eligibility';
import * as rubricRecords from '../../../../packages/operator-core/lib/rubrics';
import * as scorecardRecords from '../../../../packages/operator-core/lib/scorecards';
import { validatePhysicalDrillEvidence } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-evidence';
import { validatePhysicalPhaseG } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-g';
import { validatePhysicalPhaseI, phaseITargetOf } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-i';
import { buildPhysicalPhaseIInput } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-phase-i.fixture';
import { physicalDrillSigningBytes } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-evidence';
import { physicalDrillHostReceiptSigningBytes } from '../../../../packages/operator-core/lib/sync/pot-git/physical-drill-host-receipt';
import { buildSignedPhysicalFixture } from './p2p-signed-physical.fixture';
import {
  deriveJourneyEvidence, validateEndgameDefaultChoice,
} from './p2p-candidate-evidence';
import { buildP2pCandidateManifest } from './p2p-candidate-manifest';
import {
  computeCandidateManifestFromRecords, type ComputeDeps, type ComputeOptions,
} from './run-p2p-candidate-manifest';

type Data = Record<string, any>; // Mutable private originals for one-field corruption tests.
const PLAN = 'p2p-public-release-endgame-2026-09-01';
const WORKSPACE = process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
const HARNESS = 'papercusp';
const SOURCE = 'cbd21646b5c73bd23cad5608f9526cf9bd0048ce';
const DESKTOP = 'b'.repeat(40);
const AUTHOR = 'private-implementation-owner';
const AUDITOR = 'private-independent-auditor';
const CRITIC = 'private-rubric-critic';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ARTIFACT = sha('signed-outcome-private-installer');
const DIGEST = sha(`${ARTIFACT}  SignedFixture.deb\n`);
const GO_AT = '2026-08-13T12:31:00.000Z';
const NOW = Date.parse('2026-08-13T13:40:00Z');
const JOURNEYS = ['discovery-join', 'git-consistency-signed-scope', 'serving-identity-restart',
  'replicated-write-outage-replay', 'delegated-seat-lifecycle', 'protected-effect-fencing', 'github-bridge', 'full-installer-compat'];
const PREREQUISITES = ['P-512', 'P-513', 'P-514', 'P-515', 'P-516', 'P-517', 'P-518', 'P-520', 'P-521'];
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const temporary: string[] = [];
let physicalTemplate: { witness: Awaited<ReturnType<typeof buildSignedPhysicalFixture>>;
  drill: Awaited<ReturnType<typeof buildSignedPhysicalFixture>> };
let physicalRoot: string;
beforeAll(async () => {
  physicalRoot = mkdtempSync(join(tmpdir(), 'p2p-signed-physical-'));
  const witnessDir = join(physicalRoot, 'witness'), drillDir = join(physicalRoot, 'drill');
  mkdirSync(witnessDir); mkdirSync(drillDir);
  // PhaseG's private Git runner reaches the supported legacy-index diagnostic.
  // Record that exact diagnostic; any other warning fails.
  const warnings: string[] = [];
  const warning = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
  try {
    physicalTemplate = {
      witness: await buildSignedPhysicalFixture(witnessDir, 0, { sourceSha: SOURCE, artifactDigest: DIGEST }),
      drill: await buildSignedPhysicalFixture(drillDir, 3_600_000, { sourceSha: SOURCE, artifactDigest: DIGEST }),
    };
    for (const text of warnings) expect(text).toMatch(/catch-all commit refused: the git runner did not forward GIT_INDEX_FILE/);
  } finally { warning.mockRestore(); }
}, 120_000);
afterAll(() => { if (physicalRoot) rmSync(physicalRoot, { recursive: true, force: true }); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function blob(ref: string, value: unknown) {
  const bytes = canonicalJson(value);
  return { ref, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
}
function revision(current: Data, id: number) {
  return { id, planSlug: current.planSlug, seq: current.version, contentHash: current.contentHash,
    contentSnapshot: current.content, contentSnapshotHash: sha(current.content) };
}
function planRow(items: Data[], decision?: Data): Data {
  const content = `---\ntitle: Private signed outcome fixture\nstatus: active\n---\n\n## Work\n${items.map(item =>
    `- **${item.id}** \`${item.status}\` ${item.text}`).join('\n')}\n${decision ? `\n## Decisions\n### ${decision.id} — ${decision.title}\n${decision.body}\n` : ''}`;
  return { workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN, content, contentHash: hashPlanContent(content),
    version: decision ? 12 : 11, title: 'Private signed outcome fixture', status: 'active',
    owner: AUTHOR, created: '2026-08-13T11:00:00Z', updated: GO_AT, updatedAt: GO_AT,
    initiative: null, template: null, templateData: null, inputSchema: null, outputSchema: null,
    supersedes: [], supersededBy: null, opStatus: null, opStartedAt: null, opUpdatedAt: null,
    currentWave: null, opPriority: null, archived: false, isLegacy: false, items, decisions: decision ? [decision] : [],
    nowState: null, nowNext: null, nowNote: null, promotePolicy: null, forcedPast: null, schedule: null,
    scheduleActive: false, scheduledAt: null, expiresAt: null, tzid: null, templateSlug: null, runSeq: null };
}
function optionsAndDeps(reader?: (request: Data) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'p2p-signed-outcomes-')); temporary.push(dir);
  const path = join(dir, 'build-provenance.json');
  writeFileSync(path, JSON.stringify({ version: '0.0.25', buildSha: DESKTOP.slice(0, 12), gitHead: DESKTOP,
    gitDirty: false, gitDirtyAtEmit: false, reused: false,
    dirtySource: { status: 'captured', repositories: [
      { label: 'workspace', gitHead: SOURCE, files: [] }, { label: 'desktop', gitHead: DESKTOP, files: [] },
    ] }, builtAtUtc: '2026-08-13T11:59:00Z', artifacts: [{ name: 'SignedFixture.deb', sha256: ARTIFACT, bytes: 41, sig: true }] }));
  const deps: ComputeDeps = {
    readLedger: async () => ({ version: '0.0.25', channel: 'alpha', gitSha: SOURCE,
      artifacts: [{ name: 'SignedFixture.deb', sha256: ARTIFACT }] }),
    readBuildCommand: async () => ({ tool: 'release:cut', invocationId: 'private-signed-build',
      invokedAt: '2026-08-13T11:58:00Z', servingBuildSha: SOURCE,
      args: { op: 'run', version: '0.0.25', channel: 'alpha', confirm: true, sourceSha: SOURCE } }),
    hashFile: async () => ARTIFACT,
  };
  if (reader) Object.assign(deps, { readEndgameOutcomeOriginals: reader });
  return { options: { version: '0.0.25', channel: 'alpha', legs: [{ leg: 'linux', path }], repoRoot: dir, now: NOW } as ComputeOptions, deps };
}
async function compute(reader?: (request: Data) => Promise<unknown>) {
  const { options, deps } = optionsAndDeps(reader);
  return computeCandidateManifestFromRecords(options, deps);
}

function resignPhysical(packet: Awaited<ReturnType<typeof buildSignedPhysicalFixture>>) {
  const bytes = physicalDrillSigningBytes(packet.evidence);
  packet.evidence.attestations = packet.signingDevices.map(device => ({ deviceKey: device.pubkeyBase64,
    signature: signWithPrivateKeyDer(device.privateKeyDer, bytes).toString('base64') }));
  for (const receipt of packet.trust.receipts) {
    const index = packet.signingDevices.findIndex(device => device.pubkeyBase64 === receipt.deviceKey);
    receipt.evidenceSigningSha256 = sha(bytes);
    receipt.evidenceAttestation = packet.evidence.attestations[index].signature;
    receipt.signature = signWithPrivateKeyDer(packet.signingDevices[index]!.privateKeyDer,
      physicalDrillHostReceiptSigningBytes(receipt)).toString('base64');
  }
}

async function signedPacket() {
  const candidate = (await compute()).provenance;
  const pins = { sourceSha: SOURCE, artifactDigest: DIGEST };
  const witness = structuredClone(physicalTemplate.witness);
  const drill = structuredClone(physicalTemplate.drill);
  // Structured clone converts Buffers into Uint8Arrays; reconstruct the private
  // DER buffers for Node crypto while keeping each test's packet isolated.
  for (const packet of [witness, drill]) for (const device of packet.signingDevices) device.privateKeyDer = Buffer.from(device.privateKeyDer);
  drill.evidence.legI = buildPhysicalPhaseIInput({ runId: drill.evidence.runId,
    towerDeviceKey: drill.trust.hosts.find((host: Data) => host.id === 'tower').deviceKey,
    vmDeviceKey: drill.trust.hosts.find((host: Data) => host.id === 'vm').deviceKey,
    startMs: Date.parse('2026-08-13T13:25:00Z'),
    canary: { workspaceId: WORKSPACE, potHomeSlug: 'private-canary-owner', repoKey: 'private-canary-owner:main' } });
  resignPhysical(drill);

  // Private unit originals declare an installer; no separate runtime or seed
  // artifact is part of this fixture's candidate. These are fixture receipts,
  // not measured prechecks or physical acceptance on a real candidate.
  const precheckSubject = { artifactDigest: DIGEST, installerSha256: ARTIFACT };
  const journeyEvidence = JOURNEYS.map(journey => {
    const localPrechecks = [{ journey, check: `p521-local-precheck:${journey}`, verdict: 'pass',
      startedAt: '2026-08-13T11:59:00Z', finishedAt: '2026-08-13T11:59:30Z',
      subject: { ...precheckSubject }, command: ['private-fixture-local-precheck', journey],
      evidence: [{ kind: 'local-precheck', ref: `fixture:local-precheck:${journey}` }],
      exitCode: 0, skipped: false }];
    const doc = { kind: 'operational-test-evidence', name: `Private ${journey}`, p521Journey: journey,
      subject: { debSha256: ARTIFACT, sourceSha: SOURCE, topology: { hosts: [{ id: 'tower' }, { id: 'mac-vm' }] } },
      exitCode: 0, skipped: 0, startedAt: '2026-08-13T12:00:00Z', finishedAt: '2026-08-13T12:29:00Z',
      precheckSubject: { ...precheckSubject }, localPrechecks,
      assertions: [{ id: `complete-${journey}`, passed: true }], physicalRun: witness.evidence };
    return { path: `fixture:${journey}`, sha256: sha(canonicalJson(doc)), doc };
  });
  const derived = deriveJourneyEvidence({ candidate, evidence: journeyEvidence });
  const readiness = await buildP2pCandidateManifest({ candidate, journeys: derived.journeys,
    localPrechecks: derived.localPrechecks, now: Date.parse('2026-08-13T12:30:40Z') });
  const items = [...PREREQUISITES.map(id => ({ id, status: 'done', text: `Private current ${id} candidate evidence`,
    importance: 'normal', blockedBy: [], decisionRefs: [], phase: null })),
  { id: 'P-401', status: 'wip', text: 'Independent same-candidate GO after complete readiness and current ledger audit.', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null },
  ...['P-502', 'P-503', 'P-403', 'P-404'].map(id => ({ id, status: 'open', text: `Post-GO sibling ${id}`, importance: 'normal', blockedBy: [], decisionRefs: [], phase: null }))];
  const current = planRow(items);
  const snapshot = revision(current, 8100);
  const citation = { kind: 'code' as const, path: 'apps/operator/lib/release/run-p2p-candidate-manifest.ts' };
  const git = repoCitationDeps(root);
  const auditedBlob = await citationBlobShaAt(citation, SOURCE, git);
  expect(auditedBlob, 'fixture requires a real candidate citation').toMatch(/^[a-f0-9]{40}$/);
  const boundCitation = { ...citation, blobSha: auditedBlob! };
  const audit = { planSlug: PLAN, harnessSlug: HARNESS, auditSeq: 17, createdBy: AUDITOR,
    createdAt: '2026-08-13T12:30:45Z', auditKind: 'completion', auditedSha: SOURCE, activation: null,
    auditedPlanRevision: { id: snapshot.id, seq: snapshot.seq, contentHash: snapshot.contentHash },
    items: items.filter(item => !['P-502', 'P-503', 'P-403', 'P-404'].includes(item.id)).map(item => ({ itemId: item.id,
      verdict: 'implemented', citations: [boundCitation], auditedSha: SOURCE, auditedAt: '2026-08-13T12:30:45Z', itemTextHash: planItemTextHash(item.text) })),
    findings: [], summary: 'Private item-scoped GO audit; post-GO siblings intentionally remain open.' };
  const data = { kind: 'acceptance', subjectPlan: PLAN, characteristic: 'private-go-identity',
    criteria: [{ key: 'go', title: 'Independent GO', model: 'Current complete candidate with an independent auditor.', driftMarkers: 'A foreign candidate or author identity falsifies it.' }],
    ratingScale: ['healthy', 'broken', 'unknown'], gradingAuthority: 'independent' };
  const stored = { plan_slug: `acceptance-${PLAN}`, workspace_id: WORKSPACE, harness_slug: HARNESS,
    title: 'Private rubric', status: 'active', created: '2026-08-13T11:00:00Z', updated: '2026-08-13T11:00:00Z',
    updated_at: '2026-08-13T11:00:00Z', owner: AUTHOR, archived: false, version: 2, template_data: data };
  const rubric = rubricRecords.planRowToRubric(stored)!;
  expect(rubric).not.toBeNull();
  const rubricBody = '---\ntitle: Private identity rubric\nstatus: active\n---\n';
  const encoded = rubricRecords.formatRubricRevisionSnapshot(rubricBody, data, rubric.criteriaHash!, 2);
  const rubricSnapshot = { id: 8200, planSlug: rubric.rubricId, seq: 7, contentHash: hashPlanContent(rubricBody),
    contentSnapshot: encoded, contentSnapshotHash: sha(encoded) };
  const vetting = { issueId: 'EI-990001', createdBy: CRITIC, createdAt: '2026-08-13T11:10:00Z', rubricRef: 'meta-acceptance-rubric',
    subject: { kind: 'rubric' as const, ref: rubric.rubricId }, vetting: { workItemId: 'WI-990001', rubricRevision: 2,
      criteriaHash: rubric.criteriaHash, critiquePosts: 1, critics: [CRITIC] } };
  vi.spyOn(rubricRecords, 'readRubricPlanRevision').mockResolvedValue({ ok: true, revision: 2 });
  vi.spyOn(scorecardRecords, 'listScorecards').mockResolvedValue([vetting as unknown as scorecardRecords.ScorecardRow]);
  const eligibility = await resolveAcceptanceGraderEligibility({ rubric, callerId: AUDITOR, workspaceId: WORKSPACE,
    deps: { sameAcceptanceAuthor: async (a, b) => a === b, lineageRelated: async (a, b) => a === b,
      resolvePlanImplementerIdentities: async () => [AUTHOR] } });
  const candidateBindings = [{ planSlug: PLAN, auditSeq: audit.auditSeq, candidate,
    citations: [{ citation: boundCitation, auditedBlob, candidateBlob: await citationBlobShaAt(citation, SOURCE, git) }] }];
  const ledgerFlips = [{ current, snapshot, audit }];
  const signerReceipt = witness.trust.receipts[0];
  const signerIdentity = { schemaVersion: 'hive-git-physical-host-identity/v1', hostId: signerReceipt.hostId,
    deviceKey: signerReceipt.deviceKey, keychainId: signerReceipt.keychainId, githubUserId: signerReceipt.githubUserId,
    githubLogin: signerReceipt.githubLogin, machineFingerprint: signerReceipt.machineFingerprint };
  const common = { workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN, ...pins };
  const payload = { schemaVersion: 1, ...pins, workspaceId: WORKSPACE, planSlug: PLAN,
    readinessSha256: sha(canonicalJson(readiness)), ledgerSha256: sha(canonicalJson(ledgerFlips)),
    approvalAuditSeq: audit.auditSeq, auditorId: AUDITOR, approvedAt: GO_AT };
  const signedGo = { harnessSlug: HARNESS, kind: 'p2p-endgame-go/v1', payload,
    auth: await signAuthorityRpc({ harnessSlug: HARNESS, kind: 'p2p-endgame-go/v1', payload, device_pubkey: signerIdentity.deviceKey },
      async bytes => signWithPrivateKeyDer(witness.signingDevices[0]!.privateKeyDer, bytes),
      { nowMs: Date.parse(GO_AT), nonce: `${witness.evidence.runId}:independent-go` }) };
  const go: Data = { ...common, outcome: 'P-401', readiness, journeyEvidence, ledgerFlips,
    approval: { audit, planRevision: { current, snapshot }, rubric, rubricSnapshot,
      eligibility: { auditorId: AUDITOR, at: audit.createdAt, result: eligibility }, candidateBindings },
    signedGo, signerIdentity, signerTrust: { evidence: witness.evidence, trust: witness.trust, receipts: witness.trust.receipts } };
  const physical = { evidence: drill.evidence, trust: drill.trust, receipts: drill.trust.receipts,
    original: blob('fixture:post-go-drill-original', drill.evidence) };
  const ownerDrill: Data = { ...common, outcome: 'P-502', independentGo: go, physical,
    phaseG: drill.evidence.legG, phaseI: drill.evidence.legI };
  const witnessBlob = blob('fixture:witness-original', witness.evidence);
  const goBlob = blob('fixture:independent-go-original', signedGo);
  const record = { ...pins, decisionRef: `${PLAN}#D-777`, choice: 'bridged', rationale: 'Private explicit default after the same-candidate witness, independent GO and owner recovery.',
    recordedAt: '2026-08-13T13:31:00Z', evidence: [
      { kind: 'witness', ref: witnessBlob.ref, sha256: witnessBlob.sha256, ...pins, status: 'passed', finishedAt: witness.evidence.window.finishedAt },
      { kind: 'independent-go', ref: goBlob.ref, sha256: goBlob.sha256, ...pins, status: 'passed', finishedAt: GO_AT },
      { kind: 'owner-freeze-recovery-drill', ref: physical.original.ref, sha256: physical.original.sha256, ...pins, status: 'passed', finishedAt: drill.evidence.window.finishedAt },
    ] };
  const entry = { id: 'D-777', title: 'Private explicit bridged default', date: '2026-08-13',
    body: canonicalJson(record), itemRefs: ['P-503'], affects: [], lineNumber: 24, promotedFrom: [] };
  const decisionPlan = planRow(items, entry);
  const choice: Data = { ...common, outcome: 'P-503', decision: { current: decisionPlan, snapshot: revision(decisionPlan, 8101), entry, record },
    policy: { newHiveGitMode: 'bridged' }, witness: { evidence: witness.evidence, trust: witness.trust, receipts: witness.trust.receipts, original: witnessBlob },
    independentGo: go, ownerDrill, citationBlobs: [
      { kind: 'witness', original: witnessBlob }, { kind: 'independent-go', original: goBlob },
      { kind: 'owner-freeze-recovery-drill', original: physical.original },
    ] };
  return { go, ownerDrill, choice, witness, drill, candidate, eligibility, pins };
}

async function resultFor(packet: Awaited<ReturnType<typeof signedPacket>>) {
  return compute(async request => ({ 'P-401': packet.go, 'P-502': packet.ownerDrill, 'P-503': packet.choice }[request.outcome as 'P-401'] ?? null));
}
function outcome(result: Awaited<ReturnType<typeof compute>>, id: string, pass: boolean) {
  const report: Data | undefined = Reflect.get(result, 'outcomes');
  expect(report, 'computed consumer must expose signed original outcomes').toEqual(expect.objectContaining({ checks: expect.any(Array) }));
  const checks = report!.checks.filter((check: Data) => check.id === id);
  expect(checks).toHaveLength(1);
  if (pass) expect(checks[0].status).toBe('pass');
  else { expect(checks[0].status).not.toBe('pass'); expect(checks[0].detail.trim()).not.toBe(''); }
}

describe('D294-D296 full signed positive GO, owner recovery and default originals', () => {
  it('validates original physical packets, canonical readiness, eligibility and archived signature (fixture control)', async () => {
    // The runnable frozen file pins its private fixture helper too: modifying
    // imported fixture data must fail the unchanged oracle at closure.
    expect(sha(readFileSync(join(root, 'apps/operator/lib/release/p2p-signed-physical.fixture.ts'))))
      .toBe('9c730b7ae7987932078a7bf62f6ac9a789fcc933a70d5eee0fa2745519f690e0');
    const p = await signedPacket();
    expect(validatePhysicalDrillEvidence(p.witness.evidence, p.witness.trust)).toMatchObject({ ok: true });
    expect(validatePhysicalDrillEvidence(p.drill.evidence, p.drill.trust)).toMatchObject({ ok: true });
    expect(validatePhysicalPhaseG(p.ownerDrill.phaseG)).toMatchObject({ ok: true });
    expect(validatePhysicalPhaseI(p.ownerDrill.phaseI)).toMatchObject({ ok: true });
    expect(phaseITargetOf(p.ownerDrill.phaseI).kind).toBe('canary-owner');
    expect(p.go.readiness.current.go).toBe(true);
    expect(p.go.readiness.current.rows.map((row: Data) => row.capability)).toEqual(JOURNEYS);
    expect(p.eligibility.refusal).toBeNull();
    expect(verifyAuthorityRpc(p.go.signedGo, p.go.signedGo.auth, { nowMs: Date.parse(GO_AT) })).toBe(true);
    expect(validateEndgameDefaultChoice(p.choice.decision.record, p.pins)).toEqual([]);
    expect(p.go.approval.planRevision.current.items.filter((item: Data) => ['P-502', 'P-503', 'P-403', 'P-404'].includes(item.id))
      .every((item: Data) => item.status === 'open')).toBe(true);
  }, 120_000);

  it('derives all three passing signed outcomes while future P521 qualification remains separate', async () => {
    const result = await resultFor(await signedPacket());
    for (const id of ['P-401', 'P-502', 'P-503']) outcome(result, id, true);
    outcome(result, 'P-521', false);
  }, 120_000);
  it.each(['signature', 'signer-custody', 'readiness-hash', 'ledger-hash', 'missing-ledger', 'no-go-row',
    'self-auditor', 'stale-item-text', 'foreign-candidate', 'approval-original'])(
    'refuses P401 %s after a satisfiable signed original packet', async defect => {
      const p = await signedPacket();
      if (defect === 'signature') p.go.signedGo.auth.sig = Buffer.alloc(64).toString('base64');
      if (defect === 'signer-custody') p.go.signerIdentity.deviceKey = p.drill.signingDevices[0]!.pubkeyBase64;
      if (defect === 'readiness-hash') p.go.signedGo.payload.readinessSha256 = sha('foreign-readiness');
      if (defect === 'ledger-hash') p.go.signedGo.payload.ledgerSha256 = sha('foreign-ledger');
      if (defect === 'missing-ledger') p.go.ledgerFlips = [];
      if (defect === 'no-go-row') p.go.readiness.current.rows[0].state = 'unmeasured';
      if (defect === 'self-auditor') p.go.approval.audit.createdBy = AUTHOR;
      if (defect === 'stale-item-text') p.go.approval.planRevision.current.items.find((item: Data) => item.id === 'P-401').text += 'changed';
      if (defect === 'foreign-candidate') p.go.sourceSha = 'f'.repeat(40);
      if (defect === 'approval-original') p.go.approval.audit = null;
      if (['missing-ledger', 'no-go-row', 'self-auditor', 'stale-item-text'].includes(defect)) {
        // Keep cryptographic integrity intact: the consumer must inspect the
        // original readiness, population and independence rather than hashes alone.
        p.go.signedGo.payload.readinessSha256 = sha(canonicalJson(p.go.readiness));
        p.go.signedGo.payload.ledgerSha256 = sha(canonicalJson(p.go.ledgerFlips));
        p.go.signedGo.auth = await signAuthorityRpc({ ...p.go.signedGo,
          device_pubkey: p.go.signerIdentity.deviceKey },
        async bytes => signWithPrivateKeyDer(p.witness.signingDevices[0]!.privateKeyDer, bytes),
        { nowMs: Date.parse(GO_AT), nonce: `private-corrupt-${defect}` });
        expect(verifyAuthorityRpc(p.go.signedGo, p.go.signedGo.auth, { nowMs: Date.parse(GO_AT) })).toBe(true);
      }
      outcome(await resultFor(p), 'P-401', false);
    }, 120_000);
  it.each(['ephemeral-target', 'pre-go-drill', 'raw-byte-hash', 'foreign-machine', 'denied-side-effect', 'missing-fresh-recovery'])(
    'refuses P502 %s despite the authentic GO', async defect => {
      const p = await signedPacket();
      if (defect === 'ephemeral-target') delete p.ownerDrill.phaseI.target;
      if (defect === 'pre-go-drill') p.ownerDrill.physical.evidence.window.startedAt = '2026-08-13T12:00:00Z';
      if (defect === 'raw-byte-hash') p.ownerDrill.physical.original.sha256 = sha('foreign-raw');
      if (defect === 'foreign-machine') p.ownerDrill.physical.trust.hosts[1].machineFingerprint = p.ownerDrill.physical.trust.hosts[0].machineFingerprint;
      if (defect === 'denied-side-effect') p.ownerDrill.phaseI.steps.outage.vm.attempts[0].after.protected.stagingRef = 'f'.repeat(40);
      if (defect === 'missing-fresh-recovery') p.ownerDrill.phaseI.steps.restored = p.ownerDrill.phaseI.steps.outage;
      if (!['raw-byte-hash', 'foreign-machine'].includes(defect)) {
        resignPhysical(p.drill);
        p.ownerDrill.physical.original = blob('fixture:post-go-drill-original', p.drill.evidence);
      }
      outcome(await resultFor(p), 'P-502', false);
    }, 120_000);
  it.each(['missing-citation', 'unresolved-original', 'wrong-citation-bytes', 'changed-decision-revision', 'implicit-policy', 'wrong-default', 'choice-before-drill'])(
    'refuses P503 %s while retaining the signed GO/drill originals', async defect => {
      const p = await signedPacket();
      if (defect === 'missing-citation') p.choice.decision.record.evidence.pop();
      if (defect === 'unresolved-original') p.choice.citationBlobs.pop();
      if (defect === 'wrong-citation-bytes') p.choice.citationBlobs[0].original.bytesBase64 = Buffer.from('{}').toString('base64');
      if (defect === 'changed-decision-revision') p.choice.decision.snapshot.contentSnapshot += 'changed';
      if (defect === 'implicit-policy') p.choice.policy = {};
      if (defect === 'wrong-default') p.choice.policy.newHiveGitMode = 'legacy';
      if (defect === 'choice-before-drill') p.choice.decision.record.recordedAt = GO_AT;
      if (['missing-citation', 'choice-before-drill'].includes(defect)) {
        p.choice.decision.entry.body = canonicalJson(p.choice.decision.record);
        p.choice.decision.current = planRow(p.choice.decision.current.items, p.choice.decision.entry);
        p.choice.decision.snapshot = revision(p.choice.decision.current, 8102);
      }
      outcome(await resultFor(p), 'P-503', false);
    }, 120_000);
});
