// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { _resetActions } from '@papercusp/operator-core/lib/shortcut-bus';
import type { VoiceSessionStatus } from '../../lib/video/desktop-video-client';

// Capture the session callbacks + spy the session/capture (hoisted: referenced
// inside the vi.mock factories).
const h = vi.hoisted(() => ({
  captured: { opts: null as null | { onStatus?: (s: unknown) => void; onPeerFrame?: unknown } },
  session: {
    setMuted: vi.fn(),
    setCameraOn: vi.fn(),
    sendCamFrame: vi.fn(),
    videoPeers: vi.fn(() => [] as string[]),
    close: vi.fn(),
  },
  startCameraCapture: vi.fn(async () => ({
    stop: vi.fn(),
    encoder: { encode: vi.fn(), requestKeyframe: vi.fn(), reconfigure: vi.fn(), close: vi.fn() },
    stream: { getVideoTracks: () => [{ stop: vi.fn() }] },
  })),
}));

vi.mock('../../lib/video/desktop-video-client', () => ({
  connectDesktopVideo: (opts: { onStatus?: (s: unknown) => void }) => {
    h.captured.opts = opts;
    return h.session;
  },
}));
vi.mock('../../lib/video/camera-capture', () => ({ startCameraCapture: h.startCameraCapture }));
// Runtime-config port discovery (P-015 D-014) — resolve immediately in tests.
vi.mock('../../lib/voice/resolve-voice-ws-url', () => ({
  resolveDesktopVoiceWsUrl: () => Promise.resolve('ws://127.0.0.1:3076/api/desktop/voice'),
}));

import VideoGrid from './VideoGrid';
import GlobalShortcutDispatcher from '@/app/_components/GlobalShortcutDispatcher';

function fakeWebCodecs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.VideoEncoder = function () {} as never;
  g.VideoDecoder = function () {} as never;
  g.EncodedVideoChunk = function () {} as never;
}

beforeEach(() => {
  _resetActions();
  fakeWebCodecs();
  h.captured.opts = null;
  vi.clearAllMocks();
  // jsdom's unimplemented play() returns undefined; a real browser returns a
  // Promise. Keep the mocked camera preview from falsely entering error recovery.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => {
  cleanup();
  _resetActions();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.VideoEncoder;
  delete g.VideoDecoder;
  delete g.EncodedVideoChunk;
  vi.restoreAllMocks();
});

async function renderGrid() {
  const r = render(
    <NuqsTestingAdapter>
      <VideoGrid harnessSlug="harnessX" />
    </NuqsTestingAdapter>,
  );
  // Flush the (mocked) runtime-config URL resolution so the session connects.
  await act(async () => {});
  return r;
}

function pushStatus(status: VoiceSessionStatus) {
  act(() => {
    h.captured.opts?.onStatus?.(status);
  });
}

describe('<VideoGrid>', () => {
  it('connects for the harness and renders the control bar + empty state', async () => {
    await renderGrid();
    expect(h.captured.opts).not.toBeNull();
    expect(screen.getByText(/Waiting for others to join/)).toBeTruthy();
    expect(screen.getByRole('toolbar', { name: /call controls/i })).toBeTruthy();
    expect(screen.getByText(/Mute/)).toBeTruthy();
    expect(screen.getByText(/Camera/)).toBeTruthy();
    expect(screen.getByText(/Share screen/)).toBeTruthy();
    expect(screen.getByText(/Leave/)).toBeTruthy();
  });

  it('renders a tile per peer and flags the active speaker', async () => {
    await renderGrid();
    pushStatus({
      channel: { id: 'vid-harnessX' },
      muted: false,
      identity: { id: 'me', label: 'Me' },
      peers: [
        { id: 'a', label: 'Alice', muted: false, speaking: false, cameraOn: false },
        { id: 'b', label: 'Bob', muted: false, speaking: true, cameraOn: false },
      ],
    });
    expect(screen.getByLabelText('Alice')).toBeTruthy();
    const bob = screen.getByLabelText('Bob (speaking)');
    expect(bob.getAttribute('data-speaking')).toBe('true');
    // waiting state is gone
    expect(screen.queryByText(/Waiting for others to join/)).toBeNull();
  });

  it('camera button is enabled when WebCodecs is available (not audio-only)', async () => {
    await renderGrid();
    const cam = screen.getByText(/Camera/).closest('button')!;
    expect(cam.hasAttribute('disabled')).toBe(false);
  });

  it('toggling mute drives the session', async () => {
    await renderGrid();
    fireEvent.click(screen.getByText(/Mute/));
    // nuqs updates vmute → re-render → effect calls setMuted(true)
    await screen.findByText(/Unmute/);
    expect(h.session.setMuted).toHaveBeenCalledWith(true);
  });

  it('Leave tears down the session', async () => {
    await renderGrid();
    fireEvent.click(screen.getByText(/Leave/));
    expect(h.session.close).toHaveBeenCalled();
  });

  it('closes the session on unmount', async () => {
    const { unmount } = await renderGrid();
    unmount();
    expect(h.session.close).toHaveBeenCalled();
  });
});

describe('camera keyboard dispatch', () => {
  async function mount() {
    const result = render(
      <NuqsTestingAdapter>
        <GlobalShortcutDispatcher />
        <VideoGrid harnessSlug="harnessX" />
        <input aria-label="Composer" />
        <textarea aria-label="Editor" />
        <select aria-label="Choice"><option>One</option></select>
      </NuqsTestingAdapter>,
    );
    await act(async () => {});
    return result;
  }

  function press(target: EventTarget) {
    const event = new KeyboardEvent('keydown', {
      key: 'V', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    act(() => { target.dispatchEvent(event); });
    return event;
  }

  it('toggles the mounted camera with the real dispatcher and binding', async () => {
    await mount();
    expect(press(window).defaultPrevented).toBe(true);
    expect((await screen.findByRole('button', { name: /Stop camera/ })).getAttribute('aria-pressed')).toBe('true');
    expect(h.startCameraCapture).toHaveBeenCalledTimes(1);
    expect(press(window).defaultPrevented).toBe(true);
    expect((await screen.findByRole('button', { name: /Camera/ })).getAttribute('aria-pressed')).toBe('false');
  });

  it('leaves input, textarea and select keys unclaimed while the camera binding is live', async () => {
    await mount();
    for (const label of ['Composer', 'Editor', 'Choice']) {
      expect(press(screen.getByLabelText(label)).defaultPrevented).toBe(false);
    }
    expect(screen.getByRole('button', { name: /Camera/ }).getAttribute('aria-pressed')).toBe('false');
    expect(h.startCameraCapture).not.toHaveBeenCalled();
    expect(press(window).defaultPrevented).toBe(true);
    expect((await screen.findByRole('button', { name: /Stop camera/ })).getAttribute('aria-pressed')).toBe('true');
  });

  it('releases the camera binding when its surface unmounts', async () => {
    const result = await mount();
    result.rerender(
      <NuqsTestingAdapter><GlobalShortcutDispatcher /></NuqsTestingAdapter>,
    );
    expect(h.session.close).toHaveBeenCalledTimes(1);
    expect(press(window).defaultPrevented).toBe(false);
    expect(h.startCameraCapture).not.toHaveBeenCalled();
  });
});
