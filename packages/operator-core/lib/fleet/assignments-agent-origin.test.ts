import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

import {
  agentOriginToolCallOwnersSince,
  executingOwnersSince,
  lastProductiveToolCallAtByOwner,
  lastToolCallAtByOwner,
  nativeToolCallOwnersSince,
} from './assignments';

describe('settled invocation liveness reads require successful outcomes', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('lastToolCallAtByOwner ignores failed/refused attempts', async () => {
    sqlMock.mockResolvedValue([{ coord_owner_id: 'su-a', invoked_at: '2026-10-16T10:00:00.000Z' }]);
    await expect(lastToolCallAtByOwner(['su-a'])).resolves.toEqual(
      new Map([['su-a', '2026-10-16T10:00:00.000Z']]),
    );
    const statement = String(sqlMock.mock.calls[0]?.[0]?.join?.('') ?? '');
    expect(statement).toContain("status = 'ok'");
  });

  it('lastProductiveToolCallAtByOwner requires a successful non-housekeeping call', async () => {
    sqlMock.mockResolvedValue([{ coord_owner_id: 'su-a', invoked_at: '2026-10-16T10:00:00.000Z' }]);
    await expect(lastProductiveToolCallAtByOwner(['su-a'])).resolves.toEqual(
      new Map([['su-a', '2026-10-16T10:00:00.000Z']]),
    );
    const statement = String(sqlMock.mock.calls[0]?.[0]?.join?.('') ?? '');
    expect(statement).toContain("status = 'ok'");
    expect(statement).toContain('tool_name != ALL');
  });
});

describe('agentOriginToolCallOwnersSince (WI-583276)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('returns only owners with exact agent-origin rows in the bounded window', async () => {
    sqlMock.mockResolvedValue([{ coord_owner_id: 'su-a' }, { coord_owner_id: 'su-a' }, { coord_owner_id: 'su-b' }]);

    await expect(agentOriginToolCallOwnersSince(['su-a', 'su-b'], 15 * 60_000)).resolves.toEqual(
      new Set(['su-a', 'su-b']),
    );

    expect(sqlMock).toHaveBeenCalledTimes(1);
    const statement = String(sqlMock.mock.calls[0]?.[0]?.join?.('') ?? '');
    expect(statement).toContain("call_origin = 'agent'");
    expect(statement).toContain("status = 'ok'");
    expect(statement).toContain('invoked_at > now()');
    expect(statement).not.toContain('harness_slug');
  });

  it('returns a measured empty set without querying when the roster has no local owners', async () => {
    await expect(agentOriginToolCallOwnersSince(['fed:remote-a', '', 'fed:remote-a'])).resolves.toEqual(new Set());
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('returns UNKNOWN as null when telemetry read fails', async () => {
    sqlMock.mockRejectedValue(new Error('telemetry unavailable'));
    await expect(agentOriginToolCallOwnersSince(['su-a'])).resolves.toBeNull();
  });
});

describe('executingOwnersSince — the complete execution signal (WI-2034624)', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  // tool_invocations records MCP calls ONLY. Measured 2026-09-01 on live fleet
  // members: fleet `windows-parity` had 1 live member, 0 visible in
  // tool_invocations and 1 in agent_activity — an MCP-only reading calls that
  // fleet's only working member idle and the governor replaces a filled seat.
  it('counts an owner visible ONLY in the native-tool ledger', async () => {
    sqlMock.mockImplementation((strings: readonly string[]) => {
      const statement = strings.join('');
      if (statement.includes('tool_invocations')) return Promise.resolve([]);
      return Promise.resolve([{ owner_id: 'su-native-only' }]);
    });

    await expect(executingOwnersSince(['su-native-only'], 60 * 60_000)).resolves.toEqual(
      new Set(['su-native-only']),
    );
  });

  it('unions both ledgers rather than preferring either', async () => {
    sqlMock.mockImplementation((strings: readonly string[]) => {
      const statement = strings.join('');
      if (statement.includes('tool_invocations')) return Promise.resolve([{ coord_owner_id: 'su-mcp' }]);
      return Promise.resolve([{ owner_id: 'su-native' }]);
    });

    await expect(executingOwnersSince(['su-mcp', 'su-native'])).resolves.toEqual(
      new Set(['su-mcp', 'su-native']),
    );
  });

  // A PARTIAL union under-counts, and under-counting a capacity signal is the
  // precise harm: it spawns replacements for seats that are already filled.
  it('refuses a partial union — either leg failing is UNKNOWN, never the other leg alone', async () => {
    sqlMock.mockImplementation((strings: readonly string[]) => {
      const statement = strings.join('');
      if (statement.includes('tool_invocations')) return Promise.resolve([{ coord_owner_id: 'su-mcp' }]);
      return Promise.reject(new Error('agent_activity unavailable'));
    });
    await expect(executingOwnersSince(['su-mcp', 'su-native'])).resolves.toBeNull();

    sqlMock.mockImplementation((strings: readonly string[]) => {
      const statement = strings.join('');
      if (statement.includes('tool_invocations')) return Promise.reject(new Error('tool_invocations unavailable'));
      return Promise.resolve([{ owner_id: 'su-native' }]);
    });
    await expect(executingOwnersSince(['su-mcp', 'su-native'])).resolves.toBeNull();
  });

  it('reads the native ledger by owner_id over agent_activity in a bounded window', async () => {
    sqlMock.mockResolvedValue([{ owner_id: 'su-a' }, { owner_id: 'su-a' }]);
    await expect(nativeToolCallOwnersSince(['su-a'], 15 * 60_000)).resolves.toEqual(new Set(['su-a']));
    const statement = String(sqlMock.mock.calls[0]?.[0]?.join?.('') ?? '');
    expect(statement).toContain('harness_shared.agent_activity');
    expect(statement).toContain('created_at > now()');
  });

  it('returns UNKNOWN as null when the native ledger read fails', async () => {
    sqlMock.mockRejectedValue(new Error('activity ledger unavailable'));
    await expect(nativeToolCallOwnersSince(['su-a'])).resolves.toBeNull();
  });
});
