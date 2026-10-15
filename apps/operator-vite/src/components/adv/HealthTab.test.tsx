// @vitest-environment jsdom
//
// HealthTab render coverage (system-health-tab-2026-06-15 P-004/P-005,
// D-002/D-003) — the read-only system Health dashboard. Mounts the tab against
// `health.snapshot` (useSyncQuery mocked, the pinned-sibling pattern — see
// LearningInfraHealthChip.test.tsx) and pins the empty states (loading / error /
// flag-off), the populated overall bar (label + crit/warn counts + checkedAgo),
// per-card tone + metrics, and drill-down links in both hosts: /adv?tab=…
// writes the configured destination key/mapping; other hrefs navigate normally.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PANEL_ORDER, type HealthPanel, type PanelKey, type PanelStatus, type SystemHealth } from '@papercusp/operator-core/lib/system-health/types';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
import { configureOperatorUi } from '@papercusp/operator-ui/seam';
import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';

// ── @papercusp/sync: reassign a single result object per test (sibling pattern). ──
let syncResult: Record<string, unknown> = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => syncResult,
}));

// ── nuqs: useQueryState('tab', …) → [null, setTabSpy]; capture the spy via a hoisted ref.
// Parsers from the shared complete mock (EI-8821) so a new parseAsX call
// elsewhere can't silently red this suite. ──
const nuqs = vi.hoisted(() => ({ setTab: vi.fn(), setApp: vi.fn() }));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => [null, key === 'app' ? nuqs.setApp : nuqs.setTab],
}));

import HealthTab from './HealthTab';

const setResult = (data: unknown[] | undefined, extra: Record<string, unknown> = {}) => {
  syncResult = { data, loading: false, fetching: false, error: null, invalidate: vi.fn(), ...extra };
};

/** A single status card. */
function panel(key: PanelKey, status: PanelStatus, over: Partial<HealthPanel> = {}): HealthPanel {
  return { key, label: key, status, summary: `${key} summary`, metrics: [], data: null, ...over };
}

/** A full snapshot: every PANEL_ORDER key defaults to 'ok'; overrides win. */
function snapshot(overall: PanelStatus, overrides: Partial<Record<PanelKey, HealthPanel>> = {}, evaluatedAt = Date.now() - 5_000): SystemHealth {
  const panels = Object.fromEntries(PANEL_ORDER.map((k) => [k, overrides[k] ?? panel(k, 'ok')])) as Record<PanelKey, HealthPanel>;
  return { overall, panels, evaluatedAt } as SystemHealth;
}

afterEach(() => {
  cleanup();
  nuqs.setTab.mockClear();
  nuqs.setApp.mockClear();
  configureOperatorUi({ advNavigation: undefined });
});

describe('HealthTab — empty/placeholder states', () => {
  it('shows the loading placeholder while the snapshot is in flight', () => {
    syncResult = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    render(<HealthTab />);
    expect(screen.getByText('Loading system health…')).toBeTruthy();
    // No status bar yet.
    expect(screen.queryByText('All systems healthy')).toBeNull();
  });

  it('shows the error placeholder when the resolver errors', () => {
    setResult(undefined, { error: new Error('boom') });
    render(<HealthTab />);
    expect(screen.getByText(/Health unavailable — .*boom/)).toBeTruthy();
  });

  it('shows the disabled placeholder when the flag is off (no data, not loading, no error)', () => {
    setResult([]); // resolver returns [] → health = undefined
    render(<HealthTab />);
    expect(screen.getByText('System health is disabled.')).toBeTruthy();
  });
});

describe('HealthTab — populated overall bar', () => {
  it('renders the green "all green" bar when nothing is crit/warn', () => {
    setResult([snapshot('ok')]);
    const { container } = render(<HealthTab />);
    expect(screen.getByText('All systems healthy')).toBeTruthy();
    expect(screen.getByText('all green')).toBeTruthy();
    expect(screen.queryByText(/red$/)).toBeNull();
    expect(container.querySelector('.pc-health__bar')!.getAttribute('data-tone')).toBe('good');
  });

  it('counts crit panels as "N red" and tones the bar bad', () => {
    setResult([snapshot('crit', { queen: panel('queen', 'crit'), bees: panel('bees', 'crit') })]);
    const { container } = render(<HealthTab />);
    expect(screen.getByText('Action needed')).toBeTruthy();
    expect(screen.getByText('2 red')).toBeTruthy();
    expect(screen.queryByText('all green')).toBeNull();
    expect(container.querySelector('.pc-health__bar')!.getAttribute('data-tone')).toBe('bad');
  });

  it('counts warn panels as "N yellow" with the warn label/tone', () => {
    setResult([snapshot('warn', { tokens: panel('tokens', 'warn') })]);
    const { container } = render(<HealthTab />);
    expect(screen.getByText('Needs a look')).toBeTruthy();
    expect(screen.getByText('1 yellow')).toBeTruthy();
    expect(container.querySelector('.pc-health__bar')!.getAttribute('data-tone')).toBe('warn');
  });

  it('shows both red and yellow counts when crit and warn coexist', () => {
    setResult([snapshot('crit', { queen: panel('queen', 'crit'), tokens: panel('tokens', 'warn'), bees: panel('bees', 'warn') })]);
    render(<HealthTab />);
    expect(screen.getByText('1 red')).toBeTruthy();
    expect(screen.getByText('2 yellow')).toBeTruthy();
    expect(screen.queryByText('all green')).toBeNull();
  });

  it('renders the checkedAgo summary from evaluatedAt', () => {
    setResult([snapshot('ok', {}, Date.now() - 5_000)]);
    render(<HealthTab />);
    expect(screen.getByText(/checked \d+s ago/)).toBeTruthy();
  });
});

