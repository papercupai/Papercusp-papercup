/**
 * operator-voice-proxy.test.ts — unit coverage for the TUI voice proxy routes'
 * pure/mockable parts (voice-mode-tui-port-2026-06-05 P-002 / D-006):
 *
 *   - base64 decode + validation (decodeAudioBase64)
 *   - the STT size caps (MIN/MAX) and format normalization
 *   - TTS engine-default resolution + the browser→kokoro health-gated fallback
 *     decision (resolveTtsEngine), tested with the health probe injected so no
 *     network is touched
 *   - a handful of handler-level checks with `fetch` stubbed (pattern:
 *     operator-voice-io.test.ts) to confirm the route wires the helpers up —
 *     including the spec's "no server-side tts engine available" path when
 *     prefs say 'browser' and kokoro's health probe fails.
 *
 * Live whisper/kokoro round-trips are covered by the plan's P-004 verification
 * against the staging operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DEFAULT_VOICE_PREFS } from '../../voice-prefs';

vi.mock('../../voice-prefs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../voice-prefs')>();
  return { ...orig, loadVoicePrefs: vi.fn(async () => ({ ...orig.DEFAULT_VOICE_PREFS })) };
});
vi.mock('../../voice-credentials', () => ({
  readElevenLabsKey: vi.fn(async () => null),
  readOpenAiKey: vi.fn(async () => null),
  readCartesiaKey: vi.fn(async () => null),
}));

import { loadVoicePrefs } from '../../voice-prefs';
import {
  decodeAudioBase64,
  normalizeAudioFormat,
  resolveTtsEngine,
  isServerTtsEngine,
  MIN_AUDIO_BYTES,
  MAX_AUDIO_BYTES,
  MAX_TEXT_CHARS,
} from '../routes/agent-mcp/operator-voice-proxy-helpers';
import ttsRoute from '../routes/agent-mcp/operator-tts';
import { releaseUnavailableMessage } from '../../voice-release-availability';

// ─── pure helpers: decodeAudioBase64 ─────────────────────────────────────────

describe('decodeAudioBase64', () => {
  it('400s on a missing / non-string / empty payload', () => {
    for (const bad of [undefined, null, 123, {}, '']) {
      const r = decodeAudioBase64(bad as unknown);
      expect(r).toMatchObject({ ok: false, status: 400 });
      if (!r.ok) expect(r.error).toBe('audioBase64 (string) required');
    }
  });

  it('400s when the decoded audio is shorter than a WAV header', () => {
    const tiny = Buffer.alloc(MIN_AUDIO_BYTES - 1, 1).toString('base64');
    const r = decodeAudioBase64(tiny);
    expect(r).toMatchObject({ ok: false, status: 400, error: 'audio too short to transcribe' });
  });

  it('413s when the decoded audio exceeds the 15MB cap', () => {
    // Build a base64 string that decodes to > MAX_AUDIO_BYTES without
    // allocating the whole oversized Buffer redundantly.
    const oversized = Buffer.alloc(MAX_AUDIO_BYTES + 1, 7).toString('base64');
    const r = decodeAudioBase64(oversized);
    expect(r).toMatchObject({ ok: false, status: 413, error: 'audio exceeds the 15MB cap' });
  });

  it('accepts a valid in-range payload and returns the decoded Buffer', () => {
    const buf = Buffer.alloc(2048, 9);
    const r = decodeAudioBase64(buf.toString('base64'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.equals(buf)).toBe(true);
  });

  it('exposes sane cap constants', () => {
    expect(MIN_AUDIO_BYTES).toBe(44);
    expect(MAX_AUDIO_BYTES).toBe(15 * 1024 * 1024);
    expect(MAX_TEXT_CHARS).toBe(4000);
  });
});

// ─── pure helpers: normalizeAudioFormat ──────────────────────────────────────

describe('normalizeAudioFormat', () => {
  it("defaults to 'wav' and only honors an explicit 'webm'", () => {
    expect(normalizeAudioFormat(undefined)).toBe('wav');
    expect(normalizeAudioFormat('wav')).toBe('wav');
    expect(normalizeAudioFormat('mp3')).toBe('wav');
    expect(normalizeAudioFormat('webm')).toBe('webm');
  });
});

// ─── pure helpers: isServerTtsEngine ─────────────────────────────────────────

describe('isServerTtsEngine', () => {
  it('recognizes the four server-side engines and rejects browser/unknown', () => {
    for (const e of ['kokoro', 'elevenlabs', 'openai', 'cartesia']) {
      expect(isServerTtsEngine(e)).toBe(true);
    }
    for (const e of ['browser', 'webspeech', 'nonsense']) {
      expect(isServerTtsEngine(e)).toBe(false);
    }
  });
});

// ─── pure helpers: resolveTtsEngine (the fallback decision) ──────────────────

describe('resolveTtsEngine', () => {
  const healthy = async () => true;
  const unhealthy = async () => false;

  // kokoro and elevenlabs are the server TTS engines available in this public
  // release (voice-final-public-release-2026-10-01#D-005, ElevenLabs restored by
  // D-006); openai/cartesia are refused with a 400 rather than silently swapped
  // for another engine.
  it('honors an explicit, non-empty requested engine over prefs', async () => {
    const r = await resolveTtsEngine('kokoro', { ttsEngine: 'browser' }, unhealthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
    const el = await resolveTtsEngine('elevenlabs', { ttsEngine: 'kokoro' }, unhealthy);
    expect(el).toEqual({ ok: true, engine: 'elevenlabs' });
  });

  it('refuses an explicitly requested engine that is unavailable in this release', async () => {
    const r = await resolveTtsEngine('openai', { ttsEngine: 'kokoro' }, unhealthy);
    expect(r).toEqual({ ok: false, status: 400, error: releaseUnavailableMessage('openai') });
  });

  it('falls back to the prefs engine when the request omits one', async () => {
    const r = await resolveTtsEngine(undefined, { ttsEngine: 'kokoro' }, unhealthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
    const blank = await resolveTtsEngine('', { ttsEngine: 'kokoro' }, unhealthy);
    expect(blank).toEqual({ ok: true, engine: 'kokoro' });
  });

  it('refuses a saved prefs engine that is unavailable in this release', async () => {
    const r = await resolveTtsEngine(undefined, { ttsEngine: 'cartesia' }, unhealthy);
    expect(r).toEqual({ ok: false, status: 400, error: releaseUnavailableMessage('cartesia') });
    const blank = await resolveTtsEngine('', { ttsEngine: 'openai' }, unhealthy);
    expect(blank).toEqual({ ok: false, status: 400, error: releaseUnavailableMessage('openai') });
  });

  it("maps 'browser' → kokoro when kokoro's health check passes", async () => {
    const r = await resolveTtsEngine('browser', { ttsEngine: 'kokoro' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
  });

  it("maps prefs 'browser' → kokoro when healthy (no explicit engine)", async () => {
    const r = await resolveTtsEngine(undefined, { ttsEngine: 'browser' }, healthy);
    expect(r).toEqual({ ok: true, engine: 'kokoro' });
  });

  it("errors cleanly when 'browser' resolves but kokoro is unhealthy", async () => {
    const r = await resolveTtsEngine('browser', { ttsEngine: 'kokoro' }, unhealthy);
    expect(r).toEqual({ ok: false, error: 'no server-side tts engine available', status: 503 });
  });

  it('does NOT probe kokoro health for a non-browser engine', async () => {
    const probe = vi.fn(async () => true);
    await resolveTtsEngine('kokoro', { ttsEngine: 'browser' }, probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('400s on an unknown engine', async () => {
    const r = await resolveTtsEngine('webspeech', { ttsEngine: 'kokoro' }, healthy);
    expect(r).toMatchObject({ ok: false, status: 400 });
    if (!r.ok) expect(r.error).toMatch(/unsupported engine/);
  });
});

// ─── handler-level: the route wires resolveTtsEngine + the health probe ──────

function post(route: unknown, body: unknown): Promise<Response> {
  return (route as { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> }).handler(
    new Request('http://localhost:3070/api/agent-mcp/operator-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => impl(String(url), init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  vi.clearAllMocks();
  (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS });
  // kokoroTtsAvailable() = HTTP health probe OR the IN-PROCESS engine, and the latter is an
  // fs-marker check under the REAL $HOME (isKokoroLocalProvisioned). Reading the developer's
  // home made this suite's verdict machine-dependent: on a box where the local model happens
  // to be provisioned, a server-side engine IS available, so the health-gated 503 below never
  // fires and the assertions invert (it held the release gate on 2026-07-12). Point HOME at a
  // path with no marker so the local leg is deterministically absent and the health probe —
  // which is what these tests actually pin — decides alone.
  vi.stubEnv('HOME', '/nonexistent-papercusp-unit-test-home');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /agent-mcp/operator-tts — browser fallback wiring', () => {
  it("503s with 'no server-side tts engine available' when prefs='browser' and kokoro /health fails", async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'browser' });
    // The only fetch that should be reached is the kokoro /health probe; make it fail.
    const mock = stubFetch((url) => {
      if (url.endsWith('/health')) return new Response('down', { status: 503 });
      return new Response(Buffer.from('should-not-be-reached'), { status: 200 });
    });
    const res = await post(ttsRoute, { text: 'hello' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'no server-side tts engine available' });
    // It probed health and never reached the speech endpoint.
    expect(mock.mock.calls.some(([u]) => String(u).endsWith('/health'))).toBe(true);
    expect(mock.mock.calls.some(([u]) => String(u).endsWith('/v1/audio/speech'))).toBe(false);
  });

  it("synthesizes via kokoro when prefs='browser' and kokoro /health passes", async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'browser' });
    const audio = Buffer.from('RIFF-fake-wav');
    const mock = stubFetch((url) => {
      if (url.endsWith('/health')) return new Response('ok', { status: 200 });
      return new Response(audio, { headers: { 'content-type': 'audio/wav' } });
    });
    const res = await post(ttsRoute, { text: 'hello' });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.engine).toBe('kokoro');
    expect(out.contentType).toBe('audio/wav');
    expect(Buffer.from(out.audioBase64, 'base64')).toEqual(audio);
    expect(mock.mock.calls.some(([u]) => String(u).endsWith('/v1/audio/speech'))).toBe(true);
  });

  it('400s without text', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, {});
    expect(res.status).toBe(400);
  });
});
