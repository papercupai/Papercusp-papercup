import { describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_HOOK_BUNDLE_SCHEMA,
  buildActivityHookBundle,
  hasOwnerRelevantCoordDelta,
  hookInboxSurface,
  INBOX_CURSOR_SURFACE,
  guardedLegacyInboxFloor,
  sameHostCoordGenerationDelta,
  type ActivityHookBundleDeps,
} from './hook-bundle';
import { InMemoryReadCursorStore } from '../coordination/read-cursors';
import { changedSystemNoticeDelivery } from '../coordination/inbox-visibility';

function deps(generation = 'host-a:42') {
  const inbox = vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      entries: [],
      summary: { newest_ts: null },
    }),
  );
  const glance = vi.fn(async () => ({ display: { title: 'su-abc', notice: null } }));
  const cursor = new InMemoryReadCursorStore();
  const readInboxCursor = vi.fn((ownerId: string) => cursor.ackAndRead(ownerId, INBOX_CURSOR_SURFACE));
  const stageInboxCursor = vi.fn((ownerId: string, next: Record<string, unknown>) =>
    cursor.stage(ownerId, INBOX_CURSOR_SURFACE, next),
  );
  const readWatermark = vi.fn(
    async (): Promise<{
      messages_since_ts?: string | null;
      messages_shown_ts?: string | null;
    }> => ({
      messages_since_ts: null,
      messages_shown_ts: null,
    }),
  );
  const ownerRelevantDelta = vi.fn(async () => true);
  const value: ActivityHookBundleDeps = {
    generation: vi.fn(async () => generation),
    ownerRelevantDelta,
    inbox,
    glance,
    readInboxCursor,
    stageInboxCursor,
    readWatermark,
    now: () => new Date('2026-07-13T20:00:00.000Z'),
  };
  return { value, inbox, glance, ownerRelevantDelta, readInboxCursor, stageInboxCursor, readWatermark };
}

