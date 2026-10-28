import { describe, expect, it } from 'vitest';
import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairAdmitted,
  parseAdmissionPrecheckRecord,
  parseAppliedAdmissionSources,
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
      mode: 'multi-source',
      // change-provenance-and-admission-throughput-2026-10-27#P-002: the ordered sources a
      // multi-source admission applied, one entry of each kind.
      sources: [
        { index: 0, kind: 'whole-blob', paths: ['lib/b.ts'], sourceCommit: C1, pinned: true, headAfter: C1 },
        {
          index: 1,
          kind: 'committed-patch',
          paths: ['lib/a.test.ts'],
          patches: [{ commit: C2, parent: C, sha256: 'a'.repeat(64) }],
          headAfter: C2,
        },
      ],
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
    // Mode-exclusive fields: `patch`/`patches` are kept only in committed-patch mode, `sources`
    // only in multi-source mode (P-002). Each variant drops the OTHER mode's fields, and every
    // remaining field must round-trip unchanged, so each field is asserted in the mode it belongs to.
    const without = (...keys: Array<keyof FrozenRepairAdmission>): FrozenRepairAdmission =>
      Object.fromEntries(Object.entries(full).filter(([k]) => !keys.includes(k as keyof FrozenRepairAdmission))) as unknown as FrozenRepairAdmission;
    const variants: FrozenRepairAdmission[] = [
      without('patch', 'patches'),
      { ...without('sources'), mode: 'committed-patch' },
    ];
    for (const admission of variants) {
      const parsed = roundTrip(markFrozenRepairAdmitted(queue, admission));
      expect(parsed?.admissions?.at(-1)).toEqual(admission);
    }
  });
});

// change-provenance-and-admission-throughput-2026-10-27#P-002: a recorded multi-source
// admission keeps its ordered sources; one malformed entry drops the whole list (never a guess).
describe('parseAppliedAdmissionSources', () => {
  const whole = { index: 0, kind: 'whole-blob', paths: ['lib/b.ts'], sourceCommit: C1, pinned: false, headAfter: C1 };
  const patch = {
    index: 1,
    kind: 'committed-patch',
    paths: ['lib/a.test.ts'],
    patches: [{ commit: C2, parent: C, sha256: 'a'.repeat(64) }],
    headAfter: C2,
  };

  it('keeps every entry in its recorded order', () => {
    expect(parseAppliedAdmissionSources([whole, patch])).toEqual([whole, patch]);
    expect(parseAppliedAdmissionSources([patch, whole])).toEqual([patch, whole]);
  });

  it.each([
    ['an empty list', []],
    ['a non-array', { 0: whole }],
    ['an unknown kind', [whole, { ...patch, kind: 'hunk-exact' }]],
    ['a whole-blob without pinned', [{ ...whole, pinned: undefined }]],
    ['a patch with a bad digest', [{ ...patch, patches: [{ commit: C2, parent: C, sha256: 'bad' }] }]],
    ['an entry with no paths', [{ ...whole, paths: [] }]],
    ['a bad headAfter', [{ ...whole, headAfter: 'HEAD' }]],
  ])('returns null for %s', (_label, raw) => {
    expect(parseAppliedAdmissionSources(raw)).toBeNull();
  });

  it('a multi-source admission with malformed sources keeps no mode and no sources', () => {
    const queue = admittedWith(undefined);
    const raw = JSON.parse(JSON.stringify(queue));
    raw.admissions[0].mode = 'multi-source';
    raw.admissions[0].sources = [{ ...whole, kind: 'other' }];
    const parsed = parseFrozenCandidateRepairQueue(raw);
    expect(parsed?.admissions?.[0]).not.toHaveProperty('sources');
    expect(parsed?.admissions?.[0]).not.toHaveProperty('mode');
  });
});
