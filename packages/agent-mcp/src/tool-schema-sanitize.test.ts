import { beforeEach, describe, it, expect } from "vitest";
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  resetToolSchemaSanitizeCache,
  sanitizeToolSchema,
  sanitizeToolSchemaCached,
  TOOL_SCHEMA_SANITIZE_CACHE_MAX_ENTRIES,
  negotiatedMcpOutputSchema,
} from "./tool-schema-sanitize";

describe('MCP output schema negotiation with the standard SDK', () => {
  it.each([false, true])('accepts the negotiated reply and preserves validation (structured=%s)', async structured => {
    const schema = { type: 'object' as const, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const published = negotiatedMcpOutputSchema(schema, structured);
    const server = new Server({ name: 'output-contract', version: '1' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'output-contract', version: '1' });
    let invalid = false;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: 'read', inputSchema: { type: 'object' }, ...(published ? { outputSchema: published } : {}),
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'exact raw text' }],
      ...(structured ? { structuredContent: { ok: invalid ? 'invalid' : true } } : {}),
    }));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools[0].outputSchema).toEqual(structured ? schema : undefined);
      const result = await client.callTool({ name: 'read' });
      expect(result.content).toEqual([{ type: 'text', text: 'exact raw text' }]);
      expect(result.structuredContent).toEqual(structured ? { ok: true } : undefined);
      if (structured) {
        invalid = true;
        await expect(client.callTool({ name: 'read' })).rejects.toThrow(/Structured content does not match/);
      }
    } finally { await client.close(); await server.close(); }
  });
});

