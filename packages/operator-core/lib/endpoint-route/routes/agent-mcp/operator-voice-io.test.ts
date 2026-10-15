/**
 * operator-voice-io.test.ts — the TUI voice proxy routes
 * (voice-mode-tui-port-2026-06-05 D-006): POST /agent-mcp/operator-stt
 * (base64 WAV → voicemode whisper → text) and POST /agent-mcp/operator-tts
 * (text → prefs-resolved engine → base64 audio).
 *
 * Upstream engines are fetch-stubbed (pattern: local-adapters.test.ts);
 * voice-prefs + credentials are module-mocked (they read PG). The live
 * whisper/kokoro round-trip is covered by the plan's P-004 verification
 * against the staging operator.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DEFAULT_VOICE_PREFS } from '../../../voice-prefs';
import { decodeWavPcm16 } from '../../../voice-node/wav';

// This opt-in detector reaches the serving process, whose provider/settings
// modules are independent of this file's unit-test mocks. Never count a skipped
// unavailable provider or the controlled tests below as live synthesis proof.
const liveFetch = globalThis.fetch;
const liveBaseUrl = process.env.PAPERCUSP_TTS_LIVE_BASE_URL;
function assertRealSpeechAudio(audioBase64: string) {
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '24000', 'pipe:1'], {
    input: Buffer.from(audioBase64, 'base64'), timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(decoded.error, 'Audio decoder must be installed and complete').toBeUndefined();
  expect(decoded.status, decoded.stderr.toString().slice(0, 600)).toBe(0);
  expect(decoded.stdout.length).toBeGreaterThan(16_000);
  let peak = 0;
  for (let offset = 0; offset + 1 < decoded.stdout.length; offset += 2) peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(offset)));
  expect(peak).toBeGreaterThan(500);
}
it.runIf(!!liveBaseUrl)('LIVE selected available provider produces decodable non-silent original-reading audio', async ({ skip }) => {
  const base = new URL(liveBaseUrl!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(base.hostname);
  const request = (path: string, init?: RequestInit) => liveFetch(new URL(`/api/agent-mcp/${path}`, base), {
    ...init, signal: AbortSignal.timeout(45_000),
  });
  const prefsResponse = await request('operator-voice-prefs');
  expect(prefsResponse.status).toBe(200);
  const prefs = await prefsResponse.json();
  const healthResponse = await request('operator-voice-engine-health');
  expect(healthResponse.status).toBe(200);
  const health = await healthResponse.json();
  console.info('LIVE_SELECTED_SPEECH_AVAILABILITY', JSON.stringify({
    base: base.origin, selected: prefs.ttsEngine,
    providers: ['kokoro', 'elevenlabs', 'openai', 'cartesia'].map(engine => ({
      engine, available: health[engine], error: health[`${engine}Error`] ?? null,
    })),
  }));
  if (prefs.ttsEngine === 'browser') skip('Selected browser speech requires a real browser voice; server synthesis is not a substitute.');
  expect(['kokoro', 'elevenlabs', 'openai', 'cartesia']).toContain(prefs.ttsEngine);
  if (health[prefs.ttsEngine] === false) skip(`Selected ${prefs.ttsEngine} is unavailable: ${health[`${prefs.ttsEngine}Error`] ?? 'local engine not ready'}`);
  expect(health[prefs.ttsEngine]).toBe(true);
  const source = 'Public speech verification. The north count is twelve and the south count is thirty four. Exact final tail.';
  const response = await request('operator-tts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'read', text: source, format: 'text', allowCloud: true }),
  });
  expect(response.status).toBe(200);
  const records = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  expect(records.filter(record => record.ok !== true)).toEqual([]);
  expect(records.at(-1)).toMatchObject({ type: 'completed', ok: true });
  const chunks = records.filter(record => record.type === 'chunk');
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.map(chunk => chunk.text).join('')).toBe(source);
  for (const chunk of chunks) {
    expect(chunk.engine).toBe(prefs.ttsEngine);
    // Decode both the providers' WAV and native MP3 containers, rather than
    // treating a 200, a byte count, or a canned RIFF prefix as real audio.
    assertRealSpeechAudio(chunk.audioBase64);
  }
}, 90_000);
it.runIf(!!liveBaseUrl)('LIVE configured ElevenLabs route produces decodable non-silent complete-reply audio', async ({ skip }) => {
  const base = new URL(liveBaseUrl!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(base.hostname);
  const request = (path: string, init?: RequestInit) => liveFetch(new URL(`/api/agent-mcp/${path}`, base), {
    ...init, signal: AbortSignal.timeout(45_000),
  });
  const healthResponse = await request('operator-voice-engine-health');
  expect(healthResponse.status).toBe(200);
  const health = await healthResponse.json();
  if (health.elevenlabs === false) skip(`ElevenLabs is unavailable: ${health.elevenlabsError ?? 'not configured'}`);
  expect(health.elevenlabs).toBe(true);
  const response = await request('operator-tts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'elevenlabs', text: 'Public configured provider verification. Exact complete final sentence.' }),
  });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ ok: true, engine: 'elevenlabs' });
  assertRealSpeechAudio(result.audioBase64);
}, 90_000);

vi.mock('../../../voice-prefs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../voice-prefs')>();
  return { ...orig, loadVoicePrefs: vi.fn(async () => ({ ...orig.DEFAULT_VOICE_PREFS })) };
});
vi.mock('../../../voice-credentials', () => ({
  readElevenLabsKey: vi.fn(async () => null),
  readOpenAiKey: vi.fn(async () => null),
  readCartesiaKey: vi.fn(async () => null),
}));
// See tts-synth.test.ts: the kokoro-unreachable branch's in-process fallback is gated on an
// fs marker under the REAL $HOME, so on a box with the local model provisioned it loads
// @huggingface/transformers, fetches through the stubbed `fetch`, and console.warns —
// failing the test on some machines and not others. Stub it; kokoro-local has its own suite.
vi.mock('../../../voice-node/kokoro-local', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../voice-node/kokoro-local')>();
  return {
    ...orig,
    kokoroLocalSynthWav: vi.fn(async () => ({ ok: false as const, error: 'kokoro local model not provisioned' })),
  };
});

import { loadVoicePrefs } from '../../../voice-prefs';
import { readElevenLabsKey, readOpenAiKey, readCartesiaKey } from '../../../voice-credentials';
import sttRoute from './operator-stt';
import ttsRoute, { synthesize } from './operator-tts';

type Route = { handler: (req: Request, ctx: { params: Record<string, unknown> }) => Promise<Response> };

function post(route: unknown, path: string, body: unknown): Promise<Response> {
  return (route as Route).handler(
    new Request(`http://localhost:3070/api/agent-mcp/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: {} },
  );
}

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    impl(String(url), init),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** A fake 1s-ish WAV payload (just bytes — upstream is stubbed). */
const FAKE_WAV = Buffer.alloc(2048, 7);
const FAKE_WAV_B64 = FAKE_WAV.toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS });
});
afterEach(() => vi.unstubAllGlobals());

