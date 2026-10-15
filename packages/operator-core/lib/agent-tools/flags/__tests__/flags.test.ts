/**
 * P-028 (production-readiness-test-coverage) — `agent-tools/flags` (get / list /
 * set). Operator-side MCP tools tested by importing each tool's `handler`
 * directly and asserting the canonical `data` payload + that the
 * mocked flag-server helpers are called correctly. The dispatcher (role gates,
 * quota, telemetry) is covered in @papercusp/agent-mcp's own tests; this only
 * validates handler behavior given mocked lib helpers.
 *
 * flags:set is the high-tier one: it must publish a flag-change on success,
 * NOT publish on a backend failure (and flag isError), and best-effort the
 * audit-log insert without letting an insert failure mask the successful flip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_FLAG_KEYS } from '@papercusp/flags';

const KEY = ALL_FLAG_KEYS[0];

const getFlag = vi.fn();
const getAllFlags = vi.fn();
const setFlag = vi.fn();
const setFlagOverride = vi.fn();
const publishFlagChange = vi.fn();
const resolveDistinctId = vi.fn(() => 'did-test');
const recordFlagAudit = vi.fn(async () => {});

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'papercup',
    role: 'operator' as const,
    tx: null,
    ...over,
  } as never);

function parseDataPayload(result: { data: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

/** Read the bulk keyed-array envelope (flags:get / flags:set are bulk, P-006 —
 *  the handler returns the canonical { data: envelope } shape). */
function parseEnvelope(result: { data: unknown }): {
  ok: boolean;
  results: any[];
  counts: { ok: number; failed: number };
} {
  return result.data as { ok: boolean; results: any[]; counts: { ok: number; failed: number } };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('@papercusp/flags/server', () => ({ getFlag, getAllFlags, setFlag, setFlagOverride }));
  vi.doMock('../../../flag-bus', () => ({ publishFlagChange }));
  vi.doMock('../../../flag-distinct-id', () => ({ resolveDistinctId }));
  // flags:set now writes its audit row via recordFlagAudit (getOrgPg → real
  // PG, EI-293) — stub it so these hermetic handler tests never touch a DB.
  vi.doMock('../../../flag-audit', () => ({ recordFlagAudit }));
  getFlag.mockResolvedValue(false);
  getAllFlags.mockResolvedValue({});
  setFlag.mockResolvedValue({ ok: true });
  setFlagOverride.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../../flag-bus');
  vi.doUnmock('../../../flag-distinct-id');
  vi.doUnmock('../../../flag-audit');
  setFlagOverride.mockClear();
});

