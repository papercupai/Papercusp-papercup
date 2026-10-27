import { describe, expect, it, vi } from 'vitest';
import { createDesktopPortalLifecycle } from './desktop-portal-lifecycle';
import { createDesktopPortalHost } from './desktop-portal-host';

const env = { PAPERCUSP_DESKTOP_INTERFACE: 'portal-candidate',
  PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE: '/private/desktop-portal.cjs',
  PORTAL_DATABASE_URL: 'postgres://local-fixture/portal' };
const request = (path = '/api/apps') => new Request('http://localhost:21696' + path);

describe('opt-in desktop portal runtime lifecycle', () => {
  it('leaves the legacy host and sidecar health on their original paths without loading a portal store', async () => {
    const operator = vi.fn(() => Response.json({ source: 'operator' }));
    const load = vi.fn();
    const legacy = createDesktopPortalLifecycle({ operator, load, env: {} });
    expect((await legacy.fetch(request())).status).toBe(200);
    await legacy.stop();
    const candidate = createDesktopPortalLifecycle({ operator, load, env });
    expect((await candidate.fetch(request('/api/health'))).status).toBe(200);
    await candidate.stop();
    expect(load).not.toHaveBeenCalled();
    expect(operator).toHaveBeenCalledTimes(2);
  });

  it('opens once for concurrent API requests and forwards native bindings through the original adapter', async () => {
    const operator = vi.fn(() => Response.json({ source: 'operator' }));
    const fetch = vi.fn(() => Response.json({ source: 'portal' }));
    const stop = vi.fn(async () => {});
    const createDesktopPortalApplication = vi.fn(async () => ({ fetch, stop }));
    const load = vi.fn(async () => ({ createDesktopPortalApplication }));
    const host = createDesktopPortalLifecycle({ env, operator, load });
    const bindings = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
    const req = request();
    await Promise.all([host.fetch(req, bindings), host.fetch(req, bindings)]);
    expect(load).toHaveBeenCalledOnce();
    expect(createDesktopPortalApplication).toHaveBeenCalledWith({ operator, createHost: createDesktopPortalHost });
    expect(fetch).toHaveBeenCalledWith(req, bindings);
    await Promise.all([host.stop(), host.stop()]);
    expect(stop).toHaveBeenCalledOnce();
    expect((await host.fetch(request())).status).toBe(503);
  });

  it('waits for an in-flight persistent open when shutdown starts', async () => {
    let ready!: (value: { createDesktopPortalApplication: () => Promise<{ fetch: () => Response; stop: () => Promise<void> }> }) => void;
    const stop = vi.fn(async () => {});
    const pending = new Promise<Parameters<typeof ready>[0]>(resolve => { ready = resolve; });
    const host = createDesktopPortalLifecycle({ env, operator: () => Response.json({}), load: () => pending });
    const fetching = host.fetch(request());
    const stopping = host.stop();
    ready({ createDesktopPortalApplication: async () => ({ fetch: () => Response.json({}), stop }) });
    await Promise.all([fetching, stopping]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('requires prepared local bytes and an explicit persistent database, refusing ambient memory mode', () => {
    const operator = () => Response.json({});
    expect(() => createDesktopPortalLifecycle({ operator, env: { ...env, PAPERCUSP_DESKTOP_PORTAL_HOST_BUNDLE: 'relative.cjs' } }))
      .toThrow('explicit prepared .cjs');
    expect(() => createDesktopPortalLifecycle({ operator, env: { ...env, PORTAL_DATABASE_URL: '' } }))
      .toThrow('persistent PORTAL_DATABASE_URL');
    expect(() => createDesktopPortalLifecycle({ operator, env: { ...env, PORTAL_USE_MEMORY_STORE: '1' } }))
      .toThrow('ephemeral memory');
  });
});
