/**
 * Voice-mode capture/runtime unit tests.
 *
 * Covers the paths that broke (and were fixed) during the WebKitGTK voice
 * debugging session and had zero coverage:
 *   - the PTT "no audio detected" failure message, including how it's
 *     tailored from the real getUserMedia error (setMicCaptureError)
 *   - audioReceiving → "processing transcript" vs. the no-audio toast
 *   - __simulateUtterance → onFinalUtterance dispatch + awaitingResponse
 *   - speak()/cancelAllSpeech queue plumbing
 *   - setVoiceMode off/always-on state
 *   - shouldSkipVoicemodeWhisperOnThisRuntime (the runtime-gating truth
 *     table behind the PTT-vs-always-on capture asymmetry)
 *
 * Browser APIs are stubbed (no jsdom in this workspace). A real
 * window event bus is installed so we can assert the 'papercusp:voiceTimeout'
 * CustomEvents the no-audio path dispatches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type TimeoutDetail = { phase: string; message: string };

beforeEach(() => {
  vi.resetModules();

  const g = globalThis as any;
  g.window = globalThis;

  // Force voice-leader into its single-tab fallback (isLeader:true, no channel).
  // Node's global BroadcastChannel delivers on the REAL event loop, outside
  // fake-timer control, and vi.resetModules() leaves prior tests' voice-leader
  // module copies alive with their channel listeners attached — an old elected
  // copy answers the fresh copy's announce with a leader heartbeat, and whether
  // it lands inside the 250ms announce window decides leader-vs-follower (a
  // follower tears the full-agent session down → load-dependent gate flake).
  // Election mechanics are covered by voice-leader.test.ts's fake channel.
  delete g.BroadcastChannel;

  // Real, minimal event bus — voice-mode dispatches CustomEvents we assert.
  const listeners = new Map<string, Set<(e: any) => void>>();
  g.addEventListener = (type: string, cb: (e: any) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  };
  g.removeEventListener = (type: string, cb: (e: any) => void) => {
    listeners.get(type)?.delete(cb);
  };
  g.dispatchEvent = (ev: any) => {
    listeners.get(ev.type)?.forEach((cb) => cb(ev));
    return true;
  };
  if (typeof g.Event === 'undefined') {
    g.Event = class { type: string; constructor(type: string) { this.type = type; } };
  }
  if (typeof g.CustomEvent === 'undefined') {
    g.CustomEvent = class {
      type: string; detail: any;
      constructor(type: string, init?: { detail?: any }) { this.type = type; this.detail = init?.detail; }
    };
  }

  // Network is never reachable in unit tests — make fetch reject cleanly so
  // the async capture machinery falls through instead of throwing.
  g.fetch = vi.fn(() => Promise.reject(new Error('no network in test')));

  g.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };

  g.SpeechRecognition = class {
    onresult: any = null; onend: any = null; onerror: any = null;
    continuous = false; interimResults = false; lang = 'en-US';
    start() {} stop() {}
  };
  g.window.speechSynthesis = {
    getVoices: () => [{ name: 'Alice', lang: 'en-US' }, { name: 'Bob', lang: 'en-US' }],
    speak: vi.fn(),
    cancel: vi.fn(),
    onvoiceschanged: undefined,
  };
  g.SpeechSynthesisUtterance = class {
    rate = 1; voice: any = null; onend: any = null; onerror: any = null;
    constructor(public text: string) {}
  };

  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  const sess = new Map<string, string>();
  g.sessionStorage = {
    getItem: (k: string) => sess.get(k) ?? null,
    setItem: (k: string, v: string) => void sess.set(k, v),
    removeItem: (k: string) => void sess.delete(k),
    clear: () => sess.clear(),
  };
});

/** Capture every papercusp:voiceTimeout detail dispatched during `fn`. */
function captureTimeouts(fn: () => void): TimeoutDetail[] {
  const events: TimeoutDetail[] = [];
  const handler = (e: any) => events.push(e.detail);
  (globalThis as any).addEventListener('papercusp:voiceTimeout', handler);
  try { fn(); } finally { (globalThis as any).removeEventListener('papercusp:voiceTimeout', handler); }
  return events;
}

