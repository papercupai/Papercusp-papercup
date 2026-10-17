import { resolveBuildInfo } from '../build-info';
import {
  formatBm25MaintenanceReport,
  runOrgBm25Maintenance,
  type Bm25MaintenanceReport,
} from '../search/lexical/bm25-maintenance';

export type Bm25MaintenanceStepOutcome =
  | 'no-op'
  | 'completed'
  | 'completed-with-errors'
  | 'non-fatal-failure';

/** JSON-safe output persisted by the `bm25-maintenance` DBOS operation. */
export interface Bm25MaintenanceStepResult {
  outcome: Bm25MaintenanceStepOutcome;
  noOp: boolean;
  loadedSourceSha: string | null;
  startedAtMs: number;
  finishedAtMs: number;
  durationMs: number;
  report: Bm25MaintenanceReport | null;
  error: string | null;
}

/**
 * Run one maintenance tick and return its complete result to DBOS. The injected
 * dependencies keep the non-fatal, no-op and successful output shapes testable
 * without importing the module that registers every scheduled workflow.
 */
export async function runBm25MaintenanceStep(deps: {
  runMaintenance?: () => Promise<Bm25MaintenanceReport>;
  now?: () => number;
  loadedSourceSha?: string | null;
} = {}): Promise<Bm25MaintenanceStepResult> {
  const now = deps.now ?? Date.now;
  const startedAtMs = now();
  // Resolve only the source SHA baked into this artifact. An unbundled process
  // must not substitute its current checkout SHA for the loaded background host.
  const loadedSourceSha =
    deps.loadedSourceSha !== undefined
      ? deps.loadedSourceSha
      : resolveBuildInfo({ env: {}, bundled: true }).sha;

  try {
    const report = await (deps.runMaintenance ?? runOrgBm25Maintenance)();
    const finishedAtMs = now();
    const durationMs = Math.max(0, finishedAtMs - startedAtMs);
    const line = formatBm25MaintenanceReport(report, { startedAtMs, finishedAtMs, durationMs });
    if (line) console.log(line);

    const noOp = line === null;
    const outcome = noOp ? 'no-op' : report.errors.length ? 'completed-with-errors' : 'completed';
    return {
      outcome,
      noOp,
      loadedSourceSha,
      startedAtMs,
      finishedAtMs,
      durationMs,
      report,
      error: null,
    };
  } catch (err) {
    const finishedAtMs = now();
    const durationMs = Math.max(0, finishedAtMs - startedAtMs);
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[bm25-maintenance] run skipped (non-fatal): ${error}`);
    return {
      outcome: 'non-fatal-failure',
      noOp: false,
      loadedSourceSha,
      startedAtMs,
      finishedAtMs,
      durationMs,
      report: null,
      error,
    };
  }
}
