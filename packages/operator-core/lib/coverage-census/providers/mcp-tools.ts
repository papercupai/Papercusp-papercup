/**
 * `mcp-tools` — the declared census provider for agent-tool surfaces.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-003), Decision D-001.
 *
 * THE POPULATION IS THE LIVE CATALOG. Every tool self-registers by calling `defineTool`, which
 * pushes into the `@papercusp/tooldef` catalog; `getCatalog()` is what the MCP server itself
 * answers `tools/list` from. Enumerating from it means the census population is, by
 * construction, the set of tools an agent can actually call — never a hand-maintained list, and
 * never a glob over `agent-tools/**` (which would count a file that exists but is not imported
 * by the barrel, i.e. a tool no agent can reach).
 *
 * THE CATALOG IS POPULATED BY SIDE EFFECT, WHICH IS THE WHOLE HAZARD. `agent-tools/index.ts` is
 * a barrel of bare `import './group/verb'` statements — the imports ARE the registration. If the
 * census job runs in a process that never imported that barrel, `getCatalog()` returns `[]`,
 * which is indistinguishable from "this build has no tools" and would retire every mcp-tool row.
 * So we import the barrel explicitly before reading, and the empty-guard turns a failed load into
 * a FAILED provider (kinds not retirable) rather than a successful wipe. See `_non-empty.ts`.
 *
 * SCHEMA CAPTURE. `args` is a StandardSchema (zod in practice); `toJsonSchema` projects it
 * through the same adapter the MCP wire format uses, so the captured `schemaRef` is the schema
 * agents are actually validated against — the seed an L2 fuzz depth can drive from.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { listAllProjectedTools, projectedToolProviderVersion, type ProjectedTool } from '@papercusp/tooldef';
import type { CensusContext, ObservedSurface, SurfaceCensusProvider } from '@papercusp/testing-shell/census';
import { assertRegistryNonEmpty } from './_non-empty';
import { resolveToolSourceFile } from '../../tool-source-file';
import { loadedHandlerFingerprint } from '../../observability/runtime';

/** The surface kind this provider owns — and therefore the only kind it may retire. */
export const MCP_TOOL_KIND = 'mcp-tool';

/**
 * Reuse registration/bundle provenance, as the schema-staleness reader does.
 * A name-derived filename can miss nested registrations or name an unrelated
 * file that happens to exist. Missing, unreadable or external source stays unknown.
 * This identifies a source file, not the bytes loaded by a running process.
 */
async function censusToolSourceFile(toolName: string | undefined, repoRoot: string, capturedSource?: string): Promise<string | null> {
  const source = toolName ? await resolveToolSourceFile(toolName) : capturedSource;
  if (!source) return null;
  try {
    const actual = fs.realpathSync(source);
    const relative = path.relative(fs.realpathSync(repoRoot), actual);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    return fs.statSync(actual).isFile() ? relative.split(path.sep).join('/') : null;
  } catch {
    return null;
  }
}

function handlerAttrs(def: ProjectedTool): Record<string, unknown> {
  return {
    capabilities: def.capabilities,
    effect: def.effect ?? null,
    hasArgumentSensitiveEffect: typeof def.effectForCall === 'function',
    // These are declarations from the serving registry, not confinement proof.
    pluginName: def.pluginName,
    providerVersion: projectedToolProviderVersion(def),
    builtinProvider: def.builtinProvider ?? null,
    installationSource: def.pluginInstallation?.source ?? null,
    expose: def.expose,
    authorization: {
      requirePrincipal: def.requirePrincipal ?? null,
      agentRoles: def.agentRoles ?? null,
      requireRoles: def.requireRoles ?? null,
      hasResourceAuthorizer: typeof def.authorize === 'function',
    },
    replaces: Array.isArray(def.replaces) ? def.replaces : null,
  };
}

/**
 * Security inventory of ALL projected handlers, including HTTP-only plugins.
 * Extend the existing census extractor without changing its MCP retirement scope.
 * This is the loaded registry; configured but unloaded plugins need reconciliation
 * from loader/install inputs as well, and must never be inferred absent here.
 */
export async function enumerateProjectedHandlerSurfaces(ctx: CensusContext): Promise<ObservedSurface[]> {
  // Snapshot only. Importing the tool barrel here would change the population.
  // The declared MCP provider below intentionally initializes its own catalog.
  const surfaces = await Promise.all(listAllProjectedTools().map(async (def): Promise<ObservedSurface> => ({
    kind: 'projected-handler',
    // Same preference as the canonical registry entry key. No registration-order ids.
    surfaceId: def.expose.mcp ? `mcp:${def.expose.mcp.name}` : `http:${def.expose.http!.path}`,
    sourceFile: await censusToolSourceFile(def.expose.mcp?.name, ctx.repoRoot, def.sourceFile),
    schemaRef: def.discoveryInputSchema ?? def.inputSchema,
    attrs: {
      ...handlerAttrs(def),
      loadedFunctionSha256: loadedHandlerFingerprint(def.fn),
      functionFingerprintScope: 'loaded-function-text-only',
      actualEffectCoverage: 'unknown',
      dispatchRoutes: [
        ...(def.expose.mcp ? [{ channel: 'mcp', route: def.expose.mcp.name }] : []),
        ...(def.expose.http ? (def.expose.http.methods ?? [def.expose.http.method ?? 'POST'])
          .map(method => ({ channel: 'http', route: `${method} ${def.expose.http!.path}` })) : []),
        ...(def.expose.ipc ? [{ channel: 'ipc', route: def.expose.mcp?.name ?? def.expose.http!.path }] : []),
      ],
    },
    fidelity: 'declared',
  })));
  return assertRegistryNonEmpty(surfaces, 'listAllProjectedTools() full handler population',
    'The loaded handler registry is empty; inventory cannot infer an empty deployment.') as ObservedSurface[];
}

export const mcpToolsProvider: SurfaceCensusProvider = {
  provider: 'mcp-tools',
  kinds: [MCP_TOOL_KIND],

  async enumerate(ctx: CensusContext): Promise<ObservedSurface[]> {
    // Registration IS the import. Guarantee the barrel ran before trusting the catalog —
    // otherwise an empty catalog reads as "no tools exist" instead of "nothing loaded".
    await import('../../agent-tools/index');

    // The endpoint system serves the projected registry, not the legacy catalog. `defineTool`
    // mirrors legacy definitions into this registry and endpoint-native tools register here
    // directly, so this is the only population that matches the MCP transport.
    const catalog = listAllProjectedTools().filter((def) => def.expose.mcp != null);

    const surfaces = await Promise.all(catalog.map(async (def): Promise<ObservedSurface> => ({
      kind: MCP_TOOL_KIND,
      surfaceId: def.expose.mcp!.name,
      sourceFile: await censusToolSourceFile(def.expose.mcp!.name, ctx.repoRoot),
      schemaRef: def.discoveryInputSchema ?? def.inputSchema,
      attrs: handlerAttrs(def),
      fidelity: 'declared',
    })));

    return assertRegistryNonEmpty(
      surfaces,
      'listAllProjectedTools() MCP projection (@papercusp/tooldef)',
      'The agent-tools barrel did not register any tool — check that lib/agent-tools/index.ts imported cleanly.',
    ) as ObservedSurface[];
  },
};
