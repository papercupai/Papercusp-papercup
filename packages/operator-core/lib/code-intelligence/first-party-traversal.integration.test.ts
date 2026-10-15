/** Real graph:query handler → forked worker → vendored compiler. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import type { CodeIntelAnswer } from './contracts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-traversal-exposed-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true } }));
  writeFileSync(join(root, 'src/leaf.ts'), 'export function destination() { return 1; }\n');
  writeFileSync(join(root, 'src/barrel.ts'), 'export * from "./leaf";\n');
  writeFileSync(join(root, 'src/path.ts'), 'import { destination as renamed } from "./barrel";\nexport function middle() {\n  return renamed();\n}\nexport function origin() {\n  return middle();\n}\n');
  writeFileSync(join(root, 'src/cycle.ts'), 'import { destination } from "./leaf";\nexport function first() {\n  return second();\n}\nexport function second() {\n  first();\n  return destination();\n}\n');
  writeFileSync(join(root, 'src/other.ts'), 'export function destination() { return 2; }\n');
  writeFileSync(join(root, 'src/callback.ts'), 'import { destination } from "./leaf";\nexport function accept(cb: () => number) {\n  return cb();\n}\nexport function callbacks() {\n  return accept(destination);\n}\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function query(extra: Record<string, unknown> = {}): Promise<CodeIntelAnswer> {
  const result = await graphQuery.handler(graphQuery.args.parse({ op: 'trace', name: 'origin',
    target: 'destination', target_file_path: 'src/leaf.ts', paths: ['src'], ...extra }), { projectDir: root,
    dispatchTool: async () => { throw new Error('Indexed fallback must never run'); } } as never) as { data: CodeIntelAnswer };
  return result.data;
}
describe('P008 exposed graph impact and trace', () => {
  it('returns the expected forward source-site path through the actual worker', async () => {
    const answer = await query();
    expect(answer.error).toBeNull();
    expect(answer.backend).toBe('typescript-service');
    expect(answer.traversal!.paths).toHaveLength(1);
    expect(answer.traversal!.paths[0]!.siteIndices.map(index => [answer.sites[index]!.path, answer.sites[index]!.line1])).toEqual([
      ['src/path.ts', 6], ['src/path.ts', 3],
    ]);
    expect(answer.evidence!.relationships.map(edge => [edge.source!.site.name, edge.target!.site.name])).toEqual([
      ['origin', 'middle'], ['middle', 'destination'],
    ]);
    expect(answer.evidence!.relationships.every(edge => edge.source!.contentHash && edge.target!.contentHash && edge.runtimeExecution === 'unknown')).toBe(true);
  }, 60_000);
  it('refuses the reverse-path counterexample and nonexistent target control', async () => {
    const reverse = await query({ name: 'destination', file_path: 'src/leaf.ts', target: 'origin', target_file_path: 'src/path.ts' });
    expect(reverse.error).toBeNull();
    expect(reverse.traversal!.paths).toEqual([]);
    expect((await query({ target: 'nonexistent' })).error).toContain('No target declaration');
  }, 60_000);
  it('terminates a cycle at the requested depth and exposes a path only within that bound', async () => {
    const shallow = await query({ name: 'first', max_depth: 1 });
    expect(shallow.traversal!.paths).toEqual([]);
    expect(shallow.traversal!.truncationReasons).toContain('depth');
    const deep = await query({ name: 'first', max_depth: 2 });
    expect(deep.traversal!.paths).toHaveLength(1);
    expect(deep.traversal!.paths[0]!.siteIndices).toHaveLength(2);
  }, 60_000);
  it('returns downstream impact with original per-hop call direction', async () => {
    const answer = await query({ op: 'impact', name: 'destination', file_path: 'src/leaf.ts', max_depth: 2 });
    expect(answer.error).toBeNull();
    expect(answer.traversal!.paths.every(path => path.walk === 'reverse')).toBe(true);
    expect(answer.evidence!.relationships.some(edge => edge.source!.site.name === 'origin' && edge.target!.site.name === 'middle')).toBe(true);
  }, 60_000);
  it('keeps callback binding unknown instead of inventing target execution', async () => {
    const answer = await query({ name: 'callbacks' });
    expect(answer.error).toBeNull();
    expect(answer.traversal!.paths).toEqual([]);
    expect(answer.traversal!.outcome).toBe('incomplete');
    expect(answer.evidence!.relationships.some(edge => edge.binding === 'indirect' && edge.knowledge === 'unknown' && edge.runtimeExecution === 'unknown')).toBe(true);
  }, 60_000);
});
