/**
 * EI-21111131926207175 — keep response-shape guidance derived from registered
 * output schemas instead of letting prose become a second, unverifiable type
 * system.
 *
 * The live census is intentionally strict: a tool that authors
 * `guidance.returns` must also declare `result`, which projects to
 * `outputJsonSchema`. Two directional checks then keep the public contract
 * honest:
 *
 *  1. field tokens in the first authored `{ ... }` shape clause must resolve
 *     to registered properties. An `Each row:` clause resolves against the
 *     best matching array-item schema (or the root for legacy flat schemas);
 *  2. every top-level registered property must survive the compact shape
 *     rendered by tools:find.
 *
 * Behavioural interpretation remains useful prose. Only the structural clause
 * is parsed, so sentences about nullability, provenance, or operator action do
 * not become another hand-maintained schema.
 */
import { describe, expect, it } from 'vitest';

import './index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { compactOutputSchemaForResult } from './tools/find';

type JsonSchema = Record<string, unknown>;
type CatalogTool = {
  expose?: { mcp?: { name?: string } };
  guidance?: { returns?: string };
  outputJsonSchema?: JsonSchema;
};

// These tools deliberately return mixed MCP content, not a JSON object. Advertising
// an object-rooted output schema would make structured MCP callers require
// structuredContent that the handler cannot truthfully provide.
//
//  - capability:computer — a ledger text line plus an accessibility tree or image.
//  - fleet:supersede — every fleet_registry verb answers through the local `json()`
//    helper (fleet_registry/_shared.ts:70), which returns
//    `{ content:[{ type:'text', text: JSON.stringify(payload) }], isError }`. The
//    payload is a STRINGIFIED text block, so there is no `data` for a `result:`
//    schema to describe or for output validation to check; declaring one would
//    advertise a structuredContent shape the handler never emits. It is caught here
//    and not elsewhere in fleet_registry only because it is the verb that also
//    authored `guidance.returns` — and that prose documents REFUSAL SEMANTICS (when
//    the successor is missing or leaderless), with no `{…}` shape clause at all,
//    which is why the violation reports an empty promised-field list.
const NON_OBJECT_RETURN_TOOLS = new Set(['capability:computer', 'fleet:supersede']);

export interface ReturnSchemaViolation {
  tool: string;
  kind: 'missing-output-schema' | 'promised-field-missing' | 'generated-clause-omission';
  fields: string[];
}

function firstBalancedShapeClause(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

/** Top-level field names from the first authored shape clause. */
export function structuralReturnFields(returns: unknown): string[] {
  if (typeof returns !== 'string') return [];
  const clause = firstBalancedShapeClause(returns);
  if (!clause) return [];

  const fields = new Set<string>();
  let segment = '';
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const flush = () => {
    const match = segment.trim().match(/^([A-Za-z_$][\w$-]*)(?:\?|\[\])?/);
    if (match) fields.add(match[1]!);
    segment = '';
  };

  for (const char of clause.slice(1, -1)) {
    if (quote) {
      segment += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      segment += char;
      continue;
    }
    if (char === '{') {
      if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) flush();
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth > 0) continue;
    if (char === '[') {
      if (bracketDepth === 0 && parenDepth === 0) flush();
      bracketDepth += 1;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (bracketDepth > 0) continue;
    if (char === '(') {
      if (parenDepth === 0) flush();
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (parenDepth > 0) continue;
    if (parenDepth === 0 && (char === ',' || char === ';')) {
      flush();
      continue;
    }
    segment += char;
  }
  flush();
  return [...fields];
}

function topLevelSchemaFields(schema: JsonSchema): string[] {
  const properties = schema.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties as JsonSchema)
    : [];
}

function firstClauseDescribesRows(returns: string): boolean {
  const start = returns.indexOf('{');
  return start >= 0 && /Each row:\s*$/.test(returns.slice(0, start));
}

/**
 * Resolve an `Each row:` promise to the declared row schema without hardcoding
 * a container name such as `runs`. Some older tools publish a flat/root row
 * schema, while newer list envelopes publish `rows/items/runs` arrays. Pick the
 * candidate that explains the most promised fields; a missing field remains a
 * violation instead of disappearing behind `.passthrough()`.
 */
function promisedSchemaFields(schema: JsonSchema, returns: string, promised: string[]): Set<string> {
  const root = new Set(topLevelSchemaFields(schema));
  if (!firstClauseDescribesRows(returns)) return root;

  const properties = schema.properties;
  const candidates: Set<string>[] = [root];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const property of Object.values(properties as JsonSchema)) {
      if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
      const node = property as JsonSchema;
      if (node.type !== 'array' || !node.items || typeof node.items !== 'object' || Array.isArray(node.items)) continue;
      candidates.push(new Set(topLevelSchemaFields(node.items as JsonSchema)));
    }
  }
  return candidates.reduce((best, candidate) => {
    const score = promised.filter((field) => candidate.has(field)).length;
    const bestScore = promised.filter((field) => best.has(field)).length;
    return score > bestScore ? candidate : best;
  }, root);
}

