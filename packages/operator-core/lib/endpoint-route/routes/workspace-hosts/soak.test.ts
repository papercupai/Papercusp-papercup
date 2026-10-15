import { beforeEach, expect, it, vi } from 'vitest';
import type { RouteContext } from '../../define-route';

const IMAGE = 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918';

const h = vi.hoisted(() => {
  class WorkspaceHostSoakConflictError extends Error {}
  class WorkspaceHostReleaseBindingError extends Error {
    constructor(readonly reason: string, message: string) {
      super(message);
    }
  }
  return {
    WorkspaceHostSoakConflictError,
    WorkspaceHostReleaseBindingError,
    forward: vi.fn(async (): Promise<Response | null> => null),
    available: vi.fn(() => true),
    start: vi.fn(async (input: { soakId: string; hostId: string }) => ({
      status: 'accepted',
      soakId: input.soakId,
      workflowId: `workspace-host-soak:ws-1:${input.hostId}:${input.soakId}`,
      hostId: input.hostId,
    })),
    reading: vi.fn(async (): Promise<unknown> => ({
      kind: 'observed',
      status: 'RUNNING',
      instanceId: '1100961087771032429',
      sourceImage: 'projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20260918',
    })),
    bind: vi.fn(async () => ({ taskId: 'task-1', operationId: 'op-1', bundleSha256: 'a'.repeat(64), sourceSha: 'b', gitlinks: {}, version: 'v' })),
    writable: vi.fn(async () => undefined),
    runtimeRelease: vi.fn(async () => ({ bundleSha256: 'a'.repeat(64) })),
    latest: vi.fn(async (): Promise<string | null> => 'soak-1'),
    readSoak: vi.fn(),
  };
});
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../../../dbos/bootstrap', () => ({ dbosStarted: h.available }));
vi.mock('../../../workspace-host/controller-forwarding', () => ({ defaultWorkspaceHostRequestForwarder: h.forward }));
vi.mock('../../../dbos/workspace-host-soak-workflow', () => ({
  startWorkspaceHostSoakWorkflow: h.start,
  WorkspaceHostSoakConflictError: h.WorkspaceHostSoakConflictError,
}));
vi.mock('../../../workspace-host/soak-seams', () => ({
  resolveWorkspaceHostSoakSeams: async () => ({ readInstance: h.reading }),
}));
vi.mock('../../../workspace-host/release-stage-receipt', () => ({
  resolveWorkspaceHostReleaseBinding: h.bind,
  WorkspaceHostReleaseBindingError: h.WorkspaceHostReleaseBindingError,
}));
vi.mock('../../../workspace-host/soak-receipt', () => ({
  assertWorkspaceHostSoakReceiptWritable: h.writable,
}));
vi.mock('../../../workspace-host/soak-store', () => ({
  readWorkspaceHostRuntimeRelease: h.runtimeRelease,
  readLatestWorkspaceHostSoakId: h.latest,
  readWorkspaceHostSoak: h.readSoak,
}));

import routes from './soak';
import { resolveWorkspaceHostSoakPolicy } from '../../../workspace-host/soak';

const [start, status] = routes;
const ctx: RouteContext = { principal: null, input: undefined, params: { hostId: 'host-1' }, log: () => {}, signal: new AbortController().signal };
const post = (body: unknown) =>
  new Request('http://127.0.0.1/workspace-hosts/host-1/soak', { method: 'POST', body: JSON.stringify(body) });
const get = (query = '') => new Request(`http://127.0.0.1/workspace-hosts/host-1/soak${query}`);
beforeEach(() => vi.clearAllMocks());

it('starts a 24h soak bound to the release task and returns where to read its verdict', async () => {
  const response = await start!.handler(post({ operationId: 'soak-1', releaseTaskId: 'task-1' }), ctx);
  expect(response.status).toBe(202);
  expect(h.writable).toHaveBeenCalledTimes(1);
  expect(h.start).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'ws-1', hostId: 'host-1', soakId: 'soak-1', releaseBinding: expect.objectContaining({ taskId: 'task-1' }) }),
  );
  expect(await response.json()).toMatchObject({
    ok: true,
    soakId: 'soak-1',
    releaseTaskId: 'task-1',
    statusUrl: '/api/workspace-hosts/host-1/soak?soakId=soak-1',
  });
});

