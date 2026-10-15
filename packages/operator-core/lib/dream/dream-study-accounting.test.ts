import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { dreamComparisonInputHash, dreamEvaluationProtocolHash, type DreamPilotPin } from './dream-evaluation';
import { STUDY_BLOCKS, prepareStudyPilot, readStudyTotals, requireStudyRoom, validateStudyBlocks, studyPacketVerifier, requireStudyPacket, type StudyTotal } from './study/accounting.mts';
import type { CodeIntelAnswer } from '../code-intelligence/contracts';
import type { BuildCapabilityPacketInput } from './capability-packets';

const blocks = Object.values(STUDY_BLOCKS).map(block => JSON.parse(readFileSync(new URL('./study/' + block.file, import.meta.url), 'utf8')));
const limits = validateStudyBlocks(blocks);
const row = (pin: string, attempts: number, cost: number, arm: StudyTotal['arm'] = 'structured-pair'): StudyTotal => ({ pin, attempts, cost, arm });

describe('study packet freshness failure evidence', () => {
  it('records a packet-builder refusal before throwing with its exact reason', async () => {
    const record = vi.fn(async (_entry: unknown) => {});
    const built = { status: 'unavailable' as const, reason: 'Compiler graph differs from current cited source', costUsd: 0, durationMs: 42 };
    await expect(requireStudyPacket('capability:packer', built, record))
      .rejects.toThrow('Study packet unavailable: capability:packer: Compiler graph differs from current cited source');
    expect(record).toHaveBeenCalledWith({ phase: 'packet-build-failure', unitId: 'capability:packer', result: built });
  });
  const input = { rootPath: '/study', scope: { workspaceId: 'ws', potSlug: 'pot', repositoryId: 'repo' },
    unit: { id: 'capability:packer' }, manifestRevision: 'manifest' } as BuildCapabilityPacketInput;
  const packet = { graph: { status: 'measured', candidates: ['original-boundary'] },
    sources: [{ id: 'code', path: 'source.ts', sourceHash: 'original-hash' }] };
  it.each(['compiler-refusal', 'changed-relationship', 'worker-throw'])(
    'retains the offending packet and the original %s without replaying the query', async failure => {
      const answer = { error: failure === 'compiler-refusal' ? 'compiler deadline exceeded' : null,
        sites: [{ path: 'source.ts', line1: 2 }], freshness: { health: 'unknown' },
        evidence: { sourceScope: { sourceFingerprint: 'unchanged-source' }, relationships: ['changed-edge'] },
        truncation: { truncated: false } } as unknown as CodeIntelAnswer;
      const graph = vi.fn(async () => {
        if (failure === 'worker-throw') throw new Error('worker startup failed');
        return answer;
      });
      const refusal = { fresh: false as const, reason: 'Compiler graph differs from current cited source' };
      const record = vi.fn(async (_entry: unknown) => {});
      const verify = studyPacketVerifier({ graph, record, readArtifact: async () => 'artifact',
        verify: async (_packet, current, deps) => {
          try { await deps!.graph!(current.rootPath, 'repo', 'packer', 'source.ts', ['source.ts']); } catch {}
          return refusal;
        } });
      expect(await verify(packet, input)).toBe(refusal);
      expect(graph).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0]).toMatchObject({ phase: 'packet-freshness-failure', unitId: input.unit.id,
        sourceHashes: packet.sources, packetGraph: packet.graph, result: refusal,
        queries: [{ request: { symbol: 'packer', path: 'source.ts' },
          ...(failure === 'worker-throw' ? { error: 'worker startup failed' } : { evidence: answer.evidence, error: answer.error }) }] });
      expect(packet.graph.candidates).toEqual(['original-boundary']);
    },
  );
  it('preserves a passing verdict and fails closed when failed evidence cannot be saved', async () => {
    const record = vi.fn(async (_entry: unknown) => { throw new Error('evidence persistence failed'); });
    const ports = { graph: vi.fn(), record, readArtifact: async () => 'artifact' };
    expect(await studyPacketVerifier({ ...ports, verify: async () => ({ fresh: true }) })(packet, input)).toEqual({ fresh: true });
    expect(record).not.toHaveBeenCalled();
    await expect(studyPacketVerifier({ ...ports, verify: async () => ({ fresh: false, reason: 'changed' }) })(packet, input))
      .rejects.toThrow('evidence persistence failed');
  });
});

