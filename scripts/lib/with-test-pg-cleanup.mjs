import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const PRIVATE_STATE_REMOVE_RETRIES = 3;
const PRIVATE_STATE_REMOVE_RETRY_DELAY_MS = 100;
const RETRYABLE_REMOVE_ERRORS = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

export const PRIVATE_TEST_PG_RELEASE_TOKEN_ENV = 'PAPERCUSP_PRIVATE_TEST_PG_RELEASE_TOKEN';
const PRIVATE_TEST_PG_RELEASE_REQUEST = 'papercusp-private-test-pg-release';
const PRIVATE_TEST_PG_RELEASE_RESULT = 'papercusp-private-test-pg-release-result';
let privatePgReleaseRequestSequence = 0;

/** Cache one owned-resource stop across an early request and final cleanup. */
export function createSingleFlightStop(stop, beforeStop) {
  let pending;
  let preparation;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        const failures = [];
        if (beforeStop) {
          // Retain the database cleanup result across early release and final
          // teardown. A failed preparation must not cause drops on a dead PG.
          preparation ??= Promise.resolve().then(beforeStop);
          try { await preparation; } catch (error) { failures.push(error); }
        }
        // A database receipt failure must still stop the owned server.
        let result;
        try { result = await stop(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'private PG stop has unverified cleanup');
        return result;
      }).catch(error => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

/** Respond only to an authenticated request from the wrapper's direct child. */
export function createPrivateTestPgReleaseHandler({ token, stop, respond }) {
  if (typeof token !== 'string' || token.length === 0 || typeof stop !== 'function' || typeof respond !== 'function')
    throw new TypeError('private test-PG release handler needs a token, stop function and responder');
  return async message => {
    if (message?.kind !== PRIVATE_TEST_PG_RELEASE_REQUEST || message.token !== token ||
        typeof message.requestId !== 'string' || message.requestId.length === 0) return false;
    const result = { kind: PRIVATE_TEST_PG_RELEASE_RESULT, token, requestId: message.requestId, ok: false };
    try {
      await stop();
      result.ok = true;
    } catch (error) {
      result.error = String(error?.message ?? error).slice(0, 2000);
    }
    await respond(result);
    return true;
  };
}

/** Ask the direct with-test-pg parent to stop its owned cluster and await its receipt. */
export function requestPrivateTestPgRelease(token, { processRef = process, timeoutMs = 10_000 } = {}) {
  if (typeof token !== 'string' || token.length === 0)
    return Promise.reject(new TypeError('private test-PG release needs the parent-issued token'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    return Promise.reject(new TypeError('private test-PG release timeout must be positive integer milliseconds'));
  if (processRef.connected !== true || typeof processRef.send !== 'function' ||
      typeof processRef.on !== 'function' || typeof processRef.off !== 'function')
    return Promise.reject(new Error('private test-PG release parent IPC channel is unavailable'));
  const pid = Number.isSafeInteger(processRef.pid) ? processRef.pid : 'unknown';
  const requestId = `${pid}:${Date.now()}:${++privatePgReleaseRequestSequence}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processRef.off('message', onMessage);
      if (error) reject(error); else resolve(value);
    };
    const onMessage = message => {
      if (message?.kind !== PRIVATE_TEST_PG_RELEASE_RESULT || message.token !== token || message.requestId !== requestId) return;
      if (message.ok === true) finish(null, true);
      else finish(new Error('private test-PG release failed: ' + String(message.error ?? 'parent did not stop its owned cluster')));
    };
    const timer = setTimeout(() => finish(new Error('private test-PG release acknowledgement timed out')), timeoutMs);
    processRef.on('message', onMessage);
    try {
      processRef.send({ kind: PRIVATE_TEST_PG_RELEASE_REQUEST, token, requestId }, error => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error);
    }
  });
}

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
