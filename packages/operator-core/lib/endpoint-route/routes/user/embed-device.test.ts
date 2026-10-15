/**
 * /api/user/embed-device (plan memory-reduction-2026-09-24 P-008 / D-008,
 * WI-10002872). Every side effect is injected — the PG row, this process's
 * apply, the sidecar probe and reload — so this pins the route's contract:
 * which process it reports on, what "applied" means, and that a save reaches
 * the sidecar or says plainly why not.
 */
import type { EmbedDevicePreference, EmbedExecutionHealth } from '@papercusp/memory';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
}));

import { EMBED_SIDECAR_CAP_DEVICE_RELOAD, EMBED_SIDECAR_CAP_HEALTHZ } from '../../../memory/embed-sidecar-server';
import { createEmbedDeviceRoutes, type EmbedDeviceHost, type EmbedDeviceRouteDeps } from './embed-device';

type Route = { method: string; path: string; auth: string; handler: (req: Request) => Promise<Response> };

const SIDECAR: EmbedDeviceHost = { kind: 'sidecar', url: 'http://127.0.0.1:3384' };

// Only identity matters here: the route relays the report, it does not interpret it.
const localHealth = { requested: { device: 'cpu', source: 'setting' }, marker: 'in-process' } as unknown as EmbedExecutionHealth;
const sidecarHealth = { requested: { device: 'cuda', source: 'setting' }, marker: 'sidecar' };

function makeDeps(over: Partial<EmbedDeviceRouteDeps> = {}) {
  const calls: string[] = [];
  let stored: EmbedDevicePreference | null = null;
  const deps: EmbedDeviceRouteDeps = {
    readSetting: vi.fn(async () => stored),
    writeSetting: vi.fn(async (p: EmbedDevicePreference) => {
      calls.push(`write:${p}`);
      stored = p;
    }),
    applyLocal: vi.fn(async () => {
      calls.push('applyLocal');
      return { setting: stored, changed: true, readError: null };
    }),
    resolveHost: vi.fn(() => SIDECAR),
    probeSidecar: vi.fn(async () => ({
      capabilities: [EMBED_SIDECAR_CAP_HEALTHZ, EMBED_SIDECAR_CAP_DEVICE_RELOAD],
      embedExecutionHealth: sidecarHealth,
    })),
    localHealth: vi.fn(() => localHealth),
    reloadSidecar: vi.fn(async (url: string) => {
      calls.push(`reload:${url}`);
      return { status: 200, body: { ok: true, changed: true, readError: null, rewarm: { timedOut: false, models: {} } } };
    }),
    ...over,
  };
  const [get, post] = createEmbedDeviceRoutes(deps) as unknown as Route[];
  return { deps, calls, get: get!, post: post! };
}

