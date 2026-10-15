import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  frozenRepairRoundExecution,
  parseFrozenCandidateRepairQueue,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from './frozen-candidate-repair-queue';
import {
  classifyFixerDeath,
  DEFAULT_GATE_INVARIANT_THRESHOLDS as T,
  evaluateGateLiveInvariants,
  foldGateInvariants,
  GATE_INVARIANT_HEARTBEAT_MS,
  GATE_INVARIANT_NAMES,
  GATE_INVARIANT_ACCEPTANCE_WINDOW_MS,
  GATE_INVARIANT_ACCEPTANCE_GAP_MS,
  evaluateGateInvariantWindow,
  evaluateGateInvariantAlarmWindow,
  overallGateInvariantStatus,
  parseGateInvariantsState,
  resolveGateExecutorDrift,
  type GateInvariantName,
  type GateInvariantSnapshot,
} from './gate-live-invariants';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '4444444444444444444444444444444444444444';
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const TICK = 4 * MIN;

describe('original invariant breach filing history', () => {
  const name = 'no-verdict-rate' as const;
  function history(): PipelineEventWindowRead {
    return { status: 'complete', total: 3, reason: null, windowStartMs: T0, windowEndMs: T0 + 2 * TICK,
      rows: [0, 1, 2].map(i => ({ id: `alarm-event-${i}`, kind: 'gate_invariants',
        status: i < 2 ? 'breach' : 'pass', createdAtMs: T0 + i * TICK,
        detail: { evaluatedAtMs: T0 + i * TICK,
          results: GATE_INVARIANT_NAMES.map(n => ({ name: n, status: n === name && i < 2 ? 'breach' : 'pass', observed: 'original' })),
          alarmEpisodes: { version: 1, entries: i < 2 ? [{ name, sinceMs: T0, tickMs: TICK,
            filedItemId: i ? 'WI-original-alarm' : null, filedAtMs: i ? T0 + TICK : null }] : [] } } })) };
  }
  const entries = (h: PipelineEventWindowRead, i: number) =>
    (h.rows[i]!.detail.alarmEpisodes as { entries: Array<{ name: string; sinceMs: number; tickMs: number;
      filedItemId: string | null; filedAtMs: number | null }> }).entries;
  const check = (h: PipelineEventWindowRead, id = 'invariant-breach-filings-within-one-tick') =>
    evaluateGateInvariantAlarmWindow(h, h.windowEndMs).assertions.find(a => a.id === id)!.passed;

  it('accepts a completion at the frozen deadline and retains original event and episode identities', () => {
    const h = history(), result = evaluateGateInvariantAlarmWindow(h, h.windowEndMs);
    expect(result.assertions.every(a => a.passed)).toBe(true);
    expect(result.eventIds).toEqual(h.rows.map(row => row.id));
    expect(result.episodes).toEqual(entries(h, 1));
  });
  it('measures the awaited completion, not the earlier evaluation start', () => {
    const h = history();
    entries(h, 1)[0]!.filedAtMs! += 1;
    h.rows[1]!.createdAtMs += 1;
    expect(check(h, 'original-invariant-breach-filing-receipts')).toBe(true);
    expect(check(h)).toBe(false);
  });
  it('does not widen the original tick when a retry observes a slower cadence', () => {
    const h = history(); entries(h, 1)[0]!.tickMs *= 2;
    expect(check(h, 'original-invariant-breach-filing-receipts')).toBe(false);
  });
  it('does not accept an unfiled episode even if a later observation has recovered', () => {
    const h = history(); entries(h, 1)[0]!.filedItemId = null; entries(h, 1)[0]!.filedAtMs = null;
    expect(check(h)).toBe(false);
  });
  it('rejects legacy histories and a work-item id without its completion clock', () => {
    const legacy = history(); delete legacy.rows[0]!.detail.alarmEpisodes;
    expect(check(legacy)).toBe(false);
    const noClock = history(); entries(noClock, 1)[0]!.filedAtMs = null;
    expect(check(noClock)).toBe(false);
  });
  it('rejects missing or duplicated breach entries and partial invariant populations', () => {
    const missing = history(); entries(missing, 0).pop(); expect(check(missing)).toBe(false);
    const duplicate = history(); entries(duplicate, 0).push({ ...entries(duplicate, 0)[0]! }); expect(check(duplicate)).toBe(false);
    const partial = history(); (partial.rows[0]!.detail.results as unknown[]).pop(); expect(check(partial)).toBe(false);
  });
  it('rejects conflicting successful receipt identities and clocks', () => {
    const h = history(); h.rows.splice(2, 0, structuredClone(h.rows[1]!)); h.total!++;
    h.rows[2]!.id = 'conflicting-receipt'; entries(h, 2)[0]!.filedItemId = 'WI-different';
    expect(check(h)).toBe(false);
    entries(h, 2)[0]!.filedItemId = 'WI-original-alarm'; entries(h, 2)[0]!.filedAtMs!--;
    expect(check(h)).toBe(false);
  });
  it('rejects future, reversed and nonfinite receipt clocks', () => {
    for (const at of [NaN, Infinity, T0 - 1, T0 + 3 * TICK]) {
      const h = history(); entries(h, 1)[0]!.filedAtMs = at; expect(check(h)).toBe(false);
    }
    const h = history(); h.rows[1]!.detail.evaluatedAtMs = h.rows[1]!.createdAtMs + 1;
    expect(check(h)).toBe(false);
  });
  it.each(['capped', 'unavailable', 'invalid'] as const)('rejects a %s healthy subset', status => {
    const h = history(); h.status = status; expect(check(h)).toBe(false);
  });
  it('rejects count/identity mismatches, absent coverage and future windows', () => {
    const count = history(); count.total!++; expect(check(count)).toBe(false);
    const duplicate = history(); duplicate.rows[1]!.id = duplicate.rows[0]!.id; expect(check(duplicate)).toBe(false);
    const gap = history(); gap.windowEndMs += GATE_INVARIANT_ACCEPTANCE_GAP_MS + 1; expect(check(gap)).toBe(false);
    const left = history(); left.windowStartMs--; expect(check(left)).toBe(false);
    const future = history(); expect(evaluateGateInvariantAlarmWindow(future, future.windowEndMs - 1).assertions.every(a => a.passed)).toBe(false);
  });
  it('keeps separate breach episodes of the same invariant and rejects an empty population', () => {
    const h = history();
    h.rows[2]!.status = 'breach';
    (h.rows[2]!.detail.results as Array<{ name: string; status: string }>).find(r => r.name === name)!.status = 'breach';
    entries(h, 2).push({ name, sinceMs: T0 + 2 * TICK, tickMs: TICK, filedItemId: null, filedAtMs: null });
    expect(evaluateGateInvariantAlarmWindow(h, h.windowEndMs).episodes).toHaveLength(2);
    expect(check(h)).toBe(false);
    const empty = history(); empty.rows = []; empty.total = 0; expect(check(empty)).toBe(false);
  });
});

