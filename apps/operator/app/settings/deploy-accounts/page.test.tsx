// @vitest-environment jsdom
/**
 * Deploy accounts settings — the default-account banner + clear control
 * (default-deploy-account-2026-08-08 P-006).
 *
 * Scoped to the default axis on purpose. The banner is this page's answer to the question the
 * plan exists to make answerable — "which account is everything actually running on right
 * now?" — and it has THREE states, not two: an account, no account (the box's own ~/.claude
 * login), and not-yet-known. Collapsing the third into the second would have the page state
 * a routing fact it has not established, which is the failure mode worth a test.
 *
 * The grid is stubbed out: per-row controls are exercised through the shared AccountsTab suite,
 * and rendering RichGrid here would couple this to the whole account-row projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

// vi.mock is hoisted above every top-level const, so the spies have to be hoisted with it.
const H = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), query: {} as Record<string, unknown> }));
const toastError = H.toastError;
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: H.toastSuccess, error: H.toastError, message: vi.fn() }),
}));
vi.mock('nuqs', async () => {
  const { useState } = await import('react');
  return {
    useQueryState: (key: string, parser?: { defaultValue?: unknown }) => useState(H.query[key] ?? parser?.defaultValue ?? null),
    parseAsBoolean: { withDefault: (d: unknown) => ({ defaultValue: d }) },
    parseAsString: { withDefault: (d: unknown) => ({ defaultValue: d }) },
  };
});
vi.mock('@papercusp/grid-core', () => ({ RichGrid: () => <div data-testid="grid" /> }));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }),
}));

import DeployAccountsPage from './page';

// The fixture is NOT optional-tolerant, and the failure is disproportionate: AccountCard renders
// once per account OUTSIDE the stubbed grid, and reads `boundTo.length` (page.tsx:974) and
// `rate.pausedUntil` (accountStatusText) straight off the row. A row missing either throws during
// render, React unmounts the WHOLE tree with no error boundary, and every case then fails with a
// perfectly plausible "banner never rendered" — the assertion text names the banner while the real
// cause is the fixture. The runner tells the truth on a separate line: read `⚠⚠ UNHANDLED ERROR …
// message=` before believing any assertion in this file.
const ACCOUNTS = [
  {
    id: 'aviynw6',
    provider: 'claude',
    credentialRef: 'token:/a',
    boundTo: [],
    rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0 },
  },
];

/** The banner is `role="status"`; scope id assertions to it — the card list renders the id too. */
const banner = () => within(screen.getByRole('status'));

/** Serve the page's three GETs; `defaultOverride` drives the axis under test. */
function stubFetch(opts: { defaultOverride?: unknown; overrideFails?: boolean; post?: unknown; accounts?: typeof ACCOUNTS } = {}) {
  const post = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('session-override')) {
        if (init?.method === 'POST') {
          post(JSON.parse(String(init.body)));
          return { ok: true, json: async () => opts.post ?? { ok: true, override: {} } } as Response;
        }
        if (opts.overrideFails) throw new Error('gateway unreachable');
        return { ok: true, json: async () => ({ ok: true, override: opts.defaultOverride ?? {} }) } as Response;
      }
      if (url.includes('inference-gateway/stats')) return { ok: true, json: async () => ({ ok: false }) } as Response;
      return { ok: true, json: async () => ({ ok: true, accounts: opts.accounts ?? ACCOUNTS }) } as Response;
    }),
  );
  return { post };
}

