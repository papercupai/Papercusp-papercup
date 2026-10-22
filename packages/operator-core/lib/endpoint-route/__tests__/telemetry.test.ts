/**
 * route-invocation telemetry — sampling gate + fire-and-forget safety.
 *
 * The PG write is fire-and-forget (racy to assert directly); these tests
 * cover the synchronous, deterministic surface: the sampleRate gate and
 * that `recordRouteInvocation` never throws into the route-stack's
 * `finally`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

let unsafeCalls: Array<{ sql: string; params: unknown[] }> = [];
const sqlBegin = vi.fn(async (fn: (tx: { unsafe: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>) => {
  await fn({
    unsafe: async (sql: string, params?: unknown[]) => {
      unsafeCalls.push({ sql, params: params ?? [] });
    },
  });
});
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(() => ({ sql: { begin: sqlBegin } })),
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'ws-test'),
}));

import { recordRouteInvocation } from '../telemetry';
import { getOrgPg } from '@papercusp/db-org';
import type { RouteExecution } from '../route-stack';
import { registerRoute, type RouteDefinition } from '../define-route';
import { createHostedRouteStack } from '../hosted-route-stack';

function execWith(
  over: Partial<RouteDefinition> & { status?: RouteExecution['status']; url?: string; responseBytes?: number | null; headers?: HeadersInit } = {},
): RouteExecution {
  const { status, url, responseBytes, headers, ...defOver } = over;
  return {
    def: {
      method: 'GET',
      path: '/x',
      auth: 'public',
      handler: () => new Response(),
      ...defOver,
    } as RouteDefinition,
    hono: {} as never,
    req: new Request(url ?? 'http://x/x', { headers }),
    startedAt: Date.now() - 5,
    principal: null,
    input: undefined,
    abort: new AbortController(),
    timeoutTimer: null,
    status: status ?? 'ok',
    responseBytes: responseBytes ?? null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  unsafeCalls = [];
});

describe('recordRouteInvocation — session port diagnostics', () => {
  it.each(['/adv/sessions/port/inspect', '/adv/sessions/port/prepare'])(
    'persists completed phases on a timed-out %s without request content', async (path) => {
      const exec = execWith({ method: 'POST', path, status: 'timeout',
        headers: { authorization: 'Bearer private-auth-marker' } });
      exec.routeDiagnostics = { measure: async (_phase, work) => work(),
        snapshot: () => ({ 'port.launch-spec': 24_000, 'port.acquire-source': 12, 'private text': 1, invalid: NaN }) };
      recordRouteInvocation(exec);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const call = findInsertCall();
      const metadata = call.params.find((value) => typeof value === 'string' && value.includes('routePhaseTimingsMs'));
      expect(JSON.parse(String(metadata))).toEqual({ routePhaseTimingsMs: {
        'port.launch-spec': 24_000, 'port.acquire-source': 12,
      } });
      expect(JSON.stringify(call.params)).not.toContain('private-auth-marker');
    },
  );
});

describe('recordRouteInvocation — sampling gate', () => {
  it('sampleRate 0 → never touches PG', () => {
    recordRouteInvocation(execWith({ sampleRate: 0 }));
    expect(getOrgPg).not.toHaveBeenCalled();
  });

  it('sampleRate 1 (default) → attempts the write', async () => {
    recordRouteInvocation(execWith());
    // Fire-and-forget — let the microtask run.
    await new Promise((r) => setTimeout(r, 0));
    expect(getOrgPg).toHaveBeenCalled();
  });

  it('sampleRate 1 explicit → attempts the write', async () => {
    recordRouteInvocation(execWith({ sampleRate: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(getOrgPg).toHaveBeenCalled();
  });

  it('never throws synchronously, whatever the status', () => {
    for (const status of ['ok', 'error', 'timeout', 'unauthorized'] as const) {
      expect(() => recordRouteInvocation(execWith({ status }))).not.toThrow();
    }
  });
});

/** recordRouteInvocation's tx runs TWO tx.unsafe calls per write (a
 *  set_config, then the INSERT) — isolate the INSERT for assertions. */
