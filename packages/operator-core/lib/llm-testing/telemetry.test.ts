import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return [];
  }, { json: (value: unknown) => value });
  return { queries, sql, transactions: vi.fn(async (fn: (tx: typeof sql) => unknown, _opts: unknown) => fn(sql)) };
});
vi.mock('../long-lived-admin-pool', () => ({ getLongLivedAdminPool: () => fixture.sql }));
vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: fixture.transactions }));

import { pullContinueChainRows, pullToolInvocations } from './telemetry';

const window = { startedAt: new Date('2026-10-16T13:00:00Z'), finishedAt: new Date('2026-10-16T13:04:00Z') };

describe('LLM telemetry read bounds', () => {
  beforeEach(() => { fixture.queries.length = 0; fixture.transactions.mockClear(); });

  it('refuses an absent or reversed run interval before acquiring a database connection', async () => {
    await expect(pullToolInvocations('llm-testing/fixture')).rejects.toThrow('measured run interval');
    await expect(pullContinueChainRows('llm-testing/fixture', {
      startedAt: window.finishedAt, finishedAt: window.startedAt,
    })).rejects.toThrow('measured run interval');
    expect(fixture.queries).toEqual([]);
    expect(fixture.transactions).not.toHaveBeenCalled();
  });

  it('restricts both readers to the original interval and uses cancellable read-only transactions', async () => {
    const controller = new AbortController();
    const scope = { ...window, signal: controller.signal };
    await pullToolInvocations('llm-testing/fixture', scope);
    await pullContinueChainRows('llm-testing/fixture', scope);
    expect(fixture.queries).toHaveLength(2);
    for (const [index, column] of ['invoked_at', 'started_at'].entries()) {
      const query = fixture.queries[index];
      expect(query.text).toContain(`${column} >=`);
      expect(query.text).toContain(`${column} <=`);
      expect(query.values).toContain(window.startedAt);
      expect(query.values).toContain(window.finishedAt);
      expect(fixture.transactions.mock.calls[index][1]).toMatchObject({
        readOnly: true, signal: controller.signal, acquireTimeoutMs: 1000,
        statementTimeoutMs: 3000, lockTimeoutMs: 250, acquireRetries: 0,
      });
    }
    expect(fixture.queries[0].text).toContain('metadata_json @>');
    expect(fixture.queries[1].text).toContain('ui_client_id =');
  });
});
