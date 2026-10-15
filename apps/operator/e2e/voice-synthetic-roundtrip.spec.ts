import type { Page } from '@playwright/test';

import { expect, test } from './_egress';
import {
  FAKE_MIC_LAUNCH_ARGS,
  REQUIRE_LIVE_VOICE,
  assertLiveVoiceWhenRequired,
  norm,
  prepareLiveVoiceFixtures,
  readVoiceEngineHealth,
  withLocalEnginePrefs,
} from './_voice-live';

/**
 * SYNTHETIC-VOICE ROUND TRIPS through the shipped client voice paths
 * (voice-final-public-release-2026-10-01 D-006). Kokoro speech is played into
 * Chrome's fake microphone and driven through the REAL push-to-talk code
 * (backtick hold → startPttRawCapture → local Whisper → voice state), and the
 * REAL reply-playback code (speak → bounded operator-tts chunks → Audio) is captured
 * and transcribed back. Covered: STT, TTS playback per keyed engine,
 * stop/barge-in cleanup, microphone denial, and STT failure-then-retry.
 *
 * Voice mode stays 'off' during push-to-talk so VoiceAppBridge drops the final
 * utterance: these runs reuse a live operator and must never write into the
 * owner's real conversation thread. Every test asserts that no turn was posted.
 * The brain leg (question → agent reply → spoken) runs on the isolated-DB
 * desktop rig, where writes are safe.
 *
 * Synthetic evidence SUPPLEMENTS the plan's real-microphone bar (D-005); it
 * never substitutes for it.
 *
 *   OPERATOR_E2E_REUSE_SERVER=1 OPERATOR_E2E_BASE_URL=http://127.0.0.1:3170 \
 *     PAPERCUSP_REQUIRE_LIVE_VOICE=1 npx playwright test e2e/voice-synthetic-roundtrip.spec.ts
 */

const live = prepareLiveVoiceFixtures();
assertLiveVoiceWhenRequired(live);

test.use({ permissions: ['microphone'], launchOptions: { args: FAKE_MIC_LAUNCH_ARGS } });
// Every test pins the WORKSPACE-WIDE voice prefs through withLocalEnginePrefs and
// restores them in `finally`, so two of these tests on parallel workers overwrite
// each other's engine pin mid-test (the operator config sets fullyParallel: true).
// Opt this file out: its tests run in order on one worker (WI-10006911 seeded run).
test.describe.configure({ mode: 'default' });

const REPLY = 'Papercup heard you. The synthetic voice check is complete.';

interface VoiceHook {
  setMode(m: 'off' | 'push-to-talk' | 'always-on'): void;
  getState(): { status: string; lastTranscript: string; mode: string };
  lastSilenced(): { reason: string } | null;
  speak(t: string): void;
  /** A non-forced reply: the same gates an agent reply passes (voice off, output mute, leader). */
  reply(t: string): void;
  outputMuted(): boolean;
  cancel(): void;
  ttsEngine(): string | null;
}
type VoiceWindow = Window & {
  __pcVoiceTest?: VoiceHook;
  __voiceEvents?: Array<{ phase: string; message: string; atMs: number }>;
  __audioPlayEvents?: Array<{
    event: string;
    atMs: number;
    src: string;
    paused: boolean;
    muted: boolean;
    volume: number;
    readyState: number;
    currentTime: number;
    duration: number | null;
    errorCode: number | null;
    errorName?: string;
    errorMessage?: string;
  }>;
  /** Every MediaStream the page obtained from getUserMedia (R-4 cleanup legs). */
  __micStreams?: MediaStream[];
};

