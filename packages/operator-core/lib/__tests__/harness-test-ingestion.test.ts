/**
 * P-007/P-020: harness Tests-tab ingestion — parser + persist.
 *
 * Pins the run-route ingestion logic that lets EVERY managed hive surface its
 * framework-test history in its own Tests tab:
 *   - parseVitestJsonForHarnessRows: vitest `--reporter=json` → one row per file
 *     (status mapping pass/fail/skip/error, root-relative POSIX path, duration,
 *     failure tail), pure + defensive.
 *   - persistHarnessTestRuns: stamps harness_slug + workspace_id on every row,
 *     returns the written count, and is D-007 fail-soft (never throws).
 */
import { describe, it, expect, vi } from 'vitest';

const currentLoopLagMock = vi.fn<() => { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number } | null>(
  () => null,
);
vi.mock('../event-loop-lag-monitor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  currentLoopLag: () => currentLoopLagMock(),
}));

import {
  parseVitestJsonForHarnessRows,
  persistHarnessTestRuns,
  persistHarnessTestRunsWithIds,
  validateHarnessTestRunProvenance,
  isLikelySaturationArtifact,
  type HarnessTestFileRow,
  type HarnessTestRunEvidence,
} from '../testing-run-store';

const ROOT = '/work/harness-repo';

function report(files: unknown[]): string {
  return JSON.stringify({ numTotalTestSuites: files.length, testResults: files });
}

describe('parseVitestJsonForHarnessRows', () => {
  it('maps a passing file to a root-relative POSIX path + pass status + duration', () => {
    const json = report([
      {
        name: `${ROOT}/src/foo.test.ts`,
        status: 'passed',
        startTime: 1000,
        endTime: 1350,
        assertionResults: [
          { status: 'passed', title: 'a' },
          { status: 'passed', title: 'b' },
        ],
      },
    ]);
    const rows = parseVitestJsonForHarnessRows(json, ROOT);
    expect(rows).toHaveLength(1);
    expect(rows[0].filePath).toBe('src/foo.test.ts');
    expect(rows[0].status).toBe('pass');
    expect(rows[0].durationMs).toBe(350);
    expect(rows[0].startedAt.getTime()).toBe(1000);
    expect(rows[0].finishedAt.getTime()).toBe(1350);
    expect(rows[0].outputTail).toBeNull();
    expect(rows[0].execution).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
    });
  });

  it('maps a failed file to fail + captures the failure tail', () => {
    const json = report([
      {
        name: `${ROOT}/src/bar.test.ts`,
        status: 'failed',
        startTime: 0,
        endTime: 10,
        assertionResults: [
          { status: 'passed', title: 'ok' },
          { status: 'failed', title: 'broken', failureMessages: ['Expected 1 to be 2'] },
        ],
      },
    ]);
    const rows = parseVitestJsonForHarnessRows(json, ROOT);
    expect(rows[0].status).toBe('fail');
    expect(rows[0].outputTail).toContain('Expected 1 to be 2');
  });

  it('persists exact failed names separately from truncated DOM diagnostics (EI-25248905256718690)', async () => {
    const names = ['suite > first failure', 'suite — second > failure: with a colon'];
    const [row] = parseVitestJsonForHarnessRows(report([{
      name: `${ROOT}/src/dom.test.ts`, status: 'failed',
      assertionResults: [
        { status: 'passed', fullName: 'suite > passes' },
        ...names.map(fullName => ({ status: 'failed', fullName, failureMessages: ['DOM '.repeat(3_000)] })),
      ],
    }]), ROOT);
    expect(row.outputTail).toHaveLength(4_000);
    expect(row.execution).toEqual({ passed: 1, failed: 2, skipped: 0, collectionFailed: false,
      passedCaseTitles: ['suite > passes'], failedCaseTitles: names });
    const { sql, calls } = makeRecordingSql();
    expect(await persistHarnessTestRuns({
      root: ROOT, harnessSlug: 'papercusp', workspaceId: 'ws', rows: [row],
      runGroupId: 'retained-dom', commit: 'abc', worktreeDirty: false, sql,
    })).toBe(1);
    const stored = calls[0].find(value => typeof value === 'object' && value !== null && 'schemaVersion' in value);
    expect(stored).toMatchObject({ failedCaseTitles: names, failed: 2 });
  });

  it('maps an all-skipped "passed" file to skip (not pass)', () => {
    const json = report([
      {
        name: `${ROOT}/src/skipme.test.ts`,
        status: 'passed',
        startTime: 5,
        endTime: 6,
        assertionResults: [
          { status: 'skipped', title: 's1' },
          { status: 'pending', title: 's2' },
        ],
      },
    ]);
    const rows = parseVitestJsonForHarnessRows(json, ROOT);
    expect(rows[0].status).toBe('skip');
  });

  it('maps a file with no recognizable status to error', () => {
    const json = report([{ name: `${ROOT}/src/weird.test.ts`, startTime: 1, endTime: 2 }]);
    const rows = parseVitestJsonForHarnessRows(json, ROOT);
    expect(rows[0].status).toBe('error');
  });

  it('returns [] for malformed JSON or a non-vitest report (best-effort skip)', () => {
    expect(parseVitestJsonForHarnessRows('not json{', ROOT)).toEqual([]);
    expect(parseVitestJsonForHarnessRows(JSON.stringify({ ok: true }), ROOT)).toEqual([]);
    expect(parseVitestJsonForHarnessRows(report([{ status: 'passed' }]), ROOT)).toEqual([]); // no name → dropped
  });

  it('handles multiple files in one report', () => {
    const json = report([
      {
        name: `${ROOT}/a.test.ts`,
        status: 'passed',
        startTime: 0,
        endTime: 1,
        assertionResults: [{ status: 'passed' }],
      },
      {
        name: `${ROOT}/nested/b.test.ts`,
        status: 'failed',
        startTime: 0,
        endTime: 2,
        assertionResults: [{ status: 'failed', failureMessages: ['boom'] }],
      },
    ]);
    const rows = parseVitestJsonForHarnessRows(json, ROOT);
    expect(rows.map((r) => r.filePath)).toEqual(['a.test.ts', 'nested/b.test.ts']);
    expect(rows.map((r) => r.status)).toEqual(['pass', 'fail']);
  });

  it('measures pending/todo as exclusions without inventing executed cases', () => {
    const [row] = parseVitestJsonForHarnessRows(report([{
      name: `${ROOT}/selected.test.ts`, status: 'passed',
      assertionResults: [{ status: 'passed' }, { status: 'pending' }, { status: 'todo' }, { status: 'skipped' }],
    }]), ROOT);
    expect(row.execution).toEqual({ passed: 1, failed: 0, skipped: 3, collectionFailed: false });
  });

  it.each([undefined, null, [{ status: 'running' }], [null]])(
    'does not turn missing or malformed assertions into complete measurements: %j',
    (assertionResults) => {
      const [row] = parseVitestJsonForHarnessRows(report([{
        name: `${ROOT}/unknown.test.ts`, status: 'passed', assertionResults,
      }]), ROOT);
      expect(row.execution).toBeUndefined();
    },
  );

  it('retains a collection failure with no executed assertions', () => {
    const [row] = parseVitestJsonForHarnessRows(report([{
      name: `${ROOT}/broken.test.ts`, status: 'failed', assertionResults: [],
    }]), ROOT);
    expect(row.execution).toEqual({ passed: 0, failed: 0, skipped: 0, collectionFailed: true });
  });
});

