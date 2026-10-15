import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { workspaceContextMiddleware } from './workspace-context-middleware';
import { activeWorkspaceId } from './workspace-registry';
import { installWorkspaceHeaderFetch } from './transport-adapters/workspace-header-fetch';
import { ipcFetch, type EndpointStreamEvent, type DispatchEndpointStreamFn } from '@papercusp/desktop-ipc';
import { handleSysHttp } from '@papercusp/ipc-endpoint-server';
import { FrameType, decodeEventBinPayload } from '@papercusp/ipc-framing';

// A real temp registry so the middleware's known-workspace check (D-007) is
// exercised end-to-end, not mocked.
let root: string;
let prevRoot: string | undefined;

function makeApp() {
  const app = new Hono();
  app.use('*', workspaceContextMiddleware);
  app.get('/probe', (c) => c.json({ ws: activeWorkspaceId() }));
  return app;
}

beforeAll(() => {
  prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  root = mkdtempSync(join(tmpdir(), 'pcws-mw-'));
  writeFileSync(
    join(root, 'registry.json'),
    JSON.stringify({
      current: 'ws-default',
      workspaces: [
        { id: 'ws-default', name: 'Default', createdAt: 1 },
        { id: 'ws-known', name: 'Known', createdAt: 2 },
      ],
    }),
  );
  process.env.PAPERCUSP_WORKSPACES_ROOT = root;
});

afterAll(() => {
  if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
  else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('workspaceContextMiddleware (per-window-workspace-context P-011)', () => {
  it('binds the browser workspace after the real fetch and sys:http bridges, independently of the host default', async () => {
    const app = new Hono();
    app.use('*', workspaceContextMiddleware);
    app.get('/api/zero-harness/rest-query', (c) => c.json({
      workspace: activeWorkspaceId(),
      requestWorkspace: c.req.header('x-papercusp-workspace') ?? null,
      name: c.req.query('name'),
      args: JSON.parse(c.req.query('args') ?? '{}'),
    }));
    const inputs: unknown[] = [];
    const dispatch: DispatchEndpointStreamFn = async function* (toolName, input, options) {
      expect(toolName).toBe('sys:http');
      inputs.push(input);
      const events: EndpointStreamEvent[] = [];
      await handleSysHttp(1n, input, options?.signal ?? new AbortController().signal, {
        upstreamBase: 'http://isolated.local',
        fetchImpl: async (url, init) => app.request(String(url), init),
        injectHeaders: () => ({ authorization: 'Bearer host-credential' }),
        logger: { info: () => {}, warn: () => {} },
        writeJson: (type, value: any) => {
          if (type === FrameType.EVENT_JSON) events.push({ kind: 'event', name: value.name, data: value.data });
          else if (type === FrameType.DONE) events.push({ kind: 'done', result: value.result });
          else if (type === FrameType.ERROR) events.push({ kind: 'error', ...value.error });
          return true;
        },
        writeFrame: (type, payload) => {
          expect(type).toBe(FrameType.EVENT_BIN);
          const decoded = decodeEventBinPayload(payload);
          events.push({ kind: 'binary', name: decoded.name, data: decoded.binary });
          return true;
        },
      });
      yield* events;
    };
    const request = '/api/zero-harness/rest-query?' + new URLSearchParams({
      name: 'plans.attention', args: JSON.stringify({ limit: 100, offset: 0 }),
    });
    vi.stubGlobal('window', {
      __PAPERCUSP_WS__: 'ws-known',
      location: { href: 'http://isolated.local/inbox?opci=all', origin: 'http://isolated.local' },
      fetch: (input: string, init?: RequestInit) => ipcFetch(input, init, { dispatch }),
    });
    try {
      // Negative control: the unwrapped bridge has no workspace signal.
      expect((await (await window.fetch(request)).json()).workspace).toBe('ws-default');
      installWorkspaceHeaderFetch();
      const response = await window.fetch(request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        workspace: 'ws-known', requestWorkspace: 'ws-known',
        name: 'plans.attention', args: { limit: 100, offset: 0 },
      });
      expect(inputs[1]).toMatchObject({ headers: { 'x-papercusp-workspace': 'ws-known' }, path: request });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('no header → falls back to the global active workspace', async () => {
    const res = await makeApp().request('/probe');
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-default');
  });

  it('known header → request resolves to that workspace', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'ws-known' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });

  it('present-but-unknown header → 400 (D-007), never a silent fallback', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'ws-bogus' },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('unknown_workspace');
    expect(body.workspace).toBe('ws-bogus');
  });

  it('the literal default workspace is always accepted', async () => {
    const res = await makeApp().request('/probe', {
      headers: { 'x-papercusp-workspace': 'default' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('default');
  });

  // Streams (EventSource/WS) can't set a custom header, so the workspace
  // rides as a ?ws= query param on connect (per-window-workspace-context P-015).
  it('falls back to the ?ws= query param when no header is present (stream connect)', async () => {
    const res = await makeApp().request('/probe?ws=ws-known');
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });

  it('rejects an unknown ?ws= query param too (D-007)', async () => {
    const res = await makeApp().request('/probe?ws=ws-bogus');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown_workspace');
  });

  it('the header wins over ?ws= when both are present', async () => {
    const res = await makeApp().request('/probe?ws=ws-default', {
      headers: { 'x-papercusp-workspace': 'ws-known' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ws).toBe('ws-known');
  });
});
