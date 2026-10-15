// @vitest-environment jsdom
//
// LearningLoopControl — the Learning tab header's pause/resume + spend control
// (WI-39501). Tests mock the three seams the component rides — the
// `learning.loopControl` sync query, the LEARNING_LOOP_CONTROL flag, and the
// gated `/api/agent-mcp/run-tool` bridge — and assert the contract that
// matters: flag-off/no-snapshot renders NOTHING; running vs paused rendering;
// pause sends `{ active:false, reason }` (reason REQUIRED — group-set refuses
// without it) while resume sends `{ active:true }` and NEVER activateAll (the
// snapshot semantics: deliberate holds stay held); a refused bridge call
// surfaces as the inline error instead of throwing away the state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { LearningLoopControl as LoopSnapshot } from '@papercusp/operator-core/lib/harness/improvements/loop-control';
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

const H = vi.hoisted(() => ({
  enabled: true,
  snap: undefined as unknown,
  arming: undefined as unknown,
  dreams: {} as Record<string, unknown>,
  invalidate: { fn: (() => {}) as () => void },
  catalogInvalidate: { fn: (() => {}) as () => void },
  runTool: { fn: (async () => {}) as (...args: unknown[]) => Promise<unknown> },
  openDrawer: { fn: ((_slug: string) => {}) as (slug: string) => void },
  openPicker: { fn: (() => {}) as () => void },
}));

// TWO queries now, and they must be told apart: the control absorbed the pot
// rail, so it reads automation.catalog for the scopes alongside its own
// loopControl snapshot. A single undiscriminated mock would hand the loop
// snapshot to the pot list and quietly render nothing.
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName?: string; args?: { potSlug?: string } }) => {
    if (opts?.queryName === 'learning.dream') {
      const snapshot = H.dreams[opts.args?.potSlug ?? ''];
      return { data: snapshot ? [snapshot] : [], invalidate: H.catalogInvalidate.fn };
    }
    if (opts?.queryName === 'automation.catalog') {
      return {
        data: H.arming ? [{ arming: H.arming }] : undefined,
        invalidate: H.catalogInvalidate.fn,
      };
    }
    return { data: H.snap ? [H.snap] : undefined, invalidate: H.invalidate.fn };
  },
}));
vi.mock('@/lib/useLexicon', () => ({
  useLexicon:
    () => (_key: string, opts?: { plural?: boolean; lower?: boolean }) => {
      const word = opts?.plural ? 'Pots' : 'Pot';
      return opts?.lower ? word.toLowerCase() : word;
    },
}));
vi.mock('@/lib/pot-label', () => ({ potHomeLabel: (slug: string) => slug }));
vi.mock('./run-tool', () => ({
  runAgentTool: (...args: unknown[]) => H.runTool.fn(...args),
}));
vi.mock('./LearningPotDrawer', () => ({ useOpenPotDrawer: () => H.openDrawer.fn }));
vi.mock('./LearningPotPicker', () => ({ useOpenPotPicker: () => H.openPicker.fn }));
vi.mock('@papercusp/flags/client', () => ({
  useFlag: () => H.enabled,
}));
// nuqs needs an adapter context — stub useQueryState with plain React state.
vi.mock('nuqs', async () => {
  const { useState } = await import('react');
  return {
    useQueryState: (_key: string, parser?: { defaultValue?: unknown }) => {
      const [v, setV] = useState<unknown>(parser?.defaultValue ?? null);
      return [v, (nv: unknown) => Promise.resolve(setV(nv))] as const;
    },
    parseAsBoolean: { withDefault: (d: boolean) => ({ defaultValue: d }) },
    parseAsString: {},
  };
});

import LearningLoopControl from './LearningLoopControl';

