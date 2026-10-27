/**
 * D300/D301 independent seed-population oracle, WI-6554700010020476.
 * Real temporary signed Hypercores and the normal exporter/provider. PG and
 * custody are private synthetic unit originals, never a physical seed receipt.
 */
import Corestore from 'corestore';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeHlc } from '@papercusp/locks-core';
import type { SeedManifest } from '@papercusp/seed-bundle';
import { canonicalJson, signAuthorityRpc, verifyAuthorityRpc } from '../../../../packages/operator-core/lib/authority/authority-rpc-envelope';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../../../packages/operator-core/lib/identity/ed25519';
import { openOwnLog, type PeerLogOp } from '../../../../packages/operator-core/lib/sync/hyperbee/peer-log';
import { loadSodium, encodeOpAAD } from '../../../../packages/operator-core/lib/sync/hyperbee/hive-epoch-aead';
import {
  buildSnapshotChunkOp, foldFilteredSnapshotRows,
  produceLogSnapshot, type SnapshotRow,
} from '../../../../packages/operator-core/lib/sync/hyperbee/log-snapshot';
import {
  createCorestoreSeedProvider, exportSeedUuidIdempotencySource, SEED_EXCLUDED_TABLES,
  seedSnapshotValueTransform, type SeedFrozenExecution,
} from '../../../../packages/operator-core/lib/sync/hyperbee/seed-provider-corestore';
import { readCoreProjectedFrom } from '../../../../packages/operator-core/lib/sync/hyperbee/seed-projection-meta';
import { judgeSeedPayloadIntegrity } from './seed-payload-integrity-guard';
import * as consumer from './p2p-candidate-evidence';

