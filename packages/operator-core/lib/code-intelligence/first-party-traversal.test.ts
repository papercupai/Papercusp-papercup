import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstPartyCallers } from './first-party-callers';
import { versionedSymbolIdentity } from './contracts';

let root: string;
const files = {
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true } }),
  'src/leaf.ts': 'export function target() { return 1; }\n',
  'src/other.ts': 'export function target() { return 2; }\nexport function otherEntry() { return target(); }\n',
  'src/barrel.ts': 'export * from "./leaf";\n',
  'src/bridge.ts': 'import { target as aliasTarget } from "./barrel";\nexport function bridge() {\n  return aliasTarget();\n}\n',
  'src/entry.ts': 'import { bridge } from "./bridge";\nexport function entry() {\n  return bridge();\n}\n',
  'src/branch.ts': 'import { bridge } from "./bridge";\nexport function branch() {\n  bridge();\n  return bridge();\n}\n',
  'src/cycle.ts': 'import { target } from "./leaf";\nexport function cycleA() {\n  return cycleB();\n}\nexport function cycleB() {\n  cycleA();\n  return target();\n}\n',
  'src/callback.ts': 'import { target } from "./leaf";\nexport function invoke(cb: () => number) {\n  return cb();\n}\nexport function callbacks() {\n  return invoke(target);\n}\nexport function dynamic(client: any) {\n  return client.target();\n}\n',
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'compiler-traversal-'));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
const trace = (extra: Partial<Parameters<typeof firstPartyCallers>[0]> = {}) => firstPartyCallers({ ts, root,
  op: 'trace', name: 'entry', target: 'target', targetFilePath: 'src/leaf.ts', paths: ['src'], ...extra });
const hopNames = (answer: ReturnType<typeof trace>, pathIndex = 0) => answer.traversal!.paths[pathIndex]!.siteIndices.map(index =>
  [answer.evidence!.relationships[index]!.source!.site.name, answer.evidence!.relationships[index]!.target!.site.name]);

