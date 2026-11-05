/**
 * conversations-core.test.ts — UNIT tests for the pure conversation-engine logic
 * (app-wide-test-coverage-2026-06-05 P-009), driven over the capability seams'
 * in-memory doubles (@papercusp/coordination/capabilities InMemory* stores) + an
 * in-memory ConversationStoreLike + an in-memory sink — no PG, no Docker.
 *
 * The two sibling integration suites (conversations.integration.test.ts +
 * conversations-edges.integration.test.ts) drive the SAME core over real Postgres
 * for the lifecycle happy paths; this file targets the pure branches they skip:
 *
 *  • open — unrouted (no topics), topic slug normalization/dedup, scope
 *    precedence (harness_slug wins over an explicit scope), discussion-kind
 *    notify rendering, summary truncation, and the best-effort fan-out (a
 *    subscriber-resolution failure never breaks the write).
 *  • the asker-exclusion contract on open when the asker ALREADY follows one of
 *    the tagged topics (a regression pin — this was a real bug, fixed
 *    2026-06-09; see the comment on that test).
 *  • post — the 'conversation_post' reply kind, the lazy thread-create branch,
 *    @-mention plumbing through the mention-mode gate, touch-on-activity.
 *  • resolve — whitespace-only accepted_answer, explicit-answer precedence over
 *    accepted_post_id, resolver≠asker exclusion, the 'mem0' capture default.
 *  • join/leave — delivery_mode honored, ttl_sec → expires_ts, leave silences.
 *  • listConversationsWithTopics — the wide-page-then-narrow topic filter (a
 *    match is not lost behind the caller's limit), topic input normalization,
 *    non-conversation tagged objects ignored.
 *  • promote — promote_unavailable (no bridge), the forced-harness issue scope,
 *    the truncated-body title fallback.
 *
 * delivery-mode gating itself (full/digest/mention) is the fanout-delivery
 * primitive's contract and is pinned in fanout-delivery.test.ts; the knowledge-
 * first short-circuit lives in tools/ask.ts + ask-knowledge-tier.ts (covered by
 * ask-knowledge-tier-dedup.test.ts + the integration suite), not in this core.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryEntitySubscriptionStore,
  InMemoryLinkStore,
  InMemoryTaggableStore,
  InMemoryThreadStore,
  InMemoryTopicStore,
  objectToTargetRef,
  type SubscribableStore,
} from '@papercusp/coordination/capabilities';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { InjectSink } from '../fanout-delivery';
import type { AgentIdentity } from '../identity';
import { ADMIN_COORD_UI_OWNER } from '../identity';
import type {
  CloseIfOpenStoreError,
  CloseIfOpenStoreResult,
  ConversationRow,
  ConversationState,
  CreateConversationInput,
  ListConversationsOpts,
  SupersedeStoreError,
  SupersedeStoreResult,
} from '../conversations-store';
import {
  answerQuestionCore,
  getConversationCore,
  joinConversationCore,
  leaveConversationCore,
  listConversationsWithTopicsCore,
  openConversationCore as openConversationCoreRaw,
  postReplyCore,
  promoteConversationCore,
  resolveConversationCore,
  settleConsultConversationCore,
  supersedeConversationCore,
  withdrawConversationCore,
  type CaptureFn,
  type ConversationDeps,
  type ConversationStoreLike,
} from '../conversations-core';

/**
 * `producer` is REQUIRED on the open path (EI-21462599108204160) so no production
 * caller can land an unattributed conversation. These suites assert routing,
 * fan-out and lifecycle — not attribution — so this shim supplies `producer:
 * 'test'` and lets the call sites below stay about what they actually test.
 * A test that DOES care about attribution passes its own producer explicitly.
 */
type OpenArg = Parameters<typeof openConversationCoreRaw>[2];
const openConversationCore = (
  deps: Parameters<typeof openConversationCoreRaw>[0],
  identity: Parameters<typeof openConversationCoreRaw>[1],
  input: Omit<OpenArg, 'producer'> & Partial<Pick<OpenArg, 'producer'>>,
) => openConversationCoreRaw(deps, identity, { producer: 'test', ...input } as OpenArg);

const WS = 'default';
// Far-future clock: the InMemory subscription store filters expiry against the
// REAL Date.now(), so ttl-derived expires_ts values must land in the future.
const T0 = '2030-01-01T00:00:00.000Z';

function ident(ownerId: string): AgentIdentity {
  return { ownerId, ownerLabel: ownerId, source: 'static-client', workspaceId: WS, userId: null } as AgentIdentity;
}

/** In-memory ConversationStoreLike mirroring PgConversationStore's semantics
 *  (create is idempotent-on-id, list is created_ts DESC + clamped limit, state
 *  'resolved' is the only state that sets resolved_ts). Records the raw opts of
 *  every list() call so the wide-page topic-filter behavior is observable. */
class InMemoryConversationStore implements ConversationStoreLike {
  rows = new Map<string, ConversationRow>();
  listCalls: ListConversationsOpts[] = [];

  async create(input: CreateConversationInput): Promise<ConversationRow> {
    const existing = this.rows.get(input.id);
    if (existing) return { ...existing };
    const row: ConversationRow = {
      id: input.id,
      kind: input.kind,
      scope: input.scope,
      harness_slug: input.harness_slug ?? null,
      asker_id: input.asker_id,
      title: input.title ?? null,
      body: input.body,
      state: 'open',
      accepted_answer: null,
      accepted_post_id: null,
      capture_target: null,
      promoted_issue_id: null,
      // Carried through like PG does — a fake that dropped it would make every
      // attribution assertion below vacuously pass (EI-21462599108204160).
      producer: input.producer,
      plan_slug: input.plan_slug ?? null,
      work_item_id: input.work_item_id ?? null,
      superseded_by: null,
      created_ts: input.created_ts,
      updated_ts: input.created_ts,
      resolved_ts: null,
      superseded_ts: null,
    };
    this.rows.set(input.id, row);
    return { ...row };
  }

