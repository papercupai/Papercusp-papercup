import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { lookupStoredMcpResult } from '../_mcp-result-replay';

describe('MCP result replay lookup deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a bounded pool acquisition timeout before starting a query', async () => {
    vi.useFakeTimers();
    h.sql = {
      begin: vi.fn(() => new Promise<never>(() => {})),
    };
    const events: Array<{
      phase: string;
      state: string;
      elapsedMs?: number;
      error?: { name: string; code?: string };
    }> = [];

    const result = lookupStoredMcpResult('owner-a', 'key-a', {
      acquisitionDeadlineMs: 25,
      onPhase: (event) => events.push(event),
    });
    const rejection = expect(result).rejects.toMatchObject({ name: 'DbCallDeadlineError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: 'pool_acquisition', state: 'started' });
    expect(events[1]).toMatchObject({
      phase: 'pool_acquisition',
      state: 'finished',
      error: { name: 'DbCallDeadlineError' },
    });
    expect(events[1].elapsedMs).toEqual(expect.any(Number));
  });

  it('does not issue a lookup from a transaction that arrives after acquisition expires', async () => {
    vi.useFakeTimers();
    let releaseAcquisition!: () => void;
    const acquisitionGate = new Promise<void>((resolve) => {
      releaseAcquisition = resolve;
    });
    const statements: string[] = [];
    const tx = async (parts: TemplateStringsArray) => {
      statements.push(parts.join('?'));
      return [];
    };
    const late = { transaction: null as Promise<unknown> | null };
    h.sql = {
      begin: async (run: (transaction: typeof tx) => Promise<unknown>) => {
        await acquisitionGate;
        const transaction = Promise.resolve().then(() => run(tx));
        late.transaction = transaction;
        return transaction;
      },
    };
    const events: Array<{ phase: string; state: string }> = [];

    const result = lookupStoredMcpResult('owner-late', 'key-late', {
      acquisitionDeadlineMs: 25,
      onPhase: (event) => events.push(event),
    });
    const rejection = expect(result).rejects.toMatchObject({ name: 'DbCallDeadlineError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    releaseAcquisition();
    for (let turn = 0; turn < 5 && late.transaction === null; turn += 1) {
      await Promise.resolve();
    }
    await late.transaction?.catch(() => undefined);

    expect(statements).toEqual([]);
    expect(events.map(({ phase, state }) => [phase, state])).toEqual([
      ['pool_acquisition', 'started'],
      ['pool_acquisition', 'finished'],
    ]);
  });

  it('sets transaction-local statement_timeout and records server cancellation separately', async () => {
    const statements: Array<{ text: string; values: unknown[] }> = [];
    const statementTimeoutError = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014' },
    );
    const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?');
      statements.push({ text, values });
      if (text.includes('SELECT result, is_error')) throw statementTimeoutError;
      return [];
    };
    h.sql = {
      begin: async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    };
    const events: Array<{
      phase: string;
      state: string;
      elapsedMs?: number;
      error?: { name: string; code?: string };
    }> = [];

    await expect(lookupStoredMcpResult('owner-b', 'key-b', {
      acquisitionDeadlineMs: 1_000,
      statementTimeoutMs: 25,
      onPhase: (event) => events.push(event),
    })).rejects.toBe(statementTimeoutError);

    expect(statements).toHaveLength(2);
    expect(statements[0].text).toContain("set_config('statement_timeout'");
    expect(statements[0].values).toContain('25ms');
    expect(statements[0].text).toContain('?, true)');
    expect(statements[1].text).toContain('FROM harness_shared.mcp_tool_results');
    expect(events.map(({ phase, state }) => [phase, state])).toEqual([
      ['pool_acquisition', 'started'],
      ['pool_acquisition', 'finished'],
      ['statement', 'started'],
      ['statement', 'finished'],
    ]);
    expect(events[3]).toMatchObject({
      phase: 'statement',
      state: 'finished',
      error: { name: 'Error', code: '57014' },
    });
  });
});
