import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  listTasks: vi.fn(async (_filter: unknown) => [] as unknown[]),
  listLiveTasks: vi.fn(async (_workspaceId: string) => [] as unknown[]),
  killTask: vi.fn(async (_taskId: string) => ({ ok: true })),
  getPresence: vi.fn(async (_ownerId: string) => ({ lastActiveAt: null as string | null })),
  resolveSessionStates: vi.fn(async () => new Map([['su-answerer', { sessionState: 'live' }]])),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});
vi.mock('../../consult/park-delivery-prod', () => ({ sweepParkDeliveries: seams.sweepDeliveries }));
vi.mock('../../consult/park-adapters', () => ({
  sweepDueParks: seams.sweepParks,
  pollParkOwnerAnswers: seams.pollParks,
}));
vi.mock('../../consult/park-prod', () => ({
  makeProdParkSeams: seams.makeSeams,
  readParkOwnerAnswer: vi.fn(),
}));
vi.mock('./system-actions', () => ({
  SYSTEM_TARGET_PREFIX: 'system:',
  registerSystemAction: seams.register,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../consult/consult-expiry-core', () => ({ sweepExpiredConsults: seams.sweep }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));
vi.mock('../../agent-tools/coordination/messages', () => ({ sendMessage: seams.send }));
vi.mock('../../task-manager/store', () => ({ listLiveTasks: seams.listLiveTasks, listTasks: seams.listTasks }));
vi.mock('../../task-manager/control', () => ({ killTask: seams.killTask }));
vi.mock('../../agent-tools/coordination/presence', () => ({ getPresence: seams.getPresence }));
vi.mock('../../agent-tools/coordination/liveness-oracle', () => ({ resolveSessionStates: seams.resolveSessionStates }));

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

  it('uses the real stat reader for an exact live answer task with a post-route log write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'consult-expiry-action-'));
    const logPath = join(directory, 'answer.log');
    try {
      writeFileSync(logPath, 'recent answer task activity\n');
      const logMtimeMs = statSync(logPath).mtimeMs;
      const routedAt = new Date(logMtimeMs - 31 * 60_000).toISOString();
      expect(logMtimeMs).toBeGreaterThan(Date.parse(routedAt));

      seams.listTasks.mockClear();
      seams.listTasks.mockResolvedValue([{
        taskId: 'task-exact-answer',
        workspaceId: 'row-workspace',
        class: 'agent-session',
        state: 'running',
        startedAt: routedAt,
        endedAt: null,
        logPath,
        detail: {
          consultAnswer: {
            conversationId: 'conv-exact-answer',
            sourceOwnerId: 'su-source',
            answeringOwnerId: 'su-answerer',
          },
        },
      }]);
      seams.getPresence.mockClear();
      seams.resolveSessionStates.mockClear();
      seams.sweep.mockClear();
      const statReader = vi.mocked(statSync);
      statReader.mockClear();

      await import('./consult-expiry-action');
      const registration = seams.register.mock.calls.find(([name]) => name === 'consult-expiry-sweep');
      expect(registration).toBeDefined();
      await registration![1]();

      const deps = seams.sweep.mock.calls.at(-1)![0];
      expect(deps.findSilentResponders).toBeTypeOf('function');
      const found = await deps.findSilentResponders!([{
        workspaceId: 'row-workspace',
        conversationId: 'conv-exact-answer',
        sourceOwnerId: 'su-source',
        answeringOwnerId: 'su-answerer',
        requesterId: 'su-requester',
        routedAt,
      }]);

      expect(statReader).toHaveBeenCalledWith(logPath);
      expect(found).toEqual(new Set());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
