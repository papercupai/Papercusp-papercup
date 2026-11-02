/**
 * Unit tests for the bash capability core (P-010, B-05). Exercises the real
 * shell (no PG, no mocks): foreground run + output streaming, output-spill to a
 * log, wall-clock timeout, abort, and the background job lifecycle
 * (start → incremental read → completion / kill).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV,
  CAPABILITY_SANDBOX_TMPDIR,
  BASH_TEST_MEMORY_MAX_BYTES,
  BASH_TEST_TASKS_MAX,
  capturePreflightAttributionSnapshot,
  classifyBackgroundCloseStatus,
  classifyDeadlineReason,
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  detectPreflightFailureMarker,
  INLINE_OUTPUT_CAP,
  JOB_LOG_END_MARKER_PREFIX,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PC_HEAVY_QUEUE_ABORT_MARKER,
  PC_HEAVY_QUEUE_WAIT_MARKER,
  PC_HEAVY_SLOT_ACQUIRED_MARKER,
  PC_HEAVY_DURABLE_CALLER_ENV,
  PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX,
  STREAM_LINE_OUTPUT_CAP,
  STREAM_LINE_TRUNCATION_MARKER,
  __resetBashJobs,
  CAPABILITY_OUTPUT_REDACTION_PATTERNS,
  createCapabilityOutputRedactor,
  createStreamingSecretRedactor,
  createStreamingLineCap,
  SPILL_LOG_MODE,
  detectBufferingLastStage,
  detectMissingCommandDiagnostic,
  detectSelfOutputRedirect,
  detectUntrackedShellBackgrounding,
  formatBufferingPipelineAdvice,
  formatSelfRedirectAdvice,
  formatPreflightAttributionSnapshot,
  formatJobLogEndMarker,
  formatUntrackedShellBackgroundAdvice,
  getJob,
  isBackgroundTestCommand,
  killJob,
  normalizeExpectedRgNoMatchResult,
  normalizeExpectedPsPpidEmptyResult,
  normalizeExpectedSigpipeResult,
  readJobOutput,
  runForeground,
  snapshotJobResult,
  startBackground,
  BashTaskConfinementRequiredError,
} from './bash-jobs';
import { augmentedSpawnPath } from '../../plugin-spawn-impl';
import { taskManagerEnabledSync } from '../../task-manager/enabled';
import * as enrollSync from '../../task-manager/enroll-sync';
import { notifyTaskKillRequested } from '../../task-manager/kill-notify';
import {
  composeStreamingRedactors,
  createStreamingPatternRedactor,
  decodeRedactions,
  SYSTEMD_RUNNER_BASH_JOB_ID_ENV,
  SYSTEMD_RUNNER_JOB_END_PREFIX,
  SYSTEMD_RUNNER_MARKER_SECRET_ENV,
  SYSTEMD_RUNNER_OUTPUT_PATH_ENV,
  SYSTEMD_RUNNER_REDACTIONS_ENV,
  SYSTEMD_RUNNER_SCOPE_UNIT_ENV,
  SYSTEMD_RUNNER_TASK_ID_ENV,
} from '../../systemd-scope-env-runner.mjs';
import { readJobLogTerminal } from '../../task-manager/job-log-terminal';
import { SELF_IDENTIFYING_SECRET_PATTERN } from '../../sensitive-text';
import {
  PIDS_PER_CONCURRENT_TASK,
  PIDS_RESERVE,
  resolveTaskBudget,
} from '../../../../../scripts/lib/budgeted-task-scheduler.mjs';

const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-'));
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const never = new AbortController().signal;

afterEach(() => __resetBashJobs());

// Default ABOVE every background job's own deadline in this file (10–20s), so the
// wait always observes a terminal status unless the runner itself is broken.
// It returns SILENTLY on timeout, and the old 5s default let a job still spinning
// up its transient service under green-checkpoint load be read mid-run: the
// redaction test then failed as "expected '' to contain [REDACTED …]", naming a
// redaction regression that did not exist (WI-2144525, gate run on f3123367;
// the same sha passed in isolation). A caller that passed before returns at the
// same moment as before — this only lengthens waits that used to be cut short.
async function waitForStatus(id: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const j = getJob(id);
    if (j && j.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('runForeground', () => {
  it('rejects a confined command before its host effect when no sandbox works', async () => {
    const marker = join(STATE, `confined-effect-${crypto.randomUUID()}.txt`);
    await expect(
      runForeground(
        {
          command: `printf ran > ${JSON.stringify(marker)}`,
          cwd: STATE,
          stateDir: STATE,
          sandboxEnabled: true,
          sandboxRequired: true,
          sandboxBuildOpts: { bwrapWorks: false, srtBin: null },
        },
        never,
        10_000,
      ),
    ).rejects.toThrow(/Raw host execution was not attempted/);
    expect(existsSync(marker)).toBe(false);
  });

  it('captures stdout + exit code and streams chunks', async () => {
    const chunks: string[] = [];
    const r = await runForeground(
      { command: 'echo hello-world', cwd: STATE, stateDir: STATE, onChunk: (c) => chunks.push(c) },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('hello-world');
    expect(chunks.join('')).toContain('hello-world');
  });

  it('runs a script larger than the per-argument limit through stdin while preserving command EOF (EI-25538971645697745)', async () => {
    const largeComment = `# ${'x'.repeat(140 * 1024)}`;
    const command = `${largeComment}\nif IFS= read -r unexpected; then printf 'unexpected stdin: %s' "$unexpected"; else printf large-command-ok; fi`;
    expect(Buffer.byteLength(command)).toBeGreaterThan(128 * 1024);

    const r = await runForeground({ command, cwd: STATE, stateDir: STATE }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('large-command-ok');
  });

  it('preserves a UTF-8 code point split across stdout chunks in every output sink (WI-910499)', async () => {
    const streamed: string[] = [];
    const r = await runForeground(
      {
        // Force the first byte of 😀 (F0 9F 98 80) into a separate data event.
        command: "printf '\\360'; sleep 0.2; printf '\\237\\230\\200'",
        cwd: STATE,
        stateDir: STATE,
        onChunk: (chunk) => streamed.push(chunk),
      },
      never,
      10_000,
    );
    const spill = readFileSync(r.logPath, 'utf8');

    expect(r.status).toBe('completed');
    expect(r.output).toBe('😀');
    expect(streamed.join('')).toContain('😀');
    expect(spill).toContain('😀');
    for (const surface of [r.output, streamed.join(''), spill]) {
      expect(surface).not.toContain('\uFFFD');
    }
  });

  it('captures stderr and a non-zero exit', async () => {
    const r = await runForeground({ command: 'echo oops >&2; exit 3', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.exitCode).toBe(3);
    expect(r.status).toBe('failed');
    expect(r.output).toContain('oops');
  });

  it('adds nested cwd ancestor node_modules/.bin entries to PATH', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cap-bash-local-bin-'));
    const packageDir = join(repo, 'packages', 'operator-core');
    const binDir = join(repo, 'node_modules', '.bin');
    const binName = 'capability-bash-local-bin-test';
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, binName);
    writeFileSync(binPath, '#!/bin/sh\nprintf local-bin-found\n');
    chmodSync(binPath, 0o755);

    const r = await runForeground({ command: binName, cwd: packageDir, stateDir: repo }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('local-bin-found');
  });

  it("a failing command piped through a truncating filter (tail) reports the PIPELINE exit code, not the filter's (EI-13414)", async () => {
    // Without `-o pipefail`, bash reports the LAST command's exit status for a
    // pipe — `exit 1 | tail -60` would report 0 (tail always succeeds), silently
    // masking the real failure. This is the exact near-miss that filed EI-13414:
    // `npm run test:affected 2>&1 | tail -60` reported exit 0 while the runner
    // had actually failed.
    const r = await runForeground(
      { command: 'echo "1 non-quarantined task(s) failed" >&2; exit 1 | tail -60', cwd: STATE, stateDir: STATE },
      never,
      10_000,
    );
    expect(r.exitCode).toBe(1);
    expect(r.status).toBe('failed');
  });

  it('a successful pipeline still reports exit 0 (pipefail does not false-positive on a clean pipe)', async () => {
    const r = await runForeground({ command: 'echo hello | tail -1', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.exitCode).toBe(0);
    expect(r.status).toBe('completed');
  });

  it('treats producer SIGPIPE as success for a bounded read-only head pipeline', async () => {
    const command = ['rg --files', JSON.stringify(REPO_ROOT), '| head -n 1'].join(' ');
    const r = await runForeground({ command, cwd: STATE, stateDir: STATE }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(REPO_ROOT + '/');
  });

  it('treats an rg no-match consumed by wc as a successful zero-count probe', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cap-bash-rg-count-'));
    const file = join(fixture, 'fixture.txt');
    writeFileSync(file, 'present\n');
    const command = `rg -l -F missing ${JSON.stringify(file)} | wc -l`;
    const r = await runForeground({ command, cwd: fixture, stateDir: fixture }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('0');
  });

  it('treats an rg no-match consumed by tail as a successful empty probe', async () => {
    const command = "printf '%s\\n' present | rg -F missing | tail -n 20";
    const r = await runForeground({ command, cwd: STATE, stateDir: STATE }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('');
  });

  it('treats an empty numeric-parent ps probe as a successful empty enumeration', async () => {
    const command = "ps --ppid 2147483647 -o pid= | awk '{print $1}'";
    const r = await runForeground({ command, cwd: STATE, stateDir: STATE }, never, 10_000);

    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('');
  });

  it('keeps a bare rg no-match as a failed search', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cap-bash-rg-no-match-'));
    const file = join(fixture, 'fixture.txt');
    writeFileSync(file, 'present\n');
    const command = `rg -l -F missing ${JSON.stringify(file)}`;
    const r = await runForeground({ command, cwd: fixture, stateDir: fixture }, never, 10_000);

    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(1);
  });

  it('normalizes only read-only rg pipelines with an empty-safe consumer', () => {
    expect(normalizeExpectedRgNoMatchResult('rg -l -F missing fixture.txt | wc -l', 'failed', 1, '0\n')).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(normalizeExpectedRgNoMatchResult('journalctl -u svc | rg -F missing | tail -n 20', 'failed', 1, '')).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(normalizeExpectedRgNoMatchResult('rg -l -F missing fixture.txt', 'failed', 1, '')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(normalizeExpectedRgNoMatchResult('rg -l -F missing fixture.txt | tail -n 20 && echo done', 'failed', 1, '')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(normalizeExpectedRgNoMatchResult('rg -l -F missing fixture.txt | wc -l && echo done', 'failed', 1, '0\n')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(normalizeExpectedRgNoMatchResult('journalctl -u svc | rg -F missing | tail -n 20', 'failed', 1, 'journalctl: permission denied')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
  });

  it('normalizes only an empty numeric-parent ps probe', () => {
    const command = "ps --ppid 12345 -o pid= | awk '{print $1}'";
    expect(normalizeExpectedPsPpidEmptyResult(command, 'failed', 1, '')).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(normalizeExpectedPsPpidEmptyResult(command, 'failed', 1, 'ps: invalid option')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(normalizeExpectedPsPpidEmptyResult("ps --ppid '$PPID' -o pid= | awk '{print $1}'", 'failed', 1, '')).toEqual({
      status: 'failed',
      exitCode: 1,
    });
    expect(normalizeExpectedPsPpidEmptyResult(command, 'completed', 0, '')).toEqual({
      status: 'completed',
      exitCode: 0,
    });
  });

  it('does not normalize SIGPIPE outside the narrow bounded-read shape', () => {
    expect(normalizeExpectedSigpipeResult('rg --files . | head -n 1', 'failed', 141)).toEqual({
      status: 'completed',
      exitCode: 0,
    });
    expect(normalizeExpectedSigpipeResult('cat input | tail -n 1', 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
    expect(normalizeExpectedSigpipeResult('unknown-mutator | head -n 1', 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
    expect(normalizeExpectedSigpipeResult('rg --files . | head -n 1 && echo ok', 'failed', 141)).toEqual({
      status: 'failed',
      exitCode: 141,
    });
  });

  it('fails loudly when a missing command is hidden inside a successful outer pipeline', async () => {
    // `pipefail` cannot see a command-substitution failure when the command
    // consuming its output exits 0. The raw shell diagnostic is still decisive:
    // do not let a missing tool become a false-green capability result.
    const r = await runForeground(
      {
        command: `printf '%s\\n' "$(papercusp-command-that-is-not-installed)" | head -1`,
        cwd: STATE,
        stateDir: STATE,
      },
      never,
      10_000,
    );
    expect(r.status).toBe('failed');
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('papercusp-command-that-is-not-installed: command not found');
  });

  it('does not mistake missing-command fixture output for a failure of the wrapper shell', async () => {
    const r = await runForeground(
      {
        command:
          `printf '%s\\n' 'environment: line 31: find_open_duplicate: command not found' ` +
          `' /usr/bin/env: fakebun: No such file or directory'; exit 0`,
        cwd: STATE,
        stateDir: STATE,
      },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
  });

  it('recognizes Bash and POSIX missing-command diagnostics without assuming a host path', () => {
    expect(detectMissingCommandDiagnostic('/bin/bash: line 1: rg: command not found\n')).toEqual({
      command: 'rg',
      line: '/bin/bash: line 1: rg: command not found',
    });
    expect(detectMissingCommandDiagnostic('sh: rg: not found\n')).toEqual({
      command: 'rg',
      line: 'sh: rg: not found',
    });
    expect(detectMissingCommandDiagnostic('command completed\n')).toBeNull();
  });

  it('spills large output to a log file and trims the inline result', async () => {
    const r = await runForeground(
      {
        command: 'for i in $(seq 1 4000); do echo "line-$i padding padding padding padding"; done',
        cwd: STATE,
        stateDir: STATE,
      },
      never,
      20_000,
    );
    expect(r.status).toBe('completed');
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(INLINE_OUTPUT_CAP + 200);
    expect(existsSync(r.logPath)).toBe(true);
    const full = readFileSync(r.logPath, 'utf8');
    expect(full.length).toBeGreaterThan(INLINE_OUTPUT_CAP);
    expect(full).toContain('line-4000');
  });

  it('caps one overlong streamed line across chunks with a marker', () => {
    const cap = createStreamingLineCap();
    const first = cap.push(`prefix-${'x'.repeat(STREAM_LINE_OUTPUT_CAP)}`);
    const second = cap.push('suffix\n');
    const streamed = first + second + cap.flush();

    expect(streamed).toContain(STREAM_LINE_TRUNCATION_MARKER);
    expect(streamed.split('\n')[0]).toHaveLength(STREAM_LINE_OUTPUT_CAP);
    expect(streamed.endsWith('\n')).toBe(true);
  });

  it('bounds a minified single-line stream while preserving the complete spill log', async () => {
    const line = `prefix-${'x'.repeat(STREAM_LINE_OUTPUT_CAP + 100)}-suffix`;
    const streamed: string[] = [];
    const r = await runForeground(
      {
        command: `printf '%s\\n' ${JSON.stringify(line)}`,
        cwd: STATE,
        stateDir: STATE,
        onChunk: (chunk) => streamed.push(chunk),
      },
      never,
      10_000,
    );
    const spill = readFileSync(r.logPath, 'utf8');
    const streamedOutput = streamed.join('');

    expect(streamedOutput).toContain(STREAM_LINE_TRUNCATION_MARKER);
    expect(streamedOutput.split('\n')[0]).toHaveLength(STREAM_LINE_OUTPUT_CAP);
    expect(spill).toContain(`${line}\n`);
    expect(spill).not.toContain(STREAM_LINE_TRUNCATION_MARKER);
  });

  it('enforces the wall-clock timeout', async () => {
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, never, 300);
    expect(r.status).toBe('timed_out');
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await runForeground({ command: 'sleep 10', cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
    expect(r.status).toBe('killed');
  });
});

describe('integration credential output redaction (EI-20478240377353884)', () => {
  const secret = 'integration-test-secret-0123456789';

  it('redacts a secret split across arbitrary child-process chunks', () => {
    const redactor = createStreamingSecretRedactor([secret])!;
    const safe = [
      redactor.push(`before:${secret.slice(0, 7)}`),
      redactor.push(secret.slice(7, 21)),
      redactor.push(`${secret.slice(21)}:after`),
      redactor.flush(),
    ].join('');

    expect(safe).toBe('before:[REDACTED integration credential]:after');
    expect(safe).not.toContain(secret);
    expect(safe).not.toContain(secret.slice(0, 21));
  });

  it('chooses a replacement marker that cannot reproduce a short saved secret', () => {
    const collidingSecret = 'REDACTED';
    const redactor = createStreamingSecretRedactor([collidingSecret])!;
    const safe = redactor.push(`before:${collidingSecret}:after`) + redactor.flush();

    expect(safe).toMatch(/^before:.+:after$/);
    expect(safe).not.toContain(collidingSecret);
  });

  it('redacts foreground result, stream events, and the spill log through one shared boundary', async () => {
    const streamed: string[] = [];
    const r = await runForeground(
      {
        command: 'printf "prefix:%s:suffix" "$EI_INTEGRATION_SECRET"',
        cwd: STATE,
        stateDir: STATE,
        env: { EI_INTEGRATION_SECRET: secret },
        redactValues: [secret],
        onChunk: (chunk) => streamed.push(chunk),
      },
      never,
      10_000,
    );
    const spill = readFileSync(r.logPath, 'utf8');

    expect(r.output).toContain('prefix:[REDACTED integration credential]:suffix');
    expect(streamed.join('')).toContain('prefix:[REDACTED integration credential]:suffix');
    expect(spill).toContain('prefix:[REDACTED integration credential]:suffix');
    for (const surface of [r.output, streamed.join(''), spill]) {
      expect(surface).not.toContain(secret);
    }
  });

  it('redacts background retained output and the durable spill log', async () => {
    const job = startBackground(
      {
        command: 'printf "%s" "$EI_INTEGRATION_SECRET"',
        cwd: STATE,
        stateDir: STATE,
        env: { EI_INTEGRATION_SECRET: secret },
        redactValues: [secret],
      },
      10_000,
    );
    await waitForStatus(job.id);
    const finished = getJob(job.id)!;
    // Assert the job actually FINISHED before judging its output: an unfinished
    // job reads as empty output, which would otherwise masquerade as a redaction
    // failure (see waitForStatus).
    expect(finished.status).toBe('completed');
    const output = readJobOutput(finished);
    const spill = readFileSync(job.logPath, 'utf8');

    expect(output).toContain('[REDACTED integration credential]');
    expect(spill).toContain('[REDACTED integration credential]');
    expect(output).not.toContain(secret);
    expect(spill).not.toContain(secret);
  });
});

describe('credential-SHAPE output redaction + owner-only spill (WI-10003538)', () => {
  // Assembled at runtime so this file never carries a secret-shaped literal
  // (the secrets guard and content-lint would rightly flag one).
  const FAKE_GITHUB = ['gh', 'p_', 'Q'.repeat(36)].join('');
  const FAKE_AWS = ['AK', 'IA', 'Z'.repeat(16)].join('');
  const FAKE_ANTHROPIC = ['sk', '-ant-', 'x'.repeat(40)].join('');
  const FAKES = [FAKE_GITHUB, FAKE_AWS, FAKE_ANTHROPIC];
  const shapeEnv = { WI3538_GH: FAKE_GITHUB, WI3538_AWS: FAKE_AWS, WI3538_ANT: FAKE_ANTHROPIC };
  const shapeCommand = 'printf "gh=%s aws=%s ant=%s\\n" "$WI3538_GH" "$WI3538_AWS" "$WI3538_ANT"';
  const shapeRedacted = 'gh=[redacted] aws=[redacted] ant=[redacted]';

  it('sources its patterns from sensitive-text rather than a forked list', () => {
    expect(CAPABILITY_OUTPUT_REDACTION_PATTERNS).toEqual([SELF_IDENTIFYING_SECRET_PATTERN]);
  });

  it('redacts a token split across chunks and never emits a partial token prefix', () => {
    const redactor = createStreamingPatternRedactor([SELF_IDENTIFYING_SECRET_PATTERN])!;
    const pieces = [
      redactor.push(`token=${FAKE_GITHUB.slice(0, 6)}`),
      redactor.push(FAKE_GITHUB.slice(6, 20)),
      redactor.push(`${FAKE_GITHUB.slice(20)} done\n`),
      redactor.flush(),
    ];

    expect(pieces.join('')).toBe('token=[redacted] done\n');
    for (const piece of pieces) expect(piece).not.toContain(FAKE_GITHUB.slice(0, 6));
  });

  it('holds only the trailing token run, and releases a delimiter-free blob past maxHold', () => {
    const redactor = createStreamingPatternRedactor([SELF_IDENTIFYING_SECRET_PATTERN], 8)!;
    expect(redactor.push('ok: abc')).toBe('ok: ');
    expect(redactor.push('defghijkl')).toBe('abcdefghijkl');
    expect(redactor.flush()).toBe('');
  });

  it('chains exact values before shapes, and flush drains every stage', () => {
    const exact = 'opaque-bound-credential-0123456789';
    const redactor = composeStreamingRedactors(
      createStreamingSecretRedactor([exact]),
      createStreamingPatternRedactor([SELF_IDENTIFYING_SECRET_PATTERN]),
    )!;
    const safe = redactor.push(`a=${exact.slice(0, 10)}`) + redactor.push(`${exact.slice(10)} b=${FAKE_AWS}`) + redactor.flush();

    expect(safe).toBe('a=[REDACTED integration credential] b=[redacted]');
    expect(createCapabilityOutputRedactor(undefined).push(`x ${FAKE_ANTHROPIC} `)).toBe('x [redacted] ');
  });

  it('decodes the runner payload in both the object and the legacy bare-array shape', () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
    expect(decodeRedactions(encode(['v1']))).toEqual({ values: ['v1'], patterns: [] });
    expect(decodeRedactions(encode({ values: ['v1'], patterns: [SELF_IDENTIFYING_SECRET_PATTERN] }))).toEqual({
      values: ['v1'],
      patterns: [{ ...SELF_IDENTIFYING_SECRET_PATTERN }],
    });
    expect(decodeRedactions('')).toEqual({ values: [], patterns: [] });
    expect(() => decodeRedactions(encode({ values: [1] }))).toThrow('invalid durable-output redaction payload');
  });

  it('foreground: redacts shapes nobody bound from result, stream events and spill; spill is 0600', async () => {
    const streamed: string[] = [];
    const r = await runForeground(
      { command: shapeCommand, cwd: STATE, stateDir: STATE, env: shapeEnv, onChunk: (chunk) => streamed.push(chunk) },
      never,
      10_000,
    );
    const spill = readFileSync(r.logPath, 'utf8');

    for (const surface of [r.output, streamed.join(''), spill]) {
      expect(surface).toContain(shapeRedacted);
      for (const fake of FAKES) expect(surface).not.toContain(fake);
    }
    expect(statSync(r.logPath).mode & 0o777).toBe(SPILL_LOG_MODE);
  });

  it('background: redacts shapes from retained output and the spill log; spill is 0600', async () => {
    const job = startBackground({ command: shapeCommand, cwd: STATE, stateDir: STATE, env: shapeEnv }, 10_000);
    await waitForStatus(job.id);
    const finished = getJob(job.id)!;
    expect(finished.status).toBe('completed');
    const output = readJobOutput(finished);
    const spill = readFileSync(job.logPath, 'utf8');

    for (const surface of [output, spill]) {
      expect(surface).toContain(shapeRedacted);
      for (const fake of FAKES) expect(surface).not.toContain(fake);
    }
    expect(statSync(job.logPath).mode & 0o777).toBe(SPILL_LOG_MODE);
  });
});

describe('background jobs', () => {
  it.each([undefined, 'server-dispatch-enrollment'])('dispatch correlation preserves enrollment identity %s', async (dispatchCallId) => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'dispatch-enrollment-task', enrolled: true, confined: false,
      unconfinedReason: 'no-scope-support', unitKind: 'scope', scopeUnit: null,
      registrationReady: null, wrap: (binary: string, argv: string[]) => ({ binary, argv }),
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({ command: 'printf correlation', cwd: STATE, stateDir: STATE,
        ...(dispatchCallId ? { dispatchCallId } : {}),
      }, 5_000);
      await waitForStatus(job.id);
      expect(job.status).toBe('completed');
      expect(job.exitCode).toBe(0);
      expect(complete).toHaveBeenCalledOnce();
      const detail = complete.mock.calls[0]![1].detail;
      expect(detail).toMatchObject({ bashJobId: job.id });
      if (dispatchCallId) expect(detail).toHaveProperty('dispatchCallId', dispatchCallId);
      else expect(detail).not.toHaveProperty('dispatchCallId');
    } finally { begin.mockRestore(); complete.mockRestore(); finish.mockRestore(); }
  });

  it.each(['flag-off', 'probe-pending', 'no-scope-support', 'caller-veto', 'scope-unit-missing'] as const)(
    'required task confinement refuses %s before command or wrapper execution', (reason) => {
      const marker = join(STATE, `required-confinement-${reason}`);
      const wrap = vi.fn((binary: string, argv: string[]) => ({ binary, argv }));
      const release = vi.fn();
      const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
        taskId: 'required-confinement-refused',
        enrolled: reason !== 'flag-off',
        confined: reason === 'scope-unit-missing',
        unconfinedReason: reason === 'scope-unit-missing' ? null : reason,
        unitKind: 'service', scopeUnit: null, registrationReady: null,
        wrap, releaseEnvironmentTransport: release,
      });
      try {
        expect(() => startBackground({
          command: `touch ${marker}`, cwd: STATE, stateDir: STATE, requireTaskConfinement: true,
        }, 5_000)).toThrow(BashTaskConfinementRequiredError);
        expect(wrap).not.toHaveBeenCalled();
        expect(existsSync(marker)).toBe(false);
        expect(release).toHaveBeenCalledOnce();
      } finally { begin.mockRestore(); }
    },
  );

  it('required task confinement preserves a successful bounded launch', async () => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'required-confinement-success', enrolled: true, confined: true,
      unconfinedReason: null, unitKind: 'service', scopeUnit: 'required-confinement-success.service',
      registrationReady: null,
      wrap: (binary: string, argv: string[]) => ({ binary, argv }),
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({
        command: 'printf confined-result', cwd: STATE, stateDir: STATE, requireTaskConfinement: true,
      }, 5_000);
      await waitForStatus(job.id);
      expect(begin).toHaveBeenCalledWith({ class: 'bash-job', runtimeMaxSec: 5 });
      expect(job.status).toBe('completed');
      expect(job.exitCode).toBe(0);
      expect(readJobOutput(job)).toBe('confined-result');
      expect(job.timeoutMs).toBe(5_000);
    } finally { begin.mockRestore(); complete.mockRestore(); finish.mockRestore(); }
  });

  it('records observed spawn and pipe phases in the durable log without changing command output', async () => {
    const job = startBackground({ command: 'printf phase-proof', cwd: STATE, stateDir: STATE }, 30_000);
    await waitForStatus(job.id);
    expect(job.status).toBe('completed');
    expect(readJobOutput(job)).toBe('phase-proof');
    const timing = job.phaseTiming!;
    expect(timing.spawnReturnedAt).toBeGreaterThanOrEqual(timing.spawnRequestedAt);
    expect(timing.clientSpawnedAt).not.toBeNull();
    expect(timing.firstPipeByteAt).not.toBeNull();
    expect(timing.firstPipeByteAt!).toBeGreaterThanOrEqual(timing.clientSpawnedAt!);
    expect(job.endedAt!).toBeGreaterThanOrEqual(timing.firstPipeByteAt!);
    const log = readFileSync(job.logPath, 'utf8');
    expect(log).toContain(`spawn_requested_at=${timing.spawnRequestedAt}`);
    expect(log).toContain(`ended_at=${job.endedAt}`);
    expect(log).toContain('JOB END: status=completed');
  });

  it('leaves an unobserved first pipe byte null for a silent command', async () => {
    const job = startBackground({ command: 'exit 0', cwd: STATE, stateDir: STATE }, 30_000);
    await waitForStatus(job.id);
    expect(job.status).toBe('completed');
    expect(readJobOutput(job)).toBe('');
    expect(job.phaseTiming!.firstPipeByteAt).toBeNull();
    expect(readFileSync(job.logPath, 'utf8')).toContain('first_pipe_byte_at=null');
  });

  it('executes the background payload in its requested cwd, not the operator home', async () => {
    const job = startBackground({ command: 'pwd', cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const final = getJob(job.id)!;

    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(readJobOutput(final)).toContain(`${STATE}\n`);
  });

  it('passes the scrubbed identity and final augmented PATH into the transient service payload', async () => {
    const previousSid = process.env.PAPERCUSP_SID;
    const previousWorkspace = process.env.PAPERCUSP_WORKSPACE;
    const previousSecret = process.env.DATABASE_URL;
    process.env.PAPERCUSP_SID = 'service-payload-session';
    process.env.PAPERCUSP_WORKSPACE = 'papercusp-workspace';
    process.env.DATABASE_URL = 'postgres://user:pw@host/should-not-leak';

    let wrappedEnv: Readonly<Record<string, string | undefined>> | undefined;
    let wrappedCwd: string | undefined;
    const wrap = vi.fn(
      (binary: string, argv: string[], env?: Readonly<Record<string, string | undefined>>, cwd?: string) => {
        wrappedEnv = env;
        wrappedCwd = cwd;
        const outputPath = env?.[SYSTEMD_RUNNER_OUTPUT_PATH_ENV];
        const taskId = env?.[SYSTEMD_RUNNER_TASK_ID_ENV];
        const bashJobId = env?.[SYSTEMD_RUNNER_BASH_JOB_ID_ENV];
        const scopeUnit = env?.[SYSTEMD_RUNNER_SCOPE_UNIT_ENV];
        const secret = env?.[SYSTEMD_RUNNER_MARKER_SECRET_ENV];
        if (outputPath && taskId && bashJobId && scopeUnit && secret) {
          const nonce = createHash('sha256').update(secret).digest('hex');
          writeFileSync(
            outputPath,
            `\n${SYSTEMD_RUNNER_JOB_END_PREFIX}: status=completed exit=0 at 2026-11-02T19:00:00.000Z ` +
              `task=${taskId} bash=${bashJobId} scope=${scopeUnit} invocation=test-invocation nonce=${nonce}\n`,
          );
        }
        return { binary, argv };
      },
    );
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'service-payload-task',
      confined: true,
      unconfinedReason: null,
      unitKind: 'service',
      scopeUnit: 'service-payload-task.service',
      enrolled: true,
      registrationReady: null,
      wrap,
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});

    try {
      const job = startBackground(
        {
          command:
            'printf "SID=%s|WS=%s|PATH=%s|EXPLICIT=%s|SECRET=%s" "$PAPERCUSP_SID" "$PAPERCUSP_WORKSPACE" "$PATH" "$EXPLICIT" "${DATABASE_URL:-unset}"',
          cwd: STATE,
          stateDir: STATE,
          env: {
            EXPLICIT: 'per-call',
            [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: '/tmp/caller-forged-runner-output',
            [SYSTEMD_RUNNER_REDACTIONS_ENV]: 'caller-forged-redactions',
          },
          redactValues: ['durable-redaction-secret'],
        },
        10_000,
      );
      await waitForStatus(job.id);

      expect(job.status).toBe('completed');
      expect(wrap).toHaveBeenCalledOnce();
      expect(wrappedCwd).toBe(STATE);
      expect(wrappedEnv).toMatchObject({
        PAPERCUSP_SID: 'service-payload-session',
        PAPERCUSP_WORKSPACE: 'papercusp-workspace',
        EXPLICIT: 'per-call',
        PATH: augmentedSpawnPath(STATE),
      });
      expect(wrappedEnv).not.toHaveProperty('DATABASE_URL');
      expect(job.runnerOwnsLog).toBe(true);
      expect(wrappedEnv?.[SYSTEMD_RUNNER_OUTPUT_PATH_ENV]).toBe(job.logPath);
      expect(wrappedEnv?.[SYSTEMD_RUNNER_TASK_ID_ENV]).toBe('service-payload-task');
      expect(wrappedEnv?.[SYSTEMD_RUNNER_BASH_JOB_ID_ENV]).toBe(job.id);
      expect(wrappedEnv?.[SYSTEMD_RUNNER_SCOPE_UNIT_ENV]).toBe('service-payload-task.service');
      const runnerSecret = wrappedEnv?.[SYSTEMD_RUNNER_MARKER_SECRET_ENV] ?? '';
      expect(runnerSecret).toMatch(/^[a-f0-9]{64}$/);
      const nonceHash = createHash('sha256').update(runnerSecret).digest('hex');
      const taskDetail = complete.mock.calls[0]![1].detail;
      expect(taskDetail).toMatchObject({ bashJobId: job.id, runnerMarkerNonceHash: nonceHash });
      expect(JSON.stringify(taskDetail)).not.toContain(runnerSecret);
      expect(readJobLogTerminal(job.logPath)).toMatchObject({
        taskId: 'service-payload-task',
        bashJobId: job.id,
        scopeUnit: 'service-payload-task.service',
        invocationId: 'test-invocation',
        nonce: nonceHash,
      });
      // WI-10003538: the runner receives the exact values AND the same shape
      // patterns the live stream applies, so its durable log cannot diverge.
      expect(
        JSON.parse(Buffer.from(wrappedEnv?.[SYSTEMD_RUNNER_REDACTIONS_ENV] ?? '', 'base64').toString('utf8')),
      ).toEqual({
        values: ['durable-redaction-secret'],
        patterns: [{ ...SELF_IDENTIFYING_SECRET_PATTERN }],
      });

      const output = readJobOutput(job);
      expect(output).toContain('SID=service-payload-session');
      expect(output).toContain('WS=papercusp-workspace');
      expect(output).toContain(`PATH=${augmentedSpawnPath(STATE)}`);
      expect(output).toContain('EXPLICIT=per-call');
      expect(output).toContain('SECRET=unset');
    } finally {
      begin.mockRestore();
      complete.mockRestore();
      finish.mockRestore();
      if (previousSid === undefined) delete process.env.PAPERCUSP_SID;
      else process.env.PAPERCUSP_SID = previousSid;
      if (previousWorkspace === undefined) delete process.env.PAPERCUSP_WORKSPACE;
      else process.env.PAPERCUSP_WORKSPACE = previousWorkspace;
      if (previousSecret === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousSecret;
    }
  });

  it('strips forged durable-runner controls from an unconfined payload and keeps the operator-owned spill', async () => {
    let wrappedEnv: Readonly<Record<string, string | undefined>> | undefined;
    const wrap = vi.fn(
      (binary: string, argv: string[], env?: Readonly<Record<string, string | undefined>>) => {
        wrappedEnv = env;
        return { binary, argv };
      },
    );
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'unconfined-runner-controls-task',
      confined: false,
      unconfinedReason: 'caller-veto',
      unitKind: 'service',
      scopeUnit: null,
      enrolled: true,
      registrationReady: null,
      wrap,
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});

    try {
      const job = startBackground(
        {
          command:
            `printf 'payload-controls=%s/%s' ` +
            `"\${${SYSTEMD_RUNNER_OUTPUT_PATH_ENV}:-absent}" "\${${SYSTEMD_RUNNER_REDACTIONS_ENV}:-absent}"`,
          cwd: STATE,
          stateDir: STATE,
          env: {
            [SYSTEMD_RUNNER_OUTPUT_PATH_ENV]: '/tmp/caller-forged-runner-output',
            [SYSTEMD_RUNNER_REDACTIONS_ENV]: 'caller-forged-redactions',
            [SYSTEMD_RUNNER_TASK_ID_ENV]: 'caller-forged-task',
            [SYSTEMD_RUNNER_BASH_JOB_ID_ENV]: 'caller-forged-job',
            [SYSTEMD_RUNNER_SCOPE_UNIT_ENV]: 'caller-forged.service',
            [SYSTEMD_RUNNER_MARKER_SECRET_ENV]: 'caller-forged-secret',
          },
        },
        10_000,
      );
      // WI-6554700010008342: wait for the CLOSE handler (endedAt), not just for a non-running
      // status. Green-checkpoint runs at 13d1d785 and e526f5d4 read '' and
      // 'payload-controls=absent/' here after 76ms. The close handler sets the status and flushes
      // the redactor suffix synchronously, so a non-running status with output still missing means
      // the status was flipped by another path before close. Waiting for close keeps this test on
      // its own subject (stripped controls and the operator-owned spill); the status goes into the
      // message so an early flip stays diagnosable instead of reading as missing output.
      await waitForStatus(job.id);
      await vi.waitFor(() => expect(job.endedAt, `status=${job.status}`).toBeTruthy(), {
        timeout: 30_000,
        interval: 25,
      });

      expect(job.runnerOwnsLog).toBe(false);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_OUTPUT_PATH_ENV);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_REDACTIONS_ENV);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_TASK_ID_ENV);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_BASH_JOB_ID_ENV);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_SCOPE_UNIT_ENV);
      expect(wrappedEnv).not.toHaveProperty(SYSTEMD_RUNNER_MARKER_SECRET_ENV);
      expect(readJobOutput(job), `status=${job.status} exit=${job.exitCode}`).toContain(
        'payload-controls=absent/absent',
      );
      const spill = readFileSync(job.logPath, 'utf8');
      const payload = 'payload-controls=absent/absent';
      expect(spill).toContain(payload);
      expect(spill.indexOf('JOB TIMING:')).toBeGreaterThanOrEqual(spill.indexOf(payload) + payload.length);
    } finally {
      begin.mockRestore();
      complete.mockRestore();
      finish.mockRestore();
    }
  });

  it('enrolls an API-launched child beneath its explicit durable parent', async () => {
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({ command: 'true', cwd: STATE, stateDir: STATE,
        parentTaskId: 'parent123' }, 10_000);
      await waitForStatus(job.id);
      expect(complete).toHaveBeenCalledWith(expect.anything(),
        expect.objectContaining({ parentTaskId: 'parent123' }), expect.anything());
    } finally { complete.mockRestore(); finish.mockRestore(); }
  });

  it('stamps background children with durable task provenance and rejects caller overrides', async () => {
    const enrolledAtSpawn = taskManagerEnabledSync();
    const job = startBackground(
      {
        command:
          `printf 'task=%s durable=%s' ` +
          `"$${CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV}" "$${PC_HEAVY_DURABLE_CALLER_ENV}"`,
        cwd: STATE,
        stateDir: STATE,
        env: {
          [CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV]: 'caller-forged-task-id',
          [PC_HEAVY_DURABLE_CALLER_ENV]: '0',
        },
      },
      10_000,
    );
    await waitForStatus(job.id);
    const output = readJobOutput(getJob(job.id)!);
    if (enrolledAtSpawn) expect(output).toContain(`task=${job.taskId} durable=1`);
    else expect(output).toContain('task= durable=');
    expect(output).not.toContain('caller-forged-task-id');
    expect(output).not.toContain('durable=0');
  });

  it('runs, exposes incremental output, and reaches a terminal status', async () => {
    const job = startBackground({ command: 'echo first; sleep 0.2; echo second', cwd: STATE, stateDir: STATE }, 10_000);
    expect(job.status).toBe('running');
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    const out = readJobOutput(final);
    expect(out).toContain('first');
    expect(out).toContain('second');
    // Cursor advanced — a second read returns nothing new.
    expect(readJobOutput(final)).toBe('');
  });

  it('preserves a UTF-8 code point split across background stdout chunks in retained output and spill (WI-910499)', async () => {
    const job = startBackground(
      {
        command: "printf '\\360'; sleep 0.2; printf '\\237\\230\\200'",
        cwd: STATE,
        stateDir: STATE,
      },
      10_000,
    );
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    const output = readJobOutput(final);
    const spill = readFileSync(final.logPath, 'utf8');

    expect(final.status).toBe('completed');
    expect(output).toContain('😀');
    expect(spill).toContain('😀');
    expect(output).not.toContain('\uFFFD');
    expect(spill).not.toContain('\uFFFD');
  });

  it('keeps a successful background job green when its child output contains missing-command fixtures', async () => {
    const job = startBackground(
      {
        command: `printf '%s\\n' '/bin/sh: 1: fakeomp: not found'; exit 0`,
        cwd: STATE,
        stateDir: STATE,
      },
      10_000,
    );
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(readFileSync(final.logPath, 'utf8')).toContain('status=completed');
  });

  it('still fails a background job whose wrapper shell really loses a command inside a successful pipeline', async () => {
    const job = startBackground(
      {
        command: `printf '%s\\n' "$(papercusp-background-command-that-is-not-installed)" | head -1`,
        cwd: STATE,
        stateDir: STATE,
      },
      10_000,
    );
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(127);
    // The service writes its raw completed/0 marker before the host normalizes
    // this missing command to failed/127. The host appends through an async
    // WriteStream, so terminal in-memory status alone is not a flush barrier.
    await vi.waitFor(() => {
      expect(readFileSync(final.logPath, 'utf8')).toContain('status=failed');
    }, { timeout: 10_000, interval: 25 });
  });

  it('persists the normalized missing-command exit code for processes:list', async () => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'missing-command-ledger-task',
      confined: false,
      unconfinedReason: 'caller-veto',
      unitKind: 'service',
      scopeUnit: null,
      enrolled: true,
      registrationReady: null,
      wrap: (binary, argv) => ({ binary, argv }),
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation((enrolment) => {
      enrolment.registrationReady = Promise.resolve();
    });
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});

    try {
      const job = startBackground(
        {
          command: `printf '%s\\n' "$(papercusp-ledger-command-that-is-not-installed)" | head -1`,
          cwd: STATE,
          stateDir: STATE,
        },
        10_000,
      );
      await waitForStatus(job.id);

      const final = getJob(job.id)!;
      expect(final.status).toBe('failed');
      expect(final.exitCode).toBe(127);
      expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'missing-command-ledger-task' }),
        expect.objectContaining({ state: 'exited', exitCode: 127 }),
        expect.any(Object),
      );
    } finally {
      begin.mockRestore();
      complete.mockRestore();
      finish.mockRestore();
    }
  });

  it('kills a running job', async () => {
    const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
    expect(job.status).toBe('running');
    const r = killJob(job);
    expect(r.alreadyDone).toBe(false);
    expect(job.status).toBe('killed');
  });

  // EI-21905196224862433: reproduced live — a background job killed via
  // `processes:kill` (task-manager's killTask, NOT this module's own killJob)
  // used to report status=completed exit_code=0 with truncated output, because
  // a confined job's watched child is the `systemd-run --pipe --wait` client,
  // which exits 0 once the unit is gone regardless of whether it was killed.
  // killTask() now calls notifyTaskKillRequested() the instant it signals a
  // taskId; these tests exercise that wiring directly (unconfined here, since
  // confinement itself is not under test — only that the notice reaches and
  // sticks on the matching job).
  describe('external kill-intent notice (EI-21905196224862433)', () => {
    it('flips a running job to killed the instant an external kill-intent notice arrives for its taskId', async () => {
      const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
      expect(job.status).toBe('running');
      expect(job.taskId).toBeTruthy();

      notifyTaskKillRequested(job.taskId!, 'SIGTERM');
      expect(job.status).toBe('killed');

      // Clean up the real child so it doesn't run for the full 30s past this test.
      job.child.kill('SIGTERM');
      await waitForStatus(job.id);
    });

    it('preserves the killed status once the real close handler runs, instead of trusting the child exit code (EI-21905196224862433)', async () => {
      const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
      notifyTaskKillRequested(job.taskId!, 'SIGTERM');
      expect(job.status).toBe('killed');

      job.child.kill('SIGTERM');
      await waitForStatus(job.id);

      // The close handler's `if (job.status === 'running')` guard must have
      // left 'killed' alone — never overwritten to 'completed'/'failed' by the
      // untrustworthy `code === 0` check this bug is about.
      expect(getJob(job.id)!.status).toBe('killed');
    });

    it('ignores a kill-intent notice for a taskId that matches no live job', () => {
      const job = startBackground({ command: 'sleep 30', cwd: STATE, stateDir: STATE }, 60_000);
      notifyTaskKillRequested('not-a-real-taskid', 'SIGTERM');
      expect(job.status).toBe('running');
      killJob(job);
    });

    it('does not flip a job that already reached a terminal state', async () => {
      const job = startBackground({ command: 'true', cwd: STATE, stateDir: STATE }, 10_000);
      await waitForStatus(job.id);
      expect(job.status).toBe('completed');

      notifyTaskKillRequested(job.taskId!, 'SIGTERM');
      expect(job.status).toBe('completed');
    });
  });

  it('reports unknown ids as undefined', () => {
    expect(getJob('does-not-exist')).toBeUndefined();
  });
});

// EI-18764990059061608: a background job's log FILE must be self-describing about
// completion, because a caller can (and, per the filed bug, did) `cat`/Read it
// directly instead of calling capability:bash_output — where an empty file mid-run
// is byte-identical to a completed job that genuinely produced nothing.
describe('terminal log marker (EI-18764990059061608)', () => {
  it('formatJobLogEndMarker names status, exit code, and timestamp, and starts with the shared prefix', () => {
    const line = formatJobLogEndMarker('completed', 0, Date.UTC(2026, 0, 1));
    expect(line).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(line).toContain('status=completed');
    expect(line).toContain('exit=0');
    expect(line).toContain('2026-01-01');
  });

  it('formats a null exit code (spawn error / not yet observed) as the literal "null"', () => {
    expect(formatJobLogEndMarker('failed', null, Date.now())).toContain('exit=null');
  });

  it('a background job that produces NO output still leaves the marker in its log file', async () => {
    const job = startBackground({ command: 'true', cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('completed');
    const logContent = readFileSync(final.logPath, 'utf8');
    // Without the marker this file would be EMPTY — indistinguishable from a job
    // that has not finished writing anything yet. This is the exact ambiguity the
    // filed bug hit.
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=completed');
    expect(logContent).toContain('exit=0');
  });

  it('runs a large background script through the transient service stdin path (EI-25538971645697745)', async () => {
    const command = `# ${'x'.repeat(140 * 1024)}\nprintf large-background-command-ok`;
    expect(Buffer.byteLength(command)).toBeGreaterThan(128 * 1024);

    const job = startBackground({ command, cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const finished = getJob(job.id)!;

    expect(finished.status).toBe('completed');
    expect(finished.exitCode).toBe(0);
    expect(readJobOutput(finished)).toBe('large-background-command-ok');
  });

  it('a RUNNING background job has NOT written the marker yet', async () => {
    const job = startBackground({ command: 'sleep 5', cwd: STATE, stateDir: STATE }, 10_000);
    expect(job.status).toBe('running');
    // createWriteStream opens the fd asynchronously — the file may not exist on
    // disk yet at this exact instant. Absence-of-file is itself "no marker yet",
    // same as an existing-but-empty (or not-yet-marker-bearing) file.
    const logContent = existsSync(job.logPath) ? readFileSync(job.logPath, 'utf8') : '';
    expect(logContent).not.toContain(JOB_LOG_END_MARKER_PREFIX);
    killJob(job);
  });

  it('a failed background job (spawn error) still gets the marker via the error path', async () => {
    const job = startBackground({ command: 'exit 7', cwd: STATE, stateDir: STATE }, 10_000);
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    expect(final.status).toBe('failed');
    const logContent = readFileSync(final.logPath, 'utf8');
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=failed');
    expect(logContent).toContain('exit=7');
  });

  it('a foreground run writes the marker to the log FILE but NOT into the returned `output`', async () => {
    const r = await runForeground({ command: 'true', cwd: STATE, stateDir: STATE }, never, 10_000);
    expect(r.status).toBe('completed');
    // Exact-equality callers elsewhere (e.g. the EI-1617 secrets test) depend on
    // `output` carrying ONLY the command's own stdout/stderr — the marker must
    // never leak into it.
    expect(r.output).not.toContain(JOB_LOG_END_MARKER_PREFIX);
    const logContent = readFileSync(r.logPath, 'utf8');
    expect(logContent).toContain(JOB_LOG_END_MARKER_PREFIX);
    expect(logContent).toContain('status=completed');
  });
});

describe('preflight attribution snapshot (EI-21257218038249358)', () => {
  it('detects only the generic uppercase preflight-failure marker', () => {
    expect(detectPreflightFailureMarker('WI40905_PREFLIGHT_FAIL load1=93.20')).toBe('WI40905_PREFLIGHT_FAIL');
    expect(detectPreflightFailureMarker('preflight failed: load1=93.20')).toBeNull();
  });

  it('formats bounded current proc/cgroup evidence and redacts command arguments', () => {
    const cgroupPath = '/user.slice/papercusp.slice/pc-test.scope';
    const cgroupDir = `/sys/fs/cgroup${cgroupPath}`;
    const files: Record<string, string> = {
      '/proc/loadavg': '93.20 81.00 70.00 12/3000 42\n',
      '/proc/pressure/cpu': 'some avg10=12.34 avg60=9.87 avg300=4.56 total=123\n',
      [`${cgroupDir}/cgroup.procs`]: '42\n43\n',
      [`${cgroupDir}/memory.current`]: '4096\n',
      [`${cgroupDir}/memory.peak`]: '8192\n',
      [`${cgroupDir}/cpu.stat`]: 'usage_usec 123456\n',
      [`${cgroupDir}/pids.current`]: '2\n',
      '/proc/42/cmdline': '/usr/bin/node\0--token=do-not-persist\0',
      '/proc/42/stat': '42 (node) S 1 0 0 0 0 0 0 0 0 0 20 5\n',
      '/proc/42/cgroup': `0::${cgroupPath}\n`,
      '/proc/43/cmdline': '/bin/bash\0-w\0',
      '/proc/43/stat': '43 (bash) S 1 0 0 0 0 0 0 0 0 0 3 1\n',
      '/proc/43/cgroup': `0::${cgroupPath}\n`,
    };
    const snapshot = capturePreflightAttributionSnapshot({
      marker: 'WI40905_PREFLIGHT_FAIL',
      pid: 42,
      jobCgroupPath: cgroupPath,
      now: () => Date.UTC(2026, 7, 23, 19, 6, 40),
      readText: (path) => files[path] ?? null,
      readDir: (path) => (path === '/proc' ? ['42', '43', '44'] : []),
      redactValues: ['do-not-persist'],
    });
    const rendered = formatPreflightAttributionSnapshot(snapshot);

    expect(rendered).toContain(PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX);
    expect(rendered).toContain('basis=current-best-effort');
    expect(rendered).toContain('NOT historical attribution');
    expect(rendered).toContain('loadavg=93.20 81.00 70.00 12/3000 42');
    expect(rendered).toContain('memory.current=4096');
    expect(rendered).toContain('cpu.usage_usec=123456');
    expect(rendered).toContain('pid=42');
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('do-not-persist');
  });

  it('writes the snapshot before JOB END without changing returned command output', async () => {
    const job = startBackground(
      {
        command: "printf '%s\\n' 'WI40905_PREFLIGHT_FAIL load1=93.20 exceeds 77'",
        cwd: STATE,
        stateDir: STATE,
      },
      10_000,
    );
    await waitForStatus(job.id);
    const final = getJob(job.id)!;
    const output = readJobOutput(final);
    // job.status flips terminal synchronously in the close handler, but the
    // snapshot and the operator's normalized JOB END reach the file through an
    // async WriteStream. Under gate load a read taken right after the status flip
    // saw the runner's raw JOB END (offset 47) and the snapshot (offset 282) but
    // not the operator's later marker (gate run 762a13a6, 382606c4). Wait, with a
    // deadline, for the flush; a real ordering bug (JOB END written before the
    // snapshot) never satisfies the wait and still fails the assertions below.
    const readLog = (): string => (existsSync(final.logPath) ? readFileSync(final.logPath, 'utf8') : '');
    const flushDeadline = Date.now() + 10_000;
    let logContent = readLog();
    while (
      Date.now() < flushDeadline &&
      !(
        logContent.indexOf(PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX) >= 0 &&
        logContent.lastIndexOf(JOB_LOG_END_MARKER_PREFIX) > logContent.indexOf(PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX)
      )
    ) {
      await new Promise((r) => setTimeout(r, 25));
      logContent = readLog();
    }
    const snapshotAt = logContent.indexOf(PREFLIGHT_ATTRIBUTION_SNAPSHOT_PREFIX);
    // The transient-service runner may already have written a raw marker. The
    // operator's later normalized marker is authoritative and must follow its
    // attribution snapshot.
    const endAt = logContent.lastIndexOf(JOB_LOG_END_MARKER_PREFIX);

    expect(output).toContain('WI40905_PREFLIGHT_FAIL load1=93.20 exceeds 77');
    expect(snapshotAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(snapshotAt);
    expect(logContent.slice(snapshotAt, endAt)).toContain('current-best-effort');
  });
});

describe('detectBufferingLastStage (EI-19915289191989412)', () => {
  it('detects tail as the last pipeline stage', () => {
    expect(detectBufferingLastStage('npx vitest run 2>&1 | tail -45')).toBe('tail');
  });

  it('detects head, sort, uniq, wc as the last stage', () => {
    expect(detectBufferingLastStage('cmd | head -20')).toBe('head');
    expect(detectBufferingLastStage('cmd | sort')).toBe('sort');
    expect(detectBufferingLastStage('cmd | uniq -c')).toBe('uniq');
    expect(detectBufferingLastStage('cmd | wc -l')).toBe('wc');
  });

  it('returns null for a command with no pipe at all', () => {
    expect(detectBufferingLastStage('npm run build')).toBeNull();
  });

  it('returns null when the last stage is a streaming filter, not a buffering one', () => {
    // grep/cat/sed stream line-by-line; only the LAST stage matters for whether
    // the pipeline as a whole withholds output until exit.
    expect(detectBufferingLastStage('cmd | tail -45 | grep ERROR')).toBeNull();
    expect(detectBufferingLastStage('cmd 2>&1 | grep -i fail')).toBeNull();
  });

  it('looks only at the LAST stage — an early tail followed by a streaming stage is not flagged', () => {
    expect(detectBufferingLastStage('cmd | tail -f | cat')).toBeNull();
  });

  it('resolves a full path to its basename', () => {
    expect(detectBufferingLastStage('cmd | /usr/bin/tail -n 20')).toBe('tail');
  });

  it('skips a leading inline env assignment on the last stage', () => {
    expect(detectBufferingLastStage('cmd | LC_ALL=C sort')).toBe('sort');
  });

  it('does not split on `||` (logical OR), only real pipes', () => {
    expect(detectBufferingLastStage('cmd1 || cmd2')).toBeNull();
  });

  it('ignores a `|` inside a quoted argument', () => {
    expect(detectBufferingLastStage("echo 'a|b' | grep a")).toBeNull();
  });
});

describe('formatBufferingPipelineAdvice (EI-20039247609786797)', () => {
  it('launch advice names file redirection when tracking could be lost', () => {
    const advice = formatBufferingPipelineAdvice('tail', 'launch');
    expect(advice).toContain('If tracking is lost');
    expect(advice).toContain('JOB END marker may never be written');
    expect(advice).toContain('redirect output to a file you own');
    expect(advice).toContain('cmd > /tmp/job.log 2>&1');
  });

  it('tracking-loss advice does not tell callers to keep polling buffered output', () => {
    const advice = formatBufferingPipelineAdvice('tail', 'tracking-lost');
    expect(advice).toContain('do not keep polling for growing output');
    expect(advice).toContain('Read `log_path` directly');
    expect(advice).toContain('redirect output to a file you own');
    expect(advice).not.toContain('Keep polling capability:bash_output');
  });
});

describe('detectUntrackedShellBackgrounding (EI-21810817545133564)', () => {
  it('detects a detached child that the shell does not wait for', () => {
    const diagnostic = detectUntrackedShellBackgrounding(
      'nohup /tmp/p007-scope-watch.sh >/tmp/out 2>&1 & echo launched; sleep 1; cat /tmp/out',
    );
    expect(diagnostic).toMatchObject({ operator: '&', backgroundCount: 1 });
    expect(diagnostic?.excerpt).toContain('nohup');
    expect(formatUntrackedShellBackgroundAdvice(diagnostic!)).toContain('reaped when the shell finishes');
  });

  it('detects a background child followed by echoing its pid, not waiting for it', () => {
    expect(detectUntrackedShellBackgrounding('watcher & echo "$!"')).toMatchObject({
      operator: '&',
      backgroundCount: 1,
    });
  });

  it('does not confuse &&, redirects, quoted prose, pipe stderr, or heredoc data with backgrounding', () => {
    expect(detectUntrackedShellBackgrounding('echo "a & b" && echo "&> file"')).toBeNull();
    expect(detectUntrackedShellBackgrounding('echo hi 2>&1 |& cat')).toBeNull();
    expect(
      detectUntrackedShellBackgrounding("cat <<'SCRIPT'\necho 'child &'\nSCRIPT\nprintf '%s' ok"),
    ).toBeNull();
    expect(detectUntrackedShellBackgrounding('echo hi >&2')).toBeNull();
    expect(detectUntrackedShellBackgrounding('echo hi &> /tmp/out')).toBeNull();
  });

  it('does not confuse bitwise ampersands in Bash arithmetic with backgrounding', () => {
    expect(detectUntrackedShellBackgrounding('(( (8#$mode & 8#040) == 8#040 ))')).toBeNull();
    expect(detectUntrackedShellBackgrounding('if (( (8#$mode & 8#040) == 8#040 )); then echo ok; fi')).toBeNull();
    expect(detectUntrackedShellBackgrounding('printf "%d" $((8 & 4))')).toBeNull();
    const artifactCertification = [
      'mapfile -t roots < <(find /tmp -maxdepth 1 -type d)',
      'for root in "${roots[@]}"; do',
      '  mode=$(stat -c "%a" "$root")',
      '  if (( (8#$mode & 8#040) == 8#040 )); then printf "%s\\n" "$root"; fi',
      'done',
    ].join('\n');
    expect(detectUntrackedShellBackgrounding(artifactCertification)).toBeNull();
    expect(detectUntrackedShellBackgrounding('((8 & 4)) & echo detached')).toMatchObject({
      operator: '&',
      backgroundCount: 1,
    });
  });

  it('permits a single child joined by wait, including wait "$!"', () => {
    expect(detectUntrackedShellBackgrounding('watcher & wait')).toBeNull();
    expect(detectUntrackedShellBackgrounding('watcher & wait "$!"')).toBeNull();
  });

  it('permits a watcher joined by a named EXIT-trap cleanup function declared before it', () => {
    const command = [
      'cleanup() {',
      '  kill "$watcher_pid" 2>/dev/null || true',
      '  wait "$watcher_pid" 2>/dev/null || true',
      '}',
      'trap cleanup EXIT',
      'watcher &',
      'watcher_pid=$!',
    ].join('\n');
    expect(detectUntrackedShellBackgrounding(command)).toBeNull();
  });

  it('permits a watcher joined by a quoted EXIT trap, but not a non-EXIT trap or prose', () => {
    expect(
      detectUntrackedShellBackgrounding(
        'trap \'kill "$watcher_pid" 2>/dev/null; wait "$watcher_pid" 2>/dev/null\' EXIT; watcher & watcher_pid=$!',
      ),
    ).toBeNull();
    expect(
      detectUntrackedShellBackgrounding(
        'trap \'kill "$watcher_pid" 2>/dev/null; wait "$watcher_pid" 2>/dev/null\' TERM; watcher & watcher_pid=$!',
      ),
    ).toMatchObject({ operator: '&', backgroundCount: 1 });
    expect(detectUntrackedShellBackgrounding('echo "trap wait EXIT"; watcher &')).toMatchObject({
      operator: '&',
      backgroundCount: 1,
    });
    expect(detectUntrackedShellBackgrounding('echo "x; trap \'wait\' EXIT"; watcher &')).toMatchObject({
      operator: '&',
      backgroundCount: 1,
    });
  });

  it('still requires a bare wait in EXIT cleanup when multiple children are backgrounded', () => {
    expect(
      detectUntrackedShellBackgrounding(
        'trap \'wait "$last_pid"\' EXIT; one & first_pid=$!; two & last_pid=$!',
      ),
    ).toMatchObject({ operator: '&', backgroundCount: 2 });
    expect(detectUntrackedShellBackgrounding("trap 'wait' EXIT; one &; two &")).toBeNull();
  });

  it('requires a bare wait after multiple background children', () => {
    expect(detectUntrackedShellBackgrounding('one & two & wait "$!"')).toMatchObject({
      operator: '&',
      backgroundCount: 2,
    });
    expect(detectUntrackedShellBackgrounding('one & two & wait')).toBeNull();
  });

  it('detects coproc unless the command joins it', () => {
    expect(detectUntrackedShellBackgrounding('coproc watcher')).toMatchObject({ operator: 'coproc' });
    expect(detectUntrackedShellBackgrounding('coproc watcher; wait')).toBeNull();
  });
});

describe('TMPDIR is normalized to a sandbox-writable dir (EI-5912)', () => {
  it('overrides an inherited ephemeral TMPDIR so the child gets an existing temp dir', async () => {
    const prev = process.env.TMPDIR;
    // The ephemeral pattern the Claude harness sets — absent inside the fresh sandbox /tmp.
    process.env.TMPDIR = '/tmp/claude/nonexistent-run-xyz';
    try {
      const r = await runForeground(
        { command: 'printf "T=%s|X=%s|E=%s" "$TMPDIR" "$TMP" "$TEMP"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.output).toContain(`T=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`X=${CAPABILITY_SANDBOX_TMPDIR}`);
      expect(r.output).toContain(`E=${CAPABILITY_SANDBOX_TMPDIR}`);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });

  it('a caller-supplied env.TMPDIR still wins (explicit override)', async () => {
    const r = await runForeground(
      { command: 'printf "%s" "$TMPDIR"', cwd: STATE, stateDir: STATE, env: { TMPDIR: STATE } },
      never,
      10_000,
    );
    expect(r.output).toContain(STATE);
  });
});

describe('operator secrets are NOT inherited by a spawned command (EI-1617)', () => {
  it('a fake operator secret in process.env never reaches the child shell', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://user:pw@host/db-should-not-leak';
    try {
      const r = await runForeground(
        { command: 'printf "[%s]"  "${DATABASE_URL:-unset}"', cwd: STATE, stateDir: STATE },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toBe('[unset]');
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('a plain allowlisted var (PATH) still reaches the child', async () => {
    const r = await runForeground(
      { command: 'test -n "$PATH" && echo has-path', cwd: STATE, stateDir: STATE },
      never,
      10_000,
    );
    expect(r.status).toBe('completed');
    expect(r.output).toContain('has-path');
  });
});

describe('PAPERCUSP_OPERATOR_URL inheritance', () => {
  it('rewrites an inherited direct operator URL through the resilient proxy when configured', async () => {
    const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    const prevProxyTargetPort = process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT;
    const prevHonoPort = process.env.PAPERCUSP_HONO_PORT;
    const prevOperatorDevPort = process.env.OPERATOR_DEV_PORT;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = '3070';
    process.env.PAPERCUSP_HONO_PORT = '3070';
    delete process.env.OPERATOR_DEV_PORT;
    try {
      const r = await runForeground(
        {
          command: 'printf "%s|%s" "$PAPERCUSP_OPERATOR_URL" "$PAPERCUSP_MCP_PROXY_BASE"',
          cwd: STATE,
          stateDir: STATE,
        },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toContain('http://127.0.0.1:9071/api/mcp|http://127.0.0.1:9071');
    } finally {
      if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
      else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
      if (prevProxyTargetPort === undefined) delete process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT;
      else process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = prevProxyTargetPort;
      if (prevHonoPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
      else process.env.PAPERCUSP_HONO_PORT = prevHonoPort;
      if (prevOperatorDevPort === undefined) delete process.env.OPERATOR_DEV_PORT;
      else process.env.OPERATOR_DEV_PORT = prevOperatorDevPort;
    }
  });

  it('routes a shell from staging back to staging despite the inherited green .env pin', async () => {
    const prior = {
      PAPERCUSP_OPERATOR_URL: process.env.PAPERCUSP_OPERATOR_URL,
      PAPERCUSP_HONO_PORT: process.env.PAPERCUSP_HONO_PORT,
      PAPERCUSP_MCP_PROXY_BASE: process.env.PAPERCUSP_MCP_PROXY_BASE,
      PAPERCUSP_MCP_STAGING_PROXY_PORT: process.env.PAPERCUSP_MCP_STAGING_PROXY_PORT,
      PAPERCUSP_MCP_PROXY_TARGET_PORT: process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT,
      OPERATOR_DEV_PORT: process.env.OPERATOR_DEV_PORT,
    };
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_HONO_PORT = '3170';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT = '3070';
    process.env.PAPERCUSP_MCP_STAGING_PROXY_PORT = '9171';
    delete process.env.OPERATOR_DEV_PORT;
    try {
      const r = await runForeground(
        {
          command: 'printf "%s" "$PAPERCUSP_OPERATOR_URL"',
          cwd: STATE,
          stateDir: STATE,
        },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toBe('http://127.0.0.1:9171/api/mcp');
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('leaves explicit per-call env overrides intact', async () => {
    const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
    const prevProxy = process.env.PAPERCUSP_MCP_PROXY_BASE;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://localhost:3070/api/mcp';
    process.env.PAPERCUSP_MCP_PROXY_BASE = 'http://127.0.0.1:9071';
    try {
      const r = await runForeground(
        {
          command: 'printf "%s" "$PAPERCUSP_OPERATOR_URL"',
          cwd: STATE,
          stateDir: STATE,
          env: { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9999/api/mcp' },
        },
        never,
        10_000,
      );
      expect(r.status).toBe('completed');
      expect(r.output).toContain('http://127.0.0.1:9999/api/mcp');
    } finally {
      if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
      else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
      if (prevProxy === undefined) delete process.env.PAPERCUSP_MCP_PROXY_BASE;
      else process.env.PAPERCUSP_MCP_PROXY_BASE = prevProxy;
    }
  });
});

describe('process-group kill — no orphaned descendants (capability-bash-orphan-kill-2026-06-21)', () => {
  // A timed-out / aborted / killed command MUST take its descendants with it.
  // Before the detached-process-group fix, the kill hit only the `bash -c` parent;
  // its children (e.g. a runaway ugrep) orphaned to init and kept running at full
  // CPU — the 58-min search that starved the operator event loop → :3070 wedge.
  // Proof: a GRANDCHILD that would `touch` a marker AFTER the kill deadline must
  // never get the chance to create it.
  let markerSeq = 0;
  // `( sleep 3; touch <marker> ) &` is a subshell grandchild of the operator; the
  // outer `wait` keeps bash alive until the kill. With the group fix the grandchild
  // dies with the group; without it, it orphans, sleeps, and creates the marker.
  const grandchildCmd = (marker: string): string => `( sleep 3; touch ${marker} ) & echo started; wait`;
  // EI-10982: this used to sample the marker exactly ONCE at a fixed 3500ms
  // offset — well past the grandchild's 3s delay under an idle box, but a real
  // race against host load: on a shared box running many concurrent vitest
  // workers, the kill's actual effect (signal delivery/scheduling, and for
  // killJob specifically the SIGTERM->SIGKILL grace-period escalation) can be
  // pushed out far enough that a genuinely-about-to-be-killed process still
  // wins the race against a single fixed-offset sample. Poll for the marker
  // instead of sampling once, over a bound generous enough to absorb that
  // load-induced skew (comfortably past the grandchild's 3s delay plus
  // killJob's 2s escalation grace period plus OS reap latency) — a real orphan
  // still fails fast (the loop breaks the moment the marker appears), and a
  // correctly-killed process is given real headroom to prove it stays dead
  // rather than being raced against the clock.
  async function expectNoOrphanMarker(run: (marker: string) => Promise<unknown>): Promise<void> {
    const marker = join(STATE, `orphan-${markerSeq++}.marker`);
    await run(marker);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(existsSync(marker)).toBe(false);
  }

  it('foreground timeout kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, never, 300);
      expect(r.status).toBe('timed_out');
    });
  }, 15_000);

  it('foreground abort kills the grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 200);
      const r = await runForeground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, ac.signal, 30_000);
      expect(r.status).toBe('killed');
    });
  }, 15_000);

  it('killJob kills the background grandchild (no orphan)', async () => {
    await expectNoOrphanMarker(async (marker) => {
      const job = startBackground({ command: grandchildCmd(marker), cwd: STATE, stateDir: STATE }, 60_000);
      expect(job.status).toBe('running');
      killJob(job);
    });
  }, 15_000);
});

/**
 * WI-6677 — a BACKGROUND job's deadline is its own, and reaching it is survivable
 * enough for the job's cleanup to run.
 *
 * The bug these guard: `run_in_background` inherited the FOREGROUND default (120s)
 * and ceiling (600s), so the tool SIGKILLed precisely the long jobs it exists to
 * host — the exact duration CLAUDE.md tells agents to background at. The SIGKILL
 * then skipped every `trap`/`finally`, leaking whatever the job was mid-way through
 * building (a 489MB checkout in one case, a 4.9GB deb extract in another).
 */
