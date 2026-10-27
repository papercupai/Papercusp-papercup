/**
 * @vitest-environment jsdom
 *
 * Tests for selectToolStates (pure helper) and the useStateSnapshots hook's
 * connectivity wiring. PendingCardsBar.test.tsx (PR 1b) covers the hook's
 * consumer-facing `cards`/`connected` behavior via a full mock of this
 * module — it never exercises this hook's OWN body, so the
 * onOpen/onError → shared-connectivity-store wiring added alongside the
 * console-flood investigation (continuing session
 * fc14943c-6984-4791-905b-194e0d8665d4) is covered directly here instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

type StreamOptions = { onOpen?: () => void; onError?: () => void; handlers: Record<string, (raw: string) => void> };
let captured: StreamOptions | null = null;
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: StreamOptions) => {
    captured = opts;
    return { close: vi.fn() };
  },
}));

const reportReachable = vi.fn();
const reportUnreachable = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  reportSyncReachable: () => reportReachable(),
  reportSyncUnreachable: () => reportUnreachable(),
}));

import { _resetSnapshotStore, selectToolStates, useStateSnapshots, type SnapshotEnvelope } from './use-state-snapshots';

function env(runId: string, toolState?: unknown): SnapshotEnvelope {
  return {
    runId,
    version: 1,
    snapshot: { openCards: [], ...(toolState !== undefined ? { toolState } : {}) },
  };
}

describe('selectToolStates', () => {
  it('returns empty for an empty map', () => {
    expect(selectToolStates(new Map())).toEqual(new Map());
  });

  it('skips runs with no toolState (card-only flows)', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('rA', env('rA')); // no toolState
    m.set('rB', env('rB', { count: 3 }));
    const out = selectToolStates(m);
    expect(out.size).toBe(1);
    expect(out.get('rB')).toEqual({ count: 3 });
  });

  it('preserves runId → toolState mapping', () => {
    const m = new Map<string, SnapshotEnvelope>();
    m.set('a', env('a', { phase: 'querying' }));
    m.set('b', env('b', { phase: 'done', results: ['x'] }));
    const out = selectToolStates(m);
    expect(out.get('a')).toEqual({ phase: 'querying' });
    expect(out.get('b')).toEqual({ phase: 'done', results: ['x'] });
  });
});

describe('useStateSnapshots — shared connectivity wiring', () => {
  beforeEach(() => {
    _resetSnapshotStore();
    captured = null;
    reportReachable.mockReset();
    reportUnreachable.mockReset();
  });
  afterEach(() => { cleanup(); _resetSnapshotStore(); });

  it('clears obsolete runs on reconnect and adopts lower versions with their workspace and conversation', () => {
    const hook = renderHook(() => useStateSnapshots());
    const snapshot = (version: number, workspaceId: string, conversationId: string) => JSON.stringify({
      ...env('same-run'), version, workspaceId, snapshot: { openCards: [{ correlationId: 'card',
        prompt: 'Choose', createdAt: 1, dataSchemaJson: {}, conversationId }] },
    });
    act(() => captured!.handlers.snapshot(snapshot(90, 'previous', 'old-conversation')));
    expect(hook.result.current.cards).toHaveLength(1);
    act(() => captured!.handlers.reset(JSON.stringify({ workspaceId: 'current' })));
    expect(hook.result.current.cards).toEqual([]);
    act(() => captured!.handlers.snapshot(snapshot(1, 'current', 'owning-conversation')));
    expect(hook.result.current.cards[0]).toMatchObject({ workspaceId: 'current', conversationId: 'owning-conversation' });
  });

  it('feeds the shared sync connectivity store: onOpen → reachable, onError → unreachable', () => {
    renderHook(() => useStateSnapshots());
    expect(captured).toBeTruthy();

    captured!.onOpen?.();
    expect(reportReachable).toHaveBeenCalledTimes(1);

    captured!.onError?.();
    expect(reportUnreachable).toHaveBeenCalledTimes(1);
  });
});
