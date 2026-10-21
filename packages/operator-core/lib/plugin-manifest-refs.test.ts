/**
 * WI-6554700010018318 — a listed plugin manifest's references (dependency
 * tools/packs/plugins/events, its own tools, its own provided events) are
 * resolved against the live pack catalog and reported, instead of the listing
 * presenting every manifest as valid until load or install time.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const derive = vi.hoisted(() => ({ fail: null as Error | null }));

vi.mock('./cupboard/pack-catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('./cupboard/pack-catalog')>();
  return {
    ...real,
    // A unit test has no plugin host to warm: derive from the on-disk
    // manifests, the in-process registries and the (stubbed) Cupboard only.
    derivePackCatalog: async (opts: Parameters<typeof real.derivePackCatalog>[0] = {}) => {
      if (derive.fail) throw derive.fail;
      return real.derivePackCatalog({ ...opts, warmHost: false });
    },
  };
});

import { assemblePackCatalog, type PackCatalogInputs } from './cupboard/pack-catalog';
import { resolveManifestRefs, type ManifestRefIssue, type ManifestRefsInput } from './plugin-manifest-refs';

const key = (i: ManifestRefIssue) => `${i.axis}|${i.name}|${i.status}`;

function catalog(over: Partial<PackCatalogInputs> = {}) {
  return assemblePackCatalog({
    installed: [
      {
        name: 'helper-plugin',
        tools: [{ name: 'do' }],
        provides: { events: [{ family: 'helper:done', keyTemplate: 'helper:done:<id>' }] },
      },
      { name: 'subject' },
    ],
    projectedTools: [
      { pluginName: 'helper-plugin', mcpName: 'helper-plugin.do' },
      { pluginName: 'subject', mcpName: 'subject.other' },
    ],
    legacyCatalogNames: ['builtin.tool'],
    cupboardUnits: [
      {
        name: 'cupboard-plugin',
        kind: 'plugin',
        listingId: 'L1',
        providesTools: ['cb.tool'],
        providesEvents: [{ family: 'cb:evt', keyTemplate: 'cb:evt', describe: null }],
      },
    ],
    cupboardReachable: true,
    builtinEvents: new Map([['deploy', 'deploy:<id>']]),
    loadedUnitNames: ['helper-plugin', 'subject'],
    ...over,
  });
}

const subject: ManifestRefsInput = {
  name: 'subject',
  tools: [
    { name: 'ping' },
    { name: 'other' },
    { name: 'web', expose: { http: { path: '/api/plugins/subject/web' } } },
  ],
  dependencies: {
    tools: ['builtin.tool', 'helper-plugin.do', 'cb.tool', 'ghost.tool'],
    plugins: ['helper-plugin', 'cupboard-plugin', 'absent-plugin'],
    events: [
      { family: 'deploy' },
      { family: 'helper:done' },
      { family: 'cb:evt' },
      { family: 'ghost:evt' },
      { family: 'ghost:maybe', optional: true },
    ],
  },
  provides: {
    events: [
      { family: 'deploy', keyTemplate: 'deploy:<id>' },
      { family: 'subject:fresh', keyTemplate: 'subject:fresh' },
    ],
  },
};

describe('resolveManifestRefs', () => {
  it('reports every unresolved reference and nothing that resolves', () => {
    const report = resolveManifestRefs(subject, catalog());
    expect(report.dependenciesOk).toBe(false);
    expect(report.loaded).toBe(true);
    expect(report.issues.map(key).sort()).toEqual(
      [
        'tool|ghost.tool|missing',
        'tool|cb.tool|installable',
        'plugin|absent-plugin|missing',
        'plugin|cupboard-plugin|installable',
        'event|ghost:evt|missing',
        'event|cb:evt|installable',
        'event|ghost:maybe|optional-unresolved',
        // declared, loaded, but the registry holds only subject.other; the
        // HTTP-only tool has no MCP registration to check
        'own-tool|subject.ping|not-registered',
        'own-event|deploy|shadowed-by-builtin',
      ].sort(),
    );
  });

  it('marks pack/plugin/event misses unverified while the Cupboard is unreachable, but a missing tool stays missing', () => {
    const offline = catalog({ cupboardUnits: [], cupboardReachable: false });
    const soft = resolveManifestRefs(
      { name: 'x', dependencies: { plugins: ['absent-plugin'], events: [{ family: 'ghost:evt' }] } },
      offline,
    );
    expect(soft.issues.map(key).sort()).toEqual(['event|ghost:evt|unverified', 'plugin|absent-plugin|unverified']);
    expect(soft.dependenciesOk).toBe(true); // the install gate softens these too

    const hard = resolveManifestRefs({ name: 'x', dependencies: { tools: ['ghost.tool'] } }, offline);
    expect(hard.issues.map(key)).toEqual(['tool|ghost.tool|missing']);
    expect(hard.dependenciesOk).toBe(false);
  });

  it('checks own tools only for a unit the host has loaded', () => {
    expect(resolveManifestRefs(subject, catalog({ loadedUnitNames: null })).loaded).toBeNull();
    const notLoaded = resolveManifestRefs(subject, catalog({ loadedUnitNames: ['helper-plugin'] }));
    expect(notLoaded.loaded).toBe(false);
    expect(notLoaded.issues.filter((i) => i.axis === 'own-tool')).toEqual([]);
  });

  it('reads a malformed dependencies block as empty instead of throwing', () => {
    const report = resolveManifestRefs(
      { name: 'x', dependencies: { tools: 'ghost.tool', plugins: [5, null], events: ['bare'] } },
      catalog(),
    );
    expect(report).toEqual({ dependenciesOk: true, loaded: false, issues: [] });
  });

  it('reports nothing for a manifest whose references all resolve', () => {
    const report = resolveManifestRefs(
      {
        name: 'helper-plugin',
        tools: [{ name: 'do' }],
        dependencies: { tools: ['builtin.tool'], events: [{ family: 'deploy' }] },
      },
      catalog(),
    );
    expect(report).toEqual({ dependenciesOk: true, loaded: true, issues: [] });
  });
});

describe('GET /api/plugins reports unresolved manifest refs', () => {
  type Route = { handler: (req?: Request) => Promise<Response> };
  const route = async () => (await import('./endpoint-route/routes/plugins/list')).default as unknown as Route;
  const prevHome = process.env.PAPERCUSP_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugin-manifest-refs-'));
    process.env.PAPERCUSP_HOME = home;
    const dir = join(home, 'global-plugins', 'ref-subject');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'papercusp.json'),
      JSON.stringify({
        name: 'ref-subject',
        version: '1.0.0',
        dependencies: {
          tools: ['ghost.tool'],
          plugins: ['absent-plugin', 'cupboard-plugin'],
          events: [{ family: 'ghost:evt' }],
        },
      }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        Response.json({
          results: String(url).includes('kind=plugin')
            ? [{ id: 7, listing_ref: 'cupboard-plugin', provides_tools: '[]' }]
            : [],
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    derive.fail = null;
    if (prevHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the installed manifest with its unknown tool, unknown event and missing dependency', async () => {
    const res = await (await route()).handler(new Request('http://localhost/api/plugins'));
    const body = (await res.json()) as {
      plugins: Array<{ name: string; refs: { dependenciesOk: boolean; loaded: boolean | null; issues: ManifestRefIssue[] } | null }>;
      refResolution: { resolved: boolean; cupboardReachable: boolean | null; hostRead: boolean | null };
    };
    expect(body.refResolution).toEqual({ resolved: true, cupboardReachable: true, hostRead: false });
    const listed = body.plugins.find((p) => p.name === 'ref-subject');
    expect(listed?.refs?.dependenciesOk).toBe(false);
    expect(listed?.refs?.loaded).toBeNull();
    expect(listed?.refs?.issues.map(key).sort()).toEqual(
      [
        'tool|ghost.tool|missing',
        'event|ghost:evt|missing',
        'plugin|absent-plugin|missing',
        'plugin|cupboard-plugin|installable',
      ].sort(),
    );
  });

  it('still lists every manifest when the catalog cannot be derived', async () => {
    derive.fail = new Error('catalog down');
    const res = await (await route()).handler(new Request('http://localhost/api/plugins'));
    const body = (await res.json()) as {
      plugins: Array<{ name: string; refs: unknown }>;
      refResolution: { resolved: boolean; error?: string };
    };
    expect(body.refResolution).toMatchObject({ resolved: false, error: 'catalog down' });
    expect(body.plugins.find((p) => p.name === 'ref-subject')).toMatchObject({ refs: null });
  });
});
