/**
 * report-contention.test.ts — activity:report is FIRE-AND-FORGET telemetry (EI-7439).
 *
 * The per-CLI hooks call activity:report detached on EVERY native tool call, and the
 * telemetry INSERT runs on the harness_admin org pool whose role default caps a lock
 * wait at `lock_timeout=15s`. Under transient heavyweight-lock contention on
 * harness_shared.agent_activity that INSERT can raise `canceling statement due to lock
 * timeout` (pg 55P03) — but a dropped fleet-view row is benign (it self-heals on the
 * worker's next report), so it must be a SOFT no-op, never a hard `handler_error` that
 * the improvement-watchdog counts as "activity:report is failing" (the bug this guards).
 *
 * A GENUINE (non-contention) fault must still surface — we don't want to mask a real
 * DB-down / bug behind the drop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ append: vi.fn(), arm: vi.fn(), cancel: vi.fn(), heal: vi.fn() }));

vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({ append: h.append }) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>, contextOverrides: Record<string, unknown> = {}) =>
  tool.handler(
    args as Parameters<typeof tool.handler>[0],
    { ...ctx, ...contextOverrides } as Parameters<typeof tool.handler>[1],
  );

/** A pg lock_timeout error as postgres.js surfaces it: SQLSTATE on `.code`. */
function lockTimeoutError(): Error & { code: string } {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

beforeEach(() => {
  h.append.mockReset().mockResolvedValue({ id: '42' });
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('activity:report — telemetry INSERT never blocks the hook response (EI-7439)', () => {
  it('returns while the append is pending and publishes slow phase timing', async () => {
    vi.useFakeTimers();
    const metadata = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveAppend: ((value: { id: string }) => void) | undefined;
    h.append.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => { resolveAppend = resolve; }),
    );

    const res = await run(
      { hook_bundle: true, owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' },
      { metadata },
    );
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: null, persistence: 'async' });
    expect(h.append).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      activityReportPhase: expect.objectContaining({
        schemaVersion: 'activity-report-phase-v1',
        phase: 'record-activity',
        status: 'running',
        elapsedMs: expect.any(Number),
      }),
    }));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('telemetry append still running'));

    if (!resolveAppend) throw new Error('telemetry append did not start');
    resolveAppend({ id: '42' });
    await vi.advanceTimersByTimeAsync(0);
    expect(metadata).toHaveBeenLastCalledWith(expect.objectContaining({
      activityReportPhase: expect.objectContaining({
        phase: 'record-activity',
        status: 'fulfilled',
        elapsedMs: expect.any(Number),
      }),
    }));
  });

  it('a transient lock_timeout (55P03) is a SOFT drop, not a hard tool error', async () => {
    h.append.mockRejectedValueOnce(lockTimeoutError());
    const res = await run({ hook_bundle: true, owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    const content = (res as { isError?: boolean; content: { text: string }[] }).content;
    // The append settles independently of the response; the receipt states that persistence is async.
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: null, persistence: 'async' });
  });

  it('a statement_timeout (57014) is likewise a soft drop', async () => {
    h.append.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const res = await run({ hook_bundle: true, owner: 'su-abc', kind: 'tool', tool_name: 'Bash', summary: 'ran a command' });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: null, persistence: 'async' });
  });

  it('logs a genuine (non-contention) append failure without rejecting the hook response', async () => {
    const error = new Error('relation does not exist');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.append.mockRejectedValueOnce(error);
    const res = await run({ hook_bundle: true, owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'x' });
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('relation does not exist'));
  });

  it('the plain report awaits and preserves the INSERT id receipt', async () => {
    const res = await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Read', summary: 'read a file' });
    const content = (res as { content: { text: string }[] }).content;
    const receipt = JSON.parse(content[0].text);
    expect(receipt).toMatchObject({ ok: true, id: '42' });
    expect(receipt).not.toHaveProperty('persistence');
    expect(h.append).toHaveBeenCalledOnce();
  });
});
