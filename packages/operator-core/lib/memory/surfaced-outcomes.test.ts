import { describe, expect, it, vi } from 'vitest';
import { applyOutcomeRerank, captureSurfacedOutcome, citedMemoryIds, loadOutcomeCounts, recordSurfacedOutcome } from './surfaced-outcomes';
import type { SqlTag } from './bump-last-surfaced';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
function sqlReturning(rows: unknown[] = []) {
  const call = vi.fn(async () => rows);
  return { call, sql: call as unknown as SqlTag };
}

describe('surfaced memory outcomes', () => {
  it('demotes repeatedly contradicted memory, preserving source scores and stable unaffected ordering', () => {
    const entries = [A, B].map(id => ({ id, text: id, scope: 'harness:papercusp', score: 0.03 }));
    const counts = new Map([[A, { used: 3, contradicted: 2 }]]);
    const ranked = applyOutcomeRerank(entries, counts);
    expect(ranked.map(row => row.id)).toEqual([B, A]);
    expect(ranked[1]?.score).toBe(0.01);
    expect(entries[0]?.score).toBe(0.03);
    expect(applyOutcomeRerank(entries, new Map([[A, { used: 0, contradicted: 1 }]])).map(row => row.id)).toEqual([A, B]);
    expect(applyOutcomeRerank(entries.map(row => ({ ...row, score: 0 })), counts).map(row => row.id)).toEqual([B, A]);
  });

  it('exposes used and contradicted counts by memory id without guessing missing rows as zero', async () => {
    const { sql } = sqlReturning([{ id: A, used_count: 4, contradicted_count: 2 }]);
    const counts = await loadOutcomeCounts(sql, [A, B]);
    expect(counts.get(A)).toEqual({ used: 4, contradicted: 2 });
    expect(counts.has(B)).toBe(false);
  });

  it('refuses to invent a session or surface event; citations accept explicit memory IDs only', async () => {
    const { sql, call } = sqlReturning();
    await recordSurfacedOutcome(sql, '', [A], 'used');
    await recordSurfacedOutcome(sql, 'session', ['not-a-uuid'], 'contradicted');
    expect(call).not.toHaveBeenCalled();
    expect(await captureSurfacedOutcome(undefined, [A], 'used')).toEqual({ ok: true });
    expect(citedMemoryIds(`memory:${A}; arbitrary ${B}; memory:${A}`)).toEqual([A]);
  });
});
