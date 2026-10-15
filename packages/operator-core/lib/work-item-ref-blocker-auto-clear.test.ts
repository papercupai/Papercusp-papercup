/**
 * Blocker auto-clear (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * Clauses under test:
 *   AUTO-BAR-R-10-P-011 — when a work item referenced by another item's blocker
 *     reaches a terminal state, the blocker is cleared with history preserved and
 *     the blocked item's holder is woken.
 *   SPEC-P-011 — a blocker that references a non-terminal work item stays set.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import {
  BLOCKER_AUTO_CLEAR_ACTOR,
  clearBlockersNamingFinishedWorkItems,
  followUpAutoClearedBlockers,
  planWorkItemRefBlockerClears,
  workItemIdsNamedByBlockerRef,
  type AutoClearedBlockerItem,
  type BlockerAutoClearFollowUpDeps,
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
    expect(result).toEqual({ featureId: 'EI-100', unparked: null, notified: true, woken: true, errors: [] });
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
      { featureId: 'EI-100', unparked: null, notified: false, woken: false, errors: [] },
    ]);
    expect(quiet.send).not.toHaveBeenCalled();
    expect(quiet.wake).not.toHaveBeenCalled();

    const failing = deps({ send: vi.fn(async () => { throw new Error('inbox down'); }) });
    const [result] = await followUpAutoClearedBlockers([item()], failing);
    expect(result).toEqual({ featureId: 'EI-100', unparked: null, notified: false, woken: true, errors: ['send: inbox down'] });
  });
});
