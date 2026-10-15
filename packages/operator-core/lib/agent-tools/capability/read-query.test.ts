// token-efficiency-prompts-cache-and-behavior-2026-10-11 P-005 / R-5: saved-result query.
import { describe, expect, it } from 'vitest';
import { QUERY_OUTPUT_CHAR_BUDGET, querySavedResult, searchableView } from './read-query';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('querySavedResult', () => {
  it('finds a match on the very last line of a large text body', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `ok test ${i}`);
    lines.push('FAIL cache expiry drops the entry');
    const r = querySavedResult(buf(lines.join('\n')), { query: 'cache expiry' });
    expect(r.matchCount).toBe(1);
    expect(r.matches[0].line).toBe(5001);
    expect(r.matches[0].before).toEqual(['ok test 4998', 'ok test 4999']);
    expect(r.coverage.searchedLines).toBe(5001);
    expect(r.coverage.scannedToEnd).toBe(true);
  });

  it('requires every term (case-insensitive) on the same line', () => {
    const r = querySavedResult(buf('Cache hit\nexpiry only\nCACHE EXPIRY both'), { query: 'cache expiry', context: 0 });
    expect(r.matches.map((m) => m.line)).toEqual([3]);
  });

  it('searches one-line JSON pretty-printed and expands JSON inside MCP content text', () => {
    const inner = JSON.stringify({ results: [{ id: 'WI-1', state: 'open' }, { id: 'WI-2', state: 'failing' }] });
    const payload = JSON.stringify({ content: [{ type: 'text', text: inner }] });
    const header = 'spill header line\n';
    const r = querySavedResult(buf(header + payload), { query: 'failing', bodyOffset: Buffer.byteLength(header) });
    expect(r.view).toBe('mcp-content');
    expect(r.matchCount).toBe(1);
    expect(r.matches[0].text).toContain('"state": "failing"');
    expect(r.matches[0].before.join('\n')).toContain('WI-2');
  });

  it('reports coverage and upstream truncation markers on a zero-hit result', () => {
    const r = querySavedResult(buf(JSON.stringify({ items: [1, 2], _partial: true })), { query: 'nothing-here' });
    expect(r.matchCount).toBe(0);
    expect(r.matches).toEqual([]);
    expect(r.view).toBe('json-pretty');
    expect(r.coverage.upstreamPartialMarkers).toBe(1);
    expect(r.coverage.searchedLines).toBeGreaterThan(1);
  });

  it('stops at maxMatches but keeps counting, and resumes from nextFromLine', () => {
    const body = Array.from({ length: 50 }, (_, i) => `error ${i}`).join('\n');
    const first = querySavedResult(buf(body), { query: 'error', maxMatches: 5, context: 0 });
    expect(first.matches).toHaveLength(5);
    expect(first.matchCount).toBe(50);
    expect(first.nextFromLine).toBe(6);
    const next = querySavedResult(buf(body), { query: 'error', maxMatches: 5, context: 0, fromLine: first.nextFromLine! });
    expect(next.matches[0].line).toBe(6);
    expect(next.matchCount).toBe(45);
  });

  it('keeps output inside the result-door budget and clips very long lines', () => {
    const long = `${'x'.repeat(5000)} needle ${'y'.repeat(5000)}`;
    const body = Array.from({ length: 200 }, () => long).join('\n');
    const r = querySavedResult(buf(body), { query: 'needle', maxMatches: 100 });
    const emitted = r.matches.reduce((n, m) => n + m.text.length + m.before.join('').length + m.after.join('').length, 0);
    expect(emitted).toBeLessThanOrEqual(QUERY_OUTPUT_CHAR_BUDGET);
    expect(r.matches[0].text).toContain('needle');
    expect(r.matches[0].text.length).toBeLessThan(300);
    expect(r.nextFromLine).not.toBeNull();
  });

  // R-10: a query is cheaper than paging — the bytes it returns are a small fraction of the
  // saved result it searched (paging the same reference would return every byte).
  it('returns under 1% of the bytes of the large saved result it searched', () => {
    const line = `${'x'.repeat(5000)} needle ${'y'.repeat(5000)}`;
    const body = Array.from({ length: 200 }, (_, i) => (i % 50 === 0 ? line : `filler ${i} ${'z'.repeat(9990)}`)).join('\n');
    const r = querySavedResult(buf(body), { query: 'needle' });
    const returned = r.matches.reduce((n, m) => n + m.text.length + m.before.join('\n').length + m.after.join('\n').length, 0);
    expect(r.matchCount).toBe(4);
    expect(returned).toBeGreaterThan(0);
    expect(returned).toBeLessThan(Buffer.byteLength(body) / 100);
  });

  // R-5: the context window is the requested number of neighbouring lines on each side,
  // clipped at the body edges, defaulting to 2 and capped at 10.
  it('returns the requested context window around each match, clipped at the body edges', () => {
    const body = ['l1', 'l2 hit', 'l3', 'l4', 'l5', 'l6', 'l7 hit'].join('\n');
    const one = querySavedResult(buf(body), { query: 'hit', context: 1 });
    expect(one.matches.map((m) => [m.line, m.before, m.after])).toEqual([
      [2, ['l1'], ['l3']],
      [7, ['l6'], []],
    ]);
    const three = querySavedResult(buf(body), { query: 'hit', context: 3 });
    expect(three.matches[0].before).toEqual(['l1']);
    expect(three.matches[0].after).toEqual(['l3', 'l4', 'l5']);
    expect(three.matches[1].before).toEqual(['l4', 'l5', 'l6']);
    const dflt = querySavedResult(buf(body), { query: 'l7' });
    expect(dflt.matches[0].before).toEqual(['l5', 'l6']);
    const long = Array.from({ length: 30 }, (_, i) => (i === 15 ? 'hit' : `n${i}`)).join('\n');
    const capped = querySavedResult(buf(long), { query: 'hit', context: 50 });
    expect(capped.matches[0].before).toHaveLength(10);
    expect(capped.matches[0].after).toHaveLength(10);
  });

  it('falls back to plain text when a body that looks like JSON does not parse', () => {
    expect(searchableView(buf('{ not json\nsecond')).view).toBe('text');
  });
});
