import { describe, expect, it, vi } from 'vitest';
import { currentRequestWorkspaceId } from '../../workspace-als';
import type { ExpirySweepDeps } from '../../consult/consult-expiry-core';

const seams = vi.hoisted(() => ({
  register: vi.fn(),
  sweep: vi.fn(async (_deps: ExpirySweepDeps) => undefined),
  send: vi.fn(async () => undefined),
  sweepParks: vi.fn(async (_args: unknown) => undefined),
  pollParks: vi.fn(async (_args: unknown) => undefined),
  makeSeams: vi.fn(() => ({})),
  sweepDeliveries: vi.fn(async (_args: unknown) => ({ checked: [], failures: [], saturated: false })),
}));
vi.mock('../../consult/park-delivery-prod', () => ({ sweepParkDeliveries: seams.sweepDeliveries }));
vi.mock('../../consult/park-adapters', () => ({
  sweepDueParks: seams.sweepParks,
  pollParkOwnerAnswers: seams.pollParks,
}));
vi.mock('../../consult/park-prod', () => ({
  makeProdParkSeams: seams.makeSeams,
  readParkOwnerAnswer: vi.fn(),
}));
vi.mock('./system-actions', () => ({ registerSystemAction: seams.register }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../consult/consult-expiry-core', async (original) => ({
  ...await original<typeof import('../../consult/consult-expiry-core')>(),
  sweepExpiredConsults: seams.sweep,
}));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: seams.send }));

describe('consult expiry production wiring', () => {
  it('registers an executable sweep with the durable requester-alert adapter bound', async () => {
    await import('./consult-expiry-action');
    const registration = seams.register.mock.calls.find(([name]) => name === 'consult-expiry-sweep');
    expect(registration).toBeDefined();
    await registration![1]();
    expect(seams.sweep).toHaveBeenCalledOnce();
    const deps = seams.sweep.mock.calls[0]![0];
    expect(deps.notifyRequester).toBeTypeOf('function');
    expect(deps.resumeCascadeDispatch).toBeTypeOf('function');
    // P-014: prod binds the review conversion leg; without it silent review
    // consults would keep cascading.
    expect(deps.fileReviewWorkItem).toBeTypeOf('function');
    // consult-backed-parking P-006: the same tick polls owner answers to open park
    // questions and resolves parks past their deadline, with per-workspace prod seams.
    expect(seams.pollParks).toHaveBeenCalledOnce();
    expect(seams.sweepParks).toHaveBeenCalledOnce();
    const parkArgs = seams.sweepParks.mock.calls[0]![0] as { seamsFor: (ws: string) => unknown };
    parkArgs.seamsFor('ws-1');
    expect(seams.makeSeams).toHaveBeenCalledWith(expect.anything(), 'ws-1');
    seams.send.mockImplementationOnce(async () => {
      expect(currentRequestWorkspaceId()).toBe('row-workspace');
    });
    await deps.notifyRequester({
      requesterId: 'requester', conversationId: 'conv-exact', workspaceId: 'row-workspace',
      msgId: 'stable-alert-key', summary: 'stalled', body: 'Recovery pending; inspect conv-exact.',
    });
    expect(seams.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'row-workspace' }),
      expect.objectContaining({ msgId: 'stable-alert-key', to: ['requester'] }),
    );
    // consult-backed-parking P-007: the same tick runs the verdict delivery check.
    expect(seams.sweepDeliveries).toHaveBeenCalledOnce();
    expect(seams.sweepDeliveries).toHaveBeenCalledWith(expect.objectContaining({ sql: expect.anything() }));
  });

  it('runs the delivery check even when the park deadline sweep throws, and survives its own failure', async () => {
    await import('./consult-expiry-action');
    const registration = seams.register.mock.calls.find(([name]) => name === 'consult-expiry-sweep');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      seams.sweepParks.mockRejectedValueOnce(new Error('park sweep down'));
      seams.sweepDeliveries.mockClear();
      await registration![1]();
      expect(seams.sweepDeliveries).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('park sweep failed: park sweep down'));

      seams.sweepDeliveries.mockRejectedValueOnce(new Error('delivery down'));
      await expect(registration![1]()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('park delivery sweep failed: delivery down'));
    } finally {
      warn.mockRestore();
    }
  });
});
