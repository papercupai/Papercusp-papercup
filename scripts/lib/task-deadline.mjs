// Shared launcher-deadline contract. Native verifier admission runs before
// dependencies exist, so keep this surface free of package/toolchain imports.
export const TASK_DEADLINE_EPOCH_MS_ENV = 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS';
export const TASK_DEADLINE_REFUSAL_MARKER = 'TASK_DEADLINE_REFUSAL';

/** Null means unknown, never a measured unlimited budget. */
export function readTaskDeadlineEpochMs(env = process.env) {
  const raw = Number(env?.[TASK_DEADLINE_EPOCH_MS_ENV]);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

/** Forecasts are observations for admission, never acceptance evidence. */
export function formatTaskDeadlineRefusal({ remainingMs, knownEstimateMs, knownTasks, unknownTasks }) {
  return `${TASK_DEADLINE_REFUSAL_MARKER} remainingMs=${Math.round(remainingMs)} ` +
    `knownEstimateMs=${Math.round(knownEstimateMs)} knownTasks=${knownTasks} ` +
    `unknownTasks=${unknownTasks} remedy=raise-caller-timeout — the lane-aware historical ` +
    `wall projection exceeds the remaining launch clock, so a kill part-way through with ` +
    `no verdict is predicted. Refusing before anything runs instead.`;
}

export function isTaskDeadlineRefusal(error) {
  return String(error?.message ?? error ?? '').includes(TASK_DEADLINE_REFUSAL_MARKER);
}

/** The existing source-preview admission rule, shared with the native shell. */
export function admitTaskDeadline({ env = process.env, nowMs = Date.now(),
  knownEstimateMs = 0, cleanupReserveMs = 120_000, knownTasks = 0, unknownTasks = 1 } = {}) {
  for (const value of [nowMs, knownEstimateMs, cleanupReserveMs, knownTasks, unknownTasks])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid task deadline estimate');
  cleanupReserveMs = Math.max(120_000, cleanupReserveMs);
  knownEstimateMs = Math.max(cleanupReserveMs, knownEstimateMs);
  const deadlineEpochMs = readTaskDeadlineEpochMs(env);
  const remainingMs = deadlineEpochMs === null ? null : deadlineEpochMs - nowMs;
  if (remainingMs !== null && remainingMs <= knownEstimateMs)
    throw new Error(formatTaskDeadlineRefusal({ remainingMs, knownEstimateMs, knownTasks, unknownTasks }));
  return { deadlineEpochMs, remainingMs, knownEstimateMs, cleanupReserveMs,
    childCutoffEpochMs: deadlineEpochMs === null ? null : deadlineEpochMs - cleanupReserveMs };
}
