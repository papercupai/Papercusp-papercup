// @vitest-environment jsdom
//
// RightRail — the live status rail (plugin host / pg / build / activity). Its
// pure display logic is two relative-age formatters: fmtRel (ISO → bare age)
// and fmtRelMs (epoch-ms-or-null → "N…ago"), pinned with a fixed clock below.
// The render-level tests drive the four polled blocks for real: the per-section
// "…" placeholder before data arrives, the populated plugin-host / postgres /
// build stats, the build "missing" / ":3070 down" failure rendering, and the
// activity empty vs populated list. postTool swallows non-ok responses to null,
// so a section that fails to fetch must keep its placeholder — exactly the
// gating the formatter tests can't see.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { OperatorWorkspaceLocationProvider } from '@papercusp/operator-ui';

import RightRail, { fmtRel, fmtRelMs } from './RightRail';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

describe('fmtRel', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  it('renders a bare s / m / h / d age (no "ago" suffix)', () => {
    expect(fmtRel(new Date(NOW - 20_000).toISOString())).toBe('20s');
    expect(fmtRel(new Date(NOW - 3 * 60_000).toISOString())).toBe('3m');
    expect(fmtRel(new Date(NOW - 4 * 3_600_000).toISOString())).toBe('4h');
    expect(fmtRel(new Date(NOW - 5 * 86_400_000).toISOString())).toBe('5d');
  });
});

describe('fmtRelMs', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  it('renders an em dash for null', () => { expect(fmtRelMs(null)).toBe('—'); });
  it('renders "N… ago" from an epoch-ms timestamp', () => {
    expect(fmtRelMs(NOW - 45_000)).toBe('45s ago');
    expect(fmtRelMs(NOW - 6 * 60_000)).toBe('6m ago');
    expect(fmtRelMs(NOW - 2 * 3_600_000)).toBe('2h ago');
    expect(fmtRelMs(NOW - 7 * 86_400_000)).toBe('7d ago');
  });
});

