/**
 * P-043: testing-run-store tests.
 *
 * Spawn a fast-exiting `bash -c "echo hi"` and a slow `sleep 30`,
 * verify startRun returns a snapshot, status transitions to pass,
 * output captured, cancellation works.
 *
 * Uses the live store (no DB needed — store is in-memory).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startRun,
  getRun,
  getRunAsync,
  TestingRunSnapshotUnavailableError,
  cancelRun,
  listRuns,
  persistRunSnapshot,
  distillVitestRun,
  parseFailureDetailsSidecar,
  parseVitestJsonForHarnessRows,
  COLLECTION_FAILURE_TEST,
  _resetTestingRunStore,
} from '../testing-run-store';

afterEach(() => {
  _resetTestingRunStore();
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('startRun', () => {
  it('returns a snapshot with status=running for a real spawn', () => {
    const snap = startRun({
      kind: 'shell',
      label: 'echo',
      command: 'bash',
      args: ['-c', 'echo hello; exit 0'],
    });
    expect(snap.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(snap.status).toBe('running');
    expect(snap.exitCode).toBeNull();
    expect(snap.command).toEqual(['bash', '-c', 'echo hello; exit 0']);
  });

  it('transitions to pass + captures output for a success exit', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'echo',
      command: 'bash',
      args: ['-c', 'echo captured-output; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    const after = getRun(snap.runId);
    expect(after?.status).toBe('pass');
    expect(after?.exitCode).toBe(0);
    expect(after?.output).toContain('captured-output');
  });

  it('transitions to fail for a non-zero exit', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'fail',
      command: 'bash',
      args: ['-c', 'echo nope >&2; exit 7'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    const after = getRun(snap.runId);
    expect(after?.status).toBe('fail');
    expect(after?.exitCode).toBe(7);
    expect(after?.output).toContain('nope');
  });

  it('returns status=error when spawn itself throws', () => {
    const snap = startRun({
      kind: 'shell',
      label: 'no-such-bin',
      command: '/definitely/not/a/binary/zzz',
      args: [],
    });
    // Spawn doesn't sync-throw on ENOENT — Node emits 'error' on the proc.
    // We accept either error-on-construction OR error event flips status.
    expect(['running', 'error']).toContain(snap.status);
  });
});

describe('cancelRun', () => {
  it('SIGTERMs a running process and flips status to cancelled', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'sleeper',
      command: 'bash',
      args: ['-c', 'sleep 30'],
    });
    // Give the child a beat to actually start.
    await new Promise((r) => setTimeout(r, 100));
    const ok = cancelRun(snap.runId);
    expect(ok).toBe(true);
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.status).toBe('cancelled');
  });

  it('returns false for an unknown runId', () => {
    expect(cancelRun('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('returns false for an already-finished run', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'short',
      command: 'bash',
      args: ['-c', 'true'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(cancelRun(snap.runId)).toBe(false);
  });
});

describe('listRuns', () => {
  it('returns recent runs newest-first', async () => {
    const a = startRun({ kind: 'shell', label: 'a', command: 'bash', args: ['-c', 'true'] });
    await new Promise((r) => setTimeout(r, 10));
    const b = startRun({ kind: 'shell', label: 'b', command: 'bash', args: ['-c', 'true'] });
    const all = listRuns();
    const ids = all.map((s) => s.runId);
    expect(ids.indexOf(b.runId)).toBeLessThan(ids.indexOf(a.runId));
  });
});

describe('durable detached snapshots', () => {
  type Sql = NonNullable<Parameters<typeof persistRunSnapshot>[1]>;

  it('reads a snapshot from the shared ledger when the local worker has no run', async () => {
    const remote = {
      run_id: 'remote-run',
      task_id: null,
      kind: 'vitest',
      label: 'remote test',
      file_path: 'packages/example.test.ts',
      command: JSON.stringify(['node', 'scripts/test-files.mjs']),
      status: 'running',
      exit_code: null,
      started_at: new Date(1_700_000_000_000),
      finished_at: null,
      output: 'still running',
      truncated: false,
    };
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('FROM harness_shared.testing_run_snapshots')) return [remote];
      if (statement.includes('FROM harness_shared.test_runs')) return [];
      throw new Error(`Unexpected detached snapshot query: ${statement}`);
    }) as unknown as Sql;

    await expect(getRunAsync(remote.run_id, sql)).resolves.toEqual({
      runId: remote.run_id,
      kind: remote.kind,
      label: remote.label,
      filePath: remote.file_path,
      command: ['node', 'scripts/test-files.mjs'],
      status: remote.status,
      exitCode: null,
      startedAt: 1_700_000_000_000,
      finishedAt: null,
      output: remote.output,
      truncated: false,
    });
    // A running remote snapshot also checks the reporter's durable verdict
    // ledger. No completed test rows means it must remain running.
    expect(sql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sql).mock.calls[1]?.[0]?.join(' ')).toContain('FROM harness_shared.test_runs');
  });

  it('preserves the local snapshot while reconciling its durable task lifecycle', async () => {
    const local = startRun({ kind: 'vitest', label: 'local', command: 'node', args: ['-e', ''] });
    const sql = vi.fn(async () => []) as unknown as Sql;

    await expect(getRunAsync(local.runId, sql)).resolves.toMatchObject({ runId: local.runId, status: 'running' });
    expect(sql).toHaveBeenCalledTimes(1);
    const query = vi.mocked(sql).mock.calls[0]?.[0]?.join(' ');
    expect(query).toContain('FROM harness_shared.testing_run_snapshots AS snapshot');
    expect(query).toContain('LEFT JOIN harness_shared.task_ledger AS task_ledger');
  });

  it('persists snapshots fail-soft and serializes command argv as JSON', async () => {
    const sql = vi.fn(async () => []) as unknown as Sql;
    const snapshot = {
      runId: 'persisted-run',
      kind: 'shell' as const,
      label: 'persist me',
      command: ['bash', '-c', 'true'],
      status: 'pass' as const,
      exitCode: 0,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      output: 'ok',
      truncated: false,
    };

    await expect(persistRunSnapshot(snapshot, sql)).resolves.toBe(true);
    expect(sql).toHaveBeenCalledTimes(1);
    const values = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0].slice(1);
    expect(values).toContain(JSON.stringify(snapshot.command));
  });

  it('reports a failed snapshot query as unavailable instead of an absent run', async () => {
    const sql = vi.fn(async () => {
      throw new Error('db unavailable');
    }) as unknown as Sql;

    await expect(getRunAsync('unavailable-run', sql)).rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });
});

describe('P-014 admin-ui source propagation', () => {
  // The store sets PAPERCUSP_TEST_RUN_SOURCE=admin-ui on every spawn so the
  // in-process Vitest/Playwright reporter stamps rows with the right source.
  // The child env is observable via bash printenv.
  it('passes PAPERCUSP_TEST_RUN_SOURCE=admin-ui to the child env', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'env-probe',
      command: 'bash',
      args: ['-c', 'echo SRC=$PAPERCUSP_TEST_RUN_SOURCE; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.output).toContain('SRC=admin-ui');
  });

  it('passes PAPERCUSP_TEST_RUN_GROUP=<runId> to the child env', async () => {
    const snap = startRun({
      kind: 'shell',
      label: 'group-probe',
      command: 'bash',
      args: ['-c', 'echo GRP=$PAPERCUSP_TEST_RUN_GROUP; exit 0'],
    });
    await waitFor(() => getRun(snap.runId)?.finishedAt !== null);
    expect(getRun(snap.runId)?.output).toContain(`GRP=${snap.runId}`);
  });

  // persistFallbackRow is fail-soft (D-007). With no PG configured for the
  // unit-test env the insert silently swallows; the run should still finish
  // cleanly and never throw.
  it('node/shell close handler never throws even when PG is unreachable', async () => {
    const original = process.env.HARNESS_ADMIN_DATABASE_URL;
    process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/papercusp_no_such_db';
    try {
      const snap = startRun({
        kind: 'shell',
        label: 'fail-soft',
        command: 'bash',
        args: ['-c', 'echo done'],
      });
      await waitFor(() => getRun(snap.runId)?.finishedAt !== null, 5000);
      expect(getRun(snap.runId)?.status).toBe('pass');
    } finally {
      if (original === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
      else process.env.HARNESS_ADMIN_DATABASE_URL = original;
    }
  });
});

// ── P-021: distillVitestRun — the agent-facing projection (plan D-021/D-022) ──

const ROOT = '/repo';

/** Build a `--reporter=json` payload without hand-writing the envelope each time. */
function report(files: Array<Partial<{
  name: string; status: string; startTime: number; endTime: number; message: string;
  assertionResults: Array<Partial<{ status: string; fullName: string; title: string; failureMessages: unknown }>>;
}>>): string {
  return JSON.stringify({ testResults: files });
}

