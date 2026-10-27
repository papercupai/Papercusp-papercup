import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { coverageHash, type TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';
import { readTestCoverage, writeTestCoverage } from '@papercusp/test-config/test-coverage-store';
import { composeReuseBrief } from './reuse-brief-providers';
import { coverageBriefProvider, queryTestCoverage } from './test-coverage-map';

const hash = coverageHash('actual fixture source'), observedAt = new Date().toISOString();
const snapshot = (overrides: Partial<TestCoverageSnapshot> = {}): TestCoverageSnapshot => ({
  schemaVersion: 1, root: '/repo', scopeRoot: '/repo/pkg', testFile: 'pkg/a.test.ts', testSha256: hash,
  observedAt, populationComplete: true, population: [{ path: 'pkg/a.test.ts', sha256: hash }],
  sources: [{ path: 'pkg/a.ts', sha256: hash, executable: [2, 3], covered: [2] }], ...overrides,
});
const hashes = new Map([['pkg/a.test.ts', hash], ['pkg/a.ts', hash]]);
const ask = (snapshots: unknown[], currentHashes = hashes, population: string[] | null = ['pkg/a.test.ts']) =>
  queryTestCoverage({ root: '/repo', question: { path: 'pkg/a.ts', line1: 3, endLine1: 3, changedLines: [2, 3, 4] },
    snapshots, currentHashes, currentPopulation: population, staticTests: ['static.test.ts'] });
let pg: DedicatedNativePg, sql: ReturnType<typeof postgres>;
beforeAll(async () => {
  pg = await startDedicatedNativePg(); sql = postgres(pg.getConnectionUri(), { max: 2, onnotice: () => {} });
  await sql`CREATE SCHEMA harness_shared`;
  // Exercise the armed migration in an isolated real PostgreSQL instance.
  await sql.unsafe(await readFile(new URL('../../../../libs/papercusp/libs/db/sql/1566-test-coverage-map.sql', import.meta.url), 'utf8'));
}, 120_000);
afterAll(async () => { await sql?.end({ timeout: 3 }); await pg?.stop(); });

describe('P016 execution coverage freshness, retention and reuse advisory', () => {
  it('flags only measured uncovered changed lines and permits absence only for a complete population', () => {
    expect(ask([snapshot()])).toMatchObject({ basis: 'execution', tests: [], noTestExecutes: true,
      uncoveredChangedLines: [3], unknownChangedLines: [4] });
    expect(ask([snapshot({ populationComplete: false })])).toMatchObject({ basis: 'execution', noTestExecutes: null,
      uncoveredChangedLines: [], unknownChangedLines: [3, 4] });
    expect(ask([snapshot()], hashes, ['pkg/a.test.ts', 'new.test.ts']).noTestExecutes).toBeNull();
    expect(ask([snapshot()], hashes, null).noTestExecutes).toBeNull();
  });
  it('keeps positive evidence from an older still-bound capture; completeness stays with the newest', () => {
    // test:file runs unit and integration configs as separate captures. The newer capture must not
    // erase the older one's proof that its own (unchanged) test executes an (unchanged) line.
    const older = snapshot({ testFile: 'pkg/b.test.ts', observedAt: new Date(Date.now() - 60_000).toISOString(),
      population: [{ path: 'pkg/b.test.ts', sha256: hash }],
      sources: [{ path: 'pkg/a.ts', sha256: hash, executable: [2, 3], covered: [3] }] });
    const both = new Map([...hashes, ['pkg/b.test.ts', hash]]);
    expect(ask([snapshot(), older], both)).toMatchObject({ basis: 'execution', tests: ['pkg/b.test.ts'],
      noTestExecutes: false, uncoveredChangedLines: [], unknownChangedLines: [4] });
    // A capture whose test file changed since is not bound and proves nothing.
    expect(ask([snapshot(), older], new Map([...hashes, ['pkg/b.test.ts', coverageHash('edited test')]])))
      .toMatchObject({ basis: 'execution', tests: [], noTestExecutes: true, uncoveredChangedLines: [3] });
  });
  it('falls back to explicitly static reach for missing, stale, foreign or mismatched blobs', () => {
    for (const rows of [[], [snapshot({ root: '/sibling' })],
      [snapshot({ observedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() })],
      [snapshot({ sources: [{ ...snapshot().sources[0]!, sha256: coverageHash('other') }] })]]) {
      expect(ask(rows)).toMatchObject({ basis: 'static', tests: ['static.test.ts'], noTestExecutes: null });
    }
    expect(ask([snapshot()], new Map([['pkg/a.ts', hash]])).basis).toBe('static');
  });
  it('persists a latest snapshot, isolates workspace/root and physically applies age and count retention', async () => {
    await writeTestCoverage(sql, 'workspace', 'harness', [snapshot()], 'bound-run');
    expect(await readTestCoverage(sql, 'workspace', 'harness', '/repo', ['pkg/a.ts'])).toEqual([snapshot()]);
    expect(await readTestCoverage(sql, 'workspace', 'harness', '/repo', ['pkg/a.ts'], 'bound-run')).toEqual([snapshot()]);
    expect(await readTestCoverage(sql, 'workspace', 'harness', '/repo', ['pkg/a.ts'], 'other-run')).toEqual([]);
    expect(await readTestCoverage(sql, 'workspace', 'harness', '/repo', ['pkg/a.ts'], '')).toEqual([]);
    expect(await readTestCoverage(sql, 'other', 'harness', '/repo', ['pkg/a.ts'])).toEqual([]);
    expect(await readTestCoverage(sql, 'workspace', 'harness', '/sibling', ['pkg/a.ts'])).toEqual([]);
    await sql`INSERT INTO harness_shared.test_coverage_maps
      SELECT 'workspace', 'harness', '/repo', '/repo/pkg', 'old-' || n, now() - interval '9 days', NULL,
        ${sql.json(JSON.parse(JSON.stringify(snapshot())))} FROM generate_series(1, 2100) n`;
    await writeTestCoverage(sql, 'workspace', 'harness', [snapshot()]);
    const [{ count }] = await sql`SELECT count(*)::int count FROM harness_shared.test_coverage_maps`;
    expect(count).toBe(1);
    await sql`INSERT INTO harness_shared.test_coverage_maps
      SELECT 'workspace', 'harness', '/repo', '/repo/pkg', 'fresh-' || n, now(), NULL,
        ${sql.json(JSON.parse(JSON.stringify(snapshot())))} FROM generate_series(1, 2100) n`;
    await writeTestCoverage(sql, 'workspace', 'harness', [snapshot()]);
    const [{ count: retained }] = await sql`SELECT count(*)::int count FROM harness_shared.test_coverage_maps`;
    expect(retained).toBe(2000);
  });
  it('delivers qualified execution/fallback through the existing capped composer', async () => {
    const context = { surface: 'completion' as const, workspaceId: 'workspace', owner: 'test', invocation: 'test',
      paths: ['pkg/a.ts'], sourceVersion: 'version', repository: { workspaceId: 'workspace', rootPath: '/repo' },
      changedLines: { 'pkg/a.ts': [3] } };
    for (const snapshots of [[snapshot()], []]) {
      const provider = coverageBriefProvider(async () => ({ snapshots, currentHashes: hashes, population: ['pkg/a.test.ts'] }));
      const result = await composeReuseBrief({ base: { tests: [] as string[] }, context, deadline: Date.now() + 6000,
        providers: [provider], append: (base, contribution) => ({ tests: [...base.tests, contribution.text] }) });
      expect(result.observations[0]?.status).toBe('issued');
      expect(result.brief.tests[0]).toContain(snapshots.length ? 'changed lines 3' : 'static reach fallback');
    }
  });
});
