import { describe, expect, it } from 'vitest';
import {
  RELEASE_UNAVAILABLE_LABEL,
  isFullAgentEngineUnavailable,
  isHostedTtsEngineUnavailable,
  isTtsEngineUnavailable,
  isWakeEngineUnavailable,
  releaseUnavailableMessage,
} from './voice-release-availability';

// Pins the public voice release scope ruled in
// voice-final-public-release-2026-10-01#D-005. Changing a row here changes
// what the public release claims, so it must come with its own acceptance.
describe('voice release availability (D-005)', () => {
  it('keeps the keyless local engines available', () => {
    for (const e of ['kokoro', 'browser']) expect(isTtsEngineUnavailable(e)).toBe(false);
    expect(isFullAgentEngineUnavailable('off')).toBe(false);
    for (const e of ['off', 'openwakeword']) expect(isWakeEngineUnavailable(e)).toBe(false);
  });

  it('offers ElevenLabs TTS locally once its key works (D-006) but keeps it refused on the hosted portal', () => {
    expect(isTtsEngineUnavailable('elevenlabs')).toBe(false);
    expect(isHostedTtsEngineUnavailable('elevenlabs')).toBe(true);
    // Every engine the shared set refuses is refused on hosted too.
    for (const e of ['openai', 'cartesia']) expect(isHostedTtsEngineUnavailable(e)).toBe(true);
    for (const e of ['kokoro', 'browser']) expect(isHostedTtsEngineUnavailable(e)).toBe(false);
  });

  it('marks engines without a working key unavailable', () => {
    for (const e of ['openai', 'cartesia']) expect(isTtsEngineUnavailable(e)).toBe(true);
    for (const e of ['openai-realtime', 'gemini-live', 'elevenlabs-conv', 'elevenlabs-conversational']) {
      expect(isFullAgentEngineUnavailable(e)).toBe(true);
    }
    expect(isWakeEngineUnavailable('porcupine')).toBe(true);
  });

  it('treats non-string and unknown input as not-unavailable (callers validate kind separately)', () => {
    for (const v of [undefined, null, 42, {}, 'not-an-engine']) {
      expect(isTtsEngineUnavailable(v)).toBe(false);
      expect(isHostedTtsEngineUnavailable(v)).toBe(false);
      expect(isFullAgentEngineUnavailable(v)).toBe(false);
      expect(isWakeEngineUnavailable(v)).toBe(false);
    }
  });

  it('names the engine and the release in the shared message', () => {
    expect(releaseUnavailableMessage('elevenlabs-conv')).toBe(
      `ElevenLabs Conversational AI is ${RELEASE_UNAVAILABLE_LABEL}. Choose another engine in /settings/voice.`,
    );
    expect(releaseUnavailableMessage('porcupine')).toMatch(/^Porcupine wake word is not available in this release/);
  });
});
