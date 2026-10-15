// @vitest-environment jsdom
//
// AdvShell render coverage — the /adv shell: the Radix tab strip (now the
// TOPMOST chrome) + the two URL-mounted modals + the persisted-selection
// restore. Mounts against a mocked harnessProjects.lite sync query
// (data-sync-push P-010 — the live registry list replaced the old one-shot
// /api/harness/projects/lite fetch; nuqs mocked with STABLE per-key setter
// spies — the restore effect keyed on the project count would re-fire forever
// with per-render vi.fn() identities; otherwise the pinned sibling pattern, see
// AdvNowRunning.test.tsx). Children with their own suites (CreateHarnessPicker,
// PublishPotCard) are stubbed; the pure exports (buildHarnessSelectOptions,
// visibleAdvTabs, ADV_TABS shape, the D-001 primary/secondary split, recent-tabs
// helpers) are pinned in __tests__/adv-shell-logic.test.ts.
//
// ⚠ The POT CLUSTER IS NOT HERE ANY MORE (owner ask 2026-07-27: the title bar
// that held it was removed so the tabs sit at the very top). The selector, the
// sub-pots toggle, New/Share and the status pills moved to AdvPotBar, which
// renders inside the pot-scoped tab bodies — their coverage moved with them to
// AdvPotBar.test.tsx. What stays here is what the SHELL still owns: the strip,
// the restore effect, and the ?create=/?share= modals the bar only opens.
//
// Asserts:
//   - D-001 (owner decision 2026-07-26, option C): ONLY the PRIMARY_ADV_TAB_IDS
//     set renders as real strip tabs, in every scope (single-pot AND All Pots)
//     — Overview + HUD, plus Work (id 'harnesses') and Learning, promoted out
//     of the More menu by later owner asks the same day; every other tab —
//     including an all-mode-pinned per-pot tab — is reachable only via the
//     "More" menu, whose trigger reflects an active secondary tab,
//   - no title/kicker bar renders above the strip (owner ask 2026-07-27),
//   - the More menu itself: grouped headings, type-to-filter search, selecting
//     an item writes ?tab= and closes the menu, and the last-visited secondary
//     tabs pin under "Recent" (most-recent first, capped at 3),
//   - the persisted-selection restore precedence (URL slug > persisted >
//     All), written SEQUENTIALLY (slug then scope),
//   - the two URL-mounted modals: the hive-publish share card (?share=) and the
//     create picker (?create=, incl. the into-hive hiveScope gating + onCreated),
//   - the Discord-parity shortcuts (tab cycling, harness cycling, goto.inbox,
//     harness.create).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

// nuqs: stable [value, setter] per key. State is plain module data the tests
// seed before render; setters are spies that DON'T write back (assert-only).
// Parsers come from the shared complete mock (EI-8821) — a bare local `{}`
// stub here previously broke the moment a new parseAsX call was wired into
// an always-rendered path elsewhere in the component.
const nuqsState: Record<string, unknown> = {
  tab: 'overview',
  slug: null,
  scope: 'expanded',
  create: false,
  share: false,
  // Tab fullscreen level (owner ask 2026-08-31): off | window | screen.
  max: 'off',
};
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
const routeState = { pathname: '/adv', search: '' };
const routePush = vi.fn();
let reportsLibraryOn = true;
vi.mock('@papercusp/flags/client', () => ({
  useFlag: (key: string) => key === 'papercusp-reports-library' ? reportsLibraryOn : true,
}));
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
}));
vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: routePush }),
  usePathname: () => routeState.pathname,
  useSearchParams: () => new URLSearchParams(routeState.search),
}));

// Live harnessProjects.lite registry list (P-010). The tests seed `projectRows`
// (the resolver's projects[] row shape) and optionally `projectsError`; the
// component reads `data`, `error`, `invalidate` off the result. `invalidate` is
// a spy so the create/share refetch paths stay assertable.
let projectRows: unknown[] | undefined = [];
let projectsError: Error | null = null;
const invalidateSpy = vi.fn();
vi.mock('@papercusp/sync', async () => ({
  onSyncBusEvent: () => () => {},
  // WI-6948: TasksRunningPill loads its panel via lazyWithRetry, which THIS package
  // re-exports (operator-core/lib/lazy-with-retry is a pure re-export). A factory that
  // omits it makes the re-export `undefined` and the whole suite dies with
  // "lazyWithRetry is not a function". Dynamic import keeps the factory free of
  // top-level captures — vi.mock is hoisted, which is what the other failure mode
  // ("no top level variables inside") is complaining about.
  lazyWithRetry: (await import('react')).lazy,
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    if (queryName === 'harnessProjects.lite') {
      return { data: projectsError ? undefined : projectRows, error: projectsError, invalidate: invalidateSpy };
    }
    return { data: undefined, error: null, invalidate: vi.fn() };
  },
}));

