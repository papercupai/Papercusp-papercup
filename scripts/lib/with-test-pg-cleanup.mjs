import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const PRIVATE_STATE_REMOVE_RETRIES = 3;
const PRIVATE_STATE_REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/** async-exit-hook registers lazily; unhookEvent throws for an absent event. */
export function unhookRegisteredExitSignals(exitHook) {
  const registered = new Set(exitHook.hookedEvents());
  for (const signal of ['SIGINT', 'SIGTERM']) {
    if (registered.has(signal)) exitHook.unhookEvent(signal);
  }
}

export async function removePrivateState(path, remove = rm) {
  let lastError;
  for (let attempt = 0; attempt <= PRIVATE_STATE_REMOVE_RETRIES; attempt++) {
    try {
      await remove(path, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (cause) {
      lastError = cause;
      if (!RETRYABLE_REMOVE_ERRORS.has(cause?.code)) throw cause;
      if (attempt === PRIVATE_STATE_REMOVE_RETRIES) throw cause;
      await new Promise(resolve => setTimeout(resolve, PRIVATE_STATE_REMOVE_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

/** Stop each owned resource even when another exit fence fails. Private state
 * remains available until every resource has a verified stop.
 * @param {import('./with-test-pg-cleanup.d.mts').CleanupOwnedTestStateOptions} state */
export async function cleanupOwnedTestState(state) {
  const { child, childLifetime, profileProcess, profileLifetime,
    pg, dataDir, runtimeRoot, isolatedRuntime, cleanupStage, observePrivatePgStop } = state;
  // Include receipts emitted before entry and by non-awaiting PG observers.
  const failures = state.receiptFailures ?? [];
  const recordFailure = (stage, cause) => {
    failures.push(new Error(stage + ': ' + (cause?.message ?? String(cause)), { cause }));
  };
  // Evidence failures must stay visible without preventing the owned stop itself.
  const recordStage = async (stage, detail = {}) => {
    try { await cleanupStage(stage, detail); }
    catch (cause) { recordFailure(stage + '-receipt', cause); }
  };
  const attempt = async (stage, operation, detail = {}, finishedStage = stage + 'ped') => {
    await recordStage(stage, detail);
    try {
      await operation();
    } catch (cause) {
      recordFailure(stage, cause);
      await recordStage(stage + '-error', { ...detail, error: cause?.message ?? String(cause) });
      return;
    }
    await recordStage(finishedStage, detail);
  };
  await recordStage('start');
  if (childLifetime) await attempt('child-group-stop', () => childLifetime.terminate(), { pid: child?.pid });
  if (profileLifetime) await attempt('profile-stop', () => profileLifetime.terminate(), { pid: profileProcess?.pid });
  if (state.stopManagedTasks) await attempt('managed-tasks-stop', state.stopManagedTasks);

  let stopObserving;
  try { stopObserving = observePrivatePgStop(); }
  catch (cause) { recordFailure('pg-stop-observation-start', cause); }
  // Waiting is a stage receipt, not evidence that a process has exited.
  const pendingReceipts = new Set();
  const stopTimer = isolatedRuntime ? setInterval(() => {
    const receipt = recordStage('pg-stop-waiting');
    pendingReceipts.add(receipt);
    void receipt.finally(() => pendingReceipts.delete(receipt));
  }, 5000) : null;
  stopTimer?.unref();
  let health = null;
  try { health = pg?.health?.() ?? null; }
  catch (cause) { recordFailure('pg-stop-health', cause); }
  try {
    await attempt('pg-stop', () => pg?.stop(), { health });
  } finally {
    if (stopTimer) clearInterval(stopTimer);
    await Promise.all(pendingReceipts);
    try { stopObserving?.(); }
    catch (cause) { recordFailure('pg-stop-observation-stop', cause); }
    try { await state.drainReceipts?.(); }
    catch (cause) { recordFailure('background-cleanup-receipts', cause); }
  }
  if (failures.length) {
    await recordStage('private-state-retained', { errors: failures.map(error => error.message),
      runtimeRemoved: !runtimeRoot || !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) });
    throw new AggregateError(failures, 'private runtime cleanup has unverified resource stops');
  }

  await recordStage('remove-private-state');
  if (failures.length) throw new AggregateError(failures, 'private runtime cleanup has unverified resource stops');
  // Removal failures also need an unsuccessful exit and an exact residue receipt.
  await attempt('pg-data-remove', () => removePrivateState(dataDir), {}, 'pg-data-removed');
  if (runtimeRoot) await attempt('runtime-remove', () => removePrivateState(runtimeRoot), {}, 'runtime-removed');
  const removed = { runtimeRemoved: !runtimeRoot || !existsSync(runtimeRoot), pgDataRemoved: !existsSync(dataDir) };
  if (failures.length || !removed.runtimeRemoved || !removed.pgDataRemoved) {
    await recordStage('private-state-retained', { ...removed, errors: failures.map(error => error.message) });
    throw new AggregateError(failures, 'private runtime cleanup did not remove all owned state');
  }
  await recordStage('complete', removed);
  if (failures.length) throw new AggregateError(failures, 'private runtime cleanup completion receipt failed');
}
