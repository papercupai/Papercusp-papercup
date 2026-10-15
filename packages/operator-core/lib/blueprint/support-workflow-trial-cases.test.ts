import { describe, expect, it } from 'vitest';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { assertSupportCaseInput, parseSupportToEngineeringResult } from './support-workflow-contract';
import { supportToEngineeringOperation, supportWorkflowFromOperation } from './support-workflow-operation';
import { supportWorkflowTrialCases, supportWorkflowTrialEvidenceFixture } from './fixtures/support-workflow-trial-cases';
import { inspectSupportTrialEvidence, SUPPORT_TRIAL_METRICS } from './support-workflow-trial';

const revision = 'a'.repeat(64);
const operation = supportToEngineeringOperation({
  id: 'synthetic-support-trial', version: '1', role: 'worker',
  identity: { kind: 'identity', ref: 'trial-worker', revision: '1', contentHash: 'b'.repeat(64) },
  accountableOwner: 'trial-admin', reviewerPrincipals: ['trial-reviewer'],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
});

function detectorFixture() {
  const fixture = supportWorkflowTrialEvidenceFixture();
  for (const receiptId of [1, 2]) fixture.observe({ receiptId, workspaceId: fixture.authority.workspace,
    harnessSlug: fixture.authority.harness, operationId: fixture.registration.operationId,
    specificationRevision: fixture.authority.workflowRevision, target: { kind: 'work-item', id: `fixture-${receiptId}` } }, 'c'.repeat(64));
  return fixture;
}
type Fixture = ReturnType<typeof detectorFixture>;
const inspect = (f: Fixture) => inspectSupportTrialEvidence(f.input, f.authority);
const sealRegistration = (f: Fixture) => { f.input.registration = f.put('fixture:registration', f.registration, true); };
describe('R11 immutable trial evidence controls (fabricated artifacts, no operational acceptance)', () => {
  it('accepts complete labelled preregistration and comparable observations at the artifact layer only', async () => {
    const result = await inspect(detectorFixture());
    expect(result.findings).toEqual([]);
    expect(result.observations).toHaveLength(2);
    expect(result).not.toHaveProperty('status'); // Only the PG reader may qualify actual receipts.
  });
  it.each(['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9', 'A-10', 'P-002', 'P-003', 'R-8'])('keeps missing %s prerequisite unknown', async id => {
    const f = detectorFixture(); f.input.prerequisites = f.input.prerequisites.filter(p => p.id !== id);
    expect((await inspect(f)).findings).toContainEqual({ kind: 'unknown', code: 'prerequisite-population', subject: id });
  });
  it.each([
    ['empty cohort', (f: Fixture) => { f.registration.cohort = []; }],
    ['duplicate cohort', (f: Fixture) => { f.registration.cohort.push(f.registration.cohort[0]!); }],
    ['implementer reviewer', (f: Fixture) => { f.registration.implementers.push(f.registration.reviewer); }],
    ['employee reviewer', (f: Fixture) => { f.registration.reviewer = f.registration.cohort[0]!.submitter; }],
    ['foreign candidate', (f: Fixture) => { f.registration.candidateSha256 = 'd'.repeat(64); }],
    ['stale plan', (f: Fixture) => { f.registration.planRevision = 'old'; }],
    ['foreign workflow', (f: Fixture) => { f.registration.workflowRevision = 'd'.repeat(64); }],
    ['post trial threshold', (f: Fixture) => { f.registration.startsAt = '2026-10-15T11:57:00Z'; }],
    ['customer relabelling', (f: Fixture) => { Object.assign(f.registration, { resultLabel: 'customer-evidence' }); }],
  ])('detects %s', async (_name, mutate) => {
    const f = detectorFixture(); mutate(f); sealRegistration(f);
    expect((await inspect(f)).findings.length).toBeGreaterThan(0);
  });
  it.each(['missing', 'hash', 'workspace', 'subject', 'owner', 'expiry', 'approval', 'bytes', 'source', 'absent-body'] as const)('detects %s stored record/provenance failure', async failure => {
    const f = detectorFixture(), stored = f.artifacts.get(f.input.registration.ref)!;
    if (failure === 'missing') f.artifacts.delete(f.input.registration.ref);
    if (failure === 'source') f.artifacts.delete('fixture:cohort-source');
    if (failure === 'hash') f.input.registration.hash = 'e'.repeat(64);
    if (failure === 'workspace' || failure === 'subject' || failure === 'owner') stored.record[failure] = 'foreign';
    if (failure === 'expiry') stored.record.expiresAt = '2026-10-14T00:00:00Z';
    if (failure === 'approval') stored.approval!.principal = 'unqualified';
    if (failure === 'bytes') Object.assign(stored.body as object, { trialId: 'tampered' });
    if (failure === 'absent-body') stored.body = undefined;
    expect((await inspect(f)).findings.length).toBeGreaterThan(0);
  });
  it.each(SUPPORT_TRIAL_METRICS)('preserves measured %s stop breach alongside missing baseline and other observations', async metric => {
    const f = detectorFixture(), entry = f.input.observations[0]!;
    const body = structuredClone(f.artifacts.get(entry.record.ref)!.body) as ReturnType<Fixture['observe']>;
    body.measured[metric] = { value: f.registration.thresholds[metric].stop + 1 };
    body.baseline[metric] = { unknownReason: 'not-measured' };
    entry.record = f.put(entry.record.ref, body, false, -1);
    f.artifacts.delete(f.input.observations[1]!.record.ref);
    const result = await inspect(f);
    expect(result.findings).toContainEqual({ kind: 'failed', code: 'threshold-stop', subject: `${entry.record.ref}:${metric}` });
    expect(result.findings.some(v => v.kind === 'unknown')).toBe(true);
  });
  it.each(['trialId', 'cohortId', 'candidateSha256', 'receiptId', 'resultLabel'] as const)('detects misattributed observation %s', async key => {
    const f = detectorFixture(), entry = f.input.observations[0]!;
    const body = structuredClone(f.artifacts.get(entry.record.ref)!.body) as ReturnType<Fixture['observe']>;
    Object.assign(body, { [key]: key === 'receiptId' ? 9 : key === 'candidateSha256' ? 'f'.repeat(64) : 'foreign' });
    entry.record = f.put(entry.record.ref, body, false, -1);
    expect((await inspect(f)).findings.length).toBeGreaterThan(0);
  });
  it('detects duplicated receipts, missing comparable timing and failed recovery independently', async () => {
    const f = detectorFixture(), entry = f.input.observations[0]!;
    f.input.observations.push(entry);
    const body = structuredClone(f.artifacts.get(entry.record.ref)!.body) as ReturnType<Fixture['observe']>;
    body.recovered = false; body.measured.reviewSeconds = { unknownReason: 'absent' };
    entry.record = f.put(entry.record.ref, body, false, -1);
    expect((await inspect(f)).findings.map(v => v.code)).toEqual(expect.arrayContaining(['receipt-reused', 'observation-not-measured', 'recovered']));
  });
  it.each(['administration', 'policyUnderstood', 'recovered'] as const)('retains measured %s failure while prerequisite evidence is missing', async key => {
    const f = detectorFixture(), entry = f.input.observations[0]!;
    const body = structuredClone(f.artifacts.get(entry.record.ref)!.body) as ReturnType<Fixture['observe']>;
    body[key] = false; entry.record = f.put(entry.record.ref, body, false, -1);
    f.input.prerequisites = [];
    expect((await inspect(f)).findings).toContainEqual({ kind: 'failed', code: key, subject: entry.record.ref });
  });
  it.each(['failed', 'degraded', 'refused'] as const)('preserves a recorded %s prerequisite alongside a missing prerequisite', async state => {
    const f = detectorFixture(), prerequisite = f.input.prerequisites[0]!;
    const stored = f.artifacts.get(prerequisite.record.ref)!;
    prerequisite.record = f.put(prerequisite.record.ref, { ...(stored.body as object), state }, true);
    f.input.prerequisites.pop();
    const result = await inspect(f);
    expect(result.findings).toContainEqual({ kind: state, code: 'prerequisite-disposition', subject: prerequisite.id });
    expect(result.findings.some(v => v.kind === 'unknown')).toBe(true);
  });
});
const workflow = supportWorkflowFromOperation(operation, 'papercusp', revision)!;
const cases = supportWorkflowTrialCases(revision);

