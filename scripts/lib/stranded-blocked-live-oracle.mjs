// Oracle for clause AUTO-BAR-R-10-P-005@3 of event-wait-settlement-2026-10-20 (rubric R-10, #D-006):
//   "An item left blocked with every blocker cleared returns to open on the next re-check sweep tick."
// The live probe (docs/evidence/ews-p005-r10-stranded-live/probe.sql) returns ONE `psql -At` row of
// eight integers, in R10_COLUMNS order. This module takes every pass/fail decision on that row so the
// evidence run (docs/evidence/ews-p005-r10-stranded-live/run.mjs) only executes SQL and records output.
//
// R-10 passes when ALL of:
//   - sweep-is-live: the re-check sweep's host routine (gate-watcher-tick) last started at most
//     R10_MAX_TICK_AGE_S ago. A stopped sweep makes "nothing is stranded" vacuous, so it fails; the probe
//     reports -1 when the routine row is missing.
//   - every-candidate-classified-once: the five buckets sum to all_cleared_blocked. The first live reading
//     (2026-10-21) used independent FILTERs whose hold flags could be NULL, so a stranded row with no
//     needsOwnerAction key fell into no bucket at all; this assertion fails that whole class.
//   - no-unknown-times: no candidate lacks state_changed_at or a clear time (an unclassifiable row could
//     hide a stranded one).
//   - no-stranded-item (the clause's falsifier): no candidate is blocked, has every blocker cleared before
//     the last completed tick, and has no other hold.
//   - repair-path-observed: the stranded repair has written at least one audit row (positive control that
//     the running build carries P-005, so a zero above is a measurement, not an absence of the code).

export const R10_MAX_TICK_AGE_S = 900;
export const R10_COLUMNS = [
  'all_cleared_blocked',
  'reblocked_after_clear',
  'other_hold',
  'stranded',
  'cleared_since_tick',
  'missing_times',
  'tick_age_s',
  'repair_audit_rows',
];
const BUCKETS = ['reblocked_after_clear', 'other_hold', 'stranded', 'cleared_since_tick', 'missing_times'];

/** Parse one `psql -At` line of the R-10 probe. Throws on any shape other than eight integer fields. */
export function parseR10Row(line) {
  const text = String(line ?? '').trim();
  const parts = text.split('|');
  if (parts.length !== R10_COLUMNS.length) {
    throw new Error(`R-10 probe row must have ${R10_COLUMNS.length} fields, got ${parts.length}: ${JSON.stringify(text)}`);
  }
  const row = {};
  R10_COLUMNS.forEach((col, i) => {
    const raw = parts[i].trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n)) throw new Error(`R-10 probe field ${col} is not an integer: ${JSON.stringify(raw)}`);
    row[col] = n;
  });
  return row;
}

/** Judge a parsed R-10 probe row. Returns { passed, assertions[] }; every assertion carries its evidence. */
export function judgeR10(row) {
  const bucketSum = BUCKETS.reduce((sum, b) => sum + row[b], 0);
  const assertions = [
    {
      id: 'sweep-is-live',
      passed: row.tick_age_s >= 0 && row.tick_age_s <= R10_MAX_TICK_AGE_S,
      evidence: `gate-watcher-tick last started ${row.tick_age_s}s ago (limit ${R10_MAX_TICK_AGE_S}s; -1 = routine row missing)`,
    },
    {
      id: 'every-candidate-classified-once',
      passed: bucketSum === row.all_cleared_blocked,
      evidence: `${BUCKETS.map((b) => `${b}=${row[b]}`).join(' + ')} = ${bucketSum}; all_cleared_blocked=${row.all_cleared_blocked}`,
    },
    {
      id: 'no-unknown-times',
      passed: row.missing_times === 0,
      evidence: `missing_times=${row.missing_times}`,
    },
    {
      id: 'no-stranded-item',
      passed: row.stranded === 0,
      evidence: `stranded=${row.stranded} (blocked, every blocker cleared before the last completed tick, no other hold)`,
    },
    {
      id: 'repair-path-observed',
      passed: row.repair_audit_rows >= 1,
      evidence: `repair_audit_rows=${row.repair_audit_rows} (audit rows by system:blocker-stranded-repair)`,
    },
  ];
  return { passed: assertions.every((a) => a.passed), assertions };
}
