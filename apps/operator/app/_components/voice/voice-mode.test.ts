/**
 * Voice-mode logic unit tests. Browser APIs are stubbed; we test the
 * state transitions and voice assignment hash-stability.
 */

// Node environment with manual window stubs (jsdom not installed in this workspace).
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  // Stub Web Speech APIs.
  (globalThis as any).window = globalThis;
  // initVoiceMode registers pagehide/beforeunload + visibilitychange/
  // focus/blur listeners. Without these stubs the test environment
  // throws "window.addEventListener is not a function" at module-eval
  // time on every test in this file.
  if (!(globalThis as any).addEventListener) {
    (globalThis as any).addEventListener = () => {};
    (globalThis as any).removeEventListener = () => {};
  }
  if (!(globalThis as any).document) {
    (globalThis as any).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
    };
  }
  if (!(globalThis as any).sessionStorage) {
    (globalThis as any).sessionStorage = {
      _s: new Map<string, string>(),
      getItem(k: string) { return (this._s as any).get(k) ?? null; },
      setItem(k: string, v: string) { (this._s as any).set(k, v); },
      removeItem(k: string) { (this._s as any).delete(k); },
      clear() { (this._s as any).clear(); },
    };
  }
  (globalThis as any).SpeechRecognition = class {
    onresult: any = null;
    onend: any = null;
    onerror: any = null;
    continuous = false;
    interimResults = false;
    lang = 'en-US';
    start() {}
    stop() {}
  };
  (globalThis as any).window.speechSynthesis = {
    getVoices: () =>
      [
        { name: 'Alice', lang: 'en-US' },
        { name: 'Bob', lang: 'en-US' },
        { name: 'Carol', lang: 'en-GB' },
      ] as any,
    speak: vi.fn(),
    cancel: vi.fn(),
    onvoiceschanged: undefined,
  };
  (globalThis as any).SpeechSynthesisUtterance = class {
    rate = 1;
    voice: any = null;
    onend: any = null;
    onerror: any = null;
    constructor(public text: string) {}
  };
  (globalThis as any).localStorage = {
    _store: new Map<string, string>(),
    getItem(k: string) {
      return (this._store as any).get(k) ?? null;
    },
    setItem(k: string, v: string) {
      (this._store as any).set(k, v);
    },
    removeItem(k: string) {
      (this._store as any).delete(k);
    },
    clear() {
      (this._store as any).clear();
    },
  };
});

