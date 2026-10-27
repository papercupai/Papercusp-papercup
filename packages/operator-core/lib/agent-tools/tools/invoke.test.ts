/**
 * Tests for the tools:invoke meta-tool (dynamic-tool-surface-2026-07-01 D-003).
 * Importing the file triggers defineTool registration, so a compile/import/
 * capability error fails here too.
 *
 * The handler delegates to ctx.dispatchTool (the transport-provided server-side
 * dispatcher); these tests drive it with a stub dispatcher, so no DB / registry
 * boot is needed. The REAL dispatch (gating preserved) is proven end-to-end by
 * the live round-trip against :3170.
 */
import { describe, it, expect, vi } from 'vitest';

// P-012: default FALSE so the pre-existing exact-equality metadata assertions stay
// byte-identical; the dispatch-wrapper describe flips it per-test.
vi.mock('../../telemetry-dispatch-wrapper', () => ({
  dispatchWrapperMarkEnabled: vi.fn(async () => false),
}));
import { dispatchWrapperMarkEnabled } from '../../telemetry-dispatch-wrapper';

// Stand-in projected targets for the per-call effect resolver (D-021).
const targets = vi.hoisted(() => ({
  'work_items:get': { effect: 'read' },
  'orders:disposition': { effect: 'write' },
  'release:deploy': { effect: 'write', effectForCall: (a: { op?: string }) => (a.op === 'status' ? 'read' : 'write') },
  'broken:classifier': { effect: 'read', effectForCall: () => { throw new Error('boom'); } },
}) as Record<string, { effect: 'read' | 'write'; effectForCall?: (a: never) => 'read' | 'write' }>);
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  resolveMcpName: vi.fn((name: string) => targets[name]),
}));

import toolInvoke, { NestedToolRefusalError, summarizeNestedToolOutcome } from './invoke';
import dbMigrateTool from '../db/migrate';

const markEnabledMock = vi.mocked(dispatchWrapperMarkEnabled);

const servingGenerationMock = vi.hoisted(() => ({
  read: vi.fn(),
}));
vi.mock('../../serving-generation', () => ({
  readServingGeneration: servingGenerationMock.read,
}));
import { readServingGeneration } from '../../serving-generation';

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  skipWorkspaceTx: boolean;
  timeoutSec: number;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};

const def = toolInvoke as unknown as ToolDef;

