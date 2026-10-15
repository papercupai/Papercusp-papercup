// token-efficiency-prompts-cache-and-behavior-2026-10-11 R-10 (rubric rev 3): a saved-result query
// must cost less than paging the same reference. The population is pinned here so the bar cannot be
// passed trivially: a body of at least 1 MB, 4 matching lines (at most 5), default context (2 lines
// each side), and the WHOLE serialized query result — matched lines, context AND the coverage block —
// counted against the body's bytes. Paging the reference would return every byte of the body.
import { describe, expect, it } from 'vitest';
import { QUERY_DEFAULT_CONTEXT, querySavedResult } from './read-query';

const MATCH = `${'x'.repeat(5000)} needle ${'y'.repeat(5000)}`;
const FILLER = (i: number) => `filler ${i} ${'z'.repeat(9990)}`;

function fixture(): Buffer {
  const lines = Array.from({ length: 200 }, (_, i) => (i % 50 === 0 ? MATCH : FILLER(i)));
  return Buffer.from(lines.join('\n'), 'utf8');
}

describe('saved-result query cost (R-10)', () => {
  it('serializes every page needed to return all matches (with context and coverage) in under 1% of a >=1 MB body', () => {
    const body = fixture();
    expect(body.byteLength).toBeGreaterThanOrEqual(1_000_000);
    // The output budget may split the answer into pages; the cost of a query is every page a
    // caller must read to see ALL matches, so follow nextFromLine and count each page in full.
    const pages = [];
    let fromLine: number | undefined;
    do {
      const page = querySavedResult(body, { query: 'needle', ...(fromLine ? { fromLine } : {}) });
      pages.push(page);
      fromLine = page.nextFromLine ?? undefined;
    } while (fromLine !== undefined && pages.length < 10);
    const lines = pages.flatMap((p) => p.matches.map((m) => m.line));
    expect(lines).toEqual([1, 51, 101, 151]);
    expect(pages[0].matchCount).toBe(4);
    // default context really was applied, so context bytes are part of what is measured
    expect(pages[0].matches[1].before).toHaveLength(QUERY_DEFAULT_CONTEXT);
    expect(pages[0].matches[1].after).toHaveLength(QUERY_DEFAULT_CONTEXT);
    expect(pages.at(-1)!.coverage.scannedToEnd).toBe(true);
    const serialized = pages.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p), 'utf8'), 0);
    expect(serialized).toBeGreaterThan(0);
    expect(serialized).toBeLessThan(body.byteLength / 100);
  });
});
