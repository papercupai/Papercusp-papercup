import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPilotCapabilityManifest } from './capability-catalog';
import { capabilityHash, capabilityUnitHash, type CapabilityPacket, type CapabilityUnit } from './capability-contracts';
import { CAPABILITY_EXTRACTION_RECIPE, CAPABILITY_SUMMARY_PROMPT, verifyCapabilityPacket } from './capability-packets';
import {
  buildCapabilitySamplingSnapshot,
  buildCapabilityGraphSamplingHints,
  capabilityContentVersion,
  capabilityPairKey,
  sampleCapabilityCombination,
  type CapabilitySamplingOptions,
  type CapabilitySamplingSnapshot,
  type CapabilityStructuralRelation,
  type CapabilityThirdRole,
} from './capability-sampler';
import { dreamCapabilityRun, validateDreamSampling } from './dream-run-provenance';

const scope = { workspaceId: 'ws', potSlug: 'pot', repositoryId: 'repo' };
const now = Date.parse('2026-09-07T10:00:00Z');
const options: CapabilitySamplingOptions = { seed: 'fixture', promptVersion: 'dream-v2', now, arity: 2 };
function packet(
  name: string,
  domain = 'memory',
  granularity: CapabilityUnit['granularity'] = 'capability',
): CapabilityPacket {
  const unit = structuredClone(getPilotCapabilityManifest().units[0]!);
  unit.id = granularity + ':' + name;
  unit.granularity = granularity;
  unit.homeDomain = domain;
  unit.relatedDomains = [];
  unit.branch = name;
  unit.evidence = unit.evidence.map((ref) => ({
    ...ref,
    path: 'fixtures/' + name + (ref.kind === 'test' ? '.test.ts' : '.ts'),
  }));
  const sources = unit.evidence.map((ref) => {
    const excerpt = '// ' + name + '\n' + ref.anchor + '\n';
    return {
      ...ref,
      sourceHash: capabilityHash(excerpt),
      excerptHash: capabilityHash(excerpt),
      startLine: 1,
      endLine: 3,
      excerpt,
    };
  });
  return {
    schemaVersion: 'dream-capability-packet-v1',
    scope: { ...scope },
    unit,
    unitHash: capabilityUnitHash(unit),
    manifestRevision: 'fixture-v1',
    sources,
    extraction: {
      recipeVersion: CAPABILITY_EXTRACTION_RECIPE,
      promptVersion: CAPABILITY_SUMMARY_PROMPT,
      capturedAt: '2026-09-07T10:00:00Z',
      sourceCommit: null,
      dirty: true,
      backend: 'text',
      indexHealth: 'unknown',
      artifactRef: 'pack.xml',
      artifactHash: capabilityHash('pack'),
      durationMs: 1,
      securityScan: 'passed',
      costUsd: 0,
    },
    coverage: {
      status: 'partial',
      includedPaths: sources.map((s) => s.path),
      excluded: [],
      unresolved: [],
      truncated: false,
      note: 'Controlled fixture evidence only.',
    },
  };
}
function manifest(packets: CapabilityPacket[]) {
  return { ...getPilotCapabilityManifest(), revision: 'fixture-v1', units: packets.map((p) => p.unit) };
}
async function snapshot(packets: CapabilityPacket[], values: unknown[] = packets) {
  return buildCapabilitySamplingSnapshot(
    { rootPath: '/fixture', scope, manifest: manifest(packets), packets: values },
    async () => ({ fresh: true }),
  );
}
function selection(s: CapabilitySamplingSnapshot, input: Partial<CapabilitySamplingOptions> = {}) {
  const r = sampleCapabilityCombination(s, { ...options, ...input });
  if (r.status !== 'selected') throw new Error(JSON.stringify(r));
  return r;
}
function relation(s: CapabilitySamplingSnapshot, ai = 0, bi = 1): CapabilityStructuralRelation {
  const a = s.eligible[ai]!,
    b = s.eligible[bi]!;
  return {
    aId: a.packet.unit.id,
    bId: b.packet.unit.id,
    aVersion: a.contentVersion,
    bVersion: b.contentVersion,
    kind: 'transferable-invariant',
    rationale: 'Investigate transfer of the explicitly scoped output invariant.',
    preconditions: ['Both boundaries receive an explicit scope.'],
    aEvidenceIds: [a.packet.sources[0]!.id],
    bEvidenceIds: [b.packet.sources[0]!.id],
  };
}
function thirdRole(s: CapabilitySamplingSnapshot, ai = 0, bi = 1, ci = 2): CapabilityThirdRole {
  const a = s.eligible[ai]!,
    b = s.eligible[bi]!,
    c = s.eligible[ci]!;
  return {
    aId: a.packet.unit.id,
    bId: b.packet.unit.id,
    cId: c.packet.unit.id,
    aVersion: a.contentVersion,
    bVersion: b.contentVersion,
    cVersion: c.contentVersion,
    role: 'constraint',
    contribution: 'C supplies a bounded resource admission contract.',
    removalEffect: 'Removing C loses the resource admission bound.',
    evidenceIds: [c.packet.sources[0]!.id],
  };
}
const roots: string[] = [];

