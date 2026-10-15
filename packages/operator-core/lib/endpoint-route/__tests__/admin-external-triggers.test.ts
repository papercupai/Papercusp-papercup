import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const flagEnabled = vi.fn(async () => true);
const loadSnapshot = vi.fn(async (_sql: unknown, _workspace: string) => ({
  enabled: true,
  counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
  sources: [],
  bindings: [],
  recentRuns: [],
}));
const loadPlanSnapshot = vi.fn(async (_sql: unknown, _workspace: string, harness: string, plan: string) => ({
  harnessSlug: harness,
  planSlug: plan,
  schedule: { kind: 'cron', cron: '0 9 * * 1-5' },
  scheduleActive: false,
  scheduledAt: null,
  expiresAt: null,
  tzid: 'America/New_York',
  lastFire: null,
  nextFire: null,
  manualSource: 'input-schema',
}));
const createBinding = vi.fn(async (_sql: unknown, _workspace: string, input: Record<string, unknown>) => ({
  id: BINDING_ID,
  ...input,
  sourceKind: 'gmail',
  action: { type: 'launch-plan' },
  armed: false,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const detachBinding = vi.fn(async (_sql: unknown, _workspace: string, id: string) => ({
  id,
  detachedAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
}));
const setArmed = vi.fn(async (_sql: unknown, _workspace: string, id: string, armed: boolean) => ({
  id,
  armed,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const setStorm = vi.fn(async (_sql: unknown, _workspace: string, id: string, input: unknown) => ({
  id,
  stormPolicy: input,
  updatedAt: '2026-08-22T00:00:00.000Z',
}));
const notify = vi.fn(async (..._args: unknown[]) => {});
const sql = vi.fn();

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system',
    slug: 'system:operator',
    workspaceId: 'ws-test',
    authMethod: 'superuser-bearer',
    trust: 'trusted',
    capabilities: new Set(['*']),
    label: 'su',
  })),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    constructor(
      public status: number,
      public reason: string,
    ) {
      super(reason);
    }
  },
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: () => flagEnabled() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222' })),
}));
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: (...args: Parameters<typeof notify>) => notify(...args),
}));
vi.mock('../../external-triggers/admin', () => ({
  createExternalTriggerBinding: (...args: Parameters<typeof createBinding>) => createBinding(...args),
  detachExternalTriggerBinding: (...args: Parameters<typeof detachBinding>) => detachBinding(...args),
  disabledExternalTriggerAdminSnapshot: () => ({
    enabled: false,
    counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 },
    sources: [],
    bindings: [],
    recentRuns: [],
  }),
  loadExternalTriggerAdminSnapshot: (...args: Parameters<typeof loadSnapshot>) => loadSnapshot(...args),
  loadExternalTriggerPlanAdminSnapshot: (...args: Parameters<typeof loadPlanSnapshot>) => loadPlanSnapshot(...args),
  setExternalTriggerBindingArmed: (...args: Parameters<typeof setArmed>) => setArmed(...args),
  updateExternalTriggerBindingStormPolicy: (...args: Parameters<typeof setStorm>) => setStorm(...args),
}));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { registerRoute } from '../define-route';
import { requirePrincipal, PrincipalCheckError } from '../../auth/require-principal';
import type { RouteDefinition } from '../define-route';
import type { ZodTypeAny } from 'zod';
import routes from '../routes/admin/external-triggers';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;
const [read, mutate] = routes as unknown as AnyRoute[];
const URL = 'http://127.0.0.1:3070/admin/triggers';
const BINDING_ID = '10000000-0000-4000-8000-000000000001';

