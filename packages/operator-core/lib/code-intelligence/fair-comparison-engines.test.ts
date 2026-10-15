/**
 * Parser tests for the P-017 third-party adapters. Every fixture below is the
 * SHAPE of real output captured from codegraph 1.6.2 and trace-mcp 3.34.6 on the
 * micro repo (2026-10-06), trimmed to the fields the parsers read.
 */
import { describe, expect, it } from 'vitest';
import type { FairCase } from './fair-comparison';
import { MICRO_CASES } from './fair-comparison-micro-repo';
import {
  askCbm,
  askCgc,
  askGitnexus,
  askTrace,
  CBM_LIMITS,
  cbmNameAlternation,
  gitnexusJson,
  gitnexusLine1,
  narrowToAnchor,
  CGC_ACCEPTED_FAULTS,
  CGC_RESULT_LIMITS,
  cgcPath,
  cgcRequest,
  codegraphArgv,
  createCodegraphArm,
  parseCgc,
  parseCodegraph,
  traceCandidates,
  traceImpactSymbolIds,
  traceTextSites,
  traceUsageSites,
} from './fair-comparison-engines';

const k = (intent: FairCase['intent'], subject: string, extra: Partial<FairCase> = {}): FairCase => ({
  id: `t-${intent}`,
  intent,
  subject,
  tags: [],
  source: 'micro-repo',
  ...extra,
});
const at = (sites: ReadonlyArray<{ path: string; line1: number | null }>) => sites.map((s) => `${s.path}:${s.line1}`);

describe('codegraph adapter', () => {
  it('indexes with the watchdog off, so a busy indexer is not killed as wedged', async () => {
    const envs: Array<Record<string, string | undefined>> = [];
    const exec = (async (_bin: string, _args: readonly string[], opts: { env?: Record<string, string | undefined> }) => {
      envs.push({ ...opts.env });
      return { code: 0, stdout: '', stderr: '', wallMs: 1, peakRssKb: null };
    }) as unknown as NonNullable<Parameters<typeof createCodegraphArm>[1]['exec']>;
    const arm = createCodegraphArm(
      { version: 'v', bin: '/bin/codegraph', treeRoot: '/t', home: '/h', env: { CODEGRAPH_TELEMETRY: '0' } },
      { loadAvg1: () => null, exec },
    );
    expect((await arm.index()).ok).toBe(true);
    expect(envs[0]).toMatchObject({ CODEGRAPH_NO_WATCHDOG: '1', CODEGRAPH_TELEMETRY: '0', HOME: '/h' });
  });

  it('passes anchorFile, depth and a raised limit', () => {
    expect(codegraphArgv(k('callers', 'add', { anchorFile: 'src/util/math.ts' }))).toEqual(['callers', 'add', '-j', '-l', '10000', '-f', 'src/util/math.ts']);
    expect(codegraphArgv(k('impact', 'scale', { depth: 3 }))).toEqual(['impact', 'scale', '-j', '-d', '3']);
    expect(codegraphArgv(k('definition', 'doubled'))).toEqual(['query', 'doubled', '-j', '-l', '1000']);
    expect(() => codegraphArgv(k('references', 'x'))).toThrow(/^declined:/);
  });

  it('keeps every caller codegraph reports, file-level import edges included (raw, D-013)', () => {
    const out = JSON.stringify({
      symbol: 'add',
      callers: [
        { name: 'BASE', kind: 'constant', filePath: 'src/app/report.ts', startLine: 4, relationships: ['calls'] },
        { name: 'report.ts', kind: 'file', filePath: 'src/app/report.ts', startLine: 1, relationships: ['imports'] },
      ],
      truncated: false,
    });
    const r = parseCodegraph(k('callers', 'add'), out);
    expect(at(r.sites)).toEqual(['src/app/report.ts:4', 'src/app/report.ts:1']);
    expect(r.note).toBeNull();
  });

  it('reads impact from `affected` and flags truncation', () => {
    const out = JSON.stringify({ affected: [{ name: 'doubled', kind: 'function', filePath: 'src/app/report.ts', startLine: 12 }], truncated: true });
    const r = parseCodegraph(k('impact', 'scale'), out);
    expect(at(r.sites)).toEqual(['src/app/report.ts:12']);
    expect(r.note).toMatch(/truncated/);
  });

  it('keeps only exact-name symbols from a fuzzy query', () => {
    const out = JSON.stringify([
      { node: { name: 'add', kind: 'function', filePath: 'src/util/math.ts', startLine: 2 }, score: 93 },
      { node: { name: 'BASE', kind: 'constant', filePath: 'src/app/report.ts', startLine: 4 }, score: 5 },
    ]);
    expect(at(parseCodegraph(k('symbol-search', 'add'), out).sites)).toEqual(['src/util/math.ts:2']);
  });

  it('reads the not-found notice as a confident empty answer', () => {
    expect(parseCodegraph(k('callers', 'nosuchsym'), '\nℹ Symbol "nosuchsym" not found\n')).toEqual({ sites: [], note: 'codegraph: symbol not found' });
  });

  it('throws on output it cannot read, so a changed format surfaces as a crash', () => {
    expect(() => parseCodegraph(k('callers', 'add'), 'segfault')).toThrow(/no JSON/);
    expect(() => parseCodegraph(k('callers', 'add'), JSON.stringify({ symbol: 'add' }))).toThrow(/no 'callers' array/);
  });
});

