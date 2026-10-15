import { describe, expect, it } from 'vitest';
import { gradeSites } from './code-intel-bench';
import {
  cbmProjectName, createCodebaseMemoryArm, parseSearchCode, parseSearchGraph, parseTrace, unwrapCbmEnvelope, withDaemonPeak,
} from './engine-comparison-cbm';
import type { ExecOptions, ExecResult } from './engine-comparison-arms';
import { SELECTIVE_ACCEPTANCE_CORPUS } from './selective-corpus';

// Shapes below are copied from REAL `codebase-memory-mcp cli --json` output (2026-10-01).
const SPEC_QN = 'proj.packages.operator-core.lib.agent-tools.plans.spec-evidence-store';
const DESIGN_QN = 'proj.packages.operator-core.lib.design-compare.acceptance';
const env = (payload: unknown, isError = false): string =>
  JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, ...(isError ? { isError: true } : {}) });

const TRACE_IN = {
  function: 'measureRepoFilesEvidenceAtRoot', direction: 'inbound', callers_total: 3,
  callers: {
    cols: ['name', 'hop'],
    groups: [
      { qn_prefix: SPEC_QN, rows: [['measureRepoFilesEvidence', 1], ['listSpecEvidence', 1]] },
      { qn_prefix: DESIGN_QN, rows: [['measureDesignAcceptance', 1]] },
    ],
  },
};
const GRAPH_DECLS = {
  cols: ['name', 'label', 'lines', 'in', 'out'],
  groups: [
    { qn_prefix: SPEC_QN, file: 'packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts', rows: [['measureRepoFilesEvidence', 'Function', '123-140', 1, 2], ['listSpecEvidence', 'Function', '902-1100', 4, 9]] },
    { qn_prefix: DESIGN_QN, file: 'packages/operator-core/lib/design-compare/acceptance.ts', rows: [['measureDesignAcceptance', 'Function', '120-190', 2, 5]] },
    // Same name, DIFFERENT module: must be joined out by qn_prefix, never matched on name alone.
    { qn_prefix: 'proj.packages.operator-core.lib.unrelated.shadow', file: 'packages/operator-core/lib/unrelated/shadow.ts', rows: [['listSpecEvidence', 'Function', '7-9', 0, 0]] },
  ],
};
const SEARCH_CODE = {
  cols: ['qn', 'label', 'file', 'lines', 'matches', 'matches_omitted', 'in', 'out'],
  rows: [
    ['proj.scripts.publish', 'Function', 'scripts/publish-official-blueprints.mts', '204-245', [217], 0, 1, 3],
    ['proj.route', 'Module', 'packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts', '1-183', [2], 0, 0, 1],
  ],
  raw_matches: { cols: ['file', 'line', 'content'], rows: [['scripts/publish-official-blueprints.mts', 217, 'x']] },
};

const byId = (id: string) => SELECTIVE_ACCEPTANCE_CORPUS.find((c) => c.id === id)!;
const ok = (stdout: string, extra: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout, stderr: '', wallMs: 5, peakRssKb: 100, ...extra });