describe('HealthTab — stale-snapshot banner (P-013, WI-4464)', () => {
  it('renders NO banner for a fresh snapshot', () => {
    setResult([snapshot('ok', {}, Date.now() - 5_000)]);
    render(<HealthTab />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the loud STALE banner once the snapshot outlives STALE_AFTER_MS', () => {
    // 4 minutes old > the 3-minute threshold — stale on first render (the tab's
    // own clock initialises to Date.now() at mount; no timer advance needed).
    setResult([snapshot('ok', {}, Date.now() - 4 * 60_000)]);
    render(<HealthTab />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('SNAPSHOT STALE');
    expect(banner.textContent).toMatch(/last computed/);
  });

  it('mutes the overall bar tone and dims the grid when stale — even on a green snapshot', () => {
    setResult([snapshot('ok', {}, Date.now() - 10 * 60_000)]);
    const { container } = render(<HealthTab />);
    // The bar stops asserting "good" — a stale green is not a live green.
    expect(container.querySelector('.pc-health__bar')!.getAttribute('data-tone')).toBe('mute');
    expect(container.querySelector('.pc-health__dot--mute')).toBeTruthy();
    expect(container.querySelector('.pc-health__grid--stale')).toBeTruthy();
  });

  it('keeps the live tone on the bar when fresh (no mute, no dimmed grid)', () => {
    setResult([snapshot('ok', {}, Date.now() - 5_000)]);
    const { container } = render(<HealthTab />);
    expect(container.querySelector('.pc-health__bar')!.getAttribute('data-tone')).toBe('good');
    expect(container.querySelector('.pc-health__grid--stale')).toBeNull();
  });
});

describe('HealthTab — cards', () => {
  it('renders a card per panel with its label, summary, and tone accent', () => {
    setResult([snapshot('crit', { queen: panel('queen', 'crit', { summary: 'STALLED 47m — no wake armed' }) })]);
    const { container } = render(<HealthTab />);
    // One card per PANEL_ORDER key.
    expect(container.querySelectorAll('.pc-hcard')).toHaveLength(PANEL_ORDER.length);
    expect(screen.getByText('STALLED 47m — no wake armed')).toBeTruthy();
    // The crit queen card carries the bad accent; an ok card carries good.
    const queenCard = [...container.querySelectorAll('.pc-hcard')].find((c) => c.textContent?.includes('STALLED'))!;
    expect(queenCard.className).toContain('pc-hcard--bad');
    const okCard = [...container.querySelectorAll('.pc-hcard')].find((c) => c.textContent?.includes('bees summary'))!;
    expect(okCard.className).toContain('pc-hcard--good');
  });

  it("renders a panel's metrics as value + label", () => {
    setResult([
      snapshot('ok', {
        bees: panel('bees', 'ok', { metrics: [{ label: 'in-flight', value: 3 }, { label: 'failures', value: '0', tone: 'crit' }] }),
      }),
    ]);
    const { container } = render(<HealthTab />);
    const beesCard = [...container.querySelectorAll('.pc-hcard')].find((c) => c.textContent?.includes('bees summary'))!;
    expect(beesCard.textContent).toContain('in-flight');
    expect(beesCard.textContent).toContain('failures');
    // The tone-tagged metric carries data-tone=bad.
    const toned = beesCard.querySelector('.pc-hcard__m[data-tone="bad"]')!;
    expect(toned.textContent).toContain('failures');
  });
});

describe('HealthTab — drill-down links', () => {
  it.each([['harnesses', 'work'], ['plans', 'create'], ['calendar', 'scheduled']])(
    'Portal drill-down to %s selects the mapped %s app', (tab, app) => {
      configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
      setResult([snapshot('ok', { queen: panel('queen', 'ok', { link: { label: 'Detail', href: `/adv?tab=${tab}` } }) })]);
      render(<HealthTab />);
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      screen.getByLabelText('Open Detail').dispatchEvent(ev);
      expect(nuqs.setApp).toHaveBeenCalledWith(app);
      expect(nuqs.setTab).not.toHaveBeenCalled();
      expect(ev.defaultPrevented).toBe(true);
    },
  );

  it('intercepts an /adv?tab=… link: preventDefault + nuqs setTab(tab)', () => {
    setResult([snapshot('ok', { queen: panel('queen', 'ok', { link: { label: 'Queen detail', href: '/adv?tab=overview' } }) })]);
    render(<HealthTab />);
    const link = screen.getByLabelText('Open Queen detail') as HTMLAnchorElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    expect(nuqs.setTab).toHaveBeenCalledWith('overview');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('lets a non-/adv link navigate normally (no preventDefault, no setTab)', () => {
    setResult([snapshot('ok', { deploy: panel('deploy', 'ok', { link: { label: 'Git pipeline', href: '/admin/git' } }) })]);
    render(<HealthTab />);
    const link = screen.getByLabelText('Open Git pipeline') as HTMLAnchorElement;
    // A document-level capture listener neutralises the anchor's default BEFORE
    // jsdom would attempt the (unimplemented) navigation, but it records the
    // component's decision first: React's onClick has already run by the bubble
    // phase, so if the component had wanted to intercept, defaultPrevented would
    // be true at the moment dispatchEvent returns. We assert on that.
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(ev);
    // The component handler (bubble phase) did not prevent default for a non-/adv
    // href, and never wrote the tab param.
    expect(nuqs.setTab).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('omits the link element when a panel has no link', () => {
    setResult([snapshot('ok', { plans: panel('plans', 'ok') })]);
    render(<HealthTab />);
    // No card exposes a drill-down anchor when none carry a link.
    expect(screen.queryByRole('link')).toBeNull();
  });
});