function makeSnap(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    group: 'self-improvement',
    memberCount: 25,
    activeCount: 16,
    heldCount: 0,
    status: 'running',
    pausedAtMs: null,
    pausedBy: null,
    spend: {
      todayUsd: 4.62,
      weekUsd: 17.93,
      roles: ['scout', 'gym', 'llm-testing'],
      byRole: [
        { role: 'scout', todayUsd: 3.1, weekUsd: 12.0 },
        { role: 'gym', todayUsd: 1.02, weekUsd: 4.5 },
        { role: 'llm-testing', todayUsd: 0.5, weekUsd: 1.43 },
      ],
    },
    evaluatedAt: Date.UTC(2026, 7, 16, 21, 0, 0),
    ...overrides,
  };
}

// Arming fixtures, same shapes learning-pot-rail.test.ts builds — the model is
// unchanged by the fold, only its consumer moved.
function gym(harnessSlug: string, enabled: boolean, spentUsd = 0): AutomationGymArm {
  return { harnessSlug, enabled, budgetUsd: null, spentUsd, status: 'idle' };
}
function lane(
  loopId: string,
  potSlug: string | null,
  enabled: boolean,
  spentUsd = 0,
): AutomationLaneArm {
  return {
    loopId,
    displayName: loopId,
    potSlug,
    enabled,
    budgetUsd: null,
    budgetKind: 'lifetime',
    spentUsd,
    enforcement: 'governor',
  };
}
function makeArming(over: Partial<AutomationArming> = {}): AutomationArming {
  return { gymPots: [], lanes: [], scoutCeiling: null, potScope: null, ...over };
}
const scope = (disabledPots: string[]): AutomationArming['potScope'] => ({
  disabledPots,
  rows: [],
});

/** The dropdown trigger — the chip is the lexicon's plural pot word now. */
function openDropdown() {
  fireEvent.click(screen.getByRole('button', { name: /Pots/ }));
}

