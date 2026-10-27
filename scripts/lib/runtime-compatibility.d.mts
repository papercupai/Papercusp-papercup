/** Interpreter and candidate identities measured by runtime-compatibility.mjs. */
export interface RuntimeIdentity {
  name: string;
  version: string;
  executable: string;
  binarySha256: string;
  platform: string;
  arch: string;
}
export interface CandidateIdentity {
  sourceSha: string;
  lockfileSha256: string;
  configurationSha256: string;
  dependencyGeneration: string;
}
export interface RuntimeProofIdentity extends RuntimeIdentity {
  nativeDependencyGeneration: string;
  lockfileSha256: string;
  configurationSha256: string;
}
export function validRuntimeProofIdentity(runtime: unknown): boolean;
export function runtimeProofFingerprint(runtime: unknown): string | null;
export function captureRuntimeProofIdentity(options: {
  root: string; cwd?: string; environment?: NodeJS.ProcessEnv; executable?: string;
}): RuntimeProofIdentity | null;
export function captureCurrentRuntimeProofIdentity(options: {
  root: string; environment?: NodeJS.ProcessEnv;
}): RuntimeProofIdentity | null;
export interface CapabilityRequest {
  capabilityId: string;
  expected: unknown;
  runtime: RuntimeIdentity;
  candidate: CandidateIdentity;
}
export interface CapabilityObservation {
  nonce: string;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  overflow: boolean;
  error?: string | null;
  binarySha256: string;
  probePath?: string | null;
  probeSha256?: string | null;
  receipts: Array<{
    nonce: string;
    pid: number;
    capabilityId: string;
    completed: boolean;
    runtime: RuntimeIdentity;
    actual: unknown;
  }>;
  stderr?: string;
}
export interface CapabilityResult extends CapabilityRequest {
  schema: 'papercusp-runtime-capability-v1';
  status: 'passed' | 'failed';
  reasons: string[];
  actual: unknown;
  observation: CapabilityObservation;
}
export interface ProbeOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}
export function evaluateCapability(request: CapabilityRequest, observation: CapabilityObservation): CapabilityResult;
export type InstallScenario = 'clean-install' | 'upgrade' | 'restart' | 'node-rollback';
export type HostRuntimePath = 'absent' | 'poisoned';
export interface InstalledArtifactBinding {
  cellId: string;
  installerSha256: string;
  artifactSha256: string;
  previousArtifactSha256: string;
  runtimeRegistrationId: string;
  runtimeClosureRoot: string;
  candidate: CandidateIdentity;
  runtime: RuntimeIdentity;
  rollbackRuntime: RuntimeIdentity;
  expected: Record<InstallScenario, unknown>;
}
export interface InstalledArtifactReceipt {
  cellId: string;
  scenario: InstallScenario;
  hostRuntimePath: HostRuntimePath;
  observation: CapabilityObservation;
}
export function evaluateInstalledArtifactMatrix(input: {
  requiredScope: string[];
  bindings: InstalledArtifactBinding[];
  receipts: InstalledArtifactReceipt[];
}): {
  schema: 'papercusp-installed-artifact-matrix-v1';
  status: 'passed' | 'failed';
  reasons: string[];
  cells: Array<{ cellId: string; status: 'passed' | 'failed'; reasons: string[] }>;
  coverage: { population: string[]; checked: string[]; notChecked: string[]; notApplicable: string[]; residue: string[] };
};
export function measureRuntime(executable: string, options?: ProbeOptions): Promise<RuntimeIdentity>;
export function runCapability(request: CapabilityRequest & { probePath: string }, options?: ProbeOptions): Promise<CapabilityResult>;
