/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsLocalKey } from '@papercusp/operator-core/lib/browser-workspace';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OperatorChatSidebar } from '../OperatorChatSidebar';
import { OPERATOR_CHAT_COLLAPSED_WIDTH } from '../operator-chat-layout';

// WI-5358: this file's many `waitFor(() => expect(body.classList...))` checks
// wait on a two-effect hydration chain (mount → setHydrated(true) → the
// CSS-var/classList effect). @testing-library/dom's waitFor defaults to a
// 1000ms real-wall-clock poll timeout — plenty under normal conditions, but
// on a heavily-loaded shared dev box (100+ concurrent agents, forks-pool
// green-checkpoint runs) genuine event-loop scheduling delay can exceed that
// even though the actual work is trivial. Raise the file-scoped default so a
// real system-load spike doesn't read as a spurious CSS/layout regression —
// this widens the wait window only; it does not touch what any assertion
// checks (module-scoped via @testing-library/dom's `configure`, so it is
// isolated to this file under vitest's per-file module registry).
configure({ asyncUtilTimeout: 5000 });

/* hud-open-destinations-and-true-counts-2026-07-27 P-003: the drill-in now
   opens the work-item/plan POPUPS by writing their nuqs params (`wpop`/`wppop`,
   owned by OperatorChat) rather than always navigating. The nuqs mock therefore
   has to be observable — record every write so a test can assert WHICH popup
   opened, the same way routerPushSpy asserts a navigation. */
const nuqsWrites = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    parseAsBoolean: {
      withDefault(defaultValue: boolean) {
        return { defaultValue };
      },
    },
    parseAsString: {
      withDefault(defaultValue: string) {
        return { defaultValue };
      },
    },
    parseAsStringEnum(_values: string[]) {
      return {
        withDefault(defaultValue: string) {
          return { defaultValue };
        },
      };
    },
    useQueryState(key: string, parser?: { defaultValue?: boolean | string }) {
      const [value, setValue] = React.useState(parser?.defaultValue ?? true);
      const set = React.useCallback(
        (next: unknown) => {
          nuqsWrites.current[key] = next;
          setValue(next as never);
        },
        [key],
      );
      return [value, set];
    },
    useQueryStates(spec: Record<string, { defaultValue?: unknown }>) {
      const [state, setState] = React.useState(() =>
        Object.fromEntries(Object.entries(spec).map(([k, p]) => [k, p?.defaultValue])),
      );
      return [state, setState];
    },
  };
});

/* The conversation's loaded messages. Mutable because D-031 made them
   LOAD-BEARING for data fetching, not just rendering: the sidebar gates its
   attention-refs query on whether any loaded message carries a card row whose
   ref needs live items. A test about resolving such a ref must therefore also
   supply the message that would have rendered it — otherwise it asserts a state
   production cannot reach (a resolvable escalation ref with no card naming it).
   `withEscalationRef()` is that setup. */
const convState = vi.hoisted(() => ({ messages: [] as unknown[] }));
function withEscalationRef(ref = 'escalation:msg-9') {
  convState.messages = [
    {
      role: 'system',
      content: 'fleet status',
      report: { title: 'Fleet', plans: [{ title: 'p', items: [{ text: 'row', ref }] }] },
    },
  ];
}

vi.mock('../OperatorConversationProvider', () => ({
  useOperatorConversation: () => ({
    messages: convState.messages,
    busy: false,
    mode: 'active',
    bannerText: null,
    error: null,
    hasMoreEarlier: false,
    loadingEarlier: false,
    conversationId: 'conv-1',
    sendUserMessage: vi.fn(),
    generateIdeas: vi.fn(),
    loadEarlier: vi.fn(),
    answerChoice: vi.fn(),
  }),
}));

/* The ref the drill-in trigger fires. P-003 gave refs of different KINDS
   different destinations, so the ref can no longer be hardcoded — each test
   sets the one it is about. */
const drillState = vi.hoisted(() => ({ ref: 'wi:WI-1' }));

vi.mock('../OperatorChat', () => ({
  // hud-consolidation-2026-07-26 P-004: exposes onDrillIn so tests can fire a
  // curator card's drill-in and assert the destination it produces.
  // P-003 also asserts `harnessSlug` is actually PASSED — without it every
  // WI-/EI-/F- ref pill in the chat is inert (OperatorChat's own
  // handleWorkRefActivate returns early on a null harness).
  OperatorChat: ({
    onDrillIn,
    canDrillIn,
    harnessSlug,
  }: {
    onDrillIn?: (ref: string) => void;
    canDrillIn?: (ref: string) => boolean;
    harnessSlug?: string | null;
  }) => (
    <div
      data-testid="operator-chat"
      data-harness={harnessSlug ?? ''}
      /* The openability predicate the sidebar hands ReportBlockCard, surfaced
         per ref-kind so a test can assert the button-visibility rule without
         rendering a whole curator report. */
      data-can-drill-wi={canDrillIn ? String(canDrillIn('wi:WI-1')) : ''}
      data-can-drill-plan={canDrillIn ? String(canDrillIn('plan:my-plan-2026-07-17')) : ''}
      data-can-drill-live-escalation={canDrillIn ? String(canDrillIn('escalation:msg-9')) : ''}
      data-can-drill-escalation={canDrillIn ? String(canDrillIn(drillState.ref)) : ''}
    >
      Operator chat
      {onDrillIn ? (
        <button
          type="button"
          data-testid="drill-in-trigger"
          onClick={() => onDrillIn(drillState.ref)}
        />
      ) : null}
    </div>
  ),
}));

vi.mock('@/app/adv/create/use-create-data', () => ({
  useResolvedHarnessSlug: () => 'papercusp',
}));

