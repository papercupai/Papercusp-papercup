import { beforeEach, describe, expect, it, vi } from 'vitest';
// DERIVE the wire versions from the canonical constants instead of re-typing
// them. `sessionPortProtocolError` hard-refuses any mismatch with 426
// upgrade-required BEFORE the handler runs, so a hand-copied literal turns
// every test in this file red the moment the protocol is bumped — which is
// exactly what happened when SESSION_PORT_PROTOCOL_VERSION went 1 -> 2 and
// these literals stayed at 1. The module is a side-effect-free constants file,
// so a static import is safe alongside this file's hoisted vi.mock factories.
import {
  SESSION_PORT_PROTOCOL_VERSION,
  SESSION_PORT_TRANSFORM_VERSION,
} from '../../session-port/types';

const PORT_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = `${PORT_ID}.${'a'.repeat(64)}`;

const getSessionPortMock = vi.fn();
const transitionSessionPortMock = vi.fn();
const deleteSessionPortArtifactMock = vi.fn();
const parsePortTokenMock = vi.fn();
const verifyPortTokenMock = vi.fn();
const updateAdvSessionPortStatusMock = vi.fn();
const recordSessionPortTelemetryMock = vi.fn();
const assertSessionPortStorageReadyMock = vi.fn();
const getAdvSessionInWorkspaceMock = vi.fn();

vi.mock('../../session-port/store', () => ({
  assertSessionPortStorageReady: (...args: unknown[]) => assertSessionPortStorageReadyMock(...args),
  getSessionPort: (...args: unknown[]) => getSessionPortMock(...args),
  transitionSessionPort: (...args: unknown[]) => transitionSessionPortMock(...args),
}));

vi.mock('../../session-port/artifact', () => ({
  deleteSessionPortArtifact: (...args: unknown[]) =>
    deleteSessionPortArtifactMock(...args),
  parsePortToken: (...args: unknown[]) => parsePortTokenMock(...args),
  verifyPortToken: (...args: unknown[]) => verifyPortTokenMock(...args),
}));

vi.mock('../../session-port/telemetry', () => ({
  classifySessionPortFailure: vi.fn(() => 'target-routing'),
  recordSessionPortTelemetry: (...args: unknown[]) =>
    recordSessionPortTelemetryMock(...args),
  telemetryFromInspection: vi.fn(),
}));

vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'papercusp-workspace'),
}));

vi.mock('../../adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-sessions')>()),
  getAdvSessionInWorkspace: (...args: unknown[]) => getAdvSessionInWorkspaceMock(...args),
  updateAdvSessionPortStatus: (...args: unknown[]) =>
    updateAdvSessionPortStatusMock(...args),
}));

vi.mock('../../desktop-window-liveness', () => ({
  gatherOnDesktopSessions: vi.fn(async () => null),
}));
vi.mock('../../omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('../../omp-sessions', () => ({
  findOmpSessionNear: vi.fn(),
  getOmpSessionRowSummary: vi.fn(() => null),
  getOmpSessionState: vi.fn(),
  searchOmpSessions: vi.fn(),
}));

type Route = {
  method: string;
  path: string;
  handler: (request: Request, context?: unknown) => Promise<Response>;
};

async function delivery(body: Record<string, unknown>): Promise<Response> {
  const routes = (await import('../routes/adv/sessions')).default as Route[];
  const route = routes.find(
    (candidate) =>
      candidate.method === 'POST' &&
      candidate.path === '/adv/sessions/port/delivery',
  );
  if (!route) throw new Error('session-port delivery route not registered');
  return route.handler(
    new Request('http://localhost:3170/api/adv/sessions/port/delivery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        workspace: 'papercusp-workspace',
        portId: PORT_ID,
        ...body,
      }),
    }),
  );
}