describe("sanitizeToolSchema", () => {
  it("objectifies a boolean property value (z.unknown() → true)", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: { value: true, name: { type: "string" } },
      additionalProperties: false,
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        value: {
          type: "object",
          additionalProperties: true,
          description: "matches any object value",
        },
        name: { type: "string" },
      },
      additionalProperties: false, // untouched
    });
  });

  it("maps false → { not: {} } (accept-nothing equivalent)", () => {
    expect(sanitizeToolSchema({ properties: { x: false } })).toEqual({
      properties: { x: { not: {} } },
    });
  });

  it("objectifies a boolean items (z.array(z.unknown()) → items:true)", () => {
    expect(sanitizeToolSchema({ type: "array", items: true })).toEqual({
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        description: "matches any object value",
      },
    });
  });

  it("reaches nested properties + items", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: { type: "object", properties: { payload: true } },
        },
        cfg: { type: "object", properties: { value: true } },
      },
    });
    expect((out as any).properties.ops.items.properties.payload).toEqual({
      type: "object",
      additionalProperties: true,
      description: "matches any object value",
    });
    expect((out as any).properties.cfg.properties.value).toEqual({
      type: "object",
      additionalProperties: true,
      description: "matches any object value",
    });
  });

  it(
    "the true-mapping is NEVER a literally-empty object (omp-ollama-tool-schema-investigation-2026-06-30): " +
      "OMP collapses a bare `{}` property/items schema back into the boolean `true` when it serializes its " +
      "own outbound request, re-introducing the construct Ollama 400s on. A non-empty-but-still-unconstrained " +
      "object dodges that re-collapse; this guards the fix from regressing back to `{}`.",
    () => {
      const out = sanitizeToolSchema({
        properties: { a: true },
        items: true,
      }) as Record<string, unknown>;
      const a = (out.properties as Record<string, unknown>).a as Record<
        string,
        unknown
      >;
      expect(Object.keys(a).length).toBeGreaterThan(0);
      expect(
        Object.keys(out.items as Record<string, unknown>).length,
      ).toBeGreaterThan(0);
    },
  );

  it(
    "the true-mapping always carries a `type` keyword (2026-07-01 second OMP collapse): a description-only " +
      "object (no `type`) survives the empty-`{}` collapse above but STILL gets re-collapsed to bare `true` when " +
      "OMP flattens a discriminated-union tool (multiple anyOf branches merged into one object for Ollama) — " +
      "observed live on operator:voice_debug's `detail` field. A real `type` keyword survives both collapses.",
    () => {
      const out = sanitizeToolSchema({ properties: { a: true } }) as Record<
        string,
        unknown
      >;
      const a = (out.properties as Record<string, unknown>).a as Record<
        string,
        unknown
      >;
      expect(a.type).toBeTruthy();
    },
  );

  it("does NOT touch additionalProperties booleans (Ollama ignores; OpenAI strict needs literal false)", () => {
    const schema = {
      type: "object",
      properties: { extra: { type: "object", additionalProperties: true } },
      additionalProperties: false,
    };
    const out = sanitizeToolSchema(schema);
    expect((out as any).additionalProperties).toBe(false);
    expect((out as any).properties.extra.additionalProperties).toBe(true);
  });

  it("leaves a clean schema byte-identical", () => {
    const schema = {
      type: "object",
      properties: {
        slug: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
        status: { type: "string", enum: ["pending", "all"] },
      },
      required: ["slug"],
      additionalProperties: false,
    };
    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it(
    "rewrites an EMPTY-OBJECT property schema (z.unknown() → {}) to a typed form " +
      "(P-031 2026-07-02: OMP collapses a cached `detail: {}` back to bare `true` → Ollama 400)",
    () => {
      const out = sanitizeToolSchema({
        type: "object",
        properties: { detail: {}, op: { type: "string" } },
      });
      const detail = (
        out as { properties: { detail: Record<string, unknown> } }
      ).properties.detail;
      expect(detail.type).toBe("object");
      expect(detail.additionalProperties).toBe(true);
      expect(Object.keys(detail).length).toBeGreaterThan(0);
      expect((out as { properties: { op: unknown } }).properties.op).toEqual({
        type: "string",
      });
    },
  );

  it("rewrites an annotation-only (type-less) property schema, preserving its description", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: { payload: { description: "event payload", default: {} } },
    });
    const payload = (
      out as { properties: { payload: Record<string, unknown> } }
    ).properties.payload;
    expect(payload.type).toBe("object");
    expect(payload.additionalProperties).toBe(true);
    expect(payload.description).toBe("event payload");
    expect(payload.default).toEqual({});
  });

  it("rewrites an empty items schema but leaves constrained type-less schemas (anyOf/enum) alone", () => {
    const out = sanitizeToolSchema({
      type: "object",
      properties: {
        list: { type: "array", items: {} },
        choice: { anyOf: [{ type: "string" }, { type: "number" }] },
        mode: { enum: ["a", "b"] },
      },
    });
    const props = (
      out as { properties: Record<string, Record<string, unknown>> }
    ).properties;
    expect((props.list.items as Record<string, unknown>).type).toBe("object");
    expect(props.choice).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(props.mode).toEqual({ enum: ["a", "b"] });
  });

  it("replaces only recursive self-$ref cycle edges with a typed object for OMP/Ollama", () => {
    const recursiveRef = "#/$defs/filter";
    const out = sanitizeToolSchema({
      type: "object",
      $defs: {
        filter: {
          anyOf: [
            {
              type: "object",
              properties: {
                all: { type: "array", items: { $ref: recursiveRef } },
              },
            },
            {
              type: "object",
              properties: { not: { $ref: recursiveRef } },
            },
          ],
        },
      },
      properties: {
        payload_filter: { $ref: recursiveRef },
      },
    }) as any;

    // Preserve the entry reference: OMP can resolve it to the union. Only the cycle edges are
    // unsafe because its Ollama flattener collapses them to the boolean schema `true`.
    expect(out.properties.payload_filter).toEqual({ $ref: recursiveRef });
    expect(out.$defs.filter.anyOf[0].properties.all.items).toEqual({
      type: "object",
      additionalProperties: true,
      description: "recursive object validated by the tool",
    });
    expect(out.$defs.filter.anyOf[1].properties.not).toEqual({
      type: "object",
      additionalProperties: true,
      description: "recursive object validated by the tool",
    });
  });

  it("preserves non-recursive $ref-only schemas", () => {
    const schema = {
      type: "object",
      $defs: { environment: { type: "string", enum: ["light", "dark"] } },
      properties: { environment: { $ref: "#/$defs/environment" } },
    };

    expect(sanitizeToolSchema(schema)).toEqual(schema);
  });

  it("does not mutate the input", () => {
    const schema = { properties: { x: true } };
    const copy = JSON.parse(JSON.stringify(schema));
    sanitizeToolSchema(schema);
    expect(schema).toEqual(copy); // input still has x: true
  });

  it("passes through a non-object (defensive)", () => {
    expect(sanitizeToolSchema(true as unknown)).toBe(true);
    expect(sanitizeToolSchema(null as unknown)).toBe(null);
  });
});

