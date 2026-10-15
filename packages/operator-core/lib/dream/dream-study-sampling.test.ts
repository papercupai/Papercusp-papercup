import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPilotCapabilityManifest } from './capability-catalog';
import { capabilityHash, capabilityUnitHash, CapabilityPacketSchema } from './capability-contracts';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination, type CapabilitySamplingSnapshot } from './capability-sampler';
import { CAPABILITY_DREAM_PROMPT_VERSION } from './capability-pass';
import { studySampling } from './study/sampling.mts';

let snapshot: CapabilitySamplingSnapshot;
let fixtureRoot: string;
afterAll(async () => { if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });
beforeAll(async () => {
  const fixture = await createDreamCapabilityFixture('test-d017', 'papercusp');
  fixtureRoot = fixture.root;
  const manifest = getPilotCapabilityManifest();
  const scope = fixture.scope;
  const packets = manifest.units.map(unit => ({
    ...structuredClone(fixture.packets[0]!), scope, unit, unitHash: capabilityUnitHash(unit), manifestRevision: manifest.revision,
    sources: unit.evidence.map(ref => ({ ...ref, excerpt: 'fixture ' + ref.id + ' ' + ref.anchor, sourceHash: capabilityHash(ref.path),
      excerptHash: capabilityHash('fixture ' + ref.id + ' ' + ref.anchor), startLine: 1, endLine: 1 })),
    coverage: { ...fixture.packets[0]!.coverage, includedPaths: [...new Set(unit.evidence.map(ref => ref.path))] },
  }));
  for (const packet of packets) CapabilityPacketSchema.parse(packet);
  // Source verification has its own tests and is exercised by the live driver's
  // dry run. This test covers sampling policy without opening a live database.
  snapshot = await buildCapabilitySamplingSnapshot({ rootPath: fixtureRoot, scope, manifest, packets }, async () => ({ fresh: true }));
  expect(snapshot.exclusions).toEqual([]);
});
describe('D017 source-grounded sampling setup', () => {
  it('supplies an eligible evidence-bound third role across the bounded seed window, retaining matched A/B', () => {
    const pair = studySampling(snapshot, 'structured-pair').sampler;
    const triple = studySampling(snapshot, 'structured-triple').sampler;
    for (let n = 0; n < 200; n++) {
      const input = { seed: 'paired-' + n, now: 1, promptVersion: CAPABILITY_DREAM_PROMPT_VERSION };
      const a = sampleCapabilityCombination(snapshot, { ...pair, ...input });
      const b = sampleCapabilityCombination(snapshot, { ...triple, ...input });
      expect(a.status).toBe('selected');
      expect(b.status).toBe('selected');
      if (a.status !== 'selected' || b.status !== 'selected') throw new Error('No study pair');
      expect(b.selection.c).not.toBeNull();
      expect(b.selection.pairKey).toBe(a.selection.pairKey);
      expect(b.log.invalidThirdRoles).toBe(0);
      expect(b.log.invalidRelations).toBe(0);
    }
  });
  it('leaves structural hints out of the uniform control and fingerprints annotation changes', () => {
    const uniform = studySampling(snapshot, 'uniform-pair');
    expect(uniform.sampler.mode).toBe('random-control');
    expect(uniform.sampler).not.toHaveProperty('relations');
    expect(uniform.sampler.policy.cooldownMs).toBe(0);
    expect(uniform.annotationHash).not.toBe(studySampling(snapshot, 'structured-pair').annotationHash);
  });
  it('uses current graph evidence without injecting historical annotations into either treatment', () => {
    const current = studySampling(snapshot, 'structured-pair', true);
    expect(current.sampler).toEqual({ mode: 'structured', arity: 2, policy: { cooldownMs: 0 } });
    expect(current.annotationHash).toBe(capabilityHash(JSON.stringify({ sourceSnapshot: snapshot.fingerprint, sampler: current.sampler })));
    expect(current.annotationHash).not.toBe(studySampling(snapshot, 'structured-pair').annotationHash);
    expect(() => studySampling(snapshot, 'uniform-pair', true)).toThrow('paired sampler');
    expect(() => studySampling(snapshot, 'structured-triple', true)).toThrow('paired sampler');
  });
});
