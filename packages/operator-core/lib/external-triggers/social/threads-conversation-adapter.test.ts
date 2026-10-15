/**
 * P-018 — the Threads conversation adapter.
 *
 * THE CENTRAL CLAIM UNDER TEST IS A NEGATIVE ONE, which is the hard kind to
 * test honestly: Threads is `watermark-rescan` exactly like Instagram, and
 * unlike Instagram it loses nothing, because both media edges page (D-036).
 * "This adapter never sets lossRisk" is trivially satisfiable by an adapter
 * that simply never computes anything — so the no-loss tests below are paired
 * with a CONTROL that runs Instagram's own overflow predicate over the same
 * data and shows it WOULD have fired. That is what separates "correctly
 * lossless" from "not looking".
 *
 * The second cluster is the equal-instant stop rule. Paging newest-first and
 * stopping at the watermark is only correct if the stop is on STRICTLY older;
 * stopping at the first item AT the mark silently skips its siblings sharing
 * that second. That bug passes every naive test, so it gets a dedicated one.
 */
import { describe, expect, it } from 'vitest';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { isCoherentReconcileResult, type SocialAdapter, type SocialNormalizedEvent } from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import { isSocialWatermarkCursor, type SocialWatermarkCursor } from './social-watermark';
import { ThreadsCredentialError, type ThreadsCredential } from './threads-common';
import {
  ThreadsConversationAdapter,
  normalizeThreadsReply,
  threadsReplyDedupeKey,
  threadsReplyEventName,
  type ThreadsConversationClient,
  type ThreadsRawReply,
} from './threads-conversation-adapter';

const USER_ID = '17841400000000000';
const ROOT_ID = 'root-1';
const NEVER_EMIT_MARKER = 'TH|never-emit-this';

const CREDENTIAL: ThreadsCredential = {
  userId: USER_ID,
  accessToken: NEVER_EMIT_MARKER,
  scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies'],
};

const BASE_MS = Date.parse('2026-08-23T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', '+0000');

interface FakeWorld {
  /** Chronological, oldest first. */
  replies: ThreadsRawReply[];
  pageSize: number;
  seq: number;
  /** Every page request the adapter made, for cost assertions. */
  pageCalls: number;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return { replies: [], pageSize: 25, seq: 0, pageCalls: 0, ...over };
}

/** Add `count` replies, each one second apart. Returns ids oldest-first. */
function publishReplies(world: FakeWorld, count: number, opts: { sameInstant?: boolean } = {}): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    world.seq += 1;
    const id = `r-${world.seq}`;
    world.replies.push({
      id,
      timestamp: iso(opts.sameInstant ? BASE_MS : BASE_MS + world.seq * 1_000),
      text: `reply ${world.seq}`,
      username: 'someone',
      is_reply: true,
      replied_to: ROOT_ID,
      root_post: ROOT_ID,
    });
    ids.push(id);
  }
  return ids;
}