function findInsertCall(): { sql: string; params: unknown[] } {
  const found = unsafeCalls.find((c) => c.sql.includes('INSERT INTO harness_shared.route_invocations'));
  if (!found) throw new Error(`no INSERT call captured among ${unsafeCalls.length} tx.unsafe call(s)`);
  return found;
}

describe('recordRouteInvocation — resolved path + response bytes (EI-7069)', () => {
  it('records the RESOLVED request path, distinct from the route TEMPLATE', async () => {
    recordRouteInvocation(
      execWith({ path: '/admin/plans/:verb', url: 'http://x/admin/plans/attention?tier=trimmed' }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const { sql: insertSql, params } = findInsertCall();
    expect(insertSql).toContain('resolved_path');
    // template path stays $3 (path), resolved path is the new $10 slot.
    expect(params).toContain('/admin/plans/:verb');
    expect(params).toContain('/admin/plans/attention');
  });

  it('an unparseable request URL degrades resolved_path to null rather than throwing', async () => {
    const exec = execWith();
    // Force an unparseable URL onto the already-built Request-backed exec.
    Object.defineProperty(exec.req, 'url', { value: 'not a url', configurable: true });
    expect(() => recordRouteInvocation(exec)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    expect(params).toContain(null);
  });

  it('records response_bytes when the orchestrator set it (Content-Length present)', async () => {
    recordRouteInvocation(execWith({ responseBytes: 1234 }));
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    expect(params).toContain(1234);
  });

  it('response_bytes stays null for a streaming response (no Content-Length)', async () => {
    recordRouteInvocation(execWith({ responseBytes: null }));
    await new Promise((r) => setTimeout(r, 0));
    const { params } = findInsertCall();
    // response_bytes is the $11 bound param; assert it's specifically null,
    // not just "params contains null somewhere" (principal fields are also null here).
    expect(params[10]).toBeNull();
  });
});

describe('recordRouteInvocation — Codex home repair correlation confidentiality', () => {
  const attemptId = '78a48e81-3884-4af5-b864-e1ba22969740';
  const path = '/adv/sessions/ensure-codex-home';

  function metadata(): unknown {
    const { params } = findInsertCall();
    return typeof params[11] === 'string' ? JSON.parse(params[11]) : null;
  }

  it.each([attemptId, attemptId.toUpperCase()])('persists only the validated attempt UUID (%s)', async (header) => {
    const exec = execWith({ method: 'POST', path,
      url: 'http://x/api' + path + '?private=query-marker',
      headers: { 'x-papercusp-repair-attempt': header, authorization: 'Bearer private-auth-marker',
        'x-private-header': 'private-header-marker' },
    });
    recordRouteInvocation(exec);
    // The finally recorder must snapshot before the caller can mutate exec.
    exec.req.headers.set('x-papercusp-repair-attempt', 'private-late-header-marker');
    await vi.waitFor(() => expect(metadata()).toEqual({ codexHomeRepairAttemptId: attemptId }));
    expect(findInsertCall().sql).toContain('metadata_json');
    const persisted = JSON.stringify(findInsertCall().params);
    for (const marker of ['query-marker', 'private-auth-marker', 'private-header-marker', 'private-late-header-marker']) {
      expect(persisted).not.toContain(marker);
    }
  });

  it('persists only bounded numeric route phase timings for a validated repair attempt', async () => {
    const exec = execWith({ method: 'POST', path,
      headers: { 'x-papercusp-repair-attempt': attemptId },
    });
    exec.routeDiagnostics = {
      snapshot: () => ({
        'handler.read-session-row': 3.6,
        'handler.too-large': 90_000_001,
        'handler.negative': -1,
        'handler.nan': Number.NaN,
        'handler.infinity': Number.POSITIVE_INFINITY,
        'Bad phase': 7,
      }),
      measure: async (_phase, work) => work(),
    };
    recordRouteInvocation(exec);

    await vi.waitFor(() => expect(metadata()).toEqual({
      codexHomeRepairAttemptId: attemptId,
      routePhaseTimingsMs: {
        'handler.read-session-row': 4,
        'handler.too-large': 86_400_000,
      },
    }));
  });

  it.each([
    ['missing', undefined],
    ['arbitrary content', 'private-invalid-attempt-marker'],
    ['duplicate header values', attemptId + ', ' + attemptId],
    ['UUID with a suffix', attemptId + '-private-suffix-marker'],
    ['nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['wrong variant', '78a48e81-3884-4af5-7864-e1ba22969740'],
    ['oversized header', 'private-oversized-marker' + 'x'.repeat(1024)],
  ])('omits %s without copying request headers', async (_label, header) => {
    recordRouteInvocation(execWith({ method: 'POST', path,
      headers: header === undefined ? {} : { 'x-papercusp-repair-attempt': header },
    }));
    await vi.waitFor(() => {
      expect(findInsertCall()).toBeDefined();
      expect(metadata()).toBeNull();
    });
    if (header !== undefined) expect(JSON.stringify(findInsertCall().params)).not.toContain(header);
  });

  it.each([
    ['GET', path],
    ['POST', '/adv/sessions/ensure-claude-home'],
    ['POST', path + '/other'],
  ])('omits the header on unrelated %s %s routes', async (method, routePath) => {
    recordRouteInvocation(execWith({ method: method as 'GET' | 'POST', path: routePath,
      headers: { 'x-papercusp-repair-attempt': attemptId },
    }));
    await vi.waitFor(() => {
      expect(findInsertCall()).toBeDefined();
      expect(metadata()).toBeNull();
    });
    expect(JSON.stringify(findInsertCall().params)).not.toContain(attemptId);
  });
});

describe('mounted hosted route telemetry confidentiality census', () => {
  it('records the actual pathname but omits query, request body and response content', async () => {
    const pathMarker = 'census-path-marker';
    const queryMarker = 'census-query-marker';
    const bodyMarker = 'census-request-body-marker';
    const responseMarker = 'census-response-body-marker';
    const app = new Hono().basePath('/api');
    const def: RouteDefinition = {
      method: 'POST', path: '/hosted/workspaces/:workspaceId', auth: 'public', sampleRate: 1,
      handler: () => Response.json({ content: responseMarker }),
    };
    // Exercise registerRoute -> hosted stack -> actual finally recorder. Only
    // the PG transport is captured; telemetry and its call site are not mocked.
    registerRoute(app, def, createHostedRouteStack(async () => ({ ok: false, reason: 'session_cookie_missing' })));
    const response = await app.request('/api/hosted/workspaces/' + pathMarker + '?query=' + queryMarker, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: bodyMarker }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: responseMarker });
    await vi.waitFor(() => {
      const { params } = findInsertCall();
      expect(params).toContain(def.path);
      expect(params).toContain('/api/hosted/workspaces/' + pathMarker);
      const persisted = JSON.stringify(params);
      expect(persisted).toContain(pathMarker);
      for (const marker of [queryMarker, bodyMarker, responseMarker]) expect(persisted).not.toContain(marker);
    });
  });
});

describe('recordRouteInvocation — degraded environments (gate hold 2026-06-10)', () => {
  it('partial db-org mock (no sql.begin) → silent no-op, no write, no warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getOrgPg).mockReturnValueOnce({} as never);
    recordRouteInvocation(execWith());
    await new Promise((r) => setTimeout(r, 0));
    expect(sqlBegin).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Keep LAST: trips the module-level once-flag for the rest of the process.
  it('repeated write failures warn exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlBegin.mockImplementation(async () => {
      throw new Error('private-route-database-error-marker');
    });
    recordRouteInvocation(execWith({ path: '/private-route-template-marker' }));
    recordRouteInvocation(execWith());
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      '[route-telemetry] write failed (further telemetry write failures suppressed)',
      'route_telemetry_write_failed',
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-route-database-error-marker');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-route-template-marker');
    sqlBegin.mockImplementation(async () => {});
    warn.mockRestore();
  });
});