describe('seven-day original invariant history acceptance', () => {
  function history(): PipelineEventWindowRead {
    const rows = Array.from({ length: 169 }, (_, i) => ({
      id: `original-event-${i}`, kind: 'gate_invariants' as const, status: 'pass',
      createdAtMs: T0 + i * GATE_INVARIANT_HEARTBEAT_MS,
      detail: { results: GATE_INVARIANT_NAMES.map(name => ({ name, status: 'pass', observed: 'measured by original writer' })) },
    }));
    return { status: 'complete', total: rows.length, rows, reason: null,
      windowStartMs: T0, windowEndMs: T0 + GATE_INVARIANT_ACCEPTANCE_WINDOW_MS };
  }
  const verdict = (h: PipelineEventWindowRead, id: string) =>
    evaluateGateInvariantWindow(h, h.windowEndMs).assertions.find(assertion => assertion.id === id)!.passed;
  const results = (h: PipelineEventWindowRead, index: number) =>
    h.rows[index]!.detail.results as Array<{ name: string; status: string }>;

  it('accepts exactly seven complete days and preserves every original event identity', () => {
    const h = history();
    const result = evaluateGateInvariantWindow(h, h.windowEndMs);
    expect(result.assertions.every(assertion => assertion.passed)).toBe(true);
    expect(result.eventIds).toEqual(h.rows.map(row => row.id));
  });
  it('rejects a future seven-day endpoint even if input rows claim passes', () => {
    const h = history();
    expect(evaluateGateInvariantWindow(h, h.windowEndMs - 1).assertions.find(a => a.id === 'seven-day-invariant-window')!.passed).toBe(false);
  });
  it.each(['unknown', 'breach'])('rejects an interior %s even when both endpoints pass', status => {
    const h = history();
    results(h, 80)[0]!.status = status;
    expect(verdict(h, 'pass-only-invariant-history')).toBe(false);
  });
  it('rejects a recent pass, a short window and a missing left-boundary observation', () => {
    const h = history();
    h.rows = h.rows.slice(-1); h.total = 1;
    expect(verdict(h, 'hourly-invariant-history-coverage')).toBe(false);
    h.windowStartMs = h.windowEndMs - GATE_INVARIANT_HEARTBEAT_MS;
    expect(verdict(h, 'seven-day-invariant-window')).toBe(false);
  });
  it('rejects a silent interval and stale right boundary', () => {
    const h = history();
    h.rows.splice(80, 2); h.total = h.rows.length;
    expect(verdict(h, 'hourly-invariant-history-coverage')).toBe(false);
    const right = history();
    right.rows.splice(-2); right.total = right.rows.length;
    expect(verdict(right, 'hourly-invariant-history-coverage')).toBe(false);
  });
  it('allows only the existing lease slack at the hourly boundary', () => {
    const h = history();
    h.rows[0]!.createdAtMs = T0 - (GATE_INVARIANT_ACCEPTANCE_GAP_MS - GATE_INVARIANT_HEARTBEAT_MS);
    expect(verdict(h, 'hourly-invariant-history-coverage')).toBe(true);
    h.rows[0]!.createdAtMs -= 1;
    expect(verdict(h, 'hourly-invariant-history-coverage')).toBe(false);
  });
  it.each(['capped', 'unavailable', 'invalid'] as const)('rejects a %s read with a retained healthy subset', status => {
    const h = history(); h.status = status;
    expect(verdict(h, 'complete-invariant-population')).toBe(false);
    expect(verdict(h, 'pass-only-invariant-history')).toBe(false);
  });
  it('rejects a count mismatch, duplicate IDs and unnamed invariant results', () => {
    const h = history(); h.total! += 1;
    expect(verdict(h, 'complete-invariant-population')).toBe(false);
    const duplicate = history(); duplicate.rows[80]!.id = duplicate.rows[79]!.id;
    expect(verdict(duplicate, 'complete-invariant-population')).toBe(false);
    const missing = history(); results(missing, 80).pop();
    expect(verdict(missing, 'exact-seven-invariant-identities')).toBe(false);
    const renamed = history(); results(renamed, 80)[0]!.name = 'unrelated-invariant';
    expect(verdict(renamed, 'exact-seven-invariant-identities')).toBe(false);
  });
  it('rejects nonfinite and future historical clocks', () => {
    const h = history(); h.rows[80]!.createdAtMs = NaN;
    expect(verdict(h, 'hourly-invariant-history-coverage')).toBe(false);
    const future = history(); future.rows[80]!.createdAtMs = future.windowEndMs + 1;
    expect(verdict(future, 'hourly-invariant-history-coverage')).toBe(false);
  });
});