describe('tools:invoke registration', () => {
  it('registers with the expected name + capability + args', () => {
    expect(def.name).toBe('tools:invoke');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    // This pure delegator must not hold a workspace transaction across a slow
    // nested tool call; the idle transaction is killed by PostgreSQL after 60s.
    expect(def.skipWorkspaceTx).toBe(true);
    // db:migrate's explicit target budget (1020s) is longer than scorecards:emit's
    // 900s budget. Keep the meta-wrapper at least 60s above it, not merely above
    // the previously longest known target.
    const dbMigrateTimeoutSec = (dbMigrateTool as unknown as { timeoutSec: number }).timeoutSec;
    expect(def.timeoutSec - dbMigrateTimeoutSec).toBeGreaterThanOrEqual(60);
    expect(def.args.safeParse({ name: 'flags:set', args: { key: 'x', value: true } }).success).toBe(true);
    expect(def.args.safeParse({
      name: 'flags:set',
      args: { key: 'x', value: true },
      servingGeneration: 'serving-generation-v1:test',
    }).success).toBe(true);
    expect(def.args.safeParse({ name: 'flags:set' }).success).toBe(true); // args optional
    expect(def.args.safeParse({}).success).toBe(false); // name required
    expect(def.args.safeParse({ name: '' }).success).toBe(false); // non-empty
    const chaining = (toolInvoke as unknown as { guidance: { chaining: string } }).guidance.chaining;
    expect(chaining).toContain('tools:invoke({ name, args })');
    expect(chaining).toContain('papercusp/servingGeneration` metadata from tools/list');
    expect(chaining).toContain('legacy callable schemas may reject');
  });

  it('is advertised as a write and resolves each call to its target\'s effect (D-021)', () => {
    // readOnlyHint is derived from the static effect, so a delegator that can
    // reach capability:bash must never read as read-only.
    const tool = toolInvoke as unknown as { effect?: string; effectForCall?: (args: unknown) => string };
    expect(tool.effect).toBe('write');
    const effect = tool.effectForCall!;
    expect(effect({ name: 'work_items:get', args: { id: 'WI-1' } })).toBe('read');
    expect(effect({ name: ' orders:disposition ' })).toBe('write');
    expect(effect({ name: 'release:deploy', args: '{"op":"status"}' })).toBe('read');
    expect(effect({ name: 'release:deploy', args: { op: 'execute' } })).toBe('write');
    for (const call of [{ name: 'broken:classifier' }, { name: 'no:such-tool' }, { name: 'tools:invoke' }, {}, null]) {
      expect(effect(call)).toBe('write');
    }
  });

  it('tolerates a JSON-stringified args payload (EI-6681 client-serialization quirk)', () => {
    const r = def.args.safeParse({
      name: 'flags:set',
      args: JSON.stringify({ key: 'x', value: true, nested: { a: [1, 2, 3] } }),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.args).toEqual({ key: 'x', value: true, nested: { a: [1, 2, 3] } });
    }
  });

  it('recovers a long JSON record with one surplus closing brace (EI-25644994406425836)', () => {
    const args = {
      question: 'Can you review this decision?',
      body: "Here's the longer context (with apostrophes and parentheses). ".repeat(30),
      topics: ['papercusp-improvement'],
      timeout_s: 0,
    };
    const r = def.args.safeParse({
      name: 'coord:ask-owner',
      args: `${JSON.stringify(args)}}`,
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual(args);

    const array = def.args.safeParse({
      name: 'flags:set',
      args: `${JSON.stringify(['not a record'])}}`,
    });
    expect(array.success).toBe(false);
  });

  it('still rejects a non-JSON string args payload (no silent pass-through)', () => {
    expect(def.args.safeParse({ name: 'flags:set', args: 'not-json {' }).success).toBe(false);
  });

  it('tolerates a DOUBLE-encoded deeply-nested args payload (EI-15360)', () => {
    // Repro of EI-15360: a client double-stringifies a deep spec object (e.g.
    // scheduler:set_claim_spec's ~10-level filter tree). A single JSON.parse
    // yields a *string*, which used to fail z.record with the exact reported
    // "expected record, received string". Iterative un-stringify recovers it.
    const spec = {
      specVersion: '1.0',
      specId: 'backlog-drain-clean',
      revision: 1,
      view: {
        filter: {
          all: [{ any: [{ not: { all: [{ any: [{ field: 'tags', op: 'contains', value: 'WI-1281' }] }] } }] }],
        },
      },
      rank: { mode: 'lexicographic', terms: [{ expr: 'priority', dir: 'asc' }] },
    };
    const r = def.args.safeParse({
      name: 'scheduler:set_claim_spec',
      args: JSON.stringify(JSON.stringify(spec)),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual(spec);
  });

  it('recovers a triple-encoded args payload too, bounded (EI-15360)', () => {
    const obj = { key: 'x', value: true };
    const r = def.args.safeParse({
      name: 'flags:set',
      args: JSON.stringify(JSON.stringify(JSON.stringify(obj))),
    }) as { success: true; data: { args: unknown } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args).toEqual(obj);
  });

  it('does NOT un-string a target tool\'s legitimate nested string arg', () => {
    // A nested value that HAPPENS to be JSON must survive untouched — only the
    // top-level args wrapper is un-stringified, never its members.
    const r = def.args.safeParse({
      name: 'work_items:create',
      args: { kind: 'bug', title: 't', body: '{"looks":"like json"}' },
    }) as { success: true; data: { args: { body: unknown } } } | { success: false };
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.args.body).toBe('{"looks":"like json"}');
  });
});

describe('tools:invoke handler', () => {
  it('dispatches only when the discovered serving generation matches', async () => {
    vi.mocked(readServingGeneration).mockResolvedValue({
      state: 'known',
      revision: 'serving-generation-v1:test',
      buildSha: 'test-build',
      appliedMigrationDigest: 'test-migrations',
      toolRegistryRevision: 'test-registry',
    });
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));

    await def.handler({
      name: 'flags:get',
      args: {},
      servingGeneration: 'serving-generation-v1:test',
    }, { dispatchTool });

    expect(dispatchTool).toHaveBeenCalledExactlyOnceWith('flags:get', {});
  });

  it('refuses a mismatched serving generation before dispatching the target', async () => {
    vi.mocked(readServingGeneration).mockResolvedValue({
      state: 'known',
      revision: 'serving-generation-v1:current',
      buildSha: 'current-build',
      appliedMigrationDigest: 'current-migrations',
      toolRegistryRevision: 'current-registry',
    });
    const dispatchTool = vi.fn();

    await expect(def.handler({
      name: 'flags:set',
      args: { key: 'k', value: true },
      servingGeneration: 'serving-generation-v1:stale',
    }, { dispatchTool })).rejects.toThrow(/stale_tool_contract/);

    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('routes the call through ctx.dispatchTool with name + args and returns its result', async () => {
    const calls: Array<[string, unknown]> = [];
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: vi.fn(async (name: string, a: unknown) => {
        calls.push([name, a]);
        return { content: [{ type: 'text', text: 'dispatched-ok' }], isError: false };
      }),
    };
    const res = await def.handler({ name: 'flags:set', args: { key: 'k', value: true } }, ctx);
    expect(calls).toEqual([['flags:set', { key: 'k', value: true }]]);
    expect(res.content[0].text).toBe('dispatched-ok');
    expect(res.isError).toBe(false);
    expect(metadata).toHaveBeenCalledWith({ effectiveStatus: 'ok', childFailureCount: 0 });
  });

  it('requests full target payloads for in-script re-dispatches', async () => {
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await def.handler(
      { name: 'plans:get', args: { slug: 'example' } },
      { codeMode: true, dispatchTool },
    );

    expect(dispatchTool).toHaveBeenCalledWith('plans:get', { slug: 'example', payloadTier: 'full' });
  });

  it('preserves nested result-door metadata on a successful re-dispatch', async () => {
    const nested = {
      content: [{ type: 'text' as const, text: '{"_projection":{"cursor":{"reason":"spill-write-failed"}}}' }],
      _meta: {
        resultDoor: {
          truncated: true,
          spillFailed: true,
          spillErrorCode: 'unknown error',
          spillError: 'private filesystem detail',
        },
      },
    };
    const res = await def.handler(
      { name: 'work_items:get', args: { id: 'WI-123' } },
      { dispatchTool: async () => nested },
    );

    expect((res as typeof nested)._meta).toEqual(nested._meta);
  });

  it('preserves an explicit target payloadTier in in-script re-dispatches', async () => {
    const dispatchTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await def.handler(
      { name: 'plans:get', args: { slug: 'example', payloadTier: 'trimmed' } },
      { codeMode: true, dispatchTool },
    );

    expect(dispatchTool).toHaveBeenCalledWith('plans:get', { slug: 'example', payloadTier: 'trimmed' });
  });

  it('defaults args to {} when omitted', async () => {
    const seen: unknown[] = [];
    const ctx = { dispatchTool: async (_n: string, a: unknown) => { seen.push(a); return { content: [] }; } };
    await def.handler({ name: 'harness:status' }, ctx);
    expect(seen).toEqual([{}]);
  });

  it('refuses to invoke itself (foot-gun guard)', async () => {
    const ctx = { dispatchTool: vi.fn() };
    const res = await def.handler({ name: 'tools:invoke', args: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('cannot invoke itself');
    expect(ctx.dispatchTool).not.toHaveBeenCalled();
  });

  it('errors cleanly on a transport with no dispatcher (no throw)', async () => {
    const res = await def.handler({ name: 'flags:set', args: {} }, {}); // ctx without dispatchTool
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('unsupported_transport');
  });

  it('records an effective error when the nested tool reports ok:false', async () => {
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'bad_input' }) }],
      }),
    };
    await def.handler({ name: 'plans:new', args: {} }, ctx);
    expect(metadata).toHaveBeenCalledWith({
      effectiveStatus: 'error',
      childFailureCount: 1,
      childFailureRefs: ['plans:new'],
    });
  });

  it('rejects a resolved nested isError refusal while preserving its code/details', async () => {
    const metadata = vi.fn();
    const refusalText = JSON.stringify({
      ok: false,
      error: 'invalid_input',
      message: 'invalid_args: Unrecognized key: "harness"',
      details: { field: 'harness' },
    });
    const nested = {
      isError: true,
      content: [{ type: 'text' as const, text: refusalText }],
      _meta: {
        abortCompletionReceipt: {
          status: 'recorded',
          msg_id: 'm-late',
          diagnostics: { coordSendPhaseTimingsMs: [{ itemIndex: 0, prePersistMs: 8, persistMs: 12, postPersistMs: 5 }] },
        },
      },
    };
    const ctx = {
      metadata,
      dispatchTool: async () => nested,
    };

    await expect(def.handler({ name: 'db:check_drift', args: {} }, ctx)).rejects.toMatchObject({
      name: 'NestedToolRefusalError',
      toolName: 'db:check_drift',
      code: 'invalid_input',
      details: { field: 'harness' },
      nestedResult: nested,
      dispatchMetadata: nested._meta,
      message: refusalText,
    });
    expect(metadata).toHaveBeenCalledWith({
      effectiveStatus: 'error',
      childFailureCount: 1,
      childFailureRefs: ['db:check_drift'],
    });
  });

  it('keeps structured nested refusal details when compact content omits the code', async () => {
    const nested = {
      isError: true,
      content: [{ type: 'text' as const, text: 'request refused by the target gate' }],
      structuredContent: {
        ok: false,
        error: { code: 'role_not_allowed', message: 'su cannot call this tool' },
        details: { requiredRole: 'operator' },
      },
    };
    const ctx = { dispatchTool: async () => nested };

    const rejection = await def.handler({ name: 'flags:set', args: {} }, ctx).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(NestedToolRefusalError);
    expect(rejection).toMatchObject({
      code: 'role_not_allowed',
      details: { requiredRole: 'operator' },
      message: 'role_not_allowed: request refused by the target gate',
    });
  });
});

