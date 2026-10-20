// @vitest-environment jsdom
//
// AdvPotBar render coverage — the POT cluster (pot label · selector · sub-pots
// toggle · New · Share/Shared) and the HUD-only status strip.
//
// This suite is the pot cluster's coverage MOVED, not new coverage invented: it
// used to live in AdvShell.test.tsx, because the cluster used to live in
// AdvShell's header bar. Owner ask 2026-07-27 removed that bar so the tab strip
// sits at the very top, and the cluster now renders as the first row inside the
// pot-scoped tab bodies — so its tests moved with it, unchanged in substance.
//
// Mocked the same way the shell suite mocks: harnessProjects.lite via
// @papercusp/sync, nuqs with STABLE per-key setter spies (assert-only, they do
// NOT write back), Radix Select swapped for a native <select> with the same
// contract so options + onChange routing stay assertable, and the four status
// children (each with its own suite) stubbed. Checkbox/Tooltip stay REAL — the
// sub-pots toggle is asserted through its a11y role.
//
// Asserts:
//   - which tabs get the bar, and that ONLY hud gets the status pills
//     (potBarModeForTab / POT_BAR_TAB_IDS — the ask's "pot selector inside all
//     the tabs that are pot scoped", with the pills moved into HUD),
//   - selector changes: a concrete pick writes + persists the slug and clears
//     ?harness; from all-mode it exits all FIRST (sequential scope→slug); the
//     All row flips ?scope=all and persists the sentinel instead,
//   - the sub-pots toggle flips scope expanded ↔ self,
//   - Share = hive publish (hive pots only — per-harness sharing retired,
//     comb-retire-per-harness-sharing-2026-06-11), the legacy Shared badge, and
//     the directory-shared Share→Shared swap,
//   - New opens the create picker (?create=true — AdvShell mounts the modal),
//   - a projects/lite failure surfaces in the selector placeholder.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';

const nuqsState: Record<string, unknown> = {
  slug: null,
  scope: 'expanded',
  harness: null,
  create: false,
  share: false,
};
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key], nuqsSetters[key]];
  },
}));

let projectRows: unknown[] | undefined = [];
let projectsError: Error | null = null;
vi.mock('@papercusp/sync', async () => ({
  onSyncBusEvent: () => () => {},
  ORIGIN_SCHEDULER_CLASSES: ['interactive-control', 'foreground-read', 'background-sync', 'bulk'],
  // WI-6948: see AdvShell.test.tsx — TasksRunningPill's lazyWithRetry is re-exported
  // from this package, so a factory omitting it breaks the suite at import time.
  lazyWithRetry: (await import('react')).lazy,
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    if (queryName === 'harnessProjects.lite') {
      return { data: projectsError ? undefined : projectRows, error: projectsError, invalidate: vi.fn() };
    }
    return { data: undefined, error: null, invalidate: vi.fn() };
  },
}));

// Radix Select portals are noise here — render a native select with the same
// contract so options + onChange routing stay assertable.
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (v: string) => void;
    // SelectEntry[] — flat options OR { kind:'group', label, options } groups.
    options: Array<
      | { value: string; label: string; disabled?: boolean }
      | { kind: 'group'; label: string; options: Array<{ value: string; label: string; disabled?: boolean }> }
    >;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o, i) =>
        'kind' in o ? (
          <optgroup key={`g-${i}`} label={o.label}>
            {o.options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </optgroup>
        ) : (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ),
      )}
    </select>
  ),
}));

// The active hive's directory share-meta (GET /api/discovery/pot-meta) drives the
// Share-button → Shared-badge swap (comb-hive-native-sharing). Seed
// `hiveShareMeta` per test; default null = never published (unshared → the Share
// button shows). `public`/`invite` = shared → the Shared badge shows.
let hiveShareMeta: { found: boolean; visibility: 'public' | 'invite' | 'private' | null } | null = null;
vi.mock('@/app/harness/SharePotDialog', () => ({
  defaultFetchShareMeta: vi.fn(async () => hiveShareMeta),
}));

// The status children each have their own suite; stub them so this one is about
// the cluster, and so "did the widget render at all" is assertable.
vi.mock('./AdvNowRunning', () => ({
  default: ({ slug }: { slug: string | null }) => (
    <div data-testid="now-running" data-slug={slug ?? ''} />
  ),
}));
// The two workspace-wide pills moved to AdvShell's tab strip 2026-08-01, so this
// row must NOT import them any more. The stubs stay deliberately: they are what
// makes the negative assertion below real — re-adding either import here would
// render a stub and red the test, rather than silently restoring the duplicate.
// No './PotsRunningPill' mock — the component was DELETED by P-075
// ([owner 2026-08-10] "remove the ... 'pots running' button").
vi.mock('./AgentsRunningPill', () => ({ default: () => <div data-testid="agents-pill" /> }));
vi.mock('./CommunityBadge', () => ({
  default: ({ slug }: { slug: string | null }) => (
    <div data-testid="community-badge" data-slug={slug ?? ''} />
  ),
}));
vi.mock('@/lib/useWorkspaceLabel', () => ({ useWorkspaceLabel: () => 'papercusp-ws' }));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string, opts?: { plural?: boolean; lower?: boolean }) => {
    let s = key === 'pot' ? 'Pot' : key;
    if (opts?.plural) s += 's';
    if (opts?.lower) s = s.toLowerCase();
    return s;
  },
}));

