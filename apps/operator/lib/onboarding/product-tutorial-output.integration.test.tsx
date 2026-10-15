/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountProductTutorial, type ProductTutorialAccount } from '@papercusp/operator-ui/onboarding';

vi.mock('../../../../packages/operator-ui/src/browser-telemetry', () => ({ captureBrowserTelemetry: vi.fn() }));
const account: ProductTutorialAccount = { tenantId: 'tutorial-org', userId: 'tutorial-user', sessionId: 'tutorial-session', workspaceId: null };
const progress = { scope: { tenantId: account.tenantId, userId: account.userId }, version: 3, revision: 0, mutationId: null,
  disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [] };
const audio: FakeAudio[] = [];
let blocked = false;
class FakeAudio {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(async () => { if (blocked) throw new Error('autoplay blocked'); });
  pause = vi.fn(); removeAttribute = vi.fn();
  constructor(public src: string) { audio.push(this); }
}
const requests: Array<{ url: string; body: any; signal: AbortSignal }> = [];
let record: any;
const fetcher = vi.fn<typeof fetch>(async (url, init) => {
  if (init?.method !== 'POST') return Response.json({ record });
  const body = JSON.parse(String(init.body));
  requests.push({ url: String(url), body, signal: init.signal! });
  if (String(url).includes('tutorial-speech')) return new Response(new Blob(['audio'], { type: 'audio/wav' }));
  if (String(url).includes('tutorial-help')) return Response.json({ answer: 'Use the current lesson instructions.' });
  record = { ...record, ...body, revision: record.revision + 1 };
  return Response.json({ record });
});
const microphone = vi.fn();
beforeEach(() => {
  record = { ...progress, reviewedLessonIds: [] }; audio.length = 0; requests.length = 0; blocked = false;
  fetcher.mockClear(); microphone.mockClear();
  vi.stubGlobal('fetch', fetcher); vi.stubGlobal('Audio', FakeAudio);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lesson'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function openHelp() {
  await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
  const summary = screen.getByText('Help with this lesson');
  const details = summary.parentElement as HTMLDetailsElement;
  details.open = true; fireEvent(details, new Event('toggle'));
  await screen.findByRole('button', { name: 'Speak lesson' });
}
async function speak() {
  await openHelp();
  fireEvent.click(screen.getByRole('button', { name: 'Speak lesson' }));
  await waitFor(() => expect(audio.at(-1)?.play).toHaveBeenCalledOnce());
}
describe('full-product output speech', () => {
  it('speaks public guidance and permitted text Help with stop/mute/replay, without capture or guide writes', async () => {
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await speak();
    expect(requests[0].body).toEqual({ expectedScope: progress.scope, context: { version: 3, step: 'welcome', status: 'ready' },
      question: expect.stringContaining('Welcome to Papercusp'), engine: 'kokoro' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop speech' })); expect(audio[0].pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replay speech' })); await waitFor(() => expect(audio).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mute guide' })); expect(audio[1].pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Replay speech' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unmute guide' }));
    fireEvent.change(screen.getByLabelText('Lesson question'), { target: { value: 'What should I read?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI Help' }));
    await screen.findByText('Use the current lesson instructions.');
    fireEvent.click(screen.getByRole('button', { name: 'Speak answer' })); await waitFor(() => expect(audio).toHaveLength(3));
    expect(requests.at(-1)?.body.question).toBe('Use the current lesson instructions.');
    expect(requests.every(row => /tutorial-(speech|help)$/.test(row.url))).toBe(true);
    expect(microphone).not.toHaveBeenCalled();
    expect(screen.getByText('0 explanations reviewed. Product tasks are verified separately.')).toBeTruthy();
  });
  it.each(['signed-out', 'expired'] as const)('silences current speech on %s and ignores late audio callbacks', async sessionSignal => {
    const view = render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await speak();
    view.rerender(<AccountProductTutorial account={account} sessionSignal={sessionSignal}><p>Destination</p></AccountProductTutorial>);
    await screen.findByRole('heading', { name: 'Check your session' });
    expect(audio[0].pause).toHaveBeenCalled(); expect(requests[0].signal.aborted).toBe(true);
    act(() => audio[0].onended?.());
    expect(screen.queryByText('Speech is ready.')).toBeNull();
    expect(requests).toHaveLength(1); expect(microphone).not.toHaveBeenCalled();
  });
  it('aborts old workspace output and Help before a late response can be played or displayed', async () => {
    let settle!: (response: Response) => void;
    const view = render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>);
    await speak();
    fetcher.mockImplementationOnce(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)), signal: init!.signal! });
      return new Promise(resolve => { settle = resolve; });
    });
    fireEvent.change(screen.getByLabelText('Lesson question'), { target: { value: 'Old workspace question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI Help' }));
    const pending = requests.at(-1)!;
    view.rerender(<AccountProductTutorial account={{ ...account, workspaceId: 'authorized-workspace' }}><p>Destination</p></AccountProductTutorial>);
    expect(pending.signal.aborted).toBe(true); expect(audio[0].pause).toHaveBeenCalled();
    await act(async () => settle(Response.json({ answer: 'Old workspace private answer' })));
    expect(screen.queryByText('Old workspace private answer')).toBeNull(); expect(audio).toHaveLength(1);
  });
  it.each(['Pause guide', 'Skip guide'])('stops output before %s settles, including a refused save', async action => {
    let settle!: (response: Response) => void;
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>); await speak();
    fetcher.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: action }));
    await screen.findByText('Saving your choice…');
    expect(audio[0].pause).toHaveBeenCalled(); expect(requests[0].signal.aborted).toBe(true);
    await act(async () => settle(Response.json({ record }, { status: 503 })));
    await screen.findByRole('button', { name: 'Retry saving choice' });
    expect(audio).toHaveLength(1); expect(screen.getByRole('heading', { name: 'Welcome to Papercusp' })).toBeTruthy();
  });
  it('stops a removed lesson before delayed synthesis returns', async () => {
    let settle!: (response: Response) => void;
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>); await openHelp();
    fetcher.mockImplementationOnce(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init!.body)), signal: init!.signal! });
      return new Promise(resolve => { settle = resolve; });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Speak lesson' })); const synthesis = requests.at(-1)!;
    fireEvent.click(screen.getByRole('button', { name: 'Understand the bills' }));
    await screen.findByRole('heading', { name: 'Understand the bills' }); expect(synthesis.signal.aborted).toBe(true);
    await act(async () => settle(new Response(new Blob(['obsolete audio']))));
    expect(audio).toHaveLength(0); expect(microphone).not.toHaveBeenCalled();
  });
  it('retains text and navigation through provider failure and blocked playback', async () => {
    render(<AccountProductTutorial account={account}><p>Destination</p></AccountProductTutorial>); await openHelp();
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Speak lesson' }));
    await screen.findByText(/Speech could not be played/);
    blocked = true; fireEvent.click(screen.getByRole('button', { name: 'Replay speech' }));
    await waitFor(() => expect(audio).toHaveLength(1)); await screen.findByText(/Speech could not be played/);
    expect(screen.getByRole('button', { name: 'Reviewed — next lesson' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('heading', { name: 'Welcome to Papercusp' })).toBeTruthy(); expect(microphone).not.toHaveBeenCalled();
  });
});