/** Install the dev-only voice hook + an event recorder, then open the shell. */
async function openShell(
  page: Page,
  opts: { denyMic?: boolean } = {},
): Promise<{ postedTurns: string[]; postedBodies: string[]; postedOutcomes: string[] }> {
  await page.addInitScript((denyMic) => {
    const w = window as VoiceWindow & { __PAPERCUSP_DEV_WRAPPER__?: boolean };
    w.__PAPERCUSP_DEV_WRAPPER__ = true;
    sessionStorage.setItem('oracle-tutorial-complete', 'true');
    w.__voiceEvents = [];
    w.__audioPlayEvents = [];
    w.__micStreams = [];
    window.addEventListener('papercusp:voiceTimeout', (e) => {
      const detail = (e as CustomEvent<{ phase?: string; message?: string }>).detail;
      w.__voiceEvents!.push({
        phase: String(detail?.phase ?? 'unknown'),
        message: String(detail?.message ?? ''),
        atMs: Math.round(performance.now()),
      });
    });
    const recordAudioPlay = (audio: HTMLAudioElement, event: string, failure?: unknown) => {
      const error = failure as { name?: unknown; message?: unknown } | undefined;
      const events = w.__audioPlayEvents!;
      events.push({
        event,
        atMs: Math.round(performance.now()),
        src: audio.currentSrc || audio.src,
        paused: audio.paused,
        muted: audio.muted,
        volume: audio.volume,
        readyState: audio.readyState,
        currentTime: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : null,
        errorCode: audio.error?.code ?? null,
        ...(error ? {
          errorName: String(error.name ?? ''),
          errorMessage: String(error.message ?? error),
        } : {}),
      });
      if (events.length > 24) events.splice(0, events.length - 24);
    };
    const originalAudioPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args: Parameters<typeof originalAudioPlay>) {
      if (!(this instanceof HTMLAudioElement)) return originalAudioPlay.apply(this, args);
      const audio = this;
      recordAudioPlay(audio, 'play-called');
      audio.addEventListener('playing', () => recordAudioPlay(audio, 'playing'), { once: true });
      audio.addEventListener('ended', () => recordAudioPlay(audio, 'ended'), { once: true });
      audio.addEventListener('error', () => recordAudioPlay(audio, 'element-error'), { once: true });
      audio.addEventListener('pause', () => recordAudioPlay(audio, 'paused'), { once: true });
      try {
        const result = originalAudioPlay.apply(audio, args);
        void result.then(
          () => recordAudioPlay(audio, 'play-fulfilled'),
          (error: unknown) => recordAudioPlay(audio, 'play-rejected', error),
        );
        return result;
      } catch (error) {
        recordAudioPlay(audio, 'play-threw', error);
        throw error;
      }
    };
    if (denyMic) {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    } else {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => {
        const stream = await real(c);
        w.__micStreams!.push(stream);
        return stream;
      };
    }
  }, opts.denyMic ?? false);
  const postedTurns: string[] = [];
  const postedBodies: string[] = [];
  // Each POST's outcome (`<status> <role>` or `failed <reason> <role>`), in
  // completion order. A duplicated body is either two sends or a client retry
  // after a failed attempt; only the outcomes tell those apart (WI-10006911).
  const postedOutcomes: string[] = [];
  const isTurnPost = (r: { method(): string; url(): string }) =>
    r.method() === 'POST' && /\/api\/operator\/conversations\/[^/]+\/turns/.test(r.url());
  const roleOf = (body: string | null) => {
    try { return String((JSON.parse(body ?? '') as { role?: unknown }).role ?? '?'); } catch { return '?'; }
  };
  page.on('request', (r) => {
    if (isTurnPost(r)) {
      postedTurns.push(r.url());
      postedBodies.push(r.postData() ?? '');
    }
  });
  page.on('response', (res) => {
    const r = res.request();
    if (isTurnPost(r)) postedOutcomes.push(`${res.status()} ${roleOf(r.postData())}`);
  });
  page.on('requestfailed', (r) => {
    if (isTurnPost(r)) postedOutcomes.push(`failed ${r.failure()?.errorText ?? '?'} ${roleOf(r.postData())}`);
  });
  await page.goto('/harness');
  await expect(page.getByRole('button', { name: 'Voice mode' })).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() => !!(window as VoiceWindow).__pcVoiceTest, undefined, { timeout: 30_000 });
  return { postedTurns, postedBodies, postedOutcomes };
}