describe('output-only original reading', () => {
  async function fixture(run: (mod: typeof import('./voice-mode'), audio: Array<{ currentTime: number; playbackRate: number; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; onended: (() => void) | null }>, setFetch: (impl: () => Promise<Response>) => void) => Promise<void>) {
    const mod = await import('./voice-mode');
    const prefs = await import('./voice-prefs-client');
    const leader = await import('./voice-leader');
    const leaderSpy = vi.spyOn(leader, 'getVoiceLeaderState').mockReturnValue({ ...leader.getVoiceLeaderState(), available: true, isLeader: true });
    const previous = prefs.loadVoicePrefsClient();
    const configBefore = mod.getVoiceConfig();
    prefs.setVoicePrefsClient({ ...previous, ttsEngine: 'kokoro' });
    mod.stopReading(); mod.setVoiceOutputMuted(false);
    const audios: Array<{ currentTime: number; playbackRate: number; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
    const originalFetch = globalThis.fetch;
    const originalAudio = globalThis.Audio;
    const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
    globalThis.Audio = class {
      currentTime = 0; playbackRate = 1; onended = null; onerror = null;
      play = vi.fn(async () => {}); pause = vi.fn();
      constructor() { audios.push(this); }
    } as unknown as typeof Audio;
    URL.createObjectURL = vi.fn(() => 'blob:reading'); URL.revokeObjectURL = vi.fn();
    const records = [
      { ok: true, type: 'chunk', text: 'FIRST', start: 0, end: 5, audioBase64: 'AQ==', contentType: 'audio/wav' },
      { ok: true, type: 'chunk', text: 'TAIL', start: 5, end: 9, audioBase64: 'Ag==', contentType: 'audio/wav' },
      { ok: true, type: 'completed', chunks: 2 },
    ];
    globalThis.fetch = vi.fn(async () => new Response(records.map(record => JSON.stringify(record)).join('\n') + '\n'));
    try { await run(mod, audios, impl => { globalThis.fetch = vi.fn(impl); }); }
    finally { mod.stopReading(); mod.updateVoiceConfig(configBefore); leaderSpy.mockRestore(); prefs.setVoicePrefsClient(previous); globalThis.fetch = originalFetch; globalThis.Audio = originalAudio; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
  }

  it('pauses/resumes the same audio position, then plays the tail once with voice mode off', async () => {
    await fixture(async (mod, audio) => {
      const before = mod.getVoiceState().mode;
      mod.updateVoiceConfig({ rate: 1.35 });
      const started = mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      expect(audio[0].playbackRate).toBe(1.35);
      audio[0].currentTime = 3;
      mod.controlReading(started.readingId!, 'pause');
      expect(mod.getReadingState().status).toBe('paused');
      expect(audio[0].pause).toHaveBeenCalledTimes(1);
      expect(audio).toHaveLength(1);
      // Subscription cleanup can run when React disconnects a hidden bridge.
      mod.cancelAllSpeech({ preserveReading: true });
      expect(mod.getReadingState().status).toBe('paused');
      expect(audio[0].pause).toHaveBeenCalledTimes(1);
      mod.controlReading(started.readingId!, 'resume');
      expect(audio[0].currentTime).toBe(3);
      expect(audio[0].play).toHaveBeenCalledTimes(2);
      audio[0].onended!();
      await vi.waitFor(() => expect(audio).toHaveLength(2));
      expect(mod.getReadingState().position).toBe(5);
      audio[1].onended!();
      await vi.waitFor(() => expect(mod.getReadingState().status).toBe('completed'));
      expect(mod.getReadingState().position).toBe(9);
      expect(mod.getVoiceState().mode).toBe(before);
    });
  });

  it('keeps narration output-only without asking for a microphone', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [] }));
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
    try {
      await fixture(async (mod, audio) => {
        const mode = mod.getVoiceState().mode;
        const started = mod.startReading('FIRSTTAIL');
        await vi.waitFor(() => expect(audio).toHaveLength(1));
        mod.controlReading(started.readingId!, 'pause');
        mod.controlReading(started.readingId!, 'resume');
        mod.controlReading(started.readingId!, 'stop');
        expect(getUserMedia).not.toHaveBeenCalled();
        expect(mod.getVoiceState().mode).toBe(mode);
      });
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  });

  it('stop discards subsequent audio and stale controls cannot stop a newer reading', async () => {
    await fixture(async (mod, audio) => {
      const first = mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      mod.controlReading(first.readingId!, 'stop');
      await Promise.resolve();
      expect(mod.getReadingState().status).toBe('stopped');
      expect(audio).toHaveLength(1);
      const second = mod.startReading('FIRSTTAIL');
      expect(() => mod.controlReading(first.readingId!, 'stop')).toThrow('no longer active');
      expect(mod.getReadingState().readingId).toBe(second.readingId);
    });
  });

  it('keeps a paused provider response silent and starts its audio exactly once on resume', async () => {
    await fixture(async (mod, audio, setFetch) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      setFetch(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } })));
      const started = mod.startReading('FIRSTTAIL');
      await new Promise(done => setTimeout(done, 0));
      mod.controlReading(started.readingId!, 'pause');
      stream.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, type: 'chunk', text: 'FIRST', start: 0, end: 5, audioBase64: 'AQ==', contentType: 'audio/wav' }) + '\n'));
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      expect(audio[0].play).not.toHaveBeenCalled();
      expect(mod.getReadingState().status).toBe('paused');
      mod.controlReading(started.readingId!, 'resume');
      await vi.waitFor(() => expect(audio[0].onended).toBeTypeOf('function'));
      expect(audio[0].play).toHaveBeenCalledTimes(1);
      expect(mod.getReadingState().position).toBe(0);
    });
  });

  it('ignores a delayed resume playback failure from a replaced reading', async () => {
    await fixture(async (mod, audio) => {
      const first = mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      let reject!: (error: Error) => void;
      audio[0].play.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
      mod.controlReading(first.readingId!, 'pause');
      mod.controlReading(first.readingId!, 'resume');
      mod.stopReading();
      const second = mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(2));
      reject(new Error('Obsolete output failed'));
      await new Promise(done => setTimeout(done, 0));
      expect(mod.getReadingState()).toMatchObject({ readingId: second.readingId, status: 'playing', position: 0 });
      expect(audio[1].pause).not.toHaveBeenCalled();
    });
  });

  it('reports a truncated stream after its played prefix without marking the source completed', async () => {
    await fixture(async (mod, audio, setFetch) => {
      setFetch(async () => new Response(JSON.stringify({ ok: true, type: 'chunk', text: 'FIRST', start: 0, end: 5, audioBase64: 'AQ==', contentType: 'audio/wav' }) + '\n'));
      mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      audio[0].onended!();
      await vi.waitFor(() => expect(mod.getReadingState().status).toBe('error'));
      expect(mod.getReadingState()).toMatchObject({ position: 5, total: 9, error: 'Reading ended before the source was complete.' });
      expect(audio).toHaveLength(1);
    });
  });

  it('stops a pending provider response before late audio can become audible', async () => {
    await fixture(async (mod, audio, setFetch) => {
      let resolve!: (response: Response) => void;
      setFetch(() => new Promise<Response>(done => { resolve = done; }));
      mod.startReading('FIRSTTAIL');
      mod.stopReading();
      resolve(new Response(JSON.stringify({ ok: true, type: 'chunk', text: 'FIRST', start: 0, end: 5, audioBase64: 'AQ==', contentType: 'audio/wav' }) + '\n'));
      await new Promise(done => setTimeout(done, 0));
      expect(audio).toHaveLength(0);
      expect(mod.getReadingState().status).toBe('stopped');
    });
  });

  it('global speech cancellation aborts a pending reading and rejects its late provider response', async () => {
    await fixture(async (mod, audio, setFetch) => {
      let resolve!: (response: Response) => void;
      setFetch(() => new Promise<Response>(done => { resolve = done; }));
      const started = mod.startReading('FIRSTTAIL');
      const request = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const signal = request[1]!.signal as AbortSignal;
      mod.cancelAllSpeech();
      expect(signal.aborted).toBe(true);
      expect(mod.getReadingState()).toMatchObject({ readingId: started.readingId, status: 'stopped', position: 0 });
      resolve(new Response(JSON.stringify({ ok: true, type: 'chunk', text: 'FIRST', start: 0, end: 5, audioBase64: 'AQ==', contentType: 'audio/wav' }) + '\n'));
      await new Promise(done => setTimeout(done, 0));
      expect(audio).toHaveLength(0);
      expect(mod.getReadingState()).toMatchObject({ status: 'stopped', position: 0 });
    });
  });

  it('global speech cancellation pauses current reading audio and prevents its queued tail', async () => {
    await fixture(async (mod, audio) => {
      mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      const finishFirst = audio[0].onended!;
      mod.cancelAllSpeech();
      expect(audio[0].pause).toHaveBeenCalled();
      finishFirst();
      await new Promise(done => setTimeout(done, 0));
      expect(audio).toHaveLength(1);
      expect(mod.getReadingState()).toMatchObject({ status: 'stopped', position: 0, total: 9 });
    });
  });

  it('output mute stops an active reading and rejects a new reading', async () => {
    await fixture(async (mod, audio) => {
      mod.startReading('FIRSTTAIL');
      await vi.waitFor(() => expect(audio).toHaveLength(1));
      mod.setVoiceOutputMuted(true);
      expect(mod.getReadingState().status).toBe('stopped');
      expect(() => mod.startReading('FIRSTTAIL')).toThrow('muted');
      mod.setVoiceOutputMuted(false);
    });
  });
});