vi.mock('@/app/harness/CreateHarnessPicker', () => ({
  CreateHarnessPicker: ({
    open,
    onCreated,
    hiveScope,
  }: {
    open: boolean;
    onCreated: (slug: string) => void;
    hiveScope?: string | null;
  }) =>
    open ? (
      <div data-testid="create-picker" data-hive-scope={hiveScope ?? ''}>
        <button type="button" onClick={() => onCreated('fresh-pot')}>
          simulate-created
        </button>
      </div>
    ) : null,
}));
vi.mock('@/app/harness/PublishPotCard', () => ({
  PublishPotCard: ({ potSlug }: { potSlug: string }) => (
    <div data-testid="publish-pot-card" data-slug={potSlug} />
  ),
}));
// The share modal wrapper — passthrough so the card renders without Radix.
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div data-testid="share-modal">
        <button type="button" onClick={() => onOpenChange(false)}>
          close-share
        </button>
        {children}
      </div>
    ) : null,
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    let s = key === 'pot' ? 'Pot' : key;
    if (opts?.plural) s += 's';
    if (opts?.lower) s = s.toLowerCase();
    return s;
  },
}));

// The two workspace-wide status pills the strip carries since 2026-08-01. Each
// has its own suite (and its own sync queries + popovers); stub them so this one
// stays about WHERE the strip puts them.
// NOTE: no './PotsRunningPill' mock — the component was DELETED (P-075,
// [owner 2026-08-10] "remove the ... 'pots running' button"). Deliberately not
// re-stubbed: a regression that re-adds the import fails at resolution, which is
// a louder guard than any assertion here.
vi.mock('./AgentsRunningPill', () => ({ default: () => <div data-testid="agents-pill" /> }));

// Shortcut bus: capture each registered action so tests can trigger it.
const shortcutHandlers = new Map<string, () => void>();
vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: (id: string, run: () => void) => {
    shortcutHandlers.set(id, run);
  },
}));

// cmdk (the "More" menu, D-001) scrolls the active item into view and touches
// ResizeObserver, neither of which jsdom implements — same shim as
// CommandPalette.test.tsx.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

import AdvShell, { buildHarnessSelectOptions, resolveAdvScopeHarnessSlugs } from './AdvShell';

const LS_KEY = () => wsLocalKey('harness.activeProject');

const PROJECTS = [
  // pot-a is a hive home: the header Share affordance is hive-publish-only
  // (per-harness sharing retired — comb-retire-per-harness-sharing-2026-06-11).
  { slug: 'pot-a', harness_kind: 'hive', is_shared: false },
  { slug: 'pot-b', is_shared: true },
  { slug: 'pot-a-child', parent_slug: 'pot-a' },
];

beforeAll(() => {
  // The vitest node localStorage shim can be broken — install a real
  // in-memory Storage (the AutoLoginWelcomeToast.component pattern).
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
});

/** Seed the live harnessProjects.lite result (rows or an error). */
function stubProjects(rows: unknown[] = PROJECTS, opts: { fail?: boolean } = {}) {
  if (opts.fail) {
    projectRows = undefined;
    projectsError = new Error('HTTP 500');
  } else {
    projectRows = rows;
    projectsError = null;
  }
}

/** Render the shell and wait for the strip to mount (so effects have flushed).
 *  The anchor used to be a selector <option> — the selector lives in AdvPotBar
 *  now, so the strip itself is the shell's own first paint. */
async function renderShell({ expectTabs = true }: { expectTabs?: boolean } = {}) {
  const utils = render(
    <AdvShell>
      <div data-testid="tab-body" />
    </AdvShell>,
  );
  if (expectTabs) {
    await waitFor(() => expect(screen.getByRole('tab', { name: 'overview' })).toBeTruthy());
  }
  return utils;
}

// ── Fullscreen API (jsdom implements none of it) ────────────────────────────
// A settable `document.fullscreenElement` plus spies for request/exit, so the
// tests can assert WHEN the OS API is reached for — the distinction between the
// two levels is precisely "did this one touch the real fullscreen API".
let fullscreenElement: Element | null = null;
const requestFullscreenSpy = vi.fn(async () => {
  fullscreenElement = document.documentElement;
});
const exitFullscreenSpy = vi.fn(async () => {
  fullscreenElement = null;
});
beforeAll(() => {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  document.documentElement.requestFullscreen =
    requestFullscreenSpy as unknown as HTMLElement['requestFullscreen'];
  document.exitFullscreen = exitFullscreenSpy as unknown as Document['exitFullscreen'];
});

