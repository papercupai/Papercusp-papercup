/** Types for ./bundle-budget.mjs (operator-vite client bundle budget evaluator). */

export declare const EAGER_BUDGET_BYTES: number;
export declare const MAX_EAGER_CHUNK_BYTES: number;

export interface MustStayLazyRule {
  readonly label: string;
  readonly pattern: RegExp;
}
export declare const MUST_STAY_LAZY: readonly MustStayLazyRule[];

export declare function indexHtmlSeeds(indexHtml: string): string[];
export declare function eagerAssetSet(indexHtml: string, readAsset: (name: string) => string | null): Set<string>;

export interface BundleBudgetInput {
  indexHtml: string;
  assets: readonly string[];
  sizeOf: (name: string) => number | null;
  readAsset: (name: string) => string | null;
  eagerBudgetBytes?: number;
  maxEagerChunkBytes?: number;
  mustStayLazy?: readonly MustStayLazyRule[];
}

export interface BundleBudgetReport {
  eagerFiles: number;
  eagerBytes: number;
  unlistedEager: string[];
  largestEagerJs: { name: string; size: number } | null;
  missing: string[];
  lazyStatus: Array<{ label: string; files: string[]; eager: string[] }>;
  problems: string[];
}

export declare function evaluateBundleBudget(input: BundleBudgetInput): BundleBudgetReport;
