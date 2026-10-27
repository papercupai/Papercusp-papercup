import { describe, expect, it } from 'vitest';
import { buildSymbolSnapshot, parseSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';
import { createReuseCallColumns, decodeReuseCallColumns } from './reuse-source-population';

function build(sources: Record<string, string>) {
  const files = Object.keys(sources);
  return buildSymbolSnapshot({ files, readSource: (file: string) => sources[file] ?? null,
    resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(files)) });
}
describe('precomputed symbol snapshot', () => {
  it('resolves a merged parse only after cross-partition exports and cycles are complete', () => {
    const sources: Record<string, string> = {
      'a.ts': 'import { alias } from "./barrel"; alias(); new (factory())();',
      'barrel.ts': 'export { target as alias } from "./target"; export * from "./cycle";',
      'cycle.ts': 'export * from "./barrel";',
      'target.ts': 'export function target() {} target();',
      'z.ts': 'new (unknown())();',
      'invalid.ts': 'function broken(',
    };
    const files = Object.keys(sources), fileSet = new Set(files);
    const input = { files, readSource: (path: string) => sources[path] ?? null,
      resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, fileSet), censusOnly: true };
    const serial = buildSymbolSnapshot(input);
    const parts = [files.slice(0, 2), files.slice(2)].map(batch => parseSymbolSnapshot({ ...input, files: batch }));
    const parsed = { units: new Map(parts.flatMap(p => [...p.units])), symbols: new Map(parts.flatMap(p => [...p.symbols])),
      immediateCalls: parts.flatMap(p => p.immediateCalls), stats: { ...parts[0]!.stats } };
    for (const part of parts.slice(1)) for (const key of ['files', 'skippedFiles', 'unresolvedCalls'] as const) parsed.stats[key] += part.stats[key];
    expect(buildSymbolSnapshot({ ...input, parsed })).toEqual(serial);
    expect(serial.callCensus).toContainEqual(expect.objectContaining({ from: 'a.ts', to: 'target.ts', resolved: true }));
    expect(serial.stats.skippedFiles).toBe(1);
  });
  it('keeps compact measurement calls and completeness identical to the full brief snapshot', async () => {
    const sources: Record<string, string> = {
      'target.ts': 'export function target() {}\nfunction privateTarget() {} privateTarget();',
      'barrel.ts': 'export { target as renamed } from "./target";',
      'use.ts': 'import { renamed as alias } from "./barrel"; alias(); unknown(); new (factory())();',
      'namespace.ts': 'import * as ns from "./target"; ns.target();',
      'shadow.ts': 'import { target } from "./target"; function run(target: any) { target(); } target();',
      'invalid.ts': 'export function broken(',
      'positions.ts': 'import { target } from "./target";\n/* leading trivia */ target();\nnew (factory())();',
    };
    const files = Object.keys(sources), fileSet = new Set(files);
    const input = { files, readSource: (path: string) => sources[path] ?? null,
      resolveModule: (path: string, spec: string) => relativeSymbolModule(path, spec, fileSet), includeCallCensus: true };
    const full = buildSymbolSnapshot(input), compact = buildSymbolSnapshot({ ...input, censusOnly: true });
    expect(full.symbols.length).toBeGreaterThan(0);
    expect(compact.symbols).toEqual([]);
    expect(compact.callCensus).toEqual(full.callCensus);
    expect(compact.stats).toEqual(full.stats);
    expect(compact.stats.skippedFiles).toBe(1);
    expect(compact.knowledge).toEqual(full.knowledge);
    expect(compact.limitations).toEqual(full.limitations);
    const columns = createReuseCallColumns();
    const packed = buildSymbolSnapshot({ ...input, censusOnly: true, callCensusSink: columns.sink });
    expect(packed.callCensus).toEqual([]);
    expect(packed.stats).toEqual(full.stats);
    expect(await decodeReuseCallColumns(columns.finish())).toEqual(full.callCensus);
    expect(compact.callCensus).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^positions\.ts:2:22:/), from: 'positions.ts', to: 'target.ts', resolved: true,
    }));
  });
  it('preserves the existing caller cap as incomplete in compact measurement mode', () => {
    const text = 'export function target() {}\n' + 'target();\n'.repeat(501);
    const input = { files: ['target.ts'], readSource: () => text, resolveModule: () => null, includeCallCensus: true };
    const full = buildSymbolSnapshot(input), compact = buildSymbolSnapshot({ ...input, censusOnly: true });
    expect(compact.callCensus).toEqual(full.callCensus);
    expect(compact.callCensus).toHaveLength(501);
    expect(compact.stats).toEqual(full.stats);
    expect(compact.stats).toMatchObject({ truncated: true, resolvedCalls: 500 });
  });
  it('resolves aliases, barrel re-exports and namespace calls without matching comments or strings', () => {
    const result = build({
      'target.ts': 'export function target() {}',
      'barrel.ts': 'export { target as renamed } from "./target";',
      'use.ts': 'import { renamed as alias } from "./barrel"; alias(); // target()\nconst prose="target()";',
      'other.ts': 'import * as ns from "./target"; ns.target();',
    });
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0].aliases.sort()).toEqual(['renamed', 'target']);
    expect(result.symbols[0].callers.map((x: { path: string }) => x.path).sort()).toEqual(['other.ts', 'use.ts']);
    expect(result.symbols[0].callers.every((x: { sha256: string }) => /^[a-f0-9]{64}$/.test(x.sha256))).toBe(true);
    expect(result.symbols[0].sources.map((x: { path: string }) => x.path).sort()).toEqual(['barrel.ts', 'other.ts', 'target.ts', 'use.ts']);
  });
  it('never assigns dynamic or shadowed calls, missing modules, or ambiguous star exports', () => {
    const result = build({
      'a.ts': 'export function target() {}', 'b.ts': 'export function target() {}',
      'barrel.ts': 'export * from "./a"; export * from "./b";',
      'shadow.ts': 'import { target } from "./a"; function run(target: any) { target(); }',
      'missing.ts': 'import { target } from "./absent"; target();',
      'ambiguous.ts': 'import { target } from "./barrel"; target();',
      'dynamic.ts': 'const receiver:any={}; receiver.target();',
    });
    expect(result.symbols.every((x: { callers: unknown[] }) => x.callers.length === 0)).toBe(true);
    expect(result.stats.unresolvedCalls).toBe(4);
    expect(result.limitations.join(' ')).toContain('lower bounds');
  });
  it('keeps default exports and local exported arrows source-pinned', () => {
    const result = build({ 'target.ts': 'export default function work() {}\nexport const arrow=()=>{}; arrow();',
      'use.ts': 'import run from "./target"; run();' });
    expect(result.symbols.find((x: { name: string }) => x.name === 'work')?.callers).toHaveLength(1);
    expect(result.symbols.find((x: { name: string }) => x.name === 'arrow')?.callers).toHaveLength(1);
  });
  it('distinguishes top-level declarations from nested shadow bindings', () => {
    const result = build({
      'target.ts': 'export function target() {}',
      'top.ts': 'export const local=()=>{}; local();',
      'nested.ts': 'import { target } from "./target"; { const target=()=>{}; target(); } target();',
      'binding.ts': 'import { target } from "./target"; function run({target}: any) { target(); } target();',
      'class.ts': 'import { target } from "./target"; function run() { class target {} new target(); } target();',
    });
    expect(result.symbols.find((x: { name: string }) => x.name === 'local')?.callers).toHaveLength(1);
    expect(result.symbols.find((x: { name: string }) => x.name === 'target')?.callers).toEqual([]);
    expect(result.stats).toMatchObject({ files: 5, skippedFiles: 0, resolvedCalls: 1, unresolvedCalls: 6, truncated: false });
  });
  it('keeps comment-only JSDoc syntax out of the runtime call census', () => {
    const result = build({
      'target.ts': '/** @template {unknown} T\n * @param {{value: T}} input\n * target(); import("./missing");\n */\nexport function target(input: unknown) {}',
      'use.ts': 'import { target } from "./target"; /** @type {ReturnType<typeof target>} */ const value=target(1);',
    });
    expect(result.stats).toMatchObject({ files: 2, skippedFiles: 0, resolvedCalls: 1, unresolvedCalls: 0, truncated: false });
    expect(result.symbols[0].callers).toEqual([expect.objectContaining({ path: 'use.ts', spelling: 'target' })]);
  });
  it('binds caller workspace names to maintained package manifests, including nested workspaces', () => {
    const sources: Record<string, string> = {
      'lib/target.ts': 'export function target() {}',
      'lib/package.json': '{"name":"@example/lib"}',
      'apps/nested/package.json': '{"name":"@example/nested"}',
      'apps/nested/use.ts': 'import { target } from "../../lib/target"; target();',
    };
    const files = Object.keys(sources);
    const result = buildSymbolSnapshot({ files, readSource: (file: string) => sources[file] ?? null,
      resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(files)),
      workspacePackages: [['@example/lib', ['lib']], ['@example/parent', ['apps']], ['@example/nested', ['apps/nested']]] });
    expect(result.symbols[0]?.callers[0]?.workspace).toBe('@example/nested (apps/nested)');
    expect(result.symbols[0]?.sources.map((site: { path: string }) => site.path)).toContain('apps/nested/package.json');
  });
});
