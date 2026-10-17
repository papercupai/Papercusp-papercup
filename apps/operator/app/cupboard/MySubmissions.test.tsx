// @vitest-environment jsdom
import React, { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PublisherListing } from '@papercusp/operator-core/lib/cupboard/my-listings';
const h = vi.hoisted(() => ({ query: vi.fn(), invalidate: vi.fn(), fetch: vi.fn(), setCursor: vi.fn() }));
vi.mock('@papercusp/sync', () => ({ useSyncQuery: h.query }));
vi.mock('nuqs', () => ({ parseAsString: {}, useQueryState: () => [null, h.setCursor] }));
import MySubmissions from './MySubmissions';
const card = (listing: PublisherListing, status: ReactNode, actions: ReactNode) => <div><h2>{listing.title}</h2>{status}{actions}</div>;
const inventory = {
  ok: true, nextCursor: '100', listings: [
    { id: 'pending', title: 'Waiting item', review_status: 'pending', unlisted_at: null },
    { id: 'approved', title: 'Public item', review_status: 'approved', unlisted_at: null },
    { id: 'rejected', title: 'Rejected item', review_status: 'rejected', review_reason: 'Missing license', unlisted_at: null },
    { id: 'delisted', title: 'Old item', review_status: 'approved', unlisted_at: 1 },
  ], drafts: [{ id: 'draft', title: 'Unsubmitted item', state: 'draft', published_listing_id: null }],
};
function setRead(read: unknown, extra = {}) {
  h.query.mockReturnValue({ data: [read], loading: false, fetching: false, error: null, invalidate: h.invalidate, ...extra });
}
beforeEach(() => { vi.clearAllMocks(); setRead(inventory); vi.stubGlobal('fetch', h.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('My submissions', () => {
  it('renders every publisher state and its rejection reason with actionable active listings', () => {
    render(<MySubmissions renderCard={card} />);
    for (const label of ['Draft', 'Pending review', 'Approved', 'Rejected', 'Delisted']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Rejection reason: Missing license')).toBeTruthy();
    expect(screen.getAllByTestId('submission-card')).toHaveLength(5);
    expect(screen.getAllByRole('button', { name: /^Delist / })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Delist Old item' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(h.setCursor).toHaveBeenCalledWith('100');
  });
  it('delists through the existing tool then refreshes the inventory', async () => {
    h.fetch.mockResolvedValue(Response.json({ ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }));
    render(<MySubmissions renderCard={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delist Waiting item' }));
    await waitFor(() => expect(h.invalidate).toHaveBeenCalledTimes(1));
    expect(h.fetch.mock.calls[0][0]).toBe('/api/agent-mcp/run-tool');
    expect(JSON.parse(h.fetch.mock.calls[0][1].body)).toEqual({ name: 'cupboard:unpublish', args: { listingId: 'pending' } });
  });
  it('keeps rejected delist actions visible as errors without claiming success', async () => {
    h.fetch.mockResolvedValue(Response.json({ ok: true, result: { content: [{ type: 'text', text: '{"ok":false,"error":"forbidden"}' }] } }));
    render(<MySubmissions renderCard={card} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delist Waiting item' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('forbidden'));
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(screen.getByText('Waiting item')).toBeTruthy();
  });
  it('distinguishes loading, unavailable, and empty inventories and offers recovery', () => {
    setRead(inventory, { fetching: true });
    const mounted = render(<MySubmissions renderCard={card} />);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText('Waiting item')).toBeNull();
    setRead({ ok: false, status: 401, error: 'gh_auth_required' });
    mounted.rerender(<MySubmissions renderCard={card} />);
    expect(screen.getByRole('alert').textContent).toContain('Sign in to GitHub');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.invalidate).toHaveBeenCalled();
    setRead({ ok: true, listings: [], drafts: [], nextCursor: null });
    mounted.rerender(<MySubmissions renderCard={card} />);
    expect(screen.getByText(/No submissions yet/)).toBeTruthy();
  });
});