describe('finite Dream study accounting across model blocks', () => {
  it('retains the original failures and unknown reservation after a model switch', () => {
    const result = requireStudyRoom([
      row(STUDY_BLOCKS.haiku.pin, 2, 0.0551394),
      row(STUDY_BLOCKS.haiku.pin, 1, 0, 'structured-triple'),
      row(STUDY_BLOCKS.haiku.pin, 1, 0.0149784, 'uniform-pair'),
      row(STUDY_BLOCKS.luna.pin, 1, 0.1),
    ], 'structured-pair', limits);
    expect(result.attempts).toBe(5);
    expect(result.armAttempts).toBe(3);
    expect(result.accountedUsd).toBeCloseTo(0.1701178);
  });
  it('does not reset an arm attempt or money ceiling with a fresh model pin', () => {
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 2, 0.05), row(STUDY_BLOCKS.luna.pin, 48, 1)], 'structured-pair', limits)).toThrow(/cap reached/);
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 2, 30), row(STUDY_BLOCKS.luna.pin, 1, 11)], 'structured-pair', limits)).toThrow(/cap reached/);
  });
  it('counts all arms toward the total and reserves a complete next cycle', () => {
    const rows = ['blender', 'uniform-pair', 'structured-pair', 'structured-triple'].map(arm => row(STUDY_BLOCKS.haiku.pin, 50, 45, arm as StudyTotal['arm']));
    expect(() => requireStudyRoom(rows, 'structured-pair', limits)).toThrow(/cap reached/);
    const expensive = rows.map(r => ({ ...r, attempts: 1, cost: r.arm === 'structured-pair' ? 1 : 64 }));
    expect(() => requireStudyRoom(expensive, 'structured-pair', limits)).toThrow(/cap reached/);
  });
  it('fails closed for missing historical blocks, changed pins, and invalid accounting', () => {
    expect(() => validateStudyBlocks(blocks.slice(1))).toThrow(/every historical block/);
    const changed = structuredClone(blocks); changed[1].protocol.limits.attempts = 201;
    expect(() => validateStudyBlocks(changed)).toThrow();
    for (const bad of [null, NaN, -1]) expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 1, bad as number)], 'structured-pair', limits)).toThrow(/Invalid/);
  });
});