vi.mock('../chat/LocalCardHost', () => ({
  LocalCardHost: () => <div data-testid="local-card-host" />,
}));

vi.mock('@/lib/hotkeys', () => ({
  useShortcutAction: () => undefined,
}));

vi.mock('@/lib/use-workspace-id', () => ({
  useWorkspaceId: () => 'ws-test',
}));

vi.mock('../OperatorLogoMark', () => ({
  OperatorLogoMark: ({ className }: { className?: string }) => <span className={className}>Logo</span>,
}));

vi.mock('../OperatorWordmarkLockup', () => ({
  OperatorWordmarkLockup: ({ className, titleClassName, title }: { className?: string; titleClassName?: string; title?: string }) => (
    <div className={className}>
      <strong className={titleClassName}>{title ?? 'Papercup'}</strong>
    </div>
  ),
}));

vi.mock('@/lib/useLexicon', () => ({
  useLexicon: () => (key: string) => (key === 'brain' ? 'Mug' : key === 'overwatch' ? 'Kettle' : 'Papercup'),
  useLexiconPackId: () => 'classic',
}));

const voiceModeState = { muted: false };
const setVoiceOutputMutedSpy = vi.fn();
const readingState = { readingId: null as string | null, status: 'idle', position: 0, total: 0, warnings: [] as string[] };
const startReadingSpy = vi.fn();
const controlReadingSpy = vi.fn();
vi.mock('../voice/voice-mode', () => ({
  isVoiceOutputMuted: () => voiceModeState.muted,
  setVoiceOutputMuted: (v: boolean) => setVoiceOutputMutedSpy(v),
  getReadingState: () => ({ ...readingState }),
  subscribeReadingState: () => () => {},
  startReading: (...args: unknown[]) => startReadingSpy(...args),
  controlReading: (...args: unknown[]) => controlReadingSpy(...args),
}));

vi.mock('../OperatorActiveToggle', () => ({
  OperatorActiveToggle: () => <button type="button">Active</button>,
}));

vi.mock('../voice/VoiceButton', () => ({
  VoiceButton: () => <button type="button">Voice</button>,
}));
const inboxState = {
  pending: 0,
  plansNeedingYou: 0,
  // WI-39779: the server's attention read degraded (8s deadline fired), so the
  // counts above are its empty fallback rather than a real answer.
  degraded: false,
  items: [] as unknown[],
};
vi.mock('../inbox/use-inbox-pending', () => ({
  useInboxPendingCount: () => inboxState.pending,
  // owner-plans-single-pane-2026-07-17: the sidebar now also reads the
  // plans-needing-you count for the Plans face badge.
  usePlansNeedingYouCount: () => inboxState.plansNeedingYou,
  useAttentionCountsDegraded: () => inboxState.degraded,
}));
// WI-5342: the sidebar reads the live attention items so a curator card's
// drill-in can resolve its ref against a real one. D-031 moved that read off
// the fat `useInboxAttention` feed onto the four-field `useAttentionRefs`
// projection — the rows the resolver actually matches on are identical, so the
// fixtures below are unchanged; only the hook being stubbed moved.
// `enabled` is captured so the gate itself is assertable, not just its result.
const attentionRefsCalls: boolean[] = [];
vi.mock('@/app/admin/plans/plans-api', () => ({
  useAttentionRefs: (enabled = true) => {
    attentionRefsCalls.push(enabled);
    return { items: enabled ? inboxState.items : [], loading: false };
  },
}));
vi.mock('../plans/PlansPane', () => ({
  default: () => <div data-testid="plans-pane-stub" />,
}));
vi.mock('../inbox/InboxPane', () => ({
  default: () => (
    <div data-testid="inbox-pane-stub">
      <button type="button" data-testid="inbox-discuss-stub" />
    </div>
  ),
}));
// hud-consolidation-2026-07-26 P-004: a curator card's drill-in now navigates
// (router.push) to the HUD tab instead of opening the retired Inbox pane.
const routerPushSpy = vi.fn();
vi.mock('@/lib/router-compat/navigation', () => ({
  useRouter: () => ({ push: routerPushSpy }),
}));

const localStorageState = new Map<string, string>();

function setViewportWidth(value: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  setViewportWidth(1440);
  voiceModeState.muted = false;
  inboxState.pending = 0;
  inboxState.plansNeedingYou = 0;
  inboxState.degraded = false;
  drillState.ref = 'wi:WI-1';
  convState.messages = [];
  attentionRefsCalls.length = 0;
  nuqsWrites.current = {};
  setVoiceOutputMutedSpy.mockReset();
  Object.assign(readingState, { readingId: null, status: 'idle', position: 0, total: 0, warnings: [] });
  startReadingSpy.mockReset(); controlReadingSpy.mockReset();
  routerPushSpy.mockReset();
  localStorageState.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => localStorageState.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageState.set(key, String(value));
      },
      removeItem: (key: string) => {
        localStorageState.delete(key);
      },
      clear: () => {
        localStorageState.clear();
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorageState.clear();
  document.body.className = '';
  document.body.style.cssText = '';
  document.documentElement.style.removeProperty('--op-chat-w');
  document.documentElement.style.removeProperty('--left-sidebar-w');
});

