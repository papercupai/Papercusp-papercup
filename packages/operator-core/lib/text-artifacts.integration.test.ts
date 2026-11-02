/**
 * text-artifacts.integration.test.ts — the PG-canonical text-artifact store
 * (migration 035, drizzle), against a real Postgres. The disk mirror + sync are
 * seams (mocked); the SQL is real.
 *
 * Behaviors a fake-db unit test can't prove:
 *  - save→load round-trip + the `.papercusp/` rel_path normalization (a prefixed
 *    and a bare path hit the SAME row);
 *  - the (harness_slug, rel_path) upsert;
 *  - appendTextArtifact's ATOMIC PG-side `content || EXCLUDED.content` concat;
 *  - the EI-280 `adoptBlankWorkspace` guard: a save adopts the active workspace
 *    onto a BLANK-stamped legacy row, but never RE-HOMES a properly-stamped one;
 *  - delete.
 *
 * Reuses the drizzle harness from toast-log-data: `generated` stays real, a
 * drizzle(rootSql) db is injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { SecuritySourceProgress } from './coverage-census/security-source-census';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactPreparationStore, openBoundPreparationLedger } from '../../../scripts/lib/source-path-census.mjs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { UnifiedToolContext } from '@papercusp/tooldef';

const WS = 'ws-art';
const h = vi.hoisted(() => ({ db: undefined as unknown, sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db, sql: h.sql }) };
});
// This storage integration tests custody/SQL, not reviewer routing eligibility.
// Canonical lineage and its rejecting cases have their own maintained tests.
vi.mock('./acceptance-author-identity', () => ({ areAcceptanceLineageRelated: async () => false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
});
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { loadTextArtifact, saveTextArtifact, compareAndSwapTextArtifact, appendTextArtifact, deleteTextArtifact,
  saveImmutableTextArtifact, loadImmutableTextArtifact,
  claimImmutableTextArtifact, loadImmutableTextArtifactClaim } = await import('./text-artifacts');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `art_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: updated_at bigint, workspace_id NOT NULL default '', PK (harness_slug, rel_path).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_text_artifacts (
      harness_slug text NOT NULL,
      rel_path text NOT NULL,
      content text DEFAULT '' NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      CONSTRAINT harness_text_artifacts_pkey PRIMARY KEY (harness_slug, rel_path)
    )`);
  h.db = drizzle(rootSql);
  h.sql = rootSql;
  await rootSql.unsafe(`CREATE TABLE harness_shared.operator_secrets (name text PRIMARY KEY, value_b64 text NOT NULL)`);
  await rootSql`INSERT INTO harness_shared.operator_secrets VALUES ('spawn-signing-key', ${randomBytes(32).toString('base64')})`;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.harness_text_artifacts`;
});

const wsOf = async (slug: string, key: string) =>
  (await rootSql<{ workspace_id: string }[]>`SELECT workspace_id FROM harness_shared.harness_text_artifacts WHERE harness_slug=${slug} AND rel_path=${key}`)[0]?.workspace_id;

describe('text-artifacts (drizzle, PG)', () => {
  it('captures signed full host discovery through real PG without granting population closure', async () => {
    const q = await import('./coverage-census/security-qualification');
    const runtime = await import('./observability/runtime');
    const context: UnifiedToolContext = { uiClientId: 'su-discovery-producer', workspaceId: WS, harnessSlug: 'web', isSuperuser: true,
      log: () => {}, signal: new AbortController().signal, progress: async () => {}, emit: async () => {},
      principal: { kind: 'system', slug: 'system:superuser', workspaceId: WS,
        authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } };
    const release = runtime.registerRuntimeSecurityCapture(async () => ({
      surfaces: Array.from({ length: 503 }, (_, i) => ({ kind: 'mounted-http-handler', surfaceId: `fixture:${i}`,
        fidelity: 'observed' as const, attrs: { actualEffectCoverage: 'unknown' } })),
      declaredSurfaces: [], unresolved: ['fixture-only-not-production-closure'],
    }));
    try {
      const captured = await q.captureAuthenticatedRuntimeSecurityCensus(context, 'web');
      const verified = await q.verifyAuthenticatedRuntimeSecurityCensus('web', captured);
      expect(captured).toMatchObject({ readbackVerified: true, total: 503,
        populationComplete: false, closureAccepted: false, executionAdmitted: false });
      expect(verified.snapshot.rows).toHaveLength(503);
      expect(verified.snapshot.unresolved).toContain('fixture-only-not-production-closure');
      expect(verified.receipt.actor).toBe('su-discovery-producer');
      expect(verified.receipt.snapshotSha256).toBe(captured.snapshotRef);
      expect(await loadImmutableTextArtifact('web', captured.snapshotRef)).toContain('fixture:502');
      for (const ref of [captured.snapshotRef, captured.receiptRef]) {
        await expect(saveTextArtifact('web', `immutable/sha256/${ref}.json`, 'replace')).rejects.toThrow('immutable_namespace');
      }
      const corrupted = JSON.parse((await loadImmutableTextArtifact('web', captured.snapshotRef))!);
      corrupted.rows.pop();
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET content=${JSON.stringify(corrupted)}
        WHERE harness_slug='web' AND rel_path=${`immutable/sha256/${captured.snapshotRef}.json`}`;
      await expect(q.verifyAuthenticatedRuntimeSecurityCensus('web', captured)).rejects.toThrow();
    } finally { release(); }
  });

  it('commits signed review, consumes one execution and verifies exact result custody through real PG', async () => {
    const q = await import('./coverage-census/security-qualification');
    const { SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const context = (owner: string): UnifiedToolContext => ({ uiClientId: `su-${owner}`, workspaceId: WS, harnessSlug: 'web', isSuperuser: true,
      log: () => {}, signal: new AbortController().signal, progress: async () => {}, emit: async () => {},
      principal: { kind: 'system', slug: 'system:superuser', workspaceId: WS,
        authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } });
    const source = { revision: 'storage-fixture-source', sha256: 'a'.repeat(64) };
    const produced = await q.captureAuthenticatedSecurityManifest(context('producer'), 'web', { source, runtime: source,
      inputs: SECURITY_POPULATIONS.map(population => ({ id: population, population, source,
        surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) });
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'fixture-installed', platform: 'linux', runtime: 'node', enforcementMode: 'strict', effect: 'fs', channel: 'mcp' }));
    const planned = await q.prepareAuthenticatedSecurityLedger(context('ledger-producer'), 'web', {
      manifestSha256: produced.manifest.sha256, tuples, dispositions: tuples.map(tuple => ({
        rowId: securityTupleId(tuple), applicability: 'notApplicable', reason: 'Storage fixture only, no qualification claim',
        sourceRefs: ['fixture:storage'] })),
    });
    const input = await q.commitSecurityApplicability(context('reviewer'), 'web', {
      manifestSha256: produced.manifest.sha256, ledgerSha256: planned.ledger.sha256,
      manifestProducerRef: produced.producerRef, ledgerProducerRef: planned.producerRef,
      executor: 'su-executor', reviewRef: 'fixture:independent-storage-check' });
    const execute = vi.fn(async (pins: { startRef: string }) => {
      expect(await loadImmutableTextArtifactClaim('web', `security-qualification:start:${input.approvalRef}`)).toBe(pins.startRef);
      return 'storage-control';
    });
    const attempts = await Promise.allSettled(Array.from({ length: 3 }, () =>
      q.runSecurityQualification(context('executor'), 'web', input, execute)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const success = attempts.find(a => a.status === 'fulfilled');
    if (!success || success.status !== 'fulfilled') throw new Error('no successful control');
    const verified = await q.verifySecurityQualificationResult('web', success.value);
    expect(verified.ledger.body.rows.map(r => r.rowId)).toEqual(planned.ledger.body.rows.map(r => r.rowId));
    await expect(q.runSecurityQualification(context('executor'), 'web', input, execute)).rejects.toThrow('already_consumed');
    await expect(q.verifySecurityQualificationResult('web', { ...success.value, ledgerSha256: 'f'.repeat(64) }))
      .rejects.toThrow('result_pin_substitution');
  });

  it('routes authenticated security custody through testing adapters with real PG result readback', async () => {
    const a = await import('./agent-tools/testing/run-security-qualification');
    const { SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const context = (owner: string): UnifiedToolContext => ({ uiClientId: `su-${owner}`, workspaceId: WS,
      harnessSlug: 'web', isSuperuser: true, log: () => {}, signal: new AbortController().signal,
      progress: async () => {}, emit: async () => {}, principal: { kind: 'system', slug: 'system:superuser',
        workspaceId: WS, authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } });
    const source = { revision: 'adapter-storage-fixture', sha256: 'a'.repeat(64) };
    const produced = await a.securityQualificationMetadata(context('producer'), 'web', { phase: 'manifest',
      manifest: { source, runtime: source, inputs: SECURITY_POPULATIONS.map(population => ({ id: population,
        population, source, surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) } });
    if (!('manifestSha256' in produced) || !('producerRef' in produced)) throw Error('no manifest');
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'fixture', platform: 'linux', runtime: 'node', enforcementMode: 'strict', effect: 'fs', channel: 'mcp' }));
    const planned = await a.securityQualificationMetadata(context('producer'), 'web', { phase: 'ledger',
      manifestSha256: produced.manifestSha256, tuples, dispositions: tuples.map(tuple => ({
        rowId: securityTupleId(tuple), applicability: 'notApplicable', reason: 'Storage fixture, no security acceptance',
        sourceRefs: ['fixture:adapter-storage'] })) });
    if (!('ledgerSha256' in planned) || !('producerRef' in planned)) throw Error('no ledger');
    const review = { phase: 'review' as const, manifestSha256: produced.manifestSha256,
      ledgerSha256: planned.ledgerSha256, manifestProducerRef: produced.producerRef,
      ledgerProducerRef: planned.producerRef, executor: 'su-executor', reviewRef: 'fixture:review' };
    await expect(a.securityQualificationMetadata(context('producer'), 'web', review)).rejects.toThrow('reviewer_not_independent');
    const approved = await a.securityQualificationMetadata(context('reviewer'), 'web', review);
    if (!('approvalRef' in approved)) throw Error('no approval');
    const input = { phase: 'execute' as const, manifestSha256: review.manifestSha256,
      ledgerSha256: review.ledgerSha256, approvalRef: approved.approvalRef };
    // The callback is a storage fixture: this tests real signing/SQL/adapter
    // ordering and replay protection, not a router or confinement verdict.
    const core = vi.fn(async () => ({ ok: true, runId: 'adapter-storage-run', files: 1, passed: 1, failed: 0 }));
    const result = await a.executeSecurityQualification(context('executor'), 'web', input, core);
    expect(result.securityQualification).toMatchObject({ custodyOnly: true, securityVerdict: 'unmeasured' });
    const resultRef = result.securityQualification?.resultRef;
    if (typeof resultRef !== 'string') throw Error('no result ref');
    const verified = await a.securityQualificationMetadata(context('reviewer'), 'web', {
      phase: 'verify', manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, resultRef });
    expect(verified).toMatchObject({ readbackVerified: true, runId: 'adapter-storage-run', rows: 7,
      custodyOnly: true, securityVerdict: 'unmeasured' });
    await expect(a.executeSecurityQualification(context('executor'), 'web', input, core)).rejects.toThrow('already_consumed');
    expect(core).toHaveBeenCalledTimes(1);
    const evidenceRef = result.securityQualification?.executionEvidenceSha256;
    if (typeof evidenceRef !== 'string') throw Error('no execution evidence');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='{}'
      WHERE harness_slug='web' AND rel_path=${`immutable/sha256/${evidenceRef}.json`}`;
    await expect(a.securityQualificationMetadata(context('reviewer'), 'web', {
      phase: 'verify', manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, resultRef })).rejects.toThrow();
  });

  it('permanently consumes an immutable execution slot exactly once under concurrency', async () => {
    const slot = 'security-qualification:start:approval';
    const results = await Promise.all(Array.from({ length: 5 }, () => claimImmutableTextArtifact('web', slot, 'start')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await loadImmutableTextArtifactClaim('web', slot)).toBe('start');
    await expect(claimImmutableTextArtifact('web', slot, 'replay')).rejects.toThrow('claim_conflict');
    const [row] = await rootSql<{ rel_path: string }[]>`SELECT rel_path FROM harness_shared.harness_text_artifacts`;
    await expect(saveTextArtifact('web', row.rel_path, 'reopen')).rejects.toThrow('immutable_namespace');
    await expect(deleteTextArtifact('web', row.rel_path)).rejects.toThrow('immutable_namespace');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='foreign'`;
    expect(await loadImmutableTextArtifactClaim('web', slot)).toBeNull();
    await expect(claimImmutableTextArtifact('web', slot, 'start')).rejects.toThrow('claim_conflict');
  });

  it('preserves concurrent immutable revisions and refuses every ordinary write path', async () => {
    const first = await saveImmutableTextArtifact('web', '{"revision":1}');
    const same = await Promise.all(Array.from({ length: 3 }, () => saveImmutableTextArtifact('web', '{"revision":1}')));
    expect(same.every(ref => ref.sha256 === first.sha256)).toBe(true);
    const second = await saveImmutableTextArtifact('web', '{"revision":2}');
    expect(second.sha256).not.toBe(first.sha256);
    for (const key of [first.relPath, `.papercusp/${first.relPath}`]) {
      await expect(saveTextArtifact('web', key, 'changed')).rejects.toThrow('immutable_namespace');
      await expect(appendTextArtifact('web', key, 'changed')).rejects.toThrow('immutable_namespace');
      await expect(deleteTextArtifact('web', key)).rejects.toThrow('immutable_namespace');
      await expect(compareAndSwapTextArtifact('web', key, '{"revision":1}', 'changed')).rejects.toThrow('immutable_namespace');
      await expect(compareAndSwapTextArtifact('web', key, null, 'changed')).rejects.toThrow('immutable_namespace');
    }
    expect(await loadImmutableTextArtifact('web', first.sha256)).toBe('{"revision":1}');
    expect(await loadImmutableTextArtifact('web', second.sha256)).toBe('{"revision":2}');
    // An administrative DB write is not granted by these APIs. Detect it on read.
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='tampered' WHERE rel_path=${first.relPath}`;
    await expect(loadImmutableTextArtifact('web', first.sha256)).rejects.toThrow('immutable_corrupt');
    await expect(saveImmutableTextArtifact('web', '{"revision":1}')).rejects.toThrow('immutable_corrupt');
  });

  it('never adopts a foreign workspace immutable revision', async () => {
    const ref = await saveImmutableTextArtifact('web', 'content');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='other-ws' WHERE rel_path=${ref.relPath}`;
    expect(await loadImmutableTextArtifact('web', ref.sha256)).toBeNull();
    await expect(saveImmutableTextArtifact('web', 'content')).rejects.toThrow('immutable_conflict');
    expect(await wsOf('web', ref.relPath)).toBe('other-ws');
  });

  it('round-trips pinned security manifests and tuple ledgers through real canonical storage', async () => {
    const { createSecurityManifest, createSecurityTupleLedger, SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const { saveSecurityManifest, loadSecurityManifest, saveSecurityTupleLedger, loadSecurityTupleLedger } = await import('./coverage-census/security-manifest-store');
    const source = { revision: 'source-revision', sha256: 'a'.repeat(64) };
    const manifest = createSecurityManifest({ producer: 'producer', source, runtime: source,
      inputs: SECURITY_POPULATIONS.map(population => ({ id: population, population, source,
        surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) });
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'gui-installed', platform: 'linux', runtime: 'native', enforcementMode: 'strict', effect: 'process', channel: 'ipc' }));
    const ledger = createSecurityTupleLedger({ manifest, producer: 'producer', tuples,
      dispositions: tuples.map(tuple => ({ rowId: securityTupleId(tuple), applicability: 'notApplicable' as const,
        reason: 'Implementation-checker storage fixture only; no qualification claim', sourceRefs: ['fixture:storage'] })) });
    await expect(saveSecurityTupleLedger('web', ledger)).rejects.toThrow('manifest_missing');
    expect((await saveSecurityManifest('web', manifest)).sha256).toBe(manifest.sha256);
    expect(await loadSecurityManifest('web', manifest.sha256)).toEqual(manifest);
    expect((await saveSecurityTupleLedger('web', ledger)).sha256).toBe(ledger.sha256);
    expect(await loadSecurityTupleLedger('web', ledger.sha256)).toEqual(ledger);
    await expect(saveSecurityTupleLedger('web', { ...ledger, sha256: 'b'.repeat(64) })).rejects.toThrow('identity_mismatch');
    const changed = createSecurityManifest({ ...manifest.body, runtime: { ...source, sha256: 'c'.repeat(64) } });
    await saveSecurityManifest('web', changed);
    expect(await loadSecurityManifest('web', manifest.sha256)).toEqual(manifest);
    expect(await loadSecurityManifest('web', changed.sha256)).toEqual(changed);
  });

  it('archives a source shard with verified readback before persisting its lossless successor queue', async () => {
    const { createHash } = await import('node:crypto');
    const { gzipSync, gunzipSync } = await import('node:zlib');
    const { canonicalJson } = await import('@papercusp/hash-chain');
    const { prepareSecuritySourceShard } = await import('./coverage-census/security-source-census');
    const { loadSecuritySourceShard, saveSecuritySourceShard } = await import('./coverage-census/security-manifest-store');
    const bytes = Buffer.from('run();'), commit = 'a'.repeat(40);
    const file = { path: 'a.ts', repository: '.', commit, bytes,
      blobOid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
    const progress: SecuritySourceProgress = { schema: 'security-source-discovery-progress-v1', parentArchive: '1'.repeat(64),
      parentRawSha256: '2'.repeat(64), repositories: [{ path: '.', commit }], capturedShards: [],
      pending: ['a.ts', 'b.ts'].map(path => ({ path, commit, blobOid: file.blobOid, bytes: bytes.length, reason: 'source-byte-budget' })),
      closureAccepted: false, populationComplete: false };
    const shard = prepareSecuritySourceShard(progress, ['a.ts'], { sources: [file], repositories: progress.repositories, unresolved: [],
      selection: { paths: ['a.ts'], maxBytes: 1000, maxFiles: 1, bytesRead: bytes.length, filesRead: 1, populationComplete: false } });
    const saved = await saveSecuritySourceShard('web', progress, shard);
    const archive = JSON.parse((await loadImmutableTextArtifact('web', saved.archive.sha256))!);
    expect(JSON.parse(gunzipSync(Buffer.from(archive.data, 'base64')).toString())).toEqual(shard.discovery);
    expect(saved.receipt).toMatchObject({ readbackVerified: true, decodedVerified: true, files: 1 });
    expect(saved.progress.pending).toEqual([progress.pending[1]]);
    expect(await loadImmutableTextArtifact('web', saved.progressArchive.sha256)).toBe(canonicalJson(saved.progress));
    expect(await loadSecuritySourceShard('web', saved.progress, saved.archive.sha256)).toEqual(shard.discovery);
    // Historical archives used JSON.stringify and omitted progressSha256.
    // Verify exact byte hashes independently from canonical census identity.
    const legacyRaw = JSON.stringify(shard.discovery);
    const legacy = { ...archive, censusFingerprint: shard.discovery.fingerprint,
      parentRawSha256: progress.parentRawSha256, closureAccepted: false, executionAdmitted: false,
      rawSha256: createHash('sha256').update(legacyRaw).digest('hex'), rawBytes: Buffer.byteLength(legacyRaw),
      data: gzipSync(legacyRaw).toString('base64') };
    delete legacy.progressSha256;
    const legacySaved = await saveImmutableTextArtifact('web', JSON.stringify(legacy));
    const legacyProgress = structuredClone(saved.progress);
    legacyProgress.capturedShards[0] = { ...legacyProgress.capturedShards[0], sha256: legacySaved.sha256,
      rawSha256: legacy.rawSha256, rawBytes: legacy.rawBytes };
    expect(await loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256)).toEqual(shard.discovery);
    delete legacyProgress.capturedShards[0].consumedPaths;
    await expect(loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256)).rejects.toThrow('selection_mismatch');
    expect(await loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256, { expectedPaths: ['a.ts'] }))
      .toEqual(shard.discovery);
    await expect(loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256, { expectedPaths: ['b.ts'] }))
      .rejects.toThrow('selection_mismatch');
    expect(await loadSecuritySourceShard('absent-harness', saved.progress, saved.archive.sha256)).toBeNull();
    await expect(loadSecuritySourceShard('web', progress, saved.archive.sha256)).rejects.toThrow('not_in_progress');
    await expect(loadSecuritySourceShard('web', saved.progress, saved.archive.sha256, { maxRawBytes: 1 }))
      .rejects.toThrow('read_budget');
    const changedParent = structuredClone(saved.progress); changedParent.parentArchive = '4'.repeat(64);
    await expect(loadSecuritySourceShard('web', changedParent, saved.archive.sha256)).rejects.toThrow('identity_mismatch');
    const changedPins = structuredClone(saved.progress); changedPins.repositories.push({ path: 'new-repo', commit });
    await expect(loadSecuritySourceShard('web', changedPins, saved.archive.sha256)).rejects.toThrow('repository_substitution');
    const changedPaths = structuredClone(saved.progress); changedPaths.capturedShards[0].consumedPaths = ['b.ts'];
    await expect(loadSecuritySourceShard('web', changedPaths, saved.archive.sha256)).rejects.toThrow('selection_mismatch');
    const changedFingerprint = structuredClone(saved.progress); changedFingerprint.capturedShards[0].censusFingerprint = '5'.repeat(64);
    await expect(loadSecuritySourceShard('web', changedFingerprint, saved.archive.sha256)).rejects.toThrow('identity_mismatch');
    // Even a newly content-addressed outer envelope cannot substitute its
    // compressed bytes or inner digest under a retained census identity.
    for (const mutation of [{ rawSha256: '6'.repeat(64) }, { data: archive.data + '\n' }]) {
      const altered = { ...archive, ...mutation };
      const stored = await saveImmutableTextArtifact('web', canonicalJson(altered));
      const substituted = structuredClone(saved.progress);
      substituted.capturedShards[0] = { ...substituted.capturedShards[0], sha256: stored.sha256,
        rawSha256: altered.rawSha256 };
      await expect(loadSecuritySourceShard('web', substituted, stored.sha256)).rejects.toThrow();
    }
    expect((await saveSecuritySourceShard('web', progress, shard)).archive).toEqual(saved.archive);
    await expect(saveSecuritySourceShard('web', saved.progress, shard)).rejects.toThrow('stale_progress');
    const corrupted = structuredClone(shard); corrupted.discovery.sites = [];
    await expect(saveSecuritySourceShard('web', progress, corrupted)).rejects.toThrow('identity_mismatch');
  });

  it('save → load round-trips, null when absent', async () => {
    expect(await loadTextArtifact('web', 'notes.md')).toBeNull();
    await saveTextArtifact('web', 'notes.md', 'hello');
    expect(await loadTextArtifact('web', 'notes.md')).toBe('hello');
  });

  it('normalizes the `.papercusp/` prefix — a prefixed write and a bare read hit the same row', async () => {
    await saveTextArtifact('web', '.papercusp/memory/a.md', 'X');
    expect(await loadTextArtifact('web', 'memory/a.md')).toBe('X'); // bare read
    expect(await loadTextArtifact('web', '.papercusp/memory/a.md')).toBe('X'); // prefixed read, same row
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web'`).toHaveLength(1);
  });

  it('save upserts on (harness_slug, rel_path) — second write overwrites, one row', async () => {
    await saveTextArtifact('web', 'f.md', 'v1');
    await saveTextArtifact('web', 'f.md', 'v2');
    expect(await loadTextArtifact('web', 'f.md')).toBe('v2');
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web' AND rel_path='f.md'`).toHaveLength(1);
  });
  it('CAS has exactly one winner for concurrent create and stale-content update', async () => {
    const created = await Promise.all(['A', 'B'].map(value => compareAndSwapTextArtifact('web', 'cas.json', null, value)));
    expect(created.filter(Boolean)).toHaveLength(1);
    const old = await loadTextArtifact('web', 'cas.json');
    const updated = await Promise.all(['C', 'D'].map(value => compareAndSwapTextArtifact('web', '.papercusp/cas.json', old, value)));
    expect(updated.filter(Boolean)).toHaveLength(1);
    expect(await compareAndSwapTextArtifact('web', 'missing.json', 'absent', 'X')).toBe(false);
    expect(await loadTextArtifact('web', 'missing.json')).toBeNull();
  });
  it('CAS refuses a foreign workspace row and preserves its content', async () => {
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, workspace_id) VALUES ('web','foreign.json','old','other-ws')`;
    expect(await compareAndSwapTextArtifact('web', 'foreign.json', 'old', 'new')).toBe(false);
    expect(await loadTextArtifact('web', 'foreign.json')).toBe('old');
  });

  it('append ATOMICALLY concatenates via PG `content || EXCLUDED.content`', async () => {
    await appendTextArtifact('web', 'log.md', 'A'); // insert
    await appendTextArtifact('web', 'log.md', 'B'); // concat
    await appendTextArtifact('web', 'log.md', 'C');
    expect(await loadTextArtifact('web', 'log.md')).toBe('ABC');
  });

  it('delete removes the row', async () => {
    await saveTextArtifact('web', 'gone.md', 'x');
    await deleteTextArtifact('web', 'gone.md');
    expect(await loadTextArtifact('web', 'gone.md')).toBeNull();
  });

  it('EI-280: a save ADOPTS the active workspace onto a blank-stamped row, but does NOT re-home a stamped one', async () => {
    // blank legacy row → adopted
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','blank.md','old',1,'')`;
    await saveTextArtifact('web', 'blank.md', 'new');
    expect(await wsOf('web', 'blank.md')).toBe(WS); // adopted the operator workspace

    // properly-stamped row → left alone
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','owned.md','old',1,'other-ws')`;
    await saveTextArtifact('web', 'owned.md', 'new');
    expect(await wsOf('web', 'owned.md')).toBe('other-ws'); // NOT re-homed to WS
  });
});

describe('preparation ledger with canonical PG artifacts and real fixture descriptors', () => {
  let root: string;
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const options = { attemptId: 'fixture-attempt', candidate: 'fixture-candidate', clockId: 'fixture-boot', baseline: ['known.ts'] };
  const store = () => createArtifactPreparationStore({ slug: 'web', relPath: 'method/fixture-ledger.json',
    loadTextArtifact, compareAndSwapTextArtifact });
  const manifest = (text = 'abc') => ({ candidate: options.candidate, inputs: { 'known.ts': digest(text) } });
  beforeEach(async () => {
    root = await actualFs.realpath(await actualFs.mkdtemp(join(tmpdir(), 'preparation-fixture-')));
    await actualFs.writeFile(join(root, 'known.ts'), 'abc');
  });
  afterEach(async () => { await actualFs.rm(root, { recursive: true, force: true }); });
  it('restarts from PG and debits actual repeated file reads across adapter instances', async () => {
    const config = { ...options, maxBytes: 6 };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect((await first.read('known.ts')).data.toString()).toBe('abc');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await resumed.read('known.ts');
    await expect(resumed.read('known.ts')).rejects.toThrow('byte-limit');
    const stopped = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect(stopped.report()).toMatchObject({ status: 'STOPPED', bytesRead: 6, executionAdmitted: false });
    await expect(stopped.read('known.ts')).rejects.toThrow('byte-limit');
  });
  it('blocks stale real-store openers before filesystem access', async () => {
    const first = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    const stale = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await first.read('known.ts');
    await actualFs.rm(root, { recursive: true });
    await expect(stale.read('known.ts')).rejects.toThrow('attempt-state-conflict');
  });
  it('persists input61 refusal and never reaches a removed fixture root, even after restart', async () => {
    const config = { ...options, priorAdditions: Array.from({ length: 60 }, (_, i) => `prefix/${i}`) };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await actualFs.rm(root, { recursive: true });
    await expect(first.read('input61.ts')).rejects.toThrow('input-limit');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await expect(resumed.read('known.ts')).rejects.toThrow('input-limit');
    expect(resumed.snapshot().bytesRead).toBe(0);
  });
  it('rejects candidate, root and input-manifest changes instead of resetting a persisted attempt', async () => {
    await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), candidate: 'other' } })).rejects.toThrow('candidate-source-binding');
    await expect(openBoundPreparationLedger(options, { store: store(), root: root + '-other', manifest: manifest() })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: manifest('xyz') })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger({ ...options, attemptId: 'fresh-counter' }, { store: store(), root, manifest: manifest() })).rejects.toThrow('attempt-artifact-binding');
  });
  it('refuses missing input pins and records a terminal stop before reading the file', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), inputs: {} } });
    await expect(ledger.read('known.ts')).rejects.toThrow('candidate-input-unbound');
    expect(ledger.snapshot().bytesRead).toBe(0);
    expect((await store().load(options.attemptId))?.snapshot.status).toBe('STOPPED');
  });
  it('refuses a symlink alias to bytes with the correct digest before any payload read', async () => {
    await actualFs.symlink('known.ts', join(root, 'alias.ts'));
    const ledger = await openBoundPreparationLedger(options, { store: store(), root,
      manifest: { ...manifest(), inputs: { 'alias.ts': digest('abc') } } });
    await expect(ledger.read('alias.ts')).rejects.toThrow('input-path-alias');
    expect(ledger.snapshot().bytesRead).toBe(0);
  });
  it('charges real bytes and retains terminal failure when candidate content drifts', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await actualFs.writeFile(join(root, 'known.ts'), 'xyz');
    await expect(ledger.read('known.ts')).rejects.toThrow('input-digest-drift');
    expect(ledger.snapshot()).toMatchObject({ bytesRead: 3, status: 'STOPPED' });
  });
});
