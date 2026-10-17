import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import { listCreatorDrafts, listPublisherListings } from '../db.ts';
import { draftResponse } from './creator-drafts.ts';

/** Authenticated publisher-owned views that must not use public catalog filters. */
export function meRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/me/listings', async (c) => {
    let user;
    try {
      user = await resolveGithubBearer(c.req.raw);
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: 'auth', reason: e.reason }, 401);
      throw e;
    }
    const params = new URL(c.req.url).searchParams;
    const rawLimit = Number.parseInt(params.get('limit') ?? '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;
    const rawCursor = params.get('cursor') ?? '0';
    const offset = Number(rawCursor);
    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(offset)) {
      return c.json({ error: 'invalid_field', field: 'cursor' }, 400);
    }
    const [listings, drafts] = await Promise.all([
      listPublisherListings(c.env.DB, { publisherId: user.id, limit: limit + 1, offset }),
      listCreatorDrafts(c.env.DB, { ownerId: user.id, limit: limit + 1, offset }),
    ]);
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      listings: listings.slice(0, limit),
      drafts: drafts.slice(0, limit).map((draft) => draftResponse(draft)),
      next_cursor: listings.length > limit || drafts.length > limit ? String(offset + limit) : null,
    });
  });

  return app;
}
