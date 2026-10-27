/**
 * WI-6554700010030028: a production module must never statically import a test-fixture JSON.
 *
 * esbuild inlines every statically imported JSON into each host bundle that reaches the importer.
 * `tool-delivery-acceptance.ts` imported six LLM-testing preregistration fixtures this way; it is
 * reachable from the host graph (scorecards.ts, rubric-instrument-registry.ts), so ~5 MB of fixture
 * data sat resident in every host process and pushed lint:host-bundle-builds over its budget
 * (81.2 MB at tip, 73.2 MB at the frozen repair head, budget 72 MB). Fixtures a runtime path needs
 * are read from disk on first use instead (see toolDeliveryPreregistrationFixtureDir).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const LIB_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** A static `import … from '…/fixtures/….json'` (or a bare side-effect import of one). */
const STATIC_FIXTURE_JSON_IMPORT =
  /^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]*\/fixtures\/[^'"]+\.json)['"]/m;

const isTestOnly = (rel: string) =>
  /(^|\/)__tests__\//.test(rel) || /(^|\/)fixtures\//.test(rel) || /(^|\/)test-support\//.test(rel)
  || /\.(test|spec|fixture|bench)\.[cm]?tsx?$/.test(rel) || /(^|\/)testing\//.test(rel);

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) productionSources(full, out);
    else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      const rel = relative(LIB_ROOT, full).split('\\').join('/');
      if (!isTestOnly(rel)) out.push(full);
    }
  }
  return out;
}

describe('no production module statically imports a fixture JSON (WI-6554700010030028)', () => {
  it('the pattern matches the shape that leaked (positive control)', () => {
    expect(STATIC_FIXTURE_JSON_IMPORT.test(
      "import candidatePreregistration from './llm-testing/fixtures/tool-delivery-full-after-use-20261021.json';",
    )).toBe(true);
    expect(STATIC_FIXTURE_JSON_IMPORT.test("import './llm-testing/fixtures/x.json';")).toBe(true);
    expect(STATIC_FIXTURE_JSON_IMPORT.test("const dir = './llm-testing/fixtures/';")).toBe(false);
    expect(isTestOnly('llm-testing/r6-malformed-call-oracle.ts')).toBe(false);
    expect(isTestOnly('tool-delivery-acceptance.test.ts')).toBe(true);
  });

  it('every non-test module under packages/operator-core/lib reads fixtures from disk, never by import', () => {
    const files = productionSources(LIB_ROOT);
    // A walk that found nothing would pass vacuously; the lib holds thousands of modules.
    expect(files.length).toBeGreaterThan(1000);
    const offenders = files.flatMap((file) => {
      const match = STATIC_FIXTURE_JSON_IMPORT.exec(readFileSync(file, 'utf8'));
      return match ? [`${relative(LIB_ROOT, file)} imports ${match[1]}`] : [];
    });
    expect(offenders).toEqual([]);
  });
});
