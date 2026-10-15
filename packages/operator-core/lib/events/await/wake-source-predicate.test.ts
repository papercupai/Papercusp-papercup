/**
 * The ONE wake-source predicate (parked-agent-census-resumption-and-root-cause-2026-10-09, D-008 (1),
 * D-009; P-009). Pure cases only — the readers are exercised through their callers.
 */
import { describe, expect, it } from 'vitest';
import {
  BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC,
  boundedAwaitTemplateFor,
  countWakeSourcesBySubscriber,
  guaranteesWake,
  isWakeSource,
  nonWakeReason,
  parseWorkItemAwaitKey,
  workItemIdsNamedBy,
  type HeldWorkItem,
  type WorkItemAwaitTarget,
} from './wake-source-predicate';

const PREFIX = 'coord:inbox-wake:';
const ME = 'su-me';
const targets = (entries: Record<string, WorkItemAwaitTarget[]>) => new Map(Object.entries(entries));
const NONE = targets({});

describe('parseWorkItemAwaitKey', () => {
  it('parses a per-item key and ignores the id-less backlog watch and other families', () => {
    expect(parseWorkItemAwaitKey('work-item:done:WI-10008160')).toEqual({ verb: 'done', itemId: 'WI-10008160' });
    expect(parseWorkItemAwaitKey('work-item:unblocked:EI-25641375587421128')).toEqual({
      verb: 'unblocked',
      itemId: 'EI-25641375587421128',
    });
    expect(parseWorkItemAwaitKey('work-item:claimable')).toBeNull();
    expect(parseWorkItemAwaitKey('release:green')).toBeNull();
    expect(workItemIdsNamedBy([{ eventKey: 'work-item:done:WI-1' }, { eventKey: 'work-item:unblocked:WI-1' }])).toEqual([
      'WI-1',
    ]);
  });
});

describe('nonWakeReason / isWakeSource (D-008 (1))', () => {
  it("excludes the session's own unbounded inbox watcher (D-006)", () => {
    const keepalive = { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null, timeoutBehavior: 'expire', once: false };
    expect(nonWakeReason(keepalive, NONE, PREFIX)).toBe('inbox-watcher');
    // An unbounded deliberate park on the same key still fires only on an inbound message.
    expect(nonWakeReason({ subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null }, NONE, PREFIX)).toBe(
      'inbox-watcher',
    );
  });

  it('counts a deliberate BOUNDED wake-on-timeout await on the own inbox key (WI-2146110)', () => {
    const bounded = { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'wake' };
    expect(isWakeSource(bounded, NONE, PREFIX)).toBe(true);
  });

  it("does not treat another agent's inbox key as this session's watcher", () => {
    expect(isWakeSource({ subscriberId: ME, eventKey: PREFIX + 'su-peer', expiresTs: null }, NONE, PREFIX)).toBe(true);
  });

  it('excludes a done-await on an item the subscriber itself holds (self-deadlock)', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, t, PREFIX)).toBe('self-held-done');
  });

  it('keeps a done-await on an item someone ELSE holds, and an unblocked-await on a self-held blocked item', () => {
    expect(
      isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, targets({ 'WI-1': [{ status: 'wip', takenBy: 'su-peer' }] }), PREFIX),
    ).toBe(true);
    expect(
      isWakeSource(
        { subscriberId: ME, eventKey: 'work-item:unblocked:WI-1' },
        targets({ 'WI-1': [{ status: 'blocked', takenBy: ME }] }),
        PREFIX,
      ),
    ).toBe(true);
  });

  it('excludes an await on a terminal or a missing item', () => {
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, targets({ 'WI-1': [{ status: 'done', takenBy: null }] }), PREFIX)).toBe(
      'terminal-target',
    );
    expect(nonWakeReason({ subscriberId: ME, eventKey: 'work-item:unblocked:WI-1' }, targets({ 'WI-1': [] }), PREFIX)).toBe(
      'missing-target',
    );
  });

  it('treats an item that was NOT looked up as live (positive-finding-only)', () => {
    expect(isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-9' }, NONE, PREFIX)).toBe(true);
  });

  it('resolves a multi-harness id toward LIVE: terminal only when every row is', () => {
    const t = targets({ 'WI-1': [{ status: 'done', takenBy: null }, { status: 'open', takenBy: 'su-peer' }] });
    expect(isWakeSource({ subscriberId: ME, eventKey: 'work-item:done:WI-1' }, t, PREFIX)).toBe(true);
  });
});

