import { describe, expect, it } from 'vitest';
import { buildSymbolSnapshot, relativeSymbolModule } from '../../../../scripts/lib/code-intel-symbol-snapshot.mjs';

function build(sources: Record<string, string>) {
  const files = Object.keys(sources);
  return buildSymbolSnapshot({ files, readSource: (file: string) => sources[file] ?? null,
    resolveModule: (file: string, spec: string) => relativeSymbolModule(file, spec, new Set(files)) });
}
describe('precomputed symbol snapshot', () => {
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
