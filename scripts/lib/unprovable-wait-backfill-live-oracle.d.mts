// Types for unprovable-wait-backfill-live-oracle.mjs (AUTO-BAR-R-12-P-006@3 of event-wait-settlement-2026-10-20).
export declare const R12_COLUMNS: readonly [
  'active_waits',
  'stamped',
  'proving_concrete',
  'announced_live',
  'announced_fired',
  'unprovable_unstamped',
  'backfill_stamped_rows',
  'backfill_cleared',
  'stamped_inactive_unattributed',
];

export interface R12Row {
  active_waits: number;
  stamped: number;
  proving_concrete: number;
  announced_live: number;
  announced_fired: number;
  unprovable_unstamped: number;
  backfill_stamped_rows: number;
  backfill_cleared: number;
  stamped_inactive_unattributed: number;
}

export interface R12Assertion {
  id: string;
  passed: boolean;
  evidence: string;
}

export declare function parseR12Row(line: string): R12Row;
export declare function judgeR12(row: R12Row): { passed: boolean; assertions: R12Assertion[] };
export declare function probeTerminalStates(probeSql: string): string[];
export declare function probeConditionFamilies(probeSql: string): string[];