describe('voice-mode', () => {
  it('initializes with off state', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    const s = mod.getVoiceState();
    expect(s.mode).toBe('off');
    expect(s.supported).toBe(true);
  });

  it('does not restore a persisted microphone mode in isolated Tauri verification', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const previousMarker = g.__PAPERCUSP_TAURI_ISOLATED__;
    g.__PAPERCUSP_TAURI_ISOLATED__ = true;
    try {
      localStorage.setItem(
        'pc:ws:default:papercusp.voice.config.v1',
        JSON.stringify({ lastMode: 'always-on' }),
      );
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(mod.getVoiceState().mode).toBe('off');
    } finally {
      if (previousMarker === undefined) delete g.__PAPERCUSP_TAURI_ISOLATED__;
      else g.__PAPERCUSP_TAURI_ISOLATED__ = previousMarker;
    }
  });

  it('lists available voices', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    const voices = mod.listAvailableVoices();
    expect(voices.length).toBe(3);
    expect(voices[0].name).toBe('Alice');
  });

  it('assigned voices persist across calls', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('orchestrator', 'Alice');
    expect(mod.getVoiceConfig().roleVoices['orchestrator']).toBe('Alice');
    // Re-assign — overwrites.
    mod.assignVoiceToRole('orchestrator', 'Bob');
    expect(mod.getVoiceConfig().roleVoices['orchestrator']).toBe('Bob');
  });

  it('different roles can have different voices', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('role-a', 'Alice');
    mod.assignVoiceToRole('role-b', 'Bob');
    const cfg = mod.getVoiceConfig();
    expect(cfg.roleVoices['role-a']).toBe('Alice');
    expect(cfg.roleVoices['role-b']).toBe('Bob');
  });

  it('updateVoiceConfig persists wake word', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.updateVoiceConfig({ wakeWord: 'paperclip activate' });
    expect(mod.getVoiceConfig().wakeWord).toBe('paperclip activate');
  });

  it('assignVoiceToRole sets explicit voice', async () => {
    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.assignVoiceToRole('worker', 'Bob');
    expect(mod.getVoiceConfig().roleVoices['worker']).toBe('Bob');
  });

  // Voice-OUTPUT (TTS) mute — the speaker toggle in the voice bar
  // (sentinel-as-claude-tui-2026-06-23). Default unmuted (responses spoken);
  // setVoiceOutputMuted persists through localStorage and round-trips. (The
  // broadcast event is best-effort/try-caught, so persistence holds even when
  // window.dispatchEvent is absent in this Node test env.)
  it('voice output mute (TTS toggle) defaults off and round-trips', async () => {
    const mod = await import('./voice-mode');
    expect(mod.isVoiceOutputMuted()).toBe(false);
    mod.setVoiceOutputMuted(true);
    expect(mod.isVoiceOutputMuted()).toBe(true);
    mod.setVoiceOutputMuted(false);
    expect(mod.isVoiceOutputMuted()).toBe(false);
  });

  it('WI-4873: a cold engine cache routes the first spoken reply to the selected adapter (kokoro), not silent WebKitGTK Web Speech', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    try {
      // synthViaAdapter fetches JSON audio, decodes it to a Blob, then plays it.
      const fetchSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, engine: 'kokoro', contentType: 'audio/wav', audioBase64: 'eA==' }),
      }) as any);
      g.fetch = fetchSpy;
      // Augment the real URL (adding statics) — never REPLACE it, or `new URL()`
      // elsewhere in this file breaks with "URL is not a constructor".
      g.URL.createObjectURL = () => 'blob:x';
      g.URL.revokeObjectURL = () => {};
      g.Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(u: string) { this.src = u; }
        play() { this.onended?.(); return Promise.resolve(); }
        pause() {}
      };
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      // localStorage empty → loadVoicePrefsClient defaults ttsEngine to 'kokoro'.
      // force:true bypasses the mode/mute/leader gates so we isolate ENGINE ROUTING.
      mod.speak('the harness is green', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0)); // let the async adapter path reach fetch()
      // Regression: the FIRST utterance must NOT use the silent WebKitGTK Web Speech path…
      expect(g.window.speechSynthesis.speak).not.toHaveBeenCalled();
      // …and MUST synthesize through the server adapter with the selected engine.
      const ttsCall = fetchSpy.mock.calls.find((c: any[]) => String(c[0]).endsWith('/operator-tts'));
      expect(ttsCall).toBeTruthy();
      expect(JSON.parse(String((ttsCall![1] as any).body))).toMatchObject({ engine: 'kokoro', text: 'the harness is green' });
    } finally {
      g.fetch = origFetch;
      g.Audio = origAudio;
      if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
      if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
    }
  });

  it('WI-10006826: a TTS engine chosen after an earlier utterance (prefs hydrate / settings change) applies to the very next reply', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    try {
      const fetchSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, engine: 'kokoro', contentType: 'audio/wav', audioBase64: 'eA==' }),
      }) as any);
      g.fetch = fetchSpy;
      g.URL.createObjectURL = () => 'blob:x';
      g.URL.revokeObjectURL = () => {};
      g.Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(u: string) { this.src = u; }
        play() { this.onended?.(); return Promise.resolve(); }
        pause() {}
      };
      const mod = await import('./voice-mode');
      const prefs = await import('./voice-prefs-client');
      mod.initVoiceMode();
      const ttsBodies = () => fetchSpy.mock.calls
        .filter((c: any[]) => String(c[0]).endsWith('/operator-tts'))
        .map((c: any[]) => JSON.parse(String((c[1] as any).body)) as { engine: string; text: string });
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
      // Before the prefs sync hydrates, the default engine is used.
      mod.speak('first reply', 'system:operator', 'polite', { force: true });
      await settle();
      expect(ttsBodies().map((b) => b.engine)).toEqual(['kokoro']);
      // The sync bridge (or a Settings change) now delivers the user's choice.
      prefs.setVoicePrefsClient({ ...prefs.loadVoicePrefsClient(), ttsEngine: 'elevenlabs' });
      mod.speak('second reply', 'system:operator', 'polite', { force: true });
      await settle();
      // Regression: a 30s engine cache kept 'kokoro' here.
      expect(ttsBodies()).toEqual([
        expect.objectContaining({ engine: 'kokoro', text: 'first reply' }),
        expect.objectContaining({ engine: 'elevenlabs', text: 'second reply' }),
      ]);
    } finally {
      g.fetch = origFetch;
      g.Audio = origAudio;
      if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
      if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
    }
  });

  it('sends long adapter replies to bounded synthesis chunks in order, including the final tail', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    try {
      const fetchSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, engine: 'kokoro', contentType: 'audio/wav', audioBase64: 'eA==' }),
      }) as any);
      g.fetch = fetchSpy;
      g.URL.createObjectURL = () => 'blob:x';
      g.URL.revokeObjectURL = () => {};
      g.Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(u: string) { this.src = u; }
        play() { this.onended?.(); return Promise.resolve(); }
        pause() {}
      };
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      const text = 'First sentence. '.repeat(300) + '\n\n' + 'middle words '.repeat(300) + '\n\nFINAL TAIL';
      mod.speak(text, 'system:operator', 'polite', { force: true });
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

      const calls = fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/operator-tts'));
      const chunks = calls.map((c: any[]) => JSON.parse(String((c[1] as any).body)).text as string);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
      expect(chunks.join('')).toBe(text);
      expect(chunks[chunks.length - 1]).toContain('FINAL TAIL');
    } finally {
      g.fetch = origFetch;
      g.Audio = origAudio;
      if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
      if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
    }
  });

  it('canceling a long adapter reply stops the remaining synthesis chunks', async () => {
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    try {
      const fetchSpy = vi.fn(async (..._args: unknown[]) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, engine: 'kokoro', contentType: 'audio/wav', audioBase64: 'eA==' }),
      }) as any);
      g.fetch = fetchSpy;
      g.URL.createObjectURL = () => 'blob:x';
      g.URL.revokeObjectURL = () => {};
      let playCount = 0;
      g.Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        src = '';
        constructor(u: string) { this.src = u; }
        play() { playCount++; return new Promise<void>(() => {}); }
        pause() {}
      };
      const mod = await import('./voice-mode');
      mod.initVoiceMode();
      mod.speak('long reply '.repeat(900), 'system:operator', 'polite', { force: true });
      for (let i = 0; i < 20 && playCount === 0; i++) await new Promise((r) => setTimeout(r, 0));
      expect(playCount).toBe(1);
      mod.cancelAllSpeech();
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

      const calls = fetchSpy.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/operator-tts'));
      expect(calls).toHaveLength(1);
      expect(playCount).toBe(1);
    } finally {
      g.fetch = origFetch;
      g.Audio = origAudio;
      if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
      if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
    }
  });
});

