import { getGhAuthToken } from '../identity/gh-token';
import { resolveCupboardBaseUrl } from './base-url';
import type { ListingKind } from './types';

export interface PublisherListing {
  id: string;
  listing_kind: ListingKind;
  title: string;
  description: string | null;
  listing_ref: string | null;
  review_status: 'pending' | 'approved' | 'rejected';
  review_reason: string | null;
  unlisted_at: number | null;
  updated_at: number;
  [key: string]: unknown;
}

export interface PublisherDraft {
  id: string;
  listing_kind: ListingKind;
  title: string;
  description: string | null;
  listing_ref: string | null;
  state: 'draft' | 'submitted' | 'approved' | 'rejected' | 'published' | 'yanked' | 'revoked';
  review: { reason: string | null } | null;
  published_listing_id: string | null;
  updated_at: number;
}

export type MyListingsRead =
  | { ok: true; listings: PublisherListing[]; drafts: PublisherDraft[]; nextCursor: string | null }
  | { ok: false; status: number; error: string };

/** Server-held GitHub credentials; callers cannot select an owner or supply a token. */
export async function readMyCupboardListings(input: { limit?: number; cursor?: string } = {}): Promise<MyListingsRead> {
  const auth = await getGhAuthToken();
  if (auth.kind !== 'ok') return { ok: false, status: 401, error: 'gh_auth_required' };
  const url = new URL(`${resolveCupboardBaseUrl()}/me/listings`);
  url.searchParams.set('limit', String(input.limit ?? 100));
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${auth.token}`, 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, status: response.status, error: `cupboard_http_${response.status}` };
    const body = await response.json() as { listings?: PublisherListing[]; drafts?: PublisherDraft[]; next_cursor?: string | null };
    if (!Array.isArray(body.listings) || !Array.isArray(body.drafts) ||
      (body.next_cursor !== null && typeof body.next_cursor !== 'string')) {
      return { ok: false, status: 502, error: 'cupboard_bad_response' };
    }
    return { ok: true, listings: body.listings, drafts: body.drafts, nextCursor: body.next_cursor };
  } catch {
    return { ok: false, status: 502, error: 'cupboard_unreachable' };
  }
}
