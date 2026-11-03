import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ explainReadQuery: vi.fn() }));

vi.mock('./pg-read-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pg-read-query')>();
  return { ...actual, explainReadQuery: mocks.explainReadQuery };
});

import { PG_READ_QUERY_CALL_OVERHEAD_MS, PG_READ_QUERY_DEFAULT_TIMEOUT_MS } from './pg-read-query';
import { validateRubricReplicationSql } from './rubrics-replication-sql';

describe('validateRubricReplicationSql request-wide time bound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    mocks.explainReadQuery.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it('stops before starting an EXPLAIN whose full deadline no longer fits and marks the result incomplete', async () => {
    const explainCallDeadlineMs = PG_READ_QUERY_DEFAULT_TIMEOUT_MS + PG_READ_QUERY_CALL_OVERHEAD_MS;
    mocks.explainReadQuery.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), explainCallDeadlineMs)),
    );

    const startedAt = Date.now();
    const resultPromise = validateRubricReplicationSql([
      { key: 'slow-drills', replication: 'SELECT 1; SELECT 2; SELECT 3;' },
    ]);
    await vi.advanceTimersByTimeAsync(explainCallDeadlineMs);
    const result = await resultPromise;

    expect(mocks.explainReadQuery).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBe(explainCallDeadlineMs);
    expect(result).toMatchObject({ checked: 1, complete: false, ok: false });
    expect(result.summary).toContain('check incomplete');
  });
});
