/**
 * Independent D292 consumer contract, WI-6554700010020476.
 * This refusal/dispatch slice is preparation, not six-outcome readiness.
 * Authentic original-record positive controls and physical outcomes remain owed.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '../../../../packages/operator-core/lib/agent-tools/plans/source';
import type { PlanRevisionSnapshot } from '../../../../packages/operator-core/lib/agent-tools/plans/revisions';
import { hashPlanContent } from '../../../../packages/operator-core/lib/agent-tools/plans/content-hash';
import {
  citationBlobShaAt, repoCitationDeps, type AuditCitation, type PlanAudit,
} from '../../../../packages/operator-core/lib/plan-audits';
import * as rubricRecords from '../../../../packages/operator-core/lib/rubrics';
import * as scorecardRecords from '../../../../packages/operator-core/lib/scorecards';
import {
  resolveAcceptanceGraderEligibility, type GraderEligibility,
} from '../../../../packages/operator-core/lib/agent-tools/scorecards/grader-eligibility';
import type { HistoricalShipmentWitness } from '../../../../packages/operator-core/lib/agent-tools/plans/restore-historical-shipment';
import type { DerivedCandidateProvenance } from './p2p-candidate-evidence';
import {
  computeCandidateManifestFromRecords,
  type ComputeDeps,
  type ComputeOptions,
} from './run-p2p-candidate-manifest';

// Independent population: a production deletion must not shrink the oracle.
const SHIPPED_PLANS = [
  'p2p-coordination-public-release-2026-08-26',
  'p2p-public-release-remaining-lanes-2026-07-16',
  'p2p-git-live-activation-2026-07-09',
  'p2p-work-distribution-2026-07-02',
  'github-bridge-hive-egress-2026-07-02',
  'fleet-reliability-verification-2026-07-10',
] as const;
const ENDGAME_PLAN = 'p2p-public-release-endgame-2026-09-01';
// Fixed committed source, also used by the canonical Git citation reader below.
const SOURCE_SHA = 'cbd21646b5c73bd23cad5608f9526cf9bd0048ce';
const DESKTOP_SHA = 'b'.repeat(40);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const ARTIFACT_SHA = sha256('private D292 artifact bytes');
// The artifact digest specification hashes sorted "<sha>  <basename>\n" lines.
const ARTIFACT_DIGEST = sha256(`${ARTIFACT_SHA}  Fixture.deb\n`);

interface ReadRequest {
  planSlug: string;
  phase: 'shipped' | 'pre-ship';
  sourceSha: string;
  artifactDigest: string;
}
type Card = scorecardRecords.ScorecardRow;
type Rubric = rubricRecords.Rubric;
// D293's prospective contract stays local until independently frozen.
interface EndgameOriginalRecords {
  planRevision: { current: PlanRow; snapshot: PlanRevisionSnapshot; shipmentWitness: HistoricalShipmentWitness | null } | null;
  codeTruthAudits: readonly PlanAudit[];
  acceptanceRubric: { current: Rubric | null; atGrading: Rubric | null; snapshot: PlanRevisionSnapshot | null;
    inspection: rubricRecords.RubricRevisionSnapshotInspection | null } | null;
  rubricVetting: readonly Card[];
  countedScorecards: readonly Card[];
  gradingAudits: readonly { scorecardId: string; stamp: NonNullable<Card['gradingAudit']>; auditCard: Card | null;
    currentness: NonNullable<Card['gradingAuditCurrentness']> | null }[];
  graderEligibility: readonly { scorecardId: string; graderId: string; gradedAt: string;
    rubricSnapshotId: number; result: GraderEligibility }[];
  authorVerdicts: readonly Card[];
  candidateBindings: readonly { planSlug: string; auditSeq: number; candidate: DerivedCandidateProvenance;
    citations: readonly { citation: AuditCitation; auditedBlob: string | null; candidateBlob: string | null }[] }[];
  portfolioCensus: { workspaceId: string; harnessSlug: string; plans: readonly PlanRow[] } | null;
}
type OriginalReader = (request: ReadRequest) => Promise<EndgameOriginalRecords | null>;
interface EndgameResult {
  shipmentLedger: readonly unknown[];
  preShip: unknown | null;
  checks: readonly { id: string; status: string; detail: string }[];
  ok: boolean;
}

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(reader?: OriginalReader): { options: ComputeOptions; deps: ComputeDeps } {
  const root = mkdtempSync(join(tmpdir(), 'p403-p404-originals-'));
  roots.push(root);
  const provenancePath = join(root, 'build-provenance.json');
  writeFileSync(provenancePath, JSON.stringify({
    version: '0.0.25', buildSha: DESKTOP_SHA.slice(0, 12), gitHead: DESKTOP_SHA,
    gitDirty: false, gitDirtyAtEmit: false, reused: false,
    dirtySource: { status: 'captured', repositories: [
      { label: 'workspace', gitHead: SOURCE_SHA, files: [] },
      { label: 'desktop', gitHead: DESKTOP_SHA, files: [] },
    ] },
    builtAtUtc: '2026-10-22T10:00:00Z',
    artifacts: [{ name: 'Fixture.deb', sha256: ARTIFACT_SHA, bytes: 26, sig: true }],
  }));
  const deps: ComputeDeps = {
    readLedger: async () => ({
      version: '0.0.25', channel: 'alpha', gitSha: SOURCE_SHA,
      artifacts: [{ name: 'Fixture.deb', sha256: ARTIFACT_SHA }],
    }),
    readBuildCommand: async () => ({
      tool: 'release:cut', invocationId: 'private-D292-build',
      invokedAt: '2026-10-22T09:59:00Z', servingBuildSha: SOURCE_SHA,
      args: { op: 'run', version: '0.0.25', channel: 'alpha', confirm: true, sourceSha: SOURCE_SHA },
    }),
    hashFile: async () => ARTIFACT_SHA,
  };
  // Prospective optional member is deliberately installed at the maintained seam.
  // No absent production export is imported, so baseline red is an assertion.
  if (reader) Object.assign(deps, { readEndgameOriginals: reader });
  return {
    options: {
      version: '0.0.25', channel: 'alpha', legs: [{ leg: 'linux', path: provenancePath }],
      repoRoot: root, now: Date.parse('2026-10-22T10:01:00Z'),
    },
    deps,
  };
}

async function compute(reader?: OriginalReader) {
  const { options, deps } = fixture(reader);
  return computeCandidateManifestFromRecords(options, deps);
}

function refused(result: Awaited<ReturnType<typeof compute>>): EndgameResult {
  const endgame = Reflect.get(result, 'endgame') as EndgameResult | undefined;
  expect(endgame, 'computed consumer must expose missing original evidence').toEqual(expect.objectContaining({
    ok: false, shipmentLedger: expect.any(Array), checks: expect.any(Array),
  }));
  // The assertion above terminates a missing-result baseline before dereferencing.
  // D292 permits retained diagnostics; it does not prescribe empty output shapes.
  const evidence = endgame as EndgameResult;
  expect(Reflect.has(evidence, 'preShip')).toBe(true);
  for (const id of ['P-403', 'P-404']) {
    const aggregate = evidence.checks.filter(check => check.id === id);
    expect(aggregate, `${id} needs one retained aggregate diagnostic`).toHaveLength(1);
    expect(aggregate[0]!.status).not.toBe('pass');
  }
  return evidence;
}

const WORKSPACE = 'private-d293-workspace';
const AUTHOR = 'fixture-author';
const GRADER = 'fixture-grader';
const CRITIC = 'fixture-critic';
const AUDITOR = 'fixture-auditor';
const at = (minute: number) => `2026-10-22T09:${String(minute).padStart(2, '0')}:00Z`;

function planRow(planSlug: string, shipped: boolean): PlanRow {
  const content = `---\ntitle: ${planSlug}\nstatus: ${shipped ? 'shipped' : 'awaiting-acceptance'}\n---\n\n## Work\n- [done] P-001 Deliver the audited candidate.\n`;
  return {
    workspaceId: WORKSPACE, harnessSlug: 'papercusp', planSlug, content,
    contentHash: hashPlanContent(content), version: 11, title: planSlug,
    status: shipped ? 'shipped' : 'awaiting-acceptance', created: at(0), updated: at(4), owner: AUTHOR,
    initiative: null, template: null, templateData: null, inputSchema: null, outputSchema: null,
    supersedes: [], supersededBy: null, opStatus: null, opStartedAt: null, opUpdatedAt: null,
    currentWave: null, opPriority: null, archived: false, isLegacy: false, updatedAt: at(4),
    items: [{ id: 'P-001', status: 'done', text: 'Deliver the audited candidate.', importance: 'normal',
      blockedBy: [], decisionRefs: [], phase: null }], decisions: [], nowState: null, nowNext: null,
    nowNote: null, promotePolicy: null, forcedPast: null, schedule: null, scheduleActive: false,
    scheduledAt: null, expiresAt: null, tzid: null, templateSlug: null, runSeq: null,
  };
}

function snapshot(row: PlanRow, id: number, seq: number, contentSnapshot = row.content): PlanRevisionSnapshot {
  return { id, planSlug: row.planSlug, seq, contentHash: row.contentHash,
    contentSnapshot, contentSnapshotHash: sha256(contentSnapshot) };
}

function card(issueId: string, rubric: Rubric, createdBy: string, createdAt: string): Card {
  const ratings = Object.fromEntries(rubric.criteria.map(criterion => [criterion.key, {
    rating: 'healthy', evidence: 'Private fixture: inspect the linked original audit and committed blobs.',
  }]));
  return {
    issueId, createdAt, createdBy, rubricRef: rubric.rubricId, rubricRevision: rubric.revision,
    criteriaHash: rubric.criteriaHash, ratings, nKeys: rubric.criteria.length,
    missingKeys: [], extraKeys: [], rubricResolved: true, synthesized: false, score10: 10, linkedItems: [],
  };
}

/** Private original records; hashes/projections/identity verdicts use real canonical helpers. */
async function originalPackets(candidate: DerivedCandidateProvenance) {
  const population = [...SHIPPED_PLANS.map(slug => planRow(slug, true)), planRow(ENDGAME_PLAN, false)];
  const packets = new Map<string, EndgameOriginalRecords>();
  const allVetting: Card[] = [];
  // Replace storage reads only. The actual eligibility/critic/lineage algorithm runs below.
  vi.spyOn(rubricRecords, 'readRubricPlanRevision').mockResolvedValue({ ok: true, revision: 2 });
  vi.spyOn(scorecardRecords, 'listScorecards').mockImplementation(async options =>
    allVetting.filter(row => row.rubricRef === options?.rubricRef && row.subject?.ref === options?.subjectRef));
  const citation: AuditCitation = { kind: 'code', path: 'apps/operator/lib/release/run-p2p-candidate-manifest.ts' };
  const citationDeps = repoCitationDeps(fileURLToPath(new URL('../../../../', import.meta.url)));
  const auditedBlob = await citationBlobShaAt(citation, SOURCE_SHA, citationDeps);
  const candidateBlob = await citationBlobShaAt(citation, candidate.sourceSha, citationDeps);
  expect(auditedBlob, 'positive fixture requires a real committed citation').toMatch(/^[a-f0-9]{40}$/);
  expect(candidateBlob).toBe(auditedBlob);
  citation.blobSha = auditedBlob!;
  for (const [index, current] of population.entries()) {
    const rubricSlug = `acceptance-${current.planSlug}`;
    const data = {
      kind: 'acceptance', subjectPlan: current.planSlug, characteristic: 'p2p-release-fixture',
      criteria: [{ key: 'delivered', title: 'Delivered candidate', model: 'The candidate implements the audited work.',
        driftMarkers: 'A missing or different committed blob falsifies delivery.' }],
      ratingScale: ['healthy', 'broken', 'unknown'], gradingAuthority: 'independent',
    };
    const rubricBody = `---\ntitle: Acceptance\nstatus: active\n---\n\nPrivate fixture.\n`;
    const storedRubric = { plan_slug: rubricSlug, workspace_id: WORKSPACE, harness_slug: 'papercusp',
      title: 'Acceptance', status: 'active', created: at(0), updated: at(0), updated_at: at(0),
      owner: AUTHOR, archived: false, version: 2, template_data: data };
    const active = rubricRecords.planRowToRubric(storedRubric);
    expect(active, 'private template must project through the canonical schema').not.toBeNull();
    const encoded = rubricRecords.formatRubricRevisionSnapshot(rubricBody, data, active!.criteriaHash!, 2);
    const inspection = rubricRecords.inspectRubricRevisionSnapshot(encoded);
    const atGrading = rubricRecords.planRowToRubric({ ...storedRubric, template_data: inspection.templateData,
      version: inspection.rubricRevision });
    expect(inspection.kind).toBe('enriched');
    expect(atGrading?.criteriaHash).toBe(active!.criteriaHash);
    const rubricSnapshot = snapshot({ ...current, planSlug: rubricSlug, content: rubricBody,
      contentHash: hashPlanContent(rubricBody) }, 2000 + index, 7, encoded);
    const currentRubric = current.planSlug === ENDGAME_PLAN ? active
      : rubricRecords.planRowToRubric({ ...storedRubric, version: 3, status: 'shipped' });
    const grade = card(`EI-${900000 + index * 10}`, atGrading!, GRADER, at(1));
    grade.subject = { kind: 'plan', ref: current.planSlug };
    const vetting = { ...card(`EI-${900001 + index * 10}`, atGrading!, CRITIC, at(0)),
      rubricRef: 'meta-acceptance-rubric', subject: { kind: 'rubric' as const, ref: rubricSlug },
      vetting: { workItemId: `WI-${900000 + index}`, rubricRevision: 2,
        criteriaHash: atGrading!.criteriaHash, critiquePosts: 1, critics: [CRITIC] } };
    allVetting.push(vetting);
    const auditCard = { ...card(`EI-${900002 + index * 10}`, atGrading!, AUDITOR, at(2)),
      rubricRef: 'grading-integrity', subject: { kind: 'scorecard' as const, ref: grade.issueId } };
    const metaIdentity = { rubricId: 'grading-integrity', revision: 4, criteriaHash: sha256('private meta rubric') };
    const stamp: NonNullable<Card['gradingAudit']> = { state: 'passed', metaRubricRef: metaIdentity.rubricId,
      stampedAt: at(1), rubricRevision: metaIdentity.revision, criteriaHash: metaIdentity.criteriaHash,
      auditIssueId: auditCard.issueId, auditor: AUDITOR, auditedAt: at(2) };
    const currentness = scorecardRecords.classifyGradingAuditCurrentness(stamp, metaIdentity);
    grade.gradingAudit = stamp;
    grade.gradingAuditCurrentness = currentness;
    grade.rubricCurrentness = {
      ...rubricRecords.classifyRubricEvidenceCurrentness(
        { revision: grade.rubricRevision, criteriaHash: grade.criteriaHash },
        { revision: atGrading!.revision, criteriaHash: atGrading!.criteriaHash }),
      recordedRevision: grade.rubricRevision ?? null, currentRevision: atGrading!.revision ?? null,
      recordedCriteriaHash: grade.criteriaHash ?? null, currentCriteriaHash: atGrading!.criteriaHash ?? null,
    };
    const eligibility = await resolveAcceptanceGraderEligibility({ rubric: atGrading!, callerId: GRADER,
      workspaceId: WORKSPACE, deps: {
        sameAcceptanceAuthor: async (a, b) => a === b,
        lineageRelated: async (a, b) => a === b,
        resolvePlanImplementerIdentities: async () => [AUTHOR],
      } });
    expect(eligibility.refusal).toBeNull();
    expect(eligibility.callerIsImplementer).toBe(false);
    expect(scorecardRecords.scorecardAdmissionExclusion(grade)).toBeNull();
    const verdict = card(`EI-${900003 + index * 10}`, atGrading!, AUTHOR, at(3));
    verdict.acceptance = { verdict: 'accept', reasoning: 'The counted independent grade covers this candidate.',
      independentGrading: { scorecardId: grade.issueId, gradedBy: GRADER, rubricRevision: 2, selectedBy: 'acceptanceOf' } };
    const planSnapshot = snapshot(current, 1000 + index, 9);
    const audit: PlanAudit = { planSlug: current.planSlug, harnessSlug: 'papercusp', auditSeq: 5,
      createdBy: AUDITOR, createdAt: at(0), auditKind: 'completion', auditedSha: SOURCE_SHA, activation: null,
      auditedPlanRevision: { id: planSnapshot.id, seq: planSnapshot.seq, contentHash: planSnapshot.contentHash },
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [citation], auditedSha: SOURCE_SHA }],
      findings: [], summary: 'Private committed-source fixture, not production shipment evidence.' };
    packets.set(current.planSlug, {
      planRevision: { current, snapshot: planSnapshot, shipmentWitness: null }, codeTruthAudits: [audit],
      acceptanceRubric: { current: currentRubric, atGrading, snapshot: rubricSnapshot, inspection },
      rubricVetting: [vetting], countedScorecards: [grade],
      gradingAudits: [{ scorecardId: grade.issueId, stamp, auditCard, currentness }],
      graderEligibility: [{ scorecardId: grade.issueId, graderId: GRADER, gradedAt: grade.createdAt,
        rubricSnapshotId: rubricSnapshot.id, result: eligibility }], authorVerdicts: [verdict],
      candidateBindings: [{ planSlug: current.planSlug, auditSeq: audit.auditSeq, candidate,
        citations: [{ citation, auditedBlob, candidateBlob }] }],
      portfolioCensus: { workspaceId: WORKSPACE, harnessSlug: 'papercusp', plans: population },
    });
  }
  return packets;
}