function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  })) as unknown as typeof fetch;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  H.enabled = true;
  H.snap = makeSnap();
  // Default: no catalog row, so no verdict and no pot list — the pre-fold
  // shape, which keeps the loop-control contract tests about the loop control.
  H.arming = undefined;
  H.dreams = {};
  H.invalidate.fn = vi.fn();
  H.catalogInvalidate.fn = vi.fn();
  H.runTool.fn = vi.fn(async () => ({}));
  H.openDrawer.fn = vi.fn();
  H.openPicker.fn = vi.fn();
  fetchMock = okFetch() as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('<LearningLoopControl>', () => {
  it('renders nothing when the flag is off', () => {
    H.enabled = false;
    const { container } = render(<LearningLoopControl />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing before the snapshot arrives', () => {
    H.snap = undefined;
    const { container } = render(<LearningLoopControl />);
    expect(container.innerHTML).toBe('');
  });

  it('running: the chip is the pot dropdown and keeps today spend; button offers pause', () => {
    render(<LearningLoopControl />);
    expect(screen.getByRole('button', { name: /Pots/ })).toBeTruthy();
    // With no catalog row there is no verdict beside it, so the chip still
    // carries the spend rather than dropping it on the floor.
    expect(screen.getByText('$4.62')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pause all learning loops' })).toBeTruthy();
  });

  it('paused: root carries the paused class, dropdown says paused, button offers resume', () => {
    H.snap = makeSnap({ status: 'paused', activeCount: 0, heldCount: 16, pausedAtMs: Date.UTC(2026, 7, 16, 18, 57), pausedBy: 'su-23c9e' });
    const { container } = render(<LearningLoopControl />);
    expect(container.querySelector('.pc-lloop--paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume all learning loops' })).toBeTruthy();
    openDropdown();
    expect(screen.getByText('paused')).toBeTruthy();
  });

  it('uses the solid popover surface for the pause/resume dropdown', () => {
    render(<LearningLoopControl />);
    openDropdown();
    expect(screen.getByRole('dialog', { name: 'Learning loops' })).toBeTruthy();

    const styles = [...document.querySelectorAll('style')]
      .map((style) => style.textContent)
      .join('\n');
    const popoverRule = styles.match(/\.pc-lloop__pop\s*\{[^}]+\}/)?.[0];
    expect(popoverRule).toContain('background: var(--bg-popover)');
    expect(popoverRule).not.toContain('background: var(--bg-2)');
  });

  it('keeps the dropdown footer reachable when the window has limited space below it', () => {
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect);
    try {
      render(<LearningLoopControl />);
      openDropdown();
      const popover = screen.getByRole('dialog', { name: 'Learning loops' });
      expect(popover.style.maxHeight).toBe(`${window.innerHeight - 516}px`);
      bounds.mockReturnValue({ top: 600 } as DOMRect);
      fireEvent(window, new Event('resize'));
      expect(popover.style.maxHeight).toBe(`${window.innerHeight - 616}px`);
    } finally {
      bounds.mockRestore();
    }
  });

  it('pause sends routines:group-set { active:false, reason } through the gated bridge, then refetches', async () => {
    render(<LearningLoopControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause all learning loops' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agent-mcp/run-tool');
    const body = JSON.parse(String(init.body));
    expect(body.name).toBe('routines:group-set');
    expect(body.confirmed).toBe(true);
    expect(body.args).toEqual({
      group: 'self-improvement',
      active: false,
      reason: 'Paused from the Learning tab',
    });
    await waitFor(() => expect(H.invalidate.fn).toHaveBeenCalledTimes(1));
  });

  it('resume sends { active:true } — never activateAll, so deliberate holds stay held', async () => {
    H.snap = makeSnap({ status: 'paused', activeCount: 0, heldCount: 16 });
    render(<LearningLoopControl />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume all learning loops' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.args).toEqual({ group: 'self-improvement', active: true });
    expect(body.args.activateAll).toBeUndefined();
  });

  it('a refused bridge call surfaces as the popover error', async () => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, message: 'group-set refused: reason required' }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal('fetch', fetchMock);
    render(<LearningLoopControl />);
    // Open the popover so the error paragraph has somewhere to render.
    openDropdown();
    fireEvent.click(screen.getByRole('button', { name: 'Pause all learning loops' }));
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('group-set refused');
    });
    expect(H.invalidate.fn).not.toHaveBeenCalled();
  });

  // ── the pot rail, folded in (owner ask 2026-09-07) ──────────────────────
  //
  // The defect this replaced: seven chips all reading "learning off" through a
  // dashed border and 62% opacity, with nothing to compare against — so the one
  // fact that mattered was invisible. These pin that it is now stated in WORDS,
  // and that folding the rail in did not lose a control.
  describe('the pot verdict and list', () => {
    it('places Dreaming beside Learning and writes only the selected pot automatic setting', async () => {
      H.arming = makeArming({ gymPots: [gym('alpha', true), gym('beta', true)], potScope: scope([]) });
      for (const potSlug of ['alpha', 'beta']) H.dreams[potSlug] = {
        potSlug, automatic: { available: true, enabled: false }, blocker: null,
      };
      render(<LearningLoopControl />);
      openDropdown();
      expect(screen.getByRole('switch', { name: 'Switch off learning for alpha' })).toBeTruthy();
      fireEvent.click(screen.getByRole('switch', { name: 'Switch on dreaming for beta' }));
      await waitFor(() => expect(H.runTool.fn).toHaveBeenCalledWith('dream:control', { pot: 'beta', mode: 'auto', enabled: true }));
      expect(H.runTool.fn).toHaveBeenCalledTimes(1);
    });

    it('says nothing is learning, in words, when every pot scope is off', () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true), gym('beta', true)],
        potScope: scope(['alpha', 'beta']),
      });
      render(<LearningLoopControl />);
      expect(screen.getByText('Nothing is learning')).toBeTruthy();
      expect(screen.getByText(/0 of 2 on/)).toBeTruthy();
    });

    /** Learning is the group switch AND the pot's own scope — never either
     *  alone. A running group over switched-off scopes is still nothing. */
    it('reports nothing learning when the GROUP is paused even though scopes are on', () => {
      H.snap = makeSnap({ status: 'paused', activeCount: 0, heldCount: 16 });
      H.arming = makeArming({
        gymPots: [gym('alpha', true)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      expect(screen.getByText('Nothing is learning')).toBeTruthy();
      expect(screen.getByText(/1 pot paused/)).toBeTruthy();
    });

    it('counts the learning pots when the group runs and scopes are on', () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true), gym('beta', true)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      expect(screen.getByText('2 of 2 pots learning')).toBeTruthy();
    });

    it('keeps every figure reachable in the verdict tooltip when narrow windows drop them whole (WI-10006513)', () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true), gym('beta', true)],
        potScope: scope([]),
      });
      const { container } = render(<LearningLoopControl />);
      const verdict = container.querySelector<HTMLElement>('.pc-lloop__verdict');
      expect(verdict).toBeTruthy();
      const title = verdict!.getAttribute('title') ?? '';
      const figs = Array.from(container.querySelectorAll<HTMLElement>('.pc-lloop__fig')).map((el) =>
        (el.textContent ?? '').replace('·', '').trim(),
      );
      // Positive control: the strip rendered all three figures (pots, lanes, spend).
      expect(figs).toHaveLength(3);
      for (const fig of figs) {
        expect(fig.length).toBeGreaterThan(0);
        expect(title).toContain(fig);
      }
      expect(title).toContain('2 of 2 pots learning');
    });

    it("a row's switch writes that pot's SCOPE only, then refetches the catalog", async () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true)],
        lanes: [lane('lane-1', 'alpha', true)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      openDropdown();
      fireEvent.click(
        screen.getByRole('switch', { name: 'Switch off learning for alpha' }),
      );
      await waitFor(() => expect(H.runTool.fn).toHaveBeenCalledTimes(1));
      expect(H.runTool.fn).toHaveBeenCalledWith('learning:set-pot-scope', {
        pots: ['alpha'],
        enabled: false,
      });
      // Never a lane write: a lane's arming is its OWN state, so switching the
      // pot off must leave it untouched for the switch back on to restore.
      expect(H.runTool.fn).not.toHaveBeenCalledWith(
        'governor:arm',
        expect.anything(),
      );
      await waitFor(() =>
        expect(H.catalogInvalidate.fn).toHaveBeenCalledTimes(1),
      );
    });

    it("the pot name opens that pot's fields drawer — where the lane switches live", () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      openDropdown();
      fireEvent.click(
        screen.getByRole('button', { name: 'Open fields for alpha' }),
      );
      expect(H.openDrawer.fn).toHaveBeenCalledWith('alpha');
    });

    /** An unreadable scope cannot be drawn as a two-state switch without
     *  asserting a position we never read — but the WRITE is well-defined, so
     *  the row must stay operable rather than disabled-and-unrecoverable. */
    it('offers an explicit set action for an unreadable scope, not a switch', () => {
      H.arming = makeArming({ gymPots: [gym('alpha', true)], potScope: null });
      render(<LearningLoopControl />);
      openDropdown();
      expect(screen.queryByRole('switch', { name: /alpha/ })).toBeNull();
      expect(screen.getByText('set')).toBeTruthy();
    });

    it('renders a zero-spend pot as a dash, never as $0.00', () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true, 0), gym('beta', true, 12.5)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      openDropdown();
      expect(screen.queryByText('$0.00')).toBeNull();
      expect(screen.getByText('$12.50')).toBeTruthy();
    });

    it('keeps a route to every pot, including ones the rail model omits', () => {
      H.arming = makeArming({
        gymPots: [gym('alpha', true)],
        potScope: scope([]),
      });
      render(<LearningLoopControl />);
      openDropdown();
      fireEvent.click(screen.getByRole('button', { name: /See every pot/ }));
      expect(H.openPicker.fn).toHaveBeenCalledTimes(1);
    });
  });

  it('popover shows the spend rollup and the role breakdown labels', async () => {
    render(<LearningLoopControl />);
    openDropdown();
    expect(screen.getByRole('dialog', { name: 'Learning loops' })).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Last 7 days')).toBeTruthy();
    expect(screen.getByText('$17.93')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
    expect(screen.getByText('Gym')).toBeTruthy();
    expect(screen.getByText('Judges')).toBeTruthy();
  });
});
