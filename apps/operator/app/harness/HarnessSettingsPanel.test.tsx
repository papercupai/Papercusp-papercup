// @vitest-environment jsdom
/**
 * HarnessSettingsPanel.test.tsx — render-tier coverage for the legacy
 * per-harness Settings panel (whole-app-test-coverage-breadth). The panel
 * gates rendering behind `loaded` (config.json via useSyncQuery), so the test
 * feeds a config row to flip it loaded, then exercises: the loading gate, the
 * always-on sections (Workers / AI backend / Discord / Save bar — the chunk-loop
 * and debugger-threshold knobs were removed from the panel with the chunk
 * loop itself), the testing-flag-gated controls (workers-per-feature
 * mode, tiers section), the tiers add/remove row flow, the Discord
 * shared/not-shared branch, and a successful Save (toast.success).
 *
 * Mocked: useFlag (controls the testing flag), @papercusp/flags (FLAGS),
 * useSyncQuery, sonner, VirtualGrid (stub list), and the two heavy children.
 * fetch is allowed only for the filesystem-backed Discord shared marker and
 * mutations; durable config + telemetry must stay on named queries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
const syncState = new Map<string, { data: unknown[] | undefined; loading?: boolean }>();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data: syncState.get(queryName)?.data,
    error: null,
    loading: syncState.get(queryName)?.loading ?? false,
    fetching: false,
    invalidate: vi.fn(),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { TESTING: 'papercusp-testing' } }));

let testingFlagValue = false;
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => testingFlagValue }));

// VirtualGrid (RichGrid + an owned virtualizer) is a heavy grid — stub it to a
// simple row list so the panel smoke renders without measuring layout.
vi.mock('@papercusp/grid-core', () => ({
  VirtualGrid: ({ rows, getRowId }: { rows: { feature_id: string }[]; getRowId: (r: unknown) => string }) => (
    <div data-testid="telemetry-grid">{rows.map((r) => <div key={getRowId(r)}>{r.feature_id}</div>)}</div>
  ),
}));
vi.mock('./SavedPromptsSection', () => ({ default: () => <div data-testid="saved-prompts" /> }));
vi.mock('./HarnessPluginsSection', () => ({ default: () => <div data-testid="plugins-section" /> }));
vi.mock('./IntegrationModeSection', () => ({ default: () => <div data-testid="integration-mode-section" /> }));

import { toast } from 'sonner';
import HarnessSettingsPanel from './HarnessSettingsPanel';

/* ── Helpers ───────────────────────────────────────────────────────── */
function renderPanel(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

/** Make useSyncQuery hand back a config.json row so the panel flips `loaded`. */
function loadedConfigRow(cfg: Record<string, unknown> = {}) {
  return [{ harnessSlug: 'h', config: JSON.stringify(cfg) }];
}
function setLoadedConfig(cfg: Record<string, unknown> = {}) {
  syncState.set('harnessProjectFiles.byHarness', { data: loadedConfigRow(cfg) });
}

/** Stub only the filesystem-backed Discord marker and mutation calls. */
function stubFetch(opts: { isShared?: boolean } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/discord')) {
      return new Response(JSON.stringify({ isShared: opts.isShared ?? false, discord: null }), { status: 200 });
    }
    if (!init?.method || init.method === 'GET') throw new Error(`unexpected durable GET: ${url}`);
    // /spec PUT and other mutations.
    return new Response(JSON.stringify({ ok: true, config: '{}' }), { status: 200 });
  }));
}

