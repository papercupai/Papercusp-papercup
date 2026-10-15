import { Conversation } from '@elevenlabs/client';

const workletPaths = {
  rawAudioProcessor: '/elevenlabs-runtime/rawAudioProcessor.js',
  audioConcatProcessor: '/elevenlabs-runtime/audioConcatProcessor.js',
};
const libsampleratePath = '/elevenlabs-runtime/libsamplerate.worklet.js';

/** Tutorial-only seam. Not mounted until hosted issuance and host acceptance pass.
 * No caller-provided agent, tools, prompt, transport or asset overrides. */
export async function startTutorialVoice(signedUrl: string, signal: AbortSignal) {
  const url = new URL(signedUrl);
  if (url.protocol !== 'wss:' || url.host !== 'api.elevenlabs.io'
    || url.pathname !== '/v1/convai/conversation' || url.username || url.password
    || url.hash || url.searchParams.getAll('conversation_signature').length !== 1
    || !url.searchParams.get('conversation_signature')) throw new Error('tutorial_voice_unavailable');
  signal.throwIfAborted();
  // Reject HTML fallback responses as well as missing assets before opening a mic.
  await Promise.all([...Object.values(workletPaths), libsampleratePath].map(async path => {
    const response = await fetch(path, { signal, credentials: 'same-origin' });
    if (!response.ok || !/^(?:text|application)\/javascript(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error('tutorial_voice_assets_unavailable');
    }
  }));
  signal.throwIfAborted();
  const conversation = await Conversation.startSession({
    signedUrl, connectionType: 'websocket', workletPaths: { ...workletPaths }, libsampleratePath,
  });
  if (signal.aborted) {
    await conversation.endSession();
    signal.throwIfAborted();
  }
  const stop = () => { void conversation.endSession().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  return {
    async endSession() {
      signal.removeEventListener('abort', stop);
      await conversation.endSession();
    },
  };
}