describe('<RightRail /> polled blocks', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  // The rail reads plugin-host status and makes three read-only MCP-tool
  // POSTs (activity / pg_health / build_status); route by URL.
  const stubFetch = (impl: (url: string) => { ok: boolean; body?: unknown }) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const { ok, body } = impl(url);
      if (!ok) return { ok: false } as Response;
      if (url.includes('/api/plugins/host/refresh')) {
        return { ok: true, json: async () => body } as Response;
      }
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(body) }] }) } as Response;
    }));
  };

  it('reads plugin status without reloading plugins on mount, polling or workspace changes', () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const { rerender, unmount } = render(<RightRail workspaceIds={null} />);
    act(() => { vi.advanceTimersByTime(15_000); });
    rerender(<RightRail workspaceIds={['workspace-a']} />);
    const hostRequests = () => (fetch.mock.calls as unknown as Array<[string, RequestInit]>)
      .filter(([url]) => url === '/api/plugins/host/refresh');
    expect(hostRequests()).toHaveLength(3);
    expect(hostRequests().map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'GET', 'GET']);
    unmount();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(hostRequests()).toHaveLength(3);
  });

  it('explains cloud diagnostic availability without sending local diagnostic requests', () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    render(<OperatorWorkspaceLocationProvider location="cloud"><RightRail workspaceIds={null} /></OperatorWorkspaceLocationProvider>);
    expect(screen.getByRole('status').textContent).toContain('Local diagnostics unavailable');
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops local polling when the host changes to a cloud workspace', () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const { rerender } = render(<OperatorWorkspaceLocationProvider location="local"><RightRail workspaceIds={null} /></OperatorWorkspaceLocationProvider>);
    expect(fetch).toHaveBeenCalledTimes(4);
    rerender(<OperatorWorkspaceLocationProvider location="cloud"><RightRail workspaceIds={null} /></OperatorWorkspaceLocationProvider>);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('status').textContent).toContain('local desktop profile');
  });

  it('shows the "…" placeholder in each block before data arrives', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<RightRail workspaceIds={null} />);
    // Plugin host / Postgres / Build each render a "…" placeholder; activity its own copy.
    expect(screen.getAllByText('…').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('no recent activity')).toBeTruthy();
  });

  it('renders plugin-host, postgres and build stats once the polls resolve', async () => {
    stubFetch((url) => {
      if (url.includes('/api/plugins/host/refresh')) return { ok: true, body: { status: { loaded: 4, errors: 0 } } };
      if (url.includes('/activity')) return { ok: true, body: { entries: [] } };
      if (url.includes('/pg_health')) return { ok: true, body: { totalConnections: 9, activeConnections: 3, idleConnections: 6 } };
      if (url.includes('/build_status')) return { ok: true, body: { prodBuild: { exists: true, mtimeMs: NOW - 60_000 }, prodLogTail: null, dev3055Reachable: true, prod3070Reachable: true } };
      return { ok: true, body: {} };
    });
    render(<RightRail workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('9')).toBeTruthy()); // pg total connections
    expect(screen.getByText('4')).toBeTruthy(); // plugin host loaded
    expect(screen.getByText('up')).toBeTruthy(); // :3070 reachable
  });

  it('renders the build failure state (missing build + :3070 down)', async () => {
    stubFetch((url) => {
      if (url.includes('/api/plugins/host/refresh')) return { ok: true, body: { status: { loaded: 0, errors: 2 } } };
      if (url.includes('/activity')) return { ok: true, body: { entries: [] } };
      if (url.includes('/pg_health')) return { ok: true, body: { totalConnections: 1, activeConnections: 0, idleConnections: 1 } };
      if (url.includes('/build_status')) return { ok: true, body: { prodBuild: { exists: false, mtimeMs: null }, prodLogTail: null, dev3055Reachable: false, prod3070Reachable: false } };
      return { ok: true, body: {} };
    });
    render(<RightRail workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('missing')).toBeTruthy());
    expect(screen.getByText('down')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy(); // plugin host errors
  });

  it('renders the activity list when entries are present', async () => {
    stubFetch((url) => {
      if (url.includes('/api/plugins/host/refresh')) return { ok: true, body: { status: { loaded: 1, errors: 0 } } };
      if (url.includes('/activity')) return { ok: true, body: { entries: [
        { id: 'a1', workspace_id: 'w', harness_slug: 'h1', tool_name: 'tool.run', role: 'architect', invoked_at: new Date(NOW - 5000).toISOString(), duration_ms: 120, status: 'ok' },
        { id: 'a2', workspace_id: 'w', harness_slug: null, tool_name: 'tool.fail', role: null, invoked_at: new Date(NOW - 5000).toISOString(), duration_ms: null, status: 'error' },
      ] } };
      if (url.includes('/pg_health')) return { ok: true, body: { totalConnections: 1, activeConnections: 0, idleConnections: 1 } };
      if (url.includes('/build_status')) return { ok: true, body: { prodBuild: { exists: true, mtimeMs: NOW }, prodLogTail: null, dev3055Reachable: true, prod3070Reachable: true } };
      return { ok: true, body: {} };
    });
    render(<RightRail workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('tool.run')).toBeTruthy());
    expect(screen.getByText('tool.fail')).toBeTruthy();
    expect(screen.queryByText('no recent activity')).toBeNull();
  });

  it('keeps a section in its placeholder when its poll returns non-ok (postTool → null)', async () => {
    // Plugin host refresh fails (non-ok) → status stays null → "…" persists for
    // that block, while pg/build still populate. Guards the swallow-to-null path.
    stubFetch((url) => {
      if (url.includes('/api/plugins/host/refresh')) return { ok: false };
      if (url.includes('/activity')) return { ok: true, body: { entries: [] } };
      if (url.includes('/pg_health')) return { ok: true, body: { totalConnections: 2, activeConnections: 1, idleConnections: 1 } };
      if (url.includes('/build_status')) return { ok: true, body: { prodBuild: { exists: true, mtimeMs: NOW }, prodLogTail: null, dev3055Reachable: true, prod3070Reachable: true } };
      return { ok: true, body: {} };
    });
    render(<RightRail workspaceIds={null} />);
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy()); // pg populated
    // Plugin host block still shows its "…" placeholder (it never got status).
    expect(screen.getAllByText('…').length).toBeGreaterThanOrEqual(1);
  });
});
