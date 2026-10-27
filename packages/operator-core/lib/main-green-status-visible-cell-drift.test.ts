/**
 * main-green-status-visible-2026-09-03 P-007 — PER-CELL DRIFT TESTS.
 *
 * A registration census stays green while a cell renders garbage: it proves the spec
 * EXISTS, not that the paths it hoists resolve on what the resolver actually returns
 * (the vacuous pass caught on plan role-model-one-answer-2026-09-03). So every cell this
 * plan added or extended is exercised here THE OTHER WAY ROUND — a fixture goes through
 * the REAL projector, and the registration's own headline / assessment path / evidence /
 * measured-ness pairings are resolved against that output. Rename a field in the
 * projector and not the spec (or the reverse) and the cell whose read would silently
 * degrade is the test that fails, by name.
 *
 * No I/O: every projector here is pure, and the one resolver that owns I/O
 * (`readGateCandidateFailures`) is fed the same fakes its own unit tests use.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CELLS } from './cell-registrations';
import type { CellSpec } from './cell-registry';
import { measurednessViolations, hoistedPaths } from './cell-measuredness';
import { pathExists } from './state-plane-stamp';
import { projectFreezeDispositionCell, type FreezeAndConvergeGateHealth } from './release/freeze-disposition';
import { projectRetriageCell } from './release/in-flight-retriage';
import { projectRunStatusCell } from './release/run-status-cell';
import { parseFrozenRepairConvergence, projectFrozenRepairConvergenceCell } from './release/frozen-candidate-repair-queue';
import { composeGateOwnerBrief, type GateOwnerBriefInput } from './gate-owner-brief';
import { readGateCandidateFailures } from './gate-candidate-failures';

const NOW = 1_788_460_000_000;

function spec(cell: string): CellSpec {
  const s = BUILTIN_CELLS.find((c) => c.cell === cell);
  if (!s) throw new Error(`cell ${cell} is not registered — the drift test cannot even find its subject`);
  return s;
}

/**
 * THE DRIFT ASSERTION. Every path the registration hoists must resolve on the projected
 * payload (a `null` VALUE is fine — an ABSENT KEY is drift), the assessment code the
 * projector emitted must be one the registration documents, and the P-012 measured-ness
 * pairings must hold on this payload.
 */
function assertNoDrift(s: CellSpec, payload: unknown): void {
  const missing = hoistedPaths(s).filter((p) => !pathExists(payload, p).exists);
  expect(missing, `${s.cell}: hoisted path(s) absent on the projector's own output`).toEqual([]);

  const a = s.assessment;
  if (a) {
    const code = pathExists(payload, a.path);
    expect(code.exists, `${s.cell}: assessment path ${a.path} absent`).toBe(true);
    expect(Object.keys(a.codes), `${s.cell}: emitted code "${String(code.value)}" is not documented`).toContain(code.value);
    for (const [value, flag] of Object.entries(a.measuredBy ?? {})) {
      expect(pathExists(payload, value).exists, `${s.cell}: paired value ${value} absent`).toBe(true);
      expect(pathExists(payload, flag).exists, `${s.cell}: measured-ness flag ${flag} absent`).toBe(true);
    }
  }
  expect(measurednessViolations(s, payload), `${s.cell}: measured-ness violations`).toEqual([]);
}

/** Drop one key anywhere in a payload — the mutation a projector rename produces. */
function without(payload: unknown, dotted: string): unknown {
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const segs = dotted.split('.');
  let cur: Record<string, unknown> = clone;
  for (const seg of segs.slice(0, -1)) cur = cur[seg] as Record<string, unknown>;
  delete cur[segs[segs.length - 1]!];
  return clone;
}

