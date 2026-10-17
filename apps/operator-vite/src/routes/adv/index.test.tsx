// @vitest-environment jsdom
/**
 * adv/index.test.tsx — the /adv tab router. The ?tab= nuqs enum selects which tab
 * surface renders (a big switch) and whether that tab gets the pot bar. Covers
 * every branch: the ten first-class tabs, the Create dock (plans), the
 * harness-panel tabs (prs/insights/git/testing → AdvHarnessPanelPage with the
 * panel id), and the overview default when ?tab is absent. Every tab child +
 * AdvShell + AdvPotBar are stubbed to markers.
 *
 * The AdvShell `title` prop is GONE (owner ask 2026-07-27: the "ADVANCED
 * ORCHESTRATION / <title>" bar was removed so the tabs sit at the very top), so
 * the per-tab assertion is now "the right surface, with/without the pot bar"
 * rather than "the right surface, with the right title".
 *
 * Seams: @tanstack/react-router (createFileRoute → Route), nuqs (real adapter
 * for ?tab=), AdvShell (ADV_TABS for the enum), AdvPotBar (marker; the REAL
 * potBarModeForTab decides, from the pure adv-pot-bar-tabs module),
 * AdvHarnessPanelPage.
 */
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// Provider-order sentinel: the shell mock enters the scope boundary while its
// child component renders. A hook call in AdvIndexPage itself therefore sees
// the All-Pots default, reproducing production; its child sees selected scope.
const advScopeBoundary = vi.hoisted(() => ({ entered: false }));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));

vi.mock('../../components/adv/AdvShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => {
    advScopeBoundary.entered = true;
    return <div data-testid="adv-shell">{children}</div>;
  },
  // Inlined (not a top-level const) — vi.mock factories are hoisted above
  // module-scope declarations, so referencing an outer `const` throws.
  ADV_TABS: [
    'overview', 'enterprise', 'hud', 'brainstorm', 'workflows', 'conversations', 'learning', 'harnesses', 'health', 'frames',
    'evals', 'calendar', 'plans', 'prs', 'insights', 'settings', 'history',
    'docs', 'git', 'stats', 'testing',
  ].map((id) => ({ id })),
  portalEmbedAdvTab: (tab: string, embedded: boolean) => (
    embedded && !['overview', 'enterprise', 'hud', 'learning', 'harnesses', 'workflows', 'brainstorm'].includes(tab) ? 'overview' : tab
  ),
  useAdvScope: () => advScopeBoundary.entered
    ? {
        allMode: false,
        scopeMode: 'expanded',
        slug: 'pot-a',
        hive: 'pot-a',
        harnessSlugs: ['pot-a', 'pot-a-child'],
        ready: true,
      }
    : {
        allMode: true,
        scopeMode: 'all',
        slug: null,
        hive: '',
        harnessSlugs: null,
        ready: false,
      },
}));
// The pot bar itself is mocked (it mounts a selector + four live status pills);
// the DECISION of which tabs get it is the real adv-pot-bar-tabs module, so these
// assertions pin the shipped behaviour, not a test-local copy of the rule.
vi.mock('../../components/adv/AdvPotBar', () => ({
  default: ({ withStatus }: { withStatus?: boolean }) => (
    <div data-testid="pot-bar" data-with-status={withStatus ? '1' : '0'} />
  ),
}));
vi.mock('../../components/adv/AdvOverviewTab', () => ({ default: () => <div data-testid="tab-overview" /> }));
vi.mock('../../components/adv/AdvStatsTab', () => ({ default: () => <div data-testid="tab-stats" /> }));
vi.mock('../../components/adv/AdvConversationsTab', () => ({ default: () => <div data-testid="tab-conversations" /> }));
vi.mock('../../components/adv/LearningTab', () => ({ default: () => <div data-testid="tab-learning" /> }));
vi.mock('../../components/adv/AdvFramesTab', () => ({ default: () => <div data-testid="tab-frames" /> }));
vi.mock('../../components/adv/AdvEvalsTab', () => ({ default: () => <div data-testid="tab-evals" /> }));
vi.mock('../../components/adv/ScheduledCalendarTab', () => ({ default: () => <div data-testid="tab-calendar" /> }));
vi.mock('../../components/adv/AdvWorkflowsTab', () => ({ default: ({ enterprise }: { enterprise?: boolean }) =>
  <div data-testid={enterprise ? 'tab-enterprise' : 'tab-workflows'} /> }));
vi.mock('../../components/adv/HealthTab', () => ({ default: () => <div data-testid="tab-health" /> }));
vi.mock('../../components/adv/AdvHistoryTab', () => ({ default: () => <div data-testid="tab-history" /> }));
vi.mock('../../components/adv/AdvHarnessPanelPage', () => ({
  default: ({ panel }: { panel: string }) => <div data-testid="harness-panel" data-panel={panel} />,
}));
vi.mock('@/app/adv/harnesses/HarnessesWorkspace', () => ({ default: () => <div data-testid="tab-harnesses" /> }));
vi.mock('@/app/adv/hud/HudView', () => ({
  default: ({ potScope }: { potScope?: { harnessSlugs?: string[] } }) => (
    <div data-testid="tab-hud" data-scope={(potScope?.harnessSlugs ?? []).join(',')} />
  ),
}));
vi.mock('@/app/adv/create/AdvCreateDock', () => ({ default: () => <div data-testid="tab-create-dock" /> }));
vi.mock('@/app/admin/plans/plans.css', () => ({}));

