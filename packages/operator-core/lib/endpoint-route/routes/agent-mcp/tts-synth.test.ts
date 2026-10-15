/**
 * tts-synth — the ONE server-side TTS provider registry (voice-consolidation,
 * WI-3448). Pins the properties that make "switch provider = one config change,
 * not a second implementation" true:
 *
 *   - each provider dispatches to the right endpoint with the right auth;
 *   - openai/cartesia read model+voice from PREFS (this is the exact drift that
 *     used to differ between operator-tts and operator-tts-preview — preview
 *     hardcoded tts-1/nova/sonic-2 — so it is pinned here);
 *   - an explicit voiceId overrides the pref;
 *   - a missing cloud key → 404 with NO upstream call; an unknown engine → 400;
 *   - `operator-tts` re-exports the SAME `synthesize` reference, i.e. both
 *     server routes share one implementation (local kokoro ↔ ElevenLabs is one
 *     `ttsEngine` flip against this single code path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const keys: { el: string | null; oa: string | null; ct: string | null } = {
  el: 'el-key',
  oa: 'oa-key',
  ct: 'ct-key',
};
vi.mock('../../../voice-credentials', () => ({
  readElevenLabsKey: async () => keys.el,
  readOpenAiKey: async () => keys.oa,
  readCartesiaKey: async () => keys.ct,
  readDeepgramKey: async () => null,
}));

// The kokoro-unreachable branch falls back to the IN-PROCESS engine, which is gated on an
// fs marker under the REAL $HOME (isKokoroLocalProvisioned). On a box where someone has
// provisioned the local model, the unmocked fallback loads @huggingface/transformers, which
// fetches model metadata through the very `fetch` these tests stub to throw — and its
// console.warn trips vitest-fail-on-console. That made the outcome depend on the developer's
// home directory (green on a fresh machine, red on a provisioned one — it held the release
// gate on 2026-07-12). Stub the fallback: these tests pin `synthesize`'s CLASSIFICATION, and
// kokoro-local has its own suite.
vi.mock('../../../voice-node/kokoro-local', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../voice-node/kokoro-local')>();
  return {
    ...orig,
    kokoroLocalSynthWav: vi.fn(async () => ({ ok: false as const, error: 'kokoro local model not provisioned' })),
  };
});

import { synthesize, synthesizeReading } from './tts-synth';
import { synthesize as synthesizeFromRoute } from './operator-tts';
import type { VoicePrefs } from '../../../voice-prefs';

// Only the fields synthesize() reads; cast a partial to the full type.
const PREFS = {
  elevenlabsVoiceId: 'voice-EL',
  openaiVoice: 'shimmer',
  openaiModel: 'tts-1-hd',
  cartesiaVoiceId: 'voice-CT',
  cartesiaModel: 'sonic-2',
} as unknown as VoicePrefs;

function stubFetch(opts: { status?: number } = {}) {
  const mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('AUDIO-BYTES', { status: opts.status ?? 200 }));
  vi.stubGlobal('fetch', mock);
  return mock;
}
function firstCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: any } {
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse((init.body as string) ?? '{}') };
}
const header = (init: RequestInit, k: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[k];

afterEach(() => {
  vi.unstubAllGlobals();
  keys.el = 'el-key';
  keys.oa = 'oa-key';
  keys.ct = 'ct-key';
});

describe('incremental original reading', () => {
  const prefs = () => ({ ...PREFS, ttsEngine: 'elevenlabs' } as VoicePrefs);

  it('sends the whole source once in ordered byte-bounded chunks with a final Unicode tail', async () => {
    const fetch = stubFetch();
    const source = '日本語 🐉 paragraph. '.repeat(600) + ' FINAL TAIL {name}.';
    const results = [];
    for await (const result of synthesizeReading(source, prefs(), { allowCloud: true })) results.push(result);
    expect(results.every(result => result.ok)).toBe(true);
    const sent = fetch.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)).text);
    expect(sent.join('')).toBe(source);
    expect(sent.length).toBeGreaterThan(2);
    for (const text of sent) expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4000);
    expect(results.at(-1)).toMatchObject({ end: source.length, index: sent.length - 1, total: sent.length });
  });

  it('does no synthesis ahead of consumer demand and retains the original provider/voice', async () => {
    const fetch = stubFetch();
    const selected = prefs();
    const reading = synthesizeReading('a'.repeat(8001), selected, { allowCloud: true });
    expect(fetch).not.toHaveBeenCalled();
    await reading.next();
    expect(fetch).toHaveBeenCalledTimes(1);
    selected.ttsEngine = 'kokoro';
    selected.elevenlabsVoiceId = 'changed';
    await reading.next();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('/voice-EL/');
    await reading.return(undefined);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses cloud disclosure before credentials or upstream requests', async () => {
    const fetch = stubFetch();
    const reading = synthesizeReading('private source', prefs());
    expect((await reading.next()).value).toMatchObject({ ok: false, status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports provider failure and stops rather than switching engines or continuing the tail', async () => {
    const fetch = stubFetch({ status: 401 });
    const results = [];
    for await (const result of synthesizeReading('a'.repeat(8001), prefs(), { allowCloud: true })) results.push(result);
    expect(results).toEqual([{ ok: false, error: 'elevenlabs 401', status: 401 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels before another chunk starts', async () => {
    const fetch = stubFetch();
    const controller = new AbortController();
    const reading = synthesizeReading('a'.repeat(8001), prefs(), { allowCloud: true, signal: controller.signal });
    await reading.next();
    controller.abort();
    expect((await reading.next()).value).toMatchObject({ ok: false, status: 499 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts in-flight provider fetch and emits no late audio', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      expect(init.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetch);
    const result = await synthesize('elevenlabs', 'hello', undefined, PREFS, { signal: controller.signal });
    expect(result).toEqual({ ok: false, error: 'speech cancelled', status: 499 });
  });
});

describe('synthesize() — single server-side TTS registry', () => {
  it('kokoro → local kokoro server, WAV, default voice', async () => {
    const m = stubFetch();
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contentType).toBe('audio/wav');
    const { url, body } = firstCall(m);
    expect(url).toContain('/v1/audio/speech');
    expect(body).toMatchObject({ model: 'kokoro', input: 'hi', voice: 'af_bella', response_format: 'wav' });
  });

  it('elevenlabs → prefs voiceId in URL, turbo model, xi-api-key header', async () => {
    const m = stubFetch();
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    const { url, init, body } = firstCall(m);
    expect(url).toContain('/text-to-speech/voice-EL/stream');
    expect(header(init, 'xi-api-key')).toBe('el-key');
    expect(body.model_id).toBe('eleven_turbo_v2_5');
  });

  it('openai → reads prefs.openaiModel + prefs.openaiVoice (drift fix — NOT hardcoded tts-1/nova)', async () => {
    const m = stubFetch();
    await synthesize('openai', 'hi', undefined, PREFS);
    const { url, init, body } = firstCall(m);
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(header(init, 'Authorization')).toBe('Bearer oa-key');
    expect(body).toMatchObject({ model: 'tts-1-hd', voice: 'shimmer' });
  });

  it('cartesia → reads prefs.cartesiaModel + prefs.cartesiaVoiceId', async () => {
    const m = stubFetch();
    await synthesize('cartesia', 'hi', undefined, PREFS);
    const { url, body } = firstCall(m);
    expect(url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(body.model_id).toBe('sonic-2');
    expect(body.voice).toMatchObject({ mode: 'id', id: 'voice-CT' });
  });

  it('explicit voiceId overrides the pref', async () => {
    const m = stubFetch();
    await synthesize('elevenlabs', 'hi', 'override-voice', PREFS);
    expect(firstCall(m).url).toContain('/text-to-speech/override-voice/stream');
  });

  it('missing cloud key → 404, no upstream call attempted', async () => {
    keys.el = null;
    const m = stubFetch();
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(m).not.toHaveBeenCalled();
  });

  it('unknown engine → 400', async () => {
    const r = await synthesize('bogus', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream non-ok → 502', async () => {
    stubFetch({ status: 500 });
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 502 });
  });

  it('operator-tts re-exports the SAME synthesize (one implementation shared by both routes)', () => {
    expect(synthesizeFromRoute).toBe(synthesize);
  });
});

/**
 * EI-14136: kokoro-fastapi's ffmpeg writer streams the WAV encode and never
 * seeks back to patch the RIFF/data chunk sizes, so both arrive as the
 * 0xFFFFFFFF "unknown length" placeholder even though the response we
 * buffer is complete. Assert `synthesize()` patches them to the real
 * lengths before returning.
 */