describe('activity hook bundle', () => {
  it('commits notice fingerprints with the existing delivery cursor and retries a failed stage', async () => {
    const d = deps();
    const row = { msg_id: 'alarm', ts: '2026-07-13T19:59:30.000Z', from: 'system-watchdog',
      to: ['*'], auto: true, kind: 'message', category: 'severe-event',
      condition_key: 'compaction:other', summary: 'Compaction over-limit: other' };
    d.value.inbox = async (_floor, _ctx, state) => {
      const delivery = changedSystemNoticeDelivery([row], state);
      return { entries: delivery.entries, summary: { newest_ts: row.ts },
        injection: delivery.entries.length ? row.summary : '', __systemNoticeState: delivery.state };
    };
    const request = { force_resync: true, glance_stale: false };
    d.stageInboxCursor.mockRejectedValueOnce(new Error('stage failed'));
    const failed = await buildActivityHookBundle('su-abc', request, {} as never, d.value);
    expect(failed.complete).toBe(false);
    expect(failed.surfaces?.inbox?.injection).toBe(row.summary);
    const retry = await buildActivityHookBundle('su-abc', request, {} as never, d.value);
    expect(retry.complete).toBe(true);
    expect(retry.surfaces?.inbox?.injection).toBe(row.summary);
    expect(retry.surfaces?.inbox).not.toHaveProperty('__systemNoticeState');
    const repeated = await buildActivityHookBundle('su-abc', request, {} as never, d.value);
    expect(repeated.surfaces?.inbox?.injection).toBe('');
    row.summary = 'Compaction recovered: other';
    const changed = await buildActivityHookBundle('su-abc', request, {} as never, d.value);
    expect(changed.surfaces?.inbox?.injection).toBe(row.summary);
  });

  it('hydrates inbox + glance once, then skips both for N unchanged heartbeats', async () => {
    const d = deps();
    const first = await buildActivityHookBundle(
      'su-abc',
      { generation: null, since_ts: '2026-07-13T19:00:00.000Z', force_resync: true, glance_stale: false },
      {} as never,
      d.value,
    );
    expect(first).toMatchObject({
      schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
      generation: 'host-a:42',
      changed: true,
      complete: true,
      provenance: { source: 'activity:report', ownerId: 'su-abc' },
      resync: { strategy: 'replace-full-never-merge-behind' },
    });

    for (let i = 0; i < 20; i += 1) {
      const quiet = await buildActivityHookBundle(
        'su-abc',
        { generation: first.generation, since_ts: '2026-07-13T19:00:00.000Z' },
        {} as never,
        d.value,
      );
      expect(quiet).toMatchObject({ changed: false, complete: true });
      expect(quiet.surfaces).toBeUndefined();
    }
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).toHaveBeenCalledTimes(1);
  });

  it('rehydrates on a generation change but never trusts a client cursor past the durable receipt', async () => {
    const d = deps('host-a:43');
    d.readWatermark.mockResolvedValueOnce({
      messages_since_ts: '2026-07-13T19:00:00.000Z',
      messages_shown_ts: null,
    });
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: true, generation: 'host-a:43' });
    expect(d.ownerRelevantDelta).toHaveBeenCalledWith('su-abc', '42', '43');
    expect(d.inbox).toHaveBeenCalledWith('2026-07-13T19:00:00.000Z', expect.anything());
    expect(d.glance).toHaveBeenCalledTimes(1); // omitted freshness keeps legacy full-fold behavior
  });

  it('delivers a relevant inbox delta without rehydrating a fresh glance snapshot', async () => {
    const d = deps('host-a:43');
    const observe = vi.fn();
    d.value.observe = observe;
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', glance_stale: false },
      {} as never,
      d.value,
    );

    expect(result).toMatchObject({ changed: true, complete: true, generation: 'host-a:43' });
    expect(result.surfaces?.inbox).toBeDefined();
    expect(result.surfaces?.glance).toBeUndefined();
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).not.toHaveBeenCalled();
    expect(d.stageInboxCursor).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ glanceHydrated: false }));
  });

  it('advances through an owner-irrelevant same-host delta without hydrating either surface', async () => {
    const d = deps('host-a:43');
    d.ownerRelevantDelta.mockResolvedValueOnce(false);
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);

    expect(result).toMatchObject({ changed: false, complete: true, generation: 'host-a:43' });
    expect(result.surfaces).toBeUndefined();
    expect(d.ownerRelevantDelta).toHaveBeenCalledWith('su-abc', '42', '43');
    expect(d.readWatermark).not.toHaveBeenCalled();
    expect(d.inbox).not.toHaveBeenCalled();
    expect(d.glance).not.toHaveBeenCalled();
    expect(d.stageInboxCursor).not.toHaveBeenCalled();
  });

  it('fails open to hydration when the relevance read throws', async () => {
    const d = deps('host-a:43');
    d.ownerRelevantDelta.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);

    expect(result).toMatchObject({ changed: true, complete: true, generation: 'host-a:43' });
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an operator restart', 'host-a:42', 'host-b:43'],
    ['a malformed client generation', 'not-a-generation', 'host-a:43'],
    ['a non-forward client id', 'host-a:44', 'host-a:43'],
  ])('fails open for %s instead of querying an unsafe interval', async (_label, client, server) => {
    const d = deps(server);
    const result = await buildActivityHookBundle('su-abc', { generation: client }, {} as never, d.value);
    expect(result).toMatchObject({ changed: true, complete: true, generation: server });
    expect(d.ownerRelevantDelta).not.toHaveBeenCalled();
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).toHaveBeenCalledTimes(1);
  });

  it('force-resync always hydrates without consulting the relevance shortcut', async () => {
    const d = deps('host-a:43');
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', force_resync: true },
      {} as never,
      d.value,
    );
    expect(result).toMatchObject({ changed: true, complete: true });
    expect(d.ownerRelevantDelta).not.toHaveBeenCalled();
    expect(d.inbox).toHaveBeenCalledTimes(1);
  });

  it('ignores a first-call client cursor when no durable receipt exists', async () => {
    const d = deps('host-a:43');
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenCalledWith(null, expect.anything());
  });

  it('uses the server cursor after the first delivery, regardless of a stale client cursor', async () => {
    const d = deps('host-a:42');
    d.inbox.mockResolvedValueOnce({
      entries: [],
      summary: { newest_ts: '2026-07-13T20:00:00.000Z' },
    });
    await buildActivityHookBundle('su-abc', { generation: null, force_resync: true }, {} as never, d.value);

    d.value.generation = vi.fn(async () => 'host-a:43');
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:00:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenNthCalledWith(2, '2026-07-13T20:00:00.000Z', expect.anything());
    // The legacy watermark is needed for the first baseline only; the committed
    // server cursor makes a later read redundant.
    expect(d.readWatermark).toHaveBeenCalledTimes(1);
  });

  it('uses a null floor when the first-call watermark read fails (fail closed)', async () => {
    const d = deps('host-a:43');
    d.readWatermark.mockRejectedValueOnce(new Error('temporary'));
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', since_ts: '2026-07-13T19:30:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.inbox).toHaveBeenCalledWith(null, expect.anything());
  });

  it('marks a partial hydrate incomplete so the client retries instead of advancing', async () => {
    const d = deps();
    d.glance.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle('su-abc', { generation: 'old' }, {} as never, d.value);
    expect(result).toMatchObject({ changed: true, complete: false });
    expect(result.surfaces?.inbox).toBeDefined();
    expect(result.surfaces?.glance).toBeUndefined();
  });

  it('marks a cursor-stage failure incomplete so the next heartbeat cannot skip the delivery', async () => {
    const d = deps();
    d.stageInboxCursor.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle('su-abc', { generation: 'old' }, {} as never, d.value);
    expect(result).toMatchObject({ changed: true, complete: false });
  });
});

