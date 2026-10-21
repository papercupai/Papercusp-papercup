// Types for sync-batch-coverage-accounting-oracle.mjs (R-17 of green-main-ratchet-convergence-2026-10-17).
export declare const R17_MIN_SLOTS: number;
export declare const R17_TARGET_RATIO: number;
export declare const R17_ROUTINES: number;
export declare const R17_COLUMNS: readonly [
  'routines',
  'min_slots',
  'min_ratio',
  'unaccounted_slots',
  'low_without_current_alarm',
  'accounted',
];

export interface R17Row {
  routines: number;
  min_slots: number;
  min_ratio: number;
  unaccounted_slots: number;
  low_without_current_alarm: number;
  accounted: number;
}

export interface R17Assertion {
  id: string;
  passed: boolean;
  evidence: string;
}

/** Parse one `psql -At` line of the R-17 probe. Throws on any shape other than six numeric fields. */
export declare function parseR17Row(line: string): R17Row;

/** Judge a parsed R-17 probe row; every assertion carries its evidence. */
export declare function judgeR17(row: R17Row): { passed: boolean; assertions: R17Assertion[] };
