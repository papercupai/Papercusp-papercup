/**
 * docs:outline / docs:get / docs:search — PURE handler-level tests.
 *
 * The sibling `routing.test.ts` covers the exported `resolveAdapter`
 * branching (which adapter for which ctx). This file covers the part
 * `resolveAdapter` does NOT: the `defineTool` HANDLER pipeline around it —
 *
 *   - the `resolveHarnessScope` gate → `harness_required` error envelope
 *     (isError:true, no engine call) when no harness is in scope;
 *   - the `resolved.error` → error envelope shaping (`{error, slug}`,
 *     isError:true) without ever calling the engine;
 *   - the happy-path projection: the engine payload is wrapped with
 *     `surface` (+ `cached` for outline) and serialized to one text part;
 *   - docs:outline's per-run cache: first call MISS (cached:false, engine
 *     invoked once), second call HIT (cached:true, engine NOT re-invoked);
 *   - `ctx.metadata` emission (surface + harness_slug for a concrete slug).
 *
 * The docs-engine (buildOutline/getDocs/searchDocs) and the on-disk adapters
 * are mocked, so nothing touches the real docs tree or fs. The harness
 * registry is mocked to control the harness/engineering routing.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { OutlinePayload } from '@papercusp/docs-engine';

// These tests exercise the docs handlers, not agent-mcp's tool registration.
// Keep the large package barrel out of the warm-up import graph so a handler
// regression cannot be hidden behind an unrelated package bootstrap timeout.
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (tool: unknown) => tool,
  SU_ROLES: [],
}));

// --- Mock the docs-engine so no real fs/content tree is read. ----------------
// Each engine fn returns a recognizable payload; adapter factories return an
// opaque sentinel (handlers only pass it through to the engine fn).
// WI-5217: typed against the real OutlinePayload (generatedAt/sectionCount/
// pageCount/sections) so later `mockResolvedValueOnce(bigPayload)` overrides
// below (the EI-400 tests) typecheck — the untyped default previously
// inferred a narrower `{ pages: [...] }` shape from this literal alone.
const buildOutline = vi.fn(
  async (): Promise<OutlinePayload> => ({
    generatedAt: '2026-01-01T00:00:00.000Z',
    sectionCount: 1,
    pageCount: 1,
    sections: [{ slug: 's1', title: 'S1', pages: [{ slug: 'p1', title: 'P1', headings: [] }] }],
  }),
);
const getDocs = vi.fn(async () => ({ pages: [{ slug: 'p1', body: 'BODY' }] }));
// WI-5690: typed against a local shape (not the full real `SearchResult`,
// which also requires `url` per hit — unused by any assertion here) so the
// RRF-headroom override below (which sets `score` + hitCount/tokenCount/
// query) typechecks instead of narrowing to this literal's own shape.
const searchDocs = vi.fn(
  async (): Promise<{
    hits: Array<{ slug: string; title: string; excerpt: string; score?: number }>;
    hitCount?: number;
    tokenCount?: number;
    query?: string;
  }> => ({ hits: [{ slug: 'p1', title: 'P1', excerpt: 'ex' }] }),
);
const engineeringAdapterForSlugs = vi.hoisted(() =>
  vi.fn((slugs: readonly string[]) => ({ __adapter: 'engineering-request', slugs })),
);
const resolveDocsEmbedder = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      embedder: ((query: string) => Promise<number[]>) | null;
      embeddingMode: string | null;
    }> => ({ embedder: null, embeddingMode: null }),
  ),
);
const docSectionsRanker = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/docs-engine', () => ({
  buildOutline,
  getDocs,
  searchDocs,
  withPreamble: (body: unknown) => body,
  genericFsAdapter: (root: string) => ({ __adapter: 'generic', root }),
  harnessFsAdapter: (path: string) => ({ __adapter: 'harness', path }),
  starlightContentAdapter: () => ({ __adapter: 'starlight' }),
  // RunCache is real-behaviored but tiny — re-implement the get/set/key
  // contract the outline handler depends on (per-run keyed by runId+scope).
  RunCache: class<T> {
    private m = new Map<string, T>();
    private k(ctx: { runId?: string; spawnId?: string }, scope = '') {
      const base = ctx.runId ?? ctx.spawnId ?? '_';
      return scope ? `${base}:${scope}` : base;
    }
    get(ctx: { runId?: string; spawnId?: string }, scope = '') {
      return this.m.get(this.k(ctx, scope));
    }
    set(ctx: { runId?: string; spawnId?: string }, v: T, scope = '') {
      this.m.set(this.k(ctx, scope), v);
    }
  },
}));

vi.mock('../_engineering-adapter', () => ({
  engineeringAdapter: { __adapter: 'engineering-shared' },
  engineeringAdapterForSlugs,
  getEngineeringAdapterRevision: () => 0,
}));

vi.mock('../semantic-leg', () => ({
  resolveDocsEmbedder,
  docSectionsRanker,
}));

type RegistryProject = { slug: string; path: string };
const registryState = vi.hoisted(() => ({ projects: [] as RegistryProject[] }));
const loadHarnessRegistry = vi.hoisted(() => vi.fn(async () => ({ projects: registryState.projects })));

// Keep one mutable registry mock for the whole file. The former per-test
// vi.resetModules()+vi.doMock path put the cold docs handler module graph inside
// each test's 5s timeout; that import now takes >5s even though the scope gate
// itself returns immediately (EI-21311666639860118).
vi.mock('../../../harness-registry', () => ({
  loadHarnessRegistry,
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
  resolveHarnessContentPath: (reg: { projects: RegistryProject[] }, slug: string) =>
    reg.projects.find((p) => p.slug === slug)?.path,
}));

function mockRegistry(projects: Array<{ slug: string; path: string }>) {
  registryState.projects = projects;
}

const ORIGINAL_ENV = process.env.PAPERCUSP_PROJECT_DOCS_ROOT;

beforeAll(async () => {
  // Warm the three handler modules outside per-test timeouts. This is not a
  // timeout increase: every individual test still has the default 5s budget.
  await Promise.all([import('../outline'), import('../get'), import('../search')]);
}, 30_000);

beforeEach(() => {
  registryState.projects = [];
  loadHarnessRegistry.mockClear();
  buildOutline.mockClear();
  getDocs.mockClear();
  searchDocs.mockClear();
  engineeringAdapterForSlugs.mockClear();
  resolveDocsEmbedder.mockReset().mockResolvedValue({ embedder: null, embeddingMode: null });
  docSectionsRanker.mockReset().mockImplementation(() => async () => [] as never[]);
  delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.PAPERCUSP_PROJECT_DOCS_ROOT;
  else process.env.PAPERCUSP_PROJECT_DOCS_ROOT = ORIGINAL_ENV;
});

/** Parse the single text content part a docs handler returns. */
type TextToolResult = { content: Array<{ type?: string; text: string }>; isError?: boolean };
const textResult = (result: unknown) => result as TextToolResult;
function payloadOf(res: unknown) {
  return JSON.parse(textResult(res).content[0].text);
}