async function request(route: AnyRoute, method: 'GET' | 'PATCH' | 'POST', body?: unknown, headers: Record<string, string> = {}, query = '') {
  const app = new Hono();
  registerRoute(app, route);
  return app.request(`http://127.0.0.1:3070${route.path}${query}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  flagEnabled.mockResolvedValue(true);
  sql.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe('external-trigger admin route pair', () => {
  it('keeps the owner-local routes under their explicit trust gate and serves no provider-specific route', () => {
    expect(read).toMatchObject({ method: 'GET', path: '/admin/triggers' });
    expect(mutate).toMatchObject({ method: 'PATCH', path: '/admin/triggers' });
    expect(read.auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
    expect(mutate.auth).toEqual(read.auth);
    // Slack setup moved into the slack package (cupboard-distributable-integrations D-025/D-026).
    expect(routes.map((r) => (r as unknown as AnyRoute).path)).toEqual(['/admin/triggers', '/admin/triggers']);
  });

  it('returns the shared snapshot and the default-ON flag fails open on provider errors', async () => {
    flagEnabled.mockRejectedValueOnce(new Error('flag provider offline'));
    const response = await request(read, 'GET');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true });
    expect(loadSnapshot).toHaveBeenCalledWith(sql, 'ws-test');
  });

  it('refuses an unauthorized administrator read before loading source diagnostics', async () => {
    vi.mocked(requirePrincipal).mockRejectedValueOnce(new PrincipalCheckError(403, 'trust_required'));
    const response = await request(read, 'GET');
    expect(response.status).toBe(403);
    expect(loadSnapshot).not.toHaveBeenCalled();
    expect(flagEnabled).not.toHaveBeenCalled();
  });

  it('folds the named plan schedule/manual snapshot into the shared trigger read', async () => {
    const response = await request(
      read,
      'GET',
      undefined,
      {},
      '?planSlug=triage-mail&planHarnessSlug=papercusp',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      plan: {
        planSlug: 'triage-mail',
        schedule: { kind: 'cron' },
        manualSource: 'input-schema',
      },
    });
    expect(loadPlanSnapshot).toHaveBeenCalledWith(sql, 'ws-test', 'papercusp', 'triage-mail');
  });

  it('returns the disabled shape without reading data when the flag is explicitly off', async () => {
    flagEnabled.mockResolvedValueOnce(false);
    const response = await request(read, 'GET');
    expect(await response.json()).toMatchObject({ enabled: false, bindings: [] });
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it('refuses cross-origin writes before flag or data access', async () => {
    const response = await request(
      mutate,
      'PATCH',
      { op: 'set-armed', id: BINDING_ID, armed: true, confirm: true },
      { origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
    expect(flagEnabled).not.toHaveBeenCalled();
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('requires explicit owner confirmation for both arming directions', async () => {
    for (const armed of [true, false]) {
      const response = await request(mutate, 'PATCH', { op: 'set-armed', id: BINDING_ID, armed });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'owner_confirmation_required',
        gate: { category: 'schedule-arm', authority: 'owner', reversible: true },
      });
    }
    expect(setArmed).not.toHaveBeenCalled();
  });

  it('applies a confirmed arm and invalidates the shared admin snapshot', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-armed',
      id: BINDING_ID,
      armed: true,
      confirm: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, binding: { id: BINDING_ID, armed: true } });
    expect(setArmed).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, true);
    expect(notify).toHaveBeenCalledWith('externalTriggers.admin', { workspaceId: 'ws-test' });
  });

  it('installs an external binding disarmed and invalidates the plan facet', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      eventPattern: 'ext:gmail:message.received',
      eventFilter: { label: 'support' },
      maxRuns: 2,
      windowSeconds: 60,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({
      planSlug: 'triage-mail',
      createdBy: 'owner:22222222-2222-4222-8222-222222222222',
    }));
    expect(notify).toHaveBeenCalledWith('plans.list', undefined);
  });

  it('accepts a goal target and forwards it without inventing plan columns', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      goalId: 'goal-support-triage',
      eventPattern: 'ext:gmail:message.received',
      eventFilter: { label: 'support' },
    });
    expect(response.status).toBe(200);
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({ goalId: 'goal-support-triage' }));
    const goalInput = createBinding.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(goalInput).not.toHaveProperty('planSlug');
    expect(goalInput).not.toHaveProperty('planHarnessSlug');
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
  });

  it('accepts the Gmail direct Email work-item target', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      workItemHarnessSlug: 'email',
      workItemKind: 'email-draft-proposal',
      eventPattern: 'ext:gmail:message.received',
    });
    expect(response.status).toBe(200);
    expect(createBinding).toHaveBeenCalledWith(sql, 'ws-test', expect.objectContaining({
      workItemHarnessSlug: 'email',
      workItemKind: 'email-draft-proposal',
    }));
    expect(await response.json()).toMatchObject({ ok: true, binding: { armed: false } });
  });

  it('rejects an attach payload that mixes target families at the HTTP boundary', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      goalId: 'goal-support-triage',
      eventPattern: 'ext:gmail:message.received',
    });
    expect(response.status).toBe(400);
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('requires confirmation, then soft-detaches without deleting history', async () => {
    const refused = await request(mutate, 'PATCH', { op: 'detach-external', id: BINDING_ID });
    expect(refused.status).toBe(409);
    expect(detachBinding).not.toHaveBeenCalled();

    const response = await request(mutate, 'PATCH', {
      op: 'detach-external', id: BINDING_ID, confirm: true,
    });
    expect(response.status).toBe(200);
    expect(detachBinding).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID);
    expect(notify).toHaveBeenCalledWith('plans.list', undefined);
  });

  it('validates and applies the canonical storm-policy fields', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
    });
    expect(response.status).toBe(200);
    expect(setStorm).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, { maxRuns: 3, windowSeconds: 120 });
  });

  // WI-10004920: the dispatch validity window is settable from the admin surface,
  // on both doors, and bounded at the boundary by the engine's 31-day ceiling.
  it('forwards a stated dispatch validity window on set-storm-policy', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 3600,
    });
    expect(response.status).toBe(200);
    expect(setStorm).toHaveBeenCalledWith(sql, 'ws-test', BINDING_ID, {
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 3600,
    });
  });

  it('forwards a window-only policy on attach-external without inventing rate fields', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'attach-external',
      sourceId: '20000000-0000-4000-8000-000000000001',
      planHarnessSlug: 'papercusp',
      planSlug: 'triage-mail',
      eventPattern: 'ext:gmail:message.received',
      maxAgeSeconds: 7200,
    });
    expect(response.status).toBe(200);
    const input = createBinding.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(input.stormPolicy).toEqual({ maxAgeSeconds: 7200 });
  });

  it('refuses a validity window past the 31-day ceiling at the HTTP boundary', async () => {
    const response = await request(mutate, 'PATCH', {
      op: 'set-storm-policy',
      id: BINDING_ID,
      maxRuns: 3,
      windowSeconds: 120,
      maxAgeSeconds: 32 * 24 * 60 * 60,
    });
    expect(response.status).toBe(400);
    expect(setStorm).not.toHaveBeenCalled();
  });

  it('no longer accepts the retired Slack-specific configure-slack-bugs op', async () => {
    // Slack bug triage is the Cupboard bug-triage trigger pack
    // (cupboard-distributable-integrations-2026-10-10#D-019).
    const response = await request(mutate, 'PATCH', { op: 'configure-slack-bugs',
      sourceId: '20000000-0000-4000-8000-000000000001', channels: ['C1'],
      asanaBugDestination: { sourceId: '20000000-0000-4000-8000-000000000003', projectGid: '123' } });
    expect(response.status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
    expect(setArmed).not.toHaveBeenCalled();
  });
});
