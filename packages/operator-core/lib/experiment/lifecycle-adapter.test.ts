import { describe, expect, it } from 'vitest';
import {
  LEARNING_PRODUCERS,
  adaptCalibrationOutput,
  adaptGymOutput,
  adaptRedQueenOutput,
  adaptRegretOutput,
  adaptScoutOutput,
  adaptTransferOutput,
  canRetireLegacyWriter,
  contractArtifactRefs,
  evaluateLifecycleParity,
  type ProducerLifecycleInput,
} from './lifecycle-adapter';

const baseInput = (verdict: ProducerLifecycleInput['verdict'] = 'accept'): ProducerLifecycleInput => ({
  candidate: {
    id: 'candidate-1', version: 'v2', parentVersion: 'v1', variantHash: 'variant-hash',
    actor: { kind: 'agent', id: 'agent-1' }, potScope: { potId: 'pot-1', workspaceId: 'ws-1' }, createdAt: '2026-09-05T00:00:00.000Z',
  },
  experiment: {
    batteryId: 'battery-1', testId: 'replay', baselineId: 'baseline', challengerId: 'candidate-1', taskHash: 'task-hash', modelHash: 'model-hash', promptHash: 'prompt-hash', rubricHash: 'rubric-hash', codeHash: 'code-hash', repeats: 2, startedAt: '2026-09-05T00:00:00.000Z', completedAt: '2026-09-05T00:01:00.000Z',
  },
  evidence: [
    { id: 'objective-1', kind: 'objective', status: 'pass', coverage: { required: 2, measured: 2 }, artifactRefs: ['legacy:objective-1'], recordedAt: '2026-09-05T00:01:00.000Z' },
    { id: 'regression-1', kind: 'regression', status: 'pass', coverage: { required: 2, measured: 2 }, artifactRefs: ['legacy:regression-1'], recordedAt: '2026-09-05T00:01:00.000Z' },
    ...(['judgment', 'probe', 'cost', 'rollback'] as const).map((kind) => ({
      id: `${kind}-1`, kind, status: 'pass' as const, coverage: { required: 2, measured: 2 },
      artifactRefs: [`legacy:${kind}-1`], recordedAt: '2026-09-05T00:01:00.000Z',
    })),
  ],
  spend: { requestedUsd: 2, reservedUsd: 2, usedUsd: 1.5, unsettledUsd: 0, settledAt: '2026-09-05T00:01:00.000Z' },
  verdict,
  authority: { kind: 'system', id: 'lifecycle-adapter-test' },
  reason: 'measured evidence satisfies the common lifecycle',
  decidedAt: '2026-09-05T00:01:00.000Z',
  outcomes: [{ status: 'matured', measuredAt: '2026-09-05T00:01:00.000Z', value: 1, artifactRefs: ['legacy:objective-1'] }],
});

const adapters = { scout: adaptScoutOutput, gym: adaptGymOutput, calibration: adaptCalibrationOutput,
  transfer: adaptTransferOutput, regret: adaptRegretOutput, 'red-queen': adaptRedQueenOutput };

function boundContract(producer: typeof LEARNING_PRODUCERS[number]) {
  const input = baseInput();
  const sourceRef = `${producer}:${input.candidate.id}`;
  input.evidence = input.evidence.map((e) => ({ ...e, artifactRefs: [...e.artifactRefs, sourceRef] }));
  return structuredClone(adapters[producer](input).contract);
}

