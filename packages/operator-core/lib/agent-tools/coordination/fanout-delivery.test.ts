/**
 * fanout-delivery.test.ts — the subscribe→inject delivery primitive
 * (coordination-substrate fan-out). Pure over an injected InjectSink, so this is
 * a unit test with an in-memory double — no PG.
 *
 * Covers (BRIEF-test-coverage-fu-coordination-federation-area target #2):
 *  • buildInjectEnvelope — the `digest:true` flag tracks the subscriber's mode,
 *    the envelope carries subject/notify_kind/delivery_mode/via + ev.extra, and a
 *    caller-supplied deterministic msg_id is honored (the idempotent fan-out path).
 *  • shouldDeliver — only the mention gate can drop; full/digest always pass.
 *  • deliverInject — sink write → true; gated-out → false (no write); sink throw →
 *    false (best-effort catch, must not propagate).
 *  • deliverInjectMany — partial failure: one subscriber's sink throws → the REST
 *    still deliver, and the returned count reflects only the successes.
 */
import { describe, it, expect } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { DeliveryMode, ResolvedSubscriber } from '@papercusp/coordination/capabilities';
import {
  buildInjectEnvelope,
  shouldDeliver,
  deliverInject,
  deliverInjectMany,
  type InjectEvent,
  type InjectSink,
} from './fanout-delivery';
import { refilledTokens } from '@papercusp/structured-concurrency';
import { reserveWakeTimes, withWakeFanoutPacing, readWakeFanoutPacing } from './wake-fanout-pacing';

function sub(id: string, mode: DeliveryMode = 'full', via = 'object'): ResolvedSubscriber {
  return { subscriber_id: id, delivery_mode: mode, via };
}

function ev(overrides: Partial<InjectEvent> = {}): InjectEvent {
  return {
    from: 'su-author',
    subject: 'topic:zero-cache',
    summary: 'zero-cache topic got a new question',
    notify_kind: 'question_opened',
    ...overrides,
  };
}

/** In-memory sink. Throws for any subscriber id in `throwFor` so a single
 *  fan-out leg can be made to fail without disturbing the others. */
function makeSink(throwFor: string[] = []): {
  sink: InjectSink;
  inbox: Record<string, CoordEnvelope[]>;
} {
  const inbox: Record<string, CoordEnvelope[]> = {};
  const sink: InjectSink = {
    async appendLine(_surface, writerKey, line) {
      if (throwFor.includes(writerKey)) throw new Error(`sink boom for ${writerKey}`);
      (inbox[writerKey] ??= []).push(line);
    },
  };
  return { sink, inbox };
}

describe('buildInjectEnvelope', () => {
  it('flags digest:true ONLY for a digest subscriber', () => {
    expect(buildInjectEnvelope(sub('a', 'digest'), ev()).digest).toBe(true);
    expect(buildInjectEnvelope(sub('a', 'full'), ev()).digest).toBe(false);
    expect(buildInjectEnvelope(sub('a', 'mention'), ev()).digest).toBe(false);
  });

  it('renders as a notify addressed to exactly the one subscriber, carrying the event fields', () => {
    const env = buildInjectEnvelope(sub('subB', 'full', 'zero-cache'), ev({ body: 'full detail here' }), 'fan-7-subB');
    expect(env.kind).toBe('notify');
    expect(env.to).toEqual(['subB']);
    expect(env.from).toBe('su-author');
    expect(env.summary).toBe('zero-cache topic got a new question');
    expect(env.body).toBe('full detail here');
    expect(env.subject).toBe('topic:zero-cache');
    expect(env.notify_kind).toBe('question_opened');
    expect(env.delivery_mode).toBe('full');
    expect(env.via).toBe('zero-cache');
    // The caller-supplied deterministic id is preserved (idempotent fan-out path).
    expect(env.msg_id).toBe('fan-7-subB');
    expect(typeof env.ts).toBe('string');
  });

  it('omits body when the event has none, and merges ev.extra', () => {
    const env = buildInjectEnvelope(sub('a'), ev({ extra: { issue_id: 'EI-9', severity: 'major' } }));
    expect('body' in env).toBe(false);
    expect(env.issue_id).toBe('EI-9');
    expect(env.severity).toBe('major');
  });

  it('mints a fresh msg_id when none is supplied (two builds differ)', () => {
    const a = buildInjectEnvelope(sub('a'), ev());
    const b = buildInjectEnvelope(sub('a'), ev());
    expect(a.msg_id).not.toBe(b.msg_id);
    expect(a.msg_id.length).toBeGreaterThan(0);
  });
});

