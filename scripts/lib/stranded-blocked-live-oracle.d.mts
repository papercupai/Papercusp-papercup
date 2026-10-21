// Types for stranded-blocked-live-oracle.mjs (AUTO-BAR-R-10-P-005@3 of event-wait-settlement-2026-10-20).
export declare const R10_MAX_TICK_AGE_S: number;
export declare const R10_COLUMNS: readonly [
  'all_cleared_blocked',
  'reblocked_after_clear',
  'other_hold',
  'stranded',
  'cleared_since_tick',
  'missing_times',
  'tick_age_s',
  'repair_audit_rows',
];

export interface R10Row {
  all_cleared_blocked: number;
  reblocked_after_clear: number;
  other_hold: number;
  stranded: number;
  cleared_since_tick: number;
  missing_times: number;
  tick_age_s: number;
  repair_audit_rows: number;
}

export interface R10Assertion {
  id: string;
  passed: boolean;
  evidence: string;
}

/** Parse one `psql -At` line of the R-10 probe. Throws on any shape other than eight integer fields. */
export declare function parseR10Row(line: string): R10Row;

/** Judge a parsed R-10 probe row; every assertion carries its evidence. */
export declare function judgeR10(row: R10Row): { passed: boolean; assertions: R10Assertion[] };
