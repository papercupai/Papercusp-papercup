import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  decideAutoClose,
  processAutoClose,
  AUTO_CLOSE_ELIGIBLE_SOURCES,
  type AutoCloseCandidate,
  type AutoCloseTickContext,
  type AutoCloseDeps,
} from './auto-close';
import type { EngineerIssue } from '../../issues-engineer';
import type { RedTestRun } from './red-test-green-resolve';
import type { ToolFailureRepairEvidence } from './tool-error-positive-resolve';

// P-009 (watchdog-and-exposed-systems-improvement-2026-06-18): the auto-close sweep
// retires a watchdog-sourced EI once its signal stops firing. Auto-closing real items
// is dangerous, so every guard in the pure decision is pinned here, plus the
// DEFAULT-OFF flag gate (inert until the owner enables it).

const NOW = 1_700_000_000_000;
const THREE_H_AGO = NOW - 3 * 60 * 60 * 1000;

// NOTE: the base fixture is a `smoke-fail` key, NOT `red-test`. red-test was REMOVED from
// AUTO_CLOSE_ELIGIBLE_SOURCES (P-003) — it is absence-INELIGIBLE now, so it can no longer
// stand in as the generic "eligible source" example these guard tests need.
const baseCandidate: AutoCloseCandidate = {
  issueId: 'EI-1',
  watchdogKey: 'smoke-fail:papercusp',
  state: 'open',
  assignee: null,
  createdAtMs: THREE_H_AGO,
  signalOrigin: 'organic',
  inFlightDispatch: false,
};
const baseCtx: AutoCloseTickContext = { seenKeys: new Set<string>(), ranTickCount: 6, nowMs: NOW };

