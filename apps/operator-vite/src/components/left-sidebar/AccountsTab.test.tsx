// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  accounts: [] as unknown[],
  loading: false,
  error: null as Error | null,
  failureReason: null as Error | null,
  invalidate: vi.fn(),
  expanded: null as string | null,
  setExpanded: vi.fn(),
  forced: new Set<string>(),
  excluded: new Set<string>(),
  overrideBusy: false,
  toggleForce: vi.fn(),
  toggleExclude: vi.fn(),
  clearOverride: vi.fn(),
  defaultAccountId: undefined as string | undefined,
  setDefaultAccount: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: H.accounts, loading: H.loading, error: H.error, failureReason: H.failureReason, invalidate: H.invalidate }),
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsString: {},
  useQueryState: () => [H.expanded, H.setExpanded],
}));

// The panel moved to @papercusp/operator-ui (WI-2143109) and no longer imports a
// router or a toast library directly — it reads both from the host seam, whose
// DEFAULTS (a plain <a>, console toasts) are exactly what this suite wants. So
// there is nothing to mock here; the assertions below still exercise the real
// component, just through the path the portal also takes.
vi.mock('@papercusp/operator-ui/accounts/use-account-override', () => ({
  useAccountOverride: () => ({
    overrideBusy: H.overrideBusy,
    forced: H.forced,
    excluded: H.excluded,
    // The default is a SEPARATE axis and deliberately does NOT count as "steering active":
    // it does not restrict the pool (default-deploy-account-2026-08-08 D-003).
    overrideActive: H.forced.size > 0 || H.excluded.size > 0,
    toggleForce: H.toggleForce,
    toggleExclude: H.toggleExclude,
    clearOverride: H.clearOverride,
    defaultAccountId: H.defaultAccountId,
    setDefaultAccount: H.setDefaultAccount,
  }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AccountsTab from './AccountsTab';

const NOW = 1_800_000_000_000;
const ACCOUNT = {
  id: 'acct-opus-1',
  provider: 'claude',
  label: 'Opus Primary',
  credentialRef: 'file:/home/user/.claude/account.json',
  boundTo: ['papercup-hive'],
  available: true,
  sustainedlyLimited: false,
  edgeThrottleKnown: true,
  edgeThrottled: true,
  edgeThrottleCooledIps: 1,
  edgeThrottleBare429Streak: 2,
  rate: {
    pausedUntil: 0,
    lastPenaltyAt: 0,
    penaltyCount: 0,
    windowStartedAt: NOW - 60_000,
    utilization: 0.23,
    windowResetAt: NOW + 60 * 60_000,
    utilizationAt: NOW - 30_000,
    utilization7d: 0.61,
    windowResetAt7d: NOW + 3 * 86_400_000,
  },
  egress: { localAddress: '10.0.0.5' },
  liveBuckets: [{ key: 'anthropic:opus', provider: 'anthropic', modelClass: 'opus', paused: false, pausedUntil: 0 }],
};

const CODEX_ACCOUNT = {
  id: 'codex-main',
  provider: 'codex',
  label: 'Codex Primary',
  credentialRef: 'env:OPENAI_API_KEY',
  boundTo: [],
  available: true,
  sustainedlyLimited: false,
  rate: {
    pausedUntil: 0,
    lastPenaltyAt: 0,
    penaltyCount: 0,
    windowStartedAt: NOW - 30_000,
    utilization: 0.12,
    windowResetAt: NOW + 2 * 60 * 60_000,
    utilizationAt: NOW - 10_000,
  },
  liveBuckets: [{ key: 'openai:default', provider: 'openai', modelClass: 'default', paused: false, pausedUntil: 0 }],
};

beforeEach(() => {
  vi.setSystemTime(NOW);
  H.accounts = [ACCOUNT];
  H.loading = false;
  H.error = null;
  H.failureReason = null;
  H.invalidate.mockReset();
  H.expanded = null;
  H.setExpanded = vi.fn((next: string | null) => {
    H.expanded = next;
  });
  H.forced = new Set();
  H.excluded = new Set();
  H.overrideBusy = false;
  H.toggleForce = vi.fn();
  H.toggleExclude = vi.fn();
  H.clearOverride = vi.fn();
  H.defaultAccountId = undefined;
  H.setDefaultAccount = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('AccountsTab', () => {
  it('reports an unreadable pool and lets the reader retry instead of claiming it is empty', () => {
    H.accounts = [];
    H.error = new Error('operator_unreachable');
    render(<AccountsTab active />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load accounts');
    expect(screen.queryByText('No accounts in the pool yet.')).toBeNull();
    expect(screen.queryByText('0/0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(H.invalidate).toHaveBeenCalledOnce();
  });

  it('reports failed attempts while the transport is still retrying', () => {
    H.accounts = [];
    H.loading = true;
    H.failureReason = new Error('operator_timeout');
    render(<AccountsTab active />);
    expect(screen.getByRole('alert').textContent).toContain('Could not load accounts');
    expect(screen.queryByText('No accounts in the pool yet.')).toBeNull();
  });

  it('keeps previously loaded rows visible while declaring a refresh failure', () => {
    H.error = new Error('operator_unreachable');
    render(<AccountsTab active />);
    expect(screen.getByText('Opus Primary')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Showing previously loaded accounts');
  });

  it('claims an empty pool only after a successful empty read', () => {
    H.accounts = [];
    render(<AccountsTab active />);
    expect(screen.getByText('No accounts in the pool yet.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the compact pool summary, row facts, usage meters, and steering actions', () => {
    render(<AccountsTab active />);

    expect(screen.getByText('spawn account pool')).toBeTruthy();
    expect(screen.getAllByText('avail').length).toBeGreaterThan(0);
    expect(screen.getByText('1/1')).toBeTruthy();
    expect(screen.getByText('Opus Primary')).toBeTruthy();
    expect(screen.getByLabelText('Available')).toBeTruthy();
    expect(screen.getByText('file:…/account.json')).toBeTruthy();
    expect(screen.getByText('1 bound')).toBeTruthy();
    expect(screen.getByText('1 bucket')).toBeTruthy();
    expect(screen.getByText('egress')).toBeTruthy();
    expect(screen.getByText('edge throttle')).toBeTruthy();
    expect(screen.getByLabelText(/5h usage ~23%/)).toBeTruthy();
    expect(screen.getByLabelText(/7d usage ~61%/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Force only acct-opus-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Exclude acct-opus-1' })).toBeTruthy();
  });

  it('renders Codex provider accounts with OpenAI-compatible usage wording', () => {
    H.accounts = [CODEX_ACCOUNT];
    H.expanded = 'codex-main';

    render(<AccountsTab active />);

    expect(screen.getByText('Codex Primary')).toBeTruthy();
    expect(screen.getAllByText('Codex').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/OpenAI usage ~12%/)).toBeTruthy();
    expect(screen.getByText('OpenAI window')).toBeTruthy();
    expect(screen.getByText('Long window')).toBeTruthy();
    expect(screen.getByText('openai/default')).toBeTruthy();
    expect(screen.getByText(/Codex rows show OpenAI-compatible route usage/)).toBeTruthy();
  });

  it('surfaces session steering and expanded account detail', () => {
    H.forced = new Set(['acct-opus-1']);
    H.expanded = 'acct-opus-1';

    render(<AccountsTab active />);

    expect(screen.getByText('Session steering active')).toBeTruthy();
    expect(screen.getByText('forced')).toBeTruthy();
    expect(screen.getByText('Bound to')).toBeTruthy();
    expect(screen.getByText('papercup-hive')).toBeTruthy();
    expect(screen.getByText('anthropic/opus')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop forcing acct-opus-1' }));
    expect(H.toggleForce).toHaveBeenCalledWith('acct-opus-1');
  });
});

describe('AccountsTab — the default account (default-deploy-account-2026-08-08 P-006)', () => {
  it('with NO default set, says so and names what is being used instead', () => {
    // "No default" is a real, deliberate state (the box's own login), not an empty placeholder —
    // so the summary has to answer "what am I on right now?", not just stay blank.
    render(<AccountsTab active />);
    expect(screen.getByText(/No default/)).toBeTruthy();
    expect(screen.getByText(/~\/\.claude/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make acct-opus-1 the default Claude account' })).toBeTruthy();
  });

  it('marking a default sends the account id', () => {
    render(<AccountsTab active />);
    fireEvent.click(screen.getByRole('button', { name: 'Make acct-opus-1 the default Claude account' }));
    expect(H.setDefaultAccount).toHaveBeenCalledWith('acct-opus-1');
  });

  it('the star is a TOGGLE — clicking the current default clears it with null', () => {
    // null, not '' or the id again: clearing is the D-002 escape hatch back to ~/.claude, and
    // the store treats null (clear) and omission (keep) as different things.
    H.defaultAccountId = 'acct-opus-1';
    render(<AccountsTab active />);
    const star = screen.getByRole('button', { name: 'Clear acct-opus-1 as the default account' });
    expect(star.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(star);
    expect(H.setDefaultAccount).toHaveBeenCalledWith(null);
  });

  it('summarises WHICH account is default and that traffic still fails over past it', () => {
    H.defaultAccountId = 'acct-opus-1';
    render(<AccountsTab active />);
    expect(screen.getByText('★ acct-opus-1')).toBeTruthy();
    expect(screen.getByText(/starts here, then fails over/)).toBeTruthy();
  });

  it('is NOT optimistic — the button reflects the server value, not the click', () => {
    // The write is a patch + sync invalidate, so the row must stay unpressed until the server
    // round-trip lands. An optimistic flip here would show a default that may not have been
    // accepted (setDefaultAccount still rejects an UNKNOWN id at the write — provider is no
    // longer a rejection reason as of P-003).
    render(<AccountsTab active />);
    const star = screen.getByRole('button', { name: 'Make acct-opus-1 the default Claude account' });
    fireEvent.click(star);
    expect(H.setDefaultAccount).toHaveBeenCalledTimes(1);
    expect(star.getAttribute('aria-pressed')).toBe('false');
    expect(star.textContent).toContain('☆');
    expect(screen.getByText(/No default/)).toBeTruthy();
  });

  it('a CODEX row DOES offer the default control', () => {
    // Inverted by inference-rename-and-provider-agnostic-default-2026-08-09 P-003. The server
    // used to reject a Codex default by name and the UI never offered it; a default is now a
    // per-provider primary (D-002), so the control is real on a Codex row too.
    H.accounts = [CODEX_ACCOUNT];
    render(<AccountsTab active />);
    expect(screen.getByRole('button', { name: 'Make codex-main the default Codex/OpenAI account' })).toBeTruthy();
  });

  it('offers the control on BOTH rows of a mixed pool, labelled per provider', () => {
    // The label carries the provider because the two defaults do DIFFERENT things — picking the
    // Codex row does not steer Anthropic traffic. A bare "the default account" on both rows
    // would read as one setting with two conflicting controls.
    H.accounts = [ACCOUNT, CODEX_ACCOUNT];
    render(<AccountsTab active />);
    expect(screen.getAllByRole('button', { name: /the default .* account/i }).map((b) => b.getAttribute('aria-label'))).toEqual(
      ['Make acct-opus-1 the default Claude account', 'Make codex-main the default Codex/OpenAI account'],
    );
  });

  it('disables the control while an override write is in flight', () => {
    H.overrideBusy = true;
    render(<AccountsTab active />);
    expect(screen.getByRole('button', { name: 'Make acct-opus-1 the default Claude account' }).hasAttribute('disabled')).toBe(true);
  });

  it('a default alone does not read as "session steering active" (it restricts nothing)', () => {
    H.defaultAccountId = 'acct-opus-1';
    render(<AccountsTab active />);
    expect(screen.queryByText('Session steering active')).toBeNull();
  });
});
