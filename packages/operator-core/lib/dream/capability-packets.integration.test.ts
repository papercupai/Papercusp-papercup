import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real pinned scanner without changing the workspace's flag store.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: async () => true,
}));

import { DEFAULT_PACKER_EFFECTS, packerFacade } from '../code-intelligence/packer-facade';
import type { CodeIntelAnswer } from '../code-intelligence/contracts';
import { getPilotCapabilityManifest, getCurrentCapabilityManifest } from './capability-catalog';
import { buildCapabilityPacket, verifyCapabilityPacket, queryCapabilityGraph, type CapabilityPacketDeps } from './capability-packets';
import { firstPartyCallersOffthread } from '../code-intelligence/first-party-callers-offthread';
import { LSP_VENDOR_DIR } from '../code-intelligence/lsp-adapter';
import { capabilityHash } from './capability-contracts';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from './capability-sampler';
import { applyDreamGraphTreatment, dreamComparisonInputHash, freezeDreamEvaluationProtocol } from './dream-evaluation';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(secretSource = false) {
  const root = await mkdtemp(join(tmpdir(), 'capability-real-pack-'));
  roots.push(root);
  const unit = structuredClone(getPilotCapabilityManifest().units[0]!);
  unit.evidence[0]!.path = secretSource ? '.env' : 'source.ts';
  unit.evidence[1]!.path = 'source.test.ts';
  const code = unit.evidence[0]!.anchor + '\n  candidates: string[],\n) { return candidates; }\n';
  await writeFile(join(root, unit.evidence[0]!.path), code);
  await writeFile(join(root, unit.evidence[1]!.path), unit.evidence[1]!.anchor + ', () => {});\n');
  const artifact = join(root, 'packet.xml');
  const values = new Map<string, unknown>();
  const unknown: CodeIntelAnswer = {
    backend: 'lsp-adapter',
    intent: 'references',
    query: 'isolated fixture',
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unknown', indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: 0,
    error: 'Fixture does not run a language server',
  };
  const deps: CapabilityPacketDeps = {
    cache: {
      get: async (workspace, key) => (values.has(workspace + key) ? { value: values.get(workspace + key) } : undefined),
      set: vi.fn(async (workspace, key, value) => {
        values.set(workspace + key, value);
      }),
    },
    pack: vi.fn(async (rootPath, include) =>
      packerFacade(
        'pack',
        {
          rootPath,
          include,
          format: 'xml',
          compress: false,
        },
        {
          ...DEFAULT_PACKER_EFFECTS,
          // Only artifact placement is replaced; executable, argv and scanner are real.
          writeArtifact: async (body) => {
            await writeFile(artifact, body);
            return artifact;
          },
        },
      ),
    ),
    lookup: async () => unknown,
    resolveSymbol: async () => unknown,
    neighbors: async (direction) => ({ ...unknown, backend: 'gitnexus', intent: direction }),
    readArtifact: (path) => readFile(path, 'utf8'),
    now: Date.now,
  };
  const input = {
    rootPath: root,
    scope: { workspaceId: 'isolated-packet-tests', potSlug: 'fixture', repositoryId: 'fixture' },
    unit,
    manifestRevision: 'isolated-v1',
  };
  return { root, artifact, code, input, deps };
}

