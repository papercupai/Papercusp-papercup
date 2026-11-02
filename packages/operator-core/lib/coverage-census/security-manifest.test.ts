import { describe, expect, it } from 'vitest';
import {
  createSecurityManifest, createSecurityTupleLedger, reconcileSecurityManifest,
  SECURITY_POPULATIONS, securityTupleId,
  type SecurityManifest, type SecurityProbeIdentity, type SecurityTuple, type SecurityTupleDisposition,
} from './security-manifest';

const hash = (letter = 'a') => letter.repeat(64);
const source = () => ({ revision: 'source-revision', sha256: hash() });
function population(): Omit<SecurityManifest, 'schemaVersion'> {
  return { producer: 'canonical-producer', source: source(), runtime: { revision: 'loaded-build', sha256: hash('b') },
    inputs: SECURITY_POPULATIONS.map(kind => ({ id: kind, population: kind, source: source(),
      surfaces: [{ kind, surfaceId: `${kind}:one`, fidelity: 'declared', attrs: { auth: 'required' } }] })) };
}
const tuple = (overrides: Partial<SecurityTuple> = {}): SecurityTuple => ({
  population: 'entry-point', kind: 'entry-point', surfaceId: 'entry-point:one',
  distribution: 'server-installed', platform: 'linux-x64', runtime: 'node', enforcementMode: 'strict',
  effect: 'filesystem-write', channel: 'authenticated-mcp', ...overrides,
});
function disposition(t: SecurityTuple): SecurityTupleDisposition {
  const rowId = securityTupleId(t);
  const probe = (id: string): SecurityProbeIdentity => ({ id: `${rowId}:${id}`, rowId,
    sourceSha256: hash(), testSha256: hash('c'), fixtureSha256: hash('d'), runtimeSha256: hash('b') });
  return { rowId, applicability: 'applicable', reason: 'source registry route', sourceRefs: ['source:registration'],
    owner: 'canonical-owner', positiveControl: probe('authorized'), negativeCanary: probe('forbidden') };
}
function ledgerInput() {
  const tuples = [tuple(), tuple({ channel: 'authenticated-http' }),
    ...SECURITY_POPULATIONS.filter(p => p !== 'entry-point').map(population =>
      tuple({ population, kind: population, surfaceId: `${population}:one` }))];
  return { manifest: createSecurityManifest(population()), producer: 'canonical-producer', tuples,
    dispositions: tuples.map(disposition) };
}

describe('immutable security census manifests', () => {
  it('is order independent, pins runtime bytes and leaves registry inputs mutable', () => {
    const input = population(), first = createSecurityManifest(input);
    input.inputs = [...input.inputs].reverse();
    expect(createSecurityManifest(input).bytes).toBe(first.bytes);
    expect(Object.isFrozen(first.body.inputs[0].surfaces[0].attrs)).toBe(true);
    expect(Object.isFrozen(input.inputs[0].surfaces[0].attrs)).toBe(false);
    expect(first.body.runtime.sha256).toBe(hash('b'));
    input.runtime.sha256 = hash('c');
    expect(createSecurityManifest(input).sha256).not.toBe(first.sha256);
  });

  it.each(SECURITY_POPULATIONS)('refuses an unenumerated %s population', missing => {
    const input = population();
    input.inputs = input.inputs.filter(i => i.population !== missing);
    expect(() => createSecurityManifest(input)).toThrow(`missing_population:${missing}`);
  });

  it('rejects empty enumerations, duplicate input identities and duplicate surfaces', () => {
    const input = population();
    expect(() => createSecurityManifest({ ...input, inputs: [...input.inputs, input.inputs[0]] })).toThrow('duplicate_input');
    input.inputs[0].surfaces = [];
    expect(() => createSecurityManifest(input)).toThrow('empty_input');
    const duplicate = population();
    duplicate.inputs[0].surfaces = [duplicate.inputs[0].surfaces[0], duplicate.inputs[0].surfaces[0]];
    expect(() => createSecurityManifest(duplicate)).toThrow('duplicate_surface');
  });

  it.each(['handler', 'native-helper', 'distribution', 'observed-route'] as const)(
    'detects an uncatalogued %s from independent input', populationKind => {
      const manifest = createSecurityManifest(population()), current = population();
      const input = current.inputs.find(i => i.population === populationKind)!;
      input.surfaces = [...input.surfaces, { kind: populationKind, surfaceId: 'hidden-new-route', fidelity: 'observed' }];
      const result = reconcileSecurityManifest(manifest, current);
      expect(result.matches).toBe(false);
      expect(result.missing).toHaveLength(1);
    });

  it('reconciles deletions and source, attributes, runtime drift in both directions', () => {
    const input = population();
    input.inputs[0].surfaces = [...input.inputs[0].surfaces, { kind: 'handler', surfaceId: 'removed', fidelity: 'declared' }];
    const manifest = createSecurityManifest(input), current = population();
    current.inputs[1].source.sha256 = hash('c');
    current.inputs[2].surfaces[0].attrs = { auth: 'none' };
    current.runtime.sha256 = hash('d');
    const result = reconcileSecurityManifest(manifest, current);
    expect(result.matches).toBe(false);
    expect(result.unexpected).toHaveLength(1);
    expect(result.changed).toHaveLength(3);
    expect(reconcileSecurityManifest(manifest, input).matches).toBe(true);
  });

  it('rejects mutated bodies or substituted snapshot bytes/digests', () => {
    const manifest = createSecurityManifest(population());
    expect(() => reconcileSecurityManifest({ ...manifest, sha256: hash('f') }, population())).toThrow('snapshot_drift');
    expect(() => reconcileSecurityManifest({ ...manifest, body: { ...manifest.body, producer: 'substitute' } }, population()))
      .toThrow('snapshot_drift');
  });
});

