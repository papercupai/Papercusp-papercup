import { describe, expect, it } from 'vitest';
import { buildApi } from '../routes/index.ts';
import { makeEnv, makeListingRow, stubGithub } from './fake-d1.ts';

describe('GET /me/listings', () => {
  it('returns the authenticated publisher’s listings in every review state and their drafts', async () => {
    const api = buildApi();
    const { env, store } = makeEnv();
    store.tables.harnesses.push(
      makeListingRow({ id: 'pending-own', publisher_github_user_id: 1, publisher_github_login: 'alice', review_status: 'pending', unlisted_at: null, updated_at: 30 }),
      makeListingRow({ id: 'approved-own', publisher_github_user_id: 1, publisher_github_login: 'alice', review_status: 'approved', unlisted_at: 20, updated_at: 20 }),
      makeListingRow({ id: 'rejected-own', publisher_github_user_id: 1, review_status: 'rejected', review_reason: 'Missing license', visibility: 'private', updated_at: 10 }),
      makeListingRow({ id: 'rejected-foreign', publisher_github_user_id: 2, publisher_github_login: 'bob', review_status: 'pending', unlisted_at: null, updated_at: 40 }),
    );
    store.tables.creator_drafts.push({
      id: 'draft-own', owner_github_user_id: 1, owner_github_login: 'alice', state: 'rejected',
      listing_kind: 'plugin', listing_ref: 'draft-ref', title: 'Draft', description: null,
      manifest_json: '{}', provenance_json: '{}', artifact_key: null, artifact_content_hash: null,
      artifact_size_bytes: null, artifact_content_type: null, upload_token_hash: 'secret-hash',
      upload_expires_at: 999999, reviewed_at: 40, reviewed_by_github_user_id: 2, review_reason: 'needs work',
      published_listing_id: null, created_at: 10, updated_at: 40,
    });
    store.tables.creator_drafts.push({ ...store.tables.creator_drafts[0], id: 'draft-foreign', owner_github_user_id: 2 });
    stubGithub({ user: { id: 1, login: 'alice' } });

    const response = await api.request('/me/listings', { headers: { Authorization: 'Bearer owner' } }, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { listings: Array<{ id: string; review_status: string }>; drafts: Array<{ id: string; state: string }> };
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.listings.map((row) => row.id)).toEqual(['pending-own', 'approved-own', 'rejected-own']);
    expect(body.listings.map((row) => row.review_status)).toEqual(['pending', 'approved', 'rejected']);
    expect(body.listings[2]).toMatchObject({ review_reason: 'Missing license' });
    expect(body.drafts).toEqual([expect.objectContaining({ id: 'draft-own', state: 'rejected' })]);
    expect(body.drafts[0]).not.toHaveProperty('upload_token_hash');
    expect(body.drafts[0]).not.toHaveProperty('upload_expires_at');
    expect(body.drafts[0]).not.toHaveProperty('manifest_json');
    expect(body.drafts[0]).not.toHaveProperty('provenance_json');
  });

  it('paginates owned rows without mixing another publisher’s rows into the limit', async () => {
    const api = buildApi();
    const { env, store } = makeEnv();
    for (let i = 0; i < 3; i++) {
      store.tables.harnesses.push(makeListingRow({ id: `own-${i}`, updated_at: 10 - i }));
      store.tables.harnesses.push(makeListingRow({ id: `other-${i}`, publisher_github_user_id: 2, updated_at: 20 - i }));
    }
    stubGithub({ user: { id: 1, login: 'alice' } });
    const headers = { Authorization: 'Bearer owner' };
    const first = await api.request('/me/listings?limit=2', { headers }, env);
    expect(await first.json()).toMatchObject({ listings: [{ id: 'own-0' }, { id: 'own-1' }], next_cursor: '2' });
    const second = await api.request('/me/listings?limit=2&cursor=2', { headers }, env);
    expect(await second.json()).toMatchObject({ listings: [{ id: 'own-2' }], drafts: [], next_cursor: null });
    const bad = await api.request('/me/listings?cursor=-1', { headers }, env);
    expect(bad.status).toBe(400);
  });

  it('requires GitHub authentication', async () => {
    const api = buildApi();
    const { env } = makeEnv();
    const response = await api.request('/me/listings', {}, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'auth', reason: 'missing_bearer' });
  });
});
