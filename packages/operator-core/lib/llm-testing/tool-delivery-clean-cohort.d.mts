/** Types for the tracked native-ESM launcher; this does not authorize execution. */
export interface CleanCohortApproval {
  experimentId: string;
  portableSha256: string;
  buildSha: string;
  plan: { version: number; contentHash: string };
  auditSeq: number;
  rubric: { revision: number; criteriaHash: string };
  critic: string;
}
export interface CleanCohortAuthority {
  buildSha: string;
  readerSourceSha256: string;
  plan: CleanCohortApproval['plan'];
  audit: CleanCohortApproval['plan'] & { seq: number };
  rubric: CleanCohortApproval['rubric'] & { criteriaCount: number; selections: Record<string, string> };
  vetting: { satisfied: boolean; reason: string; attestedRevision: number; attestedCriteriaHash: string;
    critique: { critics: string[] } };
  implementer: string;
  r10: Array<{ specId: string; verdict: string; wouldBlock: string[];
    mechanicalProof: { verdict: string; gaps: string[] } }>;
}
export function assertCleanCohortAuthority(registration: {
  experiment: { id: string };
  measurementAmendment: { sourceReplacements: Record<string, { sha256: string }> };
}, portableSha256: string, expected: CleanCohortApproval | undefined, live: CleanCohortAuthority): void;
export function claimCleanCohort(directory: string, marker: Record<string, unknown>): void;
export function assertCleanCohortCatalogDefinitions(actual: unknown, expected: unknown): void;
export function assertCleanCohortCapturedInputs(input: {
  captured?: { installSha256: string; executableSha256: string; nodeVersion: string; moduleHashes: Record<string, string> };
  actual: { installSha256: string; executableSha256: string; nodeVersion: string; moduleHashes: Record<string, string> };
  amendment: { addedFiles: Record<string, string>; sourceReplacements: Record<string, { sha256: string }> };
  fixture: string; portableSha256: string; readHash: (path: string) => string;
}): void;
export function parseCleanCohortArgs(argv: string[]): {
  experimentId: string; fixture: string; readinessPath: string | undefined;
};
export function main(argv?: string[]): Promise<Record<string, unknown>>;
