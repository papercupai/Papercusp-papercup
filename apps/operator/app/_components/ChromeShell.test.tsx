// @vitest-environment jsdom
/**
 * ChromeShell.test.tsx — render-tier coverage for the operator's global chrome
 * (header + nav). ChromeShell pulls a large dependency tree (lazy docks, motion,
 * voice, flag/theme hooks); we stub every heavy child + external hook and assert
 * ChromeShell's OWN logic:
 *   - chromeless path prefixes (/pi, /project-docs, /el-min) → render null
 *   - a normal route → the header + primary nav links render
 *   - onAdv branch: on /adv the OPS CTA is a non-link "current page" span
 *   - testingFlag gating: Plugins link + the RES and PUI header CTAs appear
 *     only when the TESTING flag is on
 *   - OPERATOR_CHAT_SIDEBAR gating: the revived OperatorChatSidebar renders
 *     iff ITS flag is on (independent of TESTING); OracleDock + Tutorial
 *     stay retired regardless of flags
 *   - narrow chrome responds to the header's observed content-box width, not
 *     an unreachable viewport breakpoint below Tauri's native minimum
 *   - the website-matched header quote types on the measured cadence and
 *     settles immediately when motion/effects are disabled
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const operatorRoot = existsSync(resolve(process.cwd(), 'app/globals.css'))
  ? process.cwd()
  : resolve(process.cwd(), 'apps/operator');
const GLOBAL_CSS = readFileSync(resolve(operatorRoot, 'app/globals.css'), 'utf8');

/* ── Hook mocks (controllable per-test) ────────────────────────────── */
let pathname = '/';
let search = '';
let testingFlag = false;
let operatorChatSidebarFlag = false;
let fancyEffectsEnabled = false;
let reducedMotion = false;
vi.mock('@/lib/router-compat/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/lib/flag-hooks', () => ({
  // The sidebar has its OWN flag (operator-chat-sidebar-revival-2026-07-13);
  // every other flag read (TESTING, RES_ALLOCATION) follows testingFlag, as
  // the pre-revival tests assumed.
  useFlag: (key: string) =>
    key === 'papercusp-operator-chat-sidebar' ? operatorChatSidebarFlag : testingFlag,
}));
vi.mock('@/lib/visual-effects', () => ({
  reconcileVisualEffectsMode: vi.fn(),
  useFancyEffectsEnabled: () => fancyEffectsEnabled,
}));
vi.mock('@/lib/theme', () => ({ reconcileActiveTheme: vi.fn() }));
vi.mock('@papercusp/operator-core/lib/shortcut-registry', () => ({
  reconcileShortcutOverrides: vi.fn(),
}));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/flags', () => ({
  FLAGS: {
    TESTING: 'papercusp-testing',
    OPERATOR_CHAT_SIDEBAR: 'papercusp-operator-chat-sidebar',
  },
}));
vi.mock('motion', () => ({ animate: vi.fn(() => ({ stop: vi.fn() })), stagger: vi.fn(() => 0) }));
vi.mock('motion/react', () => ({ useReducedMotion: () => reducedMotion }));
vi.mock('@papercusp/operator-core/lib/lazy-with-retry', () => ({
  // ChromeShell only renders lazy docks behind a deferred idle gate / Suspense;
  // a never-resolving lazy keeps them from mounting in the test (fallback=null).
  lazyWithRetry: () => () => null,
}));

