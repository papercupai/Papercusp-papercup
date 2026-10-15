/**
 * harness:create — autoInstallDeps opt-in (tool-distribution-discovery-2026-06-08 P-002).
 * When a blueprint's only unmet deps are Cupboard-installable AND autoInstallDeps
 * is set, the gate INSTALLS them (via the shared install IO) before re-validating
 * instead of just reporting them advisorily. Without the flag the install IO is
 * never touched. PG-free: the gate returns before scaffoldHarnessSchema; the
 * pack catalog + install IO are mocked (catalog routed through the REAL
 * assembler; the install mock flips the unit cupboard→installed).
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
    workspaceId: 'default',
    harnessSlug: 'x',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
  } as never);

const parsePayload = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

/** Mock the catalog (real assembler) + the install IO; the install flips the unit installed. */
function mockInstallable() {
  const installCalls: Array<{ name: string }> = [];
  let installed = false;
  vi.doMock('../../../cupboard/pack-catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../cupboard/pack-catalog')>();
    const { getCatalog } = await import('@papercusp/agent-mcp');
    // Empty child arrays retain coding's dependencies; model its ready
    // providers without bootstrapping the entire operator in this fixture.
    const { operatorResolveExtends } = await import('../../../blueprint/installed-blueprints');
    const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
    const resolve = operatorResolveExtends();
    const { blueprint } = loadBlueprintFromFile(resolve('coding')!, resolve);
    return {
      ...actual,
      derivePackCatalog: async (deriveOpts: { includeCupboard?: boolean } = {}) =>
        actual.assemblePackCatalog({
          installed: installed ? [{ name: 'md-tools', version: '0.1.0', kind: 'pack', tools: [{ name: 'render' }] }] : [],
          projectedTools: installed ? [{ pluginName: 'md-tools', mcpName: 'md-tools.render' }] : [],
          legacyCatalogNames: [...getCatalog().map((t) => t.name), ...(blueprint.dependencies?.tools ?? [])],
          cupboardUnits:
            deriveOpts.includeCupboard === false
              ? []
              : [{ name: 'md-tools', kind: 'pack', listingId: 'lid-md', providesTools: ['md-tools.render'] }],
          cupboardReachable: true,
        }),
    };
  });
  vi.doMock('../../../cupboard/install-io', () => ({
    installCupboardUnitFromListing: vi.fn(async (u: { name: string }) => {
      installCalls.push(u);
      installed = true;
      return { ok: true };
    }),
  }));
  return { installCalls };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: [] }),
    saveHarnessRegistry: async () => {},
    // create.ts routes its registry insert through mutateHarnessRegistry (the
    // atomic write, audit P-006). Run the mutator so the create proceeds.
    mutateHarnessRegistry: async (m: (r: { projects: unknown[] }) => { projects: unknown[] }) =>
      m({ projects: [] }),
  }));
  // create.ts's 5b doc-tracking step (added 2026-06-22) is a PG-touching best-effort
  // call for any requiresRepo blueprint (coding extends). Left un-mocked, a PG-free
  // unit-test create hangs on a DB connection that never comes. Mock it, like the
  // other PG steps above.
  vi.doMock('../../../harness/docs/seed-doc-tracking', () => ({
    seedHarnessDocTracking: async () => ({ seeded: true, registered: 0, total: 0, reason: 'no_docs' }),
  }));
});
afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../cupboard/pack-catalog');
  vi.doUnmock('../../../cupboard/install-io');
  vi.doUnmock('../../../harness/docs/seed-doc-tracking');
});

describe('harness:create — autoInstallDeps', () => {
  it('installs the providing Cupboard unit when autoInstallDeps:true, then the gate passes', async () => {
    const { installCalls } = mockInstallable();
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-autoinstall-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'autoinst',
          parentDir: dir,
          folderName: 'already',
          autoInstallDeps: true,
          blueprint: { id: 'autoinst', extends: 'coding', dependencies: { tools: ['md-tools.render'], packs: [], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      // Gate passed (reaches dir resolution); and the install IO was invoked for the unit.
      expect(payload.error).toMatch(/destination already exists/);
      expect(installCalls.map((u) => u.name)).toContain('md-tools');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT install when autoInstallDeps is absent (installable stays advisory)', async () => {
    const { installCalls } = mockInstallable();
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-noautoinstall-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'noauto',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'noauto', extends: 'coding', dependencies: { tools: ['md-tools.render'], packs: [], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.error).toMatch(/destination already exists/); // installable is advisory — gate still passes
      expect(installCalls).toHaveLength(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
