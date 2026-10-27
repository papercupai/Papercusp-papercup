/**
 * Worker script for cpu-task-worker.ts — handles CPU-heavy synchronous work
 * off the operator main thread:
 *
 *   serialize  → JSON.stringify (with BigInt→Number replacer)
 *   broad_tree_scan → TypeScript AST census detection for evidence freshness
 *
 * Runs in a dedicated worker_threads thread so the main event loop is free
 * during the blocking compute. Both tasks share the same lifecycle and
 * round-trip id for pending-map correlation.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 * The gzip half was removed 2026-07-26: the operator is a loopback desktop
 * sidecar and no longer compresses any response, so there is nothing to
 * offload. Do not re-add it (scripts/check-no-wire-compression.mjs).
 *
 * Protocol (main → worker):
 *   { kind: 'serialize', id: number, value: unknown }
 *
 * Protocol (worker → main):
 *   { kind: 'ready' }
 *   { kind: 'serialize_ok', id: number, json: string }
 *   { kind: 'serialize_err', id: number, error: string }
 *
 * Plain ESM .mjs (no TypeScript transform) — same convention as
 * local-embedder-worker.script.mjs.
 */

import { parentPort } from 'node:worker_threads';

/**
 * BigInt-safe JSON.stringify replacer. Matches the replacer used in
 * rest-query-batch.ts so the worker output is byte-identical to what the
 * main thread produced before.
 */
function replaceBigInt(_k, v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

// A fixture inventory is not a census of repository source. Prove the narrow
// case from immutable bindings and real node builtins; names alone cannot grant
// the exception. Unresolved roots keep the existing conservative scan verdict.
function fixturePathProof(ts, file) {
  const scopes = new WeakMap();
  const references = new Map();
  const outer = { parent: null, bindings: new Map(), functionScope: true };
  const bind = (scope, name, value) => {
    if (ts.isIdentifier(name)) scope.bindings.set(name.text,
      scope.bindings.has(name.text) ? { node: null } : { ...value, name });
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) bind(scope, element.name, { node: null });
    }
  };
  const index = (node, parent) => {
    if (ts.isFunctionDeclaration(node) && node.name) bind(parent, node.name, { node, fn: node });
    const scope = ts.isFunctionLike(node) || ts.isBlock(node)
      ? { parent, bindings: new Map(), functionScope: ts.isFunctionLike(node) } : parent;
    scopes.set(node, scope);
    if (ts.isParameter(node)) bind(scope, node.name, { node });
    if (ts.isVariableDeclaration(node)) {
      const immutable = Boolean(node.parent.flags & ts.NodeFlags.Const);
      let target = scope;
      if (!(node.parent.flags & ts.NodeFlags.BlockScoped)) while (target.parent && !target.functionScope) target = target.parent;
      bind(target, node.name, { node, immutable, initializer: node.initializer });
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) bind(scope, clause.name, { node, module });
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bind(scope, clause.namedBindings.name, { node, module });
        else for (const item of clause.namedBindings.elements) bind(scope, item.name,
          { node, module, member: (item.propertyName ?? item.name).text });
      }
    }
    ts.forEachChild(node, child => index(child, scope));
  };
  index(file, outer);
  const binding = node => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (scope.bindings.has(node.text)) return scope.bindings.get(node.text);
    }
    return null;
  };
  const collect = node => {
    if (ts.isIdentifier(node)) {
      const item = binding(node);
      if (item) { if (!references.has(item)) references.set(item, []); references.get(item).push(node); }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  const unwrap = node => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node))) node = node.expression;
    return node;
  };
  const written = node => {
    let target = node;
    while (target.parent && ((ts.isPropertyAccessExpression(target.parent)
      || ts.isElementAccessExpression(target.parent)) && target.parent.expression === target
      || ts.isParenthesizedExpression(target.parent))) target = target.parent;
    const parent = target.parent;
    return Boolean(parent && (ts.isBinaryExpression(parent) && parent.left === target
      && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
        && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
      || ts.isDeleteExpression(parent)));
  };
  const unmodified = item => !(references.get(item) ?? []).some(written);
  const moduleOf = identifier => {
    if (!ts.isIdentifier(identifier)) return null;
    const item = binding(identifier);
    if (!item || !unmodified(item)) return null;
    if (item.module && !item.member) return item.module;
    const init = unwrap(item.immutable && item.initializer);
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require'
      && !binding(init.expression) && init.arguments.length === 1 && ts.isStringLiteral(init.arguments[0])) return init.arguments[0].text;
    return null;
  };
  const api = (expression, module, member) => {
    expression = unwrap(expression);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text === member
      && [module, 'node:' + module].includes(moduleOf(expression.expression));
    if (ts.isIdentifier(expression)) {
      const item = binding(expression);
      return Boolean(item && unmodified(item) && item.member === member && [module, 'node:' + module].includes(item.module));
    }
    return false;
  };
  const relativePart = node => ts.isStringLiteralLike(node) && !/^(?:[\\/]|[A-Za-z]:)/.test(node.text)
    && !node.text.split(/[\\/]/).includes('..');
  const temporaryPrefix = node => {
    node = unwrap(node);
    if (!node || !ts.isCallExpression(node) || !api(node.expression, 'path', 'join') || node.arguments.length < 2) return false;
    const first = unwrap(node.arguments[0]);
    return ts.isCallExpression(first) && api(first.expression, 'os', 'tmpdir') && first.arguments.length === 0
      && node.arguments.slice(1).every(relativePart);
  };
  // A returned fixture object may be read or passed to a local read-only helper.
  // Aliases, unknown calls, method calls and property writes make it ambiguous.
  const safeObject = (item, seen = new Set()) => {
    if (!item || seen.has(item) || !unmodified(item)) return false;
    const next = new Set(seen).add(item);
    return (references.get(item) ?? []).every(ref => {
      if (ref === item.name) return true;
      const parent = ref.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === ref) {
        return !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
      }
      if (!ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
      const fn = binding(parent.expression)?.fn;
      const parameter = fn?.parameters[parent.arguments.indexOf(ref)];
      return Boolean(parameter && ts.isIdentifier(parameter.name) && safeObject(binding(parameter.name), next));
    });
  };
  const prove = (value, seen = new Set()) => {
    value = unwrap(value);
    if (!value || seen.has(value) || seen.size > 32) return false;
    const next = new Set(seen).add(value);
    if (ts.isIdentifier(value)) {
      const item = binding(value);
      return Boolean(item?.immutable && unmodified(item) && prove(item.initializer, next));
    }
    if (ts.isCallExpression(value)) {
      if (api(value.expression, 'fs', 'mkdtempSync')) return temporaryPrefix(value.arguments[0]);
      return (api(value.expression, 'path', 'join') || api(value.expression, 'path', 'resolve'))
        && value.arguments.length > 0 && prove(value.arguments[0], next) && value.arguments.slice(1).every(relativePart);
    }
    if (!ts.isPropertyAccessExpression(value) || !ts.isIdentifier(value.expression)) return false;
    const object = binding(value.expression);
    const call = unwrap(object?.immutable && object.initializer);
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || !safeObject(object)) return false;
    const functionBinding = binding(call.expression);
    const fn = functionBinding?.fn;
    if (!fn?.body || !unmodified(functionBinding)) return false;
    const returned = [];
    const returns = node => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        const expression = unwrap(node.expression);
        if (!expression || !ts.isObjectLiteralExpression(expression) || expression.properties.some(ts.isSpreadAssignment)) returned.push(null);
        else {
          const property = expression.properties.find(p => p.name && ts.isIdentifier(p.name) && p.name.text === value.name.text);
          returned.push(property && (ts.isShorthandPropertyAssignment(property) ? property.name
            : ts.isPropertyAssignment(property) ? property.initializer : null));
        }
      }
      ts.forEachChild(node, returns);
    };
    returns(fn.body);
    return returned.length > 0 && returned.every(expression => prove(expression, next));
  };
  return prove;
}

