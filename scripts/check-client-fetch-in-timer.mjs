#!/usr/bin/env node
/** P-004: ratchet API reads in recurring UI timers onto @papercusp/sync.
 * Local callback references are followed transitively. Imported helpers can only be
 * recognized by their read-shaped names; this is a syntactic guard, not a call graph.
 * --list prints the measured, unsuppressed population used to seed the baseline.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { listFilesIncludingUntracked } from './lib/tracked-files.mjs';
import { fingerprint, judgeSites } from './lib/shrink-only-guard.mjs';

export const ROOTS = ['apps/operator-vite/src/', 'apps/operator/app/', 'packages/operator-ui/'];
export const SEED_HASH = 'f8d2fa050fe3e411e8acb42ac362d85f225e62a377466c0deaba59c0ed54631a';
export const inScope = (file) => ROOTS.some((root) => file.startsWith(root)) &&
  /\.[cm]?[jt]sx?$/.test(file) && !/(?:^|\/)(?:node_modules|dist|build|_retired)\//.test(file) &&
  !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);

export function findFetchTimers(source, file) {
  if (!inScope(file)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scopes = new Map();
  const visit = (node, fn) => { fn(node); ts.forEachChild(node, (child) => visit(child, fn)); };
  const scopeOf = (node) => {
    let scope = node.parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return scope;
  };
  visit(ast, (node) => {
    const name = ts.isFunctionDeclaration(node) ? node.name : ts.isVariableDeclaration(node) ? node.name : null;
    const value = ts.isFunctionDeclaration(node) ? node : node.initializer;
    if (!name || !ts.isIdentifier(name) || !value) return;
    const scope = scopeOf(node);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    scopes.get(scope).set(name.text, value);
  });
  const lookup = (identifier) => {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      const value = scopes.get(scope)?.get(identifier.text);
      if (value) return value;
    }
  };
  const reads = (node, seen = new Set()) => {
    if (!node) return false;
    if (seen.has(node)) return false;
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) return reads(lookup(node), next);
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(ast);
      if (/(?:^|\.)(?:fetch|fetch[A-Z]\w*|apiFetch|refetch)$/.test(name)) return true;
      if (ts.isIdentifier(node.expression) && reads(lookup(node.expression), next)) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      // Identifiers used as values are not calls. Walking them as calls connects
      // unrelated state initializers and fabricates a fetch path for clock ticks.
      if (!ts.isIdentifier(child) && reads(child, next)) found = true;
    });
    return found;
  };
  const sites = [];
  visit(ast, (node) => {
    if (!ts.isCallExpression(node) || !/(?:^|\.)(?:setInterval|setTimeout)$/.test(node.expression.getText(ast))) return;
    const callback = node.arguments[0];
    if (!callback || !reads(callback)) return;
    // setTimeout is a polling loop only when its callback reschedules itself.
    if (node.expression.getText(ast).endsWith('setTimeout')) {
      const body = ts.isIdentifier(callback) ? lookup(callback) : callback;
      let recursive = false;
      if (body) visit(body, (child) => {
        if (ts.isCallExpression(child) && /(?:^|\.)setTimeout$/.test(child.expression.getText(ast)) &&
          child.arguments[0] && ts.isIdentifier(child.arguments[0]) && lookup(child.arguments[0]) === body) recursive = true;
      });
      if (!recursive) return;
    }
    const text = node.getText(ast);
    sites.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      key: `${file}#${fingerprint(text.replace(/\s+/g, ' ')).slice(0, 16)}`, text });
  });
  return sites;
}

export function main(argv = process.argv.slice(2)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Copy-out mutation probes retain the original logical source path while
  // reading a private snapshot. Normal gating always enumerates the real tree.
  const sourceIndex = argv.indexOf('--source');
  const asIndex = argv.indexOf('--as');
  if ((sourceIndex >= 0) !== (asIndex >= 0)) throw new Error('--source requires --as');
  if (sourceIndex >= 0) {
    const file = argv[asIndex + 1];
    if (!inScope(file)) throw new Error('copy-out subject must be in a declared UI root');
    const sites = findFetchTimers(readFileSync(argv[sourceIndex + 1], 'utf8'), file);
    const policy = JSON.parse(readFileSync(new URL('./client-fetch-in-timer-baseline.json', import.meta.url), 'utf8'));
    const result = judgeSites(sites, policy, SEED_HASH);
    for (const error of result.errors) console.error(error);
    for (const site of result.offenders) console.error(`${site.file}:${site.line}: client fetch-in-timer: use @papercusp/sync (${site.key})`);
    if (!result.errors.length && !result.offenders.length) console.log('client fetch-in-timer: PASS (copy-out source)');
    return result.errors.length || result.offenders.length ? 1 : 0;
  }
  const explicit = argv.filter((arg) => !arg.startsWith('--'));
  const files = explicit.length ? explicit : listFilesIncludingUntracked(root).files;
  const sites = files.filter(inScope).flatMap((file) => findFetchTimers(readFileSync(resolve(root, file), 'utf8'), file));
  if (argv.includes('--list')) { console.log(JSON.stringify(sites, null, 2)); return 0; }
  const policy = JSON.parse(readFileSync(new URL('./client-fetch-in-timer-baseline.json', import.meta.url), 'utf8'));
  const { errors, offenders } = judgeSites(sites, policy, SEED_HASH);
  for (const error of errors) console.error(error);
  for (const site of offenders) console.error(`${site.file}:${site.line}: client fetch-in-timer: use @papercusp/sync (${site.key})`);
  if (!errors.length && !offenders.length) console.log(`client fetch-in-timer: PASS (${sites.length} measured sites)`);
  return errors.length || offenders.length ? 1 : 0;
}
if (isCliEntry(import.meta.url)) process.exitCode = main();
