/** D-016 / P-026: behavioral conformance cannot detect an unused copy of host policy.
 * Scan package-owned source too, with planted, never-called counterexamples. URL pagination
 * validation and typed fault reporting remain provider responsibilities; recovery and policy
 * enforcement remain host responsibilities. The generated stdio bridge is checked separately
 * against the shared SDK builder before it can be excluded from the owned-source scan.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const PLUGINS = join(REPO, 'libs/papercusp/plugins');
const packages = readdirSync(PLUGINS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGINS, entry.name, 'papercusp.json'), 'utf8'));
    return manifest.provider?.datatypes?.some((datatype: string) => ['social-post', 'blog-post'].includes(datatype)) ? [[entry.name, join(PLUGINS, entry.name)] as const] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
});

type Policy = 'retry/backoff' | 'cursor recovery' | 'egress enforcement';

/** A URL checked solely for content metadata is not an outbound destination policy.
 * Keep this conservative: prove the local binding and its uses, rather than exempting
 * a package, function name, domain, or every URL constructor.
 */
function isContentUrlProperty(property: ts.PropertyAccessExpression, source: ts.SourceFile): boolean {
  if (!ts.isIdentifier(property.expression)) return false;
  const binding = property.expression.text;
  let scope: ts.Node | undefined = property.parent;
  while (scope && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
  if (!scope || !ts.isFunctionDeclaration(scope) || !scope.body) return false;
  const body = scope.body;
  const fn = scope;
  const nodes: ts.Node[] = [];
  const collect = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, collect); };
  collect(body);
  const assigned = (name: string) => nodes.flatMap((node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) return [node.initializer];
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      return node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? [node.right] : [node];
    }
    return [];
  });
  const writes = assigned(binding);
  if (writes.length !== 1 || !ts.isNewExpression(writes[0]) || writes[0].expression.getText(source) !== 'URL' || writes[0].arguments?.length !== 1) return false;
  const constructor = writes[0];
  const input = constructor.arguments![0];
  const calls = nodes.filter(ts.isCallExpression);
  const inReturn = (node: ts.Node) => {
    let parent: ts.Node | undefined = node.parent;
    while (parent && parent !== fn) {
      if (ts.isReturnStatement(parent)) return true;
      parent = parent.parent;
    }
    return false;
  };
  const isCanonical = ts.isIdentifier(input) && fn.parameters.length === 1 && fn.parameters[0].name.getText(source) === input.text &&
    !!fn.name && calls.every((call) => call.expression.getText(source) === 'fault') &&
    nodes.some((node) => ts.isReturnStatement(node) && node.expression?.getText(source) === `${binding}.href`);
  if (isCanonical) {
    // Only payload metadata fields may consume this validator's result.
    const references: ts.Identifier[] = [];
    const findReferences = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === fn.name!.text && node !== fn.name) references.push(node);
      ts.forEachChild(node, findReferences);
    };
    findReferences(source);
    if (!references.length || references.some((ref) => !ts.isCallExpression(ref.parent) || ref.parent.expression !== ref ||
      !ts.isPropertyAssignment(ref.parent.parent) || ref.parent.parent.initializer !== ref.parent ||
      !['canonical_url', 'originalArticleURL'].includes(ref.parent.parent.name.getText(source)))) return false;
  } else {
    // A permalink from the sole completed host request may only be returned as metadata.
    if (!ts.isPropertyAccessExpression(input) || input.name.text !== 'url' || !ts.isIdentifier(input.expression)) return false;
    const parsed = assigned(input.expression.text);
    if (parsed.length !== 1 || !ts.isCallExpression(parsed[0]) || parsed[0].expression.getText(source) !== 'JSON.parse' ||
      parsed[0].arguments.length !== 1 || !ts.isPropertyAccessExpression(parsed[0].arguments[0]) || parsed[0].arguments[0].name.text !== 'body') return false;
    const response = parsed[0].arguments[0].expression.getText(source);
    const requests = calls.filter((call) => call.expression.getText(source) === 'host.fetch');
    const responses = assigned(response);
    if (requests.length !== 1 || responses.length !== 1 || !ts.isAwaitExpression(responses[0]) ||
      responses[0].expression !== requests[0] || requests[0].end >= parsed[0].pos || parsed[0].end >= constructor.pos) return false;
  }
  return nodes.filter((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === binding).every((ref) => {
    const parent = ref.parent;
    if ((ts.isPropertyAccessExpression(parent) && parent.name === ref) ||
      (ts.isPropertyAssignment(parent) && parent.name === ref)) return true;
    if ((ts.isVariableDeclaration(parent) && parent.name === ref) ||
      (ts.isBinaryExpression(parent) && parent.left === ref && parent.right === constructor)) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === ref) return inReturn(parent);
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== ref) return false;
    if (parent.name.text === 'href') {
      if (isCanonical) return ts.isReturnStatement(parent.parent) && parent.parent.expression === parent;
      return ts.isPropertyAssignment(parent.parent) && parent.parent.name.getText(source) === 'url' && inReturn(parent.parent);
    }
    if (!['protocol', 'host', 'hostname', 'port', 'username', 'password', 'hash'].includes(parent.name.text)) return false;
    let condition: ts.Node = parent;
    while (condition.parent && !ts.isIfStatement(condition.parent) && condition.parent !== fn) condition = condition.parent;
    return ts.isIfStatement(condition.parent) && condition.parent.expression === condition;
  });
}

