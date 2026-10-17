import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIsolatedWorker, isolatedWorkerPendingStage, retainIsolatedWorkerProgress } from '../test/isolated-integration-proof';

it('retains the innermost pending semantic step in a timed-out worker receipt', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-stage-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    retainIsolatedWorkerProgress(evidenceDir, 'delta-red-start');
    retainIsolatedWorkerProgress(evidenceDir, 'cursor-read-start');
    retainIsolatedWorkerProgress(evidenceDir, 'cursor-read-complete');
    retainIsolatedWorkerProgress(evidenceDir, 'typecheck-leg-start');
    retainIsolatedWorkerProgress(evidenceDir, 'compiler-process-start');
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 1000, killGraceMs: 100 });
    expect(result).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
    expect(JSON.parse(readFileSync(join(evidenceDir, 'worker-result.json'), 'utf8')).pendingStage)
      .toMatchObject({ stage: 'compiler-process-start' });
    retainIsolatedWorkerProgress(evidenceDir, 'compiler-process-complete');
    expect(isolatedWorkerPendingStage(evidenceDir)).toMatchObject({ stage: 'typecheck-leg-start' });
    retainIsolatedWorkerProgress(evidenceDir, 'typecheck-leg-failed');
    retainIsolatedWorkerProgress(evidenceDir, 'delta-red-failed');
    expect(isolatedWorkerPendingStage(evidenceDir)).toBeNull();
  } finally { child.kill('SIGKILL'); rmSync(evidenceDir, { recursive: true, force: true }); }
});
