import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { resolveChunkSurface, splitterVersionOf } from '@papercusp/search';
// Deliberately unmocked: a duplicate live source must fail this guard.
import { SEARCH_SOURCES } from '../../agent-tools/search/sources';
import {
  CHUNK_SURFACES,
  CONSULT_QUESTIONS_CHUNK_SURFACE,
  consultSettledPredicate,
  OPERATOR_TURNS_CHUNK_SURFACE,
  WORK_ITEMS_CHUNK_SURFACE,
  PLANS_CHUNK_SURFACE,
  REPORTS_CHUNK_SURFACE,
  surfaceStoreTable,
  TEXT_CHUNKS_TABLE,
} from './registry';
import { runChunkSyncTick } from './tick';

describe('chunk surface registry', () => {
  it('has exactly one live search source for each canonical knowledge family, with a duplicate negative control', () => {
    const names = SEARCH_SOURCES.map(source => source.name);
    const duplicates = (input: string[]) => input.filter((name, index) => input.indexOf(name) !== index);
    expect(duplicates(names)).toEqual([]);
    for (const family of ['plan', 'doc', 'report']) {
      expect(names.filter(name => name === family), family).toEqual([family]);
      expect(duplicates([...names, family])).toContain(family);
    }
  });

  it('keeps knowledge ingestion on the existing periodic and publication paths, detecting a second schedule', () => {
    const calls = (body: string) => {
      const file = ts.createSourceFile('fixture.ts', body, ts.ScriptTarget.Latest, true);
      const out: Array<{ callee: string; first: string }> = [];
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) out.push({ callee: node.expression.getText(file), first: node.arguments[0]?.getText(file) ?? '' });
        ts.forEachChild(node, visit);
      };
      visit(file);
      return out;
    };
    const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
    // Inspect every DBOS registration module, including a newly added file.
    // Resolve declarations/import aliases to the actual ingestion calls: the
    // workflow variable's spelling is not evidence of what it schedules.
    const dbos = new URL('../../dbos/', import.meta.url);
    const modules = readdirSync(dbos, { recursive: true }).map(String)
      .filter(path => path.endsWith('.ts') && !path.endsWith('.test.ts'))
      .map(path => ({ path, body: readFileSync(join(dbos.pathname, path), 'utf8') }));
    const knowledgeSchedules = (inputs: Array<{ path: string; body: string }>) => {
      const declarations = new Map<string, ts.Node[]>();
      const roots = new Set(['runEmbedBackfillOnce', 'runChunkSyncTick', 'runDocSectionsSyncOnce',
        'runHarnessDocSectionsSweep', 'indexReport']);
      const files = inputs.map(input => ({ ...input,
        ast: ts.createSourceFile(input.path, input.body, ts.ScriptTarget.Latest, true) }));
      const remember = (name: string, node: ts.Node) => declarations.set(name,
        [...(declarations.get(name) ?? []), node]);
      for (const { ast } of files) {
        const visit = (node: ts.Node) => {
          if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) remember(node.name.text, node.initializer);
          if (ts.isFunctionDeclaration(node) && node.name && node.body) remember(node.name.text, node.body);
          if (ts.isImportSpecifier(node)) remember(node.name.text, node.propertyName ?? node.name);
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
      const reaches = (node: ts.Node, targets: ReadonlySet<string>): boolean => {
        const pending = [node];
        const seenNames = new Set<string>();
        const seenNodes = new Set<ts.Node>();
        while (pending.length) {
          const current = pending.pop()!;
          if (seenNodes.has(current)) continue;
          seenNodes.add(current);
          if (ts.isIdentifier(current)) {
            if (targets.has(current.text)) return true;
            if (seenNames.has(current.text)) continue;
            seenNames.add(current.text);
            pending.push(...(declarations.get(current.text) ?? []));
          } else {
            if (ts.isPropertyAccessExpression(current) && targets.has(current.getText())) return true;
            ts.forEachChild(current, child => { pending.push(child); });
          }
        }
        return false;
      };
      const registrations: Array<{ path: string; first: string }> = [];
      const isSchedule = (node: ts.Node, seen = new Set<string>()): boolean => {
        if (ts.isPropertyAccessExpression(node)) return node.getText() === 'DBOS.registerScheduled';
        if (!ts.isIdentifier(node) || seen.has(node.text)) return false;
        const next = new Set([...seen, node.text]);
        return (declarations.get(node.text) ?? []).some(value => isSchedule(value, next));
      };
      for (const { path, ast } of files) {
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.arguments[0]
            && isSchedule(node.expression)
            && reaches(node.arguments[0], roots)) registrations.push({ path, first: node.arguments[0].getText(ast) });
          ts.forEachChild(node, visit);
        };
        visit(ast);
      }
      return registrations;
    };
    expect(knowledgeSchedules(modules)).toEqual([{ path: 'periodic-workflows.ts', first: 'embedBackfillWorkflow' }]);
    const alias = '\nconst knowledgeSweepWorkflow = embedBackfillWorkflow;\nDBOS.registerScheduled(knowledgeSweepWorkflow, {name: "parallelKnowledge"});';
    expect(knowledgeSchedules(modules.map(module => module.path === 'periodic-workflows.ts'
      ? { ...module, body: module.body + alias } : module))).toHaveLength(2);
    expect(knowledgeSchedules([...modules, { path: 'new-knowledge-scheduler.ts',
      body: 'import { runChunkSyncTick as rebuild } from "../search/chunks/tick"; const schedule = DBOS.registerScheduled; const unnamed = () => rebuild(); schedule(unnamed, {});' }]))
      .toHaveLength(2);
    expect(knowledgeSchedules([{ path: 'cyclic-alias.ts',
      body: 'const first = second; const second = first; DBOS.registerScheduled(first, {});' }])).toEqual([]);
    const backfillCalls = calls(source('../embed-backfill.ts')).map(call => call.callee);
    for (const child of ['runDocSectionsSyncOnce', 'runHarnessDocSectionsSweep', 'runChunkSyncTick']) {
      expect(backfillCalls, child).toContain(child);
    }
    expect(calls(source('../../report-publication.ts')).filter(call => call.callee === 'indexReport')).toHaveLength(1);
    const schedulers = new Set(['setInterval', 'managedSetInterval', 'DBOS.registerScheduled', 'registerSystemAction']);
    for (const child of ['../doc-embed-sync.ts', './tick.ts', '../report-index.ts']) {
      expect(calls(source(child)).filter(call => schedulers.has(call.callee)), child).toEqual([]);
      expect(calls(source(child) + '\nsetInterval(runDuplicateKnowledgeIndex, 1000);').filter(call => schedulers.has(call.callee)))
        .toHaveLength(1);
    }
  });

  it('every entry is valid, so a registry mistake fails here instead of at sync time', () => {
    for (const s of CHUNK_SURFACES) expect(() => resolveChunkSurface(s), s.surface).not.toThrow();
  });

  it('surface names are unique (they partition the shared chunk table)', () => {
    const names = CHUNK_SURFACES.map((s) => s.surface);
    expect(new Set(names).size).toBe(names.length);
  });

  it('knowledge indexes extend canonical parents in the shared chunk store rather than registering parallel stores', () => {
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'plan')).toEqual([PLANS_CHUNK_SURFACE]);
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'report')).toEqual([REPORTS_CHUNK_SURFACE]);
    expect(PLANS_CHUNK_SURFACE.parent.table).toBe('harness_shared.harness_plans');
    expect(REPORTS_CHUNK_SURFACE.parent.table).toBe('harness_shared.report_library');
    for (const surface of [PLANS_CHUNK_SURFACE,REPORTS_CHUNK_SURFACE]) {
      expect(surfaceStoreTable(surface)).toBe('harness_shared.text_chunks');
      expect(() => resolveChunkSurface(surface)).not.toThrow();
    }
    expect(CHUNK_SURFACES.filter(s=>s.searchSource === 'plan' || s.searchSource === 'report')
      .map(s=>s.surface).sort()).toEqual(['plans','report']);
  });

  it('every entry reads its version from the parent, so detection never hashes parent text in SQL', () => {
    for (const s of CHUNK_SURFACES) expect(s.versionSql, s.surface).toBeTruthy();
  });

  it('splitter versions are distinct per splitter shape (a registry edit re-cuts)', () => {
    const a = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 8 });
    const b = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 32 });
    expect(a).not.toBe(b);
  });

  it('plans are registered with the D-014 bench arm at the D-029 margin (P-009, P-015)', () => {
    expect(CHUNK_SURFACES).toContain(PLANS_CHUNK_SURFACE);
    const s = PLANS_CHUNK_SURFACE;
    expect(s.surface).toBe('plans');
    expect(s.parent).toEqual({
      table: 'harness_shared.harness_plans',
      key: ['workspace_id', 'harness_slug', 'plan_slug'],
    });
    // D-014: 1,500-character windows, 250 overlap, up to 32 windows.
    // D-029: chunk margin 0.02 (the live R-2 re-run failed at D-014's margin 0).
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(32);
    expect(s.completeBody).toBe(true);
    expect(s.chunkMargin).toBe(0.02);
    // The plan's own vector is the gist leg (D-005 readers stay on it).
    expect(s.parentVector).toEqual({
      column: 'embedding',
      profileColumn: 'embedding_profile',
      modeColumn: 'embedding_mode',
    });
    // The same chunks serve general search and its coverage gate.
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    expect(s.searchSource).toBe('plan');
  });

  it('operator turns are registered with the D-017 bench arm (P-010)', () => {
    expect(CHUNK_SURFACES).toContain(OPERATOR_TURNS_CHUNK_SURFACE);
    const s = OPERATOR_TURNS_CHUNK_SURFACE;
    expect(s.surface).toBe('operator_turns');
    expect(s.parent).toEqual({ table: 'harness_shared.operator_turns', key: [{ column: 'id', type: 'uuid' }] });
    // D-017: 1,500/250 windows, up to 8, chunk margin 0.06.
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(8);
    expect(s.chunkMargin).toBe(0.06);
    expect(s.parentVector).toEqual({
      column: 'text_embedding',
      profileColumn: 'text_embedding_profile',
      modeColumn: 'text_embedding_mode',
    });
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    // Its chunks feed the search:semantic 'turns' source, so the coverage gate counts them there.
    expect(s.searchSource).toBe('turns');
  });

  it('R-40: every registered collection carries its P-001 verdict (D-014 to D-017)', () => {
    // Pinned from the decisions, not read back from the registry: a registry edit
    // that drifts from its bench verdict fails here.
    const VERDICTS: Record<string, { maxChunks: number; chunkMargin: number; decision: string }> = {
      // The margin is D-029's (P-015 live re-run), which amends D-014's margin 0.
      plans: { maxChunks: 32, chunkMargin: 0.02, decision: 'D-014 + D-029' },
      work_items: { maxChunks: 4, chunkMargin: 0, decision: 'D-015' },
      consult_questions: { maxChunks: 8, chunkMargin: 0.04, decision: 'D-016' },
      operator_turns: { maxChunks: 8, chunkMargin: 0.06, decision: 'D-017' },
    };
    // Reports have their own complete-body contract, outside the earlier bench.
    const shared = CHUNK_SURFACES.filter((s) => surfaceStoreTable(s) === TEXT_CHUNKS_TABLE && s.surface !== 'report');
    expect(shared.map((s) => s.surface).sort()).toEqual(Object.keys(VERDICTS).sort());
    for (const s of shared) {
      const v = VERDICTS[s.surface]!;
      expect(s.splitter, `${s.surface} ${v.decision}`).toEqual({ kind: 'window', size: 1500, overlap: 250 });
      expect(s.maxChunks, `${s.surface} ${v.decision}`).toBe(v.maxChunks);
      expect(s.chunkMargin ?? 0, `${s.surface} ${v.decision}`).toBe(v.chunkMargin);
    }
  });

  it('work items and consult questions chunk their long text against their own parent vector (P-011, P-012)', () => {
    expect(WORK_ITEMS_CHUNK_SURFACE.parent).toEqual({ table: 'harness_shared.work_items', key: ['harness_slug', 'feature_id'] });
    expect(WORK_ITEMS_CHUNK_SURFACE.textSql).toBe('p.summary');
    expect(WORK_ITEMS_CHUNK_SURFACE.searchSource).toBe('work_item');
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.parent).toEqual({
      table: 'harness_shared.consult_state',
      key: ['workspace_id', 'conversation_id'],
    });
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.textSql).toBe('p.question');
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.parentVector).toEqual({
      column: 'query_embedding',
      profileColumn: 'query_embedding_profile',
      modeColumn: 'query_embedding_mode',
    });
    // Escalations are not registered (D-018).
    expect(CHUNK_SURFACES.map((s) => s.surface)).not.toContain('escalations');
  });

  it("consult questions chunk only the reader's settled population (D-048)", () => {
    // The same text peersKnowLookup filters its slice with, derived from one function.
    expect(CONSULT_QUESTIONS_CHUNK_SURFACE.eligibleSql).toBe(consultSettledPredicate('p'));
    expect(consultSettledPredicate('cs')).toBe(
      "cs.state = 'closed_answered' AND (cs.outcome->>'source' IS DISTINCT FROM 'archive')",
    );
    expect(() => consultSettledPredicate("p; DROP TABLE x")).toThrow(/not a plain identifier/);
  });

  it('plan templates are never chunked (they are never searched)', () => {
    expect(PLANS_CHUNK_SURFACE.eligibleSql).toMatch(/\bp\.template_slug IS NULL\b/);
    expect(PLANS_CHUNK_SURFACE.textSql).toBe('p.content');
    expect(PLANS_CHUNK_SURFACE.headerSql).toBe('p.title');
  });

  it('the tick is inert under vitest unless a SQL handle is injected', async () => {
    expect(await runChunkSyncTick()).toEqual({ skipped: 'vitest' });
  });
});