import { Route } from './index';

const Comp = (Route as unknown as { component: () => JSX.Element }).component;
function renderAdv(searchParams = '') {
  advScopeBoundary.entered = false;
  return render(<NuqsTestingAdapter searchParams={searchParams}><Comp /></NuqsTestingAdapter>);
}
/** The pot bar marker, or null when this tab does not carry one. */
const potBar = () => screen.queryByTestId('pot-bar');

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/adv');
});

describe('/adv tab router', () => {
  it('keeps a dedicated Workflow Editor embed renderable without restoring its Papercusp tab', async () => {
    window.history.replaceState({}, '', '/adv?tab=workflows&portalEmbed=1');
    renderAdv('?tab=workflows&portalEmbed=1');
    expect(await screen.findByTestId('tab-workflows')).toBeTruthy();
  });

  it('routes a stale non-portal tab deep link to Overview inside the cloud Papercusp embed', async () => {
    window.history.replaceState({}, '', '/adv?tab=docs&portalEmbed=1');
    renderAdv('?tab=docs&portalEmbed=1');
    expect(await screen.findByTestId('tab-overview')).toBeTruthy();
  });

  const FIRST_CLASS = [
    { tab: 'overview', child: 'tab-overview', bar: true, pills: false },
    { tab: 'enterprise', child: 'tab-enterprise', bar: false, pills: false },
    // HUD is a first-class tab (owner ask 2026-07-25) — /adv/HUD redirects here.
    // It is also where the pot cluster + status pills moved (owner ask 2026-07-27).
    { tab: 'hud', child: 'tab-hud', bar: true, pills: true },
    { tab: 'workflows', child: 'tab-workflows', bar: false, pills: false },
    { tab: 'conversations', child: 'tab-conversations', bar: false, pills: false },
    { tab: 'learning', child: 'tab-learning', bar: true, pills: false },
    // Label renamed Working → Work (owner ask 2026-07-26); id stays 'harnesses'.
    { tab: 'harnesses', child: 'tab-harnesses', bar: true, pills: false },
    { tab: 'health', child: 'tab-health', bar: false, pills: false },
    { tab: 'frames', child: 'tab-frames', bar: false, pills: false },
    { tab: 'evals', child: 'tab-evals', bar: false, pills: false },
    { tab: 'calendar', child: 'tab-calendar', bar: false, pills: false },
    { tab: 'plans', child: 'tab-create-dock', bar: true, pills: false },
    { tab: 'stats', child: 'tab-stats', bar: true, pills: false },
    { tab: 'history', child: 'tab-history', bar: true, pills: false },
  ] as const;

  it('keeps the canonical Enterprise entry route in an embedded desktop', async () => {
    window.history.replaceState({}, '', '/adv?tab=enterprise&portalEmbed=1');
    renderAdv('?tab=enterprise&portalEmbed=1');
    expect(await screen.findByTestId('tab-enterprise')).toBeTruthy();
  });

  it.each(FIRST_CLASS)('renders the $tab surface (pot bar: $bar, pills: $pills)', async ({ tab, child, bar, pills }) => {
    renderAdv(`?tab=${tab}`);
    expect(await screen.findByTestId(child)).toBeTruthy();
    if (!bar) {
      expect(potBar(), `${tab} aggregates the workspace — no pot picker`).toBeNull();
      return;
    }
    expect(potBar(), `${tab} is pot-scoped — it needs its own pot picker`).toBeTruthy();
    expect(potBar()!.getAttribute('data-with-status')).toBe(pills ? '1' : '0');
  });

  const PANELS = ['brainstorm', 'prs', 'insights', 'git', 'testing'] as const;

  it.each(PANELS)('routes the %s tab to the harness panel page, with a pot bar (it is a per-pot panel)', async (tab) => {
    renderAdv(`?tab=${tab}`);
    expect((await screen.findByTestId('harness-panel')).getAttribute('data-panel')).toBe(tab);
    expect(potBar()).toBeTruthy();
    expect(potBar()!.getAttribute('data-with-status')).toBe('0');
  });

  it('defaults to the overview surface when ?tab is absent', async () => {
    renderAdv('');
    expect(await screen.findByTestId('tab-overview')).toBeTruthy();
  });

  it('bridges the shell pot scope structurally into HUD', async () => {
    renderAdv('?tab=hud');
    expect((await screen.findByTestId('tab-hud')).getAttribute('data-scope')).toBe('pot-a,pot-a-child');
  });

  it('falls back to overview for an unknown ?tab value (enum guard)', async () => {
    renderAdv('?tab=bogus');
    expect(await screen.findByTestId('tab-overview')).toBeTruthy();
  });

  it('keeps the pot bar OUTSIDE the tab error boundary, so a crashed tab is still escapable', () => {
    const { container } = renderAdv('?tab=hud');
    const bar = potBar()!;
    const body = container.querySelector('.pc-advshell__tabbody')!;
    expect(body).toBeTruthy();
    expect(body.contains(bar), 'the bar must not be inside the boundary-wrapped body').toBe(false);
    // …and it comes first, so it reads as the tab's top row.
    expect(bar.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
