/**
 * deterministic-tool-definition-delivery-2026-09-21 P-011 / D-008 / D-012.
 *
 * The thing under test is an INSTRUMENT, so its failure mode is a vacuous
 * green: a run that looks like a compact-tier run and is not. Every case here
 * exists to make that specific lie detectable —
 *   - it must project the LIVE registry row, not the harness's curated stand-in
 *     (D-012's whole finding was that the harness never delivered the projection);
 *   - it must use the SHIPPING projection functions, so a change to what COMPACT
 *     means moves this instrument with it;
 *   - it must THROW rather than silently fall back when the registry has not
 *     registered (EI-19377066316560032: `listAllProjectedTools()` returns an
 *     empty array outside the vitest bootstrap).
 *
 * `@papercusp/tooldef` is partially mocked on purpose: `listAllProjectedTools`
 * is replaced so the registry population is controllable, while
 * `summaryGuidanceDescription` / `compactInputSchema` stay REAL. Mocking those
 * two would test a stub of the projection instead of the projection, which is
 * the same vacuity in a different costume.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const listAllProjectedTools = vi.fn();

vi.mock('../../agent-tools/index.js', () => ({}));
vi.mock('@papercusp/tooldef', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAllProjectedTools: () => listAllProjectedTools(),
}));

import {
  projectCatalogToCompactTier,
  __resetLiveDefinitionsCache,
} from '../targets/su-compact-catalog';
import { buildCatalog } from '../targets/su-catalog';
import { summaryGuidanceDescription } from '@papercusp/tooldef';

/** A registry row shaped the way `listAllProjectedTools()` returns them. */
function liveRow(name: string, description: string, inputSchema: unknown) {
  return { expose: { mcp: { name } }, description, inputSchema };
}

/** Pad the registry above the plausible-catalog floor with inert rows. */
function padTo(n: number, rows: ReturnType<typeof liveRow>[]) {
  const out = [...rows];
  for (let i = out.length; i < n; i++) {
    out.push(liveRow(`filler:tool-${i}`, 'filler', { type: 'object', properties: {} }));
  }
  return out;
}

const LIVE_DESCRIPTION =
  'Read a documentation page by slug from the live registry. This sentence is the lead. ' +
  'It carries several further sentences of prose that the COMPACT tier is expected to drop, ' +
  'because the whole point of the tier is that the prose half is the expensive half and the ' +
  'schema half is the part a caller actually needs to form a valid call.';

const LIVE_SCHEMA = {
  type: 'object',
  properties: {
    slug: { type: 'string', description: 'the page slug — prose a compact schema drops' },
    depth: { type: 'number', minimum: 1, maximum: 5 },
  },
  required: ['slug'],
};

beforeEach(() => {
  __resetLiveDefinitionsCache();
  listAllProjectedTools.mockReset();
});

describe('projectCatalogToCompactTier', () => {
  it('projects the LIVE registry definition, not the harness stand-in', async () => {
    listAllProjectedTools.mockReturnValue(padTo(500, [liveRow('docs:get', LIVE_DESCRIPTION, LIVE_SCHEMA)]));

    const offered = buildCatalog([
      {
        name: 'docs:get',
        description: 'CURATED-STAND-IN-DESCRIPTION',
        input: { type: 'object', properties: { curatedOnly: { type: 'string' } } },
      },
    ]);
    const result = await projectCatalogToCompactTier(offered);

    expect(result.usedLive).toEqual(['docs:get']);
    expect(result.fallback).toEqual([]);
    const tool = result.catalog.tools[0]!;
    // The curated text must be GONE — its presence is exactly the D-012 defect.
    expect(tool.description).not.toContain('CURATED-STAND-IN-DESCRIPTION');
    // The compact lead cap is measured separately from this instrument. Follow
    // the shipping projection's current cap instead of assuming the whole lead
    // sentence fits; the live-registry phrase must still survive the projection.
    expect(tool.description).toBe(summaryGuidanceDescription(LIVE_DESCRIPTION));
    expect(tool.description).toContain('Read a documentation page by slug');
    // ...and the schema must come from the live row too.
    expect(Object.keys((tool.input_schema as { properties: object }).properties)).toEqual([
      'slug',
      'depth',
    ]);
  });

  it('keeps the tool name set and sanitized names identical to the offered catalog', async () => {
    listAllProjectedTools.mockReturnValue(padTo(500, [liveRow('docs:get', LIVE_DESCRIPTION, LIVE_SCHEMA)]));
    const offered = buildCatalog([
      { name: 'docs:get', description: 'd', input: { type: 'object' } },
      { name: 'plans:get', description: 'd', input: { type: 'object' } },
    ]);

    const result = await projectCatalogToCompactTier(offered);

    // The A/B's single-variable claim depends on this: only the DEFINITIONS move.
    expect(result.catalog.tools.map((t) => t.name)).toEqual(offered.tools.map((t) => t.name));
    expect(result.catalog.canonicalBySanitized).toBe(offered.canonicalBySanitized);
  });

  it('actually removes prose and schema bytes', async () => {
    listAllProjectedTools.mockReturnValue(padTo(500, [liveRow('docs:get', LIVE_DESCRIPTION, LIVE_SCHEMA)]));
    const offered = buildCatalog([{ name: 'docs:get', description: 'd', input: { type: 'object' } }]);

    const result = await projectCatalogToCompactTier(offered);

    expect(result.bytes.compact).toBeLessThan(result.bytes.full);
    expect(result.liveCatalogSize).toBe(500);
  });

  it('falls back to the curated definition ONLY for a name the live registry lacks, and reports it', async () => {
    listAllProjectedTools.mockReturnValue(padTo(500, [liveRow('docs:get', LIVE_DESCRIPTION, LIVE_SCHEMA)]));
    const offered = buildCatalog([
      { name: 'docs:get', description: 'd', input: { type: 'object' } },
      // Plugin-provided tools (design-phase:*, repomix:pack) are genuinely absent
      // from the core registry; the evidence must be able to say so rather than
      // imply the whole offered set was live.
      { name: 'design-phase:list_tokens', description: 'PLUGIN TOOL PROSE', input: { type: 'object' } },
    ]);

    const result = await projectCatalogToCompactTier(offered);

    expect(result.usedLive).toEqual(['docs:get']);
    expect(result.fallback).toEqual(['design-phase:list_tokens']);
  });

  it('THROWS instead of falling back when the registry is below the plausible floor', async () => {
    // FALSIFIABILITY CONTROL. This is the case that separates a real compact-tier
    // run from a run that merely reports one: with a silent fallback, an
    // unregistered barrel yields a full catalog of curated definitions and a
    // clean green. The floor is the only thing that makes that detectable.
    listAllProjectedTools.mockReturnValue([liveRow('docs:get', LIVE_DESCRIPTION, LIVE_SCHEMA)]);
    const offered = buildCatalog([{ name: 'docs:get', description: 'd', input: { type: 'object' } }]);

    await expect(projectCatalogToCompactTier(offered)).rejects.toThrow(/below the 400 floor/);
  });

  it('always emits an object-typed input_schema, even for a non-object source schema', async () => {
    listAllProjectedTools.mockReturnValue(
      padTo(500, [liveRow('weird:tool', 'lead sentence.', { type: 'string' })]),
    );
    const offered = buildCatalog([{ name: 'weird:tool', description: 'd', input: { type: 'object' } }]);

    const result = await projectCatalogToCompactTier(offered);

    // Anthropic rejects a non-object input_schema; without this the run would
    // fail as if the MODEL had erred.
    expect((result.catalog.tools[0]!.input_schema as { type: string }).type).toBe('object');
  });
});