beforeEach(() => {
  nuqsState.tab = 'overview';
  nuqsState.slug = 'pot-a';
  nuqsState.scope = 'expanded';
  nuqsState.create = false;
  nuqsState.share = false;
  nuqsState.max = 'off';
  routeState.pathname = '/adv';
  routeState.search = '';
  routePush.mockClear();
  reportsLibraryOn = true;
  // AdvShell reads the router compatibility hooks; the default test location
  // is the ordinary non-embedded operator route.
  fullscreenElement = null;
  requestFullscreenSpy.mockClear();
  exitFullscreenSpy.mockClear();
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  shortcutHandlers.clear();
  localStorage.clear();
  invalidateSpy.mockClear();
  stubProjects();
});

afterEach(() => {
  cleanup();
});

describe('AdvShell — strip + header', () => {
  it('renders no tab strip at all in a portal-embedded frame — every tab is a portal rail entry (owner ask 2026-09-01)', async () => {
    routeState.search = '?portalEmbed=1&portalTheme=light';
    await renderShell({ expectTabs: false });
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: 'More sections' })).toBeNull();
    expect(document.querySelector('.pc-advshell__header')).toBeNull();
  });

  it('keeps a dedicated extracted-tab embed body without restoring any Papercusp tab chrome', async () => {
    routeState.search = '?portalEmbed=1&portalTheme=light&tab=workflows';
    nuqsState.tab = 'workflows';
    await renderShell({ expectTabs: false });
    expect(nuqsSetters.tab).not.toHaveBeenCalled();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(document.querySelector('.pc-advshell__header')).toBeNull();
  });

  it('preserves a secondary tab deep link in the cloud embed', async () => {
    routeState.search = '?portalEmbed=1&portalTheme=light&tab=docs';
    nuqsState.tab = 'docs';
    // Every ADV destination now mounts in the portal, including its More
    // sections. Rewriting Docs to Overview would discard the selected section.
    await renderShell({ expectTabs: false });
    expect(nuqsSetters.tab).not.toHaveBeenCalled();
  });

  it('renders ONLY the promoted tabs as real strip tabs (D-001 option C), with NO title bar above them', async () => {
    await renderShell();
    // Owner ask 2026-07-27: "remove the whole ADVANCED ORCHESTRATION / HUD bar so
    // the tabs sit at the very top". Both halves of that bar are gone — the copy
    // AND the pot cluster it carried (now AdvPotBar, inside the tab bodies).
    expect(screen.queryByText('Advanced orchestration')).toBeNull();
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.queryByLabelText('Select Pot')).toBeNull();
    expect(screen.queryByText('sub-pots')).toBeNull();
    // The strip is the header's first element — nothing renders above it.
    const header = document.querySelector('.pc-advshell__header')!;
    expect(header.firstElementChild?.className).toContain('pc-advshell__tabs');
    // D-001 (owner decision, 2026-07-26): only the PRIMARY_ADV_TAB_IDS set
    // renders as real Tabs.Trigger elements — Overview + HUD + Automations,
    // plus Work and Learning promoted out of the More menu.
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.queryByRole('tab', { name: 'overwatch' })).toBeNull();
    // Tab-strip overflow affordance (owner ask 2026-06-15 #1): the scroll
    // chevrons are wired into the strip (CSS reveals them only when clipped, so
    // query the DOM directly rather than the a11y tree).
    expect(document.querySelector('button.pc-advshell__tabnav--left')).toBeTruthy();
    expect(document.querySelector('button.pc-advshell__tabnav--right')).toBeTruthy();
    // labels render lowercased in the trigger span
    expect(screen.getByRole('tab', { name: 'hud' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'workflows' })).toBeTruthy();
    // 'harnesses' is the Work tab and sits right of HUD on the strip (owner ask
    // 2026-07-26); its old "working" label is gone.
    expect(screen.getByRole('tab', { name: 'work' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'working' })).toBeNull();
    // …while e.g. Docs stays behind the More menu.
    expect(screen.queryByRole('tab', { name: 'docs' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More sections' })).toBeTruthy();
  });

  it('carries the workspace status pills in the strip, immediately right of More (owner ask 2026-08-01)', async () => {
    await renderShell();
    const strip = document.querySelector('.pc-advshell__tabs')!;
    const status = strip.querySelector('.pc-advshell__header-status')!;
    expect(status).toBeTruthy();
    // Mounted by the SHELL — so they show on every tab, not just HUD (they read
    // advRoster.list, which is not filtered by ?slug=). The pot-running pill was
    // the third member of this strip until P-075 deleted it; its absence is
    // asserted so a restore has to come with a deliberate test change.
    expect(screen.getByTestId('agents-pill')).toBeTruthy();
    expect(screen.queryByTestId('hives-pill')).toBeNull();
    // …and positioned AFTER the More trigger, which is the owner's chosen spot.
    // DOCUMENT_POSITION_FOLLOWING asserts the order without pinning the Popover's
    // internal wrapper markup (which is Radix's to change, not ours).
    const more = screen.getByRole('button', { name: 'More sections' });
    expect(more.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the status pills on a non-HUD tab — the whole point of the move', async () => {
    // The regression this guards: they used to render from AdvPotBar's
    // `withStatus`, which only HUD passes, so every other tab lost them.
    nuqsState.tab = 'docs';
    await renderShell();
    expect(screen.getByTestId('agents-pill')).toBeTruthy();
  });

  it('keeps only the promoted tabs on the strip under All Pots too', async () => {
    nuqsState.scope = 'all';
    await renderShell();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    // Automations, Work, and Learning are workspace-level, so they survive
    // the All-Pots filter alongside Overview + HUD.
    expect(tabs).toEqual(['overview', 'hud', 'workflows', 'work', 'learning']);
  });

  it('keeps a per-pot tab pinned (no snap to Overview) under All scope — reachable via More, and the trigger reads active', async () => {
    nuqsState.scope = 'all';
    nuqsState.tab = 'docs';
    await renderShell();
    // No snap-back: the active per-pot tab is NOT rewritten to Overview…
    expect(nuqsSetters.tab).not.toHaveBeenCalledWith('overview');
    // …it's a secondary tab now, so it does NOT get its own strip Tabs.Trigger…
    expect(screen.queryByRole('tab', { name: 'docs' })).toBeNull();
    // …but the More trigger reflects the active secondary tab and the item is
    // reachable inside the menu (its body still shows the pick-a-hive prompt).
    const moreTrigger = screen.getByRole('button', { name: 'More sections' });
    expect(moreTrigger.className).toContain('pc-advshell__more-trigger--active');
    fireEvent.click(moreTrigger);
    // 'docs' is both the just-mounted active tab (so it's already "Recent") AND
    // a member of its permanent "Create & Build" group — both listings are expected
    // (standard recent-item UX), so assert presence via findAllByText.
    expect((await screen.findAllByText('Docs')).length).toBeGreaterThan(0);
  });

  it('selecting a tab from the More menu writes the tab to the URL and closes the menu', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    const gitItem = await screen.findByText('Git');
    fireEvent.click(gitItem);
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('git'));
    await waitFor(() => expect(screen.queryByText('Git')).toBeNull()); // popover closed
  });
});

