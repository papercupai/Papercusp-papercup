/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountProductTutorial,
  type ProductTutorialAccount,
  type ProductTutorialVoiceLauncher,
} from '@papercusp/operator-ui/onboarding';

vi.mock('../../../../packages/operator-ui/src/browser-telemetry', () => ({ captureBrowserTelemetry: vi.fn() }));

const account: ProductTutorialAccount = {
  tenantId: 'tutorial-org', userId: 'tutorial-user', sessionId: 'tutorial-session', workspaceId: null,
};
const progress = {
  scope: { tenantId: account.tenantId, userId: account.userId }, version: 3,
  revision: 0, mutationId: null, disposition: 'active', currentLessonId: 'welcome', reviewedLessonIds: [],
};
const response = (status = 200) => Response.json({ record: progress }, { status });

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function transport() {
  const session = {
    stop: vi.fn().mockResolvedValue(undefined),
    setMicrophoneMuted: vi.fn().mockResolvedValue(undefined),
    setOutputMuted: vi.fn(),
  };
  const openVoice = vi.fn<ProductTutorialVoiceLauncher>().mockResolvedValue(session);
  return { session, openVoice };
}

async function startQuestions() {
  await screen.findByRole('heading', { name: 'Welcome to Papercusp' });
  fireEvent.click(screen.getByText('Help with this lesson'));
  const consent = await screen.findByLabelText('Allow microphone audio for this lesson');
  expect(screen.getByRole('button', { name: 'Start spoken questions' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(consent);
  fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
  await screen.findByText('Spoken questions active');
}

describe('active account guide voice lifecycle', () => {
  for (const sessionSignal of ['signed-out', 'expired'] as const) {
    it(`stops an active conversation on ${sessionSignal} before any guide mutation`, async () => {
      const { session, openVoice } = transport();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
      vi.stubGlobal('fetch', fetcher);
      const view = render(<AccountProductTutorial account={account} openVoice={openVoice}><p>Destination</p></AccountProductTutorial>);
      await startQuestions();
      const input = openVoice.mock.calls[0][0];
      expect(input.signal.aborted).toBe(false);
      expect(session.stop).not.toHaveBeenCalled();

      view.rerender(<AccountProductTutorial account={account} sessionSignal={sessionSignal} openVoice={openVoice}><p>Destination</p></AccountProductTutorial>);
      await screen.findByRole('heading', { name: 'Check your session' });
      expect(input.signal.aborted).toBe(true);
      expect(session.setMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(session.setOutputMuted).toHaveBeenCalledWith(true);
      expect(session.stop).toHaveBeenCalledTimes(1);
      act(() => input.onTurn({ speaker: 'assistant', text: 'Late private lesson answer' }));
      expect(screen.queryByText(/Late private lesson answer/)).toBeNull();
      expect(screen.queryByLabelText('Allow microphone audio for this lesson')).toBeNull();
      expect(openVoice).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }

  it('stops on workspace selection and requires fresh consent before a new conversation', async () => {
    const { session, openVoice } = transport();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetcher);
    const view = render(<AccountProductTutorial account={account} openVoice={openVoice}><p>Destination</p></AccountProductTutorial>);
    await startQuestions();
    const original = openVoice.mock.calls[0][0];
    const selected = { ...account, workspaceId: 'authorized-workspace' };
    view.rerender(<AccountProductTutorial account={selected} openVoice={openVoice}><p>Destination</p></AccountProductTutorial>);
    await waitFor(() => expect(session.stop).toHaveBeenCalledTimes(1));
    expect(original.signal.aborted).toBe(true);
    expect(session.setMicrophoneMuted).toHaveBeenCalledWith(true);
    expect(session.setOutputMuted).toHaveBeenCalledWith(true);
    expect((screen.getByLabelText('Allow microphone audio for this lesson') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Start spoken questions' }).hasAttribute('disabled')).toBe(true);
    act(() => original.onTurn({ speaker: 'assistant', text: 'Old workspace answer' }));
    expect(screen.queryByText(/Old workspace answer/)).toBeNull();
    expect(openVoice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Allow microphone audio for this lesson'));
    fireEvent.click(screen.getByRole('button', { name: 'Start spoken questions' }));
    await screen.findByText('Spoken questions active');
    expect(openVoice).toHaveBeenCalledTimes(2);
    expect(openVoice.mock.calls[1][0].account).toEqual(selected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  for (const action of ['Pause guide', 'Skip guide']) {
    it(`stops capture while ${action} is pending and keeps consent off after a refused save`, async () => {
      const { session, openVoice } = transport();
      let settle!: (value: Response) => void;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response())
        .mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }));
      vi.stubGlobal('fetch', fetcher);
      render(<AccountProductTutorial account={account} openVoice={openVoice}><p>Destination</p></AccountProductTutorial>);
      await startQuestions();
      const original = openVoice.mock.calls[0][0];
      fireEvent.click(screen.getByRole('button', { name: action }));
      await screen.findByText('Saving your choice…');
      expect(original.signal.aborted).toBe(true);
      expect(session.setMicrophoneMuted).toHaveBeenCalledWith(true);
      expect(session.setOutputMuted).toHaveBeenCalledWith(true);
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(screen.queryByLabelText('Allow microphone audio for this lesson')).toBeNull();
      act(() => original.onTurn({ speaker: 'assistant', text: 'Obsolete spoken completion' }));
      expect(screen.queryByText(/Obsolete spoken completion/)).toBeNull();

      await act(async () => settle(response(503)));
      await screen.findByRole('button', { name: 'Retry saving choice' });
      expect(screen.getByRole('heading', { name: 'Welcome to Papercusp' })).toBeTruthy();
      expect((screen.getByLabelText('Allow microphone audio for this lesson') as HTMLInputElement).checked).toBe(false);
      expect(screen.getByRole('button', { name: 'Start spoken questions' }).hasAttribute('disabled')).toBe(true);
      expect(openVoice).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(writes).toHaveLength(1);
      expect(String(writes[0][0])).toContain('/onboarding/tutorial-progress');
      expect(JSON.parse(String(writes[0][1]!.body))).toMatchObject({
        disposition: action === 'Pause guide' ? 'paused' : 'skipped',
        currentLessonId: 'welcome', reviewedLessonIds: [],
      });
      expect(JSON.parse(String(writes[0][1]!.body))).not.toHaveProperty('completed');
    });
  }
});