async function loadVoiceMode() {
  const mod = await import('./voice-mode');
  mod.initVoiceMode();
  return mod;
}

describe('stopPushToTalk — "no audio" failure messaging', () => {
  it('dispatches a no-audio voiceTimeout with the generic message when no audio + no error', async () => {
    const mod = await loadVoiceMode();
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe('no-audio');
    expect(events[0].message).toContain('No audio detected');
    expect(events[0].message).toContain('check your microphone');
  });

  it('reports a blocked-permission message when getUserMedia failed with NotAllowedError', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotAllowedError', message: 'Permission denied' });
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].phase).toBe('no-audio');
    expect(events[0].message).toContain('Microphone access is blocked');
  });

  it('reports an unavailable-device message (with the error name) for NotReadableError', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotReadableError', message: 'Device in use' });
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].message).toContain('Microphone unavailable');
    expect(events[0].message).toContain('NotReadableError');
  });

  it('clears a stale error when passed null, falling back to the generic message', async () => {
    const mod = await loadVoiceMode();
    mod.setMicCaptureError({ name: 'NotAllowedError', message: 'x' });
    mod.setMicCaptureError(null);
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events[0].message).toContain('No audio detected');
    expect(events[0].message).not.toContain('blocked');
  });

  it('does NOT fire no-audio when audio was received — it enters processing instead', async () => {
    const mod = await loadVoiceMode();
    mod.setAudioReceiving(true);
    const events = captureTimeouts(() => mod.stopPushToTalk());
    expect(events).toHaveLength(0);
    expect(mod.getVoiceState().processingTranscript).toBe(true);
    // stopPushToTalk resets the receiving flag once the hold ends.
    expect(mod.getVoiceState().audioReceiving).toBe(false);
  });
});

describe('setAudioReceiving', () => {
  it('writes the flag and is idempotent', async () => {
    const mod = await loadVoiceMode();
    expect(mod.getVoiceState().audioReceiving).toBe(false);
    mod.setAudioReceiving(true);
    expect(mod.getVoiceState().audioReceiving).toBe(true);
    mod.setAudioReceiving(true); // no-op, no throw
    expect(mod.getVoiceState().audioReceiving).toBe(true);
  });
});

describe('utterance dispatch', () => {
  it('__simulateUtterance notifies onFinalUtterance listeners and arms awaitingResponse', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    mod.__simulateUtterance('hello world');
    unsub();
    expect(got).toEqual(['hello world']);
    expect(mod.getVoiceState().lastTranscript).toBe('hello world');
    expect(mod.getVoiceState().awaitingResponse).toBe(true);
  });

  it('unsubscribed listeners stop receiving utterances', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    unsub();
    mod.__simulateUtterance('ignored');
    expect(got).toEqual([]);
  });
});

