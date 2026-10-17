'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PRODUCT_TUTORIAL_CHAPTERS, PRODUCT_TUTORIAL_LESSONS, PRODUCT_TUTORIAL_TARGETS, productTutorialChapterIds, productTutorialLessonIds, productTutorialTargetAvailability, type ProductTutorialChapter, type ProductTutorialLesson, type ProductTutorialVideoMedia, type ProductTutorialVideoPosition } from '@papercusp/operator-core/lib/onboarding/product-tutorial-lesson';
import type { AccountTutorialProgressRecord } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-progress';
import { captureBrowserTelemetry } from '../browser-telemetry';
import { useOperatorWorkspaceLocation } from '../seam';
import { createVoiceOutputPlayback, type VoiceOutputPlaybackStatus } from '@papercusp/operator-core/lib/voice-output-playback';

type GuideCapture = typeof captureBrowserTelemetry;
/** The host supplies its maintained voice transport; the guide owns consent. */
export interface ProductTutorialVoiceSession {
  setMicrophoneMuted(muted: boolean): void | Promise<void>;
  setOutputMuted(muted: boolean): void;
  stop(): Promise<void>;
}
export type ProductTutorialVoiceLauncher = (input: {
  account: ProductTutorialAccount; lesson: ProductTutorialLesson; consent: true; signal: AbortSignal;
  onStatus(status: string): void; onTurn(turn: { speaker: 'user' | 'assistant'; text: string }): void;
}) => Promise<ProductTutorialVoiceSession>;

