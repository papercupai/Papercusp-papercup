import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation } from '@elevenlabs/client';
import { startTutorialVoice } from './tutorial-voice-client';
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: vi.fn() } }));
const signedUrl = 'wss://api.elevenlabs.io/v1/convai/conversation?conversation_signature=synthetic';
const endSession = vi.fn(async () => {});
type VoiceSession = Awaited<ReturnType<typeof Conversation.startSession>>;
beforeEach(() => {
  vi.clearAllMocks();
  const session: Pick<VoiceSession, 'endSession'> = { endSession };
  vi.mocked(Conversation.startSession).mockResolvedValue(session as VoiceSession);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('worklet', { headers: { 'content-type': 'application/javascript; charset=utf-8' } })));
});
afterEach(() => vi.unstubAllGlobals());
describe('tutorial websocket client boundary', () => {
  it('preflights and pins every local audio asset, without agent or tool overrides', async () => {
    const controller = new AbortController();
    const session = await startTutorialVoice(signedUrl, controller.signal);
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual([
      '/elevenlabs-runtime/rawAudioProcessor.js', '/elevenlabs-runtime/audioConcatProcessor.js',
      '/elevenlabs-runtime/libsamplerate.worklet.js',
    ]);
    expect(Conversation.startSession).toHaveBeenCalledExactlyOnceWith({ signedUrl, connectionType: 'websocket',
      workletPaths: { rawAudioProcessor: '/elevenlabs-runtime/rawAudioProcessor.js', audioConcatProcessor: '/elevenlabs-runtime/audioConcatProcessor.js' },
      libsampleratePath: '/elevenlabs-runtime/libsamplerate.worklet.js' });
    await session.endSession(); controller.abort(); expect(endSession).toHaveBeenCalledOnce();
  });
  it.each([new Response('fallback', { headers: { 'content-type': 'text/html' } }), new Response('', { status: 404 })])('refuses missing assets or an HTML fallback', async response => {
    vi.mocked(fetch).mockResolvedValueOnce(response);
    await expect(startTutorialVoice(signedUrl, new AbortController().signal)).rejects.toThrow('tutorial_voice_assets_unavailable');
    expect(Conversation.startSession).not.toHaveBeenCalled();
  });
  it.each([signedUrl.replace('api.elevenlabs.io', 'untrusted.test'), signedUrl.replace('wss:', 'https:'), signedUrl + '&conversation_signature=other', signedUrl + '#fragment'])('refuses invalid provider URLs before any I/O', async url => {
    await expect(startTutorialVoice(url, new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(Conversation.startSession).not.toHaveBeenCalled();
  });
  it('closes a session that arrives after cancellation', async () => {
    const controller = new AbortController();
    vi.mocked(Conversation.startSession).mockImplementationOnce(async () => { controller.abort(); return { endSession } as never; });
    await expect(startTutorialVoice(signedUrl, controller.signal)).rejects.toThrow();
    expect(endSession).toHaveBeenCalledOnce();
  });
  it('closes on cancellation after opening', async () => {
    const controller = new AbortController(); await startTutorialVoice(signedUrl, controller.signal);
    controller.abort(); expect(endSession).toHaveBeenCalledOnce();
  });
});