describe('D293 canonical original-record positive fixtures', () => {
  it('has satisfiable historical-rubric, eligibility, candidate and self-census controls', async () => {
    const packets = await originalPackets((await compute()).provenance);
    expect(packets.size).toBe(7);
    for (const slug of SHIPPED_PLANS) {
      const packet = packets.get(slug)!;
      expect(packet.acceptanceRubric?.current?.status).toBe('retired');
      expect(packet.acceptanceRubric?.atGrading?.status).toBe('active');
      expect(packet.acceptanceRubric?.snapshot?.seq).not.toBe(packet.acceptanceRubric?.atGrading?.revision);
      expect(packet.gradingAudits[0]!.currentness?.state).toBe('current');
      expect(packet.graderEligibility[0]!.result.refusal).toBeNull();
    }
    const self = packets.get(ENDGAME_PLAN)!;
    expect(self.planRevision?.current.status).toBe('awaiting-acceptance');
    expect(self.portfolioCensus?.plans.map(row => row.planSlug)).toContain(ENDGAME_PLAN);
  });

  it('derives six shipped rows and current self pre-ship readiness from the original records', async () => {
    const packets = await originalPackets((await compute()).provenance);
    const result = await compute(async request => packets.get(request.planSlug) ?? null);
    const endgame = Reflect.get(result, 'endgame') as EndgameResult | undefined;
    expect(endgame).toEqual(expect.objectContaining({ ok: true,
      shipmentLedger: expect.any(Array), preShip: expect.any(Object) }));
    expect(endgame!.shipmentLedger).toHaveLength(6);
    expect(endgame!.checks.filter(check => ['P-403', 'P-404'].includes(check.id))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'P-403', status: 'pass' }),
      expect.objectContaining({ id: 'P-404', status: 'pass' }),
    ]));
  });

  it.each(['snapshot-bytes', 'grade-rubric-hash', 'audit-original', 'eligibility', 'author-link',
    'candidate-blob', 'census-missing-self', 'census-live-residue'] as const)(
    'refuses %s after a satisfiable original-record packet is corrupted', async defect => {
      const packets = await originalPackets((await compute()).provenance);
      const slug = defect.startsWith('census') ? ENDGAME_PLAN : SHIPPED_PLANS[0];
      const packet = structuredClone(packets.get(slug)!);
      if (defect === 'snapshot-bytes') packet.planRevision!.snapshot.contentSnapshot += 'changed';
      if (defect === 'grade-rubric-hash') packet.countedScorecards[0]!.criteriaHash = 'f'.repeat(64);
      if (defect === 'audit-original') packet.gradingAudits = [{ ...packet.gradingAudits[0]!, auditCard: null }];
      if (defect === 'eligibility') packet.graderEligibility = [];
      if (defect === 'author-link') packet.authorVerdicts[0]!.acceptance!.independentGrading!.scorecardId = 'EI-1';
      if (defect === 'candidate-blob') packet.candidateBindings = [{ ...packet.candidateBindings[0]!,
        citations: [{ ...packet.candidateBindings[0]!.citations[0]!, candidateBlob: 'f'.repeat(40) }] }];
      if (defect === 'census-missing-self') packet.portfolioCensus!.plans = packet.portfolioCensus!.plans
        .filter(row => row.planSlug !== ENDGAME_PLAN);
      if (defect === 'census-live-residue') packet.portfolioCensus!.plans = [
        ...packet.portfolioCensus!.plans, planRow('p2p-private-residual-plan', false) ];
      packets.set(slug, packet);
      const result = await compute(async request => packets.get(request.planSlug) ?? null);
      const endgame = Reflect.get(result, 'endgame') as EndgameResult | undefined;
      expect(endgame).toEqual(expect.objectContaining({ ok: false, checks: expect.any(Array) }));
      const id = defect.startsWith('census') ? 'P-404' : 'P-403';
      const aggregate = endgame!.checks.filter(check => check.id === id);
      expect(aggregate).toHaveLength(1);
      expect(aggregate[0]!.status).not.toBe('pass');
    },
  );
});

