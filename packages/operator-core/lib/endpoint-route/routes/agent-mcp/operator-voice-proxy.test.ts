/**
 * operator-voice-proxy.test.ts — the pure, network-free helpers shared by the
 * TUI voice proxy routes (voice-mode-tui-port-2026-06-05 D-006). The route-level
 * round-trips (multipart → whisper, text → engine) live in operator-voice-io.test.ts;
 * here we pin the validation / size-cap / engine-resolution decisions in isolation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  decodeAudioBase64,
  normalizeAudioFormat,
  isServerTtsEngine,
  resolveTtsEngine,
  probeVoicemodeHealth,
  MAX_AUDIO_BYTES,
  MIN_AUDIO_BYTES,
} from './operator-voice-proxy-helpers';

describe('decodeAudioBase64', () => {
  it('rejects missing / non-string / empty', () => {
    expect(decodeAudioBase64(undefined)).toMatchObject({ ok: false, status: 400 });
    expect(decodeAudioBase64(123)).toMatchObject({ ok: false, status: 400 });
    expect(decodeAudioBase64('')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects audio shorter than a WAV header (400)', () => {
    const tiny = Buffer.alloc(MIN_AUDIO_BYTES - 1).toString('base64');
    expect(decodeAudioBase64(tiny)).toMatchObject({
      ok: false,
      status: 400,
      error: 'audio too short to transcribe',
    });
  });

  it('rejects audio over the size cap (413)', () => {
    // Construct an oversized payload without allocating it twice: a base64 string
    // whose decoded length exceeds the cap. 4 b64 chars → 3 bytes.
    const overBytes = MAX_AUDIO_BYTES + 3;
    const b64 = 'A'.repeat(Math.ceil(overBytes / 3) * 4);
    const res = decodeAudioBase64(b64);
    expect(res).toMatchObject({ ok: false, status: 413 });
  });

  it('accepts a valid in-range payload and returns the decoded Buffer', () => {
    const audio = Buffer.alloc(MIN_AUDIO_BYTES + 100, 9);
    const res = decodeAudioBase64(audio.toString('base64'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.audio).toEqual(audio);
  });
});

describe('normalizeAudioFormat', () => {
  it('defaults to wav and only accepts webm explicitly', () => {
    expect(normalizeAudioFormat(undefined)).toBe('wav');
    expect(normalizeAudioFormat('wav')).toBe('wav');
    expect(normalizeAudioFormat('mp3')).toBe('wav'); // unknown → wav
    expect(normalizeAudioFormat('webm')).toBe('webm');
  });
});

describe('isServerTtsEngine', () => {
  it('recognizes the server-side engines, rejects browser/garbage', () => {
    for (const e of ['kokoro', 'elevenlabs', 'openai', 'cartesia']) {
      expect(isServerTtsEngine(e)).toBe(true);
    }
    expect(isServerTtsEngine('browser')).toBe(false);
    expect(isServerTtsEngine('webspeech')).toBe(false);
  });
});

describe('resolveTtsEngine', () => {
  const healthy = () => Promise.resolve(true);
  const unhealthy = () => Promise.resolve(false);

  it('honors an explicit, available request over the prefs default', async () => {
    const r = await resolveTtsEngine('kokoro', { ttsEngine: 'browser' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
  });

  it('falls back to the prefs default when no engine is requested', async () => {
    const r = await resolveTtsEngine(undefined, { ttsEngine: 'kokoro' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
    // empty string is treated as "not requested" too
    const r2 = await resolveTtsEngine('', { ttsEngine: 'kokoro' }, healthy);
    expect(r2).toEqual({ ok: true, engine: 'kokoro' });
  });

  // voice-final-public-release-2026-10-01#D-005: cloud TTS engines without a
  // working key are refused — explicitly requested OR saved as the default —
  // and never silently substituted with another engine.
  // #D-006 (update 2026-10-06): local ElevenLabs TTS is keyed and back in scope;
  // only HOSTED ElevenLabs stays refused (RELEASE_UNAVAILABLE_HOSTED_TTS_ENGINES).
  it.each(['openai', 'cartesia'] as const)(
    "refuses release-unavailable '%s' whether requested or saved, without substituting",
    async (engine) => {
      const probe = vi.fn(healthy);
      const requested = await resolveTtsEngine(engine, { ttsEngine: 'kokoro' }, probe);
      expect(requested).toMatchObject({ ok: false, status: 400 });
      expect((requested as { error: string }).error).toMatch(/not available in this release/);
      const saved = await resolveTtsEngine(undefined, { ttsEngine: engine }, probe);
      expect(saved).toMatchObject({ ok: false, status: 400 });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("resolves local 'elevenlabs' (D-006) whether requested or saved, without probing kokoro", async () => {
    const probe = vi.fn(healthy);
    expect(await resolveTtsEngine('elevenlabs', { ttsEngine: 'kokoro' }, probe)).toEqual({
      ok: true,
      engine: 'elevenlabs',
    });
    expect(await resolveTtsEngine(undefined, { ttsEngine: 'elevenlabs' }, probe)).toEqual({
      ok: true,
      engine: 'elevenlabs',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("maps 'browser' to kokoro only when kokoro is healthy", async () => {
    const probe = vi.fn(healthy);
    const r = await resolveTtsEngine('browser', { ttsEngine: 'browser' }, probe);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("503s for 'browser' when kokoro is unreachable (no server-side engine)", async () => {
    const r = await resolveTtsEngine('browser', { ttsEngine: 'browser' }, unhealthy);
    expect(r).toEqual({ ok: false, error: 'no server-side tts engine available', status: 503 });
  });

  it('400s an unknown/unsupported engine', async () => {
    const r = await resolveTtsEngine('webspeech', { ttsEngine: 'kokoro' }, healthy);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('does not probe health when a real engine resolves (no needless network)', async () => {
    const probe = vi.fn(healthy);
    await resolveTtsEngine('kokoro', { ttsEngine: 'kokoro' }, probe);
    expect(probe).not.toHaveBeenCalled();
  });
});

// WI-3663: the "Re-detect engines" button probes voicemode's local Whisper. A down server must
// read false, never throw.
//
// ⚠ REGRESSION PIN (2026-07-13): this test used to assert `/v1/models`, and its comment asserted
// "there is no dedicated /health" as fact. Both were WRONG, and the test's confidence is exactly
// why the bug survived: whisper.cpp's server DOES implement /health (200) and does NOT implement
// /v1/models (404) — it is only OpenAI-shaped on its --inference-path (/v1/audio/transcriptions).
// So the probe reported a healthy, actively-transcribing whisper as DOWN (`voicemode: false` in
// the engine-health route + settings UI), and the owner hit an STT engine the app believed was
// offline. Verified against the live server: /health → 200, /v1/models → 404, a real
// transcription → 200 with text. Pin the URL so this cannot silently regress again.
describe('probeVoicemodeHealth', () => {
  it('probes /health — NOT /v1/models (whisper.cpp 404s that; probing it read healthy as down)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await probeVoicemodeHealth('http://vm.test')).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith('http://vm.test/health', expect.anything());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns false on a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    try {
      expect(await probeVoicemodeHealth('http://vm.test')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns false (never throws) when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    try {
      expect(await probeVoicemodeHealth('http://vm.test')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
