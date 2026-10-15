/**
 * client-report-ring — the bounded in-memory error/log ring the desktop
 * "Report a problem" dialog reads at Review (unified-bug-pipeline P-014, D-048 pt 2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_REPORT_RING_LIMITS,
  _resetClientReportRing,
  installClientReportRing,
  readClientReportRing,
  recordClientError,
  recordClientLogLine,
  type ClientReportRingTarget,
} from './client-report-ring';

interface FakeTarget extends ClientReportRingTarget {
  events: EventTarget;
  calls: { warn: unknown[][]; error: unknown[][] };
}

function fakeTarget(): FakeTarget {
  const events = new EventTarget();
  const calls = { warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    events,
    calls,
    addEventListener: events.addEventListener.bind(events),
    console: {
      warn: (...args: unknown[]) => void calls.warn.push(args),
      error: (...args: unknown[]) => void calls.error.push(args),
    },
  };
}

function fire(target: FakeTarget, type: string, props: Record<string, unknown>): void {
  target.events.dispatchEvent(Object.assign(new Event(type), props));
}

beforeEach(() => _resetClientReportRing());
afterEach(() => _resetClientReportRing());

describe('client-report-ring', () => {
  it('records window error and unhandledrejection events', () => {
    const t = fakeTarget();
    installClientReportRing(t);
    fire(t, 'error', { message: 'boom at render' });
    fire(t, 'unhandledrejection', { reason: new TypeError('x is undefined') });

    const { errors } = readClientReportRing();
    expect(errors.map((e) => [e.source, e.message])).toEqual([
      ['window.error', 'boom at render'],
      ['unhandledrejection', 'TypeError: x is undefined'],
    ]);
    expect(errors.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });

  it('falls back to the error object when an error event has no message', () => {
    const t = fakeTarget();
    installClientReportRing(t);
    fire(t, 'error', { message: '', error: new RangeError('too deep') });
    expect(readClientReportRing().errors[0]).toMatchObject({ source: 'window.error', message: 'RangeError: too deep' });
  });

  it('wraps console.warn and console.error, still passing every call through', () => {
    const t = fakeTarget();
    installClientReportRing(t);
    t.console.warn('slow query', { ms: 812 });
    t.console.error('save failed:', new Error('409 conflict'));

    expect(t.calls.warn).toEqual([['slow query', { ms: 812 }]]);
    expect(t.calls.error).toHaveLength(1);
    expect(t.calls.error[0]?.[0]).toBe('save failed:');

    const { errors, logLines } = readClientReportRing();
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toMatch(/ warn slow query \{"ms":812\}$/);
    expect(logLines[1]).toMatch(/ error save failed: Error: 409 conflict$/);
    // console.error is also an error, so the reporter sees it among errors.
    expect(errors).toEqual([expect.objectContaining({ source: 'console.error', message: 'save failed: Error: 409 conflict' })]);
  });

  it('collapses whitespace and caps each line', () => {
    recordClientLogLine('warn', ['a\n\n  b', 'x'.repeat(2000)]);
    const [line] = readClientReportRing().logLines;
    const text = line!.split(' warn ')[1]!;
    expect(text.startsWith('a b ')).toBe(true);
    expect(text.length).toBe(CLIENT_REPORT_RING_LIMITS.line);
  });

  it('keeps only the newest entries once a cap is reached', () => {
    for (let i = 0; i < CLIENT_REPORT_RING_LIMITS.errors + 5; i++) recordClientError('test', `e${i}`);
    for (let i = 0; i < CLIENT_REPORT_RING_LIMITS.logLines + 7; i++) recordClientLogLine('warn', [`l${i}`]);
    const { errors, logLines } = readClientReportRing();
    expect(errors).toHaveLength(CLIENT_REPORT_RING_LIMITS.errors);
    expect(errors[0]?.message).toBe('e5');
    expect(errors.at(-1)?.message).toBe(`e${CLIENT_REPORT_RING_LIMITS.errors + 4}`);
    expect(logLines).toHaveLength(CLIENT_REPORT_RING_LIMITS.logLines);
    expect(logLines[0]).toMatch(/ warn l7$/);
  });

  it('drops empty messages', () => {
    recordClientError('test', '   ');
    recordClientLogLine('error', ['']);
    expect(readClientReportRing()).toEqual({ errors: [], logLines: [] });
  });

  it('installs once: a second install does not double-wrap the console', () => {
    const t = fakeTarget();
    installClientReportRing(t);
    const wrapped = t.console.warn;
    installClientReportRing(t);
    expect(t.console.warn).toBe(wrapped);
    t.console.warn('once');
    expect(readClientReportRing().logLines).toHaveLength(1);
    expect(t.calls.warn).toHaveLength(1);
  });

  it('is a no-op without a target outside a browser', () => {
    vi.stubGlobal('window', undefined);
    try {
      installClientReportRing();
      recordClientError('test', 'still recordable directly');
      expect(readClientReportRing().errors).toHaveLength(1);
      // Not marked installed, so a later install with a real target still wires up.
      const t = fakeTarget();
      installClientReportRing(t);
      t.console.warn('wired');
      expect(readClientReportRing().logLines).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns copies, so a caller cannot mutate the ring', () => {
    recordClientError('test', 'kept');
    readClientReportRing().errors.length = 0;
    expect(readClientReportRing().errors).toHaveLength(1);
  });
});