describe('canonical Papercup local voice-turn events (P-003)', () => {
  function captureCanonical(): { events: any[]; stop: () => void } {
    const events: any[] = [];
    const handler = (event: any) => events.push(event.detail);
    (globalThis as any).addEventListener('papercusp:voiceTurnEvent', handler);
    return {
      events,
      stop: () => (globalThis as any).removeEventListener('papercusp:voiceTurnEvent', handler),
    };
  }

  it('emits transcript, ack, substantive sentence, and measured completion without changing the TTS path', async () => {
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceMode('push-to-talk');
    const captured = captureCanonical();
    try {
      mod.__simulateUtterance('  what   is next?  ', 'localWhisper');
      mod.speak('On it.', 'system:operator', 'polite', { preserveAwaitingResponse: true });
      mod.speak('Here is the answer.', 'system:operator', 'polite');

      expect(captured.events.map((event) => event.type)).toEqual([
        'transcript.final', 'assistant.sentence', 'assistant.sentence', 'completed',
      ]);
      expect(captured.events[0]).toMatchObject({ text: 'what is next?', sequence: 0 });
      expect(captured.events[1]).toMatchObject({ text: 'On it.', sentenceIndex: 0, sequence: 1 });
      expect(captured.events[2]).toMatchObject({
        text: 'Here is the answer.', sentenceIndex: 1, sequence: 2,
      });
      expect(captured.events[3]).toMatchObject({
        type: 'completed', sequence: 3,
        metrics: { executor: 'papercup-local', latencyClass: 'interactive' },
      });
      expect(captured.events.every((event) => event.turnId === captured.events[0].turnId)).toBe(true);
      expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    } finally {
      captured.stop();
      mod.setVoiceMode('off');
    }
  });

  it('emits a canonical user interruption on local barge-in', async () => {
    const mod = await loadVoiceMode();
    const captured = captureCanonical();
    try {
      mod.__simulateUtterance('first question', 'localWhisper');
      mod.cancelAllSpeech();
      expect(captured.events.map((event) => event.type)).toEqual(['transcript.final', 'interruption']);
      expect(captured.events[1]).toMatchObject({ reason: 'user', sequence: 1 });
    } finally {
      captured.stop();
    }
  });

  // WI-10006893: a reply silenced by output mute is still the turn's answer. It
  // must complete the canonical turn, so the NEXT utterance does not record the
  // previous turn as interrupted.
  it('completes the turn when its reply is muted, so the next turn records no interruption', async () => {
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceMode('push-to-talk');
    mod.setVoiceOutputMuted(true);
    const captured = captureCanonical();
    try {
      mod.__simulateUtterance('muted question', 'localWhisper');
      mod.speak('Muted answer.', 'system:operator', 'polite');
      expect((globalThis as any).window.speechSynthesis.speak, 'a muted reply stays silent').not.toHaveBeenCalled();
      expect(captured.events.map((event) => event.type)).toEqual([
        'transcript.final', 'assistant.sentence', 'completed',
      ]);
      mod.__simulateUtterance('next question', 'localWhisper');
      expect(captured.events.map((event) => event.type)).not.toContain('interruption');
    } finally {
      captured.stop();
      mod.setVoiceOutputMuted(false);
      mod.setVoiceMode('off');
    }
  });

  it('does not duplicate hosted provider events in the browser adapter', async () => {
    const mod = await loadVoiceMode();
    const captured = captureCanonical();
    try {
      mod.__simulateUtterance('hosted transcript', 'providerSTT');
      expect(captured.events).toEqual([]);
    } finally {
      captured.stop();
    }
  });
});