describe('guaranteesWake (D-009)', () => {
  it('requires a live source that is bounded AND wakes on its deadline', () => {
    expect(guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: null }, NONE, PREFIX)).toBe(false);
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'wake' }, NONE, PREFIX),
    ).toBe(true);
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'release:green', expiresTs: '2026-10-11T03:00:00.000Z', timeoutBehavior: 'expire' }, NONE, PREFIX),
    ).toBe(false);
  });

  it('never counts a bounded await that is dead', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    expect(
      guaranteesWake({ subscriberId: ME, eventKey: 'work-item:done:WI-1', expiresTs: '2026-10-11T03:00:00.000Z' }, t, PREFIX),
    ).toBe(false);
  });
});

describe('countWakeSourcesBySubscriber', () => {
  it('counts only wake sources, per subscriber', () => {
    const t = targets({ 'WI-1': [{ status: 'wip', takenBy: ME }] });
    const counts = countWakeSourcesBySubscriber(
      [
        { subscriberId: ME, eventKey: PREFIX + ME, expiresTs: null },
        { subscriberId: ME, eventKey: 'work-item:done:WI-1' },
        { subscriberId: ME, eventKey: 'conversation:answered:conv-1' },
        { subscriberId: 'su-other', eventKey: 'work-item:done:WI-1' },
      ],
      t,
      PREFIX,
    );
    expect(counts.get(ME)).toBe(1);
    expect(counts.get('su-other')).toBe(1);
  });
});

describe('boundedAwaitTemplateFor', () => {
  const NOW = Date.parse('2026-10-11T01:00:00.000Z');
  const item = (over: Partial<HeldWorkItem>): HeldWorkItem => ({
    id: 'WI-1',
    harness: 'papercusp',
    status: 'wip',
    eventBlockers: [],
    ...over,
  });

  it('prefers a typed event blocker, bounding the wait by its recheckAt', () => {
    const tpl = boundedAwaitTemplateFor(
      [
        item({ id: 'WI-1', status: 'blocked' }),
        item({ id: 'WI-2', eventBlockers: [{ ref: 'release:green', summary: 'gate', recheckAt: '2026-10-11T03:00:00.000Z' }] }),
      ],
      NOW,
    );
    expect(tpl).toEqual({
      itemId: 'WI-2',
      args: { event: 'release:green', timeout_sec: 7200, on_timeout: 'wake', note: expect.stringContaining('WI-2') },
    });
  });

  it('clamps a recheckAt bound into [300s, 24h]', () => {
    const soon = boundedAwaitTemplateFor(
      [item({ eventBlockers: [{ ref: 'e:x', summary: '', recheckAt: '2026-10-11T01:00:10.000Z' }] })],
      NOW,
    );
    const far = boundedAwaitTemplateFor(
      [item({ eventBlockers: [{ ref: 'e:x', summary: '', recheckAt: '2026-10-20T01:00:00.000Z' }] })],
      NOW,
    );
    expect(soon?.args.timeout_sec).toBe(300);
    expect(far?.args.timeout_sec).toBe(86_400);
  });

  it("falls back to a blocked item's own unblocked key, never a done-await on a held item", () => {
    const tpl = boundedAwaitTemplateFor([item({ id: 'WI-1' }), item({ id: 'WI-2', status: 'blocked' })], NOW);
    expect(tpl?.args).toMatchObject({
      event: 'work-item:unblocked:WI-2',
      timeout_sec: BOUNDED_AWAIT_DEFAULT_TIMEOUT_SEC,
      on_timeout: 'wake',
    });
    expect(tpl?.args.event.startsWith('work-item:done:')).toBe(false);
  });

  it('returns null when no held item states a blocker', () => {
    expect(boundedAwaitTemplateFor([item({}), item({ id: 'WI-2', status: 'open' })], NOW)).toBeNull();
  });
});
