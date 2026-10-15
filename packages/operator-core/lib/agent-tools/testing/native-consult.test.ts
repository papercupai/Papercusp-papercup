import { describe, expect, it, vi } from 'vitest';
import { acceptNativeConsultScenario, type NativeConsultScenario } from './native-consult';
import type { acceptFeedbackRequestProd } from '../../consult/get-feedback-prod';

const scenario: NativeConsultScenario = { sourceBackend: 'claude', sourceState: 'ended', targetBackend: 'codex',
  request_key: 'native-key', question: 'Can the native source answer?', tried: 'Read the dispatch path',
  observed: 'Exact source failed', decision_at_stake: 'Which native conversion is supported' };
const input = { scenario, identity: { ownerId: 'owner-requester' } as never,
  workspaceId: 'workspace-native', harnessSlug: 'papercusp', workItemId: 'WI-native' };

describe('native consult durable acceptance', () => {
  it('preserves the nonempty source-plan-lease predicate in durable acceptance', async () => {
    const accept = vi.fn(async () => ({ state: 'routing', pending: true })) as unknown as typeof acceptFeedbackRequestProd;
    await acceptNativeConsultScenario({ ...input, scenario: { ...scenario, requireSourcePlanClaims: true } },
      { accept, readHeldWorkItems: async () => [{ id: 'WI-native' }] as never });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      nativeConsult: expect.objectContaining({ requireSourcePlanClaims: true }),
    }), input.identity, { harnessSlug: 'papercusp', allowDispatch: true });
  });
  it('does not launch against an unheld or unreadable work-item', async () => {
    const accept = vi.fn();
    expect(await acceptNativeConsultScenario(input, { accept, readHeldWorkItems: async () => [] }))
      .toMatchObject({ ok: false, error: 'work_item_not_held' });
    await expect(acceptNativeConsultScenario(input, { accept,
      readHeldWorkItems: async () => { throw new Error('claim reader unavailable'); } })).rejects.toThrow('claim reader unavailable');
    expect(accept).not.toHaveBeenCalled();
  });
  it('persists actual attribution and native constraints without reporting acceptance as a passing native test', async () => {
    const accept = vi.fn(async () => ({ state: 'routing', pending: true, conversation_id: 'native-conv' })) as unknown as typeof acceptFeedbackRequestProd;
    const result = await acceptNativeConsultScenario(input, { accept,
      readHeldWorkItems: async () => [{ id: 'WI-native' }] as never });
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ requesterId: 'owner-requester',
      workspaceId: 'workspace-native', originTaskRef: 'WI-native', requestKey: 'native-key',
      nativeConsult: { sourceBackend: 'claude', targetBackend: 'codex', sourceState: 'ended' }, archiveFloor: 2 }),
      input.identity, { harnessSlug: 'papercusp', allowDispatch: true });
    expect(result).toMatchObject({ ok: true, accepted: { pending: true }, workItemId: 'WI-native' });
    expect(result).not.toHaveProperty('passed');
    expect(result).not.toHaveProperty('testRunIds');
  });
});
