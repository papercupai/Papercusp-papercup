// @vitest-environment jsdom
import { useReducer } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTutorialState, tutorialReducer, tutorialSteps } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson';
import { CloudTutorialGuide } from './cloud-tutorial-guide';
import { CloudTutorialAssistance } from './cloud-tutorial-assistance';
import { setVoiceOutputMuted, updateVoiceConfig } from '@/app/_components/voice/voice-mode';
import { loadVoicePrefsClient, setVoicePrefsClient } from '@/app/_components/voice/voice-prefs-client';
vi.mock('./cloud-tutorial-adapter', () => ({ CloudTutorialHighlight: () => null }));
vi.mock('@/app/_components/OperatorChat', () => ({ OperatorChat: ({ messages, onSend, error, busy }: { messages: Array<{ content: string }>; onSend: (q: string) => void; error: string | null; busy: boolean }) => <>
  {messages.map((m, i) => <p key={i}>{m.content}</p>)}{error && <p role="alert">{error}</p>}
  <button disabled={busy} onClick={() => onSend('Why do I need project permission?')}>Ask about this step</button>
</> }));
const scope = { tenantId: 'tenant-a', userId: 'user-a', workspaceId: 'workspace-a' };
const audio: FakeAudio[] = [];
let rejectPlayback = false;
class FakeAudio {
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  play = vi.fn(async () => { if (rejectPlayback) throw new DOMException('Playback blocked', 'NotAllowedError'); }); pause = vi.fn(); removeAttribute = vi.fn();
  constructor(public src: string) { audio.push(this); }
}
const requests: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal }> = [];
const fixtureFetch: typeof fetch = async (url, options) => {
  if (!String(url).includes('/onboarding/tutorial-')) return Response.json({ enabled: false });
  const body = JSON.parse(options!.body as string); requests.push({ url: String(url), body, signal: options!.signal! });
  return String(url).includes('tutorial-speech') ? new Response(new Blob(['audio'], { type: 'audio/wav' })) : Response.json({ answer: 'Use the project permission checks in the connection form.' });
};
function Fixture({ workspaceId = scope.workspaceId, onCheckAgain }: { workspaceId?: string; onCheckAgain?: () => void }) {
  const selected = { ...scope, workspaceId };
  const [state, dispatch] = useReducer(tutorialReducer, tutorialReducer(createTutorialState(selected), { type: 'observe', observation: { scope: selected, revision: 1, access: 'allowed' } }));
  return <CloudTutorialGuide state={state} dispatch={dispatch} onCheckAgain={onCheckAgain} assistance={(step, status) => <CloudTutorialAssistance
    key={`${workspaceId}:${step.id}`} scope={selected} step={step} status={status} />} />;
}
beforeEach(() => {
  audio.length = 0; requests.length = 0; rejectPlayback = false;
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
  setVoiceOutputMuted(false);
  setVoicePrefsClient({ ...loadVoicePrefsClient(), ttsEngine: 'openai' }); updateVoiceConfig({ roleVoices: { 'system:operator': 'nova' } });
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('fetch', vi.fn(fixtureFetch));
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:lesson-audio'; } static revokeObjectURL() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Guide output-only voice lifecycle', () => {
  it.each([
    { step: 'workspace', status: 'waiting', category: 'workspace-not-ready', instruction: /Open the selected workspace readiness details/ },
    { step: 'task', status: 'error', category: 'request-failed', instruction: /The guide has not diagnosed the underlying error/ },
  ] as const)('renders public beginner recovery and sends the exact bounded Help/TTS context: $category', async ({ step, status, category, instruction }) => {
    const lessonStep = tutorialSteps(2).find(candidate => candidate.id === step)!;
    render(<CloudTutorialAssistance scope={scope} version={2} step={lessonStep} status={status} />);
    expect(screen.getByText(instruction)).toBeTruthy();
    await waitFor(() => expect(audio[0]?.play).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }));
    await screen.findByText('Use the project permission checks in the connection form.');
    await waitFor(() => expect(requests.filter(request => request.url.includes('tutorial-speech'))).toHaveLength(2));
    expect(requests.filter(request => request.url.includes('tutorial-help'))).toHaveLength(1);
    for (const request of requests) {
      expect(request.body.expectedScope).toEqual(scope);
      // An exact object rejects private diagnostics or extra context fields.
      expect(request.body.context).toEqual({ step, status, version: 2, recoveryCategory: category });
    }
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST').every(([url]) =>
      String(url).includes('/onboarding/tutorial-') || String(url).includes('/analytics/'),
    )).toBe(true);
  });

  it('plays current guidance and permitted help with selected settings, without capture or progression', async () => {
    const microphone = vi.fn(); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: microphone } });
    render(<Fixture />);
    await waitFor(() => expect(audio[0]?.play).toHaveBeenCalledOnce());
    expect(requests[0].body).toMatchObject({ engine: 'openai', voiceId: 'nova', context: { step: 'connection' } });
    expect(requests[0].body.question).toContain('Connect Google Cloud');
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }));
    await screen.findByText('Use the project permission checks in the connection form.');
    await waitFor(() => expect(audio[1]?.play).toHaveBeenCalledOnce());
    expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy(); expect(microphone).not.toHaveBeenCalled();
    expect(requests.find(r => r.url.includes('tutorial-help'))?.body).toEqual({ expectedScope: scope, context: { step: 'connection', status: 'ready' }, question: 'Why do I need project permission?' });
  });
  it('honors mute, stop and replay and keeps visible text', async () => {
    render(<Fixture />); await waitFor(() => expect(audio.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop speech' })); expect(audio[0].pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replay speech' })); await waitFor(() => expect(audio.length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mute guide' })); expect(audio[1].pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Replay speech' })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/Use an injected credential reference in the connection form/).map(node => node.textContent))
      .toHaveLength(2);
    for (const node of screen.getAllByText(/Use an injected credential reference in the connection form/)) {
      expect(node.textContent).toContain('Never paste API keys, service-account JSON or tokens into the form or Help.');
    }
  });
  it.each(['Pause', 'Close guide', 'Skip lesson'])('cancels current audio on %s', async action => {
    render(<Fixture />); await waitFor(() => expect(audio.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: action })); expect(audio[0].pause).toHaveBeenCalled();
    expect(requests[0].signal.aborted).toBe(true);
  });
  it('cancels both help and late speech when its workspace view is removed', async () => {
    let resolveSpeech!: (r: Response) => void;
    let held = false;
    vi.mocked(fetch).mockImplementation((_url, options) => {
      if (held || !String(_url).includes('tutorial-speech')) return fixtureFetch(_url, options);
      held = true; requests.push({ url: String(_url), body: JSON.parse(options!.body as string), signal: options!.signal! }); return new Promise(resolve => { resolveSpeech = resolve; });
    });
    const view = render(<Fixture />); await waitFor(() => expect(requests.length).toBe(1));
    view.unmount(); expect(requests[0].signal.aborted).toBe(true);
    await act(async () => resolveSpeech(new Response(new Blob(['late'])))); expect(audio).toHaveLength(0);
    render(<Fixture workspaceId="workspace-b" />); await waitFor(() => expect(audio.length).toBe(1));
    expect(requests.at(-1)!.body.expectedScope).toMatchObject({ workspaceId: 'workspace-b' });
  });
  it('leaves deterministic controls usable during TTS outage and blocked autoplay', async () => {
    let failed = false;
    vi.mocked(fetch).mockImplementation((url, options) => {
      if (failed || !String(url).includes('tutorial-speech')) return fixtureFetch(url, options);
      failed = true; return Promise.resolve(new Response('', { status: 503 }));
    }); render(<Fixture />);
    await screen.findByText(/Speech could not be played/);
    rejectPlayback = true;
    fireEvent.click(screen.getByRole('button', { name: 'Replay speech' }));
    await waitFor(() => expect(audio.length).toBe(1));
    await screen.findByText(/Speech could not be played/);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy(); expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy();
  });
  it('does not synthesize or capture when output was already muted', async () => {
    setVoiceOutputMuted(true); render(<Fixture />);
    expect(screen.getByText('Guide speech is muted.')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('tutorial-speech'))).toHaveLength(0);
  });
  it('times out slow help, keeps lesson controls usable and ignores a late answer', async () => {
    const checkAgain = vi.fn();
    render(<Fixture onCheckAgain={checkAgain} />); await waitFor(() => expect(audio.length).toBe(1));
    let resolveHelp!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((_url, options) => {
      if (!String(_url).includes('tutorial-help')) return fixtureFetch(_url, options);
      requests.push({ url: String(_url), body: JSON.parse(options!.body as string), signal: options!.signal! });
      return new Promise(resolve => { resolveHelp = resolve; });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }));
    expect(screen.getByRole('button', { name: 'Ask about this step' })).toHaveProperty('disabled', true);
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(check).toHaveProperty('disabled', false);
    fireEvent.click(check);
    expect(checkAgain).toHaveBeenCalledOnce();
    expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy();
    await screen.findByText(/AI help is taking too long/, {}, { timeout: 17_000 });
    expect(requests.at(-1)!.signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    await act(async () => resolveHelp(Response.json({ answer: 'Late answer from obsolete request' })));
    expect(screen.queryByText('Late answer from obsolete request')).toBeNull();
    expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Your lesson is paused.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume guide' }));
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveProperty('disabled', false);
  }, 20_000);
  it('keeps the fixed lesson operable after help provider failure without confirming a step', async () => {
    const checkAgain = vi.fn();
    vi.mocked(fetch).mockImplementation((url, options) => String(url).includes('tutorial-help')
      ? Promise.resolve(new Response('', { status: 503 })) : fixtureFetch(url, options));
    render(<Fixture onCheckAgain={checkAgain} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this step' }));
    await screen.findByText(/AI help is unavailable/);
    const check = screen.getByRole('button', { name: 'Check again' });
    expect(check).toHaveProperty('disabled', false);
    fireEvent.click(check);
    expect(checkAgain).toHaveBeenCalledOnce();
    expect(screen.getByText('0 of 6 steps confirmed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Your lesson is paused.')).toBeTruthy();
  });
});
