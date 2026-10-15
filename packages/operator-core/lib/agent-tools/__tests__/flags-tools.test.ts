/**
 * flags-tools.test.ts — handler-level unit tests for flags:set and flags:list
 * (Plan 1 P-018).
 *
 * flags:set delegates to setFlag + publishFlagChange + audit INSERT;
 * flags:list delegates to getAllFlags + resolveDistinctId.
 *
 * Tests confirm:
 *   - success path returns ok:true + flag key
 *   - setFlag failure returns ok:false (not thrown)
 *   - publishFlagChange is called on success but not on failure
 *   - flags:list returns keys + resolved values
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The flag audit write goes through recordFlagAudit (getOrgPg → real PG, EI-293).
// These are hermetic handler unit tests — stub it so they never touch a DB
// (and don't ECONNREFUSE + console.warn in CI). The real write is covered by
// flag-audit.integration.test.ts.
vi.mock('../../flag-audit', () => ({ recordFlagAudit: vi.fn(async () => {}) }));

const MAKE_CTX = (tx?: unknown) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'ws_test',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    tx: tx ?? null,
    principal: { slug: 'agent-test' },
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../flag-bus');
  vi.doUnmock('../../flag-distinct-id');
  vi.doUnmock('../flags/_register-backend');
});

// ─── flags:set ────────────────────────────────────────────────────────────────

describe('flags:set', () => {
  it('returns ok:true and the key on success', async () => {
    const setFlag = vi.fn(async () => ({ ok: true as const }));
    const setFlagOverride = vi.fn(async () => ({ ok: true as const }));
    const publishFlagChange = vi.fn();
    vi.doMock('@papercusp/flags/server', () => ({ setFlag, setFlagOverride }));
    vi.doMock('../../flag-bus', () => ({ publishFlagChange }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/set');
    const result = (await tool.handler(
      { key: 'papercusp-testing', enabled: true, reason: 'enabling for v1 dogfood' },
      MAKE_CTX(),
    )) as any;

    expect(setFlag).toHaveBeenCalledWith('papercusp-testing', true);
    expect(publishFlagChange).toHaveBeenCalledWith('papercusp-testing');
    // flags:set is bulk (P-006): the handler returns the canonical { data: envelope }.
    const data = result.data;
    expect(data.ok).toBe(true);
  });

  it('returns ok:false and reason when setFlag fails', async () => {
    const setFlag = vi.fn(async () => ({ ok: false as const, reason: 'posthog_unconfigured' }));
    const publishFlagChange = vi.fn();
    vi.doMock('@papercusp/flags/server', () => ({ setFlag }));
    vi.doMock('../../flag-bus', () => ({ publishFlagChange }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/set');
    const result = (await tool.handler(
      { key: 'papercusp-testing', enabled: false, reason: 'disabling snapshots now' },
      MAKE_CTX(),
    )) as any;

    // flags:set is bulk (P-006): a backend failure becomes THIS item's
    // { ok:false, key, error }. The batch RAN (counts is populated, the item
    // self-describes), but the envelope's ok is DERIVED from counts.failed, so a
    // failed item makes it false — a caller branching on `ok` must never be told
    // a batch succeeded while an item inside it failed.
    const data = result.data;
    expect(data.ok).toBe(false);
    expect(data.counts).toEqual({ ok: 0, failed: 1 });
    expect(data.results[0]).toMatchObject({ ok: false, key: 'papercusp-testing', error: 'posthog_unconfigured' });
    // publishFlagChange must NOT be called on failure.
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('does not call publishFlagChange when setFlag returns ok:false', async () => {
    const setFlag = vi.fn(async () => ({ ok: false as const, reason: 'flag_not_found' }));
    const publishFlagChange = vi.fn();
    vi.doMock('@papercusp/flags/server', () => ({ setFlag }));
    vi.doMock('../../flag-bus', () => ({ publishFlagChange }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/set');
    await tool.handler(
      { key: 'papercusp-design', enabled: true, reason: 'turning on oracle feature.' },
      MAKE_CTX(),
    );
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('does not throw when ctx.tx is present and audit INSERT runs', async () => {
    // Tagged template literal mock: postgres-js calls sql`...` as a tagged
    // template (fn(strings[], ...values)). vi.fn() handles this since tagged
    // templates are just function calls.
    const tx = vi.fn(async () => []) as any;
    tx.unsafe = vi.fn(async () => []);
    const setFlag = vi.fn(async () => ({ ok: true as const }));
    const setFlagOverride = vi.fn(async () => ({ ok: true as const }));
    vi.doMock('@papercusp/flags/server', () => ({ setFlag, setFlagOverride }));
    vi.doMock('../../flag-bus', () => ({ publishFlagChange: vi.fn() }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/set');
    // Should not throw even with a real tx present — the audit INSERT is best-effort.
    await expect(
      tool.handler(
        { key: 'papercusp-testing', enabled: true, reason: 'audit trail test coverage run.' },
        MAKE_CTX(tx),
      ),
    ).resolves.not.toThrow();
  });
});

// ─── flags:list ───────────────────────────────────────────────────────────────

describe('flags:list', () => {
  it('returns all flag keys and their resolved values', async () => {
    const mockFlags = { snapshots: false, oracle: false, templates: false };
    const getAllFlags = vi.fn(async () => mockFlags);
    const resolveDistinctId = vi.fn(() => 'anon-distinct');
    vi.doMock('@papercusp/flags/server', () => ({ getAllFlags }));
    vi.doMock('../../flag-distinct-id', () => ({ resolveDistinctId }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/list');
    const { ALL_FLAG_KEYS } = await import('@papercusp/flags');
    const result = await tool.handler({}, MAKE_CTX());

    expect(getAllFlags).toHaveBeenCalledTimes(1);
    expect(getAllFlags).toHaveBeenCalledWith('anon-distinct');
    expect(result).toEqual({ data: { keys: ALL_FLAG_KEYS, ...mockFlags } });
  });

  it('resolveDistinctId is called with a Request', async () => {
    const resolveDistinctId = vi.fn((_req: Request) => 'id-123');
    vi.doMock('@papercusp/flags/server', () => ({ getAllFlags: vi.fn(async () => ({})) }));
    vi.doMock('../../flag-distinct-id', () => ({ resolveDistinctId }));
    vi.doMock('../flags/_register-backend', () => ({}));

    const { default: tool } = await import('../flags/list');
    await tool.handler({}, MAKE_CTX());

    expect(resolveDistinctId).toHaveBeenCalledTimes(1);
    const arg = resolveDistinctId.mock.calls[0]?.[0];
    expect(arg).toBeInstanceOf(Request);
  });
});
