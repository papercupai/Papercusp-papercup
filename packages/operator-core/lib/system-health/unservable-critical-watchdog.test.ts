/**
 * Tests for unservable-critical-watchdog (EI-19919820196426791 half 2).
 *
 * The two constants under test — the severity set and the age floor — decide this
 * watchdog's ENTIRE alert volume, and getting either wrong reproduces the failure
 * it exists to prevent (a 57-alert first tick trains every reader to ignore it).
 * So the severity narrowing is pinned by a CONTROL that shows the filed
 * critical-OR-major rule cannot separate the populations, and by a CALIBRATION
 * case proving the guard still fires on the thing it is for.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { UnservableSweepDeps } from './unservable-critical-watchdog';

const oracle = vi.hoisted(() => vi.fn());
const openEscalationMock = vi.hoisted(() => vi.fn(async (_identity: unknown, _input: { body: string }) => {}));
const broadcastSevereEventMock = vi.hoisted(() => vi.fn(async (_event: {
  conditionKey?: string;
  oneShot?: boolean;
  summary?: string;
  body?: string;
}) => true));
vi.mock('../work-items', () => ({ explainIssueClaimFloors: oracle }));
vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: openEscalationMock }));
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: broadcastSevereEventMock }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({
  readConditionEnvelopes: async () => [], computeConditionStates: () => [],
}));
import {
  scanUnservableCritical,
  runUnservableCriticalSweepOnce,
  UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS,
  UNSERVABLE_REPORTED_SEVERITIES,
  type UnservableItemRow,
} from './unservable-critical-watchdog';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

function row(over: Partial<UnservableItemRow> & Pick<UnservableItemRow, 'itemId'>): UnservableItemRow {
  return {
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    title: 'a stranded thing',
    severity: 'critical',
    // An oracle `refusedBy` label, not a locally-invented name (WI-2141964).
    floor: 'needs-owner-action',
    createdAtMs: NOW - 30 * DAY,
    lastWriteAtMs: NOW - 30 * DAY,
    ...over,
  };
}

describe('scanUnservableCritical — what is reported', () => {
  it('flags a stranded, untouched critical and reports both clocks', () => {
    const alerts = scanUnservableCritical([row({ itemId: 'WI-1' })], NOW);
    expect(alerts.map((a) => a.itemId)).toEqual(['WI-1']);
    expect(alerts[0].floor).toBe('needs-owner-action');
    expect(alerts[0].untouchedMs).toBe(30 * DAY);
    expect(alerts[0].itemAgeMs).toBe(30 * DAY);
  });

  it('flags a stranded critical on any structural floor, not just the two once hard-coded', () => {
    // The whole of WI-2141964: `claim-hold` and `not-claimable-status` were invisible to
    // the old `lane='observation' OR state='needs-human'` predicate, and accounted for
    // most of the 26 genuinely-stranded aged criticals it could not see.
    const alerts = scanUnservableCritical(
      [
        row({ itemId: 'EI-2', floor: 'observation-lane' }),
        row({ itemId: 'EI-3', floor: 'claim-hold' }),
        row({ itemId: 'EI-4', floor: 'not-claimable-status' }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.floor).sort()).toEqual([
      'claim-hold',
      'not-claimable-status',
      'observation-lane',
    ]);
  });

  it('reports longest-UNTOUCHED first — the most abandoned item is the likeliest real blocker', () => {
    const alerts = scanUnservableCritical(
      [
        row({ itemId: 'newer', lastWriteAtMs: NOW - 8 * DAY }),
        row({ itemId: 'stalest', lastWriteAtMs: NOW - 60 * DAY }),
        row({ itemId: 'middle', lastWriteAtMs: NOW - 20 * DAY }),
      ],
      NOW,
    );
    expect(alerts.map((a) => a.itemId)).toEqual(['stalest', 'middle', 'newer']);
  });

  it('REGRESSION (WI-2141964): an ANCIENT item written to recently is NOT reported', () => {
    // The creation basis this replaced would alarm on this row — it is 200 days old — even
    // though somebody wrote to it yesterday, i.e. it is actively being handled. That false
    // positive is half of why the live alert volume had drifted to 24 from the 5 this
    // watchdog was tuned for. The stranding signal is ABANDONMENT, which is what this
    // file's own header always claimed ("NOBODY EVER WROTE TO IT AGAIN").
    const ancientButActive = row({
      itemId: 'being-worked',
      createdAtMs: NOW - 200 * DAY,
      lastWriteAtMs: NOW - 1 * DAY,
    });
    expect(scanUnservableCritical([ancientButActive], NOW)).toEqual([]);

    // CALIBRATION: the same row, abandoned, IS reported — so the empty result above is the
    // last-write basis discriminating, not the classifier being inert.
    const ancientAndAbandoned = row({
      itemId: 'being-worked',
      createdAtMs: NOW - 200 * DAY,
      lastWriteAtMs: NOW - 30 * DAY,
    });
    expect(scanUnservableCritical([ancientAndAbandoned], NOW).map((a) => a.itemId)).toEqual([
      'being-worked',
    ]);
  });

  it('CALIBRATION: a critical touched more recently than the floor is not reported', () => {
    const justUnder = row({
      itemId: 'fresh',
      lastWriteAtMs: NOW - (UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS - 1),
    });
    expect(scanUnservableCritical([justUnder], NOW)).toEqual([]);
    // ...and the SAME row one millisecond staler is reported, so the empty result
    // above is the threshold working rather than the classifier being inert.
    const justOver = row({
      itemId: 'fresh',
      lastWriteAtMs: NOW - UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS,
    });
    expect(scanUnservableCritical([justOver], NOW).map((a) => a.itemId)).toEqual(['fresh']);
  });

  it('does NOT report major — the filed critical-OR-major spec was measured as noise', () => {
    // 2026-08-19, live papercusp backlog, non-terminal, past 7 days:
    //   critical only .....  5 rows
    //   critical OR major .. 57 rows
    // 57 open escalations is a backlog listing, and the reader stops looking —
    // which IS the failure this watchdog exists to prevent. If you widen this,
    // widen it against a FRESH measurement, not against the filed prose.
    const majors = [
      row({ itemId: 'M-1', severity: 'major' }),
      row({ itemId: 'M-2', severity: 'major', floor: 'observation-lane' }),
    ];
    expect(scanUnservableCritical(majors, NOW)).toEqual([]);
    expect(UNSERVABLE_REPORTED_SEVERITIES).toEqual(['critical']);
  });

  it('CONTROL: the filed critical-OR-major rule provably cannot separate the two populations', () => {
    const mixed = [
      row({ itemId: 'crit', severity: 'critical' }),
      row({ itemId: 'maj', severity: 'major' }),
    ];
    // The shipped rule separates them...
    expect(scanUnservableCritical(mixed, NOW).map((a) => a.itemId)).toEqual(['crit']);
    // ...while the rule as FILED admits both, which is the 57-row outcome.
    const asFiled = scanUnservableCritical(mixed, NOW, { severities: ['critical', 'major'] });
    expect(asFiled.map((a) => a.itemId).sort()).toEqual(['crit', 'maj']);
  });

  it('ANTI-VACUITY: the shipped thresholds are non-degenerate', () => {
    // A severity set that matched nothing, or an age floor beyond any real item,
    // would make every assertion above pass while the watchdog never fired in
    // production. Pin both against a row that MUST be reported.
    expect(UNSERVABLE_REPORTED_SEVERITIES.length).toBeGreaterThan(0);
    expect(UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS).toBeGreaterThan(0);
    expect(UNSERVABLE_CRITICAL_MIN_UNTOUCHED_MS).toBeLessThan(30 * DAY);
    // 19 days untouched — the filed instance's own shape (cup:spawn, hidden 19 days).
    const realistic = row({
      itemId: 'real',
      createdAtMs: NOW - 19 * DAY,
      lastWriteAtMs: NOW - 19 * DAY,
    });
    expect(scanUnservableCritical([realistic], NOW)).toHaveLength(1);
  });
});

describe('runUnservableCriticalSweepOnce', () => {
  const sql = {} as never;

  it('is a REAL kill-switch when the flag is off — it does not even read rows', async () => {
    let read = 0;
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => false,
      readRows: async () => {
        read += 1;
        return [row({ itemId: 'WI-1' })];
      },
      escalate: async () => {
        throw new Error('must not escalate while disabled');
      },
      now: () => NOW,
    });
    expect(res).toEqual({ scanned: 0, escalated: 0, failed: 0, skipped: true });
    expect(read).toBe(0);
  });

  it('escalates each stranded item', async () => {
    const seen: string[] = [];
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [row({ itemId: 'WI-1' }), row({ itemId: 'WI-2' })],
      escalate: async (a) => {
        seen.push(a.itemId);
      },
      now: () => NOW,
    });
    expect(seen).toEqual(['WI-1', 'WI-2']);
    expect(res).toMatchObject({ scanned: 2, escalated: 2, failed: 0, skipped: false });
  });

  it('recommends claimHold:false to lift a durable claim hold', async () => {
    broadcastSevereEventMock.mockClear();
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [row({ itemId: 'WI-held', floor: 'claim-hold' })],
      escalate: async () => {},
      now: () => NOW,
    });
    expect(res).toMatchObject({ scanned: 1, escalated: 1, failed: 0, skipped: false });
    const body = broadcastSevereEventMock.mock.calls[0]?.[0]?.body;
    expect(body).toContain("work_items:release { id: 'WI-held', claimHold: false } to lift it");
    expect(body).not.toContain('claimHold: true');
  });

  it('one failing escalate does not abort the batch — the rest still report, and the failure is logged not swallowed', async () => {
    const seen: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [
        row({ itemId: 'bad', createdAtMs: NOW - 60 * DAY }),
        row({ itemId: 'good', createdAtMs: NOW - 20 * DAY }),
      ],
      escalate: async (a) => {
        if (a.itemId === 'bad') throw new Error('escalation surface down');
        seen.push(a.itemId);
      },
      now: () => NOW,
    });
    expect(seen).toEqual(['good']);
    expect(res).toMatchObject({ scanned: 2, escalated: 1, failed: 1, skipped: false });
    // A silently-dropped escalation would leave the stranded item invisible AND
    // leave no trace that it was meant to be reported — assert the warning names
    // the item, so a future refactor cannot quietly swallow it.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('bad');
    warn.mockRestore();
  });

  it('rows that do not meet the thresholds are scanned but not escalated', async () => {
    const res = await runUnservableCriticalSweepOnce(sql, {
      flagEnabled: async () => true,
      readRows: async () => [
        row({ itemId: 'recently-touched', createdAtMs: NOW - 1 * DAY, lastWriteAtMs: NOW - 1 * DAY }),
        row({ itemId: 'major', severity: 'major' }),
      ],
      escalate: async () => {
        throw new Error('must not escalate a row below threshold');
      },
      now: () => NOW,
    });
    expect(res).toMatchObject({ scanned: 2, escalated: 0, failed: 0, skipped: false });
  });
});

describe('default escalation guidance', () => {
  it('does not invent source provenance for an observation-lane item', async () => {
    openEscalationMock.mockClear();
    await runUnservableCriticalSweepOnce({} as Sql, {
      readRows: async () => [row({ itemId: 'EI-observation', floor: 'observation-lane' })],
      readOpenConditionKeys: async () => [],
      flagEnabled: async () => true,
      now: () => NOW,
    });

    expect(openEscalationMock).toHaveBeenCalledTimes(1);
    const body = openEscalationMock.mock.calls[0][1].body;
    expect(body).toContain('inspect its provenance and current status');
    expect(body).toContain('canonical harness owner/claim spec');
    expect(body).not.toContain('improvements:capture');
  });

  it('routes live-gate-ops items through ownership before by-id claim and rejects observe as self-select proof', async () => {
    broadcastSevereEventMock.mockClear();
    openEscalationMock.mockClear();
    await runUnservableCriticalSweepOnce({} as Sql, {
      readRows: async () => [row({ itemId: 'WI-gate', floor: 'live-gate-ops' })],
      readOpenConditionKeys: async () => [],
      flagEnabled: async () => true,
      now: () => NOW,
    });

    const body = broadcastSevereEventMock.mock.calls[0]?.[0]?.body ?? '';
    expect(body).toContain("state:read { cell: 'gate.greenCheckpoint.ownership' }");
    expect(body).toContain('If held by another live agent');
    expect(body).toContain("work_items:claim { id: 'WI-gate', harness: 'papercusp' }");
    expect(body).toContain('alarm:unservable-critical:');
    expect(body).toContain('work_items:observe available:true does not establish live-gate-ops self-select eligibility');
    expect(body).not.toContain('work_items:observe { ids:');
    expect(openEscalationMock.mock.calls[0]?.[1]?.body).toContain(
      'work_items:observe available:true does not establish live-gate-ops self-select eligibility',
    );
  });
});

describe('original unservable-critical condition lifecycle', () => {
  function fixture() {
    const item = row({ itemId: 'WI-exact' });
    const open = new Set<string>();
    const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
      open.add(event.conditionKey!); return true;
    });
    const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
    const data = { candidates: [item], measured: [item] };
    const readRows = vi.fn(async (opts?: { recoveryFor?: unknown[] }) =>
      opts?.recoveryFor ? data.measured : data.candidates);
    const deps: Partial<UnservableSweepDeps> = {
      readRows, now: () => NOW, flagEnabled: async () => true, escalate: vi.fn(async () => {}),
      readOpenConditionKeys: async () => [...open], rail: { broadcast, resolve },
    };
    return { item, open, data, deps, broadcast, resolve, readRows };
  }

  it('opens before the legacy escalation and persists through a new sweep with no candidate', async () => {
    const f = fixture();
    f.deps.escalate = async () => { expect(f.open.size).toBe(1); };
    await runUnservableCriticalSweepOnce({} as Sql, f.deps);
    expect(f.broadcast.mock.calls[0][0]).toMatchObject({ oneShot: true });
    f.data.candidates = []; f.data.measured = [];
    await runUnservableCriticalSweepOnce({} as Sql, { ...f.deps });
    expect(f.open.size).toBe(1); expect(f.resolve).not.toHaveBeenCalled();
    expect(f.readRows).toHaveBeenLastCalledWith({ recoveryFor: [{
      workspaceId: f.item.workspaceId, harnessSlug: f.item.harnessSlug, itemId: f.item.itemId,
    }] });
  });

  it.each(['touch', 'no-longer-stranded'] as const)('resolves only positive exact-row recovery: %s', async kind => {
    const f = fixture();
    await runUnservableCriticalSweepOnce({} as Sql, f.deps);
    f.data.candidates = [];
    f.data.measured = [kind === 'touch' ? { ...f.item, lastWriteAtMs: NOW - DAY }
      : { ...f.item, recovered: true }];
    await runUnservableCriticalSweepOnce({} as Sql, { ...f.deps });
    expect(f.open.size).toBe(0); expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.resolve.mock.calls[0][0].conditionKey).toBe(f.broadcast.mock.calls[0][0].conditionKey);
  });

  it('keeps workspace, harness and item identities independent', async () => {
    const f = fixture();
    f.data.candidates.push({ ...f.item, workspaceId: 'other-workspace' },
      { ...f.item, harnessSlug: 'other-harness' }, { ...f.item, itemId: 'other-item' });
    f.data.measured = [...f.data.candidates];
    await runUnservableCriticalSweepOnce({} as Sql, f.deps); expect(f.open.size).toBe(4);
    f.data.candidates = [];
    f.data.measured = [{ ...f.item, lastWriteAtMs: NOW - DAY }];
    await runUnservableCriticalSweepOnce({} as Sql, f.deps);
    expect(f.open.size).toBe(3); expect(f.resolve).toHaveBeenCalledTimes(1);
  });

  it('preserves absent, foreign and malformed measurements and flag-OFF episodes', async () => {
    const f = fixture();
    await runUnservableCriticalSweepOnce({} as Sql, f.deps);
    f.data.candidates = []; f.data.measured = [{ ...f.item, lastWriteAtMs: NaN },
      { ...f.item, itemId: 'foreign', recovered: true }];
    await runUnservableCriticalSweepOnce({} as Sql, f.deps); expect(f.open.size).toBe(1);
    await runUnservableCriticalSweepOnce({} as Sql, { ...f.deps, flagEnabled: async () => false });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(scanUnservableCritical([{ ...f.item, lastWriteAtMs: NaN }], NOW)).toEqual([]);
  });

  it('preserves a live episode when the recovery read fails', async () => {
    const f = fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runUnservableCriticalSweepOnce({} as Sql, f.deps);
      f.deps.readRows = async opts => { if (opts?.recoveryFor) throw new Error('read unavailable'); return []; };
      await runUnservableCriticalSweepOnce({} as Sql, f.deps);
      expect(f.open.size).toBe(1); expect(f.resolve).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovery read failed'));
    } finally { warn.mockRestore(); }
  });

  it('attempts each delivery leg even if the other one fails', async () => {
    const f = fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.deps.escalate = async () => { throw new Error('legacy failed'); };
      expect((await runUnservableCriticalSweepOnce({} as Sql, f.deps)).failed).toBe(1);
      expect(f.open.size).toBe(1);
      const legacy = vi.fn(async () => {});
      f.deps.escalate = legacy;
      f.deps.rail!.broadcast = async () => { throw new Error('condition failed'); };
      await runUnservableCriticalSweepOnce({} as Sql, f.deps);
      expect(legacy).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });

  it('the default reader binds exact identities as a JSON array and treats an omitted oracle verdict as unknown', async () => {
    const f = fixture(); await runUnservableCriticalSweepOnce({} as Sql, f.deps);
    const dbRow = { issue_id: f.item.itemId, workspace_id: f.item.workspaceId,
      harness_slug: f.item.harnessSlug, title: f.item.title, severity: 'critical', state: 'open',
      created_ms: String(f.item.createdAtMs), last_write_ms: String(f.item.lastWriteAtMs) };
    const query = vi.fn(async () => [dbRow]);
    const json = vi.fn(value => value);
    const sql = Object.assign(query, { json }) as unknown as Sql;
    oracle.mockResolvedValue([]);
    delete f.deps.readRows;
    await runUnservableCriticalSweepOnce(sql, f.deps);
    expect(f.open.size).toBe(1); expect(f.resolve).not.toHaveBeenCalled();
    expect(json).toHaveBeenLastCalledWith([{ workspaceId: f.item.workspaceId,
      harnessSlug: f.item.harnessSlug, itemId: f.item.itemId }]);
    oracle.mockResolvedValue([{ id: f.item.itemId, refusedBy: null }]);
    await runUnservableCriticalSweepOnce(sql, f.deps);
    expect(f.open.size).toBe(0);
  });

  it.each([{ state: 'done', severity: 'critical' }, { state: 'open', severity: 'minor' }])(
    'the default reader recognizes explicit recovery without a working claim oracle: %j', async current => {
      const f = fixture(); await runUnservableCriticalSweepOnce({} as Sql, f.deps);
      const query = vi.fn(async () => [{ issue_id: f.item.itemId, workspace_id: f.item.workspaceId,
        harness_slug: f.item.harnessSlug, title: f.item.title, ...current,
        created_ms: String(f.item.createdAtMs), last_write_ms: String(f.item.lastWriteAtMs) }]);
      const sql = Object.assign(query, { json: (value: unknown) => value }) as unknown as Sql;
      oracle.mockRejectedValue(new Error('oracle unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        delete f.deps.readRows;
        await runUnservableCriticalSweepOnce(sql, f.deps);
        expect(f.open.size).toBe(0);
      } finally { warn.mockRestore(); }
    });
});
