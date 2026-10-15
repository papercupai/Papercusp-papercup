import { describe, expect, it } from 'vitest';
import {
  composeStrandedAppTaskFiling,
  runStrandedAppTaskGuard,
  strandedAppTaskConditionKey,
  type StrandedAppTaskFlag,
  type StrandedAppTaskGroup,
  type StrandedAppTaskGuardDeps,
} from './stranded-app-tasks';

const NOW = new Date('2026-10-06T12:00:00Z');

function group(over: Partial<StrandedAppTaskGroup> = {}): StrandedAppTaskGroup {
  return {
    workspaceId: 'ws',
    harnessSlug: 'email',
    itemKind: 'email-draft-proposal',
    count: 3,
    oldestId: 'WI-1',
    oldestCreatedAt: '2026-09-01T12:00:00Z', // exactly 35d before NOW
    sampleIds: ['WI-1', 'WI-2', 'WI-3'],
    fromTrigger: 3,
    fromOperation: 0,
    ...over,
  };
}

/** In-memory fake of the condition-upsert table: one row per key, claimable state. */
function fakeDeps(groups: StrandedAppTaskGroup[], existing: Array<StrandedAppTaskFlag & { claimed?: boolean }> = []) {
  const rows = new Map(existing.map((f) => [f.conditionKey, { ...f }]));
  const upserts: Array<{ key: string; title: string }> = [];
  const settled: Array<{ id: string; reason: string }> = [];
  let next = 100;
  const deps: StrandedAppTaskGuardDeps = {
    fetchGroups: async () => groups,
    upsertFlag: async (key, filing) => {
      upserts.push({ key, title: filing.title });
      const hit = rows.get(key);
      if (hit) return { id: hit.id, created: false };
      const id = `WI-${next++}`;
      rows.set(key, { conditionKey: key, id, harnessSlug: 'papercusp' });
      return { id, created: true };
    },
    listOpenFlags: async () => [...rows.values()].filter((r) => !r.claimed),
    settleFlag: async (flag, reason) => {
      settled.push({ id: flag.id, reason });
      rows.delete(flag.conditionKey);
    },
  };
  return { deps, upserts, settled, rows };
}

describe('strandedAppTaskConditionKey', () => {
  it('is one key per (workspace, harness, kind) — N stranded rows are one condition', () => {
    expect(strandedAppTaskConditionKey(group())).toBe('app-task-no-executor:ws/email/email-draft-proposal');
    expect(strandedAppTaskConditionKey(group({ harnessSlug: 'calendar' }))).not.toBe(
      strandedAppTaskConditionKey(group()),
    );
  });
});

describe('composeStrandedAppTaskFiling', () => {
  it('names the harness, kind, count, oldest row, origin and the honest dispositions', () => {
    const { title, summary } = composeStrandedAppTaskFiling(group({ count: 129, fromOperation: 2, fromTrigger: 127 }), {
      boundHours: 6,
      now: NOW,
    });
    expect(title).toContain("129 app-created 'email-draft-proposal' task(s) in harness 'email'");
    expect(title).toContain('oldest 35d');
    expect(summary).toContain('never claimed for more than 6h');
    expect(summary).toContain('127 from a trigger binding, 2 from a blueprint operation');
    expect(summary).toContain('Oldest: WI-1');
    expect(summary).toContain('blueprint operation with a worker role');
    expect(summary).toContain('drop them with a reason');
  });

  it('renders a sub-two-day age in hours', () => {
    const { title } = composeStrandedAppTaskFiling(group({ oldestCreatedAt: '2026-10-06T02:00:00Z' }), {
      boundHours: 6,
      now: NOW,
    });
    expect(title).toContain('oldest 10h');
  });
});

describe('runStrandedAppTaskGuard', () => {
  it('flags every stranded group exactly once, keyed per (harness, kind)', async () => {
    const f = fakeDeps([group(), group({ harnessSlug: 'calendar', itemKind: 'meeting-prep', count: 1 })]);
    const res = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(res.groups).toBe(2);
    expect(res.strandedTasks).toBe(4);
    expect(res.flagged.map((x) => x.conditionKey)).toEqual([
      'app-task-no-executor:ws/email/email-draft-proposal',
      'app-task-no-executor:ws/calendar/meeting-prep',
    ]);
    expect(res.flagged.every((x) => x.created)).toBe(true);
    expect(res.settled).toEqual([]);
  });

  it('re-firing refreshes the same flag instead of minting a second one', async () => {
    const f = fakeDeps([group()]);
    await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    const again = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(again.flagged).toEqual([
      { conditionKey: 'app-task-no-executor:ws/email/email-draft-proposal', id: 'WI-100', created: false, count: 3 },
    ]);
    expect(f.rows.size).toBe(1);
  });

  it('settles an unclaimed flag once its group clears, with the reason', async () => {
    const key = 'app-task-no-executor:ws/email/email-draft-proposal';
    const f = fakeDeps([], [{ conditionKey: key, id: 'WI-7', harnessSlug: 'papercusp' }]);
    const res = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(res.settled).toEqual(['WI-7']);
    expect(f.settled[0].reason).toContain('condition cleared');
  });

  it('never settles a flag whose group is still stranded', async () => {
    const key = 'app-task-no-executor:ws/email/email-draft-proposal';
    const f = fakeDeps([group()], [{ conditionKey: key, id: 'WI-7', harnessSlug: 'papercusp' }]);
    const res = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(res.settled).toEqual([]);
    expect(res.flagged[0]).toMatchObject({ id: 'WI-7', created: false });
  });

  it('leaves a flag someone has claimed alone — the claimant owns its close', async () => {
    const key = 'app-task-no-executor:ws/email/email-draft-proposal';
    const f = fakeDeps([], [{ conditionKey: key, id: 'WI-7', harnessSlug: 'papercusp', claimed: true }]);
    const res = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(res.settled).toEqual([]);
    expect(f.settled).toEqual([]);
  });

  it('one failing upsert does not stop the other groups or the settle pass', async () => {
    const stale = 'app-task-no-executor:ws/phone-app/call-wrapup';
    const f = fakeDeps(
      [group(), group({ harnessSlug: 'calendar', itemKind: 'meeting-prep' })],
      [{ conditionKey: stale, id: 'WI-9', harnessSlug: 'papercusp' }],
    );
    const upsert = f.deps.upsertFlag;
    f.deps.upsertFlag = async (key, filing) => {
      if (key.includes('/email/')) throw new Error('boom');
      return upsert(key, filing);
    };
    const res = await runStrandedAppTaskGuard(f.deps, { boundHours: 6, now: NOW });
    expect(res.errors).toEqual([{ conditionKey: 'app-task-no-executor:ws/email/email-draft-proposal', error: 'boom' }]);
    expect(res.flagged.map((x) => x.conditionKey)).toEqual(['app-task-no-executor:ws/calendar/meeting-prep']);
    expect(res.settled).toEqual(['WI-9']);
  });
});
