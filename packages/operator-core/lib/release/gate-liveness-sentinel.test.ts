import { describe, expect, it } from 'vitest';
import {
  GATE_LIVENESS_NO_RUN_MS,
  GATE_LIVENESS_REESCALATE_MS,
  classifyGateRoundEnding,
  decideGateLiveness,
  shouldEscalate,
  type GateLivenessEvent,
} from './gate-liveness-sentinel';

const NOW = Date.parse('2026-10-12T16:00:00Z');
const MIN = 60_000;
const fire = (minsAgo: number): GateLivenessEvent => ({ kind: 'fire', atMs: NOW - minsAgo * MIN });
const end = (minsAgo: number, ending: GateLivenessEvent['ending']): GateLivenessEvent => ({ kind: 'ending', atMs: NOW - minsAgo * MIN, ending });

describe('classifyGateRoundEnding (pipeline_events green_checkpoint detail)', () => {
  it('reads the real detail shapes the gate writes', () => {
    expect(classifyGateRoundEnding({ green: false, summary: 'x', candidate: 'abc' })).toBe('verdict');
    expect(classifyGateRoundEnding({ green: true })).toBe('verdict');
    expect(classifyGateRoundEnding({ green: null, crashed: true, summary: 'boom' })).toBe('crash');
    expect(classifyGateRoundEnding({ green: false, crashed: true })).toBe('crash');
    expect(classifyGateRoundEnding({ reason: 'conflict', phase: 'begin' })).toBe('conflict');
    expect(classifyGateRoundEnding({ reason: 'over-budget', budgetG: 4 })).toBe('refused');
    expect(classifyGateRoundEnding({ reason: 'something-new' })).toBe('other');
    expect(classifyGateRoundEnding(null)).toBe('other');
  });

  // Statuses and detail shapes measured on install `papercusp`, 2026-10-05..10-12.
  it('classifies every measured row status, reading status before detail.reason', () => {
    const deferred = ['skipped-joined-attempt', 'skipped-locked', 'unchanged-since-verdict', 'repair-in-progress', 'release-fixer-skipped-snapshot'];
    for (const status of deferred) expect(classifyGateRoundEnding({ green: null }, status)).toBe('deferred');
    expect(classifyGateRoundEnding({ green: null, killed: false }, 'error')).toBe('crash');
    expect(classifyGateRoundEnding({ phase: 'terminal', stage: 'begin', reason: 'conflict' }, 'skipped-qualification-conflict')).toBe('conflict');
    for (const status of ['skipped-memory-budget', 'disk-headroom', 'dependency-prewarm-missing', 'skipped-runner-liveness-unknown']) {
      expect(classifyGateRoundEnding({ green: null }, status)).toBe('refused');
    }
    // A red verdict is a verdict whatever its status label says.
    expect(classifyGateRoundEnding({ green: false }, 'decision-pending')).toBe('verdict');
    expect(classifyGateRoundEnding({ green: false }, 'not-green')).toBe('verdict');
    // An unknown new status still alarms rather than hiding as deferred.
    expect(classifyGateRoundEnding({ green: null }, 'some-new-status')).toBe('other');
  });
});