// ── WI-5174 — spoken output never fails silently ──────────────────────────
// Owner repro 2026-07-17: "they replied a fine response but it showed up in the
// text chat and wasn't spoken out loud like it should have been." Evidence
// showed kokoro DID return 200 + WAV bytes, so the failure was strictly in
// client-side playback — where every branch resolved silently and the queue
// advanced as if it had spoken. These lock in that a failure to SPEAK always
// tells the user, via the same papercusp:voiceTimeout channel VoiceButton
// already toasts.
describe('WI-5174: spoken playback failures are surfaced, not swallowed', () => {
  interface Harness {
    mod: typeof import('./voice-mode');
    toasts: Array<{ phase: string; message: string }>;
    restore: () => void;
  }

  /**
   * Drive one utterance through synthViaAdapter with a scripted Audio stub.
   * `audioBehavior` decides how playback resolves; `fetchOk` decides whether the
   * TTS route returns bytes at all.
   */
  async function runUtterance(opts: {
    fetchOk?: boolean;
    status?: number;
    audioBehavior?: 'ok' | 'play-rejects' | 'play-rejects-autoplay' | 'onerror' | 'throws';
  }): Promise<Harness> {
    const { fetchOk = true, status = 200, audioBehavior = 'ok' } = opts;
    vi.resetModules();
    const g = globalThis as any;
    const origFetch = g.fetch;
    const origAudio = g.Audio;
    const origCreate = g.URL?.createObjectURL;
    const origRevoke = g.URL?.revokeObjectURL;
    const origDispatch = g.dispatchEvent;

    const toasts: Array<{ phase: string; message: string }> = [];
    g.dispatchEvent = (e: any) => {
      if (e?.type === 'papercusp:voiceTimeout' && e.detail) toasts.push(e.detail);
      return true;
    };
    g.fetch = vi.fn(async () => {
      if (audioBehavior === 'throws') throw new Error('network down');
      return {
        ok: fetchOk,
        status,
        json: async () => ({ ok: true, engine: 'kokoro', contentType: 'audio/wav', audioBase64: 'eA==' }),
      } as any;
    });
    g.URL.createObjectURL = () => 'blob:x';
    g.URL.revokeObjectURL = () => {};
    g.Audio = class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = '';
      constructor(u: string) { this.src = u; }
      play(): Promise<void> {
        if (audioBehavior === 'onerror') { this.onerror?.(); return Promise.resolve(); }
        if (audioBehavior === 'play-rejects') return Promise.reject(new Error('boom'));
        if (audioBehavior === 'play-rejects-autoplay') {
          const err = new Error('play() failed because the user did not interact first');
          err.name = 'NotAllowedError';
          return Promise.reject(err);
        }
        this.onended?.();
        return Promise.resolve();
      }
      pause() {}
    };

    const mod = await import('./voice-mode');
    mod.initVoiceMode();
    mod.speak('the harness is green', 'system:operator', 'polite', { force: true });
    // Let the async adapter path run: fetch → blob → Audio → play/settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    return {
      mod,
      toasts,
      restore: () => {
        g.fetch = origFetch;
        g.Audio = origAudio;
        g.dispatchEvent = origDispatch;
        if (origCreate) g.URL.createObjectURL = origCreate; else delete g.URL.createObjectURL;
        if (origRevoke) g.URL.revokeObjectURL = origRevoke; else delete g.URL.revokeObjectURL;
      },
    };
  }

  it('stays silent when playback actually succeeds (no false alarm)', async () => {
    const h = await runUtterance({ audioBehavior: 'ok' });
    try {
      expect(h.toasts).toHaveLength(0);
    } finally { h.restore(); }
  });

  it('tells the user when play() is rejected — the exact WI-5174 shape', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].phase).toBe('playback');
      expect(h.toasts[0].message).toMatch(/couldn't be played/i);
    } finally { h.restore(); }
  });

  it('names autoplay blocking specifically so the user acts on the right problem', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects-autoplay' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/click anywhere/i);
      // Must NOT send the user hunting speakers/output devices.
      expect(h.toasts[0].message).not.toMatch(/couldn't be played/i);
    } finally { h.restore(); }
  });

  it('tells the user when the audio element errors', async () => {
    const h = await runUtterance({ audioBehavior: 'onerror' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].phase).toBe('playback');
    } finally { h.restore(); }
  });

  it('tells the user when the TTS route returns non-ok (no bytes to play)', async () => {
    const h = await runUtterance({ fetchOk: false, status: 503 });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/couldn't generate speech/i);
      expect(h.toasts[0].message).toContain('503');
    } finally { h.restore(); }
  });

  it('tells the user when the adapter throws outright', async () => {
    const h = await runUtterance({ audioBehavior: 'throws' });
    try {
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0].message).toMatch(/playback failed/i);
    } finally { h.restore(); }
  });

  it('throttles a persistently broken sink to one toast, not one per utterance', async () => {
    const h = await runUtterance({ audioBehavior: 'play-rejects' });
    try {
      // Two more failing utterances inside the throttle window.
      h.mod.speak('second reply', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0));
      h.mod.speak('third reply', 'system:operator', 'polite', { force: true });
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.toasts).toHaveLength(1);
    } finally { h.restore(); }
  });
});