describe('docs:outline handler — harness_required gate', () => {
  it('opts out of the ambient workspace transaction during registry and docs reads', async () => {
    const tool = (await import('../outline')).default;
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('no arg + ctx harnessSlug="*" → harness_required, engine never called', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    const res = await tool.handler({} as never, { harnessSlug: '*' } as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('harness_required');
    expect(payloadOf(res).detail).toContain('harness');
    expect(buildOutline).not.toHaveBeenCalled();
  });

  it('no arg + unset ctx harnessSlug → harness_required', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    const res = await tool.handler({} as never, {} as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('harness_required');
    expect(buildOutline).not.toHaveBeenCalled();
  });
});

describe('docs:outline handler — resolved.error → error envelope', () => {
  it('unknown slug → harness_not_registered envelope, engine never called', async () => {
    mockRegistry([]); // empty registry → any concrete slug is unregistered
    const tool = (await import('../outline')).default;
    const res = await tool.handler({ harness: 'nope' } as never, { harnessSlug: '*' } as never);
    expect(textResult(res).isError).toBe(true);
    const p = payloadOf(res);
    expect(p.error).toBe('harness_not_registered');
    expect(p.slug).toBe('nope');
    expect(buildOutline).not.toHaveBeenCalled();
  });

  it('non-SU caller, all scope, no project-docs env → no_docs_source envelope', async () => {
    mockRegistry([]);
    const tool = (await import('../outline')).default;
    // arg "all" → operator scope; isSuperuser unset, no env var → no_docs_source.
    const res = await tool.handler({ harness: 'all' } as never, { harnessSlug: '*' } as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('no_docs_source');
    expect(buildOutline).not.toHaveBeenCalled();
  });
});

describe('docs:outline handler — happy path + per-run cache', () => {
  it('first call MISS (cached:false, engine called once), second HIT (cached:true, not re-called)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    const ctx = { harnessSlug: 'sheets', runId: 'run_A', metadata: vi.fn() } as never;

    const r1 = await tool.handler({} as never, ctx);
    const p1 = payloadOf(r1);
    expect(p1.cached).toBe(false);
    expect(p1.surface).toBe('harness');
    expect(p1.sections[0].pages[0].slug).toBe('p1'); // engine payload spread through
    expect(buildOutline).toHaveBeenCalledTimes(1);

    const r2 = await tool.handler({} as never, ctx);
    const p2 = payloadOf(r2);
    expect(p2.cached).toBe(true);
    expect(p2.surface).toBe('harness');
    // Cache HIT: engine NOT invoked a second time for the same run+scope.
    expect(buildOutline).toHaveBeenCalledTimes(1);
  });

  it('emits metadata { surface, harness_slug } for a concrete harness scope', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    const metadata = vi.fn();
    await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_B', metadata } as never);
    expect(metadata).toHaveBeenCalledWith({ surface: 'harness', harness_slug: 'sheets' });
  });

  it('a different run does NOT share the cache (cached:false again)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_C' } as never);
    const r2 = await tool.handler({} as never, { harnessSlug: 'sheets', runId: 'run_D' } as never);
    expect(payloadOf(r2).cached).toBe(false);
    expect(buildOutline).toHaveBeenCalledTimes(2);
  });
});

/**
 * EI-400: harness:'all' (engineering/project surface) routes through the
 * SAME handler but gets the brief-by-default + section-drill-down shaping
 * (shapeOutlineResponse) instead of the raw full payload a small
 * harness-scoped corpus gets above.
 */
