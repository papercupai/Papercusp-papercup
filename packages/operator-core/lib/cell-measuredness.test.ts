/**
 * main-green-status-visible-2026-09-03 P-012 — THE MEASURED-NESS INVARIANT, FALSIFIED.
 *
 * "Measured empty" must never render as "nothing failing". This file proves the guard
 * that enforces it can actually FAIL — with synthetic payloads shaped exactly like the
 * defect the D-001 audit found (`stillBrokenCount: 0`, `distinctFailingFiles: []`,
 * `filesJudged: 0`, `unavailable: null` — the "0 / none-failing having judged zero
 * files" reading), against deliberately-broken pairings. The LIVE sweep over every
 * built-in cell lives in cell-assessment-reality.test.ts beside the other P-004 guards;
 * this file is the controls, permanently, not a one-off probe.
 *
 * The read-time half is proven here too: a paired evidence path arrives in the
 * `readCell` result WITH its flag, and the prose surface prints the flag in the same
 * breath — so no surface can carry the bare `[]`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { readCell, formatCellAssessment } from './cell-read';
import { registerCell, validateCellSpec, __resetCellRegistryForTests, type CellSpec } from './cell-registry';
import { GATE_CANDIDATE_FAILURES_CELL } from './cell-registrations';
import {
  COUNT_OR_LIST_LEAF,
  INSTANT_OR_DURATION_LEAF,
  formatMeasurednessViolations,
  hoistedPaths,
  isCountOrList,
  isFlagShaped,
  measurednessStructuralViolations,
  measurednessViolations,
  valueAtPath,
} from './cell-measuredness';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };

/**
 * THE DEFECT-SHAPED PAYLOAD. Every count is zero, every list is empty, and the flag says
 * nothing was measured — the reading that used to come back as `none-failing`.
 */
const MEASURED_EMPTY = {
  gate: {
    candidateFailures: {
      candidateSha: 'd165d7537d20',
      repairHeadSha: '424436e78826',
      stillBrokenCount: 0,
      // EI-22260078732220798: the qualifier the `repairs-outstanding` prose tells the reader
      // to compare against `stillBrokenCount`. Declared evidence now, so it has to be in the
      // modelled payload too — a declared path the payload omits downgrades the whole read to
      // `unavailable`, which is what this suite caught.
      stillBrokenNeedsRunCount: 0,
      unmeasuredCount: 0,
      distinctFailingFiles: [],
      filesJudged: 0,
      scope: 'affected radius',
      nonTestLegsMeasured: 'not-recorded',
      // P-007 added `outstanding` beside `perLeg`; both are paired with nonTestLegsMeasured.
      nonTestLegs: { perLeg: [], outstanding: [] },
      unavailable: 'test_runs unreachable',
      assessment: 'unmeasured',
    },
  },
};

const CF = GATE_CANDIDATE_FAILURES_CELL;
const brokenPairing = (measuredBy: Readonly<Record<string, string>> | undefined): CellSpec => ({
  ...CF,
  assessment: { ...CF.assessment!, ...(measuredBy === undefined ? { measuredBy: undefined } : { measuredBy }) },
});

