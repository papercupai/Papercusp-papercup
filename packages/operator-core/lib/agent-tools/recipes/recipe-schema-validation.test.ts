import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProjectedTool } from '@papercusp/tooldef';
import { validateRecipeScriptAgainstCatalog } from './recipe-schema-validation';
import orientTool from '../coordination/tools/orient';
import factsListTool from '../facts/list';
import loopStatusTool from '../loop/status';
import workItemsGetTool from '../work_items/get';
import '../pre-prompt-registry-config';

// tooldef publishes a tool's `result` as the generic StandardSchemaV1; these tools
// define it with zod, so narrow the type for z.toJSONSchema (WI-10006260). Runtime
// conversion is unchanged.
const zodResult = (schema: unknown): z.ZodType => schema as z.ZodType;

const tool = (
  name: string,
  inputSchema: Record<string, unknown>,
  outputJsonSchema?: Record<string, unknown>,
): ProjectedTool => ({
  pluginName: 'test',
  description: name,
  inputSchema,
  ...(outputJsonSchema ? { outputJsonSchema } : {}),
  capabilities: [],
  expose: { mcp: { name } },
  fn: (async () => ({ content: [] })) as never,
});

describe('validateRecipeScriptAgainstCatalog', () => {
  it('keeps the saved continuation ownership recipe aligned with live result contracts', async () => {
    const catalog = [
      tool('coord:orient', z.toJSONSchema(orientTool.args), z.toJSONSchema(zodResult(orientTool.result))),
      tool('facts:list', z.toJSONSchema(factsListTool.args)),
      tool('loop:status', z.toJSONSchema(loopStatusTool.args), z.toJSONSchema(zodResult(loopStatusTool.result))),
    ];
    const script =
      'const s = await tools.loop.status({});\n' +
      'const o = await tools.coord.orient({ afterCompaction: true });\n' +
      'const f = await tools.facts.list({ scope: "work_item", scopeRef: inputs.workItemId, full: true });\n' +
      'return { loop: { active: s.loop?.active ?? null, carry: s.loop?.carry ?? null, rewake: s.rewake ?? null }, ' +
      'host: o.host ?? null, self: o.self ?? null, obligationKeys: Object.keys(o.recovery ?? {}), ' +
      'facts: (f.facts || []).map((x) => ({ key: x.key, body: x.body })) };';

    const result = await validateRecipeScriptAgainstCatalog(script, catalog);
    expect(result).toEqual({
      ok: true,
      issues: [],
      staticToolNames: ['coord:orient', 'facts:list', 'loop:status'],
    });

    const stale = await validateRecipeScriptAgainstCatalog(
      'const s = await tools.loop.status({}); return s.loop?.rewake ?? null;',
      catalog,
    );
    expect(stale.ok).toBe(false);
    expect(stale.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'loop:status',
        path: 'result.loop.rewake',
        kind: 'output-field',
      }),
    ]));
  });

  it('keeps the fleet lane recheck recipe aligned with the published loop status fields', async () => {
    const catalog = [
      tool('loop:status', z.toJSONSchema(loopStatusTool.args), z.toJSONSchema(zodResult(loopStatusTool.result))),
    ];
    const script =
      'const l = await tools.loop.status({ ownerId: "self" });\n' +
      'return { loop: { active: l.loop && l.loop.active, intervalSec: l.loop && l.loop.intervalSec, ' +
      'carry: l.loop && l.loop.carry, rewakeGuaranteed: l.rewake && l.rewake.rewakeGuaranteed, ' +
      'rewakeReason: l.rewake && l.rewake.reason, lastDeliveryOutcome: l.loop && l.loop.lastDeliveryOutcome, ' +
      'nextFireAt: l.loop && l.loop.nextFireAt } };';

    const result = await validateRecipeScriptAgainstCatalog(script, catalog);
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['loop:status'] });
  });

  it('accepts guarded reads through nullable result branches but still rejects unguarded reads', async () => {
    const catalog = [tool('loop:status', { type: 'object', properties: {}, additionalProperties: false }, {
      type: 'object',
      properties: {
        loop: {
          anyOf: [
            {
              type: 'object',
              properties: { active: { type: 'boolean' } },
              required: ['active'],
              additionalProperties: false,
            },
            { type: 'null' },
          ],
        },
      },
      required: ['loop'],
      additionalProperties: false,
    })];

    const guarded = await validateRecipeScriptAgainstCatalog(
      'const status = await tools.loop.status({}); return status.loop?.active ?? null;',
      catalog,
    );
    expect(guarded).toEqual({ ok: true, issues: [], staticToolNames: ['loop:status'] });

    const unguarded = await validateRecipeScriptAgainstCatalog(
      'const status = await tools.loop.status({}); return status.loop.active;',
      catalog,
    );
    expect(unguarded.ok).toBe(false);
    expect(unguarded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'loop:status',
        path: 'result.loop.active',
        kind: 'output-field',
      }),
    ]));
  });

  it('accepts the saved obligation recovery read against the actual orient output contract', async () => {
    const catalog = [tool('coord:orient', z.toJSONSchema(orientTool.args), z.toJSONSchema(zodResult(orientTool.result)))];
    const guarded = await validateRecipeScriptAgainstCatalog(
      'const orient = await tools.coord.orient({ afterCompaction: false });\n' +
        'const ob = orient.obligations || {};\n' +
        'return { evaluations: ob.evaluations || [], withheld: orient.obligationsWithheldBy || null };',
      catalog,
    );
    expect(guarded).toEqual({ ok: true, issues: [], staticToolNames: ['coord:orient'] });

    // The fold is still optional: publishing it must not make an unguarded read safe.
    const unguarded = await validateRecipeScriptAgainstCatalog(
      'const orient = await tools.coord.orient({}); return orient.obligations;',
      catalog,
    );
    expect(unguarded.ok).toBe(false);
    expect(unguarded.issues[0]).toMatchObject({
      tool: 'coord:orient',
      path: 'result.obligations',
      message: expect.stringContaining('optional in the current output schema'),
    });
  });

  it('rejects a literal enum value removed from the current tool schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.checkpointRun({ op: "status" });',
      [tool('release:checkpoint-run', {
        type: 'object',
        properties: { force: { type: 'boolean' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('op');
  });

  it('accepts a literal call whose arguments match the current schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.deploy({ op: "status" });',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string', enum: ['status', 'trigger'] } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['release:deploy'] });
  });

  it('reports missing and optional fields read from current tool results with script locations', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const trace = await tools.release.trace({ path: "packages/example" });\nreturn { gate: trace.gate.state, retired: trace.retired };',
      [tool('release:trace', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }, {
        type: 'object',
        properties: {
          gate: {
            type: 'object',
            properties: { state: { type: 'string' } },
            required: ['state'],
          },
        },
        required: [],
        additionalProperties: true,
      })],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'release:trace',
        path: 'result.gate.state',
        kind: 'output-field',
        message: expect.stringContaining('optional in the current output schema'),
        position: expect.objectContaining({ line: 2 }),
        callPosition: expect.objectContaining({ line: 1 }),
      }),
      expect.objectContaining({
        tool: 'release:trace',
        path: 'result.retired',
        kind: 'output-field',
        message: expect.stringContaining('not declared in the current output schema'),
      }),
    ]));
  });

  it('accepts result fields required throughout the current output schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const trace = await tools.release.trace({ path: "packages/example" });\nreturn trace.gate.state;',
      [tool('release:trace', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }, {
        type: 'object',
        properties: {
          gate: {
            type: 'object',
            properties: { state: { type: 'string' } },
            required: ['state'],
          },
        },
        required: ['gate'],
        additionalProperties: false,
      })],
    );

    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['release:trace'] });
  });

  it('does not treat intrinsic Array members as tool-result schema fields', async () => {
    const workItemsGet = tool(
      'work_items:get',
      z.toJSONSchema(workItemsGetTool.args),
      z.toJSONSchema(zodResult(workItemsGetTool.result)),
    );
    const script =
      'const item = await tools.workItems.get({ id: "WI-1" });\n' +
      'return item.results?.map((row) => row.id);';

    const accepted = await validateRecipeScriptAgainstCatalog(script, [workItemsGet]);
    expect(accepted).toEqual({ ok: true, issues: [], staticToolNames: ['work_items:get'] });

    const misspelled = await validateRecipeScriptAgainstCatalog(
      script.replace('results?.map', 'results?.mapp'),
      [workItemsGet],
    );
    expect(misspelled.ok).toBe(false);
    expect(misspelled.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'work_items:get',
        path: 'result.results.mapp',
        kind: 'output-field',
        message: expect.stringContaining('not declared in the current output schema'),
      }),
    ]));
  });

  it('accepts optional result reads protected by short-circuit guards and fallbacks', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const card = await tools.scorecards.get({ issueId: "scorecard-1" });\n' +
        'const criteria = (card.scorecard && card.scorecard.criteria || [])[0];\n' +
        'const evidence = card.evidenceRead || {};\n' +
        'const found = await tools.tools.find({ query: "plans:evaluate-spec-test-adequacy" });\n' +
        'return { criteria: criteria || null, next: evidence.next, toolCount: (found.hits || []).length };',
      [
        tool('scorecards:get', {
          type: 'object',
          properties: { issueId: { type: 'string' } },
          required: ['issueId'],
          additionalProperties: false,
        }, {
          type: 'object',
          properties: {
            scorecard: {
              type: 'object',
              properties: { criteria: { type: 'array', items: { type: 'object' } } },
              required: [],
            },
            evidenceRead: { type: 'object', properties: { next: { type: 'object' } }, required: [] },
          },
          required: [],
        }),
        tool('tools:find', {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        }, {
          type: 'object',
          properties: { hits: { type: 'array', items: { type: 'object' } } },
          required: [],
        }),
      ],
    );

    expect(result).toEqual({
      ok: true,
      issues: [],
      staticToolNames: ['scorecards:get', 'tools:find'],
    });
  });

  it('accepts an optional array result read in the positive Array.isArray branch', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const logs = await tools.logs.read({});\n' +
        'const entries = Array.isArray(logs?.entries) ? logs.entries : [];\n' +
        'return entries.length;',
      [tool('logs:read', {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }, {
        type: 'object',
        properties: { entries: { type: 'array', items: { type: 'object' } } },
        required: [],
      })],
    );

    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['logs:read'] });
  });

  it('does not treat the negative Array.isArray branch as proof an optional array exists', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const logs = await tools.logs.read({});\n' +
        'const entries = !Array.isArray(logs?.entries) ? logs.entries : [];\n' +
        'return entries.length;',
      [tool('logs:read', {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }, {
        type: 'object',
        properties: { entries: { type: 'array', items: { type: 'object' } } },
        required: [],
      })],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'logs:read',
        path: 'result.entries',
        kind: 'output-field',
        message: expect.stringContaining('optional in the current output schema'),
      }),
    ]));
  });

  it('does not trust Array.isArray when the script shadows the global Array binding', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const Array = { isArray: () => true };\n' +
        'const logs = await tools.logs.read({});\n' +
        'const entries = Array.isArray(logs?.entries) ? logs.entries : [];\n' +
        'return entries.length;',
      [tool('logs:read', {
        type: 'object',
        properties: {},
        additionalProperties: false,
      }, {
        type: 'object',
        properties: { entries: { type: 'array', items: { type: 'object' } } },
        required: [],
      })],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'logs:read',
        path: 'result.entries',
        kind: 'output-field',
        message: expect.stringContaining('optional in the current output schema'),
      }),
    ]));
  });

  it('accepts an optional result field read in a typeof-guarded ternary branch', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const r = await tools.capability.read({ file_path: "ledger.jsonl", tail: 20, raw: true });\n' +
        'const raw = typeof r?.body === "string" ? r.body : String(r?.body ?? "");\n' +
        'return raw;',
      [
        tool('capability:read', {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            tail: { type: 'integer' },
            raw: { type: 'boolean' },
          },
          required: ['file_path', 'tail', 'raw'],
          additionalProperties: false,
        }, {
          type: 'object',
          properties: { body: { type: 'string' } },
          required: [],
        }),
      ],
    );

    expect(result).toEqual({
      ok: true,
      issues: [],
      staticToolNames: ['capability:read'],
    });
  });

  it('does not treat the wrong typeof ternary branch as proof an optional result field exists', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const r = await tools.capability.read({ file_path: "ledger.jsonl", tail: 20, raw: true });\n' +
        'const raw = typeof r?.body !== "string" ? r.body : "";\n' +
        'return raw;',
      [
        tool('capability:read', {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            tail: { type: 'integer' },
            raw: { type: 'boolean' },
          },
          required: ['file_path', 'tail', 'raw'],
          additionalProperties: false,
        }, {
          type: 'object',
          properties: { body: { type: 'string' } },
          required: [],
        }),
      ],
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: 'capability:read',
        path: 'result.body',
        kind: 'output-field',
        message: expect.stringContaining('optional in the current output schema'),
      }),
    ]));
  });

  it('checks result reads from identifiers destructured out of Promise.all', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const [trace] = await Promise.all([tools.release.trace({ path: "packages/example" })]);\nreturn trace.gate;',
      [tool('release:trace', {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }, {
        type: 'object',
        properties: { gate: { type: 'object' } },
        required: [],
      })],
    );

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      tool: 'release:trace',
      path: 'result.gate',
      kind: 'output-field',
      message: expect.stringContaining('optional in the current output schema'),
    });
  });

  it('normalizes a registered positional write row before checking the target schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.workItems.claim({ row: "EI-24779677812251161,,papercusp" });',
      [tool('work_items:claim', {
        type: 'object',
        properties: {
          id: { type: 'string' },
          assignee: { type: 'string' },
          harness: { type: 'string' },
          force: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      })],
    );

    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['work_items:claim'] });
  });

  it('accepts framework-reserved payloadTier even though it is absent from the published schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.rubrics.get({ rubricRef: "goal-mode-e2e", payloadTier: "full" });',
      [tool('rubrics:get', {
        type: 'object',
        properties: { rubricRef: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['rubrics:get'] });
  });

  it('accepts framework-reserved projection even though it is absent from the published schema', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.work.items({ id: "WI-1", projection: { pick: ["id"] } });',
      [tool('work:items', {
        type: 'object',
        properties: { id: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['work:items'] });
  });

  // EI-19449316000499177: code:run fails closed on `unknown-key` alone, so the CLASSIFICATION is
  // load-bearing, not decoration — a class mislabelled `unknown-key` becomes a false refusal on
  // the fleet's highest-traffic script tool.
  it('classifies an undeclared key as unknown-key (the class code:run refuses on)', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.improvements.capture({ harness: "papercusp", kind: "bug" });',
      [tool('improvements:capture', {
        type: 'object',
        properties: { scope: { type: 'string' }, kind: { type: 'string' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        tool: 'improvements:capture',
        kind: 'unknown-key',
        message: expect.stringContaining('harness'),
      }),
    ]);
  });

  it('classifies a literal/schema type mismatch as `type`, NOT unknown-key — z.coerce may accept it at dispatch', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.plans.revisionDiff({ revisionId: "12" });',
      [tool('plans:revision-diff', {
        type: 'object',
        // The published schema says number; the real tool uses z.coerce so the STRING is accepted
        // at dispatch. Refusing this would be a false positive, which is why code:run does not.
        properties: { revisionId: { type: 'number' } },
        additionalProperties: false,
      })],
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.kind).toBe('type');
    expect(result.issues.some((issue) => issue.kind === 'unknown-key')).toBe(false);
  });

  it('classifies a missing required field as `required`, not unknown-key', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.release.deploy({});',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string' } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result.issues[0]?.kind).toBe('required');
  });

  it('a schema WITHOUT additionalProperties:false yields no unknown-key issue (passthrough tools)', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'return await tools.some.tool({ anythingGoes: 1 });',
      [tool('some:tool', { type: 'object', properties: {} })],
    );
    expect(result.ok).toBe(true);
  });

  it('does not reject dynamic arguments that cannot be proven statically', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      'const op = getOp(); return await tools.release.deploy({ op });',
      [tool('release:deploy', {
        type: 'object',
        properties: { op: { type: 'string', enum: ['status'] } },
        required: ['op'],
        additionalProperties: false,
      })],
    );
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['release:deploy'] });
  });

  it('skips static argument validation when TypeScript recovered a malformed shell string', async () => {
    const result = await validateRecipeScriptAgainstCatalog(
      String.raw`const r = await tools.capability.bash({
        command: "set +e; head -n 12 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}' ; tail -n 18 /tmp/x.log | awk '{print NR ":" substr($0,1,600)}'",
        cwd: "/tmp",
        description: "Sample checkpoint log markers",
        timeout: 15000
      });
      return { output: (r?.output || "").slice(-12000) };`,
      [tool('capability:bash', {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          description: { type: 'string' },
          timeout: { type: 'number' },
        },
        additionalProperties: false,
      })],
    );
    // The malformed script must reach the VM, where it produces compile_error. The validator
    // must not turn TypeScript's recovered pseudo-property into a misleading unknown-key refusal.
    expect(result).toEqual({ ok: true, issues: [], staticToolNames: ['capability:bash'] });
  });
});