const getReq = () => new Request('http://127.0.0.1/api/user/embed-device');
const postReq = (body: unknown) =>
  new Request('http://127.0.0.1/api/user/embed-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('/api/user/embed-device', () => {
  it('mounts GET as public and POST as loopback (the sibling settings routes’ tier)', () => {
    const { get, post } = makeDeps();
    expect([get.method, get.path, get.auth]).toEqual(['GET', '/user/embed-device', 'public']);
    expect([post.method, post.path, post.auth]).toEqual(['POST', '/user/embed-device', 'loopback']);
  });

  it('GET reports the SIDECAR’s device when a sidecar embeds for this host — not this process’s', async () => {
    const { get, deps } = makeDeps();
    const body = await (await get.handler(getReq())).json();
    expect(body).toMatchObject({
      setting: null,
      settingError: null,
      host: SIDECAR,
      health: sidecarHealth,
      healthError: null,
      reloadSupported: true,
    });
    expect(deps.localHealth).not.toHaveBeenCalled();
  });

  it('GET reports this process when no sidecar is configured', async () => {
    const { get, deps } = makeDeps({ resolveHost: () => ({ kind: 'in-process' }) });
    const body = await (await get.handler(getReq())).json();
    expect(body).toMatchObject({ host: { kind: 'in-process' }, health: localHealth, reloadSupported: null });
    expect(deps.probeSidecar).not.toHaveBeenCalled();
  });

  it('GET says why when the sidecar is down or too old to report a device — never a blank', async () => {
    const down = makeDeps({ probeSidecar: async () => null });
    const downBody = await (await down.get.handler(getReq())).json();
    expect(downBody.health).toBeNull();
    expect(downBody.healthError).toContain('did not answer');

    const old = makeDeps({ probeSidecar: async () => ({ capabilities: [EMBED_SIDECAR_CAP_HEALTHZ] }) });
    const oldBody = await (await old.get.handler(getReq())).json();
    expect(oldBody.health).toBeNull();
    expect(oldBody.healthError).toContain('Restart');
    expect(oldBody.reloadSupported).toBe(false);
  });

  it('GET survives an unreadable setting row (settingError), still reporting the device', async () => {
    const { get } = makeDeps({
      readSetting: async () => {
        throw new Error('relation does not exist');
      },
    });
    const res = await get.handler(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ setting: null, settingError: 'relation does not exist', health: sidecarHealth });
  });

  it('POST stores the choice, applies it here, THEN asks the sidecar to reload — in that order', async () => {
    const { post, calls, deps } = makeDeps();
    const res = await post.handler(postReq({ preference: 'gpu' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // `gpu` is the user-facing word for the stored `cuda`.
    expect(deps.writeSetting).toHaveBeenCalledWith('cuda', 'settings');
    expect(calls).toEqual(['write:cuda', 'applyLocal', `reload:${SIDECAR.url}`]);
    expect(body).toMatchObject({
      ok: true,
      setting: 'cuda',
      applied: {
        thisProcess: { setting: 'cuda', changed: true, readError: null },
        sidecar: { ok: true, changed: true, readError: null },
      },
    });
  });

  it('POST to an older sidecar build (404) keeps the saved choice and says a restart applies it', async () => {
    const { post } = makeDeps({ reloadSidecar: async () => ({ status: 404, body: null }) });
    const body = await (await post.handler(postReq({ preference: 'cpu' }))).json();
    expect(body.ok).toBe(true);
    expect(body.setting).toBe('cpu');
    expect(body.applied.sidecar).toMatchObject({ ok: false, restartNeeded: true });
  });

  it('POST relays an unreachable sidecar as an error, not a success', async () => {
    const { post } = makeDeps({
      reloadSidecar: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const body = await (await post.handler(postReq({ preference: 'auto' }))).json();
    expect(body.applied.sidecar).toMatchObject({ ok: false, restartNeeded: false });
    expect(body.applied.sidecar.error).toContain('ECONNREFUSED');
  });

  it('P-530: an on-demand sidecar that is not running is neither probed nor reloaded — and is not an error', async () => {
    const { get, post, deps } = makeDeps({ resolveHost: () => ({ kind: 'sidecar-idle' }) });
    const body = await (await get.handler(getReq())).json();
    expect(body).toMatchObject({ host: { kind: 'sidecar-idle' }, health: null, healthError: null, reloadSupported: null });
    const applied = await (await post.handler(postReq({ preference: 'gpu' }))).json();
    expect(applied.applied.sidecar).toBeNull();
    expect(deps.probeSidecar).not.toHaveBeenCalled();
    expect(deps.reloadSidecar).not.toHaveBeenCalled();
  });

  it('POST with no sidecar applies to this process only', async () => {
    const { post, deps } = makeDeps({ resolveHost: () => ({ kind: 'in-process' }) });
    const body = await (await post.handler(postReq({ preference: 'cpu' }))).json();
    expect(body.applied.sidecar).toBeNull();
    expect(deps.applyLocal).toHaveBeenCalledTimes(1);
    expect(deps.reloadSidecar).not.toHaveBeenCalled();
  });

  it('POST rejects a bad preference or body with 400 and stores nothing', async () => {
    const { post, deps } = makeDeps();
    expect((await post.handler(postReq({ preference: 'tpu' }))).status).toBe(400);
    expect((await post.handler(postReq({}))).status).toBe(400);
    expect((await post.handler(postReq('not json'))).status).toBe(400);
    expect(deps.writeSetting).not.toHaveBeenCalled();
  });
});
