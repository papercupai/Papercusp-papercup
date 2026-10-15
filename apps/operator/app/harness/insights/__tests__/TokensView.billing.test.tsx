/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TokensDashboardSnapshot } from '@papercusp/operator-core/lib/harness-insights/card-types';

const fixture = vi.hoisted(() => ({ snapshot: null as TokensDashboardSnapshot | null }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: [fixture.snapshot],
  loading: false, fetching: false, error: null, invalidate: vi.fn() }) }));
import { TokensView } from '../TokensView';
afterEach(cleanup);

it('labels observed model costs separately from Papercusp charges and unobserved provider invoices', () => {
  fixture.snapshot = { observation: 'observed', windowMs: 60_000,
    totals: { runs: 3, tokens: 390, inputTokens: 300, outputTokens: 90, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0.3, reportedUsd: 0.2, estimatedUsd: 0.1, unpricedCalls: 1 },
    byModel: [], byRole: [], byAccount: [], byDay: [], accountAttributionAvailable: false,
    recentCalls: [
      { id: 'reported', atMs: 300, model: 'reported-model', inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.2, costSource: 'provider' },
      { id: 'estimated', atMs: 200, model: 'estimated-model', inputTokens: 200, outputTokens: 30,
        cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.1, costSource: 'estimated' },
      { id: 'unknown', atMs: 100, model: 'unpriced-model', inputTokens: null, outputTokens: 40,
        cacheReadTokens: 0, cacheCreationTokens: null, costUsd: null, costSource: 'unknown' },
    ],
  };
  render(<TokensView slug="billing-separation" />);
  expect(screen.getByTestId('tokens-stat-cost').textContent).toContain('$0.30');
  expect(screen.getByTestId('tokens-stat-cost').textContent).toContain('Recorded model cost');
  expect(screen.getByTestId('tokens-cache-note').textContent).toContain('Provider-reported call cost: $0.20');
  expect(screen.getByTestId('tokens-cache-note').textContent).toContain('$0.10 estimated');
  expect(screen.getByTestId('tokens-cache-note').textContent).toContain('Cost is unknown for 1 call(s)');
  const scope = screen.getByText(/This local ledger covers calls this runtime observes/).textContent;
  expect(scope).toContain('does not measure provider-account usage');
  expect(scope).toContain('subscription balances, invoices, or cloud bills');
  expect(scope).toContain('Papercusp service charges are separate');
  const calls = screen.getByRole('region', { name: 'Recent local calls' }).textContent;
  expect(calls).toContain('$0.20 (provider reported)');
  expect(calls).toContain('$0.10 (estimated)');
  expect(calls).toContain('Unknown');
});