describe('decideAutoClose — guards (the safety-critical decision)', () => {
  it('CLOSES the happy path: open, organic, unassigned, eligible source, old enough, absent, enough history', () => {
    const d = decideAutoClose(baseCandidate, baseCtx);
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/evidence cleared/);
  });

  it('EI-7317: CLOSES an abandoned assignment (assignee set, no live in-flight dispatch) — the EI-3901 pattern', () => {
    // The dispatch resolved (or the routine it was chasing was deactivated) but the
    // issue's `assignee` column was never cleared. Before the fix this stayed open+
    // assigned forever and kept getting re-dispatched even though the signal itself had
    // verifiably cleared. A bare assignee must not block retirement — only a LIVE
    // in-flight dispatch does.
    const d = decideAutoClose({ ...baseCandidate, assignee: 'su-abandoned' }, baseCtx);
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/evidence cleared/);
    expect(d.reason).toMatch(/abandoned assignment/);
  });

  it('refuses each guard with a distinct reason', () => {
    expect(decideAutoClose({ ...baseCandidate, state: 'resolved' }, baseCtx)).toMatchObject({ close: false, reason: 'not-open' });
    expect(decideAutoClose({ ...baseCandidate, watchdogKey: '' }, baseCtx)).toMatchObject({ close: false, reason: 'no-watchdog-key' });
    expect(decideAutoClose({ ...baseCandidate, signalOrigin: 'drill' }, baseCtx)).toMatchObject({ close: false, reason: 'non-organic' });
    // WI-40769: service-down IS eligible now (see the allowlist comment), so the
    // ineligible-source guard needs a genuinely unlisted source to demonstrate itself.
    expect(decideAutoClose({ ...baseCandidate, watchdogKey: 'orphaned-dispatch:x' }, baseCtx)).toMatchObject({ close: false, reason: 'ineligible-source' });
    expect(decideAutoClose({ ...baseCandidate, inFlightDispatch: true }, baseCtx)).toMatchObject({ close: false, reason: 'in-flight-dispatch' });
    // EI-7317: an assignee WITH a live in-flight dispatch still blocks (real active work) —
    // 'in-flight-dispatch' wins regardless of assignee, since that's the actual "someone is
    // on it" signal now.
    expect(decideAutoClose({ ...baseCandidate, assignee: 'su-abc', inFlightDispatch: true }, baseCtx)).toMatchObject({ close: false, reason: 'in-flight-dispatch' });
    expect(decideAutoClose(baseCandidate, { ...baseCtx, ranTickCount: 5 })).toMatchObject({ close: false, reason: 'insufficient-tick-history' });
    expect(decideAutoClose({ ...baseCandidate, createdAtMs: NOW - 10 * 60_000 }, baseCtx)).toMatchObject({ close: false, reason: 'too-new' });
    expect(decideAutoClose(baseCandidate, { ...baseCtx, seenKeys: new Set([baseCandidate.watchdogKey]) })).toMatchObject({ close: false, reason: 'still-firing' });
  });

  it('honors a custom minAbsentTicks / minIssueAgeMs', () => {
    // With minAbsentTicks 10, a 6-tick window is insufficient.
    expect(decideAutoClose(baseCandidate, baseCtx, { minAbsentTicks: 10 })).toMatchObject({ close: false, reason: 'insufficient-tick-history' });
    // With a 5h min age, a 3h-old item is too new.
    expect(decideAutoClose(baseCandidate, baseCtx, { minIssueAgeMs: 5 * 60 * 60 * 1000 })).toMatchObject({ close: false, reason: 'too-new' });
  });

  it('accepts every eligible source and rejects an unlisted one', () => {
    for (const src of ['stalled-feature', 'unresolved-escalation', 'failed-spawn', 'smoke-fail', 'escalation-spike', 'fire-circuit-open', 'governor-starvation', 'orphaned-spawn', 'stuck-plan', 'ship-link-stuck', 'stalled-claim', 'loop-stalled', 'migration-drift', 'perf-regression', 'routine-failure', 'service-down']) {
      expect(decideAutoClose({ ...baseCandidate, watchdogKey: `${src}:k` }, baseCtx).close).toBe(true);
    }
    for (const src of ['orphaned-dispatch', 'insight-staleness']) {
      expect(decideAutoClose({ ...baseCandidate, watchdogKey: `${src}:k` }, baseCtx).close).toBe(false);
    }
  });

  // ── WI-40769: the blind-tick guard ────────────────────────────────────────
  //
  // The defect this closes: `service-down` could be RAISED but never LOWERED, so a
  // self-clearing outage became permanent claimable backlog (measured 2026-08-23 —
  // `service-down:operator` open 12 days asserting nothing was listening while the
  // operator answered 200 in 86ms). Admitting it to the allowlist is only SAFE
  // because a tick where the collector observed nothing no longer counts as
  // evidence that the condition cleared.
  //
  // These two tests are a PAIR and must stay one: the first proves the new guard
  // blocks, the second proves it does not block everything (a guard that always
  // refuses would also "pass" the first test while silently disabling auto-close).
  describe('blind ticks are not absence evidence', () => {
    const svc: AutoCloseCandidate = { ...baseCandidate, watchdogKey: 'service-down:operator' };

    it('refuses to close when the source\'s collector went blind during the window', () => {
      // 6 ran-ticks, but the service-down collector skipped/threw on 1 of them, so
      // only 5 ticks actually LOOKED at the service — one short of the 6 required.
      // Reading this as "absent for 6 ticks" is the monitor-outage-looks-like-recovery
      // misread; it would auto-resolve a genuine, still-broken outage row.
      const d = decideAutoClose(svc, {
        ...baseCtx,
        unobservedTicksBySource: new Map([['service-down', 1]]),
      });
      expect(d).toMatchObject({ close: false, reason: 'insufficient-observed-tick-history' });
    });

    it('still closes when the blind ticks belong to a DIFFERENT source', () => {
      // Absence evidence is discounted PER SOURCE. A blind migration-drift tick says
      // nothing about whether service-down was evaluated, so it must not defer an
      // otherwise-good service-down close — otherwise one flaky collector would
      // freeze auto-close for every source at once.
      const d = decideAutoClose(svc, {
        ...baseCtx,
        unobservedTicksBySource: new Map([['migration-drift', 3]]),
      });
      expect(d.close).toBe(true);
    });

    it('treats a pre-WI-40769 tick record (no unobserved data) as fully observed', () => {
      // Back-compat: rows written before this change carry no `observed` field, and
      // the field is optional on the context. Absent ⇒ every tick observed, which is
      // exactly the pre-change behaviour — so deploying this cannot retroactively
      // freeze auto-close on the existing tick history.
      expect(decideAutoClose(svc, baseCtx).close).toBe(true);
      expect(decideAutoClose(svc, { ...baseCtx, unobservedTicksBySource: new Map() }).close).toBe(true);
    });
  });

  it('EI-21095659198152574: NEVER absence-closes repeated-tool-error without positive verification', () => {
    // A quiet error-observation window only means that the rejected call was not
    // observed. It cannot prove a deployed schema/handler changed: traffic may have
    // stopped after the rejection, as happened for the requiredAncestorSha gap.
    const d = decideAutoClose(
      { ...baseCandidate, watchdogKey: 'repeated-tool-error:release:checkpoint-run:requiredAncestorSha' },
      baseCtx,
    );
    expect(d).toMatchObject({ close: false, reason: 'ineligible-source' });
    expect(AUTO_CLOSE_ELIGIBLE_SOURCES.has('repeated-tool-error')).toBe(false);
  });

  it('P-003: NEVER absence-closes a red-test signal — a quiet tick means "nobody ran it", not "it passes"', () => {
    // The regression this pins (EI-11141, template-supply-chain-repair-2026-08-10 P-003):
    // templates/papercusp-desktop-app/checks/composition-integrity.test.ts last RAN
    // 2026-07-27 and was flipped `resolved` on 2026-08-02 — with ZERO 'pass' rows in all
    // of test_runs history. Its import (@papercusp/template-kit) was still unresolvable at
    // the close and stayed broken 8 more days. The runs stopped because NO vitest config
    // owns templates/**/checks/*.test.ts, not because anything got fixed.
    //
    // red-test is unique among the collectors: its input is a LOG OF EXTERNALLY-TRIGGERED
    // RUNS, not a live re-derivation of the condition, so it cannot tell a fixed test from
    // an unrun one. Its true-recovery case is served by the POSITIVE-evidence path
    // (resolveProvenGreenRedTests) instead, which demands N recorded greens.
    const d = decideAutoClose(
      { ...baseCandidate, watchdogKey: 'red-test:templates/papercusp-desktop-app/checks/composition-integrity.test.ts' },
      baseCtx,
    );
    expect(d).toMatchObject({ close: false, reason: 'ineligible-source' });
    // ...and it is genuinely gone from the allowlist, not merely failing some other guard.
    expect(AUTO_CLOSE_ELIGIBLE_SOURCES.has('red-test')).toBe(false);
  });

  it('EI-18143028205990222: CLOSES a perf-regression SLO signal (e.g. dispatch-orphan-rate) once absent', () => {
    // perf-regression-rig.ts's consider() re-derives every metric (loop-lag-p95,
    // conn-saturation, dispatch-orphan-rate, coord-open-escalations, adv-tab-switch-median,
    // adv-fcp) from a live read each tick — none cache/latch a stale verdict — so absence
    // from known-open keys reliably means the metric dropped back under budget. Before this
    // was added, a breach whose root cause was already fixed elsewhere (verified: zero new
    // orphaned dispatches for 4h+ after durable-spawn.ts's EI-18118495431535177 fix) had no
    // path back to closed while the SLO's trailing window still read the old pre-fix rows.
    const d = decideAutoClose({ ...baseCandidate, watchdogKey: 'perf-regression:dispatch-orphan-rate' }, baseCtx);
    expect(d.close).toBe(true);
    expect(d.reason).toMatch(/evidence cleared/);
  });
});