describe('owner-relevant generation gate', () => {
  it('parses the final colon and keeps bigint ids exact', () => {
    expect(
      sameHostCoordGenerationDelta(
        'host-with-colon:segment:9007199254740993',
        'host-with-colon:segment:9007199254740995',
      ),
    ).toEqual({ afterId: '9007199254740993', throughId: '9007199254740995' });
  });

  it.each([
    ['different host epochs', 'host-a:41', 'host-b:42'],
    ['malformed client id', 'host-a:nope', 'host-a:42'],
    ['malformed server id', 'host-a:41', 'host-a:nope'],
    ['equal ids', 'host-a:42', 'host-a:42'],
    ['backward ids', 'host-a:43', 'host-a:42'],
  ])('rejects %s as an unsafe delta', (_label, client, server) => {
    expect(sameHostCoordGenerationDelta(client, server)).toBeNull();
  });

  it('uses the authoritative direct-or-broadcast inbox predicate inside the bounded primary-key range', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([{ relevant: false }]);
    }) as never;

    await expect(hasOwnerRelevantCoordDelta('su-abc', '41', '43', sql)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("surface = 'messages'");
    expect(calls[0]?.text).toContain("jsonb_typeof(body->'to') = 'array'");
    expect(calls[0]?.text).toContain("(body->'to') ? ?");
    expect(calls[0]?.text).toContain("(body->'to') ? '*'");
    expect(calls[0]?.text).not.toContain('jsonb_exists');
    expect(calls[0]?.text).toContain('id > ?::bigint');
    expect(calls[0]?.text).toContain('id <= ?::bigint');
    expect(calls[0]?.values).toEqual(expect.arrayContaining(['41', '43', 'su-abc']));
  });

  it('rejects an unreadable query result so the caller can fail open', async () => {
    const sql = (() => Promise.resolve([])) as never;
    await expect(hasOwnerRelevantCoordDelta('su-abc', '41', '43', sql)).rejects.toThrow('no boolean verdict');
  });
});

