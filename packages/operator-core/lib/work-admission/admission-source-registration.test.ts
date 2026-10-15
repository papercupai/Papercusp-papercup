import { afterEach, expect, it, vi } from 'vitest';

const builtInKinds = ['record', 'chat-message', 'chat-thread'] as const;

afterEach(async () => {
  vi.resetModules();
  const { unregisterAdmissionSourceForTest } = await import('./admission-sources');
  for (const kind of builtInKinds) unregisterAdmissionSourceForTest(kind);
  vi.resetModules();
});

it('reuses process-wide built-in resolvers when source modules are re-evaluated', async () => {
  vi.resetModules();
  const firstRecordModule = await import('./record-source');
  const firstChatModule = await import('../data-sources/chat-admission-sources');

  vi.resetModules();
  const secondRecordModule = await import('./record-source');
  const secondChatModule = await import('../data-sources/chat-admission-sources');

  expect(secondRecordModule.recordAdmissionSource).toBe(firstRecordModule.recordAdmissionSource);
  expect(secondChatModule.chatMessageAdmissionSource).toBe(firstChatModule.chatMessageAdmissionSource);
  expect(secondChatModule.chatThreadAdmissionSource).toBe(firstChatModule.chatThreadAdmissionSource);
});