beforeEach(() => {
  syncState.clear();
  syncState.set('adaptiveTelemetry.byHarness', { data: [] });
  testingFlagValue = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('HarnessSettingsPanel (legacy per-harness settings)', () => {
  it('shows the loading state before config has resolved', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    syncState.set('harnessProjectFiles.byHarness', { data: undefined, loading: true });
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders the always-on sections once config loads (flag OFF)', async () => {
    stubFetch();
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy());
    // The slug appears in the header.
    expect(screen.getByText(/Settings — h/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'AI backend' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Discord' })).toBeTruthy();
    // The chunk-loop checkbox is gone with the chunk loop (HarnessSettingsPanel.tsx
    // dropped `useChunkLoop` + the debugger threshold) — assert its absence so a
    // resurrected knob is a reviewed diff, not a silent return.
    expect(screen.queryByRole('checkbox', { name: 'chunk loop enabled' })).toBeNull();
    // Save bar present.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    // The flag-gated "workers / feature" mode control is hidden when the flag is off.
    expect(screen.queryByText('workers / feature')).toBeNull();
  });

  it('reveals the flag-gated worker-count controls when the testing flag is ON', async () => {
    stubFetch();
    testingFlagValue = true;
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('workers / feature')).toBeTruthy());
    expect(screen.getByText('features cap')).toBeTruthy();
    // Synthesizer knob is also flag-gated.
    expect(screen.getByRole('checkbox', { name: 'synthesize single-worker output' })).toBeTruthy();
  });

  it('renders the tiers section + telemetry empty state when config selects tier mode', async () => {
    stubFetch();
    testingFlagValue = true;
    // adaptive present → applyLoadedConfig infers workerCountMode 'tiers'.
    setLoadedConfig({
      parallelWorkers: { max: 4, adaptive: { tiers: [1, 2, 4], labels: ['a', 'b', 'c'], rubric: 'r' } },
    });
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Worker count tiers' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Recent worker decisions' })).toBeTruthy();
    expect(screen.getByText(/No worker decisions recorded yet/i)).toBeTruthy();
    // The "+ Add tier" control is present.
    expect(screen.getByRole('button', { name: /Add tier/i })).toBeTruthy();
  });

  it('adds a tier row when "+ Add tier" is clicked', async () => {
    stubFetch();
    testingFlagValue = true;
    setLoadedConfig({
      parallelWorkers: { max: 4, adaptive: { tiers: [1, 2], labels: ['a', 'b'], rubric: 'r' } },
    });
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('Tier 1')).toBeTruthy());
    expect(screen.getByText('Tier 2')).toBeTruthy();
    expect(screen.queryByText('Tier 3')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Add tier/i }));
    expect(screen.getByText('Tier 3')).toBeTruthy();
  });

  it('shows the not-shared Discord notice when the harness is private', async () => {
    stubFetch({ isShared: false });
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText(/only available for shared harnesses/i)).toBeTruthy());
    // The guild-id input only renders in the shared branch.
    expect(screen.queryByPlaceholderText(/1509111829471690783/)).toBeNull();
  });

  it('renders the Discord guild/invite inputs for a shared harness', async () => {
    stubFetch({ isShared: true });
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByPlaceholderText(/1509111829471690783/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Save Discord/i })).toBeTruthy();
  });

  it('adds an AI backend role-override row', async () => {
    stubFetch();
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('default (all roles)')).toBeTruthy());
    // One default row → its cmd input uses the "omp -p" placeholder.
    expect(screen.getByPlaceholderText('omp -p')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add role override/i }));
    // A new override row gives an "(inherits default)" cmd placeholder.
    expect(screen.getByPlaceholderText('(inherits default)')).toBeTruthy();
  });

  it('Save persists the config and toasts success', async () => {
    stubFetch();
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
  });

  it('mounts the saved-prompts and plugins sections', async () => {
    stubFetch();
    setLoadedConfig();
    renderPanel(<HarnessSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByTestId('saved-prompts')).toBeTruthy());
    expect(screen.getByTestId('plugins-section')).toBeTruthy();
  });

  it('withholds the previous harness config while a different harness is loading', async () => {
    stubFetch();
    setLoadedConfig({ aiBackend: { default: { model: 'old-model' } } });
    const panel = renderPanel(<HarnessSettingsPanel slug="old" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('old-model')).toBeTruthy());
    syncState.set('harnessProjectFiles.byHarness', { data: undefined, loading: true });
    panel.rerender(<NuqsTestingAdapter><HarnessSettingsPanel slug="next" phase="production" /></NuqsTestingAdapter>);
    expect(screen.queryByDisplayValue('old-model')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('does not claim success on a denied save and retries without losing edits', async () => {
    let deny = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return new Response('{"isShared":false}');
      return new Response(deny ? '{"error":"forbidden"}' : '{"ok":true}', { status: deny ? 403 : 200 });
    }));
    setLoadedConfig({ unrelated: { keep: true } });
    renderPanel(<HarnessSettingsPanel slug="chosen" phase="production" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('omp -p'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed', { description: 'HTTP 403' }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('codex')).toBeTruthy();
    deny = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
    const puts = vi.mocked(fetch).mock.calls.filter(c => c[1]?.method === 'PUT');
    expect(puts.map(c => c[0])).toEqual(['/api/harness/chosen/spec?phase=production', '/api/harness/chosen/spec?phase=production']);
    expect(JSON.parse(JSON.parse(String(puts[1][1]!.body)).config).unrelated).toEqual({ keep: true });
  });
});