describe('decideGateLiveness — P-023 / bar R-3', () => {
  it('no-runs: main red and nothing fired or ended for 2h alerts and escalates', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [fire(130), end(125, 'verdict')] });
    expect(d.state).toBe('no-runs');
    expect(d.alert).toBe(true);
    expect(d.escalate).toBe(true);
    expect(d.lastActivityAtMs).toBe(NOW - 125 * MIN);
    expect(d.episodeKey).toBe(`no-runs:${NOW - 125 * MIN}`);
  });

  it('no-runs: an empty ledger (the 10-03..10-05 outage shape) still alarms', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [] });
    expect(d.state).toBe('no-runs');
    expect(d.alert && d.escalate).toBe(true);
    expect(d.episodeKey).toBe('no-runs:never');
  });

  it('just inside the window is not a breach', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [fire(GATE_LIVENESS_NO_RUN_MS / MIN - 1)] });
    expect(d.state).toBe('healthy');
    expect(d.alert).toBe(false);
  });

  it('crash-loop: rounds start but every ending is an error; never reported as healthy or no-runs', () => {
    const events = [fire(110), end(100, 'conflict'), fire(70), end(60, 'crash'), fire(30), end(20, 'conflict')];
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events });
    expect(d.state).toBe('crash-loop');
    expect(d.state).not.toBe('no-runs');
    expect(d.state).not.toBe('healthy');
    expect(d.alert && d.escalate).toBe(true);
    expect(d.windowCounts).toEqual({ fires: 3, verdicts: 0, nonVerdictEndings: 3, deferred: 0 });
    expect(d.reason).toMatch(/conflict, crash/);
  });

  it('deferred ticks during a long wait are not a crash loop (the false-alarm shape)', () => {
    // A red candidate awaiting its repair: every ~18 min the gate fires and writes
    // unchanged-since-verdict / repair-in-progress, with no verdict for hours. Nothing failed.
    const events = [end(400, 'verdict'), fire(110), end(109, 'deferred'), fire(90), end(89, 'deferred'),
      fire(70), end(69, 'deferred'), fire(50), end(49, 'deferred'), fire(30), end(29, 'deferred')];
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events });
    expect(d.state).toBe('healthy');
    expect(d.alert || d.escalate).toBe(false);
    expect(d.windowCounts).toEqual({ fires: 5, verdicts: 0, nonVerdictEndings: 0, deferred: 5 });
  });

  it('deferred ticks neither hide nor break a real crash loop', () => {
    const events = [end(400, 'verdict'), end(100, 'conflict'), end(90, 'deferred'), end(60, 'conflict'), end(30, 'deferred')];
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events });
    expect(d.state).toBe('crash-loop');
    expect(d.windowCounts).toMatchObject({ nonVerdictEndings: 2, deferred: 2 });
    expect(d.episodeKey).toBe(`crash-loop:${NOW - 100 * MIN}`);
    expect(d.reason).toMatch(/2 failed rounds: conflict/);
  });

  it('crash-loop episode key is stable while old endings slide out of the window', () => {
    const lookback = [end(300, 'verdict'), end(240, 'conflict'), end(180, 'conflict'), end(100, 'conflict'), end(40, 'crash')];
    const a = decideGateLiveness({ nowMs: NOW, mainRed: true, events: lookback });
    const b = decideGateLiveness({ nowMs: NOW + 30 * MIN, mainRed: true, events: [...lookback, end(-20, 'conflict')] });
    expect(a.state).toBe('crash-loop');
    expect(b.state).toBe('crash-loop');
    expect(a.episodeKey).toBe(`crash-loop:${NOW - 240 * MIN}`);
    expect(b.episodeKey).toBe(a.episodeKey);
  });

  it('a single crash is an incident, not a loop', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [fire(50), end(40, 'crash')] });
    expect(d.state).toBe('healthy');
    expect(d.alert).toBe(false);
  });

  it('healthy: a verdict inside the window breaks a run of errors', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [end(100, 'crash'), end(60, 'verdict'), end(20, 'conflict')] });
    expect(d.state).toBe('healthy');
    expect(d.alert || d.escalate).toBe(false);
    expect(d.episodeKey).toBeNull();
  });

  it('healthy: fires with no ending yet is a round still running', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: true, events: [end(200, 'verdict'), fire(90), fire(30)] });
    expect(d.state).toBe('healthy');
  });

  it('main green: the invariant does not apply, whatever the ledger says', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: false, events: [] });
    expect(d.state).toBe('main-green');
    expect(d.alert).toBe(false);
  });

  it('unknown main state reports unknown rather than a false healthy or a false alarm', () => {
    const d = decideGateLiveness({ nowMs: NOW, mainRed: null, events: [] });
    expect(d.state).toBe('unknown');
    expect(d.alert).toBe(false);
  });

  it('ignores future-dated and malformed events', () => {
    const d = decideGateLiveness({
      nowMs: NOW, mainRed: true,
      events: [{ kind: 'fire', atMs: NOW + 10 * MIN }, { kind: 'ending', atMs: NOW - 5 * MIN }, { kind: 'fire', atMs: Number.NaN }],
    });
    expect(d.state).toBe('no-runs');
  });
});

describe('shouldEscalate — retry until delivered, then re-send on a cadence', () => {
  const breach = { escalate: true, episodeKey: 'no-runs:1' };
  it('sends on a new episode and retries an undelivered one every tick', () => {
    expect(shouldEscalate(breach, null, NOW)).toBe(true);
    expect(shouldEscalate(breach, { episodeKey: 'no-runs:0', deliveredAtMs: NOW }, NOW)).toBe(true);
    expect(shouldEscalate(breach, { episodeKey: 'no-runs:1', deliveredAtMs: null }, NOW)).toBe(true);
  });
  it('holds a delivered episode until the re-escalation interval passes', () => {
    expect(shouldEscalate(breach, { episodeKey: 'no-runs:1', deliveredAtMs: NOW - 10 * MIN }, NOW)).toBe(false);
    expect(shouldEscalate(breach, { episodeKey: 'no-runs:1', deliveredAtMs: NOW - GATE_LIVENESS_REESCALATE_MS }, NOW)).toBe(true);
  });
  it('never escalates a quiet decision', () => {
    expect(shouldEscalate({ escalate: false, episodeKey: null }, null, NOW)).toBe(false);
  });
});