describe('P008 compiler-backed directed trace', () => {
  it('P013: keeps scoped downstream aliases and multi-hop callers without loading out-of-scope bodies', () => {
    const answer = firstPartyCallers({ ts, root, op: 'impact', direction: 'downstream', name: 'target',
      filePath: 'src/leaf.ts', paths: ['src/leaf.ts', 'src/bridge.ts', 'src/entry.ts'], maxDepth: 2 });
    expect(answer.error).toBeNull();
    expect(answer.attribution!.stubbedFiles).toBeGreaterThan(0);
    expect(answer.evidence!.relationships.map(edge => [edge.source!.site.name, edge.target!.site.name])).toEqual([
      ['bridge', 'target'], ['entry', 'bridge'],
    ]);
    expect(answer.evidence!.sourceScope.supportingFiles.map(source => source.path)).toEqual([
      'src/bridge.ts', 'src/entry.ts', 'src/leaf.ts',
    ]);
    for (const source of answer.evidence!.sourceScope.supportingFiles) {
      expect(source.representation).toBe('full-source');
      expect(source.contentHash).toBe(createHash('sha256').update(readFileSync(join(root, source.path))).digest('hex'));
    }
    expect(answer.evidence!.relationships.every(edge => edge.runtimeExecution === 'unknown')).toBe(true);
    expect(answer.evidence!.graphScope.limitations).toContain('Only searched files are full compiler inputs; other reached files are re-export stubs.');
    // Outgoing traversal needs the actual reached bodies even outside the search scope.
    const outgoing = firstPartyCallers({ ts, root, op: 'impact', direction: 'upstream', name: 'entry',
      filePath: 'src/entry.ts', paths: ['src/entry.ts'], maxDepth: 2 });
    expect(outgoing.error).toBeNull();
    expect(outgoing.evidence!.relationships.map(edge => [edge.source!.site.name, edge.target!.site.name])).toEqual([
      ['entry', 'bridge'], ['bridge', 'target'],
    ]);
    expect(outgoing.evidence!.sourceScope.supportingFiles.find(source => source.path === 'src/bridge.ts')).toMatchObject({
      representation: 'full-source', contentHash: createHash('sha256').update(files['src/bridge.ts']).digest('hex'),
    });
  });
  it('returns the forward reference path across an alias and re-export without mixing homonyms', () => {
    const answer = trace();
    expect(answer.error).toBeNull();
    expect(answer.intent).toBe('trace');
    expect(answer.traversal!.outcome).toBe('found');
    expect(hopNames(answer)).toEqual([['entry', 'bridge'], ['bridge', 'target']]);
    expect(answer.traversal!.paths).toHaveLength(1);
    expect(answer.sites.map(site => [site.path, site.line1])).toEqual([['src/entry.ts', 3], ['src/bridge.ts', 3]]);
    expect(answer.evidence!.relationships.at(-1)!.target!.site.path).toBe('src/leaf.ts');
  });
  it('does not report the reverse path as a forward trace', () => {
    const answer = trace({ name: 'target', filePath: 'src/leaf.ts', target: 'entry', targetFilePath: 'src/entry.ts' });
    expect(answer.error).toBeNull();
    expect(answer.traversal!.paths).toEqual([]);
    expect(answer.traversal!.outcome).toBe('not-found-in-scope');
  });
  it('stops at depth one before the target rather than adding an unsubstantiated hop', () => {
    const answer = trace({ maxDepth: 1 });
    expect(answer.traversal!.paths).toEqual([]);
    expect(answer.traversal!.outcome).toBe('incomplete');
    expect(answer.traversal!.truncationReasons).toContain('depth');
    expect(answer.sites).toHaveLength(1);
    expect(trace({ maxDepth: 2 }).traversal!.outcome).toBe('found');
  });
  it.each([0, 1, 2, 3])('terminates cyclic traversal at max_depth %s', maxDepth => {
    const answer = trace({ name: 'cycleA', maxDepth });
    expect(answer.error).toBeNull();
    for (const path of answer.traversal!.paths) expect(path.siteIndices.length).toBeLessThanOrEqual(maxDepth);
    expect(answer.traversal!.paths.length).toBe(maxDepth >= 2 ? 1 : 0);
    if (maxDepth >= 2) expect(hopNames(answer)).toEqual([['cycleA', 'cycleB'], ['cycleB', 'target']]);
  });
  it('bounds multiple paths and explicitly reports the omitted path', () => {
    const answer = trace({ name: 'branch', maxPaths: 1 });
    expect(answer.traversal!.paths).toHaveLength(1);
    expect(answer.traversal!.truncationReasons).toContain('paths');
    expect(answer.truncation).toMatchObject({ truncated: true, totalAvailable: null });
    expect(trace({ name: 'branch', maxPaths: 2 }).traversal!.paths).toHaveLength(2);
  });
  it('bounds call sites without inventing a partial successful path', () => {
    const answer = trace({ limit: 1 });
    expect(answer.sites).toHaveLength(1);
    expect(answer.traversal!.paths).toEqual([]);
    expect(answer.traversal!.truncationReasons).toContain('sites');
    expect(answer.traversal!.outcome).toBe('incomplete');
  });
  it('refuses nonexistent and ambiguous destination controls', () => {
    expect(trace({ target: 'nonexistent' }).error).toContain('No target declaration');
    expect(trace({ targetFilePath: undefined }).error).toContain('Ambiguous target');
    expect(trace({ name: 'target', filePath: undefined }).error).toContain('Ambiguous symbol');
  });
  it('does not infer callback execution from an argument binding', () => {
    const answer = trace({ name: 'callbacks' });
    expect(answer.traversal!.paths).toEqual([]);
    expect(answer.traversal!.outcome).toBe('incomplete');
    expect(answer.evidence!.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: 'indirect', knowledge: 'unknown', runtimeExecution: 'unknown' }),
    ]));
    expect(answer.evidence!.relationships.every(edge => edge.target?.site.name !== 'target')).toBe(true);
  });
  it('labels dynamic receivers with unknown target and runtime execution', () => {
    const answer = trace({ name: 'dynamic' });
    expect(answer.traversal!.outcome).toBe('incomplete');
    expect(answer.evidence!.relationships).toHaveLength(1);
    expect(answer.evidence!.relationships[0]).toMatchObject({ binding: 'dynamic', knowledge: 'unknown', runtimeExecution: 'unknown' });
    expect(answer.evidence!.relationships[0]!.target).toBeUndefined();
  });
  it('supports a zero-hop identity path without claiming that a call ran', () => {
    const answer = trace({ target: 'entry', targetFilePath: 'src/entry.ts', maxDepth: 0 });
    expect(answer.traversal!.paths).toEqual([{ siteIndices: [], walk: 'forward' }]);
    expect(answer.sites).toEqual([]);
  });
  it.each([{ maxDepth: -1 }, { maxDepth: 17 }, { maxPaths: 0 }, { maxPaths: 101 }])('refuses invalid direct compiler bounds %j', limits => {
    expect(trace(limits).error).toContain('Traversal limits');
  });
  it('binds every call site and both declaration endpoints to the exact compiler snapshot', () => {
    const answer = trace();
    const evidence = answer.evidence!;
    for (const source of evidence.sourceScope.supportingFiles) {
      expect(source.contentHash).toBe(createHash('sha256').update(readFileSync(join(root, source.path))).digest('hex'));
    }
    for (const relation of evidence.relationships) {
      expect(relation.runtimeExecution).toBe('unknown');
      for (const endpoint of [relation.source!, relation.target!]) {
        const source = evidence.sourceScope.supportingFiles.find(file => file.path === endpoint.site.path)!;
        expect(endpoint.versionedSymbolId).toBe(versionedSymbolIdentity(evidence.sourceScope.repositoryId, endpoint.site, source));
        expect(endpoint.contentHash).toBe(source.contentHash);
      }
    }
    expect(evidence.graphScope.sourceCompleteness).toBe('unverified');
  });
});

describe('P008 impact workflow', () => {
  it('walks downstream dependents whose source does not spell the initial target name', () => {
    const answer = trace({ op: 'impact', name: 'target', filePath: 'src/leaf.ts' });
    expect(answer.error).toBeNull();
    const sources = answer.evidence!.relationships.map(edge => edge.source!.site.name);
    expect(sources).toContain('bridge');
    expect(sources).toContain('entry');
    expect(sources).not.toContain('otherEntry');
    expect(answer.traversal!.direction).toBe('downstream');
    expect(answer.traversal!.paths.every(path => path.walk === 'reverse')).toBe(true);
  });
  it('keeps upstream and downstream direction explicit and depth-bounded', () => {
    const upstream = trace({ op: 'impact', name: 'bridge', direction: 'upstream', maxDepth: 1 });
    expect(upstream.evidence!.relationships.map(edge => edge.target!.site.name)).toEqual(['target']);
    const downstream = trace({ op: 'impact', name: 'bridge', direction: 'downstream', maxDepth: 1 });
    expect(downstream.evidence!.relationships.map(edge => edge.source!.site.name)).toEqual(['branch', 'branch', 'entry']);
    const both = trace({ op: 'impact', name: 'bridge', direction: 'both', maxDepth: 1 });
    expect(new Set(both.traversal!.paths.map(path => path.walk))).toEqual(new Set(['forward', 'reverse']));
  });
});
