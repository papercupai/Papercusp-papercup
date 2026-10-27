export interface EngineeringReleasePhase {
  phase: 'integration' | 'browser';
  plane: 'current-build' | 'final-release';
  nonce: string;
  buildSha: string;
  manifestSha256: string;
  status: number | null;
  signal: string | null;
  error: { name: string; message: string; code?: string } | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutSha256: string;
  stderrSha256: string;
  metadataPath: string;
}
export interface EngineeringReleaseChildResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
  error?: unknown;
}
export interface EngineeringReleaseProof {
  scope: string;
  status: 'pass' | 'unknown';
  reason?: string;
  plane?: 'final-release' | 'current-build';
  buildSha?: string;
  manifestSha256?: string;
  receiptPath?: string;
  receiptSha256?: string;
  nonce?: string;
  phases: { integration?: EngineeringReleasePhase; browser?: EngineeringReleasePhase };
  integration?: { logPath: string; sha256: string; result: string; files: string[] };
}
export const CURRENT_ENGINEERING_TEST_FILES: string[];
export const ENGINEERING_RELEASE_BUDGET_MS: number;
export function verifyEngineeringRelease(options: {
  root: string;
  inputsPath: string;
  env?: NodeJS.ProcessEnv;
  nonce?: string;
  plane?: 'final-release' | 'current-build';
  now?: () => number;
  write?: (path: string, bytes: string) => void;
  read?: (path: string) => string | Buffer;
  run?: (command: string, argv: string[], options: Record<string, unknown>) => EngineeringReleaseChildResult;
}): EngineeringReleaseProof;
