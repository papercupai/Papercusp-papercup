import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ auth: vi.fn(), fetch: vi.fn(), invalidate: vi.fn(async () => {}) }));
vi.mock('../identity/gh-token', () => ({ getGhAuthToken: h.auth }));
vi.mock('./base-url', () => ({ resolveCupboardBaseUrl: () => 'https://cupboard.test' }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: h.invalidate }));
import { readMyCupboardListings } from './my-listings';
import { deleteCupboardListing } from './delete-listing';
beforeEach(() => {
  vi.stubGlobal('fetch', h.fetch);
  h.fetch.mockReset();
  h.invalidate.mockClear();
  h.auth.mockResolvedValue({ kind: 'ok', token: 'private-gh-token' });
});
afterEach(() => vi.unstubAllGlobals());

describe('authenticated publisher inventory client', () => {
  it('forwards server credentials and pagination, preserving review and draft state', async () => {
    h.fetch.mockResolvedValue(Response.json({ listings: [{ id: 'a', review_status: 'rejected', review_reason: 'Missing license' }],
      drafts: [{ id: 'd', state: 'draft' }], next_cursor: '4' }));
    const read = await readMyCupboardListings({ limit: 2, cursor: '2' });
    expect(read).toMatchObject({ ok: true, listings: [{ review_reason: 'Missing license' }], drafts: [{ state: 'draft' }], nextCursor: '4' });
    expect(String(h.fetch.mock.calls[0][0])).toBe('https://cupboard.test/me/listings?limit=2&cursor=2');
    expect(h.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer private-gh-token');
    expect(JSON.stringify(read)).not.toContain('private-gh-token');
  });
  it('distinguishes auth, network and malformed-response failures from an empty inventory', async () => {
    h.auth.mockResolvedValueOnce({ kind: 'gh_auth_required' });
    expect(await readMyCupboardListings()).toMatchObject({ ok: false, status: 401 });
    expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockRejectedValueOnce(new Error('offline'));
    expect(await readMyCupboardListings()).toMatchObject({ ok: false, error: 'cupboard_unreachable' });
    h.fetch.mockResolvedValueOnce(Response.json({}));
    expect(await readMyCupboardListings()).toMatchObject({ ok: false, error: 'cupboard_bad_response' });
    h.fetch.mockResolvedValueOnce(Response.json({ error: 'auth' }, { status: 401 }));
    expect(await readMyCupboardListings()).toMatchObject({ ok: false, status: 401 });
  });
  it('invalidates inventory after successful delisting, including idempotent retries', async () => {
    h.fetch.mockResolvedValue(Response.json({ already_unlisted: true }));
    expect(await deleteCupboardListing('a/b')).toMatchObject({ ok: true, alreadyUnlisted: true });
    expect(String(h.fetch.mock.calls[0][0])).toBe('https://cupboard.test/listings/a%2Fb');
    expect(h.invalidate).toHaveBeenCalledWith('cupboard.myListings');
  });
  it('does not invalidate a refused delisting', async () => {
    h.fetch.mockResolvedValue(Response.json({ error: 'forbidden' }, { status: 403 }));
    expect(await deleteCupboardListing('foreign')).toMatchObject({ ok: false, status: 403 });
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});
