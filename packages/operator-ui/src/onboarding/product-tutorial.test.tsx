/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState, type ReactNode } from 'react';
import { AccountProductTutorial, ProductTutorialAssistance, ProductTutorialVideo, ProductTutorialVoiceQuestion, createProductTutorialAnalytics, productTutorialDestination, validProductTutorialRecord, type ProductTutorialAccount, type ProductTutorialVoiceLauncher } from './product-tutorial';
import { PRODUCT_TUTORIAL_CHAPTERS, PRODUCT_TUTORIAL_LESSONS, type ProductTutorialVideoMedia } from '@papercusp/operator-core/lib/onboarding/product-tutorial-lesson';
import { captureBrowserTelemetry } from '../browser-telemetry';
import { OperatorWorkspaceLocationProvider } from '../seam';
vi.mock('../browser-telemetry', () => ({ captureBrowserTelemetry: vi.fn() }));

const account: ProductTutorialAccount = { tenantId: 'org', userId: 'user', sessionId: 'session', workspaceId: null };
const record = (patch: Record<string, unknown> = {}) => ({ scope: { tenantId: account.tenantId, userId: account.userId }, version: 3,
  revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [], ...patch });
const response = (value: unknown, status = 200) => Response.json({ record: value }, { status });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const videoMedia: ProductTutorialVideoMedia = {
  id: 'test-video-v1', src: 'https://clips.papercusp.com/test/tutorial.mp4', captionsSrc: 'https://clips.papercusp.com/test/tutorial.vtt', transcriptHref: '/tutorial-transcript',
  chapters: PRODUCT_TUTORIAL_CHAPTERS.map((chapter, index) => ({ id: chapter.id, startSeconds: index * 10, transcript: `Transcript for ${chapter.title}.` })),
};
describe('combined video and practice guide', () => {
  it('plays and seeks with captions without saving guide or product completion', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record()));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account} videoMedia={videoMedia}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    const video = screen.getByLabelText('PaperCup cloud project tutorial') as HTMLVideoElement;
    expect(video.autoplay).toBe(false);
    expect(video.querySelector('track')?.getAttribute('src')).toBe(videoMedia.captionsSrc);
    fireEvent.click(screen.getByRole('button', { name: 'Create one useful project' }));
    expect(video.currentTime).toBe(10);
    fireEvent.timeUpdate(video);
    fireEvent.ended(video);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Choose an authorized workspace before trying this chapter.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try it — Create one useful project' })).toBeNull();
    expect(vi.mocked(captureBrowserTelemetry).mock.calls.some(([, value]) => value.action === 'explanation_reviewed')).toBe(false);
  });
  it('waits for a scoped acknowledged pause before Try it navigates, preserving reviewed lessons', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', Object.assign(Object.create(window), { location: { assign } }));
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    let acknowledge!: (value: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ reviewedLessonIds: ['welcome'] })))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { acknowledge = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={{ ...account, workspaceId: 'chosen-workspace' }} videoMedia={videoMedia}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Create one useful project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try it — Create one useful project' }));
    expect(pause).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ expectedScope: { tenantId: 'org', userId: 'user' },
      currentLessonId: 'cloud-first-agent', disposition: 'paused', reviewedLessonIds: ['welcome'], video: { mediaId: 'test-video-v1', chapterId: 'create-project', positionSeconds: 10 } });
    await act(async () => acknowledge(response(record({ disposition: 'paused', revision: 1, currentLessonId: 'cloud-first-agent', reviewedLessonIds: ['welcome'] }))));
    expect(assign).toHaveBeenCalledWith('/?app=home&chatPane=true');
    pause.mockRestore();
  });
  it('keeps transcript and practice usable when media fails', () => {
    const onTry = vi.fn();
    render(<ProductTutorialVideo media={videoMedia} lessonId="work" workspaceId="workspace" onTry={onTry} />);
    fireEvent.error(screen.getByLabelText('PaperCup cloud project tutorial'));
    expect(screen.getByRole('link', { name: 'Read the full transcript' }).getAttribute('href')).toBe('/tutorial-transcript');
    fireEvent.click(screen.getByRole('button', { name: 'Try it — Follow Plans, HUD and Work' }));
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining(PRODUCT_TUTORIAL_CHAPTERS[2]));
  });
  it('offers a persistent entry after the guide has been closed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ disposition: 'closed', reviewedLessonIds: ['welcome'] })))
      .mockResolvedValueOnce(response(record({ revision: 1, disposition: 'active', reviewedLessonIds: ['welcome'] })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account} videoMedia={videoMedia}><p>Home</p></AccountProductTutorial>);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch the project tutorial' }));
    await screen.findByLabelText('PaperCup cloud project tutorial');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ disposition: 'active', reviewedLessonIds: ['welcome'] });
  });
  it('resumes only the saved edition and keeps video time separate from reviewed explanations', async () => {
    const video = { mediaId: videoMedia.id, chapterId: 'visible-fleet', positionSeconds: 94.5 };
    const fetcher = vi.fn().mockResolvedValue(response(record({ video })));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountProductTutorial account={{ ...account, workspaceId: 'chosen-workspace' }} videoMedia={videoMedia}><p>Home</p></AccountProductTutorial>);
    const player = await screen.findByLabelText('PaperCup cloud project tutorial') as HTMLVideoElement;
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(94.5);
    expect(screen.getByRole('button', { name: 'Try it — Continue with a visible fleet' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(<AccountProductTutorial account={{ ...account, workspaceId: 'chosen-workspace' }} videoMedia={{ ...videoMedia, id: 'new-edition' }}><p>Home</p></AccountProductTutorial>);
    fireEvent.loadedMetadata(screen.getByLabelText('PaperCup cloud project tutorial'));
    expect((screen.getByLabelText('PaperCup cloud project tutorial') as HTMLVideoElement).currentTime).toBe(0);
    expect(vi.mocked(captureBrowserTelemetry).mock.calls.some(([, value]) => value.action === 'explanation_reviewed')).toBe(false);
  });
});
describe('account product guide entry', () => {
  it('passes the hosted location to analytics instead of probing desktop consent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(record())));
    render(<OperatorWorkspaceLocationProvider location="cloud">
      <AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>
    </OperatorWorkspaceLocationProvider>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    await waitFor(() => expect(captureBrowserTelemetry).toHaveBeenCalled());
    expect(vi.mocked(captureBrowserTelemetry).mock.calls.every(([, , location]) => location === 'cloud')).toBe(true);
  });

  it('starts spoken questions only after explicit consent, offers separate mute controls and stops on lesson change', async () => {
    const session = { stop: vi.fn().mockResolvedValue(undefined), setMicrophoneMuted: vi.fn().mockResolvedValue(undefined), setOutputMuted: vi.fn() };
    const launcher = vi.fn<ProductTutorialVoiceLauncher>().mockResolvedValue(session);
    const view = render(<ProductTutorialVoiceQuestion account={account} lesson={PRODUCT_TUTORIAL_LESSONS[0]} openVoice={launcher} />);
    expect(launcher).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start spoken questions' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByLabelText('Allow microphone audio for this lesson'));
    expect(launcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    await screen.findByText('Spoken questions active');
    expect(launcher.mock.calls[0][0]).toMatchObject({ account, lesson: PRODUCT_TUTORIAL_LESSONS[0], consent: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    await screen.findByRole('button', { name: 'Unmute microphone' });
    expect(session.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(session.setOutputMuted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mute spoken answers' }));
    expect(session.setOutputMuted).toHaveBeenCalledWith(true);
    view.rerender(<ProductTutorialVoiceQuestion account={account} lesson={PRODUCT_TUTORIAL_LESSONS[1]} openVoice={launcher} />);
    expect(launcher.mock.calls[0][0].signal.aborted).toBe(true);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('Allow microphone audio for this lesson') as HTMLInputElement).checked).toBe(false);
  });
  it('cancels a pending voice connection and closes a late session without presenting stale speech', async () => {
    let finish!: (value: Awaited<ReturnType<ProductTutorialVoiceLauncher>>) => void;
    const launcher = vi.fn<ProductTutorialVoiceLauncher>(() => new Promise(resolve => { finish = resolve; }));
    render(<ProductTutorialVoiceQuestion account={account} lesson={PRODUCT_TUTORIAL_LESSONS[0]} openVoice={launcher} />);
    fireEvent.click(screen.getByLabelText('Allow microphone audio for this lesson'));
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop spoken questions' }));
    expect(launcher.mock.calls[0][0].signal.aborted).toBe(true);
    const session = { stop: vi.fn().mockResolvedValue(undefined), setMicrophoneMuted: vi.fn(), setOutputMuted: vi.fn() };
    await act(async () => {
      launcher.mock.calls[0][0].onTurn({ speaker: 'assistant', text: 'Late answer' });
      finish(session);
    });
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Lesson Help: Late answer')).toBeNull();
  });
  it('stops voice when guide pauses or session expires, and never saves progress from a spoken turn', async () => {
    const session = { stop: vi.fn().mockResolvedValue(undefined), setMicrophoneMuted: vi.fn(), setOutputMuted: vi.fn() };
    const launcher = vi.fn<ProductTutorialVoiceLauncher>().mockResolvedValue(session);
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockResolvedValueOnce(response(record({ disposition: 'paused', revision: 1 })));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountProductTutorial account={account} openVoice={launcher}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByText('Help with this lesson'));
    fireEvent.click(await screen.findByLabelText('Allow microphone audio for this lesson'));
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    await screen.findByText('Spoken questions active');
    act(() => launcher.mock.calls[0][0].onTurn({ speaker: 'assistant', text: '<spawn/> explanation only' }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(document.querySelector('spawn')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await screen.findByText('Destination');
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Allow microphone audio for this lesson')).toBeNull();
    view.rerender(<AccountProductTutorial account={account} sessionSignal="signed-out" openVoice={launcher}><p>Destination</p></AccountProductTutorial>);
    expect(launcher).toHaveBeenCalledTimes(1);
  });
  it('voice refusal keeps text Help and deterministic lesson choices available', async () => {
    const launcher = vi.fn<ProductTutorialVoiceLauncher>().mockRejectedValue(new Error('quota exhausted'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(record())));
    render(<AccountProductTutorial account={account} openVoice={launcher}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByText('Help with this lesson'));
    fireEvent.click(await screen.findByLabelText('Allow microphone audio for this lesson'));
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    await screen.findByText('Spoken questions are unavailable. Type your question or use the lesson instructions.');
    expect(screen.getByRole('button', { name: 'Reviewed — next lesson' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByLabelText('Lesson question')).toBeTruthy();
  });
  it.each(['scope', 'session', 'hidden', 'unmount'])('stops an active microphone on %s and fences later transcripts', async reason => {
    const session = { stop: vi.fn().mockResolvedValue(undefined), setMicrophoneMuted: vi.fn(), setOutputMuted: vi.fn() };
    const launcher = vi.fn<ProductTutorialVoiceLauncher>().mockResolvedValue(session);
    const view = render(<ProductTutorialVoiceQuestion account={account} lesson={PRODUCT_TUTORIAL_LESSONS[0]} openVoice={launcher} />);
    fireEvent.click(screen.getByLabelText('Allow microphone audio for this lesson'));
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    await screen.findByText('Spoken questions active');
    if (reason === 'unmount') view.unmount();
    else if (reason === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      fireEvent(document, new Event('visibilitychange'));
    } else view.rerender(<ProductTutorialVoiceQuestion account={{ ...account, ...(reason === 'scope' ? { tenantId: 'other' } : { sessionId: 'renewed' }) }} lesson={PRODUCT_TUTORIAL_LESSONS[0]} openVoice={launcher} />);
    expect(launcher.mock.calls[0][0].signal.aborted).toBe(true);
    expect(session.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(session.setOutputMuted).toHaveBeenCalledWith(true);
    expect(session.stop).toHaveBeenCalledTimes(1);
    act(() => launcher.mock.calls[0][0].onTurn({ speaker: 'assistant', text: 'Stale private answer' }));
    expect(screen.queryByText('Lesson Help: Stale private answer')).toBeNull();
    vi.restoreAllMocks();
  });
  it('bounds a stalled voice connection and stops any session that resolves after the deadline', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: Awaited<ReturnType<ProductTutorialVoiceLauncher>>) => void;
      const launcher = vi.fn<ProductTutorialVoiceLauncher>(() => new Promise(resolve => { finish = resolve; }));
      render(<ProductTutorialVoiceQuestion account={account} lesson={PRODUCT_TUTORIAL_LESSONS[0]} openVoice={launcher} />);
      fireEvent.click(screen.getByLabelText('Allow microphone audio for this lesson'));
      fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
      await act(async () => vi.advanceTimersByTime(20_000));
      expect(screen.getByRole('alert').textContent).toContain('took too long');
      expect(launcher.mock.calls[0][0].signal.aborted).toBe(true);
      const session = { stop: vi.fn().mockResolvedValue(undefined), setMicrophoneMuted: vi.fn(), setOutputMuted: vi.fn() };
      await act(async () => finish(session));
      expect(session.stop).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('sends only a gesture-requested current lesson question and renders answers as advisory text', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ answer: '<spawn/> Use Billing to inspect your subscription.' }));
    vi.stubGlobal('fetch', fetcher);
    render(<ProductTutorialAssistance account={account} lesson={PRODUCT_TUTORIAL_LESSONS.find(lesson => lesson.id === 'billing')!} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Lesson question'), { target: { value: 'Who bills my cloud?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI Help' }));
    await screen.findByText('<spawn/> Use Billing to inspect your subscription.');
    expect(document.querySelector('spawn')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/hosted/browser/onboarding/tutorial-help');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ expectedScope: { tenantId: 'org', userId: 'user' },
      context: { version: 3, step: 'billing', status: 'ready' }, question: 'Who bills my cloud?' });
  });
  it('cancels Help on a lesson/session change or explicit cancellation and ignores late answers', async () => {
    let finish!: (value: Response) => void;
    const fetcher = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<ProductTutorialAssistance account={account} lesson={PRODUCT_TUTORIAL_LESSONS[0]} />);
    const ask = () => { fireEvent.change(screen.getByLabelText('Lesson question'), { target: { value: 'Explain this lesson' } }); fireEvent.click(screen.getByRole('button', { name: 'Ask AI Help' })); };
    ask(); fireEvent.click(screen.getByRole('button', { name: 'Cancel AI Help' }));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => finish(Response.json({ answer: 'Cancelled answer' })));
    expect(screen.queryByText('Cancelled answer')).toBeNull();
    ask(); view.rerender(<ProductTutorialAssistance account={account} lesson={PRODUCT_TUTORIAL_LESSONS[1]} />);
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => finish(Response.json({ answer: 'Stale lesson answer' })));
    expect(screen.queryByText('Stale lesson answer')).toBeNull();
    expect((screen.getByLabelText('Lesson question') as HTMLTextAreaElement).value).toBe('');
  });
  it('AI Help outage leaves deterministic instructions, progress and exit usable', async () => {
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith('tutorial-help')) return Response.json({ error: 'unavailable' }, { status: 503 });
      return response(record(init?.method === 'POST' ? { disposition: 'paused', revision: 1 } : {}));
    });
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByText('Help with this lesson'));
    fireEvent.change(screen.getByLabelText('Lesson question'), { target: { value: 'What is a workspace?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI Help' }));
    await screen.findByText('AI Help is unavailable. You can continue with the lesson instructions.');
    expect(screen.getByRole('button', { name: 'Reviewed — next lesson' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await screen.findByText('Destination');
    expect(screen.queryByText('AI Help is unavailable. You can continue with the lesson instructions.')).toBeNull();
  });
  it('records recovery only after a pending retry receives an acknowledged saved record', async () => {
    let acknowledge!: (value: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { acknowledge = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry saving choice' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    const actions = () => vi.mocked(captureBrowserTelemetry).mock.calls.map(([, p]) => p.action);
    expect(actions()).toContain('waiting');
    expect(actions()).not.toContain('recovery');
    expect(actions()).not.toContain('explanation_reviewed');
    await act(async () => acknowledge(response(record({ revision: 1, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] }))));
    await screen.findByRole('heading', { name: 'Find your way around' });
    expect(actions().filter(action => action === 'recovery')).toHaveLength(1);
    expect(actions().filter(action => action === 'explanation_reviewed')).toHaveLength(1);
  });
  it('observes the saved pause before navigating to a real destination', async () => {
    const assign = vi.fn(() => {
      expect(vi.mocked(captureBrowserTelemetry).mock.calls.some(([, p]) => p.action === 'pause')).toBe(true);
    });
    vi.stubGlobal('window', Object.assign(Object.create(window), { location: { assign } }));
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ currentLessonId: 'billing' })))
      .mockResolvedValueOnce(response(record({ revision: 1, currentLessonId: 'billing', disposition: 'paused' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Understand the bills' });
    fireEvent.click(screen.getByRole('link', { name: 'Open billing' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/billing'));
    expect(vi.mocked(captureBrowserTelemetry).mock.calls.filter(([, p]) => p.action === 'pause')).toHaveLength(1);
  });
  it('opens the maintained Tauri voice settings route from the product guide', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', Object.assign(Object.create(window), { location: { assign } }));
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ currentLessonId: 'help' })))
      .mockResolvedValueOnce(response(record({ revision: 1, currentLessonId: 'help', disposition: 'paused' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Get help in context' });
    const voiceLink = await screen.findByRole('link', { name: 'Open voice' });
    expect(voiceLink.getAttribute('href')).toBe('/settings/voice');
    fireEvent.click(voiceLink);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/settings/voice'));
  });
  it('measures saved explanation reviews and recovery without domain success or private state', () => {
    const capture = vi.fn();
    const observer = createProductTutorialAnalytics(capture);
    const initial = record() as Parameters<typeof observer.update>[0];
    observer.update(initial); observer.update(initial);
    observer.update(initial, true); observer.update(initial, true);
    expect(capture.mock.calls.map(([, p]) => p.action)).toEqual(['start', 'lesson_displayed', 'waiting']);
    observer.update(record({ revision: 1, currentLessonId: 'billing', reviewedLessonIds: ['welcome'] }) as typeof initial);
    expect(capture.mock.calls.map(([, p]) => p.action)).toEqual(['start', 'lesson_displayed', 'waiting', 'lesson_displayed', 'explanation_reviewed', 'recovery']);
    const serialized = JSON.stringify(capture.mock.calls);
    expect(serialized).not.toContain('org'); expect(serialized).not.toContain('user');
    expect(serialized).not.toContain('session'); expect(serialized).not.toContain('step_confirmed');
    observer.help('unregistered-private-question');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('unregistered-private-question');
  });
  it('focuses the committed resume control after pause even when an animation frame precedes React commit', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    const fetcher = vi.fn().mockResolvedValueOnce(response(record()))
      .mockResolvedValueOnce(response(record({ revision: 1, disposition: 'paused' })))
      .mockResolvedValueOnce(response(record({ revision: 2, disposition: 'active' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    const resume = await screen.findByRole('button', { name: 'Resume product guide' });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    fireEvent.click(resume);
    const heading = await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
  it('preserves shell panel/search targets through the explicit pre-workspace entry seam', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'navigation' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    const launcher = await screen.findByRole('link', { name: 'Open launcher' });
    const params = new URL(launcher.getAttribute('href')!, 'https://portal.example').searchParams;
    expect(params.get('panel')).toBe('launcher');
    expect(params.get('firstRun')).toBe('deferred');
    expect(new URL(productTutorialDestination('/?q=plans', null), 'https://portal.example').searchParams.get('q')).toBe('plans');
    expect(productTutorialDestination('/billing', null)).toBe('/billing');
    expect(productTutorialDestination('/?panel=account', 'selected')).toBe('/?panel=account');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps Resume focused when the destination replaces its startup wrapper after guide exit', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record()))
      .mockResolvedValueOnce(response(record({ revision: 1, disposition: 'skipped' })));
    vi.stubGlobal('fetch', fetcher);
    function Destination({ controls }: { controls: ReactNode }) {
      const [mounted, setMounted] = useState(false);
      useEffect(() => setMounted(true), []);
      return <section key={String(mounted)} data-mounted={mounted}>{controls}</section>;
    }
    render(<AccountProductTutorial account={account}>{controls => <Destination controls={controls} />}</AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Skip guide' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume product guide' }).closest('section')?.dataset.mounted).toBe('true'));
    const resume = screen.getByRole('button', { name: 'Resume product guide' });
    await waitFor(() => expect(document.activeElement).toBe(resume));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps the paused lesson Help available beside the real product destination without a mutation', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'billing', disposition: 'paused' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Billing destination</p></AccountProductTutorial>);
    await screen.findByText('Billing destination');
    fireEvent.click(screen.getByText('Help with Understand the bills'));
    expect(screen.getByText(/Papercusp subscription, model\/provider usage/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume product guide' })).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('lets a modal destination place a single Help and resume control inside its interaction boundary', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ currentLessonId: 'account', disposition: 'paused' })))
      .mockResolvedValueOnce(response(record({ revision: 1, currentLessonId: 'account' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}>{controls => <section role="dialog" aria-label="Account">{controls}<p>Account destination</p></section>}</AccountProductTutorial>);
    const help = await screen.findByText('Help with Manage your account and preferences');
    const dialog = screen.getByRole('dialog', { name: 'Account' });
    expect(dialog.contains(help)).toBe(true);
    const resume = screen.getByRole('button', { name: 'Resume product guide' });
    expect(dialog.contains(resume)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Resume product guide' })).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(resume);
    const heading = await screen.findByRole('heading', { name: 'Manage your account and preferences' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('tutorial-progress'))).toBe(true);
  });
  it.each([null, 'preassigned'])('shows the enrolled guide before workspace first-run/Home with workspace=%s', async workspaceId => {
    const fetcher = vi.fn().mockResolvedValue(response(record())); vi.stubGlobal('fetch', fetcher);
    let mountedDestination = false;
    function Destination() { mountedDestination = true; return <p>Home/first-run</p>; }
    render(<AccountProductTutorial account={{ ...account, workspaceId }}><Destination /></AccountProductTutorial>);
    expect(screen.queryByText('Home/first-run')).toBeNull();
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    expect(mountedDestination).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('scope=account&version=3');
  });
  it('saves only reviewed explanations and resumes after pause without running product actions', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockResolvedValueOnce(response(record({ revision: 1, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })))
      .mockResolvedValueOnce(response(record({ revision: 2, disposition: 'paused', currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })))
      .mockResolvedValueOnce(response(record({ revision: 3, currentLessonId: 'navigation', reviewedLessonIds: ['welcome'] })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home/first-run</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    await screen.findByRole('heading', { name: 'Find your way around' });
    const saved = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(saved).toMatchObject({ version: 3, expectedRevision: 0, reviewedLessonIds: ['welcome'], expectedScope: { tenantId: 'org', userId: 'user' } });
    expect(saved).not.toHaveProperty('completed');
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await screen.findByText('Home/first-run');
    fireEvent.click(screen.getByRole('button', { name: 'Resume product guide' }));
    await screen.findByRole('heading', { name: 'Find your way around' });
    expect(fetcher.mock.calls.every(([url]) => String(url).includes('tutorial-progress'))).toBe(true);
  });
  it('retains an uncertain mutation key and adopts a conflicting tab without inventing completion', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(response(record({ revision: 5, currentLessonId: 'billing' }), 409));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed — next lesson' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry saving choice' }));
    await screen.findByRole('heading', { name: 'Understand the bills' });
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(screen.getByRole('alert').textContent).toContain('Another tab');
    expect(screen.getByRole('status').textContent).toContain('0 explanations');
  });
  it('keeps a returning unenrolled account on its existing destination, but exposes recovery on failed reads', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(null)).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const first = render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByText('Home'); first.unmount();
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Product guide unavailable' });
    expect(screen.queryByText('Home')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Papercusp' }));
    await screen.findByText('Home');
  });
  it.each([
    [401, 'Sign in again to load your guide.'],
    [403, 'Your account could not access the guide. Try again or continue to Papercusp.'],
    [503, 'Papercusp’s guide service is unavailable. Try again or continue to Papercusp.'],
    [429, 'Papercusp’s guide service is unavailable. Try again or continue to Papercusp.'],
    [404, 'Papercusp could not load your guide. Try again or continue to Papercusp.'],
  ] as const)('offers recovery for HTTP %s without blaming every failure on the session', async (status, message) => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'private backend details' }, { status }))
      .mockResolvedValueOnce(response(record()));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByText('private backend details')).toBeNull();
    const signIn = screen.queryByRole('link', { name: 'Sign in' });
    if (status === 401) expect(signIn?.getAttribute('href')).toBe('/api/hosted/auth/sign-in?intent=sign-in');
    else expect(signIn).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue to Papercusp' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
  it('replaces the sign-in suggestion when a retry returns a service failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(null, 401)).mockResolvedValueOnce(response(null, 503)));
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('link', { name: 'Sign in' });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByRole('alert')).textContent).toContain('guide service is unavailable');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
  it('suggests checking the connection for a rejected guide request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')));
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    expect((await screen.findByRole('alert')).textContent).toContain('Check your connection');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
  it.each([
    () => response(record({ scope: { tenantId: 'foreign', userId: 'user' } })),
    () => new Response('not JSON', { status: 200 }),
  ])('reports unreadable guide progress while preserving the account boundary', async failedResponse => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failedResponse()));
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    expect((await screen.findByRole('alert')).textContent).toContain('Your saved guide could not be read');
    expect(screen.queryByRole('heading', { name: 'Welcome to Papercusp' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to Papercusp' }));
    await screen.findByText('Home');
  });
  it('lets an unenrolled returning account explicitly start the tutorial', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(response(record({ revision: 1 })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    fireEvent.click(await screen.findByRole('button', { name: 'Start tutorial' }));
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ restart: true, expectedRevision: 0,
      expectedScope: { tenantId: account.tenantId, userId: account.userId }, disposition: 'active',
      currentLessonId: 'welcome', reviewedLessonIds: [] });
  });
  it('restarts a completed tutorial from Welcome only after the server acknowledges it', async () => {
    let acknowledge!: (value: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response(record({ revision: 4, disposition: 'closed', currentLessonId: 'billing', reviewedLessonIds: ['welcome', 'billing'] })))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { acknowledge = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart tutorial' }));
    expect(screen.queryByRole('heading', { name: 'Welcome to Papercusp' })).toBeNull();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ restart: true, expectedRevision: 4,
      disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] });
    await act(async () => acknowledge(response(record({ revision: 5 }))));
    expect((await screen.findByRole('heading', { name: 'Welcome to Papercusp' })).textContent).toBe('Welcome to Papercusp');
  });
  it('teaches billing and payment recovery without starting checkout or billing management', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(record({ currentLessonId: 'billing' })));
    vi.stubGlobal('fetch', fetcher);
    render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Understand the bills' });
    expect(screen.getByText(/review the price, currency and payment terms in Stripe/i)).toBeTruthy();
    expect(screen.getByText(/Test mode — no real charges/)).toBeTruthy();
    fireEvent.click(screen.getByText('Help with this lesson'));
    const help = screen.getByText(/Papercusp subscription, model\/provider usage/).textContent!;
    expect(help).toContain('bring your own cloud (BYOC)');
    expect(help).toContain('Only organization owners and billing admins');
    expect(help).toContain('Manage billing');
    expect(help).toContain('invoices');
    expect(help).toContain('per-payment receipts');
    expect(help).toContain('If a payment fails');
    expect(help).toContain('awaiting confirmation');
    expect(help).toContain('unavailable is not free');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toContain('tutorial-progress');
  });
  it('refuses foreign progress and cancels a pending save when the session expires', async () => {
    expect(validProductTutorialRecord(record({ scope: { tenantId: 'foreign', userId: 'user' } }), account)).toBe(false);
    expect(validProductTutorialRecord(record({ currentLessonId: 'unknown' }), account)).toBe(false);
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn().mockResolvedValueOnce(response(record())).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountProductTutorial account={account}><p>Home</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
    fireEvent.click(screen.getByRole('button', { name: 'Pause guide' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    view.rerender(<AccountProductTutorial account={account} sessionSignal="signed-out"><p>Home</p></AccountProductTutorial>);
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => resolve(response(record({ revision: 1, disposition: 'paused' }))));
    expect(screen.queryByText('Home')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Check your session' })).toBeTruthy();
  });
});
