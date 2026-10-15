/**
 * Unit tests for the coordination ops — proven with DI test-double caps (no PG,
 * no real agent spawns), exactly as the coord-op design intends.
 * Run with: cd packages/operator-core && npx vitest run lib/coord-ops/__tests__/ops.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import type { CoordOpCaps, CoordOpCtx, CollectedPost } from '../types';
import { resolveOp } from '../ops/resolve';
import { escalateOp } from '../ops/escalate';
import { collectOp } from '../ops/collect';
import { subscribeOp } from '../ops/subscribe';
import { threadOpenOp } from '../ops/thread-open';
import { threadPostOp } from '../ops/thread-post';

const makeCtx = (caps: Partial<CoordOpCaps>, over: Partial<CoordOpCtx> = {}): CoordOpCtx => ({
  identity: { ownerId: 'owner-1' },
  depth: 0,
  now: () => '2026-01-01T00:00:00.000Z',
  newId: (p) => `${p}-test`,
  caps: caps as CoordOpCaps,
  ...over,
});

const post = (id: number): CollectedPost => ({ id, author_id: `a${id}`, body: `vote ${id}`, created_ts: '2026-01-01' });

describe('resolveOp', () => {
  it('returns the bound decision and notifies the caller', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const a = resolveOp.argsSchema.parse({ decision: 'optA', summary: 'we chose A' });
    const out = await resolveOp.run(a, makeCtx({ notify }, { callerId: 'caller-1' }));
    expect(out).toEqual({ resolved: true, decision: 'optA' });
    expect(notify).toHaveBeenCalledWith({ to: ['caller-1'], summary: 'we chose A', body: 'we chose A' });
  });

  it('does not notify when notify_caller is false', async () => {
    const notify = vi.fn();
    const a = resolveOp.argsSchema.parse({ decision: 1, notify_caller: false });
    await resolveOp.run(a, makeCtx({ notify }, { callerId: 'caller-1' }));
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not notify when there is no caller', async () => {
    const notify = vi.fn();
    const a = resolveOp.argsSchema.parse({ decision: 1 }); // notify_caller defaults true
    await resolveOp.run(a, makeCtx({ notify })); // no callerId
    expect(notify).not.toHaveBeenCalled();
  });

  it('swallows a notify failure (best-effort) and still resolves', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('bus down'));
    const a = resolveOp.argsSchema.parse({ decision: 'x' });
    await expect(resolveOp.run(a, makeCtx({ notify }, { callerId: 'c' }))).resolves.toEqual({
      resolved: true,
      decision: 'x',
    });
  });
});

describe('escalateOp', () => {
  it('forwards to caps.escalate and returns the msg id', async () => {
    const escalate = vi.fn().mockResolvedValue({ msg_id: 'esc-1' });
    const a = escalateOp.argsSchema.parse({ summary: 'need a human' });
    const out = await escalateOp.run(a, makeCtx({ escalate }));
    expect(out).toEqual({ msg_id: 'esc-1', escalated: true });
    expect(escalate).toHaveBeenCalledWith(expect.objectContaining({ severity: 'question', summary: 'need a human' }));
  });

  it('defaults severity to "question" and rejects an empty summary', () => {
    expect(escalateOp.argsSchema.parse({ summary: 'x' }).severity).toBe('question');
    expect(() => escalateOp.argsSchema.parse({ summary: '' })).toThrow();
  });
});

describe('collectOp (barrier)', () => {
  it('resolves immediately with reason "quorum" when enough posts already exist', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const listPosts = vi.fn().mockResolvedValue([post(1), post(2), post(3)]);
    const a = collectOp.argsSchema.parse({ conversation_id: 'c', quorum: 3 });
    const out = await collectOp.run(a, makeCtx({ listPosts, sleep }));
    expect(out.reason).toBe('quorum');
    expect(out.count).toBe(3);
    expect(sleep).not.toHaveBeenCalled(); // no wait needed
  });

  it('polls until quorum is reached', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const listPosts = vi
      .fn()
      .mockResolvedValueOnce([post(1)]) // below quorum
      .mockResolvedValueOnce([post(1), post(2), post(3)]); // reached after one poll
    const a = collectOp.argsSchema.parse({ conversation_id: 'c', quorum: 3, poll_ms: 1, timeout_s: 10 });
    const out = await collectOp.run(a, makeCtx({ listPosts, sleep }));
    expect(out.reason).toBe('quorum');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up with reason "timeout" after the bounded poll budget', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const listPosts = vi.fn().mockResolvedValue([post(1)]); // never reaches quorum 3
    // maxPolls = ceil(timeout_s*1000 / poll_ms) = ceil(10/1) = 10
    const a = collectOp.argsSchema.parse({ conversation_id: 'c', quorum: 3, poll_ms: 1, timeout_s: 0.01 });
    const out = await collectOp.run(a, makeCtx({ listPosts, sleep }));
    expect(out.reason).toBe('timeout');
    expect(out.count).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(10);
  });
});

describe('subscribeOp', () => {
  it('forwards to caps.subscribe with the default "full" mode', async () => {
    const subscribe = vi.fn().mockResolvedValue({ ok: true });
    const a = subscribeOp.argsSchema.parse({ target_kind: 'topic', target_ref: 'fleet' });
    const out = await subscribeOp.run(a, makeCtx({ subscribe }));
    expect(out).toEqual({ ok: true });
    expect(subscribe).toHaveBeenCalledWith({ target_kind: 'topic', target_ref: 'fleet', mode: 'full' });
  });
});

describe('threadOpenOp', () => {
  it('defaults body to title and harness to ctx.harnessSlug', async () => {
    const openThread = vi.fn().mockResolvedValue({ thread_id: 't1', conversation_id: 'c1' });
    const a = threadOpenOp.argsSchema.parse({ title: 'Pick an option' });
    const out = await threadOpenOp.run(a, makeCtx({ openThread }, { harnessSlug: 'papercup' }));
    expect(out).toEqual({ thread_id: 't1', conversation_id: 'c1' });
    expect(openThread).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Pick an option', kind: 'discussion', harness: 'papercup' }),
    );
  });

  it('falls back to a generic body when neither body nor title is given', async () => {
    const openThread = vi.fn().mockResolvedValue({ thread_id: 't', conversation_id: 'c' });
    const a = threadOpenOp.argsSchema.parse({});
    await threadOpenOp.run(a, makeCtx({ openThread }));
    expect(openThread).toHaveBeenCalledWith(expect.objectContaining({ body: 'Coordination thread' }));
  });
});

describe('threadPostOp', () => {
  it('maps is_answer→isAnswer and returns the post id', async () => {
    const postThread = vi.fn().mockResolvedValue({ post_id: 42 });
    const a = threadPostOp.argsSchema.parse({ conversation_id: 'c1', body: 'my vote', is_answer: true });
    const out = await threadPostOp.run(a, makeCtx({ postThread }));
    expect(out).toEqual({ post_id: 42 });
    expect(postThread).toHaveBeenCalledWith({ conversation_id: 'c1', body: 'my vote', isAnswer: true });
  });

  it('directs work-item thread keys to work_items:comment', async () => {
    const postThread = vi.fn();
    const a = threadPostOp.argsSchema.parse({
      conversation_id: 'work-item-thread-WI-7',
      body: 'comment',
    });
    await expect(threadPostOp.run(a, makeCtx({ postThread }))).rejects.toThrow(
      'This is a work-item thread key, not a coordination conversation ID. Use work_items:comment',
    );
    expect(threadPostOp.description).toContain('work-item-thread-* values are not conversation IDs');
    expect(postThread).not.toHaveBeenCalled();
  });

  it('rejects an empty body', () => {
    expect(() => threadPostOp.argsSchema.parse({ conversation_id: 'c', body: '' })).toThrow();
  });
});