describe('trace-mcp adapter', () => {
  const items = [
    { symbol_id: 'src/app/format.ts::add#function', name: 'add', kind: 'function', file: 'src/app/format.ts', line: 2 },
    { symbol_id: 'src/util/math.ts::add#function', name: 'add', kind: 'function', file: 'src/util/math.ts', line: 2 },
    { symbol_id: 'src/app/report.ts::BASE#variable', name: 'BASE', kind: 'variable', file: 'src/app/report.ts', line: 4 },
  ];

  it('narrows same-name candidates to anchorFile, and keeps the union without one', () => {
    expect(traceCandidates(k('callers', 'add', { anchorFile: 'src/util/math.ts' }), { items }).map((i) => i.file)).toEqual(['src/util/math.ts']);
    expect(traceCandidates(k('callers', 'add'), { items }).map((i) => i.file)).toEqual(['src/app/format.ts', 'src/util/math.ts']);
  });

  it('reads text hits and the result cap', () => {
    const json = { files: [{ file: 'src/app/report.ts', hits: [{ line: 3 }, { line: 18 }] }], truncated: false, timed_out: false };
    expect(traceTextSites(json)).toEqual({ sites: [expect.objectContaining({ path: 'src/app/report.ts', line1: 3 }), expect.objectContaining({ line1: 18 })], truncated: false });
    expect(traceTextSites({ ...json, truncated: true }).truncated).toBe(true);
  });

  it('reads usages at the referencing scope, and impact symbol ids', () => {
    expect(at(traceUsageSites({ references: [{ file: 'src/app/report.ts', symbol: { line_start: 12, kind: 'function' } }] }))).toEqual(['src/app/report.ts:12']);
    expect(traceImpactSymbolIds({ dependents: [{ symbols: [{ symbolId: 'src/app/report.ts::doubled#function' }, { symbolId: 'src/app/report.ts::report#function' }] }] })).toEqual([
      'src/app/report.ts::doubled#function',
      'src/app/report.ts::report#function',
    ]);
  });

  const text = (j: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(j) }], ...(isError ? { isError: true } : {}) });
  const fake = (replies: Record<string, (args: Record<string, unknown>) => unknown>) => {
    const calls: string[] = [];
    return {
      calls,
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${String(args.symbol_id ?? args.query ?? '')}`);
        return replies[name]!(args);
      },
    };
  };

  it('resolves the symbol through search, then asks the call graph by symbol id', async () => {
    const s = fake({
      search: () => text({ items }),
      get_call_graph: () => text({ root: { called_by: [{ file: 'src/util/math.ts', line: 6, kind: 'function' }] } }),
    });
    const r = await askTrace(s, k('callers', 'add', { anchorFile: 'src/util/math.ts' }));
    expect(s.calls).toEqual(['search:add', 'get_call_graph:src/util/math.ts::add#function']);
    expect(at(r.sites)).toEqual(['src/util/math.ts:6']);
  });

  it('resolves impact dependents to lines with trace-mcp’s own get_symbol', async () => {
    const s = fake({
      search: () => text({ items: [{ symbol_id: 'src/util/math.ts::scale#function', name: 'scale', file: 'src/util/math.ts', line: 6 }] }),
      get_change_impact: () => text({ dependents: [{ symbols: [{ symbolId: 'src/app/report.ts::doubled#function' }] }] }),
      get_symbol: () => text({ file: 'src/app/report.ts', line_start: 12, kind: 'function' }),
    });
    expect(at((await askTrace(s, k('impact', 'scale', { depth: 2 }))).sites)).toEqual(['src/app/report.ts:12']);
  });

  it('answers empty when the symbol is unknown, and crashes on a real tool error', async () => {
    const none = await askTrace(fake({ search: () => text({ items: [] }) }), k('callers', 'nosuch'));
    expect(none).toMatchObject({ sites: [], error: null, note: 'trace-mcp: symbol not found' });
    const s = fake({ search: () => text({ items }), get_call_graph: () => text({ error: { code: 'INTERNAL', message: 'db locked' } }, true) });
    await expect(askTrace(s, k('callers', 'add'))).rejects.toThrow(/db locked/);
  });
});

// Shapes captured from CodeGraphContext 0.6.13 over MCP stdio on the micro repo (2026-10-06).
describe('CodeGraphContext adapter', () => {
  const T = '/bench/micro-repo';
  const reply = (results: Record<string, unknown>) => ({ success: true, results });

  it('maps intents to CGC tools, passes anchorFile as context and depth, and declines references', () => {
    expect(cgcRequest(k('callers', 'total', { anchorFile: 'src/app/report.ts' }))).toEqual({
      tool: 'analyze_code_relationships',
      args: { query_type: 'find_callers', target: 'total', context: 'src/app/report.ts' },
    });
    expect(cgcRequest(k('impact', 'scale', { depth: 3 })).args).toEqual({ query_type: 'find_all_callers', target: 'scale', depth: 3 });
    expect(cgcRequest(k('text-search', 'grand total'))).toEqual({ tool: 'find_code', args: { query: 'grand total', fuzzy_search: false } });
    expect(() => cgcRequest(k('references', 'sortRows'))).toThrow(/^declined/);
  });

  it('raises every result cap the arm uses', () => {
    const limits = JSON.parse(CGC_RESULT_LIMITS) as Record<string, number>;
    for (const tool of ['find_code', 'find_callers', 'find_callees', 'find_all_callers']) expect(limits[tool]).toBeGreaterThanOrEqual(100_000);
  });

  it('makes paths repo-relative and leaves an outside path absolute so it scores as wrong', () => {
    expect(cgcPath(T, `${T}/src/app/report.ts`)).toBe('src/app/report.ts');
    expect(cgcPath(T, '/elsewhere/x.ts')).toBe('/elsewhere/x.ts');
  });

  it('keeps every caller call line, duplicates included (raw), and callee declaration lines', () => {
    const callers = reply({
      results: [
        { caller_function: 'total', caller_file_path: `${T}/src/app/report.ts`, caller_line_number: 6, call_line_number: 7 },
        { caller_function: 'total', caller_file_path: `${T}/src/app/report.ts`, caller_line_number: 6, call_line_number: 8 },
      ],
      truncated: false,
      result_limit: 1000000,
    });
    const r = parseCgc(k('callers', 'add'), callers, T);
    expect(at(r.sites)).toEqual(['src/app/report.ts:7', 'src/app/report.ts:8']);
    expect(r.note).toBeNull();
    const callees = reply({ results: [{ called_function: 'doubled', called_file_path: `${T}/src/app/report.ts`, called_line_number: 12, call_line_number: 20 }], truncated: true, result_limit: 20 });
    const c = parseCgc(k('callees', 'report'), callees, T);
    expect(at(c.sites)).toEqual(['src/app/report.ts:12']);
    expect(c.note).toMatch(/truncated at result_limit 20/);
  });

  it('keeps exact-name symbols across functions, classes and variables, and content matches for text search', () => {
    const found = reply({
      functions_by_name: [
        { name: 'add', path: `${T}/src/app/format.ts`, line_number: 2 },
        { name: 'addAll', path: `${T}/src/app/format.ts`, line_number: 9 },
      ],
      classes_by_name: [],
      variables_by_name: [{ name: 'add', path: `${T}/src/util/math.ts`, line_number: 4 }],
      content_matches: [{ type: 'function', name: 'report', path: `${T}/src/app/report.ts`, line_number: 19 }],
    });
    expect(at(parseCgc(k('symbol-search', 'add'), found, T).sites)).toEqual(['src/app/format.ts:2', 'src/util/math.ts:4']);
    expect(at(parseCgc(k('text-search', 'grand'), found, T).sites)).toEqual(['src/app/report.ts:19']);
  });

  it('turns a query error inside a successful envelope into an error, never an empty answer', () => {
    const broken = reply({ error: 'Error executing relationship query: Binder exception: Expression in WITH must be aliased (use AS).' });
    const r = parseCgc(k('impact', 'doubled'), broken, T);
    expect(r.sites).toEqual([]);
    expect(r.error).toMatch(/Binder exception/);
    expect(parseCgc(k('callers', 'x'), { success: false, error: 'no graph' }, T).error).toMatch(/no graph/);
    expect(() => parseCgc(k('callers', 'x'), { success: true }, T)).toThrow(/no results object/);
  });

  it('accepts only engine faults that name a real micro case, with a crash pattern and evidence', () => {
    const ids = new Set(MICRO_CASES.map((c) => c.id));
    for (const f of CGC_ACCEPTED_FAULTS) {
      expect(ids.has(f.caseId)).toBe(true);
      expect(f.evidence.length).toBeGreaterThan(40);
      if (f.outcome === 'crashed') expect(f.detail).toBeInstanceOf(RegExp);
    }
  });

  it('answers through an MCP session and reports an MCP-level error', async () => {
    const text = (j: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(j) }], ...(isError ? { isError: true } : {}) });
    const seen: string[] = [];
    const ok = { call: async (name: string, args: Record<string, unknown>) => (seen.push(`${name}:${String(args.query_type ?? args.query)}`), text(reply({ results: [] }))) };
    expect(await askCgc(ok, k('callers', 'neverCalled'), T)).toEqual({ sites: [], error: null, note: null });
    expect(seen).toEqual(['analyze_code_relationships:find_callers']);
    const bad = { call: async () => text({ message: 'tool failed' }, true) };
    expect((await askCgc(bad, k('callers', 'x'), T)).error).toMatch(/cgc analyze_code_relationships: .*tool failed/);
  });
});

/** A fake MCP session: one handler per tool, every call recorded as `tool:<key arg>`. */
const mcpFake = (replies: Record<string, (args: Record<string, unknown>) => unknown>) => {
  const calls: string[] = [];
  return {
    calls,
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push(`${name}:${String(args.uid ?? args.target_uid ?? args.name ?? args.function_name ?? args.name_pattern ?? args.pattern ?? '')}`);
      return replies[name]!(args);
    },
  };
};
const mcpText = (j: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(j) }], ...(isError ? { isError: true } : {}) });

describe('shared anchor narrowing', () => {
  it('narrows to anchorFile only when a candidate lives there, else keeps the union', () => {
    const items = [{ f: 'src/util/math.ts' }, { f: 'src/app/format.ts' }];
    expect(narrowToAnchor(k('callers', 'add', { anchorFile: 'src/app/format.ts' }), items, (i) => i.f)).toEqual([{ f: 'src/app/format.ts' }]);
    expect(narrowToAnchor(k('definition', 'add', { anchorFile: 'src/app/report.ts' }), items, (i) => i.f)).toEqual(items);
    expect(narrowToAnchor(k('symbol-search', 'add'), items, (i) => i.f)).toEqual(items);
  });
});

// Shapes captured from GitNexus 1.6.9 on the micro repo (2026-10-06): 0-based lines, File nodes as top-level callers.
describe('GitNexus adapter', () => {
  const found = (symbol: Record<string, unknown>, incoming: unknown[] = [], outgoing: unknown[] = []) =>
    mcpText({ status: 'found', symbol, incoming: { calls: incoming }, outgoing: { calls: outgoing } });
  const ADD = { uid: 'Function:src/util/math.ts:add', name: 'add', kind: 'Function', filePath: 'src/util/math.ts', startLine: 1 };
  const lineByUid: Record<string, number> = { 'Function:src/app/report.ts:total': 5, 'Function:src/util/math.ts:scale': 5, 'Function:src/app/report.ts:report': 18 };
  const byUid = (a: Record<string, unknown>) => found({ uid: a.uid, startLine: lineByUid[String(a.uid)] });

  it('drops the next-step hints GitNexus appends after the JSON, and crashes on anything else', () => {
    expect(gitnexusJson({ content: [{ type: 'text', text: '{"status":"found"}\n---\nNext: call impact' }] }).json).toEqual({ status: 'found' });
    expect(() => gitnexusJson({ content: [{ type: 'text', text: 'Error: db locked' }] })).toThrow(/non-JSON/);
    expect([gitnexusLine1(5, 0), gitnexusLine1(5, 1), gitnexusLine1(undefined, 0)]).toEqual([6, 5, null]);
  });

  it('reports callers at line 1-based declaration lines, a File node as the top level (line 1)', async () => {
    const s = mcpFake({
      context: (a) =>
        a.name === 'add'
          ? found(ADD, [
              { uid: 'Function:src/app/report.ts:total', filePath: 'src/app/report.ts' },
              { uid: 'Function:src/util/math.ts:scale', filePath: 'src/util/math.ts' },
              { uid: 'File:src/app/report.ts', filePath: 'src/app/report.ts' },
            ])
          : byUid(a),
    });
    const r = await askGitnexus(s, k('callers', 'add', { anchorFile: 'src/util/math.ts' }), 0);
    expect(at(r.sites)).toEqual(['src/app/report.ts:6', 'src/util/math.ts:6', 'src/app/report.ts:1']);
    expect(s.calls).toEqual(['context:add', 'context:Function:src/app/report.ts:total', 'context:Function:src/util/math.ts:scale']);
  });

  it('narrows an ambiguous name to the anchor, or scores the union of every exact-name candidate', async () => {
    const amb = mcpText({
      status: 'ambiguous',
      candidates: [
        { uid: 'Function:src/util/math.ts:add', name: 'add', kind: 'Function', filePath: 'src/util/math.ts', line: 1 },
        { uid: 'Function:src/app/format.ts:add', name: 'add', kind: 'Function', filePath: 'src/app/format.ts', line: 1 },
        { uid: 'Function:src/app/format.ts:addAll', name: 'addAll', kind: 'Function', filePath: 'src/app/format.ts', line: 8 },
      ],
    });
    const one = await askGitnexus(mcpFake({ context: () => amb }), k('definition', 'add', { anchorFile: 'src/app/format.ts' }), 0);
    expect(at(one.sites)).toEqual(['src/app/format.ts:2']);
    const all = await askGitnexus(mcpFake({ context: () => amb }), k('symbol-search', 'add'), 0);
    expect(at(all.sites)).toEqual(['src/util/math.ts:2', 'src/app/format.ts:2']);
  });

  it('asks impact upstream by uid with the case depth and tests included, and resolves each node line', async () => {
    let impactArgs: Record<string, unknown> = {};
    const s = mcpFake({
      context: (a) => (a.name ? found({ uid: 'Function:src/util/math.ts:scale', name: 'scale', filePath: 'src/util/math.ts', startLine: 5 }) : byUid(a)),
      impact: (a) => ((impactArgs = a), mcpText({ byDepth: { '1': [{ id: 'Function:src/app/report.ts:total', filePath: 'src/app/report.ts' }], '2': [{ id: 'Function:src/app/report.ts:report', filePath: 'src/app/report.ts' }] } })),
    });
    const r = await askGitnexus(s, k('impact', 'scale', { depth: 2 }), 0);
    expect(at(r.sites)).toEqual(['src/app/report.ts:6', 'src/app/report.ts:19']);
    expect(impactArgs).toMatchObject({ target_uid: 'Function:src/util/math.ts:scale', direction: 'upstream', maxDepth: 2, includeTests: true });
  });

  it('answers empty for an unknown symbol, and reports an impact error as an error, never as no impact', async () => {
    const none = await askGitnexus(mcpFake({ context: () => mcpText({ error: "Symbol 'subtract' not found" }) }), k('callers', 'subtract'), 0);
    expect(none).toEqual({ sites: [], error: null, note: 'gitnexus: symbol not found' });
    const s = mcpFake({ context: () => found(ADD), impact: () => mcpText({ error: 'traversal failed' }) });
    expect((await askGitnexus(s, k('impact', 'add'), 0)).error).toMatch(/gitnexus impact: traversal failed/);
    await expect(askGitnexus(mcpFake({ context: () => mcpText({ weird: true }) }), k('callers', 'x'), 0)).rejects.toThrow(/unrecognized reply/);
  });
});

// Shapes captured from codebase-memory (dev build) on the micro repo (2026-10-06).
describe('codebase-memory adapter', () => {
  const P = 'bench-micro-cbm';
  const graph = (groups: Array<{ qn: string; file: string; rows: unknown[][] }>, extra: Record<string, unknown> = {}) =>
    mcpText({ cols: ['name', 'label', 'lines', 'in', 'out'], groups: groups.map((g) => ({ qn_prefix: g.qn, file: g.file, rows: g.rows })), ...extra });
  const ADDS = [
    { qn: `${P}.src.util.math`, file: 'src/util/math.ts', rows: [['add', 'Function', '2-4', 3, 0]] },
    { qn: `${P}.src.app.format`, file: 'src/app/format.ts', rows: [['add', 'Function', '2-4', 1, 0]] },
  ];

  it('raises every cap to the engine maximum and includes tests', () => {
    expect(CBM_LIMITS.tracePath).toEqual({ limit: 5000, max_output_tokens: 1_000_000, include_tests: true });
    expect(CBM_LIMITS.searchCode).toMatchObject({ result_limit: 500, match_limit: 500, raw_limit: 100 });
  });

  it('traces direct callers (depth 1) of the anchored candidate by qualified name, then resolves names to declaration lines', async () => {
    const traced: Array<Record<string, unknown>> = [];
    const s = mcpFake({
      search_graph: (a) =>
        a.name_pattern === '^add$'
          ? graph(ADDS)
          : graph([{ qn: `${P}.src.app.report`, file: 'src/app/report.ts', rows: [['total', 'Function', '6-9', 1, 1]] }, { qn: `${P}.src.other`, file: 'src/other.ts', rows: [['total', 'Function', '1-2', 0, 0]] }]),
      trace_path: (a) => (traced.push(a), mcpText({ callers_total_relation: 'eq', callers: { cols: ['name', 'hop'], groups: [{ qn_prefix: `${P}.src.app.report`, rows: [['total', 1]] }] } })),
    });
    const r = await askCbm(s, k('callers', 'add', { anchorFile: 'src/util/math.ts' }), P);
    expect(at(r.sites)).toEqual(['src/app/report.ts:6']);
    // CBM has no `(?:…)`: that pattern silently matched nothing and emptied every resolved answer.
    expect(s.calls).toEqual(['search_graph:^add$', `trace_path:${P}.src.util.math.add`, 'search_graph:^(total)$']);
    expect(cbmNameAlternation(['a.b', 'c', 'c'])).toBe('^(a\\.b|c)$');
    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({ function_name: `${P}.src.util.math.add`, direction: 'inbound', depth: 1, project: P, format: 'json' });
  });

  it('flags a bounded trace total and a truncated text search in the note', async () => {
    const s = mcpFake({
      search_graph: () => graph([ADDS[0]!]),
      trace_path: () => mcpText({ callers_total_relation: 'gte', callers: { cols: ['name', 'hop'], groups: [] } }),
    });
    expect((await askCbm(s, k('impact', 'add', { depth: 3 }), P)).note).toMatch(/total is a bound/);
    const code = mcpFake({ search_code: () => mcpText({ cols: ['qn', 'label', 'file', 'lines', 'matches', 'matches_omitted'], rows: [['m', 'Module', 'src/app/report.ts', '1-23', [18], 4]], has_more: false }) });
    const t = await askCbm(code, k('text-search', 'grand total'), P);
    expect(at(t.sites)).toEqual(['src/app/report.ts:18']);
    expect(t.note).toMatch(/search_code answer truncated/);
  });

  it('answers empty for an unknown symbol and crashes on an engine error', async () => {
    expect(await askCbm(mcpFake({ search_graph: () => graph([]) }), k('callees', 'nosuch'), P)).toEqual({ sites: [], error: null, note: 'cbm: symbol not found' });
    const bad = mcpFake({ search_graph: () => mcpText({ error: 'project not found or not indexed' }, true) });
    await expect(askCbm(bad, k('definition', 'add'), P)).rejects.toThrow(/cbm search_graph: .*project not found/);
  });
});
