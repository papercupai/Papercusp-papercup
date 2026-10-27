import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairAdmitted,
  parseAdmissionPrecheckRecord,
  parseFrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from './frozen-candidate-repair-queue';

// WI-10007480: the admission door persists `precheck` on every admission, but the queue parser
// rebuilt admissions field by field without it, so the first read-modify-write erased the only
// evidence that an admission's pre-check ran (0 of 25 live admissions carried one).

const C = '1111111111111111111111111111111111111111';
const C1 = '2222222222222222222222222222222222222222';
const C2 = '3333333333333333333333333333333333333333';
const BASE = '4444444444444444444444444444444444444444';
const T0 = 1_800_000_000_000;

function admittedWith(precheck: FrozenRepairAdmission['precheck']) {
  const queue = createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: ['lib/a.test.ts'], nowMs: T0 });
  const entry: FrozenRepairAdmission = {
    atMs: T0 + 10,
    actor: 'su-door',
    source: { ref: 'staging', sha: C1 },
    fromRepairHead: C,
    toRepairHead: C2,
    paths: ['lib/a.test.ts'],
    unchanged: [],
    blobs: { 'lib/a.test.ts': C1 },
    mode: 'hunk-exact',
    ...(precheck ? { precheck } : {}),
  };
  return markFrozenRepairAdmitted(queue, entry);
}

/** What every persisted read-modify-write does to the row: JSON out, parse back in. */
function roundTrip<T>(value: T) {
  return parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(value)));
}

describe('admission precheck survives the queue round trip (WI-10007480)', () => {
  it('keeps a ran-and-passed precheck record verbatim', () => {
    const precheck = {
      ran: true,
      commit: C2,
      passing: ['lib/a.test.ts'],
      failing: [],
      unmeasured: [],
      fixes: ['lib/a.test.ts'],
    };
    const parsed = roundTrip(admittedWith(precheck));
    expect(parsed?.admissions?.[0]?.precheck).toEqual(precheck);
  });

  it('keeps a not-run record with its reason and the population it did not measure', () => {
    const precheck = { ran: false, reason: 'skipped', precheckReason: 'docs-only change, no tests', wouldRun: ['lib/a.test.ts'] };
    const parsed = roundTrip(admittedWith(precheck));
    expect(parsed?.admissions?.[0]?.precheck).toEqual(precheck);
  });

  it('survives a second round trip (the erasure happened on the FIRST rewrite)', () => {
    const precheck = { ran: true, commit: C2, passing: ['lib/a.test.ts'], failing: [] };
    const twice = roundTrip(roundTrip(admittedWith(precheck)));
    expect(twice?.admissions?.[0]?.precheck).toEqual(precheck);
  });

  it('an admission written without a precheck still parses, with none invented', () => {
    const parsed = roundTrip(admittedWith(undefined));
    expect(parsed?.admissions).toHaveLength(1);
    expect(parsed?.admissions?.[0]).not.toHaveProperty('precheck');
  });
});

describe('parseAdmissionPrecheckRecord', () => {
  it('drops a record without a boolean `ran` instead of guessing', () => {
    expect(parseAdmissionPrecheckRecord({ passing: [] })).toBeUndefined();
    expect(parseAdmissionPrecheckRecord('ran')).toBeUndefined();
    expect(parseAdmissionPrecheckRecord(null)).toBeUndefined();
    expect(parseAdmissionPrecheckRecord([{ ran: true }])).toBeUndefined();
  });

  it('drops malformed lists and blank strings but keeps the rest', () => {
    expect(parseAdmissionPrecheckRecord({ ran: true, failing: [1, 2], passing: ['x'], reason: '' })).toEqual({
      ran: true,
      passing: ['x'],
    });
  });
});

// P-019 (green-main-cycle-time-2026-10-08) recurrence guard for the CLASS behind WI-10007480:
// 7cc2ada8df (2026-09-11) added `precheck` to FrozenRepairAdmission while parseAdmissions
// (53f30f98ab, 2026-09-03) rebuilt admissions field by field and never learned it, so the field
// was erased on every persisted read-modify-write for four weeks with nothing failing.
// `Required<>` makes this fixture a COMPILE error the moment the interface gains a field, and the
// deep-equal round trip then fails until the parser carries it. Fill a new field with a
// well-formed value here; never loosen the type or narrow the assertion to get green.
describe('every FrozenRepairAdmission field survives the queue round trip (P-019 class guard)', () => {
  it('a fully-populated admission round-trips unchanged', () => {
    const queue = createFrozenCandidateRepairQueue({ candidate: C, base: BASE, failingTests: ['lib/a.test.ts'], nowMs: T0 });
    const full: Required<FrozenRepairAdmission> = {
      atMs: T0 + 10,
      actor: 'su-door',
      source: { ref: 'staging', sha: C1 },
      fromRepairHead: C,
      toRepairHead: C2,
      paths: ['lib/a.test.ts'],
      unchanged: ['lib/b.ts'],
      blobs: { 'lib/a.test.ts': C1, 'lib/gone.ts': null },
      reason: 'repair the red leg',
      mode: 'committed-patch',
      precheck: {
        ran: true,
        reason: 'measured',
        detail: 'detail',
        precheckReason: 'why',
        commit: C2,
        wouldRun: ['lib/a.test.ts'],
        fixes: ['lib/a.test.ts'],
        passing: ['lib/a.test.ts'],
        failing: ['lib/c.test.ts'],
        unmeasured: ['lib/d.test.ts'],
      },
      patch: { commit: C2, parent: C, sha256: 'a'.repeat(64) },
      patches: [
        { commit: C1, parent: BASE, sha256: 'b'.repeat(64) },
        { commit: C2, parent: C, sha256: 'a'.repeat(64) },
      ],
      hunks: { 'lib/a.test.ts': { applied: 2, agents: ['su-door'] } },
      ledgerRowIds: [11, 12],
      foreignHunksAccepted: 1,
      foreignAgents: ['su-peer'],
      provenance: 'reconciled-from-ref',
    };
    const parsed = roundTrip(markFrozenRepairAdmitted(queue, full));
    expect(parsed?.admissions?.at(-1)).toEqual(full);
  });
});
