/**
 * Blocker auto-clear (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * Clauses under test:
 *   AUTO-BAR-R-10-P-011 — when a work item referenced by another item's blocker
 *     reaches a terminal state, the blocker is cleared with history preserved and
 *     the blocked item's holder is woken.
 *   SPEC-P-011 — a blocker that references a non-terminal work item stays set.
 *
 * Plan event-wait-settlement-2026-10-20 P-003 (the shared follow-up after every system clear):
 *   AUTO-BAR-R-5-P-003 — the holder of an item receives a waking coord message when the
 *     system clears the item's last blocker, on every settlement path.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';

const sync = vi.hoisted(() => ({ notifySyncInvalidate: vi.fn(async () => undefined) }));
vi.mock('./sync-sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sync-sse')>()),
  notifySyncInvalidate: sync.notifySyncInvalidate,
}));

import {
  BLOCKER_AUTO_CLEAR_ACTOR,
  CLAIMABLE_WORK_QUERY_NAMES,
  clearBlockersNamingFinishedWorkItems,
  finishedWorkItemIdOfDoneKey,
  followUpAutoClearedBlockers,
  followUpSystemClears,
  planWorkItemRefBlockerClears,
  productionBlockerAutoClearFollowUpDeps,
  workItemIdsNamedByBlockerRef,
  type AutoClearedBlockerItem,
  type BlockerAutoClearFollowUpDeps,
  type SystemClearedBlockerItem,
} from './work-item-ref-blocker-auto-clear';

const T0 = '2026-10-12T10:00:00.000Z';
const NOW = '2026-10-12T18:30:00.000Z';

function blocker(ref: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'runtime',
    capability: 'live-dependency',
    capabilitySource: 'explicit',
    ref,
    summary: `waiting on ${ref}`,
    status: 'active',
    createdAt: T0,
    createdBy: 'su-blocked-holder',
    updatedAt: T0,
    ...over,
  };
}

type Row = {
  workspace_id: string;
  feature_id: string;
  item_kind: string | null;
  status: string | null;
  payload: unknown;
  harness_slug: string | null;
  taken_by: string | null;
};

function lockedRow(over: Partial<Row> & { blockers: unknown[] }): Row {
  const { blockers, ...rest } = over;
  return {
    workspace_id: 'ws-1',
    feature_id: 'EI-100',
    item_kind: 'bug',
    status: 'blocked',
    payload: { externalBlockers: blockers, held_open_reason: 'blocked', held_open_by: 'su-x', _claimHold: { by: 'su-x' } },
    harness_slug: 'papercusp',
    taken_by: 'su-blocked-holder',
    ...rest,
  };
}

/** A tagged-template stand-in for a postgres.js transaction that answers the
 *  three statements the clear issues and records every call. */
