import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  create: vi.fn(() => async () => new Response(null, { status: 204 })),
}));

vi.mock('mcp-handler', () => ({ createMcpHandler: h.create }));
vi.mock('./_mcp-host', () => ({
  ensureOperatorToolsLoaded: h.load,
  registerMcpHost: () => {},
  mcpHostServerOptions: () => ({}),
}));
vi.mock('./mcp-auth-challenge', () => ({ mcpAuthChallenge: async () => null }));
vi.mock('./mcp-admission', () => ({
  ADMISSION_CONTROL_ENABLED: true,
  withMcpAdmission: (_req: Request, _pressure: unknown, _enabled: boolean, run: () => Promise<Response>) => run(),
}));
vi.mock('../../../event-loop-lag-monitor', () => ({ loopPressure: () => 'ok' }));
vi.mock('../../../superuser-token', () => ({ isLoopbackRequest: () => true }));
vi.mock('../../../connected-apps/key', () => ({ isAppKeyShaped: () => false }));

beforeEach(() => {
  vi.resetModules();
  h.load.mockReset().mockResolvedValue(undefined);
  h.create.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MCP HTTP lazy startup evidence (EI-27741955198794793)', () => {
  it('identifies a pending catalogue load and shares startup without exposing request data', async () => {
    const { mcpHandler } = await import('./_mcp-handler');
    expect(h.load).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    let release!: () => void;
    h.load.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.useFakeTimers();
    const traceId = 'b0fb17f4-581a-4f88-bff9-9c401d117461';
    const request = () => new Request('http://127.0.0.1/api/mcp?secret=private', {
      headers: { 'x-papercusp-mcp-trace-id': traceId, authorization: 'Bearer private' },
    });
    const first = mcpHandler(request());
    const second = mcpHandler(request());
    try {
      await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(5_000);
      const events = () => info.mock.calls.map(([text]) => JSON.parse(String(text).replace('[mcp-request-trace] ', '')));
      expect(events()).toContainEqual(expect.objectContaining({
        traceId, stage: 'http_handler_phase_pending', httpHandlerPhase: 'operator_catalogue_load',
      }));
      expect(events().some(event => event.httpHandlerPhase === 'host_module_load')).toBe(false);
      expect(h.create).not.toHaveBeenCalled();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: 204 }), expect.objectContaining({ status: 204 }),
      ]);
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(events()).toContainEqual(expect.objectContaining({
        traceId, stage: 'http_handler_phase_settled', httpHandlerPhase: 'operator_catalogue_load', outcome: 'success',
      }));
      expect(JSON.stringify(info.mock.calls)).not.toContain('private');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release?.();
      await Promise.allSettled([first, second]);
    }
  });

  it('keeps catalogue errors visible and retries initialization on the next request', async () => {
    const { mcpHandler } = await import('./_mcp-handler');
    const error = new Error('catalogue registration failed');
    h.load.mockRejectedValueOnce(error);
    const request = () => new Request('http://127.0.0.1/api/mcp');
    await expect(mcpHandler(request())).rejects.toBe(error);
    expect(h.create).not.toHaveBeenCalled();
    await expect(mcpHandler(request())).resolves.toHaveProperty('status', 204);
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});
