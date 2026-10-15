/**
 * P-007 (green-main-cycle-time-2026-10-08#D-040): an admission must not add red, and when its
 * radius was too wide to pre-check (over-cap), the red round that follows must NAME it. Each red
 * round attributes every newly red signature entry to the admissions in its window, with the
 * entry's leg and a basis, stores that on the round, and keeps the queue awaiting the fixer.
 */
import { describe, expect, it } from 'vitest';
import {
  FROZEN_REPAIR_ATTRIBUTION_ADMISSION_CAP,
  FROZEN_REPAIR_ROUND_ATTRIBUTION_CAP,
  attributeRoundReds,
  createFrozenCandidateRepairQueue,
  frozenRepairRoundAdmissionWindow,
  markFrozenRepairAdmitted,
  markFrozenRepairVerificationRed,
  parseFrozenCandidateRepairQueue,
  recordFrozenRepairSupersededRed,
  summarizeAdmissionRadius,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
  type FrozenRepairAdmissionRadiusSummary,
  type RepairSignatureInput,
} from './frozen-candidate-repair-queue';

const C = '1111111111111111111111111111111111111111';
const BASE = '0000000000000000000000000000000000000000';
const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H3 = 'cccccccccccccccccccccccccccccccccccccccc';
const T0 = 1_800_000_000_000;
const OLD = 'packages/operator-core/lib/old.test.ts';
const NEW = 'packages/operator-core/lib/release/new.test.ts';
const LEG = '@papercusp/operator-core';

const OVER_CAP: FrozenRepairAdmissionRadiusSummary = { status: 'skipped', reason: 'over-cap(5572/40)' };

function opened(): FrozenCandidateRepairQueue {
  return createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: [OLD], nowMs: T0 });
}

function admit(
  queue: FrozenCandidateRepairQueue,
  to: string,
  atMs: number,
  opts: { paths?: string[]; radius?: FrozenRepairAdmissionRadiusSummary; actor?: string } = {},
): FrozenCandidateRepairQueue {
  const paths = opts.paths ?? ['packages/operator-core/lib/release/admission-jobs.ts'];
  const entry: FrozenRepairAdmission = {
    atMs,
    actor: opts.actor ?? 'su-admitter',
    source: { ref: 'staging', sha: to },
    fromRepairHead: queue.repairHead,
    toRepairHead: to,
    paths,
    unchanged: [],
    blobs: Object.fromEntries(paths.map((path) => [path, 'deadbeef'])),
    precheck: { ran: true, commit: to, passing: [], failing: [], unmeasured: [], ...(opts.radius ? { radius: opts.radius } : {}) },
  };
  return markFrozenRepairAdmitted(queue, entry);
}

function redAt(queue: FrozenCandidateRepairQueue, head: string, atMs: number, failing: string[]): FrozenCandidateRepairQueue {
  return markFrozenRepairVerificationRed(queue, {
    repairHead: head,
    nowMs: atMs,
    signature: failing.map((id) => ({ kind: 'test-file' as const, id, recipe: `npm run test:file -- ${id}`, workspace: LEG })),
  });
}

function lastRound(queue: FrozenCandidateRepairQueue) {
  const rounds = queue.convergenceRounds ?? [];
  return rounds[rounds.length - 1];
}

