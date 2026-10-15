/**
 * harness:get — summary/full projection + featureCounts assembly.
 *
 * Follows the goals/list.test.ts drizzle-mock convention. The handler runs
 * up to two builder queries (the project row, then — full only — the
 * grouped feature counts); the mock serves fixtures from a FIFO queue. The
 * logic under test:
 *   - not found → `{ data: null, degraded: true }`
 *   - detail:'summary' (the default) projects {slug, name, status,
 *     updated_ts} from the camelCase row — and skips the counts query
 *   - detail:'full' spreads the whole row + assembles featureCounts from
 *     the grouped rows, coercing n via Number and DROPPING null statuses
 *   - arg schema: detail defaults to 'summary', rejects unknown values
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let fixtureQueue: unknown[][] = [];
let queriesBuilt = 0;

function makeBuilder() {
  // Each builder serves the next fixture in FIFO order — one builder per
  // `.select()` call, so the project-row query and the counts query get
  // their own fixtures.
  const rows = fixtureQueue.shift() ?? [];
  queriesBuilt += 1;
  const builder: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'limit', 'groupBy']) {
    builder[k] = (..._args: unknown[]) => builder;
  }
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return builder;
}

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: vi.fn(() => ({
    select: (..._args: unknown[]) => makeBuilder(),
  })),
}));

import tool from './get';
import statusTool from './status';

// The handler's declared return is the generic ToolResult union; these tests read the
// degraded-envelope fields, so narrow with a local shape (EI-1834 additions stay typed).
type GetResult = { data: unknown; degraded?: boolean; degradedReasons?: string[] };

// EI-1834: the not-found branch reads the harness registry via ctx.tx (a tagged
// template — `readRegistryProjects`). Tests set `registryProjects` to control what
// the registry returns; the drizzle path (project row) is mocked separately above.
let registryProjects: unknown[] = [];
const CTX = () =>
  ({
    principal: { slug: 'op', workspaceId: 'ws_1' },
    tx: ((_s: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve([{ payload: { projects: registryProjects } }])) as never,
    log: vi.fn(),
  }) as never;

const PROJECT_ROW = {
  slug: 'sheets',
  name: 'Sheets',
  status: 'active',
  updatedTs: 1765432100000,
  repoPath: '/tmp/sheets',
  extra: 'kept-in-full',
};

beforeEach(() => {
  fixtureQueue = [];
  queriesBuilt = 0;
  registryProjects = [];
});

describe('harness:get', () => {
  it('degrades with a project-lookup reason when the slug is in neither projects nor the registry', async () => {
    fixtureQueue = [[]];
    registryProjects = [];
    const res = (await tool.handler({ slug: 'nope', detail: 'summary' } as never, CTX())) as GetResult;
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    const reason = res.degradedReasons?.[0] ?? '';
    expect(reason).toContain('not found');
    expect(reason).toContain('harness registry'); // names BOTH stores so it can't read as "doesn't exist"
    expect(reason).toContain('PROJECT lookup');
  });

  // EI-1834: a registered HIVE has no projects row, so the old generic "not found" was
  // ambiguous and misled a live diagnosis. The reason now affirmatively names the kind.
  it('degrades with a HIVE-disambiguating reason when the slug is a registered hive (not a project)', async () => {
    fixtureQueue = [[]]; // no projects row
    registryProjects = [{ slug: 'papercusp', path: '/x', harness_kind: 'hive' }];
    const res = (await tool.handler({ slug: 'papercusp', detail: 'summary' } as never, CTX())) as GetResult;
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    const reason = res.degradedReasons?.[0] ?? '';
    expect(reason).toContain("harness_kind='hive'");
    expect(reason).toContain('EXISTS');
    expect(reason).toContain('pot:get'); // points at the right inspect tool for a hive
    expect(reason).toContain('Do NOT read this as "no such harness"');
  });

  it('a registered NON-hive, non-project kind also disambiguates (reports its kind)', async () => {
    fixtureQueue = [[]];
    registryProjects = [{ slug: 'depX', path: '/d', harness_kind: 'department' }];
    const res = (await tool.handler({ slug: 'depX', detail: 'summary' } as never, CTX())) as GetResult;
    const reason = res.degradedReasons?.[0] ?? '';
    expect(reason).toContain("harness_kind='department'");
    expect(reason).toContain('non-project harness kinds');
    expect(reason).not.toContain('pot:get'); // hive-specific hint not shown for a non-hive
  });

  it('summary projects {slug, name, status, updated_ts} and skips the counts query', async () => {
    fixtureQueue = [[PROJECT_ROW]];
    const res = (await tool.handler({ slug: 'sheets', detail: 'summary' } as never, CTX())) as GetResult;
    expect(res.data).toEqual({
      slug: 'sheets',
      name: 'Sheets',
      status: 'active',
      updated_ts: 1765432100000,
    });
    expect(JSON.stringify(res.data)).not.toContain('repoPath');
    expect(queriesBuilt).toBe(1);
  });

  it('full spreads the row and assembles featureCounts, dropping null statuses', async () => {
    fixtureQueue = [
      [PROJECT_ROW],
      [
        { status: 'passed', n: 2 },
        { status: 'todo', n: '5' }, // count() can surface as a string — Number-coerced
        { status: null, n: 9 }, // dropped
      ],
    ];
    const res = (await tool.handler({ slug: 'sheets', detail: 'full' } as never, CTX())) as GetResult;
    expect(res.degraded).toBeUndefined();
    expect(res.data).toEqual({
      ...PROJECT_ROW,
      featureCounts: { passed: 2, todo: 5 },
    });
    expect(queriesBuilt).toBe(2);
  });

  it('arg schema: detail defaults to summary and rejects unknown values', () => {
    expect(tool.args.parse({ slug: 's' }).detail).toBe('summary');
    expect(() => tool.args.parse({ slug: 's', detail: 'everything' })).toThrow();
  });

  it('get and status accept an optional per-call workspace for unscoped superusers', () => {
    expect(tool.args.parse({ slug: 's', workspace: 'ws-a' })).toMatchObject({
      slug: 's',
      detail: 'summary',
      workspace: 'ws-a',
    });
    expect(statusTool.args.parse({ slug: 's', workspace: 'ws-a' })).toMatchObject({
      slug: 's',
      workspace: 'ws-a',
    });
  });
});
