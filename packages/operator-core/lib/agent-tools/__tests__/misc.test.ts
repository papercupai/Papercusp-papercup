/**
 * Misc tools — autoloop:status/control, wiki:backlinks, omp:config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../autoloop');
  vi.doUnmock('../../workspace-brain-scope');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('@papercusp/db-org');
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('../../wiki-backlinks');
  vi.doUnmock('../../omp-config');
  vi.doUnmock('../../pot/soak-report');
  vi.doUnmock('../../pot/wake');
});

// The status/control tools read harness_shared.routines via getOrgPg().sql —
// stub the tagged-template client to return no schedule routines. PARTIAL mock:
// preserve the real module (esp. `generated`, which the full tool registry pulls
// in transitively via harness/get.ts when these tests load lookupByMcpName /
// dispatchProjectedTool) and override ONLY getOrgPg. A whole-module replacement
// dropped `generated` and crashed registry load.
const mockDbOrgSql = (rows: unknown[] = []) =>
  vi.doMock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getOrgPg: () => ({ sql: vi.fn(async () => rows) }),
  }));

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/** Read a bulk keyed-array envelope (bulk tools return the canonical { data }). */
function parseEnvelope(result: { data: unknown }): Record<string, unknown> {
  return result.data as Record<string, unknown>;
}

