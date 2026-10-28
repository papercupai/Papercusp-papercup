import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  identity: vi.fn(),
  harness: vi.fn(),
  bind: vi.fn(),
  request: vi.fn(),
}));

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: io.identity }));
vi.mock('../_harness-scope', () => ({ resolveConcreteHarnessSlug: io.harness }));
vi.mock('../../work-item-admission-authority', async importOriginal => ({
  ...await importOriginal<typeof import('../../work-item-admission-authority')>(),
  bindAdmissionAuthority: io.bind,
}));
vi.mock('../../work-item-admission-review', () => ({ requestAdmissionReview: io.request }));

import { AdmissionAuthorityRefused } from '../../work-item-admission-authority';
import reviewAdmission from './review-admission';

const args = { id: 'EI-review-target', harness: 'papercup', purpose: 'admission-review' as const };
const context = { workspaceId: 'ws-review', uiClientId: 'su-reviewer' };

async function call() {
  const output = await reviewAdmission.handler(reviewAdmission.args.parse(args), context as never) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(output.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  io.identity.mockReturnValue({ ownerId: 'su-reviewer', workspaceId: 'ws-review' });
  io.harness.mockReturnValue('papercup');
  io.bind.mockReturnValue({ kind: 'superuser' });
  io.request.mockResolvedValue({
    requestId: 'request-1', purpose: 'admission-review', queued: true, pickupConfirmed: false,
  });
});

describe('work_items:review-admission handler refusals', () => {
  it('returns a structured refusal when the subject is ineligible', async () => {
    io.request.mockRejectedValue(new AdmissionAuthorityRefused('subject has a live dependency'));

    await expect(call()).resolves.toMatchObject({
      ok: false,
      error: 'admission_review_refused',
      reason: 'subject has a live dependency',
      workItemId: args.id,
      responsibleActor: 'su-reviewer',
      pickupConfirmed: false,
      nextAction: expect.stringContaining('retry this same item'),
    });
  });

  it('returns a structured refusal when authority binding rejects before the request', async () => {
    io.bind.mockImplementation(() => { throw new AdmissionAuthorityRefused('renewable authentication required'); });

    await expect(call()).resolves.toMatchObject({
      ok: false,
      error: 'admission_review_refused',
      reason: 'renewable authentication required',
      workItemId: args.id,
      pickupConfirmed: false,
    });
    expect(io.request).not.toHaveBeenCalled();
  });

  it('preserves successful review request results', async () => {
    await expect(call()).resolves.toEqual({
      requestId: 'request-1', purpose: 'admission-review', queued: true, pickupConfirmed: false,
    });
    expect(io.request).toHaveBeenCalledWith({
      workspaceId: 'ws-review', harnessSlug: 'papercup', workItemId: args.id,
    }, { caller: 'su-reviewer', authority: { kind: 'superuser' }, requestId: undefined });
  });

  it('does not disguise unexpected infrastructure errors as policy refusals', async () => {
    io.request.mockRejectedValue(new Error('database unavailable'));
    await expect(call()).rejects.toThrow('database unavailable');
  });
});