  async get(id: string): Promise<ConversationRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  /** Mirrors PgConversationStore.getByPrefix (EI-21914051456641891): a real
   *  `LIKE '<prefix>%'` prefix match, unbounded by the store's own limit —
   *  the CALLER (getConversationCore) is what decides "unique vs ambiguous". */
  async getByPrefix(prefix: string, limit = 5): Promise<ConversationRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.id.startsWith(prefix))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async list(opts: ListConversationsOpts = {}): Promise<ConversationRow[]> {
    this.listCalls.push({ ...opts });
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return [...this.rows.values()]
      .filter((r) => !opts.kind || r.kind === opts.kind)
      .filter((r) => !opts.scope || r.scope === opts.scope)
      .filter((r) => !opts.harness_slug || r.harness_slug === opts.harness_slug)
      .filter((r) => !opts.state || r.state === opts.state)
      .sort((a, b) => b.created_ts.localeCompare(a.created_ts))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async setState(id: string, state: ConversationState, opts: { now_ts: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.state = state;
    row.updated_ts = opts.now_ts;
    row.resolved_ts = state === 'resolved' ? opts.now_ts : null;
    if (state !== 'superseded') {
      row.superseded_by = null;
      row.superseded_ts = null;
    }
  }

  async supersede(
    id: string,
    replacement: CreateConversationInput,
    opts: { now_ts: string; expected_answer?: string },
  ): Promise<SupersedeStoreResult | SupersedeStoreError> {
    const old = this.rows.get(id);
    if (!old) return { error: 'not_found' };
    const resolvedAnswerMatches = old.state === 'resolved' &&
      opts.expected_answer != null &&
      old.accepted_answer === opts.expected_answer;
    if (old.state !== 'open' && !resolvedAnswerMatches) {
      return old.state === 'resolved'
        ? { error: 'source_changed', conversation: { ...old } }
        : { error: 'not_open', conversation: { ...old } };
    }
    const replacementRow = await this.create(replacement);
    old.state = 'superseded';
    old.superseded_by = replacementRow.id;
    old.superseded_ts = opts.now_ts;
    old.updated_ts = opts.now_ts;
    old.resolved_ts = null;
    old.accepted_answer = null;
    old.accepted_post_id = null;
    old.capture_target = null;
    return { conversation: { ...old }, replacement: replacementRow };
  }

  /** Mirrors PgConversationStore.closeIfOpen: compare-and-set open → closed. */
  async closeIfOpen(id: string, opts: { now_ts: string }): Promise<CloseIfOpenStoreResult | CloseIfOpenStoreError> {
    const row = this.rows.get(id);
    if (!row) return { error: 'not_found' };
    if (row.state !== 'open') return { error: 'not_open', conversation: { ...row } };
    row.state = 'closed';
    row.updated_ts = opts.now_ts;
    row.resolved_ts = null;
    return { ok: true, conversation: { ...row } };
  }

  async setAcceptedAnswer(
    id: string,
    input: { answer: string; post_id?: number | null; capture_target?: string | null; now_ts: string },
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.accepted_answer = input.answer;
    row.accepted_post_id = input.post_id ?? null;
    row.capture_target = input.capture_target ?? null;
    row.updated_ts = input.now_ts;
  }

  async setPromoted(id: string, input: { issue_id: string; now_ts: string }): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    row.promoted_issue_id = input.issue_id;
    row.state = 'closed';
    row.updated_ts = input.now_ts;
  }

  async touch(id: string, now_ts: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.updated_ts = now_ts;
  }
}

function makeSink(): { sink: InjectSink; inbox: Record<string, CoordEnvelope[]>; clear: () => void } {
  const inbox: Record<string, CoordEnvelope[]> = {};
  const sink: InjectSink = {
    async appendLine(_surface, writerKey, line) {
      (inbox[writerKey] ??= []).push(line);
    },
  };
  return { sink, inbox, clear: () => Object.keys(inbox).forEach((k) => delete inbox[k]) };
}

let store: InMemoryConversationStore;
let threads: InMemoryThreadStore;
let tags: InMemoryTaggableStore;
let subs: InMemoryEntitySubscriptionStore;
let topics: InMemoryTopicStore;
let sinkBox: ReturnType<typeof makeSink>;
let captureCalls: Array<Parameters<CaptureFn>[0]>;
let promotedIssues: Array<{
  title: string;
  body: string;
  scope?: string;
  topics?: string[];
  severity?: string;
  source?: string;
  foundDuring?: string;
}>;
let clock: { now: string };
let deps: ConversationDeps;

beforeEach(() => {
  store = new InMemoryConversationStore();
  threads = new InMemoryThreadStore();
  tags = new InMemoryTaggableStore(new InMemoryLinkStore());
  subs = new InMemoryEntitySubscriptionStore();
  topics = new InMemoryTopicStore();
  sinkBox = makeSink();
  captureCalls = [];
  promotedIssues = [];
  clock = { now: T0 };
  let idSeq = 0;
  deps = {
    conversations: store,
    threads,
    threadTxn: async (fn) => fn(threads),
    tags,
    subs,
    topics,
    sink: sinkBox.sink,
    capture: async (input) => {
      captureCalls.push(input);
      return { target: `${input.target}:${input.harness_slug ?? `workspace:${input.workspace_id}`}`, ok: true };
    },
    nowIso: () => clock.now,
    newId: (prefix) => `${prefix}-${++idSeq}`,
    promote: {
      createIssue: async (i) => {
        promotedIssues.push(i);
        return { id: `EI-${promotedIssues.length}`, title: i.title };
      },
      reparentThread: async () => ({ reparented: false }),
      issueThreadId: (id) => `issue-thread-${id}`,
    },
  };
});

