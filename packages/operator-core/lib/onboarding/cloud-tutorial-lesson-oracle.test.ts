import { expect, it } from 'vitest';
import type * as Lesson from './cloud-tutorial-lesson';

// The maintained mutation runner supplies a frozen copy of the production
// subject. The identical behavioral oracle runs against current and mutant.
const lesson: typeof Lesson = await import(process.env.CLOUD_TUTORIAL_LESSON_PROBE ?? './cloud-tutorial-lesson');
it('a failed or pending authorized domain task cannot complete the lesson task step', () => {
  const scope = { tenantId: 'tenant', userId: 'user', workspaceId: 'customer-workspace' };
  for (const status of ['pending', 'failed'] as const) {
    const state = lesson.tutorialReducer(lesson.createTutorialState(scope), { type: 'observe', observation: {
      scope, revision: 1, access: 'allowed',
      connection: { id: 'connection', provider: 'gcp', validated: true },
      configuration: { connectionId: 'connection', valid: true, costReviewed: true },
      workspace: { id: 'host', connectionId: 'connection', healthy: true },
      agent: { id: 'session', workspaceId: 'host', launchedByUser: true, available: true },
      task: { id: 'task', sessionId: 'session', sampleTask: true, submittedByUser: true, status, resultId: 'provisional-result' },
    } });
    expect(lesson.currentTutorialStep(state)?.id, 'A pending or failed domain operation was treated as success').toBe('task');
    expect(lesson.confirmedTutorialSteps(state)).not.toContain('task');
  }
});