it('forwards with a pre-chosen soak id on a request-only host, starting nothing locally', async () => {
  h.forward.mockResolvedValueOnce(Response.json({ status: 'accepted' }, { status: 202 }));
  expect((await start!.handler(post({ intervalSec: 120 }), ctx)).status).toBe(202);
  expect(h.forward).toHaveBeenCalledWith(
    '/api/workspace-hosts/host-1/soak',
    expect.objectContaining({ intervalSec: 120, operationId: expect.any(String) }),
  );
  expect(h.start).not.toHaveBeenCalled();
});

it.each([{ script: 'id' }, { durationSec: -5 }, { intervalSec: 1.5 }, { releaseTaskId: '../x' }, []])(
  'refuses an invalid request: %j',
  async (body) => {
    expect((await start!.handler(post(body), ctx)).status).toBe(400);
    expect(h.start).not.toHaveBeenCalled();
    expect(h.forward).not.toHaveBeenCalled();
  },
);

it('refuses to write the acceptance stage from a shorter smoke soak', async () => {
  const response = await start!.handler(post({ durationSec: 600, intervalSec: 60, releaseTaskId: 'task-1' }), ctx);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: expect.stringMatching(/a soak shorter than 3600s cannot record acceptance\.soak$/),
  });
  expect(h.bind).not.toHaveBeenCalled();
});

it('allows a short smoke soak with no release binding', async () => {
  const response = await start!.handler(post({ durationSec: 600, intervalSec: 60 }), ctx);
  expect(response.status).toBe(202);
  expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ releaseBinding: null }));
});

it('refuses a host that is not RUNNING before enqueueing anything', async () => {
  h.reading.mockResolvedValueOnce({ kind: 'observed', status: 'TERMINATED', instanceId: '1', sourceImage: IMAGE });
  const response = await start!.handler(post({}), ctx);
  expect(response.status).toBe(409);
  expect(h.start).not.toHaveBeenCalled();
});

it('maps a bundle mismatch to 409 with its reason', async () => {
  h.bind.mockRejectedValueOnce(new h.WorkspaceHostReleaseBindingError('bundle-mismatch', 'host runs other bytes'));
  const response = await start!.handler(post({ releaseTaskId: 'task-1' }), ctx);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ reason: 'bundle-mismatch' });
});

it('maps a soak already running on the host to 409', async () => {
  h.start.mockRejectedValueOnce(new h.WorkspaceHostSoakConflictError('busy'));
  expect((await start!.handler(post({}), ctx)).status).toBe(409);
});

it('reports status from persisted samples, flagging a sampler that went quiet as stalled', async () => {
  const policy = resolveWorkspaceHostSoakPolicy();
  const observedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  h.readSoak.mockResolvedValueOnce({
    soakId: 'soak-1',
    envelope: { policy, releaseTaskId: 'task-1' },
    malformedRows: 0,
    samples: [
      {
        schemaVersion: 1,
        soakId: 'soak-1',
        sequence: 0,
        observedAt,
        pinned: { instanceId: '1', image: IMAGE },
        checks: [
          { name: 'compute-running', ok: true },
          { name: 'incarnation-stable', ok: true },
          { name: 'image-stable', ok: true },
          { name: 'controller-reach', ok: true },
        ],
      },
    ],
  });
  const response = await status!.handler(get(), ctx);
  expect(response.status).toBe(200);
  expect(h.latest).toHaveBeenCalledWith('ws-1', 'host-1');
  expect(await response.json()).toMatchObject({
    soakId: 'soak-1',
    releaseTaskId: 'task-1',
    stalled: true,
    evaluation: { verdict: 'running', samples: 1 },
  });
});

it('answers 404 for a host that was never soaked', async () => {
  h.latest.mockResolvedValueOnce(null);
  expect((await status!.handler(get(), ctx)).status).toBe(404);
});
