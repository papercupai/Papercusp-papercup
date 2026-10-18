/**
 * Unit tests for coord:emit (coord-lifecycle-automation-2026-06-04) + the
 * sendMessage `extra` passthrough it relies on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CoordEventLog, LineSurface } from '@papercusp/coordination/event-log';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';
import { sendMessage } from '../messages';
import coordEmit, { COORD_EMIT_DB_DEADLINE_MS } from './emit';

const ctx = { uiClientId: 'su-test', isSuperuser: true, workspaceId: 'default' } as never;

describe('coord:emit', () => {
  let log: InMemoryCoordLog;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
  });
  afterEach(() => resetCoordLog());

  it('stamps auto:true + lifecycle:<category> on a visible (non-ambient) message', async () => {
    const parsed = (coordEmit.args as { parse: (x: unknown) => unknown }).parse({
      category: 'completion',
      summary: 'F-1 DONE — 12 tests',
      body: 'What landed: the thing',
      plan_slug: 'some-plan',
    });
    const res = await coordEmit.handler(parsed as never, ctx);
    const lines = await log.readLines('messages');
    expect(lines).toHaveLength(1);
    const env = lines[0] as Record<string, unknown>;
    expect(env.kind).toBe('message'); // visible in inbox, not an event surface
    expect(env.summary).toBe('F-1 DONE — 12 tests');
    expect(env.body).toBe('What landed: the thing');
    expect(env.plan_slug).toBe('some-plan');
    expect(env.auto).toBe(true);
    expect(env.lifecycle).toBe('completion');
    expect(env.category).toBeUndefined(); // NOT an ambient category (would exclude it)
    expect(env.to).toEqual(['*']); // default broadcast
    // result envelope
    const out = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(out).toMatchObject({ ok: true, lifecycle: 'completion' });
    expect(out.msg_id).toBeTruthy();
  });

  it('persists typed declared goal refs on the lifecycle envelope', async () => {
    const parsed = (coordEmit.args as { parse: (x: unknown) => unknown }).parse({
      category: 'intent',
      summary: 'working on two linked items',
      declared_goal_refs: [' work-on-everything-070565 ', 'WI-1', 'EI-2'],
      declared_plan_items: ['P-016'],
      to: [],
    });
    await coordEmit.handler(parsed as never, ctx);
    const env = (await log.readLines('messages'))[0] as Record<string, unknown>;
    expect(env.declared_goal_refs).toEqual(['work-on-everything-070565', 'WI-1', 'EI-2']);
    expect(env.declared_plan_items).toEqual(['P-016']);
  });

  it('honours an explicit recipient list + related_msg_id (window done → open)', async () => {
    const parsed = (coordEmit.args as { parse: (x: unknown) => unknown }).parse({
      category: 'window',
      summary: '✅ released locks/* — done',
      to: ['su-peer'],
      related_msg_id: 'mq-open-1',
    });
    await coordEmit.handler(parsed as never, ctx);
    const env = (await log.readLines('messages'))[0] as Record<string, unknown>;
    expect(env.to).toEqual(['su-peer']);
    expect(env.related_msg_id).toBe('mq-open-1');
    expect(env.lifecycle).toBe('window');
  });
});

describe('sendMessage extra passthrough', () => {
  let log: InMemoryCoordLog;
  const identity = {
    ownerId: 'o-1',
    ownerLabel: 'label',
    source: 'principal',
    workspaceId: null,
    userId: null,
  } as never;
  beforeEach(() => {
    log = new InMemoryCoordLog();
    configureCoordLog(log);
  });
  afterEach(() => resetCoordLog());

  it('merges extra keys but never clobbers reserved envelope fields', async () => {
    const env = (await sendMessage(identity, {
      to: ['*'],
      summary: 's',
      extra: { from: 'HACK', to: ['evil'], kind: 'escalation', custom: 'ok', auto: true },
    })) as Record<string, unknown>;
    // reserved fields preserved
    expect(env.from).toBe('o-1');
    expect(env.to).toEqual(['*']);
    expect(env.kind).toBe('message');
    // non-reserved extras merged
    expect(env.custom).toBe('ok');
    expect(env.auto).toBe(true);
  });

  it('drops undefined extra values', async () => {
    const env = (await sendMessage(identity, {
      to: ['*'],
      summary: 's',
      extra: { a: undefined, b: 1 },
    })) as Record<string, unknown>;
    expect('a' in env).toBe(false);
    expect(env.b).toBe(1);
  });

  it('EI-21862403163570302: a hung coord_event_log persist is bounded by withDbCallDeadline instead of hanging coord:emit (and its caller, work_items:complete) indefinitely', async () => {
    // Wrap the real InMemoryCoordLog so every OTHER method behaves normally,
    // but the line-append path (what sendMessage's persist ultimately calls)
    // never settles — simulating the saturated/wedged coord_event_log write
    // reported in this item.
    const real = log;
    // A plain object spread (`{ ...real, ... }`) only copies REAL's own
    // enumerable properties, not its prototype methods — it would silently
    // drop every other CoordEventLog method (readLines, putEvent, ...) both
    // at the type level (TS2740) and at runtime. Proxy preserves every
    // other method's real behavior and overrides only the two hang points.
    const hanging: CoordEventLog = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendLine' || prop === 'appendLineIfAbsent') {
          return (_surface: LineSurface, _writerKey: string, _line: unknown) =>
            new Promise(() => {});
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    configureCoordLog(hanging);

    vi.useFakeTimers();
    try {
      const parsed = (coordEmit.args as { parse: (x: unknown) => unknown }).parse({
        category: 'completion',
        summary: 'F-1 DONE — 12 tests',
      });
      const pending = coordEmit.handler(parsed as never, ctx);
      let rejection: unknown;
      pending.catch((err) => {
        rejection = err;
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(COORD_EMIT_DB_DEADLINE_MS);
      await Promise.resolve(); // let the rejection handler above settle
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).rejects.toThrow(
        /\[db-call-deadline\] "coord:emit\.sendMessage" did not resolve within/,
      );
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toMatchObject({
        name: 'DbCallDeadlineError',
        pool: 'org-admin',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
