import { describe, expect, it } from 'vitest';
import { evaluateGreenMainPreflightJoin, type GreenMainPreflightJoin } from './green-main-slo';

import {
  buildGateRoundPhases,
  GATE_ROUND_OTHER_PHASE,
  GATE_ROUND_PHASES_MAX,
  parseGateRoundPhases,
} from './gate-round-phases';

describe('buildGateRoundPhases (P-013)', () => {
  const stamps = [
    { phase: 'setup-tree', ms: 120_000 },
    { phase: 'early-typecheck-preflight', ms: 60_000 },
    { phase: 'candidate-suite', ms: 2_400_000 },
  ];

  it('keeps stamped phases in run order and reports the unstamped remainder as other', () => {
    const r = buildGateRoundPhases(stamps, 3_000_000);
    expect(r?.phases).toEqual([...stamps, { phase: GATE_ROUND_OTHER_PHASE, ms: 420_000 }]);
    // The parts add up to the measured total — the property the breakdown exists to give.
    expect(r?.phases.reduce((sum, p) => sum + p.ms, 0)).toBe(r?.totalMs);
    expect(r?.breakdown).toBe(
      'total 50m 00s: setup-tree 2m 00s (4%), early-typecheck-preflight 1m 00s (2%), ' +
        'candidate-suite 40m 00s (80%), other 7m 00s (14%)',
    );
  });

  it('omits other when the stamps cover the whole round, and never makes it negative', () => {
    expect(buildGateRoundPhases(stamps, 2_580_000)?.phases.map((p) => p.phase)).not.toContain('other');
    const over = buildGateRoundPhases(stamps, 1_000_000);
    expect(over?.phases.some((p) => p.ms < 0)).toBe(false);
    expect(over?.phases.map((p) => p.phase)).not.toContain('other');
  });

  it.each([0, -5, Number.NaN])('returns null for an unmeasured total (%s) instead of inventing shares', (total) => {
    expect(buildGateRoundPhases(stamps, total)).toBeNull();
  });

  it('caps the stored phase list, keeping room for other', () => {
    const many = Array.from({ length: GATE_ROUND_PHASES_MAX + 10 }, (_, i) => ({ phase: `p${i}`, ms: 1_000 }));
    const r = buildGateRoundPhases(many, 10_000_000);
    expect(r?.phases.length).toBeLessThanOrEqual(GATE_ROUND_PHASES_MAX);
    expect(r?.phases.at(-1)?.phase).toBe(GATE_ROUND_OTHER_PHASE);
  });
});

describe('parseGateRoundPhases (P-013)', () => {
  const built = () => buildGateRoundPhases([{ phase: 'candidate-suite', ms: 60_000 }], 90_000)!;

  it('round-trips a built breakdown through JSON', () => {
    expect(parseGateRoundPhases(JSON.parse(JSON.stringify(built())))).toEqual(built());
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an array', []],
    ['a zero total', { ...built(), totalMs: 0 }],
    ['an empty breakdown', { ...built(), breakdown: '' }],
    ['a negative phase', { ...built(), phases: [{ phase: 'x', ms: -1 }] }],
    ['an unnamed phase', { ...built(), phases: [{ phase: '', ms: 1 }] }],
    ['too many phases', { ...built(), phases: Array.from({ length: GATE_ROUND_PHASES_MAX + 1 }, () => ({ phase: 'x', ms: 1 })) }],
  ])('reads %s as not measured', (_label, value) => {
    expect(parseGateRoundPhases(value)).toBeNull();
  });
});

