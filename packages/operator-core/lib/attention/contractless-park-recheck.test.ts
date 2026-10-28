/**
 * Unit tests for the contract-less park re-check (WI-6554700010030449). The deps are an
 * in-memory store, so these pin the decisions; the SQL listing and the compare-and-set write
 * run against real Postgres in work-item-blocker-reaper.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { assertHoldRegistered } from '../hold-registry';
import {
  CONTRACTLESS_PARK_RECHECK_ACTOR,
  boundRecheck,
  firstRecheckAt,
  stampContractlessParkRecheckDates,
  sweepDueContractlessParkRechecks,
  type ContractlessParkCandidate,
  type ContractlessParkRecheck,
  type ContractlessParkRecheckDeps,
} from './contractless-park-recheck';

const DAY_MS = assertHoldRegistered('park', 'park').recheckSec * 1000;
const NOW = new Date('2026-10-27T12:00:00.000Z');

function park(id: string, over: Partial<ContractlessParkCandidate> = {}): ContractlessParkCandidate {
  return {
    id, harness: 'papercusp', parkedBy: 'su-parker', parkedAt: '2026-10-27T11:00:00.000Z', parkedReason: 'waiting on a review',
    recheck: null, hasContract: false, hasActiveBlocker: false, leaseOnly: false, ...over,
  };
}

function fakeDeps(rows: ContractlessParkCandidate[]) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const escalate = vi.fn(async (_p: ContractlessParkCandidate, _r: ContractlessParkRecheck) => {});
  const deps: ContractlessParkRecheckDeps = {
    async listUnstamped(limit, afterId) {
      return [...store.values()]
        .filter((p) => !p.hasContract && !p.hasActiveBlocker && !p.leaseOnly && !boundRecheck(p) && p.id > (afterId ?? ''))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async listDue(nowIso, limit) {
      return [...store.values()]
        .filter((p) => {
          const at = (p.recheck as { recheckAt?: string } | null)?.recheckAt;
          return typeof at === 'string' && at <= nowIso;
        })
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async writeRecheck(p, next) {
      const cur = store.get(p.id);
      if (!cur || JSON.stringify(cur.recheck) !== JSON.stringify(p.recheck)) return false;
      cur.recheck = next;
      return true;
    },
    escalate,
  };
  return { deps, store, escalate };
}

describe('firstRecheckAt', () => {
  it('waits one interval after the park when that is still ahead', () => {
    expect(firstRecheckAt({ id: 'WI-1', parkedAt: '2026-10-27T11:00:00.000Z' }, NOW, DAY_MS))
      .toBe(new Date(Date.parse('2026-10-27T11:00:00.000Z') + DAY_MS).toISOString());
  });
  it('spreads a backlog park across the next interval by id, deterministically', () => {
    const old = '2026-09-01T00:00:00.000Z';
    const ats = ['WI-a', 'WI-b', 'WI-c', 'WI-d', 'WI-e'].map((id) => Date.parse(firstRecheckAt({ id, parkedAt: old }, NOW, DAY_MS)));
    for (const at of ats) {
      expect(at).toBeGreaterThanOrEqual(NOW.getTime());
      expect(at).toBeLessThan(NOW.getTime() + DAY_MS);
    }
    expect(new Set(ats).size).toBeGreaterThan(1);
    expect(firstRecheckAt({ id: 'WI-a', parkedAt: old }, NOW, DAY_MS)).toBe(new Date(ats[0]!).toISOString());
  });
  it('treats a missing or unparseable park time as backlog, and caps a future one at one interval from now', () => {
    for (const parkedAt of [null, 'not-a-date']) {
      const at = Date.parse(firstRecheckAt({ id: 'WI-x', parkedAt }, NOW, DAY_MS));
      expect(at).toBeGreaterThanOrEqual(NOW.getTime());
      expect(at).toBeLessThan(NOW.getTime() + DAY_MS);
    }
    expect(firstRecheckAt({ id: 'WI-x', parkedAt: '2027-01-01T00:00:00.000Z' }, NOW, DAY_MS))
      .toBe(new Date(NOW.getTime() + DAY_MS).toISOString());
  });
});

describe('boundRecheck', () => {
  const rec = { recheckAt: '2026-10-28T00:00:00.000Z', parkedBy: 'su-parker', parkedAt: '2026-10-27T11:00:00.000Z', source: 'x' };
  it('returns the record only for the park it was stamped for', () => {
    expect(boundRecheck(park('WI-1', { recheck: rec }))?.recheckAt).toBe(rec.recheckAt);
    expect(boundRecheck(park('WI-1', { recheck: rec, parkedBy: 'su-other' }))).toBeNull();
    expect(boundRecheck(park('WI-1', { recheck: rec, parkedAt: '2026-10-27T11:30:00.000Z' }))).toBeNull();
  });
  it('rejects absent, malformed, and undated records', () => {
    for (const recheck of [null, 'x', [], { ...rec, recheckAt: 'soon' }, { parkedBy: 'su-parker' }]) {
      expect(boundRecheck(park('WI-1', { recheck }))).toBeNull();
    }
  });
});

describe('stampContractlessParkRecheckDates', () => {
  it('stamps every uncovered contract-less park once, bound to its park', async () => {
    const { deps, store } = fakeDeps([park('WI-1'), park('WI-2', { parkedAt: '2026-09-01T00:00:00.000Z' })]);
    const first = await stampContractlessParkRecheckDates({ now: NOW, deps });
    expect(first).toMatchObject({ parks: 2, stamped: 2, skipped: {}, nextAfterId: null, truncatedByLimit: false });
    expect(store.get('WI-1')!.recheck).toEqual({
      recheckAt: new Date(Date.parse('2026-10-27T11:00:00.000Z') + DAY_MS).toISOString(),
      parkedBy: 'su-parker', parkedAt: '2026-10-27T11:00:00.000Z', source: CONTRACTLESS_PARK_RECHECK_ACTOR,
    });
    expect((await stampContractlessParkRecheckDates({ now: NOW, deps })).parks).toBe(0);
  });
  it('pages by id and reports where to resume', async () => {
    const { deps } = fakeDeps(['WI-1', 'WI-2', 'WI-3'].map((id) => park(id)));
    const a = await stampContractlessParkRecheckDates({ now: NOW, deps, limit: 2 });
    expect(a).toMatchObject({ parks: 2, stamped: 2, nextAfterId: 'WI-2', truncatedByLimit: true });
    const b = await stampContractlessParkRecheckDates({ now: NOW, deps, limit: 2, afterId: a.nextAfterId });
    expect(b).toMatchObject({ parks: 1, stamped: 1, nextAfterId: null, truncatedByLimit: false });
  });
  it('re-stamps a park whose record belongs to an earlier park, and writes nothing on a dry run', async () => {
    const stale = { recheckAt: '2026-10-20T00:00:00.000Z', parkedBy: 'su-earlier', parkedAt: '2026-10-19T00:00:00.000Z', source: 'x' };
    const { deps, store } = fakeDeps([park('WI-1', { recheck: stale })]);
    expect(await stampContractlessParkRecheckDates({ now: NOW, deps, dryRun: true })).toMatchObject({ stamped: 0, wouldStamp: 1 });
    expect(store.get('WI-1')!.recheck).toEqual(stale);
    await stampContractlessParkRecheckDates({ now: NOW, deps });
    expect(store.get('WI-1')!.recheck).toMatchObject({ parkedBy: 'su-parker', parkedAt: '2026-10-27T11:00:00.000Z' });
  });
  it('skips a park another re-check owns and counts a lost compare-and-set', async () => {
    const { deps } = fakeDeps([]);
    deps.listUnstamped = async () => [park('WI-c', { hasContract: true }), park('WI-b', { hasActiveBlocker: true }), park('WI-l', { leaseOnly: true }), park('WI-r')];
    deps.writeRecheck = async () => false;
    expect(await stampContractlessParkRecheckDates({ now: NOW, deps })).toMatchObject({ stamped: 0, skipped: { covered: 3, 'lost-race': 1 } });
  });
});

describe('sweepDueContractlessParkRechecks', () => {
  const due = (over: Partial<ContractlessParkCandidate> = {}) => park('WI-1', {
    recheck: { recheckAt: '2026-10-27T11:59:00.000Z', parkedBy: 'su-parker', parkedAt: '2026-10-27T11:00:00.000Z', source: 'x' },
    ...over,
  });
  it('escalates a due park and re-arms it one interval out, counting escalations', async () => {
    const { deps, store, escalate } = fakeDeps([due()]);
    const swept = await sweepDueContractlessParkRechecks({ now: NOW, deps });
    expect(swept).toEqual({ examined: 1, escalated: 1, dropped: {}, skipped: {}, truncatedByLimit: false });
    expect(escalate).toHaveBeenCalledOnce();
    expect(escalate.mock.calls[0]![1].recheckAt).toBe('2026-10-27T11:59:00.000Z');
    expect(store.get('WI-1')!.recheck).toMatchObject({
      recheckAt: new Date(NOW.getTime() + DAY_MS).toISOString(), recheckedAt: NOW.toISOString(), escalations: 1,
    });
    expect((await sweepDueContractlessParkRechecks({ now: NOW, deps })).examined).toBe(0);
    const later = new Date(NOW.getTime() + DAY_MS);
    await sweepDueContractlessParkRechecks({ now: later, deps });
    expect(store.get('WI-1')!.recheck).toMatchObject({ escalations: 2 });
  });
  it('leaves the date in place when the escalation fails, so the next pass retries', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, store, escalate } = fakeDeps([due()]);
    escalate.mockRejectedValueOnce(new Error('escalation store down'));
    try {
      expect(await sweepDueContractlessParkRechecks({ now: NOW, deps })).toMatchObject({ escalated: 0, skipped: { failed: 1 } });
      expect(store.get('WI-1')!.recheck).toMatchObject({ recheckAt: '2026-10-27T11:59:00.000Z' });
    } finally {
      warning.mockRestore();
    }
  });
  it('drops the date without escalating when a contract, an active blocker, or a lease now owns the park', async () => {
    for (const [over, why] of [[{ hasContract: true }, 'contract'], [{ hasActiveBlocker: true }, 'blocker'], [{ leaseOnly: true }, 'lease']] as const) {
      const { deps, store, escalate } = fakeDeps([due(over)]);
      expect((await sweepDueContractlessParkRechecks({ now: NOW, deps })).dropped).toEqual({ [why]: 1 });
      expect(escalate).not.toHaveBeenCalled();
      expect(store.get('WI-1')!.recheck).toBeNull();
    }
  });
  it('drops a record bound to an earlier park instead of escalating the new one', async () => {
    const { deps, store, escalate } = fakeDeps([due({ parkedBy: 'su-reparker' })]);
    expect((await sweepDueContractlessParkRechecks({ now: NOW, deps })).dropped).toEqual({ stale: 1 });
    expect(escalate).not.toHaveBeenCalled();
    expect(store.get('WI-1')!.recheck).toBeNull();
  });
  it('escalates nothing and writes nothing on a dry run', async () => {
    const { deps, store, escalate } = fakeDeps([due()]);
    expect(await sweepDueContractlessParkRechecks({ now: NOW, deps, dryRun: true })).toMatchObject({ examined: 1, escalated: 1 });
    expect(escalate).not.toHaveBeenCalled();
    expect(store.get('WI-1')!.recheck).toMatchObject({ recheckAt: '2026-10-27T11:59:00.000Z' });
  });
});
