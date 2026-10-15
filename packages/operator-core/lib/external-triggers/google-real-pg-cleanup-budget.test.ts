import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Discover the maintained suites so adapter removal cannot strand this guard,
// and a newly added Google suite receives the same cleanup-budget check.
const REAL_PG_GOOGLE_SUITES = readdirSync(new URL('.', import.meta.url))
  .filter((name) => /^google-.*\.integration\.test\.ts$/.test(name))
  .sort()
  .map((name) => `./${name}`);

const STRICT_CLEANUP_BUDGET =
  /afterAll\s*\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await\s+org\?\.cleanup\(\);[\s\S]*?\},\s*300_000\s*\);/;

describe('Google real-PG cleanup hook budgets', () => {
  it('keeps the maintained Google integration suite census nonempty', () => {
    expect(REAL_PG_GOOGLE_SUITES.length).toBeGreaterThan(0);
  });

  it.each(REAL_PG_GOOGLE_SUITES)('%s retains the strict shared-container cleanup budget', (relativePath) => {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

    // Runtime teardown duration is load-dependent (observed beyond 90s), so a
    // behavior-only test can pass while this regression is reintroduced.
    expect(source).toMatch(STRICT_CLEANUP_BUDGET);
  });
});
