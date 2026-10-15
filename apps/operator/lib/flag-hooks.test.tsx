/**
 * @vitest-environment jsdom
 *
 * RTL tests for useFlag — reads the snapshot, subscribes, re-renders on change,
 * and falls back to FLAG_DEFAULTS when a key is absent.
 * Run with: cd apps/operator && npx vitest run lib/flag-hooks.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { OperatorWorkspaceLocationProvider } from '@papercusp/operator-ui';

// Shared holder so the mocked flag-store/sync-bus callbacks can hand their
// callbacks back to the test.
const h = vi.hoisted(() => ({
  emit: (_v: Record<string, boolean>) => {},
  syncEmit: (_v: { name: string }) => {},
  loadFlags: vi.fn(async () => {}),
}));

vi.mock('@papercusp/flags', () => ({
  FLAG_DEFAULTS: { myFeature: false },
  FLAGS_CHANGED_EVENT: 'flags.changed',
}));
vi.mock('@papercusp/flags/client', () => ({
  getFlagSnapshot: () => ({ flags: {} as Record<string, boolean> }),
  loadFlags: h.loadFlags,
  subscribe: (fn: (v: Record<string, boolean>) => void) => {
    h.emit = fn;
    return () => {};
  },
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: (fn: (v: { name: string }) => void) => {
    h.syncEmit = fn;
    return () => {};
  },
}));

import { useFlag } from './flag-hooks';

afterEach(cleanup);

describe('useFlag', () => {
  it('uses hosted defaults without loading or subscribing to the desktop flag store', () => {
    h.loadFlags.mockClear();
    const { result } = renderHook(() => useFlag('myFeature' as never), {
      wrapper: ({ children }) => <OperatorWorkspaceLocationProvider location="cloud">{children}</OperatorWorkspaceLocationProvider>,
    });
    expect(result.current).toBe(false);
    expect(h.loadFlags).not.toHaveBeenCalled();
    act(() => h.emit({ myFeature: true }));
    expect(result.current).toBe(false);
  });

  it('starts at the default when the snapshot lacks the key', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    expect(result.current).toBe(false);
  });

  it('re-renders to the new value when the flag stream emits', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    act(() => h.emit({ myFeature: true }));
    expect(result.current).toBe(true);
  });

  it('falls back to the default when an update omits the key', () => {
    const { result } = renderHook(() => useFlag('myFeature' as never));
    act(() => h.emit({ myFeature: true }));
    expect(result.current).toBe(true);
    act(() => h.emit({})); // key absent → default false
    expect(result.current).toBe(false);
  });
});

describe('flags-sync-bus wiring', () => {
  it('reloads the bootstrap payload for flag events without opening a private stream', async () => {
    renderHook(() => useFlag('myFeature' as never));
    h.loadFlags.mockClear();

    h.syncEmit({ name: 'unrelated.event' });
    expect(h.loadFlags).not.toHaveBeenCalled();

    h.syncEmit({ name: 'flags.changed' });
    await expect.poll(() => h.loadFlags).toHaveBeenCalledTimes(1);
  });
});