describe('background job deadlines (WI-6677)', () => {
  async function waitForEnd(id: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (getJob(id)?.endedAt != null) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * WI-1046842 — wait until a job's OWN output proves a precondition, instead of
   * assuming the job won a race against its own deadline. Returns a boolean rather
   * than throwing so the caller can fail with a NAMED cause; a bare
   * `expected false to be true` on the downstream assertion is exactly the
   * uninformative shape that made this class expensive to diagnose.
   */
  async function waitForOutput(id: string, needle: string, ms = 5_000): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const job = getJob(id);
      // Polling must not consume a prefix that can arrive in a separate pipe
      // chunk from the rest of the marker.
      if (job && readJobOutput(job, true).includes(needle)) return true;
      // Once the job is terminal its output can no longer grow, so keep polling
      // only while it might still produce the needle.
      if (job?.endedAt != null || Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function expireDeadlineAfterOutput(command: string, marker: string) {
    // These cases test deadline classification, whose precondition is an
    // observed landmark. Hold ONLY that deadline callback until real shell
    // output arrives; use an unconfined enrollment so systemd's rounded
    // RuntimeMaxSec cannot preempt this deliberately held 400ms local timer.
    // Real confined deadlines are covered by the SIGTERM cleanup test below.
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment').mockReturnValue({
      taskId: 'deadline-classification-test', enrolled: true, confined: false,
      unconfinedReason: 'no-scope-support', unitKind: 'scope', scopeUnit: null,
      registrationReady: null, wrap: (binary: string, argv: string[]) => ({ binary, argv }),
      releaseEnvironmentTransport: () => {},
    });
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    const finish = vi.spyOn(enrollSync, 'finishSyncEnrolment').mockImplementation(() => {});
    try {
      const realSetTimeout = globalThis.setTimeout;
      let expire: (() => void) | undefined;
      let heldTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        if (delay !== 400) return realSetTimeout(callback, delay, ...args);
        expire = () => callback(...args);
        heldTimer = realSetTimeout(() => {}, 30_000);
        return heldTimer;
      });
      let job: ReturnType<typeof startBackground>;
      try {
        job = startBackground({ command, cwd: STATE, stateDir: STATE }, 400);
      } finally {
        timeoutSpy.mockRestore();
      }
      try {
        const diagnostic = () => JSON.stringify({
          status: job.status,
          exitCode: job.exitCode,
          scopeUnit: job.scopeUnit,
          startedAt: job.startedAt,
          deadlineAt: job.deadlineAt,
          endedAt: job.endedAt,
          output: job.buffer,
          phaseTiming: job.phaseTiming,
        });
        expect(await waitForOutput(job.id, marker), `shell never emitted ${marker}: ${diagnostic()}`).toBe(true);
        expect(job.scopeUnit, diagnostic()).toBeNull();
        expect(job.status, diagnostic()).toBe('running');
        expect(expire, `startBackground did not arm its deadline: ${diagnostic()}`).toBeDefined();
        clearTimeout(heldTimer);
        expire!();
        await waitForEnd(job.id);
        return job;
      } finally {
        clearTimeout(heldTimer);
        if (job.status === 'running') {
          killJob(job);
          await waitForEnd(job.id, 5_000);
        }
      }
    } finally {
      begin.mockRestore();
      complete.mockRestore();
      finish.mockRestore();
    }
  }

  it('a background job is NOT bound by the foreground pair — its default outlives a foreground call and its ceiling can host a real suite', () => {
    // Stated as an invariant rather than a literal so re-tuning the durations stays
    // free, while re-pointing background back at the foreground constants (the
    // regression) fails here instead of silently in production hours later.
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(MAX_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(MAX_TIMEOUT_MS);
    expect(DEFAULT_BACKGROUND_TIMEOUT_MS).toBeLessThanOrEqual(MAX_BACKGROUND_TIMEOUT_MS);
    // The green-checkpoint suite in this repo runs ~55 min; a ceiling under that
    // cannot host the longest job anyone would legitimately background.
    expect(MAX_BACKGROUND_TIMEOUT_MS).toBeGreaterThan(60 * 60 * 1_000);
  });

  it('records the effective deadline on the job so the caller can be told it up front', () => {
    const job = startBackground({ command: 'sleep 60', cwd: STATE, stateDir: STATE }, 45_000);
    expect(job.timeoutMs).toBe(45_000);
    expect(job.deadlineAt).toBe(job.startedAt + 45_000);
    killJob(job);
  });

  it('classifies a systemd close after the deadline even when its timer callback has not run', () => {
    expect(classifyBackgroundCloseStatus('running', 2_000, 2_000)).toBe('timed_out');
    expect(classifyBackgroundCloseStatus('running', 2_000, 1_999)).toBe('running');
    expect(classifyBackgroundCloseStatus('timed_out', 2_000, 2_102)).toBe('timed_out');
    expect(classifyBackgroundCloseStatus('completed', 2_000, 2_102)).toBe('completed');
  });

  it('classifies deadline phase only from an explicit pc-heavy marker', () => {
    expect(classifyDeadlineReason(`${PC_HEAVY_QUEUE_WAIT_MARKER} a heavy slot`)).toBe('deadline_before_slot_acquired');
    expect(classifyDeadlineReason(PC_HEAVY_QUEUE_ABORT_MARKER)).toBe('deadline_before_slot_acquired');
    expect(classifyDeadlineReason(PC_HEAVY_SLOT_ACQUIRED_MARKER)).toBe('deadline_after_slot_acquired');
    expect(
      classifyDeadlineReason(`${PC_HEAVY_QUEUE_WAIT_MARKER}\n${PC_HEAVY_SLOT_ACQUIRED_MARKER}`),
    ).toBe('deadline_after_slot_acquired');
    // A command that never invokes pc-heavy has no phase evidence. Its missing
    // acquired marker must not be misreported as queueing.
    expect(classifyDeadlineReason('working\ndeadline reached')).toBeUndefined();
  });

  it('makes the caller-selected deadline a systemd-enforced cgroup deadline', () => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    try {
      const job = startBackground({ command: 'sleep 60', cwd: STATE, stateDir: STATE }, 45_000);
      expect(begin).toHaveBeenLastCalledWith({ class: 'bash-job', runtimeMaxSec: 45 });
      killJob(job);
    } finally {
      begin.mockRestore();
    }
  });

  it('budgets a test-run subtree and preserves its launcher/work-item provenance in the ledger spec', () => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground(
        {
          command: 'cd . && npx vitest run',
          cwd: STATE,
          stateDir: STATE,
          launchedBy: 'su-test-owner',
          sessionId: 'su-test-owner',
          harnessSlug: 'papercusp',
          workItemId: 'EI-21192501620501693',
          goalRef: 'EI-21192501620501693',
        },
        45_000,
      );

      expect(begin).toHaveBeenLastCalledWith({
        class: 'bash-job',
        runtimeMaxSec: 45,
        memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES,
        tasksMax: BASH_TEST_TASKS_MAX,
      });
      expect(complete.mock.lastCall?.[1]).toMatchObject({
        class: 'bash-job',
        launchedBy: 'su-test-owner',
        sessionId: 'su-test-owner',
        harnessSlug: 'papercusp',
        workItemId: 'EI-21192501620501693',
        runtimeMaxSec: 45,
        memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES,
        tasksMax: BASH_TEST_TASKS_MAX,
        detail: {
          goalRef: 'EI-21192501620501693',
          workloadClass: 'test-run',
          budgetPolicy: 'capability-bash-test-v1',
        },
      });
      killJob(job);
    } finally {
      begin.mockRestore();
      complete.mockRestore();
    }
  });

  it('RTK budget identity: budgets the original test while executing and recording the rewritten command', async () => {
    const originalCommand = 'npm run test:e2e:isolated -- e2e/content-reading.spec.ts';
    const command = 'printf rewritten-command-executed';
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({ command, originalCommand, cwd: STATE, stateDir: STATE }, 10_000);
      try {
        expect(begin).toHaveBeenLastCalledWith({
          class: 'bash-job', runtimeMaxSec: 10,
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES, tasksMax: BASH_TEST_TASKS_MAX,
        });
        expect(complete.mock.lastCall?.[1]).toMatchObject({
          argv: ['bash', '-o', 'pipefail', '-c', command],
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES, tasksMax: BASH_TEST_TASKS_MAX,
          detail: { workloadClass: 'test-run', budgetPolicy: 'capability-bash-test-v1' },
        });
        await waitForStatus(job.id);
        expect(job.status).toBe('completed');
        expect(job.exitCode).toBe(0);
        expect(readJobOutput(job)).toBe('rewritten-command-executed');
      } finally { killJob(job); }
    } finally {
      begin.mockRestore(); complete.mockRestore();
    }
  });

  it('RTK budget identity: a rewritten test-looking command cannot promote an original non-test command', () => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      // STATE has no package.json or verifier: no native/browser work can start.
      const job = startBackground({
        command: 'npm run test:e2e:isolated', originalCommand: 'printf diagnostic', cwd: STATE, stateDir: STATE,
      }, 5_000);
      try {
        expect(begin).toHaveBeenLastCalledWith({ class: 'bash-job', runtimeMaxSec: 5 });
        const spec = complete.mock.lastCall?.[1];
        expect(spec).not.toHaveProperty('memoryMaxBytes');
        expect(spec).not.toHaveProperty('tasksMax');
        expect(spec?.detail).toMatchObject({ workloadClass: 'other', budgetPolicy: 'deadline-only-v1' });
      } finally { killJob(job); }
    } finally {
      begin.mockRestore(); complete.mockRestore();
    }
  });

  it('keeps the finite test task budget above the latest measured legitimate subtree peak', () => {
    // A real background affected run reached the old 2,048 cgroup ceiling and
    // failed before any suite verdict existed. Pin the safety relationship
    // independently of beginSyncEnrolment's argument assertion: merely asserting
    // that the writer receives its exported constant would still pass if the
    // constant regressed to the ceiling a legitimate workload already exhausted.
    expect(BASH_TEST_TASKS_MAX).toBeGreaterThan(4_096);
    expect(BASH_TEST_TASKS_MAX).toBeLessThanOrEqual(8_192);
  });

  // EI-21468591394619357: the two halves of the pids arithmetic are owned by different
  // modules — capability:bash budgets the cgroup (BASH_TEST_TASKS_MAX), while
  // scripts/lib/budgeted-task-scheduler.mjs spends it (PIDS_RESERVE +
  // PIDS_PER_CONCURRENT_TASK) — and the incident was exactly their drift: a 512-task budget
  // under a 1024+4096 envelope makes resolveTaskBudget's refusal unconditional, so every
  // test:affected run through capability:bash aborted before launch with tasks=0. Import
  // both sides so the relationship is CHECKED, not remembered.
  it('admits at least one affected-tests scheduler envelope inside the test budget', () => {
    expect(BASH_TEST_TASKS_MAX).toBeGreaterThanOrEqual(PIDS_RESERVE + PIDS_PER_CONCURRENT_TASK);
    const budget = resolveTaskBudget({
      workerBudget: 8,
      memoryBudgetMb: 16_384,
      workerMemoryMb: 2_048,
      maxConcurrentTasks: 2,
      reserveWorkers: 1,
      taskCgroupPidsMax: BASH_TEST_TASKS_MAX,
    });
    expect(budget.pidsMaxConcurrentTasks).toBeGreaterThanOrEqual(1);
  });

  it('classifies only test runners at a shell-segment boundary for the hard test budget', () => {
    expect(isBackgroundTestCommand('npx vitest run')).toBe(true);
    expect(isBackgroundTestCommand('npm run test:affected -- --changed-paths a.ts,b.ts')).toBe(true);
    expect(isBackgroundTestCommand('npm run test:e2e:isolated -- e2e/content-reading.spec.ts')).toBe(true);
    expect(isBackgroundTestCommand('cd packages/operator-core && npm run test:file -- x.test.ts')).toBe(true);
    expect(isBackgroundTestCommand('FOO=1 pnpm exec playwright test')).toBe(true);
    expect(isBackgroundTestCommand('rg -n vitest packages/operator-core')).toBe(false);
    expect(isBackgroundTestCommand('printf "npx vitest run"')).toBe(false);
  });

  it('peels supported timeout wrappers before classifying the actual test or verifier command', () => {
    for (const command of [
      'timeout --signal=TERM --kill-after=60s 2700s scripts/verify-tauri-headless.sh -- true',
      'env PAPERCUSP_TEST_RUN_HARNESS=papercusp timeout --signal TERM --kill-after 60s 2700s bash -- ./scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
      'timeout -sTERM -k60s 2700s npx vitest run',
      'timeout 10s npm run test:file -- example.test.ts',
      'rtk test -- timeout 2700s scripts/verify-tauri-headless.sh',
    ]) expect(isBackgroundTestCommand(command), command).toBe(true);

    for (const command of [
      'rg -n "timeout 2700s scripts/verify-tauri-headless.sh" .',
      'timeout 2700s printf "scripts/verify-tauri-headless.sh"',
      'timeout 2700s node -e "scripts/verify-tauri-headless.sh"',
      'timeout --unknown 2700s scripts/verify-tauri-headless.sh',
      'timeout --kill-after=invalid 2700s scripts/verify-tauri-headless.sh',
    ]) expect(isBackgroundTestCommand(command), command).toBe(false);

    const longNearMiss = 'timeout --unknown=' + 'X'.repeat(10_000) + ' 2700s scripts/verify-tauri-headless.sh';
    expect(runInNewContext('classify(command)', {
      classify: isBackgroundTestCommand,
      command: longNearMiss,
    }, { timeout: 1_000 })).toBe(false);
  });

  it('applies the finite test budget to an explicitly RTK-wrapped test command', () => {
    const originalCommand = 'rtk test -- npm run test:e2e:isolated -- e2e/content-reading.spec.ts';
    expect(isBackgroundTestCommand(originalCommand)).toBe(true);
    expect(isBackgroundTestCommand('env REF=committed rtk test -- npm run test:e2e:isolated -- e2e/content-reading.spec.ts')).toBe(true);
    expect(isBackgroundTestCommand('rtk test -- printf "npm run test:e2e:isolated"')).toBe(false);
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({
        command: 'printf explicit-rtk-budget',
        originalCommand,
        cwd: STATE,
        stateDir: STATE,
      }, 10_000);
      try {
        expect(begin).toHaveBeenLastCalledWith({
          class: 'bash-job',
          runtimeMaxSec: 10,
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES,
          tasksMax: BASH_TEST_TASKS_MAX,
        });
        expect(complete.mock.lastCall?.[1]).toMatchObject({
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES,
          tasksMax: BASH_TEST_TASKS_MAX,
          detail: { workloadClass: 'test-run', budgetPolicy: 'capability-bash-test-v1' },
        });
      } finally {
        killJob(job);
      }
    } finally {
      begin.mockRestore();
      complete.mockRestore();
    }
  });

  it.each([
    ['env-wrapped isolated e2e', 'env REF=committed npm run test:e2e:isolated -- e2e/chat-streaming.spec.ts', true],
    ['npm --prefix isolated e2e', 'npm --prefix apps/operator run test:e2e:isolated -- apps/operator/e2e/reports-work-fullscreen.native.spec.mts', true],
    ['npm equals-prefix isolated e2e', 'npm --prefix=apps/operator run test:e2e:isolated -- apps/operator/e2e/reports-work-fullscreen.native.spec.mts', true],
    ['env-wrapped direct runner', 'env READY=1 npx vitest run', true],
    ['env with quoted assignments', 'env READY="two words" pnpm exec playwright test', true],
    ['assignments before env', 'OUTER=1 env -- INNER=1 npm run test:file -- example.test.ts', true],
    ['maintained env verifier', 'env READY=1 bash scripts/verify-tauri-headless.sh', true],
    ['diagnostic with runner argument', 'env READY=1 printf "npm run test:file"', false],
    ['runner text in assignment only', 'env MESSAGE="npx vitest run" printf ready', false],
    ['long env assignment near miss', 'env REF=' + 'a'.repeat(160) + ' printf ready', false],
    ['long env assignment before runner', 'env REF=' + 'a'.repeat(160) + ' npm run test:e2e:isolated', true],
  ])('budgets env command semantics for %s', (_label, command, expected) => {
    expect(runInNewContext('classify(command)', {
      classify: isBackgroundTestCommand,
      command,
    }, { timeout: 1_000 })).toBe(expected);
  });

  it.each([
    ['unquoted assignment near miss', `REF=${'a'.repeat(80)} printf ready`, false],
    ['unquoted assignment before a verifier', `REF=${'a'.repeat(80)} bash scripts/verify-tauri-headless.sh`, true],
    ['absolute path near miss', `bash /${'segment/'.repeat(32)}scripts/unrelated.sh`, false],
    ['absolute verifier path', `bash /${'segment/'.repeat(32)}scripts/verify-tauri-headless.sh`, true],
    ['absolute verifier with repeated separators', 'bash /workspace//scripts/verify-tauri-headless.sh', true],
  ])('bounds test classification for %s', (_label, command, expected) => {
    // A synchronous regex stall cannot be interrupted by Vitest's async timeout.
    // The VM deadline interrupts the actual imported classifier, keeping this
    // regression from wedging the test runner as it did the operator main thread.
    expect(runInNewContext('classify(command)', {
      classify: isBackgroundTestCommand,
      command,
    }, { timeout: 1_000 })).toBe(expected);
  });

  it('budgets the multiline isolated-e2e npm launch before its verifier starts', () => {
    // EI-26296794396363557: this npm script has TWO colon suffixes. The
    // previous one-suffix classifier left the actual launch unbounded even
    // though a direct npx playwright --list probe received the test budget.
    const command = [
      'set -uo pipefail',
      'RUN_ROOT="$(mktemp -d /tmp/isolated-e2e-budget.XXXXXX)"',
      'GROUP="content-reading-R32-R34-$(date -u +%Y%m%dT%H%M%SZ)-$$"',
      'export VERIFY_TAURI_SOURCE_REF="test-source"',
      'export VERIFY_TAURI_ISOLATED_DB=1',
      'export VERIFY_TAURI_ISOLATED_SEED=ready',
      'export PAPERCUSP_TEST_RUN_GROUP="$GROUP"',
      'export PAPERCUSP_TEST_RUN_RECEIPT_FILE="$RUN_ROOT/test-run-receipt.json"',
      'export OPERATOR_E2E_HARNESS_EVIDENCE_ROOT="$RUN_ROOT/bracket"',
      'cd apps/operator',
      "npm run test:e2e:isolated -- e2e/content-reading.spec.ts '--grep=summary-only and summary-and-read|cancel summary' --workers=1",
      'rc=$?',
      'exit "$rc"',
    ].join('\n');
    expect(isBackgroundTestCommand(command)).toBe(true);
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      const job = startBackground({ command, cwd: STATE, stateDir: STATE }, 45_000);
      expect(begin).toHaveBeenLastCalledWith({
        class: 'bash-job',
        runtimeMaxSec: 45,
        memoryMaxBytes: 16 * 1024 ** 3,
        tasksMax: BASH_TEST_TASKS_MAX,
      });
      killJob(job);
    } finally {
      begin.mockRestore();
      complete.mockRestore();
    }
  });

  it('classifies maintained verifier entrypoints without classifying diagnostic mentions', () => {
    for (const command of [
      'scripts/run-operator-e2e-isolated.sh e2e/ongoing-work-ui.spec.ts',
      "env PAPERCUSP_TEST_RUN_HARNESS=papercusp bash scripts/run-operator-e2e-isolated.sh e2e/ongoing-work-ui.spec.ts --grep 'ongoing work stays visible|mobile strip preserves' --workers=1",
      'VERIFY_TAURI_ISOLATED_DB=1 bash ./scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
      'cd apps/operator && bash ../../scripts/run-operator-e2e-isolated.sh e2e/content-reading.spec.ts',
      'env -- FOO=1 bash -- /workspace/papercusp/scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
      'VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS="completion kindEvidence" scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
      "env -- LABEL='with spaces' bash -- scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime",
      'LABEL=with\\ spaces scripts/run-operator-e2e-isolated.sh e2e/content-reading.spec.ts',
      'LABEL=prefix" with spaces"suffix scripts/run-operator-e2e-isolated.sh e2e/content-reading.spec.ts',
      'LABEL="" scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
    ]) expect(isBackgroundTestCommand(command), command).toBe(true);
    for (const command of [
      'rg scripts/run-operator-e2e-isolated.sh',
      'printf "bash scripts/verify-tauri-headless.sh"',
      'cat scripts/verify-tauri-headless.sh',
      'bash scripts/verify-tauri-headless.sh.backup',
      'bash scripts/unrelated.sh',
      'LABEL="with spaces" printf "bash scripts/verify-tauri-headless.sh"',
      'LABEL="with spaces" cat scripts/verify-tauri-headless.sh',
    ]) expect(isBackgroundTestCommand(command), command).toBe(false);
  });

  it.each([
    "env PAPERCUSP_TEST_RUN_HARNESS=papercusp bash scripts/run-operator-e2e-isolated.sh e2e/ongoing-work-ui.spec.ts --grep 'ongoing work stays visible|mobile strip preserves' --workers=1",
    'bash scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
    'timeout --signal=TERM --kill-after=60s 2700s scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
    'VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS="completion kindEvidence" scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime',
    "env -- LABEL='with spaces' bash -- scripts/verify-tauri-headless.sh --boot-only-i-accept-task-lifetime",
  ])('budgets a maintained verifier before preparation: %s', (command) => {
    const begin = vi.spyOn(enrollSync, 'beginSyncEnrolment');
    const complete = vi.spyOn(enrollSync, 'completeSyncEnrolment').mockImplementation(() => {});
    try {
      // STATE has no scripts directory: exercise real enrollment without booting a verifier.
      const job = startBackground({ command, cwd: STATE, stateDir: STATE }, 45_000);
      try {
        expect(begin).toHaveBeenLastCalledWith({
          class: 'bash-job', runtimeMaxSec: 45,
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES, tasksMax: BASH_TEST_TASKS_MAX,
        });
        expect(complete.mock.lastCall?.[1]).toMatchObject({
          memoryMaxBytes: BASH_TEST_MEMORY_MAX_BYTES, tasksMax: BASH_TEST_TASKS_MAX,
          detail: { workloadClass: 'test-run', budgetPolicy: 'capability-bash-test-v1' },
        });
      } finally { killJob(job); }
    } finally {
      begin.mockRestore(); complete.mockRestore();
    }
  });

  it('clamps to the BACKGROUND ceiling, not the foreground one', () => {
    const job = startBackground({ command: 'sleep 60', cwd: STATE, stateDir: STATE }, MAX_BACKGROUND_TIMEOUT_MS * 10);
    expect(job.timeoutMs).toBe(MAX_BACKGROUND_TIMEOUT_MS);
    killJob(job);
  });

  it("⭐ hitting the deadline SIGTERMs first, so the job's own cleanup trap still runs (it used to SIGKILL and leak)", async () => {
    const marker = join(STATE, `cleanup-ran-${Date.now()}`);
    // WI-1046842 — the deadline must not race the job's own STARTUP. The TERM trap
    // is installed by the command itself, so a SIGTERM that lands before bash has
    // run `trap` kills the job under the DEFAULT TERM action, no cleanup can
    // possibly run, and the failure presents as a bare `expected false to be true`
    // that reads like a cleanup REGRESSION rather than a fixture that never got to
    // arm itself. Measured 2026-08-30: at a 20ms deadline this fails 25/25 with the
    // job's own `echo working` never appearing, while the previous 400ms passed
    // 40/40 at rest yet flaked repeatedly inside the full suite (ledger: fails at
    // 04:12/03:47/03:10/01:51 interleaved with passes, on a byte-identical file).
    // The deadline here is a fixture constant with no product meaning — what is
    // asserted is still SIGTERM-before-SIGKILL — so the fix is to stop racing
    // startup and to make any residual loss self-diagnosing, NOT to weaken the
    // assertion or to widen a product timeout.
    const job = startBackground(
      {
        command: `trap 'echo cleaned > ${marker}; exit 143' TERM; echo working; sleep 30`,
        cwd: STATE,
        stateDir: STATE,
      },
      2_000,
    );
    // `trap` precedes `echo working`, so observing that echo PROVES the trap is
    // installed and the job has reached `sleep` — the only state in which this
    // test's question (SIGTERM vs SIGKILL) is even meaningful.
    const trapInstalled = await waitForOutput(job.id, 'working', 1_500);
    expect(
      trapInstalled,
      'the job never reached its own `echo working`, so its TERM trap was never installed: this run cannot distinguish SIGTERM from SIGKILL (startup race — WI-1046842) and is NOT evidence of a cleanup regression',
    ).toBe(true);
    await waitForEnd(job.id);
    expect(
      job.status,
      JSON.stringify({
        exitCode: job.exitCode,
        scopeUnit: job.scopeUnit,
        startedAt: job.startedAt,
        deadlineAt: job.deadlineAt,
        endedAt: job.endedAt,
        phaseTiming: job.phaseTiming,
      }),
    ).toBe('timed_out');
    // The whole point: a SIGKILLed job cannot leave this behind.
    //
    // WI-1046842 / WI-1064487 — carry the job's EXIT CODE into the failure message. But
    // READ THE REGIME FIRST, because the exit code only became informative recently.
    //
    // The legend that stood here until WI-1064487 was WRONG, and wrong in the direction
    // that costs the most: it told you `0` proved the trap never fired. Measured against
    // PASSING runs — marker present on disk, so the trap demonstrably DID run — the
    // observed exit codes were 143, 1 AND 0. All three. So `0` never discriminated
    // anything, and anyone who trusted the legend was reading noise as a diagnosis.
    //
    // WHY it was noise (the defect, not a quirk): systemd-scope-env-runner.mjs is the
    // unit's MAIN process and it collapsed every signal death to `finish(1)`, while dying
    // instantly on SIGTERM — which closed the payload's stdout/stderr pipes mid-cleanup.
    // So the code you saw depended on where the payload happened to be when its pipes
    // broke, not on whether it cleaned up.
    //
    // REGIME A — runner patched (exitCodeFor + forwardTerminationSignalsTo present in
    // systemd-scope-env-runner.mjs, WI-1064487). Signal deaths now report 128+signal, so:
    //   143 → SIGTERM: the trap had its chance; no marker here IS a genuine cleanup fault
    //   137 → SIGKILL: the 10s escalation beat the trap
    //     0 → the payload exited cleanly of its own accord
    //  null → no exit observed at all
    // REGIME B — runner UNPATCHED (an older bundle, or a copied-beside-host stale copy).
    // exitCode carries NO information about cleanup: 143, 1 and 0 all occur on success.
    // Diagnose from the marker and the unit journal, and do not reason from this number.
    //
    // Either regime: if scopeUnit is set while exitCode is null, suspect the signalled
    // process is a WRAPPER rather than the bash that holds the trap.
    expect(
      existsSync(marker),
      `the job's TERM trap left no marker; job.exitCode=${job.exitCode} status=${job.status} scopeUnit=${job.scopeUnit ?? 'none'} sawWorking=${trapInstalled} (WI-1064487: if the runner carries exitCodeFor(), 143=SIGTERM so the trap had its chance and this is a real cleanup fault, 137=SIGKILL beat the trap, 0=clean exit. If the runner is UNPATCHED, this exit code proves NOTHING about cleanup — 143, 1 and 0 all occur on PASSING runs — so diagnose from the marker and the unit journal instead. scopeUnit set while exitCode is null ⇒ suspect a WRAPPER was signalled, not the bash holding the trap.)`,
    ).toBe(true);
    expect(readFileSync(marker, 'utf8')).toContain('cleaned');
  }, 30_000);

  it("⭐ says WHY it died, in the job output — a silent death reads as an OOM or a peer's pkill", async () => {
    const job = startBackground({ command: 'echo working; sleep 30', cwd: STATE, stateDir: STATE }, 400);
    await waitForEnd(job.id);
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(out).toContain('400ms');
    // The explanation is on disk too, so it survives loss of the in-memory registry.
    expect(readFileSync(job.logPath, 'utf8')).toContain('deadline reached');
  }, 30_000);

  /**
   * EI-19315037905600226 — "deadline reached" alone conflates two very different
   * deaths: killed mid-execution vs. killed while still QUEUED behind pc-heavy's
   * semaphore (a job's own wall-clock deadline is not exempt from that wait). The
   * deadline handler classifies the job's own output only when pc-heavy emitted
   * a queue or slot-acquired landmark. A missing acquired marker by itself is
   * deliberately inconclusive.
   */
  it('⭐ leaves the deadline reason unknown when no pc-heavy marker exists', async () => {
    const job = startBackground({ command: 'echo working; sleep 30', cwd: STATE, stateDir: STATE }, 400);
    await waitForEnd(job.id);
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(job.deadlineReason).toBeUndefined();
    expect(out).not.toContain('most likely died QUEUED');
    expect(out).not.toContain('deadline fired before heavy-command admission');
  }, 30_000);

  it('waits across output chunks without consuming a split pc-heavy marker', async () => {
    const job = startBackground(
      {
        command: `printf '%s' '${PC_HEAVY_QUEUE_WAIT_MARKER}'; sleep 0.25; printf '%s' ' a heavy slot'; sleep 30`,
        cwd: STATE,
        stateDir: STATE,
      },
      10_000,
    );
    const evidence = () =>
      JSON.stringify({
        status: job.status,
        exitCode: job.exitCode,
        output: job.buffer,
        totalBytes: job.totalBytes,
        phaseTiming: job.phaseTiming,
        logPath: job.logPath,
      });
    try {
      expect(await waitForOutput(job.id, 'queued'), evidence()).toBe(true);
      expect(await waitForOutput(job.id, PC_HEAVY_QUEUE_WAIT_MARKER, 1_000), evidence()).toBe(true);
    } finally {
      if (job.status === 'running') killJob(job);
      await waitForEnd(job.id, 5_000);
    }
  }, 15_000);

  it('⭐ classifies a queued pc-heavy deadline and exposes the reason in the snapshot', async () => {
    const job = await expireDeadlineAfterOutput(
      `sleep 0.6; echo '${PC_HEAVY_QUEUE_WAIT_MARKER} a heavy slot'; sleep 30`,
      PC_HEAVY_QUEUE_WAIT_MARKER,
    );
    const out = readJobOutput(job);
    expect(job.deadlineReason).toBe('deadline_before_slot_acquired');
    expect(snapshotJobResult(job, true).reason).toBe('deadline_before_slot_acquired');
    expect(out).toContain('deadline fired before heavy-command admission');
  }, 30_000);

  it("⭐ classifies a deadline after the pc-heavy slot-acquired marker", async () => {
    const job = await expireDeadlineAfterOutput(
      `sleep 0.6; echo '${PC_HEAVY_SLOT_ACQUIRED_MARKER}'; sleep 30`,
      PC_HEAVY_SLOT_ACQUIRED_MARKER,
    );
    const out = readJobOutput(job);
    expect(out).toContain('deadline reached');
    expect(job.deadlineReason).toBe('deadline_after_slot_acquired');
    expect(snapshotJobResult(job, true).reason).toBe('deadline_after_slot_acquired');
    expect(out).not.toContain('deadline fired before heavy-command admission');
  }, 30_000);
});