function fakeTx(locked: Row[], states: Array<{ feature_id: string; status: string | null }>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    if (text.includes('FOR UPDATE OF wi')) return Promise.resolve(locked);
    if (text.includes('SELECT feature_id, status')) return Promise.resolve(states);
    if (text.includes('UPDATE harness_shared.work_items')) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected statement: ${text}`));
  };
  const updates = () =>
    calls
      .filter((c) => c.text.includes('UPDATE harness_shared.work_items'))
      .map((c) => ({
        payload: JSON.parse(String(c.values[0])) as Record<string, unknown>,
        restore: c.values[1],
        featureId: c.values[4],
      }));
  return { tx: tx as unknown as TransactionSql, calls, updates };
}

describe('workItemIdsNamedByBlockerRef', () => {
  it('reads a bare id, a done-event key and a qualified ref', () => {
    expect(workItemIdsNamedByBlockerRef('WI-123')).toEqual(['WI-123']);
    expect(workItemIdsNamedByBlockerRef('work-item:done:EI-25797215875325690')).toEqual(['EI-25797215875325690']);
    expect(workItemIdsNamedByBlockerRef('root-disk-headroom / WI-10004397')).toEqual(['WI-10004397']);
    expect(workItemIdsNamedByBlockerRef('F-12 then WI-5 and WI-5 again')).toEqual(['F-12', 'WI-5']);
  });

  it('matches whole tokens only', () => {
    expect(workItemIdsNamedByBlockerRef('waiting on WI-10')).toEqual(['WI-10']);
    expect(workItemIdsNamedByBlockerRef('SPEC-F-1 PWI-3 P-011 gate:green-checkpoint WI-7x')).toEqual([]);
  });
});

describe('the completion fire key (event-wait-settlement-2026-10-20 P-007)', () => {
  it('names the one work-item id a work-item:done key carries', () => {
    expect(finishedWorkItemIdOfDoneKey('work-item:done:WI-6554700010018159')).toBe('WI-6554700010018159');
    expect(finishedWorkItemIdOfDoneKey('  work-item:done:EI-12 ')).toBe('EI-12');
    expect(finishedWorkItemIdOfDoneKey('work-item:done:F-7')).toBe('F-7');
  });

  it('names nothing for another key, a non-id subject, or a subject that is more than one id', () => {
    for (const key of [
      'work-item:claimable', 'work-item:done:', 'work-item:done:WI-nobody-waits', 'work-item:done:WI-12x',
      'work-item:done:WI-1,WI-2', 'work-item:unblocked:WI-12', 'release:deployed:abc123', 'xwork-item:done:WI-1',
    ]) {
      expect(finishedWorkItemIdOfDoneKey(key), key).toBeNull();
    }
  });

  it('the fixture copy of migration 1543\'s function is the migration\'s own body', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const armed = path.resolve(here, '../../../libs/papercusp/libs/db/sql/1543-work-items-dependency-ref-ids-idx.sql');
    const migration = readFileSync(existsSync(armed) ? armed : `${armed}.DRAFT`, 'utf8');
    const fixture = readFileSync(path.resolve(here, '../test/_work-items-schema.ts'), 'utf8');
    const fnBody = (text: string) => {
      const m = /CREATE OR REPLACE FUNCTION harness_shared\.active_dependency_blocker_item_ids[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(text);
      expect(m, 'function definition present').not.toBeNull();
      return m![0].replace(/\s+/g, ' ').trim();
    };
    expect(fnBody(fixture)).toBe(fnBody(migration));
  });
});

describe('planWorkItemRefBlockerClears', () => {
  const finished = new Set(['WI-9']);

  it('SPEC-P-011: a blocker naming a non-terminal work item stays set', () => {
    const payload = { externalBlockers: [blocker('WI-9')] };
    expect(planWorkItemRefBlockerClears(payload, finished, new Map([['WI-9', 'wip']]))).toEqual([]);
    expect(planWorkItemRefBlockerClears(payload, finished, new Map([['WI-9', 'open']]))).toEqual([]);
    // An id the database did not return is not known to be terminal.
    expect(planWorkItemRefBlockerClears(payload, finished, new Map())).toEqual([]);
  });

  it('SPEC-P-011: a blocker naming a terminal AND a non-terminal item stays set', () => {
    const payload = { externalBlockers: [blocker('WI-9 + WI-8')] };
    const states = new Map([['WI-9', 'done'], ['WI-8', 'wip']]);
    expect(planWorkItemRefBlockerClears(payload, finished, states)).toEqual([]);
  });

  it('clears a live-dependency blocker once every id it names is terminal', () => {
    const payload = { externalBlockers: [blocker('root-disk-headroom / WI-9'), blocker('WI-9 + WI-8')] };
    const states = new Map([['WI-9', 'done'], ['WI-8', 'dropped']]);
    expect(planWorkItemRefBlockerClears(payload, finished, states)).toEqual([
      {
        kind: 'runtime',
        ref: 'root-disk-headroom / WI-9',
        namedIds: ['WI-9'],
        endedWithoutDone: [],
        evidence: 'auto-cleared: WI-9 is done',
      },
      {
        kind: 'runtime',
        ref: 'WI-9 + WI-8',
        namedIds: ['WI-9', 'WI-8'],
        endedWithoutDone: ['WI-8'],
        evidence: 'auto-cleared: WI-9 is done, WI-8 is dropped',
      },
    ]);
  });

  it('leaves owner-capability asks, cleared records and unrelated refs alone', () => {
    const payload = {
      externalBlockers: [
        blocker('owner decides on WI-9', { kind: 'human', capability: 'product-decision' }),
        blocker('WI-9', { capability: 'credential' }),
        blocker('WI-9', { status: 'cleared', clearedAt: T0, clearedBy: 'su-a' }),
        blocker('WI-4'),
      ],
    };
    const states = new Map([['WI-9', 'done'], ['WI-4', 'done']]);
    expect(planWorkItemRefBlockerClears(payload, finished, states)).toEqual([]);
  });
});

describe('clearBlockersNamingFinishedWorkItems', () => {
  it('AUTO-BAR-R-10: clears the blocker, keeps its history and restores an auto-parked issue', async () => {
    const original = blocker('work-item:done:WI-9', { kind: 'event' });
    const other = blocker('gate:release', { kind: 'gate', status: 'cleared', clearedAt: T0, clearedBy: 'su-a' });
    const { tx, calls, updates } = fakeTx([lockedRow({ blockers: [other, original] })], [{ feature_id: 'WI-9', status: 'done' }]);

    const out = await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: ['WI-9'], now: NOW });

    const select = calls[0]!;
    expect(select.text).toContain("payload ? 'externalBlockers'");
    expect(select.values).toContain('ws-1');
    expect(select.values).toContainEqual(['%WI-9%']);

    const [update] = updates();
    expect(update!.featureId).toBe('EI-100');
    expect(update!.restore).toBe(true);
    const history = update!.payload.externalBlockers as Array<Record<string, unknown>>;
    // History preserved: both records remain, the original fields are intact.
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ ref: 'gate:release', status: 'cleared', clearedBy: 'su-a' });
    expect(history[1]).toMatchObject({
      kind: 'event',
      ref: 'work-item:done:WI-9',
      summary: 'waiting on work-item:done:WI-9',
      createdAt: T0,
      createdBy: 'su-blocked-holder',
      status: 'cleared',
      clearedAt: NOW,
      clearedBy: BLOCKER_AUTO_CLEAR_ACTOR,
      evidence: 'auto-cleared: WI-9 is done',
    });
    // The auto-park lease is lifted with the last active blocker.
    expect(update!.payload).not.toHaveProperty('held_open_reason');
    expect(update!.payload).not.toHaveProperty('_claimHold');

    expect(out).toEqual([
      expect.objectContaining({
        featureId: 'EI-100',
        family: 'issue',
        status: 'open',
        holder: 'su-blocked-holder',
        restored: true,
        activeRemaining: 0,
      }),
    ]);
  });

  it('SPEC-P-011: writes nothing while a referenced item is still open', async () => {
    const { tx, updates } = fakeTx(
      [lockedRow({ blockers: [blocker('WI-9 + WI-8')] })],
      [
        { feature_id: 'WI-9', status: 'done' },
        { feature_id: 'WI-8', status: 'open' },
      ],
    );
    expect(await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: ['WI-9'], now: NOW })).toEqual([]);
    expect(updates()).toEqual([]);
  });

  it('treats an id with any non-terminal row as not terminal', async () => {
    const { tx, updates } = fakeTx(
      [lockedRow({ blockers: [blocker('WI-9')] })],
      [
        { feature_id: 'WI-9', status: 'done' },
        { feature_id: 'WI-9', status: 'wip' },
      ],
    );
    expect(await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: ['WI-9'], now: NOW })).toEqual([]);
    expect(updates()).toEqual([]);
  });

  it('keeps a feature parked while another blocker is active and reports it', async () => {
    const { tx, updates } = fakeTx(
      [
        lockedRow({
          feature_id: 'WI-200',
          item_kind: 'feature',
          blockers: [blocker('WI-9'), blocker('credential for the Stripe account', { kind: 'human', capability: 'credential' })],
        }),
      ],
      [{ feature_id: 'WI-9', status: 'closed' }],
    );
    const [item] = await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: ['WI-9'], now: NOW });
    expect(item).toMatchObject({ featureId: 'WI-200', family: 'feature', status: 'blocked', restored: false, activeRemaining: 1 });
    expect(item!.cleared[0]).toMatchObject({ ref: 'WI-9', endedWithoutDone: ['WI-9'] });
    expect(updates()[0]!.restore).toBe(false);
  });

  it('issues no SQL for empty or malformed ids', async () => {
    const { tx, calls } = fakeTx([], []);
    expect(await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: [] })).toEqual([]);
    expect(await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: 'ws-1', ids: ['P-011', ' '] })).toEqual([]);
    expect(await clearBlockersNamingFinishedWorkItems(tx, { workspaceId: '', ids: ['WI-9'] })).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('followUpAutoClearedBlockers', () => {
  function item(over: Partial<AutoClearedBlockerItem> = {}): AutoClearedBlockerItem {
    return {
      workspaceId: 'ws-1',
      featureId: 'EI-100',
      harnessSlug: 'papercusp',
      family: 'issue',
      status: 'open',
      holder: 'su-blocked-holder',
      restored: true,
      activeRemaining: 0,
      cleared: [{ kind: 'runtime', ref: 'WI-9', namedIds: ['WI-9'], endedWithoutDone: [], evidence: 'auto-cleared: WI-9 is done' }],
      ...over,
    };
  }

  function deps(over: Partial<BlockerAutoClearFollowUpDeps> = {}) {
    return {
      unparkFeature: vi.fn(async () => ({})),
      send: vi.fn(async () => ({})),
      wake: vi.fn(async () => ({})),
      invalidate: vi.fn(async () => undefined),
      ...over,
    };
  }

  it('AUTO-BAR-R-10: messages and wakes the blocked item holder', async () => {
    const d = deps();
    const [result] = await followUpAutoClearedBlockers([item()], d);
    expect(d.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', to: 'su-blocked-holder', harnessSlug: 'papercusp' }),
    );
    const sent = vi.mocked(d.send).mock.calls[0]![0];
    expect(sent.summary).toContain('EI-100');
    expect(sent.summary).toContain('WI-9');
    expect(sent.body).toContain('No active blocker remains on EI-100.');
    expect(d.wake).toHaveBeenCalledWith({ workspaceId: 'ws-1', to: 'su-blocked-holder', summary: sent.summary });
    expect(d.unparkFeature).not.toHaveBeenCalled();
    expect(result).toEqual({ featureId: 'EI-100', unparked: null, invalidated: true, notified: true, woken: true, errors: [] });
  });

  it('un-parks a blocked feature only when nothing else holds it', async () => {
    const d = deps();
    await followUpAutoClearedBlockers(
      [
        item({ featureId: 'WI-1', family: 'feature', status: 'blocked', activeRemaining: 0 }),
        item({ featureId: 'WI-2', family: 'feature', status: 'blocked', activeRemaining: 1 }),
        item({ featureId: 'WI-3', family: 'feature', status: 'wip', activeRemaining: 0 }),
      ],
      d,
    );
    expect(d.unparkFeature).toHaveBeenCalledTimes(1);
    expect(d.unparkFeature).toHaveBeenCalledWith({ id: 'WI-1', harness: 'papercusp', by: BLOCKER_AUTO_CLEAR_ACTOR });
  });

  it('tells the holder when a dependency ended without being finished', async () => {
    const d = deps();
    await followUpAutoClearedBlockers(
      [
        item({
          cleared: [{ kind: 'runtime', ref: 'WI-9', namedIds: ['WI-9'], endedWithoutDone: ['WI-9'], evidence: 'auto-cleared: WI-9 is dropped' }],
          activeRemaining: 2,
        }),
      ],
      d,
    );
    const body = vi.mocked(d.send).mock.calls[0]![0].body;
    expect(body).toContain('WI-9 ended without being finished');
    expect(body).toContain('2 other active blocker(s) still hold EI-100');
  });

  it('skips the message with no holder and survives a failing step', async () => {
    const quiet = deps();
    expect(await followUpAutoClearedBlockers([item({ holder: null })], quiet)).toEqual([
      { featureId: 'EI-100', unparked: null, invalidated: true, notified: false, woken: false, errors: [] },
    ]);
    expect(quiet.send).not.toHaveBeenCalled();
    expect(quiet.wake).not.toHaveBeenCalled();

    const failing = deps({ send: vi.fn(async () => { throw new Error('inbox down'); }) });
    const [result] = await followUpAutoClearedBlockers([item()], failing);
    expect(result).toEqual({
      featureId: 'EI-100', unparked: null, invalidated: true, notified: false, woken: true, errors: ['send: inbox down'],
    });
  });
});

describe('the follow-up after every system clear (event-wait-settlement-2026-10-20 P-003)', () => {
  function deps() {
    return {
      unparkFeature: vi.fn<BlockerAutoClearFollowUpDeps['unparkFeature']>(async () => ({})),
      send: vi.fn<BlockerAutoClearFollowUpDeps['send']>(async () => ({})),
      wake: vi.fn<BlockerAutoClearFollowUpDeps['wake']>(async () => ({})),
      invalidate: vi.fn<BlockerAutoClearFollowUpDeps['invalidate']>(async () => undefined),
    } satisfies BlockerAutoClearFollowUpDeps;
  }

  // One item per settlement path, in the shape that path builds after its transaction commits.
  const announcedSettlement: SystemClearedBlockerItem = {
    workspaceId: 'ws-1', featureId: 'WI-41', harnessSlug: 'papercusp', family: 'feature', status: 'blocked',
    holder: 'su-holder-a', restored: false, activeRemaining: 0, clearedBy: 'su-producer',
    cleared: [{ kind: 'event', ref: 'release:deployed:abc123', evidence: 'announced event "release:deployed:abc123" settled' }],
  };
  const parkSettlement: SystemClearedBlockerItem = {
    workspaceId: 'ws-1', featureId: 'EI-42', harnessSlug: 'papercusp', family: 'issue', status: 'open',
    holder: 'su-parker-b', restored: true, activeRemaining: 0, clearedBy: 'system:event-settlement',
    cleared: [{ kind: 'durable-park', ref: 'work-item:done:WI-7', evidence: 'announcement trigger "work-item:done:WI-7" fired' }],
  };
  const recheckSweep: SystemClearedBlockerItem = {
    workspaceId: 'ws-1', featureId: 'WI-43', harnessSlug: 'papercusp', family: 'feature', status: 'open',
    holder: 'su-holder-c', restored: true, activeRemaining: 0, clearedBy: 'system:blocker-default-reaper',
    cleared: [{ kind: 'gate', ref: 'plan:acceptance:x', evidence: 'current event generation fired' }],
  };

  it.each([
    ['announced settlement', announcedSettlement],
    ['durable-park settlement', parkSettlement],
    ['the re-check sweep', recheckSweep],
  ] as const)('AUTO-BAR-R-5-P-003: after %s clears the last wait, the holder gets a message and a wake', async (_path, item) => {
    const d = deps();
    const [result] = await followUpAutoClearedBlockers([item], d);

    expect(d.send).toHaveBeenCalledTimes(1);
    const sent = d.send.mock.calls[0]![0];
    expect(sent).toMatchObject({ workspaceId: 'ws-1', to: item.holder, harnessSlug: 'papercusp' });
    expect(sent.summary).toContain(item.featureId);
    expect(sent.summary).toContain(item.cleared[0]!.ref);
    expect(sent.body).toContain(`clearedBy ${item.clearedBy}`);
    expect(sent.body).toContain(`No active blocker remains on ${item.featureId}.`);
    expect(d.wake).toHaveBeenCalledWith({ workspaceId: 'ws-1', to: item.holder, summary: sent.summary });
    expect(result).toMatchObject({ notified: true, woken: true, invalidated: true, errors: [] });
  });

  it('names a released durable park as a park, not a blocker', async () => {
    const d = deps();
    await followUpAutoClearedBlockers([parkSettlement], d);
    const sent = d.send.mock.calls[0]![0];
    expect(sent.summary.startsWith('Park released on EI-42:')).toBe(true);
    expect(sent.body).toContain('- durable park "work-item:done:WI-7"');
  });

  it('AUTO-BAR-R-4-P-003: un-parks the feature that set_blocker parked once its last wait is gone, and no other', async () => {
    const d = deps();
    await followUpAutoClearedBlockers([announcedSettlement, recheckSweep, { ...announcedSettlement, featureId: 'WI-44', activeRemaining: 1 }], d);
    // recheckSweep's item is already 'open' (the sweep restored it); WI-44 still has a blocker.
    expect(d.unparkFeature).toHaveBeenCalledTimes(1);
    expect(d.unparkFeature).toHaveBeenCalledWith({ id: 'WI-41', harness: 'papercusp', by: BLOCKER_AUTO_CLEAR_ACTOR });
  });

  it('refreshes the claimable views only when the item has no wait left, and still tells the holder', async () => {
    const d = deps();
    const [result] = await followUpAutoClearedBlockers([{ ...announcedSettlement, activeRemaining: 2 }], d);
    expect(d.invalidate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ invalidated: false, notified: true, woken: true });
    expect(d.send.mock.calls[0]![0].body).toContain('2 other active blocker(s) still hold WI-41');
  });

  it('production invalidate refreshes every claimable-work sync query', async () => {
    sync.notifySyncInvalidate.mockClear();
    await productionBlockerAutoClearFollowUpDeps().invalidate({ workspaceId: 'ws-1', harnessSlug: 'papercusp' });
    expect(CLAIMABLE_WORK_QUERY_NAMES).toEqual(['workItems.byHarness', 'workItems.summary']);
    expect(sync.notifySyncInvalidate.mock.calls.map((call) => (call as unknown[])[0])).toEqual([...CLAIMABLE_WORK_QUERY_NAMES]);
  });

  it('followUpSystemClears is a no-op on nothing and never throws', async () => {
    const d = deps();
    expect(await followUpSystemClears([], d)).toEqual([]);
    const throwing = { ...d, wake: () => { throw new Error('sync throw'); } } as BlockerAutoClearFollowUpDeps;
    await expect(followUpSystemClears([announcedSettlement], throwing)).resolves.toEqual([
      expect.objectContaining({ notified: true, woken: false, errors: ['wake: sync throw'] }),
    ]);
  });
});
