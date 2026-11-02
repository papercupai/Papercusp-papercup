/** Isolate fork+tsx readiness from DB-backed and browser-open work. */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

type StartupPhase = { event: string; elapsedMs: number; childElapsedMs?: number };
const startupReadyTimeoutMs = 15_000;
const startupEvents = ['fixture:process-started', 'fixture:tsx-loaded', 'fixture:imports-loaded',
  'fixture:rpc-started', 'fixture:ready'];

function forkOwnerWorker() {
  return fork(fileURLToPath(new URL('./__fixtures__/browser-owner-worker.mts', import.meta.url)), [], {
    execArgv: [
      '--require', fileURLToPath(new URL('./__fixtures__/browser-owner-worker-startup.cjs', import.meta.url)),
      '--import', 'tsx', '--import', fileURLToPath(new URL('./__fixtures__/browser-owner-worker-tsx-ready.mjs', import.meta.url)),
    ], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

async function waitForOwnerWorkerReady(child: ChildProcess, startedAt: bigint): Promise<StartupPhase[]> {
  const phases: StartupPhase[] = [];
  let childStartedAtNs: bigint | undefined;
  const describePhases = () => phases.map(phase =>
    `${phase.event}=parent:${phase.elapsedMs.toFixed(1)}ms${phase.childElapsedMs === undefined ? '' : `/child:${phase.childElapsedMs.toFixed(1)}ms`}`)
    .join(', ') || 'none';
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(
      `real browser worker startup timed out after ${startupReadyTimeoutMs}ms; observed phases: ${describePhases()}`)),
    startupReadyTimeoutMs);
    const onMessage = (message: any) => {
      if (!startupEvents.includes(message.type)) return;
      const childAtNs = typeof message.startupAtNs === 'string' ? BigInt(message.startupAtNs) : undefined;
      childStartedAtNs ??= childAtNs;
      phases.push({ event: message.type, elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        ...(childStartedAtNs !== undefined && childAtNs !== undefined
          ? { childElapsedMs: Number(childAtNs - childStartedAtNs) / 1e6 } : {}) });
      if (message.type === 'fixture:ready') finish();
    };
    const onExit = () => finish(new Error(`real browser worker exited before ready; observed phases: ${describePhases()}`));
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
  return phases;
}

it('measures owner worker readiness without database or browser-open work', async () => {
  const startedAt = process.hrtime.bigint();
  const child = forkOwnerWorker();
  try {
    const phases = await waitForOwnerWorkerReady(child, startedAt);
    process.stderr.write(`BROWSER_WORKER_STARTUP_PHASES ${JSON.stringify(phases)}\n`);
    expect(phases.map(phase => phase.event)).toEqual(startupEvents);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
}, 30_000);
