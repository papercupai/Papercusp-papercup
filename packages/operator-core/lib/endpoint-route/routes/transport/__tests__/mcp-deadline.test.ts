/**
 * mcp-deadline.test.ts — P2-5 (operator-scalability-event-loop-2026-06-16).
 *
 * raceDeadline backs the MCP tool-call deadline: a tool exceeding the deadline
 * returns a clean error to the client instead of hanging to maxDuration / a silent
 * tunnel drop, while the tool keeps running server-side (keyed writes can replay;
 * retries of read-only calls execute a fresh read). Pins: fast path passes through, slow path times out, 0 disables, and a
 * post-timeout rejection of the orphaned run never surfaces as unhandled.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  raceDeadline,
  effectiveMcpDeadlineMs,
  formatMcpReadOnlyDeadlineMessage,
  dispatchLegacyWithDeadline,
  dispatchNestedWithMcpDeadline,
} from '../_mcp-host';

const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dispatch: dispatchMock };
});

describe('raceDeadline (P2-5 MCP deadline)', () => {
  it('returns the run result when it finishes before the deadline', async () => {
    const r = await raceDeadline(1000, async () => 'ok', () => 'timeout');
    expect(r).toBe('ok');
  });

  it('returns onTimeout() when run exceeds the deadline', async () => {
    const slow = () => new Promise<string>((res) => setTimeout(() => res('late'), 200));
    const r = await raceDeadline(10, slow, () => 'timeout');
    expect(r).toBe('timeout');
  });

  it('deadlineMs<=0 disables the race (always awaits run)', async () => {
    const r = await raceDeadline(0, async () => 'ok', () => 'timeout');
    expect(r).toBe('ok');
  });

  it('a post-timeout rejection of the orphaned run does NOT surface as unhandled', async () => {
    // run rejects AFTER the deadline already fired — raceDeadline must swallow it
    // (vitest fails the suite on an unhandledRejection, so this is the assertion).
    const failLate = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late boom')), 25));
    const r = await raceDeadline(5, failLate, () => 'timeout');
    expect(r).toBe('timeout');
    await new Promise((res) => setTimeout(res, 50)); // let the late rejection fire
  });
});

describe('effectiveMcpDeadlineMs (EI-17177)', () => {
  it('falls back to the flat base deadline when the tool declares no timeoutSec', () => {
    expect(effectiveMcpDeadlineMs(undefined, 55_000)).toBe(55_000);
    expect(effectiveMcpDeadlineMs(null, 55_000)).toBe(55_000);
    expect(effectiveMcpDeadlineMs(0, 55_000)).toBe(55_000);
  });

  it('keeps the flat base deadline when the tool timeoutSec is UNDER it (no behavior change)', () => {
    // e.g. a 30s tool — the flat 55s floor still governs, same as before this fix.
    expect(effectiveMcpDeadlineMs(30, 55_000)).toBe(55_000);
  });

  it('honors a tool timeoutSec that exceeds the base deadline, plus the buffer', () => {
    // chat:ask_choice / operator+architect+oracle+agent_chats converse / sentinel-converse
    // all declare timeoutSec: 600 — must not be cut off at the flat 55s floor.
    expect(effectiveMcpDeadlineMs(600, 55_000)).toBe(600_000 + 5_000);
  });

  it('a base deadline <= 0 (P2-5 disabled) stays disabled regardless of timeoutSec', () => {
    expect(effectiveMcpDeadlineMs(600, 0)).toBe(0);
    expect(effectiveMcpDeadlineMs(600, -1)).toBe(-1);
  });
});

describe('read-only MCP deadline guidance (EI-25270415606873353)', () => {
  it('explains that retries execute a fresh read instead of replaying the timed-out result', () => {
    const traceId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    const message = formatMcpReadOnlyDeadlineMessage('coord:presence', 55_000, traceId);

    expect(message).toContain('request_timeout');
    expect(message).toContain('read-only tool "coord:presence"');
    expect(message).toContain('results are not stored for idempotent replay');
    expect(message).toContain('retrying will execute a fresh read');
    expect(message).toContain(`request trace id: ${traceId}`);
    expect(message).not.toContain('same _meta.idempotencyKey');
    expect(message).not.toContain('commit status is UNKNOWN');
  });
});

describe('dispatchNestedWithMcpDeadline (tools:invoke)', () => {
  it('uses the nested target timeout plus buffer and returns a bounded unknown-commit error', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const dispatch = vi.fn(() => new Promise<never>(() => {}));
      const pending = dispatchNestedWithMcpDeadline('work_items:checkpoint', 0.02, dispatch, 10).then((result) => {
        settled = true;
        return result;
      });

      // The nested target's 20ms timeout + 5s buffer exceeds the 10ms base.
      await vi.advanceTimersByTimeAsync(5_019);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const result = await pending;
      expect(dispatch).toHaveBeenCalledOnce();
      expect(result.isError).toBe(true);
      const message = (result.content[0] as { text: string }).text;
      expect(message).toContain('request_timeout');
      expect(message).toContain('work_items:checkpoint');
      expect(message).toContain('exceeded 5020ms');
      expect(message).toContain('commit status is UNKNOWN');
      expect(message).toContain('Re-read the target\'s state before retrying');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dispatchLegacyWithDeadline (WI-4760)', () => {
  it('passes through a fast legacy dispatch unchanged', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, response: { data: 'fine' } });
    const r = await dispatchLegacyWithDeadline({ toolName: 'legacytest:fast', args: {}, bearer: 'b' }, 1000);
    expect(r).toEqual({ ok: true, response: { data: 'fine' } });
    expect(dispatchMock).toHaveBeenCalledWith({ toolName: 'legacytest:fast', args: {}, bearer: 'b' });
  });

  it('a wedged legacy dispatch (no per-call timeout of its own) times out cleanly instead of hanging the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dispatchMock.mockImplementationOnce(
        () => new Promise(() => {}), // never resolves — this is the WI-4760 hang
      );
      const r = await dispatchLegacyWithDeadline({ toolName: 'legacytest:hang', args: {}, bearer: 'b' }, 10);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('request_timeout');
      expect(r.error?.message).toMatch(/legacytest:hang.*exceeded 10ms/);
      expect(r.error?.message).toContain('commit status is UNKNOWN');
      expect(r.error?.message).toContain('re-check current state');
      // Attribution/telemetry (the ticket's second requirement): the wedge is
      // logged with the tool name so it can be found + fixed.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('legacytest:hang'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('a legacy dispatch REJECTING after the deadline never surfaces as an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dispatchMock.mockImplementationOnce(
        () => new Promise((_, rej) => setTimeout(() => rej(new Error('late boom')), 25)),
      );
      const r = await dispatchLegacyWithDeadline({ toolName: 'legacytest:late-fail', args: {}, bearer: 'b' }, 5);
      expect(r.error?.code).toBe('request_timeout');
      await new Promise((res) => setTimeout(res, 50)); // let the late rejection fire; vitest fails on unhandled
    } finally {
      warn.mockRestore();
    }
  });

  it('defaults to the flat MCP_DEADLINE_MS floor when no baseDeadlineMs is given (legacy tools declare no timeoutSec)', async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, response: { data: 'ok' } });
    const r = await dispatchLegacyWithDeadline({ toolName: 'legacytest:default', args: {}, bearer: 'b' });
    expect(r).toEqual({ ok: true, response: { data: 'ok' } });
  });
});