describe('D292 prospective computed P403/P404 original-evidence consumer', () => {
  it('derives the exact source and artifact pins without an endgame reader (fixture control)', async () => {
    const result = await compute();
    expect(result.provenance.sourceSha).toBe(SOURCE_SHA);
    expect(result.provenance.provenance.candidateDigest).toBe(ARTIFACT_DIGEST);
    expect(result.manifest.artifact.sha256).toBe(ARTIFACT_DIGEST);
  });

  it('retains P403/P404 non-pass diagnostics when the original reader is absent', async () => {
    refused(await compute());
  });

  it('missing original packets never become a shipment or pre-ship proof', async () => {
    refused(await compute(async () => null));
  });

  it('requests exactly the six shipped originals on pins derived from the artifact bytes', async () => {
    const requests: ReadRequest[] = [];
    await compute(async request => { requests.push({ ...request }); return null; });
    expect(requests.filter(request => request.phase === 'shipped')).toHaveLength(SHIPPED_PLANS.length);
    expect(requests.filter(request => request.phase === 'shipped')).toEqual(expect.arrayContaining(
      SHIPPED_PLANS.map(planSlug => ({
        planSlug, phase: 'shipped', sourceSha: SOURCE_SHA, artifactDigest: ARTIFACT_DIGEST,
      })),
    ));
  });

  it('requests the endgame pre-ship package without requiring this plan already shipped', async () => {
    const requests: ReadRequest[] = [];
    await compute(async request => { requests.push({ ...request }); return null; });
    expect(requests.filter(request => request.planSlug === ENDGAME_PLAN)).toEqual([{
      planSlug: ENDGAME_PLAN, phase: 'pre-ship', sourceSha: SOURCE_SHA, artifactDigest: ARTIFACT_DIGEST,
    }]);
    expect(requests).toHaveLength(SHIPPED_PLANS.length + 1);
  });

  it('reader errors remain inspectable non-pass results rather than provenance-only success', async () => {
    refused(await compute(async () => { throw new Error('private original record lookup unavailable'); }));
  });

  it.each(['status-only', 'local-witness-only', 'shortcut-flags', 'reference-only', 'empty-originals'])(
    'rejects %s even when it repeats the exact requested candidate pins', async variant => {
      const reader: OriginalReader = async request => {
        const pins = { sourceSha: request.sourceSha, artifactDigest: request.artifactDigest };
        const packet = variant === 'status-only'
          ? { ...pins, planSlug: request.planSlug, status: 'shipped', skipped: 'already-shipped' }
          : variant === 'local-witness-only'
            ? { ...pins, localShipmentCaptured: true, rubricRetiredWithShipment: true }
            : variant === 'shortcut-flags'
              ? { ...pins, authenticated: true, eligible: true, passed: true }
              : variant === 'reference-only'
                ? { ...pins, planRevision: 'plan-revision:1', codeTruthAudits: ['plan-audit:1'],
                  acceptanceRubric: 'acceptance-fixture', rubricVetting: 'consult:1', countedScorecards: ['EI-1'],
                  gradingAudits: ['EI-2'], graderEligibility: 'lineage:1', authorVerdicts: ['EI-3'],
                  candidateBindings: ['candidate:1'], portfolioCensus: 'census:1' }
                : { planRevision: null, codeTruthAudits: [], acceptanceRubric: null, rubricVetting: null,
                  countedScorecards: [], gradingAudits: [], graderEligibility: [], authorVerdicts: [],
                  candidateBindings: [], portfolioCensus: null };
        // Adversarial inputs intentionally violate the prospective packet types.
        return packet as never;
      };
      refused(await compute(reader));
    },
  );
});