/** Records every tagged-template insert's bound values. */
function makeRecordingSql() {
  const calls: unknown[][] = [];
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve([]);
  };
  return { sql, calls };
}

const sampleRows: HarnessTestFileRow[] = [
  {
    filePath: 'src/foo.test.ts',
    status: 'pass',
    durationMs: 120,
    startedAt: new Date(1000),
    finishedAt: new Date(1120),
    outputTail: null,
  },
  {
    filePath: 'src/bar.test.ts',
    status: 'fail',
    durationMs: 50,
    startedAt: new Date(2000),
    finishedAt: new Date(2050),
    outputTail: 'boom',
  },
];

describe('persistHarnessTestRuns', () => {
  it('inserts one row per file, stamping harness_slug + workspace_id + the EI-4940 saturation snapshot', async () => {
    currentLoopLagMock.mockReturnValue({ p50Ms: 10, p95Ms: 42.3, p99Ms: 60, maxMs: 80 });
    const { sql, calls } = makeRecordingSql();
    const written = await persistHarnessTestRuns({
      harnessSlug: 'my-hive',
      workspaceId: 'ws-42',
      rows: sampleRows,
      runGroupId: 'h-123',
      branch: 'main',
      commit: 'abc123',
      sql,
    });
    expect(written).toBe(2);
    expect(calls).toHaveLength(2);
    // Value order: filePath, framework (vitest default), status, durationMs, startedAt, finishedAt,
    // outputTail, runGroupId, source, branch, commit, harness_slug, workspace_id,
    // loop_lag_p95_ms, rss_mb
    const first = calls[0];
    expect(first[0]).toBe('src/foo.test.ts');
    expect(first[1]).toBe('vitest');
    expect(first[2]).toBe('pass');
    expect(first[7]).toBe('h-123');
    expect(first[8]).toBe('admin-ui'); // default source satisfies the CHECK
    expect(first[9]).toBe('main');
    expect(first[10]).toBe('abc123');
    expect(first[11]).toBe('my-hive'); // harness_slug
    expect(first[12]).toBe('ws-42'); // workspace_id
    expect(first[13]).toBe(42.3); // loop_lag_p95_ms
    expect(typeof first[14]).toBe('number'); // rss_mb — real process.memoryUsage(), not mocked
    expect(first[15]).toBe(false); // worktree_dirty
    expect(first[16]).toBeNull(); // no root/execution metadata on legacy callers
  });

  it('persists versioned execution details when detached JSON evidence supplies a root', async () => {
    const { sql, calls } = makeRecordingSql();
    await persistHarnessTestRuns({
      harnessSlug: 'my-hive',
      workspaceId: 'ws-42',
      rows: [{
        ...sampleRows[0],
        execution: { passed: 1, failed: 0, skipped: 35, collectionFailed: false },
      }],
      runGroupId: 'h-123',
      commit: 'abc123',
      worktreeDirty: false,
      root: '/work/harness-repo',
      testNamePattern: 'PUI-USAGE',
      sql,
    });
    // postgres-js serializes an object into jsonb. Passing a pre-stringified
    // value instead stores a JSON string scalar and breaks field reads.
    expect(calls[0][16]).toEqual({
      schemaVersion: 1,
      root: '/work/harness-repo',
      filePath: 'src/foo.test.ts',
      runGroupId: 'h-123',
      workspaceId: 'ws-42',
      harnessSlug: 'my-hive',
      testNamePattern: 'PUI-USAGE',
      passed: 1,
      failed: 0,
      skipped: 35,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: 'abc123',
      worktreeDirty: false,
    });
  });

  it('does not assert a clean worktree when a measured caller omitted provenance', async () => {
    const { sql, calls } = makeRecordingSql();
    await persistHarnessTestRuns({
      harnessSlug: 'h', workspaceId: 'w', runGroupId: 'g', root: ROOT,
      rows: [{ ...sampleRows[0], execution: { passed: 1, failed: 0, skipped: 0, collectionFailed: false } }],
      sql,
    });
    expect(calls[0][15]).toBe(true);
    expect(calls[0][16]).toMatchObject({ commitSha: null, worktreeDirty: true });
  });

  it('EI-4940: loop_lag_p95_ms is null when no monitor is running (absence of signal, not a claim of calm)', async () => {
    currentLoopLagMock.mockReturnValue(null);
    const { sql, calls } = makeRecordingSql();
    await persistHarnessTestRuns({
      harnessSlug: 'h',
      workspaceId: 'w',
      rows: [sampleRows[0]],
      runGroupId: 'g',
      sql,
    });
    expect(calls[0][13]).toBeNull();
  });

  it('returns 0 and never touches the DB for an empty row set', async () => {
    const { sql, calls } = makeRecordingSql();
    const written = await persistHarnessTestRuns({
      harnessSlug: 'h',
      workspaceId: 'w',
      rows: [],
      runGroupId: 'g',
      sql,
    });
    expect(written).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('returns inserted numeric IDs and preserves an explicit operational framework', async () => {
    let nextId = 70;
    const calls: unknown[][] = [];
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      nextId += 1;
      return Promise.resolve([{ id: String(nextId) }]);
    }) as Parameters<typeof persistHarnessTestRuns>[0]['sql'];

    const result = await persistHarnessTestRunsWithIds({
      harnessSlug: 'my-hive',
      workspaceId: 'ws-42',
      rows: [{ ...sampleRows[0], framework: 'operational' }],
      runGroupId: 'operational:proof',
      sql,
    });

    expect(result).toEqual({ written: 1, ids: [71] });
    expect(calls[0][1]).toBe('operational');
  });

  it('waits for a late exact-ID insert instead of reporting a false ledger failure', async () => {
    vi.useFakeTimers();
    try {
      const sql = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ id: '17700112' }]), 1_100);
        })) as Parameters<typeof persistHarnessTestRuns>[0]['sql'];
      let completed = false;
      const pending = persistHarnessTestRunsWithIds({
        harnessSlug: 'my-hive',
        workspaceId: 'ws-42',
        rows: [{ ...sampleRows[0], framework: 'operational' }],
        runGroupId: 'operational:late-proof',
        sql,
      }).then((result) => {
        completed = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(completed).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toEqual({ written: 1, ids: [17700112] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is fail-soft: a throwing sql client swallows and never rejects', async () => {
    const throwingSql = (): never => {
      throw new Error('pg down');
    };
    const written = await persistHarnessTestRuns({
      harnessSlug: 'h',
      workspaceId: 'w',
      rows: sampleRows,
      runGroupId: 'g',
      sql: throwingSql,
    });
    expect(written).toBe(0);
  });
});

