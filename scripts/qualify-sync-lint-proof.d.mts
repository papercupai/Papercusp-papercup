export function syncLintProofRoots(repo: string): string[];
export interface VerifierInputClosure {
  roots: string[];
  paths: string[];
  imports: { from: string; spec: string; mode: 'types' | 'import' | 'require'; path: string; external: boolean }[];
  unresolved: { from: string; spec: string }[];
  workingHashes: Record<string, string>;
}
export function collectVerifierInputClosure(repo: string, roots: string[]): VerifierInputClosure;
export function qualifySyncLintProofInputs(options: { repo: string; roots?: string[] }): Promise<VerifierInputClosure & {
  schemaVersion: string; measuredAt: string; headStart: string; headAfter: string;
  finalWorkingHashes: Record<string, string | null>;
  finalReadErrors: Record<string, { name: string; code: string | null; message: string }>;
  workingHashMismatches: string[];
  validationRefusal: string | null; stabilityRefusal: string | null;
  /** Combined refusal paths: hash mismatches OR unreadable inputs. */
  workingDrift: string[]; refusal: string | null; qualification: 'qualified' | 'refused';
}>;