describe('capability packets through the pinned secret-scanned packer', () => {
  it('P023: supplies version-bound sampler hints from real compiler packets while keeping disconnected random candidates', async () => {
    const f = await fixture();
    f.deps.graph = (root, repositoryId, name, filePath, paths) => firstPartyCallersOffthread({
      root, repositoryId, vendorDir: LSP_VENDOR_DIR, name, filePath, paths, op: 'context', contextScope: 'cited-files', limit: 12,
    }, { budgetMs: 20_000 });
    const packets = [];
    for (const [name, domain] of [['producer', 'memory'], ['consumer', 'code'], ['disconnected', 'planning']] as const) {
      const unit = structuredClone(f.input.unit);
      unit.id = `capability:${name}`; unit.granularity = 'capability'; unit.homeDomain = domain; unit.branch = name;
      unit.evidence[0]!.path = `${name}.ts`;
      unit.evidence[0]!.anchor = `export function ${name}(value: number)`;
      unit.evidence[1]!.path = `${name}.test.ts`;
      unit.evidence[1]!.anchor = `it('${name} rejects negative input'`;
      const ref = unit.evidence[0]!.id;
      const claim = (text: string) => ({ text, status: 'observed' as const, evidenceIds: [ref] });
      unit.contracts = { inputs: [], outputs: [], events: [], state: [], guarantees: [], prerequisites: [], failureModes: [], resourceConstraints: [] };
      if (name === 'producer') unit.contracts.outputs = [claim('A nonnegative numeric value.')];
      if (name === 'consumer') unit.contracts.inputs = [claim('A nonnegative numeric value.')];
      await writeFile(join(f.root, unit.evidence[0]!.path), unit.evidence[0]!.anchor
        + ' { if (value < 0) throw new RangeError("negative"); return value * 2; }\n');
      await writeFile(join(f.root, unit.evidence[1]!.path), `import { ${name} } from './${name}';\n`
        + unit.evidence[1]!.anchor + `, () => { expect(() => ${name}(-1)).toThrow(); });\n`);
      const artifact = join(f.root, `${name}.xml`);
      const deps = { ...f.deps, pack: (rootPath: string, include: string[]) => packerFacade('pack', {
        rootPath, include, format: 'xml', compress: false,
      }, { ...DEFAULT_PACKER_EFFECTS, writeArtifact: async (body) => { await writeFile(artifact, body); return artifact; } }) };
      const built = await buildCapabilityPacket({ ...f.input, unit }, deps);
      expect(built.status, JSON.stringify(built)).toBe('ready');
      if (built.status !== 'ready') throw new Error(built.reason);
      expect(built.packet.graph?.status).toBe('measured');
      packets.push(built.packet);
    }
    const manifest = { ...getPilotCapabilityManifest(), revision: f.input.manifestRevision, units: packets.map(p => p.unit) };
    const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: f.root, scope: f.input.scope, manifest, packets },
      (packet, input) => verifyCapabilityPacket(packet, input, f.deps));
    expect(snapshot.eligible, JSON.stringify(snapshot.exclusions)).toHaveLength(3);
    const opts = { seed: 'p023', promptVersion: 'p023-current', now: Date.now(), arity: 2 as const };
    const structural = sampleCapabilityCombination(snapshot, { ...opts, policy: { strategyWeights: [1, 0, 0] } });
    expect(structural.status).toBe('selected');
    if (structural.status !== 'selected') throw new Error(structural.reason);
    expect(structural.selection.relation).toMatchObject({ kind: 'producer-consumer',
      aVersion: structural.selection.a.contentVersion, bVersion: structural.selection.b.contentVersion });
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const control = sampleCapabilityCombination(snapshot, { ...opts, seed: `control:${i}`, mode: 'random-control' });
      if (control.status !== 'selected') throw new Error(control.reason);
      expect(control.selection.relation).toBeNull();
      seen.add(control.selection.a.packet.unit.id); seen.add(control.selection.b.packet.unit.id);
    }
    expect(seen.has('capability:disconnected')).toBe(true);
    const common = { manifestRevision: manifest.revision,
      scope: { workspaceId: f.input.scope.workspaceId, potSlug: f.input.scope.potSlug },
      problemContext: { mode: 'open-exploration' as const, evidence: [], note: 'Frozen integration comparison.' } };
    const comparison = { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: snapshot.fingerprint }),
      graphAblation: { treatments: ['graph', 'control'] as ['graph', 'control'],
        populationIds: snapshot.eligible.map(e => e.packet.unit.id), samplerHash: capabilityHash(JSON.stringify(opts)),
        attemptsPerTreatment: 2, usdPerTreatment: 2, outcomeAssessment: 'blinded-independent-executed-benefit' as const } };
    const bound = freezeDreamEvaluationProtocol({ sourceSnapshot: snapshot.fingerprint, comparison,
      benchmarkHash: 'a'.repeat(64), oracleHash: 'b'.repeat(64), independentLabelsRef: 'fixture:blinded-outcomes',
      seed: 'native-graph-fixture', models: { generator: 'generator', reviewer: 'reviewer' } });
    const graph = applyDreamGraphTreatment(snapshot, { ...bound, arm: 'structured-pair', matchedPairIndex: 0, graphTreatment: 'graph' });
    const baseline = applyDreamGraphTreatment(snapshot, { ...bound, arm: 'structured-pair', matchedPairIndex: 0, graphTreatment: 'control' });
    expect(graph).toBe(snapshot);
    expect(baseline.fingerprint).toBe(snapshot.fingerprint);
    expect(baseline.eligible.map(e => [e.packet.unit.id, e.contentVersion, e.packet.sources])).toEqual(
      graph.eligible.map(e => [e.packet.unit.id, e.contentVersion, e.packet.sources]));
    expect(baseline.eligible.every(e => e.packet.graph === undefined)).toBe(true);
    const control = sampleCapabilityCombination(baseline, opts);
    if (control.status !== 'selected') throw new Error(control.reason);
    expect(control.selection.relation).toBeNull();
    expect([control.selection.a, control.selection.b].every(e => !e.packet.graph)).toBe(true);
    expect(snapshot.eligible.some(e => e.packet.graph?.status === 'measured')).toBe(true);
    await writeFile(join(f.root, 'producer.ts'), 'export function producer(value: number) { return value * 3; }\n');
    const stale = await buildCapabilitySamplingSnapshot({ rootPath: f.root, scope: f.input.scope, manifest, packets },
      (packet, input) => verifyCapabilityPacket(packet, input, f.deps));
    expect(stale.eligible.some(e => e.packet.unit.id === 'capability:producer')).toBe(false);
    expect(() => applyDreamGraphTreatment(stale, { ...bound, arm: 'structured-pair', matchedPairIndex: 0, graphTreatment: 'control' }))
      .toThrow('population changed or is incomplete');
  }, 120_000);

  it('P022: enriches a source/test packet through the real compiler and scanner, then rejects edited evidence', async () => {
    const f = await fixture(), implementation = f.input.unit.evidence[0]!, test = f.input.unit.evidence[1]!;
    implementation.anchor = 'export function nativePacketTarget(value: number)';
    test.anchor = "it('rejects negative values'";
    const code = 'function nativePacketDouble(value: number) { return value * 2; }\n'
      + implementation.anchor + ' { if (value < 0) throw new RangeError("negative"); return nativePacketDouble(value); }\n';
    await writeFile(join(f.root, implementation.path), code);
    await writeFile(join(f.root, test.path), 'import { nativePacketTarget } from "./source";\n'
      + test.anchor + ', () => { expect(() => nativePacketTarget(-1)).toThrow(); });\n');
    const claim = (text: string, evidenceId: string) => ({ text, status: 'observed' as const, evidenceIds: [evidenceId] });
    f.input.unit.purpose = [claim('Reject negative input before computing a doubled value.', implementation.id)];
    f.input.unit.mechanism = [claim('An explicit range check throws before multiplication.', implementation.id)];
    f.input.unit.evaluation = [claim('The cited test exercises the negative input contract.', test.id)];
    f.input.unit.contracts.inputs = [claim('A numeric value.', implementation.id)];
    f.input.unit.contracts.outputs = [claim('The doubled nonnegative value.', implementation.id)];
    f.input.unit.contracts.failureModes = [claim('Negative input throws a RangeError.', implementation.id)];
    const compiler: CodeIntelAnswer[] = [];
    f.deps.graph = async (root, repositoryId, name, filePath, paths) => {
      const answer = await firstPartyCallersOffthread({ root, repositoryId, vendorDir: LSP_VENDOR_DIR,
        name, filePath, paths, op: 'context', limit: 12 }, { budgetMs: 20_000 });
      compiler.push(answer);
      return answer;
    };
    const result = await buildCapabilityPacket(f.input, f.deps);
    expect(result.status, JSON.stringify(result)).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.packet.graph, JSON.stringify({ graph: result.packet.graph, compiler })).toMatchObject({ status: 'measured', claimValidation: 'manifest-evidence-only',
      candidates: [{ symbol: 'nativePacketTarget', path: implementation.path, sourceHash: capabilityHash(code),
        capabilityStatus: 'candidate-only' }], relationships: expect.arrayContaining([
        expect.objectContaining({ origin: 'compiler', runtimeExecution: 'unknown',
          kind: 'callees', source: expect.objectContaining({ path: implementation.path }),
          target: expect.objectContaining({ path: implementation.path, line1: 1 }) }),
      ]) });
    expect(result.packet.unit.contracts.failureModes).toEqual(f.input.unit.contracts.failureModes);
    expect(await verifyCapabilityPacket(result.packet, f.input, f.deps)).toEqual({ fresh: true });
    await writeFile(join(f.root, implementation.path), code.replace('value * 2', 'value * 3'));
    expect((await verifyCapabilityPacket(result.packet, f.input, f.deps)).fresh).toBe(false);
  }, 120_000);
  it.each(getCurrentCapabilityManifest().units)(
    'DREAM-CATALOGUE-EVIDENCE: builds and revalidates current repository evidence for $id',
    async (unit) => {
      const f = await fixture();
      f.deps.graph = queryCapabilityGraph;
      const input = { ...f.input, rootPath: resolve(import.meta.dirname, '../../../..'), unit, manifestRevision: getCurrentCapabilityManifest().revision };
      const result = await buildCapabilityPacket(input, f.deps);
      expect(result.status, JSON.stringify(result)).toBe('ready');
      if (result.status !== 'ready') throw new Error(result.reason);
      expect(result.packet.sources.some(s => s.kind === 'implementation')).toBe(true);
      expect(result.packet.sources.some(s => s.kind === 'test')).toBe(true);
      expect(result.packet.coverage.status).toBe('partial');
      expect(result.packet.extraction.securityScan).toBe('passed');
      // This CAS packet cites an if-clause, not a declaration. Keep it in the
      // population with explicit unknown graph evidence rather than inventing a boundary.
      if (unit.id === 'capability:plans.spec-revisions') {
        expect(result.packet.graph).toMatchObject({ status: 'unknown', candidates: [], relationships: [],
          unmapped: ['No declared symbol at implementation anchor revision-code'], claimValidation: 'manifest-evidence-only' });
      } else {
        expect(result.packet.graph, JSON.stringify(result.packet.graph)).toMatchObject({ status: 'measured',
          claimValidation: 'manifest-evidence-only' });
        expect(result.packet.graph!.candidates.length).toBeGreaterThan(0);
        expect(result.packet.graph!.candidates.every(candidate => candidate.capabilityStatus === 'candidate-only')).toBe(true);
        expect(result.packet.graph!.unmapped.join(' ')).toContain('dependency bodies and relationships outside those files are not inspected');
      }
      expect(await verifyCapabilityPacket(result.packet, input, f.deps)).toEqual({ fresh: true });
    }, 120_000,
  );
  it('packs real source, reuses unchanged evidence, and invalidates edited bytes without a commit label', async () => {
    const f = await fixture();
    const first = await buildCapabilityPacket(f.input, f.deps);
    expect(first.status, JSON.stringify(first)).toBe('ready');
    if (first.status !== 'ready') throw new Error(first.reason);
    expect(first.packet.sources[0]!.excerpt).toBe(f.code);
    expect(first.packet.extraction.securityScan).toBe('passed');
    expect(first.packet.extraction.sourceCommit).toBeNull();
    expect(await buildCapabilityPacket(f.input, f.deps)).toMatchObject({ status: 'ready', cacheHit: true });
    expect(f.deps.pack).toHaveBeenCalledTimes(1);

    await writeFile(join(f.root, 'source.ts'), f.code + '// changed without a git commit\n');
    expect((await verifyCapabilityPacket(first.packet, f.input, f.deps)).fresh).toBe(false);
    const next = await buildCapabilityPacket(f.input, f.deps);
    expect(next).toMatchObject({ status: 'ready', cacheHit: false });
    expect(f.deps.pack).toHaveBeenCalledTimes(2);
  }, 120_000);

  it('refuses admission when the real deny-set excludes required evidence', async () => {
    const f = await fixture(true);
    const result = await buildCapabilityPacket(f.input, f.deps);
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('differs or is excluded') });
    expect(f.deps.cache.set).not.toHaveBeenCalled();
    const packed = await readFile(f.artifact, 'utf8');
    expect(packed).toContain('source.test.ts');
    expect(packed).not.toContain(f.code.trim());
    expect(packed).not.toContain('<file path=".env">');
  }, 120_000);
});
