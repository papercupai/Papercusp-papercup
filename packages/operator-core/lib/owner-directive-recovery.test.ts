import { describe, expect, it, vi } from 'vitest';
import { sweepOwnerDirectiveRecovery, type DirectiveRecoveryDeps } from './owner-directive-recovery';

function deps(over: Partial<DirectiveRecoveryDeps> = {}): DirectiveRecoveryDeps {
  return {
    readCursor: vi.fn(async () => 0), stageCursor: vi.fn(async () => {}),
    list: vi.fn(async () => [{ id: 7, recordedBy: 'ended-session' }]),
    routes: vi.fn(async () => new Map([[7, { kind: 'unhandled' as const, why: 'no-fleet' as const, fleetSlug: null }]])),
    register: vi.fn(async () => ({ id: 'WI-7', created: true })), announce: vi.fn(async () => {}), ...over,
  };
}
const input = { workspaceId: 'ws', harness: 'papercusp' };
describe('orphan directive recovery sweep', () => {
  it('registers and advertises unhandled work without dispositioning its directive', async () => {
    const d = deps();
    expect(await sweepOwnerDirectiveRecovery({ ...input, deps: d })).toEqual({ examined: 1, created: 1, retained: 0, errors: [] });
    expect(d.register).toHaveBeenCalledWith({ id: 7, recordedBy: 'ended-session' });
    expect(d.announce).toHaveBeenCalledWith('WI-7');
    expect(d.stageCursor).toHaveBeenCalledWith(0);
  });
  it.each(['addressee', 'holder', 'fleet-leader', 'unknown'] as const)('does not take over %s custody', async (kind) => {
    const routes = new Map();
    if (kind === 'addressee') routes.set(7, { kind });
    if (kind === 'holder') routes.set(7, { kind, holders: ['live-holder'] });
    if (kind === 'fleet-leader') routes.set(7, { kind, fleetSlug: 'fleet', leaderOwnerId: 'leader' });
    const d = deps({ routes: vi.fn(async () => routes) });
    await sweepOwnerDirectiveRecovery({ ...input, deps: d });
    expect(d.register).not.toHaveBeenCalled();
  });
  it('retains and revisits a committed registration whose announcement failed', async () => {
    const d = deps({ register: vi.fn(async () => ({ id: 'WI-7', created: false })),
      announce: vi.fn(async () => { throw new Error('event delivery failed'); }) });
    expect((await sweepOwnerDirectiveRecovery({ ...input, deps: d })).errors).toEqual(['#7: event delivery failed']);
    expect(d.stageCursor).toHaveBeenCalledWith(0);
  });
  it('revisits registration failures on wrap but cannot proceed without liveness evidence', async () => {
    const d = deps({ register: vi.fn(async () => { throw new Error('write failed'); }) });
    expect((await sweepOwnerDirectiveRecovery({ ...input, deps: d })).errors).toHaveLength(1);
    expect(d.stageCursor).toHaveBeenCalledWith(0);
    const unknown = deps({ routes: vi.fn(async () => { throw new Error('liveness unavailable'); }) });
    await expect(sweepOwnerDirectiveRecovery({ ...input, deps: unknown })).rejects.toThrow('liveness unavailable');
    expect(unknown.register).not.toHaveBeenCalled();
  });
  it('advances a full page and wraps only after its end so old live rows cannot starve later directives', async () => {
    const d = deps({ readCursor: vi.fn(async () => 50),
      list: vi.fn(async () => Array.from({ length: 50 }, (_, i) => ({ id: 51 + i, recordedBy: 'live' }))),
      routes: vi.fn(async () => new Map()) });
    await sweepOwnerDirectiveRecovery({ ...input, deps: d });
    expect(d.list).toHaveBeenCalledWith(50, 50);
    expect(d.stageCursor).toHaveBeenCalledWith(100);
  });
  it('does not announce work when the directive closed before registration', async () => {
    const d = deps({ register: vi.fn(async () => null) });
    await sweepOwnerDirectiveRecovery({ ...input, deps: d });
    expect(d.announce).not.toHaveBeenCalled();
  });
});