describe('P-012: classification — what counts as a count or a list', () => {
  it('a finite number is a count; an instant or duration is not', () => {
    expect(isCountOrList('gate.consecutiveReds', 104)).toBe(true);
    expect(isCountOrList('coverage.pct', 0)).toBe(true);
    expect(isCountOrList('gate.ownerBrief.vintageSpreadMs', 12_000)).toBe(false);
    expect(isCountOrList('gate.freezeDisposition.observedAtMs', 1_788_453_815_478)).toBe(false);
    expect(isCountOrList('x.count', Number.NaN)).toBe(false);
  });
  it('an array is a list, empty or not', () => {
    expect(isCountOrList('gate.ownerBrief.whyNot.failingLegs', [])).toBe(true);
    expect(isCountOrList('gate.qualification.blockers', ['a'])).toBe(true);
  });
  it('a null is a count only under a count-shaped leaf — THE unmeasured rendering', () => {
    expect(isCountOrList('gate.candidateFailures.stillBrokenCount', null)).toBe(true);
    expect(isCountOrList('gate.retriage.abandonedFailingFiles', null)).toBe(true);
    expect(isCountOrList('gate.convergence.shrinkTotal', null)).toBe(true);
    expect(isCountOrList('gate.freezeDisposition.reason', null)).toBe(false);
    expect(isCountOrList('gate.convergence.lastMeasuredAtMs', null)).toBe(false);
  });
  it('booleans, strings and objects are not subjects', () => {
    expect(isCountOrList('gate.ownerBrief.whyNot.measured', false)).toBe(false);
    expect(isCountOrList('gate.candidateFailures.unavailable', 'no-frozen-candidate')).toBe(false);
    expect(isCountOrList('gate.inconclusive', { status: 'x' })).toBe(false);
  });
  it('the leaf regexes are anchored to the LAST segment — a prefix cannot smuggle a match', () => {
    expect(COUNT_OR_LIST_LEAF.test('count')).toBe(true);
    expect(COUNT_OR_LIST_LEAF.test('counted')).toBe(false);
    expect(INSTANT_OR_DURATION_LEAF.test('observedAtMs')).toBe(true);
    expect(INSTANT_OR_DURATION_LEAF.test('atlas')).toBe(false);
  });
  it('a flag is a boolean, a string or null — never a count; the unknownHoist list is the one exception', () => {
    expect(isFlagShaped(false, { isUnknownHoist: false })).toBe(true);
    expect(isFlagShaped('carried', { isUnknownHoist: false })).toBe(true);
    expect(isFlagShaped(null, { isUnknownHoist: false })).toBe(true);
    expect(isFlagShaped(3, { isUnknownHoist: false })).toBe(false);
    expect(isFlagShaped([], { isUnknownHoist: false })).toBe(false);
    expect(isFlagShaped({}, { isUnknownHoist: false })).toBe(false);
    expect(isFlagShaped([{ leg: 'x' }], { isUnknownHoist: true })).toBe(true);
    expect(isFlagShaped({ a: 1 }, { isUnknownHoist: true })).toBe(false);
  });
  it('valueAtPath keeps the MISSING ≠ NULL split pathExists makes', () => {
    expect(valueAtPath({ a: { b: null } }, 'a.b')).toEqual({ exists: true, value: null });
    expect(valueAtPath({ a: null }, 'a.b')).toEqual({ exists: false, value: undefined, missingAt: 'a.b' });
    expect(valueAtPath({}, 'a')).toEqual({ exists: false, value: undefined, missingAt: 'a' });
  });
  it('hoistedPaths is headline + evidence + unknownHoist, deduplicated', () => {
    expect(hoistedPaths(CF)).toEqual([
      'gate.candidateFailures.stillBrokenCount',
      ...CF.assessment!.evidence,
      'gate.candidateFailures.unavailable',
    ]);
  });
});

