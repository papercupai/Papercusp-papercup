/**
 * Keeps libs/generic/search/src/__fixtures__/embedding-space-parity-cases.json
 * honest (shared-vector-search-libraries-2026-09-29 P-001, AUTO-BAR-R-1-P-001
 * and AUTO-BAR-R-3-P-001). The library's embedding-space.test.ts replays that
 * fixture; this test rebuilds it from papercusp's code and the live tree and
 * requires the committed copy to be identical, which fails when:
 *   - a pinned output no longer matches what papercusp's functions return;
 *   - a filter call site is added, removed or changes its columns (census);
 *   - a chunk surface hands a spaceFilter new columns;
 *   - papercusp's accepted profiles, width, metric or legacy modes change, so
 *     the hostConfig the library replays is no longer papercusp's config.
 * Regenerate with embedding-space-parity-gen-cli.ts and review the diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEmbeddingSpaceParityFixture, censusFilterCallSites, chunkSurfaceSpaceColumns, renderRecordedSql, recordingSql } from './embedding-space-parity-cases';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../../../libs/generic/search/src/__fixtures__/embedding-space-parity-cases.json', import.meta.url));

describe('embedding-space parity fixture', () => {
  it('the committed fixture equals a rebuild from the current tree', () => {
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    const rebuilt = JSON.parse(JSON.stringify(buildEmbeddingSpaceParityFixture(REPO_ROOT))) as unknown;
    expect(rebuilt).toEqual(committed);
  });

  it('does not send parentless semantic-only surfaces through the vector-leg census', () => {
    expect(chunkSurfaceSpaceColumns().some((entry) => entry.surface === 'report')).toBe(false);
  });

  it('the census sees the known filter call sites (positive control)', () => {
    const sites = censusFilterCallSites(REPO_ROOT);
    expect(sites.some((s) => s.fn === 'proseProfileSql' && s.file.endsWith('agent-tools/search/sources.ts'))).toBe(true);
    expect(sites.some((s) => s.fn === 'effectiveStoredProseProfileIdSql' && s.literal?.profileColumn === 'wi.embedding_profile')).toBe(true);
    expect(sites.filter((s) => s.literal === null).every((s) => /profileColumn|profile\b/.test(s.args))).toBe(true);
  });

  it('the recording renderer numbers binds and inlines fragments', () => {
    const sql = recordingSql() as unknown as ((s: TemplateStringsArray, ...v: unknown[]) => unknown) & { unsafe: (t: string) => unknown };
    const inner = sql`b = ${2}`;
    expect(renderRecordedSql(sql`SELECT  ${sql.unsafe('x')}
      WHERE a = ${1} AND ${inner} AND c = ANY(${['p', 'q']}::text[])`)).toEqual({
      text: 'SELECT x WHERE a = $1 AND b = $2 AND c = ANY($3::text[])',
      binds: [1, 2, ['p', 'q']],
    });
  });
});
