/**
 * tool-schema-byte-budget — the catalog-wide gate for EI-23345472964244980.
 *
 * THE GAP THIS CLOSES. `tool-guidance-budget`'s prompt-weight tier governs description +
 * guidance (1,500 chars) and is enforced both at the gate and at registration time. It
 * never looks at `inputSchema`. But the schema is the dominant per-turn cost now that psu
 * denies ToolSearch — Claude's native schema deferral is implemented BY that tool, so
 * every ADVERTISED tool ships its full schema on EVERY turn. EI-23319364088969722 is what
 * that costs when nothing is watching: a 64-name Claude seed at 432,714 B (~157K tokens),
 * every prompt-weight check green throughout.
 *
 * WHY PER-TOOL, when an aggregate bound already exists. `assertSelectedInputSchemaBudget()`
 * bounds ONE ASSEMBLED SET and is wired into two in-house agent-loop seams only
 * (`capabilityToolset`, `operator:converse`); `packages/agent-mcp/src` — the `tools/list`
 * handler serving every psu/Claude/OMP/codex session — imports no budget symbol at all. An
 * aggregate bound also fires at assembly time, blaming whoever assembled the set rather
 * than whoever grew the schema, and so cannot stop the creep that made the seed expensive.
 * This runs per tool, against the projected catalog, so growth is attributed to its edit.
 *
 * WHAT THE COMPANION GUARDS DO NOT COVER. `claude-seed-wire-budget.test.ts` bounds the
 * COST of one client's seed and `psu-launcher.test.ts` bounds its NAME COUNT — both are
 * seed-scoped, so a tool outside the Claude seed can grow without limit and neither
 * notices. This is the catalog-wide tier beneath them.
 */
import { describe, it, expect } from 'vitest';
// Register the real catalog during module collection, outside Vitest's 60s hookTimeout.
// This full catalog import can legitimately take longer than one hook while still fitting
// the routed test-file process budget.
import './index';
import { listAllProjectedTools } from '@papercusp/tooldef';
import { selectConverseTools } from './operator/converse-toolset';
import { assertSelectedInputSchemaBudget, selectedInputSchemaBudget } from './tool-guidance-budget';
import {
  ALLOW_OVER_SCHEMA_BUDGET,
  MIN_PLAUSIBLE_CATALOG_SIZE,
  SCHEMA_BYTE_BUDGET,
  formatSchemaViolations,
  namedToolSchemaBytes,
  roundPin,
  schemaBudgetViolations,
  serializedInputSchemaBytes,
  serializedInputSchemaProseBytes,
  slackSchemaPins,
  type NamedToolSchemaBytes,
} from './tool-guidance-budget';

/**
 * Lower plausibility floor on the catalog's TOTAL projected schema bytes — this file's
 * own vacuous-green trap.
 *
 * Every assertion below is an UPPER bound, and an upper bound is satisfied trivially by a
 * broken instrument: if `inputSchema` ever stops being populated on ProjectedTool (a
 * projection change, a renamed field), every measurement collapses toward zero, every
 * budget passes with room to spare, and this file reports healthy while measuring
 * nothing. The catalog-SIZE floor does not catch that — it counts tools, not bytes. The
 * live catalog projects ~1.5 MB today, so a reading below this floor means the instrument
 * broke, not that the catalog got cheap.
 */
const MIN_PLAUSIBLE_CATALOG_SCHEMA_BYTES = 600_000;

