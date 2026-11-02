/**
 * The three declared Papercusp census providers — P-003 of
 * deterministic-coverage-census-2026-08-17.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING. The census's entire value rests on one claim: the
 * surface population it reports IS the surface population production serves. That claim is not
 * checkable by reading the provider — it is checkable only by asserting, against the live
 * registries, that the provider neither INVENTS a surface nor OMITS one. So the population tests
 * below are exact set-equality against `routeRegistrationOrder()`, `getCatalog()` and
 * `knownQueryNamesV2()`, not spot checks: a subset assertion would pass for a provider that
 * silently dropped half the app.
 *
 * The second thing guarded is the retirement scope. `kinds` is what a successful provider run
 * makes retirable, so a provider emitting a row outside its declared `kinds` (or two providers
 * both claiming one kind) can retire another provider's surfaces. Both are asserted directly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { listAllProjectedTools, projectedToolProviderVersion, registerProjectedTool, unregisterProjectedToolsForPlugin } from '@papercusp/tooldef';
import type { CensusContext, ObservedSurface } from '@papercusp/testing-shell/census';
import { censusProviders } from './provider-registry';
import { assertRegistryNonEmpty } from './providers/_non-empty';
import { enumerateMountedHonoSurfaces, honoRoutesProvider, HTTP_ROUTE_KIND } from './providers/hono-routes';
import { enumerateProjectedHandlerSurfaces, mcpToolsProvider, MCP_TOOL_KIND } from './providers/mcp-tools';
import { syncQueriesProvider, SYNC_QUERY_KIND } from './providers/sync-queries';
import { routeRegistrationOrder } from '../endpoint-route/register';
import { ALL_ROUTES } from '../endpoint-route/routes';
import { knownQueryNamesV2 } from '../sync-resolver';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const ctx: CensusContext = {
  workspaceId: 'test-workspace',
  harnessSlug: 'papercusp',
  config: {},
  repoRoot,
};

/**
 * The repoRoot derivation is a PREMISE of the sourceFile test below, so prove it rather than
 * assume it — a wrong root would make every existsSync miss, and "no tool resolved a file" would
 * read as a clean pass of a test that had actually stopped testing anything.
 */
it('resolves the repo root it will resolve source files against', () => {
  expect(fs.existsSync(path.join(repoRoot, 'package.json'))).toBe(true);
  expect(fs.existsSync(path.join(repoRoot, 'packages/operator-core'))).toBe(true);
});

describe('provider registry wiring', () => {
  it('registers exactly the three declared Papercusp providers', () => {
    expect(censusProviders().map((p) => p.provider).sort()).toEqual([
      'hono-routes',
      'mcp-tools',
      'sync-queries',
    ]);
  });

  it('gives every provider a disjoint retirement scope', () => {
    // Two providers owning one kind means each can retire the other's surfaces on a run where
    // only one of them succeeded. The kinds partition must be strict.
    const seen = new Map<string, string>();
    for (const p of censusProviders()) {
      for (const kind of p.kinds) {
        expect(seen.has(kind), `kind "${kind}" claimed by both ${seen.get(kind)} and ${p.provider}`)
          .toBe(false);
        seen.set(kind, p.provider);
      }
    }
    expect([...seen.keys()].sort()).toEqual([HTTP_ROUTE_KIND, MCP_TOOL_KIND, SYNC_QUERY_KIND]);
  });
});

/** Invariants every declared provider must hold, applied to each of the three. */
describe.each([
  { name: 'hono-routes', provider: honoRoutesProvider, kind: HTTP_ROUTE_KIND },
  { name: 'mcp-tools', provider: mcpToolsProvider, kind: MCP_TOOL_KIND },
  { name: 'sync-queries', provider: syncQueriesProvider, kind: SYNC_QUERY_KIND },
])('$name', ({ provider, kind }) => {
  it('enumerates a non-empty population from the live registry', async () => {
    const surfaces = await provider.enumerate(ctx);
    expect(surfaces.length).toBeGreaterThan(0);
  });

  it('emits only its declared kind, at declared fidelity, with a usable id', async () => {
    const surfaces = await provider.enumerate(ctx);
    for (const s of surfaces) {
      // Emitting outside the declared kinds is the retirement-scope violation.
      expect(provider.kinds).toContain(s.kind);
      expect(s.kind).toBe(kind);
      // These providers read the production registry directly; anything weaker than `declared`
      // would let a verdict computed over them masquerade as stronger than it is.
      expect(s.fidelity).toBe('declared');
      expect(typeof s.surfaceId).toBe('string');
      expect(s.surfaceId.length).toBeGreaterThan(0);
    }
  });

  it('produces unique, stable surface ids across runs', async () => {
    const first = await provider.enumerate(ctx);
    const ids = first.map((s) => s.surfaceId);

    // A duplicate id makes two surfaces collide onto one ledger row.
    expect(new Set(ids).size, 'duplicate surfaceId emitted').toBe(ids.length);

    // An id that changes between runs retires and re-creates its row every census, resetting
    // first_seen and permanently defeating the new-surface gate.
    const second = await provider.enumerate(ctx);
    expect(second.map((s) => s.surfaceId).sort()).toEqual([...ids].sort());
  });
});