function graphPacket(name: string, domain: string, output?: string, input?: string): CapabilityPacket {
  const p = packet(name, domain);
  const evidenceIds = [p.sources.find(s => s.kind === 'implementation')!.id];
  p.unit.contracts = { inputs: [], outputs: [], events: [], state: [], guarantees: [], prerequisites: [], failureModes: [], resourceConstraints: [] };
  p.unit.contracts.outputs = output ? [{ text: output, status: 'observed', evidenceIds }] : [];
  p.unit.contracts.inputs = input ? [{ text: input, status: 'observed', evidenceIds }] : [];
  p.unitHash = capabilityUnitHash(p.unit);
  const source = p.sources.find(s => s.kind === 'implementation')!;
  p.graph = { status: 'measured', repositoryId: scope.repositoryId,
    sourceFingerprint: capabilityHash(JSON.stringify(p.sources.map(s => [s.id, s.path, s.sourceHash]))),
    candidates: [{ evidenceId: source.id, symbol: name, path: source.path, line1: 1,
      sourceHash: source.sourceHash, capabilityStatus: 'candidate-only' }],
    relationships: [], unmapped: [], claimValidation: 'manifest-evidence-only' };
  return p;
}

describe('graph-enriched sampler inputs', () => {
  it.each(['producer-consumer', 'transferable-invariant', 'purpose-mechanism', 'complementary-lifecycle'] as const)(
    'binds both source versions for %s and preserves admission caveats', async (kind) => {
      const a = graphPacket('a', 'memory'), b = graphPacket('b', 'code');
      const claim = (p: CapabilityPacket, text: string) => ({ text, status: 'observed' as const, evidenceIds: [p.sources[0]!.id] });
      if (kind === 'producer-consumer') {
        a.unit.contracts.outputs = [claim(a, 'Scoped artifact')]; b.unit.contracts.inputs = [claim(b, 'Scoped artifact')];
      } else if (kind === 'transferable-invariant') {
        a.unit.contracts.guarantees = [claim(a, 'Scoped artifact')]; b.unit.contracts.guarantees = [claim(b, 'Scoped artifact')];
      } else if (kind === 'purpose-mechanism') {
        a.unit.purpose = [claim(a, 'Scoped artifact')]; b.unit.mechanism = [claim(b, 'Scoped artifact')];
      } else {
        a.unit.contracts.events = [claim(a, 'Scoped artifact')]; b.unit.contracts.state = [claim(b, 'Scoped artifact')];
      }
      b.unit.contracts.prerequisites = [claim(b, 'Scoped authorization is required')];
      b.unit.contracts.resourceConstraints = [claim(b, 'Maximum one admitted resource')];
      a.unitHash = capabilityUnitHash(a.unit); b.unitHash = capabilityUnitHash(b.unit);
      const s = await snapshot([a, b]);
      const hints = buildCapabilityGraphSamplingHints(s);
      const hint = hints.relations.find(r => r.aId === a.unit.id && r.bId === b.unit.id && r.kind === kind)!;
      expect(hint).toMatchObject({ aVersion: s.eligible[0]!.contentVersion, bVersion: s.eligible[1]!.contentVersion });
      expect(hint.preconditions).toEqual(expect.arrayContaining([
        expect.stringContaining('Scoped authorization is required'), expect.stringContaining('Maximum one admitted resource'),
      ]));
      expect(hint.rationale).toContain('runtime compatibility remain unverified');
      const oldB = structuredClone(b);
      oldB.sources[0]!.sourceHash = capabilityHash('earlier independently captured source');
      const stale = { ...hint, bVersion: capabilityContentVersion(oldB) };
      expect(stale.bVersion).toMatch(/^[a-f0-9]{64}$/);
      expect(stale.bVersion).not.toBe(hint.bVersion);
      expect(selection(s, { relations: [stale], thirdRoles: [], policy: { strategyWeights: [1, 0, 0] } }).selection.relation).toBeNull();
    },
  );

  it('proposes source-version-bound producer/consumer and removable third-role candidates by default', async () => {
    const s = await snapshot([graphPacket('a', 'memory', 'Scoped artifact'),
      graphPacket('b', 'code', undefined, 'Scoped artifact'), graphPacket('c', 'planning', undefined, 'Scoped artifact')]);
    const hints = buildCapabilityGraphSamplingHints(s);
    expect(hints.relations).toContainEqual(expect.objectContaining({ aId: 'capability:a', bId: 'capability:b', kind: 'producer-consumer',
      aVersion: s.eligible[0]!.contentVersion, bVersion: s.eligible[1]!.contentVersion }));
    expect(hints.thirdRoles).toContainEqual(expect.objectContaining({ aId: 'capability:a', bId: 'capability:b', cId: 'capability:c', role: 'consumer' }));
    const sampled = selection(s, { arity: 3, policy: { strategyWeights: [1, 0, 0] } });
    expect(sampled.log.strategy).toBe('structural-cross-domain');
    expect(sampled.selection.relation?.kind).toBe('producer-consumer');
    expect(sampled.selection.c?.declaration.removalEffect).toContain('removes this proposed consumer contract');
    expect(sampled.selection.relation?.preconditions[0]).toContain('workspace/auth scope');
  });

  it('rejects stale graph identity, inferred contracts and overlapping capability aliases', async () => {
    const a = graphPacket('a', 'memory', 'Scoped artifact'), b = graphPacket('b', 'code', undefined, 'Scoped artifact');
    a.graph!.sourceFingerprint = '0'.repeat(64);
    expect(buildCapabilityGraphSamplingHints(await snapshot([a, b])).relations).toEqual([]);
    a.graph!.sourceFingerprint = capabilityHash(JSON.stringify(a.sources.map(s => [s.id, s.path, s.sourceHash])));
    a.unit.contracts.outputs[0]!.status = 'inferred'; a.unitHash = capabilityUnitHash(a.unit);
    expect(buildCapabilityGraphSamplingHints(await snapshot([a, b])).relations).toEqual([]);
    a.unit.contracts.outputs[0]!.status = 'observed'; a.unit.overlapsUnitIds = [b.unit.id]; a.unitHash = capabilityUnitHash(a.unit);
    expect(buildCapabilityGraphSamplingHints(await snapshot([a, b])).relations).toEqual([]);
  });

  it('keeps disconnected exploratory pairs and explicit random controls eligible', async () => {
    const s = await snapshot([graphPacket('a', 'memory', 'Scoped artifact'), graphPacket('b', 'code', undefined, 'Scoped artifact'),
      graphPacket('disconnected', 'planning')]);
    const selected = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const sampled = selection(s, { seed: `control:${i}`, mode: 'random-control' });
      expect(sampled.selection.relation).toBeNull();
      selected.add(sampled.selection.a.packet.unit.id); selected.add(sampled.selection.b.packet.unit.id);
    }
    expect(selected.has('capability:disconnected')).toBe(true);
    expect(selection(s, { relations: [], thirdRoles: [], policy: { strategyWeights: [0, 1, 0] } }).selection.relation).toBeNull();
  });
});

