/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useUiPresence } from './use-ui-presence';

const { callRoute, getOrCreateClientId } = vi.hoisted(() => ({
  callRoute: vi.fn(),
  getOrCreateClientId: vi.fn(),
}));

vi.mock('@papercusp/operator-core/lib/call-tool', () => ({ callRoute }));
vi.mock('@papercusp/operator-core/lib/ui/client-id', () => ({ getOrCreateClientId }));

function hangUntilAborted(): void {
  callRoute.mockImplementation((_path: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  callRoute.mockReset().mockResolvedValue(new Response('{}'));
  getOrCreateClientId.mockReset().mockReturnValue('presence-test-client');
  window.history.replaceState({}, '', '/adv?ws=papercusp-workspace');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useUiPresence starvation prevention', () => {
  it('advertises native desktop capability separately from ordinary browser tabs', () => {
    renderHook(() => useUiPresence());
    expect(JSON.parse(callRoute.mock.calls[0][1].body).viewport.nativeDesktop).toBe(false);
    cleanup();
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    renderHook(() => useUiPresence());
    expect(JSON.parse(callRoute.mock.calls.at(-1)![1].body).viewport.nativeDesktop).toBe(true);
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  it('demotes presence to background work and gives it a cancellation signal', () => {
    renderHook(() => useUiPresence());
    expect(callRoute).toHaveBeenCalledWith('/api/ui/presence', expect.objectContaining({
      method: 'POST',
      papercuspRequestClass: 'background-sync',
      keepalive: true,
      signal: expect.any(AbortSignal),
    }));
    expect(JSON.parse(callRoute.mock.calls[0][1].body)).toMatchObject({
      client_id: 'presence-test-client',
      url: window.location.href,
    });
  });

  it('keeps initial retries and URL changes single-flight while IPC is unavailable', async () => {
    hangUntilAborted();
    renderHook(() => useUiPresence());
    window.history.pushState({}, '', '/adv?tab=hud');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callRoute).toHaveBeenCalledTimes(1);
  });

  it('aborts a stuck request before the next heartbeat and can recover on that heartbeat', async () => {
    hangUntilAborted();
    renderHook(() => useUiPresence());
    const signal = callRoute.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    callRoute.mockResolvedValue(new Response('{}'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callRoute).toHaveBeenCalledTimes(2);
    expect(callRoute.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it('does not accumulate pending requests across repeated missing-IPC heartbeat cycles', async () => {
    hangUntilAborted();
    renderHook(() => useUiPresence());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(callRoute).toHaveBeenCalledTimes(4);
    for (const [, init] of callRoute.mock.calls.slice(0, -1)) {
      expect(init.signal.aborted).toBe(true);
    }
  });

  it('aborts the pending request and stops all producers on unmount', async () => {
    hangUntilAborted();
    const { unmount } = renderHook(() => useUiPresence());
    const signal = callRoute.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callRoute).toHaveBeenCalledTimes(1);
  });

  it('clears a settled request deadline rather than aborting successful telemetry later', async () => {
    renderHook(() => useUiPresence());
    const signal = callRoute.mock.calls[0][1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signal.aborted).toBe(false);
  });

  it('does not start requests or timers when a client id is unavailable', async () => {
    getOrCreateClientId.mockReturnValue(null);
    renderHook(() => useUiPresence());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callRoute).not.toHaveBeenCalled();
  });
});
