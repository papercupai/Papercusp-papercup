import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { _CURATED_FOR_TESTS } from './design-adapter-react-tailwind/registry';
import { lintIr } from './design-ir/lint';
import { validateIr } from './design-ir/validate';
import type { UiIr } from './design-ir/schema';

const specUrl = new URL('../../../apps/operator-vite/src/components/reports/reports.design.json', import.meta.url);
const routeUrl = new URL('../../../apps/operator-vite/src/components/reports/ReportsRoute.tsx', import.meta.url);
const registry = new Map(_CURATED_FOR_TESTS.map(entry => [entry.id, entry]));
const lintContext = { knownComponents: new Set(registry.keys()) };

function screen(): UiIr {
  const result = validateIr(JSON.parse(readFileSync(specUrl, 'utf8')));
  expect(result.errors).toEqual([]);
  if (!result.spec) throw new Error('Reports screen is invalid');
  return result.spec;
}

function sourceComponents(source: string) {
  const file = ts.createSourceFile('ReportsRoute.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = new Map<string, string>();
  const rendered = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const name of bindings.elements) imports.set(name.name.text, node.moduleSpecifier.text);
      }
    }
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
      rendered.add(node.tagName.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { imports, rendered };
}

function selectionGaps(spec: UiIr, source: string): string[] {
  const actual = sourceComponents(source);
  return (spec.components ?? []).flatMap(binding => {
    const selection = registry.get(binding.registry)?.ecosystems?.['react-tailwind'];
    if (!selection?.importHint || !selection.sourcePointer?.symbol) return [`${binding.id}: unknown registry selection`];
    const expected = sourceComponents(selection.importHint).imports;
    const symbol = selection.sourcePointer.symbol;
    return actual.imports.get(symbol) === expected.get(symbol) && actual.rendered.has(symbol)
      ? [] : [`${binding.id}: ${symbol} is not imported and rendered from its registry source`];
  });
}

describe('Reports design registry contract (P-007)', () => {
  it('validates the authored Reports screen and lints against the maintained registry without errors or warnings', () => {
    expect(lintIr(screen(), lintContext)).toEqual([]);
  });

  it('imports and renders the selected registry controls in the Reports route', () => {
    const spec = screen();
    expect(spec.components?.map(binding => binding.id)).toEqual(expect.arrayContaining(['search', 'kind', 'visibility', 'copy', 'history']));
    expect(selectionGaps(spec, readFileSync(routeUrl, 'utf8'))).toEqual([]);
  });

  it('rejects an invalid Reports layout instead of accepting a schema-shaped placeholder', () => {
    const invalid = { ...screen(), layout: { kind: 'not-a-layout' } };
    expect(validateIr(invalid).ok).toBe(false);
    expect(validateIr(invalid).errors).not.toEqual([]);
  });

  it('detects a Reports control with no declared registry binding', () => {
    const spec = screen();
    spec.components = spec.components?.filter(binding => binding.id !== 'search');
    expect(lintIr(spec, lintContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'orphan-component-binding', severity: 'error' }),
    ]));
  });

  it('detects a Reports selection absent from the maintained component registry', () => {
    const spec = screen();
    spec.components![0].registry = 'reports.hand-rolled-input';
    expect(lintIr(spec, lintContext)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'unknown-component', severity: 'error' }),
    ]));
    expect(selectionGaps(spec, readFileSync(routeUrl, 'utf8'))).not.toEqual([]);
  });

  it('detects a route substituting a local control for the selected shared component', () => {
    const source = readFileSync(routeUrl, 'utf8');
    const substituted = source.replace("from '@papercusp/ui-primitives/controls'", "from './HandRolledControls'");
    expect(substituted).not.toBe(source);
    expect(selectionGaps(screen(), substituted)).toEqual(expect.arrayContaining([
      'search: TextInput is not imported and rendered from its registry source',
    ]));
  });

  it('detects a subject picker substituted for the selected maintained combobox', () => {
    const source = readFileSync(routeUrl, 'utf8');
    const substituted = source.replace("from '@/app/harness/Combobox'", "from './HandRolledSubjectPicker'");
    expect(substituted).not.toBe(source);
    expect(selectionGaps(screen(), substituted)).toContain(
      'subject: ComboboxMenu is not imported and rendered from its registry source',
    );
  });
});
