/**
 * Recurrence guard for synchronous psu-pty discovery on the operator event loop.
 * The synchronous finder touches metadata, socket paths, and /proc identity;
 * any async function or callback containing it can stall unrelated requests.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function isAsync(node: ts.FunctionLikeDeclaration): boolean {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
}

const SYNC_DISCOVERY_NAMES = new Set([
  'findLiveHost',
  'selfCompactionAvailability',
  'readHostEventTail',
  'hostStartedAt',
  'latestRespawnNativeSession',
  'latestRespawnNativeId',
]);
const OPERATOR_SOURCE_ROOTS = [
  LIB_ROOT,
  resolve(LIB_ROOT, '../../../apps/operator/lib'),
];

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isPtyDiscoverySpecifier(specifier: string): boolean {
  return /(?:^|\/)psu-pty-discovery(?:\.[cm]?[jt]s)?$/.test(specifier);
}

function isPtyDiscoveryImport(expression: ts.Expression): boolean {
  const value = unwrapExpression(expression);
  return (
    ts.isCallExpression(value) &&
    value.expression.kind === ts.SyntaxKind.ImportKeyword &&
    value.arguments.some(
      (argument) => ts.isStringLiteralLike(argument) && isPtyDiscoverySpecifier(argument.text),
    )
  );
}

function isPtyDiscoveryModule(expression: ts.Expression, moduleAliases: Set<string>): boolean {
  const value = unwrapExpression(expression);
  return isPtyDiscoveryImport(value) || (ts.isIdentifier(value) && moduleAliases.has(value.text));
}

function staticPropertyName(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

function isSyncDiscoverySource(
  expression: ts.Expression,
  aliases: Set<string>,
  moduleAliases: Set<string>,
): boolean {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return SYNC_DISCOVERY_NAMES.has(value.text) || aliases.has(value.text);
  if (ts.isPropertyAccessExpression(value)) {
    return SYNC_DISCOVERY_NAMES.has(value.name.text) && isPtyDiscoveryModule(value.expression, moduleAliases);
  }
  if (ts.isBinaryExpression(value)) {
    return (
      value.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      value.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) && (
      isSyncDiscoverySource(value.left, aliases, moduleAliases) ||
      isSyncDiscoverySource(value.right, aliases, moduleAliases)
    );
  }
  if (ts.isConditionalExpression(value)) {
    return (
      isSyncDiscoverySource(value.whenTrue, aliases, moduleAliases) ||
      isSyncDiscoverySource(value.whenFalse, aliases, moduleAliases)
    );
  }
  return false;
}

function syncDiscoveryCallsInAsyncContext(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const syncAliases = new Set(SYNC_DISCOVERY_NAMES);
  const ptyModuleAliases = new Set<string>();

  // Resolve simple local aliases to a fixed point so declaration order and
  // chained aliases do not hide a sync finder from the call-site visitor.
  let aliasesChanged = true;
  while (aliasesChanged) {
    aliasesChanged = false;
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isPtyDiscoverySpecifier(node.moduleSpecifier.text) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (SYNC_DISCOVERY_NAMES.has(importedName) && !syncAliases.has(element.name.text)) {
            syncAliases.add(element.name.text);
            aliasesChanged = true;
          }
        }
      }

      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (ts.isIdentifier(node.name) && isPtyDiscoveryImport(node.initializer)) {
          if (!ptyModuleAliases.has(node.name.text)) {
            ptyModuleAliases.add(node.name.text);
            aliasesChanged = true;
          }
        }
        if (
          ts.isObjectBindingPattern(node.name) &&
          isPtyDiscoveryModule(node.initializer, ptyModuleAliases)
        ) {
          for (const element of node.name.elements) {
            const exportedName = staticPropertyName(element.propertyName) ??
              (ts.isIdentifier(element.name) ? element.name.text : null);
            if (
              ts.isIdentifier(element.name) &&
              exportedName !== null &&
              SYNC_DISCOVERY_NAMES.has(exportedName) &&
              !syncAliases.has(element.name.text)
            ) {
              syncAliases.add(element.name.text);
              aliasesChanged = true;
            }
          }
        }
        if (
          ts.isIdentifier(node.name) &&
          isSyncDiscoverySource(node.initializer, syncAliases, ptyModuleAliases) &&
          !syncAliases.has(node.name.text)
        ) {
          syncAliases.add(node.name.text);
          aliasesChanged = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }

  const visit = (node: ts.Node, asyncAncestor: boolean): void => {
    const nestedAsync = asyncAncestor || (isFunction(node) && isAsync(node));
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const callee = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : null;
      if (
        nestedAsync &&
        callee !== null &&
        (SYNC_DISCOVERY_NAMES.has(callee) || syncAliases.has(callee))
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        findings.push(relative(LIB_ROOT, fileName) + ':' + line + ' ' + callee);
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'findHost' &&
      isSyncDiscoverySource(node.initializer, syncAliases, ptyModuleAliases)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      findings.push(relative(LIB_ROOT, fileName) + ':' + line + ' findHost=findLiveHost');
    }
    ts.forEachChild(node, (child) => visit(child, nestedAsync));
  };

  visit(source, false);
  return findings;
}

function operatorSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : operatorSourceFiles(fullPath);
    }
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [fullPath]
      : [];
  });
}

describe('async PTY discovery recurrence guard', () => {
  it('detects sync host discovery inside async bodies and nested callbacks', () => {
    const fixture = `async function handler() {
      await Promise.resolve();
      const callback = () => findLiveHost('owner');
      return callback();
    }
    const syncOnly = () => selfCompactionAvailability('owner');`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:3 findLiveHost',
    ]);
  });

  it('detects the synchronous finder being injected as an async host dependency', () => {
    const fixture = `const deps = { findHost: findLiveHost };
    async function handler() { return await deps.findHost('owner'); }`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:1 findHost=findLiveHost',
    ]);
  });

  it('detects a sync finder carried through a nullish-coalescing default alias', () => {
    const fixture = `async function handler(deps: { findHost?: (owner: string) => unknown }) {
      const findHost = deps.findHost ?? findLiveHost;
      return await findHost('owner');
    }`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:3 findHost',
    ]);
  });

  it('detects synchronous ledger-tail and host-start readers in async code', () => {
    const fixture = `async function handler() {
      readHostEventTail('owner');
      hostStartedAt('owner');
      latestRespawnNativeSession('owner');
      latestRespawnNativeId('owner');
    }`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:2 readHostEventTail',
      'fixture.ts:3 hostStartedAt',
      'fixture.ts:4 latestRespawnNativeSession',
      'fixture.ts:5 latestRespawnNativeId',
    ]);
  });

  it('detects an awaited dynamic-import finder alias but ignores an unrelated alias', () => {
    const fixture = `async function handler(deps: { findHostFn?: (owner: string) => unknown }) {
      const findHost = deps.findHostFn ?? (await import('./events/await/psu-pty-discovery')).findLiveHost;
      return await findHost('owner');
    }
    async function unrelated(deps: { lookup?: (owner: string) => unknown }) {
      const lookup = deps.lookup ?? safeAsyncLookup;
      return await lookup('owner');
    }`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:3 findHost',
    ]);
  });

  it('detects a sync discovery helper destructured from an awaited module alias', () => {
    const fixture = `async function handler() {
      const discovery = await import('./events/await/psu-pty-discovery');
      const { selfCompactionAvailability: canCompact } = discovery;
      return canCompact('owner');
    }`;
    expect(syncDiscoveryCallsInAsyncContext(join(LIB_ROOT, 'fixture.ts'), fixture)).toEqual([
      'fixture.ts:4 canCompact',
    ]);
  });

  it('keeps sync host discovery out of async operator-core and app source', () => {
    const findings = OPERATOR_SOURCE_ROOTS.flatMap(operatorSourceFiles).flatMap((fileName) =>
      syncDiscoveryCallsInAsyncContext(fileName, readFileSync(fileName, 'utf8')),
    );
    expect(findings).toEqual([]);
  });
});
