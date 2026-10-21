import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fixtureSource = readFileSync(new URL('../test/_org-test-db.ts', import.meta.url), 'utf8');
const pgMigrateSource = readFileSync(new URL('../../../libs/test-config/src/pg-migrate.ts', import.meta.url), 'utf8');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sharedTestPgRoots = [
  'apps/operator/test',
  'libs/test-config/src',
  'libs/papercusp/libs/db/src',
  'packages/operator-core/lib',
];

function listTestSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTestSources(path);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function databaseNameVariable(sqlArgs: string): string | undefined {
  const createAt = sqlArgs.search(/\bCREATE\s+DATABASE\b/i);
  if (createAt < 0) return undefined;
  const afterCreate = sqlArgs.slice(createAt).replace(/^\bCREATE\s+DATABASE\b/i, '');
  return (
    afterCreate.match(/\$\{([A-Za-z_$][\w$]*)\}/)?.[1] ??
    afterCreate.match(/\+\s*([A-Za-z_$][\w$]*)\s*\+/)?.[1] ??
    afterCreate.match(/^\s*["']?([A-Za-z_][\w$]*)/)?.[1]
  );
}

// A test that exercises the UNMARKED-database sweeper must create unmarked
// databases on purpose. It opts out per site with this annotation on the line
// directly above the CREATE, and the annotation must carry a reason.
const DELIBERATELY_UNMARKED = /\btest-db-marker:\s*deliberately-unmarked\s+\S/;

type CreateSite = { file: string; line: number; client: string; name: string; nearby: string; exempt: boolean };

function sharedTestPgCreateSites(): CreateSite[] {
  const sites: CreateSite[] = [];
  for (const relativeRoot of sharedTestPgRoots) {
    const root = resolve(repoRoot, relativeRoot);
    for (const file of listTestSources(root)) {
      const source = readFileSync(file, 'utf8');
      if (!/\bgetTestPg\b/.test(source) || !/\bCREATE\s+DATABASE\b/i.test(source)) continue;
      const lines = source.split(/\r?\n/);

      const calls = /\bawait\s+([A-Za-z_$][\w$]*)\.unsafe\s*\(([\s\S]*?)\);/gi;
      for (const call of source.matchAll(calls)) {
        if (!/\bCREATE\s+DATABASE\b/i.test(call[2] ?? '')) continue;
        const client = call[1];
        const name = databaseNameVariable(call[2] ?? '');
        const offset = call.index ?? 0;
        const line = source.slice(0, offset).split('\n').length;
        const nearby = source.slice(offset + call[0].length).split(/\r?\n/, 2).join('\n');
        const exempt = DELIBERATELY_UNMARKED.test(lines[line - 2] ?? '');
        if (!client || !name) {
          sites.push({ file, line, client: client ?? '?', name: '?', nearby, exempt });
          continue;
        }
        sites.push({ file, line, client, name, nearby, exempt });
      }
    }
  }
  return sites;
}

describe('apps/operator org test database lifecycle', () => {
  it('uses the managed test-config lifecycle for creation and cleanup', () => {
    expect(fixtureSource).toContain("createFreshTestDb({ prefix: 'org' })");
    expect(fixtureSource).toContain('await db.drop()');
    expect(fixtureSource).not.toMatch(/\bCREATE DATABASE\b/i);
    expect(fixtureSource).not.toMatch(/\bDROP DATABASE\b/i);
  });

  it('marks disposable databases created directly on shared test-PG', () => {
    const sites = sharedTestPgCreateSites();
    const unmarked = sites.filter(({ client, name, nearby, exempt }) => {
      if (exempt) return false;
      if (client === '?' || name === '?') return true;
      const marker = new RegExp(
        `\\bmarkManagedTestDatabase\\s*\\(\\s*${escapeRegExp(client)}\\s*,\\s*${escapeRegExp(name)}\\s*\\)`,
      );
      return !marker.test(nearby);
    });

    expect(sites.length).toBeGreaterThan(0);
    expect(unmarked).toEqual([]);
  });

  it('accepts the deliberately-unmarked opt-out only with a stated reason', () => {
    expect(DELIBERATELY_UNMARKED.test('    // test-db-marker: deliberately-unmarked — sweeper subject')).toBe(true);
    expect(DELIBERATELY_UNMARKED.test('    // test-db-marker: deliberately-unmarked')).toBe(false);
    expect(DELIBERATELY_UNMARKED.test('    // test-db-marker: deliberately-unmarked   ')).toBe(false);
  });

  it('marks temporary template-build databases while keeping final templates on their readiness marker', () => {
    const buildCreateAt = pgMigrateSource.indexOf('await admin.unsafe(`CREATE DATABASE "${bld}"`);');
    expect(buildCreateAt).toBeGreaterThanOrEqual(0);
    expect(pgMigrateSource.slice(buildCreateAt, buildCreateAt + 180)).toContain(
      'await markManagedTestDatabase(admin, bld);',
    );
    expect(pgMigrateSource).toContain('COMMENT ON DATABASE "${name}" IS');
  });
});
