/**
 * tool-input-schema-rejection.test.ts — the `invalid_args` failure class.
 *
 * ~88 of the recorded tool-call failures (harness_shared.tool_invocations,
 * 2026-05-31) were `invalid_args: …` — a tool's input schema rejecting
 * malformed/missing args. There was no registry-wide test that each tool's
 * schema actually enforces its declared contract. This is that guard.
 *
 * Two registries (see agent-insights/failed-tool-call-history):
 *   getCatalog()            → ~28 principal-gated BUILT-INS, each with a Zod
 *                             `args` schema → validate schema-level (no dispatch).
 *   listAllProjectedTools() → every projected tool as JSON `inputSchema` (no Zod, no
 *                             name) → structural well-formedness checks.
 */
import { describe, it, expect } from 'vitest';
import '../agent-tools/index'; // side-effect: register the full real tool catalog (+ pre-prompt registry)
import { getCatalog, listAllProjectedTools, toArgsJsonSchema, validateSync } from '@papercusp/tooldef';
import { advertisedArgsSchema } from '@papercusp/result-encoding';

const catalog = getCatalog(); // built-ins with Zod args
const projected = listAllProjectedTools(); // full set, JSON inputSchema

describe('built-in tool args schemas (invalid_args class — schema level)', () => {
  it('the built-in catalog loaded', () => {
    expect(catalog.length).toBeGreaterThan(10);
  });

  it('every built-in args schema validates {} synchronously without throwing', () => {
    // A throw here = an async/broken validator on the dispatch hot path.
    const threw: string[] = [];
    for (const t of catalog) {
      try {
        validateSync(t.args, {});
      } catch {
        threw.push(t.name);
      }
    }
    expect(threw, `validators that threw: ${threw.join(', ')}`).toEqual([]);
  });

  it('every built-in args schema remains JSON-Schema representable (EI-20081950141743058)', () => {
    // `defineTool` performs this conversion during registration, but keeping the
    // registry-wide check explicit catches a future trailing `.transform()` at the
    // commit that introduces it. The full `../agent-tools/index` import above also
    // exercises role-gated registrations, whose raw schemas are converted before
    // they enter the projected registry.
    const failures: string[] = [];
    for (const t of catalog) {
      try {
        toArgsJsonSchema(t.name, t.args);
      } catch (error) {
        failures.push(`${t.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures, `unrepresentable args schemas:\n${failures.join('\n')}`).toEqual([]);
  });

  it('required-arg built-ins reject {} with a structured issue', () => {
    const required = ['features:get', 'features:history'];
    for (const name of required) {
      const t = catalog.find((x) => x.name === name);
      expect(t, `tool ${name} present in catalog`).toBeTruthy();
      const r = validateSync(t!.args, {});
      expect(r.ok, `${name} should reject {}`).toBe(false);
      if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
    }
  });

  it('a no-required-args built-in accepts {} (harness:list)', () => {
    // papercusp:list_workspaces (the former z.object({}).strict() example)
    // moved to the role-gated `defineTool` path, so it's no longer a NAMED
    // entry in getCatalog() (legacy built-ins only). harness:list is the
    // representative no-required legacy built-in. Unknown-key rejection
    // (.strict) is no longer a per-tool Zod property of the legacy built-ins —
    // it's enforced structurally at the projection/transport boundary via
    // additionalProperties:false, asserted for EVERY tool in the projected
    // suite below (stronger than the old single-tool check).
    const t = catalog.find((x) => x.name === 'harness:list');
    expect(t, 'harness:list present in catalog').toBeTruthy();
    expect(validateSync(t!.args, {}).ok).toBe(true);
  });
});

describe('projected tool inputSchemas (invalid_args class — structural)', () => {
  it('the full projection registry loaded', () => {
    expect(projected.length).toBeGreaterThan(150);
  });

  it('role-gated tools converted AT REGISTRATION are actually present (EI-21930203761949555)', () => {
    // The representability check in the built-in suite above walks getCatalog(),
    // which holds only the ~28 LEGACY built-ins. Role-gated `defineTool` tools —
    // work_items:complete among them — never enter that registry: their args are
    // converted by toArgsJsonSchema INSIDE registerRoleGatedAsProjected, and an
    // unrepresentable schema (a trailing .transform()/effects anywhere in the
    // imported schema graph, not just in the tool's own file) throws there, at
    // module load.
    //
    // On 2026-08-31 that threw for work_items:complete and took the operator
    // host down at boot: :3170 crash-looped (nRestarts=6, exit 7) and the same
    // bundle would have killed :3070 on promotion, since the conversion runs
    // again — unguarded — when tools/list is served. The only signal was a boot
    // stack trace; no test NAMED the tool that had dropped out of the catalog.
    //
    // Anti-vacuity: a registration regression must fail HERE, by name, rather
    // than at operator boot. (If the conversion throws again this file fails to
    // collect at all — that is the same guard firing one stage earlier.)
    const named = new Set(
      projected.map((t) => t.expose?.mcp?.name).filter((n): n is string => !!n),
    );
    // Calibration control: a permanently-absent name must read as MISSING, or
    // this whole assertion is vacuously true (e.g. if `named` were ever built
    // from a field that does not exist and silently collapsed to every-key).
    expect(
      named.has('work_items:__not_a_real_tool__'),
      'calibration failed: the membership check cannot report a missing tool, so the guard below proves nothing',
    ).toBe(false);
    for (const mustCover of ['work_items:complete', 'work_items:checkpoint']) {
      expect(
        named.has(mustCover),
        `${mustCover} is missing from the projected MCP surface — its registration, and the ` +
          `toArgsJsonSchema conversion inside it, did not complete (see EI-21930203761949555)`,
      ).toBe(true);
    }
  });

  it('every projected tool exposes a well-formed object inputSchema', () => {
    const bad = projected.filter(
      (t) => !t.inputSchema || (t.inputSchema as { type?: string }).type !== 'object',
    );
    expect(bad.length, `${bad.length} tools with a non-object inputSchema`).toBe(0);
  });

  it('every ADVERTISED inputSchema is still an object schema (WI-3290: the MCP-spec surface clients validate)', () => {
    // The transport advertises advertisedArgsSchema(name, schema), NOT the raw
    // projection this suite otherwise checks — the write-positional row/keyed
    // `oneOf` rewrite happens there. A bare top-level oneOf (no type:"object")
    // on work_items:set_state / work_items:claim violated the MCP spec and made
    // strict clients (Claude Code, ptool) reject the ENTIRE catalog: sessions
    // booted with ZERO papercusp tools. Guard the advertised surface itself so
    // no future registry entry / advertise rewrite can re-ship a non-object
    // inputSchema. (The pre-prompt registry is configured by the
    // ../agent-tools/index side-effect import above, so the positional rewrite
    // is LIVE here exactly as in production.)
    const named = projected
      .map((t) => ({ name: t.expose?.mcp?.name, inputSchema: t.inputSchema }))
      .filter((t): t is { name: string; inputSchema: Record<string, unknown> } => !!t.name);
    // Anti-vacuity: the MCP surface must actually be here, INCLUDING the two
    // write-positional tools whose advertised oneOf shipped the regression.
    expect(named.length).toBeGreaterThan(150);
    for (const mustCover of ['work_items:set_state', 'work_items:claim']) {
      expect(
        named.some((t) => t.name === mustCover),
        `${mustCover} missing from the projected MCP surface — this guard would no longer cover the WI-3290 class`,
      ).toBe(true);
    }
    const bad = named.filter(
      (t) =>
        (advertisedArgsSchema(t.name, t.inputSchema) as { type?: string }).type !== 'object',
    );
    expect(
      bad.length,
      `${bad.length} tools advertise a non-object inputSchema (MCP spec requires type:"object"): ` +
        bad.map((t) => t.name).join(', '),
    ).toBe(0);
  });

  it('every projected tool is strict (additionalProperties:false) — unknown args rejected at the wire', () => {
    // The wire-level equivalent of Zod's `.strict()`: an MCP client validating
    // against the projected inputSchema rejects typo'd / unknown keys. This is
    // where the unknown-key-rejection contract actually lives for ALL tools
    // (legacy + role-gated), regardless of whether the source Zod used .strict().
    const loose = projected.filter(
      (t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false,
    );
    expect(
      loose.length,
      `${loose.length} projected tools allow unknown keys (want additionalProperties:false): ${loose.map((t) => JSON.stringify(t).slice(0, 220)).join(' || ')}`,
    ).toBe(0);
  });

  it('a substantial set of tools declare required args (contract is enforced, not vestigial)', () => {
    const withRequired = projected.filter(
      (t) => Array.isArray((t.inputSchema as { required?: string[] }).required) &&
        (t.inputSchema as { required: string[] }).required.length > 0,
    );
    // ~151 of 217; loose lower bound stays robust to catalog churn.
    expect(withRequired.length).toBeGreaterThan(100);
  });
});