// ── P-004 / P-008: gate.greenCheckpoint.freezeDisposition ──────────────────────────────
describe('gate.greenCheckpoint.freezeDisposition (P-004/P-008) — spec resolves on projectFreezeDispositionCell()', () => {
  const S = () => spec('gate.greenCheckpoint.freezeDisposition');
  const record: FreezeAndConvergeGateHealth['freezeAndConverge'] = {
    enabled: true,
    state: 'converging',
    reason: 'frozen repair fixer dispatched (attempt 1); no suite run',
    candidate: 'd165d7537d201ac8eded1a520b137cbdafd260a0',
    holdUntilMs: null,
    capacityRetryAtMs: null,
    observedAtMs: NOW - 30_000,
  };
  const payload = (r: typeof record | null, now = NOW) => ({ gate: { freezeDisposition: projectFreezeDispositionCell(r, now) } });

  it('a live converging disposition resolves every hoisted path and emits a documented code', () => {
    assertNoDrift(S(), payload(record));
    expect(pathExists(payload(record), S().assessment!.path).value).toBe('converging');
  });

  it('the unmeasured projection (no record) still carries every hoisted key — null values, never absent keys', () => {
    assertNoDrift(S(), payload(null));
    expect(pathExists(payload(null), S().assessment!.path).value).toBe('no-disposition-recorded');
  });

  it('a stale record outranks its state (the false-current-retired class)', () => {
    const stale = payload({ ...record, state: 'retired', observedAtMs: NOW - 6 * 60 * 60_000 });
    assertNoDrift(S(), stale);
    expect(pathExists(stale, S().assessment!.path).value).toBe('stale');
  });

  it('FALSIFIER: renaming the projector\'s state or code field makes THIS test fail, not the census', () => {
    expect(() => assertNoDrift(S(), without(payload(record), 'gate.freezeDisposition.state'))).toThrow(/freezeDisposition/);
    expect(() => assertNoDrift(S(), without(payload(record), 'gate.freezeDisposition.code'))).toThrow(/freezeDisposition/);
  });
});

// ── P-004: gate.greenCheckpoint.convergence ────────────────────────────────────────────
describe('gate.greenCheckpoint.convergence (P-004) — spec resolves on projectFrozenRepairConvergenceCell()', () => {
  const S = () => spec('gate.greenCheckpoint.convergence');
  /** The exact `gate_health.convergence` blob the live routine published on 2026-09-03T18:00Z. */
  const RAW = {
    ageMs: 20_075_016,
    phase: 'awaiting-fixer',
    attempts: 1,
    candidate: 'd165d7537d201ac8eded1a520b137cbdafd260a0',
    converging: null,
    failingNow: 16,
    openedAtMs: 1_788_438_329_941,
    repairHead: '64db9da202a927878e2a93b86bea16c0c88e195a',
    shrinkTotal: 0,
    failingFirst: 16,
    observedAtMs: 1_788_458_404_957,
    shrinkPerRound: [{ delta: null, round: 1, failingCount: 16 }],
    admissionRounds: 1,
  };
  const payload = (raw: unknown) => ({ gate: { convergence: projectFrozenRepairConvergenceCell(parseFrozenRepairConvergence(raw)) } });

  it('the live blob parses, projects, and resolves every hoisted path with a documented code', () => {
    expect(parseFrozenRepairConvergence(RAW)).not.toBeNull();
    assertNoDrift(S(), payload(RAW));
    // One round with no delta yet: the projector must say it cannot know, not "not converging".
    expect(pathExists(payload(RAW), S().assessment!.path).value).toBe('not-yet-knowable');
  });

  it('an unparseable / absent blob projects the unmeasured shape with every key present', () => {
    expect(parseFrozenRepairConvergence(null)).toBeNull();
    assertNoDrift(S(), payload(null));
    expect(pathExists(payload(null), S().assessment!.path).value).toBe('no-cycle-recorded');
  });

  it('a shrinking cycle reads converging; a non-shrinking one does not', () => {
    const shrinking = payload({ ...RAW, converging: true, shrinkTotal: 4, shrinkPerRound: [{ delta: null, round: 1, failingCount: 16 }, { delta: -4, round: 2, failingCount: 12 }], admissionRounds: 2 });
    assertNoDrift(S(), shrinking);
    expect(pathExists(shrinking, S().assessment!.path).value).toBe('converging');
    const flat = payload({ ...RAW, converging: false, shrinkPerRound: [{ delta: null, round: 1, failingCount: 16 }, { delta: 0, round: 2, failingCount: 16 }], admissionRounds: 2 });
    assertNoDrift(S(), flat);
    expect(pathExists(flat, S().assessment!.path).value).toBe('not-converging');
  });

  it('FALSIFIER: dropping the headline from the projection fails here', () => {
    expect(() => assertNoDrift(S(), without(payload(RAW), S().headline))).toThrow(/convergence/);
  });
});