// Keep parsing on this thread, including TypeScript's module initialization.
// Evidence checks must never run this work inline in the request host.
async function detectBroadRepoTreeScan(source) {
  const { default: ts } = await import('typescript');
  const file = ts.createSourceFile('repo-measurement.test.ts', source, ts.ScriptTarget.Latest, true);
  const roots = [];
  let hasRootCollection = false;
  let hasDirectoryRead = false;
  let hasTraversal = false;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const name = node.text.toUpperCase();
      if (/ROOTS?$|(?:DIRS|DIRECTORIES)$/.test(name) && name.length > 4) {
        const expression = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ? node.parent : node;
        hasRootCollection = true;
        roots.push(expression);
      }
      if (/^(?:WALK|SCAN(?:TREE|DIRECTORY|FILES)?|VISIT)$/i.test(node.text)) hasTraversal = true;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (name && /^(?:READDIR|READDIRSYNC|GLOB|GLOBSYNC|FASTGLOB)$/i.test(name)) hasDirectoryRead = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!(hasRootCollection && hasDirectoryRead && hasTraversal)) return false;
  if (file.parseDiagnostics.length) return true;
  const isFixturePath = fixturePathProof(ts, file);
  return roots.some(root => !isFixturePath(root));
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { kind, id } = msg;

  if (kind !== 'serialize' && kind !== 'broad_tree_scan') return;

  try {
    if (kind === 'broad_tree_scan') {
      const broadTreeScan = await detectBroadRepoTreeScan(msg.source);
      parentPort.postMessage({ kind: 'broad_tree_scan_ok', id, broadTreeScan });
      return;
    }
    const json = JSON.stringify(msg.value, replaceBigInt);
    parentPort.postMessage({ kind: 'serialize_ok', id, json });
  } catch (err) {
    parentPort.postMessage({
      kind: kind === 'serialize' ? 'serialize_err' : 'broad_tree_scan_err',
      id,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// Signal ready immediately — no heavy init here; the worker is cheap to spawn.
parentPort.postMessage({ kind: 'ready' });