describe('response timeout', () => {
  it('speaks an audible failure notice as well as dispatching the visual timeout', async () => {
    vi.useFakeTimers();
    try {
      const prefs = await import('./voice-prefs-client');
      prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
      const mod = await loadVoiceMode();
      mod.setVoiceMode('push-to-talk');

      const events: TimeoutDetail[] = [];
      const handler = (e: any) => events.push(e.detail);
      (globalThis as any).addEventListener('papercusp:voiceTimeout', handler);
      try {
        mod.__simulateUtterance('what is the release status');
        expect(mod.getVoiceState().awaitingResponse).toBe(true);

        vi.advanceTimersByTime(mod.RESPONSE_WINDOW_MS);

        expect(mod.getVoiceState().awaitingResponse).toBe(false);
        expect(events).toContainEqual(expect.objectContaining({ phase: 'response' }));
        const synth = (globalThis as any).window.speechSynthesis.speak;
        expect(synth).toHaveBeenCalledTimes(1);
        expect(synth.mock.calls[0][0].text).toBe(mod.RESPONSE_TIMEOUT_SPOKEN_NOTICE);
        expect(mod.getVoiceState().status).toBe('speaking');
      } finally {
        (globalThis as any).removeEventListener('papercusp:voiceTimeout', handler);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows the timeout notice through while a full-agent realtime session is attached', async () => {
    vi.useFakeTimers();
    const g = globalThis as any;
    g.RTCPeerConnection = class {};
    g.window.__PAPERCUSP_DEV_WRAPPER__ = true;
    const runtime = {
      stop: vi.fn(async () => {}),
      control: vi.fn(),
      setDeafened: vi.fn(),
      isDeafened: vi.fn(() => false),
      isElected: vi.fn(() => true),
    };
    vi.doMock('./operator-voice-runtime', () => ({
      startDesktopOperatorVoice: vi.fn(async (options: any) => {
        options.onState({ status: 'idle', muted: false, mode: 'always-on' });
        return runtime;
      }),
    }));
    // ElevenLabs full-agent is outside the voice-final-public-release-2026-10-01#D-005
    // scope and refused at activation. Re-admit only it here so this dormant
    // session path stays covered for when the engine returns with acceptance.
    vi.doMock('@papercusp/operator-core/lib/voice-release-availability', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/operator-core/lib/voice-release-availability')>()),
      isFullAgentEngineUnavailable: (engine: unknown) => engine === 'gemini-live',
    }));

    try {
      const prefs = await import('./voice-prefs-client');
      prefs.setVoicePrefsClient({
        ...prefs.loadVoicePrefsClient(),
        ttsEngine: 'browser',
        fullAgentEngine: 'elevenlabs-conv',
        voicePrivacyMode: 'always-on',
      });
      const mod = await loadVoiceMode();
      mod.setVoiceMode('always-on');
      // Let the single-tab voice-leader election settle. A follower must stay
      // silent; this test exercises the elected full-agent tab. Even with the
      // single-tab fallback forced (BroadcastChannel deleted in beforeEach —
      // the root cause of the 2026-07-17 gate flake, see there), the attach
      // path still crosses real async a fixed fake-time hop can assert past
      // under CPU contention. vi.waitFor advances the fake clock per probe AND
      // yields the event loop, so probe until attached instead of hopping 300ms.
      await vi.waitFor(
        () => {
          expect(mod.getOperatorVoiceSessionUiState().active).toBe(true);
        },
        { timeout: 5000, interval: 50 },
      );
      expect(mod.getVoiceState().mode).toBe('always-on');
      expect(mod.isVoiceOutputMuted()).toBe(false);

      mod.speak(mod.RESPONSE_TIMEOUT_SPOKEN_NOTICE, 'system:operator', 'assertive', {
        allowDuringRealtime: true,
      });
      expect(g.window.__pcVoiceTest.lastSpoken().text).toBe(mod.RESPONSE_TIMEOUT_SPOKEN_NOTICE);

      const synth = g.window.speechSynthesis.speak;
      expect(synth).toHaveBeenCalledTimes(1);
      expect(synth.mock.calls[0][0].text).toBe(mod.RESPONSE_TIMEOUT_SPOKEN_NOTICE);
      mod.setVoiceMode('off');
    } finally {
      delete g.RTCPeerConnection;
      delete g.window.__PAPERCUSP_DEV_WRAPPER__;
      delete g.window.__pcVoiceTest;
      vi.doUnmock('./operator-voice-runtime');
      vi.useRealTimers();
    }
  });

  it('keeps the real-response deadline armed after an instant acknowledgement', async () => {
    vi.useFakeTimers();
    try {
      const prefs = await import('./voice-prefs-client');
      prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
      const mod = await loadVoiceMode();
      mod.setVoiceMode('push-to-talk');

      mod.__simulateUtterance('what is happening');
      mod.speak('On it.', 'system:operator', 'polite', {
        preserveAwaitingResponse: true,
      });
      expect(mod.getVoiceState().awaitingResponse).toBe(true);

      const synth = (globalThis as any).window.speechSynthesis.speak;
      const ack = synth.mock.calls[0][0] as { onend?: () => void };
      ack.onend?.();
      expect(mod.getVoiceState().awaitingResponse).toBe(true);

      vi.advanceTimersByTime(mod.RESPONSE_WINDOW_MS);
      expect(mod.getVoiceState().awaitingResponse).toBe(false);
      expect(synth).toHaveBeenCalledTimes(2);
      expect(synth.mock.calls[1][0].text).toBe(mod.RESPONSE_TIMEOUT_SPOKEN_NOTICE);
    } finally {
      vi.useRealTimers();
    }
  });
});

