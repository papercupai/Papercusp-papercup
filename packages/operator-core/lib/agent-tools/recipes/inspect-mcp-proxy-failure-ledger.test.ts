import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Keep this fixture synchronized with the persisted recipe via recipes:revise.
const script = readFileSync(
  new URL('./fixtures/inspect-mcp-proxy-failure-ledger.recipe.txt', import.meta.url),
  'utf8',
);

describe('inspect-mcp-proxy-failure-ledger saved recipe', () => {
  it('uses the current read and full-health fields and emits only compact ledger records', async () => {
    const ledgerRows = [
      {
        ts: '2026-10-31T12:00:00.000Z',
        listenPort: 3271,
        target: 'http://127.0.0.1:3271',
        kind: 'proxy_error',
        method: 'POST',
        path: '/api/mcp?superuser=1',
        status: 502,
        attempts: 1,
        elapsedMs: 31,
        connection: 'keep-alive',
        rpcMethods: ['tools/list'],
        sensitiveRawField: 'must never be returned',
      },
      {
        ts: '2026-10-30T08:00:00.000Z',
        listenPort: 0,
        target: 'legacy',
        kind: 'client_error',
        method: 'POST',
        path: '/api/mcp',
        status: 400,
        attempts: 1,
        elapsedMs: 4,
        connection: 'close',
      },
    ];
    const read = vi.fn(async () => ({
      ok: true,
      body: ledgerRows.map((row, index) => index + ' | ' + JSON.stringify(row)).join('\n'),
    }));
    const fullHealth = {
      services: [{ unit: 'papercup-mcp-proxy', active: true }],
      telemetry: { checked: 3 },
      evidence: { checked: 3, failures: [], unhealthySupervision: [] },
      supervision: { unhealthy: [] },
    };
    const serviceHealth = vi.fn(async () => fullHealth);
    const context = vm.createContext({
      tools: {
        capability: { read },
        dev: { serviceHealth },
      },
    });

    const result = await vm.runInContext(
      '(async () => {\n' + script + '\n})()',
      context,
    ) as {
      ledger: Record<string, unknown>;
      same3271Endpoint: { count: number; records: Array<Record<string, unknown>> };
      mcpPath: { count: number; instanceCount: number; latest: Array<Record<string, unknown>> };
      health: Record<string, unknown>;
    };

    expect(read).toHaveBeenCalledWith({
      file_path: '~/.papercusp/mcp-proxy-failures.jsonl',
      tail: 2000,
    });
    expect(serviceHealth).toHaveBeenCalledWith({
      units: ['papercup-mcp-proxy', 'papercup-mcp-proxy-staging', 'papercup-bg-host'],
      scope: 'user',
      detail: 'full',
    });
    expect(result.ledger).toEqual({
      ok: true,
      totalLinesReturned: 2,
      parsedRecords: 2,
      recentRecords: 2,
    });
    expect(result.same3271Endpoint.count).toBe(1);
    expect(result.mcpPath).toMatchObject({ count: 2, instanceCount: 1 });
    expect(result.mcpPath.latest[0]).toMatchObject({
      ts: '2026-10-31T12:00:00.000Z',
      listenPort: 3271,
      status: 502,
      path: '/api/mcp?superuser=1',
    });
    expect(result.health).toEqual(fullHealth);
    expect(JSON.stringify(result)).not.toContain('sensitiveRawField');
    expect(JSON.stringify(result)).not.toContain('must never be returned');
  });
});