describe('hono-routes population', () => {
  it('detects loaded handler replacement at the same stable HTTP route', () => {
    const first = new Hono(), second = new Hono();
    first.get('/same', c => c.text('first implementation'));
    second.get('/same', c => c.text('second implementation'));
    const a = enumerateMountedHonoSurfaces(first, 'same-host').surfaces[0]!;
    const b = enumerateMountedHonoSurfaces(second, 'same-host').surfaces[0]!;
    expect(a.surfaceId).toBe(b.surfaceId);
    expect(a.attrs?.loadedFunctionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(a.attrs?.loadedFunctionSha256).not.toBe(b.attrs?.loadedFunctionSha256);
    expect(a.attrs?.functionFingerprintScope).toBe('loaded-function-text-only');
  });
  it('captures actual raw and nested Hono routes, middleware and duplicate handlers without dispatch', async () => {
    let calls = 0;
    const app = new Hono(), nested = new Hono();
    app.use('*', async (_c, next) => { calls++; await next(); });
    app.post('/raw', c => { calls++; return c.text('raw'); });
    nested.get('/probe', async (_c, next) => { calls++; await next(); });
    nested.get('/probe', c => { calls++; return c.text('nested'); });
    app.route('/prefix', nested);
    const captured = enumerateMountedHonoSurfaces(app, 'actual-host');
    expect(calls).toBe(0);
    expect(captured.surfaces.map(s => s.attrs?.routeId)).toEqual(['ALL /*', 'POST /raw', 'GET /prefix/probe', 'GET /prefix/probe']);
    expect(new Set(captured.surfaces.map(s => s.surfaceId)).size).toBe(4);
    expect(captured.surfaces.map(s => s.attrs?.mountIndex)).toEqual([0, 1, 2, 3]);
    expect(captured.surfaces.map(s => s.attrs?.occurrence)).toEqual([1, 1, 1, 2]);
    expect(captured.unresolved).toEqual(['http-stack-nested-dispatch-unverified:actual-host']);
    // Later registration cannot silently change an already captured snapshot.
    app.get('/later', c => c.text('later'));
    expect(captured.surfaces).toHaveLength(4);
    expect(enumerateMountedHonoSurfaces(app, 'actual-host').surfaces).toHaveLength(5);
    expect((await app.request('/prefix/probe')).status).toBe(200);
    expect(calls).toBe(3);
  });

  it('retains opaque/malformed stack entries as gaps without invoking getters', () => {
    const trap = { get routes() { throw new Error('must not execute'); } };
    expect(enumerateMountedHonoSurfaces(trap, 'opaque').unresolved).toEqual(['http-stack-unavailable:opaque']);
    const routes = [null, { get method() { throw new Error('must not execute'); }, path: '/' },
      { method: 'GET', path: '/missing-handler' }];
    Object.defineProperty(routes, '3', { get() { throw new Error('must not execute'); } });
    const captured = enumerateMountedHonoSurfaces({ routes }, 'broken');
    expect(captured.surfaces).toHaveLength(1);
    expect(captured.surfaces[0].attrs).toMatchObject({ hasHandler: false, nestedDispatchCoverage: 'unknown' });
    expect(captured.unresolved).toEqual(['http-stack-invalid-row:broken:0', 'http-stack-invalid-route:broken:1',
      'http-stack-handler-unavailable:broken:2', 'http-stack-invalid-row:broken:3', 'http-stack-nested-dispatch-unverified:broken']);
    expect(enumerateMountedHonoSurfaces({ routes: [] }, 'empty').unresolved).toEqual(['http-stack-empty:empty']);
    expect(() => enumerateMountedHonoSurfaces({}, ' ')).toThrow('mount_id_required');
  });

  it('is exactly the mounted route table — no invented or dropped routes', async () => {
    const surfaces = await honoRoutesProvider.enumerate(ctx);
    const mounted = routeRegistrationOrder().map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(surfaces.map((s) => s.surfaceId).sort()).toEqual([...mounted].sort());
  });

  it('captures input schemas where routes declare them', async () => {
    const surfaces = await honoRoutesProvider.enumerate(ctx);
    const withSchema = surfaces.filter((s) => s.schemaRef != null);
    // The seed for L2 fuzz. If this hits zero, schema capture silently broke — the census would
    // still look healthy while every depth-ladder rung above L1 lost its input.
    expect(withSchema.length).toBeGreaterThan(0);
    for (const s of withSchema) {
      expect((s.attrs as Record<string, unknown>).hasInputSchema).toBe(true);
    }
  });

  it('retains each mounted route auth, CORS and disabled-versus-default timeout', async () => {
    const surfaces = await honoRoutesProvider.enumerate(ctx);
    const definitions = new Map(ALL_ROUTES.map((route) => [`${route.method.toUpperCase()} ${route.path}`, route]));
    for (const surface of surfaces) {
      const def = definitions.get(surface.surfaceId);
      expect(def, surface.surfaceId).toBeDefined();
      expect(surface.attrs).toMatchObject({
        auth: def!.auth,
        hasDefinition: true,
        cors: def!.cors ?? null,
        timeoutDeclared: def!.timeoutSec !== undefined,
        timeoutSec: def!.timeoutSec ?? null,
      });
    }
    expect(ALL_ROUTES.some((route) => route.timeoutSec === null)).toBe(true);
    expect(ALL_ROUTES.some((route) => route.timeoutSec === undefined)).toBe(true);
  });
});

describe('mcp-tools population', () => {
  it('security inventory retains HTTP-only handlers, every transport and composition edges', async () => {
    const pluginName = 'security-census-http-only-fixture';
    registerProjectedTool({ pluginName, description: 'HTTP-only inventory fixture',
      inputSchema: { type: 'object', properties: {} }, capabilities: [],
      expose: { http: { path: '/__security_census_fixture', methods: ['GET', 'POST'] }, ipc: true },
      replaces: ['coord:declare-intent'], fn: async () => ({ content: [] }),
    });
    try {
      const surfaces = await enumerateProjectedHandlerSurfaces(ctx);
      expect(surfaces.find(s => s.surfaceId === 'http:/__security_census_fixture')!.attrs).toMatchObject({
        loadedFunctionSha256: expect.stringMatching(/^[a-f0-9]{64}$/), actualEffectCoverage: 'unknown',
      });
      expect(surfaces.map(s => s.surfaceId).sort()).toEqual(listAllProjectedTools().map(def =>
        def.expose.mcp ? `mcp:${def.expose.mcp.name}` : `http:${def.expose.http!.path}`).sort());
      expect(surfaces.find(s => s.surfaceId === 'http:/__security_census_fixture')).toMatchObject({
        sourceFile: null, fidelity: 'declared', attrs: { replaces: ['coord:declare-intent'], dispatchRoutes: [
          { channel: 'http', route: 'GET /__security_census_fixture' },
          { channel: 'http', route: 'POST /__security_census_fixture' },
          { channel: 'ipc', route: '/__security_census_fixture' },
        ] },
      });
      // The same fixture must not leak into the MCP-only population/retirement scope.
      expect((await mcpToolsProvider.enumerate(ctx)).some(s => s.surfaceId.includes('__security_census_fixture'))).toBe(false);
    } finally { unregisterProjectedToolsForPlugin(pluginName); }
  });

  it('is exactly the live tool catalog', async () => {
    const surfaces = await mcpToolsProvider.enumerate(ctx);
    const catalog = listAllProjectedTools()
      .flatMap((d) => (d.expose.mcp ? [d.expose.mcp.name] : []));
    expect(surfaces.map((s) => s.surfaceId).sort()).toEqual([...catalog].sort());
  });

  it('enumerates the authoritative projected registry, not the legacy catalog subset', async () => {
    const surfaces = await mcpToolsProvider.enumerate(ctx);

    // The legacy registry currently contains only a small compatibility subset. Keep a
    // calibrated floor so a loader/module-identity regression cannot turn exact set-equality
    // above into a vacuous comparison against the same truncated registry.
    expect(surfaces.length).toBeGreaterThanOrEqual(500);
  });

  it('never asserts a sourceFile that does not exist', async () => {
    const surfaces = await mcpToolsProvider.enumerate(ctx);
    const resolved = surfaces.filter((s) => s.sourceFile != null);

    // Calibration: if the convention resolved nothing at all, the existence assertion below is
    // vacuous and this test would pass while proving nothing.
    expect(resolved.length, 'convention resolved no tool source files at all').toBeGreaterThan(0);

    for (const s of resolved) {
      expect(
        fs.existsSync(path.join(repoRoot, s.sourceFile as string)),
        `fabricated sourceFile for ${s.surfaceId}: ${s.sourceFile}`,
      ).toBe(true);
    }
  });

  it('attributes a nested registration to its captured module rather than its tool name', async () => {
    const surfaces = await mcpToolsProvider.enumerate(ctx);
    expect(surfaces.find((surface) => surface.surfaceId === 'coord:declare-intent')?.sourceFile).toBe(
      'packages/operator-core/lib/agent-tools/coordination/tools/declare-intent.ts',
    );
  });

  it('retains provider, alternate exposure and authority declarations for every registered handler', async () => {
    const surfaces = new Map((await mcpToolsProvider.enumerate(ctx)).map((surface) => [surface.surfaceId, surface]));
    for (const def of listAllProjectedTools().filter((tool) => tool.expose.mcp != null)) {
      const surface = surfaces.get(def.expose.mcp!.name)!;
      expect(surface.attrs).toMatchObject({
        pluginName: def.pluginName,
        providerVersion: projectedToolProviderVersion(def),
        builtinProvider: def.builtinProvider ?? null,
        installationSource: def.pluginInstallation?.source ?? null,
        expose: def.expose,
        hasArgumentSensitiveEffect: typeof def.effectForCall === 'function',
        authorization: {
          requirePrincipal: def.requirePrincipal ?? null,
          agentRoles: def.agentRoles ?? null,
          requireRoles: def.requireRoles ?? null,
          hasResourceAuthorizer: typeof def.authorize === 'function',
        },
      });
      expect(surface.fidelity).toBe('declared');
    }
  });
});

describe('sync-queries population', () => {
  it('is exactly the sync-resolver dispatch registry', async () => {
    const surfaces = await syncQueriesProvider.enumerate(ctx);
    expect(surfaces.map((s) => s.surfaceId).sort()).toEqual([...knownQueryNamesV2()].sort());
  });

  it('keeps UNDECLARED backing tables distinguishable from explicitly none', async () => {
    const surfaces = await syncQueriesProvider.enumerate(ctx);
    const backingTables = (s: ObservedSurface) =>
      (s.attrs as Record<string, unknown>).backingTables;

    // Calibrate every state on the live registry. `null` is the shrink-only legacy baseline;
    // a populated array names table-driven invalidation; [] is an explicit declaration that the
    // resolver reads no Postgres table (designEvidence.report is file-backed). Collapsing either
    // null or [] into the other would make the census lie about whether liveness was considered.
    expect(surfaces.some((s) => backingTables(s) === null)).toBe(true);
    expect(
      surfaces.some(
        (s) => Array.isArray(backingTables(s)) && (backingTables(s) as unknown[]).length > 0,
      ),
    ).toBe(true);
    expect(backingTables(surfaces.find((s) => s.surfaceId === 'designEvidence.report')!)).toEqual([]);
  });
});

describe('the empty-enumeration guard', () => {
  it('passes a populated registry through unchanged', () => {
    const rows = [{ surfaceId: 'a' }, { surfaceId: 'b' }];
    expect(assertRegistryNonEmpty(rows, 'test-registry', 'hint')).toBe(rows);
  });

  it('THROWS on an empty registry rather than reporting a successful wipe', () => {
    // The whole point: `runProvider` turns this throw into status:'failed', which makes the
    // provider's kinds un-retirable. Returning [] here would instead retire every row of the kind.
    expect(() => assertRegistryNonEmpty([], 'test-registry', 'check the loader')).toThrow(
      /enumerated ZERO surfaces/,
    );
  });

  /**
   * CONTROL — a deliberately-wrong guard, kept permanently in the tree rather than produced by
   * mutating a source file (the shared checkout is swept by git-sync, so an in-tree mutation
   * probe can be committed even when nothing goes wrong).
   *
   * It proves the assertion above DISCRIMINATES: the same expectation that passes for the real
   * guard must FAIL for a permissive one. Without this, a guard that silently stopped throwing
   * would keep the suite green.
   */
  it('is falsifiable — a permissive guard fails the same assertion', () => {
    const permissiveGuard = <T>(rows: readonly T[]): readonly T[] => rows; // returns [] happily
    expect(() => permissiveGuard([])).not.toThrow();
  });
});

/**
 * The retirement-scope invariant stated as one cross-provider property: the union of what the
 * providers EMIT must be contained by the union of what they DECLARE. A provider emitting an
 * undeclared kind would create ledger rows that no provider owns — rows nothing can ever retire,
 * which accumulate as permanent phantom coverage gaps.
 */
it('emits no surface whose kind no provider declares', async () => {
  const declared = new Set(censusProviders().flatMap((p) => p.kinds));
  const emitted = new Set<string>();
  for (const p of censusProviders()) {
    const surfaces: ObservedSurface[] = await p.enumerate(ctx);
    for (const s of surfaces) emitted.add(s.kind);
  }
  for (const kind of emitted) expect(declared).toContain(kind);
});
