/**
 * The staleness LADDER — whether the chat pane's "stale" banner is reachable
 * AT ALL (EI-20265888603098901).
 *
 * WHY THIS FILE EXISTS, separately from stream-freshness.test.ts:
 *
 * `stream-freshness.test.ts` tests `classifyStreamFreshness` by INJECTION — it
 * hands the function a transport status and a silence age and checks the verdict.
 * That is a complete test of the function and it was fully green while the
 * `'stale'` branch was **structurally unreachable dead code**: the threshold
 * shipped at 60s, above the transport's own 45s zombie watchdog, and the
 * watchdog wins. Every `'stale'` case in that file constructed a
 * (transport, age) pair the runtime can never produce.
 *
 * That is the general trap: a pure classifier unit-tested by injection can
 * never tell you which of its states the SYSTEM can enter, and the unreachable
 * combination is the easiest one to write by hand. Injection-green is evidence
 * about the function, never about the system.
 *
 * So this file tests the two things injection cannot:
 *
 *   1. THE ORDERING of the three real constants, read from their real sources.
 *   2. REACHABILITY, by driving the REAL `createResilientEventSource` — its
 *      real watchdog, its real signal wiring, at its real default timeout —
 *      and observing which states actually occur on a stream that hangs.
 *
 * The three rungs, and what each inequality protects:
 *
 *   SESSION_STREAM_HEARTBEAT_MS (15s)        ── the server's beat
 *     ×2 <  STREAM_SILENCE_STALE_MS (31s)    ── "this view may be behind"
 *         <  desktop IPC ceiling (32s)       ── endpoint IPC gives up
 *         <  DEFAULT_ZOMBIE_TIMEOUT_MS (45s) ── generic transport gives up
 *
 *   LEFT  inequality violated → FALSE ALARMS. Healthy idle streams get a stale
 *         banner, and a banner that is usually wrong is ignored exactly when it
 *         is finally right.
 *   RIGHT inequality violated → DEAD CODE. The watchdog preempts the rung and
 *         the banner silently never appears. This is the bug that shipped.
 *
 * They are a LADDER, not a belt-and-braces pair: ONE `signal()` seam feeds both
 * the pane's silence timer and the transport's watchdog, so whichever fires
 * first makes the other unobservable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createResilientEventSource,
  DEFAULT_ZOMBIE_TIMEOUT_MS,
  DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS,
} from '@papercusp/sse';
import { classifyStreamFreshness, STREAM_SILENCE_STALE_MS } from './stream-freshness';
import type { ResilientEventSourceStatus } from '@papercusp/sse';
import { FakeEventSource, latestEventSource as latest } from './fake-event-source.testkit';

// ── The server rung, read from its canonical declaration ────────────────────
//
// Read from SOURCE rather than imported: the heartbeat is declared in the
// timeline module and re-exported by the server route. Importing the route from
// a client-component test would drag the endpoint layer in. Reading the literal
// keeps the UI threshold pinned to the server's actual cadence.
const SERVER_TIMELINE_URL = new URL(
  '../../../../../packages/operator-core/lib/owner-sessions/timeline.ts',
  import.meta.url,
);

const ENDPOINT_IPC_URL = new URL(
  '../../../../../papercusp-desktop/src-tauri/src/endpoint_ipc.rs',
  import.meta.url,
);

function readServerHeartbeatMs(): number {
  const src = readFileSync(SERVER_TIMELINE_URL, 'utf8');
  const m = /export const SESSION_STREAM_HEARTBEAT_MS\s*=\s*([\d_]+)\s*;/.exec(src);
  if (!m) {
    throw new Error(
      'SESSION_STREAM_HEARTBEAT_MS not found in owner-sessions/timeline.ts. ' +
        'If it was renamed or moved, update this source pin — do NOT delete the ' +
        'assertion: it is the only thing keeping the stale threshold above the ' +
        'server heartbeat.',
    );
  }
  return Number(m[1].replace(/_/g, ''));
}

/**
 * Read the desktop writer's stream budget from its source, not from a copied
 * comment or a second hand-maintained constant. The explicit expression is a
 * guard too: changing the Rust budget formula makes this test fail loudly so
 * the UI mirror is re-derived rather than drifting.
 */
function readDesktopIpcStreamIdleTimeoutMs(): number {
  const src = readFileSync(ENDPOINT_IPC_URL, 'utf8');
  const heartbeat = /const IPC_STREAM_HEARTBEAT_INTERVAL_MS:\s*u64\s*=\s*([\d_]+)\s*;/.exec(src);
  const watchdog = /const IPC_WATCHDOG_CHECK_INTERVAL_MS:\s*u64\s*=\s*([\d_]+)\s*;/.exec(src);
  const formula = /const IPC_STREAM_IDLE_TIMEOUT_MS:\s*u64\s*=\s*IPC_STREAM_HEARTBEAT_INTERVAL_MS\s*\*\s*2\s*\+\s*IPC_WATCHDOG_CHECK_INTERVAL_MS\s*;/.exec(src);
  if (!heartbeat || !watchdog || !formula) {
    throw new Error(
      'The endpoint IPC stream timeout writer changed shape. Update this source pin and the TS mirror together — do not hand-lower the UI threshold.',
    );
  }
  return Number(heartbeat[1].replace(/_/g, '')) * 2 + Number(watchdog[1].replace(/_/g, ''));
}

