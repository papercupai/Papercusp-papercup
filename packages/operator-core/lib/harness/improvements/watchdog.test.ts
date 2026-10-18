import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
vi.mock('../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));
import { readFileSync } from 'node:fs'; // EI-20847917368795366: source-pinned WIRING guard
import { signalLaneOf, sourceFilesWorkItem } from './signal-lane';
import { AUTO_CLOSE_ELIGIBLE_SOURCES } from './auto-close-sources'; // WI-40769
import { INFRA_SIGNAL_SOURCES } from './policy'; // WI-918476
import {
  planWatchdogCaptures,
  collectToolErrorSignals,
  collectServiceDownSignals,
  runWatchdogTick,
  isImprovementLoopTool,
  toolErrorSignalsFromRows,
  sharedToolStallSignalsFromRows,
  analyzeSharedToolStallsFromRows,
  softFailureSignalsFromRows,
  softFailureSignalKey,
  classifyToolError,
  isEphemeralBenchmarkHarnessSlug,
  isEphemeralBenchmarkSignal,
  ephemeralSignalSlug,
  isEphemeralSignal,
  rollupWatchdogTicks,
  collectMigrationDriftSignals,
  collectSchemaObjectDriftSignals,
  collectSchemaAheadSignals,
  routineFailureSignalsFromRows,
  loopStalledSignalsFromRows,
  staleProtectiveHoldSignalsFromCandidates,
  stuckPlanSignalsFromRows,
  escalationSignalsFromRows,
  bridgeNeedsOwnerSignalsFromRows,
  BRIDGE_NEEDS_OWNER_CONDITION_PREFIX,
  circuitOpenSignalsFromRows,
  isResolvedFirePath,
  normalizeRedTestPath,
  fetchRedTestRows,
  redTestSignalsFromRows,
  hasSameShaVerdictFlip,
  debounceRedTestSignals,
  isLikelyTransientTransformFailure,
  isServiceHealthStale,
  serviceDownCollectorResult,
  defaultPapercuspCollectors, // WI-40769: the registered-collector source-declaration guard
  DEFAULT_SERVICE_HEALTH_MAX_STALE_MS,
  planSelfEscalations,
  withWatchdogTickLock,
  watchdogTickLockUrl,
  _closeWatchdogTickLockForTests,
  watchdogKeyOf,
  partitionSignalsByKnownKeys,
  computeRefileEligibleKeys,
  WATCHDOG_REFILE_AFTER_MS,
  WATCHDOG_REFILE_HISTORY_LIMIT,
  smokeFailSignalsFromRows,
  expiredLeaseSignalsFromRows,
  failedSpawnSignalsFromRows,
  stalledFeatureSignalsFromRows,
  orphanedSpawnSignalsFromRows,
  stalledClaimSignalsFromRows,
  ceilingJamSignalsFromRows,
  escalationSpikeSignalsFromRows,
  classifySpawnError,
  watchdogOptionsFromPayload,
  type WatchdogKeyDup,
  type WatchdogSignal,
  type GitEditCheck,
  type GitAncestryCheck,
  type WatchdogCollector,
  type WatchdogTickRecord,
  type RecentTick,
  type CollectorStatus,
} from './watchdog';
import type { CaptureImprovementResult } from './capture-core';
import type { ProbeResult } from '../../service-health';
import { _resetServiceHealthState } from '../../service-health';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';
import { stampDrillSignals } from '../../red-queen/drill-classes';

function sig(p: Partial<WatchdogSignal> & { key: string }): WatchdogSignal {
  return {
    source: 'red-test',
    title: `Test failing repeatedly: ${p.key}`,
    body: 'detail',
    severity: 'major',
    ...p,
  };
}

/** No-op P-004 key-dup / P-009 prune deps so unit ticks never touch PG. */
const noKeyDups = async (): Promise<WatchdogKeyDup[]> => [];
const noPrune = async (): Promise<void> => {};

/**
 * HERMETIC tick runner — use this instead of calling `runWatchdogTick` directly.
 *
 * `runWatchdogTick` resolves its lock as `deps?.withTickLock ?? withWatchdogTickLock`,
 * so a tick test that omits `withTickLock` runs the REAL lock, which opens a live
 * admin PG connection (`tickLockSql().reserve()`). With embedded-pg down that throws
 * ECONNREFUSED, the fail-open branch emits a `console.warn`, and `vitest-fail-on-console`
 * turns it into a failure — i.e. the file went red purely because the desktop shell
 * (which owns embedded-pg) was not running. That is environment-dependent, not a real
 * signal (EI-16132).
 *
 * Injecting a pass-through lock keeps the tick body's behavior identical while touching
 * no DB — the same intent as `noKeyDups` / `noPrune` above, applied to the lock leg.
 * `...deps` is spread LAST, so a test that exercises lock behavior passes its own
 * `withTickLock` and still wins. Tests for the REAL lock call `withWatchdogTickLock`
 * directly and spy on `console.warn` (see the fail-open tests).
 */
function runTick(
  workspaceId: string,
  opts: Parameters<typeof runWatchdogTick>[1] = {},
  deps: Parameters<typeof runWatchdogTick>[2] = {},
): ReturnType<typeof runWatchdogTick> {
  return runWatchdogTick(workspaceId, opts, {
    withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
    ...deps,
  });
}

describe('planWatchdogCaptures — pure anti-flood planning (close-loop D-003)', () => {
  it('caps captures per tick, highest severity first', () => {
    const signals = [
      sig({ key: 'a', severity: 'minor' }),
      sig({ key: 'b', severity: 'critical' }),
      sig({ key: 'c', severity: 'major' }),
    ];
    const plan = planWatchdogCaptures(signals, { maxPerTick: 2 });
    expect(plan.toCapture.map((s) => s.key)).toEqual(['b', 'c']);
    expect(plan.deferred.map((s) => s.key)).toEqual(['a']);
  });

  it('dedupes by source+key within a tick', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'a' })], { maxPerTick: 5 });
    expect(plan.toCapture).toHaveLength(1);
  });

  it('same key from DIFFERENT sources are distinct signals', () => {
    const plan = planWatchdogCaptures(
      [sig({ key: 'a', source: 'red-test' }), sig({ key: 'a', source: 'smoke-fail' })],
      { maxPerTick: 5 },
    );
    expect(plan.toCapture).toHaveLength(2);
  });

  it('default cap is 3', () => {
    const plan = planWatchdogCaptures([sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' }), sig({ key: 'd' })]);
    expect(plan.toCapture).toHaveLength(3);
    expect(plan.deferred).toHaveLength(1);
  });

  it('PER-SOURCE cap stops a red-test backlog from starving a tool-error signal (P-009 — the memory:search starvation)', () => {
    // 5 major red-tests + 1 major tool-error signal; global cap 3, per-source cap 2.
    // OLD behaviour (global severity cap): 3 red-tests admitted, tool-error deferred.
    // NEW: red-tests capped at 2, so the tool-error signal gets a slot.
    const signals = [
      sig({ key: 'rt1', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt2', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt3', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt4', source: 'red-test', severity: 'major' }),
      sig({ key: 'rt5', source: 'red-test', severity: 'major' }),
      sig({ key: 'mem', source: 'repeated-tool-error', severity: 'major' }),
    ];
    const plan = planWatchdogCaptures(signals); // default maxPerTick 3, perSourceCap 2
    const keys = plan.toCapture.map((s) => s.key);
    expect(keys).toContain('mem'); // the tool-error signal lands instead of being starved
    expect(keys.filter((k) => k.startsWith('rt'))).toHaveLength(2); // red-tests capped at 2
    expect(plan.toCapture).toHaveLength(3);
  });

  it('fills leftover budget rather than wasting it when ONE source dominates (no competition)', () => {
    const signals = [
      sig({ key: 'rt1', source: 'red-test' }),
      sig({ key: 'rt2', source: 'red-test' }),
      sig({ key: 'rt3', source: 'red-test' }),
    ];
    // No other source competing → use the full cap of 3 even though per-source cap is 2.
    expect(planWatchdogCaptures(signals).toCapture).toHaveLength(3);
  });

  it('deferred-escalation: a recently-deferred minor signal outranks a fresh major one (P-009)', () => {
    const signals = [
      sig({ key: 'fresh', source: 'red-test', severity: 'major' }),
      sig({ key: 'stale', source: 'repeated-tool-error', severity: 'minor' }),
    ];
    // Only 1 slot. The minor 'stale' was deferred on a recent tick → boosted (+1 rank,
    // and it wins the tie) so a persistent-but-minor signal eventually lands.
    const plan = planWatchdogCaptures(signals, {
      maxPerTick: 1,
      priorDeferredKeys: ['repeated-tool-error:stale'],
    });
    expect(plan.toCapture.map((s) => s.key)).toEqual(['stale']);
    // Without the deferral history, the fresh major would win.
    const baseline = planWatchdogCaptures(signals, { maxPerTick: 1 });
    expect(baseline.toCapture.map((s) => s.key)).toEqual(['fresh']);
  });
});

describe('tool-error sweep excludes the loop’s own tools (watchdog-robustness P-006)', () => {
  it('isImprovementLoopTool matches improvements:* and system:improvement-* only', () => {
    expect(isImprovementLoopTool('improvements:capture')).toBe(true);
    expect(isImprovementLoopTool('improvements:resolve')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-watchdog')).toBe(true);
    expect(isImprovementLoopTool('system:improvement-implement')).toBe(true);
    // unrelated tools are NOT excluded
    expect(isImprovementLoopTool('git:status')).toBe(false);
    expect(isImprovementLoopTool('plans:get')).toBe(false);
    expect(isImprovementLoopTool('improvement-runner')).toBe(false); // no colon prefix
  });

  it('a synthetic improvements:capture error row is not turned into a signal; an unrelated tool still is', () => {
    const rows = [
      { tool_name: 'improvements:capture', class: 'structural' as const, n: 9, total: 9, sample: 'pg hiccup' },
      { tool_name: 'system:improvement-watchdog', class: 'structural' as const, n: 12, total: 12, sample: 'boom' },
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom' },
    ];
    const signals = toolErrorSignalsFromRows(rows);
    expect(signals.map((s) => s.key)).toEqual(['docs:get:structural:error-code-unknown:field-unknown']);
    expect(signals[0].source).toBe('repeated-tool-error');
  });

  it('STRUCTURAL fires at a LOW bar (≥2) — the memory:search/remember miss is now caught (P-008)', () => {
    // The exact shape the old ≥5/60min ABSOLUTE threshold missed: a deterministic
    // workspace_required error at low volume.
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:remember', class: 'structural' as const, n: 2, total: 19, sample: 'workspace-scoped call' },
      { tool_name: 'memory:search', class: 'structural' as const, n: 18, total: 263, sample: 'workspace-scoped call' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        'memory:remember:structural:error-code-unknown:field-unknown',
        'memory:search:structural:error-code-unknown:field-unknown',
      ]),
    );
    expect(signals.every((s) => s.severity === 'major' && s.kind === 'bug')).toBe(true);
  });

  it('STRUCTURAL also fires on a high error-RATE below the count bar (decouples from volume → kills self-masking)', () => {
    const signals = toolErrorSignalsFromRows(
      [{ tool_name: 'x:y', class: 'structural' as const, n: 3, total: 4, sample: null }],
      { structuralMinCount: 5 }, // raise the COUNT bar so only the RATE test (3/4 = 75%) can fire it
    );
    expect(signals.map((s) => s.key)).toEqual(['x:y:structural:error-code-unknown:field-unknown']);
  });

  it('a single structural error does NOT fire (one-off noise is gated)', () => {
    expect(
      toolErrorSignalsFromRows([{ tool_name: 'x:y', class: 'structural' as const, n: 1, total: 100, sample: null }]),
    ).toEqual([]);
  });

  it('TRANSIENT is volume-, rate- AND duration-gated (R-1); ≥50 escalates to major', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'plans:list', class: 'transient' as const, n: 14, total: 20, active_hours: 6, sample: 'exceeded timeout' }, // <15 → no
      { tool_name: 'busy:tool', class: 'transient' as const, n: 60, total: 1000, active_hours: 6, sample: 'exceeded timeout' }, // 6% → no
      { tool_name: 'burst:tool', class: 'transient' as const, n: 60, total: 100, active_hours: 1, sample: 'exceeded timeout' }, // one hour → no
      { tool_name: 'slow:tool', class: 'transient' as const, n: 60, total: 100, active_hours: 4, sample: 'exceeded timeout' }, // sustained → major
    ]);
    expect(signals.map((s) => s.key)).toEqual(['slow:tool:transient']);
    expect(signals[0].severity).toBe('major');
    expect(signals[0].kind).toBe('bug');
    expect(signals[0].body).toMatch(/across 4 hours/);
  });

  it('CALLER/DX errors route to kind=change at low severity, only on a sustained pattern (≥10)', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'coord:thread', class: 'caller' as const, code_key: 'invalid_args', field_key: 'root_msg_id', n: 13, total: 22, sample: 'invalid_args: root_msg_id: Required' }, // ≥10
      { tool_name: 'rare:tool', class: 'caller' as const, code_key: 'invalid_args', field_key: 'slug', n: 3, total: 5, sample: 'invalid_args: slug: Required' }, // <10
    ]);
    expect(signals.map((s) => s.key)).toEqual(['coord:thread:caller:invalid_args:root_msg_id']);
    expect(signals[0].title).toContain('(invalid_args @ root_msg_id)');
    expect(signals[0].kind).toBe('change');
    expect(signals[0].severity).toBe('minor');
  });

  it('the SQL collector keeps qualifying caller groups beyond the former top-30 cap', async () => {
    const targetKey = 'capability:read:caller:superuser_native_session_verifier_unavailable:field-unknown';
    const rows = Array.from({ length: 30 }, (_, index) => ({
      tool_name: 'other:tool-' + index,
      class: 'caller' as const,
      code_key: 'invalid_args',
      field_key: 'representative',
      n: 20,
      total: 40,
      sample: 'invalid_args: representative',
    }));
    rows.push({
      tool_name: 'capability:read',
      class: 'caller',
      code_key: 'superuser_native_session_verifier_unavailable',
      field_key: 'field-unknown',
      n: 13,
      total: 9_654,
      sample: 'superuser_native_session_verifier_unavailable',
    });

    const queryTexts: string[] = [];
    const mockSql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.reduce(
          (text, part, index) => text + part + (index < values.length ? String(values[index]) : ''),
          '',
        );
        queryTexts.push(query);
        return Promise.resolve(query.includes('WITH fail AS') ? rows : []);
      },
      { unsafe: (value: string) => value },
    );

    const signals = await collectToolErrorSignals(mockSql as never, {
      toolLatencyBudgets: new Map([['work_items:complete', { effect: 'write' }]]) as never,
    }, 'papercusp-workspace');
    const mainQuery = queryTexts.find((query) => query.includes('WITH fail AS')) ?? '';

    expect(signals.map((signal) => signal.key)).toContain(targetKey);
    expect(mainQuery).toContain('HAVING');
    expect(mainQuery).not.toContain('LIMIT 30');
  });

  it('RATE-LIMIT (external provider 429 / TPM) is volume-gated, kind=change, NOT a code bug (P-002)', () => {
    const signals = toolErrorSignalsFromRows([
      // The 2026-06-17 embed-429: memory:search saturated ~32/78 calls — its OWN key,
      // distinct from the scoping :structural EI it used to be masked under.
      { tool_name: 'memory:search', class: 'rate-limit' as const, n: 32, total: 78, sample: 'openai_embed_failed_429: Rate limit reached … tokens per min (TPM)' },
      { tool_name: 'memory:remember', class: 'rate-limit' as const, n: 6, total: 40, sample: 'openai_embed_failed_429' }, // <8 → gated out
    ]);
    expect(signals.map((s) => s.key)).toEqual(['memory:search:rate-limit']);
    expect(signals[0].kind).toBe('change'); // external capacity, not the auto-implement lane
    expect(signals[0].severity).toBe('major'); // ≥30 → major
    expect(signals[0].findingClass).toBe('external-rate-limit:memory:search');
    expect(signals[0].body).toMatch(/EXTERNAL CAPACITY/);
  });

  it('STRUCTURAL key carries code + field so two DIFFERENT contracts under one tool do not mask each other (P-003, D-004)', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:search', class: 'structural' as const, code_key: 'workspace_required', field_key: 'field-unknown', n: 4, total: 50, sample: 'requires a workspace-scoped call' },
      { tool_name: 'memory:search', class: 'structural' as const, code_key: 'handler_error', field_key: 'field-unknown', n: 3, total: 50, sample: 'Cannot read properties of undefined' },
    ]);
    expect(signals.map((s) => s.key).sort()).toEqual([
      'memory:search:structural:handler_error:field-unknown',
      'memory:search:structural:workspace_required:field-unknown',
    ]);
    // Titles diverge per contract too, so the capture-core search-first dedup can't re-collapse them.
    expect(new Set(signals.map((s) => s.title)).size).toBe(2);
  });

  it('rows that share one structural key yield ONE signal however they arrive (R-3)', () => {
    // An injected collector (or a grouping change) may still hand over one row per
    // wording; the fold must not turn wordings back into separate filings.
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'plans:claim', class: 'structural' as const, code_key: 'claim_conflict', field_key: 'field-unknown', n: 2, total: 40, sample: 'claim_conflict: WI-1 held by su-a', latest_at: '2026-10-18T10:00:00Z' },
      { tool_name: 'plans:claim', class: 'structural' as const, code_key: 'claim_conflict', field_key: 'field-unknown', n: 3, total: 40, sample: 'claim_conflict: WI-9 held by su-z', latest_at: '2026-10-18T11:00:00Z' },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('plans:claim:structural:claim_conflict:field-unknown');
    expect(signals[0].body).toMatch(/5×/);
    expect(signals[0].body).toContain('WI-9 held by su-z'); // newest sample wins
  });

  it('a row with no code/field names them unknown rather than dropping the segments', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['docs:get:structural:error-code-unknown:field-unknown']);
  });

  it('coalesces a multi-tool, multi-session timeout burst into one shared-resource signal', () => {
    const signals = sharedToolStallSignalsFromRows([
      { tool_name: 'coord:inbox', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:00Z', class: 'transient', status: 'timeout' },
      { tool_name: 'sessions:search', coord_owner_id: 'owner-b', invoked_at: '2026-09-05T12:00:20Z', class: 'transient', status: 'error', duration_ms: 48_000 },
      { tool_name: 'work_items:get', coord_owner_id: 'owner-c', invoked_at: '2026-09-05T12:01:00Z', class: 'transient', status: 'timeout' },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      key: 'shared-resource-stall',
      title: 'Multiple tools timing out together (shared-resource stall)',
      severity: 'major',
      kind: 'bug',
      findingClass: 'shared-resource-stall',
    });
    expect(signals[0]!.body).toContain('3 distinct tools');
    expect(signals[0]!.body).toContain('3 distinct sessions');
  });

  it('describes the aggregate span when qualifying timeout windows are merged', () => {
    const rows = [0, 12].flatMap((hour) =>
      ['coord:inbox', 'sessions:search', 'work_items:get'].map((tool, index) => ({
        tool_name: tool,
        coord_owner_id: `owner-${hour}-${index}`,
        invoked_at: new Date(Date.UTC(2026, 9, 1, hour, 0, 0)).toISOString(),
        status: 'timeout',
      })),
    );

    const signals = sharedToolStallSignalsFromRows(rows);

    expect(signals).toHaveLength(1);
    expect(signals[0]!.body).toContain('6 transient timeout-class failures');
    expect(signals[0]!.body).toContain('across qualifying 5-minute sliding windows');
    expect(signals[0]!.body).toContain('aggregated observed span 43200s');
    expect(signals[0]!.body).not.toContain('within a 5-minute window');
  });

  it('does not coalesce a same-tool timeout or a single-session burst', () => {
    expect(sharedToolStallSignalsFromRows([
      { tool_name: 'coord:inbox', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:00Z', class: 'transient', status: 'timeout' },
      { tool_name: 'coord:inbox', coord_owner_id: 'owner-b', invoked_at: '2026-09-05T12:00:20Z', class: 'transient', status: 'timeout' },
      { tool_name: 'coord:inbox', coord_owner_id: 'owner-c', invoked_at: '2026-09-05T12:00:40Z', class: 'transient', status: 'timeout' },
    ])).toEqual([]);
    expect(sharedToolStallSignalsFromRows([
      { tool_name: 'coord:inbox', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:00Z', class: 'transient', status: 'timeout' },
      { tool_name: 'sessions:search', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:20Z', class: 'transient', status: 'timeout' },
      { tool_name: 'work_items:get', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:40Z', class: 'transient', status: 'timeout' },
    ])).toEqual([]);
  });

  it('suppresses only correlated transient per-tool signals; structural/caller/rate-limit stay independent', () => {
    const rows = [
      { tool_name: 'coord:inbox', class: 'transient' as const, n: 15, total: 20, active_hours: 5, sample: 'timeout' },
      { tool_name: 'docs:get', class: 'structural' as const, n: 2, total: 2, sample: 'missing table' },
      { tool_name: 'plans:new', class: 'caller' as const, code_key: 'invalid_args', field_key: 'status', n: 10, total: 10, sample: 'invalid_args: status' },
      { tool_name: 'memory:search', class: 'rate-limit' as const, n: 8, total: 8, sample: 'rate limit reached' },
    ];
    const signals = toolErrorSignalsFromRows(rows, {}, new Set(['coord:inbox']));
    expect(signals.map((signal) => signal.key)).toEqual([
      'docs:get:structural:error-code-unknown:field-unknown',
      'plans:new:caller:invalid_args:status',
      'memory:search:rate-limit',
    ]);
  });

  it('reports the tool suppression set alongside the shared signal for the collector', () => {
    const analysis = analyzeSharedToolStallsFromRows([
      { tool_name: 'a:tool', coord_owner_id: 'owner-a', invoked_at: '2026-09-05T12:00:00Z', class: 'transient' },
      { tool_name: 'b:tool', coord_owner_id: 'owner-b', invoked_at: '2026-09-05T12:00:10Z', class: 'transient' },
      { tool_name: 'c:tool', coord_owner_id: 'owner-c', invoked_at: '2026-09-05T12:00:20Z', class: 'transient' },
    ]);
    expect(analysis.signals).toHaveLength(1);
    expect([...analysis.correlatedToolNames]).toEqual(['a:tool', 'b:tool', 'c:tool']);
  });
});

describe('soft-failure outcome sweep (EI-20219227925547855)', () => {
  it('wires the collector to a newest-first tool+owner run partition and only selects run zero', () => {
    const source = readFileSync(new URL('./watchdog.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/PARTITION BY tool_name, coord_owner_id ORDER BY invoked_at DESC, id DESC/);
    expect(source).toMatch(/WHERE run_id = 0\s+AND result_outcome = 'soft-failure'/);
    expect(source).toContain('softFailureSignalsFromRunRows(softRows, opts)');
  });

  it('fires only for the current consecutive identical-reason run per tool + owner', () => {
    const rows = [
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-a', invoked_at: '2026-09-01T12:04:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'transcript_not_found' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-a', invoked_at: '2026-09-01T12:03:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'transcript_not_found' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-a', invoked_at: '2026-09-01T12:02:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'transcript_not_found' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-a', invoked_at: '2026-09-01T12:01:00Z', result_outcome: 'ok', soft_failure_reason: null },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-a', invoked_at: '2026-09-01T12:00:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'transcript_not_found' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-b', invoked_at: '2026-09-01T12:04:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'no_note' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-b', invoked_at: '2026-09-01T12:03:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'no_note' },
      { tool_name: 'journal:record-turn', coord_owner_id: 'owner-b', invoked_at: '2026-09-01T12:02:00Z', result_outcome: 'soft-failure', soft_failure_reason: 'no_note' },
    ];
    const signals = softFailureSignalsFromRows(rows, { softFailureMinRun: 3 });
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.key)).toEqual([
      softFailureSignalKey('journal:record-turn', 'transcript_not_found'),
      softFailureSignalKey('journal:record-turn', 'no_note'),
    ]);
    expect(signals[0].body).toContain('owner-a×3');
    expect(signals[0].body).not.toContain('×4');
  });

  it('collapses multiple owners with the same reason into one stable tool+reason signal', () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ tool_name: 'x:y', coord_owner_id: 'a', invoked_at: `2026-09-01T12:0${i}:00Z`, result_outcome: 'soft-failure', soft_failure_reason: 'same-reason' })),
      ...Array.from({ length: 4 }, (_, i) => ({ tool_name: 'x:y', coord_owner_id: 'b', invoked_at: `2026-09-01T11:0${i}:00Z`, result_outcome: 'soft-failure', soft_failure_reason: 'same-reason' })),
    ];
    const signals = softFailureSignalsFromRows(rows, { softFailureMinRun: 3 });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe(softFailureSignalKey('x:y', 'same-reason'));
    expect(signals[0].body).toMatch(/a×3/);
    expect(signals[0].body).toMatch(/b×4/);
    expect(signals[0].severity).toBe('minor');
  });

  it('does not create signals for loop-owned tools, blank reasons, or non-soft outcomes', () => {
    expect(softFailureSignalsFromRows([
      { tool_name: 'improvements:capture', coord_owner_id: 'a', result_outcome: 'soft-failure', soft_failure_reason: 'boom' },
      { tool_name: 'x:y', coord_owner_id: 'a', result_outcome: 'ok', soft_failure_reason: 'boom' },
      { tool_name: 'z:q', coord_owner_id: 'a', result_outcome: 'soft-failure', soft_failure_reason: '  ' },
    ], { softFailureMinRun: 1 })).toEqual([]);
  });
});