describe('openConversationCore', () => {
  it('an untagged open is unrouted: delivered 0, unrouted true, deterministic thread, asker full-subscribed', async () => {
    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'who owns the cache?' });

    expect(res.unrouted).toBe(true);
    expect(res.delivered).toBe(0);
    expect(res.topics).toEqual([]);
    expect(res.thread_id).toBe(`thr-${res.conversation.id}`);
    expect(Object.keys(sinkBox.inbox)).toHaveLength(0);

    const rows = await subs.listTargetSubscribers('object', objectToTargetRef({ kind: 'conversation', ref: res.conversation.id }));
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriber_id).toBe('asker');
    expect(rows[0].delivery_mode).toBe('full');
  });

  it('normalizes topic slugs: trims, lowercases, dedupes, drops empties — tags persisted once each', async () => {
    const res = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'q',
      topics: ['  Zero-Cache ', 'zero-cache', 'OTHER', '', '   '],
    });
    expect(res.topics).toEqual(['zero-cache', 'other']);
    expect((await tags.listTags({ kind: 'conversation', ref: res.conversation.id })).sort()).toEqual(['other', 'zero-cache']);
  });

  it('harness_slug forces harness scope even over an explicit scope:"operator"; absent both → operator', async () => {
    const harness = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'q',
      scope: 'operator',
      harness_slug: 'papercup',
    });
    expect(harness.conversation.scope).toBe('harness');
    expect(harness.conversation.harness_slug).toBe('papercup');

    const plain = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q2' });
    expect(plain.conversation.scope).toBe('operator');
    expect(plain.conversation.harness_slug).toBeNull();
  });

  it('a discussion open notifies as discussion_opened with the 💬 rendering', async () => {
    await subs.subscribe({ subscriber_id: 'follower', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', title: 'design talk', topics: ['area'] });
    expect(sinkBox.inbox.follower).toHaveLength(1);
    expect(sinkBox.inbox.follower[0].notify_kind).toBe('discussion_opened');
    expect(sinkBox.inbox.follower[0].summary).toBe('💬 discussion: design talk');
  });

  it('an untitled open truncates the body into the summary (whitespace-collapsed, 120 chars + ellipsis)', async () => {
    await subs.subscribe({ subscriber_id: 'follower', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    const long = 'a'.repeat(150);
    await openConversationCore(deps, ident('asker'), { kind: 'question', body: long, topics: ['area'] });
    expect(sinkBox.inbox.follower[0].summary).toBe(`❓ question: ${'a'.repeat(119)}…`);

    sinkBox.clear();
    await openConversationCore(deps, ident('asker2'), { kind: 'question', body: '  line1\n\n line2  ', topics: ['area'] });
    expect(sinkBox.inbox.follower[0].summary).toBe('❓ question: line1 line2');
  });

  // Regression (fixed 2026-06-09): openConversationCore used to fan the OPEN
  // out without an excludeId. The fanout-before-self-subscribe ordering only
  // shields the asker's OBJECT subscription; an asker who already followed one
  // of the question's TOPICS was resolved as a topic subscriber and WAS
  // notified of their own question — violating the module's documented
  // contract. The open fan-out now passes identity.ownerId like every other
  // lifecycle fan-out in this module.
  it('an asker who already follows a tagged topic is NOT notified of their own question', async () => {
    await subs.subscribe({ subscriber_id: 'asker', target_kind: 'topic', target_ref: 'area', created_ts: T0 });
    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    expect(sinkBox.inbox.asker).toBeUndefined();
    expect(res.delivered).toBe(0);
  });

  it('a subscriber-resolution failure never breaks the open (best-effort fan-out → delivered 0)', async () => {
    const failing: SubscribableStore = {
      subscribe: (input) => subs.subscribe(input),
      unsubscribe: (a, b, c) => subs.unsubscribe(a, b, c),
      listSubscriptions: (id) => subs.listSubscriptions(id),
      listTargetSubscribers: async () => {
        throw new Error('pg down');
      },
    };
    deps.subs = failing;

    const res = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    expect(res.delivered).toBe(0);
    expect(res.conversation.state).toBe('open');
    // The write went through despite the delivery failure.
    expect(await store.get(res.conversation.id)).not.toBeNull();
    expect(Object.keys(sinkBox.inbox)).toHaveLength(0);
  });
});

describe('supersedeConversationCore', () => {
  it('does not let a peer retract another agent\'s owner-question gate', async () => {
    const old = await openConversationCore(deps, ident('original-asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'Can we ship the current release?',
    });

    const result = await supersedeConversationCore(deps, ident('different-agent'), {
      conversation_id: old.conversation.id,
      replacement: { body: 'Can we ship a different release?' },
    });

    expect(result).toEqual({ error: 'not_owner' });
    expect(await store.get(old.conversation.id)).toMatchObject({
      state: 'open',
      superseded_by: null,
    });
    expect(await store.list({ state: 'open' })).toHaveLength(1);
  });

  it('allows a recovered owner to retract only a question from the same validated plan lane', async () => {
    const old = await openConversationCore(deps, ident('original-asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      plan_slug: 'plan-a',
      work_item_id: 'WI-a',
      body: 'Which reviewer should handle this plan lane?',
    });

    const result = await supersedeConversationCore(deps, ident('recovered-owner'), {
      conversation_id: old.conversation.id,
      plan_slug: 'plan-a',
      work_item_id: 'WI-a',
      replacement: { body: 'Which reviewer should handle the recovered plan lane?' },
    });

    expect(result).not.toHaveProperty('error');
    expect((await store.get(old.conversation.id))?.state).toBe('superseded');
  });

  it('rejects a recovered owner whose plan or work-item provenance does not match', async () => {
    const old = await openConversationCore(deps, ident('original-asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      plan_slug: 'plan-a',
      work_item_id: 'WI-a',
      body: 'Which reviewer should handle this plan lane?',
    });

    const result = await supersedeConversationCore(deps, ident('unrelated-recovered-owner'), {
      conversation_id: old.conversation.id,
      plan_slug: 'plan-b',
      work_item_id: 'WI-b',
      replacement: { body: 'Unrelated correction' },
    });

    expect(result).toEqual({ error: 'not_owner' });
    expect((await store.get(old.conversation.id))?.state).toBe('open');
  });

  it('corrects a resolved owner question only when the exact accepted answer is supplied', async () => {
    const old = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'Which IAM scope should be used?',
    });
    const resolved = await resolveConversationCore(deps, ident(ADMIN_COORD_UI_OWNER), {
      conversation_id: old.conversation.id,
      accepted_answer: 'Use the existing read-only scope.',
    });
    if ('error' in resolved) throw new Error(resolved.error);

    const stale = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      expected_answer: 'Grant the extra permissions.',
      replacement: { body: 'Which scope should replace the accepted scope?' },
    });
    expect(stale).toEqual({ error: 'resolution_changed' });
    expect((await store.list()).map((row) => row.id)).toEqual([old.conversation.id]);

    const correction = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      expected_answer: 'Use the existing read-only scope.',
      replacement: { body: 'Which scope should replace the accepted scope?' },
    });
    if ('error' in correction) throw new Error(correction.error);
    expect(correction.conversation).toMatchObject({
      state: 'superseded',
      accepted_answer: null,
      accepted_post_id: null,
    });
    expect(correction.replacement.conversation).toMatchObject({ state: 'open' });
  });

  it('retires the old gate, points to an open replacement, and notifies old subscribers', async () => {
    const old = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'Is the old build still deployed?',
      title: 'Deployment check',
      topics: ['release'],
    });
    await subs.subscribe({
      subscriber_id: 'follower',
      target_kind: 'object',
      target_ref: objectToTargetRef({ kind: 'conversation', ref: old.conversation.id }),
      created_ts: T0,
    });
    sinkBox.clear();

    const result = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      reason: 'The build was promoted before the owner could answer.',
      replacement: {
        body: 'Is the newly promoted build deployed?',
        topics: ['release', 'deploy'],
      },
    });

    if ('error' in result) throw new Error(result.error);
    expect(result.conversation.state).toBe('superseded');
    expect(result.conversation.superseded_by).toBe(result.replacement.conversation.id);
    expect(result.replacement.conversation.state).toBe('open');
    expect(result.replacement.conversation.body).toBe('Is the newly promoted build deployed?');
    expect((await store.list({ state: 'open' })).map((r) => r.id)).toEqual([result.replacement.conversation.id]);
    expect((await tags.listTags({ kind: 'conversation', ref: result.replacement.conversation.id })).sort()).toEqual(['deploy', 'release']);
    expect(sinkBox.inbox.follower?.[0]).toMatchObject({
      notify_kind: 'conversation_superseded',
      superseded_by: result.replacement.conversation.id,
    });
    expect(await postReplyCore(deps, ident('latecomer'), { conversation_id: old.conversation.id, body: 'stale reply' })).toEqual({
      error: 'superseded',
    });
  });

  it('rejects a second supersession and a blank replacement without changing the gate', async () => {
    const old = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'original' });
    expect(await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      replacement: { body: 'corrected' },
    })).not.toHaveProperty('error');
    expect(await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      replacement: { body: 'another correction' },
    })).toEqual({ error: 'already_superseded' });

    const fresh = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'fresh' });
    expect(await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: fresh.conversation.id,
      replacement: { body: '   ' },
    })).toEqual({ error: 'invalid_replacement' });
    expect((await store.get(fresh.conversation.id))?.state).toBe('open');
  });
});

