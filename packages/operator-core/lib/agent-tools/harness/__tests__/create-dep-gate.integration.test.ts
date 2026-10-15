/**
 * harness:create — E2b-ii import-time dependency gate
 * (harness-blueprint-distribution-2026-06-03 P-003/P-004;
 * tool-distribution-granularity-2026-06-05 D-002/D-006 — the pack model).
 * A blueprint that declares a tool with NO known provider must fail at CREATE
 * (fail-fast, before any dir/registry/schema side effect) — closing the
 * call-time `unknown_tool` gap. Tools/packs/plugins installable from the
 * Cupboard are advisory and must NOT block. A blueprint with no deps must
 * pass the gate untouched.
 *
 * All cases are PG-free: the gate (and the dest-exists check) return before
 * `scaffoldHarnessSchema`. The registry read + the pack catalog are mocked
 * (the catalog mock routes through the REAL pure assembler so the gate is
 * exercised against the real model, with injected registry snapshots).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'x',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

/**
 * Mock the pack catalog with injected registry snapshots, routed through the
 * REAL `assemblePackCatalog` + `depHostSetsFromCatalog`. `legacyCatalogNames`
 * includes the resolved parent's providers: dependency declarations union across
 * extends, while these isolated tests do not bootstrap every operator tool.
 */
function mockPackCatalog(opts: {
  installed?: Array<{ name: string; version?: string; kind?: string; tools?: Array<{ name: string }> }>;
  projectedTools?: Array<{ pluginName: string; mcpName: string }>;
  cupboardUnits?: Array<{
    name: string;
    kind: 'plugin' | 'pack';
    listingId: string | null;
    providesTools: string[];
  }>;
  cupboardReachable?: boolean;
}) {
  vi.doMock('../../../cupboard/pack-catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../cupboard/pack-catalog')>();
    const { getCatalog } = await import('@papercusp/agent-mcp');
    const { operatorResolveExtends } = await import('../../../blueprint/installed-blueprints');
    const { loadBlueprintFromFile } = await import('@papercusp/orchestrator/blueprint');
    const resolve = operatorResolveExtends();
    const { blueprint } = loadBlueprintFromFile(resolve('coding')!, resolve);
    return {
      ...actual,
      derivePackCatalog: async (deriveOpts: { includeCupboard?: boolean } = {}) =>
        actual.assemblePackCatalog({
          installed: opts.installed ?? [],
          projectedTools: opts.projectedTools ?? [],
          legacyCatalogNames: [...getCatalog().map((t) => t.name), ...(blueprint.dependencies?.tools ?? [])],
          cupboardUnits: deriveOpts.includeCupboard === false ? [] : opts.cupboardUnits ?? [],
          cupboardReachable: deriveOpts.includeCupboard === false ? true : opts.cupboardReachable ?? true,
        }),
    };
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: [] }),
    saveHarnessRegistry: async () => {},
    // create.ts routes its registry write through mutateHarnessRegistry (the
    // atomic insert, audit P-006). Every case here returns before the write,
    // but the mock must still export it so the dynamic import resolves.
    mutateHarnessRegistry: async (m: (r: { projects: unknown[] }) => { projects: unknown[] }) =>
      m({ projects: [] }),
  }));
});
afterEach(() => {
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../cupboard/pack-catalog');
});