function queue(over: Partial<FrozenCandidateRepairQueue> = {}): FrozenCandidateRepairQueue {
  return { ...createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: ['lib/a.test.ts'], nowMs: T0 }), ...over };
}

function snap(over: Partial<GateInvariantSnapshot> = {}): GateInvariantSnapshot {
  return {
    nowMs: T0 + 10 * MIN,
    queueReadable: true,
    queue: null,
    fixerAlive: null,
    fireIntervalsMs: [TICK, TICK, TICK],
    checkpointStatuses: ['unchanged-since-verdict', 'advanced'],
    executor: { treeSha: 'abc1234567', driftPaths: [], oldestDriftCommitMs: null },
    fixerOutcomes: [{ status: 'done', reason: null }],
    ...over,
  };
}

const status = (s: GateInvariantSnapshot, name: GateInvariantName) =>
  evaluateGateLiveInvariants(s).find((r) => r.name === name)!;

function admission(over: Partial<FrozenRepairAdmission> = {}): FrozenRepairAdmission {
  return {
    atMs: T0 + MIN,
    actor: 'su-door',
    source: { ref: 'staging', sha: C1 },
    fromRepairHead: C,
    toRepairHead: C2,
    paths: ['lib/a.test.ts'],
    unchanged: [],
    blobs: { 'lib/a.test.ts': C1 },
    ...over,
  };
}