function renderedFieldNames(rendered: string): Set<string> {
  return new Set([...rendered.matchAll(/(?:^|;\s)([A-Za-z_$][\w$-]*)(?:\?)?(?=[:;]|$)/g)].map((match) => match[1]!));
}

export function returnSchemaViolations(
  tools: readonly CatalogTool[],
  render: (schema: JsonSchema) => string | null = compactOutputSchemaForResult,
): ReturnSchemaViolation[] {
  const violations: ReturnSchemaViolation[] = [];
  for (const tool of tools) {
    const returns = tool.guidance?.returns?.trim();
    if (!returns) continue;
    const name = tool.expose?.mcp?.name ?? '<unnamed-tool>';
    const schema = tool.outputJsonSchema;
    if (!schema) {
      if (NON_OBJECT_RETURN_TOOLS.has(name)) continue;
      violations.push({ tool: name, kind: 'missing-output-schema', fields: structuralReturnFields(returns) });
      continue;
    }

    const promised = structuralReturnFields(returns);
    const schemaFields = promisedSchemaFields(schema, returns, promised);
    const promisedMissing = promised.filter((field) => !schemaFields.has(field));
    if (promisedMissing.length > 0) {
      violations.push({ tool: name, kind: 'promised-field-missing', fields: promisedMissing });
    }

    const rendered = render(schema);
    const renderedFields = rendered ? renderedFieldNames(rendered) : new Set<string>();
    const generatedMissing = topLevelSchemaFields(schema).filter((field) => !renderedFields.has(field));
    if (generatedMissing.length > 0) {
      violations.push({ tool: name, kind: 'generated-clause-omission', fields: generatedMissing });
    }
  }
  return violations;
}

function namedTool(name: string): CatalogTool {
  const tool = listAllProjectedTools().find((candidate) => candidate.expose.mcp?.name === name);
  if (!tool) throw new Error(`fixture tool not registered: ${name}`);
  return tool as CatalogTool;
}