describe('classifyToolError — by error_code, with a legacy error_message fallback (P-008 / D-009)', () => {
  it('classifies by the first-class error_code when present (the P-007 path)', () => {
    expect(classifyToolError('unauthorized', 'error', 'x')).toBe('structural');
    expect(classifyToolError('handler_error', 'error', 'x')).toBe('structural');
    expect(classifyToolError('harness_required', 'error', 'x')).toBe('caller'); // P-007: harness arg is the caller's job
    expect(classifyToolError('timeout', 'timeout', 'x')).toBe('transient');
    expect(classifyToolError('invalid_args', 'error', 'x')).toBe('caller');
    expect(classifyToolError('role_not_allowed', 'role-not-allowed', 'x')).toBe('caller');
  });

  it('falls back to status + message for legacy rows (error_code NULL, pre-P-007 deploy)', () => {
    expect(classifyToolError(null, 'error', 'built-in tool requires a workspace-scoped call')).toBe('structural'); // workspace-scope gap stays structural (design intent)
    expect(classifyToolError(null, 'timeout', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'error', 'exceeded timeout of 60s')).toBe('transient');
    expect(classifyToolError(null, 'role-not-allowed', '')).toBe('caller');
    expect(classifyToolError(null, 'error', 'invalid_args: slug expected string')).toBe('caller');
    expect(classifyToolError(null, 'error', 'something unrecognized')).toBe('structural');
  });

  it('classifies PG/infra connection-exhaustion as TRANSIENT, not structural — even with a handler_error code (PG-wedge collateral guard)', () => {
    // The 2026-06-17 wedge surfaced these across every PG-backed tool as handler_error /
    // status=error; the low-bar structural signal mis-filed each tool as broken (EI-1331…1344).
    for (const code of ['handler_error', null]) {
      expect(classifyToolError(code, 'error', 'sorry, too many clients already')).toBe('transient');
      expect(
        classifyToolError(code, 'error', 'remaining connection slots are reserved for roles with the SUPERUSER attribute'),
      ).toBe('transient');
      expect(classifyToolError(code, 'error', 'could not connect to server: Connection refused')).toBe('transient');
      expect(classifyToolError(code, 'error', 'the database system is starting up')).toBe('transient');
    }
    // A genuine tool bug (no infra signature) STILL classifies structural — no false negatives.
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
    expect(classifyToolError(null, 'error', 'no such column: foo')).toBe('structural');
  });

  it('classifies an EXTERNAL provider rate-limit (OpenAI embed TPM 429) as rate-limit, not structural (P-002)', () => {
    // handler_error is the dispatcher code for an embed failure; the MESSAGE carries the signal.
    expect(
      classifyToolError('handler_error', 'error', 'openai_embed_failed_429: Rate limit reached for text-embedding-3-small … on tokens per min (TPM)'),
    ).toBe('rate-limit');
    // The misleading "Request too large … Requested 6" variant is the SAME TPM saturation.
    expect(
      classifyToolError('handler_error', 'error', 'openai_embed_failed_429: Request too large … on tokens per min (TPM): Limit 1000000, Requested 6'),
    ).toBe('rate-limit');
    expect(classifyToolError(null, 'error', '429 Too Many Requests')).toBe('rate-limit');
    expect(classifyToolError(null, 'error', 'rate limit exceeded')).toBe('rate-limit');
    // No rate-limit signature → STILL structural (no false positive).
    expect(classifyToolError('handler_error', 'error', 'Cannot read properties of undefined')).toBe('structural');
    // An INTERNAL caller quota_exceeded code stays CALLER (not an external provider limit).
    expect(classifyToolError('quota_exceeded', 'error', 'monthly budget exhausted')).toBe('caller');
  });

  it('classifies harness/scope caller errors as caller, not structural (P-007)', () => {
    expect(classifyToolError('handler_error', 'error', 'No harness specified. `harness` is a per-call arg')).toBe('caller');
    expect(classifyToolError('harness_required', 'error', 'x')).toBe('caller');
    expect(classifyToolError('handler_error', 'error', "resolvePlanScope: harness 'papercup-hive' is not registered in harness_shared.projects in any workspace")).toBe('caller');
    expect(classifyToolError('handler_error', 'error', "resolvePlanScope: plans are Hive-scoped, but 'sidestage-mobile' is not a Hive home and does not belong to one in workspace 'papercusp-workspace'")).toBe('caller');
    expect(classifyToolError(null, 'error', 'No harness specified')).toBe('caller');
    // A missing WORKSPACE-scope deliberately stays structural (a wiring gap, not a caller arg).
    expect(classifyToolError('unauthorized', 'error', 'built-in tool "memory:search" requires a workspace-scoped call')).toBe('structural');
  });

  it('classifies a timeout that surfaced as handler_error as transient, not structural (P-009)', () => {
    expect(classifyToolError('handler_error', 'error', 'tool "chat:ask_choice" exceeded timeout of 60s (handler returned but signal had aborted)')).toBe('transient');
    expect(classifyToolError('handler_error', 'error', 'plans:attention timed out')).toBe('transient');
  });
});

describe('ephemeral-benchmark signal filter (P-006)', () => {
  it('matches benchmark/throwaway slugs but never real harness slugs', () => {
    for (const s of ['xbench-su-CpaQzU-instance_flipt-io__f', 'xbqbhtpys6a', 'bench-memcap-probe-DELETEME', 'hiveloop-hive', 'sb-gym', 'e2e-imp-j1', 'xbench-smoke-p009-mem'])
      expect(isEphemeralBenchmarkHarnessSlug(s)).toBe(true);
    for (const s of ['papercup', 'papercup-org', 'papercup-org-business', 'papercup-hive', 'sheets', 'sheets-from-template-e2e', 'dbosroll', 'restart'])
      expect(isEphemeralBenchmarkHarnessSlug(s)).toBe(false);
  });

  it('drops per-harness signals for benchmark instances; keeps global + real-harness signals', () => {
    const bench = { source: 'stalled-feature' as const, key: 'xbench-su-CpaQzU', title: 'features in xbench-su-CpaQzU stalled', body: '', severity: 'major' as const, scope: 'harness:xbench-su-CpaQzU-instance_flipt' };
    const govStarve = { source: 'governor-starvation' as const, key: 'gov:xbqbhtpys6a', title: 'Hive xbqbhtpys6a: fleet saturated', body: '', severity: 'minor' as const };
    const real = { source: 'stalled-feature' as const, key: 'papercup', title: 'features in papercup stalled', body: '', severity: 'major' as const, scope: 'harness:papercup' };
    const globalToolErr = { source: 'repeated-tool-error' as const, key: 'memory:search:rate-limit', title: 'rate-limit', body: '', severity: 'minor' as const };
    expect(isEphemeralBenchmarkSignal(bench)).toBe(true);
    expect(isEphemeralBenchmarkSignal(govStarve)).toBe(true);
    expect(isEphemeralBenchmarkSignal(real)).toBe(false);
    expect(isEphemeralBenchmarkSignal(globalToolErr)).toBe(false); // global source — never filtered
  });

  it('P-008: the projects.ephemeral flag drops a flagged-slug signal even when the regex would NOT', () => {
    const flagged = new Set(['some-real-looking-slug']);
    const flaggedSig = { source: 'stalled-feature' as const, key: 'k', title: 'features stalled', body: '', severity: 'major' as const, scope: 'harness:some-real-looking-slug' };
    expect(isEphemeralBenchmarkSignal(flaggedSig)).toBe(false); // regex alone would NOT catch it
    expect(isEphemeralSignal(flaggedSig, flagged)).toBe(true); // ...but the first-class flag does
    // An un-flagged real harness signal is kept; the regex still catches benchmark slugs (fallback).
    const realSig = { source: 'stalled-feature' as const, key: 'k', title: 'features in papercup', body: '', severity: 'major' as const, scope: 'harness:papercup' };
    expect(isEphemeralSignal(realSig, new Set())).toBe(false);
    const benchSig = { source: 'stalled-feature' as const, key: 'k', title: 't', body: '', severity: 'major' as const, scope: 'harness:xbench-su-x-instance_foo' };
    expect(isEphemeralSignal(benchSig, new Set())).toBe(true);
    // ephemeralSignalSlug extracts the harness slug; null for a global (non-per-harness) source.
    expect(ephemeralSignalSlug(flaggedSig)).toBe('some-real-looking-slug');
    expect(ephemeralSignalSlug({ source: 'repeated-tool-error' as const, key: 'memory:search:rate-limit', title: 't', body: '', severity: 'minor' as const })).toBeNull();
  });
});

describe('rollupWatchdogTicks (P-013 observability)', () => {
  it('sums benchmark-filter drops + buckets repeated-tool-error keys by class', () => {
    const r = rollupWatchdogTicks([
      {
        collectors: [
          { name: 'ephemeral-benchmark-filter', note: 'dropped 12 ephemeral-benchmark harness signal(s) — debris' },
          { name: 'papercusp-red-test' },
        ],
        knownOpenKeys: [
          'repeated-tool-error:memory:search:rate-limit',
          'repeated-tool-error:plans:list:caller',
          'repeated-tool-error:coord:wake-queue:transient',
          'repeated-tool-error:memory:search:structural',
          'repeated-tool-error:memory:search:structural:built-in-tool-foo', // fingerprinted structural
          'red-test:foo.test.ts', // not a tool-error → ignored
        ],
      },
      { collectors: [{ name: 'ephemeral-benchmark-filter', note: 'dropped 8 debris' }], knownOpenKeys: ['repeated-tool-error:plans:get:caller'] },
    ]);
    expect(r.benchmarkDropped).toBe(20);
    expect(r.toolErrorByClass).toEqual({ 'rate-limit': 1, caller: 2, transient: 1, structural: 2 });
  });

  it('is empty-safe', () => {
    expect(rollupWatchdogTicks([])).toEqual({ benchmarkDropped: 0, toolErrorByClass: {} });
  });
});