/** Microphone tracks the page obtained that are still capturing. */
const liveMicTracks = (page: Page) => page.evaluate(() =>
  ((window as VoiceWindow).__micStreams ?? [])
    .flatMap((s) => s.getAudioTracks())
    .filter((t) => t.readyState === 'live').length);

/** Count bounded operator-tts POSTs from now on (one per synthesized chunk). */
function countTtsPosts(page: Page): { readonly n: number } {
  const counter = { n: 0 };
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/agent-mcp/operator-tts')) counter.n += 1;
  });
  return counter;
}

const status = async (page: Page) => (await voice(page, (h) => h.getState())).status;

const voice = <T>(page: Page, fn: (hook: VoiceHook) => T) =>
  page.evaluate((src) => {
    // eslint-disable-next-line no-new-func
    return new Function('hook', `return (${src})(hook)`)((window as VoiceWindow).__pcVoiceTest);
  }, fn.toString()) as Promise<T>;

/** Hold the push-to-talk key (Backquote) while the fake mic plays the pangram. */
async function holdToTalk(page: Page, ms = 5_000): Promise<void> {
  await page.keyboard.down('Backquote');
  await page.waitForTimeout(ms);
  await page.keyboard.up('Backquote');
}

const events = (page: Page) => page.evaluate(() => (window as VoiceWindow).__voiceEvents ?? []);

const replyPlaybackDiagnostics = (page: Page) => page.evaluate(() => {
  const w = window as VoiceWindow;
  return {
    status: w.__pcVoiceTest?.getState().status ?? 'hook-unavailable',
    voiceTimeouts: (w.__voiceEvents ?? []).slice(-8),
    audioPlay: (w.__audioPlayEvents ?? []).slice(-12),
  };
});

interface CapturedTts { status: number; engine: unknown; text: string; body: Buffer }

/**
 * Capture the exact TTS bytes the reply player decodes from operator-tts JSON.
 * The endpoint uses base64 audio for its UTF-8-safe IPC contract; decode that
 * field here so the same audio can be transcribed back through STT.
 */
async function captureNextTtsReply(page: Page, timeoutMs = 60_000): Promise<() => Promise<CapturedTts>> {
  let resolve!: (c: CapturedTts) => void;
  const captured = new Promise<CapturedTts>((r) => { resolve = r; });
  await page.route('**/api/agent-mcp/operator-tts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    const body = await response.body();
    const audioResponse = JSON.parse(body.toString('utf8')) as { audioBase64?: string };
    const sent = JSON.parse(route.request().postData() ?? '{}') as { engine?: unknown; text?: unknown };
    resolve({
      status: response.status(),
      engine: sent.engine,
      text: String(sent.text ?? ''),
      body: Buffer.from(audioResponse.audioBase64 ?? '', 'base64'),
    });
    await route.fulfill({ response, body });
  });
  return () => Promise.race([
    captured,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('no operator-tts POST within ' + timeoutMs + 'ms')), timeoutMs,
    )),
  ]);
}

/** Decode reply audio in the browser (any format it can play), re-encode 16k WAV, transcribe. */
async function transcribeInPage(page: Page, audio: Buffer): Promise<{ status: number; text: string }> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const decoded = await new OfflineAudioContext(1, 1, 16_000).decodeAudioData(bytes.buffer);
    const pcm = decoded.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, 16_000, true); out.setUint32(28, 32_000, true); out.setUint16(32, 2, true);
    out.setUint16(34, 16, true); tag(36, 'data'); out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const s = Math.max(-1, Math.min(1, pcm[i]));
      out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const u8 = new Uint8Array(out.buffer);
    let bin = '';
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    const r = await fetch('/api/agent-mcp/operator-stt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audioBase64: btoa(bin), format: 'wav' }),
    });
    const j = (await r.json().catch(() => null)) as { text?: unknown } | null;
    return { status: r.status, text: String(j?.text ?? '') };
  }, audio.toString('base64'));
}

