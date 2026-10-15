import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const consultDir = fileURLToPath(new URL('.', import.meta.url));
const integrationSources = readdirSync(consultDir)
  .filter((name) => name.endsWith('.integration.test.ts'))
  .map((name) => ({ name, source: readFileSync(join(consultDir, name), 'utf8') }));

const FRESH_DATABASE_CALL = /\bcreateFreshTestDb\s*\(/g;
// Matches `<name>[: <type>] = await createFreshTestDb(`; group 1 is the owning name.
// A type annotation stays on its line, so a commented `Note:` cannot become the name.
const FRESH_DATABASE_BINDING = /(?<![\w$])([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*await\s+createFreshTestDb\s*\(/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when every createFreshTestDb() result is bound to a name whose `.drop(`
 * follows an `afterAll(`. The owning name is derived from the binding, not a
 * fixed identifier list, so a renamed fixture (`privateDb`) is judged by the
 * same rule and dropping some other name does not count. A call bound to no
 * name cannot be dropped by name, so it fails.
 */
function dropsEveryOwnedFreshDatabase(source: string): boolean {
  const calls = source.match(FRESH_DATABASE_CALL)?.length ?? 0;
  const owners = [...source.matchAll(FRESH_DATABASE_BINDING)]
    .flatMap((match) => (match[1] ? [match[1]] : []));
  if (owners.length !== calls) return false;
  return owners.every((owner) => new RegExp(
    `\\bafterAll\\s*\\([\\s\\S]*?(?<![\\w$])${escapeRegExp(owner)}\\??\\.drop\\s*\\(`,
  ).test(source));
}

describe('consult PostgreSQL fixture ownership', () => {
  it('keeps per-run databases under the owned fixture helper', () => {
    const manualDatabaseOwners = integrationSources
      .filter(({ source }) => /\bCREATE\s+DATABASE\b|\bgetTestPg\s*\(|\bmarkManagedTestDatabase\s*\(/i.test(source))
      .map(({ name }) => name);

    expect(manualDatabaseOwners).toEqual([]);
  });

  it('drops every owned fresh database after its client closes', () => {
    const freshDatabaseOwners = integrationSources
      .filter(({ source }) => /\bcreateFreshTestDb\s*\(/.test(source));
    const missingDrop = freshDatabaseOwners
      .filter(({ source }) => !dropsEveryOwnedFreshDatabase(source))
      .map(({ name }) => name);

    expect(freshDatabaseOwners.length).toBeGreaterThan(0);
    expect(missingDrop).toEqual([]);
  });

  it('judges the name that owns the fresh database, not a fixed name list', () => {
    const fixture = (drop: string) => [
      'let privateDb;',
      `beforeAll(async () => { privateDb = await createFreshTestDb({ prefix: 'probe' }); });`,
      `afterAll(async () => { await sql.end(); ${drop} });`,
    ].join('\n');

    expect(dropsEveryOwnedFreshDatabase(fixture('await privateDb?.drop();'))).toBe(true);
    expect(dropsEveryOwnedFreshDatabase(fixture('await privateDb.drop();'))).toBe(true);
    expect(dropsEveryOwnedFreshDatabase([
      '// Note: a colon in a comment must not become the owning name.',
      `const fixtureDb: MigratedTestDb = await createFreshTestDb({ prefix: 'probe' });`,
      'afterAll(async () => { await fixtureDb.drop(); });',
    ].join('\n'))).toBe(true);

    // Each of these leaks the database the file created.
    expect(dropsEveryOwnedFreshDatabase(fixture(''))).toBe(false);
    expect(dropsEveryOwnedFreshDatabase(fixture('await fixtureDb?.drop();'))).toBe(false);
    expect(dropsEveryOwnedFreshDatabase(fixture('await sibling_privateDb?.drop();'))).toBe(false);
    expect(dropsEveryOwnedFreshDatabase([
      `beforeAll(() => { void createFreshTestDb({ prefix: 'probe' }); });`,
      'afterAll(async () => { await db?.drop(); });',
    ].join('\n'))).toBe(false);
  });
});
