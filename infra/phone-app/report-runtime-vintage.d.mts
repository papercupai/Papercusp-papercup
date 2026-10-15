export declare const DEFAULT_ORIGINS: string[];
export declare const DEFAULT_WORKSPACE: string;
export declare const DEFAULT_TIMEOUT_MS: number;

export interface VintageArgs {
  unit: string;
  dir: string;
  pid: number | null;
  origins: string[];
  workspace: string;
  timeoutMs: number;
  executable?: boolean;
  nodeEntry?: boolean;
}

export interface VintageReport {
  unit: string;
  workspaceId: string;
  treeSha: string | null;
  buildTime: string;
  bundleVersion: string | null;
  pid: number | null;
  extra: { reporter: string; checkout: string; uncommittedTrackedPaths: number | null; identitySource?: string };
}

export interface VintageAttempt {
  origin: string;
  ok: boolean;
  status?: number;
  error?: string | null;
}

export declare function parseArgs(argv: string[], env?: Record<string, string | undefined>): VintageArgs;
export declare function readCheckout(
  dir: string,
  run?: (args: string[]) => string,
): { treeSha: string | null; dirty: number | null };
export declare function buildVintageReport(input: {
  unit: string;
  workspace: string;
  pid: number | null;
  dir: string;
  treeSha: string | null;
  dirty: number | null;
  executableDigest?: string;
  nodeEntryDigest?: string;
  now?: Date;
}): VintageReport;
export declare function postVintage(
  report: VintageReport,
  origins: string[],
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; origin: string | null; attempts: VintageAttempt[] }>;
export declare function main(argv?: string[], env?: Record<string, string | undefined>): Promise<number>;