describe('synthesize() — WAV streaming-placeholder size patch (EI-14136)', () => {
  /** Build a minimal RIFF/WAVE buffer, optionally with a LIST chunk before
   *  `data` (mirrors kokoro-fastapi's real ffmpeg output) and optionally with
   *  the RIFF/data sizes set to the 0xFFFFFFFF streaming placeholder. */
  function buildWav(opts: { placeholderSizes: boolean; withListChunk?: boolean }): ArrayBuffer {
    const pcmBytes = 16; // arbitrary small payload
    const listPayload = opts.withListChunk ? new Uint8Array([0x49, 0x53, 0x46, 0x54, 0x00, 0x00, 0x00, 0x00]) : null; // "ISFT" + 4 pad bytes
    const listChunkLen = listPayload ? 8 + listPayload.byteLength : 0;
    const fmtChunkLen = 8 + 16;
    const totalLen = 12 + fmtChunkLen + listChunkLen + 8 + pcmBytes;
    const buf = new ArrayBuffer(totalLen);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const writeTag = (off: number, tag: string) => {
      for (let i = 0; i < 4; i++) bytes[off + i] = tag.charCodeAt(i);
    };
    let o = 0;
    writeTag(o, 'RIFF');
    view.setUint32(4, opts.placeholderSizes ? 0xffffffff : totalLen - 8, true);
    writeTag(8, 'WAVE');
    o = 12;
    // fmt chunk (contents irrelevant to the patcher — only chunk-walking matters)
    writeTag(o, 'fmt ');
    view.setUint32(o + 4, 16, true);
    o += 8 + 16;
    if (listPayload) {
      writeTag(o, 'LIST');
      view.setUint32(o + 4, listPayload.byteLength, true);
      bytes.set(listPayload, o + 8);
      o += 8 + listPayload.byteLength;
    }
    // data chunk
    writeTag(o, 'data');
    view.setUint32(o + 4, opts.placeholderSizes ? 0xffffffff : pcmBytes, true);
    o += 8;
    for (let i = 0; i < pcmBytes; i++) bytes[o + i] = i; // arbitrary payload bytes
    return buf;
  }

  function stubFetchWav(buf: ArrayBuffer) {
    const mock = vi.fn(async () => new Response(buf, { status: 200 }));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  it('patches RIFF + data chunk sizes when the upstream sent the streaming placeholder', async () => {
    const wav = buildWav({ placeholderSizes: true });
    stubFetchWav(wav);
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = new DataView(r.audio);
    expect(view.getUint32(4, true)).toBe(r.audio.byteLength - 8); // RIFF size
    // data chunk starts after RIFF(12)+fmt(24) = 36
    expect(view.getUint32(36 + 4, true)).toBe(16); // data size (16 PCM bytes)
  });

  it('walks past a LIST/INFO chunk before "data" (kokoro-fastapi real layout) when patching', async () => {
    const wav = buildWav({ placeholderSizes: true, withListChunk: true });
    stubFetchWav(wav);
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = new DataView(r.audio);
    expect(view.getUint32(4, true)).toBe(r.audio.byteLength - 8); // RIFF size
    // data chunk starts after RIFF(12)+fmt(24)+LIST(8+8=16) = 52
    expect(view.getUint32(52 + 4, true)).toBe(16); // data size
  });

  it('leaves an already-correct WAV byte-for-byte unchanged', async () => {
    const wav = buildWav({ placeholderSizes: false });
    const original = new Uint8Array(wav.slice(0));
    stubFetchWav(wav);
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Uint8Array(r.audio)).toEqual(original);
  });

  it('leaves a non-WAV audio/mpeg response untouched (no accidental RIFF parsing)', async () => {
    const mp3Bytes = new TextEncoder().encode('not-a-wav-file').buffer;
    const mock = vi.fn(async () => new Response(mp3Bytes, { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS); // mp3 branch, not wav
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Uint8Array(r.audio)).toEqual(new Uint8Array(mp3Bytes));
  });
});

/**
 * Upstream status classification (voice-thorough-test-2026-07-09, WI-3527).
 *
 * Every upstream failure used to collapse to 502, so "your ElevenLabs key was
 * rejected / you're out of credits" (401 — the user fixes it) was indisputable
 * from "the provider is down" (5xx — the user waits). A real defunded EL account
 * surfaced from the settings preview as a bare `502`. These pin the classes.
 */
describe('synthesize() — upstream failure classification', () => {
  const respond = (status: number, body: BodyInit | null = 'ERR') => {
    const mock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  it('upstream 401 → 401 (credential rejected / out of credits), not 502', async () => {
    respond(401);
    const r = await synthesize('elevenlabs', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 401 });
    if (!r.ok) expect(r.error).toContain('elevenlabs 401');
  });

  it('upstream 403 → 401 (also a credential problem)', async () => {
    respond(403);
    expect(await synthesize('elevenlabs', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 401 });
  });

  it('upstream 429 → 429 (rate-limited / quota exhausted), not 502', async () => {
    respond(429);
    expect(await synthesize('openai', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 429 });
  });

  it('upstream 400 → 400 (bad voice/model — e.g. kokoro rejecting an unknown voice)', async () => {
    respond(400);
    expect(await synthesize('kokoro', 'hi', 'zz_nonexistent', PREFS)).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream 404 → 400, NEVER 404 (404 is reserved for the no-key contract)', async () => {
    respond(404);
    const r = await synthesize('cartesia', 'hi', undefined, PREFS);
    // If this leaked a 404, operator-tts-preview would mislabel a live provider
    // error as 'no-key' and the settings panel would tell the user to add a key
    // they already have.
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('upstream 5xx → 502 (infrastructure, not the user)', async () => {
    respond(503);
    expect(await synthesize('kokoro', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 502 });
  });

  it('2xx with an empty body → 502', async () => {
    respond(200, null);
    expect(await synthesize('kokoro', 'hi', undefined, PREFS)).toMatchObject({ ok: false, status: 502 });
  });

  it('a thrown/timed-out fetch → 502 unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await synthesize('kokoro', 'hi', undefined, PREFS);
    expect(r).toMatchObject({ ok: false, status: 502 });
    if (!r.ok) expect(r.error).toContain('unreachable');
  });

  it("the EL container:'wav' branch classifies through the same guard (no bespoke copy)", async () => {
    respond(401);
    expect(
      await synthesize('elevenlabs', 'hi', undefined, PREFS, { container: 'wav' }),
    ).toMatchObject({ ok: false, status: 401 });
  });
});
