import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { perfEvidenceRepository, sealPerfEvidence } from './perf-workload-evidence';
import { perfProtocolHash } from './perf-workload-protocol';
import type { PerfWorkloadRun } from './perf-workload-run';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'perf-evidence-'));
  directories.push(directory);
  let row: Record<string, unknown> | null = null;
  let clock = 2000;
  const sql = async (text: TemplateStringsArray, ...values: unknown[]) => {
    if (text.join('').includes('INSERT')) {
      row = { id: 31, file_path: values[0], framework: values[1], status: values[2],
        harness_slug: values[9], workspace_id: values[10], execution_details: structuredClone(values[11]), created_at: new Date(clock) };
      return [{ id: 31 }];
    }
    return row ? [row] : [];
  };
  const repository = perfEvidenceRepository({ directory, sql, scope: { workspaceId: 'ws', harnessSlug: 'papercusp' }, now: () => clock });
  const body = { kind: 'registration' as const, protocolHash: perfProtocolHash('protocol'), registeredAtMs: 1000 };
  return { repository, body, directory, row: () => row!, setClock: (at: number) => { clock = at; } };
}

describe('perf artifact/results-ledger integrity', () => {
  it('round-trips exact evidence by immutable row and byte hash, using the DB publication clock', async () => {
    const f = await fixture();
    const receipt = await f.repository.publish(f.body);
    expect(receipt.evidence).toEqual({ ...sealPerfEvidence(f.body), publishedAtMs: 2000 });
    expect(await f.repository.read(receipt.ref)).toEqual(receipt.evidence);
    expect(JSON.parse(await readFile(receipt.artifactPath, 'utf8'))).toEqual(sealPerfEvidence(f.body));
  });
  it('does not use an authored pretrial timestamp to hide a late baseline publication', async () => {
    const f = await fixture();
    const receipt = await f.repository.publish({ kind: 'power', endedAtMs: 1000, protocolInputHash: perfProtocolHash('design'),
      journey: 'http', stratum: 'cold', metric: 'p95', lowerPowerBound: 0.9, comparisonAlpha: 0.05 / 9, margin: 1.05 });
    expect(receipt.evidence).toMatchObject({ kind: 'power', endedAtMs: 1000, publishedAtMs: 2000 });
  });
  it('retains ordered baseline series and complete joint power results without scalar substitution', async () => {
    const f = await fixture();
    const bodies = [
      { kind: 'baseline' as const, endedAtMs: 1000, sourceManifestHash: perfProtocolHash('source'),
        fixtureHash: perfProtocolHash('fixture'), independentRepeatId: 'r1', independenceEvidenceRef: 'independence',
        observations: [{ journey: 'http', stratum: 'cold' as const, completedPerArm: 3, allObservationsRetained: true }],
        series: [{ journey: 'http', stratum: 'cold' as const, metric: 'p99' as const, a: [12, 9, 3000], b: [10, 11, 3000] }] },
      // Synthetic storage fixture: an integrity pass does not qualify its power.
      { kind: 'power-computation' as const, endedAtMs: 1000, protocolInputHash: perfProtocolHash('design'),
        result: { status: 'estimated' as const, method: 'nested-paired-block-production-ci-fixed-monte-carlo-v1' as const,
          assumption: 'conditional-on-preregistered-empirical-baseline-generator' as const,
          simulations: 200, iterations: 10_000, seed: 4, familySize: 9, comparisonAlpha: (1 - 0.95) / 9,
          monteCarloFamilyAlpha: 0.05, scenarios: [{ id: 'unchanged', jointPasses: 196, lowerPowerBound: 0.88 }], lowerPowerBound: 0.88 } },
    ];
    for (const body of bodies) {
      const receipt = await f.repository.publish(body);
      expect(await f.repository.read(receipt.ref)).toEqual({ ...sealPerfEvidence(body), publishedAtMs: 2000 });
      expect(JSON.parse(await readFile(receipt.artifactPath, 'utf8'))).toEqual(sealPerfEvidence(body));
    }
  });
  it('retains full unknown collection artifacts, without treating their integrity as qualification', async () => {
    const f = await fixture();
    // Storage-only fixture deliberately has no qualifying observations.
    const plan = { independentRepeatId: 'storage-only', phase: 'baseline' as const,
      origins: { a: 'http://127.0.0.1', b: 'http://127.0.0.1' },
      expectedManifestHashes: { a: perfProtocolHash('a'), b: perfProtocolHash('b') }, groups: [] };
    const body = { schemaVersion: 1 as const, plan, planHash: perfProtocolHash(plan), startedAtMs: 900, endedAtMs: 1000,
      status: 'unknown' as const, reasons: ['missing-observations'], groups: [] };
    const capture: PerfWorkloadRun = { ...body, hash: perfProtocolHash(body) };
    const receipt = await f.repository.publish({ kind: 'matched-run', endedAtMs: 1000, capture });
    expect(await f.repository.read(receipt.ref)).toMatchObject({ kind: 'matched-run', capture });
    capture.reasons = [];
    await expect(f.repository.publish({ kind: 'matched-run', endedAtMs: 1000, capture })).rejects.toThrow('invalid perf evidence');
  });
  it.each(['workspace_id', 'harness_slug', 'framework', 'status', 'file_path', 'id'])('rejects mismatched ledger %s', async field => {
    const f = await fixture(); const receipt = await f.repository.publish(f.body);
    f.row()[field] = field === 'id' ? 99 : 'other';
    expect(await f.repository.read(receipt.ref)).toBeNull();
  });
  it('rejects scalar-only, changed or truncated ledger provenance', async () => {
    const f = await fixture(); const receipt = await f.repository.publish(f.body);
    const original = structuredClone(f.row().execution_details);
    for (const mutate of [
      (c: any) => { delete c.provenance; },
      (c: any) => { c.value = perfProtocolHash('other'); },
      (c: any) => { c.provenance.procedure.snapshot = '{}'; },
      (c: any) => { c.provenance.truncated = true; },
    ]) {
      f.row().execution_details = structuredClone(original);
      mutate((f.row().execution_details as any).check);
      expect(await f.repository.read(receipt.ref)).toBeNull();
    }
  });
  it('detects artifact replacement and refuses to overwrite corrupt existing bytes', async () => {
    const f = await fixture(); const receipt = await f.repository.publish(f.body);
    await writeFile(receipt.artifactPath, '{}');
    expect(await f.repository.read(receipt.ref)).toBeNull();
    await expect(f.repository.publish(f.body)).rejects.toThrow('readback');
    expect(await readFile(receipt.artifactPath, 'utf8')).toBe('{}');
  });
  it('rejects missing artifacts, symlinks, path-shaped refs and missing rows', async () => {
    const f = await fixture(); const receipt = await f.repository.publish(f.body);
    await rm(receipt.artifactPath);
    expect(await f.repository.read(receipt.ref)).toBeNull();
    const target = join(f.directory, 'target.json');
    await writeFile(target, JSON.stringify(sealPerfEvidence(f.body)));
    await symlink(target, receipt.artifactPath);
    expect(await f.repository.read(receipt.ref)).toBeNull();
    for (const ref of ['../../target.json', 'latest', receipt.ref.replace(':31:', ':9007199254740992:')]) expect(await f.repository.read(ref)).toBeNull();
  });
  it('fails closed on unavailable ledger, malformed evidence and future clocks', async () => {
    const f = await fixture();
    await expect(f.repository.publish({ ...f.body, registeredAtMs: 3000 })).rejects.toThrow('readback');
    await expect(f.repository.publish({ ...f.body, protocolHash: 'bad' })).rejects.toThrow('invalid perf evidence');
    const receipt = await f.repository.publish(f.body);
    f.setClock(1999);
    expect(await f.repository.read(receipt.ref)).toBeNull();
    const unavailable = perfEvidenceRepository({ directory: f.directory, sql: async () => { throw new Error('offline'); },
      scope: { workspaceId: 'ws', harnessSlug: 'papercusp' } });
    expect(await unavailable.read(receipt.ref)).toBeNull();
  });
});
