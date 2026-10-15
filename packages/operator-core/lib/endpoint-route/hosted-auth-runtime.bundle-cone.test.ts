/**
 * Bundle-cone guard for the portal-prebundled hosted-auth runtime.
 *
 * `hosted-auth-runtime.ts` is esbuild-prebundled by the Cloud Portal
 * (PORTAL_HOSTED_AUTH_RUNTIME_PACKAGE_ROOT). One relative import added on
 * 2026-09-01 (secret-ref.ts → integration-credentials.ts → operator-state-pg.ts)
 * grew that cone from 596 to 9,087 modules and broke every standalone portal
 * build with unresolvable @opentelemetry/* and .node natives
 * (EI-22091008218242870). This test walks the STATIC relative-import graph of
 * the runtime inside operator-core and fails the moment any of the heavy
 * operator substrate modules become reachable again.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const ROOT = resolve(__dirname, '..');
const ENTRY = resolve(__dirname, 'hosted-auth-runtime.ts');

/** Modules that must NEVER be reachable from the prebundled hosted-auth runtime. */
const FORBIDDEN = [
  'operator-state-pg.ts',
  'integration-credentials.ts',
  'auth/hosted/secret-ref.ts',
  'sync-sse.ts',
  'endpoint-route/routes/index.ts',
  'endpoint-route/routes/hosted-tutorial-assistance-runtime.ts',
  'agent-tools/operator/converse.ts',
] as const;

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(entry: string): Map<string, string> {
  const seen = new Map<string, string>(); // file → first importer
  const queue: Array<[string, string]> = [[entry, '<entry>']];
  while (queue.length > 0) {
    const [file, importer] = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, importer);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      const target = resolveRelative(file, spec);
      if (target && target.startsWith(ROOT) && !seen.has(target)) queue.push([target, file]);
    }
    // esbuild follows lazy literal imports too; ignoring them let Help pull
    // the execution graph into hosted sign-in without this guard noticing.
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const target = resolveRelative(file, node.arguments[0].text);
        if (target && target.startsWith(ROOT) && !seen.has(target)) queue.push([target, file]);
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
  return seen;
}

describe('hosted-auth-runtime bundle cone', () => {
  it('excludes the agent runtime barrel even for types and runtime tooldef barrels', () => {
    // The relative-only walk missed an agent-mcp barrel import in a tutorial
    // preference leaf: esbuild traversed its side effects into DBOS/telemetry.
    // Inspect runtime imports throughout the same cone, including named imports
    // with inline type modifiers. Narrow package subpaths remain available.
    const offenders: string[] = [];
    for (const file of walk(ENTRY).keys()) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        if (!['@papercusp/agent-mcp', '@papercusp/tooldef'].includes(node.moduleSpecifier.text)) continue;
        // TypeScript follows type-only barrel exports too. Importing RouteContext
        // from agent-mcp pulls its agent execution graph into the Next program.
        if (node.moduleSpecifier.text === '@papercusp/agent-mcp') {
          offenders.push(`${file} imports ${node.moduleSpecifier.text}`);
          continue;
        }
        const clause = node.importClause;
        if (clause?.isTypeOnly) continue;
        if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly)) continue;
        offenders.push(`${file} imports ${node.moduleSpecifier.text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never reaches the operator substrate (operator-state-pg / integration store / sync engine / route registry)', () => {
    const cone = walk(ENTRY);
    const offenders = FORBIDDEN.map((suffix) => {
      const hit = [...cone.keys()].find((file) => file.endsWith(`/${suffix}`));
      return hit ? `${suffix} via ${cone.get(hit)}` : null;
    }).filter((entry): entry is string => entry !== null);
    expect(offenders, `forbidden modules reachable from hosted-auth-runtime.ts: ${offenders.join('; ')}`).toEqual([]);
    // Sanity: the walk actually saw the runtime's own neighbourhood.
    expect([...cone.keys()].some((file) => file.endsWith('/auth/hosted/workos-provider.ts'))).toBe(true);
  });
});