// Always-on wake-phrase gate (voice-public-release-readiness-2026-07-12 P-004).
// The always-on local loop hears EVERYTHING; the gate forwards only
// wake-phrase-prefixed utterances or follow-ups inside the conversation
// window a wake opened. Pure w.r.t. time (nowMs param) so fully deterministic.
describe('gateAlwaysOnTranscript (P-004 wake gate)', () => {
  const T0 = 1_000_000;

  it('drops ambient speech outside a wake window', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('the meeting is at three', T0)).toEqual({
      dispatch: null,
      bareWake: false,
    });
  });

  it('a bare wake opens the window and reports bareWake', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('Hey Papercup!', T0)).toEqual({
      dispatch: null,
      bareWake: true,
    });
    // Follow-up inside the window now dispatches verbatim.
    expect(mod.gateAlwaysOnTranscript('what changed today', T0 + 5_000)).toEqual({
      dispatch: 'what changed today',
      bareWake: false,
    });
  });

  it('wake + command dispatches the trailing command', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('Hey, Papercup. open the dashboard', T0)).toEqual({
      dispatch: 'open the dashboard',
      bareWake: false,
    });
  });

  it('the conversation window expires (~25s) and each follow-up refreshes it', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.gateAlwaysOnTranscript('hey papercup', T0); // opens window
    // Follow-up at +20s → inside, dispatched, refreshes the window.
    expect(mod.gateAlwaysOnTranscript('and the tests?', T0 + 20_000).dispatch).toBe('and the tests?');
    // +40s = 20s after the refresh → still inside.
    expect(mod.gateAlwaysOnTranscript('run them', T0 + 40_000).dispatch).toBe('run them');
    // +40s + 26s → expired, ambient speech dropped again.
    expect(mod.gateAlwaysOnTranscript('unrelated chatter', T0 + 66_000).dispatch).toBe(null);
  });

  it('resetWakeConversationWindow closes an open window', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.gateAlwaysOnTranscript('hey papercup', T0);
    mod.resetWakeConversationWindow();
    expect(mod.gateAlwaysOnTranscript('should be dropped', T0 + 1_000).dispatch).toBe(null);
  });
});

