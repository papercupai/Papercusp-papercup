// Types for bundle-restricted-hold-gate.mjs (WI-10005745) — consumed by its vitest suite.
export declare const GATE_EXIT: Readonly<{ admit: 0; misuse: 2; refuse: 3 }>;

export type GateArtifactEntry = { name: string; existed: boolean };

export declare function snapshotArtifacts(opts: { outdir: string; snapshotDir: string; artifacts: string[] }): GateArtifactEntry[];

export declare function restoreArtifacts(opts: { outdir: string; snapshotDir: string }): GateArtifactEntry[];

export declare function collectBundleInputs(opts: {
  baseDir: string;
  metafiles?: string[];
  metafileDirs?: string[];
  listFiles?: string[];
  paths?: string[];
}): { files: string[]; dirs: string[] };

// `skipped` carries any reason: runGate admits only the reasons in BUNDLE_PREFLIGHT_SKIP_REASONS
// and fails closed (a named refusal) on any other, so the undeclared case is part of the contract.
export type GatePreflight = (opts: { repoRoot: string; inputsFile: string }) =>
  | { verdict: 'admit' }
  | { verdict: 'skipped'; reason: string }
  | { verdict: 'refuse'; error: string; hint: string };

export declare function runGate(opts: {
  root: string;
  baseDir: string;
  outdir: string;
  snapshotDir: string;
  metafiles?: string[];
  metafileDirs?: string[];
  listFiles?: string[];
  paths?: string[];
  preflight?: GatePreflight;
  log?: (line: string) => void;
}): 0 | 3;