type Data = Record<string, any>; // Mutable adversarial unit data, never a trust type.
interface Raw { ref: string; bytesBase64: string; sha256: string }
interface LocalCore {
  readonly length: number;
  ready(): Promise<void>;
  get(index: number, options?: { wait: boolean }): Promise<PeerLogOp | null>;
}
interface Report { ok: boolean; checks: Array<{ id: string; status: string; detail: string }> }
interface Fixture {
  input: Data;
  deps: { resolveCustody(subject: Data): Data | null; resolveOriginal(ref: string): Raw | null };
  originals: Map<string, Raw>;
  custody: Data;
  sourceRows: SnapshotRow[];
  restoredRows: SnapshotRow[];
  sourceStore: Corestore;
  rebind(): Promise<void>;
  resignPg(): Promise<void>;
  replaceRestored(rows: SnapshotRow[], torn?: boolean): Promise<void>;
}
const PLAN = 'p2p-public-release-endgame-2026-09-01';
const WORKSPACE = 'private-seed-population-workspace';
const HARNESS = 'papercusp';
const SOURCE = 'cbd21646b5c73bd23cad5608f9526cf9bd0048ce';
const AT = Date.parse('2026-10-23T08:00:00Z');
// Independent PG population: never derive these from the log or exported rows.
const WORK = 'papercusp/WI-900001';
const OBSERVATION = 'papercusp/EI-900002';
const LIVE_RECEIPT = 'papercusp/EI-900003';
const DEAD_RECEIPT = 'papercusp/EI-900004';
const CONCURRENT_RECEIPT = 'papercusp/EI-900005';
const LIVE_KEYS = [WORK, OBSERVATION, LIVE_RECEIPT];
const LITERALS = ['private-seed-fixture-author'];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const without = (value: Data, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const decoded = (raw: Raw): Data => JSON.parse(Buffer.from(raw.bytesBase64, 'base64').toString('utf8'));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function directory(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `p521-seed-${label}-`));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function store(label: string) {
  const s = new Corestore(directory(label));
  cleanups.push(() => s.close());
  await s.ready();
  return s;
}
function execution(): SeedFrozenExecution {
  // As in cut-seed-cli.test.ts's transport fixture, this is a complete synthetic
  // frozen execution record. It is resolved independently from caller fields.
  // Nothing here registers a real execution or asserts an installed candidate.
  const installedPackages = ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal']
    .map(name => ({ path: `node_modules/${name}`, name, version: '1.0.0' }));
  return { sourceCommit: SOURCE, gitDirty: false, nodeVersion: process.version,
    dependencyInputSha256: sha('private-dependency-input'), installedPackages,
    installedPackagesSha256: sha(JSON.stringify(installedPackages)),
    dependencyGeneration: `v1-${sha('private-dependency-generation')}`,
    dependencyGenerationSnapshotSha256: sha('private-generation-snapshot'),
    materializedTreesSha256: sha('private-materialized-trees'),
    excludedEntries: [], excludedEntryCount: 0,
    loadedModulePaths: ['packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts'],
    securityPackages: installedPackages.map(row => ({ ...row, resolved: `https://registry.npmjs.org/${row.name}/-/fixture.tgz`,
      integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
      files: [{ path: 'package.json', sha256: sha(`private-package-${row.name}`) }] })),
    directBlobs: ['packages/operator-core/lib/sync/hyperbee/read-merge.ts',
      'packages/operator-core/lib/sync/hyperbee/log-snapshot.ts',
      'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts', 'apps/operator/lib/release/cut-seed-cli.ts',
      'packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts',
      'packages/operator-core/lib/sync/hyperbee/hive-epoch-aead.ts',
      'apps/operator/bin/release/dependency-generation.sh', 'scripts/check-lockfile-census.mjs',
      'packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs']
      .map(path => ({ path, sha256: sha(`private-source:${SOURCE}:${path}`) })) };
}
async function fixture(options: { omitObservation?: boolean; privacyConflict?: boolean } = {}): Promise<Fixture> {
  const sourceStore = await store('source');
  const own = await openOwnLog(sourceStore);
  const signer = generateEd25519KeypairDer();
  const sourceHost = { schemaVersion: 'hive-git-physical-host-identity/v1', hostId: 'private-source-host',
    deviceKey: signer.pubkeyBase64, keychainId: '9000:private-fixture', githubUserId: 9000,
    githubLogin: 'private-fixture', machineFingerprint: sha('private-source-host') };
  let sequence = 0;
  const originals = new Map<string, Raw>();
  const raw = (label: string, value: unknown): Raw => {
    const bytes = canonicalJson(value);
    const r = { ref: `fixture:seed:${label}:${sequence++}`, bytesBase64: Buffer.from(bytes).toString('base64'), sha256: sha(bytes) };
    originals.set(r.ref, structuredClone(r));
    return r;
  };
  const op = (table: string, hbKey: string, value: unknown, extra: Partial<PeerLogOp> = {}): PeerLogOp => ({
    type: 'put', table, hbKey, value, author_pubkey: signer.pubkeyBase64,
    ts: AT - 1000, hlc: encodeHlc({ ms: AT - 1000, count: 0 }), schema_version: 1, ...extra,
  });
  const receipt = (key: string) => op('engineer-issues', key,
    { issue_id: key.split('/')[1], scope: 'harness:papercusp', payload: { resource_governor: { privateFixture: key } } });
  const sodium = await loadSodium();
  const key = Buffer.alloc(32, 8), nonce = Buffer.alloc(24, 9);
  const plaintext = Buffer.from(JSON.stringify({ payload: { resource_governor: { encrypted: true } } }));
  const ciphertext = Buffer.alloc(plaintext.length + 16);
  const opId = sha(JSON.stringify(['engineer-issues', 'papercusp/EI-900006', signer.pubkeyBase64]));
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, plaintext,
    encodeOpAAD({ potId: 'private-seed-hive', epoch: 7, opId }), null, nonce, key);
  const originalOps = [op('engineer-issues', WORK, { issue_id: 'WI-900001', title: 'ordinary work', lane: 'work',
    ...(options.privacyConflict ? { body: LITERALS[0] } : {}) }),
  ...(!options.omitObservation ? [op('engineer-issues', OBSERVATION,
    { issue_id: 'EI-900002', title: 'observation', lane: 'observation' })] : []),
  op('coord-messages', 'private-message', { body: 'coordination is retained' }),
  op('hive-members', '9000', { github_username: LITERALS[0], role: 'member' }),
  receipt(LIVE_RECEIPT), receipt(DEAD_RECEIPT),
  op('engineer-issues', 'papercusp/EI-900006', { __rekey: Buffer.concat([nonce, ciphertext]).toString('base64') }, { epoch: 7 }),
  op('harness_plans', 'tombstone', undefined, { type: 'del' }),
  op('presence', 'ephemeral-presence', { online: true })];
  await own.appendBatch(originalOps);
  // The same pre-census boundary controls canonical receipt pruning. A receipt
  // added later is intentionally absent from PG and must survive in the tail.
  const boundary = own.length;
  await produceLogSnapshot(own, { now: AT, schemaVersion: 1, maxChunkBytes: 220,
    governorReceiptFilter: { maxSourceIndexExclusive: boundary, liveQualifiedKeys: [LIVE_RECEIPT] } });
  await own.append(receipt(CONCURRENT_RECEIPT));
  const exportDir = directory('private-export');
  const exported = await exportSeedUuidIdempotencySource({ sourceStore, sourceKeyHex: own.keyHex,
    sourceLength: own.length, outputDir: exportDir, segment: 'segment-000001.blob', now: AT,
    redactValues: LITERALS, executionBinding: execution() });
  const sourceCore = sourceStore.get({ key: Buffer.from(own.keyHex, 'hex'), valueEncoding: 'json' }) as LocalCore;
  await sourceCore.ready();
  const sourceRows = (await foldFilteredSnapshotRows(own, { now: AT, excludeTables: SEED_EXCLUDED_TABLES,
    requireComplete: true })).rows;
  const provider = createCorestoreSeedProvider();
  const cut = await provider.cut({ sourceStore, coreKeys: [own.keyHex], stagingDir: directory('payload'),
    filtered: true, redactValues: LITERALS, onProjection: () => {} } as never);
  const targetDir = directory('restored');
  await provider.restore(cut.entry, cut.payload, { targetStoreDir: targetDir });
  const restoredStore = new Corestore(targetDir); cleanups.push(() => restoredStore.close()); await restoredStore.ready();
  const restoredKeyHex = (cut.entry.meta!.coreKeys as string[])[0]!;
  const restoredCore = restoredStore.get({ key: Buffer.from(restoredKeyHex, 'hex'), valueEncoding: 'json' }) as LocalCore;
  await restoredCore.ready();
  const restoredRows = (await foldFilteredSnapshotRows({ length: restoredCore.length,
    get: index => restoredCore.get(index, { wait: false }) }, { now: AT, requireComplete: true })).rows;
  const manifest: SeedManifest = { seedFormatVersion: 1, potId: 'private-seed-hive', cutAtEpoch: 7,
    cutHlc: encodeHlc({ ms: AT, count: 0 }), cutTs: AT, stores: [cut.entry] };
  const manifestBytes = raw('manifest.json', manifest);
  const subject = { sourceSha: SOURCE, artifactDigest: sha('private-candidate'), installerSha256: sha('private-installer'),
    runtimeSha256: sha('private-runtime'), seedSha256: manifestBytes.sha256, builtAtMs: AT - 10_000 };
  // Independent literal query population includes the observation even when
  // options.omitObservation removes it from BOTH actual signed cores.
  const pgData = { workspaceId: WORKSPACE, harnessSlug: HARNESS, snapshotId: 'private-repeatable-read-1',
    capturedAtMs: AT - 500, maxSourceIndexExclusive: boundary, liveWorkItemKeys: [...LIVE_KEYS], liveGovernorQualifiedKeys: [LIVE_RECEIPT] };
  const pgRaw = raw('pg-original', { ...pgData, transaction: { isolation: 'repeatable read', readOnly: true, exitCode: 0,
    query: 'SELECT harness_slug, feature_id, payload FROM harness_shared.work_items WHERE workspace_id = $1 ORDER BY harness_slug, feature_id',
    parameters: [WORKSPACE], rows: LIVE_KEYS.map(qualified => ({ harness_slug: HARNESS, feature_id: qualified.split('/')[1],
      payload: qualified === LIVE_RECEIPT ? { resource_governor: {} } : {}, lane: qualified === OBSERVATION ? 'observation' : 'work' })) } });
  const input: Data = { subject, source: exported, sourceCore, restoredCore, restoredKeyHex,
    payload: { manifest, dir: (cut.payload as { path: string }).path, origin: 'fresh' }, manifestBytes,
    pg: { ...pgData, raw: pgRaw }, privacy: { literals: [...LITERALS] }, custody: null };
  let custody: Data;
  async function resignPg() {
    input.pg.auth = await signAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-seed-pg-census/v1',
      payload: without(input.pg, 'auth'), device_pubkey: signer.pubkeyBase64 },
    async bytes => signWithPrivateKeyDer(signer.privateKeyDer, bytes), { nowMs: input.pg.capturedAtMs, nonce: `pg-${sequence++}` });
  }
  async function rebind() {
    input.manifestBytes = raw('manifest.json', input.payload.manifest);
    input.subject.seedSha256 = input.manifestBytes.sha256;
    custody = { subject: structuredClone(input.subject), workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN,
      sourceHost, cutWindow: { startMs: AT - 1000, endMs: AT + 1000 },
      executionBinding: execution(), privacy: { literals: [...LITERALS] },
      sourceHead: structuredClone(exported.sourceInput.sourceHead),
      originalInventory: [...originals.values()].map(({ ref, sha256 }) => ({ ref, sha256 })) };
    input.custody = raw('custody', custody);
  }
  await resignPg(); await rebind();
  const deps = {
    resolveCustody: (supplied: Data) => canonicalJson(supplied) === canonicalJson(input.subject) ? structuredClone(custody) : null,
    resolveOriginal: (ref: string) => { const value = originals.get(ref); return value ? structuredClone(value) : null; },
  };
  async function replaceRestored(rows: SnapshotRow[], torn = false) {
    // A malicious producer can sign altered rows and ship a hash-valid payload.
    // Use the normal provider to restore those exact bytes, then claim their
    // projection mapping. The verifier must compare their population/metadata.
    const malicious = await store('signed-counterexample'); const log = await openOwnLog(malicious);
    await log.append(buildSnapshotChunkOp({ rows, coversUpTo: 0, chunkIdx: 0, chunkCount: torn ? 2 : 1,
      author_pubkey: log.keyHex, ts: AT, schema_version: 1 }));
    const replacement = await provider.cut({ sourceStore: malicious, coreKeys: [log.keyHex], stagingDir: directory('bad-payload') });
    const dir = directory('bad-restored'); await provider.restore(replacement.entry, replacement.payload, { targetStoreDir: dir });
    const s = new Corestore(dir); cleanups.push(() => s.close()); await s.ready();
    const c = s.get({ key: Buffer.from(log.keyHex, 'hex'), valueEncoding: 'json' }) as LocalCore; await c.ready();
    input.restoredCore = c; input.restoredKeyHex = log.keyHex;
    input.payload = { origin: 'fresh', dir: (replacement.payload as { path: string }).path,
      manifest: { ...manifest, stores: [{ ...replacement.entry, meta: { ...replacement.entry.meta,
        coreProjectedFrom: { [log.keyHex]: own.keyHex } } }] } };
    await rebind();
  }
  return { input, deps, originals, get custody() { return custody; }, sourceRows, restoredRows, sourceStore,
    rebind, resignPg, replaceRestored };
}

