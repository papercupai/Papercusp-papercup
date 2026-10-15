import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

const fixture = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: fixture.rows, loading: false, invalidate: vi.fn() }) }));
vi.mock('nuqs', () => ({ parseAsString: {}, useQueryState: () => [null, vi.fn()] }));
vi.mock('./use-account-override', () => ({ useAccountOverride: () => ({
  overrideBusy: false, forced: new Set(), excluded: new Set(), overrideActive: false,
  toggleForce: vi.fn(), toggleExclude: vi.fn(), clearOverride: vi.fn(), setDefaultAccount: vi.fn(),
}) }));
vi.mock('../seam', () => ({ operatorUi: () => ({ Link: ({ to, children, ...props }: any) => createElement('a', { href: to, ...props }, children) }) }));
import AccountsTab from './AccountsTab';

const row = (id: string, provider: 'claude' | 'codex', credentialRef: string, amount?: number) => ({
  id, provider, credentialRef, boundTo: [], available: true, sustainedlyLimited: false, liveBuckets: [],
  rate: { pausedUntil: 0, ...(amount !== undefined ? { creditBalance: {
    amount, unit: provider === 'codex' ? 'credits' : 'USD', source: provider === 'codex' ? 'codex' : 'claude-console', observedAt: Date.now(),
  } } : {}) },
});
beforeEach(() => { fixture.rows = []; });

describe('account sidebar balances', () => {
  it('renders numeric Codex and Claude API balances in compact rows and separate totals', () => {
    fixture.rows = [row('codex', 'codex', 'codex-cli:/private/codex', 1000), row('api', 'claude', 'apikey:env:SECRET_KEY', 12.34)];
    const html = renderToStaticMarkup(<AccountsTab active={false} />);
    expect(html).toContain('Codex: 1,000.00 credits');
    expect(html).toContain('Claude API: $12.34');
    expect(html).toContain('aria-label="Credit balance for codex"');
    expect(html).toContain('aria-label="Credit balance for api"');
    expect(html).not.toContain('/private/');
  });

  it('shows an unavailable API balance with a billing link rather than a fabricated zero', () => {
    fixture.rows = [row('api', 'claude', 'apikey:env:SECRET_KEY')];
    const html = renderToStaticMarkup(<AccountsTab active={false} />);
    expect(html).toContain('Claude API: balance unavailable');
    expect(html).toContain('Credit balance unavailable');
    expect(html).toContain('https://platform.claude.com/settings/billing');
    expect(html).not.toContain('$0.00');
  });
});