// ── P-009: gate.greenCheckpoint.retriage ───────────────────────────────────────────────
describe('gate.greenCheckpoint.retriage (P-009) — spec resolves on projectRetriageCell()', () => {
  const S = () => spec('gate.greenCheckpoint.retriage');
  const inFlight = {
    active: true,
    inRetriageWindow: true as const,
    fromCandidate: 'aaaaaaaaaaaa',
    candidate: 'bbbbbbbbbbbb',
    refireAttempt: 1,
    maxRefires: 3,
    totalRefires: 1,
    absoluteCeiling: 6,
    asOfAgeMs: 12_000,
  };
  const payload = (run: Parameters<typeof projectRetriageCell>[0]) => ({ gate: { retriage: projectRetriageCell(run, null, NOW) } });

  it('an in-flight refire resolves every hoisted path with a documented code', () => {
    assertNoDrift(S(), payload(inFlight));
    expect(pathExists(payload(inFlight), S().assessment!.path).value).toBe('in-flight');
  });

  it('no run reading is UNMEASURED with every key present — and it holds the reader (standDown true)', () => {
    assertNoDrift(S(), payload(null));
    expect(pathExists(payload(null), S().assessment!.path).value).toBe('no-run-reading');
    expect(pathExists(payload(null), 'gate.retriage.standDown').value).toBe(true);
  });

  it('a run with no refire window is no-refire, never in-flight', () => {
    const quiet = payload({ active: true });
    assertNoDrift(S(), quiet);
    expect(pathExists(quiet, S().assessment!.path).value).toBe('no-refire');
  });

  it('FALSIFIER: dropping the headline from the projection fails here', () => {
    expect(() => assertNoDrift(S(), without(payload(inFlight), S().headline))).toThrow(/retriage/);
  });
});

// ── WI-6554700010029556 (owner #2439): gate.greenCheckpoint.run ─────────────────────────
describe('gate.greenCheckpoint.run (WI-6554700010029556) — spec resolves on projectRunStatusCell()', () => {
  const S = () => spec('gate.greenCheckpoint.run');
  const live = {
    active: true,
    activeSource: 'run-lock' as const,
    pid: 4242,
    candidate: 'cccccccccccc',
    startedAtMs: NOW - 3_600_000,
    elapsedSec: 3_600,
    progressAtMs: NOW - 30_000,
    verdictWrittenAtMs: null,
    currentPhase: 'frozen-repair',
    currentActivity: 'repair-tick-legs',
    currentLeg: { label: 'lint:tsc', index: 3, total: 9 },
    asOfAgeMs: 5_000,
  };
  const payload = (run: Parameters<typeof projectRunStatusCell>[0]) => ({ gate: { run: projectRunStatusCell(run, NOW) } });

  it('a live advancing run resolves every hoisted path with a documented code', () => {
    assertNoDrift(S(), payload(live));
    expect(pathExists(payload(live), S().assessment!.path).value).toBe('running');
    expect(pathExists(payload(live), 'gate.run.pidVerified').value).toBe(true);
  });

  it('no run reading is UNMEASURED with every key present', () => {
    assertNoDrift(S(), payload(null));
    expect(pathExists(payload(null), S().assessment!.path).value).toBe('no-run-reading');
    expect(pathExists(payload(null), 'gate.run.unmeasured').value).toBe(true);
  });

  it('an idle gate resolves every hoisted path, pid null and unverified', () => {
    const idle = payload({ active: false, activeSource: 'run-lock' });
    assertNoDrift(S(), idle);
    expect(pathExists(idle, S().assessment!.path).value).toBe('no-run');
    expect(pathExists(idle, 'gate.run.pidVerified').value).toBe(false);
  });

  it('FALSIFIER: dropping the headline from the projection fails here', () => {
    expect(() => assertNoDrift(S(), without(payload(live), S().headline))).toThrow(/run/);
  });
});

