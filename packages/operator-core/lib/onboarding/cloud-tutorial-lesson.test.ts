import { describe, expect, it } from 'vitest';
import { CLOUD_TUTORIAL_STEPS, CLOUD_TUTORIAL_VERSION, confirmedTutorialSteps, createTutorialState, currentTutorialStep, tutorialProgress, tutorialReducer, tutorialStepStatus, type ProductObservation, type TutorialScope } from './cloud-tutorial-lesson';

describe('versioned beginner independent work', () => {
  const beginnerObservation = () => evidence({ connection: undefined,
    workspace: { id: scope.workspaceId, connectionId: 'connection-a', healthy: true },
    agent: { id: 'session-a', workspaceId: scope.workspaceId, launchedByUser: true, available: true },
    revisionTask: { id: 'revision-a', sessionId: 'session-a', firstTaskId: 'task-a', sampleTask: true, submittedByUser: true, status: 'succeeded', resultId: 'revision-answer' },
    practiceTask: { id: 'practice-a', sessionId: 'session-a', firstTaskId: 'task-a', sampleTask: false, submittedByUser: true, status: 'succeeded', resultId: 'practice-answer' } });
  const start = () => tutorialReducer(createTutorialState(scope, undefined, 2), { type: 'observe', observation: beginnerObservation() });
  const inspect = (state: ReturnType<typeof start>, kind: 'first' | 'revision' | 'practice') => tutorialReducer(state, { type: 'inspect-result', kind, scope,
    sessionId: 'session-a', taskId: { first: 'task-a', revision: 'revision-a', practice: 'practice-a' }[kind], resultId: { first: 'answer-a', revision: 'revision-answer', practice: 'practice-answer' }[kind] });
  it('requires ordered review of the exact first, revised and self-written answers without provider setup', () => {
    let state = start();
    expect(confirmedTutorialSteps(state)).toEqual(['configuration', 'workspace', 'agent', 'task']);
    expect(inspect(state, 'revision')).toBe(state);
    expect(inspect(state, 'practice')).toBe(state);
    state = inspect(state, 'first'); expect(currentTutorialStep(state)?.id).toBe('revision');
    state = inspect(state, 'revision'); expect(currentTutorialStep(state)?.id).toBe('practice');
    state = inspect(state, 'practice'); expect(tutorialStepStatus(state)).toBe('complete');
    const saved = tutorialProgress(state);
    expect(saved.version).toBe(2);
    expect(saved.inspectedRevision?.taskId).toBe('revision-a');
    expect(saved.inspectedPractice?.taskId).toBe('practice-a');
    expect(confirmedTutorialSteps(createTutorialState(scope, saved, 2))).toEqual([]);
    expect(createTutorialState(scope, { ...saved, disposition: 'paused' }, 1).disposition).toBe('active');
  });
  it.each(['pending', 'failed', 'foreign-session', 'old-first', 'canned', 'same-request'] as const)('rejects %s independent practice', failure => {
    let state = inspect(inspect(start(), 'first'), 'revision');
    const o = beginnerObservation();
    const task = { ...o.practiceTask! };
    if (failure === 'pending' || failure === 'failed') task.status = failure;
    if (failure === 'foreign-session') task.sessionId = 'other';
    if (failure === 'old-first') task.firstTaskId = 'old-first';
    if (failure === 'canned') task.sampleTask = true;
    if (failure === 'same-request') task.id = 'revision-a';
    state = tutorialReducer(state, { type: 'observe', observation: { ...o, revision: 2, practiceTask: task } });
    state = inspect(state, 'practice');
    expect(currentTutorialStep(state)?.id).toBe('practice');
  });
  it('rejects another authorized scope and invalidates downstream reviews after a new first task', () => {
    let state = inspect(inspect(inspect(start(), 'first'), 'revision'), 'practice');
    state = tutorialReducer(state, { type: 'observe', observation: { ...beginnerObservation(), revision: 2, task: { ...beginnerObservation().task!, id: 'new-first' } } });
    expect(confirmedTutorialSteps(state)).toEqual(['configuration', 'workspace', 'agent', 'task']);
    const wrongWorkspace = tutorialReducer(createTutorialState(scope, undefined, 2), { type: 'observe', observation: evidence() });
    expect(confirmedTutorialSteps(wrongWorkspace)).toEqual(['configuration']);
  });
});