describe('harness:create — E2b-ii dependency gate (pack model)', () => {
  it('fails fast when the blueprint declares a tool with no known provider', async () => {
    mockPackCatalog({});
    const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
    const res = await tool.handler(
      {
        slug: 'deptest',
        parentDir: '/tmp/should-never-be-created-by-this-test',
        folderName: 'deptest-x',
        blueprint: {
          id: 'deptest',
          extends: 'coding',
          dependencies: { tools: ['definitely-not-a-real-tool-xyz'], packs: [], plugins: [] },
        },
      },
      MAKE_CTX(),
    );
    const payload = parsePayload(res);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/tool dependencies unmet/);
    expect(payload.missing.tools).toEqual(['definitely-not-a-real-tool-xyz']);
  });

  it('passes when a declared tool is PROVIDED BY AN INSTALLED PLUGIN (projected registry, not getCatalog)', async () => {
    // The recon-found gap: pre-pack-model, availableTools came from
    // getCatalog() only, so `repomix.pack` false-failed even when installed.
    mockPackCatalog({
      installed: [{ name: 'repomix', version: '1.0.0' }],
      projectedTools: [{ pluginName: 'repomix', mcpName: 'repomix.pack' }],
    });
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-plugtool-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugtool',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'plugtool', extends: 'coding', dependencies: { tools: ['repomix.pack'], packs: [], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/); // gate passed
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes when a declared tool is provided by an INSTALLABLE Cupboard unit (advisory, non-blocking)', async () => {
    mockPackCatalog({
      cupboardUnits: [
        { name: 'firecrawl', kind: 'plugin', listingId: 'l1', providesTools: ['firecrawl.scrape'] },
      ],
    });
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-insttool-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'insttool',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'insttool', extends: 'coding', dependencies: { tools: ['firecrawl.scrape'], packs: [], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/); // gate passed
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when a declared plugin is neither installed nor in the Cupboard (Cupboard reachable)', async () => {
    mockPackCatalog({ cupboardReachable: true });
    const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
    const res = await tool.handler(
      {
        slug: 'plugtest',
        parentDir: '/tmp/should-never-be-created-by-this-test',
        folderName: 'plugtest-x',
        blueprint: { id: 'plugtest', extends: 'coding', dependencies: { tools: [], packs: [], plugins: ['ghost-plugin'] } },
      },
      MAKE_CTX(),
    );
    const payload = parsePayload(res);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/pack\/plugin dependencies unmet/);
    expect(payload.missing.plugins).toContain('ghost-plugin');
  });

  it('fails when a declared PACK is neither installed nor in the Cupboard (Cupboard reachable)', async () => {
    mockPackCatalog({ cupboardReachable: true });
    const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
    const res = await tool.handler(
      {
        slug: 'packtest',
        parentDir: '/tmp/should-never-be-created-by-this-test',
        folderName: 'packtest-x',
        blueprint: { id: 'packtest', extends: 'coding', dependencies: { tools: [], packs: ['ghost-pack'], plugins: [] } },
      },
      MAKE_CTX(),
    );
    const payload = parsePayload(res);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/pack\/plugin dependencies unmet/);
    expect(payload.missing.packs).toContain('ghost-pack');
  });

  it('passes the gate when a declared plugin is installable from the Cupboard', async () => {
    mockPackCatalog({
      cupboardUnits: [{ name: 'cool-plugin', kind: 'plugin', listingId: 'l2', providesTools: [] }],
    });
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-plug-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugok',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'plugok', extends: 'coding', dependencies: { tools: [], packs: [], plugins: ['cool-plugin'] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes the gate when a declared pack is installable from the Cupboard (kind pack or plugin)', async () => {
    mockPackCatalog({
      cupboardUnits: [{ name: 'audit-pack', kind: 'pack', listingId: 'l3', providesTools: ['audit-pack.scan'] }],
    });
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-pack-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'packok',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'packok', extends: 'coding', dependencies: { tools: [], packs: ['audit-pack'], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT hard-fail a missing pack/plugin when the Cupboard is unreachable', async () => {
    mockPackCatalog({ cupboardReachable: false });
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-plug-unreach-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugunreach',
          parentDir: dir,
          folderName: 'already',
          blueprint: {
            id: 'plugunreach',
            extends: 'coding',
            dependencies: { tools: [], packs: ['ghost-pack'], plugins: ['ghost-plugin'] },
          },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('empty child dependency arrays retain parent tools and validate the ready catalog', async () => {
    // Empty child arrays do not erase the parent's declaration sets. The real
    // gate derives the ready local catalog, then reaches destination validation.
    mockPackCatalog({});
    const catalog = await import('../../../cupboard/pack-catalog');
    const derive = vi.spyOn(catalog, 'derivePackCatalog');
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-noop-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'noopt',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'noopt', extends: 'coding', dependencies: { tools: [], packs: [], plugins: [] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
      expect(derive).toHaveBeenCalledExactlyOnceWith({ includeCupboard: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