async function evaluate(f: Fixture): Promise<Report> {
  const verifier: unknown = Reflect.get(consumer, 'verifyP521SeedPopulation');
  expect(verifier, 'D300 requires the maintained seed population verifier').toBeTypeOf('function');
  return (verifier as (input: Data, deps: Fixture['deps']) => Promise<Report>)(f.input, f.deps);
}
async function rejected(f: Fixture) {
  const report = await evaluate(f);
  expect(report.ok).toBe(false);
  expect(report.checks.filter(check => check.id === 'P-521:seed-population')).toHaveLength(1);
  const check = report.checks.find(check => check.id === 'P-521:seed-population')!;
  expect(check.status).not.toBe('pass'); expect(check.detail.trim()).not.toBe('');
}
describe('D300 actual signed source/restore population', () => {
  it('fixture control: verifies normal payload, independent census signature, metadata and real multi-chunk snapshot plus tail', async () => {
    const f = await fixture(); const i = f.input;
    expect(await judgeSeedPayloadIntegrity(i.payload)).toMatchObject({ ok: true });
    expect(i.subject.seedSha256).toBe(sha(Buffer.from(i.manifestBytes.bytesBase64, 'base64')));
    expect(verifyAuthorityRpc({ harnessSlug: HARNESS, kind: 'p521-seed-pg-census/v1', payload: without(i.pg, 'auth') },
      i.pg.auth, { nowMs: i.pg.capturedAtMs })).toBe(true);
    expect(i.pg.auth.device_pubkey).toBe(f.custody.sourceHost.deviceKey);
    expect(readCoreProjectedFrom(i.payload.manifest.stores[0].meta)).toEqual({ [i.restoredKeyHex]: i.source.sourceKeyHex });
    expect(i.source.sourceInput.chunkCount).toBeGreaterThan(1);
    expect(i.source.sourceInput.sourceBlocksRead).toBe(i.source.sourceInput.chunkCount + 1);
    const expected = await foldFilteredSnapshotRows({ length: i.sourceCore.length,
      get: index => i.sourceCore.get(index, { wait: false }) }, { now: AT, requireComplete: true,
      excludeTables: SEED_EXCLUDED_TABLES, transformValue: seedSnapshotValueTransform(LITERALS).transform });
    expect(f.restoredRows).toEqual(expected.rows);
    const keys = f.restoredRows.map(row => row.hbKey);
    expect(keys).toEqual(expect.arrayContaining([...LIVE_KEYS, CONCURRENT_RECEIPT, 'papercusp/EI-900006', 'private-message', 'tombstone']));
    expect(keys).not.toContain(DEAD_RECEIPT); expect(keys).not.toContain('ephemeral-presence');
    expect(f.restoredRows.find(row => row.hbKey === 'tombstone')).toMatchObject({ value: null, deleted: true });
    expect(f.restoredRows.find(row => row.hbKey === 'papercusp/EI-900006')).toMatchObject({ epoch: 7, author_pubkey: f.custody.sourceHost.deviceKey });
    expect(canonicalJson(f.restoredRows)).not.toContain(LITERALS[0]);
  });
  it('accepts the complete independent PG population and exact approved projection', async () => {
    const report = await evaluate(await fixture());
    expect(report.ok).toBe(true);
    expect(report.checks.find(check => check.id === 'P-521:seed-population')).toMatchObject({ status: 'pass' });
  });
  it('refuses source and seed agreeing to omit the independently PG-listed observation', async () => {
    const f = await fixture({ omitObservation: true });
    expect(f.sourceRows.some(row => row.hbKey === OBSERVATION)).toBe(false);
    expect(f.restoredRows.some(row => row.hbKey === OBSERVATION)).toBe(false);
    expect(f.input.pg.liveWorkItemKeys).toContain(OBSERVATION);
    await rejected(f);
  });
  it('refuses privacy DROP of a live PG work item', async () => {
    const f = await fixture({ privacyConflict: true });
    expect(f.sourceRows.some(row => row.hbKey === WORK)).toBe(true);
    expect(f.restoredRows.some(row => row.hbKey === WORK)).toBe(false);
    await rejected(f);
  });
  it.each(['missing', 'extra', 'duplicate', 'hlc', 'author', 'epoch', 'value', 'tombstone', 'unopened-ciphertext', 'concurrent-receipt', 'torn-chunk'])(
    'refuses a hash-valid signed restored population corruption: %s', async defect => {
      const f = await fixture(); const rows = structuredClone(f.restoredRows);
      const work = rows.find(row => row.hbKey === WORK)!;
      if (defect === 'missing') rows.splice(rows.indexOf(work), 1);
      if (defect === 'extra') rows.push({ ...work, hbKey: 'unapproved-extra' });
      if (defect === 'duplicate') rows.push(structuredClone(work));
      if (defect === 'hlc') work.hlc = encodeHlc({ ms: AT + 1, count: 1 });
      if (defect === 'author') work.author_pubkey = generateEd25519KeypairDer().pubkeyBase64;
      if (defect === 'epoch') work.epoch = 99;
      if (defect === 'value') work.value = { changed: true };
      if (defect === 'tombstone') delete rows.find(row => row.hbKey === 'tombstone')!.deleted;
      if (defect === 'unopened-ciphertext') rows.splice(rows.findIndex(row => row.hbKey === 'papercusp/EI-900006'), 1);
      if (defect === 'concurrent-receipt') rows.splice(rows.findIndex(row => row.hbKey === CONCURRENT_RECEIPT), 1);
      await f.replaceRestored(rows, defect === 'torn-chunk');
      expect(await judgeSeedPayloadIntegrity(f.input.payload)).toMatchObject({ ok: true });
      await rejected(f);
    });
  it.each(['head', 'head-signature', 'proof-inventory', 'span-hash', 'row-hash', 'winners', 'coverage', 'source-read-count', 'projected-from', 'manifest-hash'])(
    'refuses forged original source or manifest binding: %s', async defect => {
      const f = await fixture(); const i = f.input;
      if (defect === 'head') i.source.sourceInput.sourceHead.treeHash = '00'.repeat(32);
      if (defect === 'head-signature') i.source.sourceInput.sourceHead.signatureHex = '00'.repeat(64);
      if (defect === 'proof-inventory') i.source.sourceInput.proofInventorySha256 = '00'.repeat(32);
      if (defect === 'span-hash') i.source.sourceInput.sourceBlocksJsonSha256 = '00'.repeat(32);
      if (defect === 'row-hash') i.source.rowsSha256 = '00'.repeat(32);
      if (defect === 'winners') i.source.sourceInput.winners.pop();
      if (defect === 'coverage') i.source.sourceInput.chunkCount++;
      if (defect === 'source-read-count') i.source.sourceInput.sourceBlocksRead++;
      if (defect === 'projected-from') i.payload.manifest.stores[0].meta.coreProjectedFrom[i.restoredKeyHex] = '00'.repeat(32);
      if (defect === 'manifest-hash') i.subject.seedSha256 = '00'.repeat(32);
      await rejected(f);
    });
  it.each(['workspace', 'harness', 'boundary', 'time', 'raw-census', 'missing-live-key', 'foreign-signer', 'missing-custody', 'caller-custody',
    'missing-execution', 'dirty-execution', 'stale-execution', 'direct-blobs', 'security-inventory', 'dependency-generation',
    'privacy-literals', 'privacy-context', 'private-plan', 'custody-original', 'pg-original', 'manifest-original'])(
    'refuses an unauthenticated or stale census/execution input: %s', async defect => {
      const f = await fixture(); const i = f.input;
      if (defect === 'workspace') i.pg.workspaceId = 'foreign-workspace';
      if (defect === 'harness') i.pg.harnessSlug = 'foreign-harness';
      if (defect === 'boundary') i.pg.maxSourceIndexExclusive = i.sourceCore.length + 1;
      if (defect === 'time') i.pg.capturedAtMs += 3_600_000;
      if (defect === 'raw-census') { const value = decoded(i.pg.raw); value.liveWorkItemKeys.pop(); i.pg.raw = { ...i.pg.raw,
        bytesBase64: Buffer.from(canonicalJson(value)).toString('base64'), sha256: sha(canonicalJson(value)) }; }
      if (defect === 'missing-live-key') i.pg.liveWorkItemKeys = [WORK, LIVE_RECEIPT];
      // Re-sign semantic corruptions: a signature-only validator must miss them.
      if (['workspace', 'harness', 'boundary', 'time', 'raw-census', 'missing-live-key'].includes(defect)) await f.resignPg();
      if (defect === 'foreign-signer') { const key = generateEd25519KeypairDer(); i.pg.auth = await signAuthorityRpc({
        harnessSlug: HARNESS, kind: 'p521-seed-pg-census/v1', payload: without(i.pg, 'auth'), device_pubkey: key.pubkeyBase64 },
      async bytes => signWithPrivateKeyDer(key.privateKeyDer, bytes), { nowMs: i.pg.capturedAtMs, nonce: 'foreign-source' }); }
      if (defect === 'missing-custody') f.deps.resolveCustody = () => null;
      if (defect === 'caller-custody') { const value = decoded(i.custody); value.sourceHost.deviceKey = i.pg.auth.device_pubkey;
        value.sourceHost.machineFingerprint = sha('foreign-machine'); i.custody = { ...i.custody,
          bytesBase64: Buffer.from(canonicalJson(value)).toString('base64'), sha256: sha(canonicalJson(value)) }; }
      if (defect === 'stale-execution') i.source.sourceInput.executionBinding.sourceCommit = 'a'.repeat(40);
      if (defect === 'missing-execution') delete i.source.sourceInput.executionBinding;
      if (defect === 'dirty-execution') i.source.sourceInput.executionBinding.gitDirty = true;
      if (defect === 'direct-blobs') i.source.sourceInput.executionBinding.directBlobs.pop();
      if (defect === 'security-inventory') i.source.sourceInput.executionBinding.securityPackages.pop();
      if (defect === 'dependency-generation') i.source.sourceInput.executionBinding.dependencyGenerationSnapshotSha256 = '00'.repeat(32);
      if (defect === 'privacy-literals') i.privacy.literals.push('unadmitted-literal');
      if (defect === 'privacy-context') i.source.privacyProjectionContext.literalsSha256 = '00'.repeat(32);
      if (defect === 'private-plan') i.privacy.uuidDropPlan = { schema: 'papercusp-uuid-idempotency-row-drop-plan-v1',
        reviewRef: `${PLAN}#D-166`, sourceKeyHex: '00'.repeat(32), sourceLength: i.sourceCore.length, rows: [] };
      if (defect === 'custody-original') f.originals.delete(i.custody.ref);
      if (defect === 'pg-original') f.originals.delete(i.pg.raw.ref);
      if (defect === 'manifest-original') f.originals.delete(i.manifestBytes.ref);
      await rejected(f);
    });
  it.each(['source', 'restored'])('refuses a signed %s core whose proof cannot be read', async kind => {
    const f = await fixture(); vi.spyOn(f.input[kind === 'source' ? 'sourceCore' : 'restoredCore'], 'proof')
      .mockRejectedValue(new Error('private fixture block read failed'));
    await rejected(f);
  });
});
