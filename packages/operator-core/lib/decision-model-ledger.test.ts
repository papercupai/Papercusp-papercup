/**
 * Unit leg of the decision-model call ledger writer (plan
 * jev-decision-model-integration-2026-09-29 P-003): the failure contract, which
 * needs no database. The real-Postgres leg (column mapping, constraints, the
 * client → ledger wiring) is decision-model-ledger.integration.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stateSha256, toDecisionLedgerEntry, type DecisionCallRecord } from '@papercusp/decision-model';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

const { recordDecisionModelCall, recordDecisionModelLedgerEntry, decisionModelLedgerStats, __resetDecisionModelLedgerStatsForTest } = await import(
  './decision-model-ledger'
);

const record: DecisionCallRecord = {
  provider: 'typesafe',
  requestedModel: 'jev-1.13.0',
  request: { state: 'turn text', questions: { q: { type: 'yesNo', instructions: 'Relevant?' } } },
  outcome: { kind: 'inconclusive', reason: 'no-key', latencyMs: 0, attempts: 0 },
  startedAt: new Date('2026-09-30T02:00:00Z'),
  consumer: 'memory-injection',
  surface: 'turn-start',
  subjectIds: ['mem-1'],
  hostLoad: { busyMs: 311, utilization: 0.78 },
  transportLatencyMs: null,
};

function fakeSql(impl: () => Promise<unknown>) {
  const tag = vi.fn(impl) as unknown as ((...args: unknown[]) => Promise<unknown>) & {
    array: (v: unknown) => unknown;
    json: (v: unknown) => unknown;
  };
  tag.array = (v) => v;
  tag.json = (v) => v;
  return tag;
}

afterEach(() => {
  __resetDecisionModelLedgerStatsForTest();
  vi.restoreAllMocks();
});

describe('recordDecisionModelCall failure contract', () => {
  it('a failed insert resolves false, is counted, and writes nothing to the console', async () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    h.sql = fakeSql(() => Promise.reject(new Error('relation "harness_shared.decision_model_calls" does not exist')));
    await expect(recordDecisionModelCall(record)).resolves.toBe(false);
    expect(decisionModelLedgerStats()).toMatchObject({ written: 0, failed: 1 });
    expect(decisionModelLedgerStats().lastError).toContain('does not exist');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('a successful insert resolves true and is counted', async () => {
    h.sql = fakeSql(() => Promise.resolve([]));
    await expect(recordDecisionModelCall(record)).resolves.toBe(true);
    expect(decisionModelLedgerStats()).toMatchObject({ written: 1, failed: 0, lastError: null });
  });

  it('persists a sanitized entry received from a worker with the supplied workspace id', async () => {
    const tag = fakeSql(() => Promise.resolve([]));
    h.sql = tag;
    const entry = toDecisionLedgerEntry(record);
    await expect(recordDecisionModelLedgerEntry(entry, { workspaceId: 'ws-worker' })).resolves.toBe(true);
    const [strings, ...values] = (tag as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const columns = strings.join('?').match(/\(([^)]*)\)\s*VALUES/s)?.[1].split(',').map((c) => c.trim());
    expect(values[columns!.indexOf('workspace_id')]).toBe('ws-worker');
    expect(JSON.stringify(values)).not.toContain('turn text');
  });

  it('binds the state HASH as the state_sha256 value and never the judged state text (R-3)', async () => {
    const tag = fakeSql(() => Promise.resolve([]));
    h.sql = tag;
    await expect(recordDecisionModelCall(record)).resolves.toBe(true);
    const calls = (tag as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls).toHaveLength(1);
    const [strings, ...values] = calls[0] as [TemplateStringsArray, ...unknown[]];
    const columns = strings.join('?').match(/\(([^)]*)\)\s*VALUES/s)?.[1].split(',').map((c) => c.trim());
    expect(columns).toBeDefined();
    const expectedHash = stateSha256(record.request.state);
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(values[columns!.indexOf('state_sha256')]).toBe(expectedHash);
    expect(JSON.stringify(values)).not.toContain('turn text');
  });

  it('binds the host load to loop_busy_ms / loop_utilization (P-001)', async () => {
    const tag = fakeSql(() => Promise.resolve([]));
    h.sql = tag;
    await expect(recordDecisionModelCall(record)).resolves.toBe(true);
    const [strings, ...values] = (tag as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const columns = strings.join('?').match(/\(([^)]*)\)\s*VALUES/s)?.[1].split(',').map((c) => c.trim());
    expect(columns).toHaveLength(values.length);
    expect(values[columns!.indexOf('loop_busy_ms')]).toBe(311);
    expect(values[columns!.indexOf('loop_utilization')]).toBe(0.78);
  });

  it('a sql client that throws synchronously is still swallowed', async () => {
    h.sql = fakeSql(() => {
      throw new Error('pool closed');
    });
    await expect(recordDecisionModelCall(record)).resolves.toBe(false);
    expect(decisionModelLedgerStats().failed).toBe(1);
  });
});