describe('detectSelfOutputRedirect (EI-21301075566136325)', () => {
  it('detects the reported shape: trailing append redirect with 2>&1', () => {
    expect(detectSelfOutputRedirect('npm run --workspace "$ws" "$script" >> /tmp/p005-part3-guards.log 2>&1')).toEqual({
      target: '/tmp/p005-part3-guards.log',
      op: '>>',
      literalPath: true,
    });
  });

  it('detects a redirect ANYWHERE in the command, not just the last stage', () => {
    expect(detectSelfOutputRedirect('for i in 1 2 3; do echo $i >> /tmp/probe.log; sleep 20; done')).toEqual({
      target: '/tmp/probe.log',
      op: '>>',
      literalPath: true,
    });
  });

  it('returns null for a plain command and for a pipe-only command', () => {
    expect(detectSelfOutputRedirect('npm run build')).toBeNull();
    expect(detectSelfOutputRedirect('cmd 2>&1 | tail -45')).toBeNull();
  });

  it('ignores stderr-only redirects — stdout still reaches the capability log', () => {
    expect(detectSelfOutputRedirect('cmd 2> /tmp/err.log')).toBeNull();
    expect(detectSelfOutputRedirect('cmd 2>> /tmp/err.log')).toBeNull();
  });

  it('ignores fd dups and process substitution', () => {
    expect(detectSelfOutputRedirect('echo hi >&2')).toBeNull();
    expect(detectSelfOutputRedirect('cmd > >(tee /tmp/x)')).toBeNull();
  });

  it('flags the &> both-streams redirect', () => {
    expect(detectSelfOutputRedirect('cmd &> /tmp/both.log')).toEqual({
      target: '/tmp/both.log',
      op: '&>',
      literalPath: true,
    });
  });

  it('a $var target is detected but marked non-literal (unsafe to stat)', () => {
    expect(detectSelfOutputRedirect('cmd > "$OUT/run.log"')).toEqual({
      target: '$OUT/run.log',
      op: '>',
      literalPath: false,
    });
  });

  it('a redirect inside quotes is prose, not a redirect', () => {
    expect(detectSelfOutputRedirect("echo 'a > b'")).toBeNull();
    expect(detectSelfOutputRedirect('echo "x > y"')).toBeNull();
  });

  it('ignores truncation redirects owned by no-output builtins or by no command', () => {
    expect(detectSelfOutputRedirect(': > "$L"')).toBeNull();
    expect(detectSelfOutputRedirect('true > f')).toBeNull();
    expect(detectSelfOutputRedirect('false > f')).toBeNull();
    expect(detectSelfOutputRedirect('> f')).toBeNull();
  });

  it('still detects output redirects owned by commands after no-output redirects', () => {
    expect(detectSelfOutputRedirect(': > "$L"; cmd > f')).toEqual({
      target: 'f',
      op: '>',
      literalPath: false,
    });
    expect(detectSelfOutputRedirect('cmd >> f')).toEqual({
      target: 'f',
      op: '>>',
      literalPath: false,
    });
    expect(detectSelfOutputRedirect('cmd 2>&1 > f')).toEqual({
      target: 'f',
      op: '>',
      literalPath: false,
    });
  });

  it('does not mistake JavaScript arrows inside a quoted heredoc for stdout redirection', () => {
    const command = [
      "node --input-type=module <<'NODE' | tee logs/r28-r7-repair.log",
      "const provision = items.find((o) => o.id === input.workspaceId + '-provision');",
      "console.log(provision);",
      'NODE',
    ].join('\n');
    expect(detectSelfOutputRedirect(command)).toBeNull();
  });

  it('resumes scanning after a heredoc body for redirects in later shell syntax', () => {
    const command = [
      "node --input-type=module <<'NODE'",
      'const result = values.filter((value) => value > 0);',
      'NODE',
      'node follow-up.js > /tmp/follow-up.log',
    ].join('\n');
    expect(detectSelfOutputRedirect(command)).toEqual({
      target: '/tmp/follow-up.log',
      op: '>',
      literalPath: true,
    });
  });

  it('still detects a redirect on the heredoc declaration line', () => {
    const command = [
      "node --input-type=module <<'NODE' > /tmp/heredoc.log",
      'const result = values.filter((value) => value > 0);',
      'NODE',
    ].join('\n');
    expect(detectSelfOutputRedirect(command)).toEqual({
      target: '/tmp/heredoc.log',
      op: '>',
      literalPath: true,
    });
  });

  it('a digit glued to the preceding word still redirects stdout (`echo hi1>f`)', () => {
    expect(detectSelfOutputRedirect('echo hi1>/tmp/f.log')).toEqual({
      target: '/tmp/f.log',
      op: '>',
      literalPath: true,
    });
  });

  it('explicit fd-1 redirect counts', () => {
    expect(detectSelfOutputRedirect('cmd 1> /tmp/f.log')).toEqual({
      target: '/tmp/f.log',
      op: '1>',
      literalPath: true,
    });
  });

  it('returns the LAST redirect when several are present', () => {
    expect(detectSelfOutputRedirect('a > /tmp/first.log; b >> /tmp/second.log')?.target).toBe('/tmp/second.log');
  });

  it('ignores arithmetic comparisons before a later heredoc command', () => {
    const command = [
      'if (( SECONDS >= recovery_deadline )); then',
      '  echo timeout;',
      'fi;',
      "ptool tools:invoke --json - <<'JSON'",
      '{}',
      'JSON',
    ].join('\n');
    expect(detectSelfOutputRedirect(command)).toBeNull();
  });

  it('still detects redirects adjacent to assignment operators', () => {
    expect(detectSelfOutputRedirect('main-command target=>/tmp/out.log')).toEqual({
      target: '/tmp/out.log',
      op: '>',
      literalPath: true,
    });
  });

  it('ignores a command-local curl redirect when the main command has no redirect', () => {
    expect(detectSelfOutputRedirect('main-command; curl -fsS https://example.test >/dev/null 2>&1')).toBeNull();
  });

  it('keeps the main redirect when a later curl and cleanup helper redirect to /dev/null', () => {
    expect(
      detectSelfOutputRedirect(
        'main-command > /tmp/main.log; curl -fsS https://example.test >/dev/null 2>&1; cleanup >/dev/null 2>&1',
      ),
    ).toEqual({ target: '/tmp/main.log', op: '>', literalPath: true });
  });

  it('ignores redirects inside a cleanup function body', () => {
    expect(detectSelfOutputRedirect('cleanup() { rm -f /tmp/job.tmp >/dev/null 2>&1; }; main-command')).toBeNull();
  });

  it('a 2>&1 dup AFTER a stdout redirect does not clobber the finding', () => {
    expect(detectSelfOutputRedirect('cmd > /tmp/x.log 2>&1')?.target).toBe('/tmp/x.log');
  });

  it('a relative or glob target is detected but non-literal', () => {
    expect(detectSelfOutputRedirect('cmd > out.log')).toEqual({ target: 'out.log', op: '>', literalPath: false });
    expect(detectSelfOutputRedirect('cmd > /tmp/run-*.log')?.literalPath).toBe(false);
  });
});

describe('formatSelfRedirectAdvice (EI-21301075566136325)', () => {
  it('says an empty tail means "not measured" and points at the redirect target', () => {
    const advice = formatSelfRedirectAdvice({ target: '/tmp/run.log', op: '>>', literalPath: true }, null);
    expect(advice).toContain('redirects its own stdout');
    expect(advice).toContain('/tmp/run.log');
    expect(advice).toContain('"not measured"');
    expect(advice).toContain('size/mtime');
  });

  it('includes the fresh probe measurement when one was taken', () => {
    const advice = formatSelfRedirectAdvice(
      { target: '/tmp/run.log', op: '>>', literalPath: true },
      { sizeBytes: 9738, mtimeMs: Date.UTC(2026, 7, 24, 2, 0, 0) },
    );
    expect(advice).toContain('9738 bytes');
    expect(advice).toContain('2026-08-24T02:00:00.000Z');
  });

  it('special-cases /dev/null as deliberately discarded output', () => {
    const advice = formatSelfRedirectAdvice({ target: '/dev/null', op: '>', literalPath: true }, null);
    expect(advice).toContain('discards its own stdout');
    expect(advice).not.toContain('size/mtime');
  });
});