// WI-4500: the always-on mic hears papercup's OWN kokoro TTS (WebKitGTK AEC is weak),
// whisper hallucinates a stable token ("omid"), it sails past isBlankTranscript, and the
// self-refreshing wake window keeps papercup talking to its own echo forever. These pin
// the two guards that break that loop. Each also carries the DISCRIMINATION half — the
// guard must stay silent on real input — because a guard that drops everything is not a
// guard (see harness fact a-claimed-guard-is-not-a-guard).
describe('always-on self-feedback guards (WI-4500)', () => {
  const T0 = 2_000_000;

  it('isLikelyWhisperHallucination catches whisper non-speech tokens including "omid"', async () => {
    const mod = await import('./voice-mode');
    // The tokens the loop actually produced / the classic whisper.cpp hallucinations.
    for (const t of ['omid', 'Omid', ' OMID ', 'you', 'Thank you', 'thanks for watching']) {
      expect(mod.isLikelyWhisperHallucination(t)).toBe(true);
    }
  });

  it('does NOT filter real one-word replies (discrimination — not a mute button)', async () => {
    const mod = await import('./voice-mode');
    // These are legitimate short commands a user says; they MUST pass.
    for (const t of ['yes', 'no', 'stop', 'open the dashboard', 'what changed today']) {
      expect(mod.isLikelyWhisperHallucination(t)).toBe(false);
    }
  });

  it('isSelfAudioLikely is true within the cooldown after playout ends, false after', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow(); // also clears synthQuietSince
    // Nothing has spoken → not self-audio.
    expect(mod.isSelfAudioLikely(T0)).toBe(false);
    // Playout just ended → inside the ~700ms AEC-settle tail → treat mic as self-audio.
    mod.__markSynthPlayoutEnded(T0);
    expect(mod.isSelfAudioLikely(T0 + 100)).toBe(true);
    expect(mod.isSelfAudioLikely(T0 + 699)).toBe(true);
    // Past the tail → the room is quiet again, real speech is trustworthy.
    expect(mod.isSelfAudioLikely(T0 + 1_500)).toBe(false);
  });

  // WI-954890 — the defect the cooldown above could not see, and the reason it
  // is now only a fail-closed fallback. isSelfAudioLikely is evaluated at
  // DISPATCH, but it guards audio captured much earlier: end-of-speech detection
  // costs 683ms on the shipped energy-VAD path and whisper adds 588ms even in the
  // fastest run measured, so an echo transcript could not arrive in under 1271ms
  // — always past the 700ms window. These pin the replacement
  // property: the verdict follows the AUDIO, so lateness cannot defeat it.
  it('isSelfEchoCapture rejects audio recorded during playout REGARDLESS of dispatch time', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow(); // clears the playout ledger too
    mod.__markPlayoutStarted(T0);
    mod.__markPlayoutEnded(T0 + 3_000);

    // The reply's final segment: recorded inside playout, transcribed ~1.5-3.8s
    // later. Under the old guard this dispatched; the verdict here does not
    // depend on when it is asked, so it cannot.
    const finalSegment = { startedAtMs: T0 + 2_100, endedAtMs: T0 + 3_000 };
    expect(mod.isSelfEchoCapture(finalSegment)).toBe(true);
    // Asked again much later — same answer. This is the structural property.
    expect(mod.isSelfEchoCapture(finalSegment)).toBe(true);
  });

  it('isSelfEchoCapture ACCEPTS user speech recorded after the room went quiet', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.__markPlayoutStarted(T0);
    mod.__markPlayoutEnded(T0 + 1_000);
    // Spoken well after playout + the acoustic tail — a real user turn.
    expect(mod.isSelfEchoCapture({ startedAtMs: T0 + 2_000, endedAtMs: T0 + 3_500 })).toBe(false);
  });

  it('barge-in cancel closes the audible interval (it previously started no cooldown at all)', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.__markPlayoutStarted(T0);
    // cancelAllSpeech() is the barge-in path; it used to clear isSynthSpeaking
    // and leave the guard state untouched, so the cancelled reply's buffered
    // audio was unguarded. An open interval must not be left open.
    mod.cancelAllSpeech();
    // Audio recorded during the cancelled playout is still ours.
    expect(mod.isSelfEchoCapture({ startedAtMs: T0 + 100, endedAtMs: T0 + 500 })).toBe(true);
    // …and the interval is genuinely closed, so later speech is trusted again.
    expect(
      mod.isSelfEchoCapture({ startedAtMs: Date.now() + 60_000, endedAtMs: Date.now() + 61_000 }),
    ).toBe(false);
  });
});