/* ── Child component stubs (render nothing / a marker) ──────────────── */
vi.mock('./ChromeNavMarks', () => ({ BrainMark: () => null, ResMark: () => null }));
vi.mock('./voice/AriaLiveRegions', () => ({ AriaLiveRegions: () => null }));
vi.mock('./voice/VoiceLeaderBootstrap', () => ({ VoiceLeaderBootstrap: () => null }));
vi.mock('./HostCheckBanner', () => ({ HostCheckBanner: () => null }));
vi.mock('./WorkspaceSwitcher', () => ({ default: () => null }));
vi.mock('../cloud-workspaces/MachineSwitcher', () => ({ default: () => <span data-testid="machine-switcher" /> }));
vi.mock('./ThemeSelector', () => ({ default: () => null }));
vi.mock('./BrandSwitcher', () => ({ default: () => null }));
vi.mock('./UserPicker', () => ({ default: () => null }));
vi.mock('./AutoLoginWelcomeToast', () => ({ default: () => null }));
vi.mock('./UpdateChip', () => ({ default: () => null }));
vi.mock('./NotificationCenter', () => ({ NotificationCenter: () => null }));
vi.mock('./RecentActionsCenter', () => ({ RecentActionsCenter: () => null }));
// (TutorialButton + OracleDock stay retired 2026-07-09 →
// _retired/legacy-web-chats/ — design-simplification-2026-07-09 P-003.
// OperatorChatSidebar is REVIVED: operator-chat-sidebar-revival-2026-07-13.)
vi.mock('./OperatorChatSidebar', () => ({ OperatorChatSidebar: () => <div data-testid="op-chat" /> }));
vi.mock('./AnimatedPapercuspCup', () => ({ AnimatedPapercuspCup: () => null }));
vi.mock('./RouteLink', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('./PuiLauncherButton', () => ({ PuiLauncherButton: () => null }));
vi.mock('./ChatwootWidget', () => ({ ChatwootWidget: () => null }));

import ChromeShell from './ChromeShell';

beforeEach(() => {
  pathname = '/';
  search = '';
  testingFlag = false;
  operatorChatSidebarFlag = false;
  fancyEffectsEnabled = false;
  reducedMotion = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChromeShell', () => {
  it('renders null on a chromeless route (/pi)', () => {
    pathname = '/pi';
    const { container } = render(<ChromeShell />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null on a nested chromeless route (/project-docs/x)', () => {
    pathname = '/project-docs/some-doc';
    const { container } = render(<ChromeShell />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null for focused portal work routes', () => {
    pathname = '/plans';
    search = 'portalEmbed=1&portalTheme=light';
    const { container } = render(<ChromeShell />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the header + primary nav on a normal route', () => {
    pathname = '/';
    render(<ChromeShell />);
    expect(screen.getByText('OPS')).toBeTruthy();
    const workspacesLink = screen.getByRole('link', { name: 'Cloud Workspaces' });
    expect(workspacesLink.getAttribute('href')).toBe('/cloud-workspaces');
    expect(workspacesLink.textContent).toBe('Workspaces');
    expect(screen.getByRole('link', { name: 'Support' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'DEV' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'GitHub' })).toBeTruthy();
  });

  it('compacts from the header content box and restores when dock space returns', () => {
    let notifyWidth: ((width: number) => void) | null = null;
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const flushFrame = () => act(() => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); });
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyWidth = (width: number) =>
            callback(
              [
                {
                  target: document.querySelector('.pc-header'),
                  contentRect: { width },
                } as unknown as ResizeObserverEntry,
              ],
              this as unknown as ResizeObserver,
            );
        }
        observe = observe;
        disconnect = disconnect;
      },
    );

    const { container, unmount } = render(<ChromeShell />);
    const header = container.querySelector('.pc-header')!;
    expect(observe).toHaveBeenCalledWith(header);

    act(() => notifyWidth?.(640));
    // Resize delivery must not synchronously mutate the observed element.
    expect(header.classList.contains('pc-header--compact')).toBe(false);
    flushFrame();
    expect(header.classList.contains('pc-header--compact')).toBe(true);
    act(() => notifyWidth?.(900));
    flushFrame();
    expect(header.classList.contains('pc-header--compact')).toBe(false);

    act(() => notifyWidth?.(640));
    unmount();
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(header.classList.contains('pc-header--compact')).toBe(false);
  });

  it('gives the measured compact class one column: CTAs scroll, the utility nav wraps', () => {
    expect(GLOBAL_CSS).toMatch(
      /\.pc-header\.pc-header--compact\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(GLOBAL_CSS).toMatch(
      /\.pc-header--compact \.pc-header-center\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/s,
    );
    // WI-10006979: a scrolling utility nav hid Theme / workspace switcher /
    // account off-screen at 1280px with both rails docked. It must wrap.
    const rightRules = [...GLOBAL_CSS.matchAll(/\.pc-header--compact \.pc-header-right\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(rightRules.length).toBeGreaterThan(0);
    const last = rightRules[rightRules.length - 1];
    expect(last).toMatch(/flex-wrap:\s*wrap/);
    expect(last).not.toMatch(/overflow-x:\s*auto/);
  });

  it('types the header quote on the papercusp.com cadence, then settles', () => {
    vi.useFakeTimers();
    fancyEffectsEnabled = true;
    const quote = 'Nothing Is So Painful To The Human Mind As A Great And Sudden Change';
    const { container } = render(<ChromeShell />);
    const wrapper = container.querySelector('.pc-header-quote');
    const text = container.querySelector('.pc-header-quote-text');

    expect(text?.textContent).toBe('');
    expect(wrapper?.classList.contains('is-settled')).toBe(false);

    act(() => vi.advanceTimersByTime(949));
    expect(text?.textContent).toBe('');

    act(() => vi.advanceTimersByTime(1));
    expect(text?.textContent).toBe('N');

    act(() => vi.advanceTimersByTime((quote.length - 1) * 24));
    expect(text?.textContent).toBe(quote);
    expect(wrapper?.classList.contains('is-settled')).toBe(true);
    expect(wrapper?.classList.contains('is-static')).toBe(false);
  });

  it('renders the complete settled quote immediately when reduced motion is enabled', () => {
    fancyEffectsEnabled = true;
    reducedMotion = true;
    const { container } = render(<ChromeShell />);
    const wrapper = container.querySelector('.pc-header-quote');
    const text = container.querySelector('.pc-header-quote-text');

    expect(text?.textContent).toBe('Nothing Is So Painful To The Human Mind As A Great And Sudden Change');
    expect(wrapper?.classList.contains('is-settled')).toBe(true);
    expect(wrapper?.classList.contains('is-static')).toBe(true);
  });

  it('renders the OPS CTA as a navigable link when NOT on /adv', () => {
    pathname = '/';
    render(<ChromeShell />);
    expect(screen.getByRole('link', { name: 'Ops' })).toBeTruthy();
  });

  it('renders the OPS CTA as a non-link "current page" span when on /adv', () => {
    pathname = '/adv';
    render(<ChromeShell />);
    // On /adv the CTA is aria-current="page" and NOT a link.
    expect(screen.queryByRole('link', { name: 'Ops' })).toBeNull();
    expect(screen.getByLabelText(/Ops \(current page\)/i)).toBeTruthy();
  });

  it('keeps OPS navigable on /adv while a plan-dashboard takeover is open', () => {
    pathname = '/adv';
    search = 'pdash=papercusp%3A%3Amy-plan';
    render(<ChromeShell />);

    expect(screen.getByRole('link', { name: 'Ops' }).getAttribute('href')).toBe('/adv');
    expect(screen.queryByLabelText(/Ops \(current page\)/i)).toBeNull();
  });

  it('hides the testing-only surfaces when the TESTING flag is off', () => {
    pathname = '/';
    testingFlag = false;
    render(<ChromeShell />);
    expect(screen.queryByRole('link', { name: 'Plugins' })).toBeNull();
    // RES CTA (RouteLink aria-label="Resources") is now TESTING-gated too.
    expect(screen.queryByRole('link', { name: 'Resources' })).toBeNull();
  });

  it('shows the testing-only surfaces (Plugins link) when TESTING is on', () => {
    pathname = '/';
    testingFlag = true;
    render(<ChromeShell />);
    expect(screen.getByRole('link', { name: 'Plugins' })).toBeTruthy();
    // RES CTA appears (mock useFlag returns testingFlag for every flag, so the
    // RES_ALLOCATION gate is satisfied too); RES RouteLink aria-label="Resources".
    expect(screen.getByRole('link', { name: 'Resources' })).toBeTruthy();
  });

  it('renders the operator chat sidebar when OPERATOR_CHAT_SIDEBAR is on, even with TESTING off', () => {
    // operator-chat-sidebar-revival-2026-07-13: the sidebar is the app's
    // primary chat surface on its OWN default-ON flag — NOT a testing surface.
    pathname = '/';
    testingFlag = false;
    operatorChatSidebarFlag = true;
    render(<ChromeShell />);
    expect(screen.getByTestId('op-chat')).toBeTruthy();
  });

  it('hides the operator chat sidebar when OPERATOR_CHAT_SIDEBAR is off', () => {
    pathname = '/';
    testingFlag = true; // TESTING must NOT leak the sidebar back in
    operatorChatSidebarFlag = false;
    render(<ChromeShell />);
    expect(screen.queryByTestId('op-chat')).toBeNull();
  });

  it('switches the operations chat off for DAO Management and restores it on returning', () => {
    operatorChatSidebarFlag = true;
    pathname = '/adv';
    const { rerender } = render(<ChromeShell />);
    expect(screen.getByTestId('op-chat')).toBeTruthy();
    for (const path of ['/daos', '/dao']) {
      pathname = path;
      rerender(<ChromeShell />);
      expect(screen.queryByTestId('op-chat')).toBeNull();
      expect(screen.getByLabelText('DAO Management (current page)')).toBeTruthy();
    }
    pathname = '/adv';
    rerender(<ChromeShell />);
    expect(screen.getByTestId('op-chat')).toBeTruthy();
  });

  it('renders CONTENT ONLY when /adv is framed by the portal — no header, no Papercup chat dock, even with the chat flag ON', () => {
    // cloud-portal-extract-remaining-papercusp-panes-2026-09-01 P-002: the
    // portal hosts the Papercup chat (from /portal-panes/chat) and the
    // steering sidebar (from /portal-panes/steering) as its OWN outer
    // sidebars, so a portal-embedded /adv must not mount a second chat dock
    // beside them. The flag is ON here to prove it is the embed branch, not
    // the flag, that keeps the dock out.
    pathname = '/adv';
    search = 'portalEmbed=1&portalTheme=light';
    operatorChatSidebarFlag = true;
    const { container } = render(<ChromeShell />);

    expect(screen.queryByTestId('op-chat')).toBeNull();
    expect(container.querySelector('.pc-header')).toBeNull();
    expect(screen.queryByText('OPS')).toBeNull();
  });

  it('never renders the still-retired legacy chats (OracleDock / Tutorial), regardless of flags', () => {
    // Recurrence guard for design-simplification-2026-07-09 P-003: OracleDock
    // and TutorialButton stay in _retired/legacy-web-chats/ — only the
    // OperatorChatSidebar was revived.
    pathname = '/';
    testingFlag = true;
    operatorChatSidebarFlag = true;
    render(<ChromeShell />);
    expect(screen.queryByText('Tutorial')).toBeNull();
    expect(document.querySelector('[data-oracle-dock]')).toBeNull();
  });
});