describe('flags:get (bulk keyed-array, P-006)', () => {
  it('n=1 { key } resolves via getFlag(key, distinctId) → one keyed result', async () => {
    getFlag.mockResolvedValue(true);
    const { default: tool } = await import('../get');
    const b = parseEnvelope(await tool.handler({ key: KEY }, MAKE_CTX()) as never);
    expect(getFlag).toHaveBeenCalledWith(KEY, 'did-test');
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, key: KEY, enabled: true });
  });

  it('reflects a disabled flag', async () => {
    getFlag.mockResolvedValue(false);
    const { default: tool } = await import('../get');
    const b = parseEnvelope(await tool.handler({ key: KEY }, MAKE_CTX()) as never);
    expect(b.results[0]).toMatchObject({ ok: true, key: KEY, enabled: false });
  });

  it('keys:[…] resolves many, each result keyed by key (deduped)', async () => {
    const k0 = ALL_FLAG_KEYS[0];
    const k1 = ALL_FLAG_KEYS[1] ?? k0; // single-key builds: dedup collapses to one
    getFlag.mockImplementation(async (k: string) => k === k0);
    const { default: tool } = await import('../get');
    const b = parseEnvelope(await tool.handler({ keys: [k0, k1] }, MAKE_CTX()) as never);
    if (k0 !== k1) {
      expect(b.counts).toEqual({ ok: 2, failed: 0 });
      expect(b.results.map((r) => [r.key, r.enabled])).toEqual([
        [k0, true],
        [k1, false],
      ]);
    } else {
      expect(b.counts).toEqual({ ok: 1, failed: 0 }); // deduped to one
      expect(b.results[0]).toMatchObject({ key: k0, enabled: true });
    }
  });

  // EI-1168: `key` is a plain string now (not a z.enum(ALL_FLAG_KEYS)), so an
  // unknown key is no longer rejected at argument-parsing time by a stale
  // enum — it's caught at runtime, per-item, through the ordinary bulk error
  // contract instead. getFlag is a legit flag key never even reached.
  it('an unknown key fails ONLY that item with a clear message — never a bare zod enum rejection (EI-1168)', async () => {
    const { default: tool } = await import('../get');
    const b = parseEnvelope(await tool.handler({ key: 'papercusp-totally-made-up-flag' }, MAKE_CTX()) as never);
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, key: 'papercusp-totally-made-up-flag' });
    expect(b.results[0].error).toMatch(/unknown flag key/i);
    expect(getFlag).not.toHaveBeenCalled();
  });

  it('makes the host-global contract explicit and rejects scope selectors', async () => {
    const { default: tool } = await import('../get');
    expect(tool.description).toMatch(/host-global/i);
    expect((tool as typeof tool & { guidance?: { notWhen?: string } }).guidance?.notWhen).toMatch(/scope/i);
    expect(() => tool.args.parse({ key: KEY, scope: 'system' } as never)).toThrow(/unrecognized key/i);
  });
});

describe('flags:list', () => {
  it('wraps getAllFlags output and always includes the full key list', async () => {
    getAllFlags.mockResolvedValue({ [KEY]: true });
    const { default: tool } = await import('../list');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parseDataPayload(result as never);
    expect(payload.keys).toEqual([...ALL_FLAG_KEYS]);
    expect(payload[KEY]).toBe(true);
    expect(getAllFlags).toHaveBeenCalledWith('did-test');
  });
});

