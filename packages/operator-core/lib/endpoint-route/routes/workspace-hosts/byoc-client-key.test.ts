import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';
import type {
  ByocClientAuthorizationRecord,
  ByocClientAuthorizationStore,
} from '../../../workspace-host/byoc-client-authorization';

const custody = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock('../../../workspace-host/byoc-client-key-custody', () => ({
  createByocClientKey: custody.create,
  revokeByocClientKey: custody.revoke,
  rotateByocClientKey: custody.rotate,
}));

import { createByocClientKeyRoutes } from './byoc-client-key';

const SCOPE = { organizationId: 'org-1', workspaceId: 'ws-1', hostId: 'host-1', clientId: 'desktop-1' };
const OLD_KEY = Buffer.alloc(32, 1).toString('base64');
const NEW_KEY = Buffer.alloc(32, 2).toString('base64');

class MemoryStore implements ByocClientAuthorizationStore {
  value: ByocClientAuthorizationRecord | null = null;
  async read() { return this.value; }
  async write(record: ByocClientAuthorizationRecord) { this.value = record; }
}

function ctx(): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: { hostId: 'host-1' },
    log: () => {},
    signal: new AbortController().signal,
  };
}

function request(path: string, body: unknown) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('BYOC desktop key lifecycle route', () => {
  it('is registered desktop-only and authorizes a created public key through the loopback tunnel', async () => {
    custody.create.mockResolvedValue({ publicKeyBase64: OLD_KEY, recoverySeedBase64: 'recovery' });
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, generation: 1 })) as unknown as typeof fetch;
    const [desktop] = createByocClientKeyRoutes({
      env: { PAPERCUSP_DESKTOP: '1' },
      fetchImpl,
      authorizationStore: new MemoryStore(),
      now: () => '2026-10-03T00:00:00.000Z',
    });
    expect(desktop.path).toBe('/workspace-hosts/:hostId/byoc-client-key');

    const response = await desktop.handler(request(desktop.path, {
      action: 'create',
      scope: SCOPE,
      customerHostOrigin: 'http://127.0.0.1:45123',
    }), ctx());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, publicKeyBase64: OLD_KEY, generation: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:45123/api/workspace-hosts/host-1/byoc-client-authorization',
      expect.objectContaining({ method: 'POST' }),
    );
    const sent = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body));
    expect(sent).toEqual({ action: 'authorize', scope: SCOPE, publicKeyBase64: OLD_KEY });
  });

  it('refuses the vendor/browser runtime and non-loopback ingress before touching custody', async () => {
    const [vendor] = createByocClientKeyRoutes({
      env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'hosted-control-plane' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      authorizationStore: new MemoryStore(),
      now: () => '2026-10-03T00:00:00.000Z',
    });
    const refused = await vendor.handler(request(vendor.path, {
      action: 'create', scope: SCOPE, customerHostOrigin: 'http://127.0.0.1:45123',
    }), ctx());
    expect(refused.status).toBe(403);
    expect(custody.create).not.toHaveBeenCalled();

    const [desktop] = createByocClientKeyRoutes({
      env: { PAPERCUSP_DESKTOP: '1' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      authorizationStore: new MemoryStore(),
      now: () => '2026-10-03T00:00:00.000Z',
    });
    const publicOrigin = await desktop.handler(request(desktop.path, {
      action: 'create', scope: SCOPE, customerHostOrigin: 'https://host.vendor.test',
    }), ctx());
    expect(publicOrigin.status).toBe(400);
    expect(custody.create).not.toHaveBeenCalled();
  });
});

describe('customer-host BYOC authorization route', () => {
  it('rotates atomically and refuses the old key and stale generation', async () => {
    const store = new MemoryStore();
    const [, host] = createByocClientKeyRoutes({
      env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      authorizationStore: store,
      now: () => '2026-10-03T00:00:00.000Z',
    });
    const post = (body: unknown) => host.handler(request(host.path, body), ctx());

    expect((await post({ action: 'authorize', scope: SCOPE, publicKeyBase64: OLD_KEY })).status).toBe(200);
    await expect((await post({ action: 'assert', scope: SCOPE, publicKeyBase64: OLD_KEY, generation: 1 })).json())
      .resolves.toMatchObject({ ok: true, status: 'authorized', generation: 1 });
    await expect((await post({
      action: 'rotate', scope: SCOPE, oldPublicKeyBase64: OLD_KEY, publicKeyBase64: NEW_KEY,
    })).json()).resolves.toMatchObject({ ok: true, status: 'authorized', generation: 2 });

    expect((await post({ action: 'assert', scope: SCOPE, publicKeyBase64: OLD_KEY })).status).toBe(409);
    expect((await post({ action: 'assert', scope: SCOPE, publicKeyBase64: NEW_KEY, generation: 1 })).status).toBe(409);
    await expect((await post({ action: 'assert', scope: SCOPE, publicKeyBase64: NEW_KEY, generation: 2 })).json())
      .resolves.toMatchObject({ ok: true, status: 'authorized', generation: 2 });
  });

  it('confirms an old-key revocation after rotation without revoking the replacement', async () => {
    const store = new MemoryStore();
    const [, host] = createByocClientKeyRoutes({
      env: { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      authorizationStore: store,
      now: () => '2026-10-03T00:00:00.000Z',
    });
    const post = (body: unknown) => host.handler(request(host.path, body), ctx());
    await post({ action: 'authorize', scope: SCOPE, publicKeyBase64: OLD_KEY });
    await post({ action: 'rotate', scope: SCOPE, oldPublicKeyBase64: OLD_KEY, publicKeyBase64: NEW_KEY });
    const confirmation = await post({ action: 'revoke', scope: SCOPE, publicKeyBase64: OLD_KEY });
    await expect(confirmation.json()).resolves.toMatchObject({ ok: true, status: 'authorized', generation: 2 });
    expect(store.value?.publicKeyBase64).toBe(NEW_KEY);
  });
});