// WI-964738: Web Speech does not expose a CaptureWindow. It must reject an
// echo by comparing the final transcript with recently-started TTS text, not
// by muting every utterance while papercup is speaking (which breaks barge-in).
describe('Web Speech self-echo guard (WI-964738)', () => {
  const T0 = 5_000_000;

  it('normalizes punctuation and rejects high ordered-token overlap', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.__recordSpokenTts(
      'Okay, Papercup has completed the release check.',
      T0,
    );

    expect(mod.orderedTokenOverlap(
      'okay papercup has completed the release check',
      'Okay, Papercup has completed the release check.',
    )).toBe(1);
    expect(mod.isRecentSpokenTtsEcho(
      'okay papercup has completed the release check',
      T0 + 100,
    )).toBe(true);
    // Shared wake/brand words are not enough to suppress a real command.
    expect(mod.isRecentSpokenTtsEcho(
      'hey papercup stop the reply',
      T0 + 100,
    )).toBe(false);
  });

  it('expires entries and keeps only the bounded recent history', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.__recordSpokenTts('alpha zero green report', T0);
    for (let i = 1; i <= mod.RECENT_SPOKEN_TTS_MAX_ENTRIES; i++) {
      mod.__recordSpokenTts(`token${i} unique phrase ready`, T0 + i);
    }

    // The oldest entry was evicted by the hard cap; the newest remains.
    expect(mod.isRecentSpokenTtsEcho('alpha zero green report', T0 + 100)).toBe(false);
    expect(mod.isRecentSpokenTtsEcho(
      `token${mod.RECENT_SPOKEN_TTS_MAX_ENTRIES} unique phrase ready`,
      T0 + 100,
    )).toBe(true);
    // The TTL is exclusive at its boundary.
    expect(mod.isRecentSpokenTtsEcho(
      `token${mod.RECENT_SPOKEN_TTS_MAX_ENTRIES} unique phrase ready`,
      T0 + mod.RECENT_SPOKEN_TTS_MAX_ENTRIES + mod.RECENT_SPOKEN_TTS_TTL_MS,
    )).toBe(false);
  });

  it('anchors the Web Speech wake match, including configured wake-word fallback', async () => {
    const mod = await import('./voice-mode');
    mod.resetWakeConversationWindow();
    mod.updateVoiceConfig({ wakeWord: 'hey papercup' });
    expect(mod.__matchWebSpeechWakePhrase('I said hey papercup open the dashboard')).toEqual({
      matched: false,
      trailing: '',
    });
    expect(mod.__matchWebSpeechWakePhrase('Hey, Papercup. open the dashboard')).toEqual({
      matched: true,
      trailing: 'open the dashboard',
    });

    mod.updateVoiceConfig({ wakeWord: 'hello operator' });
    expect(mod.__matchWebSpeechWakePhrase('hello operator open the dashboard')).toEqual({
      matched: true,
      trailing: 'open the dashboard',
    });
    expect(mod.__matchWebSpeechWakePhrase('please hello operator open the dashboard')).toEqual({
      matched: false,
      trailing: '',
    });
    mod.updateVoiceConfig({ wakeWord: 'hey papercup' });
  });

  it('routes final wake+command through the guard without muting barge-in', async () => {
    vi.useFakeTimers({ now: T0 });
    try {
      const mod = await import('./voice-mode');
      mod.resetWakeConversationWindow();
      mod.updateVoiceConfig({ wakeWord: 'hey papercup' });
      mod.__recordSpokenTts(
        'Okay, Papercup has completed the release check.',
        T0,
      );
      const cancelSpy = (globalThis as any).window.speechSynthesis.cancel;
      cancelSpy.mockClear();
      const received: string[] = [];
      const unsubscribe = mod.onFinalUtterance((text) => received.push(text));
      try {
        // Echo is dropped before cancelAllSpeech(), so the reply keeps playing.
        expect(mod.__simulateWebSpeechFinalWake(
          'Okay, Papercup has completed the release check.',
        )).toBe(false);
        expect(received).toEqual([]);
        expect(cancelSpy).not.toHaveBeenCalled();

        // A different command still interrupts TTS and reaches the listener.
        expect(mod.__simulateWebSpeechFinalWake(
          'hey papercup stop the reply',
        )).toBe(true);
        expect(received).toEqual(['operator stop the reply']);
        expect(cancelSpy).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
