/** Feature projection column reader. Actual schema compatibility and the
 *  admission-column negative control run against canonical rig cells in
 *  composition-rig-schema-drift.integration.test.ts (WI-10005120/WI-10006495). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FEATURES_PROJECTION_FILE = resolve(HERE, '..', 'sync/hyperbee/projections/harness-features.ts');

const IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Pure, exported for its own coverage: the column list of the projection's
 * `INSERT INTO harness_shared.work_items (…) VALUES`.
 */
export function extractFeatureWriteColumns(projectionSource: string): string[] {
  const src = projectionSource.replace(/--[^\n]*/g, '');
  const matches = [...src.matchAll(/INSERT INTO harness_shared\.work_items\s*\(([\s\S]*?)\)\s*VALUES/g)];
  if (matches.length !== 1) {
    throw new Error(
      `extractFeatureWriteColumns: expected exactly one \`INSERT INTO harness_shared.work_items (…) VALUES\` ` +
        `in harness-features.ts, found ${matches.length} — did its shape change?`,
    );
  }
  return matches[0][1]
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

describe('federated feature write column reader', () => {
  it('reads the complete projection INSERT list, including admission and causal ordering', () => {
    const cols = extractFeatureWriteColumns(readFileSync(FEATURES_PROJECTION_FILE, 'utf8'));
    expect(cols.length).toBeGreaterThanOrEqual(40);
    for (const c of cols) expect(c).toMatch(IDENT);
    expect(cols).toEqual(expect.arrayContaining(['workspace_id', 'feature_id', 'admission', 'fed_hlc', 'closed_ts']));
  });

  it('refuses a missing or ambiguous writer instead of returning a vacuous column set', () => {
    expect(() => extractFeatureWriteColumns('SELECT 1')).toThrow('found 0');
    const source = readFileSync(FEATURES_PROJECTION_FILE, 'utf8');
    expect(() => extractFeatureWriteColumns(source + source)).toThrow('found 2');
  });
});