export function ProductTutorialVoiceQuestion({ account, lesson, openVoice, onQuestion }: {
  account: ProductTutorialAccount; lesson: ProductTutorialLesson; openVoice: ProductTutorialVoiceLauncher; onQuestion?: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState('off');
  const [error, setError] = useState<string | null>(null);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [outputMuted, setOutputMuted] = useState(false);
  const [turn, setTurn] = useState<string | null>(null);
  const connection = useRef<AbortController | null>(null);
  const session = useRef<ProductTutorialVoiceSession | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    if (deadline.current) clearTimeout(deadline.current); deadline.current = null;
    connection.current?.abort(); connection.current = null;
    const current = session.current; session.current = null;
    if (current) {
      current.setOutputMuted(true);
      void Promise.resolve(current.setMicrophoneMuted(true)).catch(() => {});
      void current.stop().catch(() => {});
    }
    setStatus('off'); setConsent(false); setMicrophoneMuted(false); setOutputMuted(false);
  }, []);
  const identity = `${account.tenantId}:${account.userId}:${account.sessionId}:${account.workspaceId}:${lesson.id}`;
  useEffect(() => {
    setError(null); setTurn(null);
    const hidden = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); stop(); };
  }, [identity, openVoice, stop]);
  async function start() {
    if (!consent || connection.current) return;
    const controller = new AbortController(); connection.current = controller;
    setError(null); setTurn(null); setStatus('connecting'); onQuestion?.();
    deadline.current = setTimeout(() => {
      if (connection.current !== controller) return;
      stop(); setError('Spoken questions took too long to connect. Type your question or try again.');
    }, 20_000);
    try {
      const opened = await openVoice({ account, lesson, consent: true, signal: controller.signal,
        onStatus: value => {
          if (connection.current !== controller || controller.signal.aborted) return;
          if (value === 'off' || value === 'disconnected') { stop(); return; }
          setStatus(value);
        },
        onTurn: value => {
          if (connection.current === controller && !controller.signal.aborted) setTurn(`${value.speaker === 'user' ? 'You' : 'Lesson Help'}: ${value.text.slice(0, 2000)}`);
        } });
      if (connection.current !== controller || controller.signal.aborted) { await opened.stop(); return; }
      if (deadline.current) clearTimeout(deadline.current); deadline.current = null;
      session.current = opened; setStatus('listening');
    } catch {
      if (connection.current === controller && !controller.signal.aborted) {
        stop(); setError('Spoken questions are unavailable. Type your question or use the lesson instructions.');
      }
    }
  }
  return <section aria-label="Spoken lesson questions">
    <p>Optional spoken questions use Papercusp’s tutorial voice service. Your microphone audio goes to ElevenLabs. Keep credentials and private content out of spoken questions.</p>
    <label><input type="checkbox" checked={consent} disabled={status !== 'off'} onChange={event => setConsent(event.target.checked)} />Allow microphone audio for this lesson</label>
    {status === 'off' ? <button type="button" disabled={!consent} onClick={() => void start()}>Start spoken questions</button> : <>
      <button type="button" onClick={stop}>Stop spoken questions</button>
      <button type="button" disabled={!session.current} onClick={() => {
        const next = !microphoneMuted;
        void Promise.resolve(session.current?.setMicrophoneMuted(next)).then(() => setMicrophoneMuted(next)).catch(() => {
          stop(); setError('The microphone could not be muted. Spoken questions have stopped; text Help remains available.');
        });
      }}>{microphoneMuted ? 'Unmute microphone' : 'Mute microphone'}</button>
      <button type="button" disabled={!session.current} onClick={() => { const next = !outputMuted; session.current?.setOutputMuted(next); setOutputMuted(next); }}>{outputMuted ? 'Unmute spoken answers' : 'Mute spoken answers'}</button>
    </>}
    {status !== 'off' && <p role="status">{status === 'connecting' ? 'Connecting spoken questions…' : microphoneMuted ? 'Microphone muted' : 'Spoken questions active'}</p>}
    {turn && <p aria-live="polite">{turn}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
/** Advisory text only. This component has no progress or product mutator. */
export function ProductTutorialAssistance({ account, lesson, onQuestion, openVoice, speechEnabled = false }: {
  account: ProductTutorialAccount; lesson: ProductTutorialLesson; onQuestion?: () => void; openVoice?: ProductTutorialVoiceLauncher; speechEnabled?: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [speechStatus, setSpeechStatus] = useState<VoiceOutputPlaybackStatus>('idle');
  const [muted, setMuted] = useState(false);
  const outputMuted = useRef(false);
  const guidance = `${lesson.title}. ${lesson.introduction} ${lesson.help}`.slice(0, 2000);
  const lastSpoken = useRef(guidance);
  const requestScope = useRef({ account, lesson }); requestScope.current = { account, lesson };
  const playback = useMemo(() => createVoiceOutputPlayback(async (text, engine, voiceId, signal) => {
    const current = requestScope.current;
    const response = await fetch('/api/hosted/browser/onboarding/tutorial-speech', { method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      body: JSON.stringify({ expectedScope: { tenantId: current.account.tenantId, userId: current.account.userId },
        context: { version: 3, step: current.lesson.id, status: 'ready' }, question: text, engine, ...(voiceId ? { voiceId } : {}) }) });
    if (!response.ok) throw new Error('tutorial_speech_unavailable');
    return response.blob();
  }, setSpeechStatus, { isMuted: () => outputMuted.current, settings: () => ({ engine: 'kokoro', voiceId: null, rate: 1 }) }), []);
  const identity = `${account.tenantId}:${account.userId}:${account.sessionId}:${account.workspaceId}:${lesson.id}`;
  useEffect(() => {
    setQuestion(''); setAnswer(null); setError(null); setBusy(false); lastSpoken.current = guidance;
    return () => { pending.current?.abort(); pending.current = null; if (timeout.current) clearTimeout(timeout.current); timeout.current = null; playback.stop(); };
  }, [identity, playback]);
  useEffect(() => {
    if (!speechEnabled) playback.stop();
    const hidden = () => { if (document.visibilityState === 'hidden') playback.stop(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); playback.stop(); };
  }, [speechEnabled, playback]);
  const cancel = () => { pending.current?.abort(); pending.current = null; if (timeout.current) clearTimeout(timeout.current); timeout.current = null; setBusy(false); };
  async function ask() {
    if (pending.current || !question.trim()) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setAnswer(null); playback.stop(); onQuestion?.();
    const timer = setTimeout(() => {
      if (pending.current !== controller) return;
      controller.abort(); pending.current = null; setBusy(false);
      setError('AI Help is taking too long. The lesson instructions remain available.');
    }, 15_000);
    timeout.current = timer;
    try {
      const response = await fetch('/api/hosted/browser/onboarding/tutorial-help', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ expectedScope: { tenantId: account.tenantId, userId: account.userId },
          context: { version: 3, step: lesson.id, status: 'ready' }, question: question.trim() }) });
      if (!response.ok) throw new Error('unavailable');
      const body: unknown = await response.json();
      if (pending.current !== controller || controller.signal.aborted) return;
      const value = (body as { answer?: unknown })?.answer;
      if (typeof value !== 'string' || !value.trim()) throw new Error('empty');
      const text = value.trim().slice(0, 2000);
      setAnswer(text); lastSpoken.current = text;
    } catch {
      if (pending.current === controller && !controller.signal.aborted) setError('AI Help is unavailable. You can continue with the lesson instructions.');
    } finally {
      clearTimeout(timer);
      if (timeout.current === timer) timeout.current = null;
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }
  return <section aria-label="Ask about this lesson">
    <p>Ask about this lesson. Keep credentials and private workspace content out of your question.</p>
    {speechEnabled && <section aria-label="Spoken lesson guidance">
      <button type="button" disabled={muted} onClick={() => { lastSpoken.current = guidance; void playback.play(guidance); }}>Speak lesson</button>
      {answer && <button type="button" disabled={muted} onClick={() => { lastSpoken.current = answer; void playback.play(answer); }}>Speak answer</button>}
      <button type="button" aria-pressed={muted} onClick={() => { outputMuted.current = !muted; setMuted(!muted); playback.stop(); }}>{muted ? 'Unmute guide' : 'Mute guide'}</button>
      <button type="button" onClick={playback.stop}>Stop speech</button>
      <button type="button" disabled={muted} onClick={() => void playback.play(lastSpoken.current)}>Replay speech</button>
      <p role="status">{muted ? 'Guide speech is muted.' : speechStatus === 'loading' ? 'Preparing speech…' : speechStatus === 'playing' ? 'Speaking the lesson.' : speechStatus === 'unavailable' ? 'Speech could not be played. The text remains available; use Replay speech to try again.' : 'Speech is ready.'}</p>
    </section>}
    <form onSubmit={event => { event.preventDefault(); void ask(); }}>
      <label>Lesson question<textarea style={{ display: 'block', boxSizing: 'border-box', width: '100%', maxWidth: '100%' }} value={question} maxLength={2000} disabled={busy} onChange={event => setQuestion(event.target.value)} /></label>
      <button disabled={busy || !question.trim()} type="submit">Ask AI Help</button>
      {busy && <button type="button" onClick={cancel}>Cancel AI Help</button>}
    </form>
    {busy && <p role="status">Asking about this lesson…</p>}
    {answer && <p aria-live="polite">{answer}</p>}{error && <p role="alert">{error}</p>}
    {openVoice && <ProductTutorialVoiceQuestion account={account} lesson={lesson} openVoice={openVoice} onQuestion={() => { playback.stop(); onQuestion?.(); }} />}
  </section>;
}
/** Observe saved learning records. Explanation review is never domain success. */
export function createProductTutorialAnalytics(capture: GuideCapture = captureBrowserTelemetry) {
  let previous: AccountTutorialProgressRecord | null = null;
  let failed = false;
  const emit = (action: string, lesson?: string) => {
    if (lesson && !productTutorialLessonIds.has(lesson)) return;
    try { void Promise.resolve(capture('product_tutorial', { lesson_id: 'product-guide', lesson_version: 3,
      action, ...(lesson ? { lesson } : {}) })).catch(() => {}); } catch { /* Optional diagnostics. */ }
  };
  return {
    help(lesson: string) { emit('help_requested', lesson); },
    update(record: AccountTutorialProgressRecord, error = false) {
      if (!previous && record.disposition === 'active') emit('start');
      if (previous && previous.disposition !== record.disposition) {
        emit({ active: 'resume', paused: 'pause', skipped: 'skip', closed: 'guide_closed' }[record.disposition]);
      }
      if (record.disposition === 'active' && (!previous || previous.disposition !== 'active' || previous.currentLessonId !== record.currentLessonId)) emit('lesson_displayed', record.currentLessonId);
      if (previous) for (const lesson of record.reviewedLessonIds) {
        if (!previous.reviewedLessonIds.includes(lesson)) emit('explanation_reviewed', lesson);
      }
      if (error && !failed) emit('waiting', record.currentLessonId);
      if (!error && failed) emit('recovery', record.currentLessonId);
      failed = error; previous = record;
    },
  };
}

