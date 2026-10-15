import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { getOrgPg } from '@papercusp/db-org';
import { recordIsolatedIntegrationProof, withIsolatedIntegrationSourceObserver,
  type CommittedReaderObservationCohort, type CommittedReaderPreparationHandoff } from '../test/isolated-integration-proof';
import type { CommittedReaderPreparationInputs } from '../test/private-http-workspace-preflight';
import { verifierSourceFiles } from './verifier-source';
import * as orgTestDb from '../test/_org-test-db';
import { FALLBACK_FLUSH_DELAY_MS, flushFallbackObservations } from './degradation/fallback-observations';
import { noteSidecarFallback, resetSidecarFallbackStatsForTest } from './fleet/git-via-sidecar';

beforeEach(resetSidecarFallbackStatsForTest);
afterEach(resetSidecarFallbackStatsForTest);

async function expectPrivateDatabaseDropped(database: string) {
  const admin = postgres(await getTestPg(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    // Maintained cleanup can defer behind another fixture's drop. Measure its
    // completion rather than treating cleanup's return as proof of removal.
    await expect.poll(async () => {
      const rows = await admin`SELECT datname FROM pg_database WHERE datname = ${database}`;
      return rows.length;
    }, { timeout: 30_000, interval: 100 }).toBe(0);
    process.stdout.write(`PARENT_SOURCE_OBSERVER_CLEANUP ${JSON.stringify({ database, removed: true })}\n`);
  } finally { await admin.end({ timeout: 5 }); }
}

it('owns delayed parent source-reader fallback observations in a private migrated database', async () => {
  const env = { ...process.env };
  const workspace = `parent-source-observer-${process.pid}`;
  const result = await withIsolatedIntegrationSourceObserver(async sql => {
    const [{ database }] = await getOrgPg().sql<{ database: string }[]>`SELECT current_database() AS database`;
    expect(database).toMatch(/^org_/);
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG).toBe(env.PAPERCUSP_FORBID_LIVE_PG);
    expect(process.env.PAPERCUSP_FORBID_LIVE_PG_TARGETS).toBe(env.PAPERCUSP_FORBID_LIVE_PG_TARGETS);
    // Exercise the exact rejected-reader reporter, including its ordinary
    // delayed flush; a flush-time override alone would not own this timer.
    process.env.PAPERCUSP_WORKSPACE_ID = workspace;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noteSidecarFallback('committed-tree-reader', new Error('parent-source-observer-test'), undefined, 'rejected');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        '[committed-tree-reader] spawner-sidecar rejected; local execution avoided: parent-source-observer-test'));
    } finally { warning.mockRestore(); }
    const deadline = Date.now() + FALLBACK_FLUSH_DELAY_MS + 5_000;
    let rows: Array<{ reason: string; eligible: number; applied: number }> = [];
    while (Date.now() < deadline) {
      rows = await sql<typeof rows>`SELECT reason, eligible, applied
        FROM harness_shared.fallback_observations WHERE workspace_id = ${workspace}`;
      if (rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(rows).toEqual([{ reason: 'local-execution-rejected', eligible: 1, applied: 0 }]);
    return database;
  }).finally(() => {
    if (env.PAPERCUSP_WORKSPACE_ID === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = env.PAPERCUSP_WORKSPACE_ID;
  });
  expect(result.database).toBe(result.value);
  expect(result.flush.failed).toBe(0);
  await expectPrivateDatabaseDropped(result.database);
  expect(process.env.HARNESS_DATABASE_URL).toBe(env.HARNESS_DATABASE_URL);
  expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(env.HARNESS_ADMIN_DATABASE_URL);
  expect(process.env.PAPERCUSP_PGBOUNCER).toBe(env.PAPERCUSP_PGBOUNCER);
  expect(process.env.PAPERCUSP_SKIP_PG_DISCOVERY).toBe(env.PAPERCUSP_SKIP_PG_DISCOVERY);
  expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 0 });
}, 120_000);

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Synthetic originals exercise the handoff contract only. They do not attest
 * actual loader/config/schema/environment collection or any loaded host. */