describe("sanitizeToolSchema position:'output' (EI-22064217935223876)", () => {
  it("maps a boolean property to a plain annotated object, NEVER type:'object' (a real non-object return value must still validate)", () => {
    const out = sanitizeToolSchema(
      { type: "object", properties: { count: true, name: { type: "string" } } },
      "output",
    ) as any;
    expect(out.properties.count).toEqual({ description: "matches any value" });
    expect(out.properties.count.type).toBeUndefined();
    expect(out.properties.name).toEqual({ type: "string" });
  });

  it("maps false → { not: {} } for output too (accept-nothing is position-independent)", () => {
    expect(
      sanitizeToolSchema({ properties: { x: false } }, "output"),
    ).toEqual({ properties: { x: { not: {} } } });
  });

  it("maps a boolean items schema without forcing type:'object'", () => {
    const out = sanitizeToolSchema(
      { type: "array", items: true },
      "output",
    ) as any;
    expect(out.items).toEqual({ description: "matches any value" });
  });

  it("rewrites an empty-object property schema to an annotated (never-empty, never type-forced) object", () => {
    const out = sanitizeToolSchema(
      { type: "object", properties: { hits: {} } },
      "output",
    ) as any;
    expect(out.properties.hits.type).toBeUndefined();
    expect(Object.keys(out.properties.hits).length).toBeGreaterThan(0);
  });

  it("preserves an unconstrained schema's own description instead of the generic placeholder", () => {
    const out = sanitizeToolSchema(
      { type: "object", properties: { detail: { description: "raw payload" } } },
      "output",
    ) as any;
    expect(out.properties.detail).toEqual({ description: "raw payload" });
    expect(out.properties.detail.type).toBeUndefined();
  });

  it("replaces a recursive self-$ref cycle edge with a description-only placeholder (no type:'object')", () => {
    const recursiveRef = "#/$defs/node";
    const out = sanitizeToolSchema(
      {
        type: "object",
        $defs: {
          node: {
            type: "object",
            properties: { child: { $ref: recursiveRef } },
          },
        },
        properties: { root: { $ref: recursiveRef } },
      },
      "output",
    ) as any;
    expect(out.properties.root).toEqual({ $ref: recursiveRef });
    expect(out.$defs.node.properties.child).toEqual({
      description: "recursive value validated by the tool",
    });
  });

  it("default position stays 'input' — omitting the argument is byte-identical to the pre-fix behavior", () => {
    const schema = { properties: { a: true }, items: true };
    expect(sanitizeToolSchema(schema)).toEqual(
      sanitizeToolSchema(schema, "input"),
    );
  });
});

describe("sanitizeToolSchemaCached", () => {
  beforeEach(() => resetToolSchemaSanitizeCache());

  it("reuses one immutable sanitized tree for an unchanged registry revision and variant", () => {
    const first = sanitizeToolSchemaCached("rev-7:plans:get:full", {
      type: "object",
      properties: { payload: true },
    });
    const second = sanitizeToolSchemaCached("rev-7:plans:get:full", {
      type: "object",
      properties: { payload: true },
    });

    expect(second).toBe(first);
    expect(second).toEqual({
      type: "object",
      properties: {
        payload: {
          type: "object",
          additionalProperties: true,
          description: "matches any object value",
        },
      },
    });
  });

  it("separates registry revisions, listing variants, and input/output semantics", () => {
    const schema = { type: "object", properties: { payload: true } };
    const full = sanitizeToolSchemaCached("rev-7:plans:get:full", schema);
    const compact = sanitizeToolSchemaCached("rev-7:plans:get:compact", schema);
    const nextRevision = sanitizeToolSchemaCached("rev-8:plans:get:full", schema);
    const output = sanitizeToolSchemaCached("rev-7:plans:get:full", schema, "output");

    expect(compact).not.toBe(full);
    expect(nextRevision).not.toBe(full);
    expect(output).not.toBe(full);
    expect((output as any).properties.payload).toEqual({
      description: "matches any value",
    });
  });

  it("stays bounded across registry revisions", () => {
    const originalOldest = sanitizeToolSchemaCached("revision-0:tool:full", {
      type: "object",
      properties: { value: { const: 0 } },
    });
    for (let i = 1; i <= TOOL_SCHEMA_SANITIZE_CACHE_MAX_ENTRIES; i += 1) {
      sanitizeToolSchemaCached(`revision-${i}:tool:full`, {
        type: "object",
        properties: { value: { const: i } },
      });
    }

    const rebuiltOldest = sanitizeToolSchemaCached("revision-0:tool:full", {
      type: "object",
      properties: { value: { const: 0 } },
    });
    const rebuiltOldestAgain = sanitizeToolSchemaCached("revision-0:tool:full", {
      type: "object",
      properties: { value: { const: 0 } },
    });
    expect(rebuiltOldest).not.toBe(originalOldest);
    expect(rebuiltOldestAgain).toBe(rebuiltOldest);
  });
});