describe('docs:outline handler — engineering scope brief-by-default (EI-400)', () => {
  const bigPayload = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    sectionCount: 2,
    pageCount: 3,
    sections: [
      {
        slug: 'agent-insights',
        title: 'Agent Insights',
        pages: [
          { slug: 'agent-insights/a', title: 'A', headings: [{ id: 'h1', text: 'H1', depth: 2 }] },
          { slug: 'agent-insights/b', title: 'B', headings: [] },
        ],
      },
      { slug: 'design', title: 'Design', pages: [{ slug: 'design/overview', title: 'Overview', headings: [] }] },
    ],
  };

  it('no `section` arg → brief section index (no per-page headings)', async () => {
    mockRegistry([]);
    buildOutline.mockResolvedValueOnce(bigPayload);
    const tool = (await import('../outline')).default;
    const res = await tool.handler(
      { harness: 'all' } as never,
      { harnessSlug: '*', isSuperuser: true, runId: 'run_E' } as never,
    );
    const p = payloadOf(res);
    expect(p.surface).toBe('engineering');
    expect(p.brief).toBe(true);
    expect(typeof p.hint).toBe('string');
    expect(p.sections).toEqual([
      { slug: 'agent-insights', title: 'Agent Insights', pageCount: 2 },
      { slug: 'design', title: 'Design', pageCount: 1 },
    ]);
    expect(p.section).toBeUndefined();
    for (const s of p.sections) expect(s.pages).toBeUndefined();
  });

  it("`section` arg → that section's full page list + headings, brief omitted", async () => {
    mockRegistry([]);
    buildOutline.mockResolvedValueOnce(bigPayload);
    const tool = (await import('../outline')).default;
    const res = await tool.handler(
      { harness: 'all', section: 'agent-insights' } as never,
      { harnessSlug: '*', isSuperuser: true, runId: 'run_F' } as never,
    );
    const p = payloadOf(res);
    expect(p.brief).toBeUndefined();
    expect(p.section.slug).toBe('agent-insights');
    expect(p.section.pages).toHaveLength(2);
    expect(p.section.pages[0].headings).toEqual([{ id: 'h1', text: 'H1', depth: 2 }]);
  });

  it('unknown `section` → section_not_found with availableSections, not an MCP error', async () => {
    mockRegistry([]);
    buildOutline.mockResolvedValueOnce(bigPayload);
    const tool = (await import('../outline')).default;
    const res = await tool.handler(
      { harness: 'all', section: 'nope' } as never,
      { harnessSlug: '*', isSuperuser: true, runId: 'run_G' } as never,
    );
    expect(textResult(res).isError).toBeFalsy();
    const p = payloadOf(res);
    expect(p.error).toBe('section_not_found');
    expect(p.availableSections).toEqual(['agent-insights', 'design']);
  });

  it('the brief shaping also applies on a cache HIT (second call, same run)', async () => {
    mockRegistry([]);
    buildOutline.mockResolvedValueOnce(bigPayload);
    const tool = (await import('../outline')).default;
    const ctx = { harnessSlug: '*', isSuperuser: true, runId: 'run_H' } as never;
    await tool.handler({ harness: 'all' } as never, ctx);
    const r2 = await tool.handler({ harness: 'all' } as never, ctx);
    const p2 = payloadOf(r2);
    expect(p2.cached).toBe(true);
    expect(p2.brief).toBe(true);
    expect(buildOutline).toHaveBeenCalledTimes(1);
  });
});

// EI-18894866320087268: harness:'all' reaches the engineering/agent-insights corpus but is
// REJECTED with harness_forbidden at the transport layer for a workspace-scoped session — and
// the tool's own scopeNote used to instruct retrying with exactly that forbidden value. 'engineering'
// is a distinct literal (never intercepted by that clamp) that reaches the SAME surface, even when
// ctx.harnessSlug is a concrete harness (the workspace-scoped shape) — it must NOT be treated as a
// harness slug to look up (which would 404 harness_not_registered, since no harness is named "engineering").
describe("docs:outline handler — 'engineering' sentinel (EI-18894866320087268)", () => {
  it("harness:'engineering' from a workspace-scoped ctx (concrete harnessSlug) reaches the engineering surface, not harness_not_registered", async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]); // no harness named "engineering" registered
    const tool = (await import('../outline')).default;
    const res = await tool.handler(
      { harness: 'engineering' } as never,
      { harnessSlug: 'sheets', isSuperuser: true } as never,
    );
    const p = payloadOf(res);
    expect(p.surface).toBe('engineering');
    expect(p.error).toBeUndefined();
  });

  it("harness:'engineering' without isSuperuser → no_docs_source (same gate as harness:'all')", async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../outline')).default;
    const res = await tool.handler({ harness: 'engineering' } as never, { harnessSlug: 'sheets' } as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('no_docs_source');
  });
});

