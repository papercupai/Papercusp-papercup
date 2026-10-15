// @vitest-environment jsdom
//
// AdvFramesTab render coverage — the Swarm live view
// (hive-frame-desktops-live-view-2026-06-06). Companion to
// AdvFramesTab.format.test.ts (pure helpers). Mounts the tab against a stubbed
// /api/deploy/frames roster + a mocked @papercusp/sse stream (nuqs mocked, the
// pinned sibling pattern — see AdvConversationsTab.test.tsx) and asserts:
//   - the loading / error / no-frames states,
//   - one SSE stream per deployed slug (+ close on unmount),
//   - per-frame status chips (idle / N active / unreachable / no desktop) and
//     the D-002 watch/drive session indicator,
//   - thumb events become tiles and tile clicks toggle ?frame= selection,
//   - the enlarged panel's stills → screen-track → VNC mode ladder, the
//     track-unavailable fallback, and the close button clearing all URL state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

// Parsers from the shared complete mock (EI-8821) so a new parseAsX call
// elsewhere can't silently red this suite.
const nuqsState: Record<string, unknown> = { frame: null, live: false, drive: false };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
}));

// @papercusp/sse: capture each per-slug stream's handlers so tests can fire
// thumb/status events, and record close() calls.
type SseHandlers = Record<string, (raw: string) => void>;
const sseSources = new Map<string, { handlers: SseHandlers; close: ReturnType<typeof vi.fn> }>();
vi.mock('@papercusp/sse', () => ({
  createResilientEventSource: (opts: { url: string; handlers: SseHandlers }) => {
    const slug = decodeURIComponent(
      /\/api\/deploy\/([^/]+)\/frame-view/.exec(opts.url)?.[1] ?? opts.url,
    );
    const src = { handlers: opts.handlers, close: vi.fn() };
    sseSources.set(slug, src);
    return src;
  },
}));

// The live-view leaves are heavy (noVNC / holepunch) — stub them with markers
// that surface their props + the onUnavailable fallback hook.
vi.mock('./FrameVncView', () => ({
  default: ({
    slug,
    display,
    drive,
    target,
  }: {
    slug: string;
    display: number;
    drive: boolean;
    target?: string;
  }) => (
    <div
      data-testid="vnc-view"
      data-slug={slug}
      data-display={display}
      data-drive={String(drive)}
      data-target={target ?? 'frame'}
    />
  ),
}));
vi.mock('./FrameScreenTrackView', () => ({
  default: ({
    slug,
    display,
    onUnavailable,
  }: {
    slug: string;
    display: number;
    onUnavailable: (reason: string) => void;
  }) => (
    <div data-testid="screentrack-view" data-slug={slug} data-display={display}>
      <button type="button" onClick={() => onUnavailable('no relay')}>
        simulate-track-unavailable
      </button>
    </div>
  ),
}));

// Lexicon resolver mocked to ECHO its key (t('fleet') → 'fleet') — isolates the
// Swarm→Fleet routed title from the THE_HIVE flag hook (restore-pot-lexicon P-006).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

// `desktops.local` — this computer's agent desktops, counted for the D-011 link.
const localRoster = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  error: null as Error | null,
  queries: [] as string[],
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    localRoster.queries.push(queryName);
    return { data: localRoster.rows, loading: false, error: localRoster.error };
  },
}));

import AdvFramesTab, { LOCAL_DESKTOPS_HREF, type DeployedFrameRow } from './AdvFramesTab';

const FRAMES: DeployedFrameRow[] = [
  { slug: 'alpha', frame: { id: 'f1', host: 'alpha.host', target: 'hetzner' }, desktop: { displays: 2 } },
  { slug: 'beta', frame: { id: 'f2', host: 'beta.host', target: 'hetzner' }, desktop: false },
];