// ── processAutoClose IO (flag gate + orchestration) ──────────────────────────
const FLAG_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_WATCHDOG_AUTO_CLOSE';
afterEach(() => { delete process.env[FLAG_ENV]; });

const mkIssue = (over: Partial<EngineerIssue> & { watchdogKey?: string }): EngineerIssue => {
  const { watchdogKey, ...rest } = over;
  return {
    id: 'EI-x',
    state: 'open',
    assignee: null,
    createdAt: new Date(THREE_H_AGO).toISOString(),
    signalOrigin: 'organic',
    payload: watchdogKey ? { watchdogKey } : {},
    ...rest,
  } as unknown as EngineerIssue;
};

describe('processAutoClose — flag gate + orchestration', () => {
  it('is INERT when the flag is off: never reads deps, closes nothing', async () => {
    // WATCHDOG_AUTO_CLOSE graduated to default-ON (flip-dark-flags-default-on-2026-06-23); pin it OFF
    // here via the env override rather than relying on the (now-ON) default — the gate is unchanged.
    process.env[FLAG_ENV] = '0';
    let touched = false;
    const deps: AutoCloseDeps = {
      listOpen: async () => { touched = true; return []; },
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async () => { touched = true; },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(out).toEqual([]);
    expect(touched).toBe(false); // gate short-circuits before any read
  });

  it('with the flag ON, closes the eligible candidate AND an abandoned assignment (EI-7317), skipping in-flight / still-firing / too-new / ineligible', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const issues = [
      mkIssue({ id: 'EI-close', watchdogKey: 'smoke-fail:gone' }), // → closes
      mkIssue({ id: 'EI-firing', watchdogKey: 'repeated-tool-error:hot:structural' }), // still firing
      // EI-7317: assigned but the dispatch already resolved (not in inFlightDispatchIds
      // below) — an abandoned assignment, not active work → closes too.
      mkIssue({ id: 'EI-abandoned-assigned', watchdogKey: 'smoke-fail:owned', assignee: 'su-z' }),
      // Genuinely active work: assigned AND a live in-flight dispatch row → stays blocked.
      mkIssue({ id: 'EI-inflight', watchdogKey: 'stalled-feature:papercup', assignee: 'su-active' }),
      mkIssue({ id: 'EI-new', watchdogKey: 'smoke-fail:fresh', createdAt: new Date(NOW - 5 * 60_000).toISOString() }), // too new
      // WI-40769: service-down is ELIGIBLE now, so the ineligible-source case needs a
      // genuinely unlisted source. `orphaned-dispatch` is not in the allowlist.
      mkIssue({ id: 'EI-ineligible', watchdogKey: 'orphaned-dispatch:x' }), // ineligible source
      // WI-40769: and the admitted source closes through the full path — this is the
      // stale `service-down:operator` row (open 12 days against a live 200/86ms
      // operator) that had no route back to closed before this change.
      mkIssue({ id: 'EI-servicedown', watchdogKey: 'service-down:operator' }),
      // P-003: a red-test key is now absence-INELIGIBLE — it must survive this sweep even
      // though its signal is absent, old enough, unassigned and organic. Only the
      // positive-green path may retire it.
      mkIssue({ id: 'EI-redtest', watchdogKey: 'red-test:never-ran.test.ts' }),
      mkIssue({ id: 'EI-nokey' }), // no watchdogKey → pre-filtered out
    ];
    const deps: AutoCloseDeps = {
      listOpen: async () => issues,
      recentRanTickKeys: async () => ({ seenKeys: new Set(['repeated-tool-error:hot:structural']), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(['EI-inflight']),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(closed.sort()).toEqual(['EI-abandoned-assigned', 'EI-close', 'EI-servicedown'].sort());
    expect(out.map((o) => o.issueId).sort()).toEqual(['EI-abandoned-assigned', 'EI-close', 'EI-servicedown'].sort());
  });

  it('WI-40769: a blind service-down tick window defers the close instead of resolving it', async () => {
    // The same stale row as above, but the collector went blind during the window.
    // This is the failure the whole change guards: a MONITOR outage produces the
    // same six quiet ticks as a genuine recovery, and closing on it would resolve
    // an outage row while the service is still down and nobody is watching.
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const deps: AutoCloseDeps = {
      listOpen: async () => [mkIssue({ id: 'EI-servicedown', watchdogKey: 'service-down:operator' })],
      recentRanTickKeys: async () => ({
        seenKeys: new Set<string>(),
        ranTickCount: 6,
        unobservedTicksBySource: new Map([['service-down', 2]]),
      }),
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(closed).toEqual([]);
    expect(out).toEqual([]);
  });

  it('does nothing when tick history is insufficient (fresh watchdog)', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const deps: AutoCloseDeps = {
      listOpen: async () => [mkIssue({ id: 'EI-close', watchdogKey: 'smoke-fail:gone' })],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 2 }), // < 6
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(out).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('does not close same-key rows across harness, signal-origin, or lane identity components', async () => {
    process.env[FLAG_ENV] = '1';
    const key = 'unresolved-escalation:escalation:shared-watchdog';
    const closed: string[] = [];
    const deps: AutoCloseDeps = {
      listOpen: async () => [
        mkIssue({ id: 'EI-harness-a', scope: 'harness:alpha', watchdogKey: key }),
        mkIssue({ id: 'EI-harness-b', scope: 'harness:beta', watchdogKey: key }),
        mkIssue({ id: 'EI-drill', scope: 'harness:alpha', signalOrigin: 'drill', watchdogKey: key }),
        mkIssue({ id: 'EI-observation', scope: 'harness:alpha', payload: { watchdogKey: key, lane: 'observation' } }),
      ],
      recentRanTickKeys: async () => ({ seenKeys: new Set([key]), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };

    const out = await processAutoClose('ws', {}, deps);
    expect(closed).toEqual([]);
    expect(out).toEqual([]);
  });

  it('when the signal disappears, independently closes same-key rows with distinct identities', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: Array<{ id: string; key: string; reason: string }> = [];
    const key = 'unresolved-escalation:escalation:papercusp:green-checkpoint-watchdog';
    const deps: AutoCloseDeps = {
      listOpen: async () => [
        mkIssue({
          id: 'EI-harness-a',
          scope: 'harness:alpha',
          watchdogKey: key,
        }),
        mkIssue({
          id: 'EI-observation',
          scope: 'harness:alpha',
          watchdogKey: key,
          payload: { watchdogKey: key, lane: 'observation' },
        }),
      ],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async (id, key, reason) => { closed.push({ id, key, reason }); },
      nowMs: () => NOW,
    };

    const out = await processAutoClose('ws', {}, deps);
    expect(closed).toEqual([
      {
        id: 'EI-harness-a',
        key,
        reason: 'signal absent from known-open keys for ≥6 ran-ticks — evidence cleared',
      },
      {
        id: 'EI-observation',
        key,
        reason: 'signal absent from known-open keys for ≥6 ran-ticks — evidence cleared',
      },
    ]);
    expect(out).toEqual(closed.map(({ id: issueId, key: watchdogKey, reason }) => ({ issueId, watchdogKey, reason })));
  });
});

// ── P-007 / WI-4601: POSITIVE green-run resolution (the raise-but-never-lower fix) ──────
// Live premise (dev:pg_query 2026-07-13): 18 of 58 open red-test EIs (31%) had their named
// test currently GREEN. This pass resolves them on PROVEN green (N consecutive passes) with
// the green run as real completion evidence — BEFORE, and independent of, the absence path.
describe('processAutoClose — P-007 green-run resolution', () => {
  const greenRun = (statuses: string): RedTestRun[] =>
    statuses.split(',').map((status, i) => ({ status: status.trim(), startedAtMs: NOW - i * 60_000, commitSha: 'deadbeef00' }));

  interface GreenCapture { resolved: Array<{ id: string; ref: string; verifiedHow?: string }> }
  const greenDeps = (
    runsByPath: Record<string, RedTestRun[]>,
    capture: GreenCapture,
    over: Partial<AutoCloseDeps> = {},
  ): AutoCloseDeps => ({
    listOpen: async () => [],
    recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
    inFlightDispatchIds: async () => new Set(),
    close: async () => {},
    nowMs: () => NOW,
    recentRedTestRuns: async (paths) => {
      const m = new Map<string, RedTestRun[]>();
      for (const p of paths) if (runsByPath[p]) m.set(p, runsByPath[p]);
      return m;
    },
    resolveGreen: async (id, _wk, ref, evidence) => {
      capture.resolved.push({ id, ref, verifiedHow: evidence.verifiedHow });
    },
    ...over,
  });

  it('resolves a PROVEN-GREEN red-test EI with real evidence, and does NOT also absence-close it', async () => {
    process.env[FLAG_ENV] = '1';
    const cap: GreenCapture = { resolved: [] };
    const closed: string[] = [];
    const deps = greenDeps({ 'packages/x/foo.test.ts': greenRun('pass,pass,pass,pass') }, cap, {
      listOpen: async () => [mkIssue({ id: 'EI-green', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      // Signal ABSENT from known-open (the absence path WOULD close it) — green evidence wins first.
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      close: async (id) => { closed.push(id); },
    });
    const out = await processAutoClose('ws', {}, deps);
    expect(cap.resolved).toEqual([
      { id: 'EI-green', ref: expect.stringContaining('POSITIVE green-run evidence'), verifiedHow: 'already-passing' },
    ]);
    expect(closed).toEqual([]); // NOT double-closed by the absence path
    expect(out.map((o) => o.issueId)).toEqual(['EI-green']);
  });

  it('runs INDEPENDENTLY of tick history — resolves a proven-green EI even with too few ran-ticks', async () => {
    process.env[FLAG_ENV] = '1';
    const cap: GreenCapture = { resolved: [] };
    const deps = greenDeps({ 'packages/x/foo.test.ts': greenRun('pass,pass,pass') }, cap, {
      listOpen: async () => [mkIssue({ id: 'EI-green', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 1 }), // absence path cannot run
    });
    const out = await processAutoClose('ws', {}, deps);
    expect(cap.resolved.map((r) => r.id)).toEqual(['EI-green']);
    expect(out.map((o) => o.issueId)).toEqual(['EI-green']);
  });

  it('does NOT green-resolve a red-test EI whose latest run is red (regressed test stays open)', async () => {
    process.env[FLAG_ENV] = '1';
    const cap: GreenCapture = { resolved: [] };
    const deps = greenDeps({ 'packages/x/foo.test.ts': greenRun('fail,pass,pass,pass') }, cap, {
      listOpen: async () => [mkIssue({ id: 'EI-red', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      // still firing → also not absence-closed; the item correctly stays open
      recentRanTickKeys: async () => ({ seenKeys: new Set(['red-test:packages/x/foo.test.ts']), ranTickCount: 6 }),
    });
    const out = await processAutoClose('ws', {}, deps);
    expect(cap.resolved).toEqual([]);
    expect(out).toEqual([]);
  });

  it('does NOT green-resolve a red-test EI with a live in-flight dispatch (active work)', async () => {
    process.env[FLAG_ENV] = '1';
    const cap: GreenCapture = { resolved: [] };
    const deps = greenDeps({ 'packages/x/foo.test.ts': greenRun('pass,pass,pass,pass') }, cap, {
      listOpen: async () => [mkIssue({ id: 'EI-green', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      inFlightDispatchIds: async () => new Set(['EI-green']),
    });
    await processAutoClose('ws', {}, deps);
    expect(cap.resolved).toEqual([]);
  });

  it('is fail-soft: a test_runs read error resolves nothing, closes nothing, and never aborts the sweep', async () => {
    process.env[FLAG_ENV] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the read error is EXPECTED
    const cap: GreenCapture = { resolved: [] };
    const closed: string[] = [];
    const deps = greenDeps({}, cap, {
      listOpen: async () => [mkIssue({ id: 'EI-green', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      recentRedTestRuns: async () => { throw new Error('pg down'); },
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      close: async (id) => { closed.push(id); },
    });
    const out = await processAutoClose('ws', {}, deps);
    expect(cap.resolved).toEqual([]);
    // P-003: this test used to assert `closed === ['EI-green']` with the comment "fell
    // through to absence close". That fallback was the bug, not the fail-soft behaviour:
    // losing the ability to READ green evidence is not evidence of green. Failing soft
    // means "resolve nothing and keep sweeping", NOT "close it on the weaker signal" —
    // that is failing OPEN. A red-test EI now survives a green-read outage untouched.
    expect(closed).toEqual([]);
    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[watchdog-green-resolve]'), expect.stringContaining('pg down'));
    warn.mockRestore();
  });

  it('P-003: with the green deps NOT injected, a red-test EI is left alone (never absence-closed)', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    // No recentRedTestRuns / resolveGreen → the green pass is a no-op. Previously the
    // absence path then closed the item anyway; now there is NO path that retires a
    // red-test EI without positive green evidence, so a caller that cannot supply that
    // evidence simply leaves it open.
    const deps: AutoCloseDeps = {
      listOpen: async () => [mkIssue({ id: 'EI-green', watchdogKey: 'red-test:packages/x/foo.test.ts' })],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
    };
    const out = await processAutoClose('ws', {}, deps);
    expect(closed).toEqual([]);
    expect(out).toEqual([]);
  });
});

describe('processAutoClose — positive repeated-tool-error repair', () => {
  const toolFailureWatchdogKey = 'repeated-tool-error:release:checkpoint-run:requiredAncestorSha';
  const toolFailureClassKey = 'repeated-tool-error-class:release:checkpoint-run:caller:schema-42~field-requiredAncestorSha:runtime-7';
  const toolFailureContractFingerprint = 'schema-42~field-requiredAncestorSha';
  const toolFailureRevision = 'runtime-7';

  const toolFailureIssue = (id: string, repairEvidence?: ToolFailureRepairEvidence): EngineerIssue =>
    mkIssue({
      id,
      watchdogKey: toolFailureWatchdogKey,
      payload: {
        watchdogKey: toolFailureWatchdogKey,
        toolFailureProbation: {
          classKey: toolFailureClassKey,
          contractFingerprint: toolFailureContractFingerprint,
          deployedRevision: toolFailureRevision,
          ...(repairEvidence ? { repairEvidence } : {}),
        },
      },
    });

  it('resolves an exact class on positive contract-change evidence without requiring tick history', async () => {
    process.env[FLAG_ENV] = '1';
    const repairEvidence: ToolFailureRepairEvidence = {
      classKey: toolFailureClassKey,
      kind: 'contract-change',
      contractFingerprint: toolFailureContractFingerprint,
      fromRevision: toolFailureRevision,
      toRevision: 'runtime-8',
      changeRef: 'commit:abc1234 / deployed:runtime-8',
    };
    const resolved: Array<{ id: string; key: string; ref: string }> = [];
    const closed: string[] = [];
    let readEvidence = false;
    let readTicks = false;
    const deps: AutoCloseDeps = {
      listOpen: async () => [toolFailureIssue('EI-tool-repaired')],
      recentRanTickKeys: async () => {
        readTicks = true;
        return { seenKeys: new Set(), ranTickCount: 0 };
      },
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
      readToolFailureRepairEvidence: async () => {
        readEvidence = true;
        return new Map([['EI-tool-repaired', repairEvidence]]);
      },
      resolveToolFailureRepair: async (id, key, ref) => { resolved.push({ id, key, ref }); },
    };

    const out = await processAutoClose('ws', {}, deps);

    expect(readEvidence).toBe(true);
    expect(readTicks).toBe(true); // the positive path is independent; the normal sweep still runs
    expect(resolved).toEqual([{
      id: 'EI-tool-repaired',
      key: toolFailureWatchdogKey,
      ref: expect.stringContaining('commit:abc1234'),
    }]);
    expect(closed).toEqual([]);
    expect(out).toMatchObject([{ issueId: 'EI-tool-repaired', watchdogKey: toolFailureWatchdogKey }]);
  });

  it('does not resolve a mismatched class and cannot fall through to absence close', async () => {
    process.env[FLAG_ENV] = '1';
    const closed: string[] = [];
    const resolved: string[] = [];
    const repairEvidence: ToolFailureRepairEvidence = {
      classKey: 'repeated-tool-error-class:other-tool',
      kind: 'positive-probe',
      contractFingerprint: toolFailureContractFingerprint,
      deployedRevision: toolFailureRevision,
      probeRef: 'probe:other-tool',
      passed: true,
    };
    const deps: AutoCloseDeps = {
      listOpen: async () => [toolFailureIssue('EI-tool-mismatch')],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async (id) => { closed.push(id); },
      nowMs: () => NOW,
      readToolFailureRepairEvidence: async () => new Map([['EI-tool-mismatch', repairEvidence]]),
      resolveToolFailureRepair: async (id) => { resolved.push(id); },
    };

    const out = await processAutoClose('ws', {}, deps);

    expect(resolved).toEqual([]);
    expect(closed).toEqual([]);
    expect(out).toEqual([]);
  });

  it('fails open when the durable repair-evidence reader fails', async () => {
    process.env[FLAG_ENV] = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps: AutoCloseDeps = {
      listOpen: async () => [toolFailureIssue('EI-tool-read-failed')],
      recentRanTickKeys: async () => ({ seenKeys: new Set(), ranTickCount: 6 }),
      inFlightDispatchIds: async () => new Set(),
      close: async () => {},
      nowMs: () => NOW,
      readToolFailureRepairEvidence: async () => { throw new Error('repair evidence unavailable'); },
      resolveToolFailureRepair: async () => {},
    };

    const out = await processAutoClose('ws', {}, deps);

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[watchdog-tool-error-resolve]'),
      expect.stringContaining('repair evidence unavailable'),
    );
    warn.mockRestore();
  });
});