describe('voice converse selected schema budget', () => {
  it.each(['operator', 'papercup'])('%s voice mounts fit the real catalog budget and retain tools', (role) => {
    const catalog = new Map(listAllProjectedTools().map(tool => [tool.expose.mcp?.name, tool]));
    const names = selectConverseTools({
      role, hostTrust: 'owner', modality: 'voice', publicDoorNames: () => [],
      supportsVoice: name => (catalog.get(name)?.modality ?? ['text', 'voice']).includes('voice'),
    }).map(name => name.replace('mcp__agentmcp__', ''));
    expect(names).toContain('memory:search');
    expect(names).toContain('harness:status');
    // plans:get is explicitly text-only; it must not remain callable but
    // absent from the voice prompt's filtered catalog.
    expect(names).not.toContain('plans:get');
    // The current card tool supports spoken fallbackText; older descriptions
    // called it text-only. Assert the registry contract, not that stale roster.
    expect(names).toContain('chat:ask_choice');
    expect(names.every(name => (catalog.get(name)?.modality ?? ['text', 'voice']).includes('voice'))).toBe(true);
    const tools = names.map(name => {
      const tool = catalog.get(name);
      expect(tool, name).toBeDefined();
      return { name, inputSchema: tool!.inputSchema };
    });
    const standardNames = selectConverseTools({
      role, hostTrust: 'owner', modality: 'voice', voiceProfile: 'standard', publicDoorNames: () => [],
      supportsVoice: name => (catalog.get(name)?.modality ?? ['text', 'voice']).includes('voice'),
    }).map(name => name.replace('mcp__agentmcp__', ''));
    const standardTools = standardNames.map(name => ({ name, inputSchema: catalog.get(name)!.inputSchema }));
    const slimBudget = selectedInputSchemaBudget(tools);
    const standardBudget = selectedInputSchemaBudget(standardTools);
    console.log(`[voice-schema-budget] role=${role} slimTools=${tools.length} standardTools=${standardTools.length} slimBytes=${slimBudget.totalBytes} standardBytes=${standardBudget.totalBytes}`);
    expect(() => assertSelectedInputSchemaBudget(tools)).not.toThrow();
    expect(() => assertSelectedInputSchemaBudget(standardTools)).not.toThrow();
    expect(slimBudget.totalBytes).toBeLessThan(standardBudget.totalBytes);
  });
});