describe('AdvShell — "More" menu (D-001 mitigations: grouped, searchable, recents)', () => {
  it.each(['expanded', 'all'])('opens the existing Reports library from More in %s scope', async (scope) => {
    nuqsState.scope = scope;
    await renderShell();
    expect(screen.queryByText('Reports')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    const reports = await screen.findByText('Reports');
    expect(reports.closest('[cmdk-group]')?.textContent).toContain('Insights');
    fireEvent.change(screen.getByLabelText('Filter sections'), { target: { value: 'reports' } });
    await waitFor(() => expect(screen.queryByText('Git')).toBeNull());
    fireEvent.click(reports);
    expect(routePush).toHaveBeenCalledWith('/reports');
    await waitFor(() => expect(screen.queryByText('Reports')).toBeNull());
    expect(nuqsSetters.tab).not.toHaveBeenCalledWith('reports');
  });

  it('hides Reports from More when the existing reports library flag is disabled', async () => {
    reportsLibraryOn = false;
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    await screen.findByText('Git');
    expect(screen.queryByText('Reports')).toBeNull();
  });

  it('groups the secondary tabs under labelled headings', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    await screen.findByText('Git'); // wait for the menu to mount
    const headings = Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent);
    // "Work" the group became "Activity" when the Work tab (harnesses) was
    // promoted to the strip — two things called "Work" in one nav is the thing
    // the relabel avoids (owner ask 2026-07-26).
    expect(headings).toEqual(['Create & Build', 'Activity', 'Insights', 'System']);
    const items = Array.from(document.querySelectorAll('[cmdk-item]')).map((el) => el.textContent?.trim());
    expect(items).toEqual(
      expect.arrayContaining(['Brainstorm', 'Create', 'Git', 'Stats', 'Tests', 'Docs', 'History', 'Conversations', 'Calendar', 'Insights', 'Evaluation', 'Health', 'Frames', 'Settings']),
    );
    // Promoted tabs are strip tabs, NOT More-menu items.
    expect(items).not.toContain('Work');
    expect(items).not.toContain('Working');
    expect(items).not.toContain('Learning');
    expect(items).not.toContain('Workflows');
  });

  it('is type-to-filter searchable: typing narrows to matching sections', async () => {
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    const input = await screen.findByLabelText('Filter sections');
    fireEvent.change(input, { target: { value: 'git' } });
    await waitFor(() => expect(screen.getByText('Git')).toBeTruthy());
    expect(screen.queryByText('Settings')).toBeNull();
  });

  it('pins the last visited secondary tabs under Recent, most-recent first, capped at 3', async () => {
    // Recents persist to localStorage (shared across mounts); simulate visiting
    // git, then docs, then testing across separate mount/unmount cycles — each
    // renderShell() picks up the prior localStorage state on mount, then its
    // own activeTab push runs.
    nuqsState.tab = 'git';
    await renderShell();
    cleanup();
    nuqsState.tab = 'docs';
    await renderShell();
    cleanup();
    nuqsState.tab = 'testing';
    await renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'More sections' }));
    const recentHeading = await screen.findByText('Recent');
    const recentGroup = recentHeading.closest('[cmdk-group]') as HTMLElement;
    const recentLabels = Array.from(recentGroup.querySelectorAll('[cmdk-item]')).map((el) => el.textContent);
    expect(recentLabels).toEqual(['Tests', 'Docs', 'Git']);
  });
});