describe('P-010 blind-source collectors (watchdog-robustness)', () => {
  it('migration-drift: fires critical when migrations are unapplied, silent when in sync', async () => {
    expect(await collectMigrationDriftSignals(async () => ({ missing: [] }))).toEqual([]);
    const drift = await collectMigrationDriftSignals(async () => ({ missing: ['205-foo.sql', '206-bar.sql'] }));
    expect(drift).toHaveLength(1);
    expect(drift[0].source).toBe('migration-drift');
    expect(drift[0].severity).toBe('critical');
    expect(drift[0].body).toContain('205-foo.sql');
    // sqlDir is optional — a check that omits it must not emit a dangling "Scanned sql dir:".
    expect(drift[0].body).not.toContain('Scanned sql dir');
  });

  it('migration-drift: names the SCANNED sql dir, so staging-ahead-of-release drift is distinguishable', async () => {
    // resolveSqlDir() is cwd-relative but the org DB is shared, so the staging operator and
    // the green operator disagree about the SAME database. Without the dir the filed bug is
    // ambiguous between real drift and the normal not-yet-deployed window (EI-18700750726210390).
    const [signal] = await collectMigrationDriftSignals(async () => ({
      missing: ['670-add-facts-confidence.sql'],
      sqlDir: '/home/dev/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql',
    }));
    expect(signal.body).toContain('670-add-facts-confidence.sql');
    expect(signal.body).toContain(
      'Scanned sql dir: /home/dev/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql',
    );
  });

  it('migration-drift: a thrown check degrades to no signal (never aborts the tick)', async () => {
    expect(await collectMigrationDriftSignals(async () => { throw new Error('pg down'); })).toEqual([]);
  });

  // WI-6037: `missing` alone over-fires during the normal staging→deploy window — the
  // staging tree is legitimately ahead of release, so every migration that lands there
  // reads as `missing` (and used to fire `critical`) until the scheduled deploy carries
  // it across. `missingDeployed` (present on disk in the release tree) is the
  // genuinely-actionable subset this collector must key on instead.
  it('migration-drift: staging-ahead-of-release noise (missingDeployed empty) does NOT fire critical', async () => {
    const signals = await collectMigrationDriftSignals(async () => ({
      missing: ['671-add-agent-facts-confidence.sql'],
      missingDeployed: [], // landed on staging only; release tree doesn't have the file yet
      sqlDir: '/home/dev/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql',
    }));
    expect(signals).toEqual([]);
  });

  // Masking control for the fix above: a migration present in the DEPLOYED tree and
  // still unapplied is a REAL hazard and must still fire critical — proving the
  // staging-ahead scoping change didn't blind the genuine case.
  it('migration-drift: a migration unapplied in the DEPLOYED tree still fires critical', async () => {
    const drift = await collectMigrationDriftSignals(async () => ({
      missing: ['670-add-facts-confidence.sql', '671-add-agent-facts-confidence.sql'],
      missingDeployed: ['670-add-facts-confidence.sql'], // only this one exists in release
    }));
    expect(drift).toHaveLength(1);
    expect(drift[0].severity).toBe('critical');
    expect(drift[0].body).toContain('670-add-facts-confidence.sql');
    expect(drift[0].body).not.toContain('671-add-agent-facts-confidence.sql');
  });

  it('schema-ahead-of-code: fires critical when the DB has migrations this tree does not ship, silent when in sync', async () => {
    expect(await collectSchemaAheadSignals(async () => ({ schemaAhead: [] }))).toEqual([]);
    const drift = await collectSchemaAheadSignals(async () => ({
      schemaAhead: ['689-agent-facts-append-versioning.sql'],
    }));
    expect(drift).toHaveLength(1);
    expect(drift[0].source).toBe('schema-ahead-of-code');
    expect(drift[0].severity).toBe('critical');
    expect(drift[0].body).toContain('689-agent-facts-append-versioning.sql');
    expect(drift[0].body).toContain('EI-18787755090726525');
    // sqlDir is optional — a check that omits it must not emit a dangling dir line.
    expect(drift[0].body).not.toContain("This tree's sql dir:");
  });

  it("schema-ahead-of-code: names THIS tree's sql dir when the check provides one", async () => {
    const [signal] = await collectSchemaAheadSignals(async () => ({
      schemaAhead: ['690-foo.sql'],
      sqlDir: '/home/dev/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql',
    }));
    expect(signal.body).toContain(
      "This tree's sql dir: /home/dev/papercupai-workspace/papercusp/libs/papercusp/libs/db/sql",
    );
  });

  it('schema-ahead-of-code: a thrown check degrades to no signal (never aborts the tick)', async () => {
    expect(await collectSchemaAheadSignals(async () => { throw new Error('pg down'); })).toEqual([]);
  });

  it('routine-failure: only routines with a non-empty last_error become signals (e.g. a wedged git-sync)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'git-sync', last_error: 'push rejected: oversized blob' },
      { name: 'healthy', last_error: null },
      { name: 'blank', last_error: '   ' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:git-sync']);
    expect(signals[0].severity).toBe('major');
    expect(signals[0].body).toContain('oversized blob');
  });

  it('routine-failure (EI-5302): a loop routine\'s dbos-executor-reaper self-heal requeue is SUPPRESSED (loop-stalled already covers a real wedge)', () => {
    const signals = routineFailureSignalsFromRows([
      {
        name: 'loop-su-abc123',
        last_error: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
        is_loop: true,
        last_error_source: 'dbos-executor-reaper',
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('routine-failure (EI-5302): a loop routine with a NON-reaper error still fires (the exclusion is source-specific, not a blanket loop exemption)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'loop-su-def456', last_error: 'some genuine crash', is_loop: true, last_error_source: 'runner' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:loop-su-def456']);
  });

  it('routine-failure (EI-5302): a NON-loop routine with a reaper-sourced error and NO next_fire_at still fires (unproven recovery)', () => {
    const signals = routineFailureSignalsFromRows([
      { name: 'git-sync', last_error: 'produced no DBOS operation output', is_loop: false, last_error_source: 'dbos-executor-reaper' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:git-sync']);
  });

  it('routine-failure (EI-6172): a NON-loop routine with a reaper-sourced error IS suppressed when next_fire_at is a concrete future timestamp (proven rescheduled)', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // a week out, like a weekly bp-singleton battery
    const signals = routineFailureSignalsFromRows([
      {
        name: 'bp-singleton-iq-battery-0',
        last_error: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
        is_loop: false,
        last_error_source: 'dbos-executor-reaper',
        next_fire_at: future,
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('routine-failure (EI-6172): a NON-loop routine with a reaper-sourced error still fires when next_fire_at is in the PAST (overdue, not proven recovered)', () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const signals = routineFailureSignalsFromRows([
      { name: 'stuck-cron', last_error: 'produced no DBOS operation output', is_loop: false, last_error_source: 'dbos-executor-reaper', next_fire_at: past },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:stuck-cron']);
  });

  it('routine-failure (WI-3098/EI-7771): a NON-loop routine with a reaper-sourced error IS suppressed when last_fired_at is RECENT even though next_fire_at reads as already-past (the collection-instant race)', () => {
    // Caught mid-cadence: fired 2min ago on a healthy ~5min cadence, but the
    // scheduler hasn't advanced next_fire_at past now() yet at query time.
    const justFired = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const nextFireBarelyPast = new Date(Date.now() - 30 * 1000).toISOString();
    const signals = routineFailureSignalsFromRows([
      {
        name: 'cross-hive-outbox-drain',
        last_error: 'DBOS routineFire produced no DBOS operation output; executor reaper cancelled the stuck fire and requeued the routine',
        is_loop: false,
        last_error_source: 'dbos-executor-reaper',
        next_fire_at: nextFireBarelyPast,
        last_fired_at: justFired,
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('routine-failure (WI-3098): a NON-loop routine with a reaper-sourced error still fires when last_fired_at is STALE (beyond the recent-fire proof window) and next_fire_at is past', () => {
    const staleFire = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago — well past the 30min proof window
    const past = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const signals = routineFailureSignalsFromRows([
      {
        name: 'genuinely-wedged',
        last_error: 'produced no DBOS operation output',
        is_loop: false,
        last_error_source: 'dbos-executor-reaper',
        next_fire_at: past,
        last_fired_at: staleFire,
      },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['routine:genuinely-wedged']);
  });

  it('routine-failure (EI-5302): the body no longer names git-sync as a false example (was mis-triggering the git-sync human-gate keyword)', () => {
    const signals = routineFailureSignalsFromRows([{ name: 'loop-su-xyz', last_error: 'crash' }]);
    expect(signals[0].body).not.toContain('git-sync');
  });

  it('loop-stalled (P1b): one signal per parked-dead loop, harness-scoped, citing the runbook', () => {
    const signals = loopStalledSignalsFromRows([
      { id: 'rt-1', name: 'loop-su-x', install_slug: 'papercusp', target_owner_id: 'su-x', interval_sec: 120, parked_secs: 2400 },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('loop-stalled');
    expect(signals[0].key).toBe('loop-stalled:papercusp:loop-su-x');
    expect(signals[0].body).toContain('~40min'); // 2400s
    expect(signals[0].body).toContain('loop-wake-turn-deaths-recorded-as-delivered');
    expect(signals[0].kind).toBe('bug');
    expect(signals[0].scope).toBe('harness:papercusp');
  });

  it('stale-protective-hold (EI-13022): fires only for a stale hold against a work-commanding directive', () => {
    const base = {
      installSlug: 'papercusp',
      potHeld: true,
      kettleStarted: false,
      workCommanded: true,
      directivePresent: true,
      directiveHead: 'Run the full Mug→Cup→Kettle→Blender loop. Place and complete real work',
      frontierDepth: 38,
      hoursSinceLastPlacement: 36,
      windowHours: 24,
      kettleHoursSinceFire: 31,
    };
    // The 2026-07-15 incident shape: pot paused + kettle paused + work-commanding directive.
    const signals = staleProtectiveHoldSignalsFromCandidates([base]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('stale-protective-hold');
    expect(signals[0].key).toBe('stale-protective-hold:papercusp:pot+kettle');
    expect(signals[0].scope).toBe('harness:papercusp');
    expect(signals[0].kind).toBe('bug');
    expect(signals[0].body).toContain('do NOT auto-resume');

    // A directive that EXISTS but does not command work → a self-documenting,
    // intentional pause ("in force until lifted"), never a signal. NOTE this case
    // keeps directivePresent:true — that is the whole distinction below.
    expect(
      staleProtectiveHoldSignalsFromCandidates([{ ...base, workCommanded: false, directivePresent: true }]),
    ).toHaveLength(0);
    // Hold present but placements are recent (< minHoldHours) → not yet stale.
    expect(
      staleProtectiveHoldSignalsFromCandidates([
        { ...base, kettleStarted: true, kettleHoursSinceFire: 0.1, hoursSinceLastPlacement: 0.5 },
      ]),
    ).toHaveLength(0);
    // Empty frontier → a pot pause is doing no harm; kettle leg alone still fires.
    const kettleOnly = staleProtectiveHoldSignalsFromCandidates([{ ...base, frontierDepth: 0 }]);
    expect(kettleOnly).toHaveLength(1);
    expect(kettleOnly[0].key).toBe('stale-protective-hold:papercusp:kettle-pause');
    // A pot that never ran a kettle (no autoloop row) never fires the kettle leg.
    expect(
      staleProtectiveHoldSignalsFromCandidates([
        { ...base, frontierDepth: 0, kettleHoursSinceFire: null },
      ]),
    ).toHaveLength(0);
    // Window too short to prove staleness → no signal (fresh tick history only).
    expect(
      staleProtectiveHoldSignalsFromCandidates([
        { ...base, kettleStarted: true, kettleHoursSinceFire: null, windowHours: 0.5, hoursSinceLastPlacement: null },
      ]),
    ).toHaveLength(0);
  });

  it('stale-protective-hold (EI-18653608066559541): an UNDOCUMENTED hold fires even with no directive to contradict', () => {
    // The gap: `workCommanded` is a keyword heuristic over directive TEXT, and
    // directiveSuggestsResume(null) is false — so the pre-fix gate skipped a pot
    // held with NO directive before weighing any evidence. The less a hold
    // documented itself, the more certainly the detector ignored it.
    const undocumented = {
      installSlug: 'papercusp',
      potHeld: true,
      kettleStarted: false,
      workCommanded: false, // necessarily false: a null directive can never command work
      directivePresent: false, // ← the whole point: nothing records WHY this hold exists
      directiveHead: '',
      frontierDepth: 38,
      hoursSinceLastPlacement: 36,
      windowHours: 24,
      kettleHoursSinceFire: 31,
    };
    const signals = staleProtectiveHoldSignalsFromCandidates([undocumented]);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('stale-protective-hold:papercusp:undocumented-pot+kettle');
    // It must NOT claim a directive it does not have — the original wording
    // ("contradicts its work-commanding directive") would be a plain falsehood.
    expect(signals[0].title).not.toContain('work-commanding');
    expect(signals[0].body).toContain('NO steering directive at all');
    // The remedy must include DOCUMENTING the pause, not only lifting it.
    expect(signals[0].body).toContain('directive:');
    expect(signals[0].body).toContain('do NOT');

    // CONTROL (so the case above cannot pass vacuously): identical evidence, but a
    // directive EXISTS and asserts the pause is intentional → still silent. This is
    // what separates "undocumented" from the pre-existing "not work-commanding".
    expect(
      staleProtectiveHoldSignalsFromCandidates([{ ...undocumented, directivePresent: true }]),
    ).toHaveLength(0);

    // CONTROL: the evidence gate still governs the new leg — an undocumented hold
    // with nothing piling up behind it is not drift, it is just a quiet pot.
    expect(
      staleProtectiveHoldSignalsFromCandidates([
        { ...undocumented, frontierDepth: 0, kettleHoursSinceFire: null },
      ]),
    ).toHaveLength(0);

    // The two legs must not double-report: they are mutually exclusive by
    // construction, so a documented work-commanding hold keeps its ORIGINAL key.
    const documented = staleProtectiveHoldSignalsFromCandidates([
      { ...undocumented, workCommanded: true, directivePresent: true, directiveHead: 'Place and complete real work' },
    ]);
    expect(documented).toHaveLength(1);
    expect(documented[0].key).toBe('stale-protective-hold:papercusp:pot+kettle');
  });

  it('stuck-plan: one signal per stuck plan, keyed by harness+plan', () => {
    const signals = stuckPlanSignalsFromRows([
      { harness_slug: 'papercup', plan_slug: 'some-plan', status: 'started', stale_hours: 51 },
    ]);
    expect(signals[0].key).toBe('stuck-plan:papercup:some-plan');
    expect(signals[0].body).toContain('51h');
    expect(signals[0].kind).toBe('bug');
    // P-032: a stuck plan is attributable to its harness → harness-scoped origin.
    expect(signals[0].scope).toBe('harness:papercup');
  });

  it('unresolved-escalation: one signal per unaddressed escalation', () => {
    const signals = escalationSignalsFromRows([{ harness_slug: 'sheets', phase: 'production' }]);
    expect(signals[0].key).toBe('escalation:sheets:production');
    expect(signals[0].source).toBe('unresolved-escalation');
    // P-032: harness-attributable origin scope.
    expect(signals[0].scope).toBe('harness:sheets');
  });

  it('fire-circuit-open: one signal per backed-off (slug, role) fire path', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: 'papercup-org', role: 'director', consecutive_errors: 7, last_status: 'error: timeout' },
    ]);
    expect(signals[0].key).toBe('circuit:papercup-org:director');
    expect(signals[0].source).toBe('fire-circuit-open');
    expect(signals[0].severity).toBe('major');
    expect(signals[0].body).toContain('7 consecutive');
    expect(signals[0].body).toContain('error: timeout');
    // P-032: harness-attributable origin scope.
    expect(signals[0].scope).toBe('harness:papercup-org');
  });

  // EI-6721: a dead, auto-paused loop:arm loop kept re-filing "stuck in error-backoff" EIs
  // (EI-6864/6912/6994/7127/7257/7386 all for the SAME dead loop-su-<uuid>) because this
  // collector — unlike the chronic-failure sweep — never checked the underlying routine state.
  it('fire-circuit-open: DROPS a row whose routine is auto-paused (routine_active=false)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: '*', role: 'loop-su-24eedd86', consecutive_errors: 54, last_status: 'loop-terminal-unreachable', routine_active: false },
    ]);
    expect(signals).toEqual([]);
  });

  it('fire-circuit-open: DROPS an ephemeral loop:arm owner loop (routine_target_owner_id set)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: '*', role: 'loop-su-24eedd86', consecutive_errors: 54, last_status: 'x', routine_target_owner_id: 'su-24eedd86' },
    ]);
    expect(signals).toEqual([]);
  });

  it('EI-7220: DROPS an ORPHANED loop:arm row (routine GC\'d → owner-id null) by its ROLE NAME', () => {
    // Mirror of the chronic-failure sweep fix: when the routine row is reaped the JOIN yields
    // routine_target_owner_id = null, so the owner-id marker fails open. The `loop-`-prefixed
    // role is the join-independent belt that still suppresses the leaked "stuck in error-backoff"
    // signal (the fire-circuit-open sibling of EI-7220's chronic-failure flood).
    const signals = circuitOpenSignalsFromRows([
      {
        harness_slug: '*',
        role: 'loop-su-c2b2ece8-d18f-4246-9ce2-d5bc0fdb4050',
        consecutive_errors: 7,
        last_status: 'loop-stuck-backstop',
        routine_active: null,
        routine_target_owner_id: null,
      },
    ]);
    expect(signals).toEqual([]);
  });

  it('fire-circuit-open: STILL fires for a fixed system role (no matching routine → routine_active null, no owner)', () => {
    const signals = circuitOpenSignalsFromRows([
      { harness_slug: 'gymloopharness', role: 'gym-cycle', consecutive_errors: 9, last_status: 'error', routine_active: null, routine_target_owner_id: null },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('circuit:gymloopharness:gym-cycle');
  });

  it('isResolvedFirePath: suppresses auto-paused OR loop:arm owner; fail-open otherwise', () => {
    expect(isResolvedFirePath({ routine_active: false })).toBe(true);
    expect(isResolvedFirePath({ routine_target_owner_id: 'su-abc' })).toBe(true);
    // EI-7220: a `loop-`-prefixed role is a loop:arm owner loop even with a null owner-id
    // (orphaned routine — the JOIN failed open).
    expect(isResolvedFirePath({ routine_active: null, routine_target_owner_id: null, role: 'loop-su-c2b2ece8' })).toBe(
      true,
    );
    // fail-open: unknown routine state (no join match) and a live fixed system role are NOT suppressed
    expect(isResolvedFirePath({ routine_active: null, routine_target_owner_id: null })).toBe(false);
    expect(isResolvedFirePath({ routine_active: null, routine_target_owner_id: null, role: 'gym-cycle' })).toBe(false);
    expect(isResolvedFirePath({ routine_active: true, routine_target_owner_id: '' })).toBe(false);
    expect(isResolvedFirePath({})).toBe(false);
  });
});

describe('hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010)', () => {
  const HOUR = 3_600_000;

  it('stalled-feature: ONE aggregate signal per harness, sample ids + oldest age in the body', () => {
    const now = Date.now();
    const signals = stalledFeatureSignalsFromRows(
      [
        { harness_slug: 'alpha', feature_id: 'F-1', updated_ts: now - 30 * HOUR },
        { harness_slug: 'alpha', feature_id: 'F-2', updated_ts: now - 14 * HOUR },
        { harness_slug: 'beta', feature_id: 'F-9', updated_ts: now - 13 * HOUR },
      ],
      { staleHours: 12, nowMs: now },
    );
    expect(signals.map((s) => s.key).sort()).toEqual(['stalled:alpha', 'stalled:beta']);
    const alpha = signals.find((s) => s.key === 'stalled:alpha')!;
    expect(alpha.source).toBe('stalled-feature');
    expect(alpha.severity).toBe('major');
    expect(alpha.body).toContain('2 dispatchable feature(s)');
    expect(alpha.body).toContain('F-1');
    expect(alpha.body).toContain('~30h');
    // P-032: one aggregate signal PER harness → harness-scoped origin (not blanket operator).
    expect(alpha.scope).toBe('harness:alpha');
    expect(signals.find((s) => s.key === 'stalled:beta')!.scope).toBe('harness:beta');
  });

  it('stalled-feature: no rows → no signal', () => {
    expect(stalledFeatureSignalsFromRows([])).toEqual([]);
  });

  it('stalled-feature: blueprint-less harnesses are expected manual work, not stalled dispatch', () => {
    expect(
      stalledFeatureSignalsFromRows([
        { harness_slug: 'papercup', feature_id: 'F-NO-BP', updated_ts: Date.now() - 30 * HOUR, blueprint_wired: false },
        { harness_slug: 'wired', feature_id: 'F-WIRED', updated_ts: Date.now() - 30 * HOUR, blueprint_wired: true },
      ]).map((signal) => signal.key),
    ).toEqual(['stalled:wired']);
  });

  it('orphaned-spawn: lingering past-reclaim running rows collapse to ONE signal with samples', () => {
    const signals = orphanedSpawnSignalsFromRows(
      [
        { spawn_id: 's-dead-1', harness_slug: 'alpha', heartbeat_at: null, started_at: new Date() },
        { spawn_id: 's-dead-2', harness_slug: null, heartbeat_at: new Date(), started_at: new Date() },
      ],
      { staleMinutes: 15 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('orphaned-spawn');
    expect(signals[0].key).toBe('orphaned-running-rows');
    expect(signals[0].body).toContain('2 spawned_agents row(s)');
    expect(signals[0].body).toContain('s-dead-1');
    // P-032: reclaim-non-execution is a WORKSPACE-global aggregate (it collapses
    // rows from many harnesses into one signal) → no harness scope; defaults to operator.
    expect(signals[0].scope).toBeUndefined();
    expect(orphanedSpawnSignalsFromRows([])).toEqual([]);
  });

  it('stalled-claim: live-holder-no-progress claims collapse to ONE signal (P-007, folds EI-2311)', () => {
    const signals = stalledClaimSignalsFromRows(
      [
        { work_item_id: 'WI-1', agent_id: 'bee-stuck', harness_slug: 'alpha', detail: 'a feature', stalled_minutes: 42 },
        { work_item_id: 'F-9', agent_id: 'bee-2', harness_slug: null, detail: 'another', stalled_minutes: 33 },
      ],
      { minMinutes: 30 },
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('stalled-claim');
    expect(signals[0].key).toBe('stalled-work-item-claims');
    expect(signals[0].findingClass).toBe('coordination:stalled-claim');
    expect(signals[0].body).toContain('2 work-item claim(s)');
    expect(signals[0].body).toContain('WI-1<-bee-stuck');
    expect(stalledClaimSignalsFromRows([])).toEqual([]);
  });

  it('EI-14763 regression: owner-wide activity is not item-scoped progress', () => {
    // WI-5215<-su-2ab13fe2 (heartbeating, mid-task) + WI-5137<-su-4d3eb54c (running
    // bash this minute) both had recent tool/coord activity → not a stall. Only a
    // heartbeating-but-idle holder (holder_active !== true) remains a genuine signal.
    const active = { work_item_id: 'WI-5215', agent_id: 'su-2ab13fe2', harness_slug: null, detail: 'fed watch', stalled_minutes: 40, holder_active: true };
    const alsoActive = { work_item_id: 'WI-5137', agent_id: 'su-4d3eb54c', harness_slug: 'papercusp', detail: 'diagnostic', stalled_minutes: 55, holder_active: true };
    const genuine = { work_item_id: 'WI-9', agent_id: 'bee-idle', harness_slug: 'alpha', detail: 'wedged', stalled_minutes: 42, holder_active: false };

    // Even the legacy owner-activity annotation cannot hide stale item progress.
    const activeSignals = stalledClaimSignalsFromRows([active, alsoActive], { minMinutes: 30 });
    expect(activeSignals).toHaveLength(1);
    expect(activeSignals[0].body).toContain('2 work-item claim(s)');

    // Mixed → owner-wide activity does not remove either stale item from the signal.
    const signals = stalledClaimSignalsFromRows([active, alsoActive, genuine], { minMinutes: 30 });
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('3 work-item claim(s)');
    expect(signals[0].body).toContain('WI-5215<-su-2ab13fe2');
    expect(signals[0].body).toContain('WI-5137<-su-4d3eb54c');
    expect(signals[0].body).toContain('WI-9<-bee-idle');
  });

  it('EI-18633753937712900 (WI-3669 recurrence): a deliberately PARKED claim (blocked / _claimHold) is NOT counted stalled', () => {
    // WI-3669 was set state=blocked + payload._claimHold=true 5 days ago (a
    // considered "nothing to do right now" disposition — it needs a live rig),
    // yet its false-alive heartbeat kept it reading `stalled=true`. Re-picking a
    // blocked/held item is futile, so it must never raise the stalled-claim
    // signal. The SQL fetch excludes these; this is the regression guard for the
    // pure signal's defensive drop (one rule, two enforcement points).
    const parkedBlocked = { work_item_id: 'WI-3669', agent_id: 'su-97195e45', harness_slug: 'papercusp', detail: 'blocked', stalled_minutes: 7914, parked: true };
    const parkedHeld = { work_item_id: 'WI-42', agent_id: 'su-held', harness_slug: 'papercusp', detail: 'claim-held', stalled_minutes: 900, parked: true };
    const genuine = { work_item_id: 'WI-9', agent_id: 'bee-idle', harness_slug: 'alpha', detail: 'wedged', stalled_minutes: 42, parked: false };

    // All rows parked → no signal (the WI-3669 5-day standing false-positive is gone).
    expect(stalledClaimSignalsFromRows([parkedBlocked, parkedHeld], { minMinutes: 30 })).toEqual([]);

    // Mixed → only the genuinely-idle, non-parked holder counts.
    const signals = stalledClaimSignalsFromRows([parkedBlocked, parkedHeld, genuine], { minMinutes: 30 });
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('1 work-item claim(s)');
    expect(signals[0].body).toContain('WI-9<-bee-idle');
    expect(signals[0].body).not.toContain('WI-3669');
    expect(signals[0].body).not.toContain('WI-42');
  });

  describe('spawn-ceiling-jam (EI-2186): admission consumed by non-streaming rows', () => {
    const now = Date.UTC(2026, 5, 21, 4, 0, 0);
    const minsAgo = (m: number) => new Date(now - m * 60_000);
    const opts = { ceiling: 8, minAgeMinutes: 15, silentMinutes: 15, slack: 2, now };

    it('fires ONE critical signal when old non-streaming rows dominate the ceiling (the jam)', () => {
      // 8 rows started 60 min ago, none streamed in the last 15 min → the EI-2186 jam.
      const rows = Array.from({ length: 8 }, (_, i) => ({
        spawn_id: `s-jam-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(60),
        last_output_at: i < 1 ? minsAgo(40) : null, // even the one with output is stale
      }));
      const signals = ceilingJamSignalsFromRows(rows, opts);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe('spawn-ceiling-jam');
      expect(signals[0].key).toBe('spawn-ceiling-jam');
      expect(signals[0].severity).toBe('critical');
      expect(signals[0].body).toContain('maxSimultaneousAgents=8');
      expect(signals[0].body).toContain('s-jam-0');
    });

    it('stays silent on a busy fleet — most running rows streamed recently', () => {
      const rows = Array.from({ length: 8 }, (_, i) => ({
        spawn_id: `s-live-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(60),
        last_output_at: minsAgo(1), // all actively streaming → genuinely alive
      }));
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('absorbs a couple of quiet/long-tool-call bees via slack (does not fire on 2)', () => {
      const rows = [
        { spawn_id: 'q1', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null },
        { spawn_id: 'q2', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null },
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('does not count YOUNG rows that have not had time to stream yet', () => {
      // 5 rows started 3 min ago with no output → too young to be suspect; no fire.
      const rows = Array.from({ length: 5 }, (_, i) => ({
        spawn_id: `young-${i}`,
        harness_slug: 'papercup',
        started_at: minsAgo(3),
        last_output_at: null,
      }));
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('does not fire when live streamers outnumber the stale-suspect rows', () => {
      const rows = [
        // 3 genuinely live (streamed in the last minute)
        ...Array.from({ length: 5 }, (_, i) => ({ spawn_id: `live-${i}`, harness_slug: 'p', started_at: minsAgo(60), last_output_at: minsAgo(1) })),
        // 3 stale suspects — but they do NOT outnumber the live ones
        ...Array.from({ length: 3 }, (_, i) => ({ spawn_id: `s-${i}`, harness_slug: 'p', started_at: minsAgo(60), last_output_at: null })),
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('is silent with no rows', () => {
      expect(ceilingJamSignalsFromRows([], opts)).toEqual([]);
    });

    // EI-7215: in-process loopback launches (durable-spawn workers, launch-* blueprints,
    // Queen/overwatch wakes) NEVER populate last_output_at — so the stream-recency proxy
    // is inapplicable and they must be EXCLUDED, else every live one reads as a stale debit.
    it('does NOT fire on a fleet of live in-process launches (the EI-7215 false positive)', () => {
      // A healthy fleet: durable-spawn implement workers + a launch-* doc-steward,
      // all old, none streaming (they structurally never do). This is exactly the
      // state that fired a false-positive critical before the fix.
      const rows = [
        { spawn_id: 'durable-spawn:implement:EI-6743:1', harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null, run_id: 'implement:EI-6743:1' },
        { spawn_id: 'durable-spawn:implement:EI-6966:1', harness_slug: 'papercup', started_at: minsAgo(45), last_output_at: null, run_id: 'implement:EI-6966:1' },
        { spawn_id: 'durable-spawn:implement:EI-7204:1', harness_slug: 'papercup', started_at: minsAgo(30), last_output_at: null, run_id: 'implement:EI-7204:1' },
        { spawn_id: 's-doc-steward-1', harness_slug: 'papercup', started_at: minsAgo(20), last_output_at: null, run_id: 'launch-1783137290156-c0e6f1' },
      ];
      expect(ceilingJamSignalsFromRows(rows, opts)).toEqual([]);
    });

    it('still fires on a genuine bee-spawn jam while ignoring co-running in-process launches', () => {
      // 4 real invoke-once bee spawns, old + never streamed → a genuine jam,
      // PLUS 3 live in-process launches that must NOT be counted (neither as
      // running, streamers, nor jammed).
      const rows = [
        ...Array.from({ length: 4 }, (_, i) => ({ spawn_id: `s-bee-${i}`, harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null as string | null, run_id: `bee-run-${i}` })),
        ...Array.from({ length: 3 }, (_, i) => ({ spawn_id: `durable-spawn:implement:EI-${i}:1`, harness_slug: 'papercup', started_at: minsAgo(60), last_output_at: null as string | null, run_id: `implement:EI-${i}:1` })),
      ];
      const signals = ceilingJamSignalsFromRows(rows, opts);
      expect(signals).toHaveLength(1);
      expect(signals[0].source).toBe('spawn-ceiling-jam');
      // Body reports the 4 EVALUABLE bee rows as running, not all 7.
      expect(signals[0].body).toContain('4 spawned_agents row(s)');
      expect(signals[0].body).toContain('s-bee-0');
      // The in-process launches are never named as jammed.
      expect(signals[0].body).not.toContain('durable-spawn');
    });
  });

  it('escalation-spike: silent below threshold, ONE signal with per-harness breakdown at/above it', () => {
    const rows = [
      { harness_slug: 'alpha', mtime_ms: Date.now() },
      { harness_slug: 'alpha', mtime_ms: Date.now() },
      { harness_slug: 'beta', mtime_ms: Date.now() },
    ];
    expect(escalationSpikeSignalsFromRows(rows.slice(0, 2), { minCount: 3 })).toEqual([]);
    const signals = escalationSpikeSignalsFromRows(rows, { windowHours: 6, minCount: 3 });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('escalation-spike');
    expect(signals[0].key).toBe('escalation-rate');
    expect(signals[0].body).toContain('3 escalation(s)');
    expect(signals[0].body).toContain('alpha×2');
    expect(signals[0].body).toContain('beta×1');
    // P-032: a RATE spike ACROSS the hive spans multiple harnesses (alpha + beta
    // here) — genuinely workspace-global → no harness scope; defaults to operator.
    expect(signals[0].scope).toBeUndefined();
  });
});

describe('red-test path normalization — one identity per broken test', () => {
  it('keeps multiple scoped paths without treating their array indexes as workspace roots', async () => {
    const queries: unknown[][] = [];
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push(values);
      return [];
    }) as unknown as Parameters<typeof fetchRedTestRows>[0];
    const paths = ['apps/operator/lib/a.test.ts', 'packages/operator-core/lib/b.test.ts'];
    await expect(fetchRedTestRows(sql, {}, paths)).resolves.toEqual([]);
    expect(queries).toContainEqual([expect.any(String), paths]);
  });

  it('strips the green-checkpoint (and any sibling-tree) prefix to the repo-relative path', () => {
    expect(normalizeRedTestPath('papercupai-workspace/papercup-checkpoint/packages/operator-core/lib/a.test.ts'))
      .toBe('packages/operator-core/lib/a.test.ts');
    expect(normalizeRedTestPath('/home/dev/papercupai-workspace/papercup/apps/operator/lib/b.test.ts'))
      .toBe('apps/operator/lib/b.test.ts');
    // Already repo-relative → unchanged.
    expect(normalizeRedTestPath('packages/operator-core/lib/a.test.ts'))
      .toBe('packages/operator-core/lib/a.test.ts');
  });

  it('strips an installation-specific workspace root when supplied', () => {
    expect(normalizeRedTestPath(
      '/srv/acme/test-workspace/papercusp/apps/operator/lib/a.test.ts',
      '/srv/acme/test-workspace',
    )).toBe('apps/operator/lib/a.test.ts');
  });

  it('drops synthetic fixture tests (loop probes, not bugs)', () => {
    expect(normalizeRedTestPath('lib/__synthetic__/close-loop-watchdog-probe.test.ts')).toBeNull();
  });

  it('drops retired-tree tests (preserved history, not active suites)', () => {
    expect(normalizeRedTestPath('libs/papercusp/_retired/orchestrator-run-loop/src/dispatches-pg.test.ts'))
      .toBeNull();
    expect(normalizeRedTestPath('/home/dev/papercupai-workspace/papercup/_retired/papercup/app/page.test.tsx'))
      .toBeNull();
  });

  it('MERGES the canonical + checkpoint rows of the SAME test into ONE signal (the EI-36/EI-143 dup)', () => {
    const signals = redTestSignalsFromRows(
      [
        { file_path: 'apps/operator/lib/__tests__/x.test.ts', framework: 'vitest', fails: 3, sample: 'boom' },
        { file_path: 'papercupai-workspace/papercup-checkpoint/apps/operator/lib/__tests__/x.test.ts', framework: 'vitest', fails: 4, sample: null },
        { file_path: 'lib/__synthetic__/probe.test.ts', framework: 'vitest', fails: 9, sample: null },
      ],
      6,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('apps/operator/lib/__tests__/x.test.ts');
    expect(signals[0].paths).toEqual(['apps/operator/lib/__tests__/x.test.ts']);
    expect(signals[0].body).toContain('failed 7×'); // counts summed across trees
    expect(signals[0].body).toContain('boom');
  });

  it('MERGES earliestAt as the min across canonical + checkpoint rows (the debounce span)', () => {
    const signals = redTestSignalsFromRows(
      [
        { file_path: 'a.test.ts', framework: 'vitest', fails: 3, sample: null, earliest_fail_at: '2026-07-11T20:00:00Z', latest_fail_at: '2026-07-11T20:30:00Z' },
        { file_path: 'a.test.ts', framework: 'vitest', fails: 2, sample: null, earliest_fail_at: '2026-07-11T19:00:00Z', latest_fail_at: '2026-07-11T19:15:00Z' },
      ],
      6,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].earliestAt).toBe('2026-07-11T19:00:00.000Z');
    expect(signals[0].latestAt).toBe('2026-07-11T20:30:00.000Z');
  });

  it('uses the newest failure tail when canonical/checkpoint rows have different evidence', () => {
    const signals = redTestSignalsFromRows(
      [
        {
          file_path: 'a.test.ts', framework: 'vitest', fails: 3, sample: 'old failure',
          latest_fail_at: '2026-07-11T19:00:00Z',
        },
        {
          file_path: 'papercupai-workspace/papercup-checkpoint/a.test.ts', framework: 'vitest', fails: 1,
          sample: 'new failure', latest_fail_at: '2026-07-11T20:00:00Z',
        },
      ],
      6,
    );
    expect(signals[0].body).toContain('new failure');
    expect(signals[0].body).not.toContain('old failure');
  });
});

describe('debounceRedTestSignals (EI-10102): a file being actively edited across its own failure window is a mid-refactor artifact, not a regression', () => {
  const redTestSig = (over: Partial<WatchdogSignal> = {}): WatchdogSignal => ({
    source: 'red-test',
    key: 'a.test.ts',
    title: 'Test failing repeatedly: a.test.ts',
    body: 'detail',
    severity: 'major',
    paths: ['a.test.ts'],
    earliestAt: '2026-07-11T20:00:00.000Z',
    latestAt: '2026-07-11T20:30:00.000Z',
    ...over,
  });

  it('drops the signal when checkEdited reports a commit inside the (buffered) failure window', async () => {
    const checkEdited = vi.fn(async (_path: string, _since: string, _until: string) => true);
    const kept = await debounceRedTestSignals([redTestSig()], checkEdited);
    expect(kept).toEqual([]);
    expect(checkEdited).toHaveBeenCalledTimes(1);
    const [path, since, until] = checkEdited.mock.calls[0];
    expect(path).toBe('a.test.ts');
    // Buffered 10min either side of the earliest/latest fail.
    expect(since).toBe('2026-07-11T19:50:00.000Z');
    expect(until).toBe('2026-07-11T20:40:00.000Z');
  });

  it('keeps the signal when checkEdited reports NO commit in the window (a real, settled regression)', async () => {
    const kept = await debounceRedTestSignals([redTestSig()], async () => false);
    expect(kept).toHaveLength(1);
    expect(kept[0].key).toBe('a.test.ts');
  });

  it('fails OPEN when checkEdited throws — a git hiccup never silently swallows a real signal', async () => {
    const kept = await debounceRedTestSignals([redTestSig()], async () => {
      throw new Error('git not found');
    });
    expect(kept).toHaveLength(1);
  });

  it('leaves non-red-test signals and red-test signals missing a window untouched (no debounce attempted)', async () => {
    const checkEdited = vi.fn(async () => true);
    const other = { source: 'smoke-fail' as const, key: 'x', title: 't', body: 'b', severity: 'major' as const, paths: ['a.test.ts'] };
    const noWindow = redTestSig({ earliestAt: undefined, latestAt: undefined });
    const kept = await debounceRedTestSignals([other, noWindow], checkEdited);
    expect(kept).toEqual([other, noWindow]);
    expect(checkEdited).not.toHaveBeenCalled();
  });

  it('only debounces the signals actually edited — a mixed batch keeps the untouched file, drops the mid-refactor one', async () => {
    const editedFile = redTestSig({ key: 'edited.test.ts', paths: ['edited.test.ts'] });
    const settledFile = redTestSig({ key: 'settled.test.ts', paths: ['settled.test.ts'] });
    const checkEdited = vi.fn(async (path: string) => path === 'edited.test.ts');
    const kept = await debounceRedTestSignals([editedFile, settledFile], checkEdited);
    expect(kept.map((s) => s.key)).toEqual(['settled.test.ts']);
  });

  describe('isLikelyTransientTransformFailure (EI-18145972782668210)', () => {
    it('matches esbuild transform-crash signatures', () => {
      expect(isLikelyTransientTransformFailure('Transform failed with 1 error:\nfoo.ts:12:3: ERROR: Expected ")" but found "opts"')).toBe(true);
      expect(isLikelyTransientTransformFailure('SyntaxError: Unexpected token, expected ","')).toBe(true);
      expect(isLikelyTransientTransformFailure('Unexpected token (14:2)')).toBe(true);
      expect(isLikelyTransientTransformFailure('Unterminated string literal')).toBe(true);
    });

    it('does NOT match a real assertion failure — this debounce must never mask genuine test breaks', () => {
      expect(isLikelyTransientTransformFailure('expected [ \'work_items:checkpoint\' ] to deeply equal []')).toBe(false);
      expect(isLikelyTransientTransformFailure('AssertionError: expected 3 to equal 4')).toBe(false);
    });

    it('does NOT match an unrelated resolution error (a missing import is often a REAL break, not a torn read)', () => {
      expect(isLikelyTransientTransformFailure('Cannot find module \'./foo\' from \'bar.ts\'')).toBe(false);
    });

    it('is null/undefined-safe', () => {
      expect(isLikelyTransientTransformFailure(null)).toBe(false);
      expect(isLikelyTransientTransformFailure(undefined)).toBe(false);
    });
  });

  describe('debounceRedTestSignals — transform-class failures from an UNCOMMITTED concurrent edit (EI-18145972782668210)', () => {
    const transformFailureSig = (over: Partial<WatchdogSignal> = {}) =>
      redTestSig({
        body: 'Watchdog signal (red-test): a.test.ts (vitest) failed 3× in the last 6h.\n\nLast failure tail:\nTransform failed with 1 error:\na.ts:5:2: ERROR: Expected ")" but found "opts"',
        ...over,
      });

    it('drops a transform-class failure when NOT git-edited but the file parses cleanly RIGHT NOW (a torn read of an uncommitted peer write)', async () => {
      const checkParsesCleanly = vi.fn(async (_path: string) => true);
      const kept = await debounceRedTestSignals([transformFailureSig()], async () => false, undefined, checkParsesCleanly);
      expect(kept).toEqual([]);
      expect(checkParsesCleanly).toHaveBeenCalledWith('a.test.ts');
    });

    it('keeps a transform-class failure when the file STILL does not parse cleanly (a real, still-broken file)', async () => {
      const kept = await debounceRedTestSignals([transformFailureSig()], async () => false, undefined, async () => false);
      expect(kept).toHaveLength(1);
    });

    it('never applies the re-parse check to a non-transform (assertion) failure, even if checkParsesCleanly would say true', async () => {
      const checkParsesCleanly = vi.fn(async () => true);
      const assertionSig = redTestSig({ body: 'expected [ \'work_items:checkpoint\' ] to deeply equal []' });
      const kept = await debounceRedTestSignals([assertionSig], async () => false, undefined, checkParsesCleanly);
      expect(kept).toHaveLength(1);
      expect(checkParsesCleanly).not.toHaveBeenCalled();
    });

    it('fails OPEN when checkParsesCleanly throws — a re-parse hiccup never silently swallows a real signal', async () => {
      const kept = await debounceRedTestSignals(
        [transformFailureSig()],
        async () => false,
        undefined,
        async () => {
          throw new Error('esbuild unavailable');
        },
      );
      expect(kept).toHaveLength(1);
    });

    it('keeps the signal when no checkParsesCleanly is wired at all (backward-compatible default)', async () => {
      const kept = await debounceRedTestSignals([transformFailureSig()], async () => false);
      expect(kept).toHaveLength(1);
    });

    it('the git-commit debounce (EI-10102) still wins first — a committed edit drops the signal without even calling checkParsesCleanly', async () => {
      const checkParsesCleanly = vi.fn(async () => false);
      const kept = await debounceRedTestSignals([transformFailureSig()], async () => true, undefined, checkParsesCleanly);
      expect(kept).toEqual([]);
      expect(checkParsesCleanly).not.toHaveBeenCalled();
    });
  });

  describe('debounceRedTestSignals — a file that no longer exists (a deleted/never-committed scratch test)', () => {
    it('drops the signal when checkExists reports the file is gone, WITHOUT even calling checkEdited', async () => {
      const checkEdited = vi.fn(async () => false);
      const checkExists = vi.fn(async (_path: string) => false);
      const kept = await debounceRedTestSignals([redTestSig()], checkEdited, undefined, undefined, checkExists);
      expect(kept).toEqual([]);
      expect(checkExists).toHaveBeenCalledWith('a.test.ts');
      expect(checkEdited).not.toHaveBeenCalled();
    });

    it('keeps the signal when checkExists reports the file is still there (falls through to the other debounces)', async () => {
      const kept = await debounceRedTestSignals([redTestSig()], async () => false, undefined, undefined, async () => true);
      expect(kept).toHaveLength(1);
    });

    it('fails OPEN when checkExists throws — an unverifiable filesystem check never silently swallows a real signal', async () => {
      const kept = await debounceRedTestSignals([redTestSig()], async () => false, undefined, undefined, async () => {
        throw new Error('EACCES');
      });
      expect(kept).toHaveLength(1);
    });

    it('keeps the signal when no checkExists is wired at all (backward-compatible default)', async () => {
      const kept = await debounceRedTestSignals([redTestSig()], async () => false);
      expect(kept).toHaveLength(1);
    });

    it('applies to a plain assertion failure too (unlike checkParsesCleanly, this is not scoped to transform-class failures)', async () => {
      const checkExists = vi.fn(async () => false);
      const assertionSig = redTestSig({ body: 'expected \'HUNG(bound neutralized)\' to be \'rejected(bound held)\'' });
      const kept = await debounceRedTestSignals([assertionSig], async () => false, undefined, undefined, checkExists);
      expect(kept).toEqual([]);
      expect(checkExists).toHaveBeenCalledWith('a.test.ts');
    });
  });
});

describe('watchdog COVERAGE self-test — the original miss is caught end-to-end (P-012)', () => {
  // A REGRESSION GUARD. The watchdog exists because it missed a low-frequency
  // STRUCTURAL tool error (memory:search workspace_required), starved by a backlog of
  // MAJOR red-tests. If a future change reintroduces EITHER half of that blind spot —
  // the structural classification (detection) or the per-source budget (anti-starvation)
  // — one of these tests fails, so the next blind spot is caught at CI time, not by an
  // owner noticing months later.
  function captureRec() {
    const captured: string[] = [];
    const capture = (async (input: { title: string }) => {
      captured.push(input.title);
      return { ok: true, created: true, issue: { id: `iss-${captured.length}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { captured, capture };
  }

  it('DETECTION: the memory:search workspace_required shape classifies as structural and fires at the LOW bar', () => {
    expect(classifyToolError('unauthorized', 'error', 'x')).toBe('structural');
    expect(classifyToolError(null, 'error', 'requires a workspace-scoped call')).toBe('structural');
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'memory:search', class: 'structural' as const, code_key: 'workspace_required', field_key: 'field-unknown', n: 2, total: 21, sample: 'workspace-scoped call' },
    ]);
    expect(signals.map((s) => s.key)).toEqual(['memory:search:structural:workspace_required:field-unknown']);
    expect(signals[0].severity).toBe('major');
  });

  it('ANTI-STARVATION: a structural tool-error signal lands end-to-end despite a 5× red-test backlog', async () => {
    const { captured, capture } = captureRec();
    const memSignal = sig({
      key: 'memory:search:structural', source: 'repeated-tool-error', severity: 'major',
      title: 'Tool memory:search returns a structural error',
    });
    const redTests = Array.from({ length: 5 }, (_, i) =>
      sig({ key: `t${i}`, source: 'red-test', severity: 'major', title: `Test failing repeatedly: t${i}` }),
    );
    const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      // red-tests FIRST in the list — under the old global cap-3 they would fill every
      // slot and starve the memory signal. The per-source budget (P-009) prevents that.
      collect: async () => [...redTests, memSignal],
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => [],
    });
    expect(captured).toContain('Tool memory:search returns a structural error');
    expect(res.captured.length).toBeGreaterThanOrEqual(1);
  });
});

describe('collectServiceDownSignals', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  it('captures only DOWN + present services', () => {
    const out = collectServiceDownSignals([
      probe({ name: 'operator' }),
      probe({ name: 'vite', up: false, status: null }),
      probe({ name: 'desktop', up: false, present: false }), // legitimately absent → no signal
    ]);
    expect(out.map((s) => s.key)).toEqual(['vite']);
    expect(out[0].title).toBe('Service vite is down');
    expect(out[0].severity).toBe('major');
  });
});

describe('service-down freshness gate (watchdog-robustness P-004)', () => {
  const probe = (p: Partial<ProbeResult> & { name: string }): ProbeResult => ({
    up: true,
    status: 200,
    latencyMs: 5,
    ...p,
  });

  // The inline-probe-on-stale fallback (below) now routes through
  // recordProbeResults, which mutates service-health.ts's shared confirm-ticks
  // streaks — reset between tests so one case's streak can't leak into another.
  beforeEach(() => {
    _resetServiceHealthState();
  });

  it('isServiceHealthStale: never-probed (null) is stale; fresh is not; beyond the window is', () => {
    const now = 1_000_000;
    const maxStale = 120_000;
    expect(isServiceHealthStale(null, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now - 30_000, now, maxStale)).toBe(false);
    expect(isServiceHealthStale(now - 200_000, now, maxStale)).toBe(true);
    expect(isServiceHealthStale(now, now, maxStale)).toBe(false);
  });

  it('a FRESH snapshot yields the down signals as before', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 10_000,
      now,
      maxStaleMs: 120_000,
    });
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.note).toBeUndefined();
  });

  // R4-7: with inline-probe DISABLED, the stale path keeps the legacy skip.
  it('a STALE snapshot (inline-probe off) yields NO signals + a stale-service-health skip note', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      results: [probe({ name: 'vite', up: false, status: null })],
      at: now - 200_000, // older than the 120s window
      now,
      maxStaleMs: 120_000,
      inlineProbe: false,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/stale-service-health/);
    expect(res.note).toMatch(/skipping service-down/);
    expect(res.note).toMatch(/200s old/);
  });

  it('a NEVER-populated snapshot (at=null, inline-probe off) skips with a "never populated" note', async () => {
    const res = await serviceDownCollectorResult({
      results: [], at: null, now: 1_000_000, maxStaleMs: 120_000, inlineProbe: false,
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/never populated/);
  });

  // R4-7: with inline-probe ENABLED (default), a stale snapshot runs a FRESH probe
  // instead of going blind — a real DOWN is still caught when the writer stalled.
  it('a STALE snapshot (inline-probe on) runs a fresh inline probe + emits its DOWN signals', async () => {
    const now = 1_000_000;
    let probed = false;
    const res = await serviceDownCollectorResult({
      // The cached `results` are intentionally all-UP — they must be IGNORED on
      // the stale path; the fresh probe (vite DOWN) is what should drive signals.
      results: [probe({ name: 'vite', up: true })],
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => {
        probed = true;
        return [probe({ name: 'operator' }), probe({ name: 'vite', up: false, status: null })];
      },
    });
    expect(probed).toBe(true);
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
    expect(res.signals[0].severity).toBe('major');
    expect(res.note).toMatch(/fresh inline probe/);
  });

  it('a STALE snapshot (inline-probe on) with all-up fresh probe emits NO signals (no phantom down)', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => [probe({ name: 'operator' }), probe({ name: 'vite' })],
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/fresh inline probe/);
  });

  // R4-7: if the inline probe itself throws, never go blind — emit a single
  // DEGRADED/unknown signal so a stale-and-unprobeable monitor is visible.
  it('a STALE snapshot (inline-probe on) whose probe THROWS emits a degraded monitor signal', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => { throw new Error('probe blew up'); },
    });
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].source).toBe('service-down');
    expect(res.signals[0].key).toBe('service-health-monitor');
    expect(res.signals[0].title).toMatch(/degraded/i);
    expect(res.signals[0].body).toMatch(/probe blew up/);
    expect(res.signals[0].findingClass).toBe('service-down:monitor-degraded');
    expect(res.note).toMatch(/inline probe failed/);
  });

  // ── WI-40769: the blind paths must DECLARE themselves unobserved ───────────
  //
  // A `note` is not enough. Both the sweep and this collector emit notes on paths
  // that DID observe (the inline-probe fallback carries one), so downstream cannot
  // tell "I looked and everything is up" from "I never looked" by prose. The
  // structured `observed:false` + `unobservedSource` pair is what `decideAutoClose`
  // subtracts from its absence evidence — without it, admitting service-down to
  // AUTO_CLOSE_ELIGIBLE_SOURCES would let a monitor outage auto-resolve a genuine
  // open outage row, because both look like six quiet ticks.
  describe('WI-40769 — blind ticks declare observed:false', () => {
    const now = 1_000_000;

    it('the legacy skip path declares itself unobserved', async () => {
      const res = await serviceDownCollectorResult({
        results: [probe({ name: 'vite', up: false, status: null })],
        at: now - 200_000,
        now,
        maxStaleMs: 120_000,
        inlineProbe: false,
      });
      // Zero signals here means "nothing was probed", NOT "every service is up".
      expect(res.signals).toEqual([]);
      expect(res.observed).toBe(false);
      expect(res.unobservedSource).toBe('service-down');
    });

    it('the inline-probe-FAILED path declares itself unobserved', async () => {
      const res = await serviceDownCollectorResult({
        at: now - 200_000,
        now,
        maxStaleMs: 120_000,
        inlineProbe: true,
        probe: async () => { throw new Error('probe blew up'); },
      });
      // It emits a signal, but that signal is about the MONITOR — every
      // per-service condition still went unobserved this tick.
      expect(res.signals).toHaveLength(1);
      expect(res.observed).toBe(false);
      expect(res.unobservedSource).toBe('service-down');
    });

    it('paths that DID observe do not claim to be blind (fresh, and inline-probe success)', async () => {
      // The other half of the pair: if every path declared itself unobserved,
      // service-down could never accumulate absence evidence and would never
      // auto-close — passing the two tests above while defeating the fix.
      const fresh = await serviceDownCollectorResult({
        results: [probe({ name: 'vite', up: true })],
        at: now - 10_000,
        now,
        maxStaleMs: 120_000,
      });
      expect(fresh.observed).not.toBe(false);

      const inlineOk = await serviceDownCollectorResult({
        at: now - 200_000,
        now,
        maxStaleMs: 120_000,
        inlineProbe: true,
        probe: async () => [probe({ name: 'operator' }), probe({ name: 'vite' })],
      });
      expect(inlineOk.observed).not.toBe(false);
    });

    it('the registered service-down collector declares its source, so a THROWN tick is attributable', async () => {
      // The pairing promised in the AUTO_CLOSE_ELIGIBLE_SOURCES comment: when
      // `collect()` throws there is no CollectorResult to read `unobservedSource`
      // from, so the source must come from the registration. Without it a crashed
      // collector's silence is unattributable and silently counts as "cleared".
      const collectors = await defaultPapercuspCollectors('papercusp-workspace');
      const svc = collectors.find((c) => c.name === 'papercusp-service-down');
      expect(svc).toBeDefined();
      expect(svc!.source).toBe('service-down');

      // Every auto-close-eligible source whose collector is registered here must
      // be able to attribute a thrown tick the same way.
      for (const c of collectors) {
        const derived = c.name.replace(/^papercusp-/, '');
        if (!AUTO_CLOSE_ELIGIBLE_SOURCES.has(derived)) continue;
        if (c.source === undefined) continue; // not yet adopted — see the field's doc
        expect(c.source).toBe(derived);
      }
    });
  });

  // The blind-spot regression guard: a stale snapshot must NEVER produce both
  // zero signals AND no note (the old silent-skip-under-load failure mode).
  it('a STALE snapshot is never fully blind (signals OR a note, both inline modes)', async () => {
    const now = 1_000_000;
    const stale = { at: now - 200_000, now, maxStaleMs: 120_000 } as const;
    const off = await serviceDownCollectorResult({ ...stale, inlineProbe: false, results: [] });
    const onDown = await serviceDownCollectorResult({
      ...stale, inlineProbe: true, probe: async () => [probe({ name: 'vite', up: false })],
    });
    const onThrow = await serviceDownCollectorResult({
      ...stale, inlineProbe: true, probe: async () => { throw new Error('x'); },
    });
    for (const r of [off, onDown, onThrow]) {
      expect(r.signals.length > 0 || (r.note != null && r.note.length > 0)).toBe(true);
    }
  });

  // EI-19363229944812169: the inline-probe-on-stale fallback used to call
  // probeAll() and feed the raw result straight to collectServiceDownSignals,
  // bypassing DOWN_CONFIRM_TICKS entirely — reintroducing the exact
  // single-tick restart-drain flap WI-6146 damped staging-api against, but
  // only for the watchdog's auto-filed bug tickets (the periodic 60s tick
  // was never affected). Fixed by routing the fresh probe through
  // recordProbeResults, the same debounce the periodic tick uses.
  it('a STALE snapshot (inline-probe on) does NOT fire on a single down reading for a DAMPED name (staging-api)', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000,
      now,
      maxStaleMs: 120_000,
      inlineProbe: true,
      probe: async () => [probe({ name: 'staging-api', up: false, status: null })],
    });
    // First-ever bad reading for a 2-confirm-tick name → unconfirmed, no signal —
    // exactly the restart-drain-window false alarm this fix eliminates.
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/fresh inline probe/);
  });

  it('a STALE snapshot (inline-probe on) DOES fire for a DAMPED name once its streak is confirmed (2 consecutive bad probes)', async () => {
    const now = 1_000_000;
    const down = { name: 'staging-api', up: false, status: null } as const;
    // First inline probe: unconfirmed (streak 1/2) — matches the case above.
    const first = await serviceDownCollectorResult({
      at: now - 200_000, now, maxStaleMs: 120_000, inlineProbe: true,
      probe: async () => [probe(down)],
    });
    expect(first.signals).toEqual([]);
    // Second consecutive inline probe still down: streak reaches 2/2 → confirmed.
    const second = await serviceDownCollectorResult({
      at: now - 200_000, now: now + 1000, maxStaleMs: 120_000, inlineProbe: true,
      probe: async () => [probe(down)],
    });
    expect(second.signals.map((s) => s.key)).toEqual(['staging-api']);
  });

  it('a STALE snapshot (inline-probe on) still fires immediately for an UNDAMPED name (vite, unchanged behavior)', async () => {
    const now = 1_000_000;
    const res = await serviceDownCollectorResult({
      at: now - 200_000, now, maxStaleMs: 120_000, inlineProbe: true,
      probe: async () => [probe({ name: 'vite', up: false, status: null })],
    });
    expect(res.signals.map((s) => s.key)).toEqual(['vite']);
  });

  it('default window is 2× the 60s probe interval', () => {
    expect(DEFAULT_SERVICE_HEALTH_MAX_STALE_MS).toBe(120_000);
  });
});

describe('runWatchdogTick — captures through the shared core', () => {
  /** No-op tick sink so unit tests never touch PG (the default recordTick writes PG). */
  const noopRecord = async (): Promise<void> => {};

  function captureRecorder(results: Partial<CaptureImprovementResult>[] = []) {
    const calls: unknown[] = [];
    let i = 0;
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      const r = results[i++] ?? {};
      return {
        ok: true,
        created: r.created ?? true,
        reason: r.reason,
        issue: r.created === false ? undefined : ({ id: `EI-${100 + i}` } as never),
        possibleDuplicates: [],
        ...r,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('captures each planned signal as kind=bug with dedupScope open + the paths', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'lib/a.test.ts', paths: ['lib/a.test.ts'] })];
    const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'bug',
      dedupScope: 'open',
      paths: ['lib/a.test.ts'],
      foundDuring: 'improvement-watchdog',
      // consume-edges P-021: scope is always explicit so the D-005 triage
      // taxonomy can key off it ('operator' when the signal doesn't set one).
      scope: 'operator',
    });
  });

  it('re-detects planned red tests immediately before capture and suppresses a now-green subject', async () => {
    const { calls, capture } = captureRecorder();
    const red = sig({ key: 'a.test.ts', paths: ['a.test.ts'], latestAt: '2026-07-11T20:00:00.000Z' });
    const redetectRedTests = vi.fn(async () => [] as WatchdogSignal[]);
    const res = await runTick('ws', {}, {
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      collect: async () => [red],
      redetectRedTests,
      capture,
      recordTick: noopRecord,
    });
    expect(redetectRedTests).toHaveBeenCalledWith(['a.test.ts'], expect.anything());
    expect(calls).toHaveLength(0);
    expect(res.captured).toEqual([]);
  });

  it('captures refreshed red-test evidence when the subject is still red', async () => {
    const { calls, capture } = captureRecorder();
    const initial = sig({ key: 'a.test.ts', paths: ['a.test.ts'], body: 'stale tail' });
    const current = sig({ key: 'a.test.ts', paths: ['a.test.ts'], body: 'fresh tail' });
    await runTick('ws', {}, {
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      collect: async () => [initial],
      redetectRedTests: async () => [current],
      capture,
      recordTick: noopRecord,
    });
    expect(calls[0]).toMatchObject({ body: 'fresh tail' });
  });

  it('passes a per-signal scope through to the capture (consume-edges P-021)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'hive-x', scope: 'harness:sheets' })];
    await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls[0]).toMatchObject({ scope: 'harness:sheets' });
  });

  it('captures a Red-Queen drill with the valid operator scope and drill origin intact', async () => {
    const { calls, capture } = captureRecorder();
    const signal = stampDrillSignals([sig({ key: 'drill-scope-regression' })])[0];
    await runTick('ws', {}, {
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      collect: async () => [signal],
      capture,
      recordTick: noopRecord,
    });
    expect(calls[0]).toMatchObject({ scope: 'operator', origin: 'drill' });
  });

  it('captures drill-origin metric signals while suppressing organic metrics', async () => {
    const { calls, capture } = captureRecorder();
    const drill = sig({ source: 'routine-engine-death', key: 'sandbox-engine', origin: 'drill' });
    const organic = sig({ source: 'routine-engine-death', key: 'live-engine', origin: 'organic' });

    expect(signalLaneOf('routine-engine-death')).toBe('metric');
    expect(sourceFilesWorkItem('routine-engine-death')).toBe(false);

    const res = await runTick('sandbox', {}, {
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      collect: async () => [drill, organic],
      capture,
      recordTick: noopRecord,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ origin: 'drill', watchdogKey: watchdogKeyOf(drill) });
    expect(res.captured).toEqual(['EI-101']);
    expect(res.metricSuppressed).toBe(1);
    expect(res.metricSuppressedKeys).toEqual([watchdogKeyOf(organic)]);
  });

  it('passes a per-signal findingClass through to the capture (frontier P-044 taxonomy slug)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'slo-x', findingClass: 'learning-slo:triage-degeneracy' })];
    await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls[0]).toMatchObject({ findingClass: 'learning-slo:triage-degeneracy' });
    // absent on the signal stays absent on the capture — graduation's
    // findingClassOf falls back to `<source>:unclassified`, never a fake stamp.
    const { calls: bare, capture: bareCapture } = captureRecorder();
    await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'y' })], capture: bareCapture, recordTick: noopRecord });
    expect((bare[0] as { findingClass?: string }).findingClass).toBeUndefined();
  });

  it('counts verdict-annotated duplicate filings (P-002: the dedup verdict rides the created row)', async () => {
    const { capture } = captureRecorder([
      { created: true, issue: { id: 'EI-9', payload: { dedupVerdict: 'likely-duplicate' } } as never },
    ]);
    const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'x' })], capture, recordTick: noopRecord });
    expect(res.captured).toEqual(['EI-9']);
    expect(res.declinedDuplicates).toBe(1);
  });

  it('respects the per-tick cap (deferred surfaces in the result)', async () => {
    const { calls, capture } = captureRecorder();
    const signals = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const res = await runTick('ws', { maxPerTick: 1 }, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => signals, capture, recordTick: noopRecord });
    expect(calls).toHaveLength(1);
    expect(res.deferred).toBe(2);
  });

  it('a single capture failure does not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let n = 0;
      const capture = async (): Promise<CaptureImprovementResult> => {
        n += 1;
        if (n === 1) throw new Error('pg hiccup');
        return { ok: true, created: true, issue: { id: 'EI-9' } as never, possibleDuplicates: [] };
      };
      const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], capture, recordTick: noopRecord });
      expect(res.captured).toEqual(['EI-9']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/capture failed for red-test:a/));
    } finally {
      warn.mockRestore();
    }
  });

  it('(P-011) accepts pluggable per-target collectors', async () => {
    const { calls, capture } = captureRecorder();
    const customCollectors: WatchdogCollector[] = [
      {
        name: 'my-project-integration-tests',
        collect: async () => [
          sig({ key: 'integration-test', source: 'red-test', title: 'My project integration test failing' }),
        ],
      },
      {
        name: 'my-project-smoke',
        collect: async () => [sig({ key: 'smoke', source: 'smoke-fail', title: 'My project smoke test failing' })],
      },
    ];
    const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collectors: customCollectors, capture, recordTick: noopRecord });
    expect(res.captured).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ title: 'My project integration test failing' });
    expect(calls[1]).toMatchObject({ title: 'My project smoke test failing' });
  });

  it('(P-011) collector failures are caught + logged but do not abort the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder();
      const collectors: WatchdogCollector[] = [
        {
          name: 'good-collector',
          collect: async () => [sig({ key: 'good', title: 'Good signal' })],
        },
        {
          name: 'bad-collector',
          collect: async () => {
            throw new Error('connection timeout');
          },
        },
      ];
      const res = await runTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune, collectors, capture, recordTick: noopRecord });
      expect(res.signals).toBe(1); // only the good signal
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/collector "bad-collector" failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — tick record (watchdog-robustness P-001)', () => {
  function captureOk() {
    let i = 0;
    return async (): Promise<CaptureImprovementResult> =>
      ({ ok: true, created: true, issue: { id: `EI-${++i}` } as never, possibleDuplicates: [] }) as CaptureImprovementResult;
  }

  it('writes one tick record with status, captured ids, and per-collector statuses', async () => {
    const records: WatchdogTickRecord[] = [];
    const collectors: WatchdogCollector[] = [
      { name: 'good', collect: async () => [sig({ key: 'a', title: 'A' })] },
      { name: 'bad', collect: async () => { throw new Error('boom'); } },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runTick('ws-1', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collectors,
        capture: captureOk(),
        recordTick: async (r) => { records.push(r); },
      });
      expect(records).toHaveLength(1);
      const rec = records[0];
      expect(rec).toMatchObject({ workspaceId: 'ws-1', status: 'ran', signals: 1 });
      expect(rec.captured).toEqual(res.captured);
      // per-collector status reflects the good + failed collector.
      // WI-40769: a collector that THREW observed nothing, so it is stamped
      // `observed:false` — its silence must not later read as "condition cleared".
      // No `unobservedSource` here because this test collector declares no
      // `source`; an unattributable blind tick is recorded but discounts nothing.
      expect(rec.collectors).toEqual([
        { name: 'good', ok: true, signalCount: 1 },
        { name: 'bad', ok: false, signalCount: 0, error: 'boom', observed: false },
      ]);
      expect(rec.selfEscalations).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('records the installSlug when given', async () => {
    const records: WatchdogTickRecord[] = [];
    await runTick('ws-2', { installSlug: 'papercup' }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [],
      capture: captureOk(),
      recordTick: async (r) => { records.push(r); },
    });
    expect(records[0].installSlug).toBe('papercup');
  });

  it('a tick-record failure does NOT abort the tick (best-effort bookkeeping)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await runTick('ws-3', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collect: async () => [sig({ key: 'a' })],
        capture: captureOk(),
        recordTick: async () => { throw new Error('pg down'); },
      });
      expect(res.captured).toHaveLength(1); // tick still completed + returned
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tick record failed: pg down/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('planSelfEscalations — the watchdog watches itself (watchdog-robustness P-002)', () => {
  const fail = (name: string): CollectorStatus => ({ name, ok: false, signalCount: 0, error: 'boom' });
  const okc = (name: string): CollectorStatus => ({ name, ok: true, signalCount: 1 });
  const tick = (collectors: CollectorStatus[], status: 'ran' | 'skipped' = 'ran'): RecentTick => ({ status, collectors });

  it('escalates a collector failing this tick + the (need-1) prior ticks', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual(['bad']);
  });

  it('does NOT escalate before the streak is reached', () => {
    const out = planSelfEscalations([fail('bad')], [tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // streak = 2 < 3
  });

  it('a recovered (ok) prior tick breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([okc('bad')]), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]); // most-recent prior shows it recovered → streak resets
  });

  it('a skipped prior tick (no sweep) breaks the streak', () => {
    const out = planSelfEscalations([fail('bad')], [tick([], 'skipped'), tick([fail('bad')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('a collector healthy this tick never escalates', () => {
    const out = planSelfEscalations([okc('good')], [tick([fail('good')]), tick([fail('good')])], { failStreakToEscalate: 3 });
    expect(out).toEqual([]);
  });

  it('failStreakToEscalate=1 escalates on the first failing tick', () => {
    expect(planSelfEscalations([fail('bad')], [], { failStreakToEscalate: 1 })).toEqual(['bad']);
  });
});

describe('runWatchdogTick — self-escalation through the shared core (P-002)', () => {
  const throwingCollector: WatchdogCollector = {
    name: 'papercusp-red-test',
    collect: async () => { throw new Error('relation test_runs does not exist'); },
  };
  const priorFails = (n: number): RecentTick[] =>
    Array.from({ length: n }, () => ({ status: 'ran' as const, collectors: [{ name: 'papercusp-red-test', ok: false, signalCount: 0, error: 'x' }] }));

  function captureRecorder(result: Partial<CaptureImprovementResult> = {}) {
    const calls: unknown[] = [];
    const capture = async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      return {
        ok: true,
        created: result.created ?? true,
        reason: result.reason,
        issue: result.created === false ? undefined : ({ id: 'EI-SELF' } as never),
        possibleDuplicates: [],
        ...result,
      } as CaptureImprovementResult;
    };
    return { calls, capture };
  }

  it('files exactly one kind=bug self-escalation when a collector hits the fail streak', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(2), // 2 priors + this tick = streak 3
      });
      expect(res.selfEscalations).toEqual(['EI-SELF']);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        kind: 'bug',
        dedupScope: 'open',
        sourceRole: 'system',
        title: 'Watchdog collector "papercusp-red-test" is failing',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT self-escalate before the streak (no prior failing ticks)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const res = await runTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [], // no priors → streak 1 < 3
      });
      expect(res.selfEscalations).toEqual([]);
      expect(calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('a coalesced self-escalation is not re-listed (P-002: coalesce is the surviving non-create path)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { capture } = captureRecorder({ created: false, reason: 'coalesced' });
      const res = await runTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collectors: [throwingCollector],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => priorFails(3),
      });
      expect(res.selfEscalations).toEqual([]); // coalesced onto the open duplicate
    } finally {
      warn.mockRestore();
    }
  });

  it('a healthy signal-bearing tick reads the prior tick for the delta gate but does not self-escalate', async () => {
    let readCalled = false;
    const { calls, capture } = captureRecorder();
    const res = await runTick('ws', { failStreakToEscalate: 3 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [sig({ key: 'a' })], // injected → collectors = [{injected, ok:true}]
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => { readCalled = true; return []; },
    });
    expect(res.selfEscalations).toEqual([]); // nothing failed → no self-escalation
    // The P-003 delta gate (watchdog-churn-delta-gate-2026-07-25) diffs this tick's signals
    // against the previous ran tick's seenKeys, so a signal-bearing tick now takes ONE shared
    // prior-tick read even when no collector failed. The old "no read unless something failed"
    // short-circuit predated the delta gate; the read fails OPEN here (no prior → [] → fresh).
    expect(readCalled).toBe(true);
    expect(calls).toHaveLength(1); // only the real signal capture, still filed (fresh)
  });

  it('caps self-escalations per tick (maxSelfEscalationsPerTick)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRecorder();
      const twoBad: WatchdogCollector[] = [
        { name: 'col-a', collect: async () => { throw new Error('a'); } },
        { name: 'col-b', collect: async () => { throw new Error('b'); } },
      ];
      const res = await runTick('ws', { failStreakToEscalate: 1, maxSelfEscalationsPerTick: 1 }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
        collectors: twoBad,
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
      });
      expect(res.selfEscalations).toHaveLength(1); // both crossed, but capped at 1
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — cross-host lock (watchdog-robustness P-003)', () => {
  const captureOk = (counter: { n: number }) =>
    async (): Promise<CaptureImprovementResult> => {
      counter.n += 1;
      return { ok: true, created: true, issue: { id: `EI-${counter.n}` } as never, possibleDuplicates: [] } as CaptureImprovementResult;
    };

  it('runs the tick (and captures) when it HOLDS the lock', async () => {
    const counter = { n: 0 };
    const res = await runWatchdogTick('ws', {}, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async () => {},
      withTickLock: async (_ws, fn) => ({ ran: true, value: await fn() }),
    });
    expect(res.status).toBe('ran');
    expect(res.captured).toEqual(['EI-1']);
    expect(counter.n).toBe(1);
  });

  it('SKIPS the tick (zero captures) + records a skipped tick when another host holds the lock', async () => {
    const counter = { n: 0 };
    const records: WatchdogTickRecord[] = [];
    const res = await runWatchdogTick('ws', { installSlug: 'papercup' }, { readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [sig({ key: 'a' })],
      capture: captureOk(counter),
      recordTick: async (r) => { records.push(r); },
      withTickLock: async () => ({ ran: false }), // another host owns it
    });
    expect(res.status).toBe('skipped');
    expect(res.captured).toEqual([]);
    expect(counter.n).toBe(0); // body never ran → nothing captured (no duplicate race)
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'skipped', installSlug: 'papercup', signals: 0 });
  });

  it('default lock FAILS OPEN when the DB is unavailable (runs fn unlocked, never double-runs)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      const out = await withWatchdogTickLock('ws', async () => { runs += 1; return 42; });
      expect(out).toEqual({ ran: true, value: 42 });
      expect(runs).toBe(1); // ran exactly once (fail-open, no double-run)
    } finally {
      warn.mockRestore();
    }
  });

  it('default lock propagates a fn error without double-running it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let runs = 0;
      await expect(
        withWatchdogTickLock('ws', async () => { runs += 1; throw new Error('body boom'); }),
      ).rejects.toThrow('body boom');
      expect(runs).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  // backend-connection-scaling-2026-06-17 P-001: the tick mutex is a SESSION-level
  // pg_advisory_lock — acquire + release MUST hit the same backend. Under PgBouncer
  // transaction pooling (PAPERCUSP_PGBOUNCER=1) the pooled org client reassigns
  // backends per statement, so the lock connection MUST bypass the pooler. This
  // guards against a future refactor "helpfully" routing it through maybePgbouncer.
  describe('tick-lock connection is DIRECT, never the PgBouncer pooler (P-001)', () => {
    const DIRECT = 'postgresql://harness_admin:pw@db-direct.test:5432/papercusp';
    const env = process.env;
    const KEYS = [
      'HARNESS_ADMIN_DATABASE_URL',
      'DATABASE_URL',
      'PAPERCUSP_PG_URL',
      'PAPERCUSP_PGBOUNCER',
      'PAPERCUSP_PGBOUNCER_PORT',
    ] as const;
    // Snapshot originals so we can restore EXACTLY — `env.X = undefined` coerces to
    // the STRING "undefined" (poisoning getHarnessAdminUrl for later tests), so an
    // originally-unset var must be `delete`-d, not assigned.
    const original = new Map(KEYS.map((k) => [k, env[k]]));
    const setOrDelete = (k: string, v: string | undefined) => {
      if (v === undefined) delete env[k];
      else env[k] = v;
    };
    afterAll(() => {
      for (const k of KEYS) setOrDelete(k, original.get(k));
      _resetHarnessAdminUrlCacheForTests();
    });

    it('stays the direct admin URL even when PAPERCUSP_PGBOUNCER=1', () => {
      env.HARNESS_ADMIN_DATABASE_URL = DIRECT;
      delete env.DATABASE_URL;
      delete env.PAPERCUSP_PG_URL;
      env.PAPERCUSP_PGBOUNCER = '1';
      env.PAPERCUSP_PGBOUNCER_PORT = '6432';
      _resetHarnessAdminUrlCacheForTests();

      const url = watchdogTickLockUrl();
      expect(url).toBe(DIRECT);
      // The whole point: NOT rerouted to the local pooler port.
      expect(url).not.toContain('6432');
      expect(url).not.toContain('127.0.0.1');
    });
  });

  // Close the dedicated tick-lock connection the default-path tests may have opened
  // (idle_timeout:0 singleton) so the suite leaves no open PG handle.
  afterAll(async () => {
    await _closeWatchdogTickLockForTests();
  });
});

// ── watchdog-audit-2026-06-09 coverage ───────────────────────────────────────

describe('partitionSignalsByKnownKeys — key pre-filter (audit P-004/P-005)', () => {
  const dup = (watchdogKey: string, state: string, updatedAt: string): WatchdogKeyDup => ({ watchdogKey, state, updatedAt });

  it('drops a signal whose key matches an OPEN improvement (already filed)', () => {
    const s = sig({ key: 'lib/a.test.ts' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'open', '2026-06-09T00:00:00Z')]);
    expect(out.knownOpen).toEqual([s]);
    expect(out.fresh).toEqual([]);
    expect(out.staleResolved).toEqual([]);
  });

  it('keeps an OPEN tool-failure probation observation fresh so the watchdog promotes it', () => {
    const s = sig({ source: 'repeated-tool-error', key: 'coord:send:caller:invalid-args-body' });
    const out = partitionSignalsByKnownKeys(
      [s],
      [{
        watchdogKey: 'repeated-tool-error:coord:send:caller:invalid-args-body',
        state: 'open',
        updatedAt: '2026-08-11T00:00:00Z',
        probation: true,
      }],
      ['repeated-tool-error:coord:send:caller:invalid-args-body'],
    );
    expect(out.fresh).toEqual([s]);
    expect(out.knownOpen).toEqual([]);
    expect(out.standing).toEqual([]);
  });

  it('drops a resolved-dup signal whose evidence pre-dates the resolution (D-002 — not a regression)', () => {
    const s = sig({ key: 'lib/a.test.ts', latestAt: '2026-06-08T00:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.staleResolved).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('re-files a resolved dup when the evidence POST-dates the resolution (real regression)', () => {
    const s = sig({ key: 'lib/a.test.ts', latestAt: '2026-06-09T12:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('red-test:lib/a.test.ts', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });

  it('a live-state signal (no latestAt) with only resolved dups re-files (the problem exists NOW)', () => {
    const s = sig({ key: 'vite', source: 'service-down' });
    const out = partitionSignalsByKnownKeys([s], [dup('service-down:vite', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });

  it('an OPEN match wins over resolved matches (knownOpen, never staleResolved)', () => {
    const s = sig({ key: 'x', latestAt: '2026-06-01T00:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [
      dup('red-test:x', 'resolved', '2026-06-09T00:00:00.000Z'),
      dup('red-test:x', 'open', '2026-06-02T00:00:00.000Z'),
    ]);
    expect(out.knownOpen).toEqual([s]);
  });

  it('no matching key → fresh', () => {
    const s = sig({ key: 'x' });
    expect(partitionSignalsByKnownKeys([s], [dup('red-test:other', 'open', '2026-06-09T00:00:00.000Z')]).fresh).toEqual([s]);
  });
});

describe('partitionSignalsByKnownKeys — resolution cooldown (EI-427 deploy-lag suppressor)', () => {
  const dup = (watchdogKey: string, state: string, updatedAt: string): WatchdogKeyDup => ({ watchdogKey, state, updatedAt });
  const COOLDOWN = 2 * 60 * 60 * 1000; // 2h

  it('suppresses a re-file when the fix resolved WITHIN the cooldown before the scan (still deploying)', () => {
    // latestAt (scan) is 1h after the resolution → without a cooldown this would
    // re-file as a "real regression"; the cooldown holds it for the deploy window.
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T01:00:00.000Z', resolutionCooldownMs: COOLDOWN });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.staleResolved).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('re-files once the resolution is OLDER than the cooldown (the fix genuinely never deployed)', () => {
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T05:00:00.000Z', resolutionCooldownMs: COOLDOWN });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]); // resolved 5h ago, past the 2h cooldown
  });

  it('cooldown is opt-in — a signal without resolutionCooldownMs still re-files on post-resolution evidence', () => {
    const s = sig({ key: 'dbos', source: 'insight-staleness', latestAt: '2026-06-09T01:00:00.000Z' });
    const out = partitionSignalsByKnownKeys([s], [dup('insight-staleness:dbos', 'resolved', '2026-06-09T00:00:00.000Z')]);
    expect(out.fresh).toEqual([s]);
  });
});

describe('runWatchdogTick — key pre-filter frees the capture budget (audit P-004)', () => {
  function captureRec() {
    const calls: Array<Record<string, unknown>> = [];
    let i = 0;
    const capture = (async (input: Record<string, unknown>) => {
      calls.push(input);
      return { ok: true, created: true, issue: { id: `EI-${++i}` } as never, possibleDuplicates: [] };
    }) as unknown as typeof import('./capture-core').captureImprovement;
    return { calls, capture };
  }

  it('known-open signals never consume capture slots; the fresh one lands; the record carries the keys', async () => {
    const { calls, capture } = captureRec();
    const records: WatchdogTickRecord[] = [];
    const known = [sig({ key: 'a' }), sig({ key: 'b' }), sig({ key: 'c' })];
    const fresh = sig({ key: 'new-one', source: 'repeated-tool-error', title: 'Tool new-one returns a structural error' });
    const res = await runTick('ws', {}, {
      collect: async () => [...known, fresh],
      capture,
      recordTick: async (r) => { records.push(r); },
      readRecentTicks: async () => [],
      readKeyDups: async () => known.map((s) => ({ watchdogKey: watchdogKeyOf(s), state: 'open', updatedAt: '2026-06-09T00:00:00.000Z' })),
      pruneTicks: noPrune,
      processAging: async () => [],
    });
    // OLD behavior: 3 known-open red-tests fill the cap and the fresh signal defers.
    // NEW: they are pre-filtered, the fresh signal captures, nothing is declined.
    expect(res.knownOpen).toBe(3);
    expect(res.declinedDuplicates).toBe(0);
    expect(res.captured).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(records[0].knownOpenKeys).toEqual(['red-test:a', 'red-test:b', 'red-test:c']);
  });

  it('captures carry watchdogKey + evidenceAt (the next tick pre-filters on them)', async () => {
    const { calls, capture } = captureRec();
    const s = sig({ key: 'lib/x.test.ts', latestAt: '2026-06-09T10:00:00.000Z' });
    await runTick('ws', {}, {
      collect: async () => [s],
      capture,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
    });
    expect(calls[0]).toMatchObject({ watchdogKey: 'red-test:lib/x.test.ts', evidenceAt: '2026-06-09T10:00:00.000Z' });
  });

  it('stale-resolved signals are dropped pre-plan and recorded (audit P-005)', async () => {
    const { calls, capture } = captureRec();
    const records: WatchdogTickRecord[] = [];
    const s = sig({ key: 'lib/x.test.ts', latestAt: '2026-06-08T00:00:00.000Z' });
    const res = await runTick('ws', {}, {
      collect: async () => [s],
      capture,
      recordTick: async (r) => { records.push(r); },
      readRecentTicks: async () => [],
      readKeyDups: async () => [{ watchdogKey: 'red-test:lib/x.test.ts', state: 'resolved', updatedAt: '2026-06-09T00:00:00.000Z' }],
      pruneTicks: noPrune,
    });
    expect(res.staleResolved).toBe(1);
    expect(calls).toHaveLength(0); // never even attempted — no wasted capture slot
    expect(records[0].staleResolvedKeys).toEqual(['red-test:lib/x.test.ts']);
  });

  it('a key-dup read failure degrades to the old behavior (everything planned, title net catches dups)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { calls, capture } = captureRec();
      const res = await runTick('ws', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: async () => { throw new Error('pg down'); },
        pruneTicks: noPrune,
      });
      expect(res.captured).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/key-dup pre-filter failed/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('runWatchdogTick — known-open aging wiring (consume-edges P-020 / EI-363)', () => {
  type AgingSeamInput = string | { key: string; evidence?: string | null };
  function knownOpenTick(processAging: (ws: string, knownOpen: readonly AgingSeamInput[], o: unknown) => Promise<{ issueId: string; watchdogKey: string; reescalation: boolean }[]>) {
    const known = [sig({ key: 'shop', source: 'service-down', title: 'Service shop is down' })];
    return runTick('ws', {}, {
      collect: async () => known,
      capture: (async () => ({ ok: true, created: true, issue: { id: 'EI-X' }, possibleDuplicates: [] })) as never,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: async () => [{ watchdogKey: 'service-down:shop', state: 'open', updatedAt: '2026-06-09T00:00:00.000Z' }],
      pruneTicks: noPrune,
      processAging: processAging as never,
    });
  }

  it('passes the known-open keys AND the re-measured body to the aging seam, and surfaces escalated ids', async () => {
    const seen: AgingSeamInput[][] = [];
    const res = await knownOpenTick(async (_ws, knownOpen) => {
      seen.push([...knownOpen]);
      return [{ issueId: 'EI-42', watchdogKey: 'service-down:shop', reescalation: false }];
    });
    // EI-19920080383279759: the seam receives the CURRENT signal body, not just
    // the key. A known-open signal declines its capture, so this is the only
    // path by which live evidence can reach an escalation — asserting the key
    // alone is what let the body silently fossilize.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    const passed = seen[0][0];
    // Narrow rather than cast: a bare string here is precisely the regression
    // (the key-only form), so it must FAIL loudly, not be asserted away.
    expect(typeof passed).toBe('object');
    if (typeof passed === 'string') throw new Error(`aging seam got a bare key, not {key,evidence}: ${passed}`);
    expect(passed.key).toBe('service-down:shop');
    expect(passed.evidence).toBeTruthy();
    expect(res.agingEscalations).toEqual(['EI-42']);
  });

  it('an aging failure is logged but never aborts the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await knownOpenTick(async () => { throw new Error('pg hiccup'); });
      expect(res.status).toBe('ran');
      expect(res.agingEscalations).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/known-open aging failed/));
    } finally {
      warn.mockRestore();
    }
  });

  it('a tick with NO known-open signals never invokes aging (zero extra reads when quiet)', async () => {
    const processAging = vi.fn(async () => []);
    const res = await runTick('ws', {}, {
      collect: async () => [sig({ key: 'fresh-one' })],
      capture: (async () => ({ ok: true, created: true, issue: { id: 'EI-1' }, possibleDuplicates: [] })) as never,
      recordTick: async () => {},
      readRecentTicks: async () => [],
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
      processAging,
    });
    expect(processAging).not.toHaveBeenCalled();
    expect(res.agingEscalations).toEqual([]);
  });
});

describe('expiredLeaseSignalsFromRows — recency window (audit P-006)', () => {
  const now = Date.parse('2026-06-09T12:00:00.000Z');
  const daysAgo = (d: number): string => new Date(now - d * 86_400_000).toISOString();

  it('counts only leases expired within the window; ancient ones no longer fire forever', () => {
    const ancient = Array.from({ length: 42 }, () => ({ expires_ts: daysAgo(30) }));
    expect(expiredLeaseSignalsFromRows(ancient, { windowDays: 7, minCount: 15, nowMs: now })).toEqual([]);
  });

  it('fires at the threshold within the window, with latestAt = the newest expiry', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ expires_ts: daysAgo(i % 6) }));
    const out = expiredLeaseSignalsFromRows(rows, { windowDays: 7, minCount: 15, nowMs: now });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('expired-leases');
    expect(out[0].latestAt).toBe(daysAgo(0));
    expect(out[0].body).toContain('within the last 7d');
  });

  it('boundary: a lease expired exactly at the window edge counts; one just past it does not', () => {
    const edge = Array.from({ length: 15 }, () => ({ expires_ts: daysAgo(7) }));
    expect(expiredLeaseSignalsFromRows(edge, { windowDays: 7, minCount: 15, nowMs: now })).toHaveLength(1);
    const past = Array.from({ length: 15 }, () => ({ expires_ts: new Date(now - 7 * 86_400_000 - 1).toISOString() }));
    expect(expiredLeaseSignalsFromRows(past, { windowDays: 7, minCount: 15, nowMs: now })).toEqual([]);
  });
});

describe('smokeFailSignalsFromRows — recency gate via mtime_ms (audit P-007)', () => {
  const now = Date.parse('2026-06-09T12:00:00.000Z');
  const hoursAgoMs = (h: number): number => now - h * 3_600_000;

  it('a failure recorded within the gate fires, with latestAt from mtime_ms', () => {
    const out = smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: hoursAgoMs(2) }],
      { recentHours: 48, nowMs: now },
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('papercup');
    expect(out[0].latestAt).toBe(new Date(hoursAgoMs(2)).toISOString());
    // P-032: a smoke fail is attributable to ONE harness → harness-scoped origin.
    expect(out[0].scope).toBe('harness:papercup');
  });

  it('a weeks-old failing smoke does NOT fire (no more monthly re-files forever)', () => {
    expect(smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: hoursAgoMs(24 * 21) }],
      { recentHours: 48, nowMs: now },
    )).toEqual([]);
  });

  it('a row with NO mtime is treated as stale (cannot show the failure is current)', () => {
    expect(smokeFailSignalsFromRows(
      [{ harness_slug: 'papercup', failure_content: 'boom', mtime_ms: null }],
      { recentHours: 48, nowMs: now },
    )).toEqual([]);
  });

  it('boundary: exactly at the gate fires; one ms past it does not', () => {
    expect(smokeFailSignalsFromRows([{ harness_slug: 'p', failure_content: null, mtime_ms: hoursAgoMs(48) }], { recentHours: 48, nowMs: now })).toHaveLength(1);
    expect(smokeFailSignalsFromRows([{ harness_slug: 'p', failure_content: null, mtime_ms: hoursAgoMs(48) - 1 }], { recentHours: 48, nowMs: now })).toEqual([]);
  });
});

describe('per-signal ORIGIN scope tagging (per-hive-learning-loops P-032)', () => {
  // The per-hive improvement LENS (P-040) keys off each captured improvement's
  // origin scope, read back through readImprovementItems({ harnessSlug }) which
  // matches scope === `harness:<slug>`. So a harness-attributable signal MUST
  // carry its harness scope, and a genuinely workspace-global signal MUST stay
  // unscoped (→ 'operator' at the capture site) — NOT blanket-tagged.

  it('harness-attributable signals carry scope=harness:<slug>', () => {
    expect(
      smokeFailSignalsFromRows([{ harness_slug: 'sheets', failure_content: 'x', mtime_ms: Date.now() }])[0].scope,
    ).toBe('harness:sheets');
    expect(
      stuckPlanSignalsFromRows([{ harness_slug: 'docs', plan_slug: 'p', status: 'started', stale_hours: 30 }])[0].scope,
    ).toBe('harness:docs');
    expect(
      escalationSignalsFromRows([{ harness_slug: 'mail', phase: null }])[0].scope,
    ).toBe('harness:mail');
    expect(
      circuitOpenSignalsFromRows([{ harness_slug: 'calendar', role: 'director', consecutive_errors: 6, last_status: null }])[0].scope,
    ).toBe('harness:calendar');
    expect(
      stalledFeatureSignalsFromRows([{ harness_slug: 'forms', feature_id: 'F-1', updated_ts: Date.now() - 30 * 3_600_000 }])[0].scope,
    ).toBe('harness:forms');
  });

  it('genuinely workspace-global signals stay UNSCOPED (→ operator at capture), not blanket-tagged', () => {
    // service-down: a workspace-wide dev endpoint.
    expect(
      collectServiceDownSignals([{ name: 'sidecar', up: false } as ProbeResult])[0].scope,
    ).toBeUndefined();
    // routine-failure: a system background routine, not one harness.
    expect(
      routineFailureSignalsFromRows([{ name: 'git-sync', last_error: 'push rejected' }])[0].scope,
    ).toBeUndefined();
    // failed-spawn: a workspace aggregate keyed by dominant cause class.
    const spawnRows = Array.from({ length: 6 }, () => ({ error_message: 'timed out', started_at: new Date() }));
    expect(failedSpawnSignalsFromRows(spawnRows, { minCount: 5 })[0].scope).toBeUndefined();
    // red-test: box-global (test_runs has no workspace/harness column).
    expect(
      redTestSignalsFromRows([{ file_path: 'packages/x/a.test.ts', framework: 'vitest', fails: 5, sample: null }], 6)[0].scope,
    ).toBeUndefined();
  });

  it('the capture site resolves a harness signal to its scope and an unscoped one to operator', async () => {
    const calls: unknown[] = [];
    const capture = (async (input: unknown): Promise<CaptureImprovementResult> => {
      calls.push(input);
      return { ok: true, created: true, issue: { id: `EI-${calls.length}` }, possibleDuplicates: [] } as unknown as CaptureImprovementResult;
    }) as typeof import('./capture-core').captureImprovement;
    const harnessSig = smokeFailSignalsFromRows([{ harness_slug: 'sheets', failure_content: 'x', mtime_ms: Date.now() }]);
    const globalSig = collectServiceDownSignals([{ name: 'sidecar', up: false } as ProbeResult]);
    await runTick('ws', { maxPerTick: 5 }, {
      readKeyDups: noKeyDups, pruneTicks: noPrune,
      collect: async () => [...harnessSig, ...globalSig],
      capture, recordTick: async () => {},
    });
    const scopes = calls.map((c) => (c as { scope?: string }).scope).sort();
    expect(scopes).toEqual(['harness:sheets', 'operator']);
  });
});

describe('failed-spawn dominant-class identity (audit P-008)', () => {
  it('classifySpawnError buckets the common failure shapes', () => {
    expect(classifySpawnError('spawn timed out after 280s')).toBe('timeout');
    expect(classifySpawnError('connect ECONNREFUSED 127.0.0.1:3070')).toBe('network');
    expect(classifySpawnError('401 unauthorized: bad api key')).toBe('auth');
    expect(classifySpawnError('ENOENT: no such file or directory')).toBe('missing-file');
    expect(classifySpawnError('invalid spawn config: missing role')).toBe('config');
    expect(classifySpawnError('Autocompact is thrashing: the context window is already full')).toBe('context-overflow');
    expect(classifySpawnError('something else entirely')).toBe('other');
    expect(classifySpawnError(null)).toBe('other');
  });

  // EI-5485: an admission-ceiling rejection is expected D-004 backpressure (await spawn-slot:freed +
  // retry), recorded as a `failed` row for durability — NOT a spawn failure. It must classify as
  // 'backpressure', not 'other', so it can be excluded from the failed-spawn signal.
  it('classifies the admission-ceiling rejection as backpressure, not a failure', () => {
    const ceilingMsg =
      'spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees). ' +
      'Do not drop or busy-wait: events:await { event: "spawn-slot:freed:papercusp-workspace" }, ' +
      'end your turn, and retry this spawn on wake (a slot-free wakes you) — or fleet:cancel one.';
    expect(classifySpawnError(ceilingMsg)).toBe('backpressure');
    expect(classifySpawnError('spawn rejected: 16 spawns already running (fleet ceiling 16 — maxSimultaneousAgents).')).toBe('backpressure');
  });

  it('EXCLUDES admission-ceiling backpressure rows from the failed-spawn signal (EI-5485)', () => {
    const ceiling = (slot: number) => ({
      error_message:
        `spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees). ` +
        `events:await { event: "spawn-slot:freed:papercusp-workspace" } — slot ${slot}`,
      started_at: '2026-06-30T16:00:00.000Z',
    });
    // 57 ceiling rejections + 4 timeouts + 4 config: only the 8 genuine failures should count.
    const rows = [
      ...Array.from({ length: 57 }, (_, i) => ceiling(i)),
      ...Array.from({ length: 4 }, () => ({ error_message: 'spawn timed out after 280s', started_at: '2026-06-30T15:00:00.000Z' })),
      ...Array.from({ length: 4 }, () => ({ error_message: 'invalid spawn config', started_at: '2026-06-30T14:00:00.000Z' })),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Dominant of the GENUINE failures is timeout (4), not the ceiling backpressure (57).
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].title).toContain('(timeout)');
    expect(out[0].body).not.toContain('backpressure');
    // Count reflects only the 8 real failures, not the 65 total rows.
    expect(out[0].body).toContain('8 agent spawn(s) failed');
    expect(out[0].body).toContain('timeout: 4');
    expect(out[0].body).toContain('config: 4');
  });

  // EI-6018: a fleet infra-reclaim (boot reconcile EI-2186 / orphan sweep EI-85 / wedge reaper
  // WI-233) settles a `running` row `failed` to FREE the concurrency ceiling — expected
  // housekeeping, NOT a spawn failure. All such messages are `reclaimed`-prefixed and must
  // classify as 'reclaimed', not 'other'.
  it('classifies fleet infra-reclaim rows as reclaimed, not a failure (EI-6018)', () => {
    expect(classifySpawnError(
      'reclaimed at operator boot: launched by a prior incarnation on host-A ' +
      '(host/process restarted before its admission-release ran) — stale spawn-ceiling debit ' +
      'freed by the boot reconcile (EI-2186)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      'reclaimed: launched by a prior operator incarnation (boot-id mismatch on host-A) — ' +
      'host restarted, concurrency ceiling freed by the reclaim sweep (EI-2186)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      'reclaimed: child process (pid 4242) confirmed dead on host-A — concurrency ceiling freed ' +
      'by the P-011 reclaim sweep (EI-85)',
    )).toBe('reclaimed');
    expect(classifySpawnError(
      "reclaimed: spawn heartbeat stale > 300s (launching operator host presumed dead) — " +
      'concurrency ceiling freed by the P-011 reclaim sweep',
    )).toBe('reclaimed');
  });

  // EI-8890: a not-fully-pinned test-isolation leak occasionally lets a real run of
  // packages/operator-core/lib/endpoint-route/__tests__/agent-chats-messages.test.ts write a
  // LIVE row to harness_shared.spawned_agents (harness_slug='test-harness') carrying its
  // hardcoded fixture error string. This is a MITIGATION (hide the test debris from the
  // watchdog) — not the underlying fix, which remains open — but it must stop this exact
  // fixture identity from re-triggering the signal, while a genuine failure on a REAL harness
  // in the same window still fires normally.
  it('EXCLUDES the test-harness fixture-leak rows from the failed-spawn signal (EI-8890 mitigation)', () => {
    const leaked = (i: number) => ({
      error_message: `anthropic-direct: rate-limited — paused until 2026-06-14T08:50:00.000Z (${i})`,
      started_at: '2026-07-09T20:00:00.000Z',
      harness_slug: 'test-harness',
      workspace_id: 'default',
    });
    // 10 leaked test-fixture rows + 5 genuine timeouts on a real harness: only the 5
    // genuine failures should count, and they must dominate (not be swamped by the leak).
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => leaked(i)),
      ...Array.from({ length: 5 }, () => ({
        error_message: 'spawn timed out after 280s',
        started_at: '2026-07-09T19:00:00.000Z',
        harness_slug: 'papercusp',
        workspace_id: 'papercusp-workspace',
      })),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].body).toContain('5 agent spawn(s) failed');
    expect(out[0].body).not.toContain('rate-limited');
  });

  it('does not fire at all when the ONLY failures in the window are test-harness fixture leaks (EI-8890)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      error_message: `anthropic-direct: rate-limited — paused until 2026-06-14T08:50:00.000Z (${i})`,
      started_at: '2026-07-09T20:00:00.000Z',
      harness_slug: 'test-harness',
      workspace_id: 'default',
    }));
    expect(failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 })).toEqual([]);
  });

  // EI-7520: EVERY no-turn diagnostic (invoke-outcome.ts `agentProducedTurn`) embeds a
  // literal `timedOut=<bool>` token. The generic `timed?\s*out` alternative matched the
  // camelCase substring `timedOut`, so a `timedOut=false` gateway-stall / infra_loss death
  // (NOT a timeout) was mis-bucketed as 'timeout' — inflating the class and conflating it
  // with real wall-clock timeouts. `=true` is a genuine kill → timeout; `=false` is not.
  it('does NOT bucket a `timedOut=false` infra_loss as timeout (EI-7520 false-positive)', () => {
    // The real shape recorded by agentProducedTurn for a mid-turn gateway stall: the
    // detail carries `timedOut=false` but the death is not a timeout at all.
    const infraLossFalse =
      'infra_loss: papercusp/doc-steward returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=1, timedOut=false, outLen=257; rawStdoutTail="PG bootstrap: connected; ' +
      'orchestrator running with ctx.pg active; prompt-budget role=doc-steward feature=- total=52758")';
    expect(classifySpawnError(infraLossFalse)).not.toBe('timeout');
    // EI-8667: a `timedOut=false` infra_loss no-turn death is now its OWN diagnosable class
    // (infra-loss), not the generic 'other' bucket. The EI-7520 guarantee (NOT timeout) holds.
    expect(classifySpawnError(infraLossFalse)).toBe('infra-loss');
    // A `timedOut=true` IS a genuine wall-clock kill → timeout (the diagnostic token is a
    // positive signal here, so the fix must keep classifying it).
    const infraLossTrue =
      'infra_loss: quartermaster-hive/release-fixer returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=143, timedOut=true, outLen=0; rawStdoutTail="invoke-once: received termination signal")';
    expect(classifySpawnError(infraLossTrue)).toBe('timeout');
    // Genuine timeout PHRASES still classify as timeout (the fix must not regress them).
    expect(classifySpawnError('spawn timed out after 280s')).toBe('timeout');
    expect(classifySpawnError('agent invoke timeout exceeded (900s)')).toBe('timeout');
  });

  // EI-7520: a storm of `timedOut=false` infra_loss deaths must NOT masquerade as a
  // 'timeout' dominant class — the whole point of keying by cause is to keep a
  // gateway-stall storm distinguishable from a real wall-clock-timeout storm.
  it('does not let `timedOut=false` infra_loss inflate the timeout class (EI-7520)', () => {
    const infraLoss = (i: number) => ({
      error_message:
        'infra_loss: papercusp/doc-steward returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=1, timedOut=false, outLen=257; rawStdoutTail="run ${i}")`,
      started_at: '2026-07-05T08:00:00.000Z',
    });
    const realTimeout = (i: number) => ({
      error_message:
        'infra_loss: quartermaster-hive/release-fixer returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=143, timedOut=true, outLen=0; rawStdoutTail="termination signal ${i}")`,
      started_at: '2026-07-05T07:00:00.000Z',
    });
    // 8 gateway-stall (timedOut=false) + 5 genuine timeouts (timedOut=true).
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => infraLoss(i)),
      ...Array.from({ length: 5 }, (_, i) => realTimeout(i)),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Only the 5 genuine `timedOut=true` deaths are 'timeout'; the 8 `=false` no-turn deaths
    // are 'infra-loss' (EI-8667 — their own class, no longer the generic 'other').
    expect(out[0].body).toContain('timeout: 5');
    expect(out[0].body).toContain('infra-loss: 8');
    // Dominant is 'infra-loss' (the gateway-stall storm), NOT a phantom 'timeout: 13'.
    expect(out[0].key).toBe('failed-spawns:infra-loss');
  });

  // EI-8667: the exact failure that re-filed "Agent spawns are failing repeatedly (other)":
  // an invoke-outcome `infra_loss` no-turn death carrying `API Error: Request rejected` in its
  // rawStdoutTail. With timedOut=false it matched no specific rule and landed in 'other',
  // conflating an upstream gateway/API rejection with genuinely-unknown failures. It must now
  // classify as its own diagnosable class, 'infra-loss'.
  it('classifies an infra_loss no-turn / API-error death as infra-loss, not other (EI-8667)', () => {
    // The verbatim EI-8667 sample (the `release-fixer` death, rawStdoutTail cut at the API error).
    const apiRejected =
      'infra_loss: papercusp/release-fixer returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=1, timedOut=false, outLen=112; rawStdoutTail="[2026-07-08T03:43:39.747Z] ' +
      'PG bootstrap: connected (search_path=harness_papercusp,harness_shared,public); orchestrator ' +
      'running with ctx.pg active [2026-07-08T03:43:42.026Z] invoke release-fixer rc=1 API Error: Request rejected")';
    expect(classifySpawnError(apiRejected)).toBe('infra-loss');
    // A bare `API Error: Request rejected` (no infra_loss prefix / no-turn phrasing) still lands there.
    expect(classifySpawnError('spawn child rc=1 — API Error: Request rejected')).toBe('infra-loss');
    // The generic no-turn shape (any harness/role, no keyword tail) is infra-loss, not 'other'.
    expect(classifySpawnError(
      'infra_loss: dummy-pot-0707/release-fixer returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=1, timedOut=false, outLen=89; rawStdoutTail="prompt-budget role=release-fixer")',
    )).toBe('infra-loss');
    // Genuinely-unknown messages STILL fall to 'other' — the class is not swallowed.
    expect(classifySpawnError('something else entirely')).toBe('other');
    // A genuine wall-clock timeout (timedOut=true) still wins over infra-loss (EI-7520 preserved).
    expect(classifySpawnError(
      'infra_loss: papercusp/release-fixer returned HTTP 200 but the agent produced no turn ' +
      '(ok=false, exitCode=143, timedOut=true, outLen=0; rawStdoutTail="received termination signal")',
    )).toBe('timeout');
  });

  it('keys a storm of API-error / infra_loss no-turn deaths as failed-spawns:infra-loss (EI-8667)', () => {
    const apiError = (i: number) => ({
      error_message:
        'infra_loss: papercusp/release-fixer returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=1, timedOut=false, outLen=112; rawStdoutTail="invoke rc=1 API Error: Request rejected ${i}")`,
      started_at: '2026-07-08T03:00:00.000Z',
    });
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => apiError(i)),
      { error_message: 'spawn timed out after 280s', started_at: '2026-07-08T02:00:00.000Z' },
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('failed-spawns:infra-loss');
    expect(out[0].title).toContain('(infra-loss)');
    expect(out[0].body).toContain('infra-loss: 6');
    expect(out[0].body).not.toContain('other: 6');
  });

  it('classifies autocompaction-thrash no-turn deaths as context-overflow, not generic other (EI-8051)', () => {
    const contextOverflow = (i: number) => ({
      error_message:
        'infra_loss: papercusp/doc-steward returned HTTP 200 but the agent produced no turn ' +
        `(ok=false, exitCode=1, timedOut=false, outLen=257; rawStdoutTail="PG bootstrap: connected; ` +
        `orchestrator running with ctx.pg active; prompt-budget role=doc-steward feature=- total=53542; ` +
        `Autocompact is thrashing: the context window is already full (${i})")`,
      started_at: '2026-07-06T11:00:00.000Z',
    });
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => contextOverflow(i)),
      { error_message: 'connect ECONNREFUSED 127.0.0.1:3070', started_at: '2026-07-06T10:00:00.000Z' },
      { error_message: 'spawn timed out after 280s', started_at: '2026-07-06T09:00:00.000Z' },
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('failed-spawns:context-overflow');
    expect(out[0].title).toContain('(context-overflow)');
    expect(out[0].body).toContain('context-overflow: 6');
    expect(out[0].body).not.toContain('other: 6');
  });

  it('EXCLUDES fleet infra-reclaim rows from the failed-spawn signal (EI-6018)', () => {
    const reclaim = (i: number) => ({
      error_message:
        'reclaimed at operator boot: launched by a prior incarnation on host-A ' +
        `(host/process restarted before its admission-release ran) — freed by the boot reconcile (EI-2186) slot ${i}`,
      started_at: '2026-07-01T10:00:00.000Z',
    });
    // 15 boot-reclaim rows (the EI-6018 "other" phantom) + 4 timeouts + 4 network:
    // only the 8 genuine failures should count, and the reclaim rows must not be the dominant class.
    const rows = [
      ...Array.from({ length: 15 }, (_, i) => reclaim(i)),
      ...Array.from({ length: 4 }, () => ({ error_message: 'spawn timed out after 280s', started_at: '2026-07-01T09:00:00.000Z' })),
      ...Array.from({ length: 4 }, () => ({ error_message: 'connect ECONNREFUSED 127.0.0.1:3070', started_at: '2026-07-01T08:00:00.000Z' })),
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    // Dominant of the GENUINE failures is timeout (4), not the reclaim housekeeping (15).
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].body).not.toContain('reclaimed');
    // Count reflects only the 8 real failures, not the 23 total rows.
    expect(out[0].body).toContain('8 agent spawn(s) failed');
    expect(out[0].body).toContain('timeout: 4');
    expect(out[0].body).toContain('network: 4');
  });

  it('reclaim-only rows never fire (all reclaimed housekeeping, no genuine failures) (EI-6018)', () => {
    const rows = Array.from({ length: 30 }, () => ({
      error_message: 'reclaimed at operator boot: freed by the boot reconcile (EI-2186)',
      started_at: '2026-07-01T10:00:00.000Z',
    }));
    expect(failedSpawnSignalsFromRows(rows, { minCount: 5 })).toEqual([]);
  });

  it('ceiling-only rejections never fire (all backpressure, below the genuine-failure threshold)', () => {
    const rows = Array.from({ length: 30 }, () => ({
      error_message: 'spawn rejected: 3 bee spawns already running (fleet ceiling 3 — owner maxBees).',
      started_at: '2026-06-30T16:00:00.000Z',
    }));
    expect(failedSpawnSignalsFromRows(rows, { minCount: 5 })).toEqual([]);
  });

  it('keys by the DOMINANT class with the full breakdown in the body + latestAt', () => {
    const rows = [
      { error_message: 'timed out', started_at: '2026-06-09T10:00:00.000Z' },
      { error_message: 'timed out again', started_at: '2026-06-09T11:00:00.000Z' },
      { error_message: 'timeout', started_at: '2026-06-09T09:00:00.000Z' },
      { error_message: '401 unauthorized', started_at: '2026-06-09T08:00:00.000Z' },
      { error_message: 'ECONNREFUSED', started_at: '2026-06-09T07:00:00.000Z' },
    ];
    const out = failedSpawnSignalsFromRows(rows, { windowHours: 6, minCount: 5 });
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('failed-spawns:timeout');
    expect(out[0].title).toContain('(timeout)');
    expect(out[0].body).toContain('timeout: 3');
    expect(out[0].body).toContain('auth: 1');
    expect(out[0].latestAt).toBe('2026-06-09T11:00:00.000Z');
  });

  it('below the threshold → no signal', () => {
    expect(failedSpawnSignalsFromRows(
      [{ error_message: 'x', started_at: null }],
      { minCount: 5 },
    )).toEqual([]);
  });
});

describe('tick prune — retention is best-effort (audit P-009)', () => {
  it('prune runs after the tick with the retention default and an error never aborts the tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pruned: Array<[string, number]> = [];
      const okCapture = (async () => ({ ok: true, created: true, issue: { id: 'EI-1' } as never, possibleDuplicates: [] })) as unknown as typeof import('./capture-core').captureImprovement;
      const res = await runTick('ws', {}, {
        collect: async () => [sig({ key: 'a' })],
        capture: okCapture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: noKeyDups,
        pruneTicks: async (ws, days) => { pruned.push([ws, days]); },
      });
      expect(res.captured).toHaveLength(1);
      expect(pruned).toEqual([['ws', 14]]);

      const res2 = await runTick('ws', { tickRetentionDays: 7 }, {
        collect: async () => [],
        capture: okCapture,
        recordTick: async () => {},
        readRecentTicks: async () => [],
        readKeyDups: noKeyDups,
        pruneTicks: async () => { throw new Error('gc hiccup'); },
      });
      expect(res2.status).toBe('ran'); // prune failure swallowed
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/tick prune failed: gc hiccup/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('deferred boost survives a skipped tick (audit P-011)', () => {
  it('the contended deferred-keys read asks for the last RAN tick, not the last tick', async () => {
    let filterSeen: { status?: 'ran' | 'skipped' } | undefined;
    const okCapture = (async () => ({ ok: true, created: true, issue: { id: 'EI-1' } as never, possibleDuplicates: [] })) as unknown as typeof import('./capture-core').captureImprovement;
    await runTick('ws', { maxPerTick: 1 }, {
      collect: async () => [sig({ key: 'a' }), sig({ key: 'b' })], // contention → the read happens
      capture: okCapture,
      recordTick: async () => {},
      readRecentTicks: async (_ws, _n, filter) => {
        filterSeen = filter;
        return [{ status: 'ran', collectors: [], deferredKeys: [] }];
      },
      readKeyDups: noKeyDups,
      pruneTicks: noPrune,
    });
    expect(filterSeen).toEqual({ status: 'ran' });
  });
});

describe('watchdogOptionsFromPayload — routine-tunable bars (audit P-012)', () => {
  it('extracts whitelisted numeric keys, coercing numeric strings', () => {
    expect(watchdogOptionsFromPayload({
      maxPerTick: 5,
      transientMinCount: '20',
      smokeFailRecentHours: 24,
      notATunable: 99,
      structuralMinCount: 'not-a-number',
    })).toEqual({ maxPerTick: 5, transientMinCount: 20, smokeFailRecentHours: 24 });
  });

  it('null/undefined payload → empty options', () => {
    expect(watchdogOptionsFromPayload(null)).toEqual({});
    expect(watchdogOptionsFromPayload(undefined)).toEqual({});
  });
});

// ── EI-19363804802198172: the COMMIT dimension the wall-clock window flattens ──
describe('red-test commit context (EI-19363804802198172)', () => {
  const rows = (extra: Partial<Parameters<typeof redTestSignalsFromRows>[0][number]> = {}) => [
    {
      file_path: 'a.test.ts',
      framework: 'vitest',
      fails: 5,
      sample: 'boom',
      earliest_fail_at: '2026-08-02T17:38:34Z',
      latest_fail_at: '2026-08-02T18:00:05Z',
      ...extra,
    },
  ];

  it('renders the per-commit failure breakdown instead of a bare count', () => {
    const s = redTestSignalsFromRows(
      rows({ fail_shas: ['c8aac92703', 'c8aac92703', '1aa133bb11', 'c8aac92703', 'c8aac92703'] }),
      6,
    )[0];
    expect(s.body).toContain('Failures span 2 commits: c8aac92703 ×4, 1aa133bb11 ×1');
    expect(s.redTest?.failShas).toEqual(['c8aac92703', '1aa133bb11']);
  });

  it('says so explicitly when every failure is on ONE commit (a different situation entirely)', () => {
    const s = redTestSignalsFromRows(rows({ fail_shas: ['abc123', 'abc123'] }), 6)[0];
    expect(s.body).toContain('Failures all on ONE commit: abc123 ×2');
    expect(s.body).not.toContain('span');
  });

  it('surfaces the last PASS (sha + time) — the line that bounds the regression window', () => {
    const s = redTestSignalsFromRows(
      rows({ fail_shas: ['c8aac92703'], last_pass_sha: 'd384a993f3', last_pass_at: '2026-08-02T17:51:24Z' }),
      6,
    )[0];
    expect(s.body).toContain('Last PASS in window: 2026-08-02T17:51:24.000Z (d384a993f3)');
    expect(s.redTest?.lastPassSha).toBe('d384a993f3');
  });

  it('states plainly when the test never passed in the window (absence is evidence too)', () => {
    expect(redTestSignalsFromRows(rows({ fail_shas: ['abc123'] }), 6)[0].body).toContain(
      'Last PASS in window: none',
    );
  });

  it('degrades to the previous body when the aggregate carried no sha data at all', () => {
    const s = redTestSignalsFromRows(rows(), 6)[0];
    expect(s.body).toContain('failed 5× in the last 6h');
    expect(s.body).not.toContain('Failures');
    expect(s.redTest?.failShas).toEqual([]);
  });

  it('labels the failure tail as point-in-time evidence and requires a claim-time rerun', () => {
    const s = redTestSignalsFromRows(
      rows({ latest_fail_at: '2026-07-27T20:15:16.000Z', sample: "expected [ 'old-entry' ] to deeply equal []" }),
      6,
    )[0];
    expect(s.body).toContain('Failure tail AS OF 2026-07-27T20:15:16.000Z');
    expect(s.body).toContain('the specific failing assertion may have changed');
    expect(s.body).toContain('re-run this file before acting on the assertion below');
    expect(s.body).toContain("expected [ 'old-entry' ] to deeply equal []");
  });

  it('merges the commit dimension across the canonical + checkpoint trees', () => {
    const s = redTestSignalsFromRows(
      [
        { file_path: 'a.test.ts', framework: 'vitest', fails: 2, sample: 'boom', fail_shas: ['sha1', 'sha1'], last_pass_at: '2026-08-02T10:00:00Z', last_pass_sha: 'old' },
        { file_path: 'papercupai-workspace/papercup-checkpoint/a.test.ts', framework: 'vitest', fails: 1, sample: null, fail_shas: ['sha2'], last_pass_at: '2026-08-02T12:00:00Z', last_pass_sha: 'newer' },
      ],
      6,
    );
    expect(s).toHaveLength(1);
    expect(s[0].redTest?.failShas).toEqual(['sha1', 'sha2']);
    expect(s[0].redTest?.lastPassSha).toBe('newer'); // newest pass across trees wins
  });
});

// ── WI-10929: the SAME-SHA verdict flip the collector computed and threw away ──
describe('red-test SAME-SHA verdict flip (WI-10929)', () => {
  const rows = (extra: Partial<Parameters<typeof redTestSignalsFromRows>[0][number]> = {}) => [
    {
      file_path: 'a.test.ts',
      framework: 'vitest',
      fails: 5,
      sample: 'boom',
      earliest_fail_at: '2026-08-04T01:09:54Z',
      latest_fail_at: '2026-08-04T01:33:43Z',
      ...extra,
    },
  ];

  // The predicate, isolated. Both false cases matter: they are what stops the
  // flip line firing on an ordinary red, which is the only way this can do harm.
  it('the predicate is true only when the passing sha is itself one of the failing shas', () => {
    expect(hasSameShaVerdictFlip(['abc123', 'def456'], 'abc123')).toBe(true);
    expect(hasSameShaVerdictFlip(['abc123', 'def456'], 'zzz999')).toBe(false);
    expect(hasSameShaVerdictFlip(['abc123'], undefined)).toBe(false);
    expect(hasSameShaVerdictFlip([], 'abc123')).toBe(false);
  });

  it('THE POINT: a sha that both passed and failed is reported as disattributing, not as a regression', () => {
    // The measured shape behind this ticket: code-search-deps.test.ts recorded
    // fail·PASS·fail·fail·fail·fail inside 24 minutes, every run on ed37db59c8.
    // A commit that yields both verdicts cannot be the cause, so the one thing
    // the body must not do is send the reader to bisect it.
    const s = redTestSignalsFromRows(
      rows({
        fail_shas: ['ed37db59c8', 'ed37db59c8', 'ed37db59c8', 'ed37db59c8', 'ed37db59c8'],
        last_pass_sha: 'ed37db59c8',
        // WI-39890: the flip is now derived from the pass SET, so the fixture must carry it.
        // Faithful to the modelled shape — every run in the window was on ed37db59c8.
        pass_shas: ['ed37db59c8'],
        last_pass_at: '2026-08-04T01:10:41Z',
      }),
      6,
    )[0];
    expect(s.body).toContain('SAME-SHA VERDICT FLIP');
    expect(s.body).toContain('DO NOT BISECT');
    expect(s.body).toContain('WORKING TREE');
    expect(s.redTest?.sameShaFlip).toBe(true);
  });

  it('REPLACES the ancestry advice rather than appending to it — that advice is the misdirection', () => {
    // "check it against the failing shas ... a pass on a DESCENDANT sha means
    // the failures judged superseded code" asks a question whose answer here is
    // "same sha", which reads as inconclusive instead of decisive. Leaving both
    // lines in would preserve the exact wrong next action this fixes.
    const s = redTestSignalsFromRows(
      // WI-39890: pass_shas is what the flip is derived from now (see the fixture above).
      rows({ fail_shas: ['ed37db59c8'], last_pass_sha: 'ed37db59c8', pass_shas: ['ed37db59c8'], last_pass_at: '2026-08-04T01:10:41Z' }),
      6,
    )[0];
    expect(s.body).not.toContain('DESCENDANT');
    expect(s.body).not.toContain('before bisecting');
    // The pass is still reported — suppressing it would lose the evidence.
    expect(s.body).toContain('Last PASS in window: 2026-08-04T01:10:41.000Z (ed37db59c8)');
  });

  it('reports the pass/fail intersection SHA instead of attributing the flip to the newest pass', () => {
    const s = redTestSignalsFromRows(
      rows({
        fail_shas: ['dfa9f1289f'],
        pass_shas: ['dfa9f1289f', 'b87b04aab0'],
        last_pass_sha: 'b87b04aab0',
        last_pass_at: '2026-10-03T09:00:00Z',
      }),
      6,
    )[0];

    expect(s.body).toContain('Last PASS in window: 2026-10-03T09:00:00.000Z (b87b04aab0)');
    expect(s.body).toContain('SAME-SHA VERDICT FLIP: dfa9f1289f both PASSED and FAILED');
    expect(s.body).not.toContain('SAME-SHA VERDICT FLIP: b87b04aab0');
    expect(s.redTest?.sameShaFlipSha).toBe('dfa9f1289f');
  });

  it('CONTROL — a pass on a DIFFERENT sha keeps the ancestry line and is NOT flagged as a flip', () => {
    const s = redTestSignalsFromRows(
      rows({ fail_shas: ['ed37db59c8'], last_pass_sha: 'd384a993f3', last_pass_at: '2026-08-04T01:10:41Z' }),
      6,
    )[0];
    expect(s.body).not.toContain('SAME-SHA VERDICT FLIP');
    expect(s.body).toContain('a pass on a DESCENDANT sha means the failures judged superseded code');
    expect(s.redTest?.sameShaFlip).toBeUndefined();
  });

  it('CONTROL — a test that never passed in the window is NOT flagged as a flip', () => {
    const s = redTestSignalsFromRows(rows({ fail_shas: ['ed37db59c8', 'ed37db59c8'] }), 6)[0];
    expect(s.body).not.toContain('SAME-SHA VERDICT FLIP');
    expect(s.body).toContain('Last PASS in window: none');
    expect(s.redTest?.sameShaFlip).toBeUndefined();
  });

  it('does NOT suppress the signal — non-determinism is real and must still be filed', () => {
    // The flip changes what the filing SAYS, never whether it happens. A test
    // flipping verdicts on one commit is a genuine defect; dropping it here
    // would trade a misdirecting signal for a silent one.
    const s = redTestSignalsFromRows(
      rows({ fail_shas: ['ed37db59c8'], last_pass_sha: 'ed37db59c8', last_pass_at: '2026-08-04T01:10:41Z' }),
      6,
    );
    expect(s).toHaveLength(1);
    expect(s[0].severity).toBe('major');
    expect(s[0].body).toContain('failed 5× in the last 6h');
  });
});

describe('red-test supersession by a passing DESCENDANT (EI-19363804802198172)', () => {
  const sig = (redTest: NonNullable<WatchdogSignal['redTest']>): WatchdogSignal => ({
    source: 'red-test',
    key: 'a.test.ts',
    title: 'Test failing repeatedly: a.test.ts',
    body: 'boom',
    severity: 'major',
    paths: ['a.test.ts'],
    earliestAt: '2026-08-02T17:38:34.000Z',
    latestAt: '2026-08-02T18:00:05.000Z',
    redTest,
  });
  /** ancestry oracle: `parent` is an ancestor of everything in its list. */
  const ancestry = (map: Record<string, string[]>): GitAncestryCheck =>
    async (a, b) => (map[a] ?? []).includes(b);
  const keepAll: GitEditCheck = async () => false;

  it('drops the signal when EVERY failing sha is an ancestor of a sha that has since passed', async () => {
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['c8aac92703', '1aa133bb11'], passShas: ['d384a993f3'], lastPassSha: 'd384a993f3' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ c8aac92703: ['d384a993f3'], '1aa133bb11': ['d384a993f3'] }),
    );
    expect(kept).toEqual([]);
  });

  it('KEEPS the signal when even one failing sha is NOT superseded (partial ≠ moot)', async () => {
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['old', 'newer-than-the-pass'], passShas: ['p'], lastPassSha: 'p' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ old: ['p'] }), // 'newer-than-the-pass' is not an ancestor of the pass
    );
    expect(kept).toHaveLength(1);
  });

  it('KEEPS a genuine per-commit flake: the same sha both passed and failed', async () => {
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['abc'], passShas: ['abc'], lastPassSha: 'abc' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ abc: ['abc'] }),
    );
    expect(kept).toHaveLength(1);
  });

  // ---- WI-39890: the candidate set is EVERY pass in the window, not the newest ----

  it('suppresses off a NON-newest pass: the newest-by-clock pass is an ANCESTOR, an older one is the descendant', async () => {
    // The measured live case (2026-08-19). df89e330a7 failed 4×. The newest pass BY
    // WALL-CLOCK was 7481dd033e — committed three days EARLIER and an ANCESTOR of the
    // failing sha, so the old single-candidate rule found no supersession and filed
    // three `major` items for a test that had been green for 13h. But 2150d3573e, an
    // older-by-clock pass, IS a descendant and had passed this same test 37 minutes
    // BEFORE the first failure. Note the ancestry oracle deliberately does NOT relate
    // the fail sha to lastPassSha: if this ever regresses to reading lastPassSha, this
    // test fails rather than passing for the wrong reason.
    const kept = await debounceRedTestSignals(
      [
        sig({
          failShas: ['df89e330a7'],
          passShas: ['7481dd033e', '2150d3573e'],
          lastPassSha: '7481dd033e',
        }),
      ],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ df89e330a7: ['2150d3573e'] }),
    );
    expect(kept).toEqual([]);
  });

  it('CONTROL: the same signal is KEPT when that descendant is absent from the pass set', async () => {
    // Non-vacuity for the case above — it proves the suppression came from the extra
    // candidate and not from the ancestry oracle being permissive.
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['df89e330a7'], passShas: ['7481dd033e'], lastPassSha: '7481dd033e' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ df89e330a7: ['2150d3573e'] }),
    );
    expect(kept).toHaveLength(1);
  });

  it('a same-sha verdict flip ANYWHERE in the pass set keeps the signal, not just against the newest', async () => {
    // 'abc' failed and also passed earlier in the window, while a later pass 'z' is a
    // descendant. The flip makes the test non-deterministic, which is a real signal —
    // supersession must not swallow it just because 'z' happens to be newest.
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['abc'], passShas: ['z', 'abc'], lastPassSha: 'z' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ abc: ['z'] }),
    );
    expect(kept).toHaveLength(1);
  });

  it('this is ANCESTRY, not wall-clock: a fail timestamped AFTER the pass is still superseded', async () => {
    // The live case (pc-heavy.test.ts, EI-19365113150061623): the fix landed at
    // 17:42:57Z, a runner re-tested the STALE pre-fix sha at 18:00, and the pass on
    // the descendant sha was recorded at 17:51 — EARLIER than the failure. A
    // "last pass newer than last fail" rule reads that as still-red; ancestry does not.
    const kept = await debounceRedTestSignals(
      [
        {
          ...sig({
            failShas: ['c8aac92703'],
            passShas: ['d384a993f3'],
            lastPassSha: 'd384a993f3',
            lastPassAt: '2026-08-02T17:51:24.000Z',
          }),
          latestAt: '2026-08-02T18:00:05.000Z', // failure is NEWER than the pass
        },
      ],
      keepAll,
      undefined,
      undefined,
      undefined,
      ancestry({ c8aac92703: ['d384a993f3'] }),
    );
    expect(kept).toEqual([]);
  });

  it('fails OPEN — a throwing ancestry check never suppresses a real signal', async () => {
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['a'], passShas: ['p'], lastPassSha: 'p' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      async () => { throw new Error('git exploded'); },
    );
    expect(kept).toHaveLength(1);
  });

  it('fails OPEN per-candidate — one throwing candidate does not disqualify the others', async () => {
    // (WI-39890) The set walk must not let a single git hiccup abort the whole
    // candidate list: 'bad' throws, but 'good' still legitimately supersedes.
    const kept = await debounceRedTestSignals(
      [sig({ failShas: ['a'], passShas: ['bad', 'good'], lastPassSha: 'bad' })],
      keepAll,
      undefined,
      undefined,
      undefined,
      async (failSha, passSha) => {
        if (passSha === 'bad') throw new Error('git exploded');
        return failSha === 'a' && passSha === 'good';
      },
    );
    expect(kept).toEqual([]);
  });

  it('is inert when no ancestry check is wired, and when there is no passing sha', async () => {
    const noCheck = await debounceRedTestSignals(
      [sig({ failShas: ['a'], passShas: ['p'], lastPassSha: 'p' })],
      keepAll,
    );
    expect(noCheck).toHaveLength(1);
    // An EMPTY pass set is the "cannot show supersession" case — it must keep the
    // signal, never suppress it. (WI-39890: this is also the shape a producer that
    // does not populate pass_shas yields, so it is the fail-safe direction.)
    const noPass = await debounceRedTestSignals(
      [sig({ failShas: ['a'], passShas: [] })],
      keepAll, undefined, undefined, undefined, ancestry({ a: ['p'] }),
    );
    expect(noPass).toHaveLength(1);
  });
});

describe('latestAt plumbing (audit P-005)', () => {
  it('red-test merge keeps the NEWEST failure timestamp across trees', () => {
    const signals = redTestSignalsFromRows(
      [
        { file_path: 'apps/x.test.ts', framework: 'vitest', fails: 3, sample: 'boom', latest_fail_at: '2026-06-09T08:00:00.000Z' },
        { file_path: 'papercupai-workspace/papercup-checkpoint/apps/x.test.ts', framework: 'vitest', fails: 4, sample: null, latest_fail_at: '2026-06-09T11:00:00.000Z' },
      ],
      6,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].latestAt).toBe('2026-06-09T11:00:00.000Z');
  });

  it('tool-error signals carry latestAt from the newest failure row', () => {
    const signals = toolErrorSignalsFromRows([
      { tool_name: 'docs:get', class: 'structural' as const, n: 7, total: 7, sample: 'boom', latest_at: '2026-06-09T10:30:00.000Z' },
    ]);
    expect(signals[0].latestAt).toBe('2026-06-09T10:30:00.000Z');
  });
});

// ── EI-20847917368795366: the RE-FILE RATE LIMIT ─────────────────────────────
//
// The DELTA GATE below and this block encode OPPOSITE failure modes, and the whole
// difficulty of the fix is that satisfying either one alone re-creates the other:
//   • gate too weak  → 60 copies of one key in 7d (the incident it was built for);
//   • gate unbounded → a key firing every tick is suppressed FOREVER once nothing open
//     matches it (measured 2026-08-19: 11 keys standing with no item, 8 of them on all
//     48 ticks of a 12h window, incl. `ship-link-stuck:staging->main` while main WAS
//     frozen, and 4 that had never been filed even once).
// So the property under test is neither "suppresses" nor "re-files" but: SUPPRESSES BY
// DEFAULT, AND RELEASES EXACTLY ONE FILING once a measured, unbroken standing run crosses
// the window. The CONTROLs at the end are deliberately-wrong implementations kept
// PERMANENTLY here (CLAUDE.md tier 1 — the subject is imported, so falsifiability is
// proven in-file, never by mutating the shared tree). Each satisfies half the property and
// must FAIL, which is what proves these assertions can discriminate at all.

describe('computeRefileEligibleKeys — RE-FILE RATE LIMIT (EI-20847917368795366)', () => {
  const T0 = Date.parse('2026-08-19T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  /** A ran tick `hoursAgo` before T0 that suppressed `standingKeys`. */
  const tick = (hoursAgo: number, standingKeys: string[]): RecentTick => ({
    status: 'ran',
    collectors: [],
    tickAt: new Date(T0 - hoursAgo * HOUR).toISOString(),
    standingKeys,
  });
  const K = 'ship-link-stuck:staging->main';

  it('releases a key standing unbroken for longer than the window', () => {
    expect([...computeRefileEligibleKeys([tick(0.25, [K]), tick(6, [K]), tick(13, [K])], { nowMs: T0 })]).toEqual([K]);
  });

  it('holds a key whose standing run is younger than the window', () => {
    expect([...computeRefileEligibleKeys([tick(0.25, [K]), tick(6, [K])], { nowMs: T0 })]).toEqual([]);
  });

  it('RATE LIMIT: a broken run resets the clock, so one re-file cannot become a stream', () => {
    // The property that makes the escape hatch safe. Letting a key through means it is NOT
    // in that tick's standingKeys, so the run breaks and must rebuild from zero. Here the
    // 24h/30h ticks are individually old enough; the gap at 1h is what disqualifies.
    expect([...computeRefileEligibleKeys([tick(0.25, [K]), tick(1, []), tick(24, [K]), tick(30, [K])], { nowMs: T0 })]).toEqual([]);
  });

  it('a DEFERRED tick continues the run — the measure is "has not FILED", not "was suppressed"', () => {
    // planCap defaults to 3 and 6 keys were measured eligible at once, so a release the cap
    // swallows is the COMMON case, not a corner. If deferral broke the run, such a key would
    // pay another full window without ever filing — the exact shape that left 4 keys never
    // filed at all (deferred on their first tick, suppressed on every tick after).
    const deferredTick = (hoursAgo: number, keys: string[]): RecentTick => ({
      status: 'ran',
      collectors: [],
      tickAt: new Date(T0 - hoursAgo * HOUR).toISOString(),
      standingKeys: [],
      deferredKeys: keys,
    });
    const ticks = [tick(0.25, [K]), deferredTick(1, [K]), tick(13, [K])];
    expect([...computeRefileEligibleKeys(ticks, { nowMs: T0 })]).toEqual([K]);
  });

  it('but a tick where the key actually FILED still breaks the run (the bound holds)', () => {
    // The counterpart to the case above: filing is the ONLY thing that resets the clock, and
    // it must, or "one filing per window" degrades into one filing per tick.
    const filedTick = (hoursAgo: number): RecentTick => ({
      status: 'ran',
      collectors: [],
      tickAt: new Date(T0 - hoursAgo * HOUR).toISOString(),
      standingKeys: [],
      deferredKeys: [],
    });
    expect([...computeRefileEligibleKeys([tick(0.25, [K]), filedTick(1), tick(24, [K])], { nowMs: T0 })]).toEqual([]);
  });

  it('ignores a key not standing on the NEWEST tick (its episode already ended)', () => {
    expect([...computeRefileEligibleKeys([tick(0.25, []), tick(13, [K]), tick(26, [K])], { nowMs: T0 })]).toEqual([]);
  });

  it('scores each key independently within one history', () => {
    const other = 'routine-failure:routine:git-sync';
    expect([...computeRefileEligibleKeys([tick(0.25, [K, other]), tick(13, [K])], { nowMs: T0 })]).toEqual([K]);
  });

  it('FAILS CLOSED on absent/unusable history — the inverse of the delta gate’s fail-OPEN', () => {
    // Absence of evidence must never be read as evidence of a long blackout, or the rate
    // limit becomes a way to re-open the churn on exactly the rows carrying no data.
    expect([...computeRefileEligibleKeys([], { nowMs: T0 })]).toEqual([]);
    expect([...computeRefileEligibleKeys([{ status: 'ran', collectors: [] }], { nowMs: T0 })]).toEqual([]);
    const noStamp: RecentTick[] = [{ status: 'ran', collectors: [], standingKeys: [K] }];
    expect([...computeRefileEligibleKeys(noStamp, { nowMs: T0 })]).toEqual([]);
    const badStamp: RecentTick[] = [{ status: 'ran', collectors: [], standingKeys: [K], tickAt: 'not-a-date' }];
    expect([...computeRefileEligibleKeys(badStamp, { nowMs: T0 })]).toEqual([]);
    expect([...computeRefileEligibleKeys([tick(0.25, [K]), tick(13, [K])], { nowMs: Number.NaN })]).toEqual([]);
  });

  it('a bad stamp mid-run truncates the measured run rather than extending it', () => {
    const ticks: RecentTick[] = [
      tick(0.25, [K]),
      { status: 'ran', collectors: [], standingKeys: [K], tickAt: 'garbage' },
      tick(30, [K]),
    ];
    expect([...computeRefileEligibleKeys(ticks, { nowMs: T0 })]).toEqual([]);
  });

  it('honours an explicit refileAfterMs (the window is tunable, not fixed at the call site)', () => {
    const ticks = [tick(0.25, [K]), tick(2, [K])];
    expect([...computeRefileEligibleKeys(ticks, { nowMs: T0, refileAfterMs: HOUR })]).toEqual([K]);
    expect([...computeRefileEligibleKeys(ticks, { nowMs: T0, refileAfterMs: 8 * HOUR })]).toEqual([]);
  });

  it('the shipped default is 12h, and the history read can actually SPAN it', () => {
    expect(WATCHDOG_REFILE_AFTER_MS).toBe(12 * HOUR);
    // If the read horizon were narrower than the window, every run would look truncated and
    // the limit would silently never fire. 240 ran ticks covers 12h down to a 3-min cadence.
    expect(WATCHDOG_REFILE_HISTORY_LIMIT * 3 * 60 * 1000).toBeGreaterThanOrEqual(WATCHDOG_REFILE_AFTER_MS);
  });

  it('the gate consumes it: an eligible key falls through, an ineligible one stays suppressed', () => {
    // The live-state shape from the blackout: no latestAt, and no dup row to match on.
    const s = sig({ source: 'ship-link-stuck', key: 'staging->main' });
    const prior = ['ship-link-stuck:staging->main'];
    expect(partitionSignalsByKnownKeys([s], [], prior, new Set([K])).fresh).toEqual([s]);
    expect(partitionSignalsByKnownKeys([s], [], prior, new Set([K])).standing).toEqual([]);
    expect(partitionSignalsByKnownKeys([s], [], prior, new Set(['some-other-key'])).standing).toEqual([s]);
  });

  it('eligibility does NOT bypass knownOpen — an open item still absorbs the signal', () => {
    // Otherwise the hatch would double-file the very conditions that ARE tracked, and
    // known-open aging would stop receiving its keys.
    const s = sig({ source: 'service-down', key: 'desktop' });
    const open: WatchdogKeyDup = { watchdogKey: 'service-down:desktop', state: 'open', updatedAt: '2026-08-19T00:00:00.000Z' };
    const out = partitionSignalsByKnownKeys([s], [open], ['service-down:desktop'], new Set(['service-down:desktop']));
    expect(out.knownOpen).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('an eligible key still lands in staleResolved when its evidence pre-dates the fix', () => {
    // It falls through to the RESOLUTION CHECKS, not straight to `fresh` — so the hatch can
    // only ever add a filing the existing logic already agreed was warranted.
    const s = sig({ source: 'red-test', key: 'lib/a.test.ts', latestAt: '2026-08-18T00:00:00.000Z' });
    const resolved: WatchdogKeyDup = { watchdogKey: 'red-test:lib/a.test.ts', state: 'resolved', updatedAt: '2026-08-19T00:00:00.000Z' };
    const out = partitionSignalsByKnownKeys([s], [resolved], ['red-test:lib/a.test.ts'], new Set(['red-test:lib/a.test.ts']));
    expect(out.staleResolved).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  // ── CONTROLS (permanent, deliberately wrong) ───────────────────────────────

  /** CONTROL A: age of the OLDEST standing tick, ignoring whether the run was broken. */
  const controlA = (ticks: readonly RecentTick[], nowMs: number): Set<string> => {
    const out = new Set<string>();
    for (const key of ticks[0]?.standingKeys ?? []) {
      const oldest = [...ticks].reverse().find((t) => (t.standingKeys ?? []).includes(key));
      const ms = Date.parse(oldest?.tickAt ?? '');
      if (Number.isFinite(ms) && nowMs - ms >= WATCHDOG_REFILE_AFTER_MS) out.add(key);
    }
    return out;
  };

  it('CONTROL A — ignoring run breaks would re-open the churn this gate exists to stop', () => {
    // A key re-filed 1h ago (run broken) but standing for 24h+ before that: the real
    // function holds it, CONTROL A releases it AGAIN — i.e. one filing per tick, the storm.
    const ticks = [tick(0.25, [K]), tick(1, []), tick(24, [K]), tick(30, [K])];
    expect([...controlA(ticks, T0)]).toEqual([K]); // the wrong answer, pinned
    expect([...computeRefileEligibleKeys(ticks, { nowMs: T0 })]).toEqual([]);
  });

  it('CONTROL B — treating missing history as eligible would flip the fail-CLOSED rule', () => {
    const controlB = (ticks: readonly RecentTick[], nowMs: number): Set<string> => {
      const out = new Set<string>();
      for (const key of ticks[0]?.standingKeys ?? []) {
        const ms = Date.parse(ticks[ticks.length - 1]?.tickAt ?? '');
        if (!Number.isFinite(ms) || nowMs - ms >= WATCHDOG_REFILE_AFTER_MS) out.add(key); // fails OPEN
      }
      return out;
    };
    const noStamps: RecentTick[] = [{ status: 'ran', collectors: [], standingKeys: [K] }];
    expect([...controlB(noStamps, T0)]).toEqual([K]);
    expect([...computeRefileEligibleKeys(noStamps, { nowMs: T0 })]).toEqual([]);
  });

  it('CALIBRATION — the controls are near-misses, not strawmen: they agree on the plain case', () => {
    // If a control disagreed everywhere it would prove nothing about the SPECIFIC properties
    // above. On an unbroken, well-stamped, long-enough run both must give the same answer;
    // the disagreements pinned above are the entire delta.
    const plain = [tick(0.25, [K]), tick(13, [K])];
    expect([...computeRefileEligibleKeys(plain, { nowMs: T0 })]).toEqual([K]);
    expect([...controlA(plain, T0)]).toEqual([K]);
  });
});

describe('WIRING — the rate limit is reachable from a real tick (EI-20847917368795366)', () => {
  // A pure function nothing calls is a fix in name only, and this wiring is exactly what a
  // later refactor drops silently: the gate keeps its 3-arg overload, so deleting the 4th
  // argument leaves every behaviour test above GREEN while restoring the permanent blackout.
  // Source-pinned so that regression fails HERE rather than in production months later.
  const src = readFileSync(new URL('./watchdog.ts', import.meta.url), 'utf8');

  it('runWatchdogTickBody computes the eligible set and passes it INTO the gate', () => {
    expect(src).toMatch(/const refileEligible = computeRefileEligibleKeys\(recentTicks, \{ nowMs: Date\.now\(\) \}\)/);
    // BOTH call sites: the normal path and the dup-read-failure degradation path.
    expect(src.match(/partitionSignalsByKnownKeys\(signals, [^)]*refileEligible\)/g) ?? []).toHaveLength(2);
  });

  it('the tick-history read is wide enough to span the window', () => {
    // readRecentTicks(…, 1, …) would make the run measurement structurally impossible.
    expect(src).toMatch(/readRecentTicks\(workspaceId, WATCHDOG_REFILE_HISTORY_LIMIT, \{ status: 'ran' \}\)/);
  });

  it('the reader SELECTs the two columns the window is measured from', () => {
    expect(src).toMatch(/SELECT status, collectors, deferred_keys, seen_keys, tick_at, standing_keys/);
  });
});

// ── watchdog-churn-delta-gate-2026-07-25 ─────────────────────────────────────

describe('partitionSignalsByKnownKeys — DELTA GATE (P-003/D-001: standing ≠ new)', () => {
  const dup = (watchdogKey: string, state: string, updatedAt: string): WatchdogKeyDup => ({ watchdogKey, state, updatedAt });

  it('suppresses a signal whose key fired on the previous ran tick (the churn fix)', () => {
    // The exact live-state shape that minted 60 copies of one key: no `latestAt`, and the
    // prior item already retired by another subsystem, so NO dup row exists to match on.
    const s = sig({ source: 'stalled-claim', key: 'stalled-work-item-claims' });
    const out = partitionSignalsByKnownKeys([s], [], ['stalled-claim:stalled-work-item-claims']);
    expect(out.standing).toEqual([s]);
    expect(out.fresh).toEqual([]);
  });

  it('files a key that was NOT in the previous tick (absent→present is a real detection)', () => {
    const s = sig({ source: 'stalled-claim', key: 'stalled-work-item-claims' });
    const out = partitionSignalsByKnownKeys([s], [], ['service-down:desktop']);
    expect(out.fresh).toEqual([s]);
    expect(out.standing).toEqual([]);
  });

  it('fails OPEN when there is no prior tick (first run / pre-migration rows)', () => {
    const s = sig({ source: 'migration-drift', key: 'migration-drift' });
    expect(partitionSignalsByKnownKeys([s], []).fresh).toEqual([s]);
    expect(partitionSignalsByKnownKeys([s], [], []).fresh).toEqual([s]);
  });

  it('keeps knownOpen ahead of the delta gate so known-open AGING still gets its keys', () => {
    // A filed+open item must stay in knownOpen even while standing, or persistence stops
    // escalating (consume-edges P-020 / EI-363).
    const s = sig({ source: 'service-down', key: 'desktop' });
    const out = partitionSignalsByKnownKeys([s], [dup('service-down:desktop', 'open', '2026-07-25T00:00:00.000Z')], [
      'service-down:desktop',
    ]);
    expect(out.knownOpen).toEqual([s]);
    expect(out.standing).toEqual([]);
  });

  it('the delta gate covers the live-state hole the resolution checks structurally miss', () => {
    // Live-state collectors omit `latestAt`, so the resolved-dup guard is skipped entirely
    // and the signal used to fall through to `fresh` — re-filing every 15 min forever.
    const s = sig({ source: 'unresolved-escalation', key: 'escalation:papercusp:x' });
    const resolved = [dup('unresolved-escalation:escalation:papercusp:x', 'resolved', '2026-07-25T00:00:00.000Z')];
    expect(partitionSignalsByKnownKeys([s], resolved).fresh).toEqual([s]); // old behaviour
    expect(partitionSignalsByKnownKeys([s], resolved, ['unresolved-escalation:escalation:papercusp:x']).standing).toEqual([s]);
  });

  it('preserves origin-scoped matching (a drill signal is not absorbed by an organic row)', () => {
    const s = sig({ source: 'red-test', key: 'lib/a.test.ts', origin: 'drill' });
    const organicOpen: WatchdogKeyDup = {
      watchdogKey: 'red-test:lib/a.test.ts',
      state: 'open',
      updatedAt: '2026-07-25T00:00:00.000Z',
      signalOrigin: 'organic',
    };
    const out = partitionSignalsByKnownKeys([s], [organicOpen]);
    expect(out.knownOpen).toEqual([]);
    expect(out.fresh).toEqual([s]);
  });
});

describe('signal lanes — metric vs defect (P-005/P-006: stats are not improvements)', () => {
  it('classifies coordination/throughput measurements as metric (never file)', () => {
    for (const src of ['stalled-claim', 'unresolved-escalation', 'perf-regression', 'failed-spawn', 'escalation-spike']) {
      expect(signalLaneOf(src)).toBe('metric');
      expect(sourceFilesWorkItem(src)).toBe(false);
    }
  });

  it('classifies concrete named defects + live infra alerts as defect (still file)', () => {
    for (const src of ['red-test', 'smoke-fail', 'migration-drift', 'repeated-tool-error', 'service-down']) {
      expect(signalLaneOf(src)).toBe('defect');
      expect(sourceFilesWorkItem(src)).toBe(true);
    }
  });

  it('an UNKNOWN source fails open to defect (a new collector keeps filing until classified)', () => {
    expect(signalLaneOf('some-brand-new-collector')).toBe('defect');
    expect(sourceFilesWorkItem('some-brand-new-collector')).toBe(true);
  });

  // WI-38327: its nearest neighbours are metrics, so the classification is worth pinning.
  it('bridge-needs-owner-unalerted is a DEFECT, unlike the escalation MEASUREMENTS beside it', () => {
    expect(signalLaneOf('bridge-needs-owner-unalerted')).toBe('defect');
    expect(sourceFilesWorkItem('bridge-needs-owner-unalerted')).toBe(true);
    expect(signalLaneOf('unresolved-escalation')).toBe('metric');
  });
});

/**
 * WI-38327 — the recurrence guard for the github-bridge owner-gated egress block.
 * The invariant: needs_owner=true past the debounce ⇒ an owner-rail record exists.
 * Zero signals == satisfied.
 */
describe('bridge-needs-owner-unalerted (WI-38327 recurrence guard)', () => {
  const gated = (over: Partial<Parameters<typeof bridgeNeedsOwnerSignalsFromRows>[0][number]> = {}) => ({
    harness_slug: 'papercusp',
    cause: 'bridge-egress-unreachable',
    sweeps: 3,
    alerted: true,
    owner_alerted: true,
    ...over,
  });

  it('SATISFIED: an owner-gated block the owner rail has a record of yields no signal', () => {
    expect(bridgeNeedsOwnerSignalsFromRows([gated()])).toEqual([]);
  });

  it('VIOLATION: past the threshold with no owner-rail record — the ~26h/899-commit incident', () => {
    const signals = bridgeNeedsOwnerSignalsFromRows([gated({ owner_alerted: false })]);
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('bridge-needs-owner-unalerted');
    expect(signals[0].key).toBe('bridge-needs-owner:papercusp');
    expect(signals[0].severity).toBe('critical');
    expect(signals[0].scope).toBe('harness:papercusp');
    expect(signals[0].body).toContain(`${BRIDGE_NEEDS_OWNER_CONDITION_PREFIX}papercusp`);
  });

  it('the latch claiming alerted:true does NOT satisfy it — the writer persists intent, then delivers in a try/catch', () => {
    // The whole reason the falsifier is attention_notifications and not the latch.
    const signals = bridgeNeedsOwnerSignalsFromRows([gated({ alerted: true, owner_alerted: false })]);
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('swallowed its failure');
  });

  it('names the DECIDER when the latch never alerted despite passing the threshold', () => {
    const signals = bridgeNeedsOwnerSignalsFromRows([gated({ alerted: false, owner_alerted: false })]);
    expect(signals[0].body).toContain('decider itself is not firing');
  });

  it('DEBOUNCE: below the threshold is not yet a violation (a single non-transient blip)', () => {
    expect(bridgeNeedsOwnerSignalsFromRows([gated({ sweeps: 1, alerted: false, owner_alerted: false })])).toEqual([]);
  });

  it('FAILS CLOSED on an absent latch — the shape a regression that drops it would produce', () => {
    const signals = bridgeNeedsOwnerSignalsFromRows([
      gated({ sweeps: null, alerted: null, cause: null, owner_alerted: false }),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('latch fields are ABSENT');
  });

  it('accepts a string sweeps count (jsonb ->> always returns text)', () => {
    expect(bridgeNeedsOwnerSignalsFromRows([gated({ sweeps: '5', owner_alerted: false })])).toHaveLength(1);
    expect(bridgeNeedsOwnerSignalsFromRows([gated({ sweeps: '1', owner_alerted: false })])).toEqual([]);
  });

  it('CONTROL: an unparseable sweeps value is not silently read as past-threshold', () => {
    // Calibration for the two cases above — proves the filter reads the value rather
    // than passing everything non-null through.
    expect(bridgeNeedsOwnerSignalsFromRows([gated({ sweeps: 'lots', owner_alerted: false })])).toEqual([]);
  });

  it('is per-harness: two blocked hives yield two independently-keyed signals', () => {
    const signals = bridgeNeedsOwnerSignalsFromRows([
      gated({ harness_slug: 'papercusp', owner_alerted: false }),
      gated({ harness_slug: 'oddsmith-hive', owner_alerted: false }),
    ]);
    expect(signals.map((s) => s.key)).toEqual([
      'bridge-needs-owner:papercusp',
      'bridge-needs-owner:oddsmith-hive',
    ]);
  });

  it('is ephemeral-benchmark filtered like every other per-harness source (test debris is not an improvement)', () => {
    const [signal] = bridgeNeedsOwnerSignalsFromRows([gated({ harness_slug: 'xbench-throwaway', owner_alerted: false })]);
    expect(isEphemeralBenchmarkSignal(signal)).toBe(true);
  });
});

describe('collectSchemaObjectDriftSignals (WI-918476)', () => {
  const entry = (name: string, table = 't') => ({
    schema: 'harness_shared',
    name,
    table,
    definition: `CREATE INDEX ${name} ON harness_shared.${table} USING btree (c)`,
    constraintBacked: false,
  });
  type Entry = ReturnType<typeof entry>;
  const clean = {
    // Annotated: a bare `[]` here infers as never[], which then rejects every
    // override below with an unhelpful "not assignable to type 'never'".
    liveOnly: [] as Entry[],
    referenceOnly: [] as Entry[],
    definitionMismatch: [] as Array<{
      schema: string; name: string; table: string; reference: string; live: string;
    }>,
    schemasCompared: ['harness_shared'],
    schemasNotCompared: ['dbos'],
    liveIndexCount: 100,
    referenceIndexCount: 100,
  };
  const result = (drift: Partial<typeof clean>) => async () => ({
    drift: { ...clean, ...drift },
    unavailableReason: null,
    manifestGeneratedAt: '2026-08-29T00:00:00.000Z',
  });
  const noPending = async () => ({ missing: [] as string[] });

  it('says nothing when the live schema matches the migrations', async () => {
    expect(await collectSchemaObjectDriftSignals(result({}), noPending)).toEqual([]);
  });

  it('fires on an index that exists live but in no migration, and NAMES it', async () => {
    const [signal] = await collectSchemaObjectDriftSignals(
      result({ liveOnly: [entry('plugin_configs_plugin_idx', 'plugin_configs')] }),
      noPending,
    );
    expect(signal.source).toBe('schema-object-drift');
    expect(signal.severity).toBe('major'); // fidelity finding, not an outage
    expect(signal.body).toContain('plugin_configs_plugin_idx');
  });

  describe('referenceOnly is gated on whether any migration is still pending', () => {
    const missingIndex = result({ referenceOnly: [entry('test_runs_branch_idx', 'test_runs')] });

    it('FIRES when every migration has been applied — no ledger check can see this case', async () => {
      // The migration is recorded as applied and the index is still absent, so
      // migration-drift and schema-ahead-of-code are both silent by construction.
      const [signal] = await collectSchemaObjectDriftSignals(missingIndex, noPending);
      expect(signal?.body).toContain('test_runs_branch_idx');
    });

    it('STAYS QUIET while a migration is pending — that is migration-drift\'s finding, not this one', async () => {
      // The normal staging-ahead-of-release window. Firing here too is the
      // WI-6037 complaint: one unapplied migration consuming double claim capacity.
      expect(
        await collectSchemaObjectDriftSignals(missingIndex, async () => ({ missing: ['900-x.sql'] })),
      ).toEqual([]);
    });

    it('FAILS CLOSED when the pending-migration probe throws', async () => {
      // A missed finding recurs on the next tick; a source that fires on every
      // deploy window gets discounted, and then it protects nothing.
      expect(
        await collectSchemaObjectDriftSignals(missingIndex, async () => { throw new Error('pg down'); }),
      ).toEqual([]);
    });

    it('does not suppress liveOnly just because a migration is pending', async () => {
      // The gate is scoped to referenceOnly ONLY. An index that exists live and in
      // no migration is unaffected by anything the ledger is doing.
      const [signal] = await collectSchemaObjectDriftSignals(
        result({ liveOnly: [entry('hand_made_idx')], referenceOnly: [entry('test_runs_branch_idx')] }),
        async () => ({ missing: ['900-x.sql'] }),
      );
      expect(signal.body).toContain('hand_made_idx');
      expect(signal.body).not.toContain('test_runs_branch_idx');
    });
  });

  it('reports an UNGENERATED manifest as a finding rather than as a clean result', async () => {
    const [signal] = await collectSchemaObjectDriftSignals(
      async () => ({ drift: null, unavailableReason: 'the migration-derived index manifest is empty', manifestGeneratedAt: null }),
      noPending,
    );
    expect(signal.key).toBe('schema-object-drift-unavailable');
  });

  it('stays quiet when the LIVE census fails — unreachable is service-health\'s question', async () => {
    expect(
      await collectSchemaObjectDriftSignals(
        async () => ({ drift: null, unavailableReason: 'live index census failed: connection refused', manifestGeneratedAt: null }),
        noPending,
      ),
    ).toEqual([]);
  });

  it('is classed INFRA, so no auto-implement worker decides to DROP INDEX on the shared database', () => {
    expect(INFRA_SIGNAL_SOURCES).toContain('schema-object-drift');
  });

  it('is NOT auto-close eligible — it degrades quiet, so silence can mean "could not look"', () => {
    expect(AUTO_CLOSE_ELIGIBLE_SOURCES).not.toContain('schema-object-drift');
  });
});