describe('withdrawConversationCore (WI-6554700010012347)', () => {
  it('lets the asker close an owner question with no answer, no capture and no replacement', async () => {
    const old = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'Should I fix the 502 now?',
    });
    await subs.subscribe({
      subscriber_id: 'follower',
      target_kind: 'object',
      target_ref: objectToTargetRef({ kind: 'conversation', ref: old.conversation.id }),
      created_ts: T0,
    });
    sinkBox.clear();

    const result = await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      reason: 'The owner told me to fix it in chat.',
    });

    if ('error' in result) throw new Error(result.error);
    expect(result.conversation).toMatchObject({
      state: 'closed',
      accepted_answer: null,
      accepted_post_id: null,
      superseded_by: null,
      resolved_ts: null,
    });
    expect(captureCalls).toEqual([]);
    expect(await store.list()).toHaveLength(1);
    const posts = await threads.listPosts(`thr-${old.conversation.id}`);
    expect(posts.map((p) => ({ author: p.author_id, body: p.body }))).toEqual([
      { author: 'asker', body: 'Withdrawn by the asker: The owner told me to fix it in chat.' },
    ]);
    expect(result.reasonPostId).toBe(posts[0]!.id);
    expect(result.delivered).toBe(1);
    expect(sinkBox.inbox.follower?.[0]).toMatchObject({
      notify_kind: 'conversation_withdrawn',
      withdrawn_reason: 'The owner told me to fix it in chat.',
    });
    expect(sinkBox.inbox.asker).toBeUndefined();
    expect(await postReplyCore(deps, ident('latecomer'), { conversation_id: old.conversation.id, body: 'late' })).toEqual({
      error: 'closed',
    });
  });

  it('refuses a peer, leaving the gate open', async () => {
    const old = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'mine' });
    expect(await withdrawConversationCore(deps, ident('peer'), {
      conversation_id: old.conversation.id,
      reason: 'not my question',
    })).toEqual({ error: 'not_owner' });
    expect((await store.get(old.conversation.id))?.state).toBe('open');
  });

  it('refuses a blank reason, an unknown id, a consult, and an already-terminal conversation', async () => {
    const open = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q' });
    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: open.conversation.id,
      reason: '   ',
    })).toEqual({ error: 'invalid_reason' });
    expect((await store.get(open.conversation.id))?.state).toBe('open');

    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: 'conv-missing',
      reason: 'gone',
    })).toEqual({ error: 'not_found' });

    const consult = await openConversationCore(deps, ident('asker'), { kind: 'consult', body: 'q' });
    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: consult.conversation.id,
      reason: 'moot',
    })).toEqual({ error: 'consult_requires_typed_verb' });

    const answered = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'peer q' });
    const resolved = await resolveConversationCore(deps, ident('peer'), {
      conversation_id: answered.conversation.id,
      accepted_answer: 'yes',
    });
    if ('error' in resolved) throw new Error(resolved.error);
    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: answered.conversation.id,
      reason: 'too late',
    })).toEqual({ error: 'already_terminal', state: 'resolved' });
    expect((await store.get(answered.conversation.id))?.accepted_answer).toBe('yes');
  });

  it('a second withdraw reports already_terminal instead of closing twice', async () => {
    const old = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q' });
    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      reason: 'moot',
    })).not.toHaveProperty('error');
    expect(await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      reason: 'moot again',
    })).toEqual({ error: 'already_terminal', state: 'closed' });
    expect(await threads.listPosts(`thr-${old.conversation.id}`)).toHaveLength(1);
  });

  it('still closes when the best-effort reason post fails', async () => {
    const old = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q' });
    deps.threadTxn = async () => {
      throw new Error('thread write stalled');
    };
    const result = await withdrawConversationCore(deps, ident('asker'), {
      conversation_id: old.conversation.id,
      reason: 'moot',
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.reasonPostId).toBeNull();
    expect((await store.get(old.conversation.id))?.state).toBe('closed');
  });
});

describe('postReplyCore', () => {
  it('a reply notifies as conversation_post, excludes the poster, auto-joins them, and touches the row', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    sinkBox.clear();

    clock.now = '2030-01-01T01:00:00.000Z';
    const res = await postReplyCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'a thought' });
    if ('error' in res) throw new Error(res.error);

    expect(res.post.body).toBe('a thought');
    expect(sinkBox.inbox.asker).toHaveLength(1);
    expect(sinkBox.inbox.asker[0].notify_kind).toBe('conversation_post');
    expect(sinkBox.inbox.asker[0].summary).toContain('💬 reply');
    expect(sinkBox.inbox.replier).toBeUndefined();

    const objSubs = await subs.listTargetSubscribers('object', objectToTargetRef({ kind: 'conversation', ref: opened.conversation.id }));
    expect(objSubs.map((s) => s.subscriber_id).sort()).toEqual(['asker', 'replier']);

    // touch-on-activity: updated_ts advanced to the post's clock.
    expect((await store.get(opened.conversation.id))?.updated_ts).toBe('2030-01-01T01:00:00.000Z');
  });

  it('resolves a unique truncated id before posting to the canonical conversation', async () => {
    const canonicalId = 'conv-mtg3t543-0000-7f6b6e8460be4af0b94dbfc0f6858f00';
    await store.create({
      id: canonicalId,
      kind: 'discussion',
      scope: 'operator',
      asker_id: 'asker',
      body: 'seed conversation',
      producer: 'test',
      created_ts: T0,
    });

    const result = await postReplyCore(deps, ident('replier'), {
      conversation_id: 'conv-mtg3t543',
      body: 'reply through truncated id',
    });
    if ('error' in result) throw new Error(result.error);

    expect(result.post.thread_id).toBe(`thr-${canonicalId}`);
    expect((await threads.listPosts(`thr-${canonicalId}`)).map((post) => post.body)).toEqual([
      'reply through truncated id',
    ]);
  });

  it('lazily creates the deterministic thread when the conversation row exists without one', async () => {
    await store.create({
      id: 'conv-bare',
      kind: 'discussion',
      scope: 'operator',
      asker_id: 'someone',
      body: 'created off-path, no thread',
      producer: 'test',
      created_ts: T0,
    });
    expect(await threads.getThreadByParent({ kind: 'conversation', ref: 'conv-bare' })).toBeNull();

    const res = await postReplyCore(deps, ident('replier'), { conversation_id: 'conv-bare', body: 'first post' });
    if ('error' in res) throw new Error(res.error);

    const thread = await threads.getThreadByParent({ kind: 'conversation', ref: 'conv-bare' });
    expect(thread?.thread_id).toBe('thr-conv-bare');
    expect((await threads.listPosts('thr-conv-bare')).map((p) => p.body)).toEqual(['first post']);
  });

  it('plumbs mentions through the mention-mode gate: only the @-mentioned mention-mode follower receives', async () => {
    await subs.subscribe({ subscriber_id: 'pinged', target_kind: 'topic', target_ref: 'area', delivery_mode: 'mention', created_ts: T0 });
    await subs.subscribe({ subscriber_id: 'quiet', target_kind: 'topic', target_ref: 'area', delivery_mode: 'mention', created_ts: T0 });
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    sinkBox.clear();

    const res = await postReplyCore(deps, ident('replier'), {
      conversation_id: opened.conversation.id,
      body: 'cc @pinged',
      mentions: ['pinged'],
    });
    if ('error' in res) throw new Error(res.error);

    expect(sinkBox.inbox.pinged).toHaveLength(1);
    expect(sinkBox.inbox.pinged[0].notify_kind).toBe('conversation_post');
    expect(sinkBox.inbox.quiet).toBeUndefined();
  });

  it('returns not_found for an unknown conversation', async () => {
    expect(await postReplyCore(deps, ident('x'), { conversation_id: 'nope', body: 'b' })).toEqual({ error: 'not_found' });
  });
});