(live ? test.describe : test.describe.skip)('SYNTHETIC voice round trips (D-006)', () => {
  test.describe.configure({ mode: 'serial' }); // shared voice prefs + one local Whisper

  test('push-to-talk: fake-mic speech is transcribed by the real PTT path', async ({ page }) => {
    test.setTimeout(150_000);
    await withLocalEnginePrefs(page, async () => {
      const { postedTurns } = await openShell(page);
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page);
      await expect.poll(async () => norm((await voice(page, (h) => h.getState())).lastTranscript), {
        timeout: 60_000,
      }).toContain('quick brown fox');
      expect(norm((await voice(page, (h) => h.getState())).lastTranscript)).toContain('lazy dog');
      expect((await events(page)).filter((e) => e.phase === 'no-audio' || e.phase === 'transcript')).toEqual([]);
      expect(postedTurns, 'PTT in mode off must not write a conversation turn').toEqual([]);
    });
  });

  for (const engine of ['kokoro', 'elevenlabs'] as const) {
    test(`reply playback (${engine}): speak() plays audio that transcribes back to the reply`, async ({ page }) => {
      test.setTimeout(150_000);
      if (engine === 'elevenlabs' && readVoiceEngineHealth()?.elevenlabs !== true) {
        // Fails a release-acceptance run, where ElevenLabs TTS is in scope (D-006).
        expect(REQUIRE_LIVE_VOICE, 'ElevenLabs TTS is in release scope but not healthy').toBe(false);
        test.skip(true, 'ElevenLabs is not keyed on this operator');
      }
      await withLocalEnginePrefs(page, async () => {
        const { postedTurns } = await openShell(page);
        await voice(page, (h) => h.setMode('push-to-talk'));
        // Wait for the prefs sync to deliver the engine to the client before speaking.
        await expect.poll(() => voice(page, (h) => h.ttsEngine()), { timeout: 30_000 }).toBe(engine);
        const nextReply = await captureNextTtsReply(page);
        await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), REPLY);
        const reply = await nextReply();
        expect(reply.status).toBe(200);
        expect(reply.engine).toBe(engine);
        expect(reply.body.length, 'captured TTS reply bytes').toBeGreaterThan(1_000);
        // The client really played it, rather than one of speak()'s silent gates.
        await expect.poll(() => replyPlaybackDiagnostics(page), {
          timeout: 30_000,
          message: 'reply playback should enter speaking; received snapshot includes voiceTimeout and Audio.play diagnostics',
        }).toMatchObject({ status: 'speaking' });
        const heard = await transcribeInPage(page, reply.body);
        expect(heard.status).toBe(200);
        expect(norm(heard.text), `whisper heard: ${JSON.stringify(heard.text)}`).toContain('synthetic voice');
        await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 60_000 })
          .not.toBe('speaking');
        expect((await events(page)).filter((e) => e.phase === 'playback')).toEqual([]);
        expect(postedTurns).toEqual([]);
      }, { ttsEngine: engine });
    });
  }

  test('stop: cancelling mid-reply ends playback and stays stopped', async ({ page }) => {
    test.setTimeout(120_000);
    await withLocalEnginePrefs(page, async () => {
      await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), `${REPLY} `.repeat(6));
      await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 60_000 })
        .toBe('speaking');
      await voice(page, (h) => h.cancel());
      await expect.poll(async () => (await voice(page, (h) => h.getState())).status, { timeout: 2_000 })
        .not.toBe('speaking');
      await page.waitForTimeout(3_000); // a queued or still-playing clip must not resurrect it
      expect((await voice(page, (h) => h.getState())).status).not.toBe('speaking');
    });
  });

  test('denial: a blocked microphone names the permission problem', async ({ page }) => {
    test.setTimeout(90_000);
    await withLocalEnginePrefs(page, async () => {
      const whisperCalls: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/v1/audio/transcriptions')) whisperCalls.push(r.url()); });
      const { postedTurns } = await openShell(page, { denyMic: true });
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page, 1_500);
      await expect.poll(async () => (await events(page)).find((e) => e.phase === 'no-audio')?.message ?? '', {
        timeout: 15_000,
      }).toMatch(/Microphone access is blocked/);
      expect(whisperCalls).toEqual([]);
      expect(postedTurns).toEqual([]);
    });
  });

  test('retry: an STT failure says so, and the next hold transcribes', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      let failNext = true;
      await page.route(/\/v1\/audio\/transcriptions/, async (route) => {
        if (failNext) {
          failNext = false;
          await route.fulfill({ status: 500, body: 'synthetic outage' });
          return;
        }
        await route.continue();
      });
      const { postedTurns } = await openShell(page);
      await voice(page, (h) => h.setMode('off'));
      await holdToTalk(page);
      await expect.poll(async () => (await events(page)).some((e) => e.phase === 'transcript'), { timeout: 30_000 })
        .toBe(true);
      expect((await voice(page, (h) => h.getState())).lastTranscript).toBe('');
      await holdToTalk(page);
      await expect.poll(async () => norm((await voice(page, (h) => h.getState())).lastTranscript), {
        timeout: 60_000,
      }).toContain('quick brown fox');
      expect(postedTurns).toEqual([]);
    });
  });

  // The brain leg: question (fake mic) → PTT → STT → posted turn → agent reply →
  // spoken reply. It writes a real conversation turn, so it runs only on the
  // isolated-DB desktop rig (verify-tauri-headless VERIFY_TAURI_ISOLATED_DB=1).
  test('brain: a spoken question is posted, answered by the agent, and the answer is spoken', async ({ page }) => {
    test.skip(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1',
      'writes a real conversation turn: isolated-DB desktop rig only');
    test.setTimeout(330_000);
    await withLocalEnginePrefs(page, async () => {
      const { postedTurns, postedBodies, postedOutcomes } = await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      const nextReply = await captureNextTtsReply(page, 240_000);
      await holdToTalk(page);
      // The same route also persists the agent's reply (role 'assistant', which can
      // land within seconds), so turn identity is judged on the USER-role posts only
      // (measured, rig run 2 2026-10-06: exactly one role:'user' POST per hold).
      // Compare the PARSED text, never the raw body: JSON escapes a newline as
      // `\n`, which norm() turns into a stray "n" token.
      const userTexts = () => postedBodies.flatMap((b) => {
        try {
          const turn = JSON.parse(b) as { role?: unknown; text?: unknown };
          return turn.role === 'user' ? [String(turn.text ?? '')] : [];
        } catch { return []; }
      });
      await expect.poll(() => userTexts().length, { timeout: 60_000, message: 'the spoken question was posted as a turn' })
        .toBeGreaterThan(0);
      // R-4 turn/transcript identity: one hold posts ONE user turn, and what it posts
      // IS the transcript the user was shown — not a re-recognition or a stale one.
      const transcript = (await voice(page, (h) => h.getState())).lastTranscript;
      expect(norm(transcript)).toContain('quick brown fox');
      expect(userTexts(), `one hold posts exactly one user turn; all posted turn bodies: ${JSON.stringify(postedBodies)}; outcomes: ${JSON.stringify(postedOutcomes)}`)
        .toHaveLength(1);
      expect(norm(userTexts()[0] ?? ''), `posted user turn text: ${JSON.stringify(userTexts()[0])}`).toBe(norm(transcript));
      const reply = await nextReply();
      expect(reply.status).toBe(200);
      expect(reply.text.length, 'the agent reply sent to TTS').toBeGreaterThan(0);
      expect(reply.text).not.toBe(REPLY);
      expect(reply.body.length, 'captured TTS reply bytes').toBeGreaterThan(1_000);
      const heard = await transcribeInPage(page, reply.body);
      expect(heard.status).toBe(200);
      const sentWords = new Set(norm(reply.text).split(' ').filter((w) => w.length > 3));
      const matched = norm(heard.text).split(' ').filter((w) => sentWords.has(w));
      expect(matched.length, `reply sent to TTS: ${JSON.stringify(reply.text)}; whisper heard: ${JSON.stringify(heard.text)}`)
        .toBeGreaterThanOrEqual(Math.min(2, sentWords.size));
      expect((await events(page)).filter((e) => e.phase === 'playback')).toEqual([]);
      expect(userTexts(), `the spoken reply did not post a second user turn; all posted turn bodies: ${JSON.stringify(postedBodies)}; outcomes: ${JSON.stringify(postedOutcomes)}`)
        .toHaveLength(1);
      expect(postedTurns.length, 'every posted turn is either the one user turn or an assistant reply')
        .toBe(postedBodies.length);
    });
  });
});