function originalPreparation() {
  const dir = mkdtempSync(join(tmpdir(), 'original-preparation-')); temporary.push(dir);
  const root = join(dir, 'source'); mkdirSync(root);
  for (const path of ['reader.test.ts', 'helper.ts', 'config.ts', 'import.ts', 'asset.sql'])
    writeFileSync(join(root, path), path);
  const source = { schemaVersion: 'verifier-source-v1', sourceCommit: 'a'.repeat(40),
    testedInputs: [{ path: 'reader.test.ts', sha256: digest('reader.test.ts') }], files: verifierSourceFiles(root) };
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(source));
  const sourceReceiptPath = join(dir, 'source.json'); writeFileSync(sourceReceiptPath, JSON.stringify(source));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'example.js'), 'module.exports = 1;');
  const inputs: CommittedReaderPreparationInputs = { sourceCommit: source.sourceCommit, phase: 'planned',
    testPaths: ['reader.test.ts'], helperPaths: ['helper.ts'], configPaths: ['config.ts'], executedImports: ['import.ts'],
    dependencyFiles: verifierSourceFiles(join(root, 'node_modules')), externalResolutions: {},
    copiedSources: ['asset.sql'], copiedArtifacts: [{ path: 'asset.sql', sourcePath: 'asset.sql' }],
    schema: { 'private.actual_column': digest('jsonb:not-null') }, environment: { PRIVATE_WORKER: digest('0') },
    omitted: [], opaque: [] };
  const inputReceiptPath = join(dir, 'inputs.json'); writeFileSync(inputReceiptPath, JSON.stringify(inputs));
  const handoff: CommittedReaderPreparationHandoff = { root, selectedCommit: source.sourceCommit,
    sourceReceiptPath, sourceReceiptSha256: digest(readFileSync(sourceReceiptPath)),
    inputReceiptPath, inputReceiptSha256: digest(readFileSync(inputReceiptPath)),
    observationReceiptPath: join(dir, 'observations.json'), observationReceiptSha256: '' };
  const identity = { sourceCommit: source.sourceCommit, runId: 'original-run', process: { pid: 42, identity: 'original-process-start' } };
  const values = { source, dependencies: { files: inputs.dependencyFiles, externalResolutions: inputs.externalResolutions },
    config: inputs.configPaths, imports: inputs.executedImports, schema: inputs.schema, environment: inputs.environment };
  const cohort: CommittedReaderObservationCohort = { ...identity, sourceRoot: root,
    sourceReceipt: { path: sourceReceiptPath, sha256: handoff.sourceReceiptSha256 },
    inputReceipt: { path: inputReceiptPath, sha256: handoff.inputReceiptSha256 },
    observations: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { ...structuredClone(identity), value }])) as
      CommittedReaderObservationCohort['observations'], omitted: [], opaque: [] };
  const save = () => {
    writeFileSync(inputReceiptPath, JSON.stringify(inputs));
    handoff.inputReceiptSha256 = digest(readFileSync(inputReceiptPath));
    cohort.inputReceipt.sha256 = handoff.inputReceiptSha256;
    writeFileSync(handoff.observationReceiptPath, JSON.stringify(cohort));
    handoff.observationReceiptSha256 = digest(readFileSync(handoff.observationReceiptPath));
  };
  save();
  return { root, dir, handoff, inputs, cohort, identity, save };
}

