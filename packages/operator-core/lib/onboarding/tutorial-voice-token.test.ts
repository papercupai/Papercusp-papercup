import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
import type { Sql } from 'postgres';
import { createHostedPrincipal } from '../auth/hosted-principal';
import { createHostedTutorialVoiceTokenRoute, type TutorialVoiceTokenProvider } from '../endpoint-route/routes/hosted-tutorial-progress';
import { CLOUD_TUTORIAL_ID } from './cloud-tutorial-lesson';
vi.mock('./cloud-tutorial-progress', () => ({ readAccountTutorialProgress: vi.fn(), readTutorialProgress: vi.fn() }));
import { readAccountTutorialProgress, readTutorialProgress, type TutorialProgressRecord } from './cloud-tutorial-progress';

const origin = 'https://app.papercusp.com';
const expiresAt = Date.now() + 900_000;
const scope = { tenantId: 'org-a', userId: 'user-a' };
const body = { expectedScope: scope, context: { version: 3, step: 'welcome', status: 'ready' } };
const enrolled = { scope, version: 3 as const, revision: 0, mutationId: null,
  disposition: 'active' as const, currentLessonId: 'welcome', reviewedLessonIds: [] };
const principal = (patch: Partial<Parameters<typeof createHostedPrincipal>[0]> = {}) => createHostedPrincipal({
  workspaceId: 'control', userId: scope.userId, activeOrganizationId: scope.tenantId,
  sessionId: 'session', sessionVersion: 1, ...patch,
});
function setup(withProvider = true) {
  const disabled = vi.fn(async () => false);
  const issue = vi.fn<TutorialVoiceTokenProvider['issue']>(async () => ({ ok: true, connectionType: 'websocket',
    signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=single-use',
    sessionId: 'reservation', expiresAt, maximumSeconds: 60 }));
  const runTenant = vi.fn(async <T>(_context: unknown, callback: (tx: Sql) => Promise<T>) => callback({} as Sql));
  const route = createHostedTutorialVoiceTokenRoute({ origin, controlPlaneWorkspaceId: 'control',
    runTenant: (context, callback) => runTenant(context, callback) as ReturnType<typeof callback>, provider: withProvider ? { disabled, issue } : undefined });
  const call = (input: unknown = body, options: { principal?: ReturnType<typeof principal> | null; origin?: string;
    workspaceHeader?: string; signal?: AbortSignal } = {}) => {
    const request = new Request(origin + route.path, { method: 'POST', body: JSON.stringify(input), signal: options.signal,
      headers: { origin: options.origin ?? origin, 'content-type': 'application/json',
        ...(options.workspaceHeader ? { 'x-papercusp-workspace': options.workspaceHeader } : {}) } });
    const context: RouteContext = { principal: options.principal === null ? null : options.principal ?? principal(),
      params: {}, input: undefined, signal: request.signal, log: () => {} };
    return route.handler(request, context);
  };
  return { call, disabled, issue, runTenant };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readAccountTutorialProgress).mockResolvedValue(enrolled); });