describe('guardedLegacyInboxFloor — migration safety', () => {
  it('rejects a client floor newer than the durable receipt', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T19:30:00.000Z', '2026-07-13T19:00:00.000Z')).toBe(
      '2026-07-13T19:00:00.000Z',
    );
  });

  it('allows an older client floor because it can only duplicate delivery', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T18:30:00.000Z', '2026-07-13T19:00:00.000Z')).toBe(
      '2026-07-13T18:30:00.000Z',
    );
  });

  it('fails closed to a full baseline when no durable receipt exists', () => {
    expect(guardedLegacyInboxFloor('2026-07-13T19:30:00.000Z', null)).toBeNull();
  });
});

/**
 * P-005 (D-001): the fold's `changed` outcome was computed, acted on and
 * discarded, so the optimization's own effectiveness was unobservable and both
 * open filings had to reason from proxies. These cases pin the instrument that
 * makes it measurable — see coord-fold-census.ts for how the numbers are read.
 */
describe('coord-fold census — instrument before changing the gate', () => {
  /** A clock that advances a fixed step per read, so durations are deterministic. */
  function advancingClock(stepMs: number, startIso = '2026-07-13T20:00:00.000Z') {
    let t = new Date(startIso).getTime();
    return () => {
      const at = new Date(t);
      t += stepMs;
      return at;
    };
  }

  function censusDeps(generation = 'host-a:42', stepMs = 10) {
    const d = deps(generation);
    const observe = vi.fn();
    return { ...d, observe, value: { ...d.value, observe, now: advancingClock(stepMs) } };
  }

  it('censuses the QUIET fold too — the ratio is uncomputable from expensive folds alone', async () => {
    const d = censusDeps();
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);

    expect(result).toMatchObject({ changed: false, complete: true });
    expect(d.observe).toHaveBeenCalledTimes(1);
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({
      changed: false,
      reason: 'quiet',
      complete: true,
      // The saving the optimization exists to deliver, recorded as a hard 0.
      hydrateMs: 0,
      reqGen: 'host-a:42',
      gen: 'host-a:42',
    });
    // The quiet path must not have paid for hydration at all.
    expect(d.inbox).not.toHaveBeenCalled();
    expect(d.glance).not.toHaveBeenCalled();
  });

  it('censuses an expensive fold with the gate/hydration split P-007 needs', async () => {
    const d = censusDeps();
    await buildActivityHookBundle('su-abc', { generation: 'host-a:41' }, {} as never, d.value);

    const census = d.observe.mock.calls[0]?.[0];
    expect(census).toMatchObject({
      changed: true,
      reason: 'generation-mismatch',
      complete: true,
      reqGen: 'host-a:41',
      gen: 'host-a:42',
    });
    // gateMs + hydrateMs accounts for the whole fold — no unattributed remainder.
    expect(census.gateMs + census.hydrateMs).toBe(census.foldMs);
    expect(census.hydrateMs).toBeGreaterThan(0);
  });

  it('records BOTH generations, which is what makes the P-007 discard rate a query rather than an inference', async () => {
    const d = censusDeps();
    await buildActivityHookBundle('su-abc', { generation: 'stale-gen' }, {} as never, d.value);
    // A client that received this bundle sends back `gen`; one that timed out
    // re-sends `reqGen` unchanged. Both must be on the row for the window
    // function over consecutive folds to tell those apart.
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({ reqGen: 'stale-gen', gen: 'host-a:42' });
  });

  it('separates a first call from a real mismatch — a null cursor is legitimately expensive', async () => {
    const d = censusDeps();
    await buildActivityHookBundle('su-abc', { generation: null }, {} as never, d.value);
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({
      changed: true,
      reason: 'no-client-generation',
      reqGen: null,
    });
  });

  it('reports inboxAdvanced when the floor actually moved for THIS owner', async () => {
    const d = censusDeps();
    d.inbox.mockResolvedValueOnce({
      entries: [{}],
      summary: { newest_ts: '2026-07-13T19:45:00.000Z', total: 3 },
    });
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'old', since_ts: '2026-07-13T19:00:00.000Z' },
      {} as never,
      d.value,
    );
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({ inboxAdvanced: true, inboxTotal: 3 });
  });

  it('reports inboxAdvanced=false when the expensive fold delivered this owner no new mail', async () => {
    // This is the population a per-owner gate would have skipped (P-006) — an
    // UPPER BOUND on the saving, never a count of wasted work, because the fold
    // also replaces `glance`.
    const d = censusDeps();
    await buildActivityHookBundle('su-abc', { generation: 'old' }, {} as never, d.value);
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({ changed: true, inboxAdvanced: false });
  });

  it('directly records an owner-irrelevant global advance as a zero-hydration fold', async () => {
    const d = censusDeps('host-a:43');
    d.ownerRelevantDelta.mockResolvedValueOnce(false);
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);
    expect(result).toMatchObject({ changed: false, complete: true, generation: 'host-a:43' });
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({
      changed: false,
      reason: 'owner-irrelevant',
      hydrateMs: 0,
      reqGen: 'host-a:42',
      gen: 'host-a:43',
    });
  });

  it('carries an incomplete fold through to the census instead of dropping the row', async () => {
    const d = censusDeps();
    d.stageInboxCursor.mockRejectedValueOnce(new Error('temporary'));
    const result = await buildActivityHookBundle('su-abc', { generation: 'old' }, {} as never, d.value);
    expect(result).toMatchObject({ complete: false });
    expect(d.observe.mock.calls[0]?.[0]).toMatchObject({ changed: true, complete: false });
  });

  it.each([
    ['quiet', 'host-a:42'],
    ['expensive', 'stale-gen'],
  ])('never lets a throwing instrument break the %s fold it measures', async (_label, generation) => {
    // Guarded at the USE site, not just inside coordFoldObserverFor — an
    // injected sink bypasses that constructor's own try/catch, and this runs
    // synchronously for every agent on every tool call.
    const d = censusDeps();
    d.observe.mockImplementation(() => {
      throw new Error('sink exploded');
    });
    const result = await buildActivityHookBundle('su-abc', { generation }, {} as never, d.value);
    expect(result).toMatchObject({ schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA });
    expect(d.observe).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the ctx carries no metadata channel, rather than throwing', async () => {
    const d = deps();
    // No `observe` dep and a bare ctx: coordFoldObserverFor returns undefined.
    await expect(buildActivityHookBundle('su-abc', { generation: 'old' }, {} as never, d.value)).resolves.toMatchObject(
      { changed: true },
    );
  });
});

