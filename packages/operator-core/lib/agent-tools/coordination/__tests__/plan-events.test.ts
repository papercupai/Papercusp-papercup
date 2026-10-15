/**
 * Unit tests for plan-events.ts — the working-memory history feed.
 *
 * Drives the CoordEventLog seam with an in-memory backend (no PG, no fs).
 * In production the operator backs the seam with Postgres
 * (harness_shared.coord_event_log); the in-memory double exercises the same
 * emit/read/filter logic in isolation. The legacy filesystem layout
 * (planEventsFile / monthly-rotation .jsonl files) was retired in the
 * coord-channels-pg-port cutover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { emitAwaitedEvent } from '../../../events/await/engine';

vi.mock('../../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn(async () => undefined) }));

import { emitPlanEvent, emitPlanEventForCaller, readPlanEvents } from '../plan-events';
import { configureCoordLog, resetCoordLog } from '../log';
import planEventsTool from '../tools/plan-events';

beforeEach(() => {
  vi.clearAllMocks();
  configureCoordLog(new InMemoryCoordLog());
});
afterEach(() => {
  resetCoordLog();
});

describe('plan-events', () => {
  it('emitPlanEvent writes a typed plan_event envelope', async () => {
    await emitPlanEvent({
      planSlug: 'foo-2026-05-20',
      event: 'created',
      identity: {
        ownerId: 'agent-1',
        ownerLabel: 'a',
        source: 'omp-hook-session',
        workspaceId: 'default',
        userId: null,
      },
      detail: 'first',
    });
    const all = await readPlanEvents();
    expect(all).toHaveLength(1);
    expect(all[0]?.kind).toBe('plan_event');
    expect(all[0]?.event).toBe('created');
    expect(all[0]?.plan_slug).toBe('foo-2026-05-20');
    expect(all[0]?.from).toBe('agent-1');
    expect(all[0]?.detail).toBe('first');
  });

  it('emitPlanEventForCaller resolves identity from ctx and falls back to "system"', async () => {
    // ctx with a resolvable power-user identity
    const receipt = await emitPlanEventForCaller(
      { isPowerUser: true, uiClientId: 'pus-abcdefab-cdef-...', workspaceId: 'ws' },
      { planSlug: 'p1', event: 'now_updated' },
    );
    // ctx that cannot be attributed -> from === 'system', no throw
    await emitPlanEventForCaller({}, { planSlug: 'p1', event: 'item_added', detail: 'P-001' });
    const events = await readPlanEvents();
    expect(events.map((e) => e.from)).toEqual(['pus-abcdefab-cdef-...', 'system']);
    expect(receipt).toBe(events[0]?.msg_id);
  });

  it('readPlanEvents filters by since_ts / planSlugs / events', async () => {
    await emitPlanEvent({ planSlug: 'a', event: 'created' });
    await new Promise((r) => setTimeout(r, 5));
    const cutoffTs = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 5));
    await emitPlanEvent({ planSlug: 'a', event: 'now_updated' });
    await emitPlanEvent({ planSlug: 'b', event: 'created' });

    const sinceCutoff = await readPlanEvents({ since_ts: cutoffTs });
    expect(sinceCutoff.map((e) => e.event)).toEqual(['now_updated', 'created']);

    const onlyA = await readPlanEvents({ planSlugs: ['a'] });
    expect(onlyA.map((e) => e.plan_slug)).toEqual(['a', 'a']);

    const onlyCreated = await readPlanEvents({ events: ['created'] });
    expect(onlyCreated.map((e) => e.plan_slug)).toEqual(['a', 'b']);
  });

  it('round-trips an agent_launched event (plan-agent-launch P-014)', async () => {
    await emitPlanEvent({
      planSlug: 'launchable-plan',
      event: 'agent_launched',
      after: 42,
      detail: 'advance phase 3',
      identity: null,
    });
    const launched = await readPlanEvents({ events: ['agent_launched'] });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.plan_slug).toBe('launchable-plan');
    expect(launched[0]?.event).toBe('agent_launched');
    expect(launched[0]?.after).toBe(42);
    expect(launched[0]?.detail).toBe('advance phase 3');
  });

  it('emitPlanEventForCaller never throws — even when the backend errors', async () => {
    // Emission is best-effort observability; a backend failure must never
    // break a plans:* write. Point the seam at a log that throws on append.
    const throwing = new InMemoryCoordLog();
    throwing.appendLine = () => {
      throw new Error('backend down');
    };
    configureCoordLog(throwing);
    await expect(
      emitPlanEventForCaller({}, { planSlug: 'x', event: 'created' }),
    ).resolves.toBeNull();
    expect(emitAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: { planSlug: 'x', event: 'created' },
    }));
  });
});

describe('coord:plan-events tool — result bound (EI-1737)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const run = (args: Record<string, unknown> = {}) => (planEventsTool as any).handler(args, {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parse = (res: any) => JSON.parse(res.content[0].text);

  it('a no-arg call returns the NEWEST `limit` (default 100) events + reports total/truncated', async () => {
    for (let i = 0; i < 150; i++) await emitPlanEvent({ planSlug: `p-${i}`, event: 'created' });
    const full = await readPlanEvents();
    expect(full).toHaveLength(150);

    const out = parse(await run());

    expect(out.events).toHaveLength(100);
    expect(out.total).toBe(150);
    expect(out.truncated).toBe(true);
    expect(out.events).toEqual(full.slice(-100)); // exactly the newest 100 (ts-ascending tail)
  });

  it('respects an explicit `limit`', async () => {
    for (let i = 0; i < 20; i++) await emitPlanEvent({ planSlug: `q-${i}`, event: 'created' });
    const out = parse(await run({ limit: 5 }));
    expect(out.events).toHaveLength(5);
    expect(out.total).toBe(20);
    expect(out.truncated).toBe(true);
  });

  it('returns everything, not truncated, when under the limit', async () => {
    for (let i = 0; i < 10; i++) await emitPlanEvent({ planSlug: `r-${i}`, event: 'created' });
    const out = parse(await run());
    expect(out.events).toHaveLength(10);
    expect(out.total).toBe(10);
    expect(out.truncated).toBe(false);
  });
});

describe('coord:plan-events tool — files_back schema', () => {
  it('accepts zero for the current rotation file and rejects negative values', () => {
    expect(planEventsTool.args.safeParse({ files_back: 0 }).success).toBe(true);
    expect(planEventsTool.args.safeParse({ files_back: -1 }).success).toBe(false);
  });
});
