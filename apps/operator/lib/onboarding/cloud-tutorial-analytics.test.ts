import { describe, expect, it, vi } from 'vitest';
import { createTutorialAnalytics } from './cloud-tutorial-analytics';
import { createTutorialState, tutorialReducer, type ProductObservation } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
const scope = { tenantId: 'private-tenant', userId: 'private-user', workspaceId: 'private-workspace' };
const observation: ProductObservation = { scope, revision: 1, access: 'allowed',
  connection: { id: 'private-connection', provider: 'gcp', validated: true },
  configuration: { connectionId: 'private-connection', valid: true, costReviewed: true },
  workspace: { id: scope.workspaceId, connectionId: 'private-connection', healthy: true },
  agent: { id: 'private-agent', workspaceId: scope.workspaceId, launchedByUser: true, available: true },
  task: { id: 'private-task', sessionId: 'private-agent', sampleTask: true, submittedByUser: true, status: 'succeeded', resultId: 'private-result' } };
describe('tutorial measurement follows confirmed state', () => {
  it('records the beginner version while dropping private diagnostics and transcript content at the telemetry sink', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture);
    const privateObservation = { ...observation, transcript: 'private transcript', providerError: 'private provider diagnostic',
      attempt: { step: 'practice' as const, status: 'failed' as const, rawError: 'private token' } };
    analytics.update(tutorialReducer(createTutorialState(scope, undefined, 2), { type: 'observe', observation: privateObservation }));
    const serialized = JSON.stringify(capture.mock.calls);
    for (const value of [...Object.values(scope), 'private transcript', 'private provider diagnostic', 'private token', 'private-agent', 'private-task']) expect(serialized).not.toContain(value);
    for (const [, properties] of capture.mock.calls) {
      expect(properties.lesson_version).toBe(2);
      expect(Object.keys(properties).every(key => ['lesson_id', 'lesson_version', 'action', 'step', 'status'].includes(key))).toBe(true);
    }
  });
  it('deduplicates repeated renders and never records click intent as success', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture);
    let state = createTutorialState(scope); analytics.update(state); analytics.update(state);
    for (const action of ['check-again', 'help', 'replay'] as const) { state = tutorialReducer(state, { type: 'action', action }); analytics.update(state); }
    expect(capture.mock.calls.map(([, p]) => p.action)).toEqual(['start', 'step_displayed']);
  });
  it('reports confirmed steps and waits for correlated result inspection before completion', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture);
    let state = createTutorialState(scope); analytics.update(state);
    state = tutorialReducer(state, { type: 'observe', observation }); analytics.update(state); analytics.update(state);
    expect(capture.mock.calls.filter(([, p]) => p.action === 'step_confirmed').map(([, p]) => p.step)).toEqual(['connection', 'configuration', 'workspace', 'agent', 'task']);
    expect(capture.mock.calls.some(([, p]) => p.action === 'complete')).toBe(false);
    state = tutorialReducer(state, { type: 'inspect-result', scope, sessionId: 'private-agent', taskId: 'private-task', resultId: 'private-result' });
    analytics.update(state); analytics.update(state);
    expect(capture.mock.calls.filter(([, p]) => p.action === 'complete')).toHaveLength(1);
    expect(capture.mock.calls.filter(([, p]) => p.step === 'result' && p.action === 'step_confirmed')).toHaveLength(1);
  });
  it('records waiting and recovery after a confirmed connection, without duplicating waiting', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture);
    let state = tutorialReducer(createTutorialState(scope), { type: 'observe', observation: { scope, revision: 1, access: 'allowed', attempt: { step: 'connection', status: 'failed' } } });
    analytics.update(state); analytics.update(state);
    state = tutorialReducer(state, { type: 'observe', observation: { scope, revision: 2, access: 'allowed', connection: observation.connection } }); analytics.update(state);
    expect(capture.mock.calls.filter(([, p]) => p.action === 'waiting')).toHaveLength(1);
    expect(capture.mock.calls).toContainEqual(['cloud_tutorial', { lesson_id: 'first-cloud-agent', lesson_version: 1, action: 'recovery', step: 'connection', status: 'ready' }]);
  });
  it('tracks pause/resume/skip/exit, replay and checks through enum-only metadata', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture); let state = createTutorialState(scope); analytics.update(state);
    for (const action of ['pause', 'resume', 'skip', 'exit'] as const) { state = tutorialReducer(state, { type: 'action', action }); analytics.update(state); }
    analytics.action('replay', 'connection'); analytics.action('check_again', 'workspace');
    expect(capture.mock.calls.map(([, p]) => p.action)).toEqual(['start', 'step_displayed', 'pause', 'resume', 'step_displayed', 'skip', 'exit', 'replay', 'check_again']);
  });
  it('resets its cursor on scope changes and never includes private identifiers or payloads', () => {
    const capture = vi.fn(); const analytics = createTutorialAnalytics(capture);
    analytics.update(tutorialReducer(createTutorialState(scope), { type: 'observe', observation }));
    const foreign = { ...scope, workspaceId: 'another-private-workspace' }; analytics.update(createTutorialState(foreign));
    const serialized = JSON.stringify(capture.mock.calls);
    for (const secret of [...Object.values(scope), 'private-connection', 'private-agent', 'private-task', 'private-result', foreign.workspaceId]) expect(serialized).not.toContain(secret);
    expect(capture.mock.calls.filter(([, p]) => p.action === 'start')).toHaveLength(2);
    for (const [, p] of capture.mock.calls) expect(Object.keys(p).every(key => ['lesson_id', 'lesson_version', 'action', 'step', 'status'].includes(key))).toBe(true);
  });
  it.each([() => { throw new Error('offline'); }, () => Promise.reject(new Error('offline'))])('keeps confirmed progression usable when capture fails', async capture => {
    const analytics = createTutorialAnalytics(capture); const state = tutorialReducer(createTutorialState(scope), { type: 'observe', observation });
    expect(() => analytics.update(state)).not.toThrow(); await Promise.resolve();
    expect(state.observation?.task?.status).toBe('succeeded');
  });
});