describe('D046 original preparation handoff', () => {
  const recorderRoot = resolve(import.meta.dirname, '../../..');
  const filePath = 'packages/operator-core/lib/isolated-integration-source-observer.integration.test.ts';
  const invoke = (f: ReturnType<typeof originalPreparation>, prepare = async (_dir: string) => f.handoff,
    execute = vi.fn(async () => { throw new Error('synthetic consumer reached'); })) => ({ execute,
    run: () => recordIsolatedIntegrationProof({ root: recorderRoot, filePath, sourcePaths: [],
      requiredPreparation: f.identity, prepare, execute }) });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses missing original %s before observer allocation or consumer', async dimension => {
      const f = originalPreparation(); delete (f.cohort.observations as Partial<typeof f.cohort.observations>)[dimension]; f.save();
      const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb'); const { run, execute } = invoke(f);
      await expect(run()).rejects.toThrow(/Original dimension identity is missing/);
      expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses cross-run original %s before allocation', async dimension => {
      const f = originalPreparation(); f.cohort.observations[dimension].runId = 'other-run'; f.save();
      const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb'); const { run, execute } = invoke(f);
      await expect(run()).rejects.toThrow(/cohort identity differs/);
      expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });

  it.each(['source', 'dependencies', 'config', 'imports', 'schema', 'environment'] as const)(
    'refuses mismatched original %s membership before allocation', async dimension => {
      const f = originalPreparation(); f.cohort.observations[dimension].value = ['not-the-planned-observation']; f.save();
      const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb'); const { run, execute } = invoke(f);
      await expect(run()).rejects.toThrow(new RegExp(`Original ${dimension} observation differs`));
      expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });

  it.each(['omitted', 'opaque', 'reference', 'process', 'source-bytes', 'dependency-bytes', 'input-digest',
    'observation-digest', 'planned-config', 'planned-imports', 'planned-schema', 'planned-environment', 'copy-map'])(
    'refuses invalid %s before observer allocation', async defect => {
      const f = originalPreparation();
      if (defect === 'omitted' || defect === 'opaque') f.cohort[defect] = ['unobserved'];
      else if (defect === 'reference') f.cohort.sourceCommit = 'b'.repeat(40);
      else if (defect === 'process') f.cohort.process = { pid: 43, identity: 'different-process' };
      else if (defect === 'source-bytes') writeFileSync(join(f.root, 'helper.ts'), 'drift');
      else if (defect === 'dependency-bytes') writeFileSync(join(f.root, 'node_modules', 'example.js'), 'drift');
      else if (defect === 'planned-config') f.inputs.configPaths = [];
      else if (defect === 'planned-imports') f.inputs.executedImports = [];
      else if (defect === 'planned-schema') f.inputs.schema = {};
      else if (defect === 'planned-environment') f.inputs.environment = {};
      else if (defect === 'copy-map') f.inputs.copiedArtifacts = [];
      f.save();
      if (defect === 'input-digest') writeFileSync(f.handoff.inputReceiptPath, readFileSync(f.handoff.inputReceiptPath, 'utf8') + '\n');
      if (defect === 'observation-digest') writeFileSync(f.handoff.observationReceiptPath, readFileSync(f.handoff.observationReceiptPath, 'utf8') + '\n');
      const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb'); const { run, execute } = invoke(f);
      await expect(run()).rejects.toThrow();
      expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    });

  it('refuses a missing required handoff before observer allocation', async () => {
    const f = originalPreparation(); const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb'); const execute = vi.fn();
    await expect(recordIsolatedIntegrationProof({ root: recorderRoot, filePath, sourcePaths: [],
      requiredPreparation: f.identity, prepare: () => {}, execute })).rejects.toThrow(/handoff is missing/);
    expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('refuses original-byte drift during retention before observer allocation', async () => {
    const f = originalPreparation(); const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb');
    // The first async retained write yields to the original producer. The
    // existing before/after byte check must detect that handoff race.
    const { run, execute } = invoke(f, async () => {
      setImmediate(() => writeFileSync(f.handoff.inputReceiptPath, readFileSync(f.handoff.inputReceiptPath, 'utf8') + '\n'));
      return f.handoff;
    });
    await expect(run()).rejects.toThrow(/Selected input receipt changed/);
    expect(allocate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });

  it('retains exact originals and selected identity before the consumer, then observes exception cleanup', async () => {
    const f = originalPreparation(); let retained = '';
    const { run, execute } = invoke(f, async dir => { retained = dir; return f.handoff; });
    await expect(run()).rejects.toThrow(/synthetic consumer reached/);
    expect(execute).toHaveBeenCalledOnce();
    for (const [file, original] of [['verifier-source.json', f.handoff.sourceReceiptPath],
      ['operator-api-inputs.json', f.handoff.inputReceiptPath], ['original-observations.json', f.handoff.observationReceiptPath]])
      expect(readFileSync(join(retained, file))).toEqual(readFileSync(original));
    const source = JSON.parse(readFileSync(join(retained, 'source.json'), 'utf8'));
    expect(source).toMatchObject({ sourceCommit: f.identity.sourceCommit, repoRoot: f.root,
      originalPreparation: { identity: f.identity, handoff: f.handoff } });
    expect(source.files).toEqual(JSON.parse(readFileSync(f.handoff.sourceReceiptPath, 'utf8')).files);
    await expectPrivateDatabaseDropped(source.parentObserver.database);
    expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 0 });
  }, 120_000);

  it('refuses retained-byte tampering before the consumer and drops the original observer', async () => {
    const f = originalPreparation(); let retained = ''; let database = '';
    const create = orgTestDb.createOrgTestDb;
    const allocate = vi.spyOn(orgTestDb, 'createOrgTestDb');
    allocate.mockImplementation(async (...args) => {
      const db = await create(...args); database = db.dbName;
      writeFileSync(join(retained, 'operator-api-inputs.json'), 'tampered');
      return db;
    });
    const { run, execute } = invoke(f, async dir => { retained = dir; return f.handoff; });
    await expect(run()).rejects.toThrow(/Retained original preparation bytes changed/);
    expect(execute).not.toHaveBeenCalled(); await expectPrivateDatabaseDropped(database);
  }, 120_000);

  it('preserves the legacy source-only order and exception cleanup', async () => {
    let retained = ''; const execute = vi.fn(async () => { throw new Error('legacy consumer reached'); });
    await expect(recordIsolatedIntegrationProof({ root: recorderRoot, filePath, sourcePaths: [],
      prepare: dir => { retained = dir; expect(existsSync(join(dir, 'source.json'))).toBe(true); }, execute }))
      .rejects.toThrow(/legacy consumer reached/);
    expect(execute).toHaveBeenCalledOnce();
    const source = JSON.parse(readFileSync(join(retained, 'source.json'), 'utf8'));
    expect(source).not.toHaveProperty('originalPreparation');
    await expectPrivateDatabaseDropped(source.parentObserver.database);
  }, 120_000);
});

it('drains the parent observer before restoring its environment when source capture throws', async () => {
  const adminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  let database = '';
  await expect(withIsolatedIntegrationSourceObserver(async sql => {
    [{ database }] = await sql<{ database: string }[]>`SELECT current_database() AS database`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      noteSidecarFallback('committed-tree-reader', new Error('parent-capture-failed-test'), undefined, 'rejected');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        '[committed-tree-reader] spawner-sidecar rejected; local execution avoided: parent-capture-failed-test'));
    } finally { warning.mockRestore(); }
    throw new Error('source capture failed');
  })).rejects.toThrow('source capture failed');
  expect(database).toMatch(/^org_/);
  await expectPrivateDatabaseDropped(database);
  expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(adminUrl);
  // No deferred row may survive to resolve the restored ambient pool.
  expect(await flushFallbackObservations()).toMatchObject({ written: 0, failed: 0 });
}, 120_000);
