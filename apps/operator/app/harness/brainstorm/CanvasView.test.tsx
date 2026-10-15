// @vitest-environment jsdom
/**
 * CanvasView.test.tsx — the brainstorm "canvas" layer wraps Excalidraw, hydrated
 * from the `harnessBrainstorm.byHarness` sync row and debounce-saving to
 * /api/harness/<slug>/brainstorm-canvas. Excalidraw is dynamically imported and
 * extremely heavy, so we mock the `@excalidraw/excalidraw` module (and its CSS)
 * to a marker. This asserts CanvasView's OWN logic:
 *   - the loading guard (`brainstormRows === undefined` → "loading canvas…");
 *   - the staging-vs-first row selection;
 *   - hydration into a default empty scene when the row has no canvas;
 *   - the loaded surface mounting (the dynamic Excalidraw child).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] | undefined; loading?: boolean; error?: Error | null };
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: syncResult.data, loading: syncResult.loading ?? false, error: syncResult.error ?? null, fetching: false, invalidate: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@excalidraw/excalidraw/index.css', () => ({}));
// Heavy whiteboard — stub the dynamic import target to a marker that echoes the
// background-color override CanvasView injects via initialData.appState.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({
    initialData,
    validateEmbeddable,
    onChange,
  }: {
    initialData: { appState?: { viewBackgroundColor?: string } };
    validateEmbeddable?: (link: string) => boolean | undefined;
    onChange: (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => void;
  }) => (
    <div
      data-testid="excalidraw"
      data-bg={initialData?.appState?.viewBackgroundColor}
      data-twitter-policy={String(validateEmbeddable?.('https://platform.twitter.com/widgets.js'))}
      data-default-policy={String(validateEmbeddable?.('https://example.com/article'))}
    ><button type="button" onClick={() => onChange([{ id: 'edited-element' }], {}, {})}>change canvas</button></div>
  ),
}));

import { CanvasView } from './CanvasView';

function row(over: Record<string, unknown> = {}) {
  return { harnessSlug: 'h', phase: 'staging', content: '', canvas: null, mindmap: null, updatedAt: 1, ...over };
}

beforeEach(() => { syncResult = { data: undefined }; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('CanvasView (brainstorm canvas layer)', () => {
  it.each(['loading', 'failed'])('does not mount a writable empty scene while the initial Sync read is %s', async state => {
    syncResult = { data: [], loading: state === 'loading', error: state === 'failed' ? new Error('private read denied') : null };
    render(<CanvasView slug="h" />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/loading canvas/i)).toBeTruthy();
    expect(screen.queryByTestId('excalidraw')).toBeNull();
  });

  it.each([403, 500])('reports a resolved HTTP %i save rejection', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private save denied', { status })));
    syncResult = { data: [row()] };
    render(<CanvasView slug="h" />);
    await screen.findByRole('button', { name: 'change canvas' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'change canvas' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(fetch).toHaveBeenCalledWith('/api/harness/h/brainstorm-canvas', expect.objectContaining({ method: 'PUT' }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('private save denied'));
  });

  it('accepts a successful canvas save without a failure alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    syncResult = { data: [row()] };
    render(<CanvasView slug="h" />);
    await screen.findByRole('button', { name: 'change canvas' });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'change canvas' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the loading guard while the sync row is undefined', () => {
    syncResult = { data: undefined }; // still loading → loaded stays false
    render(<CanvasView slug="h" />);
    expect(screen.getByText(/loading canvas/i)).toBeTruthy();
    expect(screen.queryByTestId('excalidraw')).toBeNull();
  });

  it('hydrates into a default empty scene when the row carries no canvas', async () => {
    syncResult = { data: [row({ canvas: null })] };
    render(<CanvasView slug="h" />);
    // Dynamic Excalidraw resolves via Suspense → marker mounts.
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
    // CanvasView forces a transparent background over whatever scene loaded.
    expect(screen.getByTestId('excalidraw').getAttribute('data-bg')).toBe('transparent');
  });

  it('hydrates a persisted canvas scene from the staging row', async () => {
    const scene = { elements: [{ id: 'e1' }], appState: { viewBackgroundColor: '#fff' }, files: {} };
    syncResult = { data: [row({ phase: 'production', canvas: null }), row({ phase: 'staging', canvas: scene })] };
    render(<CanvasView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
    // Even a persisted bg is overridden to transparent (z-stacked layer).
    expect(screen.getByTestId('excalidraw').getAttribute('data-bg')).toBe('transparent');
  });

  it('an empty data array (no rows) still hydrates to the empty-scene surface', async () => {
    syncResult = { data: [] };
    render(<CanvasView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());
  });

  it('passes the fail-closed third-party embed policy to Excalidraw', async () => {
    syncResult = { data: [row()] };
    render(<CanvasView slug="h" />);
    await waitFor(() => expect(screen.getByTestId('excalidraw')).toBeTruthy());

    const canvas = screen.getByTestId('excalidraw');
    expect(canvas.getAttribute('data-twitter-policy')).toBe('false');
    expect(canvas.getAttribute('data-default-policy')).toBe('undefined');
  });
});