/** Instagram observes an already-created media container before publishing it once.
 * Its bounded status-only loop is not a retry of creation/publication. An extra request
 * in that loop invalidates this exception, including inside an unused nested function.
 */
function isLifecycleObservation(timer: ts.CallExpression, source: ts.SourceFile): boolean {
  let ancestor: ts.Node | undefined = timer.parent;
  while (ancestor && !ts.isForStatement(ancestor)) ancestor = ancestor.parent;
  if (!ancestor || !ts.isForStatement(ancestor) || !ancestor.initializer ||
    !ts.isVariableDeclarationList(ancestor.initializer) || ancestor.initializer.declarations.length !== 1) return false;
  const counter = ancestor.initializer.declarations[0];
  if (!ts.isIdentifier(counter.name) || counter.initializer?.getText(source) !== '0') return false;
  const name = counter.name.text;
  if (!ancestor.condition || !ts.isBinaryExpression(ancestor.condition) ||
    ancestor.condition.left.getText(source) !== name || ancestor.condition.operatorToken.kind !== ts.SyntaxKind.LessThanEqualsToken ||
    ancestor.condition.right.getText(source) !== '5') return false;
  const step = ancestor.incrementor;
  const incrementsOnce = step && (
    ((ts.isPostfixUnaryExpression(step) || ts.isPrefixUnaryExpression(step)) && step.operator === ts.SyntaxKind.PlusPlusToken && step.operand.getText(source) === name) ||
    (ts.isBinaryExpression(step) && step.left.getText(source) === name && step.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && step.right.getText(source) === '1')
  );
  if (!incrementsOnce || timer.arguments.length !== 2 || !ts.isNumericLiteral(timer.arguments[1]) || Number(timer.arguments[1].text) !== 60_000) return false;
  const calls: string[] = [];
  const literals = new Set<string>();
  let changesCounter = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    if (ts.isStringLiteral(node)) literals.add(node.text);
    if ((ts.isBinaryExpression(node) && node.left.getText(source) === name &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
      ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && node.operand.getText(source) === name &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))) changesCounter = true;
    ts.forEachChild(node, visit);
  };
  visit(ancestor.statement);
  return !changesCounter && calls.filter((call) => call === 'statusOf').length === 1 &&
    calls.filter((call) => call === 'setTimeout').length === 1 && literals.has('FINISHED') && literals.has('IN_PROGRESS') &&
    calls.every((call) => ['statusOf', 'targetId', 'fault', 'status.toLowerCase', 'setTimeout'].includes(call));
}