describe('flags:set (bulk keyed-array, P-006)', () => {
  it('n=1 { key, enabled } flips a flag, publishes the change → one keyed result {backend:posthog}', async () => {
    setFlag.mockResolvedValue({ ok: true });
    const { default: tool } = await import('../set');
    const b = parseEnvelope(await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX()) as never);
    expect(setFlag).toHaveBeenCalledWith(KEY, true);
    expect(setFlagOverride).toHaveBeenCalledWith(KEY, null);
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toEqual({ ok: true, key: KEY, enabled: true, backend: 'posthog' });
  });

  it('on flag-backend-not-configured: falls back to pg-override → {ok:true, backend:pg-override}', async () => {
    setFlag.mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(true); // readback confirms the write took
    const { default: tool } = await import('../set');
    const b = parseEnvelope(await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX()) as never);
    expect(setFlag).toHaveBeenCalledWith(KEY, true);
    expect(setFlagOverride).toHaveBeenCalledWith(KEY, true);
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
    expect(b.results[0]).toEqual({ ok: true, key: KEY, enabled: true, backend: 'pg-override' });
  });

  it('EI-18712738949489735: pg-override write "succeeds" but readback disagrees → the item fails, does NOT publish', async () => {
    setFlag.mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(false); // resolving process still sees the OLD value
    const { default: tool } = await import('../set');
    const b = parseEnvelope(await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX()) as never);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, key: KEY });
    expect(b.results[0].error).toMatch(/not observably applied/);
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('on other backend failure: the item fails ({ ok:false, key, error }) and does NOT publish; batch ok:true', async () => {
    setFlag.mockResolvedValue({ ok: false, reason: 'posthog_error' });
    const { default: tool } = await import('../set');
    const b = parseEnvelope(await tool.handler({ key: KEY, enabled: true, reason: 'enable for release' }, MAKE_CTX()) as never);
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, key: KEY, error: 'posthog_error' });
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('records the flag audit with the principal slug as actor (EI-293)', async () => {
    const { default: tool } = await import('../set');
    await tool.handler(
      { key: KEY, enabled: false, reason: 'disable for V1' },
      MAKE_CTX({ principal: { slug: 'agent-x' } }),
    );
    // recordFlagAudit is the single correct writer (replaced the inline
    // ctx.tx INSERT that omitted id + workspace_id and silently failed).
    expect(recordFlagAudit).toHaveBeenCalledWith(KEY, false, 'agent-x', { reason: 'disable for V1', backend: 'posthog' });
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
  });

  it("falls back to actor 'agent' when no principal is present", async () => {
    const { default: tool } = await import('../set');
    await tool.handler({ key: KEY, enabled: true, reason: 'enable it' }, MAKE_CTX());
    expect(recordFlagAudit).toHaveBeenCalledWith(KEY, true, 'agent', { reason: 'enable it', backend: 'posthog' });
  });

  it('items:[…] flips many heterogeneous keys; one backend failure fails ONLY itself', async () => {
    const [k0, k1] = [ALL_FLAG_KEYS[0], ALL_FLAG_KEYS[1] ?? ALL_FLAG_KEYS[0]];
    setFlag.mockImplementation(async (k: string) => (k === k1 && k0 !== k1 ? { ok: false, reason: 'posthog_error' } : { ok: true }));
    const { default: tool } = await import('../set');
    const b = parseEnvelope(
      await tool.handler(
        { items: [{ key: k0, enabled: true }, { key: k1, enabled: false }], reason: 'batch flip for release' },
        MAKE_CTX(),
      ) as never,
    );
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    expect(b.ok).toBe(false);
    if (k0 !== k1) {
      // Distinct keys: k0 succeeds, k1 fails only itself.
      expect(b.counts).toEqual({ ok: 1, failed: 1 });
      expect(b.results[0]).toMatchObject({ ok: true, key: k0, enabled: true });
      expect(b.results[1]).toMatchObject({ ok: false, key: k1, error: 'posthog_error' });
    } else {
      // Single-key build: both items resolve ok.
      expect(b.counts.failed).toBe(0);
    }
  });
  // recordFlagAudit's best-effort "never throws even on a write failure"
  // contract is covered against a real dead connection in
  // flag-audit.integration.test.ts (it's mocked here).

  // EI-1168: same treatment as flags:get — `key` is a plain string, so an
  // unknown key fails only itself (never a stale-enum argument rejection),
  // never touches setFlag, and never publishes a flag-change for it.
  it('an unknown key fails ONLY that item with a clear message and never calls setFlag/publishFlagChange (EI-1168)', async () => {
    const { default: tool } = await import('../set');
    const b = parseEnvelope(
      await tool.handler({ key: 'papercusp-totally-made-up-flag', enabled: true, reason: 'testing EI-1168' }, MAKE_CTX()) as never,
    );
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, key: 'papercusp-totally-made-up-flag' });
    expect(b.results[0].error).toMatch(/unknown flag key/i);
    expect(setFlag).not.toHaveBeenCalled();
    expect(publishFlagChange).not.toHaveBeenCalled();
  });
});

/**
 * `enabled: null` = CLEAR the runtime pg-override, letting whatever governs underneath
 * (PostHog, else the derived FLAG_DEFAULTS) take over again.
 *
 * ⚠ THE FIRST TEST HERE IS THE LOAD-BEARING ONE, and it is a SCHEMA test on purpose.
 * The defect was never in the handler: the override store has ALWAYS implemented
 * clear-by-null (`FlagOverrideStore.set(key, boolean | null)` — "`null` clears it",
 * libs/flags/src/server.ts:48), but BOTH agent-facing edges declared `z.boolean()`, so
 * no caller could ever express it. A capability implemented in the core and unreachable
 * from every edge is indistinguishable from a missing feature — and it hides behind its
 * own documentation, which is why three agents read that line and assumed the operation
 * existed. These tests call `handler` directly, which does NOT run the args schema, so
 * a handler-only test would pass against a `z.boolean()` edge that rejects every real
 * call. Tightening the schema back must FAIL something: it fails the first test below.
 */