describe('the consult kind gate (get-feedback-relevance-consults P-004, D-008 §2)', () => {
  it('refuses an untyped reply into a kind=consult conversation — every route lands here', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });
    expect(await postReplyCore(deps, ident('responder'), { conversation_id: opened.conversation.id, body: 'untyped' })).toEqual({
      error: 'consult_requires_typed_verb',
    });
    // conversations:answer routes through the same chokepoint.
    expect(await answerQuestionCore(deps, ident('responder'), { conversation_id: opened.conversation.id, body: 'untyped answer' })).toEqual({
      error: 'consult_requires_typed_verb',
    });
    // Nothing entered the thread.
    expect((await threads.listPosts(`thr-${opened.conversation.id}`))).toEqual([]);
  });

  it('the internal via_consult_verb opt-in (set only by the consult verbs) passes the gate', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });
    const res = await postReplyCore(deps, ident('responder'), {
      conversation_id: opened.conversation.id,
      body: 'typed via verb',
      via_consult_verb: true,
    });
    if ('error' in res) throw new Error(res.error);
    expect(res.post.body).toBe('typed via verb');
  });

  it('keeps an expired consult terminal for generic posts while allowing the typed seam', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });
    await store.setState(opened.conversation.id, 'expired', { now_ts: '2030-01-01T01:00:00.000Z' });

    expect(await postReplyCore(deps, ident('requester'), {
      conversation_id: opened.conversation.id,
      body: 'untyped late post',
    })).toEqual({ error: 'consult_requires_typed_verb' });

    const typed = await postReplyCore(deps, ident('requester'), {
      conversation_id: opened.conversation.id,
      body: 'typed late disposition',
      via_consult_verb: true,
    });
    if ('error' in typed) throw new Error(typed.error);
    expect(typed.post.body).toBe('typed late disposition');
  });

  it('non-consult conversations are untouched by the gate', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b' });
    const res = await postReplyCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'plain' });
    if ('error' in res) throw new Error(res.error);
    expect(res.post.body).toBe('plain');
  });
  it('appends a settled consult disposition only through the internal typed marker, without lifecycle or notification changes', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });
    const conversation_id = opened.conversation.id;
    await store.setState(conversation_id, 'resolved', { now_ts: '2030-01-01T01:00:00.000Z' });
    const before = await store.get(conversation_id);
    const inbox = structuredClone(sinkBox.inbox);
    expect(await postReplyCore(deps, ident('requester'), { conversation_id, body: 'untyped',
      settled_review_disposition: true })).toEqual({ error: 'consult_requires_typed_verb' });
    expect(await postReplyCore(deps, ident('requester'), { conversation_id, body: 'ordinary typed reply',
      via_consult_verb: true })).toEqual({ error: 'resolved' });
    const result = await postReplyCore(deps, ident('requester'), { conversation_id, body: 'finding planned',
      via_consult_verb: true, settled_review_disposition: true });
    expect(result).toMatchObject({ post: { body: 'finding planned' }, delivered: 0 });
    expect(await store.get(conversation_id)).toEqual(before);
    expect(sinkBox.inbox).toEqual(inbox);
    expect(await threads.listPosts(`thr-${conversation_id}`)).toHaveLength(1);
  });
  it.each(['question', 'discussion'] as const)('the settled review marker cannot append to a resolved %s', async (kind) => {
    const opened = await openConversationCore(deps, ident('requester'), { kind, body: 'q' });
    const conversation_id = opened.conversation.id;
    await store.setState(conversation_id, 'resolved', { now_ts: '2030-01-01T01:00:00.000Z' });
    expect(await postReplyCore(deps, ident('requester'), { conversation_id, body: 'late',
      via_consult_verb: true, settled_review_disposition: true })).toEqual({ error: 'resolved' });
    expect(await threads.listPosts(`thr-${conversation_id}`)).toHaveLength(0);
  });
});

describe('resolveConversationCore', () => {
  it('refuses generic resolution for consults: typed close owns the lifecycle and no capture/state write occurs', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });

    const res = await resolveConversationCore(deps, ident('requester'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'untyped answer',
    });

    expect(res).toEqual({ error: 'consult_requires_typed_verb' });
    expect(captureCalls).toHaveLength(0);
    expect(await store.get(opened.conversation.id)).toMatchObject({
      kind: 'consult',
      state: 'open',
      accepted_answer: null,
    });
  });

  it('a whitespace-only accepted_answer is no_answer: no capture, no state flip', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: '   \n  ',
    });
    expect(res).toEqual({ error: 'no_answer' });
    expect(captureCalls).toHaveLength(0);
    expect((await store.get(opened.conversation.id))?.state).toBe('open');
  });

  it('refuses to resolve an owner question from an agent-authored reply', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'May this role receive the additional IAM permissions?',
    });
    sinkBox.clear();
    const agentAnswer = await answerQuestionCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      body: 'Grant the extra permissions.',
    });
    if ('error' in agentAnswer) throw new Error(agentAnswer.error);
    expect(agentAnswer.author_origin).toBe('agent');
    expect(agentAnswer.owner_decision_effect).toBe('peer-opinion');
    expect(sinkBox.inbox.asker[0]).toMatchObject({
      author_origin: 'agent',
      owner_decision_effect: 'peer-opinion',
    });
    expect(sinkBox.inbox.asker[0].summary).toContain('peer opinion; not the owner\'s decision');

    const result = await resolveConversationCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: agentAnswer.post.id,
    });

    expect(result).toEqual({ error: 'owner_answer_required' });
    expect(captureCalls).toHaveLength(0);
    expect(await store.get(opened.conversation.id)).toMatchObject({
      state: 'open',
      accepted_answer: null,
      accepted_post_id: null,
    });
  });

  it('requires the accepted answer to match the owner-authored decision post', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'May this role receive the additional IAM permissions?',
    });
    const ownerAnswer = await answerQuestionCore(deps, ident(ADMIN_COORD_UI_OWNER), {
      conversation_id: opened.conversation.id,
      body: 'Keep the existing read-only scope.',
    });
    if ('error' in ownerAnswer) throw new Error(ownerAnswer.error);
    expect(ownerAnswer.author_origin).toBe('owner-typed');
    expect(ownerAnswer.owner_decision_effect).toBe('owner-typed-reply');

    const mismatch = await resolveConversationCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'Grant the extra permissions.',
      accepted_post_id: ownerAnswer.post.id,
    });
    expect(mismatch).toEqual({ error: 'owner_answer_mismatch' });
    expect((await store.get(opened.conversation.id))?.state).toBe('open');

    const result = await resolveConversationCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: ownerAnswer.post.id,
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.conversation).toMatchObject({
      state: 'resolved',
      accepted_answer: 'Keep the existing read-only scope.',
      accepted_post_id: ownerAnswer.post.id,
    });
  });

  it('records an owner-authored post when the owner resolves with direct accepted_answer text', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      producer: 'coord:ask-owner',
      body: 'Which IAM scope should be used?',
    });
    const result = await resolveConversationCore(deps, ident(ADMIN_COORD_UI_OWNER), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'Use the existing read-only scope.',
    });
    if ('error' in result) throw new Error(result.error);

    const detail = await getConversationCore(deps, opened.conversation.id);
    expect(detail?.posts).toContainEqual(expect.objectContaining({
      id: result.conversation.accepted_post_id,
      author_id: ADMIN_COORD_UI_OWNER,
      body: 'Use the existing read-only scope.',
    }));
  });

  it('an explicit accepted_answer wins over accepted_post_id (trimmed; the post id is still recorded)', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const ans = await answerQuestionCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'post body answer' });
    if ('error' in ans) throw new Error(ans.error);

    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: '  the explicit answer  ',
      accepted_post_id: ans.post.id,
    });
    if ('error' in res) throw new Error(res.error);

    expect(res.conversation.accepted_answer).toBe('the explicit answer');
    expect(res.conversation.accepted_post_id).toBe(ans.post.id);
    expect(captureCalls[0].answer).toBe('the explicit answer');
  });

  it('when a peer resolves, the asker IS notified (only the resolver is excluded) and capture records both ids', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const ans = await answerQuestionCore(deps, ident('resolver'), { conversation_id: opened.conversation.id, body: 'the fix' });
    if ('error' in ans) throw new Error(ans.error);
    sinkBox.clear();

    const res = await resolveConversationCore(deps, ident('resolver'), {
      conversation_id: opened.conversation.id,
      accepted_post_id: ans.post.id,
    });
    if ('error' in res) throw new Error(res.error);

    expect(sinkBox.inbox.asker).toHaveLength(1);
    expect(sinkBox.inbox.asker[0].notify_kind).toBe('conversation_resolved');
    expect(sinkBox.inbox.resolver).toBeUndefined();
    expect(captureCalls[0].asker_id).toBe('asker');
    expect(captureCalls[0].resolver_id).toBe('resolver');
  });

  it('defaults the capture target to mem0 when none is given', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const res = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'done',
    });
    if ('error' in res) throw new Error(res.error);
    expect(captureCalls[0].target).toBe('mem0');
    expect(res.conversation.capture_target).toBe('mem0:workspace:default');
  });
});