describe('docs:get handler', () => {
  it('opts out of the ambient workspace transaction during registry and filesystem reads', async () => {
    const tool = (await import('../get')).default;
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('harness_required gate fires (no arg, ctx "*") with no engine call', async () => {
    mockRegistry([]);
    const tool = (await import('../get')).default;
    const res = await tool.handler({ slugs: ['p1'] } as never, { harnessSlug: '*' } as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('harness_required');
    expect(getDocs).not.toHaveBeenCalled();
  });

  it('happy path wraps the engine response with surface (no cached flag)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    const res = await tool.handler({ slugs: ['p1'] } as never, { harnessSlug: 'sheets' } as never);
    const p = payloadOf(res);
    expect(p.surface).toBe('harness');
    expect(p.pages[0].body).toBe('BODY');
    expect(p).not.toHaveProperty('cached'); // get does not cache
    expect(getDocs).toHaveBeenCalledTimes(1);
    // engine receives args (slugs) so the heading-narrowing path is reachable.
    expect(getDocs).toHaveBeenCalledWith(expect.anything(), { slugs: ['p1'] }, expect.anything());
  });

  it('args schema rejects heading with multiple slugs (heading is single-slug only)', async () => {
    const mod = await import('../get');
    const parsed = mod.default.args.safeParse({ slugs: ['a', 'b'], heading: 'x' });
    expect(parsed.success).toBe(false);
  });

  it('args schema accepts a single slug + heading', async () => {
    const mod = await import('../get');
    const parsed = mod.default.args.safeParse({ slugs: ['a'], heading: 'sec-1' });
    expect(parsed.success).toBe(true);
  });

  it('args schema rejects an empty slugs array', async () => {
    const mod = await import('../get');
    expect(mod.default.args.safeParse({ slugs: [] }).success).toBe(false);
  });

  // EI-18894866320087268: see the docs:outline sentinel describe above for the full rationale.
  it("harness:'engineering' from a workspace-scoped ctx reaches the engineering surface, not harness_not_registered", async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    const res = await tool.handler(
      { slugs: ['p1'], harness: 'engineering' } as never,
      { harnessSlug: 'sheets', isSuperuser: true } as never,
    );
    const p = payloadOf(res);
    expect(p.surface).toBe('engineering');
    expect(p.error).toBeUndefined();
  });

  it('uses a request-local canonical adapter for exactly the requested engineering slugs', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    await tool.handler(
      { slugs: ['agent-insights/one', 'reference/two'], harness: 'engineering' } as never,
      { harnessSlug: 'sheets', isSuperuser: true } as never,
    );

    expect(engineeringAdapterForSlugs).toHaveBeenCalledOnce();
    expect(engineeringAdapterForSlugs).toHaveBeenCalledWith(['agent-insights/one', 'reference/two']);
    expect(getDocs).toHaveBeenCalledWith(
      expect.objectContaining({ __adapter: 'engineering-request' }),
      { slugs: ['agent-insights/one', 'reference/two'] },
      expect.anything(),
    );
  });

  it('accepts the authored projected path together with its returned engineering scope', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    const res = await tool.handler(
      { slugs: ['agent-insights/current-refresh.mdx'], harness: 'engineering' } as never,
      { harnessSlug: 'sheets', isSuperuser: true } as never,
    );
    expect(payloadOf(res)).toMatchObject({ surface: 'engineering' });
    expect(getDocs).toHaveBeenCalledWith(
      expect.anything(),
      { slugs: ['agent-insights/current-refresh'] },
      expect.anything(),
    );
  });

  it('maps engineering URL and content-root aliases after selecting the engineering surface', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    const res = await tool.handler(
      {
        slugs: [
          'docs/design/index',
          'docs/design/gotchas',
          '/internal/docs/design',
          'apps/operator-docs/src/content/docs/design/index.mdx',
        ],
        harness: 'engineering',
      } as never,
      { harnessSlug: 'sheets', isSuperuser: true } as never,
    );

    expect(payloadOf(res)).toMatchObject({ surface: 'engineering' });
    expect(engineeringAdapterForSlugs).toHaveBeenCalledWith([
      'design',
      'design/gotchas',
      'design',
      'design',
    ]);
    expect(getDocs).toHaveBeenCalledWith(
      expect.objectContaining({ __adapter: 'engineering-request' }),
      { slugs: ['design', 'design/gotchas', 'design', 'design'] },
      expect.anything(),
    );
  });

  it('preserves docs URL aliases on the harness surface', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../get')).default;
    await tool.handler(
      { slugs: ['docs/design/index', '/internal/docs/design/gotchas'] } as never,
      { harnessSlug: 'sheets' } as never,
    );

    expect(engineeringAdapterForSlugs).not.toHaveBeenCalled();
    expect(getDocs).toHaveBeenCalledWith(
      expect.objectContaining({ __adapter: 'harness' }),
      { slugs: ['docs/design/index', '/internal/docs/design/gotchas'] },
      expect.anything(),
    );
  });

  /**
   * WI-1511581 — `source: true` is the read whose body can be written back.
   *
   * The handler's only job here is to carry the flag through UNTRANSLATED and to
   * refuse the one combination that would return a partial body looking whole. A
   * flag silently dropped at this seam is the failure mode: the engine would serve
   * the rendered projection and the caller would have no way to tell.
   */
  describe('source mode', () => {
    it('passes source through to the engine as an explicit flag', async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      const tool = (await import('../get')).default;
      await tool.handler({ slugs: ['p1'], source: true } as never, { harnessSlug: 'sheets' } as never);
      expect(getDocs).toHaveBeenCalledWith(expect.anything(), { slugs: ['p1'], source: true }, expect.anything());
    });

    it('CONTROL: omits the key entirely when source is not asked for', async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      const tool = (await import('../get')).default;
      await tool.handler({ slugs: ['p1'] } as never, { harnessSlug: 'sheets' } as never);
      expect(getDocs).toHaveBeenCalledWith(expect.anything(), { slugs: ['p1'] }, expect.anything());
    });

    it('args schema REJECTS source + heading — a slice is not the document', async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({ slugs: ['a'], heading: 'sec-1', source: true });
      expect(parsed.success).toBe(false);
      // Controls: each half alone is valid, so the refusal is about the COMBINATION
      // and not about either field being rejected outright.
      expect(mod.default.args.safeParse({ slugs: ['a'], source: true }).success).toBe(true);
      expect(mod.default.args.safeParse({ slugs: ['a'], heading: 'sec-1' }).success).toBe(true);
    });

    it('args schema accepts source together with offset — paging a large doc whole', async () => {
      const mod = await import('../get');
      expect(mod.default.args.safeParse({ slugs: ['a'], source: true, offset: 50_000 }).success).toBe(true);
    });
  });
});

/**
 * WI-1985 — docs:get failed ~35% of calls (68/118 in 48h), EVERY failure the same
 * shape: "slugs: Invalid input: expected array, received undefined" — an agent
 * passing a bare singular `slug` or a string `slugs`. We coerce those into the
 * `slugs:[]` array BEFORE validation (never rejecting a well-intentioned read),
 * while leaving a well-formed array — and the published schema — untouched.
 */
