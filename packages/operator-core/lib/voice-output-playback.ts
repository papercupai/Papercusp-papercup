/** The maintained output-only player shared by the operator and product guide.
 * Hosts supply voice preferences; this leaf never opens a microphone or chat. */
export type VoiceOutputPlaybackStatus = 'idle' | 'loading' | 'playing' | 'unavailable';
export function createVoiceOutputPlayback(
  requestSpeech: (text: string, engine: string, voiceId: string | null, signal: AbortSignal) => Promise<Blob>,
  onStatus: (status: VoiceOutputPlaybackStatus) => void,
  preferences: {
    isMuted(): boolean;
    settings(): { engine: string; voiceId: string | null; rate: number };
  },
) {
  let current: AbortController | null = null;
  let disposeAudio: (() => void) | null = null;
  const stop = () => {
    current?.abort(); current = null;
    disposeAudio?.(); disposeAudio = null;
    onStatus('idle');
  };
  return {
    stop,
    async play(text: string) {
      stop();
      if (preferences.isMuted() || !text.trim()) return;
      const controller = new AbortController(); current = controller;
      const signal = controller.signal;
      const active = () => !signal.aborted && current === controller && !preferences.isMuted();
      onStatus('loading');
      try {
        const { engine, voiceId, rate } = preferences.settings();
        if (engine === 'browser') {
          if (!window.speechSynthesis) throw new Error('speech_unavailable');
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = rate;
          utterance.voice = window.speechSynthesis.getVoices().find(voice => voice.name === voiceId) ?? null;
          disposeAudio = () => window.speechSynthesis.cancel();
          utterance.onstart = () => { if (active()) onStatus('playing'); };
          utterance.onend = () => { if (active()) onStatus('idle'); };
          utterance.onerror = () => { if (active()) onStatus('unavailable'); };
          window.speechSynthesis.speak(utterance);
          return;
        }
        const blob = await requestSpeech(text, engine, voiceId, signal);
        if (!active()) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true; audio.pause(); audio.removeAttribute('src'); URL.revokeObjectURL(url);
        };
        disposeAudio = dispose;
        audio.onended = () => { dispose(); if (active()) onStatus('idle'); };
        audio.onerror = () => { dispose(); if (active()) onStatus('unavailable'); };
        await audio.play();
        if (active() && !disposed) onStatus('playing');
      } catch {
        if (active()) { disposeAudio?.(); disposeAudio = null; onStatus('unavailable'); }
      }
    },
  };
}