describe('P-007 (#D-040) — a red round attributes newly red entries to its window admissions', () => {
  it('an over-cap admission followed by a new red test is named unmeasured-radius, with test and leg, and the queue stays awaiting-fixer', () => {
    const admitted = admit(opened(), H1, T0 + 10, { radius: OVER_CAP });
    const red = redAt(admitted, H1, T0 + 20, [OLD, NEW]);
    expect(red.phase).toBe('awaiting-fixer');
    expect(lastRound(red)?.attributions).toEqual([
      {
        entry: `test-file:${NEW}`,
        leg: LEG,
        basis: 'unmeasured-radius',
        admissions: [{ actor: 'su-admitter', toRepairHead: H1, atMs: T0 + 10, basis: 'unmeasured-radius' }],
      },
    ]);
  });

  it('does not attribute a red that was already in the prior signature', () => {
    const red = redAt(admit(opened(), H1, T0 + 10, { radius: OVER_CAP }), H1, T0 + 20, [OLD]);
    expect(lastRound(red)?.attributions).toBeUndefined();
  });

  it('an admission with no radius record reads as unmeasured-radius, never as guarded', () => {
    const red = redAt(admit(opened(), H1, T0 + 10), H1, T0 + 20, [NEW]);
    expect(lastRound(red)?.attributions?.[0]).toMatchObject({ basis: 'unmeasured-radius' });
  });

  it('a test inside the measured radius is measured-radius, and its leg comes from the radius when the entry has none', () => {
    const radius = summarizeAdmissionRadius({
      status: 'measured',
      reason: 'ok',
      guarded: [NEW],
      reportOnly: [],
      legs: { [NEW]: LEG },
    });
    const admitted = admit(opened(), H1, T0 + 10, { radius });
    const red = markFrozenRepairVerificationRed(admitted, { repairHead: H1, nowMs: T0 + 20, failingTests: [OLD, NEW] });
    expect(lastRound(red)?.attributions).toEqual([
      {
        entry: `test-file:${NEW}`,
        leg: LEG,
        basis: 'measured-radius',
        admissions: [{ actor: 'su-admitter', toRepairHead: H1, atMs: T0 + 10, basis: 'measured-radius' }],
      },
    ]);
  });

  it('matches a workspace-relative test id against a repo-relative radius file', () => {
    const radius: FrozenRepairAdmissionRadiusSummary = { status: 'measured', reason: 'ok', files: [NEW] };
    const red = redAt(admit(opened(), H1, T0 + 10, { radius }), H1, T0 + 20, ['lib/release/new.test.ts']);
    expect(lastRound(red)?.attributions?.[0]?.basis).toBe('measured-radius');
  });

  it('a measured radius that does not contain the test is outside-measured-radius', () => {
    const radius: FrozenRepairAdmissionRadiusSummary = { status: 'measured', reason: 'ok', files: ['packages/operator-core/lib/other.test.ts'] };
    const red = redAt(admit(opened(), H1, T0 + 10, { radius }), H1, T0 + 20, [NEW]);
    expect(lastRound(red)?.attributions?.[0]?.basis).toBe('outside-measured-radius');
  });

  it('an admitted test file is admitted-file, ranked first above a newer over-cap admission', () => {
    const first = admit(opened(), H1, T0 + 10, { paths: [NEW], actor: 'su-test-author', radius: { status: 'measured', reason: 'ok', files: [] } });
    const second = admit(first, H2, T0 + 11, { radius: OVER_CAP });
    const red = redAt(second, H2, T0 + 20, [NEW]);
    const attribution = lastRound(red)?.attributions?.[0];
    expect(attribution?.basis).toBe('admitted-file');
    expect(attribution?.admissions.map((a) => [a.actor, a.basis])).toEqual([
      ['su-test-author', 'admitted-file'],
      ['su-admitter', 'unmeasured-radius'],
    ]);
  });

  it('a task/lint/seed leg is unmeasured-radius even under a measured radius (a test radius cannot contain it)', () => {
    const radius: FrozenRepairAdmissionRadiusSummary = { status: 'measured', reason: 'ok', files: [NEW] };
    const red = markFrozenRepairVerificationRed(admit(opened(), H1, T0 + 10, { radius }), {
      repairHead: H1,
      nowMs: T0 + 20,
      failingTests: [OLD, `${LEG} :: lint:migration-forward-compat`],
    });
    expect(lastRound(red)?.attributions).toEqual([
      expect.objectContaining({
        entry: `workspace-task:${LEG} :: lint:migration-forward-compat`,
        leg: LEG,
        basis: 'unmeasured-radius',
      }),
    ]);
  });

  it('records basis none when no admission landed in the window', () => {
    const red = recordFrozenRepairSupersededRed(opened(), { measuredHead: H1, nowMs: T0 + 20, failingTests: [OLD, NEW] });
    expect(lastRound(red)?.attributions).toEqual([{ entry: `test-file:${NEW}`, basis: 'none', admissions: [] }]);
  });

  it('the window opens after the last judged round: an admission already judged red is not blamed again', () => {
    const round2 = redAt(admit(opened(), H1, T0 + 10, { radius: OVER_CAP, actor: 'su-first' }), H1, T0 + 20, [OLD]);
    const red = redAt(admit(round2, H2, T0 + 30, { radius: OVER_CAP, actor: 'su-second' }), H2, T0 + 40, [OLD, NEW]);
    expect(lastRound(red)?.attributions?.[0]?.admissions.map((a) => a.actor)).toEqual(['su-second']);
  });

  it('a superseded red closes the window at the measured head: a later admission is not blamed', () => {
    const twice = admit(admit(opened(), H1, T0 + 10, { radius: OVER_CAP, actor: 'su-first' }), H2, T0 + 11, {
      radius: OVER_CAP,
      actor: 'su-second',
    });
    const red = recordFrozenRepairSupersededRed(twice, { measuredHead: H1, nowMs: T0 + 20, failingTests: [OLD, NEW] });
    expect(red.phase).toBe(twice.phase);
    expect(lastRound(red)?.attributions?.[0]?.admissions.map((a) => a.actor)).toEqual(['su-first']);
  });

  it('bounds admissions per entry and entries per round, and says how many admissions it cut', () => {
    let queue = opened();
    const heads = Array.from({ length: FROZEN_REPAIR_ATTRIBUTION_ADMISSION_CAP + 2 }, (_, i) => String(i + 2).repeat(40).slice(0, 40));
    heads.forEach((head, i) => {
      queue = admit(queue, head, T0 + 10 + i, { radius: OVER_CAP, actor: `su-${i}` });
    });
    const reds = Array.from({ length: FROZEN_REPAIR_ROUND_ATTRIBUTION_CAP + 5 }, (_, i) => `packages/x/lib/n${i}.test.ts`);
    const red = redAt(queue, queue.repairHead, T0 + 100, reds);
    const attributions = lastRound(red)?.attributions ?? [];
    expect(attributions).toHaveLength(FROZEN_REPAIR_ROUND_ATTRIBUTION_CAP);
    expect(attributions[0]?.admissions).toHaveLength(FROZEN_REPAIR_ATTRIBUTION_ADMISSION_CAP);
    expect(attributions[0]?.omittedAdmissions).toBe(2);
    expect(attributions[0]?.admissions[0]?.actor).toBe(`su-${heads.length - 1}`);
  });

  it('round-trips attributions and the admission radius summary through the persisted row', () => {
    const red = redAt(admit(opened(), H1, T0 + 10, { radius: OVER_CAP }), H1, T0 + 20, [OLD, NEW]);
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(red)));
    expect(lastRound(parsed as FrozenCandidateRepairQueue)?.attributions).toEqual(lastRound(red)?.attributions);
    expect(parsed?.admissions?.[0]?.precheck?.radius).toEqual(OVER_CAP);
  });

  it('drops a malformed attribution or radius on parse instead of guessing', () => {
    const red = redAt(admit(opened(), H1, T0 + 10, { radius: OVER_CAP }), H1, T0 + 20, [OLD, NEW]);
    const raw = JSON.parse(JSON.stringify(red));
    raw.convergenceRounds[raw.convergenceRounds.length - 1].attributions.push({ entry: '', basis: 'bogus' });
    raw.admissions[0].precheck.radius = { status: 'skipped', reason: 'over-cap(5/4)', files: [NEW] };
    const parsed = parseFrozenCandidateRepairQueue(raw) as FrozenCandidateRepairQueue;
    expect(lastRound(parsed)?.attributions).toHaveLength(1);
    expect(parsed.admissions?.[0]?.precheck?.radius).toBeUndefined();
  });
});