function fakeExec(handlers: Record<string, (args: readonly string[]) => ExecResult>) {
  const calls: Array<{ tool: string; args: readonly string[]; env: ExecOptions['env'] }> = [];
  const exec = async (_cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecResult> => {
    const tool = args[2]!; // ['cli', '--json', <tool>, ...]
    calls.push({ tool, args, env: opts.env });
    const h = handlers[tool];
    return h ? h(args) : { code: 1, stdout: '', stderr: `no handler ${tool}`, wallMs: 1, peakRssKb: null };
  };
  return { exec, calls };
}

const cfg = { id: 'codebase-memory', version: 'pin', bin: '/bin/cbm', treeRoot: '/a/b/tree', home: '/h', cacheDir: '/h/cache', sampleMs: 5 };
const deps = { loadAvg1: () => 1 };
const arm = (handlers: Record<string, (args: readonly string[]) => ExecResult>) => {
  const f = fakeExec(handlers);
  return { f, arm: createCodebaseMemoryArm(cfg, deps, f.exec, async () => 0) };
};

describe('CBM envelope + parsers (shapes from real CLI output)', () => {
  it('derives the project key the engine uses', () => {
    expect(cbmProjectName('/home/u/.papercusp/bench/x/arms/cbm/tree')).toBe('home-u-.papercusp-bench-x-arms-cbm-tree');
  });

  it('unwraps structuredContent, falls back to the text JSON, and flags garbage', () => {
    expect(unwrapCbmEnvelope(env({ a: 1 })).payload).toEqual({ a: 1 });
    const textOnly = JSON.stringify({ content: [{ type: 'text', text: '{"b":2}' }] });
    expect(unwrapCbmEnvelope(textOnly).payload).toEqual({ b: 2 });
    expect(unwrapCbmEnvelope('not json').isError).toBe(true);
    expect(unwrapCbmEnvelope(env({ error: 'x' }, true)).isError).toBe(true);
  });

  it('parses declarations with the START of the line range', () => {
    const d = parseSearchGraph(GRAPH_DECLS);
    expect(d.map((x) => `${x.path}:${x.line1}`)).toContain('packages/operator-core/lib/agent-tools/plans/spec-evidence-store.ts:902');
    expect(d.find((x) => x.name === 'measureDesignAcceptance')?.kind).toBe('Function');
    expect(parseSearchGraph(null)).toEqual([]);
  });

  it('parses trace sides and de-duplicates (qn_prefix, name)', () => {
    expect(parseTrace(TRACE_IN, 'inbound')).toHaveLength(3);
    expect(parseTrace(TRACE_IN, 'outbound')).toEqual([]);
    const dup = { callees: { groups: [{ qn_prefix: 'q', rows: [['f', 1], ['f', 2]] }] } };
    expect(parseTrace(dup, 'outbound')).toEqual([{ qnPrefix: 'q', name: 'f' }]);
  });

  it('parses search_code compact + raw matches without duplicating a line', () => {
    const s = parseSearchCode(SEARCH_CODE).map((x) => `${x.path}:${x.line1}`);
    expect(s).toEqual(['scripts/publish-official-blueprints.mts:217', 'packages/operator-core/lib/endpoint-route/routes/cupboard-publish-blueprint.ts:2']);
  });
});

describe('createCodebaseMemoryArm', () => {
  it('callers: trace_path then ONE search_graph, joined on qn_prefix (a same-named shadow is excluded) and graded correct', async () => {
    const { f, arm: a } = arm({
      trace_path: () => ok(env(TRACE_IN)),
      search_graph: () => ok(env(GRAPH_DECLS)),
    });
    const kase = byId('selective-external-consumer');
    const r = await a.query(kase);
    expect(f.calls.map((c) => c.tool)).toEqual(['trace_path', 'search_graph']);
    expect(r.error).toBeNull();
    expect(r.sites.map((s) => `${s.path}:${s.line1}`)).not.toContain('packages/operator-core/lib/unrelated/shadow.ts:7');
    expect(gradeSites(kase, r.sites).correct).toBe(true);
    // Only the MCP text payload counts, never the envelope that duplicates it.
    expect(r.responseBytes).toBe(Buffer.byteLength(JSON.stringify(TRACE_IN)) + Buffer.byteLength(JSON.stringify(GRAPH_DECLS)));
    // The scratch HOME/cache are always injected; the bin is never asked to `install`.
    expect(f.calls.every((c) => c.env?.HOME === '/h' && c.env?.CBM_CACHE_DIR === '/h/cache')).toBe(true);
    expect(f.calls.some((c) => c.args.includes('install'))).toBe(false);
  });

  it('callees uses the outbound direction', async () => {
    const { f, arm: a } = arm({ trace_path: () => ok(env({ callees: { groups: [] } })), search_graph: () => ok(env(GRAPH_DECLS)) });
    const r = await a.query(byId('selective-fingerprint-chain'));
    expect(f.calls[0]!.args).toContain('outbound');
    expect(r.sites).toEqual([]);
    expect(f.calls).toHaveLength(1); // nothing traced → no resolve call
  });

  it('symbol-search anchors the name with ^…$ and escapes regex metacharacters', async () => {
    const { f, arm: a } = arm({ search_graph: () => ok(env(GRAPH_DECLS)) });
    await a.query({ ...byId('selective-exact-index-symbol'), query: 'use$Thing' });
    const i = f.calls[0]!.args.indexOf('--name-pattern');
    expect(f.calls[0]!.args[i + 1]).toBe('^use\\$Thing$');
  });

  it('text-search maps matches to path:line and is NOT graded correct when the expected line differs (disclosed miss, not tuned)', async () => {
    const { arm: a } = arm({ search_code: () => ok(env(SEARCH_CODE)) });
    const kase = byId('selective-route-boundary');
    const r = await a.query(kase);
    expect(r.sites.length).toBeGreaterThan(0);
    expect(gradeSites(kase, r.sites).correct).toBe(false);
  });

  it('declines an unrouted intent instead of guessing, and surfaces CLI failures as errors', async () => {
    const { arm: a } = arm({ search_graph: () => ({ code: 3, stdout: '', stderr: 'boom', wallMs: 1, peakRssKb: null }) });
    const declined = await a.query({ ...byId('selective-exact-index-symbol'), intent: 'rename-preview' });
    expect(declined.error).toMatch(/declined/);
    const failed = await a.query(byId('selective-exact-index-symbol'));
    expect(failed.error).toMatch(/search_graph exit 3/);
    expect(failed.sites).toEqual([]);
  });

  it('index/refresh run index_repository against the arm tree, adopt the engine project key, and fail on an error envelope', async () => {
    const { f, arm: a } = arm({ index_repository: () => ok(env({ project: 'engine-key' })) });
    const p = await a.index();
    expect(p.ok).toBe(true);
    expect(f.calls[0]!.args).toEqual(['cli', '--json', 'index_repository', '--repo-path', '/a/b/tree']);
    const bad = arm({ index_repository: () => ok(env({ error: 'nope' }, true)) });
    expect((await bad.arm.refresh()).ok).toBe(false);
  });
});

describe('withDaemonPeak', () => {
  it('reports the larger of the client peak and the sampled daemon peak, and keeps null when neither was measured', async () => {
    let n = 0;
    const slow = async () => { await new Promise((r) => setTimeout(r, 40)); return ok('x', { peakRssKb: 17 }); };
    const r = await withDaemonPeak(slow, 5, async () => (n += 1000));
    expect(r.peakRssKb).toBeGreaterThanOrEqual(1000);
    const none = await withDaemonPeak(async () => ok('x', { peakRssKb: null }), 5, async () => 0);
    expect(none.peakRssKb).toBeNull();
  });
});
