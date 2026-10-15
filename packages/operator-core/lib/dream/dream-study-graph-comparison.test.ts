import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { capabilityHash } from './capability-contracts';
import { dreamEvaluationProtocolHash, applyDreamGraphTreatment } from './dream-evaluation';
import { prepareGraphComparison, GRAPH_OUTCOME_DESIGN } from './study/prepare-graph-comparison.mts';
import { validateStudyBlocks, STUDY_BLOCKS } from './study/accounting.mts';
import type { CapabilitySamplingSnapshot } from './capability-sampler';

const blocks = Object.values(STUDY_BLOCKS).map(block =>
  JSON.parse(readFileSync(new URL('./study/' + block.file, import.meta.url), 'utf8')));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function population() {
  const f = await createDreamCapabilityFixture('ws', 'pot');
  roots.push(f.root);
  const packet = f.packets[0]!;
  const graph = { status: 'measured' as const, repositoryId: packet.scope.repositoryId,
    sourceFingerprint: capabilityHash(JSON.stringify(packet.sources.map(s => [s.id, s.path, s.sourceHash]))),
    candidates: [{ name: 'fixture' }], relationships: [], unmapped: [] };
  return { schemaVersion: 'dream-eligible-capabilities-v1', scope: packet.scope, manifestRevision: packet.manifestRevision,
    fingerprint: 'a'.repeat(64), exclusions: [], eligible: [
      { packet: { ...packet, graph }, contentVersion: 'b'.repeat(64) },
      { packet: { ...packet, unit: { ...packet.unit, id: 'other' }, graph }, contentVersion: 'c'.repeat(64) },
    ] } as unknown as CapabilitySamplingSnapshot;
}

describe('native current graph study pre-registration', () => {
  it('freezes source/problem/sampler and equal treatment caps while retaining both historical blocks', async () => {
    const snapshot = await population();
    const before = JSON.stringify(blocks);
    const prepared = prepareGraphComparison(snapshot, blocks);
    expect(prepared.frozen.pin).toBe(dreamEvaluationProtocolHash(prepared.frozen.protocol));
    expect(validateStudyBlocks([...blocks, prepared.frozen])).toEqual(validateStudyBlocks(blocks));
    expect(JSON.stringify(blocks)).toBe(before);
    expect(prepared.frozen.protocol.comparison?.graphAblation).toMatchObject({
      populationIds: snapshot.eligible.map(e => e.packet.unit.id), attemptsPerTreatment: 2,
      usdPerTreatment: validateStudyBlocks(blocks).cycleUsd * 2,
      outcomeAssessment: 'blinded-independent-executed-benefit',
    });
    expect(prepared.frozen.protocol.benchmarkHash).toBe(capabilityHash(JSON.stringify(prepared.population)));
    expect(prepared.frozen.protocol.oracleHash).toBe(capabilityHash(JSON.stringify(GRAPH_OUTCOME_DESIGN)));
    const control = applyDreamGraphTreatment(snapshot, { ...prepared.frozen, arm: 'structured-pair', graphTreatment: 'control' });
    expect(control.eligible.every(e => !e.packet.graph)).toBe(true);
    expect(control.fingerprint).toBe(snapshot.fingerprint);
  });

  it('refuses partial, graphless and duplicate populations before registration', async () => {
    const snapshot = await population();
    expect(() => prepareGraphComparison({ ...snapshot, exclusions: [{ unitId: 'lost', reason: 'source changed' }] }, blocks)).toThrow('incomplete');
    const graphless = { ...snapshot, eligible: snapshot.eligible.map(e => ({ ...e, packet: { ...e.packet, graph: undefined } })) };
    expect(() => prepareGraphComparison(graphless, blocks)).toThrow('no measured graph');
    expect(() => prepareGraphComparison({ ...snapshot, eligible: [snapshot.eligible[0]!, snapshot.eligible[0]!] }, blocks)).toThrow();
    expect(() => prepareGraphComparison(snapshot, blocks.slice(1))).toThrow('historical block');
  });

  it('makes a source-version change observable without manufacturing outcomes', async () => {
    const snapshot = await population();
    const original = prepareGraphComparison(snapshot, blocks);
    const changed = structuredClone(snapshot);
    changed.fingerprint = 'd'.repeat(64);
    changed.eligible[0]!.contentVersion = 'e'.repeat(64);
    const current = prepareGraphComparison(changed, blocks);
    expect(current.frozen.pin).not.toBe(original.frozen.pin);
    expect(current.frozen.protocol.comparison!.inputHash).not.toBe(original.frozen.protocol.comparison!.inputHash);
    expect(current.frozen.protocol.benchmarkHash).not.toBe(original.frozen.protocol.benchmarkHash);
    expect(current.frozen.protocol.independentLabelsRef).toContain('pending');
    expect(current.outcomeDesign.decision).toContain('inconclusive');
  });
});