// ─── operator-stt ────────────────────────────────────────────────────────────

describe('POST /agent-mcp/operator-stt', () => {
  it('proxies base64 WAV to whisper as multipart and returns the trimmed text', async () => {
    const mock = stubFetch(() => Response.json({ text: '  hello world ' }));
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, text: 'hello world' });

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/audio\/transcriptions$/);
    const fd = init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get('model')).toBe('whisper-1');
    const file = fd.get('file') as File;
    expect(file.size).toBe(FAKE_WAV.length);
    expect(file.name).toBe('audio.wav');
  });

  it('400s without audioBase64', async () => {
    stubFetch(() => Response.json({}));
    const res = await post(sttRoute, 'operator-stt', {});
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it('400s on audio shorter than a WAV header', async () => {
    stubFetch(() => Response.json({}));
    const res = await post(sttRoute, 'operator-stt', {
      audioBase64: Buffer.alloc(10).toString('base64'),
    });
    expect(res.status).toBe(400);
  });

  it('502s when whisper is down (fetch throws)', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/unreachable/);
  });

  it('502s on a whisper non-2xx', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    const res = await post(sttRoute, 'operator-stt', { audioBase64: FAKE_WAV_B64 });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('whisper 500');
  });
});

// ─── operator-tts ────────────────────────────────────────────────────────────

