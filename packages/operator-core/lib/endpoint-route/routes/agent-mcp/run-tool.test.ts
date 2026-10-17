/**
 * run-tool.test.ts — POST /api/agent-mcp/run-tool (EI-1751's callerSid pass-
 * through). `isLoopbackRequest` + `invokeServerCapability` are mocked; this
 * pins the route's own shaping: `callerSid` is forwarded ONLY when it is a
 * non-empty string, trimmed, and hard-capped at 128 chars — never passed
 * through raw, and never required (an absent/non-string callerSid omits the
 * field entirely so invokeServerCapability's own `?? null` default applies).
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/agent-mcp/run-tool.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: vi.fn(() => true) }));
vi.mock('../../../agent-tools', () => ({}));
vi.mock('../../../capabilities/invoke', () => ({ invokeServerCapability: vi.fn() }));
vi.mock('../../../auth/principal/from-cookie', () => ({ principalFromCookie: vi.fn(async () => null) }));
vi.mock('../../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../../coverage-census/attribution/sink', () => ({ recordHttpTraffic: vi.fn() }));

import { invokeServerCapability } from '../../../capabilities/invoke';
import { principalFromCookie } from '../../../auth/principal/from-cookie';
import { registerRoute } from '../../define-route';
import { DEFAULT_ROUTE_STACK } from '../../route-stack';
const invokeM = vi.mocked(invokeServerCapability);
const tool = (await import('./run-tool')).default;

function req(body: unknown): Parameters<typeof tool.handler>[0] {
  return {
    headers: new Headers(),
    signal: new AbortController().signal,
    json: async () => body,
  } as unknown as Parameters<typeof tool.handler>[0];
}

// The route handler's declared type takes (req, ctx); this handler's own
// implementation never reads ctx, so a minimal stub is enough to satisfy
// the call signature.
function fakeCtx(): Parameters<typeof tool.handler>[1] {
  return {
    principal: null,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
  } as unknown as Parameters<typeof tool.handler>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(principalFromCookie).mockResolvedValue(null);
  invokeM.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
});

describe('POST /agent-mcp/run-tool — governed deadline receipt', () => {
  it.each(['work_items:get', 'tools:invoke'])('preserves the governed read deadline receipt for %s', async name => {
    vi.useFakeTimers();
    try {
      const receipt = { ok: false, counts: { ok: 0, failed: 1 },
        results: [{ id: 'WI-stalled', ok: false, availability: 'unavailable', error: 'timeout', retryable: true }] };
      invokeM.mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 30_001));
        return { ok: true, status: 200, body: { structuredContent: receipt } };
      });
      const app = new Hono();
      // Exercise the real endpoint watchdog boundary; auth is covered separately.
      registerRoute(app, tool, DEFAULT_ROUTE_STACK.filter(step => step.name === 'invoke'));
      const pending = app.request(tool.path, { method: 'POST',
        body: JSON.stringify({ name, args: { id: 'WI-stalled' } }) });
      await vi.advanceTimersByTimeAsync(30_010);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, result: { structuredContent: receipt } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POST /agent-mcp/run-tool — request cancellation', () => {
  it.each(['work_items:get', 'tools:invoke'])('carries the request signal for %s without trusting a body signal', async name => {
    const controller = new AbortController();
    const request = new Request('http://localhost/api/agent-mcp/run-tool', {
      method: 'POST', signal: controller.signal,
      body: JSON.stringify({ name, signal: { aborted: false } }),
    });
    await tool.handler(request, fakeCtx());
    const forwarded = (invokeM.mock.calls[0]![0] as { signal?: AbortSignal }).signal;
    expect(forwarded).toBe(request.signal);
    const reason = new Error('private HTTP caller disconnected');
    controller.abort(reason);
    expect(forwarded?.aborted).toBe(true);
    expect(forwarded?.reason).toBe(reason);
  });

  it('preserves a request cancelled before dispatch', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before route entry'));
    const request = new Request('http://localhost/api/agent-mcp/run-tool', {
      method: 'POST', signal: controller.signal, body: JSON.stringify({ name: 'work_items:get' }),
    });
    await tool.handler(request, fakeCtx());
    expect(invokeM).toHaveBeenCalledWith(expect.objectContaining({ signal: request.signal }));
  });
});

describe('POST /agent-mcp/run-tool — callerSid shaping', () => {
  it('carries the verified cookie actor rather than caller-supplied identity into dispatch', async () => {
    const principal = { kind: 'user' as const, slug: 'employee-id', workspaceId: 'ws1',
      authMethod: 'cookie-session' as const, trust: 'verified' as const, capabilities: new Set(['blueprint:submit']) };
    vi.mocked(principalFromCookie).mockResolvedValue(principal);
    const request = req({ name: 'blueprint:submit', authenticatedPrincipal: { slug: 'forged' } });
    await tool.handler(request, fakeCtx());
    expect(principalFromCookie).toHaveBeenCalledWith(request.headers);
    expect(invokeM).toHaveBeenCalledWith(expect.objectContaining({ authenticatedPrincipal: principal }));
  });

  it('does not trust an actor supplied in JSON without a verified session', async () => {
    await tool.handler(req({ name: 'blueprint:submit', authenticatedPrincipal: { slug: 'forged' } }), fakeCtx());
    expect(invokeM.mock.calls[0]![0]).not.toHaveProperty('authenticatedPrincipal');
  });

  it('no callerSid in the body ⇒ omits the field entirely', async () => {
    await tool.handler(req({ name: 't:x' }), fakeCtx());
    expect(invokeM).toHaveBeenCalledWith({ name: 't:x', args: undefined, confirmed: false,
      signal: expect.any(AbortSignal) });
  });

  it('a plain string callerSid is forwarded trimmed', async () => {
    await tool.handler(req({ name: 't:x', callerSid: '  pui-4242  ' }), fakeCtx());
    expect(invokeM).toHaveBeenCalledWith(
      expect.objectContaining({ callerSid: 'pui-4242' }),
    );
  });

  it('a non-string callerSid is dropped, not coerced', async () => {
    await tool.handler(req({ name: 't:x', callerSid: 12345 }), fakeCtx());
    const call = invokeM.mock.calls[0]![0];
    expect(call).not.toHaveProperty('callerSid');
  });

  it('an oversized callerSid is hard-capped at 128 chars', async () => {
    const long = 'x'.repeat(500);
    await tool.handler(req({ name: 't:x', callerSid: long }), fakeCtx());
    const call = invokeM.mock.calls[0]![0] as { callerSid?: string };
    expect(call.callerSid).toHaveLength(128);
  });

  it('a blank/whitespace-only callerSid is treated as absent', async () => {
    await tool.handler(req({ name: 't:x', callerSid: '   ' }), fakeCtx());
    const call = invokeM.mock.calls[0]![0];
    expect(call).not.toHaveProperty('callerSid');
  });

  it('forwards an explicit harness separately from tool args and caller identity', async () => {
    await tool.handler(req({ name: 'capability:computer', args: { action: 'screenshot' }, harness: 'desktop-pot' }), fakeCtx());
    expect(invokeM).toHaveBeenCalledWith({
      name: 'capability:computer', args: { action: 'screenshot' }, confirmed: false, harness: 'desktop-pot',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([{ harness: null }, { harness: 123 }, { harness: {} }, { harness: [] }])('rejects a non-string harness $harness before dispatch', async ({ harness }) => {
    const response = await tool.handler(req({ name: 'capability:computer', harness }), fakeCtx());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: 'invalid_harness' });
    expect(invokeM).not.toHaveBeenCalled();
  });
});
