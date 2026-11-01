/**
 * topics-core.test.ts — the topic workflow logic, pure over injected stores + an
 * inject sink. Driven with the REAL in-memory capability doubles (InMemoryTopicStore /
 * InMemoryEntitySubscriptionStore) so the merge/resolve/subscribe semantics are exercised
 * for real, plus a recording InjectSink. No PG.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { InMemoryTopicStore, InMemoryEntitySubscriptionStore } from '@papercusp/coordination/capabilities';

// fanout-delivery imports coordLog from ./log only as deliverInjectMany's DEFAULT sink; we always
// pass our own sink, so stub ./log to keep the test hermetic (no getOrgPg / PG import side effects).
vi.mock('./log', () => ({ coordLog: {} }));

import {
  ensureBuiltinTopics,
  createTopicCore,
  mergeTopicsCore,
  NEW_TOPIC,
  IMPROVEMENT_TOPIC,
  SEVERE_EVENTS_TOPIC,
  type TopicsStores,
} from './topics-core';
import type { InjectSink } from './fanout-delivery';

const NOW = '2026-06-23T12:00:00.000Z';

function makeStores(): TopicsStores {
  return { topics: new InMemoryTopicStore(), subscriptions: new InMemoryEntitySubscriptionStore() };
}

function makeSink(): { sink: InjectSink; lines: CoordEnvelope[] } {
  const lines: CoordEnvelope[] = [];
  return { sink: { async appendLine(_s, _w, line) { lines.push(line); } }, lines };
}

async function sub(
  stores: TopicsStores,
  subscriber_id: string,
  target_ref: string,
  delivery_mode: 'full' | 'digest' | 'mention' = 'full',
): Promise<void> {
  await stores.subscriptions.subscribe({ subscriber_id, target_kind: 'topic', target_ref, delivery_mode, created_ts: NOW });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ensureBuiltinTopics', () => {
  it('seeds the built-in topics and is idempotent', async () => {
    const stores = makeStores();
    await ensureBuiltinTopics(stores, NOW);
    await ensureBuiltinTopics(stores, NOW); // second call must not throw / duplicate
    for (const slug of [NEW_TOPIC, IMPROVEMENT_TOPIC, SEVERE_EVENTS_TOPIC, 'coord-dx', 'db-tooling']) {
      expect((await stores.topics.get(slug))?.slug).toBe(slug);
    }
    const all = await stores.topics.list();
    expect(all.length).toBe(5);
  });
});

describe('createTopicCore — new topic', () => {
  it('creates the topic, returns created:true, and notifies new_topic subscribers (creator excluded)', async () => {
    const stores = makeStores();
    const { sink, lines } = makeSink();
    await ensureBuiltinTopics(stores, NOW);
    await sub(stores, 'alice', NEW_TOPIC);
    await sub(stores, 'bob', NEW_TOPIC);
    await sub(stores, 'creator', NEW_TOPIC); // the creator is subscribed but must NOT self-notify

    const res = await createTopicCore(stores, sink, {
      slug: 'feature-x', description: 'a brand new topic', created_by: 'creator', nowIso: NOW,
    });

    expect(res.created).toBe(true);
    expect(res.notified).toBe(2); // alice + bob, not creator
    expect(res.topic.slug).toBe('feature-x');
    // one notify envelope per notified subscriber, addressed to them
    expect(lines.map((l) => l.to).sort()).toEqual([['alice'], ['bob']]);
    expect(lines.every((l) => l.kind === 'notify')).toBe(true);
    expect(lines.every((l) => (l.summary ?? '').includes('feature-x'))).toBe(true);
  });

  it('drops mention-mode subscribers (a plain topic_created is not a mention/resolution)', async () => {
    const stores = makeStores();
    const { sink, lines } = makeSink();
    await ensureBuiltinTopics(stores, NOW);
    await sub(stores, 'full-sub', NEW_TOPIC, 'full');
    await sub(stores, 'digest-sub', NEW_TOPIC, 'digest');
    await sub(stores, 'mention-sub', NEW_TOPIC, 'mention');

    const res = await createTopicCore(stores, sink, {
      slug: 'feature-y', description: 'y', created_by: 'someone', nowIso: NOW,
    });

    expect(res.notified).toBe(2); // full + digest deliver; mention is dropped
    expect(lines.map((l) => l.to[0]).sort()).toEqual(['digest-sub', 'full-sub']);
  });
});

describe('createTopicCore — no broadcast cases', () => {
  it('re-creating an existing topic is a prefer-existing no-op (created:false, notified:0)', async () => {
    const stores = makeStores();
    const { sink, lines } = makeSink();
    await ensureBuiltinTopics(stores, NOW);
    await sub(stores, 'alice', NEW_TOPIC);
    await createTopicCore(stores, sink, { slug: 'dup', description: 'first', created_by: 'x', nowIso: NOW });
    lines.length = 0; // clear the first (legit) broadcast

    const res = await createTopicCore(stores, sink, { slug: 'dup', description: 'again', created_by: 'x', nowIso: NOW });
    expect(res.created).toBe(false);
    expect(res.notified).toBe(0);
    expect(lines).toHaveLength(0);
  });

  it('creating the built-in new_topic itself never broadcasts', async () => {
    const stores = makeStores();
    const { sink, lines } = makeSink();
    await sub(stores, 'alice', NEW_TOPIC);
    const res = await createTopicCore(stores, sink, {
      slug: NEW_TOPIC, description: 'the builtin', created_by: 'system', nowIso: NOW,
    });
    expect(res.created).toBe(false);
    expect(res.notified).toBe(0);
    expect(lines).toHaveLength(0);
  });
});

describe('mergeTopicsCore', () => {
  it('from === into is a no-op', async () => {
    const stores = makeStores();
    const res = await mergeTopicsCore(stores, { from: 'a', into: 'a', nowIso: NOW });
    expect(res.moved).toBe(0);
  });

  it('re-points the merged slug\'s subscribers onto the target and reports moved count', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'src', description: 's', created_by: 'x', created_ts: NOW });
    await stores.topics.create({ slug: 'dst', description: 'd', created_by: 'x', created_ts: NOW });
    await sub(stores, 'alice', 'src');
    await sub(stores, 'bob', 'src');

    const res = await mergeTopicsCore(stores, { from: 'src', into: 'dst', nowIso: NOW });

    expect(res.moved).toBe(2);
    const onDst = (await stores.subscriptions.listTargetSubscribers('topic', 'dst')).map((s) => s.subscriber_id).sort();
    expect(onDst).toEqual(['alice', 'bob']);
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'src')).toHaveLength(0);
    expect(await stores.topics.resolve('src')).toBe('dst'); // topic itself aliased
  });

  it('re-points onto the CANONICAL head when the target was already merged', async () => {
    const stores = makeStores();
    for (const slug of ['src', 'mid', 'head']) {
      await stores.topics.create({ slug, description: slug, created_by: 'x', created_ts: NOW });
    }
    await stores.topics.merge('mid', 'head'); // mid → head
    await sub(stores, 'alice', 'src');

    const res = await mergeTopicsCore(stores, { from: 'src', into: 'mid', nowIso: NOW });

    expect(res.moved).toBe(1);
    // alice lands on the live canonical head, NOT the dead middle slug
    expect((await stores.subscriptions.listTargetSubscribers('topic', 'head')).map((s) => s.subscriber_id)).toEqual(['alice']);
    expect(await stores.subscriptions.listTargetSubscribers('topic', 'mid')).toHaveLength(0);
  });

  it('preserves each subscriber\'s delivery_mode across the re-point', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'src', description: 's', created_by: 'x', created_ts: NOW });
    await stores.topics.create({ slug: 'dst', description: 'd', created_by: 'x', created_ts: NOW });
    await sub(stores, 'alice', 'src', 'digest');
    await sub(stores, 'bob', 'src', 'mention');

    await mergeTopicsCore(stores, { from: 'src', into: 'dst', nowIso: NOW });

    const byId = Object.fromEntries(
      (await stores.subscriptions.listTargetSubscribers('topic', 'dst')).map((s) => [s.subscriber_id, s.delivery_mode]),
    );
    expect(byId).toEqual({ alice: 'digest', bob: 'mention' });
  });

  it('merging a topic with no subscribers reports moved:0', async () => {
    const stores = makeStores();
    await stores.topics.create({ slug: 'src', description: 's', created_by: 'x', created_ts: NOW });
    await stores.topics.create({ slug: 'dst', description: 'd', created_by: 'x', created_ts: NOW });
    const res = await mergeTopicsCore(stores, { from: 'src', into: 'dst', nowIso: NOW });
    expect(res.moved).toBe(0);
    expect(await stores.topics.resolve('src')).toBe('dst'); // still aliased even with no subscribers
  });
});