describe('summarizeNestedToolOutcome', () => {
  const body = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });

  it('marks mixed batch results partial', () => {
    expect(summarizeNestedToolOutcome({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, counts: { ok: 2, failed: 1 } }) }],
    })).toEqual({ effectiveStatus: 'partial', childFailureCount: 1 });
  });

  /**
   * EI-20460134627396216. Measured live 2026-08-31 through the real dispatcher:
   * `work_items:search` for a token matching NOTHING and the same tool matching
   * plenty both recorded status=ok, effectiveStatus=ok, childFailureCount=0
   * (telemetry rows 23843990 / 23843994) — indistinguishable in every field but
   * raw byte size. These cases pin the discrimination that was missing.
   *
   * The `ok` cases below are the falsifiability controls: an implementation that
   * calls everything vacuous, or that reads a bare `ok:true` as empty, fails them.
   */
  describe('vacuous success — ok that measured nothing', () => {
    it('a search whose declared population came back empty is vacuous', () => {
      expect(summarizeNestedToolOutcome(body({ ok: true, count: 0, items: [] })))
        .toEqual({ effectiveStatus: 'vacuous', childFailureCount: 0 });
    });

    it('CONTROL: the same envelope with matches is ok, not vacuous', () => {
      expect(summarizeNestedToolOutcome(body({ ok: true, count: 1, items: [{ id: 'WI-1' }] })))
        .toEqual({ effectiveStatus: 'ok', childFailureCount: 0 });
    });

    it('a batch that neither succeeded nor failed at anything is vacuous', () => {
      expect(summarizeNestedToolOutcome(body({ ok: true, results: [], counts: { ok: 0, failed: 0 } })))
        .toEqual({ effectiveStatus: 'vacuous', childFailureCount: 0 });
    });

    it('CONTROL: a body declaring NO population is ok — absence needs its population', () => {
      // An action result. Calling this vacuous would mean "I recognized no field",
      // which is a claim about POPULATION_KEYS, not about the call.
      expect(summarizeNestedToolOutcome(body({ ok: true, flags: { a: true } })))
        .toEqual({ effectiveStatus: 'ok', childFailureCount: 0 });
    });

    it('CONTROL: one non-empty population among several is ok', () => {
      expect(summarizeNestedToolOutcome(body({ ok: true, results: [], rows: [{ n: 1 }] })))
        .toEqual({ effectiveStatus: 'ok', childFailureCount: 0 });
    });

    it('CONTROL: a real failure still outranks emptiness', () => {
      expect(summarizeNestedToolOutcome(body({ ok: false, items: [] })))
        .toEqual({ effectiveStatus: 'error', childFailureCount: 1 });
    });

    it('CONTROL: isError short-circuits before any population read', () => {
      expect(summarizeNestedToolOutcome({ ...body({ ok: true, items: [] }), isError: true }))
        .toEqual({ effectiveStatus: 'error', childFailureCount: 1 });
    });
  });
});

