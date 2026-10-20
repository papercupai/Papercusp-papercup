// Oracle for acceptance bar R-17 of green-main-ratchet-convergence-2026-10-17 (rubric rev 12, #D-036..#D-039):
// sync-batch slot accounting. The bar's registered probe (docs/evidence/p009-r17-slot-accounting-live-2026-10-20/probe.sql)
// returns ONE row, `routines|min_slots|min_ratio|unaccounted_slots|low_without_current_alarm|accounted` (psql -At).
// This module takes every pass/fail decision on that row so the evidence run only collects output.
//
// R-17 passes when, for BOTH routines (sync-batch-delta-check, sync-batch-lint-guards):
//   - at least 276 five-minute slots were recorded in the 24h window (the routine kept recording; H1),
//   - no recorded slot lacks a cause (unaccounted_slots = 0),
//   - coverage is >= 95% OR a fresh coverage-low alarm is open (low_without_current_alarm = 0; H2).
// The probe's own `accounted` column must agree with that recomputation; a disagreement is a failure, not a pass.

export const R17_MIN_SLOTS = 276;
export const R17_TARGET_RATIO = 0.95;
export const R17_ROUTINES = 2;
export const R17_COLUMNS = ['routines', 'min_slots', 'min_ratio', 'unaccounted_slots', 'low_without_current_alarm', 'accounted'];

/** Parse one `psql -At` line of the R-17 probe. Throws on any shape other than six numeric fields. */
export function parseR17Row(line) {
  const text = String(line ?? '').trim();
  const parts = text.split('|');
  if (parts.length !== R17_COLUMNS.length) {
    throw new Error(`R-17 probe row must have ${R17_COLUMNS.length} fields, got ${parts.length}: ${JSON.stringify(text)}`);
  }
  const row = {};
  R17_COLUMNS.forEach((col, i) => {
    const raw = parts[i].trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n)) throw new Error(`R-17 probe field ${col} is not numeric: ${JSON.stringify(raw)}`);
    row[col] = n;
  });
  return row;
}

/** Judge a parsed R-17 probe row. Returns { passed, assertions[] }; every assertion carries its evidence. */
export function judgeR17(row) {
  const assertions = [
    {
      id: 'both-routines-present',
      passed: row.routines === R17_ROUTINES,
      evidence: `routines=${row.routines} (expected ${R17_ROUTINES})`,
    },
    {
      id: 'slot-floor',
      passed: row.min_slots >= R17_MIN_SLOTS,
      evidence: `min_slots=${row.min_slots} (floor ${R17_MIN_SLOTS})`,
    },
    {
      id: 'every-slot-accounted',
      passed: row.unaccounted_slots === 0,
      evidence: `unaccounted_slots=${row.unaccounted_slots}`,
    },
    {
      id: 'low-coverage-has-fresh-alarm',
      passed: row.low_without_current_alarm === 0,
      evidence: `low_without_current_alarm=${row.low_without_current_alarm} (min_ratio=${row.min_ratio}, target ${R17_TARGET_RATIO})`,
    },
  ];
  const recomputed = assertions.every((a) => a.passed);
  assertions.push({
    id: 'probe-verdict-agrees',
    passed: (row.accounted === 1) === recomputed,
    evidence: `probe accounted=${row.accounted}, oracle recomputation=${recomputed ? 1 : 0}`,
  });
  return { passed: recomputed && row.accounted === 1, assertions };
}
