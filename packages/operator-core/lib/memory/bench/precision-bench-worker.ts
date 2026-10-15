/**
 * Child-process entry point for the scheduled memory precision bench.
 *
 * Keep this boundary deliberately tiny: importing the bench core here gives it
 * its own process-global memory host/client, while the parent only receives the
 * final metrics over stdout.
 */
import { jevFetch } from '../jev-transport';
import {
  benchMemoryPrecision,
  createPrecisionBenchJevGate,
  PRECISION_BENCH_JEV_API_KEY_ENV,
  PRECISION_BENCH_JEV_GATE_ENV,
  PRECISION_BENCH_JEV_LEDGER_MARKER,
  PRECISION_BENCH_RESULT_MARKER,
  PRECISION_BENCH_WORKSPACE_ID_ENV,
} from './precision-bench-core';
import { configurePrecisionBenchMemoryHost, PRECISION_BENCH_EMBEDDER_MODE_ENV } from './precision-bench-host';

try {
  configurePrecisionBenchMemoryHost(process.env[PRECISION_BENCH_EMBEDDER_MODE_ENV]);
  const jevGate = process.env[PRECISION_BENCH_JEV_GATE_ENV] === '1';
  let gate: ReturnType<typeof createPrecisionBenchJevGate> | undefined;
  if (jevGate) {
    const workspaceId = process.env[PRECISION_BENCH_WORKSPACE_ID_ENV];
    const apiKey = process.env[PRECISION_BENCH_JEV_API_KEY_ENV];
    if (!workspaceId) throw new Error(`missing ${PRECISION_BENCH_WORKSPACE_ID_ENV}`);
    if (!apiKey) throw new Error(`missing ${PRECISION_BENCH_JEV_API_KEY_ENV}`);
    gate = createPrecisionBenchJevGate({
      workspaceId,
      apiKey,
      fetch: jevFetch,
      onLedgerEntry: (entry) => {
        process.stdout.write(`${PRECISION_BENCH_JEV_LEDGER_MARKER}${JSON.stringify(entry)}\n`);
      },
    });
  }
  const metrics = await benchMemoryPrecision({ jevGate, ...(gate ? { gate } : {}) });
  process.stdout.write(`${PRECISION_BENCH_RESULT_MARKER}${JSON.stringify(metrics)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
