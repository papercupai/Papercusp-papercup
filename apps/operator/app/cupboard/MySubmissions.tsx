'use client';

import { useState, type ReactNode } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type { MyListingsRead, PublisherDraft, PublisherListing } from '@papercusp/operator-core/lib/cupboard/my-listings';
import { Button } from '../harness/Button';

const reviewLabels: Record<string, string> = { pending: 'Pending review', submitted: 'Pending review',
  approved: 'Approved', published: 'Approved', rejected: 'Rejected', draft: 'Draft',
  yanked: 'Delisted', revoked: 'Delisted' };
const reviewLabel = (state: string): string => reviewLabels[state] ?? 'Unknown review state';

export default function MySubmissions({ renderCard }: {
  renderCard: (listing: PublisherListing, status: ReactNode, actions: ReactNode) => ReactNode;
}) {
  const [cursor, setCursor] = useQueryState('submissionCursor', parseAsString);
  const query = useSyncQuery<MyListingsRead>({ queryName: 'cupboard.myListings',
    args: { limit: 100, ...(cursor ? { cursor } : {}) }, staleTime: 0, persist: false });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const read = query.data?.[0];
  const busy = query.loading || query.fetching;
  const page = !busy && !query.error && read?.ok ? read : null;
  const error = query.error ? String(query.error) : read?.ok === false ? read.error : null;

  async function delist(id: string) {
    setPendingId(id);
    setActionError(null);
    try {
      const response = await fetch('/api/agent-mcp/run-tool', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cupboard:unpublish', args: { listingId: id } }) });
      const body = await response.json();
      const result = body.result?.data ?? body.result?.structuredContent ??
        (body.result?.content?.find((part: { type: string }) => part.type === 'text')?.text
          ? JSON.parse(body.result.content.find((part: { type: string }) => part.type === 'text').text) : null);
      if (!response.ok || body.ok === false || result?.ok !== true) {
        throw new Error(body.message ?? body.error ?? result?.error ?? 'Delist failed');
      }
      query.invalidate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delist failed');
    } finally {
      setPendingId(null);
    }
  }

  const draftListing = (draft: PublisherDraft): PublisherListing => ({
    id: draft.id, listing_kind: draft.listing_kind, listing_ref: draft.listing_ref, title: draft.title,
    description: draft.description, updated_at: draft.updated_at,
    review_status: draft.state === 'rejected' ? 'rejected' : 'pending',
    review_reason: draft.review?.reason ?? null, unlisted_at: null,
  });
  function status(label: string, reason?: string | null) {
    return <div><span className="pc-badge" data-testid="submission-state">{label}</span>
      {reason && <p style={{ color: 'var(--bad)', margin: '8px 0 0' }}>Rejection reason: {reason}</p>}</div>;
  }
  return <section aria-label="My submissions" style={{ maxWidth: 1180, margin: '24px auto' }}>
    <h1>My submissions</h1>
    <p>Everything you submitted with your signed-in GitHub account, including items awaiting review.</p>
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <Button onClick={() => query.invalidate()} disabled={busy}>Refresh</Button>
      <Button onClick={() => void setCursor(null)} disabled={busy || !cursor}>First page</Button>
      <Button onClick={() => { if (page?.nextCursor) void setCursor(page.nextCursor); }} disabled={busy || !page?.nextCursor}>Next page</Button>
    </div>
    {actionError && <p role="alert">Could not delist this submission: {actionError}</p>}
    {busy ? <p role="status" aria-live="polite">Loading your submissions…</p> : error ? <div role="alert">
      <p>Your submissions are unavailable. {read?.ok === false && read.status === 401 ? 'Sign in to GitHub in Settings, then retry.' : error}</p>
      <Button onClick={() => query.invalidate()}>Retry</Button>
    </div> : page ? <>
      {page.listings.length === 0 && page.drafts.length === 0 ? <p>No submissions yet. Ask an agent to publish an item to the Cupboard, then return here to track its review.</p> :
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {page.listings.map(listing => <article key={`listing:${listing.id}`} data-testid="submission-card">
            {renderCard(listing, status(listing.unlisted_at != null ? 'Delisted' : reviewLabel(listing.review_status),
              listing.review_status === 'rejected' ? listing.review_reason : null), listing.unlisted_at == null ?
              <Button disabled={pendingId !== null} onClick={() => void delist(listing.id)} aria-label={`Delist ${listing.title}`}>
                {pendingId === listing.id ? 'Delisting…' : 'Delist'}
              </Button> : null)}
          </article>)}
          {page.drafts.filter(draft => !draft.published_listing_id || !page.listings.some(listing => listing.id === draft.published_listing_id))
            .map(draft => <article key={`draft:${draft.id}`} data-testid="submission-card">
              {renderCard(draftListing(draft), status(reviewLabel(draft.state), draft.state === 'rejected' ? draft.review?.reason : null), null)}
            </article>)}
        </div>}
    </> : <p role="status">Your submissions have not loaded yet.</p>}
  </section>;
}