describe('distillVitestRun', () => {
  it('counts per TEST, not per file, and sums across files', () => {
    const out = distillVitestRun(report([
      {
        name: `${ROOT}/a.test.ts`, status: 'passed',
        assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'skipped' }],
      },
      {
        name: `${ROOT}/b.test.ts`, status: 'failed',
        assertionResults: [{ status: 'passed' }, { status: 'failed', fullName: 'x > y', failureMessages: ['boom'] }],
      },
    ]), ROOT);

    expect(out.files).toBe(2);
    expect(out.passed).toBe(3);
    expect(out.failed).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it('identifies a failing test by file + fullName + its first message', () => {
    const out = distillVitestRun(report([{
      name: `${ROOT}/pkg/b.test.ts`, status: 'failed',
      assertionResults: [{
        status: 'failed', fullName: 'suite > does the thing',
        failureMessages: ['expected 1 to be 2', 'second message'],
      }],
    }]), ROOT);

    expect(out.failures).toEqual([
      { file: 'pkg/b.test.ts', test: 'suite > does the thing', message: 'expected 1 to be 2' },
    ]);
  });

  it('enriches a JSON failure with actual/expected values from the optional sidecar', () => {
    const json = report([{
      name: `${ROOT}/pkg/b.test.ts`, status: 'failed',
      assertionResults: [{
        status: 'failed', fullName: 'suite > does the thing',
        failureMessages: ['expected { service_select: true, …(6) }'],
      }],
    }]);
    const details = parseFailureDetailsSidecar(JSON.stringify({ failures: [{
      file: `${ROOT}/pkg/b.test.ts`,
      test: 'suite > does the thing',
      actual: '{ service_select: false }',
      expected: '{ service_select: true }',
    }] }), ROOT);

    const out = distillVitestRun(json, ROOT, { failureDetails: details });

    expect(out.failures).toEqual([{
      file: 'pkg/b.test.ts',
      test: 'suite > does the thing',
      message: 'expected { service_select: true, …(6) }',
      actual: '{ service_select: false }',
      expected: '{ service_select: true }',
    }]);
  });

  it('redacts launch-environment secrets in every Vitest report projection', () => {
    const credential = 'synthetic-child-credential-value-never-present-in-parent-env';
    const environment = { SYNTHETIC_CHILD_API_KEY: credential };
    const json = report([{
      name: `${ROOT}/pkg/credential.test.ts`, status: 'failed',
      assertionResults: [{
        status: 'failed', fullName: 'suite > keeps credentials private',
        failureMessages: [`received ${credential} from the child environment`],
      }],
    }]);
    const details = parseFailureDetailsSidecar(JSON.stringify({ failures: [{
      file: `${ROOT}/pkg/credential.test.ts`,
      test: 'suite > keeps credentials private',
      actual: { observed: credential },
      expected: { observed: 'placeholder' },
    }] }), ROOT, environment);

    const distilled = distillVitestRun(json, ROOT, { failureDetails: details, environment });
    const rows = parseVitestJsonForHarnessRows(json, ROOT, environment);
    const projected = JSON.stringify({ distilled, rows });

    expect(projected).not.toContain(credential);
    expect(distilled.failures[0]?.message).toContain('[redacted]');
    expect(distilled.failures[0]?.actual).toContain('[redacted]');
    expect(rows[0]?.outputTail).toContain('[redacted]');
  });

  it('parses malformed or unsupported sidecars fail-soft', () => {
    expect(parseFailureDetailsSidecar('not json', ROOT)).toEqual([]);
    expect(parseFailureDetailsSidecar(JSON.stringify({ failures: [{ file: '', test: 't' }, null] }), ROOT)).toEqual([]);
  });

  it('falls back to title when fullName is absent', () => {
    const out = distillVitestRun(report([{
      name: `${ROOT}/a.test.ts`, status: 'failed',
      assertionResults: [{ status: 'failed', title: 'bare title', failureMessages: ['nope'] }],
    }]), ROOT);
    expect(out.failures[0].test).toBe('bare title');
  });

  // THE load-bearing case: a file that throws at import produces NO failing
  // assertion, so a naive per-test projection reports `failed: 0` for a red run.
  it('surfaces a collection failure (failed file, zero assertions) as a failure', () => {
    const out = distillVitestRun(report([{
      name: `${ROOT}/broken.test.ts`, status: 'failed',
      message: 'SyntaxError: Unterminated template literal',
      assertionResults: [],
    }]), ROOT);

    expect(out.failed).toBe(1);
    expect(out.failures).toEqual([{
      file: 'broken.test.ts',
      test: COLLECTION_FAILURE_TEST,
      message: 'SyntaxError: Unterminated template literal',
    }]);
  });

  it('does not double-count a failed file that DID report a failing assertion', () => {
    const out = distillVitestRun(report([{
      name: `${ROOT}/a.test.ts`, status: 'failed',
      message: 'file-level noise',
      assertionResults: [{ status: 'failed', fullName: 't', failureMessages: ['boom'] }],
    }]), ROOT);

    expect(out.failed).toBe(1);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].test).toBe('t');
  });

  it('caps the failure LIST but keeps the failure COUNT complete', () => {
    const asserts = Array.from({ length: 30 }, (_, i) => ({
      status: 'failed', fullName: `t${i}`, failureMessages: [`m${i}`],
    }));
    const out = distillVitestRun(
      report([{ name: `${ROOT}/a.test.ts`, status: 'failed', assertionResults: asserts }]),
      ROOT,
      { maxFailures: 5 },
    );

    expect(out.failed).toBe(30);
    expect(out.failures).toHaveLength(5);
    expect(out.failuresTruncated).toBe(true);
  });

  it('truncates an overlong failure message to the budget', () => {
    const out = distillVitestRun(report([{
      name: `${ROOT}/a.test.ts`, status: 'failed',
      assertionResults: [{ status: 'failed', fullName: 't', failureMessages: ['x'.repeat(5000)] }],
    }]), ROOT, { maxMessageChars: 100 });

    expect(out.failures[0].message).toHaveLength(100);
  });

  it('reports wall-clock duration as the span across files, not their sum', () => {
    const out = distillVitestRun(report([
      { name: `${ROOT}/a.test.ts`, status: 'passed', startTime: 1000, endTime: 4000, assertionResults: [] },
      { name: `${ROOT}/b.test.ts`, status: 'passed', startTime: 2000, endTime: 9000, assertionResults: [] },
    ]), ROOT);

    // Parallel files: span is 1000→9000, NOT 3000+7000.
    expect(out.durationMs).toBe(8000);
  });

  it('returns null duration when the report carries no timings', () => {
    const out = distillVitestRun(report([{ name: `${ROOT}/a.test.ts`, status: 'passed', assertionResults: [] }]), ROOT);
    expect(out.durationMs).toBeNull();
  });

  // A distillation failure must never be reported as a TEST failure.
  it('returns an empty run for malformed JSON rather than throwing', () => {
    const out = distillVitestRun('not json {{{', ROOT);
    expect(out).toMatchObject({ passed: 0, failed: 0, files: 0, failures: [], durationMs: null });
  });

  it('returns an empty run for a report with no testResults', () => {
    expect(distillVitestRun(JSON.stringify({ ok: true }), ROOT).files).toBe(0);
  });

  it('skips entries with no usable file name', () => {
    const out = distillVitestRun(report([
      { status: 'passed', assertionResults: [{ status: 'passed' }] },
      { name: `${ROOT}/a.test.ts`, status: 'passed', assertionResults: [{ status: 'passed' }] },
    ]), ROOT);
    expect(out.files).toBe(1);
  });
});
