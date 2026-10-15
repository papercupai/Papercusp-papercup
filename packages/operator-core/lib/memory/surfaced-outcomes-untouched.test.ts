import { describe, expect, it, vi } from 'vitest';
import type { SqlTag } from './bump-last-surfaced';
import { _resetSessionEpochLedgerForTests, stampSurfaced } from './session-epoch-ledger';
import { applyOutcomeRerank, loadOutcomeCounts } from './surfaced-outcomes';

describe('surfaced memory without a session action', () => {
  it('stamps delivery without assigning an outcome or changing outcome counters', async () => {
    _resetSessionEpochLedgerForTests();
    const id = '11111111-1111-4111-8111-111111111111';
    const statements: string[] = [];
    const query = vi.fn(async (template: TemplateStringsArray) => {
      statements.push(template.join('?'));
      return statements.length === 1 ? [] : [{ id, used_count: 0, contradicted_count: 0 }];
    });
    const sql = query as unknown as SqlTag;

    expect(await stampSurfaced(sql, 'untouched-reader', 0, [id], 'unit')).toBe(true);
    // The migration supplies outcome='ignored' and outcome_at=NULL. Delivery
    // must leave those defaults alone; PostgreSQL behavior is covered by the
    // companion surfaced-outcomes integration suite.
    expect(statements[0]).toContain('(session_id, epoch, memory_id, port)');
    expect(statements[0]).not.toMatch(/\boutcome(?:_at)?\b|\b(?:used|contradicted)_count\b/);
    expect(statements[0]).toContain('DO NOTHING');

    const counts = await loadOutcomeCounts(sql, [id]);
    expect(counts.get(id)).toEqual({ used: 0, contradicted: 0 });
    expect(statements[1]?.trim()).toMatch(/^SELECT\b/);
    const entries = [{ id, text: 'Delivered only', scope: 'harness:papercusp', score: 0.03 }];
    expect(applyOutcomeRerank(entries, counts)).toEqual(entries);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
