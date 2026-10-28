/**
 * tool-contract-repair-2026-09-05 P-009 — the class-wide argument-contract guard.
 *
 * Two halves, deliberately:
 *
 *  - LIVE: run the scanner over the real projected catalog. This is the guard.
 *  - CONTROLS: run the same scanner over deliberately-broken synthetic tools
 *    kept permanently in this file. Without them a green here is worthless —
 *    a scanner that can never report anything is indistinguishable from a
 *    catalog that is clean. Mutating a real tool to prove the point is
 *    forbidden on this shared tree (the git-sync sweep commits whatever is on
 *    disk when it fires), so the wrong implementations live here instead.
 */
import { describe, it, expect } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/tooldef';

import { MIN_PLAUSIBLE_CATALOG_SIZE } from './tool-guidance-budget';
import {
  scanToolAliases,
  toAliasScannableTool,
  formatAliasIssues,
  STRICT_ALIAS_DECLARATION_FLOOR,
  FOLDED_ARG_ALIASES,
  FOLDED_ALIAS_FLOOR,
  type AliasScannableTool,
} from './tool-alias-contract';
import plansItemsTool from './plans/items';
import factsListTool from './facts/list';
import factsRetractTool from './facts/retract';
import presenceTool from './coordination/tools/presence';
import inboxTool from './coordination/tools/inbox';
import eventsCatalogTool from './events/catalog';
import loopStatusTool from './loop/status';
import bashTool from './capability/bash';
import toolsFindTool from './tools/find';
import orientTool from './coordination/tools/orient';
import addDecisionTool from './plans/add-decision';

type ParsableTool = { args: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: unknown } } };
/** The tool modules a FOLDED_ARG_ALIASES row may name — a row for any other tool fails loudly. */
const FOLDED_ALIAS_TOOLS: Record<string, ParsableTool> = {
  'plans:items': plansItemsTool as unknown as ParsableTool,
  'facts:list': factsListTool as unknown as ParsableTool,
  'facts:retract': factsRetractTool as unknown as ParsableTool,
  'coord:presence': presenceTool as unknown as ParsableTool,
  'coord:inbox': inboxTool as unknown as ParsableTool,
  'events:catalog': eventsCatalogTool as unknown as ParsableTool,
  'loop:status': loopStatusTool as unknown as ParsableTool,
  'capability:bash': bashTool as unknown as ParsableTool,
  'tools:find': toolsFindTool as unknown as ParsableTool,
  'coord:orient': orientTool as unknown as ParsableTool,
  'plans:add-decision': addDecisionTool as unknown as ParsableTool,
};

function liveScannableTools(): AliasScannableTool[] {
  const catalog = listAllProjectedTools();

  // The vacuous-green trap this whole file exists to avoid: an unregistered
  // catalog scans clean and reports zero issues, which reads exactly like a
  // healthy result. Borrow tool-guidance-budget's floor rather than inventing
  // a second one (EI-19377066316560032).
  expect(
    catalog.length,
    `listAllProjectedTools() returned only ${catalog.length} tool(s), far below the ` +
      `${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor. The agent-tools barrel did not register, so every assertion ` +
      `below would pass over an EMPTY catalog. Run this through vitest, or any driver that ` +
      `side-effect-imports './index' first — without that import the barrel never registers.`,
  ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

  const scannable = catalog
    .map(toAliasScannableTool)
    .filter((t): t is AliasScannableTool => t !== null);

  // D-001 rule 2 ("a guard must assert its own DENOMINATOR"), applied to the
  // right side of the filter. The floor above is asserted on the PRE-filter
  // catalog, but what actually gets scanned is this post-filter population:
  // toAliasScannableTool returns null for any tool whose projected inputSchema
  // carries no `properties`. Measured 2026-09-05 (WI-2145955): 854 -> 854, zero
  // dropped, so today these two counts are identical and nothing is hidden.
  // That is exactly why this assertion is cheap now and load-bearing later — if
  // a projection change ever drops a family of tools out of `properties`, they
  // would leave the scanned class SILENTLY while the pre-filter count above
  // stayed comfortably green. This is the same relocation of the ZodEffects
  // blind spot D-008 names, one layer out: from `args.shape` to the JSON-Schema
  // projection.
  expect(
    scannable.length,
    `Only ${scannable.length} of ${catalog.length} catalog tools survived toAliasScannableTool, ` +
      `below the ${MIN_PLAUSIBLE_CATALOG_SIZE}-tool floor. Tools are being dropped from the scanned ` +
      `class because their projected inputSchema has no \`properties\` — the assertions below still ` +
      `read green while covering a shrinking population. Fix the projection (or the conversion); do ` +
      `not lower this floor to restore green.`,
  ).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);

  return scannable;
}