describe('flags:set — `enabled: null` clears the pg-override (the graduation path)', () => {
  it('the args schema ACCEPTS null, in BOTH the n=1 and items forms (the actual gap)', async () => {
    const { default: tool } = await import('../set');
    expect(tool.args.parse({ key: KEY, enabled: null, reason: 'clearing an override' })).toMatchObject({
      key: KEY,
      enabled: null,
    });
    expect(
      tool.args.parse({ items: [{ key: KEY, enabled: null }], reason: 'clearing an override' }),
    ).toMatchObject({ items: [{ key: KEY, enabled: null }] });
  });

  it('still refuses a n=1 call that OMITS enabled — nullable widened the type, it did not make the field optional', async () => {
    const { default: tool } = await import('../set');
    expect(() => tool.args.parse({ key: KEY, reason: 'no value at all' })).toThrow();
  });

  it('CLEARS the override and never touches PostHog (a local clear must not rewrite the shared value)', async () => {
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(true); // the derived default governs once the row is gone
    const { default: tool } = await import('../set');
    const b = parseEnvelope(
      await tool.handler({ key: KEY, enabled: null, reason: 'graduating the flag' }, MAKE_CTX()) as never,
    );
    expect(setFlagOverride).toHaveBeenCalledWith(KEY, null);
    expect(setFlag).not.toHaveBeenCalled();
    expect(publishFlagChange).toHaveBeenCalledWith(KEY);
    expect(b.counts).toEqual({ ok: 1, failed: 0 });
    expect(b.results[0]).toMatchObject({ ok: true, key: KEY, cleared: true, backend: 'pg-override-cleared' });
  });

  it('reports what NOW GOVERNS after the clear, not the value that was removed', async () => {
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(true);
    const { default: tool } = await import('../set');
    const b = parseEnvelope(
      await tool.handler({ key: KEY, enabled: null, reason: 'graduating the flag' }, MAKE_CTX()) as never,
    );
    // For a graduated flag this `true` IS the proof the derived default — not a
    // surviving override row — is what governs now.
    expect(b.results[0].enabled).toBe(true);
  });

  it('null is NOT false: `false` writes an override row, `null` removes one', async () => {
    setFlag.mockResolvedValue({ ok: false, reason: 'flag-backend-not-configured' });
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(false);
    const { default: tool } = await import('../set');
    await tool.handler({ key: KEY, enabled: false, reason: 'pinning it off' }, MAKE_CTX());
    expect(setFlagOverride).toHaveBeenLastCalledWith(KEY, false);

    getFlag.mockResolvedValue(true);
    await tool.handler({ key: KEY, enabled: null, reason: 'clearing the pin' }, MAKE_CTX());
    expect(setFlagOverride).toHaveBeenLastCalledWith(KEY, null);
  });

  it('a failed clear fails ONLY that item and does not publish', async () => {
    setFlagOverride.mockResolvedValue({ ok: false, reason: 'pg down' });
    const { default: tool } = await import('../set');
    const b = parseEnvelope(
      await tool.handler({ key: KEY, enabled: null, reason: 'graduating the flag' }, MAKE_CTX()) as never,
    );
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0].error).toMatch(/could not clear the pg-override/);
    expect(publishFlagChange).not.toHaveBeenCalled();
  });

  it('audits the clear with what now governs, and never calls setFlag for it', async () => {
    setFlagOverride.mockResolvedValue({ ok: true });
    getFlag.mockResolvedValue(true);
    const { default: tool } = await import('../set');
    await tool.handler(
      { key: KEY, enabled: null, reason: 'graduating the flag' },
      MAKE_CTX({ principal: { slug: 'agent-x' } }),
    );
    expect(recordFlagAudit).toHaveBeenCalledWith(KEY, true, 'agent-x', {
      reason: 'graduating the flag',
      backend: 'pg-override',
    });
    expect(setFlag).not.toHaveBeenCalled();
  });
});