function port(overrides: Record<string, unknown> = {}) {
  return {
    id: PORT_ID,
    workspaceId: 'papercusp-workspace',
    protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
    status: 'prepared',
    sourceAdvSessionId: 41,
    targetAdvSessionId: null,
    sourceBackend: 'claude',
    targetBackend: 'codex',
    targetModel: 'gpt-5.6-sol:xhigh',
    tokenHash: 'token-hash',
    artifactPath: '/managed/port.seed.md',
    sourceHash: 'a'.repeat(64),
    normalizedHash: 'b'.repeat(64),
    renderedHash: 'c'.repeat(64),
    metadata: {},
    error: null,
    preparedAt: '2026-09-19T20:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionPortMock.mockResolvedValue(port());
  transitionSessionPortMock.mockImplementation(
    async (_id: string, _workspace: string, status: string, fields: object) =>
      port({ status, ...fields }),
  );
  deleteSessionPortArtifactMock.mockResolvedValue(true);
  parsePortTokenMock.mockImplementation((value: string) =>
    value === TOKEN ? { portId: PORT_ID, secret: 'a'.repeat(64) } : null,
  );
  verifyPortTokenMock.mockImplementation((value: string) => value === TOKEN);
  updateAdvSessionPortStatusMock.mockResolvedValue(true);
  recordSessionPortTelemetryMock.mockResolvedValue(true);
  assertSessionPortStorageReadyMock.mockReset().mockResolvedValue(undefined);
  getAdvSessionInWorkspaceMock.mockReset().mockResolvedValue(null);
});

describe('POST /adv/sessions/port/delivery — post-prepare failure finalization', () => {
  it('token-finalizes a prepared row with no target and deletes its seed immediately', async () => {
    const response = await delivery({
      status: 'failed',
      preparationToken: TOKEN,
      error:
        'target bootstrap/spawn failed after preparation: prepared target did not match bootstrap',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      status: 'failed',
      targetAdvSessionId: null,
      artifactDeleted: true,
    });
    expect(transitionSessionPortMock).toHaveBeenCalledWith(
      PORT_ID,
      'papercusp-workspace',
      'failed',
      {
        error:
          'target bootstrap/spawn failed after preparation: prepared target did not match bootstrap',
      },
    );
    expect(deleteSessionPortArtifactMock).toHaveBeenCalledWith(
      '/managed/port.seed.md',
    );
    expect(updateAdvSessionPortStatusMock).not.toHaveBeenCalled();
    expect(recordSessionPortTelemetryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'failed',
        portId: PORT_ID,
        targetAdvSessionId: null,
        cleanupOutcome: 'deleted',
        failureClass: 'target-routing',
      }),
    );
  });

  it('refuses a no-target failure without the exact opaque preparation token', async () => {
    const response = await delivery({
      status: 'failed',
      preparationToken: `${PORT_ID}.${'b'.repeat(64)}`,
      error: 'bootstrap failed',
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'valid preparationToken for this port is required',
    });
    expect(transitionSessionPortMock).not.toHaveBeenCalled();
    expect(deleteSessionPortArtifactMock).not.toHaveBeenCalled();
  });

  it('keeps the existing target-bound pending failure path unchanged', async () => {
    getSessionPortMock.mockResolvedValueOnce(
      port({ status: 'pending', targetAdvSessionId: 99 }),
    );
    const response = await delivery({
      status: 'failed',
      targetAdvSessionId: 99,
      error: 'native persistence verification failed',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'failed',
      artifactDeleted: true,
    });
    expect(updateAdvSessionPortStatusMock).toHaveBeenCalledWith(
      99,
      'papercusp-workspace',
      'failed',
      { deliveryError: 'native persistence verification failed' },
    );
  });
});

/**
 * WI-6554700010011137 — a launcher newer than its operator offered "Port to
 * claude" for a Codex session; the operator (main d740fc3802, same protocol
 * 2/transform 4) refused it with a raw 400 after the pick. The operator now
 * advertises its pairs, and the launcher reads them before building the picker.
 * For operators older than that route, the launcher reads the pair set back out
 * of the targetBackend refusal — so that refusal's wording is a contract too
 * (pinned from the launcher side in apps/operator/lib/psu-session-port-capabilities.test.ts).
 */
