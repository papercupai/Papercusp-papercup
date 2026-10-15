import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetBashJobs, getJob, readJobOutput, startBackground } from '../capability/bash-jobs';

// Keep the actual shell and confinement lifecycle; only the asynchronous PG
// persistence boundary is a fixture in this unit suite. The live e2e checks the
// real durable task registry and documents tool separately.
vi.mock('../../task-manager/store', async importOriginal => ({
  ...await importOriginal<typeof import('../../task-manager/store')>(),
  registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})),
  closeTask: vi.fn(async () => ({})),
  bindAgentSessionTaskToLatestNativeSession: vi.fn(async () => ({})),
}));

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const worker = fileURLToPath(new URL('../../../test/fixtures/background-content-summary.ts', import.meta.url));
const directories: string[] = [];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

afterEach(() => {
  __resetBashJobs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function execute(mode: 'success' | 'failure') {
  const state = mkdtempSync(join(tmpdir(), 'content-summary-job-test-'));
  directories.push(state);
  const input = join(state, 'provided.json');
  const started = join(state, 'started.txt');
  writeFileSync(input, JSON.stringify({ kind: 'text', text: 'North 12. South 34. FINAL TOTAL 56.', ref: 'fixture:public-report' }));
  const job = startBackground({ cwd: root, stateDir: state,
    command: [process.execPath, '--import', 'tsx', worker, input, started, mode].map(quote).join(' ') }, 40_000);
  const original = getJob(job.id);
  await expect.poll(() => getJob(job.id)?.status, { timeout: 45_000, interval: 50 }).not.toBe('running');
  const completed = getJob(job.id)!;
  expect(completed).toBe(original);
  expect(completed.taskId).toBeTruthy();
  expect(readFileSync(started, 'utf8').trim().split('\n')).toHaveLength(1);
  return { job: completed, output: readJobOutput(completed), log: readFileSync(completed.logPath, 'utf8') };
}

describe('background content summary through registered execution primitives', () => {
  it('executes intake and summarization in the managed job and retains its actual result', async () => {
    const { job, output, log } = await execute('success');
    expect(job.status).toBe('completed');
    expect(job.exitCode).toBe(0);
    const line = output.split('\n').find(value => value.startsWith('SUMMARY-RESULT '));
    expect(line).toBeTruthy();
    const receipt = JSON.parse(line!.slice('SUMMARY-RESULT '.length));
    expect(receipt.result).toMatchObject({ operation: 'summarize', sourceRefs: ['fixture:public-report'],
      summary: 'North reports 12, South reports 34, and the final total is 56.',
      coverage: { complete: true, characters: 'North 12. South 34. FINAL TOTAL 56.'.length, chunks: 1 }, usage: { calls: 1 }, cached: false });
    expect(receipt.requests).toHaveLength(1);
    expect(receipt.requests[0].quotedSource).toBe('North 12. South 34. FINAL TOTAL 56.');
    expect(log).toContain(line!);
  });

  it('retains provider failure as a failed job without a fabricated successful summary', async () => {
    const { job, output, log } = await execute('failure');
    expect(job.status).toBe('failed');
    expect(job.exitCode).toBe(1);
    expect(output).toContain('SUMMARY-FAILED');
    expect(log).toContain('Fixture provider failed');
    expect(output).not.toContain('SUMMARY-RESULT');
  });
});