describe('healthy gate: every invariant that has evidence passes', () => {
  it('no open queue, verdicts flowing, executor current', () => {
    const results = evaluateGateLiveInvariants(snap());
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['fixer-spawn-latency', 'pass'],
      ['targeted-radius', 'pass'],
      ['admission-precheck', 'pass'],
      ['no-verdict-rate', 'pass'],
      ['round-idle-time', 'pass'],
      ['executor-freshness', 'pass'],
      ['fixer-outcome-mix', 'pass'],
    ]);
    expect(overallGateInvariantStatus(results)).toBe('pass');
  });
});

describe('fixer-outcome-mix (WI-10007488)', () => {
  // Reason strings copied verbatim (prefixes) from live spawned_agents rows, 2026-08..09.
  const BOOT_ID = 'reclaimed: launched by a prior operator incarnation (boot-id mismatch on main-server) — host restarted';
  const BOOT = 'reclaimed at operator boot: launched by a prior incarnation on main-server (host/process restarted';
  const DEAD = 'reclaimed: child process (pid 205258) confirmed dead on main-server — concurrency ceiling freed';
  const STALE = 'reclaimed: spawn heartbeat stale > 300s (launching operator host presumed dead)';
  const JAM = 'reclaimed: spawn-ceiling-jam — no stream activity for > 15min despite an apparently-fresh heartbeat';
  const INFRA = 'infra_loss: papercusp/release-fixer timed out before producing a turn';
  const failed = (reason: string | null) => ({ status: 'failed', reason });
  const done = { status: 'done', reason: null };
  const mix = (fixerOutcomes: GateInvariantSnapshot['fixerOutcomes']) => status(snap({ fixerOutcomes }), 'fixer-outcome-mix');

  it('classifies each recorded death by what was observed, never by a presumed killer', () => {
    expect(
      [BOOT_ID, BOOT, DEAD, STALE, JAM, INFRA, 'fetch failed (ECONNREFUSED)', null].map((r) => classifyFixerDeath(r)),
    ).toEqual(['launcher-restarted', 'launcher-restarted', 'child-dead', 'heartbeat-stale', 'silent-no-stream', 'infra-loss', 'other', 'no-reason']);
  });

  it('breaches on the live 2026-09 shape: most fixers die, and it names the dominant classes', () => {
    const r = mix([failed(DEAD), failed(DEAD), failed(BOOT), failed(JAM), done]);
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/^4\/5 release-fixers that ended in \d+m died \(1 finished\)/);
    expect(r.observed).toContain('child-dead×2');
  });

  it('does not page below the minimum death count, however bad the rate', () => {
    expect(mix([failed(DEAD), failed(DEAD)]).status).toBe('pass');
  });

  it('a rate of exactly the limit passes; one more death breaches', () => {
    expect(mix([failed(DEAD), failed(DEAD), failed(DEAD), done, done, done]).status).toBe('pass');
    expect(mix([failed(DEAD), failed(DEAD), failed(DEAD), failed(DEAD), done, done, done]).status).toBe('breach');
  });

  it('a deliberate cancel is an outcome but never a death', () => {
    const r = mix([failed(DEAD), failed(DEAD), failed(DEAD), { status: 'cancelled', reason: 'superseded' }, { status: 'cancelled', reason: 'x' }, done]);
    expect(r.status).toBe('pass');
    expect(r.observed).toMatch(/^3\/6 /);
  });

  it('an unrecognised failure reason still counts as a death', () => {
    expect(mix([failed('something new'), failed(null), failed('also new')]).status).toBe('breach');
  });

  it('an unreadable ledger is unknown, and an empty window passes with nothing to judge', () => {
    expect(mix(null)).toMatchObject({ status: 'unknown', observed: expect.stringMatching(/could not be read/) });
    expect(mix([])).toMatchObject({ status: 'pass', observed: expect.stringMatching(/no deaths to judge/) });
  });
});

