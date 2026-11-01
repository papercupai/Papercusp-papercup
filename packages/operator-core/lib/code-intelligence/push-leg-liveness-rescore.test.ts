/**
 * WI-6554700010030221 guard: the scheduled liveness rescore (the registered instrument
 * code-intel:liveness-probe) must take the excluded implementer lineage from the shared
 * resolver, never from a hand-written work_items query. The previous inline query selected
 * a non-existent `assignee` column, so every scheduled rescore threw 42703 before writing a
 * probe row — the instrument looked registered and armed while measuring nothing.
 *
 * Kept in its own file because the module mocks below are file-wide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlag } from '@papercusp/flags/server';
import { resolveAlarm } from '../alarm-attention';

const unsafe = vi.fn(async (_query: string, _params?: unknown[]) => [] as unknown[]);
const resolvePlanImplementerIdentities = vi.fn(async (_plan: string, _opts: { workspaceId?: string }) => ['su-implementer-a', 'su-implementer-b']);

vi.mock('@papercusp/db-org', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: { unsafe } }),
}));
vi.mock('../build-info', () => ({ getBuildInfo: () => ({ sha: 'test-sha' }) }));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../alarm-attention', () => ({ resolveAlarm: vi.fn(async () => true) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('../acceptance-author-identity', () => ({ resolvePlanImplementerIdentities }));

const { codeIntelLivenessRescore, LIVENESS_SUBJECT_PLAN, LIVENESS_PROBE_ACTION } = await import('./push-leg-liveness');

const WINDOW = { workspaceId: 'ws-test', windowStart: '2026-10-20T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' };

describe('code-intel liveness rescore lineage (WI-6554700010030221)', () => {
  beforeEach(() => {
    unsafe.mockClear();
    resolvePlanImplementerIdentities.mockClear();
    vi.mocked(getFlag).mockClear();
    vi.mocked(resolveAlarm).mockClear();
  });

  it('delegates the excluded lineage to resolvePlanImplementerIdentities for the subject plan and workspace', async () => {
    await codeIntelLivenessRescore().resolve(WINDOW);
    expect(LIVENESS_SUBJECT_PLAN).toBe('code-intel-delivery-and-outcomes-2026-10-26');
    expect(resolvePlanImplementerIdentities).toHaveBeenCalledTimes(1);
    expect(resolvePlanImplementerIdentities).toHaveBeenCalledWith(LIVENESS_SUBJECT_PLAN, { workspaceId: 'ws-test' });
  });

  it('never queries a work_items assignee column and threads the resolved lineage into the outside-lineage reads', async () => {
    await codeIntelLivenessRescore().resolve(WINDOW);
    const queries = unsafe.mock.calls.map(([q]) => String(q));
    expect(queries.some(q => /\bassignee\b/.test(q))).toBe(false);
    expect(queries.some(q => /harness_shared\.work_items\b/.test(q))).toBe(false);
    // The excluded-owner array param ($5 / $4) carries the resolved lineage plus the canary.
    const lineageParams = unsafe.mock.calls
      .flatMap(([, params]) => (params ?? []) as unknown[])
      .filter((p): p is string[] => Array.isArray(p) && p.includes('su-implementer-a'));
    expect(lineageParams.length).toBeGreaterThan(0);
    for (const p of lineageParams) expect(p).toEqual(expect.arrayContaining(['su-implementer-a', 'su-implementer-b', 'system:code-intel-canary']));
  });

  it('reaches the probe-row write (the audit insert the instrument never produced while the query threw)', async () => {
    const result = await codeIntelLivenessRescore().resolve(WINDOW);
    expect(result.verdict).not.toBe(undefined);
    const auditInserts = unsafe.mock.calls.filter(([q, params]) => /INSERT INTO harness_shared\.audit_log/.test(String(q))
      && Array.isArray(params) && params.includes(LIVENESS_PROBE_ACTION));
    expect(auditInserts.length).toBeGreaterThan(0);
  });

  it('propagates a lineage read failure instead of measuring with an empty exclusion set', async () => {
    resolvePlanImplementerIdentities.mockRejectedValueOnce(new Error('lineage unreadable'));
    await expect(codeIntelLivenessRescore().resolve(WINDOW)).rejects.toThrow('lineage unreadable');
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('does not turn a flag read failure into an OFF disposition that clears an alarm', async () => {
    vi.mocked(getFlag).mockRejectedValueOnce(new Error('flag store unreadable'));
    await expect(codeIntelLivenessRescore().resolve(WINDOW)).rejects.toThrow('flag store unreadable');
    expect(resolveAlarm).not.toHaveBeenCalled();
    expect(unsafe.mock.calls.some(([q]) => /INSERT INTO harness_shared\.audit_log/.test(String(q)))).toBe(false);
  });
});