/** Syntax, not comments or dead-code execution: these rules also inspect unused functions. */
function copiedPolicies(body: string): Policy[] {
  const source = ts.createSourceFile('provider.cjs', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Set<Policy>();
  const text = (node: ts.Node) => node.getText(source);
  const cursorCheck = (node: ts.Node) => /['"]cursor-expired['"]/.test(text(node));
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || (ts.isCallExpression(node) && text(node.expression) === 'require')) {
      const specifier = ts.isImportDeclaration(node) ? node.moduleSpecifier : node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) {
        if (/^(?:node:)?timers(?:\/promises)?$|^(?:p-retry|async-retry|retry|exponential-backoff)$/.test(specifier.text)) found.add('retry/backoff');
        if (/^(?:node:)?(?:http|https|http2|net|tls)$|^undici$/.test(specifier.text)) found.add('egress enforcement');
      }
    }
    if (ts.isCallExpression(node)) {
      const call = text(node.expression);
      if (/(?:^|\.)(?:setTimeout|setInterval|sleep)$|^Atomics\.wait(?:Async)?$/.test(call) &&
        !(call === 'setTimeout' && isLifecycleObservation(node, source))) found.add('retry/backoff');
      if (call === 'fetch' || /^(?:globalThis|global)\.fetch$/.test(call)) found.add('egress enforcement');
      if (/\.(?:has|includes|test|match)$/.test(call) && node.arguments.some((arg) => /\.(?:host|hostname|origin)\b/.test(text(arg)))) found.add('egress enforcement');
    }
    if (ts.isPropertyAccessExpression(node) && /^(?:egressHosts|host|hostname)$/.test(node.name.text) && !isContentUrlProperty(node, source)) found.add('egress enforcement');
    if (ts.isBinaryExpression(node) && /\.(?:host|hostname|origin)\b/.test(text(node)) &&
      (ts.isStringLiteral(node.left) || ts.isStringLiteral(node.right)) &&
      ![node.left, node.right].some((side) => ts.isPropertyAccessExpression(side) && isContentUrlProperty(side, source))) found.add('egress enforcement');
    if ((ts.isIfStatement(node) && cursorCheck(node.expression)) ||
      (ts.isConditionalExpression(node) && cursorCheck(node.condition)) ||
      (ts.isSwitchStatement(node) && node.caseBlock.clauses.some((clause) => ts.isCaseClause(clause) && cursorCheck(clause.expression)))) found.add('cursor recovery');
    if (ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const loop = text(node);
      if (/\b(?:attempt|attempts|retries|retryCount|backoff)\b/.test(loop) ||
        (/\b(?:429|503)\b/.test(loop) && /\b(?:fetch|graph)\s*\(/.test(loop))) found.add('retry/backoff');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

function ownedSources(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.git'].includes(entry.name)) return [];
    const path = join(current, entry.name);
    if (entry.isDirectory()) return ownedSources(root, path);
    if (!entry.isFile() || !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) || /(?:\.test|\.spec|\.d)\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) return [];
    // This exact file is generated solely from the SDK, as the independent byte check proves.
    return relative(root, path) === 'daemon.cjs' ? [] : [path];
  });
}