describe('autoloop:status', () => {
  it('returns fire-state rows with the backoff gate verdict + the schedule routines (P-009/P-010)', async () => {
    const rows = [{ harness_slug: 's', role: 'r', consecutive_errors: 0, last_fired_at: null }];
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(async () => rows),
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');
    const result = await tool.handler({ harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parseEnvelope(result as never);
    expect(payload).toEqual({
      harnessSlug: 'sheets',
      rows: [{ ...rows[0], gate: { allow: true, consecutiveErrors: 0 } }],
      scheduleRoutines: [],
    });
  });

  it('rejects with precondition_failed when no slug (declarative requires: — D-006)', async () => {
    // The former in-handler `if (!slug) throw` guard is lifted into a
    // `requires:` precondition; the DISPATCHER rejects before the handler runs.
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState: vi.fn(async () => null),
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');
    const { lookupByMcpName, dispatchProjectedTool } = await import('@papercusp/tooldef');
    // The tool declares the precondition…
    expect(tool.requires?.[0]?.id).toBe('harness-slug');
    // …and the dispatcher enforces it: no arg, no ctx slug → precondition_failed.
    const projected = lookupByMcpName('autoloop:status');
    expect(projected).toBeDefined();
    const denied = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ harnessSlug: undefined, emit: vi.fn() }),
      {},
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('precondition_failed');
    expect(denied.error?.message).toMatch(/slug required/i);
    // A ctx-scoped slug satisfies it (the handler then runs).
    const allowed = await dispatchProjectedTool(
      projected!,
      'autoloop:status',
      {},
      MAKE_CTX({ emit: vi.fn() }),
      {},
    );
    expect(allowed.ok).toBe(true);
  });

  it('does not let the evidence-only judge override its dispatched harness', async () => {
    const getAutoLoopState = vi.fn(async () => []);
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState,
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');

    const result = await tool.handler(
      { harnessSlug: 'other-harness' },
      MAKE_CTX({ role: 'judge', harnessSlug: 'sheets' }),
    );
    expect(parsePayload(result as never)).toMatchObject({ error: 'judge_harness_scope_mismatch' });
    expect(getAutoLoopState).not.toHaveBeenCalled();
  });

  it('lets the evidence-only judge read its dispatched harness without widening scope', async () => {
    const getAutoLoopState = vi.fn(async () => []);
    vi.doMock('../../autoloop', () => ({
      getAutoLoopState,
      evaluateFireGate: vi.fn(() => ({ allow: true, consecutiveErrors: 0 })),
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/status');

    const result = await tool.handler({}, MAKE_CTX({ role: 'judge', harnessSlug: 'sheets' }));
    expect(parseEnvelope(result as never)).toMatchObject({ harnessSlug: 'sheets', rows: null });
    expect(getAutoLoopState).toHaveBeenCalledWith('sheets');
  });
});

describe('autoloop:control', () => {
  it("pause flips the harness's bp-schedule-* routines inactive (durable — P-010)", async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([{ name: 'bp-schedule-0' }]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'pause', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'pause', harness: 'sheets', routines: ['bp-schedule-0'] });
  });

  it('resume reports when the blueprint declares no schedule', async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'resume', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    const payload = parsePayload(result as never);
    expect(payload).toMatchObject({ ok: true, op: 'resume', harness: 'sheets', routines: [] });
    expect(String(payload.note)).toMatch(/no bp-schedule/);
  });

  it('reset-errors zeroes the consecutive_errors counters (P-009 circuit reset)', async () => {
    const resetFireErrors = vi.fn(async () => 2);
    vi.doMock('../../autoloop', () => ({ resetFireErrors }));
    vi.doMock('../../workspace-brain-scope', () => ({
      isWorkspaceCoordinationOn: vi.fn(async () => false),
      workspaceBrainReadKeys: (_workspaceId: string, perPotSlug: string) => [perPotSlug],
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler({ op: 'reset-errors', harness: 'sheets' }, MAKE_CTX({ role: 'operator' }));
    expect(resetFireErrors).toHaveBeenCalledWith('sheets', undefined);
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, op: 'reset-errors', harness: 'sheets', rowsReset: 2 });
  });

  it('reset-errors also clears workspace-brain sentinel scope when coordination is on', async () => {
    const resetFireErrors = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    vi.doMock('../../autoloop', () => ({ resetFireErrors }));
    vi.doMock('../../workspace-brain-scope', () => ({
      isWorkspaceCoordinationOn: vi.fn(async () => true),
      workspaceBrainReadKeys: (workspaceId: string, perPotSlug: string, on: boolean) =>
        on ? [workspaceId, perPotSlug] : [perPotSlug],
    }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    const result = await tool.handler(
      { op: 'reset-errors', harness: '@singleton', role: 'scout-cycle' },
      MAKE_CTX({ role: 'operator', workspaceId: 'papercusp-workspace' }),
    );
    expect(resetFireErrors).toHaveBeenNthCalledWith(1, 'papercusp-workspace', 'scout-cycle');
    expect(resetFireErrors).toHaveBeenNthCalledWith(2, '@singleton', 'scout-cycle');
    expect(resetFireErrors).toHaveBeenNthCalledWith(3, '*', 'scout-cycle');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({
      ok: true,
      op: 'reset-errors',
      harness: '@singleton',
      rowsReset: 6,
      scopes: [
        { harness: 'papercusp-workspace', rowsReset: 1 },
        { harness: '@singleton', rowsReset: 2 },
        { harness: '*', rowsReset: 3 },
      ],
    });
  });

  it('exposes operator-only role gate + the harness-slug precondition (D-006)', async () => {
    vi.doMock('../../autoloop', () => ({ resetFireErrors: vi.fn() }));
    mockDbOrgSql([]);
    const { default: tool } = await import('../autoloop/control');
    expect(tool.agentRoles).toEqual(['operator']);
    expect(tool.requires?.[0]?.id).toBe('harness-slug');
  });
});

describe('loop:soak-report', () => {
  it('reads the resolved hive soak report', async () => {
    vi.doMock('../../pot/wake', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      resolvePotHomeSlug: vi.fn(() => 'papercusp'),
    }));
    vi.doMock('../../pot/soak-report', () => ({
      readPotSoakReport: vi.fn(async () => ({ potSlug: 'papercusp', ready: false, reasons: ['gate red'] })),
      MIN_SOAK_WINDOW_HOURS: 12,
      MAX_SOAK_WINDOW_HOURS: 24,
    }));
    const { default: tool } = await import('../loop/soak_report');
    const payload = parsePayload((await tool.handler({ windowHours: 24 }, MAKE_CTX())) as never);
    expect(payload).toEqual({
      ok: true,
      report: { potSlug: 'papercusp', ready: false, reasons: ['gate red'] },
    });
  });

  it('returns ok:false when no hive home resolves', async () => {
    vi.doMock('../../pot/wake', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      resolvePotHomeSlug: vi.fn(() => null),
    }));
    vi.doMock('../../pot/soak-report', () => ({
      readPotSoakReport: vi.fn(),
      MIN_SOAK_WINDOW_HOURS: 12,
      MAX_SOAK_WINDOW_HOURS: 24,
    }));
    const { default: tool } = await import('../loop/soak_report');
    const payload = parsePayload((await tool.handler({}, MAKE_CTX({ harnessSlug: undefined })) as never));
    expect(payload).toEqual({ ok: false, error: 'no hive home harness resolved' });
  });
});

