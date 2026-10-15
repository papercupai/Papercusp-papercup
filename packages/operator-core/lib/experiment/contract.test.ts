import { describe, expect, it } from 'vitest';
import { validateLearningContract, type LearningContract, type LearningEvidenceKind } from './types';

const requiredKinds: LearningEvidenceKind[] = ['objective', 'judgment', 'regression', 'probe', 'cost', 'rollback'];

const baseContract = (overrides: Partial<LearningContract> = {}): LearningContract => ({
  contractVersion: '1',
  candidate: {
    id: 'candidate-1',
    version: 'v2',
    parentVersion: 'v1',
    variantHash: 'variant-hash',
    actor: { kind: 'agent', id: 'su-1', role: 'scout' },
    potScope: { potId: 'pot-1', workspaceId: 'workspace-1' },
    createdAt: '2026-09-04T00:00:00.000Z',
  },
  experiment: {
    batteryId: 'battery-1',
    testId: 'replay',
    baselineId: 'baseline',
    challengerId: 'candidate-1',
    taskHash: 'task-hash',
    modelHash: 'model-hash',
    promptHash: 'prompt-hash',
    rubricHash: 'rubric-hash',
    codeHash: 'code-hash',
    repeats: 3,
    startedAt: '2026-09-04T00:01:00.000Z',
    completedAt: '2026-09-04T00:02:00.000Z',
  },
  evidence: requiredKinds.map((kind) => ({
    id: kind, kind, status: 'pass', coverage: { required: 10, measured: 10 },
    artifactRefs: [`experiment:battery-1:${kind}`], recordedAt: '2026-09-04T00:03:00.000Z',
  })),
  spend: { requestedUsd: 2, reservedUsd: 2, usedUsd: 1.5, unsettledUsd: 0,
    settledAt: '2026-09-04T00:03:00.000Z' },
  decision: {
    verdict: 'accepted',
    authority: { kind: 'system', id: 'gym-verdict' },
    reason: 'All required gates passed on the pinned battery.',
    evidenceIds: [...requiredKinds],
    decidedAt: '2026-09-04T00:04:00.000Z',
  },
  activation: {
    version: 'v2',
    parentVersion: 'v1',
    rollbackVersion: 'v1',
    exposure: { population: 'pot-1', percentage: 10 },
    activatedAt: '2026-09-04T00:05:00.000Z',
  },
  outcomes: [{ status: 'pending' }],
  ...overrides,
});

describe('validateLearningContract', () => {
  it('accepts a complete evidence-backed candidate lifecycle', () => {
    expect(validateLearningContract(baseContract())).toEqual({ ok: true, errors: [] });
  });

  it.each(requiredKinds)('refuses acceptance when the %s gate is omitted entirely', (kind) => {
    const original = baseContract();
    const contract = baseContract({ evidence: original.evidence.filter((e) => e.kind !== kind),
      decision: { ...original.decision, evidenceIds: original.decision.evidenceIds.filter((id) => id !== kind) } });
    expect(validateLearningContract(contract).errors).toContain(`accepted decision is missing required evidence: ${kind}`);
  });

  it.each(requiredKinds)('refuses a vacuous pass for the %s gate', (kind) => {
    const original = baseContract();
    const contract = baseContract({ evidence: original.evidence.map((e) => e.kind === kind
      ? { ...e, coverage: { required: 0, measured: 0 } } : e) });
    expect(validateLearningContract(contract).errors).toContain(`accepted decision has no required coverage: ${kind}`);
  });

  it.each(['', '  ', '\n'])('refuses an unusable artifact reference %j', (ref) => {
    const original = baseContract();
    const contract = baseContract({ evidence: original.evidence.map((e) => e.kind === 'probe'
      ? { ...e, artifactRefs: [ref] } : e) });
    expect(validateLearningContract(contract).errors).toContain('evidence.artifactRef must be non-empty');
  });

  it.each(['unsettled', 'missing-settlement', 'invalid-settlement'] as const)(
    'refuses accepted decisions with %s spend', (state) => {
      const spend = { ...baseContract().spend };
      if (state === 'unsettled') spend.unsettledUsd = 0.5;
      if (state === 'missing-settlement') delete spend.settledAt;
      if (state === 'invalid-settlement') spend.settledAt = 'not-a-date';
      expect(validateLearningContract(baseContract({ spend })).ok).toBe(false);
    });

  it.each(['omitted', 'duplicate'] as const)('refuses %s decision evidence citations', (state) => {
    const original = baseContract();
    const evidenceIds = state === 'omitted' ? original.decision.evidenceIds.slice(1)
      : [...original.decision.evidenceIds, original.decision.evidenceIds[0]!];
    expect(validateLearningContract(baseContract({ decision: { ...original.decision, evidenceIds } })).ok).toBe(false);
  });

  it('retains an explicit partial, unsettled inconclusive observation without allowing activation', () => {
    const original = baseContract();
    const contract = baseContract({ activation: undefined, evidence: [],
      spend: { requestedUsd: 2, reservedUsd: 2, usedUsd: 1.5, unsettledUsd: 0.5 },
      decision: { ...original.decision, verdict: 'inconclusive', evidenceIds: [] } });
    expect(validateLearningContract(contract)).toEqual({ ok: true, errors: [] });
  });

  it('retains unknown execution pins while refusing their acceptance and activation', () => {
    const contract = baseContract({ experiment: { ...baseContract().experiment,
      modelHash: null, promptHash: null, codeHash: null } });
    expect(validateLearningContract(contract)).toMatchObject({ ok: false, errors: expect.arrayContaining([
      'experiment.modelHash must be non-empty', 'experiment.promptHash must be non-empty',
      'experiment.codeHash must be non-empty',
    ]) });
  });

  it('fails closed when an accepted candidate has incomplete or unmeasured evidence', () => {
    const result = validateLearningContract(
      baseContract({
        evidence: [
          {
            id: 'regression',
            kind: 'regression',
            status: 'not-measured',
            coverage: { required: 4, measured: 0 },
            artifactRefs: ['probe:run-1'],
            recordedAt: '2026-09-04T00:03:00.000Z',
          },
        ],
        decision: {
          ...baseContract().decision,
          evidenceIds: ['regression'],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'accepted decision has not-measured evidence: regression',
        'accepted decision has incomplete evidence: regression',
      ]),
    );
  });

  it('rejects alternate or unsafe lifecycle edges', () => {
    const result = validateLearningContract(
      baseContract({
        experiment: { ...baseContract().experiment, baselineId: 'candidate-1', challengerId: 'candidate-1' },
        spend: { requestedUsd: 1, reservedUsd: 2, usedUsd: 2, unsettledUsd: 1 },
        decision: { ...baseContract().decision, evidenceIds: ['missing'] },
        activation: { ...baseContract().activation!, rollbackVersion: '' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'experiment baseline and challenger must differ',
        'spend.reservedUsd cannot exceed requestedUsd',
        'spend.usedUsd + unsettledUsd cannot exceed reservedUsd',
        'decision references unknown evidence: missing',
        'activation.rollbackVersion must be non-empty',
      ]),
    );
  });

  it('requires an accepted decision before activation', () => {
    const result = validateLearningContract(
      baseContract({ decision: { ...baseContract().decision, verdict: 'inconclusive' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('activation requires an accepted decision');
  });
});
