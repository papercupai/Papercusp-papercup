import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { readLatestRubricCheckResults } from '../check-results-ledger';
import { perfEvidenceRepository, sealPerfEvidence } from './perf-workload-evidence';
import { perfProtocolHash } from './perf-workload-protocol';

let db: OrgTestDb;
let directory: string;
beforeAll(async () => {
  db = await createOrgTestDb();
  directory = await mkdtemp(join(tmpdir(), 'perf-evidence-pg-'));
}, 180_000);
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  await db?.cleanup();
});

it('retains evidence through real Postgres and files, without making integrity an acceptance grade', async () => {
  const repository = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'perf-evidence-fixture', harnessSlug: 'papercusp' } });
  const body = { kind: 'registration' as const, protocolHash: perfProtocolHash('fixture-protocol'), registeredAtMs: Date.now() - 60_000 };
  const before = Date.now();
  const receipt = await repository.publish(body);
  expect(receipt.evidence).toMatchObject(sealPerfEvidence(body));
  expect(receipt.evidence.publishedAtMs).toBeGreaterThanOrEqual(before);
  expect(await repository.read(receipt.ref)).toEqual(receipt.evidence);
  const unscoped = await readLatestRubricCheckResults({ rubricRef: 'acceptance-host-memory-right-sizing-2026-10-31',
    workspaceId: 'perf-evidence-fixture' }, db.adminSql);
  expect(unscoped.size).toBe(0);
  const foreign = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'other-workspace', harnessSlug: 'papercusp' } });
  expect(await foreign.read(receipt.ref)).toBeNull();
  // Exact-row refs keep resolving the earlier snapshot when a new edition is appended.
  const newer = await repository.publish({ ...body, protocolHash: perfProtocolHash('different-protocol') });
  expect(newer.ref).not.toBe(receipt.ref);
  expect(await repository.read(receipt.ref)).toEqual(receipt.evidence);
  await writeFile(receipt.artifactPath, '{}');
  expect(await repository.read(receipt.ref)).toBeNull();
}, 30_000);

it('round-trips the new raw series and joint computation variants through real ledger rows', async () => {
  const repository = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'perf-evidence-fixture', harnessSlug: 'papercusp' } });
  const baseline = await repository.publish({ kind: 'baseline', endedAtMs: Date.now() - 60_000,
    sourceManifestHash: perfProtocolHash('source'), fixtureHash: perfProtocolHash('fixture'),
    independentRepeatId: 'storage-fixture', independenceEvidenceRef: 'unqualified-fixture',
    observations: [{ journey: 'http', stratum: 'burst', completedPerArm: 3, allObservationsRetained: true }],
    series: [{ journey: 'http', stratum: 'burst', metric: 'p95', a: [1, 3000, 2], b: [2, 3000, 1] }] });
  const computation = await repository.publish({ kind: 'power-computation', endedAtMs: Date.now() - 60_000,
    protocolInputHash: perfProtocolHash('unqualified-storage-fixture'),
    result: { status: 'unknown', reason: 'prospective-computation-budget' } });
  expect(await repository.read(baseline.ref)).toEqual(baseline.evidence);
  expect(await repository.read(computation.ref)).toEqual(computation.evidence);
  if (baseline.evidence.kind !== 'baseline') throw new Error('fixture kind');
  expect(baseline.evidence.series?.[0].a).toEqual([1, 3000, 2]);
  const unscoped = await readLatestRubricCheckResults({ rubricRef: 'acceptance-host-memory-right-sizing-2026-10-31',
    workspaceId: 'perf-evidence-fixture' }, db.adminSql);
  expect(unscoped.size).toBe(0);
}, 30_000);

it('retains an unknown performance evaluation without turning artifact integrity into acceptance', async () => {
  const repository = perfEvidenceRepository({ directory, sql: db.adminSql,
    scope: { workspaceId: 'perf-evidence-fixture', harnessSlug: 'papercusp' } });
  const body = { schemaVersion: 1 as const, protocolHash: perfProtocolHash('fixture-protocol'), registrationRef: 'unqualified-fixture',
    repeats: [], status: 'unknown' as const, reasons: ['missing-pretrial-manifest-pins'], comparisons: [] };
  const receipt = await repository.publish({ kind: 'evaluation', endedAtMs: Date.now() - 1000,
    evaluation: { ...body, hash: perfProtocolHash(body) } });
  expect(await repository.read(receipt.ref)).toEqual(receipt.evidence);
  const unscoped = await readLatestRubricCheckResults({ rubricRef: 'acceptance-host-memory-right-sizing-2026-10-31',
    workspaceId: 'perf-evidence-fixture' }, db.adminSql);
  expect(unscoped.size).toBe(0);
}, 30_000);