describe('persisted dream sampling compatibility', () => {
  it('reads known v1 provenance while keeping new writes v2-only', async () => {
    const current = selection(await snapshot([packet('a', 'memory'), packet('b', 'code')]));
    const readRun = (sampling: typeof current) =>
      dreamCapabilityRun({
        outcome: {
          capabilityRun: {
            schemaVersion: 'dream-capability-run-v1',
            manifestHash: 'a'.repeat(64),
            manifestRevision: 'fixture-v1',
            dreamerModel: 'dreamer',
            reviewerModel: 'reviewer',
            dreamPromptVersion: 'dream-v2',
            reviewPromptVersion: 'review-v1',
            sampling,
            calls: [],
            artifactId: null,
          },
        },
      });
    expect(readRun(current)?.sampling).toEqual(current);
    expect(() => validateDreamSampling(current)).not.toThrow();

    const historical = structuredClone(current);
    (historical.log as { version: string }).version = 'domain-structural-v1';
    expect(readRun(historical)?.sampling?.log.version).toBe('domain-structural-v1');
    expect(() => validateDreamSampling(historical)).toThrow(/Invalid persisted sampling provenance/);

    const unknown = structuredClone(historical);
    (unknown.log as { version: string }).version = 'domain-structural-v0';
    expect(() => readRun(unknown)).toThrow(/Invalid persisted sampling provenance/);
  });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('capability sampling eligibility', () => {
  it('verifies each packet against current manifest/scope and reports every missing or failed unit', async () => {
    const a = packet('a'),
      b = packet('b', 'plans'),
      c = packet('c');
    const verify = vi.fn(async (p: unknown) =>
      (p as CapabilityPacket).unit.id === b.unit.id
        ? { fresh: false as const, reason: 'test deleted' }
        : { fresh: true as const },
    );
    const r = await buildCapabilitySamplingSnapshot(
      { rootPath: '/fixture', scope, manifest: manifest([a, b, c]), packets: [a, b] },
      verify,
    );
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledWith(a, {
      rootPath: '/fixture',
      scope,
      unit: a.unit,
      manifestRevision: 'fixture-v1',
    });
    expect(r.eligible.map((e) => e.packet.unit.id)).toEqual([a.unit.id]);
    expect(r.exclusions).toEqual([
      { unitId: b.unit.id, reason: 'test deleted' },
      { unitId: c.unit.id, reason: 'Missing packet' },
    ]);
    expect(sampleCapabilityCombination(r, options)).toMatchObject({ status: 'no-pair', reason: 'insufficient-units' });
  });
  it.each(['workspaceId', 'potSlug', 'repositoryId'] as const)(
    'excludes cross-%s packets before verifier calls',
    async (axis) => {
      const a = packet('a'),
        b = packet('b');
      const foreign = structuredClone(b);
      foreign.scope[axis] = 'foreign';
      const verify = vi.fn(async () => ({ fresh: true as const }));
      const r = await buildCapabilitySamplingSnapshot(
        { rootPath: '/fixture', scope, manifest: manifest([a, b]), packets: [a, foreign] },
        verify,
      );
      expect(verify).toHaveBeenCalledTimes(1);
      expect(r.eligible.map((e) => e.packet.unit.id)).toEqual([a.unit.id]);
      expect(r.exclusions).toContainEqual({ unitId: b.unit.id, reason: 'Outside allowed scope or manifest' });
    },
  );
  it('excludes ambiguity, unknown identities, malformed and incomplete evidence without inventing coverage', async () => {
    const a = packet('a'),
      b = packet('b'),
      incomplete = structuredClone(b);
    incomplete.coverage.unresolved = ['missing contract'];
    const r = await snapshot([a, b], [a, a, incomplete, packet('unmapped'), {}]);
    expect(r.eligible).toEqual([]);
    expect(r.exclusions.map((e) => e.reason)).toEqual(
      expect.arrayContaining([
        'Ambiguous duplicate packets',
        'Materially incomplete evidence',
        'Outside allowed scope or manifest',
        'Invalid packet contract',
      ]),
    );
    expect(sampleCapabilityCombination(r, options)).toMatchObject({
      status: 'no-pair',
      log: { exclusions: r.exclusions },
    });
  });
  it('rechecks actual source bytes, including test deletion, with the maintained verifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-sampler-'));
    roots.push(root);
    const packets = [packet('a'), packet('b', 'plans')];
    await Promise.all(
      packets
        .flatMap((p) => p.sources)
        .map(async (s) => {
          await mkdir(dirname(join(root, s.path)), { recursive: true });
          await writeFile(join(root, s.path), s.excerpt);
        }),
    );
    await writeFile(join(root, 'pack.xml'), 'pack');
    const verify: typeof verifyCapabilityPacket = (p, input) =>
      verifyCapabilityPacket(p, input, { readArtifact: (p) => readFile(join(root, p), 'utf8') });
    const input = { rootPath: root, scope, manifest: manifest(packets), packets };
    const fresh = await buildCapabilitySamplingSnapshot(input, verify);
    expect(fresh.eligible, JSON.stringify(fresh.exclusions)).toHaveLength(2);
    await rm(join(root, packets[1]!.sources.find((s) => s.kind === 'test')!.path));
    const stale = await buildCapabilitySamplingSnapshot(input, verify);
    expect(stale.eligible).toHaveLength(1);
    expect(stale.exclusions[0]!.reason).toMatch(/verification unavailable/i);
    expect(stale.fingerprint).not.toBe(fresh.fingerprint);
  });
  it('rejects an altered snapshot instead of presenting it as the recorded population', async () => {
    const s = await snapshot([packet('a'), packet('b')]);
    s.eligible[0]!.packet.scope.potSlug = 'foreign';
    expect(() => sampleCapabilityCombination(s, options)).toThrow(/identity/);
  });
  it('rejects eligibility evidence marked incomplete after snapshot construction', async () => {
    const s = await snapshot([packet('a'), packet('b')]);
    expect(selection(s).status).toBe('selected');
    s.eligible[0]!.packet.coverage.truncated = true;
    expect(() => sampleCapabilityCombination(s, options)).toThrow(/identity/);
  });
});