describe('AdvShell — hive pick resets the member focus (?harness)', () => {
  // (The SELECTOR path of this same bugfix moved to AdvPotBar.test.tsx with the
  // selector; this is the keyboard path, which AdvShell still owns.)
  it('cycling the harness via the keyboard (harness.next) ALSO clears ?harness so the dock follows the newly-cycled hive (same stale-?harness bugfix, keyboard path)', async () => {
    nuqsState.slug = 'pot-a';
    nuqsState.harness = 'pot-a-child'; // a sticky within-hive member focus from a prior drill-in
    await renderShell();
    act(() => shortcutHandlers.get('harness.next')!());
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    // THE FIX (keyboard path, AdvShell cycleHarness): member focus reset to null
    // so the dock follows the cycled-to hive instead of the stale sub-hive.
    await waitFor(() => expect(nuqsSetters.harness).toHaveBeenCalledWith(null));
    nuqsState.harness = undefined; // don't leak into other tests
  });
});

describe('AdvShell — selection restore (resolveAdvHarnessSelection wiring)', () => {
  it('a valid URL slug wins — no restore writes', async () => {
    nuqsState.slug = 'pot-a';
    localStorage.setItem(LS_KEY(), 'pot-b');
    await renderShell();
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
    expect(nuqsSetters.scope).not.toHaveBeenCalled();
  });

  it('restores a persisted concrete pot (slug then scope=expanded, sequential)', async () => {
    nuqsState.slug = null;
    localStorage.setItem(LS_KEY(), 'pot-b');
    await renderShell();
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('expanded'));
  });

  it('preserves an explicit All Pots URL instead of restoring a persisted concrete pot', async () => {
    nuqsState.slug = null;
    nuqsState.scope = 'all';
    localStorage.setItem(LS_KEY(), 'pot-b');
    await renderShell();
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
    expect(nuqsSetters.scope).not.toHaveBeenCalled();
  });

  it('falls back to All harnesses when nothing usable is persisted', async () => {
    nuqsState.slug = null;
    await renderShell();
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('all'));
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
  });

});

describe('AdvShell — the URL-mounted modals (the pot bar only opens them)', () => {
  it('mounts the hive-publish share modal from URL state and closes it', async () => {
    nuqsState.share = true;
    await renderShell();
    const card = screen.getByTestId('publish-pot-card');
    expect(card.getAttribute('data-slug')).toBe('pot-a');
    fireEvent.click(screen.getByText('close-share'));
    await waitFor(() => expect(nuqsSetters.share).toHaveBeenCalledWith(false));
  });

  it('mounts the create picker from URL state; onCreated persists the new pot', async () => {
    nuqsState.create = true;
    await renderShell();
    fireEvent.click(screen.getByText('simulate-created'));
    // onCreated is side-effects only now (localStorage). The new pot's FOCUS
    // (?slug/?harness) is written by the picker ITSELF in the SAME atomic
    // useQueryStates write as the modal close — doing it here too would be a second
    // same-tick write the custom adapter clobbers (the stuck-modal bug). The
    // focus+close atomicity is covered by nuqs-two-write-race.router-integration.
    await waitFor(() => expect(localStorage.getItem(LS_KEY())).toBe('fresh-pot'));
  });
});