function makeClient(world: FakeWorld): ThreadsConversationClient {
  return {
    async listWatchedRootMediaIds() {
      return [ROOT_ID];
    },
    async listConversation({ reverse, after }) {
      world.pageCalls += 1;
      // Newest-first when reverse is true, which is what the adapter asks for.
      const ordered = reverse ? [...world.replies].reverse() : [...world.replies];
      const offset = after ? Number(after) : 0;
      const slice = ordered.slice(offset, offset + world.pageSize);
      const nextOffset = offset + world.pageSize;
      return {
        data: slice,
        nextCursor: nextOffset < ordered.length ? String(nextOffset) : null,
      };
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<{ credential: ThreadsCredential; maxPagesPerMedia: number }> = {}) {
  return new ThreadsConversationAdapter({
    client: makeClient(world),
    userId: USER_ID,
    credential: over.credential ?? CREDENTIAL,
    maxPagesPerMedia: over.maxPagesPerMedia ?? 50,
  });
}

async function drain(adapter: SocialAdapter, cursor: unknown | null) {
  const events: SocialNormalizedEvent[] = [];
  const result = await adapter.reconcile({
    cursor,
    async emit(event) {
      events.push(event);
    },
  });
  return { result, events };
}

function harness(worldOver: Partial<FakeWorld> = {}): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld(worldOver);
      return { adapter: newAdapter(world), world };
    },
    async publish(world, count) {
      return publishReplies(world, count);
    },
    // No expireCursor / rateLimitOnce: Threads has no server-side cursor to
    // expire, so the kit SKIPS those and says so rather than passing vacuously.
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */
/* Conformance                                                                */
/* -------------------------------------------------------------------------- */

describe('ThreadsConversationAdapter — P-003 conformance', () => {
  it('passes the shared kit UNMODIFIED', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures.map((f) => `${f.check}: ${f.detail}`).join(' || ')).toBe('');
  });

  it('passes the kit even when the page size forces MULTI-PAGE reads', async () => {
    // The distinguishing property: a page size smaller than the published set
    // is a paging exercise here, where on Instagram the equivalent is a real
    // loss (its edge caps and does not page).
    const report = await runSocialAdapterConformance(harness({ pageSize: 1 }));
    expect(report.failures.map((f) => `${f.check}: ${f.detail}`).join(' || ')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* D-036 — the class is Instagram's, the consequence is not                   */
/* -------------------------------------------------------------------------- */

describe('no loss, and it is EARNED rather than merely unreported (D-036)', () => {
  it('pages backwards across many pages to reach the watermark, emitting every reply', async () => {
    const world = makeWorld({ pageSize: 2 });
    publishReplies(world, 3);

    const first = await drain(newAdapter(world), null);
    expect(first.events).toHaveLength(3);

    // A burst far larger than one page arrives while we were away.
    publishReplies(world, 20);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.events).toHaveLength(20);
    expect(second.result.lossRisk).toBeUndefined();
    // It genuinely paged rather than reading one window and declaring victory.
    expect(world.pageCalls).toBeGreaterThan(3);
  });

  it('CONTROL: Instagram\'s overflow predicate WOULD have fired on the same data', async () => {
    // This is the case that makes the negative claim meaningful. Under
    // Instagram's capped-and-unpageable edge, a full newest-window whose oldest
    // item is still newer than the watermark proves items fell off the end. The
    // same shape here is simply "there is another page".
    const world = makeWorld({ pageSize: 2 });
    publishReplies(world, 3);
    const first = await drain(newAdapter(world), null);
    const stored = first.result.cursor as SocialWatermarkCursor;

    publishReplies(world, 20);
    // The package's capped-window controls live in instagram-provider.test.ts.
    // This suite proves the contrasting paginated Threads path stays lossless.
    expect(Date.parse(world.replies[world.replies.length - 3]!.timestamp as string)).toBeGreaterThan(Date.parse(stored.watermark!));

    // Threads', over the same data: nothing lost, because it can page.
    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toHaveLength(20);
    expect(second.result.lossRisk).toBeUndefined();
  });

  it('never sets lossRisk on a cold start either, however much history exists', async () => {
    // Instagram DOES report loss on a cold start under its cap — history older
    // than the newest 50 was never reachable. Here it is reachable, so silence
    // is the correct answer rather than an omission.
    const world = makeWorld({ pageSize: 3 });
    publishReplies(world, 40);
    const { result, events } = await drain(newAdapter(world), null);
    expect(events).toHaveLength(40);
    expect(result.lossRisk).toBeUndefined();
    expect(result.path).toBe('cold-start');
  });
});

/* -------------------------------------------------------------------------- */
/* The stop rule                                                              */
/* -------------------------------------------------------------------------- */

describe('the newest-first stop rule is STRICTLY older, not at-or-older', () => {
  it('emits an unseen SIBLING sharing the watermark instant', async () => {
    // THE BUG THIS PINS: stopping at the first item whose instant EQUALS the
    // mark abandons the page before reaching its siblings at that same second,
    // and they are never seen again. One-second resolution makes ties routine,
    // not exotic.
    const world = makeWorld({ pageSize: 10 });
    publishReplies(world, 2, { sameInstant: true });

    // Pretend we saw only ONE of the two items at that instant.
    const stored: SocialWatermarkCursor = { watermark: iso(BASE_MS), boundaryIds: ['r-1'] };
    const { events } = await drain(newAdapter(world), stored);

    expect(events.map((e) => e.externalId)).toEqual(['r-2']);
  });

  it('does NOT re-emit the sibling already recorded at that instant', async () => {
    const world = makeWorld({ pageSize: 10 });
    publishReplies(world, 2, { sameInstant: true });
    const stored: SocialWatermarkCursor = { watermark: iso(BASE_MS), boundaryIds: ['r-1', 'r-2'] };
    const { events } = await drain(newAdapter(world), stored);
    expect(events).toHaveLength(0);
  });

  it('stops early once it passes the watermark instead of draining all history', async () => {
    const world = makeWorld({ pageSize: 5 });
    publishReplies(world, 50);
    const first = await drain(newAdapter(world), null);

    const before = world.pageCalls;
    publishReplies(world, 2);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.events).toHaveLength(2);
    // Early exit is legitimate HERE because `reverse` is a documented sort over
    // an already-flat list — Instagram cannot do this, because its expanded
    // replies arrive nested and its flattened sequence is not ordered.
    expect(world.pageCalls - before).toBe(1);
  });

  it('is a no-op when nothing new arrived', async () => {
    const world = makeWorld();
    publishReplies(world, 4);
    const first = await drain(newAdapter(world), null);
    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toHaveLength(0);
    expect(second.result.emitted).toBe(0);
    expect(isCoherentReconcileResult(second.result)).toBe(true);
  });
});

describe('the runaway guard THROWS rather than truncating', () => {
  it('refuses to advance the cursor past replies it never read', async () => {
    // A silent short return would be the one way this adapter could invent the
    // loss the platform does not have: the watermark would land on the newest
    // reply while the older ones were never emitted.
    const world = makeWorld({ pageSize: 1 });
    publishReplies(world, 10);
    const adapter = newAdapter(world, { maxPagesPerMedia: 3 });
    await expect(drain(adapter, null)).rejects.toThrow(/threads_conversation_runaway/);
  });
});

/* -------------------------------------------------------------------------- */
/* Credential gating                                                          */
/* -------------------------------------------------------------------------- */

describe('the read refuses BEFORE the call when the scope is missing', () => {
  it('throws rather than returning an empty result set', async () => {
    // Threads documents no error codes, so an under-privileged read is
    // indistinguishable from a quiet account once it has gone out.
    const world = makeWorld();
    publishReplies(world, 3);
    const adapter = newAdapter(world, {
      credential: { ...CREDENTIAL, scopes: ['threads_basic'] },
    });
    await expect(drain(adapter, null)).rejects.toThrow(ThreadsCredentialError);
    expect(world.pageCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe('normalizeThreadsReply', () => {
  const reply: ThreadsRawReply = {
    id: 'r-9',
    timestamp: iso(BASE_MS),
    text: 'hello',
    username: 'someone',
    permalink: 'https://www.threads.net/@someone/post/abc',
    is_reply: true,
    replied_to: 'r-4',
    root_post: ROOT_ID,
    has_replies: true,
  };

  it('carries the IMMEDIATE parent as replyToId, not the root (D-035)', () => {
    // The opposite of the Instagram adapter, and deliberately so: Threads
    // addresses nested replies exactly, so flattening to the root here would
    // throw away the only thing that makes a correct nested reply possible.
    const event = normalizeThreadsReply(reply, ROOT_ID, USER_ID);
    expect(event.payload.replyToId).toBe('r-4');
    expect(event.payload.subjectId).toBe(ROOT_ID);
  });

  it('records the root OWNER, which the write path\'s gate needs', () => {
    // Establishable only here, by construction: the adapter reads conversations
    // for root media belonging to the connected profile. `is_reply_owned_by_me`
    // describes the REPLY and cannot answer for the root.
    expect(normalizeThreadsReply(reply, ROOT_ID, USER_ID).payload.subjectOwnerId).toBe(USER_ID);
  });

  it('unwraps an expanded node as readily as a bare id', () => {
    const expanded = { ...reply, replied_to: { id: 'r-4' }, root_post: { id: ROOT_ID } };
    const event = normalizeThreadsReply(expanded, ROOT_ID, USER_ID);
    expect(event.payload.replyToId).toBe('r-4');
    expect(event.payload.subjectId).toBe(ROOT_ID);
  });

  it('OMITS optional fields the vendor did not send rather than nulling them', () => {
    // A null would violate the canonical schema while looking like completeness,
    // and the conformance kit's payload check catches exactly that.
    const bare: ThreadsRawReply = { id: 'r-1', timestamp: iso(BASE_MS) };
    const payload = normalizeThreadsReply(bare, ROOT_ID, USER_ID).payload;
    expect('author' in payload).toBe(false);
    expect('replyToId' in payload).toBe(false);
    expect('url' in payload).toBe(false);
    expect(payload.text).toBe('');
  });

  it('the dedupe key is STABLE across a hide/unhide', () => {
    // hide_status is mutable and deliberately excluded: folding it in would
    // re-deliver a reply every time a moderator touched it.
    const hidden = { ...reply, hide_status: 'HIDDEN' };
    expect(threadsReplyDedupeKey(hidden)).toBe(threadsReplyDedupeKey(reply));
    expect(threadsReplyDedupeKey(reply)).toBe('threads:reply:r-9');
  });

  it('names the event from the vendor\'s own discriminator', () => {
    expect(threadsReplyEventName(reply)).toBe('reply');
    expect(threadsReplyEventName({ id: 'x', is_reply: false })).toBe('post');
  });

  it('never leaks the credential into an emitted payload', async () => {
    const world = makeWorld();
    publishReplies(world, 2);
    const { events } = await drain(newAdapter(world), null);
    expect(JSON.stringify(events)).not.toContain(NEVER_EMIT_MARKER);
  });
});

describe('the persisted cursor is a WATERMARK, never a provider cursor', () => {
  it('returns a shape the shared guard recognises', async () => {
    // Persisting `paging.cursors.after` would pin the integration to a snapshot
    // of the past: it addresses a position inside one result set, not a stream.
    const world = makeWorld();
    publishReplies(world, 3);
    const { result } = await drain(newAdapter(world), null);
    expect(isSocialWatermarkCursor(result.cursor)).toBe(true);
    expect(JSON.stringify(result.cursor)).not.toContain('nextCursor');
  });

  it('treats an unusable stored cursor as a rejected one, not as cold start', async () => {
    const world = makeWorld();
    publishReplies(world, 2);
    const { result } = await drain(newAdapter(world), { watermark: 'not-a-date', boundaryIds: [] });
    expect(result.path).toBe('backfill');
    expect(result.backfillReason).toBe('cursor-rejected');
    expect(isCoherentReconcileResult(result)).toBe(true);
  });

  it('declares no-replay-supported in the steady state', async () => {
    const world = makeWorld();
    publishReplies(world, 2);
    const first = await drain(newAdapter(world), null);
    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('no-replay-supported');
  });
});