describe('session-port capability advertisement and preflight cancellation', () => {
  async function route(method: string, path: string): Promise<Route> {
    const routes = (await import('../routes/adv/sessions')).default as Route[];
    const found = routes.find((candidate) => candidate.method === method && candidate.path === path);
    if (!found) throw new Error(`${method} ${path} not registered`);
    return found;
  }

  function preflightRequest(path: string): Request {
    return new Request('http://localhost:3170/api' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
        transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        sourceAdvSessionId: 41,
        targetBackend: 'codex',
        expectedSourceHash: 'a'.repeat(64),
      }),
    });
  }

  it.each(['inspect', 'prepare'])('does not read storage for an already-aborted %s request', async (verb) => {
    const path = '/adv/sessions/port/' + verb;
    const target = await route('POST', path);
    const controller = new AbortController();
    controller.abort(new Error('preflight deadline expired'));

    const response = await target.handler(preflightRequest(path), { signal: controller.signal });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'preflight deadline expired' });
    expect(assertSessionPortStorageReadyMock).not.toHaveBeenCalled();
    expect(getAdvSessionInWorkspaceMock).not.toHaveBeenCalled();
    expect(recordSessionPortTelemetryMock).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'prepare'])('does not start a later read after the %s deadline expires during storage inspection', async (verb) => {
    const path = '/adv/sessions/port/' + verb;
    const target = await route('POST', path);
    const controller = new AbortController();
    assertSessionPortStorageReadyMock.mockImplementationOnce(async () => {
      controller.abort(new Error('preflight deadline expired'));
    });

    const response = await target.handler(preflightRequest(path), { signal: controller.signal });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'preflight deadline expired' });
    expect(assertSessionPortStorageReadyMock).toHaveBeenCalledTimes(1);
    expect(getAdvSessionInWorkspaceMock).not.toHaveBeenCalled();
    expect(recordSessionPortTelemetryMock).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'prepare'])('cancels the active tracked-source read with the %s watchdog signal', async (verb) => {
    const path = '/adv/sessions/port/' + verb;
    const target = await route('POST', path);
    const controller = new AbortController();
    getAdvSessionInWorkspaceMock.mockImplementationOnce(async (_id, _workspace, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(new Error('tracked source read abandoned'));
      options.signal.throwIfAborted();
    });

    const response = await target.handler(preflightRequest(path), { signal: controller.signal });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'tracked source read abandoned' });
    expect(recordSessionPortTelemetryMock).not.toHaveBeenCalled();
  });

  it('GET /adv/sessions/port/capabilities advertises every ordered cross-backend pair and the wire versions', async () => {
    const { SESSION_PORT_SUPPORTED_PAIRS } = await import('../../session-port/types');
    const capabilities = await route('GET', '/adv/sessions/port/capabilities');
    const response = await capabilities.handler(
      new Request('http://localhost:3170/api/adv/sessions/port/capabilities'),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      protocolVersion: number;
      transformVersion: number;
      backends: string[];
      pairs: Array<{ source: string; target: string }>;
    };
    expect(body).toMatchObject({
      ok: true,
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      transformVersion: SESSION_PORT_TRANSFORM_VERSION,
    });
    expect([...body.backends].sort()).toEqual(['claude', 'codex', 'omp']);
    expect(body.pairs).toEqual(SESSION_PORT_SUPPORTED_PAIRS);
    // Six ordered pairs, none same-backend (that is a native resume, not a port),
    // and the pair the owner hit — codex → claude — among them.
    expect(body.pairs).toHaveLength(6);
    expect(body.pairs.every((pair) => pair.source !== pair.target)).toBe(true);
    expect(body.pairs).toContainEqual({ source: 'codex', target: 'claude' });
    expect(recordSessionPortTelemetryMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown targetBackend before reading any session, in the wording launchers parse', async () => {
    const inspect = await route('POST', '/adv/sessions/port/inspect');
    const response = await inspect.handler(
      new Request('http://localhost:3170/api/adv/sessions/port/inspect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
          transformVersion: SESSION_PORT_TRANSFORM_VERSION,
          sourceAdvSessionId: 1,
          targetBackend: '__psu_capability_probe__',
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'targetBackend must be claude|codex|omp',
    });
    // The launcher's legacy probe relies on this refusal having no side effects.
    expect(recordSessionPortTelemetryMock).not.toHaveBeenCalled();
    expect(getSessionPortMock).not.toHaveBeenCalled();
  });
});
