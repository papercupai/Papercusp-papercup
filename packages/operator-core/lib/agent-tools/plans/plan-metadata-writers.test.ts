/**
 * P-002: the REAL template/schema handlers validate the snapshot passed by the
 * canonical lock callback, not an earlier preflight. Lock/persistence IO is
 * injected; this is handler wiring evidence, not a PostgreSQL concurrency test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { PlanWriteMeta } from './with-plan-lock';
import { evaluatePlanStartReadiness } from './plan-input-validation';
import { metadataHarness, metadataInputSchema, metadataPlanSlug } from './coordination-metadata-fixtures';

const state = vi.hoisted(() => ({
  body: '', schema: null as unknown, writes: [] as unknown[], lockCalls: 0,
}));
vi.mock('./with-plan-lock', () => ({
  withPlanLock: async (
    _ctx: unknown, _opts: unknown,
    mutate: (body: string, meta: PlanWriteMeta) => Promise<{
      newBody: string | null; templateData?: unknown; inputSchema?: unknown; value: unknown;
    }>,
  ) => {
    state.lockCalls++;
    const result = await mutate(state.body, {
      version: 2, contentHash: 'locked', opStatus: null, planStatus: null,
      inputSchema: state.schema, templateData: null, outputSchema: null, nowNote: null,
    });
    if (result.templateData !== undefined) state.writes.push(result.templateData);
    if (result.inputSchema !== undefined) state.writes.push(result.inputSchema);
    if (result.newBody !== null) state.writes.push(result.newBody);
    return { kind: 'applied', value: result.value, version: 3 };
  },
}));
vi.mock('./revisions', () => ({
  planRevisionCapture: () => ({ afterWrite: vi.fn(), recorded: { current: null } }),
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

import dataTool from './set-template-data';
import schemaTool from './set-input-schema';

const ctx: UnifiedToolContext = {
  harnessSlug: metadataHarness, workspaceId: 'metadata-fixture-workspace',
  log: () => {}, signal: new AbortController().signal, progress: () => {}, emit: () => {},
};

beforeEach(() => {
  state.body = `---\ntitle: Metadata\nslug: ${metadataPlanSlug}\nstatus: draft\n---\n\n## Now\n**State:** draft\n**Next:** validate\n`;
  state.schema = metadataInputSchema.inputSchema;
  state.writes = [];
  state.lockCalls = 0;
});

describe('canonical metadata writer validation', () => {
  it('rejects against a schema changed after an earlier successful preflight, without a patch', async () => {
    const data = { harness: 'fixture', attempts: 1 };
    expect(evaluatePlanStartReadiness(metadataInputSchema, data).ready).toBe(true);
    state.schema = {
      type: 'object', properties: { harness: { type: 'string' }, attempts: { type: 'integer', maximum: 0 } },
    };
    const result = await dataTool.handler(dataTool.args.parse({ slug: metadataPlanSlug, data }), ctx);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('invalid_data');
    expect(state.lockCalls).toBe(1);
    expect(state.writes).toEqual([]);
  });

  it('preserves incremental JSON-data writes, without pretending they are startable', async () => {
    const data = { attempts: 1 };
    const result = await dataTool.handler(dataTool.args.parse({ slug: metadataPlanSlug, data }), ctx);
    expect(result).not.toHaveProperty('isError', true);
    expect(state.writes).toEqual([{ data }]);
    expect(evaluatePlanStartReadiness(metadataInputSchema, data).ready).toBe(false);
  });

  it('refuses a schema declaration if a registry template appeared before the locked write', async () => {
    state.body = state.body.replace('status: draft', 'status: draft\ntemplate: rubric');
    const result = await schemaTool.handler(schemaTool.args.parse({
      slug: metadataPlanSlug, schema: metadataInputSchema.inputSchema,
    }), ctx);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('template_conflict');
    expect(state.lockCalls).toBe(1);
    expect(state.writes).toEqual([]);
  });

  it('never persists an uncheckable schema', async () => {
    const result = await schemaTool.handler(schemaTool.args.parse({
      slug: metadataPlanSlug, schema: { type: 'banana' },
    }), ctx);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('bad_schema');
    expect(state.writes).toEqual([]);
  });
});