describe('native graph comparison retains cumulative study admission', () => {
  function native() {
    const protocol = structuredClone(blocks[1]!.protocol);
    const common = { sourceSnapshot: protocol.sourceSnapshot, manifestRevision: 'native-current-seven',
      scope: { workspaceId: 'papercusp-workspace', potSlug: 'papercusp' },
      problemContext: { mode: 'open-exploration' as const, evidence: [], note: 'Frozen independent comparison.' } };
    protocol.comparison = { ...common, inputHash: dreamComparisonInputHash(common),
      graphAblation: { treatments: ['graph', 'control'], populationIds: ['a', 'b'], samplerHash: 'a'.repeat(64),
        attemptsPerTreatment: 2, usdPerTreatment: limits.cycleUsd * 2, outcomeAssessment: 'blinded-independent-executed-benefit' } };
    delete protocol.comparison.sourceSnapshot;
    const block = { protocol, pin: dreamEvaluationProtocolHash(protocol) };
    const pilot: DreamPilotPin = { ...block, arm: 'structured-pair', graphTreatment: 'graph', matchedPairIndex: 0 };
    return { block, registered: [...blocks, block], pilot };
  }
  const treatment = (pin: string, graphTreatment: 'graph' | 'control', attempts: number, cost: number): StudyTotal =>
    ({ ...row(pin, attempts, cost), graphTreatment });

  it('selects the next treatment assignment from its recorded attempts without resetting legacy spending', () => {
    const { block, registered } = native();
    const rows = [row(STUDY_BLOCKS.haiku.pin, 2, 0.05), treatment(block.pin, 'control', 1, 0.02)];
    const control = prepareStudyPilot(registered, rows, { pin: block.pin, arm: 'structured-pair', graphTreatment: 'control' });
    expect(control.pilot).toMatchObject({ pin: block.pin, matchedPairIndex: 1, graphTreatment: 'control' });
    expect(control.cumulative).toMatchObject({ attempts: 3, accountedUsd: 0.07, treatmentAttempts: 1 });
    expect(prepareStudyPilot(registered, rows, { pin: block.pin, arm: 'structured-pair', graphTreatment: 'graph' }).pilot.matchedPairIndex).toBe(0);
    expect(prepareStudyPilot(blocks, [row(STUDY_BLOCKS.luna.pin, 1, 0.01)],
      { pin: STUDY_BLOCKS.luna.pin, arm: 'structured-pair' }).pilot.matchedPairIndex).toBe(1);
  });

  it('refuses a driver selection with an unregistered block, missing treatment, or a mismatched arm', () => {
    const { block, registered } = native();
    expect(() => prepareStudyPilot(registered, [], { pin: 'b'.repeat(64), arm: 'structured-pair', graphTreatment: 'graph' })).toThrow('not registered');
    expect(() => prepareStudyPilot(registered, [], { pin: block.pin, arm: 'structured-pair' })).toThrow('explicit paired treatment');
    expect(() => prepareStudyPilot(registered, [], { pin: block.pin, arm: 'uniform-pair', graphTreatment: 'graph' })).toThrow('explicit paired treatment');
    expect(() => prepareStudyPilot(blocks, [], { pin: STUDY_BLOCKS.luna.pin, arm: 'structured-pair', graphTreatment: 'graph' })).toThrow('Legacy study block');
    expect(() => prepareStudyPilot(registered, [row(STUDY_BLOCKS.haiku.pin, 50, 0.1)],
      { pin: block.pin, arm: 'structured-pair', graphTreatment: 'graph' })).toThrow('Cumulative study');
  });

  it('requires both historical pins and unchanged global limits for a new graph block', () => {
    const { block, registered } = native();
    expect(validateStudyBlocks(registered)).toEqual(limits);
    expect(() => validateStudyBlocks([block])).toThrow('every historical block');
    const changed = structuredClone(block); changed.protocol.limits.discoveryUsd += 1;
    changed.pin = dreamEvaluationProtocolHash(changed.protocol);
    expect(() => validateStudyBlocks([...blocks, changed])).toThrow('cumulative study limits');
    expect(() => validateStudyBlocks([...registered, block])).toThrow('every historical block');
  });

  it('queries both historical pins plus the new pin and preserves separate treatment costs', async () => {
    const { block, registered } = native();
    const graph = treatment(block.pin, 'graph', 1, limits.cycleUsd);
    const control = treatment(block.pin, 'control', 1, 0.01);
    const sql = vi.fn().mockResolvedValueOnce([graph, control]).mockResolvedValueOnce([]);
    expect(await readStudyTotals(sql as never, 'papercusp-workspace', registered)).toEqual([graph, control]);
    for (const call of sql.mock.calls) expect(call[2]).toEqual(registered.map(entry => entry.pin));
    expect(sql.mock.calls[0]![0].join('')).toContain('GROUP BY 1, 2, 3');
  });

  it('counts legacy failures and conservative costs against the next graph admission', () => {
    const { block, registered, pilot } = native();
    const rows = [row(STUDY_BLOCKS.haiku.pin, 2, 0.05), row(STUDY_BLOCKS.luna.pin, 1, 0.1),
      treatment(block.pin, 'control', 1, 0.02)];
    expect(requireStudyRoom(rows, 'structured-pair', limits, { blocks: registered, pilot }))
      .toMatchObject({ attempts: 4, armAttempts: 4, accountedUsd: 0.17, treatmentAttempts: 0 });
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 49, 1), ...rows.slice(2)], 'structured-pair', limits,
      { blocks: registered, pilot })).toThrow('Cumulative study');
    expect(() => requireStudyRoom([row(STUDY_BLOCKS.haiku.pin, 1, limits.discoveryUsdPerArm)], 'structured-pair', limits,
      { blocks: registered, pilot })).toThrow('Cumulative study');
  });

  it('admits treatments independently while charging unknown reservations and limiting attempts', () => {
    const { block, registered, pilot } = native();
    const graphSpent = treatment(block.pin, 'graph', 1, limits.cycleUsd * 2);
    const next = { ...pilot, matchedPairIndex: 1 };
    expect(() => requireStudyRoom([graphSpent], 'structured-pair', limits, { blocks: registered, pilot: next }))
      .toThrow('treatment attempt or conservative monetary');
    expect(requireStudyRoom([graphSpent], 'structured-pair', limits,
      { blocks: registered, pilot: { ...pilot, graphTreatment: 'control' } })).toMatchObject({ treatmentAttempts: 0 });
    expect(() => requireStudyRoom([treatment(block.pin, 'graph', 2, 0.01)], 'structured-pair', limits,
      { blocks: registered, pilot: { ...pilot, matchedPairIndex: 2 } })).toThrow('treatment attempt');
  });

  it('refuses missing/foreign treatment attribution and replayed pair assignment', () => {
    const { block, registered, pilot } = native();
    const options = { blocks: registered, pilot };
    expect(() => requireStudyRoom([], 'structured-pair', limits, { blocks: registered })).toThrow('registered treatment pin');
    expect(() => requireStudyRoom([row(block.pin, 1, 0.1)], 'structured-pair', limits, options)).toThrow('Invalid cumulative');
    expect(() => requireStudyRoom([treatment(STUDY_BLOCKS.haiku.pin, 'graph', 1, 0.1)], 'structured-pair', limits, options))
      .toThrow('Invalid cumulative');
    const observed = treatment(block.pin, 'graph', 1, 0.1);
    expect(() => requireStudyRoom([observed], 'structured-pair', limits, options)).toThrow('recorded attempts');
    expect(() => requireStudyRoom([observed, observed], 'structured-pair', limits, options)).toThrow('Invalid cumulative');
    expect(() => requireStudyRoom([], 'structured-pair', limits,
      { blocks: registered, pilot: { ...pilot, pin: 'b'.repeat(64) } })).toThrow('registered treatment pin');
  });
});