import AdvPotBar from './AdvPotBar';
import { POT_BAR_TAB_IDS, potBarModeForTab } from './adv-pot-bar-tabs';

const LS_KEY = () => wsLocalKey('harness.activeProject');

const PROJECTS = [
  // pot-a is a hive home: Share is hive-publish-only (per-harness sharing
  // retired — comb-retire-per-harness-sharing-2026-06-11).
  { slug: 'pot-a', harness_kind: 'hive', is_shared: false },
  { slug: 'pot-b', is_shared: true },
  { slug: 'pot-a-child', parent_slug: 'pot-a' },
];

beforeAll(() => {
  // The vitest node localStorage shim can be broken — install a real in-memory
  // Storage (the AutoLoginWelcomeToast.component pattern).
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

async function renderBar(props: { withStatus?: boolean } = {}) {
  const utils = render(<AdvPotBar {...props} />);
  await waitFor(() => expect(screen.getByRole('option', { name: 'pot-a' })).toBeTruthy());
  return utils;
}

beforeEach(() => {
  nuqsState.slug = 'pot-a';
  nuqsState.scope = 'expanded';
  nuqsState.harness = null;
  nuqsState.create = false;
  nuqsState.share = false;
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  localStorage.clear();
  hiveShareMeta = null;
  stubProjects();
});

afterEach(() => {
  cleanup();
});

describe('AdvPotBar — which tabs get it (owner ask 2026-07-27 #2/#3)', () => {
  it('shows the bar on the pot-scoped tabs and NOT on the workspace-wide ones', () => {
    // The pot-scoped set: every tab whose content is filtered by ?slug=.
    for (const id of ['hud', 'overview', 'brainstorm', 'plans', 'harnesses', 'learning', 'git', 'stats', 'docs', 'testing', 'insights', 'settings', 'prs'] as const) {
      expect(potBarModeForTab(id).show, `${id} should carry the pot bar`).toBe(true);
    }
    // The workspace aggregates: a pot picker there would change nothing on
    // screen, which is the confusion this change removed.
    for (const id of ['calendar', 'health', 'frames', 'evals', 'conversations'] as const) {
      expect(potBarModeForTab(id).show, `${id} aggregates the workspace`).toBe(false);
      expect(POT_BAR_TAB_IDS.has(id)).toBe(false);
    }
  });

  it('gives the pot status widgets to HUD ONLY — that is where the owner moved them', () => {
    expect(potBarModeForTab('hud').withStatus).toBe(true);
    for (const id of ['overview', 'brainstorm', 'plans', 'harnesses', 'learning', 'git', 'stats'] as const) {
      expect(potBarModeForTab(id).withStatus, `${id} must not duplicate the widgets`).toBe(false);
    }
  });

  it('renders the POT-scoped widgets (with the active pot) only when withStatus is set', async () => {
    await renderBar({ withStatus: true });
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('pot-a');
    expect(screen.getByTestId('community-badge').getAttribute('data-slug')).toBe('pot-a');

    cleanup();
    await renderBar();
    // Selector still there; the pot widgets gone.
    expect(screen.getByLabelText('Select Pot')).toBeTruthy();
    expect(screen.queryByTestId('now-running')).toBeNull();
    expect(screen.queryByTestId('community-badge')).toBeNull();
  });

  it('never renders the WORKSPACE-wide pills — they live in the AdvShell top bar', async () => {
    // Owner ask 2026-08-01: pots-running + agents-running moved to the tab strip
    // so they show on EVERY tab. Neither reads `?slug=`, so a pot-scoped row was
    // never their scope. Asserted under withStatus (the strongest case: this is
    // the one mode that used to render them) so a re-added import cannot slip
    // back in unnoticed and double-render them on HUD.
    //
    // The pots-running half of that pair no longer exists at all (P-075 deleted
    // the component), so only the agents pill is still a live regression risk
    // here — a `hives-pill` assertion would now pass vacuously and is dropped
    // rather than left looking like coverage.
    await renderBar({ withStatus: true });
    expect(screen.queryByTestId('agents-pill')).toBeNull();
  });

  it('blanks the single-pot widgets under All Pots', async () => {
    nuqsState.scope = 'all';
    await renderBar({ withStatus: true });
    expect(screen.getByTestId('now-running').getAttribute('data-slug')).toBe('');
    expect(screen.queryByText('sub-pots')).toBeNull();
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });
});

describe('AdvPotBar — selector', () => {
  it('picking a concrete pot writes the slug and persists it', async () => {
    await renderBar();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(localStorage.getItem(LS_KEY())).toBe('pot-b');
    // already out of all-mode — no scope write needed
    expect(nuqsSetters.scope).not.toHaveBeenCalled();
  });

  it('picking a pot from All-mode exits all FIRST (sequential scope→slug)', async () => {
    nuqsState.scope = 'all';
    await renderBar();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    expect(nuqsSetters.scope).toHaveBeenCalledWith('expanded');
    expect(nuqsSetters.scope.mock.invocationCallOrder[0]).toBeLessThan(
      nuqsSetters.slug.mock.invocationCallOrder[0],
    );
  });

  it('the All row routes to the scope axis and persists the sentinel', async () => {
    await renderBar();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: '__all__' } });
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('all'));
    expect(localStorage.getItem(LS_KEY())).toBe('__all__');
    // ?slug= keeps the last real pot — switching back is one click
    expect(nuqsSetters.slug).not.toHaveBeenCalled();
  });

  it('picking a hive CLEARS ?harness so the Work dock re-scopes (stale-?harness bugfix)', async () => {
    nuqsState.harness = 'pot-b'; // a sticky within-hive member focus from a prior drill-in
    await renderBar();
    fireEvent.change(screen.getByLabelText('Select Pot'), { target: { value: 'pot-b' } });
    await waitFor(() => expect(nuqsSetters.slug).toHaveBeenCalledWith('pot-b'));
    // THE FIX: the member focus resets to null so dockSlug follows the picked hive
    // instead of the stale sub-hive (a valid member, so the stale-guard kept it).
    await waitFor(() => expect(nuqsSetters.harness).toHaveBeenCalledWith(null));
  });

  it('the sub-pots toggle flips scope between expanded and self', async () => {
    await renderBar();
    const toggle = screen.getByRole('checkbox', { name: /include sub-pots/i });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(nuqsSetters.scope).toHaveBeenCalledWith('self'));
  });

  it('surfaces a projects/lite failure in the selector placeholder', async () => {
    stubProjects([], { fail: true });
    render(<AdvPotBar />);
    expect(await screen.findByRole('option', { name: 'Failed to load Pots' })).toBeTruthy();
  });
});

