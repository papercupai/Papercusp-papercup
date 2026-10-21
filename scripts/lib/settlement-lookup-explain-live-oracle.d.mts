// Types for settlement-lookup-explain-live-oracle.mjs (AUTO-BAR-R-3-P-002@3 of event-wait-settlement-2026-10-20).
export declare const R3_MAX_MS: number;
export declare const R3_LOOKUPS: readonly { name: 'externalBlockers' | 'durableParks'; index: string }[];

export interface ExplainNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: ExplainNode[];
}

export interface ExplainTop {
  Plan: ExplainNode;
  'Execution Time': number;
}

export interface R3Assertion {
  id: 'no-seq-scan-on-work-items' | 'reads-wait-ref-index' | 'within-threshold';
  passed: boolean;
  evidence: string;
}

export interface R3LookupVerdict {
  passed: boolean;
  executionMs: number;
  seqScanOnWorkItems: boolean;
  indexes: string[];
  nodes: string[];
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  assertions: R3Assertion[];
}

export declare function explainTop(rows: unknown): ExplainTop;
export declare function judgeLookup(top: ExplainTop, opts: { index: string; maxMs?: number }): R3LookupVerdict;
export declare function judgeR3(
  byName: Record<string, ExplainTop>,
  opts?: { maxMs?: number },
): { passed: boolean; results: Record<string, R3LookupVerdict> };