describe('shouldDeliver', () => {
  it('full + digest always pass (digest changes rendering, not delivery)', () => {
    expect(shouldDeliver('full', ev(), 'x')).toBe(true);
    expect(shouldDeliver('digest', ev(), 'x')).toBe(true);
  });

  it('mention drops a non-mention, non-resolution event', () => {
    expect(shouldDeliver('mention', ev(), 'x')).toBe(false);
  });

  it('mention passes an explicit @-mention of the subscriber', () => {
    expect(shouldDeliver('mention', ev({ mentions: ['x', 'y'] }), 'x')).toBe(true);
    expect(shouldDeliver('mention', ev({ mentions: ['y'] }), 'x')).toBe(false);
  });

  it('mention always passes a lifecycle resolution', () => {
    expect(shouldDeliver('mention', ev({ isResolution: true }), 'x')).toBe(true);
  });
});

describe('deliverInject', () => {
  it('writes a notify row to the sink and returns true', async () => {
    const { sink, inbox } = makeSink();
    expect(await deliverInject(sub('subA', 'digest'), ev(), sink)).toBe(true);
    expect(inbox.subA).toHaveLength(1);
    expect(inbox.subA[0].notify_kind).toBe('question_opened');
    expect(inbox.subA[0].digest).toBe(true);
  });

  it('returns false WITHOUT writing when the mention gate drops the event', async () => {
    const { sink, inbox } = makeSink();
    expect(await deliverInject(sub('subA', 'mention'), ev(), sink)).toBe(false);
    expect(inbox.subA).toBeUndefined();
  });

  it('returns false (does not throw) when the sink write fails', async () => {
    const { sink } = makeSink(['subA']);
    await expect(deliverInject(sub('subA'), ev(), sink)).resolves.toBe(false);
  });
});

describe('deliverInjectMany', () => {
  it('delivers to every subscriber and returns the count', async () => {
    const { sink, inbox } = makeSink();
    const n = await deliverInjectMany([sub('a'), sub('b'), sub('c')], ev(), sink);
    expect(n).toBe(3);
    expect(Object.keys(inbox).sort()).toEqual(['a', 'b', 'c']);
  });

  it('partial failure: one subscriber sink throws → the REST still deliver, count excludes it', async () => {
    const { sink, inbox } = makeSink(['bad']);
    const n = await deliverInjectMany([sub('good1'), sub('bad'), sub('good2')], ev(), sink);
    expect(n).toBe(2);
    expect(inbox.good1).toHaveLength(1);
    expect(inbox.good2).toHaveLength(1);
    expect(inbox.bad).toBeUndefined();
  });

  it('counts only ungated deliveries (mention subscribers gated out of a normal event)', async () => {
    const { sink, inbox } = makeSink();
    const n = await deliverInjectMany([sub('a', 'full'), sub('b', 'mention'), sub('c', 'digest')], ev(), sink);
    expect(n).toBe(2); // a + c; b is mention-gated
    expect(inbox.b).toBeUndefined();
  });

  it('a mention subscriber DOES receive a resolution in a mixed fan-out', async () => {
    const { sink, inbox } = makeSink();
    const n = await deliverInjectMany([sub('a', 'mention'), sub('b', 'full')], ev({ isResolution: true }), sink);
    expect(n).toBe(2);
    expect(inbox.a).toHaveLength(1);
  });
});

describe('bulk wake schedule (WI-6554700010009434)', () => {
  it('delivers a 200-recipient reservation over 19.5 minutes, with five immediate wakes', () => {
    const { times, tokens } = reserveWakeTimes(5, 200, 10_000);
    expect(times.slice(0, 5)).toEqual(Array(5).fill(10_000));
    expect(times[5]).toBe(16_000);
    expect(times[199]).toBe(1_180_000);
    expect(tokens).toBe(-195);
    expect(new Set(times.slice(5)).size).toBe(195);
  });

  it('a second producer inherits the first reservation debt instead of creating a new burst', () => {
    const first = reserveWakeTimes(5, 200, 0);
    const refilled = refilledTokens({ tokens: first.tokens, capacity: 5, refillPerSec: 1 / 6, updatedAtMs: 0 }, 6_000);
    const next = reserveWakeTimes(refilled, 10, 6_000);
    expect(next.times[0]).toBe(1_176_000);
    expect(next.times.at(-1)).toBe(1_230_000);
  });

  it('pacing metadata survives durable JSON serialization without losing the original message', () => {
    const payload = withWakeFanoutPacing({ msg_id: 'directive-1', relayProvenance: { origin: 'owner' } }, { workspaceId: 'ws-a', notBeforeMs: 60_000 });
    const restored = JSON.parse(JSON.stringify(payload));
    expect(readWakeFanoutPacing(restored)).toEqual({ workspaceId: 'ws-a', notBeforeMs: 60_000 });
    expect(restored.msg_id).toBe('directive-1');
    expect(restored.relayProvenance.origin).toBe('owner');
    expect(readWakeFanoutPacing({ __papercuspWakeFanout: { workspaceId: '', notBeforeMs: 'bad' } })).toBeNull();
  });
});
