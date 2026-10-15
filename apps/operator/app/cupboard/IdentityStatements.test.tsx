// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { PrincipalUsagePage } from '@papercusp/operator-core/lib/cupboard/metered-invocation-door-io';

const H = vi.hoisted(() => ({ query: { data: [] as unknown[], error: null as string | null,
  loading: false, fetching: false, invalidate: vi.fn() }, useQuery: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: (input: unknown) => { H.useQuery(input); return H.query; } }));
vi.mock('@papercusp/grid-core', () => ({ RichGrid: ({ rows, columns }: { rows: unknown[];
  columns: Array<{ key: string; header: string; render: (input: { row: unknown }) => unknown }> }) =>
    <div>{columns.map(column => <div key={column.key}>{column.header}{rows.map((row, index) =>
      <div key={index}>{column.render({ row }) as React.ReactNode}</div>)}</div>)}</div> }));
import IdentityStatements, { formatUsageMicros } from './IdentityStatements';

const page = (): PrincipalUsagePage => ({ receipts: [], nextCursor: '["next-channel","next-nonce"]',
  coverage: { scope: 'authenticated-principal', population: 'live-page', totals: 'page', hasMore: true },
  identityStatement: { basis: 'hosted-settled-usage', currency: 'USD', chainFinality: 'not-measured',
    allocationBasis: 'per-receipt-quote', markupMicros: '10', reservedReceipts: 2, complete: true, issues: [],
    costPerAcceptedOutcomeMicros: null, outcomeEvidence: 'unavailable', lines: [{ channelId: 'ch', usageNonce: 'n',
      offerId: 'offer', releaseRef: 'identity-release:seller/example@1', payer: 'gh:buyer', seller: 'gh:seller',
      priceVersion: 'v1', splitManifestHash: 'sha256:exact', billedInferenceMicros: '9007199254740993', markupMicros: '10',
      allocationQuote: { creatorMicros: '8', daoMicros: '1', componentMicros: '1', componentAuthorsMicros: { author: '1' } } }] } });

beforeEach(() => {
  H.query.data = [{ ok: true, page: page() }];
  H.query.error = null; H.query.loading = false; H.query.fetching = false;
  H.query.invalidate.mockClear(); H.useQuery.mockClear();
});
afterEach(cleanup);
const mount = (searchParams = '') => render(<NuqsTestingAdapter searchParams={searchParams}>
  <IdentityStatements /></NuqsTestingAdapter>);

describe('P-018 identity statement UI', () => {
  it('renders exact per-identity provider cost, markup and split quotes without a combined inference total', () => {
    mount();
    expect(screen.getByText('identity-release:seller/example@1')).toBeTruthy();
    expect(screen.getByText('$9007199254.740993')).toBeTruthy();
    expect(screen.getByText('$0.000008')).toBeTruthy();
    expect(screen.getByText('author: $0.000001')).toBeTruthy();
    expect(screen.getByText(/Cost per accepted outcome: unavailable/)).toBeTruthy();
    expect(screen.getByText(/Split amounts are quotes, not payouts/)).toBeTruthy();
    expect(screen.getByText(/Markup on this page/)).toBeTruthy();
    expect(formatUsageMicros('9007199254740993')).toBe('$9007199254.740993');
  });
  it('stores pagination in the URL and reads only a bounded authenticated page', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await vi.waitFor(() => expect(H.useQuery).toHaveBeenLastCalledWith({ queryName: 'cupboard.identityUsage',
      args: { limit: 100, cursor: '["next-channel","next-nonce"]' }, staleTime: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'First page' }));
    await vi.waitFor(() => expect(H.useQuery).toHaveBeenLastCalledWith({ queryName: 'cupboard.identityUsage',
      args: { limit: 100 }, staleTime: 0 }));
  });
  it('refreshes explicitly through the sync layer', () => {
    mount(); fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(H.query.invalidate).toHaveBeenCalledOnce();
  });
  it('hides cached totals while a different page is loading', () => {
    H.query.fetching = true; mount('?usageCursor=%5B%22a%22%2C%22b%22%5D');
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText(/Markup on this page/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
  });
  it.each(['hosted', 'sync'])('reports %s failure without replacing missing evidence with zero', mode => {
    if (mode === 'sync') H.query.error = 'offline';
    else H.query.data = [{ ok: false, code: 'gh_auth_required', detail: 'sign in' }];
    mount(); expect(screen.getByRole('alert').textContent).toContain('No totals were measured');
    expect(screen.queryByText(/Markup on this page/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(H.query.invalidate).toHaveBeenCalledOnce();
  });
  it('keeps incomplete evidence and measured empty pages distinct', () => {
    const original = page();
    const empty: PrincipalUsagePage = { ...original, nextCursor: null,
      coverage: { ...original.coverage, hasMore: false },
      identityStatement: { ...original.identityStatement, lines: [], markupMicros: '0', complete: false,
        issues: [{ channelId: 'ch', usageNonce: 'bad', reason: 'conflicting-receipt' }] } };
    H.query.data = [{ ok: true, page: empty }]; mount();
    expect(screen.getByText('No settled identity usage on this page.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('conflicting-receipt');
    expect(screen.getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('$0.000000')).toBeTruthy();
  });
});