describe('POST /agent-mcp/operator-tts original reading', () => {
  it('reads the complete long source using stored settings and emits honest progress/completion', async () => {
    const mock = stubFetch(() => new Response(FAKE_WAV));
    const source = 'A paragraph with exact symbols {name}. '.repeat(230) + 'FINAL 🐉 TAIL';
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: source });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const records = (await res.text()).trim().split('\n').map(line => JSON.parse(line));
    const chunks = records.filter(record => record.type === 'chunk');
    expect(chunks.map(chunk => chunk.text).join('')).toBe(source);
    expect(chunks.at(-1).end).toBe(source.length);
    expect(records.at(-1)).toEqual({ ok: true, type: 'completed', chunks: chunks.length });
    expect(mock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).input).join('')).toBe(source);
    expect(loadVoicePrefs).toHaveBeenCalledTimes(1);
  });

  it('defaults to local-only and refuses selected cloud before synthesis', async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'elevenlabs' });
    const mock = stubFetch(() => new Response(FAKE_WAV));
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'private words' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('local speech');
    expect(mock).not.toHaveBeenCalled();
  });

  it('requires the browser player for explicit reading instead of substituting a server engine', async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'browser' });
    const mock = stubFetch(() => new Response(FAKE_WAV));
    for (const allowCloud of [false, true]) {
      const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'original words', allowCloud });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('active browser player');
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('does not emit completed when a later chunk fails', async () => {
    let calls = 0;
    stubFetch(() => ++calls === 1 ? new Response(FAKE_WAV) : new Response('unavailable', { status: 500 }));
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'x'.repeat(9000) });
    const records = (await res.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(records.map(record => record.type)).toEqual(['chunk', 'error']);
    expect(records.at(-1)).toMatchObject({ ok: false, status: 502, chunks: 1 });
    expect(calls).toBe(2);
  });

  it('bounds synthesis to one prepared chunk while the response consumer is stalled', async () => {
    const mock = stubFetch(() => new Response(FAKE_WAV));
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'x'.repeat(9001) });
    const reader = res.body!.getReader();
    expect(mock).toHaveBeenCalledTimes(1);
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toMatchObject({ type: 'chunk', index: 0 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mock).toHaveBeenCalledTimes(1);
    const second = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(second.value))).toMatchObject({ type: 'chunk', index: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mock).toHaveBeenCalledTimes(2);
    await reader.cancel();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('stops synthesis when the response consumer cancels', async () => {
    const mock = stubFetch(() => new Response(FAKE_WAV));
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'x'.repeat(9000) });
    const reader = res.body!.getReader();
    await reader.read();
    expect(mock).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed option types instead of treating a string as cloud consent', async () => {
    const res = await post(ttsRoute, 'operator-tts', { operation: 'read', text: 'words', allowCloud: 'true' });
    expect(res.status).toBe(400);
  });
});