describe('docs:get slug coercion (WI-1985)', () => {
  describe('coerceDocsGetSlugs (unit)', () => {
    it('leaves a well-formed slugs array untouched (identity)', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      const input = { slugs: ['endpoint-system/overview'] };
      expect(coerceDocsGetSlugs(input)).toBe(input); // same reference, no clone
    });

    it('maps a singular `slug` string → slugs:[…], dropping the bad key', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slug: 'endpoint-system/overview' })).toEqual({
        slugs: ['endpoint-system/overview'],
      });
    });

    it('maps a string-valued `slugs` → a one-element array', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slugs: 'testing/agent-e2e' })).toEqual({ slugs: ['testing/agent-e2e'] });
    });

    it('normalizes a projected `.mdx` ref to the extensionless Starlight slug', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slugs: ['agent-insights/current-refresh.mdx'] })).toEqual({
        slugs: ['agent-insights/current-refresh'],
      });
      expect(coerceDocsGetSlugs({ slug: 'agent-insights/current-refresh.md' })).toEqual({
        slugs: ['agent-insights/current-refresh'],
      });
    });

    it('keeps docs URL and content-root refs route-neutral during coercion', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(
        coerceDocsGetSlugs({
          slugs: [
            'docs/design/index',
            'docs/design/gotchas',
            '/internal/docs/design',
            'apps/operator-docs/src/content/docs/design/index.mdx',
          ],
        }),
      ).toEqual({
        slugs: [
          'docs/design/index',
          'docs/design/gotchas',
          '/internal/docs/design',
          'apps/operator-docs/src/content/docs/design/index',
        ],
      });
    });

    it('maps engineering URL and content-root refs only with the engineering normalizer', async () => {
      const { normalizeEngineeringDocsGetRef } = await import('../get-coerce');
      expect(
        [
          'docs/design/index',
          'docs/design/gotchas',
          '/internal/docs/design',
          'apps/operator-docs/src/content/docs/design/index.mdx',
        ].map(normalizeEngineeringDocsGetRef),
      ).toEqual(['design', 'design/gotchas', 'design', 'design']);
    });

    it('splits a comma/space-separated slug string into multiple slugs', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slug: 'a/b, c/d  e/f' })).toEqual({ slugs: ['a/b', 'c/d', 'e/f'] });
    });

    it('preserves a caller `harness`/`heading` while salvaging the slug', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slug: 'p/one', harness: 'all', heading: 'sec-1' })).toEqual({
        slugs: ['p/one'],
        harness: 'all',
        heading: 'sec-1',
      });
    });

    it('prefers a usable `slugs` over the singular `slug`', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ slugs: 'keep/this', slug: 'drop/this' })).toEqual({ slugs: ['keep/this'] });
    });

    it('leaves an unsalvageable object alone (no slug/slugs) so the schema errors normally', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs({ harness: 'all' })).toEqual({ harness: 'all' });
    });

    it('passes a non-object through untouched', async () => {
      const { coerceDocsGetSlugs } = await import('../get-coerce');
      expect(coerceDocsGetSlugs('x')).toBe('x');
      expect(coerceDocsGetSlugs(null)).toBe(null);
      expect(coerceDocsGetSlugs(['a'])).toEqual(['a']);
    });
  });

  describe('through the real args schema (the wire shapes that 400ed now parse)', () => {
    it("a singular slug parses to slugs:[…] (was: 'expected array, received undefined')", async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({ slug: 'endpoint-system/overview' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.slugs).toEqual(['endpoint-system/overview']);
    });

    it('a string-valued slugs parses to a one-element array', async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({ slugs: 'testing/agent-e2e' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.slugs).toEqual(['testing/agent-e2e']);
    });

    it('preserves docs URL refs through the route-neutral args schema', async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({
        slugs: ['docs/design/index', '/internal/docs/design/gotchas'],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.slugs).toEqual(['docs/design/index', '/internal/docs/design/gotchas']);
    });

    it('a singular slug + heading still parses (single-slug heading path preserved)', async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({ slug: 'p/one', heading: 'sec-1' });
      expect(parsed.success).toBe(true);
    });

    it('the heading-with-multiple-slugs refine STILL fires after coercion', async () => {
      const mod = await import('../get');
      // singular slug carrying a comma → 2 slugs + a heading → refine rejects.
      expect(mod.default.args.safeParse({ slug: 'a/b, c/d', heading: 'x' }).success).toBe(false);
    });

    it('a well-formed slugs array is unaffected', async () => {
      const mod = await import('../get');
      const parsed = mod.default.args.safeParse({ slugs: ['a/b', 'c/d'] });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.slugs).toEqual(['a/b', 'c/d']);
    });

    it('an object with no slug at all still fails (coercion never fabricates a slug)', async () => {
      const mod = await import('../get');
      expect(mod.default.args.safeParse({ harness: 'all' }).success).toBe(false);
    });
  });

  it('the published tools/list JSON schema still advertises slugs as a string array', async () => {
    const mod = await import('../get');
    const json = z.toJSONSchema(mod.default.args as never) as {
      properties?: { slugs?: { type?: string; items?: { type?: string } } };
    };
    expect(json.properties?.slugs?.type).toBe('array');
    expect(json.properties?.slugs?.items?.type).toBe('string');
  });
});