beforeEach(() => { H.query = {}; });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('Deploy accounts — browser login completion', () => {
  function loginFetch(status: 'completed' | 'unknown') {
    stubFetch();
    const read = globalThis.fetch;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/link-start')) return {
        status: 200,
        json: async () => ({ ok: true, authorizeUrl: 'https://provider.example/login', linkId: 'private-link', userCode: 'ABCD-12345' }),
      } as Response;
      if (url.endsWith('/link-status')) return { status: 200, json: async () => ({ ok: true, status }) } as Response;
      return read(input, init);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it.each(['Claude', 'Codex'])('observes %s approval without a manual Complete link click', async (provider) => {
    H.query = { add: true, id: 'pc-proof' };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fetch = loginFetch('completed');
    render(<DeployAccountsPage />);
    if (provider === 'Codex') fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get authorize link' }));
    await screen.findByRole('link', { name: /open the/ });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(H.toastSuccess).toHaveBeenCalledWith(`${provider} account "pc-proof" linked via browser login`);
    expect(screen.queryByText('Link an account')).toBeNull();
    expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/link-complete'))).toBe(false);
  });

  it('shows an expired link and makes a new login available after a workspace restart', async () => {
    H.query = { add: true, id: 'pc-proof' };
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    loginFetch('unknown');
    render(<DeployAccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Get authorize link' }));
    await screen.findByRole('link', { name: /open the/ });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText(/The login link expired or the workspace restarted/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get authorize link' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /open the/ })).toBeNull();
  });
});

describe('Inference — Anthropic API-key accounts', () => {
  it('submits the Anthropic workspace ID with a user-scoped key', async () => {
    H.query = { add: true, id: 'user-api' };
    stubFetch();
    render(<DeployAccountsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Anthropic API key' }));
    fireEvent.change(screen.getByLabelText('3 · Anthropic API key'), { target: { value: ['sk', 'ant', 'usr', 'fixture'].join('-') } });
    fireEvent.change(screen.getByLabelText(/Anthropic workspace ID/), { target: { value: 'wrkspc_selected' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/register'))).toBe(true));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/register'))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ credentialType: 'api-key', anthropicWorkspaceId: 'wrkspc_selected' });
  });

  it('offers a private API-key entry beside subscription login and posts the explicit credential type', async () => {
    H.query = { add: true, id: 'console-api' };
    stubFetch();
    const read = globalThis.fetch;
    const register = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }) as Response);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/register') ? register(input, init) : read(input, init)));
    render(<DeployAccountsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Anthropic API key' }));
    expect(screen.getByText(/billed separately from a Claude Max subscription/)).toBeTruthy();
    expect(screen.getByText(/when no subscription account has included allowance/)).toBeTruthy();
    const key = screen.getByLabelText('3 · Anthropic API key');
    expect(key.getAttribute('type')).toBe('password');
    fireEvent.change(key, { target: { value: 'sk-ant-api03-test-console-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(register).toHaveBeenCalled());
    const [, init] = register.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      accountId: 'console-api', provider: 'claude', credentialType: 'api-key', value: 'sk-ant-api03-test-console-key',
    });
    await waitFor(() => expect(screen.queryByLabelText('3 · Anthropic API key')).toBeNull());
  });

  it('clears a secret when switching credential modes or providers', async () => {
    H.query = { add: true, id: 'console-api' };
    stubFetch();
    render(<DeployAccountsPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Anthropic API key' }));
    fireEvent.change(screen.getByLabelText('3 · Anthropic API key'), { target: { value: 'sk-ant-api03-secret' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Paste a setup-token' }));
    expect((screen.getByRole('textbox', { name: /Paste the token/ }) as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('tab', { name: 'Anthropic API key' }));
    expect((screen.getByLabelText('3 · Anthropic API key') as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(screen.queryByRole('tab', { name: 'Anthropic API key' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Get authorize link' })).toBeTruthy();
  });

  it('labels API accounts as paid credits in the account list', async () => {
    stubFetch({ accounts: [{ ...ACCOUNTS[0], id: 'console-api', credentialRef: 'apikey:file:/private/console-api' }] });
    render(<DeployAccountsPage />);
    expect(await screen.findByText('Anthropic API · paid credits')).toBeTruthy();
  });
});

describe('Deploy accounts — default-account banner (P-006)', () => {
  it('names the account in force, and says traffic still fails over past it', async () => {
    stubFetch({ defaultOverride: { defaultAccountId: 'aviynw6' } });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    expect(banner().getByText('aviynw6')).toBeTruthy();
    expect(screen.getByText(/fail over to the rest of the pool/)).toBeTruthy();
  });

  it('with NO default, names what is being used instead rather than going blank', async () => {
    // "No default" is a real routing state, not an empty one — before this feature the honest
    // answer ("this box's own login") appeared nowhere on the page at all.
    stubFetch({ defaultOverride: {} });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/No default account/)).toBeTruthy());
    expect(screen.getByText('~/.claude')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull(); // nothing to clear
  });

  it('a FAILED override read shows NOTHING rather than claiming "no default"', async () => {
    // The distinction that matters: unknown ≠ none. Coercing a failed read to null would make
    // the page assert the machine is on its own ~/.claude login when it may well be on a pool
    // account — a confident, wrong answer to the one question this banner exists to answer.
    // Falsifiability checked 2026-09-05: feeding this case a SUCCESSFUL read of null (the coercion
    // the page deliberately avoids) makes it fail on the "~/.claude" span — so the null-assertions
    // below discriminate unknown-from-none rather than passing vacuously. The getByTestId('grid')
    // line is what stops them passing when the page renders nothing at all.
    stubFetch({ overrideFails: true });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy()); // page finished loading
    expect(screen.queryByText(/No default account/)).toBeNull();
    expect(screen.queryByText(/Default account:/)).toBeNull();
  });

  it('Clear posts an explicit null (the D-002 way back to ~/.claude)', async () => {
    // null, not '' or a missing key: the store treats null (clear) and omission (keep) as
    // different things, so an omitted field here would silently leave the default in place.
    const { post } = stubFetch({ defaultOverride: { defaultAccountId: 'aviynw6' }, post: { ok: true, override: {} } });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(post).toHaveBeenCalledWith({ defaultAccountId: null }));
    await waitFor(() => expect(screen.getByText(/No default account/)).toBeTruthy());
  });

  it('re-reads the server’s answer instead of trusting the click', async () => {
    // The write can change more than this one field, and the server validates the pick — so the
    // banner must reflect what came BACK, not what was sent. Here the server reports a different
    // account than the clear that was requested; the banner must follow the server.
    const { post } = stubFetch({
      defaultOverride: { defaultAccountId: 'aviynw6' },
      post: { ok: true, override: { defaultAccountId: 'aviynw2' } },
    });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(banner().getByText('aviynw2')).toBeTruthy());
  });

  it('surfaces the server’s own rejection reason, and leaves the banner alone', async () => {
    stubFetch({
      defaultOverride: { defaultAccountId: 'aviynw6' },
      post: { ok: false, error: "account 'codex-main' is a Codex account." },
    });
    render(<DeployAccountsPage />);
    await waitFor(() => expect(screen.getByText(/Default account:/)).toBeTruthy());
    screen.getByRole('button', { name: 'Clear' }).click();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("account 'codex-main' is a Codex account."));
    expect(banner().getByText('aviynw6')).toBeTruthy(); // unchanged by the failed write
  });
});