describe('AdvShell — Discord-parity shortcuts', () => {
  it('goto.nextTab / goto.prevTab cycle the visible strip with wrap-around', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('goto.nextTab')!());
    // next tab after overview is 'hud' — the session board took the first slot
    // right of Overview (owner ask 2026-07-25); 'plans' follows it.
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('hud'));
    act(() => shortcutHandlers.get('goto.prevTab')!());
    // from overview (idx 0) backwards wraps to the last tab
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('settings'));
  });

  it('harness.next cycles to the next project and persists the pick', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('harness.next')!());
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(localStorage.getItem(LS_KEY())).toBe('pot-b');
  });

  it.each(['harness.next', 'harness.prev'])(
    '%s leaves All Pots when its sole pot is already the retained selection',
    async (shortcut) => {
      stubProjects([PROJECTS[0]]);
      nuqsState.slug = 'pot-a';
      nuqsState.scope = 'all';
      nuqsState.harness = 'pot-a-child';
      await renderShell();
      act(() => shortcutHandlers.get(shortcut)!());
      await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('expanded'));
      await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-a'));
      await waitFor(() => expect(nuqsSetters.harness).toHaveBeenCalledWith(null));
      expect(localStorage.getItem(LS_KEY())).toBe('pot-a');
      nuqsState.harness = undefined;
    },
  );

  it('goto.inbox jumps to Conversations and harness.create opens the picker', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('goto.inbox')!());
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('conversations'));
    act(() => shortcutHandlers.get('harness.create')!());
    await waitFor(() => expect(nuqsSetters.create).toHaveBeenCalledWith(true));
  });

  // Both two-stroke shortcuts have in-place handlers while /adv is mounted.
  it('goto.brainstorm and goto.insights jump to their per-pot tabs', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('goto.brainstorm')!());
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('brainstorm'));
    act(() => shortcutHandlers.get('goto.insights')!());
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('insights'));
  });
});

describe('AdvShell — CreateHarnessPicker into-hive scope gating', () => {
  // Regression: `?slug=` outlives the entity, so a removed hive or a non-hive
  // active harness must NOT be handed to the picker as `hiveScope` — doing so
  // defaulted the picker to the into-hive "Add to <X>" fork, and submitting
  // posted `intoHive=<X>`, which the backend rejects as `hive_not_found`
  // ("The selected hive wasn't found"), blocking a plain new-hive create.
  it('passes the active slug as hiveScope only when it is a live kind:hive home', async () => {
    nuqsState.slug = 'pot-a'; // PROJECTS: harness_kind:'hive'
    nuqsState.create = true;
    await renderShell();
    expect(screen.getByTestId('create-picker').getAttribute('data-hive-scope')).toBe('pot-a');
  });

  it('does NOT pass a non-hive active harness as hiveScope (→ null, new-hive default)', async () => {
    nuqsState.slug = 'pot-b'; // PROJECTS: a real project but NOT a hive
    nuqsState.create = true;
    await renderShell();
    // Gated to '' (null) — the picker defaults to new-hive, so submitting cannot
    // post intoHive=pot-b and trip the backend hive_not_found.
    expect(screen.getByTestId('create-picker').getAttribute('data-hive-scope')).toBe('');
  });
});

