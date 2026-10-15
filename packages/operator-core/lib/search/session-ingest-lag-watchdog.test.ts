/**
 * Ingest-lag watchdog (session-turn-storage-2026-07-28 P-007, D-005).
 *
 * The recurrence guard for the class this watchdog exists to catch AND for the
 * false alarm it exists to avoid. On 2026-07-28 codex read 2 d 9 h "behind"
 * and omp 6 d 8 h while BOTH were fully caught up and simply unused — so the
 * first test below is the one that matters most: a quiet adapter must stay
 * silent no matter how large its wall-clock lag. A watchdog that pages for
 * that is worse than none, because the next real wedge arrives into an alert
 * everyone has learned to ignore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateIngestLag,
  sessionIngestLagSweep,
  remainderIsConsumableWork,
  INGEST_LAG_MIN_BACKLOG_BYTES,
  type AdapterLagObservation,
  type IngestLagSweepDeps,
} from './session-ingest-lag-watchdog';
import {
  INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
  evaluateInteractiveUsageFreshness,
} from '../interactive-usage/freshness';

const HOUR = 3_600_000;
const obs = (over: Partial<AdapterLagObservation> = {}): AdapterLagObservation => ({
  sourceKind: 'codex',
  behindFiles: 0,
  backlogBytes: 0,
  oldestBacklogAgeMs: 0,
  worstPath: null,
  ...over,
});

describe('remainderIsConsumableWork — the PER-FILE admission test (EI-19280389878453845)', () => {
  // The regression: this floor was only ever tested against the per-ADAPTER
  // SUM. Its premise is per-file ("a live session ALWAYS has a few hundred
  // unconsumed bytes"), so summing enough sub-floor tails always crosses it.
  // Measured with claude ingest demonstrably healthy: 20 files behind /
  // 537 KB summed, only 2 individually at the floor → reported WEDGED.
  it('rejects an ordinary partially-written tail', () => {
    expect(remainderIsConsumableWork(1_024, true)).toBe(false);
    expect(remainderIsConsumableWork(INGEST_LAG_MIN_BACKLOG_BYTES - 1, true)).toBe(false);
  });

  it('rejects a remainder with no complete line, however large', () => {
    // readNewLines stops at the last newline BY DESIGN, so a remainder with no
    // newline can never be consumed — and because the state row then stops
    // advancing, its age grows without bound and crosses any threshold. This
    // is the second half of the false alarm.
    expect(remainderIsConsumableWork(INGEST_LAG_MIN_BACKLOG_BYTES * 4, false)).toBe(false);
  });

  it('admits a real backlog — over the floor AND holding a complete line', () => {
    expect(remainderIsConsumableWork(INGEST_LAG_MIN_BACKLOG_BYTES, true)).toBe(true);
    expect(remainderIsConsumableWork(5 * 1024 * 1024, true)).toBe(true);
  });

  it('N sub-floor tails can no longer sum their way into an alert', () => {
    // The precise shape of the incident: 20 files, none individually real.
    const files = Array.from({ length: 20 }, () => 27 * 1024); // ~537 KB summed
    const admitted = files.filter((b) => remainderIsConsumableWork(b, true));
    expect(admitted).toHaveLength(0);
    expect(files.reduce((a, b) => a + b, 0)).toBeGreaterThan(INGEST_LAG_MIN_BACKLOG_BYTES);
  });
});

describe('evaluateIngestLag', () => {
  it('reports WHAT it ignored, so a healthy verdict is auditable', () => {
    const v = evaluateIngestLag(
      obs({ sourceKind: 'claude', ignoredTailFiles: 18, ignoredIncompleteFiles: 2 }),
      HOUR,
    );
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('18 sub-floor tail(s)');
    expect(v.reason).toContain('2 file(s) whose remainder holds no complete line');
  });

  it('omits the ignored-files clause entirely when there is nothing to report', () => {
    expect(evaluateIngestLag(obs({ sourceKind: 'omp' }), HOUR).reason).not.toContain('Ignored');
  });

  it('stays SILENT for a quiet adapter, however stale its clock lag', () => {
    // The 2026-07-28 case: no unconsumed bytes anywhere. The verdict must not
    // consult wall-clock lag at all — there is no input for it to consult.
    const v = evaluateIngestLag(obs({ sourceKind: 'omp' }), HOUR);
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('fully caught up');
  });

  it('ignores a sub-floor backlog (a live session mid-line)', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 3, backlogBytes: INGEST_LAG_MIN_BACKLOG_BYTES - 1, oldestBacklogAgeMs: 5 * HOUR }),
      HOUR,
    );
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('floor');
  });

  it('ignores a real backlog that is still inside the threshold window', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 2, backlogBytes: 50 * 1024 * 1024, oldestBacklogAgeMs: HOUR / 2 }),
      HOUR,
    );
    expect(v.wedged).toBe(false);
    expect(v.reason).toContain('inside the threshold');
  });

  it('ALERTS when real unconsumed bytes have sat past the threshold', () => {
    const v = evaluateIngestLag(
      obs({ behindFiles: 4, backlogBytes: 12 * 1024 * 1024, oldestBacklogAgeMs: 3 * HOUR, worstPath: '/t/a.jsonl' }),
      HOUR,
    );
    expect(v.wedged).toBe(true);
    expect(v.reason).toContain('WEDGED');
    expect(v.reason).toContain('/t/a.jsonl');
    // The alert must say WHY it is trustworthy, so a responder does not
    // dismiss it as the usual lag noise.
    expect(v.reason).toContain('NOT a quiet client');
  });

  it('honours the kill switch', () => {
    const v = evaluateIngestLag(obs({ behindFiles: 9, backlogBytes: 1e9, oldestBacklogAgeMs: 99 * HOUR }), 0);
    expect(v.wedged).toBe(false);
  });
});

describe('sessionIngestLagSweep', () => {
  // The sweep logs its alerts to the operator journal deliberately (that log
  // line is how a wedge is diagnosed after the fact); silence it here so the
  // repo's fail-on-console guard sees an expected, asserted warning.
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  const deps = (observations: AdapterLagObservation[], fires = 0) => ({
    rail: { broadcast: vi.fn(async () => true), resolve: vi.fn(async () => true) },
    readOpenConditionKeys: async () => [],
    observe: async () => observations,
    observeInteractiveUsageFreshness: async (_workspaceId: string, nowMs?: number) =>
      evaluateInteractiveUsageFreshness(nowMs ?? Date.now(), nowMs ?? Date.now()),
    recentWatchdogFires: vi.fn<NonNullable<IngestLagSweepDeps['recentWatchdogFires']>>(async () => fires),
    recordFire: vi.fn<NonNullable<IngestLagSweepDeps['recordFire']>>(async () => undefined as never),
    openEscalation: vi.fn<NonNullable<IngestLagSweepDeps['openEscalation']>>(async () => undefined as never),
  });

  it('records a fire and opens ONE escalation for a wedged adapter', async () => {
    const d = deps([obs({ behindFiles: 2, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR, worstPath: '/rollout' })]);
    const res = await sessionIngestLagSweep({}, d);
    expect(res).toEqual([
      expect.objectContaining({ sourceKind: 'codex', outcome: 'alerted' }),
      expect.objectContaining({ sourceKind: 'interactive-usage', outcome: 'healthy' }),
    ]);
    expect(d.recordFire).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
  });

  it('debounces a repeat fire inside the window', async () => {
    const d = deps([obs({ behindFiles: 2, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR, worstPath: '/rollout' })], 1);
    const res = await sessionIngestLagSweep({}, d);
    expect(res[0].outcome).toBe('debounced');
    expect(d.recordFire).not.toHaveBeenCalled();
  });

  it('debounces PER source_kind, so one wedge cannot mask another', async () => {
    // The EI-16071 trap from the sibling watchdog: a source-only debounce key
    // means the first alerting adapter suppresses every other one for the rest
    // of the window. The scope key is the source_kind, so assert it is passed.
    const d = deps([
      obs({ sourceKind: 'codex', behindFiles: 1, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR, worstPath: '/codex' }),
      obs({ sourceKind: 'omp', behindFiles: 1, backlogBytes: 9e6, oldestBacklogAgeMs: 6 * HOUR, worstPath: '/omp' }),
    ]);
    await sessionIngestLagSweep({}, d);
    const scopes = d.recentWatchdogFires.mock.calls.map((c) => c[4]);
    expect(scopes).toEqual(['codex', 'omp']);
    expect(d.recordFire).toHaveBeenCalledTimes(2);
  });

  it('reports a healthy adapter without touching the fires ledger', async () => {
    const d = deps([obs()]);
    const res = await sessionIngestLagSweep({}, d);
    expect(res[0].outcome).toBe('healthy');
    expect(d.recentWatchdogFires).not.toHaveBeenCalled();
  });

  it('alerts on stale interactive usage freshness without attributing a cause', async () => {
    const d = {
      ...deps([]),
      observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(1_000, 2_000_000),
    };
    const res = await sessionIngestLagSweep({}, d);
    expect(res).toEqual([expect.objectContaining({ sourceKind: 'interactive-usage', outcome: 'alerted' })]);
    expect(d.recordFire).toHaveBeenCalledWith(expect.objectContaining({ source: 'interactive-usage-freshness' }));
    expect(d.openEscalation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      body: expect.stringContaining('does not establish why samples were not written'),
    }));
  });

  it('reports unavailable interactive freshness without alerting as a proven stall', async () => {
    const d = {
      ...deps([]),
      observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(null),
    };
    const res = await sessionIngestLagSweep({}, d);
    expect(res).toEqual([expect.objectContaining({ sourceKind: 'interactive-usage', outcome: 'error' })]);
    expect(d.recordFire).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
  });

  it('alerts when a recent interactive sample has event-to-receipt lag above 15 minutes', async () => {
    const nowMs = Date.now();
    const d = {
      ...deps([]),
      now: nowMs,
      observeInteractiveUsageFreshness: async () => evaluateInteractiveUsageFreshness(
        nowMs - 1_000,
        nowMs,
        undefined,
        INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS + 1,
      ),
    };
    const res = await sessionIngestLagSweep({}, d);
    expect(res).toEqual([expect.objectContaining({ sourceKind: 'interactive-usage', outcome: 'alerted' })]);
    expect(d.recentWatchdogFires).toHaveBeenCalledWith(
      'papercusp-workspace', 'papercusp', 1, 'interactive-usage-freshness', 'interactive',
    );
    expect(d.recordFire).toHaveBeenCalledWith(expect.objectContaining({ source: 'interactive-usage-freshness' }));
    expect(d.openEscalation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      severity: 'advisory', summary: 'Interactive usage ingestion freshness is stale',
    }));
  });

  it('is fail-soft: an observe failure returns an error row, never throws', async () => {
    const res = await sessionIngestLagSweep({}, {
      observe: async () => { throw new Error('pg down'); },
    });
    expect(res).toEqual([{ sourceKind: '*', outcome: 'error', reason: 'pg down' }]);
  });
});