describe('P-012: the guard is falsifiable — deliberately broken pairings against the defect-shaped payload', () => {
  it('calibration: the SHIPPED candidateFailures pairing passes on the measured-empty payload', () => {
    const v = measurednessViolations(CF, MEASURED_EMPTY);
    expect(v, formatMeasurednessViolations(v)).toEqual([]);
  });

  it('names EVERY unpaired count and list when the pairing is removed — the defect, by path', () => {
    const v = measurednessViolations(brokenPairing(undefined), MEASURED_EMPTY);
    expect(v.map((x) => x.kind)).toEqual(['unpaired-count-or-list', 'unpaired-count-or-list', 'unpaired-count-or-list', 'unpaired-count-or-list', 'unpaired-count-or-list', 'unpaired-count-or-list']);
    expect(v.map((x) => x.path)).toEqual([
      'gate.candidateFailures.stillBrokenCount',
      // EI-22260078732220798: the qualifier is a count too, so removing the pairing must name
      // it as well — otherwise the guard would go quiet on exactly the field whose silent
      // zero this pairing exists to distinguish from "never measured".
      'gate.candidateFailures.stillBrokenNeedsRunCount',
      'gate.candidateFailures.distinctFailingFiles',
      'gate.candidateFailures.filesJudged',
      'gate.candidateFailures.nonTestLegs.perLeg',
      // P-007: the outstanding-leg list is a list like perLeg, paired with the same flag.
      'gate.candidateFailures.nonTestLegs.outstanding',
    ]);
    // The message says what to do, not just that it is wrong.
    expect(v[0]!.detail).toContain('assessment.measuredBy["gate.candidateFailures.stillBrokenCount"]');
  });

  it('a PARTIAL pairing still names the ones left out', () => {
    const v = measurednessViolations(
      brokenPairing({ 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.unavailable' }),
      MEASURED_EMPTY,
    );
    expect(v.map((x) => x.path)).toEqual([
      'gate.candidateFailures.stillBrokenNeedsRunCount',
      'gate.candidateFailures.distinctFailingFiles',
      'gate.candidateFailures.filesJudged',
      'gate.candidateFailures.nonTestLegs.perLeg',
      'gate.candidateFailures.nonTestLegs.outstanding',
    ]);
  });

  it('refuses a flag that is not hoisted — the pair would not travel together', () => {
    const v = measurednessViolations(
      brokenPairing({ ...CF.assessment!.measuredBy, 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.candidateSha' }),
      MEASURED_EMPTY,
    );
    expect(v.map((x) => [x.kind, x.path])).toEqual([['flag-not-hoisted', 'gate.candidateFailures.candidateSha']]);
  });

  it('refuses a COUNT as a flag — a count cannot vouch for a count', () => {
    const v = measurednessViolations(
      brokenPairing({ ...CF.assessment!.measuredBy, 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.filesJudged' }),
      MEASURED_EMPTY,
    );
    expect(v.map((x) => [x.kind, x.path])).toEqual([['flag-not-a-flag', 'gate.candidateFailures.filesJudged']]);
  });

  it('refuses a LIST as a flag, but accepts the unknownHoist list as one', () => {
    const listFlag = measurednessViolations(
      brokenPairing({ ...CF.assessment!.measuredBy, 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.distinctFailingFiles' }),
      MEASURED_EMPTY,
    );
    expect(listFlag.map((x) => x.kind)).toEqual(['flag-not-a-flag']);

    const hoistList: CellSpec = {
      ...CF,
      unknownHoist: 'gate.candidateFailures.unknownLegs',
      assessment: {
        ...CF.assessment!,
        // `unavailable` stops being the unknownHoist here, so it must be hoisted as
        // evidence for the other pairs to keep travelling.
        evidence: [...CF.assessment!.evidence, 'gate.candidateFailures.unknownLegs', 'gate.candidateFailures.unavailable'],
        measuredBy: { ...CF.assessment!.measuredBy, 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.unknownLegs' },
      },
    };
    const payload = { gate: { candidateFailures: { ...MEASURED_EMPTY.gate.candidateFailures, unknownLegs: [{ leg: 'stillBrokenCount' }] } } };
    const v = measurednessViolations(hoistList, payload);
    expect(v, formatMeasurednessViolations(v)).toEqual([]);
  });

  it('reports a flag that did not ARRIVE as pairing drift, not as a pass', () => {
    const payload = { gate: { candidateFailures: { ...MEASURED_EMPTY.gate.candidateFailures, nonTestLegsMeasured: undefined } } };
    delete (payload.gate.candidateFailures as Record<string, unknown>).nonTestLegsMeasured;
    const v = measurednessViolations(CF, payload);
    // Reported PER PAIR: both `perLeg` and (P-007) `outstanding` vouch through this one flag,
    // so each names it — a reader fixing one subject is told the other is affected too.
    expect(v.map((x) => [x.kind, x.path])).toEqual([
      ['flag-absent', 'gate.candidateFailures.nonTestLegsMeasured'],
      ['flag-absent', 'gate.candidateFailures.nonTestLegsMeasured'],
    ]);
  });

  it('refuses a dangling pair, a self-pair and a hoist-as-subject — with or without a payload', () => {
    const structural = measurednessStructuralViolations(
      brokenPairing({
        'gate.candidateFailures.nowhere': 'gate.candidateFailures.unavailable',
        'gate.candidateFailures.filesJudged': 'gate.candidateFailures.filesJudged',
        'gate.candidateFailures.unavailable': 'gate.candidateFailures.scope',
      }),
    );
    expect(structural.map((x) => x.kind).sort()).toEqual(['hoist-paired', 'pair-not-hoisted', 'self-paired']);
    // The payload-bearing predicate carries the same structural findings first.
    const withPayload = measurednessViolations(
      brokenPairing({ 'gate.candidateFailures.nowhere': 'gate.candidateFailures.unavailable' }),
      MEASURED_EMPTY,
    );
    expect(withPayload[0]!.kind).toBe('pair-not-hoisted');
  });

  it('the unknownHoist is never a SUBJECT even though it is a list', () => {
    const payload = { gate: { candidateFailures: { ...MEASURED_EMPTY.gate.candidateFailures, unavailable: null } } };
    // `unavailable` is null here (measured); nothing pairs it and nothing should ask to.
    const v = measurednessViolations(CF, payload);
    expect(v, formatMeasurednessViolations(v)).toEqual([]);
  });

  it('a nullable:false cell is paired BY TOTALITY — its counts are exempt, its declared pairs are still checked', () => {
    const total: CellSpec = {
      ...CF,
      nullable: false,
      unknownHoist: undefined,
      whyTotal: 'test: the resolver counts or throws',
      assessment: { ...CF.assessment!, measuredBy: undefined },
    };
    expect(measurednessViolations(total, MEASURED_EMPTY)).toEqual([]);
    const totalButDangling: CellSpec = {
      ...total,
      assessment: { ...total.assessment!, measuredBy: { 'gate.candidateFailures.nowhere': 'gate.candidateFailures.scope' } },
    };
    expect(measurednessViolations(totalButDangling, MEASURED_EMPTY).map((x) => x.kind)).toEqual(['pair-not-hoisted']);
  });

  it('a payload-less run keeps the structural half and skips the type half — and says nothing false', () => {
    // No payload ⇒ an unpaired count cannot be seen; the structural findings still are.
    expect(measurednessViolations(brokenPairing(undefined), undefined)).toEqual([]);
    expect(
      measurednessViolations(brokenPairing({ 'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.nowhere' }), undefined).map((x) => x.kind),
    ).toEqual(['flag-not-hoisted']);
  });
});

describe('P-012: the registry refuses a malformed pairing at REGISTRATION', () => {
  it('rejects flag-not-hoisted / pair-not-hoisted / self-paired / hoist-paired as axis-2 rules, and accepts the shipped spec', () => {
    expect(validateCellSpec(CF).filter((r) => r.rule.startsWith('measured-by-'))).toEqual([]);
    const rejected = validateCellSpec(
      brokenPairing({
        'gate.candidateFailures.stillBrokenCount': 'gate.candidateFailures.candidateSha',
        'gate.candidateFailures.nowhere': 'gate.candidateFailures.unavailable',
        'gate.candidateFailures.filesJudged': 'gate.candidateFailures.filesJudged',
        'gate.candidateFailures.unavailable': 'gate.candidateFailures.scope',
      }),
    ).filter((r) => r.rule.startsWith('measured-by-'));
    expect(rejected.map((r) => r.rule).sort()).toEqual([
      'measured-by-flag-not-hoisted',
      'measured-by-hoist-paired',
      'measured-by-pair-not-hoisted',
      'measured-by-self-paired',
    ]);
    expect(rejected.every((r) => r.axis === 2)).toBe(true);
  });
});

describe('P-012: the read surface carries the flag WITH the value', () => {
  beforeEach(() => {
    __resetCellRegistryForTests();
    dispatchReadOnlyTool.mockReset();
  });

  it('a paired evidence path arrives with `measuredBy` resolved off the SAME payload, and the prose prints it beside the value', async () => {
    registerCell(CF);
    dispatchReadOnlyTool.mockResolvedValue(MEASURED_EMPTY);
    const r = await readCell(CF.cell, READER, ENV);
    expect(r.status).toBe('value');
    if (r.status !== 'value') return;
    const a = r.assessment!;
    expect(a.status).toBe('resolved');
    if (a.status !== 'resolved') return;
    expect(a.code).toBe('unmeasured');
    const files = a.evidence.find((e) => e.path === 'gate.candidateFailures.distinctFailingFiles')!;
    expect(files.value).toEqual([]);
    expect(files.measuredBy).toEqual({ path: 'gate.candidateFailures.unavailable', value: 'test_runs unreachable' });
    const perLeg = a.evidence.find((e) => e.path === 'gate.candidateFailures.nonTestLegs.perLeg')!;
    expect(perLeg.measuredBy).toEqual({ path: 'gate.candidateFailures.nonTestLegsMeasured', value: 'not-recorded' });
    // An UNPAIRED evidence path carries no flag — the field is present exactly when declared.
    const scope = a.evidence.find((e) => e.path === 'gate.candidateFailures.scope')!;
    expect(scope.measuredBy).toBeUndefined();

    const prose = formatCellAssessment(a, CF.cell);
    // The flag is printed in the SAME clause as the value — `briefCellValue`'s exact
    // rendering of `[]` and of a string is its own business; the pairing is what is pinned.
    expect(prose).toMatch(
      /gate\.candidateFailures\.distinctFailingFiles = [^;]*\(measured-ness: gate\.candidateFailures\.unavailable = [^;)]*test_runs unreachable[^;)]*\)/,
    );
    expect(prose).toMatch(
      /gate\.candidateFailures\.nonTestLegs\.perLeg = [^;]*\(measured-ness: gate\.candidateFailures\.nonTestLegsMeasured = [^;)]*not-recorded[^;)]*\)/,
    );
  });

  it('a flag that did not arrive is reported as pairing DRIFT in the same slot, never as measured', async () => {
    registerCell(CF);
    const payload = { gate: { candidateFailures: { ...MEASURED_EMPTY.gate.candidateFailures } } };
    delete (payload.gate.candidateFailures as Record<string, unknown>).nonTestLegsMeasured;
    dispatchReadOnlyTool.mockResolvedValue(payload);
    const r = await readCell(CF.cell, READER, ENV);
    if (r.status !== 'value') throw new Error(`expected a value read, got ${r.status}`);
    const a = r.assessment!;
    // `nonTestLegsMeasured` is ALSO an evidence path, so the whole assessment downgrades
    // (P-004 rule) — and the pairing on perLeg reports the same absence beside the list.
    const perLeg = a.evidence.find((e) => e.path === 'gate.candidateFailures.nonTestLegs.perLeg')!;
    expect(perLeg.measuredBy).toEqual({ path: 'gate.candidateFailures.nonTestLegsMeasured', value: null, drifted: true });
    expect(formatCellAssessment(a, CF.cell)).toContain('measured-ness flag gate.candidateFailures.nonTestLegsMeasured ABSENT');
  });
});
