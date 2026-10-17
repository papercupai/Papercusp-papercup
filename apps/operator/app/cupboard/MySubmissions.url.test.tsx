// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import * as Tooltip from '@radix-ui/react-tooltip';

const h = vi.hoisted(() => ({ read: vi.fn(), invalidate: vi.fn(), fetch: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: h.read }));
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (key: string) => key }));
vi.mock('@/lib/router-compat/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import CupboardClient from './CupboardClient';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  h.read.mockReset(); h.invalidate.mockReset(); h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
});

describe('My submissions URL journey with real nuqs parsers', () => {
  it('opens the private view from its URL, preserves pagination, shows review details, and delists', async () => {
    let delisted = false;
    h.read.mockImplementation(({ queryName }) => ({
      data: queryName === 'cupboard.myListings' ? [{ ok: true, listings: [{
        id: 'owned', title: 'Owned plugin', description: '', listing_kind: 'plugin', listing_ref: 'owned',
        review_status: 'rejected', review_reason: 'Missing license', unlisted_at: delisted ? 123 : null,
      }], drafts: [], nextCursor: '40' }] : [],
      loading: false, fetching: false, error: null, invalidate: h.invalidate,
    }));
    h.fetch.mockImplementation(async () => {
      delisted = true;
      return Response.json({ ok: true, result: { data: { ok: true } } });
    });
    const onUrlUpdate = vi.fn();
    render(<NuqsTestingAdapter searchParams="?kind=my-submissions&submissionCursor=20" hasMemory onUrlUpdate={onUrlUpdate}>
      <Tooltip.Provider><CupboardClient /></Tooltip.Provider>
    </NuqsTestingAdapter>);

    expect(await screen.findByRole('region', { name: 'My submissions' })).toBeTruthy();
    expect(screen.getByText('Rejection reason: Missing license')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith(expect.objectContaining({ queryName: 'cupboard.myListings',
      args: { limit: 100, cursor: '20' }, persist: false }));
    expect(h.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(h.read).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'cupboard.myListings', args: { limit: 100, cursor: '40' },
    })));
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get('kind')).toBe('my-submissions');
    expect(onUrlUpdate.mock.calls.at(-1)?.[0].searchParams.get('submissionCursor')).toBe('40');
    fireEvent.click(screen.getByRole('button', { name: 'Delist Owned plugin' }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledOnce());
    expect(h.fetch).toHaveBeenCalledExactlyOnceWith('/api/agent-mcp/run-tool', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: 'cupboard:unpublish', args: { listingId: 'owned' } }),
    }));
    expect(await screen.findByText('Delisted')).toBeTruthy();
  });
});