describe('AdvPotBar — New / Share', () => {
  it('New opens the create picker (?create=true — AdvShell mounts the modal)', async () => {
    await renderBar();
    fireEvent.click(screen.getByRole('button', { name: /New/ }));
    await waitFor(() => expect(nuqsSetters.create).toHaveBeenCalledWith(true));
  });

  it('shows Share (hive publish) for a hive pot; legacy Shared badge for a shared non-hive pot', async () => {
    await renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    await waitFor(() => expect(nuqsSetters.share).toHaveBeenCalledWith(true));

    cleanup();
    nuqsState.slug = 'pot-b'; // legacy shared.json share, NOT a hive
    await renderBar();
    expect(screen.getByText('Shared')).toBeTruthy();
    // Per-harness sharing is retired: a non-hive pot gets no Share button.
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });

  it('relabels the Share button to the live visibility once a hive pot is shared to the directory', async () => {
    // pot-a is a hive; a public directory listing means it is already shared, so
    // the action relabels to the granular visibility (Public / Invite) and reads
    // the discovery meta, not the legacy is_shared/shared.json.
    //
    // It stays a BUTTON on purpose (EI-18814950644299297): this used to assert a
    // passive "Shared" badge, but the Work tab's hive header — the only other
    // Share affordance — was deleted on 2026-07-27, so a passive badge here would
    // strand share management with no way back into the dialog. Asserting the
    // badge is what made this test red; the behavior it described is the one that
    // was deliberately removed.
    hiveShareMeta = { found: true, visibility: 'public' };
    await renderBar();
    const shareBtn = await screen.findByTestId('potbar-share-button');
    await waitFor(() => expect(shareBtn.textContent).toMatch(/Public/));
    expect(shareBtn.textContent).not.toMatch(/Share$/);
  });

  it('shows Invite (not Public) for an invite-only hive pot', async () => {
    hiveShareMeta = { found: true, visibility: 'invite' };
    await renderBar();
    const shareBtn = await screen.findByTestId('potbar-share-button');
    await waitFor(() => expect(shareBtn.textContent).toMatch(/Invite/));
  });
});