const endpoint = '/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3';
export interface ProductTutorialAccount { tenantId: string; userId: string; sessionId: string; workspaceId: string | null }
/** A player has no progress endpoint or product mutator. Try it is a separate
 * gesture routed through the guide's acknowledged pause/navigation operation. */
export function ProductTutorialVideo({ media, lessonId, workspaceId, busy = false, initialVideo, onPosition, onTry }: {
  media: ProductTutorialVideoMedia; lessonId: string; workspaceId: string | null; busy?: boolean;
  initialVideo?: ProductTutorialVideoPosition; onPosition?(position: ProductTutorialVideoPosition): void;
  onTry(chapter: ProductTutorialChapter): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const saved = initialVideo?.mediaId === media.id ? initialVideo : undefined;
  const [chapterId, setChapterId] = useState(() => saved?.chapterId ?? PRODUCT_TUTORIAL_CHAPTERS.find(chapter => chapter.lessonId === lessonId)?.id ?? PRODUCT_TUTORIAL_CHAPTERS[0].id);
  const [unavailable, setUnavailable] = useState(false);
  const chapters = PRODUCT_TUTORIAL_CHAPTERS.flatMap(chapter => {
    const timing = media.chapters.find(entry => entry.id === chapter.id);
    return timing && Number.isFinite(timing.startSeconds) && timing.startSeconds >= 0 ? [{ ...chapter, ...timing }] : [];
  }).sort((a, b) => a.startSeconds - b.startSeconds);
  const current = chapters.find(chapter => chapter.id === chapterId) ?? chapters[0];
  const seek = (id: string) => {
    const chapter = chapters.find(entry => entry.id === id);
    if (!chapter) return;
    setChapterId(id);
    if (video.current) video.current.currentTime = chapter.startSeconds;
    onPosition?.({ mediaId: media.id, chapterId: id, positionSeconds: chapter.startSeconds });
  };
  const availability = current && current.id !== 'meet-papercup' && !workspaceId ? 'Choose an authorized workspace before trying this chapter.' : null;
  return <section className="product-guide-video" aria-label="Watch and try the project tutorial">
    <h2>Build a project with PaperCup</h2>
    <p>Watch the example, then try each step in your own project. Watching records no completed product tasks.</p>
    <video ref={video} controls preload="metadata" playsInline aria-label="PaperCup cloud project tutorial"
      onLoadedMetadata={() => {
        if (current && video.current) {
          const desired = saved?.positionSeconds ?? current.startSeconds;
          video.current.currentTime = Number.isFinite(video.current.duration) ? Math.min(desired, video.current.duration) : desired;
        }
      }}
      onTimeUpdate={() => {
        const time = video.current?.currentTime ?? 0;
        const playing = [...chapters].reverse().find(chapter => chapter.startSeconds <= time);
        if (playing && Number.isFinite(time) && time >= 0) {
          setChapterId(playing.id);
          onPosition?.({ mediaId: media.id, chapterId: playing.id, positionSeconds: time });
        }
      }} onError={() => setUnavailable(true)}>
      <source src={media.src} type="video/mp4" />
      <track kind="captions" src={media.captionsSrc} srcLang="en" label="English" default />
      <p><a href={media.src}>Open the tutorial video</a></p>
    </video>
    {unavailable && <p role="status">The video could not be loaded. You can read the transcript and continue with the guide.</p>}
    <p><a href={media.transcriptHref}>Read the full transcript</a>{' · '}<a href={media.src}>Open video</a></p>
    <nav aria-label="Video chapters"><ol>{chapters.map(chapter => <li key={chapter.id}>
      <button type="button" aria-current={current?.id === chapter.id ? 'true' : undefined} onClick={() => seek(chapter.id)}>{chapter.title}</button>
    </li>)}</ol></nav>
    {current && <section aria-label="Try this chapter">
      <h3>{current.title}</h3><p>{current.transcript}</p>
      {current.prompt && <details><summary>Use this prompt in your project</summary><p className="product-guide-prompt">{current.prompt}</p></details>}
      {availability ? <p>{availability}</p> : <button type="button" disabled={busy} onClick={() => { video.current?.pause(); onTry(current); }}>Try it — {current.title}</button>}
      <p>Your current workspace stays selected. Review the proposed work and costs before starting an agent.</p>
    </section>}
  </section>;
}
/** Explicit guide navigation may enter the existing shell before workspace
 * selection. Panel/search URLs otherwise return to the first-workspace card. */
export function productTutorialDestination(route: string, workspaceId: string | null): string {
  if (workspaceId || !route.startsWith('/?')) return route;
  const params = new URLSearchParams(route.slice(2));
  params.set('firstRun', 'deferred');
  return `/?${params.toString()}`;
}
export function validProductTutorialRecord(value: unknown, account: ProductTutorialAccount): value is AccountTutorialProgressRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as AccountTutorialProgressRecord;
  return row.version === 3 && Number.isSafeInteger(row.revision) && row.revision >= 0 &&
    row.scope?.tenantId === account.tenantId && row.scope.userId === account.userId &&
    ['active', 'paused', 'skipped', 'closed'].includes(row.disposition) && productTutorialLessonIds.has(row.currentLessonId) &&
    Array.isArray(row.reviewedLessonIds) && row.reviewedLessonIds.every(id => productTutorialLessonIds.has(id)) &&
    new Set(row.reviewedLessonIds).size === row.reviewedLessonIds.length &&
    (row.video === undefined || (typeof row.video === 'object' && row.video !== null && typeof row.video.mediaId === 'string' && /^[a-zA-Z0-9._-]{1,160}$/.test(row.video.mediaId) && productTutorialChapterIds.has(row.video.chapterId) && Number.isFinite(row.video.positionSeconds) && row.video.positionSeconds >= 0 && row.video.positionSeconds <= 14400));
}
type GuidePatch = Pick<AccountTutorialProgressRecord, 'disposition' | 'currentLessonId' | 'reviewedLessonIds' | 'video'>;