describe('settleConsultConversationCore', () => {
  it('answered close makes conversations:get read a resolved row with the terminal answer/post', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });

    await settleConsultConversationCore(deps, {
      conversation_id: opened.conversation.id,
      outcome: 'answered',
      answer: '  the grounded answer  ',
      post_id: 42,
      now_ts: '2030-01-01T01:00:00.000Z',
    });

    const detail = await getConversationCore(deps, opened.conversation.id);
    expect(detail?.conversation).toMatchObject({
      state: 'resolved',
      accepted_answer: 'the grounded answer',
      accepted_post_id: 42,
    });
    expect(detail?.conversation.resolved_ts).toBe('2030-01-01T01:00:00.000Z');
  });

  it.each(['cant_help', 'graduate'] as const)('%s close makes conversations:get read a closed row', async (outcome) => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });

    await settleConsultConversationCore(deps, {
      conversation_id: opened.conversation.id,
      outcome,
      post_id: 42,
      now_ts: '2030-01-01T01:00:00.000Z',
    });

    const detail = await getConversationCore(deps, opened.conversation.id);
    expect(detail?.conversation.state).toBe('closed');
    expect(detail?.conversation.resolved_ts).toBeNull();
  });
});

describe('join / leave', () => {
  it('refuses generic joins for consults because participation is router-assigned', async () => {
    const opened = await openConversationCore(deps, ident('requester'), { kind: 'consult', body: 'q' });

    const joined = await joinConversationCore(deps, ident('joiner'), { conversation_id: opened.conversation.id });

    expect(joined).toEqual({ error: 'consult_participation_router_assigned' });
    expect(await subs.listSubscriptions('joiner')).toHaveLength(0);
  });

  it('join honors the requested mode and converts ttl_sec into expires_ts off the injected clock', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });

    const joined = await joinConversationCore(deps, ident('joiner'), {
      conversation_id: opened.conversation.id,
      mode: 'digest',
      ttl_sec: 3600,
    });
    expect(joined).toEqual({ ok: true, mode: 'digest' });

    const rows = await subs.listSubscriptions('joiner');
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_mode).toBe('digest');
    expect(rows[0].expires_ts).toBe('2030-01-01T01:00:00.000Z'); // T0 + 3600s

    // Defaults: full mode, no expiry.
    const def = await joinConversationCore(deps, ident('joiner2'), { conversation_id: opened.conversation.id });
    expect(def).toEqual({ ok: true, mode: 'full' });
    expect((await subs.listSubscriptions('joiner2'))[0].expires_ts).toBeNull();
  });

  it('leave unsubscribes: a later fan-out no longer reaches the leaver', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    await joinConversationCore(deps, ident('lurker'), { conversation_id: opened.conversation.id });
    await leaveConversationCore(deps, ident('lurker'), opened.conversation.id);
    sinkBox.clear();

    const res = await answerQuestionCore(deps, ident('replier'), { conversation_id: opened.conversation.id, body: 'a' });
    if ('error' in res) throw new Error(res.error);
    expect(sinkBox.inbox.lurker).toBeUndefined();
    expect(sinkBox.inbox.asker).toHaveLength(1);
  });

  // P2-19: join is an UPSERT — a re-join (different mode + ttl) must NOT spawn a
  // second subscription row; it re-points the existing one (the InMemory double
  // mirrors PgEntitySubscriptionStore's active-row upsert). Only fresh-join was
  // covered before.
  it('re-joining updates the single subscription in place (mode + ttl) instead of adding a row', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });

    const first = await joinConversationCore(deps, ident('rejoiner'), { conversation_id: opened.conversation.id });
    expect(first).toEqual({ ok: true, mode: 'full' });
    let rows = await subs.listSubscriptions('rejoiner');
    expect(rows).toHaveLength(1);
    expect(rows[0].delivery_mode).toBe('full');
    expect(rows[0].expires_ts).toBeNull();

    // Re-join in digest with a TTL — same target, so it upserts the one row.
    const second = await joinConversationCore(deps, ident('rejoiner'), {
      conversation_id: opened.conversation.id,
      mode: 'digest',
      ttl_sec: 3600,
    });
    expect(second).toEqual({ ok: true, mode: 'digest' });

    rows = await subs.listSubscriptions('rejoiner');
    expect(rows).toHaveLength(1); // ONE row, not two
    expect(rows[0].delivery_mode).toBe('digest'); // mode flipped
    expect(rows[0].expires_ts).toBe('2030-01-01T01:00:00.000Z'); // TTL applied (T0 + 3600s)
  });
});