/**
 * WI-10002436 compromise B — the glance leg is gated SEPARATELY from the inbox leg.
 *
 * This is a DELIVERY-REGRESSION guard before it is a ratio guard, per D-001 of
 * observation-and-recall-surface-honesty-2026-08-16: this fold runs synchronously
 * for every agent on every tool call, and getting it wrong does not fail loudly —
 * it silently stops delivering coordination. So the assertions below are weighted
 * toward "the inbox leg is untouched", not toward "fewer calls happened".
 */
describe('activity hook bundle — glance/inbox leg split', () => {
  /**
   * The property under test, stated once so the control below can be checked
   * against the SAME predicate the real subject is.
   *
   * A glance-staleness signal is a statement about a DISPLAY CACHE. It may cost
   * a glance hydration and nothing else — above all it must never advance the
   * delivery cursor, which would mark mail as received that was never assembled.
   */
  function violatesDeliveryIsolation(observed: {
    inboxHydrated: boolean;
    deliveryCursorStaged: boolean;
  }): boolean {
    return observed.inboxHydrated || observed.deliveryCursorStaged;
  }

  it('THE GUARD: glance staleness alone never hydrates inbox and never advances the delivery cursor', async () => {
    const d = deps();
    const result = await buildActivityHookBundle(
      'su-abc',
      // Same generation the server holds => the inbox gate is SHUT. Only the
      // display cache is stale.
      { generation: 'host-a:42', glance_stale: true },
      {} as never,
      d.value,
    );

    expect(result).toMatchObject({ changed: false, complete: true });
    expect(result.surfaces?.glance).toBeDefined();
    expect(result.surfaces?.inbox).toBeUndefined();

    expect(d.glance).toHaveBeenCalledTimes(1);
    expect(d.inbox).not.toHaveBeenCalled();
    expect(d.stageInboxCursor).not.toHaveBeenCalled();
    expect(d.readWatermark).not.toHaveBeenCalled();

    expect(
      violatesDeliveryIsolation({
        inboxHydrated: d.inbox.mock.calls.length > 0,
        deliveryCursorStaged: d.stageInboxCursor.mock.calls.length > 0,
      }),
    ).toBe(false);
  });

  /**
   * THE PERMANENT CONTROL (repo rule: prove falsifiability with a deliberately
   * wrong implementation kept in the test file, never by mutating the shared
   * tree).
   *
   * This is the PRE-SPLIT behaviour: glance staleness escalated to a full
   * resync, so the inbox leg hydrated and the delivery cursor advanced. The
   * predicate above MUST reject it. If this ever passes, the guard has stopped
   * discriminating and the test above is vacuous.
   */
  it('CONTROL: the pre-split coupled behaviour FAILS the same predicate the real fold passes', () => {
    const coupledLegsFold = { inboxHydrated: true, deliveryCursorStaged: true };
    expect(violatesDeliveryIsolation(coupledLegsFold)).toBe(true);

    // Calibration: the predicate is not simply always-true. A leg-split fold
    // that hydrated ONLY glance must read as clean, or the control above would
    // pass even with the property itself broken.
    expect(violatesDeliveryIsolation({ inboxHydrated: false, deliveryCursorStaged: false })).toBe(false);
  });

  it('a real inbox delta still hydrates BOTH legs — glance_stale never shadows undelivered mail', async () => {
    const d = deps('host-a:43');
    const result = await buildActivityHookBundle(
      'su-abc',
      // The generation genuinely moved AND the display cache is stale. The inbox
      // gate wins: this must behave exactly as it did before the split.
      { generation: 'host-a:42', glance_stale: true },
      {} as never,
      d.value,
    );

    expect(result).toMatchObject({ changed: true, complete: true });
    expect(result.surfaces?.inbox).toBeDefined();
    expect(result.surfaces?.glance).toBeDefined();
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.stageInboxCursor).toHaveBeenCalledTimes(1);
  });

  it('BACK-COMPAT: force_resync still means replace-everything, so an older hook is unaffected', async () => {
    const d = deps();
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', force_resync: true },
      {} as never,
      d.value,
    );

    expect(result).toMatchObject({ changed: true, complete: true });
    expect(d.inbox).toHaveBeenCalledTimes(1);
    expect(d.glance).toHaveBeenCalledTimes(1);
  });

  it('THE SAVING: N stale-display heartbeats cost N glance reads and ZERO inbox hydrations', async () => {
    const d = deps();
    for (let i = 0; i < 12; i += 1) {
      const fold = await buildActivityHookBundle(
        'su-abc',
        { generation: 'host-a:42', glance_stale: true },
        {} as never,
        d.value,
      );
      expect(fold.changed).toBe(false);
    }
    expect(d.glance).toHaveBeenCalledTimes(12);
    // Pre-split this was 12 full hydrations: the measured 61% force-resync bucket.
    expect(d.inbox).not.toHaveBeenCalled();
    expect(d.stageInboxCursor).not.toHaveBeenCalled();
  });

  it('a FAILED glance on a glance-only fold reports incomplete, so the client retries instead of banking it', async () => {
    const d = deps();
    d.glance.mockRejectedValueOnce(new Error('glance unavailable'));
    const result = await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', glance_stale: true },
      {} as never,
      d.value,
    );

    expect(result).toMatchObject({ changed: false, complete: false });
    expect(result.surfaces).toBeUndefined();
    // Still no delivery-side effect from a display-side failure.
    expect(d.stageInboxCursor).not.toHaveBeenCalled();
  });

  it('censuses a glance-only fold as glance-only, not as a quiet fold that mysteriously hydrated', async () => {
    const d = deps();
    const observe = vi.fn();
    await buildActivityHookBundle(
      'su-abc',
      { generation: 'host-a:42', glance_stale: true },
      {} as never,
      { ...d.value, observe },
    );

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toMatchObject({
      changed: false,
      reason: 'glance-only',
      glanceHydrated: true,
      // The leg did not run, so it cannot report a count or an advance.
      inboxAdvanced: false,
      inboxTotal: null,
    });
  });

  it('an absent glance_stale keeps the quiet path exactly as it was', async () => {
    const d = deps();
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);
    expect(result).toMatchObject({ changed: false, complete: true });
    expect(result.surfaces).toBeUndefined();
    expect(d.glance).not.toHaveBeenCalled();
    expect(d.inbox).not.toHaveBeenCalled();
  });
});

