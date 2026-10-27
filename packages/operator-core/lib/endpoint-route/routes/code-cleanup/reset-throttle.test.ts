/**
 * POST /api/code-cleanup/reset-throttle — the owner's door to reset a tripped cleanup campaign
 * (code-cleanup-campaigns-2026-10-26 P-008 R-9, P-009; D-013, D-016). The real reset logic runs;
 * only the runner work-item store is replaced by an in-memory one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignThrottleStore } from '../../../code-cleanup/campaign-runner';
import type { CampaignThrottleState } from '../../../code-cleanup/throttle';

vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-active' }));
vi.mock('../../../code-cleanup/campaign-native', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../code-cleanup/campaign-native')>();
  return { ...original, workItemThrottleStore: vi.fn() };
});

import { workItemThrottleStore } from '../../../code-cleanup/campaign-native';
import routes, { resetThrottleSchema } from './reset-throttle';

const [route] = routes;
const TRIPPED: CampaignThrottleState = {
  throttled: true, review: 'required', reviewBeforeTrip: 'off',
  trippedAt: new Date('2026-10-27T08:00:00.000Z'), resetAt: null, resetBy: null,
};
const INPUT = { campaignId: 'papercusp-1', runnerItemId: 'WI-RUN', harness: 'papercusp' };

let state: CampaignThrottleState;
let saves: CampaignThrottleState[];
let failLoad: Error | null;
function memoryStore(): CampaignThrottleStore {
  return {
    async load() { if (failLoad) throw failLoad; return state; },
    async save(_campaign, next) { saves.push(next); state = next; },
  };
}

async function call(input: Record<string, unknown>, slug: string | null = 'avi') {
  const res = (await route!.handler(new Request('http://127.0.0.1/api/code-cleanup/reset-throttle'),
    { input, principal: slug ? { slug } : null } as never)) as Response;
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state = TRIPPED; saves = []; failLoad = null;
  vi.mocked(workItemThrottleStore).mockReset().mockImplementation(() => memoryStore());
});

describe('/api/code-cleanup/reset-throttle', () => {
  it('is one loopback POST door, and there is no MCP verb beside it', () => {
    expect(routes.map(r => [r.method, r.path, r.auth])).toEqual([['POST', '/code-cleanup/reset-throttle', 'loopback']]);
    expect(resetThrottleSchema.safeParse({ ...INPUT, principal: 'admin:x' }).success).toBe(false);
    expect(resetThrottleSchema.safeParse({ campaignId: 'c', runnerItemId: '', harness: 'h' }).success).toBe(false);
  });

  it('resets as admin:<principal slug>, scoped to the runner item in the active workspace', async () => {
    const { status, body } = await call(INPUT);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, op: 'reset-throttle', campaignId: 'papercusp-1', runnerItemId: 'WI-RUN',
      state: { throttled: false, review: 'off', resetBy: 'admin:avi' } });
    expect(saves).toHaveLength(1);
    expect(vi.mocked(workItemThrottleStore)).toHaveBeenCalledWith(
      { workspaceId: 'ws-active', harness: 'papercusp', runnerItemId: 'WI-RUN', defaultReview: expect.any(String) });
  });

  it('stamps admin:operator when the loopback caller carries no principal slug', async () => {
    const { body } = await call(INPUT, null);
    expect(body).toMatchObject({ ok: true, state: { resetBy: 'admin:operator' } });
  });

  it('answers 409 not-throttled for a campaign that is not throttled, and saves nothing', async () => {
    state = { ...TRIPPED, throttled: false, trippedAt: null };
    const { status, body } = await call({ ...INPUT, workspaceId: 'ws-b' });
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, op: 'reset-throttle', code: 'not-throttled' });
    expect(saves).toEqual([]);
    expect(vi.mocked(workItemThrottleStore).mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-b' });
  });

  it('maps a missing runner item to 404, another campaign to 409, and anything else to 500', async () => {
    failLoad = new Error('runner work-item WI-RUN not found');
    expect(await call(INPUT)).toMatchObject({ status: 404, body: { ok: false, code: 'invalid' } });
    failLoad = new Error('runner work-item WI-RUN runs campaign other, not papercusp-1');
    expect(await call(INPUT)).toMatchObject({ status: 409, body: { ok: false, code: 'invalid' } });
    failLoad = new Error('connection reset');
    expect(await call(INPUT)).toMatchObject({ status: 500, body: { ok: false, code: 'unavailable' } });
    expect(saves).toEqual([]);
  });
});
