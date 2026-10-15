import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRow {
  id: string;
  title: string;
  summary: string;
  state: string;
  harness_slug: string;
  has_embedding: boolean;
}

const mocks = vi.hoisted(() => {
  let rows: FakeRow[] = [];
  const sql = vi.fn(async (..._args: unknown[]) => rows);
  return {
    sql,
    setRows: (next: FakeRow[]) => { rows = next; },
  };
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: mocks.sql }),
}));
vi.mock('../../issues-engineer', () => ({
  issuesScopeWorkspace: () => 'issues-workspace',
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'active-workspace',
}));
vi.mock('../../work-item-blocking', () => ({
  ALL_TERMINAL_STATUSES: ['done', 'dropped'],
}));

import { __queryRecentOpenItemsForTest } from './recent-lexical-dupe-guard';

const sampleRows = (): FakeRow[] => [
  {
    id: 'WI-UNEMBEDDED',
    title: 'fresh candidate',
    summary: 'not indexed yet',
    state: 'open',
    harness_slug: 'papercusp',
    has_embedding: false,
  },
  {
    id: 'WI-EMBEDDED',
    title: 'indexed candidate',
    summary: '',
    state: 'open',
    harness_slug: 'papercusp',
    has_embedding: true,
  },
];

beforeEach(() => {
  mocks.sql.mockClear();
  mocks.setRows(sampleRows());
});

describe('recent-lexical-dupe-guard bounded census query', () => {
  it('selects embedding presence and requests one sentinel beyond the 50-row scan cap', async () => {
    const result = await __queryRecentOpenItemsForTest(10, 'papercusp');

    expect(result).toEqual({
      rows: [
        {
          id: 'WI-UNEMBEDDED',
          title: 'fresh candidate',
          summary: 'not indexed yet',
          state: 'open',
          harness: 'papercusp',
          hasEmbedding: false,
        },
        {
          id: 'WI-EMBEDDED',
          title: 'indexed candidate',
          summary: '',
          state: 'open',
          harness: 'papercusp',
          hasEmbedding: true,
        },
      ],
      truncated: false,
    });

    const mainCall = mocks.sql.mock.calls.at(-1);
    const queryText = (mainCall?.[0] as TemplateStringsArray).join('');
    expect(queryText).toMatch(/embedding IS NOT NULL\) AS has_embedding/);
    expect(mainCall?.slice(1)).toContain(51);
  });

  it('keeps only the first 50 rows and marks the census truncated when the sentinel exists', async () => {
    mocks.setRows(
      Array.from({ length: 51 }, (_, index) => ({
        id: `WI-${index + 1}`,
        title: `recent row ${index + 1}`,
        summary: '',
        state: 'open',
        harness_slug: 'papercusp',
        has_embedding: index !== 0,
      })),
    );

    const result = await __queryRecentOpenItemsForTest(10, 'papercusp');

    expect(result.rows).toHaveLength(50);
    expect(result.rows[0].hasEmbedding).toBe(false);
    expect(result.truncated).toBe(true);
  });
});
