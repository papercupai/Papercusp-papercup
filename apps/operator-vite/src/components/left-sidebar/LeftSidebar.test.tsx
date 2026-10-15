// @vitest-environment jsdom
/**
 * LeftSidebar shell coverage (left-sidebar-tauri-2026-06-07) — the docked,
 * collapsible Colony rail. Mirrors the DevAdminRail shell test: the 5 lazy tab
 * panels are stubbed so this covers the SHELL — the collapsed icon rail vs the
 * expanded shell, open/collapse + tab switching writing ?lsb/?lst atomically (one
 * setRail), the MUG_KETTLE_SYSTEM tier gate on the Mug tab (and where a stale
 * ?lst= lands when its target is hidden or retired), the body-reservation side
 * effect, and
 * the chromeless-route null-out. nuqs runs via the real testing adapter so the
 * atomic useQueryStates write is exercised end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

// `blanketFlagOn` is the BLANKET answer the shared useFlag mock gives every flag —
// it predates there being more than one gated tab, and the order tests lean on it
// to turn the whole rail on at once. `flags` overrides it PER KEY, which is what
// the CONVERSATIONS_RAIL_TAB tests need: that flag is DEFAULT OFF (WI-37561), so
// "sentinel on, convos off" is a real configuration and a single boolean cannot
// express it. Without the per-key override, a test asserting the Convos tab is
// hidden would be indistinguishable from one asserting Sentinel is hidden.
// (It was called `overwatchOn` until 2026-08-11, when the Kettle tab retired —
// P-059/D-083. The name was already a misnomer by then: it answers EVERY flag
// except MUG_KETTLE, so it is what turns Sentinel and Convos on, and the several
// `= true` assignments below are load-bearing for THOSE tabs. Renamed rather than
// removed precisely so the next reader does not delete them as overwatch residue.)
// (`mugKettleOn` was a THIRD knob here, defaulting TRUE, because
// MUG_KETTLE_SYSTEM's OFF state removed the rail's DEFAULT tab — letting the
// blanket answer it would have silently retired the Mug tier underneath every
// test written before that gate existed. The knob is GONE as of 2026-08-12: the
// Mug tab is RETIRED (P-063/D-096), LeftSidebar reads that flag NOWHERE, and a
// knob attached to nothing is the "gate a deleted subject" shape this file keeps
// warning about. The key itself is still pinned as MUG_KETTLE below, because the
// retirement block sets it explicitly to prove a flip does NOT bring the tab
// back.)
const MUG_KETTLE = 'papercusp-mug-kettle-system';
const H = vi.hoisted(() => ({
  blanketFlagOn: false,
  flags: {} as Record<string, boolean>,
  pathname: '/adv',
}));

vi.mock('@papercusp/flags/client', () => ({
  useFlag: (key: string) => H.flags[key] ?? H.blanketFlagOn,
}));
vi.mock('@/lib/router-compat/navigation', () => ({ usePathname: () => H.pathname }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `test:${k}`,
}));
// Stub the lazy tab panels with trivial markers — their own surfaces are tested
// separately.
// (No './PotsTab' stub: this rail no longer mounts it at all — the Pots tab was
// removed 2026-08-10 on owner directive. A stub here would hide a regression that
// re-added the tab, the same reasoning as the SwarmTab/VoiceTab note below.)
vi.mock('./AccountsTab', () => ({ default: () => <div data-testid="panel-accounts" /> }));
// (No './MugTab' stub: that module RETIRED to _retired/mug-kettle-deciders/ with
// the Mug/`queen` tab — P-063/D-096 — exactly as the OverwatchTab stub went
// below. A vi.mock naming a module that no longer exists is the strand this repo
// has been bitten by before, so it goes with the tab rather than lingering as a
// harmless-looking line.)
// (No './OverwatchTab' stub: that module RETIRED to _retired/mug-kettle-deciders/
// with the Kettle tab — P-059/D-083. A vi.mock naming a module that no longer
// exists is the strand this repo has been bitten by before, so it goes with the
// tab rather than lingering as a harmless-looking line.)
vi.mock('./WorkspacePulseTab', () => ({ default: () => <div data-testid="panel-pulse" /> }));
vi.mock('./ConversationsTab', () => ({ default: () => <div data-testid="panel-conversations" /> }));
// SwarmTab / VoiceTab are deliberately NOT stubbed: this rail no longer mounts
// them at all (WI-5162 — they are op-chat sidebar faces now). A stub here would
// hide a regression that re-added them. See the "moved out" test below.

import LeftSidebar, { leftSidebarWidthFromPointer } from './LeftSidebar';
import { getLatestMeasure } from '@/app/_components/perf/perf-marks';

describe('far-left dock width math (D-009)', () => {
  it('uses viewport clientX directly, independent of the chat pane width', () => {
    document.documentElement.style.setProperty('--op-chat-w', '720px');
    expect(leftSidebarWidthFromPointer(420, 1440)).toBe(420);
  });

  it('retains the rail minimum and viewport ceiling', () => {
    expect(leftSidebarWidthFromPointer(10, 1200)).toBe(300);
    expect(leftSidebarWidthFromPointer(2000, 1200)).toBe(600);
  });
});

beforeAll(() => {
  // The vitest jsdom localStorage shim can be broken (`getItem is not a function`);
  // install a real in-memory Storage so components rendered in the tree that read
  // localStorage at render (VoiceButton's wake/ptt-hint useState init; LeftSidebar's
  // own width restore) don't crash. Mirrors AdvShell.test.tsx's pattern.
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

function setViewportWidth(value: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  setViewportWidth(1440);
  localStorage.clear();
  H.blanketFlagOn = false;
  H.flags = {};
  H.pathname = '/adv';
  document.body.className = '';
});
afterEach(() => {
  cleanup();
  document.body.className = '';
});

function renderRail(searchParams = '') {
  const onUrlUpdate = vi.fn();
  render(<LeftSidebar />, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
        {children}
      </NuqsTestingAdapter>
    ),
  });
  const lastQuery = () =>
    onUrlUpdate.mock.calls.length
      ? onUrlUpdate.mock.calls[onUrlUpdate.mock.calls.length - 1][0].queryString
      : '';
  return { onUrlUpdate, lastQuery };
}

describe('<LeftSidebar> shell', () => {
  // Was "defaults to OPEN on the Mug tab (the owner-default Colony tab)". Mug was
  // the owner's default-open pick (2026-06-15) until it retired with its tier on
  // 2026-08-12 — P-063/D-096. Accounts is TABS[0] and the new static nuqs
  // default. The rail still defaults to OPEN, which is the half of this test that
  // is about the rail rather than about which tab won.
  it('defaults to OPEN on the Accounts tab (TABS[0], the new default)', async () => {
    renderRail();
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rail.getAttribute('data-tab')).toBe('accounts');
    expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
    await waitFor(() => expect(getLatestMeasure('accounts-tab-import')).not.toBeNull());
  });

  // Pins the WHOLE owner-set order, not just the first pair (owner ask
  // 2026-07-25: "move the pots tab to the right of the accounts tab" + "move the
  // papercup tab to the right of the pots tab"). The previous version asserted
  // only ['Accounts', 'brain'], which would have stayed green through exactly the
  // reordering the owner asked for — a placement request needs a test that fails
  // when the placement changes, or the next refactor silently undoes it.
  //
  // Labels route through the lexicon (t('pot'), t('operator'), t('brain'),
  // t('overwatch')); the useLexicon mock above echoes the key, so they render as
  // the bare key names (restore-pot-lexicon P-005 — the classic pack shows
  // Pots / Papercup / Brain / Kettle at runtime).
  it('orders the consolidated rail Accounts · Papercup · Pulse', () => {
    // The blanket useFlag answer turns EVERY gated tab on — overwatch, sentinel
    // and (since WI-37561) conversations. The full rail is what the owner's
    // ordering describes, and pinning it with the gates open is deliberate: a
    // dark tab still has a place in the order, and this test is what keeps that
    // place from drifting while nobody can see the tab. The gated-OFF subsets are
    // covered by the flag tests below.
    H.blanketFlagOn = true;
    renderRail();
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((x) => x.textContent?.trim())).toEqual([
      'Accounts',
      // ('pot' sat HERE, right of Accounts, 2026-07-25 → 2026-08-10. REMOVED on
      // owner directive: "Remove the 'Pots' tab from the middle pane." Like the
      // Goals removal noted below this is a removal from the MIDDLE, so every
      // entry after it shifts up one — if you are reading this because the test
      // red'd, check whether your change meant to move a tab at all before
      // editing the expectation.)
      'operator',
      // ('brain' (the Mug) sat HERE, between Papercup and the Kettle, until
      // 2026-08-12. RETIRED with its tier — P-063/D-096 — so like the Kettle
      // below this is a removal from TABS itself, not a gated-OFF tab, and every
      // entry after it shifts up one. If you are reading this because the test
      // red'd, check whether your change meant to move a tab at all first.)
      // ('overwatch' (the Kettle) sat HERE, between Mug and Agents, until
      // 2026-08-11. RETIRED with its tier — P-059/D-083 — so unlike the gated-OFF
      // case this is a removal from TABS itself, and every entry after it shifts
      // up one. If you are reading this because the test red'd, check whether your
      // change meant to move a tab at all before editing the expectation.)
      // (🎯 Goals sat HERE, between Kettle and Agents, 2026-08-07 → 2026-08-09.
      // REMOVED on owner directive: "remove the goals middle pane tab entirely.
      // We already have a goals tab inside the hud tab lets just use that."
      // Unlike every prior change to this rail, this is a removal from the
      // MIDDLE, so everything below shifts up one — which is exactly the kind of
      // silent reshuffle this test exists to make loud. If you are reading this
      // because the test red'd, check whether your change meant to move a tab at
      // all before editing the expectation.)
      // Catalog identity, controls, schedules, history, and spend moved to the
      // full-width Automations main tab. The middle pane keeps live attention.
      'Pulse',
      // WI-5754 — APPENDED, never inserted: the order above is owner-set, so a
      // new tab goes last rather than reshuffling it. The label is "Convos"
      // because a 3-column tab cell fits ~8 characters beside its icon at the
      // rail's 300px minimum; the pane header carries the full word.
      //
      // WI-37561: Convos is now DEFAULT OFF behind CONVERSATIONS_RAIL_TAB (owner
      // directive 2026-08-09), so at runtime the rail normally ends at Pulse. It
      // is asserted here because the flag is ON in this test — its POSITION is
      // what survives the park, and holding that position is precisely what makes
      // flipping the flag back on a one-click change rather than a code change.
      'Convos',
      // NOTE there is deliberately no 'Tasks' here any more: the task manager left
      // this rail on 2026-08-02 for the AdvShell header (WI-6844, owner ask) and is
      // now TasksRunningPill. Removing it was a REMOVAL from the end, so every
      // position above is untouched — which is exactly what this test exists to
      // prove about any change to the rail, additions and removals alike.
    ]);
  });

  // The collapsed icon rail is a SECOND rendering of the same TABS array, and the
  // owner navigates by it while collapsed — so it must carry the same order.
  it('keeps the collapsed icon rail in the same order as the expanded tabs', () => {
    H.blanketFlagOn = true;
    renderRail('?lsb=false');
    const railButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="left-sidebar-rail-"]'),
    )
      .map((el) => el.getAttribute('data-testid')!.replace('left-sidebar-rail-', ''))
      // drop the expand control that sits above the tab icons
      .filter((id) => id !== 'expand');
    expect(railButtons).toEqual([
      'accounts',
      // ('hives' was here — removed 2026-08-10 with the Pots tab. It joins
      // 'goal'/'blender'/'docs'/'tasks' as a RETIRED id: a stale `?lst=hives` no
      // longer matches the nuqs literal parser and falls through to the default.)
      'sentinel',
      // ('queen' was here — removed 2026-08-12 with the Mug tab (P-063/D-096).
      // It joins 'overwatch'/'hives'/'goal'/'blender'/'docs'/'tasks' as a RETIRED
      // id: a stale `?lst=queen` no longer matches the nuqs literal parser and
      // falls through to the default tab, which is now 'accounts'.)
      // ('overwatch' was here — removed 2026-08-11 with the Kettle tab. It joins
      // 'hives'/'goal'/'blender'/'docs'/'tasks' as a RETIRED id: a stale
      // `?lst=overwatch` no longer matches the nuqs literal parser and falls
      // through to the default tab.)
      // ('goal' was here — removed 2026-08-09 with the Goals tab. It joins
      // 'blender'/'docs'/'tasks' as a RETIRED id: a stale `?lst=goal` no longer
      // matches the nuqs literal parser and falls through to the default tab.)
      'pulse',
      'conversations',
    ]);
  });

  // Subject is `pulse`, the consolidated non-default live-attention pane. It must stay a
  // NON-DEFAULT, ungated, stubbed tab or the test stops proving anything: point it
  // at the default tab and it passes without the deep link doing any work.
  it('deep-links a tab from ?lst= and mounts only that panel', async () => {
    renderRail('?lst=pulse');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('pulse');
    expect(await screen.findByTestId('panel-pulse')).toBeTruthy();
    // The DEFAULT panel must not also be mounted — this asserted `panel-queen`
    // until 2026-08-12, which became vacuous when that tab was deleted
    // (P-063/D-096); re-pointed at the new default so it still proves "only that
    // panel" rather than passing because the subject cannot exist.
    expect(screen.queryByTestId('panel-accounts')).toBeNull();
  });

  // A retired tab id must not resolve. `hives` joins goal/blender/docs/tasks: the
  // nuqs literal parser no longer lists it, so a stale deep link falls through to
  // the default tab rather than rendering a blank rail.
  it('falls through to the default tab for the RETIRED ?lst=hives deep link', () => {
    renderRail('?lst=hives');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).not.toBe('hives');
    expect(screen.queryByTestId('panel-hives')).toBeNull();
  });

  // Owner ask 2026-09-01: the cloud portal frames this rail as ITS OWN sidebar
  // (/portal-panes/steering). Docked = the rail is the whole document: always
  // open even against ?lsb=false, no collapse/expand/resize controls (the
  // portal owns those), and no body-class layout reservation.
  it('renders docked as an always-open pane with no collapse, expand, or resize controls', async () => {
    render(
      <NuqsTestingAdapter searchParams="?lsb=false&lst=pulse">
        <LeftSidebar docked />
      </NuqsTestingAdapter>,
    );
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-docked')).toBe('true');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rail.classList.contains('pclsb--docked')).toBe(true);
    expect((rail as HTMLElement).style.width).toBe('100%');
    // The ?lst= deep link still picks the tab, so the portal can target one.
    expect(rail.getAttribute('data-tab')).toBe('pulse');
    expect(await screen.findByTestId('panel-pulse')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).toBeNull();
    await waitFor(() => expect(document.body.classList.contains('has-left-sidebar')).toBe(false));
  });

  it('collapses to the icon rail on ?lsb=false and unmounts the active panel', () => {
    renderRail('?lsb=false');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    // The ACTIVE panel unmounts while collapsed. This named `panel-queen` until
    // 2026-08-12 (P-063/D-096) — re-pointed at the new default tab so it still
    // has a subject that could actually have mounted.
    expect(screen.queryByTestId('panel-accounts')).toBeNull();
    // The collapsed expand-rail icon buttons are present.
    expect(screen.getByTestId('left-sidebar-rail-pulse')).toBeTruthy();
    // ...and the removed Pots icon is NOT (2026-08-10) — the collapsed rail is a
    // second rendering of TABS, so a tab removed from one must vanish from both.
    expect(screen.queryByTestId('left-sidebar-rail-hives')).toBeNull();
  });

  it('clicking a tab switches the active panel and writes ?lst', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByTestId('left-sidebar-tab-pulse'));
    await waitFor(() => expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('pulse'));
    expect(await screen.findByTestId('panel-pulse')).toBeTruthy();
    expect(lastQuery()).toContain('lst=pulse');
  });

  it('the collapse button writes ?lsb=false', async () => {
    const { lastQuery } = renderRail();
    fireEvent.click(screen.getByLabelText('Collapse sidebar'));
    await waitFor(() => expect(lastQuery()).toContain('lsb=false'));
  });

  it('a collapsed icon-rail button expands AND selects its tab atomically (one write)', async () => {
    // ?lsb default is `true`, so the URL omits lsb=true once re-opened; assert the
    // observable rail state instead — both the expand (collapsed=false) AND the tab
    // selection (data-tab=accounts) must land from the single setRail write.
    renderRail('?lsb=false');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-collapsed')).toBe('true');
    fireEvent.click(screen.getByTestId('left-sidebar-rail-accounts'));
    await waitFor(() => {
      const rail = screen.getByTestId('left-sidebar');
      expect(rail.getAttribute('data-collapsed')).toBe('false');
      expect(rail.getAttribute('data-tab')).toBe('accounts');
    });
    expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
  });

  it('the expand control is the TOPMOST collapsed-rail button and re-expands to the last pane without switching tabs (WI-4800)', async () => {
    // Pulse is a NON-DEFAULT tab, so this proves expand preserves selection.
    // NON-DEFAULT tab (the default is 'queen') or "re-expands WITHOUT switching
    // tabs" would pass even if the tab silently reset.
    renderRail('?lsb=false&lst=pulse');
    const rail = screen.getByTestId('left-sidebar');
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    expect(rail.getAttribute('data-tab')).toBe('pulse');
    // The expand control is the FIRST button in the collapsed rail (topmost) —
    // the mirror of the collapse chevron, not buried under the tab icons.
    const railEl = document.querySelector('.pclsb__expand-rail');
    const firstBtn = railEl!.querySelector('button');
    expect(firstBtn?.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(firstBtn?.getAttribute('data-testid')).toBe('left-sidebar-rail-expand');
    // Clicking it re-expands to the SAME (last) pane — no tab switch.
    fireEvent.click(screen.getByTestId('left-sidebar-rail-expand'));
    await waitFor(() => {
      expect(rail.getAttribute('data-collapsed')).toBe('false');
    });
    expect(rail.getAttribute('data-tab')).toBe('pulse');
  });

  it('auto-collapses on compact entry without rewriting ?lsb and honors explicit re-expand', async () => {
    setViewportWidth(620);
    const { onUrlUpdate } = renderRail();
    const rail = screen.getByTestId('left-sidebar');

    await waitFor(() => expect(rail.getAttribute('data-collapsed')).toBe('true'));
    expect(onUrlUpdate).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--left-sidebar-w')).toBe(rail.style.width);

    fireEvent.click(screen.getByTestId('left-sidebar-rail-expand'));
    await waitFor(() => expect(rail.getAttribute('data-collapsed')).toBe('false'));

    fireEvent.resize(window);
    expect(rail.getAttribute('data-collapsed')).toBe('false');

    setViewportWidth(1440);
    fireEvent.resize(window);
    setViewportWidth(620);
    fireEvent.resize(window);
    await waitFor(() => expect(rail.getAttribute('data-collapsed')).toBe('true'));
  });

  // WI-5162 (owner ask 2026-07-17): Fleet + Peers MOVED to the op-chat sidebar,
  // right of the 🎯 Pot Health button. They must be gone from this rail —
  // expanded tabs AND collapsed icon rail — or the owner sees them in two
  // places at once, which is exactly what the move was meant to end.
  it('no longer hosts the Fleet or Peers tabs — they moved to the op-chat sidebar (WI-5162)', () => {
    H.blanketFlagOn = true;
    renderRail();
    for (const gone of ['swarm', 'voice']) {
      expect(screen.queryByTestId(`left-sidebar-tab-${gone}`)).toBeNull();
      expect(screen.queryByTestId(`left-sidebar-rail-${gone}`)).toBeNull();
    }
    // The steering/settings tabs this rail kept are all still here. ('hives' left
    // this list on 2026-08-10 — the Pots tab was removed on owner directive, so
    // asserting it is KEPT would now be asserting the opposite of the intent.
    // 'overwatch' left it on 2026-08-11 for the same reason — P-059/D-083, and
    // 'queen' on 2026-08-12 — P-063/D-096. Anchored on two UNGATED survivors so
    // this cannot go silently unasserted the way a gated anchor could.)
    for (const kept of ['accounts', 'pulse']) {
      expect(screen.getByTestId(`left-sidebar-tab-${kept}`)).toBeTruthy();
    }
    // ...and Pots is gone from BOTH renderings, same as Fleet/Peers above.
    expect(screen.queryByTestId('left-sidebar-tab-hives')).toBeNull();
    expect(screen.queryByTestId('left-sidebar-rail-hives')).toBeNull();
  });

  // A bookmarked ?lst=swarm must not wedge the rail on a tab that no longer
  // exists: the nuqs literal parser rejects it and falls back to the default.
  it('falls back to the default tab for a stale ?lst pointing at a moved tab (WI-5162)', () => {
    renderRail('?lst=swarm');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts');
  });

  // The Kettle tab was FLAG-GATED here (hidden/shown by OVERWATCH, with a
  // snap-back for a stale ?lst) until 2026-08-11. It is now RETIRED outright —
  // P-059/D-083 — so those three cases could no longer fail for the right reason:
  // a gating test whose subject has been deleted passes vacuously forever.
  // What replaces them is the assertion that actually protects the retirement:
  // the tab must stay gone with EVERY flag forced on, which is the one direction
  // a reflexive "restore the tab" change would break.
  it('no longer hosts a Kettle/Overwatch tab, with every flag forced on', () => {
    H.blanketFlagOn = true;
    H.flags = { [MUG_KETTLE]: true, 'papercusp-conversations-rail-tab': true };
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-overwatch')).toBeNull();
    expect(screen.queryByTestId('left-sidebar-rail-overwatch')).toBeNull();
    // Its surviving neighbours. Mug was the left-hand one until it retired in
    // turn (P-063/D-096), so Accounts anchors that side now. The removal came out
    // of the MIDDLE of TABS, so these are what a bad re-index would disturb.
    expect(screen.getByTestId('left-sidebar-tab-accounts')).toBeTruthy();
    expect(screen.getByTestId('left-sidebar-tab-pulse')).toBeTruthy();
  });

  // (The `?lst=overwatch` bookmark case moved into the tier-retirement block
  // below, where it is asserted for BOTH retired ids through one it.each:
  // `queen` joined `overwatch` in leaving TAB_IDS on 2026-08-12, so the two
  // cases had become the same assertion with a different literal.)

  // 🎯 Goals left this rail on 2026-08-09 (owner: "remove the goals middle pane
  // tab entirely. We already have a goals tab inside the hud tab lets just use
  // that."). Unlike Convos it is DELETED, not flag-gated — the owner asked for
  // two different things and the difference is the point, so this pair of tests
  // is what stops a later change "restoring" it by reflex.
  it('no longer hosts a Goals tab — the HUD Goals tab is the one goals surface', () => {
    H.blanketFlagOn = true;
    H.flags = { 'papercusp-conversations-rail-tab': true };
    renderRail();
    expect(screen.queryByTestId('left-sidebar-tab-goal')).toBeNull();
    expect(screen.queryByTestId('left-sidebar-rail-goal')).toBeNull();
    // Its former neighbours are both still here — the removal came out of the
    // MIDDLE of the array, so this is the pair most likely to be disturbed.
    // (Goals' left-hand neighbour was the Kettle tab; that retired in turn —
    // P-059/D-083 — and then Mug did too — P-063/D-096 — so Accounts is the
    // surviving anchor on that side.)
    expect(screen.getByTestId('left-sidebar-tab-accounts')).toBeTruthy();
    expect(screen.getByTestId('left-sidebar-tab-pulse')).toBeTruthy();
  });

  it("retires the 'goal' id so a stale ?lst=goal falls through to the default tab", async () => {
    const { TAB_IDS } = await import('./LeftSidebar');
    expect(TAB_IDS).not.toContain('goal');
    // Deliberately UNLIKE the flag-gated Convos case: there is no snap-back
    // effect for `goal`, because nuqs's literal parser no longer accepts the
    // value at all — it never becomes the active tab in the first place.
    renderRail('?lst=goal');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts');
  });

  // ── 💬 Convos behind its testing flag (WI-37561) ─────────────────────────────
  // Owner directive 2026-08-09: "Put the 'convos' tab in the middle pane behind a
  // testing flag", with hidden-until-flipped chosen over a visible kill-switch.
  // CONVERSATIONS_RAIL_TAB is therefore DEFAULT OFF (a DARK_FLAGS 'parked' entry),
  // which makes the hidden case the DEFAULT rendering of this rail, not an edge.
  //
  // Each of these pins the flag EXPLICITLY via H.flags rather than leaning on the
  // blanket-off default. Relying on the default would keep them green if the gate
  // were deleted and the tab simply removed from TABS — the assertion has to fail
  // for the right reason, and "the flag is off" and "the entry is gone" are
  // different states with the same screen.
  describe('the Convos tab gate', () => {
    const CONVOS = 'papercusp-conversations-rail-tab';

    it('hides Convos from BOTH the tab strip and the collapsed icon rail while the flag is off', () => {
      // Everything else on, convos off — the configuration the single blanket
      // boolean could not express, and the one the owner actually ships.
      H.blanketFlagOn = true;
      H.flags = { [CONVOS]: false };
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-conversations')).toBeNull();
      // The collapsed rail is a SECOND rendering of TABS — a gate applied to only
      // one of the two leaves the tab reachable from the icon rail while invisible
      // in the strip, which is worse than not gating it at all.
      expect(screen.queryByTestId('left-sidebar-rail-conversations')).toBeNull();
      // The rail is otherwise intact: hiding the last tab must not disturb Pulse,
      // the tab it sits beside.
      expect(screen.getByTestId('left-sidebar-tab-pulse')).toBeTruthy();
    });

    it('shows Convos again the moment the flag is flipped on', () => {
      H.blanketFlagOn = true;
      H.flags = { [CONVOS]: true };
      renderRail();
      expect(screen.getByTestId('left-sidebar-tab-conversations')).toBeTruthy();
      expect(screen.getByTestId('left-sidebar-rail-conversations')).toBeTruthy();
    });

    it('mounts the Convos panel when the flag is on and the tab is selected', async () => {
      H.flags = { [CONVOS]: true };
      renderRail('?lst=conversations');
      expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('conversations');
      expect(await screen.findByTestId('panel-conversations')).toBeTruthy();
    });

    // The failure this prevents: `conversations` stays in TAB_IDS (so the flag can
    // be flipped back on without a code change), which means nuqs still PARSES a
    // bookmarked ?lst=conversations. Without the guard, `active` falls through to
    // visibleTabs[0] — Accounts — while ?lst= still reads `conversations`, so the
    // URL, `data-tab` and ui:get_state disagree with what is on screen.
    // (Landed on Mug until 2026-08-12; the snap-back target followed `homeTab`
    // to Accounts when the Mug tab retired — P-063/D-096.)
    it('snaps a bookmarked ?lst=conversations back to Accounts while the flag is off', async () => {
      H.flags = { [CONVOS]: false };
      renderRail('?lst=conversations');
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
      expect(screen.queryByTestId('panel-conversations')).toBeNull();
    });

    // The one failure the mocked useFlag above CANNOT see, and it is silent in the
    // expensive direction. `useFlag` resolves `current.flags[key] ?? FLAG_DEFAULTS[key]`
    // — so if `FLAGS.CONVERSATIONS_RAIL_TAB` were ever undefined at runtime (a typo, or
    // operator-vite resolving a stale second copy of @papercusp/flags — a documented
    // hazard in this tree), the lookup would be `FLAG_DEFAULTS[undefined]` → undefined →
    // falsy → tab hidden. The VISIBLE outcome would be exactly right, so every assertion
    // above would still pass, while the owner's flip at /admin/features could never turn
    // the tab back on. Pin the key against its wire value from the REAL module.
    it('resolves a defined flag key against the real flags module, so the flip can work', async () => {
      const { FLAGS } = await import('@papercusp/flags');
      expect(FLAGS.CONVERSATIONS_RAIL_TAB).toBe(CONVOS);
    });

    // The id must SURVIVE in TAB_IDS: it is what keeps the nuqs enum parsing the
    // deep link (so the snap-back above is reachable rather than a silent default)
    // and what makes flipping the flag on a /admin/features action instead of a
    // code change. A tab deleted outright would pass every assertion above.
    it('keeps `conversations` in TAB_IDS so the park is a flag flip, not a deletion', async () => {
      const { TAB_IDS } = await import('./LeftSidebar');
      expect(TAB_IDS).toContain('conversations');
    });
  });

  // MUG_KETTLE_SYSTEM (retire-mug-kettle-su-only-2026-08-09 P-012). Unlike the
  // three gates above, this one hides the rail's DEFAULT tab, so the interesting
  // assertions are not "is the tab gone" but "where does everything that used to
  // land on Mug land now". Note the polarity: OFF is the shipped end state here,
  // so this block describes production and the rest of the file describes the
  // testing escape hatch.
  describe('the Mug/Kettle tier retirement (both tabs deleted, not gated)', () => {
    // Re-declared rather than shared with the Convos block above: the two gates
    // are independent, and the cross-gate test below is the only place they meet.
    const CONVOS_KEY = 'papercusp-conversations-rail-tab';

    // This block used to cover the surviving HALF of the tier gate. The Kettle
    // tab was the other half until 2026-08-11: it took BOTH this gate and its
    // own OVERWATCH flag, and three cases here pinned that AND. All three went
    // with the tab (P-059/D-083) rather than being rewritten, because a flag-AND
    // has no meaning once one operand's subject is deleted.
    //
    // Mug is now retired too — P-063/D-096 — so LeftSidebar reads
    // FLAGS.MUG_KETTLE_SYSTEM NOWHERE and every flag-gating case here has lost
    // its subject. They are REPLACED for the same reason the Kettle's were: a
    // gating test whose subject has been deleted passes vacuously forever. The
    // `H.mugKettleOn` knob that drove them went with the component's flag read.
    //
    // What protects the retirement instead is the tripwire shape: the tab must
    // stay gone with EVERY flag forced on — including the tier flag, which still
    // EXISTS (adv/AdvNowRunning.tsx reads it until P-068) and so can still be
    // flipped by someone expecting the tab back.
    it('no longer hosts a Mug/queen tab, with every flag forced on', () => {
      H.blanketFlagOn = true;
      H.flags = { [MUG_KETTLE]: true, [CONVOS_KEY]: true };
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-queen')).toBeNull();
      expect(screen.queryByTestId('left-sidebar-rail-queen')).toBeNull();
      // The ungated rail is otherwise intact — the removal came out of the
      // MIDDLE of TABS, so these neighbours are what a bad re-index disturbs.
      expect(screen.getByTestId('left-sidebar-tab-accounts')).toBeTruthy();
      expect(screen.getByTestId('left-sidebar-tab-pulse')).toBeTruthy();
    });

    // ⚠ THE FLAG IS NOT AN UNDO — the UI counterpart of the contract D-080 set
    // for retired TOOLS. Flipping papercusp-mug-kettle-system ON does not bring
    // a deleted, unmounted surface back. This is the case that catches someone
    // "re-enabling the Mug" by flipping the flag and believing it worked.
    it('does not resurrect the Mug tab when the tier flag is flipped ON', () => {
      H.flags = { [MUG_KETTLE]: true };
      renderRail();
      expect(screen.queryByTestId('left-sidebar-tab-queen')).toBeNull();
      expect(screen.queryByTestId('panel-queen')).toBeNull();
    });

    // THE DEFAULT-TAB MOVE. The nuqs default was a static 'queen'; TAB_IDS is
    // derived from TABS, so deleting the entry forced the default to 'accounts'
    // in the same change (a 'queen' default no longer typechecks). A fresh load
    // must land on a REAL tab with data-tab and the rendered panel agreeing —
    // the URL-vs-screen disagreement this file keeps catching.
    it('lands a fresh load on Accounts, the new static default', async () => {
      renderRail();
      await waitFor(() =>
        expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
      );
      expect(await screen.findByTestId('panel-accounts')).toBeTruthy();
      expect(screen.queryByTestId('panel-queen')).toBeNull();
    });

    // Both retired ids now self-heal through the PARSER rather than a snap-back
    // guard: neither is in TAB_IDS, so parseAsStringLiteral rejects the value and
    // `tab` reads the 'accounts' default. Asserting them together is deliberate —
    // they retired a day apart for the same reason, and a reflexive "add a guard
    // for the stale deep link" change would be redundant with the parser.
    it.each(['queen', 'overwatch'])(
      'lands a bookmarked ?lst=%s on Accounts via the parser, not a guard',
      async (stale) => {
        H.blanketFlagOn = true;
        renderRail(`?lst=${stale}`);
        await waitFor(() =>
          expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts'),
        );
        // Not merely "the panel is absent" — vacuous once the tab is gone.
        // Assert the rail rendered a REAL tab: stranding an owner's bookmark on
        // an empty body is the failure that matters.
        expect(screen.getByTestId('left-sidebar-tab-accounts')).toBeTruthy();
      },
    );

    // `queen` LEAVES TAB_IDS — the inversion this retirement turns on. It was
    // pinned as PRESENT until 2026-08-12 precisely because the tier flag made it
    // a flip rather than a code change. P-063/D-096 makes it a DELETION, so it
    // follows `overwatch` and `goal` out of the list, and pinning the absence is
    // what stops a later change restoring it by reflex.
    it('drops both `queen` and `overwatch` from TAB_IDS (both are deletions now)', async () => {
      const { TAB_IDS } = await import('./LeftSidebar');
      expect(TAB_IDS).not.toContain('queen');
      expect(TAB_IDS).not.toContain('overwatch');
      // Survivors pinned too, so this reds on a bad splice and not only a rename.
      expect(TAB_IDS).toContain('accounts');
      expect(TAB_IDS).toContain('pulse');
    });

    // P-068/D-098 DELETED the tier flag — the last read (adv/AdvNowRunning) went
    // with it. This test used to resolve the key against the real flags module so
    // the tripwire above could not pass against a typo'd key that gates nothing.
    // That concern is now moot in the strongest possible way: there is no key at
    // all, so the tripwire above forces a literal string that matches NO flag and
    // the tab must stay gone regardless. Assert the deletion, which is the thing
    // a later reader could actually undo.
    it('no longer has a tier flag to flip — the retirement is permanent', async () => {
      const { FLAGS } = await import('@papercusp/flags');
      expect('MUG_KETTLE_SYSTEM' in FLAGS).toBe(false);
      expect(Object.values(FLAGS as Record<string, string>)).not.toContain(MUG_KETTLE);
    });
  });

  it('renders nothing on a chromeless (iframe-target) route', () => {
    H.pathname = '/pi/some-embed';
    const { container } = render(
      <NuqsTestingAdapter>
        <LeftSidebar />
      </NuqsTestingAdapter>,
    );
    expect(container.querySelector('[data-testid="left-sidebar"]')).toBeNull();
  });

  it('reserves left-side layout space (body.has-left-sidebar) when docked', async () => {
    renderRail();
    await waitFor(() => expect(document.body.classList.contains('has-left-sidebar')).toBe(true));
    expect(document.documentElement.style.getPropertyValue('--left-sidebar-w')).toBeTruthy();
  });

  // The middle pane's one operational replacement follows Papercup; automation
  // identity and controls live in the full-width main tab instead.
  it('opens Pulse from ?lst=pulse and places it immediately after Papercup', async () => {
    H.blanketFlagOn = true;
    renderRail('?lst=pulse');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('pulse');
    expect(await screen.findByTestId('panel-pulse')).toBeTruthy();
    const ids = Array.from(document.querySelectorAll('[role="tab"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    const anchor = ids.indexOf('left-sidebar-tab-sentinel');
    const pulse = ids.indexOf('left-sidebar-tab-pulse');
    expect(anchor).toBeGreaterThan(-1);
    expect(pulse).toBe(anchor + 1);
  });

  // The retired ids must not silently resolve to something else — a stale
  // `?lst=blender` bookmark falls through to the default tab (see the TABS note in
  // LeftSidebar.tsx).
  it('no longer resolves the retired blender / docs tab ids', () => {
    renderRail('?lst=blender');
    expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).not.toBe('blender');
  });

  it('retires the duplicate Agents/System/Spend catalog ids and exports Pulse', async () => {
    const { TAB_IDS } = await import('./LeftSidebar');
    expect(TAB_IDS).toContain('pulse');
    expect(TAB_IDS).not.toContain('agents');
    expect(TAB_IDS).not.toContain('system');
    expect(TAB_IDS).not.toContain('spend');
    expect(TAB_IDS).not.toContain('blender');
    for (const stale of ['agents', 'system', 'spend']) {
      cleanup();
      renderRail(`?lst=${stale}`);
      expect(screen.getByTestId('left-sidebar').getAttribute('data-tab')).toBe('accounts');
    }
  });

});