describe('buildHarnessSelectOptions — hive-home folding (the repo-less `-hive` plumbing is never shown)', () => {
  const lite = (slug: string, extra: Record<string, unknown> = {}) =>
    ({ slug, path: '/p', hasState: false, hasSpec: false, ...extra }) as never;
  // Pull the member tree out of the workspace group entry.
  const treeOf = (entries: ReturnType<typeof buildHarnessSelectOptions>) =>
    (entries.find((e) => 'kind' in e && e.kind === 'group') as { options: { value: string; label: string }[] } | undefined)
      ?.options ?? [];

  it('collapses a single-repo hive: `<x>-hive` home + member `<x>` → ONE "x" row (no -hive, no redundant member)', () => {
    const tree = treeOf(
      buildHarnessSelectOptions([lite('shop-hive', { harness_kind: 'hive' }), lite('shop', { hive_slug: 'shop-hive' })], null, 'Hives', 'WS'),
    );
    // label = the stripped hive name; value = the home slug so ?slug= scopes to the hive.
    expect(tree).toEqual([{ value: 'shop-hive', label: 'shop' }]);
  });

  it('multi-repo hive: friendly header (`-hive` stripped) + member rows; the raw `-hive` slug never appears', () => {
    const tree = treeOf(
      buildHarnessSelectOptions(
        [lite('team-hive', { harness_kind: 'hive' }), lite('backend', { hive_slug: 'team-hive' }), lite('frontend', { hive_slug: 'team-hive' })],
        null, 'Hives', 'WS',
      ),
    );
    expect(tree[0]).toEqual({ value: 'team-hive', label: 'team' });
    expect(tree.map((o) => o.label)).toEqual(expect.arrayContaining(['  ↳ backend', '  ↳ frontend']));
    expect(tree.some((o) => o.label === 'team-hive')).toBe(false);
  });

  it('a legacy/standalone non-hive root keeps its slug as-is', () => {
    const tree = treeOf(buildHarnessSelectOptions([lite('solo', { is_shared: true })], null, 'Hives', 'WS'));
    expect(tree).toEqual([{ value: 'solo', label: 'solo' }]);
  });

  it('shows a repo-less operations hive that is not suffix plumbing, e.g. oddsmith-ops', () => {
    const tree = treeOf(buildHarnessSelectOptions([lite('oddsmith-ops', { harness_kind: 'hive' })], null, 'Hives', 'WS'));
    expect(tree).toEqual([{ value: 'oddsmith-ops', label: 'oddsmith-ops' }]);
  });

  it('folds a `-hive` home by SUFFIX even when harness_kind is absent (projects-lite robustness)', () => {
    // projects-lite doesn't always carry harness_kind; the `-hive` suffix alone
    // must still fold the home (members never end in -hive). Guards the case
    // where the kind-only gate would leave a raw `<x>-hive` row in the picker.
    const tree = treeOf(
      buildHarnessSelectOptions([lite('shop-hive'), lite('shop', { hive_slug: 'shop-hive' })], null, 'Hives', 'WS'),
    );
    expect(tree).toEqual([{ value: 'shop-hive', label: 'shop' }]);
    expect(tree.some((o) => o.label.includes('-hive'))).toBe(false);
  });
});

/**
 * Tab fullscreen — owner ask 2026-08-31 ("I should be able to full screen the
 * main section that shows up inside the tabs"), two-level shape chosen by the
 * owner: press once to maximize inside the app window, again for real OS
 * fullscreen, Escape walks back down one level at a time.
 *
 * What these pin, beyond the happy path, is every way the two levels can drift
 * apart — because the failure mode of a fullscreen toggle is a URL that CLAIMS a
 * level the document is not in, and from there the next press acts on a state
 * that never existed.
 */
