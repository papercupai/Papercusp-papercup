import { describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { createHostedTutorialAssistanceRoutes, HOSTED_BROWSER_TUTORIAL_HELP_PATH, HOSTED_BROWSER_TUTORIAL_SPEECH_PATH } from '../endpoint-route/routes/hosted-tutorial-progress';
import { createTutorialState, confirmedTutorialSteps } from './cloud-tutorial-lesson';
import type { TutorialAssistanceRequest } from './cloud-tutorial-help';
vi.mock('./cloud-tutorial-progress', () => ({ readAccountTutorialProgress: vi.fn() }));
import { readAccountTutorialProgress, type AccountTutorialProgressRecord } from './cloud-tutorial-progress';
const NEVER_EMIT_MARKER = 'never-emit-me';
const origin = 'https://app.papercusp.com';
const scope = { tenantId: 'tenant-a', userId: 'user-a', workspaceId: 'customer-a' };
const input = { expectedScope: scope, context: { step: 'connection', status: 'ready' }, question: 'Where do I connect my project?' };
const principal = (patch: Partial<Parameters<typeof createHostedPrincipal>[0]> = {}) => createHostedPrincipal({
  workspaceId: 'control', userId: scope.userId, activeOrganizationId: scope.tenantId, selectedWorkspaceId: scope.workspaceId,
  sessionId: 'session', sessionVersion: 1, permissions: ['workspace:view'], ...patch,
});
function setup(withProviders = true) {
  const answer = vi.fn(async (_input: TutorialAssistanceRequest, _signal: AbortSignal, _workspaceId: string) => 'Use the app connection form. The app validates your project.');
  const speech = vi.fn(async (_text: string, _engine: string, _voice: string | undefined, _signal?: AbortSignal) => ({ audio: new ArrayBuffer(16), contentType: 'audio/wav' }));
  const runTenant = vi.fn(async <T>(_context: unknown, callback: (tx: Sql) => Promise<T>) => callback({} as Sql));
  // Vitest's spy return type erases a generic call signature. Preserve the
  // tenant runner's callback/result relationship at the route boundary.
  const routes = createHostedTutorialAssistanceRoutes({ origin, controlPlaneWorkspaceId: 'control',
    runTenant: <T>(context: VerifiedTenantServerContext, callback: (tx: Sql) => Promise<T>) => runTenant(context, callback) as Promise<T>,
    dependencies: withProviders ? { answer, speech } : {} });
  const call = (body: unknown = input, options: { path?: string; origin?: string; principal?: ReturnType<typeof principal> | null; signal?: AbortSignal } = {}) => {
    const route = routes.find(row => row.path === (options.path ?? HOSTED_BROWSER_TUTORIAL_HELP_PATH))!;
    const request = new Request(`${origin}/api${route.path}`, { method: 'POST', headers: { origin: options.origin ?? origin, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: options.signal });
    const context: RouteContext = { principal: options.principal === null ? null : options.principal ?? principal(), params: {}, input: undefined, signal: request.signal, log: () => {} };
    return route.handler(request, context);
  };
  return { call, answer, speech, runTenant };
}
describe('hosted lesson assistance boundary', () => {
  it('fails closed when a host has not configured an execution provider', async () => {
    const { call, answer, speech } = setup(false);
    for (const body of [input, { ...input, engine: 'openai' }]) {
      const response = await call(body, { path: 'engine' in body ? HOSTED_BROWSER_TUTORIAL_SPEECH_PATH : HOSTED_BROWSER_TUTORIAL_HELP_PATH });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('checks the account-owned current lesson before AI Help without granting workspace authority', async () => {
    const { call, answer, speech, runTenant } = setup();
    const accountInput = { expectedScope: { tenantId: scope.tenantId, userId: scope.userId },
      context: { version: 3, step: 'billing', status: 'ready' }, question: 'Who bills cloud resources?' };
    const unselected = principal({ selectedWorkspaceId: undefined, permissions: [] });
    vi.mocked(readAccountTutorialProgress).mockResolvedValue({ currentLessonId: 'billing', disposition: 'active' } as AccountTutorialProgressRecord);
    expect((await call(accountInput, { principal: unselected })).status).toBe(200);
    expect(answer.mock.calls[0][0]).toEqual(accountInput);
    expect(runTenant.mock.calls[0][0]).toMatchObject({ principal: { userId: scope.userId, activeOrganizationId: scope.tenantId } });
    expect(runTenant.mock.calls[0][0]).not.toHaveProperty('selectedWorkspace');
    answer.mockClear();
    expect((await call(accountInput, { principal: principal({ userId: 'foreign', selectedWorkspaceId: undefined }) })).status).toBe(403);
    expect((await call({ ...accountInput, context: { ...accountInput.context, transcript: 'private' } }, { principal: unselected })).status).toBe(400);
    expect((await call(input, { principal: unselected })).status).toBe(403);
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
    for (const saved of [null, { currentLessonId: 'account', disposition: 'active' } as AccountTutorialProgressRecord, { currentLessonId: 'billing', disposition: 'closed' } as AccountTutorialProgressRecord]) {
      vi.mocked(readAccountTutorialProgress).mockResolvedValue(saved);
      expect((await call(accountInput, { principal: unselected })).status).toBe(409);
    }
    expect(answer).not.toHaveBeenCalled();
  });
  it('speaks the persisted account lesson without workspace selection and refuses foreign, obsolete or secret input before synthesis', async () => {
    const { call, answer, speech } = setup();
    const accountInput = { expectedScope: { tenantId: scope.tenantId, userId: scope.userId },
      context: { version: 3, step: 'billing', status: 'ready' }, question: 'Your cloud provider bills cloud resources.', engine: 'kokoro' };
    const unselected = principal({ selectedWorkspaceId: undefined, permissions: [] });
    vi.mocked(readAccountTutorialProgress).mockResolvedValue({ currentLessonId: 'billing', disposition: 'active' } as AccountTutorialProgressRecord);
    const response = await call(accountInput, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, principal: unselected });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(speech).toHaveBeenCalledWith(accountInput.question, 'kokoro', undefined, expect.any(AbortSignal));
    expect(answer).not.toHaveBeenCalled(); speech.mockClear();
    for (const body of [
      { ...accountInput, expectedScope: { ...accountInput.expectedScope, userId: 'foreign' } },
      { ...accountInput, question: `api_key=${NEVER_EMIT_MARKER}` },
      { ...accountInput, context: { ...accountInput.context, transcript: 'private workspace content' } },
    ]) expect((await call(body, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, principal: unselected })).status).toBeGreaterThanOrEqual(400);
    for (const saved of [null, { currentLessonId: 'account', disposition: 'active' } as AccountTutorialProgressRecord, { currentLessonId: 'billing', disposition: 'closed' } as AccountTutorialProgressRecord]) {
      vi.mocked(readAccountTutorialProgress).mockResolvedValue(saved);
      expect((await call(accountInput, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, principal: unselected })).status).toBe(409);
    }
    expect(speech).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
  });
  it('keeps account progress-store failures private and never invokes assistance providers', async () => {
    const { call, answer, speech, runTenant } = setup();
    const accountInput = { expectedScope: { tenantId: scope.tenantId, userId: scope.userId },
      context: { version: 3, step: 'billing', status: 'ready' }, question: 'Who bills cloud resources?' };
    const unselected = principal({ selectedWorkspaceId: undefined, permissions: [] });
    for (const failureSource of [vi.mocked(readAccountTutorialProgress), runTenant]) {
      failureSource.mockRejectedValueOnce(new Error('private progress store diagnostic'));
      const response = await call(accountInput, { principal: unselected });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ok: false, error: 'tutorial_help_unavailable', message: 'tutorial_help_unavailable' });
    }
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('accepts v2 public recovery and blocks private category/diagnostic input before both providers', async () => {
    const { call, answer, speech } = setup();
    const context = { step: 'practice', status: 'error', version: 2, recoveryCategory: 'unknown' };
    expect((await call({ ...input, context })).status).toBe(200);
    expect(answer.mock.calls[0][0].context).toEqual(context);
    answer.mockClear();
    for (const extra of [{ recoveryCategory: 'private-provider-id' }, { rawError: 'private token' }, { transcript: 'private chat' }]) {
      expect((await call({ ...input, context: { ...context, ...extra } })).status).toBe(400);
      expect((await call({ ...input, context: { ...context, ...extra }, engine: 'openai' }, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH })).status).toBe(400);
    }
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('passes only authorized minimal context to existing brain and leaves domain state untouched', async () => {
    const { call, answer } = setup(); const state = createTutorialState(scope);
    const response = await call();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(answer.mock.calls[0][0]).toEqual(input);
    expect(await response.json()).toEqual({ answer: 'Use the app connection form. The app validates your project.' });
    expect(confirmedTutorialSteps(state)).toEqual([]);
  });
  it.each([{ principal: null }, { principal: principal({ selectedWorkspaceId: 'foreign' }) }, { principal: principal({ userId: 'foreign' }) }, { principal: principal({ activeOrganizationId: 'foreign' }) }, { principal: principal({ permissions: [] }) }, { origin: 'https://evil.invalid' }])('refuses forbidden boundary %j before providers', async options => {
    const { call, answer, speech } = setup();
    expect((await call(input, options)).status).toBeGreaterThanOrEqual(400);
    expect(answer).not.toHaveBeenCalled(); expect(speech).not.toHaveBeenCalled();
  });
  it('refuses credentials and expanded state before provider invocation', async () => {
    const { call, answer } = setup();
    expect((await call({ ...input, question: `api_key=${NEVER_EMIT_MARKER}` })).status).toBe(403);
    expect((await call({ ...input, context: { ...input.context, transcript: 'another tenant' } })).status).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });
  it('returns a recoverable outage and suppresses cancelled model results', async () => {
    const { call, answer } = setup(); answer.mockRejectedValueOnce(new Error('provider private error'));
    expect(await (await call()).json()).toMatchObject({ error: 'tutorial_help_unavailable' });
    const controller = new AbortController(); controller.abort();
    expect((await call(input, { signal: controller.signal })).status).toBe(408);
  });
  it('uses the shared synthesis adapter with the selected engine and voice', async () => {
    const { call, speech, answer } = setup();
    const response = await call({ ...input, engine: 'openai', voiceId: 'nova' }, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(speech).toHaveBeenCalledWith(input.question, 'openai', 'nova', expect.any(AbortSignal)); expect(answer).not.toHaveBeenCalled();
  });
  it('propagates cancellation into synthesis and never returns late audio', async () => {
    const { call, speech } = setup();
    let finish!: (result: { audio: ArrayBuffer; contentType: string }) => void;
    speech.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const pending = call({ ...input, engine: 'kokoro' }, { path: HOSTED_BROWSER_TUTORIAL_SPEECH_PATH, signal: controller.signal });
    await vi.waitFor(() => expect(speech).toHaveBeenCalledOnce());
    const forwarded = speech.mock.calls[0][3]!;
    expect(forwarded.aborted).toBe(false);
    controller.abort();
    expect(forwarded.aborted).toBe(true);
    finish({ audio: new ArrayBuffer(16), contentType: 'audio/wav' });
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: 'tutorial_speech_cancelled' });
  });
});