describe('guidance return shapes resolve through registered output schemas', () => {
  it('reads the real catalog rather than passing vacuously', () => {
    expect(listAllProjectedTools().length).toBeGreaterThanOrEqual(500);
  });

  it('catches guidance → schema drift on the processes:list positive control', () => {
    const processList = namedTool('processes:list');
    expect(returnSchemaViolations([processList])).toEqual([]);
    const properties = { ...((processList.outputJsonSchema!.properties ?? {}) as JsonSchema) };
    delete properties.counts;
    const mutated = { ...processList, outputJsonSchema: { ...processList.outputJsonSchema!, properties } };
    expect(returnSchemaViolations([mutated])).toContainEqual({
      tool: 'processes:list',
      kind: 'promised-field-missing',
      fields: ['counts'],
    });
  });

  it('catches schema → generated-clause drift on the sessions:read positive control', () => {
    const sessionRead = namedTool('sessions:read');
    expect(returnSchemaViolations([sessionRead])).toEqual([]);
    const schema = {
      ...sessionRead.outputJsonSchema!,
      properties: {
        ...((sessionRead.outputJsonSchema!.properties ?? {}) as JsonSchema),
        loadBearingSentinel: { type: 'string' },
      },
    };
    const mutated = { ...sessionRead, outputJsonSchema: schema };
    expect(
      returnSchemaViolations(
        [mutated],
        (value) => compactOutputSchemaForResult(value)?.replace(/; loadBearingSentinel[^;]*/, '') ?? null,
      ),
    ).toContainEqual({
      tool: 'sessions:read',
      kind: 'generated-clause-omission',
      fields: ['loadBearingSentinel'],
    });
  });

  it('resolves an Each row clause through the registered array-item schema', () => {
    const testingRuns = namedTool('testing:runs');
    expect(returnSchemaViolations([testingRuns])).toEqual([]);
    const properties = { ...((testingRuns.outputJsonSchema!.properties ?? {}) as JsonSchema) };
    const runs = { ...(properties.runs as JsonSchema) };
    const items = { ...(runs.items as JsonSchema) };
    const itemProperties = { ...((items.properties ?? {}) as JsonSchema) };
    delete itemProperties.filePath;
    properties.runs = { ...runs, items: { ...items, properties: itemProperties } };
    const mutated = { ...testingRuns, outputJsonSchema: { ...testingRuns.outputJsonSchema!, properties } };
    expect(returnSchemaViolations([mutated])).toContainEqual({
      tool: 'testing:runs',
      kind: 'promised-field-missing',
      fields: ['filePath'],
    });
  });

  it('does not force mixed MCP content into a fake object schema', () => {
    const computer = namedTool('capability:computer');
    expect(computer.outputJsonSchema).toBeUndefined();
    expect(returnSchemaViolations([computer])).toEqual([]);
  });

  it.each([
    { name: 'consult:get_feedback', fields: ['request_key', 'state', 'pending'] },
    { name: 'dev:service_health', fields: ['dhtUniverse'] },
    { name: 'work_items:get', fields: ['receipt'] },
  ])('publishes $name fields promised by its return guidance', ({ name, fields }) => {
    const tool = namedTool(name);
    expect(returnSchemaViolations([tool])).toEqual([]);
    const properties = { ...((tool.outputJsonSchema!.properties ?? {}) as JsonSchema) };
    for (const field of fields) {
      expect(properties).toHaveProperty(field);
      delete properties[field];
    }
    const mutated = { ...tool, outputJsonSchema: { ...tool.outputJsonSchema!, properties } };
    expect(returnSchemaViolations([mutated])).toContainEqual({
      tool: name,
      kind: 'promised-field-missing',
      fields,
    });
  });

  it('describes the work-item envelope before its nested receipt example', () => {
    const tool = namedTool('work_items:get');
    expect(structuralReturnFields(tool.guidance!.returns!)).toEqual(['ok', 'results', 'counts', 'read', 'receipt']);
    const receipt = (tool.outputJsonSchema!.properties as JsonSchema).receipt as JsonSchema;
    expect(receipt).toMatchObject({
      type: 'array',
      items: { properties: { id: { type: 'string' }, delivered: { type: 'boolean' }, reason: { type: 'string' } } },
    });
  });

  it('every authored returns contract is backed by a registered, resolvable schema', () => {
    const violations = returnSchemaViolations(listAllProjectedTools() as readonly CatalogTool[]);
    expect(
      violations.map(({ tool, kind, fields }) => `${tool}: ${kind}${fields.length ? ` (${fields.join(', ')})` : ''}`),
      'guidance.returns prose may interpret a result, but its structural shape must come from outputJsonSchema',
    ).toEqual([]);
  });
});
