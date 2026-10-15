/**
 * harness:create { hive } — git-sync routine seeding for a member born at
 * create (git-sync-any-hive-2026-06-12 B-01, the third creator-side producer).
 *
 * A successful create WITH `hive` must call seedGitSyncRoutineForMember
 * (creator side, the freshly-registered entry) and report the outcome as
 * `gitSync`; a create WITHOUT `hive` must not touch the seeder; a seeder that
 * explodes must never fail the create. PG-free: registry/schema/triggers and
 * the seeder module are doMock'd (same pattern as create-dep-gate.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAKE_CTX = () =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    // create.ts resolves the workspace via resolveConcreteWorkspaceId(ctx.workspaceId, …) —
    // the REQUEST's workspace wins over the global active one (workspace-scoping discipline).
    // The seeder expectations below assert THIS value threads through; the mocked
    // activeWorkspaceId('ws-test') is only the ctx-less fallback.
    workspaceId: 'ws-test',
    harnessSlug: 'x',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
  }) as never;

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

const seedCalls: Array<Record<string, unknown>> = [];
let seedImpl: (o: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({
  seeded: true,
  active: true,
  push: false,
  pushReason: 'no_upstream_remote — faked',
  cron: '0 4,14,24,34,44,54 * * * *',
});

beforeEach(() => {
  vi.resetModules();
  seedCalls.length = 0;
  seedImpl = async () => ({
    seeded: true,
    active: true,
    push: false,
    pushReason: 'no_upstream_remote — faked',
    cron: '0 4,14,24,34,44,54 * * * *',
  });
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({
      projects: [{ slug: 'my-hive', path: '/h', harness_kind: 'hive' }],
    }),
    saveHarnessRegistry: async () => {},
    // create.ts routes its registry insert through mutateHarnessRegistry (the
    // atomic write, audit P-006). Run the mutator so the create proceeds.
    mutateHarnessRegistry: async (
      m: (r: { projects: unknown[] }) => { projects: unknown[] },
    ) => m({ projects: [{ slug: 'my-hive', path: '/h', harness_kind: 'hive' }] }),
  }));
  vi.doMock('../../../scaffold-harness-schema', () => ({
    scaffoldHarnessSchema: async () => {},
  }));
  vi.doMock('../../../blueprint/materialize-triggers', () => ({
    materializeBlueprintTriggers: async () => [],
  }));
  // dependencies.* union across extends. Supply the parent's ready providers
  // through the real catalog assembler; this isolated test does not bootstrap
  // the operator's complete tool registry. The dependency gate remains active.
  vi.doMock('../../../cupboard/pack-catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../cupboard/pack-catalog')>();
    const { operatorResolveExtends } = await import('../../../blueprint/installed-blueprints');
    const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
    const resolve = operatorResolveExtends();
    const { blueprint } = loadBlueprintFromFile(resolve('coding')!, resolve);
    return {
      ...actual,
      derivePackCatalog: async () => actual.assemblePackCatalog({
        installed: [],
        projectedTools: [],
        legacyCatalogNames: blueprint.dependencies?.tools ?? [],
        cupboardUnits: [],
        cupboardReachable: true,
      }),
    };
  });
  vi.doMock('../../../workspace-registry', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../workspace-registry')>()),
    activeWorkspaceId: () => 'ws-test',
  }));
  vi.doMock('../../../harness/git-sync/git-sync-routine', () => ({
    seedGitSyncRoutineForMember: async (o: Record<string, unknown>) => {
      seedCalls.push(o);
      return seedImpl(o);
    },
  }));
  // create.ts's 5b "doc-integrity twin" (added 2026-06-22) calls seedHarnessDocTracking
  // for any requiresRepo blueprint (coding extends → requiresRepo). It's PG-touching
  // (resolveHarnessDocPaths/listDocBodies/anchorManualDoc), so leave it un-mocked and a
  // unit-test create hangs on a DB connection that never comes. Mock it PG-free, same as
  // the git-sync seeder above. This test asserts only on gitSync, not docTracking.
  vi.doMock('../../../harness/docs/seed-doc-tracking', () => ({
    seedHarnessDocTracking: async () => ({ seeded: true, registered: 0, total: 0, reason: 'no_docs' }),
  }));
});
afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../scaffold-harness-schema');
  vi.doUnmock('../../../blueprint/materialize-triggers');
  vi.doUnmock('../../../cupboard/pack-catalog');
  vi.doUnmock('../../../workspace-registry');
  vi.doUnmock('../../../harness/git-sync/git-sync-routine');
  vi.doUnmock('../../../harness/docs/seed-doc-tracking');
});

async function runCreate(args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = (await import('../create')).default as {
    handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
  };
  return parsePayload(await tool.handler(args, MAKE_CTX()));
}

describe('harness:create { hive } — B-01 git-sync seeding', () => {
  it('seeds the member routine (creator side, active workspace, the new entry) and reports gitSync', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-gitsync-'));
    try {
      const payload = await runCreate({
        slug: 'member-x',
        path: dir,
        blueprint: { id: 'member-x', extends: 'coding', dependencies: { tools: [], packs: [], plugins: [] } },
        pot: 'my-hive',
      });
      expect(payload).toMatchObject({ ok: true });
      // WI-3646 class-bug, instance #3 (found live while validating the .strict()
      // schema fix on harness/create.ts): this assertion pinned the WRONG output
      // key — the handler's success payload names the field `pot` (create.ts
      // ~L516: `...(hiveMembership ? { pot: hiveMembership } : {})`), never
      // `hive`. The test's own `hive` name was a copy of the same naming
      // confusion that broke `_create_from_repo.ts`'s `defaultCreateMember` —
      // it was PRE-EXISTING and unrelated to `.strict()` (confirmed by reverting
      // just that change and re-running: same failure either way), just never
      // caught because this integration test isn't in the default
      // `test:affected` (unit-only) sweep.
      expect(payload.pot).toBe('my-hive');
      expect(seedCalls).toEqual([
        {
          workspaceId: 'ws-test',
          installSlug: 'member-x',
          joinerSide: false,
          entry: expect.objectContaining({ slug: 'member-x', path: dir, hive_slug: 'my-hive' }),
        },
      ]);
      expect(payload.gitSync).toMatchObject({ seeded: true, push: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a create WITHOUT { hive } never touches the seeder and reports no gitSync', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-nogitsync-'));
    try {
      const payload = await runCreate({
        slug: 'standalone-x',
        path: dir,
        blueprint: { id: 'standalone-x', extends: 'coding', dependencies: { tools: [], packs: [], plugins: [] } },
      });
      expect(payload).toMatchObject({ ok: true });
      expect(seedCalls).toEqual([]);
      expect(payload).not.toHaveProperty('gitSync');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('an exploding seeder NEVER fails the create — reported as { reason: error }', async () => {
    seedImpl = async () => {
      throw new Error('routines pg down');
    };
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-gitsync-err-'));
    try {
      const payload = await runCreate({
        slug: 'member-err',
        path: dir,
        blueprint: { id: 'member-err', extends: 'coding', dependencies: { tools: [], packs: [], plugins: [] } },
        pot: 'my-hive',
      });
      expect(payload).toMatchObject({ ok: true });
      expect(payload.gitSync).toEqual({ seeded: false, reason: 'error', message: 'routines pg down' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
