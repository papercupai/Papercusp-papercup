/**
 * Tests for the tools:find defineTool wiring (tool-discovery-for-weak-models WS3).
 * Importing the file triggers defineTool registration, so a compile/import/
 * capability error fails here too.
 *
 * The embedder module is mocked to return NO embedder, so the tool runs in its
 * graceful-degrade (lexical-only) mode deterministically — no network, no DB.
 * The semantic index BUILD path is covered separately via the injectable
 * buildEmbeddingIndex (a mock embedder), and the semantic FUSION via
 * tool-find.test.ts.
 *
 * Run with: npx vitest run packages/operator-core/lib/agent-tools/tools/find.test.ts
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { addresseeArg } from '../_addressee-arg';
import { defineTool } from '@papercusp/agent-mcp';
import '../work_items/set_state';
import '../scheduler/get_next';
import { nestedProjectionContext } from '../../result-projection/nested-dispatch';
import devServiceHealth from '../dev/service_health';
import launchAgent from '../capability/launch-agent';
import activityToolLog from '../activity/tool-log';
import releaseCut from '../release/cut';
import releaseTrace from '../release/trace';
import plansNew from '../plans/new';
import plansAudit from '../plans/audit';
import plansSetSpecs from '../plans/set-specs';
import bindSpecEvidence from '../plans/bind-spec-evidence';
import plansSearch from '../plans/search';
import crossHarnessPlansSearch from '../cross_harness/plans_search';
import docsGet from '../docs/get';
import eventsAwait from '../events/await';
import loopArm from '../loop/arm';
import complete from '../work_items/complete';
import workItemsCreate from '../work_items/create';
import workItemsGet from '../work_items/get';
import workItemsRelease from '../work_items/release';
import workItemsCheckpoint from '../work_items/checkpoint';
import workItemsSetBlocker from '../work_items/set_blocker';
import coordSend from '../coordination/tools/send';
import coordHandoff from '../coordination/tools/handoff';
import coordConditions from '../coordination/tools/conditions';
import sessionsRead from '../sessions/read';
import ompSessions from '../omp/sessions';
import sessionCarryDrill from '../session/carry-drill';
import capabilityRead from '../capability/read';
import bashOutput from '../capability/bash_output';
import bashKill from '../capability/bash_kill';
import factsAssert from '../facts/assert';
import { bulkRunReport } from '../inbox/bulk-run';
import agentReview from '../improvements/agent-review';
import captureTool from '../improvements/capture';
import recipesRun from '../recipes/run';
import rubricsPropose from '../rubrics/propose';
import './invoke';
import { COORD_SEND_MAX_CHUNK_PARTS, DEFAULT_INBOX_BODY_CAP } from '../coordination/tools/inbox-content-bounds';
import { chunkContentBudget } from '../coordination/tools/send-chunking';
import { scorecardEmitArgs } from '../scorecards/emit';
import scorecardEvaluate from '../scorecards/evaluate';
import { schemaAliasAnnotation } from '../../cupboard/tools-discovery';
import { findTools } from '../../cupboard/tool-find';
import {
  COMPLETION_COVERAGE_CALL_CONSTRAINT,
  ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT,
  ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT,
  ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION,
  ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES,
  ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS,
  RootCauseVerificationSchema,
} from '../../coord-lifecycle/records';

// Force lexical-only: buildQueryEmbedder resolves to null (unconfigured embedder).
vi.mock('../search/embedder', () => ({
  buildQueryEmbedder: vi.fn().mockResolvedValue(null),
  interactiveEmbedAcquireBudgetMs: () => 4000,
}));

const hiveMocks = vi.hoisted(() => ({
  potHomeSlugForHarness: vi.fn(),
}));

const pluginHostMocks = vi.hoisted(() => ({
  getPluginHost: vi.fn(),
}));

const servingGenerationMocks = vi.hoisted(() => ({
  read: vi.fn(),
}));

vi.mock('../../hive-federation', () => ({
  potHomeSlugForHarness: hiveMocks.potHomeSlugForHarness,
}));

vi.mock('../../plugin-host-runtime', () => ({
  getPluginHost: pluginHostMocks.getPluginHost,
}));

vi.mock('../../serving-generation', () => ({
  readServingGeneration: servingGenerationMocks.read,
}));

import toolFind, {
  boundDiscoveryHits,
  buildEmbeddingIndex,
  buildCorpus,
  compactOutputSchemaForResult,
  compactSchemaForResult,
  DISCOVERY_RESULT_MAX_BYTES,
  PLUGIN_HOST_READINESS_TIMEOUT_MS,
  TOOLS_FIND_DEFAULT_LIMIT,
  TOOLS_FIND_LIMIT_MAX,
  ensureIndex,
  exactToolNamesInQuery,
  exactToolNamesInCorpus,
  normalizeToolsFindArgs,
  filterCorpusForConfirmedHiveScope,
  prioritizeExactToolHits,
  warmToolFindIndex,
} from './find';

type ToolDef = {
  name: string;
  capability: string;
  requirePrincipal: boolean;
  args: { safeParse: (v: unknown) => { success: boolean } };
  handler: (a: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

async function callHandler(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const res = await (toolFind as unknown as ToolDef).handler(args, ctx);
  return JSON.parse(res.content[0].text) as {
    query: string;
    count: number;
    semantic: 'on' | 'warming' | 'lexical-only';
    registry: { source: string; revision: string };
    servingGeneration: string | null;
    hits: Array<{
      tool: string;
      description: string | null;
      argSchema: string | null;
      returns: string | null;
      returnsSource: 'registered-output-schema' | 'authored-tool-guidance' | null;
      via: string;
    }>;
    omittedTools?: string[];
    truncated: boolean;
    howToCall: string;
  };
}

function expectBehaviorClassInBothShapes(schema: string) {
  const specStart = schema.indexOf('spec?:object{');
  const itemsStart = schema.indexOf('; items?:array', specStart);
  expect(specStart).toBeGreaterThanOrEqual(0);
  expect(itemsStart).toBeGreaterThan(specStart);
  expect(schema.slice(specStart, itemsStart)).toContain('behaviorClass:enum(');
  expect(schema.slice(itemsStart)).toContain('behaviorClass:enum(');
}

beforeEach(() => {
  hiveMocks.potHomeSlugForHarness.mockReset();
  hiveMocks.potHomeSlugForHarness.mockResolvedValue(null);
  pluginHostMocks.getPluginHost.mockReset();
  pluginHostMocks.getPluginHost.mockResolvedValue({ loaded: [] });
  servingGenerationMocks.read.mockReset();
  servingGenerationMocks.read.mockResolvedValue({
    state: 'known',
    revision: 'serving-generation-v1:test',
    buildSha: 'test-build',
    appliedMigrationDigest: 'test-migrations',
    toolRegistryRevision: 'test-registry',
  });
});

describe('tools:find tool registration', () => {
  it('registers with the expected name + capability + args', () => {
    const def = toolFind as unknown as ToolDef;
    expect(def.name).toBe('tools:find');
    expect(def.capability).toBe('agent_tools:read');
    expect(def.requirePrincipal).toBe(false);
    expect((def as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    expect((def as { guidance?: { notWhen?: string } }).guidance?.notWhen).toContain(
      'accepted but ignored — it never filters or narrows results',
    );
    // args schema accepts a query, rejects an empty one.
    expect(def.args.safeParse({ query: 'feature flag' }).success).toBe(true);
    expect(def.args.safeParse({ query: '' }).success).toBe(false);
    expect(def.args.safeParse({ query: 'feature flag', limit: TOOLS_FIND_LIMIT_MAX }).success).toBe(true);
    expect(def.args.safeParse({ query: 'feature flag', limit: TOOLS_FIND_LIMIT_MAX + 1 }).success).toBe(false);
    const missing = def.args.safeParse({});
    expect(missing.success).toBe(false);
  });

  it('publishes the result-count cap in the live discovery schema', async () => {
    const out = await callHandler({ query: 'tools:find', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'tools:find');

    expect(hit?.description).toContain('`limit` defaults to 8, accepts 1-25, and values above 25 are rejected');
    expect(hit?.argSchema).toContain(`limit?:integer(>0-${TOOLS_FIND_LIMIT_MAX})`);
    expect(hit?.argSchema).toContain(`defaults to ${TOOLS_FIND_DEFAULT_LIMIT}`);
    expect(hit?.argSchema).toContain(`values above ${TOOLS_FIND_LIMIT_MAX} are rejected`);
  });

  it('accepts legacy q and normalizes it to query, with query taking precedence', () => {
    const def = toolFind as unknown as {
      args: {
        safeParse: (value: unknown) => {
          success: boolean;
          data?: { query?: unknown; q?: unknown };
        };
      };
    };

    const legacy = def.args.safeParse({ q: 'find a feature flag' });
    expect(legacy.success).toBe(true);
    expect(legacy.data).toMatchObject({ query: 'find a feature flag' });
    expect(legacy.data).not.toHaveProperty('q');

    const both = def.args.safeParse({ q: 'legacy intent', query: 'canonical intent' });
    expect(both.success).toBe(true);
    expect(both.data).toMatchObject({ query: 'canonical intent' });
    expect(both.data).not.toHaveProperty('q');
  });

  it('keeps tools:find normalization pure for non-object input and canonical precedence', () => {
    const original = { query: 'canonical intent' };
    expect(normalizeToolsFindArgs(original)).toBe(original);
    expect(normalizeToolsFindArgs('legacy intent')).toBe('legacy intent');
    expect(normalizeToolsFindArgs({ q: 'legacy intent', query: 'canonical intent' })).toEqual({
      query: 'canonical intent',
    });
  });

  it('EI-21854434860586936: accepts (and ignores) caller-supplied harness/workspace scope hints', () => {
    const def = toolFind as unknown as ToolDef;
    // Every other harness/workspace-scoped tool in the catalog accepts these
    // keys, so callers naturally pass them here too — the strict schema must
    // not reject them as unrecognized (that was the recurring caller-error).
    expect(def.args.safeParse({ query: 'feature flag', harness: 'papercusp' }).success).toBe(true);
    expect(def.args.safeParse({ query: 'feature flag', workspace: 'papercusp-workspace' }).success).toBe(true);
    expect(
      def.args.safeParse({ query: 'feature flag', harness: 'papercusp', workspace: 'papercusp-workspace' }).success,
    ).toBe(true);
    // Still rejects a genuinely unknown key.
    expect(def.args.safeParse({ query: 'feature flag', bogus: 'nope' }).success).toBe(false);
  });

  it('EI-21854434860586936: caller-supplied harness/workspace hints do not change results (accept-and-ignore)', async () => {
    const withoutHint = await callHandler({ query: 'feature flag' });
    const withHint = await callHandler({ query: 'feature flag', harness: 'some-other-harness', workspace: 'some-other-workspace' });
    expect(withHint.hits.map((h) => h.tool)).toEqual(withoutHint.hits.map((h) => h.tool));
  });

  it('keeps current discovery compatible with a legacy tools:invoke schema while retaining the transport fence', async () => {
    const out = await callHandler({ query: 'coord:inbox', limit: 1 });

    expect(out.servingGeneration).toBe('serving-generation-v1:test');
    const legacyInvokeArgs = z.object({
      name: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
    }).strict();
    const legacyCall = { name: 'coord:inbox', args: { limit: 1 } };
    expect(legacyInvokeArgs.safeParse(legacyCall).success).toBe(true);
    expect(legacyInvokeArgs.safeParse({ ...legacyCall, servingGeneration: out.servingGeneration }).success).toBe(false);
    expect(out.howToCall).toContain('Use tools:invoke');
    expect(out.howToCall).toContain('legacy callable schemas may reject it');
    expect(out.howToCall).toContain('papercusp/servingGeneration');
    expect(out.howToCall).not.toContain('pass it unchanged as `servingGeneration` to tools:invoke');
    expect(servingGenerationMocks.read).toHaveBeenCalledWith({
      toolRegistryRevision: out.registry.revision,
    });
  });

  it('warns against cross-operator dispatch when the serving generation is unknown', async () => {
    servingGenerationMocks.read.mockResolvedValueOnce({ state: 'unknown', reason: 'build-sha-unknown' });

    const out = await callHandler({ query: 'coord:inbox', limit: 1 });

    expect(out.servingGeneration).toBeNull();
    expect(out.howToCall).toContain('server generation is unknown');
    expect(out.howToCall).toContain('do not send this schema through a different operator');
  });
});

describe('documented tools:find argSchema selection (EI-25211864676774274)', () => {
  type Selection = {
    tool: string;
    status: 'available' | 'unavailable';
    format?: 'compact-text' | 'json-schema';
    argSchema?: unknown;
    reason?: string;
  };

  async function runExample(hits: Array<Record<string, unknown>>): Promise<Selection[]> {
    const source = readFileSync(new URL(
      '../../../../../apps/operator-docs/src/content/docs/agent-insights/toolsearch-stale-schema-snapshot-vs-imperative-required-field.mdx',
      import.meta.url,
    ), 'utf8');
    const examples = [...source.matchAll(
      /\{\/\* tools-find-argschema-example:start \*\/\}\r?\n```js\r?\n([\s\S]*?)\r?\n```\r?\n\{\/\* tools-find-argschema-example:end \*\/\}/g,
    )];
    expect(examples, 'the maintained runbook must contain exactly one executable example').toHaveLength(1);
    const find = vi.fn().mockResolvedValue({ hits });
    const selected = await runInNewContext(
      `(async () => {\n${examples[0][1]}\n})()`,
      { tools: { tools: { find } } },
      { timeout: 1000 },
    ) as Selection[];
    expect(find).toHaveBeenCalledExactlyOnceWith({ query: 'work_items:get tools:invoke', limit: 8 });
    expect(selected.map((row) => row.tool)).toEqual(['work_items:get', 'tools:invoke']);
    return selected;
  }

  const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

  it('preserves actual compactSchemaForResult text byte-for-byte and selects exact names only', async () => {
    const compact = compactSchemaForResult(schema);
    expect(typeof compact).toBe('string');
    const selected = await runExample([
      { tool: 'work_items:get-extra', argSchema: schema },
      { tool: 'tools:invoke', argSchema: compact, description: 'do not copy', returns: 'do not copy' },
      { tool: 'work_items:get', argSchema: compact, description: 'do not copy', via: 'lexical' },
      { tool: 'unrelated', argSchema: schema },
    ]);
    for (const row of selected) {
      expect(row).toEqual({ tool: row.tool, status: 'available', format: 'compact-text', argSchema: compact });
      expect(Object.keys(row).sort()).toEqual(['argSchema', 'format', 'status', 'tool']);
      expect(row).not.toHaveProperty('properties');
    }
  });

  it.each([
    ['object', schema],
    ['JSON-encoded object', JSON.stringify(schema)],
  ])('retains properties and required from a %s schema', async (_label, argSchema) => {
    const [selected] = await runExample([{ tool: 'work_items:get', argSchema }]);
    expect(selected).toEqual({ tool: 'work_items:get', status: 'available', format: 'json-schema', argSchema: schema });
  });

  it('keeps arbitrary non-JSON text opaque without semantic validation', async () => {
    const opaque = '  caller-supplied schema guidance: unknown grammar\n';
    const [selected] = await runExample([{ tool: 'work_items:get', argSchema: opaque }]);
    expect(selected).toEqual({ tool: 'work_items:get', status: 'available', format: 'compact-text', argSchema: opaque });
  });

  it('labels an absent exact hit unavailable', async () => {
    const selected = await runExample([{ tool: 'work_items:get-extra', argSchema: schema }]);
    expect(selected).toEqual([
      { tool: 'work_items:get', status: 'unavailable', reason: 'missing-hit' },
      { tool: 'tools:invoke', status: 'unavailable', reason: 'missing-hit' },
    ]);
  });

  it.each([null, undefined, 7, true, [], 'null', '42', 'true', '["id"]', '"JSON string"'])(
    'labels unsupported or non-object JSON schema %j unavailable without manufacturing properties',
    async (argSchema) => {
      const [selected] = await runExample([{ tool: 'work_items:get', argSchema }]);
      expect(selected).toEqual({ tool: 'work_items:get', status: 'unavailable', reason: 'unsupported-schema' });
      expect(Object.keys(selected).sort()).toEqual(['reason', 'status', 'tool']);
    },
  );

  it.each(['', ' \n '])('labels empty schema text %j unavailable', async (argSchema) => {
    const [selected] = await runExample([{ tool: 'work_items:get', argSchema }]);
    expect(selected).toEqual({ tool: 'work_items:get', status: 'unavailable', reason: 'missing-schema' });
  });

  it.each(['{bad JSON', '[bad JSON', '"unfinished'])('labels malformed JSON-looking text %j unavailable', async (argSchema) => {
    const [selected] = await runExample([{ tool: 'work_items:get', argSchema }]);
    expect(selected).toEqual({ tool: 'work_items:get', status: 'unavailable', reason: 'malformed-json' });
  });
});

describe('buildEmbeddingIndex (boot-time index builder)', () => {
  it('embeds each row → name→vector map', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['a', 'aaa'],
        ['c', 'ccccc'],
      ]),
      async (t) => [t.length, 0, 0],
    );
    expect(idx.get('a')).toEqual([3, 0, 0]);
    expect(idx.get('c')).toEqual([5, 0, 0]);
  });

  it('skips a row whose embedder throws (partial index still helps)', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['ok', 'fine'],
        ['boom', 'boom'],
      ]),
      async (t) => {
        if (t.includes('boom')) throw new Error('admission shed');
        return [1, 1];
      },
    );
    expect(idx.has('ok')).toBe(true);
    expect(idx.has('boom')).toBe(false);
  });

  it('skips a row that embeds to an empty vector', async () => {
    const idx = await buildEmbeddingIndex(
      new Map([
        ['x', 'x'],
        ['y', 'y'],
      ]),
      async (t) => (t === 'x' ? [] : [1]),
    );
    expect(idx.has('x')).toBe(false);
    expect(idx.has('y')).toBe(true);
  });

  it('rebuilds the module index when the registry revision changes at the same size', async () => {
    const embedder = vi.fn(async (text: string) => [text === 'old contract' ? 1 : 2]);
    const oldText = new Map([['same-tool', 'old contract']]);
    const newText = new Map([['same-tool', 'new contract']]);

    await ensureIndex(oldText, embedder, 'registry-r1');
    expect(embedder).toHaveBeenCalledTimes(1);

    // The map cardinality is unchanged, but its executable registry revision
    // changed. Reusing the old vector would make semantic discovery stale.
    await ensureIndex(newText, embedder, 'registry-r2');
    expect(embedder).toHaveBeenCalledTimes(2);

    // Repeated calls for the same revision remain single-build/idempotent.
    await ensureIndex(newText, embedder, 'registry-r2');
    expect(embedder).toHaveBeenCalledTimes(2);
  });
});

describe('buildCorpus (live registry → corpus + embed text)', () => {
  it('reuses a snapshot until the projected registry revision changes', () => {
    const first = buildCorpus();
    const second = buildCorpus();
    expect(second.corpus).toBe(first.corpus);
    expect(second.embedText).toBe(first.embedText);

    const name = 'test:tools-find-corpus-cache';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.object({ value: z.string() }),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });

    const afterRegistration = buildCorpus();
    expect(afterRegistration.corpus).not.toBe(first.corpus);
    expect(afterRegistration.corpus.some((entry) => entry.tool === name)).toBe(true);
  });

  it('includes tools:find itself, with arg-schema text folded in', () => {
    const { corpus, embedText } = buildCorpus();
    const self = corpus.find((e) => e.tool === 'tools:find');
    expect(self).toBeDefined();
    // tools:find takes { query, limit? } → its arg-schema text mentions the query arg.
    expect(self?.argSchema).toContain('query');
    expect(self?.argSchema).toContain('query?:');
    expect(self?.argSchema).toContain('q');
    expect(self?.argSchema).toContain('Compatibility alias for `query`');
    // The embed text folds name + description + arg schema.
    const text = embedText.get('tools:find');
    expect(text).toContain('tools:find');
    expect(text).toContain('query');
  });

  it('publishes coord:conditions exact-key lookup in tools:find', async () => {
    expect(coordConditions.name).toBe('coord:conditions');
    const result = await callHandler({ query: 'coord:conditions', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'coord:conditions');

    expect(hit).toBeDefined();
    expect(hit?.argSchema).toContain('condition_key?:string(1-2000)');
  });

  it('publishes capability:launch-agent conditional brief requirements in discovery output', async () => {
    expect(launchAgent.name).toBe('capability:launch-agent');
    const result = await callHandler({ query: 'capability:launch-agent', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'capability:launch-agent');

    expect(hit).toBeDefined();
    expect(hit?.argSchema).toContain('brief?:string');
    expect(hit?.argSchema).toContain(
      'constraint:$ (resume or fork => non-empty top-level brief required, except guarded system:lineage-neutral-successor resume)',
    );

    const recoveryArgs = { resume: { agentId: 'su-a1a71' }, headless: true, account: 'auto' };
    expect(launchAgent.args.safeParse(recoveryArgs).success).toBe(false);
    expect(
      launchAgent.args.safeParse({ ...recoveryArgs, brief: 'continue the recovery' }).success,
    ).toBe(true);
  });

  it('derives return shapes from registered output schemas before authored prose', () => {
    const name = 'test:derived-return-shape';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.object({}),
      result: z.object({ actual: z.string(), count: z.number().int() }),
      guidance: { returns: '{ stale_authored_shape }' },
      handler: async () => ({ data: { actual: 'ok', count: 1 } }),
    });

    const { returnsByTool, returnSourcesByTool } = buildCorpus();
    expect(returnsByTool.get(name)).toContain('actual:string');
    expect(returnsByTool.get(name)).not.toContain('stale_authored_shape');
    expect(returnSourcesByTool.get(name)).toBe('registered-output-schema');
    expect(compactOutputSchemaForResult({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })).toContain('array{id:string}');
  });

  it('projects dev:service_health registered result fields into discovery', async () => {
    expect(devServiceHealth.name).toBe('dev:service_health');
    const out = await callHandler({ query: 'dev:service_health', limit: 1 });
    const health = out.hits.find((hit) => hit.tool === 'dev:service_health');

    expect(health?.returnsSource).toBe('registered-output-schema');
    expect(health?.returns).toContain('healthPhaseTimingsMs:object');
    expect(health?.returns).toContain('unitStates?');
    expect(health?.returns).toContain('unitsUnknown?');
    expect(health?.returns).toContain('scopesUnavailable?');
  });

  it('publishes checkpoint and bounded comment paths under the work-item result envelope', async () => {
    expect(workItemsGet.name).toBe('work_items:get');
    const out = await callHandler({ query: 'work_items:get', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'work_items:get');
    expect(hit?.returnsSource).toBe('registered-output-schema');
    expect(hit?.returns).toContain('results:array{');
    expect(hit?.returns).toContain('checkpoint?:string|null');
    expect(hit?.returns).toContain('threadWindow?:object|null{total:integer');
    expect(hit?.returns).toContain('posts:array');
    expect(hit?.returns).toContain('workItem?');
    expect(hit?.returns?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('shows carry-row soft caps in caller-facing discovery results', async () => {
    expect(workItemsCheckpoint.name).toBe('work_items:checkpoint');
    const out = await callHandler({ query: 'work_items:checkpoint', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'work_items:checkpoint');

    expect(hit?.argSchema).toContain('verified?:string(≤1200 (soft cap ≤300))');
  });

  it('publishes the checkpoint root constraint in compact tool discovery', async () => {
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('work_items:checkpoint')) ?? '';
    const constraintPrefix = 'constraint:$ (With `items[]`, omit root-level `checkpoint`, `note`, `did`';

    expect(compact).toContain(constraintPrefix);
    expect(compact).toContain('`confirmShrink`');
    expect(compact).toContain('remain defaults for entries');

    const out = await callHandler({ query: 'work_items:checkpoint', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'work_items:checkpoint');
    expect(hit?.argSchema).toContain(constraintPrefix);
    expect(hit?.argSchema).toContain('remain defaults for entries');
  });

  it('shows required behaviorClass in plans:set-specs compact discovery', async () => {
    expect(plansSetSpecs.name).toBe('plans:set-specs');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:set-specs')) ?? '';
    expectBehaviorClassInBothShapes(compact);
  });

  it('preserves the nested plans:set-specs falsifier scenario pattern in compact discovery', async () => {
    const proofObligationIdPattern = '~/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/';
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:set-specs')) ?? '';

    expect(compact).toMatch(/falsifier\?:object(?:\|null)?\{[^}]*requiredScenarios\?:array/);
    expect(compact).toContain(proofObligationIdPattern);

    const out = await callHandler({ query: 'plans:set-specs', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'plans:set-specs');
    const argSchema = hit?.argSchema ?? '';
    expect(argSchema).toMatch(/falsifier\?:object(?:\|null)?\{[^}]*requiredScenarios\?:array/);
    expect(argSchema).toContain(proofObligationIdPattern);
    expectBehaviorClassInBothShapes(argSchema);
  });

  it('publishes work_items:get resume exclusivity before dispatch', async () => {
    const out = await callHandler({ query: 'work_items:get', limit: 1 });
    const hit = out.hits.find((entry) => entry.tool === 'work_items:get');
    expect(hit?.argSchema).toContain(
      'constraint:$ (resume requires one item (pass `id`, or a one-element `ids` array; multi-id batches are not supported) and cannot be combined with detail, checksOnly, checkpointOnly, offset, limit, threadLimit, priorAttemptRefs or operationalBrief; use a separate read for those enrichments',
    );
  });

  it('publishes improvements:capture text-input requirements from the runtime validator (EI-22685673523193526)', async () => {
    const result = await callHandler({ query: 'improvements:capture', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'improvements:capture');
    expect(hit).toBeDefined();
    expect(hit!.argSchema).toContain(
      'constraint:$ (at least one of title, body, or toolFailure is required; title is required when both body and toolFailure are omitted',
    );

    const missingText = captureTool.args.safeParse({ lane: 'observation', checkDuplicatesOnly: true });
    expect(missingText.success).toBe(false);
    expect(hit!.argSchema).toContain('title?:string(1-1000)');
    expect(captureTool.args.safeParse({ lane: 'observation', body: 'body-only capture' }).success).toBe(true);
  });

  it('keeps the structured observation subject shape visible in improvements:capture discovery (EI-24759188330677893)', async () => {
    const { schemaByTool } = buildCorpus();
    const subjectShape = 'subject?:object{kind?:enum(agent-run|session|work-item|plan|pot),ref:string';
    expect(compactSchemaForResult(schemaByTool.get('improvements:capture'))).toContain(subjectShape);

    const result = await callHandler({ query: 'improvements:capture', limit: 1 });
    expect(result.hits.find((entry) => entry.tool === 'improvements:capture')?.argSchema).toContain(subjectShape);
  });

  it('uses the raw discovery schema for a release:trace-style path-or-sha union', () => {
    const name = 'test:release-trace-discovery-schema';
    defineTool({
      name,
      capability: 'test:read',
      requirePrincipal: false,
      args: z.union([
        z.object({ path: z.string().min(1), sha: z.string().optional() }),
        z.object({ path: z.string().optional(), sha: z.string().min(4) }),
      ]),
      handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    });

    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === name);
    expect(entry?.argSchema).toContain('one-of:path|sha');
    expect(entry?.argSchema).toContain('path?:string');
    expect(entry?.argSchema).toContain('sha?:string');
    expect(schemaByTool.get(name)).toMatchObject({ anyOf: expect.any(Array) });
  });

  it('exposes the actual release:trace path-or-sha requirements to discovery', () => {
    expect(releaseTrace.name).toBe('release:trace');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'release:trace');
    expect(entry?.argSchema).toContain('one-of:path|sha');
    expect(entry?.argSchema).toContain('path?:string');
    expect(entry?.argSchema).toContain('sha?:string');
    expect(schemaByTool.get('release:trace')).toMatchObject({ anyOf: expect.any(Array) });
  });

  it('EI-25577107953770833: advertises release:cut branch-specific fields without leaking them into reclaim', () => {
    expect(releaseCut.name).toBe('release:cut');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'release:cut');
    const branchRule =
      'when op in (preflight|prepare-tag|status|handoff|abort-leg|gate-status|reclaim) => work_item_id';
    const rootRule = 'when op in (abort-leg|reclaim) => root forbidden';

    expect(entry?.argSchema).toContain(branchRule);
    expect(entry?.argSchema).toContain(rootRule);
    expect(entry?.argSchema).toContain('forbidden');
    expect(compactSchemaForResult(schemaByTool.get('release:cut'))).toContain(branchRule);
    expect(compactSchemaForResult(schemaByTool.get('release:cut'))).toContain(rootRule);
  });

  it('advertises session:carry-drill fields only on the operation variants that accept them', () => {
    expect(sessionCarryDrill.name).toBe('session:carry-drill');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'session:carry-drill');
    const reportDrillIdRule = 'when op in (start|report|retire|unretire) => drillId forbidden';

    expect(entry?.argSchema).toContain(reportDrillIdRule);
    expect(compactSchemaForResult(schemaByTool.get('session:carry-drill'))).toContain(reportDrillIdRule);
    expect(sessionCarryDrill.args.safeParse({ op: 'report', drillId: 'drill-1' }).success).toBe(false);
    expect(sessionCarryDrill.args.safeParse({ op: 'grade', drillId: 'drill-1' }).success).toBe(true);
  });

  it('advertises omp:sessions advSessionId only on the link variant', () => {
    expect(ompSessions.name).toBe('omp:sessions');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'omp:sessions');
    const compact = compactSchemaForResult(schemaByTool.get('omp:sessions')) ?? '';
    const linkOnlyRule = 'when op=link => advSessionId required; when op!=link => advSessionId forbidden';

    expect(entry?.argSchema).toContain(linkOnlyRule);
    expect(compact).toContain(linkOnlyRule);
  });

  it('publishes activity:tool-log scope as a required owner/session one-of', () => {
    expect(activityToolLog.name).toBe('activity:tool-log');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'activity:tool-log');
    const schema = schemaByTool.get('activity:tool-log') as {
      anyOf?: Array<{ required?: string[] }>;
    } | undefined;

    expect(entry?.argSchema).toContain('one-of:owner|session_id');
    expect(entry?.argSchema).toContain('max_lines?:integer(5-200)');
    expect(schema?.anyOf?.some((branch) => branch.required?.includes('owner'))).toBe(true);
    expect(schema?.anyOf?.some((branch) => branch.required?.includes('session_id'))).toBe(true);
    expect(activityToolLog.args.safeParse({}).success).toBe(false);
    expect(activityToolLog.args.safeParse({ owner: 'self' }).success).toBe(true);
    expect(activityToolLog.args.safeParse({ session_id: 'session-123' }).success).toBe(true);
  });

  it('publishes the bash recovery handle requirement in full and compact discovery', () => {
    expect(bashOutput.name).toBe('capability:bash_output');
    expect(bashKill.name).toBe('capability:bash_kill');
    const { corpus, schemaByTool } = buildCorpus();

    for (const toolName of ['capability:bash_output', 'capability:bash_kill']) {
      const entry = corpus.find((candidate) => candidate.tool === toolName);
      const schema = schemaByTool.get(toolName) as { anyOf?: Array<{ required?: string[] }> } | undefined;
      const compact = compactSchemaForResult(schema) ?? '';

      expect(entry?.argSchema).toContain('one-of:bash_id|task_id');
      expect(compact).toContain('one-of:bash_id|task_id');
      expect(compact).toContain('bash_id?:string');
      expect(compact).toContain('task_id?:string');
      expect(schema?.anyOf?.some((branch) => branch.required?.includes('bash_id'))).toBe(true);
      expect(schema?.anyOf?.some((branch) => branch.required?.includes('task_id'))).toBe(true);
    }
  });

  it('EI-22449939490325270: tells callers that resubmit forbids harness', () => {
    expect(agentReview.name).toBe('improvements:agent-review');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'improvements:agent-review');
    const compact = compactSchemaForResult(schemaByTool.get('improvements:agent-review'));

    expect(entry?.argSchema).toContain('when mode=resubmit => harness forbidden');
    expect(compact).toContain('when mode=resubmit => harness forbidden');
  });

  it('keeps plans:audit auditedSha completion-only guidance in compact discovery output', () => {
    expect(plansAudit.name).toBe('plans:audit');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:audit'));

    expect(compact).toContain(
      'auditedSha?:string(7-64) Completion phase only: commit audited against; resolved from the local tree when omitted.',
    );
  });

  it('publishes plans:audit phase-dependent required fields in compact discovery output', () => {
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:audit')) ?? '';

    // P-003 (plan-verification-friction-reduction-2026-10-11): classRef is derived when omitted.
    expect(compact).toContain('phase=activation => classRef derived if omitted');
    expect(compact).toContain('phase=completion (including omitted phase) => items required');
    expect(compact).toContain('classRef');
  });

  it('publishes every plans:audit itemProvenance variant in compact discovery output', () => {
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:audit')) ?? '';

    expect(compact).toContain('kind:enum(derived|agent-added)');
    expect(compact).toContain('from?:array(1-50)<string>');
    expect(compact).toContain('reason?:string(1-2000)');
    expect(compact).toContain('constraint:itemProvenance[] (');
    expect(compact).toContain('when kind=derived => from required; when kind!=derived => from forbidden');
    expect(compact).toContain('when kind=agent-added => reason required');
    expect(compact).toContain('when kind=agent-added => note forbidden');
  });

  it('keeps the late plans:new BAR contract in compact discovery output', () => {
    expect(plansNew.name).toBe('plans:new');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('plans:new')) ?? '';

    expect(compact).toContain('Bar-to-work map for this plan');
    expect(compact).toContain('| bar | implementing plan items | evidence plane |');
    expect(compact).toContain('tree');
    expect(compact).toContain('deployed');
    expect(compact).toContain('live');
    expect(compact.length).toBeLessThanOrEqual(2_200);
  });

  it('projects root anyOf and oneOf branches with their required-key hint', () => {
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const compact = compactSchemaForResult({
        [keyword]: [
          { type: 'object', required: ['path'], properties: { path: { type: 'string' }, sha: { type: 'string' } } },
          { type: 'object', required: ['sha'], properties: { path: { type: 'string' }, sha: { type: 'string' } } },
        ],
      });

      expect(compact).toBe('one-of:path|sha; path?:string; sha?:string');
    }
  });

  it('annotates description- and metadata-declared aliases at the root and in array items', () => {
    const schema = {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'body / summary text' },
        body: { type: 'string', description: 'alias for `summary` — pass either spelling' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              canonical: { type: 'string' },
              legacy: { type: 'string', 'x-papercusp-aliases': ['canonical'] },
            },
          },
        },
      },
    };

    expect(schemaAliasAnnotation(schema)).toBe(
      'alias-group:summary|body; alias-group:items[].canonical|legacy',
    );
    const compact = compactSchemaForResult(schema);
    expect(compact).toContain('alias-group:summary|body');
    expect(compact).toContain('alias-group:items[].canonical|legacy');
  });

  it.each([
    'Not the same field as `canonical`.',
    'NOT the SAME logical field as `canonical`.',
    'This is not an equivalent field as `canonical`.',
    'Never aliased to another field; not an alias for `canonical`.',
    'No alias for `canonical`.',
    'This is not a compatibility alias of `canonical`.',
    "This isn't an alias for `canonical`.",
    'This isn’t the same field as `canonical`.',
    'These aren’t the same logical field as `canonical`.',
    'This was not an alias of `canonical`.',
    'This was never aliased for `canonical`.',
    'This wasn’t an alias of `canonical`.',
    'These weren’t the same field as `canonical`.',
    '**Not** the **same field as** `canonical`.',
  ])('does not publish negated aliases: %s', (description) => {
    const fields = {
      type: 'object',
      properties: { canonical: { type: 'string' }, separate: { type: 'string', description } },
    };
    const schema = {
      ...fields,
      properties: { ...fields.properties, items: { type: 'array', items: fields } },
    };
    expect(schemaAliasAnnotation(schema)).toBe('');
    expect(compactSchemaForResult(schema)).not.toContain('alias-group:');
  });

  it.each([
    'Alias for `canonical`.',
    'Compatibility alias of `canonical`.',
    'The same field as `canonical`.',
    'Equivalent logical field as `canonical`.',
    'Not an alias for `unrelated`; alias for `canonical`.',
    'Not the same field as `unrelated`, but the same field as `canonical`.',
  ])('retains affirmative aliases: %s', (description) => {
    const schema = {
      type: 'object',
      properties: {
        canonical: { type: 'string' },
        unrelated: { type: 'string' },
        legacy: { type: 'string', description },
      },
    };
    expect(schemaAliasAnnotation(schema)).toBe('alias-group:canonical|legacy');
    expect(compactSchemaForResult(schema)).toContain('alias-group:canonical|legacy');
  });

  it('keeps explicit alias metadata independent of a negated prose comparison', () => {
    expect(schemaAliasAnnotation({
      type: 'object',
      properties: {
        canonical: { type: 'string' },
        unrelated: { type: 'string' },
        legacy: {
          type: 'string',
          description: 'Not the same field as `unrelated`.',
          'x-papercusp-aliases': ['canonical'],
        },
      },
    })).toBe('alias-group:canonical|legacy');
  });

  it('surfaces the live work_items:create alias groups in both discovery projections', () => {
    expect(workItemsCreate.name).toBe('work_items:create');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'work_items:create');
    const compact = compactSchemaForResult(schemaByTool.get('work_items:create'));

    expect(entry?.argSchema).toContain('alias-group:summary|body');
    expect(entry?.argSchema).toContain('alias-group:items[].summary|body');
    expect(compact).toContain('alias-group:summary|body');
    expect(compact).toContain('alias-group:items[].summary|body');
  });

  it('merges every discriminated-union literal instead of advertising only the first op', () => {
    const compact = compactSchemaForResult({
      oneOf: [
        { type: 'object', required: ['op'], properties: { op: { const: 'get' }, stallReds: { type: 'integer' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'set' }, enabled: { type: 'boolean' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'hold' }, reason: { type: 'string' } } },
        { type: 'object', required: ['op'], properties: { op: { const: 'unhold' } } },
      ],
    });

    expect(compact).toContain('one-of:op;');
    expect(compact).not.toContain('one-of:op|op');
    expect(compact).toContain('op:enum(get|set|hold|unhold)');
    expect(compact).toContain('stallReds?:integer');
    expect(compact).toContain('enabled?:boolean');
    expect(compact).toContain('reason?:string');
  });

  it('keeps closed repair-queue branch conditions while retaining all CAS field shapes', () => {
    const compact = compactSchemaForResult({
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['op'],
          properties: { op: { const: 'get' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'paths'],
          properties: {
            op: { const: 'admit' },
            paths: { type: 'array', maxItems: 50, items: { type: 'string' } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'paths'],
          properties: {
            op: { const: 'converge' },
            paths: { type: 'array', maxItems: 50, items: { type: 'string' } },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['op', 'expectedCandidate', 'expectedRepairHead', 'expectedUpdatedAtMs'],
          properties: {
            op: { const: 'retire' },
            expectedCandidate: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
            expectedRepairHead: { type: 'string', pattern: '^[0-9a-fA-F]{40,64}$' },
            expectedUpdatedAtMs: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
          },
        },
      ],
    });

    expect(compact).toContain(
      'when op=retire => expectedCandidate,expectedRepairHead,expectedUpdatedAtMs required; when op!=retire => expectedCandidate,expectedRepairHead,expectedUpdatedAtMs forbidden',
    );
    expect(compact).toContain('expectedCandidate?:string~/^[0-9a-fA-F]{40,64}$/');
    expect(compact).toContain('expectedRepairHead?:string~/^[0-9a-fA-F]{40,64}$/');
    expect(compact).toContain('expectedUpdatedAtMs?:integer(0-9007199254740991)');
  });

  it('preserves explicit discriminator-dependent required and forbidden fields in compact results', () => {
    const compact = compactSchemaForResult({
      anyOf: [
        {
          required: ['kind', 'settledBy'],
          properties: { kind: { const: 'undecidable' }, settledBy: { type: 'string' } },
        },
        {
          required: ['kind'],
          properties: {
            kind: { enum: ['conclusion', 'assumption', 'convention'] },
            settledBy: { not: {} },
          },
        },
      ],
    });

    expect(compact).toContain('when kind=undecidable => settledBy required');
    expect(compact).toContain('when kind!=undecidable => settledBy forbidden');
  });

  it('keeps work_items:complete conditional change-kind fields and assumptions visible', async () => {
    expect(complete.name).toBe('work_items:complete');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'work_items:complete');
    const schema = schemaByTool.get('work_items:complete');
    const compact = compactSchemaForResult(schema);

    expect(schema).toMatchObject({ anyOf: expect.any(Array) });
    expect(entry?.argSchema).toContain('assumptions?');
    expect(compact).toContain('one-of:items');
    expect(compact).toContain('assumptions?');
    expect(compact).toContain('changeKinds?');
    expect(compact).toContain('changeKindReason?');
    expect(compact).toContain('constraint:changeKinds (A successful close uses stored `changeKinds` or this declaration');
    expect(compact).toContain('constraint:changeKindReason (First close-time declaration needs this reason');
    expect(compact).toContain('constraint:completion.kindEvidence (Multi-kind close needs one `completion.kindEvidence` entry per declared kind');
    expect(compact).toContain('constraint:items[].changeKinds (same as constraint:changeKinds)');
    expect(compact).toContain('constraint:items[].changeKindReason (same as constraint:changeKindReason)');
    expect(compact).toContain('constraint:items[].completion.kindEvidence (same as constraint:completion.kindEvidence)');
    expect(compact).toContain('contract v2; required:');
    expect(compact).toContain(
      'hypotheses differ; predictions differ meaningfully; distinguishingTest: non-empty procedure',
    );
    expect(compact).not.toContain('predictedObservations arms must be meaningfully different');
    expect(entry?.argSchema).toContain('contractVersion=2; required fields:');
    expect(entry?.argSchema).toContain('predictedObservations arms must be meaningfully different');
    expect(entry?.argSchema).toContain('hypothesis!=alternativeHypothesis');
    expect(entry?.argSchema).toContain(ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT);
    // EI-21563626901112953: the recursive verification shape is larger than
    // the nested segment budget, but its field name/type must remain visible;
    // otherwise discovery advertises only the legacy top-level coverage alias.
    // EI-21646294277891760: retain the canonical nested coverage path and its
    // residue bucket on the bounded fallback. Runtime universal-verification
    // enforcement reads completion.verification.coverage, not the legacy
    // completion.coverage sibling that follows it.
    expect(compact).toContain(
      'verification?:object{coverage?:object{population:array(≥1)<string>,checked?:array<string>,notChecked?:array<string>,notApplicable?:array<string>,residue?:array<string>}}',
    );
    expect(compact).toContain(
      'constraint:items[].completion.verification.coverage (same as constraint:completion.verification.coverage)',
    );
    // WI-37960 / EI-22611436941619072: the structural coverage fields are
    // optional in JSON Schema for ordinary completions, but the validator
    // makes them required for verification-shaped universal terminal claims.
    // Discovery must expose that conditional rule at every accepted alias.
    expect(entry?.argSchema).toContain(
      `constraint:completion.verification.coverage (${COMPLETION_COVERAGE_CALL_CONSTRAINT})`,
    );
    expect(entry?.argSchema).toContain(
      `constraint:completion.coverage (${COMPLETION_COVERAGE_CALL_CONSTRAINT})`,
    );
    const currentEvidence = /current\?:array\(≤500\)\{([^}]*)\}/.exec(compact ?? '')?.[1] ?? '';
    expect(currentEvidence).not.toBe('');
    expect(currentEvidence).toContain('planSlug?');
    expect(currentEvidence).toContain('specId?');
    expect(currentEvidence).toContain('specRevision?');
    expect(currentEvidence).toContain('specFingerprint?');
    expect(currentEvidence).toMatch(/evidenceKind:enum\([^)]*\)/);
    expect(currentEvidence).toContain('evidenceRef:string');
    expect(currentEvidence).toContain('sourceFingerprint:string');
    expect(currentEvidence).toContain('testFingerprint?:string|null(1-256)');
    expect(currentEvidence).not.toContain('fixtureFingerprint');
    expect(currentEvidence).not.toContain('rubricFingerprint');
    expect(currentEvidence).not.toContain('environmentFingerprint');
    expect(currentEvidence.length).toBeLessThanOrEqual(400);
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);

    const liveResult = await callHandler({ query: 'work_items:complete', limit: 1 });
    const liveCompact = liveResult.hits.find((hit) => hit.tool === 'work_items:complete')?.argSchema;
    expect(liveCompact).toContain('changeKinds?');
    expect(liveCompact).toContain('changeKindReason?');
    expect(liveCompact).toContain('constraint:changeKinds');
    expect(liveCompact).toContain('constraint:changeKindReason');
    expect(liveCompact).toContain('constraint:completion.kindEvidence');
    expect(liveCompact).toContain('constraint:items[].completion.kindEvidence');
    expect(liveCompact).toContain('verification?:object{coverage?:object{population:array(≥1)<string>');
  });

  it('retains canonical completion coverage when optional legacy fields grow', () => {
    const { schemaByTool } = buildCorpus();
    const schema = structuredClone(schemaByTool.get('work_items:complete')) as {
      anyOf: Array<{ properties: Record<string, unknown> }>;
    };
    const legacyFields = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
      `legacyCompletionMetadataAlias${index}`,
      { type: 'string' },
    ]));
    for (const branch of schema.anyOf) {
      branch.properties = { ...legacyFields, ...branch.properties };
    }

    const compact = compactSchemaForResult(schema);
    expect(compact).toContain('id?:string');
    expect(compact).toContain('assumptions?');
    expect(compact).toContain('validateOnly?');
    expect(compact).toContain('specAdequacy?:object{current?:array');
    expect(compact).toContain('completion?:object{rootCauseVerification?:object,verification?:object{coverage?:object{population:array(≥1)<string>');
    expect(compact).toContain('residue?:array<string>');
    expect(compact).toContain(
      'constraint:items[].completion.verification.coverage (same as constraint:completion.verification.coverage)',
    );
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('keeps the successful bug-close root-cause contract visible in bounded discovery', () => {
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('work_items:complete'));

    // A successful bug close is rejected without this conditional nested record.
    // Keep both the field and its required evidence keys visible even when
    // the surrounding completion schema exceeds the nested-field budget.
    expect(compact).toContain('rootCauseVerification?:object');
    expect(compact).toMatch(/required:\s*hypothesis\b/);
    expect(compact).toContain('alternativeHypothesis');
    expect(compact).toContain('distinguishingTest');
    expect(compact).toContain('testResult');
    for (const field of ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS) {
      expect(compact).toContain(field.split('.')[0]);
    }
    expect(compact).toContain('validateOnly?');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('publishes the validator-owned successful-close predicate and structured contrast rule on shorthand and bulk paths', async () => {
    const result = await callHandler({ query: 'work_items:complete', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'work_items:complete')?.argSchema;

    for (const path of ['completion.rootCauseVerification', 'items[].completion.rootCauseVerification']) {
      expect(compact).toContain(`constraint:${path} (`);
    }
    expect(compact).toContain(`state=${ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES.join('|')}) => required`);
    expect(compact).toContain('successful bug/capability-gap close');
    expect(compact).toContain('hypotheses differ');
    expect(compact).toContain('distinguishingTest: non-empty procedure');
    expect(compact).toContain('predictions differ meaningfully');
    expect(compact).toContain('assumptions?');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);

    const evidence = {
      contractVersion: ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION,
      hypothesis: 'the cache returns stale data',
      alternativeHypothesis: 'the writer persisted incorrect data',
      distinguishingTest: 'if H1 then fresh reads succeed; if H2 then fresh reads fail',
      testResult: 'fresh reads succeeded before the fix',
      testProcedure: 'Compare a fresh read with the persisted writer value.',
      predictedObservations: {
        hypothesis: 'the fresh read succeeds',
        alternativeHypothesis: 'the fresh read fails',
      },
      actualObservation: 'the fresh read succeeded',
      evidenceRefs: ['test:find.test.ts#completion-contract'],
    };
    expect(RootCauseVerificationSchema.safeParse(evidence).success).toBe(true);
    // Free text names the procedure; the typed predictions carry the outcomes.
    expect(RootCauseVerificationSchema.safeParse({
      ...evidence,
      distinguishingTest: 'Inspect the fresh read and compare it with the persisted writer value.',
    }).success).toBe(true);
    expect(RootCauseVerificationSchema.safeParse({
      ...evidence,
      alternativeHypothesis: evidence.hypothesis,
    }).success).toBe(false);
    const sameObservable = RootCauseVerificationSchema.safeParse({
      ...evidence,
      predictedObservations: {
        hypothesis: 'fresh reads fail',
        alternativeHypothesis: 'fresh reads fail',
      },
    });
    expect(sameObservable.success).toBe(false);
    if (!sameObservable.success) {
      expect(sameObservable.error.issues[0]?.message).toContain(ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT);
    }
    // Exact live P-008 counterexample: the procedure does not duplicate the typed predictions.
    expect(RootCauseVerificationSchema.safeParse({
      ...evidence,
      distinguishingTest:
        'Inspect the code that writes ServingTruth and the unit map, then compare its stated host semantics with both actual systemd units.',
      predictedObservations: {
        hypothesis: 'the writer claims current/staging semantics but maps the release unit',
        alternativeHypothesis: 'the writer defines production serving and exposes staging separately',
      },
    }).success).toBe(true);
  });

  it('publishes the validator-owned universal-coverage predicate on shorthand and bulk paths', async () => {
    const result = await callHandler({ query: 'work_items:complete', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'work_items:complete')?.argSchema;

    expect(compact).toContain(
      `constraint:completion.verification.coverage (${COMPLETION_COVERAGE_CALL_CONSTRAINT})`,
    );
    for (const path of [
      'completion.coverage',
      'items[].completion.verification.coverage',
      'items[].completion.coverage',
    ]) {
      expect(compact).toContain(
        `constraint:${path} (same as constraint:completion.verification.coverage)`,
      );
    }
    expect(compact).toContain('terminal state=done|resolved|passed');
    expect(compact).toContain('residue:[]');
    expect(compact).toContain('residue:[\'none\']');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('bounds a verbose nested-fields segment so nesting stays readable (EI-21490971340666010)', () => {
    const manyFields: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      manyFields[`field${i}`] = { type: 'string', description: 'x'.repeat(180) };
    }
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        observation: { type: 'object', properties: manyFields, required: ['field0'] },
        tail: { type: 'boolean' },
      },
    });

    expect(compact).toContain('tail?:boolean');
    // The nested block stays visually attachable to its parent: per-field
    // descriptions drop first, then the tail elides with an explicit marker.
    const segment = /\{(.*)\}/.exec(compact ?? '')?.[1] ?? '';
    expect(segment.length).toBeLessThanOrEqual(400);
    expect(segment).toContain('field0:string');
    expect(segment).not.toContain('xxxxxxx');
    expect(segment).toMatch(/…\+\d+$/);
  });

  it('publishes the handoff open/accept constraint from the runtime validator', async () => {
    const result = await callHandler({ query: 'coord:handoff', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'coord:handoff')?.argSchema;
    expect(compact).toContain('constraint:$ (');
    expect(compact).toContain('unless accept_msg_id is nonempty (accept takes precedence)');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
    for (const args of [{}, { to: ['reviewer'] }, { summary: 'Review' }, { to: ['reviewer'], summary: '' }]) {
      const parsed = coordHandoff.args.safeParse(args);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) expect(compact).toContain(issue.message);
      }
    }
    for (const args of [
      { accept_msg_id: 'existing-handoff' },
      { accept_msg_id: 'existing-handoff', summary: '' },
      { to: ['reviewer'], summary: 'Review P-001 and P-002', body: 'b'.repeat(16001) },
    ]) expect(coordHandoff.args.safeParse(args).success).toBe(true);
  });

  it('publishes sessions:read selector and tail constraints from the same runtime errors', async () => {
    const result = await callHandler({ query: 'sessions:read', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'sessions:read')?.argSchema;
    expect(compact).toContain('constraint:$ (');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
    for (const args of [
      {},
      { ref: 'session_turn:codex:sess:4', session: 'sess' },
      { ref: 'session_turn:codex:sess:4', around: 4 },
      { session: 'sess', tail: 2, order: 'desc' },
      { session: 'sess', tail: 2, limit: 2 },
    ]) {
      const parsed = sessionsRead.args.safeParse(args);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) expect(compact).toContain(issue.message);
      }
    }
    for (const args of [
      { session: 'sess', tail: 2 },
      { session: 'sess', order: 'desc', limit: 2 },
      { ref: 'session_turn:codex:sess:4', context: 3, tail: 2 },
      { ref: 'session_turn:codex:sess:4', text_offset: 1_500, text_limit: 1_500 },
    ]) {
      expect(sessionsRead.args.safeParse(args).success).toBe(true);
    }
    // No search-only mode/query alias or permissive unknown-key behavior.
    expect(sessionsRead.args.safeParse({ session: 'sess', mode: 'verbatim' }).success).toBe(false);
    expect(compact).not.toContain('mode?:');
  });

  it('publishes work_items:release claimHold contract from the runtime validator', async () => {
    const result = await callHandler({ query: 'work_items:release', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'work_items:release')?.argSchema;
    const missingContract = workItemsRelease.args.safeParse({ id: 'WI-1', claimHold: true });
    expect(missingContract.success).toBe(false);
    expect(compact).toContain('constraint:$ (');
    for (const issue of missingContract.success ? [] : missingContract.error.issues) {
      expect(compact).toContain(issue.message);
    }
    expect(workItemsRelease.args.safeParse({
      id: 'WI-1',
      claimHold: true,
      claimHoldRelease: { condition: 'deployment finishes', trigger: 'deploy:ready:staging' },
    }).success).toBe(true);
  });

  it('publishes conditional work_items:set_blocker requirements in tools:find', async () => {
    expect(workItemsSetBlocker.name).toBe('work_items:set_blocker');
    const result = await callHandler({ query: 'work_items:set_blocker', limit: 1 });
    const compact = result.hits.find((hit) => hit.tool === 'work_items:set_blocker')?.argSchema;
    expect(compact).toContain(
      'constraint:$ (For a single-item call that sets a blocker, pass id, kind, and ref; ref is required even though it is optional in the structural schema.',
    );
    expect(compact).toContain(
      'For items:[...], each entry that sets a blocker also requires kind and ref.',
    );
    expect(workItemsSetBlocker.args.safeParse({ id: 'WI-1', kind: 'event' }).success).toBe(false);
  });

  it('keeps nested descriptions when a block fits the budget', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        wait: {
          type: 'object',
          properties: { max_sec: { type: 'integer', description: 'seconds' } },
          required: ['max_sec'],
        },
      },
    });
    expect(compact).toBe('wait?:object{max_sec:integer seconds}');
  });

  it('publishes nested addressee-union prohibitions in the compact tools:find schema', () => {
    const schema = z.toJSONSchema(z.object({ addressee: addresseeArg }).strict());
    const compact = compactSchemaForResult(schema);

    expect(addresseeArg.safeParse({ from: 'owner-instruction' }).success).toBe(true);
    expect(addresseeArg.safeParse({ from: 'owner-instruction', source: 'campaign' }).success).toBe(false);
    expect(compact).toContain('constraint:addressee (');
    expect(compact).toContain('when from=contact => contactExternalId required');
    expect(compact).toContain('when from!=contact => contactExternalId forbidden');
    expect(compact).toContain('when from=thread-participant => source,externalId required');
    expect(compact).toContain('when from!=thread-participant => source,externalId forbidden');
  });

  it('retains required shallow fields beside a wide nested field in the bounded fallback (EI-21985077629322871)', () => {
    const wideFingerprint: Record<string, unknown> = {};
    for (let i = 0; i < 24; i += 1) wideFingerprint[`field${i}`] = { type: 'string' };

    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          properties: {
            prefix: { type: 'string' },
            current: {
              type: 'object',
              required: ['supplied'],
              properties: {
                fingerprints: { type: 'array', items: { type: 'object', properties: wideFingerprint } },
                supplied: { type: 'boolean' },
              },
            },
            tail: { type: 'boolean' },
          },
        },
      },
    });

    expect(compact).toContain('current?:object{fingerprints?:array,supplied:boolean}');
    expect(compact).toContain('tail?:boolean');
  });

  it('keeps scorecards:emit rerunRecipe.current.supplied visible at the root budget (EI-21985077629322871)', () => {
    const schema = z.toJSONSchema(scorecardEmitArgs) as { properties?: Record<string, unknown> };
    const compact = compactSchemaForResult(schema);

    expect(compact).toContain('rerunRecipe?:object{');
    expect(compact).toMatch(/rerunRecipe\?:object\{current:object\{[^}]*supplied:boolean/);
  });

});

describe('confirmed hive discovery visibility (WI-39255)', () => {
  it('removes cross_harness tools only after a concrete hive resolution', async () => {
    expect(plansSearch.name).toBe('plans:search');
    expect(crossHarnessPlansSearch.name).toBe('cross_harness:plans_search');
    const { corpus } = buildCorpus();
    expect(corpus.some((entry) => entry.tool.startsWith('cross_harness:'))).toBe(true);
    const resolveHive = vi.fn().mockResolvedValue('home-hive');

    const visible = await filterCorpusForConfirmedHiveScope(
      corpus,
      { workspaceId: 'ws-1', harnessSlug: 'member-a' },
      resolveHive,
    );

    expect(resolveHive).toHaveBeenCalledWith('ws-1', 'member-a');
    expect(visible.some((entry) => entry.tool.startsWith('cross_harness:'))).toBe(false);
    expect(visible.some((entry) => entry.tool === 'plans:search')).toBe(true);
  });

  it('fails open when the harness is standalone or hive resolution throws', async () => {
    const { corpus } = buildCorpus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        filterCorpusForConfirmedHiveScope(
          corpus,
          { workspaceId: 'ws-1', harnessSlug: 'standalone' },
          vi.fn().mockResolvedValue(null),
        ),
      ).resolves.toBe(corpus);
      await expect(
        filterCorpusForConfirmedHiveScope(
          corpus,
          { workspaceId: 'ws-1', harnessSlug: 'member-a' },
          vi.fn().mockRejectedValue(new Error('registry unavailable')),
        ),
      ).resolves.toBe(corpus);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('tools:find hive scope resolution failed: registry unavailable'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('fails open when the Hive-scope registry read exceeds its budget', async () => {
    const { corpus } = buildCorpus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(
        filterCorpusForConfirmedHiveScope(
          corpus,
          { workspaceId: 'ws-1', harnessSlug: 'member-a' },
          () => new Promise<string | null>(() => {}),
          1,
        ),
      ).resolves.toBe(corpus);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('tools:find hive scope resolution exceeded 1ms'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not resolve hive membership for an unscoped caller', async () => {
    const { corpus } = buildCorpus();
    const resolveHive = vi.fn();

    await expect(
      filterCorpusForConfirmedHiveScope(corpus, { workspaceId: 'ws-1', harnessSlug: '*' }, resolveHive),
    ).resolves.toBe(corpus);
    expect(resolveHive).not.toHaveBeenCalled();
  });

  it('ranks a callable local plan reader first after hiding the forbidden exact match', async () => {
    hiveMocks.potHomeSlugForHarness.mockResolvedValue('home-hive');

    const out = await callHandler(
      { query: 'cross_harness:plans_search', limit: 1 },
      { workspaceId: 'ws-1', harnessSlug: 'member-a' },
    );

    expect(hiveMocks.potHomeSlugForHarness).toHaveBeenCalledWith('ws-1', 'member-a');
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.tool).toBe('plans:search');
  });
});

describe('handler — graceful degrade + result shape', () => {
  it('waits for plugin-host readiness before snapshotting the projected registry', async () => {
    const toolName = 'test:tools-find-readiness';
    let releaseHost!: () => void;
    pluginHostMocks.getPluginHost.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseHost = () => {
          defineTool({
            name: toolName,
            capability: 'test:read',
            requirePrincipal: false,
            args: z.object({}),
            handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
          });
          resolve({ loaded: [] });
        };
      }),
    );

    const pending = callHandler({ query: toolName });
    await vi.waitFor(() => expect(pluginHostMocks.getPluginHost).toHaveBeenCalledOnce());
    expect(await Promise.race([pending.then(() => true), Promise.resolve(false)])).toBe(false);

    releaseHost();
    const out = await pending;
    expect(out.hits.some((hit) => hit.tool === toolName)).toBe(true);
  });

  it('returns the base catalog when plugin-host readiness never resolves', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      pluginHostMocks.getPluginHost.mockReturnValueOnce(new Promise(() => {}));
      const pending = callHandler({ query: 'find tools by intent' });

      await vi.waitFor(() => expect(pluginHostMocks.getPluginHost).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(PLUGIN_HOST_READINESS_TIMEOUT_MS);

      const out = await pending;
      expect(out.count).toBeGreaterThan(0);
      expect(out.semantic).toBe('lexical-only');
      expect(out.hits.some((hit) => hit.tool === 'tools:find')).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('tools:find plugin-host readiness exceeded'));
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('runs lexical-only when no embedder is configured, marking semantic accordingly', async () => {
    const out = await callHandler({ query: 'find tools by intent' });
    expect(out.semantic).toBe('lexical-only'); // never silently pretends semantic ran
    expect(out.registry).toEqual({
      source: 'projected-tool-registry',
      revision: expect.stringMatching(/^projected-tool-registry-v1:/),
    });
    expect(out.count).toBeGreaterThan(0);
    // every hit carries name + description + argSchema + returns + via.
    for (const h of out.hits) {
      expect(typeof h.tool).toBe('string');
      expect(h).toHaveProperty('description');
      expect(h).toHaveProperty('argSchema'); // null or a string, never missing
      expect(h).toHaveProperty('returns'); // null or a string, never missing
      expect(h).toHaveProperty('returnsSource');
      expect(h.via).toBe('lexical');
    }
    // howToCall must always name the never-fails dispatch path (tools:invoke) —
    // the exact copy varies by activation state; the invariant is the pointer.
    expect(out.howToCall).toContain('tools:invoke');
  });

  it('returns the real tool arg-schema with a hit (schemas are returnable)', async () => {
    const out = await callHandler({ query: 'tools:find' });
    const self = out.hits.find((h) => h.tool === 'tools:find');
    expect(self?.argSchema).toContain('query');
    // tools:find now declares a result schema, so discovery must expose the
    // registered structural projection rather than its authored prose clause.
    expect(self?.returns).toContain('hits?');
    expect(self?.returnsSource).toBe('registered-output-schema');
  });

  it('does not advertise loop checkpoint CAS fields on work-item checkpoints', async () => {
    expect(workItemsCheckpoint.name).toBe('work_items:checkpoint');
    const out = await callHandler({ query: 'work_items:checkpoint', limit: 1 });
    const checkpoint = out.hits.find((hit) => hit.tool === 'work_items:checkpoint');

    expect(checkpoint).toBeDefined();
    expect(checkpoint?.argSchema).toContain('contentHash?');
    expect(checkpoint?.argSchema).toContain('unchanged?');
    expect(checkpoint?.argSchema).not.toContain('expectedHash');
    expect(checkpoint?.argSchema).toContain('constraint:unchanged (');
    expect(checkpoint?.argSchema).toContain('`contentHash` required');
    expect(checkpoint?.argSchema).toContain('`checks`');
    expect(checkpoint?.argSchema).toContain('`retireIds`');
    expect(checkpoint?.argSchema).toContain('attestation_conflicting_args');
    expect(checkpoint?.argSchema).toContain('`confirmRetire` cannot authorize a row mutation');
  });

  it('surfaces the checkpoint retireIds rowsMode constraint in compact discovery', async () => {
    expect(workItemsCheckpoint.name).toBe('work_items:checkpoint');
    const out = await callHandler({ query: 'work_items:checkpoint', limit: 1 });
    const checkpoint = out.hits.find((hit) => hit.tool === 'work_items:checkpoint');

    expect(checkpoint?.argSchema).toContain('constraint:items[].retireIds');
    expect(checkpoint?.argSchema).toContain("effective `rowsMode:'replace'`");
    expect(checkpoint?.argSchema).toContain("defaults to `'merge'`");
    expect(checkpoint?.argSchema).toContain('constraint:retireIds');
  });

  it('shows the facts body storage cap in compact discovery', async () => {
    expect(factsAssert.name).toBe('facts:assert');
    const out = await callHandler({ query: 'facts:assert', limit: 1 });
    const hit = out.hits.find((candidate) => candidate.tool === 'facts:assert');
    expect(hit?.argSchema).toContain('body:string(1-4000)');
    expect(hit?.description).toContain('1200 chars are refused');
    expect(hit?.description).toContain('acceptTruncation:true');
  });

  it('keeps conditional validator rules in compact discovery beside the runtime contract', async () => {
    const factSchema = (await callHandler({ query: 'facts:assert', limit: 1 }))
      .hits.find((hit) => hit.tool === 'facts:assert')?.argSchema ?? '';
    expect(factSchema).toContain(
      "constraint:settledBy (required when kind:'undecidable'; refused for every other kind.)",
    );
    expect(factSchema).toContain(
      'constraint:ttlSec (when subjectVolatile:true or measuredAt is supplied, ttlSec>900 is clamped to 900 and disclosed as ttlClampedFrom; the ordinary ttlSec ceiling still applies.)',
    );
    expect(factsAssert.args.safeParse({
      scope: 'owner',
      key: 'schema-discovery-probe',
      body: 'probe',
      ttlSec: 60,
      kind: 'undecidable',
    }).success).toBe(false);
    expect(factsAssert.args.safeParse({
      scope: 'owner',
      key: 'schema-discovery-probe',
      body: 'probe',
      ttlSec: 60,
      kind: 'conclusion',
      settledBy: 'a probe',
    }).success).toBe(false);

    const bulkSchema = (await callHandler({ query: 'inbox:bulk-run-report', limit: 1 }))
      .hits.find((hit) => hit.tool === 'inbox:bulk-run-report')?.argSchema ?? '';
    expect(bulkSchema).toContain(
      'constraint:items[] (when outcome is skipped or failed, error must be a non-empty reason)',
    );
    expect(bulkRunReport.args.safeParse({
      items: [{ itemId: 'WI-1', outcome: 'skipped' }],
    }).success).toBe(false);
  });

  it('publishes docs:get source/heading exclusion in compact discovery', async () => {
    expect(docsGet.name).toBe('docs:get');
    expect(
      docsGet.args.safeParse({
        slugs: ['agent-spawning/observability'],
        source: true,
        heading: 'Spawn-tree feed',
      }).success,
    ).toBe(false);

    const out = await callHandler({ query: 'docs:get', limit: 1 });
    const hit = out.hits.find((candidate) => candidate.tool === 'docs:get');

    expect(hit?.argSchema).toContain(
      'constraint:$ (source and heading are mutually exclusive; source reads the entire canonical document, while heading returns a rendered section slice)',
    );
  });

  it('returns null when a matched tool has no declared response shape', async () => {
    const { corpus, returnsByTool } = buildCorpus();
    const undeclared = corpus.find((hit) => !returnsByTool.has(hit.tool));
    expect(undeclared).toBeDefined();

    const out = await callHandler({ query: undeclared!.tool });
    const hit = out.hits.find((candidate) => candidate.tool === undeclared!.tool);
    expect(hit).toBeDefined();
    expect(hit?.returns).toBeNull();
    expect(hit?.returnsSource).toBeNull();
  });

  it('preserves nested object-union branch requirements in compact arg schemas', async () => {
    expect(bindSpecEvidence.name).toBe('plans:bind-spec-evidence');
    const { schemaByTool } = buildCorpus();
    const compactSchema = compactSchemaForResult(
      schemaByTool.get('plans:bind-spec-evidence'),
      { includeNestedDescriptions: false },
    ) ?? '';
    const rawBindSchema = schemaByTool.get('plans:bind-spec-evidence');
    const bindRoot = rawBindSchema && typeof rawBindSchema === 'object'
      ? rawBindSchema as Record<string, unknown>
      : {};
    const branchKeys = (key: 'anyOf' | 'oneOf' | 'allOf') => Array.isArray(bindRoot[key])
      ? (bindRoot[key] as unknown[]).map((branch) =>
        branch && typeof branch === 'object' ? Object.keys(branch) : typeof branch)
      : undefined;
    const rootSummary = {
      keys: Object.keys(bindRoot),
      type: bindRoot.type,
      properties: bindRoot.properties && typeof bindRoot.properties === 'object'
        ? Object.keys(bindRoot.properties)
        : undefined,
      anyOf: branchKeys('anyOf'),
      oneOf: branchKeys('oneOf'),
      allOf: branchKeys('allOf'),
    };
    expect(compactSchema, `schemaByTool root shape: ${JSON.stringify(rootSummary)}`).toContain(
      'binding?:object(one-of:workItemId&fromTestRun|workItemId&evidenceKind&evidenceRef)',
    );

    const out = await callHandler({ query: 'plans:bind-spec-evidence', limit: 1 });
    const schema = out.hits.find((hit) => hit.tool === 'plans:bind-spec-evidence')?.argSchema ?? '';

    expect(schema).toContain(
      'binding?:object(one-of:workItemId&fromTestRun|workItemId&evidenceKind&evidenceRef)',
    );
  });

  it('publishes canonicalTestPath source limits for plans:bind-spec-evidence', async () => {
    const out = await callHandler({ query: 'plans:bind-spec-evidence', limit: 1 });
    const description = out.hits.find((hit) => hit.tool === 'plans:bind-spec-evidence')?.description ?? '';

    expect(description).toContain("canonicalTestPath only for cargo's defining .rs");
    expect(description).toContain('or unavailable copy-out mirror');
    expect(description).toContain('never ordinary local/Playwright rows');
  });

  it('publishes all loop:arm monitor-authority branch requirements in discovery', async () => {
    expect(loopArm.name).toBe('loop:arm');
    const out = await callHandler({ query: 'loop:arm', limit: 1 });
    const schema = out.hits.find((hit) => hit.tool === 'loop:arm')?.argSchema ?? '';

    expect(schema).toContain('when kind=owner-turn => turnRef,quote required');
    expect(schema).toContain('when kind!=owner-turn => turnRef,quote forbidden');
  });

  it('keeps recipes:run authority alternatives visible in compact discovery', async () => {
    expect(recipesRun.name).toBe('recipes:run');
    const { schemaByTool } = buildCorpus();
    const schema = compactSchemaForResult(schemaByTool.get('recipes:run')) ?? '';

    expect(schema).toContain(
      'authority?:object(one-of:version&revision&context|version&revision&refs&requiresContext&runnable)',
    );
  });

  it('honors an explicit full payload tier when the complete schema fits the result budget', async () => {
    expect(docsGet.name).toBe('docs:get');
    const compact = await callHandler({ query: 'docs:get', limit: 1 });
    const full = await callHandler(
      { query: 'docs:get', limit: 1 },
      { payloadTierOverride: 'full' },
    );
    const compactSchema = compact.hits[0]?.argSchema ?? '';
    const fullSchema = full.hits[0]?.argSchema ?? '';

    expect(compact.hits[0]?.tool).toBe('docs:get');
    expect(full.hits[0]?.tool).toBe('docs:get');
    expect(fullSchema).not.toContain('…+');
    expect(fullSchema).not.toBe(compactSchema);
    expect(() => JSON.parse(fullSchema)).not.toThrow();
    expect(fullSchema).toContain('"slugs"');
  });

  it('keeps a projected discovery schema compact instead of expanding the implicit full source', async () => {
    const args = { query: 'work_items:checkpoint', limit: 1 };
    const projection = { pick: ['hits[].argSchema'] };
    const materialized = nestedProjectionContext({ contextTier: 'trimmed' } as never, args, projection);
    expect(materialized.sourceMaterialization?.promotedToFull).toBe(true);
    const ordinary = await callHandler(args);
    const projected = await callHandler(args, { ...materialized });
    expect(projected.hits[0]?.argSchema).toBe(ordinary.hits[0]?.argSchema);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(DISCOVERY_RESULT_MAX_BYTES);
  });

  it('retains explicitly requested full schemas even when the caller also picks fields', async () => {
    const args = { query: 'work_items:checkpoint', limit: 1, payloadTier: 'full' };
    const materialized = nestedProjectionContext(
      { contextTier: 'trimmed', payloadTierOverride: 'full' } as never,
      args,
      { pick: ['hits[].argSchema'] },
    );
    expect(materialized.sourceMaterialization?.promotedToFull).toBe(false);
    const out = await callHandler(args, { ...materialized });
    expect(() => JSON.parse(out.hits[0]?.argSchema ?? '')).not.toThrow();
    expect(out.hits[0]?.argSchema).toContain('"properties"');
  });

  it('returns a full schema when an explicit full payload tier exceeds the inline result budget', async () => {
    expect(bindSpecEvidence.name).toBe('plans:bind-spec-evidence');
    const { schemaByTool } = buildCorpus();
    const bindSpecSchema = schemaByTool.get('plans:bind-spec-evidence');
    expect(bindSpecSchema).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(bindSpecSchema), 'utf8')).toBeGreaterThan(DISCOVERY_RESULT_MAX_BYTES);

    const out = await callHandler(
      { query: 'plans:bind-spec-evidence', limit: 1 },
      { payloadTierOverride: 'full' },
    );
    const hit = out.hits.find((candidate) => candidate.tool === 'plans:bind-spec-evidence');

    expect(hit).toBeDefined();
    expect(hit?.argSchema).toBe(JSON.stringify(bindSpecSchema));
    expect(() => JSON.parse(hit?.argSchema ?? '')).not.toThrow();
    expect(out).toHaveProperty('truncated', false);
    expect(out.howToCall).not.toContain('Full argument schemas exceeded the response budget');
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeGreaterThan(DISCOVERY_RESULT_MAX_BYTES);
  });
});

describe('bounded discovery projection (EI-20235784774977954)', () => {
  it('keeps nested object fields visible without copying verbose descriptions', () => {
    const schema = {
      type: 'object',
      properties: {
        body: {
          anyOf: [
            { type: 'string' },
            {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  premises: {
                    anyOf: [
                      { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                  youMayNotKnow: {
                    anyOf: [
                      {
                        type: 'array',
                        maxItems: 20,
                        items: {
                          type: 'object',
                          properties: {
                            ref: { type: 'string' },
                            provenance: { type: 'string', enum: ['computed', 'authored'] },
                          },
                          required: ['ref', 'provenance'],
                        },
                      },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                  couldNotDetermine: {
                    anyOf: [
                      {
                        type: 'array',
                        maxItems: 20,
                        items: {
                          type: 'object',
                          properties: { what: { type: 'string' }, note: { type: 'string' } },
                          required: ['what'],
                        },
                      },
                      { type: 'string' },
                      { type: 'array', items: {} },
                    ],
                  },
                },
                required: ['text'],
              },
            },
          ],
        },
        expects: { type: 'string', enum: ['ack', 'answer', 'action', 'none'] },
      },
    };

    const compact = compactSchemaForResult(schema);
    expect(compact).toContain(
      'body?:array(1-20){text:string,premises?:array(≤20)<string>,youMayNotKnow?:array(≤20){ref:string,provenance:enum(computed|authored)},couldNotDetermine?:array(≤20){what:string,note?:string}}',
    );
    expect(compact).toContain('expects?:enum(ack|answer|action|none)');
    expect(compact).not.toContain('body?:string|');
    expect(compact).not.toContain('premises?:array|string');
    expect(compact).not.toContain('youMayNotKnow?:array|string');
    expect(compact).not.toContain('couldNotDetermine?:array|string');
    expect(compact).not.toContain('description');
  });

  it('merges every nested structured-check branch in rubrics:propose discovery (EI-22803598097461225)', async () => {
    expect(rubricsPropose.name).toBe('rubrics:propose');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('rubrics:propose')) ?? '';
    // `check` is a nested discriminated union. The compact response must retain
    // every callable input even when growing optional metadata forces a shallow
    // fallback; enum/bounds remain on the full schema and conditional synopsis.
    const assertCheckInputs = (schema: string) => {
      const fields = schema.match(/check\?:object\{([^}]+)\}/)?.[1] ?? '';
      expect(fields).toContain('kind:enum(tests|cargo|instrument|probe|coverage|requirements)');
      for (const key of ['files', 'manifestPath', 'sourceFiles', 'test', 'instrumentKey', 'probe', 'all', 'scope', 'floor', 'expect']) {
        expect(fields, `missing callable check input ${key}`).toMatch(new RegExp(`(?:^|,)${key}\\?(?::|,|$)`));
      }
    };
    assertCheckInputs(compact);
    expect(compact).not.toContain('check?:object{kind:enum(tests),');

    const result = await callHandler({ query: 'rubrics:propose', limit: 1 });
    assertCheckInputs(result.hits.find((hit) => hit.tool === 'rubrics:propose')?.argSchema ?? '');
  });

  it('EI-21579794371308546: live coord:send discovery identifies premises as string refs', () => {
    expect(coordSend.name).toBe('coord:send');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('coord:send'));

    expect(compact).toContain('premises?:array(≤20)<string>');
    expect(compact).toContain('forYouBecause?:object{relation');
    expect(compact).not.toContain('premises?:array(≤20){');
  });

  it('keeps the joined-body chunk limit in returned coord:send discovery, with validator parity', async () => {
    const result = await callHandler({ query: 'coord:send', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'coord:send');
    expect(hit).toBeDefined();
    const rule = `body text joined with "\\n\\n" must fit ${COORD_SEND_MAX_CHUNK_PARTS} parts of <=${DEFAULT_INBOX_BODY_CAP} characters`;
    expect(hit!.argSchema).toContain(`constraint:body (${rule})`);
    expect(hit!.argSchema).toContain('constraint:items[].body (same as constraint:body)');
    expect(hit!.argSchema!.length).toBeLessThanOrEqual(2200);

    // RSR-P-008-B boundary: sections that each fill one part exactly. N of them
    // take exactly N parts, so the documented limit parses and one more section
    // is refused — for every expects, on both axes.
    const fullPart = 'x'.repeat(chunkContentBudget());
    for (const bulk of [false, true]) {
      for (const expects of ['ack', 'answer', 'action', 'none']) {
        for (const excess of [0, 1]) {
          const message = {
            to: ['bee-1'],
            summary: 'cap parity',
            expects,
            body: Array.from({ length: COORD_SEND_MAX_CHUNK_PARTS + excess }, (_, i) =>
              i === 0 ? { text: fullPart, forYouBecause: { relation: 'owns' } } : { text: fullPart },
            ),
          };
          const parsed = coordSend.args.safeParse(bulk ? { items: [message] } : message);
          expect(parsed.success, JSON.stringify({ bulk, expects, excess })).toBe(excess === 0);
          if (!parsed.success) {
            expect(parsed.error.issues.some((issue) =>
              issue.message.includes(`at most ${COORD_SEND_MAX_CHUNK_PARTS} parts`),
            )).toBe(true);
          }
        }
      }
    }
  });

  it('EI-22692063823365372: returned coord:send discovery keeps knowledge and uncertainty fields independent', async () => {
    const { corpus, schemaByTool } = buildCorpus();
    const result = await callHandler({ query: 'coord:send', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'coord:send');
    expect(hit).toBeDefined();
    const falseAlias = /alias-group:[^;]*(?:youMayNotKnow|couldNotDetermine)/;
    for (const text of [
      schemaAliasAnnotation(schemaByTool.get('coord:send')),
      corpus.find((entry) => entry.tool === 'coord:send')!.argSchema,
      compactSchemaForResult(schemaByTool.get('coord:send')),
      hit!.argSchema,
    ]) {
      expect(text).not.toMatch(falseAlias);
    }

    // Both fields may coexist. Their own strict entry shapes still govern
    // acceptance, for shorthand and bulk sends; discovery changes no validator.
    const section = {
      text: 'Independent fields',
      youMayNotKnow: [{ ref: 'WI-1234', provenance: 'authored' }],
      couldNotDetermine: [{ what: 'whether the candidate carries the fix' }],
    };
    for (const bulk of [false, true]) {
      const message = { to: ['bee-1'], summary: 'field parity', expects: 'none', body: [section] };
      expect(coordSend.args.safeParse(bulk ? { items: [message] } : message).success).toBe(true);
      const swapped = {
        ...message,
        body: [{
          ...section,
          youMayNotKnow: section.couldNotDetermine,
          couldNotDetermine: section.youMayNotKnow,
        }],
      };
      expect(coordSend.args.safeParse(bulk ? { items: [swapped] } : swapped).success).toBe(false);
    }
  });

  it('preserves nested constraint paths and deduplicates union annotations under description pressure', () => {
    const body = { type: 'string', 'x-papercusp-call-constraint': 'mode=ask => length<=42' };
    const schema = {
      type: 'object',
      properties: {
        body: { anyOf: [body, body] },
        items: { type: 'array', items: { type: 'object', properties: { body } } },
        ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
          `detail${i}`, { type: 'string', description: 'optional prose '.repeat(50) },
        ])),
      },
    };
    const compact = compactSchemaForResult(schema)!;
    expect(compact.match(/constraint:body /g)).toHaveLength(1);
    expect(compact).toContain('constraint:items[].body (mode=ask => length<=42)');
    expect(compact.length).toBeLessThanOrEqual(2200);
    expect(compactSchemaForResult({ type: 'object', properties: { ordinary: { type: 'string' } } }))
      .toBe('ordinary?:string');
  });

  it('keeps ordinary unions intact when they are not teaching-only array branches', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['yes', 'no'] }] },
      },
    });

    expect(compact).toContain('value?:boolean|enum(yes|no)');
  });

  it('renders an array item pattern in the compact result', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        refs: { type: 'array', items: { type: 'string', pattern: '^P-\\d{3,}$' } },
      },
    });

    expect(compact).toBe('refs?:array<string~/^P-\\d{3,}$/>');
  });

  it('renders a property pattern in the compact result', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        published_sha: { type: 'string', pattern: '^[0-9a-f]{40,64}$' },
      },
    });

    expect(compact).toBe('published_sha?:string~/^[0-9a-f]{40,64}$/');
  });

  it('preserves exclusive bounds in the compact result (events:await timeout_sec)', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        timeout_sec: { type: 'integer', exclusiveMinimum: 0, maximum: 604800 },
      },
    });

    expect(compact).toBe('timeout_sec?:integer(>0-604800)');
  });

  it('exposes the live events:await exclusive lower bound through the discovery corpus', () => {
    expect(eventsAwait.name).toBe('events:await');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'events:await');
    const compact = compactSchemaForResult(schemaByTool.get('events:await'));

    expect(entry?.argSchema).toContain('timeout_sec?:integer');
    expect(compact).toContain('timeout_sec?:integer(>0-604800)');
  });

  it('preserves callable branch bounds when another union branch forbids the field', () => {
    expect(capabilityRead.name).toBe('capability:read');
    const { corpus, schemaByTool } = buildCorpus();
    const entry = corpus.find((candidate) => candidate.tool === 'capability:read');
    const compact = compactSchemaForResult(schemaByTool.get('capability:read'));

    // The line/content/evidence branches explicitly forbid byte_limit, while
    // the byte-window branch accepts it as an integer capped at 4096. Both
    // discovery surfaces must teach the callable branch's actual ceiling.
    expect(entry?.argSchema).toContain('byte_limit?:integer(>0-4096)');
    expect(compact).toContain('byte_limit?:integer(>0-4096)');
  });

  it('keeps the required progress_lease remedy visible in bounded events:await discovery', () => {
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('events:await'));

    // progress_lease has optional fields before its required remedy. The
    // bounded nested projection must not hide the only field that tells a
    // caller how to recover after repeated cadence misses.
    expect(compact).toContain('progress_lease?:object{');
    expect(compact).toContain(
      'remedy:object{kind:enum(spec-widen|outside-lane-placement|leader-claim|create-unblock-item)',
    );
    expect(compact).toContain('instructions?:string(1-2000)');
    expect(compact?.length ?? 0).toBeLessThanOrEqual(2_200);
  });

  it('preserves every required testing:run recovery key in compact discovery', async () => {
    const { corpus, schemaByTool } = buildCorpus();
    const schema = schemaByTool.get('testing:run') as
      | { properties?: Record<string, { required?: string[] }> }
      | undefined;
    const recoverySchema = schema?.properties?.recoverEvidence;
    const compact = compactSchemaForResult(schema) ?? '';
    const recoveryStart = compact.indexOf('recoverEvidence?:object{');
    const recovery = recoveryStart < 0 ? '' : compact.slice(recoveryStart, recoveryStart + 320);

    // The registry boundary must hand compaction the validator's required-key
    // contract unchanged; otherwise the renderer cannot distinguish a required
    // key from optional metadata when it has to shorten a nested object.
    expect(recoverySchema?.required).toEqual(expect.arrayContaining(['workItemId', 'originRunId', 'runId']));

    // originRunId is required by the recovery validator. Hiding it behind a
    // tail marker makes a schema-following caller fail only after dispatch.
    expect(recovery).toContain('originRunId:string');
    expect(recovery).toContain('runId:string');
    expect(recovery).toContain('workItemId:string');

    const corpusHit = corpus.find((candidate) => candidate.tool === 'testing:run');
    expect(corpusHit?.argSchema).toContain('originRunId');
    expect(corpusHit?.argSchema).toContain('workItemId');

    // Exercise the public response path as well as the pure projection helper:
    // the compact returned schema must retain each required key with its type.
    const out = await callHandler({ query: 'testing:run', limit: 1 });
    const hit = out.hits.find((candidate) => candidate.tool === 'testing:run');
    expect(hit?.argSchema).toContain('originRunId:string');
    expect(hit?.argSchema).toContain('runId:string');
    expect(hit?.argSchema).toContain('workItemId:string');
  });

  it('preserves record entry fields in the live scorecards:evaluate discovery schema', async () => {
    expect(scorecardEvaluate.name).toBe('scorecards:evaluate');
    const { schemaByTool } = buildCorpus();
    const compact = compactSchemaForResult(schemaByTool.get('scorecards:evaluate')) ?? '';

    // instrumentSnapshots is a z.record(...), so the callable value is a map
    // whose every entry has the typed snapshot contract. A bare object here
    // sends callers back to runtime validation to discover verdict/measuredAt.
    expect(compact).toContain('instrumentSnapshots?:object{*:object{');
    expect(compact).toContain('verdict:enum(pass|fail|unknown)');
    expect(compact).toContain('measuredAt:string');
    expect(compact).toContain('window?:object');
    expect(compact).toContain('evidenceRef?:string');
    expect(compact.length).toBeLessThanOrEqual(2_200);

    const result = await callHandler({ query: 'scorecards:evaluate', limit: 1 });
    const hit = result.hits.find((entry) => entry.tool === 'scorecards:evaluate');
    expect(hit?.argSchema).toContain('instrumentSnapshots?:object{*:object{');
  });

  it('renders a JSON-schema const as a singleton enum in nested discovery output', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        producer_health: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'green-checkpoint' },
          },
          required: ['kind'],
        },
      },
    });

    expect(compact).toBe('producer_health?:object{kind:enum(green-checkpoint)}');
  });

  it('preserves a bounded nested semantic description when structure cannot express the constraint (EI-21211778836360588)', () => {
    const compact = compactSchemaForResult({
      type: 'object',
      properties: {
        producer_health: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'green-checkpoint' },
            pipeline: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              description:
                'Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
            },
          },
          required: ['kind'],
        },
      },
    });

    const rendered = compact ?? '';
    expect(rendered).toContain(
      'pipeline?:string(1-64) Sanitized basename of the integration root that emits the event (for example "papercusp" in release:green:papercusp), not the routine name "green-checkpoint".',
    );
    expect(rendered.length).toBeLessThanOrEqual(2_200);
  });

  it('returns valid bounded JSON and marks omitted hits', () => {
    const base = {
      query: 'a verbose discovery query',
      semantic: 'on',
      activated: false,
      howToCall: 'tools:invoke {name, args}',
      totalMatches: 8,
    };
    const hits = Array.from({ length: 8 }, (_, i) => ({
      tool: `tool:${i}`,
      description: 'd'.repeat(320),
      argSchema: 'field?:object' + 'x'.repeat(2_180),
      returns: null,
      via: 'lexical',
    }));
    const exactNames = hits.slice(0, 3).map((hit) => hit.tool);
    const bounded = boundDiscoveryHits(base, hits, exactNames);
    const payload = {
      ...base,
      count: bounded.hits.length,
      truncated: bounded.truncated,
      hits: bounded.hits,
      ...(bounded.omittedTools.length > 0 ? { omittedTools: bounded.omittedTools } : {}),
    };

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(DISCOVERY_RESULT_MAX_BYTES);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(bounded.truncated).toBe(true);
    expect(bounded.hits.length).toBeLessThan(hits.length);
    expect(bounded.omittedTools).toEqual(exactNames.filter((name) => !bounded.hits.some((hit) => hit.tool === name)));
    expect(bounded.omittedTools.length).toBeGreaterThan(0);
  });

  it('does not return a single hit that exceeds the discovery result budget', () => {
    const base = {
      query: 'tool:large',
      semantic: 'on',
      activated: false,
      howToCall: 'tools:invoke {name, args}',
      totalMatches: 1,
    };
    const hits = [{
      tool: 'tool:large',
      description: 'd'.repeat(320),
      argSchema: 'field?:object' + 'x'.repeat(DISCOVERY_RESULT_MAX_BYTES),
      returns: null,
      via: 'lexical',
    }];

    const bounded = boundDiscoveryHits(base, hits);
    const payload = { ...base, count: bounded.hits.length, truncated: bounded.truncated, hits: bounded.hits };

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(DISCOVERY_RESULT_MAX_BYTES);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    expect(bounded.hits).toEqual([]);
    expect(bounded.truncated).toBe(true);
  });

  it('keeps complete compact-schema clauses when one hit needs byte-budget trimming', () => {
    const base = {
      query: 'tool:large',
      semantic: 'on',
      activated: false,
      howToCall: 'tools:invoke {name, args}',
      totalMatches: 1,
    };
    const hits = [{
      tool: 'tool:large',
      description: 'optional description',
      argSchema: `first?:string; binding?:object(one-of:workItemId&evidenceRef|workItemId&testRunId); oversized?:string(${ 'x'.repeat(DISCOVERY_RESULT_MAX_BYTES) })`,
      returns: 'optional result description',
      returnsSource: 'authored-tool-guidance' as const,
      via: 'lexical',
    }];

    const bounded = boundDiscoveryHits(base, hits);
    const payload = { ...base, count: bounded.hits.length, truncated: bounded.truncated, hits: bounded.hits };
    const schema = bounded.hits[0]?.argSchema ?? '';

    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(DISCOVERY_RESULT_MAX_BYTES);
    expect(schema).toContain('binding?:object(one-of:workItemId&evidenceRef|workItemId&testRunId)');
    expect(schema).not.toContain('oversized?:string');
    expect(schema).toMatch(/; …$/);
    expect(bounded.truncated).toBe(true);
  });
});

describe('handler — dynamic activation (dynamic-tool-surface-2026-07-01)', () => {
  it('does not advertise unknown exact names as omitted callable tools', async () => {
    const corpus = [
      { tool: 'routines:list' },
      { tool: 'tools:find' },
    ];
    expect(exactToolNamesInCorpus(['routines:statvfs', 'routines:list'], corpus)).toEqual(['routines:list']);

    const out = await callHandler({ query: 'routines:statvfs tools:find', limit: 8 });
    expect(out.hits.some((hit) => hit.tool === 'tools:find')).toBe(true);
    expect(out.omittedTools ?? []).not.toContain('routines:statvfs');
  });

  it('prioritizes explicitly named tools and identifies requested names omitted by the result budget', async () => {
    const requested = [
      'work_items:link',
      'work_items:checkpoint',
      'coord:send',
      'events:status',
      'scheduler:get_next',
    ];
    const query = requested.join(', ');
    expect(exactToolNamesInQuery(query)).toEqual(requested);

    const out = await callHandler({ query, limit: 8 });
    const returned = out.hits.map((hit) => hit.tool).filter((name) => requested.includes(name));
    const returnedInRequestOrder = requested.filter((name) => returned.includes(name));
    const lastExactIndex = out.hits.reduce((last, hit, index) => requested.includes(hit.tool) ? index : last, -1);
    const firstOtherIndex = out.hits.findIndex((hit) => !requested.includes(hit.tool));

    expect(returned).toEqual(returnedInRequestOrder);
    expect(firstOtherIndex < 0 || lastExactIndex < firstOtherIndex).toBe(true);
    expect(out.omittedTools ?? []).toEqual(requested.filter((name) => !returned.includes(name)));
    expect(out.truncated).toBe(true);
    if (out.omittedTools?.length) {
      expect(out.howToCall).toContain('omittedTools');
    }
  });

  it('fills explicit tool-name matches that generic relevance ranking left out', async () => {
    const names = [
      'work_items:link',
      'work_items:set_state',
      'coord:send',
      'events:status',
      'scheduler:get_next',
      'work_items:claim_next',
    ];
    const corpus = names.map((tool) => ({
      tool,
      status: 'available' as const,
      category: tool.split(':')[0],
      description: `description for ${tool}`,
      argSchema: 'id:string',
      capability: 'test:read',
      provider: { kind: 'builtin' as const, name: 'test' },
    }));
    const query = names.slice(0, 5).join(', ');
    const requested = exactToolNamesInQuery(query);
    const ranked = await findTools(corpus, query, { limit: 2 });
    const selected = prioritizeExactToolHits(ranked, corpus, requested, 8);

    expect(requested).toEqual(names.slice(0, 5));
    expect(ranked).toHaveLength(2);
    expect(ranked.some((hit) => hit.tool === 'work_items:link')).toBe(false);
    expect(selected.slice(0, requested.length).map((hit) => hit.tool)).toEqual(requested);
  });

  it('activates the matched tools for the session + reports activated:true', async () => {
    const activated: string[][] = [];
    const ctx = {
      activateTools: (names: readonly string[]) => {
        activated.push([...names]);
        return true;
      },
    };
    const res = await (toolFind as unknown as ToolDef).handler({ query: 'find tools by intent' }, ctx);
    const out = JSON.parse(res.content[0].text) as {
      activated: boolean;
      hits: Array<{ tool: string }>;
      howToCall: string;
    };
    // activateTools was called exactly once, with EVERY hit's tool name.
    expect(activated).toHaveLength(1);
    expect(activated[0]).toEqual(out.hits.map((h) => h.tool));
    expect(out.activated).toBe(true);
    const description = (toolFind as unknown as { description: string }).description;
    expect(description).toContain('client may need a tool-list refresh');
    expect(description).toContain('follow `howToCall`');
    expect(description).toContain('use tools:invoke when a wrapper is absent');
    expect(description).not.toContain('are directly callable');
    // EI-20224177038218883: server activation cannot prove the client consumed
    // list_changed and materialized a same-turn wrapper. Lead with the one path
    // that is immediately callable on every client.
    expect(out.howToCall).toContain('tools:invoke');
    expect(out.howToCall).toContain('tool-list refresh');
    expect(out.howToCall).not.toContain('call the one you want directly');
  });

  it('does not recommend dispatching a tools:invoke hit through itself', async () => {
    const activated = await callHandler({ query: 'tools:invoke' }, { activateTools: () => true });
    const inactive = await callHandler({ query: 'tools:invoke' });

    for (const out of [activated, inactive]) {
      expect(out.hits.some((hit) => hit.tool === 'tools:invoke')).toBe(true);
      expect(out.howToCall).toContain('Use tools:invoke directly for a different target');
      expect(out.howToCall).toContain('do not route tools:invoke through itself');
      expect(out.howToCall).not.toContain('name:"<exact tool name from hits>"');
    }
  });

  it('never breaks discovery when activation throws — hits still returned', async () => {
    const ctx = {
      activateTools: () => {
        throw new Error('surface exploded');
      },
    };
    const res = await (toolFind as unknown as ToolDef).handler({ query: 'feature flag' }, ctx);
    const out = JSON.parse(res.content[0].text) as { activated: boolean; count: number };
    expect(out.activated).toBe(false); // swallowed
    expect(out.count).toBeGreaterThan(0); // discovery unaffected
  });
});

describe('warmToolFindIndex (boot warm)', () => {
  it('resolves without throwing when no embedder is configured (no-op warm)', async () => {
    await expect(warmToolFindIndex()).resolves.toBeUndefined();
  });
});