describe('body-shift commutation contract with the LeftSidebar rail (WI-4725)', () => {
  // The operator-vite LeftSidebar injects an equal-specificity
  // `body.has-left-sidebar { padding-left: calc(--op-chat-w + --left-sidebar-w) }`.
  // Cascade order between the two <style> tags is NOT a contract, so THIS
  // sidebar's shift rules must compute the identical full sum — an
  // op-chat-only padding here puts the rail on top of the main pane
  // (owner-reported overlap, 2026-07-13).
  it('the injected shift rules compose --left-sidebar-w (and --dev-rail-w on the header width)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const bodyRule = css.match(/body\.has-op-chat\s*\{[^}]*\}/)?.[0] ?? '';
    expect(bodyRule).toContain('var(--op-chat-w');
    expect(bodyRule).toContain('var(--left-sidebar-w, 0px)');
    const headerRule = css.match(/body\.has-op-chat \.pc-header\s*\{[^}]*\}/)?.[0] ?? '';
    expect(headerRule).toContain('var(--left-sidebar-w, 0px)');
    expect(headerRule).toMatch(/left:\s*calc\(var\(--left-sidebar-w, 0px\) \+ var\(--op-chat-w, 360px\)\)/);
    expect(headerRule).toContain('var(--dev-rail-w, 0px)');
    const sidebarRule = css.match(/\.op-chat-sidebar\s*\{[^}]*\}/)?.[0] ?? '';
    expect(sidebarRule).toContain('left: var(--left-sidebar-w, 0px)');
  });

  it('the fixed sidebar sits below the dev env-switcher bar (WI-4729 clipped header orb)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const sidebarRule = css.match(/\.op-chat-sidebar\s*\{[^}]*\}/)?.[0] ?? '';
    // top: 0 hides the header orb under the fixed EnvSwitcherBar — the rail
    // must use the published bar height, same as .pclsb/.pcdar/.pc-header.
    expect(sidebarRule).toContain('top: var(--pc-env-bar-h, 0px)');
  });

  it('keeps the header on ONE line: icon-only chat identity, controls hug the right, the mic never stretches (D-011)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Structure: the icon-only Papercup identity toggle, controls, and collapse toggle
    // are all DIRECT siblings on the single .op-chat-header-main row (no
    // title-row/copy column wrappers left to wrap onto a second line).
    const main = document.querySelector('.op-chat-header-main');
    expect(main).toBeTruthy();
    const childClasses = Array.from(main!.children).map((c) => c.className);
    expect(childClasses.some((c) => String(c).includes('op-chat-papercup-toggle'))).toBe(true);
    expect(childClasses.some((c) => String(c).includes('op-chat-controls'))).toBe(true);
    expect(document.querySelector('.op-chat-papercup-toggle .op-chat-wordmark')).toBeNull();
    expect(document.querySelector('.op-chat-header-copy')).toBeNull();
    expect(document.querySelector('.op-chat-header-title-row')).toBeNull();
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    // The mic's old flex:1 stretch is the "gigantic mic" the owner flagged —
    // pin the natural-size rule and the right-aligned control cluster.
    const voiceControlRule = css.match(/\.op-chat-controls \.pc-voice-control\s*\{[^}]*\}/)?.[0] ?? '';
    expect(voiceControlRule).toContain('flex: 0 0 auto');
    const controlsRule = css.match(/\.op-chat-controls\s*\{[^}]*\}/)?.[0] ?? '';
    expect(controlsRule).toContain('margin-left: auto');
  });

  it('the header identity is always the Papercup icon — no visible name or Mug/Kettle mark (D-011)', async () => {
    // Rail docked (the old WI-4739 trigger) → still Papercup: Papercup is the
    // one persona you talk to; the 🎯 toggle swaps the body for the pot's
    // goals / agents / throughput view instead.
    document.body.classList.add('has-left-sidebar');
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const papercup = screen.getByRole('button', { name: 'Papercup chat' });
    expect(papercup.querySelector('.op-chat-papercup-mark')).toBeTruthy();
    expect(papercup.querySelector('.op-chat-wordmark')).toBeNull();
    expect(screen.queryByText('Mug')).toBeNull();
    expect(document.querySelector('.op-chat-header-mark')).toBeNull();
  });

  it('the ambient Mug/Kettle status strip is GONE — the 🫖 toggle is the one entry (WI-4789)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // The old strip rendered a "Pot status — …" button under the header; the
    // owner asked for it removed once the toggle moved beside the identity.
    expect(screen.queryByRole('button', { name: /^Pot status/ })).toBeNull();
    expect(document.querySelector('.op-pot-status')).toBeNull();
  });

  it('the 🫖 toggle carries its own "Pot Health" label beside the icon-only Papercup identity (D-011)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const toggle = screen.getByRole('button', { name: 'Show pot health' });
    const label = toggle.querySelector('.op-chat-pot-toggle-label');
    expect(label?.textContent).toBe('Pot Health');
    // A DIRECT sibling immediately right of the Papercup identity toggle on the
    // single header row (WI-4793: the two pills are peers, Papercup leads).
    const main = document.querySelector('.op-chat-header-main');
    const kids = Array.from(main!.children).map((c) => String(c.className));
    const papercupIdx = kids.findIndex((c) => c.includes('op-chat-papercup-toggle'));
    const potIdx = kids.findIndex((c) => c.includes('op-chat-pot-toggle'));
    expect(potIdx).toBe(papercupIdx + 1);
  });

  it('the Papercup identity is an icon-only flat peer toggle, lit while chat shows, no raised orb (D-011)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // The icon carries the visible identity; the accessible name survives.
    const papercup = screen.getByRole('button', { name: 'Papercup chat' });
    expect(papercup.querySelector('.op-chat-wordmark')).toBeNull();
    expect(papercup.querySelector('.op-chat-papercup-mark')).toBeTruthy();
    // Chat is the default face → the Papercup pill is lit (is-on), the 🫖 isn't.
    expect(papercup.className).toContain('is-on');
    expect(papercup.getAttribute('aria-pressed')).toBe('true');
    const pot = screen.getByRole('button', { name: 'Show pot health' });
    expect(pot.className).not.toContain('is-on');
    // Both pills are driven by ONE shared base rule (not a bespoke raised orb),
    // and the old glowing 38px orb element/rules are gone.
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    expect(css).toContain('.op-chat-header-main .op-chat-papercup-toggle');
    expect(css).not.toContain('.op-chat-header-orb');
    expect(document.querySelector('.op-chat-header-orb')).toBeNull();
  });

  it('the Papercup toggle returns to the chat face from the pot view (WI-4793)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Open the pot view via the 🫖 toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Show pot health' }));
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Pot health' })).toBeTruthy();
    });
    // The Papercup pill is now unlit; clicking it brings the chat body back.
    const papercup = screen.getByRole('button', { name: 'Papercup chat' });
    expect(papercup.className).not.toContain('is-on');
    fireEvent.click(papercup);
    await waitFor(() => {
      expect(screen.getByTestId('operator-chat')).toBeTruthy();
    });
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();
  });

  it('the 🫖 toggle swaps the chat body for the full-height Pot Health view and back (WI-4778)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    // Default: the chat body renders, no pot-health region.
    expect(screen.getByTestId('operator-chat')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Show pot health' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);

    // 🫖 on: the pot view REPLACES the chat body (same pane, full height).
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Pot health' })).toBeTruthy();
    });
    expect(screen.queryByTestId('operator-chat')).toBeNull();
    const back = screen.getByRole('button', { name: 'Back to chat' });
    expect(back.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(back);

    await waitFor(() => {
      expect(screen.getByTestId('operator-chat')).toBeTruthy();
    });
    expect(screen.queryByRole('region', { name: 'Pot health' })).toBeNull();
  });

  it('reads a selection with explicit cloud consent', async () => {
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Selected exact source' } as Selection);
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Read selected text aloud' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read selection' }));
    expect(startReadingSpy).toHaveBeenCalledWith('Selected exact source', expect.objectContaining({ allowCloud: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow selected text to use cloud speech' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read selection' }));
    expect(startReadingSpy).toHaveBeenLastCalledWith('Selected exact source', expect.objectContaining({ allowCloud: true }));
    selection.mockRestore();
  });

  it('exposes saved progress with resume/stop controls for a paused reading', async () => {
    Object.assign(readingState, { readingId: 'reading-1', status: 'paused', position: 25, total: 100 });
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Read selected text aloud' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    expect(controlReadingSpy).toHaveBeenCalledWith('reading-1', 'resume');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(controlReadingSpy).toHaveBeenCalledWith('reading-1', 'stop');
    expect(screen.getByRole('progressbar', { name: 'Reading progress' }).getAttribute('value')).toBe('25');
  });
  it('summarizes without speaking and only reads an explicitly requested summary', async () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Original source with exact tail' } as Selection);
    const send = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ ok: true, summary: 'Explicit concise summary', coverage: { complete: false, warnings: ['source-partial'] } }));
    vi.stubGlobal('fetch', send);
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Read selected text aloud' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Summary length' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Short' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Summary focus' }), { target: { value: 'numbers' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow this text to use a cloud summary model' }));
    fireEvent.click(screen.getByRole('button', { name: /^Summarize$/ }));
    await screen.findByRole('region', { name: 'Summary' });
    expect(startReadingSpy).not.toHaveBeenCalled();
    const summaryCall = send.mock.calls.find(([url]) => url === '/api/agent-mcp/operator-tts')!;
    expect(JSON.parse(summaryCall[1]!.body as string)).toMatchObject({ operation: 'summarize', content: { text: 'Original source with exact tail', partial: true }, summary: { allowCloud: true, length: 'short', focus: 'numbers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Summarize and read' }));
    await waitFor(() => expect(startReadingSpy).toHaveBeenCalledWith('Explicit concise summary', expect.objectContaining({ allowCloud: false })));
  });
  it('cancels a summary request and ignores late output before it can speak', async () => {
    let finish!: (response: Response) => void;
    const summaryRequests: RequestInit[] = [];
    const send = vi.fn((url: unknown, init?: RequestInit) => {
      if (url !== '/api/agent-mcp/operator-tts') return Promise.resolve(Response.json({}));
      summaryRequests.push(init!);
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    vi.stubGlobal('fetch', send);
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByRole('button', { name: 'Read selected text aloud' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Text to read or summarize' }), { target: { value: 'Selected source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Summarize and read' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel summary' }));
    expect(summaryRequests[0]!.signal!.aborted).toBe(true);
    expect(screen.getByRole('status', { name: 'Summary status' }).textContent).toBe('Summary canceled.');
    await act(async () => { finish(Response.json({ ok: true, summary: 'Late obsolete summary', coverage: { complete: true, warnings: [] } })); });
    expect(startReadingSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
    expect(screen.getByRole('status', { name: 'Summary status' }).textContent).toBe('Summary canceled.');
    fireEvent.click(screen.getByRole('button', { name: /^Summarize$/ }));
    expect(screen.getByRole('status', { name: 'Summary status' }).textContent).toBe('Summarizing…');
    await act(async () => { finish(Response.json({ ok: true, summary: 'Fresh summary', coverage: { complete: true, warnings: [] } })); });
    expect(screen.queryByRole('status', { name: 'Summary status' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Summary' }).textContent).toContain('Fresh summary');
    expect(startReadingSpy).not.toHaveBeenCalled();
  });

  it('the TTS speak-responses mute lives on the chat bar: hydrates, flips + persists, re-syncs on broadcast (WI-4740)', async () => {
    voiceModeState.muted = false;
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const tts = await screen.findByRole('button', { name: 'Mute spoken voice replies' });
    expect(tts.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tts);
    expect(setVoiceOutputMutedSpy).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Unmute spoken voice replies' })).toBeTruthy();
    // Cross-tab broadcast re-sync (same event contract the middle bar had).
    fireEvent(window, new CustomEvent('papercusp:voiceOutputMutedChanged', { detail: { muted: false } }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute spoken voice replies' })).toBeTruthy();
    });
  });

  it('the compact-density avatar override keeps the agent mark readable (WI-4731)', async () => {
    // The sidebar's own !important density block WINS over globals.css'
    // .oracle-msg-avatar sizing — a globals-only bump silently does nothing
    // in this pane (live-verified 2026-07-13: computed 20px while globals
    // said 34px). Pin the operative override at the readable size so the
    // two-rule trap can't regress.
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const avatarRules = css.match(/\.op-chat-sidebar \.oracle-msg-avatar\s*\{[^}]*\}/g) ?? [];
    expect(avatarRules.length).toBeGreaterThan(0);
    const important = avatarRules.find((r) => r.includes('!important')) ?? '';
    expect(important).toContain('width: 30px !important');
    expect(important).toContain('height: 30px !important');
    const iconRule = css.match(/\.op-chat-sidebar \.oracle-msg-icon\s*\{[^}]*\}/)?.[0] ?? '';
    expect(iconRule).toContain('width: 18px !important');
  });

  it('narrow-width container queries free enough header-row space for the Pot Health / Papercup labels to render (EI-13551)', async () => {
    // jsdom has no layout engine (no @container evaluation, no real
    // getBoundingClientRect() widths — see the bug's own live-measured repro,
    // which required a real Tauri/browser layout), so this pins the CSS RULES
    // the fix depends on rather than a computed width. Two things regressed
    // silently before (both invisible to any test that only checks DOM
    // presence/computed display, per the bug's own root-cause note):
    //  1. the @container(max-width:480px) block that frees floor space by
    //     hiding the Inbox label + dropping the Fleet/Peers face pills
    //     entirely must still exist with those exact rules;
    //  2. its `.op-chat-header-main` gap override must appear AFTER (later in
    //     source than) the unconditional `gap: 9px !important` rule from the
    //     "Simplicity/readability pass" block — same specificity + importance,
    //     so an EARLIER-declared override is silently defeated by the later
    //     unconditional one. Re-ordering these back the wrong way is exactly
    //     the gotcha this guard exists to catch.
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');

    const narrowBlock = css.match(/@container op-chat \(max-width: 480px\) \{[\s\S]*?\n\}/g) ?? [];
    expect(narrowBlock.length).toBeGreaterThan(0);
    const joinedNarrowBlocks = narrowBlock.join('\n');
    expect(joinedNarrowBlocks).toMatch(/\.op-chat-header-main \.op-chat-inbox-toggle-label\s*\{[^}]*display:\s*none/);
    expect(joinedNarrowBlocks).toMatch(/\.op-chat-header-main \.op-chat-face-toggle\s*\{[^}]*display:\s*none/);
    expect(joinedNarrowBlocks).toMatch(/\.op-chat-header-main\s*\{[^}]*gap:\s*6px\s*!important/);

    // Ordering: the unconditional gap:9px rule must appear BEFORE the
    // container-scoped gap:6px override in source, or the cascade drops it.
    // (Two separate @container(max-width:480px) blocks exist in this file —
    // one for the Inbox/face-pill hiding, a second, LATER one solely for this
    // gap re-assertion — so pinpoint the block that actually carries the
    // header-main gap override rather than the first @container occurrence.)
    const unconditionalGapIdx = css.search(/\.op-chat-header-main\s*\{[^}]*gap:\s*9px\s*!important/);
    const gapOverrideBlock = narrowBlock.find((b) => /\.op-chat-header-main\s*\{[^}]*gap:\s*6px\s*!important/.test(b));
    expect(gapOverrideBlock).toBeTruthy();
    const narrowGapIdx = gapOverrideBlock ? css.indexOf(gapOverrideBlock) : -1;
    expect(unconditionalGapIdx).toBeGreaterThanOrEqual(0);
    expect(narrowGapIdx).toBeGreaterThanOrEqual(0);
    expect(narrowGapIdx).toBeGreaterThan(unconditionalGapIdx);
  });

  it('keeps plans and collapsed-rail badges readable against the light rose danger fill (EI-20188337255817233)', async () => {
    render(<OperatorChatSidebar />);
    await waitFor(() => {
      expect(document.body.classList.contains('has-op-chat')).toBe(true);
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const plansBadgeRule = css.match(/\.op-chat-inbox-badge\s*\{[^}]*\}/)?.[0] ?? '';
    const railBadgeRule = css.match(/\.op-chat-expand-rail \.op-chat-rail-badge\s*\{[^}]*\}/)?.[0] ?? '';

    expect(plansBadgeRule).toContain('background: var(--bad, #f87171)');
    expect(plansBadgeRule).toContain('color: var(--bg-deepest, #02060c)');
    expect(plansBadgeRule).not.toContain('color: #fff');
    expect(railBadgeRule).toContain('background: var(--bad, #f87171)');
    expect(railBadgeRule).toContain('color: var(--bg-deepest, #02060c)');
    expect(railBadgeRule).not.toContain('color: #fff');
  });
});

describe('OperatorChatSidebar collapse behavior', () => {
  it('collapses to a slim rail and can be expanded again', async () => {
    window.localStorage.setItem(wsLocalKey('papercusp.operatorChat.width'), '420');

    render(<OperatorChatSidebar />);

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('has-op-chat')).toBe(true);
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Collapse Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe(`${OPERATOR_CHAT_COLLAPSED_WIDTH}px`);
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Expand Papercup chat' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Papercup chat' }));

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });
    expect(document.body.classList.contains('op-chat-collapsed')).toBe(false);
  });

  it('auto-collapses on compact entry without rewriting ?chat and honors explicit re-expand', async () => {
    setViewportWidth(620);
    window.localStorage.setItem(wsLocalKey('papercusp.operatorChat.width'), '420');

    render(<OperatorChatSidebar />);

    await waitFor(() => {
      expect(document.querySelector('.op-chat-sidebar')?.getAttribute('data-collapsed')).toBe('true');
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe(`${OPERATOR_CHAT_COLLAPSED_WIDTH}px`);
    });
    expect(nuqsWrites.current.chat).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Papercup chat' }));
    await waitFor(() => {
      expect(document.querySelector('.op-chat-sidebar')?.getAttribute('data-collapsed')).toBe('false');
      expect(document.documentElement.style.getPropertyValue('--op-chat-w')).toBe('420px');
    });

    fireEvent.resize(window);
    expect(document.querySelector('.op-chat-sidebar')?.getAttribute('data-collapsed')).toBe('false');

    setViewportWidth(1440);
    fireEvent.resize(window);
    setViewportWidth(620);
    fireEvent.resize(window);
    await waitFor(() => {
      expect(document.querySelector('.op-chat-sidebar')?.getAttribute('data-collapsed')).toBe('true');
    });
  });
});
describe('Resolution Inbox face + attention drill-ins (owner-inbox-single-pane D-009/P-012)', () => {
  it('renders the Inbox toggle and keeps the inline Discuss flow inside that face', async () => {
    render(<OperatorChatSidebar />);
    const toggle = screen.getByTestId('op-chat-inbox-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    expect(await screen.findByTestId('inbox-pane-stub')).toBeTruthy();
    expect(screen.queryByTestId('operator-chat')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('inbox-discuss-stub'));
    expect(screen.getByTestId('inbox-pane-stub')).toBeTruthy();
    expect(screen.queryByTestId('operator-chat')).toBeNull();
  });

  it('still shows the live "needs you" badge (99+ cap) on the collapsed rail — the data layer keeps working', () => {
    inboxState.pending = 132;
    render(<OperatorChatSidebar />);
    expect(screen.getByTestId('op-chat-rail-badge').textContent).toBe('99+');
    expect(screen.getByTestId('op-chat-rail-badge').getAttribute('aria-label')).toBe('132 inbox items need you');
    expect(screen.getByTestId('op-chat-inbox-badge').textContent).toBe('99+');
  });

  /* WI-39779 — a timed-out attention read must not render as "nothing needs you".
     The server's 8s deadline falls back to an EMPTY feed, which derives to zero,
     and both badges render a zero by rendering NOTHING. So the failure mode is an
     ABSENCE: the user sees a clean sidebar and reasonably concludes nothing is
     waiting, when in truth the read never completed. These pin the disclosure at
     the surface the user actually looks at. */

  it('renders an indeterminate rail badge — not silence — when the attention read degraded', () => {
    inboxState.pending = 0;
    inboxState.degraded = true;
    render(<OperatorChatSidebar />);

    // Scoped by testid, not by label: BOTH badges carry the same degraded
    // label, so a label query is ambiguous by construction here.
    const badge = screen.getByTestId('op-chat-rail-badge');
    // The load-bearing assertion is that SOMETHING renders: a hidden badge is
    // exactly the silent "0 need you" this fixes.
    expect(badge.textContent).toBe('–');
    expect(badge.getAttribute('data-degraded')).toBe('true');
    expect(badge.getAttribute('aria-label')).toBe(
      'Could not load what needs you — this count is unavailable, not zero',
    );
  });

  it('marks the Plans badge indeterminate when the attention read degraded', () => {
    inboxState.plansNeedingYou = 0;
    inboxState.degraded = true;
    render(<OperatorChatSidebar />);

    const badge = screen.getByTestId('op-chat-plans-badge');
    expect(badge.textContent).toBe('–');
    expect(badge.getAttribute('data-degraded')).toBe('true');
  });

  it('does NOT claim degradation when the inbox is genuinely empty', () => {
    inboxState.pending = 0;
    inboxState.plansNeedingYou = 0;
    inboxState.degraded = false;
    render(<OperatorChatSidebar />);

    // A real zero still renders nothing — the pre-existing, correct behaviour.
    // Without this case, marking EVERY row degraded would pass the two above.
    expect(screen.queryByTestId('op-chat-plans-badge')).toBeNull();
    expect(screen.queryByTestId('op-chat-rail-badge')).toBeNull();
  });

  /* owner-inbox-single-pane P-013: a ref that matches a LIVE attention row
     opens the canonical Inbox and selects that row. Refs with no live Inbox
     row preserve the specific popup/HUD fallbacks. */

  it('a live escalation opens the canonical Inbox with that card selected', () => {
    drillState.ref = 'escalation:msg-9';
    withEscalationRef();
    inboxState.items = [
      { id: 'coord-escalation:msg-9', itemRef: null, planSlug: null, ownerAgentId: 'su-abc123' },
    ];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    expect(nuqsWrites.current.opcv).toBe('inbox');
    expect(nuqsWrites.current.opci).toBe('all');
    expect(nuqsWrites.current.opcis).toBe('coord-escalation:msg-9');
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('an explicit work-item ref keeps the popup fast-path when the attention-ref fetch is gated off', () => {
    drillState.ref = 'wi:WI-1';
    inboxState.items = [{ id: 'wi-1', itemRef: 'WI-1', planSlug: null, ownerAgentId: null }];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    // `wi:` resolves without the live attention projection, so D-031 keeps
    // that fetch disabled. Preserve the specific popup rather than paying the
    // app-wide read just to discover a duplicate Inbox destination.
    expect(nuqsWrites.current.wpop).toBe('papercusp::WI-1');
    expect(nuqsWrites.current.opcv).toBeUndefined();
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('a PLAN ref opens the plan popup instead of navigating', () => {
    drillState.ref = 'plan:my-plan-2026-07-17';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    // WI-6601: `wppop` now carries its harness too, like `wpop` — the single
    // root-level renderer can otherwise only fall back to the surface's
    // `?slug`, which is the wrong harness on a cross-harness mount.
    expect(nuqsWrites.current.wppop).toBe('papercusp::my-plan-2026-07-17');
    expect(routerPushSpy).not.toHaveBeenCalled();
  });

  it('a drill-in with no live match at all (e.g. health:<panelId>) still lands on the HUD board', () => {
    drillState.ref = 'health:some-panel';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    expect(routerPushSpy).toHaveBeenCalledWith('/adv?tab=hud&ws=ws-test&slug=papercusp');
  });

  /* Live-confirmed regression (2026-07-28): a drill-in that NAVIGATES used to
     push a bare `/adv?tab=hud[&hudsession=…]`, dropping `?ws` and `?slug`.
     Because `harnessSlug` resolves from `?slug`, the next work-item drill-in
     then failed the harness gate and fell through to the bare-HUD fallback —
     the exact visible no-op this plan fixes, reachable again in two clicks.
     These assert the CONTEXT survives a navigation, and that view state does
     not ride along with it. */
  it('a fallback HUD navigation carries workspace + harness context', () => {
    drillState.ref = 'health:some-panel';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    const href = routerPushSpy.mock.calls[0][0] as string;
    const params = new URLSearchParams(href.slice(href.indexOf('?')));
    expect(params.get('ws')).toBe('ws-test');
    expect(params.get('slug')).toBe('papercusp');
  });

  /* Caught on the DEPLOYED build 2026-07-28: the first cut of buildAdvHudHref
     re-derived `ws` from useWorkspaceId(), which snapshots its value ONCE at
     mount and had resolved to the literal 'default'. Clicking a drill-in on a
     URL carrying ?ws=papercusp-workspace therefore REWROTE it to ws=default —
     silently changing workspace identity, worse than the dropped param it was
     fixing. The live URL value must win; the hook is only a fallback. */
  it('carries the LIVE ?ws from the URL, never the mount-time hook snapshot', () => {
    const spy = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      search: '?ws=papercusp-workspace&slug=papercusp&tab=hud',
    } as Location);
    try {
      drillState.ref = 'health:some-panel';
      inboxState.items = [];
      render(<OperatorChatSidebar />);
      fireEvent.click(screen.getByTestId('drill-in-trigger'));
      const href = routerPushSpy.mock.calls[0][0] as string;
      const params = new URLSearchParams(href.slice(href.indexOf('?')));
      // The hook mock returns 'ws-test'; the URL says 'papercusp-workspace'.
      // The URL must win — otherwise a real workspace id gets overwritten.
      expect(params.get('ws')).toBe('papercusp-workspace');
      expect(params.get('slug')).toBe('papercusp');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the hook workspace/harness when the URL carries neither (the /quick-panel mount)', () => {
    drillState.ref = 'health:some-panel';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    const href = routerPushSpy.mock.calls[0][0] as string;
    const params = new URLSearchParams(href.slice(href.indexOf('?')));
    expect(params.get('ws')).toBe('ws-test');
    expect(params.get('slug')).toBe('papercusp');
  });

  /* [owner 2026-07-28] "if there is nothing to open there should be no open
     button". The predicate the sidebar hands ReportBlockCard must agree with
     what the click would actually do — same resolver, same items. */
  it('canDrillIn says NO for a ref that resolves to nothing (the dead-button case)', () => {
    // An escalation whose message is not in the live attention snapshot: the
    // exact shape the owner clicked on the fleet-status cards.
    drillState.ref = 'escalation:aged-out-msg';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    const chat = screen.getByTestId('operator-chat');
    expect(chat.getAttribute('data-can-drill-escalation')).toBe('false');
  });

  it('canDrillIn says YES for refs that DO open something (work item, plan, live escalation)', () => {
    withEscalationRef();
    inboxState.items = [
      { id: 'coord-escalation:msg-9', itemRef: null, planSlug: null, ownerAgentId: 'su-abc123' },
    ];
    render(<OperatorChatSidebar />);
    const chat = screen.getByTestId('operator-chat');
    expect(chat.getAttribute('data-can-drill-wi')).toBe('true');
    expect(chat.getAttribute('data-can-drill-plan')).toBe('true');
    expect(chat.getAttribute('data-can-drill-live-escalation')).toBe('true');
  });

  /* no-http-anywhere-2026-07-28 D-031 — the attention-refs fetch gate.
     ChromeShell mounts this sidebar on EVERY non-chromeless route, so an
     ungated read here is paid app-wide: measured 1,461 KB on :3055 (891 KB on
     :3270) on a git tab that renders no attention feed. These pin the gate
     itself, not just what it lets through. */
  it('does NOT fetch attention refs when no loaded message needs live items', () => {
    convState.messages = [];
    render(<OperatorChatSidebar />);
    expect(attentionRefsCalls).not.toHaveLength(0);
    expect(attentionRefsCalls.every((enabled) => enabled === false)).toBe(true);
  });

  it('still does NOT fetch when every card ref resolves without live items', () => {
    // `wi:` and `plan:` refs are answered by resolveRefDestination steps 1-2,
    // which never read `items` — so the feed cannot change their verdict.
    convState.messages = [
      {
        role: 'system',
        content: 'fleet status',
        report: {
          plans: [{ title: 'p', items: [{ text: 'a', ref: 'wi:papercusp#WI-1' }, { text: 'b', ref: 'plan:some-plan' }] }],
        },
      },
    ];
    render(<OperatorChatSidebar />);
    expect(attentionRefsCalls.every((enabled) => enabled === false)).toBe(true);
  });

  it('DOES fetch as soon as one card ref needs live items (an escalation)', () => {
    withEscalationRef();
    render(<OperatorChatSidebar />);
    expect(attentionRefsCalls.some((enabled) => enabled === true)).toBe(true);
  });

  it('a navigating drill-in does NOT drag view state (an open popup) across the navigation', () => {
    drillState.ref = 'health:some-panel';
    inboxState.items = [];
    render(<OperatorChatSidebar />);
    fireEvent.click(screen.getByTestId('drill-in-trigger'));
    const href = routerPushSpy.mock.calls[0][0] as string;
    expect(href).not.toContain('wpop');
    expect(href).not.toContain('wppop');
  });

  it('passes harnessSlug to OperatorChat — without it every chat ref pill is inert', () => {
    render(<OperatorChatSidebar />);
    expect(screen.getByTestId('operator-chat').getAttribute('data-harness')).toBe('papercusp');
  });

  // WI-5162 (owner ask 2026-07-17): the Fleet + Peers panes moved out of the
  // middle rail and into THIS sidebar, "to the right of the kettle button" —
  // the 🫖 Pot Health toggle. Their panes live in operator-vite and cannot be
  // imported up-layer, so they arrive as `faces` descriptors; these tests use
  // stand-ins for the same reason the real ones are injected.
  describe('extra faces (WI-5162)', () => {
    const faces = [
      {
        id: 'fleet',
        label: 'Fleet',
        tip: 'The fleet — live roster',
        icon: <span>F</span>,
        render: () => <div data-testid="pane-fleet" />,
      },
      {
        id: 'peers',
        label: 'Peers',
        tip: 'Peers — live voice/video channels',
        icon: <span>P</span>,
        render: () => <div data-testid="pane-peers" />,
      },
    ];

    it('renders the faces to the RIGHT of the 🫖 kettle button, in order', () => {
      render(<OperatorChatSidebar faces={faces} />);
      const row = document.querySelector('.op-chat-header-main')!;
      const pills = Array.from(row.querySelectorAll('button')).map((b) =>
        b.getAttribute('data-testid'),
      );
      const kettle = pills.findIndex((p) => p === null); // the 🫖 toggle carries no testid
      const fleet = pills.indexOf('op-chat-face-fleet');
      const peers = pills.indexOf('op-chat-face-peers');
      expect(fleet).toBeGreaterThan(-1);
      // Fleet then Peers, and both after the kettle toggle.
      expect(peers).toBe(fleet + 1);
      expect(fleet).toBeGreaterThan(kettle);
      // …and the built-in Plans + Inbox faces still lead the row.
      expect(pills.indexOf('op-chat-plans-toggle')).toBeLessThan(fleet);
      expect(pills.indexOf('op-chat-inbox-toggle')).toBeLessThan(fleet);
    });

    it('a face swaps the body for its pane and toggles back to the chat', async () => {
      render(<OperatorChatSidebar faces={faces} />);
      expect(screen.getByTestId('operator-chat')).toBeTruthy();

      fireEvent.click(screen.getByTestId('op-chat-face-fleet'));
      expect(await screen.findByTestId('pane-fleet')).toBeTruthy();
      expect(screen.queryByTestId('operator-chat')).toBeNull();
      expect(screen.getByTestId('op-chat-face-fleet').getAttribute('aria-pressed')).toBe('true');

      // Only ONE pane at a time — switching faces replaces, never stacks.
      fireEvent.click(screen.getByTestId('op-chat-face-peers'));
      expect(await screen.findByTestId('pane-peers')).toBeTruthy();
      expect(screen.queryByTestId('pane-fleet')).toBeNull();

      // Clicking the lit face returns to the chat (same contract as 🫖 / 📥).
      fireEvent.click(screen.getByTestId('op-chat-face-peers'));
      await waitFor(() => expect(screen.getByTestId('operator-chat')).toBeTruthy());
      expect(screen.queryByTestId('pane-peers')).toBeNull();
    });

    it('an unpicked face never mounts its pane (the sidebar is boot-critical)', () => {
      const render_ = vi.fn(() => <div data-testid="pane-fleet" />);
      render(<OperatorChatSidebar faces={[{ ...faces[0], render: render_ }]} />);
      expect(render_).not.toHaveBeenCalled();
    });

    it('drops a face whose id would shadow a built-in view', () => {
      render(
        <OperatorChatSidebar
          faces={[
            { ...faces[0], id: 'pot' },
            { ...faces[0], id: 'inbox' },
            { ...faces[1], id: 'peers' },
            { ...faces[1], id: 'peers' },
          ]}
        />,
      );
      // Built-in pot/inbox ids would fight their host toggles for ?opcv; the
      // duplicate peers id would light two pills. All collisions are dropped.
      expect(screen.queryByTestId('op-chat-face-pot')).toBeNull();
      expect(screen.queryByTestId('op-chat-face-inbox')).toBeNull();
      expect(screen.getAllByTestId('op-chat-face-peers')).toHaveLength(1);
    });

    it('renders the built-in faces unchanged when no faces are passed', () => {
      render(<OperatorChatSidebar />);
      expect(screen.getByTestId('op-chat-plans-toggle')).toBeTruthy();
      expect(screen.getByTestId('op-chat-inbox-toggle')).toBeTruthy();
      expect(screen.getByTestId('operator-chat')).toBeTruthy();
      expect(document.querySelector('.op-chat-face-toggle')).toBeNull();
    });
  });
});