// voice-convergence-additive-wins-2026-07-10 P-001: both transport paths relay
// the transcript into the pane through ONE uniform, source-tagged seam. The
// tag is additive — a legacy 1-arg listener is unaffected — so this is a pure
// observability win with no dispatch change.
describe('transcriptSource seam (P-001)', () => {
  it('tags local-engine utterances localWhisper (the default arm)', async () => {
    const mod = await loadVoiceMode();
    const got: Array<[string, string | undefined]> = [];
    const unsub = mod.onFinalUtterance((t, src) => got.push([t, src]));
    mod.__simulateUtterance('what is the build status');
    unsub();
    expect(got).toEqual([['what is the build status', 'localWhisper']]);
  });

  it('tags provider-engine utterances providerSTT through the same seam', async () => {
    const mod = await loadVoiceMode();
    const got: Array<[string, string | undefined]> = [];
    const unsub = mod.onFinalUtterance((t, src) => got.push([t, src]));
    mod.__simulateUtterance('deploy the operator', 'providerSTT');
    unsub();
    expect(got).toEqual([['deploy the operator', 'providerSTT']]);
  });

  it('is backward-compatible: a 1-arg listener still receives the text', async () => {
    const mod = await loadVoiceMode();
    const got: string[] = [];
    const unsub = mod.onFinalUtterance((t) => got.push(t));
    mod.__simulateUtterance('legacy listener', 'providerSTT');
    unsub();
    expect(got).toEqual(['legacy listener']);
  });

  it('delivers the tag to every subscribed listener', async () => {
    const mod = await loadVoiceMode();
    const a: Array<string | undefined> = [];
    const b: Array<string | undefined> = [];
    const unsubA = mod.onFinalUtterance((_t, src) => a.push(src));
    const unsubB = mod.onFinalUtterance((_t, src) => b.push(src));
    mod.__simulateUtterance('fan out', 'localWhisper');
    unsubA();
    unsubB();
    expect(a).toEqual(['localWhisper']);
    expect(b).toEqual(['localWhisper']);
  });
});