describe('fixer-spawn-latency', () => {
  it('breaches when a red has waited longer than one measured tick plus grace with no fixer (the 2026-10-07/08 ~20h wait)', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    const r = status(snap({ queue: q, nowMs: T0 + 20 * 60 * MIN }), 'fixer-spawn-latency');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/no fixer dispatched/);
  });

  it('passes inside one tick plus grace', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    expect(status(snap({ queue: q, nowMs: T0 + TICK }), 'fixer-spawn-latency').status).toBe('pass');
  });

  it('uses the MEASURED tick, not the 60m default, when fires are recorded', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: null });
    const s = snap({ queue: q, nowMs: T0 + 30 * MIN });
    expect(status(s, 'fixer-spawn-latency').status).toBe('breach');
    expect(status({ ...s, fireIntervalsMs: [] }, 'fixer-spawn-latency').status).toBe('pass');
  });

  it('breaches when the assigned fixer is dead, and is unknown when liveness cannot be read', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: 'spawn-1', fixerSpawnedAtMs: T0 + MIN });
    expect(status(snap({ queue: q, fixerAlive: false }), 'fixer-spawn-latency').status).toBe('breach');
    expect(status(snap({ queue: q, fixerAlive: null }), 'fixer-spawn-latency').status).toBe('unknown');
    expect(status(snap({ queue: q, fixerAlive: true }), 'fixer-spawn-latency').status).toBe('pass');
  });

  it('breaches a live fixer that was dispatched too late after its red', () => {
    const q = queue({ phase: 'awaiting-fixer', fixerSpawnId: 'spawn-1', fixerSpawnedAtMs: T0 + 3 * 60 * MIN });
    const r = status(snap({ queue: q, fixerAlive: true, nowMs: T0 + 4 * 60 * MIN }), 'fixer-spawn-latency');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/dispatched 180m after the red/);
  });
});

