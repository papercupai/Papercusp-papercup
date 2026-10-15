/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { configureOperatorUi, OperatorWorkspaceLocationProvider } from '@papercusp/operator-ui/seam';
import type { TokensDashboardSnapshot } from '@papercusp/operator-core/lib/harness-insights/card-types';
const h = vi.hoisted(() => ({ snapshot: null as TokensDashboardSnapshot | null }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: () => ({ data: h.snapshot ? [h.snapshot] : [],
  loading: false, fetching: false, error: null, invalidate: vi.fn() }) }));
import { TokensView } from '../TokensView';
afterEach(cleanup);
function snapshot(): TokensDashboardSnapshot {
  return { observation: 'observed', windowMs: 3600000,
    totals: { tokens: 10, costUsd: 0.2, estimatedUsd: 0.1, reportedUsd: 0.1, unpricedCalls: 1,
      runs: 3, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byModel: [], byRole: [], byAccount: [], byDay: [], accountAttributionAvailable: true,
    recentCalls: [{ id: '1', atMs: 100, model: 'unknown-model', inputTokens: null, outputTokens: 10,
      cacheReadTokens: 0, cacheCreationTokens: null, costUsd: null, costSource: 'unknown' }],
  };
}
describe('TokensView local diagnostics', () => {
  it('renders failed ledger reads as unknown instead of empty usage', () => {
    h.snapshot = { ...snapshot(), observation: 'unavailable' };
    render(<TokensView slug="customer" />);
    expect(screen.getByTestId('tokens-unavailable').textContent).toContain('unknown');
    expect(screen.queryByTestId('tokens-empty')).toBeNull();
    expect(screen.queryByTestId('tokens-stat-cost')).toBeNull();
  });
  it('discloses runtime scope and separates estimates and unpriced calls', () => {
    h.snapshot = snapshot();
    render(<TokensView slug="customer" />);
    expect(screen.getByTestId('tokens-cache-note').textContent).toContain('$0.10 estimated');
    expect(screen.getByTestId('tokens-cache-note').textContent).toContain('Cost is unknown for 1');
    expect(screen.getByText(/does not measure provider-account usage/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Recent local calls' }).textContent).toContain('Unknown');
    expect(screen.getByTestId('tokens-stat-cost').textContent).toContain('Recorded model cost');
  });
  it('sends only an explicit bounded request through the customer host seam and keeps local usage after refusal', async () => {
    h.snapshot = snapshot();
    const apiFetch = vi.fn(async () => Response.json({ delivered: false, code: 'consent_disabled' }, { status: 202 }));
    configureOperatorUi({ apiFetch });
    render(<OperatorWorkspaceLocationProvider location="cloud"><TokensView slug="customer" /></OperatorWorkspaceLocationProvider>);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Aggregate diagnostic export' }).textContent).toContain('off by default');
    expect(screen.getByRole('combobox', { name: 'Export period' }).textContent).toContain('Last 24 hours');
    fireEvent.click(screen.getByRole('button', { name: 'Send aggregate diagnostics' }));
    await screen.findByText('Enable aggregate diagnostic export in Settings → Profile first.');
    const [path, init] = apiFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/harness/customer/insights/diagnostic-export');
    expect(JSON.parse(String(init.body))).toEqual({ operation_id: expect.any(String), window_ms: 86400000 });
    expect(screen.getByTestId('tokens-stat-cost')).toBeTruthy();
    configureOperatorUi({ apiFetch: (path, init) => fetch(path, init) });
  });
});
