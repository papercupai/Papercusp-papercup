/**
 * pg-notify-bus.test.ts — EI-9920: a failed LISTEN start (e.g. CONNECTION_DESTROYED
 * during embedded-PG boot warmup on a pristine VM first boot) must not leave a
 * subscribed handler permanently dead for the session. `ensureStarted` must retry
 * with backoff as long as a handler is still registered, and must stop retrying
 * (and never leak a connection) once the last handler unsubscribes.
 *
 * `postgres` and `./pg-listen-hub` are mocked so no real DB connection is ever
 * opened; fake timers drive the retry backoff deterministically.
 *
 * Run: cd packages/operator-core && npx vitest run lib/pg-notify-bus.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listen = vi.fn();
const end = vi.fn().mockResolvedValue(undefined);
const postgresFactory = vi.fn((_url?: string, _opts?: unknown) => ({ listen, end }));
const hubEnabled = vi.fn(() => false);
const hubListen = vi.fn();

vi.mock('postgres', () => ({
  default: (url?: string, opts?: unknown) => postgresFactory(url, opts),
}));
vi.mock('./embedded-pg-discovery', () => ({ getHarnessAdminUrl: () => 'postgres://test' }));
vi.mock('./pg-listen-hub', () => ({
  listenHubEnabled: () => hubEnabled(),
  hubListen: (...args: unknown[]) => hubListen(...args),
}));

import { createNotifyBus } from './pg-notify-bus';

describe('createNotifyBus — EI-9920 retry-on-failed-start', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    listen.mockReset();
    end.mockReset().mockResolvedValue(undefined);
    postgresFactory.mockClear();
    hubEnabled.mockReturnValue(false);
    hubListen.mockReset();
    // These tests deliberately exercise the failed-start → retry path, which
    // logs `[label] failed to start (will retry): ...` — expected noise, not
    // a real failure.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('a subscribe that hits a failed LISTEN (CONNECTION_DESTROYED) retries and eventually connects — the handler is not left permanently dead', async () => {
    listen
      .mockRejectedValueOnce(new Error('write CONNECTION_DESTROYED localhost:15968'))
      .mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const handler = vi.fn();
    bus.subscribe(handler);

    // let the first (failing) ensureStarted() attempt settle
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(1);

    // before the retry fires, nothing has been re-attempted
    await vi.advanceTimersByTimeAsync(499);
    expect(listen).toHaveBeenCalledTimes(1);

    // the 500ms backoff elapses → retry fires → this attempt succeeds
    await vi.advanceTimersByTimeAsync(1);
    expect(listen).toHaveBeenCalledTimes(2);

    await bus._stopForTests();
  });

  it('backoff DOUBLES on consecutive failures, capped, and resets once a start succeeds', async () => {
    listen
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    bus.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 (fails)
    expect(listen).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // 500ms backoff → attempt 2 (fails)
    expect(listen).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999); // 1000ms backoff not yet elapsed
    expect(listen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // now it has → attempt 3 (succeeds)
    expect(listen).toHaveBeenCalledTimes(3);

    // no further retries scheduled after a success
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(3);

    await bus._stopForTests();
  });

  it('unsubscribing while a retry is pending cancels it — no leaked reconnect for an empty bus', async () => {
    listen.mockRejectedValue(new Error('still down'));

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const unsubscribe = bus.subscribe(vi.fn());

    await vi.advanceTimersByTimeAsync(0); // attempt 1 (fails), retry scheduled for +500ms
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe(); // last handler gone — the pending retry must be cancelled

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1); // never retried into an empty bus

    await bus._stopForTests();
  });

  // WI-10004194: ending the pool destroys a LISTEN still in flight (postgres.js
  // rejects it with CONNECTION_DESTROYED). When that close is ours — the last
  // handler left mid-start — it is not a failed start. The PTY suite's
  // fail-on-console turned exactly this into a red on an unrelated case.
  it('WI-10004194: the last handler leaving while LISTEN is in flight logs no failure, and a new subscriber starts cleanly', async () => {
    let rejectListen!: (err: Error) => void;
    listen.mockImplementationOnce(() => new Promise((_, reject) => { rejectListen = reject; }));
    end.mockImplementationOnce(async () => { rejectListen(new Error('write CONNECTION_DESTROYED localhost:32785')); });

    const bus = createNotifyBus('tui_intents', 'tui-intents-bus');
    const unsubscribe = bus.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(1);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(end).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledTimes(1); // no retry into an empty bus

    listen.mockResolvedValueOnce(undefined);
    const handler = vi.fn();
    bus.subscribe(handler);
    await vi.advanceTimersByTimeAsync(0);
    expect(postgresFactory).toHaveBeenCalledTimes(2);
    (listen.mock.calls[1][1] as (payload: string) => void)('client-7');
    expect(handler).toHaveBeenCalledWith('client-7');

    await bus._stopForTests();
  });

  it('WI-10004194: a stale start rejection landing after a newer start leaves the live listener alone', async () => {
    let rejectFirst!: (err: Error) => void;
    listen
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('tui_intents', 'tui-intents-bus');
    const unsubscribe = bus.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    unsubscribe(); // end() resolves without settling the first LISTEN yet
    await vi.advanceTimersByTimeAsync(0);

    bus.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(listen).toHaveBeenCalledTimes(2);

    rejectFirst(new Error('write CONNECTION_DESTROYED localhost:32785'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // The second listener is still the live one: another subscriber reuses it.
    bus.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(postgresFactory).toHaveBeenCalledTimes(2);
    expect(listen).toHaveBeenCalledTimes(2);

    await bus._stopForTests();
  });

  it('a well-formed first start never schedules a retry and fans out notifications', async () => {
    listen.mockResolvedValueOnce(undefined);

    const bus = createNotifyBus('ui_intents', 'ui-intents-bus');
    const handler = vi.fn();
    bus.subscribe(handler);
    await vi.advanceTimersByTimeAsync(0);

    expect(listen).toHaveBeenCalledTimes(1);
    const onNotify = listen.mock.calls[0][1] as (payload: string) => void;
    onNotify('client-123');
    expect(handler).toHaveBeenCalledWith('client-123');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listen).toHaveBeenCalledTimes(1);

    await bus._stopForTests();
  });

  it.each([false, true])('rescans initial and reconnected LISTEN, suppressing a stale ready callback (hub=%s)', async useHub => {
    hubEnabled.mockReturnValue(useHub);
    listen.mockResolvedValue(undefined);
    hubListen.mockResolvedValue(vi.fn());
    const onListen = vi.fn();
    const bus = createNotifyBus('coord_inbox', 'recovery-test', onListen);
    const unsubscribe = bus.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const ready = (useHub ? hubListen : listen).mock.calls[0][2] as () => void;
    ready();
    ready();
    expect(onListen).toHaveBeenCalledTimes(2);
    unsubscribe();
    ready();
    expect(onListen).toHaveBeenCalledTimes(2);
    await bus._stopForTests();
  });
});
