// @vitest-environment jsdom
/**
 * AdvHarnessPanelPage.test — the /adv per-pot harness panel router
 * (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09 P-008/P-009).
 *
 * This file is a thin ROUTER: scope=all → a per-pot empty hint; panel 'git' →
 * AdvGitWorkspace; the DIRECT registry panels (brainstorm/prs/insights/
 * settings/docs/testing) → their component, but only with a selected ?slug=. The heavy
 * child panels + the lexicon/flag hooks are stubbed so we can assert the routing
 * + the BLUEPRINT_AWARE_SETTINGS flag swap on Settings without their trees.
 *
 * nuqs is mocked with a controllable per-key store (the AdvShell.test pattern):
 * setters are no-op spies; tests seed slug/scope before each render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// ── nuqs: per-key store the tests seed; setters are inert spies. ──
const nuqsState: Record<string, unknown> = { slug: null, scope: 'expanded' };
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [nuqsState[key], vi.fn(async () => {})],
  parseAsString: {},
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
}));

// ── Lexicon: identity-ish resolver ('pot' → 'pot', 'Pot'). ──
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (term: string, opts?: { lower?: boolean }) => (opts?.lower ? term : term[0].toUpperCase() + term.slice(1)),
}));

// ── Flag: BLUEPRINT_AWARE_SETTINGS — flipped per-test via the ref. ──
const flagRef = { blueprintAware: false };
vi.mock('@/lib/flag-hooks', () => ({ useFlag: () => flagRef.blueprintAware }));

// ── Heavy child panels: stub each to a marker element with its slug. ──
vi.mock('@/app/adv/harnesses/AdvGitWorkspace', () => ({ default: () => <div data-testid="git-workspace">git</div> }));
vi.mock('@/app/harness/PrsTab', () => ({ default: ({ harnessSlug }: { harnessSlug: string }) => <div data-testid="prs">{harnessSlug}</div> }));
vi.mock('@/app/harness/HarnessSettingsPanel', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="settings-legacy">{slug}</div> }));
vi.mock('@/app/harness/BlueprintSettingsPanel', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="settings-blueprint">{slug}</div> }));
vi.mock('@/app/harness/insights/InsightsTab', () => ({
  InsightsTab: ({ slug }: { slug: string }) => <div data-testid="insights">{slug}</div>,
}));
vi.mock('@/app/adv/harnesses/AdvDocsTab', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="docs">{slug}</div> }));
vi.mock('@/app/adv/harnesses/HarnessTestsView', () => ({ default: ({ slug }: { slug: string }) => <div data-testid="testing">{slug}</div> }));
vi.mock('@/app/harness/brainstorm/BrainstormFull', () => ({ BrainstormFull: ({ slug }: { slug: string }) => <div data-testid="brainstorm">{slug}</div> }));

import AdvHarnessPanelPage, { ADV_HARNESS_PANEL_LABELS } from './AdvHarnessPanelPage';

beforeEach(() => {
  nuqsState.slug = null;
  nuqsState.scope = 'expanded';
  flagRef.blueprintAware = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ADV_HARNESS_PANEL_LABELS', () => {
  it('labels every routable harness panel', () => {
    expect(ADV_HARNESS_PANEL_LABELS).toEqual({
      brainstorm: 'Brainstorm',
      prs: 'PRs',
      insights: 'Insights',
      settings: 'Settings',
      docs: 'Docs',
      git: 'Git',
      testing: 'Tests',
    });
  });
});

describe('<AdvHarnessPanelPage> routing', () => {
  it('scope=all → the per-pot empty hint, no child panel', () => {
    nuqsState.scope = 'all';
    nuqsState.slug = 'pot-a';
    render(<AdvHarnessPanelPage panel="insights" />);
    expect(screen.getByText(/is a per-pot view — pick a Pot from the dropdown above/)).toBeTruthy();
    expect(screen.queryByTestId('insights-tab')).toBeNull();
  });

  it('panel=git → AdvGitWorkspace (owns its own slug; renders even without ?slug=)', () => {
    render(<AdvHarnessPanelPage panel="git" />);
    expect(screen.getByTestId('git-workspace')).toBeTruthy();
  });


  it('PrsTab receives the slug as harnessSlug', () => {
    nuqsState.slug = 'pot-prs';
    render(<AdvHarnessPanelPage panel="prs" />);
    expect(screen.getByTestId('prs').textContent).toBe('pot-prs');
  });

  it('Brainstorm renders the canonical BrainstormFull surface for the selected pot', () => {
    nuqsState.slug = 'pot-ideas';
    render(<AdvHarnessPanelPage panel="brainstorm" />);
    expect(screen.getByTestId('brainstorm').textContent).toBe('pot-ideas');
  });

  it('a DIRECT panel with NO slug renders the "Select a Pot." prompt', () => {
    nuqsState.slug = null;
    render(<AdvHarnessPanelPage panel="docs" />);
    expect(screen.getByText('Select a Pot.')).toBeTruthy();
    expect(screen.queryByTestId('docs')).toBeNull();
  });

  it('Settings → legacy panel when the blueprint flag is OFF', () => {
    nuqsState.slug = 'pot-s';
    flagRef.blueprintAware = false;
    render(<AdvHarnessPanelPage panel="settings" />);
    expect(screen.getByTestId('settings-legacy')).toBeTruthy();
    expect(screen.queryByTestId('settings-blueprint')).toBeNull();
  });

  it('Settings → blueprint panel when the flag is ON', () => {
    nuqsState.slug = 'pot-s';
    flagRef.blueprintAware = true;
    render(<AdvHarnessPanelPage panel="settings" />);
    expect(screen.getByTestId('settings-blueprint')).toBeTruthy();
    expect(screen.queryByTestId('settings-legacy')).toBeNull();
  });

  it('testing panel routes to HarnessTestsView with the slug', () => {
    nuqsState.slug = 'pot-t';
    render(<AdvHarnessPanelPage panel="testing" />);
    expect(screen.getByTestId('testing').textContent).toBe('pot-t');
  });
});

describe('Insights read recovery', () => {
  const success = () => new Response(JSON.stringify({ insights: {} }), { status: 200 });

  it('retries a cold read failure without leaving the selected pot', async () => {
    nuqsState.slug = 'insights-cold-retry';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    render(<AdvHarnessPanelPage panel="insights" />);

    await screen.findByText(/Could not load insights: HTTP 503/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect((await screen.findByTestId('insights')).textContent).toBe('insights-cold-retry');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/harness/insights-cold-retry/insights', { cache: 'no-store' });
  });

  it('keeps cached cards visible while reporting and retrying a failed refresh', async () => {
    nuqsState.slug = 'insights-warm-retry';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<AdvHarnessPanelPage panel="insights" />);
    await screen.findByTestId('insights');
    first.unmount();
    render(<AdvHarnessPanelPage panel="insights" />);

    expect(screen.getByTestId('insights').textContent).toBe('insights-warm-retry');
    expect((await screen.findByRole('alert')).textContent).toContain('Could not refresh insights');
    expect(screen.getByTestId('insights')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('insights')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('loads a cold pot and immediately reuses its cached cards on a successful revisit', async () => {
    nuqsState.slug = 'insights-success-control';
    let finishRefresh!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(success())
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<AdvHarnessPanelPage panel="insights" />);
    expect(screen.getByText('Loading insights…')).toBeTruthy();
    await screen.findByTestId('insights');
    first.unmount();
    render(<AdvHarnessPanelPage panel="insights" />);

    expect(screen.getByTestId('insights')).toBeTruthy();
    expect(screen.queryByText('Loading insights…')).toBeNull();
    await act(async () => finishRefresh(success()));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['cold', 'cached'])('reports a missing payload on a %s read and recovers through retry', async (visit) => {
    nuqsState.slug = `insights-missing-${visit}`;
    const fetchMock = vi.fn();
    if (visit === 'cached') fetchMock.mockResolvedValueOnce(success());
    fetchMock
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(success());
    vi.stubGlobal('fetch', fetchMock);
    if (visit === 'cached') {
      const first = render(<AdvHarnessPanelPage panel="insights" />);
      await screen.findByTestId('insights');
      first.unmount();
    }
    render(<AdvHarnessPanelPage panel="insights" />);

    expect((await screen.findByRole('alert')).textContent).toContain('insights payload missing');
    expect(Boolean(screen.queryByTestId('insights'))).toBe(visit === 'cached');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(screen.getByTestId('insights')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a late response for a previous pot and leaves its cache untouched', async () => {
    nuqsState.slug = 'insights-previous-pot';
    let finishPrevious!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPrevious = resolve; }))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<AdvHarnessPanelPage panel="insights" />);
    nuqsState.slug = 'insights-current-pot';
    view.rerender(<AdvHarnessPanelPage panel="insights" />);
    expect((await screen.findByTestId('insights')).textContent).toBe('insights-current-pot');

    await act(async () => finishPrevious(success()));
    expect(screen.getByTestId('insights').textContent).toBe('insights-current-pot');
    expect(screen.queryByRole('alert')).toBeNull();
    nuqsState.slug = 'insights-previous-pot';
    view.rerender(<AdvHarnessPanelPage panel="insights" />);
    expect(screen.queryByTestId('insights')).toBeNull();
    expect((await screen.findByRole('alert')).textContent).toContain('HTTP 403');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/harness/insights-previous-pot/insights', { cache: 'no-store' });
  });
});