describe('docs:search handler', () => {
  it('opts out of the ambient workspace transaction during filesystem and semantic search', async () => {
    const tool = (await import('../search')).default;
    expect((tool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('harness_required gate fires with no engine call', async () => {
    mockRegistry([]);
    const tool = (await import('../search')).default;
    const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: '*' } as never);
    expect(textResult(res).isError).toBe(true);
    expect(payloadOf(res).error).toBe('harness_required');
    expect(searchDocs).not.toHaveBeenCalled();
  });

  it('happy path wraps the engine response with surface', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../search')).default;
    const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: 'sheets' } as never);
    const p = payloadOf(res);
    expect(p.surface).toBe('harness');
    expect(p.hits[0].slug).toBe('p1');
    // Called, but NOT an exact count. These are handler-pipeline tests; how many
    // queries the engine issues is the engine's business, and `lexicalCascade`
    // (libs/generic/search hybrid.ts) legitimately fires a SECOND widening query
    // whenever stage 1 under-fills `limit` — which this 1-hit mock vs limit:8
    // always does. The meaningful contrast is the `not.toHaveBeenCalled()` gate
    // test above; asserting an exact count here only re-coupled this file to
    // engine internals it does not test.
    expect(searchDocs).toHaveBeenCalled();
  });

  it('records separate docs-search phase timings, including the semantic section query', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    resolveDocsEmbedder.mockResolvedValueOnce({
      embedder: async () => [0.1, 0.2],
      embeddingMode: 'test',
    });
    docSectionsRanker.mockReturnValueOnce(async () => []);
    const tool = (await import('../search')).default;
    const metadata = vi.fn();

    const res = await tool.handler(
      { query: 'auth flow', limit: 8, semantic: true } as never,
      { harnessSlug: 'sheets', metadata } as never,
    );

    expect(payloadOf(res).surface).toBe('harness');
    const metadataCalls = metadata.mock.calls as Array<[Record<string, unknown>]>;
    const timing = metadataCalls.at(-1)?.[0].docsSearchTiming as {
      version: number;
      active: unknown[];
      completedMs: Record<string, number>;
    };
    expect(timing.version).toBe(1);
    expect(timing.active).toEqual([]);
    expect(timing.completedMs).toEqual(
      expect.objectContaining({
        adapterResolution: expect.any(Number),
        embedderResolution: expect.any(Number),
        lexicalSearch: expect.any(Number),
        docSectionsQuery: expect.any(Number),
        hybridSearch: expect.any(Number),
        packageDocHits: expect.any(Number),
        embedCoverage: expect.any(Number),
      }),
    );
    expect(JSON.stringify(timing)).not.toContain('auth flow');
  });

  it('publishes partial lexical diagnostics before search settles and preserves earlier engine metadata', async () => {
    vi.useFakeTimers();
    try {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      let releaseSearch!: () => void;
      const lexicalTiming = { version: 1, active: { phase: 'getContent' }, pages: { loaded: 25 } };
      searchDocs.mockImplementationOnce(async (...params: unknown[]) => {
        const engineCtx = params[2] as { metadata: (data: Record<string, unknown>) => void };
        engineCtx.metadata({ non_searchable_excluded: 2 });
        engineCtx.metadata({ docsLexicalTiming: lexicalTiming });
        return await new Promise(resolve => {
          releaseSearch = () => resolve({ hits: [{ slug: 'p1', title: 'P1', excerpt: 'ex' }] });
        });
      });
      const tool = (await import('../search')).default;
      const metadata = vi.fn();
      const pending = tool.handler(
        { query: 'private query', limit: 8, semantic: false } as never,
        { harnessSlug: 'sheets', metadata } as never,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(metadata.mock.lastCall?.[0]).toMatchObject({
        non_searchable_excluded: 2,
        docsLexicalTiming: lexicalTiming,
        docsSearchTiming: { active: expect.arrayContaining([expect.objectContaining({ phase: 'lexicalSearch' })]) },
      });
      releaseSearch();
      await pending;
      expect(metadata.mock.lastCall?.[0]).toMatchObject({ non_searchable_excluded: 2, docsLexicalTiming: lexicalTiming });
    } finally { vi.useRealTimers(); }
  });

  it('logs one query-free breadcrumb when a search phase stays pending past the diagnostic threshold', async () => {
    vi.useFakeTimers();
    try {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      let releaseSearch: (() => void) | undefined;
      searchDocs.mockImplementationOnce(
        async (...params: unknown[]) => {
          const engineCtx = params[2] as { metadata: (data: Record<string, unknown>) => void };
          setTimeout(() => engineCtx.metadata({ docsLexicalTiming: {
            version: 1,
            totalElapsedMs: 19_999,
            outcome: 'running',
            completedMs: { listPages: 10 },
            active: { phase: 'getContent', elapsedMs: 19_989 },
            pages: { listed: 37, searchable: 33, loaded: 12 },
          } }), 19_999);
          return await new Promise((resolve) => {
            releaseSearch = () => {
              engineCtx.metadata({ docsLexicalTiming: {
                version: 1,
                totalElapsedMs: 20_000,
                outcome: 'complete',
                completedMs: { listPages: 10, getContent: 19_900, ranking: 90 },
                active: null,
                pages: { listed: 37, searchable: 33, loaded: 33 },
              } });
              resolve({ hits: [{ slug: 'p1', title: 'P1', excerpt: 'ex' }] });
            };
          });
        },
      );
      const tool = (await import('../search')).default;
      const log = vi.fn();
      const pending = tool.handler(
        { query: 'private query text', limit: 8 } as never,
        { harnessSlug: 'sheets', log } as never,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(searchDocs).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          '[docs:search timing] lexicalSearch still pending after at least 20000ms; docsLexicalTiming',
        ),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        'total=19999ms outcome=running phases=listPages=10ms active=getContent:19989ms pages=37/33/12',
      ));

      releaseSearch?.();
      await pending;
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/lexicalSearch completed in \d+ms/));
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        'docsLexicalTiming total=20000ms outcome=complete phases=listPages=10ms,getContent=19900ms,ranking=90ms pages=37/33/33',
      ));
      expect(log.mock.calls.flat().join(' ')).not.toContain('private query text');
    } finally {
      vi.useRealTimers();
    }
  });

  it('project surface when PAPERCUSP_PROJECT_DOCS_ROOT is set and arg is "all"', async () => {
    process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/proj-docs';
    mockRegistry([]);
    const tool = (await import('../search')).default;
    const res = await tool.handler(
      { query: 'auth flow', limit: 8, harness: 'all' } as never,
      { harnessSlug: '*' } as never,
    );
    expect(payloadOf(res).surface).toBe('project');
    // >=1, not an exact count — see the lexicalCascade note on the happy-path test.
    expect(searchDocs).toHaveBeenCalled();
  });

  // ⛔ RECURRENCE GUARD — the query-COUNT invariant, given a home of its own.
  //
  // The two tests above deliberately stopped asserting an exact count (they are
  // handler-pipeline tests and the count is engine business). That is a fair
  // call for THEM, but it left the count unguarded, and the count is a real
  // contract for this source — so it gets its own test rather than riding along
  // as someone else's side-assertion.
  //
  // WHAT BROKE (green-checkpoint red, candidate 4c379d2a): the leg rename
  // bm25 -> lexical (f9ed5eb4f3) reconnected this source to the engine's lexical
  // leg and thereby opted it into `lexicalWithCascade`, which re-queries with
  // `lexicalMode: 'coverage-graded'` whenever stage 1 under-fills. For a source
  // that IMPLEMENTS the mode (the PG-backed agent-tools/search/sources.ts) that
  // second query is a genuine widening. This source does not: `lexical()`
  // destructures only `limit`, and the docs-engine has no `lexicalMode` concept
  // at all — so stage 2 re-issues a request byte-identical to stage 1, every row
  // comes back already in the engine's `seen` set, and `stage2Added` is 0 BY
  // CONSTRUCTION. Net effect: every under-filled docs:search paid two identical
  // filesystem searches for zero extra rows. `search.ts` opts out with
  // `lexicalCascade: false`; this test is what fails if that opt-out is dropped.
  it('issues exactly ONE engine query even when stage 1 under-fills (cascade opted out)', async () => {
    mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
    const tool = (await import('../search')).default;
    await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: 'sheets' } as never);

    // CALIBRATION FIRST — without this the assertion below can pass for the
    // wrong reason. The cascade only arms when stage 1 returns FEWER rows than
    // the candidate limit it was asked for; a future mock that returns enough
    // hits to fill that limit would leave the cascade dormant anyway, and this
    // test would then be guarding nothing while still reporting green.
    const calls = vi.mocked(searchDocs).mock.calls as unknown as Array<[unknown, { limit: number }]>;
    const requestedLimit = calls[0][1].limit;
    const stage1 = (await vi.mocked(searchDocs).mock.results[0].value) as { hits: unknown[] };
    expect(stage1.hits.length).toBeLessThan(requestedLimit);

    expect(searchDocs).toHaveBeenCalledTimes(1);
  });

  it('args schema enforces query min length 2', async () => {
    const mod = await import('../search');
    expect(mod.default.args.safeParse({ query: 'a' }).success).toBe(false);
    expect(mod.default.args.safeParse({ query: 'ab' }).success).toBe(true);
  });

  it('accepts legacy q and normalizes it to the canonical query arg', async () => {
    const mod = await import('../search');
    const parsed = mod.default.args.safeParse({ q: 'auth flow' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toBe('auth flow');
      expect(parsed.data).not.toHaveProperty('q');
    }
  });

  it('prefers query over legacy q when both spellings are supplied', async () => {
    const mod = await import('../search');
    const parsed = mod.default.args.safeParse({ query: 'canonical term', q: 'legacy term' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.query).toBe('canonical term');
      expect(parsed.data).not.toHaveProperty('q');
    }
  });

  // EI-18804433041289369: a harness-scoped search (the natural, "pass my own harness slug" call) does
  // NOT reach agent-insights/ — a caller who does not know that reads "no hits I recognize" as "no such
  // page exists". A `scopeNote` on every non-engineering-surface response makes that scope explicit
  // instead of silent, even on a NON-empty result (the reported incident had 37 hits, just none of them
  // agent-insights).
  describe('scopeNote (EI-18804433041289369)', () => {
    it("harness surface → scopeNote present, names the surface and the harness:'all' retry", async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      const tool = (await import('../search')).default;
      const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: 'sheets' } as never);
      const p = payloadOf(res);
      expect(p.surface).toBe('harness');
      expect(typeof p.scopeNote).toBe('string');
      expect(p.scopeNote).toMatch(/agent-insights/);
      expect(p.scopeNote).toMatch(/harness:'all'/);
    });

    it('project surface → scopeNote present too (also excludes agent-insights)', async () => {
      process.env.PAPERCUSP_PROJECT_DOCS_ROOT = '/tmp/proj-docs';
      mockRegistry([]);
      const tool = (await import('../search')).default;
      const res = await tool.handler(
        { query: 'auth flow', limit: 8, harness: 'all' } as never,
        { harnessSlug: '*' } as never,
      );
      const p = payloadOf(res);
      expect(p.surface).toBe('project');
      expect(typeof p.scopeNote).toBe('string');
    });

    it('engineering surface (the agent-insights corpus itself) → NO scopeNote', async () => {
      mockRegistry([]);
      const tool = (await import('../search')).default;
      const res = await tool.handler(
        { query: 'auth flow', limit: 8, harness: 'all' } as never,
        { harnessSlug: '*', isSuperuser: true } as never,
      );
      const p = payloadOf(res);
      expect(p.surface).toBe('engineering');
      expect(p.scopeNote).toBeUndefined();
    });

    it("names the harness:'engineering' escape (workspace-scoped-safe) alongside harness:'all'", async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      const tool = (await import('../search')).default;
      const res = await tool.handler({ query: 'auth flow', limit: 8 } as never, { harnessSlug: 'sheets' } as never);
      expect(payloadOf(res).scopeNote).toMatch(/harness:'engineering'/);
    });
  });

  describe('retirement/currentness authority route (P-005 / D-006)', () => {
    it('injects exact-slug current authority ahead of a historical plan hit', async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      searchDocs
        .mockResolvedValueOnce({
          query: 'Queen Mug Kettle retired current work assignment wake agent',
          tokenCount: 9,
          hitCount: 1,
          hits: [
            {
              slug: 'docs/plans/sentinel-tui-shared-backend-and-cards-2026-06-22',
              title: 'Historical Queen architecture',
              excerpt: 'The Queen surveys the backlog and places bees.',
              score: 99,
            },
          ],
        })
        .mockResolvedValueOnce({
          query: 'agent-insights/mug-kettle-cup-tier-is-retired',
          tokenCount: 7,
          hitCount: 1,
          hits: [
            {
              slug: 'agent-insights/mug-kettle-cup-tier-is-retired',
              title: 'The Mug · Kettle · Cup tier is RETIRED',
              excerpt: 'su + GOAL mode are the current replacement.',
              score: 1000,
            },
          ],
        });

      const tool = (await import('../search')).default;
      const res = await tool.handler(
        { query: 'Queen Mug Kettle retired current work assignment wake agent', limit: 8 } as never,
        { harnessSlug: 'sheets', isSuperuser: true } as never,
      );
      const p = payloadOf(res);

      expect(searchDocs).toHaveBeenCalledTimes(2);
      const calls = vi.mocked(searchDocs).mock.calls as unknown as Array<[unknown, { query: string; limit: number }]>;
      expect(calls[1][1]).toMatchObject({
        query: 'agent-insights/mug-kettle-cup-tier-is-retired',
        limit: 1,
      });
      expect(p.currentAuthority).toMatchObject({
        slug: 'agent-insights/mug-kettle-cup-tier-is-retired',
        authority: 'current',
        surface: 'engineering',
      });
      expect(p.hits.map((entry: { slug: string }) => entry.slug)).toEqual([
        'agent-insights/mug-kettle-cup-tier-is-retired',
        'docs/plans/sentinel-tui-shared-backend-and-cards-2026-06-22',
      ]);
      expect(p.hits[1]).toMatchObject({ historical: true });
      expect(p.crossSurface).toMatchObject({ surface: 'engineering', mode: 'authority-lookup' });
      expect(p.crossSurface.why).toMatch(/historical plan material/);
      expect(p.scopeNote).toMatch(/canonical engineering authority/);
      expect(p.scopeNote).not.toMatch(/semantic leg matched NOTHING/);
    });
  });

  // EI-18894866320087268: harness:'all' is REJECTED with harness_forbidden at the transport
  // layer for a workspace-scoped session; 'engineering' is a distinct literal that is NOT
  // intercepted by that clamp and reaches the same corpus — even when ctx.harnessSlug is a
  // concrete harness (the workspace-scoped shape), and it must not be looked up as a harness slug.
  describe("'engineering' sentinel (EI-18894866320087268)", () => {
    it("harness:'engineering' from a workspace-scoped ctx reaches the engineering surface, not harness_not_registered", async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]); // no harness named "engineering" registered
      const tool = (await import('../search')).default;
      const res = await tool.handler(
        { query: 'auth flow', limit: 8, harness: 'engineering' } as never,
        { harnessSlug: 'sheets', isSuperuser: true } as never,
      );
      const p = payloadOf(res);
      expect(p.surface).toBe('engineering');
      expect(p.error).toBeUndefined();
      // >=1, not an exact count — see the lexicalCascade note on the happy-path test.
      expect(searchDocs).toHaveBeenCalled();
    });

    it("harness:'engineering' without isSuperuser → no_docs_source (same gate as harness:'all')", async () => {
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      const tool = (await import('../search')).default;
      const res = await tool.handler(
        { query: 'auth flow', limit: 8, harness: 'engineering' } as never,
        { harnessSlug: 'sheets' } as never,
      );
      expect(textResult(res).isError).toBe(true);
      expect(payloadOf(res).error).toBe('no_docs_source');
    });
  });

  // ── CH3: the result-limit guard. The engine truncates to `limit` hits
  //    (searchDocs slices to args.limit), so the tool must bound it: default 8,
  //    floor 1, hard cap 20 — an unbounded limit can't drag the whole corpus.
  describe('result limit (CH3)', () => {
    it('defaults limit to 8 when unspecified', async () => {
      const mod = await import('../search');
      const parsed = mod.default.args.safeParse({ query: 'auth' });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.limit).toBe(8);
    });

    it('accepts the boundary 1 and 20 but rejects 0 and >20', async () => {
      const mod = await import('../search');
      expect(mod.default.args.safeParse({ query: 'auth', limit: 1 }).success).toBe(true);
      expect(mod.default.args.safeParse({ query: 'auth', limit: 20 }).success).toBe(true);
      expect(mod.default.args.safeParse({ query: 'auth', limit: 0 }).success).toBe(false);
      expect(mod.default.args.safeParse({ query: 'auth', limit: 21 }).success).toBe(false);
      expect(mod.default.args.safeParse({ query: 'auth', limit: 5000 }).success).toBe(false);
    });

    it('over-fetches the engine past the caller limit (RRF headroom), but still truncates the FINAL result to it', async () => {
      // WI-5690: the engine is now over-fetched (limit*3, floor 30) so RRF
      // fusion with the semantic leg has real candidates to promote above the
      // cut — searchDocs no longer receives the caller's raw limit directly.
      // The result-limit guard this test class exists for (CH3) now applies
      // POST-fusion instead, so assert both halves: the over-fetch call, and
      // the final truncation to the caller's `limit`.
      mockRegistry([{ slug: 'sheets', path: '/tmp/h' }]);
      searchDocs.mockResolvedValueOnce({
        hits: [
          { slug: 'p1', title: 'P1', excerpt: 'ex', score: 5 },
          { slug: 'p2', title: 'P2', excerpt: 'ex', score: 4 },
          { slug: 'p3', title: 'P3', excerpt: 'ex', score: 3 },
          { slug: 'p4', title: 'P4', excerpt: 'ex', score: 2 },
          { slug: 'p5', title: 'P5', excerpt: 'ex', score: 1 },
        ],
        hitCount: 5,
        tokenCount: 2,
        query: 'auth flow',
      });
      const tool = (await import('../search')).default;
      const res = await tool.handler({ query: 'auth flow', limit: 3 } as never, { harnessSlug: 'sheets' } as never);
      // searchDocs(adapter, args, ctx) — args carries the OVER-FETCHED limit
      // (Math.max(3*3, 30) = 30), not the raw caller limit.
      expect(searchDocs).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 30 }),
        expect.anything(),
      );
      const p = payloadOf(res);
      expect(p.hits).toHaveLength(3);
      expect(p.hits.map((h: { slug: string }) => h.slug)).toEqual(['p1', 'p2', 'p3']);
    });
  });
});