describe('speak / cancelAllSpeech queue', () => {
  it('force-speaks through the browser engine and cancelAllSpeech stops it', async () => {
    // Voice prefs hydrate through the shared sync bridge and default to Kokoro
    // (WI-4873: cold cache resolves the engine synchronously; only an EXPLICIT
    // 'browser' pref uses Web Speech). Pin the browser engine to exercise the
    // speechSynthesis path this test asserts.
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.speak('hello there', 'system:operator', 'polite', { force: true });
    expect((globalThis as any).window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    mod.cancelAllSpeech();
    expect((globalThis as any).window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  // R-4 output mute (voice-final-public-release-2026-10-01, WI-10004760): the
  // voice-bar mute must silence the reply that is ALREADY playing and drop its
  // queued sentences, not only gate the next reply — and it must not interrupt
  // the voice turn itself (the answer still lands in the chat).
  it('muting output stops the reply already playing and drops its queued sentences', async () => {
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceOutputMuted(false);
    mod.setVoiceMode('push-to-talk');
    const synth = (globalThis as any).window.speechSynthesis;
    const turnEvents: string[] = [];
    (globalThis as any).window.addEventListener?.('papercusp:voiceTurnEvent', (e: Event) => {
      turnEvents.push(String((e as CustomEvent<{ type?: string }>).detail?.type));
    });
    mod.speak('first sentence', 'system:operator');
    mod.speak('second sentence', 'system:operator');
    expect(synth.speak).toHaveBeenCalledTimes(1);
    synth.cancel.mockClear();

    mod.setVoiceOutputMuted(true);
    expect(synth.cancel, 'mute cancels the audible reply').toHaveBeenCalled();
    // The engine reports the cancelled utterance as ended; the queue must be empty.
    const first = synth.speak.mock.calls[0]?.[0] as { onend?: () => void } | undefined;
    first?.onend?.();
    expect(synth.speak, 'the queued second sentence never starts').toHaveBeenCalledTimes(1);
    expect(turnEvents.filter((t) => /interrupt/i.test(t)), 'mute is not a barge-in').toEqual([]);
    mod.setVoiceOutputMuted(false);
  });

  it('does not speak when voice mode is off and force is not set', async () => {
    const mod = await loadVoiceMode();
    mod.speak('quiet', 'system:operator'); // mode off, no force → gated out
    expect((globalThis as any).window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  // WI-5174: every silent gate in speak() now leaves a breadcrumb readable via
  // the dev test seam, so "reply was correct but never spoken" is diagnosable
  // instead of a dead end. Covers the two gates reachable without a real
  // BroadcastChannel/leader/realtime setup; not-leader-tab and
  // realtime-session-active share the exact same silenceSpeak() call path.
  it('records WHY speak() was silenced (WI-5174 diagnostic seam)', async () => {
    const g = globalThis as any;
    g.window.__PAPERCUSP_DEV_WRAPPER__ = true;
    try {
      const mod = await loadVoiceMode();
      mod.speak('quiet', 'system:operator'); // mode off, no force → gated out
      expect(g.window.__pcVoiceTest.lastSilenced()).toMatchObject({
        reason: 'voice-mode-off',
        text: 'quiet',
      });

      mod.setVoiceMode('always-on');
      mod.setVoiceOutputMuted(true);
      mod.speak('still quiet', 'system:operator');
      expect(g.window.__pcVoiceTest.lastSilenced()).toMatchObject({
        reason: 'output-muted',
        text: 'still quiet',
      });
      mod.setVoiceOutputMuted(false);
      mod.setVoiceMode('off');
    } finally {
      delete g.window.__PAPERCUSP_DEV_WRAPPER__;
      delete g.window.__pcVoiceTest;
    }
  });
});

describe('setVoiceMode', () => {
  it('rejects stored Gemini Live with a clear error and no provider or local capture', async () => {
    const toastError = vi.fn();
    const startLocalCapture = vi.fn();
    const startProvider = vi.fn();
    vi.doMock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError }) }));
    vi.doMock('./energy-vad-capture', () => ({ startEnergyVadCapture: startLocalCapture }));
    vi.doMock('./operator-voice-runtime', () => ({ startDesktopOperatorVoice: startProvider }));
    try {
      const prefs = await import('./voice-prefs-client');
      prefs.setVoicePrefsClient({
        ...prefs.loadVoicePrefsClient(),
        fullAgentEngine: 'gemini-live',
        sttEngine: 'webspeech',
        voicePrivacyMode: 'wake-word-gated',
      });
      const mod = await loadVoiceMode();
      mod.setVoiceMode('always-on');
      await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining('Gemini Live is not available in this release'), expect.anything(),
      ));
      expect(mod.getVoiceState()).toMatchObject({ mode: 'off', status: 'off', micOwnedByFullAgent: false });
      expect(prefs.loadVoicePrefsClient().fullAgentEngine).toBe('gemini-live');
      expect(startProvider).not.toHaveBeenCalled();
      expect(startLocalCapture).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('sonner');
      vi.doUnmock('./energy-vad-capture');
      vi.doUnmock('./operator-voice-runtime');
    }
  });

  it('off clears mode + status', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    expect(mod.getVoiceState().mode).toBe('always-on');
    mod.setVoiceMode('off');
    expect(mod.getVoiceState().mode).toBe('off');
    expect(mod.getVoiceState().status).toBe('off');
  });

  it('push-to-talk goes straight to idle — never the stuck "connecting" state', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('push-to-talk');
    expect(mod.getVoiceState().mode).toBe('push-to-talk');
    // PTT has no session to connect to — it must be ready immediately so the
    // button shows "PUSH TT", not a permanent "Connecting…".
    expect(mod.getVoiceState().status).toBe('idle');
    expect(mod.getVoiceState().micOwnedByFullAgent).toBe(false);
  });

  it('always-on enters the optimistic connecting state on toggle', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    // Synchronously optimistic (a watchdog + non-leader/no-engine resets
    // guarantee it resolves; here fetch is mocked-rejecting so it would fall
    // back asynchronously).
    expect(mod.getVoiceState().status).toBe('connecting');
    expect(mod.getVoiceState().micOwnedByFullAgent).toBe(true);
  });
});