/**
 * R-4 LIFECYCLE SCENARIOS (voice-final-public-release-2026-10-01 AUTO-BAR R-4):
 * output mute, voice off, and a TTS provider outage on the shipped desktop client.
 * Default (non-serial) mode so one red leg does not skip the others; the CLI runs
 * --workers=1, so they still execute one at a time against the one local Whisper.
 */
(live ? test.describe : test.describe.skip)('SYNTHETIC voice lifecycle (R-4)', () => {
  const LONG_REPLY = `${REPLY} `.repeat(6);

  test('mute: muting mid-reply stops it, a muted reply stays silent, unmuting speaks again', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      const tts = countTtsPosts(page);
      await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.reply(t), LONG_REPLY);
      await expect.poll(() => status(page), { timeout: 60_000 }).toBe('speaking');
      await page.getByRole('button', { name: 'Mute spoken voice replies' }).click();
      expect(await voice(page, (h) => h.outputMuted())).toBe(true);
      await expect.poll(() => status(page), { timeout: 2_000, message: 'mute silences the reply already playing' })
        .not.toBe('speaking');
      await page.waitForTimeout(3_000); // queued sentences must not resume it
      expect(await status(page)).not.toBe('speaking');

      const before = tts.n;
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.reply(t), REPLY);
      await page.waitForTimeout(4_000);
      expect(tts.n, 'a muted reply is not synthesized').toBe(before);
      expect((await voice(page, (h) => h.lastSilenced()))?.reason).toBe('output-muted');

      await page.getByRole('button', { name: 'Unmute spoken voice replies' }).click();
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.reply(t), REPLY);
      await expect.poll(() => status(page), { timeout: 60_000, message: 'unmuted replies speak again' }).toBe('speaking');
      expect(tts.n).toBeGreaterThan(before);
    });
  });

  test('off: turning voice off releases the microphone and stops a reply mid-playback', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      await openShell(page);
      await voice(page, (h) => h.setMode('always-on'));
      await expect.poll(() => liveMicTracks(page), { timeout: 30_000, message: 'always-on opened the microphone' })
        .toBeGreaterThan(0);
      await voice(page, (h) => h.setMode('off'));
      await expect.poll(() => liveMicTracks(page), { timeout: 3_000, message: 'voice off released every mic track' })
        .toBe(0);
      expect(await status(page)).toBe('off');

      await voice(page, (h) => h.setMode('push-to-talk'));
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), LONG_REPLY);
      await expect.poll(() => status(page), { timeout: 60_000 }).toBe('speaking');
      await voice(page, (h) => h.setMode('off'));
      await expect.poll(() => status(page), { timeout: 2_000, message: 'voice off stops the reply' }).toBe('off');
      await page.waitForTimeout(3_000);
      expect(await status(page)).toBe('off');
      expect(await liveMicTracks(page)).toBe(0);
    });
  });

  // R-4 navigation/unmount cleanup. Voice is global to the desktop shell, so an
  // in-app route change must NOT stop capture — but a remount on the new route must
  // not open a second microphone either, and voice-off must still release every
  // track afterwards. The route change goes through the SPA router (TanStack Router
  // follows popstate), never a full reload, which would destroy the document's
  // tracks itself and prove nothing about the app.
  test('navigate: moving between screens keeps one microphone, and off still releases it', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      await openShell(page);
      await voice(page, (h) => h.setMode('always-on'));
      await expect.poll(() => liveMicTracks(page), { timeout: 30_000, message: 'always-on opened the microphone' })
        .toBeGreaterThan(0);
      const opened = await liveMicTracks(page);
      // Return to the path the shell actually settled on, not the one openShell
      // requested: '/harness' is a router alias that redirects (rig run 4 measured
      // it landing on '/adv'), so asserting the literal alias fails on routing, not voice.
      const home = await page.evaluate(() => window.location.pathname);
      expect(home, 'the shell settled on a route other than the voice settings page').not.toBe('/settings/voice');
      for (const path of ['/settings/voice', home, '/settings/voice', home]) {
        await page.evaluate((p) => {
          window.history.pushState({}, '', p);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, path);
        await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe(path);
      }
      // A leaked or duplicated capture opens within milliseconds of the remount; give
      // every route's effects time to settle before counting.
      await page.waitForTimeout(3_000);
      expect(await liveMicTracks(page), 'route changes neither leaked nor duplicated the microphone').toBe(opened);
      expect((await voice(page, (h) => h.getState())).mode, 'voice stays on across in-app navigation').toBe('always-on');
      await voice(page, (h) => h.setMode('off'));
      await expect.poll(() => liveMicTracks(page), { timeout: 3_000, message: 'voice off after navigating released every mic track' })
        .toBe(0);
    });
  });

  test('tts outage: a failed synthesis says so on the same engine, and the next reply plays', async ({ page }) => {
    test.setTimeout(180_000);
    await withLocalEnginePrefs(page, async () => {
      const sent: Array<{ engine: unknown; status: number }> = [];
      let failNext = true;
      await page.route('**/api/agent-mcp/operator-tts', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const { engine } = JSON.parse(route.request().postData() ?? '{}') as { engine?: unknown };
        if (failNext) {
          failNext = false;
          sent.push({ engine, status: 503 });
          await route.fulfill({ status: 503, body: 'synthetic outage' });
          return;
        }
        const response = await route.fetch();
        sent.push({ engine, status: response.status() });
        await route.fulfill({ response });
      });
      await openShell(page);
      await voice(page, (h) => h.setMode('push-to-talk'));
      const engine = await voice(page, (h) => h.ttsEngine());
      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), REPLY);
      await expect.poll(async () => (await events(page)).find((e) => e.phase === 'playback')?.message ?? '', {
        timeout: 30_000,
      }).toMatch(/Couldn't generate speech \(.+ returned 503\) — the reply is in the chat\./);
      await expect.poll(() => status(page), { timeout: 10_000, message: 'a failed reply does not stick in speaking' })
        .not.toBe('speaking');

      await page.evaluate((t) => (window as VoiceWindow).__pcVoiceTest!.speak(t), REPLY);
      await expect.poll(() => status(page), { timeout: 60_000, message: 'the next reply plays' }).toBe('speaking');
      // 'speaking' is set before the synthesis request goes out, so wait for the
      // routed request itself rather than reading `sent` at that instant.
      await expect.poll(() => sent.map((s) => s.status), { timeout: 60_000, message: 'the next reply was synthesized' })
        .toEqual([503, 200]);
      expect(sent.map((s) => s.engine), 'no silent engine substitution').toEqual([sent[0]!.engine, sent[0]!.engine]);
      if (engine) expect(sent[0]!.engine).toBe(engine === 'browser' ? 'kokoro' : engine);
    });
  });
});