describe('P-015 labelled synthetic support trial inputs', () => {
  it('provides 30 distinct comparable cases with disjoint permitted and denied documents', () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((item) => item.input.supportCaseId)).size).toBe(30);
    expect(new Set(cases.map((item) => item.title)).size).toBe(30);
    expect(new Set(cases.map((item) => item.reviewerOnlyOracle.trigger)).size).toBe(30);
    const ids = cases.flatMap((item) => [...item.documents, item.deniedDocument].map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of cases) {
      expect(item.provenance).toBe('synthetic');
      expect(item.resultLabel).toBe('internal-simulation');
      expect(item.input.documentIds).toEqual(item.documents.map(({ id }) => id));
      expect(item.input.documentIds).not.toContain(item.deniedDocument.id);
      expect(JSON.stringify(item.documents)).not.toContain(item.deniedDocument.snippet);
    }
  });

  it.each(cases)('$input.supportCaseId uses the existing approved input and private schemas', (item) => {
    expect(assertSupportCaseInput(workflow, item.input)).toEqual(item.input);
    expect(checkAgainstJsonSchema(operation.inputSchema, item.input).ok).toBe(true);
    expect(checkAgainstJsonSchema(operation.privateInputSchema!, {
      supportCaseId: item.input.supportCaseId, documents: item.documents,
    }).ok).toBe(true);
    expect(() => assertSupportCaseInput(workflow, { ...item.input, approvedRevision: 'c'.repeat(64) })).toThrow(/outside/);
    expect(() => assertSupportCaseInput(workflow, { ...item.input, requestedAction: 'publish' })).toThrow(/outside/);
  });

  it.each(cases)('$input.supportCaseId rejects restricted or foreign-case citations', (item) => {
    // This is a fabricated contract control, never a model result or trial outcome.
    const result = { supportCaseId: item.input.supportCaseId, summary: item.title,
      reproduction: [item.reviewerOnlyOracle.trigger], checklist: [item.reviewerOnlyOracle.expected],
      suggestedRole: item.reviewerOnlyOracle.suggestedRole,
      citations: item.documents.map(({ id, source, externalId }) => ({ id, source, externalId })),
    };
    expect(parseSupportToEngineeringResult(result, item.input, item.documents).supportCaseId)
      .toBe(item.input.supportCaseId);
    const foreignCase = cases.find((other) => other.input.supportCaseId !== item.input.supportCaseId)!;
    for (const invalid of [item.deniedDocument, foreignCase.documents[0]]) {
      expect(() => parseSupportToEngineeringResult({ ...result, citations: [invalid] }, item.input, item.documents))
        .toThrow(/evidence/);
    }
    expect(() => parseSupportToEngineeringResult(result, item.input, item.documents.slice(0, 1)))
      .toThrow(/complete canonical evidence/);
  });

  it('recreates inputs without inheriting decisions or mutation from a previous run', () => {
    const first = supportWorkflowTrialCases(revision);
    first[0].documents[0].snippet = 'mutated by a runner';
    expect(supportWorkflowTrialCases(revision)[0].documents[0].snippet).not.toBe('mutated by a runner');
    for (const item of cases) {
      expect(item).not.toHaveProperty('accepted');
      expect(item).not.toHaveProperty('baselineMs');
      expect(item).not.toHaveProperty('costMicros');
      expect(item).not.toHaveProperty('reviewerDecision');
    }
  });
});
