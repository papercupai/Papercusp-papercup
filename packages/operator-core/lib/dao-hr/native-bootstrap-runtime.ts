import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { killSpawnedProcessTree } from '../../../../scripts/lib/batch-watchdog.mjs';

// Separate preparation from native acceptance. The retained cold run spent
// 19 minutes preparing and two booting before it could start the journey.
export const NATIVE_VERIFIER_PHASE_BUDGETS = { prepare: 25 * 60_000, boot: 10 * 60_000, assert: 10 * 60_000 };
export const NATIVE_BOOTSTRAP_TEARDOWN_MS = 60_000;
export const NATIVE_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000
  + Object.values(NATIVE_VERIFIER_PHASE_BUDGETS).reduce((sum, value) => sum + value, 0)
  + NATIVE_BOOTSTRAP_TEARDOWN_MS;

/** Establish attribution before source preparation or provider allocation. */
export function nativeBootstrapEnvironment(env: NodeJS.ProcessEnv, ledgerUrl: string): NodeJS.ProcessEnv {
  const workspace = env.PAPERCUSP_TEST_RUN_WORKSPACE || env.PAPERCUSP_WORKSPACE_ID || env.PAPERCUSP_WORKSPACE;
  assert.ok(workspace?.trim(), 'PAPERCUSP_TEST_RUN_WORKSPACE is required before native allocation');
  assert.ok(ledgerUrl.trim(), 'PAPERCUSP_TEST_RUNS_DB_URL is required before native allocation');
  return { ...env, PAPERCUSP_TEST_RUNS_DB_URL: ledgerUrl, PAPERCUSP_TEST_RUN_WORKSPACE: workspace,
    PAPERCUSP_TEST_RUN_GROUP: env.PAPERCUSP_TEST_RUN_GROUP?.trim() || `dao-hr-native-${randomUUID()}` };
}

/** Join the whole verifier tree before fixtures can be torn down or a test can finish. */
export async function runNativeVerifier(command: string, args: string[], options: SpawnOptions & {
  signal: AbortSignal; timeoutMs: number; killGraceMs?: number;
  phaseBudgetsMs?: typeof NATIVE_VERIFIER_PHASE_BUDGETS; logFd?: number;
}): Promise<number | null> {
  const { signal, timeoutMs, killGraceMs = 30_000, phaseBudgetsMs, logFd, ...spawnOptions } = options;
  signal.throwIfAborted();
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0,
    'Native bootstrap exhausted its preparation budget before verifier launch');
  assert.ok(Number.isFinite(killGraceMs) && killGraceMs >= 0, 'Native verifier kill grace must be finite and nonnegative');
  if (phaseBudgetsMs) {
    assert.ok(Number.isInteger(logFd), 'Native phase budgets require retained output');
    for (const budget of Object.values(phaseBudgetsMs))
      assert.ok(Number.isFinite(budget) && budget > 0, 'Native phase budgets must be positive and finite');
  }
  const child = spawn(command, args, { ...spawnOptions, detached: true,
    ...(logFd === undefined ? {} : { stdio: ['ignore', 'pipe', 'pipe'] }) });
  let failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  let phaseDeadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: Error) => {
    if (failure) return;
    failure = reason;
    killSpawnedProcessTree(child, 'SIGTERM');
    termination = new Promise(resolve => {
      escalation = setTimeout(() => { killSpawnedProcessTree(child, 'SIGKILL'); resolve(); }, killGraceMs);
    });
  };
  const abort = () => stop(new Error('Native verifier cancelled with its enclosing test', { cause: signal.reason }));
  const phases = ['prepare', 'boot', 'assert'] as const;
  let phaseIndex = -1;
  const enterPhase = (index: number) => {
    if (!phaseBudgetsMs || index <= phaseIndex) return; // Repeated progress cannot renew a deadline.
    phaseIndex = index;
    clearTimeout(phaseDeadline);
    const phase = phases[index];
    phaseDeadline = setTimeout(() => stop(new Error(`Native verifier ${phase} phase exceeded its ${phaseBudgetsMs[phase]}ms budget`)), phaseBudgetsMs[phase]);
  };
  const readers: ReturnType<typeof createInterface>[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream || logFd === undefined) continue;
    stream.on('data', chunk => writeSync(logFd, chunk));
    const lines = createInterface({ input: stream });
    lines.on('line', line => {
      const phase = line.match(/^VH_BEGIN phase=(prepare|boot|assert)$/)?.[1];
      if (phase) enterPhase(phases.indexOf(phase as typeof phases[number]));
    });
    readers.push(lines);
  }
  enterPhase(0); // Also bounds preflight before the shell emits its first marker.
  const deadline = setTimeout(() => stop(new Error(`Native verifier exceeded its remaining ${timeoutMs}ms budget`)), timeoutMs);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => failure ? reject(failure) : resolve(code));
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(phaseDeadline);
    for (const reader of readers) reader.close();
    signal.removeEventListener('abort', abort);
    // A shell can exit on SIGTERM while a descendant ignores it. Direct-child
    // close must not cancel group escalation or let fixture teardown run early.
    await termination;
    if (escalation) clearTimeout(escalation);
  }
}