describe('POST /agent-mcp/operator-tts', () => {
  it('synthesizes via the prefs default engine (kokoro) and returns base64 wav', async () => {
    const audio = Buffer.from('RIFF-fake-wav-bytes');
    const mock = stubFetch(() => new Response(audio, { headers: { 'content-type': 'audio/wav' } }));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hello from the TUI' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.engine).toBe('kokoro'); // DEFAULT_VOICE_PREFS.ttsEngine
    expect(body.contentType).toBe('audio/wav');
    expect(Buffer.from(body.audioBase64, 'base64')).toEqual(audio);

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/audio\/speech$/);
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      model: 'kokoro',
      input: 'hello from the TUI',
      voice: 'af_bella',
      response_format: 'wav',
    });
  });

  it("maps ttsEngine 'browser' (no speechSynthesis in a terminal) to kokoro", async () => {
    (loadVoicePrefs as Mock).mockResolvedValue({ ...DEFAULT_VOICE_PREFS, ttsEngine: 'browser' });
    stubFetch(() => new Response(Buffer.from('x'), { status: 200 }));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi' });
    expect((await res.json()).engine).toBe('kokoro');
  });

  it('400s without text', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', {});
    expect(res.status).toBe(400);
  });

  it('400s on an unsupported engine', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi', engine: 'webspeech' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unsupported engine/);
  });

  it('404s when the requested cloud engine has no key', async () => {
    stubFetch(() => new Response(''));
    const res = await post(ttsRoute, 'operator-tts', { text: 'hi', engine: 'elevenlabs' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/key not configured/);
  });

  it('uses the prefs elevenlabs voice and preserves text at the 4000-character request limit', async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    const mock = stubFetch(() => new Response(Buffer.from('mp3'), { status: 200 }));
    const long = ' ' + 'a'.repeat(3998) + ' ';
    const res = await post(ttsRoute, 'operator-tts', { text: long, engine: 'elevenlabs' });
    expect(res.status).toBe(200);
    expect((await res.json()).contentType).toBe('audio/mpeg');
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(DEFAULT_VOICE_PREFS.elevenlabsVoiceId);
    expect(JSON.parse(String(init.body)).text).toBe(long);
  });

  it('413s over-limit text instead of silently truncating it', async () => {
    const mock = stubFetch(() => new Response(Buffer.from('should not synthesize'), { status: 200 }));
    const res = await post(ttsRoute, 'operator-tts', { text: 'a'.repeat(4001) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/4000 characters per request/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('502s when the engine is unreachable', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const synth = await synthesize('kokoro', 'hi', undefined, DEFAULT_VOICE_PREFS);
    expect(synth).toMatchObject({ ok: false, status: 502 });
  });

  // ── synthesize() container option (B1 — the p2p voice-channel say-path) ──────
  // voiceAgentSay requests container:'wav' so its decodeWavPcm16 path accepts
  // every server engine. ElevenLabs has no WAV container, so synthesize asks
  // for raw pcm_24000 and wraps it into a WAV here. These exercise synthesize()
  // directly (fetch stubbed) — the same seam voiceAgentSay calls.

  it("elevenlabs container:'wav' requests pcm_24000 and returns a decodable WAV", async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    // What output_format=pcm_24000 yields: raw little-endian PCM16 @ 24kHz.
    const pcm = new Int16Array([0, 1000, -1000, 2000, -2000, 32767, -32768, 123]);
    const mock = stubFetch(() => new Response(Buffer.from(pcm.buffer), { status: 200 }));

    const synth = await synthesize('elevenlabs', 'narrate the demo', undefined, DEFAULT_VOICE_PREFS, {
      container: 'wav',
    });
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/wav');

    // Must have asked EL for raw PCM (so the WAV wrap is lossless).
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('output_format=pcm_24000');
    expect((init.headers as Record<string, string>).accept).toBe('audio/pcm');

    // The bytes are a real RIFF/WAVE the channel decoder accepts, round-tripping
    // the PCM at 24kHz — proving voiceAgentSay's decodeWavPcm16 path will work.
    const decoded = decodeWavPcm16(new Uint8Array(synth.audio));
    expect(decoded.sampleRate).toBe(24_000);
    expect([...decoded.samples]).toEqual([...pcm]);
  });

  it('elevenlabs default container stays mp3 (audio/mpeg, no output_format) — TUI path unchanged', async () => {
    (readElevenLabsKey as Mock).mockResolvedValue('k-123');
    const mock = stubFetch(() => new Response(Buffer.from('mp3-bytes'), { status: 200 }));
    const synth = await synthesize('elevenlabs', 'narrate the demo', undefined, DEFAULT_VOICE_PREFS);
    expect(synth.ok).toBe(true);
    if (!synth.ok) return;
    expect(synth.contentType).toBe('audio/mpeg');
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('output_format');
  });

  it("openai/cartesia container:'wav' request a WAV response_format", async () => {
    (readOpenAiKey as Mock).mockResolvedValue('o-123');
    let mock = stubFetch(() => new Response(Buffer.from('RIFF....WAVE'), { status: 200 }));
    let synth = await synthesize('openai', 'hi', undefined, DEFAULT_VOICE_PREFS, { container: 'wav' });
    expect(synth.ok).toBe(true);
    if (synth.ok) expect(synth.contentType).toBe('audio/wav');
    expect(JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body)).response_format).toBe('wav');

    (readCartesiaKey as Mock).mockResolvedValue('c-123');
    mock = stubFetch(() => new Response(Buffer.from('RIFF....WAVE'), { status: 200 }));
    synth = await synthesize('cartesia', 'hi', undefined, DEFAULT_VOICE_PREFS, { container: 'wav' });
    expect(synth.ok).toBe(true);
    if (synth.ok) expect(synth.contentType).toBe('audio/wav');
    expect(JSON.parse(String((mock.mock.calls[0] as [string, RequestInit])[1].body)).output_format.container).toBe('wav');
  });
});
