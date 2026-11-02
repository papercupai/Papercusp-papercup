import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEMD_RUNNER_JOB_END_PREFIX } from '../systemd-scope-env-runner.mjs';
import {
  JOB_LOG_END_MARKER_PREFIX,
  JOB_LOG_TERMINAL_TAIL_BYTES,
  parseJobLogEndMarker,
  readJobLogTerminal,
} from './job-log-terminal';

// WI-10004208: the reconciler recovers a lost-watcher job's exit from this line.
// The shape below is exactly what systemd-scope-env-runner.mjs formatJobEnd writes.
const runnerLine = (status: string, exit: number) =>
  `\n${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=${status} exit=${exit} at 2026-09-30T07:59:10.000Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.\n`;

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});
const logFile = (body: string): string => {
  dir = mkdtempSync(join(tmpdir(), 'job-log-terminal-'));
  const p = join(dir, 'bash-job.log');
  writeFileSync(p, body);
  return p;
};

describe('job-log-terminal', () => {
  it('derives its prefix from the runner that writes the line', () => {
    expect(JOB_LOG_END_MARKER_PREFIX).toBe(SYSTEMD_RUNNER_JOB_END_PREFIX);
  });

  it('reads a runner JOB END (success and failure) from a real log file', () => {
    expect(readJobLogTerminal(logFile(`RELEASED ok\n${runnerLine('completed', 0)}`))).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(readJobLogTerminal(logFile(`boom\n${runnerLine('failed', 4)}`))).toEqual({ status: 'failed', exitCode: 4 });
  });

  it('retains all runner identity pins from an identity-bearing failed JOB END', () => {
    const marker = runnerLine('failed', 1).replace(
      ' — this line was recorded',
      ' task=task-1 bash=bash-1 scope=task-1.service invocation=invocation-1 ' +
        `nonce=${'a'.repeat(64)} — this line was recorded`,
    );
    expect(parseJobLogEndMarker(marker)).toEqual({
      status: 'failed',
      exitCode: 1,
      taskId: 'task-1',
      bashJobId: 'bash-1',
      scopeUnit: 'task-1.service',
      invocationId: 'invocation-1',
      nonce: 'a'.repeat(64),
    });
  });

  it('finds the marker at the end of a log larger than the bounded tail it reads', () => {
    const big = 'x'.repeat(JOB_LOG_TERMINAL_TAIL_BYTES * 3) + runnerLine('completed', 0);
    expect(readJobLogTerminal(logFile(big))).toEqual({ status: 'completed', exitCode: 0 });
  });

  it('returns null (no evidence) for a missing file, an empty file, or a mid-line prefix', () => {
    expect(readJobLogTerminal('/nonexistent/job-log-terminal/none.log')).toBeNull();
    expect(readJobLogTerminal(logFile(''))).toBeNull();
    expect(parseJobLogEndMarker(`echo "${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=completed exit=0 at now"\n`)).toBeNull();
  });
});
