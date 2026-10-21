// Types for dependency-graph-wait-latency-live-oracle.mjs (AUTO-BAR-R-19-P-009@3 of event-wait-settlement-2026-10-20).
export declare const R19_BAR_DEADLINE_MS: number;
export declare const R19_MIN_RUNS: number;
export declare const R19_ASSERTIONS: readonly [
  'min-runs',
  'operator-db',
  'graph-non-empty',
  'wait-leg-ran',
  'before-recorded',
  'within-deadline',
];

export interface R19Run {
  edgesMs?: number;
  edgesPlusWaitsMs?: number;
  waitsAloneMs?: number;
  edges?: number;
  waits?: number;
  [extra: string]: unknown;
}

export interface R19Measurement {
  db: unknown;
  expectedDb: unknown;
  deadlineMs: unknown;
  runs: unknown;
}

export interface R19Verdict {
  ok: boolean;
  failedIds: string[];
  maxEdgesMs: number | null;
  maxEdgesPlusWaitsMs: number | null;
  maxWaitsAloneMs: number | null;
}

export declare function expectedDbFromDsn(dsn: string): string;
export declare function judgeR19(m: R19Measurement): R19Verdict;
