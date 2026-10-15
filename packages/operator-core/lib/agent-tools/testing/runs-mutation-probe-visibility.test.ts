/**
 * testing:runs never hides an explicitly requested mutation-probe row
 * (plan mutation-probe-evidence-value-2026-10-11, P-002 / BAR R-2).
 *
 * Two lookups used to answer with an absence for rows that plainly exist:
 * an exact `testRunIds` receipt read, and a `filePath` browse whose only
 * matches were mutation-probe rows. The first must return the row; the second
 * must say how many rows the default exclusion hid AND which argument shows them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import runsTool, { sourceOmissionHint } from './runs';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

function renderSqlFragment(fragment: unknown): string {
  if (!fragment || typeof fragment !== 'object') return '';
  const value = fragment as { strings?: unknown[]; args?: unknown[]; values?: unknown[] };
  if (!Array.isArray(value.strings)) return '';
  const args = value.args ?? value.values ?? [];
  return value.strings.map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`).join('');
}

const PROBE_ROW = {
  id: '18917527',
  workspace_id: 'papercusp-workspace',
  harness_slug: 'papercusp',
  execution_details: null,
  file_path: 'packages/operator-core/lib/some-guard.test.ts',
  status: 'fail',
  framework: 'vitest',
  duration_ms: '120',
  started_at: '2026-10-11T12:00:00.000Z',
  finished_at: '2026-10-11T12:00:01.000Z',
  commit_sha: 'abc1234',
  run_group_id: null,
  source: 'mutation-probe',
  branch: 'staging',
  output_tail: 'AssertionError',
  loop_lag_p95_ms: null,
  rss_mb: null,
  worktree_dirty: false,
  is_scratch_config: false,
  total: '1',
};

type Data = Record<string, unknown> & { runs?: Array<Record<string, unknown>> };

describe('testing:runs mutation-probe visibility (R-2)', () => {
  const calls: Array<{ strings: string[]; values: unknown[] }> = [];
  let listedRows: unknown[] = [];
  let omitted = '0';
  let omittedIds: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    listedRows = [];
    omitted = '0';
    omittedIds = [];
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call = { strings: Array.from(strings), values };
      calls.push(call);
      if (call.strings.some((part) => part.includes('WITH filtered'))) return Promise.resolve(listedRows);
      if (call.strings.some((part) => part.includes('omitted_by_source_filter'))) {
        return Promise.resolve(omittedIds.map((id) => ({ id, omitted_by_source_filter: omitted })));
      }
      return call;
    });
  });

  async function run(args: Record<string, unknown>): Promise<Data> {
    const result = (await runsTool.handler(args as never, {} as never)) as {
      data?: Data;
      content?: Array<{ text: string }>;
    };
    return result.data ?? JSON.parse(result.content?.[0]?.text ?? '{}');
  }

  it('a testRunIds lookup with no source argument returns the mutation-probe row', async () => {
    listedRows = [PROBE_ROW];
    const data = await run({ testRunIds: [18917527] });

    expect(data.count).toBe(1);
    expect(data.runs?.[0]).toMatchObject({ id: 18917527, source: 'mutation-probe' });
    expect(data.effectiveSourceFilter).toBe('none (exact testRunIds receipt lookup)');
    const where = calls.map(renderSqlFragment).join('\n');
    expect(where).not.toContain("source <> 'mutation-probe'");
  });

  it('a filePath lookup that matched only probe rows reports the count and names source "mutation-probe"', async () => {
    omitted = '3';
    omittedIds = ['18917527', '18917525', '18917523'];
    const data = await run({ filePath: 'some-guard.test.ts' });

    expect(data.count).toBe(0);
    expect(data.omittedBySourceFilter).toBe(3);
    expect(data.sourceFilterHint).toContain('source:"mutation-probe"');
    // BAR R-9: the hint names BOTH arguments that return the hidden rows.
    expect(data.sourceFilterHint).toContain('testRunIds');
    expect(data.sourceFilterHint).toContain('3 matching row(s)');
    expect(data.omittedSourceRunIds).toEqual([18917527, 18917525, 18917523]);
    expect(data).not.toHaveProperty('omittedSourceRunIdsTruncated');
    expect(data).not.toHaveProperty('notRecorded');
  });

  it('marks the bounded hidden-ID list when more source-filtered rows exist', async () => {
    omitted = '3';
    omittedIds = ['18917527', '18917525'];
    const data = await run({ filePath: 'some-guard.test.ts' });

    expect(data.omittedBySourceFilter).toBe(3);
    expect(data.omittedSourceRunIds).toEqual([18917527, 18917525]);
    expect(data.omittedSourceRunIdsTruncated).toBe(true);
  });

  it('CONTROL: nothing hidden means no hint', async () => {
    listedRows = [{ ...PROBE_ROW, source: 'local' }];
    const data = await run({ filePath: 'some-guard.test.ts' });

    expect(data.omittedBySourceFilter).toBe(0);
    expect(data).not.toHaveProperty('omittedSourceRunIds');
    expect(data).not.toHaveProperty('sourceFilterHint');
  });

  it('an explicit source names that filter instead of the probe exclusion', () => {
    expect(sourceOmissionHint(2, 'ci')).toContain('source:"ci"');
    expect(sourceOmissionHint(2, 'ci')).not.toContain('mutation-probe');
    expect(sourceOmissionHint(0)).toBeNull();
  });
});
