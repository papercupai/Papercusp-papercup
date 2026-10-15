/** One-shot worker entry: all synchronous Codex-home filesystem work runs here. */
import { parentPort, workerData } from 'node:worker_threads';
import { executeCodexHomeMaterializerJob } from './role-codex-home.ts';
import type { CodexHomeMaterializerJob } from './role-codex-home-offload.ts';

if (!parentPort) throw new Error('role-codex-home.worker must run as a worker thread');

const port = parentPort;
try {
  const value = executeCodexHomeMaterializerJob(workerData as CodexHomeMaterializerJob);
  port.postMessage({ ok: true, value });
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  port.postMessage({ ok: false, error: { name: err.name, message: err.message, stack: err.stack } });
} finally {
  port.close();
}