describe('P-011 common candidate/evidence/decision lifecycle', () => {
  it.each(LEARNING_PRODUCERS)('detaches and freezes the evaluated %s contract without freezing its caller', (producer) => {
    const input = baseInput();
    const result = adapters[producer](input);
    const captured = JSON.stringify(result.contract);
    expect(Reflect.set(input.candidate, 'version', 'rewritten')).toBe(true);
    expect(Reflect.set(input.candidate.actor, 'id', 'other-actor')).toBe(true);
    expect(Reflect.set(input.experiment, 'codeHash', 'other-code')).toBe(true);
    expect(Reflect.set(input.evidence[0]!, 'status', 'fail')).toBe(true);
    expect(Reflect.set(input.spend, 'unsettledUsd', 2)).toBe(true);
    expect(Reflect.set(input.authority, 'id', 'other-authority')).toBe(true);
    expect(Reflect.set(input.outcomes![0]!, 'value', -1)).toBe(true);
    expect(JSON.stringify(result.contract)).toBe(captured);
    expect(result.validation).toEqual({ ok: true, errors: [] });
    expect(Object.isFrozen(result.contract)).toBe(true);
    expect(Object.isFrozen(result.contract.evidence[0]!.artifactRefs)).toBe(true);
    expect(Reflect.set(result.contract.spend, 'unsettledUsd', 2)).toBe(false);
  });

  it.each(LEARNING_PRODUCERS)('keeps %s observation evidence and promotion consistent after caller mutation', (producer) => {
    const contract = boundContract(producer);
    const evaluation = { experiment: { codeHash: null }, runs: [{ id: 'actual-run', score: 0.8 }] };
    const result = adapters[producer]({ stage: 'observation', workspaceId: 'ws-1',
      sourceRef: `${producer}:${contract.candidate.id}`, source: { status: 'passed' },
      recordedAt: '2026-10-05T00:00:00Z', evaluation, contract });
    const captured = JSON.stringify(result);
    expect(result.promotionAllowed).toBe(true);
    evaluation.runs[0]!.score = -1;
    evaluation.experiment.codeHash = null;
    expect(Reflect.set(contract.spend, 'unsettledUsd', 2)).toBe(true);
    expect(Reflect.set(contract.evidence[0]!, 'status', 'fail')).toBe(true);
    expect(JSON.stringify(result)).toBe(captured);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evaluation)).toBe(true);
    expect(Object.isFrozen(result.decisions![0]!.contract.spend)).toBe(true);
    expect(Reflect.set(result.contract!.evidence[0]!, 'status', 'fail')).toBe(false);
  });

  it.each(LEARNING_PRODUCERS)('detaches inherited %s evaluation and decision history from a mutable prior receipt', (producer) => {
    const contract = boundContract(producer);
    const prior = structuredClone(adapters[producer]({ stage: 'observation', workspaceId: 'ws-1',
      sourceRef: `${producer}:${contract.candidate.id}`, source: { status: 'passed' },
      recordedAt: '2026-10-05T00:00:00Z', contract, evaluation: { runs: ['actual-run'], codeHash: null } }));
    const result = adapters[producer]({ stage: 'observation', workspaceId: 'ws-1',
      sourceRef: prior.sourceRef, source: { status: 'error', learning_lifecycle: prior },
      recordedAt: '2026-10-05T00:01:00Z' });
    const captured = JSON.stringify(result);
    expect(Reflect.set(prior.evaluation as object, 'runs', ['unrelated-run'])).toBe(true);
    expect(Reflect.set(prior.decisions![0]!.contract.spend, 'usedUsd', 999)).toBe(true);
    expect(JSON.stringify(result)).toBe(captured);
    expect(result).toMatchObject({ contract: null, promotionAllowed: false, evaluationCurrent: false });
    expect(Object.isFrozen(result.decisions)).toBe(true);
    expect(Object.isFrozen(result.decisions![0]!.contract)).toBe(true);
    expect(Reflect.set(result.decisions![0]!.contract.spend, 'usedUsd', 999)).toBe(false);
  });

  it('preserves discovery output without inventing promotion evidence for any producer', () => {
    const adapters = [adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput, adaptRegretOutput, adaptRedQueenOutput];
    for (const [index, adapt] of adapters.entries()) {
      const result = adapt({
        stage: 'observation', workspaceId: 'ws-1', sourceRef: `${LEARNING_PRODUCERS[index]}:source-1`,
        recordedAt: '2026-10-03T00:00:00.000Z',
        source: { status: 'accepted', model_spec: null, budget_spent_usd: null, signal_origin: 'drill' },
      });
      expect(result).toMatchObject({
        producer: LEARNING_PRODUCERS[index], contract: null, promotionAllowed: false,
        source: { status: 'accepted', model_spec: null, budget_spent_usd: null, signal_origin: 'drill' },
      });
      expect(result.stage).toBe(result.lifecycle.stage);
      expect(result.lifecycle).toMatchObject({ schemaVersion: '1', producer: LEARNING_PRODUCERS[index],
        sourceRef: `${LEARNING_PRODUCERS[index]}:source-1`, sourceHash: result.sourceHash });
      expect(result.missing.length).toBeGreaterThan(0);
    }
  });

  it('keeps unknown producer pins and settlement explicit in a source-linked partial lifecycle', () => {
    const result = adaptGymOutput({
      stage: 'observation', workspaceId: 'ws-1', sourceRef: 'gym:proposal-1',
      recordedAt: '2026-10-03T00:00:00.000Z',
      source: { id: 'proposal-1', workspace_id: 'ws-1', status: 'pending', role: 'worker',
        original_md: 'parent prompt', proposed_md: 'candidate prompt', created_at: '2026-10-03T00:00:00Z',
        candidate_verdict: { candidateId: 'candidate-1', parentId: 'parent-1',
          hashes: { variantHash: 'variant-sha', parentHash: 'parent-sha', rubricHash: 'rubric-sha',
            taskHash: 'task-sha', codeHash: 'code-sha' },
          gateResults: [{ gate: 'cost', status: 'pass', pass: true }] } },
    });

    expect(result).toMatchObject({ stage: 'evidence', contract: null, promotionAllowed: false,
      lifecycle: {
        sourceRef: 'gym:proposal-1', candidate: { status: 'partial', values: [{ id: 'candidate-1',
          variantHash: 'variant-sha', potScope: { workspaceId: 'ws-1', potId: null } }] },
        experiment: { status: 'partial', value: { baselineId: 'parent-1', challengerId: 'candidate-1',
          modelHash: null, promptHash: null, taskHash: 'task-sha' } },
        evidence: { values: [{ id: 'gym:proposal-1:cost', kind: 'cost', status: 'pass' }] },
        spend: { status: 'unknown', value: null }, decision: { status: 'not-applicable', value: null },
      } });
    expect(result.missing).toContain('experiment.modelHash');
    expect(result.missing.some((field) => field.startsWith('spend.governor reservation and settlement'))).toBe(true);
  });

  it('hashes the actual source consistently and excludes the previous receipt', () => {
    const input = {
      stage: 'observation' as const, workspaceId: 'ws-1', sourceRef: 'gym:source-1',
      recordedAt: '2026-10-03T00:00:00.000Z', source: { status: 'pending', pins: { b: 2, a: 1 } },
    };
    const first = adaptGymOutput(input);
    expect(adaptGymOutput({ ...input, source: { pins: { a: 1, b: 2 }, status: 'pending', learning_lifecycle: first } }).sourceHash).toBe(first.sourceHash);
    expect(adaptGymOutput({ ...input, source: { ...input.source, status: 'accepted' } }).sourceHash).not.toBe(first.sourceHash);
  });

  it('adapts every producer through the same validated contract', () => {
    const adapters = [adaptScoutOutput, adaptGymOutput, adaptCalibrationOutput, adaptTransferOutput, adaptRegretOutput, adaptRedQueenOutput];
    expect(LEARNING_PRODUCERS).toEqual(['scout', 'gym', 'calibration', 'transfer', 'regret', 'red-queen']);
    for (const [index, adapt] of adapters.entries()) {
      const result = adapt(baseInput());
      expect(result.producer).toBe(LEARNING_PRODUCERS[index]);
      expect(result.validation).toEqual({ ok: true, errors: [] });
      expect(result.contract.contractVersion).toBe('1');
      expect(result.contract.decision.verdict).toBe('accepted');
    }
  });

  it('records a complete bound settled decision and refuses unrelated or unsettled contracts', () => {
    const fixture = baseInput();
    const sourceRef = `transfer:${fixture.candidate.id}`;
    fixture.evidence = fixture.evidence.map((e) => ({ ...e, artifactRefs: [...e.artifactRefs, sourceRef] }));
    const contract = adaptTransferOutput(fixture).contract;
    const input = { stage: 'observation' as const, workspaceId: contract.candidate.potScope.workspaceId,
      sourceRef, source: { status: 'passed' }, recordedAt: '2026-10-03T00:00:00Z', contract };
    expect(adaptTransferOutput(input)).toMatchObject({ stage: 'decision', contract, promotionAllowed: true, validation: { ok: true } });
    expect(adaptTransferOutput({ ...input, workspaceId: 'foreign' }).promotionAllowed).toBe(false);
    expect(adaptTransferOutput({ ...input, sourceRef: 'transfer:unrelated' }).promotionAllowed).toBe(false);
    expect(adaptTransferOutput({ ...input, contract: { ...contract, spend: { ...contract.spend, settledAt: undefined } } }).promotionAllowed).toBe(false);
  });

  it.each(LEARNING_PRODUCERS)('withholds common promotion when %s omits a required gate', (producer) => {
    const fixture = baseInput();
    const sourceRef = `${producer}:${fixture.candidate.id}`;
    fixture.evidence = fixture.evidence.filter((e) => e.kind !== 'rollback')
      .map((e) => ({ ...e, artifactRefs: [...e.artifactRefs, sourceRef] }));
    const adapters = { scout: adaptScoutOutput, gym: adaptGymOutput, calibration: adaptCalibrationOutput,
      transfer: adaptTransferOutput, regret: adaptRegretOutput, 'red-queen': adaptRedQueenOutput };
    const adapt = adapters[producer];
    const contract = adapt(fixture).contract;
    const receipt = adapt({ stage: 'observation', workspaceId: fixture.candidate.potScope.workspaceId,
      sourceRef, source: { status: 'passed' }, recordedAt: fixture.decidedAt, contract });
    expect(receipt.promotionAllowed).toBe(false);
    expect(receipt.validation?.errors).toContain('accepted decision is missing required evidence: rollback');
  });

  it('preserves decision history through later observations and refuses rewriting the same battery decision', () => {
    const fixture = baseInput();
    const sourceRef = `transfer:${fixture.candidate.id}`;
    fixture.evidence = fixture.evidence.map((e) => ({ ...e, artifactRefs: [...e.artifactRefs, sourceRef] }));
    const contract = adaptTransferOutput(fixture).contract;
    const input = { stage: 'observation' as const, workspaceId: contract.candidate.potScope.workspaceId,
      sourceRef, source: { status: 'passed' }, recordedAt: '2026-10-03T00:00:00Z', contract };
    const accepted = adaptTransferOutput(input);
    const observed = adaptTransferOutput({ ...input, contract: undefined, source: { status: 'error', learning_lifecycle: accepted } });
    expect(observed).toMatchObject({ contract: null, promotionAllowed: false, decisions: [{ contract }] });
    expect(adaptTransferOutput({ ...input, contract: undefined, source: { learning_lifecycle: JSON.stringify(observed) } }).decisions).toEqual(observed.decisions);
    expect(() => adaptTransferOutput({ ...input, source: { learning_lifecycle: observed },
      contract: { ...contract, decision: { ...contract.decision, reason: 'rewritten' } } })).toThrow('common decision is immutable');
  });

  it('preserves partial evaluation through later writes, marks changed source stale, and never allows promotion', () => {
    const input = { stage: 'observation' as const, workspaceId: 'ws-1', sourceRef: 'transfer:lesson',
      recordedAt: '2026-10-03T00:00:00Z', source: { status: 'passed', last_battery_id: 'actual-battery' } };
    const evaluation = { experiment: { batteryId: 'actual-battery', codeHash: null }, reservation: { id: 'actual-reservation', status: 'open' } };
    const first = adaptTransferOutput({ ...input, evaluation });
    expect(first).toMatchObject({ evaluation, evaluationCurrent: true, contract: null, promotionAllowed: false });
    const linked = adaptTransferOutput({ ...input, source: { ...input.source, memory_id: 'memory', learning_lifecycle: first } });
    expect(linked).toMatchObject({ evaluation, evaluationCurrent: false, contract: null, promotionAllowed: false });
    const next = adaptTransferOutput({ ...input, source: { status: 'error', learning_lifecycle: linked } });
    expect(next.evaluation).toEqual(evaluation);
    expect(next.evaluationSourceHash).toBe(first.sourceHash);
    expect(next.evaluationCurrent).toBe(false);
  });

  it('maps rejection and inconclusive producer outputs without allowing activation', () => {
    const rejected = adaptGymOutput(baseInput('reject'));
    expect(rejected.validation.ok).toBe(true);
    expect(rejected.contract.decision.verdict).toBe('rejected');
    const inconclusive = adaptScoutOutput(baseInput('inconclusive'));
    expect(inconclusive.validation.ok).toBe(true);
    expect(inconclusive.contract.decision.verdict).toBe('inconclusive');
  });

  it('fails closed when an accepted producer has incomplete or failed evidence', () => {
    const input = baseInput();
    input.evidence = [{ ...input.evidence[0]!, status: 'not-measured', coverage: { required: 2, measured: 1 } }];
    const result = adaptTransferOutput(input);
    expect(result.validation.ok).toBe(false);
    expect(result.validation.errors).toEqual(expect.arrayContaining([
      'accepted decision has not-measured evidence: objective-1',
      'accepted decision has incomplete evidence: objective-1',
    ]));
  });

  it('requires artifact identity and evidence-kind parity before legacy retirement', () => {
    const contract = adaptRegretOutput(baseInput()).contract;
    const parity = evaluateLifecycleParity({
      producer: 'regret', contract,
      legacyArtifactRefs: ['legacy:objective-1', 'legacy:regression-1'],
      requiredEvidenceKinds: ['objective', 'regression'],
    });
    expect(parity.ok).toBe(true);
    expect(contractArtifactRefs(contract)).toEqual(['legacy:cost-1', 'legacy:judgment-1', 'legacy:objective-1',
      'legacy:probe-1', 'legacy:regression-1', 'legacy:rollback-1']);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 1 })).toBe(false);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 0 })).toBe(true);
  });

  it('keeps a missing legacy artifact or evidence kind from looking like parity', () => {
    const input = baseInput();
    input.evidence = input.evidence.filter((e) => e.kind !== 'probe');
    const contract = adaptRedQueenOutput(input).contract;
    const parity = evaluateLifecycleParity({ producer: 'red-queen', contract, legacyArtifactRefs: ['legacy:drill-1'], requiredEvidenceKinds: ['probe'] });
    expect(parity.ok).toBe(false);
    expect(parity.missingArtifactRefs).toEqual(['legacy:drill-1']);
    expect(parity.missingEvidenceKinds).toEqual(['probe']);
    expect(canRetireLegacyWriter({ parity, remainingLegacyWrites: 0 })).toBe(false);
  });
});