describe('staleness ladder — the three rungs must stay ordered', () => {
  it('mirrors the desktop IPC writer’s effective stream ceiling', () => {
    expect(DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS).toBe(readDesktopIpcStreamIdleTimeoutMs());
  });

  it('the stale threshold sits BELOW every transport ceiling (else it is dead code)', () => {
    // The regression that shipped: 60_000 >= 45_000. Desktop IPC is now the
    // tighter ceiling, so asserting only against the generic wrapper would
    // bless a threshold that the shipping target can never reach.
    const effectiveCeilingMs = Math.min(DEFAULT_ZOMBIE_TIMEOUT_MS, DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS);
    expect(STREAM_SILENCE_STALE_MS).toBeLessThan(effectiveCeilingMs);
  });

  it('the stale threshold sits ABOVE two server heartbeats (else it false-alarms)', () => {
    const serverHeartbeatMs = readServerHeartbeatMs();
    // Two missed beats is "real, not jitter". One beat of grace is too tight:
    // a single delayed heartbeat would banner a perfectly healthy stream.
    expect(STREAM_SILENCE_STALE_MS).toBeGreaterThan(serverHeartbeatMs * 2);
  });

  it('leaves a usable window between the two rungs', () => {
    // The one-second margin is deliberate: the desktop writer is the binding
    // ceiling, and any larger hand-picked gap would spend the heartbeat grace
    // that keeps a healthy idle stream from false-alarming.
    const effectiveCeilingMs = Math.min(DEFAULT_ZOMBIE_TIMEOUT_MS, DESKTOP_IPC_STREAM_IDLE_TIMEOUT_MS);
    const windowMs = effectiveCeilingMs - STREAM_SILENCE_STALE_MS;
    expect(windowMs).toBe(1_000);
  });
});

// ── Reachability against the REAL transport ─────────────────────────────────
//
// Only the EventSource *transport* is faked (`./fake-event-source.testkit`,
// shared with the hook-level test so both drive one identical fake). Everything
// that decides the outcome is real: the real wrapper, its real zombie watchdog
// at its real default timeout, the real `signal()` wiring that feeds BOTH
// timers, and the real classifier at its real threshold.

describe('the "stale" rung is REACHABLE by the real transport', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a stream that opens, beats once, then hangs goes fresh → stale → reconnecting', () => {
    let transport: ResilientEventSourceStatus | undefined;
    let lastSignalAt: number | null = null;

    const es = createResilientEventSource({
      url: 'http://127.0.0.1/adv/session/thinking?sessionId=test',
      // No zombieTimeoutMs override — the REAL default is the whole point.
      handlers: {},
      onStatusChange: (s) => { transport = s; },
      onSignal: () => { lastSignalAt = Date.now(); },
    });

    // The pane's exact computation, at the pane's exact threshold.
    const freshness = () =>
      classifyStreamFreshness({ transport, lastSignalAtMs: lastSignalAt, nowMs: Date.now() });

    try {
      latest().fireOpen();
      expect(transport).toBe('open');
      expect(freshness()).toBe('fresh');

      // One healthy heartbeat, then the producer goes deaf with the socket
      // still open — the exact condition the banner exists for.
      vi.advanceTimersByTime(15_000);
      latest().fire('heartbeat', '{"tsMs":1}');
      expect(freshness()).toBe('fresh');

      // Silence. One millisecond short of the threshold is still fresh.
      vi.advanceTimersByTime(STREAM_SILENCE_STALE_MS - 1);
      expect(transport).toBe('open');
      expect(freshness()).toBe('fresh');

      // ── THE RUNG THAT WAS DEAD CODE ────────────────────────────────────
      // Reached with the transport genuinely still 'open', produced by the
      // real watchdog's own timing rather than by a hand-built input pair.
      vi.advanceTimersByTime(1);
      expect(transport).toBe('open');
      expect(freshness()).toBe('stale');

      // The watchdog then escalates it, and the banner hands off cleanly.
      vi.advanceTimersByTime(DEFAULT_ZOMBIE_TIMEOUT_MS - STREAM_SILENCE_STALE_MS);
      expect(transport).not.toBe('open');
      expect(freshness()).toBe('reconnecting');
    } finally {
      es.close();
    }
  });

  it('an idle-but-healthy stream never goes stale (heartbeats alone keep it fresh)', () => {
    // The asymmetry that matters: most agents are idle most of the time and
    // emit ZERO transcript events. If freshness keyed on payload activity
    // instead of heartbeats, every quiet agent would be bannered as broken.
    let transport: ResilientEventSourceStatus | undefined;
    let lastSignalAt: number | null = null;

    const es = createResilientEventSource({
      url: 'http://127.0.0.1/adv/session/thinking?sessionId=idle',
      handlers: {},
      onStatusChange: (s) => { transport = s; },
      onSignal: () => { lastSignalAt = Date.now(); },
    });

    try {
      latest().fireOpen();

      // Ten minutes of a totally silent AGENT, but a healthy SERVER.
      for (let i = 0; i < 40; i++) {
        vi.advanceTimersByTime(15_000);
        latest().fire('heartbeat', '{"tsMs":1}');
        expect(classifyStreamFreshness({
          transport, lastSignalAtMs: lastSignalAt, nowMs: Date.now(),
        })).toBe('fresh');
      }
      expect(transport).toBe('open');
    } finally {
      es.close();
    }
  });
});