describe('admission-precheck', () => {
  it('breaches when the newest admission on the lineage carries no pre-check record (the live 0/25 shape)', () => {
    const q = queue({ phase: 'ready-to-verify', admissions: [admission()] });
    const r = status(snap({ queue: q }), 'admission-precheck');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/no pre-check record/);
  });

  it('judges only the NEWEST admission, and ignores ones from before the queue opened', () => {
    const old = admission({ atMs: T0 - 5 * MIN });
    const bad = admission({ atMs: T0 + MIN, precheck: { ran: true, failing: ['lib/a.test.ts'], passing: [] } });
    const good = admission({ atMs: T0 + 2 * MIN, precheck: { ran: true, failing: [], passing: ['lib/a.test.ts'] } });
    expect(status(snap({ queue: queue({ admissions: [bad, good] }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [good, bad].reverse() }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [old] }) }), 'admission-precheck').status).toBe('pass');
    expect(status(snap({ queue: queue({ admissions: [good, admission({ atMs: T0 + 3 * MIN, precheck: bad.precheck })] }) }), 'admission-precheck').status).toBe('breach');
  });

  it('a skipped pre-check is a breach; nothing-to-run is a pass', () => {
    const skipped = admission({ precheck: { ran: false, reason: 'skipped', precheckReason: 'trust me' } });
    const nothing = admission({ precheck: { ran: false, reason: 'nothing-to-run' } });
    expect(status(snap({ queue: queue({ admissions: [skipped] }) }), 'admission-precheck').observed).toMatch(/skipped: trust me/);
    expect(status(snap({ queue: queue({ admissions: [skipped] }) }), 'admission-precheck').status).toBe('breach');
    expect(status(snap({ queue: queue({ admissions: [nothing] }) }), 'admission-precheck').status).toBe('pass');
  });
});

describe('no-verdict-rate', () => {
  it('breaches on the measured 2026-10-01..08 mix (memory-budget, qualification-conflict, error dominate)', () => {
    const statuses = [
      ...Array(51).fill('skipped-memory-budget'),
      ...Array(46).fill('skipped-qualification-conflict'),
      ...Array(18).fill('error'),
      ...Array(12).fill('repair-in-progress'),
      ...Array(8).fill('unchanged-since-verdict'),
      'advanced',
      'not-green',
      'not-green',
    ];
    const r = status(snap({ checkpointStatuses: statuses }), 'no-verdict-rate');
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/^115\/138 /);
    expect(r.observed).toMatch(/skipped-memory-budget×51/);
  });

  it('counts an UNRECOGNISED status as a failure, so a new failure mode cannot pass by being unknown', () => {
    const r = status(snap({ checkpointStatuses: ['brand-new-refusal', 'brand-new-refusal', 'brand-new-refusal'] }), 'no-verdict-rate');
    expect(r.status).toBe('breach');
  });

  it('a quiet healthy gate passes; an empty or unreadable window is unknown, not pass', () => {
    expect(status(snap({ checkpointStatuses: ['up-to-date', 'unchanged-since-verdict', 'error'] }), 'no-verdict-rate').status).toBe('pass');
    expect(status(snap({ checkpointStatuses: [] }), 'no-verdict-rate').status).toBe('unknown');
    expect(status(snap({ checkpointStatuses: null }), 'no-verdict-rate').status).toBe('unknown');
  });
});