// P1-17: a conversation in a terminal state (resolved / promoted-closed) must
// not silently re-run capture or take more posts. Before the guard, a SECOND
// resolve re-ran capture and OVERWROTE the accepted answer (a real corruption
// bug), and a post landed on a resolved row as if it were live.
describe('terminal-state guards (P1-17)', () => {
  it('a second resolve is rejected (already_resolved): capture runs ONCE, the accepted answer stays A', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    const first = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'answer A',
    });
    if ('error' in first) throw new Error(first.error);
    expect(captureCalls).toHaveLength(1);
    expect(first.conversation.accepted_answer).toBe('answer A');

    const second = await resolveConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'answer B',
    });
    expect(second).toEqual({ error: 'already_resolved' });

    // Capture was NOT re-run, and the original accepted answer survives.
    expect(captureCalls).toHaveLength(1);
    const row = await store.get(opened.conversation.id);
    expect(row?.accepted_answer).toBe('answer A');
    expect(row?.state).toBe('resolved');
  });

  it('a reply onto a resolved conversation is rejected (resolved) — the thread does not grow', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'question', body: 'q', topics: ['area'] });
    await resolveConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id, accepted_answer: 'done' });

    const thread = await threads.getThreadByParent({ kind: 'conversation', ref: opened.conversation.id });
    const before = thread ? (await threads.listPosts(thread.thread_id)).length : 0;

    const res = await postReplyCore(deps, ident('latecomer'), { conversation_id: opened.conversation.id, body: 'late reply' });
    expect(res).toEqual({ error: 'resolved' });

    // No post appended, state unchanged.
    const after = thread ? (await threads.listPosts(thread.thread_id)).length : 0;
    expect(after).toBe(before);
    expect((await store.get(opened.conversation.id))?.state).toBe('resolved');
  });

  it('an answer onto a promoted (closed) conversation is rejected (closed)', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    const promoted = await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id });
    if ('error' in promoted) throw new Error(promoted.error);
    expect((await store.get(opened.conversation.id))?.state).toBe('closed');

    const res = await answerQuestionCore(deps, ident('latecomer'), { conversation_id: opened.conversation.id, body: 'too late' });
    expect(res).toEqual({ error: 'closed' });
  });
});

describe('listConversationsWithTopicsCore', () => {
  it('a topic filter pages WIDE (store limit 200) then narrows + re-limits, so a match is not lost behind the caller limit', async () => {
    // Older conversation carries the topic; a NEWER untagged one would otherwise
    // fill a limit-1 scalar page and hide it.
    const tagged = await openConversationCore(deps, ident('a'), { kind: 'question', body: 'tagged', topics: ['area'] });
    clock.now = '2030-01-01T02:00:00.000Z';
    await openConversationCore(deps, ident('a'), { kind: 'question', body: 'newer untagged' });
    store.listCalls = [];

    const rows = await listConversationsWithTopicsCore(deps, { topic: ' AREA ', limit: 1 });
    expect(rows.map((r) => r.id)).toEqual([tagged.conversation.id]);
    expect(rows[0].topics).toEqual(['area']);
    expect(store.listCalls).toEqual([{ limit: 200 }]);

    // Without a topic filter the caller's limit goes straight to the store.
    store.listCalls = [];
    const page = await listConversationsWithTopicsCore(deps, { limit: 1 });
    expect(page.map((r) => r.body)).toEqual(['newer untagged']);
    expect(store.listCalls).toEqual([{ limit: 1 }]);
  });

  it('ignores non-conversation objects tagged with the same topic', async () => {
    const conv = await openConversationCore(deps, ident('a'), { kind: 'question', body: 'q', topics: ['area'] });
    await tags.addTag({ kind: 'issue', ref: 'EI-9' }, 'area', { created_ts: T0 });

    const rows = await listConversationsWithTopicsCore(deps, { topic: 'area' });
    expect(rows.map((r) => r.id)).toEqual([conv.conversation.id]);
  });

  it('returns [] when nothing matches', async () => {
    expect(await listConversationsWithTopicsCore(deps, { topic: 'unused' })).toEqual([]);
  });
});

describe('getConversationCore', () => {
  it('returns null for a missing id', async () => {
    expect(await getConversationCore(deps, 'nope')).toBeNull();
  });

  it('a thread-less off-path row reads back with empty posts/topics and zero subscribers', async () => {
    await store.create({ id: 'conv-bare', kind: 'discussion', scope: 'operator', asker_id: 'a', body: 'b', producer: 'test', created_ts: T0 });
    const detail = await getConversationCore(deps, 'conv-bare');
    expect(detail?.conversation.id).toBe('conv-bare');
    expect(detail?.posts).toEqual([]);
    expect(detail?.topics).toEqual([]);
    expect(detail?.subscriber_count).toBe(0);
  });

  /**
   * EI-21914051456641891: a real conversation id is minted as
   * `<prefix>-<8charMs>-<4charSeq>-<32hexUuid>` (three hyphen-delimited
   * segments after the prefix). A durable citation (a plan `## Now`, a
   * rubric methodRef) commonly gets hand-truncated to just the leading
   * `<prefix>-<ms>` segment — which LOOKS like a complete short id on its
   * own — and an exact-match lookup on that truncated form used to return a
   * clean `not_found`, indistinguishable from genuine absence. These pin the
   * fallback: resolve when the truncated form UNIQUELY prefix-matches one
   * real id, and — critically — NEVER guess when it is ambiguous or truly
   * absent.
   */
  describe('prefix-fallback (EI-21914051456641891)', () => {
    it('resolves a hand-truncated id that uniquely prefix-matches one real conversation, and flags resolvedFromPrefix', async () => {
      await store.create({
        id: 'conv-mtg3t543-0000-7f6b6e8460be4af0b94dbfc0f6858f00',
        kind: 'consult',
        scope: 'operator',
        asker_id: 'a',
        body: 'the seed',
        producer: 'test',
        created_ts: T0,
      });
      const detail = await getConversationCore(deps, 'conv-mtg3t543');
      expect(detail).not.toBeNull();
      // The conversation itself is the REAL, full id — never the truncated request.
      expect(detail?.conversation.id).toBe('conv-mtg3t543-0000-7f6b6e8460be4af0b94dbfc0f6858f00');
      expect(detail?.resolvedFromPrefix).toBe('conv-mtg3t543');
    });

    it('an EXACT match wins outright — no prefix fallback attempted, no resolvedFromPrefix flag', async () => {
      await store.create({ id: 'conv-exact', kind: 'discussion', scope: 'operator', asker_id: 'a', body: 'b', producer: 'test', created_ts: T0 });
      const detail = await getConversationCore(deps, 'conv-exact');
      expect(detail?.conversation.id).toBe('conv-exact');
      expect(detail?.resolvedFromPrefix).toBeUndefined();
    });

    it('AMBIGUOUS prefix (matches ≥2 real ids) returns null — never guesses which one was meant', async () => {
      await store.create({ id: 'conv-mtg9-aaaa', kind: 'discussion', scope: 'operator', asker_id: 'a', body: 'b', producer: 'test', created_ts: T0 });
      await store.create({ id: 'conv-mtg9-bbbb', kind: 'discussion', scope: 'operator', asker_id: 'a', body: 'b', producer: 'test', created_ts: T0 });
      expect(await getConversationCore(deps, 'conv-mtg9')).toBeNull();
    });

    it('a truncated id with NO real match still returns null (genuine absence, not a crash)', async () => {
      expect(await getConversationCore(deps, 'conv-totally-bogus')).toBeNull();
    });
  });
});