describe('hosted tutorial conversation token boundary', () => {
  it('admits persisted account enrollment without workspace permission and emits only the token contract', async () => {
    const { call, issue, runTenant } = setup();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ connectionType: 'websocket',
      signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=single-use',
      sessionId: 'reservation', expiresAt, maximumSeconds: 60 });
    expect(issue).toHaveBeenCalledWith({ controlWorkspaceId: 'control', organizationId: scope.tenantId,
      userId: scope.userId, sessionId: 'session', sessionVersion: 1,
      customerWorkspaceId: null, lesson: body.context }, expect.any(AbortSignal));
    expect(runTenant.mock.calls[0][0]).not.toHaveProperty('selectedWorkspace');
  });
  it('refuses signed-out, wrong-origin, foreign control/scope/header requests before minting', async () => {
    const { call, issue, runTenant } = setup();
    expect((await call(body, { principal: null })).status).toBe(401);
    for (const options of [{ origin: 'https://evil.example' }, { workspaceHeader: 'foreign' },
      { principal: principal({ workspaceId: 'foreign' }) }, { principal: principal({ userId: 'foreign' }) },
      { principal: principal({ activeOrganizationId: 'foreign' }) }]) {
      expect((await call(body, options)).status).toBe(403);
    }
    expect(issue).not.toHaveBeenCalled(); expect(runTenant).not.toHaveBeenCalled();
  });
  it('keeps account enrollment independent of the selected workspace and carries only the verified session', async () => {
    const { call, issue } = setup();
    expect((await call(body, { principal: principal({ selectedWorkspaceId: 'workspace-a',
      sessionId: 'verified-session', sessionVersion: 7 }) })).status).toBe(200);
    expect(issue).toHaveBeenCalledWith({ controlWorkspaceId: 'control', organizationId: scope.tenantId,
      userId: scope.userId, sessionId: 'verified-session', sessionVersion: 7,
      customerWorkspaceId: null, lesson: body.context }, expect.any(AbortSignal));
    for (const patch of [{ sessionId: 'forged' }, { sessionVersion: 99 }]) {
      expect((await call({ ...body, ...patch })).status).toBe(400);
    }
    expect(issue).toHaveBeenCalledTimes(1);
  });
  it('refuses missing, paused, skipped, closed and changed lessons before minting', async () => {
    const { call, issue } = setup();
    for (const record of [null, ...(['paused', 'skipped', 'closed'] as const).map(disposition => ({ ...enrolled, disposition })),
      { ...enrolled, currentLessonId: 'billing' }]) {
      vi.mocked(readAccountTutorialProgress).mockResolvedValueOnce(record);
      expect((await call()).status).toBe(409);
    }
    expect(issue).not.toHaveBeenCalled();
  });
  it('rejects client session overrides and malformed context before providers', async () => {
    const { call, issue, disabled } = setup();
    for (const patch of [{ agentId: 'other' }, { maximumSeconds: 9999 }, { prompt: 'override' },
      { context: { ...body.context, transcript: 'private' } }]) expect((await call({ ...body, ...patch })).status).toBe(400);
    expect(issue).not.toHaveBeenCalled(); expect(disabled).not.toHaveBeenCalled();
  });
  it('refuses the kill switch both before and after the progress read', async () => {
    const { call, issue, disabled, runTenant } = setup();
    disabled.mockResolvedValueOnce(true);
    expect((await call()).status).toBe(503); expect(runTenant).not.toHaveBeenCalled();
    disabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect((await call()).status).toBe(503); expect(issue).not.toHaveBeenCalled();
  });
  it('returns bounded refusal codes for quotas, live sessions and unavailable issuers', async () => {
    const { call, issue } = setup();
    for (const [reason, status] of [['quota_exhausted', 429], ['session_active', 409], ['disabled', 503], ['unavailable', 503]] as const) {
      issue.mockResolvedValueOnce({ ok: false, reason });
      const response = await call(); expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: 'tutorial_voice_' + reason });
    }
    expect((await setup(false).call()).status).toBe(503);
    issue.mockRejectedValueOnce(new Error('private credential/store diagnostic'));
    expect(await (await call()).json()).toEqual({ ok: false, error: 'tutorial_voice_unavailable', message: 'tutorial_voice_unavailable' });
  });
  it('refuses cancellation before minting', async () => {
    const { call, issue } = setup(); const abort = new AbortController(); abort.abort();
    expect((await call(body, { signal: abort.signal })).status).toBe(408); expect(issue).not.toHaveBeenCalled();
  });
  it('refuses legacy WebRTC tokens and missing signed URLs without exposing provider diagnostics', async () => {
    const { call, issue } = setup();
    for (const result of [{ ok: true, token: 'private-token', apiKey: 'private-key' },
      { ok: true, connectionType: 'websocket', signedUrl: '' },
      { ok: true, connectionType: 'webrtc', signedUrl: 'private-url' }]) {
      issue.mockResolvedValueOnce(result as Awaited<ReturnType<TutorialVoiceTokenProvider['issue']>>);
      const response = await call();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'tutorial_voice_unavailable', message: 'tutorial_voice_unavailable' });
    }
  });
  it('allowlists the signed session receipt without exposing server credential or remote ledger fields', async () => {
    const { call, issue } = setup();
    const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=single-use';
    issue.mockResolvedValueOnce({ ok: true, connectionType: 'websocket', signedUrl,
      sessionId: 'reservation', expiresAt, maximumSeconds: 60, apiKey: 'private-key',
      providerConversationId: 'server-only', issuanceAttemptId: 'server-only' } as Awaited<ReturnType<TutorialVoiceTokenProvider['issue']>>);
    expect(await (await call()).json()).toEqual({ connectionType: 'websocket', signedUrl,
      sessionId: 'reservation', expiresAt, maximumSeconds: 60 });
  });
  it('refuses unsafe URLs and malformed or expired session receipts', async () => {
    const { call, issue } = setup();
    const valid = await issue({} as never, new AbortController().signal);
    issue.mockClear();
    for (const patch of [
      ...['not-a-url', 'https://api.elevenlabs.io/v1/convai/conversation?conversation_signature=x',
        'wss://evil.example/v1/convai/conversation?conversation_signature=x',
        'wss://api.elevenlabs.io/other?conversation_signature=x',
        'wss://secret@api.elevenlabs.io/v1/convai/conversation?conversation_signature=x',
        'wss://api.elevenlabs.io/v1/convai/conversation',
        'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=x#fragment']
        .map(signedUrl => ({ signedUrl })),
      { sessionId: '' }, { expiresAt: Date.now() - 1 }, { expiresAt: Infinity },
      { maximumSeconds: 0 }, { maximumSeconds: 7201 }, { maximumSeconds: 1.5 },
    ]) {
      issue.mockResolvedValueOnce({ ...valid, ...patch } as Awaited<ReturnType<TutorialVoiceTokenProvider['issue']>>);
      const response = await call();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: 'tutorial_voice_unavailable', message: 'tutorial_voice_unavailable' });
    }
  });
  it('requires selected authorized workspace and persisted legacy progress', async () => {
    const { call, issue } = setup();
    const legacyScope = { ...scope, workspaceId: 'workspace-a' };
    const legacy = { expectedScope: legacyScope, context: { version: 2, step: 'workspace', status: 'ready' } };
    expect((await call(legacy)).status).toBe(403);
    expect((await call(legacy, { principal: principal({ selectedWorkspaceId: 'workspace-a' }) })).status).toBe(403);
    const selected = principal({ selectedWorkspaceId: 'workspace-a', permissions: ['workspace:view'] });
    const record: TutorialProgressRecord = { revision: 1, mutationId: 'saved', progress: { scope: legacyScope,
      lessonId: CLOUD_TUTORIAL_ID, version: 2 as const, disposition: 'active' as const } };
    vi.mocked(readTutorialProgress).mockResolvedValueOnce({ ...record, revision: 0 });
    expect((await call(legacy, { principal: selected })).status).toBe(409);
    vi.mocked(readTutorialProgress).mockResolvedValueOnce(record);
    expect((await call(legacy, { principal: selected })).status).toBe(200);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(issue.mock.calls[0][0]).toMatchObject({ customerWorkspaceId: 'workspace-a', sessionId: 'session', sessionVersion: 1 });
  });
});
