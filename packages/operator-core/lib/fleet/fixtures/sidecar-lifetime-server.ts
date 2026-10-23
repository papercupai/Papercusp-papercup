/** Separate-process fixture: real IPC, exec and kernel containment; admission
 * persistence is replaced with an explicit test barrier. Never used at runtime. */
import { writeFile } from 'node:fs/promises';
// Emit before the real server's import graph, so an empty READY timeout can be
// distinguished from an import stall or a server that has reached listen().
const startedAt = performance.now();
const phase = (event: string) => process.stderr.write(`SIDECAR_FIXTURE_PHASE ${JSON.stringify({
  event, pid: process.pid, elapsedMs: performance.now() - startedAt,
})}\n`);
phase('entry');
const { runSpawnerSidecarServer } = await import('../spawner-sidecar-server');
phase('server-imported');
const { execProcess } = await import('../sidecar-exec-process');
phase('exec-imported');

const server = runSpawnerSidecarServer({
  executeProcess: (params, deps) => execProcess(params, {
    ...deps,
    lazyReceiptMs: 0, // the fixture's explicit admission barrier must gate the spawn
    beginExecution: async () => {
      if (process.env.PC_TEST_WAIT_ADMISSION_PATH) {
        await writeFile(process.env.PC_TEST_WAIT_ADMISSION_PATH, 'waiting');
        // The test kills this process before admission is granted. No PID exists.
        await new Promise(() => {});
      }
      return {
        receiptId: 'fixture',
        context: { contractVersion: 1, requestId: 'fixture', rootRequestId: 'fixture', parentRequestId: null,
          idempotencyKey: 'fixture', admissionClass: 'process', priority: 0, demand: { cpuWeight: 1 },
          depth: 0, createdAtMs: 1, decisionGeneration: 1 },
        lease: { leaseId: 'fixture', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'fixture' },
        finish: async () => true, cancel: async () => true,
      };
    },
  }),
});
phase('server-created');
server.once('listening', () => phase('listening'));