describe('AdvShell — tab fullscreen', () => {
  const toggle = () => screen.getByTestId('adv-fullscreen-toggle');

  it('starts off: a maximize control in the strip, and no maximize on <body>', async () => {
    await renderShell();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('Maximize this tab');
    expect(document.body.hasAttribute('data-adv-max')).toBe(false);
  });

  it('first press maximizes in-app and does NOT reach for the OS fullscreen API', async () => {
    await renderShell();
    fireEvent.click(toggle());
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
    expect(requestFullscreenSpy).not.toHaveBeenCalled();
  });

  it('second press escalates the SAME control to real OS fullscreen', async () => {
    nuqsState.max = 'window';
    await renderShell();
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(requestFullscreenSpy).toHaveBeenCalled());
    expect(nuqsSetters.max).toHaveBeenCalledWith('screen');
  });

  it('third press leaves both levels at once', async () => {
    nuqsState.max = 'screen';
    fullscreenElement = document.documentElement;
    await renderShell();
    fireEvent.click(toggle());
    await waitFor(() => expect(exitFullscreenSpy).toHaveBeenCalled());
    expect(nuqsSetters.max).toHaveBeenCalledWith('off');
  });

  // Radix dialogs/popovers and the BlockNote menus portal to <body>, which is
  // OUTSIDE any smaller fullscreen element — fullscreening the SHELL would make
  // every one of them invisible while fullscreen. So the request must go to
  // documentElement, and this pins which element receives it.
  it('fullscreens the DOCUMENT, not the shell element', async () => {
    nuqsState.max = 'window';
    await renderShell();
    const shell = document.querySelector('.pc-advshell') as HTMLElement;
    const shellRequest = vi.fn();
    shell.requestFullscreen = shellRequest as unknown as HTMLElement['requestFullscreen'];
    fireEvent.click(toggle());
    await waitFor(() => expect(requestFullscreenSpy).toHaveBeenCalled());
    expect(shellRequest).not.toHaveBeenCalled();
  });

  it('publishes the level on <body> for the overlay CSS, and clears it on unmount', async () => {
    nuqsState.max = 'window';
    const { unmount } = await renderShell();
    expect(document.body.getAttribute('data-adv-max')).toBe('window');
    unmount();
    // Navigating off /adv must never leave the app wearing a maximize.
    expect(document.body.hasAttribute('data-adv-max')).toBe(false);
  });

  it('Escape steps down one level: screen → window', async () => {
    nuqsState.max = 'screen';
    fullscreenElement = document.documentElement;
    await renderShell();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
    expect(exitFullscreenSpy).toHaveBeenCalled();
  });

  it('Escape steps down one level: window → off', async () => {
    nuqsState.max = 'window';
    await renderShell();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('off'));
  });

  it('Escape is inert while nothing is maximized', async () => {
    await renderShell();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(nuqsSetters.max).not.toHaveBeenCalled();
  });

  it('Escape leaves the maximize alone while an open dialog owns the key', async () => {
    nuqsState.max = 'window';
    await renderShell();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.appendChild(dialog);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(nuqsSetters.max).not.toHaveBeenCalled();
    dialog.remove();
  });

  // REGRESSION GUARD. The first version of that guard matched any
  // [data-radix-popper-content-wrapper] — and a Radix TOOLTIP is one, so simply
  // HOVERING this button disabled the Escape that leaves the mode it turns on.
  // Tooltips never carry data-state="open", which is what the guard keys on now.
  it('Escape still works while only a tooltip popper is open', async () => {
    nuqsState.max = 'window';
    await renderShell();
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-radix-popper-content-wrapper', '');
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-state', 'delayed-open');
    wrapper.appendChild(tip);
    document.body.appendChild(wrapper);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('off'));
    wrapper.remove();
  });

  it('degrades a cold-loaded ?max=screen to the maximize — a page load has no gesture to enter fullscreen with', async () => {
    nuqsState.max = 'screen';
    fullscreenElement = null;
    await renderShell();
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
    expect(requestFullscreenSpy).not.toHaveBeenCalled();
  });

  it('falls back to the maximize when the OS refuses fullscreen, rather than claiming a level it never entered', async () => {
    nuqsState.max = 'window';
    requestFullscreenSpy.mockRejectedValueOnce(new Error('refused'));
    await renderShell();
    fireEvent.click(toggle());
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
    expect(nuqsSetters.max).not.toHaveBeenCalledWith('screen');
  });

  // Caught by the live Tauri run: OS fullscreen really does engage in WebKitGTK,
  // so leaving /adv while at 'screen' would otherwise strand the window fullscreen
  // with the tab strip — the only visible way back — no longer rendered.
  it('releases OS fullscreen on unmount, since ?max= leaves with the route', async () => {
    nuqsState.max = 'screen';
    fullscreenElement = document.documentElement;
    const { unmount } = await renderShell();
    unmount();
    expect(exitFullscreenSpy).toHaveBeenCalled();
  });

  it('leaves a fullscreen it did not enter alone (a user F11) on unmount', async () => {
    nuqsState.max = 'off';
    fullscreenElement = document.documentElement;
    const { unmount } = await renderShell();
    unmount();
    expect(exitFullscreenSpy).not.toHaveBeenCalled();
  });

  it('syncs back down when the user leaves OS fullscreen outside the app (Esc / F11 / the window manager)', async () => {
    nuqsState.max = 'screen';
    fullscreenElement = document.documentElement;
    await renderShell();
    fullscreenElement = null;
    fireEvent(document, new Event('fullscreenchange'));
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
  });

  it('the view.fullscreen shortcut escalates exactly like the button', async () => {
    await renderShell();
    act(() => shortcutHandlers.get('view.fullscreen')!());
    await waitFor(() => expect(nuqsSetters.max).toHaveBeenCalledWith('window'));
  });

  // The whole point of keeping the strip visible while maximized (owner's choice
  // over a chrome-free variant): tabs stay one click apart.
  it('keeps the tab strip usable while maximized', async () => {
    nuqsState.max = 'window';
    await renderShell();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    // mouseDown, not click: Radix Tabs activates a trigger on pointer-down, so a
    // bare fireEvent.click never reaches onValueChange.
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'learning' }));
    await waitFor(() => expect(nuqsSetters.tab).toHaveBeenCalledWith('learning'));
  });
});

describe('resolveAdvScopeHarnessSlugs', () => {
  const projects = [
    { slug: 'team-hive', harness_kind: 'hive' },
    { slug: 'api', hive_slug: 'team-hive' },
    { slug: 'web', parent_slug: 'api' },
    { slug: 'other' },
  ];

  it('maps All Pots to workspace-wide and self to the exact selected pot', () => {
    expect(resolveAdvScopeHarnessSlugs('all', 'team-hive', projects)).toBeNull();
    expect(resolveAdvScopeHarnessSlugs('self', 'team-hive', projects)).toEqual(['team-hive']);
  });

  it('expands through authoritative hive_slug and legacy parent_slug descendants', () => {
    expect(resolveAdvScopeHarnessSlugs('expanded', 'team-hive', projects)).toEqual([
      'team-hive',
      'api',
      'web',
    ]);
  });
});