describe('P-007 (#D-040) — a file of a whole red test task was never known green, so it is not newly red', () => {
  const LANE = `${LEG} :: test:lane-stateful`;
  const VITE = '@papercusp/operator-vite';
  const A = 'lib/release/a.test.ts';
  const file = (id: string, workspace = LEG): RepairSignatureInput => ({ kind: 'test-file', id, recipe: `npm run test:file -- ${id}`, workspace });
  const marker = (workspace: string): RepairSignatureInput => ({ kind: 'workspace-task', id: workspace, recipe: `npm run test -w ${workspace}`, workspace });
  const openedWith = (failingTests: string[]) => createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests, nowMs: T0 });
  const redWith = (queue: FrozenCandidateRepairQueue, signature: RepairSignatureInput[]) =>
    markFrozenRepairVerificationRed(admit(queue, H1, T0 + 10, { radius: OVER_CAP }), { repairHead: H1, nowMs: T0 + 20, signature });

  it('a red test lane later named by its failing files blames no admission (a narrowed lane or a full-gate red)', () => {
    const red = redWith(openedWith([LANE]), [file(A), marker(LEG)]);
    expect(red.signature.map((e) => `${e.kind}:${e.id}`)).toEqual([`test-file:${A}`, `workspace-task:${LEG}`]);
    expect(lastRound(red)?.attributions).toBeUndefined();
  });

  it('a bare workspace marker with no file of its own is a whole-task red too', () => {
    expect(lastRound(redWith(openedWith([LEG]), [file(A), marker(LEG)]))?.attributions).toBeUndefined();
  });

  it('a marker paired with named files is not a whole-task red: a new file in that workspace is still blamed', () => {
    const red = redWith(openedWith([LEG, 'lib/old.test.ts']), [file('lib/old.test.ts'), file(A), marker(LEG)]);
    expect(lastRound(red)?.attributions?.map((a) => a.entry)).toEqual([`test-file:${A}`]);
  });

  it('a red lane covers only its own workspace: a new red file elsewhere is blamed with its marker', () => {
    const red = redWith(openedWith([LANE]), [file(A), marker(LEG), file('src/b.test.ts', VITE), marker(VITE)]);
    expect(lastRound(red)?.attributions?.map((a) => [a.entry, a.basis])).toEqual([
      ['test-file:src/b.test.ts', 'unmeasured-radius'],
      [`workspace-task:${VITE}`, 'unmeasured-radius'],
    ]);
  });

  it('another task of the same workspace is matched exactly by id, never covered by the red lane', () => {
    const pure = `${LEG} :: test:lane-pure`;
    const red = redWith(openedWith([LANE]), [{ kind: 'workspace-task', id: pure, recipe: `npm run test:lane-pure -w ${LEG}`, workspace: LEG }]);
    expect(lastRound(red)?.attributions?.map((a) => a.entry)).toEqual([`workspace-task:${pure}`]);
  });
});

