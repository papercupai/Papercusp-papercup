import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TutorialAssistanceDependencies } from './hosted-tutorial-progress';

const providers = vi.hoisted(() => ({
  guarded: vi.fn(() => []),
  dispatch: vi.fn(),
  lookup: vi.fn(() => ({ name: 'operator:converse' })),
  unavailable: vi.fn(() => false),
  synthesize: vi.fn(),
  preferences: vi.fn(async () => ({})),
}));
vi.mock('./hosted-tutorial-progress', () => ({ createHostedTutorialAssistanceRoutes: providers.guarded }));
vi.mock('../../agent-tools/operator/converse', () => ({}));
vi.mock('@papercusp/agent-mcp', () => ({ dispatchProjectedTool: providers.dispatch, lookupByMcpName: providers.lookup }));
vi.mock('../../voice-release-availability', () => ({ isHostedTtsEngineUnavailable: providers.unavailable }));
vi.mock('./agent-mcp/tts-synth', () => ({ synthesize: providers.synthesize }));
vi.mock('../../voice-prefs', () => ({ loadVoicePrefs: providers.preferences }));

import { createHostedTutorialAssistanceRoutes } from './hosted-tutorial-assistance-runtime';

const input = { expectedScope: { tenantId: 'private-tenant', userId: 'private-user' },
  context: { version: 3 as const, step: 'billing' as const, status: 'ready' as const },
  question: 'Who bills cloud usage?' };

function composition(): TutorialAssistanceDependencies {
  createHostedTutorialAssistanceRoutes({ origin: 'https://app.papercusp.com', controlPlaneWorkspaceId: 'control' });
  return (providers.guarded.mock.calls[0] as unknown as [{ dependencies: TutorialAssistanceDependencies }])[0].dependencies;
}

beforeEach(() => {
  vi.clearAllMocks();
  providers.unavailable.mockReturnValue(false);
  providers.dispatch.mockResolvedValue({ ok: true, result: { content: [{ type: 'text',
    text: JSON.stringify({ assembled: 'Your provider bills infrastructure.', privateTrace: 'hidden' }) }] } });
});

describe('native hosted tutorial provider composition', () => {
  it('executes the existing public brain adapter without account or conversation authority', async () => {
    const dependencies = composition();
    await expect(dependencies.answer!(input, new AbortController().signal, 'control'))
      .resolves.toBe('Your provider bills infrastructure.');
    const [, name, args, context] = providers.dispatch.mock.calls[0];
    expect(name).toBe('operator:converse');
    expect(args).toEqual({ messages: [{ role: 'user', content: input.question }], trigger: 'user_message',
      modality: 'text', hostTrust: 'public', lessonContext: input.context, sessionUser: null });
    expect(context).toMatchObject({ workspaceId: 'control', role: 'operator', transport: 'in_process', uiClientId: null });
    expect(JSON.stringify(args)).not.toContain('private-tenant');
    expect(JSON.stringify(args)).not.toContain('private-user');
  });

  it('bounds the completed answer and refuses tool failures or empty results', async () => {
    const dependencies = composition();
    providers.dispatch.mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text',
      text: JSON.stringify({ assembled: 'x'.repeat(3000) }) }] } });
    expect(await dependencies.answer!(input, new AbortController().signal, 'control')).toHaveLength(2000);
    for (const result of [{ ok: false }, { ok: true, result: { isError: true } },
      { ok: true, result: { content: [{ type: 'text', text: '{}' }] } }]) {
      providers.dispatch.mockResolvedValueOnce(result);
      await expect(dependencies.answer!(input, new AbortController().signal, 'control')).rejects.toThrow();
    }
  });

  it('refuses a cancelled answer even when the provider finishes', async () => {
    const dependencies = composition();
    const controller = new AbortController(); controller.abort();
    await expect(dependencies.answer!(input, controller.signal, 'control')).rejects.toThrow('tutorial_help_unavailable');
  });

  it('keeps unavailable speech fail-closed before synthesis and uses maintained preferences when available', async () => {
    const dependencies = composition();
    providers.unavailable.mockReturnValueOnce(true);
    await expect(dependencies.speech!('Lesson', 'elevenlabs', 'voice')).rejects.toThrow('tutorial_speech_unavailable');
    expect(providers.synthesize).not.toHaveBeenCalled();
    const speech = { ok: true, audio: new ArrayBuffer(8), contentType: 'audio/wav' };
    providers.synthesize.mockResolvedValueOnce(speech);
    const signal = new AbortController().signal;
    await expect(dependencies.speech!('Lesson', 'elevenlabs', 'voice', signal)).resolves.toBe(speech);
    expect(providers.synthesize).toHaveBeenCalledWith('elevenlabs', 'Lesson', 'voice', {}, { signal });
  });

  it('refuses cancelled speech before loading or calling a provider', async () => {
    const dependencies = composition();
    const controller = new AbortController(); controller.abort();
    await expect(dependencies.speech!('Lesson', 'kokoro', undefined, controller.signal))
      .rejects.toThrow('tutorial_speech_cancelled');
    expect(providers.synthesize).not.toHaveBeenCalled();
    expect(providers.preferences).not.toHaveBeenCalled();
  });
});
