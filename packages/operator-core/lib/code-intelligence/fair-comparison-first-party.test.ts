import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeIntelAnswer, SymbolSite } from './contracts';
import type { FairCase } from './fair-comparison';
import { materializeMicroRepo, runConformance } from './fair-comparison-arms';
import {
  askLspQuery,
  askTypescript,
  createLspQueryArm,
  createNoThirdPartyArm,
  identifierColumn,
  openTsTree,
  symbolHits,
  type LspDoor,
  type TsTree,
} from './fair-comparison-first-party';
import { MICRO_CASES, microRepoKeys } from './fair-comparison-micro-repo';

const answer = (sites: SymbolSite[], error: string | null = null, truncated = false): CodeIntelAnswer => ({
  backend: 'lsp-adapter',
  intent: 'symbol-search',
  query: 'q',
  sites,
  truncation: { truncated, totalAvailable: truncated ? sites.length + 5 : null, continuation: null },
  freshness: { health: error ? 'degraded' : 'healthy', indexedAt: null, staleVsDisk: null, indexedCommit: null },
  latencyMs: 1,
  error,
});
const sym = (path: string, line1: number, name: string): SymbolSite => ({ path, line1, kind: null, name });
const kase = (intent: FairCase['intent'], subject: string, anchorFile?: string): FairCase => ({
  id: `t-${intent}-${subject}`,
  intent,
  subject,
  tags: [],
  source: 'authored',
  ...(anchorFile ? { anchorFile } : {}),
});

describe('identifierColumn', () => {
  it('finds the name as a whole identifier, not inside a longer one', () => {
    expect(identifierColumn('export function addAll(add: number) { add }', 'add')).toBe(23);
    expect(identifierColumn('const $add = add$;', 'add')).toBe(-1);
    expect(identifierColumn('  scale(x)', 'scale')).toBe(2);
  });
});

describe('symbolHits', () => {
  it('reads the adapter empty-search caveat as an empty answer, not a failure', () => {
    const r = symbolHits(answer([], "no typescript symbol named 'gone' in the project rooted at /t. This is NOT evidence"), 'gone');
    expect(r).toMatchObject({ hits: [], error: null });
    expect(r.note).toMatch(/^no typescript symbol named/);
  });
  it('passes any other error through as an error', () => {
    expect(symbolHits(answer([], 'language server did not establish readiness'), 'x').error).toMatch(/readiness/);
  });
  it('keeps exact-name hits only (tsserver search is fuzzy) and flags truncation', () => {
    const r = symbolHits(answer([sym('a.ts', 1, 'add'), sym('a.ts', 9, 'addAll'), sym('b.ts', 2, 'add')], null, true), 'add');
    expect(r.hits.map((h) => `${h.path}:${h.line1}`)).toEqual(['a.ts:1', 'b.ts:2']);
    expect(r.note).toMatch(/truncated by the engine/);
  });
});