// ── P-005 / P-010 / P-007: gate.greenCheckpoint.ownerBrief ────────────────────────────
describe('gate.greenCheckpoint.ownerBrief (P-005/P-010/P-007) — spec resolves on composeGateOwnerBrief()', () => {
  const S = () => spec('gate.greenCheckpoint.ownerBrief');
  const red: GateOwnerBriefInput = {
    nowMs: NOW,
    consecutiveReds: 104,
    failingTests: [],
    failingTestsMeasured: true,
    failingTestsProvenance: 'measured',
    mainBehindStaging: true,
    lastGreenAtMs: NOW - 15 * 24 * 60 * 60_000,
    verdictObservedAtMs: NOW - 40_000,
    fireStale: false,
    verdictStale: false,
    inconclusive: { status: 'repair-in-progress', detail: 'fixer dispatched', observedAtMs: NOW - 30_000 },
    repairQueue: { phase: 'awaiting-fixer', attempts: 1, updatedAtMs: NOW - 20_000, ageMs: 20_000_000, fixerSpawnId: 's-1', fixerAlive: false, zeroAttemptStalled: false },
    ownership: { claimState: 'held', takenBy: 'su-holder', workItem: 'WI-212675', assessment: 'held-live' } as unknown as GateOwnerBriefInput['ownership'],
    nonTestLegs: { measured: 'measured', outstanding: ['lint:tsc'] },
  };
  const payload = (inp: GateOwnerBriefInput, mainBehindStaging: boolean | null = false) => ({
    gate: { ownerBrief: composeGateOwnerBrief(inp) },
    verdictProvenance: { mainBehindStaging },
  });

  it('a red brief with a red non-test leg resolves every hoisted path, names the leg, and emits a documented code', () => {
    const p = payload(red, true);
    assertNoDrift(S(), p);
    expect(pathExists(p, S().assessment!.path).value).toBe('red-owned-stalled');
    expect(pathExists(p, 'gate.ownerBrief.whyNot.failingNonTestLegs').value).toEqual(['lint:tsc']);
    expect(pathExists(p, 'gate.ownerBrief.attestations.verdict').value).toBeTypeOf('string');
  });

  it('FALSIFIER: dropping the P-007 leg list — or its measured-ness flag — fails here, not in a census', () => {
    expect(() => assertNoDrift(S(), without(payload(red, true), 'gate.ownerBrief.whyNot.failingNonTestLegs'))).toThrow(/ownerBrief/);
    expect(() => assertNoDrift(S(), without(payload(red, true), 'gate.ownerBrief.whyNot.nonTestLegsMeasured'))).toThrow(/ownerBrief/);
    expect(() => assertNoDrift(S(), without(payload(red, true), 'gate.ownerBrief.attestations.staleLegs'))).toThrow(/ownerBrief/);
  });
});

