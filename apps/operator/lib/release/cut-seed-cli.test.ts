/**
 * cut-seed-cli.test.ts — the git-seal key-selection branch of the seed cutter CLI
 * (plan hive-seed-bundle-2026-07-04 P-010 live-wire 2 completion). Pure: `deriveEpochKey`
 * is injected, so the correctness-critical branch (which keyRef + key seals the git
 * bundle) is verified with no keychain / native crypto / real hive. The full cut (git +
 * corestore I/O + real deriveEpochKey on the owner keychain) is owner-box/build-dependent
 * and out of scope for a headless unit test — only the branch selection is tested here.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, cp, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertStagedSeedCarriesNoIdentity } from './seed-identity-guard.js';
import Corestore from 'corestore';
import { openOwnLog } from '@papercusp/operator-core/lib/sync/hyperbee/peer-log';
import { cutHiveSeed } from '@papercusp/operator-core/lib/sync/hyperbee/seed-cutter';
import { SEED_EXCLUDED_TABLES } from '@papercusp/operator-core/lib/sync/hyperbee/seed-excluded-tables';
import { shouldDropGovernorReceiptSnapshotRow } from '@papercusp/operator-core/lib/sync/hyperbee/governor-receipt-snapshot-filter';
import type { produceLogSnapshot } from '@papercusp/operator-core/lib/sync/hyperbee/log-snapshot';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseGitDepth,
  parseHeadSnapshotTimeoutMs,
  pickGitEncryption,
  assertEpochSealIdentityPresent,
  assertShippingCutDbTarget,
  resolveUuidIdempotencyDropPlanInput,
  encodeEpochKeysFile,
  collectSeedEpochKeys,
  graftCorestoreEntry,
  refreshCorestoreStateForSeed,
  withCutSeedSingleton,
  readReusableCorestore,
  isCorestoreLockedError,
  waitForOperatorDrain,
  openSourceStoreForCut,
  isTransientStoreOpenError,
  HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS,
  RO_OPEN_RETRY_ATTEMPTS,
  CUT_SEED_DRAIN_STALL_MS,
  mergeReleaseSeedRedactionValues,
  resolveReleaseSeedRedactionValuesForCut,
  deriveSourceStoreDirs,
  createFilteredSeedProgressReporter,
  withSeedOutput,
  readSeedFindingRedactions,
  readSeedUuidIdempotencyDropPlans,
  exportSeedUuidIdempotencyCensus,
} from "./cut-seed-cli";

function spawnCutSeedCli(args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  // test:file runs under committed-source-loader. Keep that loader in the child, but force the
  // TypeScript CLI through its ESM path: tsx otherwise classifies this CommonJS-package .ts file
  // as CJS and the source guard correctly refuses tsx's transformed Module._compile input.
  const cliPath = fileURLToPath(new URL('./cut-seed-cli.ts', import.meta.url));
  const cliUrl = pathToFileURL(cliPath).href;
  const esmTypeScriptResolver = [
    'export async function resolve(specifier, context, nextResolve) {',
    '  const resolved = await nextResolve(specifier, context);',
    '  if (resolved.url.startsWith("file:") &&',
    '      (new URL(resolved.url).pathname.endsWith(".ts") || new URL(resolved.url).pathname.endsWith(".tsx")) &&',
    '      !resolved.url.includes("/node_modules/"))',
    '    return { ...resolved, format: "module-typescript" };',
    '  return resolved;',
    '}',
  ].join('\n');
  const bootstrap = [
    'import { register } from "node:module";',
    `register("data:text/javascript," + encodeURIComponent(${JSON.stringify(esmTypeScriptResolver)}), import.meta.url);`,
    `process.argv = [process.execPath, ${JSON.stringify(cliPath)}, ...${JSON.stringify(args)}];`,
    `await import(${JSON.stringify(cliUrl)});`,
  ].join('\n');
  const env = options.env ? { ...options.env } : { ...process.env };
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap], {
    encoding: 'utf8', ...options, env,
  });
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return result;
}

describe('D166 private row-drop plan transport', () => {
  const installedPackages = ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal'].sort()
    .map(name => ({ path: `node_modules/${name}`, name, version: '1.0.0' }));
  const execution = { sourceCommit: 'a'.repeat(40), gitDirty: false as const, nodeVersion: process.version,
    dependencyInputSha256: 'b'.repeat(64), installedPackagesSha256: createHash('sha256').update(JSON.stringify(installedPackages)).digest('hex'),
    dependencyGeneration: `v1-${'d'.repeat(64)}`, installedPackages,
    excludedEntries: [], excludedEntryCount: 0,
    loadedModulePaths: ['packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts'],
    dependencyGenerationSnapshotSha256: 'f'.repeat(64), materializedTreesSha256: '1'.repeat(64),
    securityPackages: ['hypercore', 'hyperbee', 'hypercore-crypto', 'sodium-native', 'sodium-universal'].map(name => ({
      path: `node_modules/${name}`, name, version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/package.tgz`,
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64'), files: [{ path: 'package.json', sha256: '2'.repeat(64) }] })),
    directBlobs: ['packages/operator-core/lib/sync/hyperbee/read-merge.ts',
      'packages/operator-core/lib/sync/hyperbee/log-snapshot.ts',
      'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts', 'apps/operator/lib/release/cut-seed-cli.ts',
      'packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts',
      'packages/operator-core/lib/sync/hyperbee/hive-epoch-aead.ts',
      'apps/operator/bin/release/dependency-generation.sh', 'scripts/check-lockfile-census.mjs',
      'packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs']
      .map(path => ({ path, sha256: 'e'.repeat(64) })) };
  const deps = { readFrozenExecution: async () => execution };
  it('exports the actual frozen manifest population read-only and refuses changed source identities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uuid-frozen-export-'));
    const store = new Corestore(join(dir, 'source'));
    try {
      await store.ready();
      const own = await openOwnLog(store);
      await own.append({ type: 'put', table: 'harness_plans', hbKey: 'row', value: { public: 'unchanged' },
        ts: 1, schema_version: 1, author_pubkey: '' });
      await own.append({ type: 'put', table: 'harness_plans', hbKey: 'z-private', value: { body: 'private-fixture-owner' },
        ts: 2, schema_version: 1, author_pubkey: '' });
      const seed = await cutHiveSeed({ potId: 'fixture-pot', cutAtEpoch: 0, cutHlc: '0', cutTs: 1,
        outDir: join(dir, 'seed'), git: null, corestore: { sourceStore: store, coreKeys: [own.keyHex] } });
      const censusDir = join(dir, 'census'); await mkdir(censusDir, { mode: 0o700 });
      const manifestBytes = await readFile(seed.manifestPath);
      const inputs = { storeDir: join(dir, 'seed', 'corestore'), manifestPath: seed.manifestPath,
        manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
        epochKeysPath: join(dir, 'unused-private-keys.json'), epochKeysSha256: 'b'.repeat(64), outputDir: censusDir,
        redactValues: ['private-fixture-owner'] };
      // Real Hypercore/manifest path; only the checkout/dependency environment is a fixture.
      const configPath = await exportSeedUuidIdempotencyCensus(inputs, deps);
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      expect(config.potId).toBe('fixture-pot'); expect(config.sources).toHaveLength(1);
      expect(config.sources[0]).toMatchObject({ sourceKeyHex: own.keyHex, sourceLength: 2,
        sourceBlocksRead: 2, rowCount: 2 });
      const rows = (await readFile(config.sources[0].rowsPath, 'utf8')).trim().split('\n').map(text => JSON.parse(text));
      const row = rows[0];
      expect(row).toMatchObject({ table: 'harness_plans', hbKey: 'row', author_pubkey: '', value: { public: 'unchanged' } });
      expect(rows[1]).toMatchObject({ hbKey: 'z-private', privacyProjection: { disposition: 'drop' } });
      expect(own.length).toBe(2);
      expect(config.sources[0].sourceInput.executionBinding).toEqual(execution);
      for (const phase of ['before', 'after']) {
        const path = join(censusDir, `uuid-execution-${phase}.private.json`);
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(execution);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      const executionSha256 = createHash('sha256').update(JSON.stringify(execution)).digest('hex');
      expect(JSON.parse(await readFile(join(censusDir, 'uuid-execution-check.private.json'), 'utf8')))
        .toEqual({ schema: 'papercusp-uuid-census-execution-check-v1', verdict: 'equal', changedFields: [],
          beforeSha256: executionSha256, afterSha256: executionSha256 });
      await expect(exportSeedUuidIdempotencyCensus({ ...inputs, manifestSha256: '0'.repeat(64) }, deps)).rejects.toThrow('binding changed');
      await expect(exportSeedUuidIdempotencyCensus(inputs, deps)).rejects.toThrow('EEXIST');
      const captureDir = join(dir, 'capture'); await mkdir(captureDir, { mode: 0o700 });
      const capturedConfigPath = await exportSeedUuidIdempotencyCensus({ ...inputs, outputDir: captureDir,
        captureOriginalSpan: true }, deps);
      const capturedConfig = JSON.parse(await readFile(capturedConfigPath, 'utf8'));
      expect(capturedConfig.originalSpanReplicaDir).toBe(join(captureDir, 'original-signed-span'));
      expect(capturedConfig.sources[0].sourceInput.sourceHead).toEqual(config.sources[0].sourceInput.sourceHead);
      expect(capturedConfig.sources[0].sourceInput.proofInventorySha256).toBe(config.sources[0].sourceInput.proofInventorySha256);
      const originalDir = join(dir, 'original-capture'); await mkdir(originalDir, { mode: 0o700 });
      const originalConfigPath = await exportSeedUuidIdempotencyCensus({ ...inputs, storeDir: join(dir, 'source'),
        manifestPath: undefined, manifestSha256: undefined, potId: 'fixture-pot', outputDir: originalDir,
        captureOriginalSpan: true }, deps);
      const originalConfig = JSON.parse(await readFile(originalConfigPath, 'utf8'));
      const originalManifest = JSON.parse(await readFile(originalConfig.sourceManifestPath, 'utf8'));
      expect(originalManifest).toMatchObject({ sourceSelection: 'enumerateOwnStoreCoreKeys',
        stores: [{ kind: 'corestore', meta: { coreKeys: [own.keyHex], coreLengths: { [own.keyHex]: 2 } } }] });
      expect(originalManifest.stores[0].meta.sourceHeads[own.keyHex]).toEqual(originalConfig.sources[0].sourceInput.sourceHead);
      const replayDir = join(dir, 'original-replay'); await mkdir(replayDir, { mode: 0o700 });
      const replayInputs = { ...inputs, storeDir: originalConfig.originalSpanReplicaDir,
        manifestPath: originalConfig.sourceManifestPath, manifestSha256: originalConfig.sourceManifestSha256, outputDir: replayDir };
      const replayPath = await exportSeedUuidIdempotencyCensus(replayInputs, deps);
      const replay = JSON.parse(await readFile(replayPath, 'utf8'));
      expect(replay.sources[0].sourceInput).toEqual(originalConfig.sources[0].sourceInput);
      const changed = { ...originalManifest, stores: [{ ...originalManifest.stores[0], meta: {
        ...originalManifest.stores[0].meta, sourceHeads: { [own.keyHex]: {
          ...originalManifest.stores[0].meta.sourceHeads[own.keyHex], treeHash: '0'.repeat(64) } } } }] };
      const alteredPath = join(dir, 'changed-original.json'); const alteredBytes = JSON.stringify(changed);
      await writeFile(alteredPath, alteredBytes, { mode: 0o600 });
      const refusedHeadDir = join(dir, 'refused-head'); await mkdir(refusedHeadDir, { mode: 0o700 });
      await expect(exportSeedUuidIdempotencyCensus({ ...replayInputs, outputDir: refusedHeadDir,
        manifestPath: alteredPath, manifestSha256: createHash('sha256').update(alteredBytes).digest('hex') }, deps))
        .rejects.toThrow('signed head changed');
      expect(await readdir(refusedHeadDir)).not.toContain('uuid-census.private.json');
      const refusedDir = join(dir, 'refused'); await mkdir(refusedDir, { mode: 0o700 });
      await expect(exportSeedUuidIdempotencyCensus({ ...inputs, outputDir: refusedDir },
        { readFrozenExecution: async () => { throw new Error('fixture clean execution refused'); } }))
        .rejects.toThrow('clean execution refused');
      expect(await readdir(refusedDir)).toEqual([]);
      const drift = vi.fn().mockResolvedValueOnce(execution).mockResolvedValueOnce({ ...execution, sourceCommit: 'f'.repeat(40) });
      await expect(exportSeedUuidIdempotencyCensus({ ...inputs, outputDir: refusedDir }, { readFrozenExecution: drift }))
        .rejects.toThrow('execution changed');
      expect(await readdir(refusedDir)).not.toContain('uuid-census.private.json');
      expect(JSON.parse(await readFile(join(refusedDir, 'uuid-execution-before.private.json'), 'utf8'))).toEqual(execution);
      expect(JSON.parse(await readFile(join(refusedDir, 'uuid-execution-after.private.json'), 'utf8')))
        .toEqual({ ...execution, sourceCommit: 'f'.repeat(40) });
      expect(JSON.parse(await readFile(join(refusedDir, 'uuid-execution-check.private.json'), 'utf8')))
        .toMatchObject({ verdict: 'changed', changedFields: ['sourceCommit'], beforeSha256: executionSha256 });
      // A second attempt must preserve the failed attempt's original measurements.
      await expect(exportSeedUuidIdempotencyCensus({ ...inputs, outputDir: refusedDir }, deps)).rejects.toThrow('EEXIST');
      expect(JSON.parse(await readFile(join(refusedDir, 'uuid-execution-check.private.json'), 'utf8')))
        .toMatchObject({ verdict: 'changed', changedFields: ['sourceCommit'] });
      const unreadableDir = join(dir, 'unreadable-after'); await mkdir(unreadableDir, { mode: 0o700 });
      const unreadable = vi.fn().mockResolvedValueOnce(execution).mockRejectedValueOnce(new Error('fixture final binding refused'));
      await expect(exportSeedUuidIdempotencyCensus({ ...inputs, outputDir: unreadableDir }, { readFrozenExecution: unreadable }))
        .rejects.toThrow('fixture final binding refused');
      expect(await readdir(unreadableDir)).not.toContain('uuid-census.private.json');
      expect(JSON.parse(await readFile(join(unreadableDir, 'uuid-execution-before.private.json'), 'utf8'))).toEqual(execution);
      expect(JSON.parse(await readFile(join(unreadableDir, 'uuid-execution-check.private.json'), 'utf8')))
        .toEqual({ schema: 'papercusp-uuid-census-execution-check-v1', verdict: 'read-failed',
          error: { name: 'Error', message: 'fixture final binding refused' } });
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('checks exact private bytes and the producer contract before returning bindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-uuid-plans-'));
    await chmod(dir, 0o700);
    const file = join(dir, 'plans.json');
    const plans = [{ schema: 'papercusp-uuid-idempotency-row-drop-plan-v1',
      reviewRef: 'p2p-public-release-endgame-2026-09-01#D-166', sourceKeyHex: 'a'.repeat(64),
      sourceLength: 1, rows: [{ table: 'plans', hbKey: 'row', valueSha256: 'b'.repeat(64),
        occurrences: [{ segment: 'segment-000001.blob', line: 1, fieldPath: ['idempotencyKey'] }] }] }];
    const value = { schema: 'papercusp-uuid-idempotency-row-drop-plan-set-v1', reviewRef: plans[0]!.reviewRef,
      plans, sourceAuthentication: 'original-envelope-aead',
      sourceSignatureAndCoverage: 'requires-independent-hypercore-export-validation',
      privateSourceBindings: { configSha256: 'c'.repeat(64) }, counts: { droppedRows: 1 } };
    const save = async (data: unknown) => {
      const bytes = JSON.stringify(data); await writeFile(file, bytes, { mode: 0o600 });
      return createHash('sha256').update(bytes).digest('hex');
    };
    try {
      const hash = await save(value);
      expect(await readSeedUuidIdempotencyDropPlans(file, hash)).toEqual(plans);
      await expect(readSeedUuidIdempotencyDropPlans(file, hash, [])).rejects.toThrow('input invalid');
      const literals = ['fixture-owner'];
      const bound = await save({ ...value, privateSourceBindings: { sources: [{ privacyProjectionContext: {
        schema: 'papercusp-seed-privacy-projection-v1',
        literalsSha256: createHash('sha256').update(JSON.stringify(literals)).digest('hex'),
        excludedTablesSha256: createHash('sha256').update(JSON.stringify([...SEED_EXCLUDED_TABLES].sort())).digest('hex'),
      } }] } });
      expect(await readSeedUuidIdempotencyDropPlans(file, bound, literals)).toEqual(plans);
      await expect(readSeedUuidIdempotencyDropPlans(file, bound, ['other-owner'])).rejects.toThrow('input invalid');
      await expect(readSeedUuidIdempotencyDropPlans(file, '0'.repeat(64))).rejects.toThrow('input invalid');
      const duplicate = await save({ ...value, plans: [...plans, ...plans] });
      await expect(readSeedUuidIdempotencyDropPlans(file, duplicate)).rejects.toThrow('input invalid');
      const original = await save(value);
      await chmod(file, 0o644);
      await expect(readSeedUuidIdempotencyDropPlans(file, original)).rejects.toThrow('input invalid');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('requires an exact private file/hash and a fresh, non-reused corestore cut', () => {
    const valid = {
      requested: true,
      file: 'private-plans.json',
      hash: 'a'.repeat(64),
      skipCorestoreRefresh: true,
      reuseCorestore: false,
      noCorestore: false,
    };
    expect(resolveUuidIdempotencyDropPlanInput(valid)).toEqual({ file: valid.file, hash: valid.hash });
    expect(resolveUuidIdempotencyDropPlanInput({ ...valid, requested: false })).toBeUndefined();

    for (const invalid of [
      { ...valid, file: undefined },
      { ...valid, hash: undefined },
      { ...valid, skipCorestoreRefresh: false },
      { ...valid, reuseCorestore: true },
      { ...valid, noCorestore: true },
    ]) {
      expect(() => resolveUuidIdempotencyDropPlanInput(invalid))
        .toThrow('UUID row-drop plans require an exact private file/hash and a fresh cut with --skip-corestore-refresh');
    }
  });

  it('refuses an invalid row-drop cut before opening a store or replacing the output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-uuid-refuse-'));
    try {
      const out = join(dir, 'prior-seed'); await mkdir(out);
      await writeFile(join(out, 'manifest.json'), 'prior bytes');
      const result = spawnCutSeedCli(['--out', out,
        '--uuid-idempotency-drop-plans', join(dir, 'missing.json'),
        '--uuid-idempotency-drop-plans-sha256', 'a'.repeat(64)], { timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('fresh cut with --skip-corestore-refresh');
      expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('prior bytes');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('assertShippingCutDbTarget (WI-6554700010012344: a shipping cut never reads a discovered DB)', () => {
  const base = { workspaceId: 'papercusp-workspace', allowDiscoveredDb: false } as const;

  it('accepts an explicit env DSN and the operator env file', () => {
    for (const source of ['env', 'operator-env-file'] as const) {
      expect(() => assertShippingCutDbTarget({ ...base, target: { source, endpoint: 'localhost:5432' } })).not.toThrow();
    }
  });

  it('refuses embedded-PG discovery and the port fallback, naming the source and endpoint', () => {
    for (const [source, endpoint] of [['discovery', 'localhost:19406'], ['fallback', 'localhost:5432']] as const) {
      let message = '';
      try {
        assertShippingCutDbTarget({ ...base, target: { source, endpoint } });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('REFUSING shipping cut');
      expect(message).toContain(`via ${source} (${endpoint})`);
      expect(message).toContain('--workspace-id papercusp-workspace');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('--allow-discovered-db');
    }
  });

  it('lets --allow-discovered-db through with a loud warning', () => {
    const warn = vi.fn();
    expect(() =>
      assertShippingCutDbTarget({
        ...base,
        allowDiscoveredDb: true,
        target: { source: 'discovery', endpoint: 'localhost:19406' },
        warn,
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('--allow-discovered-db');
    expect(String(warn.mock.calls[0]?.[0])).toContain('via discovery (localhost:19406)');
  });

  it('the CLI refuses --workspace-id before any cut work when no env DSN or operator env file pins the DB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-db-source-refuse-'));
    try {
      const out = join(dir, 'prior-seed'); await mkdir(out);
      await writeFile(join(out, 'manifest.json'), 'prior bytes');
      const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_SKIP_PG_DISCOVERY: '1' };
      for (const key of ['DATABASE_URL', 'HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_PG_PORT']) {
        delete env[key];
      }
      // A MISSING --reuse-corestore: if the guard ever regresses, the CLI dies at
      // readReusableCorestore, right after a read-only epoch lookup and BEFORE the git
      // cut, instead of bundling the whole repo. (--no-git is refused earlier with reuse.)
      const result = spawnCutSeedCli(['--out', out,
        '--workspace-id', 'wi-6554700010012344-test',
        '--reuse-corestore', join(dir, 'missing-corestore')], { timeout: 60_000, env });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('REFUSING shipping cut');
      expect(result.stderr).toMatch(/via (discovery|fallback) \(/);
      expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('prior bytes');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('exact private finding redaction input', () => {
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'seed-private-redaction-'));
    await chmod(dir, 0o700);
    const source = join(dir, 'plaintext.jsonl');
    const report = join(dir, 'findings.json');
    const meta = join(dir, 'findings.meta.json');
    const config = join(dir, 'detectors.toml');
    const secret = ['fixture-view:', 'synthetic-only-pass'].join('');
    const sourceText = JSON.stringify({ body: 'curl -u ' + secret }) + '\n';
    const row = { RuleID: 'curl-auth-user', Match: 'curl -u ' + secret, Secret: secret, File: source };
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const reportText = JSON.stringify([row]);
    await Promise.all([
      writeFile(source, sourceText, { mode: 0o600 }),
      writeFile(report, reportText, { mode: 0o600 }),
      writeFile(config, '[extend]\nuseDefault = true\n', { mode: 0o600 }),
      writeFile(meta, JSON.stringify({ scannerExit: 1, findings: 1, reportSha256: hash(reportText),
        identity: { blobSha256: hash(sourceText), configSha256: hash('[extend]\nuseDefault = true\n') } }), { mode: 0o600 }),
    ]);
    return { dir, source, report, config, secret, digest: hash(JSON.stringify([row.RuleID, row.Match, row.Secret])) };
  }

  it('resolves only the approved finding from an unchanged private scan', async () => {
    const f = await fixture();
    try {
      expect(await readSeedFindingRedactions(f.report, [f.digest], f.config)).toEqual([f.secret]);
      await expect(readSeedFindingRedactions(f.report, ['0'.repeat(64)], f.config)).rejects.toThrow('evidence invalid');
      await expect(readSeedFindingRedactions(f.report, [f.digest, f.digest], f.config)).rejects.toThrow('evidence invalid');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('refuses export redaction before reading the report, opening a store or touching prior seed output', async () => {
    const f = await fixture();
    try {
      const out = join(f.dir, 'prior-seed');
      await mkdir(out);
      await writeFile(join(out, 'manifest.json'), 'prior seed bytes');
      const result = spawnCutSeedCli([
        '--out', out, '--store-dir', join(f.dir, 'absent-store'),
        '--redact-findings', join(f.dir, 'absent-report.json'),
        '--redact-finding-digests', f.digest,
      ], { timeout: 30_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('export redaction is unsupported for sealed content');
      expect(result.stdout + result.stderr).not.toContain(f.secret);
      expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('prior seed bytes');
      expect(await readdir(f.dir)).not.toContain('absent-store');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });

  it('fails closed on changed source/config/report and public evidence permissions without exposing values', async () => {
    for (const mutation of ['source', 'config', 'report', 'permissions']) {
      const f = await fixture();
      try {
        if (mutation === 'permissions') await chmod(f.report, 0o644);
        else await writeFile(f[mutation as 'source' | 'config' | 'report'], 'changed', { mode: 0o600 });
        try {
          await readSeedFindingRedactions(f.report, [f.digest], f.config);
          throw new Error('expected refusal');
        } catch (error) {
          expect(String(error)).toContain('evidence invalid');
          expect(String(error)).not.toContain(f.secret);
          expect(String(error)).not.toContain(f.dir);
        }
      } finally { await rm(f.dir, { recursive: true, force: true }); }
    }
  });
});

describe('head-snapshot timeout override', () => {
  it('prefers the explicit CLI value over the environment', () => {
    expect(parseHeadSnapshotTimeoutMs({ 'head-snapshot-timeout-ms': '123456' }, {
      PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS: '999999',
    })).toBe(123456);
  });

  it('reads the environment when the CLI flag is omitted and preserves derived sizing when both are absent', () => {
    expect(parseHeadSnapshotTimeoutMs({}, { PAPERCUSP_HEAD_SNAPSHOT_TIMEOUT_MS: '654321' })).toBe(654321);
    expect(parseHeadSnapshotTimeoutMs({}, {})).toBeUndefined();
  });

  it('rejects a non-positive or non-integer override', () => {
    expect(() => parseHeadSnapshotTimeoutMs({ 'head-snapshot-timeout-ms': '0' })).toThrow(/positive integer/);
    expect(() => parseHeadSnapshotTimeoutMs({ 'head-snapshot-timeout-ms': '1.5' })).toThrow(/positive integer/);
  });
});
import { DRAIN_PASS_TIMEOUT_MS } from '@papercusp/operator-core/lib/sync/hyperbee/outbox-drain';
import { HEAD_SNAPSHOT_PATH } from '@papercusp/operator-core/lib/sync/hyperbee/live-head-snapshot-client';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';

const EPOCH_KEY = Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 256));
const HEX32 = 'ab'.repeat(32); // 64 hex chars = 32 bytes

// The identity strings below are deliberately SYNTHETIC. This is a pure string-merge
// function, so the fixture only needs the SHAPE of a uname/identity table — using this
// build box's real user and hostname taught the fixture nothing extra and tripped
// lint:no-identity-literals, which red-pins the whole release gate.
const FIXTURE_BUILD_HOST = 'papercusp-build';
const FIXTURE_BUILD_USER = 'fixture-builduser';
const FIXTURE_REAL_HOST = 'fixture-host-0000';

describe('transactional seed output', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'cut-seed-publish-'));
    const out = join(root, 'seed');
    await mkdir(join(out, 'corestore'), { recursive: true });
    await writeFile(join(out, 'manifest.json'), 'prior manifest');
    await writeFile(join(out, 'epoch-keys.json'), 'prior keys');
    await writeFile(join(out, 'corestore', 'data'), 'prior corestore');
    return { root, out };
  }

  async function expectPrior(out: string) {
    expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('prior manifest');
    expect(await readFile(join(out, 'epoch-keys.json'), 'utf8')).toBe('prior keys');
    expect(await readFile(join(out, 'corestore', 'data'), 'utf8')).toBe('prior corestore');
  }

  it('preserves all prior seed bytes when the staged cut or verification rejects', async () => {
    const { root, out } = await fixture();
    try {
      await expect(withSeedOutput(out, async (staged) => {
        await cp(out, staged, { recursive: true });
        await writeFile(join(staged, 'manifest.json'), 'partial new manifest');
        await writeFile(join(staged, 'corestore', 'data'), 'partial new corestore');
        await expectPrior(out);
        throw new Error('staged seed rejected');
      })).rejects.toThrow('staged seed rejected');
      await expectPrior(out);
      expect(await readdir(root)).toEqual(['seed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('publishes the verified whole seed together, then removes the prior generation', async () => {
    const { root, out } = await fixture();
    try {
      const result = await withSeedOutput(out, async (staged) => {
        await cp(out, staged, { recursive: true });
        await writeFile(join(staged, 'manifest.json'), 'new manifest');
        await writeFile(join(staged, 'epoch-keys.json'), 'new keys');
        await expectPrior(out);
        return 'verified';
      });
      expect(result).toBe('verified');
      expect(await readFile(join(out, 'manifest.json'), 'utf8')).toBe('new manifest');
      expect(await readFile(join(out, 'epoch-keys.json'), 'utf8')).toBe('new keys');
      expect(await readFile(join(out, 'corestore', 'data'), 'utf8')).toBe('prior corestore');
      expect(await readdir(root)).toEqual(['seed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains a rejected identity-bearing stage privately without publishing it', async () => {
    const { root, out } = await fixture();
    const marker = 'fixture-crossbox-marker';
    const rejected = Buffer.concat([Buffer.from([0, 255]), Buffer.from(marker)]);
    try {
      await expect(withSeedOutput(out, async staged => {
        await cp(out, staged, { recursive: true });
        await mkdir(join(staged, 'corestore', 'db'));
        await writeFile(join(staged, 'corestore', 'db', '000104.blob'), rejected);
        await assertStagedSeedCarriesNoIdentity({
          dir: staged,
          neutralHostname: FIXTURE_BUILD_HOST,
          env: {},
          probe: { user: () => undefined, home: () => undefined, hostname: () => 'runner-test' },
          extraLiterals: [marker],
        });
      })).rejects.toThrow(/STAGED SEED CARRIES/);
      await expectPrior(out);
      const transactions = (await readdir(root)).filter(name => name.startsWith('.seed-cut-'));
      expect(transactions).toHaveLength(1);
      const transaction = join(root, transactions[0]);
      expect((await stat(transaction)).mode & 0o077).toBe(0);
      expect(await readFile(join(transaction, 'next', 'corestore', 'db', '000104.blob'))).toEqual(rejected);
      const receiptPath = join(transaction, 'identity-failure.json');
      expect((await stat(receiptPath)).mode & 0o077).toBe(0);
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({
        kind: 'seed-identity',
        findings: [{ file: 'corestore/db/000104.blob', key: 'release-literal:0', offset: 2, binary: true }],
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rolls back a failed publication rename, leaving the prior seed reusable', async () => {
    const { root, out } = await fixture();
    try {
      const renameDir: typeof rename = async (from, to) => {
        if (String(from).endsWith('/next')) throw new Error('publish EIO');
        await rename(from, to);
      };
      await expect(withSeedOutput(out, (staged) => cp(out, staged, { recursive: true }), renameDir)).rejects.toThrow('publish EIO');
      await expectPrior(out);
      expect(await readdir(root)).toEqual(['seed']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains the entire backup if both publication and rollback fail', async () => {
    const { root, out } = await fixture();
    try {
      const renameDir: typeof rename = async (from, to) => {
        if (String(to) === out) throw new Error('destination unavailable');
        await rename(from, to);
      };
      await expect(withSeedOutput(out, (staged) => cp(out, staged, { recursive: true }), renameDir)).rejects.toThrow('prior seed preserved at');
      const [transaction] = await readdir(root);
      await expectPrior(join(root, transaction, 'previous'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("createFilteredSeedProgressReporter", () => {
  it("logs the first window, meaningful percentage/time progress, and completion without window spam", () => {
    let now = 1_000;
    const warn = vi.fn();
    const report = createFilteredSeedProgressReporter({
      warn,
      now: () => now,
      minIntervalMs: 60_000,
      minPercentStep: 5,
    });
    const reportProgress = (processed: number) => report({
      phase: "filtered-source-scan",
      sourceStart: 0,
      sourceEnd: 10_000,
      processed,
      total: 10_000,
      decodedOps: processed,
      decodedBytes: processed,
    });

    reportProgress(256);
    reportProgress(512);
    expect(warn).toHaveBeenCalledTimes(1);

    reportProgress(768);
    expect(warn).toHaveBeenCalledTimes(2);

    now += 60_000;
    reportProgress(1_024);
    expect(warn).toHaveBeenCalledTimes(3);

    reportProgress(10_000);
    reportProgress(10_000);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenLastCalledWith(
      "[cut-seed] filtered-source-scan: 10000/10000 source blocks folded (100%).",
    );
  });
});

describe('mergeReleaseSeedRedactionValues (WI-37894)', () => {
  it('keeps the real host when the audit runs inside the neutralized UTS child', () => {
    const values = mergeReleaseSeedRedactionValues(
      `${FIXTURE_BUILD_HOST}\tbuildhost\t0\n${FIXTURE_BUILD_USER}\tbuilduser\t0\n`,
      FIXTURE_REAL_HOST,
    );

    expect(values).toEqual([FIXTURE_REAL_HOST, FIXTURE_BUILD_HOST, FIXTURE_BUILD_USER]);
  });
});

describe('release seed identity coverage for fresh and reused corestores (WI-10004435)', () => {
  it('loads the release literal set for a reused corestore even though wantCorestore is false', () => {
    const load = vi.fn(() => ['Synthetic Owner', 'Synthetic Organization']);

    expect(resolveReleaseSeedRedactionValuesForCut({
      wantCorestore: false,
      reuseCorestoreDir: '/fixture/reused-seed',
      load,
    })).toEqual(['Synthetic Owner', 'Synthetic Organization']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads once for a fresh corestore and skips resolution only when no corestore can ship', () => {
    const freshLoad = vi.fn(() => ['Synthetic Owner']);
    expect(resolveReleaseSeedRedactionValuesForCut({ wantCorestore: true, load: freshLoad })).toEqual([
      'Synthetic Owner',
    ]);
    expect(freshLoad).toHaveBeenCalledTimes(1);

    const absentLoad = vi.fn(() => ['must-not-load']);
    expect(resolveReleaseSeedRedactionValuesForCut({ wantCorestore: false, load: absentLoad })).toEqual([]);
    expect(absentLoad).not.toHaveBeenCalled();
  });
});

describe('deriveSourceStoreDirs (WI-37822)', () => {
  it('discovers existing sibling hive stores and excludes the current store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cut-seed-source-dirs-'));
    try {
      const current = join(root, '.papercusp', 'current-harness', 'hyperbee');
      const siblingA = join(root, '.papercusp', 'a-harness', 'hyperbee');
      const siblingB = join(root, '.papercusp', 'b-harness', 'hyperbee');
      await Promise.all([current, siblingA, siblingB].map((dir) => mkdir(dir, { recursive: true })));

      expect(await deriveSourceStoreDirs(current)).toEqual([siblingA, siblingB]);
      expect(await deriveSourceStoreDirs(join(root, 'not-a-hyperbee'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('pickGitEncryption', () => {
  it('explicit keyHex ⇒ FIXTURE mode: seals via=seed-key-op with that key, never touches deriveEpochKey', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      keyHex: HEX32,
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 0,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'seed-key-op', potId: 'papercusp' });
    expect(enc?.key).toEqual(Uint8Array.from(Buffer.from(HEX32, 'hex')));
    expect(deriveEpochKey).not.toHaveBeenCalled(); // explicit key wins; no crypto touched
  });

  it('a bad-length keyHex ⇒ throws (32-byte requirement)', async () => {
    await expect(
      pickGitEncryption({ keyHex: 'abcd', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey: vi.fn(async () => EPOCH_KEY) }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('a live --workspace-id ⇒ RELEASE mode: seals via=epoch with the owner epoch key at cutAtEpoch', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({
      workspaceId: 'papercusp-workspace',
      epochProvided: false,
      hive: 'papercusp',
      cutAtEpoch: 3,
      deriveEpochKey,
    });
    expect(enc?.keyRef).toEqual({ via: 'epoch', potId: 'papercusp', epoch: 3 });
    expect(enc?.key).toEqual(EPOCH_KEY);
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 3);
  });

  it('an explicit --epoch (no workspace) also takes the epoch path', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const enc = await pickGitEncryption({ epochProvided: true, hive: 'papercusp', cutAtEpoch: 5, deriveEpochKey });
    expect(enc?.keyRef).toEqual({ via: 'epoch', potId: 'papercusp', epoch: 5 });
    expect(deriveEpochKey).toHaveBeenCalledWith('papercusp', 5);
  });

  it('no key + no epoch context ⇒ PLAINTEXT (undefined), never mints from the bare cutAtEpoch=0 guess', async () => {
    const deriveEpochKey = vi.fn(async () => EPOCH_KEY);
    const warn = vi.fn();
    const enc = await pickGitEncryption({ epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey, warn });
    expect(enc).toBeUndefined();
    expect(deriveEpochKey).not.toHaveBeenCalled(); // guarded: never mint a divergent key from nothing
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PLAINTEXT/));
  });

  it('a wrong-size epoch key from deriveEpochKey ⇒ throws (fail closed, never seal with a bad key)', async () => {
    const deriveEpochKey = vi.fn(async () => Uint8Array.from([1, 2, 3]));
    await expect(
      pickGitEncryption({ workspaceId: 'ws', epochProvided: false, hive: 'papercusp', cutAtEpoch: 0, deriveEpochKey }),
    ).rejects.toThrow(/expected 32/);
  });
});

describe('assertEpochSealIdentityPresent (load-don\'t-mint guard, WI-2903/WI-1981)', () => {
  const base = { workspaceId: 'papercusp-workspace', hive: 'papercusp', allowMint: false };

  it('identity present ⇒ proceeds (and names the pubkey in the warn)', async () => {
    const warn = vi.fn();
    await expect(
      assertEpochSealIdentityPresent({ ...base, warn, loadStatus: async () => ({ kind: 'ok', pubkeyBase64: 'dt7o6ioLxyz' }) }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dt7o6ioL/));
  });

  it('identity ABSENT ⇒ refuses: deriveEpochKey is get-or-create, sealing here would mint a divergent key', async () => {
    await expect(
      assertEpochSealIdentityPresent({ ...base, loadStatus: async () => ({ kind: 'not_found' }) }),
    ).rejects.toThrow(/REFUSING epoch seal.*NO private key/s);
  });

  it('keychain read ERROR ⇒ fails CLOSED (a key may exist but be unreadable — not the same as absent)', async () => {
    await expect(
      assertEpochSealIdentityPresent({ ...base, loadStatus: async () => ({ kind: 'error', reason: 'secret-tool timeout' }) }),
    ).rejects.toThrow(/keychain read FAILED \(secret-tool timeout\)/);
  });

  it('--allow-mint-epoch-key ⇒ proceeds on absent identity (new-hive bootstrap escape hatch), loudly', async () => {
    const warn = vi.fn();
    await expect(
      assertEpochSealIdentityPresent({ ...base, allowMint: true, warn, loadStatus: async () => ({ kind: 'not_found' }) }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/WILL mint/));
  });
});

describe('parseGitDepth', () => {
  it('--shallow aliases to --depth 1', () => {
    expect(parseGitDepth({ shallow: true })).toBe(1);
  });

  it('--depth 1 is accepted and omitted depth stays undefined', () => {
    expect(parseGitDepth({ depth: '1' })).toBe(1);
    expect(parseGitDepth({})).toBeUndefined();
  });

  it('rejects invalid or unsupported depths', () => {
    expect(() => parseGitDepth({ depth: '0' })).toThrow(/positive integer/);
    expect(() => parseGitDepth({ depth: '2' })).toThrow(/only 1/);
    expect(() => parseGitDepth({ shallow: true, depth: '2' })).toThrow(/alias/);
  });
});

describe('refreshCorestoreStateForSeed', () => {
  it('force-backfills current rows and drains until empty before a corestore cut', async () => {
    const pg = {} as never;
    const ownLog = {
      keyHex: 'cd'.repeat(32),
      append: vi.fn(async () => {}),
      appendBatch: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      length: 0,
    };
    const backfillImpl = vi.fn(async () => ({ skipped: false, enqueued: 12, dropped: 0 }));
    const drainImpl = vi.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(5).mockResolvedValueOnce(0);
    const warn = vi.fn();

    const res = await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg,
      openOwnLogImpl: async () => ownLog,
      backfillImpl,
      drainImpl,
      warn,
    });

    expect(backfillImpl).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', ownLog }),
      pg,
      { force: true, maxOpsPerAuthor: 0 },
    );
    expect(drainImpl).toHaveBeenCalledTimes(3);
    expect(res).toEqual({
      backfill: { skipped: false, enqueued: 12, dropped: 0 },
      drained: 12,
      passes: 3,
      ownLogKey: ownLog.keyHex,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refreshed corestore source'));
  });

  it('P-014 --no-force-backfill: passes force:false so already-swept targets are NOT re-enqueued', async () => {
    // The DEFAULT (force:true) is asserted by the test above — that assertion is this
    // one's control, and the pair is the point: a resume must be opt-in, because
    // force:true is the belt-and-braces default a first-ever cut needs.
    const ownLog = { keyHex: 'ef'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 0 };
    const backfillImpl = vi.fn(async () => ({ skipped: false, enqueued: 0, dropped: 0 }));
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg: {} as never,
      openOwnLogImpl: async () => ownLog,
      backfillImpl,
      drainImpl: vi.fn(async () => 0),
      warn: vi.fn(),
      forceBackfill: false,
    });
    expect(backfillImpl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      force: false,
      maxOpsPerAuthor: 0,
    });
  });

  it('P-004: does NOT append a fresh head snapshot for a FULL cut (sparse falsy)', async () => {
    const ownLog = { keyHex: 'cd'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 0 };
    const produceSnapshotImpl = vi.fn();
    const loadGovernorReceiptKeysImpl = vi.fn();
    const loadSnapshotEnvelopeKeysImpl = vi.fn();
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg: {} as never,
      openOwnLogImpl: async () => ownLog,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 0, dropped: 0 })),
      drainImpl: vi.fn(async () => 0),
      produceSnapshotImpl,
      loadGovernorReceiptKeysImpl,
      loadSnapshotEnvelopeKeysImpl,
      warn: vi.fn(),
      // sparse omitted → full cut
    });
    expect(produceSnapshotImpl).not.toHaveBeenCalled();
    expect(loadGovernorReceiptKeysImpl).not.toHaveBeenCalled();
    expect(loadSnapshotEnvelopeKeysImpl).not.toHaveBeenCalled();
  });

  it('P-004: appends a fresh head snapshot AFTER the drain when sparse (so the sparse start is in the reader scan window)', async () => {
    const ownLog = { keyHex: 'cd'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 0 };
    const drainImpl = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0);
    const produceSnapshotImpl = vi.fn(async () => ({ appended: true, coversUpTo: 42, rowCount: 10, chunkCount: 2 }));
    const warn = vi.fn();
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace',
      hive: 'papercusp',
      store: {} as never,
      pg: {} as never,
      openOwnLogImpl: async () => ownLog,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 3, dropped: 0 })),
      drainImpl,
      produceSnapshotImpl,
      loadGovernorReceiptKeysImpl: async () => [],
      loadSnapshotEnvelopeKeysImpl: async () => ({ potId: 'papercusp', keys: [] }),
      warn,
      sparse: true,
    });
    expect(produceSnapshotImpl).toHaveBeenCalledTimes(1);
    expect(produceSnapshotImpl).toHaveBeenCalledWith(ownLog, expect.objectContaining({ now: expect.any(Number), schemaVersion: expect.any(Number) }));
    // Drain fully first, THEN snapshot: the snapshot must compact the drained state.
    expect(drainImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appended fresh head snapshot'));
  });

  it('filters only absent governor receipts using the pre-census log boundary on a quiesced cut', async () => {
    const ownLog = { keyHex: 'cd'.repeat(32), append: vi.fn(async () => {}), appendBatch: vi.fn(async () => {}), get: vi.fn(async () => null), length: 10 };
    const pg = {} as never;
    const order: string[] = [];
    const envelopeKeys = { potId: 'papercusp', keys: [{ epoch: 1, key: new Uint8Array(32) }] };
    const loadGovernorReceiptKeysImpl = vi.fn(async () => {
      order.push('census');
      ownLog.length = 11; // A concurrent append after the captured boundary must survive.
      return ['papercusp/WI-LIVE'];
    });
    const produceSnapshotImpl = vi.fn(async (_log: Parameters<typeof produceLogSnapshot>[0], opts: Parameters<typeof produceLogSnapshot>[1]) => {
      order.push('snapshot');
      const filter = opts?.governorReceiptFilter;
      expect(filter).toEqual({ maxSourceIndexExclusive: 10, liveQualifiedKeys: ['papercusp/WI-LIVE'], envelopeKeys });
      if (!filter) throw new Error('missing governor receipt filter');
      const receipt = { payload: { resource_governor: {} } };
      const row = { table: 'engineer-issues', sourceIndex: 2, hbKey: 'papercusp/WI-DEAD' };
      expect(shouldDropGovernorReceiptSnapshotRow(receipt, row, filter)).toBe(true);
      expect(shouldDropGovernorReceiptSnapshotRow(receipt, { ...row, hbKey: 'papercusp/WI-LIVE' }, filter)).toBe(false);
      expect(shouldDropGovernorReceiptSnapshotRow(receipt, { ...row, sourceIndex: 10 }, filter)).toBe(false);
      expect(shouldDropGovernorReceiptSnapshotRow({ payload: { lane: 'observation' } }, row, filter)).toBe(false);
      expect(shouldDropGovernorReceiptSnapshotRow({ payload: {} }, row, filter)).toBe(false);
      expect(opts?.excludeTables).toEqual(SEED_EXCLUDED_TABLES);
      expect(opts?.excludeTables).not.toContain('engineer-issues');
      return { appended: true, coversUpTo: 11, rowCount: 4, chunkCount: 1 };
    });
    await refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace', hive: 'papercusp', store: {} as never, pg,
      openOwnLogImpl: async () => ownLog,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 0, dropped: 0 })),
      drainImpl: async () => { order.push('drain'); return 0; },
      loadGovernorReceiptKeysImpl,
      loadSnapshotEnvelopeKeysImpl: async (workspaceId, hive) => {
        expect([workspaceId, hive]).toEqual(['papercusp-workspace', 'papercusp']);
        return envelopeKeys;
      },
      produceSnapshotImpl, warn: vi.fn(), sparse: true,
    });
    expect(loadGovernorReceiptKeysImpl).toHaveBeenCalledWith('papercusp-workspace', pg);
    expect(order).toEqual(['drain', 'census', 'snapshot']);
  });

  it('refuses a quiesced filtered snapshot when its census cannot be loaded', async () => {
    const produceSnapshotImpl = vi.fn();
    await expect(refreshCorestoreStateForSeed({
      workspaceId: 'papercusp-workspace', hive: 'papercusp', store: {} as never, pg: {} as never,
      openOwnLogImpl: async () => ({ keyHex: 'cd'.repeat(32), length: 10 }) as never,
      backfillImpl: vi.fn(async () => ({ skipped: false, enqueued: 0, dropped: 0 })),
      drainImpl: async () => 0,
      loadGovernorReceiptKeysImpl: async () => { throw new Error('census unavailable'); },
      loadSnapshotEnvelopeKeysImpl: async () => ({ potId: 'papercusp', keys: [] }),
      produceSnapshotImpl, warn: vi.fn(), sparse: true,
    })).rejects.toThrow('census unavailable');
    expect(produceSnapshotImpl).not.toHaveBeenCalled();
  });
});

describe('withCutSeedSingleton (workspace+hive advisory lock)', () => {
  function lockClient(acquired = true) {
    const session = Object.assign(vi.fn(async () => [{ acquired }]), { release: vi.fn() });
    const client = { reserve: vi.fn(async () => session), end: vi.fn(async () => {}) };
    return { session, client, createLockClient: () => ({ sql: client as never }) };
  }

  it('refuses a second cut before its backfill/INSERT callback runs', async () => {
    const { session, client, createLockClient } = lockClient(false);
    const pg = vi.fn() as never;
    const backfillOrInsert = vi.fn(async () => 'must-not-run');

    await expect(
      withCutSeedSingleton({
        pg,
        workspaceId: 'papercusp-workspace',
        hive: 'papercusp',
        run: backfillOrInsert,
        createLockClient,
      }),
    ).rejects.toThrow(/another seed cut is already refreshing or opening/);
    expect(backfillOrInsert).not.toHaveBeenCalled();
    expect(session).toHaveBeenCalledTimes(1);
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('holds the session across the callback and forwards the ordinary data pool', async () => {
    const { session, client, createLockClient } = lockClient();
    const pg = vi.fn() as never;
    const run = vi.fn(async (dataPool: unknown) => {
      expect(dataPool).toBe(pg);
      expect(session.release).not.toHaveBeenCalled();
      await Promise.resolve();
      await Promise.resolve();
      expect(session.release).not.toHaveBeenCalled();
      expect(client.end).not.toHaveBeenCalled();
      return 'cut-opened';
    });

    await expect(
      withCutSeedSingleton({ pg, workspaceId: 'ws-1', hive: 'papercusp', run, createLockClient }),
    ).resolves.toBe('cut-opened');
    expect(run).toHaveBeenCalledWith(pg);
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('closes the dedicated lock client when the cut callback fails', async () => {
    const { session, client, createLockClient } = lockClient();
    const pg = vi.fn() as never;
    const failure = new Error('backfill failed');

    await expect(withCutSeedSingleton({
      pg,
      workspaceId: 'ws-1',
      hive: 'papercusp',
      createLockClient,
      run: async () => {
        await Promise.resolve();
        throw failure;
      },
    })).rejects.toBe(failure);
    expect(session.release).toHaveBeenCalledTimes(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('closes a lock client whose connection reservation fails', async () => {
    const { client, createLockClient } = lockClient();
    const failure = new Error('connection unavailable');
    client.reserve.mockRejectedValueOnce(failure);
    const run = vi.fn();
    await expect(withCutSeedSingleton({
      pg: vi.fn() as never, workspaceId: 'ws-1', hive: 'papercusp', run, createLockClient,
    })).rejects.toBe(failure);
    expect(run).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});

// --- WI-3232: offline-pot cutter helpers ---

const GIT_ENTRY: SeedStoreEntry = {
  kind: 'git',
  hash: 'gh1',
  sizeBytes: 100,
  source: { type: 'resource', path: 'git' },
  encryption: { scheme: 'xchacha20poly1305', keyRef: { via: 'epoch', potId: 'papercusp', epoch: 0 } },
};
const CORESTORE_ENTRY: SeedStoreEntry = {
  kind: 'corestore',
  hash: 'ch1',
  sizeBytes: 2048,
  source: { type: 'resource', path: 'corestore' },
};
function manifest(stores: SeedStoreEntry[], cutAtEpoch = 0): SeedManifest {
  return { seedFormatVersion: 1, potId: 'papercusp', cutAtEpoch, cutHlc: '0:0', cutTs: 1, stores };
}

describe('encodeEpochKeysFile (WI-3232 bundled epoch keys, WI-3297 multi-epoch)', () => {
  const key = (fill: number) => Uint8Array.from(Array.from({ length: 32 }, () => fill));

  it('serializes { hive: { epoch: base64 } } for a 32-byte key', () => {
    const k = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
    const out = JSON.parse(encodeEpochKeysFile('papercusp', new Map([[0, k]])));
    expect(out).toEqual({ papercusp: { '0': Buffer.from(k).toString('base64') } });
    // round-trips back to the exact 32 bytes
    expect(Uint8Array.from(Buffer.from(out.papercusp['0'], 'base64'))).toEqual(k);
  });
  it('serializes MULTIPLE epochs under one hive, epoch-sorted', () => {
    const out = JSON.parse(
      encodeEpochKeysFile('papercusp', new Map([[2, key(2)], [0, key(0)], [1, key(1)]])),
    );
    expect(Object.keys(out.papercusp)).toEqual(['0', '1', '2']);
    expect(out.papercusp['2']).toBe(Buffer.from(key(2)).toString('base64'));
  });
  it('rejects a non-32-byte key (never ship a truncated seal key)', () => {
    expect(() => encodeEpochKeysFile('papercusp', new Map([[0, new Uint8Array(16)]]))).toThrow(/32 bytes/);
  });
  it('rejects an empty map (an empty file would silently defer every op)', () => {
    expect(() => encodeEpochKeysFile('papercusp', new Map())).toThrow(/no epoch keys/);
  });
});

describe('collectSeedEpochKeys (WI-3297 historical-epoch bundling)', () => {
  const key = (fill: number) => Uint8Array.from(Array.from({ length: 32 }, () => fill));

  it('bundles the current key plus every keychain-present historical epoch (load-only)', async () => {
    const loadKey = vi.fn(async (_h: string, epoch: number) => (epoch === 1 ? null : key(epoch)));
    const warn = vi.fn();
    const keys = await collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 3, currentKey: key(9), loadKey, warn });
    expect([...keys.keys()].sort((a, b) => a - b)).toEqual([0, 2, 3]);
    expect(keys.get(3)).toEqual(key(9)); // current epoch = the seal-derived key, never re-loaded
    expect(loadKey.mock.calls.map(([, e]) => e)).toEqual([0, 1, 2]); // never touches cutAtEpoch
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/epoch 1 key NOT in the keychain/);
  });
  it('cutAtEpoch 0 bundles exactly the current key with no keychain reads', async () => {
    const loadKey = vi.fn();
    const keys = await collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 0, currentKey: key(7), loadKey });
    expect([...keys.entries()]).toEqual([[0, key(7)]]);
    expect(loadKey).not.toHaveBeenCalled();
  });
  it('propagates a loader failure (unreadable ≠ absent — fail closed)', async () => {
    const loadKey = vi.fn(async () => {
      throw new Error('keychain read FAILED');
    });
    await expect(
      collectSeedEpochKeys({ hive: 'papercusp', cutAtEpoch: 1, currentKey: key(1), loadKey, warn: () => {} }),
    ).rejects.toThrow(/keychain read FAILED/);
  });
});

describe('graftCorestoreEntry (WI-3232 --reuse-corestore)', () => {
  it('appends the corestore entry to a git-only manifest', () => {
    const grafted = graftCorestoreEntry(manifest([GIT_ENTRY]), CORESTORE_ENTRY);
    expect(grafted.stores.map((s) => s.kind)).toEqual(['git', 'corestore']);
    expect(grafted.stores[1]).toEqual(CORESTORE_ENTRY);
    expect(grafted.potId).toBe('papercusp'); // preserves the rest of the manifest
  });
  it('refuses to double-add a corestore', () => {
    expect(() => graftCorestoreEntry(manifest([GIT_ENTRY, CORESTORE_ENTRY]), CORESTORE_ENTRY)).toThrow(/already has a corestore/);
  });
});

describe('readReusableCorestore (WI-3232 --reuse-corestore)', () => {
  const okExists = () => true;
  it('returns the corestore entry + epoch from an existing seed manifest', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY, CORESTORE_ENTRY], 0)));
    const res = await readReusableCorestore('/seed', { readManifest, exists: okExists });
    expect(res.entry).toEqual(CORESTORE_ENTRY);
    expect(res.cutAtEpoch).toBe(0);
  });
  it('throws when the seed dir has no manifest', async () => {
    await expect(readReusableCorestore('/seed', { exists: (p) => !p.endsWith('manifest.json') })).rejects.toThrow(/no manifest.json/);
  });
  it('throws when the manifest has no corestore entry (nothing to reuse)', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY])));
    await expect(readReusableCorestore('/seed', { readManifest, exists: okExists })).rejects.toThrow(/no 'corestore' store entry/);
  });
  it('throws when the corestore payload dir is missing on disk', async () => {
    const readManifest = vi.fn(async () => JSON.stringify(manifest([GIT_ENTRY, CORESTORE_ENTRY])));
    const exists = (p: string) => !p.endsWith('corestore');
    await expect(readReusableCorestore('/seed', { readManifest, exists })).rejects.toThrow(/is missing on disk/);
  });
});

describe('isCorestoreLockedError (WI-4487)', () => {
  it('recognises the real fd-lock message a live operator produces', () => {
    // The exact string fd-lock throws (fd-lock/index.js) when the operator holds the
    // CORESTORE device file — the signature that we must fall back to a read-only open.
    expect(isCorestoreLockedError(new Error('File descriptor could not be locked'))).toBe(true);
  });

  it('does NOT swallow unrelated open failures (they must keep propagating)', () => {
    expect(isCorestoreLockedError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isCorestoreLockedError(new Error('Unsupported version: 3'))).toBe(false);
  });
});

describe('waitForOperatorDrain (WI-4487 — the operator owns the log append)', () => {
  const base = { workspaceId: 'ws-1', hive: 'papercusp' };

  /** Minimal postgres.Sql stand-in: each call returns the next queued undrained count. */
  const pgReturning = (counts: number[]) => {
    const calls = { n: 0 };
    const sql = (async () => [{ undrained: counts[Math.min(calls.n++, counts.length - 1)] }]) as never;
    return { sql, calls };
  };

  it('returns immediately when the operator has already drained to zero', async () => {
    const { sql, calls } = pgReturning([0]);
    const res = await waitForOperatorDrain({ ...base, pg: sql, warn: () => {} });
    expect(res.undrained).toBe(0);
    expect(calls.n).toBe(1);
  });

  it('waits for the live operator to drain the rows backfill enqueued, then proceeds', async () => {
    const { sql, calls } = pgReturning([7, 3, 0]);
    const sleep = vi.fn(async () => {});
    const res = await waitForOperatorDrain({ ...base, pg: sql, sleep, warn: () => {} });
    expect(res.undrained).toBe(0);
    expect(calls.n).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('refuses a quarantine that appears during a changing backlog instead of waiting forever', async () => {
    const states = [
      { undrained: 5, quarantined: 0, first_quarantined_id: null },
      { undrained: 9, quarantined: 1, first_quarantined_id: '42' },
    ];
    let calls = 0;
    const pg = vi.fn(async (strings: TemplateStringsArray) => {
      expect(strings.join('?')).toContain("to_jsonb(o.*) ->> 'quarantined_at'");
      return [states[Math.min(calls++, states.length - 1)]];
    }) as never;
    const sleep = vi.fn(async () => {});
    await expect(waitForOperatorDrain({ ...base, pg, sleep, warn: () => {} }))
      .rejects.toThrow(/1 QUARANTINED.*first id=42.*waiting for zero cannot complete/);
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('resets the stall clock when an external refill raises the backlog', async () => {
    // A second writer can refill rows after the first cut has reached a low-water mark.
    // The refill is new progress to wait on; the old low-water-only detector would throw
    // on the third poll even though the operator is about to drain the refill.
    const { sql } = pgReturning([5, 9, 9, 0]);
    let t = 0;
    const res = await waitForOperatorDrain({
      ...base,
      pg: sql,
      stallMs: 1_000,
      now: () => t,
      sleep: async () => {
        t += 600;
      },
      warn: () => {},
    });
    expect(res.undrained).toBe(0);
  });

  it('keeps waiting while the backlog SHRINKS, however long it takes (a real backfill is ~8k rows)', async () => {
    // Regression: a fixed total budget failed a perfectly healthy cut. ~8k rows drain at
    // ~55 rows/s ≈ 145s live, so elapsed time alone must never end the wait.
    const { sql } = pgReturning([8000, 6000, 4000, 2000, 0]);
    let t = 0;
    const res = await waitForOperatorDrain({
      ...base,
      pg: sql,
      stallMs: 120_000,
      now: () => (t += 60_000), // 60s per poll => 240s total elapsed, far past any fixed budget
      sleep: async () => {},
      warn: () => {},
    });
    expect(res.undrained).toBe(0); // progress, so we waited it out rather than falsely failing
  });

  it('REFUSES to cut a seed that would silently omit rows when the operator STALLS', async () => {
    const { sql } = pgReturning([5]); // stuck at 5 — no progress
    let t = 0;
    await expect(
      waitForOperatorDrain({
        ...base,
        pg: sql,
        stallMs: 1_000,
        now: () => (t += 600),
        sleep: async () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/NO progress draining 5 outbox row\(s\).*refusing to cut/s);
  });

  it('explains that the cut cannot drain on the operator\u2019s behalf (the data-loss trap)', async () => {
    const { sql } = pgReturning([2]);
    let t = 0;
    await expect(
      // idle-window-ok: this pure drain fixture advances an injected clock by100ms; no child boots.
      waitForOperatorDrain({ ...base, pg: sql, stallMs: 10, now: () => (t += 100), sleep: async () => {}, warn: () => {} }),
    ).rejects.toThrow(/cannot drain on its behalf without corrupting delivery state/);
  });

  // EI-18155637095067676: the default stall tolerance used to be an independent 120_000
  // constant that coincidentally EQUALED outbox-drain's own DRAIN_PASS_TIMEOUT_MS (also
  // 120s) \u2014 a single legitimate drain-pass self-heal (WI-2009) then raced the cut's own
  // stall detector and lost every time. Lock in that the default is DERIVED from the
  // drain's real constant and gives it strictly more than one full pass-timeout cycle.
  it('defaults the stall tolerance to strictly more than one outbox-drain pass-timeout cycle (no more coincidental-equal race, EI-18155637095067676)', () => {
    expect(CUT_SEED_DRAIN_STALL_MS).toBeGreaterThan(DRAIN_PASS_TIMEOUT_MS * 2);
    expect(CUT_SEED_DRAIN_STALL_MS).not.toBe(DRAIN_PASS_TIMEOUT_MS);
  });

  it('a single-pass-timeout-length stall (the exact race that used to fail the cut) no longer trips the default tolerance', async () => {
    // Simulate the diagnosed incident: undrained count is stuck for a span that reaches
    // exactly one DRAIN_PASS_TIMEOUT_MS (120s) of real elapsed no-progress (a single hung
    // pass self-healing), then resumes progress. `now`/`sleep` model real wall-clock time
    // advancing 60s per poll \u2014 independent of how many times the implementation happens to
    // call `now()` per iteration, unlike incrementing inside `now` itself. With the OLD
    // coincidentally-equal 120_000 default, stalledFor reaching exactly 120_000 THROWS
    // (stalledFor >= stallMs); the derived ~300s default must ride it out.
    const { sql } = pgReturning([100, 100, 100, 0]); // stuck for 2 full polls (120s), then drains
    let t = 0;
    const now = () => t;
    const sleep = async () => {
      t += 60_000;
    };

    // Sanity: confirm this exact scenario WOULD have thrown under the old literal default \u2014
    // otherwise the "no longer trips" assertion below would be vacuous.
    t = 0;
    await expect(
      waitForOperatorDrain({ ...base, pg: pgReturning([100, 100, 100, 0]).sql, stallMs: 120_000, now, sleep, warn: () => {} }),
    ).rejects.toThrow(/NO progress/);

    t = 0;
    const res = await waitForOperatorDrain({
      ...base,
      pg: sql,
      // no explicit stallMs \u2014 exercise the real default
      now,
      sleep,
      warn: () => {},
    });
    expect(res.undrained).toBe(0);
  });

  // WI-37500: the SAME defect one level up. The EI-18155637095067676 fix above accounts for the
  // drain's INTERNAL self-heal (a hung pass, ≤120s). It does not account for the larger one — a
  // bg-host PROCESS recycle by bghost-watchdog, during which nothing drains at all because the
  // drain's owner is not running. That envelope is BOOT_GRACE_MS (8min) + POLL_MS (30s) = 510s,
  // measured live 2026-08-09 as five consecutive 510-511s inter-restart gaps. The old 300s
  // budget therefore could not survive even ONE recycle, while a real cut needs ~20-25min of
  // draining — so the cut lost that race by construction.
  it('defaults the stall tolerance to strictly more than one full bghost-watchdog recycle envelope (WI-37500)', () => {
    const BGHOST_RECYCLE_ENVELOPE_MS = 8 * 60_000 + 30_000; // BOOT_GRACE_MS + POLL_MS = 510s
    expect(CUT_SEED_DRAIN_STALL_MS).toBeGreaterThan(BGHOST_RECYCLE_ENVELOPE_MS);
    // and still strictly more than the drain-pass cycle it already had to clear
    expect(CUT_SEED_DRAIN_STALL_MS).toBeGreaterThan(DRAIN_PASS_TIMEOUT_MS * 2);
  });

  it('a stall spanning a full bg-host recycle no longer trips the default tolerance (WI-37500)', async () => {
    // The measured incident: drain frozen while bg-host is recycled, then resumes. Model ~540s
    // of real no-progress (9 polls × 60s) followed by a drained backlog.
    const stuckThenDrained = () => pgReturning([...Array<number>(10).fill(100), 0]).sql;
    let t = 0;
    const now = () => t;
    const sleep = async () => {
      t += 60_000;
    };

    // Sanity control: this exact scenario MUST still throw under the OLD 300s default, or the
    // "no longer trips" assertion below is vacuous (the same discipline as the test above).
    t = 0;
    await expect(
      waitForOperatorDrain({ ...base, pg: stuckThenDrained(), stallMs: 300_000, now, sleep, warn: () => {} }),
    ).rejects.toThrow(/NO progress/);

    t = 0;
    const res = await waitForOperatorDrain({
      ...base,
      pg: stuckThenDrained(),
      // no explicit stallMs — exercise the real default
      now,
      sleep,
      warn: () => {},
    });
    expect(res.undrained).toBe(0);
  });
});

describe('openSourceStoreForCut (WI-4487 — readOnly is a point-in-time snapshot)', () => {
  const LOCKED = new Error('File descriptor could not be locked');

  /**
   * A fake store whose ready() fails for the writable open (as the live operator's lock
   * makes it) and succeeds read-only — recording the exact sequence of opens.
   */
  function harness(opts: { readonly locked: boolean }) {
    const calls: string[] = [];
    const openStore = (_dir: string, o?: { readOnly?: boolean; wait?: boolean }) => {
      const readOnly = o?.readOnly === true;
      calls.push(readOnly ? `open:ro(wait=${String(o?.wait)})` : 'open:rw');
      return {
        ready: async () => {
          if (!readOnly && opts.locked) throw LOCKED;
        },
        close: async () => {},
      } as never;
    };
    return { calls, openStore };
  }

  const base = {
    storeDir: '/tmp/store',
    workspaceId: 'ws',
    hive: 'papercusp',
    sparse: false,
    wantRefresh: true,
    pg: (async () => []) as never,
    warn: () => {},
  };

  it('refuses existing quarantined rows BEFORE backfill, drain, or opening a read-only snapshot', async () => {
    const { calls, openStore } = harness({ locked: true });
    const backfillImpl = vi.fn();
    const waitImpl = vi.fn();
    const pg = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      expect(sql).toContain('drained_at IS NULL');
      expect(sql).toContain("to_jsonb(o.*) ->> 'quarantined_at'");
      expect(values).toEqual(['ws', 'papercusp']);
      return [{ quarantined: 2, first_quarantined_id: '41' }];
    });
    await expect(openSourceStoreForCut({
      ...base, pg: pg as never, openStore,
      backfillImpl: backfillImpl as never, waitImpl: waitImpl as never,
    })).rejects.toThrow(/2 QUARANTINED.*first id=41.*refusing to omit them/);
    expect(backfillImpl).not.toHaveBeenCalled();
    expect(waitImpl).not.toHaveBeenCalled();
    expect(calls).toEqual(['open:rw']);
  });

  it('propagates quarantine preflight read failures without enqueueing a backfill', async () => {
    const { openStore } = harness({ locked: true });
    const backfillImpl = vi.fn();
    await expect(openSourceStoreForCut({
      ...base, openStore,
      pg: (async () => { throw new Error('quarantine inspection unavailable'); }) as never,
      backfillImpl: backfillImpl as never,
    })).rejects.toThrow('quarantine inspection unavailable');
    expect(backfillImpl).not.toHaveBeenCalled();
  });

  it('on a LIVE-operator box opens read-only only AFTER the drain completes — the seed must not be a pre-drain snapshot', async () => {
    const { calls, openStore } = harness({ locked: true });
    const res = await openSourceStoreForCut({
      ...base,
      openStore,
      backfillImpl: (async () => {
        calls.push('backfill');
        return { enqueued: 3, dropped: 0 };
      }) as never,
      waitImpl: (async () => {
        calls.push('drain');
        return { undrained: 0, waitedMs: 5 };
      }) as never,
    });

    expect(res.sourceWritable).toBe(false);
    // THE regression: a readOnly RocksDB open snapshots at open(), so opening before the
    // drain ships state frozen at that instant while still exiting 0. Order is the fix.
    expect(calls).toEqual(['open:rw', 'backfill', 'drain', 'open:ro(wait=false)']);
    expect(calls.indexOf('open:ro(wait=false)')).toBeGreaterThan(calls.indexOf('drain'));
  });

  it('pins wait:false on the read-only open (a truthy wait re-arms the DeviceFile lock readOnly avoids)', async () => {
    const { calls, openStore } = harness({ locked: true });
    await openSourceStoreForCut({
      ...base,
      wantRefresh: false,
      openStore,
    });
    expect(calls).toContain('open:ro(wait=false)');
  });

  it('a QUIESCED box still refreshes in-process against the writable store (no behaviour change)', async () => {
    const { calls, openStore } = harness({ locked: false });
    const res = await openSourceStoreForCut({
      ...base,
      openStore,
      refreshImpl: (async () => {
        calls.push('refresh:in-process');
        return {} as never;
      }) as never,
    });
    expect(res.sourceWritable).toBe(true);
    expect(calls).toEqual(['open:rw', 'refresh:in-process']);
    // Never falls back to a read-only open when it owns the store.
    expect(calls.some((c) => c.startsWith('open:ro'))).toBe(false);
  });

  it('propagates a non-lock open failure instead of silently degrading to read-only', async () => {
    const boom = new Error('corrupt manifest');
    const openStore = () => ({ ready: async () => { throw boom; }, close: async () => {} }) as never;
    await expect(openSourceStoreForCut({ ...base, openStore })).rejects.toThrow(/corrupt manifest/);
  });

  // ── WI-37488: the read-only open races the WAL churn the cut itself caused ─────────
  //
  // openSourceStoreForCut opens read-only immediately after forcing a full outbox drain +
  // a head-snapshot append. A readOnly open stats every file the MANIFEST references, so a
  // WAL the primary retires in that window throws ENOENT. Measured 2026-08-09: this killed
  // a cut AFTER a 1,090s drain, and five identical opens 30s later succeeded in 8-58ms.
  describe('read-only open retry (WI-37488 — a transient ENOENT must not waste the whole drain)', () => {
    /** The real RocksDB text, verbatim from the cut that died at 13:20:50Z. */
    const ENOENT_MSG =
      'While stat a file for size: /home/x/.papercusp/papercusp/hyperbee/db/002519.log: ' +
      'No such file or directory';

    /**
     * A store that is locked writable (as the live operator makes it) and whose read-only
     * open throws a TRANSIENT ENOENT for its first `flakyOpens` attempts, then succeeds.
     */
    function flakyRoHarness(flakyOpens: number) {
      const calls: string[] = [];
      let roOpens = 0;
      const openStore = (_dir: string, o?: { readOnly?: boolean; wait?: boolean }) => {
        const readOnly = o?.readOnly === true;
        if (!readOnly) {
          calls.push('open:rw');
          return { ready: async () => { throw LOCKED; }, close: async () => {} } as never;
        }
        roOpens += 1;
        const mine = roOpens;
        calls.push(`open:ro#${mine}`);
        return {
          ready: async () => {
            if (mine <= flakyOpens) throw new Error(ENOENT_MSG);
          },
          close: async () => { calls.push(`close:ro#${mine}`); },
        } as never;
      };
      return { calls, openStore, roOpens: () => roOpens };
    }

    const noSleep = async () => {};

    it('retries a transient ENOENT and completes the cut instead of throwing away the drain', async () => {
      const { calls, openStore, roOpens } = flakyRoHarness(3);
      const res = await openSourceStoreForCut({
        ...base,
        wantRefresh: false,
        openStore,
        sleep: noSleep,
      });
      expect(res.sourceWritable).toBe(false);
      // 3 losses then a win — the cut proceeds rather than dying after the full drain.
      expect(roOpens()).toBe(4);
      expect(calls).toContain('open:ro#4');
    });

    it('opens a FRESH store per attempt — a failed ready() leaves the instance unusable', async () => {
      const { calls, openStore } = flakyRoHarness(2);
      await openSourceStoreForCut({ ...base, wantRefresh: false, openStore, sleep: noSleep });
      // Each failed attempt is closed and a NEW one opened. Retrying on the same object
      // would just re-throw, so this ordering is the fix, not an implementation detail.
      expect(calls).toContain('close:ro#1');
      expect(calls).toContain('close:ro#2');
      expect(calls.indexOf('open:ro#2')).toBeGreaterThan(calls.indexOf('close:ro#1'));
    });

    /**
     * CONTROL (repo falsifiability discipline, tier 1): a permanently-resident model of the
     * PRE-FIX behaviour — one attempt, no retry — run against the SAME flaky harness. It
     * must FAIL. Without it, the passing tests above are consistent with a fake that never
     * actually throws, i.e. a guard that measures nothing.
     */
    it('CONTROL: the pre-fix single-attempt open fails against this same harness', async () => {
      const { openStore } = flakyRoHarness(3);
      const openOnceNoRetry = async () => {
        const store = openStore('/tmp/store', { readOnly: true, wait: false }) as unknown as {
          ready: () => Promise<void>;
        };
        await store.ready();
      };
      await expect(openOnceNoRetry()).rejects.toThrow(/No such file or directory/);
    });

    it('does NOT retry a non-transient failure — a corrupt manifest never self-clears', async () => {
      let roOpens = 0;
      const openStore = (_dir: string, o?: { readOnly?: boolean; wait?: boolean }) => {
        if (o?.readOnly !== true) {
          return { ready: async () => { throw LOCKED; }, close: async () => {} } as never;
        }
        roOpens += 1;
        return {
          ready: async () => { throw new Error('corrupt manifest'); },
          close: async () => {},
        } as never;
      };
      await expect(
        openSourceStoreForCut({ ...base, wantRefresh: false, openStore, sleep: noSleep }),
      ).rejects.toThrow(/corrupt manifest/);
      expect(roOpens).toBe(1);
    });

    it('an exhausted budget reports a TRANSIENT race, never the seed-degrading lock remedies', async () => {
      // The expensive half of the bug: the old message sent readers to --no-corestore /
      // --reuse-corestore / an outage, all of which ship a WORSE seed to dodge a condition
      // that clears by itself.
      const { openStore } = flakyRoHarness(Number.MAX_SAFE_INTEGER);
      let err: unknown;
      try {
        await openSourceStoreForCut({ ...base, wantRefresh: false, openStore, sleep: noSleep });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : '';
      expect(message).toMatch(/TRANSIENT race/);
      expect(message).toMatch(new RegExp(`all ${RO_OPEN_RETRY_ATTEMPTS} attempts`));
      // It must NOT recommend the remedies that degrade the seed.
      expect(message).not.toMatch(/PAPERCUSP_SKIP_SEED_CUT=1 \(release-local/);
      expect(message).not.toMatch(/this is not a plain lock conflict/);
    });

    it('classifies ENOENT as transient but a lock / corrupt manifest as not', () => {
      expect(isTransientStoreOpenError(new Error(ENOENT_MSG))).toBe(true);
      expect(isTransientStoreOpenError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(true);
      // The corestore lock has its own handling and never self-clears — swallowing it here
      // would turn a correct fast diagnosis into a silent 10s stall.
      expect(isTransientStoreOpenError(LOCKED)).toBe(false);
      expect(isTransientStoreOpenError(new Error('corrupt manifest'))).toBe(false);
      expect(isTransientStoreOpenError(new Error('EACCES: permission denied'))).toBe(false);
    });
  });

  // ── P-014 (D-012): --sparse REQUIRES a fresh head snapshot ────────────────────────
  // findLatestCompleteSnapshot scans back only SNAPSHOT_SCAN_LOOKBACK (4,000) ops, so a
  // sparse cut without a fresh tail snapshot resolves coreSparseFrom → 0 and silently
  // ships the FULL core. The 2026-07-21 release shipped 461,475 blocks / 1.9 GB labelled
  // "sparse" exactly this way.
  //
  // ⚠ P-019 CHANGED THE ANSWER ON THE LIVE-OPERATOR PATH, and the three tests that used
  // to assert a refusal there are gone, not merely renamed. P-014 refused because the
  // read-only path cannot append; that was correct given the mechanisms of the time, and
  // it made "no outage" and "sparse" mutually exclusive. P-019 adds the missing
  // mechanism — the cut ASKS the operator holding the store to append on its behalf — so
  // holding the store is no longer disqualifying. What IS disqualifying is having nobody
  // to ask, and that is what the surviving refusal tests below pin.
  describe('--sparse precondition (P-014 / D-012, revised by P-019)', () => {
    const live = {
      backfillImpl: (async () => ({ enqueued: 0, dropped: 0 })) as never,
      waitImpl: (async () => ({ undrained: 0, waitedMs: 1 })) as never,
    };
    const holderFound = (async () => ({
      kind: 'holder' as const,
      sibling: { port: 3070, pid: 4070, startedAt: 1 },
    })) as never;
    const noHolder = (async () => ({
      kind: 'no-holder' as const,
      answered: [3070],
      probed: [3070, 3170],
      staleBuild: [],
    })) as never;
    const snapshotProduced = (async () => ({
      kind: 'produced' as const,
      port: 3070,
      pid: 4070,
      process: 'operator',
      appended: true,
      coversUpTo: 461_475,
      chunkCount: 10,
      rowCount: 12_345,
      elapsedMs: 8_200,
    })) as never;

    it('P-019: ALLOWS a sparse cut on a LIVE-operator box once the operator appends the head snapshot', async () => {
      const { openStore } = harness({ locked: true });
      const res = await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        ...live,
        findHolderImpl: holderFound,
        headSnapshotImpl: snapshotProduced,
      });
      // The no-outage path AND a trimmed cut — the pair P-014 could not deliver together.
      expect(res.sourceWritable).toBe(false);
    });

    it('P-014 --no-force-backfill: forwards force:false but STILL drains AND snapshots (currency preserved)', async () => {
      const { openStore } = harness({ locked: true });
      const backfillImpl = vi.fn(async () => ({ enqueued: 0, dropped: 0 }));
      const waitImpl = vi.fn(async () => ({ undrained: 0, waitedMs: 5 }));
      const headSnapshotImpl = vi.fn(async () => ({
        kind: 'produced' as const,
        process: 'operator',
        appended: true,
        coversUpTo: 1,
        chunkCount: 1,
        rowCount: 1,
        elapsedMs: 1,
      }));
      await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        backfillImpl: backfillImpl as never,
        waitImpl: waitImpl as never,
        findHolderImpl: holderFound,
        headSnapshotImpl: headSnapshotImpl as never,
        forceBackfill: false,
      });
      expect(backfillImpl).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        force: false,
        maxOpsPerAuthor: 0,
      });
      // This pair IS the safety argument for the flag. Dropping the re-enqueue must not
      // drop the drain wait or the fresh head snapshot — those two are what make the
      // shipped sparse seed CURRENT, and without them the flag would silently ship stale.
      expect(waitImpl).toHaveBeenCalledTimes(1);
      expect(headSnapshotImpl).toHaveBeenCalledTimes(1);
    });

    it('WI-10001781: SURVIVES the transient CONNECTION_DESTROYED that killed the 0.0.21-alpha cut', async () => {
      // The exact error, verbatim from /tmp/papercup-release-cut.log at 2026-09-17T23:00:00Z.
      // Before the fix it propagated and aborted the cut during the seed phase — which runs
      // BEFORE any platform build, so the loss was the preflight work (3 min and 12 min on the
      // two attempts that night), not the 2.5h build. The pool it names reconnects on the very
      // next query, which is what makes discarding the run the wrong response to it.
      const { openStore } = harness({ locked: true });
      const destroyed = Object.assign(new Error('write CONNECTION_DESTROYED 127.0.0.1:6432'), {
        code: 'CONNECTION_DESTROYED',
      });
      let backfillCalls = 0;
      const backfillImpl = vi.fn(async () => {
        backfillCalls += 1;
        if (backfillCalls === 1) throw destroyed;
        return { enqueued: 7, dropped: 0 };
      });
      const waitImpl = vi.fn(async () => ({ undrained: 0, waitedMs: 5 }));

      const res = await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        backfillImpl: backfillImpl as never,
        waitImpl: waitImpl as never,
        findHolderImpl: holderFound,
        headSnapshotImpl: snapshotProduced,
      });

      expect(backfillCalls).toBe(2);
      expect(res.sourceWritable).toBe(false);
      // The cut must go on to do the rest of the refresh, not merely swallow the error.
      expect(waitImpl).toHaveBeenCalledTimes(1);
    });

    it('WI-10001781: a drain-wait blip does NOT re-run the backfill (separate retry scopes)', async () => {
      // Load-bearing, and invisible from the code unless asserted: the drain wait has been
      // measured at ~17 min for 35k rows (P-014). One shared retry scope would re-enqueue the
      // whole corpus to recover from a dropped socket during that wait.
      const { openStore } = harness({ locked: true });
      const backfillImpl = vi.fn(async () => ({ enqueued: 7, dropped: 0 }));
      let waitCalls = 0;
      const waitImpl = vi.fn(async () => {
        waitCalls += 1;
        if (waitCalls === 1) {
          throw Object.assign(new Error('write CONNECTION_DESTROYED 127.0.0.1:6432'), {
            code: 'CONNECTION_DESTROYED',
          });
        }
        return { undrained: 0, waitedMs: 5 };
      });

      await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        backfillImpl: backfillImpl as never,
        waitImpl: waitImpl as never,
        findHolderImpl: holderFound,
        headSnapshotImpl: snapshotProduced,
      });

      expect(waitCalls).toBe(2);
      expect(backfillImpl).toHaveBeenCalledTimes(1);
    });

    it('WI-10001781: does NOT retry a non-transient failure — a real fault still fails the cut', async () => {
      // The other half of the contract. A retry that swallows genuine breakage would turn a
      // loud 3-minute failure into a silently-wrong seed, which is strictly worse.
      const { openStore } = harness({ locked: true });
      const backfillImpl = vi.fn(async () => {
        throw Object.assign(new Error('null value in column "key" violates not-null constraint'), {
          code: '23502',
        });
      });

      await expect(
        openSourceStoreForCut({
          ...base,
          sparse: true,
          openStore,
          backfillImpl: backfillImpl as never,
          waitImpl: (async () => ({ undrained: 0, waitedMs: 1 })) as never,
          findHolderImpl: holderFound,
          headSnapshotImpl: snapshotProduced,
        }),
      ).rejects.toThrow('violates not-null constraint');
      expect(backfillImpl).toHaveBeenCalledTimes(1);
    });

    it('P-019: asks for the snapshot AFTER the drain and BEFORE the read-only open (D-012 ordering)', async () => {
      // Both halves are load-bearing and neither is visible from the code alone:
      //   • before the drain ⇒ the snapshot covers less than the seed ships;
      //   • after the read-only open ⇒ the snapshot lands in a log this cut, whose
      //     readOnly handle is a point-in-time view, can no longer see.
      const { calls, openStore } = harness({ locked: true });
      await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        backfillImpl: (async () => {
          calls.push('backfill');
          return { enqueued: 3, dropped: 0 };
        }) as never,
        waitImpl: (async () => {
          calls.push('drain');
          return { undrained: 0, waitedMs: 5 };
        }) as never,
        findHolderImpl: (async () => {
          calls.push('probe');
          return { kind: 'holder' as const, sibling: { port: 3070, pid: 4070, startedAt: 1 } };
        }) as never,
        headSnapshotImpl: (async () => {
          calls.push('head-snapshot');
          return {
            kind: 'produced' as const,
            port: 3070,
            pid: 4070,
            process: 'operator',
            appended: true,
            coversUpTo: 10,
            chunkCount: 1,
            rowCount: 2,
            elapsedMs: 1,
          };
        }) as never,
      });
      expect(calls).toEqual([
        'open:rw',
        'probe',
        'backfill',
        'drain',
        'head-snapshot',
        'open:ro(wait=false)',
      ]);
    });

    it('forwards an explicit head-snapshot timeout override without disabling the probe-derived default', async () => {
      const { openStore } = harness({ locked: true });
      const headSnapshotImpl = vi.fn(async () => ({
        kind: 'produced' as const,
        port: 3070,
        pid: 4070,
        process: 'operator',
        appended: true,
        coversUpTo: 10,
        chunkCount: 1,
        rowCount: 2,
        elapsedMs: 1,
      }));
      await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        backfillImpl: (async () => ({ enqueued: 0, dropped: 0 })) as never,
        waitImpl: (async () => ({ undrained: 0, waitedMs: 1 })) as never,
        findHolderImpl: holderFound,
        headSnapshotImpl: headSnapshotImpl as never,
        headSnapshotTimeoutMs: 12_345,
      });
      expect(headSnapshotImpl).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 12_345 }));
    });

    it('P-019: REFUSES incomplete holder discovery before backfill without claiming a boot invariant violation', async () => {
      // The P-014 fail-before-mutating invariant survives P-019 only because discovery is
      // a separate, side-effect-free probe. Rolling it into the expensive request would
      // have quietly handed that invariant back: backfillLocalState INSERTs into
      // substrate_outbox, and those rows would be enqueued for a doomed cut.
      const { openStore } = harness({ locked: true });
      const ran: string[] = [];
      const err = (await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        findHolderImpl: noHolder,
        detectWedgedListenerImpl: async () => null,
        // One look: this asserts the REFUSAL MESSAGE, not the recycle-waiting policy
        // (covered in live-head-snapshot-client.test.ts). Production waits out a recycle.
        holderWaitMs: 0,
        backfillImpl: (async () => {
          ran.push('backfill');
          return { enqueued: 0, dropped: 0 };
        }) as never,
        waitImpl: (async () => {
          ran.push('drain');
          return { undrained: 0, waitedMs: 1 };
        }) as never,
      }).then(
        () => new Error('expected a refusal, got a resolved cut'),
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toMatch(/--sparse requires a fresh head snapshot/);
      // The lock is held, but 3170 did not answer. Its boot state is unknown:
      // another sibling's negative answer cannot prove that the holder denies boot.
      expect(err.message).toContain('undetermined, NOT a D-025 violation');
      expect(err.message).not.toContain('D-025 INVARIANT VIOLATED');
      // Names the ports it looked at, so the verdict is diagnosable rather than bare.
      expect(err.message).toMatch(/3070 of probed 3070, 3170/);
      expect(ran).toEqual([]);
    });

    it('adds only confirmed passive accept-queue evidence to the refusal for unanswered ports', async () => {
      const { openStore } = harness({ locked: true });
      const samples = [
        { wedged: true, pending: 4, backlog: 128, pid: 4170 },
        { wedged: true, pending: 3, backlog: 128, pid: 4170 },
      ];
      const detectWedgedListenerImpl = vi.fn(async (url: string) => {
        expect(url).toBe(`http://127.0.0.1:3170${HEAD_SNAPSHOT_PATH}`);
        return samples.shift() ?? null;
      });
      const acceptQueueSamplePauseImpl = vi.fn(async (_ms: number) => {});

      const err = (await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        findHolderImpl: noHolder,
        headSnapshotImpl: noHolder,
        holderWaitMs: 0,
        detectWedgedListenerImpl,
        acceptQueueSamplePauseImpl,
      }).then(
        () => new Error('expected a refusal, got a resolved cut'),
        (e: unknown) => e,
      )) as Error;

      expect(detectWedgedListenerImpl).toHaveBeenCalledTimes(2);
      expect(acceptQueueSamplePauseImpl).toHaveBeenCalledWith(HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS);
      expect(err.message).toMatch(
        /persistent unaccepted connections \(port 3170: pending 4 -> 3, backlog 128 -> 128, pid 4170\)/,
      );
      expect(err.message).toMatch(/queue evidence only; it does not establish the listener's root cause/i);
    });

    it('does not report a wedge when the second passive sample shows the accept queue drained', async () => {
      const { openStore } = harness({ locked: true });
      const samples = [
        { wedged: true, pending: 2, backlog: 128, pid: 4170 },
        { wedged: false, pending: 0, backlog: 128, pid: 4170 },
      ];
      const detectWedgedListenerImpl = vi.fn(async (_url: string) => samples.shift() ?? null);
      const acceptQueueSamplePauseImpl = vi.fn(async (_ms: number) => {});

      const err = (await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        findHolderImpl: noHolder,
        headSnapshotImpl: noHolder,
        holderWaitMs: 0,
        detectWedgedListenerImpl,
        acceptQueueSamplePauseImpl,
      }).then(
        () => new Error('expected a refusal, got a resolved cut'),
        (e: unknown) => e,
      )) as Error;

      expect(detectWedgedListenerImpl).toHaveBeenCalledTimes(2);
      expect(acceptQueueSamplePauseImpl).toHaveBeenCalledWith(HEAD_SNAPSHOT_ACCEPT_QUEUE_RECHECK_MS);
      expect(err.message).not.toMatch(/persistent unaccepted connections/);
    });

    it('P-019: REFUSES (never silently degrades to FULL) when the holder cannot produce the snapshot', async () => {
      // This one necessarily lands after the drain — a holder that fails is not knowable
      // in advance. Refusing is still right: a silently-full "sparse" cut is
      // indistinguishable from a working one until somebody measures the installer, which
      // took three weeks last time.
      const { openStore } = harness({ locked: true });
      await expect(
        openSourceStoreForCut({
          ...base,
          sparse: true,
          openStore,
          ...live,
          findHolderImpl: holderFound,
          headSnapshotImpl: (async () => ({
            kind: 'failed' as const,
            port: 3070,
            error: 'this harness engine is stopped/closing.',
          })) as never,
        }),
      ).rejects.toThrow(/could not produce it: this harness engine is stopped/);
    });

    it('P-019: the refusal still offers the quiesce and drop-sparse remedies', async () => {
      const { openStore } = harness({ locked: true });
      const err = (await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        ...live,
        findHolderImpl: noHolder,
        detectWedgedListenerImpl: async () => null,
        // One look: this asserts the REFUSAL MESSAGE, not the recycle-waiting policy
        // (covered in live-head-snapshot-client.test.ts). Production waits out a recycle.
        holderWaitMs: 0,
      }).then(
        () => new Error('expected a refusal, got a resolved cut'),
        (e: unknown) => e,
      )) as Error;
      expect(err.message).toMatch(/quiesce the operator/);
      expect(err.message).toMatch(/PAPERCUSP_SEED_SPARSE=0/);
    });

    it('P-019: a QUIESCED sparse cut never consults the operator — it appends the snapshot itself', async () => {
      const { openStore } = harness({ locked: false });
      let asked = false;
      await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        refreshImpl: (async () => {}) as never,
        findHolderImpl: (async () => {
          asked = true;
          return { kind: 'no-holder' as const, answered: [], probed: [], staleBuild: [] };
        }) as never,
      });
      expect(asked).toBe(false);
    });

    it('REFUSES a sparse cut when --skip-corestore-refresh suppressed the snapshot', async () => {
      const { openStore } = harness({ locked: false });
      await expect(
        openSourceStoreForCut({ ...base, sparse: true, wantRefresh: false, openStore }),
      ).rejects.toThrow(/skip-corestore-refresh/);
    });

    it('REFUSES a sparse cut with no --workspace-id (no refresh scope ⇒ no snapshot)', async () => {
      const { openStore } = harness({ locked: false });
      await expect(
        openSourceStoreForCut({ ...base, sparse: true, workspaceId: undefined, openStore }),
      ).rejects.toThrow(/no --workspace-id/);
    });

    it('ALLOWS a sparse cut on a quiesced box, and passes sparse through so the snapshot is appended', async () => {
      const { openStore } = harness({ locked: false });
      let sawSparse: boolean | undefined;
      const res = await openSourceStoreForCut({
        ...base,
        sparse: true,
        openStore,
        refreshImpl: (async (a: { sparse?: boolean }) => {
          sawSparse = a.sparse;
        }) as never,
      });
      expect(sawSparse).toBe(true);
      expect(res.sourceWritable).toBe(true);
    });

    it('does NOT disturb the non-sparse live-operator path (WI-4487 no-outage cut still works)', async () => {
      const { openStore } = harness({ locked: true });
      const res = await openSourceStoreForCut({ ...base, sparse: false, openStore, ...live });
      expect(res.sourceWritable).toBe(false);
    });
  });
});