describe('trusted test-run provenance', () => {
  const query = {
    testRunIds: [17700101, 17700102],
    workspaceId: 'ws-proof',
    harnessSlug: 'h-proof',
    runGroupId: 'run-proof',
    root: '/work/harness-repo',
    filePaths: ['src/a.test.ts', 'src/b.test.ts'],
  } as const;

  const row = (id: number, filePath: string, commitSha = 'ABC123'): HarnessTestRunEvidence => ({
    id,
    file_path: filePath,
    status: 'pass',
    finished_at: '2026-09-13T21:00:00Z',
    workspace_id: query.workspaceId,
    harness_slug: query.harnessSlug,
    run_group_id: query.runGroupId,
    commit_sha: commitSha,
    worktree_dirty: false,
    execution_details: {
      schemaVersion: 1,
      root: query.root,
      filePath,
      runGroupId: query.runGroupId,
      workspaceId: query.workspaceId,
      harnessSlug: query.harnessSlug,
      testNamePattern: null,
      passed: 1,
      failed: 0,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha,
      worktreeDirty: false,
    },
  });

  it('returns one normalized SHA only for the complete exact row set', () => {
    expect(validateHarnessTestRunProvenance(query, [
      row(17700101, 'src/a.test.ts'),
      row(17700102, 'src/b.test.ts'),
    ])).toMatchObject({
      commitSha: 'abc123',
      testRunIds: [17700101, 17700102],
      filePaths: ['src/a.test.ts', 'src/b.test.ts'],
    });
  });

  it.each([
    ['missing exact row', [row(17700101, 'src/a.test.ts')]],
    ['dirty worktree', [row(17700101, 'src/a.test.ts'), { ...row(17700102, 'src/b.test.ts'), worktree_dirty: true }]],
    ['inconsistent SHA', [row(17700101, 'src/a.test.ts'), row(17700102, 'src/b.test.ts', 'def456')]],
    ['incomplete details', [row(17700101, 'src/a.test.ts'), { ...row(17700102, 'src/b.test.ts'), execution_details: null }]],
  ])('rejects %s instead of returning runtime identity', (_name, rows) => {
    expect(validateHarnessTestRunProvenance(query, rows)).toBeNull();
  });
});

