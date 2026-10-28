import { parentPort, workerData } from 'node:worker_threads';
import { collectCodexStartingStuckSnapshot } from './psu-pty-host.mjs';

const startedAt = process.hrtime.bigint();
const cpuStartedAt = process.cpuUsage();
const snapshot = collectCodexStartingStuckSnapshot(workerData ?? {});
const cpu = process.cpuUsage(cpuStartedAt);

parentPort?.postMessage({
  snapshot,
  snapshotWallMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
  snapshotCpuMs: (cpu.user + cpu.system) / 1_000,
});