describe('R19 original preflight receipt join', () => {
  const head = (n: number) => n.toString(16).padStart(40, '0');
  const fixture = (): GreenMainPreflightJoin => ({
    workspaceId: 'workspace-test', installSlug: 'install-test', windowStartMs: 1_000_000, windowEndMs: 5_000_000,
    population: { status: 'complete', total: 2, sha256: 'a'.repeat(64) },
    rounds: [2, 3].map((round, index) => ({
      candidate: head(1), openedAtMs: 0, round, previousHead: head(round - 1),
      previousVerdictAtMs: 1_000_000 + index * 1_000_000, head: head(round), verdictAtMs: 2_000_000 + index * 1_000_000,
      snapshotId: `snapshot-${round}`, checkpoint: {
        eventId: `event-${round}`, workspaceId: 'workspace-test', installSlug: 'install-test',
        head: head(round), runId: `run-${round}`, verdictAtMs: 2_000_000 + index * 1_000_000,
        logRef: `original-log-${round}`, logSha256: 'b'.repeat(64), logHead: head(round), logRunId: `run-${round}`,
        preflightStatus: 'passed', phases: [{ phase: 'early-typecheck-preflight', ms: 600_000 }],
      },
      admissions: [{ fromRepairHead: head(round - 1), toRepairHead: head(round), atMs: 1_200_000 + index * 1_000_000 }],
      audits: [{ id: `audit-${round}`, atMs: 1_210_000 + index * 1_000_000, candidate: head(1),
        from: head(round - 1), to: head(round), persisted: true,
        paths: Array.from({ length: 20 }, (_, n) => `src/file-${n}.ts`), unchanged: [] }],
    })),
  });
  const evaluate = (input = fixture()) => evaluateGreenMainPreflightJoin(input, 5_000_000);

  it('accepts the literal 600000ms/20-path boundary on two original adjacent rounds', () => {
    const result = evaluate();
    expect(result.verdict).toBe('healthy');
    expect(result.rounds.map(round => round.admittedPaths.length)).toEqual([20, 20]);
    expect(result.assertions.every(assertion => assertion.passed)).toBe(true);
  });

  it.each([0, 1])('fails when qualified round %s exceeds ten minutes by one millisecond', index => {
    const input = fixture();
    input.rounds[index]!.checkpoint.phases[0]!.ms = 600_001;
    expect(evaluate(input).verdict).toBe('broken');
  });

  it.each(['skipped', 'unknown'] as const)('never accepts a %s preflight as a measured zero', status => {
    const input = fixture();
    input.rounds[0]!.checkpoint.preflightStatus = status;
    input.rounds[0]!.checkpoint.phases[0]!.ms = 0;
    expect(evaluate(input).verdict).toBe('unknown');
  });

  it.each(['capped', 'unavailable', 'invalid'] as const)('preserves a %s census as unknown', status => {
    const input = fixture();
    input.population.status = status;
    expect(evaluate(input).verdict).toBe('unknown');
  });

  it.each(['missing-pair', 'wrong-total', 'future-window', 'scope', 'incarnation', 'ordinal', 'previous-head',
    'previous-clock', 'short-head', 'run', 'duplicate-run', 'duplicate-event', 'log-head', 'log-hash',
    'phase-missing', 'phase-duplicate', 'phase-nan', 'phase-negative', 'phase-outside-window', 'over-cap', 'audit-missing',
    'audit-extra', 'audit-duplicate', 'audit-unpersisted', 'audit-wrong-head', 'audit-before-admission',
    'audit-after-verdict', 'bad-path', 'bad-unchanged', 'empty-paths', 'reconstructed', 'broken-chain',
    'chain-after-verdict', 'chain-at-previous-verdict'])('keeps %s evidence unknown', defect => {
    const input = fixture(), first = input.rounds[0]!, second = input.rounds[1]!;
    if (defect === 'missing-pair') { input.rounds.pop(); input.population.total = 1; }
    if (defect === 'wrong-total') input.population.total = 3;
    if (defect === 'future-window') input.windowEndMs++;
    if (defect === 'scope') first.checkpoint.workspaceId = 'foreign';
    if (defect === 'incarnation') second.openedAtMs = 1;
    if (defect === 'ordinal') second.round++;
    if (defect === 'previous-head') second.previousHead = head(99);
    if (defect === 'previous-clock') second.previousVerdictAtMs++;
    if (defect === 'short-head') first.head = first.head.slice(0, 12);
    if (defect === 'run') first.checkpoint.logRunId = 'other';
    if (defect === 'duplicate-run') second.checkpoint.runId = second.checkpoint.logRunId = first.checkpoint.runId;
    if (defect === 'duplicate-event') second.checkpoint.eventId = first.checkpoint.eventId;
    if (defect === 'log-head') first.checkpoint.logHead = head(99);
    if (defect === 'log-hash') first.checkpoint.logSha256 = '';
    if (defect === 'phase-missing') first.checkpoint.phases = [];
    if (defect === 'phase-duplicate') first.checkpoint.phases.push({ ...first.checkpoint.phases[0]! });
    if (defect === 'phase-nan') first.checkpoint.phases[0]!.ms = NaN;
    if (defect === 'phase-negative') first.checkpoint.phases[0]!.ms = -1;
    if (defect === 'phase-outside-window') first.checkpoint.phases[0]!.ms = 800_001;
    if (defect === 'over-cap') first.audits[0]!.paths.push('src/file-20.ts');
    if (defect === 'audit-missing') first.audits = [];
    if (defect === 'audit-extra') first.audits.push({ ...first.audits[0]!, id: 'extra', to: head(98) });
    if (defect === 'audit-duplicate') first.audits.push({ ...first.audits[0]! });
    if (defect === 'audit-unpersisted') first.audits[0]!.persisted = false;
    if (defect === 'audit-wrong-head') first.audits[0]!.to = head(99);
    if (defect === 'audit-before-admission') first.audits[0]!.atMs = first.admissions[0]!.atMs - 1;
    if (defect === 'audit-after-verdict') first.audits[0]!.atMs = first.verdictAtMs + 1;
    if (defect === 'bad-path') first.audits[0]!.paths[0] = '../escape';
    if (defect === 'bad-unchanged') first.audits[0]!.unchanged = [first.audits[0]!.paths[0]!];
    if (defect === 'empty-paths') first.audits[0]!.paths = [];
    if (defect === 'reconstructed') first.admissions[0]!.provenance = 'reconciled-from-ref';
    if (defect === 'broken-chain') first.admissions[0]!.fromRepairHead = head(99);
    if (defect === 'chain-after-verdict') first.admissions[0]!.atMs = first.verdictAtMs + 1;
    if (defect === 'chain-at-previous-verdict') first.admissions[0]!.atMs = first.previousVerdictAtMs;
    expect(evaluate(input).verdict).toBe('unknown');
  });

  it('unions actual paths across multiple original admissions without counting them as extra rounds', () => {
    const input = fixture(), round = input.rounds[0]!;
    round.admissions[0]!.toRepairHead = head(50);
    round.admissions.push({ fromRepairHead: head(50), toRepairHead: round.head, atMs: 1_300_000 });
    round.audits[0]!.to = head(50);
    round.audits[0]!.unchanged = ['src/unchanged.ts'];
    round.audits.push({ ...round.audits[0]!, id: 'another-audit', atMs: 1_310_000, from: head(50), to: round.head });
    const result = evaluate(input);
    expect(result.verdict).toBe('healthy');
    expect(result.rounds[0]!.admittedPaths).toEqual([...round.audits[0]!.paths].sort());
    expect(result.rounds).toHaveLength(2);
  });
});