describe('shouldSkipVoicemodeWhisperOnThisRuntime', () => {
  // The predicate now detects the REAL capability the Silero always-on path needs —
  // onnxruntime-web THREADED wasm → SharedArrayBuffer — instead of the old
  // UA/crossOriginIsolated proxy. WI-4498 proved that proxy wrong on WebKitGTK: the
  // desktop webview exposes SAB via the JSC_useSharedArrayBuffer runtime flag while
  // crossOriginIsolated stays false. UA / Tauri / COI are now irrelevant; only SAB
  // presence decides skip (energy-VAD) vs. run (Silero).
  const g = globalThis as any;
  const ORIG_SAB = g.SharedArrayBuffer;
  const HAD_SAB = 'SharedArrayBuffer' in g;

  function setSab(present: boolean) {
    g.window = g.window ?? {};
    if (present) g.SharedArrayBuffer = ORIG_SAB ?? (function SharedArrayBuffer() {} as unknown);
    else delete g.SharedArrayBuffer;
  }
  function restoreSab() {
    if (HAD_SAB) g.SharedArrayBuffer = ORIG_SAB;
    else delete g.SharedArrayBuffer;
  }

  it('returns true when SharedArrayBuffer is unavailable (no threaded ort → energy-VAD fallback)', async () => {
    const mod = await import('./voice-mode');
    setSab(false);
    try {
      expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(true);
    } finally {
      restoreSab();
    }
  });

  it('returns false when SharedArrayBuffer is available (Silero threading works)', async () => {
    const mod = await import('./voice-mode');
    setSab(true);
    try {
      expect(mod.shouldSkipVoicemodeWhisperOnThisRuntime()).toBe(false);
    } finally {
      restoreSab();
    }
  });
});

// P-011 (voice-production-test-coverage): barge-in. cancelAllSpeech() is the
// interruption primitive (wired to wake/utterance via activateListening, and
// to mode-off). The existing speak/cancel test only checks cancel() fired;
// these cover the user-facing semantics — return-to-idle, queue-clear (no
// overlap), mode-off stop, and clean resume.
describe('barge-in (TTS interruption)', () => {
  const synth = () => (globalThis as unknown as { window: { speechSynthesis: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } } }).window.speechSynthesis;

  it('cancel while speaking returns to idle and clears the speaking role', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('a long operator utterance', 'system:operator', 'polite', { force: true });
    expect(mod.getVoiceState().status).toBe('speaking');
    expect(mod.getVoiceState().speakingRole).toBe('system:operator');
    mod.cancelAllSpeech();
    expect(synth().cancel).toHaveBeenCalled();
    expect(mod.getVoiceState().status).toBe('idle');
    expect(mod.getVoiceState().speakingRole).toBeNull();
  });

  it('clears the queue so a pending utterance never plays (no overlap)', async () => {
    // Pin the browser engine — prefs default to Kokoro post-WI-4873, and this
    // test observes the speechSynthesis queue directly (see the note on
    // "a fresh utterance speaks again after a barge-in").
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('first', 'system:operator', 'polite', { force: true }); // plays now
    mod.speak('second', 'system:operator', 'polite', { force: true }); // queued behind first
    expect(synth().speak).toHaveBeenCalledTimes(1);
    const firstUtt = synth().speak.mock.calls[0][0] as { onend?: () => void };
    mod.cancelAllSpeech(); // barge-in clears the queue
    // the first utterance "ending" must NOT pull the (cleared) second off the queue
    firstUtt.onend?.();
    expect(synth().speak).toHaveBeenCalledTimes(1);
    expect(mod.getVoiceState().status).toBe('idle');
  });

  it('turning voice mode off stops in-progress speech', async () => {
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('mid-sentence', 'system:operator', 'polite', { force: true });
    synth().cancel.mockClear();
    mod.setVoiceMode('off');
    expect(synth().cancel).toHaveBeenCalled();
    expect(mod.getVoiceState().status).toBe('off');
  });

  it('a fresh utterance speaks again after a barge-in (capture resumes)', async () => {
    // This assertion observes the browser SpeechSynthesis adapter directly.
    // Voice prefs now hydrate through the shared sync bridge and default to
    // Kokoro, so pin the browser engine explicitly instead of relying on the
    // old fetch-cache's first-call fallback.
    const prefs = await import('./voice-prefs-client');
    prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'browser' });
    const mod = await loadVoiceMode();
    mod.setVoiceMode('always-on');
    mod.speak('first', 'system:operator', 'polite', { force: true });
    mod.cancelAllSpeech();
    mod.speak('second after barge-in', 'system:operator', 'polite', { force: true });
    expect(synth().speak).toHaveBeenCalledTimes(2);
    expect(mod.getVoiceState().status).toBe('speaking');
  });
});
