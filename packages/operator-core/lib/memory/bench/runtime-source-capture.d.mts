export interface ParsedSourceReceipt {
  processId: number;
  sources: number;
  workerIds: string[];
  workersClosedByProcessExit: string[];
  parsedSourcePopulationComplete: true;
  completeRuntimeClosureVerified: false;
  scope: string;
}
export function validateRuntimeSourceCapture(rows: Record<string, any>[], expectedWorkerIds?: string[],
  processTerminal?: {processId: number; exitCode: number; signal: string | null; eof: boolean}): ParsedSourceReceipt;
export function startRuntimeSourceCapture(destination: string): void;