/**
 * EI-21462599108204160 — attribution must SURVIVE the answer.
 *
 * Before `producer`, the only record of which tool opened a conversation was the
 * Decision-tier escalation twin that `coord:ask-owner` writes alongside it. That
 * twin is CLOSED when the question is answered (correctly — it is the
 * EI-19399318647145782 zombie fix). So attribution existed only while a question
 * was unanswered, and "what fraction of owner asks get answered" — the one number
 * the table is asked for — was structurally uncomputable: every row that would
 * have counted in the numerator had destroyed its own attribution on the way in.
 *
 * These tests pin the property that fixes it: the producer is written at open
 * time and is untouched by every later lifecycle transition.
 */
describe('conversation producer attribution (EI-21462599108204160)', () => {
  it('records the producer the caller declared at open time', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'did you approve this?',
      producer: 'coord:ask-owner',
    });
    expect((await store.get(opened.conversation.id))?.producer).toBe('coord:ask-owner');
  });

  it('THE DEFECT: the producer survives resolution — an ANSWERED ask is still attributable', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'q',
      producer: 'coord:ask-owner',
    });
    const res = await resolveConversationCore(deps, ident(ADMIN_COORD_UI_OWNER), {
      conversation_id: opened.conversation.id,
      accepted_answer: 'yes',
    });
    expect('error' in res).toBe(false);

    const row = await store.get(opened.conversation.id);
    // The state DID flip — otherwise this asserts attribution survives a
    // transition that never happened, which is how a guard passes vacuously.
    expect(row?.state).toBe('resolved');
    expect(row?.accepted_answer).toBe('yes');
    expect(row?.producer).toBe('coord:ask-owner');
  });

  it('keeps producers DISTINCT across resolved rows, so answer-rate-per-tool is computable', async () => {
    // The control that makes the two tests above non-vacuous: if `producer` were
    // dropped on the write path, defaulted, or overwritten by the lifecycle, this
    // group-by collapses and the count this column exists to serve is wrong.
    const ownerAsk = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'owner q',
      producer: 'coord:ask-owner',
    });
    const peerAsk = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'peer q',
      producer: 'coord:ask',
    });
    const consult = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'consult q',
      producer: 'consult:get_feedback',
    });

    // Answer two of the three; the unanswered one must stay attributable too.
    for (const c of [ownerAsk, peerAsk]) {
      const resolver = c === ownerAsk ? ADMIN_COORD_UI_OWNER : 'asker';
      const r = await resolveConversationCore(deps, ident(resolver), {
        conversation_id: c.conversation.id,
        accepted_answer: 'answered',
      });
      expect('error' in r).toBe(false);
    }

    const rows = await Promise.all(
      [ownerAsk, peerAsk, consult].map((c) => store.get(c.conversation.id)),
    );
    expect(rows.map((r) => [r?.producer, r?.state])).toEqual([
      ['coord:ask-owner', 'resolved'],
      ['coord:ask', 'resolved'],
      ['consult:get_feedback', 'open'],
    ]);
  });

  it('a superseding replacement INHERITS the original producer, not the supersede verb', async () => {
    const opened = await openConversationCore(deps, ident('asker'), {
      kind: 'question',
      body: 'original',
      producer: 'coord:ask-owner',
    });
    const res = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: opened.conversation.id,
      replacement: { body: 'the premise changed' },
    });
    if ('error' in res) throw new Error(res.error);

    // Retract-and-re-ask is the SAME tool asking again. Attributing the
    // replacement to `conversations:supersede` would lose the attribution
    // precisely when a question is re-asked, which is when it matters most.
    expect((await store.get(res.replacement.conversation.id))?.producer).toBe('coord:ask-owner');
  });

  it('preserves the owner gate for an unattributed legacy question', async () => {
    // Models a row opened before this column existed, or federated from a peer
    // running older code — the only way a live row carries a NULL producer.
    await store.create({
      id: 'conv-legacy',
      kind: 'question',
      scope: 'operator',
      asker_id: 'asker',
      body: 'pre-attribution row',
      producer: 'test',
      created_ts: T0,
    });
    const legacy = await store.get('conv-legacy');
    if (!legacy) throw new Error('fixture missing');
    legacy.producer = null;
    store.rows.set('conv-legacy', legacy);

    const res = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: 'conv-legacy',
      replacement: { body: 'replacement' },
    });
    if ('error' in res) throw new Error(res.error);
    expect((await store.get(res.replacement.conversation.id))?.producer).toBe('coord:ask-owner');
    expect(await resolveConversationCore(deps, ident('different-agent'), {
      conversation_id: res.replacement.conversation.id,
      accepted_answer: 'agent decision',
    })).toEqual({ error: 'owner_answer_required' });
  });

  it('uses the supersede producer for an unattributed legacy discussion', async () => {
    await store.create({
      id: 'legacy-discussion',
      kind: 'discussion',
      scope: 'operator',
      asker_id: 'asker',
      body: 'pre-attribution discussion',
      producer: 'test',
      created_ts: T0,
    });
    const legacy = await store.get('legacy-discussion');
    if (!legacy) throw new Error('fixture missing');
    legacy.producer = null;
    store.rows.set('legacy-discussion', legacy);

    const res = await supersedeConversationCore(deps, ident('asker'), {
      conversation_id: 'legacy-discussion',
      replacement: { body: 'replacement discussion' },
    });
    if ('error' in res) throw new Error(res.error);
    expect((await store.get(res.replacement.conversation.id))?.producer).toBe('conversations:supersede');
  });
});

describe('promoteConversationCore', () => {
  it('returns promote_unavailable when no issues bridge is injected', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    deps.promote = undefined;
    expect(await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id })).toEqual({
      error: 'promote_unavailable',
    });
    expect((await store.get(opened.conversation.id))?.state).toBe('open');
  });

  it('input.harness forces a harness:<slug> issue scope for an operator-scope conversation', async () => {
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body: 'b', topics: ['area'] });
    const res = await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id, harness: 'pcup' });
    if ('error' in res) throw new Error(res.error);
    expect(promotedIssues[0].scope).toBe('harness:pcup');
  });

  it('an operator conversation without a forced harness mints an operator-scope issue, falling back to the truncated body as title', async () => {
    const body = `${'long problem statement '.repeat(10)}end`;
    const opened = await openConversationCore(deps, ident('asker'), { kind: 'discussion', body, topics: ['area'] });
    const res = await promoteConversationCore(deps, ident('asker'), { conversation_id: opened.conversation.id });
    if ('error' in res) throw new Error(res.error);

    expect(promotedIssues[0].scope).toBe('operator');
    // Untitled → title is the whitespace-collapsed body truncated to 120 chars.
    const collapsed = body.trim().replace(/\s+/g, ' ');
    expect(promotedIssues[0].title).toBe(`${collapsed.slice(0, 119)}…`);
    expect(promotedIssues[0].title).toHaveLength(120);
    expect(res.conversation.state).toBe('closed');
    expect(res.conversation.promoted_issue_id).toBe('EI-1');
  });
});
