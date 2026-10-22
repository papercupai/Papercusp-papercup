export const ROUTINES_SWEEP_STEP_OVERRUN_BUDGET_MS = 30_000;

export interface SweepStepOverrunDetails {
  stepName: string;
  workflowId: string | null;
  budgetMs: number;
  elapsedMs: number;
  phase: 'still-running' | 'completed';
  outcome?: 'succeeded' | 'failed';
}

export interface SweepStepOverrunOptions {
  budgetMs?: number;
  workflowId?: string | null;
  log?: (message: string, details: SweepStepOverrunDetails) => void;
}

/**
 * Diagnostic budget only: report a step that runs past its budget, but never
 * time it out or change its durable result. Sweep liveness takes precedence.
 */
export async function runSweepStepWithOverrunBudget<T>(
  stepName: string,
  operation: () => T | Promise<T>,
  options: SweepStepOverrunOptions = {},
): Promise<T> {
  const budgetMs = options.budgetMs ?? ROUTINES_SWEEP_STEP_OVERRUN_BUDGET_MS;
  const startedAt = Date.now();
  const log = options.log ?? ((message, details) => console.warn(message, details));
  const emit = (message: string, details: SweepStepOverrunDetails) => {
    try {
      log(message, details);
    } catch {
      // Diagnostic logging must not fail the durable sweep step it observes.
    }
  };
  const timer = setTimeout(() => {
    emit('[routines-sweep-step] exceeded diagnostic budget; step is still running', {
      stepName,
      workflowId: options.workflowId ?? null,
      budgetMs,
      elapsedMs: Date.now() - startedAt,
      phase: 'still-running',
    });
  }, budgetMs);
  let outcome: SweepStepOverrunDetails['outcome'] = 'succeeded';
  try {
    return await operation();
  } catch (error) {
    outcome = 'failed';
    throw error;
  } finally {
    clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= budgetMs) {
      emit('[routines-sweep-step] step completed over diagnostic budget', {
        stepName,
        workflowId: options.workflowId ?? null,
        budgetMs,
        elapsedMs,
        phase: 'completed',
        outcome,
      });
    }
  }
}
