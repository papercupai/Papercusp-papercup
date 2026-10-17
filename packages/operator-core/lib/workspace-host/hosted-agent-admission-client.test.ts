import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchWithHostedAgentSlot, reserveHostedAgentSlot } from './hosted-agent-admission-client';

const env = { PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'hc_private',
  PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'wss://app.papercusp.com/api/hosted/connectors/socket?discard=yes' };
afterEach(() => vi.restoreAllMocks());

describe('hosted process reservation client', () => {
  it('reserves and starts before native launch, retaining the slot until an explicit host end', async () => {
    const order: string[] = [];
    const start = vi.fn(async () => { order.push('start'); });
    const release = vi.fn(async () => { order.push('finish'); });
    const reserve = vi.fn(async () => { order.push('reserve'); return { start, finish: release }; });
    const launchEnv = { ...env, PAPERCUSP_SID: 'owner' };
    let end!: () => Promise<void>;
    await launchWithHostedAgentSlot(launchEnv, finish => { order.push('spawn'); end = finish; }, reserve);
    expect(order).toEqual(['reserve', 'start', 'spawn']);
    expect(release).not.toHaveBeenCalled();
    await Promise.all([end(), end()]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['fleet', 'host-adoption'])('reuses the same %s slot for this owner, with no second tenant charge', async kind => {
    const launchEnv: NodeJS.ProcessEnv = { ...env, PAPERCUSP_SID: 'owner',
      ...(kind === 'fleet' ? { PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify({ metadata: {
        targetOwnerId: 'owner', hostedAgentProcessKey: 'existing' } }) } : {
        PAPERCUSP_HOSTED_NATIVE_SLOT: JSON.stringify({ ownerId: 'owner', processKey: 'existing' }) }) };
    const reserve = vi.fn(async () => ({ start: vi.fn(), finish: vi.fn() }));
    await launchWithHostedAgentSlot(launchEnv, () => {}, reserve);
    expect(reserve).toHaveBeenCalledWith('existing', launchEnv);
    expect(JSON.parse(launchEnv.PAPERCUSP_HOSTED_NATIVE_SLOT!)).toEqual({ ownerId: 'owner', processKey: 'existing' });
  });

  it.each(['{}', 'invalid', JSON.stringify({ ownerId: 'parent', processKey: 'parent-slot' })])(
    'does not inherit a different session slot (%s)', async raw => {
      const launchEnv = { ...env, PAPERCUSP_SID: 'new-owner', PAPERCUSP_HOSTED_NATIVE_SLOT: raw,
        PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify({ metadata: { targetOwnerId: 'parent', hostedAgentProcessKey: 'parent-slot' } }) };
      const reserve = vi.fn<typeof reserveHostedAgentSlot>(async () => null);
      await launchWithHostedAgentSlot(launchEnv, () => {}, reserve);
      expect(reserve.mock.calls[0]?.[0]).toMatch(/^native:/);
    });

  it('fails closed before native spawn on refusal and settles failed start or synchronous spawn', async () => {
    const launch = vi.fn();
    await expect(launchWithHostedAgentSlot(env, launch, vi.fn(async () => { throw new Error('quota'); }))).rejects.toThrow('quota');
    expect(launch).not.toHaveBeenCalled();
    const release = vi.fn(async () => {});
    await expect(launchWithHostedAgentSlot(env, launch, vi.fn(async () => ({
      start: async () => { throw new Error('start'); }, finish: release })))).rejects.toThrow('start');
    expect(release).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    release.mockClear();
    await expect(launchWithHostedAgentSlot(env, () => { throw new Error('spawn'); }, vi.fn(async () => ({
      start: async () => {}, finish: release })))).rejects.toThrow('spawn');
    expect(release).toHaveBeenCalledOnce();
  });

  it('leaves local installs alone and refuses partial or insecure hosted configuration', async () => {
    const send = vi.fn();
    expect(await reserveHostedAgentSlot('p', {}, send)).toBeNull();
    await expect(reserveHostedAgentSlot('p', { PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'x' }, send)).rejects.toThrow('config_incomplete');
    for (const origin of ['http://remote.example', 'https://user:secret@app.papercusp.com', 'bad-url']) {
      await expect(reserveHostedAgentSlot('p', { ...env, PAPERCUSP_HOSTED_CONTROL_PLANE_URL: origin }, send))
        .rejects.toThrow('origin_invalid');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('uses only the connector credential and process key; refuses redirect credential forwarding', async () => {
    const send = vi.fn(async (_url, init) => {
      const { action } = JSON.parse(init.body);
      return Response.json({ ok: true, receiptId: 'RG-1', state: action === 'reserve' ? 'queued' : action === 'start' ? 'running' : 'cancelled' });
    });
    const slot = await reserveHostedAgentSlot('process-1', env, send);
    await slot!.start(); await slot!.finish();
    expect(send.mock.calls.map(([url, init]) => [String(url), JSON.parse(init.body)])).toEqual(
      ['reserve', 'start', 'finish'].map(action => ['https://app.papercusp.com/api/hosted/connectors/agent-admission', { action, processKey: 'process-1' }]));
    expect(send.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer hc_private' } });
  });

  it.each([Response.json({ ok: false }), Response.json({ ok: true, receiptId: 'WI-1', state: 'queued' }),
    Response.json({ ok: true, receiptId: 'RG-1', state: 'cancelled' }), new Response('private-database-error', { status: 409 })])(
    'fails closed on refusal or invalid authority response', async response => {
      await expect(reserveHostedAgentSlot('p', env, vi.fn(async () => response)))
        .rejects.toThrow(/hosted_pool_agent_admission_(invalid_response|refused)/);
    });
});
