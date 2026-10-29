/**
 * testing:runs — plan sql-escape-tool-routing-2026-08-12 P-004.
 *
 * The matcher shapes and the saturation classifier are the parts that decide
 * whether a caller gets the right ROWS; the SQL around them is exercised
 * against the live table during development. The classifier's NULL case is the
 * one with a documented failure mode, so it is asserted directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';
import {
  defaultRollupSource,
  foregroundRunMetadata,
  isSaturationSuspect,
  MUTANT_DIFF_INLINE_CHARS,
  normalizeRunGroupFilter,
  shapeTestingRuns,
  toPathPattern,
  toShaPattern,
} from './runs';
import runsTool from './runs';
import { CRITICAL_P95_MS } from '../../event-loop-lag-monitor';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
const foregroundVerdictMock = vi.hoisted(() => vi.fn(async (_runId: string): Promise<unknown> => null));
vi.mock('../../testing-run-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../testing-run-store')>()),
  getForegroundRunVerdictAsync: foregroundVerdictMock,
}));

/** Render the SQL text carried by postgres.js tagged fragments in the mock. */
function renderSqlFragment(fragment: unknown): string {
  if (!fragment || typeof fragment !== 'object') return '';
  const value = fragment as { strings?: unknown[]; args?: unknown[]; values?: unknown[] };
  if (!Array.isArray(value.strings)) return '';
  const args = value.args ?? value.values ?? [];
  return value.strings
    .map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`)
    .join('');
}

describe('toPathPattern', () => {
  it('matches a memorable path FRAGMENT as a substring — the corpus shape', () => {
    // Corpus: WHERE file_path LIKE '%release-submodule-freshness-fail-closed%'
    expect(toPathPattern('release-submodule-freshness')).toBe('%release-submodule-freshness%');
  });

  it('escapes LIKE metacharacters while keeping the fragment a substring', () => {
    expect(toPathPattern('sync/hyperbee/__tests__')).toBe('%sync/hyperbee/\\_\\_tests\\_\\_%');
    expect(toPathPattern('packages/%/lib/x.test.ts')).toBe('%packages/\\%/lib/x.test.ts%');
  });

  it('escapes a literal backslash before wrapping', () => {
    expect(toPathPattern('dir\\name%part')).toBe('%dir\\\\name\\%part%');
  });
});

describe('toShaPattern', () => {
  it('treats a short sha as a PREFIX — the column holds the full 40 chars', () => {
    // Corpus: WHERE commit_sha LIKE '362398846fd2%'
    expect(toShaPattern('362398846fd2')).toBe('362398846fd2%');
  });

  it('honours an explicit pattern verbatim', () => {
    expect(toShaPattern('%362398%')).toBe('%362398%');
  });
});

describe('defaultRollupSource', () => {
  it('isolates commit rollups to CI rows by default', () => {
    expect(defaultRollupSource('commit')).toBe('ci');
  });

  it('honors an explicit source for commit rollups', () => {
    expect(defaultRollupSource('commit', 'local')).toBe('local');
    expect(defaultRollupSource('commit', 'admin-ui')).toBe('admin-ui');
  });

  it('isolates runGroup rollups to CI rows by default, like commit rollups', () => {
    // A runGroup rollup is a GATE-RUN list. Left unscoped it swept in every
    // local row lacking a run_group_id and collapsed them into one `null`
    // group — measured at 11,822 rows across three months, larger than every
    // real run beside it. EI-19312054331303577.
    expect(defaultRollupSource('runGroup')).toBe('ci');
  });

  it('honors an explicit source for runGroup rollups', () => {
    expect(defaultRollupSource('runGroup', 'local')).toBe('local');
    expect(defaultRollupSource('runGroup', 'admin-ui')).toBe('admin-ui');
  });

  it('leaves a NON-rollup row listing unscoped when no source is named', () => {
    // The row-listing path is not a verdict about a sha, so it must keep
    // showing an agent its own local runs.
    expect(defaultRollupSource(undefined)).toBeNull();
    expect(defaultRollupSource(undefined, 'ci')).toBe('ci');
  });
});

describe('testing:runs run-group input naming', () => {
  it('accepts the output-shaped runGroupId compatibility alias', () => {
    expect(normalizeRunGroupFilter(undefined, 'run-alias')).toBe('run-alias');
    expect(runsTool.args.safeParse({ runGroupId: 'run-alias' }).success).toBe(true);
  });

  it('keeps runGroup canonical when both spellings are supplied', () => {
    expect(normalizeRunGroupFilter('run-canonical', 'run-alias')).toBe('run-canonical');
  });
});

describe('testing:runs rollup source isolation', () => {
  const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) {
        return Promise.resolve([
          {
            key: 'abc123',
            commit_sha: 'abc123def456',
            commit_shas: '1',
            total: '1',
            failed: '0',
            failed_files: '0',
            files: '1',
            first_start: '2026-08-14T13:14:24.555Z',
            last_finish: '2026-08-14T13:14:24.563Z',
            group_count: '1',
          },
        ]);
      }
      return call;
    });
  });

  it('passes source:ci into an omitted-source commit rollup and reports it', async () => {
    const result = (await runsTool.handler({ commitSha: 'abc123', rollup: 'commit' } as never, {} as never)) as {
      data?: { source?: string; groups?: Array<{ failed: number }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const whereCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('file_path')));

    expect(JSON.stringify(whereCall)).toContain('ci');
    expect(data).toMatchObject({ source: 'ci', groups: [{ failed: 0 }] });
  });

  it('collapses a superseded fail before aggregating a commit rollup', async () => {
    const result = (await runsTool.handler({ commitSha: 'abc123', rollup: 'commit' } as never, {} as never)) as {
      data?: { latestPerFile?: boolean; groups?: Array<{ failed: number; failedFiles: number }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const rollupCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('WITH filtered')));
    const queryText = rollupCall ? renderSqlFragment({ strings: rollupCall.strings, args: rollupCall.values }) : '';

    // The fixture returned by this mock represents a file whose older fail was
    // superseded by a newer pass. The query must explicitly select the latest
    // row per rollup key + file before counting red statuses; otherwise the
    // pre-fix aggregate would report failed=1/failedFiles=1.
    expect(queryText).toContain('DISTINCT ON (');
    expect(queryText).toContain('latest_rows');
    expect(data).toMatchObject({ latestPerFile: true, groups: [{ failed: 0, failedFiles: 0 }] });
    expect(data).not.toHaveProperty('notRecorded');
    expect(data).not.toHaveProperty('reason');
  });

  it('passes source:ci into an omitted-source runGroup rollup and reports it', async () => {
    const result = (await runsTool.handler({ rollup: 'runGroup' } as never, {} as never)) as {
      data?: { source?: string };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const whereCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('file_path')));

    // Pre-fix this reported source:null and the WHERE carried no source
    // predicate, so the "gate runs" list was contaminated by local rows.
    expect(JSON.stringify(whereCall)).toContain('ci');
    expect(data).toMatchObject({ source: 'ci' });
  });

  it('projects the candidate sha into rollup groups so a runGroup names what it judged', async () => {
    const result = (await runsTool.handler({ rollup: 'runGroup' } as never, {} as never)) as {
      data?: { groups?: Array<{ key: string | null; commitSha: string | null; commitShaCount: number }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const rollupCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('WITH filtered')));
    const queryText = rollupCall ? renderSqlFragment({ strings: rollupCall.strings, args: rollupCall.values }) : '';

    // The aggregate groups BY run_group_id, so the sha is not the key and is
    // otherwise unrecoverable — a caller could not tell which candidate a run
    // judged. commit_shas is what keeps a multi-candidate group honest rather
    // than silently presenting one arbitrary member as "the" sha.
    expect(queryText).toContain('max(commit_sha)');
    expect(queryText).toContain('commit_shas');
    expect(data.groups?.[0]).toMatchObject({ commitSha: 'abc123def456', commitShaCount: 1 });
  });
});

describe('testing:runs runGroupId compatibility alias', () => {
  const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      return call;
    });
  });

  it('binds runGroupId to the existing run_group_id filter', async () => {
    await runsTool.handler({ runGroupId: 'run-from-alias' } as never, {} as never);
    expect(JSON.stringify(sqlCalls)).toContain('run-from-alias');
  });

  it('does not bind the alias when canonical runGroup is supplied', async () => {
    await runsTool.handler({ runGroup: 'run-canonical', runGroupId: 'run-alias' } as never, {} as never);
    expect(JSON.stringify(sqlCalls)).toContain('run-canonical');
    expect(JSON.stringify(sqlCalls)).not.toContain('run-alias');
  });
});

describe('testing:runs evidence identity', () => {
  const cappedDetails = {
    schemaVersion: 1, root: '/checkouts/papercusp', filePath: 'same.test.ts',
    runGroupId: null, workspaceId: 'workspace-a', harnessSlug: 'harness-a',
    testNamePattern: null, testLayer: 'integration', passed: 80, failed: 0, skipped: 0,
    collectionFailed: false, mutationPhase: null, commitSha: 'abc123', worktreeDirty: true,
    passedCaseTitles: Array.from({ length: 64 }, (_, index) => `suite > case ${index}`),
    passedCaseTitlesTruncated: true,
  };

  async function readDetails(executionDetails: unknown) {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (!call.strings.some(part => part.includes('WITH filtered'))) return call;
      return Promise.resolve([{
        id: '17692433', workspace_id: 'workspace-a', harness_slug: 'harness-a',
        execution_details: executionDetails, file_path: 'same.test.ts',
        status: 'pass', framework: 'vitest', started_at: '2026-09-08T09:43:05Z',
        finished_at: '2026-09-08T09:43:06Z', duration_ms: '1000', output_tail: null,
        run_group_id: null, source: 'local', branch: 'staging', commit_sha: 'abc123',
        loop_lag_p95_ms: null, rss_mb: null, worktree_dirty: true,
        is_scratch_config: false, total: '1',
      }]);
    });
    const result = await runsTool.handler({ testRunIds: [17692433], limit: 1 } as never, {} as never) as {
      data?: { runs: Array<Record<string, unknown>> };
      content?: Array<{ text: string }>;
    };
    return (result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}')).runs[0];
  }

  it.each([
    { name: 'missing column', stored: undefined, reason: 'not-recorded' },
    { name: 'SQL NULL', stored: null, reason: 'not-recorded' },
    { name: 'malformed JSON', stored: '{', reason: 'invalid-or-unsupported' },
    { name: 'incomplete object', stored: { root: '/untrusted' }, reason: 'invalid-or-unsupported' },
    { name: 'unsupported extension', stored: { ...cappedDetails, futureField: true }, reason: 'invalid-or-unsupported' },
    { name: 'different file', stored: { ...cappedDetails, filePath: 'other.test.ts' }, reason: 'row-mismatch' },
    { name: 'different group', stored: { ...cappedDetails, runGroupId: 'other-run' }, reason: 'row-mismatch' },
  ])('explains execution-details availability for $name without granting identity', async ({ stored, reason }) => {
    const row = await readDetails(stored);
    expect(row).toMatchObject({ root: null, executionDetails: null, executionDetailsUnavailableReason: reason });
    expect(shapeTestingRuns({ runs: [row] }, 'trimmed')).toMatchObject({
      runs: [{ executionDetailsUnavailableReason: reason }],
    });
  });

  it.each([false, true])('retains capped integration counts and root with serialized=%s', async serialized => {
    const row = await readDetails(serialized ? JSON.stringify(cappedDetails) : cappedDetails);
    expect(row).toMatchObject({ root: cappedDetails.root, executionDetails: cappedDetails });
    expect(row).not.toHaveProperty('executionDetailsUnavailableReason');
  });

  it.each([false, true])('recovers reporter timing and unconfigured runtime capture with serialized=%s', async serialized => {
    // EI-27285944879352300: a real passing reporter row was withheld by an
    // older reader that did not recognize this combination of optional fields.
    const details = {
      ...cappedDetails,
      testTimingRuntimeIdentity: 'node:25.9.0 linux/x64 vitest:4.1.8',
      runtimeEnvironmentBeforeCaptureStatus: 'not-configured',
      runtimeEnvironmentAfterCaptureStatus: 'not-configured',
    };
    const row = await readDetails(serialized ? JSON.stringify(details) : details);

    expect(row).toMatchObject({ root: details.root, executionDetails: details });
    expect(row).not.toHaveProperty('executionDetailsUnavailableReason');
    expect(row?.executionDetails).not.toHaveProperty('runtimeEnvironmentBefore');
    expect(row?.executionDetails).not.toHaveProperty('runtimeEnvironmentAfter');
    expect(shapeTestingRuns({ runs: [row] }, 'trimmed')).toMatchObject({
      runs: [{ root: details.root, executionDetails: { passed: 80, failed: 0, skipped: 0 } }],
    });
  });

  it('preserves receipt roots with measured passing cases, including an unscoped receipt', async () => {
    let selectedSql = '';
    const row = {
      execution_details: {
        schemaVersion: 1,
        root: '/checkouts/papercusp',
        filePath: 'packages/example/same.test.ts',
        runGroupId: null,
        workspaceId: 'workspace-a',
        harnessSlug: 'harness-a',
        testNamePattern: null,
        passed: 65,
        failed: 0,
        skipped: 0,
        collectionFailed: false,
        passedCaseTitles: ['suite > passed case'],
        passedCaseTitlesTruncated: true,
        mutationPhase: null,
        commitSha: null,
        worktreeDirty: false,
      },
      file_path: 'packages/example/same.test.ts', status: 'pass', framework: 'vitest',
      started_at: '2026-09-08T09:43:05Z', finished_at: '2026-09-08T09:43:06Z',
      duration_ms: '1000', output_tail: null, run_group_id: null, source: 'local',
      branch: 'staging', commit_sha: 'abc123', loop_lag_p95_ms: null, rss_mb: null,
      worktree_dirty: false, is_scratch_config: false, total: '2',
    };
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (!call.strings.some((part) => part.includes('WITH filtered'))) return call;
      selectedSql = renderSqlFragment(call);
      return Promise.resolve([
        { ...row, id: '17692431', workspace_id: 'workspace-a', harness_slug: 'harness-a' },
        { ...row, id: '17692432', workspace_id: null, harness_slug: null, execution_details: null },
      ]);
    });

    const result = await runsTool.handler({ filePath: 'same.test.ts', limit: 2 } as never, {} as never) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(data).toMatchObject({
      count: 2,
      runs: [
        { id: 17692431, workspaceId: 'workspace-a', harnessSlug: 'harness-a', root: '/checkouts/papercusp',
          executionDetails: row.execution_details },
        { id: 17692432, workspaceId: null, harnessSlug: null, root: null, executionDetails: null },
      ],
    });
    // Both rows have the same path/time/commit. Those labels cannot replace
    // the ledger identity, and a missing scope must not inherit the caller's.
    expect(selectedSql).toContain('SELECT p.id::text, p.workspace_id, p.harness_slug, p.execution_details');
  });

  it('returns null root for malformed execution details instead of inventing checkout identity', async () => {
    let selectedSql = '';
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (!call.strings.some((part) => part.includes('WITH filtered'))) return call;
      selectedSql = renderSqlFragment(call);
      return Promise.resolve([{
        id: '17692433', workspace_id: null, harness_slug: null,
        execution_details: { schemaVersion: 1, root: '/untrusted', filePath: 'same.test.ts' },
        file_path: 'same.test.ts', status: 'pass', framework: 'vitest',
        started_at: '2026-09-08T09:43:05Z', finished_at: '2026-09-08T09:43:06Z',
        duration_ms: '1000', output_tail: null, run_group_id: null, source: 'local',
        branch: 'staging', commit_sha: 'abc123', loop_lag_p95_ms: null, rss_mb: null,
        worktree_dirty: false, is_scratch_config: false, total: '1',
      }]);
    });

    const result = await runsTool.handler({ filePath: 'same.test.ts', limit: 1 } as never, {} as never) as {
      data?: { runs?: Array<{ root: string | null }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(data.runs).toEqual([expect.objectContaining({ root: null, executionDetails: null })]);
    expect(selectedSql).toContain('p.execution_details');
  });

  it.each([
    { filePath: 'same.test.ts', runGroupId: null, matches: true },
    { filePath: 'other.test.ts', runGroupId: null, matches: false },
    { filePath: 'same.test.ts', runGroupId: 'other-run', matches: false },
  ])('binds JSONB measured cases to their exact file and group: $filePath/$runGroupId', async (scenario) => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (!call.strings.some((part) => part.includes('WITH filtered'))) return call;
      return Promise.resolve([{
        id: '17692434', workspace_id: 'workspace-a', harness_slug: 'harness-a',
        execution_details: JSON.stringify({
          schemaVersion: 1,
          root: '/checkouts/papercusp',
          filePath: scenario.filePath,
          runGroupId: scenario.runGroupId,
          workspaceId: 'workspace-a',
          harnessSlug: 'harness-a',
          testNamePattern: null,
          passed: 1,
          failed: 0,
          skipped: 0,
          collectionFailed: false,
          passedCaseTitles: ['suite > passed case'],
          mutationPhase: null,
          commitSha: null,
          worktreeDirty: false,
        }),
        file_path: 'same.test.ts', status: 'pass', framework: 'vitest',
        started_at: '2026-09-08T09:43:05Z', finished_at: '2026-09-08T09:43:06Z',
        duration_ms: '1000', output_tail: null, run_group_id: null, source: 'local',
        branch: 'staging', commit_sha: 'abc123', loop_lag_p95_ms: null, rss_mb: null,
        worktree_dirty: false, is_scratch_config: false, total: '1',
      }]);
    });

    const result = await runsTool.handler({ filePath: 'same.test.ts', limit: 1 } as never, {} as never) as {
      data?: { runs?: Array<{ root: string | null }> };
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(data.runs).toMatchObject([scenario.matches
      ? { root: '/checkouts/papercusp', executionDetails: { passed: 1, failed: 0, skipped: 0,
        collectionFailed: false, passedCaseTitles: ['suite > passed case'], testNamePattern: null } }
      : { root: null, executionDetails: null }]);
  });
});

describe('testing:runs exact ID selection', () => {
  const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];
  const exactIds = [17692431, 17692432];

  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) {
        return Promise.resolve([
          {
            id: String(exactIds[0]),
            workspace_id: null,
            harness_slug: null,
            file_path: 'packages/example/retry.test.ts',
            status: 'fail',
            framework: 'vitest',
            started_at: '2026-09-08T09:43:05Z',
            finished_at: '2026-09-08T09:43:06Z',
            duration_ms: '1000',
            output_tail: 'first attempt',
            run_group_id: 'run-a',
            source: 'ci',
            branch: 'staging',
            commit_sha: 'abc123',
            loop_lag_p95_ms: null,
            rss_mb: null,
            worktree_dirty: false,
            is_scratch_config: false,
            total: '2',
          },
          {
            id: String(exactIds[1]),
            workspace_id: null,
            harness_slug: null,
            file_path: 'packages/example/retry.test.ts',
            status: 'pass',
            framework: 'vitest',
            started_at: '2026-09-08T09:44:05Z',
            finished_at: '2026-09-08T09:44:06Z',
            duration_ms: '1000',
            output_tail: null,
            run_group_id: 'run-b',
            source: 'ci',
            branch: 'staging',
            commit_sha: 'abc123',
            loop_lag_p95_ms: null,
            rss_mb: null,
            worktree_dirty: false,
            is_scratch_config: false,
            total: '2',
          },
        ]);
      }
      return call;
    });
  });

  it('accepts bounded exact IDs and keeps every selected receipt by default', async () => {
    expect(runsTool.args.safeParse({ testRunIds: exactIds }).success).toBe(true);
    expect(runsTool.args.safeParse({ testRunIds: [] }).success).toBe(false);
    expect(runsTool.args.safeParse({ testRunIds: [0] }).success).toBe(false);
    expect(runsTool.args.safeParse({ testRunIds: Array.from({ length: 101 }, (_, i) => i + 1) }).success).toBe(false);

    const result = (await runsTool.handler({ testRunIds: exactIds } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const queryText = renderSqlFragment(sqlCalls.find((call) => call.strings.some((part) => part.includes('WITH filtered'))) ?? { strings: [], values: [] });

    expect(queryText).toContain('id = ANY(');
    expect(queryText).toContain('SELECT * FROM filtered');
    expect(queryText).not.toContain('SELECT DISTINCT ON (file_path)');
    expect(JSON.stringify(sqlCalls)).toContain(JSON.stringify(exactIds));
    expect(sqlCalls[sqlCalls.length - 1]?.values).toContain(2);
    expect(data).toMatchObject({
      count: 2,
      total: 2,
      latestPerFile: false,
      runs: [
        { id: exactIds[0], filePath: 'packages/example/retry.test.ts', status: 'fail' },
        { id: exactIds[1], filePath: 'packages/example/retry.test.ts', status: 'pass' },
      ],
    });
  });

  it('allows an explicit latest-per-file collapse for selected IDs', async () => {
    await runsTool.handler({ testRunIds: exactIds, latestPerFile: true } as never, {} as never);
    const queryText = renderSqlFragment(sqlCalls.find((call) => call.strings.some((part) => part.includes('WITH filtered'))) ?? { strings: [], values: [] });
    expect(queryText).toContain('SELECT DISTINCT ON (file_path)');
  });
});

describe('testing:runs empty results', () => {
  beforeEach(() => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      return call;
    });
  });

  it('marks an empty row list as not recorded instead of a clean result', async () => {
    const result = (await runsTool.handler({ filePath: 'missing.test.ts', sinceHours: 1 } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');

    expect(data).toMatchObject({
      count: 0,
      total: 0,
      truncatedByLimit: false,
      latestPerFile: false,
      runs: [],
      notRecorded: true,
      reason: 'no_runs_recorded',
    });
  });

  it('marks an empty rollup as not recorded instead of a zero-failure verdict', async () => {
    const result = (await runsTool.handler({ commitSha: 'missing', rollup: 'commit' } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');

    expect(data).toMatchObject({
      rollup: 'commit',
      source: 'ci',
      latestPerFile: true,
      count: 0,
      total: 0,
      truncatedByLimit: false,
      groups: [],
      notRecorded: true,
      reason: 'no_runs_recorded',
    });
  });
});

describe('testing:runs payload-tier shape', () => {
  const dbRows = Array.from({ length: 19 }, (_, i) => ({
    id: String(17692431 + i),
    workspace_id: i % 2 === 0 ? 'workspace-a' : null,
    harness_slug: i % 2 === 0 ? 'papercusp' : null,
    file_path: `packages/example/test-${i}.test.ts`,
    status: 'error',
    framework: 'vitest',
    started_at: `2026-09-08T09:43:${String(i).padStart(2, '0')}Z`,
    finished_at: `2026-09-08T09:44:${String(i).padStart(2, '0')}Z`,
    duration_ms: '1000',
    output_tail: `failure-${i} ${'x'.repeat(800)}`,
    run_group_id: 'gate-run',
    source: 'ci',
    branch: 'staging',
    commit_sha: 'abc123',
    loop_lag_p95_ms: null,
    rss_mb: null,
    worktree_dirty: false,
    is_scratch_config: false,
    total: '19',
  }));

  const dispatchContext = (contextTier: 'trimmed' | 'standard'): UnifiedToolContext => ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId: 'default',
    runId: `testing-runs-shape-${contextTier}`,
    isSuperuser: true,
    uiClientId: 'testing-runs-shape-test',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
    contextTier,
    tx: {},
  });

  beforeEach(() => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve(dbRows);
      return call;
    });
  });

  it.each(['trimmed', 'standard'] as const)('keeps schema-required row identity in %s projected output', async (contextTier) => {
    const raw = (await runsTool.handler({ limit: 19 } as never, {} as never)) as { data: unknown };
    expect(JSON.stringify(raw).length).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);

    const projected = lookupByMcpName('testing:runs');
    expect(projected).toBeDefined();

    const dispatched = await dispatchProjectedTool(
      projected!,
      'testing:runs',
      { limit: 19 },
      dispatchContext(contextTier),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      count: number;
      total: number;
      truncatedByLimit: boolean;
      runs: Array<{ id: number; workspaceId: string | null; harnessSlug: string | null; outputTail?: string }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.count).toBe(19);
    expect(payload?.total).toBe(19);
    expect(payload?.runs.length).toBeGreaterThan(0);
    expect(payload?.runs.every((row) => Number.isInteger(row.id))).toBe(true);
    expect(payload?.runs.every((row) => 'workspaceId' in row && 'harnessSlug' in row)).toBe(true);
    expect(payload?.runs[0]).toMatchObject({ id: 17692431, workspaceId: 'workspace-a', harnessSlug: 'papercusp' });
  });

  it('preserves every exact receipt row when case details exceed the inline tier budget', async () => {
    const exactIds = [21207957, 21208029];
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      const query = call.strings.join(' ');
      if (query.includes('WITH filtered')) return Promise.resolve([
        { ...dbRows[0], id: String(exactIds[0]), status: 'pass', output_tail: null, total: '2' },
        { ...dbRows[1], id: String(exactIds[1]), status: 'pass', output_tail: null, total: '2' },
      ]);
      if (query.includes('FROM harness_shared.test_case_runs')) return Promise.resolve(exactIds.map((id, index) => ({
        test_run_id: String(id),
        case_key: `suite > case ${index + 1}`,
        occurrence: 1,
        status: 'pass',
        duration_ms: 3,
        error_tail: `${index}: ${'case detail '.repeat(180)}`,
      })));
      return Promise.resolve([]);
    });

    const raw = await runsTool.handler({ testRunIds: exactIds, cases: true } as never, {} as never) as { data: unknown };
    expect(JSON.stringify(raw.data).length).toBeGreaterThan(4_800);

    const projected = lookupByMcpName('testing:runs');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'testing:runs',
      { testRunIds: exactIds, cases: true },
      dispatchContext('trimmed'),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      count: number;
      total: number;
      runs: Array<{ id: number; cases: Array<{ caseKey: string; errorTail: string | null }> }>;
      payloadBounded?: { droppedRuns?: number };
    }>(dispatched.result!);
    expect(payload?.count).toBe(2);
    expect(payload?.total).toBe(2);
    expect(payload?.runs.map((row) => row.id)).toEqual(exactIds);
    expect(payload?.runs.every((row) => row.cases.length === 1 && row.cases[0]?.errorTail?.length! > 1_000)).toBe(true);
    expect(payload?.payloadBounded?.droppedRuns ?? 0).toBe(0);
  });

  it('bounds verbose saved case details without clipping identities or changing measured counts', () => {
    const executionDetails = {
      schemaVersion: 1, root: '/tmp', filePath: 'measured.test.ts', runGroupId: 'measured',
      workspaceId: null, harnessSlug: null, passed: 7, failed: 0, skipped: 118,
      collectionFailed: false, testNamePattern: 'selected assertion',
      mutationPhase: null, commitSha: null, worktreeDirty: false,
      passedCaseTitles: ['exact short case', 'x'.repeat(2_048)],
      passedCaseTitlesTruncated: true,
    };
    const shaped = shapeTestingRuns({ runs: [{ id: 42, executionDetails }] }, 'trimmed') as {
      runs: Array<{ executionDetails: Record<string, unknown>; executionDetailsBounded: unknown }>;
    };
    expect(shaped.runs[0]?.executionDetails).toMatchObject({ passed: 7, failed: 0, skipped: 118,
      collectionFailed: false, testNamePattern: 'selected assertion', passedCaseTitles: ['exact short case'] });
    expect(shaped.runs[0]?.executionDetails.passedCaseTitlesTruncated).toBe(true);
    expect(shaped.runs[0]?.executionDetailsBounded).toMatchObject({ passedCaseTitlesOmitted: 1,
      failedCaseTitlesOmitted: 0, fieldsOmitted: expect.arrayContaining(['root', 'filePath']) });
    expect(JSON.stringify(shaped).length).toBeLessThan(1_400);
    expect(executionDetails.passedCaseTitles).toHaveLength(2);
  });

  it('publishes testLayer for judges and preserves it when execution details are bounded', () => {
    expect(runsTool.agentRoles).toContain('judge');
    const runShape = (runsTool.result as any).shape.runs.unwrap().element.shape;
    expect(Object.keys(runShape)).toEqual(expect.arrayContaining([
      'executionDetails', 'executionDetailsUnavailableReason',
    ]));
    const detailsShape = runShape.executionDetails.unwrap().shape;
    expect(Object.keys(detailsShape)).toContain('testLayer');

    const executionDetails = {
      schemaVersion: 1,
      root: '/tmp',
      filePath: 'measured.test.ts',
      runGroupId: 'measured',
      workspaceId: null,
      harnessSlug: null,
      testNamePattern: null,
      testLayer: 'integration',
      passed: 7,
      failed: 0,
      skipped: 2,
      collectionFailed: false,
      passedCaseTitles: ['x'.repeat(2_048)],
    };
    const shaped = shapeTestingRuns({ runs: [{ id: 45, executionDetails }] }, 'trimmed') as {
      runs: Array<{ executionDetails: Record<string, unknown>; executionDetailsBounded: { fieldsOmitted: string[] } }>;
    };
    expect(shaped.runs[0]?.executionDetails).toMatchObject({
      testLayer: 'integration', passed: 7, failed: 0, skipped: 2,
    });
    expect(shaped.runs[0]?.executionDetailsBounded.fieldsOmitted).not.toContain('testLayer');
  });

  // Plan mutation-probe-evidence-value-2026-10-11 R-1: the mutation descriptor is what
  // makes a probe row auditable, so a bounded row keeps it inline instead of listing it
  // in fieldsOmitted, and clips only the mutant diff body (flagged).
  it.each([
    ['baseline', 1, 0], ['mutant', 1, 0], ['mutant', 0, 1], ['consumption-control', 0, 1],
  ])('keeps execution_details.mutation inline on a bounded %s row (%i passed/%i failed) and clips only the mutant diff', (leg, passed, failed) => {
    const mutation = {
      schemaVersion: 1,
      probeInvocationId: 'probe-7f3c',
      leg,
      mode: 'copy-out',
      subjectPath: 'scripts/example-guard.sh',
      mutateExpression: 's/^guard_on=1$/guard_on=0/',
      againstCommit: null,
      subjectBeforeSha256: 'a'.repeat(64),
      subjectAfterSha256: 'b'.repeat(64),
      mutantDiff: `--- a\n+++ b\n${'-guard_on=1\n+guard_on=0\n'.repeat(100)}`,
      mutantDiffTruncated: false,
      testCommandSha256: 'd'.repeat(64),
      testFileSha256: 'c'.repeat(64),
    };
    const executionDetails = {
      schemaVersion: 1, root: '/tmp', filePath: 'measured.test.ts', runGroupId: 'measured',
      workspaceId: null, harnessSlug: null, passed, failed, skipped: 0,
      collectionFailed: false, testNamePattern: null, mutationPhase: leg, commitSha: null,
      worktreeDirty: false, failedCaseTitles: failed ? ['guard refuses when disabled'] : [],
      passedCaseTitles: passed ? ['guard accepts the surviving source'] : [], mutation,
    };
    expect(JSON.stringify(executionDetails).length).toBeGreaterThan(1_400);
    const shaped = shapeTestingRuns({ runs: [{ id: 43, executionDetails }] }, 'trimmed') as {
      runs: Array<{ executionDetails: Record<string, unknown>; executionDetailsBounded: { fieldsOmitted: string[] } }>;
    };
    const row = shaped.runs[0]!;
    const inline = row.executionDetails.mutation as Record<string, unknown>;
    const { mutantDiff } = mutation;
    expect(inline).toMatchObject({ ...mutation, mutantDiff: mutantDiff.slice(0, MUTANT_DIFF_INLINE_CHARS),
      mutantDiffTruncated: true });
    expect(inline.mutantDiff).toBe(mutantDiff.slice(0, MUTANT_DIFF_INLINE_CHARS));
    expect(inline.mutantDiffTruncated).toBe(true);
    expect(row.executionDetailsBounded.fieldsOmitted).not.toContain('mutation');
    // A diff within budget is carried verbatim with no truncation flag.
    const small = shapeTestingRuns({ runs: [{ id: 44, executionDetails: { ...executionDetails,
      passedCaseTitles: ['x'.repeat(2_048)], mutation: { ...mutation, mutantDiff: '-a\n+b\n' } } }] }, 'trimmed') as {
      runs: Array<{ executionDetails: Record<string, unknown> }>;
    };
    expect(small.runs[0]!.executionDetails.mutation).toEqual({ ...mutation, mutantDiff: '-a\n+b\n' });
  });

  it('preserves the required fields and announces row/tail bounds in the shaper output', () => {
    const shaped = shapeTestingRuns(
      {
        count: 19,
        total: 19,
        truncatedByLimit: false,
        latestPerFile: true,
        runs: dbRows.map((row) => ({
          id: Number(row.id),
          workspaceId: row.workspace_id,
          harnessSlug: row.harness_slug,
          filePath: row.file_path,
          status: row.status,
          framework: row.framework,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          durationMs: 1000,
          commitSha: row.commit_sha,
          runGroupId: row.run_group_id,
          source: row.source,
          branch: row.branch,
          outputTail: row.output_tail,
          loopLagP95Ms: null,
          rssMb: null,
          saturationSuspect: null,
          worktreeDirty: false,
          isScratchConfig: false,
        })),
      },
      'trimmed',
    ) as Record<string, unknown>;
    const runs = shaped.runs as Array<Record<string, unknown>>;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThan(19);
    expect(runs[0]).toMatchObject({ id: 17692431, workspaceId: 'workspace-a', harnessSlug: 'papercusp' });
    expect(runs[0]).toHaveProperty('outputTailTruncated', true);
    expect(shaped.payloadBounded).toMatchObject({ totalRuns: 19, showingRuns: runs.length });
  });
});

/**
 * EI-21669113109175663 / EI-21675813584516519 (`harness` rejected while its twin
 * `workspace` was accepted) and EI-21677405671312383 (the 0.1h floor refused a
 * legitimately tight poll).
 */
describe('testing:runs tenant scoping and window bounds', () => {
  const sqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  beforeEach(() => {
    sqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      // The row-listing path maps over its result; the WHERE fragment is consumed as
      // a nested fragment. Only the former is awaited as rows.
      if (call.strings.some((part) => part.includes('FROM harness_shared.test_runs'))) {
        return Promise.resolve([]);
      }
      return call;
    });
  });

  function whereFragment(): string {
    const call = sqlCalls.find((c) => c.strings.some((part) => part.includes('file_path')));
    return renderSqlFragment(call);
  }

  it('applies a harness_slug predicate, symmetric with workspace_id', async () => {
    await runsTool.handler({ harness: 'papercusp', limit: 1 } as never, {} as never);
    const where = whereFragment();
    expect(where).toContain('harness_slug');
    const call = sqlCalls.find((c) => c.strings.some((part) => part.includes('file_path')));
    expect(JSON.stringify(call?.values)).toContain('papercusp');
  });

  it('leaves harness_slug unconstrained when no harness is named — CI rows carry NULL', async () => {
    // The trap this tool exists to avoid (EI-19324633485547042): scoping by a tenant
    // column silently excludes every CI/gate row and reads as a clean "no failures".
    // Declaring `harness` must not make that the default.
    await runsTool.handler({ limit: 1 } as never, {} as never);
    const call = sqlCalls.find((c) => c.strings.some((part) => part.includes('file_path')));
    expect(call?.values).not.toContain('papercusp');
    expect(whereFragment()).toContain("source <> 'mutation-probe'");
  });

  it('an exact testRunIds lookup does NOT exclude mutation-probe rows — a receipt read is not a browse', async () => {
    // Measured 2026-09-22 (scorecard EI-23921807742712130): test_runs 18917525 /
    // 18917527 were written by scripts/mutation-probe.sh and are plainly present
    // in harness_shared.test_runs, but `testing:runs { testRunIds }` returned
    // total 0 because the browse-time exclusion applied to an exact-ID lookup.
    // An independent grading auditor read that zero as "the card cites test runs
    // that do not exist" and failed the card's re-runnable-evidence criterion —
    // a false ABSENCE, the failure class this repo documents repeatedly. The
    // exclusion still guards browsing and rollups, where a deliberately-red
    // probe row really would contaminate "what is failing".
    await runsTool.handler({ testRunIds: [18917525, 18917527] } as never, {} as never);
    const where = whereFragment();
    expect(where).not.toContain("source <> 'mutation-probe'");
    expect(where).toContain('id = ANY');
  });

  it('reports mutation-probe rows hidden by the default browse filter instead of a false not-recorded result', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      sqlCalls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      if (call.strings.some((part) => part.includes('omitted_by_source_filter'))) {
        return Promise.resolve([{ omitted_by_source_filter: '2' }]);
      }
      return call;
    });

    const result = (await runsTool.handler({ filePath: 'some/file.test.ts', sinceHours: 24 } as never, {} as never)) as {
      data?: Record<string, unknown>;
      content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    const countCall = sqlCalls.find((call) => call.strings.some((part) => part.includes('omitted_by_source_filter')));

    // The ordinary row-listing exclusion is still active, but the caller now
    // sees that this "empty" filtered list omitted two matching receipt rows.
    expect(whereFragment()).toContain("source <> 'mutation-probe'");
    expect(renderSqlFragment(countCall)).toContain('file_path ILIKE');
    expect(renderSqlFragment(countCall)).toContain('started_at >=');
    expect(renderSqlFragment(countCall)).toContain("source <> 'mutation-probe'");
    expect(data).toMatchObject({
      count: 0,
      total: 0,
      effectiveSourceFilter: "source <> 'mutation-probe' (default row-list exclusion)",
      omittedBySourceFilter: 2,
    });
    expect(data).not.toHaveProperty('notRecorded');
    expect(data).not.toHaveProperty('reason');
  });

  it('CONTROL: an explicit source filter still wins over the exact-ID path', async () => {
    await runsTool.handler({ testRunIds: [18917525], source: 'ci' } as never, {} as never);
    const call = sqlCalls.find((c) => c.strings.some((part) => part.includes('file_path')));
    expect(JSON.stringify(call?.values)).toContain('ci');
  });

  it('accepts a sub-0.1-hour window and still applies the time predicate', () => {
    const parsed = runsTool.args.safeParse({ sinceHours: 0.05 });
    expect(parsed.success).toBe(true);
  });

  it('CONTROL: still refuses a zero window, which would silently drop the predicate', () => {
    // 0 is falsy: admitting it would make `sinceHours != null` compute a bound of
    // "now" while an earlier `args.sinceHours ?` guard would have dropped the filter
    // entirely and returned the whole ledger. Refusing it keeps the two consistent.
    expect(runsTool.args.safeParse({ sinceHours: 0 }).success).toBe(false);
    expect(runsTool.args.safeParse({ sinceHours: -1 }).success).toBe(false);
  });

  it('CONTROL: the old 0.1 floor is genuinely gone, not merely unreachable', () => {
    expect(runsTool.args.safeParse({ sinceHours: 0.099 }).success).toBe(true);
    // and the upper bound is still enforced
    expect(runsTool.args.safeParse({ sinceHours: 2161 }).success).toBe(false);
  });
});

describe('testing:runs filePath matching', () => {
  const filePathSqlCalls: Array<{ strings: string[]; values: unknown[] }> = [];

  it('uses the escaped literal substring pattern and declares its LIKE escape character', async () => {
    filePathSqlCalls.length = 0;
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      filePathSqlCalls.push(call);
      // The handler only needs an empty result for this SQL-construction test;
      // the nested `where` fragment remains available for inspection below.
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve([]);
      return call;
    });

    await runsTool.handler({ filePath: 'sync/hyperbee/__tests__', limit: 1 } as never, {} as never);

    const whereCall = filePathSqlCalls.find((call) => call.strings.some((part) => part.includes('file_path ILIKE')));
    expect(whereCall).toBeDefined();
    expect(whereCall?.values).toContain('%sync/hyperbee/\\_\\_tests\\_\\_%');
    expect(renderSqlFragment({ strings: whereCall?.strings ?? [], args: whereCall?.values ?? [] })).toContain(
      "file_path ILIKE ",
    );
    expect(renderSqlFragment({ strings: whereCall?.strings ?? [], args: whereCall?.values ?? [] })).toContain(
      "ESCAPE '\\'",
    );
  });
});

describe('isSaturationSuspect', () => {
  it('returns UNKNOWN for a NULL lag sample', () => {
    // NULL means no trustworthy host signal was recorded. It is not evidence
    // of saturation, but it is also not evidence that the host was calm.
    expect(isSaturationSuspect(null)).toBeNull();
  });

  it('flags a sample at or past the critical band', () => {
    expect(isSaturationSuspect(CRITICAL_P95_MS)).toBe(true);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 500)).toBe(true);
  });

  it('leaves a calm sample unflagged', () => {
    // Real observed values on this box sit around 20-25ms.
    expect(isSaturationSuspect(25)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 1)).toBe(false);
  });

  it('classifies against the monitor’s own tunable, not a hardcoded 600', () => {
    // Guards the drift this import exists to prevent: if the monitor's band
    // moves (PAPERCUSP_LOOP_CRITICAL_MS), the ledger reader must move with it.
    // A control value derived from the constant cannot pass against a
    // hardcoded threshold unless the two agree.
    expect(CRITICAL_P95_MS).toBeGreaterThan(0);
    expect(isSaturationSuspect(CRITICAL_P95_MS - 0.5)).toBe(false);
    expect(isSaturationSuspect(CRITICAL_P95_MS + 0.5)).toBe(true);
  });
});

// WI-6554700010018414 — a foreground run killed at its scope RuntimeMaxSec after a
// host-shutdown handoff writes ZERO rows; the empty exact-runGroup read must say so.
describe('testing:runs foreground verdict on an empty exact runGroup', () => {
  const verdict = (v: 'running' | 'recorded' | 'lost') => ({
    runId: 'run-x', taskId: 'task-x', taskState: v === 'running' ? 'running' : 'ended_unobserved',
    startedAt: 1, endedAt: v === 'running' ? null : 2, exitCode: null, ledgerRows: v === 'recorded' ? 3 : 0, verdict: v,
  });

  beforeEach(() => {
    foregroundVerdictMock.mockReset();
    foregroundVerdictMock.mockResolvedValue(null);
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      return /^\s*(SELECT|WITH)\b/i.test(call.strings.join('')) ? Promise.resolve([]) : call;
    });
  });

  it('labels a lost run as never reporting, so the empty set is not read as pending', async () => {
    const out = await foregroundRunMetadata('run-x', async () => verdict('lost'));
    expect(out).toMatchObject({ foregroundRun: { verdict: 'lost', taskId: 'task-x' } });
    expect((out as { foregroundRunHint?: string }).foregroundRunHint).toContain('NOTHING was measured');
  });

  it('routes a still-running run to testing:run-status instead of a re-run', async () => {
    const out = await foregroundRunMetadata('run-x', async () => verdict('running'));
    expect((out as { foregroundRunHint?: string }).foregroundRunHint).toContain('testing:run-status');
  });

  it('adds no hint for a recorded run and nothing for a non-foreground group', async () => {
    expect(await foregroundRunMetadata('run-x', async () => verdict('recorded'))).toEqual({
      foregroundRun: verdict('recorded'),
    });
    expect(await foregroundRunMetadata('run-x', async () => null)).toEqual({});
  });

  it('reports an unreadable task ledger instead of guessing a verdict', async () => {
    const out = await foregroundRunMetadata('run-x', async () => { throw new Error('ledger down'); });
    expect(out).toEqual({ foregroundRunUnavailable: true });
  });

  it('attaches the verdict to a zero-row exact runGroup read through the handler', async () => {
    foregroundVerdictMock.mockResolvedValue(verdict('lost'));
    const result = (await runsTool.handler({ runGroup: 'run-x' } as never, {} as never)) as {
      data?: Record<string, unknown>; content?: Array<{ text: string }>;
    };
    const data = result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(foregroundVerdictMock).toHaveBeenCalledWith('run-x');
    expect(data).toMatchObject({ count: 0, notRecorded: true, foregroundRun: { verdict: 'lost' } });
  });

  it('does not consult the task ledger for an exact testRunIds receipt read', async () => {
    await runsTool.handler({ runGroup: 'run-x', testRunIds: [1] } as never, {} as never);
    expect(foregroundVerdictMock).not.toHaveBeenCalled();
  });
});

describe('testing:runs query diagnostics', () => {
  it('publishes pending and completed SQL stages on invocation metadata', async () => {
    let resolveFirstQuery!: (rows: unknown[]) => void;
    const firstQuery = new Promise<unknown[]>((resolve) => {
      resolveFirstQuery = resolve;
    });
    let queryCount = 0;
    sqlMock.mockImplementation(() => {
      queryCount++;
      return queryCount === 1 ? firstQuery : Promise.resolve([]);
    });
    const metadataSnapshots: Array<Record<string, unknown>> = [];

    const pendingHandler = runsTool.handler({} as never, {
      metadata: (metadata: Record<string, unknown>) => metadataSnapshots.push(metadata),
    } as never) as Promise<unknown>;

    const diagnostics = () => metadataSnapshots
      .map((metadata) => metadata.testingRunsDiagnostics as {
        requestId: string;
        stages: Array<{ stage: string; outcome: string }>;
      } | undefined)
      .filter((value): value is { requestId: string; stages: Array<{ stage: string; outcome: string }> } => Boolean(value));

    expect(diagnostics().at(-1)).toMatchObject({
      requestId: expect.any(String),
      stages: [{ stage: 'testing-runs-latest-rows', outcome: 'pending' }],
    });

    resolveFirstQuery([]);
    await pendingHandler;

    expect(diagnostics().at(-1)).toMatchObject({
      requestId: expect.any(String),
      stages: [
        { stage: 'testing-runs-latest-rows', outcome: 'fulfilled' },
        { stage: 'testing-runs-source-omissions', outcome: 'fulfilled' },
      ],
    });
  });
});