describe('P-007 (#D-040) — the window and summary helpers', () => {
  it('a red at the candidate has an empty window', () => {
    expect(frozenRepairRoundAdmissionWindow(admit(opened(), H1, T0 + 10), C)).toEqual([]);
  });

  it('with no rounds recorded the window covers every admission up to the measured head', () => {
    const queue = admit(admit(opened(), H1, T0 + 10), H2, T0 + 11);
    const noRounds = { ...queue, convergenceRounds: [] };
    expect(frozenRepairRoundAdmissionWindow(noRounds, H2).map((a) => a.toRepairHead)).toEqual([H1, H2]);
    expect(frozenRepairRoundAdmissionWindow(noRounds, H3).map((a) => a.toRepairHead)).toEqual([H1, H2]);
  });

  it('attributeRoundReds names nothing when the next signature adds nothing', () => {
    const queue = admit(opened(), H1, T0 + 10, { radius: OVER_CAP });
    expect(attributeRoundReds(queue, queue.signature, H1)).toEqual([]);
  });

  it('summarizeAdmissionRadius keeps files only when measured and bounds them', () => {
    expect(summarizeAdmissionRadius({ status: 'skipped', reason: 'over-cap(5572/40)', guarded: [], reportOnly: [], legs: {} })).toEqual(OVER_CAP);
    const many = Array.from({ length: 50 }, (_, i) => `lib/t${i}.test.ts`);
    const summary = summarizeAdmissionRadius({
      status: 'measured',
      reason: 'ok',
      guarded: many.slice(0, 30),
      reportOnly: many.slice(30),
      legs: Object.fromEntries(many.map((file) => [file, LEG])),
    });
    expect(summary?.files).toHaveLength(40);
    expect(Object.keys(summary?.legs ?? {})).toHaveLength(40);
    expect(summarizeAdmissionRadius(undefined)).toBeUndefined();
  });
});
