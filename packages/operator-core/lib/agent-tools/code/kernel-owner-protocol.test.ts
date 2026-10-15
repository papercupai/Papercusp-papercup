import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => ({ locate: vi.fn(), call: vi.fn() }));
vi.mock('../../cluster-owner-rpc', () => ({
  bindOwnerRpcResource: vi.fn(), locateOwnerRpcResource: rpc.locate,
  callOwnerProcess: rpc.call, registerOwnerRpcHandler: vi.fn(),
}));
import { controlManagedKernel, runManagedKernelScript } from './kernel-owner';
const id = 'ec6f30b2-a0db-45a0-ae28-dacfead8e0f1';
const scope = 'trusted-current-scope';
beforeEach(() => { rpc.locate.mockReset(); rpc.call.mockReset(); });
describe('kernel placement failure truth', () => {
  it('does not label a placement timeout as lost state', async () => {
    rpc.locate.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow primary' });
    await expect(controlManagedKernel('status', id, scope)).rejects.toThrow('kernel_owner_unreachable:timeout');
    const out = await runManagedKernelScript('return 1;', { call: vi.fn() }, { kernel: { id, scope } });
    expect(out.ok).toBe(false); expect(out.kernel).toBeUndefined(); expect(rpc.call).not.toHaveBeenCalled();
  });
  it('does not label a live-owner response timeout as lost state or leave settlement unbounded', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    rpc.locate.mockResolvedValue({ ok: true, result: { ownerPid: process.pid + 1 } });
    rpc.call.mockResolvedValue({ ok: false, code: 'timeout', message: 'slow owner' });
    await expect(controlManagedKernel('close', id, scope)).rejects.toThrow('kernel_owner_unreachable:timeout');
    const settlement = vi.fn(() => new Promise<void>(() => {}));
    const out = await runManagedKernelScript('return 1;', { call: vi.fn() }, { kernel: { id, scope }, onTimeout: settlement, timeoutGraceMs: 20 });
    expect(out).toMatchObject({ ok: false, error: 'kernel_owner_timeout' });
    expect(out.kernel).toBeUndefined(); expect(settlement).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[bounded-timeout] exceeded 20ms — degrading to fallback');
    warning.mockRestore();
  });
  it('names unrecoverability only when placement establishes an unknown, foreign or dead owner', async () => {
    const reason = 'owner worker pid 41 is no longer live; process-local state cannot be recovered';
    rpc.locate.mockResolvedValue({ ok: false, code: 'owner_gone', message: reason });
    expect(await controlManagedKernel('status', id, scope)).toMatchObject({ state: 'unrecoverable', reason });
    expect(await runManagedKernelScript('return 1;', { call: vi.fn() }, { kernel: { id, scope } }))
      .toMatchObject({ ok: false, error: expect.stringContaining(reason), kernel: { state: 'unrecoverable', reason: expect.stringContaining(reason) } });
  });
});