describe('social packages keep shared host policy in the host', () => {
  it('discovers delivered social providers and verifies every excluded launcher against the SDK builder', () => {
    expect(packages.map(([name]) => name)).toEqual(expect.arrayContaining(['facebook-pages', 'instagram', 'x']));
    const generated = packages.filter(([, path]) => existsSync(join(path, 'daemon.cjs')));
    expect(generated.length).toBeGreaterThan(0);
    execFileSync(process.execPath, [join(REPO, 'packages/plugin-sdk/scripts/build-provider-daemons.mjs'), '--check', ...generated.map(([, path]) => path)], { cwd: REPO, stdio: 'pipe' });
  });

  it.each(packages)('%s carries no copied retry, cursor recovery or egress policy in owned source', (_name, root) => {
    const files = ownedSources(root);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((path) => copiedPolicies(readFileSync(path, 'utf8')).map((policy) => `${relative(root, path)}: ${policy}`))).toEqual([]);
  });

  it.each([
    ['retry/backoff', 'async function unused() { await new Promise(resolve => setTimeout(resolve, 1000)); }'],
    ['retry/backoff', "const { setTimeout: pause } = require('node:timers/promises'); async function unused() { await pause(1000); }"],
    ['retry/backoff', 'async function unused(host) { for (let attempt = 0; attempt < 3; attempt++) await host.fetch({}); }'],
    ['cursor recovery', "function unused(error) { if (error.kind === 'cursor-expired') return syncPage({ cursor: null }); }"],
    ['cursor recovery', "function unused(error) { switch (error.kind) { case 'cursor-expired': return fresh(); } }"],
    ['egress enforcement', "function unused(url) { return ['api.example'].includes(new URL(url).hostname); }"],
    ['egress enforcement', "function unused(url) { return new URL(url).origin === 'https://api.example'; }"],
    ['egress enforcement', 'function unused(descriptor, url) { return descriptor.egressHosts.includes(url); }'],
  ] as const)('detects dormant %s code: %s', (policy, planted) => {
    expect(copiedPolicies(planted)).toContain(policy);
  });

  it('allows bounded container observation and rejects a request hidden in that loop', () => {
    const observe = `async function observe() {
      for (let minute = 0; minute <= 5; minute++) {
        status = await statusOf(host, source, targetId(container));
        if (status === 'FINISHED') break;
        if (status !== 'IN_PROGRESS') throw fault('transient', 'container_failed');
        await new Promise(resolve => setTimeout(resolve, 60_000));
      }
    }`;
    expect(copiedPolicies(observe)).toEqual([]);
    expect(copiedPolicies(observe.replace("if (status === 'FINISHED')", "await host.fetch({}); if (status === 'FINISHED')"))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute <= 5', 'minute <= 5000'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute++', 'minute--'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('minute++', 'minute += 0'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('let minute = 0', 'let minute = -5000'))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace("if (status === 'FINISHED')", "minute = 0; if (status === 'FINISHED')"))).toContain('retry/backoff');
    expect(copiedPolicies(observe.replace('60_000', 'delay'))).toContain('retry/backoff');
  });

  it('allows canonical payload and returned permalink checks but rejects destination checks', () => {
    const canonical = `function validate(value) {
      let url; try { url = new URL(value); } catch { throw fault('invalid'); }
      if (url.hostname !== 'papercusp.com' || url.protocol !== 'https:') throw fault('invalid');
      return url.href;
    }
    const article = { canonical_url: validate(args.canonicalUrl) };`;
    expect(copiedPolicies(canonical)).toEqual([]);
    expect(copiedPolicies(canonical.replace('canonical_url:', 'url:'))).toContain('egress enforcement');
    expect(copiedPolicies(canonical.replace('const article = { canonical_url: validate(args.canonicalUrl) };',
      'host.fetch({ request: { url: validate(args.canonicalUrl) } });'))).toContain('egress enforcement');
    expect(copiedPolicies(canonical.replace('return url.href;', 'return url.hostname;'))).toContain('egress enforcement');
    const permalink = `async function invoke(request, host) {
      const response = await host.fetch({ request: { url: 'https://api.example' } });
      const data = JSON.parse(response.body);
      let url; url = new URL(data.url);
      if (url.hostname !== 'example.com') throw fault('invalid');
      return { url: url.href };
    }`;
    expect(copiedPolicies(permalink)).toEqual([]);
    expect(copiedPolicies(permalink.replace('return { url: url.href };', 'return host.fetch({ request: { url: url.href } });'))).toContain('egress enforcement');
    expect(copiedPolicies(permalink.replace('new URL(data.url)', 'new URL(request.url)'))).toContain('egress enforcement');
    expect(copiedPolicies(permalink.replace('return { url: url.href };', "await host.fetch({ request: { url: data.url } }); return { url: url.href };"))).toContain('egress enforcement');
    expect(copiedPolicies(permalink.replace("if (url.hostname", "url = new URL(request.url); if (url.hostname"))).toContain('egress enforcement');
  });

  it('allows fault classification, host catch-up reporting and resource-bound pagination validation', () => {
    expect(copiedPolicies(`
      // retry/backoff, cursor-expired and egressHosts in comments are not implementations.
      const descriptor = { egressHosts: ['api.example'] };
      if (response.status === 429) throw fault('rate-limited', 'throttled', { retryAfterSeconds: 10 });
      if (!valid(cursor)) throw fault('cursor-expired', 'unreadable');
      const catchUp = request.catchUpFrom ? { reason: 'cursor-expired' } : undefined;
      if (next.origin !== current.origin || next.pathname !== current.pathname) throw fault('transient', 'outside_resource');
      await host.fetch({ source, request: { url } });
    `)).toEqual([]);
  });
});
