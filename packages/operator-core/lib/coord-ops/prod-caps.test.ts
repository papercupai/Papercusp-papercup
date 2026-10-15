/**
 * prod-caps.test.ts — the production CoordOp capability bag + context builder.
 * Covers the box-safe logic that needs no live PG (the PG-backed caps touch the
 * pool only lazily, which this test never triggers):
 *
 *  - the spawn-runner SEAM: caps.spawnRoles throws a clear "not wired" error when
 *    no runner is set, and once setCoordSpawnRunner() is wired it forwards the
 *    specs + the bound { harnessSlug, workspaceId } scope (a regression dropping
 *    the guard would call undefined; mis-forwarding scope would misroute spawns).
 *  - buildCoordOpCtx: depth defaults to 0 (the recursion guard), field
 *    passthrough, now() is an ISO instant, and newId(prefix) is prefixed +
 *    monotonic (two calls never collide — ids key durable state).
 *  - readAnswer's "is it answered?" branches: no-conversation, an accepted answer,
 *    the latest reply by someone OTHER than the asker, and only-the-asker-replied.
 *  - listPosts: empty on a missing conversation, else the projected post shape.
 *
 * getConversation is mocked (readAnswer/listPosts read it); the spawn seam + ctx
 * need no mocks. Node env. In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/coord-ops/prod-caps.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent-tools/coordination/conversations.js', () => ({
  openConversation: vi.fn(),
  postReply: vi.fn(),
  getConversation: vi.fn(),
}));

import { getConversation } from '../agent-tools/coordination/conversations.js';
import { ADMIN_COORD_UI_OWNER } from '../agent-tools/coordination/identity.js';
import { buildCoordOpCaps, buildCoordOpCtx, setCoordSpawnRunner } from './prod-caps';

const getConv = vi.mocked(getConversation);
const base = { identity: { ownerId: 'u1' }, harnessSlug: 'web', workspaceId: 'default' };

beforeEach(() => vi.clearAllMocks());
afterEach(() => setCoordSpawnRunner(null)); // never leak a wired runner across tests

describe('spawnRoles seam', () => {
  it('throws a clear "not wired" error when no runner is set', async () => {
    const caps = buildCoordOpCaps(base);
    await expect(caps.spawnRoles([{ role: 'worker' } as never])).rejects.toThrow(/spawn runner not wired/);
  });

  it('forwards specs + the bound scope to a wired runner and returns its result', async () => {
    const runner = vi.fn(async () => ({ spawned: ['worker'] }) as never);
    setCoordSpawnRunner(runner);
    const caps = buildCoordOpCaps(base);
    const specs = [{ role: 'worker' }] as never;
    const out = await caps.spawnRoles(specs);
    expect(out).toEqual({ spawned: ['worker'] });
    expect(runner).toHaveBeenCalledWith(specs, { harnessSlug: 'web', workspaceId: 'default' });
  });

  it('reverts to throwing after the runner is cleared', async () => {
    setCoordSpawnRunner(vi.fn());
    setCoordSpawnRunner(null);
    await expect(buildCoordOpCaps(base).spawnRoles([] as never)).rejects.toThrow(/not wired/);
  });
});

describe('buildCoordOpCtx', () => {
  it('defaults depth to 0 and passes the scope/identity fields through', () => {
    const ctx = buildCoordOpCtx({ ...base, callerId: 'c1', workItemId: 'WI-9' });
    expect(ctx.depth).toBe(0);
    expect(ctx.identity).toBe(base.identity);
    expect(ctx.workspaceId).toBe('default');
    expect(ctx.harnessSlug).toBe('web');
    expect(ctx.callerId).toBe('c1');
    expect(ctx.workItemId).toBe('WI-9');
    expect(typeof ctx.caps.spawnRoles).toBe('function');
  });

  it('respects an explicit depth', () => {
    expect(buildCoordOpCtx({ ...base, depth: 3 }).depth).toBe(3);
  });

  it('now() is a valid ISO instant', () => {
    const ts = buildCoordOpCtx(base).now();
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
    expect(ts).toMatch(/\dT\d.*Z$/);
  });

  it('newId is prefixed and monotonic (no collisions within a ctx)', () => {
    const ctx = buildCoordOpCtx(base);
    const a = ctx.newId('vote');
    const b = ctx.newId('vote');
    expect(a.startsWith('vote-')).toBe(true);
    expect(b.startsWith('vote-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('readAnswer — "is it answered?" branches', () => {
  const caps = () => buildCoordOpCaps(base);

  it('no conversation → not answered', async () => {
    getConv.mockResolvedValue(null);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({ answered: false, answer: null });
  });

  it('an accepted answer wins outright', async () => {
    getConv.mockResolvedValue({ conversation: { accepted_answer: 'the answer' }, posts: [] } as never);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({ answered: true, answer: 'the answer' });
  });

  it('does not surface an agent-authored accepted post as an owner-question answer', async () => {
    getConv.mockResolvedValue({
      conversation: {
        kind: 'question',
        producer: 'coord:ask-owner',
        accepted_answer: 'grant the extra permissions',
        accepted_post_id: 23,
      },
      posts: [
        { id: 23, author_id: 'agent-1', body: 'grant the extra permissions' },
      ],
    } as never);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({
      answered: false,
      answer: null,
    });
  });

  it('returns the latest owner-authored reply for an owner decision question', async () => {
    getConv.mockResolvedValue({
      conversation: {
        kind: 'question',
        producer: 'coord:ask-owner',
        accepted_answer: null,
        accepted_post_id: null,
      },
      posts: [
        { id: 1, author_id: 'u1', body: 'question followup' },
        { id: 2, author_id: 'agent-1', body: 'agent suggestion' },
        { id: 3, author_id: ADMIN_COORD_UI_OWNER, body: '  keep the existing scope  ' },
      ],
    } as never);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({
      answered: true,
      answer: 'keep the existing scope',
    });
  });

  it('falls back to the latest reply by someone OTHER than the asker', async () => {
    getConv.mockResolvedValue({
      conversation: { accepted_answer: null },
      posts: [
        { id: 'p1', author_id: 'u1', body: 'my own note' },
        { id: 'p2', author_id: 'u2', body: 'first peer' },
        { id: 'p3', author_id: 'u3', body: 'latest peer' },
      ],
    } as never);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({ answered: true, answer: 'latest peer' });
  });

  it('only the asker replied → not answered', async () => {
    getConv.mockResolvedValue({
      conversation: { accepted_answer: null },
      posts: [{ id: 'p1', author_id: 'u1', body: 'talking to myself' }],
    } as never);
    expect(await caps().readAnswer({ conversationId: 'x', askerId: 'u1' })).toEqual({ answered: false, answer: null });
  });

  // WI-1571 read side: the answer poll must read the SAME workspace partition
  // openThread wrote to — identity-less it resolved 'default', so a
  // workspace-scoped coord:ask-owner NEVER saw its answer and always timed out.
  it('threads the caps identity into the read (same partition as the ask that was written)', async () => {
    getConv.mockResolvedValue(null);
    await caps().readAnswer({ conversationId: 'x', askerId: 'u1' });
    expect(getConv).toHaveBeenCalledWith('x', expect.objectContaining({ ownerId: 'u1', workspaceId: 'default' }));
  });
});

describe('listPosts', () => {
  it('empty for a missing conversation', async () => {
    getConv.mockResolvedValue(null as never);
    expect(await buildCoordOpCaps(base).listPosts('x')).toEqual([]);
  });

  it('projects the post shape', async () => {
    getConv.mockResolvedValue({
      conversation: {},
      posts: [{ id: 'p1', author_id: 'u2', body: 'hi', created_ts: 't', extra: 'dropped' }],
    } as never);
    expect(await buildCoordOpCaps(base).listPosts('x')).toEqual([
      { id: 'p1', author_id: 'u2', body: 'hi', created_ts: 't' },
    ]);
  });
});
