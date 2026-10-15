/**
 * session-compacted-events.test — the completed-/compact signal, pure (injected emit)
 * (event-await-discoverability-and-coverage-2026-07-03 P-103).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  emitSessionCompactedEvent,
  emitSessionCompactedEventAsync,
  parseSessionCompactedArgv,
} from './session-compacted-events';

type EmitOpts = { key: string; summary?: string; payload?: unknown; to?: string[]; source?: string };
const typedEmit = () =>
  vi.fn(async (_opts: EmitOpts) => ({ ok: true as const, key: '', woken: 0, notified: [] as string[], msgId: null, waiters: 0 }));

describe('emitSessionCompactedEvent (P-103)', () => {
  it('fires session:compacted:<owner> with the owner in both key and payload', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-94b69', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit).toHaveBeenCalledTimes(1);
    const call = emit.mock.calls[0][0];
    expect(call.key).toBe('session:compacted:su-94b69');
    expect(call).toMatchObject({ source: 'session', payload: { owner: 'su-94b69', detail: null } });
    expect(call.summary).toContain('su-94b69');
  });

  it('rides the focus in the summary + payload when supplied', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-cd47dc54', 'keep identity + plan Now', { emit });
    await new Promise((r) => setTimeout(r, 0));
    const call = emit.mock.calls[0][0];
    expect(call.summary).toContain('keep identity + plan Now');
    expect(call).toMatchObject({ payload: { owner: 'su-cd47dc54', detail: 'keep identity + plan Now' } });
  });

  it('is an awaiter-only signal — no `to` push', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-1', undefined, { emit });
    await new Promise((r) => setTimeout(r, 0));
    expect(emit.mock.calls[0][0].to).toBeUndefined();
  });

  it('never rejects on an emit failure (warns; the resume turn must never break)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    expect(() => emitSessionCompactedEvent('su-2', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('compacted-event for su-2'));
    warn.mockRestore();
  });

  it('swallows expected teardown noise WITHOUT warning (CONNECTION_ENDED / partial schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emit = vi.fn(async () => {
      throw Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' });
    });
    expect(() => emitSessionCompactedEvent('su-3', undefined, { emit: emit as never })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ── the AWAITABLE core the bridge CLI runs (P-103 linchpin) ─────────────────
describe('emitSessionCompactedEventAsync (the CLI-awaited core)', () => {
  it('preserves the exact successor sessionId in the completed-cut event payload', async () => {
    const emit = typedEmit();
    const parsed = parseSessionCompactedArgv(['node', '/emit.ts', 'su-carry', 'carry-respawn', '01a0f83a-e303-7031-be21-efbcc3abf714'])!;
    await emitSessionCompactedEventAsync(parsed.owner, parsed.focus, { emit, sessionId: parsed.sessionId });
    expect(emit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      key: 'session:compacted:su-carry',
      payload: { owner: 'su-carry', detail: 'carry-respawn', sessionId: '01a0f83a-e303-7031-be21-efbcc3abf714' },
    }));
  });

  it('keeps the successor identity through the in-process wrapper too', async () => {
    const emit = typedEmit();
    emitSessionCompactedEvent('su-carry', 'carry-respawn', { emit, sessionId: 'native-successor' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emit.mock.calls[0][0]).toMatchObject({ payload: { sessionId: 'native-successor' } });
  });

  it('RESOLVES only after the emit settles (the CLI must not exit before the fire commits)', async () => {
    let settled = false;
    const emit = vi.fn(async (_opts: EmitOpts) => {
      await new Promise((r) => setTimeout(r, 5));
      settled = true;
      return { ok: true as const, key: '', woken: 1, notified: [] as string[], msgId: null, waiters: 1 };
    });
    await emitSessionCompactedEventAsync('su-9', 'focus', { emit });
    expect(settled).toBe(true); // awaited through — not fire-and-forget
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      key: 'session:compacted:su-9',
      source: 'session',
      payload: { owner: 'su-9', detail: 'focus' },
    });
  });

  it('REJECTS on an emit failure (the CLI wraps this fail-soft; the in-process wrapper does not)', async () => {
    const emit = vi.fn(async () => {
      throw new Error('engine down');
    });
    await expect(emitSessionCompactedEventAsync('su-10', undefined, { emit: emit as never })).rejects.toThrow(
      'engine down',
    );
  });
});

describe('parseSessionCompactedArgv (CLI arg mapping)', () => {
  const argv = (...rest: string[]) => ['node', '/scripts/emit-session-compacted.ts', ...rest];

  it('maps <ownerId> <focus> <sessionId> to the bridge payload', () => {
    expect(parseSessionCompactedArgv(argv('su-94b69', 'keep identity + plan Now', 'native-2'))).toEqual({
      owner: 'su-94b69',
      focus: 'keep identity + plan Now',
      sessionId: 'native-2',
    });
  });

  it("collapses the host's empty-string focus (String(focus ?? '')) back to undefined", () => {
    expect(parseSessionCompactedArgv(argv('su-1', ''))).toEqual({ owner: 'su-1' });
    expect(parseSessionCompactedArgv(argv('su-1'))).toEqual({ owner: 'su-1' });
  });

  it('trims surrounding whitespace on owner and focus', () => {
    expect(parseSessionCompactedArgv(argv('  su-2  ', '  hi  ', '  native-3  '))).toEqual({
      owner: 'su-2',
      focus: 'hi',
      sessionId: 'native-3',
    });
  });

  it('returns null when no ownerId is present (the CLI then no-ops and exits 0)', () => {
    expect(parseSessionCompactedArgv(argv())).toBeNull();
    expect(parseSessionCompactedArgv(argv('   '))).toBeNull();
  });
});