describe('tool argument aliases — class-wide contract (P-009)', () => {
  it('every documented alias names a real, usable canonical field', () => {
    const scan = scanToolAliases(liveScannableTools());

    expect(
      scan.issues,
      scan.issues.length === 0
        ? ''
        : `${scan.issues.length} tool(s) document an argument alias that a caller cannot actually rely on:\n` +
          `${formatAliasIssues(scan.issues)}\n\n` +
          `Each is the argument-contract defect class (tool-contract-repair-2026-09-05): the description promises ` +
          `a spelling the schema does not honour. Fix the schema or the description — do not delete the alias.`,
    ).toEqual([]);
  });

  it('the declared-alias population has not shrunk below its floor', () => {
    const scan = scanToolAliases(liveScannableTools());

    expect(
      scan.declarations.length,
      `Only ${scan.declarations.length} backticked alias declarations remain, below the floor of ` +
        `${STRICT_ALIAS_DECLARATION_FLOOR}. An alias repair was REMOVED — the one regression shape a scan over ` +
        `fields-that-still-exist cannot see directly. If the removal was deliberate (the tool itself was retired), ` +
        `lower STRICT_ALIAS_DECLARATION_FLOOR in tool-alias-contract.ts and say why in the commit; if it was not, ` +
        `restore the alias. Never lower the floor just to get green.`,
    ).toBeGreaterThanOrEqual(STRICT_ALIAS_DECLARATION_FLOOR);
  });

  it('reports the population it measured, so a silent collapse to zero is visible', () => {
    const scan = scanToolAliases(liveScannableTools());

    // A scan that matched nothing at all would satisfy "no issues" vacuously.
    expect(scan.toolsWithAliases).toBeGreaterThan(0);
    expect(scan.declarations.length).toBeGreaterThanOrEqual(scan.toolsWithAliases);
  });
});

/**
 * WI-6554700010029664 — FOLDED aliases are accepted but not advertised, so the description
 * scanner above cannot see them. Guard them by BEHAVIOUR: absent from the projected schema,
 * canonical present, and parsing the alias yields the canonical value.
 */
