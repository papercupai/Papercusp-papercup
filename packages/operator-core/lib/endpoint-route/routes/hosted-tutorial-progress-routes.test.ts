import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { RouteContext } from '@papercusp/tooldef';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { AccountTutorialProgressRecord } from '../../onboarding/cloud-tutorial-progress';
import { createHostedPrincipal } from '../../auth/hosted-principal';

const h = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn(), consent: vi.fn() }));
vi.mock('../../onboarding/cloud-tutorial-progress', async importOriginal => ({
  ...await importOriginal<typeof import('../../onboarding/cloud-tutorial-progress')>(),
  readAccountTutorialProgress: h.read, updateAccountTutorialProgress: h.update,
}));
vi.mock('../../cloud-telemetry', async importOriginal => ({
  ...await importOriginal<typeof import('../../cloud-telemetry')>(), readCloudTelemetryConsent: h.consent,
}));
vi.mock('../../build-info', () => ({ getBuildInfo: () => ({ sha: 'abcdef1234567' }) }));
import { createHostedTutorialProgressRoutes } from './hosted-tutorial-progress-routes';

const origin = 'https://app.papercusp.com';
const principal = createHostedPrincipal({ workspaceId: 'control', userId: 'user-a', activeOrganizationId: 'tenant-a',
  sessionId: 'session-a', sessionVersion: 1, permissions: [] });
const previous: AccountTutorialProgressRecord = { scope: { tenantId: 'tenant-a', userId: 'user-a' }, version: 3,
  revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] };
const patch = { expectedScope: previous.scope, expectedRevision: 0, mutationId: 'saved-mutation', version: 3,
  disposition: 'active', currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] };
const record = { ...previous, revision: 1, mutationId: patch.mutationId, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] };
const context = { principal, params: {}, input: undefined, signal: new AbortController().signal, log: () => {} } as RouteContext;
const request = (body: unknown = patch) => new Request(origin + '/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3',
  { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function fixture() {
  const tx = (() => []) as unknown as Sql;
  const runTenant = async <T>(tenant: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>): Promise<T> => {
    expect(tenant.principal).toMatchObject({ activeOrganizationId: 'tenant-a', userId: 'user-a' }); return fn(tx);
  };
  const deliver = vi.fn<typeof import('../../cloud-telemetry-posthog')['deliverCloudPosthog']>(async () => ({ delivered: true }));
  const routes = createHostedTutorialProgressRoutes({ origin, controlPlaneWorkspaceId: 'control', runTenant, deliver });
  return { post: routes[1].handler, get: routes[0].handler, deliver, runTenant };
}
beforeEach(() => { vi.clearAllMocks(); h.read.mockResolvedValue(previous); h.update.mockResolvedValue(record); });

describe('saved public-guide analytics witness', () => {
  it('observes a committed explanation review with fresh scoped consent, without exposing private scope', async () => {
    const f = fixture(); const response = await f.post(request(), context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ record });
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const [event, runtime, readConsent] = f.deliver.mock.calls[0]!;
    expect(event).toMatchObject({ event: 'product_tutorial', properties: {
      lesson_id: 'product-guide', lesson_version: 3, action: 'explanation_reviewed', lesson: 'welcome' } });
    expect(runtime).toMatchObject({ principal, origin: 'control-plane' });
    expect(JSON.stringify(event)).not.toMatch(/user-a|tenant-a|saved-mutation|task_succeeded/);
    await readConsent(); expect(h.consent).toHaveBeenCalledWith(expect.anything(), principal);
  });
  it('never emits reviews for reads, idempotent saves, scope forgery or failed writes', async () => {
    const f = fixture();
    expect((await f.get(new Request(origin + '/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3'), context)).status).toBe(200);
    h.read.mockResolvedValue(record);
    expect((await f.post(request(), context)).status).toBe(200);
    expect((await f.post(request({ ...patch, expectedScope: { ...patch.expectedScope, tenantId: 'other' } }), context)).status).toBe(403);
    h.read.mockResolvedValue(previous); h.update.mockRejectedValue(new Error('write unavailable'));
    expect((await f.post(request(), context)).status).toBe(503); expect(f.deliver).not.toHaveBeenCalled();
  });
  it('keeps a saved choice successful while the analytics sink stalls or rejects', async () => {
    const f = fixture(); f.deliver.mockImplementationOnce(() => new Promise(() => {}));
    expect((await f.post(request(), context)).status).toBe(200);
    f.deliver.mockRejectedValueOnce(new Error('sink unavailable'));
    expect((await f.post(request(), context)).status).toBe(200);
    await Promise.resolve();
  });
});