describe('round-idle-time', () => {
  it('breaches when an admitted head waits past one tick for its verification run', () => {
    const q = queue({ phase: 'ready-to-verify', lastAdmittedAtMs: T0 + MIN });
    expect(status(snap({ queue: q, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('breach');
    const started = queue({ phase: 'ready-to-verify', lastAdmittedAtMs: T0 + MIN, lastResumeRunStartedAtMs: T0 + 2 * MIN });
    expect(status(snap({ queue: started, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('pass');
  });

  it('breaches a queue left ready-to-test past one tick', () => {
    const q = queue({ phase: 'ready-to-test', updatedAtMs: T0 });
    expect(status(snap({ queue: q, nowMs: T0 + 30 * MIN }), 'round-idle-time').status).toBe('breach');
  });
});

describe('executor-freshness', () => {
  it('breaches when committed gate code has waited past the grace for the executor to load it', () => {
    const s = snap({ executor: { treeSha: 'abc1234567', driftPaths: ['packages/operator-core/lib/release/x.ts'], oldestDriftCommitMs: T0 - 60 * MIN } });
    expect(status(s, 'executor-freshness').status).toBe('breach');
  });

  it('passes inside the grace; unresolvable drift is unknown, never pass', () => {
    const fresh = snap({ executor: { treeSha: 'abc1234567', driftPaths: ['packages/operator-core/lib/release/x.ts'], oldestDriftCommitMs: T0 } });
    expect(status(fresh, 'executor-freshness').status).toBe('pass');
    expect(status(snap({ executor: { treeSha: 'abc1234567', driftPaths: null, oldestDriftCommitMs: null } }), 'executor-freshness').status).toBe('unknown');
    expect(status(snap({ executor: null }), 'executor-freshness').status).toBe('unknown');
  });

  it('resolveGateExecutorDrift drops test files and degrades every git failure to null', async () => {
    const boot = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const git = async (args: string[]) => {
      if (args[0] === 'rev-parse') return args[2]?.startsWith('HEAD') ? head : boot;
      if (args[0] === 'diff') return 'packages/operator-core/lib/release/x.ts\npackages/operator-core/lib/release/x.test.ts\n';
      if (args[0] === 'log') return '1800000000\n1799990000\n';
      throw new Error('unexpected');
    };
    expect(await resolveGateExecutorDrift('abc1234567', git)).toEqual({
      driftPaths: ['packages/operator-core/lib/release/x.ts'],
      oldestDriftCommitMs: 1_799_990_000_000,
    });
    expect(await resolveGateExecutorDrift('abc1234567', async () => { throw new Error('no git'); })).toEqual({ driftPaths: null, oldestDriftCommitMs: null });
    expect(await resolveGateExecutorDrift('not a sha;rm', git)).toEqual({ driftPaths: null, oldestDriftCommitMs: null });
  });
});

describe('targeted-radius judges each round by the radius it recorded (WI-10007489)', () => {
  const targeted = frozenRepairRoundExecution({ mode: 'targeted', fileKeys: ['core :: lib/a.test.ts'], gateIds: ['lint:tsc'] });
  const round = (n: number, executed?: ReturnType<typeof frozenRepairRoundExecution>) => ({
    round: n,
    head: C,
    failingCount: 1,
    atMs: T0 + n * MIN,
    ...(executed ? { executed } : {}),
  });
  const radius = (rounds: ReturnType<typeof round>[]) =>
    status(snap({ queue: queue({ convergenceRounds: rounds }) }), 'targeted-radius');

  it('rounds written before the record are UNKNOWN with a reason, never a fabricated pass', () => {
    const r = radius([round(1), round(2)]);
    expect(r.status).toBe('unknown');
    expect(r.observed).toMatch(/none of the open queue's 2 round\(s\) records its executed radius/);
  });

  it('targeted rounds plus justified full-gate rounds pass, with the counts named', () => {
    const r = radius([
      round(1, frozenRepairRoundExecution({ mode: 'full', trigger: 'candidate' })),
      round(2, targeted),
      round(3, frozenRepairRoundExecution({ mode: 'full', trigger: 'promotion-proof' })),
      round(4, frozenRepairRoundExecution({ mode: 'full', trigger: 'full-run-required' })),
    ]);
    expect(r.status).toBe('pass');
    expect(r.observed).toContain('1 targeted, 1 full as promotion proof, 1 full-run-required, 1 opening');
  });

  it('LOAD-BEARING: a full-gate round with NO recorded reason is the fallthrough, and breaches', () => {
    const r = radius([
      round(1, frozenRepairRoundExecution({ mode: 'full', trigger: 'candidate' })),
      round(2, targeted),
      round(3, frozenRepairRoundExecution({ mode: 'full' })),
    ]);
    expect(r.status).toBe('breach');
    expect(r.observed).toMatch(/1 round\(s\) ran the full gate with no recorded reason \(round 3\)/);
  });

  it('an unrecognised trigger read back from the row counts as unexplained, not as justified', () => {
    const parsedTrigger = parseFrozenCandidateRepairQueue({
      ...queue(),
      convergenceRounds: [{ ...round(1), executed: { mode: 'full', gateIds: [], trigger: 'because' } }],
    });
    expect(parsedTrigger?.convergenceRounds?.[0]?.executed).toEqual({ mode: 'full', gateIds: [] });
    expect(status(snap({ queue: parsedTrigger }), 'targeted-radius').status).toBe('breach');
  });

  it('older unrecorded rounds are counted beside recorded ones, never judged', () => {
    const r = radius([round(1), round(2, targeted)]);
    expect(r.status).toBe('pass');
    expect(r.observed).toContain('1 older round(s) carry no record');
  });

  it('a trigger is never stored on a targeted round', () => {
    const record = frozenRepairRoundExecution({ mode: 'targeted', trigger: 'promotion-proof' });
    expect(Object.hasOwn(record, 'trigger')).toBe(false);
  });
});

describe('fold: transitions, counters, heartbeat', () => {
  const pass = evaluateGateLiveInvariants(snap());
  const breachSnap = snap({ checkpointStatuses: ['error', 'error', 'error'] });
  const breach = evaluateGateLiveInvariants(breachSnap);

  it('the first evaluation is all transitions and emits', () => {
    const out = foldGateInvariants(null, pass, T0);
    expect(out.transitions).toHaveLength(7);
    expect(out.emit).toBe(true);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ status: 'pass', sinceMs: T0, passes: 1, evaluations: 1 });
  });

  it('an unchanged evaluation inside the heartbeat neither transitions nor emits, and keeps sinceMs', () => {
    const first = foldGateInvariants(null, pass, T0).next;
    const out = foldGateInvariants(first, pass, T0 + 15 * MIN);
    expect(out.transitions).toEqual([]);
    expect(out.emit).toBe(false);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ sinceMs: T0, passes: 2, evaluations: 2 });
    expect(out.next.lastEmittedAtMs).toBe(T0);
    expect(foldGateInvariants(out.next, pass, T0 + GATE_INVARIANT_HEARTBEAT_MS).emit).toBe(true);
  });

  it('a pass -> breach change is one transition and the breach keeps its last pass time', () => {
    const first = foldGateInvariants(null, pass, T0).next;
    const out = foldGateInvariants(first, breach, T0 + 15 * MIN);
    expect(out.transitions).toEqual([{ name: 'no-verdict-rate', from: 'pass', to: 'breach' }]);
    expect(out.next.invariants['no-verdict-rate']).toMatchObject({ status: 'breach', sinceMs: T0 + 15 * MIN, lastPassAtMs: T0 });
  });

  it('state survives the jsonb round trip, including when the driver hands back a string', () => {
    const next = foldGateInvariants(null, breach, T0).next;
    next.invariants['no-verdict-rate']!.filedItemId = 'WI-1';
    next.invariants['no-verdict-rate']!.filedAtMs = T0 + 100;
    next.invariants['no-verdict-rate']!.alarmTickMs = TICK;
    expect(parseGateInvariantsState(JSON.parse(JSON.stringify(next)))).toEqual(next);
    expect(parseGateInvariantsState(JSON.stringify(next))).toEqual(next);
    expect(parseGateInvariantsState('{nope')).toBeNull();
  });

  it('freezes the first observed tick and never backfills a legacy breach budget', () => {
    const first = foldGateInvariants(null, breach, T0, TICK).next;
    first.invariants['no-verdict-rate']!.filedItemId = 'WI-original';
    first.invariants['no-verdict-rate']!.filedAtMs = T0 + 1;
    const next = foldGateInvariants(first, breach, T0 + TICK, 2 * TICK).next;
    expect(next.invariants['no-verdict-rate']).toMatchObject({ alarmTickMs: TICK, filedAtMs: T0 + 1 });
    const recovered = foldGateInvariants(next, pass, T0 + 2 * TICK).next;
    expect(recovered.invariants['no-verdict-rate']!.filedAtMs).toBeUndefined();
    const legacy = foldGateInvariants(null, breach, T0).next;
    expect(foldGateInvariants(legacy, breach, T0 + TICK, TICK).next.invariants['no-verdict-rate']!.alarmTickMs).toBeUndefined();
  });
});