/** Account entry wraps the host's existing first-run/shell choice. It never
 * mounts that workspace UI while an enrolled guide is active. */
export function AccountProductTutorial({ account, sessionSignal = 'valid', children, openVoice, videoMedia }: { account: ProductTutorialAccount; sessionSignal?: string; children: ReactNode | ((guideControls: ReactNode) => ReactNode); openVoice?: ProductTutorialVoiceLauncher; videoMedia?: ProductTutorialVideoMedia }) {
  const [record, setRecord] = useState<AccountTutorialProgressRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadRequiresSignIn, setLoadRequiresSignIn] = useState(false);
  const [reload, setReload] = useState(0);
  const [continueUnavailable, setContinueUnavailable] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const resume = useRef<HTMLButtonElement>(null);
  const requestedFocus = useRef<'heading' | 'resume' | null>(null);
  // A destination provider may replace its startup wrapper after this guide's
  // effect has run. Transfer the focus intent only when it replaces our focused
  // control; an ordinary destination update must not steal the user's focus.
  const attachResume = useCallback((node: HTMLButtonElement | null) => {
    if (!node && requestedFocus.current !== 'heading' && resume.current === document.activeElement) requestedFocus.current = 'resume';
    resume.current = node;
    if (node && !node.disabled && requestedFocus.current === 'resume') {
      node.focus(); requestedFocus.current = null;
    }
  }, []);
  const operation = useRef<AbortController | null>(null);
  const videoPosition = useRef<ProductTutorialVideoPosition | undefined>(undefined);
  const mounted = useRef(false);
  const pending = useRef<{ body: string; patch: GuidePatch; href?: string } | null>(null);
  const identity = `${account.tenantId}:${account.userId}:${account.sessionId}`;
  const currentLesson = record ? PRODUCT_TUTORIAL_LESSONS.find(lesson => lesson.id === record.currentLessonId) : null;
  const analytics = useRef<{ identity: string; observer: ReturnType<typeof createProductTutorialAnalytics> } | null>(null);
  const workspaceLocation = useOperatorWorkspaceLocation();
  useEffect(() => {
    const analyticsIdentity = `${identity}:${workspaceLocation}`;
    if (!analytics.current || analytics.current.identity !== analyticsIdentity) analytics.current = {
      identity: analyticsIdentity,
      observer: createProductTutorialAnalytics((event, properties) => captureBrowserTelemetry(event, properties, workspaceLocation)),
    };
    // Starting a retry clears the visible error before it has succeeded. Keep
    // the failed observation until the save/read has actually settled.
    if (!busy && !loading && record && validProductTutorialRecord(record, account) && sessionSignal === 'valid') {
      analytics.current.observer.update(record, Boolean(error));
    }
  }, [identity, record, error, sessionSignal, busy, loading, workspaceLocation]);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    operation.current?.abort(); operation.current = abort;
    pending.current = null;
    videoPosition.current = undefined;
    requestedFocus.current = null;
    setLoading(true); setRecord(null); setError(null); setLoadRequiresSignIn(false); setContinueUnavailable(false); setBusy(false);
    let loadFailure = 'Your guide could not be loaded. Check your connection and try again.';
    let requiresSignIn = false;
    fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then(async response => {
        if (!response.ok) {
          requiresSignIn = response.status === 401;
          loadFailure = requiresSignIn ? 'Sign in again to load your guide.'
            : response.status === 403 ? 'Your account could not access the guide. Try again or continue to Papercusp.'
              : response.status >= 500 || response.status === 429 ? 'Papercusp’s guide service is unavailable. Try again or continue to Papercusp.'
                : 'Papercusp could not load your guide. Try again or continue to Papercusp.';
          throw new Error('unavailable');
        }
        loadFailure = 'Your saved guide could not be read. Try again or continue to Papercusp.';
        const body: unknown = await response.json();
        const value = (body as { record?: unknown })?.record;
        if (value !== null && !validProductTutorialRecord(value, account)) throw new Error('scope_changed');
        if (!abort.signal.aborted) setRecord(value as AccountTutorialProgressRecord | null);
      }).catch(() => { if (!abort.signal.aborted) { setError(loadFailure); setLoadRequiresSignIn(requiresSignIn); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; operation.current?.abort(); abort.abort(); };
  }, [identity, reload]);
  useEffect(() => { if (sessionSignal !== 'valid') { operation.current?.abort(); pending.current = null; setBusy(false); } }, [sessionSignal]);
  // A frame scheduled by save can precede a concurrent React commit. Wait for
  // the committed, enabled control so the requested focus cannot be lost.
  useEffect(() => {
    if (busy || loading || sessionSignal !== 'valid' || !requestedFocus.current) return;
    const target = requestedFocus.current === 'heading' ? heading.current : resume.current;
    if (target) { target.focus(); requestedFocus.current = null; }
  }, [record, busy, loading, sessionSignal]);

  async function save(patch: GuidePatch, href?: string, restart = false) {
    if ((!record && !restart) || busy || sessionSignal !== 'valid') return;
    const mutation = pending.current ?? { patch, href, body: JSON.stringify({ disposition: patch.disposition,
      currentLessonId: patch.currentLessonId, reviewedLessonIds: patch.reviewedLessonIds,
      ...(!restart && (videoPosition.current ?? patch.video ?? record?.video) ? { video: videoPosition.current ?? patch.video ?? record?.video } : {}),
      expectedScope: record?.scope ?? { tenantId: account.tenantId, userId: account.userId },
      expectedRevision: record?.revision ?? 0, mutationId: crypto.randomUUID(), version: 3, ...(restart ? { restart: true } : {}) }) };
    pending.current = mutation;
    operation.current?.abort();
    const abort = new AbortController(); operation.current = abort;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: { 'content-type': 'application/json' }, body: mutation.body });
      const body = await response.json() as { record?: unknown };
      if (abort.signal.aborted || !mounted.current) return;
      if (!validProductTutorialRecord(body.record, account)) throw new Error('scope_changed');
      if (response.status === 409) {
        pending.current = null;
        videoPosition.current = body.record.video;
        setRecord(body.record); setError('Another tab changed your guide. Review the current lesson, then try your choice again.'); return;
      }
      if (!response.ok) throw new Error('unavailable');
      pending.current = null;
      videoPosition.current = body.record.video;
      // Observe the acknowledged record before navigation can unmount this
      // component. The later effect sees the same record and emits no duplicate.
      analytics.current?.observer.update(body.record);
      if (!mutation.href) requestedFocus.current = mutation.patch.disposition === 'active' ? 'heading' : 'resume';
      setRecord(body.record);
      if (mutation.href) { window.location.assign(mutation.href); return; }
    } catch { if (!abort.signal.aborted && mounted.current) setError('Your choice was not saved. Check your connection and try again.'); }
    finally { if (!abort.signal.aborted && mounted.current) setBusy(false); }
  }
  if (sessionSignal !== 'valid') return <main className="welcome-state"><h1>Check your session</h1><p role="alert">Your session could not be verified. Guide changes are paused.</p><a href="/api/hosted/auth/sign-in?intent=sign-in">Sign in</a>{' · '}<a href="/docs">Public Docs</a></main>;
  if (loading) return <main className="welcome-state" aria-busy="true"><p role="status">Loading your product guide…</p></main>;
  if (error && !record && !continueUnavailable) return <main className="welcome-state"><h1>Product guide unavailable</h1><p role="alert">{error}</p>
    {loadRequiresSignIn && <><a href="/api/hosted/auth/sign-in?intent=sign-in">Sign in</a>{' '}</>}
    <button onClick={() => setReload(value => value + 1)}>Try again</button>{' '}<button onClick={() => setContinueUnavailable(true)}>Continue to Papercusp</button>{' '}<a href="/docs">Public Docs</a></main>;
  if (!record || record.disposition !== 'active') {
    // The destination owns placement: a modal host must place these controls
    // inside its existing dialog, rather than behind its blocking backdrop.
    const guideControls = <aside className="product-guide-return" aria-label="Product guide">
    <style>{PRODUCT_GUIDE_CSS}</style>
    {record && <button ref={attachResume} disabled={busy} onClick={() => save({ ...record, disposition: 'active' })}>{record.disposition === 'closed' ? 'Review product guide' : 'Resume product guide'}</button>}
    <button ref={record ? undefined : attachResume} disabled={busy} onClick={() => {
      pending.current = null;
      void save({ disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] }, undefined, true);
    }}>{record ? 'Restart tutorial' : 'Start tutorial'}</button>
    {videoMedia && <button type="button" disabled={busy} onClick={() => {
      pending.current = null;
      void save({ disposition: 'active', currentLessonId: record?.currentLessonId ?? 'welcome', reviewedLessonIds: record?.reviewedLessonIds ?? [] }, undefined, !record);
    }}>Watch the project tutorial</button>}
    {currentLesson && <details onToggle={event => { if (event.currentTarget.open) analytics.current?.observer.help(currentLesson.id); }}><summary>Help with {currentLesson.title}</summary><p>{currentLesson.help}</p><a href="/docs">Read public Docs</a><ProductTutorialAssistance key={identity + currentLesson.id} account={account} lesson={currentLesson} onQuestion={() => analytics.current?.observer.help(currentLesson.id)} /></details>}
    {error && <p role="alert">{error}</p>}</aside>;
    return typeof children === 'function' ? children(guideControls) : <>{guideControls}{children}</>;
  }
  const position = PRODUCT_TUTORIAL_LESSONS.findIndex(lesson => lesson.id === record.currentLessonId);
  const lesson = PRODUCT_TUTORIAL_LESSONS[position];
  const targets = PRODUCT_TUTORIAL_TARGETS.filter(target => target.module === lesson.id);
  const choice = (disposition: AccountTutorialProgressRecord['disposition']) => save({ ...record, disposition });
  const move = (next: number, reviewed = false) => save({ disposition: 'active', currentLessonId: PRODUCT_TUTORIAL_LESSONS[next].id,
    reviewedLessonIds: reviewed ? Array.from(new Set([...record.reviewedLessonIds, lesson.id])) : record.reviewedLessonIds });
  return <main className="product-guide" aria-labelledby="product-guide-title">
    <style>{PRODUCT_GUIDE_CSS}</style>
    <p>Product guide · Lesson {position + 1} of {PRODUCT_TUTORIAL_LESSONS.length}</p>
    <h1 id="product-guide-title" ref={heading} tabIndex={-1}>{lesson.title}</h1>
    <p>{lesson.introduction}</p>
    {videoMedia && <ProductTutorialVideo key={`${identity}:${account.workspaceId ?? ''}:${videoMedia.id}`} media={videoMedia} lessonId={lesson.id} workspaceId={account.workspaceId} busy={busy} initialVideo={record.video} onPosition={position => { videoPosition.current = position; }}
      onTry={chapter => void save({ ...record, currentLessonId: chapter.lessonId, disposition: 'paused' }, productTutorialDestination(chapter.destination, account.workspaceId))} />}
    <nav aria-label="Product guide lessons"><ol>{PRODUCT_TUTORIAL_LESSONS.map((entry, index) => <li key={entry.id}>
      <button disabled={busy} aria-current={entry.id === lesson.id ? 'step' : undefined} onClick={() => move(index)}>{entry.title}{record.reviewedLessonIds.includes(entry.id) ? ' · Reviewed' : ''}</button>
    </li>)}</ol></nav>
    <section aria-label="Try these destinations"><h2>Find it in Papercusp</h2>
      {targets.length ? <ul>{targets.map(target => {
        const unavailable = productTutorialTargetAvailability(target, account.workspaceId);
        const href = productTutorialDestination(target.route, account.workspaceId);
        return <li key={target.id}><strong>{target.id}</strong><p>{target.teaches}</p>{unavailable ? <p>{unavailable}</p> :
          <a href={href} onClick={event => { event.preventDefault(); if (!busy) void save({ ...record, disposition: 'paused' }, href); }}>Open {target.id}</a>}</li>;
      })}</ul> : <p>You can read this lesson before selecting a workspace. The navigation lesson shows where the product controls live.</p>}
    </section>
    <details onToggle={event => { setHelpOpen(event.currentTarget.open); if (event.currentTarget.open) analytics.current?.observer.help(lesson.id); }}><summary>Help with this lesson</summary><p>{lesson.help}</p><a href="/docs">Read public Docs</a>{' · '}<a href="/?app=support" onClick={event => { event.preventDefault(); if (!busy) void save({ ...record, disposition: 'paused' }, '/?app=support'); }}>Open Support</a><ProductTutorialAssistance key={identity + lesson.id} account={account} lesson={lesson} speechEnabled={!busy && helpOpen} openVoice={!busy && helpOpen ? openVoice : undefined} onQuestion={() => analytics.current?.observer.help(lesson.id)} /></details>
    <p role="status">{busy ? 'Saving your choice…' : `${record.reviewedLessonIds.length} explanations reviewed. Product tasks are verified separately.`}</p>
    {error && <p role="alert">{error}</p>}{pending.current && error && <button disabled={busy} onClick={() => save(pending.current!.patch, pending.current!.href)}>Retry saving choice</button>}
    <div className="product-guide-actions">
      <button disabled={busy || position === 0} onClick={() => move(position - 1)}>Back</button>
      {position + 1 < PRODUCT_TUTORIAL_LESSONS.length ? <button disabled={busy} onClick={() => move(position + 1, true)}>Reviewed — next lesson</button> :
        <button disabled={busy} onClick={() => save({ ...record, disposition: 'closed', reviewedLessonIds: Array.from(new Set([...record.reviewedLessonIds, lesson.id])) })}>Finish reading the guide</button>}
      <button disabled={busy} onClick={() => choice('paused')}>Pause guide</button>
      <button disabled={busy} onClick={() => choice('skipped')}>Skip guide</button>
    </div>
  </main>;
}
const PRODUCT_GUIDE_CSS = `.product-guide{max-width:72rem;margin:0 auto;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere;color:var(--foreground,inherit)}.product-guide p{max-width:75ch;line-height:1.6}.product-guide nav ol{display:flex;flex-wrap:wrap;gap:.5rem;padding:0;list-style:none}.product-guide nav button[aria-current]{outline:2px solid currentColor;outline-offset:2px}.product-guide ul{padding-left:1.4rem}.product-guide li{margin:.5rem 0}.product-guide-actions{display:flex;flex-wrap:wrap;gap:.75rem}.product-guide button,.product-guide summary,.product-guide a{min-height:2.75rem}.product-guide :focus-visible{outline:2px solid currentColor;outline-offset:3px}.product-guide h1:focus{outline:none}.product-guide-return{padding:.75rem}.product-guide-video{border:1px solid currentColor;border-radius:1rem;padding:clamp(.75rem,2vw,1.5rem);margin:1.5rem 0}.product-guide-video video{display:block;width:100%;aspect-ratio:16/9;background:#15120f;border-radius:.5rem}.product-guide-prompt{white-space:pre-wrap;border-inline-start:3px solid currentColor;padding-inline-start:1rem}`;
