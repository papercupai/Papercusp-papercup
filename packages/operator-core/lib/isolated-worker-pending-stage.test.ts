import { it, expect, vi } from 'vitest';
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

it('relays real nested phase and test advances without forwarding repeated heartbeats or private output', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'isolated-progress-'));
  const child = spawn(process.execPath, ['-e', `
    process.send({ kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:one.sql' });
    process.send({ kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:one.sql' });
    process.send({ kind: 'isolated-runtime-start' });
    const trace = 'TEST_FILE_CASE_TRACE ' + JSON.stringify({ event: 'finished', file: 'proof.test.ts', name: 'private case name' });
    const progress = 'TEST_FILE_PROGRESS state=running lastOutputLine=' + JSON.stringify({ channel: 'stderr', text: trace });
    console.log(progress); console.log(progress);
    console.log('TEST_FILE_HEARTBEAT completedCases=1');
    console.log('TEST_FILE_HEARTBEAT completedCases=1');
    console.log('TEST_FILE_PROGRESS state=running lastOutputLine=' + JSON.stringify({ text: { private: true } }));
    console.log('unstructured private output');
    process.send({ kind: 'isolated-runtime-stopping' });
    const sample = n => ({ kind: 'isolated-runtime-cleanup', stage: 'pg-stop-observation',
      processes: [{ pid: 1, startTicks: '10', io: { syscw: String(n), write_bytes: String(n) } }] });
    process.send(sample(1)); process.send(sample(2)); process.send(sample(2));
    setTimeout(() => process.exit(0), 30);
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, {
      phaseTimeouts: { bootstrapMs: 2000, executeMs: 2000, teardownMs: 2000 }, progressIntervalMs: 0,
    });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    const lines = stderr.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith('ISOLATED_WORKER_PROGRESS '));
    expect(lines.filter(line => line.includes('migration:one.sql'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('test-case-finished'))).toHaveLength(1);
    expect(lines.filter(line => line.includes('test-case-completed'))).toHaveLength(1);
    expect(lines.join('')).toContain('phase-execute');
    expect(lines.filter(line => line.includes('pg-stop-io'))).toHaveLength(1);
    expect(lines.join('')).not.toContain('private case name');
    expect(lines.join('')).not.toContain('unstructured private output');
    expect(readFileSync(join(evidenceDir, 'worker.log'), 'utf8')).toContain('unstructured private output');
  } finally {
    stderr.mockRestore(); child.kill('SIGKILL'); rmSync(evidenceDir, { recursive: true, force: true });
  }
});