describe('per-tool argSchema wire budget (EI-23345472964244980)', () => {
  const measured: NamedToolSchemaBytes[] = namedToolSchemaBytes(listAllProjectedTools());

  it('sees a genuinely-registered catalog and real schema bytes (a vacuous green is worse than a red)', () => {
    expect(measured.length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);
    const total = measured.reduce((sum, t) => sum + t.bytes, 0);
    // eslint-disable-next-line no-console
    console.log(
      `[schema-budget] tools=${measured.length} totalSchemaBytes=${total} ` +
        `median=${[...measured].sort((a, b) => a.bytes - b.bytes)[Math.floor(measured.length / 2)]?.bytes}`,
    );
    if (process.env.PAPERCUSP_SCHEMA_BUDGET_CENSUS === '1') {
      const over = [...measured].filter((t) => t.bytes > SCHEMA_BYTE_BUDGET).sort((a, b) => b.bytes - a.bytes);
      // eslint-disable-next-line no-console
      console.log(`[schema-budget] CENSUS — ${over.length} tool(s) over ${SCHEMA_BYTE_BUDGET} B:`);
      for (const t of over) {
        // eslint-disable-next-line no-console
        console.log(`[schema-budget]   ['${t.name}', ${roundPin(t.bytes)}], // measured ${t.bytes}`);
      }
    }
    expect(total).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SCHEMA_BYTES);
  });

  it('no tool exceeds its binding ceiling — the budget, or its pin', () => {
    const violations = schemaBudgetViolations(measured);
    expect(
      violations.length === 0 ? '' : `\nargSchema budget breach:\n${formatSchemaViolations(violations)}\n`,
    ).toBe('');
  });

  it('every pin is real and load-bearing — no stale name, no pin below the budget', () => {
    const live = new Set(measured.map((t) => t.name));
    const stale = [...ALLOW_OVER_SCHEMA_BUDGET.keys()].filter((name) => !live.has(name));
    expect(
      stale.length === 0
        ? ''
        : `\nALLOW_OVER_SCHEMA_BUDGET names ${stale.length} tool(s) that no longer exist — delete them: ${stale.join(', ')}\n`,
    ).toBe('');

    const pointless = [...ALLOW_OVER_SCHEMA_BUDGET.entries()].filter(([, pin]) => pin <= SCHEMA_BYTE_BUDGET);
    expect(
      pointless.length === 0
        ? ''
        : `\nALLOW_OVER_SCHEMA_BUDGET entries at or below the ${SCHEMA_BYTE_BUDGET} B budget are dead weight — delete them: ${pointless
            .map(([n, p]) => `${n}=${p}`)
            .join(', ')}\n`,
    ).toBe('');
  });

  /**
   * The ratchet's DOWNWARD half, reported rather than failed.
   *
   * Failing here would red the fleet gate every time a tool legitimately got cheaper,
   * which punishes exactly the behaviour the budget wants. Enforcing the UPWARD direction
   * is what stops the regression; banking a shrink is a cleanup the next editor of that
   * tool should make, so it is surfaced loudly and left non-blocking.
   */
  it('reports pins that now have slack, so a shrink is banked instead of re-spent', () => {
    const slack = slackSchemaPins(measured);
    if (slack.length > 0) {
      // Deliberately process.stdout.write, NOT console.warn: the global
      // `vitest-fail-on-console` rule fails any test that calls console.warn, which would
      // turn this advisory into exactly the fleet-gate red the docstring above forbids —
      // reds firing every time a tool legitimately got cheaper. Writing straight to stdout
      // keeps the report loud in the test output while staying non-blocking.
      process.stdout.write(
        `[schema-budget] ${slack.length} pin(s) now have slack — lower them (SHRINK-ONLY ratchet):\n` +
          slack.map((s) => `  • ${s.name}: pinned ${s.pin}, now ${s.bytes} — lower to ${s.lowerTo}`).join('\n') +
          '\n',
      );
    }
    expect(Array.isArray(slack)).toBe(true);
  });

  /**
   * WHICH lever, not just how much (EI-23379068490085254). The ratchet above tells an
   * author to cut N bytes; it cannot tell them the bytes are `.describe()` prose rather
   * than structure, and that gap is what turns a five-minute prose trim into a schema
   * redesign nobody attempts. `tool-weight` prints this split under every argSchema line.
   */
  describe('prose share', () => {
    it('returns exactly the bytes that deleting every description would give back', () => {
      const schema = {
        type: 'object',
        description: 'the tool',
        properties: {
          a: { type: 'string', description: 'about a' },
          b: { type: 'number' },
          c: { type: 'array', items: { type: 'string', description: 'about c items' } },
        },
      };
      const stripped = {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
          c: { type: 'array', items: { type: 'string' } },
        },
      };
      const prose = serializedInputSchemaProseBytes(schema);
      // The defining property: prose + structural === total, so a reported share is a
      // real fraction of the wire cost rather than an unrelated second measurement.
      expect(serializedInputSchemaBytes(schema) - prose).toBe(serializedInputSchemaBytes(stripped));
      // It charges prose for its `"description":` key, quotes and comma too, so it reads
      // ABOVE the raw string bytes — the honest answer to "how much would I get back".
      expect(prose).toBeGreaterThan('the tool'.length + 'about a'.length + 'about c items'.length);
    });

    it('is 0 when there is no prose, and when there is no schema (never a phantom share)', () => {
      expect(serializedInputSchemaProseBytes({ type: 'object', properties: { a: { type: 'string' } } })).toBe(0);
      expect(serializedInputSchemaProseBytes(undefined)).toBe(0);
      // A non-string `description` is structure, not prose — do not charge it either way.
      expect(serializedInputSchemaProseBytes({ properties: { description: { type: 'string' } } })).toBe(0);
    });

    it('measures the live catalog inside a plausible band — 0% or 100% means the walk broke', () => {
      // This instrument's own vacuous-green trap, the same shape as the total-bytes floor
      // above. A share that collapses to 0 (the walk stopped matching `description`) or
      // saturates at 100 (it stopped stripping) both LOOK like findings rather than like
      // a broken instrument. Measured 2026-09-16: 57.5% across 889 exposed tools; the band
      // is deliberately wide, because it is asserting the walk still works, not the value.
      const tools = listAllProjectedTools();
      const total = tools.reduce((sum, t) => sum + serializedInputSchemaBytes(t.inputSchema), 0);
      const prose = tools.reduce((sum, t) => sum + serializedInputSchemaProseBytes(t.inputSchema), 0);
      const share = prose / total;
      // eslint-disable-next-line no-console
      console.log(
        `[schema-budget] prose=${prose} B of ${total} B (${(share * 100).toFixed(1)}%) across ${tools.length} tools`,
      );
      expect(share).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.9);
    });
  });
});