describe('tool argument aliases — folded (accepted, not advertised)', () => {
  it('the folded-alias population has not shrunk below its floor', () => {
    expect(FOLDED_ARG_ALIASES.length).toBeGreaterThanOrEqual(FOLDED_ALIAS_FLOOR);
  });

  it('every folded alias is unadvertised, its canonical is advertised, and parsing it yields the canonical', () => {
    const byName = new Map(liveScannableTools().map((t) => [t.name, t]));
    const failures: string[] = [];
    for (const row of FOLDED_ARG_ALIASES) {
      const projected = byName.get(row.tool);
      const tool = FOLDED_ALIAS_TOOLS[row.tool];
      if (!projected || !tool) {
        failures.push(`${row.tool}: not in the projected catalog or not mapped in FOLDED_ALIAS_TOOLS`);
        continue;
      }
      if (row.alias in projected.properties) failures.push(`${row.tool}.${row.alias}: still advertised`);
      if (!(row.canonical in projected.properties)) failures.push(`${row.tool}.${row.canonical}: canonical not advertised`);
      const parsed = tool.args.safeParse({ ...row.base, [row.alias]: row.sample });
      if (!parsed.success) {
        failures.push(`${row.tool}.${row.alias}: parse refused — ${JSON.stringify(parsed.error).slice(0, 200)}`);
        continue;
      }
      const data = parsed.data as Record<string, unknown>;
      const got = data[row.canonical];
      const want = row.canonical === 'itemIds' && typeof row.sample === 'string' ? [row.sample] : row.sample;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        failures.push(`${row.tool}.${row.alias}: folded to ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      }
      if (row.alias in data) failures.push(`${row.tool}.${row.alias}: alias key survived the fold`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the canonical spelling wins when the canonical and a folded alias are both supplied', () => {
    expect((factsListTool as unknown as ParsableTool).args.safeParse({ scope: 'harness', scopeRef: 'a', ref: 'b' }).data).toMatchObject({
      scopeRef: 'a',
    });
    expect((inboxTool as unknown as ParsableTool).args.safeParse({ unanswered_only: false, unanswered: true }).data).toMatchObject({
      unanswered_only: false,
    });
    expect((eventsCatalogTool as unknown as ParsableTool).args.safeParse({ q: 'a', pattern: 'b', query: 'c' }).data).toMatchObject({ q: 'a' });
    expect((loopStatusTool as unknown as ParsableTool).args.safeParse({ ownerId: 'a', owner: 'b' }).data).toMatchObject({ ownerId: 'a' });
    expect((bashTool as unknown as ParsableTool).args.safeParse({ command: 'a', cmd: 'b' }).data).toMatchObject({ command: 'a' });
    // A blank canonical does not shadow a real alias value (resolveScopeRefAlias precedence).
    expect((factsListTool as unknown as ParsableTool).args.safeParse({ scope: 'harness', scopeRef: ' ', scope_ref: 'x' }).data).toMatchObject({
      scopeRef: 'x',
    });
    // A wrongly-typed alias is still REFUSED, not silently dropped.
    expect((factsListTool as unknown as ParsableTool).args.safeParse({ scope: 'harness', ref: 42 }).success).toBe(false);
  });
});

/**
 * CONTROLS — the wrong implementations. Each asserts the scanner CAN fail, so
 * the live green above means something. Do not delete these to "clean up".
 */
describe('tool argument aliases — detector controls (must stay falsifiable)', () => {
  const tool = (
    name: string,
    properties: AliasScannableTool['properties'],
    required?: string[],
  ): AliasScannableTool => ({ name, properties, required });

  it('CATCHES a dangling canonical (the shape a rename leaves behind)', () => {
    const scan = scanToolAliases([
      tool('demo:renamed', {
        legacyName: { description: 'Compatibility alias for `newName`.' },
        // `newName` was renamed away and the alias was left pointing at nothing.
        currentName: { description: 'The actual field.' },
      }),
    ]);

    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]!.kind).toBe('dangling-canonical');
    expect(scan.issues[0]!.canonical).toBe('newName');
  });

  it('CATCHES a documented-but-unusable alias whose canonical is required', () => {
    const scan = scanToolAliases([
      tool(
        'demo:unusable',
        {
          q: { description: 'Compatibility alias for `query`.' },
          query: { description: 'The search text.' },
        },
        ['query'],
      ),
    ]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['canonical-required']);
  });

  it('CATCHES an alias that has itself become required', () => {
    const scan = scanToolAliases([
      tool(
        'demo:inverted',
        {
          legacy: { description: 'Compatibility alias for `canonical`.' },
          canonical: { description: 'The real one.' },
        },
        ['legacy'],
      ),
    ]);

    expect(scan.issues.map((i) => i.kind)).toEqual(['alias-required']);
  });

  it('does NOT fire on healthy aliases — the controls above are the scanner working, not noise', () => {
    const scan = scanToolAliases([
      tool('demo:healthy', {
        unanswered: { description: 'Compatibility alias for `unanswered_only`.' },
        unanswered_only: { description: 'The canonical filter.' },
      }),
    ]);

    expect(scan.issues).toEqual([]);
    expect(scan.declarations).toEqual([
      { tool: 'demo:healthy', field: 'unanswered', canonical: 'unanswered_only' },
    ]);
  });

  it('ignores prose that says "alias" without a backticked target', () => {
    // The measured false-positive shape: "alias for the persisted measurement"
    // captured `persisted` under a loose regex and would have redded the gate.
    const scan = scanToolAliases([
      tool('demo:prose', {
        measurement: { description: 'Optional alias for the persisted measurement this fact records.' },
        persisted: { description: 'Unrelated real field.' },
        other: { description: 'An alias of the thing above, loosely speaking.' },
      }),
    ]);

    expect(scan.issues).toEqual([]);
    expect(scan.declarations).toEqual([]);
    expect(scan.looseMentions).toBe(2);
  });

  it('counts declarations per tool so the floor cannot be gamed by one tool', () => {
    const scan = scanToolAliases([
      tool('demo:a', {
        x: { description: 'alias for `y`' },
        y: { description: 'canonical' },
      }),
      tool('demo:b', {
        p: { description: 'Compatibility alias of `q`.' },
        q: { description: 'canonical' },
      }),
    ]);

    expect(scan.declarations).toHaveLength(2);
    expect(scan.toolsWithAliases).toBe(2);
  });

  it('adapter refuses an unexposed or schema-less catalog entry rather than inventing a name', () => {
    expect(toAliasScannableTool({ inputSchema: { properties: {} } })).toBeNull();
    expect(toAliasScannableTool({ expose: { mcp: { name: 'demo:x' } } })).toBeNull();
    expect(toAliasScannableTool(undefined)).toBeNull();
    expect(toAliasScannableTool({ expose: { mcp: { name: 'demo:x' } }, inputSchema: { properties: {} } })).toEqual({
      name: 'demo:x',
      properties: {},
      required: undefined,
    });
  });
});