describe('domain-aware reproducible draws', () => {
  it('repeats exact seed results across reordered source inputs', async () => {
    const packets = [packet('a'), packet('b', 'plans'), packet('c', 'papercusp-su')];
    const a = await snapshot(packets),
      b = await snapshot([...packets].reverse());
    for (let i = 0; i < 30; i++)
      expect(sampleCapabilityCombination(a, { ...options, seed: String(i) })).toEqual(
        sampleCapabilityCombination(b, { ...options, seed: String(i) }),
      );
  });
  it('honors the recorded 50/30/20 strategy draw exactly and labels structural sparse fallback', async () => {
    const s = await snapshot([packet('a'), packet('b'), packet('c', 'plans')]);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const r = selection(s, { seed: String(i) }),
        draw = r.log.draws[0]!;
      const expected =
        draw.random < 0.5
          ? 'structural-cross-domain'
          : draw.random < 0.8
            ? 'uniform-cross-domain'
            : 'same-domain-other-branch';
      expect(r.log.requestedStrategy).toBe(expected);
      seen.add(expected);
      if (expected === 'structural-cross-domain')
        expect(r.log).toMatchObject({
          strategy: 'uniform-cross-domain',
          fallback: 'No eligible pair for structural-cross-domain',
        });
      expect(r.log.pathProbability).toBeCloseTo(
        r.log.draws.reduce((p, d) => p * d.probability, 1),
        12,
      );
    }
    expect(seen.size).toBe(3);
  });
  it('chooses domains uniformly before bounded exposure-weighted units, independent of directory size', async () => {
    const s = await snapshot([...Array.from({ length: 8 }, (_, i) => packet('many-' + i)), packet('rare', 'plans')]);
    const exposures = Object.fromEntries(s.eligible.map((e, i) => [e.packet.unit.id, i === 0 ? 100 : 0]));
    const covered = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const r = selection(s, { seed: String(i), exposures, policy: { strategyWeights: [0, 1, 0] } });
      const domain = r.log.draws.find((d) => d.stage === 'anchor-domain')!;
      expect(domain.probability).toBe(0.5);
      expect(domain.eligibleCount).toBe(2);
      for (const d of r.log.draws.filter((d) => d.stage.endsWith('-unit')))
        expect(d.selectedWeight).toBeGreaterThanOrEqual(1);
      for (const d of r.log.draws.filter((d) => d.stage.endsWith('-unit')))
        expect(d.selectedWeight).toBeLessThanOrEqual(2);
      covered.add(domain.selected);
    }
    expect(covered).toEqual(new Set(['memory', 'plans']));
  });
  it('uses supported versioned relation features and refuses name-only/stale hints', async () => {
    const s = await snapshot([packet('a'), packet('b', 'plans')]);
    const hint = relation(s);
    const r = selection(s, { relations: [hint], policy: { strategyWeights: [1, 0, 0] } });
    expect(r.selection.relation).toEqual(hint);
    expect(r.selection.a.packet.unit.id).toBe(hint.aId);
    expect(r.log.fallback).toBeNull();
    for (const invalid of [
      { ...hint, aVersion: '0'.repeat(64) },
      { ...hint, aEvidenceIds: ['invented'] },
      { aId: hint.aId, bId: hint.bId },
    ]) {
      const rejected = selection(s, { relations: [invalid], policy: { strategyWeights: [1, 0, 0] } });
      expect(rejected.log.invalidRelations).toBe(1);
      expect(rejected.selection.relation).toBeNull();
      expect(rejected.log.strategy).toBe('uniform-cross-domain');
    }
  });
  it('falls back to different branches in one domain and returns no-pair if none exist', async () => {
    const a = packet('a'),
      b = packet('b');
    const r = selection(await snapshot([a, b]), { policy: { strategyWeights: [0, 1, 0] } });
    expect(r.log.strategy).toBe('same-domain-other-branch');
    b.unit.branch = a.unit.branch;
    b.unitHash = capabilityUnitHash(b.unit);
    expect(sampleCapabilityCombination(await snapshot([a, b]), options)).toMatchObject({
      status: 'no-pair',
      reason: 'no-eligible-pair',
    });
  });
  it('keeps the pure random control uniform over eligible ordered pairs without exposure weighting', async () => {
    const s = await snapshot([packet('a'), packet('b'), packet('c', 'plans')]);
    const r = selection(s, { mode: 'random-control', exposures: { 'capability:a': 100000 } });
    expect(r.log.draws).toHaveLength(1);
    expect(r.log.draws[0]).toMatchObject({
      stage: 'uniform-ordered-pair',
      eligibleCount: 6,
      probability: 1 / 6,
      selectedWeight: 1,
    });
    expect(r.selection.relation).toBeNull();
  });
  it('rejects alias/duplicated-source pairs and prefers capability recipes with tagged subsystem opt-in', async () => {
    const a = packet('a'),
      duplicate = structuredClone(a);
    duplicate.unit.id = 'capability:copy';
    duplicate.unitHash = capabilityUnitHash(duplicate.unit);
    const aliases = sampleCapabilityCombination(await snapshot([a, duplicate]), { ...options, mode: 'random-control' });
    expect(aliases).toMatchObject({ status: 'no-pair', log: { pairExclusions: { alias: 1 } } });
    expect(selection(await snapshot([a, packet('m', 'plans', 'mechanism')])).selection.recipe).toBe(
      'capability-mechanism',
    );
    const mechanisms = await snapshot([packet('m', 'plans', 'mechanism'), packet('n', 'memory', 'mechanism')]);
    expect(sampleCapabilityCombination(mechanisms, options)).toMatchObject({
      status: 'no-pair',
      log: { pairExclusions: { recipe: 1 } },
    });
    const subsystem = await snapshot([a, packet('s', 'plans', 'subsystem')]);
    expect(sampleCapabilityCombination(subsystem, options).status).toBe('no-pair');
    expect(selection(subsystem, { allowSubsystem: true }).selection.recipe).toBe('subsystem-experiment');
  });
  it('cools an unordered source-version pair across direction, seed, prompt and wording changes', async () => {
    const a = packet('a'),
      b = packet('b', 'plans'),
      s = await snapshot([a, b]);
    const first = selection(s);
    const history = [{ pairKey: first.selection.pairKey, selectedAt: now - 1 }];
    expect(capabilityPairKey(first.selection.b, first.selection.a)).toBe(first.selection.pairKey);
    expect(
      sampleCapabilityCombination(s, { ...options, seed: 'reverse', promptVersion: 'new-prompt', history }),
    ).toMatchObject({ status: 'no-pair', log: { pairExclusions: { cooldown: 1 } } });
    a.unit.name = 'Reworded description';
    a.unitHash = capabilityUnitHash(a.unit);
    expect(sampleCapabilityCombination(await snapshot([a, b]), { ...options, history }).status).toBe('no-pair');
    const changed = structuredClone(b);
    changed.sources[0]!.sourceHash = capabilityHash('new full source bytes');
    const refreshed = await snapshot([a, changed]);
    expect(selection(refreshed, { history }).selection.pairKey).not.toBe(first.selection.pairKey);
    expect(selection(s, { history, now: now + 24 * 60 * 60_000 }).status).toBe('selected');
  });
  it('retains transfer direction and C/prompt identity while keeping pair cooldown identity separate', async () => {
    const s = await snapshot([packet('a'), packet('b', 'plans')]);
    const directions = new Map<string, ReturnType<typeof selection>>();
    for (let i = 0; i < 30; i++) {
      const r = selection(s, { seed: String(i), mode: 'random-control' });
      directions.set(r.selection.a.packet.unit.id, r);
    }
    const [a, b] = [...directions.values()];
    expect(directions.size).toBe(2);
    expect(a!.selection.pairKey).toBe(b!.selection.pairKey);
    expect(a!.selection.attemptKey).not.toBe(b!.selection.attemptKey);
    const changedPrompt = selection(s, { seed: a!.log.seed, mode: 'random-control', promptVersion: 'different' });
    expect(changedPrompt.selection.attemptKey).not.toBe(a!.selection.attemptKey);
  });
  it('keeps scope key ordering out of snapshot and cooldown identities', async () => {
    const packets = [packet('a'), packet('b', 'plans')];
    const a = await snapshot(packets);
    const b = await buildCapabilitySamplingSnapshot(
      {
        rootPath: '/fixture',
        scope: { potSlug: scope.potSlug, repositoryId: scope.repositoryId, workspaceId: scope.workspaceId },
        manifest: manifest(packets),
        packets,
      },
      async () => ({ fresh: true }),
    );
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(selection(a).selection.pairKey).toBe(selection(b).selection.pairKey);
  });
});