const scope: TutorialScope = { tenantId: 'tenant-a', userId: 'user-a', workspaceId: 'customer-workspace-a' };
function evidence(patch: Partial<ProductObservation> = {}): ProductObservation {
  return { scope, revision: 1, access: 'allowed',
    connection: { id: 'connection-a', provider: 'gcp', validated: true },
    configuration: { connectionId: 'connection-a', valid: true, costReviewed: true },
    workspace: { id: 'host-a', connectionId: 'connection-a', healthy: true },
    agent: { id: 'session-a', workspaceId: 'host-a', launchedByUser: true, available: true },
    task: { id: 'task-a', sessionId: 'session-a', sampleTask: true, submittedByUser: true, status: 'succeeded', resultId: 'answer-a' }, ...patch };
}
const observe = (o: ProductObservation) => tutorialReducer(createTutorialState(scope), { type: 'observe', observation: o });
describe('Cloud tutorial confirmed domain progression', () => {
  it('starts loading, accepts precompleted state, and requires inspection of the correlated result', () => {
    expect(tutorialStepStatus(createTutorialState(scope))).toBe('loading');
    const state = observe(evidence());
    expect(confirmedTutorialSteps(state)).toEqual(['connection', 'configuration', 'workspace', 'agent', 'task']);
    expect(currentTutorialStep(state)?.id).toBe('result');
    const complete = tutorialReducer(state, { type: 'inspect-result', scope, sessionId: 'session-a', taskId: 'task-a', resultId: 'answer-a' });
    expect(tutorialStepStatus(complete)).toBe('complete');
    expect(confirmedTutorialSteps(complete)).toHaveLength(CLOUD_TUTORIAL_STEPS.length);
  });
  it('never accepts clicking, highlight readiness, retry or help as completion', () => {
    let state = observe(evidence({ connection: undefined }));
    state = tutorialReducer(state, { type: 'target', scope, step: 'connection', status: 'ready' });
    for (const action of ['show-target', 'check-again', 'help'] as const) state = tutorialReducer(state, { type: 'action', action });
    expect(confirmedTutorialSteps(state)).toEqual([]);
    expect(currentTutorialStep(state)?.id).toBe('connection');
    expect(Object.keys(state)).not.toContain('effects');
  });
  it.each([
    ['unvalidated connection', { connection: { id: 'connection-a', provider: 'gcp', validated: false } }, 'connection'],
    ['unreviewed cost', { configuration: { connectionId: 'connection-a', valid: true, costReviewed: false } }, 'configuration'],
    ['invalid configuration', { configuration: { connectionId: 'connection-a', valid: false, costReviewed: true } }, 'configuration'],
    ['different connection', { configuration: { connectionId: 'foreign', valid: true, costReviewed: true } }, 'configuration'],
    ['unhealthy workspace', { workspace: { id: 'host-a', connectionId: 'connection-a', healthy: false } }, 'workspace'],
    ['foreign workspace connection', { workspace: { id: 'host-a', connectionId: 'foreign', healthy: true } }, 'workspace'],
    ['foreign session workspace', { agent: { id: 'session-a', workspaceId: 'foreign', launchedByUser: true, available: true } }, 'agent'],
    ['automatic agent launch', { agent: { id: 'session-a', workspaceId: 'host-a', launchedByUser: false, available: true } }, 'agent'],
    ['foreign session task', { task: { id: 'task-a', sessionId: 'foreign', sampleTask: true, submittedByUser: true, status: 'succeeded', resultId: 'answer-a' } }, 'task'],
    ['unrelated task', { task: { id: 'task-a', sessionId: 'session-a', sampleTask: false, submittedByUser: true, status: 'succeeded', resultId: 'answer-a' } }, 'task'],
    ['automatically submitted task', { task: { id: 'task-a', sessionId: 'session-a', sampleTask: true, submittedByUser: false, status: 'succeeded', resultId: 'answer-a' } }, 'task'],
    ['no actual result', { task: { id: 'task-a', sessionId: 'session-a', sampleTask: true, submittedByUser: true, status: 'succeeded' } }, 'task'],
  ] satisfies [string, Partial<ProductObservation>, string][] )('stops at %s', (_case, patch, expected) => {
    expect(currentTutorialStep(observe(evidence(patch)))?.id).toBe(expected);
  });
  it.each(['pending', 'failed'] as const)('does not complete a %s task', status => {
    const state = observe(evidence({ task: { ...evidence().task!, status } }));
    expect(currentTutorialStep(state)?.id).toBe('task');
    expect(tutorialStepStatus(state)).toBe(status === 'pending' ? 'waiting' : 'error');
  });
  it.each(['tenantId', 'userId', 'workspaceId'] as const)('rejects a different %s', key => {
    const initial = createTutorialState(scope);
    expect(tutorialReducer(initial, { type: 'observe', observation: evidence({ scope: { ...scope, [key]: 'other' } }) })).toBe(initial);
  });
  it('rejects stale, duplicate and invalid generations, including late completion after scope changes', () => {
    const current = observe(evidence({ revision: 3, connection: undefined }));
    for (const revision of [2, 3, -1, NaN, 1.5]) expect(tutorialReducer(current, { type: 'observe', observation: evidence({ revision }) })).toBe(current);
    const switched = tutorialReducer(current, { type: 'change-scope', scope: { ...scope, workspaceId: 'other' } });
    expect(tutorialReducer(switched, { type: 'observe', observation: evidence({ revision: 4 }) })).toBe(switched);
    expect(confirmedTutorialSteps(switched)).toEqual([]);
  });
  it('permission refusal blocks even an otherwise complete snapshot', () => {
    const state = observe(evidence({ access: 'denied' }));
    expect(confirmedTutorialSteps(state)).toEqual([]);
    expect(tutorialStepStatus(state)).toBe('blocked');
  });
  it.each(['pending', 'failed', 'delayed'] as const)('supports %s recovery without repeating a product operation', status => {
    const state = observe(evidence({ connection: undefined, attempt: { step: 'connection', status } }));
    expect(tutorialStepStatus(state)).toBe(status === 'pending' ? 'waiting' : status === 'failed' ? 'error' : 'delayed');
    expect(currentTutorialStep(state)?.recovery).toMatch(/validation/);
    expect(tutorialReducer(state, { type: 'action', action: 'check-again' })).toBe(state);
    const recovered = tutorialReducer(state, { type: 'observe', observation: evidence({ revision: 2 }) });
    expect(currentTutorialStep(recovered)?.id).toBe('result');
  });
  it('ignores attempt/target statuses for another step and recovers a missing target', () => {
    let state = observe(evidence({ connection: undefined, attempt: { step: 'workspace', status: 'failed' } }));
    expect(tutorialStepStatus(state)).toBe('ready');
    expect(tutorialReducer(state, { type: 'target', scope, step: 'workspace', status: 'missing' })).toBe(state);
    state = tutorialReducer(state, { type: 'target', scope, step: 'connection', status: 'missing' });
    expect(tutorialStepStatus(state)).toBe('missing-target');
    state = tutorialReducer(state, { type: 'target', scope, step: 'connection', status: 'ready' });
    expect(tutorialStepStatus(state)).toBe('ready');
  });
  it.each(['pause', 'skip', 'exit'] as const)('%s preserves evidence; resume/replay reconcile current domain state', action => {
    const state = observe(evidence());
    const stopped = tutorialReducer(state, { type: 'action', action });
    expect(stopped.observation).toBe(state.observation);
    expect(stopped.disposition).toBe({ pause: 'paused', skip: 'skipped', exit: 'closed' }[action]);
    for (const resume of ['resume', 'replay'] as const) {
      const resumed = tutorialReducer(stopped, { type: 'action', action: resume });
      expect(resumed.disposition).toBe('active');
      expect(currentTutorialStep(resumed)?.id).toBe('result');
    }
  });
  it('saved progress does not assert domain completion and reconciles against current state on refresh', () => {
    const original = tutorialReducer(observe(evidence()), { type: 'inspect-result', scope, sessionId: 'session-a', taskId: 'task-a', resultId: 'answer-a' });
    const saved = tutorialProgress(original);
    const restored = createTutorialState(scope, saved);
    expect(confirmedTutorialSteps(restored)).toEqual([]);
    expect(currentTutorialStep(restored)?.id).toBe('connection');
    const reconciled = tutorialReducer(restored, { type: 'observe', observation: evidence() });
    expect(tutorialStepStatus(reconciled)).toBe('complete');
    expect(tutorialStepStatus(tutorialReducer(reconciled, { type: 'observe', observation: evidence({ revision: 2, task: { ...evidence().task!, id: 'new-task', resultId: 'new-result' } }) }))).toBe('ready');
  });
  it('a version or scope change discards old UI receipts and dispositions', () => {
    const saved = tutorialProgress(tutorialReducer(observe(evidence()), { type: 'action', action: 'skip' }));
    expect(createTutorialState(scope, { ...saved, version: CLOUD_TUTORIAL_VERSION + 1 }).disposition).toBe('active');
    expect(createTutorialState({ ...scope, userId: 'other' }, saved).disposition).toBe('active');
  });
  it.each(['sessionId', 'taskId', 'resultId'] as const)('does not accept inspection of another %s', key => {
    const state = observe(evidence());
    const event = { type: 'inspect-result' as const, scope, sessionId: 'session-a', taskId: 'task-a', resultId: 'answer-a', [key]: 'foreign' };
    expect(tutorialReducer(state, event)).toBe(state);
  });
});