// WI-6554700010010423: the native hooks echo `injection` and read `entries` only as
// an emptiness/length signal (+ `ts` as OMP's cursor fallback), so the bundle ships
// one { msg_id, ts } stub per entry and no `recent` copy.
describe('activity hook bundle — inbox surface is slimmed for the hook consumers', () => {
  const fullEntry = {
    msg_id: 'm-1',
    ts: '2026-07-13T19:59:00.000Z',
    from: 'su-peer',
    kind: 'message',
    body: [{ text: 'x'.repeat(2_000) }],
    summary: 'a long peer message',
    fieldProvenance: { body: 'authored' },
  };

  it('keeps injection, summary and the gauge but stubs entries and drops recent', async () => {
    const d = deps('host-a:43');
    d.inbox.mockResolvedValueOnce({
      owner_id: 'su-abc',
      entries: [fullEntry, { ...fullEntry, msg_id: 'm-2', ts: '2026-07-13T19:59:30.000Z' }],
      recent: [fullEntry],
      summary: { newest_ts: '2026-07-13T19:59:30.000Z', total: 2 },
      injection: '[coord+2]\n- su-pe a long peer message',
      context_gauge: '',
    });
    const result = await buildActivityHookBundle('su-abc', { generation: 'host-a:42' }, {} as never, d.value);

    const inbox = result.surfaces?.inbox as Record<string, unknown>;
    expect(inbox.entries).toEqual([
      { msg_id: 'm-1', ts: '2026-07-13T19:59:00.000Z' },
      { msg_id: 'm-2', ts: '2026-07-13T19:59:30.000Z' },
    ]);
    expect(inbox).not.toHaveProperty('recent');
    expect(inbox).toMatchObject({
      owner_id: 'su-abc',
      summary: { newest_ts: '2026-07-13T19:59:30.000Z', total: 2 },
      injection: '[coord+2]\n- su-pe a long peer message',
      context_gauge: '',
    });
    // The cursor is staged from the FULL surface, before slimming.
    expect(d.stageInboxCursor).toHaveBeenCalledWith('su-abc', { since_ts: '2026-07-13T19:59:30.000Z' });
    expect(JSON.stringify(inbox).length).toBeLessThan(400);
  });

  it('preserves an empty entries list, which the Claude hook reads as "show the gauge"', () => {
    expect(hookInboxSurface({ entries: [], context_gauge: 'ctx 85%' })).toEqual({ entries: [], context_gauge: 'ctx 85%' });
  });

  it('leaves a non-array entries value untouched and tolerates non-object entries', () => {
    expect(hookInboxSurface({ entries: null })).toEqual({ entries: null });
    expect(hookInboxSurface({ entries: [null, 'x', { ts: 't' }] })).toEqual({ entries: [{}, {}, { ts: 't' }] });
  });
});