function stubFrames(payload: unknown, opts: { fail?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/deploy/frames')) {
        if (opts.fail) return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}


/** Fire an SSE event into the captured per-slug stream (inside act). */
function fireSse(slug: string, kind: 'thumb' | 'status', payload: Record<string, unknown>) {
  const src = sseSources.get(slug);
  if (!src) throw new Error(`no SSE source captured for ${slug}`);
  act(() => src.handlers[kind](JSON.stringify(payload)));
}

const thumb = (slug: string, display: number, over: Record<string, unknown> = {}) => ({
  slug,
  display,
  jpegBase64: 'AAAA',
  capturedAtMs: Date.now(),
  ...over,
});

beforeEach(() => {
  nuqsState.frame = null;
  nuqsState.live = false;
  nuqsState.drive = false;
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  sseSources.clear();
  localRoster.rows = [];
  localRoster.error = null;
  localRoster.queries = [];
  stubFrames({ frames: FRAMES });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Render and wait for the roster fetch + SSE streams to settle. */
async function renderLoaded() {
  const utils = render(<AdvFramesTab />);
  await waitFor(() => expect(sseSources.size).toBe(2));
  return utils;
}

describe('AdvFramesTab — roster states', () => {
  it('shows the loading state, then the roster summary', async () => {
    render(<AdvFramesTab />);
    expect(screen.getByText('Loading deployed frames…')).toBeTruthy();
    expect(await screen.findByText('2 frames · 0 live displays')).toBeTruthy();
    expect(screen.getByText(/No active displays/)).toBeTruthy();
  });

  it('shows the empty state when nothing is deployed', async () => {
    stubFrames({ frames: [] });
    render(<AdvFramesTab />);
    expect(await screen.findByText(/No deployed frames/)).toBeTruthy();
    expect(screen.getByText('no deployed frames')).toBeTruthy();
  });

  it('surfaces a roster fetch failure', async () => {
    stubFrames(null, { fail: true });
    render(<AdvFramesTab />);
    expect(await screen.findByText('HTTP 502')).toBeTruthy();
  });

  it('opens one SSE stream per deployed slug and closes them on unmount', async () => {
    const { unmount } = await renderLoaded();
    expect([...sseSources.keys()].sort()).toEqual(['alpha', 'beta']);
    unmount();
    for (const src of sseSources.values()) expect(src.close).toHaveBeenCalled();
  });
});

describe('AdvFramesTab — status chips', () => {
  it('renders idle / no-desktop chip metas before any status arrives', async () => {
    await renderLoaded();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('idle')).toBeTruthy(); // alpha: desktop, no status yet
    expect(screen.getByText('no desktop')).toBeTruthy(); // beta: desktop:false
  });

  it('flips a chip to "N active" with the watch indicator on a status event', async () => {
    await renderLoaded();
    fireSse('alpha', 'status', {
      slug: 'alpha',
      state: 'polling',
      displays: [0, 1],
      viewers: [{ display: 0, mode: 'takeover', sinceMs: 1 }],
    });
    expect(screen.getByText('2 active')).toBeTruthy();
    const watch = screen.getByTitle('a human is DRIVING a display');
    expect(watch.getAttribute('data-drive')).toBe('true');
    expect(watch.textContent).toContain('1');
  });

  it('marks an unreachable frame from an error status', async () => {
    await renderLoaded();
    fireSse('alpha', 'status', { slug: 'alpha', state: 'error', error: 'ssh refused' });
    expect(screen.getByText('unreachable')).toBeTruthy();
    expect(screen.getByTitle('ssh refused')).toBeTruthy();
  });
});

describe('AdvFramesTab — tiles + selection', () => {
  it('renders a sorted tile per thumb event and updates the live-display count', async () => {
    await renderLoaded();
    fireSse('alpha', 'thumb', thumb('alpha', 1, { role: 'worker' }));
    fireSse('alpha', 'thumb', thumb('alpha', 0));
    expect(screen.getByText('2 frames · 2 live displays')).toBeTruthy();
    const imgs = screen.getAllByRole('img');
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual([
      'alpha display :0',
      'alpha display :1',
    ]);
    expect(screen.getByText('worker')).toBeTruthy(); // role badge
    expect(screen.getAllByText(/0s ago/).length).toBeGreaterThan(0);
  });

  it('clicking a tile selects it; clicking again clears the selection', async () => {
    await renderLoaded();
    fireSse('alpha', 'thumb', thumb('alpha', 0));
    fireEvent.click(screen.getByRole('button', { name: 'alpha :0' }));
    expect(nuqsSetters.frame).toHaveBeenCalledWith('alpha:0');

    cleanup();
    sseSources.clear();
    nuqsState.frame = 'alpha:0';
    await renderLoaded();
    fireSse('alpha', 'thumb', thumb('alpha', 0));
    const tile = screen.getByRole('button', { name: 'alpha :0' });
    expect(tile.getAttribute('data-selected')).toBe('true');
    fireEvent.click(tile);
    expect(nuqsSetters.frame).toHaveBeenCalledWith(null);
  });

  it('ignores a malformed ?frame= key (no panel)', async () => {
    nuqsState.frame = 'not-a-key';
    await renderLoaded();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AdvFramesTab — enlarged panel', () => {
  it('shows the stills panel with the enlarged image and Watch live', async () => {
    nuqsState.frame = 'alpha:0';
    await renderLoaded();
    fireSse('alpha', 'thumb', thumb('alpha', 0, { role: 'mug' }));
    const panel = screen.getByRole('region', { name: 'Frame live view' });
    expect(panel.textContent).toContain('alpha');
    expect(panel.textContent).toContain('mug');
    expect(screen.getByAltText('alpha display :0 (enlarged)')).toBeTruthy();
    expect(screen.getByText(/stills refresh every few seconds/)).toBeTruthy();
    fireEvent.click(screen.getByText('Watch live'));
    expect(nuqsSetters.live).toHaveBeenCalledWith(true);
    expect(nuqsSetters.drive).not.toHaveBeenCalled();
  });

  it('shows the idle placeholder when the selected display has no thumb yet', async () => {
    nuqsState.frame = 'alpha:1';
    await renderLoaded();
    expect(screen.getByText(/display is idle — no frame yet/)).toBeTruthy();
  });

  it('live mode mounts the holepunch screen track read-only', async () => {
    nuqsState.frame = 'alpha:0';
    nuqsState.live = true;
    await renderLoaded();
    const track = screen.getByTestId('screentrack-view');
    expect(track.getAttribute('data-slug')).toBe('alpha');
    expect(track.getAttribute('data-display')).toBe('0');
    expect(screen.queryByTestId('vnc-view')).toBeNull();
    expect(screen.getByText(/holepunch screen track — read-only/)).toBeTruthy();
    expect(screen.getByText('read-only')).toBeTruthy();
    expect(screen.getByText('Take control')).toBeTruthy();
    // Back to stills tears down drive then live
    fireEvent.click(screen.getByText('Back to stills'));
    expect(nuqsSetters.drive).toHaveBeenCalledWith(null);
    expect(nuqsSetters.live).toHaveBeenCalledWith(null);
  });

  it('falls back to read-only VNC when the screen track is unavailable (P-013)', async () => {
    nuqsState.frame = 'alpha:0';
    nuqsState.live = true;
    await renderLoaded();
    fireEvent.click(screen.getByText('simulate-track-unavailable'));
    const vnc = await screen.findByTestId('vnc-view');
    expect(vnc.getAttribute('data-drive')).toBe('false');
    expect(screen.getByText(/screen track unavailable: no relay/)).toBeTruthy();
  });

  it('drive mode mounts VNC with input and the DRIVING marker', async () => {
    nuqsState.frame = 'alpha:0';
    nuqsState.live = true;
    nuqsState.drive = true;
    await renderLoaded();
    const vnc = screen.getByTestId('vnc-view');
    expect(vnc.getAttribute('data-drive')).toBe('true');
    expect(screen.getByText('DRIVING')).toBeTruthy();
    expect(screen.getByText(/you are driving this display \(audited\)/)).toBeTruthy();
    fireEvent.click(screen.getByText('Release control'));
    expect(nuqsSetters.drive).toHaveBeenCalledWith(null);
  });

  it('the close button clears drive, live, and the selection', async () => {
    nuqsState.frame = 'alpha:0';
    nuqsState.live = true;
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Close live view'));
    await waitFor(() => expect(nuqsSetters.frame).toHaveBeenCalledWith(null));
    expect(nuqsSetters.drive).toHaveBeenCalledWith(null);
    expect(nuqsSetters.live).toHaveBeenCalledWith(null);
  });
});

describe('AdvFramesTab — this computer’s desktops live on the Desktops page (D-011)', () => {
  it('links to Desktops › This computer with the count from desktops.local', async () => {
    localRoster.rows = [{ id: 'ds-1' }, { id: 'ds-2' }];
    stubFrames({ frames: FRAMES });
    render(<AdvFramesTab />);
    expect(localRoster.queries).toContain('desktops.local');
    const link = await screen.findByRole('link', { name: /2 agent desktops on this computer/ });
    expect(link.getAttribute('href')).toBe(LOCAL_DESKTOPS_HREF);
    expect(LOCAL_DESKTOPS_HREF).toBe('/desktops?desktopHost=local');
    // The frames half keeps its own summary, with no local count folded in.
    expect(screen.getByText('2 frames · 0 live displays')).toBeTruthy();
  });

  it('renders NO local tiles and never polls the old roster route', async () => {
    localRoster.rows = [{ id: 'ds-1' }];
    stubFrames({ frames: FRAMES });
    const { container } = render(<AdvFramesTab />);
    await screen.findByText('2 frames · 0 live displays');
    expect(container.querySelector('[aria-label="Local desktops"]')).toBeNull();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/deploy/local-desktops')),
    ).toBe(false);
  });

  it('points at the Desktops page from the empty state on a box with no frames', async () => {
    stubFrames({ frames: [] });
    render(<AdvFramesTab />);
    expect(await screen.findByText(/No deployed frames\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Desktops page' }).getAttribute('href')).toBe(
      LOCAL_DESKTOPS_HREF,
    );
    // No count when there are none — the link still offers the page.
    expect(screen.getByRole('link', { name: /Desktops on this computer/ })).toBeTruthy();
  });

  it('a failing local roster only hides the count, never the frames view', async () => {
    localRoster.error = new Error('down');
    localRoster.rows = [{ id: 'ds-1' }];
    stubFrames({ frames: FRAMES });
    render(<AdvFramesTab />);
    expect(await screen.findByText('2 frames · 0 live displays')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Desktops on this computer/ })).toBeTruthy();
  });

  it('a frame selection still drives the frame VNC view', async () => {
    nuqsState.frame = 'alpha:2';
    nuqsState.live = true;
    nuqsState.drive = true;
    stubFrames({ frames: FRAMES });
    render(<AdvFramesTab />);
    const view = await screen.findByTestId('vnc-view');
    expect(view.getAttribute('data-target')).toBe('frame');
    expect(view.getAttribute('data-slug')).toBe('alpha');
    expect(view.getAttribute('data-display')).toBe('2');
  });
});