describe('optional C contribution boundary', () => {
  it('selects a distinct evidenced third role while preserving the two required primaries', async () => {
    const s = await snapshot([packet('a'), packet('b', 'plans'), packet('c', 'experiments')]);
    const hints = [relation(s)],
      role = thirdRole(s);
    const r = selection(s, { arity: 3, relations: hints, thirdRoles: [role], policy: { strategyWeights: [1, 0, 0] } });
    expect([r.selection.a.packet.unit.id, r.selection.b.packet.unit.id]).toEqual([role.aId, role.bId]);
    expect(r.selection.c).toEqual({ entry: s.eligible[2], declaration: role });
    expect(new Set([role.aId, role.bId, r.selection.c!.entry.packet.unit.id]).size).toBe(3);
    const otherRole = selection(s, {
      arity: 3,
      relations: hints,
      thirdRoles: [{ ...role, role: 'consumer' }],
      policy: { strategyWeights: [1, 0, 0] },
    });
    expect(otherRole.selection.attemptKey).not.toBe(r.selection.attemptKey);
    expect(otherRole.selection.pairKey).toBe(r.selection.pairKey);
  });
  it.each(['duplicate', 'alias', 'decorative', 'missing-effect', 'unsupported-ref', 'stale'])(
    'rejects %s C declarations (role-boundary counterexamples)',
    async (kind) => {
      const packets = [packet('a'), packet('b', 'plans'), packet('c', 'experiments')];
      if (kind === 'alias') {
        packets[2]!.unit.overlapsUnitIds = [packets[0]!.unit.id];
        packets[2]!.unitHash = capabilityUnitHash(packets[2]!.unit);
      }
      const s = await snapshot(packets),
        valid = thirdRole(s);
      const invalid =
        kind === 'duplicate'
          ? { ...valid, cId: valid.aId, cVersion: valid.aVersion }
          : kind === 'decorative'
            ? { ...valid, role: 'decoration' }
            : kind === 'missing-effect'
              ? { ...valid, removalEffect: '' }
              : kind === 'unsupported-ref'
                ? { ...valid, evidenceIds: ['invented'] }
                : kind === 'stale'
                  ? { ...valid, cVersion: '0'.repeat(64) }
                  : valid;
      const result = sampleCapabilityCombination(s, {
        ...options,
        arity: 3,
        relations: [relation(s)],
        thirdRoles: [invalid],
        policy: { strategyWeights: [1, 0, 0] },
      });
      expect(result).toMatchObject({
        status: 'no-pair',
        reason: 'no-third-candidate',
        log: { invalidThirdRoles: 1, thirdOutcome: 'unavailable' },
      });
    },
  );
  it('never substitutes C for a missing primary and rejects arity four', async () => {
    const a = packet('a'),
      b = packet('b'),
      s = await snapshot([a, b], [a]);
    expect(sampleCapabilityCombination(s, { ...options, arity: 3 })).toMatchObject({
      status: 'no-pair',
      reason: 'insufficient-units',
    });
    expect(() => sampleCapabilityCombination(s, { ...options, arity: 4 as never })).toThrow(/pair\/triple/);
  });
  it('records mixed-mode 20% C draws and explicitly reports unavailable C without changing A/B', async () => {
    const s = await snapshot([packet('a'), packet('b', 'plans')]);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = selection(s, { arity: 'mixed', seed: String(i) }),
        draw = r.log.draws.find((d) => d.stage === 'third-presence')!;
      expect(draw.selected).toBe(String(draw.random >= 0.8));
      expect(r.selection.c).toBeNull();
      expect(r.log.thirdOutcome).toBe(draw.selected === 'true' ? 'unavailable' : 'not-drawn');
      seen.add(r.log.thirdOutcome);
    }
    expect(seen).toEqual(new Set(['unavailable', 'not-drawn']));
  });
  it('enforces config and hint budgets instead of silently normalizing invalid settings', async () => {
    const s = await snapshot([packet('a'), packet('b')]);
    expect(() => sampleCapabilityCombination(s, { ...options, policy: { strategyWeights: [0.5, 0.5, 0.5] } })).toThrow(
      /sum/,
    );
    expect(() => sampleCapabilityCombination(s, { ...options, exposures: { 'capability:a': -1 } })).toThrow(/Exposure/);
    expect(() => sampleCapabilityCombination(s, { ...options, thirdRoles: Array(2001).fill({}) })).toThrow(/budget/);
    expect(capabilityContentVersion(s.eligible[0]!.packet)).toBe(s.eligible[0]!.contentVersion);
  });
});