// wiki:backlinks is bulk (bulk-endpoint-standardization-2026-06-21): single
// `target` | many `targets:[…]` → { ok, results:[{ ok, target, harness, hits[] |
// error }], counts }, correlate by target not position.
describe('wiki:backlinks (bulk keyed-array)', () => {
  it('forwards target + harness=null to findWikiBacklinks, wraps in the envelope', async () => {
    const findWikiBacklinks = vi.fn(async () => ({ target: 'doc', harness: null, hits: [] }));
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    const result = await tool.handler({ target: 'doc' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('doc', null);
    const payload = parseEnvelope(result as never);
    expect(payload).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect((payload as { results: unknown[] }).results[0]).toEqual({ ok: true, target: 'doc', harness: null, hits: [] });
  });

  it('passes the shared harness to every target', async () => {
    const findWikiBacklinks = vi.fn(async () => ({ target: '', harness: 'sheets', hits: [] }));
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    await tool.handler({ target: 'd', harness: 'sheets' }, MAKE_CTX());
    expect(findWikiBacklinks).toHaveBeenCalledWith('d', 'sheets');
  });

  it('targets:[…] fans out over many pages → results correlated by target', async () => {
    const findWikiBacklinks = vi.fn(async (target: string) => ({ target, harness: null, hits: [{ harness: 'h', filename: 'f.md', line: 1, snippet: target }] }));
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    const payload = parseEnvelope((await tool.handler({ targets: ['a', 'b'] }, MAKE_CTX())) as never) as {
      counts: { ok: number; failed: number };
      results: Array<{ target: string }>;
    };
    expect(payload.counts).toEqual({ ok: 2, failed: 0 });
    expect(payload.results.map((r) => r.target)).toEqual(['a', 'b']);
  });

  it('a per-target throw → that item { ok:false, target, error }; the batch survives', async () => {
    const findWikiBacklinks = vi.fn(async (target: string) => {
      if (target === 'bad') throw new Error('scan-failed');
      return { target, harness: null, hits: [] };
    });
    vi.doMock('../../wiki-backlinks', () => ({ findWikiBacklinks }));
    const { default: tool } = await import('../wiki/backlinks');
    const payload = parseEnvelope((await tool.handler({ targets: ['ok', 'bad'] }, MAKE_CTX())) as never) as {
      ok: boolean;
      counts: { ok: number; failed: number };
      results: Array<{ ok: boolean; target: string; error?: string }>;
    };
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(payload.ok).toBe(false);
    expect(payload.counts).toEqual({ ok: 1, failed: 1 });
    expect(payload.results[1]).toMatchObject({ ok: false, target: 'bad', error: 'scan-failed' });
  });
});

describe('omp:config', () => {
  it('get op returns sections', async () => {
    const sections = [{ name: 's', settings: [] }];
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(async () => sections),
      readOmpModelCatalog: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler({ op: 'get' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, sections });
  });

  it('catalog returns exact OMP model identities with explicit availability semantics', async () => {
    const models = [{
      provider: 'openai-codex',
      id: 'gpt-5.6-terra',
      selector: 'openai-codex/gpt-5.6-terra',
      name: 'GPT-5.6-Terra',
    }];
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      readOmpModelCatalog: vi.fn(async () => ({ models })),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler({ op: 'catalog' }, MAKE_CTX({ role: 'architect' }));
    expect(parsePayload(result as never)).toEqual({
      ok: true,
      availability: {
        kind: 'enabled-configured',
        credentials: 'unchecked',
        upstream: 'unchecked',
      },
      models,
    });
  });

  it('catalog reports an OMP read failure clearly', async () => {
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      readOmpModelCatalog: vi.fn(async () => { throw new Error('registry unavailable'); }),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    await expect(tool.handler({ op: 'catalog' }, MAKE_CTX())).rejects.toThrow(
      'omp:config catalog failed: registry unavailable',
    );
  });

  it('set rejects non-operator', async () => {
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      readOmpModelCatalog: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    await expect(
      tool.handler({ op: 'set', key: 'k', value: 'v' }, MAKE_CTX({ role: 'architect' })),
    ).rejects.toThrow(/operator role/i);
  });

  it('set as operator persists', async () => {
    const setOmpConfig = vi.fn(async () => ({ raw: 'v' }));
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      readOmpModelCatalog: vi.fn(),
      setOmpConfig,
      unsetOmpConfig: vi.fn(),
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'set', key: 'k', value: 'v' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(setOmpConfig).toHaveBeenCalledWith('k', 'v');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, raw: 'v' });
  });

  it('unset op as operator', async () => {
    const unsetOmpConfig = vi.fn(async () => undefined);
    vi.doMock('../../omp-config', () => ({
      readOmpConfig: vi.fn(),
      readOmpModelCatalog: vi.fn(),
      setOmpConfig: vi.fn(),
      unsetOmpConfig,
    }));
    const { default: tool } = await import('../omp/config');
    const result = await tool.handler(
      { op: 'unset', key: 'k' },
      MAKE_CTX({ role: 'operator' }),
    );
    expect(unsetOmpConfig).toHaveBeenCalledWith('k');
    const payload = parsePayload(result as never);
    expect(payload).toEqual({ ok: true, unset: true, key: 'k' });
  });
});