/**
 * P-012 (census double-count): the inner dispatch writes its own telemetry row, so
 * tools:invoke marks its OWN row as a dispatch wrapper for census exclusion. The
 * flag-off case is the falsifiability control: an implementation that stamps
 * unconditionally (or never) fails one of these two in each direction.
 */
describe('tools:invoke dispatch-wrapper mark (P-012)', () => {
  it('marks its row with dispatchWrapper + the dispatched tool when the flag is on', async () => {
    markEnabledMock.mockResolvedValueOnce(true);
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    await def.handler({ name: 'flags:get', args: {} }, ctx);
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchWrapper: true, dispatchedTool: 'flags:get' }),
    );
  });

  it('flag OFF (the kill-switch / control): metadata carries NO wrapper keys', async () => {
    // The module mock defaults to false — no mockResolvedValueOnce here on purpose.
    const metadata = vi.fn();
    const ctx = {
      metadata,
      dispatchTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    };
    await def.handler({ name: 'flags:get', args: {} }, ctx);
    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    expect(stamped).not.toHaveProperty('dispatchWrapper');
    expect(stamped).not.toHaveProperty('dispatchedTool');
  });

  it('a refusal that never dispatched stamps no metadata at all (no inner row exists)', async () => {
    markEnabledMock.mockResolvedValueOnce(true);
    const metadata = vi.fn();
    const ctx = { metadata, dispatchTool: vi.fn() };
    const res = await def.handler({ name: 'tools:invoke', args: {} }, ctx);
    expect(res.isError).toBe(true);
    expect(metadata).not.toHaveBeenCalled();
  });
});
