import { describe, expect, it, expectTypeOf } from 'vitest';
import type {
  AgentRole,
  Capability,
  ToolDefinition,
  ToolHandler,
  ToolContext,
  ToolResult,
  ProgressCallback,
  RolesQuota,
  PluginToolMap,
} from './index';

describe('Tool type extensions', () => {
  it('AgentRole accepts the seven core roles', () => {
    const roles: AgentRole[] = [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'operator',
    ];
    expect(roles).toHaveLength(7);
  });

  it('AgentRole accepts custom plugin-registered role names via string fallback', () => {
    const custom: AgentRole = 'narrator';
    expect(custom).toBe('narrator');
  });

  it('Capability union accepts tools:<name> and tools:orchestrator:spawn:<role>', () => {
    const a: Capability = 'tools:repomix:pack';
    const b: Capability = 'tools:gitnexus:impact';
    const c: Capability = 'tools:orchestrator:spawn:worker';
    const d: Capability = 'tools:orchestrator:spawn:validator';
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('RolesQuota allows partial windows', () => {
    const workerQuota: RolesQuota = { perChunk: 1 };
    const architectQuota: RolesQuota = { perRun: 5, perDay: 100 };
    const onlyDaily: RolesQuota = { perDay: 50 };
    expect(workerQuota.perChunk).toBe(1);
    expect(architectQuota.perRun).toBe(5);
    expect(onlyDaily.perDay).toBe(50);
  });

  it('ToolDefinition shape is well-typed for a realistic tool', () => {
    const repomixPack: ToolDefinition = {
      name: 'repomix.pack',
      description: 'Pack a project (or subset) into a single LLM-friendly document.',
      inputSchema: {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          format: { enum: ['xml', 'md', 'plain'], default: 'xml' },
        },
      },
      capabilities: ['tools:repomix:pack', 'compute:exec:repomix'],
      roles: ['scoper', 'architect', 'operator', 'reviewer', 'debugger', 'worker'],
      rolesQuota: {
        worker: { perChunk: 1 },
        scoper: { perRun: 3 },
        architect: { perRun: 5 },
      },
      timeoutSec: 60,
      // `largeOutput` is a transport flag on the MCP exposure (ToolExposureMcp), not a
      // top-level ToolDefinition field. A stale top-level copy passed here for months because
      // vitest never typechecks; the package tsconfig (WI-10006702) is what now catches it.
      expose: { mcp: { name: 'repomix.pack', largeOutput: true } },
    };
    expect(repomixPack.name).toBe('repomix.pack');
    expect(repomixPack.expose?.mcp?.largeOutput).toBe(true);
    expect(repomixPack.roles).toContain('worker');
    expect(repomixPack.rolesQuota?.worker?.perChunk).toBe(1);
  });

  it('ToolResult permits text, image, and resource content variants', () => {
    const textOnly: ToolResult = {
      content: [{ type: 'text', text: 'hello' }],
    };
    const mixed: ToolResult = {
      content: [
        { type: 'text', text: 'see attached:' },
        { type: 'resource', resource: { uri: 'file:///x.xml', mimeType: 'application/xml' } },
      ],
    };
    const error: ToolResult = {
      content: [{ type: 'text', text: 'failed: timeout' }],
      isError: true,
    };
    expect(textOnly.content).toHaveLength(1);
    expect(mixed.content).toHaveLength(2);
    expect(error.isError).toBe(true);
  });

  it('ProgressCallback accepts pct + msg, pct only, undefined for indeterminate', () => {
    const calls: Array<[number | undefined, string | undefined]> = [];
    const progress: ProgressCallback = (pct, msg) => {
      calls.push([pct, msg]);
    };
    progress(0, 'starting');
    progress(50);
    progress(undefined, 'indeterminate');
    progress(100, 'done');
    expect(calls).toEqual([
      [0, 'starting'],
      [50, undefined],
      [undefined, 'indeterminate'],
      [100, 'done'],
    ]);
  });

  it('ToolContext exposes spawn lineage fields nullable where appropriate', () => {
    expectTypeOf<ToolContext['featureId']>().toEqualTypeOf<string | null>();
    expectTypeOf<ToolContext['chunkId']>().toEqualTypeOf<string | null>();
    expectTypeOf<ToolContext['parentSpawnId']>().toEqualTypeOf<string | null>();
    expectTypeOf<ToolContext['runId']>().toEqualTypeOf<string>();
    expectTypeOf<ToolContext['spawnId']>().toEqualTypeOf<string>();
    expectTypeOf<ToolContext['workspaceId']>().toEqualTypeOf<string>();
    expectTypeOf<ToolContext['harnessSlug']>().toEqualTypeOf<string>();
  });

  it('ToolHandler is generic over input type', () => {
    interface PackInput {
      include?: string[];
      format?: 'xml' | 'md';
    }
    const handler: ToolHandler<PackInput> = async (input, ctx) => {
      ctx.progress(0, 'starting');
      ctx.log(`packing for harness=${ctx.harnessSlug} include=${input.include?.length ?? 0}`);
      ctx.progress(100, 'done');
      return { content: [{ type: 'text', text: `packed ${input.format ?? 'xml'}` }] };
    };
    expect(typeof handler).toBe('function');
  });

  it('PluginToolMap collects multiple handlers', () => {
    const tools: PluginToolMap = {
      'repomix.pack': async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      'repomix.estimate': async () => ({ content: [{ type: 'text', text: '12345 tokens' }] }),
    };
    expect(Object.keys(tools)).toHaveLength(2);
    expect(tools['repomix.pack']).toBeDefined();
  });
});