describe('pre-execution security tuple partitions', () => {
  it('freezes a complete, distinct row-bound control/canary partition without granting approval', () => {
    const input = ledgerInput(), ledger = createSecurityTupleLedger(input);
    expect(ledger.body.manifestSha256).toBe(input.manifest.sha256);
    expect(ledger.body.rows.map(r => r.rowId).sort()).toEqual(input.tuples.map(securityTupleId).sort());
    expect(ledger.body).not.toHaveProperty('approved');
    expect(ledger.body).not.toHaveProperty('commitment');
    expect(createSecurityTupleLedger({ ...input, tuples: [...input.tuples].reverse(),
      dispositions: [...input.dispositions].reverse() }).sha256).toBe(ledger.sha256);
  });

  it.each(['distribution', 'platform', 'runtime', 'enforcementMode', 'effect', 'channel', 'kind', 'surfaceId'] as const)(
    'keeps materially different %s rows distinct', dimension => {
      expect(securityTupleId(tuple({ [dimension]: 'different' }))).not.toBe(securityTupleId(tuple()));
    });

  it('rejects omitted, duplicate, unknown and merged rows', () => {
    const input = ledgerInput();
    expect(() => createSecurityTupleLedger({ ...input, dispositions: input.dispositions.slice(1) })).toThrow('missing_disposition');
    expect(() => createSecurityTupleLedger({ ...input, tuples: [input.tuples[0], input.tuples[0]] })).toThrow('tuple_duplicate');
    expect(() => createSecurityTupleLedger({ ...input, dispositions: [...input.dispositions, input.dispositions[0]] }))
      .toThrow('duplicate_disposition');
    expect(() => createSecurityTupleLedger({ ...input, tuples: [tuple({ surfaceId: 'unknown' })] })).toThrow('unknown_surface');
    expect(() => createSecurityTupleLedger({ ...input, tuples: input.tuples.slice(0, 2),
      dispositions: input.dispositions.slice(0, 2) })).toThrow('omitted_surface');
    expect(() => createSecurityTupleLedger({ ...input, dispositions: [{ ...input.dispositions[0], rowId: hash('e') }] }))
      .toThrow('unexpected_disposition');
  });

  it('requires source-justified N/A and explicit ownership of applicable rows', () => {
    const input = ledgerInput();
    input.dispositions[0] = { rowId: securityTupleId(input.tuples[0]), applicability: 'notApplicable',
      reason: 'GUI does not contain server loader', sourceRefs: ['distribution-contract:gui'] };
    expect(createSecurityTupleLedger(input).body.rows).toHaveLength(input.tuples.length);
    input.dispositions[0].sourceRefs = [];
    expect(() => createSecurityTupleLedger(input)).toThrow('missing_applicability_source');
    const unowned = ledgerInput();
    if (unowned.dispositions[0].applicability === 'applicable') unowned.dispositions[0].owner = '';
    expect(() => createSecurityTupleLedger(unowned)).toThrow('disposition.owner');
  });

  it('rejects cross-row probe reuse, row substitution, identical positive/negative probes and missing byte identities', () => {
    const input = ledgerInput();
    const a = input.dispositions[0], b = input.dispositions[1];
    if (a.applicability !== 'applicable' || b.applicability !== 'applicable') throw new Error('fixture');
    b.negativeCanary.id = a.positiveControl.id;
    expect(() => createSecurityTupleLedger(input)).toThrow('reused_probe');
    b.negativeCanary.id = 'distinct';
    b.negativeCanary.rowId = a.rowId;
    expect(() => createSecurityTupleLedger(input)).toThrow('probe_row_substitution');
    b.negativeCanary.rowId = b.rowId;
    a.negativeCanary.id = a.positiveControl.id;
    expect(() => createSecurityTupleLedger(input)).toThrow('reused_probe');
    a.negativeCanary.id = 'another-distinct';
    a.negativeCanary.fixtureSha256 = '';
    expect(() => createSecurityTupleLedger(input)).toThrow('invalid_digest:probe.fixtureSha256');
  });
});