describe('askLspQuery', () => {
  const lines: Record<string, string> = {
    '/t/src/a.ts:3': 'export function add(a: number) {',
    '/t/src/b.ts:7': 'function add(x: string) {',
  };
  const refCalls: unknown[] = [];
  const door: LspDoor = {
    workspaceSymbols: async () => answer([sym('src/a.ts', 3, 'add'), sym('src/b.ts', 7, 'add'), sym('src/a.ts', 20, 'adder')]),
    references: async (q) => {
      refCalls.push(q);
      return answer(q.file.endsWith('a.ts') ? [sym('src/a.ts', 3, 'add'), sym('src/c.ts', 4, 'add')] : [sym('src/b.ts', 9, 'add'), sym('src/c.ts', 4, 'add')]);
    },
  };
  const readLine = async (file: string, line1: number) => lines[`${file}:${line1}`] ?? '';

  it('symbol-search returns every exact-name declaration', async () => {
    const r = await askLspQuery(door, kase('symbol-search', 'add'), '/t', readLine);
    expect(r.sites.map((s) => `${s.path}:${s.line1}`)).toEqual(['src/a.ts:3', 'src/b.ts:7']);
  });
  it('definition narrows to the anchor file when it holds a declaration', async () => {
    const r = await askLspQuery(door, kase('definition', 'add', 'src/b.ts'), '/t', readLine);
    expect(r.sites.map((s) => `${s.path}:${s.line1}`)).toEqual(['src/b.ts:7']);
  });
  it('references puts the cursor on the name of each declaration and unions the answers', async () => {
    refCalls.length = 0;
    const r = await askLspQuery(door, kase('references', 'add'), '/t', readLine);
    expect(refCalls).toEqual([
      { file: '/t/src/a.ts', line1: 3, character: 16, rootPath: '/t' },
      { file: '/t/src/b.ts', line1: 7, character: 9, rootPath: '/t' },
    ]);
    expect(r.sites.map((s) => `${s.path}:${s.line1}`)).toEqual(['src/a.ts:3', 'src/c.ts:4', 'src/b.ts:9']);
  });
  it('a references failure is an error, never an empty answer', async () => {
    const failing: LspDoor = { ...door, references: async () => answer([], 'server crashed') };
    const r = await askLspQuery(failing, kase('references', 'add', 'src/a.ts'), '/t', readLine);
    expect(r).toEqual({ sites: [], error: 'server crashed' });
  });
  it('index() warms up inside the configured project, not at a root that spans nested projects', async () => {
    const anchors: string[] = [];
    const rootRefusing: LspDoor = {
      ...door,
      workspaceSymbols: async (q) => {
        anchors.push(q.anchor);
        return q.anchor === '/t' ? answer([], 'directory anchor /t spans 113 nested tsconfig project(s)') : answer([]);
      },
    };
    const anchored = await createLspQueryArm({ version: 'v', treeRoot: '/t', warmupAnchor: 'pkg/src/index.ts' }, rootRefusing).index();
    expect(anchors).toEqual(['/t/pkg/src/index.ts']);
    expect(anchored).toMatchObject({ ok: true, error: null });
    // Without the anchor, the root refusal fails the index phase (the 2026-10-06 run).
    const rooted = await createLspQueryArm({ version: 'v', treeRoot: '/t' }, rootRefusing).index();
    expect(rooted.ok).toBe(false);
  });
  it('the arm declares no call-hierarchy intents (lsp:query has none)', async () => {
    const arm = createLspQueryArm({ version: 'v', treeRoot: '/t' }, door);
    expect(arm.capabilities.intents).toEqual(['definition', 'references', 'symbol-search']);
    expect((await arm.query(kase('callers', 'add'))).status).toBe('declined');
  });
});

describe('no-third-party arm on the real micro repo (TypeScript LanguageService)', () => {
  let dir = '';
  let tree: TsTree;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fair-ntp-'));
    await materializeMicroRepo(dir);
    tree = openTsTree(ts, dir);
  });
  afterAll(async () => {
    tree?.service.dispose();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('passes micro conformance: every plain declared case correct', async () => {
    const arm = createNoThirdPartyArm({ treeRoot: dir, ts });
    expect((await arm.index()).ok).toBe(true);
    const report = await runConformance(arm, MICRO_CASES, microRepoKeys());
    await arm.close?.();
    expect(report.defects).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('callers report every call line, including a module top-level call', () => {
    const r = askTypescript(tree, kase('callers', 'add', 'src/util/math.ts'));
    expect(r.sites.map((s) => `${s.path}:${s.line1}`).sort()).toEqual(['src/app/report.ts:4', 'src/app/report.ts:7', 'src/app/report.ts:8', 'src/util/math.ts:7']);
  });

  it.each(['rust', 'python', 'go'] as const)(
    'declines %s before unrelated TypeScript homonyms reach whole-tree reference search', language => {
      const positive = askTypescript(tree, { ...kase('references', 'add', 'src/util/math.ts'), language: 'typescript' });
      expect(positive.error).toBeNull();
      expect(positive.sites.length).toBeGreaterThan(0);
      const findReferences = vi.spyOn(tree.service, 'findReferences');
      try {
        const unsupported = askTypescript(tree, {
          ...kase('references', 'add', `native-controls/${language}/control`), language,
        });
        expect(unsupported.error).toEqual(expect.stringMatching(/^declined:.*unsupported.*language/));
        expect(unsupported.sites).toEqual([]);
        expect(findReferences).not.toHaveBeenCalled();
      } finally { findReferences.mockRestore(); }
    });

  it('callees omit default-lib targets as neutral and say how many', () => {
    const r = askTypescript(tree, kase('callees', 'report', 'src/app/report.ts'));
    expect(r.sites.every((s) => !s.path.startsWith('../') && !s.path.startsWith('/'))).toBe(true);
    expect(r.sites.map((s) => `${s.path}:${s.line1}`).sort()).toEqual(['src/app/report.ts:12', 'src/app/report.ts:6']);
    expect(r.note).toMatch(/^2 callee\(s\) outside the tree omitted as neutral/);
  });

  it('impact stops at the case depth', () => {
    const at = (depth: number) => askTypescript(tree, { ...kase('impact', 'scale', 'src/util/math.ts'), depth }).sites.map((s) => `${s.path}:${s.line1}`).sort();
    expect(at(1)).toEqual(['src/app/report.ts:12']);
    expect(at(2)).toEqual(['src/app/report.ts:12', 'src/app/report.ts:19']);
    expect(at(3)).toContain('src/main.ts:1');
  });
});