describe('isLikelySaturationArtifact (EI-4940)', () => {
  it('true: a bare timeout failure recorded while the loop was critically saturated', () => {
    expect(
      isLikelySaturationArtifact({
        status: 'fail',
        outputTail: 'Error: Test timed out in 60000ms.',
        loopLagP95Ms: 900, // > the 600ms critical default
      }),
    ).toBe(true);
  });

  it('false: a timeout-shaped message but the host was NOT saturated (elevated or ok band)', () => {
    expect(
      isLikelySaturationArtifact({
        status: 'fail',
        outputTail: 'Error: Test timed out in 60000ms.',
        loopLagP95Ms: 50, // well under the elevated default
      }),
    ).toBe(false);
  });

  it('false: the host was saturated but the failure is a real assertion, not a timeout', () => {
    expect(
      isLikelySaturationArtifact({
        status: 'fail',
        outputTail: 'AssertionError: expected 1 to equal 2',
        loopLagP95Ms: 900,
      }),
    ).toBe(false);
  });

  it('false: loopLagP95Ms null (no monitor running) never masquerades as saturation — conservative default', () => {
    expect(
      isLikelySaturationArtifact({
        status: 'fail',
        outputTail: 'Error: Test timed out in 60000ms.',
        loopLagP95Ms: null,
      }),
    ).toBe(false);
  });

  it('false: a passing row is never flagged regardless of lag', () => {
    expect(isLikelySaturationArtifact({ status: 'pass', outputTail: null, loopLagP95Ms: 900 })).toBe(false);
  });

  it('recognizes jest/vitest\'s alternate timeout phrasing ("exceeded timeout of Nms")', () => {
    expect(
      isLikelySaturationArtifact({
        status: 'error',
        outputTail: 'thrown: "Exceeded timeout of 5000ms for a hook."',
        loopLagP95Ms: 700,
      }),
    ).toBe(true);
  });
});