// ── P-003 / P-007: gate.greenCheckpoint.candidateFailures ─────────────────────────────
describe('gate.greenCheckpoint.candidateFailures (P-003/P-007) — spec resolves on readGateCandidateFailures()', () => {
  const S = () => spec('gate.greenCheckpoint.candidateFailures');
  const CANDIDATE = 'adbf27530285830455f8d8df32a45752cfaff332';
  const REPAIR_HEAD = 'e7bffeac00000000000000000000000000000000';
  const fakeSql = (failing: Array<Record<string, unknown>>) =>
    ((strings: TemplateStringsArray) =>
      /count\(DISTINCT file_path\)/.test(strings.join(' ')) ? Promise.resolve([{ files_judged: 223 }]) : Promise.resolve(failing)) as never;
  const fakeGit = (table: Record<string, string | null>) => async (_cwd: string, args: string[]) => table[args.join(' ')] ?? null;
  const tick = (status: 'pass' | 'fail') => ({
    head: REPAIR_HEAD.slice(0, 12),
    atMs: NOW - 1000,
    ok: status === 'pass',
    failingSignatures: status === 'pass' ? [] : ['lint:tsc'],
    legs: [{ id: 'lint:tsc', status, durationMs: 10 }],
  });
  const read = (opts: { failing?: Array<Record<string, unknown>>; git?: Record<string, string | null>; legs?: 'pass' | 'fail' | null } = {}) =>
    readGateCandidateFailures({
      candidateSha: CANDIDATE,
      repairHeadSha: REPAIR_HEAD,
      root: '/repo',
      sql: fakeSql(opts.failing ?? []),
      git: fakeGit(opts.git ?? {}),
      ...(opts.legs ? { repairTickLegs: tick(opts.legs) } : {}),
    });

  it('a red non-test leg with zero failing files resolves every hoisted path and reads non-test-leg-failing', async () => {
    const p = { gate: { candidateFailures: await read({ legs: 'fail' }) } };
    assertNoDrift(S(), p);
    expect(pathExists(p, S().assessment!.path).value).toBe('non-test-leg-failing');
    expect(pathExists(p, 'gate.candidateFailures.nonTestLegs.outstanding').value).toEqual(['lint:tsc']);
  });

  it('no leg measurement is not-recorded (flag present, legs UNMEASURED but present) — the P-012 pairing rides beside an empty list, never a null subtree', async () => {
    const p = { gate: { candidateFailures: await read() } };
    // C2 (EI-22270968007901491): `nonTestLegs` used to be null here, which made its paired
    // paths ABSENT — and an absent declared evidence path downgrades the whole assessment to
    // `unavailable` on the ordinary path (cell-assessment-reality measured it live: 222/223).
    // Now the subtree is always an object: the list arrives EMPTY and the flag beside it says
    // it is unmeasured. Both halves of the pairing must resolve.
    expect(pathExists(p, 'gate.candidateFailures.nonTestLegsMeasured').value).toBe('not-recorded');
    expect(pathExists(p, 'gate.candidateFailures.nonTestLegs.perLeg').value).toEqual([]);
    expect(pathExists(p, 'gate.candidateFailures.nonTestLegs.outstanding').value).toEqual([]);
    assertNoDrift(S(), p);
    expect(measurednessViolations(S(), p)).toEqual([]);
    expect(pathExists(p, S().assessment!.path).value).toBe('none-failing');
  });

  it('a still-broken file resolves every hoisted path and reads repairs-outstanding', async () => {
    const f = 'lib/a.test.ts';
    const key = (sha: string) => `rev-parse --verify --quiet ${sha}:${f}`;
    const p = { gate: { candidateFailures: await read({ failing: [{ file_path: f, status: 'fail', attempts: 1 }], git: { [key(CANDIDATE)]: 'same', [key(REPAIR_HEAD)]: 'same' }, legs: 'pass' }) } };
    assertNoDrift(S(), p);
    expect(pathExists(p, S().assessment!.path).value).toBe('repairs-outstanding');
  });

  it('FALSIFIER: dropping the P-007 outstanding list, or the measured-ness flag it is paired with, fails here', async () => {
    const p = { gate: { candidateFailures: await read({ legs: 'fail' }) } };
    expect(() => assertNoDrift(S(), without(p, 'gate.candidateFailures.nonTestLegs.outstanding'))).toThrow(/candidateFailures/);
    expect(() => assertNoDrift(S(), without(p, 'gate.candidateFailures.nonTestLegsMeasured'))).toThrow(/candidateFailures/);
  });
});
