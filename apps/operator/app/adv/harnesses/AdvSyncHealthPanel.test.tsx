// @vitest-environment jsdom
/**
 * AdvSyncHealthPanel.test.tsx
 *
 * The assertions that matter here are the ABSENCE ones. This panel exists because
 * "not measured" kept rendering as "healthy zero" elsewhere in the same plan (the
 * perf suite's `web-vitals: {}`, EI-18895065570073000), so every test below that
 * checks a null/empty path is testing the actual defect class, not decoration:
 *   - a gate with no registered probe must say "unknown", never "0 in flight"
 *   - an empty per-query rollup must say so, not render a table of zeros
 *   - "browser mode, no IPC bridge" and "the IPC bridge errored" must not look alike
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SyncMetricsSnapshot, SyncQueryEvent, SyncQueryStat } from '@papercusp/sync';

const snapshot = vi.fn();
const recentQueries = vi.fn();
const readIpcStatus = vi.fn();

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  syncMetrics: {
    snapshot: () => snapshot(),
    recentQueries: () => recentQueries(),
  },
}));
vi.mock('@/lib/ipc-status-tauri', () => ({
  readIpcStatus: () => readIpcStatus(),
}));

import AdvSyncHealthPanel, {
  IpcSection,
  describeGate,
  formatBytes,
  formatMaybe,
  formatMs,
  slowestRecent,
  topQueries,
} from './AdvSyncHealthPanel';

function stat(over: Partial<SyncQueryStat> = {}): SyncQueryStat {
  return {
    requests: 1,
    bytes: 100,
    waitMsTotal: 0,
    requestMsTotal: 10,
    requestMsMax: 10,
    failures: 0,
    ...over,
  };
}

function snap(over: Partial<SyncMetricsSnapshot> = {}): SyncMetricsSnapshot {
  return {
    takenAtMs: 5_000,
    sse: {
      connectedSinceMs: 1_000,
      reconnectCount: 0,
      eventsReceived: 3,
      lastEventLatencyMs: null,
      bytesReceived: 512,
    },
    cache: { hits: 4, misses: 2 },
    invalidations: { fromSse: 1, fromTimer: 2, fromManual: 0, bySseName: {} },
    transport: {
      inFlight: 2,
      queued: 0,
      limit: 6,
      requests: 10,
      failures: 0,
      timeouts: 0,
      bytesReceived: 2048,
      queueWaitMsTotal: 30,
      queueWaitMsMax: 20,
      queueWaitOver250: 0,
      queueWaitOver1000: 0,
    },
    byQuery: {},
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('formatting helpers', () => {
  it('scales bytes and refuses nonsense rather than printing it', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB');
    // -1 is the library's "not observed" sentinel for a response body.
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('scales ms and renders a null duration as unknown, not zero', () => {
    expect(formatMs(250)).toBe('250ms');
    expect(formatMs(1500)).toBe('1.5s');
    expect(formatMs(90_000)).toBe('1.5m');
    expect(formatMs(null)).toBe('—');
    expect(formatMs(0)).toBe('0ms'); // a real measured zero still reads as zero
  });

  it('distinguishes an unknown count from zero', () => {
    expect(formatMaybe(null)).toBe('unknown');
    expect(formatMaybe(0)).toBe('0');
  });
});

describe('topQueries', () => {
  it('ranks by bytes and derives per-request averages', () => {
    const rows = topQueries({
      small: stat({ requests: 2, bytes: 100, waitMsTotal: 10, requestMsTotal: 100 }),
      big: stat({ requests: 4, bytes: 9000, waitMsTotal: 40, requestMsTotal: 400 }),
    });
    expect(rows.map((r) => r.name)).toEqual(['big', 'small']);
    expect(rows[0].waitAvgMs).toBe(10);
    expect(rows[0].requestAvgMs).toBe(100);
  });

  it('does not divide by zero for a query with no completed requests', () => {
    const rows = topQueries({ idle: stat({ requests: 0, bytes: 0, requestMsTotal: 0 }) });
    expect(rows[0].waitAvgMs).toBe(0);
    expect(rows[0].requestAvgMs).toBe(0);
    expect(Number.isNaN(rows[0].requestAvgMs)).toBe(false);
  });
});

describe('describeGate — the absence-is-not-zero rule', () => {
  it('reports UNKNOWN when no transport registered a probe', () => {
    const g = describeGate(snap({ transport: { ...snap().transport, inFlight: null, queued: null, limit: null } }).transport);
    expect(g.measured).toBe(false);
    expect(g.text).toMatch(/unknown/i);
    // The failure this guards: printing a reassuring zero for an unmeasured gate.
    expect(g.text).not.toMatch(/\b0 in flight\b/);
  });

  it('reports the live depth when a probe is registered', () => {
    const g = describeGate(snap().transport);
    expect(g.measured).toBe(true);
    expect(g.text).toBe('2 in flight of 6 · 0 queued');
  });

  it('renders a measured zero as zero (not as unknown)', () => {
    const g = describeGate({ ...snap().transport, inFlight: 0, queued: 0 });
    expect(g.measured).toBe(true);
    expect(g.text).toBe('0 in flight of 6 · 0 queued');
  });
});

describe('slowestRecent', () => {
  const ev = (name: string, waitMs: number, requestMs: number): SyncQueryEvent => ({
    name,
    startedAtMs: 1,
    waitMs,
    requestMs,
    bytes: 10,
    outcome: 'ok',
  });

  it('ranks by queue wait PLUS request time, not request time alone', () => {
    // The whole point of the P-003(b) split: a request that was fast once it left
    // but sat 900ms behind the gate is the one the user actually waited on.
    const out = slowestRecent([ev('fast', 0, 100), ev('queued', 900, 50)], 2);
    expect(out.map((e) => e.name)).toEqual(['queued', 'fast']);
  });

  it('does not mutate the input ring', () => {
    const input = [ev('a', 0, 1), ev('b', 500, 1)];
    slowestRecent(input);
    expect(input.map((e) => e.name)).toEqual(['a', 'b']);
  });
});

describe('IpcSection — three-valued, so a missing bridge never reads as a broken one', () => {
  it('says "browser mode" when there is no desktop runtime', () => {
    render(<IpcSection read={{ kind: 'unavailable' }} />);
    expect(screen.getByTestId('ipc-unavailable').textContent).toMatch(/browser mode/i);
    expect(screen.queryByTestId('ipc-error')).toBeNull();
    expect(screen.queryByTestId('ipc-ok')).toBeNull();
  });

  it('shows the error text when the command refuses', () => {
    render(<IpcSection read={{ kind: 'error', error: 'capability denied' }} />);
    expect(screen.getByTestId('ipc-error').textContent).toMatch(/capability denied/);
    expect(screen.queryByTestId('ipc-unavailable')).toBeNull();
  });

  it('flags a hung dial explicitly, because repeated dial-in-flight IS the diagnosis', () => {
    render(
      <IpcSection
        read={{
          kind: 'ok',
          status: {
            resolvedPath: '/run/user/1000/x.sock',
            resolutionDetail: 'discovery file',
            client: 'dial-in-flight',
            attempts: 3,
            reuses: 0,
            resolveMisses: 0,
            connectErrors: 0,
            connects: 0,
            invokes: 0,
            msSinceLastAttempt: 120,
            msSinceLastConnect: null,
            lastError: null,
            connectedPath: null,
            ownerIsContentOrigin: false,
            snapshotStartedAtUnixMs: 1_700_000_000_000,
            snapshotDurationMs: 0.5,
          },
        }}
      />,
    );
    const box = screen.getByTestId('ipc-ok');
    expect(box.textContent).toMatch(/dial is hung/i);
    // ownerIsContentOrigin:false is WHY /api/desktop/* fell back to HTTP (D-008).
    expect(box.textContent).toMatch(/cannot ride IPC/i);
  });
});

describe('AdvSyncHealthPanel render', () => {
  it('renders the gate line and says so when nothing has been recorded yet', () => {
    snapshot.mockReturnValue(snap());
    recentQueries.mockReturnValue([]);
    readIpcStatus.mockResolvedValue({ kind: 'unavailable' });

    render(<AdvSyncHealthPanel />);
    expect(screen.getByTestId('gate-line').textContent).toBe('2 in flight of 6 · 0 queued');
    expect(screen.getByTestId('no-queries').textContent).toMatch(/nothing recorded yet/i);
  });

  it('renders the per-query table once queries exist', () => {
    snapshot.mockReturnValue(snap({ byQuery: { 'plans.list': stat({ bytes: 900_000 }) } }));
    recentQueries.mockReturnValue([]);
    readIpcStatus.mockResolvedValue({ kind: 'unavailable' });

    render(<AdvSyncHealthPanel />);
    expect(screen.queryByTestId('no-queries')).toBeNull();
    expect(screen.getByText('plans.list')).toBeTruthy();
    expect(screen.getByText('878.9 KB')).toBeTruthy(); // 900000 / 1024
  });

  it('surfaces an unmeasured gate loudly instead of as zeros', () => {
    snapshot.mockReturnValue(
      snap({ transport: { ...snap().transport, inFlight: null, queued: null, limit: null } }),
    );
    recentQueries.mockReturnValue([]);
    readIpcStatus.mockResolvedValue({ kind: 'unavailable' });

    render(<AdvSyncHealthPanel />);
    expect(screen.getByTestId('gate-line').textContent).toMatch(/unknown/i);
  });
});
