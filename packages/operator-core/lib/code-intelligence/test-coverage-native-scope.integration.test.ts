import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coverageHash, type TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';
import { writeTestCoverage } from '@papercusp/test-config/test-coverage-store';
import { createFreshPgDb, applyMigrationForTest, type FreshPgDb } from '../../test/_pg-helpers';
import type { ReuseProviderContext } from './reuse-brief-providers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, projects: [] as Array<{ path: string; slug: string }> }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: h.projects }) }));
const { readNativeCoverageScope, queryTestCoverage } = await import('./test-coverage-map');

const WS = 'coverage-verifier-workspace';
const HARNESS = 'coverage-verifier';
const SOURCE = 'pkg/source.ts';
const TEST = 'pkg/source.test.ts';
const source = 'export const answer = 42;\n';
const test = 'export const fixture = true;\n';
let db: FreshPgDb;
let base: string;
let canonical: string;
let retained: string;
let sha: string;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'coverage fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'coverage fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  } }).trim();
}
const marker = () => join(retained, '.git/lint-as-committed-owner.json');
async function writeMarker(overrides = {}) {
  await writeFile(marker(), JSON.stringify({ sha, sourceRepoRoot: canonical, keep: true, ...overrides }));
}
function snapshot(root = retained): TestCoverageSnapshot {
  return { schemaVersion: 1, root, scopeRoot: join(root, 'pkg'), testFile: TEST, testSha256: coverageHash(test),
    observedAt: new Date().toISOString(), populationComplete: true, population: [{ path: TEST, sha256: coverageHash(test) }],
    sources: [{ path: SOURCE, sha256: coverageHash(source), executable: [1], covered: [1] }] };
}
function context(root = retained, harness = HARNESS): ReuseProviderContext {
  const sourceFiles = [{ path: SOURCE, sha256: coverageHash(source) }];
  return { surface: 'completion', workspaceId: WS, owner: 'fixture', invocation: 'fixture', paths: [SOURCE],
    sourceVersion: coverageHash(JSON.stringify(sourceFiles.map(s => [s.path, s.sha256]))), sourceFiles,
    repository: { workspaceId: WS, rootPath: root, harness } };
}
const read = (ctx = context()) => readNativeCoverageScope(ctx, AbortSignal.timeout(30_000));

beforeAll(async () => {
  db = await createFreshPgDb('native-coverage-retained-scope');
  h.sql = db.sql;
  await applyMigrationForTest(db.sql, new URL('../../../../libs/papercusp/libs/db/sql/1566-test-coverage-map.sql', import.meta.url).pathname);
  base = await realpath(await mkdtemp(join(tmpdir(), 'native-coverage-scope-')));
  canonical = join(base, 'canonical'); retained = join(base, 'retained');
  await mkdir(join(canonical, 'pkg'), { recursive: true });
  await writeFile(join(canonical, SOURCE), source);
  await writeFile(join(canonical, TEST), test);
  git(canonical, 'init', '--quiet'); git(canonical, 'add', '.'); git(canonical, 'commit', '--quiet', '-m', 'coverage fixture');
  sha = git(canonical, 'rev-parse', 'HEAD');
  git(base, 'clone', '--quiet', '--local', '--shared', canonical, retained);
}, 120_000);
afterAll(async () => { await db?.cleanup(); if (base) await rm(base, { recursive: true, force: true }); });
beforeEach(async () => {
  h.projects = [{ path: canonical, slug: HARNESS }];
  await writeFile(join(retained, SOURCE), source);
  await writeMarker();
  await db.sql`DELETE FROM harness_shared.test_coverage_maps`;
});

describe('native coverage scope for maintained committed verifier trees', () => {
  it('reads physical retained-root execution without registering or rebasing the artifact', async () => {
    await writeTestCoverage(db.sql, WS, HARNESS, [snapshot()], 'retained-run');
    const scope = await read();
    expect(scope?.snapshots).toEqual([expect.objectContaining({ root: retained, testFile: TEST })]);
    expect(queryTestCoverage({ root: retained, question: { path: SOURCE, line1: 1 }, snapshots: scope!.snapshots,
      currentHashes: scope!.currentHashes, currentPopulation: scope!.population })).toMatchObject({ basis: 'execution', tests: [TEST] });
    expect(h.projects).toEqual([{ path: canonical, slug: HARNESS }]);
  });

  it('keeps canonical coverage and both workspace and harness boundaries', async () => {
    await writeTestCoverage(db.sql, WS, HARNESS, [snapshot(canonical)]);
    expect((await read(context(canonical)))?.snapshots).toHaveLength(1);
    expect((await read())?.snapshots).toEqual([]);
    expect(await read(context(retained, 'foreign-harness'))).toBeNull();
    h.projects = [];
    expect(await read({ ...context(), workspaceId: 'foreign-workspace' })).toBeNull();
  });

  it('refuses missing or forged provenance, an unregistered donor, and a mismatched commit', async () => {
    await rm(marker());
    expect(await read()).toBeNull();
    await writeMarker({ sha: '0'.repeat(40) });
    expect(await read()).toBeNull();
    await writeMarker({ sourceRepoRoot: base });
    expect(await read()).toBeNull();
  });

  it('refuses changed retained source and source-mismatched execution observations', async () => {
    await writeTestCoverage(db.sql, WS, HARNESS, [snapshot()]);
    await writeFile(join(retained, SOURCE), 'export const changed = true;\n');
    expect(await read()).toBeNull();
    await writeFile(join(retained, SOURCE), source);
    const wrong = snapshot(); wrong.sources[0]!.sha256 = coverageHash('other source');
    await writeTestCoverage(db.sql, WS, HARNESS, [wrong]);
    expect((await read())?.snapshots).toEqual([]);
    expect(await readFile(join(retained, SOURCE), 'utf8')).toBe(source);
  });
});
