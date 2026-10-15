import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

/**
 * Shared fixtures for the LIVE voice specs (real Kokoro TTS + real Whisper STT,
 * a WAV played into Chrome's fake microphone). Used by voice-live-e2e.spec.ts
 * and voice-synthetic-roundtrip.spec.ts (voice-final-public-release-2026-10-01
 * D-006). Release acceptance sets PAPERCUSP_REQUIRE_LIVE_VOICE=1 so a dead or
 * starved local engine fails collection instead of skipping to a false green.
 */

export const KOKORO_URL = process.env.KOKORO_URL ?? 'http://127.0.0.1:8880';
// The browser exercises /api/agent-mcp/operator-stt and the PTT path's local
// Whisper. Resolve the same operator Playwright drives so the preflight asks
// its canonical health route whether the external or managed Whisper is ready.
export const OPERATOR_BASE = (
  process.env.OPERATOR_E2E_BASE_URL ??
  process.env.OPERATOR_BASE ??
  `http://127.0.0.1:${process.env.OPERATOR_E2E_PORT ?? '3055'}`
).replace(/\/+$/, '');

/** The sentence the fake microphone "speaks". A pangram: broad phoneme coverage. */
export const PHRASE = 'the quick brown fox jumps over the lazy dog';
export const FAKE_MIC_WAV = join(tmpdir(), 'papercusp-e2e-fakemic.wav');

export const REQUIRE_LIVE_VOICE = process.env.PAPERCUSP_REQUIRE_LIVE_VOICE === '1';

export interface VoiceEngineHealth {
  kokoro?: boolean;
  voicemode?: boolean;
  elevenlabs?: boolean;
}

const curl = (args: string[]): void => {
  execFileSync('curl', ['-sf', '--max-time', '30', ...args], { stdio: 'ignore' });
};

/** The operator's engine-health verdict, or null when it cannot be read. */
export function readVoiceEngineHealth(): VoiceEngineHealth | null {
  try {
    return JSON.parse(
      execFileSync(
        'curl',
        ['-sf', '--max-time', '30', `${OPERATOR_BASE}/api/agent-mcp/operator-voice-engine-health`],
        { encoding: 'utf8' },
      ),
    ) as VoiceEngineHealth;
  } catch {
    return null;
  }
}

/**
 * Synthesize the fake-mic WAV with the real Kokoro. Chrome's fake capture
 * device accepts Kokoro's native 16-bit PCM mono @24kHz as-is. Returns false
 * when the local services are not up.
 */
export function prepareLiveVoiceFixtures(): boolean {
  try {
    curl(['-o', '/dev/null', `${KOKORO_URL}/health`]);
    if (readVoiceEngineHealth()?.voicemode !== true) return false;
    if (!existsSync(FAKE_MIC_WAV)) {
      curl([
        '-X', 'POST', `${KOKORO_URL}/v1/audio/speech`,
        '-H', 'content-type: application/json',
        '-d', JSON.stringify({ model: 'kokoro', input: PHRASE, voice: 'af_bella', response_format: 'wav' }),
        '-o', FAKE_MIC_WAV,
      ]);
    }
    return existsSync(FAKE_MIC_WAV);
  } catch {
    return false;
  }
}

/** Turn a skip into a collection failure when release acceptance demands live voice. */
export function assertLiveVoiceWhenRequired(live: boolean): void {
  if (REQUIRE_LIVE_VOICE && !live) {
    throw new Error(
      `PAPERCUSP_REQUIRE_LIVE_VOICE=1 but the live voice fixtures could not be prepared ` +
      `(Kokoro: ${KOKORO_URL}, operator health: ${OPERATOR_BASE}/api/agent-mcp/operator-voice-engine-health)`,
    );
  }
}

/** Chrome flags that play FAKE_MIC_WAV into getUserMedia (top-level test.use only). */
export const FAKE_MIC_LAUNCH_ARGS = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${FAKE_MIC_WAV}`,
  '--autoplay-policy=no-user-gesture-required',
];

/** Lowercase, strip punctuation, collapse whitespace — STT formatting isn't under test. */
export const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pin the local engine pair (or the given overrides) for the duration of `run`,
 * then restore every shared preference even when the test fails. The live
 * workspace may run a full-agent engine, which would route push-to-talk and
 * playback elsewhere. The workspace header mirrors the SPA's own resolution.
 */
export async function withLocalEnginePrefs<T>(
  page: Page,
  run: () => Promise<T>,
  overrides: { ttsEngine?: string } = {},
): Promise<T> {
  const prefsUrl = '/api/agent-mcp/operator-voice-prefs';
  const indexHtml = await (await page.request.get('/settings/voice')).text();
  const workspace = /__PAPERCUSP_WS__\s*=\s*["']([^"']+)["']/.exec(indexHtml)?.[1] ?? 'default';
  const headers = { 'x-papercusp-workspace': workspace };
  const beforeResponse = await page.request.get(prefsUrl, { headers });
  if (!beforeResponse.ok()) throw new Error(`prefs GET failed: ${beforeResponse.status()}`);
  const before = await beforeResponse.json() as {
    fullAgentEngine?: string;
    sttEngine?: string;
    ttsEngine?: string;
  };
  const put = async (data: Record<string, string>) => {
    const response = await page.request.put(prefsUrl, { headers, data });
    if (!response.ok()) throw new Error(`prefs PUT failed: ${response.status()}`);
  };
  await put({ fullAgentEngine: 'off', sttEngine: 'voicemode', ttsEngine: overrides.ttsEngine ?? 'kokoro' });
  try {
    return await run();
  } finally {
    await put({
      fullAgentEngine: before.fullAgentEngine ?? 'off',
      sttEngine: before.sttEngine ?? 'voicemode',
      ttsEngine: before.ttsEngine ?? 'kokoro',
    });
  }
}
